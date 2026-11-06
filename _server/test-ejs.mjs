// Boot Ridge Racer Type 4 in a real browser via the /play page.
// Usage: node test-ejs.mjs [url]
// Expects the app server to already be running (see EJS-BOOT-REPORT.md).
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import puppeteer from 'puppeteer-core';

const BRAVE = 'C:/Program Files/BraveSoftware/Brave-Browser/Application/brave.exe';
const URL_ = process.argv[2] || 'http://127.0.0.1:8099/play';
const OUT = '../_runtime/ejs-play';
const BOOT_TIMEOUT_MS = Number(process.env.EJS_BOOT_TIMEOUT_MS || 240000);
fs.mkdirSync(OUT, { recursive: true });

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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const logLines = [];
const say = (...a) => { const s = a.join(' '); logLines.push(s); console.log(s); };

const browser = await puppeteer.launch({
  executablePath: BRAVE,
  headless: 'new',
  userDataDir: process.env.EJS_PROFILE || undefined,
  args: [
    '--no-sandbox',
    '--disable-dev-shm-usage',
    '--autoplay-policy=no-user-gesture-required',
    '--enable-unsafe-swiftshader',
    '--use-angle=swiftshader',
    '--window-size=1280,800',
    '--js-flags=--max-old-space-size=4096',
    '--disable-background-timer-throttling',
    '--disable-renderer-backgrounding',
    '--mute-audio',
  ],
  defaultViewport: { width: 1280, height: 800 },
});

const page = await browser.newPage();
const consoleLog = [];
const pageErrors = [];
const netFail = [];
const netErr = [];
const external = [];

page.on('console', (m) => {
  const line = `[${m.type()}] ${m.text()}`;
  consoleLog.push(line);
  if (/error|fail|EJS|bios|cue|core|wasm|ROM/i.test(m.text())) say('CONSOLE', line.slice(0, 400));
});
page.on('request', (r) => {
  const u = r.url();
  if (u.includes('/rom/') || u.includes('/bios/')) say('REQ', r.method(), decodeURIComponent(u).split('/').pop(), r.resourceType());
});
page.on('requestfinished', async (r) => {
  const u = r.url();
  if (u.includes('/rom/')) {
    try {
      const resp = await r.response();
      say('REQFIN', r.method(), decodeURIComponent(u).split('/').pop(), resp?.status(), 'len=' + (resp?.headers()['content-length'] || '?'));
    } catch { /* ignore */ }
  }
});
page.on('pageerror', (e) => { consoleLog.push('[pageerror] ' + e.message); pageErrors.push(e.message); say('PAGEERROR', e.message); });
page.on('requestfailed', (r) => {
  const rec = { url: r.url(), err: r.failure()?.errorText };
  netFail.push(rec);
  say('REQFAIL', rec.url.slice(0, 160), rec.err);
});
page.on('response', (r) => {
  const u = r.url();
  if (!u.startsWith('http://127.0.0.1:8099') && !u.startsWith('blob:') && !u.startsWith('data:')) external.push({ url: u.slice(0, 160), status: r.status() });
  if (r.status() >= 400) {
    netErr.push({ url: u, status: r.status() });
    say('HTTP', r.status(), u.slice(0, 180));
  }
});

const shots = [];
async function shot(name) {
  const file = path.join(OUT, `${name}.png`);
  await page.screenshot({ path: file });
  let stats = null;
  try { stats = pngStats(fs.readFileSync(file)); } catch (e) { stats = { error: e.message }; }
  shots.push({ name, file, stats });
  say('SHOT', name, JSON.stringify(stats));
  return stats;
}

const t0 = Date.now();
say('NAV', URL_);
await page.goto(URL_, { waitUntil: 'domcontentloaded', timeout: 30000 });
await shot('01-page');

let booted = false;
let lastState = null;
let fsState = null;
const deadline = Date.now() + BOOT_TIMEOUT_MS;
let lastShot = 0;
while (Date.now() < deadline) {
  lastState = await page.evaluate(() => {
    const s = window.__R4;
    if (!s) return { missing: true, body: document.body.innerText.slice(0, 400) };
    const c = document.querySelector('#game canvas');
    return {
      game: s.game, bios: s.bios, cue: s.cue, threads: s.threads,
      startedAt: s.startedAt, bootMs: s.bootMs, readyAt: s.readyAt,
      rom: s.rom ? { ms: s.rom.ms, mb: s.rom.mb, mbps: s.rom.mbps, loaded: s.rom.loaded, status: s.rom.status } : null,
      transfers: s.transfers || [],
      romResource: s.romResource || null,
      events: s.events.map((e) => e.name),
      errors: s.errors,
      canvas: c ? { w: c.width, h: c.height, cw: c.clientWidth, ch: c.clientHeight } : null,
      status: document.querySelector('#bootStatus')?.textContent,
      overlay: document.querySelector('#overlayText')?.textContent,
      startBtn: !!document.querySelector('#game .ejs_start_button'),
      loadingText: document.querySelector('#game .ejs_loading_text')?.innerText || null,
    };
  });
  // Click the EmulatorJS start button if it ever appears (safety net).
  if (lastState.startBtn) {
    await page.evaluate(() => document.querySelector('#game .ejs_start_button')?.click());
    say('CLICK start button');
  }
  if (Date.now() - lastShot > 15000) { lastShot = Date.now(); await shot(`02-progress-${Math.round((Date.now() - t0) / 1000)}s`); }
  if (lastState.startedAt) { booted = true; break; }
  await sleep(1000);
}

say('STATE', JSON.stringify(lastState));

if (booted) {
  await sleep(1500);
  await shot('03-started');

  // Sound gate: verify it appears, then dismiss it with a real click.
  const gate = await page.evaluate(() => {
    const g = document.querySelector('#soundGate');
    return { visible: !!g && !g.hidden, text: g?.innerText?.replace(/\s+/g, ' ').trim() || null };
  });
  say('GATE', JSON.stringify(gate));
  if (gate.visible) {
    await page.click('#soundGate');
    await sleep(700);
    const after = await page.evaluate(() => ({
      hidden: document.querySelector('#soundGate')?.hidden,
      audioUnlocked: !!window.__R4?.audioUnlocked,
      audioState: window.EJS_emulator?.Module?.SDL2?.audioContext?.state || null,
    }));
    say('GATE AFTER CLICK', JSON.stringify(after));
  }
  await shot('03b-after-gate');

  // Let the boot sequence play; capture several frames.
  for (const [wait, name] of [[4000, '04-boot-4s'], [6000, '05-boot-10s'], [8000, '06-boot-18s']]) {
    await sleep(wait);
    await shot(name);
  }
  // Press Start (Enter) to leave the intro / reach the menu.
  await page.keyboard.press('Enter');
  await sleep(3000);
  await shot('07-after-start');
  await sleep(5000);
  await shot('08-menu');
  // Down + X to sanity-check input reaches the core.
  await page.keyboard.press('ArrowDown');
  await sleep(600);
  await page.keyboard.press('Enter');
  await sleep(4000);
  await shot('09-after-confirm');

  // ---- fullscreen enter / exit ----
  await page.click('#fsBtn');
  await sleep(1500);
  const fsOn = await page.evaluate(() => ({
    fullscreen: !!document.fullscreenElement,
    bodyClass: document.body.className,
    exitVisible: !document.querySelector('#fsExit')?.hidden,
    game: (() => { const r = document.querySelector('#game').getBoundingClientRect(); return { w: Math.round(r.width), h: Math.round(r.height) }; })(),
    canvas: (() => { const c = document.querySelector('#game canvas'); return c ? { w: c.clientWidth, h: c.clientHeight } : null; })(),
    inner: { w: innerWidth, h: innerHeight },
  }));
  say('FULLSCREEN ON', JSON.stringify(fsOn));
  await shot('10-fullscreen');

  await page.click('#fsExit');
  await sleep(1200);
  const fsOff = await page.evaluate(() => ({
    fullscreen: !!document.fullscreenElement,
    bodyClass: document.body.className,
    exitVisible: !document.querySelector('#fsExit')?.hidden,
  }));
  say('FULLSCREEN OFF', JSON.stringify(fsOff));
  await shot('11-exit-fullscreen');
  fsState = { on: fsOn, off: fsOff };
} else {
  await shot('99-timeout');
}

const summary = {
  url: URL_,
  booted,
  elapsedMs: Date.now() - t0,
  state: lastState,
  fullscreen: fsState,
  shots,
  pageErrors,
  httpErrors: netErr,
  requestFailures: netFail,
  externalRequests: external,
  consoleTail: consoleLog.slice(-60),
};
fs.writeFileSync(path.join(OUT, 'result.json'), JSON.stringify(summary, null, 2));
fs.writeFileSync(path.join(OUT, 'console.log'), consoleLog.join('\n'));
say('SUMMARY', JSON.stringify({
  booted, elapsedMs: summary.elapsedMs,
  rom: lastState?.rom, bootMs: lastState?.bootMs,
  errors: lastState?.errors, httpErrors: netErr, external,
  shots: shots.map((s) => ({ name: s.name, ...s.stats })),
}));

await browser.close();
process.exit(booted ? 0 : 2);
