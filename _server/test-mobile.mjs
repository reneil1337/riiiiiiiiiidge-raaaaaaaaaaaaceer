import puppeteer from 'puppeteer-core';
const brave = 'C:/Program Files/BraveSoftware/Brave-Browser/Application/brave.exe';
const browser = await puppeteer.launch({
  executablePath: brave,
  headless: 'new',
  args: ['--no-sandbox', '--disable-gpu', '--autoplay-policy=no-user-gesture-required'],
});
const page = await browser.newPage();
await page.setViewport({ width: 390, height: 844, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
await page.goto('http://127.0.0.1:8080/', { waitUntil: 'networkidle2' });
await new Promise(r => setTimeout(r, 2500));
await page.screenshot({ path: '../_runtime/ui-mobile-landing.png' });
await page.type('#nameInput', 'MOBILE');
await page.tap('#joinBtn');
await new Promise(r => setTimeout(r, 2500));
const btns = await page.$$('#seatCards button');
if (btns[0]) await btns[0].tap();
await new Promise(r => setTimeout(r, 1500));
console.log(await page.evaluate(() => ({
  body: document.body.className,
  touchHidden: document.querySelector('#touchControls')?.hidden,
  touchDisplay: getComputedStyle(document.querySelector('#touchControls')).display,
  seat: document.querySelector('#hudSeat')?.textContent,
  viewport: [innerWidth, innerHeight],
  scrollW: document.documentElement.scrollWidth,
})));
await page.screenshot({ path: '../_runtime/ui-mobile-arcade.png' });
await browser.close();
