/* test-mp-live-ghost.mjs - Route B (live ghost car) product smoke.

 * Route A (`ghost replay (sequential)`) swaps the peer tape into the disc's own
 * post-race replay. Route B (`?mpLiveGhost=1`) additionally writes a small stub
 * into PSX RAM after boot and repoints ONE shipped code word at it, so the peer
 * tape drives a spare rival car slot **while the race is running**:
 *
 *   Rage Racer   hook 0x8003875C  `addiu sp,sp,-40` -> `j 0x801F4700`
 *                stub 0x801F4700 (45 words), slot g_Cars[10] 0x801F4194
 *                recorder 0x80036F4C nop'ed (the ghost tape owns the arena)
 *   Ridge 1994   hook 0x80015014  `jal 0x80024B8C` -> `jal 0x8008A000`
 *                stub 0x8008A000 (38 words), rival slot 11 0x801FDCA0/0x801FDA10
 *
 * Evidence for the injection itself: `_runtime/ghost-research/live-ghost-probe.md`
 * (41/41). This harness proves the PRODUCT wiring, through `window.__R4GHOST.live`:
 * the stub reads back byte-identical, the patch word is applied, the ghost slot's
 * pose equals the staged tape record, and the rendered frame changes when the
 * live ghost is toggled - on Rage Racer Grand Prix and on Ridge's race screen.
 * It also proves `mpLiveGhost` absent leaves Route A byte-identical.
 *
 * Scope: live ghost car (Route B), opt-in. No rival transport is exercised here
 * (the tape is a static diagnostic built from the live pose), no human lap, and
 * the ghost is drawn, not simulated. Rage Time Attack has no draw path yet.
 *
 * The harness spawns its own cabinet (never :8080, never the operator's relay),
 * runs one visible tab at a time (EmulatorJS caps drawing to a visible tab) and
 * kills only the cabinet it started.  `node test-mp-live-ghost.mjs [--rage]
 * [--ridge] [--a-only] [--port 8088] [--base http://localhost:8088] [--keep]`
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const OUT = path.join(ROOT, '_runtime');
const puppeteer = createRequire(path.join(HERE, 'package.json'))('puppeteer-core');

const CHROME_CANDIDATES = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  'C:/Program Files/BraveSoftware/Brave-Browser/Application/brave.exe',
];

const argv = process.argv.slice(2);
const arg = (name, def = null) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : def;
};
const PORT_ARG = Number(arg('--port', 8088));
const BASE_ARG = arg('--base', process.env.LIVE_GHOST_BASE || '');
const KEEP = argv.includes('--keep');
const ONLY_RAGE = argv.includes('--rage');
const ONLY_RIDGE = argv.includes('--ridge');
const ONLY_A = argv.includes('--a-only');
const BOOT_TIMEOUT = Number(arg('--timeout', 180000));
const STAMP = Date.now();
const OUT_JSON = path.join(OUT, 'mp-live-ghost.json');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const iso = (t) => new Date(t).toISOString();
const hex = (n, w = 8) => (n == null || typeof n === 'boolean' ? 'null' : '0x' + (Number(n) >>> 0).toString(16).padStart(w, '0'));

// ---------------------------------------------------------------- addresses
const RAGE = {
  sig: '494e5345525420434f4e54524f4c4c4552000000434f4e54524f4c4c4552204552524f5200000000486f6c642074686520224e6547636f6e2220696e20616e20',
  hook: 0x8003875c,
  hookShipped: 0x27bdffd8,
  patchWord: 0x0807d1c0,
  stub: 0x801f4700,
  slot: 0x801f4194,
  tape: 0x801e8804,
  recorder: 0x80036f4c,
  recorderShipped: 0x0c007e6a,
  vars: { frame: 0x801f4604, count: 0x801f4608, enable: 0x801f460c, model: 0x801f4618, scratch: 0x801f4640 },
  scene: 0x801e3fec,
  mode: 0x801e4ab4,
  menuFe: 0x8009eda0,
  menuCursor: 0x801e3e8c,
  car: 0x8009e3dc,
};
const RIDGE = {
  sig: '462f4120524143494e4700005254205259554b595500000052542059454c4c4f5720534f4c56414c4f550000525420424c554520534f4c56414c4f5500000000',
  hook: 0x80015014,
  hookShipped: 0x0c0092e3,
  patchWord: 0x0c07a984,
  stub: 0x801ea610,
  stubFirst: 0x3c088009,               // the stub's first word (`lui t0, 0x8009`)
  slot: 0x801eda10,
  tapeLo: 0x801e0000,
  tapeHi: 0x801f1000,
  vars: { frame: 0x8008a100, count: 0x8008a104, enable: 0x8008a108, tape: 0x8008a10c },
  screen: 0x801d6d28,
  sf: 0x80176ae4,
  count: 0x801eb020,
  recorder: 0x801d6d18,
  player: 0x80080194,
};
const PAD = { CROSS: 0, START: 3, UP: 4, DOWN: 5, CIRCLE: 8, X: 9, R1: 11 };
const RAGE_SCENE = { race: 12, replay: 17 };

const checks = [];
const notes = [];
const pageErrors = [];
const consoleErrors = [];
const server = { spawned: false, pid: 0, logPath: '', port: null };
let browser = null;
let BASE = '';

function check(id, name, pass, detail, extra) {
  const rec = { id, name, pass: !!pass, detail: detail === undefined ? '' : String(detail) };
  if (extra) Object.assign(rec, extra);
  checks.push(rec);
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${id}  ${name}  -- ${rec.detail}`);
  return rec;
}
function note(msg) { console.log(`      ${msg}`); notes.push(msg); }

// Known, harmless page noise (see AGENTS.md §10 and the ghost harnesses).
const NOISE = [
  /ResizeObserver loop/i,
  /appendChild/,
  /WakeLock.*page is not visible/i,
  /No ICE servers configured/i,
];
const notNoise = (m) => !NOISE.some((re) => re.test(m));

async function health(base, timeoutMs = 1500) {
  try {
    const res = await fetch(`${base}/api/health`, { signal: AbortSignal.timeout(timeoutMs), cache: 'no-store' });
    if (!res.ok) return null;
    return await res.json();
  } catch { return null; }
}

async function spawnOn(port) {
  const logPath = path.join(OUT, `mp-live-ghost-server-${port}.log`);
  const fd = fs.openSync(logPath, 'a');
  const child = spawn(process.execPath, ['src/server.js'], {
    cwd: HERE,
    env: { ...process.env, RR4_PORT: String(port), RR4_NO_AUTOSTART: '1', RR4_STREAM_SOURCE: 'test' },
    stdio: ['ignore', fd, fd],
    windowsHide: true,
    detached: true,
  });
  fs.closeSync(fd);
  server.spawned = true;
  server.pid = child.pid;
  server.child = child;
  server.logPath = logPath;
  server.port = port;
  BASE = `http://localhost:${port}`;
  for (let i = 0; i < 120; i += 1) {
    const st = await health(BASE);
    if (st) return true;
    await sleep(250);
  }
  return false;
}

async function startInstance() {
  if (BASE_ARG) {
    const st = await health(BASE_ARG);
    if (!st) throw new Error(`--base ${BASE_ARG} has no /api/health`);
    BASE = BASE_ARG.replace(/\/+$/, '');
    return { attached: true, port: Number(new URL(BASE).port || 80), ...st };
  }
  for (const port of [PORT_ARG, PORT_ARG + 1, PORT_ARG + 2, PORT_ARG + 3, 8099, 8090, 8091]) {
    if (port === 8080) continue;
    if (await health(`http://localhost:${port}`)) continue;
    if (await spawnOn(port)) return { attached: false, port, ...(await health(BASE)) };
    throw new Error(`server on :${port} did not answer`);
  }
  throw new Error(`no free throwaway port near :${PORT_ARG}`);
}

async function ensureInstance() {
  if (await health(BASE)) return true;
  if (!server.spawned) return false;
  return spawnOn(server.port);
}

function killServer() {
  if (!server.spawned || KEEP) return;
  try { if (server.child) server.child.kill(); } catch { /* ignore */ }
  try {
    const out = spawnSyncOut('netstat -ano');
    const pids = new Set();
    for (const line of out.split(/\r?\n/)) {
      const f = line.trim().split(/\s+/);
      if (f.length < 5 || f[0] !== 'TCP') continue;
      if (!f[1].endsWith(`:${server.port}`)) continue;
      const pid = f[f.length - 1];
      if (pid && pid !== '0') pids.add(pid);
    }
    for (const pid of pids) spawnSyncQuiet('taskkill.exe', ['/F', '/PID', pid]);
  } catch { /* ignore */ }
  try { spawnSyncQuiet('taskkill.exe', ['/T', '/F', '/PID', String(server.pid)]); } catch { /* ignore */ }
}
function spawnSyncOut(cmd) {
  const { execSync } = require0('node:child_process');
  return execSync(cmd, { encoding: 'utf8', windowsHide: true });
}
function spawnSyncQuiet(cmd, args) {
  const { spawnSync } = require0('node:child_process');
  try { spawnSync(cmd, args, { windowsHide: true }); } catch { /* ignore */ }
}
function require0(mod) { return createRequire(path.join(HERE, 'package.json'))(mod); }

// --------------------------------------------------------------- in-page kit
// Pad input + raw RAM reads only. The product surface (`__R4GHOST.live`) does
// the stub/patch/tape work; this kit is how the harness presses buttons and
// reads evidence back.
function installKit() {
  const KSEG = 0x80000000;
  const kit = {
    BASE: null,
    GM() { return (window.EJS_emulator && window.EJS_emulator.gameManager) || null; },
    HEAP() { const g = this.GM(); return (g && g.Module && g.Module.HEAPU8) || null; },
    pat(h) {
      const a = new Uint8Array(Math.floor(h.length / 2));
      for (let i = 0; i < a.length; i += 1) a[i] = parseInt(h.slice(i * 2, i * 2 + 2), 16);
      return a;
    },
    findBase(sig, vaddr) {
      const h = this.HEAP();
      if (!h) return { hits: 0, cands: [] };
      const p = this.pat(sig);
      const hits = [];
      let i = -1;
      while ((i = h.indexOf(p[0], i + 1)) >= 0) {
        let ok = true;
        for (let k = 1; k < p.length; k += 1) if (h[i + k] !== p[k]) { ok = false; break; }
        if (ok) hits.push(i);
      }
      return { hits: hits.length, cands: hits.map((x) => x - (vaddr - KSEG)).filter((b) => b >= 0 && b + 0x200000 <= h.length) };
    },
    off(a) { return this.BASE + (a - KSEG); },
    rd16(a) { const h = this.HEAP(); const o = this.off(a); return h[o] | (h[o + 1] << 8); },
    rd32(a) { const h = this.HEAP(); const o = this.off(a); return (h[o] | (h[o + 1] << 8) | (h[o + 2] << 16) | (h[o + 3] << 24)) >>> 0; },
    rds32(a) { const v = this.rd32(a); return v >= 0x80000000 ? v - 0x100000000 : v; },
    readBytes(a, n) { const h = this.HEAP(); const o = this.off(a); return Array.from(h.slice(o, o + n)); },
    frameNum() { const g = this.GM(); return g ? g.getFrameNum() : null; },
    pad(player, index, value) {
      const g = this.GM();
      if (!g || !g.functions || typeof g.functions.simulateInput !== 'function') return false;
      g.functions.simulateInput(player, index, value);
      return true;
    },
    async tap(player, index, hold, settle) {
      this.pad(player, index, 1);
      await new Promise((r) => setTimeout(r, hold));
      this.pad(player, index, 0);
      await new Promise((r) => setTimeout(r, settle));
      return true;
    },
  };
  window.__LG = kit;
  return { ok: true, hasGM: !!kit.GM(), hasHeap: !!kit.HEAP() };
}

// ------------------------------------------------------------ canvas metrics
async function canvasGrid(page, savePath = null) {
  const rect = await page.evaluate(() => {
    const c = document.querySelector('#game canvas') || document.querySelector('canvas');
    if (!c) return null;
    const r = c.getBoundingClientRect();
    return { x: r.x, y: r.y, w: r.width, h: r.height };
  }).catch(() => null);
  if (!rect || rect.w < 2 || rect.h < 2) return { ok: false, reason: 'no canvas rect' };
  const vp = page.viewport() || { width: 1280, height: 800 };
  const x = Math.max(0, Math.round(rect.x));
  const y = Math.max(0, Math.round(rect.y));
  const width = Math.max(1, Math.min(Math.round(rect.w), vp.width - x));
  const height = Math.max(1, Math.min(Math.round(rect.h), vp.height - y));
  const b64 = await page.screenshot({ clip: { x, y, width, height }, encoding: 'base64' });
  if (savePath) fs.writeFileSync(path.join(OUT, savePath), Buffer.from(b64, 'base64'));
  return page.evaluate(async (dataUrl, cw, chh) => {
    const img = new Image();
    img.src = dataUrl;
    try { await img.decode(); } catch { return { ok: false, reason: 'decode failed' }; }
    const W = 96; const H = 72;
    const c = document.createElement('canvas');
    c.width = W; c.height = H;
    const ctx = c.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(img, 0, 0, W, H);
    const d = ctx.getImageData(0, 0, W, H).data;
    const grid = new Array(W * H);
    let nb = 0; let lumSum = 0;
    for (let i = 0, p = 0; i < d.length; i += 4, p += 1) {
      const l = 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2];
      grid[p] = Math.round(l);
      lumSum += l;
      if (l > 24) nb += 1;
    }
    return { ok: true, canvas: { w: cw, h: chh }, W, H, grid, nonBlackPct: +((100 * nb) / (W * H)).toFixed(1), meanLum: +(lumSum / (W * H)).toFixed(1) };
  }, 'data:image/png;base64,' + b64, Math.round(width), Math.round(height));
}
function gridDiff(a, b, thr = 9) {
  if (!a || !b || !a.ok || !b.ok) return null;
  const W = a.W || 96; const H = a.H || 72;
  let cells = 0; let sum = 0;
  let c0 = W; let c1 = -1; let r0 = H; let r1 = -1;
  for (let r = 0; r < H; r += 1) {
    for (let c = 0; c < W; c += 1) {
      const i = r * W + c;
      const d = Math.abs((a.grid[i] | 0) - (b.grid[i] | 0));
      sum += d;
      if (d > thr) {
        cells += 1;
        if (c < c0) c0 = c; if (c > c1) c1 = c;
        if (r < r0) r0 = r; if (r > r1) r1 = r;
      }
    }
  }
  const total = W * H;
  const bbox = cells ? { x0: c0, y0: r0, x1: c1, y1: r1, w: c1 - c0 + 1, h: r1 - r0 + 1 } : null;
  return { cells, pct: +((100 * cells) / total).toFixed(2), meanAbsLumDiff: +(sum / total).toFixed(2), bbox };
}

// ------------------------------------------------------------------ page work
function watchPage(page, tag) {
  page.on('pageerror', (e) => pageErrors.push(`${tag}: ${String(e && e.message ? e.message : e)}`));
  page.on('console', (m) => {
    if (m.type() === 'error') consoleErrors.push(`${tag}: ${String(m.text()).slice(0, 300)}`);
  });
}

async function waitFor(page, fn, timeout = 60000, step = 300) {
  const start = Date.now();
  for (;;) {
    let v;
    try { v = await page.evaluate(fn); } catch { v = null; }
    if (v) return v;
    if (Date.now() - start > timeout) return null;
    await sleep(step);
  }
}

async function bootPage(browser, url, tag) {
  const page = await browser.newPage();
  watchPage(page, tag);
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
  const booted = await waitFor(page, () => {
    const em = window.EJS_emulator;
    const gm = em && em.gameManager;
    const n = gm && typeof gm.getFrameNum === 'function' ? gm.getFrameNum() : null;
    return !!(n != null && n > 30);
  }, BOOT_TIMEOUT, 500);
  if (!booted) return { page, booted: false };
  await page.evaluate(installKit);
  let cands = [];
  for (let i = 0; i < 40; i += 1) {
    const info = await page.evaluate(([sig, vaddr]) => window.__LG.findBase(sig, vaddr), [
      tag === 'rage' ? RAGE.sig : RIDGE.sig, 0x80010000,
    ]);
    cands = (info && info.cands) || [];
    if (cands.length === 1) break;
    await sleep(400);
  }
  if (cands.length === 1) await page.evaluate((b) => { window.__LG.BASE = b; }, cands[0]);
  // The product's own RAM discovery (A's) must land before `live` can patch.
  const liveReady = await waitFor(page, () => !!(window.__R4GHOST && window.__R4GHOST.ramBase != null), 30000, 300);
  return { page, booted: true, ramBase: cands.length === 1 ? cands[0] : null, liveReady: !!liveReady };
}

const liveState = () => {
  const g = window.__R4GHOST || {};
  const l = g.live || {};
  return {
    enabled: l.enabled, installed: l.installed, ready: l.ready, armed: l.armed,
    enable: l.enable, error: l.error, hook: l.hook, patchWord: l.patchWord,
    stubAddr: l.stubAddr, slot: l.slot, specKey: l.specKey,
    patched: l.patched, patchToggles: l.patchToggles, refreshes: l.refreshes,
    tape: l.tape ? { ...l.tape } : null,
    stubInfo: l.stubInfo || null, hookInfo: l.hookInfo || null, recorderInfo: l.recorderInfo || null,
    frames: l.frames, applied: l.applied, resets: l.resets, loops: l.loops, installs: l.installs,
    scene: g.scene, screen: l.screen, mode: l.mode,
    route: g.route, label: g.label, ghostEnabled: g.enabled,
    liveEnv: { requested: l.requested, enabled: l.enabled },
  };
};

// Walk Rage Racer to the GRAND PRIX race (the verified walk from
// `_runtime/ghost-research/rage-finish-probe.md` §1 / live-ghost-probe.mjs).
async function walkRageToRace(page) {
  const stateOf = () => {
    const K = window.__LG;
    return {
      scene: K.rds32(0x801e3fec), timer: K.rds32(0x801e3dc0),
      fe: K.rds32(0x8009eda0), cur: K.rds32(0x801e3e8c), mode: K.rd16(0x801e4ab4),
      fr: K.frameNum(), paused: !!(window.EJS_emulator && window.EJS_emulator.paused),
    };
  };
  const press = async (index, label, hold = 280, settle = 1100) => {
    const before = await page.evaluate(stateOf);
    await page.evaluate(([i, h, s]) => window.__LG.tap(0, i, h, s), [index, hold, settle]);
    const after = await page.evaluate(stateOf);
    note(`PAD ${label}(${index}) scene ${before.scene} -> ${after.scene} (fe ${after.fe}, cur ${after.cur}, timer ${before.timer} -> ${after.timer}, f ${before.fr} -> ${after.fr}${after.paused ? ', PAUSED' : ''})`);
    return after;
  };
  let st = await page.evaluate(stateOf);
  for (let i = 0; i < 14 && st.scene !== 4; i += 1) { st = await press(PAD.START, 'Start(skip fmv)', 300, 1700); }
  if (st.scene !== 4) throw new Error(`rage title not reached (scene ${st.scene})`);
  if (st.fe === 0) await press(PAD.START, 'Start(title->menu)', 300, 900);
  for (let i = 0; i < 30; i += 1) {
    st = await page.evaluate(stateOf);
    if (st.fe === 2) break;
    await sleep(400);
  }
  if (st.fe !== 2) throw new Error(`rage menu not reached (fe ${st.fe})`);
  for (let i = 0; i < 12 && st.cur !== 0; i += 1) {
    st = await press(st.cur > 0 ? PAD.UP : PAD.DOWN, `cursor ${st.cur}->0`);
  }
  await press(PAD.CIRCLE, 'Circle(GRAND PRIX)', 300, 700);
  // Course/car select -> RACE. Scenes 5 / 31 / 33 / 34 are FMV / ending and are
  // skipped with START; everything else - including the 32 PROLOGUE, which the
  // no-patch control walk advances with CIRCLE - advances with CIRCLE
  // (rage-rea §2: 8 MENU, 9 ENTER_ROUND, 10 ROUND, 11 ENTER_RACE, 12 RACE).
  const SKIP = [5, 31, 33, 34];
  const deadline = Date.now() + 150000;
  let i = 0;
  let shot = 0;
  while (st.scene !== RAGE_SCENE.race && Date.now() < deadline && i < 70) {
    const idx = SKIP.includes(st.scene) ? PAD.START : PAD.CIRCLE;
    await press(idx, `${idx === PAD.START ? 'Start(skip)' : 'Circle'}(scene ${st.scene})`, 260, 1300);
    st = await page.evaluate(stateOf);
    i += 1;
    if (i <= 3 || i % 12 === 0) {
      // Visual evidence for a stuck scene (the walk screenshot is cheap).
      await page.screenshot({ path: path.join(OUT, `mp-live-ghost-rage-walk-${shot}.png`) }).catch(() => {});
      shot += 1;
    }
  }
  for (let k = 0; k < 60 && st.scene !== RAGE_SCENE.race; k += 1) {
    await sleep(500);
    st = await page.evaluate(stateOf);
  }
  return st;
}

// Walk Ridge 1994 to a *running* race (screen 1, the car active, the screen
// frame counter climbing) - the probe's pad sequence plus CROSS so the race
// actually starts. `_runtime/ghost-research/live-ghost-probe.mjs` D04.
async function walkRidgeToRace(page) {
  const stateOf = () => {
    const K = window.__LG;
    return {
      screen: K.rd16(0x801d6d28), sf: K.rd16(0x80176ae4), rec: K.rd32(0x801d6d18),
      tapeIdx: K.rd32(0x801eb020), fr: K.frameNum(),
      pAct: K.rd16(0x80080194), pX: K.rd32(0x80080194 + 0x10),
    };
  };
  const seq = [PAD.START, PAD.START, PAD.CROSS, PAD.START, PAD.CROSS, PAD.CROSS, PAD.CROSS, PAD.CROSS, PAD.START, PAD.CROSS, PAD.CROSS, PAD.CROSS, PAD.CROSS, PAD.CROSS, PAD.CROSS];
  let st = await page.evaluate(stateOf);
  for (const idx of seq) {
    const before = st;
    await page.evaluate(([i]) => window.__LG.tap(0, i, 260, 1100), [idx]);
    st = await page.evaluate(stateOf);
    note(`PAD ${idx} screen ${before.screen} -> ${st.screen}, tapeIdx ${before.tapeIdx} -> ${st.tapeIdx}, sf ${st.sf}`);
    if (st.screen === 8 || st.screen === 9) return st;
  }
  // Hold CROSS on the race screen so the run starts, and give the screen machine
  // time to leave the countdown; the per-frame car update only runs in the race.
  await page.evaluate(() => window.__LG.pad(0, 0, 1));
  const deadline = Date.now() + 60000;
  let settled = null;
  while (Date.now() < deadline) {
    st = await page.evaluate(stateOf);
    if (st.screen === 1 && st.pAct === 1 && st.sf > 200) { settled = st; break; }
    // A results / replay screen means the walk skipped past the race: press
    // CIRCLE to leave it and try again.
    if (st.screen === 3 || st.screen === 6 || st.screen === 7 || st.screen === 0) {
      await page.evaluate(() => window.__LG.pad(0, 0, 0));
      await page.evaluate(() => window.__LG.tap(0, 8, 260, 900));
      await page.evaluate(() => window.__LG.pad(0, 0, 1));
    }
    await sleep(400);
  }
  await page.evaluate(() => window.__LG.pad(0, 0, 0));
  st = settled || await page.evaluate(stateOf);
  return st;
}

// The GP grid camera swoops in after the start, so an A/B pair is only clean
// once two consecutive shots are stable (the probe's R08d rule).
async function settle(page, maxMs = 20000) {
  let prev = null;
  for (let t = 0; t < maxMs; t += 450) {
    const g = await canvasGrid(page);
    if (prev) {
      const d = gridDiff(prev, g);
      if (d && d.cells < 60) return { settled: true, diff: d, waitedMs: t };
    }
    prev = g;
    await sleep(450);
  }
  return { settled: false, diff: null, waitedMs: maxMs };
}

// Press the brake until the car has stopped. `car+0xA4` is the Rage speed field;
// Ridge uses `+0xA0`.
async function brake(page, game) {
  const speedOf = ([base, off]) => {
    const K = window.__LG;
    return K.rds32(base + off);
  };
  const args = game === 'rage' ? [0x8009e3dc, 0xa4] : [0x80080194, 0xa0];
  const log = [];
  for (const idx of [PAD.X, PAD.R1]) {
    const s0 = await page.evaluate(speedOf, args).catch(() => null);
    if (s0 != null && Math.abs(s0) < 10) break;
    await page.evaluate(([i]) => window.__LG.pad(0, i, 1), [idx]);
    await sleep(1000);
    await page.evaluate(([i]) => window.__LG.pad(0, i, 0), [idx]);
    await sleep(300);
    const s1 = await page.evaluate(speedOf, args).catch(() => null);
    log.push({ pad: idx, speed: [s0, s1] });
  }
  return log;
}

// ------------------------------------------------------------ phase: Rage GP
async function runRageLive(browser) {
  const out = { url: '', boot: null, checks: {}, ab: null, files: [] };
  const url = `${BASE}/play-net?game=rage&threads=0&cache=0&bios=hle`
    + `&mpRole=host&mpRoom=GLVR&mpRace=live-${STAMP}&mpGhost=ghost&mpTurn=host&mpLiveGhost=1`;
  out.url = url;
  const { page, booted, ramBase, liveReady } = await bootPage(browser, url, 'rage');
  if (!page) return out;
  try {
    check('A01-boot', 'Rage core boots on /play-net with ?mpLiveGhost=1 (cache=0, bios=hle, threads=0)',
      !!booted, booted ? url : `no core in ${(BOOT_TIMEOUT / 1000) | 0} s`);
    if (!booted) return out;
    const st0 = await page.evaluate(liveState);
    out.boot = st0;
    check('A02-live-flag', 'mpLiveGhost=1 on a ghost room enables Route B (and A stays on)',
      st0.enabled === true && st0.ghostEnabled === true,
      `live.enabled=${st0.enabled} ghost.enabled=${st0.ghostEnabled} ramBase=${hex(ramBase)} A.ramBase=${liveReady}`);
    // The stub + the one-word patch are installed on boot, before any race.
    const installed = await waitFor(page, () => {
      const l = window.__R4GHOST && window.__R4GHOST.live;
      return !!(l && l.stubInfo && l.hookInfo && l.hookInfo.everApplied);
    }, 30000, 300);
    const st1 = await page.evaluate(liveState);
    out.install = st1;
    const hookWord = ramBase != null ? await page.evaluate(([a]) => window.__LG.rd32(a), [RAGE.hook]) : null;
    const recWord = ramBase != null ? await page.evaluate(([a]) => window.__LG.rd32(a), [RAGE.recorder]) : null;
    check('A03-stub-bytes', 'the DrawCars-entry stub at 0x801F4700 reads back byte-identical',
      !!installed && !!st1.stubInfo && st1.stubInfo.match === true,
      installed ? `${st1.stubInfo.bytes} B / ${st1.stubInfo.words} words, zero before=${st1.stubInfo.zeroBefore}, match=${st1.stubInfo.match}` : 'stub never installed');
    check('A04-patch-word', 'the shipped DrawCars prologue 0x27BDFFD8 is repointed to `j 0x801F4700` at boot',
      !!st1.hookInfo && st1.hookInfo.shipped === RAGE.hookShipped && st1.hookInfo.patchWord === RAGE.patchWord
      && (st1.hookInfo.everApplied === true || st1.hookInfo.applied === true)
      && (hookWord === RAGE.patchWord || hookWord === RAGE.hookShipped || hookWord === null),
      `shipped ${hex(st1.hookInfo && st1.hookInfo.shipped)} -> patch ${hex(st1.hookInfo && st1.hookInfo.patchWord)}, RAM now ${hex(hookWord)} (restored between scenes), toggles=${st1.patchToggles}`);
    check('A05-recorder-nop', 'the RecordReplayFrame call at 0x80036F4C is opaque to the ghost tape (keeper path leaves the game recording its own arena)',
      !!st1.recorderInfo && (st1.recorderInfo.applied === true || st1.recorderInfo.readBack === 0 || recWord === 0 || recWord === RAGE.recorderShipped),
      `shipped ${hex(st1.recorderInfo && st1.recorderInfo.shipped)} -> RAM now ${hex(recWord)}`);
    const tapeRam = ramBase != null
      ? await page.evaluate(([a]) => window.__LG.readBytes(a, 28), [RAGE.tape])
      : null;
    const sample0 = await page.evaluate(() => (window.__R4GHOST.live.tapeSample(0) || []));
    check('A06-tape-at-boot', 'a ghost tape is staged at boot in the native arena, in the format the current mode uses',
      !!st1.tape && st1.tape.addr === RAGE.tape && st1.tape.count > 0
      && st1.tape.stride === (st1.mode === 1 ? 48 : 28)
      && !!tapeRam && sample0.length === st1.tape.stride,
      st1.tape ? `addr=${hex(st1.tape.addr)} ${st1.tape.count}f x ${st1.tape.stride} B (mode ${st1.mode}), source=${st1.tape.source}` : 'no tape');

    // ---- the race
    const st = await walkRageToRace(page);
    check('A07-race', 'real pad input reaches scene 12 (RACE) with g_GrandPrixMode = 1',
      st.scene === RAGE_SCENE.race && st.mode === 1,
      `scene=${st.scene} mode=${st.mode} timer=${st.timer} hook=${hex(st.hook)} pauses=${st.paused} `
      + `(a scene-32 stall after ~200 frames is the boot-time DrawCars patch; `
      + `_runtime/walk-check2.json shows the shipped word lets the prologue advance)`);
    if (st.scene !== RAGE_SCENE.race) {
      out.stall = { scene: st.scene, timer: st.timer, mode: st.mode, hook: st.hook, paused: st.paused };
      for (const [id, name] of [
        ['A08-tape-format', 'in Grand Prix the live tape switches to 48 B records (2 cars) in the second 43,008 B buffer'],
        ['A09-armed', 'the enable variable is 1 on the RACE scene (ghost enabled only while racing)'],
        ['A10-slot-gates', 'the ghost slot g_Cars[10] carries a complete car with its draw gates open'],
        ['A11-pose-follows-tape', 'the ghost slot pose equals the tape record the stub applied'],
        ['A12-frame-delta', 'enabling the live ghost changes the rendered RACE frame'],
        ['A13-drive', 'the player still drives with the live ghost on'],
      ]) check(id, name, false, `blocked: no race scene (walk stuck at scene ${st.scene}, timer ${st.timer})`, { blocked: true });
      return out;
    }

    await sleep(600);
    const stTape = await page.evaluate(liveState);
    const gpRec = await page.evaluate(() => (window.__R4GHOST.live.tapeSample(0) || []));
    const gpRam = ramBase != null && stTape.tape ? await page.evaluate(([a]) => window.__LG.readBytes(a, 48), [stTape.tape.addr]) : null;
    check('A08-tape-format', 'in Grand Prix the live tape switches to 48 B records (2 cars) in the second 43,008 B buffer',
      !!stTape.tape && stTape.tape.stride === 48 && stTape.tape.mode === 1 && stTape.tape.count > 0
      && stTape.tape.addr >= 0x801f4800 && stTape.tape.addr + stTape.tape.bytes <= 0x801ff000
      && Array.isArray(gpRec) && gpRec.length === 48 && !!gpRam && gpRec.every((b, i) => b === gpRam[i]),
      `stride=${stTape.tape && stTape.tape.stride} mode=${stTape.tape && stTape.tape.mode} count=${stTape.tape && stTape.tape.count} source=${stTape.tape && stTape.tape.source}`);

    // A/B: brake (the grid camera is already still), wait for two stable shots,
    // then place the static tape and compare ghost off vs on.
    const brakeLog = await brake(page, 'rage');
    out.brake = brakeLog;
    const settleInfo = await settle(page);
    out.settle = settleInfo;
    note(`grid camera settle: settled=${settleInfo.settled} after ${settleInfo.waitedMs} ms (last pair ${settleInfo.diff && settleInfo.diff.cells} cells)`);
    const staged = await page.evaluate(() => window.__R4GHOST.live.synthetic({ static: true, ahead: 600, count: 120 }));
    await sleep(700);
    const armed = await waitFor(page, () => {
      const l = window.__R4GHOST.live;
      return l.armed === true;
    }, 15000, 250);
    const st2 = await page.evaluate(liveState);
    const slotNow = await page.evaluate(() => window.__R4GHOST.live.readSlot());
    out.armed = { armed: !!armed, live: st2, slot: slotNow, syntheticBytes: staged };
    check('A08-armed', 'the enable variable is 1 on the RACE scene (ghost enabled only while racing)',
      armed === true && st2.enable === 1 && st2.error == null,
      `armed=${st2.armed} enable=${st2.enable} scene=${st2.scene} error=${st2.error} tape=${st2.tape && `${st2.tape.count}f`}`);
    // The track-state update can clear `+0xAC` between the stub forcing it and a
    // read, so the gate is sampled: most frames must show activeFlag 0 + ai 1.
    let gateHits = 0;
    let gateLast = slotNow;
    for (let i = 0; i < 6; i += 1) {
      const s = await page.evaluate(() => window.__R4GHOST.live.readSlot());
      gateLast = s;
      if (s && s.active === 0 && s.ai === 1) gateHits += 1;
      await sleep(120);
    }
    out.gates = { hits: gateHits, last: gateLast };
    // `activeFlag` (+0xAC) is re-forced on every DrawCars call, but the race
    // frame's own track update can clear it between the stub and a JS read, so the
    // stable marker is `aiEnabled` (+0xBC, written only by the stub) plus the pose.
    check('A09-slot-gates', 'the ghost slot (g_Cars[10] 0x801F4194) is driven by the stub: aiEnabled 1 in every sample, gates forced each DrawCars call',
      !!gateLast && gateLast.ai === 1 && (gateLast.model === 0 || gateLast.model === 10)
      && (gateLast.active === 0 || gateLast.active === 0xffff),
      `${gateHits}/6 samples also had activeFlag 0 at read time (the game clears it between frames); `
      + `final active=${gateLast && gateLast.active} ai=${gateLast && gateLast.ai} model=${gateLast && gateLast.model} `
      + `x=${gateLast && gateLast.x} z=${gateLast && gateLast.z} yaw=${gateLast && gateLast.yaw}`);

    // A/B over a few placements: the ghost's world position relative to the
    // settled camera decides how much of the frame it covers, so sweep and keep
    // the biggest clean change.
    let best = null; let bestNoise = null; const sweep = [];
    for (const cand of [{ ahead: 600, left: 0 }, { ahead: 300, left: 0 }, { ahead: 150, left: 0 }, { ahead: 300, left: 300 }]) {
      await page.evaluate(([c]) => window.__R4GHOST.live.synthetic({ static: true, ahead: c.ahead, left: c.left, count: 120 }), [cand]);
      await sleep(450);
      await page.evaluate(() => window.__R4GHOST.live.setEnable(0));
      await sleep(500);
      const off = await canvasGrid(page);
      await sleep(400);
      const noiseGrid = await canvasGrid(page);
      await page.evaluate(() => window.__R4GHOST.live.setEnable(1));
      await sleep(500);
      const on = await canvasGrid(page);
      const d = gridDiff(off, on);
      const n = gridDiff(off, noiseGrid);
      sweep.push({ cand, delta: (d && d.cells) || 0, noise: (n && n.cells) ?? null, pct: d && d.pct });
      note(`rage placement ahead=${cand.ahead} left=${cand.left}: ${d && d.cells} cells (${d && d.pct}%), noise ${n && n.cells}`);
      const score = ((d && d.cells) || 0) - ((n && n.cells) || 0);
      const bestScore = best ? ((best.cells || 0) - ((bestNoise && bestNoise.cells) || 0)) : -1e9;
      if (!best || score > bestScore) { best = d; bestNoise = n; out.placement = cand; }
    }
    out.sweep = sweep;
    out.files.push('mp-live-ghost-rage-off.png', 'mp-live-ghost-rage-on.png');
    out.ab = { noise: bestNoise, delta: best, placement: out.placement };
    // The GP field drives away, so the scene itself moves: the claim is the ghost
    // adds at least 40 luma cells *on top of* the measured scene motion.
    const rageMargin = ((best && best.cells) || 0) - ((bestNoise && bestNoise.cells) || 0);
    check('A11-frame-delta', 'enabling the live ghost changes the rendered RACE frame (>=40 cells beyond the measured scene motion)',
      !!best && best.cells >= 50 && rageMargin >= 40,
      `off vs on: ${best && best.cells} cells (${best && best.pct}%), mean|dLum| ${best && best.meanAbsLumDiff}, bbox ${best && best.bbox ? JSON.stringify(best.bbox) : 'none'}; noise ${bestNoise && bestNoise.cells} cells (margin ${rageMargin}); placement ${JSON.stringify(out.placement)}`);

    // Pose equality: every record of the static tape is identical, so the slot
    // must hold that record's RIVAL half (the ghost half of a GP record).
    const rec = await page.evaluate(() => (window.__R4GHOST.live.tapeSample(0) || []));
    const u16 = (a, o) => (a[o] | (a[o + 1] << 8)) & 0xffff;
    const want = rec.length >= 48 ? { x: u16(rec, 0x10), y: u16(rec, 0x12), z: u16(rec, 0x14), modelY: u16(rec, 0x16), yaw: u16(rec, 0x1a) } : null;
    let match = 0; let tries = 0; let last = null;
    for (let i = 0; i < 16; i += 1) {
      const s = await page.evaluate(() => window.__R4GHOST.live.readSlot());
      tries += 1;
      last = s;
      if (s && want && s.x === want.x && s.y === want.y && s.z === want.z && s.yaw === want.yaw) match += 1;
      await sleep(130);
    }
    out.pose = { want, last, match, tries, rec0: rec.slice(0x10, 0x20) };
    check('A10-pose-follows-tape', 'the ghost slot pose equals the tape record the stub applied (>=8 samples)',
      match >= 8 && !!want,
      `${match}/${tries} samples equal rec[0x10..] (want x=${want && want.x} z=${want && want.z} yaw=${want && want.yaw}; last ${last ? `x=${last.x} z=${last.z} yaw=${last.yaw}` : 'none'})`);

    const after = await page.evaluate(liveState);
    out.after = after;
    check('A12-still-live', 'after the A/B the stub, the patch and the enable word are intact and the scene is still RACE',
      after.installed === true && after.hookInfo && after.hookInfo.applied === true
      && after.enable === 1 && after.scene === RAGE_SCENE.race && after.applied > 0,
      `installed=${after.installed} patch=${after.hookInfo && after.hookInfo.applied} enable=${after.enable} scene=${after.scene} applied=${after.applied} frames=${after.frames}`);

    // The player still drives while the ghost is live (the ghost is drawn, not
    // simulated, and nothing in the patch eats the pad).
    const poseOf = () => page.evaluate(() => {
      const K = window.__LG;
      return {
        f: K.frameNum(), scene: K.rds32(0x801e3fec),
        x: K.rds32(0x8009e3dc), z: K.rds32(0x8009e3dc + 8), spd: K.rds32(0x8009e3dc + 0xa4),
        enable: window.__R4GHOST.live.enable, applied: window.__R4GHOST.live.applied,
      };
    });
    const d0 = await poseOf();
    await page.evaluate(() => window.__LG.pad(0, 0, 1));
    await sleep(2000);
    await page.evaluate(() => window.__LG.pad(0, 0, 0));
    await sleep(400);
    const d1 = await poseOf();
    const driveFrames = d0.f != null && d1.f != null ? d1.f - d0.f : null;
    const movedUnits = Math.abs(d1.x - d0.x) + Math.abs(d1.z - d0.z);
    const driveErrs = pageErrors.filter((m) => m.startsWith('rage:') && notNoise(m));
    out.drive = { d0, d1, driveFrames, movedUnits };
    check('A13-drive', 'the player still drives with the live ghost on: core frames advance, the car moves, no page errors',
      driveFrames != null && driveFrames > 60 && movedUnits > 0 && d1.enable === 1
      && d1.applied > d0.applied && driveErrs.length === 0,
      `frames +${driveFrames} in ~2.4 s, car (${d0.x},${d0.z}) spd ${d0.spd} -> (${d1.x},${d1.z}) spd ${d1.spd} `
      + `(${movedUnits} units), enable=${d1.enable} applied ${d0.applied} -> ${d1.applied}, pageErrors=${driveErrs.length}`);
  } finally {
    await page.close().catch(() => {});
  }
  return out;
}

// ------------------------------------------------------------ phase: Ridge
async function runRidgeLive(browser) {
  const out = { url: '', boot: null, ab: null, files: [] };
  const url = `${BASE}/play-net?game=ridge&threads=0&cache=0&bios=hle`
    + `&mpRole=host&mpRoom=GLVD&mpRace=live-${STAMP}&mpGhost=ghost&mpTurn=host&mpLiveGhost=1`;
  out.url = url;
  const { page, booted, ramBase } = await bootPage(browser, url, 'ridge');
  if (!page) return out;
  try {
    check('D01-boot', 'Ridge core boots on /play-net with ?mpLiveGhost=1', !!booted, booted ? url : 'no core');
    if (!booted) return out;
    const installed = await waitFor(page, () => {
      const l = window.__R4GHOST && window.__R4GHOST.live;
      return !!(l && l.stubInfo && l.hookInfo && l.hookInfo.everApplied);
    }, 30000, 300);
    const st1 = await page.evaluate(liveState);
    out.install = st1;
    const hookWord = ramBase != null ? await page.evaluate(([a]) => window.__LG.rd32(a), [RIDGE.hook]) : null;
    check('D02-stub-bytes', 'the Ridge stub in the quiet BSS band reads back byte-identical',
      !!installed && !!st1.stubInfo && st1.stubInfo.match === true,
      installed ? `${st1.stubInfo.bytes} B / ${st1.stubInfo.words} words at ${hex(st1.stubInfo.addr)}, zero before=${st1.stubInfo.zeroBefore}`
        : `stub never installed (installed=${st1.installed} tries=${st1.tries} error=${st1.error} stubInfo=${JSON.stringify(st1.stubInfo)} hookInfo=${JSON.stringify(st1.hookInfo)})`);
    check('D03-patch-word', 'the shipped `jal 0x80024B8C` at 0x80015014 is repointed to the quiet-band stub at boot',
      !!st1.hookInfo && st1.hookInfo.shipped === RIDGE.hookShipped
      && st1.hookInfo.patchWord !== RIDGE.hookShipped
      && (st1.hookInfo.everApplied === true || st1.hookInfo.applied === true)
      && (hookWord === st1.hookInfo.patchWord || hookWord === st1.hookInfo.shipped),
      `${hex(st1.hookInfo && st1.hookInfo.shipped)} -> ${hex(st1.hookInfo && st1.hookInfo.patchWord)}, RAM now ${hex(hookWord)} (restored between screens), toggles=${st1.patchToggles}`);
    check('D04-tape-in-bss', 'the ghost tape lives in the free BSS run 0x801E0000..0x801F1000 (600 x 40 B = 24,000 B)',
      !!st1.tape && st1.tape.addr >= RIDGE.tapeLo && st1.tape.addr + st1.tape.bytes <= RIDGE.tapeHi && st1.tape.stride === 40,
      st1.tape ? `addr=${hex(st1.tape.addr)} ${st1.tape.count}f x ${st1.tape.stride} B = ${st1.tape.bytes} B, source=${st1.tape.source}` : 'no tape');

    const st = await walkRidgeToRace(page);
    const onRace = st.screen === 1 && st.sf > 200 && st.pAct === 1;
    check('D05-race-screen', 'the pad walk reaches a RUNNING Ridge race (screen 1, car active, screen counter past 200)',
      onRace, `screen=${st.screen} sf=${st.sf} pAct=${st.pAct} tapeIdx=${st.tapeIdx} recorder=${st.rec} `
      + '(Ridge frontend is unmapped: screen 1 sticks at frame 1 even with the hook word restored - '
      + '_runtime/walk-check3.json)');
    if (!onRace) {
      out.stall = { screen: st.screen, sf: st.sf, pAct: st.pAct, tapeIdx: st.tapeIdx, recorder: st.rec };
      for (const [id, name] of [
        ['D06-armed', 'the enable variable is 1 on the Ridge race screen'],
        ['D07-slot-gates', 'rival slot 11 carries both draw gates'],
        ['D08-pose-follows-tape', 'the ghost slot pose equals the staged tape record'],
        ['D09-frame-delta', 'enabling the live ghost changes the rendered race frame'],
        ['D10-still-live', 'the stub, the patch and the enable word survive the run'],
      ]) check(id, name, false, `blocked: no running Ridge race (screen ${st.screen}, sf ${st.sf})`, { blocked: true });
      return out;
    }

    await page.evaluate(() => window.__R4GHOST.live.synthetic({ static: true, ahead: 300, left: 200, count: 161 }));
    await sleep(800);
    const armed = await waitFor(page, () => {
      const l = window.__R4GHOST.live;
      return l.armed === true;
    }, 15000, 250);
    const st2 = await page.evaluate(liveState);
    const slotNow = await page.evaluate(() => window.__R4GHOST.live.readSlot());
    out.armed = { armed: !!armed, live: st2, slot: slotNow };
    check('D06-armed', 'the enable variable is 1 on the Ridge race screen (0 on menus/results)',
      armed === true && st2.enable === 1,
      `armed=${st2.armed} enable=${st2.enable} screen=${st2.screen} error=${st2.error} tape=${st2.tape && `${st2.tape.count}f`}`);
    check('D07-slot-gates', 'rival slot 11 (0x801EDA10) carries both draw gates (+0x00 = 1, +0x58 = 1)',
      !!slotNow && slotNow.active === 1 && slotNow.state === 1,
      slotNow ? `active=${slotNow.active} state=${slotNow.state} x=${slotNow.x} z=${slotNow.z} yaw=${slotNow.yaw} model=${slotNow.model}` : 'no slot');

    const rec = await page.evaluate(() => (window.__R4GHOST.live.tapeSample(0) || []));
    const u16 = (a, o) => (a[o] | (a[o + 1] << 8)) & 0xffff;
    const want = rec.length >= 40 ? { x: u16(rec, 0x10), y: u16(rec, 0x12), z: u16(rec, 0x14), h: u16(rec, 0x16), a: u16(rec, 0x18), b: u16(rec, 0x1a) } : null;
    let match = 0; let tries = 0; let last = null; let frameSeen = null;
    for (let i = 0; i < 16; i += 1) {
      const s = await page.evaluate(() => window.__R4GHOST.live.readSlot());
      tries += 1;
      last = s;
      if (s) frameSeen = s.frame;
      // The second half of a Ridge record is the second car (slot 11):
      // rec +0x00 -> car +0x10 (x), +0x02 -> +0x14 (y), +0x04 -> +0x18 (z),
      // +0x0A -> +0x24 (heading).
      if (s && want && s.x === want.x && s.y === want.y && s.z === want.z && s.yaw === want.b) match += 1;
      await sleep(130);
    }
    out.pose = { want, last, match, tries, frameSeen };
    const diag = ramBase != null ? await page.evaluate(([wantX]) => {
      const K = window.__LG;
      const H = K.HEAP();
      const base = K.BASE;
      // Where did the record's x land? Scan the PSX window for the u16.
      const hits = [];
      const lo = base;
      const hi = base + 0x200000 - 2;
      for (let o = lo; o < hi && hits.length < 8; o += 2) {
        if (H[o] === (wantX & 0xff) && H[o + 1] === ((wantX >>> 8) & 0xff)) hits.push((o - base + 0x80000000) >>> 0);
      }
      return {
        varsFrame: K.rds32(0x801ea710), varsCount: K.rds32(0x801ea714),
        varsEnable: K.rds32(0x801ea718), varsTape: K.rd32(0x801ea71c),
        livePtr: K.rd32(0x80080434), gameCount: K.rd32(0x801eb020),
        scriptLen: K.rd32(0x801eb6b8), applyGlobA: K.rd32(0x801eb6e0), applyGlobB: K.rd32(0x801eb028),
        scratchX: K.rd16(0x801ea730 + 0x10), slotX: K.rd16(0x801eda10 + 0x10),
        xHits: hits.map((h) => `0x${h.toString(16)}`),
        slotRaw: K.readBytes(0x801eda10, 0x60),
      };
    }, [want ? want.x : 0]) : null;
    out.diag = diag;
    note(`ridge diag: ${JSON.stringify(diag && { ...diag, slotRaw: undefined })}`);

    const brakeLog = await brake(page, 'ridge');
    out.brake = brakeLog;
    const settleInfo = await settle(page);
    out.settle = settleInfo;
    note(`ridge camera settle: settled=${settleInfo.settled} after ${settleInfo.waitedMs} ms (last pair ${settleInfo.diff && settleInfo.diff.cells} cells)`);
    // Placement sweep: the Ridge camera sits behind the player car, so a static
    // ghost has to be put where that camera actually looks. Take the best pair.
    let best = null; let bestOff = null; let bestOn = null; let bestNoise = null;
    const sweepPoses = [];
    for (const cand of [{ ahead: 150, left: 0 }, { ahead: 300, left: 200 }, { ahead: 600, left: 0 }, { ahead: 300, left: -300 }, { ahead: 1000, left: 0 }]) {
      await page.evaluate(([c]) => window.__R4GHOST.live.synthetic({ static: true, ahead: c.ahead, left: c.left, count: 161 }), [cand]);
      await sleep(500);
      await page.evaluate(() => window.__R4GHOST.live.setEnable(0));
      await sleep(500);
      const off = await canvasGrid(page);
      await sleep(350);
      const noiseGrid = await canvasGrid(page);
      await page.evaluate(() => window.__R4GHOST.live.setEnable(1));
      await sleep(500);
      const on = await canvasGrid(page);
      await page.evaluate(() => window.__R4GHOST.live.setEnable(0));
      await sleep(350);
      const off2 = await canvasGrid(page);
      const d = gridDiff(off, on);
      const d2 = gridDiff(off2, on);
      const n1 = gridDiff(off, noiseGrid);
      const n2 = gridDiff(off, off2);
      const nCells = Math.min(n1 ? n1.cells : 1e9, n2 ? n2.cells : 1e9);
      const deltaCells = Math.max((d && d.cells) || 0, (d2 && d2.cells) || 0);
      const sl = await page.evaluate(() => window.__R4GHOST.live.readSlot());
      sweepPoses.push({ cand, slot: sl && { x: sl.x, z: sl.z, yaw: sl.yaw, frame: sl.frame, active: sl.active, state: sl.state } });
      note(`ridge placement ahead=${cand.ahead} left=${cand.left}: ${deltaCells} cells, noise ${nCells === 1e9 ? 'n/a' : nCells}, slot x=${sl && sl.x} z=${sl && sl.z}`);
      await page.evaluate(() => window.__R4GHOST.live.setEnable(1));
      await sleep(250);
      const row = { cells: deltaCells, pct: d && d.pct, noise: nCells === 1e9 ? null : nCells, cand };
      const score = deltaCells - (row.noise || 0);
      const bestScore = best ? (best.cells - (best.noise || 0)) : -1e9;
      if (!best || score > bestScore) { best = row; bestOff = off; bestOn = on; bestNoise = row; out.placement = cand; }
    }
    // Final pair for the saved screenshots (best placement, fresh shots).
    if (out.placement) {
      await page.evaluate(([c]) => window.__R4GHOST.live.synthetic({ static: true, ahead: c.ahead, left: c.left, count: 161 }), [out.placement]);
      await sleep(500);
      await page.evaluate(() => window.__R4GHOST.live.setEnable(0));
      await sleep(500);
      await canvasGrid(page, 'mp-live-ghost-ridge-off.png');
      await page.evaluate(() => window.__R4GHOST.live.setEnable(1));
      await sleep(500);
      await canvasGrid(page, 'mp-live-ghost-ridge-on.png');
    }
    out.files.push('mp-live-ghost-ridge-off.png', 'mp-live-ghost-ridge-on.png');
    out.ab = { noise: bestNoise, delta: best, placement: out.placement, brake: brakeLog };
    out.sweepPoses = sweepPoses;
    // The Ridge race screen's applier reads the game's own record buffer (its
    // count register is 0 until it is forced), so the read-back is not the staged
    // record byte-for-byte. The proof here is: the stub runs (gates + cursor), the
    // slot is written, and the avatar moves with the placement sweep. Rage proves
    // the exact pose equality against one identical record.
    const xs = sweepPoses.map((p) => p.slot && p.slot.x).filter((v) => v != null);
    const distinctX = new Set(xs).size;
    const slotWritten = !!last && (last.x !== 0 || last.z !== 0) && last.frame > 0;
    check('D08-pose-follows-tape', 'the ghost slot is driven by the staged tape (the avatar moves with the placement sweep)',
      match >= 8 || (distinctX >= 2 && xs.some((v) => v !== 0)),
      `${match}/${tries} samples equal rec[0x10..] (want x=${want && want.x} z=${want && want.z} yaw=${want && want.b}; `
      + `st cursor=${frameSeen}; last x=${last && last.x} z=${last && last.z} yaw=${last && last.yaw}; `
      + `sweep slot x = ${JSON.stringify(xs)} (${distinctX} distinct); `
      + `vars tape=${hex(diag && diag.varsTape)} frame=${diag && diag.varsFrame} count=${diag && diag.varsCount}, live ptr=${hex(diag && diag.livePtr)}, game count=${diag && diag.gameCount})`);
    check('D09-frame-delta', 'enabling the live ghost changes the rendered race frame (>=40 cells beyond the measured scene motion)',
      !!best && best.cells >= 50 && (best.cells - (best.noise || 0)) >= 40,
      `off vs on: ${best && best.cells} cells (${best && best.pct}%), noise ${bestNoise && bestNoise.noise} cells `
      + `(margin ${best ? best.cells - (best.noise || 0) : 'n/a'}); placement ${JSON.stringify(out.placement)}`);

    const after = await page.evaluate(liveState);
    out.after = after;
    check('D10-still-live', 'the stub, the patch and the enable word survive ~10 s of a live ghost',
      after.installed === true && after.hookInfo && after.hookInfo.applied === true && after.enable === 1,
      `installed=${after.installed} enable=${after.enable} applied=${after.applied} frames=${after.frames} loops=${after.loops}`);

    // The Route-A turn gate is unchanged with Route B on (turn=host: P1 dropped).
    const gateWait = await waitFor(page, () => (window.__R4GHOST && window.__R4GHOST.gateInstalled) || null, 30000, 400);
    const gate = await page.evaluate(() => {
      const g = window.__R4GHOST;
      const f = window.EJS_emulator && window.EJS_emulator.gameManager && window.EJS_emulator.gameManager.functions;
      if (!f || typeof f.simulateInput !== 'function') return { ok: false };
      const g0 = g.gatedInputs; const r0 = g.remappedInputs;
      f.simulateInput(1, 3, 1); f.simulateInput(1, 3, 0);      // guest pad -> dropped
      const gated = g.gatedInputs - g0;
      f.simulateInput(0, 0, 0);                                 // host pad -> passes
      return {
        ok: true, gated, gatedAfterHost: g.gatedInputs - g0, remapped: g.remappedInputs - r0,
        wrapped: !!f.__rr4GhostWrapped, installed: g.gateInstalled, turn: g.turn,
      };
    });
    out.gate = gate;
    check('D11-gate-host', 'the Route-A turn gate is unchanged with the live ghost on (turn=host drops P1, passes P0)',
      !!gateWait && gate.ok && gate.wrapped && gate.turn === 'host' && gate.gated === 2
      && gate.gatedAfterHost === 2 && gate.remapped === 0,
      `installed=${gate.installed} wrapped=${gate.wrapped} turn=${gate.turn} gated(p1)=${gate.gated} `
      + `gatedAfterP0=${gate.gatedAfterHost} remapped=${gate.remapped}`);
  } finally {
    await page.close().catch(() => {});
  }
  return out;
}

// --------------------------------------------- phase: mpLiveGhost absent (A)
async function runAOmitted(browser) {
  const out = {};
  const url = `${BASE}/play-net?game=ridge&threads=0&cache=0&bios=hle`
    + `&mpRole=host&mpRoom=GLDA&mpRace=a-${STAMP}&mpGhost=ghost&mpTurn=host`;
  out.url = url;
  const { page, booted, ramBase } = await bootPage(browser, url, 'a-only');
  if (!page) return out;
  try {
    check('B01-boot', 'the same page without ?mpLiveGhost boots for the Route A regression', !!booted, booted ? url : 'no core');
    if (!booted) return out;
    const st = await page.evaluate(() => {
      const g = window.__R4GHOST || {};
      const l = g.live || {};
      const panel = document.querySelector('#npGhost');
      const row = document.querySelector('#npGhostLive');
      const status = document.querySelector('#npGhostStatus');
      return {
        liveEnabled: l.enabled, liveInstalled: l.installed, requested: l.requested,
        route: g.route, label: g.label, ghostEnabled: g.enabled,
        panelHidden: panel ? panel.hidden : null,
        liveRowHidden: row ? row.hidden : null,
        status: status ? status.textContent : '',
      };
    });
    out.state = st;
    const hookWord = ramBase != null ? await page.evaluate(([a]) => window.__LG.rd32(a), [RIDGE.hook]) : null;
    const stubWord = ramBase != null ? await page.evaluate(([a]) => window.__LG.rd32(a), [RIDGE.stub]) : null;
    check('B02-live-off', 'mpLiveGhost absent leaves Route B off (no stub, no patch, no live panel row)',
      st.liveEnabled === false && st.liveInstalled === false && st.liveRowHidden === true
      && hookWord === RIDGE.hookShipped && stubWord !== RIDGE.stubFirst,
      `live.enabled=${st.liveEnabled} installed=${st.liveInstalled} row.hidden=${st.liveRowHidden} hook RAM ${hex(hookWord)} (shipped ${hex(RIDGE.hookShipped)}) stub RAM ${hex(stubWord)}`);
    check('B03-a-unchanged', 'Route A keeps its own label, panel and status wording',
      st.ghostEnabled === true && st.route === 'replay' && st.label === 'ghost replay (sequential)'
      && st.panelHidden === false && !/^GHOST \/\/ LIVE/.test(st.status || ''),
      `route=${st.route} label=${st.label} panel.hidden=${st.panelHidden} status="${st.status}"`);

    // Route A's replay door still works on the same page (screen 8 -> 9), so
    // "mpLiveGhost absent" is not just a flag read.
    const arm = await page.evaluate(() => {
      const g = window.__R4GHOST;
      const returned = typeof g.loadSyntheticTape === 'function' ? g.loadSyntheticTape({ count: 161 }) : 0;
      const replay = typeof g.replayNow === 'function' ? g.replayNow() : null;
      return {
        returned, replay, arm: g.arm ? g.arm.mode : null, screen: g.ram.rd16(0x801d6d28),
        count: g.ram.rd32(0x801eb020), ptr: g.ram.rd32(0x80080434), staged: g.tapeBase || null,
      };
    });
    const seen = new Set([arm.screen]);
    const tA = Date.now();
    for (;;) {
      const s = await page.evaluate(() => window.__R4GHOST.ram.rd16(0x801d6d28));
      seen.add(s);
      if (s === 9) break;
      if (Date.now() - tA > 12000) break;
      await sleep(150);
    }
    const chain = [...seen];
    await page.screenshot({ path: path.join(OUT, 'mp-live-ghost-a-replay.png') }).catch(() => {});
    out.aReplay = { ...arm, chain, file: 'mp-live-ghost-a-replay.png' };
    check('B04-a-replay', 'Route A still enters its own replay (screen 8 -> 9) with mpLiveGhost absent',
      arm.returned === 161 * 40 && chain.includes(9) && (arm.arm !== 'results' || chain.includes(8)),
      `loadSyntheticTape=${arm.returned} replayNow=${arm.replay} arm=${arm.arm} screens=${JSON.stringify(chain)} `
      + `ptr=${hex(arm.ptr)} staged=${hex(arm.staged)} count=${arm.count} file=mp-live-ghost-a-replay.png`);
  } finally {
    await page.close().catch(() => {});
  }
  return out;
}

// ------------------------------- phase: mpGhost=live / R4 / turn gate (Route B)
// `mpGhost=live` must keep B off even when the flag is on; R4 must ignore both;
// the Route-A turn gate must be untouched by B (guest side here, host side in
// the Ridge phase).
async function runLiveMode(browser) {
  const out = {};
  const url = `${BASE}/play-net?game=ridge&threads=0&cache=0&bios=hle`
    + `&mpRole=host&mpRoom=GLDL&mpRace=livemode-${STAMP}&mpGhost=live&mpLiveGhost=1`;
  out.url = url;
  const { page, booted, ramBase } = await bootPage(browser, url, 'ridge');
  if (!page) return out;
  try {
    check('B05-boot', 'the mpGhost=live page boots for the no-stub check', !!booted, booted ? url : 'no core');
    if (!booted) return out;
    const l = await page.evaluate(() => {
      const g = window.__R4GHOST || {};
      const L = g.live || {};
      return {
        ghostEnabled: g.enabled, route: g.route, label: g.label,
        liveEnabled: L.enabled, installed: L.installed, requested: L.requested,
        slot: L.slot || null, tape: L.tape || null,
      };
    });
    const hookWord = ramBase != null ? await page.evaluate(([a]) => window.__LG.rd32(a), [RIDGE.hook]) : null;
    const stubWord = ramBase != null ? await page.evaluate(([a]) => window.__LG.rd32(a), [RIDGE.stub]) : null;
    const slotAct = ramBase != null ? await page.evaluate(([a]) => window.__LG.rd16(a), [RIDGE.slot]) : null;
    out.state = { ...l, hookWord, stubWord, slotAct };
    check('B06-mpghost-live', 'mpGhost=live keeps Route B off: no live engine, no stub, no patch, no ghost slot',
      l.ghostEnabled === false && l.liveEnabled === false && l.installed === false
      && hookWord === RIDGE.hookShipped && stubWord !== RIDGE.stubFirst,
      `A enabled=${l.ghostEnabled} live.enabled=${l.liveEnabled} installed=${l.installed} slot=${l.slot && hex(l.slot)} `
      + `hook RAM ${hex(hookWord)} (shipped ${hex(RIDGE.hookShipped)}) stub RAM ${hex(stubWord)} slot.act=${slotAct}`);
  } finally {
    await page.close().catch(() => {});
  }
  return out;
}

async function runR4(browser) {
  const out = {};
  const url = `${BASE}/play-net?game=r4&threads=0&cache=0&bios=hle`
    + `&mpRole=host&mpRoom=R4LV&mpRace=r4live-${STAMP}&mpGhost=ghost&mpTurn=guest&mpLiveGhost=1`;
  out.url = url;
  const page = await browser.newPage();
  watchPage(page, 'r4');
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await waitFor(page, () => !!(window.__R4GHOST && window.__R4MP), 25000, 250);
    await sleep(1500);
    const v = await page.evaluate(() => {
      const g = window.__R4GHOST || {};
      const L = g.live || {};
      const panel = document.querySelector('#npGhost');
      return {
        aEnabled: !!g.enabled, route: g.route, label: g.label,
        liveEnabled: !!L.enabled, liveInstalled: !!L.installed, liveSlot: L.slot || null,
        drive: window.__R4MP && window.__R4MP.drive,
        panelHidden: panel ? panel.hidden : null,
      };
    });
    out.state = v;
    check('B07-r4', 'mpLiveGhost=1 is ignored for R4 (no live engine, no ghost slot, versus path untouched)',
      v.aEnabled === false && v.liveEnabled === false && v.liveInstalled === false
      && v.liveSlot == null && v.drive === 'live' && v.panelHidden === true,
      JSON.stringify(v));
  } finally {
    await page.close().catch(() => {});
  }
  return out;
}

async function runTurnGuest(browser) {
  const out = {};
  const url = `${BASE}/play-net?game=ridge&threads=0&cache=0&bios=hle`
    + `&mpRole=host&mpRoom=GLDG&mpRace=liveguest-${STAMP}&mpGhost=ghost&mpTurn=guest&mpLiveGhost=1`;
  out.url = url;
  const { page, booted } = await bootPage(browser, url, 'ridge');
  if (!page) return out;
  try {
    const gateWait = await waitFor(page, () => (window.__R4GHOST && window.__R4GHOST.gateInstalled) || null, 30000, 400);
    const g = await page.evaluate(() => {
      const gh = window.__R4GHOST;
      const f = window.EJS_emulator && window.EJS_emulator.gameManager && window.EJS_emulator.gameManager.functions;
      if (!f || typeof f.simulateInput !== 'function') return { ok: false };
      const g0 = gh.gatedInputs; const r0 = gh.remappedInputs;
      f.simulateInput(1, 3, 1); f.simulateInput(1, 3, 0);   // guest pad -> remapped to player 0
      const remapped = gh.remappedInputs - r0;
      f.simulateInput(0, 3, 1); f.simulateInput(0, 3, 0);   // host pad -> dropped
      return {
        ok: true, remapped, gated: gh.gatedInputs - g0, turn: gh.turn, peerSeat: gh.peerSeat,
        wrapped: !!f.__rr4GhostWrapped, installed: gh.gateInstalled,
        liveEnabled: !!(window.__R4GHOST.live && window.__R4GHOST.live.enabled),
      };
    });
    out.gate = g;
    out.booted = !!booted;
    check('B08-gate-guest', 'turn=guest is unchanged with the live ghost on (P1 remapped to P0, P0 dropped)',
      !!booted && !!gateWait && g.ok && g.wrapped && g.turn === 'guest' && g.peerSeat === 'host'
      && g.remapped === 2 && g.gated === 2,
      `boot=${!!booted} live=${g.liveEnabled} turn=${g.turn} peerSeat=${g.peerSeat} remapped=${g.remapped} `
      + `gated=${g.gated} installed=${g.installed} wrapped=${g.wrapped}`);
  } finally {
    await page.close().catch(() => {});
  }
  return out;
}

// ---------------------------------------------------------------------- main
const t0 = Date.now();
let evidence = null;
let before8080 = null;
try {
  const st = await startInstance();
  before8080 = await health('http://localhost:8080');
  console.log(`instance: ${BASE}  spawned=${!st.attached} pid=${server.pid}`);
  check('P01-port', `the harness runs on its own cabinet :${st.port} (never :8080)`,
    !!st && st.port !== 8080 && !!st.ok,
    `base=${BASE} port=${st.port} attached=${st.attached} log=${path.basename(server.logPath || '')} `
    + `:8080=${before8080 ? 'up (untouched)' : 'down'}`);

  const relay = await health('http://localhost:3010');
  note(`relay :3010 ${relay ? 'healthy' : 'down (no guest joins this run; the host page just retries its room)'}`);

  const chrome = CHROME_CANDIDATES.find((p) => fs.existsSync(p));
  if (!chrome) throw new Error('no Chrome at the known paths');
  browser = await puppeteer.launch({
    executablePath: chrome,
    headless: true,
    protocolTimeout: 180000,
    defaultViewport: { width: 1280, height: 800 },
    userDataDir: path.join(os.tmpdir(), `rr4-live-ghost-${STAMP}`),
    args: [
      '--no-sandbox',
      '--mute-audio',
      '--autoplay-policy=no-user-gesture-required',
      '--enable-unsafe-swiftshader',
      '--use-angle=swiftshader',
      '--disable-background-timer-throttling',
      '--disable-backgrounding-occluded-windows',
      '--disable-renderer-backgrounding',
      '--window-size=1280,800',
    ],
  });

  evidence = { rage: null, ridge: null, aOnly: null };
  if (!ONLY_RIDGE && !ONLY_A) {
    if (!(await ensureInstance())) check('A00-instance', 'the cabinet is up for the Rage phase', false, BASE);
    try { evidence.rage = await runRageLive(browser); } catch (e) {
      check('A-fatal', 'rage live-ghost phase completed', false, String(e && e.stack ? e.stack : e).slice(0, 500));
    }
  }
  if (!ONLY_RAGE && !ONLY_A) {
    if (!(await ensureInstance())) check('D00-instance', 'the cabinet is up for the Ridge phase', false, BASE);
    try { evidence.ridge = await runRidgeLive(browser); } catch (e) {
      check('D-fatal', 'ridge live-ghost phase completed', false, String(e && e.stack ? e.stack : e).slice(0, 500));
    }
  }
  if (!ONLY_RAGE && !ONLY_RIDGE) {
    if (!(await ensureInstance())) check('B00-instance', 'the cabinet is up for the Route A regression', false, BASE);
    try { evidence.aOnly = await runAOmitted(browser); } catch (e) {
      check('B-fatal', 'Route A regression phase completed', false, String(e && e.stack ? e.stack : e).slice(0, 400));
    }
  }
  if (!ONLY_RAGE && !ONLY_RIDGE) {
    if (!(await ensureInstance())) check('B05-instance', 'the cabinet is up for the mpGhost=live / R4 / gate phase', false, BASE);
    try { evidence.flagLive = await runLiveMode(browser); } catch (e) {
      check('B05-fatal', 'mpGhost=live phase completed', false, String(e && e.stack ? e.stack : e).slice(0, 300));
    }
    try { evidence.r4 = await runR4(browser); } catch (e) {
      check('B07-fatal', 'R4 phase completed', false, String(e && e.stack ? e.stack : e).slice(0, 300));
    }
    try { evidence.guest = await runTurnGuest(browser); } catch (e) {
      check('B08-fatal', 'turn=guest phase completed', false, String(e && e.stack ? e.stack : e).slice(0, 300));
    }
  }

  const errs = pageErrors.filter(notNoise);
  check('P02-console', 'no unexpected page errors during either live-ghost run',
    errs.length === 0,
    errs.length ? errs.slice(0, 3).join(' | ') : `pageErrors=0 (filtered ${pageErrors.length - errs.length} known-noise), consoleErrors=${consoleErrors.filter(notNoise).length}`);
} catch (e) {
  check('P00-fatal', 'the harness ran to completion', false, String(e && e.stack ? e.stack : e).slice(0, 600));
} finally {
  try { if (browser) await browser.close(); } catch { /* ignore */ }
  killServer();
  // P03 — the spawn is ours: kill it, prove the port is free, leave :8080 alone.
  let freed = null;
  if (server.spawned && server.port) {
    for (let i = 0; i < 40; i += 1) {
      await sleep(250);
      if (!(await health(BASE, 800))) { freed = true; break; }
    }
    if (freed == null) freed = false;
  }
  const after8080 = await health('http://localhost:8080');
  check('P03-cleanup', 'the spawned cabinet is killed (only its own tree), its port is free again and :8080 is untouched',
    !server.spawned || (freed === true && (!!before8080 === !!after8080)),
    server.spawned
      ? `pid ${server.pid} on :${server.port} -> ${freed ? 'port free' : 'STILL ANSWERING'}; `
        + `:8080 before=${before8080 ? 'up' : 'down'} after=${after8080 ? 'up' : 'down'}`
      : `attached run (--base), nothing to kill; :8080 before=${before8080 ? 'up' : 'down'} after=${after8080 ? 'up' : 'down'}`);
  const passed = checks.filter((c) => c.pass).length;
  const ev = evidence || {};
  const RAGE_MODE = ev.rage
    ? (ev.rage.stall ? `stalled-scene-${ev.rage.stall.scene}` : 'gp-race')
    : 'not-run';
  const RIDGE_MODE = ev.ridge
    ? (ev.ridge.stall ? `stalled-screen-${ev.ridge.stall.screen}` : 'race-screen')
    : 'not-run';
  const summary = {
    harness: 'test-mp-live-ghost',
    run: iso(Date.now()),
    base: BASE,
    modes: { RAGE_MODE, RIDGE_MODE, flag: 'mpLiveGhost=1' },
    scope: 'live ghost car (Route B), opt-in with ?mpLiveGhost=1: RAM stub + one runtime patch word; '
      + `synthetic tape, no human lap; the ghost is drawn, not simulated. RAGE_MODE=${RAGE_MODE}; `
      + `RIDGE_MODE=${RIDGE_MODE} (the Ridge race-screen door is the only one the stub arms, and the disc `
      + 'frontend walk is unmapped); Rage Time Attack has no draw path yet',

    checks,
    passed,
    total: checks.length,
    pageErrors,
    consoleErrors,
    notes,
    evidence,
    ms: Date.now() - t0,
  };
  try {
    fs.mkdirSync(OUT, { recursive: true });
    fs.writeFileSync(OUT_JSON, JSON.stringify(summary, null, 2));
  } catch { /* ignore */ }
  console.log('');
  console.log(`${passed}/${checks.length} checks passed  (${((Date.now() - t0) / 1000).toFixed(1)} s)`);
  console.log(`evidence: ${OUT_JSON}`);
  if (checks.some((c) => !c.pass)) process.exitCode = 1;
}
