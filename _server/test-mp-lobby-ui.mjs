// Two-browser 2P LOBBY UI flow test (NOT the emulator race).
//
// Proves the shell -> 2P LOUNGE -> room code -> both ready -> 3-2-1-GO ->
// shell hands each browser to /play-net?... with the same room/race/track/cars
// and the correct mpRole.
//
// Usage: cd "_server"; node test-mp-lobby-ui.mjs
// Server: http://localhost:8080 (must already be running, relay on :3010).
//
// Writes to _runtime/:
//   mp-lobby-ui-host.png / mp-lobby-ui-guest.png        (GO overlay)
//   mp-lobby-ui-host-room.png / mp-lobby-ui-guest-room.png (READY room state)
//   mp-lobby-ui.json
//   mp-lobby-ui.log
//
// Harness-only note: /play-net document requests are held (request
// interception) so the GO overlay stays on screen for the screenshots and the
// disc download never starts. The shell's #rr4sFrame.src is still asserted.
import fs from 'node:fs';
import puppeteer from 'puppeteer-core';

const BASE = process.env.RR4_MP_BASE || 'http://localhost:8080';
const OUT = '../_runtime';
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const STEP_TIMEOUT_MS = 30000;
const NAV_HANDOFF_TIMEOUT_MS = 30000;

fs.mkdirSync(OUT, { recursive: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const iso = (t) => new Date(t).toISOString();
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
    steps.push({ name, ok: false, ms: Date.now() - startedAt, startedAt: iso(startedAt), error: err && err.message ? err.message : String(err) });
    log(`STEP FAIL ${name} (${Date.now() - startedAt} ms): ${err && err.message ? err.message : err}`);
    throw err;
  }
}

function randomCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let out = '';
  for (let i = 0; i < 4; i++) out += chars[Math.floor(Math.random() * chars.length)];
  return out;
}

const CODE = randomCode();

function attach(page, label) {
  const rec = { consoleLines: [], consoleErrors: [], consoleIgnored: [], pageErrors: [], requestFailed: [] };
  // The harness holds the /play-net document; when the shell later navigates
  // away (rematch) the held request aborts and EmulatorJS reports its download
  // fallback. That is interception noise, not an app error.
  const CONSOLE_NOISE = [
    /Download error: Download failed/i,
    /THIS METHOD IS A FAILSAFE/i,
    /attempting to fetch from the emulatorjs cdn/i,
    /Failed to fetch/i,
  ];
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
    const url = req.url();
    if (/\/play-net(\?|$)/.test(url)) {
      sink.push(url);
      // Deliberately do not continue(): keeps the lobby document (with the
      // GO overlay) on screen and skips the disc download.
      return;
    }
    req.continue().catch(() => {});
  });
}

async function shellFrameSrc(page) {
  return page.evaluate(() => {
    const f = document.querySelector('#rr4sFrame');
    return f ? f.src : '';
  });
}

async function waitShellFrameUrl(page, needle, timeout = STEP_TIMEOUT_MS) {
  await page.waitForFunction(
    (n) => {
      const f = document.querySelector('#rr4sFrame');
      return !!f && String(f.src || '').includes(n);
    },
    { timeout, polling: 100 },
    needle,
  );
  return shellFrameSrc(page);
}

async function waitLobbyFrame(page, timeout = STEP_TIMEOUT_MS) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const frame = page.frames().find((f) => /\/multiplayer(\?|$)/.test(f.url()));
    if (frame) {
      try {
        const ok = await frame.evaluate(() => !!document.querySelector('#mName'));
        if (ok) return frame;
      } catch { /* context still swapping */ }
    }
    await sleep(150);
  }
  throw new Error('lobby iframe (/multiplayer) did not appear in the shell');
}

async function enterCabinet(page, label) {
  await page.goto(BASE + '/', { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForSelector('#rr4-enter', { visible: true, timeout: STEP_TIMEOUT_MS });
  // boot() disables ENTER until the music manifest is loaded.
  await page.waitForFunction(() => {
    const b = document.querySelector('#rr4eEnter');
    return !!b && !b.disabled;
  }, { timeout: STEP_TIMEOUT_MS, polling: 100 });
  await page.click('#rr4eEnter');
  await page.waitForFunction(() => {
    const s = document.querySelector('#rr4-shell');
    return !!s && !s.hidden;
  }, { timeout: STEP_TIMEOUT_MS, polling: 50 });
  const welcomeSrc = await waitShellFrameUrl(page, '/welcome', STEP_TIMEOUT_MS);
  // Wait for the welcome document to be usable before pressing 2P.
  await page.waitForFunction(() => {
    const f = document.querySelector('#rr4sFrame');
    try {
      const d = f.contentDocument;
      return !!d && d.readyState === 'complete' && !!d.body;
    } catch { return false; }
  }, { timeout: STEP_TIMEOUT_MS, polling: 100 });
  return { welcomeSrc, entered: true };
}

async function openLobby(page) {
  await page.click('[data-view="multiplayer"]');
  const src = await waitShellFrameUrl(page, '/multiplayer', STEP_TIMEOUT_MS);
  const frame = await waitLobbyFrame(page);
  // renderRooms() runs on the 'hello'/'rooms' websocket messages and replaces
  // the placeholder text; wait for that so create/join are not sent into a
  // socket that is still connecting.
  await frame.waitForFunction(() => {
    const el = document.querySelector('#mRooms');
    return !!el && !/scanning/i.test(el.textContent || '');
  }, { timeout: STEP_TIMEOUT_MS, polling: 100 });
  return { src, frame };
}

async function fillAndSubmit(frame, name, code, action) {
  await frame.waitForSelector('#mName', { visible: true, timeout: STEP_TIMEOUT_MS });
  await frame.click('#mName', { clickCount: 3 });
  await frame.$eval('#mName', (el) => { el.value = ''; });
  await frame.type('#mName', name, { delay: 8 });
  if (code) {
    await frame.click('#mCode', { clickCount: 3 });
    await frame.$eval('#mCode', (el) => { el.value = ''; });
    await frame.type('#mCode', code, { delay: 8 });
  }
  await frame.click(action === 'create' ? '#mCreate' : '#mJoin');
}

async function snapshotLobby(frame) {
  return frame.evaluate(() => {
    const txt = (sel) => {
      const el = document.querySelector(sel);
      return el ? String(el.textContent || '').trim() : '';
    };
    const overlay = document.querySelector('#mRace');
    let visible = false;
    if (overlay) {
      const cs = getComputedStyle(overlay);
      visible = !overlay.hidden && cs.display !== 'none' && cs.visibility !== 'hidden' && Number(cs.opacity) > 0;
    }
    return {
      roomCode: txt('#mRoomCode'),
      p1: txt('#mP1Name'),
      p2: txt('#mP2Name'),
      p1Ready: txt('#mP1Ready'),
      p2Ready: txt('#mP2Ready'),
      readyPressed: document.querySelector('#mReady')?.getAttribute('aria-pressed') === 'true',
      readyLabel: txt('#mReady'),
      raceOverlayVisible: visible,
      count: txt('#mCount'),
      track: txt('#mRaceTrack'),
      cars: txt('#mRaceCars'),
      roomTrack: txt('#mTrack'),
      roomCars: txt('#mCars'),
    };
  });
}

function parseMpParams(src) {
  const out = {};
  try {
    const u = new URL(src, BASE);
    for (const k of ['mpRole', 'mpRoom', 'mpRace', 'mpTrackIndex', 'mpCarHost', 'mpCarGuest', 'embedded', 'threads']) {
      out[k] = u.searchParams.get(k);
    }
  } catch { /* leave empty */ }
  return out;
}

// ---------------------------------------------------------------- main run
const startedAt = Date.now();
const state = {
  code: CODE,
  contexts: {
    host: { label: 'HOST-A', name: 'HOST-A', roomCode: '', p1: '', p2: '', p1Ready: '', p2Ready: '', readyPressed: false, raceOverlayVisible: false, count: '', track: '', cars: '', roomTrack: '', roomCars: '', shellFrameSrc: '', mpParams: {}, consoleErrors: [], pageErrors: [], requestFailed: [] },
    guest: { label: 'GUEST-B', name: 'GUEST-B', roomCode: '', p1: '', p2: '', p1Ready: '', p2Ready: '', readyPressed: false, raceOverlayVisible: false, count: '', track: '', cars: '', roomTrack: '', roomCars: '', shellFrameSrc: '', mpParams: {}, consoleErrors: [], pageErrors: [], requestFailed: [] },
  },
  entered: { host: false, guest: false },
  welcomeSrc: { host: '', guest: '' },
  lobbySrc: { host: '', guest: '' },
  interceptedPlayNet: [],
  screenshots: {},
  fatal: null,
  phases: {},
};

let browser = null;
let hostPage = null;
let guestPage = null;
let hostRec = null;
let guestRec = null;
let hostFrame = null;
let guestFrame = null;

try {
  browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: true,
    protocolTimeout: 240000,
    defaultViewport: { width: 1440, height: 900 },
    args: [
      '--no-sandbox',
      '--disable-background-timer-throttling',
      '--disable-backgrounding-occluded-windows',
      '--disable-renderer-backgrounding',
      '--mute-audio',
      '--window-size=1440,900',
    ],
  });

  const hostCtx = await browser.createBrowserContext();
  const guestCtx = await browser.createBrowserContext();

  hostPage = await hostCtx.newPage();
  guestPage = await guestCtx.newPage();
  await hostPage.setViewport({ width: 1440, height: 900 });
  await guestPage.setViewport({ width: 1440, height: 900 });
  hostRec = attach(hostPage, 'host');
  guestRec = attach(guestPage, 'guest');
  holdPlayNet(hostPage, state.interceptedPlayNet);
  holdPlayNet(guestPage, state.interceptedPlayNet);

  state.phases.enterStart = iso(Date.now());
  await step('both cabinets enter (ENTER gate -> /welcome)', async () => {
    const [h, g] = await Promise.all([
      enterCabinet(hostPage, 'host'),
      enterCabinet(guestPage, 'guest'),
    ]);
    state.entered.host = h.entered;
    state.entered.guest = g.entered;
    state.welcomeSrc.host = h.welcomeSrc;
    state.welcomeSrc.guest = g.welcomeSrc;
  });
  state.phases.enterEnd = iso(Date.now());

  await step('both shells open 2P LOUNGE (/multiplayer)', async () => {
    const [h, g] = await Promise.all([
      openLobby(hostPage),
      openLobby(guestPage),
    ]);
    hostFrame = h.frame;
    guestFrame = g.frame;
    state.lobbySrc.host = h.src;
    state.lobbySrc.guest = g.src;
  });

  await step('host creates room ' + CODE, async () => {
    await fillAndSubmit(hostFrame, 'HOST-A', CODE, 'create');
    await hostFrame.waitForFunction(
      (c) => (document.querySelector('#mRoomCode')?.textContent || '').trim() === c,
      { timeout: STEP_TIMEOUT_MS, polling: 100 },
      CODE,
    );
  });

  await step('guest joins room ' + CODE, async () => {
    await fillAndSubmit(guestFrame, 'GUEST-B', CODE, 'join');
    await guestFrame.waitForFunction(
      (c) => (document.querySelector('#mRoomCode')?.textContent || '').trim() === c,
      { timeout: STEP_TIMEOUT_MS, polling: 100 },
      CODE,
    );
  });

  await step('both frames show the same room code and both driver names', async () => {
    const check = (label) => async (frame) => {
      await frame.waitForFunction(
        (c, a, b) => {
          const t = (s) => (document.querySelector(s)?.textContent || '').trim();
          return t('#mRoomCode') === c && t('#mP1Name') === a && t('#mP2Name') === b;
        },
        { timeout: STEP_TIMEOUT_MS, polling: 100 },
        CODE, 'HOST-A', 'GUEST-B',
      );
      return label;
    };
    await Promise.all([check('host')(hostFrame), check('guest')(guestFrame)]);
  });

  state.phases.roomReady = iso(Date.now());
  await step('screenshots: READY room state (both drivers present)', async () => {
    await Promise.all([
      hostPage.screenshot({ path: `${OUT}/mp-lobby-ui-host-room.png`, fullPage: true }).then(() => { state.screenshots.hostRoom = `${OUT}/mp-lobby-ui-host-room.png`; }),
      guestPage.screenshot({ path: `${OUT}/mp-lobby-ui-guest-room.png`, fullPage: true }).then(() => { state.screenshots.guestRoom = `${OUT}/mp-lobby-ui-guest-room.png`; }),
    ]);
  });

  await step('both drivers press READY', async () => {
    await hostFrame.click('#mReady');
    await sleep(120);
    await guestFrame.click('#mReady');
    await Promise.all([
      hostFrame.waitForFunction(() => document.querySelector('#mReady')?.getAttribute('aria-pressed') === 'true', { timeout: STEP_TIMEOUT_MS, polling: 100 }),
      guestFrame.waitForFunction(() => document.querySelector('#mReady')?.getAttribute('aria-pressed') === 'true', { timeout: STEP_TIMEOUT_MS, polling: 100 }),
    ]);
  });

  await step('3-2-1 overlay reaches GO in both browsers', async () => {
    await Promise.all([
      hostFrame.waitForFunction(() => {
        const el = document.querySelector('#mRace');
        const c = (document.querySelector('#mCount')?.textContent || '').trim();
        return !!el && !el.hidden && c === 'GO';
      }, { timeout: STEP_TIMEOUT_MS, polling: 100 }),
      guestFrame.waitForFunction(() => {
        const el = document.querySelector('#mRace');
        const c = (document.querySelector('#mCount')?.textContent || '').trim();
        return !!el && !el.hidden && c === 'GO';
      }, { timeout: STEP_TIMEOUT_MS, polling: 100 }),
    ]);
  });
  state.phases.goOverlay = iso(Date.now());

  await step('capture GO overlay snapshots + screenshots in both browsers', async () => {
    const [hs, gs] = await Promise.all([snapshotLobby(hostFrame), snapshotLobby(guestFrame)]);
    Object.assign(state.contexts.host, hs);
    Object.assign(state.contexts.guest, gs);
    await Promise.all([
      hostPage.screenshot({ path: `${OUT}/mp-lobby-ui-host.png`, fullPage: true }).then(() => { state.screenshots.hostGo = `${OUT}/mp-lobby-ui-host.png`; }),
      guestPage.screenshot({ path: `${OUT}/mp-lobby-ui-guest.png`, fullPage: true }).then(() => { state.screenshots.guestGo = `${OUT}/mp-lobby-ui-guest.png`; }),
    ]);
  });

  await step('both shells hand off to /play-net?... with matching mp* params', async () => {
    const [hSrc, gSrc] = await Promise.all([
      (async () => {
        await hostPage.waitForFunction(() => /\/play-net(\?|$)/.test(String(document.querySelector('#rr4sFrame')?.src || '')), { timeout: NAV_HANDOFF_TIMEOUT_MS, polling: 100 });
        return shellFrameSrc(hostPage);
      })(),
      (async () => {
        await guestPage.waitForFunction(() => /\/play-net(\?|$)/.test(String(document.querySelector('#rr4sFrame')?.src || '')), { timeout: NAV_HANDOFF_TIMEOUT_MS, polling: 100 });
        return shellFrameSrc(guestPage);
      })(),
    ]);
    state.contexts.host.shellFrameSrc = hSrc;
    state.contexts.guest.shellFrameSrc = gSrc;
    state.contexts.host.mpParams = parseMpParams(hSrc);
    state.contexts.guest.mpParams = parseMpParams(gSrc);
  });
  state.phases.handoff = iso(Date.now());

  // ---------------------------------------------------------- one-click rematch
  // The game page posts {type:'rr4-rematch'} to the shell; both then reload the
  // lounge with the same code. The host recreates it, the guest retries until it
  // exists, and a second race must start from there.
  state.phases.rematchStart = iso(Date.now());
  await step('rematch: both shells return to the lounge with the same code', async () => {
    await Promise.all([
      hostPage.evaluate((code) => window.postMessage({ type: 'rr4-rematch', code, role: 'host' }, location.origin), CODE),
      guestPage.evaluate((code) => window.postMessage({ type: 'rr4-rematch', code, role: 'guest' }, location.origin), CODE),
    ]);
    const [hSrc, gSrc] = await Promise.all([
      waitShellFrameUrl(hostPage, 'host=1', NAV_HANDOFF_TIMEOUT_MS),
      waitShellFrameUrl(guestPage, 'host=0', NAV_HANDOFF_TIMEOUT_MS),
    ]);
    state.rematch = { hostSrc: hSrc, guestSrc: gSrc };
  });

  await step('rematch: host auto-creates and guest auto-joins the same room', async () => {
    hostFrame = await waitLobbyFrame(hostPage);
    guestFrame = await waitLobbyFrame(guestPage);
    await hostFrame.waitForFunction(
      (c) => (document.querySelector('#mRoomCode')?.textContent || '').trim() === c,
      { timeout: STEP_TIMEOUT_MS, polling: 100 },
      CODE,
    );
    // The guest retries /join while the host is still creating the room.
    await guestFrame.waitForFunction(
      (c) => (document.querySelector('#mRoomCode')?.textContent || '').trim() === c,
      { timeout: STEP_TIMEOUT_MS, polling: 150 },
      CODE,
    );
    const [hs, gs] = await Promise.all([snapshotLobby(hostFrame), snapshotLobby(guestFrame)]);
    state.rematch.host = hs;
    state.rematch.guest = gs;
  });

  await step('rematch: both ready starts a second race', async () => {
    await hostFrame.click('#mReady');
    await sleep(150);
    await guestFrame.click('#mReady');
    await Promise.all([
      hostFrame.waitForFunction(() => {
        const el = document.querySelector('#mRace');
        const c = (document.querySelector('#mCount')?.textContent || '').trim();
        return !!el && !el.hidden && c === 'GO';
      }, { timeout: STEP_TIMEOUT_MS, polling: 100 }),
      guestFrame.waitForFunction(() => {
        const el = document.querySelector('#mRace');
        const c = (document.querySelector('#mCount')?.textContent || '').trim();
        return !!el && !el.hidden && c === 'GO';
      }, { timeout: STEP_TIMEOUT_MS, polling: 100 }),
    ]);
    const wait = (page) => page.waitForFunction(
      () => /\/play-net(\?|$)/.test(String(document.querySelector('#rr4sFrame')?.src || '')),
      { timeout: NAV_HANDOFF_TIMEOUT_MS, polling: 100 },
    );
    await Promise.all([wait(hostPage), wait(guestPage)]);
    state.rematch.secondRace = {
      host: await shellFrameSrc(hostPage),
      guest: await shellFrameSrc(guestPage),
    };
  });
  state.phases.rematchEnd = iso(Date.now());
} catch (err) {
  state.fatal = { message: err && err.message ? err.message : String(err), at: iso(Date.now()) };
  log(`FATAL ${state.fatal.message}`);
  // Best-effort partial evidence: whatever the two lobby documents show now.
  for (const [key, frame] of [['host', hostFrame], ['guest', guestFrame]]) {
    if (!frame) continue;
    try { Object.assign(state.contexts[key], await snapshotLobby(frame)); } catch { /* ignore */ }
  }
  for (const [key, page] of [['host', hostPage], ['guest', guestPage]]) {
    if (!page) continue;
    try {
      const src = await shellFrameSrc(page);
      state.contexts[key].shellFrameSrc = src;
      state.contexts[key].mpParams = parseMpParams(src);
    } catch { /* ignore */ }
  }
} finally {
  state.finishedAt = iso(Date.now());
  state.durationMs = Date.now() - startedAt;
  if (hostRec) {
    state.contexts.host.consoleErrors = hostRec.consoleErrors;
    state.contexts.host.pageErrors = hostRec.pageErrors;
    state.contexts.host.requestFailed = hostRec.requestFailed;
    state.contexts.host.consoleLines = hostRec.consoleLines.slice(-200);
  }
  if (guestRec) {
    state.contexts.guest.consoleErrors = guestRec.consoleErrors;
    state.contexts.guest.pageErrors = guestRec.pageErrors;
    state.contexts.guest.requestFailed = guestRec.requestFailed;
    state.contexts.guest.consoleLines = guestRec.consoleLines.slice(-200);
  }
  try { await hostPage?.close(); } catch { /* ignore */ }
  try { await guestPage?.close(); } catch { /* ignore */ }
  try { await browser?.close(); } catch { /* ignore */ }
}

// -------------------------------------------------------------- assertions
const A = [];
function check(id, name, pass, detail) {
  const entry = { id, name, pass: !!pass, detail: detail === undefined ? '' : String(detail) };
  A.push(entry);
  log(`${pass ? 'PASS' : 'FAIL'} ${id}: ${name}${entry.detail ? ' — ' + entry.detail : ''}`);
}

const H = state.contexts.host;
const G = state.contexts.guest;
const sameRooms = !!H.roomCode && H.roomCode === G.roomCode && H.roomCode === CODE;

check('A01', 'HOST-A enters cabinet and shell loads /welcome', state.entered.host && /\/welcome/.test(state.welcomeSrc.host), `frame=${state.welcomeSrc.host}`);
check('A02', 'GUEST-B enters cabinet and shell loads /welcome', state.entered.guest && /\/welcome/.test(state.welcomeSrc.guest), `frame=${state.welcomeSrc.guest}`);
check('A03', 'HOST-A shell 2P button loads /multiplayer in #rr4sFrame', /\/multiplayer/.test(state.lobbySrc.host), `frame=${state.lobbySrc.host}`);
check('A04', 'GUEST-B shell 2P button loads /multiplayer in #rr4sFrame', /\/multiplayer/.test(state.lobbySrc.guest), `frame=${state.lobbySrc.guest}`);
check('A05', 'HOST-A room code matches created code', H.roomCode === CODE, `room=${H.roomCode || '(none)'} expected=${CODE}`);
check('A06', 'GUEST-B sees the same room code after join', G.roomCode === CODE, `room=${G.roomCode || '(none)'} expected=${CODE}`);
check('A07', 'both browsers show the identical room code', sameRooms, `host=${H.roomCode || '(none)'} guest=${G.roomCode || '(none)'}`);
check('A08', 'HOST-A frame shows P1 HOST-A and P2 GUEST-B', H.p1 === 'HOST-A' && H.p2 === 'GUEST-B', `p1=${H.p1 || '(none)'} p2=${H.p2 || '(none)'}`);
check('A09', 'GUEST-B frame shows P1 HOST-A and P2 GUEST-B', G.p1 === 'HOST-A' && G.p2 === 'GUEST-B', `p1=${G.p1 || '(none)'} p2=${G.p2 || '(none)'}`);
check('A10', 'HOST-A READY button is pressed', H.readyPressed, `aria-pressed=${H.readyPressed} p1Ready=${H.p1Ready} p2Ready=${H.p2Ready}`);
check('A11', 'GUEST-B READY button is pressed', G.readyPressed, `aria-pressed=${G.readyPressed} p1Ready=${G.p1Ready} p2Ready=${G.p2Ready}`);
check('A12', 'HOST-A sees the 3-2-1 race overlay', H.raceOverlayVisible, `visible=${H.raceOverlayVisible} count=${H.count}`);
check('A13', 'GUEST-B sees the 3-2-1 race overlay', G.raceOverlayVisible, `visible=${G.raceOverlayVisible} count=${G.count}`);
check('A14', 'HOST-A countdown reaches GO', H.count === 'GO', `count=${H.count}`);
check('A15', 'GUEST-B countdown reaches GO', G.count === 'GO', `count=${G.count}`);
check('A16', 'both overlays show the same track', !!H.track && H.track === G.track, `host="${H.track}" guest="${G.track}"`);
check('A17', 'both overlays show the same car lines', !!H.cars && H.cars === G.cars, `host="${H.cars}" guest="${G.cars}"`);
check('A18', 'HOST-A shell frame is a /play-net URL', /\/play-net(\?|$)/.test(H.shellFrameSrc), H.shellFrameSrc);
check('A19', 'GUEST-B shell frame is a /play-net URL', /\/play-net(\?|$)/.test(G.shellFrameSrc), G.shellFrameSrc);
check('A20', 'mpRoom matches on both and equals the lobby code', H.mpParams.mpRoom === G.mpParams.mpRoom && H.mpParams.mpRoom === CODE, `host=${H.mpParams.mpRoom} guest=${G.mpParams.mpRoom}`);
check('A21', 'mpRace is present and identical on both', !!H.mpParams.mpRace && H.mpParams.mpRace === G.mpParams.mpRace, `host=${H.mpParams.mpRace} guest=${G.mpParams.mpRace}`);
check('A22', 'mpTrackIndex is present and identical on both', H.mpParams.mpTrackIndex != null && H.mpParams.mpTrackIndex === G.mpParams.mpTrackIndex, `host=${H.mpParams.mpTrackIndex} guest=${G.mpParams.mpTrackIndex}`);
check('A23', 'mpCarHost is present and identical on both', H.mpParams.mpCarHost != null && H.mpParams.mpCarHost === G.mpParams.mpCarHost, `host=${H.mpParams.mpCarHost} guest=${G.mpParams.mpCarHost}`);
check('A24', 'mpCarGuest is present and identical on both', H.mpParams.mpCarGuest != null && H.mpParams.mpCarGuest === G.mpParams.mpCarGuest, `host=${H.mpParams.mpCarGuest} guest=${G.mpParams.mpCarGuest}`);
check('A25', 'mpRole is host for HOST-A and guest for GUEST-B', H.mpParams.mpRole === 'host' && G.mpParams.mpRole === 'guest', `host=${H.mpParams.mpRole} guest=${G.mpParams.mpRole}`);

const R = state.rematch || {};
check('R01', 'rematch sends the host back to the lounge with host=1',
  /\/multiplayer\?/.test(R.hostSrc || '') && /host=1/.test(R.hostSrc || '') && new RegExp(`room=${CODE}`).test(R.hostSrc || ''),
  `frame=${R.hostSrc || '(none)'}`);
check('R02', 'rematch sends the guest back to the lounge with host=0',
  /\/multiplayer\?/.test(R.guestSrc || '') && /host=0/.test(R.guestSrc || '') && new RegExp(`room=${CODE}`).test(R.guestSrc || ''),
  `frame=${R.guestSrc || '(none)'}`);
check('R03', 'rematch host auto-created the same room code', !!R.host && R.host.roomCode === CODE,
  `room=${R.host ? R.host.roomCode : '(none)'} expected=${CODE}`);
check('R04', 'rematch guest auto-joined the same room after retrying', !!R.guest && R.guest.roomCode === CODE,
  `room=${R.guest ? R.guest.roomCode : '(none)'} expected=${CODE}`);
check('R05', 'rematch starts a second race for both seats',
  !!R.secondRace && /mpRole=host/.test(R.secondRace.host || '') && /mpRole=guest/.test(R.secondRace.guest || ''),
  `host=${R.secondRace ? R.secondRace.host : '(none)'} guest=${R.secondRace ? R.secondRace.guest : '(none)'}`);
check('A26', 'no uncaught page errors in either browser', H.pageErrors.length === 0 && G.pageErrors.length === 0, `host=${H.pageErrors.length} guest=${G.pageErrors.length}`);
check('A27', 'no console errors in either browser', H.consoleErrors.length === 0 && G.consoleErrors.length === 0, `host=${H.consoleErrors.length} guest=${G.consoleErrors.length}`);
check('A28', 'no fatal harness error', !state.fatal, state.fatal ? state.fatal.message : 'none');

const passed = A.filter((a) => a.pass).length;
const failed = A.length - passed;

const report = {
  test: 'two-browser 2P LOBBY UI flow (shell -> /multiplayer -> ready -> GO -> /play-net handoff)',
  scopeNote: 'Lobby UI handoff only. The EmulatorJS/PCSX_Rearmed race boot is NOT covered; /play-net document requests were held by the harness.',
  baseUrl: BASE,
  code: CODE,
  startedAt: iso(startedAt),
  finishedAt: state.finishedAt,
  durationMs: state.durationMs,
  phases: state.phases,
  steps,
  contexts: {
    host: state.contexts.host,
    guest: state.contexts.guest,
  },
  interceptedPlayNet: state.interceptedPlayNet,
  screenshots: {
    ...state.screenshots,
    roomPhaseNote: 'The -room.png pair is the room card with both drivers present and READY buttons armed, captured just before either READY click (the server shows the race overlay in the same tick the second READY lands, so a "both READY, no overlay" frame does not exist).',
    goPhaseNote: 'The GO overlays are held on screen by request interception on the /play-net document, so the shot is taken at count=GO before the iframe navigates.',
  },
  fatal: state.fatal,
  assertions: A,
  summary: { total: A.length, passed, failed },
};

fs.writeFileSync(`${OUT}/mp-lobby-ui.json`, JSON.stringify(report, null, 2) + '\n', 'utf8');

const logOut = [
  'R4 2P LOBBY UI — two independent browser contexts',
  `base: ${BASE}`,
  `command: cd "_server"; node test-mp-lobby-ui.mjs`,
  `room code: ${CODE}`,
  `started: ${report.startedAt}  finished: ${report.finishedAt}  (${state.durationMs} ms)`,
  `screenshots: ${Object.values(state.screenshots).join(', ') || '(none)'}`,
  '',
  ...logLines.filter((l) => l.startsWith('STEP') || l.startsWith('FATAL') || l.startsWith('PASS') || l.startsWith('FAIL')),
  '',
  `checks: ${passed} passed / ${failed} failed (of ${A.length})`,
  failed ? 'RESULT: FAIL' : 'RESULT: PASS',
  '',
].join('\n');
fs.writeFileSync(`${OUT}/mp-lobby-ui.log`, '\ufeff' + logOut, 'utf8');

log(`checks: ${passed} passed / ${failed} failed (of ${A.length})`);
log(`evidence: ${OUT}/mp-lobby-ui.json, ${OUT}/mp-lobby-ui.log`);
process.exitCode = failed ? 1 : 0;
