/* R4 2P lobby transport probe — raw WebSocket evidence for /mp.
 *
 * Proves the head-to-head lobby handshake against a running cabinet:
 *   host hello -> create -> guest hello -> join -> both ready -> both get `race`
 * with the same code/raceId/track/trackIndex/cars and per-socket roles.
 * Also records: hello.id, app-level {type:"ping"} reply, protocol pong,
 * server-initiated heartbeat ping, and that the room is gone after leave.
 *
 * Read-only against the server (no restarts). Writes ONE evidence file:
 *   _runtime/mp-lobby-ws.json
 *
 * Run:  cd _server; node mp-ws-probe.mjs
 * Optional: MP_BASE=http://127.0.0.1:8080 node mp-ws-probe.mjs
 */
import { randomInt } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const EVIDENCE = path.join(ROOT, '_runtime', 'mp-lobby-ws.json');
const BASE = (process.env.MP_BASE || 'http://127.0.0.1:8080').replace(/\/+$/, '');
const WS_URL = BASE.replace(/^http/i, 'ws') + '/mp';
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

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

function open(tag) {
  const ws = new WebSocket(WS_URL);
  const peer = {
    tag, ws, queue: [], waiters: [], types: [], raw: [],
    serverPings: 0, protocolPongs: 0, connectedAt: 0, firstServerPingAt: 0,
  };
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
  ws.on('ping', () => {
    peer.serverPings += 1;
    if (!peer.firstServerPingAt) peer.firstServerPingAt = Date.now();
  });
  ws.on('pong', () => { peer.protocolPongs += 1; });
  ws.on('open', () => { peer.connectedAt = Date.now(); });
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

const send = (peer, msg) => peer.ws.send(JSON.stringify(msg));
const isRoomOf = (n) => (m) => m.type === 'room' && Array.isArray(m.players) && m.players.length === n;
const isReadyOf = (id) => (m) => m.type === 'room' && Array.isArray(m.players)
  && m.players.some((p) => p.id === id && p.ready);
const carsKey = (cars) => JSON.stringify((cars || []).map((c) => [c.id, c.name, c.role, c.team, c.car, c.carIndex]));
const randomCode = () => Array.from({ length: 4 }, () => CODE_CHARS[randomInt(CODE_CHARS.length)]).join('');

const evidence = {
  probe: 'mp-lobby-ws',
  target: WS_URL,
  startedAt: new Date().toISOString(),
  node: process.version,
  checks,
  infos,
  hello: null,
  room: null,
  race: null,
  ping: {},
  transcript: null,
  result: 'FAIL',
};

let host = null;
let guest = null;
let watcher = null;
let code = '';

try {
  host = open('host');
  guest = open('guest');
  await Promise.all([opened(host), opened(guest)]);

  const hostHello = await wait(host, (m) => m.type === 'hello', 6000, 'hello(host)');
  const guestHello = await wait(guest, (m) => m.type === 'hello', 6000, 'hello(guest)');
  evidence.hello = { host: hostHello, guest: guestHello };

  check('hello/host-id', typeof hostHello.id === 'string' && hostHello.id.length > 0, `id=${hostHello.id}`);
  check('hello/guest-id', typeof guestHello.id === 'string' && guestHello.id.length > 0 && guestHello.id !== hostHello.id, `id=${guestHello.id}`);
  check('hello/rooms-array', Array.isArray(hostHello.rooms), `${(hostHello.rooms || []).length} open room(s)`);

  const taken = new Set((hostHello.rooms || []).map((r) => r.code));
  for (let i = 0; i < 8 && !code; i += 1) {
    const candidate = randomCode();
    if (!taken.has(candidate)) code = candidate;
  }
  if (!code) code = randomCode();
  evidence.code = code;
  info('room-code', code);

  // ---- host create ----
  send(host, { type: 'create', name: 'PROBE-HOST', code });
  const hostJoined = await wait(host, (m) => m.type === 'joined', 6000, 'joined(host)');
  check('create/host-joined', hostJoined.code === code && hostJoined.role === 'host', JSON.stringify(hostJoined));
  check('create/host-id-stable', hostJoined.id === hostHello.id, `joined.id=${hostJoined.id}`);
  const hostRoom1 = await wait(host, isRoomOf(1), 6000, 'room(host,1)');
  check('create/room-one-player',
    hostRoom1.players[0].id === hostHello.id && hostRoom1.players[0].role === 'host' && hostRoom1.started === false,
    JSON.stringify(hostRoom1.players));

  // ---- guest join ----
  send(guest, { type: 'join', name: 'PROBE-GUEST', code });
  const guestJoined = await wait(guest, (m) => m.type === 'joined', 6000, 'joined(guest)');
  check('join/guest-joined', guestJoined.code === code && guestJoined.role === 'guest', JSON.stringify(guestJoined));

  const [guestRoom2, hostRoom2] = await Promise.all([
    wait(guest, isRoomOf(2), 6000, 'room(guest,2)'),
    wait(host, isRoomOf(2), 6000, 'room(host,2)'),
  ]);
  evidence.room = { hostSees: hostRoom2, guestSees: guestRoom2 };

  const seatHost = (hostRoom2.players || []).find((p) => p.id === hostHello.id) || {};
  const seatGuest = (hostRoom2.players || []).find((p) => p.id === guestHello.id) || {};
  check('room/roles', seatHost.role === 'host' && seatGuest.role === 'guest' && hostRoom2.host === hostHello.id,
    `host-slot=${seatHost.role} guest-slot=${seatGuest.role}`);
  check('room/guest-view-matches', JSON.stringify(guestRoom2.players) === JSON.stringify(hostRoom2.players),
    `${(guestRoom2.players || []).length} players`);

  // ---- host ready only: no race yet ----
  send(host, { type: 'ready', ready: true });
  await Promise.all([
    wait(host, isReadyOf(hostHello.id), 6000, 'room(host ready)'),
    wait(guest, isReadyOf(hostHello.id), 6000, 'room(guest sees host ready)'),
  ]);
  check('ready/host-flag', true, 'both sockets saw host ready=true');
  check('ready/no-early-race',
    !host.raw.some((m) => m.type === 'race') && !guest.raw.some((m) => m.type === 'race'),
    'no race before the guest is ready');

  // ---- guest ready -> both receive race ----
  const hostRaceP = wait(host, (m) => m.type === 'race', 8000, 'race(host)');
  const guestRaceP = wait(guest, (m) => m.type === 'race', 8000, 'race(guest)');
  send(guest, { type: 'ready', ready: true });
  const [hostRace, guestRace] = await Promise.all([hostRaceP, guestRaceP]);
  evidence.race = { host: hostRace, guest: guestRace };

  const codeOk = hostRace.code === code && guestRace.code === code;
  const raceIdOk = typeof hostRace.raceId === 'string' && hostRace.raceId.length > 0 && hostRace.raceId === guestRace.raceId;
  const trackOk = typeof hostRace.track === 'string' && hostRace.track.length > 0 && hostRace.track === guestRace.track;
  const indexOk = Number.isInteger(hostRace.trackIndex) && hostRace.trackIndex >= 0 && hostRace.trackIndex <= 7
    && hostRace.trackIndex === guestRace.trackIndex;

  check('race/host-role', hostRace.role === 'host', `role=${hostRace.role}`);
  check('race/guest-role', guestRace.role === 'guest', `role=${guestRace.role}`);
  check('race/code', codeOk, `host=${hostRace.code} guest=${guestRace.code}`);
  check('race/raceId', raceIdOk, `raceId=${hostRace.raceId}`);
  check('race/track', trackOk, `track=${hostRace.track}`);
  check('race/trackIndex', indexOk, `trackIndex host=${hostRace.trackIndex} guest=${guestRace.trackIndex}`);
  check('race/cars-identical',
    Array.isArray(hostRace.cars) && hostRace.cars.length === 2 && carsKey(hostRace.cars) === carsKey(guestRace.cars),
    `${(hostRace.cars || []).length} car slot(s)`);

  const carHostSlot = (hostRace.cars || []).find((c) => c.role === 'host') || {};
  const carGuestSlot = (hostRace.cars || []).find((c) => c.role === 'guest') || {};
  check('race/cars-roles',
    carHostSlot.id === hostHello.id && carGuestSlot.id === guestHello.id
      && typeof carHostSlot.car === 'string' && typeof carGuestSlot.car === 'string',
    `host=${carHostSlot.car} guest=${carGuestSlot.car}`);

  const [hostRaceRoom, guestRaceRoom] = await Promise.all([
    wait(host, (m) => m.type === 'room' && m.started === true, 6000, 'room(started,host)'),
    wait(guest, (m) => m.type === 'room' && m.started === true, 6000, 'room(started,guest)'),
  ]);
  check('race/room-started-flag',
    hostRaceRoom.started === true && guestRaceRoom.started === true && hostRaceRoom.track === hostRace.track,
    `started=${hostRaceRoom.started} track=${hostRaceRoom.track}`);

  // ---- app-level ping (may not exist on this build) ----
  const appPingAt = Date.now();
  const pongP = wait(host, (m) => m.type === 'pong', 2500, 'pong').catch(() => null);
  send(host, { type: 'ping', t: appPingAt });
  const pong = await pongP;
  const pongRtt = pong ? Date.now() - appPingAt : null;
  evidence.ping.appLevel = { sent: true, responded: !!pong, rttMs: pongRtt, reply: pong };
  if (pong) info('ping/app-level', `pong in ${pongRtt}ms :: ${JSON.stringify(pong)}`);
  else info('ping/app-level', 'no {type:"pong"} within 2500ms (this build has no /mp ping handler)');

  // ---- protocol-level ping (ws library auto-pong) ----
  const protoBefore = host.protocolPongs;
  host.ws.ping();
  await sleep(1200);
  const protoDelta = host.protocolPongs - protoBefore;
  evidence.ping.protocol = { sent: true, pongs: protoDelta, responded: protoDelta > 0 };
  check('ping/protocol-pong', protoDelta > 0, `${protoDelta} pong frame(s) within 1200ms`);

  // ---- server-initiated heartbeat ping ----
  const heartbeatWait = 22000;
  const heartbeatStart = Date.now();
  while (host.serverPings === 0 && Date.now() - heartbeatStart < heartbeatWait) await sleep(250);
  const heartbeatMs = host.serverPings ? host.firstServerPingAt - (host.connectedAt || heartbeatStart) : null;
  evidence.ping.serverHeartbeat = {
    pings: host.serverPings, firstAfterMs: heartbeatMs, waitedMs: Date.now() - heartbeatStart, seen: host.serverPings > 0,
  };
  if (host.serverPings > 0) info('heartbeat/server-ping', `${host.serverPings} server ping frame(s), first after ${heartbeatMs}ms`);
  else info('heartbeat/server-ping', `no server-initiated ping within ${heartbeatWait}ms (dead sockets only reaped on close)`);

  // ---- leave / cleanup ----
  send(host, { type: 'leave' });
  send(guest, { type: 'leave' });
  await Promise.all([
    wait(host, (m) => m.type === 'left', 4000, 'left(host)').catch(() => null),
    wait(guest, (m) => m.type === 'left', 4000, 'left(guest)').catch(() => null),
  ]);
  host.ws.close();
  guest.ws.close();
  await sleep(400);

  watcher = open('watcher');
  await opened(watcher);
  const watcherHello = await wait(watcher, (m) => m.type === 'hello', 6000, 'hello(watcher)');
  check('cleanup/room-gone', !(watcherHello.rooms || []).some((r) => r.code === code),
    `${(watcherHello.rooms || []).length} room(s) open after leave`);
  watcher.ws.close();
} catch (err) {
  const message = err && err.message ? err.message : String(err);
  evidence.error = err && err.stack ? err.stack : message;
  checks.push({ id: 'probe/flow', ok: false, detail: message });
  console.log(`FAIL  probe/flow :: ${message}`);
} finally {
  for (const peer of [host, guest, watcher]) {
    if (!peer) continue;
    try { peer.ws.terminate(); } catch { /* ignore */ }
  }
}

const failed = checks.filter((c) => !c.ok);
evidence.finishedAt = new Date().toISOString();
evidence.result = failed.length ? 'FAIL' : 'PASS';
evidence.transcript = {
  host: host ? host.types : [],
  guest: guest ? guest.types : [],
  watcher: watcher ? watcher.types : [],
};

await mkdir(path.dirname(EVIDENCE), { recursive: true });
await writeFile(EVIDENCE, JSON.stringify(evidence, null, 2) + '\n', 'utf8');

console.log('');
console.log(`RESULT: ${evidence.result} - ${checks.length - failed.length}/${checks.length} checks passed`);
for (const f of failed) console.log(`  FAILED: ${f.id} :: ${f.detail}`);
console.log(`EVIDENCE: ${EVIDENCE}`);
process.exit(failed.length ? 1 : 0);