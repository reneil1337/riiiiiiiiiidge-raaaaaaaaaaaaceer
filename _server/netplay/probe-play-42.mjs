// Read-only probe of the real /play page (EmulatorJS 4.2.3) with netplay
// config injected before load. Does not edit any main-page file.
import puppeteer from 'puppeteer-core';
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const browser = await puppeteer.launch({
  executablePath: CHROME, headless: true,
  args: ['--no-sandbox', '--disable-gpu', '--autoplay-policy=no-user-gesture-required',
    '--disable-background-timer-throttling', '--window-size=1280,900'],
  defaultViewport: { width: 1280, height: 900 },
});
const page = await browser.newPage();
page.on('pageerror', (e) => console.log(`[pageerror] ${e.message}`));
page.on('console', (m) => { if (m.type() === 'error') console.log(`[error] ${m.text()}`); });
await page.evaluateOnNewDocument(() => {
  window.EJS_netplayServer = 'http://127.0.0.1:3010';
  window.EJS_DEBUG_XX = true;
  window.EJS_EXPERIMENTAL_NETPLAY = true;
  window.EJS_Buttons = { netplay: true };
});
await page.goto('http://127.0.0.1:8080/play', { waitUntil: 'domcontentloaded', timeout: 60000 });
for (let i = 0; i < 40; i++) {
  const s = await page.evaluate(() => ({
    started: window.__R4?.startedAt != null,
    boot: window.__R4?.bootMs,
    errors: window.__R4?.errors,
    netplay: !!window.EJS_emulator?.netplay,
    button: (() => {
      const b = window.EJS_emulator?.elements?.bottomBar?.netplay?.[0];
      return b ? { display: getComputedStyle(b).display, visible: b.getBoundingClientRect().width > 2 } : null;
    })(),
    gameID: window.EJS_emulator?.config?.gameId,
    netplayUrl: window.EJS_emulator?.config?.netplayUrl,
  }));
  console.log(i, JSON.stringify(s));
  if (s.started) break;
  await sleep(2000);
}
await page.screenshot({ path: '../../_runtime/netplay-play42-probe.png' });
await browser.close();
