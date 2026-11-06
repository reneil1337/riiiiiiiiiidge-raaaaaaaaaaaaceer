// Two-page probe for the host -> guest control channel (`data-message`).
// Run: node mp-ctrl-probe.mjs
import puppeteer from 'puppeteer-core';

const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const BASE = 'http://localhost:8080';
const URL_ = `${BASE}/play-net?game=r4&cache=0`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const code = Array.from({ length: 4 }, () => 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'[Math.floor(Math.random() * 32)]).join('');

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: true,
  protocolTimeout: 240000,
  args: ['--no-sandbox', '--mute-audio', '--autoplay-policy=no-user-gesture-required',
    '--enable-unsafe-swiftshader', '--use-angle=swiftshader',
    '--disable-background-timer-throttling', '--disable-backgrounding-occluded-windows',
    '--disable-renderer-backgrounding', '--window-size=1280,900'],
  defaultViewport: { width: 1280, height: 900 },
});

const waitFor = async (page, label, fn, timeout = 120000) => {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    const v = await page.evaluate(fn).catch(() => null);
    if (v) return v;
    await sleep(500);
  }
  throw new Error(`timeout ${label}`);
};

try {
  const ctxA = await browser.createBrowserContext();
  const ctxB = await browser.createBrowserContext();
  const A = await ctxA.newPage();
  const B = await ctxB.newPage();
  for (const [p, label] of [[A, 'HOST'], [B, 'GUEST']]) {
    p.on('pageerror', (e) => console.log(`[${label}] pageerror ${e.message}`));
    await p.goto(URL_, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await waitFor(p, `${label} boot`, () => !!(window.__R4NET && window.__R4NET.snapshot().started));
    await p.evaluate(() => { try { window.EJS_emulator.play(); } catch { /* ignore */ } window.__R4NET.closePanel(); });
  }
  await A.evaluate((name) => { window.__R4NET.setName('CTRL-HOST'); window.__R4NET.hostRoom(name, 2, 'pw'); }, `CTRL-${code}`);
  await waitFor(A, 'host room', () => { const s = window.__R4NET.snapshot(); return s.isNetplay && s.owner; }, 45000);

  const joinInfo = await B.evaluate(async (name) => {
    const rooms = await window.__R4NET.getRooms();
    const hit = Object.entries(rooms).find(([, r]) => r.room_name === name);
    if (!hit) return null;
    window.__R4NET.setName('CTRL-GUEST');
    window.__R4NET.joinRoom(hit[0], hit[1].room_name, 2, 'pw');
    return { sid: hit[0], room: hit[1] };
  }, `CTRL-${code}`);
  if (!joinInfo) throw new Error('guest did not see the room');
  await waitFor(B, 'guest joined', () => { const s = window.__R4NET.snapshot(); return s.isNetplay && !s.owner; }, 45000);
  await sleep(1500);

  const state = async () => ({
    A: await A.evaluate(() => ({
      isNetplay: window.__R4NET.snapshot().isNetplay,
      owner: window.__R4NET.snapshot().owner,
      socket: !!window._np?.socket,
      control: window.__R4MP.controlReceived.length,
      events: window.__R4MP.socketEvents,
      mySocketId: window.EJS_emulator.netplay.socket?.id || null,
    })),
    B: await B.evaluate(() => ({
      isNetplay: window.__R4NET.snapshot().isNetplay,
      owner: window.__R4NET.snapshot().owner,
      control: window.__R4MP.controlReceived.length,
      events: window.__R4MP.socketEvents,
      mySocketId: window.EJS_emulator.netplay.socket?.id || null,
      listeners: window.EJS_emulator.netplay.socket?.listeners('data-message').length ?? null,
      hasOurFlag: !!window.EJS_emulator.netplay.__r4Control,
      hasSocket: !!window.EJS_emulator.netplay.socket,
    })),
  });
  console.log('before', JSON.stringify(await state(), null, 2));

  // Direct send from the host with the same wire shape the macro uses.
  await A.evaluate(() => window.EJS_emulator.netplay.sendMessage({ 'r4-mp': { type: 'probe', from: 'host' } }));
  await sleep(2000);
  console.log('after host->guest', JSON.stringify(await state(), null, 2));

  // Guest -> host for comparison.
  await B.evaluate(() => window.EJS_emulator.netplay.sendMessage({ 'r4-mp': { type: 'probe', from: 'guest' } }));
  await sleep(2000);
  console.log('after guest->host', JSON.stringify(await state(), null, 2));

  // Raw listener attached right now (bypasses any early/late install issue).
  await B.evaluate(() => {
    window.__raw = [];
    window.EJS_emulator.netplay.socket.on('data-message', (d) => window.__raw.push(d));
  });
  await A.evaluate(() => window.EJS_emulator.netplay.sendMessage({ 'r4-mp': { type: 'probe2', from: 'host' } }));
  await sleep(2000);
  console.log('raw guest data-message', JSON.stringify(await B.evaluate(() => window.__raw), null, 2));
  console.log('guest control after', JSON.stringify(await B.evaluate(() => window.__R4MP.controlReceived), null, 2));
} catch (e) {
  console.error('PROBE FAILED', e);
  process.exitCode = 1;
} finally {
  await browser.close().catch(() => {});
}
