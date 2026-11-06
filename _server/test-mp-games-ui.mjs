// Two-browser multi-disc 2P LOUNGE UI test (no emulator boot).
//
// Proves the disc selector / shared-car contract on /multiplayer for the three
// discs, against a cabinet this harness spawns itself on :8093:
//   RAGE start selector -> SHARED CAR hint -> create/join -> room + list badges
//   -> host-only disc change (guest follows) -> both READY -> shared-car overlay
//   -> handoff `game=rage` on both sides; the same for RIDGE; and the R4
//   regression (VS BATTLE card, two cars, `game=r4`). Plus ?game= deep link,
//   localStorage persistence, and 390x844 overflow checks.
//
// Harness-only note: every `/play-net*` document request is held (request
// interception) and never continued, so the lobby document - with the GO
// overlay - stays on screen and no disc is downloaded / no core boots.
//
// Usage: cd "_server"; node test-mp-games-ui.mjs
//        node test-mp-games-ui.mjs --base http://127.0.0.1:8093
//        node test-mp-games-ui.mjs --port 8093 --keep
//
// Writes to _runtime/:
//   mp-games-lounge-host.png / mp-games-lounge-mobile.png
//   mp-games-grid-rage.png / mp-games-grid-ridge.png
//   mp-games-ui.json / mp-games-ui.log
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';

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

const PORT = Number(arg('port', 8093) || 8093);
const BASE_ARG = typeof arg('base') === 'string' ? arg('base').replace(/\/+$/, '') : '';
const BASE = BASE_ARG || `http://127.0.0.1:${PORT}`;
const SPAWN_OWN = !BASE_ARG;
const KEEP = flag('keep');
const STEP_TIMEOUT_MS = 30000;
const NAV_TIMEOUT_MS = 30000;
const DESKTOP = { width: 1440, height: 900 };
const MOBILE = { width: 390, height: 844 };
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

fs.mkdirSync(OUT, { recursive: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const iso = (t) => new Date(t).toISOString();
const logLines = [];
const log = (...a) => {
  const line = a.map((v) => (typeof v === 'string' ? v : JSON.stringify(v))).join(' ');
  console.log(line);
  logLines.push(line);
};

const randomCode = () => Array.from({ length: 4 }, () => CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)]).join('');

const steps = [];
async function step(name, fn) {
  const startedAt = Date.now();
  try {
    const value = await fn();
    steps.push({ name, ok: true, ms: Date.now() - startedAt, startedAt: iso(startedAt) });
    log(`STEP OK   ${name} (${Date.now() - startedAt} ms)`);
    return value;
  } catch (err) {
    steps.push({ name, ok: false, ms: Date.now() - startedAt, startedAt: iso(startedAt), error: err && err.message ? err.message : String(err) });
    log(`STEP FAIL ${name} (${Date.now() - startedAt} ms): ${err && err.message ? err.message : err}`);
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
      // Deliberately not continued: keeps the lobby document (GO overlay) on
      // screen and skips the disc download / core boot entirely.
      return;
    }
    req.continue().catch(() => {});
  });
}

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

async function waitFor(fn, ms, label, stepMs = 250) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await fn()) return true;
    await sleep(stepMs);
  }
  throw new Error(`${label} not ready within ${ms}ms`);
}

async function startInstance() {
  if (!SPAWN_OWN) {
    await waitFor(healthUp, 20000, `${BASE} /api/health`, 250);
    server.reused = true;
    log(`instance: attached to ${BASE} (nothing spawned)`);
    return;
  }
  if (await healthUp()) {
    // Idempotent port: reuse a throwaway instance a previous run left behind.
    server.reused = true;
    log(`instance: :${PORT} already answering /api/health (nothing spawned, nothing killed)`);
    return;
  }
  server.env = { RR4_PORT: String(PORT), RR4_NO_AUTOSTART: '1' };
  server.logPath = path.join(OUT, `mp-games-ui-server-${PORT}.log`);
  let logFd = null;
  try { logFd = fs.openSync(server.logPath, 'a'); } catch { logFd = null; }
  const child = spawn(process.execPath, ['src/server.js'], {
    cwd: HERE,
    env: { ...process.env, ...server.env },
    stdio: ['ignore', logFd === null ? 'pipe' : logFd, logFd === null ? 'pipe' : logFd],
    windowsHide: true,
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
  log(`instance: spawned :${PORT} pid=${server.pid} RR4_NO_AUTOSTART=1`);
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

async function gotoLobby(client, query = '') {
  const { page } = client;
  await page.goto(`${BASE}/multiplayer${query}`, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForSelector('#mName', { visible: true, timeout: STEP_TIMEOUT_MS });
  // Wait for the manifest fetch to settle so the selector is the real list.
  await page.waitForFunction(() => document.querySelectorAll('#mGame option').length >= 3, { timeout: STEP_TIMEOUT_MS, polling: 100 });
  await page.waitForFunction(() => {
    const el = document.querySelector('#mRooms');
    return !!el && !/scanning/i.test(el.textContent || '');
  }, { timeout: STEP_TIMEOUT_MS, polling: 100 });
  return page;
}

async function setDisc(page, key) {
  await page.select('#mGame', key);
  await page.waitForFunction((k) => document.querySelector('#mGame')?.value === k, { timeout: STEP_TIMEOUT_MS, polling: 100 }, key);
  return page.evaluate(() => ({
    value: document.querySelector('#mGame')?.value || '',
    hint: (document.querySelector('#mGameHint')?.textContent || '').trim(),
  }));
}

async function fillName(page, name) {
  await page.click('#mName', { clickCount: 3 });
  await page.$eval('#mName', (el) => { el.value = ''; });
  await page.type('#mName', name, { delay: 5 });
}

async function createRoom(page, name, code) {
  await fillName(page, name);
  await page.click('#mCode', { clickCount: 3 });
  await page.$eval('#mCode', (el) => { el.value = ''; });
  await page.type('#mCode', code, { delay: 5 });
  await page.click('#mCreate');
  // `joined` paints the code first; the room state (slot names, disc card,
  // selector enable/disable) lands in the following `room` message.
  await page.waitForFunction(({ c, n }) => {
    const t = (s) => (document.querySelector(s)?.textContent || '').trim();
    return t('#mRoomCode') === c && t('#mP1Name') === n && t('#mRoomGame') !== 'R4 // VS BATTLE';
  }, { timeout: STEP_TIMEOUT_MS, polling: 100 }, { c: code, n: name });
}

async function joinRoom(page, name, code) {
  await fillName(page, name);
  await page.click('#mCode', { clickCount: 3 });
  await page.$eval('#mCode', (el) => { el.value = ''; });
  await page.type('#mCode', code, { delay: 5 });
  await page.click('#mJoin');
  await page.waitForFunction(({ c, n }) => {
    const t = (s) => (document.querySelector(s)?.textContent || '').trim();
    return t('#mRoomCode') === c && t('#mP1Name') === 'HOST-A' && t('#mP2Name') === n
      && t('#mRoomGame') !== 'R4 // VS BATTLE';
  }, { timeout: STEP_TIMEOUT_MS, polling: 100 }, { c: code, n: name });
}

async function roomCard(page) {
  return page.evaluate(() => {
    const txt = (sel) => {
      const el = document.querySelector(sel);
      return el ? String(el.textContent || '').trim() : '';
    };
    const sel = document.querySelector('#mRoomGameSel');
    return {
      roomGame: txt('#mRoomGame'),
      roomGameValue: sel ? sel.value : '',
      roomGameDisabled: sel ? !!sel.disabled : null,
      roomCode: txt('#mRoomCode'),
      p1: txt('#mP1Name'),
      p2: txt('#mP2Name'),
      track: txt('#mTrack'),
      cars: txt('#mCars'),
      invite: txt('#mInvite'),
    };
  });
}

async function roomBadge(page, code) {
  return page.evaluate((c) => {
    const rows = Array.from(document.querySelectorAll('#mRooms .mroom-row'));
    const row = rows.find((r) => (r.querySelector('.mroom-code')?.textContent || '').trim() === c);
    if (!row) return { found: false, badge: '', hasBadge: false };
    const badge = row.querySelector('.mroom-game');
    return { found: true, hasBadge: !!badge, badge: badge ? String(badge.textContent || '').trim() : '' };
  }, code);
}

async function overlay(page) {
  return page.evaluate(() => {
    const txt = (sel) => {
      const el = document.querySelector(sel);
      return el ? String(el.textContent || '').trim() : '';
    };
    const race = document.querySelector('#mRace');
    let ready = false;
    if (race) {
      const cs = getComputedStyle(race);
      ready = !race.hidden && cs.display !== 'none' && cs.visibility !== 'hidden' && Number(cs.opacity) > 0;
    }
    const cars = txt('#mRaceCars');
    return {
      ready,
      count: txt('#mCount'),
      kicker: txt('#mRaceKicker'),
      track: txt('#mRaceTrack'),
      cars,
      sharedLines: (cars.match(/SHARED\s*\/\//g) || []).length,
      p1Lines: (cars.match(/P1\s/g) || []).length,
      p2Lines: (cars.match(/P2\s/g) || []).length,
    };
  });
}

async function pressReady(page) {
  await page.click('#mReady');
  await page.waitForFunction(() => document.querySelector('#mReady')?.getAttribute('aria-pressed') === 'true',
    { timeout: STEP_TIMEOUT_MS, polling: 100 });
}

// The lobby counts 3-2-1-GO on a 900 ms tick and then assigns location.href to
// /play-net. Once that navigation is pending (its document request is held) the
// old document can no longer be evaluated, so this harness stretches ONLY that
// 900 ms tick to 4500 ms. The overlay is then stable for the GO snapshot +
// screenshot while the handoff URL is still produced normally.
async function slowCountdown(page) {
  await page.evaluate(() => {
    if (window.__rr4SlowCountdown) return true;
    const orig = window.setInterval;
    window.setInterval = function (fn, ms, ...rest) {
      return orig.call(this, fn, ms === 900 ? 4500 : ms, ...rest);
    };
    window.__rr4SlowCountdown = true;
    return true;
  });
}

async function waitGo(page) {
  await page.waitForFunction(() => {
    const el = document.querySelector('#mRace');
    const c = (document.querySelector('#mCount')?.textContent || '').trim();
    return !!el && !el.hidden && c === 'GO';
  }, { timeout: STEP_TIMEOUT_MS, polling: 100 });
}

async function waitHeldUrl(client, timeout = NAV_TIMEOUT_MS) {
  await waitFor(() => client.held.length > 0, timeout, `${client.label} /play-net handoff`, 100);
  return client.held[client.held.length - 1];
}

function parseMp(url) {
  const out = {};
  try {
    const u = new URL(url, BASE);
    for (const k of ['mpRole', 'mpRoom', 'mpRace', 'mpTrackIndex', 'mpCarHost', 'mpCarGuest', 'threads', 'game']) {
      out[k] = u.searchParams.get(k);
    }
  } catch { /* leave empty */ }
  return out;
}

async function shot(page, file) {
  await page.screenshot({ path: `${OUT}/${file}` });
  state.screenshots[file] = `${OUT}/${file}`;
}

/* ------------------------------------------------------------------ main --- */

const startedAt = Date.now();
const clients = [];
const state = {
  base: BASE,
  instance: server,
  phases: {},
  rage: { code: randomCode() },
  ridge: { code: randomCode() },
  r4: { code: randomCode() },
  deepLink: {},
  mobile: {},
  screenshots: {},
  fatal: null,
  fatalPhase: '',
};

let browser = null;

/** One lobby pair on the given discs; returns the captured room/overlay data. */
async function runPair(phase, { code, select }) {
  const host = await newClient(`${phase}-host`, DESKTOP);
  const guest = await newClient(`${phase}-guest`, DESKTOP);
  const result = { code, handoff: {}, go: {}, cards: {} };

  await gotoLobby(host);
  await gotoLobby(guest);
  if (select) result.start = await setDisc(host.page, select);

  await createRoom(host.page, 'HOST-A', code);
  result.cards.host = await roomCard(host.page);

  // The guest has to see the room in the list (with its disc badge) before it joins.
  await guest.page.waitForFunction((c) => {
    const rows = Array.from(document.querySelectorAll('#mRooms .mroom-row'));
    return rows.some((r) => (r.querySelector('.mroom-code')?.textContent || '').trim() === c);
  }, { timeout: STEP_TIMEOUT_MS, polling: 150 }, code);
  result.roomsBadge = await roomBadge(guest.page, code);

  await joinRoom(guest.page, 'GUEST-B', code);
  result.cards.guest = await roomCard(guest.page);

  if (phase === 'rage') {
    // host-only disc change: RIDGE, then back to RAGE.
    await host.page.select('#mRoomGameSel', 'ridge');
    await host.page.waitForFunction(() => (document.querySelector('#mRoomGame')?.textContent || '').includes('RIDGE RACER //'),
      { timeout: STEP_TIMEOUT_MS, polling: 100 });
    await guest.page.waitForFunction(() => (document.querySelector('#mRoomGame')?.textContent || '').includes('RIDGE RACER //'),
      { timeout: STEP_TIMEOUT_MS, polling: 100 });
    result.afterRidge = { host: await roomCard(host.page), guest: await roomCard(guest.page) };

    await host.page.select('#mRoomGameSel', 'rage');
    await host.page.waitForFunction(() => (document.querySelector('#mRoomGame')?.textContent || '').includes('RAGE RACER //'),
      { timeout: STEP_TIMEOUT_MS, polling: 100 });
    await guest.page.waitForFunction(() => (document.querySelector('#mRoomGame')?.textContent || '').includes('RAGE RACER //'),
      { timeout: STEP_TIMEOUT_MS, polling: 100 });
    result.afterRage = { host: await roomCard(host.page), guest: await roomCard(guest.page) };
    await shot(host.page, 'mp-games-lounge-host.png');
  }

  result.hostSelBeforeReady = await host.page.evaluate(() => !!document.querySelector('#mRoomGameSel')?.disabled);
  result.guestSelBeforeReady = await guest.page.evaluate(() => !!document.querySelector('#mRoomGameSel')?.disabled);

  await slowCountdown(host.page);
  await slowCountdown(guest.page);
  await pressReady(host.page);
  await sleep(120);
  await pressReady(guest.page);
  await Promise.all([waitGo(host.page), waitGo(guest.page)]);

  // Capture BEFORE the handoff navigation starts: a pending (held) navigation
  // suspends the old document, so evaluate/screenshot must happen first.
  result.go.host = await overlay(host.page);
  result.go.guest = await overlay(guest.page);
  result.cards.hostAfterGo = await roomCard(host.page);
  result.cards.guestAfterGo = await roomCard(guest.page);
  if (phase === 'rage') await shot(host.page, 'mp-games-grid-rage.png');
  if (phase === 'ridge') await shot(host.page, 'mp-games-grid-ridge.png');

  const heldHost = await waitHeldUrl(host);
  const heldGuest = await waitHeldUrl(guest);
  result.handoff.hostUrl = heldHost;
  result.handoff.guestUrl = heldGuest;
  result.handoff.host = parseMp(heldHost);
  result.handoff.guest = parseMp(heldGuest);
  return result;
}

try {
  await startInstance();
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
      '--mute-audio',
      '--window-size=1440,900',
    ],
  });

  // ---- phase 1: RAGE (selector, host disc change, shared-car overlay) ----
  state.phases.rage = iso(Date.now());
  try {
    Object.assign(state.rage, await step('rage: select RAGE, create/join, change disc, READY, GO, handoff', async () => (
      runPair('rage', { code: state.rage.code, select: 'rage' })
    )));
  } catch (err) {
    state.rage.error = err && err.message ? err.message : String(err);
    if (!state.fatal) { state.fatal = state.rage.error; state.fatalPhase = 'rage'; }
  }

  // ---- phase 2: RIDGE (shared car with a single course) ----
  try {
    Object.assign(state.ridge, await step('ridge: select RIDGE, create/join, READY, GO, handoff', async () => (
      runPair('ridge', { code: state.ridge.code, select: 'ridge' })
    )));
  } catch (err) {
    state.ridge.error = err && err.message ? err.message : String(err);
    if (!state.fatal) { state.fatal = state.ridge.error; state.fatalPhase = 'ridge'; }
  }

  // ---- phase 3: R4 regression (default disc, two cars) ----
  try {
    Object.assign(state.r4, await step('r4: default disc, create/join, READY, GO, handoff', async () => (
      runPair('r4', { code: state.r4.code, select: null })
    )));
  } catch (err) {
    state.r4.error = err && err.message ? err.message : String(err);
    if (!state.fatal) { state.fatal = state.r4.error; state.fatalPhase = 'r4'; }
  }

  // ---- phase 4: deep link + persistence ----
  try {
    await step('deep link ?game=ridge preselects the disc', async () => {
      const c = await newClient('deeplink', DESKTOP);
      await gotoLobby(c, '?game=ridge');
      state.deepLink.deep = await c.page.evaluate(() => ({
        value: document.querySelector('#mGame')?.value || '',
        hint: (document.querySelector('#mGameHint')?.textContent || '').trim(),
        options: document.querySelectorAll('#mGame option').length,
      }));
      await c.page.goto(`${BASE}/multiplayer`, { waitUntil: 'domcontentloaded', timeout: 60000 });
      await c.page.waitForSelector('#mName', { visible: true, timeout: STEP_TIMEOUT_MS });
      await c.page.waitForFunction(() => document.querySelectorAll('#mGame option').length >= 3, { timeout: STEP_TIMEOUT_MS, polling: 100 });
      state.deepLink.freshDefault = await c.page.evaluate(() => document.querySelector('#mGame')?.value || '');
      await c.page.select('#mGame', 'rage');
      await c.page.waitForFunction(() => document.querySelector('#mGame')?.value === 'rage', { timeout: STEP_TIMEOUT_MS, polling: 100 });
      state.deepLink.storedAfterPick = await c.page.evaluate(() => {
        try { return localStorage.getItem('rr4.mp.game') || ''; } catch { return ''; }
      });
      await c.page.reload({ waitUntil: 'domcontentloaded', timeout: 60000 });
      await c.page.waitForSelector('#mName', { visible: true, timeout: STEP_TIMEOUT_MS });
      await c.page.waitForFunction(() => document.querySelectorAll('#mGame option').length >= 3, { timeout: STEP_TIMEOUT_MS, polling: 100 });
      state.deepLink.afterReload = await c.page.evaluate(() => ({
        value: document.querySelector('#mGame')?.value || '',
        hint: (document.querySelector('#mGameHint')?.textContent || '').trim(),
        stored: (() => { try { return localStorage.getItem('rr4.mp.game') || ''; } catch { return ''; } })(),
      }));
    });
  } catch (err) {
    state.deepLink.error = err && err.message ? err.message : String(err);
    if (!state.fatal) { state.fatal = state.deepLink.error; state.fatalPhase = 'deepLink'; }
  }

  // ---- phase 5: mobile 390x844 ----
  try {
    await step('mobile 390x844: start card + room card have no horizontal overflow', async () => {
      const c = await newClient('mobile', MOBILE);
      await gotoLobby(c, '?game=rage');
      state.mobile.start = await c.page.evaluate(() => {
        const el = document.querySelector('#mStart');
        return el ? { scrollWidth: el.scrollWidth, clientWidth: el.clientWidth } : null;
      });
      await setDisc(c.page, 'rage');
      const code = randomCode();
      state.mobile.code = code;
      await createRoom(c.page, 'MOBILE-HOST', code);
      state.mobile.room = await c.page.evaluate(() => {
        const el = document.querySelector('#mRoom');
        return el ? { scrollWidth: el.scrollWidth, clientWidth: el.clientWidth, hidden: el.hidden } : null;
      });
      state.mobile.card = await roomCard(c.page);
      await shot(c.page, 'mp-games-lounge-mobile.png');
    });
  } catch (err) {
    state.mobile.error = err && err.message ? err.message : String(err);
    if (!state.fatal) { state.fatal = state.mobile.error; state.fatalPhase = 'mobile'; }
  }
} catch (err) {
  state.fatal = err && err.message ? err.message : String(err);
  state.fatalPhase = state.fatalPhase || 'setup';
  log(`FATAL ${state.fatal}`);
} finally {
  state.finishedAt = iso(Date.now());
  state.durationMs = Date.now() - startedAt;
  for (const c of clients) {
    state.console = state.console || {};
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

const RAGE = state.rage || {};
const RIDGE = state.ridge || {};
const R4 = state.r4 || {};
const rc = RAGE.cards || {};
const rg = RAGE.go || {};
const rh = RAGE.handoff || {};
const afterRidge = RAGE.afterRidge || {};
const afterRage = RAGE.afterRage || {};
const ridgeCards = RIDGE.cards || {};
const ridgeGo = RIDGE.go || {};
const ridgeHandoff = RIDGE.handoff || {};
const r4Cards = R4.cards || {};
const r4Go = R4.go || {};
const r4Handoff = R4.handoff || {};

check('G01', 'start selector RAGE switches the hint to SHARED CAR',
  RAGE.start && RAGE.start.value === 'rage' && /^SHARED CAR\b/.test(String(RAGE.start.hint || '')),
  `value=${RAGE.start ? RAGE.start.value : '(none)'} hint="${RAGE.start ? RAGE.start.hint : ''}"`);

check('G02', 'host room card reads RAGE RACER // SHARED CAR',
  rc.host && rc.host.roomGame === 'RAGE RACER // SHARED CAR',
  `card="${rc.host ? rc.host.roomGame : '(none)'}"`);

check('G03', 'guest rooms list shows the RAGE disc badge',
  !!RAGE.roomsBadge && RAGE.roomsBadge.found && RAGE.roomsBadge.hasBadge && RAGE.roomsBadge.badge === 'RAGE',
  RAGE.roomsBadge ? `badge="${RAGE.roomsBadge.badge}" found=${RAGE.roomsBadge.found}` : '(no row)');

check('G04', 'guest room card reads RAGE RACER // SHARED CAR',
  rc.guest && rc.guest.roomGame === 'RAGE RACER // SHARED CAR',
  `card="${rc.guest ? rc.guest.roomGame : '(none)'}"`);

check('G05', 'guest disc selector is disabled in the room',
  RAGE.guestSelBeforeReady === true,
  `guest #mRoomGameSel disabled=${RAGE.guestSelBeforeReady}`);

check('G06', 'host disc selector is enabled in the lobby',
  RAGE.hostSelBeforeReady === false,
  `host #mRoomGameSel disabled=${RAGE.hostSelBeforeReady}`);

check('G07', 'host change to RIDGE updates the host card',
  afterRidge.host && afterRidge.host.roomGame === 'RIDGE RACER // SHARED CAR',
  `card="${afterRidge.host ? afterRidge.host.roomGame : '(none)'}"`);

check('G08', 'guest card + selector follow the host change to RIDGE',
  afterRidge.guest && afterRidge.guest.roomGame === 'RIDGE RACER // SHARED CAR'
    && afterRidge.guest.roomGameValue === 'ridge' && afterRidge.guest.roomGameDisabled === true,
  afterRidge.guest ? `card="${afterRidge.guest.roomGame}" sel=${afterRidge.guest.roomGameValue} disabled=${afterRidge.guest.roomGameDisabled}` : '(none)');

check('G09', 'host change back to RAGE lands on both cards',
  afterRage.host && afterRage.host.roomGame === 'RAGE RACER // SHARED CAR'
    && afterRage.guest && afterRage.guest.roomGame === 'RAGE RACER // SHARED CAR',
  `host="${afterRage.host ? afterRage.host.roomGame : '(none)'}" guest="${afterRage.guest ? afterRage.guest.roomGame : '(none)'}"`);

check('G10', 'overlay kicker says SHARED CAR // BOTH PADS DRIVE on both',
  rg.host && rg.guest && rg.host.kicker === 'SHARED CAR // BOTH PADS DRIVE'
    && rg.guest.kicker === 'SHARED CAR // BOTH PADS DRIVE' && rg.host.ready && rg.guest.ready,
  `host="${rg.host ? rg.host.kicker : ''}" guest="${rg.guest ? rg.guest.kicker : ''}"`);

check('G11', 'overlay shows exactly ONE SHARED // <car> line (no P1/P2 cars)',
  rg.host && rg.guest && rg.host.sharedLines === 1 && rg.guest.sharedLines === 1
    && rg.host.p1Lines === 0 && rg.host.p2Lines === 0
    && rg.guest.p1Lines === 0 && rg.guest.p2Lines === 0
    && /^SHARED \/\/ .+/.test(String(rg.host.cars || '')),
  `host="${rg.host ? rg.host.cars : ''}" guest="${rg.guest ? rg.guest.cars : ''}"`);

check('G12', 'both overlays show the same RAGE track',
  !!rg.host && !!rg.guest && !!rg.host.track && rg.host.track === rg.guest.track,
  `host="${rg.host ? rg.host.track : ''}" guest="${rg.guest ? rg.guest.track : ''}"`);

check('G13', 'both overlays show the same shared car line',
  !!rg.host && !!rg.guest && !!rg.host.cars && rg.host.cars === rg.guest.cars,
  `host="${rg.host ? rg.host.cars : ''}" guest="${rg.guest ? rg.guest.cars : ''}"`);

check('G14', 'countdown reaches GO in both browsers',
  rg.host && rg.guest && rg.host.count === 'GO' && rg.guest.count === 'GO',
  `host=${rg.host ? rg.host.count : ''} guest=${rg.guest ? rg.guest.count : ''}`);

check('G15', 'held /play-net URLs carry game=rage on both sides',
  (rh.host && rh.host.game === 'rage') && (rh.guest && rh.guest.game === 'rage'),
  `host=${rh.host ? rh.host.game : '(none)'} guest=${rh.guest ? rh.guest.game : '(none)'}`);

check('G16', 'mpRoom matches on both and equals the lobby code',
  !!rh.host && !!rh.guest && rh.host.mpRoom === rh.guest.mpRoom && rh.host.mpRoom === RAGE.code,
  `host=${rh.host ? rh.host.mpRoom : ''} guest=${rh.guest ? rh.guest.mpRoom : ''} code=${RAGE.code}`);

check('G17', 'mpRace + mpTrackIndex are present and identical on both',
  !!rh.host && !!rh.guest && !!rh.host.mpRace && rh.host.mpRace === rh.guest.mpRace
    && rh.host.mpTrackIndex != null && rh.host.mpTrackIndex === rh.guest.mpTrackIndex,
  `race host=${rh.host ? rh.host.mpRace : ''} guest=${rh.guest ? rh.guest.mpRace : ''} track=${rh.host ? rh.host.mpTrackIndex : ''}/${rh.guest ? rh.guest.mpTrackIndex : ''}`);

check('G18', 'mpCarHost + mpCarGuest are present and identical on both',
  !!rh.host && !!rh.guest && rh.host.mpCarHost != null && rh.host.mpCarHost === rh.guest.mpCarHost
    && rh.host.mpCarGuest != null && rh.host.mpCarGuest === rh.guest.mpCarGuest,
  `host=${rh.host ? `${rh.host.mpCarHost}/${rh.host.mpCarGuest}` : ''} guest=${rh.guest ? `${rh.guest.mpCarHost}/${rh.guest.mpCarGuest}` : ''}`);

check('G19', 'RIDGE room card reads RIDGE RACER // SHARED CAR on both seats',
  ridgeCards.host && ridgeCards.guest && ridgeCards.host.roomGame === 'RIDGE RACER // SHARED CAR'
    && ridgeCards.guest.roomGame === 'RIDGE RACER // SHARED CAR',
  `host="${ridgeCards.host ? ridgeCards.host.roomGame : '(none)'}" guest="${ridgeCards.guest ? ridgeCards.guest.roomGame : '(none)'}"`);

check('G20', 'RIDGE overlay is shared car and the handoff carries game=ridge + mpTrackIndex=0',
  ridgeGo.host && ridgeGo.host.kicker === 'SHARED CAR // BOTH PADS DRIVE'
    && ridgeGo.host.sharedLines === 1 && ridgeGo.host.count === 'GO'
    && ridgeHandoff.host && ridgeHandoff.host.game === 'ridge'
    && ridgeHandoff.guest && ridgeHandoff.guest.game === 'ridge'
    && ridgeHandoff.host.mpTrackIndex === '0' && ridgeHandoff.guest.mpTrackIndex === '0'
    && ridgeHandoff.host.mpRoom === ridgeHandoff.guest.mpRoom && ridgeHandoff.host.mpRoom === RIDGE.code,
  `kicker="${ridgeGo.host ? ridgeGo.host.kicker : ''}" game=${ridgeHandoff.host ? ridgeHandoff.host.game : '(none)'}/${ridgeHandoff.guest ? ridgeHandoff.guest.game : '(none)'} track=${ridgeHandoff.host ? ridgeHandoff.host.mpTrackIndex : ''}`);

check('G21', 'R4 regression: room card reads RIDGE RACER TYPE 4 // VS BATTLE on both',
  r4Cards.host && r4Cards.guest && r4Cards.host.roomGame === 'RIDGE RACER TYPE 4 // VS BATTLE'
    && r4Cards.guest.roomGame === 'RIDGE RACER TYPE 4 // VS BATTLE',
  `host="${r4Cards.host ? r4Cards.host.roomGame : '(none)'}" guest="${r4Cards.guest ? r4Cards.guest.roomGame : '(none)'}"`);

check('G22', 'R4 overlay keeps GRID LOCKED and two P1/P2 car lines',
  r4Go.host && r4Go.host.kicker === 'GRID LOCKED // TEAMS READY'
    && r4Go.host.p1Lines === 1 && r4Go.host.p2Lines === 1 && r4Go.host.sharedLines === 0
    && r4Go.guest && r4Go.guest.cars === r4Go.host.cars,
  `kicker="${r4Go.host ? r4Go.host.kicker : ''}" cars="${r4Go.host ? r4Go.host.cars : ''}"`);

check('G23', 'R4 handoff carries game=r4 with a matching plan on both sides',
  r4Handoff.host && r4Handoff.guest && r4Handoff.host.game === 'r4' && r4Handoff.guest.game === 'r4'
    && r4Handoff.host.mpRoom === r4Handoff.guest.mpRoom && r4Handoff.host.mpRoom === R4.code
    && !!r4Handoff.host.mpRace && r4Handoff.host.mpRace === r4Handoff.guest.mpRace
    && r4Handoff.host.mpRole === 'host' && r4Handoff.guest.mpRole === 'guest',
  `game=${r4Handoff.host ? r4Handoff.host.game : '(none)'}/${r4Handoff.guest ? r4Handoff.guest.game : '(none)'} room=${r4Handoff.host ? r4Handoff.host.mpRoom : ''}`);

check('G24', 'R4 handoff mpTrackIndex is an R4 index (0-7)',
  !!r4Handoff.host && /^[0-7]$/.test(String(r4Handoff.host.mpTrackIndex || ''))
    && r4Handoff.host.mpTrackIndex === r4Handoff.guest.mpTrackIndex,
  `host=${r4Handoff.host ? r4Handoff.host.mpTrackIndex : '(none)'} guest=${r4Handoff.guest ? r4Handoff.guest.mpTrackIndex : '(none)'}`);

const D = state.deepLink || {};
check('G25', 'deep link ?game=ridge preselects RIDGE and shows the SHARED CAR hint',
  D.deep && D.deep.value === 'ridge' && /^SHARED CAR\b/.test(String(D.deep.hint || '')),
  `value=${D.deep ? D.deep.value : '(none)'} hint="${D.deep ? D.deep.hint : ''}"`);

check('G26', 'disc choice persists in localStorage rr4.mp.game across a reload',
  D.storedAfterPick === 'rage' && D.afterReload && D.afterReload.value === 'rage'
    && D.afterReload.stored === 'rage' && /^SHARED CAR\b/.test(String(D.afterReload.hint || '')),
  `stored=${D.storedAfterPick} afterReload=${D.afterReload ? D.afterReload.value : '(none)'} freshDefault=${D.freshDefault || '(none)'}`);

const M = state.mobile || {};
check('G27', 'mobile 390x844: start card has no horizontal overflow',
  !!M.start && M.start.scrollWidth <= M.start.clientWidth + 1,
  M.start ? `scrollWidth=${M.start.scrollWidth} clientWidth=${M.start.clientWidth}` : '(not measured)');

check('G28', 'mobile 390x844: room card has no horizontal overflow',
  !!M.room && M.room.scrollWidth <= M.room.clientWidth + 1 && M.room.hidden === false,
  M.room ? `scrollWidth=${M.room.scrollWidth} clientWidth=${M.room.clientWidth}` : '(not measured)');

const consoleAll = state.console || {};
const unexpectedConsole = Object.values(consoleAll).flatMap((c) => c.consoleErrors || []);
const pageErrorAll = Object.values(consoleAll).flatMap((c) => c.pageErrors || []);
check('G29', 'no uncaught page errors in any browser context',
  pageErrorAll.length === 0,
  `${pageErrorAll.length} page error(s)`);
check('G30', 'no unexpected console errors (expected interception noise allow-listed, not claimed as 0)',
  unexpectedConsole.length === 0,
  `${unexpectedConsole.length} unexpected / ${Object.values(consoleAll).flatMap((c) => c.consoleIgnored || []).length} allow-listed`);

const requiredShots = ['mp-games-lounge-host.png', 'mp-games-lounge-mobile.png', 'mp-games-grid-rage.png', 'mp-games-grid-ridge.png'];
check('G31', 'all four screenshots were written',
  requiredShots.every((f) => fs.existsSync(path.join(OUT, f))),
  requiredShots.map((f) => `${f}:${fs.existsSync(path.join(OUT, f)) ? 'yes' : 'no'}`).join(' '));

check('G32', 'no fatal harness error',
  !state.fatal,
  state.fatal ? `${state.fatalPhase}: ${state.fatal}` : 'none');

const passed = A.filter((a) => a.pass).length;
const failed = A.length - passed;

const report = {
  test: 'two-browser multi-disc 2P LOUNGE UI (RAGE/RIDGE shared car + R4 VS Battle regression)',
  scopeNote: 'Lounge UI + handoff only; /play-net document requests held, so no emulator boot and no Rage/Ridge in-game verification.',
  baseUrl: BASE,
  instance: server,
  rooms: { rage: state.rage.code, ridge: state.ridge.code, r4: state.r4.code, mobile: state.mobile.code || '' },
  startedAt: iso(startedAt),
  finishedAt: state.finishedAt,
  durationMs: state.durationMs,
  phases: state.phases,
  steps,
  rage: state.rage,
  ridge: state.ridge,
  r4: state.r4,
  deepLink: state.deepLink,
  mobile: state.mobile,
  screenshots: state.screenshots,
  console: state.console || {},
  fatal: state.fatal ? { phase: state.fatalPhase, message: state.fatal } : null,
  assertions: A,
  summary: { total: A.length, passed, failed },
};

fs.writeFileSync(`${OUT}/mp-games-ui.json`, JSON.stringify(report, null, 2) + '\n', 'utf8');

const logOut = [
  'MULTI-DISC 2P LOUNGE UI — two independent browser contexts per phase',
  `base: ${BASE}  (spawned=${server.spawned}${KEEP ? ', kept' : ''})`,
  'command: cd "_server"; node test-mp-games-ui.mjs',
  `rooms: rage=${state.rage.code} ridge=${state.ridge.code} r4=${state.r4.code}`,
  `started: ${report.startedAt}  finished: ${report.finishedAt}  (${state.durationMs} ms)`,
  `screenshots: ${Object.values(state.screenshots).join(', ') || '(none)'}`,
  '',
  ...logLines.filter((l) => l.startsWith('STEP') || l.startsWith('FATAL') || l.startsWith('PASS') || l.startsWith('FAIL')),
  '',
  `checks: ${passed} passed / ${failed} failed (of ${A.length})`,
  failed ? 'RESULT: FAIL' : 'RESULT: PASS',
  '',
].join('\n');
fs.writeFileSync(`${OUT}/mp-games-ui.log`, '\ufeff' + logOut, 'utf8');

log(`checks: ${passed} passed / ${failed} failed (of ${A.length})`);
log(`evidence: ${OUT}/mp-games-ui.json, ${OUT}/mp-games-ui.log`);
process.exitCode = failed ? 1 : 0;
