// Probe black-canvas cause: stage filter vs emulation.
import fs from 'node:fs';
import path from 'node:path';
import puppeteer from 'puppeteer-core';

const BASE = process.env.RR4_QA_BASE || 'http://localhost:8080';
const OUT = '../_runtime';
const PROFILE = path.join(process.env.TEMP, 'rr4-ridge-probe-profile');
const BRAVE = 'C:/Program Files/BraveSoftware/Brave-Browser/Application/brave.exe';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await puppeteer.launch({
  executablePath: BRAVE, headless: 'new', userDataDir: PROFILE,
  args: ['--no-sandbox', '--enable-unsafe-swiftshader', '--use-angle=swiftshader', '--window-size=1280,800', '--mute-audio'],
  defaultViewport: { width: 1280, height: 800 },
});
const page = await browser.newPage();
page.on('console', (m) => console.log('[console]', m.type(), m.text().slice(0, 200)));
page.on('pageerror', (e) => console.log('[pageerror]', String(e)));
await page.goto(BASE + '/play?game=ridge', { waitUntil: 'domcontentloaded' });
for (let i = 0; i < 60; i++) {
  const s = await page.evaluate(() => ({ started: !!window.__R4?.startedAt, status: document.querySelector('#bootStatus')?.textContent, btn: !!document.querySelector('#game .ejs_start_button') }));
  if (s.started) break;
  if (s.btn) await page.evaluate(() => document.querySelector('#game .ejs_start_button')?.click());
  await sleep(500);
}
await sleep(12000);
const info = await page.evaluate(() => {
  const c = document.querySelector('#game canvas');
  const stage = document.querySelector('#play-stage');
  const em = window.EJS_emulator;
  return {
    bodyFilter: document.body.dataset.filter,
    stageFilter: stage ? getComputedStyle(stage).filter : null,
    stageInline: stage ? stage.style.filter : null,
    canvas: c ? { w: c.width, h: c.height, rect: c.getBoundingClientRect().toJSON(), display: getComputedStyle(c).display, visibility: getComputedStyle(c).visibility } : null,
    em: em ? { started: em.started, paused: em.paused, fps: em.fps, frameCount: em.frameCount } : null,
    svgFilter: !!document.querySelector('#dlss5-filter'),
    overlayHidden: document.querySelector('#bootOverlay')?.hidden,
  };
});
console.log('INFO', JSON.stringify(info, null, 2));
await page.screenshot({ path: path.join(OUT, 'ridge-probe-a.png') });
await page.evaluate(() => { const s = document.querySelector('#play-stage'); if (s) s.style.filter = 'none'; });
await sleep(1500);
await page.screenshot({ path: path.join(OUT, 'ridge-probe-b.png') });
// Press Start (Enter) a few times to pass attract.
for (let i = 0; i < 3; i++) { await page.keyboard.press('Enter'); await sleep(1500); }
await page.screenshot({ path: path.join(OUT, 'ridge-probe-c.png') });
await sleep(6000);
await page.screenshot({ path: path.join(OUT, 'ridge-probe-d.png') });
console.log('DONE');
await browser.close();
