// Capture R4 title screen after the manifest change (regression evidence).
import path from 'node:path';
import puppeteer from 'puppeteer-core';
const BASE = process.env.RR4_QA_BASE || 'http://localhost:8080';
const OUT = '../_runtime';
const PROFILE = path.join(process.env.TEMP, 'rr4-r4-title-profile');
const BRAVE = 'C:/Program Files/BraveSoftware/Brave-Browser/Application/brave.exe';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const browser = await puppeteer.launch({
  executablePath: BRAVE, headless: 'new', userDataDir: PROFILE,
  args: ['--no-sandbox', '--enable-unsafe-swiftshader', '--use-angle=swiftshader', '--window-size=1280,800', '--mute-audio'],
  defaultViewport: { width: 1280, height: 800 },
});
const page = await browser.newPage();
const errs = [];
page.on('pageerror', (e) => errs.push(String(e)));
page.on('console', (m) => { if (m.type() === 'error') errs.push(m.text()); });
await page.goto(BASE + '/play', { waitUntil: 'domcontentloaded' });
for (let i = 0; i < 120; i++) {
  const s = await page.evaluate(() => ({ started: !!window.__R4?.startedAt, btn: !!document.querySelector('#game .ejs_start_button') }));
  if (s.started) break;
  if (s.btn) await page.evaluate(() => document.querySelector('#game .ejs_start_button')?.click());
  await sleep(500);
}
await sleep(30000);
const info = await page.evaluate(() => ({
  game: window.__R4?.game, brand: document.querySelector('#brandGame')?.innerText.replace(/\s+/g, ' ').trim(),
  status: document.querySelector('#bootStatus')?.textContent, errors: window.__R4?.errors,
}));
await page.screenshot({ path: path.join(OUT, 'ridge-verify-r4-title.png') });
console.log('R4', JSON.stringify(info), 'ERR', JSON.stringify(errs.slice(0, 5)));
await browser.close();
