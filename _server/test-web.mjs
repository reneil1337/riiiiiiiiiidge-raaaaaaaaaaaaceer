// QA end-to-end test for the R4 LAN arcade website.
// Starts an isolated test server on :8093 (test stream, no cabinet), drives
// Brave via puppeteer-core, writes screenshots to ../_runtime/qa-*.png.
//
// Run: node test-web.mjs
// No native game process is launched; RR4_NO_AUTOSTART=1 is enforced.
import puppeteer from 'puppeteer-core';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = '.';
const OUT = '../_runtime';
const PORT = 8093;
const BASE = `http://127.0.0.1:${PORT}/`;
const BRAVE = 'C:/Program Files/BraveSoftware/Brave-Browser/Application/brave.exe';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

fs.mkdirSync(OUT, { recursive: true });

const results = [];
function record(id, name, pass, detail = '') {
  results.push({ id, name, pass: !!pass, detail: String(detail || '') });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${id}  ${name}${detail ? '  — ' + detail : ''}`);
}

async function waitFor(label, fn, { timeout = 12000, interval = 100 } = {}) {
  const start = Date.now();
  let last = null;
  while (Date.now() - start < timeout) {
    try {
      last = await fn();
      if (last) return last;
    } catch (e) {
      last = e.message;
    }
    await sleep(interval);
  }
  throw new Error(`timeout waiting for ${label}; last=${JSON.stringify(last)}`);
}

const consoleEvents = [];
function watchPage(page, label) {
  page.on('console', (m) => {
    const entry = { label, kind: `console:${m.type()}`, text: m.text() };
    consoleEvents.push(entry);
  });
  page.on('pageerror', (e) => consoleEvents.push({ label, kind: 'pageerror', text: e.message }));
  page.on('requestfailed', (r) => consoleEvents.push({
    label, kind: 'requestfailed', text: `${r.url()} ${r.failure()?.errorText || ''}`,
  }));
}

async function shot(page, name) {
  const file = path.join(OUT, `qa-${name}.png`);
  await page.screenshot({ path: file });
  return file;
}

async function joinAs(page, name) {
  await page.waitForSelector('#nameInput', { visible: true });
  await page.$eval('#nameInput', (el, value) => { el.value = value; }, name);
  await page.click('#joinBtn');
  await page.waitForFunction(() => {
    const arcade = document.querySelector('#arcade');
    return arcade && !arcade.hidden;
  }, { timeout: 8000 });
  await page.waitForFunction(() => {
    const s = window.__RR4 && window.__RR4.state;
    return s && s.ws && s.ws.readyState === 1 && s.room;
  }, { timeout: 12000 });
}

async function takeSeat(page, seat) {
  const sel = `#seatCards .seat-card.p${seat} button`;
  await page.waitForFunction((s) => {
    const b = document.querySelector(s);
    return !!b && !b.disabled && /TAKE P/i.test(b.textContent);
  }, { timeout: 8000 }, sel);
  await page.click(sel);
  await page.waitForFunction((n) => {
    const hud = document.querySelector('#hudSeat');
    return hud && hud.textContent.trim().startsWith(`P${n}`);
  }, { timeout: 8000 }, seat);
}

async function mockPad(page, id, buttonCount = 17) {
  await page.evaluate((padId, n) => {
    const pad = {
      id: padId,
      index: 0,
      connected: true,
      mapping: 'standard',
      buttons: Array.from({ length: n }, () => ({ pressed: false, value: 0 })),
      axes: [0, 0, 0, 0],
      vibrationActuator: { playEffect: () => Promise.resolve('complete') },
    };
    navigator.getGamepads = () => [pad];
    window.__qaPad = pad;
    window.dispatchEvent(new Event('gamepadconnected'));
  }, id, buttonCount);
}

async function padSnapshot(page) {
  return page.evaluate(() => ({
    pill: document.querySelector('#padPill')?.textContent,
    name: document.querySelector('#padStatusName')?.textContent,
    detail: document.querySelector('#padStatusDetail')?.textContent,
    badge: document.querySelector('#padStatusBadge')?.textContent,
    face: [...document.querySelectorAll('#padFace [data-face]')].map((e) => e.textContent),
    mask: window.__RR4?.state?.mask,
  }));
}

async function pressPadButton(page, index, pressed) {
  await page.evaluate((i, value) => {
    const pad = window.__qaPad;
    if (!pad || !pad.buttons[i]) return;
    pad.buttons[i].pressed = value;
    pad.buttons[i].value = value ? 1 : 0;
  }, index, pressed);
}

async function auditButtons(page) {
  return page.evaluate(async () => {
    const pause = (ms) => new Promise((r) => setTimeout(r, ms));
    const all = [...document.querySelectorAll('button')];
    const visible = all.filter((el) => {
      if (el.hidden || el.disabled) return false;
      const cs = getComputedStyle(el);
      if (cs.display === 'none' || cs.visibility === 'hidden' || Number(cs.opacity) === 0) return false;
      const r = el.getBoundingClientRect();
      return r.width > 2 && r.height > 2;
    });
    const bad = [];
    for (const el of visible) {
      el.scrollIntoView({ block: 'center', inline: 'center' });
      await pause(35);
      const r = el.getBoundingClientRect();
      const cx = Math.min(innerWidth - 1, Math.max(0, r.left + r.width / 2));
      const cy = Math.min(innerHeight - 1, Math.max(0, r.top + r.height / 2));
      const inView = r.left >= -1 && r.top >= -1 && r.right <= innerWidth + 1 && r.bottom <= innerHeight + 1;
      const top = document.elementFromPoint(cx, cy);
      const reachable = !!top && (top === el || el.contains(top) || top.closest('button') === el);
      if (!inView || !reachable) {
        bad.push({
          text: (el.textContent || el.getAttribute('aria-label') || el.id || '').trim().slice(0, 40),
          id: el.id,
          cls: String(el.className),
          inView,
          reachable,
          coveredBy: top ? (top.id || String(top.className) || top.tagName) : null,
          rect: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) },
        });
      }
    }
    return { total: visible.length, bad };
  });
}

async function auditCoverage(page, selector) {
  return page.evaluate(async (sel) => {
    const els = [...document.querySelectorAll(sel)].filter((el) => {
      if (el.hidden || el.disabled) return false;
      const cs = getComputedStyle(el);
      if (cs.display === 'none' || cs.visibility === 'hidden') return false;
      const r = el.getBoundingClientRect();
      return r.width > 2 && r.height > 2;
    });
    const out = [];
    for (const el of els) {
      const r = el.getBoundingClientRect();
      let covered = 0;
      let total = 0;
      for (let i = 1; i <= 6; i++) {
        for (let j = 1; j <= 6; j++) {
          const x = r.left + (r.width * i) / 7;
          const y = r.top + (r.height * j) / 7;
          if (x < 0 || x >= innerWidth || y < 0 || y >= innerHeight) continue;
          total++;
          const top = document.elementFromPoint(x, y);
          if (top && top !== el && !el.contains(top)) covered++;
        }
      }
      const cx = Math.min(innerWidth - 1, Math.max(0, r.left + r.width / 2));
      const cy = Math.min(innerHeight - 1, Math.max(0, r.top + r.height / 2));
      const centerTop = document.elementFromPoint(cx, cy);
      out.push({
        text: (el.textContent || el.id || '').trim().slice(0, 30),
        id: el.id,
        coveredPct: total ? Math.round((covered / total) * 100) : 0,
        centerCovered: !!(centerTop && centerTop !== el && !el.contains(centerTop)),
        centerCoveredBy: centerTop ? (centerTop.id || String(centerTop.className) || centerTop.tagName) : null,
      });
    }
    return out;
  }, selector);
}

async function auditFixedOverlaps(page) {
  return page.evaluate(() => {
    const sels = ['#topbar', '#btnExitFs', '.stage-bar', '#touchControls', '.toasts'];
    const els = [];
    for (const sel of sels) {
      for (const el of document.querySelectorAll(sel)) {
        const cs = getComputedStyle(el);
        if (cs.position !== 'fixed' || cs.display === 'none' || cs.visibility === 'hidden') continue;
        const r = el.getBoundingClientRect();
        if (r.width < 2 || r.height < 2) continue;
        els.push({ sel, id: el.id, r: { l: r.left, t: r.top, r: r.right, b: r.bottom } });
      }
    }
    const overlaps = [];
    for (let i = 0; i < els.length; i++) {
      for (let j = i + 1; j < els.length; j++) {
        const a = els[i];
        const b = els[j];
        const w = Math.min(a.r.r, b.r.r) - Math.max(a.r.l, b.r.l);
        const h = Math.min(a.r.b, b.r.b) - Math.max(a.r.t, b.r.t);
        if (w > 4 && h > 4) {
          overlaps.push({ a: a.id || a.sel, b: b.id || b.sel, area: Math.round(w * h) });
        }
      }
    }
    return { fixed: els.map((e) => e.id || e.sel), overlaps };
  });
}

async function status() {
  const r = await fetch(`${BASE}api/status`, { cache: 'no-store' });
  return r.json();
}

// ---------------------------------------------------------------- server
// Make sure no orphaned test server from an earlier run owns :8093.
try {
  const out = spawnSync('powershell', ['-NoProfile', '-Command',
    `(Get-NetTCPConnection -LocalPort ${PORT} -State Listen -ErrorAction SilentlyContinue).OwningProcess`],
  { encoding: 'utf8', windowsHide: true, timeout: 10000 });
  const pid = String(out.stdout || '').trim().split(/\s+/).find((x) => /^\d+$/.test(x) && x !== '0');
  if (pid) {
    console.log(`freeing :${PORT} from stale pid ${pid}`);
    spawnSync('taskkill', ['/PID', pid, '/T', '/F'], { windowsHide: true, timeout: 10000 });
    await sleep(800);
  }
} catch { /* ignore */ }

let serverLog = '';
let serverExit = null;
const server = spawn(process.execPath, ['src/server.js'], {
  cwd: ROOT,
  env: {
    ...process.env,
    RR4_PORT: String(PORT),
    RR4_NO_AUTOSTART: '1',
    RR4_STREAM_SOURCE: 'test',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
  windowsHide: true,
});
server.stdout.on('data', (d) => { serverLog += d.toString(); });
server.stderr.on('data', (d) => { serverLog += d.toString(); });
server.on('exit', (code, signal) => { serverExit = { code, signal }; });

let browser = null;
try {
  await waitFor('test server health', async () => {
    try {
      const r = await fetch(`${BASE}api/health`, { cache: 'no-store' });
      return r.ok;
    } catch {
      return false;
    }
  }, { timeout: 20000, interval: 250 });

  await waitFor('test stream producing data', async () => {
    const j = await status();
    return j.cabinet?.stream?.running && j.cabinet.stream.bytesPerSec > 0;
  }, { timeout: 20000, interval: 250 });

  browser = await puppeteer.launch({
    executablePath: BRAVE,
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-gpu',
      '--autoplay-policy=no-user-gesture-required',
      '--window-size=1440,1000',
      '--force-device-scale-factor=1',
    ],
    defaultViewport: { width: 1440, height: 1000 },
  });

  // ============================================================ 1. landing
  const page = await browser.newPage();
  watchPage(page, 'desktop');
  const landingErrorsBefore = consoleEvents.length;
  await page.goto(BASE, { waitUntil: 'networkidle2', timeout: 30000 });
  await sleep(2500);
  const landing = await page.evaluate(() => {
    const box = (sel) => {
      const el = document.querySelector(sel);
      if (!el) return null;
      const r = el.getBoundingClientRect();
      const cs = getComputedStyle(el);
      return {
        visible: !el.hidden && cs.display !== 'none' && cs.visibility !== 'hidden' && r.width > 2 && r.height > 2,
        rect: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) },
      };
    };
    return {
      landingHidden: document.querySelector('#landing')?.hidden,
      joinBtn: box('#joinBtn'),
      fullscreenTop: box('#btnFullscreen'),
      fullscreenLanding: box('#fsLanding'),
      title: document.title,
    };
  });
  await shot(page, 'landing');
  const landingErrors = consoleEvents.slice(landingErrorsBefore).filter((e) => e.kind === 'pageerror' || e.kind === 'console:error');
  record('1.1', 'Landing loads with join + fullscreen controls',
    !landing.landingHidden && landing.joinBtn?.visible && landing.fullscreenTop?.visible && landing.fullscreenLanding?.visible,
    JSON.stringify(landing));
  record('1.2', 'No console/page errors on landing', landingErrors.length === 0,
    landingErrors.length ? JSON.stringify(landingErrors) : '0 errors');

  // Fullscreen button on the landing page must be clickable, not just visible.
  await page.click('#btnFullscreen');
  await sleep(1200);
  const landingFs = await page.evaluate(() => ({
    fs: document.body.classList.contains('fs'),
    fsEl: !!document.fullscreenElement,
    exitVisible: (() => { const e = document.querySelector('#btnExitFs'); return !!e && !e.hidden && e.getBoundingClientRect().width > 2; })(),
  }));
  record('1.3', 'Landing FULLSCREEN button is clickable', landingFs.fs, JSON.stringify(landingFs));
  await page.click('#btnExitFs').catch(() => {});
  await sleep(900);

  // ============================================================ 2. join + P1 + pads
  await joinAs(page, 'QA P1');
  await sleep(1200);
  await takeSeat(page, 1);
  await sleep(700);
  const p1Seat = await page.evaluate(() => ({
    hud: document.querySelector('#hudSeat')?.textContent,
    seatText: document.querySelector('#seatCards')?.innerText,
    input: document.querySelector('#infoInput')?.textContent,
  }));
  record('2.1', 'Join with a name enters the arcade', !(await page.$eval('#arcade', (e) => e.hidden)), 'arcade visible');
  record('2.2', 'Take P1 shows the correct seat + HUD', /P1/.test(p1Seat.hud || '') && /QA P1/.test(p1Seat.seatText || '') && p1Seat.input === 'ARMED',
    JSON.stringify(p1Seat));

  await page.click('#btnReady');
  await waitFor('P1 ready state', () => page.evaluate(() => {
    const b = document.querySelector('#btnReady');
    return b && /UNREADY/.test(b.textContent);
  }), { timeout: 5000 });
  const readyText = await page.$eval('#btnReady', (e) => e.textContent);
  record('2.3', 'READY toggles to UNREADY for the seated driver', /UNREADY/.test(readyText), readyText);

  await page.click('#btnController');
  await waitFor('controller modal', () => page.evaluate(() => !document.querySelector('#modalController').hidden), { timeout: 4000 });

  await mockPad(page, 'Xbox Wireless Controller (STANDARD GAMEPAD Vendor: 045e Product: 0b13)');
  await sleep(900);
  const xbox = await padSnapshot(page);
  await shot(page, 'controller-xbox');
  await pressPadButton(page, 0, true);
  await sleep(350);
  const xboxCross = await page.evaluate(() => window.__RR4?.state?.mask);
  await pressPadButton(page, 0, false);
  await sleep(350);
  const xboxNeutral = await page.evaluate(() => window.__RR4?.state?.mask);

  record('2.4', 'Xbox pad detected with A/B/X/Y labels',
    xbox.pill === 'XBOX' && xbox.badge === 'ONLINE' && /Xbox/i.test(xbox.name || '') &&
      JSON.stringify(xbox.face) === JSON.stringify(['Y', 'B', 'A', 'X']),
    JSON.stringify(xbox));
  record('2.5', 'Xbox Cross -> mask 0xBFFF, neutral -> 0xFFFF',
    xboxCross === 0xBFFF && xboxNeutral === 0xFFFF,
    `cross=0x${Number(xboxCross).toString(16).toUpperCase()} neutral=0x${Number(xboxNeutral).toString(16).toUpperCase()}`);

  await mockPad(page, 'DualSense Wireless Controller (STANDARD GAMEPAD Vendor: 054c Product: 0ce6)');
  await sleep(900);
  const ps = await padSnapshot(page);
  await shot(page, 'controller-dualsense');
  await pressPadButton(page, 0, true);
  await sleep(350);
  const psCross = await page.evaluate(() => window.__RR4?.state?.mask);
  await pressPadButton(page, 0, false);
  await sleep(350);
  const psNeutral = await page.evaluate(() => window.__RR4?.state?.mask);

  record('2.6', 'DualSense pad detected with Cross/Circle/Square/Triangle labels',
    ps.pill === 'PLAYSTATION' && ps.badge === 'ONLINE' && /DualSense/i.test(ps.name || '') &&
      JSON.stringify(ps.face) === JSON.stringify(['△', '○', '✕', '□']),
    JSON.stringify(ps));
  record('2.7', 'DualSense Cross -> mask 0xBFFF, neutral -> 0xFFFF',
    psCross === 0xBFFF && psNeutral === 0xFFFF,
    `cross=0x${Number(psCross).toString(16).toUpperCase()} neutral=0x${Number(psNeutral).toString(16).toUpperCase()}`);

  await page.click('[data-close="modalController"]');
  await sleep(400);

  // ============================================================ 3. P2 + chat
  const ctx2 = await browser.createBrowserContext();
  const page2 = await ctx2.newPage();
  watchPage(page2, 'desktop-p2');
  await page2.setViewport({ width: 1280, height: 900 });
  await page2.goto(BASE, { waitUntil: 'networkidle2', timeout: 30000 });
  await sleep(1500);
  await joinAs(page2, 'QA P2');
  await sleep(900);
  await takeSeat(page2, 2);
  await sleep(1000);

  const bothSeats = await waitFor('both seats populated', async () => {
    const a = await page.evaluate(() => window.__RR4?.state?.room?.seats);
    const b = await page2.evaluate(() => window.__RR4?.state?.room?.seats);
    const ok = a?.[1]?.name === 'QA P1' && a?.[2]?.name === 'QA P2' &&
      b?.[1]?.name === 'QA P1' && b?.[2]?.name === 'QA P2';
    return ok ? { a, b } : false;
  }, { timeout: 8000 });
  const p1SeatText = await page.$eval('#seatCards', (e) => e.innerText);
  const p2SeatText = await page2.$eval('#seatCards', (e) => e.innerText);
  record('3.1', 'Second context takes P2; both seats show correct names',
    /QA P1/.test(p1SeatText) && /QA P2/.test(p1SeatText) && /QA P1/.test(p2SeatText) && /QA P2/.test(p2SeatText),
    `P1 view: ${JSON.stringify(p1SeatText)} | P2 view: ${JSON.stringify(p2SeatText)}`);
  await shot(page, 'two-players');

  await page2.click('#chatInput');
  await page2.type('#chatInput', 'hello from QA P2');
  await page2.click('#chatForm button');
  const chatFromP2 = await waitFor('P1 receives P2 chat', () => page.evaluate(() =>
    /hello from QA P2/.test(document.querySelector('#chatLog')?.innerText || '')), { timeout: 6000 }).catch(() => false);
  await page.click('#chatInput');
  await page.type('#chatInput', 'roger from QA P1');
  await page.click('#chatForm button');
  const chatFromP1 = await waitFor('P2 receives P1 chat', () => page2.evaluate(() =>
    /roger from QA P1/.test(document.querySelector('#chatLog')?.innerText || '')), { timeout: 6000 }).catch(() => false);
  const chatCount = await page.evaluate(() => document.querySelector('#chatLog')?.children.length);
  record('3.2', 'Chat messages round-trip between both contexts', !!chatFromP2 && !!chatFromP1,
    `P2->P1=${!!chatFromP2} P1->P2=${!!chatFromP1} lines=${chatCount}`);

  // ============================================================ 4. countdown
  const beforeErrors = consoleEvents.length;
  await page.click('#btnStart');
  const seen = [];
  let countdownShot = false;
  const deadline = Date.now() + 6500;
  while (Date.now() < deadline) {
    const snap = await page.evaluate(() => {
      const el = document.querySelector('#countdown');
      return {
        visible: !!el && !el.hidden,
        num: document.querySelector('#countdownNum')?.textContent,
        sub: el?.querySelector('small')?.textContent,
      };
    });
    if (snap.visible && snap.num && seen[seen.length - 1] !== snap.num) {
      seen.push(snap.num);
      if (!countdownShot && snap.num === '3') {
        await shot(page, 'countdown');
        countdownShot = true;
      }
    }
    if (seen.includes('GO')) break;
    await sleep(90);
  }
  const afterGo = await page.evaluate(() => ({
    phase: window.__RR4?.state?.room?.phase,
    overlayHidden: document.querySelector('#countdown')?.hidden,
    badge: document.querySelector('#readyBadge')?.textContent,
  }));
  await sleep(1200);
  const overlayGone = await page.evaluate(() => document.querySelector('#countdown')?.hidden);
  const countdownErrors = consoleEvents.slice(beforeErrors).filter((e) => e.kind === 'pageerror');
  record('4.1', 'PRESS START shows 3/2/1/GO countdown', ['3', '2', '1', 'GO'].every((v) => seen.includes(v)),
    `seen=${JSON.stringify(seen)} phase=${afterGo.phase}`);
  record('4.2', 'Countdown hides after GO with no crash', overlayGone === true && countdownErrors.length === 0,
    `overlayHidden=${overlayGone} pageErrors=${countdownErrors.length}`);

  await waitFor('room reaches race phase', () => page.evaluate(() =>
    window.__RR4?.state?.room?.phase === 'race'), { timeout: 6000 });
  await page.click('#btnStart');
  let secondStartSeen = false;
  const secondDeadline = Date.now() + 5200;
  while (Date.now() < secondDeadline) {
    const snap = await page.evaluate(() => ({
      visible: !document.querySelector('#countdown')?.hidden,
      num: document.querySelector('#countdownNum')?.textContent,
    }));
    if (snap.visible && snap.num === '3') secondStartSeen = true;
    if (secondStartSeen && snap.num === 'GO') break;
    await sleep(100);
  }
  record('4.3', 'PRESS START during a race does not re-run the countdown', !secondStartSeen,
    secondStartSeen ? 'second 3/2/1 countdown observed' : 'no second countdown');

  // ============================================================ 5. fullscreen
  await page.click('#btnFullscreenTop');
  await sleep(1300);
  const fs = await page.evaluate(() => {
    const exit = document.querySelector('#btnExitFs');
    const r = exit?.getBoundingClientRect();
    return {
      fsClass: document.body.classList.contains('fs'),
      fsEl: document.fullscreenElement?.tagName || null,
      exitHidden: exit?.hidden,
      exitVisible: !!r && r.width > 2 && r.height > 2,
      topbarHidden: getComputedStyle(document.querySelector('#topbar')).display === 'none',
    };
  });
  await shot(page, 'fullscreen');
  record('5.1', 'FULLSCREEN enters (body.fs) and shows EXIT FULLSCREEN', fs.fsClass && fs.exitVisible && fs.topbarHidden,
    JSON.stringify(fs));

  await page.click('#btnExitFs');
  await sleep(1200);
  const fsExit = await page.evaluate(() => ({
    fsClass: document.body.classList.contains('fs'),
    fsEl: document.fullscreenElement?.tagName || null,
    exitHidden: document.querySelector('#btnExitFs')?.hidden,
    topbarVisible: getComputedStyle(document.querySelector('#topbar')).display !== 'none',
  }));
  record('5.2', 'EXIT FULLSCREEN restores the normal view', !fsExit.fsClass && fsExit.exitHidden === true && fsExit.topbarVisible,
    JSON.stringify(fsExit));

  // ============================================================ 8. stream + canvas
  const streamInfo = await waitFor('stream bytes > 0', async () => {
    const j = await status();
    const s = j.cabinet?.stream;
    return s && s.running && s.bytesPerSec > 0 ? s : false;
  }, { timeout: 10000, interval: 250 });
  const canvas = await waitFor('canvas 960x720', () => page.evaluate(() => {
    const c = document.querySelector('#streamCanvas');
    return c && c.width === 960 && c.height === 720
      ? { w: c.width, h: c.height, inScreen: c.parentElement?.id }
      : false;
  }), { timeout: 15000, interval: 250 }).catch(() => null);
  const infoStream = await page.$eval('#infoStream', (e) => e.textContent);
  record('8.1', 'Test stream reports running with bytes/sec > 0',
    streamInfo.running && streamInfo.bytesPerSec > 0 && streamInfo.source === 'test',
    `source=${streamInfo.source} bytesPerSec=${streamInfo.bytesPerSec} viewers=${streamInfo.viewers}`);
  record('8.2', 'Canvas decodes at 960x720 in test mode', !!canvas && canvas.w === 960 && canvas.h === 720,
    canvas ? JSON.stringify(canvas) : 'canvas not 960x720');
  record('8.3', 'Stream info panel is live (not OFFLINE)', !/OFFLINE/.test(infoStream || ''), infoStream);

  // ============================================================ 7. refresh/reconnect
  const beforeReload = await page.evaluate(() => ({
    clientId: localStorage.getItem('rr4.clientId'),
    seat1: window.__RR4?.state?.room?.seats?.[1]?.name,
    seat2: window.__RR4?.state?.room?.seats?.[2]?.name,
    viewers: window.__RR4?.state?.room?.viewers?.length,
    youAreHost: window.__RR4?.state?.room?.youAreHost,
  }));
  await page.reload({ waitUntil: 'networkidle2', timeout: 30000 });
  await sleep(1800);
  const autoJoined = await page.evaluate(() =>
    !document.querySelector('#arcade')?.hidden && !!window.__RR4?.state?.joined);
  if (!autoJoined) await joinAs(page, 'QA P1');
  else {
    await page.waitForFunction(() => {
      const s = window.__RR4 && window.__RR4.state;
      return s && s.ws && s.ws.readyState === 1 && s.room;
    }, { timeout: 12000 });
  }
  await sleep(1500);
  const afterReload = await waitFor('P1 reattached', async () => {
    const v = await page.evaluate(() => ({
      clientId: localStorage.getItem('rr4.clientId'),
      mySeat: window.__RR4?.state?.room?.mySeat,
      hud: document.querySelector('#hudSeat')?.textContent,
      seatText: document.querySelector('#seatCards')?.innerText,
      viewers: window.__RR4?.state?.room?.viewers?.length,
      seats: window.__RR4?.state?.room?.seats,
      ids: window.__RR4?.state?.room?.viewers?.map((x) => x.id),
      youAreHost: window.__RR4?.state?.room?.youAreHost,
    }));
    return v.mySeat === 1 && /QA P1/.test(v.seatText || '') ? v : false;
  }, { timeout: 10000 });
  const serverRoom = (await status()).room;
  const uniqueIds = new Set(afterReload.ids || []);
  record('7.1', 'Refresh keeps the same clientId and reattaches to P1',
    afterReload.clientId === beforeReload.clientId && afterReload.mySeat === 1 &&
      /P1 \/\/ QA P1/.test(afterReload.hud || ''),
    `sameId=${afterReload.clientId === beforeReload.clientId} autoJoined=${autoJoined} seat=${afterReload.mySeat} hud=${afterReload.hud}`);
  record('7.2', 'No duplicate seats/viewers after reconnect',
    serverRoom.seats[1]?.name === 'QA P1' && serverRoom.seats[2]?.name === 'QA P2' &&
      serverRoom.viewers.length === 2 && uniqueIds.size === 2,
    `server viewers=${serverRoom.viewers.length} unique=${uniqueIds.size} seats=${JSON.stringify({
      p1: serverRoom.seats[1]?.name, p2: serverRoom.seats[2]?.name,
    })}`);
  record('7.3', 'Host role stays with the reconnecting host', afterReload.youAreHost === beforeReload.youAreHost,
    `before=${beforeReload.youAreHost} after=${afterReload.youAreHost}`);
  await shot(page, 'reconnect');

  // ============================================================ 6. mobile
  const ctx3 = await browser.createBrowserContext();
  const mobile = await ctx3.newPage();
  watchPage(mobile, 'mobile');
  await mobile.setViewport({ width: 390, height: 844, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
  await mobile.goto(BASE, { waitUntil: 'networkidle2', timeout: 30000 });
  await mobile.waitForSelector('#btnFullscreen', { visible: true, timeout: 20000 });
  await sleep(2000);
  const mobileLanding = await waitFor('mobile landing DOM', () => mobile.evaluate(() => {
    const r = document.querySelector('#btnFullscreen').getBoundingClientRect();
    return {
      scrollW: document.documentElement.scrollWidth,
      innerW: innerWidth,
      fsRect: { x: Math.round(r.x), y: Math.round(r.y), right: Math.round(r.right), bottom: Math.round(r.bottom) },
      fsFullyVisible: r.left >= 0 && r.top >= 0 && r.right <= innerWidth + 0.5 && r.bottom <= innerHeight + 0.5 && r.width > 2,
    };
  }), { timeout: 10000, interval: 250 });
  await shot(mobile, 'mobile-landing');
  record('6.1', 'Mobile landing has no horizontal scroll', mobileLanding.scrollW <= mobileLanding.innerW + 1,
    `scrollW=${mobileLanding.scrollW} innerW=${mobileLanding.innerW}`);
  record('6.2', 'Mobile fullscreen button is fully visible', mobileLanding.fsFullyVisible,
    JSON.stringify(mobileLanding.fsRect));

  await joinAs(mobile, 'QA MOBILE');
  await sleep(1600);
  const mobileArcade = await mobile.evaluate(() => {
    const t = document.querySelector('#touchControls');
    const r = document.querySelector('#btnFullscreen').getBoundingClientRect();
    return {
      body: document.body.className,
      touchHidden: t?.hidden,
      touchDisplay: t ? getComputedStyle(t).display : null,
      touchButtons: t ? t.querySelectorAll('button').length : 0,
      scrollW: document.documentElement.scrollWidth,
      innerW: innerWidth,
      fsRect: { x: Math.round(r.x), y: Math.round(r.y), right: Math.round(r.right), bottom: Math.round(r.bottom) },
      fsFullyVisible: r.left >= 0 && r.top >= 0 && r.right <= innerWidth + 0.5 && r.bottom <= innerHeight + 0.5 && r.width > 2,
    };
  });
  await shot(mobile, 'mobile-arcade');
  record('6.3', 'Touch controls are visible on a coarse-pointer phone',
    /touch/.test(mobileArcade.body) && mobileArcade.touchHidden === false && mobileArcade.touchDisplay === 'grid' && mobileArcade.touchButtons >= 14,
    JSON.stringify(mobileArcade));
  record('6.4', 'Mobile arcade has no horizontal scroll', mobileArcade.scrollW <= mobileArcade.innerW + 1,
    `scrollW=${mobileArcade.scrollW} innerW=${mobileArcade.innerW}`);
  record('6.5', 'Mobile arcade fullscreen button is fully visible', mobileArcade.fsFullyVisible,
    JSON.stringify(mobileArcade.fsRect));

  // Mobile fullscreen + fixed-element overlap audit
  await mobile.click('#btnFullscreen');
  await sleep(1300);
  const mobileFs = await mobile.evaluate(() => {
    const t = document.querySelector('#touchControls');
    const s = document.querySelector('.stage-bar');
    const tr = t?.getBoundingClientRect();
    const sr = s?.getBoundingClientRect();
    return {
      fsClass: document.body.classList.contains('fs'),
      touchFixed: t ? getComputedStyle(t).position : null,
      touchRect: tr ? { y: Math.round(tr.y), h: Math.round(tr.height), bottom: Math.round(tr.bottom) } : null,
      stageFixed: s ? getComputedStyle(s).position : null,
      stageRect: sr ? { y: Math.round(sr.y), h: Math.round(sr.height), bottom: Math.round(sr.bottom) } : null,
      scrollW: document.documentElement.scrollWidth,
      innerW: innerWidth,
    };
  });
  await shot(mobile, 'mobile-fullscreen');
  const fixedAudit = await auditFixedOverlaps(mobile);
  record('6.6', 'Mobile fullscreen keeps body.fs and no horizontal scroll',
    mobileFs.fsClass && mobileFs.scrollW <= mobileFs.innerW + 1, JSON.stringify(mobileFs));
  record('9.1', 'No overlapping fixed chrome in mobile fullscreen', fixedAudit.overlaps.length === 0,
    JSON.stringify(fixedAudit));
  const stageCoverage = await auditCoverage(mobile, '.stage-bar button');
  const coveredBad = stageCoverage.filter((x) => x.coveredPct >= 20 || x.centerCovered);
  record('9.5', 'Mobile fullscreen stage-bar buttons are not obscured by touch controls',
    coveredBad.length === 0, JSON.stringify(stageCoverage));

  const overlapTap = await mobile.evaluate(() => {
    const exit = document.querySelector('#btnExitFs').getBoundingClientRect();
    const splitBtn = [...document.querySelectorAll('#viewSwitch button')]
      .find((b) => /FULL SPLIT/.test(b.textContent));
    const split = splitBtn.getBoundingClientRect();
    const l = Math.max(exit.left, split.left);
    const r = Math.min(exit.right, split.right);
    const t = Math.max(exit.top, split.top);
    const b = Math.min(exit.bottom, split.bottom);
    const x = (l + r) / 2;
    const y = (t + b) / 2;
    const top = document.elementFromPoint(x, y);
    return {
      w: Math.round(r - l), h: Math.round(b - t), x: Math.round(x), y: Math.round(y),
      top: top ? (top.id || String(top.className) || top.tagName) : null,
      isExit: top?.id === 'btnExitFs',
    };
  });
  if (overlapTap.w > 0 && overlapTap.h > 0) {
    await mobile.mouse.click(overlapTap.x, overlapTap.y);
    await sleep(900);
    const stillFs = await mobile.evaluate(() => document.body.classList.contains('fs'));
    record('9.6', 'Tapping the overlapped edge of FULL SPLIT does not exit fullscreen', stillFs,
      JSON.stringify({ ...overlapTap, stillFs }));
  } else {
    record('9.6', 'Tapping the overlapped edge of FULL SPLIT does not exit fullscreen', true, 'no overlap');
  }

  // Toasts are fixed and share the bottom edge with the touch deck. Trigger one
  // from the desktop client (leave + retake P1) while mobile is fullscreen.
  if (!(await mobile.evaluate(() => document.body.classList.contains('fs')))) {
    await mobile.click('#btnFullscreen');
    await sleep(1000);
  }
  await page.click('#seatCards .seat-card.p1 button');
  await sleep(500);
  await takeSeat(page, 1);
  await sleep(800);
  const toastCheck = await mobile.evaluate(() => {
    const toast = document.querySelector('.toasts .toast');
    if (!toast) return { toast: false };
    const tr = toast.getBoundingClientRect();
    const touch = document.querySelector('#touchControls').getBoundingClientRect();
    const w = Math.min(tr.right, touch.right) - Math.max(tr.left, touch.left);
    const h = Math.min(tr.bottom, touch.bottom) - Math.max(tr.top, touch.top);
    const bottomBtn = [...document.querySelectorAll('#touchControls button')]
      .map((b) => ({ b, r: b.getBoundingClientRect() }))
      .sort((a, b) => b.r.bottom - a.r.bottom)[0];
    const top = bottomBtn ? document.elementFromPoint(
      bottomBtn.r.left + bottomBtn.r.width / 2,
      bottomBtn.r.top + bottomBtn.r.height / 2,
    ) : null;
    return {
      toast: true,
      text: toast.textContent,
      toastRect: { x: Math.round(tr.x), y: Math.round(tr.y), w: Math.round(tr.width), h: Math.round(tr.height) },
      touchRect: { x: Math.round(touch.x), y: Math.round(touch.y), w: Math.round(touch.width), h: Math.round(touch.height) },
      overlap: { w: Math.round(w), h: Math.round(h) },
      bottomButton: bottomBtn ? (bottomBtn.b.textContent || bottomBtn.b.dataset.touch) : null,
      bottomButtonCoveredBy: top ? (top.id || String(top.className) || top.tagName) : null,
    };
  });
  record('9.7', 'Toasts do not cover the touch deck in mobile fullscreen',
    !toastCheck.toast || toastCheck.overlap.w <= 4 || toastCheck.overlap.h <= 4,
    JSON.stringify(toastCheck));

  await mobile.evaluate(() => { if (document.fullscreenElement) document.exitFullscreen().catch(() => {}); });
  await sleep(900);

  // ============================================================ 9. reachability
  const desktopAudit = await auditButtons(page);
  const desktopFixed = await auditFixedOverlaps(page);
  record('9.2', 'All visible desktop buttons are reachable and un-covered',
    desktopAudit.bad.length === 0,
    `checked=${desktopAudit.total} bad=${JSON.stringify(desktopAudit.bad)}`);
  record('9.3', 'No overlapping fixed chrome on desktop arcade', desktopFixed.overlaps.length === 0,
    JSON.stringify(desktopFixed));

  const mobileAudit = await auditButtons(mobile);
  record('9.4', 'All visible mobile buttons are reachable and un-covered',
    mobileAudit.bad.length === 0,
    `checked=${mobileAudit.total} bad=${JSON.stringify(mobileAudit.bad)}`);

  await shot(mobile, 'mobile-final');
} catch (e) {
  record('0.0', 'Test harness completed without an uncaught exception', false, e.stack || e.message);
  console.error(e);
} finally {
  if (browser) {
    try { await browser.close(); } catch { /* ignore */ }
  }
  try {
    spawnSync('taskkill', ['/PID', String(server.pid), '/T', '/F'], { windowsHide: true, timeout: 10000 });
  } catch { /* ignore */ }
  await sleep(600);

  const errors = consoleEvents.filter((e) => e.kind === 'pageerror' || e.kind === 'console:error');
  const failed = results.filter((r) => !r.pass);
  console.log('\n================ QA SUMMARY ================');
  console.log(`checks: ${results.length}  passed: ${results.length - failed.length}  failed: ${failed.length}`);
  if (failed.length) {
    for (const f of failed) console.log(`FAIL ${f.id} ${f.name} :: ${f.detail}`);
  }
  console.log(`console/page errors: ${errors.length}`);
  for (const e of errors) console.log(`  [${e.label}] ${e.kind}: ${e.text}`);
  const reqFails = consoleEvents.filter((e) => e.kind === 'requestfailed');
  console.log(`request failures: ${reqFails.length}`);
  for (const e of reqFails) console.log(`  [${e.label}] ${e.text}`);
  console.log(`server exit: ${JSON.stringify(serverExit)}`);
  if (serverExit) {
    console.log('--- server log tail ---');
    console.log(serverLog.split(/\r?\n/).slice(-25).join('\n'));
  }
  console.log('screenshots: ' + fs.readdirSync(OUT).filter((f) => f.startsWith('qa-')).join(', '));
  console.log('============================================');
  process.exitCode = failed.length ? 1 : 0;
}
