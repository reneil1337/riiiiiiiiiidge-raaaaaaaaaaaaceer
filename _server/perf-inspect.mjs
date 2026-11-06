// Inspect EmulatorJS runtime options on the live /play page.
import puppeteer from 'puppeteer-core';
const BRAVE = 'C:/Program Files/BraveSoftware/Brave-Browser/Application/brave.exe';
const URL_ = process.argv[2] || 'http://localhost:8080/play?threads=0';
const browser = await puppeteer.launch({
  executablePath: BRAVE, headless: 'new',
  userDataDir: '../_runtime/perf-profile',
  args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--window-size=1280,900'],
  defaultViewport: { width: 1280, height: 900 },
});
const page = await browser.newPage();
page.on('pageerror', (e) => console.log('PAGEERROR', e.message));
await page.goto(URL_, { waitUntil: 'domcontentloaded', timeout: 60000 });
const deadline = Date.now() + 120000;
while (Date.now() < deadline) {
  const s = await page.evaluate(() => ({ started: !!window.__R4?.startedAt, ejs: !!window.EJS_emulator?.gameManager }));
  if (s.started && s.ejs) break;
  await new Promise((r) => setTimeout(r, 800));
}
await new Promise((r) => setTimeout(r, 1500));
const info = await page.evaluate(() => {
  const emu = window.EJS_emulator;
  const gm = emu.gameManager;
  const canvas = document.querySelector('#game canvas');
  let coreOptions = null;
  try { coreOptions = gm.getCoreOptions(); } catch (e) { coreOptions = 'ERR ' + e.message; }
  let videoDims = null;
  try { videoDims = { base: gm.getVideoDimensions('base'), aspect: gm.getVideoDimensions('aspect') }; } catch (e) { videoDims = 'ERR ' + e.message; }
  const settings = {};
  try {
    const ls = localStorage.getItem(emu.getLocalStorageKey());
    settings.localStorage = ls ? JSON.parse(ls).settings : null;
  } catch (e) { settings.localStorage = 'ERR ' + e.message; }
  const menuTexts = [...document.querySelectorAll('#game .ejs_settings_parent, #game .ejs_menu_text, #game .ejs_setting')]
    .map((e) => e.textContent.trim()).filter(Boolean).slice(0, 200);
  return {
    ejsVersion: emu.ejs_version || window.EJS_emulator?.version || null,
    core: emu.getCore ? emu.getCore() : null,
    coreName: emu.coreName || null,
    file: emu.fileName || null,
    extensions: emu.extensions || null,
    videoDims,
    canvas: canvas ? {
      width: canvas.width, height: canvas.height,
      clientWidth: canvas.clientWidth, clientHeight: canvas.clientHeight,
      rect: canvas.getBoundingClientRect().toJSON(),
      cssImageRendering: getComputedStyle(canvas).imageRendering,
      cssObjectFit: getComputedStyle(canvas).objectFit,
    } : null,
    parent: (() => { const p = document.querySelector('#game'); const r = p.getBoundingClientRect(); return { w: r.width, h: r.height, cls: p.className }; })(),
    coreOptions,
    settings,
    settingsKeys: Object.keys(emu.settings || {}),
    settingValues: Object.fromEntries(Object.entries(emu.settings || {}).map(([k, v]) => [k, v?.value ?? v])),
    menuTexts,
    getSetting: {
      fps: emu.getSettingValue('fps'), shader: emu.getSettingValue('shader'),
      ejs_threads: emu.getSettingValue('ejs_threads'), videoRotation: emu.getSettingValue('videoRotation'),
      aspectRatio: emu.getSettingValue('aspectRatio'),
    },
    webgl: (() => {
      const c = document.createElement('canvas'); const gl = c.getContext('webgl2');
      if (!gl) return null; const ext = gl.getExtension('WEBGL_debug_renderer_info');
      return { renderer: gl.getParameter(ext.UNMASKED_RENDERER_WEBGL), maxTexture: gl.getParameter(gl.MAX_TEXTURE_SIZE) };
    })(),
  };
});
console.log(JSON.stringify(info, null, 2));
await browser.close();
