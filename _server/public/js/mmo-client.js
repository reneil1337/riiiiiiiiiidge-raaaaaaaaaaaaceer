/* Race Day — MMO client (dependency-free ESM, no bundler).
 *
 * Owns the only /mmo websocket: reconnect-with-backoff, seq ordering, the
 * immutable state store, the feed ring and the 4 Hz telemetry writer.
 * Rendering lives in mmo-ui.js / mmo-lfg.js / mmo-hud.js / mmo-spectate.js and
 * reads this module through client.subscribe() or window.__R4_MMO.
 *
 * Wire protocol: _runtime/analysis/20-mmo-contract.md §3.
 * Nothing here touches layout, and every DOM lookup is optional (missing
 * element = silently skipped, never a throw).
 */

export const MMO_VERSION = '1.0.0';

export const MMO_LIMITS = Object.freeze({
  FEED_MAX: 100,
  TELEMETRY_HISTORY_MAX: 600,
  TELEMETRY_MS: 250,
  PING_MS: 1000,
  BACKOFF_MIN: 300,
  BACKOFF_MAX: 5000,
  MAX_ATTEMPTS: 10,
  SENT_LOG_MAX: 2000,
});

const DRIVER_KEY = 'rr4.mmo.driverId'; // sessionStorage — a driver id is per tab
const NAME_KEY = 'rr4.mmo.name'; // localStorage — the driver keeps a callsign
// The server issues 5-char party codes (mmo.js partyCode()). Normalise the same
// way the server does, but never cut a 5-char code down to 4.
const PARTY_CODE_MAX = 5;
const TYPES = new Set([
  'welcome', 'event', 'grid', 'queue', 'countdown', 'standings', 'result',
  'party', 'feed', 'error', 'pong',
]);

/* ---------- small helpers ------------------------------------------------- */

function num(value, fallback) {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function str(value, fallback) {
  return typeof value === 'string' ? value : fallback;
}

function bool(value, fallback) {
  return typeof value === 'boolean' ? value : fallback;
}

function list(value) {
  return Array.isArray(value) ? value.slice() : [];
}

function obj(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
}

function normPartyCode(value) {
  if (typeof value !== 'string' && typeof value !== 'number') return '';
  return String(value).toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, PARTY_CODE_MAX);
}

// `bots` is a boolean on `welcome` and a count inside `counts`; the store keeps
// the boolean so `counts.bots === true` stays the UI's test.
function countBots(value, fallback) {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return value > 0;
  return fallback === true;
}

/* Counts are merged key-by-key: `event`/`grid` frames carry seated/queued/max
 * (plus connected/bots) and never `min`, while `welcome` carries max/min/bots.
 * A key survives from the previous snapshot when the frame omits it, so the LFG
 * panel keeps `min` for the START gate. `spectators` is only ever passed
 * through — never synthesised as 0 (mmo-spectate hides the chip when absent). */
function mergeCounts(prev, incoming) {
  const p = obj(prev) || {};
  const next = obj(incoming);
  if (!next) return p;
  const out = {};
  for (const key of ['seated', 'queued', 'max', 'min', 'connected', 'spectators']) {
    if (typeof next[key] === 'number' && Number.isFinite(next[key])) out[key] = next[key];
    else if (typeof p[key] === 'number' && Number.isFinite(p[key])) out[key] = p[key];
    else if (key === 'seated' || key === 'queued' || key === 'max') out[key] = 0;
  }
  if ('bots' in p || 'bots' in next) out.bots = countBots(next.bots, p.bots);
  return out;
}

function freezeDeep(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const key of Object.keys(value)) freezeDeep(value[key]);
  return value;
}

function readStore(kind, key) {
  try {
    const store = kind === 'session'
      ? (typeof sessionStorage !== 'undefined' ? sessionStorage : null)
      : (typeof localStorage !== 'undefined' ? localStorage : null);
    return store ? store.getItem(key) || '' : '';
  } catch { return ''; }
}

function writeStore(kind, key, value) {
  try {
    const store = kind === 'session'
      ? (typeof sessionStorage !== 'undefined' ? sessionStorage : null)
      : (typeof localStorage !== 'undefined' ? localStorage : null);
    if (store && typeof value === 'string' && value) store.setItem(key, value);
  } catch { /* private mode / quota — the name is cosmetic */ }
}

export function defaultDriverName() {
  const tag = Math.random().toString(36).slice(2, 6).toUpperCase().padEnd(4, '0');
  return `PLAYER-${tag}`;
}

function emptyEvent() {
  return {
    id: null,
    index: 0,
    state: 'lobby',
    plan: null,
    counts: { seated: 0, queued: 0, max: 0, min: 0, bots: false },
  };
}

function emptyState(name) {
  return {
    version: MMO_VERSION,
    conn: 'closed',
    attempt: 0,
    name,
    driverId: '',
    event: emptyEvent(),
    you: { seat: null, team: null, teamIndex: null, name, driverId: '', position: null, gapMs: null, gapLap: false },
    grid: { seats: [], counts: { seated: 0, queued: 0, max: 0 }, st: '', at: 0, full: false },
    queue: { position: 0, size: 0, etaMs: null, fillMs: null, party: null },
    party: { code: null, size: 0, members: [] },
    countdown: { n: null, startsAt: 0, at: 0 },
    standings: { rows: [], you: { position: null, gapMs: null, gapLap: false }, lap: 0, top: 0, slow: false, at: 0 },
    results: { rows: [], you: { position: null, raceTimeMs: null }, finishedAt: 0 },
    result: null, // alias of `results` (same frozen object)
    feed: [],
    error: null,
    rttMs: null,
    slow: false, // standings back-pressure (§3.4) — drives #mmoQualityBadge
    seq: 0,
    lastFrameAt: 0,
    telemetry: { source: 'none', sent: 0, lastAt: 0 },
    updatedAt: 0,
  };
}

function mergeEvent(prev, incoming) {
  const next = obj(incoming);
  if (!next) return prev;
  const plan = next.plan === null
    ? null
    : (obj(next.plan) ? { ...next.plan } : prev.plan);
  return {
    id: next.id != null ? next.id : prev.id,
    index: num(next.index, prev.index),
    state: str(next.state, prev.state),
    plan,
    counts: obj(next.counts) ? mergeCounts(prev.counts, next.counts) : prev.counts,
  };
}

/* ---------- grid rows (full snapshot or merge-by-seat delta) -------------- */

// A row is `{seat, team:<0..3 index>, name:<=12}` plus `state` only when it
// differs from the frame's `st` phase default, and optionally `bot:true`,
// `connected:false` and `driverId` (unclaimed seats). `team` may still arrive
// as a team name from an older server, and mmo-ui.js brand() accepts both.
function normalizeGridRow(raw, defState) {
  const src = obj(raw);
  if (!src) return null;
  if (typeof src.seat !== 'number' || !Number.isFinite(src.seat)) return null;
  const seat = Math.round(src.seat);
  if (seat < 1) return null;
  const explicit = typeof src.state === 'string' && src.state && src.state !== defState
    ? src.state
    : '';
  const row = {
    seat,
    team: typeof src.team === 'number' || typeof src.team === 'string' ? src.team : null,
    name: str(src.name, ''),
    state: explicit || defState,
    stateOff: explicit, // what the frame spelled out; `state` is derived from it
  };
  if (src.bot === true) row.bot = true;
  if (src.connected === false) row.connected = false;
  if (typeof src.driverId === 'string' && src.driverId) row.driverId = src.driverId;
  if (typeof src.car === 'string' && src.car) row.car = src.car; // legacy full rows
  if (typeof src.lap === 'number') row.lap = src.lap;
  return row;
}

// Re-derive `state` from the frame's phase default so a phase change re-spells
// every row that did not spell its own state out.
function respellGridRow(row, defState) {
  const state = row.stateOff || defState;
  return row.state === state ? row : { ...row, state };
}

/* ---------- the client ---------------------------------------------------- */

export function createMmoClient(options = {}) {
  const opts = obj(options) || {};
  const listeners = new Set();

  let name = (() => {
    const explicit = str(opts.name, '').trim();
    if (explicit) { const clean = explicit.slice(0, 24); writeStore('local', NAME_KEY, clean); return clean; }
    const stored = readStore('local', NAME_KEY).trim();
    if (stored) return stored.slice(0, 24);
    const generated = defaultDriverName();
    writeStore('local', NAME_KEY, generated);
    return generated;
  })();

  let snap = freezeDeep(emptyState(name));
  let socket = null;
  let attempt = 0;
  let reconnectTimer = 0;
  let pumpTimer = 0;
  let pingTimer = 0;
  let closedByUser = false;
  let wantSpectate = opts.spectate === true;
  let wantQueued = false;
  let wantPartyCode = normPartyCode(str(opts.partyCode, ''));
  let finishSent = false;
  let lastSeq = 0;
  let seqSeen = false;

  let telemetrySource = typeof opts.telemetrySource === 'function' ? opts.telemetrySource : null;
  let telemetryLabel = telemetrySource ? 'custom' : 'none';
  const telemetryHistory = [];
  const telemetryStats = { sent: 0, lastAt: 0 };
  const sentLog = [];

  /* ---- store ---- */

  function emit(keys) {
    for (const fn of Array.from(listeners)) {
      try { fn(snap, keys); } catch (err) { if (typeof opts.onError === 'function') { try { opts.onError({ code: 'listener', message: String(err && err.message || err) }); } catch { /* ignore */ } } }
    }
    if (typeof opts.onState === 'function') {
      try { opts.onState(snap, keys); } catch { /* a broken renderer must not break the socket */ }
    }
  }

  function commit(partial) {
    const keys = Object.keys(partial);
    if (!keys.length) return snap;
    snap = freezeDeep(Object.assign({}, snap, partial, { updatedAt: Date.now() }));
    emit(keys);
    return snap;
  }

  function subscribe(fn) {
    if (typeof fn !== 'function') return () => {};
    listeners.add(fn);
    return () => { listeners.delete(fn); };
  }

  /* ---- frames ---- */

  function applyFrame(rawFrame) {
    let frame = rawFrame;
    if (typeof frame === 'string') {
      try { frame = JSON.parse(frame); } catch { return 'bad'; }
    }
    if (!frame || typeof frame !== 'object') return 'bad';
    const type = frame.type;
    if (typeof type !== 'string' || !type) return 'bad';
    const payload = obj(frame.payload) || frame;

    const seq = typeof frame.seq === 'number' ? frame.seq
      : (typeof payload.seq === 'number' ? payload.seq : null);
    if (seq !== null) {
      if (seqSeen && seq <= lastSeq) return 'stale';
      lastSeq = seq;
      seqSeen = true;
    }

    if (typeof frame.event === 'string' || typeof frame.event === 'number') {
      // Top-level `event` is the event id, not an object (contract §3). The
      // per-type branches below carry the plan; the id is only needed for the
      // telemetry/finish reset, which reads state.event.id.
    }

    if (!TYPES.has(type)) return 'ignored'; // unknown types are ignored, never thrown
    const now = Date.now();
    const patch = { lastFrameAt: now, seq: seq !== null ? seq : snap.seq };
    const beforeEvent = snap.event;

    switch (type) {
      case 'welcome': {
        const you = obj(payload.you) || {};
        const evt = obj(payload.event) || {};
        const driverId = str(payload.driverId, snap.driverId);
        if (driverId) writeStore('session', DRIVER_KEY, driverId);
        patch.driverId = driverId;
        patch.you = {
          seat: you.seat !== undefined ? (typeof you.seat === 'number' ? you.seat : null) : snap.you.seat,
          team: typeof you.team === 'string' || typeof you.team === 'number' ? you.team : snap.you.team,
          teamIndex: typeof you.team === 'number' ? you.team : snap.you.teamIndex,
          name: str(you.name, snap.name),
          driverId,
          position: snap.you.position,
          gapMs: snap.you.gapMs,
          gapLap: snap.you.gapLap === true,
        };
        const incoming = { ...evt };
        if (typeof payload.state === 'string') incoming.state = payload.state;
        // `welcome` is the only frame that carries `min` (and the max/bots pair);
        // `event` and `grid` counts carry seated/queued/max (+connected/bots)
        // only, so merge them and keep `min` for the LFG START gate.
        const countsIn = obj(payload.counts) || obj(evt.counts) || null;
        if (countsIn || payload.max !== undefined || payload.min !== undefined || payload.bots !== undefined) {
          incoming.counts = { ...(countsIn || {}) };
          if (payload.max !== undefined) incoming.counts.max = payload.max;
          if (payload.min !== undefined) incoming.counts.min = payload.min;
          if (payload.bots !== undefined) incoming.counts.bots = payload.bots;
        }
        patch.event = mergeEvent(beforeEvent, incoming);
        commit(patch);
        syncTelemetry();
        break;
      }

      case 'event': {
        patch.event = mergeEvent(beforeEvent, payload);
        if (patch.event.state !== 'racing') finishSent = false;
        if (patch.event.id !== beforeEvent.id || patch.event.state === 'lobby' || patch.event.state === 'grid') {
          resetEventMemory(patch.event, beforeEvent);
        }
        commit(patch);
        syncTelemetry();
        break;
      }

      case 'grid': {
        // `full:true` replaces the board (a large grid may arrive as several
        // `part`/`parts` chunks of one snapshot); `full:false` is a delta:
        // merge rows by `seat`, delete `removed`, keep every other seat.
        const defState = str(payload.st, snap.grid.st);
        const counts = obj(payload.counts);
        const parts = num(payload.parts, 1);
        const part = num(payload.part, 0);
        const isFull = payload.full !== false;
        const restart = isFull && !(parts > 1 && part > 0);
        const frameEvent = frame.event !== undefined ? frame.event : null;
        const eventChanged = frameEvent !== null && snap.event.id !== null && frameEvent !== snap.event.id;
        const bySeat = new Map();
        if (!restart && !eventChanged) {
          for (const row of snap.grid.seats) bySeat.set(row.seat, row);
        }
        for (const raw of list(payload.seats)) {
          const row = normalizeGridRow(raw, defState);
          if (row) bySeat.set(row.seat, row);
        }
        for (const gone of list(payload.removed)) {
          const seatNo = typeof gone === 'number' ? Math.round(gone) : Number(gone);
          if (Number.isFinite(seatNo)) bySeat.delete(seatNo);
        }
        const seats = Array.from(bySeat.values())
          .sort((a, b) => a.seat - b.seat)
          .map((row) => respellGridRow(row, defState));
        patch.grid = {
          seats,
          counts: counts ? mergeCounts(snap.grid.counts, counts) : snap.grid.counts,
          st: defState,
          at: now,
          full: isFull && restart,
        };
        patch.event = {
          ...snap.event,
          counts: counts ? mergeCounts(snap.event.counts, counts) : snap.event.counts,
        };
        // `you.seat` only ever arrives on `welcome`, so a seat assigned after
        // queueing is learnt from the board: rows always carry the driverId of
        // a changed seat and every driverId on a per-socket full snapshot.
        const myId = snap.driverId || readStore('session', DRIVER_KEY);
        const mine = myId ? seats.find((row) => row.driverId === myId) : null;
        const known = snap.you.seat;
        if (mine) {
          if (known !== mine.seat) patch.you = { ...snap.you, seat: mine.seat };
        } else if (typeof known === 'number' && known > 0) {
          const row = seats.find((r) => r.seat === known);
          if (!row || (row.driverId && row.driverId !== myId)) patch.you = { ...snap.you, seat: null };
        }
        commit(patch);
        break;
      }

      case 'queue': {
        const party = obj(payload.party);
        const partyCode = party ? normPartyCode(party.code) : '';
        patch.queue = {
          position: num(payload.position, 0),
          size: num(payload.size, 0),
          etaMs: payload.etaMs === null ? null : num(payload.etaMs, snap.queue.etaMs),
          fillMs: payload.fillMs === null ? null : num(payload.fillMs, snap.queue.fillMs),
          party: party ? { code: partyCode, size: num(party.size, 1) } : null,
        };
        if (party && partyCode) {
          wantPartyCode = partyCode;
          patch.party = { ...snap.party, code: wantPartyCode, size: num(party.size, snap.party.size) };
        } else if (party === null) {
          patch.party = { code: null, size: 0, members: [] };
        }
        commit(patch);
        break;
      }

      case 'countdown': {
        patch.countdown = { n: num(payload.n, 0), startsAt: num(payload.startsAt, 0), at: now };
        commit(patch);
        break;
      }

      case 'standings': {
        const you = obj(payload.you);
        const rows = list(payload.rows);
        const youNull = payload.you === null;
        const youPosition = you
          ? (typeof you.position === 'number' ? you.position : snap.you.position)
          : (youNull ? null : snap.you.position);
        const youGap = you
          ? (you.gapMs === null ? null : num(you.gapMs, snap.you.gapMs))
          : (youNull ? null : snap.you.gapMs);
        const youGapLap = you ? you.gapLap === true : (youNull ? false : snap.you.gapLap === true);
        // `standings.slow` is the §3.4 back-pressure flag: the UI badge and the
        // HUD read `state.slow` (never invent it — only a boolean flips it).
        const slowNow = typeof payload.slow === 'boolean' ? payload.slow : snap.slow === true;
        patch.standings = {
          rows,
          you: {
            position: youPosition,
            gapMs: youGap,
            gapLap: youGapLap,
          },
          lap: num(payload.lap, snap.standings.lap),
          top: num(payload.top, rows.length),
          slow: slowNow,
          at: now,
        };
        patch.you = { ...snap.you, position: youPosition, gapMs: youGap, gapLap: youGapLap };
        if (typeof payload.slow === 'boolean') {
          patch.slow = payload.slow;
          patch.you.slow = payload.slow;
        }
        commit(patch);
        break;
      }

      case 'result': {
        const you = obj(payload.you) || {};
        const results = {
          rows: list(payload.rows),
          you: {
            position: num(you.position, null),
            raceTimeMs: you.raceTimeMs === null ? null : num(you.raceTimeMs, null),
            gapMs: you.gapMs === null ? null : num(you.gapMs, null),
            lap: num(you.lap, null),
            bestLapMs: you.bestLapMs === null ? null : num(you.bestLapMs, null),
          },
          finishedAt: num(payload.finishedAt, now),
          at: now,
        };
        patch.results = results;
        patch.result = results; // alias so both spellings read the same frozen object
        patch.event = snap.event.state === 'racing'
          ? { ...snap.event, state: 'results' }
          : snap.event;
        commit(patch);
        stopPump();
        break;
      }

      case 'party': {
        const members = list(payload.members);
        const code = normPartyCode(payload.code) || normPartyCode(snap.party.code);
        if (code) wantPartyCode = code;
        patch.party = { code: code || null, size: num(payload.size, members.length), members };
        commit(patch);
        break;
      }

      case 'feed': {
        const text = str(payload.text, '').trim();
        if (!text) return 'ignored';
        const at = num(payload.at, now);
        const feed = snap.feed.slice();
        const last = feed[feed.length - 1];
        const duplicate = feed.some((line) => line.at === at && line.text === text)
          || (last && last.text === text && Math.abs(at - last.at) < 1000);
        if (duplicate) return 'duplicate';
        feed.push({ at, text: text.slice(0, 200) });
        while (feed.length > MMO_LIMITS.FEED_MAX) feed.shift();
        patch.feed = feed;
        commit(patch);
        if (typeof opts.onFeed === 'function') {
          try { opts.onFeed(text, at); } catch { /* renderer owns its own errors */ }
        }
        break;
      }

      case 'error': {
        const error = {
          code: str(payload.code, 'error'),
          message: str(payload.message, '').slice(0, 300),
          at: now,
        };
        patch.error = error;
        commit(patch);
        if (typeof opts.onError === 'function') {
          try { opts.onError(error); } catch { /* ignore */ }
        }
        break;
      }

      case 'pong': {
        const at = num(payload.at, 0);
        const rttMs = at > 0 ? Math.max(0, now - at) : null;
        patch.rttMs = rttMs;
        commit(patch);
        break;
      }

      default:
        return 'ignored';
    }
    return 'applied';
  }

  function resetEventMemory(nextEvent, prevEvent) {
    const newRace = nextEvent.id !== prevEvent.id
      || (nextEvent.state === 'lobby' && prevEvent.state === 'results')
      || nextEvent.state === 'grid';
    if (!newRace) return;
    finishSent = false;
    if (telemetryHistory.length) telemetryHistory.length = 0;
  }

  /* ---- telemetry ---- */

  function normalizeTelemetry(raw) {
    const sample = obj(raw);
    if (!sample) return null;
    if (!Number.isFinite(sample.raceTimeMs)) return null;
    return {
      lap: Math.min(99, Math.max(1, Math.round(num(sample.lap, 1)))),
      raceTimeMs: Math.min(3600000, Math.max(0, Math.round(sample.raceTimeMs))),
      speedKph: Math.min(400, Math.max(0, Math.round(num(sample.speedKph, 0)))),
      state: sample.state === 'finished' || sample.state === 'countdown' ? sample.state : 'racing',
    };
  }

  function readTelemetry() {
    if (typeof telemetrySource !== 'function') {
      telemetryLabel = 'none';
      return null;
    }
    let sample = null;
    try { sample = telemetrySource(); } catch { sample = null; }
    return normalizeTelemetry(sample);
  }

  function telemetryLive() {
    return snap.conn === 'open' && snap.event.state === 'racing' && !closedByUser;
  }

  function startPump() {
    if (pumpTimer) return;
    pumpTimer = setInterval(telemetryTick, MMO_LIMITS.TELEMETRY_MS);
  }

  function stopPump() {
    if (!pumpTimer) return;
    clearInterval(pumpTimer);
    pumpTimer = 0;
  }

  function syncTelemetry() {
    if (telemetryLive()) startPump();
    else stopPump();
  }

  function telemetryTick() {
    if (!telemetryLive()) { stopPump(); return; }
    const sample = readTelemetry();
    if (!sample) return; // no reader installed yet — skip, do not invent a lap
    const t = Date.now();
    const ok = send('telemetry', {
      t,
      lap: sample.lap,
      raceTimeMs: sample.raceTimeMs,
      speedKph: sample.speedKph,
      state: sample.state,
    });
    if (!ok) return;
    telemetryStats.sent += 1;
    telemetryStats.lastAt = t;
    telemetryHistory.push({ t, lap: sample.lap, raceTimeMs: sample.raceTimeMs, speedKph: sample.speedKph, state: sample.state });
    while (telemetryHistory.length > MMO_LIMITS.TELEMETRY_HISTORY_MAX) telemetryHistory.shift();
    if (telemetryStats.sent % 8 === 0) {
      commit({ telemetry: { source: telemetryLabel, sent: telemetryStats.sent, lastAt: t } });
    }
    if (sample.state === 'finished' && !finishSent) {
      finishSent = true;
      send('finish', { raceTimeMs: sample.raceTimeMs, lap: sample.lap });
    }
  }

  function setTelemetrySource(fn, label) {
    if (fn == null) {
      telemetrySource = null;
      telemetryLabel = 'none';
    } else if (typeof fn === 'function') {
      telemetrySource = fn;
      telemetryLabel = str(label, '').trim() || str(fn.source, '').trim() || 'custom';
    } else {
      return telemetryLabel;
    }
    commit({ telemetry: { source: telemetryLabel, sent: telemetryStats.sent, lastAt: telemetryStats.lastAt } });
    syncTelemetry();
    return telemetryLabel;
  }

  /* ---- socket ---- */

  function wsUrl() {
    if (str(opts.url, '')) return opts.url;
    const loc = typeof location !== 'undefined' ? location : null;
    const proto = loc && loc.protocol === 'https:' ? 'wss:' : 'ws:';
    const host = loc && loc.host ? loc.host : '127.0.0.1:8080';
    return `${proto}//${host}/mmo`;
  }

  function socketWithDriverId(url) {
    // Reclaim: the same driverId in the hello frame (and in the query) lets a
    // refresh or a 1 s blip take its old seat back for 30 s.
    const driverId = snap.driverId || readStore('session', DRIVER_KEY);
    if (!driverId) return url;
    if (/[?&]driverId=/.test(url)) return url;
    return `${url}${url.indexOf('?') === -1 ? '?' : '&'}driverId=${encodeURIComponent(driverId)}`;
  }

  function makeSocket(url) {
    const Ctor = opts.WebSocket || opts.socketFactory
      || (typeof WebSocket !== 'undefined' ? WebSocket : null);
    if (!Ctor) throw new Error('no WebSocket');
    return new Ctor(url);
  }

  function on(target, event, handler) {
    if (!target) return;
    if (typeof target.addEventListener === 'function') target.addEventListener(event, handler);
    else target[`on${event}`] = handler;
  }

  function connect() {
    closedByUser = false;
    if (socket && (socket.readyState === 0 || socket.readyState === 1)) return api;
    clearReconnect();

    commit({ conn: attempt > 0 ? 'reconnecting' : 'connecting', attempt });

    let ws = null;
    try {
      ws = makeSocket(socketWithDriverId(wsUrl()));
    } catch (err) {
      if (typeof opts.onError === 'function') {
        try { opts.onError({ code: 'socket', message: String(err && err.message || err) }); } catch { /* ignore */ }
      }
      scheduleReconnect();
      return api;
    }
    socket = ws;

    on(ws, 'open', () => {
      if (socket !== ws) return;
      lastSeq = 0;
      seqSeen = false;
      attempt = 0;
      commit({ conn: 'open', attempt: 0 });
      startPing();
      send(helloFrame());
      if (wantSpectate) send('spectate', {});
      else if (wantQueued) send('queue', wantPartyCode ? { partyCode: wantPartyCode } : {});
      syncTelemetry(); // a reconnect mid-race restarts the 4 Hz pump
    });

    on(ws, 'message', (event) => {
      if (socket !== ws) return;
      const data = event && event.data !== undefined ? event.data : event;
      if (typeof data !== 'string') return; // binary frames are not part of /mmo
      applyFrame(data);
    });

    on(ws, 'close', () => {
      if (socket !== ws) return;
      socket = null;
      stopPing();
      stopPump();
      // Do NOT clear driverId here: a 1 s blip must keep the seat (30 s reclaim).
      if (closedByUser) { commit({ conn: 'closed' }); return; }
      scheduleReconnect();
    });

    on(ws, 'error', () => { /* the close event owns the retry */ });

    return api;
  }

  function clearReconnect() {
    if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = 0; }
  }

  function scheduleReconnect() {
    if (closedByUser) { commit({ conn: 'closed' }); return 0; }
    if (opts.reconnect === false) { commit({ conn: 'closed', attempt }); return 0; }
    if (attempt >= MMO_LIMITS.MAX_ATTEMPTS) { commit({ conn: 'closed', attempt }); return 0; }
    attempt += 1;
    const base = Math.min(MMO_LIMITS.BACKOFF_MAX, MMO_LIMITS.BACKOFF_MIN * Math.pow(2, attempt - 1));
    const delay = Math.round(base * (0.8 + Math.random() * 0.4));
    commit({ conn: 'reconnecting', attempt });
    clearReconnect();
    reconnectTimer = setTimeout(() => { reconnectTimer = 0; connect(); }, delay);
    return delay;
  }

  function close() {
    closedByUser = true;
    clearReconnect();
    stopPing();
    stopPump();
    const ws = socket;
    socket = null;
    if (ws) { try { ws.close(1000, 'bye'); } catch { /* already gone */ } }
    commit({ conn: 'closed', attempt: 0 });
    return api;
  }

  /* ---- ping ---- */

  function startPing() {
    if (pingTimer || opts.ping === false) return;
    pingTimer = setInterval(() => { send('ping', { at: Date.now() }); }, MMO_LIMITS.PING_MS);
  }

  function stopPing() {
    if (!pingTimer) return;
    clearInterval(pingTimer);
    pingTimer = 0;
  }

  /* ---- outbound ---- */

  function send(type, payload) {
    const message = typeof type === 'string'
      ? Object.assign({ type }, obj(payload) || {})
      : obj(type);
    if (!message || typeof message.type !== 'string') return false;
    if (!socket || socket.readyState !== 1) return false;
    try { socket.send(JSON.stringify(message)); } catch { return false; }
    if (sentLog.length < MMO_LIMITS.SENT_LOG_MAX) sentLog.push(message);
    return true;
  }

  function queue(queueOpts) {
    const extra = obj(queueOpts) || {};
    wantQueued = true;
    wantSpectate = false;
    const partyCode = normPartyCode(str(extra.partyCode, '')) || wantPartyCode || normPartyCode(snap.party && snap.party.code) || '';
    if (partyCode) wantPartyCode = partyCode;
    return send('queue', wantPartyCode ? { partyCode: wantPartyCode } : {});
  }

  function unqueue() {
    wantQueued = false;
    return send('unqueue', {});
  }

  function start() {
    return send('start', { at: Date.now() });
  }

  function spectate() {
    wantSpectate = true;
    wantQueued = false;
    return send('spectate', {});
  }

  function leave() {
    wantQueued = false;
    wantSpectate = false;
    wantPartyCode = '';
    return send('unqueue', {});
  }

  function setParty(mode, code) {
    const action = String(mode || '').toLowerCase();
    const clean = normPartyCode(code);
    if (action === 'create') {
      wantPartyCode = '';
      return send('party:create', {});
    }
    if (action === 'join') {
      wantPartyCode = clean;
      return send('party:join', clean ? { code: clean } : {});
    }
    if (action === 'leave') {
      wantPartyCode = '';
      commit({ party: { code: null, size: 0, members: [] } });
      return send('party:leave', {});
    }
    return false;
  }

  // Rename in place: the name is what `hello` sends, so a rename only reaches
  // the server with another `hello`. That is safe before a seat is assigned
  // (the seat list is what makes a rename ambiguous); after that it applies on
  // the next connect, and `localStorage` keeps it for that connect.
  function seated() {
    return typeof snap.you.seat === 'number' && snap.you.seat > 0;
  }

  function helloFrame() {
    const driverId = snap.driverId || readStore('session', DRIVER_KEY) || '';
    const partyCode = wantPartyCode || normPartyCode(snap.party && snap.party.code) || '';
    return {
      type: 'hello',
      name,
      driverId: driverId || undefined,
      partyCode: partyCode || undefined,
    };
  }

  function setName(value) {
    const clean = String(value == null ? '' : value).replace(/\s+/g, ' ').trim().slice(0, 24);
    if (!clean || clean === name) return name;
    name = clean;
    writeStore('local', NAME_KEY, clean);
    commit({ name: clean, you: { ...snap.you, name: clean } });
    if (socket && socket.readyState === 1 && !seated()) send(helloFrame());
    return name;
  }

  /* ---- test hooks ---- */

  const debug = Object.freeze({
    snapshot() { return JSON.parse(JSON.stringify(snap)); },
    inject(frame) { return applyFrame(frame); },
    sent() { return sentLog.slice(); },
    sentCount(type) { return sentLog.reduce((n, m) => n + (m.type === type ? 1 : 0), 0); },
    clearSent() { sentLog.length = 0; },
    telemetry() { return telemetryHistory.map((s) => ({ ...s })); },
    timers() { return { pump: !!pumpTimer, ping: !!pingTimer, reconnect: !!reconnectTimer }; },
    lastSeq() { return { seq: lastSeq, seen: seqSeen }; },
  });

  const api = {
    connect,
    close,
    send,
    queue,
    unqueue,
    start,
    spectate,
    leave,
    setParty,
    setName,
    setTelemetrySource,
    readTelemetry,
    subscribe,
    get state() { return snap; },
    get snapshot() { return snap; },
    get name() { return name; },
    get telemetrySource() { return telemetryLabel; },
    get driverId() { return snap.driverId || readStore('session', DRIVER_KEY); },
    _debug: debug,
  };

  return api;
}

/* ---------- window.__R4_MMO + auto-mount on /race-day ---------------------- */

function connToken(state) {
  // mmo.css styles #mmoConn[data-conn="linking|online|slow|offline"] and keeps
  // the <i> dot alive, so mirror those tokens instead of inventing new ones.
  switch (state.conn) {
    case 'open': return 'online';
    case 'connecting': return 'linking';
    case 'reconnecting': return state.attempt > 3 ? 'offline' : 'slow';
    default: return 'offline';
  }
}

function connLabel(state) {
  switch (state.conn) {
    case 'open': return 'LIVE';
    case 'connecting': return 'LINKING';
    case 'reconnecting': return `RETRY ${state.attempt}`;
    default: return 'OFFLINE';
  }
}

function paintConn(el, state) {
  if (!el) return;
  try {
    el.dataset.conn = connToken(state);
    el.dataset.link = state.conn;
    el.dataset.attempt = String(state.attempt);
    if (typeof state.rttMs === 'number') el.dataset.rtt = String(state.rttMs);
    // Text only, and in the existing text node, so the status dot (<i>) that
    // mmo.css paints is never destroyed. No innerHTML anywhere.
    const text = connLabel(state);
    const textNode = Array.prototype.find.call(el.childNodes || [], (n) => n && n.nodeType === 3);
    if (textNode) textNode.nodeValue = text;
    else if (typeof document.createTextNode === 'function') el.appendChild(document.createTextNode(text));
    else el.textContent = text;
  } catch { /* a missing/foreign node must not break the socket */ }
}

function installFacade(client) {
  const api = {
    client,
    get state() { return client.state; },
    send: (...args) => client.send(...args),
    setName: (...args) => client.setName(...args),
    readTelemetry: () => client.readTelemetry(),
    get telemetrySource() { return client.telemetrySource; },
    setTelemetrySource: (...args) => client.setTelemetrySource(...args),
    version: MMO_VERSION,
  };
  try {
    Object.defineProperty(window, '__R4_MMO', {
      value: api, configurable: true, enumerable: true, writable: true,
    });
  } catch {
    window.__R4_MMO = api;
  }
  return api;
}

function boot() {
  if (typeof window === 'undefined' || typeof document === 'undefined') return null;

  const existing = window.__R4_MMO && window.__R4_MMO.client;
  if (existing) return existing;

  const params = (() => {
    try { return new URLSearchParams((typeof location !== 'undefined' && location.search) || ''); }
    catch { return new URLSearchParams(''); }
  })();
  const path = String((typeof location !== 'undefined' && location.pathname) || '').replace(/\/+$/, '') || '/';
  const onRaceDay = /(^|\/)(race-day|mmo\.html|mmo)$/i.test(path);
  const connEl = document.getElementById('mmoConn');

  // Off /race-day (e.g. the /play HUD) we still publish the facade, but the
  // socket is opened by whoever mounts the HUD, not by this module.
  if (!onRaceDay && !connEl) {
    installFacade(createMmoClient());
    return window.__R4_MMO.client;
  }

  const client = createMmoClient({
    name: params.get('name') || undefined,
    spectate: params.get('spectate') === '1',
    partyCode: params.get('party') || undefined,
  });

  // Default callsign: fill a name field when the page has one, and keep the
  // conn chip's data-name for CSS/debug. Never write HTML.
  const nameEl = document.getElementById('mmoName')
    || document.querySelector('[data-mmo-name]')
    || document.querySelector('input[name="driver"]');
  try {
    if (nameEl && 'value' in nameEl && !nameEl.value) nameEl.value = client.state.name;
    if (connEl) connEl.dataset.driver = client.state.name;
    if (document.body && document.body.dataset) document.body.dataset.mmoName = client.state.name;
  } catch { /* optional */ }

  paintConn(connEl, client.state);
  const lookupConn = () => connEl || document.getElementById('mmoConn');
  client.subscribe((state) => paintConn(lookupConn(), state));

  try {
    window.addEventListener('beforeunload', () => { try { client.close(); } catch { /* ignore */ } });
  } catch { /* ignore */ }

  installFacade(client);

  if (params.get('spectate') === '1') client.spectate();
  client.connect();
  return client;
}

if (typeof window !== 'undefined') {
  try { boot(); } catch (err) {
    // A boot failure must never blank the page: keep a facade that can be
    // repaired by a later module.
    try {
      if (!window.__R4_MMO) {
        window.__R4_MMO = {
          client: null,
          state: null,
          send: () => false,
          readTelemetry: () => null,
          telemetrySource: 'none',
          setTelemetrySource: () => 'none',
          version: MMO_VERSION,
          bootError: String(err && err.message || err),
        };
      }
    } catch { /* ignore */ }
  }
}

export default createMmoClient;
