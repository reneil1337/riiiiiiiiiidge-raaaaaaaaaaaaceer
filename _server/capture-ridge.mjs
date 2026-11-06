// Capture Ridge Racer title/attract with a long wait; also capture R4 boot.
import fs from 'node:fs';
import path from 'node:path';
import puppeteer from 'puppeteer-core';

const BASE = process.env.RR4_QA_BASE || 'http://localhost:8080';
const OUT = '../_runtime';
const PROFILE = path.join(process.env.TEMP, 'rr4-ridge-capture-profile');
const BRAVE = 'C:/Program Files/BraveSoftware/Brave-Browser/Application/brave.exe';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await puppeteer.launch({
  executablePath: BRAVE, headless: 'new', userDataDir: PROFILE,
  args: ['--no-sandbox', '--enable-unsafe-swiftshader', '--use-angle=swiftshader', '--window-size=1280,800', '--mute-audio',
    '--disable-background-timer-throttling', '--disable-renderer-backgrounding'],
  defaultViewport: { width: 1280, height: 800 },
});

async function bootAndCapture(key, url, seconds) {
  const page = await browser.newPage();
  const errors = [];
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  for (let i = 0; i < 120; i++) {
    const s = await page.evaluate(() => ({ started: !!window.__R4?.startedAt, btn: !!document.querySelector('#game .ejs_start_button') }));
    if (s.started) break;
    if (s.btn) await page.evaluate(() => document.querySelector('#game .ejs_start_button')?.click());
    await sleep(500);
  }
  const t0 = Date.now();
  let n = 0;
  const frames = [];
  while (Date.now() - t0 < seconds * 1000) {
    await sleep(10000);
    n++;
    const file = path.join(OUT, `ridge-capture-${key}-${String(n).padStart(2, '0')}.png`);
    await page.screenshot({ path: file });
    frames.push(file);
    const st = await page.evaluate(() => ({
      filter: document.body.dataset.filter,
      stage: document.querySelector('#play-stage')?.style.filter || '',
      status: document.querySelector('#bootStatus')?.textContent,
      fps: window.EJS_emulator?.fps,
      paused: window.EJS_emulator?.paused,
      errors: window.__R4?.errors,
    }));
    console.log(key, n * 10 + 's', JSON.stringify(st));
  }
  // Nudge past attract with Start.
  await page.keyboard.press('Enter');
  await sleep(4000);
  const file = path.join(OUT, `ridge-capture-${key}-after-start.png`);
  await page.screenshot({ path: file });
  frames.push(file);
  console.log(key, 'errors', JSON.stringify(errors.slice(0, 10)));
  await page.close();
  return frames;
}

const ridge = await bootAndCapture('ridge', BASE + '/play?game=ridge', 80);
const r4 = await bootAndCapture('r4', BASE + '/play', 30);
console.log('FRAMES', JSON.stringify({ ridge, r4 }, null, 2));
await browser.close();
