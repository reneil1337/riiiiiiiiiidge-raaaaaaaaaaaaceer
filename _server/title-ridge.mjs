// Try to reach the Ridge Racer title screen; verify the netplay manifest page.
import fs from 'node:fs';
import path from 'node:path';
import puppeteer from 'puppeteer-core';

const BASE = process.env.RR4_QA_BASE || 'http://localhost:8080';
const OUT = '../_runtime';
const PROFILE = path.join(process.env.TEMP, 'rr4-ridge-title-profile');
const BRAVE = 'C:/Program Files/BraveSoftware/Brave-Browser/Application/brave.exe';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await puppeteer.launch({
  executablePath: BRAVE, headless: 'new', userDataDir: PROFILE,
  args: ['--no-sandbox', '--enable-unsafe-swiftshader', '--use-angle=swiftshader', '--window-size=1280,800', '--mute-audio'],
  defaultViewport: { width: 1280, height: 800 },
});

// --- Ridge single-player: get past the intro, then tap Start ---
const page = await browser.newPage();
const errs = [];
page.on('pageerror', (e) => errs.push(String(e)));
await page.goto(BASE + '/play?game=ridge', { waitUntil: 'domcontentloaded' });
for (let i = 0; i < 120; i++) {
  const s = await page.evaluate(() => ({ started: !!window.__R4?.startedAt, btn: !!document.querySelector('#game .ejs_start_button') }));
  if (s.started) break;
  if (s.btn) await page.evaluate(() => document.querySelector('#game .ejs_start_button')?.click());
  await sleep(500);
}
await sleep(26000); // let the Namco logo + intro finish
const frames = [];
for (let i = 0; i < 12; i++) {
  const f = path.join(OUT, `ridge-title-${String(i).padStart(2, '0')}.png`);
  await page.screenshot({ path: f });
  frames.push(f);
  await page.keyboard.press('Enter');
  await sleep(1200);
}
console.log('TITLE FRAMES', JSON.stringify(frames));
console.log('RIDGE ERRORS', JSON.stringify(errs));

// --- Netplay page: manifest/brand/selector, no full boot needed ---
const net = await browser.newPage();
const netErrs = [];
net.on('pageerror', (e) => netErrs.push(String(e)));
await net.goto(BASE + '/play-net?game=ridge', { waitUntil: 'domcontentloaded' });
await sleep(4000);
const netInfo = await net.evaluate(() => {
  const sel = document.querySelector('#gameSelect');
  return {
    title: document.title,
    brand: document.querySelector('#brandGame')?.innerText.replace(/\s+/g, ' ').trim() || null,
    subtitle: document.querySelector('#overlayTitle')?.textContent || null,
    options: sel ? Array.from(sel.options).map((o) => ({ value: o.value, text: o.textContent })) : [],
    selected: sel ? sel.value : null,
    footRom: document.querySelector('#footRom')?.textContent || null,
    state: { game: window.__R4?.game, gameName: window.__R4?.gameName },
  };
});
await net.screenshot({ path: path.join(OUT, 'ridge-netplay.png') });
console.log('NETPLAY', JSON.stringify(netInfo));
console.log('NETPLAY ERRORS', JSON.stringify(netErrs.slice(0, 5)));
await browser.close();
