// Host-only proof of the R4 VS Battle macro in public/js/play-net.js.
//
// Boots /play-net as the host for a synthetic room (no guest needed), then calls
// window.__R4NET.mpRun() and records every macro stage plus screenshots.
//
// Run: node mp-macro-test.mjs
import puppeteer from 'puppeteer-core';
import fs from 'node:fs';
import path from 'node:path';

const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const OUT = '../_runtime';
const PROFILE = path.join(process.env.TEMP || 'C:/Windows/Temp', 'rr4-macro-profile');
const BASE = process.env.RR4_BASE || 'http://localhost:8080';
const TRACK = process.env.MP_TRACK || '3';
const CAR_HOST = process.env.MP_CAR_HOST || '5';
const CAR_GUEST = process.env.MP_CAR_GUEST || '2';
const URL_ = `${BASE}/play-net?game=r4&threads=0&cache=0&mpRole=host&mpRoom=TEST&mpRace=macro-${Date.now()}&mpTrackIndex=${TRACK}&mpCarHost=${CAR_HOST}&mpCarGuest=${CAR_GUEST}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const checks = [];
const stages = [];
const shots = [];
const log = (m) => console.log(m);
const record = (id, name, pass, detail = '') => {
  checks.push({ id, name, pass: !!pass, detail: String(detail) });
  log(`${pass ? 'PASS' : 'FAIL'}  ${id}  ${name}${detail ? '  - ' + detail : ''}`);
};

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: true,
  userDataDir: PROFILE,
  protocolTimeout: 240000,
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
  await page.setCacheEnabled(false);
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  log(`goto ${URL_}`);
  await page.goto(URL_, { waitUntil: 'domcontentloaded', timeout: 60000 });

  const t0 = Date.now();
  let started = false;
  for (let i = 0; i < 300; i += 1) {
    const s = await page.evaluate(() => {
      const btn = document.querySelector('#game .ejs_start_button');
      if (btn) btn.click();
      return !!(window.__R4NET && window.__R4NET.snapshot().started);
    });
    if (s) { started = true; break; }
    await sleep(500);
  }
  record('1', 'R4 core boots on /play-net', started, `${Math.round((Date.now() - t0) / 1000)}s`);
  await page.evaluate(() => {
    try { window.EJS_emulator?.play?.(); } catch { /* ignore */ }
    const gate = document.querySelector('#soundGate');
    if (gate && !gate.hidden) gate.click();
    window.__R4NET.closePanel();
  });
  await page.bringToFront();

  const snap = await page.evaluate(() => ({
    plan: window.__R4NET.planText(),
    role: window.__R4NET.mp.role,
    menuSel: window.__R4NET.readMenuSel(),
  }));
  log(`plan: ${snap.plan}  role=${snap.role}  menuSel=${snap.menuSel}`);

  const shot = async (name) => {
    const c = await page.evaluate(() => {
      const el = document.querySelector('#game canvas');
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { x: Math.max(0, r.x), y: Math.max(0, r.y), width: Math.max(1, r.width), height: Math.max(1, r.height) };
    });
    if (!c) return null;
    const file = path.join(OUT, `mp-macro-${name}.png`);
    await page.screenshot({ path: file, clip: c });
    shots.push(file);
    return file;
  };

  await page.evaluate(() => { window.__R4NET.mpRun(); });
  let lastStage = '';
  let raceShot = 0;
  const deadline = Date.now() + 150000;
  while (Date.now() < deadline) {
    const s = await page.evaluate(() => ({
      stage: window.__R4NET.mp.stage,
      stages: window.__R4NET.mp.stages.slice(-1),
      menuSel: window.__R4NET.readMenuSel(),
      menuVerified: window.__R4NET.mp.menuVerified,
      error: window.__R4NET.mp.auto.error,
      raceStart: window.__R4NET.mp.raceStartSignalledAt,
      raceLive: window.__R4NET.mp.raceLive,
      logs: window.__R4NET.logs.slice(-3),
    }));
    if (s.stage !== lastStage) {
      lastStage = s.stage;
      stages.push({ stage: s.stage, at: Date.now(), menuSel: s.menuSel });
      log(`stage ${String(stages.length).padStart(2, '0')}: ${s.stage}  menuSel=${s.menuSel}`);
      await sleep(600);
      await shot(`${String(stages.length).padStart(2, '0')}-${s.stage.replace(/[^a-z0-9]+/gi, '-')}`);
    } else if (s.stage === 'race:starting') {
      raceShot += 1;
      await shot(`race-load-${String(raceShot).padStart(2, '0')}`);
    }
    if (s.stage === 'race:live' || s.stage === 'macro:error') break;
    await sleep(1200);
  }
  const final = await page.evaluate(() => ({
    stage: window.__R4NET.mp.stage,
    menuVerified: window.__R4NET.mp.menuVerified,
    stages: window.__R4NET.mp.stages,
    ackLog: window.__R4NET.mp.ackLog || [],
    error: window.__R4NET.mp.auto.error,
    plan: window.__R4NET.planText(),
    logs: window.__R4NET.logs.slice(-12),
    errors: (window.__R4 ? window.__R4.errors : []).slice(-5),
  }));
  await sleep(9000);
  await shot('final');
  // The car/course menus are a solid yellow field; the race is not. This proves
  // the macro left the menus instead of only reaching the timer.
  const yellowPct = await (async () => {
    const c = await page.evaluate(() => {
      const el = document.querySelector('#game canvas');
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { x: Math.max(0, r.x), y: Math.max(0, r.y), width: Math.max(1, r.width), height: Math.max(1, r.height) };
    });
    if (!c) return null;
    const b64 = (await page.screenshot({ clip: c })).toString('base64');
    return page.evaluate(async (data) => {
      const img = new Image();
      img.src = 'data:image/png;base64,' + data;
      await img.decode();
      const W = 64, Hh = 48;
      const t = document.createElement('canvas');
      t.width = W; t.height = Hh;
      const x = t.getContext('2d');
      x.drawImage(img, 0, 0, W, Hh);
      const d = x.getImageData(0, 0, W, Hh).data;
      let y = 0, n = 0;
      for (let i = 0; i < d.length; i += 4) { n += 1; if (d[i] > 170 && d[i + 1] > 120 && d[i + 2] < 90) y += 1; }
      return +(100 * y / n).toFixed(1);
    }, b64);
  })();
  record('6', 'Macro left the yellow car/course menus (race frame)', yellowPct != null && yellowPct < 30,
    `yellowPct=${yellowPct}`);
  record('2', 'Macro reached the main menu via the RAM probe', final.menuVerified === true,
    `menuVerified=${final.menuVerified}`);
  record('3', 'Macro navigated VS Battle -> car P1 -> car P2 -> course', 
    final.stages.some((s) => s.stage === 'car:p1') && final.stages.some((s) => s.stage === 'car:p2')
      && final.stages.some((s) => s.stage === 'course'),
    final.stages.map((s) => s.stage).join(' > '));
  record('4', 'Macro reached race:live without an error', final.stage === 'race:live' && !final.error,
    `stage=${final.stage} error=${final.error || 'none'}`);
  log(`ack: ${JSON.stringify(final.ackLog)}`);
  record('5', 'No page errors during the macro', (final.errors || []).length === 0,
    JSON.stringify(final.errors || []));
  log(`plan ${final.plan}`);

  fs.writeFileSync(path.join(OUT, 'mp-macro-evidence.json'), JSON.stringify({
    url: URL_, plan: final.plan, stages, final, checks, shots, browserErrors: errors.slice(0, 20),
    at: new Date().toISOString(),
  }, null, 2));
  log(`evidence: ${OUT}/mp-macro-evidence.json`);
} catch (e) {
  record('0', 'Macro harness completed', false, e.stack || e.message);
  console.error(e);
} finally {
  try { await browser.close(); } catch { /* ignore */ }
  const failed = checks.filter((c) => !c.pass);
  log(`checks: ${checks.length - failed.length}/${checks.length} passed`);
  process.exitCode = failed.length ? 1 : 0;
}
