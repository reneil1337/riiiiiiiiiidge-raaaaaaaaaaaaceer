// Drive the R4 intro/menu with key presses and screenshot each step.
import fs from 'node:fs';
import puppeteer from 'puppeteer-core';
const BRAVE = 'C:/Program Files/BraveSoftware/Brave-Browser/Application/brave.exe';
const OUT = '../_runtime/perf';
fs.mkdirSync(OUT, { recursive: true });
const browser = await puppeteer.launch({
  executablePath: BRAVE, headless: 'new',
  userDataDir: '../_runtime/perf-profile',
  args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-background-timer-throttling',
    '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows',
    '--window-size=1280,900', '--js-flags=--max-old-space-size=4096', '--disable-frame-rate-limit'],
  defaultViewport: { width: 1280, height: 900 },
});
const page = await browser.newPage();
page.on('pageerror', (e) => console.log('PAGEERROR', e.message));
await page.goto('http://localhost:8080/play?threads=0', { waitUntil: 'domcontentloaded', timeout: 60000 });
const deadline = Date.now() + 120000;
while (Date.now() < deadline) {
  if (await page.evaluate(() => !!window.__R4?.startedAt)) break;
  await new Promise((r) => setTimeout(r, 700));
}
await new Promise((r) => setTimeout(r, 2500));
await page.mouse.click(640, 450);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
for (let i = 1; i <= 16; i++) {
  await page.keyboard.press('Enter');
  await sleep(1800);
  await page.screenshot({ path: `${OUT}/drive-${String(i).padStart(2, '0')}.png` });
  const info = await page.evaluate(() => ({
    frame: window.EJS_emulator?.gameManager?.getFrameNum?.(),
    canvas: (() => { const c = document.querySelector('#game canvas'); return c ? [c.width, c.height] : null; })(),
  }));
  console.log('step', i, JSON.stringify(info));
}
await browser.close();
