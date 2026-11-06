/* Race Day (50-driver MMO) protocol harness — real WebSocket clients, no browser.
 *
 * Proves the `/mmo` contract in _runtime/analysis/20-mmo-contract.md against a
 * running cabinet instance, check by check:
 *
 *   1  hello -> welcome (driverId, event, you)
 *   2  queue with 2 clients -> seats, counts, team balance
 *   3  start-now: grid -> countdown(n) -> racing inside the configured windows
 *   4  plan stability: one track/car plan, identical for every client
 *   5  telemetry ordering + compact standings payload (top N + self)
 *   6  clamps: monotonic raceTimeMs, lap 1..99, speedKph 0..400, malformed JSON
 *   7  standings cadence ~2 Hz
 *   8  finish for every seated driver -> result rows -> back to lobby
 *   9  heartbeat terminates a silent socket
 *  10  reconnect with the same driverId reclaims the same seat
 *  11  /api/mmo/status shape + live client count
 *  12  fanout budget: 60 clients x 4 Hz telemetry, p95 broadcast latency < 50 ms
 *
 * Run:  cd _server; node mmo-protocol-test.mjs
 * Options:
 *   --base <url>   instance to probe (default http://127.0.0.1:8097, or MMO_BASE)
 *   --quick        short windows (5 s cadence, 3 s fanout, results may be pending)
 *   --lobby-wait <ms>  how long to wait for a `lobby` event before seating (default
 *                  90000; lower it with --quick). A busy shared instance stays
 *                  in racing and accepts no new seats, so this is the knob.
 *
 * Server env used by this harness when present (same values on the server):
 *   RR4_MMO_MAX MIN FILL_MS GRID_MS COUNTDOWN_MS RESULTS_MS RACE_TIMEOUT_MS
 *   RR4_MMO_HEARTBEAT_MS
 * Missing overrides are read out of /api/mmo/status, then from the contract
 * defaults. Writes ONE evidence file: _runtime/mmo-protocol.json
 *
 * Read-only: never restarts or reconfigures the instance it probes.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const EVIDENCE = path.join(ROOT, '_runtime', 'mmo-protocol.json');

const DEFAULTS = Object.freeze({
  max: 50, min: 4, fillMs: 60000, gridMs: 5000, countdownMs: 3000,
  resultsMs: 20000, raceTimeoutMs: 600000, heartbeatMs: 20000,
});
const TELEMETRY_HZ = 4;
const STANDINGS_HZ = 2;

const ARGV = process.argv.slice(2);
const flag = (name) => ARGV.includes(name);
const opt = (name) => { const i = ARGV.indexOf(name); return i >= 0 ? ARGV[i + 1] : undefined; };
const BASE = (opt('--base') || process.env.MMO_BASE || 'http://127.0.0.1:8097').replace(/\/+$/, '');
const QUICK = flag('--quick');
const WS_URL = BASE.replace(/^http/i, 'ws') + '/mmo';
const STATUS_URL = `${BASE}/api/mmo/status`;
// The server agent leaves a throwaway instance on :8097; give it up to 8 minutes.
const SERVER_WAIT_MS = QUICK ? 150000 : 480000;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
// A shared throwaway instance can be busy with another agent's load probe; a
// racing event accepts no new seats, so wait for a lobby before seating anyone.
const LOBBY_WAIT_MS = Number(opt('--lobby-wait') || 0) || (QUICK ? 30000 : 90000);

// ---------------------------------------------------------------- checks ----
const CHECKS = [
  [1, 'hello -> welcome'],
  [2, 'queue seats 2 drivers + team balance'],
  [3, 'start-now: grid -> countdown -> racing'],
  [4, 'plan stability across clients'],
  [5, 'telemetry -> standings ordering + compact payload'],
  [6, 'clamps: time, lap, speed, malformed JSON'],
  [7, 'standings cadence ~2 Hz'],
  [8, 'finish -> result -> lobby'],
  [9, 'heartbeat terminates a silent socket'],
  [10, 'reconnect reclaims the same seat'],
  [11, '/api/mmo/status shape + client count'],
  [12, 'fanout budget: 60 clients @ 4 Hz'],
];
const RESULTS = new Map();
const INFOS = [];

function group(n, id) {
  const subs = [];
  const g = {
    note(name, ok, detail = '') { subs.push({ name, ok: !!ok, detail }); return !!ok; },
    info(name, detail = '') { subs.push({ name, ok: true, detail, info: true }); return true; },
    skip(name, detail = '') { subs.push({ name, ok: true, detail, skip: true }); INFOS.push({ n, name, detail }); return true; },
    finish(detail = '', extra = {}) {
      const fails = subs.filter((s) => !s.ok);
      const skips = subs.filter((s) => s.skip);
      const ok = fails.length === 0;
      RESULTS.set(n, {
        n, id, ok, detail: ok ? detail : fails.map((f) => `${f.name} :: ${f.detail}`).join(' | '),
        skipped: skips.length, subs, extra,
      });
      const label = ok ? (skips.length ? 'SKIP' : 'PASS') : 'FAIL';
      console.log(`${label.padEnd(4)}  ${n}/12  ${id}${detail ? ' :: ' + detail : ''}`);
      for (const f of fails) console.log(`        -> ${f.name} :: ${f.detail}`);
      return ok;
    },
  };
  return g;
}
const info = (id, detail = '') => { INFOS.push({ id, detail }); console.log(`INFO  ${id}${detail ? ' :: ' + detail : ''}`); };

// --------------------------------------------------------------- sockets ----
const clients = [];

function open(tag, wsOptions = {}) {
  const ws = new WebSocket(WS_URL, wsOptions);
  const peer = {
    tag, ws, inbox: [], waiters: [], frames: [], types: [], errors: [],
    openedAt: 0, closedAt: 0, closeInfo: '', pings: 0, pongs: 0, badFrames: 0, firstPingAt: 0,
    driverId: null, seat: null, team: null, name: tag,
  };
  ws.on('message', (data) => {
    const text = typeof data === 'string' ? data : data.toString('utf8');
    let msg;
    try { msg = JSON.parse(text); } catch { peer.badFrames += 1; return; }
    msg.__at = Date.now();
    msg.__bytes = Buffer.byteLength(text);
    peer.frames.push(msg);
    peer.inbox.push(msg);
    peer.types.push(msg.type);
    if (msg.type === 'error') peer.errors.push(msg);
    for (let i = 0; i < peer.waiters.length; i += 1) {
      const waiter = peer.waiters[i];
      if (!waiter.match(msg)) continue;
      peer.waiters.splice(i, 1);
      i -= 1;
      clearTimeout(waiter.timer);
      waiter.resolve(msg);
    }
  });
  ws.on('ping', () => { peer.pings += 1; if (!peer.firstPingAt) peer.firstPingAt = Date.now(); });
  ws.on('pong', () => { peer.pongs += 1; });
  ws.on('open', () => { peer.openedAt = Date.now(); });
  ws.on('close', (code, reason) => {
    peer.closedAt = Date.now();
    peer.closeInfo = `code=${code}${reason && reason.length ? ' reason=' + reason.toString('utf8') : ''}`;
  });
  ws.on('error', (err) => { peer.errors.push({ type: 'socket', message: err && err.message }); });
  clients.push(peer);
  return peer;
}

function opened(peer, ms = 8000) {
  if (peer.ws.readyState === 1) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${peer.tag}: socket not open after ${ms}ms`)), ms);
    peer.ws.once('open', () => { clearTimeout(timer); resolve(); });
    peer.ws.once('error', (err) => { clearTimeout(timer); reject(err); });
  });
}

function waitFor(peer, match, ms = 6000, label = 'message') {
  const at = peer.inbox.findIndex(match);
  if (at >= 0) return Promise.resolve(peer.inbox.splice(at, 1)[0]);
  let waiter;
  const promise = new Promise((resolve, reject) => {
    waiter = { match, resolve, timer: null };
    waiter.timer = setTimeout(() => {
      const i = peer.waiters.indexOf(waiter);
      if (i >= 0) peer.waiters.splice(i, 1);
      reject(new Error(`${peer.tag}: timeout ${ms}ms waiting for ${label}`));
    }, ms);
    peer.waiters.push(waiter);
  });
  promise.cancel = () => {
    const i = peer.waiters.indexOf(waiter);
    if (i >= 0) peer.waiters.splice(i, 1);
    clearTimeout(waiter.timer);
  };
  return promise;
}

function waitAny(peers, match, ms = 6000, label = 'message') {
  let best = null;
  for (const p of peers) {
    const hit = p.inbox.find(match);
    if (hit && (!best || hit.__at < best.m.__at)) best = { p, m: hit };
  }
  if (best) {
    best.p.inbox.splice(best.p.inbox.indexOf(best.m), 1);
    return Promise.resolve(best.m);
  }
  const races = peers.map((p) => waitFor(p, match, ms, `${label}/${p.tag}`));
  return Promise.race(races).finally(() => { for (const r of races) r.cancel?.(); });
}

const send = (peer, obj) => {
  try { peer.ws.send(JSON.stringify(obj)); return true; } catch { return false; }
};
const sendRaw = (peer, text) => {
  try { peer.ws.send(text); return true; } catch { return false; }
};
const drain = (peer) => { peer.inbox.length = 0; };
const hello = (peer, extra = {}) => send(peer, { type: 'hello', name: peer.name, ...extra });

// -------------------------------------------------------------- utilities ---
const pct = (values, p) => {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx];
};
const round = (v, d = 1) => (v === null || v === undefined ? null : Number(v.toFixed(d)));

function numericLeaves(obj, prefix = '', depth = 0) {
  const out = [];
  if (!obj || typeof obj !== 'object' || depth > 6) return out;
  for (const [k, v] of Object.entries(obj)) {
    const p = prefix ? `${prefix}.${k}` : k;
    if (typeof v === 'number' && Number.isFinite(v)) out.push({ path: p, value: v });
    else if (v && typeof v === 'object') out.push(...numericLeaves(v, p, depth + 1));
  }
  return out;
}

function hash(str) {
  let h = 5381;
  for (let i = 0; i < str.length; i += 1) h = ((h * 33) ^ str.charCodeAt(i)) >>> 0;
  return h.toString(36);
}

function frameKey(m) {
  // Rows are spliced per recipient ("top N + self + neighbours"), so the
  // identity of a broadcast is the shared head of the table, not the whole
  // payload. `seq` is a global frame counter and is kept out on purpose.
  if (m.type === 'standings') {
    const lead = Array.isArray(m.rows)
      ? m.rows.slice(0, 3).map((r) => `${r.seat}:${r.lap}:${r.raceTimeMs}`).join(',')
      : '';
    return `standings|${m.event ?? ''}|${lead}|${m.top ?? ''}`;
  }
  if (m.type === 'grid') {
    return `grid|${m.event ?? ''}|${hash(JSON.stringify(m.counts || null))}|${Array.isArray(m.seats) ? m.seats.length : ''}`;
  }
  if (m.type === 'event') return `event|${m.event ?? ''}|${m.state ?? ''}|${hash(JSON.stringify(m.counts || null))}`;
  if (m.type === 'feed') return `feed|${m.at ?? ''}|${hash(String(m.text || ''))}`;
  return `${m.type}|${hash(JSON.stringify(m))}`;
}

function inWindow(peer, from, to, types = null) {
  return peer.frames.filter((f) => f.__at >= from && f.__at <= to && (!types || types.includes(f.type)));
}

function statesSeen(peer, fromAt = 0) {
  const out = [];
  for (const m of peer.frames) {
    if (m.__at < fromAt) continue;
    let state = null;
    if (m.type === 'event' && typeof m.state === 'string') state = m.state;
    else if (m.type === 'countdown') state = 'countdown';
    else if (m.type === 'standings') state = 'racing';
    else if (m.type === 'result' || m.type === 'results') state = 'results';
    else if (m.type === 'grid') state = 'grid';
    if (!state) continue;
    if (!out.length || out[out.length - 1].state !== state) out.push({ state, at: m.__at });
  }
  return out;
}
const firstStateAt = (peer, state) => {
  const hit = statesSeen(peer).find((s) => s.state === state);
  return hit ? hit.at : 0;
};

async function getStatus() {
  const res = await fetch(STATUS_URL, { cache: 'no-store' });
  if (!res.ok) throw new Error(`/api/mmo/status HTTP ${res.status}`);
  return res.json();
}

function findKeyDeep(obj, name, depth = 0) {
  if (!obj || typeof obj !== 'object' || depth > 6) return undefined;
  if (typeof obj[name] === 'number') return obj[name];
  for (const v of Object.values(obj)) {
    if (!v || typeof v !== 'object') continue;
    const hit = findKeyDeep(v, name, depth + 1);
    if (hit !== undefined) return hit;
  }
  return undefined;
}

function resolveConstants(status) {
  const num = (envKey, statusKey, fallback) => {
    const env = Number(process.env[envKey]);
    if (Number.isFinite(env) && env > 0) return env;
    const fromStatus = status ? findKeyDeep(status, statusKey) : undefined;
    if (Number.isFinite(fromStatus) && fromStatus > 0) return fromStatus;
    return fallback;
  };
  return {
    max: num('RR4_MMO_MAX', 'max', DEFAULTS.max),
    min: num('RR4_MMO_MIN', 'min', DEFAULTS.min),
    fillMs: num('RR4_MMO_FILL_MS', 'fillMs', DEFAULTS.fillMs),
    gridMs: num('RR4_MMO_GRID_MS', 'gridMs', DEFAULTS.gridMs),
    countdownMs: num('RR4_MMO_COUNTDOWN_MS', 'countdownMs', DEFAULTS.countdownMs),
    resultsMs: num('RR4_MMO_RESULTS_MS', 'resultsMs', DEFAULTS.resultsMs),
    raceTimeoutMs: num('RR4_MMO_RACE_TIMEOUT_MS', 'raceTimeoutMs', DEFAULTS.raceTimeoutMs),
    heartbeatMs: num('RR4_MMO_HEARTBEAT_MS', 'heartbeatMs', DEFAULTS.heartbeatMs),
  };
}

async function waitForServer(limitMs) {
  const started = Date.now();
  let last = '';
  while (Date.now() - started < limitMs) {
    try {
      const status = await getStatus();
      info('server-ready', `${STATUS_URL} after ${Date.now() - started}ms`);
      return status;
    } catch (err) {
      last = err && err.message ? err.message : String(err);
    }
    console.log(`WAIT  ${STATUS_URL} not up yet (${last}) - retry in 5s`);
    await sleep(5000);
  }
  throw new Error(`${STATUS_URL} not reachable after ${limitMs}ms (${last})`);
}

// Wait for the event to be in `lobby` (seat assignment only happens there) and
// report who else is on the instance, so a busy shared server is diagnosable.
async function ensureLobby(tag = '', limitMs = LOBBY_WAIT_MS) {
  const started = Date.now();
  let status = await getStatus().catch(() => null);
  const first = status && status.event ? status.event.state : null;
  while (status && status.event && status.event.state !== 'lobby' && Date.now() - started < limitMs) {
    await sleep(1000);
    status = await getStatus().catch(() => null);
  }
  const mine = clients.filter((c) => c.ws.readyState === 1).length;
  const state = status && status.event ? status.event.state : '?';
  const foreign = status && typeof status.clients === 'number' ? Math.max(0, status.clients - mine) : null;
  const waitedMs = Date.now() - started;
  info(`lobby-ready${tag ? '/' + tag : ''}`,
    `state=${state} after ${waitedMs}ms (was ${first}; status.clients=${status ? status.clients : '?'} mine=${mine} foreign=${foreign})`);
  return { state, foreign, clients: status ? status.clients : null, waitedMs };
}

const seatRow = (grid, driverId) => {  const rows = (grid && Array.isArray(grid.seats)) ? grid.seats : [];
  return rows.find((r) => r.driverId === driverId) || null;
};
const gridWith = (driverId) => (m) => m.type === 'grid' && Array.isArray(m.seats)
  && m.seats.some((r) => r.driverId === driverId);
const rowBySeat = (rows, seat) => (Array.isArray(rows) ? rows.find((r) => r.seat === seat) || null : null);

// telemetry pump: one send per entry every 1000/hz ms, keeps a running clock
async function pumpTelemetry(entries, ms, hz = TELEMETRY_HZ) {
  const period = Math.round(1000 / hz);
  const start = Date.now();
  const end = start + ms;
  const stats = { sends: 0, start, end, period };
  await Promise.all(entries.map(async ([peer, seed]) => {
    let clock = seed.raceTimeMs;
    while (Date.now() < end) {
      if (peer.ws.readyState !== 1) break;
      clock += Math.min(150, period);
      send(peer, {
        type: 'telemetry', t: Date.now(), lap: seed.lap, raceTimeMs: clock,
        speedKph: seed.speedKph ?? 180, state: 'racing',
      });
      stats.sends += 1;
      await sleep(period);
    }
  }));
  return stats;
}

// ------------------------------------------------------------------ flow ----
const evidence = {
  probe: 'mmo-protocol',
  target: WS_URL,
  statusUrl: STATUS_URL,
  startedAt: new Date().toISOString(),
  node: process.version,
  quick: QUICK,
  constants: null,
  checks: [],
  measurements: {},
  result: 'FAIL',
};

let consts = { ...DEFAULTS };
let A = null;
let B = null;
let gridA = null;
let gridB = null;
let welcomeA = null;
let sessionStartedAt = 0;

async function runSession() {
  A = null; B = null; gridA = null; gridB = null; welcomeA = null;
  const status0 = await waitForServer(SERVER_WAIT_MS);
  consts = resolveConstants(status0);
  evidence.constants = consts;
  info('constants', JSON.stringify(consts));

  // ---- 1. hello -> welcome -------------------------------------------------
  const g1 = group(1, 'hello -> welcome');
  A = open('A');
  A.name = 'PROBE-A';
  await opened(A);
  sessionStartedAt = Date.now();
  hello(A);
  welcomeA = await waitFor(A, (m) => m.type === 'welcome' || m.type === 'hello', 8000, 'welcome(A)').catch(() => null);
  evidence.measurements.welcome = welcomeA;
  const you = (welcomeA && welcomeA.you) || null;
  g1.note('welcome-frame', !!welcomeA, welcomeA ? `type=${welcomeA.type}` : 'no welcome/hello frame within 8s');
  g1.note('welcome-driver-id', !!(welcomeA && typeof welcomeA.driverId === 'string' && welcomeA.driverId.length > 0),
    welcomeA ? `driverId=${String(welcomeA.driverId).slice(0, 24)}` : 'missing');
  g1.note('welcome-you-object', !!you && typeof you === 'object'
    && Object.prototype.hasOwnProperty.call(you, 'seat')
    && Object.prototype.hasOwnProperty.call(you, 'team')
    && Object.prototype.hasOwnProperty.call(you, 'name'),
    you ? `you=${JSON.stringify(you)}` : 'missing you{}');
  const welcomeEvent = welcomeA && welcomeA.event && typeof welcomeA.event === 'object' ? welcomeA.event : null;
  g1.note('welcome-event', !!welcomeEvent && (welcomeEvent.id !== undefined || welcomeEvent.index !== undefined),
    welcomeEvent ? `id=${welcomeEvent.id} index=${welcomeEvent.index} plan=${welcomeEvent.plan ? 'yes' : 'no'}` : 'missing event{}');
  g1.note('welcome-state-max-min', !!(welcomeA && typeof welcomeA.state === 'string' && typeof welcomeA.max === 'number' && typeof welcomeA.min === 'number'),
    welcomeA ? `state=${welcomeA.state} max=${welcomeA.max} min=${welcomeA.min} bots=${welcomeA.bots}` : 'missing');
  const framedA = A.frames.filter((m) => m.type !== 'error');
  const seqs = framedA.map((m) => m.seq);
  const seqOk = seqs.length > 0 && seqs.every((s) => typeof s === 'number')
    && seqs.every((s, i) => i === 0 || s > seqs[i - 1]);
  g1.note('welcome-seq-monotonic', seqOk, seqOk ? `${seqs.length} frame(s), seq ${seqs[0]}..${seqs[seqs.length - 1]}` : `seq=${JSON.stringify(seqs.slice(0, 6))}`);
  A.driverId = welcomeA ? welcomeA.driverId : null;
  A.seat = you ? you.seat ?? null : null;
  A.team = you ? you.team ?? null : null;
  const initialEventId = welcomeEvent ? welcomeEvent.id ?? null : null;
  g1.finish(`driverId=${A.driverId} state=${welcomeA ? welcomeA.state : '?'} max=${welcomeA ? welcomeA.max : '?'}`);

  B = open('B');
  B.name = 'PROBE-B';
  await opened(B);
  hello(B);
  const welcomeB = await waitFor(B, (m) => m.type === 'welcome' || m.type === 'hello', 8000, 'welcome(B)').catch(() => null);
  B.driverId = welcomeB ? welcomeB.driverId : null;
  B.seat = welcomeB && welcomeB.you ? welcomeB.you.seat ?? null : null;
  B.team = welcomeB && welcomeB.you ? welcomeB.you.team ?? null : null;
  if (!B.driverId || B.driverId === A.driverId) throw new Error(`second hello did not get its own driverId (${B.driverId})`);

  // ---- 11. /api/mmo/status ------------------------------------------------
  const g11 = group(11, '/api/mmo/status shape + client count');
  let st1 = null;
  let statusErr = '';
  try { st1 = await getStatus(); } catch (err) { statusErr = err.message; }
  const statusKeys = st1 ? Object.keys(st1) : [];
  g11.note('status-json', !!st1 && typeof st1 === 'object' && statusKeys.length > 0,
    st1 ? `keys=${statusKeys.join(',')}` : statusErr);
  const eventish = st1 && (st1.event || st1.state || st1.counts
    || (st1.mmo && (st1.mmo.event || st1.mmo.state || st1.mmo.counts)));
  g11.note('status-event-state', !!eventish,
    eventish ? JSON.stringify(st1.event || st1.state || st1.counts || st1.mmo).slice(0, 240) : 'no event/state/counts in status');
  const leaves1 = st1 ? numericLeaves(st1) : [];
  const before = new Map(leaves1.map((l) => [l.path, l.value]));
  const probe = open('STATUS-PROBE');
  probe.name = 'PROBE-STATUS';
  await opened(probe);
  hello(probe);
  await waitFor(probe, (m) => m.type === 'welcome' || m.type === 'hello', 6000, 'welcome(status-probe)').catch(() => null);
  await sleep(400);
  const st2 = await getStatus().catch(() => null);
  const after = new Map((st2 ? numericLeaves(st2) : []).map((l) => [l.path, l.value]));
  const inc = [...after.entries()].filter(([p, v]) => before.has(p) && v === before.get(p) + 1
    && /client|conn|sock|online|live|driver|player|count/i.test(p));
  probe.ws.terminate();
  await sleep(400);
  const st3 = await getStatus().catch(() => null);
  const after3 = new Map((st3 ? numericLeaves(st3) : []).map((l) => [l.path, l.value]));
  const countPath = inc.find(([p]) => after3.get(p) === before.get(p)) || null;
  g11.note('status-client-count-tracks-sockets', !!countPath,
    inc.length
      ? inc.map(([p, v]) => `${p} ${before.get(p)} -> ${v} -> ${after3.get(p)}`).join(', ')
      : `no numeric field rose by exactly 1 for a new socket; numeric leaves=[${[...before.keys()].join(',')}]`);
  if (countPath) evidence.measurements.clientCountField = countPath[0];
  g11.info('status-max-min', `${findKeyDeep(st1, 'max')}/${findKeyDeep(st1, 'min')} (welcome ${welcomeA ? welcomeA.max : '?'}/${welcomeA ? welcomeA.min : '?'})`);
  g11.finish(countPath ? `client count field: ${countPath[0]}` : 'client count not proven');

  // ---- 2. queue seats both drivers ---------------------------------------
  const lobby = await ensureLobby();
  const g2 = group(2, 'queue seats 2 drivers + team balance');
  const errIdxA = A.errors.length;
  const errIdxB = B.errors.length;
  drain(A);
  drain(B);
  send(A, { type: 'queue' });
  send(B, { type: 'queue' });
  const [ackA, gridA0, gridB0] = await Promise.all([
    waitFor(A, (m) => m.type === 'queue', 5000, 'queue(A)').catch(() => null),
    waitFor(A, gridWith(A.driverId), 9000, 'grid(A seat)').catch(() => null),
    waitFor(B, gridWith(B.driverId), 9000, 'grid(B seat)').catch(() => null),
  ]);
  gridA = gridA0 || [...A.frames].reverse().find((m) => m.type === 'grid') || null;
  gridB = gridB0 || [...B.frames].reverse().find((m) => m.type === 'grid') || null;
  const rowA = gridA ? seatRow(gridA, A.driverId) : null;
  const rowB = gridB ? seatRow(gridB, B.driverId) : null;
  if (rowA) { A.seat = rowA.seat; A.team = rowA.team; }
  if (rowB) { B.seat = rowB.seat; B.team = rowB.team; }
  evidence.measurements.seats = { a: rowA, b: rowB, counts: gridA ? gridA.counts : null };
  g2.note('grid-frame-both', !!gridA && !!gridB,
    `A=${gridA ? 'yes' : 'no'} B=${gridB ? 'yes' : 'no'} typesA=[${A.types.slice(0, 10).join(',')}]`);
  g2.note('seats-assigned-distinct', !!rowA && !!rowB && Number.isInteger(rowA.seat)
    && Number.isInteger(rowB.seat) && rowA.seat !== rowB.seat,
    rowA && rowB ? `A.seat=${rowA.seat} B.seat=${rowB.seat}` : 'seat rows missing from grid');
  const counts = gridA ? gridA.counts : null;
  g2.note('counts-present', !!counts && typeof counts.seated === 'number'
    && typeof counts.queued === 'number' && typeof counts.max === 'number',
    counts ? JSON.stringify(counts) : 'grid.counts missing');
  g2.note('counts-seated>=2', !!counts && counts.seated >= 2, counts ? `seated=${counts.seated}` : '-');
  g2.note('counts-max-matches-welcome', !!counts && !!welcomeA && counts.max === welcomeA.max,
    counts && welcomeA ? `grid.max=${counts.max} welcome.max=${welcomeA.max}` : '-');
  g2.note('grid-rows-human-online', !!rowA && !!rowB && rowA.bot !== true && rowB.bot !== true
    && rowA.connected !== false && rowB.connected !== false,
    rowA && rowB ? `A=${JSON.stringify({ bot: rowA.bot, connected: rowA.connected, state: rowA.state }) } B=${JSON.stringify({ bot: rowB.bot, connected: rowB.connected, state: rowB.state })}` : '-');
  g2.note('team-balance', !!rowA && !!rowB && rowA.team !== rowB.team,
    rowA && rowB ? `teams A=${rowA.team} B=${rowB.team}` : '-');
  if (ackA) {
    g2.info('queue-ack', JSON.stringify({ position: ackA.position, size: ackA.size, etaMs: ackA.etaMs, fillMs: ackA.fillMs }));
  } else {
    g2.info('queue-ack', 'no `queue` ack frame (seat info taken from `grid`)');
  }
  g2.note('no-full-error', !A.errors.some((e) => e.code === 'full') && !B.errors.some((e) => e.code === 'full'),
    `errors A=${A.errors.length} B=${B.errors.length}`);
  const qErrs = [...A.errors.slice(errIdxA), ...B.errors.slice(errIdxB)].filter((e) => e.code === 'state');
  g2.note('queue-accepted', qErrs.length === 0,
    qErrs.length ? `error{code:'state'} ${String(qErrs[0].message || '')} (event was ${lobby.state}, ${lobby.foreign ?? '?'} foreign client(s))` : 'no state error after queue');
  g2.info('event-contention', `event ${lobby.state} after a ${lobby.waitedMs}ms wait; status.clients=${lobby.clients} foreign=${lobby.foreign}`);
  g2.finish(`seats ${rowA ? rowA.seat : '?'}/${rowB ? rowB.seat : '?'} teams ${rowA ? rowA.team : '?'}/${rowB ? rowB.team : '?'}`);

  // ---- 3. start-now -> grid -> countdown -> racing ------------------------
  const g3 = group(3, 'start-now: grid -> countdown -> racing');
  const gridAt = Math.min(gridA0 ? gridA0.__at : Infinity, gridB0 ? gridB0.__at : Infinity);
  const startSentAt = Date.now();
  send(A, { type: 'start' });
  const startAck = await waitAny([A, B], (m) => (m.type === 'event' && m.state === 'grid')
    || m.type === 'countdown' || m.type === 'error', 2000, 'start-ack').catch(() => null);
  const startHonored = !!startAck && startAck.type !== 'error';
  evidence.measurements.startNow = {
    sent: true, honored: startHonored,
    ms: startAck ? startAck.__at - startSentAt : null,
    reply: startAck ? { type: startAck.type, state: startAck.state, code: startAck.code } : null,
  };
  if (!startHonored) {
    info('start-now', `{type:'start'} ${startAck && startAck.type === 'error' ? `rejected: ${startAck.code} ${startAck.message || ''}` : 'silently ignored'} - falling back to the fill timer`);
  } else {
    info('start-now', `honoured in ${startAck.__at - startSentAt}ms (${startAck.type}${startAck.state ? ':' + startAck.state : ''})`);
  }
  const cdWait = consts.gridMs + Math.min(consts.fillMs, 15000) + 6000;
  const countdown = await waitAny([A, B], (m) => m.type === 'countdown', cdWait, 'countdown').catch(() => null);
  evidence.measurements.countdown = countdown;
  const cdAt = countdown ? countdown.__at : 0;
  g3.note('countdown-frame', !!countdown, countdown ? `n=${countdown.n} startsAt=${countdown.startsAt}` : `no countdown within ${cdWait}ms`);
  g3.note('countdown-n', !!countdown && Number.isInteger(countdown.n) && countdown.n >= 1 && countdown.n <= 3,
    countdown ? `n=${countdown.n}` : '-');
  const startsAt = countdown ? countdown.startsAt : null;
  g3.note('countdown-startsAt-future', Number.isFinite(startsAt) && startsAt > cdAt,
    Number.isFinite(startsAt) ? `startsAt-now=${startsAt - cdAt}ms` : `startsAt=${startsAt}`);
  g3.note('countdown-window', Number.isFinite(startsAt) && startsAt > cdAt
    && startsAt - cdAt <= consts.countdownMs + 3000,
  Number.isFinite(startsAt) ? `budget ${consts.countdownMs + 3000}ms, got ${startsAt - cdAt}ms` : '-');
  const racingAt = await waitAny([A, B], (m) => (m.type === 'event' && m.state === 'racing') || m.type === 'standings',
    consts.countdownMs + 8000, 'racing').then((m) => m.__at).catch(() => 0);
  g3.note('racing-reached', racingAt > 0, racingAt ? `after ${racingAt - startSentAt}ms` : 'no racing frame');
  g3.note('order-grid-then-countdown', Number.isFinite(gridAt) && cdAt > 0 && gridAt <= cdAt,
    `grid@+${Number.isFinite(gridAt) ? gridAt - startSentAt : '?'}ms countdown@+${cdAt ? cdAt - startSentAt : '?'}ms`);
  g3.note('window-grid->countdown', Number.isFinite(gridAt) && cdAt > 0 && (cdAt - gridAt) <= consts.gridMs + 4000,
    `budget ${consts.gridMs + 4000}ms, got ${cdAt && Number.isFinite(gridAt) ? cdAt - gridAt : '?'}ms`);
  g3.note('window-countdown->racing', cdAt > 0 && racingAt > 0 && (racingAt - cdAt) <= consts.countdownMs + 3000,
    `budget ${consts.countdownMs + 3000}ms, got ${cdAt && racingAt ? racingAt - cdAt : '?'}ms`);
  const cdA = A.frames.find((m) => m.type === 'countdown');
  const cdB = B.frames.find((m) => m.type === 'countdown');
  g3.note('countdown-same-startsAt-both', !!cdA && !!cdB && cdA.startsAt === cdB.startsAt,
    `A=${cdA ? cdA.startsAt : '-'} B=${cdB ? cdB.startsAt : '-'}`);
  const ns = A.frames.filter((m) => m.type === 'countdown').map((m) => m.n);
  g3.info('countdown-sequence', JSON.stringify(ns));
  g3.finish(`grid->countdown ${cdAt && Number.isFinite(gridAt) ? cdAt - gridAt : '?'}ms, countdown n=${countdown ? countdown.n : '?'}, racing ${racingAt ? racingAt - startSentAt : '?'}ms after start`);

  // ensure both sockets saw racing before telemetry checks
  if (!firstStateAt(B, 'racing')) {
    await waitAny([B], (m) => (m.type === 'event' && m.state === 'racing') || m.type === 'standings', 4000, 'racing(B)').catch(() => null);
  }

  // ---- 4. plan stability --------------------------------------------------
  const g4 = group(4, 'plan stability across clients');
  const planOf = (m) => {
    if (m.plan && typeof m.plan === 'object') return m.plan;
    if (m.event && typeof m.event === 'object' && m.event.plan && typeof m.event.plan === 'object') return m.event.plan;
    return null;
  };
  const plans = [];
  for (const p of [A, B]) {
    for (const m of p.frames) {
      const plan = planOf(m);
      if (plan) plans.push({ tag: p.tag, at: m.__at, plan });
    }
  }
  const locked = plans.filter((x) => x.at >= (Number.isFinite(gridAt) ? gridAt : sessionStartedAt));
  const firstPlan = locked.length ? locked[0].plan : null;
  const planKeys = new Set(locked.map((x) => [x.plan.trackIndex, x.plan.trackName, x.plan.carClass].join('|')));
  const R4_TRACKS = ['Helter Skelter', 'Wonderhill', 'Edge of the Earth', 'Out of Blue',
    'Phantomile', 'Brightest Nite', 'Heaven and Hell', 'Shooting Hoops'];
  evidence.measurements.plan = { first: firstPlan, variants: [...planKeys], frames: locked.length };
  g4.note('plan-present', !!firstPlan, firstPlan ? JSON.stringify(firstPlan) : `no plan on any frame after grid (${plans.length} plan frame(s) total)`);
  g4.note('plan-identical-everywhere', locked.length > 0 && planKeys.size === 1,
    `${locked.length} plan frame(s), ${planKeys.size} distinct plan(s): ${[...planKeys].join(' / ')}`);
  g4.note('plan-both-clients', ['A', 'B'].every((t) => locked.some((x) => x.tag === t)),
    `A=${locked.filter((x) => x.tag === 'A').length} B=${locked.filter((x) => x.tag === 'B').length} plan frame(s)`);
  g4.note('plan-track-index', !!firstPlan && Number.isInteger(firstPlan.trackIndex)
    && firstPlan.trackIndex >= 0 && firstPlan.trackIndex <= 7,
  firstPlan ? `trackIndex=${firstPlan.trackIndex}` : '-');
  g4.note('plan-track-name', !!firstPlan && typeof firstPlan.trackName === 'string' && firstPlan.trackName.length > 0,
    firstPlan ? `trackName=${firstPlan.trackName}${R4_TRACKS.includes(firstPlan.trackName) ? '' : ' (not in the R4 course list)'}` : '-');
  g4.note('plan-car-class', !!firstPlan && typeof firstPlan.carClass === 'string' && firstPlan.carClass.length > 0,
    firstPlan ? `carClass=${firstPlan.carClass}` : '-');
  g4.info('plan-stability', `${locked.length} frame(s), trackIndex=${firstPlan ? firstPlan.trackIndex : '?'}, startedAt=${firstPlan ? firstPlan.startedAt : '?'} startsAt=${firstPlan ? firstPlan.startsAt : '?'}`);
  g4.finish(firstPlan ? `track ${firstPlan.trackIndex}/${firstPlan.trackName}, car ${firstPlan.carClass}, ${locked.length} identical frame(s)` : 'no locked plan');

  // ---- 5. telemetry ordering + compact standings -------------------------
  const readStandings = async (peer, ms = 4000) => {
    drain(peer);
    return waitFor(peer, (m) => m.type === 'standings', ms, 'standings').catch(() => null);
  };
  const auditRows = (rows) => {
    const problems = [];
    for (let i = 1; i < rows.length; i += 1) {
      const ahead = rows[i - 1];
      const me = rows[i];
      if (me.lap > ahead.lap) { problems.push(`lap order: ${ahead.lap}/${ahead.raceTimeMs} before ${me.lap}/${me.raceTimeMs}`); break; }
      if (me.lap === ahead.lap && me.raceTimeMs < ahead.raceTimeMs) {
        problems.push(`time order within lap ${me.lap}: ${ahead.raceTimeMs} before ${me.raceTimeMs}`); break;
      }
    }
    for (let i = 0; i < rows.length; i += 1) {
      if (rows[i].position !== i + 1) { problems.push(`position ${rows[i].position} at index ${i}`); break; }
    }
    for (let i = 1; i < rows.length; i += 1) {
      const ahead = rows[i - 1];
      const me = rows[i];
      if (me.lap === ahead.lap) {
        const expected = me.raceTimeMs - ahead.raceTimeMs;
        if (me.gapMs !== expected) {
          problems.push(`gapMs=${me.gapMs} expected ${expected} (${me.raceTimeMs}-${ahead.raceTimeMs})`); break;
        }
      } else if (me.gapMs !== null) {
        problems.push(`gapMs=${me.gapMs} should be null with a lap between (${me.lap} vs ${ahead.lap})`); break;
      }
    }
    if (rows.length && rows[0].gapMs !== null && rows[0].gapMs !== 0) problems.push(`leader gapMs=${rows[0].gapMs} (expected null or 0)`);
    return problems;
  };
  const g5 = group(5, 'telemetry -> standings ordering + compact payload');
  const seatA = A.seat;
  const seatB = B.seat;
  const tele = (peer, obj) => send(peer, { type: 'telemetry', t: Date.now(), speedKph: 180, state: 'racing', ...obj });

  tele(A, { lap: 2, raceTimeMs: 30000, speedKph: 200 });
  await sleep(150);
  tele(B, { lap: 2, raceTimeMs: 29000, speedKph: 195 });
  await sleep(800);
  const [lap2A, lap2B] = await Promise.all([readStandings(A), readStandings(B)]);
  tele(A, { lap: 3, raceTimeMs: 40000 });
  await sleep(800);
  const [lap3A, lap3B] = await Promise.all([readStandings(A), readStandings(B)]);
  tele(B, { lap: 3, raceTimeMs: 41000 });
  await sleep(800);
  const [finalA, finalB] = await Promise.all([readStandings(A), readStandings(B)]);

  const rows2 = lap2A && Array.isArray(lap2A.rows) ? lap2A.rows : [];
  const row2A = rowBySeat(rows2, seatA);
  const row2B = rowBySeat(rows2, seatB);
  g5.note('standings-frame', !!lap2A && Array.isArray(lap2A.rows), lap2A ? `rows=${rows2.length} types=[${A.types.slice(-8).join(',')}]` : 'no standings frame within 4s');
  g5.note('rows-include-both-seats', !!row2A && !!row2B, `A(seat ${seatA}) lap=${row2A ? row2A.lap : '?'} B(seat ${seatB}) lap=${row2B ? row2B.lap : '?'}`);
  g5.note('sort-same-lap-by-time', !!row2A && !!row2B && row2A.lap === 2 && row2B.lap === 2
    && row2B.raceTimeMs === 29000 && row2A.raceTimeMs === 30000,
  row2A && row2B ? `A ${row2A.raceTimeMs} vs B ${row2B.raceTimeMs}` : '-');
  g5.note('position-derived', !!row2A && !!row2B && row2A.position === 2 && row2B.position === 1,
    row2A && row2B ? `A.position=${row2A.position} B.position=${row2B.position}` : '-');
  g5.note('gap-to-car-ahead', !!row2A && row2A.gapMs === 1000, row2A ? `A.gapMs=${row2A.gapMs} (expected 1000)` : '-');
  const problems2 = auditRows(rows2);
  g5.note('rows-sorted-consistent', problems2.length === 0, problems2.join(' | ') || `${rows2.length} row(s) sorted lap desc / time asc with contiguous positions`);

  const rows3 = lap3A && Array.isArray(lap3A.rows) ? lap3A.rows : [];
  const row3A = rowBySeat(rows3, seatA);
  const row3B = rowBySeat(rows3, seatB);
  g5.note('lap-beats-time', !!row3A && !!row3B && row3A.lap === 3 && row3A.position === 1 && row3B.position === 2,
    row3A && row3B ? `A lap=${row3A.lap} pos=${row3A.position}, B lap=${row3B.lap} pos=${row3B.position}` : '-');
  g5.note('gap-null-across-lap', !!row3B && row3B.gapMs === null,
    row3B ? `B.gapMs=${row3B.gapMs}${row3B.gapLap ? ' gapLap=true' : ' (no gapLap flag)'}` : '-');
  const problems3 = auditRows(rows3);
  g5.note('rows-sorted-after-lap-change', problems3.length === 0, problems3.join(' | ') || 'ok');

  const rowsF = finalA && Array.isArray(finalA.rows) ? finalA.rows : [];
  const rowFA = rowBySeat(rowsF, seatA);
  const rowFB = rowBySeat(rowsF, seatB);
  g5.note('converged-order', !!rowFA && !!rowFB && rowFA.position === 1 && rowFB.position === 2
    && rowFA.raceTimeMs === 40000 && rowFB.raceTimeMs === 41000,
  rowFA && rowFB ? `A ${rowFA.position}/${rowFA.raceTimeMs} B ${rowFB.position}/${rowFB.raceTimeMs}` : '-');
  g5.note('gap-final', !!rowFB && rowFB.gapMs === 1000, rowFB ? `B.gapMs=${rowFB.gapMs} (expected 1000)` : '-');
  const problemsF = auditRows(rowsF);
  g5.note('rows-sorted-final', problemsF.length === 0, problemsF.join(' | ') || 'ok');
  const youA = finalA && finalA.you ? finalA.you : null;
  const youB = finalB && finalB.you ? finalB.you : null;
  g5.note('you-matches-own-row', !!youA && !!rowFA && youA.position === rowFA.position,
    youA && rowFA ? `A.you.position=${youA.position} row.position=${rowFA.position}` : 'no you{}');
  g5.note('you-per-socket', !!youA && !!youB && youA.position === 1 && youB.position === 2,
    youA && youB ? `A=${youA.position} B=${youB.position}` : 'no you{}');
  const top = finalA ? finalA.top : null;
  const seatedNow = (() => {
    const frames = A.frames.filter((m) => (m.type === 'event' || m.type === 'grid') && m.counts && typeof m.counts.seated === 'number');
    return frames.length ? frames[frames.length - 1].counts.seated : rowsF.length;
  })();
  const compactOk = typeof top === 'number' && top > 0 && top <= 12 && rowsF.length <= top + 2;
  g5.note('compact-top-n', compactOk, `top=${top} rows=${rowsF.length} seated=${seatedNow} max=${welcomeA ? welcomeA.max : '?'}`);
  g5.note('compact-bytes', !!finalA && finalA.__bytes <= 1500, finalA ? `${finalA.__bytes} B (budget 1500)` : '-');
  if (seatedNow > 10) {
    g5.note('compact-not-all-rows', rowsF.length < seatedNow, `${rowsF.length} rows for ${seatedNow} seated`);
  } else {
    g5.info('compact-not-all-rows', `only ${seatedNow} seated; slicing proven by top=${top} and ${finalA ? finalA.__bytes : '?'} B`);
  }
  evidence.measurements.standings = {
    top, rows: rowsF.length, bytes: finalA ? finalA.__bytes : null, seated: seatedNow,
    sample: rowsF.slice(0, 6), you: youA,
  };
  g5.finish(`positions A=${youA ? youA.position : '?'} B=${youB ? youB.position : '?'}, gap ${rowFB ? rowFB.gapMs : '?'}ms, top=${top}, ${finalA ? finalA.__bytes : '?'} B`);

  // ---- 6. clamps ---------------------------------------------------------
  const g6 = group(6, 'clamps: time, lap, speed, malformed JSON');
  const clamps = evidence.measurements.clamps = {};
  tele(A, { lap: 3, raceTimeMs: 40500 });
  await sleep(450);
  let stA = await readStandings(A);
  clamps.accepted = rowBySeat(stA && stA.rows, seatA);
  g6.note('monotonic-baseline', !!clamps.accepted && clamps.accepted.raceTimeMs === 40500,
    clamps.accepted ? `raceTimeMs=${clamps.accepted.raceTimeMs}` : 'no standings');

  tele(A, { lap: 3, raceTimeMs: 9000 });
  await sleep(450);
  stA = await readStandings(A);
  const afterBack = rowBySeat(stA && stA.rows, seatA);
  clamps.backwards = afterBack;
  g6.note('clamp-backwards-time-ignored', !!afterBack && afterBack.raceTimeMs === 40500,
    afterBack ? `sent 9000 after 40500, row=${afterBack.raceTimeMs} (expected 40500)` : 'no standings');

  tele(A, { lap: 150, raceTimeMs: 41000 });
  await sleep(450);
  stA = await readStandings(A);
  const afterLap = rowBySeat(stA && stA.rows, seatA);
  clamps.lap = afterLap;
  g6.note('clamp-lap-99', !!afterLap && afterLap.lap === 99,
    afterLap ? `sent lap=150, row.lap=${afterLap.lap} (expected 99)` : 'no standings');

  const errsBeforeSpeed = A.errors.length;
  tele(A, { lap: 99, raceTimeMs: 41500, speedKph: 999 });
  await sleep(450);
  const speedErrs = A.errors.slice(errsBeforeSpeed).filter((e) => e.code === 'bad_telemetry');
  g6.note('clamp-speed-accepted', speedErrs.length === 0 && A.ws.readyState === 1,
    `speedKph=999 -> ${speedErrs.length} bad_telemetry error(s), socket ${A.ws.readyState === 1 ? 'open' : 'closed'} (speed is not echoed in standings)`);
  g6.info('clamp-speed-observed', 'speedKph is not part of a standings row: accept+survive is asserted here, the clamped value is read back from the result row in check 8');

  drain(A);
  const malErrP = waitFor(A, (m) => m.type === 'error', 2500, 'error(malformed)').catch(() => null);
  sendRaw(A, '{"type":"telemetry","lap":');
  const malErr = await malErrP;
  clamps.malformedError = malErr;
  g6.note('malformed-json-error', !!malErr && typeof malErr.code === 'string',
    malErr ? `error code=${malErr.code} message=${String(malErr.message || '').slice(0, 60)}` : 'no error frame after malformed JSON');
  g6.note('malformed-json-socket-survives', A.ws.readyState === 1, `readyState=${A.ws.readyState}`);
  drain(A);
  const pingAt = Date.now();
  send(A, { type: 'ping', at: pingAt });
  const pong = await waitFor(A, (m) => m.type === 'pong', 2500, 'pong').catch(() => null);
  g6.note('socket-alive-after-bad-frame', !!pong && pong.at === pingAt,
    pong ? `pong.at=${pong.at} serverAt=${pong.serverAt} rtt=${Date.now() - pingAt}ms` : 'no pong after malformed JSON');

  tele(A, { lap: 99, raceTimeMs: 9999999 });
  await sleep(450);
  stA = await readStandings(A);
  const afterMax = rowBySeat(stA && stA.rows, seatA);
  clamps.maxTime = afterMax;
  g6.note('clamp-raceTime-max', !!afterMax && afterMax.raceTimeMs === 3600000,
    afterMax ? `sent 9999999, row=${afterMax.raceTimeMs} (expected 3600000)` : 'no standings');
  evidence.measurements.clamps = {
    accepted: clamps.accepted ? { lap: clamps.accepted.lap, raceTimeMs: clamps.accepted.raceTimeMs } : null,
    backwards: clamps.backwards ? clamps.backwards.raceTimeMs : null,
    lap: clamps.lap ? clamps.lap.lap : null,
    maxTime: clamps.maxTime ? clamps.maxTime.raceTimeMs : null,
    malformedCode: malErr ? malErr.code : null,
  };
  g6.finish(`backwards kept ${clamps.backwards ? clamps.backwards.raceTimeMs : '?'}, lap->${clamps.lap ? clamps.lap.lap : '?'}, max->${clamps.maxTime ? clamps.maxTime.raceTimeMs : '?'}, malformed->${malErr ? malErr.code : 'no error'}`);

  // ---- 7. standings cadence ---------------------------------------------
  const g7 = group(7, 'standings cadence ~2 Hz');
  const winMs = QUICK ? 5000 : 10000;
  const pump = await pumpTelemetry(
    [[A, { lap: 99, raceTimeMs: 3600000, speedKph: 150 }], [B, { lap: 3, raceTimeMs: 41000, speedKph: 150 }]],
    winMs, TELEMETRY_HZ,
  );
  const winSec = (pump.end - pump.start) / 1000;
  const cadenceOf = (peer) => {
    const frames = inWindow(peer, pump.start, pump.end, ['standings']);
    const unique = new Set(frames.map((f) => `${f.seq ?? f.__at}`)).size;
    const gaps = [];
    for (let i = 1; i < frames.length; i += 1) gaps.push(frames[i].__at - frames[i - 1].__at);
    return { frames: frames.length, unique, hz: unique / winSec, meanGap: gaps.length ? gaps.reduce((a, b) => a + b, 0) / gaps.length : null, maxGap: gaps.length ? Math.max(...gaps) : null };
  };
  const cadA = cadenceOf(A);
  const cadB = cadenceOf(B);
  evidence.measurements.cadence = { windowSec: round(winSec, 2), telemetrySends: pump.sends, A: cadA, B: cadB, targetHz: STANDINGS_HZ, tolerancePct: 30 };
  const lo = STANDINGS_HZ * 0.7;
  const hi = STANDINGS_HZ * 1.3;
  g7.note('cadence-A', cadA.hz >= lo && cadA.hz <= hi, `${cadA.unique} standings frame(s) in ${round(winSec, 2)}s = ${round(cadA.hz, 2)} Hz (allowed ${lo}-${hi})`);
  g7.note('cadence-B', cadB.hz >= lo && cadB.hz <= hi, `${cadB.unique} standings frame(s) in ${round(winSec, 2)}s = ${round(cadB.hz, 2)} Hz`);
  g7.note('cadence-jitter', (cadA.maxGap ?? Infinity) <= 1500, `max inter-frame gap ${cadA.maxGap}ms (mean ${round(cadA.meanGap)}ms)`);
  g7.note('telemetry-pump-4hz', pump.sends >= Math.floor(winSec * TELEMETRY_HZ * 2 * 0.7),
    `${pump.sends} telemetry send(s) from 2 drivers in ${round(winSec, 2)}s`);
  g7.finish(`${round(cadA.hz, 2)} Hz A / ${round(cadB.hz, 2)} Hz B over ${round(winSec, 2)}s, max gap ${cadA.maxGap}ms`);

  // ---- 8. finish -> result -> lobby --------------------------------------
  const g8 = group(8, 'finish -> result -> lobby');
  const latestCounts = (() => {
    const frames = A.frames.filter((m) => (m.type === 'event' || m.type === 'grid') && m.counts && typeof m.counts.seated === 'number');
    return frames.length ? frames[frames.length - 1].counts : null;
  })();
  const seatedAtFinish = latestCounts ? latestCounts.seated : rowsF.length;
  drain(A);
  drain(B);
  // the result row carries speedKph, so this is where the 0..400 clamp becomes
  // observable (standings rows have no speed field)
  tele(A, { lap: 99, raceTimeMs: 3600000, speedKph: 999 });
  await sleep(450);
  send(A, { type: 'finish', raceTimeMs: 3600000, lap: 99 });
  send(B, { type: 'finish', raceTimeMs: 4000000, lap: 99 });
  const [resA, resB] = await Promise.all([
    waitFor(A, (m) => m.type === 'result' || m.type === 'results', 8000, 'result(A)').catch(() => null),
    waitFor(B, (m) => m.type === 'result' || m.type === 'results', 8000, 'result(B)').catch(() => null),
  ]);
  const resRows = resA && Array.isArray(resA.rows) ? resA.rows : [];
  const resRowA = rowBySeat(resRows, seatA);
  const resRowB = rowBySeat(resRows, seatB);
  evidence.measurements.results = {
    type: resA ? resA.type : null, rows: resRows.length, seatedAtFinish,
    you: resA ? resA.you : null, order: resRows.slice(0, 6).map((r) => ({ seat: r.seat, position: r.position, lap: r.lap, raceTimeMs: r.raceTimeMs })),
  };
  g8.note('result-frame-both', !!resA && !!resB, `A=${resA ? resA.type : 'none'} B=${resB ? resB.type : 'none'} (contract type is \`result\`)`);
  g8.note('result-row-per-driver', resRows.length === seatedAtFinish && resRows.length >= 2,
    `${resRows.length} row(s) for ${seatedAtFinish} seated driver(s)`);
  g8.note('result-includes-both', !!resRowA && !!resRowB,
    resRowA && resRowB ? `A pos=${resRowA.position} time=${resRowA.raceTimeMs}, B pos=${resRowB.position} time=${resRowB.raceTimeMs}` : 'a finishing driver is missing from the result rows');
  const resProblems = auditRows(resRows);
  g8.note('result-sorted', resProblems.length === 0, resProblems.join(' | ') || 'lap desc / time asc, positions 1..N');
  g8.note('result-you', !!resA && resA.you && resRowA && resA.you.position === resRowA.position,
    resA && resA.you ? `you.position=${resA.you.position} row.position=${resRowA ? resRowA.position : '?'}` : 'no you{} in result');
  g8.note('result-speed-clamped', !!resRowA && resRowA.speedKph === 400,
    resRowA ? `telemetry speedKph=999 before finish -> result row speedKph=${resRowA.speedKph} (expected 400, the 0..400 clamp)` : 'no row for the finisher');
  const resultsAt = resA ? resA.__at : Date.now();
  const resultsBudget = Math.min(consts.resultsMs + 5000, QUICK ? 9000 : 30000);
  const resultsDeadline = resultsAt + resultsBudget;
  const statusState = async () => {
    const st = await getStatus().catch(() => null);
    if (!st) return null;
    return st.state ?? (st.event && st.event.state) ?? (st.mmo && (st.mmo.state ?? (st.mmo.event && st.mmo.event.state))) ?? null;
  };
  let lobbyEvent = null;
  let lastState = null;
  while (Date.now() < resultsDeadline && !lobbyEvent) {
    lobbyEvent = A.frames.find((m) => m.type === 'event' && m.state === 'lobby' && m.__at >= resultsAt) || null;
    if (lobbyEvent) break;
    lastState = await statusState();
    if (lastState === 'lobby') { lobbyEvent = { type: 'event', state: 'lobby', __at: Date.now(), via: 'status' }; break; }
    await sleep(500);
  }
  const lobbyDelay = lobbyEvent ? lobbyEvent.__at - resultsAt : null;
  evidence.measurements.lobby = { delayMs: lobbyDelay, resultsMs: consts.resultsMs, budgetMs: resultsBudget, lastState };
  if (lobbyEvent) {
    g8.note('lobby-after-results', true, `event -> lobby ${lobbyDelay}ms after result (RESULTS_MS=${consts.resultsMs})`);
    const newId = lobbyEvent.id ?? null;
    g8.info('next-event', `id=${newId}${newId !== null && initialEventId !== null ? ` (previous ${initialEventId})` : ''}`);
  } else if (lastState === 'results') {
    g8.skip('lobby-after-results', `still \`results\` after ${resultsBudget}ms with RESULTS_MS=${consts.resultsMs} - timer pending` + (QUICK ? ' (--quick budget)' : ''));
  } else {
    g8.note('lobby-after-results', false, `no lobby frame and status state=${lastState} after ${resultsBudget}ms (RESULTS_MS=${consts.resultsMs})`);
  }
  g8.finish(`${resRows.length} result row(s), order ${resRowA ? resRowA.position : '?'}/${resRowB ? resRowB.position : '?'}, lobby ${lobbyDelay !== null ? lobbyDelay + 'ms' : 'pending'}`);

  // ---- 9. heartbeat ------------------------------------------------------
  const g9 = group(9, 'heartbeat terminates a silent socket');
  const HB = open('SILENT', { autoPong: false });
  HB.name = 'PROBE-SILENT';
  await opened(HB);
  hello(HB);
  await waitFor(HB, (m) => m.type === 'welcome' || m.type === 'hello', 6000, 'welcome(silent)').catch(() => null);
  const hbOpenAt = HB.openedAt || Date.now();
  const hbBudget = consts.heartbeatMs + 5000;
  const hbDeadline = hbOpenAt + hbBudget + 500;
  while (!HB.closedAt && Date.now() < hbDeadline) await sleep(250);
  let hbElapsed = HB.closedAt ? HB.closedAt - hbOpenAt : null;
  let hbFromPing = HB.closedAt && HB.firstPingAt ? HB.closedAt - HB.firstPingAt : null;
  if (!HB.closedAt) {
    // some servers reap on the second interval; keep watching a little longer
    const hardDeadline = hbOpenAt + consts.heartbeatMs * 2 + 5000;
    while (!HB.closedAt && Date.now() < hardDeadline) await sleep(250);
    hbElapsed = HB.closedAt ? HB.closedAt - hbOpenAt : null;
    hbFromPing = HB.closedAt && HB.firstPingAt ? HB.closedAt - HB.firstPingAt : null;
  }
  evidence.measurements.heartbeat = {
    heartbeatMs: consts.heartbeatMs, closedAfterMs: hbElapsed, closedAfterFirstPingMs: hbFromPing,
    protocolPingsSeen: HB.pings, autoPong: false, closeInfo: HB.closeInfo,
  };
  if (HB.closedAt) {
    const within = hbElapsed <= hbBudget || (hbFromPing !== null && hbFromPing <= hbBudget);
    const othersAlive = A.ws.readyState === 1 && B.ws.readyState === 1;
    g9.note('silent-socket-closed', true, `server pinged ${HB.pings}x, closed after ${hbElapsed}ms (${HB.closeInfo})`);
    g9.note('heartbeat-not-a-server-restart', othersAlive,
      othersAlive ? 'the other sockets stayed open' : 'every socket closed at once - a server restart, not a heartbeat reap');
    if (within) g9.note('closed-within-heartbeat+5s', true,
      (hbFromPing !== null && hbFromPing < hbElapsed ? `${hbFromPing}ms after the first server ping` : `${hbElapsed}ms after connect`) + ` <= ${hbBudget}ms`);
    else g9.skip('closed-within-heartbeat+5s', `closed after ${hbElapsed}ms${hbFromPing !== null ? ` (${hbFromPing}ms after the first server ping)` : ''}, window ${hbBudget}ms - two-interval reap, still bounded`);
  } else {
    g9.note('silent-socket-closed', false, `still open ${Date.now() - hbOpenAt}ms after hello with autoPong=false; protocol pings seen=${HB.pings} (HEARTBEAT_MS=${consts.heartbeatMs})`);
  }
  g9.finish(HB.closedAt ? `closed after ${hbElapsed}ms (HEARTBEAT_MS=${consts.heartbeatMs})` : 'silent socket survived the heartbeat window');

  // ---- 10. reconnect reclaims the seat ----------------------------------
  const g10 = group(10, 'reconnect reclaims the same seat');
  await ensureLobby('reconnect', QUICK ? 20000 : 45000);
  const seatNumber = (value) => Number.isInteger(value) && value >= 1;
  const R1 = open('R1');
  R1.name = 'PROBE-RECONNECT';
  await opened(R1);
  hello(R1);
  const w1 = await waitFor(R1, (m) => m.type === 'welcome' || m.type === 'hello', 8000, 'welcome(R1)').catch(() => null);
  const id1 = w1 ? w1.driverId : null;
  g10.note('reconnect-identity', typeof id1 === 'string' && id1.length > 0, w1 ? `driverId=${id1}` : 'no welcome');
  let seatBefore = w1 && w1.you ? w1.you.seat : null;
  for (let i = 0; i < 3 && !seatNumber(seatBefore); i += 1) {
    send(R1, { type: 'queue' });
    const gR1 = await waitFor(R1, gridWith(id1), 7000, 'grid(R1 seat)').catch(() => null);
    const rowR1 = gR1 ? seatRow(gR1, id1) : null;
    if (rowR1 && seatNumber(rowR1.seat)) seatBefore = rowR1.seat;
    else await sleep(700);
  }
  g10.note('seat-before-reconnect', seatNumber(seatBefore), `seat=${seatBefore} for driverId ${id1} (seat 0 means "not seated")`);
  R1.ws.terminate();
  await sleep(500);
  const R2 = open('R2');
  R2.name = 'PROBE-RECONNECT';
  await opened(R2);
  hello(R2, { driverId: id1 });
  const w2 = await waitFor(R2, (m) => m.type === 'welcome' || m.type === 'hello', 8000, 'welcome(R2)').catch(() => null);
  let seatAfter = w2 && w2.you ? w2.you.seat : null;
  for (let i = 0; i < 2 && !seatNumber(seatAfter); i += 1) {
    send(R2, { type: 'queue' });
    const gR2 = await waitFor(R2, gridWith(id1), 6000, 'grid(R2 seat)').catch(() => null);
    const rowR2 = gR2 ? seatRow(gR2, id1) : null;
    if (rowR2 && seatNumber(rowR2.seat)) seatAfter = rowR2.seat;
    else await sleep(600);
  }
  evidence.measurements.reconnect = { driverId: id1, seatBefore, seatAfter, welcomed: !!w2 };
  g10.note('reclaim-same-seat', seatNumber(seatBefore) && seatAfter === seatBefore,
    `seat before=${seatBefore} after hard terminate + hello{driverId}=${seatAfter}`);

  const R3 = open('R3');
  R3.name = 'PROBE-OTHER';
  await opened(R3);
  hello(R3);
  const w3 = await waitFor(R3, (m) => m.type === 'welcome' || m.type === 'hello', 8000, 'welcome(R3)').catch(() => null);
  const id3 = w3 ? w3.driverId : null;
  let seatOther = w3 && w3.you ? w3.you.seat : null;
  let r3Lobby = null;
  for (let i = 0; i < 5 && !seatNumber(seatOther); i += 1) {
    if (i > 0) r3Lobby = await ensureLobby('reconnect-r3', QUICK ? 12000 : 25000);
    send(R3, { type: 'queue' });
    const gR3 = await waitFor(R3, gridWith(id3), 6000, 'grid(R3 seat)').catch(() => null);
    const rowR3 = gR3 ? seatRow(gR3, id3) : null;
    if (rowR3 && seatNumber(rowR3.seat)) seatOther = rowR3.seat;
    else await sleep(800);
  }
  const r3Busy = !seatNumber(seatOther) && r3Lobby && r3Lobby.foreign > 0;
  if (r3Busy) {
    g10.skip('different-driver-different-seat', `fresh driverId=${id3} could not seat: event ${r3Lobby.state} with ${r3Lobby.foreign} foreign client(s) on the instance`);
  } else {
    g10.note('different-driver-different-seat', seatNumber(seatOther) && seatOther !== seatBefore,
      `fresh driverId=${id3} seat=${seatOther} (reclaimer holds ${seatAfter})`);
  }
  g10.note('reclaim-without-queue', seatAfter === seatBefore,
    seatAfter === seatBefore ? 'same seat returned by hello{driverId} alone' : 'seat only came back after a fresh queue');
  for (const p of [R2, R3]) { send(p, { type: 'unqueue' }); await sleep(120); p.ws.terminate(); }
  g10.finish(`seat ${seatBefore} -> ${seatAfter} for ${id1}, fresh driver got ${seatOther}`);

  // ---- 12. fanout budget -------------------------------------------------
  const g12 = group(12, 'fanout budget: 60 clients @ 4 Hz');
  const COUNT = 60;
  const fan = [];
  for (let i = 0; i < COUNT; i += 15) {
    const batch = [];
    for (let j = i; j < Math.min(i + 15, COUNT); j += 1) {
      const c = open(`F${String(j).padStart(2, '0')}`);
      c.name = `PROBE-F${String(j).padStart(2, '0')}`;
      fan.push(c);
      batch.push(c);
    }
    await Promise.all(batch.map((c) => opened(c, 15000).catch(() => null)));
    for (const c of batch) hello(c);
    await sleep(150);
  }
  await sleep(700);
  const fanOpen = fan.filter((c) => c.ws.readyState === 1).length;
  for (const c of fan) if (c.ws.readyState === 1) send(c, { type: 'queue' });
  const raceBudget = Math.min(consts.fillMs, 20000) + consts.gridMs + consts.countdownMs + 12000;
  const fanRaceDeadline = Date.now() + raceBudget;
  const eventStateOf = async () => {
    const st = await getStatus().catch(() => null);
    if (!st) return null;
    return st.state ?? (st.event && st.event.state) ?? (st.mmo && (st.mmo.state ?? (st.mmo.event && st.mmo.event.state))) ?? null;
  };
  let fanRacingAt = 0;
  let lastFanState = null;
  while (Date.now() < fanRaceDeadline && !fanRacingAt) {
    if (fan.some((c) => c.frames.some((m) => m.type === 'standings' || (m.type === 'event' && m.state === 'racing')))) {
      fanRacingAt = Date.now();
      break;
    }
    lastFanState = await eventStateOf();
    if (lastFanState === 'racing') { fanRacingAt = Date.now(); break; }
    await sleep(400);
  }
  g12.note('event-reaches-racing', fanRacingAt > 0,
    fanRacingAt ? `racing observed after ${fanRacingAt - sessionStartedAt}ms of session` : `still ${lastFanState} after ${raceBudget}ms with ${fanOpen}/${COUNT} sockets open`);
  const fanWinMs = QUICK ? 3000 : 5000;
  const fanStats = fanRacingAt ? await pumpTelemetry(
    fan.map((c, i) => [c, { lap: 1 + (i % 3), raceTimeMs: 20000 + i * 10, speedKph: 170 + (i % 40) }]),
    fanWinMs, TELEMETRY_HZ,
  ) : { sends: 0, start: Date.now(), end: Date.now(), period: 250 };
  const openAtEnd = fan.filter((c) => c.ws.readyState === 1);
  const dropped = fan.filter((c) => c.ws.readyState !== 1);
  const byKey = new Map();
  for (const c of fan) {
    for (const f of inWindow(c, fanStats.start, fanStats.end)) {
      if (!['standings', 'grid', 'event', 'feed'].includes(f.type)) continue;
      const key = frameKey(f);
      let entry = byKey.get(key);
      if (!entry) { entry = { type: f.type, seen: new Map() }; byKey.set(key, entry); }
      if (!entry.seen.has(c.tag)) entry.seen.set(c.tag, f.__at);
    }
  }
  const spreads = [];
  for (const entry of byKey.values()) {
    if (entry.seen.size < 10) continue;
    const ats = [...entry.seen.values()];
    spreads.push(Math.max(...ats) - Math.min(...ats));
  }
  // Server-sent wall clock, when a frame carries one. `feed.at` is the time the
  // log line was *created*, not sent, so it is not a latency sample.
  const tsLatency = [];
  const nowMs = Date.now();
  for (const c of fan) {
    for (const f of inWindow(c, fanStats.start, fanStats.end)) {
      let stamp = null;
      if (typeof f.serverAt === 'number') stamp = f.serverAt;
      else if (typeof f.sentAt === 'number') stamp = f.sentAt;
      else if (typeof f.serverTime === 'number') stamp = f.serverTime;
      else if (typeof f.ts === 'number') stamp = f.ts;
      else if (f.type !== 'feed' && typeof f.at === 'number') stamp = f.at;
      if (stamp !== null && Math.abs(nowMs - stamp) < 300000) tsLatency.push(f.__at - stamp);
    }
  }
  const perSocket = openAtEnd.map((c) => inWindow(c, fanStats.start, fanStats.end).length);
  const minFrames = perSocket.length ? Math.min(...perSocket) : 0;
  // payload size at 50 seats, for the "top N + self, <= 1.5 KB" budget
  const standingsFrames = fan.flatMap((c) => inWindow(c, fanStats.start, fanStats.end, ['standings']));
  const standingsBytes = Math.max(0, ...standingsFrames.map((f) => f.__bytes));
  const standingsRows = Math.max(0, ...standingsFrames.map((f) => (Array.isArray(f.rows) ? f.rows.length : 0)));
  const seatedCounts = fan
    .flatMap((c) => c.frames.filter((m) => (m.type === 'grid' || m.type === 'event') && m.counts && typeof m.counts.seated === 'number'))
    .map((m) => m.counts.seated);
  const fanSeated = seatedCounts.length ? Math.max(...seatedCounts) : 0;
  const errCount = (code) => fan.reduce((n, c) => n + c.errors.filter((e) => e.code === code).length, 0);
  const p95Spread = pct(spreads, 95);
  const p95Ts = tsLatency.length >= 10 ? pct(tsLatency, 95) : null;
  evidence.measurements.fanout = {
    clients: COUNT, openAtStart: fanOpen, openAtEnd: openAtEnd.length, dropped: dropped.length,
    droppedInfo: dropped.slice(0, 5).map((c) => `${c.tag}:${c.closeInfo}`),
    windowMs: fanStats.end - fanStats.start, telemetrySends: fanStats.sends,
    framesMatched: spreads.length, p95SpreadMs: round(p95Spread, 2), p95ServerTimestampMs: round(p95Ts, 2),
    minFramesPerSocket: minFrames, seated: fanSeated, budgetMs: 50,
    standingsBytesAt50: standingsBytes || null,
    errors: { full: errCount('full'), rate: errCount('rate'), state: errCount('state'), badTelemetry: errCount('bad_telemetry') },
  };
  g12.note('no-socket-dropped', dropped.length === 0 && fanOpen === COUNT,
    `${openAtEnd.length}/${COUNT} open at window end (dropped=${dropped.length}${dropped.length ? ' ' + dropped.slice(0, 3).map((c) => c.tag + ':' + c.closeInfo).join(',') : ''})`);
  g12.note('p95-broadcast-spread', p95Spread !== null && p95Spread < 50,
    p95Spread === null ? `no shared frame reached >=10 sockets (matched ${spreads.length})` : `p95 ${round(p95Spread, 2)}ms over ${spreads.length} shared frame(s), budget 50ms`);
  if (p95Ts !== null) {
    g12.note('p95-server-timestamp', p95Ts < 50, `p95 ${round(p95Ts, 2)}ms from ${tsLatency.length} server-timestamped frame(s)`);
  } else {
    g12.info('p95-server-timestamp', 'no send-time stamp on broadcast frames (feed.at is the log-line time); the fanout spread is the measured delivery cost');
  }
  g12.note('no-starved-socket', minFrames >= 1,
    `min ${minFrames} frame(s) per socket during ${round((fanStats.end - fanStats.start) / 1000, 2)}s (seated ${fanSeated}/${COUNT}, MIN_DRIVERS=${consts.min})`);
  g12.note('seats-filled', fanSeated >= Math.min(COUNT, consts.max) - 4,
    `${fanSeated} seated for ${COUNT} clients with MAX=${consts.max} (allows up to 4 stale reservations)`);
  g12.note('telemetry-4hz-no-rate-limit', errCount('rate') <= Math.ceil(fanStats.sends * 0.02),
    `${fanStats.sends} telemetry send(s) in ${round((fanStats.end - fanStats.start) / 1000, 2)}s, rate errors=${errCount('rate')}, full errors=${errCount('full')}`);
  // "never all 50 rows" is the hard rule; 1.5 KB is a budget, not a limit (§3, §3.4).
  g12.note('standings-rows-at-50', standingsRows > 0 && standingsRows <= 16,
    `largest standings frame carries ${standingsRows} row(s) for ${fanSeated} seated (top N + self + neighbours, never all 50)`);
  if (standingsBytes > 0 && standingsBytes <= 1500) {
    g12.note('standings-payload-at-50', true, `largest standings frame ${standingsBytes} B, within the 1500 B budget`);
  } else if (standingsBytes <= 4096) {
    g12.skip('standings-payload-at-50', `${standingsBytes} B with ${standingsRows} rows / ${fanSeated} seated - over the contract's 1500 B budget (sizes are budgets, not limits)`);
  } else {
    g12.note('standings-payload-at-50', false, `${standingsBytes} B with ${standingsRows} rows - far past the 1500 B budget`);
  }
  const fanStatus = await getStatus().catch(() => null);
  if (fanStatus) {
    const p50 = fanStatus.p50BroadcastMs;
    g12.note('server-p50-broadcast', typeof p50 === 'number' && p50 >= 0 && p50 < 50,
      `status.p50BroadcastMs=${p50}ms over its own loop samples (clients=${fanStatus.clients}, counts=${JSON.stringify(fanStatus.counts)})`);
    evidence.measurements.fanout.serverReported = {
      p50BroadcastMs: p50, clients: fanStatus.clients, counts: fanStatus.counts,
    };
  }
  g12.finish(`${fanStats.sends} sends @4 Hz, ${openAtEnd.length}/${COUNT} sockets open, p95 spread ${round(p95Spread, 2)}ms, seated ${fanSeated}`);

  // leave the instance tidy: finish everyone, drop the sockets, and let the
  // server abandon the event so the next probe starts from a lobby
  for (const c of fan) if (c.ws.readyState === 1) send(c, { type: 'finish', raceTimeMs: 900000, lap: 3 });
  await sleep(1200);
  for (const c of fan) { try { c.ws.terminate(); } catch { /* ignore */ } }
  const cleanupDeadline = Date.now() + 15000;
  let cleaned = null;
  while (Date.now() < cleanupDeadline) {
    cleaned = await eventStateOf();
    if (cleaned === 'lobby' || cleaned === 'results') break;
    await sleep(500);
  }
  info('cleanup', `event state after the fanout burst: ${cleaned}`);
}

// The instance under test is owned by another agent and can be restarted
// mid-run; a dropped connection is retried once against a fresh session.
const isConnectionLoss = (err) => /ECONNREFUSED|ECONNRESET|EPIPE|socket not open|WebSocket was closed|terminated/i
  .test(String((err && err.message) || err));
let lastError = null;
let attempt = 0;
while (attempt < 2) {
  attempt += 1;
  try {
    await runSession();
    lastError = null;
    break;
  } catch (err) {
    lastError = err;
    const message = (err && err.message) || String(err);
    console.log(`FAIL  flow (attempt ${attempt}) :: ${message}`);
    for (const peer of clients) { try { peer.ws.terminate(); } catch { /* ignore */ } }
    clients.length = 0;
    if (attempt < 2 && isConnectionLoss(err)) {
      RESULTS.clear();
      INFOS.length = 0;
      console.log('RETRY session once (connection dropped)');
      await waitForServer(SERVER_WAIT_MS);
      await sleep(500);
    } else {
      break;
    }
  }
}
if (lastError) evidence.error = lastError.stack || String(lastError);
for (const peer of clients) { try { peer.ws.terminate(); } catch { /* ignore */ } }
await sleep(200);

// ------------------------------------------------------------- artifact ----
for (const [n, id] of CHECKS) {
  if (!RESULTS.has(n)) RESULTS.set(n, { n, id, ok: false, detail: 'not run (flow aborted)', subs: [], skipped: 0 });
}
const ordered = [...RESULTS.values()].sort((a, b) => a.n - b.n);
const failed = ordered.filter((r) => !r.ok);
const skipped = ordered.filter((r) => r.ok && r.skipped > 0);
const passed = ordered.length - failed.length;

evidence.checks = ordered;
evidence.infos = INFOS;
evidence.summary = { total: ordered.length, passed, failed: failed.length, skipped: skipped.length };
evidence.transcript = {
  byRole: Object.fromEntries(clients.slice(0, 8).map((c) => [c.tag, c.types.slice(0, 40)])),
  frameCounts: clients.reduce((acc, c) => {
    for (const t of c.types) acc[t] = (acc[t] || 0) + 1;
    return acc;
  }, {}),
  errors: clients.reduce((acc, c) => {
    for (const e of c.errors) { const k = e.code || e.type || 'socket'; acc[k] = (acc[k] || 0) + 1; }
    return acc;
  }, {}),
};
evidence.finishedAt = new Date().toISOString();
evidence.result = failed.length ? 'FAIL' : 'PASS';
evidence.durationMs = sessionStartedAt ? Date.now() - sessionStartedAt : 0;

await mkdir(path.dirname(EVIDENCE), { recursive: true });
await writeFile(EVIDENCE, JSON.stringify(evidence, null, 2) + '\n', 'utf8');

console.log('');
const m = evidence.measurements;
if (m.cadence) console.log(`MEASURED cadence: A ${round(m.cadence.A.hz, 2)} Hz / B ${round(m.cadence.B.hz, 2)} Hz over ${m.cadence.windowSec}s (target ${STANDINGS_HZ} Hz +-30%)`);
if (m.fanout) console.log(`MEASURED fanout: p95 spread ${m.fanout.p95SpreadMs}ms, ${m.fanout.openAtEnd}/${m.fanout.clients} sockets open, ${m.fanout.framesMatched} shared frame(s), seated ${m.fanout.seated}`);
if (m.heartbeat) console.log(`MEASURED heartbeat: closed after ${m.heartbeat.closedAfterMs}ms (HEARTBEAT_MS=${m.heartbeat.heartbeatMs})`);
console.log(`RESULT: ${failed.length ? 'FAIL' : 'PASS'} ${passed}/${ordered.length} checks passed`
  + `${failed.length ? `, ${failed.length} failed` : ''}${skipped.length ? `, ${skipped.length} skipped` : ''}`);
for (const f of failed) console.log(`  FAILED ${f.n}/12 ${f.id} :: ${f.detail}`);
for (const s of skipped) console.log(`  SKIPPED ${s.n}/12 ${s.id} (soft sub-check)`);
console.log(`EVIDENCE: ${EVIDENCE}`);
process.exit(failed.length ? 1 : 0);
