// Fast-forward through the R4 intro, then screenshot the menu state.
import puppeteer from 'puppeteer-core';
const BRAVE = 'C:/Program Files/BraveSoftware/Brave-Browser/Application/brave.exe';
const OUT = '../_runtime/perf';
const browser = await puppeteer.launch({
  executablePath: BRAVE, headless: 'new',
  userDataDir: '../_runtime/perf-profile',
  args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-background-timer-throttling',
    '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows',
    '--window-size=1280,900', '--js-flags=--max-old-space-size=4096', '--disable-frame-rate-limit'],
  defaultViewport: { width: 1280, height: 900 },
});
const page = await browser.newPage();
await page.goto('http://localhost:8080/play?threads=0', { waitUntil: 'domcontentloaded', timeout: 60000 });
const deadline = Date.now() + 120000;
while (Date.now() < deadline) {
  if (await page.evaluate(() => !!window.__R4?.startedAt)) break;
  await new Promise((r) => setTimeout(r, 700));
}
await new Promise((r) => setTimeout(r, 2000));
await page.evaluate(() => window.EJS_emulator.gameManager.toggleFastForward(1));
console.log('fast forward on');
await new Promise((r) => setTimeout(r, 45000));
await page.evaluate(() => window.EJS_emulator.gameManager.toggleFastForward(0));
await new Promise((r) => setTimeout(r, 1000));
await page.screenshot({ path: `${OUT}/skip-01.png` });
console.log('frame', await page.evaluate(() => window.EJS_emulator.gameManager.getFrameNum()));
for (let i = 1; i <= 6; i++) {
  await page.keyboard.press('Enter');
  await new Promise((r) => setTimeout(r, 2000));
  await page.screenshot({ path: `${OUT}/skip-${String(i + 1).padStart(2, '0')}.png` });
  console.log('enter', i, 'frame', await page.evaluate(() => window.EJS_emulator.gameManager.getFrameNum()));
}
await browser.close();
