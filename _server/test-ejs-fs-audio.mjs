// Focused check: F-shortcut fullscreen + WebAudio unlock state.
// Usage: EJS_PROFILE=<dir> node test-ejs-fs-audio.mjs [url]
import puppeteer from 'puppeteer-core';

const BRAVE = 'C:/Program Files/BraveSoftware/Brave-Browser/Application/brave.exe';
const URL_ = process.argv[2] || 'http://127.0.0.1:8099/play';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await puppeteer.launch({
  executablePath: BRAVE,
  headless: 'new',
  userDataDir: process.env.EJS_PROFILE || undefined,
  args: ['--no-sandbox', '--autoplay-policy=no-user-gesture-required', '--enable-unsafe-swiftshader', '--use-angle=swiftshader', '--window-size=1280,800'],
  defaultViewport: { width: 1280, height: 800 },
});
const page = await browser.newPage();
const errs = [];
page.on('pageerror', (e) => errs.push(e.message));

const audioInfo = () => page.evaluate(() => {
  const em = window.EJS_emulator;
  const al = em?.Module?.AL;
  const ctx = al?.currentCtx?.audioCtx || null;
  return {
    hasEmulator: !!em,
    hasModule: !!em?.Module,
    hasAL: !!al,
    alCurrentCtx: !!al?.currentCtx,
    audioCtxState: ctx?.state || null,
    sampleRate: ctx?.sampleRate || null,
    paused: em?.paused ?? null,
    audioUnlocked: !!window.__R4?.audioUnlocked,
  };
});

await page.goto(URL_, { waitUntil: 'domcontentloaded', timeout: 30000 });
const t0 = Date.now();
while (Date.now() - t0 < 120000) {
  const started = await page.evaluate(() => !!window.__R4?.startedAt);
  if (started) break;
  await sleep(500);
}
await sleep(1200);
console.log('BEFORE GESTURE', JSON.stringify(await audioInfo()));

// F shortcut -> fullscreen
await page.keyboard.press('f');
await sleep(1400);
console.log('AFTER F', JSON.stringify(await page.evaluate(() => ({
  fullscreen: !!document.fullscreenElement,
  bodyClass: document.body.className,
  exitVisible: !document.querySelector('#fsExit')?.hidden,
}))));

await page.keyboard.press('f');
await sleep(1200);
console.log('AFTER F AGAIN', JSON.stringify(await page.evaluate(() => ({
  fullscreen: !!document.fullscreenElement,
  bodyClass: document.body.className,
}))));

// Gate click unlocks audio
const gate = await page.evaluate(() => !!document.querySelector('#soundGate') && !document.querySelector('#soundGate').hidden);
if (gate) await page.click('#soundGate');
await sleep(900);
console.log('AFTER GATE CLICK', JSON.stringify(await audioInfo()));

await page.screenshot({ path: '../_runtime/ejs-play/12-fs-audio-check.png' });
console.log('PAGE ERRORS', JSON.stringify(errs));
await browser.close();
