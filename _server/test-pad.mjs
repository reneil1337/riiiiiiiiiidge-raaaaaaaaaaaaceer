/* Browser-only controller smoke test.
 * Usage: start the site on 8091 with RR4_NO_AUTOSTART=1 RR4_STREAM_SOURCE=test,
 * then `node test-pad.mjs`.
 */
import puppeteer from 'puppeteer-core';
import fs from 'node:fs';

const brave = 'C:/Program Files/BraveSoftware/Brave-Browser/Application/brave.exe';
const outDir = '../_runtime';
const url = 'http://127.0.0.1:8091/';
fs.mkdirSync(outDir, { recursive: true });

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
let checks = 0;
function assert(ok, label, extra) {
  checks++;
  if (!ok) throw new Error(`FAIL ${label}${extra === undefined ? '' : ' :: ' + JSON.stringify(extra)}`);
  console.log(`ok ${checks} - ${label}`);
}

// Wait for the test server.
for (let i = 0; i < 60; i++) {
  try {
    const r = await fetch('http://127.0.0.1:8091/api/status');
    if (r.ok) break;
  } catch { /* not up yet */ }
  await sleep(250);
}

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

try {
  const page = await browser.newPage();
  const logs = [];
  page.on('console', (m) => logs.push(`[console:${m.type()}] ${m.text()}`));
  page.on('pageerror', (e) => logs.push(`[pageerror] ${e.message}`));

  // Mutable Gamepad API surface installed before the app boots.
  await page.evaluateOnNewDocument(() => {
    window.__mockPads = [];
    window.__rumble = [];
    window.__makePad = (id, index, opts = {}) => ({
      id,
      index,
      connected: true,
      mapping: opts.mapping === undefined ? 'standard' : opts.mapping,
      timestamp: performance.now(),
      buttons: Array.from({ length: opts.buttons || 17 }, () => ({ pressed: false, value: 0, touched: false })),
      axes: new Array(opts.axes || 4).fill(0),
      vibrationActuator: opts.noRumble ? undefined : {
        playEffect: (type, params) => {
          window.__rumble.push({ type, params });
          return Promise.resolve('complete');
        },
      },
    });
    Object.defineProperty(navigator, 'getGamepads', {
      configurable: true,
      value: () => window.__mockPads,
    });
  });

  await page.goto(url, { waitUntil: 'networkidle2', timeout: 30000 });
  await page.waitForSelector('#nameInput');
  await page.type('#nameInput', 'PAD TEST');
  await page.click('#joinBtn');
  await page.waitForFunction(() => document.querySelectorAll('#seatCards button').length >= 2, { timeout: 15000 });
  await page.evaluate(() => document.querySelector('#seatCards button').click());
  await page.waitForFunction(() => window.__RR4?.state?.input && window.__RR4.state.seat === 1, { timeout: 10000 });
  await sleep(400);
  assert(await page.evaluate(() => window.__RR4.state.mask) === 0xFFFF, 'starts neutral (0xFFFF)');
  const apiKeys = await page.evaluate(() => Object.keys(window.RR4Input).sort());
  assert(JSON.stringify(apiKeys) === JSON.stringify(['BIT', 'InputController', 'NEUTRAL', 'detectPadType', 'padLabel']),
    'RR4Input public API unchanged', apiKeys);

  const read = () => page.evaluate(() => ({
    pill: document.querySelector('#padPill')?.textContent,
    name: document.querySelector('#padStatusName')?.textContent,
    detail: document.querySelector('#padStatusDetail')?.textContent,
    face: Array.from(document.querySelectorAll('#padFace [data-face]')).map(e => e.textContent),
    mask: window.__RR4.state.mask,
    info: window.__RR4.state.input?.getPadInfo(),
  }));
  const setPads = (pads) => page.evaluate((specs) => {
    window.__mockPads = specs.map((s, i) => window.__makePad(s.id, s.index ?? i, s));
    window.dispatchEvent(new Event('gamepadconnected'));
  }, pads);
  const press = (index, pressed, value = 0) => page.evaluate(({ index, pressed, value }) => {
    const b = window.__mockPads[0].buttons[index];
    b.pressed = pressed;
    b.value = value;
  }, { index, pressed, value });

  await page.click('#btnController');
  await sleep(400);

  // ---- Xbox, standard mapping -------------------------------------------
  await setPads([{ id: 'Xbox Wireless Controller (STANDARD GAMEPAD Vendor: 045e Product: 0b13)', index: 0 }]);
  await sleep(500);
  let ui = await read();
  assert(ui.pill === 'XBOX', 'Xbox pill label', ui.pill);
  assert(ui.name === 'Xbox Wireless Controller', 'Xbox cleaned name', ui.name);
  assert(JSON.stringify(ui.face) === JSON.stringify(['Y', 'B', 'A', 'X']), 'Xbox face labels', ui.face);
  assert(ui.info?.type === 'xbox' && ui.info?.mapping === 'standard', 'Xbox pad info', ui.info);
  await page.screenshot({ path: `${outDir}/subagent-pad-xbox.png` });

  await press(0, true);
  await sleep(220);
  ui = await read();
  assert(ui.mask === 0xBFFF, 'Xbox Cross -> 0xBFFF', ui.mask);
  await press(0, false);
  await sleep(220);
  assert((await read()).mask === 0xFFFF, 'Xbox Cross release -> 0xFFFF');

  await press(12, true);
  await sleep(220);
  assert((await read()).mask === 0xFFEF, 'Xbox D-pad up -> 0xFFEF');
  await press(12, false);
  await press(7, false, 0.8);
  await sleep(220);
  assert((await read()).mask === 0xFDFF, 'Xbox analog R2 -> 0xFDFF');
  await press(7, false, 0.1);
  await sleep(220);
  assert((await read()).mask === 0xFFFF, 'Xbox analog R2 release');

  // Left stick with radial deadzone + hysteresis.
  await page.evaluate(() => { window.__mockPads[0].axes[0] = 0.8; });
  await sleep(220);
  assert((await read()).mask === 0xFFDF, 'Xbox stick right -> 0xFFDF');
  await page.evaluate(() => { window.__mockPads[0].axes[0] = 0.4; });
  await sleep(220);
  assert((await read()).mask === 0xFFDF, 'stick hysteresis holds at 0.4');
  await page.evaluate(() => { window.__mockPads[0].axes[0] = 0.2; });
  await sleep(220);
  assert((await read()).mask === 0xFFFF, 'stick releases below 0.34');
  await page.evaluate(() => { window.__mockPads[0].axes[0] = 0; });

  // ---- DualSense, standard mapping --------------------------------------
  await setPads([{ id: 'DualSense Wireless Controller (STANDARD GAMEPAD Vendor: 054c Product: 0ce6)', index: 0 }]);
  await sleep(500);
  ui = await read();
  assert(ui.pill === 'PLAYSTATION', 'PlayStation pill label', ui.pill);
  assert(ui.name === 'DualSense Wireless Controller', 'DualSense cleaned name', ui.name);
  assert(JSON.stringify(ui.face) === JSON.stringify(['△', '○', '✕', '□']), 'PlayStation face labels', ui.face);
  assert(ui.info?.type === 'playstation' && ui.info?.mapping === 'standard', 'DualSense pad info', ui.info);
  await page.screenshot({ path: `${outDir}/subagent-pad-playstation.png` });

  await press(0, true);
  await sleep(220);
  assert((await read()).mask === 0xBFFF, 'DualSense Cross -> 0xBFFF');
  await press(0, false);
  await sleep(220);
  assert((await read()).mask === 0xFFFF, 'DualSense Cross release -> 0xFFFF');

  // Rumble: dual-rumble path and unsupported path.
  const rumbleOk = await page.evaluate(() => window.__RR4.state.input.rumble(200, 1, 0.5));
  assert(rumbleOk === true, 'rumble reports supported');
  const rumbleCalls = await page.evaluate(() => window.__rumble);
  assert(rumbleCalls.length === 1 && rumbleCalls[0].type === 'dual-rumble', 'dual-rumble playEffect used', rumbleCalls);
  await setPads([{ id: 'Generic USB Gamepad', index: 0, noRumble: true }]);
  await sleep(300);
  const noRumble = await page.evaluate(() => window.__RR4.state.input.rumble(100, 1, 1));
  assert(noRumble === false, 'rumble returns false when unsupported');

  // ---- Non-standard raw PS3 order fallback ------------------------------
  await setPads([{
    id: 'PLAYSTATION(R)3 Controller (Vendor: 054c Product: 0268)',
    index: 0,
    mapping: '',
    buttons: 17,
    axes: 4,
  }]);
  await sleep(400);
  await press(14, true); // raw PS3 Cross
  await sleep(220);
  assert((await read()).mask === 0xBFFF, 'non-standard PS3 raw Cross -> 0xBFFF');
  await press(14, false);
  await press(4, true); // raw PS3 D-pad up
  await sleep(220);
  assert((await read()).mask === 0xFFEF, 'non-standard PS3 raw D-pad up -> 0xFFEF');
  await press(4, false);
  await sleep(200);

  // ---- Multi-pad slot selection + safe fallback -------------------------
  await setPads([
    { id: 'Xbox Wireless Controller (STANDARD GAMEPAD Vendor: 045e Product: 0b13)', index: 0 },
    { id: 'DualSense Wireless Controller (STANDARD GAMEPAD Vendor: 054c Product: 0ce6)', index: 1 },
  ]);
  await sleep(400);
  await page.evaluate(() => window.__RR4.state.input.setPadSlot(1));
  await sleep(400);
  ui = await read();
  assert(ui.pill === 'PLAYSTATION' && ui.name === 'DualSense Wireless Controller', 'padSlot 1 selects second pad', ui);
  await page.evaluate(() => window.__RR4.state.input.setPadSlot(0));
  await sleep(300);
  ui = await read();
  assert(ui.pill === 'XBOX', 'padSlot 0 selects first pad', ui.pill);
  await page.evaluate(() => window.__RR4.state.input.setPadSlot(1));
  await setPads([{ id: 'Xbox Wireless Controller (STANDARD GAMEPAD Vendor: 045e Product: 0b13)', index: 0 }]);
  await sleep(400);
  ui = await read();
  assert(ui.pill === 'XBOX', 'missing second pad falls back to first', ui.pill);
  await page.evaluate(() => window.__RR4.state.input.setPadSlot(0));

  // ---- Keyboard layouts, typing guard, blur release ---------------------
  await page.evaluate(() => window.__RR4.state.input.setLayout('p1'));
  await page.keyboard.down('ArrowDown');
  await sleep(180);
  assert((await read()).mask === 0xFFBF, 'P1 ArrowDown -> 0xFFBF');
  await page.keyboard.up('ArrowDown');
  await sleep(180);
  assert((await read()).mask === 0xFFFF, 'P1 ArrowDown release');

  await page.evaluate(() => window.__RR4.state.input.setLayout('p2'));
  await page.keyboard.down('KeyI');
  await sleep(180);
  assert((await read()).mask === 0xFFEF, 'P2 KeyI -> 0xFFEF');
  await page.keyboard.up('KeyI');
  await page.evaluate(() => window.__RR4.state.input.setLayout('auto'));
  await sleep(150);

  await page.focus('#chatInput');
  await page.keyboard.press('KeyX');
  await sleep(180);
  assert((await read()).mask === 0xFFFF, 'typing in chat does not fire the pad');
  await page.evaluate(() => document.querySelector('#chatInput').blur());

  await page.keyboard.down('ArrowUp');
  await sleep(180);
  assert((await read()).mask === 0xFFEF, 'ArrowUp held before blur');
  await page.evaluate(() => window.dispatchEvent(new Event('blur')));
  await sleep(180);
  assert((await read()).mask === 0xFFFF, 'blur releases keyboard');
  await page.keyboard.up('ArrowUp');

  // ---- Touch: pointer capture, multi-touch, no stuck buttons ------------
  await page.evaluate(() => {
    const input = window.__RR4.state.input;
    input.setTouchVisible(true);
    const cross = document.querySelector('[data-touch="cross"]');
    const circle = document.querySelector('[data-touch="circle"]');
    const ev = (el, type, id) => el.dispatchEvent(new PointerEvent(type, {
      bubbles: true, cancelable: true, pointerId: id, pointerType: 'touch', isPrimary: id === 1,
    }));
    ev(cross, 'pointerdown', 1);
    ev(circle, 'pointerdown', 2);
  });
  await sleep(180);
  let touch = await page.evaluate(() => ({
    mask: window.__RR4.state.mask,
    on: Array.from(document.querySelectorAll('#touchControls [data-touch].on')).map(e => e.dataset.touch),
  }));
  assert(touch.mask === 0x9FFF, 'touch Cross + Circle multi-touch', touch.mask);
  assert(touch.on.includes('cross') && touch.on.includes('circle'), 'touch buttons highlight', touch.on);
  await page.evaluate(() => {
    const cross = document.querySelector('[data-touch="cross"]');
    cross.dispatchEvent(new PointerEvent('pointerup', {
      bubbles: true, cancelable: true, pointerId: 1, pointerType: 'touch', isPrimary: true,
    }));
  });
  await sleep(180);
  touch = await page.evaluate(() => ({
    mask: window.__RR4.state.mask,
    on: Array.from(document.querySelectorAll('#touchControls [data-touch].on')).map(e => e.dataset.touch),
  }));
  assert(touch.mask === 0xDFFF, 'touch releases only the lifted finger', touch.mask);
  assert(!touch.on.includes('cross') && touch.on.includes('circle'), 'touch highlight follows fingers', touch.on);
  await page.evaluate(() => {
    window.__RR4.state.input.releaseAll();
    document.querySelector('[data-touch="circle"]').dispatchEvent(new PointerEvent('pointerup', {
      bubbles: true, cancelable: true, pointerId: 2, pointerType: 'touch', isPrimary: false,
    }));
  });
  await sleep(180);
  touch = await page.evaluate(() => ({
    mask: window.__RR4.state.mask,
    on: Array.from(document.querySelectorAll('#touchControls [data-touch].on')).map(e => e.dataset.touch),
  }));
  assert(touch.mask === 0xFFFF && touch.on.length === 0, 'releaseAll clears touch without stuck buttons', touch);
  await page.evaluate(() => window.__RR4.state.input.setTouchVisible(false));

  // Final state + evidence.
  ui = await read();
  console.log('FINAL', JSON.stringify(ui, null, 2));
  const errors = logs.filter(l => l.startsWith('[pageerror]') || l.startsWith('[console:error]'));
  assert(errors.length === 0, 'no page errors', errors);
  console.log(`PASS ${checks} checks`);
} finally {
  await browser.close();
}
