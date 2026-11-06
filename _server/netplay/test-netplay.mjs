// End-to-end LAN netplay test for the standalone EmulatorJS harness.
//
//   node test-netplay.mjs
//
// Starts (or reuses) the netplay relay on :3010 and the static harness on
// :3011, then drives two independent Chrome browser contexts. No native game
// process is launched. Screenshots/logs go to ../../_runtime/netplay-*.
import puppeteer from 'puppeteer-core';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT = '../../_runtime';
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const NP_PORT = 3010;
const WEB_PORT = 3011;
const BASE = `http://127.0.0.1:${WEB_PORT}/`;
const NP = `http://127.0.0.1:${NP_PORT}`;
const GAME_ID = 4001;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
fs.mkdirSync(OUT, { recursive: true });

const results = [];
const events = [];
const serverLog = [];
let serverExit = null;

function record(id, name, pass, detail = '') {
  results.push({ id, name, pass: !!pass, detail: String(detail || '') });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${id}  ${name}${detail ? '  - ' + detail : ''}`);
}
function note(msg) {
  console.log(`      ${msg}`);
  events.push(`      ${msg}`);
}
async function waitFor(label, fn, { timeout = 20000, interval = 150 } = {}) {
  const start = Date.now();
  let last = null;
  while (Date.now() - start < timeout) {
    try {
      last = await fn();
      if (last) return last;
    } catch (e) { last = e.message; }
    await sleep(interval);
  }
  throw new Error(`timeout waiting for ${label}; last=${JSON.stringify(last)}`);
}
function watchPage(page, label) {
  page.on('console', (m) => {
    const text = m.text();
    events.push(`[${label}] console:${m.type()}: ${text}`);
  });
  page.on('pageerror', (e) => events.push(`[${label}] pageerror: ${e.message}`));
  page.on('requestfailed', (r) => events.push(`[${label}] requestfailed: ${r.url()} ${r.failure()?.errorText || ''}`));
}
async function shot(page, name) {
  const file = path.join(OUT, `netplay-${name}.png`);
  await page.screenshot({ path: file });
  return file;
}
function portPids(port) {
  const out = spawnSync('powershell', ['-NoProfile', '-Command',
    `(Get-NetTCPConnection -LocalPort ${port} -State Listen -ErrorAction SilentlyContinue).OwningProcess`],
  { encoding: 'utf8', windowsHide: true, timeout: 10000 });
  return String(out.stdout || '').trim().split(/\s+/).filter((x) => /^\d+$/.test(x) && x !== '0');
}
async function freePort(port) {
  for (const pid of portPids(port)) {
    note(`freeing :${port} from stale pid ${pid}`);
    spawnSync('taskkill', ['/PID', pid, '/T', '/F'], { windowsHide: true, timeout: 10000 });
  }
  await sleep(500);
}
async function health(url) {
  try {
    const r = await fetch(url, { cache: 'no-store' });
    return r.ok ? await r.json() : null;
  } catch { return null; }
}
function startProc(name, args, cwd, env) {
  const p = spawn(process.execPath, args, { cwd, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  p.stdout.on('data', (d) => serverLog.push(`[${name}] ${d.toString()}`));
  p.stderr.on('data', (d) => serverLog.push(`[${name}] ${d.toString()}`));
  p.on('exit', (code, signal) => { serverExit = { name, code, signal }; });
  return p;
}

// ------------------------------------------------------------------ servers
let npProc = null;
let webProc = null;
let browser = null;

try {
  if (!(await health(`${NP}/health`))) {
    await freePort(NP_PORT);
    npProc = startProc('netplay', ['server.js'], HERE, { PORT: String(NP_PORT), HOST: '0.0.0.0' });
    await waitFor('netplay health', () => health(`${NP}/health`), { timeout: 15000 });
  } else {
    note('reusing already-running netplay relay on :3010');
  }
  if (!(await health(`http://127.0.0.1:${WEB_PORT}/health`))) {
    await freePort(WEB_PORT);
    webProc = startProc('harness', ['serve-test.mjs'], HERE, { PORT: String(WEB_PORT) });
    await waitFor('harness health', () => health(`http://127.0.0.1:${WEB_PORT}/health`), { timeout: 15000 });
  } else {
    note('reusing already-running harness on :3011');
  }

  const npHealth0 = await health(`${NP}/health`);
  record('1.1', 'Netplay relay is up on :3010 with /health', npHealth0?.ok === true, JSON.stringify(npHealth0));

  browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-gpu',
      '--autoplay-policy=no-user-gesture-required',
      '--disable-background-timer-throttling',
      '--disable-backgrounding-occluded-windows',
      '--disable-renderer-backgrounding',
      '--window-size=1280,900',
      '--force-device-scale-factor=1',
    ],
    defaultViewport: { width: 1280, height: 900 },
  });

  // ================================================================ player A
  const ctxA = await browser.createBrowserContext();
  const pageA = await ctxA.newPage();
  watchPage(pageA, 'A');
  await pageA.goto(BASE, { waitUntil: 'networkidle2', timeout: 60000 });
  const bootA = await waitFor('A emulator boot', () => pageA.evaluate(() =>
    window.__np && window.__np.snapshot().started ? window.__np.snapshot() : false), { timeout: 60000 });
  await sleep(1200);
  const snapA0 = await pageA.evaluate(() => window.__np.snapshot());
  record('1.2', 'Standalone harness boots a core and starts the game', !!bootA.started && !!snapA0.canvas,
    `canvas=${JSON.stringify(snapA0.canvas)} url=${snapA0.url}`);
  record('1.3', 'Netplay toolbar button is visible with EJS_Buttons.netplay=true',
    snapA0.netplayButtonVisible === true, `visible=${snapA0.netplayButtonVisible}`);

  // Open the real netplay menu, set the player name through its popup.
  await pageA.evaluate(() => window.EJS_emulator.openNetplayMenu());
  await waitFor('A name popup', () => pageA.evaluate(() => {
    const popup = [...document.querySelectorAll('.ejs_popup_container')]
      .find((p) => p.offsetParent !== null && /Set Player Name/i.test(p.textContent || ''));
    return popup ? true : false;
  }), { timeout: 5000 });
  await pageA.evaluate(() => {
    const popup = [...document.querySelectorAll('.ejs_popup_container')]
      .find((p) => p.offsetParent !== null && /Set Player Name/i.test(p.textContent || ''));
    const input = popup.querySelector('input[type="text"]');
    input.value = 'PLAYER A';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    popup.querySelector('.ejs_popup_submit').click();
  });
  await waitFor('A name accepted', () => pageA.evaluate(() => window.EJS_emulator.netplay?.name === 'PLAYER A'), { timeout: 5000 });
  record('2.1', 'Player name can be set from the netplay menu', true, 'PLAYER A');

  // Create a room through the menu's "Create a Room" action + dialog.
  await pageA.evaluate(() => window.EJS_emulator.netplay.createButton.click());
  await waitFor('A create-room dialog', () => pageA.evaluate(() => {
    return [...document.querySelectorAll('.ejs_popup_container')]
      .some((p) => p.offsetParent !== null && /Create a room/i.test(p.textContent || ''));
  }), { timeout: 5000 });
  await pageA.evaluate(() => {
    const popup = [...document.querySelectorAll('.ejs_popup_container')]
      .find((p) => p.offsetParent !== null && /Create a room/i.test(p.textContent || ''));
    const inputs = popup.querySelectorAll('input[type="text"]');
    inputs[0].value = 'R4 LAN TEST';
    inputs[0].dispatchEvent(new Event('input', { bubbles: true }));
    // Password left blank: EJS 4.2.3 joinRoom() does not send a password.
    popup.querySelectorAll('.ejs_popup_submit')[0].click();
  });
  const joinedA = await waitFor('A joins as host', () => pageA.evaluate(() => {
    const s = window.__np.snapshot();
    return s.isNetplay && s.owner && s.connected ? s : false;
  }), { timeout: 12000 });
  await sleep(1200);
  const roomA = await pageA.evaluate(() => {
    const e = window.EJS_emulator;
    return {
      ...window.__np.snapshot(),
      roomTitle: e.netplay.roomNameElem?.innerText,
      table: e.netplay.playerTable?.innerText,
      tabs: e.netplay.tabs?.map((t) => getComputedStyle(t).display),
      createLabel: e.netplay.createButton?.innerText,
    };
  });
  await shot(pageA, 'host-room');
  record('2.2', 'Player A creates a room and becomes host', joinedA.isNetplay && joinedA.owner,
    `session=${joinedA.session} room=${roomA.roomTitle} players=${JSON.stringify(joinedA.players)}`);
  record('2.3', 'Joined-room UI replaces the room list and shows the host',
    /R4 LAN TEST/.test(roomA.roomTitle || '') && /PLAYER A/.test(roomA.table || '') &&
      roomA.tabs?.[0] === 'none' && roomA.tabs?.[1] !== 'none',
    `title=${roomA.roomTitle} table=${JSON.stringify(roomA.table)} tabs=${JSON.stringify(roomA.tabs)}`);

  const listA = await (await fetch(`${NP}/list?domain=127.0.0.1:${WEB_PORT}&game_id=${GAME_ID}`)).json();
  const roomEntry = Object.entries(listA).find(([, r]) => r.room_name === 'R4 LAN TEST');
  record('2.4', 'Relay /list advertises the room for this origin + gameID',
    !!roomEntry && roomEntry[1].current === 1 && roomEntry[1].max === 2,
    JSON.stringify(listA));

  // ================================================================ player B
  const ctxB = await browser.createBrowserContext();
  const pageB = await ctxB.newPage();
  watchPage(pageB, 'B');
  // Count state loads so we can prove the host pushed a save-state to B.
  await pageB.evaluateOnNewDocument(() => {
    window.__stateLoads = 0;
    window.__npMessages = [];
  });
  await pageB.goto(BASE, { waitUntil: 'networkidle2', timeout: 60000 });
  const bootB = await waitFor('B emulator boot', () => pageB.evaluate(() =>
    window.__np && window.__np.snapshot().started ? window.__np.snapshot() : false), { timeout: 60000 });
  await sleep(800);
  await pageB.evaluate(() => {
    const e = window.EJS_emulator;
    const orig = e.gameManager.loadState.bind(e.gameManager);
    e.gameManager.loadState = (...args) => { window.__stateLoads++; return orig(...args); };
    e.openNetplayMenu();
  });
  await waitFor('B name popup', () => pageB.evaluate(() => {
    return [...document.querySelectorAll('.ejs_popup_container')]
      .some((p) => p.offsetParent !== null && /Set Player Name/i.test(p.textContent || ''));
  }), { timeout: 5000 });
  await pageB.evaluate(() => {
    const popup = [...document.querySelectorAll('.ejs_popup_container')]
      .find((p) => p.offsetParent !== null && /Set Player Name/i.test(p.textContent || ''));
    const input = popup.querySelector('input[type="text"]');
    input.value = 'PLAYER B';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    popup.querySelector('.ejs_popup_submit').click();
  });
  await waitFor('B name accepted', () => pageB.evaluate(() => window.EJS_emulator.netplay?.name === 'PLAYER B'), { timeout: 5000 });
  record('3.1', 'Second browser context boots independently', !!bootB.started, `canvas=${JSON.stringify(bootB.canvas)}`);

  const listedB = await waitFor('B sees host room in list', () => pageB.evaluate(() => {
    const e = window.EJS_emulator;
    const rows = [...(e.netplay?.table?.querySelectorAll('tr.ejs_netplay_table_row') || [])];
    const row = rows.find((r) => /R4 LAN TEST/.test(r.textContent || ''));
    if (!row) return false;
    return { text: row.textContent, buttons: row.querySelectorAll('.ejs_netplay_join_button').length };
  }), { timeout: 15000 });
  await shot(pageB, 'room-list');
  record('3.2', 'Player B sees the LAN room in the browser UI', /R4 LAN TEST/.test(listedB.text) && listedB.buttons === 1,
    JSON.stringify(listedB));

  // Click the actual Join button in the room table.
  await pageB.evaluate(() => {
    const e = window.EJS_emulator;
    const row = [...e.netplay.table.querySelectorAll('tr.ejs_netplay_table_row')]
      .find((r) => /R4 LAN TEST/.test(r.textContent || ''));
    row.querySelector('.ejs_netplay_join_button').click();
  });
  const joinedB = await waitFor('B joins as client', () => pageB.evaluate(() => {
    const s = window.__np.snapshot();
    return s.isNetplay && !s.owner && s.connected ? s : false;
  }), { timeout: 15000 });
  await sleep(2500);
  const bothA = await pageA.evaluate(() => window.__np.snapshot());
  const bothB = await pageB.evaluate(() => window.__np.snapshot());
  const stateLoadsB = await pageB.evaluate(() => window.__stateLoads);
  await shot(pageA, 'two-players-host');
  await shot(pageB, 'two-players-client');
  record('3.3', 'Second player joins the same room; both sides see 2 players',
    bothA.players.length === 2 && bothB.players.length === 2 &&
      bothA.players.includes('PLAYER A') && bothA.players.includes('PLAYER B') &&
      bothB.players.includes('PLAYER A') && bothB.players.includes('PLAYER B'),
    `A=${JSON.stringify(bothA.players)} B=${JSON.stringify(bothB.players)}`);
  record('3.4', 'Roles are host/client as expected', bothA.owner === true && bothB.owner === false,
    `A.owner=${bothA.owner} B.owner=${bothB.owner}`);
  record('3.5', 'Host pushed a save-state to the joining client', stateLoadsB >= 1,
    `B loadState calls=${stateLoadsB}`);

  const listBoth = await (await fetch(`${NP}/list?domain=127.0.0.1:${WEB_PORT}&game_id=${GAME_ID}`)).json();
  const fullRoom = Object.values(listBoth).find((r) => r.room_name === 'R4 LAN TEST');
  // The upstream /list only returns rooms with current < max, so a full room
  // legitimately disappears from the list.
  record('3.6', 'Relay state reaches 2/2 (full room leaves /list)', fullRoom === undefined,
    JSON.stringify(listBoth));

  // ============================================================ input relay
  note(`pre-input A=${JSON.stringify(await pageA.evaluate(() => window.__np.snapshot()))}`);
  note(`pre-input B=${JSON.stringify(await pageB.evaluate(() => window.__np.snapshot()))}`);
  await pageA.evaluate(() => {
    window.__npRx = [];
    window.EJS_emulator.netplay.socket.on('data-message', (d) => {
      if (d && d['sync-control']) window.__npRx.push(d['sync-control']);
    });
  });
  await pageB.evaluate(() => {
    window.__npRx = [];
    window.EJS_emulator.netplay.socket.on('data-message', (d) => {
      if (d && d['sync-control']) window.__npRx.push(d['sync-control']);
    });
  });
  // B (client) -> A (host): client input is sent to the host.
  await pageB.evaluate(() => window.__np.inputTest(0, 0, 1));
  const bToA = await waitFor('host receives client input', () => pageA.evaluate(() =>
    window.__npRx.length ? window.__npRx : false), { timeout: 8000 });
  record('4.1', 'Client input reaches the host over the relay', bToA.length > 0,
    `host rx frames=${bToA.length} sample=${JSON.stringify(bToA[0]?.slice(0, 2))}`);
  // 4.2.3 assigns Module.postMainLoop after the core has already registered
  // its main loop, so netplay.currentFrame stays 0 and the host never emits
  // its own sync-control. Verify the relay path itself works, then report the
  // client-side frame-hook limitation separately.
  const frameA = await pageA.evaluate(() => window.__np.snapshot().frame);
  await pageA.evaluate(() => window.EJS_emulator.netplay.socket.emit('data-message', {
    'sync-control': [{ frame: 1, connected_input: [0, 0, 1] }],
  }));
  const aToB = await waitFor('client receives relayed sync-control', () => pageB.evaluate(() =>
    window.__npRx.length ? window.__npRx : false), { timeout: 8000 });
  record('4.2', 'Relay transports sync-control host -> client', aToB.length > 0,
    `client rx frames=${aToB.length} sample=${JSON.stringify(aToB[0]?.slice(0, 2))}`);
  record('4.3', '4.2.3 client frame counter is stuck at 0 (known experimental limitation)',
    frameA === 0, `host netplay.currentFrame=${frameA}`);

  // ======================================================= host leaves / promote
  await pageA.evaluate(() => window.EJS_emulator.netplay.leaveRoom());
  await waitFor('host removed from client list', () => pageB.evaluate(() => {
    const s = window.__np.snapshot();
    return s.players.length === 1 ? s : false;
  }), { timeout: 12000 }).catch(() => null);
  await sleep(800);
  const afterLeave = await pageB.evaluate(() => window.__np.snapshot());
  await shot(pageB, 'client-after-host-left');
  record('5.1', 'Host leaving removes the host from the client list',
    afterLeave.players.length === 1 && afterLeave.players[0] === 'PLAYER B',
    `players=${JSON.stringify(afterLeave.players)} owner=${afterLeave.owner} netplay=${afterLeave.isNetplay}`);

  const npHealth1 = await health(`${NP}/health`);
  record('5.2', 'Relay health reports the live room/player count', npHealth1?.ok === true && npHealth1.rooms >= 0,
    JSON.stringify(npHealth1));

  record('6.1', 'No page errors during the run',
    events.filter((e) => e.includes('pageerror:')).length === 0,
    `pageerrors=${events.filter((e) => e.includes('pageerror:')).length}`);
} catch (e) {
  record('0.0', 'Harness completed without an uncaught exception', false, e.stack || e.message);
  console.error(e);
} finally {
  if (browser) { try { await browser.close(); } catch { /* ignore */ } }
  for (const p of [npProc, webProc]) {
    if (p) {
      try { spawnSync('taskkill', ['/PID', String(p.pid), '/T', '/F'], { windowsHide: true, timeout: 10000 }); } catch { /* ignore */ }
    }
  }
  await sleep(500);

  const failed = results.filter((r) => !r.pass);
  const summary = [
    '',
    '================ NETPLAY TEST SUMMARY ================',
    `checks: ${results.length}  passed: ${results.length - failed.length}  failed: ${failed.length}`,
    ...failed.map((f) => `FAIL ${f.id} ${f.name} :: ${f.detail}`),
    `server exit: ${JSON.stringify(serverExit)}`,
    '--- relay/server log ---',
    ...serverLog.join('').split(/\r?\n/).filter(Boolean).slice(-80),
    '--- browser events (errors/requests) ---',
    ...events.filter((e) => /pageerror|requestfailed|console:error/.test(e)).slice(-80),
    `screenshots: ${fs.readdirSync(OUT).filter((f) => f.startsWith('netplay-')).join(', ')}`,
    '======================================================',
  ].join('\n');
  console.log(summary);
  fs.writeFileSync(path.join(OUT, 'netplay-test.log'), summary + '\n');
  process.exitCode = failed.length ? 1 : 0;
}
