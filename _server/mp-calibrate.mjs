// R4 two-player menu calibration harness.
//
// Boots the real /play-net page (no mpRole, so the page's own auto-race macro is
// inert), then runs a plan from a JSON file and captures a screenshot whenever
// the emulated video frame changes.
//
// Run:
//   node mp-calibrate.mjs plans/attract.json
//   node mp-calibrate.mjs plans/vs-battle.json --url "/play-net?game=r4&threads=0&cache=0"
//
// The plan is a JSON array of steps:
//   { "wait": 1500 }                     sleep
//   { "tap": [0, 3, 180, 900] }          player, button, hold ms, settle ms
//   { "hold": [0, 7, 900] }              press, sleep, release
//   { "shot": "name" }                   forced screenshot
//   { "log": "text" }                    annotate the run log
//   { "eval": "js expression" }          evaluate in the page, log the result
//
// Every screenshot also records the video hash/size so a caller can tell a
// real scene change from a static frame.
import puppeteer from 'puppeteer-core';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const OUT = '../_runtime/calib';
const PROFILE = path.join(process.env.TEMP || 'C:/Windows/Temp', 'rr4-calib-profile');
const CHROME = process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const APP = process.env.RR4_BASE || 'http://localhost:8080';
const args = process.argv.slice(2);
const planPath = args.find((a) => !a.startsWith('--')) || 'plans/attract.json';
const urlArgIdx = args.indexOf('--url');
const URL_ = urlArgIdx >= 0 ? APP + args[urlArgIdx + 1] : `${APP}/play-net?game=r4&threads=0&cache=0`;
const plan = JSON.parse(fs.readFileSync(path.resolve(planPath), 'utf8'));
fs.mkdirSync(OUT, { recursive: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// A starved renderer can leave a Puppeteer call pending forever; cap every
// frame read so a calibration run always finishes and reports a timeout.
const withTimeout = (promise, ms, fallback = null) => Promise.race([
  promise,
  new Promise((resolve) => setTimeout(() => resolve(fallback), ms)),
]);
const log = [];
const shots = [];
const note = (msg) => { const line = `${new Date().toISOString().slice(11, 23)} ${msg}`; log.push(line); console.log(line); };

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: true,
  userDataDir: PROFILE,
  protocolTimeout: 180000,
  args: [
    '--no-sandbox', '--mute-audio', '--autoplay-policy=no-user-gesture-required',
    '--enable-unsafe-swiftshader', '--use-angle=swiftshader',
    '--disable-background-timer-throttling', '--disable-backgrounding-occluded-windows',
    '--disable-renderer-backgrounding', '--window-size=1280,900', '--force-device-scale-factor=1',
  ],
  defaultViewport: { width: 1280, height: 900 },
});

let page;
try {
  page = await browser.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });

  note(`goto ${URL_}`);
  await page.goto(URL_, { waitUntil: 'domcontentloaded', timeout: 60000 });

  // EmulatorJS sometimes shows its own start button in headless.
  const t0 = Date.now();
  for (let i = 0; i < 400; i++) {
    const s = await page.evaluate(() => {
      const btn = document.querySelector('#game .ejs_start_button');
      if (btn) btn.click();
      return {
        started: !!(window.__R4NET && window.__R4NET.snapshot && window.__R4NET.snapshot().started),
        status: document.querySelector('#bootStatus')?.textContent || '',
        errors: (window.__R4 && window.__R4.errors || []).slice(-2),
      };
    });
    if (s.started) break;
    if (i % 10 === 0) note(`boot ${Math.round((Date.now() - t0) / 1000)}s ${s.status} ${JSON.stringify(s.errors)}`);
    await sleep(500);
  }
  const bootMs = Date.now() - t0;
  note(`core started in ${bootMs}ms`);

  await page.evaluate(() => {
    try { window.EJS_emulator?.play?.(); } catch { /* ignore */ }
    const gate = document.querySelector('#soundGate');
    if (gate && !gate.hidden) gate.click();
    window.__R4NET?.closePanel?.();
    const c = document.querySelector('#game canvas');
    if (c) { c.tabIndex = 0; try { c.focus({ preventScroll: true }); } catch { /* ignore */ } }
    if (window.__R4NET) {
      window.__calibInputs = [];
      const gm = window.EJS_emulator.gameManager;
      const orig = gm.functions.simulateInput;
      gm.functions.simulateInput = (p, i, v) => { window.__calibInputs.push([p, i, v]); return orig(p, i, v); };
    }
    // Locate the R4 main-menu label table in PSX RAM and derive the base
    // offset, so 0x800ACC40 / 0x800AC808 can be read without guessing where the
    // 2 MB PSX RAM lives inside the 512 MB WASM heap.
    window.__calibFindBase = () => {
      const em = window.EJS_emulator;
      const M = (em.gameManager && em.gameManager.Module) || em.Module;
      const H = M && M.HEAPU8;
      if (!H) return null;
      const bytes = (s) => Array.from(s).map((c) => c.charCodeAt(0));
      const gp = bytes('GRAND PRIX');
      const wl = bytes('WELCOME');
      const vs = bytes('VS BATTLE');
      for (let i = 6000000; i < Math.min(H.length - 64, 12000000); i += 1) {
        if (H[i] !== gp[0]) continue;
        let ok = true;
        for (let j = 1; j < gp.length; j += 1) if (H[i + j] !== gp[j]) { ok = false; break; }
        if (!ok) continue;
        let w = true;
        for (let j = 0; j < wl.length; j += 1) if (H[i - 32 + j] !== wl[j]) { w = false; break; }
        if (!w) continue;
        let v = true;
        for (let j = 0; j < vs.length; j += 1) if (H[i + 32 + j] !== vs[j]) { v = false; break; }
        if (!v) continue;
        return i - 32;
      }
      return null;
    };
    window.__calibCanvas = () => {
      const c = document.querySelector('#game canvas');
      if (!c) return { ok: false, reason: 'no-canvas' };
      const W = 64, Hh = 48;
      const t = document.createElement('canvas');
      t.width = W; t.height = Hh;
      const x = t.getContext('2d', { willReadFrequently: true });
      try { x.drawImage(c, 0, 0, W, Hh); } catch (e) { return { ok: false, reason: String(e && e.message || e) }; }
      const d = x.getImageData(0, 0, W, Hh).data;
      let r = 0, g = 0, b = 0, n = 0, yellow = 0, dark = 0;
      for (let i = 0; i < d.length; i += 4) {
        r += d[i]; g += d[i + 1]; b += d[i + 2]; n += 1;
        if (d[i] > 170 && d[i + 1] > 120 && d[i + 2] < 90) yellow += 1;
        if (d[i] < 40 && d[i + 1] < 40 && d[i + 2] < 40) dark += 1;
      }
      return { ok: true, r: +(r / n).toFixed(1), g: +(g / n).toFixed(1), b: +(b / n).toFixed(1), yellowPct: +(100 * yellow / n).toFixed(1), darkPct: +(100 * dark / n).toFixed(1) };
    };
    window.__calibFullRam = () => {
      const em = window.EJS_emulator;
      const M = (em.gameManager && em.gameManager.Module) || em.Module;
      const H = M && M.HEAPU8;
      if (!H) return null;
      if (window.__calibBase == null) window.__calibBase = window.__calibFindBase();
      if (window.__calibBase == null) return null;
      const ramStart = window.__calibBase - (0x800A2180 - 0x80000000);
      const out = new Uint8Array(0x200000);
      out.set(H.subarray(ramStart, ramStart + 0x200000));
      window.__calibRamStart = ramStart;
      return out;
    };
    window.__calibSnaps = [];
    window.__calibPush = () => {
      const s = window.__calibFullRam();
      if (!s) return -1;
      window.__calibSnaps.push(s);
      return window.__calibSnaps.length;
    };
    window.__calibDiff = (step) => {
      const snaps = window.__calibSnaps;
      if (snaps.length < 2) return [];
      const hits = [];
      const n = snaps[0].length;
      for (let i = 0; i < n; i += 1) {
        const v0 = snaps[0][i];
        let ok = true;
        for (let k = 1; k < snaps.length; k += 1) {
          if (snaps[k][i] !== ((v0 + k * (step || 1)) & 0xff)) { ok = false; break; }
        }
        if (ok) hits.push(i);
        if (hits.length > 40) break;
      }
      return hits.map((i) => `0x${(0x80000000 + i).toString(16)}`);
    };
    window.__calibVals = (addr) => {
      const i = (parseInt(addr, 16) - 0x80000000) & 0xFFFFFF;
      return window.__calibSnaps.map((s) => s[i]);
    };
    window.__calibScreenCandidates = () => {
      const snaps = window.__calibSnaps;
      if (snaps.length < 8) return [];
      const n = snaps[0].length;
      const hits = [];
      for (let i = 0; i < n; i += 1) {
        const a = snaps[0][i], b = snaps[1][i], c = snaps[2][i], d = snaps[3][i];
        const e = snaps[4][i], f = snaps[5][i], g = snaps[6][i], h = snaps[7][i];
        if (a !== b || c !== d || e !== f || g !== h) continue;
        if (a === c && c === e && e === g) continue;
        hits.push({ addr: `0x${(0x80000000 + i).toString(16)}`, values: [a, c, e, g] });
        if (hits.length >= 25) break;
      }
      return hits;
    };
    window.__calibWordDiff = (delta) => {
      const snaps = window.__calibSnaps;
      if (snaps.length < 2) return [];
      const a = snaps[0], b = snaps[1];
      const hits = [];
      const n = a.length - 4;
      for (let i = 0; i < n; i += 4) {
        const w0 = (a[i] | (a[i + 1] << 8) | (a[i + 2] << 16) | (a[i + 3] << 24)) >>> 0;
        const w1 = (b[i] | (b[i + 1] << 8) | (b[i + 2] << 16) | (b[i + 3] << 24)) >>> 0;
        if (((w1 - w0) >>> 0) === (delta >>> 0)) {
          hits.push({ addr: `0x${(0x80000000 + i).toString(16)}`, from: `0x${w0.toString(16)}`, to: `0x${w1.toString(16)}` });
        }
        if (hits.length >= 20) break;
      }
      return hits;
    };
    window.__calibRam = () => {
      const em = window.EJS_emulator;
      const M = (em.gameManager && em.gameManager.Module) || em.Module;
      const H = M && M.HEAPU8;
      if (!H) return { ok: false, reason: 'no-heap' };
      if (window.__calibBase == null) window.__calibBase = window.__calibFindBase();
      const base = window.__calibBase;
      if (base == null) return { ok: false, reason: 'label-table-not-found' };
      const at = (addr) => base + (addr - 0x800A2180);
      const hex = (addr, n) => Array.from(H.slice(at(addr), at(addr) + n)).map((b) => b.toString(16).padStart(2, '0')).join('');
      const u16 = (addr) => Array.from({ length: 8 }, (_, k) => H[at(addr) + k * 2] | (H[at(addr) + k * 2 + 1] << 8));
      const u32 = (addr) => Array.from({ length: 8 }, (_, k) => (H[at(addr) + k * 4] | (H[at(addr) + k * 4 + 1] << 8) | (H[at(addr) + k * 4 + 2] << 16) | (H[at(addr) + k * 4 + 3] << 24)) >>> 0);
      return {
        ok: true, base,
        menuSel: H[at(0x800AC801)],
        selHex: hex(0x800ACC40, 16), selU16: u16(0x800ACC40), selU32: u32(0x800ACC40),
        stateHex: hex(0x800AC808, 32), stateU16: u16(0x800AC808), stateU32: u32(0x800AC808),
        aroundSel: hex(0x800ACC00, 96),
      };
    };
  });
  await page.bringToFront();

  const canvasRect = async () => page.evaluate(() => {
    const c = document.querySelector('#game canvas');
    if (!c) return null;
    const r = c.getBoundingClientRect();
    return { x: Math.max(0, r.x), y: Math.max(0, r.y), width: Math.max(1, r.width), height: Math.max(1, r.height) };
  });

  // Mean colour of the emulated frame. Used to recognise R4's yellow title
  // card without a PNG decoder in Node: the screenshot is drawn into a small
  // 2D canvas inside the page and averaged there.
  const frameStats = async () => {
    const rect = await withTimeout(canvasRect(), 8000);
    if (!rect) return null;
    let buf;
    try { buf = await withTimeout(page.screenshot({ clip: rect }), 15000); } catch { return null; }
    if (!buf) return null;
    const b64 = buf.toString('base64');
    return withTimeout(page.evaluate(async (data) => {
      const img = new Image();
      img.src = 'data:image/png;base64,' + data;
      try { await img.decode(); } catch { return null; }
      const W = 160, Hh = 120;
      const c = document.createElement('canvas');
      c.width = W; c.height = Hh;
      const x = c.getContext('2d');
      x.drawImage(img, 0, 0, W, Hh);
      const d = x.getImageData(0, 0, W, Hh).data;
      let r = 0, g = 0, b = 0, n = 0, yellow = 0;
      for (let i = 0; i < d.length; i += 4) {
        r += d[i]; g += d[i + 1]; b += d[i + 2]; n += 1;
        if (d[i] > 170 && d[i + 1] > 120 && d[i + 2] < 90) yellow += 1;
      }
      // Text bands on R4's yellow cards: '*PRESS START BUTTON' sits just above
      // the copyright lines. Count dark pixels inside that band.
      const band = (y0, y1) => {
        let dark = 0, tot = 0;
        for (let yy = Math.round(Hh * y0); yy < Math.round(Hh * y1); yy += 1) {
          for (let xx = Math.round(W * 0.1); xx < Math.round(W * 0.9); xx += 1) {
            const i = (yy * W + xx) * 4;
            tot += 1;
            if (d[i] < 105 && d[i + 1] < 105 && d[i + 2] < 105) dark += 1;
          }
        }
        return +(100 * dark / Math.max(1, tot)).toFixed(2);
      };
      return {
        r: +(r / n).toFixed(1), g: +(g / n).toFixed(1), b: +(b / n).toFixed(1),
        yellowPct: +(100 * yellow / n).toFixed(1),
        startBandPct: band(0.66, 0.75),
        copyBandPct: band(0.79, 0.9),
        logoBandPct: band(0.2, 0.55),
      };
    }, b64), 10000);
  };
  // R4's "*PRESS START BUTTON" card is a bright yellow field with a text band
  // and a copyright band below the logo.
  const isYellow = (s) => !!s && s.yellowPct > 35;
  const isPressStart = (s) => isYellow(s) && s.startBandPct > 0.6;

  let lastHash = '';
  let shotSeq = 0;
  const snapNow = async (label, force = false) => {
    const rect = await canvasRect();
    if (!rect) return null;
    let buf;
    try { buf = await page.screenshot({ clip: rect }); } catch (e) { note(`shot failed ${label}: ${e.message}`); return null; }
    const hash = crypto.createHash('sha1').update(buf).digest('hex').slice(0, 12);
    if (!force && hash === lastHash) return { hash, changed: false };
    lastHash = hash;
    shotSeq += 1;
    const name = `${String(shotSeq).padStart(3, '0')}-${label.replace(/[^a-z0-9_.-]+/gi, '-')}.png`;
    fs.writeFileSync(path.join(OUT, name), buf);
    const rec = { name, hash, bytes: buf.length, at: new Date().toISOString(), label };
    shots.push(rec);
    note(`SHOT ${name} ${buf.length}B ${hash}`);
    return { ...rec, changed: true };
  };

  const rawPad = (player, index, value) => page.evaluate((p, i, v) => {
    const gm = window.EJS_emulator && window.EJS_emulator.gameManager;
    if (!gm || !gm.functions || typeof gm.functions.simulateInput !== 'function') return false;
    gm.functions.simulateInput(p, i, v);
    return true;
  }, player, index, value);

  // Capture the first frame and a frame after every plan step, plus on change
  // while waiting.
  await snapNow('boot', true);
  for (const step of plan) {
    if (step.log) note(`STEP ${step.log}`);
    if (step.shot) await snapNow(step.shot, true);
    if (step.eval) {
      try {
        const v = await page.evaluate((expr) => {
          // eslint-disable-next-line no-new-func
          return new Function(`return (${expr});`)();
        }, step.eval);
        note(`EVAL ${step.eval} => ${JSON.stringify(v)}`);
      } catch (e) { note(`EVAL FAILED ${step.eval}: ${e.message}`); }
    }
    if (step.stats) note(`STATS ${JSON.stringify(await frameStats())}`);
    if (step.waitStart) {
      const end = Date.now() + step.waitStart;
      let s = null;
      while (Date.now() < end) {
        s = await frameStats();
        if (isPressStart(s)) break;
        await sleep(800);
      }
      note(`WAIT-PRESS-START ${isPressStart(s) ? 'found' : 'timeout'} ${JSON.stringify(s)}`);
    }
    if (step.waitYellow) {
      const end = Date.now() + step.waitYellow;
      let s = null;
      while (Date.now() < end) {
        s = await frameStats();
        if (isYellow(s)) break;
        await sleep(900);
      }
      note(`WAIT-YELLOW ${isYellow(s) ? 'found' : 'timeout'} ${JSON.stringify(s)}`);
    }
    if (step.quietWait) await sleep(step.quietWait);
    if (step.ramSnap) {
      const hex = await page.evaluate(() => {
        const em = window.EJS_emulator;
        const M = (em.gameManager && em.gameManager.Module) || em.Module;
        const H = M && M.HEAPU8;
        if (!H) return null;
        if (window.__calibBase == null) window.__calibBase = window.__calibFindBase();
        if (window.__calibBase == null) return null;
        const o = window.__calibBase + (0x800AC000 - 0x800A2180);
        return Array.from(H.slice(o, o + 4096)).map((b) => b.toString(16).padStart(2, '0')).join('');
      });
      if (hex) {
        fs.writeFileSync(path.join(OUT, `ram-${step.ramSnap}.txt`), hex);
        note(`RAMSNAP ${step.ramSnap} ${hex.length} hex chars`);
      } else note(`RAMSNAP ${step.ramSnap} failed`);
    }
    if (step.wait) {
      const end = Date.now() + step.wait;
      while (Date.now() < end) {
        await sleep(Math.min(700, Math.max(160, end - Date.now())));
        await snapNow('wait');
      }
    }
    if (step.hold) {
      const [p, idx, ms] = step.hold;
      await rawPad(p, idx, 1);
      await sleep(ms || 400);
      await snapNow('hold');
      await rawPad(p, idx, 0);
      await sleep(300);
    }
    if (step.tap) {
      const [p, idx, hold = 180, settle = 900] = step.tap;
      await rawPad(p, idx, 1);
      await sleep(hold);
      await rawPad(p, idx, 0);
      const end = Date.now() + settle;
      while (Date.now() < end) {
        await sleep(Math.min(600, Math.max(160, end - Date.now())));
        await snapNow('after');
      }
      await snapNow('settle', true);
    }
  }

  const inputs = await page.evaluate(() => window.__calibInputs || []);
  const snap = await page.evaluate(() => window.__R4NET?.snapshot?.() || null);
  note(`inputs: ${JSON.stringify(inputs)}`);
  note(`page errors: ${JSON.stringify(errors.slice(0, 6))}`);
  fs.writeFileSync(path.join(OUT, 'last-run.json'), JSON.stringify({
    url: URL_, bootMs, plan: planPath, shots, inputs, errors: errors.slice(0, 20), snapshot: snap, log,
  }, null, 2));
  note(`wrote ${OUT}/last-run.json (${shots.length} screenshots)`);
} catch (e) {
  note(`FAILED ${e.stack || e.message}`);
  process.exitCode = 1;
} finally {
  try { await browser.close(); } catch { /* ignore */ }
}
