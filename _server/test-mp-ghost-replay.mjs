// Route A ghost replay harness — "ghost replay (sequential)" on the real
// EmulatorJS 4.3 /play-net page, against the product code in
// `public/js/play-net.js` (window.__R4GHOST), not a private probe kit.
//
// What it proves (and what it does NOT):
//   * Ridge Racer 1994: `loadSyntheticTape({count:161})` stages a 161x40 tape in
//     a zeroed BSS run, repoints the applier pointer 0x80080434 at it and arms
//     the replay; `replayNow()` then reaches the built-in replay (screen 9, and
//     8 first when it is entered from the results screen). The LIVE CAR POSE
//     equals the staged tape record for the current playback frame on >=10
//     distinct frames (this is the proof the swapped tape is what plays), and a
//     different (peer) tape changes BOTH the applied pose and the rendered
//     frame — so the frame is the tape, not a canned replay.
//   * Rage Racer: real pad input drives the disc to scene 12 (RACE), the run the
//     game taped is captured through the product and stored as the rival seat,
//     and `replayNow()` arms the RACE frame's own finish branch
//     (g_RacePhase 0x801E6B7C = 4, lap = raceLength + 1, finish timer = 0). The
//     game counts 131 frames and calls BeginReplay + SetScene(17) itself
//     (`_runtime/ghost-research/rage-finish-probe.md`), so scene 17 is entered
//     with NO scene poke; g_SceneTimer and g_Replay.read advance, the live car
//     pose equals the taped record on >=10 frames, and a mirrored tape changes
//     the rendered frame.
//   * `mpGhost=live`, R4 with `mpGhost=ghost` and a ghost GUEST keep the old
//     path (engine off / no local gate / live).
//   * the turn gate (turn=host / turn=guest) on the real cwrap
//     `gameManager.functions.simulateInput`.
//   * IndexedDB `rr4-ghost`/`runs` survives a database reopen with the same
//     count / stride / bytes hash, both seats kept.
//
// Scope: ghost replay (sequential); Ridge and Rage verified; no live ghost car.
// There is no second car and no human lap: the tapes are synthetic (161x40 on
// Ridge, 300x28 Time Attack on Rage) and the Rage run is stopped early by the
// finish arm, not by crossing the line.
//
// Run:  cd _server; node test-mp-ghost-replay.mjs
// Opts: --port 8096  --base http://127.0.0.1:8096  --ridge  --rage  --keep
//       --timeout <ms>
// Evidence: _runtime/mp-ghost-replay.json + mp-ghost-*.png
// The harness spawns (and kills) only its own cabinet + browser tree; :8080 is
// never touched. It walks to the next free port if :8096 is already held, and
// respawns its own cabinet if another agent's cleanup kills it mid-run.
// EmulatorJS needs a visible tab, so the pages run one at a time (a hidden tab
// stops drawing and its wake-lock request is rejected).
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
const PORT_ARG = Number(arg('--port', 8096));
const BASE_ARG = arg('--base', process.env.GHOST_BASE || '');
const KEEP = argv.includes('--keep');
const ONLY_RIDGE = argv.includes('--ridge');
const ONLY_RAGE = argv.includes('--rage');
const BOOT_TIMEOUT = Number(arg('--timeout', 180000));
const STAMP = Date.now();
const OUT_JSON = path.join(OUT, 'mp-ghost-replay.json');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const iso = (t) => new Date(t).toISOString();
const hex = (n, w = 8) => (n == null || typeof n === 'boolean' ? 'null' : '0x' + (Number(n) >>> 0).toString(16).padStart(w, '0'));

// ---------------------------------------------------------------- addresses
// Ridge 1994 (SCUS-94300) and Rage Racer (SLUS-00403) —
// `_runtime/ghost-research/tape-probe.md` §1 and §2.
const RIDGE = {
  sig: '462f4120524143494e4700005254205259554b595500000052542059454c4c4f5720534f4c56414c4f550000525420424c554520534f4c56414c4f5500000000',
  sigText: /^F\/A RACI/,
  stride: 40,
  n: 161,                          // 161 * 40 = 6440 B = the applier's safe cap
  tapeDoc: 0x8006ce7c,             // documented fixed base (writes there are ignored)
  tapePtr: 0x80080434,             // the pointer the replay applier reads
  count: 0x801eb020,
  recorder: 0x801d6d18,
  screen: 0x801d6d28,
  fc: 0x80176ae4,
  dispatch: 0x8006e7bc,
  wait: 0x80131014,
  carA: 0x80080194,
  carB: 0x801fce34,
  sampler: [
    ['screen', 0x801d6d28, 'u16'], ['fc', 0x80176ae4, 'u16'],
    ['count', 0x801eb020, 'u32'], ['wait', 0x80131014, 'u32'],
    ['carX', 0x80080194 + 0x10, 'u16'], ['carZ', 0x80080194 + 0x18, 'u16'],
    ['tapePtr', 0x80080434, 'u32'],
  ],
};
const RAGE = {
  sig: '494e5345525420434f4e54524f4c4c4552000000434f4e54524f4c4c4552204552524f5200000000486f6c642074686520224e6547636f6e2220696e20616e20',
  sigText: /^INSERT C/,
  stride: 28,                      // Time Attack record
  n: 300,
  maxBytes: 43200,                 // the 0xA8C0 arena at 0x801E8804
  maxSamples: 1542,                // TA capacity (GP is 900 x 48 B)
  tape: 0x801e8804,                // BSS, accepts writes directly
  tapePtr: 0x8019c4ac,
  tapePtr2: 0x8009edac,
  count: 0x8019c874,
  write: 0x801e48b8,
  read: 0x801f30c4,
  wrapped: 0x8009e994,
  mode: 0x801e4ab4,
  scene: 0x801e3fec,
  sceneTimer: 0x801e3dc0,
  fadeLevel: 0x801e3fe8,
  fadeStep: 0x801e3fa8,
  // The finish branch inside the RACE frame (rage-finish-probe.md §2).
  racePhase: 0x801e6b7c,           // s16 = 4 arms the finish branch
  raceLength: 0x801e406c,          // s32 laps of this run (3 TA / 6 GP)
  lap: 0x8009e544,                 // s16 player lap counter
  finishTimer: 0x801e4104,         // s16 the RACE frame counts 0 -> 131 itself
  finishCount: 131,
  // Frontend cells the pad walk reads back every step (probe §1).
  feState: 0x8009eda0,             // 0 title, 1 intro anim, 2 selectable list, 3 confirmed
  feCtr: 0x801e3fa4,
  menuCursor: 0x801e3e8c,          // 0 GRAND PRIX, 2 TIME ATTACK, ...
  car: 0x8009e3dc,
  sampler: [
    ['scene', 0x801e3fec, 's32'], ['read', 0x801f30c4, 's32'],
    ['write', 0x801e48b8, 's32'], ['count', 0x8019c874, 's32'],
    ['mode', 0x801e4ab4, 's16'], ['sceneTimer', 0x801e3dc0, 's32'],
    ['carX', 0x8009e3dc, 'u16'], ['carZ', 0x8009e3dc + 8, 'u16'],
    ['phase', 0x801e6b7c, 's16'], ['lap', 0x8009e544, 's16'],
    ['fin', 0x801e4104, 's16'], ['raceLength', 0x801e406c, 's32'],
  ],
};
// RetroArch pad indices used by the probe and by the netplay client.
const PAD = { CROSS: 0, START: 3, UP: 4, DOWN: 5, CIRCLE: 8 };
// Rage scene ids: 12 = RACE (the only scene whose own finish branch enters the
// replay), 17 = REPLAY. 15/16 are NOT on that path (probe check C02b).
const RAGE_SCENE = { race: 12, replay: 17 };

const checks = [];
const pageErrors = [];
const consoleErrors = [];
const server = { spawned: false, pid: 0, logPath: '', port: null };
let browser = null;
let BASE = '';
const notes = [];

function check(id, name, pass, detail, extra) {
  const rec = { id, name, pass: !!pass, detail: detail === undefined ? '' : String(detail) };
  if (extra) Object.assign(rec, extra);
  checks.push(rec);
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${id}  ${name}  -- ${rec.detail}`);
  return rec;
}
function note(msg) { console.log(`      ${msg}`); notes.push(msg); }

// Known, harmless page noise: framework resize loops, EmulatorJS's stray
// appendChild during teardown, and the wake-lock request a headless tab makes.
const NOISE = [
  /ResizeObserver loop/i,
  /appendChild/,
  /WakeLock.*page is not visible/i,
];
const notNoise = (m) => !NOISE.some((re) => re.test(m));

async function health(base, timeoutMs = 1500) {
  try {
    const res = await fetch(`${base}/api/health`, { signal: AbortSignal.timeout(timeoutMs), cache: 'no-store' });
    if (!res.ok) return null;
    return await res.json();
  } catch { return null; }
}

async function startInstance() {
  if (BASE_ARG) {
    const st = await health(BASE_ARG);
    if (!st) throw new Error(`--base ${BASE_ARG} has no /api/health`);
    BASE = BASE_ARG.replace(/\/+$/, '');
    return { attached: true, port: Number(new URL(BASE).port || 80), ...st };
  }
  // :8096 is the documented port; walk (never 8080) if other agents already
  // hold it. The list is fixed so a rerun is deterministic.
  for (const port of [PORT_ARG, 8097, 8098, 8099, 8090, 8091, 8092, 8089]) {
    if (port === 8080) continue;
    if (await health(`http://localhost:${port}`)) continue;
    if (await spawnOn(port)) return { attached: false, port, ...(await health(BASE)) };
    throw new Error(`server on :${port} did not answer`);
  }
  throw new Error(`no free throwaway port near :${PORT_ARG}`);
}

// Spawn the cabinet on an exact port and wait for /api/health.
async function spawnOn(port) {
  BASE = `http://localhost:${port}`;
  const logPath = path.join(OUT, `mp-ghost-replay-server-${port}.log`);
  const fd = fs.openSync(logPath, 'a');
  server.logPath = logPath;
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
  server.port = port;
  for (let i = 0; i < 120; i += 1) {
    if (await health(BASE)) return true;
    await sleep(250);
  }
  return false;
}

// Other agents' harnesses kill stray cabinets; if ours dies between phases,
// bring it back on the same port instead of failing every later check.
let respawns = 0;
async function ensureInstance() {
  if (await health(BASE)) return true;
  if (!server.spawned || !server.port) return false;
  respawns += 1;
  note(`cabinet on :${server.port} stopped answering - respawning (${respawns})`);
  return spawnOn(server.port);
}

function killServer() {
  if (!server.spawned || KEEP) return;
  try { spawn('taskkill.exe', ['/T', '/F', '/PID', String(server.pid)], { windowsHide: true }); } catch { /* ignore */ }
}

async function waitFor(page, fn, timeout = 60000, step = 400) {
  const t0 = Date.now();
  for (;;) {
    let value;
    try { value = await page.evaluate(fn); } catch { value = null; }
    if (value) return value;
    if (Date.now() - t0 > timeout) return null;
    await sleep(step);
  }
}

// Same, with one argument (page.evaluate(fn, arg) inside the poll).
async function waitForArg(page, fn, arg, timeout = 60000, step = 400) {
  const t0 = Date.now();
  for (;;) {
    let value;
    try { value = await page.evaluate(fn, arg); } catch { value = null; }
    if (value) return value;
    if (Date.now() - t0 > timeout) return null;
    await sleep(step);
  }
}

// ------------------------------------------------------------ page-side kit
// Installed once per host page. Tape I/O and register access go through the
// PRODUCT's `__R4GHOST.ram` API, so a broken product API fails the harness. The
// heap scan / zero-run search is harness-side (independent of the product).
function installKit() {
  const KSEG = 0x80000000;
  const gm = () => (window.EJS_emulator && window.EJS_emulator.gameManager) || null;
  const heap = () => { const g = gm(); return (g && g.Module && g.Module.HEAPU8) || null; };
  const G = () => window.__R4GHOST;
  const kit = {
    base: 0,
    heap,
    gm,
    rd(type, addr) {
      const r = G().ram;
      if (type === 'u16') return r.rd16(addr);
      if (type === 's16') return r.rd16s(addr);
      if (type === 'u32') return r.rd32(addr);
      return r.rd32s(addr);
    },
    wr(type, addr, value) {
      const r = G().ram;
      return (type === 'u16' || type === 's16') ? r.wr16(addr, value) : r.wr32(addr, value);
    },
    read(addr, len) { const b = G().ram.read(addr, len); return b ? Array.from(b) : null; },
    write(addr, arr) { return G().ram.write(addr, new Uint8Array(arr)); },
    spanZero(addr, n) {
      const H = heap();
      if (!H) return false;
      const o = this.base + (addr - KSEG);
      if (o < 0 || o + n > H.length) return false;
      for (let i = 0; i < n; i += 1) if (H[o + i] !== 0) return false;
      return true;
    },
    findZeroRun(lo, hi, n, avoid) {
      const skip = avoid || [];
      for (let a = lo; a + n <= hi; a += 0x40) {
        let hit = false;
        for (const [addr, len] of skip) if (a <= addr && addr + len <= a + n) { hit = true; break; }
        if (hit) continue;
        if (this.spanZero(a, n)) return a;
      }
      return null;
    },
    findBase(sigHex) {
      const H = heap();
      if (!H) return { hits: 0, cands: [] };
      const sig = new Uint8Array(sigHex.length / 2);
      for (let i = 0; i < sig.length; i += 1) sig[i] = parseInt(sigHex.substr(i * 2, 2), 16);
      const hits = [];
      let i = H.indexOf(sig[0]);
      while (i >= 0 && i + sig.length <= H.length && hits.length < 8) {
        let ok = true;
        for (let j = 1; j < sig.length; j += 1) if (H[i + j] !== sig[j]) { ok = false; break; }
        if (ok) hits.push(i);
        i = H.indexOf(sig[0], i + 1);
      }
      const cands = hits.map((x) => x - 0x10000).filter((b) => b >= 0 && b + 0x200000 <= H.length);
      return { hits: hits.length, cands, heap: H.length };
    },
    text(addr, n) {
      const b = this.read(addr, n) || [];
      return String.fromCharCode(...b).replace(/[^\x20-\x7e]/g, '.');
    },
    frame() { const g = gm(); return g && typeof g.getFrameNum === 'function' ? g.getFrameNum() : null; },
    // Real pad input through the cwrap the netplay client applies input with
    // (the product's ghost turn gate wraps this same function).
    pad(player, index, value) {
      const g = gm();
      if (!g || !g.functions || typeof g.functions.simulateInput !== 'function') return false;
      g.functions.simulateInput(player, index, value);
      return true;
    },
    async tap(player, index, hold, settleMs) {
      this.pad(player, index, 1);
      await new Promise((r) => setTimeout(r, hold));
      this.pad(player, index, 0);
      await new Promise((r) => setTimeout(r, settleMs));
      return true;
    },
    startSampler(fields) {
      const g = gm();
      if (!g || typeof g.getFrameNum !== 'function') return null;
      const rec = { last: g.getFrameNum(), samples: [], t0: performance.now(), cap: 12000 };
      this.S = rec;
      const tick = () => {
        if (this.S !== rec) return;
        const n = g.getFrameNum();
        while (rec.last < n) {
          rec.last += 1;
          const s = { f: rec.last, t: +(performance.now() - rec.t0).toFixed(1) };
          for (const [name, addr, type] of fields) s[name] = this.rd(type, addr);
          if (rec.samples.length < rec.cap) rec.samples.push(s);
        }
        requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
      return { frame0: rec.last };
    },
    samples(from) { return this.S ? this.S.samples.slice(from || 0) : []; },
    sampleCount() { return this.S ? this.S.samples.length : 0; },
    hashHex(arr) {
      // FNV-1a 32 bit over the tape bytes; enough to compare two copies.
      let h = 0x811c9dc5;
      for (let i = 0; i < arr.length; i += 1) { h ^= arr[i]; h = Math.imul(h, 0x01000193) >>> 0; }
      return 'fnv1a:' + h.toString(16).padStart(8, '0');
    },
  };
  window.__GR = kit;
  return { ok: true, hasGhost: !!G(), hasHeap: !!heap() };
}

// ------------------------------------------------------------ canvas metrics
// WebGL readback is black with preserveDrawingBuffer off, so clip the composited
// screenshot of the canvas and decode it to 64x48 (as tape-probe/test-mp-race-e2e).
async function canvasMetrics(page) {
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
  return page.evaluate(async (dataUrl, cw, chh) => {
    const img = new Image();
    img.src = dataUrl;
    try { await img.decode(); } catch { return { ok: false, reason: 'decode failed' }; }
    const c = document.createElement('canvas');
    c.width = 64; c.height = 48;
    const ctx = c.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(img, 0, 0, 64, 48);
    const d = ctx.getImageData(0, 0, 64, 48).data;
    let n = 0; let nonBlack = 0; let lumSum = 0;
    const row = [];
    for (let i = 0; i < d.length; i += 4) {
      const r = d[i]; const g = d[i + 1]; const b = d[i + 2];
      n += 1;
      const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
      lumSum += lum;
      if (lum > 24) nonBlack += 1;
      if (i % 64 === 0) row.push(Math.round(lum));
    }
    return {
      ok: true,
      canvas: { w: cw, h: chh },
      nonBlackPct: +((100 * nonBlack) / n).toFixed(1),
      meanLum: +(lumSum / n).toFixed(1),
      lumaRow: row,
    };
  }, 'data:image/png;base64,' + b64, Math.round(width), Math.round(height));
}
function metricDelta(a, b) {
  if (!a || !b || !a.ok || !b.ok) return null;
  const ra = a.lumaRow || []; const rb = b.lumaRow || [];
  const n = Math.min(ra.length, rb.length);
  let sum = 0; let big = 0;
  for (let i = 0; i < n; i += 1) { const d = Math.abs(ra[i] - rb[i]); sum += d; if (d > 16) big += 1; }
  return {
    meanAbsLumDiff: +(sum / Math.max(1, n)).toFixed(1),
    changedRowsPct: +((100 * big) / Math.max(1, n)).toFixed(1),
    nonBlackDelta: +(b.nonBlackPct - a.nonBlackPct).toFixed(1),
    meanLumDelta: +(b.meanLum - a.meanLum).toFixed(1),
  };
}

// ------------------------------------------------------------- tape readback
// Ridge 40 B record: +0x00 x, +0x02 y, +0x04 z, +0x06 h, +0x08 pitch, +0x0A yaw,
// +0x0C roll, +0x0E extra, +0x10..+0x1E the same 8 for car B, +0x20 modelA,
// +0x24 modelB (`tape-probe.md` §1, record writer 0x8002A78C).
function ridgeRecordAt(buf, i) {
  const o = i * 40;
  return { x: buf.readUInt16LE(o), z: buf.readUInt16LE(o + 4), at: o };
}
// Rage TA 28 B record: +0x00 x, +0x04 z (`tape-probe.md` §2).
function rageRecordAt(buf, i) {
  const o = i * 28;
  return { x: buf.readUInt16LE(o), z: buf.readUInt16LE(o + 4), at: o };
}
const nearU16 = (a, b, tol = 1) => Math.abs((((a | 0) - (b | 0)) << 16) >> 16) <= tol;

// Poll the canvas until it shows a played-in replay frame (past the REPLAY
// title card): screen 9, non-black > 25 %, mean luma > 15. Returns the metrics
// plus the screen/frame at that moment.
async function waitRaceLike(page, timeout = 5000, maxFc = 150) {
  const t0 = Date.now();
  let last = null;
  for (;;) {
    const metrics = await canvasMetrics(page);
    const ids = await page.evaluate(() => ({ screen: window.__R4GHOST.ram.rd16(0x801d6d28), fc: window.__R4GHOST.ram.rd16(0x80176ae4) }));
    last = { metrics, ...ids };
    if (metrics && metrics.ok && metrics.nonBlackPct > 25 && metrics.meanLum > 15
      && ids.screen === 9 && ids.fc <= maxFc) return last;
    if (Date.now() - t0 > timeout) return last;
    await sleep(120);
  }
}

// --------------------------------------------------------------- Ridge (host)
async function runRidgeHost() {
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 800 });
  const localErrors = [];
  page.on('pageerror', (e) => {
    const msg = String(e && e.message ? e.message : e);
    localErrors.push(msg);
    pageErrors.push(`ridge-host: ${msg}`);
  });
  page.on('console', (m) => {
    if (m.type() === 'error') consoleErrors.push(`ridge-host: ${String(m.text()).slice(0, 300)}`);
  });
  const room = 'GHST';
  const url = `${BASE}/play-net?game=ridge&threads=0&cache=0&bios=hle`
    + `&mpRole=host&mpRoom=${room}&mpRace=ghost-${STAMP}&mpGhost=ghost&mpTurn=host`
    + '&mpTrackIndex=0&mpCarHost=0&mpCarGuest=1';
  const out = { url, room };
  console.log(`\n=== ridge host :: ${url}`);

  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 90000 });
  const booted = await waitFor(page, () => !!(
    window.__R4 && window.__R4.startedAt
    && window.EJS_emulator && window.EJS_emulator.gameManager
    && window.EJS_emulator.gameManager.Module
    && window.EJS_emulator.gameManager.Module.HEAPU8
  ), BOOT_TIMEOUT, 400);
  check('R01-boot', 'ridge boots on /play-net with mpGhost=ghost&mpTurn=host', !!booted,
    booted ? `boot ${await page.evaluate(() => window.__R4.bootMs)} ms, page errors so far ${localErrors.length}`
      : `no core in ${(BOOT_TIMEOUT / 1000) | 0} s`);
  if (!booted) { await page.close(); return out; }

  // 1. product surface
  const surf = await page.evaluate(() => {
    const g = window.__R4GHOST;
    const panel = document.querySelector('#npGhost');
    const btn = document.querySelector('#npGhostReplay');
    return {
      enabled: !!(g && g.enabled),
      game: g && g.game,
      turn: g && g.turn,
      role: g && g.role,
      peerSeat: g && g.peerSeat,
      label: g && g.label,
      route: g && g.route,
      drive: window.__R4MP && window.__R4MP.drive,
      mpTurn: window.__R4MP && window.__R4MP.turn,
      triggerProved: g && typeof g.triggerProved === 'function' ? g.triggerProved() : null,
      swapSource: g && typeof g.swapSource === 'function' ? !!g.swapSource() : null,
      panelHidden: panel ? panel.hidden : null,
      replayHidden: btn ? btn.hidden : null,
      replayDisabled: btn ? btn.disabled : null,
      replayText: btn ? btn.textContent : null,
      status: (document.querySelector('#npGhostStatus') || {}).textContent || '',
      api: !!g && ['captureNow', 'replayNow', 'reload', 'ram', 'loadSyntheticTape', 'ramMap'].every((k) => !!g[k]),
      map: g && g.ramMap ? {
        tapePtr: g.ramMap.ridge.tapePtr, count: g.ramMap.ridge.count, screen: g.ramMap.ridge.screen,
        maxCount: g.ramMap.ridge.maxCount, stride: g.ramMap.ridge.stride,
      } : null,
    };
  });
  out.surface = surf;
  check('R02-surface', '__R4GHOST is enabled for ridge/ghost/turn=host and exposes the engine API',
    surf.enabled && surf.game === 'ridge' && surf.turn === 'host' && surf.role === 'host'
      && surf.label === 'ghost replay (sequential)' && surf.drive === 'ghost' && surf.mpTurn === 'host'
      && surf.panelHidden === false && surf.api
      && surf.map && surf.map.tapePtr === RIDGE.tapePtr && surf.map.count === RIDGE.count
      && surf.map.screen === RIDGE.screen && surf.map.maxCount === 161 && surf.map.stride === 40,
    `enabled=${surf.enabled} game=${surf.game} turn=${surf.turn} drive=${surf.drive} label="${surf.label}" `
    + `panelHidden=${surf.panelHidden} ramMap=${JSON.stringify(surf.map)} status="${surf.status}"`);

  // 2. the PSX window is found the same way the product finds it
  await page.evaluate(installKit);
  const scan = await page.evaluate((sig) => window.__GR.findBase(sig), RIDGE.sig);
  await waitFor(page, () => !!(window.__R4GHOST && window.__R4GHOST.ramBase), 30000, 400);
  const ramBase = await page.evaluate(() => window.__R4GHOST.ramBase);
  const ramText = await page.evaluate((addr) => window.__GR.text(addr, 16), 0x80010000);
  await page.evaluate((b) => { window.__GR.base = b; }, ramBase);
  check('R03-ram', 'the PSX window is found (one exe-signature hit) and 0x80010000 is the Ridge exe text',
    Number.isFinite(ramBase) && ramBase > 0 && scan.hits === 1 && scan.cands[0] === ramBase && RIDGE.sigText.test(ramText),
    `ramBase=${hex(ramBase)} scanHits=${scan.hits} text="${ramText}" heap=${(scan.heap / 1048576) | 0}MiB`);

  // 3. settle: the disc must be drawing before a tape poke (probe: a poke
  //    before the frontend is up stalls the screen machine).
  const settle = { probes: [] };
  for (let i = 0; i < 45; i += 1) {
    const m = await canvasMetrics(page);
    const ids = await page.evaluate(() => ({
      screen: window.__R4GHOST.ram.rd16(0x801d6d28),
      screenSeen: !!window.__R4GHOST.screenSeen,
      wait: window.__R4GHOST.ram.rd32(0x80131014),
    }));
    settle.probes.push({ i, nonBlackPct: m && m.nonBlackPct, meanLum: m && m.meanLum, ...ids });
    if (m && m.ok && m.nonBlackPct > 20 && ids.screen !== 0) { settle.at = { ...ids, nonBlackPct: m.nonBlackPct, meanLum: m.meanLum }; break; }
    await sleep(800);
  }
  const beforeShot = path.join(OUT, 'mp-ghost-ridge-before.png');
  await page.screenshot({ path: beforeShot });
  const beforeMetrics = await canvasMetrics(page);
  out.settle = { at: settle.at, probes: settle.probes.length, file: beforeShot };
  out.beforeMetrics = beforeMetrics;
  check('R04-drawn', 'ridge is drawing (screen id seen) before the tape work starts',
    !!settle.at && settle.at.screen !== 0,
    settle.at ? `screen=${settle.at.screen} wait=${settle.at.wait} nonBlackPct=${settle.at.nonBlackPct} meanLum=${settle.at.meanLum}`
      : `no drawn frame in ${settle.probes.length} probes`);

  // 4. install the 1:1 frame sampler BEFORE staging: the product may enter the
  //    replay on its own tick the moment a tape exists at the results screen.
  const sampler = await page.evaluate((fields) => window.__GR.startSampler(fields), RIDGE.sampler);
  note(`ridge sampler installed at core frame ${sampler && sampler.frame0}`);

  // 5. stage the 161x40 synthetic tape through the PRODUCT
  const markStage = await page.evaluate(() => window.__GR.sampleCount());
  const stage = await page.evaluate(() => {
    const g = window.__R4GHOST;
    const before = {
      ptr: g.ram.rd32(0x80080434), count: g.ram.rd32(0x801eb020),
      screen: g.ram.rd16(0x801d6d28), recorder: g.ram.rd32(0x801d6d18),
    };
    const returned = g.loadSyntheticTape({ count: 161 });
    const t = g.syntheticTape;
    const ptr = g.ram.rd32(0x80080434);
    const back = t ? Array.from(g.ram.read(ptr, t.bytes.length)) : null;
    let diff = 0;
    if (t && back) for (let i = 0; i < t.bytes.length; i += 1) if (back[i] !== t.bytes[i]) diff += 1;
    return {
      returned, before, ptr, count: g.ram.rd32(0x801eb020),
      tape: t ? { count: t.count, stride: t.stride, len: t.bytes.length, game: t.game, seat: t.seat } : null,
      stageAddr: g.tapeBase, staging: g.staging ? { ...g.staging } : null,
      diff, bytes: back, meta: g.synthetic ? { ...g.synthetic } : null,
      frame: window.__GR.frame(),
      recorder: g.ram.rd32(0x801d6d18),
      status: (document.querySelector('#npGhostStatus') || {}).textContent || '',
    };
  });
  out.stage = { ...stage, bytes: undefined };
  const stageAddrOk = stage.ptr === stage.stageAddr && stage.ptr >= 0x801e0000 && stage.ptr < 0x801f0000;
  check('R05-stage', 'loadSyntheticTape(161) writes a 161x40 tape into a zeroed BSS run, read-back byte-exact, 0x80080434 repointed at it',
    stage.returned === 6440 && !!stage.tape && stage.tape.count === 161 && stage.tape.stride === 40
      && stage.tape.len === 6440 && stage.diff === 0 && stageAddrOk && stage.count === 161
      && !!stage.staging && stage.staging.found === true && stage.recorder !== 1,
    `returned=${stage.returned} tape=${JSON.stringify(stage.tape)} staging=${JSON.stringify(stage.staging)} `
    + `ptr=${hex(stage.ptr)} (was ${hex(stage.before.ptr)}) count=${stage.count} diff=${stage.diff}/6440 recorder=${stage.recorder}`);

  // 6. the product's replayNow(): swap + arm + replay
  const replayNow = await page.evaluate(() => {
    const g = window.__R4GHOST;
    const pre = { screen: g.ram.rd16(0x801d6d28), fc: g.ram.rd16(0x80176ae4) };
    const t0 = performance.now();
    let ok = null; let err = null;
    try { ok = g.replayNow(); } catch (e) { err = String(e && e.message ? e.message : e); }
    return {
      ok, err, pre, ms: +(performance.now() - t0).toFixed(1),
      swapped: g.swapped, state: g.state, arm: g.arm ? { ...g.arm, writes: (g.arm.writes || []).length } : null,
      replayedSource: g.replayedSource, lastError: g.lastError,
      count: g.ram.rd32(0x801eb020), ptr: g.ram.rd32(0x80080434),
      status: (document.querySelector('#npGhostStatus') || {}).textContent || '',
      log: (window.__R4NET_LOGS || []).filter((l) => /GHOST \/\//.test(l)).slice(-5),
    };
  });
  out.replayNow = replayNow;

  const entry = await waitForArg(page, (mark) => {
    const s = window.__GR.samples(mark);
    const i9 = s.findIndex((x) => x.screen === 9);
    if (i9 < 0) return null;
    const i8 = s.findIndex((x, i) => x.screen === 8 && i < i9);
    return {
      seen9: true, seen8: i8 >= 0, at8: i8 >= 0 ? s[i8].t : null, at9: s[i9].t,
      ids: [...new Set(s.map((x) => x.screen))],
    };
  }, markStage, 10000, 150);
  const entryState = await page.evaluate(() => {
    const g = window.__R4GHOST;
    return {
      screen: g.ram.rd16(0x801d6d28), fc: g.ram.rd16(0x80176ae4),
      ghostScreen: g.screen, ghostState: g.state, captured: g.captured, swapped: g.swapped,
    };
  });
  const mode = replayNow.arm && replayNow.arm.mode ? replayNow.arm.mode : null;
  out.entry = { entry, entryState, mode };
  check('R06-replay-entered', 'replayNow() reaches the built-in replay (screen 9; 8 first from the results screen) within 10 s',
    replayNow.ok === true && !!entry && entry.seen9 && (mode !== 'results' || entry.seen8),
    `mode=${mode} preScreen=${replayNow.pre.screen} seen8=${!!(entry && entry.seen8)} at8=${entry && entry.at8}ms `
    + `seen9=${!!(entry && entry.seen9)} at9=${entry && entry.at9}ms screens=${JSON.stringify(entry && entry.ids)} `
    + `ghost.screen=${entryState.ghostScreen} ghost.state=${entryState.ghostState} arm=${JSON.stringify(replayNow.arm)}`);

  // wait for a played-in playback frame, then capture the evidence frame
  const playA = await waitForArg(page, (mark) => {
    const s = window.__GR.samples(mark);
    const rows = s.filter((x) => x.screen === 9 && x.fc >= 20 && x.fc < 150);
    return rows.length ? { fc: rows[rows.length - 1].fc, t: rows[rows.length - 1].t, rows: rows.length } : null;
  }, markStage, 12000, 100);
  const frameA = await waitRaceLike(page, 5000);
  const replayShot = path.join(OUT, 'mp-ghost-ridge-replay.png');
  await page.screenshot({ path: replayShot });
  const replayMetrics = frameA.metrics;
  const atShotA = { screen: frameA.screen, fc: frameA.fc };
  const frontendDelta = metricDelta(beforeMetrics, replayMetrics);
  out.replay = { shot: replayShot, metrics: replayMetrics, before: beforeMetrics, delta: frontendDelta, playA, atShot: atShotA };
  check('R07-replay-frame', 'the replay renders a race-like frame (not black, not the frontend) and the screenshot is written',
    !!playA && !!replayMetrics && replayMetrics.ok && atShotA.screen === 9
      && replayMetrics.nonBlackPct > 25 && replayMetrics.meanLum > 15
      && !!frontendDelta && (frontendDelta.meanAbsLumDiff >= 4 || frontendDelta.changedRowsPct >= 10),
    `fc=${playA && playA.fc} (screenshot at screen ${atShotA.screen} fc ${atShotA.fc}) `
    + `replay=${replayMetrics && `${replayMetrics.nonBlackPct}% nonBlack / ${replayMetrics.meanLum} lum`} `
    + `frontend=${beforeMetrics && `${beforeMetrics.nonBlackPct}% / ${beforeMetrics.meanLum}`} `
    + `delta=${JSON.stringify(frontendDelta)} file=${path.basename(replayShot)}`);

  // 7. pose == staged tape record (the proof the swapped tape is what plays)
  const tapeARead = await page.evaluate(() => {
    const g = window.__R4GHOST;
    const ptr = g.ram.rd32(0x80080434);
    return { ptr, bytes: Array.from(g.ram.read(ptr, 161 * 40)) };
  });
  const tapeA = Buffer.from(tapeARead.bytes);
  const samplesA = await page.evaluate((mark) => window.__GR.samples(mark), markStage);
  const rowsA = [];
  for (const s of samplesA) {
    if (s.screen !== 9) continue;
    if (stage.frame != null && s.f <= stage.frame) continue;   // only frames after the tape was staged
    const i = s.fc | 0;
    if (i < 0 || i >= RIDGE.n) continue;
    const rec = ridgeRecordAt(tapeA, i);
    rowsA.push({ i, f: s.f, carX: s.carX, carZ: s.carZ, tx: rec.x, tz: rec.z });
  }
  const matchA = rowsA.filter((r) => nearU16(r.carX, r.tx) && nearU16(r.carZ, r.tz));
  const exactA = rowsA.filter((r) => r.carX === r.tx && r.carZ === r.tz);
  const distinctA = new Set(matchA.map((r) => r.i)).size;
  const missA = rowsA.filter((r) => !nearU16(r.carX, r.tx) || !nearU16(r.carZ, r.tz));
  out.poseTapeA = { ptr: tapeARead.ptr, rows: rowsA.length, match: matchA.length, exact: exactA.length, distinct: distinctA, miss: missA.slice(0, 4), first: rowsA.slice(0, 4) };
  check('R08-pose-from-tape', 'the live car pose equals the staged tape record for the playback frame on >=10 distinct frames',
    rowsA.length >= 10 && matchA.length >= 10 && distinctA >= 10 && missA.length / rowsA.length <= 0.1,
    `${matchA.length}/${rowsA.length} samples within tolerance 1 (${exactA.length} exact), ${distinctA} distinct playback frames `
    + `(mismatches ${missA.length}${missA.length ? ': ' + JSON.stringify(missA.slice(0, 2)) : ''}), tape@${hex(tapeARead.ptr)}; `
    + `first=${JSON.stringify(rowsA.slice(0, 3))}`);

  // 8. a DIFFERENT tape (the stored peer tape) must change the pose AND the
  //    frame: swap it in through the product and re-enter playback. Let the
  //    tape-A playback finish first when it can, so the poke starts a new run.
  let aEnd = null;
  {
    const t0a = Date.now();
    for (;;) {
      const v = await page.evaluate(() => ({ screen: window.__R4GHOST.ram.rd16(0x801d6d28), fc: window.__R4GHOST.ram.rd16(0x80176ae4) }));
      if (v.screen !== 9) { aEnd = v; break; }
      if (Date.now() - t0a > 9000) break;
      await sleep(100);
    }
  }
  out.replayAEnd = aEnd;
  const key = `${room}:ridge`;
  const peerTape = Buffer.alloc(RIDGE.n * 40);
  // A mirrored ramp of the staged tape: same record layout, reversed x/z/yaw.
  for (let i = 0; i < RIDGE.n; i += 1) {
    const src = i * 40; const dst = i * 40;
    const xs = tapeA.readUInt16LE(src); const zs = tapeA.readUInt16LE(src + 4); const ys = tapeA.readUInt16LE(src + 10);
    const mirror = (v) => (-v) & 0xffff;
    peerTape.writeUInt16LE(mirror(xs), dst);
    peerTape.writeUInt16LE(mirror(zs), dst + 4);
    peerTape.writeUInt16LE(mirror(ys), dst + 10);
    // the remaining fields keep their own values so the records stay distinct
    for (let k = 2; k < 40; k += 2) {
      if (k === 4 || k === 10) continue;
      peerTape.writeUInt16LE(tapeA.readUInt16LE(src + k) ^ 0x0101, dst + k);
    }
  }
  for (let i = 0; i < RIDGE.n; i += 1) peerTape.writeUInt16LE((0x0400 + i * 7) & 0xffff, i * 40 + 4);
  const peer = await page.evaluate(async ({ keyStr, tape }) => {
    const open = () => new Promise((res, rej) => {
      const req = indexedDB.open('rr4-ghost', 1);
      req.onupgradeneeded = () => { if (!req.result.objectStoreNames.contains('runs')) req.result.createObjectStore('runs'); };
      req.onsuccess = () => res(req.result);
      req.onerror = () => rej(req.error);
    });
    const db = await open();
    const family = await new Promise((res) => {
      const tx = db.transaction('runs', 'readonly');
      const q = tx.objectStore('runs').get(keyStr);
      q.onsuccess = () => res(q.result || {});
      q.onerror = () => res({});
    });
    family.guest = {
      room: keyStr.split(':')[0], game: 'ridge', mode: 0, stride: 40, count: 161,
      bytes: new Uint8Array(tape), seat: 'guest', turn: 'guest', at: Date.now(), trackIndex: 0,
    };
    await new Promise((res) => {
      const tx = db.transaction('runs', 'readwrite');
      tx.objectStore('runs').put(family, keyStr);
      tx.oncomplete = () => res();
      tx.onerror = () => res();
    });
    db.close();
    await window.__R4GHOST.reload();
    return window.__R4GHOST.peer ? { ...window.__R4GHOST.peer } : null;
  }, { keyStr: key, tape: Array.from(peerTape) });
  const markB = await page.evaluate(() => window.__GR.sampleCount());
  const swapB = await page.evaluate(() => {
    const g = window.__R4GHOST;
    const ok = g.replayNow();
    const ptr = g.ram.rd32(0x80080434);
    return {
      ok, ptr, count: g.ram.rd32(0x801eb020), swapped: g.swapped, state: g.state,
      arm: g.arm ? g.arm.mode : null, replayedSource: g.replayedSource,
      frame: window.__GR.frame(),
      bytes: Array.from(g.ram.read(ptr, 161 * 40)),
      status: (document.querySelector('#npGhostStatus') || {}).textContent || '',
      log: (window.__R4NET_LOGS || []).filter((l) => /GHOST \/\//.test(l)).slice(-3),
    };
  });
  const markSwap = await page.evaluate(() => window.__GR.sampleCount());
  let swapBDiff = 0;
  for (let i = 0; i < peerTape.length; i += 1) if (swapB.bytes[i] !== peerTape[i]) swapBDiff += 1;
  // The fresh peer playback starts at the fc reset (0xFFFF -> 0 / re-entry to 9):
  // without this the tail of the tape-A run would be counted as tape B.
  const resetB = await waitForArg(page, (mark) => {
    const s = window.__GR.samples(mark);
    for (let i = 1; i < s.length; i += 1) {
      if (s[i].screen === 9 && (s[i].fc < s[i - 1].fc || s[i - 1].screen !== 9)) {
        return { i, f: s[i].f, fc: s[i].fc, from: s[i - 1].screen };
      }
    }
    return null;
  }, markSwap, 9000, 80);
  const resetMark = resetB ? markSwap + resetB.i : markSwap;
  const playB = await waitForArg(page, (mark) => {
    const s = window.__GR.samples(mark);
    const rows = s.filter((x) => x.screen === 9 && x.fc >= 20 && x.fc < 150);
    return rows.length ? { fc: rows[rows.length - 1].fc } : null;
  }, resetMark, 12000, 80);
  const frameB = await waitRaceLike(page, 6000);
  const mirrorShot = path.join(OUT, 'mp-ghost-ridge-replay-b.png');
  await page.screenshot({ path: mirrorShot });
  const atShotB = { screen: frameB.screen, fc: frameB.fc };
  const mirrorMetrics = frameB.metrics;
  const mirrorDelta = metricDelta(replayMetrics, mirrorMetrics);
  const samplesB = await page.evaluate((mark) => window.__GR.samples(mark), markB);
  const rowsB = [];
  for (const s of samplesB) {
    if (s.screen !== 9) continue;
    if (swapB.frame != null && s.f <= swapB.frame) continue;    // only frames after the peer swap
    if (resetB && s.f < resetB.f) continue;                     // only the fresh peer playback
    const i = s.fc | 0;
    if (i < 0 || i >= RIDGE.n) continue;
    const rec = ridgeRecordAt(peerTape, i);
    rowsB.push({ i, carX: s.carX, carZ: s.carZ, tx: rec.x, tz: rec.z });
  }
  const matchB = rowsB.filter((r) => nearU16(r.carX, r.tx) && nearU16(r.carZ, r.tz));
  const distinctB = new Set(matchB.map((r) => r.i)).size;
  const missB = rowsB.filter((r) => !nearU16(r.carX, r.tx) || !nearU16(r.carZ, r.tz));
  out.peerSwap = { peer, swapB: { ...swapB, bytes: undefined }, swapBDiff, resetB, playB, rows: rowsB.length, match: matchB.length, distinct: distinctB, miss: missB.slice(0, 4), first: rowsB.slice(0, 3) };
  out.mirror = { metrics: mirrorMetrics, delta: mirrorDelta, file: mirrorShot, atShot: atShotB };
  check('R09-peer-tape', 'a different stored tape is what plays: byte-exact at the applier pointer, pose follows it, rendered frame changes',
    !!peer && peer.seat === 'guest' && peer.count === 161 && peer.bytes === 6440
      && swapB.ok === true && swapBDiff === 0 && swapB.count === 161
      && rowsB.length >= 10 && matchB.length >= 10 && distinctB >= 10 && missB.length / rowsB.length <= 0.1
      && atShotB.screen === 9
      && !!mirrorDelta && (mirrorDelta.meanAbsLumDiff >= 4 || mirrorDelta.changedRowsPct >= 10),
    `peer=${JSON.stringify(peer)} bytes@${hex(swapB.ptr)}=peer(diff=${swapBDiff}/6440) count=${swapB.count} `
    + `reset=${JSON.stringify(resetB)} pose=${matchB.length}/${rowsB.length} (${distinctB} frames, mismatches ${missB.length}) `
    + `fc=${playB && playB.fc} screenshot at screen ${atShotB.screen} fc ${atShotB.fc} `
    + `frame delta=${JSON.stringify(mirrorDelta)} file=${path.basename(mirrorShot)}`);

  const countAfter = await page.evaluate(() => window.__R4GHOST.ram.rd32(0x801eb020));
  check('R10-count', 'the replay never rewrites the tape length', countAfter === 161,
    `0x801eb020=${countAfter} (staged 161)`);

  // 9. turn gate (turn=host): player 1 is dropped, player 0 passes
  const gateWait = await waitFor(page, () => (window.__R4GHOST && window.__R4GHOST.gateInstalled) || null, 30000, 400);
  const gate = await page.evaluate(() => {
    const g = window.__R4GHOST;
    const f = window.EJS_emulator.gameManager.functions;
    if (!f || typeof f.simulateInput !== 'function') return { ok: false };
    const g0 = g.gatedInputs; const r0 = g.remappedInputs;
    f.simulateInput(1, 3, 1); f.simulateInput(1, 3, 0);      // guest pad: dropped
    const gated = g.gatedInputs - g0;
    f.simulateInput(0, 0, 0);                                 // host pad: passes
    return {
      ok: true, gated, gatedAfterHost: g.gatedInputs - g0, remapped: g.remappedInputs - r0,
      wrapped: !!f.__rr4GhostWrapped, installed: g.gateInstalled,
    };
  });
  check('R11-gate-host', 'turn=host: a player-1 press is dropped and a player-0 press passes',
    !!gateWait && gate.ok && gate.wrapped && gate.gated === 2 && gate.gatedAfterHost === 2 && gate.remapped === 0,
    `installed=${gate.installed} wrapped=${gate.wrapped} gated(p1)=${gate.gated} gatedAfterP0=${gate.gatedAfterHost} remapped=${gate.remapped}`);

  // 10. IndexedDB round-trip: product captureNow() -> reopen the DB -> same
  //     count / stride / bytes hash, and the guest seat is still there.
  const idb = await page.evaluate(async (keyStr) => {
    const g = window.__R4GHOST;
    const ptr = g.ram.rd32(0x80080434);
    g.ram.wr32(0x801eb020, 161);
    const expected = Array.from(g.ram.read(ptr, 161 * 40));
    const captured = g.captureNow();
    const openDb = () => new Promise((res, rej) => {
      const req = indexedDB.open('rr4-ghost', 1);
      req.onupgradeneeded = () => { if (!req.result.objectStoreNames.contains('runs')) req.result.createObjectStore('runs'); };
      req.onsuccess = () => res(req.result);
      req.onerror = () => rej(req.error);
    });
    const readFamily = (db) => new Promise((res) => {
      const tx = db.transaction('runs', 'readonly');
      const q = tx.objectStore('runs').get(keyStr);
      q.onsuccess = () => res(q.result || null);
      q.onerror = () => res(null);
    });
    const db1 = await openDb();
    let family = null;
    for (let i = 0; i < 25 && !(family && family.host); i += 1) {
      family = await readFamily(db1);
      if (!(family && family.host)) await new Promise((r) => setTimeout(r, 100));
    }
    db1.close();
    const db2 = await openDb();                  // a genuine database reopen
    const reopened = await readFamily(db2);
    db2.close();
    const host = reopened && reopened.host ? reopened.host : null;
    const hostBytes = host ? Array.from(host.bytes) : null;
    const reloaded = await g.reload();
    return {
      captured, ptr, mode: g.storage.mode, storageKey: g.storage.key,
      seats: reopened ? Object.keys(reopened) : [],
      host: host ? { count: host.count, stride: host.stride, len: host.bytes.length, seat: host.seat, game: host.game } : null,
      hashStored: hostBytes ? window.__GR.hashHex(hostBytes) : null,
      hashExpected: window.__GR.hashHex(expected),
      byteEqual: !!hostBytes && hostBytes.length === expected.length && hostBytes.every((v, i) => v === expected[i]),
      guestStill: !!(reopened && reopened.guest),
      tapeMeta: g.tape ? { ...g.tape } : null,
      reloadedHost: reloaded && reloaded.host ? { count: reloaded.host.count, stride: reloaded.host.stride, len: reloaded.host.bytes.length } : null,
    };
  }, key);
  out.idb = idb;
  check('R12-idb', 'IndexedDB round-trip after a database reopen: same count/stride/bytes hash, both seats kept',
    idb.captured === true && idb.mode === 'indexeddb' && !!idb.host
      && idb.host.count === 161 && idb.host.stride === 40 && idb.host.len === 6440
      && idb.byteEqual && idb.hashStored === idb.hashExpected
      && idb.guestStill && !!idb.reloadedHost,
    `captured=${idb.captured} ptr=${hex(idb.ptr)} mode=${idb.mode} key=${idb.storageKey} host=${JSON.stringify(idb.host)} `
    + `hash=${idb.hashStored}/${idb.hashExpected} byteEqual=${idb.byteEqual} seats=${JSON.stringify(idb.seats)} `
    + `guestKept=${idb.guestStill} reloaded=${JSON.stringify(idb.reloadedHost)}`);

  const noise = localErrors.filter(notNoise);
  check('R13-errors', 'no uncaught page errors on the ridge ghost page', noise.length === 0,
    noise.length ? noise.slice(0, 3).join(' | ') : 'clean');
  out.errors = localErrors;
  await page.close();
  return out;
}

// --------------------------------------------------------------- Rage (host)
// Route A on Rage Racer is the game's own post-race replay. There is no usable
// frontend "show the replay" poke: the supported door is the finish branch
// inside the RACE frame (scene 12), which needs
//   g_RacePhase 0x801E6B7C == 4  AND  lap 0x8009E544 == 0x801E406C + 1
// and then counts the finish timer 0x801E4104 to 131 itself before calling
// BeginReplay + SetScene(17) (`_runtime/ghost-research/rage-finish-probe.md`,
// 21/21). This run proves the whole product path: real pad input to scene 12,
// the run the game taped, `replayNow()` arming the branch, scene 17 entered by
// the game, the tape driving the pose, and a mirrored tape changing the frame.
async function runRageHost() {
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 800 });
  const localErrors = [];
  page.on('pageerror', (e) => {
    const msg = String(e && e.message ? e.message : e);
    localErrors.push(msg);
    pageErrors.push(`rage-host: ${msg}`);
  });
  page.on('console', (m) => {
    if (m.type() === 'error') consoleErrors.push(`rage-host: ${String(m.text()).slice(0, 300)}`);
  });
  const room = 'GHSR';
  const url = `${BASE}/play-net?game=rage&threads=0&cache=0&bios=hle`
    + `&mpRole=host&mpRoom=${room}&mpRace=ghostr-${STAMP}&mpGhost=ghost&mpTurn=host`
    + '&mpTrackIndex=0&mpCarHost=0&mpCarGuest=1';
  const out = { url, room };
  console.log(`\n=== rage host :: ${url}`);
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 90000 });
  const booted = await waitFor(page, () => !!(
    window.__R4 && window.__R4.startedAt
    && window.EJS_emulator && window.EJS_emulator.gameManager
    && window.EJS_emulator.gameManager.Module
    && window.EJS_emulator.gameManager.Module.HEAPU8
  ), BOOT_TIMEOUT, 400);
  const surf = await page.evaluate(() => {
    const g = window.__R4GHOST;
    const btn = document.querySelector('#npGhostReplay');
    const statusEl = document.querySelector('#npGhostStatus');
    return {
      enabled: !!(g && g.enabled), game: g && g.game, turn: g && g.turn, role: g && g.role,
      label: g && g.label, drive: window.__R4MP && window.__R4MP.drive,
      triggerProved: g && typeof g.triggerProved === 'function' ? g.triggerProved() : null,
      panelHidden: document.querySelector('#npGhost') ? document.querySelector('#npGhost').hidden : null,
      replayText: btn ? btn.textContent : null,
      status: statusEl ? statusEl.textContent : '',
      statusState: statusEl ? statusEl.dataset.state : null,
      api: !!g && ['captureNow', 'replayNow', 'loadSyntheticTape', 'ram'].every((k) => !!g[k]),
      map: g && g.ramMap ? {
        scene: g.ramMap.rage.scene, tape: g.ramMap.rage.tape, count: g.ramMap.rage.count,
        write: g.ramMap.rage.write, read: g.ramMap.rage.read, wrapped: g.ramMap.rage.wrapped,
        mode: g.ramMap.rage.mode, racePhase: g.ramMap.rage.racePhase,
        raceLength: g.ramMap.rage.raceLength, lap: g.ramMap.rage.lap,
        finishTimer: g.ramMap.rage.finishTimer, maxBytes: g.ramMap.rage.maxBytes,
      } : null,
    };
  });
  await waitFor(page, () => !!(window.__R4GHOST && window.__R4GHOST.ramBase), 30000, 400);
  const ramBase = await page.evaluate(() => window.__R4GHOST.ramBase);
  check('G01-boot', 'rage boots with the ghost engine enabled, finds PSX RAM, and the Rage replay trigger is PROVED',
    !!booted && surf.enabled && surf.game === 'rage' && surf.turn === 'host'
      && surf.label === 'ghost replay (sequential)' && surf.drive === 'ghost'
      && Number.isFinite(ramBase) && ramBase > 0 && surf.api && surf.triggerProved === true
      && surf.panelHidden === false && !/UNVERIFIED/.test(String(surf.replayText))
      && !!surf.map && surf.map.racePhase === RAGE.racePhase && surf.map.lap === RAGE.lap
      && surf.map.finishTimer === RAGE.finishTimer && surf.map.raceLength === RAGE.raceLength,
    `boot=${!!booted} enabled=${surf.enabled} game=${surf.game} turn=${surf.turn} ramBase=${hex(ramBase)} `
    + `triggerProved=${surf.triggerProved} replayButton="${surf.replayText}" `
    + `status="${surf.status}" state=${surf.statusState}`);
  if (!booted || !Number.isFinite(ramBase) || !ramBase) { await page.close(); return out; }

  await page.evaluate(installKit);
  await page.evaluate((b) => { window.__GR.base = b; }, ramBase);
  const sampler = await page.evaluate((fields) => window.__GR.startSampler(fields), RAGE.sampler);
  note(`rage sampler installed at core frame ${sampler && sampler.frame0}`);

  // ---------------------------------------------------------------- pad walk
  // The probe's sequence, replayed through the cwrap the netplay client uses
  // (`gameManager.functions.simulateInput`) - the same function the product's
  // ghost turn gate wraps, and player 0 passes it in turn=host.
  const padState = () => page.evaluate(() => {
    const r = window.__R4GHOST.ram;
    return {
      scene: r.rd32s(0x801e3fec),
      fe: r.rd32s(0x8009eda0),
      fectr: r.rd32s(0x801e3fa4),
      cur: r.rd32s(0x801e3e8c),
      mode: r.rd16s(0x801e4ab4),
      phase: r.rd16s(0x801e6b7c),
      lap: r.rd16s(0x8009e544),
      fin: r.rd16s(0x801e4104),
      raceLength: r.rd32s(0x801e406c),
      write: r.rd32s(0x801e48b8),
      count: r.rd32s(0x8019c874),
      read: r.rd32s(0x801f30c4),
      timer: r.rd32s(0x801e3dc0),
      carX: r.rd16(0x8009e3dc),
      carZ: r.rd16(0x8009e3dc + 8),
      carYaw: r.rd16(0x8009e3dc + 0x24),
      frame: window.__GR.frame(),
    };
  });
  const slim = (s) => ({ scene: s.scene, fe: s.fe, cur: s.cur, fectr: s.fectr });
  const waitPad = async (pred, timeout, step = 200) => {
    const start = Date.now();
    let s = null;
    for (;;) {
      s = await padState();
      if (pred(s)) return s;
      if (Date.now() - start > timeout) return { ...s, timedOut: true };
      await sleep(step);
    }
  };
  const walk = [];
  const press = async (index, label, hold, settleMs) => {
    const before = await padState();
    await page.evaluate(([i, h, s]) => window.__GR.tap(0, i, h, s), [index, hold, settleMs]);
    const after = await padState();
    walk.push({
      label, index, hold, settle: settleMs, before: slim(before), after: slim(after),
      changed: before.scene !== after.scene,
    });
    return after;
  };
  const cursorTo = async (target, s0) => {
    let s = s0;
    for (let i = 0; i < 12 && s.cur !== target; i += 1) {
      const dir = s.cur < target ? PAD.DOWN : PAD.UP;
      s = await press(dir, `cursor ${s.cur}->${target}`, 40, 320);
    }
    return s;
  };
  const openMenu = async () => {
    let s = await waitPad((x) => x.fe === 2, 9000);
    if (s.fe !== 2) {
      await press(PAD.START, 'Start(title->menu)', 300, 900);
      await waitPad((x) => x.fe === 1, 4000);
      s = await waitPad((x) => x.fe === 2, 9000);
    }
    return s;
  };

  let st = await padState();
  const bootScene = st.scene;
  for (let i = 0; i < 12 && st.scene !== 4; i += 1) {
    st = await press(PAD.START, 'Start(skip fmv)', 300, 1700);
  }
  const title = st;
  check('G02-title', 'real pad input reaches the title screen (scene 4) from the boot scene',
    title.scene === 4, `boot scene ${bootScene} -> ${title.scene} (fe=${title.fe}); ${walk.length} presses`);

  st = title.fe === 0 ? await press(PAD.START, 'Start(title->menu)', 300, 900) : title;
  st = await openMenu();
  if (st.fe === 2) st = await cursorTo(2, st);
  check('G03-menu', 'the frontend list is up and the cursor sits on TIME ATTACK (row 2)',
    st.fe === 2 && st.cur === 2, `fe=${st.fe} fectr=${st.fectr} cur=${st.cur}`);
  const menuShot = path.join(OUT, 'mp-ghost-rage-menu.png');
  await page.screenshot({ path: menuShot });
  out.beforeMetrics = await canvasMetrics(page);
  out.menu = { state: slim(st), metrics: out.beforeMetrics, file: menuShot };

  if (st.fe === 2 && st.cur === 2) st = await press(PAD.CIRCLE, 'Circle(choose TA)', 300, 700);
  st = await waitPad((x) => x.scene === 6 || x.scene === 8, 12000);
  if (st.scene === 6) st = await waitPad((x) => x.scene === 8, 12000);
  const selectShot = path.join(OUT, 'mp-ghost-rage-select.png');
  await page.screenshot({ path: selectShot });
  out.select = { scene: st.scene, mode: st.mode, metrics: await canvasMetrics(page), file: selectShot };

  // scene 8 (course/car/class) confirms through 9 -> 10 -> 11 -> 12 on its own
  for (let i = 0; i < 9 && st.scene !== RAGE_SCENE.race; i += 1) {
    if (st.scene === 4) {
      await openMenu();
      await cursorTo(2);
      await press(PAD.CIRCLE, 'Circle(choose TA again)', 300, 800);
    }
    st = await press(PAD.CIRCLE, `Circle(scene ${st.scene})`, 220, 1500);
  }
  st = await waitPad((x) => x.scene === RAGE_SCENE.race, 40000);
  const raceShot = path.join(OUT, 'mp-ghost-rage-race.png');
  await page.screenshot({ path: raceShot });
  const raceMetrics = await canvasMetrics(page);
  out.walk = walk.map((w) => `${w.label}(retro ${w.index}) hold ${w.hold}/settle ${w.settle}`
    + `${w.changed ? ` scene ${w.before.scene} -> ${w.after.scene}` : ''}`);
  out.race = { state: st, metrics: raceMetrics, file: raceShot, presses: walk.length };
  check('G04-race', 'the pad sequence reaches scene 12 (RACE)', st.scene === RAGE_SCENE.race,
    st.scene === RAGE_SCENE.race
      ? `scene=12 mode=${st.mode} phase=${st.phase} write=${st.write} count=${st.count} after ${walk.length} presses`
      : `last scene=${st.scene} fe=${st.fe} fectr=${st.fectr} cur=${st.cur} mode=${st.mode}${st.timedOut ? ' (timed out)' : ''}`);
  if (st.scene !== RAGE_SCENE.race) {
    check('G05-errors', 'no uncaught page errors on the rage ghost page',
      localErrors.filter(notNoise).length === 0, localErrors.slice(0, 3).join(' | ') || 'clean');
    out.errors = localErrors;
    await page.close();
    return out;
  }

  // ------------------------------------------------------- the taped RACE run
  // Hold the throttle (Cross, retro 0 - the control the probe measured) so the
  // game's own recorder writes a moving run, then read that tape back through
  // the product. This is the real rival tape: a game-recorded run is
  // physics-consistent, so the replay reproduces its records exactly (the
  // probe's 93/95 pose result; a fabricated tape does not, because the replay's
  // own physics smooths fields that disagree with each other).
  const driveFrom = await padState();
  await page.evaluate(() => window.__GR.pad(0, 0, 1));
  await sleep(2400);
  await page.evaluate(() => window.__GR.pad(0, 0, 0));
  await sleep(400);
  const driveTo = await padState();
  const frames = (driveTo.frame != null && driveFrom.frame != null) ? driveTo.frame - driveFrom.frame : null;
  check('G05-race-live', 'the RACE scene is live: the core advances frames and the game tapes the run (write cursor)',
    frames != null && frames > 20 && driveTo.write > driveFrom.write + 20,
    `frames=${frames} write ${driveFrom.write} -> ${driveTo.write} count=${driveTo.count} `
    + `carX/Z ${driveFrom.carX}/${driveFrom.carZ} -> ${driveTo.carX}/${driveTo.carZ}`);

  const capRun = await page.evaluate(() => {
    const g = window.__R4GHOST;
    const ok = g.captureNow();
    const t = g.tape;
    const bytes = t ? Array.from(g.ram.read(0x801e8804, t.samples * 28)) : null;
    return {
      ok, state: g.state, bytes,
      tape: t ? { count: t.count, stride: t.stride, mode: t.mode, samples: t.samples, bytes: t.bytes } : null,
      write: g.ram.rd32s(0x801e48b8), count: g.ram.rd32s(0x8019c874), mode: g.ram.rd16s(0x801e4ab4),
      storage: { ...g.storage },
      status: (document.querySelector('#npGhostStatus') || {}).textContent || '',
    };
  });
  out.captureRun = { ...capRun, bytes: undefined };
  const capOk = !!capRun.tape && capRun.tape.stride === RAGE.stride && capRun.tape.mode === 0
    && capRun.tape.bytes > 0 && capRun.tape.bytes <= RAGE.maxBytes
    && capRun.tape.bytes === capRun.tape.samples * RAGE.stride
    && capRun.tape.count === capRun.tape.samples * 2
    && capRun.tape.count <= RAGE.maxSamples * 2 && !!capRun.bytes;
  check('G06-capture-run', 'captureNow() on the live run reads the game\'s own tape at 0x801E8804, clamped to the TA capacity',
    capRun.ok === true && capOk,
    `ok=${capRun.ok} tape=${JSON.stringify(capRun.tape)} write=${capRun.write} count=${capRun.count} `
    + `mode=${capRun.mode} (TA cap ${RAGE.maxSamples} samples / ${RAGE.maxBytes} B) status="${capRun.status}"`);
  const runTape = Buffer.from(capRun.bytes || []);
  const runSamples = capRun.tape ? capRun.tape.samples : 0;

  // ------------------------------------------- stage a synthetic tape (staging)
  const markStage = await page.evaluate(() => window.__GR.sampleCount());
  const stage = await page.evaluate(() => {
    const g = window.__R4GHOST;
    const before = {
      mode: g.ram.rd16s(0x801e4ab4), count: g.ram.rd32s(0x8019c874), write: g.ram.rd32s(0x801e48b8),
      read: g.ram.rd32s(0x801f30c4), wrapped: g.ram.rd32s(0x8009e994),
      scene: g.ram.rd32s(0x801e3fec), ptrA: g.ram.rd32(0x8019c4ac), ptrB: g.ram.rd32(0x8009edac),
    };
    const returned = g.loadSyntheticTape({ count: 300 });
    const t = g.syntheticTape;
    const back = t ? Array.from(g.ram.read(0x801e8804, t.bytes.length)) : null;
    let diff = 0;
    if (t && back) for (let i = 0; i < t.bytes.length; i += 1) if (back[i] !== t.bytes[i]) diff += 1;
    return {
      returned, before, diff,
      tape: t ? { count: t.count, samples: t.samples, stride: t.stride, len: t.bytes.length, mode: t.mode, game: t.game } : null,
      after: {
        mode: g.ram.rd16s(0x801e4ab4), count: g.ram.rd32s(0x8019c874), write: g.ram.rd32s(0x801e48b8),
        read: g.ram.rd32s(0x801f30c4), wrapped: g.ram.rd32s(0x8009e994),
        ptrA: g.ram.rd32(0x8019c4ac), ptrB: g.ram.rd32(0x8009edac), scene: g.ram.rd32s(0x801e3fec),
      },
      status: (document.querySelector('#npGhostStatus') || {}).textContent || '',
    };
  });
  out.stage = stage;
  check('G07-stage', 'loadSyntheticTape(300) writes a 300x28 Time Attack tape at 0x801E8804 byte-exactly and seeds the cursors',
    stage.returned === 8400 && !!stage.tape && stage.tape.samples === 300 && stage.tape.stride === 28
      && stage.tape.len === 8400 && stage.tape.count === 600 && stage.tape.mode === 0 && stage.diff === 0
      && stage.after.mode === 0 && stage.after.count === 600 && stage.after.write === 602
      && stage.after.read === 0 && stage.after.wrapped === 0
      && stage.after.ptrA === RAGE.tape && stage.after.ptrB === RAGE.tape
      && stage.after.scene === RAGE_SCENE.race,
    `returned=${stage.returned} tape=${JSON.stringify(stage.tape)} diff=${stage.diff}/8400 cursors=${JSON.stringify(stage.after)} `
    + `(were count ${stage.before.count} write ${stage.before.write} read ${stage.before.read}) scene=${stage.after.scene}`);

  // --------------------------------- the run just taped becomes the rival tape
  // Stored as the GUEST seat (this page is host), then reloaded through the
  // product - exactly what a peer's finished run looks like on the next race.
  const key = `${room}:rage`;
  const peer = await page.evaluate(async ({ keyStr, tape, count }) => {
    const open = () => new Promise((res, rej) => {
      const req = indexedDB.open('rr4-ghost', 1);
      req.onupgradeneeded = () => { if (!req.result.objectStoreNames.contains('runs')) req.result.createObjectStore('runs'); };
      req.onsuccess = () => res(req.result);
      req.onerror = () => rej(req.error);
    });
    const db = await open();
    const family = await new Promise((res) => {
      const tx = db.transaction('runs', 'readonly');
      const q = tx.objectStore('runs').get(keyStr);
      q.onsuccess = () => res(q.result || {});
      q.onerror = () => res({});
    });
    family.guest = {
      room: keyStr.split(':')[0], game: 'rage', mode: 0, stride: 28, count,
      bytes: new Uint8Array(tape), seat: 'guest', turn: 'guest', at: Date.now(), trackIndex: 0,
    };
    await new Promise((res) => {
      const tx = db.transaction('runs', 'readwrite');
      tx.objectStore('runs').put(family, keyStr);
      tx.oncomplete = () => res();
      tx.onerror = () => res();
    });
    db.close();
    await window.__R4GHOST.reload();
    return window.__R4GHOST.peer ? { ...window.__R4GHOST.peer } : null;
  }, { keyStr: key, tape: Array.from(runTape), count: runSamples * 2 });
  check('G08-peer', 'the run the game just taped is stored as the rival (guest) seat and reloaded through the product',
    !!peer && peer.seat === 'guest' && peer.game === 'rage' && peer.mode === 0
      && peer.stride === 28 && peer.count === runSamples * 2 && peer.bytes === runTape.length,
    `peer=${JSON.stringify(peer)} key=${key} run=${runSamples} samples / ${runTape.length} B`);

  // ------------------------------------------------- replayNow() arms the branch
  const arm = await page.evaluate(({ len }) => {
    const g = window.__R4GHOST;
    const pre = {
      scene: g.ram.rd32s(0x801e3fec), phase: g.ram.rd16s(0x801e6b7c),
      lap: g.ram.rd16s(0x8009e544), fin: g.ram.rd16s(0x801e4104),
      raceLength: g.ram.rd32s(0x801e406c),
    };
    const t0 = performance.now();
    let ok = null; let err = null;
    try { ok = g.replayNow(); } catch (e) { err = String(e && e.message ? e.message : e); }
    return {
      ok, err, ms: +(performance.now() - t0).toFixed(1), pre,
      arm: g.arm ? {
        game: g.arm.game, mode: g.arm.mode, armed: g.arm.armed, scene: g.arm.scene,
        staged: g.arm.staged, raceLength: g.arm.raceLength, lap: g.arm.lap,
        writes: (g.arm.writes || []).map((w) => `${w.addr}:${w.value}`),
      } : null,
      post: {
        scene: g.ram.rd32s(0x801e3fec), phase: g.ram.rd16s(0x801e6b7c),
        lap: g.ram.rd16s(0x8009e544), fin: g.ram.rd16s(0x801e4104),
        count: g.ram.rd32s(0x8019c874), write: g.ram.rd32s(0x801e48b8),
      },
      state: g.state, swapped: g.swapped, lastError: g.lastError,
      bytes: Array.from(g.ram.read(0x801e8804, len)),
      status: (document.querySelector('#npGhostStatus') || {}).textContent || '',
      log: (window.__R4NET_LOGS || []).filter((l) => /GHOST \/\//.test(l)).slice(-4),
    };
  }, { len: runTape.length });
  let armDiff = 0;
  for (let i = 0; i < runTape.length; i += 1) if (arm.bytes[i] !== runTape[i]) armDiff += 1;
  out.arm = { ...arm, bytes: undefined, armDiff };
  const armOk = arm.ok === true && !!arm.arm && arm.arm.mode === 'race' && arm.arm.armed === true
    && arm.arm.scene === RAGE_SCENE.race && arm.arm.staged === 'ok'
    && arm.post.phase === 4 && arm.post.lap === arm.pre.raceLength + 1 && arm.post.fin === 0
    && armDiff === 0 && arm.post.count === runSamples * 2 && arm.post.write === runSamples * 2 + 2;
  check('G09-arm', 'replayNow() in scene 12 stages the rival tape and arms the RACE finish branch (g_RacePhase=4, lap=raceLength+1, fin=0)',
    armOk,
    `ok=${arm.ok} err=${arm.err} arm=${JSON.stringify(arm.arm)} pre=${JSON.stringify(arm.pre)} post=${JSON.stringify(arm.post)} `
    + `tape@0x801e8804=peer(diff=${armDiff}/${runTape.length}) state=${arm.state} log=${JSON.stringify(arm.log.slice(-2))}`);

  // ------------------------------------------------ the game enters scene 17
  const entered = await waitPad((x) => x.scene === RAGE_SCENE.replay, 15000, 100);
  // The sampler records one row per core frame from a rAF tick, so the first
  // scene-17 row lands just after the RAM scene id flips - wait for it instead
  // of racing the next animation frame.
  let afterMark = [];
  for (let i = 0; i < 30; i += 1) {
    afterMark = await page.evaluate((mark) => window.__GR.samples(mark), markStage);
    if (afterMark.some((r) => r.scene === RAGE_SCENE.replay)) break;
    await sleep(100);
  }
  const chain = [];
  for (const r of afterMark) if (!chain.length || chain[chain.length - 1] !== r.scene) chain.push(r.scene);
  const finRows = afterMark.filter((r) => r.scene === RAGE_SCENE.race).map((r) => r.fin);
  const finMax = finRows.length ? Math.max(...finRows) : null;
  const scene17Shot = path.join(OUT, 'mp-ghost-rage-scene17.png');
  await page.screenshot({ path: scene17Shot });
  out.enter = { entered, chain, finMax, file: scene17Shot, metrics: await canvasMetrics(page) };
  note('scene 17 is entered on the BeginReplay fade-in (the shot is white by design); '
    + 'mp-ghost-rage-replay.png is the played-in frame');
  check('G10-scene17', 'the RACE frame counts the finish timer itself and enters scene 17 (12 -> 17, no 15/16)',
    entered.scene === RAGE_SCENE.replay && finMax != null && finMax >= 120
      && chain.includes(RAGE_SCENE.race) && chain.includes(RAGE_SCENE.replay)
      && !chain.includes(15) && !chain.includes(16),
    `scene=${entered.scene} timer=${entered.timer} read=${entered.read} count=${entered.count} `
    + `phase=${entered.phase} fin=${entered.fin} finish timer max seen=${finMax} chain=${JSON.stringify(chain)} `
    + `(mp-ghost-rage-scene17.png is the BeginReplay fade-in)`);
  if (entered.scene !== RAGE_SCENE.replay) {
    check('G11-errors', 'no uncaught page errors on the rage ghost page',
      localErrors.filter(notNoise).length === 0, localErrors.slice(0, 3).join(' | ') || 'clean');
    out.errors = localErrors;
    await page.close();
    return out;
  }

  // ------------------------------------------- capture at the first 17 tick
  const cap17 = await page.evaluate(() => {
    const g = window.__R4GHOST;
    const ok = g.captureNow();
    return {
      ok, tape: g.tape ? {
        count: g.tape.count, stride: g.tape.stride, mode: g.tape.mode,
        samples: g.tape.samples, bytes: g.tape.bytes,
      } : null,
      state: g.state, restage: g.arm ? (g.arm.restage || null) : null,
      write: g.ram.rd32s(0x801e48b8), count: g.ram.rd32s(0x8019c874),
      captured: g.captured,
    };
  });
  out.capture17 = cap17;
  check('G11-capture-17', 'the run is captured at scene 17 (before the peer swap), same TA stride and clamped length',
    cap17.ok === true && !!cap17.tape && cap17.tape.stride === 28 && cap17.tape.mode === 0
      && cap17.tape.samples === runSamples && cap17.tape.count === runSamples * 2
      && cap17.tape.bytes === runTape.length && cap17.restage === 'ok',
    `ok=${cap17.ok} tape=${JSON.stringify(cap17.tape)} restage=${cap17.restage} `
    + `count=${cap17.count} write=${cap17.write} captured=${cap17.captured} (the rival tape is ${runSamples} samples)`);

  // ------------------------------------------ timer / cursor keep advancing
  const t0r = entered;
  await sleep(1500);
  const advanced = await padState();
  check('G12-timer', 'g_SceneTimer advances inside the replay (the scene handler runs every frame)',
    advanced.timer > t0r.timer + 25,
    `scene timer ${t0r.timer} -> ${advanced.timer} in ~1.5 s (scene ${advanced.scene})`);
  check('G13-cursor', 'g_Replay.read advances - the native tape is being played, not applied once',
    advanced.read !== t0r.read && (advanced.read > t0r.read + 5 || advanced.read < t0r.read),
    `read ${t0r.read} -> ${advanced.read} (count ${advanced.count}, wrapped 0 = no loop)`);

  // ------------------------------------------------ pose comes from the tape
  const replayShot = path.join(OUT, 'mp-ghost-rage-replay.png');
  await page.screenshot({ path: replayShot });
  const replayMetrics = await canvasMetrics(page);
  const frontendDelta = metricDelta(out.beforeMetrics, replayMetrics);
  const poseSamples = await page.evaluate((mark) => window.__GR.samples(mark), markStage);
  const rowsA = [];
  for (const s of poseSamples) {
    if (s.scene !== RAGE_SCENE.replay) continue;
    const read = s.read | 0;
    if (read < 2) continue;                        // the first frames land after the snapshot
    const i = read >> 1;
    if (i >= runSamples) continue;
    const rec = rageRecordAt(runTape, i);
    rowsA.push({ i, read, carX: s.carX, carZ: s.carZ, carYaw: s.carYaw, tx: rec.x, tz: rec.z, dx: s.carX - rec.x, dz: s.carZ - rec.z });
  }
  const seenA = new Set(rowsA.map((r) => r.i));
  const matchA = rowsA.filter((r) => nearU16(r.carX, r.tx) && nearU16(r.carZ, r.tz));
  const exactA = rowsA.filter((r) => r.carX === r.tx && r.carZ === r.tz);
  const missA = rowsA.filter((r) => !nearU16(r.carX, r.tx) || !nearU16(r.carZ, r.tz));
  out.poseTapeA = {
    rows: rowsA.length, match: matchA.length, exact: exactA.length, distinct: seenA.size,
    miss: missA.slice(0, 4), first: rowsA.slice(0, 6),
  };
  check('G14-pose', 'the replayed car pose equals the rival tape record for the played read index on >=10 distinct frames',
    rowsA.length >= 10 && seenA.size >= 10 && matchA.length >= 10
      && missA.length / rowsA.length <= 0.1,
    `${matchA.length}/${rowsA.length} samples match x/z within tolerance 1 (${exactA.length} exact, ${seenA.size} distinct replay frames, `
    + `mismatches ${missA.length}${missA.length ? ': ' + JSON.stringify(missA.slice(0, 3)) : ''}); first=${JSON.stringify(rowsA.slice(0, 3))}`);
  check('G15-frame', 'the automatic replay renders a race-like frame (not black, not the frontend)',
    !!replayMetrics && replayMetrics.ok && replayMetrics.nonBlackPct > 20 && replayMetrics.meanLum > 12,
    `replay=${replayMetrics && `${replayMetrics.nonBlackPct}% nonBlack / ${replayMetrics.meanLum} lum`} `
    + `race=${raceMetrics && `${raceMetrics.nonBlackPct}% / ${raceMetrics.meanLum}`} deltaVsFrontend=${JSON.stringify(frontendDelta)} `
    + `file=${path.basename(replayShot)}`);

  // ------------------------------------- a mirrored tape must change the frame
  // Freeze the playback on sample 0 (count = 1 makes the scene handler apply
  // record 0 every frame, probe C08), shoot, then swap in a mirrored tape
  // through the product and shoot the same sample again.
  const freezeA = await page.evaluate(() => {
    const g = window.__R4GHOST;
    g.ram.wr32(0x8019c874, 1);
    g.ram.wr32(0x801f30c4, 0);
    return { count: g.ram.rd32s(0x8019c874), read: g.ram.rd32s(0x801f30c4) };
  });
  await sleep(800);
  const frozenShotA = path.join(OUT, 'mp-ghost-rage-frozen-a.png');
  await page.screenshot({ path: frozenShotA });
  const frozenA = await canvasMetrics(page);

  const peerTape = Buffer.alloc(runSamples * 28);
  for (let i = 0; i < runSamples; i += 1) {
    const o = i * 28;
    runTape.copy(peerTape, o, o, o + 28);
    // Same course, different run: the recorded heading turns +22.5 deg per
    // sample (0x1000 = 360 deg) and the path sits 0x400 units off in z, so the
    // mirrored tape differs in the bytes the applier reads.
    peerTape.writeUInt16LE((runTape.readUInt16LE(o + 0x0a) + 0x0400) & 0xffff, o + 0x0a);
    peerTape.writeUInt16LE((runTape.readUInt16LE(o + 0x04) + 0x0400) & 0xffff, o + 0x04);
  }
  const peerB = await page.evaluate(async ({ keyStr, tape, count }) => {
    const open = () => new Promise((res, rej) => {
      const req = indexedDB.open('rr4-ghost', 1);
      req.onupgradeneeded = () => { if (!req.result.objectStoreNames.contains('runs')) req.result.createObjectStore('runs'); };
      req.onsuccess = () => res(req.result);
      req.onerror = () => rej(req.error);
    });
    const db = await open();
    const family = await new Promise((res) => {
      const tx = db.transaction('runs', 'readonly');
      const q = tx.objectStore('runs').get(keyStr);
      q.onsuccess = () => res(q.result || {});
      q.onerror = () => res({});
    });
    family.guest = {
      room: keyStr.split(':')[0], game: 'rage', mode: 0, stride: 28, count,
      bytes: new Uint8Array(tape), seat: 'guest', turn: 'guest', at: Date.now(), trackIndex: 0,
    };
    await new Promise((res) => {
      const tx = db.transaction('runs', 'readwrite');
      tx.objectStore('runs').put(family, keyStr);
      tx.oncomplete = () => res();
      tx.onerror = () => res();
    });
    db.close();
    await window.__R4GHOST.reload();
    return window.__R4GHOST.peer ? { ...window.__R4GHOST.peer } : null;
  }, { keyStr: key, tape: Array.from(peerTape), count: runSamples * 2 });

  const swapB = await page.evaluate(({ len }) => {
    const g = window.__R4GHOST;
    const ok = g.replayNow();
    const res = {
      ok, swapped: g.swapped, state: g.state, replayedSource: g.replayedSource,
      count: g.ram.rd32s(0x8019c874), write: g.ram.rd32s(0x801e48b8),
      read: g.ram.rd32s(0x801f30c4), wrapped: g.ram.rd32s(0x8009e994),
      mode: g.ram.rd16s(0x801e4ab4), arm: g.arm ? { mode: g.arm.mode, staged: g.arm.staged } : null,
      bytes: Array.from(g.ram.read(0x801e8804, len)),
      status: (document.querySelector('#npGhostStatus') || {}).textContent || '',
    };
    // freeze on sample 0 again so both shots show the same read index / fade
    g.ram.wr32(0x8019c874, 1);
    g.ram.wr32(0x801f30c4, 0);
    return res;
  }, { len: peerTape.length });
  let swapDiff = 0;
  for (let i = 0; i < peerTape.length; i += 1) if (swapB.bytes[i] !== peerTape[i]) swapDiff += 1;
  out.peerSwap = { peer: peerB, swap: { ...swapB, bytes: undefined }, swapDiff };
  check('G16-peer-swap', 'replayNow() in scene 17 swaps the mirrored tape byte-exactly and re-seeds count/write/read/wrapped',
    !!peerB && peerB.seat === 'guest' && peerB.bytes === peerTape.length
      && swapB.ok === true && swapDiff === 0 && swapB.count === runSamples * 2
      && swapB.write === runSamples * 2 + 2 && swapB.read === 0 && swapB.wrapped === 0
      && swapB.mode === 0 && !!swapB.arm && swapB.arm.mode === 'replay',
    `peer=${JSON.stringify(peerB)} ok=${swapB.ok} arm=${JSON.stringify(swapB.arm)} `
    + `bytes@0x801e8804=mirror(diff=${swapDiff}/${peerTape.length}) count=${swapB.count} write=${swapB.write} `
    + `read=${swapB.read} wrapped=${swapB.wrapped} mode=${swapB.mode} state=${swapB.state} source=${swapB.replayedSource}`);

  await sleep(800);
  const frozenShotB = path.join(OUT, 'mp-ghost-rage-frozen-b.png');
  await page.screenshot({ path: frozenShotB });
  const frozenB = await canvasMetrics(page);
  const frozenDelta = metricDelta(frozenA, frozenB);
  out.frozen = {
    a: { count: freezeA.count, read: freezeA.read, metrics: frozenA, file: frozenShotA },
    b: { metrics: frozenB, file: frozenShotB },
    delta: frozenDelta,
  };
  check('G17-peer-frame', 'the mirrored tape changes the rendered replay at the same frozen sample (the tape bytes are what plays)',
    !!frozenA && !!frozenB && !!frozenDelta
      && (frozenDelta.meanAbsLumDiff >= 3 || frozenDelta.changedRowsPct >= 8),
    `frozen on sample 0 (count=1, read=0) in both shots: A=${JSON.stringify({ nonBlackPct: frozenA.nonBlackPct, meanLum: frozenA.meanLum })} `
    + `B=${JSON.stringify({ nonBlackPct: frozenB.nonBlackPct, meanLum: frozenB.meanLum })} delta=${JSON.stringify(frozenDelta)} `
    + `files=${path.basename(frozenShotA)},${path.basename(frozenShotB)}`);

  // resume the swapped tape: it must keep playing
  await page.evaluate(({ count }) => {
    const g = window.__R4GHOST;
    g.ram.wr32(0x8019c874, count);
    g.ram.wr32(0x801e48b8, count + 2);
    g.ram.wr32(0x801f30c4, 0);
  }, { count: runSamples * 2 });
  const resumeFrom = await padState();
  await sleep(1400);
  const resumeTo = await padState();
  check('G18-resume', 'the replay keeps playing the swapped tape (the cursor advances again after the swap)',
    resumeTo.scene === RAGE_SCENE.replay && resumeTo.timer > resumeFrom.timer
      && (resumeTo.read !== resumeFrom.read || resumeTo.read > 0),
    `scene=${resumeTo.scene} timer ${resumeFrom.timer} -> ${resumeTo.timer} read ${resumeFrom.read} -> ${resumeTo.read} count=${resumeTo.count}`);

  const noise = localErrors.filter(notNoise);
  check('G19-errors', 'no uncaught page errors on the rage ghost page', noise.length === 0,
    noise.length ? noise.slice(0, 3).join(' | ') : 'clean');
  out.errors = localErrors;
  await page.close();
  return out;
}

// ------------------------------------------------------- turn gate (turn=guest)
async function runTurnGuest() {
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 800 });
  const localErrors = [];
  page.on('pageerror', (e) => { const m = String(e && e.message ? e.message : e); localErrors.push(m); pageErrors.push(`turn-guest: ${m}`); });
  const url = `${BASE}/play-net?game=ridge&threads=0&cache=0&bios=hle`
    + `&mpRole=host&mpRoom=GHSG&mpRace=ghostg-${STAMP}&mpGhost=ghost&mpTurn=guest`;
  console.log(`\n=== ridge turn=guest :: ${url}`);
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 90000 });
  const booted = await waitFor(page, () => !!(
    window.__R4 && window.__R4.startedAt
    && window.EJS_emulator && window.EJS_emulator.gameManager
    && window.EJS_emulator.gameManager.functions
  ), BOOT_TIMEOUT, 400);
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
      label: (document.querySelector('#npGhostTurn') || {}).textContent || '',
    };
  });
  check('T01-gate-guest', 'turn=guest: a player-1 press is remapped to player 0 and a player-0 press is dropped',
    !!booted && !!gateWait && g.ok && g.wrapped && g.turn === 'guest' && g.peerSeat === 'host'
      && g.remapped === 2 && g.gated === 2,
    `boot=${!!booted} turn=${g.turn} peerSeat=${g.peerSeat} remapped=${g.remapped} gated=${g.gated} `
    + `installed=${g.installed} label="${g.label}"`);
  check('T02-errors', 'no uncaught page errors on the turn=guest page',
    localErrors.filter(notNoise).length === 0,
    localErrors.slice(0, 2).join(' | ') || 'clean');
  await page.close();
}

// ---------------------------------------------- live / R4 / guest surface only
// These three only need the page script (the engine object is created at parse
// time); they are closed before the core finishes booting.
async function quickPage(tag, url, fn) {
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 800 });
  const localErrors = [];
  page.on('pageerror', (e) => { const m = String(e && e.message ? e.message : e); localErrors.push(m); pageErrors.push(`${tag}: ${m}`); });
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 90000 });
  await waitFor(page, () => !!(window.__R4GHOST && window.__R4MP), 15000, 200);
  await sleep(1500);
  let value = null;
  try { value = await page.evaluate(fn); } catch (e) { value = { error: String(e && e.message ? e.message : e) }; }
  await page.close();
  return { value, localErrors };
}

async function runLiveFlagChecks() {
  const live = await quickPage('live', `${BASE}/play-net?game=ridge&threads=0&cache=0&bios=hle`
    + `&mpRole=host&mpRoom=GHSL&mpRace=ghostl-${STAMP}&mpGhost=live`, () => {
    const g = window.__R4GHOST;
    return {
      enabled: g.enabled, game: g.game, drive: window.__R4MP.drive, turn: window.__R4MP.turn,
      panelHidden: document.querySelector('#npGhost').hidden,
      gateInstalled: g.gateInstalled, captured: g.captured, swapped: g.swapped,
      tape: g.tape, synthetic: g.syntheticTape, state: g.state,
      status: (document.querySelector('#npGhostStatus') || {}).textContent || '',
    };
  });
  const v = live.value || {};
  check('L01-live', 'mpGhost=live on ridge keeps the engine off: no tape capture, no gate, panel hidden',
    v.enabled === false && v.game === null && v.drive === 'live' && v.turn === null
      && v.panelHidden === true && v.gateInstalled === false && v.captured === 0 && v.swapped === 0
      && v.tape === null && (v.synthetic === null || v.synthetic === undefined),
    JSON.stringify(v));

  const r4 = await quickPage('r4', `${BASE}/play-net?game=r4&threads=0&cache=0&bios=hle`
    + `&mpRole=host&mpRoom=R4GL&mpRace=ghost4-${STAMP}&mpGhost=ghost&mpTurn=guest`, () => {
    const g = window.__R4GHOST;
    return {
      enabled: g.enabled, game: g.game, drive: window.__R4MP.drive, turn: window.__R4MP.turn,
      panelHidden: document.querySelector('#npGhost').hidden, captured: g.captured, swapped: g.swapped,
      state: g.state,
    };
  });
  const r = r4.value || {};
  check('L02-r4', 'mpGhost=ghost is ignored for R4 (the versus path is untouched)',
    r.enabled === false && r.game === null && r.drive === 'live' && r.turn === null
      && r.panelHidden === true && r.captured === 0 && r.swapped === 0,
    JSON.stringify(r));

  const guest = await quickPage('guest', `${BASE}/play-net?game=ridge&threads=0&cache=0&bios=hle`
    + `&mpRole=guest&mpRoom=GHSG&mpRace=ghostu-${STAMP}&mpGhost=ghost&mpTurn=host`, () => {
    const g = window.__R4GHOST;
    const gate = window.__R4NET.guestGate();     // installGuestGate(): the host owns the gate
    return {
      enabled: g.enabled, role: g.role, turn: g.turn, gate, gateInstalled: g.gateInstalled,
      raceLive: window.__R4MP.raceLive, inputGated: window.__R4MP.inputGated,
      captured: g.captured, swapped: g.swapped, state: g.state,
      panelHidden: document.querySelector('#npGhost').hidden,
      turnLabel: (document.querySelector('#npGhostTurn') || {}).textContent || '',
    };
  });
  const gv = guest.value || {};
  check('S01-guest', 'a ghost GUEST installs no local gate, is raceLive, and never captures',
    gv.enabled === true && gv.role === 'guest' && gv.gate === false && gv.gateInstalled === false
      && gv.raceLive === true && gv.inputGated === false && gv.captured === 0 && gv.swapped === 0
      && gv.panelHidden === false && /DRIVER: HOST/.test(gv.turnLabel || ''),
    JSON.stringify(gv));
}

// ---------------------------------------------------------------------- main
const t0 = Date.now();
try {
  const health8080Before = await health('http://localhost:8080');
  const st = await startInstance();
  console.log(`instance: ${BASE}  spawned=${!st.attached} pid=${server.pid}`);
  check('P01-port', `the harness runs on its own cabinet :${st.port} (never :8080)`,
    !!st && st.port !== 8080 && !!BASE && !!st.ok,
    `base=${BASE} port=${st.port} attached=${st.attached} log=${path.basename(server.logPath || '')} :8080=${health8080Before ? 'up (untouched)' : 'down'}`);

  const relay = await health('http://localhost:3010');
  note(`relay :3010 ${relay ? 'healthy' : 'down (no guest joins this run; only the host page retries its room)'}`);

  const chrome = CHROME_CANDIDATES.find((p) => fs.existsSync(p));
  if (!chrome) throw new Error('no Chrome at the known paths');
  browser = await puppeteer.launch({
    executablePath: chrome,
    headless: true,
    protocolTimeout: 300000,
    defaultViewport: { width: 1280, height: 800 },
    userDataDir: path.join(os.tmpdir(), `rr4-ghost-replay-${STAMP}`),
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

  // EmulatorJS caps every core to one visible tab, so the two discs AND the
  // turn-gate / surface pages run one at a time (a hidden tab stops drawing and
  // its wake-lock request is rejected).
  const evidence = { ridge: null, rage: null };
  if (!ONLY_RAGE) {
    try { evidence.ridge = await runRidgeHost(); } catch (e) {
      check('R-fatal', 'ridge ghost run completed', false, String(e && e.stack ? e.stack : e).slice(0, 500));
    }
  }
  if (!ONLY_RIDGE) {
    if (!(await ensureInstance())) check('G00-instance', 'the cabinet is up for the rage phase', false, BASE);
    try { evidence.rage = await runRageHost(); } catch (e) {
      check('G-fatal', 'rage ghost run completed', false, String(e && e.stack ? e.stack : e).slice(0, 500));
    }
  }

  if (!(await ensureInstance())) check('T00-instance', 'the cabinet is up for the turn-gate phase', false, BASE);
  try { await runTurnGuest(); } catch (e) {
    check('T-fatal', 'turn=guest run completed', false, String(e && e.stack ? e.stack : e).slice(0, 400));
  }
  if (!ONLY_RAGE && !ONLY_RIDGE) {
    if (!(await ensureInstance())) check('L00-instance', 'the cabinet is up for the surface phase', false, BASE);
    try { await runLiveFlagChecks(); } catch (e) {
      check('L-fatal', 'live/R4/guest checks completed', false, String(e && e.stack ? e.stack : e).slice(0, 400));
    }
  }

  // --- cleanup: kill only our child, then prove the port is free again
  const spawned = server.spawned;
  const port = server.port;
  const pid = server.pid;
  killServer();
  let freed = null;
  if (spawned && port) {
    for (let i = 0; i < 40; i += 1) {
      await sleep(250);
      if (!(await health(BASE, 800))) { freed = true; break; }
    }
    if (freed == null) freed = false;
  }
  const health8080After = await health('http://localhost:8080');
  check('P02-cleanup', 'the spawned cabinet is killed (only its own tree) and its port is free again; :8080 untouched',
    !spawned || (freed === true && (!!health8080Before === !!health8080After)),
    spawned ? `pid ${pid} on :${port} -> ${freed ? 'port free' : 'STILL ANSWERING'}; :8080 before=${!!health8080Before} after=${!!health8080After}; respawns=${respawns}`
      : `attached run (--base), nothing to kill; :8080 before=${!!health8080Before} after=${!!health8080After}; respawns=${respawns}`);

  // --- global noise: the known ICE line (and two framework lines) are allowed
  const allowed = [
    /No ICE servers configured/i,
    /ResizeObserver loop/i,
    /Cannot read properties of undefined \(reading 'appendChild'\)/i,
    /WakeLock.*page is not visible/i,
  ];
  const unexpectedConsole = consoleErrors.filter((m) => !allowed.some((re) => re.test(m)));
  const unexpectedPage = pageErrors.filter((m) => !allowed.some((re) => re.test(m)));
  check('P03-errors', 'no unexpected console/page errors (the known ICE notice is allowed)',
    unexpectedPage.length === 0 && unexpectedConsole.length === 0,
    `${unexpectedPage.length} page / ${unexpectedConsole.length} console unexpected`
    + (unexpectedPage.length ? ` :: ${unexpectedPage.slice(0, 3).join(' | ')}` : '')
    + (unexpectedConsole.length ? ` :: ${unexpectedConsole.slice(0, 3).join(' | ')}` : ''));

  const rageLabel = (evidence.rage && evidence.rage.poseTapeA && evidence.rage.poseTapeA.match >= 10)
    ? 'RAGE_REPLAY_VERIFIED' : 'RAGE_REPLAY_UNVERIFIED';
  const failures = checks.filter((c) => !c.pass);
  const doc = {
    ok: failures.length === 0,
    run: iso(Date.now()),
    base: BASE,
    port: server.port,
    attached: !server.spawned,
    durationSec: +((Date.now() - t0) / 1000).toFixed(1),
    total: checks.length,
    passed: checks.length - failures.length,
    checks,
    pageErrors,
    consoleErrors,
    notes,
    scopeNote: 'ghost replay (sequential); Ridge and Rage verified; no live ghost car. '
      + 'Ridge: post-race playback of the peer seat\'s native tape, staged in a zeroed BSS run with '
      + '0x80080434 repointed, because writes at the documented fixed base 0x8006CE7C do not reach the '
      + 'applier (tape-probe §1.1a); 161 records is the applier cap before the screen dispatch table at '
      + '0x8006E7BC, and a mirrored peer tape is what plays (pose + rendered frame). '
      + 'Rage: the RACE frame\'s own finish branch enters scene 17 and the tape drives the replay '
      + `(${rageLabel}; rage-finish-probe.md 21/21) - g_RacePhase 4 + lap = raceLength + 1, no scene poke. `
      + 'The Rage rival tape is the run the game itself taped (captured through the product during a '
      + 'synthetic throttle hold, 50 x 28 B Time Attack records); `loadSyntheticTape(300)` only proves the '
      + 'staging path, and the Rage run is stopped by the finish arm rather than by crossing the line. '
      + 'Nothing here is a human lap or a second car.',
    evidence,
  };
  fs.writeFileSync(OUT_JSON, JSON.stringify(doc, null, 2));
  console.log(`\n${doc.passed}/${doc.total} checks pass in ${doc.durationSec}s  ->  ${path.relative(ROOT, OUT_JSON)}`);
  console.log(`scope: ${doc.scopeNote}`);
  console.log(`screenshots: ${[...new Set(checks.flatMap((c) => (String(c.detail).match(/mp-ghost-[\w-]+\.png/g) || [])))].join(', ')}`);
  if (failures.length) {
    console.log('failures:');
    for (const f of failures) console.log(`  ${f.id} ${f.name} -- ${f.detail}`);
  }
  process.exitCode = failures.length ? 1 : 0;
} catch (e) {
  console.error('HARNESS FAILED', e && e.stack ? e.stack : e);
  process.exitCode = 1;
} finally {
  try { if (browser) await browser.close(); } catch { /* ignore */ }
  killServer();
  await sleep(300);
}
