#!/usr/bin/env node
/* Race Day MMO load probe — N real WebSocket clients against /mmo.
 *
 * Proves the scale path from _runtime/analysis/20-mmo-contract.md §3.4:
 *   - N sockets connect and get seated (up to MAX_DRIVERS)
 *   - broadcast cadence: standings ≈ 2 Hz ±30 % on the client
 *   - per-frame size: standings ≤ 1.5 KB, grid ≤ 2 KB
 *   - broadcast inter-arrival p95 ≤ 600 ms, p99 ≤ 1500 ms at 550 clients
 *   - zero unexpected disconnects, no standings frame with > 64 rows
 *   - /api/mmo/status agrees with what the probe sees (±2) and reports a
 *     plausible p50BroadcastMs
 * Plus a headroom ramp (50 → 150 → 300 → 550) into one JSON so the report can
 * say where the curve bends.
 *
 * Read-only against the server. Never starts, stops or restarts anything.
 * Writes ONE evidence file: _runtime/mmo-load.json (or --json <path>).
 *
 * Run:  cd _server; node mmo-load-probe.mjs --drivers 550
 * Quick: node mmo-load-probe.mjs --quick
 *
 * Flags: --drivers 550 --base ws://127.0.0.1:8097/mmo --seconds 20 --rate 4
 *        --ramp 50,150,300,550 --ramp-seconds <seconds> --no-ramp
 *        --json <path> --wait 480 --no-wait --http-base <url>
 *        --seat-wait 150 --race-wait 30 --settle 1500
 *        --dns-lookup-family 4 --deflate
 *
 * The probe waits for its OWN clients to be seated (the server queues late
 * joiners in `pending` while another race runs), then opens the measurement
 * window on the first standings frame delivered after that, so a race already
 * in progress cannot be mistaken for the race under test.
 *
 * Measurement traps handled on purpose:
 *   - one shared WebSocket per client (never a socket per frame);
 *   - frames are queued on arrival (cheap) and JSON.parse'd in a bounded,
 *     yielding drainer, so the ws read loop keeps up and the event loop is
 *     never blocked by a 550-client parse burst; dropped frames are counted;
 *   - telemetry is driven by ONE ticker with per-client phase jitter, sent in
 *     chunks that yield between them (no 550-socket send stampede);
 *   - probe-side event-loop lag (perf_hooks.monitorEventLoopDelay) and probe
 *     CPU are recorded next to every step, so server slowness can be told
 *     apart from probe slowness;
 *   - IPv4-first DNS and an optional --dns-lookup-family 4.
 */
import dns from 'node:dns';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import WebSocket from 'ws';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const argv = process.argv.slice(2);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// IPv4 first: a LAN hostname that resolves to ::1 first can stall 550 handshakes.
try { dns.setDefaultResultOrder('ipv4first'); } catch { /* older node */ }

function arg(name, def = null) {
  const i = argv.indexOf('--' + name);
  if (i === -1) return def;
  const v = argv[i + 1];
  return v && !v.startsWith('--') ? v : true;
}
const flag = (name) => argv.includes('--' + name);

const QUICK = flag('quick');
const DRIVERS = Number(arg('drivers', QUICK ? 100 : 550));
const SECONDS = Number(arg('seconds', QUICK ? 8 : 20));
const RATE = Number(arg('rate', 4));
const SETTLE_MS = Number(arg('settle', 1500));
const RAMP_SECONDS = Number(arg('ramp-seconds', SECONDS));
const CONNECT_TIMEOUT_MS = Number(arg('connect-timeout', 25000));
const RACE_WAIT_MS = Number(arg('race-wait', 30000));
const SEAT_WAIT_MS = Number(arg('seat-wait', 150)) * 1000;
const GRID_WAIT_MS = Number(arg('grid-wait', 25000));
const WAIT_MS = flag('no-wait') ? 0 : Number(arg('wait', 480)) * 1000;
const DEFLATE = flag('deflate');
const FAMILY = Number(arg('dns-lookup-family', arg('family', 0))) || 0;
const JSON_OUT = path.resolve(ROOT, String(arg('json', path.join('_runtime', 'mmo-load.json'))));
const NO_RAMP = flag('no-ramp');
const RAMP_RAW = String(arg('ramp', QUICK ? '50,100' : '50,150,300,550'));

const DRAIN_BATCH = 400;          // frames parsed per event-loop turn
const MAX_QUEUE = 60000;          // pending frames before we drop (counted)
const SEND_CHUNK = 100;           // sockets per send chunk (yields between)
const TICK_MS = 40;               // telemetry scheduler tick
const MAX_INTERVALS = 5000;       // per-client cap on stored gaps
const MAX_BYTE_SAMPLES = 4000;    // reservoir size for per-frame byte stats
const KB = 1024;

// Bounded, unbiased reservoir sample: the array size stays fixed, the max is
// tracked separately so a capped sample can never hide an oversized frame.
function reservoir(arr, value, cap, seen) {
  if (arr.length < cap) { arr.push(value); return; }
  const j = Math.floor(Math.random() * seen);
  if (j < cap) arr[j] = value;
}

function normalizeTargets(raw) {
  let u;
  try { u = new URL(/^[a-z]+:\/\//i.test(raw) ? raw : `ws://${raw}`); }
  catch { u = new URL(`ws://${raw}`); }
  if (u.protocol === 'http:') u.protocol = 'ws:';
  if (u.protocol === 'https:') u.protocol = 'wss:';
  if (!u.pathname || u.pathname === '/') u.pathname = '/mmo';
  const ws = u.toString();
  const h = new URL(ws);
  h.protocol = h.protocol === 'wss:' ? 'https:' : 'http:';
  h.pathname = '/';
  h.search = '';
  h.hash = '';
  return { ws, http: h.toString().replace(/\/+$/, '') };
}

const TARGET = normalizeTargets(String(arg('base', process.env.MMO_BASE || 'ws://127.0.0.1:8097/mmo')));
const WS_URL = TARGET.ws;
const HTTP_BASE = String(arg('http-base', TARGET.http)).replace(/\/+$/, '');

function percentile(sorted, p) {
  if (!sorted.length) return null;
  const i = Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1));
  return sorted[i];
}
const round = (n, d = 1) => (n == null || !Number.isFinite(n) ? null : +n.toFixed(d));
const median = (arr) => {
  if (!arr.length) return null;
  const s = arr.slice().sort((a, b) => a - b);
  return s[Math.floor((s.length - 1) / 2)];
};
const nowIso = () => new Date().toISOString();

// ---------------------------------------------------------------- status API
function deepFindNumber(obj, patterns, depth = 0, trail = '') {
  if (!obj || typeof obj !== 'object' || depth > 3) return null;
  for (const [k, v] of Object.entries(obj)) {
    const p = trail ? `${trail}.${k}` : k;
    if (typeof v === 'number' && Number.isFinite(v) && patterns.some((re) => re.test(k))) return { key: p, value: v };
  }
  for (const [k, v] of Object.entries(obj)) {
    const p = trail ? `${trail}.${k}` : k;
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      const hit = deepFindNumber(v, patterns, depth + 1, p);
      if (hit) return hit;
    }
  }
  return null;
}

const CLIENT_KEYS = [
  /^clients?$/i, /^clients?count$/i, /^connections?$/i, /^connected$/i, /^sockets?$/i,
  /^sessions?$/i, /^drivers?$/i, /^online$/i, /^seatcount$/i, /^seated$/i,
];

async function fetchStatus() {
  const url = `${HTTP_BASE}/api/mmo/status`;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(5000), headers: { accept: 'application/json' } });
    if (!res.ok) return { ok: false, httpStatus: res.status, url };
    const body = await res.json();
    let clients = null;
    for (const re of CLIENT_KEYS) { clients = deepFindNumber(body, [re]); if (clients) break; }
    const p50 = deepFindNumber(body, [/p50.*broadcast/i, /broadcast.*p50/i, /^p50$/i]);
    const cpu = deepFindNumber(body, [/^cpu/i, /cpuPct/i]);
    const rss = deepFindNumber(body, [/rss/i, /^mem/i]);
    return { ok: true, url, body, clients, p50, cpu, rss };
  } catch (err) {
    return { ok: false, url, error: err && err.message ? err.message : String(err) };
  }
}

// ---------------------------------------------------------------- one client
const BROADCAST_TYPES = new Set(['grid', 'countdown', 'standings', 'event', 'feed', 'result']);

function newClient(session, i) {
  return {
    i,
    name: `LOAD${String(i).padStart(4, '0')}`,
    driverId: `ld-${session.runId}-${i}`,
    ws: null,
    connectStart: 0,
    openedAt: 0,
    connectMs: null,
    sendError: null,
    frames: 0,
    bytes: 0,
    typeCounts: Object.create(null),
    gridAt: 0,
    countdownAt: 0,
    firstStandingsAt: 0,
    lastBroadcastAt: 0,
    steady: false,
    intervals: [],
    standingsIntervals: [],
    standingsFrames: 0,
    standingsInWindow: 0,
    winStdFirst: 0,
    winStdLast: 0,
    standingsMaxBytes: 0,
    gridMaxBytes: 0,
    rowsMax: 0,
    bytesInWindow: 0,
    framesInWindow: 0,
    seat: null,
    seated: false,
    sendsEnabled: false,
    telReset: true,
    seatedAt: 0,
    racing: false,
    racingSince: 0,
    nextTelAt: 0,
    telemetrySent: 0,
    finishSent: false,
    bufferedMax: 0,
    bufferedSamples: 0,
    parseLat: [],
    parseErrors: 0,
    serverErrors: [],
    unexpectedClose: false,
    intentional: false,
    closedAt: 0,
    closeCode: null,
    hadError: null,
  };
}

function enqueueFrame(session, client, data) {
  const at = performance.now();
  const len = typeof data === 'string'
    ? Buffer.byteLength(data)
    : (data && (data.length ?? data.byteLength)) || 0;
  const depth = session.queue.length - session.qHead;
  if (depth >= MAX_QUEUE) { session.droppedFrames += 1; return; }
  session.queue.push({ client, data, at, len });
  if (depth + 1 > session.maxQueueDepth) session.maxQueueDepth = depth + 1;
  if (!session.drainScheduled) {
    session.drainScheduled = true;
    setImmediate(() => drainSession(session));
  }
}

// Bounded, yielding parse loop: keeps the ws read loop and the telemetry
// ticker alive even when 550 sockets answer in the same millisecond.
function drainSession(session) {
  session.drainScheduled = false;
  let n = 0;
  while (session.qHead < session.queue.length && n < DRAIN_BATCH) {
    const item = session.queue[session.qHead];
    session.qHead += 1;
    n += 1;
    try { handleFrame(session, item); } catch (err) { session.parseErrors += 1; }
  }
  if (session.qHead >= session.queue.length) {
    session.queue.length = 0;
    session.qHead = 0;
  } else if (session.qHead > DRAIN_BATCH * 8) {
    session.queue = session.queue.slice(session.qHead);
    session.qHead = 0;
  }
  if (session.qHead < session.queue.length) {
    session.drainScheduled = true;
    setImmediate(() => drainSession(session));
  }
}

function observeCounts(session, msg) {
  const counts = msg.counts && typeof msg.counts === 'object' ? msg.counts : null;
  if (counts && Number.isFinite(counts.seated)) {
    if (counts.seated > session.maxSeated) { session.maxSeated = counts.seated; session.seatSource = 'counts.seated'; }
  }
  if (Number.isFinite(msg.max) && msg.max > session.maxDrivers) { session.maxDrivers = msg.max; session.maxSource = 'welcome.max'; }
  if (counts && Number.isFinite(counts.max) && counts.max > session.maxDrivers) {
    session.maxDrivers = counts.max;
    session.maxSource = 'counts.max';
  }
}

function handleFrame(session, item) {
  const { client: c, data, at, len } = item;
  const raw = typeof data === 'string' ? data : data.toString('utf8');
  const parseStart = performance.now();
  let msg;
  try { msg = JSON.parse(raw); } catch { c.parseErrors += 1; session.parseErrors += 1; return; }
  const parseDone = performance.now();
  if (c.parseLat.length < 4000) c.parseLat.push(parseDone - at);
  if (parseDone - parseStart > session.maxParseMs) session.maxParseMs = parseDone - parseStart;

  const type = msg && typeof msg.type === 'string' ? msg.type : '?';
  c.frames += 1;
  c.bytes += len;
  c.typeCounts[type] = (c.typeCounts[type] || 0) + 1;
  session.frames += 1;
  session.bytes += len;

  const inWindow = session.windowStart > 0 && at >= session.windowStart && at <= session.windowEnd;
  if (inWindow) { c.framesInWindow += 1; c.bytesInWindow += len; }

  if (type === 'welcome') {
    session.welcomed += 1;
    if (msg.you && msg.you.seat != null) markSeated(session, c, msg.you.seat);
    if (msg.state) session.lastState = msg.state;
    if (msg.state === 'racing') markRacing(c, at);
    observeCounts(session, msg);
  } else if (type === 'queue') {
    // Per-socket truth: the server tells each socket whether it holds a seat.
    if (typeof msg.seated === 'boolean') {
      if (msg.seated) markSeated(session, c, msg.seat ?? c.seat ?? -1);
      else markUnseated(session, c);
    }
  } else if (type === 'grid') {
    if (!c.gridAt) {
      c.gridAt = at;
      session.gridClients += 1;
      if (!session.firstGridAt) session.firstGridAt = at;
    }
    if (len > c.gridMaxBytes) c.gridMaxBytes = len;
    if (len > session.gridMaxBytes) session.gridMaxBytes = len;
    session.gridSeen += 1;
    reservoir(session.gridBytes, len, MAX_BYTE_SAMPLES, session.gridSeen);
    const seats = Array.isArray(msg.seats) ? msg.seats : null;
    if (seats) {
      if (seats.length > session.gridMaxRows) session.gridMaxRows = seats.length;
      let seatedRows = 0;
      for (const s of seats) {
        if (!s || typeof s !== 'object') continue;
        if (s.connected === false) continue;
        if (s.state === 'empty') continue;
        if (s.state === 'queued') continue;
        if (s.driverId || s.name) seatedRows += 1;
      }
      if (seatedRows > session.maxSeatedRows) session.maxSeatedRows = seatedRows;
    }
    observeCounts(session, msg);
  } else if (type === 'event') {
    observeCounts(session, msg);
    if (msg.state) session.lastState = msg.state;
    if (msg.plan && Number.isFinite(msg.plan.laps)) session.lapCap = Math.max(1, msg.plan.laps - 1);
    if (msg.state === 'racing') markRacing(c, at);
  } else if (type === 'countdown') {
    session.lastState = 'countdown';
    if (!c.countdownAt) {
      c.countdownAt = at;
      session.countdownClients += 1;
      if (!session.firstCountdownAt) session.firstCountdownAt = at;
      if (c.gridAt) session.gridToCountdown.push(at - c.gridAt);
    }
  } else if (type === 'standings') {
    c.standingsFrames += 1;
    if (len > c.standingsMaxBytes) c.standingsMaxBytes = len;
    if (len > session.standingsMaxBytes) session.standingsMaxBytes = len;
    session.standingsSeen += 1;
    reservoir(session.standingsBytes, len, MAX_BYTE_SAMPLES, session.standingsSeen);
    if (!c.firstStandingsAt) {
      c.firstStandingsAt = at;
      session.standingsClients += 1;
      if (!session.firstStandingsAt) session.firstStandingsAt = at;
    }
    const rows = Array.isArray(msg.rows) ? msg.rows.length : 0;
    if (rows > c.rowsMax) c.rowsMax = rows;
    if (rows > session.rowsMax) session.rowsMax = rows;
    // Track our own row so telemetry follows the server's clock: a re-seated
    // socket can inherit a seat with a raceTimeMs already ahead of us, and the
    // server rejects a raceTimeMs that goes backwards.
    if (c.seated && c.seat > 0 && Array.isArray(msg.rows)) {
      const me = msg.rows.find((r) => r && r.seat === c.seat);
      if (me && Number.isFinite(me.raceTimeMs) && me.raceTimeMs > (c.lastRaceTimeMs || 0)) {
        c.lastRaceTimeMs = me.raceTimeMs;
        c.racingSince = at - me.raceTimeMs;
      }
    }
    // Telemetry starts with the measurement window: a seated client waits for
    // its first standings frame, so sends are never aimed at a race we missed.
    if (c.seated) c.sendsEnabled = true;
    if (inWindow) {
      c.standingsInWindow += 1;
      if (!c.winStdFirst) c.winStdFirst = at;
      c.winStdLast = at;
    }
    if (c.seated && session.seatedAt && at >= session.seatedAt && !session.firstStandingsAfterSeat) {
      session.firstStandingsAfterSeat = at;
      session.racingAfterSeat = session.clients.filter((x) => x.seated).length;
    }
    markRacing(c, at);
  } else if (type === 'error') {
    c.serverErrors.push({ code: msg.code || null, message: msg.message || null });
    const key = String(msg.code || 'unknown');
    session.serverErrorCounts[key] = (session.serverErrorCounts[key] || 0) + 1;
    if (session.serverErrors.length < 40) session.serverErrors.push({ seat: c.i, code: msg.code || null, message: msg.message || null });
  }

  if (BROADCAST_TYPES.has(type)) {
    if (c.lastBroadcastAt && c.steady && at >= session.windowStart && at <= session.windowEnd) {
      const gap = at - c.lastBroadcastAt;
      if (c.intervals.length < MAX_INTERVALS) c.intervals.push(gap);
      if (type === 'standings' && c.standingsIntervals.length < MAX_INTERVALS) c.standingsIntervals.push(gap);
    }
    c.lastBroadcastAt = at;
  }
  if (type === 'standings') c.steady = true;
}

function markSeated(session, c, seat) {
  if (!c.seated) {
    c.seated = true;
    c.seatedAt = performance.now();
    session.withSeat.add(c.i);
    if (!session.firstSeatAt) session.firstSeatAt = c.seatedAt;
    if (session.withSeat.size > session.withSeatMax) session.withSeatMax = session.withSeat.size;
  }
  if (Number.isFinite(seat) && seat > 0) c.seat = seat;
}

function markUnseated(session, c) {
  if (!c.seated) return;
  c.seated = false;
  c.seat = null;
  session.withSeat.delete(c.i);
}

function markRacing(c, at) {
  if (c.racing) return;
  c.racing = true;
  c.racingSince = at;
  c.nextTelAt = 0;
}

// ---------------------------------------------------------------- telemetry
function sendTelemetry(session, c) {
  if (!c.ws || c.ws.readyState !== 1) return;
  const now = performance.now();
  const el = Math.max(0, now - (c.racingSince || session.windowStart || now));
  // A re-seated socket may inherit a seat whose raceTimeMs is already ahead of
  // it. The contract's documented reset is one telemetry frame with
  // state:'countdown' (§3.3), which is legal during racing.
  const reset = c.telReset;
  if (reset) { c.telReset = false; c.lastRaceTimeMs = 0; }
  // Jitter the value but keep it monotonic: the server rejects a raceTimeMs
  // that goes backwards, and a rejected sample would silently drop load.
  const rt = reset
    ? Math.round(el)
    : Math.max((c.lastRaceTimeMs || 0) + 1, Math.round(el + (Math.random() * 120 - 60)));
  c.lastRaceTimeMs = rt;
  // Never report the final lap: a client that "reaches" plan.laps would finish
  // the race mid-window and stop the standings cadence we are measuring.
  const lap = Math.min(session.lapCap, 1 + Math.floor(el / 22000));
  const payload = JSON.stringify({
    type: 'telemetry',
    t: Date.now(),
    lap,
    raceTimeMs: rt,
    speedKph: Math.round(110 + Math.random() * 80),
    state: reset ? 'countdown' : 'racing',
  });
  try { c.ws.send(payload); c.telemetrySent += 1; session.telemetrySent += 1; session.telemetryResets += reset ? 1 : 0; }
  catch (err) { c.sendError = err && err.message ? err.message : String(err); }
}

function startTicker(session) {
  const period = 1000 / RATE;
  const stepMs = Math.min(TICK_MS, Math.max(5, period / 3));
  const tick = async () => {
    if (session.tickerDone) return;
    const now = performance.now();
    session.ticks += 1;
    const due = [];
    for (const c of session.clients) {
      if (!c.racing || !c.seated || !c.sendsEnabled || c.intentional) continue;
      if (!c.ws || c.ws.readyState !== 1) continue;
      if (now < c.nextTelAt) continue;
      due.push(c);
      c.nextTelAt = now + period * (0.85 + Math.random() * 0.3); // ±15 % per-client jitter
    }
    for (let i = 0; i < due.length; i += SEND_CHUNK) {
      const end = Math.min(due.length, i + SEND_CHUNK);
      for (let j = i; j < end; j += 1) sendTelemetry(session, due[j]);
      if (end < due.length) await sleep(0); // let reads/parses interleave
    }
    if (now - session.lastBufSample >= 500) {
      session.lastBufSample = now;
      for (const c of session.clients) {
        if (!c.ws || c.ws.readyState !== 1) continue;
        const b = c.ws.bufferedAmount || 0;
        if (b > c.bufferedMax) c.bufferedMax = b;
        if (b > session.bufferedMax) session.bufferedMax = b;
        c.bufferedSamples += 1;
        session.bufferedSamples += 1;
      }
    }
    session.tickTimer = setTimeout(tick, stepMs);
  };
  session.tickTimer = setTimeout(tick, stepMs);
}

// ---------------------------------------------------------------- one step
function makeSession({ label, drivers, seconds, index }) {
  return {
    label,
    drivers,
    seconds,
    index,
    runId: `${Date.now().toString(36)}${index}`,
    t0: performance.now(),
    clients: [],
    queue: [],
    qHead: 0,
    drainScheduled: false,
    droppedFrames: 0,
    maxQueueDepth: 0,
    parseErrors: 0,
    maxParseMs: 0,
    frames: 0,
    bytes: 0,
    opened: 0,
    lastOpenAt: 0,
    unexpectedCloses: 0,
    socketErrors: [],
    windowStart: 0,
    windowEnd: 0,
    maxDrivers: 0,
    maxSource: null,
    maxSeated: 0,
    seatSource: null,
    maxSeatedRows: 0,
    gridMaxRows: 0,
    rowsMax: 0,
    gridBytes: [],
    standingsBytes: [],
    gridSeen: 0,
    standingsSeen: 0,
    gridMaxBytes: 0,
    standingsMaxBytes: 0,
    standingsClients: 0,
    gridClients: 0,
    countdownClients: 0,
    welcomed: 0,
    withSeat: new Set(),
    withSeatMax: 0,
    seatedAt: 0,
    seatedWaitMs: 0,
    lastState: '',
    firstStandingsAfterSeat: 0,
    racingAfterSeat: 0,
    lapCap: 2,
    gridToCountdown: [],
    firstGridAt: 0,
    firstCountdownAt: 0,
    firstStandingsAt: 0,
    serverErrors: [],
    serverErrorCounts: Object.create(null),
    statusMid: null,
    statusEnd: null,
    ticks: 0,
    telemetrySent: 0,
    telemetryResets: 0,
    bufferedMax: 0,
    bufferedSamples: 0,
    firstSeatAt: 0,
    lastBufSample: 0,
    tickTimer: null,
    tickerDone: false,
  };
}

function openClient(session, i) {
  const c = newClient(session, i);
  session.clients.push(c);
  ACTIVE.push(c);
  const options = { perMessageDeflate: DEFLATE, handshakeTimeout: 8000 };
  if (FAMILY) options.family = FAMILY;
  let ws;
  try { ws = new WebSocket(WS_URL, [], options); } catch (err) {
    c.hadError = err && err.message ? err.message : String(err);
    c.openPromise = Promise.resolve();
    return c;
  }
  c.ws = ws;
  c.connectStart = performance.now();
  c.openPromise = new Promise((resolve) => {
    const timer = setTimeout(() => {
      c.hadError = c.hadError || `open timeout after ${CONNECT_TIMEOUT_MS}ms`;
      try { ws.terminate(); } catch { /* ignore */ }
      resolve();
    }, CONNECT_TIMEOUT_MS);
    ws.once('open', () => {
      clearTimeout(timer);
      c.openedAt = performance.now();
      c.connectMs = c.openedAt - c.t0;
      session.opened += 1;
      session.lastOpenAt = c.openedAt;
      try {
        ws.send(JSON.stringify({ type: 'hello', name: c.name, driverId: c.driverId }));
        ws.send(JSON.stringify({ type: 'queue' }));
      } catch (err) {
        c.sendError = err && err.message ? err.message : String(err);
      }
      resolve();
    });
    ws.once('error', (err) => {
      c.hadError = err && err.message ? err.message : String(err);
      if (session.socketErrors.length < 40) session.socketErrors.push({ seat: i, error: c.hadError });
    });
  });
  ws.on('message', (data) => enqueueFrame(session, c, data));
  ws.on('error', (err) => { if (!c.hadError) c.hadError = err && err.message ? err.message : String(err); });
  ws.on('close', (code, reason) => {
    c.closedAt = performance.now();
    c.closeCode = code;
    c.closeReason = reason ? reason.toString() : '';
    if (!c.intentional) {
      c.unexpectedClose = true;
      session.unexpectedCloses += 1;
    }
  });
  return c;
}

async function sampleStatus(session, phase) {
  const openNow = session.clients.filter((c) => c.ws && c.ws.readyState === 1).length;
  const atMs = Math.round(performance.now() - session.t0);
  const st = await fetchStatus();
  const out = { phase, atMs, openNow, ...st };
  session[phase] = out;
  return out;
}

async function runStep({ drivers, seconds, label, index }) {
  const session = makeSession({ label, drivers, seconds, index });
  ACTIVE = [];
  const lag = monitorEventLoopDelay({ resolution: 10 });
  lag.enable();
  const cpu0 = process.cpuUsage();
  console.log(`\n=== ${label} :: ${drivers} clients, ${seconds}s window, ${RATE} Hz telemetry -> ${WS_URL}`);

  try {
    for (let i = 0; i < drivers; i += 1) openClient(session, i);
    startTicker(session);
    await Promise.all(session.clients.map((c) => c.openPromise));

    const connectMs = round(session.lastOpenAt ? session.lastOpenAt - session.t0 : null, 0);
    console.log(`  connect: ${session.opened}/${drivers} in ${connectMs}ms`);

    // 1) Wait until our own clients hold seats. The server may be mid-race with
    //    another grid, in which case our drivers sit in `pending` until the
    //    results timer rolls the next event; measuring before that would report
    //    a cadence for a race we are not in.
    const seatDeadline = performance.now() + SEAT_WAIT_MS;
    const seatTargetNow = () => Math.min(drivers, session.maxDrivers || 50);
    // Stop as soon as our own drivers hold the grid, or as soon as the server
    // reports the grid full while we are in lobby/grid (another client holds the
    // last seat — waiting longer cannot help).
    const seatsDone = () => session.withSeat.size >= seatTargetNow()
      || (session.maxSeated >= seatTargetNow()
        && ['lobby', 'grid', 'countdown'].includes(session.lastState || ''));
    while (performance.now() < seatDeadline && !seatsDone()) await sleep(100);
    session.seatedAt = performance.now();
    session.seatedWaitMs = session.seatedAt - session.t0;
    console.log(`  seats: peak ${session.withSeatMax}/${seatTargetNow()}`
      + ` (first @${round(session.firstSeatAt ? session.firstSeatAt - session.t0 : null, 0)}ms,`
      + ` wait ended @${round(session.seatedWaitMs, 0)}ms, counts.seated=${session.maxSeated},`
      + ` MAX=${session.maxDrivers || '?'}, cap ${round(SEAT_WAIT_MS / 1000, 0)}s)`);

    // 2) Wait for the grid/countdown of the event we are seated in.
    const tGrid = performance.now() + GRID_WAIT_MS;
    while (!session.firstGridAt && performance.now() < tGrid) await sleep(100);
    const tCd = performance.now() + 20000;
    while (!session.firstCountdownAt && performance.now() < tCd) await sleep(100);

    // 3) The measurement window opens on the first standings frame delivered
    //    after we were seated — not on a frame from somebody else's race.
    const tRace = performance.now() + RACE_WAIT_MS;
    while (!session.firstStandingsAfterSeat && performance.now() < tRace) await sleep(50);

    session.windowStart = session.firstStandingsAfterSeat || performance.now();
    session.windowEnd = session.windowStart + seconds * 1000;
    session.openAtWindow = session.clients.filter((c) => c.ws && c.ws.readyState === 1).length;
    console.log(`  grid@${round(session.firstGridAt ? session.firstGridAt - session.t0 : null, 0)}ms`
      + ` countdown@${round(session.firstCountdownAt ? session.firstCountdownAt - session.t0 : null, 0)}ms`
      + ` racing@${round(session.firstStandingsAfterSeat ? session.firstStandingsAfterSeat - session.t0 : null, 0)}ms`
      + ` seatedClients=${session.withSeat.size} max=${session.maxDrivers || '?'}`
      + (session.firstStandingsAfterSeat ? '' : ' (NO RACING AFTER SEAT WAIT)'));

    const mid = session.windowStart + (seconds * 1000) / 2;
    let midDone = false;
    while (performance.now() < session.windowEnd) {
      if (!midDone && performance.now() >= mid) {
        midDone = true;
        await sampleStatus(session, 'statusMid');
      }
      await sleep(100);
    }
    session.tickerDone = true;
    clearTimeout(session.tickTimer);

    // Finish cleanly, then snapshot the server view before we hang up.
    for (const c of session.clients) {
      if (!c.racing || !c.seated || !c.ws || c.ws.readyState !== 1) continue;
      const el = Math.max(0, performance.now() - (c.racingSince || session.t0));
      const rt = Math.max(c.lastRaceTimeMs || 0, Math.round(el));
      try {
        c.ws.send(JSON.stringify({
          type: 'finish',
          raceTimeMs: rt,
          lap: Math.min(session.lapCap, 1 + Math.floor(el / 22000)),
        }));
        c.finishSent = true;
      } catch { /* ignore */ }
    }
    await sleep(1200);
    await sampleStatus(session, 'statusEnd');

    for (const c of session.clients) {
      c.intentional = true;
      try { c.ws.close(1000); } catch { /* ignore */ }
    }
    await sleep(600);
    for (const c of session.clients) {
      try { if (c.ws.readyState !== 3) c.ws.terminate(); } catch { /* ignore */ }
    }
  } finally {
    session.tickerDone = true;
    clearTimeout(session.tickTimer);
    lag.disable();
    const cpu = process.cpuUsage(cpu0);
    for (const c of session.clients) {
      try { if (c.ws.readyState !== 3) { c.intentional = true; c.ws.terminate(); } } catch { /* ignore */ }
    }
    session.lag = {
      p50: round(lag.percentile(50) / 1e6, 2),
      p95: round(lag.percentile(95) / 1e6, 2),
      p99: round(lag.percentile(99) / 1e6, 2),
      max: round(lag.max / 1e6, 2),
      note: 'probe-side event-loop delay (perf_hooks.monitorEventLoopDelay, resolution 10ms)',
    };
    const elapsedMs = performance.now() - session.t0;
    const cpuUserMs = cpu.user / 1000;
    const cpuSystemMs = cpu.system / 1000;
    session.cpu = {
      elapsedMs: round(elapsedMs, 0),
      userMs: round(cpuUserMs, 0),
      systemMs: round(cpuSystemMs, 0),
    };
    session.probeCpuPct = round(((cpuUserMs + cpuSystemMs) / Math.max(1, elapsedMs)) * 100, 1);
  }
  return summarize(session);
}

function summarize(session) {
  const windowMs = Math.max(1, session.windowEnd - session.windowStart);
  const seconds = windowMs / 1000;

  const intervals = [];
  const standingsIntervals = [];
  const parseLat = [];
  const cadences = [];
  const byWindow = [];
  const bytesPerSec = [];
  for (const c of session.clients) {
    for (const v of c.intervals) intervals.push(v);
    for (const v of c.standingsIntervals) standingsIntervals.push(v);
    for (const v of c.parseLat) parseLat.push(v);
    if (c.framesInWindow > 0) {
      // True client-observed cadence: (n-1) frames over the span they cover.
      const span = (c.winStdLast - c.winStdFirst) / 1000;
      const bySpan = (c.standingsInWindow >= 2 && span > 0.25) ? (c.standingsInWindow - 1) / span : null;
      cadences.push(bySpan != null ? bySpan : c.standingsInWindow / seconds);
      byWindow.push(c.standingsInWindow / seconds);
      bytesPerSec.push(c.bytesInWindow / seconds);
    }
  }
  intervals.sort((a, b) => a - b);
  standingsIntervals.sort((a, b) => a - b);
  parseLat.sort((a, b) => a - b);
  const standingsBytes = session.standingsBytes.slice().sort((a, b) => a - b);
  const gridBytes = session.gridBytes.slice().sort((a, b) => a - b);

  const cadence = median(cadences.filter((n) => n > 0));
  const maxOf = (arr) => (arr.length ? arr[arr.length - 1] : null);
  const statusMid = session.statusMid || null;
  const statusClients = statusMid && statusMid.ok && statusMid.clients ? statusMid.clients.value : null;
  const statusOpenNow = statusMid ? statusMid.openNow : null;
  const statusP50 = statusMid && statusMid.ok && statusMid.p50 ? statusMid.p50.value : null;

  const step = {
    label: session.label,
    drivers: session.drivers,
    seconds: round(seconds, 1),
    target: WS_URL,
    connected: session.opened,
    connectMs: round(session.lastOpenAt ? session.lastOpenAt - session.t0 : null, 0),
    connectBudgetMs: 10000,
    clientsOpenAtWindow: session.openAtWindow ?? null,
    clientsSeenStandings: session.standingsClients,
    clientsSeenGrid: session.gridClients,
    welcomed: session.welcomed,
    seat: {
      reached: session.withSeatMax,
      seatedAtEnd: session.withSeat.size,
      countsSeatedMax: session.maxSeated,
      fromSeats: session.maxSeatedRows,
      source: session.withSeatMax ? 'queue.seated per socket' : (session.seatSource || null),
      maxDrivers: session.maxDrivers || null,
      maxSource: session.maxSource,
      target: Math.min(session.drivers, session.maxDrivers || 50),
      waitMs: SEAT_WAIT_MS,
    },
    timeline: {
      connectMs: round(session.lastOpenAt ? session.lastOpenAt - session.t0 : null, 0),
      firstSeatMs: round(session.firstSeatAt ? session.firstSeatAt - session.t0 : null, 0),
      seatsDoneMs: round(session.seatedWaitMs || null, 0),
      gridMs: round(session.firstGridAt ? session.firstGridAt - session.t0 : null, 0),
      countdownMs: round(session.firstCountdownAt ? session.firstCountdownAt - session.t0 : null, 0),
      racingMs: round(session.firstStandingsAfterSeat ? session.firstStandingsAfterSeat - session.t0 : null, 0),
      windowStartMs: round(session.windowStart - session.t0, 0),
      stepTotalMs: round(performance.now() - session.t0, 0),
    },
    gridToCountdownMs: {
      p50: round(percentile(session.gridToCountdown.slice().sort((a, b) => a - b), 0.5), 0),
      p95: round(percentile(session.gridToCountdown.slice().sort((a, b) => a - b), 0.95), 0),
      n: session.gridToCountdown.length,
    },
    cadenceHz: {
      median: round(cadence, 2),
      byWindowMedian: round(median(byWindow), 2),
      p05: round(percentile(cadences.slice().sort((a, b) => a - b), 0.05), 2),
      p95: round(percentile(cadences.slice().sort((a, b) => a - b), 0.95), 2),
      samples: cadences.length,
      budget: '2 Hz ±30 % (1.40–2.60)',
      note: 'median = (frames-1)/span per client; byWindowMedian = frames/window (both in Hz)',
    },
    interArrivalMs: {
      p50: round(percentile(intervals, 0.5), 0),
      p95: round(percentile(intervals, 0.95), 0),
      p99: round(percentile(intervals, 0.99), 0),
      max: round(maxOf(intervals), 0),
      n: intervals.length,
      standingsP95: round(percentile(standingsIntervals, 0.95), 0),
      note: 'gaps between server broadcast frames, measured only after the first standings frame',
    },
    bytes: {
      standingsMax: session.standingsMaxBytes || null,
      standingsP50: round(percentile(standingsBytes, 0.5), 0),
      standingsP95: round(percentile(standingsBytes, 0.95), 0),
      gridMax: session.gridMaxBytes || null,
      gridP95: round(percentile(gridBytes, 0.95), 0),
      gridFrames: session.gridSeen,
      standingsFrames: session.standingsSeen,
      sampledFrames: { standings: standingsBytes.length, grid: gridBytes.length },
      note: 'max is the true running maximum; p50/p95 come from a bounded reservoir sample',
    },
    rows: { standingsMax: session.rowsMax, gridMax: session.gridMaxRows, limit: 64 },
    parseLatencyMs: {
      p50: round(percentile(parseLat, 0.5), 2),
      p95: round(percentile(parseLat, 0.95), 2),
      max: round(maxOf(parseLat), 2),
      maxParseOnlyMs: round(session.maxParseMs, 2),
      samples: parseLat.length,
      note: 'frame arrival (ws message) -> JSON.parse done, includes probe queue wait',
    },
    frames: {
      total: session.frames,
      bytes: session.bytes,
      perClientMedian: round(median(session.clients.map((c) => c.frames)), 0),
      telemetrySent: session.telemetrySent,
      telemetryHzTarget: RATE,
      telemetryHzActual: round(session.telemetrySent
        / Math.max(1, session.clients.filter((c) => c.telemetrySent > 0).length)
        / seconds, 2),
      telemetryHzNote: 'sends per seated client per measured second (the server accepts ≤4 Hz)',
      telemetryResets: session.telemetryResets,
      seatedClients: session.clients.filter((c) => c.telemetrySent > 0).length,
      ticks: session.ticks,
    },
    bytesPerSecondPerClient: round(median(bytesPerSec), 0),
    bytesPerSecondTotal: round(bytesPerSec.reduce((a, b) => a + b, 0), 0),
    bufferedAmountMax: session.bufferedMax ?? 0,
    bufferedAmountSamples: session.bufferedSamples,
    disconnects: {
      unexpected: session.unexpectedCloses,
      socketErrors: session.socketErrors.length,
      sendErrors: session.clients.filter((c) => c.sendError).length,
      samples: session.socketErrors.slice(0, 10),
    },
    status: {
      mid: statusMid ? {
        ok: statusMid.ok,
        httpStatus: statusMid.httpStatus ?? null,
        clients: statusClients,
        clientsKey: statusMid.clients ? statusMid.clients.key : null,
        p50BroadcastMs: statusP50,
        p50Key: statusMid.p50 ? statusMid.p50.key : null,
        cpu: statusMid.cpu ? statusMid.cpu.value : null,
        rss: statusMid.rss ? statusMid.rss.value : null,
        openNow: statusOpenNow,
        error: statusMid.error || null,
      } : null,
      end: session.statusEnd ? {
        ok: session.statusEnd.ok,
        clients: session.statusEnd.clients ? session.statusEnd.clients.value : null,
        p50BroadcastMs: session.statusEnd.p50 ? session.statusEnd.p50.value : null,
        openNow: session.statusEnd.openNow,
      } : null,
    },
    serverErrors: { counts: session.serverErrorCounts, samples: session.serverErrors.slice(0, 10) },
    probe: {
      eventLoopLagMs: session.lag,
      cpuPct: session.probeCpuPct,
      cpu: session.cpu,
      maxQueueDepth: session.maxQueueDepth,
      droppedFrames: session.droppedFrames,
      parseErrors: session.parseErrors,
      rssMb: round(process.memoryUsage().rss / 1048576, 0),
    },
    gates: [],
  };

  // ---- gates ------------------------------------------------------------
  const gate = (id, ok, detail) => step.gates.push({ id, ok: !!ok, detail: String(detail) });

  gate('connect/all-within-10s',
    step.connected === session.drivers && step.connectMs != null && step.connectMs <= 10000,
    `${step.connected}/${session.drivers} opened in ${step.connectMs}ms (budget 10000ms)`);
  gate('seat/reaches-min(drivers,max)',
    Math.max(step.seat.reached, step.seat.countsSeatedMax || 0) >= step.seat.target && step.seat.target > 0,
    `seated ${Math.max(step.seat.reached, step.seat.countsSeatedMax || 0)} of ${step.seat.target}`
    + ` (our sockets ${step.seat.reached}, server counts.seated ${step.seat.countsSeatedMax},`
    + ` drivers=${session.drivers}, MAX_DRIVERS=${step.seat.maxDrivers || 'unknown'})`);
  gate('cadence/standings-2hz±30',
    step.cadenceHz.median != null && step.cadenceHz.median >= 1.4 && step.cadenceHz.median <= 2.6,
    step.cadenceHz.median == null
      ? `no standings frame arrived for a seated client within ${Math.round(RACE_WAIT_MS / 1000)}s of seating`
      : `median ${step.cadenceHz.median}Hz over ${step.cadenceHz.samples} clients (1.40–2.60)`);
  gate('size/standings<=1.5KB', step.bytes.standingsMax != null && step.bytes.standingsMax <= 1.5 * KB,
    `max ${step.bytes.standingsMax}B, p95 ${step.bytes.standingsP95}B (budget ${1.5 * KB}B)`);
  gate('size/grid<=2KB', step.bytes.gridMax == null || step.bytes.gridMax <= 2 * KB,
    `max ${step.bytes.gridMax}B (budget ${2 * KB}B, ${step.bytes.gridFrames} frame(s))`);
  gate('inter-arrival/p95<=600', step.interArrivalMs.p95 != null && step.interArrivalMs.p95 <= 600,
    `p95 ${step.interArrivalMs.p95}ms (budget 600ms)`);
  gate('inter-arrival/p99<=1500', step.interArrivalMs.p99 != null && step.interArrivalMs.p99 <= 1500,
    `p99 ${step.interArrivalMs.p99}ms (budget 1500ms)`);
  gate('disconnects/zero-unexpected', session.unexpectedCloses === 0,
    `${session.unexpectedCloses} unexpected close(s), ${session.socketErrors.length} socket error(s)`);
  gate('errors/bad_telemetry=0', (session.serverErrorCounts.bad_telemetry || 0) === 0,
    `${session.serverErrorCounts.bad_telemetry || 0} bad_telemetry error frame(s)`
    + (session.serverErrorCounts.bad_telemetry ? ` (${session.serverErrors.find((e) => e.code === 'bad_telemetry')?.message || ''})` : ''));
  gate('rows/standings<=64', session.rowsMax > 0 && session.rowsMax <= 64,
    `max ${session.rowsMax} rows (limit 64)`);
  gate('status/client-count±2',
    statusClients != null && statusOpenNow != null && Math.abs(statusClients - statusOpenNow) <= 2,
    statusClients == null
      ? `/api/mmo/status did not report a client count (ok=${statusMid && statusMid.ok}, http=${statusMid && statusMid.httpStatus}, err=${statusMid && statusMid.error})`
      : `status ${statusClients} (${statusMid.clients.key}) vs probe ${statusOpenNow}`,
  );
  gate('status/p50Broadcast-plausible',
    typeof statusP50 === 'number' && Number.isFinite(statusP50) && statusP50 >= 0 && statusP50 <= 600,
    statusP50 == null ? 'p50BroadcastMs missing from /api/mmo/status' : `p50BroadcastMs=${statusP50}`);

  return step;
}

// ---------------------------------------------------------------- printing
function printStepTable(step) {
  const pad = (v, n) => String(v == null ? '-' : v).padEnd(n);
  console.log('  '
    + pad(`${step.drivers}`, 5)
    + pad(`${step.connected}`, 6)
    + pad(`${step.connectMs}`, 8)
    + pad(`${step.seat.reached}/${step.seat.target}`, 10)
    + pad(`${step.cadenceHz.median ?? '-'}`, 9)
    + pad(`${step.interArrivalMs.p95 ?? '-'}`, 8)
    + pad(`${step.interArrivalMs.p99 ?? '-'}`, 8)
    + pad(`${step.bytes.standingsMax ?? '-'}`, 10)
    + pad(`${step.bytes.gridMax ?? '-'}`, 9)
    + pad(`${step.bytesPerSecondPerClient ?? '-'}`, 9)
    + pad(`${step.probe.eventLoopLagMs ? step.probe.eventLoopLagMs.p95 : '-'}`, 9)
    + pad(`${step.probe.cpuPct ?? '-'}`, 7)
    + pad(`${step.disconnects.unexpected}`, 6));
}

const TABLE_HEAD = '  ' + [
  ['drv', 5], ['conn', 6], ['connMs', 8], ['seated', 10], ['Hz', 9], ['p95', 8], ['p99', 8],
  ['stdB', 10], ['gridB', 9], ['B/s/ci', 9], ['lag95', 9], ['cpu%', 7], ['disc', 6],
].map(([h, n]) => String(h).padEnd(n)).join('');

// ---------------------------------------------------------------- main
const RAMP = NO_RAMP ? [] : RAMP_RAW.split(',').map((n) => Number(n.trim())).filter((n) => n > 0 && n <= DRIVERS).sort((a, b) => a - b);
const STEPS = Array.from(new Set([...RAMP, DRIVERS])).sort((a, b) => a - b);

const artifact = {
  probe: 'mmo-load',
  target: WS_URL,
  statusUrl: `${HTTP_BASE}/api/mmo/status`,
  startedAt: nowIso(),
  node: process.version,
  platform: `${process.platform} ${process.arch}`,
  args: {
    drivers: DRIVERS,
    seconds: SECONDS,
    rate: RATE,
    ramp: NO_RAMP ? null : RAMP_RAW,
    rampSeconds: RAMP_SECONDS,
    quick: QUICK,
    dnsFamily: FAMILY || null,
    deflate: DEFLATE,
    waitSeconds: Math.round(WAIT_MS / 1000),
    seatWaitSeconds: Math.round(SEAT_WAIT_MS / 1000),
    raceWaitSeconds: Math.round(RACE_WAIT_MS / 1000),
  },
  env: {
    RR4_MMO_MIN: process.env.RR4_MMO_MIN ?? null,
    RR4_MMO_MAX: process.env.RR4_MMO_MAX ?? null,
    RR4_MMO_FILL_MS: process.env.RR4_MMO_FILL_MS ?? null,
    note: 'env captured from the probe process, not the server; the server defaults live in mmo.js',
  },
  reachability: null,
  steps: [],
  summary: null,
  result: 'FAIL',
};

let ACTIVE = [];   // sockets to kill on SIGINT / exit
const breakdown = () => {
  for (const c of ACTIVE) { try { c.ws.terminate(); } catch { /* ignore */ } }
};

function installKillHandles() {
  const bail = (code) => {
    breakdown();
    try {
      if (!artifact.summary) {
        artifact.finishedAt = nowIso();
        artifact.result = 'ABORTED';
        fs.mkdirSync(path.dirname(JSON_OUT), { recursive: true });
        fs.writeFileSync(JSON_OUT, JSON.stringify(artifact, null, 2) + '\n', 'utf8');
      }
    } catch { /* ignore */ }
    process.exit(code);
  };
  process.on('SIGINT', () => { console.log('\nSIGINT — closing every socket'); bail(130); });
  process.on('SIGTERM', () => bail(143));
  process.on('exit', () => { for (const c of ACTIVE) { try { c.ws.terminate(); } catch { /* ignore */ } } });
}

async function waitForServer() {
  const started = performance.now();
  let attempt = 0;
  let lastErr = null;
  while (true) {
    attempt += 1;
    const st = await fetchStatus();
    const slim = st.ok
      ? { httpStatus: 200, clients: st.clients || null, p50BroadcastMs: st.p50 ? st.p50.value : null }
      : { httpStatus: st.httpStatus ?? null, error: st.error || null };
    if (st.ok) {
      console.log(`INFO  ${HTTP_BASE}/api/mmo/status is up after ${Math.round(performance.now() - started)}ms (attempt ${attempt})`);
      return { up: true, via: 'status', waitedMs: Math.round(performance.now() - started), status: slim };
    }
    // The WS is what actually matters; a status 404 is not a reason to stop.
    const probeOk = await new Promise((resolve) => {
      const ws = new WebSocket(WS_URL, [], { perMessageDeflate: false, handshakeTimeout: 4000, ...(FAMILY ? { family: FAMILY } : {}) });
      const done = (v) => { try { ws.terminate(); } catch { /* ignore */ } resolve(v); };
      const timer = setTimeout(() => done({ ok: false, error: 'open timeout 4000ms' }), 4500);
      ws.once('open', () => { clearTimeout(timer); done({ ok: true }); });
      ws.once('error', (err) => { clearTimeout(timer); done({ ok: false, error: err && err.message ? err.message : String(err) }); });
    });
    if (probeOk.ok) {
      console.log(`INFO  ${WS_URL} accepts a socket after ${Math.round(performance.now() - started)}ms (status http=${st.httpStatus ?? 'n/a'})`);
      return { up: true, via: 'socket', waitedMs: Math.round(performance.now() - started), status: slim };
    }
    lastErr = probeOk.error || st.error || `status http=${st.httpStatus}`;
    if (performance.now() - started >= WAIT_MS) return { up: false, error: lastErr, waitedMs: Math.round(performance.now() - started) };
    if (attempt === 1 || attempt % 5 === 0) {
      console.log(`WAIT  ${WS_URL} not up yet (${Math.round((performance.now() - started) / 1000)}s/${Math.round(WAIT_MS / 1000)}s): ${lastErr}`);
    }
    await sleep(3000);
  }
}

installKillHandles();
try {
  console.log(`MMO LOAD PROBE  target=${WS_URL}  status=${HTTP_BASE}/api/mmo/status  node=${process.version}`);
  console.log(`steps: ${STEPS.join(' -> ')} clients, window ${SECONDS}s (ramp ${Math.min(RAMP_SECONDS, SECONDS)}s), telemetry ${RATE} Hz${QUICK ? ' [quick]' : ''}`);
  console.log(`waits: reachability ${Math.round(WAIT_MS / 1000)}s, seats ${Math.round(SEAT_WAIT_MS / 1000)}s, racing ${Math.round(RACE_WAIT_MS / 1000)}s; settle ${SETTLE_MS}ms`);
  if (FAMILY) console.log(`dns family: IPv${FAMILY} forced`);

  artifact.reachability = await waitForServer();
  if (artifact.reachability.up) {
    await sleep(400);
    for (let idx = 0; idx < STEPS.length; idx += 1) {
      const drivers = STEPS[idx];
      const isMain = drivers === DRIVERS;
      const seconds = isMain ? SECONDS : Math.min(RAMP_SECONDS, SECONDS);
      if (idx === 0) console.log('\n' + TABLE_HEAD);
      const step = await runStep({ drivers, seconds, label: `step${idx + 1}-${drivers}`, index: idx });
      artifact.steps.push(step);
      ACTIVE = [];
      printStepTable(step);
      for (const g of step.gates) console.log(`  ${g.ok ? 'PASS' : 'FAIL'}  ${g.id} :: ${g.detail}`);
      if (idx < STEPS.length - 1) await sleep(SETTLE_MS);
    }
  } else {
    console.log(`FAIL  server/reachable :: ${WS_URL} not reachable within ${Math.round((artifact.reachability.waitedMs || 0) / 1000)}s (${artifact.reachability.error})`);
  }
} catch (err) {
  artifact.error = err && err.stack ? err.stack : String(err);
  console.log(`FAIL  probe/flow :: ${err && err.message ? err.message : err}`);
} finally {
  breakdown();
}

const allGates = artifact.steps.flatMap((s) => s.gates.map((g) => ({ step: s.label, ...g })));
const failures = allGates.filter((g) => !g.ok);
if (!artifact.steps.length) failures.push({ step: 'reachability', id: 'server/reachable', ok: false, detail: artifact.reachability ? artifact.reachability.error : 'no steps ran' });

const worst = artifact.steps.length
  ? artifact.steps.reduce((a, b) => ((b.drivers > a.drivers) ? b : a))
  : null;
const serverCpu = worst && worst.status && worst.status.mid ? worst.status.mid.cpu : null;

artifact.summary = {
  maxClients: worst ? worst.connected : 0,
  maxDrivers: worst ? worst.seat.maxDrivers : null,
  seated: worst ? Math.max(worst.seat.reached, worst.seat.countsSeatedMax || 0) : 0,
  p95Ms: worst ? worst.interArrivalMs.p95 : null,
  p99Ms: worst ? worst.interArrivalMs.p99 : null,
  cadenceHz: worst ? worst.cadenceHz.median : null,
  bytesPerStandingsFrame: worst ? worst.bytes.standingsMax : null,
  bytesPerGridFrame: worst ? worst.bytes.gridMax : null,
  bytesPerSecondPerClient: worst ? worst.bytesPerSecondPerClient : null,
  bytesPerSecondTotal: worst ? worst.bytesPerSecondTotal : null,
  serverCpuPct: serverCpu,
  probeEventLoopLagP95Ms: worst ? worst.probe.eventLoopLagMs.p95 : null,
  probeEventLoopLagP99Ms: worst ? worst.probe.eventLoopLagMs.p99 : null,
  probeCpuPct: worst ? worst.probe.cpuPct : null,
  droppedFrames: artifact.steps.reduce((a, s) => a + s.probe.droppedFrames, 0),
  gateCount: allGates.length,
  gatePassed: Math.max(0, allGates.length - failures.length),
  failures: failures.map((f) => `${f.step}/${f.id}`),
};

artifact.finishedAt = nowIso();
artifact.result = failures.length ? 'FAIL' : 'PASS';

// "the probe, not the server, was the limiter" diagnostics
artifact.summary.probeLimited = artifact.steps.some((s) => s.probe.droppedFrames > 0
  || (s.probe.eventLoopLagMs && s.probe.eventLoopLagMs.p99 > 50)
  || (s.probe.cpuPct != null && s.probe.cpuPct > 85));

fs.mkdirSync(path.dirname(JSON_OUT), { recursive: true });
fs.writeFileSync(JSON_OUT, JSON.stringify(artifact, null, 2) + '\n', 'utf8');

console.log('\nSUMMARY');
console.log(`  maxClients=${artifact.summary.maxClients}  seated=${artifact.summary.seated}  MAX_DRIVERS=${artifact.summary.maxDrivers ?? '?'}`);
console.log(`  p95=${artifact.summary.p95Ms ?? 'n/a'}ms  p99=${artifact.summary.p99Ms ?? 'n/a'}ms  cadence=${artifact.summary.cadenceHz ?? 'n/a'}Hz`);
console.log(`  standings max=${artifact.summary.bytesPerStandingsFrame ?? 'n/a'}B  grid max=${artifact.summary.bytesPerGridFrame ?? 'n/a'}B  ${artifact.summary.bytesPerSecondPerClient ?? 'n/a'}B/s/client`);
console.log(`  server cpu=${artifact.summary.serverCpuPct ?? 'n/a'}%  probe lag p95=${artifact.summary.probeEventLoopLagP95Ms ?? 'n/a'}ms p99=${artifact.summary.probeEventLoopLagP99Ms ?? 'n/a'}ms  probe cpu=${artifact.summary.probeCpuPct ?? 'n/a'}%  dropped=${artifact.summary.droppedFrames}`);
if (artifact.summary.probeLimited) console.log('  WARN  probe-side limiter detected (dropped frames / event-loop lag > 50ms p99 / probe CPU > 85%) — treat server numbers with care');

console.log(`\nRESULT: ${artifact.result} - ${artifact.summary.gatePassed}/${artifact.summary.gateCount} gates passed`);
for (const f of failures) console.log(`  FAILED: ${f.step}/${f.id} :: ${f.detail}`);
console.log(`EVIDENCE: ${JSON_OUT}`);

process.exit(failures.length ? 1 : 0);
