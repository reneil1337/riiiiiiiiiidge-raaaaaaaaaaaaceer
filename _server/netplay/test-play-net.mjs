// End-to-end test of the live /play netplay integration.
//
// Uses Brave (two independent browser contexts), the real LAN origin
// (http://<lan-ip>:8090), the real R4 CHD/BIOS, the relay on :3010, and the
// main app on :8090 so it never disturbs a server already running on :8080.
//
// Run: node test-play-net.mjs
import puppeteer from 'puppeteer-core';
import os from 'node:os';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SERVER_DIR = path.resolve(HERE, '..');
const OUT = '../../_runtime';
const BRAVE = 'C:/Program Files/BraveSoftware/Brave-Browser/Application/brave.exe';
const APP_PORT = Number(process.env.APP_PORT || 8090);
const NP_PORT = Number(process.env.NP_PORT || 3010);
const RELAY = `http://127.0.0.1:${NP_PORT}`;
const GAME_ID = 4;
const ROOM = 'R4 LAN INTEGRATION';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
fs.mkdirSync(OUT, { recursive: true });

function lanIp() {
  const candidates = [];
  for (const [name, list] of Object.entries(os.networkInterfaces())) {
    for (const info of list || []) {
      if (info.family !== 'IPv4' || info.internal) continue;
      if (info.address.startsWith('169.254.')) continue;
      let score = 2;
      if (/^(WLAN|Wi-?Fi|Ethernet)/i.test(name)) score = 0;
      else if (info.address.startsWith('192.168.') || /^10\./.test(info.address)) score = 0;
      if (/tailscale|vpn/i.test(name)) score = 3;
      candidates.push({ name, address: info.address, score });
    }
  }
  candidates.sort((a, b) => a.score - b.score || a.address.localeCompare(b.address));
  return candidates[0]?.address || '127.0.0.1';
}

const LAN_IP = process.env.LAN_IP || lanIp();
const ORIGIN = `http://${LAN_IP}:${APP_PORT}`;
const HOST_ORIGIN = `${LAN_IP}:${APP_PORT}`;
const NP_PATH = process.env.NP_PATH || '/play?netplay=1&cache=0';
const SINGLE_PATH = process.env.SINGLE_PATH || '/play?cache=0';
const HOST_URL = `${ORIGIN}${NP_PATH}`;
const GUEST_URL = `${ORIGIN}${NP_PATH}`;
const SINGLE_URL = `${ORIGIN}${SINGLE_PATH}`;

const results = [];
const events = [];
const serverLog = [];
let serverExit = null;

function record(id, name, pass, detail = '') {
  results.push({ id, name, pass: !!pass, detail: String(detail || '') });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${id}  ${name}${detail ? '  - ' + detail : ''}`);
}
function note(msg) { console.log(`      ${msg}`); events.push(`      ${msg}`); }
async function waitFor(label, fn, { timeout = 20000, interval = 250 } = {}) {
  const start = Date.now();
  let last = null;
  while (Date.now() - start < timeout) {
    try { last = await fn(); if (last) return last; } catch (e) { last = e.message; }
    await sleep(interval);
  }
  throw new Error(`timeout waiting for ${label}; last=${JSON.stringify(last)}`);
}
function watchPage(page, label) {
  page.on('console', (m) => {
    const t = m.text();
    if (!/invalid core option/.test(t)) events.push(`[${label}] console:${m.type()}: ${t}`);
  });
  page.on('pageerror', (e) => events.push(`[${label}] pageerror: ${e.message}`));
  page.on('requestfailed', (r) => {
    const err = r.failure()?.errorText || '';
    // Chrome cancels the reader after EmulatorJS has the CHD bytes.
    if (!/ERR_ABORTED/.test(err)) events.push(`[${label}] requestfailed: ${r.url()} ${err}`);
  });
}
async function shot(page, name) {
  const file = path.join(OUT, `netplay-integration-${name}.png`);
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

let npProc = null;
let appProc = null;
let browser = null;

try {
  // ---------------------------------------------------------------- relay
  if (!(await health(`${RELAY}/health`))) {
    await freePort(NP_PORT);
    npProc = startProc('netplay', ['server.js'], HERE, { PORT: String(NP_PORT), HOST: '0.0.0.0' });
    await waitFor('netplay health', () => health(`${RELAY}/health`), { timeout: 15000 });
  } else note(`reusing already-running netplay relay on :${NP_PORT}`);

  // ------------------------------------------------------------ main app
  if (!(await health(`http://127.0.0.1:${APP_PORT}/api/health`))) {
    await freePort(APP_PORT);
    appProc = startProc('app', ['src/server.js'], SERVER_DIR, {
      RR4_PORT: String(APP_PORT),
      RR4_NO_AUTOSTART: '1',
      RR4_STREAM_SOURCE: 'test',
    });
    await waitFor('app health', () => health(`http://127.0.0.1:${APP_PORT}/api/health`), { timeout: 20000 });
  } else note(`reusing already-running main app on :${APP_PORT}`);

  note(`LAN origin: ${ORIGIN}`);
  note(`relay: ${RELAY}`);
  note(`Brave: ${BRAVE}`);

  // Static proof: 4.3 and 4.2.3 coexist.
  const v43 = await (await fetch(`${ORIGIN}/emulator43/data/version.json`)).json();
  const v42 = await (await fetch(`${ORIGIN}/emulator/data/version.json`)).json();
  const js43 = await (await fetch(`${ORIGIN}/emulator43/data/emulator.min.js`)).text();
  const js42 = await (await fetch(`${ORIGIN}/emulator/data/emulator.min.js`)).text();
  const netHtml = await (await fetch(HOST_URL)).text();
  const singleHtml = await (await fetch(SINGLE_URL)).text();
  record('0.1', 'The netplay entry point serves the netplay document', /play-net\.js/.test(netHtml) && /netplayPanel/.test(netHtml),
    `url=${HOST_URL} netHtml=${netHtml.length}B`);
  record('0.2', '/play (no query) still serves the stable 4.2.3 document', /\/js\/play\.js/.test(singleHtml) && !/play-net\.js/.test(singleHtml),
    `singleHtml=${singleHtml.length}B`);
  record('0.3', '/emulator43/data serves 4.3.0-pre while /emulator/data still serves 4.2.3',
    /4\.3\.0-pre/.test(js43) && /ejs_version="4\.2\.3"/.test(js42),
    `emulator43.version.json=${JSON.stringify(v43)} emulator.version.json=${JSON.stringify(v42)}`);
  record('0.4', 'Both pinned data folders answer version.json', !!(v43 && v42),
    `emulator43=${JSON.stringify(v43)} emulator=${JSON.stringify(v42)}`);

  browser = await puppeteer.launch({
    executablePath: BRAVE,
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
  watchPage(pageA, 'HOST');
  const t0 = Date.now();
  await pageA.goto(HOST_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
  const bootA = await waitFor('host boot', () => pageA.evaluate(() =>
    window.__R4NET && window.__R4NET.snapshot().started ? window.__R4NET.snapshot() : false),
  { timeout: 240000, interval: 1000 });
  const bootSecA = Math.round((Date.now() - t0) / 1000);
  await sleep(2500);
  const a0 = await pageA.evaluate(() => window.__R4NET.snapshot());
  await shot(pageA, 'host-boot');
  record('1.1', 'Host boots R4 from /emulator43/data (4.3-pre)',
    !!a0.started && a0.version && a0.version.startsWith('4.3') && a0.pathtodata === '/emulator43/data/' && !!a0.canvas,
    `boot=${bootSecA}s version=${a0.version} path=${a0.pathtodata} canvas=${JSON.stringify(a0.canvas)}`);
  record('1.2', 'Host netplay config is gameID 4 + relay :3010 + empty ICE',
    a0.gameID === 4 && a0.netplayServer === `http://${LAN_IP}:3010`,
    `gameID=${a0.gameID} relay=${a0.netplayServer}`);
  record('1.3', 'EmulatorJS netplay button is visible on the netplay page', a0.netplayButtonVisible === true,
    `visible=${a0.netplayButtonVisible}`);

  const hostReady = await waitFor('host netplay ready', () => pageA.evaluate(() =>
    window.__R4NET.ready() ? window.__R4NET.snapshot() : false), { timeout: 30000 });
  record('1.4', 'Netplay client initialises', !!hostReady, `relay=${hostReady.netplayServer}`);

  await pageA.evaluate((name) => window.__R4NET.setName(name), 'PLAYER A');
  await pageA.evaluate((room) => window.__R4NET.hostRoom(room, 2, ''), ROOM);
  const hostJoined = await waitFor('host room', () => pageA.evaluate(() => {
    const s = window.__R4NET.snapshot();
    return s.isNetplay && s.owner && s.connected ? s : false;
  }), { timeout: 25000 });
  await sleep(1000);
  await shot(pageA, 'host-room');
  record('2.1', 'Host creates the R4 netplay room', hostJoined.owner === true,
    `room=${hostJoined.room} players=${JSON.stringify(hostJoined.players)}`);

  const listA = await (await fetch(`${RELAY}/list?domain=${encodeURIComponent(HOST_ORIGIN)}&game_id=${GAME_ID}`)).json();
  record('2.2', 'Relay advertises the room for this LAN origin and gameID 4',
    Object.values(listA).some((r) => r.room_name === ROOM), JSON.stringify(listA));

  // ---------------------------------------------------------------- guest B
  const ctxB = await browser.createBrowserContext();
  const pageB = await ctxB.newPage();
  watchPage(pageB, 'GUEST');
  const t1 = Date.now();
  await pageB.goto(GUEST_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
  const bootB = await waitFor('guest boot', () => pageB.evaluate(() =>
    window.__R4NET && window.__R4NET.snapshot().started ? window.__R4NET.snapshot() : false),
  { timeout: 240000, interval: 1000 });
  const bootSecB = Math.round((Date.now() - t1) / 1000);
  await sleep(2000);
  const b0 = await pageB.evaluate(() => window.__R4NET.snapshot());
  record('3.1', 'Guest boots the same R4 page on the same LAN origin',
    !!b0.started && b0.version && b0.version.startsWith('4.3') && b0.pathtodata === '/emulator43/data/',
    `boot=${bootSecB}s version=${b0.version} path=${b0.pathtodata}`);

  const roomsB = await waitFor('guest sees room', () => pageB.evaluate(async (room) => {
    const rooms = await window.__R4NET.getRooms();
    const hit = Object.entries(rooms).find(([, r]) => r.room_name === room);
    return hit ? { sessionId: hit[0], room: hit[1] } : false;
  }, ROOM), { timeout: 25000 });
  await shot(pageB, 'room-list');
  record('3.2', 'Guest sees the host room in the relay list', !!roomsB && roomsB.room.current >= 1,
    JSON.stringify(roomsB));

  await pageB.evaluate(({ sessionId, room }) => window.__R4NET.setName('PLAYER B') && window.__R4NET.joinRoom(sessionId, room.room_name, room.max, null),
    roomsB);
  const guestJoined = await waitFor('guest joined', () => pageB.evaluate(() => {
    const s = window.__R4NET.snapshot();
    return s.isNetplay && !s.owner && s.connected ? s : false;
  }), { timeout: 25000 });
  await sleep(1500);
  const bothA = await pageA.evaluate(() => window.__R4NET.snapshot());
  const bothB = await pageB.evaluate(() => window.__R4NET.snapshot());
  record('3.3', 'Guest joins; both sides see 2 players', bothA.playerCount === 2 && bothB.playerCount === 2,
    `host=${JSON.stringify(bothA.players)} guest=${JSON.stringify(bothB.players)}`);
  record('3.4', 'Roles are host (authoritative) and guest (stream)', bothA.owner === true && bothB.owner === false,
    `host.owner=${bothA.owner} guest.owner=${bothB.owner}`);

  // ---------------------------------------------------------- WebRTC/video
  const rtc = await waitFor('WebRTC connected', () => pageA.evaluate(() => {
    const s = window.__R4NET.snapshot();
    return s.peers.some((p) => p.state === 'connected' || p.ice === 'connected' || p.ice === 'completed') ? s : false;
  }), { timeout: 45000 });
  const video = await waitFor('guest video', () => pageB.evaluate(() => {
    const s = window.__R4NET.snapshot();
    return s.video && s.video.w > 0 && s.video.readyState >= 2 ? s : false;
  }), { timeout: 35000 });
  await sleep(2000);
  const rtcA = await pageA.evaluate(() => window.__R4NET.snapshot());
  const rtcB = await pageB.evaluate(() => window.__R4NET.snapshot());
  record('4.1', 'WebRTC peer connection reaches connected', !!rtc,
    `host=${JSON.stringify(rtcA.peers)} guest=${JSON.stringify(rtcB.peers)}`);
  record('4.2', 'Guest receives the live host R4 canvas stream', !!video,
    `guest.video=${JSON.stringify(rtcB.video)}`);
  const t1v = await pageB.evaluate(() => window.EJS_emulator.netplay.video?.currentTime || 0);
  await sleep(1400);
  const t2v = await pageB.evaluate(() => window.EJS_emulator.netplay.video?.currentTime || 0);
  record('4.3', 'Guest stream is live (currentTime advances)', t2v > t1v,
    `video time ${t1v.toFixed(2)} -> ${t2v.toFixed(2)}`);

  // Hide the panels and dismiss the click-to-race gate so the screenshots
  // show the actual host game and the guest's streamed picture. Bring each
  // tab forward in turn: headless Chrome can throttle a backgrounded canvas.
  const dismissGate = (page) => page.evaluate(() => {
    const gate = document.querySelector('#soundGate');
    if (gate && !gate.hidden) gate.click();
    try { window.EJS_emulator?.play?.(); } catch { /* ignore */ }
  });
  await pageA.evaluate(() => window.__R4NET.closePanel());
  await pageB.evaluate(() => window.__R4NET.closePanel());
  await dismissGate(pageA);
  await dismissGate(pageB);
  await pageA.bringToFront();
  await sleep(2500);
  // Tap START on the host to move past R4's black boot/attract frames.
  await pageA.evaluate(() => {
    const gm = window.EJS_emulator?.gameManager;
    if (!gm || !gm.functions?.simulateInput) return;
    try { gm.functions.simulateInput(0, 3, 1); } catch { /* ignore */ }
    setTimeout(() => { try { gm.functions.simulateInput(0, 3, 0); } catch { /* ignore */ } }, 180);
  });
  await sleep(3500);
  await shot(pageA, 'host-game');
  await pageB.bringToFront();
  await sleep(3000);
  await shot(pageB, 'guest-game');

  // ---------------------------------------------------------- guest input
  await pageA.evaluate(() => {
    window.__hostInputs = [];
    const gm = window.EJS_emulator.gameManager;
    const orig = gm.functions.simulateInput;
    gm.functions.simulateInput = (player, index, value) => {
      window.__hostInputs.push([player, index, value]);
      return orig(player, index, value);
    };
  });
  await pageB.evaluate(() => window.__R4NET.simulateInput(0, 0, 1));
  const hostInputs = await waitFor('host receives guest input', () => pageA.evaluate(() =>
    window.__hostInputs && window.__hostInputs.some((v) => v[0] === 1 && v[1] === 0 && v[2] === 1)
      ? window.__hostInputs : false), { timeout: 12000 }).catch(() => null);
  record('5.1', 'Guest input reaches the host PSX core as player 2', !!hostInputs,
    `host simulateInput calls=${JSON.stringify(hostInputs)}`);

  // ------------------------------------------------------- single player
  const ctxC = await browser.createBrowserContext();
  const pageC = await ctxC.newPage();
  watchPage(pageC, 'SINGLE');
  const t2 = Date.now();
  await pageC.goto(SINGLE_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
  const single = await waitFor('single-player boot', () => pageC.evaluate(() => {
    if (!window.__R4 || !window.__R4.startedAt) return false;
    return {
      started: true,
      path: window.EJS_pathtodata,
      version: window.EJS_emulator && (window.EJS_emulator.ejs_version || window.EJS_emulator.version),
      gameID: window.EJS_gameID,
      netplayServer: window.EJS_netplayServer || null,
      hasPanel: !!document.querySelector('#netplayPanel'),
      canvas: (() => { const c = document.querySelector('#game canvas'); return c ? { w: c.width, h: c.height } : null; })(),
    };
  }), { timeout: 240000, interval: 1000 });
  const bootSecC = Math.round((Date.now() - t2) / 1000);
  await sleep(1500);
  await shot(pageC, 'single');
  record('6.1', 'Stable single-player /play still boots EmulatorJS 4.2.3',
    single.started && single.path === '/emulator/data/' && String(single.version).startsWith('4.2') && !!single.canvas,
    `boot=${bootSecC}s path=${single.path} version=${single.version} canvas=${JSON.stringify(single.canvas)}`);
  record('6.2', 'Single-player /play has no netplay page chrome or relay config',
    single.hasPanel === false && !single.netplayServer,
    `panel=${single.hasPanel} netplayServer=${single.netplayServer}`);

  // --------------------------------------------------------------- errors
  const pageErrors = events.filter((e) => e.includes('pageerror:'));
  const consoleErrors = events.filter((e) => /console:error:/.test(e));
  record('7.1', 'No page errors during host/guest/single-player runs', pageErrors.length === 0,
    `pageerrors=${pageErrors.length}${pageErrors.length ? ' ' + pageErrors.join(' | ') : ''}`);
  note(`console errors: ${consoleErrors.length}`);
  for (const e of consoleErrors.slice(0, 10)) note(e);

  // Final panel snapshot for the log.
  const finalA = await pageA.evaluate(() => window.__R4NET.snapshot());
  const finalB = await pageB.evaluate(() => window.__R4NET.snapshot());
  note(`host final: ${JSON.stringify({ room: finalA.room, role: finalA.owner ? 'host' : 'guest', players: finalA.players, peers: finalA.peers })}`);
  note(`guest final: ${JSON.stringify({ room: finalB.room, role: finalB.owner ? 'host' : 'guest', players: finalB.players, peers: finalB.peers, video: finalB.video })}`);
} catch (e) {
  record('0.0', 'Integration harness completed without an uncaught exception', false, e.stack || e.message);
  console.error(e);
} finally {
  if (browser) { try { await browser.close(); } catch { /* ignore */ } }
  for (const p of [npProc, appProc]) if (p) {
    try { spawnSync('taskkill', ['/PID', String(p.pid), '/T', '/F'], { windowsHide: true, timeout: 10000 }); } catch { /* ignore */ }
  }
  await sleep(500);
  const failed = results.filter((r) => !r.pass);
  const summary = [
    '',
    '================ /play NETPLAY INTEGRATION TEST ================',
    `origin: ${ORIGIN}`,
    `checks: ${results.length}  passed: ${results.length - failed.length}  failed: ${failed.length}`,
    ...failed.map((f) => `FAIL ${f.id} ${f.name} :: ${f.detail}`),
    `server exit: ${JSON.stringify(serverExit)}`,
    '--- relay/server log ---',
    ...serverLog.join('').split(/\r?\n/).filter(Boolean).slice(-80),
    '--- browser events ---',
    ...events.slice(-120),
    `screenshots: ${fs.readdirSync(OUT).filter((f) => f.startsWith('netplay-integration-')).join(', ')}`,
    '===============================================================',
  ].join('\n');
  console.log(summary);
  fs.writeFileSync(path.join(OUT, 'netplay-integration.log'), summary + '\n');
  fs.writeFileSync(path.join(OUT, 'netplay-integration-results.json'), JSON.stringify({
    origin: ORIGIN,
    checks: results,
    events,
    serverLog: serverLog.slice(-120),
    at: new Date().toISOString(),
  }, null, 2));
  process.exitCode = failed.length ? 1 : 0;
}
