// Ridge Racer Type 4 — PSX RAM telemetry probe (single player TIME ATTACK).
//
// Boots /play?game=r4&threads=0 in headless Brave (same flags as perf-ejs.mjs),
// drives the real main menu into TIME ATTACK, races, samples the full 2 MiB PSX
// RAM at ~4 Hz and then finds timer / lap / speed / state candidates offline-in-
// page. A second race (after a console restart) repeats the sampling so every
// reported address has two agreeing runs.
//
// Usage:
//   node rr4-telemetry-probe.mjs            # full run (~3-4 min): race, restart, race, finish
//   node rr4-telemetry-probe.mjs --quick    # ~90 s: one race + restart, no finish run
//   node rr4-telemetry-probe.mjs --url "http://127.0.0.1:8080/play?game=r4&threads=0"
//
// Writes _runtime/rr4-telemetry-probe.json and prints the ranked candidate table.
// Read-only: it never edits app files and never restarts :8080 / :3010.
import puppeteer from 'puppeteer-core';
import fs from 'node:fs';
import path from 'node:path';

const BRAVE = process.env.BRAVE_PATH || 'C:/Program Files/BraveSoftware/Brave-Browser/Application/brave.exe';
const ROOT = '..';
const OUT_DIR = path.join(ROOT, '_runtime');
const SHOT_DIR = path.join(OUT_DIR, 'telemetry');
const PROFILE = path.join(process.env.TEMP || 'C:/Windows/Temp', 'rr4-telemetry-profile');
const BASE_URL = process.env.RR4_BASE || 'http://127.0.0.1:8080';
const URL_ = arg('url', `${BASE_URL}/play?game=r4&threads=0&cache=0`);
const QUICK = !!arg('quick', false);
const RACE_MS = Number(arg('race-ms', QUICK ? 30000 : 34000));
const RATE_HZ = Number(arg('hz', 4));
const AFTER_RESTART_MS = Number(arg('after-restart-ms', QUICK ? 30000 : 34000));
const FINISH_SECONDS = Number(arg('finish-seconds', 140));
const SKIP_FINISH = QUICK || !!arg('no-finish', false);

fs.mkdirSync(SHOT_DIR, { recursive: true });

function arg(name, def = null) {
  const i = process.argv.indexOf('--' + name);
  if (i === -1) return def;
  const v = process.argv[i + 1];
  return v && !v.startsWith('--') ? v : true;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log('[telemetry]', ...a);
const stageLog = [];
const stage = (name, extra = null) => {
  const rec = { stage: name, at: new Date().toISOString(), wallMs: Date.now() - startedAt, ...(extra || {}) };
  stageLog.push(rec);
  log(`${name}${extra ? '  ' + JSON.stringify(extra) : ''}`);
};
const startedAt = Date.now();

// ---------------------------------------------------------------------------
// Browser
// ---------------------------------------------------------------------------
const browser = await puppeteer.launch({
  executablePath: BRAVE,
  headless: 'new',
  userDataDir: PROFILE,
  protocolTimeout: 300000,
  args: [
    '--no-sandbox', '--mute-audio', '--autoplay-policy=no-user-gesture-required',
    '--enable-unsafe-swiftshader', '--use-angle=swiftshader',
    '--disable-background-timer-throttling', '--disable-backgrounding-occluded-windows',
    '--disable-renderer-backgrounding', '--window-size=1280,900', '--force-device-scale-factor=1',
    '--js-flags=--max-old-space-size=4096',
  ],
  defaultViewport: { width: 1280, height: 900 },
});

const page = await browser.newPage();
const pageErrors = [];
page.on('pageerror', (e) => pageErrors.push(String(e).slice(0, 300)));
page.on('console', (m) => { if (m.type() === 'error') pageErrors.push(m.text().slice(0, 300)); });
await page.setCacheEnabled(false);

const shots = [];
const shot = async (name) => {
  try {
    const clip = await page.evaluate(() => {
      const c = document.querySelector('#game canvas');
      if (!c) return null;
      const r = c.getBoundingClientRect();
      return { x: Math.max(0, r.x), y: Math.max(0, r.y), width: Math.max(1, r.width), height: Math.max(1, r.height) };
    });
    if (!clip) return null;
    const file = path.join(SHOT_DIR, `${name}.png`);
    await page.screenshot({ path: file, clip });
    shots.push(file);
    return file;
  } catch { return null; }
};

// ---------------------------------------------------------------------------
// In-page helpers: RAM base, pad, sampling, analysis
// ---------------------------------------------------------------------------
const INSTALL = () => {
  const em = window.EJS_emulator;
  const gm = em && em.gameManager;
  const M = gm && (gm.Module || em.Module);
  const H = M && M.HEAPU8;
  const T = { H, gm, base: null, ramStart: null, snaps: [], R4_MENU_SEL: 0x800AC801, R4_LABEL_TABLE: 0x800A2180 };
  window.__T = T;

  // The shipped /play page mounts a soundtrack gate over the canvas; click it
  // once so the page is in its normal state.
  try { document.querySelector('.rr4m-gate-skip')?.click(); } catch { /* ignore */ }
  try { window.EJS_emulator?.play?.(); } catch { /* ignore */ }

  // R4's main menu label table is the only reliable anchor from JS: the
  // WELCOME / DEMONSTRATION / GRAND PRIX / TIME ATTACK / VS BATTLE list sits at
  // 0x800A2180 with a 16-byte stride. The heap can hold stale copies (save-state
  // buffers), so find() returns every copy and the caller picks the live one by
  // watching 0x800AC801 answer a Down press.
  const pat = (s) => Array.from(s).map((c) => c.charCodeAt(0));
  const PAT = {
    welcome: pat('WELCOME'), demo: pat('DEMONSTRATION'), gp: pat('GRAND PRIX'),
    ta: pat('TIME ATTACK'), vs: pat('VS BATTLE'),
  };
  const eq = (at, p) => { if (at < 0 || at + p.length > H.length) return false; for (let j = 0; j < p.length; j++) if (H[at + j] !== p[j]) return false; return true; };
  T.find = () => {
    const hits = [];
    let p = 0;
    while (hits.length < 12) {
      const i = H.indexOf(PAT.ta[0], p);
      if (i < 0 || i > H.length - 64) break;
      p = i + 1;
      // 0x800A2180 + 3*16 = TIME ATTACK; neighbours pin the real table.
      if (!eq(i, PAT.ta) || !eq(i - 16, PAT.gp) || !eq(i + 16, PAT.vs) || !eq(i - 48, PAT.welcome) || !eq(i - 32, PAT.demo)) continue;
      hits.push(i - 48);
    }
    return hits;
  };
  T.setBase = (b) => { T.base = b; T.ramStart = b - (T.R4_LABEL_TABLE - 0x80000000); };
  T.at = (addr) => T.ramStart + (addr - 0x80000000);
  T.u8 = (a) => H[T.at(a)];
  T.u16 = (a) => H[T.at(a)] | (H[T.at(a) + 1] << 8);
  T.u32 = (a) => (H[T.at(a)] | (H[T.at(a) + 1] << 8) | (H[T.at(a) + 2] << 16) | (H[T.at(a) + 3] << 24)) >>> 0;
  T.str = (a, n) => { let s = ''; for (let k = 0; k < n; k++) { const b = H[T.at(a) + k]; s += b >= 32 && b < 127 ? String.fromCharCode(b) : ' '; } return s; };
  T.menuSel = () => (T.base == null ? null : T.u8(T.R4_MENU_SEL));
  T.pad = (pl, i, v) => gm.functions.simulateInput(pl, i, v);
  T.tap = async (pl, i, hold = 280, settle = 500) => {
    T.pad(pl, i, 1); await new Promise((r) => setTimeout(r, hold));
    T.pad(pl, i, 0); await new Promise((r) => setTimeout(r, settle));
  };
  T.frame = () => gm.getFrameNum();

  // --- sampling ---------------------------------------------------------
  T.sampleReset = () => { T.snaps = []; };
  T.snap = () => {
    const s = new Uint8Array(0x200000);
    s.set(H.subarray(T.ramStart, T.ramStart + 0x200000));
    T.snaps.push({ b: s, t: performance.now(), f: gm.getFrameNum(), thr: T.throttle ? 1 : 0 });
  };
  // Sample at `hz` for `ms` with a fixed throttle script. Sampling starts on the
  // TIME ATTACK mode card (before the track loads), so the moment the race timer
  // starts is inside the window — that is also the evidence that the timer is
  // guarded by the race state.
  //   t < 18 s   throttle on   (grid -> GO -> accelerating)
  //   18-22 s    coast         (speed decays)
  //   22-26 s    throttle on
  //   26-30 s    coast
  //   > 30 s     throttle on
  T.sampleRace = async (ms, hz) => {
    const t0 = performance.now();
    const period = 1000 / hz;
    const marks = [];
    const schedule = (el) => (el < 18000 ? 1 : el < 22000 ? 0 : el < 26000 ? 1 : el < 30000 ? 0 : 1);
    T.throttle = 0;
    T.snap();
    while (performance.now() - t0 < ms) {
      const el = performance.now() - t0;
      // Hold Cross only once the race clock is live. Pressing it earlier cancels
      // the TIME ATTACK mode card (the card is a menu: Cross = cancel).
      const clock = T.u32(0x800F4E2F);
      const racing = (clock !== 0xFFFFFFFF && clock > 0) || el > 15000;
      T.throttle = racing ? schedule(el) : 0;
      T.pad(0, 0, T.throttle);
      if (racing && Math.floor(el / 3000) !== Math.floor((el - period) / 3000)) {
        T.pad(0, Math.floor(el / 3000) % 2 ? 7 : 6, 1);
        setTimeout(() => { try { T.pad(0, 7, 0); T.pad(0, 6, 0); } catch { /* ignore */ } }, 220);
      }
      marks.push({ el: Math.round(el), throttle: T.throttle, clock, racing });
      T.snap();
      const next = t0 + (Math.floor(el / period) + 1) * period;
      await new Promise((r) => setTimeout(r, Math.max(0, next - performance.now())));
    }
    T.pad(0, 0, 0);
    T.throttle = 0;
    return { marks, snaps: T.snaps.length };
  };

  // --- analysis ---------------------------------------------------------
  // Streaming candidate finder over the collected snapshots.
  // Every 1/2/3/4-byte aligned offset is decoded as u8/u16le/u32le/f32le (and
  // BCD for u16/u32); a value is kept when it is monotonic or has a stable
  // increment or is highly volatile (speed-like).
  T.analyze = () => {
    const snaps = T.snaps;
    const n = snaps.length;
    const N = 0x200000;
    if (n < 4) return { error: 'not-enough-snapshots', n };
    const chg = new Uint16Array(N);
    for (let k = 1; k < n; k++) {
      const a = snaps[k - 1].b, b = snaps[k].b;
      for (let i = 0; i < N; i++) if (a[i] !== b[i]) chg[i]++;
    }
    const need = Math.max(3, Math.floor((n - 1) * 0.15));
    const hot = [];
    for (let i = 0; i < N; i++) if (chg[i] >= need) hot.push(i);
    const hotSet = new Set();
    for (const o of hot) for (let d = -4; d <= 4; d++) if (o + d >= 0 && o + d < N) hotSet.add(o + d);
    const offsets = Array.from(hotSet).sort((a, b) => a - b);
    const series = (off, width, enc) => {
      const out = new Array(n);
      for (let k = 0; k < n; k++) {
        const b = snaps[k].b;
        let v;
        if (enc === 'u8') v = b[off];
        else if (enc === 'u16le') v = b[off] | (b[off + 1] << 8);
        else if (enc === 'u16be') v = (b[off] << 8) | b[off + 1];
        else if (enc === 'u32le') v = (b[off] | (b[off + 1] << 8) | (b[off + 2] << 16) | (b[off + 3] << 24)) >>> 0;
        else if (enc === 'i32le') v = (b[off] | (b[off + 1] << 8) | (b[off + 2] << 16) | (b[off + 3] << 24)) | 0;
        else if (enc === 'f32le') {
          const u = (b[off] | (b[off + 1] << 8) | (b[off + 2] << 16) | (b[off + 3] << 24)) >>> 0;
          v = new Float32Array(new Uint32Array([u]).buffer)[0];
        } else return null;
        out[k] = v;
      }
      return out;
    };
    const isBcd = (arr, bytes) => {
      for (const v of arr) {
        let x = v;
        for (let j = 0; j < bytes * 2; j++) { if ((x & 0xF) > 9) return false; x >>= 4; }
      }
      return true;
    };
    const bcdValue = (arr) => arr.map((v) => {
      let x = v, mul = 1, out = 0;
      while (x > 0) { out += (x & 0xF) * mul; mul *= 10; x >>= 4; }
      return out;
    });
    const stats = (vals, frames, times, thr) => {
      // The race timer starts mid-window (grid -> GO), so score the longest
      // monotonic non-decreasing suffix instead of the whole series.
      let s = vals.length - 1;
      while (s > 0 && vals[s] >= vals[s - 1]) s--;
      const tail = vals.slice(s);
      const tailFrames = frames.slice(s);
      const tailThr = thr.slice(s);
      const min = Math.min(...vals), max = Math.max(...vals);
      const distinct = new Set(vals).size;
      const deltas = [];
      for (let k = 1; k < tail.length; k++) deltas.push(tail[k] - tail[k - 1]);
      const dframes = [];
      for (let k = 1; k < tailFrames.length; k++) dframes.push(Math.max(0, tailFrames[k] - tailFrames[k - 1]));
      const med = (arr) => { const a = arr.slice().sort((x, y) => x - y); return a.length ? a[Math.floor(a.length / 2)] : 0; };
      const medDf = med(dframes);
      const nz = deltas.filter((d) => d !== 0);
      const medDelta = med(nz);
      const modeShare = nz.length ? nz.filter((d) => d === medDelta).length / nz.length : 0;
      const perFrame = medDf ? medDelta / medDf : 0;
      const tailSpanFrames = tailFrames.length > 1 ? tailFrames[tailFrames.length - 1] - tailFrames[0] : 0;
      const tailSpanFramesAll = (frames[frames.length - 1] - frames[s]) || 1;
      const spanRate = (tail[tail.length - 1] - tail[0]) / (tailSpanFramesAll / 60);
      let corr = null;
      if (tailThr && tailThr.length === tail.length && tail.length > 4) {
        const n = tail.length;
        const mv = tail.reduce((a, b) => a + b, 0) / n;
        const mt = tailThr.reduce((a, b) => a + b, 0) / n;
        let cov = 0, vv = 0, tt = 0;
        for (let k = 0; k < n; k++) { const dv = tail[k] - mv, dt = tailThr[k] - mt; cov += dv * dt; vv += dv * dv; tt += dt * dt; }
        corr = vv > 0 && tt > 0 ? +(cov / Math.sqrt(vv * tt)).toFixed(2) : null;
      }
      return {
        min, max, distinct,
        suffixStart: s,
        suffixLen: tail.length,
        tailFirst: tail[0], tailLast: tail[tail.length - 1],
        monoFrac: 1,
        medianDelta: medDelta, modeShare: +modeShare.toFixed(2),
        ratePerEmuSec: +(perFrame * 60).toFixed(2),
        spanRatePerEmuSec: +spanRate.toFixed(2),
        corrThrottle: corr,
        first: vals[0], last: vals[vals.length - 1],
        resets: s > 0 ? 1 : 0,
        values: vals,
      };
    };
    const rangeOf = (arr) => {
      const step = [];
      for (let k = 1; k < arr.length; k++) step.push(arr[k] - arr[k - 1]);
      return step;
    };

    const frames = snaps.map((s) => s.f);
    const times = snaps.map((s) => s.t);
    const thr = snaps.map((s) => (s.thr ? 1 : 0));
    const out = [];
    const seen = new Set();
    const push = (off, width, enc, vals, bcd) => {
      if (!vals) return;
      const id = `${off}:${width}:${enc}`;
      if (seen.has(id)) return;
      seen.add(id);
      const st = stats(vals, frames, times, thr);
      const addr = 0x80000000 + off;
      const r = +st.ratePerEmuSec;
      const plausibleCounter = Number.isFinite(r) && Math.abs(r) >= 0.2 && Math.abs(r) <= 5000;
      const keep = (
        (st.suffixLen >= 6 && st.tailLast > st.tailFirst && st.distinct >= 6 && plausibleCounter)
        || (st.modeShare >= 0.5 && st.distinct >= 6 && plausibleCounter)
        || (st.distinct >= 24 && Math.abs(st.corrThrottle || 0) >= 0.35)
      );
      if (!keep) return;
      out.push({ addr, width, enc, bcd: !!bcd, ...st, values: bcd ? bcdValue(vals) : vals });
    };
    for (const off of offsets) {
      if (off + 4 > N) continue;
      push(off, 1, 'u8', series(off, 1, 'u8'));
      // NOTE: R4 keeps 32-bit fields at odd addresses (the race clock is at
      // 0x800F4E2F), so u16/u32 must be decoded at EVERY offset, not just
      // naturally aligned ones.
      const u16 = series(off, 2, 'u16le');
      push(off, 2, 'u16le', u16);
      if (out.length < 6000 && isBcd(u16, 2)) push(off, 2, 'u16le-bcd', u16, true);
      const u32 = series(off, 4, 'u32le');
      push(off, 4, 'u32le', u32);
      if (out.length < 6000 && isBcd(u32, 4)) push(off, 4, 'u32le-bcd', u32, true);
      push(off, 4, 'f32le', series(off, 4, 'f32le'));
      if (out.length > 6000) break;
    }
    return { n, hotOffsets: hot.length, offsets: offsets.length, total: out.length, frames, times, cands: out };
  };

  // Direct readout of the fields verified in _runtime/analysis/14-ram-telemetry.md
  // so every run states their rate/min/max even if a heuristic misses them.
  T.knownFields = () => {
    const fields = [
      { name: 'raceClockMs', addr: 0x800F4E2F, width: 4, enc: 'u32le' },
      { name: 'raceClockMsMirror', addr: 0x8010C24F, width: 4, enc: 'u32le' },
      { name: 'speedFixed', addr: 0x800AC0EE, width: 2, enc: 'u16le' },
      { name: 'speedByte', addr: 0x800AC0EF, width: 1, enc: 'u8' },
      { name: 'speedSlot', addr: 0x800AC180, width: 1, enc: 'u8' },
      { name: 'menuSel', addr: 0x800AC801, width: 1, enc: 'u8' },
    ];
    const snaps = T.snaps;
    const frames = snaps.map((s) => s.f);
    const out = [];
    for (const f of fields) {
      const off = f.addr - 0x80000000;
      const vals = snaps.map((s) => (f.width === 1 ? s.b[off] : f.width === 2 ? (s.b[off] | (s.b[off + 1] << 8)) : ((s.b[off] | (s.b[off + 1] << 8) | (s.b[off + 2] << 16) | (s.b[off + 3] << 24)) >>> 0)));
      // The clock (and the mirrored status block) reads 0xFFFFFFFF / 0 outside a
      // race, so summarise the tail of the window where the race is live.
      const tail = vals.slice(Math.floor(vals.length * 0.5));
      const first = tail[0], last = tail[tail.length - 1];
      const framesTail = frames.slice(Math.floor(frames.length * 0.5));
      const df = (framesTail[framesTail.length - 1] - framesTail[0]) || 1;
      const sentinel = vals.filter((v) => v === 0xFFFFFFFF || v === 0xFFFFFF).length;
      out.push({
        name: f.name, addr: f.addr, width: f.width, enc: f.enc,
        first, last, min: Math.min(...vals), max: Math.max(...vals),
        distinct: new Set(vals).size,
        sentinel,
        ratePerEmuSec: +(((last - first) / (df / 60)) || 0).toFixed(2),
        values: vals,
      });
    }
    return out;
  };

  // Stepwise small-integer fields (lap counter, race phase). A lap byte changes
  // only 2-3 times in a 3-lap run, far below the "hot offset" threshold, so it
  // gets its own pass over the finish snapshots.
  T.findStepwise = () => {
    const snaps = T.snaps;
    const n = snaps.length;
    if (n < 8) return [];
    const N = 0x200000;
    const out = [];
    for (let off = 0; off < N - 4; off++) {
      const b = snaps[0].b[off];
      if (b > 8) continue;
      let changes = 0;
      let max = b;
      let min = b;
      const seen = new Set([b]);
      for (let k = 1; k < n; k++) {
        const v = snaps[k].b[off];
        if (v !== snaps[k - 1].b[off]) changes++;
        if (v > max) max = v;
        if (v < min) min = v;
        seen.add(v);
        if (seen.size > 6) break;
      }
      if (seen.size < 2 || seen.size > 6) continue;
      if (max > 8 || changes > 12 || changes < 1) continue;
      out.push({ addr: 0x80000000 + off, width: 1, distinct: seen.size, changes, min, max, values: seen.size <= 6 ? snaps.map((s) => s.b[off]) : null });
      if (out.length > 200) break;
    }
    return out;
  };

  // Sample just the given addresses (used to track known fields through the
  // finish) without keeping 2 MiB snapshots.
  T.track = (addrs, ms, hz) => new Promise((resolve) => {
    const t0 = performance.now();
    const rows = [];
    const tick = () => {
      const row = { t: Math.round(performance.now() - t0), f: gm.getFrameNum(), v: [] };
      for (const a of addrs) row.v.push(T.u32(a.addr) & (a.width === 4 ? 0xFFFFFFFF : (a.width === 2 ? 0xFFFF : 0xFF)));
      rows.push(row);
      if (performance.now() - t0 > ms) { resolve(rows); return; }
      setTimeout(tick, 1000 / hz);
    };
    tick();
  });

  T.base = null;
};

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------
try {
  stage('goto', { url: URL_, quick: QUICK });
  await page.goto(URL_, { waitUntil: 'domcontentloaded', timeout: 60000 });

  const t0 = Date.now();
  let booted = false;
  for (let i = 0; i < 600; i++) {
    const s = await page.evaluate(() => {
      const b = document.querySelector('#game .ejs_start_button');
      if (b) b.click();
      const g = document.querySelector('.rr4m-gate-skip');
      if (g) g.click();
      return !!(window.__R4 && window.__R4.startedAt && window.EJS_emulator && window.EJS_emulator.gameManager);
    });
    if (s) { booted = true; break; }
    await sleep(500);
  }
  if (!booted) throw new Error('core did not boot in 300 s');
  stage('boot', { seconds: Math.round((Date.now() - t0) / 1000) });
  await page.evaluate(INSTALL);
  await sleep(600);

  // -------------------------------------------------------------------------
  // Find the live PSX RAM base (candidate label tables answered by the menu)
  // -------------------------------------------------------------------------
  const findLiveBase = async () => {
    const cands = [];
    for (let i = 0; i < 40; i++) {
      const found = await page.evaluate(() => window.__T.find());
      for (const c of found) if (!cands.includes(c)) cands.push(c);
      for (const c of cands) {
        await page.evaluate((b) => window.__T.setBase(b), c);
        const sel = await page.evaluate(() => window.__T.menuSel());
        if (sel == null || sel > 10) continue;
        await page.evaluate(() => window.__T.tap(0, 5, 300, 380));      // Down
        const next = await page.evaluate(() => window.__T.menuSel());
        await page.evaluate(() => window.__T.tap(0, 4, 300, 300));      // Up
        if (next === sel + 1) return { base: c, cands, sel };
      }
      await page.evaluate(() => window.__T.tap(0, 3, 300, 1500));       // Start
    }
    return { base: null, cands };
  };

  const b1 = await findLiveBase();
  stage('ram-base', { base: b1.base, candidates: b1.cands });
  if (b1.base == null) throw new Error(`no live PSX RAM base (candidates ${JSON.stringify(b1.cands)})`);
  await shot('01-main-menu');

  // -------------------------------------------------------------------------
  // Menu -> TIME ATTACK -> course -> car -> AT/MT -> mode card -> race
  // -------------------------------------------------------------------------
  const tap = (i, hold = 300, settle = 700) => page.evaluate((ii, h, s) => window.__T.tap(0, ii, h, s), i, hold, settle);
  const sel = () => page.evaluate(() => window.__T.menuSel());

  const driveToRace = async ({ car = 0, course = 0 } = {}) => {
    // main menu: 0 GP, 1 TIME ATTACK, 2 VS BATTLE
    for (let i = 0; i < 10; i++) {
      if ((await sel()) === 1) break;
      await tap(5, 300, 420);
    }
    if ((await sel()) !== 1) throw new Error('could not select TIME ATTACK');
    await tap(8, 350, 1600);            // enter TIME ATTACK (splash)
    await sleep(10500);
    await shot('02-course-select');
    // Course Select: Right x course, Circle = O.K.
    for (let i = 0; i < course; i++) await tap(7, 300, 700);
    await tap(8, 350, 3000);            // O.K. -> Car Select Preset
    await shot('03-car-select');
    // Car Select: Right x car, Circle -> AT/MT, Circle -> AT, Circle -> mode card
    for (let i = 0; i < car; i++) await tap(7, 300, 700);
    await tap(8, 350, 2500);            // Start row -> AT/MT
    await tap(8, 350, 2500);            // AT
    await tap(8, 350, 1200);            // mode card (auto-advances into the track load)
  };

  const findLiveBaseAgain = async () => {
    for (let i = 0; i < 40; i++) {
      const found = await page.evaluate(() => window.__T.find());
      for (const c of found) {
        await page.evaluate((b) => window.__T.setBase(b), c);
        const v = await page.evaluate(() => ({ sel: window.__T.menuSel(), frame: window.__T.frame() }));
        if (v.sel != null && v.sel <= 10) return c;
      }
      await sleep(600);
    }
    return null;
  };

  stage('race1:drive');
  await driveToRace({ car: 0, course: 0 });
  await shot('04-race1-start');
  stage('race1:sample', { ms: RACE_MS, hz: RATE_HZ });
  const s1 = await page.evaluate((ms, hz) => window.__T.sampleRace(ms, hz), RACE_MS, RATE_HZ);
  const a1 = await page.evaluate(() => window.__T.analyze());
  const k1 = await page.evaluate(() => window.__T.knownFields());
  stage('race1:analyze', { snaps: s1.snaps, hot: a1.hotOffsets, cands: a1.total });
  await shot('05-race1-end');
  const race1Summary = await page.evaluate(() => ({
    menuSel: window.__T.menuSel(),
    str0: window.__T.str(0x800A2180, 16),
    frame: window.__T.frame(),
  }));

  // -------------------------------------------------------------------------
  // Finish run on the same race: fast-forward + pinned throttle, 1 Hz snapshots.
  // The timer / state bytes found in race 1 are tracked every 250 ms as well, so
  // the "finished" transition is visible even if the sample rate is coarse.
  // -------------------------------------------------------------------------
  let finish = null;
  if (!SKIP_FINISH) {
    const watch = pickWatchFields(a1);
    stage('finish:run', { seconds: FINISH_SECONDS, watch: watch.map((w) => `${w.addr.toString(16)}/${w.width}`) });
    await page.evaluate((ms) => {
      window.__T.snaps = [];
      try { window.EJS_emulator.gameManager.functions.toggleFastForward(1); } catch { /* ignore */ }
      try { window.EJS_emulator.isFastForward = true; } catch { /* ignore */ }
      window.__T.pad(0, 0, 1);
      const t0 = performance.now();
      let frozenTicks = 0;
      let lastClock = -1;
      let sawRacing = false;
      window.__T.__finishState = { finished: false, frozenAt: null };
      window.__T.__finishLoop = new Promise((resolve) => {
        const tick = () => {
          const el = performance.now() - t0;
          const clock = window.__T.u32(0x800F4E2F);
          const racing = (clock !== 0xFFFFFFFF && clock > 0) || el > 15000;
          if (racing) {
            sawRacing = true;
            window.__T.pad(0, 0, 1);
            if (Math.floor(el / 3000) !== Math.floor((el - 1000) / 3000)) {
              const dir = Math.floor(el / 3000) % 2 ? 7 : 6;
              try { window.__T.pad(0, dir, 1); setTimeout(() => { try { window.__T.pad(0, dir, 0); } catch { /* ignore */ } }, 320); } catch { /* ignore */ }
            }
          } else {
            window.__T.pad(0, 0, 0);
          }
          if (sawRacing && clock === lastClock && el > 30000) frozenTicks++; else frozenTicks = 0;
          lastClock = clock;
          window.__T.snap();
          // The race clock stops / is invalidated (0xFFFFFFFF) at the results
          // screen: stop early so the transition is captured.
          if (frozenTicks === 5) {
            window.__T.__finishState = { finished: true, frozenAt: el, clock };
            window.__T.pad(0, 0, 0);
            resolve(true);
            return;
          }
          if (el > ms * 1000) { window.__T.pad(0, 0, 0); resolve(true); return; }
          setTimeout(tick, 1000);
        };
        tick();
      });
    }, FINISH_SECONDS);
    const trackP = page.evaluate((w, ms) => window.__T.track(w, ms, 4), watch, FINISH_SECONDS * 1000);
    const finishShots = [];
    for (let i = 0; i < FINISH_SECONDS; i += 5) {
      await sleep(5000);
      const f = await shot(`08-finish-${String(i).padStart(3, '0')}`);
      if (f) finishShots.push(f);
      const st = await page.evaluate(() => window.__T.__finishState || null);
      if (st && st.finished) { stage('finish:detected', st); break; }
    }
    await page.evaluate(() => window.__T.__finishLoop);
    const finishState = await page.evaluate(() => window.__T.__finishState || null);
    if (finishState && finishState.finished) {
      await sleep(1500);
      const f = await shot('08-finish-detected');
      if (f) finishShots.push(f);
    } else {
      // No finish inside the budget: try the in-game pause menu (Start, then
      // DOWN x2 -> RETIRE, then Circle/Cross) and record whether the clock stops.
      const before = await page.evaluate(() => window.__T.u32(0x800F4E2F));
      await page.evaluate(() => window.__T.pad(0, 0, 0));
      await page.evaluate(() => window.__T.tap(0, 3, 350, 1600));
      await shot('08-pause');
      await page.evaluate(() => window.__T.tap(0, 5, 350, 700));
      await page.evaluate(() => window.__T.tap(0, 5, 350, 700));
      await shot('08-pause-retire');
      for (const btn of [8, 0, 3]) {
        await page.evaluate((b) => window.__T.tap(0, b, 900, 2000), btn);
        const after = await page.evaluate(() => window.__T.u32(0x800F4E2F));
        stage('finish:retire-try', { button: btn, before, after, changed: after !== before });
        await shot(`08-retire-${btn}`);
        if (after === before) break;
      }
      await sleep(2500);
      const tail = await page.evaluate(() => window.__T.u32(0x800F4E2F));
      stage('finish:post-retire', { clock: tail, stopped: tail === before });
      await shot('08-post-retire');
      finishShots.push(...[]);
    }
    const track = await trackP;
    const af = await page.evaluate(() => window.__T.analyze());
    const stepwise = await page.evaluate(() => window.__T.findStepwise());
    finish = { shots: finishShots, analyze: af, track, watch, stepwise, finishState };
    stage('finish:analyze', { snaps: af.n, hot: af.hotOffsets, cands: af.total, stepwise: stepwise.length });
    stage('finish:stepwise', { top: stepwise.slice(0, 8).map((s) => `${s.addr.toString(16)} d=${s.distinct} ch=${s.changes} ${s.min}..${s.max}`) });
    await shot('09-finish-end');
    await page.evaluate(() => { try { window.EJS_emulator.gameManager.functions.toggleFastForward(0); } catch { /* ignore */ } });
  }

  // free the snapshots before the restart
  await page.evaluate(() => { window.__T.snaps = []; });

  // -------------------------------------------------------------------------
  // Console restart -> second race with a different course + car
  // -------------------------------------------------------------------------
  stage('restart');
  await page.evaluate(() => { try { window.EJS_emulator.gameManager.functions.restart(); } catch { /* ignore */ } });
  await sleep(3000);
  // The restarted core may show EJS's own start button again.
  for (let i = 0; i < 120; i++) {
    const ok = await page.evaluate(() => {
      const b = document.querySelector('#game .ejs_start_button');
      if (b) b.click();
      return !!(window.__R4 && window.__R4.startedAt) && window.EJS_emulator?.gameManager?.getFrameNum?.() > 30;
    });
    if (ok) break;
    await sleep(500);
  }
  await page.evaluate(INSTALL);
  stage('ram-base-2', { candidate: await page.evaluate(() => window.__T.find()) });
  const b2 = await findLiveBase();
  if (b2.base == null) throw new Error('no live PSX RAM base after restart');
  const base2 = b2.base;
  await page.evaluate((b) => window.__T.setBase(b), base2);
  stage('ram-base-2:live', { base: base2 });
  stage('race2:drive');
  await driveToRace({ car: 3, course: 2 });
  await shot('06-race2-start');
  stage('race2:sample', { ms: AFTER_RESTART_MS, hz: RATE_HZ });
  const s2 = await page.evaluate((ms, hz) => window.__T.sampleRace(ms, hz), AFTER_RESTART_MS, RATE_HZ);
  const a2 = await page.evaluate(() => window.__T.analyze());
  const k2 = await page.evaluate(() => window.__T.knownFields());
  stage('race2:analyze', { snaps: s2.snaps, hot: a2.hotOffsets, cands: a2.total });
  await shot('07-race2-end');
  const race2Summary = await page.evaluate(() => ({
    menuSel: window.__T.menuSel(),
    frame: window.__T.frame(),
  }));
  await page.evaluate(() => { window.__T.snaps = []; });

  // -------------------------------------------------------------------------
  // Ranking (Node side)
  // -------------------------------------------------------------------------
  const report = rankAndReport([{ label: 'race1', a: a1 }, { label: 'race2', a: a2 }], finish, { k1, k2 });
  console.log(report.text);

  const artifact = {
    at: new Date().toISOString(),
    url: URL_,
    command: process.argv.join(' '),
    quick: QUICK,
    stages: stageLog,
    ramBase: b1.base,
    ramBaseRestart: base2,
    race1: { params: { ms: RACE_MS, hz: RATE_HZ, car: 0, course: 0 }, summary: race1Summary, frames: a1.frames, times: a1.times, hotOffsets: a1.hotOffsets, total: a1.total },
    race2: { params: { ms: AFTER_RESTART_MS, hz: RATE_HZ, car: 3, course: 2 }, summary: race2Summary, frames: a2.frames, times: a2.times, hotOffsets: a2.hotOffsets, total: a2.total },
    ranking: report.ranking,
    confirmed: report.confirmed,
    known: report.known,
    finish: finish ? {
      shots: finish.shots,
      watch: finish.watch.map((w) => ({ addr: w.addr, width: w.width, enc: w.enc, min: w.min, max: w.max })),
      frames: finish.analyze.frames,
      hotOffsets: finish.analyze.hotOffsets,
      total: finish.analyze.total,
      track: finish.track,
      stepwise: finish.stepwise ? finish.stepwise.slice(0, 60) : [],
      finishState: finish.finishState,
      finishReport: report.finishReport,
    } : null,
    shots,
    pageErrors: pageErrors.slice(0, 20),
  };
  fs.writeFileSync(path.join(OUT_DIR, 'rr4-telemetry-probe.json'), JSON.stringify(artifact, null, 2));
  log(`wrote ${path.join(OUT_DIR, 'rr4-telemetry-probe.json')}`);
} catch (e) {
  stage('error', { message: e.message });
  console.error(e);
  fs.writeFileSync(path.join(OUT_DIR, 'rr4-telemetry-probe.json'), JSON.stringify({
    at: new Date().toISOString(), url: URL_, error: e.stack || e.message, stages: stageLog, shots, pageErrors,
  }, null, 2));
  process.exitCode = 1;
} finally {
  try { await browser.close(); } catch { /* ignore */ }
}

// ---------------------------------------------------------------------------
// Ranking
// ---------------------------------------------------------------------------
// The fields worth tracking through the finish: the fastest monotonic ~100/s
// counter (timer), the small stepwise integer (lap), and low-cardinality state
// bytes. They come from the race-1 candidate list.
function pickWatchFields(a1) {
  const cands = a1.cands || [];
  const mono = (c) => c.suffixLen >= 8 && c.tailLast > c.tailFirst;
  const timer = cands
    .filter((c) => mono(c) && c.ratePerEmuSec != null && c.ratePerEmuSec > 50 && c.distinct >= 8)
    .sort((a, b) => Math.abs(a.ratePerEmuSec - 100) - Math.abs(b.ratePerEmuSec - 100))
    .slice(0, 3);
  const lap = cands
    .filter((c) => c.width === 1 && c.min >= 0 && c.max <= 5 && c.distinct >= 2 && c.distinct <= 5)
    .slice(0, 3);
  const state = cands
    .filter((c) => c.width === 1 && c.distinct >= 2 && c.distinct <= 6 && c.max <= 20)
    .slice(0, 6);
  void timer; void lap; void state;
  // Known-good fields first (see _runtime/analysis/14-ram-telemetry.md), then the
  // generic candidates from this run's own scan.
  const known = [
    { addr: 0x800F4E2F, width: 4, enc: 'u32le', min: 0, max: 1e9 },   // race clock, ms
    { addr: 0x8010C24F, width: 4, enc: 'u32le', min: 0, max: 1e9 },   // same clock, mirrored
    { addr: 0x800AC0EE, width: 2, enc: 'u16le', min: 0, max: 1e4 },   // speed (8.8-ish)
    { addr: 0x800AC0EF, width: 1, enc: 'u8', min: 0, max: 255 },      // speed high byte
    { addr: 0x8010C180, width: 1, enc: 'u8', min: 0, max: 255 },      // mirrored speed-ish
  ];
  const out = [...known];
  for (const c of [...timer, ...lap, ...state]) {
    if (out.some((w) => w.addr === c.addr && w.width === c.width)) continue;
    out.push({ addr: c.addr, width: c.width, enc: c.enc, min: c.min, max: c.max });
    if (out.length >= 14) break;
  }
  return out;
}

// Did the run actually finish? A finished race shows the timer frozen while the
// frame counter keeps advancing and (usually) a state byte stepping.
function analyzeFinish(finish) {
  if (!finish || !finish.track || !finish.track.length) return null;
  const rows = finish.track;
  const watch = finish.watch;
  const fields = watch.map((w, i) => {
    const vals = rows.map((r) => r.v[i]);
    const first = vals[0], last = vals[vals.length - 1];
    const changes = vals.filter((v, k) => k > 0 && v !== vals[k - 1]).length;
    // The last index where the value changed; everything after is frozen.
    let lastChange = -1;
    for (let k = 1; k < vals.length; k++) if (vals[k] !== vals[k - 1]) lastChange = k;
    return {
      addr: w.addr, width: w.width, enc: w.enc,
      first, last, min: Math.min(...vals), max: Math.max(...vals), changes,
      finalValue: last,
      frozenFromMs: lastChange >= 0 ? rows[Math.min(rows.length - 1, lastChange + 1)].t : rows[0].t,
      distinctTail: new Set(vals.slice(Math.max(0, lastChange))).size,
    };
  });
  const frames = rows.map((r) => r.f);
  const frameSpan = frames[frames.length - 1] - frames[0];
  const wallSpan = rows[rows.length - 1].t - rows[0].t;
  return {
    samples: rows.length,
    wallMs: wallSpan,
    emuFrames: frameSpan,
    emuSeconds: +(frameSpan / 60).toFixed(1),
    fields,
    frozenEmuSeconds: fields.map((f) => ({
      addr: f.addr,
      frozenFromMs: f.frozenFromMs,
      frozenEmuSeconds: +(((rows[rows.length - 1].f - (rows.find((r) => r.t >= f.frozenFromMs) || rows[rows.length - 1]).f)) / 60).toFixed(1),
    })),
  };
}

function rankAndReport(runs, finish, known) {
  const [r1, r2] = runs;
  const key = (c) => `${c.addr}:${c.width}:${c.enc}`;
  const map2 = new Map(r2.a.cands.map((c) => [key(c), c]));

  const scored = r1.a.cands.map((c) => {
    const twin = map2.get(key(c));
    const bothRuns = !!twin;
    const rate = c.ratePerEmuSec;
    const near = (target) => rate != null && Math.abs(rate - target) / target < 0.12;
    let score = 0;
    const notes = [];
    const monotonicTail = c.suffixLen >= 8 && c.tailLast > c.tailFirst && c.distinct >= 8;
    if (monotonicTail) { score += 3; notes.push('monotonic-tail'); }
    if (c.suffixStart > 0 && monotonicTail) { score += 2; notes.push('starts mid-window'); }
    if (c.modeShare > 0.6 && c.distinct >= 8) { score += 2; notes.push('stable-increment'); }
    if (near(60)) { score += 4; notes.push('~60/s (frames)'); }
    if (near(100)) { score += 4; notes.push('~100/s (centiseconds)'); }
    if (near(1000)) { score += 3; notes.push('~1000/s (milliseconds)'); }
    if (near(30)) { score += 1; notes.push('~30/s'); }
    if (near(2) || near(1)) { score += 1; notes.push('~1-2/s'); }
    if (Math.abs(c.corrThrottle || 0) >= 0.5) { score += 2; notes.push(`throttle-corr ${c.corrThrottle}`); }
    if (bothRuns) { score += 3; notes.push('two-runs'); }
    if (c.bcd) { score += 1; notes.push('bcd'); }
    if (c.width === 4) { score += 1; }
    return { ...c, twin, score, notes, rate };
  }).sort((a, b) => b.score - a.score || (b.suffixLen - a.suffixLen));

  const fmt = (n, d = 2) => (n == null || Number.isNaN(n) ? '-' : Number(n).toFixed(d));
  const lines = [];
  lines.push('');
  lines.push('RANKED CANDIDATES (race 1)');
  lines.push('  addr      w  enc          rate/emu-s  dlt  stable  corrThr  min..max        distinct  sufStart  sufLen');
  const top = scored.slice(0, 45);
  for (const c of top) {
    lines.push([
      `${c.addr.toString(16).padEnd(8)}`,
      `${c.width}`,
      c.enc.padEnd(11),
      fmt(c.ratePerEmuSec).padStart(9),
      String(c.medianDelta).padStart(5),
      fmt(c.modeShare).padStart(6),
      fmt(c.corrThrottle).padStart(7),
      `${c.min}..${c.max}`.padEnd(14),
      String(c.distinct).padStart(7),
      String(c.suffixStart).padStart(7),
      String(c.suffixLen).padStart(6),
      c.notes.includes('two-runs') ? 'RUNS' : '',
    ].join('  '));
  }

  // Volatile (speed-like) candidates: correlation with the throttle schedule.
  const volatile = scored.filter((c) => c.distinct >= 24 && !c.notes.includes('monotonic')).slice(0, 400);
  const rank = (arr) => {
    const sorted = arr.slice().sort((a, b) => b.distinct - a.distinct);
    return sorted.slice(0, 10).map((c) => ({ addr: c.addr, width: c.width, enc: c.enc, min: c.min, max: c.max, distinct: c.distinct }));
  };

  const confirmed = detectFields(r1.a, r2.a, finish);
  const finishReport = analyzeFinish(finish);
  if (finishReport && finish && finish.stepwise) {
    finishReport.stepwise = finish.stepwise.slice(0, 60);
  }

  return {
    text: lines.join('\n') + formatKnown(known) + formatConfirmed(confirmed) + formatFinishReport(finishReport) + formatStepwise(finish ? finish.stepwise : null),
    ranking: {
      top: top.map((c) => ({
        addr: c.addr, width: c.width, enc: c.enc, ratePerEmuSec: c.ratePerEmuSec, ratePerWallSec: c.ratePerWallSec,
        medianDelta: c.medianDelta, min: c.min, max: c.max, distinct: c.distinct, monoFrac: c.monoFrac,
        suffixStart: c.suffixStart, suffixLen: c.suffixLen, tailFirst: c.tailFirst, tailLast: c.tailLast,
        modeShare: c.modeShare, corrThrottle: c.corrThrottle, resets: c.resets, bothRuns: !!c.twin,
        bcd: c.bcd, notes: c.notes, firstValues: (c.values || []).slice(0, 12),
      })),
      volatile: rank(volatile),
    },
    confirmed,
    known: known ? { race1: known.k1, race2: known.k2 } : null,
    finishReport,
  };
}

function formatKnown(known) {
  if (!known) return '';
  const L = ['', 'KNOWN FIELDS — two-run agreement'];
  L.push('  field                   addr       w  race1 first->last (rate/s)      race2 first->last (rate/s)');
  const { k1, k2 } = known;
  for (let i = 0; i < k1.length; i++) {
    const a = k1[i];
    const b = k2 && k2[i] ? k2[i] : null;
    L.push([
      a.name.padEnd(22),
      `0x${a.addr.toString(16)}`.padEnd(10),
      String(a.width).padStart(2),
      `${a.first}->${a.last} (${a.ratePerEmuSec})${a.sentinel ? ` [${a.sentinel} pre-race]` : ''}`.padEnd(34),
      b ? `${b.first}->${b.last} (${b.ratePerEmuSec})${b.sentinel ? ` [${b.sentinel} pre-race]` : ''}` : '-',
    ].join('  '));
  }
  return L.join('\n');
}

function formatConfirmed(c) {
  if (!c) return '';
  const L = [];
  const show = (name, arr) => {
    L.push(`\n${name.toUpperCase()} (${arr.length})`);
    for (const x of arr.slice(0, 10)) {
      L.push(`  ${x.addr.toString(16)}  ${x.width}B  ${x.enc}  min=${x.min} max=${x.max}${x.ratePerEmuSec != null ? ' rate=' + x.ratePerEmuSec : ''}${x.corrThrottle != null ? ' corr=' + x.corrThrottle : ''}${x.from ? ' (' + x.from + ')' : ''}`);
    }
  };
  show('timer', c.timer);
  show('speed (throttle-correlated)', c.speed);
  show('lap (finish run)', c.lap);
  show('state-like', c.state);
  return L.join('\n');
}

function formatStepwise(list) {
  if (!list || !list.length) return '\nSTEPWISE SMALL-INT BYTES (finish run): none\n';
  const rle = (vals) => {
    if (!vals) return '';
    const out = [];
    let prev = vals[0], n = 1;
    for (let i = 1; i < vals.length; i++) {
      if (vals[i] === prev) { n++; continue; }
      out.push(`${prev}x${n}`);
      prev = vals[i]; n = 1;
    }
    out.push(`${prev}x${n}`);
    return out.join(' ');
  };
  const L = ['', `STEPWISE SMALL-INT BYTES (finish run): ${list.length} candidates`];
  for (const s of list.slice(0, 24)) {
    L.push(`  ${s.addr.toString(16)}  d=${s.distinct} changes=${s.changes} ${s.min}..${s.max}  ${rle(s.values)}`);
  }
  return L.join('\n');
}

function formatFinishReport(fr) {
  if (!fr) return '\nFINISH: not sampled (--quick / --no-finish)\n';
  const L = [];
  L.push('');
  L.push(`FINISH RUN: ${fr.samples} samples, ${fr.emuSeconds} emulated s (${fr.wallMs} ms wall)`);
  L.push('  addr width  first -> last   min..max  changes  frozen at (ms)  frozen emu-s');
  for (const f of fr.fields) {
    const frozen = fr.frozenEmuSeconds.find((x) => x.addr === f.addr);
    L.push(`  ${f.addr.toString(16)}  ${f.width}B  ${String(f.first).padStart(8)} -> ${String(f.last).padEnd(8)} ${String(f.min).padStart(5)}..${String(f.max).padEnd(5)}  ${String(f.changes).padStart(4)}     ${String(f.frozenFromMs).padStart(6)}          ${frozen ? frozen.frozenEmuSeconds : '-'}`);
  }
  return L.join('\n');
}

// Heuristics for the four fields the MMO needs; every hit is cross-checked
// against the second race and (when available) the finish run.
function detectFields(a1, a2, finish) {
  const out = { timer: [], lap: [], speed: [], state: [], courseCar: [] };
  const key = (c) => `${c.addr}:${c.width}:${c.enc}`;
  const m2 = new Map(a2.cands.map((c) => [key(c), c]));
  const fin = finish && finish.analyze && finish.analyze.cands ? finish.analyze.cands : [];
  for (const c of a1.cands) {
    const twin = m2.get(key(c));
    if (!twin) continue;
    const rate = c.ratePerEmuSec;
    if (rate == null) continue;
    const monotonicTail = c.suffixLen >= 8 && c.tailLast > c.tailFirst && c.distinct >= 8;
    // elapsed timer: monotonic counter at ~60/s (frames), ~100/s (centiseconds)
    // or ~1000/s (milliseconds)
    if (monotonicTail && (Math.abs(rate - 100) / 100 < 0.15 || Math.abs(rate - 60) / 60 < 0.15 || Math.abs(rate - 1000) / 1000 < 0.15)) {
      out.timer.push({ addr: c.addr, width: c.width, enc: c.enc, ratePerEmuSec: rate, min: c.min, max: c.max, medianDelta: c.medianDelta, suffixStart: c.suffixStart, suffixLen: c.suffixLen, bcd: !!c.bcd });
    }
    // speed: volatile field that follows the throttle square wave
    if (c.distinct >= 20 && Math.abs(c.corrThrottle || 0) >= 0.4 && c.min >= 0 && c.max <= 5000) {
      out.speed.push({ addr: c.addr, width: c.width, enc: c.enc, min: c.min, max: c.max, distinct: c.distinct, corrThrottle: c.corrThrottle });
    }
    // state: few distinct small values, not monotonic
    if (c.distinct >= 2 && c.distinct <= 6 && c.max <= 12 && c.suffixLen < 8) {
      out.state.push({ addr: c.addr, width: c.width, enc: c.enc, min: c.min, max: c.max, distinct: c.distinct });
    }
  }
  // Lap counter only steps at a lap boundary, so it shows up in the finish run
  // (3 laps) rather than in a 25 s race sample.
  for (const c of fin) {
    if (c.width === 1 && c.min >= 0 && c.max <= 4 && c.distinct >= 2 && c.distinct <= 4) {
      out.lap.push({ addr: c.addr, width: c.width, enc: c.enc, min: c.min, max: c.max, distinct: c.distinct, from: 'finish-run' });
    }
  }
  out.timer = out.timer.slice(0, 12);
  out.lap = out.lap.slice(0, 20);
  out.speed = out.speed.slice(0, 20);
  out.state = out.state.slice(0, 20);
  if (finish && finish.analyze) out.finishHot = finish.analyze.hotOffsets;
  return out;
}
