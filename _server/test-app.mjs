import puppeteer from 'puppeteer-core';
import fs from 'node:fs';

const brave = 'C:/Program Files/BraveSoftware/Brave-Browser/Application/brave.exe';
const outDir = '../_runtime';
const base = 'http://127.0.0.1:8092/';
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
await page.setCacheEnabled(false);
const logs = [];
const errors = [];
page.on('console', (m) => {
  logs.push(`[console:${m.type()}] ${m.text()}`);
  if (m.type() === 'error') errors.push(`[console] ${m.text()}`);
});
page.on('pageerror', (e) => errors.push(`[pageerror] ${e.message}`));
page.on('requestfailed', (r) => logs.push(`[reqfail] ${r.url()} ${r.failure()?.errorText}`));

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const shot = (name) => page.screenshot({ path: `${outDir}/subagent-app-${name}.png` });
const info = (label, value) => console.log(label, JSON.stringify(value, null, 2));

async function waitFor(fn, timeout = 15000, label = 'condition') {
  try {
    await page.waitForFunction(fn, { timeout, polling: 250 });
    return true;
  } catch {
    console.log('TIMEOUT', label);
    return false;
  }
}

// ---- landing ----
await page.goto(base, { waitUntil: 'networkidle2', timeout: 30000 });
await sleep(3000);
await shot('landing');
info('LANDING', await page.evaluate(() => ({
  arcadeHidden: document.querySelector('#arcade')?.hidden,
  canvasCount: document.querySelectorAll('canvas').length,
  landingCanvas: !!document.querySelector('#landingCanvas'),
  status: document.querySelector('#landingStatus')?.textContent,
  bootHidden: document.querySelector('#previewBoot')?.hidden,
  view: window.__RR4?.state?.view,
})));

// ---- join ----
await page.type('#nameInput', 'SUBAGENT ONE');
await page.click('#joinBtn');
await sleep(2500);
await shot('arcade');
info('JOIN', await page.evaluate(() => ({
  arcadeHidden: document.querySelector('#arcade')?.hidden,
  joined: window.__RR4?.state?.joined,
  wsOpen: window.__RR4?.state?.wsOpen,
  room: !!window.__RR4?.state?.room,
  clientId: window.__RR4?.state?.clientId,
  canvasCount: document.querySelectorAll('canvas').length,
  canvasParent: document.querySelector('#streamCanvas')?.parentElement?.id,
  view: window.__RR4?.state?.view,
  screenClass: document.querySelector('#screen')?.className,
  viewButtons: Array.from(document.querySelectorAll('#viewSwitch button')).map(b => b.textContent),
  streamReady: window.__RR4?.state?.streamReady,
  bootHidden: document.querySelector('#screenIdle')?.hidden,
})));

// stream should begin within a few seconds with the test source
const streamStarted = await waitFor(
  () => window.__RR4?.state?.streamReady === true,
  20000,
  'stream frames',
);
info('STREAM', await page.evaluate(() => ({
  ready: window.__RR4?.state?.streamReady,
  bootHidden: document.querySelector('#screenIdle')?.hidden,
  previewBootHidden: document.querySelector('#previewBoot')?.hidden,
  player: !!window.__RR4?.state?.player,
  canvasCount: document.querySelectorAll('canvas').length,
})));
await shot('stream');

// ---- seat ----
const seatButtons = await page.$$('#seatCards button');
if (seatButtons[0]) await seatButtons[0].click();
await sleep(1600);
await shot('seated');
info('SEAT', await page.evaluate(() => ({
  mySeat: window.__RR4?.state?.room?.mySeat,
  hud: document.querySelector('#hudSeat')?.textContent,
  input: document.querySelector('#infoInput')?.textContent,
  ready: document.querySelector('#btnReady')?.textContent,
  viewButtons: Array.from(document.querySelectorAll('#viewSwitch button')).map(b => b.textContent),
  seatText: document.querySelector('#seatCards')?.innerText,
  host: document.querySelector('#arcadeHost')?.textContent,
  viewers: document.querySelector('#viewerPill')?.textContent,
})));

// ---- input change + release on blur ----
await page.keyboard.down('ArrowDown');
await sleep(250);
info('INPUT DOWN', await page.evaluate(() => ({
  mask: window.__RR4?.state?.mask,
  lastSent: window.__RR4?.state?.lastSent,
  armed: document.querySelector('#infoInput')?.textContent,
})));
await page.evaluate(() => window.dispatchEvent(new Event('blur')));
await sleep(350);
info('INPUT BLUR', await page.evaluate(() => ({
  mask: window.__RR4?.state?.mask,
  lastSent: window.__RR4?.state?.lastSent,
})));
await page.keyboard.up('ArrowDown');
await sleep(200);

// ---- view toggle ----
const myView = await page.$('#viewSwitch button[data-view="auto"]');
if (myView) await myView.click();
await sleep(500);
info('VIEW MY', await page.evaluate(() => ({
  view: window.__RR4?.state?.view,
  screenClass: document.querySelector('#screen')?.className,
  hudView: document.querySelector('#hudView')?.textContent,
})));
const fullSplit = await page.$('#viewSwitch button[data-view="split"]');
if (fullSplit) await fullSplit.click();
await sleep(500);
info('VIEW SPLIT', await page.evaluate(() => ({
  view: window.__RR4?.state?.view,
  screenClass: document.querySelector('#screen')?.className,
  hudView: document.querySelector('#hudView')?.textContent,
})));

// ---- modals + keyboard focus ----
await page.click('#btnHelp');
await sleep(500);
info('HELP OPEN', await page.evaluate(() => ({
  hidden: document.querySelector('#modalHelp')?.hidden,
  role: document.querySelector('#modalHelp')?.getAttribute('role'),
  labelledby: document.querySelector('#modalHelp')?.getAttribute('aria-labelledby'),
  focusInside: document.querySelector('#modalHelp')?.contains(document.activeElement),
})));
await page.keyboard.press('Escape');
await sleep(300);
info('HELP CLOSED', await page.evaluate(() => ({
  hidden: document.querySelector('#modalHelp')?.hidden,
  focusId: document.activeElement?.id,
})));
await page.click('#btnController');
await sleep(500);
info('CONTROLLER OPEN', await page.evaluate(() => ({
  hidden: document.querySelector('#modalController')?.hidden,
  focusInside: document.querySelector('#modalController')?.contains(document.activeElement),
})));
await page.click('[data-close="modalController"]');
await sleep(300);

// ---- fullscreen ----
await page.click('#btnFullscreenTop');
await sleep(1200);
await shot('fullscreen');
info('FULLSCREEN ON', await page.evaluate(() => ({
  fsEl: document.fullscreenElement?.tagName || null,
  bodyClass: document.body.className,
  exitHidden: document.querySelector('#btnExitFs')?.hidden,
})));
await page.keyboard.press('Escape');
await sleep(900);
info('FULLSCREEN ESC', await page.evaluate(() => ({
  fsEl: document.fullscreenElement?.tagName || null,
  bodyClass: document.body.className,
  exitHidden: document.querySelector('#btnExitFs')?.hidden,
})));
// F toggles in, exit button toggles out
await page.keyboard.press('f');
await sleep(900);
info('FULLSCREEN F', await page.evaluate(() => ({
  fsEl: document.fullscreenElement?.tagName || null,
  bodyClass: document.body.className,
  exitHidden: document.querySelector('#btnExitFs')?.hidden,
})));
await page.click('#btnExitFs');
await sleep(700);
info('FULLSCREEN EXIT BTN', await page.evaluate(() => ({
  fsEl: document.fullscreenElement?.tagName || null,
  bodyClass: document.body.className,
  exitHidden: document.querySelector('#btnExitFs')?.hidden,
})));

// ---- chat ----
await page.type('#chatInput', 'hello from subagent app test');
await page.click('#chatForm button');
await sleep(1200);
info('CHAT', await page.evaluate(() => ({
  text: document.querySelector('#chatLog')?.innerText,
  count: document.querySelector('#chatCount')?.textContent,
  role: document.querySelector('#chatLog')?.getAttribute('role'),
  live: document.querySelector('#chatLog')?.getAttribute('aria-live'),
})));

// ---- ready toggle ----
await page.click('#btnReady');
await sleep(900);
info('READY', await page.evaluate(() => ({
  text: document.querySelector('#btnReady')?.textContent,
  badge: document.querySelector('#readyBadge')?.textContent,
  seat: document.querySelector('#seatCards')?.innerText,
})));
await page.click('#btnReady');
await sleep(900);

// ---- lobby reconnect (same socket/client id) ----
await page.evaluate(() => {
  window.__oldWs = window.__RR4.state.ws;
  window.__RR4.state.ws.close();
});
const lobbyReconnected = await waitFor(
  () => window.__RR4?.state?.wsOpen === true && window.__RR4?.state?.ws !== window.__oldWs,
  12000,
  'lobby reconnect',
);
await sleep(1200);
info('LOBBY RECONNECT', await page.evaluate(() => ({
  reconnected: window.__RR4?.state?.wsOpen,
  mySeat: window.__RR4?.state?.room?.mySeat,
  clientId: window.__RR4?.state?.clientId,
  input: document.querySelector('#infoInput')?.textContent,
})));

// ---- stream reconnect (close jsmpeg socket) ----
await page.evaluate(() => { window.__oldPlayer = window.__RR4.state.player; });
await page.evaluate(() => {
  const p = window.__RR4.state.player;
  if (p?.source?.socket) p.source.socket.close();
});
const playerRecreated = await waitFor(
  () => !!window.__RR4?.state?.player && window.__RR4?.state?.player !== window.__oldPlayer,
  12000,
  'stream player recreate',
);
const streamBack = await waitFor(
  () => window.__RR4?.state?.streamReady === true,
  20000,
  'stream back after restart',
);
info('STREAM RECONNECT', await page.evaluate(() => ({
  playerRecreated: !!window.__RR4?.state?.player && window.__RR4?.state?.player !== window.__oldPlayer,
  ready: window.__RR4?.state?.streamReady,
  canvasCount: document.querySelectorAll('canvas').length,
  canvasParent: document.querySelector('#streamCanvas')?.parentElement?.id,
})));
await shot('stream-reconnect');

// ---- refresh / auto rejoin + seat reservation ----
const beforeRefresh = await page.evaluate(() => ({
  clientId: window.__RR4?.state?.clientId,
  name: window.__RR4?.state?.name,
  mySeat: window.__RR4?.state?.room?.mySeat,
}));
await page.reload({ waitUntil: 'networkidle2', timeout: 30000 });
const autoJoined = await waitFor(
  () => window.__RR4?.state?.joined === true && window.__RR4?.state?.room?.mySeat === 1,
  15000,
  'auto rejoin with seat',
);
await sleep(1500);
await shot('reconnect');
info('REFRESH REJOIN', await page.evaluate(() => ({
  autoJoined: window.__RR4?.state?.joined,
  arcadeHidden: document.querySelector('#arcade')?.hidden,
  clientId: window.__RR4?.state?.clientId,
  name: window.__RR4?.state?.name,
  mySeat: window.__RR4?.state?.room?.mySeat,
  hud: document.querySelector('#hudSeat')?.textContent,
  seatText: document.querySelector('#seatCards')?.innerText,
  chat: document.querySelector('#chatLog')?.innerText,
})), beforeRefresh);

// ---- split orientation override ----
await page.click('#btnController');
await sleep(400);
await page.select('#splitOrientation', 'horizontal');
await sleep(400);
info('SPLIT OVERRIDE', await page.evaluate(() => ({
  select: document.querySelector('#splitOrientation')?.value,
  screenClass: document.querySelector('#screen')?.className,
  stored: localStorage.getItem('rr4.split'),
})));
await page.select('#splitOrientation', 'auto');
await sleep(300);
await page.click('[data-close="modalController"]');
await sleep(300);

// ---- second player / spectator options ----
const ctx2 = await browser.createBrowserContext();
const page2 = await ctx2.newPage();
await page2.setCacheEnabled(false);
await page2.goto(base, { waitUntil: 'networkidle2', timeout: 30000 });
await page2.type('#nameInput', 'SUBAGENT TWO');
await page2.click('#joinBtn');
await sleep(2200);
info('P2 SPECTATOR', await page2.evaluate(() => ({
  mySeat: window.__RR4?.state?.room?.mySeat,
  viewButtons: Array.from(document.querySelectorAll('#viewSwitch button')).map(b => b.textContent),
  seatText: document.querySelector('#seatCards')?.innerText,
})));
const seat2Buttons = await page2.$$('#seatCards button');
if (seat2Buttons[1]) await seat2Buttons[1].click();
await sleep(1500);
info('P2 SEATED', await page2.evaluate(() => ({
  mySeat: window.__RR4?.state?.room?.mySeat,
  hud: document.querySelector('#hudSeat')?.textContent,
  viewButtons: Array.from(document.querySelectorAll('#viewSwitch button')).map(b => b.textContent),
  seatText: document.querySelector('#seatCards')?.innerText,
})));
info('P1 SEES P2', await page.evaluate(() => ({
  mySeat: window.__RR4?.state?.room?.mySeat,
  seatText: document.querySelector('#seatCards')?.innerText,
  readyBadge: document.querySelector('#readyBadge')?.textContent,
})));
await shot('two-players');
await ctx2.close();

info('RESULT', {
  streamStarted,
  lobbyReconnected,
  playerRecreated,
  streamBack,
  autoJoined,
  pageErrors: errors,
  logs: logs.filter(l => !l.includes('Download the React')).slice(0, 30),
});

await browser.close();
