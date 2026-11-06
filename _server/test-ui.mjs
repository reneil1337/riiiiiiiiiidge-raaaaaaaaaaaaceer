import puppeteer from 'puppeteer-core';
import fs from 'node:fs';

const brave = 'C:/Program Files/BraveSoftware/Brave-Browser/Application/brave.exe';
const outDir = '../_runtime';
fs.mkdirSync(outDir, { recursive: true });

const browser = await puppeteer.launch({
  executablePath: brave,
  headless: 'new',
  args: [
    '--no-sandbox',
    '--disable-gpu',
    '--autoplay-policy=no-user-gesture-required',
    '--window-size=1440,1000',
    '--force-device-scale-factor=1',
  ],
  defaultViewport: { width: 1440, height: 1000 },
});

const page = await browser.newPage();
const logs = [];
page.on('console', (m) => logs.push(`[console:${m.type()}] ${m.text()}`));
page.on('pageerror', (e) => logs.push(`[pageerror] ${e.message}`));
page.on('requestfailed', (r) => logs.push(`[reqfail] ${r.url()} ${r.failure()?.errorText}`));

await page.goto('http://127.0.0.1:8080/', { waitUntil: 'networkidle2', timeout: 30000 });
await new Promise(r => setTimeout(r, 3500));
await page.screenshot({ path: `${outDir}/ui-landing.png` });

await page.type('#nameInput', 'TEST DRIVER');
await page.click('#joinBtn');
await new Promise(r => setTimeout(r, 4500));
await page.screenshot({ path: `${outDir}/ui-arcade.png` });

console.log('INFO', JSON.stringify(await page.evaluate(() => ({
  arcadeHidden: document.querySelector('#arcade')?.hidden,
  canvas: (() => { const c = document.querySelector('#streamCanvas'); return c ? { w: c.width, h: c.height } : null; })(),
  seats: document.querySelector('#seatCards')?.innerText,
  hud: document.querySelector('#hudSeat')?.textContent,
  ping: document.querySelector('#pingPill')?.textContent,
  pad: document.querySelector('#padPill')?.textContent,
  chat: document.querySelector('#chatLog')?.innerText,
  cabinet: document.querySelector('#infoCabinet')?.textContent,
  stream: document.querySelector('#infoStream')?.textContent,
})), null, 2));

// Take P1
const seatButtons = await page.$$('#seatCards button');
if (seatButtons[0]) await seatButtons[0].click();
await new Promise(r => setTimeout(r, 1500));
await page.screenshot({ path: `${outDir}/ui-seat.png` });
console.log('AFTER SEAT', await page.evaluate(() => ({
  seats: document.querySelector('#seatCards')?.innerText,
  hud: document.querySelector('#hudSeat')?.textContent,
  ready: document.querySelector('#btnReady')?.textContent,
  input: document.querySelector('#infoInput')?.textContent,
})));

// Keyboard mask (down arrow = 0x40 active-low)
await page.keyboard.down('ArrowDown');
await new Promise(r => setTimeout(r, 250));
console.log('MASK DOWN', await page.evaluate(() => window.__RR4?.state?.mask));
await page.keyboard.up('ArrowDown');

// Mock an Xbox pad through the Gamepad API surface
await page.evaluate(() => {
  const pad = {
    id: 'Xbox Wireless Controller (STANDARD GAMEPAD Vendor: 045e Product: 0b13)',
    index: 0, connected: true, mapping: 'standard',
    buttons: Array.from({ length: 17 }, () => ({ pressed: false, value: 0 })),
    axes: [0, 0, 0, 0],
    vibrationActuator: { playEffect: () => { window.__rumble = (window.__rumble || 0) + 1; return Promise.resolve('complete'); } },
  };
  navigator.getGamepads = () => [pad];
  window.__pad = pad;
  window.dispatchEvent(new Event('gamepadconnected'));
});
await new Promise(r => setTimeout(r, 900));
console.log('XBOX PAD', await page.evaluate(() => ({
  pill: document.querySelector('#padPill')?.textContent,
  name: document.querySelector('#padStatusName')?.textContent,
  face: Array.from(document.querySelectorAll('#padFace [data-face]')).map(e => e.textContent),
})));
await page.evaluate(() => { window.__pad.buttons[0].pressed = true; });
await new Promise(r => setTimeout(r, 400));
console.log('PAD CROSS MASK', await page.evaluate(() => window.__RR4?.state?.mask));
await page.evaluate(() => { window.__pad.buttons[0].pressed = false; });

// Mock a DualSense pad
await page.evaluate(() => {
  const pad = {
    id: 'DualSense Wireless Controller (STANDARD GAMEPAD Vendor: 054c Product: 0ce6)',
    index: 0, connected: true, mapping: 'standard',
    buttons: Array.from({ length: 17 }, () => ({ pressed: false, value: 0 })),
    axes: [0, 0, 0, 0],
    vibrationActuator: { playEffect: () => Promise.resolve('complete') },
  };
  navigator.getGamepads = () => [pad];
  window.__pad = pad;
  window.dispatchEvent(new Event('gamepadconnected'));
});
await new Promise(r => setTimeout(r, 900));
console.log('PS PAD', await page.evaluate(() => ({
  pill: document.querySelector('#padPill')?.textContent,
  name: document.querySelector('#padStatusName')?.textContent,
  face: Array.from(document.querySelectorAll('#padFace [data-face]')).map(e => e.textContent),
})));

// Fullscreen
await page.click('#btnFullscreenTop');
await new Promise(r => setTimeout(r, 1500));
console.log('FS', await page.evaluate(() => ({
  fsEl: document.fullscreenElement?.tagName || null,
  bodyClass: document.body.className,
  exitHidden: document.querySelector('#btnExitFs')?.hidden,
})));
await page.screenshot({ path: `${outDir}/ui-fullscreen.png` });
await page.evaluate(() => document.exitFullscreen && document.exitFullscreen());
await new Promise(r => setTimeout(r, 1200));

// Controller modal
await page.click('#btnController');
await new Promise(r => setTimeout(r, 800));
await page.screenshot({ path: `${outDir}/ui-controller.png` });
await page.click('#btnRumble');
await new Promise(r => setTimeout(r, 500));
console.log('PAD MODAL', await page.evaluate(() => ({
  name: document.querySelector('#padStatusName')?.textContent,
  detail: document.querySelector('#padStatusDetail')?.textContent,
  badge: document.querySelector('#padStatusBadge')?.textContent,
  rumble: window.__rumble || 0,
})));
await page.click('[data-close="modalController"]');

// Chat
await page.type('#chatInput', 'hello from the test driver');
await page.click('#chatForm button');
await new Promise(r => setTimeout(r, 1200));
console.log('CHAT', await page.evaluate(() => document.querySelector('#chatLog')?.innerText));

// Second player in a separate context
const ctx2 = await browser.createBrowserContext();
const page2 = await ctx2.newPage();
await page2.setViewport({ width: 1280, height: 900 });
await page2.goto('http://127.0.0.1:8080/', { waitUntil: 'networkidle2', timeout: 30000 });
await page2.type('#nameInput', 'PLAYER TWO');
await page2.click('#joinBtn');
await new Promise(r => setTimeout(r, 2500));
const seat2 = await page2.$$('#seatCards button');
if (seat2[1]) await seat2[1].click();
await new Promise(r => setTimeout(r, 1500));
console.log('P2', await page2.evaluate(() => ({
  seats: document.querySelector('#seatCards')?.innerText,
  hud: document.querySelector('#hudSeat')?.textContent,
})));
console.log('P1 VIEW OF SEATS', await page.evaluate(() => document.querySelector('#seatCards')?.innerText));
await page.screenshot({ path: `${outDir}/ui-two-players.png` });

console.log('LOGS', logs.slice(0, 40).join('\n'));
await browser.close();
