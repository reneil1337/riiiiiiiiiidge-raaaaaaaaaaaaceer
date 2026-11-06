import puppeteer from 'puppeteer-core';
import fs from 'node:fs';

const brave = 'C:/Program Files/BraveSoftware/Brave-Browser/Application/brave.exe';
const outDir = '../_runtime';
const base = 'http://127.0.0.1:8098/';
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

const errors = [];
const failures = [];
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const check = (label, ok, detail = '') => {
  if (ok) console.log(`PASS ${label}${detail ? ` — ${detail}` : ''}`);
  else { failures.push(label); console.log(`FAIL ${label}${detail ? ` — ${detail}` : ''}`); }
};

async function newPage(context, viewport, mobile = false) {
  const page = await context.newPage();
  await page.setCacheEnabled(false);
  await page.setViewport(viewport);
  if (mobile) await page.setUserAgent('Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1');
  page.on('pageerror', (e) => errors.push(`[pageerror ${viewport.width}] ${e.message}`));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(`[console ${viewport.width}] ${m.text()}`); });
  return page;
}

async function metrics(page) {
  return page.evaluate(() => ({
    innerWidth: window.innerWidth,
    scrollWidth: document.documentElement.scrollWidth,
    bodyScrollWidth: document.body.scrollWidth,
  }));
}

// ---------------------------------------------------------------- desktop
const desktopCtx = await browser.createBrowserContext();
const page = await newPage(desktopCtx, { width: 1440, height: 1000 });
await page.goto(base, { waitUntil: 'networkidle2', timeout: 30000 });
await sleep(2500);

const landing = await page.evaluate(() => {
  const play = document.querySelector('#playBrowserBtn');
  const note = document.querySelector('#nativeNote');
  const fs = document.querySelector('#fsLanding');
  const join = document.querySelector('#joinBtn');
  return {
    playHref: play?.getAttribute('href'),
    playText: play?.innerText,
    playVisible: !!play && play.offsetParent !== null,
    playPrimary: play?.classList.contains('primary'),
    noteVisible: !!note && note.offsetParent !== null,
    noteText: note?.innerText,
    fsText: fs?.innerText,
    fsPrimary: fs?.classList.contains('primary'),
    joinText: join?.innerText,
  };
});
check('landing PLAY IN BROWSER link exists', !!landing.playHref, landing.playHref || 'missing');
check('landing link targets /play', landing.playHref === '/play', landing.playHref || '');
check('landing CTA visible + primary red', landing.playVisible && landing.playPrimary);
check('landing native/in-browser panel visible', landing.noteVisible, (landing.noteText || '').replace(/\s+/g, ' ').slice(0, 90));
check('landing fullscreen is secondary', !landing.fsPrimary, landing.fsText || '');
check('landing fallback join label', /WATCH CABINET/i.test(landing.joinText || ''), landing.joinText || '');
const lm = await metrics(page);
check('no horizontal overflow at 1440 landing', lm.scrollWidth <= lm.innerWidth + 1, JSON.stringify(lm));
await page.screenshot({ path: `${outDir}/native-cta-landing-1440.png`, fullPage: true });

// Enter the fallback lobby and verify the arcade CTA.
await page.type('#nameInput', 'NATIVE TEST');
await page.click('#joinBtn');
await sleep(2500);
const arcade = await page.evaluate(() => {
  const top = document.querySelector('#arcadePlayTop');
  const stage = document.querySelector('#arcadePlayStage');
  const sub = document.querySelector('.cabinet-sub');
  return {
    hidden: document.querySelector('#arcade')?.hidden,
    topHref: top?.getAttribute('href'),
    topVisible: !!top && top.offsetParent !== null,
    stageHref: stage?.getAttribute('href'),
    stageVisible: !!stage && stage.offsetParent !== null,
    subText: sub?.textContent,
    seats: document.querySelector('#seatCards')?.children.length,
    streamLabel: document.querySelector('#infoStream')?.previousElementSibling?.textContent,
  };
});
check('arcade opens (fallback lobby intact)', arcade.hidden === false);
check('arcade top PLAY IN BROWSER link', arcade.topHref === '/play' && arcade.topVisible);
check('arcade stage PLAY IN BROWSER link', arcade.stageHref === '/play' && arcade.stageVisible);
check('stream labeled fallback', /FALLBACK/i.test(arcade.subText || '') && /FALLBACK/i.test(arcade.streamLabel || ''), `${arcade.subText} / ${arcade.streamLabel}`);
check('seat cards still render', arcade.seats === 2, `${arcade.seats} cards`);
check('fallback stream canvas still created', await page.evaluate(() => !!document.querySelector('#streamCanvas')));
const am = await metrics(page);
check('no horizontal overflow at 1440 arcade', am.scrollWidth <= am.innerWidth + 1, JSON.stringify(am));
await page.screenshot({ path: `${outDir}/native-cta-arcade-1440.png`, fullPage: true });

// Existing lobby flow: take a seat, ready up, chat, switch view.
const seatBtn = await page.$('#seatCards button');
if (seatBtn) await seatBtn.click();
await sleep(900);
check('taking P1 still works', await page.evaluate(() => /P1 \/\//.test(document.querySelector('#hudSeat')?.textContent || '')), await page.evaluate(() => document.querySelector('#hudSeat')?.textContent || ''));
check('READY enables for a seated driver', await page.evaluate(() => !document.querySelector('#btnReady')?.disabled));
await page.click('#btnReady');
await sleep(700);
check('READY toggles to UNREADY', await page.evaluate(() => /UNREADY/i.test(document.querySelector('#btnReady')?.textContent || '')));
await page.type('#chatInput', 'native cta test');
await page.click('#chatForm button');
await sleep(700);
check('chat still posts', await page.evaluate(() => /native cta test/i.test(document.querySelector('#chatLog')?.innerText || '')));
const viewBtn = await page.$('#viewSwitch button[data-view="split"]');
if (viewBtn) await viewBtn.click();
await sleep(300);
check('view switch still works', await page.evaluate(() => document.querySelector('#viewSwitch button[data-view="split"]')?.getAttribute('aria-pressed') === 'true'));

// Controller modal still opens/closes.
await page.click('#btnController');
await sleep(400);
check('controller modal still opens', await page.evaluate(() => !document.querySelector('#modalController')?.hidden));
await page.click('#modalController .modal-close');
await sleep(300);
check('controller modal still closes', await page.evaluate(() => document.querySelector('#modalController')?.hidden));

// Fullscreen flow still toggles the in-page class.
await page.click('#btnFullscreen2');
await sleep(700);
check('fullscreen flow still enters', await page.evaluate(() => document.body.classList.contains('fs')));
await page.screenshot({ path: `${outDir}/native-cta-fullscreen-1440.png` });
await page.click('#btnExitFs');
await sleep(700);
check('fullscreen flow still exits', await page.evaluate(() => !document.body.classList.contains('fs')));

// ---------------------------------------------------------------- mobile
const mobCtx = await browser.createBrowserContext();
const mob = await newPage(mobCtx, { width: 390, height: 844, isMobile: true, hasTouch: true, deviceScaleFactor: 2 }, true);
await mob.goto(base, { waitUntil: 'networkidle2', timeout: 30000 });
await sleep(2500);
const mobLanding = await mob.evaluate(() => {
  const play = document.querySelector('#playBrowserBtn');
  const note = document.querySelector('#nativeNote');
  return {
    playHref: play?.getAttribute('href'),
    playVisible: !!play && play.offsetParent !== null,
    noteVisible: !!note && note.offsetParent !== null,
  };
});
check('mobile landing PLAY link visible', mobLanding.playVisible && mobLanding.playHref === '/play');
check('mobile landing native panel visible', mobLanding.noteVisible);
const mlm = await metrics(mob);
check('no horizontal overflow at 390 landing', mlm.scrollWidth <= mlm.innerWidth + 1, JSON.stringify(mlm));
await mob.screenshot({ path: `${outDir}/native-cta-landing-390.png`, fullPage: true });

await mob.type('#nameInput', 'MOBILE');
await mob.tap('#joinBtn');
await sleep(2500);
const mobArcade = await mob.evaluate(() => {
  const stage = document.querySelector('#arcadePlayStage');
  return {
    stageHref: stage?.getAttribute('href'),
    stageVisible: !!stage && stage.offsetParent !== null,
    stageRect: stage ? stage.getBoundingClientRect().toJSON() : null,
    seats: document.querySelector('#seatCards')?.children.length,
  };
});
check('mobile arcade PLAY link visible', mobArcade.stageVisible && mobArcade.stageHref === '/play', JSON.stringify(mobArcade.stageRect));
check('mobile seat cards still render', mobArcade.seats === 2, `${mobArcade.seats} cards`);
const mam = await metrics(mob);
check('no horizontal overflow at 390 arcade', mam.scrollWidth <= mam.innerWidth + 1, JSON.stringify(mam));
await mob.screenshot({ path: `${outDir}/native-cta-arcade-390.png`, fullPage: true });

check('no page errors', errors.length === 0, errors.join(' | ').slice(0, 400));

await browser.close();
console.log(failures.length ? `RESULT FAIL (${failures.length})` : 'RESULT PASS');
process.exit(failures.length ? 1 : 0);
