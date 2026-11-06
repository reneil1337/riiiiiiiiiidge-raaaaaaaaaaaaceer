// Headful autoplay-policy probe: is audio running before a click?
import puppeteer from 'puppeteer-core';
const BRAVE = 'C:/Program Files/BraveSoftware/Brave-Browser/Application/brave.exe';
const browser = await puppeteer.launch({
  executablePath: BRAVE,
  headless: false,
  userDataDir: '../_runtime/perf-profile',
  args: [
    '--no-sandbox', '--disable-dev-shm-usage',
    '--autoplay-policy=document-user-activation-required',
    '--window-position=-2200,0', '--window-size=1100,760',
    '--disable-background-timer-throttling', '--disable-renderer-backgrounding',
  ],
  defaultViewport: { width: 1100, height: 760 },
});
const page = await browser.newPage();
await page.goto('http://localhost:8080/play?threads=0', { waitUntil: 'domcontentloaded', timeout: 60000 });
const deadline = Date.now() + 120000;
while (Date.now() < deadline) {
  const ok = await page.evaluate(() => !!window.__R4?.startedAt);
  if (ok) break;
  await new Promise((r) => setTimeout(r, 800));
}
await new Promise((r) => setTimeout(r, 2500));
const read = () => page.evaluate(() => {
  const AL = window.EJS_emulator?.Module?.AL;
  const ctx = AL?.currentCtx?.audioCtx;
  return {
    state: ctx?.state ?? null,
    sampleRate: ctx?.sampleRate ?? null,
    sourceStates: AL?.currentCtx?.sources ? AL.currentCtx.sources.map((s) => s.gain?.context?.state ?? null) : null,
    hasActivation: navigator.userActivation ? { active: navigator.userActivation.isActive, ever: navigator.userActivation.hasBeenActive } : null,
  };
});
const before = await read();
const box = await page.evaluate(() => {
  const c = document.querySelector('#game canvas'); const r = c.getBoundingClientRect();
  return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
});
await page.mouse.click(box.x, box.y);
await new Promise((r) => setTimeout(r, 1000));
const after = await read();
console.log(JSON.stringify({ before, after }, null, 2));
await browser.close();
