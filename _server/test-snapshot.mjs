import puppeteer from 'puppeteer-core';
const brave = 'C:/Program Files/BraveSoftware/Brave-Browser/Application/brave.exe';
const browser = await puppeteer.launch({ executablePath: brave, headless: 'new', args: ['--no-sandbox','--disable-gpu','--autoplay-policy=no-user-gesture-required'] });
const out = '../_runtime';
async function shot(page, path) { await page.screenshot({ path }); }
{
  const page = await browser.newPage();
  await page.setViewport({ width: 1440, height: 1000 });
  await page.goto('http://127.0.0.1:8098/', { waitUntil: 'networkidle2' });
  await new Promise(r => setTimeout(r, 2500));
  await shot(page, `${out}/snap-landing.png`);
  await page.type('#nameInput', 'SNAP');
  await page.click('#joinBtn');
  await new Promise(r => setTimeout(r, 3000));
  await shot(page, `${out}/snap-arcade.png`);
  console.log('desktop', await page.evaluate(() => ({ body: document.body.className, scrollW: document.documentElement.scrollWidth, w: innerWidth, cabinet: document.querySelector('#infoCabinet')?.textContent, view: document.querySelector('#hudView')?.textContent, fsBtn: document.querySelector('#btnFullscreen')?.getBoundingClientRect().toJSON() })));
  await page.close();
}
{
  const page = await browser.newPage();
  await page.setViewport({ width: 390, height: 844, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
  await page.goto('http://127.0.0.1:8098/', { waitUntil: 'networkidle2' });
  await new Promise(r => setTimeout(r, 2000));
  await shot(page, `${out}/snap-mobile-landing.png`);
  await page.type('#nameInput', 'PHONE');
  await page.tap('#joinBtn');
  await new Promise(r => setTimeout(r, 2500));
  await shot(page, `${out}/snap-mobile-arcade.png`);
  console.log('mobile', await page.evaluate(() => ({ body: document.body.className, scrollW: document.documentElement.scrollWidth, w: innerWidth, touch: getComputedStyle(document.querySelector('#touchControls')).display, fs: document.querySelector('#btnFullscreen')?.getBoundingClientRect().toJSON() })));
  await page.close();
}
await browser.close();
