import puppeteer from 'puppeteer-core';
import path from 'node:path';
const BASE = process.env.QA_BASE || 'http://localhost:8090';
const BRAVE = 'C:/Program Files/BraveSoftware/Brave-Browser/Application/brave.exe';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const browser = await puppeteer.launch({
  executablePath: BRAVE, headless: 'new',
  userDataDir: path.join(process.env.TEMP, 'rr4-dlss5-guest-diag'),
  args: ['--no-sandbox', '--disable-dev-shm-usage', '--window-size=1280,800'],
  defaultViewport: { width: 1280, height: 800 },
});
const hostCtx = await browser.createBrowserContext();
const guestCtx = await browser.createBrowserContext();
const host = await hostCtx.newPage();
const guest = await guestCtx.newPage();
for (const [p, label] of [[host, 'HOST'], [guest, 'GUEST']]) {
  p.on('pageerror', (e) => console.log(label, 'PAGEERROR', e.message));
}
async function boot(p, label) {
  const t0 = Date.now();
  await p.goto(BASE + '/play-net?cache=0', { waitUntil: 'domcontentloaded', timeout: 60000 });
  while (Date.now() - t0 < 300000) {
    const s = await p.evaluate(() => ({ started: !!window.__R4?.startedAt, ejs: !!window.EJS_emulator, canvas: !!document.querySelector('#game canvas') }));
    if (s.started && s.ejs && s.canvas) return s;
    await sleep(1000);
  }
  throw new Error('boot timeout ' + label);
}
console.log('host boot', await boot(host, 'HOST'));
await sleep(9000);
await host.evaluate(() => { window.__R4NET.setName('QA HOST'); window.__R4NET.hostRoom('DLSS5 DIAG', 2, ''); });
for (let i = 0; i < 30; i++) {
  const s = await host.evaluate(() => window.__R4NET?.snapshot?.());
  if (s?.owner && s?.connected) break;
  await sleep(700);
}
console.log('guest boot', await boot(guest, 'GUEST'));
for (let i = 0; i < 30; i++) {
  const rooms = await guest.evaluate(async () => {
    try { const r = await window.__R4NET.getRooms(); return Object.entries(r).find(([, v]) => v.room_name === 'DLSS5 DIAG'); } catch { return null; }
  });
  if (rooms) { await guest.evaluate(([id, room]) => { window.__R4NET.setName('QA GUEST'); window.__R4NET.joinRoom(id, room.room_name, room.max, null); }, rooms); break; }
  await sleep(800);
}
for (let i = 0; i < 40; i++) {
  const s = await guest.evaluate(() => window.__R4NET?.snapshot?.());
  if (s?.video?.readyState >= 2) break;
  await sleep(800);
}
await guest.evaluate(() => { const c = document.querySelector('#game canvas'); const r = c.getBoundingClientRect(); window.__diagPt = [r.x + r.width / 2, r.y + r.height / 2]; });
const pt = await guest.evaluate(() => window.__diagPt);
await guest.mouse.click(pt[0], pt[1]);
await sleep(4500);
const dump = (p) => p.evaluate(() => ({
  bodyFilter: document.body.dataset.filter,
  stageFilter: getComputedStyle(document.querySelector('#play-stage')).filter,
  videos: [...document.querySelectorAll('video')].map((v) => {
    const chain = []; let e = v; while (e && chain.length < 6) { chain.push(e.id ? '#' + e.id : (e.className ? '.' + String(e.className).replace(/\s+/g, '.') : e.tagName)); e = e.parentElement; }
    const r = v.getBoundingClientRect();
    return { chain, filter: getComputedStyle(v).filter, inline: v.style.filter, rect: [r.x, r.y, r.width, r.height], vw: v.videoWidth, vh: v.videoHeight, rs: v.readyState, paused: v.paused };
  }),
  gameVideos: document.querySelectorAll('#game video').length,
}));
console.log('GUEST BEFORE', JSON.stringify(await dump(guest), null, 2));
await guest.select('#filterSelect', 'dlss5');
await sleep(1500);
console.log('GUEST DLSS', JSON.stringify(await dump(guest), null, 2));
await guest.screenshot({ path: '../_runtime/dlss5-guest-diag-on.png' });
await guest.select('#filterSelect', 'off');
await sleep(1500);
console.log('GUEST OFF', JSON.stringify(await dump(guest), null, 2));
await guest.screenshot({ path: '../_runtime/dlss5-guest-diag-off.png' });
await browser.close();
