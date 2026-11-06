// Full PSX netplay smoke test: EmulatorJS 4.3-pre + pcsx_rearmed + the real
// Ridge Racer Type 4 disc, two independent browser contexts, LAN relay on
// :3010. Run: node test-netplay-psx.mjs  (takes ~2 minutes; each context
// downloads/decompresses the 345 MB 7z once).
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
const ICE = process.env.ICE || '1';
const BASE = `http://127.0.0.1:${WEB_PORT}/test-page-nightly.html?psx=1&ice=${ICE}`;
const NP = `http://127.0.0.1:${NP_PORT}`;
const GAME_ID = 4002;
const ROOM = 'R4 PSX NETPLAY';
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
  page.on('requestfailed', (r) => events.push(`[${label}] requestfailed: ${r.url()} ${r.failure()?.errorText || ''}`));
}
async function shot(page, name) {
  const file = path.join(OUT, `netplay-psx-${name}.png`);
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
  await page.evaluate(() => window.EJS_emulator.frontend.elements.bottomBar.netplay[0].click());
}
async function setName(page, name) {
  await waitFor('name popup', () => page.evaluate(() => [...document.querySelectorAll('.ejs_netplay_name_heading')]
    .some((x) => x.offsetParent !== null && /Set Player Name/i.test(x.textContent || ''))), { timeout: 8000 });
  await page.evaluate((n) => {
    const h = [...document.querySelectorAll('.ejs_netplay_name_heading')]
      .find((x) => x.offsetParent !== null && /Set Player Name/i.test(x.textContent || ''));
    const popup = h.closest('.ejs_cheat_parent') || h.closest('.ejs_popup_container');
    const input = popup.querySelector('input[type="text"]');
    input.value = n;
    input.dispatchEvent(new Event('input', { bubbles: true }));
    popup.querySelector('.ejs_popup_submit').click();
  }, name);
  await waitFor('name accepted', () => page.evaluate((n) => window.EJS_emulator.netplay?.name === n, name), { timeout: 6000 });
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
  note(`ICE mode: ${ICE === '0' ? 'empty array (LAN host candidates only)' : 'Google STUN'}`);

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

  // ------------------------------------------------------------------ host A
  const ctxA = await browser.createBrowserContext();
  const pageA = await ctxA.newPage();
  watchPage(pageA, 'A');
  const t0 = Date.now();
  await pageA.goto(BASE, { waitUntil: 'domcontentloaded', timeout: 60000 });
  const bootA = await waitFor('A PSX boot', () => pageA.evaluate(() =>
    window.__np && window.__np.snapshot().started ? window.__np.snapshot() : false), { timeout: 240000, interval: 1000 });
  const bootSecA = Math.round((Date.now() - t0) / 1000);
  await sleep(4000);
  const a0 = await pageA.evaluate(() => window.__np.snapshot());
  await shot(pageA, 'host-boot');
  record('1.1', 'Host boots Ridge Racer Type 4 in the PSX core', !!bootA.started && !!a0.canvas,
    `boot=${bootSecA}s canvas=${JSON.stringify(a0.canvas)}`);
  record('1.2', 'Netplay button is available on the PSX page', a0.netplayButtonVisible === true,
    `visible=${a0.netplayButtonVisible}`);

  await clickNetplay(pageA);
  await setName(pageA, 'PLAYER A');
  await pageA.evaluate(() => window.EJS_emulator.netplay.createButton.click());
  await waitFor('A create dialog', () => pageA.evaluate(() => [...document.querySelectorAll('.ejs_netplay_name_heading')]
    .some((x) => x.offsetParent !== null && /Create a room/i.test(x.textContent || ''))), { timeout: 8000 });
  await pageA.evaluate((room) => {
    const h = [...document.querySelectorAll('.ejs_netplay_name_heading')]
      .find((x) => x.offsetParent !== null && /Create a room/i.test(x.textContent || ''));
    const popup = h.closest('.ejs_cheat_parent') || h.closest('.ejs_popup_container');
    const inputs = popup.querySelectorAll('input[type="text"]');
    inputs[0].value = room;
    inputs[0].dispatchEvent(new Event('input', { bubbles: true }));
    popup.querySelectorAll('.ejs_popup_submit')[0].click();
  }, ROOM);
  const hostA = await waitFor('A host', () => pageA.evaluate(() => {
    const s = window.__np.snapshot();
    return s.isNetplay && s.owner && s.connected ? s : false;
  }), { timeout: 20000 });
  await sleep(1000);
  await shot(pageA, 'host-room');
  record('2.1', 'Host creates the PSX netplay room', hostA.owner === true, `room=${hostA.room} players=${JSON.stringify(hostA.players)}`);
  const listA = await (await fetch(`${NP}/list?domain=127.0.0.1:${WEB_PORT}&game_id=${GAME_ID}`)).json();
  record('2.2', 'Relay advertises the PSX room for gameID 4002', Object.values(listA).some((r) => r.room_name === ROOM),
    JSON.stringify(listA));

  // ----------------------------------------------------------------- guest B
  const ctxB = await browser.createBrowserContext();
  const pageB = await ctxB.newPage();
  watchPage(pageB, 'B');
  const t1 = Date.now();
  await pageB.goto(BASE, { waitUntil: 'domcontentloaded', timeout: 60000 });
  const bootB = await waitFor('B PSX boot', () => pageB.evaluate(() =>
    window.__np && window.__np.snapshot().started ? window.__np.snapshot() : false), { timeout: 240000, interval: 1000 });
  const bootSecB = Math.round((Date.now() - t1) / 1000);
  await sleep(3000);
  await clickNetplay(pageB);
  await setName(pageB, 'PLAYER B');
  const listedB = await waitFor('B sees PSX room', () => pageB.evaluate((room) => {
    const rows = [...(window.EJS_emulator.netplay.table?.querySelectorAll('tr') || [])];
    const row = rows.find((r) => (r.textContent || '').includes(room));
    return row ? { text: row.textContent, join: !!row.querySelector('.ejs_netplay_join_button') } : false;
  }, ROOM), { timeout: 20000 });
  await shot(pageB, 'room-list');
  record('3.1', 'Guest boots PSX and sees the host room', !!bootB.started && listedB.join,
    `boot=${bootSecB}s row=${JSON.stringify(listedB)}`);
  await pageB.evaluate((room) => {
    const row = [...window.EJS_emulator.netplay.table.querySelectorAll('tr')]
      .find((r) => (r.textContent || '').includes(room));
    row.querySelector('.ejs_netplay_join_button').click();
  }, ROOM);
  const guestB = await waitFor('B guest', () => pageB.evaluate(() => {
    const s = window.__np.snapshot();
    return s.isNetplay && !s.owner && s.connected ? s : false;
  }), { timeout: 20000 });
  await sleep(2000);
  const bothA = await pageA.evaluate(() => window.__np.snapshot());
  const bothB = await pageB.evaluate(() => window.__np.snapshot());
  record('3.2', 'Guest joins the R4 room; both sides see 2 players',
    bothA.players.length === 2 && bothB.players.length === 2,
    `A=${JSON.stringify(bothA.players)} B=${JSON.stringify(bothB.players)}`);
  record('3.3', 'Roles are host/guest', bothA.owner === true && bothB.owner === false,
    `A.owner=${bothA.owner} B.owner=${bothB.owner}`);

  // --------------------------------------------------------- WebRTC + video
  const rtc = await waitFor('PSX WebRTC connected', () => pageA.evaluate(() => {
    const s = window.__np.snapshot();
    return s.peers.some((p) => p.state === 'connected' || p.ice === 'connected' || p.ice === 'completed') ? s : false;
  }), { timeout: 40000 }).catch(() => null);
  const video = await waitFor('guest receives R4 video', () => pageB.evaluate(() => {
    const s = window.__np.snapshot();
    return s.video && s.video.w > 0 && s.video.readyState >= 2 ? s : false;
  }), { timeout: 30000 }).catch(() => null);
  await sleep(2500);
  const rtcA = await pageA.evaluate(() => window.__np.snapshot());
  const rtcB = await pageB.evaluate(() => window.__np.snapshot());
  await shot(pageA, 'host-webrtc');
  await shot(pageB, 'guest-webrtc');
  // Close the netplay overlay to show the actual streamed R4 picture.
  await pageA.evaluate(() => { if (window.EJS_emulator.netplay._menuElement) window.EJS_emulator.netplay._menuElement.style.display = 'none'; });
  await pageB.evaluate(() => { if (window.EJS_emulator.netplay._menuElement) window.EJS_emulator.netplay._menuElement.style.display = 'none'; });
  await sleep(800);
  await shot(pageA, 'host-game');
  await shot(pageB, 'guest-game');
  record('4.1', 'WebRTC peer connection reaches connected on the LAN', !!rtc,
    `A=${JSON.stringify(rtcA.peers)} B=${JSON.stringify(rtcB.peers)}`);
  const iceStats = await pageA.evaluate(async () => {
    try {
      const pc = Object.values(window.EJS_emulator.netplay.peerConnections)[0]?.pc;
      if (!pc) return null;
      const report = await pc.getStats();
      let pair = null; const cands = {};
      report.forEach((s) => {
        if (s.type === 'local-candidate' || s.type === 'remote-candidate') cands[s.id] = s;
        if (s.type === 'candidate-pair' && (s.state === 'succeeded' || s.selected)) pair = s;
      });
      const local = pair ? cands[pair.localCandidateId] : null;
      const remote = pair ? cands[pair.remoteCandidateId] : null;
      return {
        rttMs: pair && typeof pair.currentRoundTripTime === 'number' ? Math.round(pair.currentRoundTripTime * 1000) : null,
        localType: local?.candidateType || null,
        remoteType: remote?.candidateType || null,
        protocol: local?.protocol || null,
      };
    } catch { return null; }
  });
  note(`ICE stats: ${JSON.stringify(iceStats)}`);
  record('4.4', 'ICE selected a direct host candidate (no TURN relay)',
    !!iceStats && iceStats.localType === 'host' && iceStats.remoteType === 'host',
    JSON.stringify(iceStats));
  record('4.2', 'Guest receives the live R4 canvas stream', !!video,
    `B.video=${JSON.stringify(rtcB.video)}`);
  record('4.3', 'Guest stream is live (currentTime advances)', await (async () => {
    const t1v = await pageB.evaluate(() => window.EJS_emulator.netplay.video?.currentTime || 0);
    await sleep(1400);
    const t2v = await pageB.evaluate(() => window.EJS_emulator.netplay.video?.currentTime || 0);
    note(`guest video time ${t1v.toFixed(2)} -> ${t2v.toFixed(2)}`);
    return t2v > t1v;
  })(), 'see log');

  // --------------------------------------------------------- input transport
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
  const dcRx = await waitFor('host receives PSX guest input', () => pageA.evaluate(() =>
    window.__dcRx.length ? window.__dcRx : false), { timeout: 10000 }).catch(() => null);
  const hostInputs = await pageA.evaluate(() => window.__hostInputs);
  record('5.1', 'Guest input reaches the host over the WebRTC data channel',
    Array.isArray(dcRx) && dcRx.some((d) => typeof d.index === 'number'),
    `host rx=${JSON.stringify(dcRx)}`);
  record('5.2', 'Host PSX core receives guest input for player 2',
    hostInputs.some((v) => v[0] === 1 && v[1] === 0 && v[2] === 1),
    `host simulateInput calls=${JSON.stringify(hostInputs)}`);

  record('6.1', 'No page errors during the PSX run',
    events.filter((e) => e.includes('pageerror:')).length === 0,
    `pageerrors=${events.filter((e) => e.includes('pageerror:')).length}`);
} catch (e) {
  record('0.0', 'PSX harness completed without an uncaught exception', false, e.stack || e.message);
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
    '================ NETPLAY PSX (R4) TEST SUMMARY ================',
    `checks: ${results.length}  passed: ${results.length - failed.length}  failed: ${failed.length}`,
    ...failed.map((f) => `FAIL ${f.id} ${f.name} :: ${f.detail}`),
    `server exit: ${JSON.stringify(serverExit)}`,
    '--- relay/server log ---',
    ...serverLog.join('').split(/\r?\n/).filter(Boolean).slice(-80),
    '--- browser errors ---',
    ...events.filter((e) => /pageerror|requestfailed|console:error/.test(e)).slice(-80),
    `screenshots: ${fs.readdirSync(OUT).filter((f) => f.startsWith('netplay-psx-')).join(', ')}`,
    '==============================================================',
  ].join('\n');
  console.log(summary);
  fs.writeFileSync(path.join(OUT, 'netplay-psx-test.log'), summary + '\n');
  process.exitCode = failed.length ? 1 : 0;
}
