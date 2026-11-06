// Independent QA for the DLSS 5 real-time post-process.
// Read-only against the app: boots /play and /play-net, exercises the FILTER
// menu, measures FPS and writes evidence to _runtime/dlss5-*.png.
//
// Usage: node test-dlss5-qa.mjs
//        QA_BASE=http://127.0.0.1:8090 node test-dlss5-qa.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import puppeteer from 'puppeteer-core';

const LAN = 'http://localhost:8090';
const LOCAL = 'http://127.0.0.1:8090';
const OUT = '../_runtime';
const BRAVE = 'C:/Program Files/BraveSoftware/Brave-Browser/Application/brave.exe';
const PROFILE = path.join(os.tmpdir(), 'rr4-dlss5-qa-profile');
const BOOT_TIMEOUT_MS = Number(process.env.QA_BOOT_TIMEOUT_MS || 300000);
fs.mkdirSync(OUT, { recursive: true });
for (const f of fs.readdirSync(OUT)) {
  if (/^dlss5-.*\.png$/.test(f) || f === 'dlss5-result.json') fs.rmSync(path.join(OUT, f), { force: true });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(...a);
const results = { startedAt: new Date().toISOString(), base: null, checks: [], console: [], pageErrors: [], shots: [], notes: [] };
function check(id, name, pass, detail = '') {
  results.checks.push({ id, name, pass: !!pass, detail: String(detail || '') });
  log(`${pass ? 'PASS' : 'FAIL'}  ${id}  ${name}${detail ? '  - ' + detail : ''}`);
  return !!pass;
}
function note(msg) { results.notes.push(String(msg)); log('      ' + msg); }

async function reachable(url, timeout = 2500) {
  try {
    const c = new AbortController();
    const t = setTimeout(() => c.abort(), timeout);
    const r = await fetch(url, { cache: 'no-store', signal: c.signal });
    clearTimeout(t);
    return r.ok ? r : null;
  } catch { return null; }
}

// ---------------------------------------------------------------- PNG stats
function decodePng(buf) {
  if (buf.readUInt32BE(0) !== 0x89504e47) throw new Error('not png');
  let off = 8, w = 0, h = 0, bitDepth = 8, colorType = 6, interlace = 0;
  const idat = [];
  while (off < buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.toString('ascii', off + 4, off + 8);
    const data = buf.subarray(off + 8, off + 8 + len);
    if (type === 'IHDR') {
      w = data.readUInt32BE(0); h = data.readUInt32BE(4);
      bitDepth = data[8]; colorType = data[9]; interlace = data[12];
    } else if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') break;
    off += 12 + len;
  }
  if (bitDepth !== 8 || interlace !== 0 || ![2, 6].includes(colorType)) {
    return { width: w, height: h, note: `unsupported png ${bitDepth}/${colorType}` };
  }
  const bpp = colorType === 6 ? 4 : 3;
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = w * bpp;
  const out = Buffer.alloc(h * stride);
  let pos = 0;
  for (let y = 0; y < h; y++) {
    const ft = raw[pos++];
    const line = raw.subarray(pos, pos + stride); pos += stride;
    const prev = y ? out.subarray((y - 1) * stride, y * stride) : null;
    const cur = out.subarray(y * stride, (y + 1) * stride);
    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? cur[x - bpp] : 0;
      const b = prev ? prev[x] : 0;
      const c = (prev && x >= bpp) ? prev[x - bpp] : 0;
      let v = line[x];
      switch (ft) {
        case 0: break;
        case 1: v = (v + a) & 255; break;
        case 2: v = (v + b) & 255; break;
        case 3: v = (v + ((a + b) >> 1)) & 255; break;
        case 4: {
          const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
          v = (v + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c)) & 255; break;
        }
        default: throw new Error('bad filter ' + ft);
      }
      cur[x] = v;
    }
  }
  return { width: w, height: h, bpp, stride, pixels: out };
}
function statsOf(buf) {
  const img = decodePng(buf);
  if (!img.pixels) return img;
  const { width: w, height: h, bpp, stride, pixels } = img;
  const luma = new Float32Array(w * h);
  let sum = 0, nonBlack = 0, sampled = 0;
  const colors = new Set();
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * stride + x * bpp;
      const r = pixels[i], g = pixels[i + 1], b = pixels[i + 2];
      const l = 0.2126 * r + 0.7152 * g + 0.0722 * b;
      luma[y * w + x] = l;
      sum += l;
      if (y % 3 === 0 && x % 3 === 0) {
        sampled++;
        if (r + g + b > 24) nonBlack++;
        colors.add(((r >> 4) << 8) | ((g >> 4) << 4) | (b >> 4));
      }
    }
  }
  // Mean absolute 4-neighbour Laplacian on luma = edge sharpness proxy.
  let edgeSum = 0, edgeN = 0;
  for (let y = 1; y < h - 1; y += 2) {
    for (let x = 1; x < w - 1; x += 2) {
      const c = luma[y * w + x];
      const lap = 4 * c - luma[(y - 1) * w + x] - luma[(y + 1) * w + x] - luma[y * w + x - 1] - luma[y * w + x + 1];
      edgeSum += Math.abs(lap); edgeN++;
    }
  }
  return {
    width: w, height: h,
    meanLuma: +(sum / (w * h)).toFixed(2),
    nonBlackPct: +((nonBlack / Math.max(1, sampled)) * 100).toFixed(1),
    edge: +(edgeSum / Math.max(1, edgeN)).toFixed(3),
    distinctColors: colors.size,
  };
}
function comparePng(a, b) {
  try {
    const A = decodePng(a), B = decodePng(b);
    if (!A.pixels || !B.pixels || A.width !== B.width || A.height !== B.height) return null;
    let diff = 0, changed = 0, n = 0;
    const step = Math.max(1, Math.floor(A.width / 400));
    for (let y = 0; y < A.height; y += step) {
      for (let x = 0; x < A.width; x += step) {
        const ia = y * A.stride + x * A.bpp, ib = y * B.stride + x * B.bpp;
        const d = (Math.abs(A.pixels[ia] - B.pixels[ib]) + Math.abs(A.pixels[ia + 1] - B.pixels[ib + 1]) + Math.abs(A.pixels[ia + 2] - B.pixels[ib + 2])) / 3;
        diff += d; if (d > 2) changed++; n++;
      }
    }
    return { meanAbsDiff: +(diff / n).toFixed(2), changedPct: +((changed / n) * 100).toFixed(1) };
  } catch { return null; }
}

// ---------------------------------------------------------------- browser
function attach(page, label) {
  const rec = { console: [], pageErrors: [], reqFailed: [], httpErrors: [] };
  page.on('console', (m) => {
    const line = `[${m.type()}] ${m.text()}`;
    rec.console.push(line);
    results.console.push({ label, line });
    if (m.type() === 'error') log(`  CONSOLE[${label}]`, line.slice(0, 400));
  });
  page.on('pageerror', (e) => {
    rec.pageErrors.push(e.message);
    results.pageErrors.push({ label, message: e.message });
    log(`  PAGEERROR[${label}]`, e.message.slice(0, 400));
  });
  page.on('requestfailed', (r) => {
    const err = r.failure()?.errorText || '';
    if (/ERR_ABORTED/.test(err)) return; // EJS aborts the ROM reader after caching.
    rec.reqFailed.push({ url: r.url(), err });
    log(`  REQFAIL[${label}]`, r.url().slice(0, 160), err);
  });
  page.on('response', (r) => {
    if (r.status() >= 400) {
      rec.httpErrors.push({ url: r.url(), status: r.status() });
      log(`  HTTP[${label}]`, r.status(), r.url().slice(0, 160));
    }
  });
  return rec;
}

async function canvasRect(page) {
  return page.evaluate(() => {
    const c = document.querySelector('#game canvas');
    if (!c) return null;
    const r = c.getBoundingClientRect();
    const vw = innerWidth, vh = innerHeight;
    const x = Math.max(0, Math.round(r.x)), y = Math.max(0, Math.round(r.y));
    return {
      x, y,
      width: Math.max(1, Math.min(Math.round(r.width), vw - x)),
      height: Math.max(1, Math.min(Math.round(r.height), vh - y)),
      canvasW: c.width, canvasH: c.height,
    };
  });
}

async function shot(page, name, opts = {}) {
  const file = path.join(OUT, `dlss5-${name}.png`);
  const buf = await page.screenshot({ path: file, ...opts });
  let stats = null;
  try { stats = statsOf(buf); } catch (e) { stats = { error: e.message }; }
  const rec = {
    name, file,
    sha: crypto.createHash('sha256').update(buf).digest('hex').slice(0, 16),
    stats,
  };
  results.shots.push(rec);
  log(`  SHOT ${name}`, JSON.stringify({ sha: rec.sha, ...stats }));
  return { ...rec, buf };
}
async function shotCanvas(page, name) {
  const r = await canvasRect(page);
  if (!r) return null;
  return shot(page, name, { clip: { x: r.x, y: r.y, width: r.width, height: r.height } });
}

async function boot(page, url, label) {
  const t0 = Date.now();
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
  let last = null, clicks = 0;
  const deadline = Date.now() + BOOT_TIMEOUT_MS;
  while (Date.now() < deadline) {
    last = await page.evaluate(() => {
      const s = window.__R4;
      const em = window.EJS_emulator;
      const c = document.querySelector('#game canvas');
      const start = document.querySelector('#game .ejs_start_button');
      return {
        started: !!(s && s.startedAt), ready: !!(s && s.readyAt),
        errors: s ? s.errors : [], hasEjs: !!em,
        canvas: c ? { w: c.width, h: c.height, cw: c.clientWidth, ch: c.clientHeight } : null,
        startBtn: !!start,
        status: document.querySelector('#bootStatus')?.textContent || null,
        overlay: document.querySelector('#overlayText')?.textContent || null,
      };
    });
    if (last.startBtn) {
      clicks++;
      await page.evaluate(() => document.querySelector('#game .ejs_start_button')?.click());
    }
    if (last.started && last.hasEjs && last.canvas) {
      log(`  BOOT[${label}] ${Math.round((Date.now() - t0) / 1000)}s canvas=${JSON.stringify(last.canvas)} startClicks=${clicks}`);
      return { ...last, wallMs: Date.now() - t0, startClicks: clicks };
    }
    await sleep(1000);
  }
  throw new Error(`boot timeout for ${label}; last=${JSON.stringify(last)}`);
}

// The DLSS 5 mirror is armed by the first real pointer/key gesture, so a
// programmatic .click() is not enough. Click the sound gate (or the canvas).
async function activateDlss5(page) {
  const target = await page.evaluate(() => {
    const gate = document.querySelector('#soundGate');
    const c = document.querySelector('#game canvas');
    const el = (gate && !gate.hidden) ? gate : c;
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2, w: r.width, h: r.height };
  });
  if (target && target.w > 0 && target.h > 0) {
    await page.mouse.click(target.x, target.y);
  } else {
    await page.evaluate(() => window.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true })));
  }
  // Current implementation arms the stage filter 3 s after the first gesture.
  await sleep(3800);
}

async function appState(page) {
  return page.evaluate(() => {
    const em = window.EJS_emulator;
    const fsys = em?.Module?.FS;
    let glslp = null, shaderFiles = null;
    try { glslp = fsys.readFile('/shader/shader.glslp', { encoding: 'utf8' }); } catch { glslp = null; }
    try { shaderFiles = fsys.readdir('/shader'); } catch { shaderFiles = null; }
    const c = document.querySelector('#game canvas');
    const el = document.querySelector('#game');
    const after = el ? getComputedStyle(el, '::after') : null;
    const before = el ? getComputedStyle(el, '::before') : null;
    let glRenderer = null;
    try {
      const gl = c && (c.getContext('webgl2') || c.getContext('webgl'));
      if (gl) {
        const ext = gl.getExtension('WEBGL_debug_renderer_info');
        glRenderer = ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER);
      }
    } catch { /* ignore */ }
    const gameFilter = el ? getComputedStyle(el).filter : null;
    const shaderActive = !!(glslp && /shader0\s*=\s*"?dlss5\.glsl"?/.test(glslp));
    const svgFilterPresent = !!document.querySelector('#dlss5-filter');
    const svgActive = !!svgFilterPresent && /dlss5-filter/.test(gameFilter || '');
    const bodyFilter = document.body.dataset.filter || null;
    const stageEl = document.querySelector('#play-stage');
    const stageFilter = stageEl ? getComputedStyle(stageEl).filter : null;
    const stageActive = !!stageFilter && stageFilter !== 'none';
    const gameVideos = [...document.querySelectorAll('#game video')];
    const filteredVideo = gameVideos.find((v) => /dlss5-filter/.test(getComputedStyle(v).filter || ''));
    const mirror = document.querySelector('#game video.dlss5-mirror') || filteredVideo || null;
    const mirrorFilter = mirror ? getComputedStyle(mirror).filter : null;
    const mirrorActive = !!mirror && /dlss5-filter/.test(mirrorFilter || '');
    const videoCssActive = gameVideos.some((v) => {
      const f = getComputedStyle(v).filter;
      return !!f && f !== 'none';
    });
    const cssActive = bodyFilter === 'dlss5' && (
      (gameFilter && gameFilter !== 'none') ||
      Number(after?.opacity || 0) > 0 || Number(before?.opacity || 0) > 0
    );
    const dlss5Active = shaderActive || svgActive || cssActive || mirrorActive || stageActive || videoCssActive;
    const mode = shaderActive ? 'ejs-shader'
      : (mirrorActive ? 'mirror-svg-filter'
        : (svgActive ? 'svg-filter'
          : (stageActive ? 'stage-css-filter'
            : (videoCssActive ? 'guest-video-css-filter' : (cssActive ? 'css-filter' : 'none')))));
    return {
      ejs: !!em,
      startedAt: window.__R4?.startedAt || null,
      bootMs: window.__R4?.bootMs ?? null,
      r4Errors: window.__R4?.errors || [],
      setting: em?.getSettingValue?.('shader') ?? null,
      configHasDlss5: !!em?.config?.shaders?.dlss5,
      shaderKeys: em?.config?.shaders ? Object.keys(em.config.shaders) : [],
      glslp, shaderFiles,
      shaderActive,
      svgActive,
      cssActive,
      mirrorActive,
      dlss5Active,
      mode,
      gameFilter,
      mirrorFilter,
      mirrorPresent: !!mirror,
      svgFilterPresent,
      stageFilter,
      stageActive,
      videoCssActive,
      videoCount: gameVideos.length,
      bodyFilter,
      selectValue: document.querySelector('#filterSelect')?.value || null,
      selectOptions: Array.from(document.querySelectorAll('#filterSelect option')).map((o) => o.value),
      overlay: {
        afterOpacity: after ? after.opacity : null,
        beforeOpacity: before ? before.opacity : null,
        canvasFilter: c ? getComputedStyle(c).filter : null,
        imageRendering: c ? getComputedStyle(c).imageRendering : null,
      },
      canvas: c ? { w: c.width, h: c.height, cw: c.clientWidth, ch: c.clientHeight } : null,
      frameNum: (() => { try { return em?.gameManager?.getFrameNum?.() ?? null; } catch { return null; } })(),
      paused: em?.paused ?? null,
      glRenderer,
    };
  });
}

async function setFilter(page, value) {
  await page.select('#filterSelect', value);
  await sleep(1100);
  return appState(page);
}

async function waitForFrame(page, label, { timeout = 50000, minNonBlack = 12 } = {}) {
  const deadline = Date.now() + timeout;
  let last = null, n = 0;
  while (Date.now() < deadline) {
    n++;
    const s = await shotCanvas(page, `${label}-frame-${n}`);
    last = s;
    if (s && s.stats && (s.stats.nonBlackPct >= minNonBlack) && (s.stats.distinctColors || 0) > 12) return s;
    await sleep(2500);
  }
  return last;
}

async function waitForStaticFrame(page, label, { timeout = 45000, minNonBlack = 20 } = {}) {
  let prev = null, n = 0;
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    n++;
    const s = await shotCanvas(page, `${label}-${n}`);
    if (s && s.stats && s.stats.nonBlackPct >= minNonBlack) {
      if (prev && prev.stats && prev.stats.nonBlackPct >= minNonBlack) {
        const c = comparePng(prev.buf, s.buf);
        if (c && c.changedPct < 0.8) return s;
      }
      prev = s;
    }
    await sleep(700);
  }
  return prev;
}

async function rapidCompare(page) {
  // DLSS 5 is active. Capture it, switch Off with the shortest possible delay,
  // and capture again. Both must be non-black for a fair comparison.
  const d = await shotCanvas(page, 'r4-compare-static-dlss5');
  await page.select('#filterSelect', 'off');
  await sleep(160);
  let o = await shotCanvas(page, 'r4-compare-static-off');
  if (o && o.stats && (o.stats.nonBlackPct || 0) < 10) {
    await sleep(500);
    o = await shotCanvas(page, 'r4-compare-static-off');
  }
  await page.select('#filterSelect', 'dlss5');
  await sleep(700);
  return { d, o };
}

async function measureFps(page, seconds) {
  return page.evaluate(async (sec) => {
    const em = window.EJS_emulator;
    const gm = em?.gameManager;
    const f0 = gm?.getFrameNum?.() ?? null;
    const t0 = performance.now();
    let frames = 0;
    const times = [];
    await new Promise((resolve) => {
      function tick(t) {
        frames++; times.push(t);
        if (t - t0 < sec * 1000) requestAnimationFrame(tick);
        else resolve();
      }
      requestAnimationFrame(tick);
    });
    const elapsed = performance.now() - t0;
    const f1 = gm?.getFrameNum?.() ?? null;
    const deltas = [];
    for (let i = 1; i < times.length; i++) deltas.push(times[i] - times[i - 1]);
    const sorted = deltas.slice().sort((a, b) => a - b);
    const q = (p) => sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))] : null;
    return {
      seconds: sec,
      rafFrames: frames,
      rafFps: +(frames / (elapsed / 1000)).toFixed(2),
      emuFrames: f1 != null && f0 != null ? f1 - f0 : null,
      emuFps: f1 != null && f0 != null ? +(((f1 - f0) / (elapsed / 1000))).toFixed(2) : null,
      p50: q(0.5) != null ? +q(0.5).toFixed(2) : null,
      p95: q(0.95) != null ? +q(0.95).toFixed(2) : null,
      max: sorted.length ? +sorted[sorted.length - 1].toFixed(2) : null,
    };
  }, seconds);
}

// ---------------------------------------------------------------- main
let BASE = process.env.QA_BASE || LAN;
let baseProbe = await reachable(BASE + '/play');
if (!baseProbe) {
  note(`LAN ${LAN} unreachable, falling back to ${LOCAL}`);
  BASE = LOCAL;
  baseProbe = await reachable(BASE + '/play');
}
results.base = BASE;
if (!baseProbe) {
  check('0.1', 'QA target /play is reachable', false, BASE);
  fs.writeFileSync(path.join(OUT, 'dlss5-result.json'), JSON.stringify(results, null, 2));
  process.exit(1);
}
check('0.1', 'QA target /play is reachable', true, BASE);

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
    '--window-size=1280,800',
    '--js-flags=--max-old-space-size=4096',
  ],
  defaultViewport: { width: 1280, height: 800, deviceScaleFactor: 1 },
});

const ctx = await browser.createBrowserContext();
const page = await ctx.newPage();
const rec = attach(page, 'PLAY');

try {
  // ================================================== 1. /play?game=r4 boot
  const bootR4 = await boot(page, BASE + '/play?game=r4', 'PLAY');
  await sleep(2500);
  await activateDlss5(page);
  const s0 = await appState(page);
  results.r4Boot = s0;
  check('1.1', '/play?game=r4 boots and EJS_emulator exists', !!s0.ejs && !!s0.startedAt, `boot=${bootR4.wallMs}ms`);
  check('1.2', 'FILTER default is DLSS 5 and a DLSS 5 post-process is active',
    s0.selectValue === 'dlss5' && s0.dlss5Active,
    `select=${s0.selectValue} body=${s0.bodyFilter} mode=${s0.mode} stageFilter=${s0.stageFilter} getSettingValue=${s0.setting} shaderActive=${s0.shaderActive} svgActive=${s0.svgActive} config=${s0.configHasDlss5} keys=${s0.shaderKeys.length}`);
  if (s0.mode !== 'ejs-shader' && s0.mode !== 'none') note(`DLSS 5 is implemented as ${s0.mode} (${s0.stageFilter || s0.gameFilter}), not the EJS GLSL shader (applyShaderFilter is a no-op). getSettingValue('shader')=${JSON.stringify(s0.setting)}.`);
  if (s0.shaderActive && s0.setting !== 'dlss5') note(`getSettingValue('shader') reports ${JSON.stringify(s0.setting)} while the EJS FS shader is active; enableShader() does not update EJS's setting cache.`);
  check('1.3', 'DLSS 5 post-process resources are present and active',
    s0.mode === 'ejs-shader'
      ? (!!s0.glslp && /shader0\s*=\s*"?dlss5\.glsl"?/.test(s0.glslp) && Array.isArray(s0.shaderFiles) && s0.shaderFiles.includes('dlss5.glsl'))
      : s0.mode !== 'none',
    `mode=${s0.mode} glslp=${JSON.stringify((s0.glslp || '').replace(/\n/g, '|'))} files=${JSON.stringify(s0.shaderFiles)} svg=${s0.svgFilterPresent} stageFilter=${s0.stageFilter} gameFilter=${s0.gameFilter}`);
  const shaderErr = results.console.filter((c) => /shader|glsl|compile|link/i.test(c.line) && /error|fail|invalid|warn/i.test(c.line));
  check('1.4', 'No shader compile/link errors in console', shaderErr.length === 0,
    shaderErr.length ? shaderErr.map((e) => e.line).join(' | ').slice(0, 500) : 'none');
  check('1.5', 'No page errors during R4 boot', rec.pageErrors.length === 0,
    rec.pageErrors.length ? rec.pageErrors.join(' | ').slice(0, 500) : 'none');

  // activateDlss5() already clicked the gate (real pointer gesture), so wait
  // for a non-black title/attract frame.
  await sleep(1200);
  const frameDlss = await waitForFrame(page, 'r4-dlss5', { timeout: 60000, minNonBlack: 12 });
  results.frameDlss = frameDlss ? { name: frameDlss.name, stats: frameDlss.stats, sha: frameDlss.sha } : null;
  check('1.6', 'R4 DLSS 5 screenshot is visibly rendered (not black/blank)',
    !!(frameDlss && frameDlss.stats && frameDlss.stats.nonBlackPct >= 12 && (frameDlss.stats.distinctColors || 0) > 12),
    frameDlss ? JSON.stringify(frameDlss.stats) : 'no frame');

  // DLSS 5 vs Off comparison. Wait for a near-static attract/logo frame, then
  // toggle Off and capture with the shortest possible delay. Pausing EJS while
  // Off is active leaves the WebGL canvas blank, so a running capture is used.
  const validPair = (d, o) => d && o && d.stats && o.stats &&
    (d.stats.nonBlackPct || 0) >= 10 && (o.stats.nonBlackPct || 0) >= 10;
  const staticFrame = await waitForStaticFrame(page, 'r4-static', { timeout: 45000, minNonBlack: 20 });
  let pair = null;
  let method = 'static-rapid';
  let cmp = null;
  if (staticFrame) {
    const rp = await rapidCompare(page);
    pair = { dlss: rp.d, off: rp.o };
    cmp = rp.d && rp.o ? comparePng(rp.d.buf, rp.o.buf) : null;
  }
  if (!pair || !validPair(pair.dlss, pair.off) || !cmp || cmp.changedPct < 0.5) {
    // Last resort: two live captures ~200 ms apart.
    method = 'live-rapid';
    await page.select('#filterSelect', 'dlss5');
    await sleep(900);
    const d = await shotCanvas(page, 'r4-compare-live-dlss5');
    await page.select('#filterSelect', 'off');
    await sleep(200);
    const o = await shotCanvas(page, 'r4-compare-live-off');
    await page.select('#filterSelect', 'dlss5');
    await sleep(800);
    cmp = d && o ? comparePng(d.buf, o.buf) : null;
    pair = { dlss: d, off: o };
  }
  const dStat = pair?.dlss?.stats, oStat = pair?.off?.stats;
  results.compare = {
    method,
    valid: validPair(pair.dlss, pair.off),
    dlss: dStat || null,
    off: oStat || null,
    diff: cmp,
    meanLumaDelta: dStat && oStat && dStat.meanLuma != null ? +(dStat.meanLuma - oStat.meanLuma).toFixed(2) : null,
    edgeDelta: dStat && oStat && dStat.edge != null ? +(dStat.edge - oStat.edge).toFixed(3) : null,
    edgePct: dStat && oStat && oStat.edge ? +(((dStat.edge - oStat.edge) / oStat.edge) * 100).toFixed(1) : null,
  };
  check('1.7', 'DLSS 5 vs Off comparable-frame screenshots differ measurably', !!cmp && cmp.changedPct > 1 && validPair(pair.dlss, pair.off),
    cmp ? `method=${method} changed=${cmp.changedPct}% meanAbsDiff=${cmp.meanAbsDiff} nonBlack dlss=${dStat?.nonBlackPct} off=${oStat?.nonBlackPct}` : 'no comparison');
  check('1.8', 'DLSS 5 output is sharper than Off (mean |Laplacian|)',
    !!(validPair(pair.dlss, pair.off) && dStat.edge > oStat.edge * 1.01),
    `dlss edge=${dStat?.edge} off edge=${oStat?.edge} delta=${results.compare.edgePct}% luma=${results.compare.meanLumaDelta} nonBlack dlss=${dStat?.nonBlackPct} off=${oStat?.nonBlackPct}`);
  // Restore DLSS 5 and running state.
  await page.evaluate(() => {
    document.querySelector('#filterSelect').value = 'dlss5';
    document.querySelector('#filterSelect').dispatchEvent(new Event('change', { bubbles: true }));
    try { window.EJS_emulator?.play?.(); } catch { /* ignore */ }
  });
  await sleep(1500);

  // ================================================== 2. FILTER menu sequence
  const sequence = ['dlss5', 'off', 'scanlines', 'crt', 'vignette', 'sharp', 'dlss5'];
  const seqResults = [];
  const cssOverlayOk = (s) => {
    if (s.selectValue === 'off') {
      return s.overlay.afterOpacity === '0' && s.overlay.beforeOpacity === '0' && s.overlay.canvasFilter === 'none' && !s.dlss5Active;
    }
    if (s.selectValue === 'dlss5') {
      return s.dlss5Active;
    }
    if (s.selectValue === 'scanlines' || s.selectValue === 'crt') return Number(s.overlay.afterOpacity) > 0 && !s.dlss5Active;
    if (s.selectValue === 'vignette') return Number(s.overlay.beforeOpacity) > 0 && !s.dlss5Active;
    if (s.selectValue === 'sharp') return s.overlay.canvasFilter !== 'none' && !s.dlss5Active;
    return false;
  };
  for (const value of sequence) {
    const s = await setFilter(page, value);
    const shaderOn = s.dlss5Active;
    const shaderOk = value === 'dlss5' ? shaderOn : !s.dlss5Active;
    const cssOk = cssOverlayOk(s);
    const shotName = `filter-${value}`;
    const sh = await shotCanvas(page, shotName);
    seqResults.push({
      value, bodyFilter: s.bodyFilter, selectValue: s.selectValue, setting: s.setting,
      mode: s.mode, dlss5Active: s.dlss5Active, shaderOn, shaderOk, cssOk, overlay: s.overlay,
      shot: sh ? { name: sh.name, sha: sh.sha, stats: sh.stats } : null,
    });
    log(`  FILTER ${value}: body=${s.bodyFilter} setting=${s.setting} mode=${s.mode} postOk=${shaderOk} cssOk=${cssOk} overlay=${JSON.stringify(s.overlay)}`);
  }
  results.filterSequence = seqResults;
  check('2.1', 'FILTER menu follows DLSS5 -> Off -> Scanlines -> CRT -> Vignette -> Sharp -> DLSS5',
    seqResults.length === sequence.length && seqResults.every((r, i) =>
      r.value === sequence[i] && r.selectValue === sequence[i] &&
      (r.value === 'dlss5' ? r.dlss5Active : r.bodyFilter === r.value)),
    seqResults.map((r) => `${r.value}:body=${r.bodyFilter}/sel=${r.selectValue}/active=${r.dlss5Active}`).join(' '));
  check('2.2', 'DLSS 5 post-process enabled only for DLSS 5; disabled for every CSS filter',
    seqResults.every((r) => r.shaderOk),
    seqResults.map((r) => `${r.value}=${r.mode}`).join(' '));
  check('2.3', 'CSS overlays apply for Scanlines/CRT/Vignette/Sharp and clear for Off/DLSS5',
    seqResults.every((r) => r.cssOk),
    seqResults.map((r) => `${r.value}:${r.cssOk ? 'ok' : 'BAD(' + JSON.stringify(r.overlay) + ')'}`).join(' '));
  check('2.4', 'No page errors while cycling FILTER', rec.pageErrors.length === 0,
    rec.pageErrors.length ? rec.pageErrors.join(' | ').slice(0, 500) : 'none');

  // ================================================== 5a. FPS DLSS vs Off
  await setFilter(page, 'dlss5');
  await page.bringToFront();
  await sleep(2500);
  const fpsDlss = await measureFps(page, 5);
  const shotFpsDlss = await shotCanvas(page, 'perf-dlss5');
  await setFilter(page, 'off');
  await sleep(2000);
  const fpsOff = await measureFps(page, 5);
  const shotFpsOff = await shotCanvas(page, 'perf-off');
  await setFilter(page, 'dlss5');
  results.fps = { dlss5: fpsDlss, off: fpsOff, dlssShot: shotFpsDlss?.stats, offShot: shotFpsOff?.stats };
  check('5.1', 'DLSS 5 holds >= 55 fps at 1280x800', fpsDlss.rafFps >= 55,
    `dlss raf=${fpsDlss.rafFps} emu=${fpsDlss.emuFps} p95=${fpsDlss.p95}ms | off raf=${fpsOff.rafFps} emu=${fpsOff.emuFps} p95=${fpsOff.p95}ms`);
  check('5.2', 'DLSS 5 FPS cost vs Off is reported', true,
    `delta=${+(fpsDlss.rafFps - fpsOff.rafFps).toFixed(2)} fps (${fpsDlss.rafFps} vs ${fpsOff.rafFps})`);

  // ================================================== 3. /play?game=rage
  const pageRage = await ctx.newPage();
  const recRage = attach(pageRage, 'RAGE');
  await pageRage.setViewport({ width: 1280, height: 800, deviceScaleFactor: 1 });
  const bootRage = await boot(pageRage, BASE + '/play?game=rage', 'RAGE');
  await sleep(2500);
  await activateDlss5(pageRage);
  const sRage = await appState(pageRage);
  results.rageBoot = sRage;
  check('3.1', '/play?game=rage boots with EJS_emulator', !!sRage.ejs && !!sRage.startedAt, `boot=${bootRage.wallMs}ms`);
  check('3.2', 'Rage Racer boots with DLSS 5 enabled', sRage.dlss5Active && sRage.selectValue === 'dlss5',
    `select=${sRage.selectValue} setting=${sRage.setting} mode=${sRage.mode} body=${sRage.bodyFilter} stage=${sRage.stageFilter}`);
  await sleep(1200);
  const rageFrame = await waitForFrame(pageRage, 'rage-dlss5', { timeout: 70000, minNonBlack: 8 });
  check('3.3', 'Rage Racer DLSS 5 screenshot is rendered (not black/blank)',
    !!(rageFrame && rageFrame.stats && rageFrame.stats.nonBlackPct >= 8),
    rageFrame ? JSON.stringify(rageFrame.stats) : 'no frame');
  check('3.4', 'No page errors during Rage boot', recRage.pageErrors.length === 0,
    recRage.pageErrors.length ? recRage.pageErrors.join(' | ').slice(0, 400) : 'none');
  await pageRage.close();

  // ================================================== 4. /play-net host+guest
  const relay = `http://${new URL(BASE).hostname}:3010`;
  const relayHealth = await reachable(relay + '/health', 3000);
  results.relay = { url: relay, healthy: !!relayHealth, body: relayHealth ? await relayHealth.text().catch(() => '') : null };
  if (!relayHealth) note(`Relay ${relay} unreachable; netplay stream checks will be limited.`);

  const ctxHost = await browser.createBrowserContext();
  const ctxGuest = await browser.createBrowserContext();
  const host = await ctxHost.newPage();
  const guest = await ctxGuest.newPage();
  const recHost = attach(host, 'HOST');
  const recGuest = attach(guest, 'GUEST');
  await host.setViewport({ width: 1280, height: 800, deviceScaleFactor: 1 });
  await guest.setViewport({ width: 1280, height: 800, deviceScaleFactor: 1 });

  const netUrl = BASE + '/play-net?cache=0';
  const bootHost = await boot(host, netUrl, 'HOST');
  // EJS 4.3 needs a moment to create its WebGL context; arming the mirror too
  // early can leave the host with body=dlss5 but no active filter.
  await sleep(8000);
  await activateDlss5(host);
  await sleep(1500);
  let sHost = await appState(host);
  if (!sHost.dlss5Active) {
    await sleep(2500);
    sHost = await appState(host);
  }
  results.netHostBoot = sHost;
  // The netplay host deliberately leaves its raw 4.3 canvas alone and applies
  // the grade to the guest's received video; accept that design but report it.
  const hostRawByDesign = sHost.selectValue === 'dlss5' && sHost.mode === 'none' && sHost.videoCount === 0;
  check('4.1', 'Netplay host boots with DLSS 5 selected',
    !!sHost.ejs && !!sHost.startedAt && sHost.selectValue === 'dlss5' && (sHost.dlss5Active || hostRawByDesign),
    `boot=${bootHost.wallMs}ms select=${sHost.selectValue} setting=${sHost.setting} mode=${sHost.mode} body=${sHost.bodyFilter} stage=${sHost.stageFilter} hostRawByDesign=${hostRawByDesign}`);
  if (hostRawByDesign) note('Netplay host keeps its own 4.3 canvas unfiltered by design; the guest applies the DLSS 5 grade to the received video.');

  let hostRoom = null, guestJoined = null, guestVideo = null, streamShots = null;
  if (relayHealth) {
    await host.evaluate(() => {
      try { window.__R4NET.setName('QA HOST'); } catch { /* ignore */ }
      try { window.__R4NET.hostRoom('DLSS5 QA', 2, ''); } catch { /* ignore */ }
    });
    hostRoom = await (async () => {
      const deadline = Date.now() + 30000;
      while (Date.now() < deadline) {
        const s = await host.evaluate(() => window.__R4NET?.snapshot?.() || null);
        if (s && s.isNetplay && s.owner && s.connected) return s;
        await sleep(700);
      }
      return null;
    })();
    check('4.2', 'Host creates a room', !!hostRoom, hostRoom ? `room=${hostRoom.room} players=${JSON.stringify(hostRoom.players)}` : 'no room');

    if (hostRoom) {
      const bootGuest = await boot(guest, netUrl, 'GUEST');
      await sleep(2000);
      const rooms = await (async () => {
        const deadline = Date.now() + 25000;
        while (Date.now() < deadline) {
          const r = await guest.evaluate(async (room) => {
            try {
              const rooms = await window.__R4NET.getRooms();
              const hit = Object.entries(rooms).find(([, v]) => v.room_name === room);
              return hit ? { sessionId: hit[0], room: hit[1] } : null;
            } catch { return null; }
          }, 'DLSS5 QA');
          if (r) return r;
          await sleep(800);
        }
        return null;
      })();
      if (rooms) {
        await guest.evaluate(({ sessionId, room }) => {
          window.__R4NET.setName('QA GUEST');
          window.__R4NET.joinRoom(sessionId, room.room_name, room.max, null);
        }, rooms);
        guestJoined = await (async () => {
          const deadline = Date.now() + 30000;
          while (Date.now() < deadline) {
            const s = await guest.evaluate(() => window.__R4NET?.snapshot?.() || null);
            if (s && s.isNetplay && !s.owner && s.connected) return s;
            await sleep(700);
          }
          return null;
        })();
        check('4.3', 'Guest joins the host room', !!guestJoined,
          guestJoined ? `players=${JSON.stringify(guestJoined.players)}` : `rooms=${JSON.stringify(rooms)}`);
      } else {
        check('4.3', 'Guest joins the host room', false, 'room not listed');
      }
      if (guestJoined) {
        // Arm the guest's own DLSS 5 path before testing the received stream.
        await activateDlss5(guest);
        await sleep(800);
        guestVideo = await (async () => {
          const deadline = Date.now() + 45000;
          while (Date.now() < deadline) {
            const s = await guest.evaluate(() => window.__R4NET?.snapshot?.() || null);
            if (s && s.video && s.video.w > 0 && s.video.readyState >= 2) return s;
            await sleep(900);
          }
          return null;
        })();
        check('4.4', 'Guest receives the host stream (video readyState >= 2)', !!guestVideo,
          guestVideo ? `video=${JSON.stringify(guestVideo.video)} peers=${JSON.stringify(guestVideo.peers)}` : 'no video');
        if (guestVideo) {
          const t1 = await guest.evaluate(() => window.EJS_emulator?.netplay?.video?.currentTime || 0);
          await sleep(1500);
          const t2 = await guest.evaluate(() => window.EJS_emulator?.netplay?.video?.currentTime || 0);
          check('4.5', 'Guest stream is live (currentTime advances)', t2 > t1, `${t1.toFixed(2)} -> ${t2.toFixed(2)}`);
          // The guest renders the received host stream locally, so verify the
          // guest's own FILTER DLSS 5 vs Off on that video.
          await guest.evaluate(() => { try { window.__R4NET?.closePanel?.(); } catch { /* ignore */ } });
          await host.evaluate(() => { try { window.__R4NET?.closePanel?.(); } catch { /* ignore */ } });
          await sleep(800);
          const guestClip = await guest.evaluate(() => {
            const game = document.querySelector('#game');
            if (!game) return null;
            const r = game.getBoundingClientRect();
            return { x: Math.max(0, r.x), y: Math.max(0, r.y), width: Math.min(r.width, innerWidth - r.x), height: Math.min(r.height, innerHeight - r.y) };
          });
          if (guestClip && guestClip.width > 2 && guestClip.height > 2) {
            const gsD = await setFilter(guest, 'dlss5');
            await sleep(1200);
            const gd = await shot(guest, 'net-guest-dlss5', { clip: guestClip });
            const gsO = await setFilter(guest, 'off');
            await sleep(1200);
            const go = await shot(guest, 'net-guest-off', { clip: guestClip });
            await setFilter(guest, 'dlss5');
            streamShots = {
              guestModeDlss: gsD.mode, guestModeOff: gsO.mode,
              dlss: gd.stats, off: go.stats, diff: comparePng(gd.buf, go.buf),
            };
            results.netStream = streamShots;
            check('4.6', 'Guest stream display carries the DLSS 5 look (guest DLSS 5 vs Off)',
              !!(gsD.mode !== 'none' && gsO.mode === 'none' && streamShots.dlss && streamShots.off && streamShots.dlss.edge > streamShots.off.edge * 1.005),
              `guest mode dlss=${gsD.mode} off=${gsO.mode} dlss edge=${streamShots.dlss?.edge} off edge=${streamShots.off?.edge} nonBlack dlss=${streamShots.dlss?.nonBlackPct} off=${streamShots.off?.nonBlackPct}`);
          } else {
            check('4.6', 'Guest stream display carries the DLSS 5 look (guest DLSS 5 vs Off)', false, `no guest clip ${JSON.stringify(guestClip)}`);
          }
        }
      }
    }
  } else {
    check('4.2', 'Host creates a room', false, 'relay unreachable');
    check('4.3', 'Guest joins the host room', false, 'relay unreachable');
    check('4.4', 'Guest receives the host stream', false, 'relay unreachable');
  }
  check('4.7', 'No page errors during netplay host/guest run',
    recHost.pageErrors.length === 0 && recGuest.pageErrors.length === 0,
    [...recHost.pageErrors, ...recGuest.pageErrors].join(' | ').slice(0, 500) || 'none');
  await ctxHost.close().catch(() => {});
  await ctxGuest.close().catch(() => {});

  // ================================================== 5b. mobile viewport
  const ctxMob = await browser.createBrowserContext();
  const mob = await ctxMob.newPage();
  const recMob = attach(mob, 'MOBILE');
  await mob.setViewport({ width: 390, height: 844, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
  await mob.goto(BASE + '/play?game=r4', { waitUntil: 'domcontentloaded', timeout: 60000 });
  await sleep(6000);
  const mobLayout = await mob.evaluate(() => {
    const sel = document.querySelector('#filterSelect');
    const foot = document.querySelector('#play-foot');
    const r = sel ? sel.getBoundingClientRect() : null;
    const fr = foot ? foot.getBoundingClientRect() : null;
    return {
      inner: { w: innerWidth, h: innerHeight },
      docScrollW: document.documentElement.scrollWidth,
      bodyScrollW: document.body.scrollWidth,
      overflowX: document.documentElement.scrollWidth > innerWidth + 1,
      select: r ? { x: r.x, y: r.y, w: r.width, h: r.height, visible: r.width > 0 && r.height > 0 && r.bottom <= innerHeight + 1 } : null,
      foot: fr ? { x: fr.x, y: fr.y, w: fr.width, h: fr.height } : null,
      options: Array.from(document.querySelectorAll('#filterSelect option')).map((o) => o.value),
      value: sel?.value,
    };
  });
  const mobFilter = await mob.evaluate(() => {
    const sel = document.querySelector('#filterSelect');
    if (!sel) return null;
    sel.value = 'scanlines';
    sel.dispatchEvent(new Event('change', { bubbles: true }));
    return { value: sel.value, body: document.body.dataset.filter };
  });
  results.mobile = { layout: mobLayout, filter: mobFilter };
  check('5.3', 'Mobile 390x844 has no horizontal overflow', !mobLayout.overflowX,
    `inner=${mobLayout.inner.w} doc=${mobLayout.docScrollW} body=${mobLayout.bodyScrollW}`);
  check('5.4', 'Mobile FILTER menu is visible/usable inside the viewport',
    !!(mobLayout.select && mobLayout.select.visible && mobLayout.options.includes('dlss5') && mobFilter?.body === 'scanlines'),
    `select=${JSON.stringify(mobLayout.select)} options=${mobLayout.options.length} switch=${JSON.stringify(mobFilter)}`);
  await shot(mob, 'mobile');
  await mob.evaluate(() => { const s = document.querySelector('#filterSelect'); if (s) { s.value = 'dlss5'; s.dispatchEvent(new Event('change', { bubbles: true })); } });
  check('5.5', 'No page errors during mobile check', recMob.pageErrors.length === 0,
    recMob.pageErrors.join(' | ').slice(0, 400) || 'none');
  await ctxMob.close().catch(() => {});

} catch (e) {
  check('X.1', 'QA script completed without an uncaught error', false, e && e.stack ? e.stack.slice(0, 1500) : String(e));
  log('UNCAUGHT', e);
} finally {
  results.finishedAt = new Date().toISOString();
  results.pageErrors = results.pageErrors || [];
  results.consoleErrors = results.console.filter((c) => /^\[error\]/.test(c.line));
  results.summary = {
    pass: results.checks.filter((c) => c.pass).length,
    fail: results.checks.filter((c) => !c.pass).length,
    total: results.checks.length,
  };
  fs.writeFileSync(path.join(OUT, 'dlss5-result.json'), JSON.stringify(results, null, 2));
  log(`SUMMARY ${results.summary.pass}/${results.summary.total} passed, ${results.summary.fail} failed`);
  await browser.close().catch(() => {});
}
