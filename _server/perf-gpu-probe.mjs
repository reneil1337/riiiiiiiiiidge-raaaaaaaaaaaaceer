// Quick headless GPU probe: which renderer does Brave use in this mode?
import puppeteer from 'puppeteer-core';

const BRAVE = 'C:/Program Files/BraveSoftware/Brave-Browser/Application/brave.exe';
const modes = [
  { name: 'default-headless', args: [] },
  { name: 'headless-swiftshader', args: ['--enable-unsafe-swiftshader', '--use-angle=swiftshader'] },
  { name: 'headless-d3d11', args: ['--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist'] },
];

for (const mode of modes) {
  let browser;
  try {
    browser = await puppeteer.launch({
      executablePath: BRAVE,
      headless: 'new',
      args: ['--no-sandbox', '--disable-dev-shm-usage', ...mode.args],
      defaultViewport: { width: 1280, height: 800 },
    });
    const page = await browser.newPage();
    await page.goto('about:blank');
    const info = await page.evaluate(() => {
      const c = document.createElement('canvas');
      const gl = c.getContext('webgl2') || c.getContext('webgl');
      let renderer = null, vendor = null, version = null;
      if (gl) {
        const ext = gl.getExtension('WEBGL_debug_renderer_info');
        renderer = ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER);
        vendor = ext ? gl.getParameter(ext.UNMASKED_VENDOR_WEBGL) : gl.getParameter(gl.VENDOR);
        version = gl.getParameter(gl.VERSION);
      }
      return { renderer, vendor, version, webgl2: !!c.getContext('webgl2'), dpr: devicePixelRatio, ua: navigator.userAgent };
    });
    console.log(JSON.stringify({ mode: mode.name, ...info }));
  } catch (e) {
    console.log(JSON.stringify({ mode: mode.name, error: String(e).slice(0, 300) }));
  } finally {
    if (browser) await browser.close();
  }
}
