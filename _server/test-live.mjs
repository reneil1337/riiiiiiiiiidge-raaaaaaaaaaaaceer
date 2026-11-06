import puppeteer from 'puppeteer-core';
const brave = 'C:/Program Files/BraveSoftware/Brave-Browser/Application/brave.exe';
const browser = await puppeteer.launch({
  executablePath: brave,
  headless: 'new',
  args: ['--no-sandbox', '--disable-gpu', '--autoplay-policy=no-user-gesture-required', '--window-size=1440,1000'],
  defaultViewport: { width: 1440, height: 1000 },
});
const page = await browser.newPage();
const logs = [];
page.on('console', m => logs.push(`[${m.type()}] ${m.text()}`));
page.on('pageerror', e => logs.push(`[pageerror] ${e.message}`));
await page.goto('http://127.0.0.1:8080/', { waitUntil: 'networkidle2' });
await new Promise(r => setTimeout(r, 3000));
await page.type('#nameInput', 'VERIFY');
await page.click('#joinBtn');
await new Promise(r => setTimeout(r, 4000));
const btns = await page.$$('#seatCards button');
if (btns[0]) await btns[0].click();
await new Promise(r => setTimeout(r, 2000));
console.log('LIVE', await page.evaluate(() => ({
  cabinet: document.querySelector('#infoCabinet')?.textContent,
  stream: document.querySelector('#infoStream')?.textContent,
  audio: window.__RR4?.state?.cabinet?.stream?.audio,
  source: window.__RR4?.state?.cabinet?.stream?.source,
  bytes: window.__RR4?.state?.cabinet?.stream?.bytesPerSec,
  seat: document.querySelector('#hudSeat')?.textContent,
  canvas: (() => { const c = document.querySelector('#streamCanvas'); return c ? [c.width, c.height] : null; })(),
})));
await page.screenshot({ path: '../_runtime/live-site.png' });
await page.click('#btnStart');
await new Promise(r => setTimeout(r, 5500));
await page.screenshot({ path: '../_runtime/live-site-start.png' });
console.log('LOGS', logs.join('\n'));
await browser.close();
