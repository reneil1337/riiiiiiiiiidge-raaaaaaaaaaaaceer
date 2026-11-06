import puppeteer from 'puppeteer-core';

const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const URL = 'http://127.0.0.1:3011/';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: true,
  args: ['--no-sandbox', '--disable-gpu', '--autoplay-policy=no-user-gesture-required', '--window-size=1280,900'],
  defaultViewport: { width: 1280, height: 900 },
});
const page = await browser.newPage();
page.on('console', (m) => console.log(`[console:${m.type()}] ${m.text()}`));
page.on('pageerror', (e) => console.log(`[pageerror] ${e.message}`));
page.on('requestfailed', (r) => console.log(`[reqfail] ${r.url()} ${r.failure()?.errorText}`));
page.on('response', (r) => { if (r.status() >= 400) console.log(`[http ${r.status()}] ${r.url()}`); });
await page.goto(URL, { waitUntil: 'networkidle2', timeout: 60000 });
for (let i = 0; i < 40; i++) {
  const s = await page.evaluate(() => window.__np ? window.__np.snapshot() : null);
  console.log(i, JSON.stringify(s));
  if (s?.started) break;
  await sleep(1000);
}
await page.screenshot({ path: '../../_runtime/netplay-probe.png' });
await browser.close();
