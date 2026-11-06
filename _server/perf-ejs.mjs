// Measure EmulatorJS / PCSX-ReARMed performance in headless Brave.
// Usage: node perf-ejs.mjs --url <url> --label <name> [--seconds 10] [--profile <dir>] [--fresh]
// Writes _runtime/perf/<label>.json and a screenshot.
import fs from 'node:fs';
import path from 'node:path';
import puppeteer from 'puppeteer-core';

const BRAVE = 'C:/Program Files/BraveSoftware/Brave-Browser/Application/brave.exe';
const ROOT = '..';
const OUT = path.join(ROOT, '_runtime', 'perf');
fs.mkdirSync(OUT, { recursive: true });

function arg(name, def = null) {
  const i = process.argv.indexOf('--' + name);
  if (i === -1) return def;
  const v = process.argv[i + 1];
  return v && !v.startsWith('--') ? v : true;
}

const URL_ = arg('url', 'http://localhost:8080/play?threads=0');
const LABEL = arg('label', 'run');
const SECONDS = Number(arg('seconds', 10));
const PROFILE = arg('profile', path.join(ROOT, '_runtime', 'perf-profile'));
const FRESH = !!arg('fresh', false);
const BOOT_TIMEOUT_MS = Number(arg('boot-timeout', 360000));
const EXTRA_ARGS = String(arg('args', '') || '').split(' ').filter(Boolean);
const CORE = arg('core', null);
const OPTS = arg('opts', null);
const SHADER = arg('shader', null);
const FRESH_LOCALSTORAGE = !!arg('fresh-localstorage', false);
const RAF_CAP = Number(arg('raf-cap', 0)) || 0;
const OPT_PAIRS = [];
for (let i = 0; i < process.argv.length; i++) {
  if (process.argv[i] === '--opt' && process.argv[i + 1]) {
    const kv = process.argv[i + 1];
    const eq = kv.indexOf('=');
    if (eq > 0) OPT_PAIRS.push([kv.slice(0, eq), kv.slice(eq + 1)]);
  }
}
const CPU_THROTTLE = Number(arg('cpu-throttle', 0)) || 0;
const VIEWPORT = String(arg('viewport', '1280x900')).split('x').map((n) => Number(n) || 0);
const MOBILE = !!arg('mobile', false);
const FF_SECONDS = Number(arg('ff-seconds', 0)) || 0;

if (FRESH) fs.rmSync(PROFILE, { recursive: true, force: true });
fs.mkdirSync(PROFILE, { recursive: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(`[${LABEL}]`, ...a);

const browser = await puppeteer.launch({
  executablePath: BRAVE,
  headless: 'new',
  userDataDir: PROFILE,
  args: [
    '--no-sandbox',
    '--disable-dev-shm-usage',
    '--disable-background-timer-throttling',
    '--disable-renderer-backgrounding',
    '--disable-backgrounding-occluded-windows',
    '--window-size=1280,900',
    '--js-flags=--max-old-space-size=4096',
    ...EXTRA_ARGS,
  ],
  defaultViewport: {
    width: VIEWPORT[0] || 1280,
    height: VIEWPORT[1] || 900,
    isMobile: MOBILE,
    hasTouch: MOBILE,
    deviceScaleFactor: MOBILE ? 3 : 1,
  },
});

const page = await browser.newPage();
const consoleLog = [];
const requests = [];
const responses = [];

// Optional pre-load hooks: force a core, seed EJS_defaultOptions, or clear
// only the per-origin settings (keeps IndexedDB ROM cache intact).
if (CORE || OPTS || SHADER || FRESH_LOCALSTORAGE || RAF_CAP || OPT_PAIRS.length) {
  await page.evaluateOnNewDocument((core, opts, shader, clearLs, rafCap, optPairs) => {
    try { if (clearLs) localStorage.clear(); } catch (e) { /* ignore */ }
    if (rafCap > 0) {
      const delay = 1000 / rafCap;
      window.requestAnimationFrame = (cb) => setTimeout(() => cb(performance.now()), delay);
      window.cancelAnimationFrame = (id) => clearTimeout(id);
    }
    const defaults = {};
    if (opts) { try { Object.assign(defaults, JSON.parse(opts)); } catch (e) { console.warn('bad --opts', e.message); } }
    for (const [k, v] of optPairs) defaults[k] = v;
    if (shader) defaults.shader = shader;
    if (Object.keys(defaults).length) window.EJS_defaultOptions = defaults;
    if (core) {
      // play.js assigns window.EJS_core = 'psx'; ignore that assignment so the
      // loader sees the requested core instead.
      Object.defineProperty(window, 'EJS_core', {
        configurable: true,
        get: () => core,
        set: () => { /* keep requested core */ },
      });
    }
  }, CORE, OPTS, SHADER, FRESH_LOCALSTORAGE, RAF_CAP, OPT_PAIRS);
}

page.on('console', (m) => consoleLog.push(`[${m.type()}] ${m.text()}`));
page.on('pageerror', (e) => consoleLog.push('[pageerror] ' + e.message));
page.on('request', (r) => {
  const u = r.url();
  if (/\/rom\/|\/bios\/|cores\/|\.data(\?|$)/.test(u)) {
    requests.push({ method: r.method(), url: decodeURIComponent(u), type: r.resourceType() });
  }
});
page.on('response', async (r) => {
  const u = r.url();
  if (/\/rom\/|\/bios\//.test(u)) {
    const h = r.headers();
    responses.push({
      url: decodeURIComponent(u), status: r.status(),
      contentLength: h['content-length'] || null,
      cacheControl: h['cache-control'] || null,
      fromCache: r.fromCache ? r.fromCache() : null,
      fromServiceWorker: r.fromServiceWorker ? r.fromServiceWorker() : null,
    });
  }
});

const t0 = Date.now();
log('NAV', URL_);
await page.goto(URL_, { waitUntil: 'domcontentloaded', timeout: 60000 });

let boot = null;
let last = null;
const deadline = Date.now() + BOOT_TIMEOUT_MS;
let startClicks = 0;
while (Date.now() < deadline) {
  last = await page.evaluate(() => {
    const s = window.__R4;
    const c = document.querySelector('#game canvas');
    const btn = document.querySelector('#game .ejs_start_button');
    return {
      hasState: !!s,
      startedAt: s ? s.startedAt : null,
      bootMs: s ? s.bootMs : null,
      readyAt: s ? s.readyAt : null,
      events: s ? s.events.map((e) => e.name) : [],
      errors: s ? s.errors : [],
      threads: s ? s.threads : null,
      rom: s && s.rom ? { ms: s.rom.ms, mb: s.rom.mb, mbps: s.rom.mbps, loaded: s.rom.loaded } : null,
      canvas: c ? { w: c.width, h: c.height, cw: c.clientWidth, ch: c.clientHeight } : null,
      status: document.querySelector('#bootStatus')?.textContent || null,
      overlay: document.querySelector('#overlayText')?.textContent || null,
      loadingText: document.querySelector('#game .ejs_loading_text')?.innerText || null,
      startBtn: !!btn,
      ejs: !!window.EJS_emulator,
      frameNum: window.EJS_emulator?.gameManager?.getFrameNum?.() ?? null,
    };
  });
  if (last.startBtn) {
    startClicks++;
    await page.evaluate(() => document.querySelector('#game .ejs_start_button')?.click());
    log('clicked EJS start button');
  }
  if (last.startedAt && last.ejs) break;
  if (Date.now() - t0 > 20000 && Date.now() % 2 === 0) {
    // keep the log readable
  }
  await sleep(1000);
}
boot = { ...last, wallMs: Date.now() - t0, startClicks };
log('BOOT', JSON.stringify({ wallMs: boot.wallMs, bootMs: boot.bootMs, rom: boot.rom, canvas: boot.canvas, errors: boot.errors }));

// Let the intro run a moment so frame counters are warm.
await sleep(4000);

// Optional: fast-forward through the long R4 intro to reach a 3D race/demo,
// then measure there instead of on the intro FMV.
if (FF_SECONDS > 0) {
  await page.evaluate(() => window.EJS_emulator.gameManager.toggleFastForward(1));
  log('fast-forward on for', FF_SECONDS + 's');
  await sleep(FF_SECONDS * 1000);
  await page.evaluate(() => window.EJS_emulator.gameManager.toggleFastForward(0));
  await sleep(1200);
  log('fast-forward off');
}

// --- audio state before any click -------------------------------------
const audioBefore = await page.evaluate(() => {
  const AL = window.EJS_emulator?.Module?.AL;
  const ctx = AL?.currentCtx?.audioCtx;
  return {
    hasAL: !!AL,
    state: ctx ? ctx.state : null,
    sampleRate: ctx ? ctx.sampleRate : null,
    baseLatency: ctx ? ctx.baseLatency : null,
    outputLatency: ctx ? ctx.outputLatency : null,
    sourceStates: AL?.currentCtx?.sources ? AL.currentCtx.sources.map((s) => s.gain?.context?.state || null) : null,
    muted: window.EJS_emulator?.muted ?? null,
    volume: window.EJS_emulator?.volume ?? null,
  };
});

// Click the canvas once (this is what a real player does), then re-read.
const canvasBox = await page.evaluate(() => {
  const c = document.querySelector('#game canvas');
  if (!c) return null;
  const r = c.getBoundingClientRect();
  return { x: r.x + r.width / 2, y: r.y + r.height / 2, w: r.width, h: r.height };
});
if (canvasBox) await page.mouse.click(canvasBox.x, canvasBox.y);
await sleep(1200);
const audioAfterClick = await page.evaluate(() => {
  const AL = window.EJS_emulator?.Module?.AL;
  const ctx = AL?.currentCtx?.audioCtx;
  return {
    state: ctx ? ctx.state : null,
    sampleRate: ctx ? ctx.sampleRate : null,
    baseLatency: ctx ? ctx.baseLatency : null,
    outputLatency: ctx ? ctx.outputLatency : null,
  };
});

// --- 10s rAF + emulator frame count -----------------------------------
let cdpClient = null;
if (CPU_THROTTLE > 0) {
  cdpClient = await page.createCDPSession();
  await cdpClient.send('Emulation.setCPUThrottlingRate', { rate: CPU_THROTTLE });
  log('CPU throttle', CPU_THROTTLE + 'x');
}
const metrics0 = await page.metrics();
const perf = await page.evaluate(async (seconds) => {
  const s = window.__R4;
  const emu = window.EJS_emulator;
  const gm = emu?.gameManager;
  const canvas = document.querySelector('#game canvas');
  const frame0 = gm?.getFrameNum?.() ?? null;
  const t0 = performance.now();
  const deltas = [];
  let rafCount = 0;
  let last = t0;
  await new Promise((resolve) => {
    function loop(t) {
      rafCount++;
      const d = t - last;
      last = t;
      if (rafCount > 1) deltas.push(d);
      if (t - t0 < seconds * 1000) requestAnimationFrame(loop);
      else resolve();
    }
    requestAnimationFrame(loop);
  });
  const elapsed = performance.now() - t0;
  const frame1 = gm?.getFrameNum?.() ?? null;
  const sorted = deltas.slice().sort((a, b) => a - b);
  const q = (p) => (sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))] : null);
  const mean = sorted.length ? sorted.reduce((a, b) => a + b, 0) / sorted.length : null;
  const gl = canvas ? (canvas.getContext('webgl2') || canvas.getContext('webgl')) : null;
  let glRenderer = null;
  if (gl) {
    const ext = gl.getExtension('WEBGL_debug_renderer_info');
    glRenderer = ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER);
  }
  return {
    seconds,
    elapsedMs: +elapsed.toFixed(1),
    rafCount,
    rafFps: +(rafCount / (elapsed / 1000)).toFixed(2),
    frame0,
    frame1,
    emuFrames: frame1 != null && frame0 != null ? frame1 - frame0 : null,
    emuFps: frame1 != null && frame0 != null ? +(((frame1 - frame0) / (elapsed / 1000))).toFixed(2) : null,
    rafDelta: {
      mean: mean != null ? +mean.toFixed(2) : null,
      p50: q(0.5) != null ? +q(0.5).toFixed(2) : null,
      p95: q(0.95) != null ? +q(0.95).toFixed(2) : null,
      p99: q(0.99) != null ? +q(0.99).toFixed(2) : null,
      max: sorted.length ? +sorted[sorted.length - 1].toFixed(2) : null,
      under20ms: deltas.filter((d) => d < 20).length,
      over33ms: deltas.filter((d) => d > 33.4).length,
    },
    canvas: canvas ? {
      width: canvas.width, height: canvas.height,
      clientWidth: canvas.clientWidth, clientHeight: canvas.clientHeight,
      rectW: +canvas.getBoundingClientRect().width.toFixed(1),
      rectH: +canvas.getBoundingClientRect().height.toFixed(1),
      styleW: canvas.style.width || null, styleH: canvas.style.height || null,
      dpr: window.devicePixelRatio,
      glRenderer,
    } : null,
    visibility: document.visibilityState,
    crossOriginIsolated: window.crossOriginIsolated,
    sharedArrayBuffer: typeof window.SharedArrayBuffer,
    hardwareConcurrency: navigator.hardwareConcurrency,
    deviceMemory: navigator.deviceMemory ?? null,
    paused: emu?.paused ?? null,
    started: emu?.started ?? null,
    menuOpen: emu?.menu?.isOpen ?? null,
    core: emu?.getCore?.() ?? null,
    coreName: emu?.coreName ?? null,
    coreOptions: (() => { try { return gm?.getCoreOptions?.() ?? null; } catch (e) { return 'ERR ' + e.message; } })(),
    videoDims: (() => { try { return { base: gm?.getVideoDimensions?.('base'), aspect: gm?.getVideoDimensions?.('aspect') }; } catch (e) { return 'ERR ' + e.message; } })(),
    settings: {
      fps: emu?.getSettingValue?.('fps') ?? null,
      threads: emu?.getSettingValue?.('ejs_threads') ?? null,
      shader: emu?.getSettingValue?.('shader') ?? null,
      videoRotation: emu?.getSettingValue?.('videoRotation') ?? null,
    },
    memory: performance.memory ? {
      usedJSHeapMB: +(performance.memory.usedJSHeapSize / 1048576).toFixed(1),
      totalJSHeapMB: +(performance.memory.totalJSHeapSize / 1048576).toFixed(1),
    } : null,
    r4: s ? { threads: s.threads, bootMs: s.bootMs, rom: s.rom ? { ms: s.rom.ms, mb: s.rom.mb, mbps: s.rom.mbps } : null } : null,
  };
}, SECONDS);
const metrics1 = await page.metrics();
const cpu = {};
for (const k of ['TaskDuration', 'ScriptDuration', 'LayoutDuration', 'RecalcStyleDuration', 'V8CompileDuration', 'DevToolsCommandDuration']) {
  if (typeof metrics0[k] === 'number' && typeof metrics1[k] === 'number') {
    cpu[k] = +(metrics1[k] - metrics0[k]).toFixed(3);
  }
}
cpu.wallSeconds = +((perf.elapsedMs || 0) / 1000).toFixed(2);
cpu.mainThreadBusyPct = cpu.TaskDuration != null && cpu.wallSeconds ? +((cpu.TaskDuration / cpu.wallSeconds) * 100).toFixed(1) : null;
log('PERF', JSON.stringify(perf));
log('CPU', JSON.stringify(cpu));

// --- input latency: synthetic in-page keydown -> next emulated frame ---
const inputLatency = await page.evaluate(async (trials) => {
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
    await new Promise((r) => setTimeout(r, 250));
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
  out.sort((a, b) => a - b);
  return {
    trials: out.length, samples: out,
    median: out[Math.floor(out.length / 2)],
    p95: out[Math.min(out.length - 1, Math.floor(out.length * 0.95))],
    note: 'synthetic KeyboardEvent -> next get_current_frame_count increment',
  };
}, 8);
log('INPUT', JSON.stringify(inputLatency));

// --- CDP input round-trip (closer to a real key press) ----------------
const cdpLatency = [];
if (perf.frame1 != null) {
  for (let i = 0; i < 5; i++) {
    await sleep(250);
    const before = await page.evaluate(() => window.EJS_emulator.gameManager.getFrameNum());
    const t0 = performance.now();
    await page.keyboard.down('ArrowRight');
    let dt = null;
    for (let j = 0; j < 60; j++) {
      const n = await page.evaluate(() => window.EJS_emulator.gameManager.getFrameNum());
      if (n > before) { dt = performance.now() - t0; break; }
      await sleep(2);
    }
    await page.keyboard.up('ArrowRight');
    if (dt != null) cdpLatency.push(+dt.toFixed(2));
  }
}
cdpLatency.sort((a, b) => a - b);
const cdp = cdpLatency.length ? {
  trials: cdpLatency.length, samples: cdpLatency,
  median: cdpLatency[Math.floor(cdpLatency.length / 2)],
  note: 'CDP key dispatch (Node->browser) -> next emulated frame; includes CDP round trips',
} : null;
log('CDP-INPUT', JSON.stringify(cdp));

// --- cache / storage ---------------------------------------------------
const cache = await page.evaluate(async () => {
  const out = { databases: [], rom: null, bios: null, cores: null, estimate: null, persisted: null };
  try { out.estimate = await navigator.storage.estimate(); } catch (e) { out.estimate = { error: String(e) }; }
  try { out.persisted = await navigator.storage.persisted(); } catch (e) { out.persisted = String(e); }
  try { out.databases = (await indexedDB.databases()).map((d) => ({ name: d.name, version: d.version })); } catch (e) { out.databases = [{ error: String(e) }]; }
  const readStore = (dbName, storeName, withSizes) => new Promise((resolve) => {
    let req;
    try { req = indexedDB.open(dbName); } catch (e) { return resolve({ error: String(e) }); }
    req.onerror = () => resolve({ error: 'open failed' });
    req.onsuccess = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(storeName)) { db.close(); return resolve({ missing: true }); }
      const tx = db.transaction([storeName], 'readonly');
      const st = tx.objectStore(storeName);
      const keysReq = st.getAllKeys();
      keysReq.onerror = () => { db.close(); resolve({ error: 'getAllKeys failed' }); };
      keysReq.onsuccess = async () => {
        const keys = keysReq.result.filter((k) => k !== '?EJS_KEYS!');
        const entries = [];
        for (const k of keys) {
          const v = await new Promise((res) => {
            const g = st.get(k);
            g.onsuccess = () => res(g.result);
            g.onerror = () => res(null);
          });
          entries.push({
            key: k,
            contentLength: v && v['content-length'] != null ? Number(v['content-length']) : null,
            type: v && v.type != null ? v.type : null,
            byteLength: v && v.data && typeof v.data.byteLength === 'number' ? v.data.byteLength : null,
          });
          if (!withSizes) break;
        }
        db.close();
        resolve({ keys, entries });
      };
    };
  });
  out.rom = await readStore('EmulatorJS-roms', 'rom', true);
  out.bios = await readStore('EmulatorJS-bios', 'bios', true);
  out.cores = await readStore('EmulatorJS-core', 'core', false);
  return out;
});
log('CACHE', JSON.stringify({ dbs: cache.databases, rom: cache.rom?.entries, estimate: cache.estimate, persisted: cache.persisted }));

// --- resource timing + HTTP responses ---------------------------------
const timing = await page.evaluate(() => performance.getEntriesByType('resource')
  .filter((e) => /\/rom\/|\/bios\/|\/emulator\/|cores\//.test(e.name))
  .map((e) => ({
    name: decodeURIComponent(e.name).replace(location.origin, ''),
    startTime: +e.startTime.toFixed(0),
    duration: +e.duration.toFixed(0),
    transferMB: +(e.transferSize / 1048576).toFixed(2),
    encodedMB: +(e.encodedBodySize / 1048576).toFixed(2),
    decodedMB: +(e.decodedBodySize / 1048576).toFixed(2),
    initiatorType: e.initiatorType,
  })));

// --- screenshot --------------------------------------------------------
const shot = path.join(OUT, `${LABEL}.png`);
await page.screenshot({ path: shot });
log('SHOT', shot);

const result = {
  label: LABEL,
  url: URL_,
  profile: PROFILE,
  requested: { core: CORE, opts: OPTS, shader: SHADER, freshLocalStorage: FRESH_LOCALSTORAGE, cpuThrottle: CPU_THROTTLE },
  startedAt: new Date(t0).toISOString(),
  wallMs: Date.now() - t0,
  boot,
  audio: { beforeClick: audioBefore, afterClick: audioAfterClick },
  perf,
  cpu,
  inputLatency,
  cdpLatency: cdp,
  cache,
  timing,
  requests,
  responses,
  consoleTail: consoleLog.slice(-80),
};
fs.writeFileSync(path.join(OUT, `${LABEL}.json`), JSON.stringify(result, null, 2));
log('WROTE', path.join(OUT, `${LABEL}.json`));

await browser.close();
