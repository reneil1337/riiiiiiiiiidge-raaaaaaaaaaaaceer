// End-to-end LAN netplay test for EmulatorJS 4.3.0-pre (nightly).
// 4.3 uses Socket.IO for signalling + WebRTC canvas/input streaming, unlike
// the stable 4.2.3 Socket.IO-only relay. Run: node test-netplay-43.mjs
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
const BASE = `http://127.0.0.1:${WEB_PORT}/test-page-nightly.html`;
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
function note(msg) { console.log(`      ${msg}`); events.push(`      ${msg}`); }
async function waitFor(label, fn, { timeout = 20000, interval = 150 } = {}) {
  const start = Date.now();
  let last = null;
  while (Date.now() - start < timeout) {
    try { last = await fn(); if (last) return last; } catch (e) { last = e.message; }
    await sleep(interval);
  }
  throw new Error(`timeout waiting for ${label}; last=${JSON.stringify(last)}`);
}
function watchPage(page, label) {
  page.on('console', (m) => events.push(`[${label}] console:${m.type()}: ${m.text()}`));
  page.on('pageerror', (e) => events.push(`[${label}] pageerror: ${e.message}`));
  page.on('requestfailed', (r) => events.push(`[${label}] requestfailed: ${r.url()} ${r.failure()?.errorText || ''}`));
}
async function shot(page, name) {
  const file = path.join(OUT, `netplay43-${name}.png`);
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
  try { const r = await fetch(url, { cache: 'no-store' }); return r.ok ? await r.json() : null; } catch { return null; }
}
function startProc(name, args, cwd, env) {
  const p = spawn(process.execPath, args, { cwd, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  p.stdout.on('data', (d) => serverLog.push(`[${name}] ${d.toString()}`));
  p.stderr.on('data', (d) => serverLog.push(`[${name}] ${d.toString()}`));
  p.on('exit', (code, signal) => { serverExit = { name, code, signal }; });
  return p;
}
async function clickNetplay(page) {
  await page.evaluate(() => {
    const e = window.EJS_emulator;
    e.frontend.elements.bottomBar.netplay[0].click();
  });
}
async function setName(page, name) {
  await waitFor('name popup', () => page.evaluate(() => {
    const h = [...document.querySelectorAll('.ejs_netplay_name_heading')]
      .find((x) => x.offsetParent !== null && /Set Player Name/i.test(x.textContent || ''));
    return !!h;
  }), { timeout: 6000 });
  await page.evaluate((n) => {
    const h = [...document.querySelectorAll('.ejs_netplay_name_heading')]
      .find((x) => x.offsetParent !== null && /Set Player Name/i.test(x.textContent || ''));
    const popup = h.closest('.ejs_cheat_parent') || h.closest('.ejs_popup_container');
    const input = popup.querySelector('input[type="text"]');
    input.value = n;
    input.dispatchEvent(new Event('input', { bubbles: true }));
    popup.querySelector('.ejs_popup_submit').click();
  }, name);
  await waitFor('name accepted', () => page.evaluate((n) => window.EJS_emulator.netplay?.name === n, name), { timeout: 5000 });
}

let npProc = null;
let webProc = null;
let browser = null;

try {
  if (!(await health(`${NP}/health`))) {
    await freePort(NP_PORT);
    npProc = startProc('netplay', ['server.js'], HERE, { PORT: String(NP_PORT), HOST: '0.0.0.0' });
    await waitFor('netplay health', () => health(`${NP}/health`), { timeout: 15000 });
  } else note('reusing already-running netplay relay on :3010');
  if (!(await health(`http://127.0.0.1:${WEB_PORT}/health`))) {
    await freePort(WEB_PORT);
    webProc = startProc('harness', ['serve-test.mjs'], HERE, { PORT: String(WEB_PORT) });
    await waitFor('harness health', () => health(`http://127.0.0.1:${WEB_PORT}/health`), { timeout: 15000 });
  } else note('reusing already-running harness on :3011');

  browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: true,
    args: [
      '--no-sandbox', '--disable-gpu', '--autoplay-policy=no-user-gesture-required',
      '--disable-background-timer-throttling', '--disable-backgrounding-occluded-windows',
      '--disable-renderer-backgrounding', '--window-size=1280,900', '--force-device-scale-factor=1',
    ],
    defaultViewport: { width: 1280, height: 900 },
  });

  // ---------------------------------------------------------------- host A
  const ctxA = await browser.createBrowserContext();
  const pageA = await ctxA.newPage();
  watchPage(pageA, 'A');
  await pageA.goto(BASE, { waitUntil: 'networkidle2', timeout: 60000 });
  const bootA = await waitFor('A boot', () => pageA.evaluate(() =>
    window.__np && window.__np.snapshot().started ? window.__np.snapshot() : false), { timeout: 60000 });
  await sleep(800);
  const a0 = await pageA.evaluate(() => window.__np.snapshot());
  record('1.1', '4.3-pre harness boots and starts the game', !!bootA.started && !!a0.canvas, JSON.stringify(a0.canvas));
  record('1.2', 'Netplay button is visible by default in 4.3-pre', a0.netplayButtonVisible === true, `visible=${a0.netplayButtonVisible}`);

  await clickNetplay(pageA);
  await setName(pageA, 'PLAYER A');
  await pageA.evaluate(() => window.EJS_emulator.netplay.createButton.click());
  await waitFor('A create dialog', () => pageA.evaluate(() => {
    const h = [...document.querySelectorAll('.ejs_netplay_name_heading')]
      .find((x) => x.offsetParent !== null && /Create a room/i.test(x.textContent || ''));
    return !!h;
  }), { timeout: 6000 });
  await pageA.evaluate(() => {
    const h = [...document.querySelectorAll('.ejs_netplay_name_heading')]
      .find((x) => x.offsetParent !== null && /Create a room/i.test(x.textContent || ''));
    const popup = h.closest('.ejs_cheat_parent') || h.closest('.ejs_popup_container');
    const inputs = popup.querySelectorAll('input[type="text"]');
    inputs[0].value = 'R4 LAN TEST 43';
    inputs[0].dispatchEvent(new Event('input', { bubbles: true }));
    popup.querySelectorAll('.ejs_popup_submit')[0].click();
  });
  const hostA = await waitFor('A host', () => pageA.evaluate(() => {
    const s = window.__np.snapshot();
    return s.isNetplay && s.owner && s.connected ? s : false;
  }), { timeout: 15000 });
  await sleep(1000);
  const roomA = await pageA.evaluate(() => ({
    ...window.__np.snapshot(),
    title: window.EJS_emulator.netplay.roomNameElem?.innerText,
    table: window.EJS_emulator.netplay.playerTable?.innerText,
  }));
  await shot(pageA, 'host-room');
  record('2.1', 'Host creates a 4.3 netplay room', hostA.owner === true && /R4 LAN TEST 43/.test(roomA.title || ''),
    `room=${roomA.title} players=${JSON.stringify(hostA.players)}`);
  const listA = await (await fetch(`${NP}/list?domain=127.0.0.1:${WEB_PORT}&game_id=${GAME_ID}`)).json();
  record('2.2', 'Relay advertises the room', Object.values(listA).some((r) => r.room_name === 'R4 LAN TEST 43'),
    JSON.stringify(listA));

  // --------------------------------------------------------------- guest B
  const ctxB = await browser.createBrowserContext();
  const pageB = await ctxB.newPage();
  watchPage(pageB, 'B');
  await pageB.goto(BASE, { waitUntil: 'networkidle2', timeout: 60000 });
  const bootB = await waitFor('B boot', () => pageB.evaluate(() =>
    window.__np && window.__np.snapshot().started ? window.__np.snapshot() : false), { timeout: 60000 });
  await sleep(800);
  await clickNetplay(pageB);
  await setName(pageB, 'PLAYER B');
  const listedB = await waitFor('B sees room', () => pageB.evaluate(() => {
    const rows = [...(window.EJS_emulator.netplay.table?.querySelectorAll('tr') || [])];
    const row = rows.find((r) => /R4 LAN TEST 43/.test(r.textContent || ''));
    return row ? { text: row.textContent, join: !!row.querySelector('.ejs_netplay_join_button') } : false;
  }), { timeout: 15000 });
  await shot(pageB, 'room-list');
  record('3.1', 'Guest sees the host room in the room list', /R4 LAN TEST 43/.test(listedB.text) && listedB.join,
    JSON.stringify(listedB));
  await pageB.evaluate(() => {
    const row = [...window.EJS_emulator.netplay.table.querySelectorAll('tr')]
      .find((r) => /R4 LAN TEST 43/.test(r.textContent || ''));
    row.querySelector('.ejs_netplay_join_button').click();
  });
  const guestB = await waitFor('B guest', () => pageB.evaluate(() => {
    const s = window.__np.snapshot();
    return s.isNetplay && !s.owner && s.connected ? s : false;
  }), { timeout: 15000 });
  await sleep(1500);
  const bothA = await pageA.evaluate(() => window.__np.snapshot());
  const bothB = await pageB.evaluate(() => window.__np.snapshot());
  record('3.2', 'Guest joins and both sides see two players',
    bothA.players.length === 2 && bothB.players.length === 2,
    `A=${JSON.stringify(bothA.players)} B=${JSON.stringify(bothB.players)}`);
  record('3.3', 'Roles are host/guest', bothA.owner === true && bothB.owner === false,
    `A.owner=${bothA.owner} B.owner=${bothB.owner}`);

  // ------------------------------------------------------- WebRTC transport
  const rtc = await waitFor('WebRTC peer connected', () => pageA.evaluate(() => {
    const s = window.__np.snapshot();
    const connected = s.peers.some((p) => p.state === 'connected' || p.ice === 'connected' || p.ice === 'completed');
    return connected ? s : false;
  }), { timeout: 30000 }).catch(() => null);
  await sleep(2500);
  const rtcA = await pageA.evaluate(() => window.__np.snapshot());
  const rtcB = await pageB.evaluate(() => window.__np.snapshot());
  await shot(pageA, 'host-webrtc');
  await shot(pageB, 'guest-webrtc');
  record('4.1', 'WebRTC peer connection reaches connected on the LAN',
    !!rtc && rtcA.peers.some((p) => p.state === 'connected' || p.ice === 'connected' || p.ice === 'completed'),
    `A=${JSON.stringify(rtcA.peers)} B=${JSON.stringify(rtcB.peers)}`);
  record('4.2', 'Guest receives host canvas video stream',
    !!rtcB.video && rtcB.video.w > 0 && rtcB.video.readyState >= 2,
    `B.video=${JSON.stringify(rtcB.video)}`);
  record('4.3', 'ICE server config is passed into 4.3 netplay', Array.isArray(rtcA.iceServers) && rtcA.iceServers.length > 0,
    JSON.stringify(rtcA.iceServers));

  // --------------------------------------------------------- input transport
  // Guest -> host over the WebRTC data channel. Instrument both the raw
  // channel and the host's actual emulator input entry point.
  await pageA.evaluate(() => {
    window.__dcRx = [];
    window.__hostInputs = [];
    const np = window.EJS_emulator.netplay;
    for (const k in np.peerConnections) {
      const dc = np.peerConnections[k].dataChannel;
      if (dc) dc.addEventListener('message', (e) => {
        try { window.__dcRx.push(JSON.parse(e.data)); } catch { /* ignore */ }
      });
    }
    const gm = window.EJS_emulator.gameManager;
    const orig = gm.functions.simulateInput;
    gm.functions.simulateInput = (player, index, value) => {
      window.__hostInputs.push([player, index, value]);
      return orig(player, index, value);
    };
  });
  await pageB.evaluate(() => window.EJS_emulator.netplay.simulateInput(0, 0, 1));
  const dcRx = await waitFor('host receives guest data-channel input', () => pageA.evaluate(() =>
    window.__dcRx.length ? window.__dcRx : false), { timeout: 8000 }).catch(() => null);
  const hostInputs = await pageA.evaluate(() => window.__hostInputs);
  record('5.1', 'Guest input reaches the host over the WebRTC data channel',
    Array.isArray(dcRx) && dcRx.some((d) => typeof d.index === 'number'),
    `host rx=${JSON.stringify(dcRx)}`);
  record('5.2', 'Host emulator receives the guest input for player 2',
    hostInputs.some((v) => v[0] === 1 && v[1] === 0 && v[2] === 1),
    `host simulateInput calls=${JSON.stringify(hostInputs)}`);

  // Guest -> host video is a live host canvas stream (4.3 design: host is
  // authoritative, guest renders the streamed canvas and sends only inputs).
  const t1 = await pageB.evaluate(() => window.EJS_emulator.netplay.video?.currentTime || 0);
  await sleep(1400);
  const t2 = await pageB.evaluate(() => window.EJS_emulator.netplay.video?.currentTime || 0);
  const liveB = await pageB.evaluate(() => window.__np.snapshot());
  record('5.3', 'Guest video stream is live (currentTime advances)',
    t2 > t1 && liveB.video?.readyState >= 2,
    `t=${t1.toFixed(2)} -> ${t2.toFixed(2)} video=${JSON.stringify(liveB.video)}`);

  // ------------------------------------------------------------ leave/promote
  await pageA.evaluate(() => window.EJS_emulator.netplay.leaveRoom());
  await waitFor('host removed from guest list', () => pageB.evaluate(() => {
    const s = window.__np.snapshot();
    return s.players.length === 1 ? s : false;
  }), { timeout: 12000 }).catch(() => null);
  await sleep(1200);
  const after = await pageB.evaluate(() => window.__np.snapshot());
  await shot(pageB, 'guest-after-host-left');
  // 4.3-pre keeps the guest in the room but does not promote it to owner;
  // the session effectively ends (the guest has no host video). This matches
  // the host-authoritative design: one host runs the game, guests send input.
  record('6.1', 'Host leaving removes the host; guest is not auto-promoted (4.3-pre limitation)',
    after.players.length === 1 && after.players[0] === 'PLAYER B' && after.owner === false,
    `players=${JSON.stringify(after.players)} owner=${after.owner} netplay=${after.isNetplay}`);

  record('7.1', 'No page errors during the run',
    events.filter((e) => e.includes('pageerror:')).length === 0,
    `pageerrors=${events.filter((e) => e.includes('pageerror:')).length}`);
} catch (e) {
  record('0.0', 'Harness completed without an uncaught exception', false, e.stack || e.message);
  console.error(e);
} finally {
  if (browser) { try { await browser.close(); } catch { /* ignore */ } }
  for (const p of [npProc, webProc]) if (p) {
    try { spawnSync('taskkill', ['/PID', String(p.pid), '/T', '/F'], { windowsHide: true, timeout: 10000 }); } catch { /* ignore */ }
  }
  await sleep(500);
  const failed = results.filter((r) => !r.pass);
  const summary = [
    '',
    '================ NETPLAY 4.3 TEST SUMMARY ================',
    `checks: ${results.length}  passed: ${results.length - failed.length}  failed: ${failed.length}`,
    ...failed.map((f) => `FAIL ${f.id} ${f.name} :: ${f.detail}`),
    `server exit: ${JSON.stringify(serverExit)}`,
    '--- relay/server log ---',
    ...serverLog.join('').split(/\r?\n/).filter(Boolean).slice(-80),
    '--- browser errors ---',
    ...events.filter((e) => /pageerror|requestfailed|console:error/.test(e)).slice(-80),
    `screenshots: ${fs.readdirSync(OUT).filter((f) => f.startsWith('netplay43-')).join(', ')}`,
    '==========================================================',
  ].join('\n');
  console.log(summary);
  fs.writeFileSync(path.join(OUT, 'netplay43-test.log'), summary + '\n');
  process.exitCode = failed.length ? 1 : 0;
}
