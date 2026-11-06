// Read-only QA for the native EmulatorJS page on the real LAN origin.
// Usage: node test-play-qa.mjs
// Server: http://localhost:8080/play (RR4_NO_AUTOSTART=1, RR4_STREAM_SOURCE=test)
//
// Current app serves r4.chd (341 MiB CHD; 621 MB raw BIN is the fallback).
// Produces:
//   ../_runtime/play-qa-*.png
//   ../_runtime/play-qa-result.json
// Does not modify the app.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import puppeteer from 'puppeteer-core';

const BASE = process.env.RR4_QA_BASE || 'http://localhost:8080';
const PLAY = BASE + '/play';
const OUT = '../_runtime';
const PROFILE = path.join(os.tmpdir(), 'rr4-play-qa-profile');
const BRAVE = 'C:/Program Files/BraveSoftware/Brave-Browser/Application/brave.exe';
const BOOT_TIMEOUT_MS = Number(process.env.RR4_QA_BOOT_TIMEOUT_MS || 240000);
fs.mkdirSync(OUT, { recursive: true });
for (const f of fs.readdirSync(OUT)) {
  if (/^play-qa-.*\.png$/.test(f)) fs.rmSync(path.join(OUT, f), { force: true });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const now = () => Date.now();
const log = (...a) => console.log(...a);

// ---- minimal PNG stats (no native deps) ------------------------------
function pngStats(buf) {
  if (buf.readUInt32BE(0) !== 0x89504e47) throw new Error('not png');
  let off = 8;
  let w = 0, h = 0, bitDepth = 8, colorType = 6, interlace = 0;
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
  let nonBlack = 0, sampled = 0, sum = 0;
  const colors = new Set();
  for (let y = 0; y < h; y += 3) {
    for (let x = 0; x < w; x += 3) {
      const i = y * stride + x * bpp;
      const r = out[i], g = out[i + 1], b = out[i + 2];
      sampled++;
      sum += (r + g + b) / 3;
      if (r + g + b > 24) nonBlack++;
      colors.add(((r >> 4) << 8) | ((g >> 4) << 4) | (b >> 4));
    }
  }
  return {
    width: w, height: h,
    nonBlackPct: +((nonBlack / sampled) * 100).toFixed(1),
    avgLuma: +(sum / sampled).toFixed(1),
    distinctColors: colors.size,
  };
}

function attach(page, label) {
  const rec = {
    label, console: [], pageErrors: [], reqFailed: [], httpErrors: [], external: [],
    romRequests: [], romResponses: [], allRequests: [],
  };
  page.on('console', (m) => {
    const line = `[${m.type()}] ${m.text()}`;
    rec.console.push(line);
    if (m.type() === 'error') log(`  CONSOLE[${label}]`, line.slice(0, 500));
  });
  page.on('pageerror', (e) => {
    rec.pageErrors.push(e.message);
    log(`  PAGEERROR[${label}]`, e.message.slice(0, 500));
  });
  page.on('requestfailed', (r) => {
    const item = { url: r.url(), err: r.failure()?.errorText, type: r.resourceType() };
    rec.reqFailed.push(item);
    log(`  REQFAIL[${label}]`, item.url.slice(0, 180), item.err);
  });
  page.on('request', (r) => {
    const u = r.url();
    const item = { method: r.method(), url: u, type: r.resourceType(), at: now() };
    rec.allRequests.push(item);
    if (/\/rom\/.*\.(bin|cue|iso|chd|img)(\?|$)/i.test(u)) rec.romRequests.push(item);
  });
  page.on('response', async (r) => {
    const u = r.url();
    try {
      if (r.status() >= 400) {
        rec.httpErrors.push({ url: u, status: r.status() });
        log(`  HTTP[${label}]`, r.status(), u.slice(0, 200));
      }
      if (/\/rom\/.*\.(bin|cue|iso|chd|img)(\?|$)/i.test(u)) {
        const h = r.headers();
        rec.romResponses.push({
          url: u, method: r.request().method(), status: r.status(),
          fromCache: typeof r.fromCache === 'function' ? r.fromCache() : null,
          contentLength: h['content-length'] || null,
          contentRange: h['content-range'] || null,
          acceptRanges: h['accept-ranges'] || null,
        });
      }
      if (!u.startsWith(BASE) && !u.startsWith('blob:') && !u.startsWith('data:')) {
        rec.external.push({ url: u, status: r.status() });
      }
    } catch { /* ignore */ }
  });
  return rec;
}

const shots = [];
async function shot(page, name, opts = {}) {
  const file = path.join(OUT, `play-qa-${name}.png`);
  const buf = await page.screenshot({ path: file, ...opts });
  let stats = null;
  try { stats = pngStats(buf); } catch (e) { stats = { error: e.message }; }
  const rec = {
    name, file,
    sha256: crypto.createHash('sha256').update(buf).digest('hex').slice(0, 16),
    stats,
    ...(opts.clip ? { clip: opts.clip } : {}),
  };
  shots.push(rec);
  log(`  SHOT ${name}`, JSON.stringify({ sha: rec.sha256, ...stats }));
  return { ...rec, buffer: buf };
}

async function canvasRect(page) {
  return page.evaluate(() => {
    const c = document.querySelector('#game canvas');
    if (!c) return null;
    const r = c.getBoundingClientRect();
    return {
      x: Math.max(0, Math.round(r.x)), y: Math.max(0, Math.round(r.y)),
      width: Math.max(1, Math.round(r.width)), height: Math.max(1, Math.round(r.height)),
      canvasW: c.width, canvasH: c.height, cssW: c.clientWidth, cssH: c.clientHeight,
    };
  });
}

async function shotCanvas(page, name) {
  const r = await canvasRect(page);
  if (!r) return null;
  // Keep the clip inside the viewport.
  const vp = page.viewport();
  const x = Math.max(0, Math.min(r.x, vp.width - 2));
  const y = Math.max(0, Math.min(r.y, vp.height - 2));
  const width = Math.max(2, Math.min(r.width, vp.width - x));
  const height = Math.max(2, Math.min(r.height, vp.height - y));
  const clip = { x, y, width, height };
  return shot(page, name, { clip });
}

async function state(page) {
  try {
    return await page.evaluate(() => {
      const s = window.__R4;
      const c = document.querySelector('#game canvas');
      const st = document.querySelector('#bootStatus');
      const ov = document.querySelector('#bootOverlay');
      const em = window.EJS_emulator;
      return {
        hasR4: !!s,
        game: s?.game, gameName: s?.gameName, bios: s?.bios, cue: s?.cue, threads: s?.threads,
        startedAt: s?.startedAt || null, readyAt: s?.readyAt || null, bootMs: s?.bootMs ?? null,
        errors: s?.errors || [],
        events: s?.events?.map((e) => e.name) || [],
        rom: s?.rom ? { ms: s.rom.ms, mb: s.rom.mb, mbps: s.rom.mbps, loaded: s.rom.loaded, status: s.rom.status } : null,
        transfers: s?.transfers || [],
        romResource: s?.romResource || null,
        canvas: c ? { w: c.width, h: c.height, cw: c.clientWidth, ch: c.clientHeight } : null,
        canvasRect: c ? (() => { const r = c.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; })() : null,
        status: st ? { text: st.textContent, state: st.dataset.state } : null,
        overlay: ov ? { hidden: ov.hidden, text: document.querySelector('#overlayText')?.textContent, title: document.querySelector('#overlayTitle')?.textContent } : null,
        selector: (() => {
          const sel = document.querySelector('#gameSelect');
          return sel ? { value: sel.value, options: Array.from(sel.options).map((o) => ({ value: o.value, text: o.textContent })) } : null;
        })(),
        ejs: em ? {
          started: em.started, paused: em.paused, fullscreen: em.fullscreen,
          touch: em.touch, hasTouchScreen: em.hasTouchScreen, isMobile: em.isMobile,
          virtualGamepadDisplay: em.virtualGamepad ? getComputedStyle(em.virtualGamepad).display : null,
          virtualGamepadChildren: em.virtualGamepad ? em.virtualGamepad.children.length : null,
          gamepads: em.gamepad ? em.gamepad.gamepads.map((g) => ({ id: g.id, index: g.index })) : null,
          gamepadSelection: em.gamepadSelection || null,
          menuButtons: Array.from(document.querySelectorAll('#game .ejs_menu_button')).map((b) => b.innerText.trim()),
        } : null,
        viewport: { w: innerWidth, h: innerHeight, dpr: devicePixelRatio },
        doc: { scrollW: document.documentElement.scrollWidth, clientW: document.documentElement.clientWidth, scrollH: document.documentElement.scrollHeight },
        touchPoints: navigator.maxTouchPoints,
        isSecureContext,
        coi: { coep: crossOriginIsolated },
      };
    });
  } catch (e) {
    return { evalError: String(e) };
  }
}

async function waitStarted(page, label, timeout = BOOT_TIMEOUT_MS) {
  const t0 = now();
  let last = null;
  let lastShot = 0;
  while (now() - t0 < timeout) {
    last = await state(page);
    if (last.startedAt) return { ok: true, ms: now() - t0, state: last };
    if (last.startBtn) {
      await page.evaluate(() => document.querySelector('#game .ejs_start_button')?.click());
    }
    if (now() - lastShot > 15000) {
      lastShot = now();
      log(`  [${label}] waiting ${Math.round((now() - t0) / 1000)}s status=${last.status?.text} overlay=${last.overlay?.text}`);
    }
    await sleep(500);
  }
  return { ok: false, ms: now() - t0, state: last };
}

async function audioInfo(page) {
  return page.evaluate(() => {
    const em = window.EJS_emulator;
    const out = { exists: !!em, contexts: [] };
    if (!em) return out;
    const add = (pathName, ctx) => {
      if (!ctx) return;
      out.contexts.push({
        path: pathName,
        state: ctx.state || null,
        sampleRate: ctx.sampleRate || null,
        currentTime: typeof ctx.currentTime === 'number' ? +ctx.currentTime.toFixed(2) : null,
      });
    };
    try { add('Module.AL.currentCtx.audioCtx', em.Module?.AL?.currentCtx?.audioCtx); } catch { }
    try {
      const srcs = em.Module?.AL?.currentCtx?.sources || [];
      srcs.forEach((s, i) => add(`Module.AL.currentCtx.sources[${i}].gain.context`, s?.gain?.context));
    } catch { }
    try { add('emulator.audioContext', em.audioContext); } catch { }
    out.muted = em.muted;
    out.volume = em.volume;
    out.popup = Array.from(document.querySelectorAll('#game .ejs_popup_box')).map((e) => e.innerText.trim()).filter(Boolean);
    out.resumeButton = !!Array.from(document.querySelectorAll('#game button')).find((b) => /resume emulator/i.test(b.innerText));
    return out;
  });
}

const results = {
  startedAt: new Date().toISOString(),
  base: BASE, play: PLAY,
  browser: null,
  firstLoad: null,
  frameRender: null,
  input: null,
  fullscreen: null,
  audio: null,
  cache: null,
  mobile: null,
  selector: null,
  controller: null,
  landing: null,
  fps: null,
  console: null,
  shots,
  bugs: [],
};

let browser;
try {
  // Fresh profile so the first load is a real cold cache.
  fs.rmSync(PROFILE, { recursive: true, force: true });
  browser = await puppeteer.launch({
    executablePath: BRAVE,
    headless: 'new',
    userDataDir: PROFILE,
    args: [
      '--no-sandbox',
      '--disable-dev-shm-usage',
      '--enable-unsafe-swiftshader',
      '--use-angle=swiftshader',
      '--window-size=1280,800',
      '--js-flags=--max-old-space-size=4096',
      '--disable-background-timer-throttling',
      '--disable-renderer-backgrounding',
      '--disable-backgrounding-occluded-windows',
      '--mute-audio',
    ],
    defaultViewport: { width: 1280, height: 800 },
  });
  results.browser = await browser.version();
  log('BROWSER', results.browser);

  // =====================================================================
  // 1. Cold first load on the LAN origin
  // =====================================================================
  const page = await browser.newPage();
  const rec = attach(page, 'main');
  const t0 = now();
  log('NAV', PLAY);
  await page.goto(PLAY, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await shot(page, '01-loading');
  const boot = await waitStarted(page, 'main');
  const loadMs = now() - t0;
  results.firstLoad = {
    ok: boot.ok,
    navToStartedMs: loadMs,
    state: boot.state,
    consoleErrors: rec.console.filter((l) => l.startsWith('[error]')),
    pageErrors: rec.pageErrors,
    reqFailed: rec.reqFailed,
    httpErrors: rec.httpErrors,
    external: rec.external,
    romRequests: rec.romRequests,
    romResponses: rec.romResponses,
  };
  log('FIRST LOAD', JSON.stringify({ ok: boot.ok, ms: loadMs, bootMs: boot.state?.bootMs, rom: boot.state?.rom, errors: boot.state?.errors }));

  if (!boot.ok) throw new Error('Game did not start on first load');

  // =====================================================================
  // 2. Audio state + the app's "CLICK TO RACE" sound gate.
  //    Measure before any gesture, then dismiss the gate with a real click.
  // =====================================================================
  await sleep(1200); // showGate() is scheduled ~600 ms after start
  const audioBefore = await audioInfo(page);
  const gateBefore = await page.evaluate(() => {
    const g = document.querySelector('#soundGate');
    return g ? { hidden: g.hidden, display: getComputedStyle(g).display, text: g.innerText.replace(/\s+/g, ' ').trim() } : null;
  });
  let gateClick = { clicked: false, error: null };
  if (gateBefore && !gateBefore.hidden) {
    try { await page.click('#soundGate'); gateClick.clicked = true; } catch (e) { gateClick.error = String(e); }
    await sleep(800);
  }
  const audioAfterGate = await audioInfo(page);
  const gateAfter = await page.evaluate(() => {
    const g = document.querySelector('#soundGate');
    return g ? { hidden: g.hidden, display: getComputedStyle(g).display } : null;
  });
  results.audio = { before: audioBefore, gateBefore, gateClick, afterGate: audioAfterGate, gateAfter };

  // Install instrumentation for keyboard/gamepad input reaching the core.
  await page.evaluate(() => {
    window.__r4Keys = [];
    window.addEventListener('keydown', (e) => window.__r4Keys.push({ key: e.key, code: e.code }), true);
    const gm = window.EJS_emulator?.gameManager;
    if (gm && !gm.__r4Wrapped) {
      gm.__r4Wrapped = true;
      const orig = gm.simulateInput.bind(gm);
      window.__r4Inputs = [];
      gm.simulateInput = (...a) => {
        window.__r4Inputs.push({ args: a, at: Math.round(performance.now()) });
        return orig(...a);
      };
    }
  });

  // Capture actual emulator frames once the DOM gate is gone. Some PSX boot
  // screens are legitimately black, so sample a few points and keep them all.
  const frameSeries = [];
  for (const [waitMs, name] of [[2500, '02-intro'], [6000, '03-title'], [6000, '04-late']]) {
    await sleep(waitMs);
    const full = await shot(page, name);
    const canv = await shotCanvas(page, `${name}-canvas`);
    frameSeries.push({ name, fullSha: full.sha256, fullStats: full.stats, canvasSha: canv?.sha256, canvasStats: canv?.stats || null });
  }
  // Frame-to-frame proof that the emulator is rendering (not a frozen/black canvas).
  const frameA = await shotCanvas(page, '05-frame-a');
  await sleep(1000);
  const frameB = await shotCanvas(page, '06-frame-b');
  results.frameRender = {
    series: frameSeries,
    frameA: frameA ? { sha: frameA.sha256, stats: frameA.stats } : null,
    frameB: frameB ? { sha: frameB.sha256, stats: frameB.stats } : null,
    changed: !!(frameA && frameB && frameA.sha256 !== frameB.sha256),
    canvas: boot.state?.canvas,
    canvasRect: boot.state?.canvasRect,
  };

  // =====================================================================
  // 3. Input: click canvas, press Enter / arrows, observe core input calls.
  //    Case A = gate-dismiss only (focus still outside EJS); case B = click canvas.
  // =====================================================================
  await page.evaluate(() => { window.__r4Inputs = []; window.__r4Keys = []; });
  await page.keyboard.press('Enter');
  await sleep(1200);
  const caseA = await page.evaluate(() => ({
    inputs: (window.__r4Inputs || []).slice(0, 20),
    inputCount: (window.__r4Inputs || []).length,
    keys: window.__r4Keys || [],
    focused: document.activeElement?.id || document.activeElement?.className || document.activeElement?.tagName,
  }));

  const preInput = await shotCanvas(page, '07-before-input');
  const cr = await canvasRect(page);
  await page.mouse.click(cr.x + cr.width / 2, cr.y + cr.height / 2);
  await sleep(500);
  await page.evaluate(() => { window.__r4Inputs = []; window.__r4Keys = []; });
  await page.keyboard.press('Enter');
  await sleep(1500);
  await page.keyboard.press('ArrowDown');
  await sleep(500);
  await page.keyboard.press('Enter');
  await sleep(3000);
  const postInput = await shotCanvas(page, '08-after-input');
  await shot(page, '09-after-input-page');
  await sleep(7000);
  const postInputWait = await shotCanvas(page, '10-after-input-wait');
  const caseB = await page.evaluate(() => ({
    inputs: (window.__r4Inputs || []).slice(0, 20),
    inputCount: (window.__r4Inputs || []).length,
    keys: window.__r4Keys || [],
    focused: document.activeElement?.id || document.activeElement?.className || document.activeElement?.tagName,
  }));
  results.input = {
    caseA_gateOnly: caseA,
    caseB_canvasClick: caseB,
    before: preInput ? { sha: preInput.sha256, stats: preInput.stats } : null,
    after: postInput ? { sha: postInput.sha256, stats: postInput.stats } : null,
    afterWait: postInputWait ? { sha: postInputWait.sha256, stats: postInputWait.stats } : null,
    changed: !!(preInput && postInput && preInput.sha256 !== postInput.sha256),
  };

  // Audio after the canvas click gesture.
  results.audio.afterClick = await audioInfo(page);

  // =====================================================================
  // 4. FPS (5s): browser rAF + the emulator's own frame counter
  // =====================================================================
  const rafFps = await page.evaluate(() => new Promise((resolve) => {
    let frames = 0;
    let first = 0;
    const times = [];
    const t0 = performance.now();
    function tick(t) {
      if (!first) first = t;
      frames++;
      times.push(t);
      if (t - t0 < 5000) requestAnimationFrame(tick);
      else {
        const elapsed = t - first;
        const deltas = [];
        for (let i = 1; i < times.length; i++) deltas.push(times[i] - times[i - 1]);
        deltas.sort((a, b) => a - b);
        resolve({
          frames, elapsedMs: Math.round(elapsed),
          fps: +(frames / (elapsed / 1000)).toFixed(1),
          medianFrameMs: deltas.length ? +deltas[Math.floor(deltas.length / 2)].toFixed(2) : null,
          p95FrameMs: deltas.length ? +deltas[Math.floor(deltas.length * 0.95)].toFixed(2) : null,
          minFrameMs: deltas.length ? +deltas[0].toFixed(2) : null,
          maxFrameMs: deltas.length ? +deltas[deltas.length - 1].toFixed(2) : null,
        });
      }
    }
    requestAnimationFrame(tick);
  }));
  const emuFrames = await page.evaluate(() => {
    const gm = window.EJS_emulator?.gameManager;
    try { return { ok: true, f0: gm.getFrameNum(), t0: performance.now() }; } catch (e) { return { ok: false, error: String(e) }; }
  });
  await sleep(5000);
  const emuFrames2 = await page.evaluate(() => {
    const gm = window.EJS_emulator?.gameManager;
    try { return { ok: true, f1: gm.getFrameNum(), t1: performance.now() }; } catch (e) { return { ok: false, error: String(e) }; }
  });
  results.fps = {
    raf: rafFps,
    emulator: (emuFrames.ok && emuFrames2.ok)
      ? {
        frames: emuFrames2.f1 - emuFrames.f0,
        elapsedMs: Math.round(emuFrames2.t1 - emuFrames.t0),
        fps: +(((emuFrames2.f1 - emuFrames.f0) / ((emuFrames2.t1 - emuFrames.t0) / 1000))).toFixed(1),
      }
      : { error: emuFrames.error || emuFrames2.error },
  };

  // =====================================================================
  // 5. Fullscreen control: app header button + EJS menu control
  // =====================================================================
  const fsInfo = await page.evaluate(() => {
    const em = window.EJS_emulator;
    const appBtn = document.querySelector('#fsBtn');
    const appExit = document.querySelector('#fsExit');
    const btns = Array.from(document.querySelectorAll('#game .ejs_menu_button'));
    const labels = btns.map((b) => b.innerText.trim());
    const enter = btns.find((b) => /enter fullscreen/i.test(b.innerText));
    const rect = appBtn ? appBtn.getBoundingClientRect() : null;
    return {
      appButton: appBtn ? {
        text: appBtn.innerText.replace(/\s+/g, ' ').trim(), title: appBtn.getAttribute('title'),
        disabled: appBtn.disabled, display: getComputedStyle(appBtn).display,
        rect: { x: rect.x, y: rect.y, w: rect.width, h: rect.height },
      } : null,
      appExitHidden: appExit ? appExit.hidden : null,
      ejsHasToggle: typeof em?.toggleFullscreen === 'function',
      ejsLabels: labels,
      ejsEnter: enter ? { text: enter.innerText.trim(), display: getComputedStyle(enter).display } : null,
      parentRequestFullscreen: typeof document.querySelector('#game .ejs_parent')?.requestFullscreen === 'function',
      fullscreenElement: !!document.fullscreenElement,
    };
  });
  let fsClick = { clicked: false, error: null };
  if (fsInfo.appButton && fsInfo.appButton.rect.w > 0) {
    try {
      await page.click('#fsBtn');
      fsClick.clicked = true;
    } catch (e) { fsClick.error = String(e); }
    await sleep(1400);
  } else {
    fsClick.error = 'app fullscreen button missing or not clickable';
  }
  const fsAfter = await page.evaluate(() => {
    const em = window.EJS_emulator;
    const el = document.fullscreenElement;
    const r = el?.getBoundingClientRect();
    const appExit = document.querySelector('#fsExit');
    const c = document.querySelector('#game canvas');
    const cr = c ? c.getBoundingClientRect() : null;
    return {
      fullscreenElement: el ? (el.id || el.className || el.tagName) : null,
      emulatorFullscreen: em?.fullscreen,
      stateFs: window.__R4?.fs,
      bodyFs: document.body.classList.contains('fs'),
      appExitHidden: appExit ? appExit.hidden : null,
      appBtnText: document.querySelector('#fsBtn')?.innerText.replace(/\s+/g, ' ').trim(),
      status: document.querySelector('#bootStatus')?.textContent,
      errors: window.__R4?.errors || [],
      rect: r ? { x: r.x, y: r.y, w: r.width, h: r.height } : null,
      canvasRect: cr ? { x: cr.x, y: cr.y, w: cr.width, h: cr.height } : null,
      viewport: { w: innerWidth, h: innerHeight },
    };
  });
  await shot(page, '11-fullscreen');
  let fsExit = null;
  if (fsAfter.fullscreenElement) {
    try { await page.keyboard.press('Escape'); } catch { }
    await sleep(800);
    if (await page.evaluate(() => !!document.fullscreenElement)) {
      await page.evaluate(() => document.exitFullscreen().catch(() => { }));
      await sleep(500);
    }
    fsExit = await page.evaluate(() => ({
      fullscreenElement: !!document.fullscreenElement,
      bodyFs: document.body.classList.contains('fs'),
      appExitHidden: document.querySelector('#fsExit')?.hidden,
      appBtnText: document.querySelector('#fsBtn')?.innerText.replace(/\s+/g, ' ').trim(),
    }));
  }
  results.fullscreen = { before: fsInfo, click: fsClick, after: fsAfter, exit: fsExit };

  // =====================================================================
  // 6. Cache / reload: second load must not re-download 621 MB
  // =====================================================================
  await sleep(8000); // give IndexedDB the chance to finish the 621 MB write
  const cacheSizes = await page.evaluate(async () => {
    try { return await window.EJS_emulator.storage.rom.getSizes(); } catch (e) { return { error: String(e) }; }
  });
  const perfRomBefore = await page.evaluate(() => performance.getEntriesByType('resource')
    .filter((e) => /\/rom\/.*\.(bin|cue|iso|chd)(\?|$)/i.test(e.name))
    .map((e) => ({ name: decodeURIComponent(e.name).split('/').pop(), durationMs: Math.round(e.duration), transferMB: +(e.transferSize / 1048576).toFixed(1), encodedMB: +(e.encodedBodySize / 1048576).toFixed(1), decodedMB: +(e.decodedBodySize / 1048576).toFixed(1) })));

  // Reset network recorders for the reload.
  rec.romRequests.length = 0;
  rec.romResponses.length = 0;
  rec.allRequests.length = 0;
  rec.httpErrors.length = 0;
  rec.reqFailed.length = 0;
  rec.pageErrors.length = 0;
  rec.console.length = 0;
  const tReload = now();
  log('RELOAD', PLAY);
  await page.reload({ waitUntil: 'domcontentloaded', timeout: 60000 });
  const boot2 = await waitStarted(page, 'reload');
  const reloadMs = now() - tReload;
  await sleep(2000);
  await shot(page, '12-reload');
  const reloadState = await state(page);
  const reloadPerf = await page.evaluate(() => performance.getEntriesByType('resource')
    .filter((e) => /\/rom\/.*\.(bin|cue|iso|chd)(\?|$)/i.test(e.name))
    .map((e) => ({ name: decodeURIComponent(e.name).split('/').pop(), durationMs: Math.round(e.duration), transferMB: +(e.transferSize / 1048576).toFixed(1), encodedMB: +(e.encodedBodySize / 1048576).toFixed(1), decodedMB: +(e.decodedBodySize / 1048576).toFixed(1) })));
  const fullDownloads = rec.romResponses.filter((r) => r.method === 'GET' && r.status === 200 && Number(r.contentLength) > 1048576);
  const rangeProbes = rec.romResponses.filter((r) => r.method === 'GET' && (r.status === 206 || /bytes=/.test(r.contentRange || '')));
  const perfFull = reloadPerf.some((r) => r.transferMB > 1);
  results.cache = {
    first: {
      navToStartedMs: loadMs,
      state: results.firstLoad.state,
      romRequests: results.firstLoad.romRequests,
      romResponses: results.firstLoad.romResponses,
      cacheSizes,
      perfRom: perfRomBefore,
    },
    second: {
      ok: boot2.ok,
      navToStartedMs: reloadMs,
      state: reloadState,
      romRequests: rec.romRequests,
      romResponses: rec.romResponses,
      allRequests: rec.allRequests,
      pageErrors: rec.pageErrors,
      consoleErrors: rec.console.filter((l) => l.startsWith('[error]')),
      httpErrors: rec.httpErrors,
      reqFailed: rec.reqFailed,
      perfRom: reloadPerf,
      fullDownloads,
      rangeProbes,
    },
    speedup: loadMs > 0 ? +(loadMs / Math.max(1, reloadMs)).toFixed(2) : null,
    romRedownloaded: fullDownloads.length > 0 || perfFull,
    idbHit: !!(reloadState && reloadState.transfers && reloadState.transfers.length === 0),
  };
  log('RELOAD RESULT', JSON.stringify({ ok: boot2.ok, ms: reloadMs, romRequests: rec.romRequests.length, transfers: reloadState?.transfers, perfRom: reloadPerf }));

  // =====================================================================
  // 7. Game selector: Type 4 selected, Rage Racer pending
  // =====================================================================
  const selInfo = await page.evaluate(() => {
    const s = document.querySelector('#gameSelect');
    return s ? { value: s.value, options: Array.from(s.options).map((o) => ({ value: o.value, text: o.textContent })) } : null;
  });
  const rage = await browser.newPage();
  const recRage = attach(rage, 'rage');
  await rage.setViewport({ width: 1280, height: 800 });
  await rage.goto(PLAY + '?game=rage', { waitUntil: 'domcontentloaded', timeout: 60000 });
  let rageState = null;
  let rageBootMs = null;
  const rageT0 = now();
  const rageDeadline = now() + 90000;
  while (now() < rageDeadline) {
    rageState = await state(rage);
    if (rageState.startedAt) { rageBootMs = now() - rageT0; break; }
    if (rageState.status?.text === 'ERROR' || (rageState.overlay?.text && /not installed|failed|error/i.test(rageState.overlay.text))) break;
    await sleep(500);
  }
  await sleep(1500);
  await shot(rage, '13-selector-rage');
  let rageFrame = null;
  if (rageState?.startedAt) {
    await rage.evaluate(() => document.querySelector('#soundGate')?.click());
    await sleep(6000);
    rageFrame = await shotCanvas(rage, '13b-selector-rage-frame');
  }
  results.selector = {
    main: selInfo,
    rage: {
      bootMs: rageBootMs,
      booted: !!rageState?.startedAt,
      frame: rageFrame ? { sha: rageFrame.sha256, stats: rageFrame.stats } : null,
      state: rageState,
      pageErrors: recRage.pageErrors,
      consoleErrors: recRage.console.filter((l) => l.startsWith('[error]')),
      httpErrors: recRage.httpErrors,
      reqFailed: recRage.reqFailed,
    },
  };
  await rage.close();

  // =====================================================================
  // 8. Controller: mock Xbox + DualSense, check EJS detection / settings
  // =====================================================================
  const padPage = await browser.newPage();
  const recPad = attach(padPage, 'controller');
  await padPage.setViewport({ width: 1280, height: 800 });
  await padPage.evaluateOnNewDocument(() => {
    const mk = (index, id) => ({
      index, id, connected: true, mapping: 'standard', timestamp: performance.now(),
      axes: [0, 0, 0, 0],
      buttons: Array.from({ length: 17 }, () => ({ pressed: false, touched: false, value: 0 })),
    });
    const pads = [
      mk(0, 'Xbox Wireless Controller (STANDARD GAMEPAD Vendor: 045e Product: 0b13)'),
      mk(1, 'DualSense Wireless Controller (STANDARD GAMEPAD Vendor: 054c Product: 0ce6)'),
    ];
    window.__mockPads = pads;
    Object.defineProperty(navigator, 'getGamepads', { configurable: true, value: () => pads });
  });
  await padPage.goto(PLAY, { waitUntil: 'domcontentloaded', timeout: 60000 });
  const bootPad = await waitStarted(padPage, 'controller');
  await sleep(1500);
  const padInfo = await padPage.evaluate(() => {
    const em = window.EJS_emulator;
    const labels = (em?.gamepadLabels || []).map((l) => ({
      index: l.getAttribute('index'),
      value: l.value,
      options: Array.from(l.options).map((o) => ({ value: o.value, text: o.textContent })),
    }));
    return {
      getGamepads: (navigator.getGamepads ? navigator.getGamepads() : []).map((g) => g && ({ id: g.id, index: g.index, connected: g.connected })),
      handlerPads: em?.gamepad ? em.gamepad.gamepads.map((g) => ({ id: g.id, index: g.index })) : null,
      selection: em?.gamepadSelection || null,
      labels,
      controlMenuOpen: em?.controlMenu ? getComputedStyle(em.controlMenu).display : null,
      settings: em ? {
        gamepadEnabled: em.getSettingValue ? em.getSettingValue('gamepad') : null,
      } : null,
    };
  });
  // Open the Control Settings popup for a screenshot (pads connected before boot).
  await padPage.evaluate(() => {
    const em = window.EJS_emulator;
    if (em?.controlMenu) em.controlMenu.style.display = '';
  });
  await sleep(500);
  await shot(padPage, '14-controller');
  // Close Control Settings: EJS consumes pad presses while it is open.
  await padPage.evaluate(() => {
    const em = window.EJS_emulator;
    if (em?.controlMenu) em.controlMenu.style.display = 'none';
  });
  await sleep(300);

  // Prove whether an already-connected pad actually drives the core.
  await padPage.evaluate(() => {
    const gm = window.EJS_emulator?.gameManager;
    if (gm && !gm.__r4PadWrapped) {
      gm.__r4PadWrapped = true;
      const orig = gm.simulateInput.bind(gm);
      window.__r4PadInputs = [];
      gm.simulateInput = (...a) => {
        window.__r4PadInputs.push({ args: a, at: Math.round(performance.now()) });
        return orig(...a);
      };
    }
  });
  const pressPad9 = async () => {
    await padPage.evaluate(() => { window.__mockPads[0].buttons[9] = { pressed: true, touched: true, value: 1 }; });
    await sleep(350);
    await padPage.evaluate(() => { window.__mockPads[0].buttons[9] = { pressed: false, touched: false, value: 0 }; });
    await sleep(350);
    return padPage.evaluate(() => (window.__r4PadInputs || []).slice());
  };
  const padPressUnmapped = await pressPad9();
  const padSelectionBefore = await padPage.evaluate(() => window.EJS_emulator?.gamepadSelection || null);
  // Manually map player 1 to the Xbox pad, as a user would in Control Settings.
  await padPage.evaluate(() => {
    const em = window.EJS_emulator;
    const id = window.__mockPads[0].id + '_0';
    if (em) { em.gamepadSelection[0] = id; em.updateGamepadLabels(); }
  });
  await sleep(300);
  await padPage.evaluate(() => { window.__r4PadInputs = []; });
  const padPressMapped = await pressPad9();
  await padPage.evaluate(() => {
    const em = window.EJS_emulator;
    if (em?.controlMenu) em.controlMenu.style.display = '';
  });
  await sleep(300);
  await shot(padPage, '15-controller-mapped');
  const padInfo2 = await padPage.evaluate(() => ({
    selection: window.EJS_emulator?.gamepadSelection || null,
    labelValues: (window.EJS_emulator?.gamepadLabels || []).map((l) => l.value),
  }));
  results.controller = {
    ok: bootPad.ok,
    state: bootPad.state,
    ...padInfo,
    pressUnmapped: padPressUnmapped,
    selectionBefore: padSelectionBefore,
    pressMapped: padPressMapped,
    afterManualMap: padInfo2,
    pageErrors: recPad.pageErrors,
    consoleErrors: recPad.console.filter((l) => l.startsWith('[error]')),
    httpErrors: recPad.httpErrors,
  };
  await padPage.close();

  // =====================================================================
  // 9. Mobile 390x844
  // =====================================================================
  const mob = await browser.newPage();
  const recMob = attach(mob, 'mobile');
  await mob.setViewport({ width: 390, height: 844, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
  await mob.setUserAgent('Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36');
  await mob.goto(PLAY, { waitUntil: 'domcontentloaded', timeout: 60000 });
  const bootMob = await waitStarted(mob, 'mobile');
  // Dismiss the sound gate and close the EJS menu so the game + touch pad are visible.
  await sleep(1200);
  const gateMob = await mob.evaluate(() => {
    const g = document.querySelector('#soundGate');
    return g ? { hidden: g.hidden, text: g.innerText.replace(/\s+/g, ' ').trim() } : null;
  });
  if (gateMob && !gateMob.hidden) {
    // Programmatic click: on mobile the EJS menu can sit above the gate.
    await mob.evaluate(() => document.querySelector('#soundGate')?.click());
    await sleep(600);
  }
  await mob.evaluate(() => {
    try { window.EJS_emulator?.menu?.close?.(); } catch { }
    try { window.EJS_emulator?.closePopup?.(); } catch { }
  });
  await sleep(3500);
  await mob.evaluate(() => {
    const gm = window.EJS_emulator?.gameManager;
    if (gm && !gm.__r4MobWrapped) {
      gm.__r4MobWrapped = true;
      const orig = gm.simulateInput.bind(gm);
      window.__r4MobInputs = [];
      gm.simulateInput = (...a) => { window.__r4MobInputs.push({ args: a, at: Math.round(performance.now()) }); return orig(...a); };
    }
  });
  const mobInfo = await state(mob);
  const mobLayout = await mob.evaluate(() => {
    const c = document.querySelector('#game canvas');
    const vg = window.EJS_emulator?.virtualGamepad;
    const cr = c ? c.getBoundingClientRect() : null;
    const vr = vg ? vg.getBoundingClientRect() : null;
    const vis = (el) => {
      if (!el) return null;
      const s = getComputedStyle(el);
      const r = el.getBoundingClientRect();
      return { display: s.display, visibility: s.visibility, opacity: s.opacity, w: r.width, h: r.height, x: r.x, y: r.y };
    };
    return {
      canvas: cr ? { x: cr.x, y: cr.y, w: cr.width, h: cr.height } : null,
      virtualGamepad: vis(vg),
      virtualGamepadChildren: vg ? Array.from(vg.children).map((ch) => ({ cls: ch.className, text: ch.innerText?.slice(0, 20), ...vis(ch) })) : null,
      menuToggle: vis(document.querySelector('#game .ejs_virtualGamepad_open')),
      fsBtn: vis(document.querySelector('#fsBtn')),
      foot: vis(document.querySelector('#play-foot')),
      overflowX: document.documentElement.scrollWidth > document.documentElement.clientWidth,
      scrollW: document.documentElement.scrollWidth,
      clientW: document.documentElement.clientWidth,
      bodyScrollW: document.body.scrollWidth,
      inner: { w: innerWidth, h: innerHeight },
      touchPoints: navigator.maxTouchPoints,
      hasTouch: window.EJS_emulator?.hasTouchScreen,
    };
  });
  await shot(mob, '16-mobile');
  // Tap the on-screen Start button and verify it reaches the core.
  const startRect = await mob.evaluate(() => {
    const vg = window.EJS_emulator?.virtualGamepad;
    if (!vg) return null;
    const el = Array.from(vg.querySelectorAll('.ejs_virtualGamepad_button, .ejs_virtualGamepad_bottom div, .ejs_virtualGamepad_bottom span'))
      .find((b) => /^start$/i.test((b.innerText || '').trim()));
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: r.x, y: r.y, w: r.width, h: r.height, text: el.innerText.trim() };
  });
  // 1) Synthetic touch on the Start button: proves the pad handler is wired.
  const syntheticStart = await mob.evaluate(() => {
    const vg = window.EJS_emulator?.virtualGamepad;
    const el = vg ? Array.from(vg.querySelectorAll('.ejs_virtualGamepad_button')).find((b) => /^start$/i.test((b.innerText || '').trim())) : null;
    if (!el) return { found: false, count: 0 };
    window.__r4MobInputs = [];
    el.dispatchEvent(new Event('touchstart', { bubbles: true, cancelable: true }));
    el.dispatchEvent(new Event('touchend', { bubbles: true, cancelable: true }));
    return { found: true, count: (window.__r4MobInputs || []).length, inputs: (window.__r4MobInputs || []).slice(0, 6) };
  });
  await sleep(400);
  // 2) Real touchscreen tap on the same on-screen Start button.
  await mob.evaluate(() => { try { window.EJS_emulator?.menu?.close?.(); window.EJS_emulator?.closePopup?.(); } catch { } });
  await sleep(300);
  await mob.evaluate(() => { window.__r4MobInputs = []; });
  if (startRect && startRect.w > 0) {
    await mob.touchscreen.tap(startRect.x + startRect.w / 2, startRect.y + startRect.h / 2);
    await sleep(900);
  }
  const mobTouchResult = await mob.evaluate(() => ({
    touch: window.EJS_emulator?.touch,
    inputs: (window.__r4MobInputs || []).slice(0, 10),
    inputCount: (window.__r4MobInputs || []).length,
    display: window.EJS_emulator?.virtualGamepad ? getComputedStyle(window.EJS_emulator.virtualGamepad).display : null,
    opacity: window.EJS_emulator?.virtualGamepad ? getComputedStyle(window.EJS_emulator.virtualGamepad).opacity : null,
    menuHidden: document.querySelector('#game .ejs_menu')?.classList.contains('ejs_menu_bar_hidden'),
    popup: Array.from(document.querySelectorAll('#game .ejs_popup_box')).map((e) => e.innerText.replace(/\s+/g, ' ').trim()).filter(Boolean),
  }));
  mobTouchResult.syntheticStart = syntheticStart;
  await shot(mob, '17-mobile-after-touch');
  // Hide the virtual pad for a moment so the canvas pixels are not the pad UI.
  await mob.evaluate(() => {
    const em = window.EJS_emulator;
    if (em?.virtualGamepad) em.virtualGamepad.style.visibility = 'hidden';
    const t = document.querySelector('#game .ejs_virtualGamepad_open');
    if (t) t.style.visibility = 'hidden';
    try { em?.closePopup?.(); em?.menu?.close?.(); } catch { }
  });
  const mobPure = [];
  for (let i = 0; i < 3; i++) {
    await sleep(3000);
    const c = await shotCanvas(mob, `18-mobile-game-${i + 1}`);
    mobPure.push(c ? { sha: c.sha256, stats: c.stats } : null);
  }
  await mob.evaluate(() => {
    const em = window.EJS_emulator;
    if (em?.virtualGamepad) em.virtualGamepad.style.visibility = '';
    const t = document.querySelector('#game .ejs_virtualGamepad_open');
    if (t) t.style.visibility = '';
  });
  const mobBest = mobPure.filter(Boolean).sort((a, b) => (b.stats?.nonBlackPct || 0) - (a.stats?.nonBlackPct || 0))[0] || null;
  const mobAfterTap = { ...mobTouchResult, startRect, pureCanvas: mobPure, bestPureCanvas: mobBest };
  results.mobile = {
    ok: bootMob.ok,
    gate: gateMob,
    state: mobInfo,
    layout: mobLayout,
    afterTap: mobAfterTap,
    pageErrors: recMob.pageErrors,
    consoleErrors: recMob.console.filter((l) => l.startsWith('[error]')),
    httpErrors: recMob.httpErrors,
    reqFailed: recMob.reqFailed,
  };
  await mob.close();

  // =====================================================================
  // 10. Landing page links to /play and both work
  // =====================================================================
  const land = await browser.newPage();
  const recLand = attach(land, 'landing');
  await land.setViewport({ width: 1280, height: 800 });
  const landResp = await land.goto(BASE + '/', { waitUntil: 'domcontentloaded', timeout: 60000 });
  await sleep(2000);
  const landInfo = await land.evaluate(() => {
    const a = document.querySelector('#playBrowserBtn');
    return {
      title: document.title,
      href: a?.getAttribute('href'),
      absolute: a?.href,
      text: a?.innerText?.replace(/\s+/g, ' ').trim(),
      visible: a ? (() => { const r = a.getBoundingClientRect(); const s = getComputedStyle(a); return r.width > 0 && r.height > 0 && s.display !== 'none' && s.visibility !== 'hidden'; })() : false,
    };
  });
  await shot(land, '19-landing');
  let navResult = null;
  if (landInfo.href) {
    const nav = await Promise.all([
      land.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 30000 }).catch((e) => ({ error: String(e) })),
      land.click('#playBrowserBtn'),
    ]);
    await sleep(2500);
    navResult = {
      url: land.url(),
      hasR4: await land.evaluate(() => !!window.__R4).catch(() => false),
      status: (await land.evaluate(() => document.querySelector('#bootStatus')?.textContent).catch(() => null)),
      navError: nav?.[0]?.error || null,
    };
    await shot(land, '20-landing-to-play');
  }
  results.landing = {
    status: landResp?.status(),
    ...landInfo,
    navResult,
    pageErrors: recLand.pageErrors,
    httpErrors: recLand.httpErrors,
    reqFailed: recLand.reqFailed,
  };
  await land.close();

  // Global console summary from the main page.
  results.console = {
    errors: results.firstLoad.consoleErrors,
    pageErrors: results.firstLoad.pageErrors,
    httpErrors: results.firstLoad.httpErrors,
    reqFailed: results.firstLoad.reqFailed,
    external: results.firstLoad.external,
  };

} catch (e) {
  results.fatal = String(e && e.stack ? e.stack : e);
  log('FATAL', results.fatal);
} finally {
  try { await browser?.close(); } catch { }
  fs.writeFileSync(path.join(OUT, 'play-qa-result.json'), JSON.stringify(results, null, 2));
  log('WROTE', path.join(OUT, 'play-qa-result.json'));
}
