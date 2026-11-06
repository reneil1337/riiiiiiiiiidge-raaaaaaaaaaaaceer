// Throwaway probe for the /mp heartbeat, host handoff and room cleanup.
// Usage: node mp-heartbeat-probe.mjs [port]
// Start the server it probes with:
//   $env:RR4_PORT='8091'; $env:RR4_NO_AUTOSTART='1'; $env:RR4_STREAM_SOURCE='test'; node src/server.js
import WebSocket from 'ws';

const port = Number(process.argv[2] || process.env.RR4_PORT || 8091);
const base = `ws://127.0.0.1:${port}/mp`;
const results = [];
let failures = 0;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function check(name, ok, detail = '') {
  results.push(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures++;
}

function connect(label, options) {
  const ws = new WebSocket(base, options);
  ws.label = label;
  ws.inbox = [];
  ws.waiters = [];
  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString('utf8')); } catch { return; }
    ws.inbox.push(msg);
    for (const waiter of [...ws.waiters]) {
      if (!waiter.match(msg)) continue;
      ws.waiters.splice(ws.waiters.indexOf(waiter), 1);
      waiter.resolve(msg);
    }
  });
  return new Promise((resolve, reject) => {
    ws.once('open', () => resolve(ws));
    ws.once('error', reject);
  });
}

function waitFor(ws, match, ms = 5000) {
  const hit = ws.inbox.find(match);
  if (hit) return Promise.resolve(hit);
  return new Promise((resolve, reject) => {
    const entry = { match, resolve: null };
    const timer = setTimeout(() => {
      ws.waiters = ws.waiters.filter((w) => w !== entry);
      reject(new Error(`timeout (${ms}ms) waiting on ${ws.label}`));
    }, ms);
    entry.resolve = (msg) => { clearTimeout(timer); resolve(msg); };
    ws.waiters.push(entry);
  });
}

function send(ws, obj) { ws.send(JSON.stringify(obj)); }

// ask() clears the inbox first so a stale broadcast cannot satisfy the wait.
async function ask(ws, obj, match, ms = 5000) {
  ws.inbox.length = 0;
  send(ws, obj);
  return waitFor(ws, match, ms);
}

const roomsWith = (code) => (m) => m.type === 'rooms' && m.rooms.some((r) => r.code === code);
const noRooms = (m) => m.type === 'rooms' && m.rooms.length === 0;

const code = `P${Math.random().toString(36).slice(2, 5).toUpperCase()}`;
const sockets = [];
let host;
let guest;
let observer;

try {
  // 1. host creates a room
  host = await connect('host');
  sockets.push(host);
  await waitFor(host, (m) => m.type === 'hello');
  const created = await ask(host, { type: 'create', code, name: 'PROBE-HOST' },
    (m) => m.type === 'joined');
  check('host create -> joined as host', created.role === 'host', `code=${created.code} role=${created.role}`);

  // 2. guest joins
  guest = await connect('guest');
  sockets.push(guest);
  await waitFor(guest, (m) => m.type === 'hello');
  const joined = await ask(guest, { type: 'join', code, name: 'PROBE-GUEST' },
    (m) => m.type === 'joined');
  const guestId = joined.id;
  check('guest join -> joined as guest', joined.role === 'guest', `code=${joined.code} role=${joined.role}`);

  // 3. application-level ping/pong
  const pong = await ask(guest, { type: 'ping' }, (m) => m.type === 'pong', 3000);
  check('ping -> pong with at', typeof pong.at === 'number', `at=${pong.at}`);

  // 4. a full room is not listed
  observer = await connect('observer');
  sockets.push(observer);
  await waitFor(observer, (m) => m.type === 'hello');
  const fullList = await ask(observer, { type: 'list' }, (m) => m.type === 'rooms');
  check('full room hidden from lobby list', !fullList.rooms.some((r) => r.code === code),
    `listed=[${fullList.rooms.map((r) => `${r.code}:${r.players}`).join(',')}]`);

  // 5. host socket dies hard (no close frame) -> guest is promoted
  host.terminate();
  const promoted = await waitFor(guest, (m) => m.type === 'room' && m.host === guestId, 8000);
  check('guest promoted to host after host death',
    promoted.host === guestId && promoted.players.length === 1 &&
    promoted.players[0].role === 'host',
    `host=${promoted.host} players=${promoted.players.map((p) => `${p.name}:${p.role}`).join(',')}`);

  const singleList = await ask(observer, { type: 'list' }, roomsWith(code), 5000);
  const listed = singleList.rooms.filter((r) => r.code === code);
  check('room still lists exactly once with 1 player',
    listed.length === 1 && listed[0].players === 1,
    `listed=${listed.map((r) => `${r.code}:${r.players}`).join(',')}`);

  // 6. last player leaves -> room disappears from the lobby list
  guest.inbox.length = 0;
  guest.close();
  const emptyList = await ask(observer, { type: 'list' }, noRooms, 8000);
  check('room disappears after last player leaves', emptyList.rooms.length === 0,
    `listed=[${emptyList.rooms.map((r) => `${r.code}:${r.players}`).join(',')}]`);

  // 7. heartbeat: a socket that never answers a protocol-level ping is
  // terminated, and its room is cleaned up with it. One ping interval marks it
  // dead, the next one terminates, so allow ~2 x 20s plus slack.
  const zombieCode = `Z${Math.random().toString(36).slice(2, 5).toUpperCase()}`;
  const zombie = await connect('zombie', { autoPong: false });
  sockets.push(zombie);
  const zombieCreated = await ask(zombie, { type: 'create', code: zombieCode, name: 'PROBE-ZOMBIE' },
    (m) => m.type === 'joined');
  check('zombie room created', zombieCreated.code === zombieCode, `code=${zombieCreated.code}`);
  const zombieClosed = await new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), 50000);
    zombie.once('close', () => { clearTimeout(timer); resolve('closed'); });
  });
  check('silent socket terminated by heartbeat', zombieClosed === 'closed',
    `closed=${zombieClosed} (interval ${20}s x2)`);
  const zombieList = await ask(observer, { type: 'list' }, noRooms, 8000);
  check('zombie room cleaned up after heartbeat terminate', zombieList.rooms.length === 0,
    `listed=[${zombieList.rooms.map((r) => `${r.code}:${r.players}`).join(',')}]`);
} catch (e) {
  check('probe completed', false, e.message);
} finally {
  for (const ws of sockets) {
    try { ws.terminate(); } catch { /* ignore */ }
  }
}

console.log(results.join('\n'));
console.log(failures ? `\n${failures} CHECK(S) FAILED` : '\nALL CHECKS PASSED');
await sleep(100);
process.exit(failures ? 1 : 0);
