import puppeteer from 'puppeteer-core';
const brave = 'C:/Program Files/BraveSoftware/Brave-Browser/Application/brave.exe';
const browser = await puppeteer.launch({ executablePath: brave, headless: 'new', args: ['--no-sandbox', '--disable-gpu'] });
for (const url of ['http://127.0.0.1:8096/', 'http://<host-lan-ip>:8096/']) {
  const page = await browser.newPage();
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 15000 });
    const info = await page.evaluate(() => ({
      url: location.href,
      secure: window.isSecureContext,
      gamepadFn: typeof navigator.getGamepads,
      gamepadCount: typeof navigator.getGamepads === 'function' ? navigator.getGamepads().length : null,
      fullscreenFn: typeof document.documentElement.requestFullscreen,
      vibration: typeof navigator.vibrate,
    }));
    console.log(JSON.stringify(info));
  } catch (e) {
    console.log(url, 'ERR', e.message);
  }
  await page.close();
}
await browser.close();
