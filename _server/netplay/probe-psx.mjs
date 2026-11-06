import puppeteer from 'puppeteer-core';
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const URL = 'http://127.0.0.1:3011/test-page-nightly.html?psx=1';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const browser = await puppeteer.launch({
  executablePath: CHROME, headless: true,
  args: ['--no-sandbox', '--disable-gpu', '--autoplay-policy=no-user-gesture-required',
    '--disable-background-timer-throttling', '--disable-backgrounding-occluded-windows',
    '--disable-renderer-backgrounding', '--window-size=1280,900'],
  defaultViewport: { width: 1280, height: 900 },
});
const page = await browser.newPage();
page.on('console', (m) => { if (!/invalid core option/.test(m.text())) console.log(`[${m.type()}] ${m.text().slice(0, 240)}`); });
page.on('pageerror', (e) => console.log(`[pageerror] ${e.message}`));
page.on('response', (r) => { if (r.status() >= 400) console.log(`[http ${r.status()}] ${r.url()}`); });
await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
const start = Date.now();
for (let i = 0; i < 120; i++) {
  const s = await page.evaluate(() => window.__np ? window.__np.snapshot() : null);
  if (i % 3 === 0) console.log(Math.round((Date.now() - start) / 1000) + 's', JSON.stringify(s));
  if (s?.started) break;
  await sleep(2000);
}
await sleep(30000);
const final = await page.evaluate(() => window.__np?.snapshot());
console.log('FINAL', JSON.stringify(final));
console.log('GM', JSON.stringify(await page.evaluate(() => {
  const e = window.EJS_emulator;
  const gm = e && e.gameManager;
  return {
    frame: gm?.getFrameNum?.(),
    text: e?.textElem?.innerText,
    files: gm?.FS ? (() => { try { return gm.FS.readdir('/'); } catch { return null; } })() : null,
    started: e?.started,
  };
})));
await page.screenshot({ path: '../../_runtime/netplay-psx-probe.png' });
// Try pressing Start (Enter) once in the canvas.
await page.focus('#game canvas').catch(() => {});
await page.keyboard.press('Enter');
await sleep(4000);
await page.screenshot({ path: '../../_runtime/netplay-psx-probe-start.png' });
console.log('AFTER START', JSON.stringify(await page.evaluate(() => window.__np?.snapshot())));
await browser.close();
