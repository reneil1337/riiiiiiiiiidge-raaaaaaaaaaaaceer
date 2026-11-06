// Two-browser 2P LOUNGE harness for the Route A GHOST room (lounge side only).
//
// Proves the lounge half of `_runtime/ghost-research/IMPLEMENTATION-A.md`
// against a cabinet this harness spawns itself (:8093, walks to the next free
// port; never :8080). Two isolated browser contexts per pair, 1440x900 desktop
// and 390x844 mobile. Every `/play-net*` document request is held (request
// interception, never continued), so the GO overlay stays on screen and no disc
// is downloaded / no core boots.
//
// Covered:
//   R4    : #mDrive disabled (LIVE), no drive/turn rows, invite + handoff
//           unchanged (no mpGhost / no mpTurn, game=r4)
//   RIDGE : LIVE | GHOST selector, ghost hint, localStorage rr4.mp.drive
//   room  : both cards `DRIVE GHOST`, `TURN HOST`, rooms-list `GHOST` badge,
//           guest drive/turn selectors read-only
//   turn  : host-only TURN GUEST -> both cards follow, overlay `DRIVER: GUEST`
//           with exactly one `SHARED // <car>` line
//   handoff: game=ridge&mpGhost=ghost&mpTurn=guest + an identical
//           mpRoom/mpRace/mpTrackIndex/mpCarHost/mpCarGuest plan on both seats
//   rematch: shell-built `/multiplayer?room=&host=1|0&embedded=1&game=ridge
//           &drive=ghost&turn=host` (the opposite turn), host auto-creates the
//           same code, guest auto-joins, the second handoff carries turn=host
//   live  : DRIVE LIVE, turn row hidden, `SHARED CAR // BOTH PADS DRIVE`,
//           handoff mpGhost=live with no mpTurn
//   mobile: 390x844 start + room cards have no horizontal overflow
//
// Scope note: this is the lounge/plan/handoff contract. It does not boot a core
// and says nothing about the tape swap (`_server/test-mp-ghost-replay.mjs`).
//
// Usage: cd "_server"; node test-mp-ghost-lobby.mjs
//        node test-mp-ghost-lobby.mjs --port 8093 --keep
//        node test-mp-ghost-lobby.mjs --base http://127.0.0.1:8093
//
// Writes to _runtime/:
//   mp-ghost-lobby-host.png / -mobile.png / -overlay.png / -rematch.png
//   mp-ghost-lobby.json / mp-ghost-lobby.log
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';
import { WebSocket } from 'ws';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const OUT = path.join(ROOT, '_runtime');
const CHROME_CANDIDATES = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files/BraveSoftware/Brave-Browser/Application/brave.exe',
];

const argv = process.argv.slice(2);
function arg(name, def = null) {
  const i = argv.indexOf('--' + name);
  if (i === -1) return def;
  const v = argv[i + 1];
  return v && !v.startsWith('--') ? v : true;
}
const flag = (name) => argv.includes('--' + name);

const PORT_ARG = Number(arg('port', 8093) || 8093);
const BASE_ARG = typeof arg('base') === 'string' ? arg('base').replace(/\/+$/, '') : '';
const KEEP = flag('keep');
// :8093 is the documented port. Walk forward (never :8080) when another agent
// already holds it, so a rerun never attaches to a stale build.
const PORT_CANDIDATES = [PORT_ARG, 8094, 8095, 8096, 8097, 8098, 8099, 8089, 8090, 8091, 8092]
  .filter((p) => p !== 8080 && p !== 3010);
const STEP_TIMEOUT_MS = 30000;
const DESKTOP = { width: 1440, height: 900 };
const MOBILE = { width: 390, height: 844 };
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const iso = (t) => new Date(t).toISOString();
const randomCode = () => Array.from({ length: 4 }, () => CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)]).join('');

fs.mkdirSync(OUT, { recursive: true });

const logLines = [];
const log = (...a) => {
  const line = a.map((v) => (typeof v === 'string' ? v : JSON.stringify(v))).join(' ');
  console.log(line);
  logLines.push(line);
};

const steps = [];
async function step(name, fn) {
  const startedAt = Date.now();
  try {
    const value = await fn();
    steps.push({ name, ok: true, ms: Date.now() - startedAt, startedAt: iso(startedAt) });
    log(`STEP OK   ${name} (${Date.now() - startedAt} ms)`);
    return value;
  } catch (err) {
    const message = err && err.message ? err.message : String(err);
    steps.push({ name, ok: false, ms: Date.now() - startedAt, startedAt: iso(startedAt), error: message });
    log(`STEP FAIL ${name} (${Date.now() - startedAt} ms): ${message}`);
    throw err;
  }
}

// Console noise that is expected in this build (never claim "0 console errors").
const CONSOLE_NOISE = [
  /Download error/i,
  /THIS METHOD IS A FAILSAFE/i,
  /emulatorjs cdn/i,
  /Failed to fetch/i,
  /net::ERR_ABORTED/i,
  /Failed to load resource/i, // held /play-net document + favicon
];

function attach(page, label) {
  const rec = { label, consoleLines: [], consoleErrors: [], consoleIgnored: [], pageErrors: [], requestFailed: [] };
  page.on('console', (m) => {
    const line = `[${m.type()}] ${m.text()}`;
    rec.consoleLines.push(line);
    if (m.type() === 'error') {
      if (CONSOLE_NOISE.some((re) => re.test(line))) rec.consoleIgnored.push(line);
      else rec.consoleErrors.push(line);
    }
  });
  page.on('pageerror', (e) => {
    rec.pageErrors.push(e && e.message ? e.message : String(e));
    log(`  PAGEERROR[${label}] ${e && e.message ? e.message : e}`);
  });
  page.on('requestfailed', (r) => {
    // A held /play-net request is aborted at browser close; expected.
    if (/\/play-net/i.test(r.url())) return;
    rec.requestFailed.push({ url: r.url(), err: r.failure() ? r.failure().errorText : '' });
  });
  return rec;
}

function holdPlayNet(page, sink) {
  page.on('request', (req) => {
    if (/\/play-net(\?|$)/.test(req.url())) {
      sink.push(req.url());
      // Deliberately not continued: keeps the lounge document (GO overlay) on
      // screen and skips the disc download / core boot entirely.
      return;
    }
    req.continue().catch(() => {});
  });
}

/* ------------------------------------------------------------- instance --- */

let PORT = PORT_ARG;
let BASE = BASE_ARG || `http://127.0.0.1:${PORT_ARG}`;
const server = { spawned: false, attached: false, port: PORT, pid: 0, base: BASE, logPath: '', env: {} };

async function health(base, timeoutMs = 2000) {
  try {
    const res = await fetch(`${base}/api/health`, { signal: AbortSignal.timeout(timeoutMs), cache: 'no-store' });
    if (!res.ok) return null;
    return await res.json();
  } catch { return null; }
}

async function waitFor(fn, ms, label, stepMs = 250) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await fn()) return true;
    await sleep(stepMs);
  }
  throw new Error(`${label} not ready within ${ms}ms`);
}

async function spawnOn(port) {
  PORT = port;
  BASE = `http://127.0.0.1:${port}`;
  server.port = port;
  server.base = BASE;
  server.env = { RR4_PORT: String(port), RR4_NO_AUTOSTART: '1' };
  server.logPath = path.join(OUT, `mp-ghost-lobby-server-${port}.log`);
  const fd = fs.openSync(server.logPath, 'a');
  const child = spawn(process.execPath, ['src/server.js'], {
    cwd: HERE,
    env: { ...process.env, ...server.env },
    stdio: ['ignore', fd, fd],
    windowsHide: true,
    detached: true,
  });
  try { fs.closeSync(fd); } catch { /* child owns it */ }
  server.spawned = true;
  server.pid = child.pid;
  child.unref();
  for (let i = 0; i < 120; i += 1) {
    if (await health(BASE)) {
      log(`instance: spawned :${port} pid=${server.pid} RR4_NO_AUTOSTART=1`);
      return true;
    }
    await sleep(250);
  }
  return false;
}

async function startInstance() {
  if (BASE_ARG) {
    const st = await health(BASE_ARG);
    if (!st) throw new Error(`--base ${BASE_ARG} has no /api/health`);
    server.attached = true;
    PORT = Number(new URL(BASE_ARG).port || 80);
    log(`instance: attached to ${BASE_ARG} (nothing spawned)`);
    return;
  }
  for (const port of PORT_CANDIDATES) {
    // A stale throwaway cabinet on that port: walk on instead of trusting it.
    if (await health(`http://127.0.0.1:${port}`, 1200)) {
      log(`instance: :${port} already answering (walking to the next free port)`);
      continue;
    }
    if (await spawnOn(port)) return;
    log(`instance: :${port} spawned but never answered /api/health - walking on`);
  }
  throw new Error(`no free throwaway port in ${PORT_CANDIDATES.join(', ')}`);
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

/* ------------------------------------------------------------ page helpers --- */

/** Can the ghost room still be joined? Used to wait out the previous race room. */
function probeRoom(code) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (v) => {
      if (done) return;
      done = true;
      try { ws.close(); } catch { /* ignore */ }
      resolve(v);
    };
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}/mp`);
    const timer = setTimeout(() => finish('timeout'), 5000);
    ws.on('open', () => ws.send(JSON.stringify({ type: 'join', name: 'PROBE', code })));
    ws.on('message', (raw) => {
      let m = null;
      try { m = JSON.parse(String(raw)); } catch { return; }
      if (m.type === 'joined') { clearTimeout(timer); finish(true); }
      if (m.type === 'error') { clearTimeout(timer); finish(!/not found/i.test(String(m.message || ''))); }
    });
    ws.on('error', () => { clearTimeout(timer); finish('error'); });
    ws.on('close', () => { clearTimeout(timer); finish(false); });
  });
}

async function newClient(label, viewport) {
  const ctx = await browser.createBrowserContext();
  const page = await ctx.newPage();
  await page.setViewport(viewport);
  // Interception must be enabled explicitly: without it the 'request' events
  // still fire but the held /play-net document would load anyway and boot EJS.
  await page.setRequestInterception(true);
  const rec = attach(page, label);
  const held = [];
  holdPlayNet(page, held);
  const client = { label, ctx, page, rec, held, viewport };
  clients.push(client);
  return client;
}

function framesAt(page, needle) {
  return page.frames().filter((f) => String(f.url() || '').includes(needle));
}

async function waitLoungeFrame(page, timeout = STEP_TIMEOUT_MS) {
  let found = null;
  await waitFor(async () => {
    for (const f of framesAt(page, '/multiplayer')) {
      try {
        if (await f.evaluate(() => !!document.querySelector('#mName'))) { found = f; return true; }
      } catch { /* frame is detaching */ }
    }
    return false;
  }, timeout, 'lounge iframe', 150);
  return found;
}

async function gotoLobby(page, query = '') {
  await page.goto(`${BASE}/multiplayer${query}`, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await lobbyReady(page);
  return page;
}

async function lobbyReady(tgt) {
  await tgt.waitForSelector('#mName', { visible: true, timeout: STEP_TIMEOUT_MS });
  // Wait for the manifest fetch to settle so the selector is the real list.
  await tgt.waitForFunction(() => document.querySelectorAll('#mGame option').length >= 3,
    { timeout: STEP_TIMEOUT_MS, polling: 100 });
  // A `?room=` deep link auto-joins, so the list may never leave "Scanning…":
  // accept a rendered room card as "lobby ready" too.
  await tgt.waitForFunction(() => {
    const room = document.querySelector('#mRoom');
    if (room && !room.hidden) return true;
    const el = document.querySelector('#mRooms');
    return !!el && !/scanning/i.test(el.textContent || '');
  }, { timeout: STEP_TIMEOUT_MS, polling: 100 });
}

/** ENTER the cabinet and return the shell page, ready to host a view iframe. */
async function gotoShell(page) {
  await page.goto(`${BASE}/`, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForFunction(() => {
    const b = document.getElementById('rr4eEnter');
    if (!b || b.disabled) return false;
    const label = b.querySelector('span');
    return !!label && /^ENTER$/i.test(label.textContent.trim());
  }, { timeout: STEP_TIMEOUT_MS, polling: 100 });
  await page.click('#rr4eEnter');
  await page.waitForFunction(() => {
    const s = document.getElementById('rr4-shell');
    return !!s && !s.hidden && document.body.classList.contains('is-live');
  }, { timeout: 15000, polling: 100 });
  await waitFor(() => framesAt(page, '/welcome').length > 0, 15000, 'shell /welcome iframe', 150);
  return page;
}

async function setDisc(tgt, key) {
  await tgt.select('#mGame', key);
  await tgt.waitForFunction((k) => document.querySelector('#mGame')?.value === k,
    { timeout: STEP_TIMEOUT_MS, polling: 100 }, key);
  await sleep(80);
}

async function fillName(tgt, name) {
  await tgt.click('#mName', { clickCount: 3 });
  await tgt.$eval('#mName', (el) => { el.value = ''; });
  await tgt.type('#mName', name, { delay: 5 });
}

async function createRoom(tgt, name, code, expectDrive = '') {
  await fillName(tgt, name);
  await tgt.click('#mCode', { clickCount: 3 });
  await tgt.$eval('#mCode', (el) => { el.value = ''; });
  await tgt.type('#mCode', code, { delay: 5 });
  await tgt.click('#mCreate');
  await waitRoomCard(tgt, code, expectDrive);
}

async function waitRoomCard(tgt, code, expectDrive = '') {
  // `joined` paints the code first; the room state (drive/turn, selectors)
  // lands in the following `room` frame, so wait for the expected drive too.
  await tgt.waitForFunction(({ c, d }) => {
    const el = document.querySelector('#mRoom');
    if (!el || el.hidden) return false;
    if ((document.querySelector('#mRoomCode')?.textContent || '').trim() !== c) return false;
    if (!d) return true;
    return new RegExp(`^DRIVE ${d}\\b`).test((document.querySelector('#mRoomDrive')?.textContent || '').trim());
  }, { timeout: STEP_TIMEOUT_MS, polling: 100 }, { c: code, d: expectDrive });
  await sleep(250);
}

const driveState = (tgt) => tgt.evaluate(() => ({
  present: !!document.querySelector('#mDrive'),
  buttons: [...document.querySelectorAll('#mDrive [data-drive]')].map((b) => ({
    drive: b.dataset.drive, pressed: b.getAttribute('aria-pressed'), disabled: b.disabled,
  })),
  hint: (document.querySelector('#mGameHint')?.textContent || '').trim(),
  driveHint: (document.querySelector('#mDriveHint')?.textContent || '').trim(),
  storedGame: (() => { try { return localStorage.getItem('rr4.mp.game'); } catch { return null; } })(),
  storedDrive: (() => { try { return localStorage.getItem('rr4.mp.drive'); } catch { return null; } })(),
}));

const roomCard = (tgt) => tgt.evaluate(() => {
  const txt = (s) => (document.querySelector(s)?.textContent || '').trim();
  const vis = (s) => {
    const el = document.querySelector(s);
    if (!el || el.hidden) return false;
    const st = getComputedStyle(el);
    return st.display !== 'none' && st.visibility !== 'hidden';
  };
  return {
    roomVisible: vis('#mRoom'),
    code: txt('#mRoomCode'),
    roomGame: txt('#mRoomGame'),
    driveLine: txt('#mRoomDrive'),
    driveRowVisible: vis('#mRoomDriveRow'),
    driveSelValue: document.querySelector('#mRoomDriveSel')?.value ?? '',
    driveSelDisabled: document.querySelector('#mRoomDriveSel')?.disabled ?? null,
    turnRowVisible: vis('#mRoomTurn'),
    turnNow: txt('#mTurnNow'),
    turnSelValue: document.querySelector('#mTurnSel')?.value ?? '',
    turnSelDisabled: document.querySelector('#mTurnSel')?.disabled ?? null,
    invite: txt('#mInvite'),
    cars: txt('#mCars'),
    p1: txt('#mP1Name'),
    p2: txt('#mP2Name'),
  };
});

const overlay = (tgt) => tgt.evaluate(() => {
  const txt = (s) => (document.querySelector(s)?.textContent || '').trim();
  const race = document.querySelector('#mRace');
  let visible = false;
  if (race) {
    const cs = getComputedStyle(race);
    visible = !race.hidden && cs.display !== 'none' && cs.visibility !== 'hidden' && Number(cs.opacity) > 0;
  }
  const cars = txt('#mRaceCars');
  return {
    visible,
    count: txt('#mCount'),
    kicker: txt('#mRaceKicker'),
    track: txt('#mRaceTrack'),
    cars,
    sharedLines: (cars.match(/SHARED\s*\/\//g) || []).length,
    driverLines: (cars.match(/DRIVER:/g) || []).length,
    p1Lines: (cars.match(/P1\s/g) || []).length,
    p2Lines: (cars.match(/P2\s/g) || []).length,
  };
});

async function roomRows(page) {
  return page.evaluate(() => [...document.querySelectorAll('#mRooms .mroom-row')].map((r) => ({
    code: (r.querySelector('.mroom-code')?.textContent || '').trim(),
    game: (r.querySelector('.mroom-game')?.textContent || '').trim(),
    drives: [...r.querySelectorAll('.mroom-drive')].map((b) => (b.textContent || '').trim()),
  })));
}

async function pressReady(tgt) {
  await tgt.waitForSelector('#mReady', { visible: true, timeout: STEP_TIMEOUT_MS });
  await tgt.click('#mReady');
  await tgt.waitForFunction(() => document.querySelector('#mReady')?.getAttribute('aria-pressed') === 'true',
    { timeout: STEP_TIMEOUT_MS, polling: 100 });
}

// The lobby counts 3-2-1-GO on a 900 ms tick and then hands off to /play-net.
// Once that navigation is pending (its document request is held) the old
// document can no longer be evaluated, so this harness stretches ONLY that
// 900 ms tick to 4500 ms: the overlay stays stable for the GO snapshot and
// screenshot while the handoff URL is still produced normally.
async function slowCountdown(tgt) {
  await tgt.evaluate(() => {
    if (window.__rr4SlowCountdown) return true;
    const orig = window.setInterval;
    window.setInterval = function (fn, ms, ...rest) {
      return orig.call(this, fn, ms === 900 ? 4500 : ms, ...rest);
    };
    window.__rr4SlowCountdown = true;
    return true;
  });
}

async function waitGo(tgt) {
  await tgt.waitForFunction(() => {
    const el = document.querySelector('#mRace');
    const c = (document.querySelector('#mRaceCount')?.textContent || document.querySelector('#mCount')?.textContent || '').trim();
    return !!el && !el.hidden && c === 'GO';
  }, { timeout: STEP_TIMEOUT_MS, polling: 100 });
}

async function waitHeldUrl(client, timeout = 40000) {
  await waitFor(() => client.held.length > 0, timeout, `${client.label} /play-net handoff`, 100);
  return client.held[client.held.length - 1];
}

async function waitFrameSrc(page, needle, timeout = STEP_TIMEOUT_MS) {
  let src = '';
  await waitFor(async () => {
    const value = await page.evaluate(() => document.getElementById('rr4sFrame')?.src || '').catch(() => '');
    if (String(value).includes(needle)) { src = value; return true; }
    return false;
  }, timeout, `shell iframe src ${needle}`, 120);
  return src;
}

const MP_PARAMS = ['mpRole', 'mpRoom', 'mpRace', 'mpTrackIndex', 'mpCarHost', 'mpCarGuest', 'mpGhost', 'mpTurn', 'game', 'threads', 'embedded'];

function parseUrl(url) {
  const out = { path: '', search: '', params: {}, values: {} };
  try {
    const u = new URL(url, BASE);
    out.path = u.pathname;
    out.search = u.search;
    out.params = Object.fromEntries(u.searchParams.entries());
    for (const k of MP_PARAMS) out.values[k] = u.searchParams.get(k);
  } catch { /* leave empty */ }
  return out;
}

const inviteQuery = (invite) => {
  try { return new URL(invite, BASE).search; } catch { return ''; }
};

async function shot(page, file) {
  await page.screenshot({ path: path.join(OUT, file) });
  state.screenshots[file] = path.join(OUT, file);
}

/* ------------------------------------------------------------------ main --- */

const startedAt = Date.now();
const clients = [];
const state = {
  base: BASE,
  instance: server,
  rooms: {},
  r4: {},
  ghost: {},
  live: {},
  mobile: {},
  rematch: {},
  screenshots: {},
  fatal: null,
  fatalPhase: '',
  console: {},
};
let browser = null;

let r4Host = null;
let r4Guest = null;
let ghostHost = null;
let ghostGuest = null;
let liveHost = null;
let liveGuest = null;
let mob = null;

async function closeClient(client) {
  if (!client) return;
  try { await Promise.race([client.ctx.close(), sleep(5000)]); } catch { /* held navigation can reject close */ }
  client.closed = true;
}

try {
  await startInstance();
  state.base = BASE;
  const chrome = CHROME_CANDIDATES.find((p) => fs.existsSync(p));
  if (!chrome) throw new Error(`no Chrome/Brave found in ${CHROME_CANDIDATES.join(', ')}`);
  browser = await puppeteer.launch({
    executablePath: chrome,
    headless: true,
    protocolTimeout: 240000,
    defaultViewport: DESKTOP,
    args: [
      '--no-sandbox',
      '--disable-background-timer-throttling',
      '--disable-backgrounding-occluded-windows',
      '--disable-renderer-backgrounding',
      '--autoplay-policy=no-user-gesture-required',
      '--mute-audio',
      '--window-size=1440,900',
    ],
  });

  /* ---- 1. R4: ghost is a shared-car mode, so the room must not grow fields ---- */
  try {
    await step('r4: drive control disabled, no ghost rows, invite/handoff unchanged', async () => {
      r4Host = await newClient('r4-host', DESKTOP);
      r4Guest = await newClient('r4-guest', DESKTOP);
      await gotoLobby(r4Host.page);
      await gotoLobby(r4Guest.page);
      state.r4.start = await driveState(r4Host.page);

      const code = randomCode();
      state.rooms.r4 = code;
      await createRoom(r4Host.page, 'R4HOST', code, 'LIVE');
      await waitRoomCard(r4Host.page, code, 'LIVE');
      state.r4.hostCard = await roomCard(r4Host.page);

      await gotoLobby(r4Guest.page, inviteQuery(state.r4.hostCard.invite));
      await waitRoomCard(r4Guest.page, code, 'LIVE');
      state.r4.guestCard = await roomCard(r4Guest.page);

      await slowCountdown(r4Host.page);
      await slowCountdown(r4Guest.page);
      await pressReady(r4Host.page);
      await sleep(150);
      await pressReady(r4Guest.page);
      await Promise.all([waitGo(r4Host.page), waitGo(r4Guest.page)]);

      state.r4.go = { host: await overlay(r4Host.page), guest: await overlay(r4Guest.page) };
      const hostUrl = await waitHeldUrl(r4Host);
      const guestUrl = await waitHeldUrl(r4Guest);
      state.r4.handoff = { hostUrl, guestUrl, host: parseUrl(hostUrl), guest: parseUrl(guestUrl) };
      await closeClient(r4Host);
      await closeClient(r4Guest);
    });
  } catch (err) {
    state.r4.error = err && err.message ? err.message : String(err);
    if (!state.fatal) { state.fatal = state.r4.error; state.fatalPhase = 'r4'; }
  }

  /* ---- 2. RIDGE: ghost selector, persistence, room card, live room for the list ---- */
  try {
    await step('ghost: RIDGE + GHOST selector persists, room card + rooms-list badge', async () => {
      ghostHost = await newClient('ghost-host', DESKTOP);
      await gotoLobby(ghostHost.page);
      await setDisc(ghostHost.page, 'ridge');
      state.ghost.startLive = await driveState(ghostHost.page);

      await ghostHost.page.click('#mDrive [data-drive="ghost"]');
      await sleep(180);
      state.ghost.startGhost = await driveState(ghostHost.page);

      const code = randomCode();
      state.rooms.ghost = code;
      await createRoom(ghostHost.page, 'HOST-A', code, 'GHOST');
      await waitRoomCard(ghostHost.page, code, 'GHOST');
      state.ghost.hostCard = await roomCard(ghostHost.page);

      // A real live room, created while the ghost room is still open, so the
      // rooms list can be checked for the GHOST badge without a fake frame.
      liveHost = await newClient('live-host', DESKTOP);
      await gotoLobby(liveHost.page);
      await setDisc(liveHost.page, 'ridge');
      await liveHost.page.click('#mDrive [data-drive="live"]');
      await sleep(150);
      state.live.start = await driveState(liveHost.page);
      const liveCode = randomCode();
      state.rooms.live = liveCode;
      await createRoom(liveHost.page, 'HOSTL', liveCode, 'LIVE');
      await waitRoomCard(liveHost.page, liveCode, 'LIVE');
      state.live.hostCard = await roomCard(liveHost.page);

      await shot(ghostHost.page, 'mp-ghost-lobby-host.png');
    });
  } catch (err) {
    state.ghost.error = err && err.message ? err.message : String(err);
    if (!state.fatal) { state.fatal = state.ghost.error; state.fatalPhase = 'ghost-start'; }
  }

  /* ---- 3. guest: rooms-list badge, join by invite, read-only card ---- */
  try {
    await step('guest: rooms-list GHOST badge, invite join, drive/turn selectors read-only', async () => {
      ghostGuest = await newClient('ghost-guest', DESKTOP);
      await gotoLobby(ghostGuest.page);
      const ghostCode = state.rooms.ghost;
      const liveCode = state.rooms.live;
      await waitFor(async () => {
        const rows = await roomRows(ghostGuest.page);
        return rows.some((r) => r.code === ghostCode) && rows.some((r) => r.code === liveCode);
      }, 15000, 'both rooms in the guest rooms list', 250);
      state.ghost.roomsList = await roomRows(ghostGuest.page);

      await gotoLobby(ghostGuest.page, inviteQuery(state.ghost.hostCard.invite));
      await waitRoomCard(ghostGuest.page, state.rooms.ghost, 'GHOST');
      state.ghost.guestCard = await roomCard(ghostGuest.page);
    });
  } catch (err) {
    state.ghost.guestError = err && err.message ? err.message : String(err);
    if (!state.fatal) { state.fatal = state.ghost.guestError; state.fatalPhase = 'ghost-join'; }
  }

  /* ---- 4. host-only TURN GUEST -> both cards, overlay, handoff ---- */
  try {
    await step('ghost: host turn=guest follows both cards, overlay DRIVER: GUEST, handoff URLs', async () => {
      const code = state.rooms.ghost;
      await ghostHost.page.select('#mTurnSel', 'guest');
      await ghostHost.page.waitForFunction(() => (document.querySelector('#mTurnNow')?.textContent || '').trim() === 'TURN GUEST',
        { timeout: STEP_TIMEOUT_MS, polling: 100 });
      // The guest repaints from the server's `room` broadcast (no local state).
      await ghostGuest.page.waitForFunction(() => (document.querySelector('#mTurnNow')?.textContent || '').trim() === 'TURN GUEST',
        { timeout: STEP_TIMEOUT_MS, polling: 100 });
      await sleep(200);
      state.ghost.hostCardTurnGuest = await roomCard(ghostHost.page);
      state.ghost.guestCardTurnGuest = await roomCard(ghostGuest.page);

      await slowCountdown(ghostHost.page);
      await slowCountdown(ghostGuest.page);
      await pressReady(ghostHost.page);
      await sleep(150);
      await pressReady(ghostGuest.page);
      await Promise.all([waitGo(ghostHost.page), waitGo(ghostGuest.page)]);

      state.ghost.go = { host: await overlay(ghostHost.page), guest: await overlay(ghostGuest.page) };
      await shot(ghostHost.page, 'mp-ghost-lobby-overlay.png');

      const hostUrl = await waitHeldUrl(ghostHost);
      const guestUrl = await waitHeldUrl(ghostGuest);
      state.ghost.handoff = { hostUrl, guestUrl, host: parseUrl(hostUrl), guest: parseUrl(guestUrl) };
      state.ghost.code = code;
      // Mirror play-net.js: the rematch flips the turn to the other seat.
      const nextTurn = state.ghost.handoff.host.values.mpTurn === 'guest' ? 'host' : 'guest';
      state.rematch.nextTurn = nextTurn;
      state.rematch.drive = 'ghost';
    });
  } catch (err) {
    state.ghost.turnError = err && err.message ? err.message : String(err);
    if (!state.fatal) { state.fatal = state.ghost.turnError; state.fatalPhase = 'ghost-turn'; }
  }

  /* ---- 5. live regression on RIDGE (the untouched shared-car path) ---- */
  try {
    await step('live: DRIVE LIVE, turn row hidden, BOTH PADS overlay, mpGhost=live handoff', async () => {
      liveGuest = await newClient('live-guest', DESKTOP);
      await gotoLobby(liveGuest.page, inviteQuery(state.live.hostCard.invite));
      await waitRoomCard(liveGuest.page, state.rooms.live, 'LIVE');
      state.live.hostCardBefore = await roomCard(liveHost.page);
      state.live.guestCard = await roomCard(liveGuest.page);

      await slowCountdown(liveHost.page);
      await slowCountdown(liveGuest.page);
      await pressReady(liveHost.page);
      await sleep(150);
      await pressReady(liveGuest.page);
      await Promise.all([waitGo(liveHost.page), waitGo(liveGuest.page)]);

      state.live.go = { host: await overlay(liveHost.page), guest: await overlay(liveGuest.page) };
      const hostUrl = await waitHeldUrl(liveHost);
      const guestUrl = await waitHeldUrl(liveGuest);
      state.live.handoff = { hostUrl, guestUrl, host: parseUrl(hostUrl), guest: parseUrl(guestUrl) };
    });
  } catch (err) {
    state.live.error = err && err.message ? err.message : String(err);
    if (!state.fatal) { state.fatal = state.live.error; state.fatalPhase = 'live'; }
  }

  /* ---- 6. mobile 390x844 ---- */
  try {
    await step('mobile 390x844: ghost start card + ghost room card have no horizontal overflow', async () => {
      mob = await newClient('mobile', MOBILE);
      await gotoLobby(mob.page, '?game=ridge&drive=ghost&turn=guest');
      state.mobile.start = await mob.page.evaluate(() => {
        const el = document.querySelector('#mStart');
        return {
          docOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
          cardOverflow: el ? Math.max(0, el.scrollWidth - el.clientWidth) : -1,
          hint: (document.querySelector('#mGameHint')?.textContent || '').trim(),
          drivePressed: [...document.querySelectorAll('#mDrive [data-drive]')]
            .map((b) => `${b.dataset.drive}:${b.getAttribute('aria-pressed')}`).join(','),
        };
      });
      const code = randomCode();
      state.rooms.mobile = code;
      await createRoom(mob.page, 'MOBILE', code, 'GHOST');
      await waitRoomCard(mob.page, code, 'GHOST');
      state.mobile.room = await mob.page.evaluate(() => {
        const el = document.querySelector('#mRoom');
        const sel = document.querySelector('#mTurnSel');
        return {
          docOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
          cardOverflow: el ? Math.max(0, el.scrollWidth - el.clientWidth) : -1,
          viewport: document.documentElement.clientWidth,
          driveSelWidth: Math.round(document.querySelector('#mRoomDriveSel').getBoundingClientRect().width),
          turnSelWidth: sel ? Math.round(sel.getBoundingClientRect().width) : -1,
          turnNow: (document.querySelector('#mTurnNow')?.textContent || '').trim(),
        };
      });
      state.mobile.card = await roomCard(mob.page);
      await shot(mob.page, 'mp-ghost-lobby-mobile.png');
    });
  } catch (err) {
    state.mobile.error = err && err.message ? err.message : String(err);
    if (!state.fatal) { state.fatal = state.mobile.error; state.fatalPhase = 'mobile'; }
  }

  /* ---- 7. rematch through the shell (enter.js builds the URL) ---- */
  try {
    await step('rematch: shell URL drive=ghost&turn=host, host recreates, guest auto-joins, turn=host handoff', async () => {
      const code = state.rooms.ghost;
      // The product replaces the lounge document with /play-net, so its /mp
      // socket is gone before the rematch create. A held document would keep a
      // live socket, so close the first race's contexts and wait out the room.
      await closeClient(ghostHost);
      await closeClient(ghostGuest);
      await closeClient(liveHost);
      await closeClient(liveGuest);
      await closeClient(r4Host);
      await closeClient(r4Guest);
      await closeClient(mob);
      try {
        await waitFor(async () => (await probeRoom(code)) === false, 20000, `room ${code} released`, 300);
        state.rematch.roomReleased = true;
      } catch {
        state.rematch.roomReleased = false;
      }

      const shHost = await newClient('rematch-host', DESKTOP);
      const shGuest = await newClient('rematch-guest', DESKTOP);
      await gotoShell(shHost.page);
      await gotoShell(shGuest.page);

      // Exactly the payload play-net.js posts: role + disc + drive + NEXT turn.
      const payloadHost = { type: 'rr4-rematch', code, role: 'host', game: 'ridge', drive: 'ghost', turn: state.rematch.nextTurn };
      const payloadGuest = { type: 'rr4-rematch', code, role: 'guest', game: 'ridge', drive: 'ghost', turn: state.rematch.nextTurn };
      state.rematch.payload = { host: payloadHost, guest: payloadGuest };

      await shHost.page.evaluate((p) => { window.postMessage(p, location.origin); }, payloadHost);
      const srcHost = await waitFrameSrc(shHost.page, '/multiplayer');
      state.rematch.hostUrl = srcHost;
      state.rematch.host = parseUrl(srcHost);

      await shGuest.page.evaluate((p) => { window.postMessage(p, location.origin); }, payloadGuest);
      const srcGuest = await waitFrameSrc(shGuest.page, '/multiplayer');
      state.rematch.guestUrl = srcGuest;
      state.rematch.guest = parseUrl(srcGuest);

      // The iframe now runs the lounge: host auto-creates the same code, the
      // guest retries `join` until it exists.
      const hostFrame = await waitLoungeFrame(shHost.page);
      const guestFrame = await waitLoungeFrame(shGuest.page);
      await lobbyReady(hostFrame);
      await lobbyReady(guestFrame);
      await waitRoomCard(hostFrame, code, 'GHOST');
      state.rematch.hostCard = await roomCard(hostFrame);
      await waitRoomCard(guestFrame, code, 'GHOST');
      await sleep(400);
      state.rematch.guestCard = await roomCard(guestFrame);

      await slowCountdown(hostFrame);
      await slowCountdown(guestFrame);
      await pressReady(hostFrame);
      await sleep(150);
      await pressReady(guestFrame);
      await Promise.all([waitGo(hostFrame), waitGo(guestFrame)]);
      state.rematch.go = { host: await overlay(hostFrame), guest: await overlay(guestFrame) };
      await shot(shHost.page, 'mp-ghost-lobby-rematch.png');

      const hostUrl = await waitHeldUrl(shHost);
      const guestUrl = await waitHeldUrl(shGuest);
      state.rematch.handoff = { hostUrl, guestUrl, host: parseUrl(hostUrl), guest: parseUrl(guestUrl) };
    });
  } catch (err) {
    state.rematch.error = err && err.message ? err.message : String(err);
    if (!state.fatal) { state.fatal = state.rematch.error; state.fatalPhase = 'rematch'; }
  }
} catch (err) {
  state.fatal = err && err.message ? err.message : String(err);
  state.fatalPhase = state.fatalPhase || 'setup';
  log(`FATAL ${state.fatal}`);
} finally {
  state.finishedAt = iso(Date.now());
  state.durationMs = Date.now() - startedAt;
  for (const c of clients) {
    state.console[c.label] = {
      consoleErrors: c.rec.consoleErrors,
      consoleIgnored: c.rec.consoleIgnored,
      pageErrors: c.rec.pageErrors,
      requestFailed: c.rec.requestFailed,
      consoleLines: c.rec.consoleLines.slice(-120),
    };
    try { await Promise.race([c.page.close(), sleep(4000)]); } catch { /* a held navigation can reject close */ }
  }
  try { await Promise.race([browser?.close(), sleep(6000)]); } catch { /* ignore */ }
  await stopInstance();
}

/* -------------------------------------------------------------- assertions --- */

const A = [];
function check(id, name, pass, detail) {
  const entry = { id, name, pass: !!pass, detail: detail === undefined ? '' : String(detail) };
  A.push(entry);
  log(`${pass ? 'PASS' : 'FAIL'} ${id}: ${name}${entry.detail ? ' — ' + entry.detail : ''}`);
}

const R4 = state.r4 || {};
const G = state.ghost || {};
const L = state.live || {};
const M = state.mobile || {};
const R = state.rematch || {};
const r4Start = R4.start || { buttons: [], hint: '', driveHint: '' };
const gStartLive = G.startLive || { buttons: [] };
const gStartGhost = G.startGhost || { buttons: [], hint: '', storedDrive: null };
const gHostCard = G.hostCard || {};
const gGuestCard = G.guestCard || {};
const gHostTurn = G.hostCardTurnGuest || {};
const gGuestTurn = G.guestCardTurnGuest || {};
const gGo = G.go || { host: {}, guest: {} };
const gHandoff = G.handoff || { host: { values: {} }, guest: { values: {} } };
const gh = gHandoff.host.values || {};
const gg = gHandoff.guest.values || {};
const liveHostCard = L.hostCard || {};
const liveGo = L.go || { host: {}, guest: {} };
const liveHandoff = L.handoff || { host: { values: {} }, guest: { values: {} } };
const lh = liveHandoff.host.values || {};
const lg = liveHandoff.guest.values || {};
const rematchHost = R.host || { values: {}, params: {} };
const rematchGuest = R.guest || { values: {}, params: {} };
const rematchHandoff = R.handoff || { host: { values: {} }, guest: { values: {} } };
const rHH = rematchHandoff.host.values || {};
const rHG = rematchHandoff.guest.values || {};
const pressed = (s) => (s.buttons || []).map((b) => b.pressed).join(',');

// --- 1. R4 regression -------------------------------------------------------
check('L01', 'R4: #mDrive exists, LIVE active, both buttons disabled, hint RAGE + RIDGE ONLY',
  r4Start.present === true
    && JSON.stringify(r4Start.buttons) === JSON.stringify([
      { drive: 'live', pressed: 'true', disabled: true },
      { drive: 'ghost', pressed: 'false', disabled: true },
    ])
    && /VS BATTLE/.test(String(r4Start.hint || ''))
    && r4Start.driveHint === 'RAGE + RIDGE ONLY',
  `present=${r4Start.present} buttons=${JSON.stringify(r4Start.buttons)} hint="${r4Start.hint}" driveHint="${r4Start.driveHint}"`);

check('L02', 'R4: room card has no ghost rows (drive row + turn row hidden)',
  R4.hostCard && R4.hostCard.driveRowVisible === false && R4.hostCard.turnRowVisible === false,
  R4.hostCard ? `driveRow=${R4.hostCard.driveRowVisible} turnRow=${R4.hostCard.turnRowVisible} line="${R4.hostCard.driveLine}"` : '(no card)');

check('L03', 'R4: invite link is unchanged (room + game only, no drive/turn)',
  R4.hostCard && JSON.stringify(parseUrl(R4.hostCard.invite).params) === JSON.stringify({ room: state.rooms.r4, game: 'r4' }),
  R4.hostCard ? JSON.stringify(parseUrl(R4.hostCard.invite).params) : '(no invite)');

check('L04', 'R4: room state stays drive=live turn=host',
  R4.hostCard && R4.hostCard.driveSelValue === 'live' && R4.hostCard.turnSelValue === 'host',
  R4.hostCard ? `drive=${R4.hostCard.driveSelValue} turn=${R4.hostCard.turnSelValue}` : '(no card)');

check('L05', 'R4: handoff carries no mpGhost/mpTurn, game=r4, both roles + the rolled plan',
  (R4.handoff) && R4.handoff.host.values.game === 'r4' && R4.handoff.guest.values.game === 'r4'
    && R4.handoff.host.values.mpRole === 'host' && R4.handoff.guest.values.mpRole === 'guest'
    && R4.handoff.host.values.mpGhost == null && R4.handoff.host.values.mpTurn == null
    && R4.handoff.guest.values.mpGhost == null && R4.handoff.guest.values.mpTurn == null
    && R4.handoff.host.values.mpRoom === state.rooms.r4
    && R4.handoff.guest.values.mpRoom === state.rooms.r4,
  R4.handoff ? `mpGhost=${R4.handoff.host.values.mpGhost}/${R4.handoff.guest.values.mpGhost} mpTurn=${R4.handoff.host.values.mpTurn}/${R4.handoff.guest.values.mpTurn} game=${R4.handoff.host.values.game}` : '(no handoff)');

// --- 2. RIDGE start card ----------------------------------------------------
check('L06', 'RIDGE: drive control enabled with LIVE active by default',
  gStartLive.buttons && gStartLive.buttons.length === 2
    && gStartLive.buttons.every((b) => b.disabled === false)
    && pressed(gStartLive) === 'true,false'
    && /^SHARED CAR\b/.test(String(gStartLive.hint || '')),
  `buttons=${JSON.stringify(gStartLive.buttons)} hint="${gStartLive.hint}"`);

check('L07', 'RIDGE: clicking GHOST moves the segmented control',
  pressed(gStartGhost) === 'false,true' && (gStartGhost.buttons || []).every((b) => b.disabled === false),
  JSON.stringify(gStartGhost.buttons));

check('L08', 'ghost: the start hint is the turn-based Time Trial line',
  gStartGhost.hint === "GHOST · TURN-BASED TIME TRIAL - THE RUN YOU FINISH BECOMES THE OTHER'S GHOST",
  `hint="${gStartGhost.hint}"`);

check('L09', 'ghost: the choice persists in localStorage rr4.mp.drive',
  gStartGhost.storedDrive === 'ghost' && gStartGhost.storedGame === 'ridge',
  `rr4.mp.drive=${gStartGhost.storedDrive} rr4.mp.game=${gStartGhost.storedGame}`);

// --- 3. ghost room card + list badge ---------------------------------------
check('L10', 'ghost: host card reads DRIVE GHOST // TURN-BASED TIME TRIAL on the RIDGE disc',
  /^DRIVE GHOST \/\/ TURN-BASED TIME TRIAL/.test(String(gHostCard.driveLine || ''))
    && gHostCard.roomGame === 'RIDGE RACER // SHARED CAR',
  `line="${gHostCard.driveLine}" disc="${gHostCard.roomGame}"`);

check('L11', 'ghost: host card shows TURN HOST with both selectors enabled',
  gHostCard.turnRowVisible === true && gHostCard.turnNow === 'TURN HOST'
    && gHostCard.driveSelDisabled === false && gHostCard.turnSelDisabled === false
    && gHostCard.driveSelValue === 'ghost' && gHostCard.turnSelValue === 'host',
  `turn="${gHostCard.turnNow}" driveSel=${gHostCard.driveSelValue}/${gHostCard.driveSelDisabled} turnSel=${gHostCard.turnSelValue}/${gHostCard.turnSelDisabled}`);

check('L12', 'ghost: invite link carries drive=ghost&turn=host',
  gHostCard.invite && JSON.stringify(parseUrl(gHostCard.invite).params) === JSON.stringify({
    room: state.rooms.ghost, game: 'ridge', drive: 'ghost', turn: 'host',
  }),
  gHostCard.invite ? JSON.stringify(parseUrl(gHostCard.invite).params) : '(no invite)');

const listRows = Array.isArray(G.roomsList) ? G.roomsList : [];
const ghostRow = listRows.find((r) => r.code === state.rooms.ghost) || null;
const liveRow = listRows.find((r) => r.code === state.rooms.live) || null;
check('L13', 'rooms list: GHOST badge on the ghost room only (real rooms, not an injected frame)',
  !!ghostRow && !!liveRow
    && ghostRow.drives.join(',') === 'GHOST' && ghostRow.game === 'RIDGE'
    && liveRow.drives.length === 0 && liveRow.game === 'RIDGE',
  `rows=${JSON.stringify(listRows)}`);

check('L14', 'guest: room card reads DRIVE GHOST with TURN HOST',
  /^DRIVE GHOST/.test(String(gGuestCard.driveLine || '')) && gGuestCard.code === state.rooms.ghost
    && gGuestCard.turnRowVisible === true && gGuestCard.turnNow === 'TURN HOST',
  `code=${gGuestCard.code} line="${gGuestCard.driveLine}" turn="${gGuestCard.turnNow}"`);

check('L15', 'guest: drive + turn selectors are read-only',
  gGuestCard.driveSelDisabled === true && gGuestCard.turnSelDisabled === true
    && gGuestCard.driveSelValue === 'ghost' && gGuestCard.turnSelValue === 'host',
  `driveSel=${gGuestCard.driveSelValue}/${gGuestCard.driveSelDisabled} turnSel=${gGuestCard.turnSelValue}/${gGuestCard.turnSelDisabled}`);

// --- 4. turn switch + overlay ---------------------------------------------
check('L16', 'host: TURN GUEST lands on the host card',
  gHostTurn.turnNow === 'TURN GUEST' && gHostTurn.turnRowVisible === true,
  `turn="${gHostTurn.turnNow}"`);

check('L17', "guest: the server's room frame moves the read-only card to TURN GUEST",
  gGuestTurn.turnNow === 'TURN GUEST' && gGuestTurn.turnSelValue === 'guest'
    && gGuestTurn.turnSelDisabled === true,
  `turn="${gGuestTurn.turnNow}" sel=${gGuestTurn.turnSelValue}/${gGuestTurn.turnSelDisabled}`);

check('L18', 'overlay: DRIVER: GUEST on both, exactly one SHARED // <car> · DRIVER line, no BOTH PADS DRIVE',
  gGo.host.visible === true && gGo.guest.visible === true
    && gGo.host.kicker === 'DRIVER: GUEST' && gGo.guest.kicker === 'DRIVER: GUEST'
    && /^SHARED \/\/ .+/.test(String(gGo.host.cars || ''))
    && gGo.host.sharedLines === 1 && gGo.guest.sharedLines === 1
    && gGo.host.driverLines === 1 && gGo.guest.driverLines === 1
    && /DRIVER: GUEST/.test(String(gGo.host.cars || ''))
    && gGo.host.p1Lines === 0 && gGo.host.p2Lines === 0
    && !/BOTH PADS DRIVE/.test(String(gGo.host.kicker) + String(gGo.guest.kicker)),
  `host="${gGo.host.kicker}" cars="${gGo.host.cars}" guest="${gGo.guest.kicker}"`);

check('L19', 'handoff host: game=ridge&mpGhost=ghost&mpTurn=guest with mpRole=host',
  gh.mpRole === 'host' && gh.game === 'ridge' && gh.mpGhost === 'ghost' && gh.mpTurn === 'guest'
    && gh.mpRoom === state.rooms.ghost && !!gh.mpRace,
  `role=${gh.mpRole} game=${gh.game} mpGhost=${gh.mpGhost} mpTurn=${gh.mpTurn} room=${gh.mpRoom}`);

check('L20', 'handoff guest: the same ghost params with mpRole=guest',
  gg.mpRole === 'guest' && gg.game === 'ridge' && gg.mpGhost === 'ghost' && gg.mpTurn === 'guest'
    && gg.mpRoom === state.rooms.ghost && !!gg.mpRace,
  `role=${gg.mpRole} game=${gg.game} mpGhost=${gg.mpGhost} mpTurn=${gg.mpTurn} room=${gg.mpRoom}`);

check('L21', 'handoff: both sides carry an identical room/race/track/car plan',
  !!gh.mpRoom && gh.mpRoom === gg.mpRoom
    && !!gh.mpRace && gh.mpRace === gg.mpRace
    && gh.mpTrackIndex != null && gh.mpTrackIndex === gg.mpTrackIndex
    && gh.mpCarHost != null && gh.mpCarHost === gg.mpCarHost
    && gh.mpCarGuest != null && gh.mpCarGuest === gg.mpCarGuest,
  `room=${gh.mpRoom}/${gg.mpRoom} race=${gh.mpRace}/${gg.mpRace} track=${gh.mpTrackIndex}/${gg.mpTrackIndex} cars=${gh.mpCarHost},${gh.mpCarGuest}/${gg.mpCarHost},${gg.mpCarGuest}`);

// --- 5. rematch through the shell -----------------------------------------
check('L22', 'rematch host URL: /multiplayer?room&host=1&embedded=1&game=ridge&drive=ghost&turn=host',
  R.hostUrl && rematchHost.path === '/multiplayer'
    && JSON.stringify(rematchHost.params) === JSON.stringify({
      room: state.rooms.ghost, host: '1', embedded: '1', game: 'ridge', drive: 'ghost', turn: 'host',
    }),
  R.hostUrl ? R.hostUrl : '(no URL)');

check('L23', 'rematch guest URL: same code + drive=ghost&turn=host with host=0',
  R.guestUrl && rematchGuest.path === '/multiplayer'
    && JSON.stringify(rematchGuest.params) === JSON.stringify({
      room: state.rooms.ghost, host: '0', embedded: '1', game: 'ridge', drive: 'ghost', turn: 'host',
    }),
  R.guestUrl ? R.guestUrl : '(no URL)');

check('L24', 'rematch host auto-creates the SAME code with DRIVE GHOST + TURN HOST',
  R.hostCard && R.hostCard.code === state.rooms.ghost
    && /^DRIVE GHOST/.test(String(R.hostCard.driveLine || ''))
    && R.hostCard.turnNow === 'TURN HOST' && R.hostCard.driveSelDisabled === false,
  R.hostCard ? `code=${R.hostCard.code}/${state.rooms.ghost} line="${R.hostCard.driveLine}" turn="${R.hostCard.turnNow}"` : '(no card)');

check('L25', 'rematch guest auto-joins that room and adopts DRIVE GHOST + TURN HOST',
  R.guestCard && R.guestCard.code === state.rooms.ghost
    && /^DRIVE GHOST/.test(String(R.guestCard.driveLine || ''))
    && R.guestCard.turnNow === 'TURN HOST' && R.guestCard.driveSelDisabled === true
    && R.guestCard.turnSelDisabled === true,
  R.guestCard ? `code=${R.guestCard.code} line="${R.guestCard.driveLine}" turn="${R.guestCard.turnNow}" selDisabled=${R.guestCard.driveSelDisabled}/${R.guestCard.turnSelDisabled}` : '(no card)');

check('L26', 'second race handoff carries mpGhost=ghost&mpTurn=host on both sides, same room',
  rHH.mpGhost === 'ghost' && rHH.mpTurn === 'host' && rHH.mpRole === 'host' && rHH.game === 'ridge'
    && rHG.mpGhost === 'ghost' && rHG.mpTurn === 'host' && rHG.mpRole === 'guest' && rHG.game === 'ridge'
    && rHH.mpRoom === state.rooms.ghost && rHG.mpRoom === state.rooms.ghost
    && !!rHH.mpRace && rHH.mpRace === rHG.mpRace,
  `host=${rHH.mpGhost}/${rHH.mpTurn}/${rHH.mpRoom} guest=${rHG.mpGhost}/${rHG.mpTurn}/${rHG.mpRoom} race=${rHH.mpRace}/${rHG.mpRace}`);

check('L27', 'rematch overlay says DRIVER: HOST with one SHARED // line (the flipped driver)',
  R.go && R.go.host && R.go.host.kicker === 'DRIVER: HOST'
    && R.go.guest && R.go.guest.kicker === 'DRIVER: HOST'
    && R.go.host.sharedLines === 1 && R.go.host.driverLines === 1
    && /DRIVER: HOST/.test(String(R.go.host.cars || '')),
  R.go && R.go.host ? `host="${R.go.host.kicker}" cars="${R.go.host.cars}" guest="${R.go.guest ? R.go.guest.kicker : ''}"` : '(no overlay)');

// --- 6. live regression ----------------------------------------------------
check('L28', 'live: host card DRIVE LIVE // SHARED CAR with the turn row hidden',
  /^DRIVE LIVE \/\/ SHARED CAR/.test(String(liveHostCard.driveLine || ''))
    && liveHostCard.turnRowVisible === false
    && liveHostCard.driveSelValue === 'live' && L.start && L.start.storedDrive === 'live',
  `line="${liveHostCard.driveLine}" turnRow=${liveHostCard.turnRowVisible} stored=${L.start ? L.start.storedDrive : '(none)'}`);

check('L29', 'live: overlay keeps SHARED CAR // BOTH PADS DRIVE on both seats',
  liveGo.host.kicker === 'SHARED CAR // BOTH PADS DRIVE'
    && liveGo.guest.kicker === 'SHARED CAR // BOTH PADS DRIVE'
    && liveGo.host.sharedLines === 1 && liveGo.host.driverLines === 0
    && liveGo.guest.sharedLines === 1 && liveGo.guest.driverLines === 0,
  `host="${liveGo.host.kicker}"/${liveGo.host.cars} guest="${liveGo.guest.kicker}"`);

check('L30', 'live: handoff carries mpGhost=live and NO mpTurn on both sides',
  lh.mpGhost === 'live' && lh.mpTurn == null && lg.mpGhost === 'live' && lg.mpTurn == null
    && lh.game === 'ridge' && lg.game === 'ridge'
    && lh.mpRoom === state.rooms.live && lg.mpRoom === state.rooms.live,
  `host=${lh.mpGhost}/${lh.mpTurn} guest=${lg.mpGhost}/${lg.mpTurn} room=${lh.mpRoom}/${state.rooms.live}`);

// --- 7. mobile -------------------------------------------------------------
check('L31', 'mobile 390x844: ghost start card has no horizontal overflow',
  M.start && M.start.docOverflow <= 1 && M.start.cardOverflow <= 1
    && /^GHOST · TURN-BASED TIME TRIAL/.test(String(M.start.hint || ''))
    && M.start.drivePressed === 'live:false,ghost:true',
  M.start ? `docOverflow=${M.start.docOverflow} cardOverflow=${M.start.cardOverflow} drive=${M.start.drivePressed}` : '(not measured)');

check('L32', 'mobile 390x844: ghost room card has no horizontal overflow and ?turn=guest is honoured',
  M.room && M.room.docOverflow <= 1 && M.room.cardOverflow <= 1
    && M.room.turnNow === 'TURN GUEST'
    && M.room.driveSelWidth <= M.room.viewport && M.room.turnSelWidth <= M.room.viewport,
  M.room ? `docOverflow=${M.room.docOverflow} cardOverflow=${M.room.cardOverflow} turn="${M.room.turnNow}" width=${M.room.driveSelWidth}/${M.room.turnSelWidth} viewport=${M.room.viewport}` : '(not measured)');

// --- 8. console / evidence -------------------------------------------------
const consoleAll = state.console || {};
const pageErrorAll = Object.values(consoleAll).flatMap((c) => c.pageErrors || []);
const unexpectedConsole = Object.values(consoleAll).flatMap((c) => c.consoleErrors || []);
const ignoredConsole = Object.values(consoleAll).flatMap((c) => c.consoleIgnored || []);

check('L33', 'no uncaught page errors in any browser context',
  pageErrorAll.length === 0,
  `${pageErrorAll.length} page error(s)${pageErrorAll.length ? ': ' + pageErrorAll.join(' | ') : ''}`);

check('L34', 'no unexpected console errors (interception noise allow-listed, not claimed as 0)',
  unexpectedConsole.length === 0,
  `${unexpectedConsole.length} unexpected / ${ignoredConsole.length} allow-listed${unexpectedConsole.length ? ': ' + unexpectedConsole.join(' | ') : ''}`);

const requiredShots = ['mp-ghost-lobby-host.png', 'mp-ghost-lobby-mobile.png', 'mp-ghost-lobby-overlay.png'];
check('L35', 'the three required screenshots were written (deliverable)',
  requiredShots.every((f) => fs.existsSync(path.join(OUT, f))),
  requiredShots.map((f) => `${f}:${fs.existsSync(path.join(OUT, f)) ? 'yes' : 'no'}`).join(' '));

check('L36', 'no fatal harness error',
  !state.fatal,
  state.fatal ? `${state.fatalPhase}: ${state.fatal}` : 'none');

const passed = A.filter((a) => a.pass).length;
const failed = A.length - passed;

const report = {
  test: 'two-browser 2P LOUNGE ghost room (Route A lounge side: selector, room card, turn, handoff, rematch, live regression)',
  scopeNote: 'Lounge UI + plan + handoff only; every /play-net document request is held, so no emulator boot and no tape swap. Ghost replay itself is _server/test-mp-ghost-replay.mjs.',
  baseUrl: BASE,
  instance: server,
  rooms: state.rooms,
  rematchTurnFlip: { firstRaceTurn: gh.mpTurn || null, nextTurn: state.rematch.nextTurn || null, drive: state.rematch.drive || null },
  startedAt: iso(startedAt),
  finishedAt: state.finishedAt,
  durationMs: state.durationMs,
  steps,
  r4: state.r4,
  ghost: state.ghost,
  live: state.live,
  mobile: state.mobile,
  rematch: state.rematch,
  screenshots: state.screenshots,
  console: state.console,
  fatal: state.fatal ? { phase: state.fatalPhase, message: state.fatal } : null,
  assertions: A,
  summary: { total: A.length, passed, failed },
};

fs.writeFileSync(path.join(OUT, 'mp-ghost-lobby.json'), JSON.stringify(report, null, 2) + '\n', 'utf8');

const logOut = [
  '2P LOUNGE GHOST ROOM (Route A, lounge side) — two isolated browser contexts',
  `base: ${BASE}  (spawned=${server.spawned}${KEEP ? ', kept' : ''})`,
  'command: cd "_server"; node test-mp-ghost-lobby.mjs',
  `rooms: r4=${state.rooms.r4} ghost=${state.rooms.ghost} live=${state.rooms.live} mobile=${state.rooms.mobile || ''}`,
  `rematch: first turn=${gh.mpTurn || '(none)'} -> next turn=${state.rematch.nextTurn || '(none)'}`,
  `started: ${report.startedAt}  finished: ${report.finishedAt}  (${state.durationMs} ms)`,
  `screenshots: ${Object.values(state.screenshots).join(', ') || '(none)'}`,
  '',
  ...logLines.filter((l) => l.startsWith('STEP') || l.startsWith('FATAL') || l.startsWith('PASS') || l.startsWith('FAIL')),
  '',
  `checks: ${passed} passed / ${failed} failed (of ${A.length})`,
  failed ? 'RESULT: FAIL' : 'RESULT: PASS',
  '',
].join('\n');
fs.writeFileSync(path.join(OUT, 'mp-ghost-lobby.log'), '\ufeff' + logOut, 'utf8');

log(`checks: ${passed} passed / ${failed} failed (of ${A.length})`);
log(`evidence: ${path.join(OUT, 'mp-ghost-lobby.json')}, ${path.join(OUT, 'mp-ghost-lobby.log')}`);
process.exitCode = failed ? 1 : 0;
