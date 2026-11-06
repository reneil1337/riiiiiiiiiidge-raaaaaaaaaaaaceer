/* Race Day — MMO view (header, 50-slot grid, standings, countdown, results, feed).
 *
 * Dependency-free ESM, no bundler, no framework: the same house style as
 * multiplayer.js. State comes from mmo-client.js through subscribe(); this file
 * never polls the socket and never touches layout maths.
 *
 * Contract: _runtime/analysis/20-mmo-contract.md §4 (UX) and §5 (ids).
 * Every DOM lookup is optional — a missing element silently disables that part
 * and must never throw (the page shell / LFG / HUD are owned by other agents).
 *
 * Cost model: 50 slots for the MVP, but the patchers are keyed by seat and diff
 * per cell, so a 500-driver board only touches rows that actually changed.
 * All updates coalesce into one requestAnimationFrame.
 */

const MAX_SEATS = 50;
const TOP_ROWS = 10;
const GRID_COLS = 5; // .mmo-grid is 5 columns at every width (mmo.css)
const FEED_VISIBLE = 40;
const RESULTS_MS = 20000;
const GO_HOLD_MS = 900;

const TEAMS = [
  { name: 'Solvalou', slug: 'sol', short: 'SOL' },
  { name: 'Pac Racing Club', slug: 'pac', short: 'PAC' },
  { name: 'Micro Mouse Mappy', slug: 'map', short: 'MAP' },
  { name: 'Dig Racing Team', slug: 'dig', short: 'DIG' },
];

/* Contract §5 course list, in-game menu order — used only when the server's
 * plan carries a trackIndex but no trackName. */
const TRACK_NAMES = [
  'Helter Skelter', 'Wonderhill', 'Edge of the Earth', 'Out of Blue',
  'Phantomile', 'Brightest Nite', 'Heaven and Hell', 'Shooting Hoops',
];

const PHASE_LABEL = {
  idle: 'LOBBY',
  lobby: 'LOBBY',
  grid: 'GRID LOCKED',
  countdown: 'GRID LOCKED',
  racing: 'RACING',
  results: 'RESULTS',
};

/* ---------- brand: team index / name -> stable slug + label ------------- */

function wrapTeam(n) {
  const i = Math.round(n) % 4;
  return i < 0 ? i + 4 : i;
}

function teamIndex(team) {
  if (typeof team === 'number' && Number.isFinite(team)) return wrapTeam(team);
  const raw = typeof team === 'string' ? team.trim() : '';
  if (!raw) return -1;
  const asNumber = Number(raw);
  if (Number.isFinite(asNumber)) return wrapTeam(asNumber);
  const key = raw.toLowerCase();
  let hit = TEAMS.findIndex((t) => t.slug === key || t.name.toLowerCase() === key);
  if (hit >= 0) return hit;
  hit = TEAMS.findIndex((t) => {
    const name = t.name.toLowerCase();
    return name.startsWith(key) || key.startsWith(t.slug) || name.includes(key);
  });
  return hit;
}

export function brand(team) {
  const found = teamIndex(team);
  const index = found >= 0 ? found : 0;
  const t = TEAMS[index];
  return {
    index,
    name: t.name,
    slug: t.slug,
    short: t.short,
    className: `mmo-team-${t.slug}`,
    label: `TEAM ${t.short} · ${t.name}`,
    known: found >= 0,
  };
}

/* ---------- small DOM + number helpers --------------------------------- */

const $id = (id) => {
  try { return document.getElementById(id); } catch { return null; }
};
const $q = (sel, scope) => {
  try { return (scope || document).querySelector(sel); } catch { return null; }
};

function setText(el, value) {
  if (!el) return false;
  const next = value === null || value === undefined ? '' : String(value);
  if (el.textContent === next) return false;
  el.textContent = next;
  return true;
}

function setAttr(el, name, value) {
  if (!el) return;
  if (value === null || value === undefined) {
    if (el.hasAttribute(name)) el.removeAttribute(name);
    return;
  }
  const next = String(value);
  if (el.getAttribute(name) !== next) el.setAttribute(name, next);
}

function setClass(el, name, on) {
  if (!el) return;
  if (el.classList.contains(name) !== !!on) el.classList.toggle(name, !!on);
}

function numOrNull(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string' && value.trim() !== '') {
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

const pad2 = (n) => String(Math.floor(n)).padStart(2, '0');

/** 41200 -> "0:41.2" (one decimal, contract §4.3). */
function fmtLapTime(ms) {
  const n = numOrNull(ms);
  if (n === null || n < 0) return null;
  const minutes = Math.floor(n / 60000);
  const seconds = (n % 60000) / 1000;
  return `${minutes}:${seconds < 10 ? '0' : ''}${seconds.toFixed(1)}`;
}

/** 41200 -> "0:41" (mm:ss-ish clock cell). */
function fmtClock(ms) {
  const n = numOrNull(ms);
  if (n === null || n < 0) return null;
  return `${Math.floor(n / 60000)}:${pad2((n % 60000) / 1000)}`;
}

/** Countdown / ETA: "00:12". */
function fmtMmSs(ms) {
  const n = numOrNull(ms);
  if (n === null || n <= 0) return '00:00';
  const total = Math.ceil(n / 1000);
  return `${pad2(total / 60)}:${pad2(total % 60)}`;
}

/** Feed stamp: local clock minute:second ("mm:ss"). */
function fmtStamp(at) {
  const n = numOrNull(at);
  if (n === null || n <= 0) return '--:--';
  const d = new Date(n);
  const mins = d.getMinutes();
  const secs = d.getSeconds();
  if (!Number.isFinite(mins) || !Number.isFinite(secs)) return '--:--';
  return `${pad2(mins)}:${pad2(secs)}`;
}

/** Gap chip text: "+0.8" / "−1.4" (U+2212) / "LAP DOWN" / "—". */
function fmtGap(ms, gapLap) {
  if (gapLap === true) return 'LAP DOWN';
  const n = numOrNull(ms);
  if (n === null) return '—';
  const v = (Math.abs(n) / 1000).toFixed(1);
  if (n > 0) return `+${v}`;
  if (n < 0) return `−${v}`;
  return '+0.0';
}

function fmtPos(position) {
  const n = numOrNull(position);
  return n === null ? '—' : `P${Math.round(n)}`;
}

function isTableHost(host) {
  if (!host) return false;
  const tag = host.tagName;
  if (tag === 'TBODY' || tag === 'THEAD' || tag === 'TABLE') return true;
  return !!(host.closest && host.closest('table'));
}

function makeRow(host, tableMode) {
  const row = document.createElement(tableMode ? 'tr' : 'div');
  if (!tableMode) {
    row.className = 'mmo-row';
    row.setAttribute('role', 'row');
  }
  row.dataset.mmoRow = '1';
  // Never a tab stop: 50 results + 10 standings rows twice over was 58+ presses
  // before BACK TO LOBBY (a11y K3). The skip link in the results overlay is the
  // intended way to reach your row.
  row.tabIndex = -1;
  return row;
}

function makeCell(tableMode, role) {
  const cell = document.createElement(tableMode ? 'td' : 'span');
  cell.className = `mmo-cell mmo-cell--${role}`;
  cell.dataset.mmoCell = role;
  if (!tableMode) cell.setAttribute('role', 'cell');
  if (role === 'pos' || role === 'lap' || role === 'time' || role === 'gap' || role === 'best') {
    cell.classList.add('mmo-num');
  }
  return cell;
}

/** Re-append managed rows in the requested order, only when it actually changed. */
function orderRows(host, rows) {
  if (!host || !rows.length) return;
  const wanted = rows.map((r) => r.el);
  const current = Array.from(host.children).filter((el) => el.dataset && el.dataset.mmoRow === '1');
  let same = current.length === wanted.length;
  if (same) {
    for (let i = 0; i < wanted.length; i += 1) {
      if (current[i] !== wanted[i]) { same = false; break; }
    }
  }
  if (same) return;
  const fragment = document.createDocumentFragment();
  for (const el of wanted) fragment.appendChild(el);
  host.appendChild(fragment);
}

function removeNoteRows(host) {
  if (!host) return;
  for (const el of Array.from(host.children)) {
    if (el.dataset && el.dataset.mmoRow === '1') continue;
    if (el.classList && el.classList.contains('mmo-row-note')) host.removeChild(el);
  }
}

/* ---------- state normalisation ---------------------------------------- */

const CONN_KEY = {
  open: 'live',
  live: 'live',
  connecting: 'reconnecting',
  reconnecting: 'reconnecting',
  closed: 'offline',
  offline: 'offline',
  error: 'offline',
};

function connKey(conn) {
  if (typeof conn === 'boolean') return conn ? 'live' : 'offline';
  const key = String(conn || '').toLowerCase();
  return CONN_KEY[key] || 'offline';
}

const PHASE_KEY = {
  lobby: 'lobby',
  grid: 'grid',
  gridlocked: 'grid',
  'grid-locked': 'grid',
  countdown: 'countdown',
  racing: 'racing',
  race: 'racing',
  results: 'results',
  result: 'results',
  finished: 'results',
};

function phaseKey(state) {
  const key = String(state || '').toLowerCase().replace(/\s+/g, '');
  return PHASE_KEY[key] || 'lobby';
}

function normalizeSeats(raw) {
  const seats = Array.isArray(raw) ? raw : [];
  const out = [];
  for (const entry of seats) {
    if (!entry || typeof entry !== 'object') continue;
    const seat = numOrNull(entry.seat);
    if (seat === null || seat < 1 || seat > MAX_SEATS) continue;
    out.push({
      seat: Math.round(seat),
      name: typeof entry.name === 'string' ? entry.name : '',
      driverId: typeof entry.driverId === 'string' ? entry.driverId : '',
      team: entry.team === null || entry.team === undefined ? null : entry.team,
      bot: entry.bot === true,
      state: typeof entry.state === 'string' ? entry.state : '',
      connected: entry.connected === false ? false : true,
    });
  }
  out.sort((a, b) => a.seat - b.seat);
  return out;
}

function normalizeRows(raw) {
  const rows = Array.isArray(raw) ? raw : [];
  const out = [];
  for (const entry of rows) {
    if (!entry || typeof entry !== 'object') continue;
    out.push({
      seat: numOrNull(entry.seat),
      name: typeof entry.name === 'string' ? entry.name : '',
      team: entry.team === null || entry.team === undefined ? null : entry.team,
      position: numOrNull(entry.position) ?? numOrNull(entry.pos),
      lap: numOrNull(entry.lap),
      raceTimeMs: numOrNull(entry.raceTimeMs) ?? numOrNull(entry.timeMs) ?? numOrNull(entry.totalMs),
      bestLapMs: numOrNull(entry.bestLapMs) ?? numOrNull(entry.bestMs) ?? numOrNull(entry.best),
      gapMs: numOrNull(entry.gapMs),
      gapLap: entry.gapLap === true,
      bot: entry.bot === true,
      state: typeof entry.state === 'string' ? entry.state : '',
    });
  }
  return out;
}

function normalizeFeed(raw) {
  const list = Array.isArray(raw) ? raw : (raw && Array.isArray(raw.items) ? raw.items : []);
  const out = [];
  const seen = new Set();
  for (const line of list) {
    if (!line) continue;
    const text = typeof line === 'string' ? line : (typeof line.text === 'string' ? line.text : '');
    if (!text) continue;
    const at = numOrNull(typeof line === 'object' ? line.at : null) ?? 0;
    const key = `${at}|${text}`;
    if (seen.has(key)) continue; // de-dupe the ring buffer a second time
    seen.add(key);
    out.push({ at, text });
  }
  return out;
}

function normalize(raw) {
  const s = raw && typeof raw === 'object' ? raw : {};
  const event = s.event && typeof s.event === 'object' ? s.event : {};
  const counts = event.counts && typeof event.counts === 'object' ? event.counts : {};
  const grid = s.grid && typeof s.grid === 'object' ? s.grid : {};
  const you = s.you && typeof s.you === 'object' ? s.you : {};
  const standings = s.standings && typeof s.standings === 'object' ? s.standings : {};
  const results = (s.results && typeof s.results === 'object' ? s.results : null)
    || (s.result && typeof s.result === 'object' ? s.result : {});
  const plan = event.plan && typeof event.plan === 'object' ? event.plan : null;
  const youTeam = typeof you.team === 'string' && you.team ? you.team : null;

  const eventIndex = numOrNull(event.index);
  const eventId = event.id === null || event.id === undefined ? null : event.id;
  const seats = normalizeSeats(grid.seats);
  const maxRaw = numOrNull(counts.max);
  const max = Math.min(MAX_SEATS, maxRaw && maxRaw > 0 ? Math.round(maxRaw) : MAX_SEATS);
  const standingRows = normalizeRows(standings.rows);
  const resultRows = normalizeRows(results.rows);
  const seatedFallback = seats.length;

  const slowRaw = s.slow === true || s.slowNetwork === true
    || (s.net && typeof s.net === 'object' && s.net.slow === true);

  return {
    raw: s,
    conn: connKey(s.conn),
    connRaw: typeof s.conn === 'string' ? s.conn : (typeof s.conn === 'boolean' ? (s.conn ? 'open' : 'closed') : 'closed'),
    attempt: numOrNull(s.attempt) ?? 0,
    phase: phaseKey(event.state),
    eventIndex: eventIndex !== null && eventIndex > 0 ? Math.round(eventIndex) : null,
    eventId,
    plan,
    max,
    seated: numOrNull(counts.seated) ?? seatedFallback,
    queued: numOrNull(counts.queued) ?? 0,
    bots: counts.bots === true,
    you: {
      seat: numOrNull(you.seat),
      team: youTeam,
      name: typeof you.name === 'string' ? you.name : '',
      driverId: typeof you.driverId === 'string' ? you.driverId : '',
      position: numOrNull(you.position) ?? numOrNull(standings.you && standings.you.position),
      gapMs: numOrNull(you.gapMs) ?? numOrNull(standings.you && standings.you.gapMs),
      gapLap: you.gapLap === true || (standings.you && standings.you.gapLap === true),
    },
    seats,
    standingsRows: standingRows,
    standingsYou: standings.you && typeof standings.you === 'object' ? standings.you : null,
    standingsLap: numOrNull(standings.lap),
    resultsRows: resultRows,
    resultsYou: results.you && typeof results.you === 'object' ? results.you : null,
    resultsFinishedAt: numOrNull(results.finishedAt),
    resultsAt: numOrNull(results.at),
    countdown: s.countdown && typeof s.countdown === 'object' ? s.countdown : null,
    feed: normalizeFeed(s.feed),
    slow: slowRaw,
  };
}

/* ---------- mount ------------------------------------------------------ */

export function mountMmoUi(root, clientArg) {
  if (typeof document === 'undefined') return null;
  const scope = typeof root === 'string' ? $q(root) : root;
  if (scope && scope.__mmoUi) return scope.__mmoUi;

  let client = clientArg || null;
  let unsubscribe = null;
  let snapshot = null;
  let lastGood = null;
  let lastEventKey = '';
  let rafId = 0;
  let fallbackTimer = 0;
  let ticker = 0;
  let destroyed = false;

  const dirty = { header: false, grid: false, standings: false, countdown: false, results: false, feed: false };
  const filter = { key: 'all' };
  const cd = { n: 0, startsAt: 0, at: 0, mode: 'n', sig: '' };
  let rovingSeat = null; // grid tab stop after an arrow-key move (a11y K3)
  let resultsOpen = false; // the results dialog is the active modal (a11y K1)
  let resultsReturnFocus = null; // where focus goes when it closes
  const cache = {
    gridHost: null,
    slots: new Map(),
    slotSig: new Map(),
    standHost: null,
    standTable: false,
    standRows: new Map(),
    yourHost: null,
    yourCells: null,
    resHost: null,
    resTable: false,
    resRows: new Map(),
    podium: [],
    feedHost: null,
    feedKeys: [],
    feedNodes: [],
    qualityText: '',
  };

  /* ---- reading state ---- */

  function externalState() {
    if (client && client.state) return client.state;
    const g = typeof window !== 'undefined' ? window.__R4_MMO : null;
    if (g && g.state) return g.state;
    return snapshot;
  }

  function withCarry(next) {
    const prev = lastGood;
    if (!prev) return next;
    const sameEvent = !next.eventId || !prev.eventId || next.eventId === prev.eventId;
    if (next.conn === 'live' && !sameEvent) return next; // a new event: no stale board
    // "never blank the screen": a dropped link (or a thinner frame) keeps the
    // last board on screen, dimmed, instead of clearing 50 rows.
    const carry = (value, fallback) => (value && value.length ? value : fallback);
    next.seats = carry(next.seats, prev.seats);
    next.standingsRows = carry(next.standingsRows, prev.standingsRows);
    next.resultsRows = carry(next.resultsRows, prev.resultsRows);
    next.feed = carry(next.feed, prev.feed);
    if (!next.plan) next.plan = prev.plan;
    if (!next.eventIndex) next.eventIndex = prev.eventIndex;
    if (next.eventId === null) next.eventId = prev.eventId;
    if (next.you.seat === null) {
      next.you = {
        ...prev.you,
        position: next.you.position === null ? prev.you.position : next.you.position,
        gapMs: next.you.gapMs === null ? prev.you.gapMs : next.you.gapMs,
      };
    }
    if (next.phase === 'lobby' && prev.phase !== 'lobby' && next.conn !== 'live') next.phase = prev.phase;
    if (!next.resultsFinishedAt) next.resultsFinishedAt = prev.resultsFinishedAt;
    if (!next.resultsAt) next.resultsAt = prev.resultsAt;
    return next;
  }

  function currentSnap() {
    return withCarry(normalize(externalState()));
  }

  /* ---- batching ---- */

  function schedule(...parts) {
    for (const part of parts) if (part in dirty) dirty[part] = true;
    if (rafId || fallbackTimer) return;
    const flush = () => { rafId = 0; if (fallbackTimer) { clearTimeout(fallbackTimer); fallbackTimer = 0; } flushNow(); };
    if (typeof requestAnimationFrame === 'function') rafId = requestAnimationFrame(flush);
    else fallbackTimer = setTimeout(flush, 16);
    // A backgrounded tab throttles rAF; this keeps the board from going stale.
    fallbackTimer = setTimeout(() => { if (rafId) { if (typeof cancelAnimationFrame === 'function') cancelAnimationFrame(rafId); rafId = 0; } flushNow(); }, 260);
  }

  function flushNow() {
    if (destroyed) return;
    const snap = snapshot || currentSnap();
    snapshot = snap;
    if (dirty.header) { dirty.header = false; renderHeader(snap); }
    if (dirty.grid) { dirty.grid = false; renderGrid(snap); }
    if (dirty.standings) { dirty.standings = false; renderStandings(snap); renderYourRow(snap); }
    if (dirty.countdown) { dirty.countdown = false; renderCountdown(snap); }
    if (dirty.results) { dirty.results = false; renderResults(snap); renderPodium(snap); }
    if (dirty.feed) { dirty.feed = false; renderFeed(snap); }
    const showResults = snap.phase === 'results' && snap.resultsRows.length > 0;
    if (showResults || cd.n > 0) startTicker();
    else stopTicker();
  }

  function resetBoardCaches() {
    for (const entry of cache.standRows.values()) {
      if (entry.el && entry.el.isConnected) entry.el.remove();
    }
    for (const entry of cache.resRows.values()) {
      if (entry.el && entry.el.isConnected) entry.el.remove();
    }
    cache.standRows.clear();
    cache.resRows.clear();
    cache.slotSig.clear();
    for (const node of cache.feedNodes) if (node && node.parentNode) node.parentNode.removeChild(node);
    cache.feedKeys = [];
    cache.feedNodes = [];
  }

  /* ---- header ---- */

  function carCell() {
    let el = $q('[data-mmo-car]');
    if (el) return el;
    const stats = $q('.mmo-event-stats');
    if (!stats) return null;
    const box = document.createElement('div');
    box.className = 'mmo-stat';
    box.dataset.mmoCarStat = '1';
    const dt = document.createElement('dt');
    dt.textContent = 'CAR';
    const dd = document.createElement('dd');
    el = document.createElement('b');
    el.className = 'mmo-num';
    el.dataset.mmoCar = '1';
    el.textContent = '—';
    dd.appendChild(el);
    box.append(dt, dd);
    stats.appendChild(box);
    return el;
  }

  function paintConn(el, snap) {
    if (!el) return;
    // mmo-client.js owns the same chip and mirrors CSS tokens, so write into its
    // existing text node and never touch the <i> dot: two writers, one node.
    const label = snap.conn === 'live' ? 'LIVE' : (snap.conn === 'reconnecting' ? 'RECONNECTING' : 'OFFLINE');
    const token = snap.conn === 'live'
      ? 'online'
      : (snap.connRaw === 'connecting' ? 'linking' : (snap.conn === 'reconnecting' ? (snap.attempt > 3 ? 'offline' : 'slow') : 'offline'));
    setAttr(el, 'data-conn', token);
    setAttr(el, 'data-link', snap.connRaw);
    setAttr(el, 'data-attempt', String(snap.attempt));
    setAttr(el, 'aria-label', `Connection: ${label.toLowerCase()}`);
    if (!el.querySelector('i')) {
      const dot = document.createElement('i');
      dot.setAttribute('aria-hidden', 'true');
      el.insertBefore(dot, el.firstChild);
    }
    const textNode = Array.prototype.find.call(el.childNodes, (n) => n && n.nodeType === 3);
    if (textNode) {
      if (textNode.nodeValue !== label) textNode.nodeValue = label;
    } else {
      el.appendChild(document.createTextNode(label));
    }
  }

  function renderHeader(snap) {
    const app = $id('mmoApp');
    if (app) {
      setAttr(app, 'data-conn', snap.conn === 'live' ? 'online' : (snap.conn === 'reconnecting' ? 'slow' : 'offline'));
      setAttr(app, 'data-link', snap.connRaw);
      setAttr(app, 'data-phase', snap.phase);
      setAttr(app, 'aria-busy', snap.conn === 'live' ? null : 'true');
      setAttr(app, 'data-stale', snap.conn === 'live' ? null : '1');
      setClass(app, 'is-stale', snap.conn !== 'live');
    }

    const idle = !snap.eventIndex && !snap.plan && !snap.seats.length;
    const eventHost = $id('mmoEvent');
    const numEl = $q('[data-mmo-event-num]');
    if (numEl) setText(numEl, snap.eventIndex ? `#${snap.eventIndex}` : '#—');
    else if (eventHost && !eventHost.children.length) setText(eventHost, snap.eventIndex ? `RACE DAY #${snap.eventIndex}` : 'WAITING FOR RACE DAY');
    if (eventHost) {
      setAttr(eventHost, 'data-idle', idle ? '1' : null);
      setAttr(eventHost, 'aria-label', snap.eventIndex ? `Race Day event ${snap.eventIndex}, ${PHASE_LABEL[snap.phase] || 'LOBBY'}` : 'Waiting for race day');
    }

    const trackEl = $q('[data-mmo-track]');
    const plan = snap.plan || {};
    const trackIndex = numOrNull(plan.trackIndex);
    const trackName = typeof plan.trackName === 'string' && plan.trackName
      ? plan.trackName
      : (trackIndex !== null ? TRACK_NAMES[trackIndex] || null : null);
    if (trackEl) setText(trackEl, trackName || (idle ? 'WAITING FOR RACE DAY' : 'TBC'));

    const carEl = carCell();
    if (carEl) setText(carEl, typeof plan.carClass === 'string' && plan.carClass ? plan.carClass : '—');

    const stateEl = $id('mmoState');
    if (stateEl) {
      const label = PHASE_LABEL[snap.phase] || 'LOBBY';
      setText(stateEl, label);
      setAttr(stateEl, 'data-state', snap.phase);
      setAttr(stateEl, 'aria-label', `Event state: ${label.toLowerCase()}`);
    }

    paintConn($id('mmoConn'), snap);

    const gridCountEl = $id('mmoGridCount');
    if (gridCountEl) {
      setText(gridCountEl, `${Math.max(0, Math.min(snap.max, snap.seated))}/${snap.max}`);
      setAttr(gridCountEl, 'aria-label', `${snap.seated} of ${snap.max} drivers seated`);
    }

    const mySeat = snap.you.seat !== null ? String(snap.you.seat) : '—';
    const seatEl = $q('[data-mmo-seat]');
    if (seatEl) {
      setText(seatEl, mySeat);
      setAttr(seatEl, 'data-mmo-filled', 'ui');
    }
    const teamEl = $id('mmoTeam');
    if (teamEl) {
      const team = snap.you.team ? brand(snap.you.team) : null;
      setText(teamEl, team ? team.name : 'NO TEAM');
      setAttr(teamEl, 'data-team', team ? team.slug : 'none');
      setAttr(teamEl, 'aria-label', team ? `Team: ${team.name}` : 'No team');
    }

    const clockEl = $q('[data-mmo-clock]');
    if (clockEl) setText(clockEl, fmtClock(myRaceTime(snap)) || '00:00');

    const badge = $id('mmoQualityBadge');
    if (badge) {
      if (!cache.qualityText) cache.qualityText = badge.textContent.trim() || 'NET AUTO';
      if (snap.slow) {
        setText(badge, 'SLOW');
        setAttr(badge, 'data-slow', '1');
        setAttr(badge, 'aria-label', 'Slow network: the board may lag behind the race');
      } else {
        setText(badge, cache.qualityText);
        setAttr(badge, 'data-slow', null);
        setAttr(badge, 'aria-label', 'Network quality: normal');
      }
    }
  }

  function myRaceTime(snap) {
    const mine = youRow(snap);
    return mine ? mine.raceTimeMs : null;
  }

  function isMine(snap, row) {
    if (!row) return false;
    if (snap.you.seat !== null && row.seat !== null && row.seat === snap.you.seat) return true;
    if (snap.you.driverId && row.driverId && row.driverId === snap.you.driverId) return true;
    return false;
  }

  function youRow(snap) {
    const rows = snap.standingsRows;
    for (const row of rows) {
      if (snap.you.seat !== null && row.seat === snap.you.seat) return row;
      if (snap.you.driverId && row.driverId === snap.you.driverId) return row;
    }
    const res = snap.resultsRows;
    for (const row of res) {
      if (snap.you.seat !== null && row.seat === snap.you.seat) return row;
    }
    return null;
  }

  function positionMap(snap) {
    const map = new Map();
    for (const row of snap.resultsRows) {
      if (row.seat !== null && row.position !== null && !map.has(row.seat)) map.set(row.seat, row.position);
    }
    for (const row of snap.standingsRows) {
      if (row.seat !== null && row.position !== null) map.set(row.seat, row.position);
    }
    return map;
  }

  /* ---- grid (50 slots) ---- */

  function slotParts(el) {
    let avatar = $q('.mmo-slot-avatar', el);
    if (!avatar) {
      avatar = document.createElement('span');
      avatar.className = 'mmo-slot-avatar';
      avatar.setAttribute('aria-hidden', 'true');
      el.insertBefore(avatar, el.firstChild);
    }
    let body = $q('.mmo-slot-body', el);
    if (!body) {
      body = document.createElement('span');
      body.className = 'mmo-slot-body';
      el.appendChild(body);
    }
    let name = $q('.mmo-slot-name', el);
    if (!name) {
      name = document.createElement('span');
      name.className = 'mmo-slot-name';
      body.appendChild(name);
    }
    let meta = $q('.mmo-slot-meta', el);
    if (!meta) {
      meta = document.createElement('span');
      meta.className = 'mmo-slot-meta mmo-num';
      body.appendChild(meta);
    }
    return { avatar, name, meta };
  }

  function makeSlot(seat) {
    const el = document.createElement('div');
    el.className = 'mmo-slot';
    el.dataset.seat = String(seat);
    el.dataset.state = 'empty';
    el.setAttribute('role', 'listitem');
    // Roving tabindex (a11y K3): exactly one slot is a tab stop; renderGrid picks
    // it (your seat, else seat 1) and the arrow keys move it.
    el.tabIndex = -1;
    slotParts(el).avatar.textContent = pad2(seat);
    return el;
  }

  function slotView(snap, seat, row, positions) {
    if (!row || (!row.driverId && !row.name)) {
      return {
        state: 'empty',
        name: 'OPEN',
        meta: '',
        aria: `Seat ${seat}, open`,
        flags: {},
      };
    }
    const mine = isMine(snap, row);
    const finished = row.state === 'finished';
    const offline = row.connected === false;
    const bot = row.bot;
    const position = positions.get(seat) ?? null;
    let state = 'seated';
    if (mine) state = 'you';
    else if (offline) state = 'offline';
    else if (bot) state = 'bot';
    else if (finished) state = 'finished';
    else if (row.state === 'queued') state = 'queued';

    const parts = [];
    if (mine) parts.push('YOU');
    if (bot) parts.push('BOT');
    if (offline) parts.push('OFFLINE');
    if (finished) parts.push(position !== null ? fmtPos(position) : 'P—');
    const live = youTimeFor(snap, seat);
    if (live && live.lap !== null) parts.push(`LAP ${live.lap}`);
    if (live && live.raceTimeMs !== null) {
      const t = fmtLapTime(live.raceTimeMs);
      if (t) parts.push(t);
    }
    const team = row.team !== null ? brand(row.team) : null;
    const aria = [
      `Seat ${seat}`,
      row.name || 'driver',
      team ? team.name : 'no team',
      mine ? 'you' : '',
      bot ? 'bot' : '',
      offline ? 'offline' : '',
      finished ? `finished ${fmtPos(position)}` : '',
    ].filter(Boolean).join(', ');

    return {
      state,
      name: row.name || `SEAT ${seat}`,
      meta: parts.join(' · '),
      aria,
      team,
      flags: { you: mine, bot, offline, finished, state: row.state },
    };
  }

  function youTimeFor(snap, seat) {
    for (const row of snap.standingsRows) {
      if (row.seat === seat) return row;
    }
    for (const row of snap.resultsRows) {
      if (row.seat === seat) return row;
    }
    return null;
  }

  function renderGrid(snap) {
    const host = $id('mmoGrid');
    if (!host) return;
    if (cache.gridHost !== host) {
      cache.gridHost = host;
      cache.slots.clear();
      cache.slotSig.clear();
    }
    const existing = host.querySelectorAll('[data-seat]');
    for (const el of existing) {
      const n = numOrNull(el.dataset.seat);
      if (n === null || n < 1 || n > MAX_SEATS) continue;
      if (!cache.slots.has(Math.round(n))) cache.slots.set(Math.round(n), el);
    }
    const bySeat = new Map();
    for (const row of snap.seats) bySeat.set(row.seat, row);
    const positions = positionMap(snap);
    const active = filter.key;
    const total = Math.min(MAX_SEATS, Math.max(1, snap.max || MAX_SEATS));

    for (let seat = 1; seat <= total; seat += 1) {
      let el = cache.slots.get(seat);
      if (!el || !el.isConnected) {
        el = makeSlot(seat);
        host.appendChild(el);
        cache.slots.set(seat, el);
      }
      const row = bySeat.get(seat) || null;
      const view = slotView(snap, seat, row, positions);
      const matches = active === 'all'
        || (active === 'bots' ? view.flags.bot : !!(view.team && active === view.team.slug));
      const filtered = active !== 'all' && !matches;
      const sig = `${view.state}|${view.name}|${view.meta}|${view.aria}|${view.team ? view.team.slug : ''}|${filtered ? 1 : 0}`;
      if (cache.slotSig.get(seat) === sig) continue;
      cache.slotSig.set(seat, sig);
      const parts = slotParts(el);
      setText(parts.avatar, pad2(seat));
      setText(parts.name, view.name);
      setText(parts.meta, view.meta);
      setAttr(el, 'data-state', view.state);
      setAttr(el, 'data-you', view.flags.you ? '1' : null);
      setAttr(el, 'data-bot', view.flags.bot ? '1' : null);
      setAttr(el, 'data-offline', view.flags.offline ? '1' : null);
      setAttr(el, 'data-finished', view.flags.finished ? '1' : null);
      setAttr(el, 'data-filtered', filtered ? '1' : null);
      if (view.team) setAttr(el, 'data-team', view.team.slug);
      setAttr(el, 'aria-label', view.aria);
      setClass(el, 'mmo-team', !!view.team);
    }

    // Roving tabindex: one stop for the whole 50-seat grid, on your seat when
    // you have one (a11y K3). Applied outside the signature diff so a seat that
    // did not change still loses/gains the tab stop when the stop moves.
    const stop = gridStopSeat(snap, total);
    for (let seat = 1; seat <= total; seat += 1) {
      const el = cache.slots.get(seat);
      if (el) setAttr(el, 'tabindex', seat === stop ? '0' : '-1');
    }
    setAttr(host, 'aria-label',
      `${total} seats, ${Math.max(0, Math.min(total, snap.seated))} occupied. Arrow keys move between seats; Home and End jump.`);
  }

  /** Which slot holds the grid's single tab stop. */
  function gridStopSeat(snap, total) {
    const mine = snap.you.seat;
    if (mine !== null && mine >= 1 && mine <= total) return Math.round(mine);
    if (rovingSeat !== null && rovingSeat >= 1 && rovingSeat <= total) return rovingSeat;
    return 1;
  }

  /* ---- standings (top 10 + you, keyed by seat) ---- */

  function wantedStandingRows(snap) {
    const wanted = [];
    const seen = new Set();
    for (const row of snap.standingsRows) {
      const mine = isMine(snap, row);
      const top = row.position !== null && row.position <= TOP_ROWS;
      if (!top && !mine) continue;
      const key = row.seat !== null ? `s${row.seat}` : `p${row.position}`;
      if (seen.has(key)) continue;
      seen.add(key);
      wanted.push({ key, row, mine });
      if (wanted.length >= TOP_ROWS + 2) break;
    }
    return wanted;
  }

  function standEntry(host, tableMode, key) {
    let entry = cache.standRows.get(key);
    if (entry && entry.el.isConnected) return entry;
    const el = makeRow(host, tableMode);
    el.className = 'mmo-row';
    el.dataset.key = key;
    const cells = {
      pos: makeCell(tableMode, 'pos'),
      driver: makeCell(tableMode, 'driver'),
      team: makeCell(tableMode, 'team'),
      lap: makeCell(tableMode, 'lap'),
      time: makeCell(tableMode, 'time'),
      gap: makeCell(tableMode, 'gap'),
    };
    cells.driver.classList.remove('mmo-num');
    el.append(cells.pos, cells.driver, cells.team, cells.lap, cells.time, cells.gap);
    entry = { el, cells, sig: '' };
    cache.standRows.set(key, entry);
    return entry;
  }

  function noteRow(host, tableMode, text) {
    let note = host.querySelector('[data-mmo-note]');
    if (!note) {
      note = makeRow(host, tableMode);
      note.className = 'mmo-row-note';
      note.dataset.mmoNote = '1';
      note.tabIndex = -1;
      const cell = makeCell(tableMode, 'note');
      if (tableMode) cell.colSpan = 6;
      note.appendChild(cell);
      host.appendChild(note);
    }
    const cell = note.firstElementChild;
    setText(cell, text);
    return note;
  }

  function renderStandings(snap) {
    const host = $id('mmoStandingsBody');
    if (!host) return;
    if (cache.standHost !== host) {
      cache.standHost = host;
      cache.standRows.clear();
      cache.standTable = isTableHost(host);
    }
    const tableMode = cache.standTable;
    const wanted = wantedStandingRows(snap);

    if (!wanted.length) {
      for (const entry of cache.standRows.values()) if (entry.el.isConnected) entry.el.remove();
      cache.standRows.clear();
      noteRow(host, tableMode, snap.conn === 'live'
        ? 'NO STANDINGS YET — THE BOARD FILLS AT 2 HZ ONCE THE RACE STARTS'
        : 'RECONNECTING — SHOWING THE LAST BOARD');
      return;
    }

    removeNoteRows(host);
    const entries = [];
    for (const { key, row, mine } of wanted) {
      const entry = standEntry(host, tableMode, key);
      const time = fmtLapTime(row.raceTimeMs) || '—';
      const gap = fmtGap(row.gapMs, row.gapLap);
      const team = row.team !== null ? brand(row.team) : null;
      const pos = fmtPos(row.position);
      const sig = `${pos}|${row.name}|${team ? team.name : ''}|${row.lap}|${time}|${gap}|${mine ? 1 : 0}`;
      if (entry.sig !== sig) {
        entry.sig = sig;
        setText(entry.cells.pos, pos);
        setText(entry.cells.driver, row.name || '—');
        setText(entry.cells.team, team ? team.name : '—');
        setText(entry.cells.lap, row.lap !== null ? String(row.lap) : '—');
        setText(entry.cells.time, time);
        setText(entry.cells.gap, gap);
        setAttr(entry.cells.gap, 'data-lapdown', row.gapLap ? '1' : null);
        setAttr(entry.cells.pos, 'aria-label', row.position !== null ? `Position ${row.position} of ${snap.max}` : 'Position unknown');
      }
      setAttr(entry.el, 'data-you', mine ? '1' : null);
      setAttr(entry.el, 'data-seat', row.seat !== null ? String(row.seat) : null);
      setClass(entry.el, 'is-you', mine);
      entries.push(entry);
    }
    orderRows(host, entries);

    const note = host.querySelector('[data-mmo-note]');
    if (note) note.remove();
  }

  function renderYourRow(snap) {
    const cells = yourCells();
    if (!cells) return;
    const mine = youRow(snap);
    const you = snap.you;
    const position = you.position !== null ? you.position : (mine ? mine.position : null);
    const lap = mine && mine.lap !== null ? mine.lap : snap.standingsLap;
    const time = mine ? mine.raceTimeMs : null;
    const gap = you.gapMs !== null ? you.gapMs : (mine ? mine.gapMs : null);
    const gapLap = you.gapLap || (mine ? mine.gapLap : false);
    const team = you.team ? brand(you.team) : null;

    setText(cells.pos, position !== null ? `P${Math.round(position)} / ${snap.max}` : `— / ${snap.max}`);
    setText(cells.name, 'YOU');
    setText(cells.team, team ? team.name : 'NO TEAM');
    setAttr(cells.team, 'data-team', team ? team.slug : 'none');
    setText(cells.lap, lap !== null ? `LAP ${lap}` : 'LAP —');
    setText(cells.time, fmtLapTime(time) || '—');
    setText(cells.gap, fmtGap(gap, gapLap));
    setAttr(cells.gap, 'data-lapdown', gapLap ? '1' : null);
    setAttr(cells.pos, 'data-position', position !== null ? String(Math.round(position)) : null);

    const host = $id('mmoYourRow');
    setAttr(host, 'data-state', snap.phase);
    setAttr(host, 'aria-label', `Your standing: ${fmtPos(position)} of ${snap.max}, lap ${lap !== null ? lap : 'unknown'}, time ${fmtLapTime(time) || 'unknown'}, gap ${fmtGap(gap, gapLap)}`);
  }

  function yourCells() {
    const host = $id('mmoYourRow');
    if (!host) return null;
    if (cache.yourHost === host && cache.yourCells) return cache.yourCells;
    const tableMode = host.tagName === 'TR';
    const tag = tableMode ? 'td' : 'span';
    const ensure = (el, cls, role) => {
      if (!el) {
        el = document.createElement(tag);
        el.className = cls;
        host.appendChild(el);
      }
      if (role) {
        el.dataset.mmoYou = role;
        el.classList.add('mmo-num');
      }
      return el;
    };
    const nums = Array.from(host.querySelectorAll('.mmo-your-num'));
    const byRole = (role) => nums.find((el) => el.dataset && el.dataset.mmoYou === role);
    cache.yourHost = host;
    cache.yourCells = {
      pos: ensure($q('[data-mmo-you-pos]', host) || $q('.mmo-your-pos', host), 'mmo-your-pos', null),
      name: ensure($q('.mmo-your-name', host), 'mmo-your-name', null),
      team: ensure($q('.mmo-your-team', host), 'mmo-your-team', null),
      lap: ensure(byRole('lap') || nums[0], 'mmo-your-num', 'lap'),
      time: ensure(byRole('time') || nums[1], 'mmo-your-num', 'time'),
      gap: ensure(byRole('gap') || null, 'mmo-your-num mmo-your-gap', 'gap'),
    };
    setAttr(cache.yourCells.gap, 'data-mmo-you-gap', '1');
    setAttr(cache.yourCells.gap, 'aria-hidden', 'false');
    return cache.yourCells;
  }

  /* ---- countdown (3-2-1-GO) ---- */

  const reduceMotion = (() => {
    try {
      return typeof matchMedia === 'function' ? matchMedia('(prefers-reduced-motion: reduce)') : { matches: false };
    } catch { return { matches: false }; }
  })();

  function renderCountdown(snap) {
    const el = $id('mmoCountdown');
    if (!el) return;
    // a11y L4: polite, not assertive (the race starts on its own clock — no need
    // to interrupt), and the label is static so each digit mutates one node once.
    setAttr(el, 'aria-live', 'polite');
    setAttr(el, 'aria-atomic', 'true');
    setAttr(el, 'data-reduced-motion', reduceMotion.matches ? '1' : null);

    const frame = snap.countdown;
    const at = frame ? numOrNull(frame.at) : null;
    const n = frame ? numOrNull(frame.n) : null;
    const startsAt = frame ? numOrNull(frame.startsAt) : null;
    const sig = `${at}|${n}|${startsAt}`;
    if (frame && sig !== cd.sig) {
      cd.sig = sig;
      cd.at = at || 0;
      cd.n = n && n > 0 ? Math.min(9, Math.round(n)) : 0;
      cd.startsAt = startsAt || 0;
      // `startsAt` is server epoch ms. Without a serverAt/skew sample we only
      // trust it when the two clocks agree to within a minute; otherwise count
      // down from the frame's own `n` (contract §3.2 fallback).
      const skew = cd.startsAt > 0 && cd.at > 0 ? Math.abs(cd.startsAt - cd.at) : Infinity;
      cd.mode = skew < 60000 ? 'clock' : 'n';
    }
    if (snap.phase === 'lobby' || snap.phase === 'results') {
      cd.n = 0;
      cd.startsAt = 0;
      cd.mode = 'n';
    }
    paintCountdown();
  }

  function paintCountdown() {
    const el = $id('mmoCountdown');
    if (!el) return;
    const numEl = $q('[data-mmo-countdown-n]', el);
    const now = Date.now();
    let label = '';
    let go = false;
    if (cd.mode === 'clock' && cd.startsAt > 0) {
      const remaining = cd.startsAt - now;
      if (remaining > 0) label = String(Math.min(9, Math.ceil(remaining / 1000)));
      else if (now - cd.startsAt < GO_HOLD_MS) { label = 'GO'; go = true; }
      else { cd.n = 0; cd.startsAt = 0; }
    } else if (cd.n > 0) {
      const elapsed = now - (cd.at || now);
      const left = cd.n - Math.floor(elapsed / 1000);
      if (left >= 1) label = String(left);
      else if (elapsed < cd.n * 1000 + GO_HOLD_MS) { label = 'GO'; go = true; }
      else cd.n = 0;
    }
    const show = label !== '';
    if (el.hidden !== !show) el.hidden = !show;
    if (!show) {
      setAttr(el, 'aria-label', 'Race start countdown');
      return;
    }
    setAttr(el, 'data-go', go ? '1' : null);
    // No per-digit aria-label: it doubled every announcement (label + number).
    // The number below is the one and only mutation per second.
    setAttr(el, 'aria-label', go ? 'Race started' : 'Race start countdown');
    setText(numEl, label);
  }

  /* ---- results (50 rows, your row pinned) ---- */

  function resultsChrome() {
    const wrap = $id('mmoResults');
    if (!wrap) return null;
    // a11y K1: the results sheet is a modal dialog, not a live region —
    // 50 rows must not be announced on open, and focus must land inside it.
    setAttr(wrap, 'tabindex', '-1');
    setAttr(wrap, 'role', 'dialog');
    setAttr(wrap, 'aria-modal', 'true');
    setAttr(wrap, 'aria-labelledby', 'mmoResultsTitle');
    setAttr(wrap, 'aria-live', null);
    if (!wrap.querySelector('[data-mmo-status]')) {
      const status = document.createElement('p');
      status.className = 'mmo-sr';
      status.id = 'mmoResultsStatus';
      status.dataset.mmoStatus = '1';
      status.setAttribute('role', 'status');
      status.setAttribute('aria-live', 'polite');
      status.setAttribute('aria-atomic', 'true');
      wrap.appendChild(status); // one compact announcement, written once (L2)
    }
    if (!wrap.querySelector('[data-mmo-skip]')) {
      const link = document.createElement('a');
      link.className = 'mmo-skip';
      link.href = '#mmoYourResult';
      link.dataset.mmoSkip = '1';
      link.textContent = 'SKIP TO MY RESULT';
      link.addEventListener('click', (event) => {
        const row = $id('mmoYourResult');
        if (!row) return; // no row yet: let the browser do whatever it does
        event.preventDefault();
        setAttr(row, 'tabindex', '-1');
        try { row.focus({ preventScroll: false }); } catch { try { row.focus(); } catch { /* ignore */ } }
        if (typeof row.scrollIntoView === 'function') row.scrollIntoView({ block: 'center' });
      });
      wrap.prepend(link);
    }
    if (wrap.dataset.mmoDialog !== '1') {
      wrap.dataset.mmoDialog = '1';
      wrap.addEventListener('keydown', onResultsKeydown);
    }
    return wrap;
  }

  /** Tab stays inside the dialog: the first stop after the skip link is BACK TO LOBBY. */
  function onResultsKeydown(event) {
    if (event.key !== 'Tab') return;
    const wrap = $id('mmoResults');
    if (!wrap || wrap.hidden) return;
    const stops = Array.from(wrap.querySelectorAll('a[href], button:not([disabled]), input:not([disabled]), [tabindex="0"]'))
      .filter((el) => el.getClientRects().length > 0);
    if (!stops.length) {
      event.preventDefault();
      try { wrap.focus({ preventScroll: true }); } catch { /* ignore */ }
      return;
    }
    const first = stops[0];
    const last = stops[stops.length - 1];
    const active = document.activeElement;
    if (!wrap.contains(active)) {
      event.preventDefault();
      try { first.focus(); } catch { /* ignore */ }
      return;
    }
    if (stops.indexOf(active) === -1) {
      // e.g. the focused "your result" row (tabindex=-1): keep the next Tab in
      // the dialog instead of letting it fall out to the page behind.
      event.preventDefault();
      const target = event.shiftKey ? last : first;
      try { target.focus(); } catch { /* ignore */ }
      return;
    }
    if (!event.shiftKey && active === last) {
      event.preventDefault();
      try { first.focus(); } catch { /* ignore */ }
    } else if (event.shiftKey && (active === first || active === wrap)) {
      event.preventDefault();
      try { last.focus(); } catch { /* ignore */ }
    }
  }

  function openResultsDialog(wrap) {
    if (resultsOpen) return;
    resultsOpen = true;
    const active = typeof document !== 'undefined' ? document.activeElement : null;
    resultsReturnFocus = active && active !== document.body && !wrap.contains(active) ? active : null;
    // The next Tab is the skip link, then BACK TO LOBBY — inside the 20 s window.
    try { wrap.focus({ preventScroll: true }); } catch { try { wrap.focus(); } catch { /* ignore */ } }
  }

  function closeResultsDialog() {
    if (!resultsOpen) return;
    resultsOpen = false;
    const back = resultsReturnFocus;
    resultsReturnFocus = null;
    if (back && back.isConnected && typeof back.focus === 'function') {
      try { back.focus({ preventScroll: true }); } catch { try { back.focus(); } catch { /* ignore */ } }
    }
  }

  /** The one announcement for the whole screen (a11y L2). */
  function announceResults(snap, mine) {
    const wrap = $id('mmoResults');
    const status = wrap ? wrap.querySelector('[data-mmo-status]') : null;
    if (!status || !mine) return;
    const total = Math.min(MAX_SEATS, Math.max(1, snap.max || MAX_SEATS));
    const next = Math.max(1, Math.round(RESULTS_MS / 1000));
    setText(status, `Results ready. You finished ${fmtPos(mine.position)} of ${total}. Next race in ${next} seconds.`);
  }

  function resultEntry(host, tableMode, key) {
    let entry = cache.resRows.get(key);
    if (entry && entry.el.isConnected) return entry;
    const el = makeRow(host, tableMode);
    el.className = 'mmo-row';
    el.dataset.key = key;
    const cells = {
      pos: makeCell(tableMode, 'pos'),
      driver: makeCell(tableMode, 'driver'),
      team: makeCell(tableMode, 'team'),
      total: makeCell(tableMode, 'time'),
      best: makeCell(tableMode, 'best'),
      gap: makeCell(tableMode, 'gap'),
    };
    cells.driver.classList.remove('mmo-num');
    el.append(cells.pos, cells.driver, cells.team, cells.total, cells.best, cells.gap);
    entry = { el, cells, sig: '' };
    cache.resRows.set(key, entry);
    return entry;
  }

  function youResultRow(snap) {
    const rows = snap.resultsRows;
    const you = snap.resultsYou || {};
    const position = numOrNull(you.position);
    if (position !== null) {
      for (const row of rows) if (row.position === position) return row;
    }
    if (snap.you.seat !== null) {
      for (const row of rows) if (row.seat === snap.you.seat) return row;
    }
    return null;
  }

  function renderResults(snap) {
    const wrap = resultsChrome();
    const host = $id('mmoResultsBody');
    const show = snap.phase === 'results' && snap.resultsRows.length > 0;
    if (wrap) {
      const wasHidden = wrap.hidden;
      wrap.hidden = !show;
      if (show && wasHidden) openResultsDialog(wrap);
      else if (!show && !wasHidden) closeResultsDialog();
    }
    if (!host) return;
    if (cache.resHost !== host) {
      cache.resHost = host;
      cache.resRows.clear();
      cache.resTable = isTableHost(host);
    }
    const tableMode = cache.resTable;
    if (!snap.resultsRows.length) {
      for (const entry of cache.resRows.values()) if (entry.el.isConnected) entry.el.remove();
      cache.resRows.clear();
      noteRow(host, tableMode, 'NO RESULT YET — FINISH THE RACE OR WAIT FOR THE NEXT EVENT');
      paintNextRace(snap);
      return;
    }

    removeNoteRows(host);
    const mine = youResultRow(snap);
    const entries = [];
    let seen = 0;
    for (const row of snap.resultsRows) {
      if (seen >= MAX_SEATS) break; // >50 seats never render
      seen += 1;
      const key = row.seat !== null ? `s${row.seat}` : `p${row.position !== null ? row.position : seen}`;
      const entry = resultEntry(host, tableMode, key);
      const isYou = (mine && mine === row) || (snap.you.seat !== null && row.seat === snap.you.seat);
      const total = fmtLapTime(row.raceTimeMs) || '—';
      const best = fmtLapTime(row.bestLapMs) || '—';
      const gap = fmtGap(row.gapMs, row.gapLap);
      const team = row.team !== null ? brand(row.team) : null;
      const sig = `${fmtPos(row.position)}|${row.name}|${team ? team.name : ''}|${total}|${best}|${gap}|${isYou ? 1 : 0}`;
      if (entry.sig !== sig) {
        entry.sig = sig;
        setText(entry.cells.pos, fmtPos(row.position));
        setText(entry.cells.driver, row.name || '—');
        setText(entry.cells.team, team ? team.name : '—');
        setText(entry.cells.total, total);
        setText(entry.cells.best, best);
        setText(entry.cells.gap, gap);
        setAttr(entry.cells.gap, 'data-lapdown', row.gapLap ? '1' : null);
      }
      setAttr(entry.el, 'data-you', isYou ? '1' : null);
      setAttr(entry.el, 'data-seat', row.seat !== null ? String(row.seat) : null);
      setClass(entry.el, 'is-you', isYou);
      if (isYou) {
        setAttr(entry.el, 'id', 'mmoYourResult');
        setAttr(entry.el, 'data-pinned', '1');
        setAttr(entry.el, 'tabindex', '-1');
        setAttr(entry.el, 'aria-label', `Your result: ${fmtPos(row.position)} of ${snap.max}, total ${total}, best lap ${best}`);
      } else if (entry.el.id === 'mmoYourResult') {
        entry.el.removeAttribute('id');
        setAttr(entry.el, 'data-pinned', null);
      }
      entries.push(entry);
    }
    orderRows(host, entries);
    const note = host.querySelector('[data-mmo-note]');
    if (note) note.remove();
    announceResults(snap, mine);
    paintNextRace(snap);
  }

  function renderPodium(snap) {
    const host = $id('mmoPodium');
    if (!host) return;
    for (const slot of Array.from(host.querySelectorAll('[data-place]'))) {
      const place = numOrNull(slot.dataset.place);
      const row = place === null ? null : (snap.resultsRows.find((r) => r.position === place) || null);
      const team = row && row.team !== null ? brand(row.team) : null;
      const name = row ? (row.name || `SEAT ${row.seat}`) : '—';
      const meta = row
        ? [team ? team.name : '—', fmtLapTime(row.raceTimeMs) || '—'].join(' · ')
        : 'AWAITING RESULT';
      setText($q('.mmo-podium-name', slot), name);
      setText($q('.mmo-podium-meta', slot), meta);
      setAttr(slot, 'data-filled', row ? '1' : null);
      setAttr(slot, 'data-team', team ? team.slug : null);
      setAttr(slot, 'aria-label', row
        ? `P${place}, ${name}, ${team ? team.name : 'no team'}, ${fmtLapTime(row.raceTimeMs) || 'no time'}`
        : `P${place} awaiting result`);
    }
  }

  function ensureNextRace() {
    const host = $id('mmoNextRace');
    if (!host) return null;
    // a11y L2: the clock ticks 1x/s — keep it out of the live regions.
    setAttr(host, 'aria-live', 'off');
    let bold = $q('[data-mmo-next]', host) || $q('b', host);
    if (!bold) {
      bold = document.createElement('b');
      bold.className = 'mmo-num';
      host.appendChild(document.createTextNode(' '));
      host.appendChild(bold);
    }
    bold.dataset.mmoNext = '1';
    return bold;
  }

  function paintNextRace(snap) {
    const bold = ensureNextRace();
    if (!bold) return;
    const finished = snap.resultsFinishedAt;
    const now = Date.now();
    const deadline = finished !== null && Math.abs(finished - now) < 120000
      ? finished + RESULTS_MS
      : (snap.resultsAt !== null ? snap.resultsAt + RESULTS_MS : null);
    setText(bold, deadline === null ? '--:--' : fmtMmSs(deadline - now));
  }

  /* ---- feed (role=log, newest last, max 40, de-duplicated) ---- */

  function renderFeed(snap) {
    const host = $id('mmoFeed');
    if (!host) return;
    setAttr(host, 'role', 'log');
    setAttr(host, 'aria-live', 'polite');
    setAttr(host, 'aria-relevant', 'additions');
    if (cache.feedHost !== host) {
      cache.feedHost = host;
      cache.feedKeys = [];
      cache.feedNodes = [];
    }
    const items = snap.feed.slice(-FEED_VISIBLE);
    if (items.length) {
      for (const placeholder of Array.from(host.querySelectorAll('[data-placeholder]'))) placeholder.remove();
    }
    const keys = items.map((line) => `${line.at}|${line.text}`);
    let diverge = 0;
    while (diverge < keys.length && diverge < cache.feedKeys.length && keys[diverge] === cache.feedKeys[diverge]) {
      diverge += 1;
    }
    if (diverge === keys.length && keys.length === cache.feedKeys.length) return;

    while (cache.feedNodes.length > diverge) {
      const node = cache.feedNodes.pop();
      if (node && node.parentNode) node.parentNode.removeChild(node);
    }
    cache.feedKeys.length = diverge;

    const listTag = host.tagName === 'OL' || host.tagName === 'UL' ? 'li' : 'div';
    for (let i = diverge; i < items.length; i += 1) {
      const line = items[i];
      const row = document.createElement(listTag);
      row.className = 'mmo-feed-line';
      row.dataset.mmoRow = '1';
      if (listTag === 'div') row.setAttribute('role', 'listitem');
      const stamp = document.createElement('time');
      stamp.className = 'mmo-feed-tag mmo-num';
      stamp.dataset.mmoStamp = '1';
      if (line.at) {
        try { stamp.dateTime = new Date(line.at).toISOString(); } catch { /* cosmetic */ }
      }
      setText(stamp, fmtStamp(line.at));
      const text = document.createElement('span');
      text.className = 'mmo-feed-text';
      setText(text, line.text);
      row.append(stamp, text);
      host.appendChild(row);
      cache.feedNodes.push(row);
      cache.feedKeys.push(keys[i]);
    }
  }

  /* ---- 250 ms ticker (countdown + next-race only; never polls state) ---- */

  function startTicker() {
    if (ticker || destroyed) return;
    ticker = setInterval(tick, 250);
  }

  function stopTicker() {
    if (!ticker) return;
    clearInterval(ticker);
    ticker = 0;
  }

  function tick() {
    const snap = snapshot;
    if (!snap) { stopTicker(); return; }
    if (cd.n > 0 || cd.startsAt > 0) paintCountdown();
    if (snap.phase === 'results') paintNextRace(snap);
    if (!(cd.n > 0 || cd.startsAt > 0) && snap.phase !== 'results') stopTicker();
  }

  /* ---- grid keyboard: arrow keys move the single tab stop (a11y K3) ----- */

  function bindGridKeys() {
    const host = $id('mmoGrid');
    if (!host || host.dataset.mmoGridKeys === '1') return;
    host.dataset.mmoGridKeys = '1';
    host.addEventListener('keydown', onGridKeydown);
  }

  function onGridKeydown(event) {
    if (event.altKey || event.ctrlKey || event.metaKey) return;
    const target = event.target && event.target.closest ? event.target.closest('.mmo-slot') : null;
    if (!target) return;
    const seat = numOrNull(target.dataset.seat);
    if (seat === null) return;
    const total = Math.min(MAX_SEATS, Math.max(1, (snapshot && snapshot.max) || MAX_SEATS));
    let next = null;
    switch (event.key) {
      case 'ArrowRight': next = seat + 1; break;
      case 'ArrowLeft': next = seat - 1; break;
      case 'ArrowDown': next = seat + GRID_COLS; break;
      case 'ArrowUp': next = seat - GRID_COLS; break;
      case 'Home': next = 1; break;
      case 'End': next = total; break;
      default: return;
    }
    event.preventDefault();
    moveGridFocus(Math.min(total, Math.max(1, next)));
  }

  function moveGridFocus(seat) {
    const host = $id('mmoGrid');
    const el = host ? host.querySelector(`.mmo-slot[data-seat="${seat}"]`) : null;
    if (!el) return;
    rovingSeat = seat;
    if (host) {
      for (const node of host.querySelectorAll('.mmo-slot')) {
        setAttr(node, 'tabindex', Number(node.dataset.seat) === seat ? '0' : '-1');
      }
    }
    try { el.focus({ preventScroll: true }); } catch { try { el.focus(); } catch { /* ignore */ } }
    try { el.scrollIntoView({ block: 'nearest' }); } catch { /* older engines */ }
  }

  /* ---- grid filters (ALL / SOL / PAC / MAP / DIG / BOTS) ---- */

  function bindFilters() {
    const host = $id('mmoFilters');
    if (!host || host.dataset.mmoUiFilters === '1') return;
    host.dataset.mmoUiFilters = '1';
    const labels = {
      all: 'Show all 50 seats',
      sol: 'Show Solvalou seats only',
      pac: 'Show Pac Racing Club seats only',
      map: 'Show Micro Mouse Mappy seats only',
      dig: 'Show Dig Racing Team seats only',
      bots: 'Show bot seats only',
    };
    const chips = Array.from(host.querySelectorAll('[data-filter]'));
    for (const chip of chips) {
      const key = String(chip.dataset.filter || 'all');
      if (labels[key]) setAttr(chip, 'aria-label', labels[key]);
      const on = key === filter.key;
      setAttr(chip, 'aria-pressed', on ? 'true' : 'false');
      setClass(chip, 'is-on', on);
      chip.addEventListener('click', () => {
        filter.key = key;
        for (const other of chips) {
          const active = String(other.dataset.filter || 'all') === key;
          setAttr(other, 'aria-pressed', active ? 'true' : 'false');
          setClass(other, 'is-on', active);
        }
        cache.slotSig.clear();
        schedule('grid');
      });
    }
  }

  /* ---- wiring ---- */

  function applyState(state) {
    snapshot = withCarry(normalize(state === undefined ? externalState() : state));
    lastGood = snapshot;
    const eventKey = `${snapshot.eventId === null ? '' : snapshot.eventId}|${snapshot.eventIndex === null ? '' : snapshot.eventIndex}`;
    if (eventKey !== lastEventKey) {
      lastEventKey = eventKey;
      if (snapshot.phase === 'lobby' || snapshot.phase === 'grid') resetBoardCaches();
    }
    schedule('header', 'grid', 'standings', 'countdown', 'results', 'feed');
    return snapshot;
  }

  function bindClient(next) {
    if (!next) return;
    if (unsubscribe) { try { unsubscribe(); } catch { /* ignore */ } unsubscribe = null; }
    client = next;
    if (typeof next.subscribe === 'function') {
      unsubscribe = next.subscribe(() => applyState(next.state));
    }
    applyState(next.state);
  }

  function watchClient(tries) {
    const n = tries || 0;
    if (destroyed || client) return;
    const g = typeof window !== 'undefined' ? window.__R4_MMO : null;
    if (g && g.client) { bindClient(g.client); return; }
    if (n > 40) { applyState(null); return; } // 10 s, then paint the empty shell once
    setTimeout(() => watchClient(n + 1), 250);
  }

  function injectFrame(frame) {
    if (!frame || typeof frame !== 'object') return snapshot;
    if (typeof frame.type === 'string' && client && client._debug && typeof client._debug.inject === 'function') {
      const result = client._debug.inject(frame);
      applyState(client.state);
      return result;
    }
    return applyState(frame);
  }

  installFallbackCss();
  bindFilters();
  bindGridKeys();
  resultsChrome();
  ensureNextRace();
  if (client) bindClient(client);
  else watchClient(0);
  applyState(client ? client.state : externalState());
  try {
    if (reduceMotion && typeof reduceMotion.addEventListener === 'function') {
      reduceMotion.addEventListener('change', () => schedule('countdown'));
    }
  } catch { /* older Safari */ }

  const api = {
    root: scope || null,
    get client() { return client; },
    brand,
    render(state) { return applyState(state === undefined ? externalState() : state); },
    inject: injectFrame,
    dispatch: injectFrame,
    flush() {
      if (rafId && typeof cancelAnimationFrame === 'function') cancelAnimationFrame(rafId);
      rafId = 0;
      if (fallbackTimer) { clearTimeout(fallbackTimer); fallbackTimer = 0; }
      dirty.header = true; dirty.grid = true; dirty.standings = true;
      dirty.countdown = true; dirty.results = true; dirty.feed = true;
      if (!snapshot) snapshot = currentSnap();
      flushNow();
      return snapshot;
    },
    snapshot() { return snapshot; },
    destroy() {
      destroyed = true;
      stopTicker();
      if (unsubscribe) { try { unsubscribe(); } catch { /* ignore */ } unsubscribe = null; }
      if (rafId && typeof cancelAnimationFrame === 'function') cancelAnimationFrame(rafId);
      rafId = 0;
      if (fallbackTimer) { clearTimeout(fallbackTimer); fallbackTimer = 0; }
    },
  };

  if (scope) {
    try { scope.__mmoUi = api; } catch { /* frozen node */ }
  }
  return api;
}

/* ---------- fallback CSS (page-shell's mmo.css always wins: :where() = 0) -- */

const FALLBACK_CSS = `
:where([hidden]) { display: none !important; }
:where(.mmo-num) { font-variant-numeric: tabular-nums; font-feature-settings: "tnum" 1; }
:where(.mmo-slot) { display: flex; align-items: center; gap: .45rem; min-height: 2.1rem; }
:where(.mmo-slot-body) { display: flex; flex-direction: column; min-width: 0; }
:where(.mmo-slot-name) { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
:where(.mmo-slot-meta) { overflow: hidden; font-size: .68rem; text-overflow: ellipsis; white-space: nowrap; opacity: .82; }
:where(.mmo-slot[data-state="empty"]) { border: 1px dashed rgba(255,255,255,.14); }
:where(.mmo-slot[data-state="you"]) { outline: 2px solid #e10600; outline-offset: 1px; }
:where(.mmo-slot[data-state="bot"]) { border: 1px dotted rgba(255,255,255,.34); }
:where(.mmo-slot[data-state="offline"]) { opacity: .5; }
:where(.mmo-slot[data-filtered="1"]) { opacity: .22; filter: grayscale(1); }
:where(.mmo-row.is-you) { background: rgba(225,6,0,.16); box-shadow: inset 3px 0 0 #e10600; }
:where(#mmoYourRow) { display: flex; flex-wrap: wrap; align-items: center; gap: .5rem; }
:where(#mmoYourRow [data-mmo-you-gap]) { margin-left: auto; }
:where(#mmoCountdown) { position: fixed; inset: 0; z-index: 90; display: grid; place-content: center; justify-items: center; gap: .4rem; background: rgba(4,6,12,.86); text-align: center; }
:where(#mmoCountdown .mmo-countdown-n) { color: #fff; font: italic 800 clamp(4rem, 18vw, 11rem)/.9 Bahnschrift, "Arial Narrow", "Segoe UI", system-ui, sans-serif; }
:where(#mmoCountdown)[data-go="1"] :where(.mmo-countdown-n) { color: #6ef2a2; }
:where(#mmoApp[data-stale="1"]) { opacity: .74; }
:where(.mmo-feed-line) { display: flex; gap: .5rem; }
:where(.mmo-feed-text) { min-width: 0; }
@media (prefers-reduced-motion: reduce) {
  :where(#mmoCountdown), :where(#mmoCountdown .mmo-countdown-n), :where(.mmo-slot) {
    animation: none !important;
    transition: none !important;
    transform: none !important;
  }
}
`;

function installFallbackCss() {
  if (typeof document === 'undefined') return;
  try {
    if (document.getElementById('mmo-ui-fallback')) return;
    const style = document.createElement('style');
    style.id = 'mmo-ui-fallback';
    style.textContent = FALLBACK_CSS;
    (document.head || document.documentElement).appendChild(style);
  } catch { /* a blocked <style> must not stop the board */ }
}

/* ---------- auto-mount on mmo.html / race-day -------------------------- */

function autoMount() {
  if (typeof document === 'undefined' || typeof window === 'undefined') return null;
  const root = $id('mmoApp');
  if (!root) return null; // not the Race Day page (e.g. the /play HUD) — leave it alone
  const g = window.__R4_MMO;
  const api = mountMmoUi(root, g && g.client ? g.client : null);
  try {
    if (!window.__R4_MMO_UI) {
      window.__R4_MMO_UI = {
        mount: mountMmoUi,
        brand,
        ui: api,
        render: (state) => window.__R4_MMO_UI.ui.render(state),
        inject: (frame) => window.__R4_MMO_UI.ui.inject(frame),
        flush: () => window.__R4_MMO_UI.ui.flush(),
        snapshot: () => window.__R4_MMO_UI.ui.snapshot(),
      };
    } else if (!window.__R4_MMO_UI.ui) {
      window.__R4_MMO_UI.ui = api;
    }
  } catch { /* a test hook is nice to have, never required */ }
  return api;
}

if (typeof document !== 'undefined' && typeof window !== 'undefined') {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => {
      try { autoMount(); } catch { /* never blank the page */ }
    });
  } else {
    try { autoMount(); } catch { /* never blank the page */ }
  }
}

export default mountMmoUi;

