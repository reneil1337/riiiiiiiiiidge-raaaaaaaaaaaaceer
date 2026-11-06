// bench-native.mjs - one-run performance + observability artifact for the
// single-player browser path (/play, EmulatorJS + PCSX-ReARMed).
//
// Usage:
//   node bench-native.mjs                          # warm profile, 20 s steady, 50 input samples
//   node bench-native.mjs --label r4-before        # name the artifact
//   node bench-native.mjs --quick                  # 6 s steady, 20 samples (~20 s total)
//   node bench-native.mjs --tier midrange          # thresholds for a slower client
//   node bench-native.mjs --raf-cap 60             # patch rAF to 60 Hz (display-realistic)
//   node bench-native.mjs --url "http://127.0.0.1:8080/play?game=r4&threads=1"
//
// Writes _runtime/bench-native-<label>.json (and -<label>.png with --shot).
// Exit code is 0 when the measurement completed; --strict makes a failed
// threshold check exit 1. It never starts or stops a server.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import puppeteer from 'puppeteer-core';

const ROOT = '..';
const OUT = path.join(ROOT, '_runtime');
const BRAVE = 'C:/Program Files/BraveSoftware/Brave-Browser/Application/brave.exe';
const SCHEMA = 'rr4.bench.native/1';

function arg(name, def = null) {
  const i = process.argv.indexOf('--' + name);
  if (i === -1) return def;
  const v = process.argv[i + 1];
  return v && !v.startsWith('--') ? v : true;
}
const flag = (name) => !!arg(name, false);

const QUICK = flag('quick');
const LABEL = String(arg('label', 'r4-local')).replace(/[^a-zA-Z0-9._-]/g, '-');
const TIER = String(arg('tier', 'desktop-ref'));
const SECONDS = Number(arg('seconds', QUICK ? 6 : 20));
const SAMPLES = Number(arg('samples', QUICK ? 20 : 60));
const CDP_SAMPLES = Number(arg('cdp-samples', QUICK ? 3 : 6));
const INPUT_GAP_MS = Number(arg('input-gap', QUICK ? 140 : 180));
const SETTLE_MS = Number(arg('settle', QUICK ? 2500 : 3500));
const RAF_CAP = Number(arg('raf-cap', 0)) || 0;
const WIDTH = Number(arg('width', 1280));
const HEIGHT = Number(arg('height', 900));
const URL_ = String(arg('url', 'http://localhost:8080/play?game=r4&threads=0'));
// Dedicated profile: the shared perf-profile is often locked by a leftover
// benchmark browser, and a lock is a hard launch failure. The first run on a
// fresh bench-profile is cold; every later run is warm.
const PROFILE = String(arg('profile', path.join(ROOT, '_runtime', 'bench-profile')));
const SHOT = flag('shot');
const STRICT = flag('strict');
const HEADFUL = flag('headful');
const FRESH = flag('fresh');
const BOOT_TIMEOUT_MS = Number(arg('boot-timeout', 180000));

if (FRESH) fs.rmSync(PROFILE, { recursive: true, force: true });
fs.mkdirSync(PROFILE, { recursive: true });
fs.mkdirSync(OUT, { recursive: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log('[bench]', ...a);
const r1 = (n, d = 1) => (n == null || !Number.isFinite(n) ? null : +n.toFixed(d));

// Windows host load: a parallel 2-core benchmark doubles input p50 and boot
// wall. Record it so two runs are never compared without this context.
async function sampleSystemCpu(ms = 500) {
  const read = () => os.cpus().reduce((a, c) => {
    const t = c.times;
    a.total += t.user + t.nice + t.sys + t.irq + t.idle;
    a.busy += t.user + t.nice + t.sys + t.irq;
    return a;
  }, { total: 0, busy: 0 });
  const a = read();
  await sleep(ms);
  const b = read();
  const dt = b.total - a.total;
  const db = b.busy - a.busy;
  return dt > 0 ? +((db / dt) * 100).toFixed(1) : null;
}
const systemCpuBusyPct = await sampleSystemCpu(500);
log('SYSTEM CPU', systemCpuBusyPct, '%');

// ---------------------------------------------------------------------------
// Threshold contract. Every gate names the hardware class it belongs to.
// reference desktop = this machine (RTX 5090, Brave/Chrome, headless, warm
// IndexedDB, 1280x900). A mid-range laptop or phone is NOT this tier.
// ---------------------------------------------------------------------------
const TIERS = {
  'desktop-ref': {
    label: 'reference desktop: RTX 5090 + Brave headless, warm cache, 1280x900, threads=0',
    checks: [
      { id: 'FPS', metric: 'frame.emuFps', op: '>=', value: 59.5, unit: 'fps', why: 'PCSX-ReARMed must hold NTSC 60' },
      { id: 'FPS-MIN', metric: 'frame.variance.p10BinFps', op: '>=', value: 58.5, unit: 'fps', why: '10th percentile 1 s bin (robust to one hiccup)' },
      { id: 'FPS-FLOOR', metric: 'frame.variance.minBinFps', op: '>=', value: 56, unit: 'fps', why: 'absolute worst 1 s bin' },
      { id: 'STDEV', metric: 'frame.variance.cvPct', op: '<=', value: 2.5, unit: '%', why: 'steady-state coefficient of variation (1 s bins; idle baseline 0.9-1.7 %)' },
      { id: 'P95', metric: 'frame.raf.p95', op: '<=', value: 25, unit: 'ms', when: 'rafCapped', why: 'frame interval p95, only meaningful when rAF is 60 Hz' },
      { id: 'JANK', metric: 'frame.raf.over33Pct', op: '<=', value: 1.0, unit: '%', when: 'rafUncapped', why: 'uncapped headless: share of >33.4 ms frontend gaps' },
      { id: 'IN-P50', metric: 'input.synthetic.p50', op: '<=', value: 30, unit: 'ms', why: 'synthetic p50; idle baseline 13-16 ms, gate tolerates a contended host' },
      { id: 'IN-P95', metric: 'input.synthetic.p95', op: '<=', value: 50, unit: 'ms', why: 'synthetic p95; idle baseline 36-44 ms, 40 ms is the display-path target' },
      { id: 'IN-P99', metric: 'input.synthetic.p99', op: '<=', value: 75, unit: 'ms', why: 'tail: at most ~4.5 core frames' },
      { id: 'IN-2F', metric: 'input.synthetic.within2FramesPct', op: '>=', value: 70, unit: '%', why: 'share of presses sampled within two 60 Hz frames (idle baseline 85-95)' },
      { id: 'BOOT', metric: 'boot.wallMs', op: '<=', value: 8000, unit: 'ms', when: 'warmCache', why: 'warm boot; idle baseline 1.3-4.2 s, 5.9-6.7 s with a parallel benchmark (target 4 s)' },
      { id: 'CPU', metric: 'mainThread.busyPct', op: '<=', value: 70, unit: '%', why: 'renderer main-thread headroom' },
      { id: 'HEAP', metric: 'heap.usedMB', op: '<=', value: 1536, unit: 'MB', why: 'JS heap ceiling, warning only' },
      { id: 'AUDIO', metric: 'audio.afterRun.state', op: '==', value: 'running', unit: '', when: 'always', why: 'AudioContext running after the canvas click' },
      { id: 'AUDIO-UR', metric: 'audio.clock.depthMs.underruns', op: '<=', value: 2, unit: 'bins', why: 'queue starvation bins (05-audio depth method); null when the core exposes no queue fields' },
    ],
  },
  midrange: {
    label: 'mid-range client proxy: CPU-throttled/headful laptop, warm cache, NOT a phone measurement',
    checks: [
      { id: 'FPS', metric: 'frame.emuFps', op: '>=', value: 55, unit: 'fps', why: 'playable 60 target with some slack' },
      { id: 'FPS-MIN', metric: 'frame.variance.p10BinFps', op: '>=', value: 52, unit: 'fps', why: 'worst decile of 1 s bins' },
      { id: 'STDEV', metric: 'frame.variance.cvPct', op: '<=', value: 3.5, unit: '%', why: 'steady-state variance' },
      { id: 'IN-P95', metric: 'input.synthetic.p95', op: '<=', value: 60, unit: 'ms', why: 'input p95' },
      { id: 'BOOT', metric: 'boot.wallMs', op: '<=', value: 12000, unit: 'ms', when: 'warmCache', why: 'warm boot' },
      { id: 'CPU', metric: 'mainThread.busyPct', op: '<=', value: 95, unit: '%', why: 'no headroom left above this' },
      { id: 'AUDIO', metric: 'audio.afterRun.state', op: '==', value: 'running', unit: '', why: 'AudioContext running' },
    ],
  },
};

const getPath = (obj, dotted) => dotted.split('.').reduce((o, k) => (o == null ? null : o[k]), obj);

function evaluateChecks(result, tierKey) {
  const tier = TIERS[tierKey];
  if (!tier) throw new Error(`unknown tier "${tierKey}" (use ${Object.keys(TIERS).join('|')})`);
  const rafCapped = !!result.target.rafCapped;
  const warmCache = !!result.http?.rom?.warmCache;
  const out = [];
  for (const c of tier.checks) {
    if (c.when === 'rafCapped' && !rafCapped) { out.push({ ...c, actual: null, pass: null, skipped: 'rAF uncapped' }); continue; }
    if (c.when === 'rafUncapped' && rafCapped) { out.push({ ...c, actual: null, pass: null, skipped: 'rAF capped' }); continue; }
    if (c.when === 'warmCache' && !warmCache) { out.push({ ...c, actual: null, pass: null, skipped: 'cold cache run' }); continue; }
    const actual = getPath(result, c.metric);
    let pass = null;
    if (actual != null) {
      if (c.op === '>=') pass = actual >= c.value;
      else if (c.op === '<=') pass = actual <= c.value;
      else if (c.op === '==') pass = actual === c.value;
    }
    out.push({ ...c, actual, pass, tier: tierKey });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Launch
// ---------------------------------------------------------------------------
const t0 = Date.now();
const browser = await puppeteer.launch({
  executablePath: BRAVE,
  headless: HEADFUL ? false : 'new',
  userDataDir: PROFILE,
  protocolTimeout: 180000,
  args: [
    '--no-sandbox',
    '--disable-dev-shm-usage',
    '--disable-background-timer-throttling',
    '--disable-renderer-backgrounding',
    '--disable-backgrounding-occluded-windows',
    '--enable-precise-memory-info',
    `--window-size=${WIDTH},${HEIGHT}`,
    '--js-flags=--max-old-space-size=4096',
  ],
  defaultViewport: { width: WIDTH, height: HEIGHT, deviceScaleFactor: 1 },
});
const page = await browser.newPage();
page.setDefaultTimeout(60000);
const browserVersion = await browser.version();

const consoleLog = [];
const pageErrors = [];
const consoleCounts = {};
const httpRequests = [];
const httpResponses = [];
page.on('console', (m) => {
  const t = m.type();
  consoleCounts[t] = (consoleCounts[t] || 0) + 1;
  if (consoleLog.length < 200) consoleLog.push(`[${t}] ${m.text().slice(0, 400)}`);
});
page.on('pageerror', (e) => pageErrors.push(String(e.message).slice(0, 400)));
page.on('request', (r) => {
  const u = r.url();
  if (/\/rom\/|\/bios\/|\/emulator\/|cores\//.test(u)) {
    httpRequests.push({ method: r.method(), url: decodeURIComponent(u).replace(/^https?:\/\/[^/]+/, ''), type: r.resourceType() });
  }
});
page.on('response', async (r) => {
  const u = r.url();
  if (/\/rom\/|\/bios\//.test(u)) {
    const h = r.headers();
    httpResponses.push({
      url: decodeURIComponent(u).replace(/^https?:\/\/[^/]+/, ''),
      status: r.status(),
      contentLength: h['content-length'] ? Number(h['content-length']) : null,
      cacheControl: h['cache-control'] || null,
      contentType: h['content-type'] || null,
      fromCache: typeof r.fromCache === 'function' ? r.fromCache() : null,
    });
  }
});

// Optional rAF cap (same technique as perf-ejs --raf-cap).
if (RAF_CAP > 0) {
  await page.evaluateOnNewDocument((cap) => {
    const delay = 1000 / cap;
    window.requestAnimationFrame = (cb) => setTimeout(() => cb(performance.now()), delay);
    window.cancelAnimationFrame = (id) => clearTimeout(id);
  }, RAF_CAP);
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------
const navT0 = Date.now();
log('NAV', URL_);
await page.goto(URL_, { waitUntil: 'domcontentloaded', timeout: 60000 });

let bootState = null;
let startClicks = 0;
const deadline = Date.now() + BOOT_TIMEOUT_MS;
while (Date.now() < deadline) {
  bootState = await page.evaluate(() => {
    const s = window.__R4;
    const btn = document.querySelector('#game .ejs_start_button');
    const nav = performance.getEntriesByType('navigation')[0];
    const pageEpoch = Date.now() - performance.now();
    return {
      hasState: !!s,
      startedAt: s ? s.startedAt : null,
      startedPerfMs: s && s.startedAt ? Math.round(s.startedAt - pageEpoch) : null,
      bootMs: s ? s.bootMs : null,
      events: s ? s.events : [],
      errors: s ? s.errors : [],
      threads: s ? s.threads : null,
      embedded: s ? s.embedded : null,
      rom: s && s.rom ? { ms: s.rom.ms, mb: s.rom.mb, mbps: s.rom.mbps, loaded: s.rom.loaded, total: s.rom.total, url: s.rom.url } : null,
      canvas: (() => { const c = document.querySelector('#game canvas'); return c ? { w: c.width, h: c.height, cw: c.clientWidth, ch: c.clientHeight } : null; })(),
      navTiming: nav ? {
        domContentLoadedMs: Math.round(nav.domContentLoadedEventEnd),
        loadMs: Math.round(nav.loadEventEnd),
        durationMs: Math.round(nav.duration),
        transferSize: nav.transferSize,
      } : null,
      status: document.querySelector('#bootStatus')?.textContent || null,
      startBtn: !!btn,
      ejs: !!window.EJS_emulator,
      frameNum: window.EJS_emulator?.gameManager?.getFrameNum?.() ?? null,
    };
  });
  if (bootState.startBtn) {
    startClicks++;
    await page.evaluate(() => document.querySelector('#game .ejs_start_button')?.click());
    log('clicked EJS start button');
  }
  if (bootState.startedAt && bootState.ejs) break;
  await sleep(400);
}
const bootWallMs = Date.now() - navT0;
if (!bootState?.startedAt) log('WARN boot not detected before timeout');
log('BOOT', JSON.stringify({ wallMs: bootWallMs, startedPerfMs: bootState?.startedPerfMs, bootMs: bootState?.bootMs, rom: bootState?.rom, errors: bootState?.errors }));

await sleep(SETTLE_MS);

// A real player click: unlocks audio and is also the point where the canvas
// is definitely presenting.
const readAudio = () => page.evaluate(() => {
  const em = window.EJS_emulator;
  const AL = em?.Module?.AL;
  const al = AL?.currentCtx;
  const ctx = al?.audioCtx || em?.Module?.SDL2?.audioContext || em?.audioContext || null;
  let outTs = null;
  try {
    const ts = ctx && ctx.getOutputTimestamp ? ctx.getOutputTimestamp() : null;
    outTs = ts ? { contextTime: ts.contextTime ?? null, performanceTime: ts.performanceTime ?? null } : null;
  } catch { /* ignore */ }
  // Queue depth after 05-audio §1.2 / recommendation #7: newest scheduled end
  // minus the audio clock. Negative depth with live sources = starvation.
  let depthMs = null;
  let queued = 0;
  try {
    const sources = (al?.sources || []).filter((s) => s && typeof s === 'object');
    queued = sources.length;
    let end = null;
    for (const s of sources) {
      let dur = 0;
      try { dur = AL ? AL.sourceDuration(s) : 0; } catch { dur = 0; }
      if (Number.isFinite(dur) && dur > 0) {
        const cur = (s.bufStartTime || 0) + dur - (s.bufOffset || 0);
        if (end == null || cur > end) end = cur;
      }
      // Scheduled head: each queued entry knows its own start+duration. They are
      // small (5.8 ms) sub-buffers, so summing queue length is wrong.
      for (const q of (s.audioQueue || [])) {
        if (q && typeof q._startTime === 'number' && typeof q._duration === 'number') {
          const e = q._startTime + q._duration;
          if (end == null || e > end) end = e;
        }
      }
    }
    if (end != null && ctx) depthMs = +((end - ctx.currentTime) * 1000).toFixed(1);
  } catch { /* ignore */ }
  return {
    present: !!ctx,
    state: ctx ? ctx.state : null,
    sampleRate: ctx ? ctx.sampleRate : null,
    baseLatency: ctx ? ctx.baseLatency ?? null : null,
    outputLatency: ctx ? ctx.outputLatency ?? null : null,
    currentTime: ctx ? +ctx.currentTime.toFixed(3) : null,
    outputTimestamp: outTs,
    sourceCount: al?.sources ? al.sources.length : null,
    runningSources: al?.sources ? al.sources.filter((s) => s?.gain?.context?.state === 'running').length : null,
    queuedSources: queued,
    queueDepthMs: depthMs,
    muted: em?.muted ?? null,
    volume: em?.volume ?? null,
    underrunCounter: depthMs == null ? null : 'derived from AL queue depth (see steady.audioClock.depthMs)',
    underrunMethod: depthMs == null ? 'none: AL source queue fields not exposed by this core build' : 'max(current buffer end, last scheduled audioQueue _startTime+_duration) - currentTime',
  };
});
const audioBefore = await readAudio();
const canvasBox = await page.evaluate(() => {
  const c = document.querySelector('#game canvas');
  if (!c) return null;
  const r = c.getBoundingClientRect();
  return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
});
if (canvasBox) await page.mouse.click(canvasBox.x, canvasBox.y);
await sleep(1200);
const audioAfter = await readAudio();

// ---------------------------------------------------------------------------
// Steady-state window: emulator fps, rAF distribution, 1 s bins, audio clock,
// heap. The emulator frame counter is the primary signal (core-timed 60 Hz);
// headless rAF is uncapped and only a frontend-jank signal.
// ---------------------------------------------------------------------------
const metrics0 = await page.metrics();
const steady = await page.evaluate(async ({ seconds, rafCap }) => {
  const em = window.EJS_emulator;
  const gm = em?.gameManager;
  const canvas = document.querySelector('#game canvas');
  const audioCtxOf = () => {
    const al = em?.Module?.AL?.currentCtx;
    return al?.audioCtx || em?.Module?.SDL2?.audioContext || em?.audioContext || null;
  };
  const frame0 = gm?.getFrameNum?.() ?? null;
  const heap0 = performance.memory ? performance.memory.usedJSHeapSize : null;
  const t0 = performance.now();
  const deltas = [];
  const bins = [];
  const audioClock = { samples: 0, stalls: 0, stallMsTotal: 0, maxDeficitMs: 0, stateChanges: 0, lastState: audioCtxOf()?.state ?? null, depths: [] };
  const queueDepth = (ctx) => {
    const AL = em?.Module?.AL;
    const al = AL?.currentCtx;
    const sources = (al?.sources || []).filter((s) => s && typeof s === 'object');
    let end = null;
    let playing = 0;
    for (const s of sources) {
      // Emscripten OpenAL: state 4114 = AL_PLAYING.
      if (s.state === 4114) playing++;
      let dur = 0;
      try { dur = AL ? AL.sourceDuration(s) : 0; } catch { dur = 0; }
      if (Number.isFinite(dur) && dur > 0) {
        const cur = (s.bufStartTime || 0) + dur - (s.bufOffset || 0);
        if (end == null || cur > end) end = cur;
      }
      // The queued entries are ~5.8 ms sub-buffers; use their own timestamps.
      for (const q of (s.audioQueue || [])) {
        if (q && typeof q._startTime === 'number' && typeof q._duration === 'number') {
          const e = q._startTime + q._duration;
          if (end == null || e > end) end = e;
        }
      }
    }
    return { depthMs: end != null && ctx ? +((end - ctx.currentTime) * 1000).toFixed(1) : null, playing, sources: sources.length };
  };
  let rafCount = 0;
  let last = t0;
  let lastFrame = frame0;
  let lastAudio = audioCtxOf()?.currentTime ?? null;
  let lastBin = t0;
  let binFrame = frame0;
  let binAudio = lastAudio;
  let lastDepthAt = t0;
  const BIN_MS = 1000;
  const DEPTH_MS = 250;

  await new Promise((resolve) => {
    function loop(t) {
      rafCount++;
      const d = t - last;
      last = t;
      if (rafCount > 1 && d < 2000) deltas.push(d);

      if (t - lastDepthAt >= DEPTH_MS) {
        const ctxNow = audioCtxOf();
        if (ctxNow) audioClock.depths.push(queueDepth(ctxNow));
        lastDepthAt = t;
      }

      if (t - lastBin >= BIN_MS) {
        const now = gm?.getFrameNum?.() ?? null;
        const ctx = audioCtxOf();
        const aNow = ctx ? ctx.currentTime : null;
        const wallMs = t - lastBin;
        const isFull = wallMs >= 900;
        if (isFull && now != null && binFrame != null) {
          bins.push({
            atMs: Math.round(lastBin - t0),
            wallMs: Math.round(wallMs),
            frames: now - binFrame,
            fps: +(((now - binFrame) / (wallMs / 1000))).toFixed(2),
            audioAdvance: aNow != null && binAudio != null ? +(aNow - binAudio).toFixed(3) : null,
            ctxState: ctx ? ctx.state : null,
            heapMB: performance.memory ? +(performance.memory.usedJSHeapSize / 1048576).toFixed(1) : null,
          });
        }
        if (aNow != null && binAudio != null) {
          const audioDelta = aNow - binAudio;
          const deficit = (wallMs / 1000) - audioDelta;
          audioClock.samples++;
          if (deficit > (wallMs / 1000) * 0.5) {
            audioClock.stalls++;
            audioClock.stallMsTotal += Math.round(deficit * 1000);
          }
          if (deficit * 1000 > audioClock.maxDeficitMs) audioClock.maxDeficitMs = Math.round(deficit * 1000);
        }
        const state = ctx ? ctx.state : null;
        if (state !== audioClock.lastState) { audioClock.stateChanges++; audioClock.lastState = state; }
        lastBin = t;
        binFrame = now;
        binAudio = aNow;
      }

      if (t - t0 < seconds * 1000) requestAnimationFrame(loop);
      else resolve();
    }
    requestAnimationFrame(loop);
  });

  const elapsed = performance.now() - t0;
  const frame1 = gm?.getFrameNum?.() ?? null;
  const heap1 = performance.memory ? performance.memory.usedJSHeapSize : null;
  const sorted = deltas.slice().sort((a, b) => a - b);
  const q = (p) => (sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))] : null);
  const mean = sorted.length ? sorted.reduce((a, b) => a + b, 0) / sorted.length : null;
  const emuFrames = frame1 != null && frame0 != null ? frame1 - frame0 : null;
  const emuFps = emuFrames != null ? emuFrames / (elapsed / 1000) : null;

  // Variance over complete 1 s bins, first bin dropped (warm-up).
  const steadyBins = bins.slice(bins.length > 5 ? 1 : 0);
  const fpsList = steadyBins.map((b) => b.fps).filter((n) => Number.isFinite(n));
  const fpsSorted = fpsList.slice().sort((a, b) => a - b);
  const qb = (p) => (fpsSorted.length ? fpsSorted[Math.min(fpsSorted.length - 1, Math.floor(fpsSorted.length * p))] : null);
  const bMean = fpsList.length ? fpsList.reduce((a, b) => a + b, 0) / fpsList.length : null;
  const variance = fpsList.length > 1 ? fpsList.reduce((a, b) => a + (b - bMean) ** 2, 0) / (fpsList.length - 1) : null;
  const stddev = variance != null ? Math.sqrt(variance) : null;

  const depthVals = audioClock.depths.map((d) => d.depthMs).filter((n) => n != null);
  audioClock.depthMs = depthVals.length ? {
    n: depthVals.length,
    min: +Math.min(...depthVals).toFixed(1),
    max: +Math.max(...depthVals).toFixed(1),
    mean: +(depthVals.reduce((a, b) => a + b, 0) / depthVals.length).toFixed(1),
    underruns: depthVals.filter((d) => d <= 0).length,
    playingSamples: audioClock.depths.filter((d) => d.playing > 0).length,
    method: '250 ms samples: max(current buffer end, last scheduled audioQueue _startTime+_duration) - currentTime',
  } : { n: 0, underruns: null, playingSamples: 0, method: 'unavailable: core does not expose AL source queue fields' };
  delete audioClock.depths;

  let glRenderer = null, glVendor = null, glVersion = null, webgl2 = false;
  try {
    const gl = canvas ? (canvas.getContext('webgl2') || canvas.getContext('webgl')) : null;
    if (gl) {
      webgl2 = typeof WebGL2RenderingContext !== 'undefined' && gl instanceof WebGL2RenderingContext;
      const ext = gl.getExtension('WEBGL_debug_renderer_info');
      glRenderer = ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER);
      glVendor = ext ? gl.getParameter(ext.UNMASKED_VENDOR_WEBGL) : gl.getParameter(gl.VENDOR);
      glVersion = gl.getParameter(gl.VERSION);
    }
  } catch { /* ignore */ }

  return {
    seconds,
    rafCap: rafCap || 0,
    rafCapped: !!rafCap,
    elapsedMs: +elapsed.toFixed(1),
    rafCount,
    rafFps: rafCount / (elapsed / 1000),
    frame0, frame1, emuFrames, emuFps,
    expectedFramesAt60: Math.round((elapsed / 1000) * 60),
    emulatorDroppedFrames: emuFrames != null ? Math.max(0, Math.round((elapsed / 1000) * 60) - emuFrames) : null,
    raf: {
      mean, p50: q(0.5), p95: q(0.95), p99: q(0.99), max: sorted.length ? sorted[sorted.length - 1] : null,
      over33: deltas.filter((d) => d > 33.4).length,
      over33Pct: deltas.length ? +((deltas.filter((d) => d > 33.4).length / deltas.length) * 100).toFixed(2) : null,
      under12: deltas.filter((d) => d < 12).length,
      count: deltas.length,
    },
    variance: {
      bins: fpsList.length,
      meanFps: bMean,
      stddevFps: stddev,
      cvPct: stddev != null && bMean ? +((stddev / bMean) * 100).toFixed(2) : null,
      minBinFps: fpsList.length ? Math.min(...fpsList) : null,
      p10BinFps: qb(0.10),
      p50BinFps: qb(0.50),
      maxBinFps: fpsList.length ? Math.max(...fpsList) : null,
      droppedBins: fpsList.filter((f) => f < 58).length,
    },
    bins,
    audioClock,
    heap: {
      usedMB: heap1 != null ? +(heap1 / 1048576).toFixed(1) : null,
      startMB: heap0 != null ? +(heap0 / 1048576).toFixed(1) : null,
      growthMB: heap0 != null && heap1 != null ? +((heap1 - heap0) / 1048576).toFixed(1) : null,
      totalMB: performance.memory ? +(performance.memory.totalJSHeapSize / 1048576).toFixed(1) : null,
      limitMB: performance.memory ? +(performance.memory.jsHeapSizeLimit / 1048576).toFixed(1) : null,
    },
    canvas: canvas ? {
      backingW: canvas.width, backingH: canvas.height,
      cssW: canvas.clientWidth, cssH: canvas.clientHeight,
      rectW: +canvas.getBoundingClientRect().width.toFixed(2),
      rectH: +canvas.getBoundingClientRect().height.toFixed(2),
      styleW: canvas.style.width || null, styleH: canvas.style.height || null,
      dpr: window.devicePixelRatio,
      scaleX: canvas.clientWidth ? +(canvas.width / canvas.clientWidth).toFixed(3) : null,
      scaleY: canvas.clientHeight ? +(canvas.height / canvas.clientHeight).toFixed(3) : null,
      imageRendering: getComputedStyle(canvas).imageRendering,
      objectFit: getComputedStyle(canvas).objectFit,
    } : null,
    gpu: { renderer: glRenderer, vendor: glVendor, version: glVersion, webgl2 },
    crossOriginIsolated: window.crossOriginIsolated,
    sharedArrayBuffer: typeof window.SharedArrayBuffer,
    hardwareConcurrency: navigator.hardwareConcurrency,
    deviceMemory: navigator.deviceMemory ?? null,
    visibility: document.visibilityState,
    paused: em?.paused ?? null,
    started: em?.started ?? null,
    core: (() => { try { return em?.getCore?.() ?? null; } catch { return null; } })(),
    coreName: em?.coreName ?? null,
    videoDims: (() => { try { return { base: gm?.getVideoDimensions?.('base'), aspect: gm?.getVideoDimensions?.('aspect') }; } catch { return 'ERR'; } })(),
    settings: {
      fps: em?.getSettingValue?.('fps') ?? null,
      threads: em?.getSettingValue?.('ejs_threads') ?? null,
      shader: em?.getSettingValue?.('shader') ?? null,
    },
    coreOptions: (() => { try { return gm?.getCoreOptions?.() ?? null; } catch { return null; } })(),
  };
}, { seconds: SECONDS, rafCap: RAF_CAP });
const metrics1 = await page.metrics();

const cpu = {};
for (const k of ['TaskDuration', 'ScriptDuration', 'LayoutDuration', 'RecalcStyleDuration', 'V8CompileDuration']) {
  if (typeof metrics0[k] === 'number' && typeof metrics1[k] === 'number') cpu[k] = +(metrics1[k] - metrics0[k]).toFixed(3);
}
cpu.wallSeconds = +(steady.elapsedMs / 1000).toFixed(2);
cpu.busyPct = cpu.TaskDuration != null && cpu.wallSeconds ? +((cpu.TaskDuration / cpu.wallSeconds) * 100).toFixed(1) : null;
cpu.scriptPct = cpu.ScriptDuration != null && cpu.wallSeconds ? +((cpu.ScriptDuration / cpu.wallSeconds) * 100).toFixed(1) : null;
log('FRAME', JSON.stringify({
  emuFps: r1(steady.emuFps, 2), rafFps: r1(steady.rafFps, 1),
  p50: r1(steady.raf.p50, 2), p95: r1(steady.raf.p95, 2), p99: r1(steady.raf.p99, 2),
  cvPct: steady.variance.cvPct, minBin: steady.variance.minBinFps,
  dropped: steady.emulatorDroppedFrames, busyPct: cpu.busyPct,
}));

// ---------------------------------------------------------------------------
// Input latency: 50x synthetic keydown -> next getFrameNum increment.
// Synthetic events are optimistic (no OS/browser input path); CDP presses give
// an upper bound that includes the protocol round-trip.
// ---------------------------------------------------------------------------
const input = await page.evaluate(async ({ trials, gapMs }) => {
  const gm = window.EJS_emulator?.gameManager;
  const parent = document.querySelector('#game');
  if (!gm || !parent) return null;
  const make = (type) => {
    const ev = new KeyboardEvent(type, { key: 'ArrowLeft', code: 'ArrowLeft', bubbles: true, cancelable: true });
    Object.defineProperty(ev, 'keyCode', { get: () => 37 });
    Object.defineProperty(ev, 'which', { get: () => 37 });
    return ev;
  };
  const out = [];
  for (let i = 0; i < trials; i++) {
    await new Promise((r) => setTimeout(r, gapMs));
    const before = gm.getFrameNum();
    const t0 = performance.now();
    parent.dispatchEvent(make('keydown'));
    const dt = await new Promise((res) => {
      const check = () => {
        if (gm.getFrameNum() > before) res(performance.now() - t0);
        else requestAnimationFrame(check);
      };
      requestAnimationFrame(check);
    });
    parent.dispatchEvent(make('keyup'));
    out.push(+dt.toFixed(2));
  }
  const sorted = out.slice().sort((a, b) => a - b);
  const q = (p) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))];
  return {
    trials: out.length,
    p50: q(0.5), p95: q(0.95), p99: q(0.99),
    min: sorted[0], max: sorted[sorted.length - 1],
    within2FramesPct: +((out.filter((s) => s <= 34).length / out.length) * 100).toFixed(1),
    samples: out,
    method: 'in-page KeyboardEvent(ArrowLeft) on #game -> next getFrameNum() increment',
    caveat: 'quantised by the 60 Hz core frame (16.7 ms); excludes display compositing',
  };
}, { trials: SAMPLES, gapMs: INPUT_GAP_MS });
log('INPUT', JSON.stringify({ trials: input?.trials, p50: input?.p50, p95: input?.p95, p99: input?.p99, max: input?.max }));

let cdpInput = null;
if (CDP_SAMPLES > 0) {
  const samples = [];
  for (let i = 0; i < CDP_SAMPLES; i++) {
    await sleep(220);
    const before = await page.evaluate(() => window.EJS_emulator?.gameManager?.getFrameNum?.() ?? null);
    if (before == null) break;
    const t = performance.now();
    await page.keyboard.down('ArrowRight');
    let dt = null;
    for (let j = 0; j < 90; j++) {
      const n = await page.evaluate(() => window.EJS_emulator?.gameManager?.getFrameNum?.() ?? null);
      if (n != null && n > before) { dt = performance.now() - t; break; }
      await sleep(1);
    }
    await page.keyboard.up('ArrowRight');
    if (dt != null) samples.push(+dt.toFixed(2));
  }
  samples.sort((a, b) => a - b);
  const q = (p) => (samples.length ? samples[Math.min(samples.length - 1, Math.floor(samples.length * p))] : null);
  cdpInput = {
    trials: samples.length, p50: q(0.5), p95: q(0.95), max: samples.length ? samples[samples.length - 1] : null,
    samples,
    method: 'CDP page.keyboard.down -> next getFrameNum() increment',
    caveat: 'includes Node->browser CDP round-trips; upper bound',
  };
  log('CDP-INPUT', JSON.stringify({ trials: cdpInput.trials, p50: cdpInput.p50, p95: cdpInput.p95, max: cdpInput.max }));
}

// ---------------------------------------------------------------------------
// Audio, cache, boot resources (read after the run so timers are settled).
// ---------------------------------------------------------------------------
const audioAfterRun = await readAudio();
const resources = await page.evaluate(() => performance.getEntriesByType('resource')
  .filter((e) => /\/rom\/|\/bios\/|\/emulator\/|cores\//.test(e.name))
  .map((e) => ({
    name: decodeURIComponent(e.name).replace(/^https?:\/\/[^/]+/, ''),
    initiatorType: e.initiatorType,
    startTime: +e.startTime.toFixed(1),
    responseStart: +e.responseStart.toFixed(1),
    responseEnd: +e.responseEnd.toFixed(1),
    duration: +e.duration.toFixed(1),
    transferBytes: e.transferSize,
    encodedBytes: e.encodedBodySize,
    decodedBytes: e.decodedBodySize,
    nextHopProtocol: e.nextHopProtocol || null,
    responseStatus: e.responseStatus ?? null,
  })));
const navTiming = await page.evaluate(() => {
  const nav = performance.getEntriesByType('navigation')[0];
  const pageEpoch = Date.now() - performance.now();
  const s = window.__R4;
  return {
    domContentLoadedMs: nav ? Math.round(nav.domContentLoadedEventEnd) : null,
    loadMs: nav ? Math.round(nav.loadEventEnd) : null,
    pageLoadToStartMs: s && s.startedAt ? Math.round(s.startedAt - pageEpoch) : null,
    events: s ? s.events : [],
  };
});
const cache = await page.evaluate(async () => {
  const out = { databases: [], rom: null, bios: null, storage: null, persisted: null };
  try { out.databases = (await indexedDB.databases()).map((d) => d.name); } catch (e) { out.databases = ['ERR ' + e.message]; }
  if (!navigator.storage) { out.storage = 'undefined (insecure origin)'; out.persisted = 'undefined (insecure origin)'; }
  else {
    try { out.storage = await navigator.storage.estimate(); } catch (e) { out.storage = { error: String(e) }; }
    try { out.persisted = await navigator.storage.persisted(); } catch (e) { out.persisted = String(e); }
  }
  const readStore = (dbName, storeName) => new Promise((resolve) => {
    let req;
    try { req = indexedDB.open(dbName); } catch (e) { return resolve({ error: String(e) }); }
    req.onerror = () => resolve({ error: 'open failed' });
    req.onsuccess = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(storeName)) { db.close(); return resolve({ keys: [] }); }
      const st = db.transaction([storeName], 'readonly').objectStore(storeName);
      const keysReq = st.getAllKeys();
      keysReq.onerror = () => { db.close(); resolve({ error: 'getAllKeys failed' }); };
      keysReq.onsuccess = async () => {
        const keys = keysReq.result.filter((k) => k !== '?EJS_KEYS!');
        const entries = [];
        for (const k of keys.slice(0, 4)) {
          const v = await new Promise((res) => {
            const g = st.get(k);
            g.onsuccess = () => res(g.result);
            g.onerror = () => res(null);
          });
          entries.push({
            key: k,
            contentLength: v && v['content-length'] != null ? Number(v['content-length']) : null,
            byteLength: v && v.data && typeof v.data.byteLength === 'number' ? v.data.byteLength : null,
          });
        }
        db.close();
        resolve({ keys: keys.length, entries });
      };
    };
  });
  out.rom = await readStore('EmulatorJS-roms', 'rom');
  out.bios = await readStore('EmulatorJS-bios', 'bios');
  return out;
});

const romResources = resources.filter((r) => /\/rom\//.test(r.name));
const romResponses = httpResponses.filter((r) => /\/rom\//.test(r.url));
const romGet = httpRequests.filter((r) => /\/rom\//.test(r.url) && r.method === 'GET');
const romHead = httpRequests.filter((r) => /\/rom\//.test(r.url) && r.method === 'HEAD');
const romDownloadedBytes = romResources.reduce((a, r) => a + (r.decodedBytes || 0), 0);
// Cache hit = no disc body crossed the network this run. A Range probe can
// still report a few hundred bytes; the ROM itself is hundreds of megabytes.
const romCacheHit = romResources.length ? romDownloadedBytes < 1024 : null;
// Warm = no real disc body crossed the network this run. A Range probe or a
// HEAD can still show ~300 transfer bytes; 1 MiB is a safe separator.
const warmCache = romDownloadedBytes < 1048576;

if (SHOT) {
  const shotPath = path.join(OUT, `bench-native-${LABEL}.png`);
  await page.screenshot({ path: shotPath });
  log('SHOT', shotPath);
}

// ---------------------------------------------------------------------------
// Assemble, evaluate, write.
// ---------------------------------------------------------------------------
const result = {
  schema: SCHEMA,
  label: LABEL,
  tier: TIER,
  generatedAt: new Date().toISOString(),
  durationMs: Date.now() - t0,
  target: {
    url: URL_, viewport: { width: WIDTH, height: HEIGHT }, headless: !HEADFUL,
    profile: PROFILE, rafCap: RAF_CAP || 0, rafCapped: RAF_CAP > 0,
    seconds: SECONDS, inputSamples: SAMPLES, cdpSamples: CDP_SAMPLES,
  },
  env: {
    platform: `${os.platform()} ${os.release()}`,
    hostname: os.hostname(),
    cpu: (os.cpus()[0] || {}).model || null,
    cpuCount: os.cpus().length,
    ramGB: +(os.totalmem() / 1073741824).toFixed(1),
    systemCpuBusyPct,
    contended: systemCpuBusyPct != null ? systemCpuBusyPct > 40 : null,
    node: process.version,
    browser: browserVersion,
    userAgent: await page.evaluate(() => navigator.userAgent),
    hardwareConcurrency: steady.hardwareConcurrency,
    deviceMemory: steady.deviceMemory,
    gpu: steady.gpu,
    dpr: steady.canvas?.dpr ?? null,
    crossOriginIsolated: steady.crossOriginIsolated,
    sharedArrayBuffer: steady.sharedArrayBuffer,
  },
  boot: {
    wallMs: bootWallMs,
    gameStartMs: navTiming.pageLoadToStartMs,
    r4BootMs: bootState?.bootMs ?? null,
    startClicks,
    navTiming: bootState?.navTiming ?? null,
    rom: bootState?.rom ?? null,
    events: navTiming.events,
    transition: 'nav start -> __R4.startedAt (first emulated frame)',
  },
  frame: {
    emuFps: r1(steady.emuFps, 2),
    rafFps: r1(steady.rafFps, 1),
    frames: { start: steady.frame0, end: steady.frame1, emulated: steady.emuFrames, expectedAt60: steady.expectedFramesAt60, dropped: steady.emulatorDroppedFrames },
    raf: {
      count: steady.raf.count,
      mean: r1(steady.raf.mean, 2), p50: r1(steady.raf.p50, 2), p95: r1(steady.raf.p95, 2),
      p99: r1(steady.raf.p99, 2), max: r1(steady.raf.max, 2),
      over33: steady.raf.over33, over33Pct: steady.raf.over33Pct, under12: steady.raf.under12,
    },
    variance: {
      bins: steady.variance.bins, meanFps: r1(steady.variance.meanFps, 2),
      stddevFps: r1(steady.variance.stddevFps, 3), cvPct: steady.variance.cvPct,
      minBinFps: r1(steady.variance.minBinFps, 2), maxBinFps: r1(steady.variance.maxBinFps, 2),
      p10BinFps: r1(steady.variance.p10BinFps, 2), p50BinFps: r1(steady.variance.p50BinFps, 2),
      droppedBins: steady.variance.droppedBins,
      binSeconds: 1, note: 'complete 1 s bins, first bin dropped',
    },
    bins: steady.bins,
    visibility: steady.visibility,
    paused: steady.paused,
    core: steady.core,
    coreName: steady.coreName,
    videoDims: steady.videoDims,
    settings: steady.settings,
    coreOptions: steady.coreOptions,
  },
  mainThread: cpu,
  input: { synthetic: input, cdp: cdpInput },
  audio: {
    beforeClick: audioBefore,
    afterClick: audioAfter,
    afterRun: audioAfterRun,
    clock: steady.audioClock,
    note: 'baseLatency/outputLatency are AudioContext fields, not an acoustic loopback. No underrun counter exists in EJS 4.2.3; clock deficits are a stall proxy.',
  },
  heap: steady.heap,
  canvas: steady.canvas,
  resources,
  http: {
    requests: httpRequests,
    responses: httpResponses,
    rom: {
      gets: romGet.length, heads: romHead.length,
      viaIndexedDb: !!(cache.rom && cache.rom.keys > 0),
      cacheHit: romCacheHit,
      warmCache,
      downloadedBytes: romDownloadedBytes,
      resourceEntries: romResources,
      transferBytes: romResources.reduce((a, r) => a + (r.transferBytes || 0), 0),
      decodedBytes: romResources.reduce((a, r) => a + (r.decodedBytes || 0), 0),
    },
  },
  cache,
  console: {
    counts: consoleCounts,
    pageErrors,
    tail: consoleLog.slice(-40),
    note: 'expected noise: plain-HTTP COOP/COEP warning, netplay empty-ICE warning, EJS core-option notices',
  },
};

result.checks = evaluateChecks(result, TIER);
result.outcome = {
  pass: result.checks.every((c) => c.pass !== false),
  evaluated: result.checks.filter((c) => c.pass != null).length,
  skipped: result.checks.filter((c) => c.pass == null).length,
  failed: result.checks.filter((c) => c.pass === false).map((c) => c.id),
};

const outPath = path.join(OUT, `bench-native-${LABEL}.json`);
fs.writeFileSync(outPath, JSON.stringify(result, null, 2));

// ---------------------------------------------------------------------------
// Human summary.
// ---------------------------------------------------------------------------
const fmt = (v, u = '') => (v == null ? 'n/a' : `${v}${u}`);
console.log('');
console.log(`BENCH NATIVE  ${LABEL}  tier=${TIER}  ${result.durationMs} ms`);
console.log(`  url       ${URL_}  ${WIDTH}x${HEIGHT}  ${HEADFUL ? 'headful' : 'headless'}  rafCap=${RAF_CAP || 'off'}`);
console.log(`  gpu       ${steady.gpu.renderer || 'n/a'}`);
console.log(`  fps       emu ${fmt(result.frame.emuFps)} / raf ${fmt(result.frame.rafFps)}   cv ${fmt(result.frame.variance.cvPct, '%')}  p10 ${fmt(result.frame.variance.p10BinFps)}  min ${fmt(result.frame.variance.minBinFps)}  dropped ${fmt(result.frame.frames.dropped)}`);
console.log(`  rAF       p50 ${fmt(result.frame.raf.p50, 'ms')}  p95 ${fmt(result.frame.raf.p95, 'ms')}  p99 ${fmt(result.frame.raf.p99, 'ms')}  >33.4ms ${fmt(result.frame.raf.over33Pct, '%')}`);
console.log(`  input     p50 ${fmt(input?.p50, 'ms')}  p95 ${fmt(input?.p95, 'ms')}  p99 ${fmt(input?.p99, 'ms')}  <=2f ${fmt(input?.within2FramesPct, '%')}  (n=${input?.trials ?? 0})   cdp p95 ${fmt(cdpInput?.p95, 'ms')}`);
console.log(`  boot      ${fmt(result.boot.wallMs, 'ms')} ${result.http.rom.warmCache ? 'warm' : 'cold'}   gameStart ${fmt(result.boot.gameStartMs, 'ms')}   rom ${result.boot.rom ? result.boot.rom.mb + ' MB in ' + result.boot.rom.ms + ' ms' : 'cached (no download)'}`);
console.log(`  cpu       busy ${fmt(cpu.busyPct, '%')}  script ${fmt(cpu.scriptPct, '%')}   heap ${fmt(result.heap.usedMB, ' MB')} (${fmt(result.heap.growthMB, ' MB')} growth)   hostCpu ${fmt(systemCpuBusyPct, '%')}${result.env.contended ? ' CONTENDED' : ''}`);
console.log(`  audio     ${fmt(audioAfterRun.state)}  ${fmt(audioAfterRun.sampleRate, ' Hz')}  base ${fmt(audioAfterRun.baseLatency, 's')}  out ${fmt(audioAfterRun.outputLatency, 's')}  depth ${fmt(steady.audioClock.depthMs?.min, '..' + fmt(steady.audioClock.depthMs?.max, ' ms'))}  underruns ${fmt(steady.audioClock.depthMs?.underruns)}/${fmt(steady.audioClock.depthMs?.n)}`);
console.log(`  canvas    ${fmt(steady.canvas?.backingW)}x${fmt(steady.canvas?.backingH)} backing / ${fmt(steady.canvas?.cssW)}x${fmt(steady.canvas?.cssH)} css  dpr ${fmt(steady.canvas?.dpr)}  ${steady.canvas?.imageRendering || ''}`);
console.log(`  isolation crossOriginIsolated=${steady.crossOriginIsolated}  SharedArrayBuffer=${steady.sharedArrayBuffer}`);
console.log(`  rom       GET ${romGet.length}  HEAD ${romHead.length}  cacheHit=${romCacheHit}  downloaded ${result.http.rom.downloadedBytes} B`);
console.log('');
for (const c of result.checks) {
  const mark = c.pass === true ? 'PASS' : c.pass === false ? 'FAIL' : 'SKIP';
  console.log(`  ${mark.padEnd(4)} ${String(c.id).padEnd(8)} ${String(c.metric).padEnd(28)} ${String(c.actual ?? (c.skipped || 'n/a')).padStart(9)} ${c.op} ${c.value}${c.unit || ''}`);
}
console.log(`\n  ${result.outcome.pass ? 'OK' : 'THRESHOLD FAIL'}  ${result.outcome.evaluated} evaluated, ${result.outcome.skipped} skipped${result.outcome.failed.length ? ', failed: ' + result.outcome.failed.join(',') : ''}`);
console.log(`  WROTE ${outPath}`);

await browser.close();
if (STRICT && !result.outcome.pass) process.exitCode = 1;
