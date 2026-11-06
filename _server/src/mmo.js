// Race Day (/mmo): one race, up to MAX_DRIVERS drivers, one shared clock, one
// leaderboard. Contract (single source of truth):
// _runtime/analysis/20-mmo-contract.md
//
// Style mirrors the /mp block in server.js on purpose: a `noServer`
// WebSocketServer upgraded by path, JSON text frames, a 20 s ping/terminate
// heartbeat, and no new dependency (`ws` only).
//
// The server owns the *event* (course, car class, start signal, seats, live
// standings). It never trusts a client position: standings are derived from
// the telemetry each browser reads out of the emulated PSX RAM.
import { WebSocketServer } from 'ws';

export const MMO_PATH = '/mmo';
// Same names and order the 2P lounge uses (server.js MP_TEAMS / MP_TRACKS).
// The course order is R4's in-game menu order and is never re-ordered here.
export const MMO_TEAMS = ['Solvalou', 'Pac Racing Club', 'Micro Mouse Mappy', 'Dig Racing Team'];
export const MMO_TRACKS = [
  'Helter Skelter', 'Wonderhill', 'Edge of the Earth', 'Out of Blue',
  'Phantomile', 'Brightest Nite', 'Heaven and Hell', 'Shooting Hoops',
];
export const MMO_CARS = ['D1', 'D2', 'D3', 'D4', 'G1', 'G2', 'G3', 'G4'];

// One race is three laps for the synthesized bots (humans report their own lap
// and finish explicitly); the value is advertised in `plan.laps`.
const RACE_LAPS = 3;
// Standings payload = top N + self + its immediate neighbours (§3.4). Eight
// shared rows + you + two neighbours = at most 11 rows, which is what keeps the
// frame inside the 1.5 KB budget without dropping a field the UI reads.
const TOP_N = 8;
// A socket this far behind is skipped for one tick and marked slow (§3.4).
// Env-overridable so a probe can drive the backlog far enough to see the flag
// without drowning a real socket for a minute.
const SLOW_BACKLOG = 65536;
// Grid rows are capped at the UI's own seat count (`MAX_SEATS` in mmo-ui.js):
// seats above it are never rendered, so they are not worth wire bytes. The
// full snapshot is chunked so a single frame stays inside the 2 KB budget.
const GRID_ROW_CAP = 50;
const GRID_FRAME_BUDGET = 2000;
// Names in grid/standings rows are cut to 12 chars (the event header, the
// results table and `welcome.you.name` keep the full 20-char name).
const ROW_NAME_MAX = 12;
// A non-seated socket may toggle bots at most once per second.
const CONFIG_MIN_GAP_MS = 1000;
// A disconnected driver keeps its seat for 30 s (§3.2/§4 reconnect rule).
const SEAT_RESERVE_MS = 30000;
// Grid deltas are coalesced to at most one broadcast per 100 ms (§3.4).
const GRID_COALESCE_MS = 100;
// A socket that stays backlogged gets `slow:true` re-asserted on a forced
// standings frame every 10 s, so #mmoQualityBadge cannot flicker off while it
// is still behind (§3.4, durability on top of the edge behaviour).
const SLOW_REASSERT_MS = 10000;
// A party code is 4-6 chars after normalisation (the client normalises to 5):
// anything longer is cut to 6, anything shorter than 4 is rejected outright.
const PARTY_CODE_MIN = 4;
const PARTY_CODE_MAX = 6;
// Node feed: at most one line per second in total (§ server task list 8).
const FEED_MIN_GAP_MS = 1000;
const CHAT_MIN_GAP_MS = 1000;
const CHAT_MAX = 120;

function envNum(name, def, min = 0, max = Number.MAX_SAFE_INTEGER) {
  const raw = process.env[name];
  if (raw == null || raw === '') return def;
  const n = Number(raw);
  if (!Number.isFinite(n)) return def;
  return Math.min(max, Math.max(min, n));
}

// Constants table of the contract. Every value has an env override so the
// protocol/load suites can shorten a whole race day to a few seconds.
const CFG = {
  max: Math.floor(envNum('RR4_MMO_MAX', 50, 1, 1000)),
  min: Math.floor(envNum('RR4_MMO_MIN', 4, 1, 1000)),
  fillMs: envNum('RR4_MMO_FILL_MS', 60000, 0),
  gridMs: envNum('RR4_MMO_GRID_MS', 5000, 0),
  countdownMs: envNum('RR4_MMO_COUNTDOWN_MS', 3000, 0),
  resultsMs: envNum('RR4_MMO_RESULTS_MS', 20000, 0),
  raceTimeoutMs: envNum('RR4_MMO_RACE_TIMEOUT_MS', 600000, 0),
  heartbeatMs: envNum('RR4_MMO_HEARTBEAT_MS', 20000, 500),
  telemetryHz: 4,
  standingsHz: 2,
  slowBacklog: envNum('RR4_MMO_SLOW_BACKLOG', SLOW_BACKLOG, 1),
  bots: process.env.RR4_MMO_BOTS === '1',
};

// ---- module state ----
let wss = null;
let current = null;
let attachedAt = 0;
let frameSeq = 0;
let mainTimer = null;
let heartbeatTimer = null;
let gridTimer = null;
/** @type {Set<any>} */
const timers = new Set();
/** driver id -> {code, members:[driverId], createdAt} (party of ≤2) */
const parties = new Map();
/** feed lines waiting for the 1/s slot */
let feedQueue = [];
let lastFeedAt = 0;
const broadcastSamples = [];
let lastStandingsAt = 0;
let lastSweepAt = 0;
let lastQueueAt = 0;

const nowMs = () => Date.now();
const warn = (msg, err) => {
  const detail = err && (err.stack || err.message) ? `: ${err.stack || err.message}` : '';
  console.warn(`[MMO] ${msg}${detail}`);
};
// Every callback below runs from a timer or a socket frame; one bad frame must
// never take the event down, so timers always go through safe().
const safe = (fn) => (...args) => {
  try { return fn(...args); } catch (e) { warn('handler failed', e); return undefined; }
};
function later(fn, ms) {
  const t = setTimeout(() => { timers.delete(t); safe(fn)(); }, Math.max(0, Number(ms) || 0));
  timers.add(t);
  return t;
}
function cancelTimer(t) {
  if (!t) return;
  try { clearTimeout(t); } catch { /* ignore */ }
  timers.delete(t);
}
function clearAllTimers() {
  for (const t of [...timers]) cancelTimer(t);
  timers.clear();
}

// ---- small value helpers ----
function clampInt(value, lo, hi, def) {
  const n = Math.round(Number(value));
  if (!Number.isFinite(n)) return def;
  return Math.min(hi, Math.max(lo, n));
}
function clampNum(value, lo, hi, def) {
  const n = Number(value);
  if (!Number.isFinite(n)) return def;
  return Math.min(hi, Math.max(lo, n));
}
function fmtTime(ms) {
  const t = Math.max(0, Number(ms) || 0);
  const m = Math.floor(t / 60000);
  const s = (t % 60000) / 1000;
  return `${m}:${s < 10 ? '0' : ''}${s.toFixed(1)}`;
}
function cleanName(raw) {
  const text = String(raw ?? '').replace(/\s+/g, ' ').trim().slice(0, 20);
  return text || 'DRIVER';
}
function validDriverId(raw) {
  return typeof raw === 'string' && /^[A-Za-z0-9_-]{6,64}$/.test(raw);
}
function newDriverId() {
  return `d-${Math.random().toString(36).slice(2, 10)}${Math.random().toString(36).slice(2, 6)}`;
}
function partyCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let out = '';
  for (let i = 0; i < 5; i++) out += chars[Math.floor(Math.random() * chars.length)];
  return out;
}
// One normaliser for `hello`, `party:join` and `party:create`: uppercase,
// alphanumerics only, cut to 6, and rejected below 4 (see PARTY_CODE_MIN).
function normalizePartyCode(raw) {
  const code = String(raw || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, PARTY_CODE_MAX);
  return code.length >= PARTY_CODE_MIN ? code : '';
}

// ---- transport helpers ----
function sendTo(ws, obj) {
  if (!ws || ws.readyState !== 1) return false;
  if (!('seq' in obj)) obj.seq = ++frameSeq;
  if (!('event' in obj)) obj.event = current ? current.id : null;
  let text;
  try { text = JSON.stringify(obj); } catch { return false; }
  try { ws.send(text); return true; } catch { return false; }
}
function sendRaw(ws, text) {
  if (!ws || ws.readyState !== 1) return false;
  try { ws.send(text); return true; } catch { return false; }
}
function broadcastRaw(text) {
  if (!wss || !text) return 0;
  let sent = 0;
  for (const ws of wss.clients) {
    if (!ws || ws.readyState !== 1) continue;
    try { ws.send(text); sent++; } catch { /* one dead socket must not stop the fan-out */ }
  }
  return sent;
}
function sendError(ws, code, message) {
  sendTo(ws, { type: 'error', code, message: String(message || code) });
}
function clientWithDriver(driverId) {
  if (!wss || !driverId) return null;
  for (const ws of wss.clients) {
    if (ws.readyState === 1 && ws.mmo && ws.mmo.driverId === driverId) return ws;
  }
  return null;
}

// ---- event model ----
function teamOfSeat(seat) {
  return MMO_TEAMS[(seat - 1) % MMO_TEAMS.length];
}
function makeSeat(seat) {
  return {
    seat,
    team: teamOfSeat(seat),
    driverId: null,
    name: '',
    bot: false,
    ws: null,
    connected: false,
    state: 'empty',
    car: '',
    carIndex: -1,
    lap: 0,
    raceTimeMs: 0,
    speedKph: 0,
    bestLapMs: null,
    lapStartMs: 0,
    finished: false,
    finishedAt: 0,
    disconnectedAt: 0,
    lastTelemetryAt: 0,
    botLapMs: 0,
  };
}
function newEvent(prev = null) {
  const index = prev ? prev.index + 1 : 1;
  const seats = new Array(CFG.max + 1);
  for (let i = 1; i <= CFG.max; i++) seats[i] = makeSeat(i);
  return {
    id: `evt-${index}-${Math.random().toString(36).slice(2, 6)}`,
    index,
    state: 'lobby',
    plan: null,
    seats,
    queue: [],
    pending: [],
    // Grid delta bookkeeping (§3.4): the last row signature the fan-out sent
    // per seat, the driverId it already handed out per seat, and whether the
    // next coalesced tick must be a full snapshot instead of a delta.
    gridSig: new Map(),
    gridIdSig: new Map(),
    gridFullPending: true,
    fillStartedAt: 0,
    fillTimer: null,
    fillExpired: false,
    startsAt: 0,
    startedAt: 0,
    finishedAt: 0,
    leaderSeat: 0,
    emptySince: 0,
    bots: Boolean(prev ? prev.bots : CFG.bots),
    // Last spectator count announced on `event.counts.spectators`.
    spectators: 0,
    raceTimer: null,
    lastBotTick: 0,
  };
}
function participants(ev) {
  const out = [];
  for (let i = 1; i <= CFG.max; i++) {
    const s = ev.seats[i];
    if (s.driverId) out.push(s);
  }
  return out;
}
function counts(ev) {
  let seated = 0;
  let connected = 0;
  let bots = 0;
  for (let i = 1; i <= CFG.max; i++) {
    const s = ev.seats[i];
    if (!s.driverId) continue;
    seated++;
    if (s.connected) connected++;
    if (s.bot) bots++;
  }
  return {
    seated,
    queued: queueList(ev).length,
    max: CFG.max,
    // `min` rides on every counts object (`event`, `grid`, `welcome`, status) so
    // a socket that missed `welcome` can still gate START (§4.2).
    min: CFG.min,
    connected,
    bots,
    // Real spectators (a `spectate` socket with no seat). Only `event`/`welcome`
    // advertise it: the spectate board shows "N WATCHING" only when present.
    spectators: spectatorCount(),
  };
}
function seatOf(ws) {
  if (!ws || !ws.mmo || !ws.mmo.seat || !current) return null;
  const seat = current.seats[ws.mmo.seat];
  if (!seat || seat.driverId !== ws.mmo.driverId) return null;
  return seat;
}
// Spectators are live sockets that asked for `spectate` and hold no seat.
function spectatorCount() {
  if (!wss) return 0;
  let n = 0;
  for (const ws of wss.clients) {
    if (!ws || ws.readyState !== 1 || !ws.mmo || !ws.mmo.spectating) continue;
    if (seatOf(ws)) continue;
    n++;
  }
  return n;
}
// `event.counts.spectators` is emitted when the number actually changes (the
// spectate board prints it only while it is present). broadcastEvent() memoises
// the value it just sent, so a reconcile here is one comparison per tick.
function syncSpectators(ev) {
  if (!ev || current !== ev) return;
  if (spectatorCount() === ev.spectators) return;
  broadcastEvent();
}
function findSeat(ev, driverId) {
  if (!driverId) return null;
  for (let i = 1; i <= CFG.max; i++) {
    const s = ev.seats[i];
    if (s.driverId === driverId) return s;
  }
  return null;
}
function freeSeat(ev, team) {
  for (let i = 1; i <= CFG.max; i++) {
    const s = ev.seats[i];
    if (s.driverId) continue;
    if (team && s.team !== team) continue;
    return s;
  }
  return null;
}
function teamCounts(ev) {
  const out = new Map(MMO_TEAMS.map((t) => [t, 0]));
  for (const s of participants(ev)) out.set(s.team, (out.get(s.team) || 0) + 1);
  return out;
}
// Deterministic seat/team pick that prefers the emptiest team. Seat numbering
// cycles the four teams (seat 1 -> team 0, seat 2 -> team 1, ...), so always
// taking the lowest free seat of the emptiest team fills the grid round-robin
// and keeps the teams within one driver of each other.
function assignSeat(ev, ws, preferred) {
  const st = ws.mmo;
  const want = Number(preferred);
  if (Number.isFinite(want)) {
    const seat = Math.round(want);
    if (seat >= 1 && seat <= CFG.max && !ev.seats[seat].driverId) return ev.seats[seat];
  }
  const party = st.partyCode ? parties.get(st.partyCode) : null;
  if (party) {
    for (const id of party.members) {
      if (id === st.driverId) continue;
      const mate = findSeat(ev, id);
      if (!mate) continue;
      const sameTeam = freeSeat(ev, mate.team);
      if (sameTeam) return sameTeam;
    }
  }
  const teamLoad = teamCounts(ev);
  let pick = MMO_TEAMS[0];
  let pickLoad = Infinity;
  for (const team of MMO_TEAMS) {
    const load = teamLoad.get(team) || 0;
    if (load < pickLoad) { pick = team; pickLoad = load; }
  }
  const free = freeSeat(ev, pick) || freeSeat(ev, null);
  if (free) return free;
  // A human queue always wins over a bot seat (§ config frame): during the
  // lobby the lowest bot seat is handed back to the pool and reused.
  if (ev.state === 'lobby' && ev.bots) {
    const bot = firstBotSeat(ev);
    if (bot) {
      const no = bot.seat;
      releaseSeat(ev, bot);
      return ev.seats[no];
    }
  }
  return null;
}
function releaseSeat(ev, seat) {
  if (!seat) return;
  if (seat.ws && seat.ws.mmo && seat.ws.mmo.seat === seat.seat) seat.ws.mmo.seat = 0;
  const fresh = makeSeat(seat.seat);
  ev.seats[seat.seat] = fresh;
}
function seatDriver(ev, ws, seat) {
  const st = ws.mmo;
  seat.driverId = st.driverId;
  seat.name = st.name || 'DRIVER';
  seat.ws = ws;
  seat.connected = true;
  seat.disconnectedAt = 0;
  seat.bot = false;
  seat.state = ev.state === 'lobby' ? 'queued' : (ev.state === 'racing' ? 'racing' : 'seated');
  seat.lap = 0;
  seat.raceTimeMs = 0;
  seat.speedKph = 0;
  seat.bestLapMs = null;
  seat.lapStartMs = 0;
  seat.finished = false;
  seat.finishedAt = 0;
  st.seat = seat.seat;
}

// ---- LFG queue ----
function queueList(ev) {
  return ev && ev.state === 'lobby' ? ev.queue : (ev ? ev.pending : []);
}
function partyInfo(ws) {
  const code = ws && ws.mmo ? ws.mmo.partyCode : '';
  if (!code) return null;
  const party = parties.get(code);
  if (!party) return null;
  return { code: party.code, size: party.members.length };
}
function etaMs(ev) {
  if (!ev || ev.state !== 'lobby') return 0;
  if (!ev.fillStartedAt) return CFG.fillMs;
  if (ev.fillExpired) return 0;
  return Math.max(0, Math.round(CFG.fillMs - (nowMs() - ev.fillStartedAt)));
}
function startable(ev) {
  const size = queueList(ev).length;
  return ev.state === 'lobby' && (size >= CFG.min || (ev.bots && size >= 1));
}
function sendQueueInfo(ws) {
  const ev = current;
  if (!ev || !ws || !ws.mmo) return;
  const st = ws.mmo;
  const list = queueList(ev);
  const idx = list.indexOf(st.driverId);
  const seat = seatOf(ws);
  sendTo(ws, {
    type: 'queue',
    position: idx >= 0 ? idx + 1 : 0,
    size: list.length,
    etaMs: seat ? 0 : etaMs(ev),
    fillMs: CFG.fillMs,
    min: CFG.min,
    max: CFG.max,
    seated: Boolean(seat),
    // Additive: the seat/team you already hold, so the client never has to
    // infer them from grid rows (0/null when the socket holds no seat).
    seat: seat ? seat.seat : 0,
    team: seat ? seat.team : null,
    startable: startable(ev),
    party: partyInfo(ws),
  });
}
function broadcastQueue() {
  const ev = current;
  if (!ev) return;
  const list = queueList(ev);
  for (const driverId of list) {
    const ws = clientWithDriver(driverId);
    if (ws) sendQueueInfo(ws);
  }
}
function armFill(ev) {
  if (!ev || ev.fillTimer || ev.state !== 'lobby') return;
  if (!ev.fillStartedAt) ev.fillStartedAt = nowMs();
  ev.fillExpired = false;
  if (!(CFG.fillMs > 0)) {
    ev.fillExpired = true;
    maybeAutoStart(ev);
    return;
  }
  ev.fillTimer = later(() => {
    ev.fillTimer = null;
    if (current !== ev || ev.state !== 'lobby') return;
    ev.fillExpired = true;
    if (startable(ev) || participants(ev).length >= CFG.max) {
      toGrid(ev);
      return;
    }
    // Still short of MIN: roll the fill window over so the ETA never goes
    // negative and the next expiry can start the race.
    ev.fillStartedAt = nowMs();
    broadcastQueue();
    armFill(ev);
  }, CFG.fillMs);
}
function maybeAutoStart(ev) {
  if (!ev || ev.state !== 'lobby') return;
  const size = queueList(ev).length;
  if (ev.bots && size >= 1) { toGrid(ev); return; }
  if (participants(ev).length >= CFG.max) { toGrid(ev); return; }
  if (ev.fillExpired && size >= CFG.min) toGrid(ev);
}

// ---- plan roll (lounge rules: one of the 8 R4 courses in menu order) ----
function rollPlan(ev) {
  const trackIndex = Math.floor(Math.random() * MMO_TRACKS.length);
  const carClass = Math.random() < 0.5 ? 'D' : 'G';
  ev.plan = {
    trackIndex,
    trackName: MMO_TRACKS[trackIndex],
    carClass,
    laps: RACE_LAPS,
    rolledAt: nowMs(),
  };
  // Preset car per driver, exactly the D1-D4 / G1-G4 set the lounge uses. The
  // four cars of the rolled class are spread across the grid.
  const base = carClass === 'G' ? 4 : 0;
  for (let i = 1; i <= CFG.max; i++) {
    const s = ev.seats[i];
    if (!s.driverId) continue;
    const carIndex = base + ((i - 1) % 4);
    s.carIndex = carIndex;
    s.car = MMO_CARS[carIndex];
  }
}

// ---- state machine ----
function toGrid(ev) {
  if (!ev || ev.state !== 'lobby') return;
  ev.state = 'grid';
  cancelTimer(ev.fillTimer);
  ev.fillTimer = null;
  ev.fillExpired = false;
  // Seats change state in bulk, so this tick is a full snapshot, not a delta.
  ev.gridFullPending = true;
  if (ev.bots) fillBots(ev);
  rollPlan(ev);
  for (const s of participants(ev)) if (s.state === 'queued') s.state = 'seated';
  broadcastEvent();
  broadcastGrid();
  queueFeed(`GRID LOCKED — ${MMO_TRACKS[ev.plan.trackIndex]} · ${ev.plan.carClass} class · ${participants(ev).length} drivers`);
  later(() => toCountdown(ev), CFG.gridMs);
}
function toCountdown(ev) {
  if (current !== ev || ev.state !== 'grid') return;
  ev.state = 'countdown';
  // One shared start instant, broadcast with every step, so a client that
  // misses n=3 still knows when GO is.
  ev.startsAt = nowMs() + CFG.countdownMs;
  ev.plan = { ...(ev.plan || {}), startsAt: ev.startsAt };
  ev.gridFullPending = true;
  broadcastEvent();
  const step = CFG.countdownMs / 3;
  for (let n = 3; n >= 1; n--) {
    const delay = (3 - n) * step;
    later(() => {
      if (current !== ev || ev.state !== 'countdown') return;
      broadcastRaw(JSON.stringify({
        type: 'countdown', event: ev.id, seq: ++frameSeq, n, startsAt: ev.startsAt,
      }));
    }, delay);
  }
  later(() => toRacing(ev), CFG.countdownMs + 10);
}
function toRacing(ev) {
  if (current !== ev || ev.state !== 'countdown') return;
  ev.state = 'racing';
  ev.startedAt = nowMs();
  ev.plan = { ...(ev.plan || {}), startedAt: ev.startedAt };
  for (const s of participants(ev)) {
    s.state = 'racing';
    s.lap = Math.max(1, s.lap || 1);
    s.lapStartMs = 0;
    s.raceTimeMs = s.raceTimeMs || 0;
  }
  ev.lastBotTick = nowMs();
  ev.leaderSeat = 0;
  lastStandingsAt = 0;
  ev.gridFullPending = true;
  broadcastEvent();
  broadcastGrid();
  queueFeed(`GO — ${participants(ev).length} drivers, ${RACE_LAPS} laps`);
  // Hard ceiling so a stuck race still reaches results (§2).
  ev.raceTimer = later(() => {
    if (current === ev && ev.state === 'racing') toResults(ev, 'timeout');
  }, CFG.raceTimeoutMs);
}
function allFinished(ev) {
  const list = participants(ev);
  return list.length > 0 && list.every((s) => s.finished);
}
function toResults(ev, reason) {
  if (current !== ev || (ev.state !== 'racing' && ev.state !== 'countdown')) return;
  ev.state = 'results';
  cancelTimer(ev.raceTimer);
  ev.raceTimer = null;
  ev.finishedAt = nowMs();
  for (const s of participants(ev)) {
    if (!s.finished) {
      // Unfinished rows keep their last telemetry but are clearly not finishers.
      if (s.state !== 'finished') s.state = 'dnf';
    }
  }
  ev.gridFullPending = true;
  broadcastEvent();
  broadcastResult(ev);
  broadcastGrid();
  queueFeed(reason === 'timeout' ? 'RACE COMPLETE — time limit reached' : 'RACE COMPLETE');
  later(() => {
    if (current === ev) nextEvent(ev);
  }, CFG.resultsMs);
}
// A race day is in-memory, so an abandoned event (every driver gone) must not
// hold the room for the 10-minute race timeout. Give reconnects their 5 s grace
// first, then roll a fresh lobby with a new event id.
function abandon(ev) {
  if (current !== ev) return;
  cancelTimer(ev.raceTimer);
  ev.raceTimer = null;
  cancelTimer(ev.fillTimer);
  ev.fillTimer = null;
  nextEvent(ev);
  queueFeed('EVENT ABANDONED — everyone left');
}
function nextEvent(prev) {
  const pending = prev ? prev.pending.slice() : [];
  // Party membership survives the event; seats and queue slots do not.
  if (wss) {
    for (const ws of wss.clients) {
      if (ws.readyState !== 1 || !ws.mmo) continue;
      ws.mmo.seat = 0;
      ws.mmo.lastTelemetryAt = 0;
    }
  }
  current = newEvent(prev);
  const ev = current;
  lastStandingsAt = 0;
  lastSweepAt = 0;
  lastQueueAt = 0;
  ev.pending = pending;
  broadcastEvent();
  broadcastGrid();
  // Re-seat whoever queued while the previous race was finishing. Every opaque
  // re-seat is announced twice: a fresh `welcome` per affected socket (seat,
  // team, event and counts — the only frame that carries `you.team`), and one
  // coalesced full `grid` for the room after the loop, so a 50-driver re-seat
  // is 50 small welcomes + one (chunked) grid frame, never 50 grids.
  if (ev.pending.length) later(() => {
    if (current !== ev) return;
    const ids = ev.pending.slice();
    ev.pending = [];
    const reseated = [];
    for (const driverId of ids) {
      const ws = clientWithDriver(driverId);
      if (!ws) continue;
      const seat = queueDriver(ev, ws, null);
      if (seat) reseated.push(ws);
    }
    for (const ws of reseated) sendWelcome(ws);
    // A re-seated driver does not send another `queue`, so this is the only
    // place that can start the new lobby's fill clock (onQueue does the same).
    if (reseated.length) armFill(ev);
    // The seat list changed in bulk: the next coalesced tick is a full snapshot.
    ev.gridFullPending = true;
    broadcastGrid();
    broadcastQueue();
    syncSpectators(ev);
    maybeAutoStart(ev);
  }, 0);
}

// ---- seats -> wire rows ----
// One shared text payload per frame, never a JSON.stringify per recipient
// (§3.4). A row carries only what the UI reads: `seat`, `team` (index into
// MMO_TEAMS - `brand()` in mmo-ui.js accepts an index), the 12-char `name` and
// - only when the seat is an exception - `state`. `bot`, `connected:false` and
// `driverId` are emitted only when they carry information, which keeps a full
// 50-row frame inside the 2 KB budget.
const TEAM_INDEX = new Map(MMO_TEAMS.map((team, i) => [team, i]));
function shortName(name, max = ROW_NAME_MAX) {
  const text = String(name == null ? '' : name);
  return text.length > max ? text.slice(0, max) : text;
}
// The state every occupied seat has while the event sits in `ev.state`; a row
// only spells `state` out when the seat differs from that default (finished,
// dnf, a bot still queued during `grid`, ...).
function gridDefaultState(ev) {
  if (!ev) return 'seated';
  if (ev.state === 'lobby') return 'queued';
  if (ev.state === 'racing') return 'racing';
  return 'seated';
}
function gridRow(ev, s, defState, withId) {
  const row = {
    seat: s.seat,
    team: TEAM_INDEX.get(s.team) ?? 0,
    name: shortName(s.name),
  };
  if (s.state !== defState) row.state = s.state;
  if (s.bot) row.bot = true;
  if (!s.connected) row.connected = false;
  if (withId && s.driverId) row.driverId = s.driverId;
  return row;
}
// Change detector for the delta path: one small string, no JSON, no per-seat
// object unless the seat actually changed.
function gridSeatSig(s) {
  if (!s.driverId) return '';
  return `${s.driverId}|${s.name || ''}|${s.state || ''}|${s.bot ? 1 : 0}|${s.connected ? 1 : 0}`;
}
// `grid` counts are the four the client and the load probe read; the full
// counts (connected/bots/spectators) ride on the `event` frame. `min` is
// repeated here so a client that lost `welcome` can still gate START.
function gridCountsText(ev) {
  const c = counts(ev);
  return `{"seated":${c.seated},"queued":${c.queued},"max":${c.max},"min":${c.min}}`;
}
// Greedy chunker: every returned frame is <= GRID_FRAME_BUDGET bytes, so a full
// snapshot of a very large grid still honours the per-frame budget.
function chunkGridRows(eventId, defState, countsText, rowsText) {
  const reserve = 32; // `,"part":99,"parts":99` plus seq digits
  const head = `{"type":"grid","event":${eventId},"seq":123456,"full":true,` +
    `"st":${JSON.stringify(defState)},"seats":[`;
  const tail = `],"counts":${countsText}}`;
  const fixed = Buffer.byteLength(head) + reserve + Buffer.byteLength(tail);
  const chunks = [];
  let cur = [];
  let len = fixed;
  for (const text of rowsText) {
    const add = Buffer.byteLength(text) + (cur.length ? 1 : 0);
    if (cur.length && len + add > GRID_FRAME_BUDGET) {
      chunks.push(cur);
      cur = [text];
      len = fixed + Buffer.byteLength(text);
    } else {
      cur.push(text);
      len += add;
    }
  }
  if (cur.length || !chunks.length) chunks.push(cur);
  const parts = chunks.length;
  return chunks.map((rows, i) => {
    const partField = parts > 1 ? `,"part":${i},"parts":${parts}` : '';
    return `{"type":"grid","event":${eventId},"seq":${++frameSeq},"full":true${partField},` +
      `"st":${JSON.stringify(defState)},"seats":[${rows.join(',')}],"counts":${countsText}}`;
  });
}
// Greedy chunker for a delta: same per-frame budget, no `part` numbering
// needed because a delta is merged seat-by-seat. The `removed` list rides on
// the last chunk.
function chunkDeltaRows(eventId, defState, countsText, changedRows, removed) {
  const reserve = 32;
  const removedText = removed.length ? `,"removed":[${removed.join(',')}]` : '';
  const head = `{"type":"grid","event":${eventId},"seq":123456,"full":false,` +
    `"st":${JSON.stringify(defState)},"seats":[`;
  const tail = `]${removedText},"counts":${countsText}}`;
  const fixed = Buffer.byteLength(head) + reserve + Buffer.byteLength(tail);
  const chunks = [];
  let cur = [];
  let len = fixed;
  for (const text of changedRows) {
    const add = Buffer.byteLength(text) + (cur.length ? 1 : 0);
    if (cur.length && len + add > GRID_FRAME_BUDGET) {
      chunks.push(cur);
      cur = [text];
      len = fixed + Buffer.byteLength(text);
    } else {
      cur.push(text);
      len += add;
    }
  }
  if (cur.length || !chunks.length) chunks.push(cur);
  return chunks.map((rows, i) => {
    const extra = i === chunks.length - 1 ? removedText : '';
    return `{"type":"grid","event":${eventId},"seq":${++frameSeq},"full":false,` +
      `"st":${JSON.stringify(defState)},"seats":[${rows.join(',')}]${extra},"counts":${countsText}}`;
  });
}
// One coalesced tick (§3.4): the first grid after a welcome or a state change
// is a full snapshot (chunked), every later tick is a delta with only the
// rows that changed plus the seats that went back to EMPTY.
function flushGrid() {
  const ev = current;
  if (!ev || !wss) return;
  const defState = gridDefaultState(ev);
  const cap = Math.min(CFG.max, GRID_ROW_CAP);
  const countsText = gridCountsText(ev);
  const eventId = JSON.stringify(ev.id);
  const sigs = ev.gridSig;
  const idSigs = ev.gridIdSig;
  const full = ev.gridFullPending;
  ev.gridFullPending = false;
  let needFresh = false;
  for (const ws of wss.clients) {
    if (ws.readyState === 1 && ws.mmo && ws.mmo.needGridFull) { needFresh = true; break; }
  }
  const snapshotRows = [];
  const freshRows = needFresh ? [] : null;
  const changedRows = [];
  const removed = [];
  for (let i = 1; i <= cap; i++) {
    const s = ev.seats[i];
    const sig = gridSeatSig(s);
    const prev = sigs.get(i);
    if (!sig) {
      if (prev !== undefined) { removed.push(i); sigs.delete(i); idSigs.delete(i); }
      continue;
    }
    const newId = idSigs.get(i) !== s.driverId;
    // The shared snapshot only spells `driverId` out for a seat whose occupant
    // the fan-out has not handed out yet; a delta row always carries it.
    snapshotRows.push(JSON.stringify(gridRow(ev, s, defState, newId)));
    if (freshRows) freshRows.push(JSON.stringify(gridRow(ev, s, defState, true)));
    if (sig !== prev) changedRows.push(JSON.stringify(gridRow(ev, s, defState, true)));
    sigs.set(i, sig);
    idSigs.set(i, s.driverId);
  }
  const sharedChunks = full ? chunkGridRows(eventId, defState, countsText, snapshotRows) : null;
  // A socket that just said `hello` has never seen a full grid: hand it one
  // with every driverId, even mid-race, so it can identify every seat.
  const freshChunks = needFresh
    ? chunkGridRows(eventId, defState, countsText, freshRows && freshRows.length ? freshRows : snapshotRows)
    : null;
  let deltaFrames = null;
  if (!full && (changedRows.length || removed.length)) {
    deltaFrames = chunkDeltaRows(eventId, defState, countsText, changedRows, removed);
  }
  if (!sharedChunks && !freshChunks && !deltaFrames) return;
  for (const ws of wss.clients) {
    if (!ws || ws.readyState !== 1 || !ws.mmo) continue;
    if (ws.mmo.needGridFull && freshChunks) {
      ws.mmo.needGridFull = false;
      for (const text of freshChunks) sendRaw(ws, text);
      continue;
    }
    if (ws.mmo.needGridFull) ws.mmo.needGridFull = false;
    if (sharedChunks) {
      for (const text of sharedChunks) sendRaw(ws, text);
      continue;
    }
    if (deltaFrames) for (const text of deltaFrames) sendRaw(ws, text);
  }
}
// Coalesced: a 50-driver queue burst must not fan out 50 grids.
function broadcastGrid() {
  if (gridTimer) return;
  gridTimer = later(() => {
    gridTimer = null;
    flushGrid();
  }, GRID_COALESCE_MS);
}
function broadcastEvent() {
  const ev = current;
  if (!ev) return;
  const c = counts(ev);
  ev.spectators = c.spectators;
  broadcastRaw(JSON.stringify({
    type: 'event',
    event: ev.id,
    seq: ++frameSeq,
    id: ev.id,
    index: ev.index,
    state: ev.state,
    plan: ev.plan,
    counts: c,
  }));
}

// ---- standings ----
// Sort is lap desc, raceTimeMs asc; gapMs is the time to the car directly
// ahead on the SAME lap, otherwise null with gapLap:true (§3.3). A row keeps
// exactly the fields the board reads; `bot:false`, `gapLap:false` and a null
// `bestLapMs` are left out, and names are cut to 12 chars for the board.
function standingsLines(ev, opts = {}) {
  const nameMax = Number(opts.nameMax) || 0;
  const stateDefault = opts.stateDefault || '';
  const rows = participants(ev).slice().sort((a, b) => (
    (b.lap - a.lap) || (a.raceTimeMs - b.raceTimeMs) || (a.seat - b.seat)
  ));
  return rows.map((s, i) => {
    let gapMs = 0;
    let gapLap = false;
    if (i > 0) {
      const ahead = rows[i - 1];
      if (ahead.lap === s.lap) gapMs = Math.max(0, Math.round(s.raceTimeMs - ahead.raceTimeMs));
      else { gapMs = null; gapLap = true; }
    }
    const position = i + 1;
    const row = {
      seat: s.seat,
      name: nameMax ? shortName(s.name, nameMax) : (s.name || ''),
      team: s.team,
      lap: s.lap,
      raceTimeMs: Math.round(s.raceTimeMs),
      gapMs,
      position,
    };
    // `state` is only spelled out for a seat that differs from the phase
    // default (finished/dnf mid-board); the phase itself comes from `event`.
    if (stateDefault ? s.state !== stateDefault : true) row.state = s.state;
    if (gapLap) row.gapLap = true;
    if (s.bot) row.bot = true;
    if (s.bestLapMs) row.bestLapMs = s.bestLapMs;
    return { seat: s.seat, s, position, gapMs, gapLap, json: JSON.stringify(row) };
  });
}
function tickStandings(ev) {
  if (!ev || ev.state !== 'racing' || !wss) return;
  const started = process.hrtime.bigint();
  const now = nowMs();
  const lines = standingsLines(ev, { nameMax: ROW_NAME_MAX, stateDefault: gridDefaultState(ev) });
  const bySeat = new Map();
  lines.forEach((line, i) => bySeat.set(line.seat, i));
  const top = Math.min(TOP_N, lines.length);
  const topJson = lines.slice(0, top).map((l) => l.json);
  const topText = topJson.join(',');
  const eventId = JSON.stringify(ev.id);

  const leader = lines[0];
  if (leader && ev.leaderSeat && ev.leaderSeat !== leader.seat) {
    queueFeed(`P1 — ${leader.s.name} took the lead`);
  }
  if (leader) ev.leaderSeat = leader.seat;

  for (const ws of wss.clients) {
    if (ws.readyState !== 1 || !ws.mmo) continue;
    const st = ws.mmo;
    // Slow consumer: skip this tick and tell the socket on the next frame that
    // is delivered, so #mmoQualityBadge can show SLOW (§3.4). While the socket
    // stays congested the flag is re-asserted on a forced frame every 10 s so
    // the badge cannot flicker off between edges.
    if (Number(ws.bufferedAmount) > CFG.slowBacklog) {
      if (!st.slow) {
        st.slow = true;
        st.slowPending = true;
        st.slowReassertAt = now + SLOW_REASSERT_MS;
      }
      if (now < (st.slowReassertAt || 0)) continue;
      st.slowReassertAt = now + SLOW_REASSERT_MS;
      st.slowPending = true;
    } else if (st.slow) {
      st.slow = false;
      st.slowRecovered = true;
      st.slowReassertAt = 0;
    }
    const seatNo = st.seat;
    const idx = seatNo ? bySeat.get(seatNo) : undefined;
    let rowsText = topText;
    let you = null;
    // `lap` is the leader's lap unless this socket has a seat, in which case it
    // reports your lap (the HUD needs your lap, not the leader's).
    let lap = lines.length ? lines[0].s.lap : 0;
    if (idx !== undefined) {
      const mine = lines[idx];
      // `you` carries position/gap only (contract §3.2); the frame's `lap`
      // below is already your own lap for a seated socket.
      you = { position: mine.position, gapMs: mine.gapMs };
      if (mine.gapLap) you.gapLap = true;
      lap = mine.s.lap;
      const wanted = [];
      for (const j of [idx, idx - 1, idx + 1]) {
        if (j < 0 || j >= lines.length) continue;
        if (j < top) continue; // already in the shared top N
        if (wanted.includes(j)) continue;
        wanted.push(j);
      }
      if (wanted.length) {
        const extra = wanted.map((j) => lines[j].json).join(',');
        rowsText = topText ? `${topText},${extra}` : extra;
      }
    }
    let slowField = '';
    if (st.slowPending) { slowField = ',"slow":true'; st.slowPending = false; }
    else if (st.slowRecovered) { slowField = ',"slow":false'; st.slowRecovered = false; }
    const text = `{"type":"standings","event":${eventId},"seq":${++frameSeq},` +
      `"rows":[${rowsText}],"you":${you ? JSON.stringify(you) : 'null'},` +
      `"lap":${Math.round(lap) || 0},"top":${TOP_N}${slowField}}`;
    sendRaw(ws, text);
  }
  const tookMs = Number(process.hrtime.bigint() - started) / 1e6;
  broadcastSamples.push(tookMs);
  if (broadcastSamples.length > 200) broadcastSamples.shift();
}
function broadcastResult(ev) {
  if (!ev || !wss) return;
  const lines = standingsLines(ev);
  const rowsStr = `[${lines.map((l) => {
    const row = JSON.parse(l.json);
    row.finished = Boolean(l.s.finished) && l.s.state === 'finished';
    row.speedKph = Math.round(l.s.speedKph || 0);
    return JSON.stringify(row);
  }).join(',')}]`;
  for (const ws of wss.clients) {
    if (ws.readyState !== 1 || !ws.mmo) continue;
    const idx = ws.mmo.seat ? lines.findIndex((l) => l.seat === ws.mmo.seat) : -1;
    const mine = idx >= 0 ? lines[idx] : null;
    const you = mine ? { position: mine.position, raceTimeMs: Math.round(mine.s.raceTimeMs) } : null;
    const text = `{"type":"result","event":${JSON.stringify(ev.id)},"seq":${++frameSeq},` +
      `"rows":${rowsStr},"you":${you ? JSON.stringify(you) : 'null'},` +
      `"finishedAt":${Math.round(ev.finishedAt || nowMs())}}`;
    sendRaw(ws, text);
  }
}

// ---- telemetry ----
// Clamps + monotonic rule of §3.3. Returns the seat or null (after sending the
// matching error), so the caller can bail out.
function noteProgress(seat, lap, raceTimeMs) {
  if (lap > (seat.lap || 0)) {
    const lapMs = raceTimeMs - (seat.lapStartMs || 0);
    if (lapMs >= 2000 && lapMs <= 600000) {
      const prev = seat.bestLapMs;
      if (!prev || lapMs < prev) {
        seat.bestLapMs = Math.round(lapMs);
        if (prev) queueFeed(`${seat.name} set ${fmtTime(lapMs)}`);
      }
    }
    seat.lap = lap;
    seat.lapStartMs = raceTimeMs;
  } else if (lap > 0) {
    seat.lap = Math.max(seat.lap || 0, lap);
  }
  seat.raceTimeMs = Math.max(seat.raceTimeMs || 0, raceTimeMs);
}
function finishSeat(ev, seat, raceTimeMs, lap) {
  if (!seat || seat.finished) return;
  seat.finished = true;
  seat.finishedAt = nowMs();
  seat.state = 'finished';
  seat.raceTimeMs = Math.max(seat.raceTimeMs || 0, raceTimeMs || 0);
  if (lap > (seat.lap || 0)) noteProgress(seat, lap, seat.raceTimeMs);
  seat.lap = Math.max(seat.lap || 1, Math.min(lap || seat.lap || 1, 99));
  queueFeed(`${seat.name} finished ${fmtTime(seat.raceTimeMs)}`);
  broadcastGrid();
  if (allFinished(ev)) toResults(ev, 'all-finished');
}

// ---- bots ----
// Bots are labelled bot:true on every row. Their pace is jittered and slower
// than a strong human (63-75 s laps, never faster than the 3-lap best human).
function fillBots(ev) {
  for (let i = 1; i <= CFG.max; i++) {
    const s = ev.seats[i];
    if (s.driverId) continue;
    s.driverId = `bot-${ev.index}-${i}`;
    s.name = `BOT ${String(i).padStart(2, '0')}`;
    s.bot = true;
    s.ws = null;
    s.connected = true;
    s.state = ev.state === 'lobby' ? 'queued' : 'seated';
    s.lap = 0;
    s.raceTimeMs = 0;
    s.speedKph = 0;
    s.bestLapMs = null;
    s.lapStartMs = 0;
    s.finished = false;
    // 63 s + a per-seat offset: deterministic spread, always slower than a
    // strong human lap.
    s.botLapMs = 63000 + ((i * 1100) % 12000);
  }
}
function firstBotSeat(ev) {
  if (!ev) return null;
  for (let i = 1; i <= CFG.max; i++) {
    const s = ev.seats[i];
    if (s.bot && s.driverId) return s;
  }
  return null;
}
// Turn the bots off (§ config frame). During the lobby the seats go back to the
// pool immediately; mid-race the bots finish the race they started.
function clearBots(ev) {
  if (!ev) return false;
  let changed = false;
  for (let i = 1; i <= CFG.max; i++) {
    const s = ev.seats[i];
    if (!s.bot || !s.driverId) continue;
    if (ev.state !== 'lobby') continue;
    ev.queue = ev.queue.filter((id) => id !== s.driverId);
    ev.pending = ev.pending.filter((id) => id !== s.driverId);
    releaseSeat(ev, s);
    changed = true;
  }
  return changed;
}
function tickBots(ev, dtRaw) {
  if (!ev || ev.state !== 'racing') return;
  const dt = Math.min(1000, Math.max(0, dtRaw));
  if (!dt) return;
  for (let i = 1; i <= CFG.max; i++) {
    if (ev.state !== 'racing') return; // a finish can end the race mid-loop
    const s = ev.seats[i];
    if (!s.bot || !s.driverId || s.finished) continue;
    s.raceTimeMs += dt * (0.94 + Math.random() * 0.12);
    s.speedKph = Math.round(185 + Math.random() * 55);
    const lap = 1 + Math.floor(s.raceTimeMs / s.botLapMs);
    if (lap > RACE_LAPS) {
      const total = Math.round(RACE_LAPS * s.botLapMs);
      finishSeat(ev, s, total, RACE_LAPS);
      continue;
    }
    if (lap > (s.lap || 0)) {
      const lapMs = s.raceTimeMs - (s.lapStartMs || 0);
      if (lapMs >= 2000) {
        if (!s.bestLapMs || lapMs < s.bestLapMs) s.bestLapMs = Math.round(lapMs);
      }
      s.lap = lap;
      s.lapStartMs = s.raceTimeMs;
    }
    s.state = 'racing';
  }
}

// ---- feed (at most one line per second, never interleaved) ----
function queueFeed(text, at) {
  if (!text) return;
  feedQueue.push({ at: at || nowMs(), text: String(text).slice(0, 140) });
  if (feedQueue.length > 40) feedQueue.shift();
}
function flushFeed(now) {
  if (!feedQueue.length) return;
  if (now - lastFeedAt < FEED_MIN_GAP_MS) return;
  const line = feedQueue.shift();
  lastFeedAt = now;
  broadcastRaw(JSON.stringify({
    type: 'feed', event: current ? current.id : null, seq: ++frameSeq, at: line.at, text: line.text,
  }));
}

// ---- parties (≤2, kept across events) ----
function partyFrame(party) {
  return {
    code: party.code,
    size: party.members.length,
    members: party.members.map((driverId) => {
      const ws = clientWithDriver(driverId);
      const seat = ws ? seatOf(ws) : null;
      return { driverId, name: ws && ws.mmo ? ws.mmo.name : '', seat: seat ? seat.seat : 0 };
    }),
  };
}
function broadcastParty(party) {
  if (!party) return;
  const frame = { type: 'party', ...partyFrame(party) };
  for (const driverId of party.members) {
    const ws = clientWithDriver(driverId);
    if (ws) sendTo(ws, { ...frame });
  }
}
function joinParty(ws, rawCode, opts = {}) {
  const code = normalizePartyCode(rawCode);
  if (!code) {
    if (!opts.silent) sendError(ws, 'party', `party code must be ${PARTY_CODE_MIN}-${PARTY_CODE_MAX} characters`);
    return null;
  }
  const st = ws.mmo;
  let party = parties.get(code);
  if (!party) {
    if (!opts.create) {
      if (!opts.silent) sendError(ws, 'party', 'party not found');
      return null;
    }
    party = { code, members: [], createdAt: nowMs() };
    parties.set(code, party);
  }
  if (!party.members.includes(st.driverId)) {
    if (party.members.length >= 2) {
      if (!opts.silent) sendError(ws, 'party', 'party is full');
      return null;
    }
    party.members.push(st.driverId);
  }
  st.partyCode = code;
  broadcastParty(party);
  return party;
}

// ---- frames: client -> server ----
function sendWelcome(ws) {
  const ev = current;
  if (!ev || !ws || !ws.mmo) return;
  const seat = seatOf(ws);
  sendTo(ws, {
    type: 'welcome',
    driverId: ws.mmo.driverId,
    you: seat
      ? { seat: seat.seat, team: seat.team, name: seat.name, car: seat.car || null, bot: false }
      : { seat: 0, team: null, name: ws.mmo.name || 'DRIVER' },
    state: ev.state,
    event: { id: ev.id, index: ev.index, state: ev.state, plan: ev.plan },
    counts: counts(ev),
    max: CFG.max,
    min: CFG.min,
    bots: Boolean(ev.bots),
  });
}
function onHello(ws, msg) {
  const ev = current;
  const st = ws.mmo;
  const name = cleanName(msg && msg.name);
  const supplied = msg && validDriverId(msg.driverId) ? msg.driverId : '';
  let reclaimed = null;
  if (supplied) {
    const existing = findSeat(ev, supplied);
    if (existing) {
      // A refresh / second tab reclaims the seat for 30 s. The newest socket
      // wins; the old one is told and closed.
      const old = existing.ws;
      if (old && old !== ws && old.readyState === 1) {
        try { sendError(old, 'state', 'seat reclaimed by a newer connection'); } catch { /* ignore */ }
        try { if (old.mmo) old.mmo.seat = 0; old.close(4001, 'replaced'); } catch { /* ignore */ }
      }
      existing.ws = ws;
      existing.connected = true;
      existing.disconnectedAt = 0;
      if (!existing.name) existing.name = name;
      reclaimed = existing;
    }
  }
  st.driverId = supplied || newDriverId();
  st.name = name;
  st.hello = true;
  st.spectating = false;
  // Every welcome is followed by a full grid snapshot for that socket: it has
  // never seen a delta, and it needs every driverId to identify seats.
  st.needGridFull = true;
  if (reclaimed) st.seat = reclaimed.seat;
  if (msg && msg.partyCode) joinParty(ws, msg.partyCode, { silent: true });
  sendWelcome(ws);
  if (reclaimed) {
    const queued = ev.queue.includes(st.driverId);
    if (!queued && ev.state === 'lobby') ev.queue.push(st.driverId);
    broadcastGrid();
    if (ev.state !== 'lobby') sendQueueInfo(ws);
  }
  return reclaimed;
}
function ensureHello(ws) {
  if (!ws.mmo.hello) onHello(ws, { name: ws.mmo.name || 'DRIVER' });
}
function queueDriver(ev, ws, preferred) {
  const st = ws.mmo;
  const existing = seatOf(ws);
  if (existing) {
    if (!ev.queue.includes(st.driverId)) ev.queue.push(st.driverId);
    return existing;
  }
  const seat = assignSeat(ev, ws, preferred);
  if (!seat) { sendError(ws, 'full', 'grid is full'); return null; }
  seatDriver(ev, ws, seat);
  if (!ev.queue.includes(st.driverId)) ev.queue.push(st.driverId);
  return seat;
}
function onQueue(ws, msg) {
  const ev = current;
  const st = ws.mmo;
  ensureHello(ws);
  if (msg && msg.partyCode) joinParty(ws, msg.partyCode, { silent: true });
  if (ev.state !== 'lobby') {
    // Queue for the NEXT event instead of dropping the driver on the floor.
    if (!ev.pending.includes(st.driverId)) ev.pending.push(st.driverId);
    sendQueueInfo(ws);
    return;
  }
  const seat = queueDriver(ev, ws, msg && msg.seat);
  if (!seat) return;
  armFill(ev);
  broadcastGrid();
  sendWelcome(ws);
  broadcastQueue();
  maybeAutoStart(ev);
}
function onUnqueue(ws) {
  const ev = current;
  const st = ws.mmo;
  ev.pending = ev.pending.filter((id) => id !== st.driverId);
  ev.queue = ev.queue.filter((id) => id !== st.driverId);
  const seat = seatOf(ws);
  if (seat && ev.state === 'lobby') {
    releaseSeat(ev, seat);
    broadcastGrid();
  }
  sendQueueInfo(ws);
  broadcastQueue();
}
function onSeat(ws, msg) {
  const ev = current;
  const st = ws.mmo;
  ensureHello(ws);
  const want = Math.round(Number(msg && msg.seat));
  if (!Number.isFinite(want) || want < 1 || want > CFG.max) {
    sendError(ws, 'state', `seat must be 1..${CFG.max}`);
    return;
  }
  const target = ev.seats[want];
  if (target.driverId && target.driverId !== st.driverId) { sendError(ws, 'full', `seat ${want} is taken`); return; }
  if (ev.state !== 'lobby') { sendError(ws, 'state', `cannot move seats during ${ev.state}`); return; }
  const mine = seatOf(ws);
  if (mine && mine.seat === want) { sendQueueInfo(ws); return; }
  if (mine) releaseSeat(ev, mine);
  seatDriver(ev, ws, target);
  if (!ev.queue.includes(st.driverId)) ev.queue.push(st.driverId);
  broadcastGrid();
  sendWelcome(ws);
  sendQueueInfo(ws);
  maybeAutoStart(ev);
}
function onTelemetry(ws, msg) {
  const ev = current;
  const seat = seatOf(ws);
  if (!seat) { sendError(ws, 'state', 'no seat'); return; }
  if (ev.state !== 'racing' && ev.state !== 'countdown') {
    sendError(ws, 'state', `telemetry during ${ev.state}`);
    return;
  }
  const clientState = String((msg && msg.state) || 'racing');
  if (!['countdown', 'racing', 'finished'].includes(clientState)) {
    sendError(ws, 'bad_telemetry', `unknown telemetry state ${clientState}`);
    return;
  }
  const now = nowMs();
  if (now - (ws.mmo.lastTelemetryAt || 0) < Math.floor(1000 / CFG.telemetryHz)) {
    // Over-rate is normal (a 60 fps HUD flushes on its own cadence): drop the
    // sample silently instead of spamming error frames.
    return;
  }
  ws.mmo.lastTelemetryAt = now;
  if (clientState === 'finished') {
    const total = clampNum(msg && msg.raceTimeMs, 0, 3600000, seat.raceTimeMs || 0);
    const lap = clampInt(msg && msg.lap, 1, 99, seat.lap || 1);
    finishSeat(ev, seat, total, lap);
    return;
  }
  let lap = clampInt(msg && msg.lap, 1, 99, seat.lap || 1);
  let raceTimeMs = clampNum(msg && msg.raceTimeMs, 0, 3600000, seat.raceTimeMs || 0);
  const speedKph = clampNum(msg && msg.speedKph, 0, 400, seat.speedKph || 0);
  if (clientState === 'countdown') {
    // A reset is only legal with state:'countdown' (§3.3).
    seat.raceTimeMs = raceTimeMs;
    seat.lap = lap;
    seat.lapStartMs = raceTimeMs;
    seat.state = 'racing';
    seat.speedKph = speedKph;
    return;
  }
  if (raceTimeMs + 1 < (seat.raceTimeMs || 0)) {
    sendError(ws, 'bad_telemetry', 'raceTimeMs may not go backwards');
    return;
  }
  if (lap + 1 < (seat.lap || 0)) lap = seat.lap; // lap only resets via countdown
  seat.connected = true;
  seat.state = 'racing';
  seat.speedKph = speedKph;
  noteProgress(seat, lap, raceTimeMs);
}
function onFinish(ws, msg) {
  const ev = current;
  const seat = seatOf(ws);
  if (!seat) { sendError(ws, 'state', 'no seat'); return; }
  if (ev.state !== 'racing' && ev.state !== 'countdown') {
    sendError(ws, 'state', `finish during ${ev.state}`);
    return;
  }
  const total = clampNum(msg && msg.raceTimeMs, 0, 3600000, seat.raceTimeMs || 0);
  if (total + 1 < (seat.raceTimeMs || 0)) {
    sendError(ws, 'bad_telemetry', 'raceTimeMs may not go backwards');
    return;
  }
  const lap = clampInt(msg && msg.lap, 1, 99, seat.lap || 1);
  finishSeat(ev, seat, total, lap);
}
function onStart(ws) {
  const ev = current;
  ensureHello(ws);
  if (ev.state !== 'lobby') { sendError(ws, 'state', `cannot start during ${ev.state}`); return; }
  const st = ws.mmo;
  const queued = queueList(ev).includes(st.driverId) || Boolean(seatOf(ws));
  if (!queued) { sendError(ws, 'state', 'queue before starting'); return; }
  if (!startable(ev)) {
    sendError(ws, 'state', `need ${CFG.min} drivers (${queueList(ev).length} queued)`);
    return;
  }
  toGrid(ev);
}
function onConfig(ws, msg) {
  const ev = current;
  const st = ws.mmo;
  ensureHello(ws);
  const opaque = msg ? msg.bots : undefined;
  const want = opaque === true || opaque === 1 || opaque === '1' || opaque === 'true';
  const seated = Boolean(seatOf(ws));
  const now = nowMs();
  // A client without a seat drives the demo path, so it must not be able to
  // churn the grid: one toggle per second, then a `rate` error (§ config).
  if (!seated && now - (st.lastConfigAt || 0) < CONFIG_MIN_GAP_MS) {
    sendError(ws, 'rate', 'bots toggle is 1/s without a seat');
    return;
  }
  st.lastConfigAt = now;
  if (Boolean(ev.bots) !== want) {
    ev.bots = want;
    if (ev.state === 'lobby') {
      if (want) fillBots(ev);
      else clearBots(ev);
    }
    broadcastEvent();
    broadcastGrid();
    broadcastQueue();
  }
  sendQueueInfo(ws);
}
function onSpectate(ws) {
  const ev = current;
  const seat = seatOf(ws);
  if (seat && ev.state === 'lobby') releaseSeat(ev, seat);
  ws.mmo.seat = 0;
  ws.mmo.spectating = true;
  sendTo(ws, {
    type: 'queue',
    position: 0,
    size: queueList(ev).length,
    etaMs: etaMs(ev),
    fillMs: CFG.fillMs,
    spectating: true,
    seated: false,
    seat: 0,
    team: null,
    party: partyInfo(ws),
  });
  broadcastGrid();
  // The spectate board only prints "N WATCHING" when the count is present.
  syncSpectators(ev);
}
function onChat(ws, msg) {
  const st = ws.mmo;
  const now = nowMs();
  if (now - (st.lastChatAt || 0) < CHAT_MIN_GAP_MS) { sendError(ws, 'rate', 'chat is 1/s'); return; }
  const text = String((msg && msg.text) || '').replace(/\s+/g, ' ').trim().slice(0, CHAT_MAX);
  if (!text) { sendError(ws, 'bad_telemetry', 'empty chat'); return; }
  st.lastChatAt = now;
  const seat = seatOf(ws);
  // Additive: the contract's client->server table has `chat` but no matching
  // server->client row, so the echo reuses the feed channel shape.
  broadcastRaw(JSON.stringify({
    type: 'chat',
    event: current.id,
    seq: ++frameSeq,
    at: now,
    seat: seat ? seat.seat : 0,
    name: seat ? seat.name : (st.name || 'DRIVER'),
    team: seat ? seat.team : null,
    text,
  }));
}
function onLeave(ws) {
  const ev = current;
  const st = ws.mmo;
  ev.pending = ev.pending.filter((id) => id !== st.driverId);
  ev.queue = ev.queue.filter((id) => id !== st.driverId);
  const seat = seatOf(ws);
  if (seat && ev.state === 'lobby') releaseSeat(ev, seat);
  st.spectating = false;
  sendQueueInfo(ws);
  broadcastGrid();
  syncSpectators(ev);
}
function handleFrame(ws, msg) {
  if (!msg || typeof msg !== 'object' || typeof msg.type !== 'string') {
    sendError(ws, 'bad_telemetry', 'frame must be an object with a type');
    return;
  }
  const type = msg.type;
  if (type === 'ping') {
    sendTo(ws, { type: 'pong', at: msg.at ?? null, serverAt: nowMs() });
    return;
  }
  if (type === 'hello') {
    onHello(ws, msg);
    // A hello on an already-seated socket is a refresh/resync: either way the
    // socket gets its full snapshot on the next coalesced grid tick.
    broadcastGrid();
    return;
  }
  ensureHello(ws);
  switch (type) {
    case 'queue': onQueue(ws, msg); break;
    case 'unqueue': onUnqueue(ws); break;
    case 'leave': onLeave(ws); break;
    case 'seat': onSeat(ws, msg); break;
    case 'telemetry': onTelemetry(ws, msg); break;
    case 'finish': onFinish(ws, msg); break;
    case 'start': onStart(ws); break;
    case 'config': onConfig(ws, msg); break;
    case 'spectate': onSpectate(ws); break;
    case 'chat': onChat(ws, msg); break;
    case 'party:create': {
      const code = normalizePartyCode(msg && msg.code) || partyCode();
      joinParty(ws, code, { create: true });
      break;
    }
    case 'party:join': joinParty(ws, msg && msg.code, {}); break;
    default: sendError(ws, 'state', `unknown frame type ${type}`); break;
  }
}

// ---- socket lifecycle ----
function onConnection(ws, req) {
  let queryBots = false;
  try {
    const url = new URL(req && req.url ? req.url : '/', 'http://localhost');
    const bots = url.searchParams.get('bots');
    queryBots = bots === '1' || bots === 'true';
  } catch { /* a malformed URL just means no query flags */ }
  ws.isAlive = true;
  ws.mmo = {
    driverId: '',
    name: '',
    seat: 0,
    hello: false,
    spectating: false,
    lastTelemetryAt: 0,
    lastChatAt: 0,
    lastConfigAt: 0,
    // Grid: a socket that just said hello has not seen a full snapshot yet.
    needGridFull: false,
    // Standings back-pressure (§3.4): slow = congested right now,
    // slowPending = announce SLOW on the next delivered frame,
    // slowRecovered = announce the recovery once.
    slow: false,
    slowPending: false,
    slowRecovered: false,
    // When the next forced `slow:true` re-assert is due while congested.
    slowReassertAt: 0,
  };
  if (queryBots && current) current.bots = true;
  ws.on('pong', () => { ws.isAlive = true; });
  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString('utf8')); } catch {
      sendError(ws, 'bad_telemetry', 'invalid JSON');
      return;
    }
    try {
      handleFrame(ws, msg);
    } catch (e) {
      warn('frame failed', e);
      sendError(ws, 'state', 'server error');
    }
  });
  ws.on('close', safe(() => {
    const st = ws.mmo;
    if (!st || !current) return;
    const seat = seatOf(ws);
    if (seat) {
      // Keep the row (and the driverId) so the 30 s reclaim works and the
      // standings do not jump around mid-race.
      seat.ws = null;
      seat.connected = false;
      seat.disconnectedAt = nowMs();
      broadcastGrid();
    } else {
      current.pending = current.pending.filter((id) => id !== st.driverId);
      current.queue = current.queue.filter((id) => id !== st.driverId);
      broadcastQueue();
    }
  }));
  ws.on('error', () => {});
}
function sweepSeats(ev) {
  if (!ev || ev.state !== 'lobby') return;
  const now = nowMs();
  let changed = false;
  for (let i = 1; i <= CFG.max; i++) {
    const s = ev.seats[i];
    if (!s.driverId || s.connected || s.bot) continue;
    if (now - (s.disconnectedAt || now) < SEAT_RESERVE_MS) continue;
    // Reservation expired: the seat (and the LFG slot) goes back to the pool.
    ev.queue = ev.queue.filter((id) => id !== s.driverId);
    releaseSeat(ev, s);
    changed = true;
  }
  if (changed) { broadcastGrid(); broadcastQueue(); }
}
function mainTick() {
  try {
    const ev = current;
    if (!ev) return;
    const now = nowMs();
    if (ev.state === 'grid' || ev.state === 'countdown' || ev.state === 'racing' || ev.state === 'results') {
      if (participants(ev).some((s) => s.connected)) ev.emptySince = 0;
      else {
        if (!ev.emptySince) ev.emptySince = now;
        if (now - ev.emptySince > 5000) { abandon(ev); return; }
      }
    }
    if (ev.state === 'racing') {
      if (now - lastStandingsAt >= Math.floor(1000 / CFG.standingsHz)) {
        lastStandingsAt = now;
        tickStandings(ev);
      }
      if (ev.bots) {
        const dt = ev.lastBotTick ? now - ev.lastBotTick : 0;
        ev.lastBotTick = now;
        if (dt > 0) tickBots(ev, dt);
      }
    }
    flushFeed(now);
    if (now - lastSweepAt >= 1000) { lastSweepAt = now; sweepSeats(ev); }
    // Covers closes, `hello` resets and a spectator taking a seat: one
    // comparison per tick, a broadcast only when the number really changed.
    syncSpectators(ev);
    if (ev.state === 'lobby' && now - lastQueueAt >= 1000 && queueList(ev).length) {
      lastQueueAt = now;
      broadcastQueue();
    }
  } catch (e) {
    warn('main tick failed', e);
  }
}
function startHeartbeat() {
  return setInterval(() => {
    try {
      if (!wss) return;
      for (const ws of wss.clients) {
        if (ws.isAlive === false) {
          try { ws.terminate(); } catch { /* ignore */ }
          continue;
        }
        ws.isAlive = false;
        try { ws.ping(); } catch { /* ignore */ }
      }
    } catch (e) {
      warn('heartbeat failed', e);
    }
  }, CFG.heartbeatMs);
}

// ---- upgrade hook ----
// server.js already owns a single `upgrade` listener that destroys every path
// it does not know (/ws, /mp, /stream). Re-register a dispatcher that handles
// /mmo itself and hands every other path to the previous listeners, so /mp and
// the lobby keep byte-for-byte behaviour without editing them.
function hookServer(httpServer) {
  const previous = httpServer.listeners('upgrade').slice();
  httpServer.removeAllListeners('upgrade');
  const dispatch = (req, socket, head) => {
    let pathname = '';
    try { pathname = new URL(req && req.url ? req.url : '/', 'http://localhost').pathname; } catch { pathname = ''; }
    if (pathname === MMO_PATH || pathname === `${MMO_PATH}/`) {
      try {
        wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
      } catch (e) {
        warn('upgrade failed', e);
        try { socket.destroy(); } catch { /* ignore */ }
      }
      return;
    }
    if (!previous.length) { try { socket.destroy(); } catch { /* ignore */ } return; }
    for (const fn of previous) {
      try { fn.call(httpServer, req, socket, head); } catch (e) { warn('upgrade delegate failed', e); }
    }
  };
  httpServer.on('upgrade', dispatch);
  httpServer.on('close', () => {
    try { httpServer.removeListener('upgrade', dispatch); } catch { /* ignore */ }
  });
}

// ---- public API ----
function p50BroadcastMs() {
  if (!broadcastSamples.length) return 0;
  const sorted = broadcastSamples.slice().sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const v = sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
  return Math.round(v * 100) / 100;
}
export function mmoStatus() {
  const ev = current;
  return {
    ok: true,
    event: ev
      ? { id: ev.id, index: ev.index, state: ev.state, plan: ev.plan, bots: Boolean(ev.bots) }
      : null,
    counts: ev
      ? counts(ev)
      : { seated: 0, queued: 0, max: CFG.max, min: CFG.min, connected: 0, bots: 0, spectators: spectatorCount() },
    uptimeSec: attachedAt ? Math.floor((nowMs() - attachedAt) / 1000) : 0,
    clients: wss ? wss.clients.size : 0,
    p50BroadcastMs: p50BroadcastMs(),
    max: CFG.max,
    min: CFG.min,
    path: MMO_PATH,
  };
}
// Mounted by server.js as `app.get('/api/mmo/status', mmoStatusHandler)`; works
// with express and with a bare node response so a probe can reuse it.
export function mmoStatusHandler(req, res) {
  let body;
  try { body = mmoStatus(); } catch (e) {
    body = { ok: false, error: e && e.message ? e.message : 'status failed' };
  }
  if (!res) return body;
  try {
    res.setHeader('Cache-Control', 'no-cache');
    if (typeof res.json === 'function') { res.json(body); return; }
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-cache' });
    res.end(JSON.stringify(body));
  } catch { /* a closed response must not throw into the timer */ }
}
/**
 * Attach the /mmo WebSocket endpoint. `server` is the http/https instance that
 * already serves the cabinet; `tlsServer` (optional) is the opt-in HTTPS
 * listener so `wss://` works under RR4_TLS=1.
 */
export function attachMmo({ server, tlsServer = null, maxDrivers, minDrivers, fillMs, gridMs, countdownMs, resultsMs, raceTimeoutMs, bots } = {}) {
  if (!server) throw new Error('attachMmo: an http server is required');
  if (Number.isFinite(Number(maxDrivers))) CFG.max = clampInt(maxDrivers, 1, 1000, CFG.max);
  if (Number.isFinite(Number(minDrivers))) CFG.min = clampInt(minDrivers, 1, CFG.max, CFG.min);
  if (Number.isFinite(Number(fillMs))) CFG.fillMs = Math.max(0, Number(fillMs));
  if (Number.isFinite(Number(gridMs))) CFG.gridMs = Math.max(0, Number(gridMs));
  if (Number.isFinite(Number(countdownMs))) CFG.countdownMs = Math.max(0, Number(countdownMs));
  if (Number.isFinite(Number(resultsMs))) CFG.resultsMs = Math.max(0, Number(resultsMs));
  if (Number.isFinite(Number(raceTimeoutMs))) CFG.raceTimeoutMs = Math.max(0, Number(raceTimeoutMs));
  if (typeof bots === 'boolean') CFG.bots = bots;
  if (CFG.min > CFG.max) CFG.min = CFG.max;

  attachedAt = nowMs();
  wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 });
  current = newEvent(null);
  wss.on('connection', (ws, req) => {
    try { onConnection(ws, req); } catch (e) { warn('connection failed', e); }
  });
  hookServer(server);
  if (tlsServer) hookServer(tlsServer);
  mainTimer = setInterval(safe(mainTick), 250);
  mainTimer.unref?.();
  heartbeatTimer = startHeartbeat();
  heartbeatTimer.unref?.();
  wss.on('close', () => {
    cancelTimer(mainTimer);
    cancelTimer(heartbeatTimer);
    clearAllTimers();
  });
  console.log(`[MMO] race day attached at ${MMO_PATH} (max=${CFG.max} min=${CFG.min} fillMs=${CFG.fillMs} bots=${CFG.bots ? 'on' : 'off'})`);
  return {
    wss,
    path: MMO_PATH,
    status: mmoStatus,
    statusHandler: mmoStatusHandler,
    config: { ...CFG },
  };
}
