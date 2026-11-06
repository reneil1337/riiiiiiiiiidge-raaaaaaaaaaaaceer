import puppeteer from 'puppeteer-core';
import path from 'node:path';
const BASE = process.env.QA_BASE || 'http://localhost:8090';
const BRAVE = 'C:/Program Files/BraveSoftware/Brave-Browser/Application/brave.exe';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const browser = await puppeteer.launch({
  executablePath: BRAVE, headless: 'new',
  userDataDir: path.join(process.env.TEMP, 'rr4-dlss5-diag'),
  args: ['--no-sandbox', '--disable-dev-shm-usage', '--window-size=1280,800'],
  defaultViewport: { width: 1280, height: 800 },
});
const ctx = await browser.createBrowserContext();
const p = await ctx.newPage();
p.on('console', (m) => console.log('CONSOLE', m.type(), m.text().slice(0, 300)));
p.on('pageerror', (e) => console.log('PAGEERROR', e.message));
await p.goto(BASE + '/play-net?cache=0', { waitUntil: 'domcontentloaded', timeout: 60000 });
const t0 = Date.now();
let last = null;
while (Date.now() - t0 < 300000) {
  last = await p.evaluate(() => ({
    started: !!window.__R4?.startedAt, ejs: !!window.EJS_emulator,
    canvas: !!document.querySelector('#game canvas'),
  }));
  if (last.started && last.ejs && last.canvas) break;
  await sleep(1000);
}
console.log('BOOT', JSON.stringify(last), Math.round((Date.now() - t0) / 1000) + 's');
await sleep(12000);
const info = await p.evaluate(() => {
  const c = document.querySelector('#game canvas');
  const g = document.querySelector('#game');
  const vids = [...document.querySelectorAll('#game video')].map((v) => {
    const r = v.getBoundingClientRect();
    return { cls: v.className, filter: getComputedStyle(v).filter, inline: v.style.filter, rect: [r.x, r.y, r.width, r.height], vw: v.videoWidth, vh: v.videoHeight, rs: v.readyState };
  });
  let capture = { type: typeof c?.captureStream };
  try { const s = c.captureStream(60); capture.tracks = s.getTracks().map((t) => t.kind); } catch (e) { capture.error = String(e); }
  return {
    bodyFilter: document.body.dataset.filter,
    gameFilter: g ? getComputedStyle(g).filter : null,
    canvas: c ? { w: c.width, h: c.height, opacity: getComputedStyle(c).opacity } : null,
    videos: vids,
    capture,
    snapshot: window.__R4NET?.snapshot?.() || null,
  };
});
console.log('INFO', JSON.stringify(info, null, 2));
await p.screenshot({ path: '../_runtime/dlss5-net-diag.png' });
// Simulate the first user gesture and inspect again.
const box = await p.evaluate(() => { const c = document.querySelector('#game canvas'); const r = c.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; });
await p.mouse.click(box.x, box.y);
await sleep(3000);
const after = await p.evaluate(() => {
  const c = document.querySelector('#game canvas');
  const g = document.querySelector('#game');
  const vids = [...document.querySelectorAll('#game video')].map((v) => {
    const r = v.getBoundingClientRect();
    return { cls: v.className, filter: getComputedStyle(v).filter, inline: v.style.filter, rect: [r.x, r.y, r.width, r.height], vw: v.videoWidth, vh: v.videoHeight, rs: v.readyState };
  });
  return { bodyFilter: document.body.dataset.filter, gameFilter: g ? getComputedStyle(g).filter : null, canvasOpacity: c ? getComputedStyle(c).opacity : null, videos: vids };
});
console.log('AFTER_CLICK', JSON.stringify(after, null, 2));
await p.screenshot({ path: '../_runtime/dlss5-net-diag-after.png' });
// Re-apply the filter now that the canvas has definitely presented frames.
await p.select('#filterSelect', 'off');
await sleep(600);
await p.select('#filterSelect', 'dlss5');
await sleep(1800);
const retry = await p.evaluate(() => {
  const c = document.querySelector('#game canvas');
  const vids = [...document.querySelectorAll('#game video')].map((v) => ({ cls: v.className, filter: getComputedStyle(v).filter, rect: [v.getBoundingClientRect().width, v.getBoundingClientRect().height], vw: v.videoWidth, vh: v.videoHeight, rs: v.readyState }));
  return { bodyFilter: document.body.dataset.filter, canvasOpacity: c ? getComputedStyle(c).opacity : null, videos: vids };
});
console.log('AFTER_RETRY', JSON.stringify(retry, null, 2));
await p.screenshot({ path: '../_runtime/dlss5-net-diag-retry.png' });
await browser.close();
