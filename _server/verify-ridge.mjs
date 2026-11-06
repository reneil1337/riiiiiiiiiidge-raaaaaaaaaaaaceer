// Verify the Ridge Racer (1994) manifest entry + R4 regression.
// Usage: node verify-ridge.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import puppeteer from 'puppeteer-core';

const BASE = process.env.RR4_QA_BASE || 'http://localhost:8080';
const OUT = '../_runtime';
const PROFILE = path.join(os.tmpdir(), 'rr4-ridge-verify-profile');
const BRAVE = 'C:/Program Files/BraveSoftware/Brave-Browser/Application/brave.exe';
const BOOT_TIMEOUT_MS = Number(process.env.RR4_QA_BOOT_TIMEOUT_MS || 240000);
fs.mkdirSync(OUT, { recursive: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(...a);

async function state(page) {
  return page.evaluate(() => {
    const s = window.__R4 || {};
    const em = window.EJS_emulator;
    const sel = document.querySelector('#gameSelect');
    return {
      game: s.game,
      gameName: s.gameName,
      brand: document.querySelector('#brandGame')?.innerText.replace(/\s+/g, ' ').trim() || null,
      title: document.title,
      subtitle: document.querySelector('#overlayTitle')?.textContent || null,
      status: document.querySelector('#bootStatus')?.textContent || null,
      footRom: document.querySelector('#footRom')?.textContent || null,
      options: sel ? Array.from(sel.options).map((o) => ({ value: o.value, text: o.textContent })) : [],
      selected: sel ? sel.value : null,
      startedAt: s.startedAt || null,
      bootMs: s.bootMs ?? null,
      errors: s.errors || [],
      startBtn: !!document.querySelector('#game .ejs_start_button'),
      emuStarted: em ? !!em.started : false,
    };
  });
}

async function waitStarted(page, label, timeout = BOOT_TIMEOUT_MS) {
  const t0 = Date.now();
  let last = null;
  while (Date.now() - t0 < timeout) {
    last = await state(page);
    if (last.startedAt) return { ok: true, ms: Date.now() - t0, state: last };
    if (last.startBtn) await page.evaluate(() => document.querySelector('#game .ejs_start_button')?.click());
    if ((Date.now() - t0) % 15000 < 600) log(`  [${label}] ${Math.round((Date.now() - t0) / 1000)}s status=${last.status} overlay=${last.subtitle}`);
    await sleep(500);
  }
  return { ok: false, ms: Date.now() - t0, state: last };
}

const results = { base: BASE, shots: {}, games: {} };
let browser;
try {
  fs.rmSync(PROFILE, { recursive: true, force: true });
  browser = await puppeteer.launch({
    executablePath: BRAVE,
    headless: 'new',
    userDataDir: PROFILE,
    args: [
      '--no-sandbox', '--disable-dev-shm-usage', '--enable-unsafe-swiftshader',
      '--use-angle=swiftshader', '--window-size=1280,800',
      '--js-flags=--max-old-space-size=4096', '--mute-audio',
      '--disable-background-timer-throttling', '--disable-renderer-backgrounding',
      '--disable-backgrounding-occluded-windows',
    ],
    defaultViewport: { width: 1280, height: 800 },
  });
  results.browser = await browser.version();
  log('BROWSER', results.browser);

  for (const [key, url, boot] of [
    ['ridge', BASE + '/play?game=ridge', true],
    ['r4', BASE + '/play', true],
    ['rage', BASE + '/play?game=rage', false],
  ]) {
    const page = await browser.newPage();
    const roms = [];
    page.on('response', (r) => {
      if (/\/rom\//.test(r.url())) roms.push({ url: r.url(), status: r.status() });
    });
    const consoleErrors = [];
    page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()); });
    page.on('pageerror', (e) => consoleErrors.push(String(e)));
    log('NAV', url);
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await sleep(1500);
    const pre = await state(page);
    let bootInfo = null;
    if (boot) {
      bootInfo = await waitStarted(page, key);
      if (bootInfo.ok) await sleep(20000); // let the title / attract mode appear
      const file = path.join(OUT, `ridge-verify-${key}.png`);
      await page.screenshot({ path: file });
      results.shots[key] = file;
      log('SHOT', file);
    } else {
      const file = path.join(OUT, `ridge-verify-${key}.png`);
      await page.screenshot({ path: file });
      results.shots[key] = file;
      log('SHOT', file);
    }
    results.games[key] = {
      url,
      booted: bootInfo ? bootInfo.ok : null,
      bootMs: bootInfo ? bootInfo.ms : null,
      state: bootInfo ? bootInfo.state : await state(page),
      preBoot: pre,
      romResponses: roms,
      consoleErrors,
    };
    log(key.toUpperCase(), JSON.stringify({
      booted: results.games[key].booted,
      brand: results.games[key].state.brand,
      options: results.games[key].state.options,
      rom: results.games[key].state.footRom,
      errors: results.games[key].state.errors,
      roms: roms.slice(0, 3),
    }));
    await page.close();
  }
  fs.writeFileSync(path.join(OUT, 'ridge-verify-result.json'), JSON.stringify(results, null, 2));
  log('RESULT', path.join(OUT, 'ridge-verify-result.json'));
  const ok = results.games.ridge.booted && results.games.r4.booted;
  process.exit(ok ? 0 : 1);
} catch (e) {
  results.fatal = String(e);
  fs.writeFileSync(path.join(OUT, 'ridge-verify-result.json'), JSON.stringify(results, null, 2));
  console.error('FATAL', e);
  process.exit(2);
} finally {
  if (browser) await browser.close();
}
