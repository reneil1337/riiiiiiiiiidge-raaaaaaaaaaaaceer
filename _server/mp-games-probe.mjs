/* Multi-disc 2P lobby probe — raw WebSocket evidence for the /mp `game` contract.
 *
 * Proves the three-disc manifest and the head-to-head lobby protocol without a
 * browser and without booting any emulator:
 *   GET /mp-games.json shape, per-game track/car rolls, room `game`/`mode`,
 *   guest adoption of the room's disc, host-only `setgame`, invalid-key
 *   fallbacks, R4 legacy race field shape, identical payloads on both sockets,
 *   `trackSelection` on the room after the race, and room cleanup on leave.
 *
 * A throwaway cabinet is spawned on :8097 (RR4_PORT=8097,
 * RR4_NO_AUTOSTART=1) unless --base / MP_BASE names an instance. :8080 is
 * never touched, and only the child this probe spawned is killed.
 *
 * Writes ONE evidence file:
 *   _runtime/mp-games.json
 *
 * Run:  cd _server; node mp-games-probe.mjs
 * Optional: node mp-games-probe.mjs --base http://127.0.0.1:8080
 *           node mp-games-probe.mjs --port 8097 --keep
 */
import { randomInt } from 'node:crypto';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const OUT = path.join(ROOT, '_runtime');
const EVIDENCE = path.join(OUT, 'mp-games.json');

const argv = process.argv.slice(2);
function arg(name, def = null) {
  const i = argv.indexOf('--' + name);
  if (i === -1) return def;
  const v = argv[i + 1];
  return v && !v.startsWith('--') ? v : true;
}
const flag = (name) => argv.includes('--' + name);

const PORT = Number(arg('port', 8097) || 8097);
const BASE_ARG = typeof arg('base') === 'string' ? arg('base').replace(/\/+$/, '') : '';
const BASE_ENV = String(process.env.MP_BASE || '').replace(/\/+$/, '');
const BASE = BASE_ARG || BASE_ENV || `http://127.0.0.1:${PORT}`;
const WS_URL = BASE.replace(/^http/i, 'ws') + '/mp';
const SPAWN_OWN = !BASE_ARG && !BASE_ENV;
const KEEP = flag('keep');

const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const randomCode = () => Array.from({ length: 4 }, () => CODE_CHARS[randomInt(CODE_CHARS.length)]).join('');

// Reference arrays: the R4 lists this project shipped before the manifest, plus
// the disc track names the multi-disc contract fixes for Rage/Ridge.
const R4_TRACKS = ['Helter Skelter', 'Wonderhill', 'Edge of the Earth', 'Out of Blue',
  'Phantomile', 'Brightest Nite', 'Heaven and Hell', 'Shooting Hoops'];
const R4_CARS = ['D1', 'D2', 'D3', 'D4', 'G1', 'G2', 'G3', 'G4'];
const RAGE_TRACKS = ['Mythical Coast', 'Over Pass City', 'Lakeside Gate', 'The Extreme Oval'];
const RIDGE_TRACK = 'Seaside Route 765';

const checks = [];
const infos = [];
const check = (id, ok, detail = '') => {
  checks.push({ id, ok: !!ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${id}${detail ? ' :: ' + detail : ''}`);
  return !!ok;
};
const info = (id, detail = '') => {
  infos.push({ id, detail });
  console.log(`INFO  ${id}${detail ? ' :: ' + detail : ''}`);
};

/* ------------------------------------------------------------- instance --- */

const server = { spawned: false, reused: false, port: PORT, pid: 0, base: BASE, logPath: '', env: {} };

async function healthUp() {
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 2000);
    const res = await fetch(`${BASE}/api/health`, { signal: ctrl.signal });
    clearTimeout(timer);
    return res.ok;
  } catch { return false; }
}

async function manifestUp() {
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 2000);
    const res = await fetch(`${BASE}/mp-games.json`, { signal: ctrl.signal });
    clearTimeout(timer);
    return res.ok;
  } catch { return false; }
}

async function waitFor(fn, ms, label, step = 250) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await fn()) return true;
    await sleep(step);
  }
  throw new Error(`${label} not ready within ${ms}ms`);
}

async function startInstance() {
  if (!SPAWN_OWN) {
    await waitFor(healthUp, 20000, `${BASE} /api/health`, 250);
    server.reused = true;
    info('instance/attached', `--base ${BASE} (nothing spawned)`);
    return;
  }
  if (await healthUp()) {
    // Idempotent port: reuse the throwaway instance another run left behind.
    server.reused = true;
    info('instance/reused', `:${PORT} already answering /api/health (nothing spawned, nothing killed)`);
    return;
  }
  server.env = { RR4_PORT: String(PORT), RR4_NO_AUTOSTART: '1' };
  try { fs.mkdirSync(OUT, { recursive: true }); } catch { /* ignore */ }
  server.logPath = path.join(OUT, `mp-games-probe-server-${PORT}.log`);
  let logFd = null;
  try { logFd = fs.openSync(server.logPath, 'a'); } catch { logFd = null; }
  const child = spawn(process.execPath, ['src/server.js'], {
    cwd: HERE,
    env: { ...process.env, ...server.env },
    stdio: ['ignore', logFd === null ? 'pipe' : logFd, logFd === null ? 'pipe' : logFd],
    windowsHide: true,
    // Own process group so taskkill /T /PID reaps the whole tree; the probe
    // never touches an instance it did not spawn.
    detached: true,
  });
  if (logFd !== null) { try { fs.closeSync(logFd); } catch { /* child owns it */ } }
  server.spawned = true;
  server.pid = child.pid;
  child.on('exit', (code) => { server.exitCode = code; });
  if (child.stdout) child.stdout.on('data', () => {});
  if (child.stderr) child.stderr.on('data', () => {});
  child.unref();
  await waitFor(healthUp, 30000, `throwaway cabinet on :${PORT}`, 250);
  info('instance/spawned', `:${PORT} pid=${server.pid} RR4_NO_AUTOSTART=1`);
}

async function stopInstance() {
  if (!server.spawned || KEEP) return;
  await new Promise((resolve) => {
    try {
      const k = spawn('taskkill', ['/PID', String(server.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
      k.on('exit', resolve);
      k.on('error', resolve);
    } catch { resolve(); }
  });
  await sleep(300);
}

function logTail(n = 40) {
  try {
    return fs.readFileSync(server.logPath, 'utf8').split(/\r?\n/).filter((l) => l.trim()).slice(-n);
  } catch { return []; }
}

/* ------------------------------------------------------------ websocket --- */

function open(tag) {
  const ws = new WebSocket(WS_URL);
  const peer = { tag, ws, queue: [], waiters: [], types: [], raw: [] };
  ws.on('message', (data) => {
    let msg;
    try { msg = JSON.parse(data.toString('utf8')); } catch { return; }
    peer.types.push(msg.type);
    peer.raw.push(msg);
    peer.queue.push(msg);
    for (let i = 0; i < peer.waiters.length; i += 1) {
      const waiter = peer.waiters[i];
      const at = peer.queue.findIndex(waiter.match);
      if (at < 0) continue;
      const [delivered] = peer.queue.splice(at, 1);
      peer.waiters.splice(i, 1);
      i -= 1;
      clearTimeout(waiter.timer);
      waiter.resolve(delivered);
    }
  });
  ws.on('error', (err) => info(`${tag}/socket-error`, err.message));
  return peer;
}

function opened(peer, ms = 6000) {
  if (peer.ws.readyState === 1) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${peer.tag}: socket did not open within ${ms}ms`)), ms);
    peer.ws.once('open', () => { clearTimeout(timer); resolve(); });
    peer.ws.once('error', (err) => { clearTimeout(timer); reject(err); });
  });
}

function wait(peer, match, ms = 6000, label = 'message') {
  const at = peer.queue.findIndex(match);
  if (at >= 0) return Promise.resolve(peer.queue.splice(at, 1)[0]);
  return new Promise((resolve, reject) => {
    const waiter = { match, resolve, timer: null };
    waiter.timer = setTimeout(() => {
      const i = peer.waiters.indexOf(waiter);
      if (i >= 0) peer.waiters.splice(i, 1);
      reject(new Error(`${peer.tag}: timed out after ${ms}ms waiting for ${label}`));
    }, ms);
    peer.waiters.push(waiter);
  });
}

function drain(peer) {
  if (!peer) return;
  peer.queue.length = 0;
}

const send = (peer, msg) => {
  if (peer && peer.ws.readyState === 1) peer.ws.send(JSON.stringify(msg));
};
const isRoomOf = (n) => (m) => m.type === 'room' && Array.isArray(m.players) && m.players.length === n;
const isStartedRoom = (m) => m.type === 'room' && m.started === true;
const isRace = (m) => m.type === 'race';
const isError = (m) => m.type === 'error';
const carsKey = (cars) => JSON.stringify((cars || []).map((c) => [c.id, c.name, c.role, c.team, c.car, c.carIndex]));
const planKey = (p) => JSON.stringify([p.code, p.raceId, p.track, p.trackIndex, carsKey(p.cars), p.game, p.mode]);

async function connectPeer(tag) {
  const peer = open(tag);
  await opened(peer);
  const hello = await wait(peer, (m) => m.type === 'hello', 6000, `hello(${tag})`);
  peer.id = hello.id;
  peer.initialRooms = hello.rooms || [];
  return peer;
}

/* ---------------------------------------------------------------- state --- */

const evidence = {
  probe: 'mp-games',
  target: WS_URL,
  manifestUrl: `${BASE}/mp-games.json`,
  scopeNote: 'Manifest + /mp protocol only. No emulator boot, no browser, no Rage/Ridge in-game mode (R4 VS Battle macro is covered by mp-ws-probe / mp-macro-test, not here).',
  instance: server,
  startedAt: new Date().toISOString(),
  node: process.version,
  manifest: null,
  perGame: {},
  plans: {},
  errors: [],
  rooms: {},
  checks,
  infos,
  result: 'FAIL',
};

let host = null;
let guest = null;
let lister = null;

async function listRooms() {
  drain(lister);
  send(lister, { type: 'list' });
  const msg = await wait(lister, (m) => m.type === 'rooms', 5000, 'rooms(lister)');
  return Array.isArray(msg.rooms) ? msg.rooms : [];
}

// Authoritative room refresh without touching the disc: a `team` message makes
// the server re-broadcast mpRoomState(room), so a rejected setgame can prove it
// left the room unchanged.
async function refreshRoom() {
  const team = 'Solvalou';
  send(host, { type: 'team', team });
  const [hr, gr] = await Promise.all([
    wait(host, (m) => m.type === 'room', 5000, 'room(host refresh)'),
    wait(guest, (m) => m.type === 'room', 5000, 'room(guest refresh)'),
  ]);
  return { host: hr, guest: gr };
}

async function createRoom(code, game, name = 'PROBE-HOST') {
  const msg = { type: 'create', name, code };
  if (game !== undefined) msg.game = game;
  send(host, msg);
  const joined = await wait(host, (m) => m.type === 'joined', 6000, 'joined(host)');
  const room = await wait(host, isRoomOf(1), 6000, 'room(host,1)');
  return { joined, room, code: joined.code };
}

async function joinRoom(code, game, name = 'PROBE-GUEST') {
  const msg = { type: 'join', name, code };
  if (game !== undefined) msg.game = game;
  send(guest, msg);
  const joined = await wait(guest, (m) => m.type === 'joined', 6000, 'joined(guest)');
  const [hostRoom, guestRoom] = await Promise.all([
    wait(host, isRoomOf(2), 6000, 'room(host,2)'),
    wait(guest, isRoomOf(2), 6000, 'room(guest,2)'),
  ]);
  return { joined, hostRoom, guestRoom };
}

async function bothReady() {
  send(host, { type: 'ready', ready: true });
  await Promise.all([
    wait(host, (m) => m.type === 'room' && Array.isArray(m.players) && m.players.some((p) => p.id === host.id && p.ready), 6000, 'room(host ready)'),
    wait(guest, (m) => m.type === 'room' && Array.isArray(m.players) && m.players.some((p) => p.id === host.id && p.ready), 6000, 'room(guest sees host ready)'),
  ]);
  const hostRaceP = wait(host, isRace, 8000, 'race(host)');
  const guestRaceP = wait(guest, isRace, 8000, 'race(guest)');
  send(guest, { type: 'ready', ready: true });
  const [hostRace, guestRace] = await Promise.all([hostRaceP, guestRaceP]);
  const [hostRoom, guestRoom] = await Promise.all([
    wait(host, isStartedRoom, 6000, 'room(started,host)'),
    wait(guest, isStartedRoom, 6000, 'room(started,guest)'),
  ]);
  return { hostRace, guestRace, hostRoom, guestRoom };
}

async function teardown() {
  if (host && host.ws.readyState === 1) {
    send(host, { type: 'leave' });
    await wait(host, (m) => m.type === 'left', 4000, 'left(host)').catch(() => null);
  }
  if (guest && guest.ws.readyState === 1) {
    send(guest, { type: 'leave' });
    await wait(guest, (m) => m.type === 'left', 4000, 'left(guest)').catch(() => null);
  }
  await sleep(250);
  drain(host);
  drain(guest);
}

/* ----------------------------------------------------------------- run --- */

try {
  await startInstance();
  await waitFor(manifestUp, 20000, `${BASE}/mp-games.json`, 250);

  // ---- 01/02: manifest ---------------------------------------------------
  const res = await fetch(`${BASE}/mp-games.json`);
  const manifest = await res.json();
  const gameKeys = Object.keys(manifest.games || {}).sort();
  evidence.manifest = {
    status: res.status,
    ok: res.ok,
    version: manifest.version,
    defaultGame: manifest.defaultGame,
    keys: gameKeys,
  };
  check('01-manifest/endpoint',
    res.status === 200 && manifest.defaultGame === 'r4'
      && JSON.stringify(gameKeys) === JSON.stringify(['r4', 'rage', 'ridge']),
    `HTTP ${res.status} defaultGame=${manifest.defaultGame} keys=${gameKeys.join(',')}`);

  for (const key of gameKeys) {
    const g = manifest.games[key] || {};
    evidence.perGame[key] = {
      id: g.id,
      name: g.name,
      short: g.short,
      roomPrefix: g.roomPrefix,
      mode: g.mode,
      modeLabel: g.modeLabel,
      guestPlayerIndex: g.guestPlayerIndex,
      macro: g.macro,
      macroVerified: g.macroVerified,
      trackSelect: g.trackSelect,
      evidence: g.evidence,
      trackCount: (g.tracks || []).length,
      carCount: (g.cars || []).length,
      tracks: (g.tracks || []).map((t) => t.name),
      cars: (g.cars || []).map((c) => c.name),
    };
  }
  const r4 = evidence.perGame.r4 || {};
  const rage = evidence.perGame.rage || {};
  const ridge = evidence.perGame.ridge || {};
  check('02-manifest/game-data',
    JSON.stringify(r4.tracks) === JSON.stringify(R4_TRACKS)
      && JSON.stringify(r4.cars) === JSON.stringify(R4_CARS)
      && r4.trackCount === 8 && r4.carCount === 8
      && rage.trackCount === 4 && rage.carCount === 4
      && JSON.stringify(rage.tracks) === JSON.stringify(RAGE_TRACKS)
      && ridge.trackCount === 1 && ridge.carCount === 4
      && (ridge.tracks || [])[0] === RIDGE_TRACK,
    `r4 ${r4.trackCount}t/${r4.carCount}c, rage ${rage.trackCount}t/${rage.carCount}c, ridge ${ridge.trackCount}t/${ridge.carCount}c`);

  host = await connectPeer('host');
  guest = await connectPeer('guest');
  lister = await connectPeer('lister');
  info('sockets', `host=${host.id} guest=${guest.id} lister=${lister.id}`);

  // ---- scenario A: default create (no game) -> r4 versus ----------------
  evidence.rooms.default = randomCode();
  const A = await createRoom(evidence.rooms.default);
  const joinA = await joinRoom(A.code);
  const raceA = await bothReady();
  const hostRaceA = raceA.hostRace;
  const guestRaceA = raceA.guestRace;
  check('03-create/default-r4',
    A.room.game === 'r4' && A.room.mode === 'versus'
      && joinA.hostRoom.mode === 'versus' && joinA.guestRoom.game === 'r4'
      && hostRaceA.guestPlayerIndex === 1 && guestRaceA.guestPlayerIndex === 1,
    `game=${A.room.game} mode=${A.room.mode} guestPlayerIndex=${hostRaceA.guestPlayerIndex} code=${A.code}`);
  evidence.plans.r4 = {
    code: hostRaceA.code, raceId: hostRaceA.raceId, game: hostRaceA.game, mode: hostRaceA.mode,
    guestPlayerIndex: hostRaceA.guestPlayerIndex, track: hostRaceA.track,
    trackIndex: hostRaceA.trackIndex, trackCount: hostRaceA.trackCount,
    carCount: hostRaceA.carCount, trackSelection: hostRaceA.trackSelection,
    cars: hostRaceA.cars,
  };

  // ---- 13: the old race field shape survives ----------------------------
  const legacyKeys = ['type', 'code', 'raceId', 'track', 'trackIndex', 'cars'];
  const newKeys = ['game', 'mode', 'guestPlayerIndex', 'trackSelection', 'trackCount', 'carCount'];
  const missingLegacy = legacyKeys.filter((k) => hostRaceA[k] === undefined || hostRaceA[k] === null);
  const missingNew = newKeys.filter((k) => hostRaceA[k] === undefined || hostRaceA[k] === null);
  const carsShapeOk = Array.isArray(hostRaceA.cars) && hostRaceA.cars.length === 2
    && hostRaceA.cars.every((c) => typeof c.id === 'string' && typeof c.name === 'string'
      && typeof c.role === 'string' && typeof c.car === 'string' && Number.isInteger(c.carIndex));
  check('13-race/r4-legacy-shape',
    hostRaceA.type === 'race' && typeof hostRaceA.code === 'string' && hostRaceA.code.length === 4
      && typeof hostRaceA.raceId === 'string' && hostRaceA.raceId.length > 0
      && typeof hostRaceA.track === 'string' && hostRaceA.track.length > 0
      && Number.isInteger(hostRaceA.trackIndex) && hostRaceA.trackIndex >= 0 && hostRaceA.trackIndex <= 7
      && carsShapeOk && !missingLegacy.length && !missingNew.length,
    `missing=${[...missingLegacy, ...missingNew].join(',') || 'none'} cars=${(hostRaceA.cars || []).length}`);

  // ---- 14: identical payloads ------------------------------------------
  check('14-race/identical-payloads',
    planKey(hostRaceA) === planKey(guestRaceA)
      && hostRaceA.role === 'host' && guestRaceA.role === 'guest',
    `code=${hostRaceA.code} raceId=${hostRaceA.raceId} track=${hostRaceA.track}/${hostRaceA.trackIndex}`);

  // ---- 15: room state after the race ------------------------------------
  check('15-room/track-selection',
    raceA.hostRoom && raceA.hostRoom.started === true
      && raceA.hostRoom.trackSelection === 'auto' && raceA.hostRoom.game === 'r4'
      && raceA.guestRoom && raceA.guestRoom.trackSelection === 'auto',
    `trackSelection=${raceA.hostRoom && raceA.hostRoom.trackSelection} started=${raceA.hostRoom && raceA.hostRoom.started}`);
  await teardown();

  // ---- scenario B: rage room + setgame rules ----------------------------
  evidence.rooms.rage = randomCode();
  const B = await createRoom(evidence.rooms.rage, 'rage');
  const listB = await listRooms();
  const entryB = listB.find((r) => r.code === B.code) || null;
  check('04-create/rage',
    B.room.game === 'rage' && B.room.mode === 'shared-car'
      && B.room.modeLabel === 'SHARED CAR'
      && !!entryB && entryB.game === 'rage' && entryB.mode === 'shared-car',
    `room=${B.room.game}/${B.room.mode} list=${entryB ? `${entryB.game}/${entryB.mode}` : '(missing)'}`);
  // 09: host setgame before ready changes room + list; the guest adopts it on join.
  send(host, { type: 'setgame', game: 'ridge' });
  const setHost = await wait(host, (m) => m.type === 'room' && m.game === 'ridge', 6000, 'room(host,ridge)');
  const listB2 = await listRooms();
  const entryB2 = listB2.find((r) => r.code === B.code) || null;
  const joinB = await joinRoom(B.code);
  check('09-setgame/host-before-ready',
    setHost.game === 'ridge' && setHost.mode === 'shared-car'
      && !!entryB2 && entryB2.game === 'ridge' && entryB2.mode === 'shared-car'
      && joinB.guestRoom.game === 'ridge',
    `host=${setHost.game} list=${entryB2 ? entryB2.game : '(missing)'} guest-after-join=${joinB.guestRoom.game}`);

  // 10: guest setgame -> error, room unchanged
  let guestErr = null;
  try {
    send(guest, { type: 'setgame', game: 'rage' });
    guestErr = await wait(guest, isError, 5000, 'error(guest setgame)');
  } catch (err) {
    guestErr = { message: `no error frame: ${err.message}` };
  }
  const afterGuest = await refreshRoom();
  evidence.errors.push({ check: '10-setgame/guest-rejected', message: guestErr.message });
  check('10-setgame/guest-rejected',
    /host/i.test(String(guestErr.message || ''))
      && afterGuest.host.game === 'ridge' && afterGuest.guest.game === 'ridge',
    `error="${guestErr.message}" game after=${afterGuest.host.game}`);

  // 12: unknown key -> error, room unchanged
  let unknownErr = null;
  try {
    send(host, { type: 'setgame', game: 'n64' });
    unknownErr = await wait(host, isError, 5000, 'error(host setgame n64)');
  } catch (err) {
    unknownErr = { message: `no error frame: ${err.message}` };
  }
  const afterUnknown = await refreshRoom();
  evidence.errors.push({ check: '12-setgame/unknown-key', message: unknownErr.message });
  check('12-setgame/unknown-key',
    /unknown/i.test(String(unknownErr.message || ''))
      && afterUnknown.host.game === 'ridge' && afterUnknown.guest.game === 'ridge',
    `error="${unknownErr.message}" game after=${afterUnknown.host.game}`);

  // Back to rage for the per-game roll check.
  send(host, { type: 'setgame', game: 'rage' });
  await Promise.all([
    wait(host, (m) => m.type === 'room' && m.game === 'rage', 6000, 'room(host,rage)'),
    wait(guest, (m) => m.type === 'room' && m.game === 'rage', 6000, 'room(guest,rage)'),
  ]);

  // 05: rage both-ready race
  const raceB = await bothReady();
  const hostRaceB = raceB.hostRace;
  const guestRaceB = raceB.guestRace;
  evidence.plans.rage = {
    code: hostRaceB.code, raceId: hostRaceB.raceId, game: hostRaceB.game, mode: hostRaceB.mode,
    guestPlayerIndex: hostRaceB.guestPlayerIndex, track: hostRaceB.track,
    trackIndex: hostRaceB.trackIndex, trackCount: hostRaceB.trackCount,
    carCount: hostRaceB.carCount, trackSelection: hostRaceB.trackSelection,
    cars: hostRaceB.cars,
  };
  const ragePlanSame = planKey(hostRaceB) === planKey(guestRaceB);
  check('05-race/rage',
    hostRaceB.game === 'rage' && hostRaceB.mode === 'shared-car'
      && hostRaceB.guestPlayerIndex === 0
      && hostRaceB.trackCount === 4 && hostRaceB.carCount === 4
      && RAGE_TRACKS.includes(hostRaceB.track)
      && Number.isInteger(hostRaceB.trackIndex) && hostRaceB.trackIndex >= 0 && hostRaceB.trackIndex <= 3
      && (hostRaceB.cars || []).every((c) => /^CAR [1-4]$/.test(String(c.car)))
      && ragePlanSame,
    `game=${hostRaceB.game} mode=${hostRaceB.mode} guestIndex=${hostRaceB.guestPlayerIndex} track=${hostRaceB.track}/${hostRaceB.trackIndex} cars=${(hostRaceB.cars || []).map((c) => c.car).join(',')} samePlan=${ragePlanSame}`);

  // 11: setgame after the grid locks -> error, unchanged
  let lockedErr = null;
  try {
    send(host, { type: 'setgame', game: 'ridge' });
    lockedErr = await wait(host, isError, 5000, 'error(host setgame locked)');
  } catch (err) {
    lockedErr = { message: `no error frame: ${err.message}` };
  }
  const afterLocked = await refreshRoom();
  evidence.errors.push({ check: '11-setgame/after-lock', message: lockedErr.message });
  check('11-setgame/after-lock',
    /(grid|lock)/i.test(String(lockedErr.message || ''))
      && afterLocked.host.game === 'rage' && afterLocked.host.started === true,
    `error="${lockedErr.message}" game after=${afterLocked.host.game} started=${afterLocked.host.started}`);
  await teardown();

  // ---- scenario C: ridge roll -------------------------------------------
  evidence.rooms.ridge = randomCode();
  const C = await createRoom(evidence.rooms.ridge, 'ridge');
  await joinRoom(C.code);
  const raceC = await bothReady();
  const hostRaceC = raceC.hostRace;
  evidence.plans.ridge = {
    code: hostRaceC.code, raceId: hostRaceC.raceId, game: hostRaceC.game, mode: hostRaceC.mode,
    guestPlayerIndex: hostRaceC.guestPlayerIndex, track: hostRaceC.track,
    trackIndex: hostRaceC.trackIndex, trackCount: hostRaceC.trackCount,
    carCount: hostRaceC.carCount, trackSelection: hostRaceC.trackSelection,
    cars: hostRaceC.cars,
  };
  check('06-race/ridge',
    hostRaceC.game === 'ridge' && hostRaceC.mode === 'shared-car'
      && hostRaceC.trackCount === 1 && hostRaceC.trackIndex === 0
      && hostRaceC.track === RIDGE_TRACK && hostRaceC.carCount === 4
      && (hostRaceC.cars || []).every((c) => ['Solvalou', 'Mappy', 'Bosconian', 'Nebulasray'].includes(String(c.car)))
      && planKey(hostRaceC) === planKey(raceC.guestRace),
    `game=${hostRaceC.game} track=${hostRaceC.track}/${hostRaceC.trackIndex} trackCount=${hostRaceC.trackCount} cars=${(hostRaceC.cars || []).map((c) => c.car).join(',')}`);
  await teardown();

  // ---- 07: invalid create game falls back to r4 -------------------------
  evidence.rooms.invalid = randomCode();
  const D = await createRoom(evidence.rooms.invalid, 'n64');
  check('07-create/invalid-game-fallback',
    D.room.game === 'r4' && D.room.mode === 'versus',
    `create game=n64 -> game=${D.room.game} mode=${D.room.mode}`);
  await teardown();

  // ---- 08: guest adopts the room's disc --------------------------------
  evidence.rooms.adopt = randomCode();
  const E = await createRoom(evidence.rooms.adopt, 'r4');
  const joinE = await joinRoom(E.code, 'ridge');
  const raceE = await bothReady();
  check('08-join/guest-adopts-room-game',
    E.room.game === 'r4'
      && joinE.guestRoom.game === 'r4' && joinE.hostRoom.game === 'r4'
      && raceE.hostRace.game === 'r4' && raceE.guestRace.game === 'r4'
      && planKey(raceE.hostRace) === planKey(raceE.guestRace),
    `host room=${E.room.game} guest room=${joinE.guestRoom.game} race=${raceE.hostRace.game}/${raceE.guestRace.game} samePlan=${planKey(raceE.hostRace) === planKey(raceE.guestRace)}`);

  // ---- 16: cleanup ------------------------------------------------------
  const finalCode = E.code;
  await teardown();
  const listAfter = await listRooms();
  check('16-cleanup/room-gone',
    !listAfter.some((r) => r.code === finalCode),
    `${listAfter.length} room(s) open after both seats left (code ${finalCode})`);
} catch (err) {
  const message = err && err.message ? err.message : String(err);
  evidence.error = err && err.stack ? err.stack : message;
  checks.push({ id: 'probe/flow', ok: false, detail: message });
  console.log(`FAIL  probe/flow :: ${message}`);
} finally {
  await teardown().catch(() => {});
  for (const peer of [host, guest, lister]) {
    if (!peer) continue;
    try { peer.ws.terminate(); } catch { /* ignore */ }
  }
  evidence.serverLogTail = logTail();
  await stopInstance();
}

const failed = checks.filter((c) => !c.ok);
evidence.finishedAt = new Date().toISOString();
evidence.result = failed.length ? 'FAIL' : 'PASS';
evidence.transcript = {
  host: host ? host.types : [],
  guest: guest ? guest.types : [],
  lister: lister ? lister.types : [],
};

await mkdir(OUT, { recursive: true });
await writeFile(EVIDENCE, JSON.stringify(evidence, null, 2) + '\n', 'utf8');

console.log('');
console.log(`RESULT: ${evidence.result} - ${checks.length - failed.length}/${checks.length} checks passed`);
for (const f of failed) console.log(`  FAILED: ${f.id} :: ${f.detail}`);
console.log(`EVIDENCE: ${EVIDENCE}`);
process.exit(failed.length ? 1 : 0);
