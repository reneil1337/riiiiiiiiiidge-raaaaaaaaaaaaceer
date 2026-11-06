// Shell fullscreen + one-top-bar / iframe-fill evidence for the R4 cabinet.
//
// Covers HANDOFF.md P1 #1 (fullscreen shell button added but untested) and the
// AGENTS.md rules "the shell top bar is the only top bar" and "embedded /play
// must hide #play-bar and give the stage its space".
//
// Drives Chrome via puppeteer-core against the already-running cabinet on
// :8080. Does not start or stop any server, does not launch a native game.
//
// Run: node test-shell-fs.mjs
// Writes: _runtime/shell-fs.json, _runtime/shell-fs.log,
//         _runtime/shell-fs-1440.png, _runtime/shell-fs-390.png
//         (+ shell-fs-1440-windowed.png / shell-fs-390-windowed.png)

import puppeteer from 'puppeteer-core';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const BASE = 'http://localhost:8080';
const OUT = '../_runtime';
const DESKTOP = { width: 1440, height: 900 };
const MOBILE = { width: 390, height: 844 };

fs.mkdirSync(OUT, { recursive: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const checks = [];
function record(id, name, pass, detail = '', extra = undefined) {
  const entry = { id, name, pass: !!pass, detail: String(detail || '') };
  if (extra !== undefined) entry.extra = extra;
  checks.push(entry);
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${id}  ${name}${detail ? '  -- ' + detail : ''}`);
  return entry;
}

async function waitFor(label, fn, { timeout = 12000, interval = 120 } = {}) {
  const started = Date.now();
  let last = null;
  while (Date.now() - started < timeout) {
    try {
      last = await fn();
      if (last) return last;
    } catch (e) {
      last = e.message;
    }
    await sleep(interval);
  }
  throw new Error(`timeout waiting for ${label}; last=${JSON.stringify(last)}`);
}

// ---------------------------------------------------------------- console

const COOP_RX = /Cross-Origin-Opener-Policy|SharedArrayBuffer|COOP|No ICE servers configured/i;
// Known pre-existing: HANDOFF P0 #7, React hydration warning on /docs/introduction.
const KNOWN_RX = /Minified React error #418|react\.dev\/errors\/418/i;
const consoleErrors = [];
const consoleWarnings = [];
const pageErrors = [];
const ignoredConsole = [];
const knownConsole = [];

function watchPage(page) {
  page.on('console', (m) => {
    const text = m.text();
    const type = m.type();
    if (type !== 'error' && type !== 'warning') return;
    const entry = { type, text, url: (m.location && m.location().url) || '' };
    if (COOP_RX.test(text)) ignoredConsole.push(entry);
    else if (KNOWN_RX.test(text)) knownConsole.push(entry);
    else if (type === 'error') consoleErrors.push(entry);
    else consoleWarnings.push(entry);
  });
  page.on('pageerror', (e) => {
    const entry = { message: e.message, stack: e.stack || '' };
    if (KNOWN_RX.test(e.message)) knownConsole.push({ type: 'pageerror', ...entry });
    else if (COOP_RX.test(e.message)) ignoredConsole.push({ type: 'pageerror', ...entry });
    else pageErrors.push(entry);
  });
}

function sha256(file) {
  try {
    return createHash('sha256').update(fs.readFileSync(file)).digest('hex').slice(0, 16);
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------- geometry

const GEOMETRY_FN = () => {
  const rect = (el) => {
    if (!el) return null;
    const b = el.getBoundingClientRect();
    return { x: +b.x.toFixed(1), y: +b.y.toFixed(1), w: +b.width.toFixed(1), h: +b.height.toFixed(1), bottom: +b.bottom.toFixed(1) };
  };
  const cs = (el) => (el ? getComputedStyle(el) : null);
  const bar = document.querySelector('.rr4s-bar');
  const exit = document.getElementById('rr4sFsExit');
  const frame = document.getElementById('rr4sFrame');
  const shell = document.getElementById('rr4-shell');
  const rows = cs(shell) ? cs(shell).gridTemplateRows : '';
  const fe = document.fullscreenElement;
  return {
    viewport: { w: innerWidth, h: innerHeight, dpr: devicePixelRatio },
    fullscreen: {
      active: !!fe,
      id: fe ? (fe.id || '') : null,
      tag: fe ? fe.tagName : null,
      isShellRoot: !!fe && fe === shell,
      isDocumentElement: !!fe && fe === document.documentElement,
    },
    bar: bar ? { rect: rect(bar), display: cs(bar).display, minHeight: cs(bar).minHeight } : null,
    exit: exit ? { rect: rect(exit), display: cs(exit).display, visible: rect(exit).w > 0 && rect(exit).h > 0 } : null,
    frame: frame ? { rect: rect(frame), css: { height: cs(frame).height, width: cs(frame).width, gridRow: cs(frame).gridRow } } : null,
    shell: shell ? { rect: rect(shell), gridTemplateRows: rows, rowCount: rows ? rows.split(/\s+/).filter(Boolean).length : 0 } : null,
  };
};

async function shellGeometry(page) {
  return page.evaluate(GEOMETRY_FN);
}

function approx(a, b, tol = 2) {
  return Math.abs(Number(a) - Number(b)) <= tol;
}

function probeLabel(p) {
  if (!p) return 'none';
  return `${p.tag}${p.id ? '#' + p.id : ''}${p.cls ? '.' + String(p.cls).split(/\s+/)[0] : ''}`;
}

// ---------------------------------------------------------------- CDP listeners

let cdp = null;
async function listenerCount(client, selector, type) {
  const { result } = await client.send('Runtime.evaluate', {
    expression: `document.querySelector(${JSON.stringify(selector)})`,
  });
  if (!result || !result.objectId) return -1;
  const { listeners } = await client.send('DOMDebugger.getEventListeners', { objectId: result.objectId });
  await client.send('Runtime.releaseObject', { objectId: result.objectId }).catch(() => {});
  return (listeners || []).filter((l) => l.type === type).length;
}

// ---------------------------------------------------------------- frames

function frameByUrl(page, needle) {
  return page.frames().find((f) => {
    try {
      return f.url().includes(needle);
    } catch {
      return false;
    }
  }) || null;
}

async function waitFrame(page, needle, timeout = 20000) {
  return waitFor(`iframe url containing ${needle}`, async () => {
    const f = frameByUrl(page, needle);
    if (!f) return false;
    const ready = await f.evaluate(() => !!document.body).catch(() => false);
    return ready ? f : false;
  }, { timeout, interval: 150 });
}

const VIEW_FN = () => {
  const rect = (el) => {
    if (!el) return null;
    const b = el.getBoundingClientRect();
    return { x: +b.x.toFixed(1), y: +b.y.toFixed(1), w: +b.width.toFixed(1), h: +b.height.toFixed(1), bottom: +b.bottom.toFixed(1) };
  };
  const cs = (el) => (el ? getComputedStyle(el) : null);
  const bar = document.getElementById('play-bar');
  const foot = document.getElementById('play-foot');
  const game = document.getElementById('game');
  const stage = document.getElementById('play-stage');
  const chrome = document.getElementById('rr4-shell-chrome');
  const topEl = document.elementFromPoint(20, 10);
  const topBars = [];
  for (const el of document.querySelectorAll('header, nav, [role="banner"], [class*="header" i], [id*="header" i]')) {
    const b = el.getBoundingClientRect();
    const c = cs(el);
    if (b.height > 8 && b.top < 60 && c.display !== 'none' && c.visibility !== 'hidden') {
      topBars.push({
        tag: el.tagName,
        id: el.id || '',
        cls: typeof el.className === 'string' ? el.className.slice(0, 80) : '',
        top: +b.top.toFixed(1),
        h: +b.height.toFixed(1),
        w: +b.width.toFixed(1),
        position: c.position,
      });
    }
  }
  return {
    href: location.href,
    search: location.search,
    inner: { w: innerWidth, h: innerHeight },
    shellChrome: !!chrome,
    shellChromeCss: chrome ? chrome.textContent.slice(0, 400) : null,
    bar: bar ? { display: cs(bar).display, rect: rect(bar) } : null,
    foot: foot ? { display: cs(foot).display, rect: rect(foot) } : null,
    game: game ? { display: cs(game).display, rect: rect(game) } : null,
    stage: stage ? { display: cs(stage).display, padding: cs(stage).padding, rect: rect(stage) } : null,
    topProbe: topEl ? { tag: topEl.tagName, id: topEl.id || '', cls: typeof topEl.className === 'string' ? topEl.className.slice(0, 80) : '' } : null,
    topBars,
    doc: {
      scrollH: document.documentElement.scrollHeight,
      clientH: document.documentElement.clientHeight,
      overflow: cs(document.documentElement).overflow,
    },
  };
};

// ---------------------------------------------------------------- fullscreen helpers

async function tryFullscreen(page, expression) {
  // Puppeteer's page.evaluate sets CDP userGesture:true, and the preceding real
  // page.click() also grants transient activation, so requestFullscreen is
  // allowed in headless new mode.
  await page.evaluate(`(async () => { await ${expression}; })()`);
  await waitFor('document.fullscreenElement', () => page.evaluate(() => !!document.fullscreenElement), { timeout: 4000, interval: 100 });
  return page.evaluate(() => {
    const fe = document.fullscreenElement;
    return fe ? (fe.id || fe.tagName) : null;
  });
}

async function ensureWindowed(page, label) {
  const active = await page.evaluate(() => !!document.fullscreenElement);
  if (!active) return 'already-windowed';
  await page.evaluate(async () => {
    if (document.fullscreenElement) await document.exitFullscreen();
  }).catch(() => {});
  await waitFor(`${label}: exit fullscreen`, () => page.evaluate(() => !document.fullscreenElement), { timeout: 4000, interval: 100 });
  return 'document.exitFullscreen()';
}

// ---------------------------------------------------------------- main

const startedAt = new Date();
const t0 = Date.now();
const result = {
  run: 'test-shell-fs.mjs',
  startedAt: startedAt.toISOString(),
  base: BASE,
  chrome: { executablePath: CHROME, version: null, headless: true, protocolTimeout: 120000 },
  shellSources: {
    'enter.html': sha256('./public/enter.html'),
    'js/enter.js': sha256('./public/js/enter.js'),
    'css/enter.css': sha256('./public/css/enter.css'),
  },
  viewports: { desktop: DESKTOP, mobile: MOBILE },
  fullscreen: {
    supported: null,
    pathUsed: null,
    buttonClickEntered: null,
    buttonClickListeners: null,
    exitButtonClickListeners: null,
    escapePath: null,
    exitButtonPath: null,
    verdict: null,
    reason: null,
  },
  geometry: {
    desktopWindowed: null,
    desktopFullscreen: null,
    afterEscape: null,
    mobileWindowed: null,
    mobileFullscreen: null,
    play: null,
    multiplayer: null,
    docs: null,
    playNet: null,
  },
  checks,
  knownIssues: [],
  console: { errors: consoleErrors, pageErrors, ignored: ignoredConsole },
  screenshots: [],
  durationMs: null,
};

let browser = null;
let page = null;

try {
  browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: true,
    protocolTimeout: 120000,
    defaultViewport: DESKTOP,
    args: [
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-background-timer-throttling',
      '--disable-renderer-backgrounding',
      '--autoplay-policy=no-user-gesture-required',
      '--window-size=1440,900',
    ],
  });
  result.chrome.version = await browser.version();

  page = await browser.newPage();
  await page.setViewport({ ...DESKTOP, deviceScaleFactor: 1 });
  watchPage(page);
  cdp = await page.createCDPSession();
  await cdp.send('DOM.enable');
  await cdp.send('Runtime.enable');

  // ============================================================ A1: enter
  await page.goto(BASE + '/', { waitUntil: 'domcontentloaded', timeout: 30000 });
  await waitFor('#rr4eEnter enabled', async () => page.evaluate(() => {
    const b = document.getElementById('rr4eEnter');
    if (!b || b.disabled) return false;
    const label = b.querySelector('span');
    return !!label && /^ENTER$/i.test(label.textContent.trim());
  }), { timeout: 25000 });
  record('A1', 'ENTER gate becomes interactive after the music manifest loads', true);

  await page.click('#rr4eEnter');
  await waitFor('shell live', () => page.evaluate(() => {
    const s = document.getElementById('rr4-shell');
    return !!s && !s.hidden && document.body.classList.contains('is-live');
  }), { timeout: 10000 });
  await waitFrame(page, '/welcome', 15000);
  record('A2', 'Shell is visible and the first view (/welcome) is loaded in #rr4sFrame', true);

  // Fullscreen API + wiring evidence.
  result.fullscreen.supported = await page.evaluate(() => ({
    fullscreenEnabled: document.fullscreenEnabled,
    requestOnElement: typeof Element.prototype.requestFullscreen === 'function',
    exitOnDocument: typeof document.exitFullscreen === 'function',
    webkitElement: typeof document.webkitFullscreenElement !== 'undefined',
    userAgent: navigator.userAgent,
  }));
  result.fullscreen.buttonClickListeners = await listenerCount(cdp, '#rr4sFs', 'click');
  result.fullscreen.exitButtonClickListeners = await listenerCount(cdp, '#rr4sFsExit', 'click');
  result.fullscreen.fullscreenchangeListeners = await listenerCount(cdp, '#rr4-shell', 'fullscreenchange');

  // ============================================================ A2: windowed geometry
  const g0 = await shellGeometry(page);
  result.geometry.desktopWindowed = g0;
  const frameTopOk = g0.frame && g0.bar && approx(g0.frame.rect.y, g0.bar.rect.h, 1.5);
  const frameHeightOk = g0.frame && g0.viewport && approx(g0.frame.rect.h, g0.viewport.h - g0.bar.rect.h, 2);
  record('A3', 'Windowed shell: bar at top, iframe starts below it and fills the rest',
    !!(g0.bar && g0.bar.rect.h > 0 && frameTopOk && frameHeightOk),
    `viewport ${g0.viewport.w}x${g0.viewport.h}; bar h=${g0.bar?.rect.h}; frame ${g0.frame?.rect.w}x${g0.frame?.rect.h} at y=${g0.frame?.rect.y}`);
  await page.screenshot({ path: path.join(OUT, 'shell-fs-1440-windowed.png') });
  result.screenshots.push('_runtime/shell-fs-1440-windowed.png');

  // ============================================================ A3: fullscreen button click
  await page.click('#rr4sFs'); // real trusted click (also grants transient activation)
  await sleep(900);
  const afterClick = await page.evaluate(() => {
    const fe = document.fullscreenElement;
    return { active: !!fe, id: fe ? (fe.id || fe.tagName) : null };
  });
  result.fullscreen.buttonClickEntered = afterClick.active;
  record('A4', 'Clicking #rr4sFs enters browser fullscreen', afterClick.active,
    afterClick.active ? `fullscreenElement=#${afterClick.id}` : 'still null after a real mouse click');

  let pathUsed = afterClick.active ? 'button #rr4sFs' : null;
  let fallbackNote = '';
  if (!afterClick.active) {
    // The button exists in enter.html and the CSS ships the fullscreen UI, but
    // enter.js had no click handler at the time of the run. Prove the API and
    // the CSS path still work by entering fullscreen on the shell root from a
    // user-gesture evaluate (same target the button should use).
    try {
      const id = await tryFullscreen(page, "document.getElementById('rr4-shell').requestFullscreen()");
      pathUsed = 'page.evaluate -> #rr4-shell.requestFullscreen() (fallback; button unwired)';
      fallbackNote = `fullscreenElement=#${id}`;
    } catch (e) {
      fallbackNote = `shell-root fallback failed: ${e.message}`;
      try {
        const id = await tryFullscreen(page, 'document.documentElement.requestFullscreen()');
        pathUsed = 'page.evaluate -> documentElement.requestFullscreen() (second fallback)';
        fallbackNote += `; documentElement fallback fullscreenElement=${id}`;
      } catch (e2) {
        pathUsed = 'none';
        fallbackNote += `; documentElement fallback failed: ${e2.message}`;
      }
    }
  }
  result.fullscreen.pathUsed = pathUsed;
  record('A5', 'Fullscreen API reachable in headless Chrome and CSS transition can be exercised',
    !!pathUsed && pathUsed !== 'none', fallbackNote || 'via the real button click');

  await sleep(600);
  const gFs = await shellGeometry(page);
  result.geometry.desktopFullscreen = gFs;

  const fsIsShell = !!(gFs.fullscreen.active && (gFs.fullscreen.isShellRoot || /^HTML$/i.test(gFs.fullscreen.tag || '')));
  record('A6', 'document.fullscreenElement is the cabinet document (#rr4-shell or <html>)', fsIsShell,
    `fullscreenElement=${gFs.fullscreen.tag}${gFs.fullscreen.id ? '#' + gFs.fullscreen.id : ''}` +
    (pathUsed && pathUsed.includes('documentElement') ? ' (second fallback put <html> in fullscreen)' : ''));

  const barHidden = !!gFs.bar && gFs.bar.display === 'none' && (gFs.bar.rect.h === 0);
  record('A7', 'Fullscreen hides the shell top bar (.rr4s-bar display:none)', barHidden,
    `display=${gFs.bar?.display}; bar rect h=${gFs.bar?.rect.h}`);
  record('A8', 'Fullscreen shows the #rr4sFsExit control', !!(gFs.exit && gFs.exit.visible && gFs.exit.display !== 'none'),
    `display=${gFs.exit?.display}; rect ${gFs.exit?.rect.w}x${gFs.exit?.rect.h} at (${gFs.exit?.rect.x},${gFs.exit?.rect.y})`);
  const fsFill = gFs.frame && gFs.viewport &&
    approx(gFs.frame.rect.w, gFs.viewport.w, 2) && approx(gFs.frame.rect.h, gFs.viewport.h, 2) &&
    approx(gFs.frame.rect.y, 0, 2);
  record('A9', 'Fullscreen: iframe fills the whole viewport', !!fsFill,
    `viewport ${gFs.viewport.w}x${gFs.viewport.h}; frame ${gFs.frame?.rect.w}x${gFs.frame?.rect.h} at (${gFs.frame?.rect.x},${gFs.frame?.rect.y}); frame css height=${gFs.frame?.css.height} grid-row=${gFs.frame?.css.gridRow}; gridRows=${gFs.shell?.gridTemplateRows}`);
  result.geometry.desktopFullscreenGridRows = gFs.shell ? gFs.shell.gridTemplateRows : null;

  if (!fsFill && gFs.fullscreen.isShellRoot) {
    result.knownIssues.push({
      item: 'enter.css:465-467 fullscreen layout collapses the iframe on desktop',
      files: ['_server/public/css/enter.css:465', '_server/public/css/enter.css:467', '_server/public/css/enter.css:475'],
      note: 'With #rr4-shell itself in fullscreen, the three :fullscreen rules that go through a .rr4s descendant (:fullscreen .rr4s, :fullscreen .rr4s iframe) do not match: an element is not its own descendant. Only :fullscreen .rr4s-bar and :fullscreen .rr4s-fs-exit match, so the bar is removed but the iframe stays auto-placed in the grid\'s first "auto" row. Display:none removes the bar from grid flow, the iframe becomes the first grid item, and its height:100% resolves against an auto track, falling back to the default 150px iframe height. At <=720px the media query sets grid-row:2, which is why the 390px run passes and 1440px does not.',
      detail: { viewport: gFs.viewport, frame: gFs.frame?.rect, frameCss: gFs.frame?.css, gridRows: gFs.shell?.gridTemplateRows },
    });
  }

  await page.screenshot({ path: path.join(OUT, 'shell-fs-1440.png') });
  result.screenshots.push('_runtime/shell-fs-1440.png');

  // ============================================================ A4: Escape
  await page.keyboard.press('Escape');
  await sleep(900);
  let escActive = await page.evaluate(() => !!document.fullscreenElement);
  let escapePath = escActive ? null : 'Escape key';
  if (escActive) {
    await page.evaluate(async () => {
      if (document.fullscreenElement) await document.exitFullscreen();
    }).catch(() => {});
    await waitFor('exit after Escape fallback', () => page.evaluate(() => !document.fullscreenElement), { timeout: 4000 });
    escapePath = 'document.exitFullscreen() fallback (Escape did not reach the browser UI in headless)';
  }
  result.fullscreen.escapePath = escapePath;
  result.fullscreen.escapeVerdict = escActive ? 'headless-limited' : 'verified';
  const gEsc = await shellGeometry(page);
  result.geometry.afterEscape = gEsc;
  record('A10', 'Escape (or exitFullscreen fallback when headless swallows Esc) exits fullscreen and the shell bar returns',
    !gEsc.fullscreen.active && !!gEsc.bar && gEsc.bar.display !== 'none' && gEsc.bar.rect.h > 0,
    `${escapePath}; bar display=${gEsc.bar?.display} h=${gEsc.bar?.rect.h}; frame y=${gEsc.frame?.rect.y}; verdict=${result.fullscreen.escapeVerdict}`);

  // Diagnostic: what the same CSS does when <html> is the fullscreen element
  // (the target the current :fullscreen rules actually expect).
  let htmlTargetFs = false;
  try {
    await tryFullscreen(page, 'document.documentElement.requestFullscreen()');
    htmlTargetFs = true;
  } catch (e) {
    record('A9b', 'Diagnostic: fullscreen on <html> keeps the iframe at full viewport height', false, e.message);
  }
  if (htmlTargetFs) {
    await sleep(500);
    const gFsDoc = await shellGeometry(page);
    result.geometry.desktopFullscreenDocumentElement = gFsDoc;
    const docFill = gFsDoc.frame && approx(gFsDoc.frame.rect.w, gFsDoc.viewport.w, 2) &&
      approx(gFsDoc.frame.rect.h, gFsDoc.viewport.h, 2) && approx(gFsDoc.frame.rect.y, 0, 2);
    record('A9b', 'Diagnostic: fullscreen on <html> keeps the iframe at full viewport height', !!docFill,
      `fullscreenElement=${gFsDoc.fullscreen.tag}; frame ${gFsDoc.frame?.rect.w}x${gFsDoc.frame?.rect.h} at y=${gFsDoc.frame?.rect.y}; gridRows=${gFsDoc.shell?.gridTemplateRows}`);
    await page.screenshot({ path: path.join(OUT, 'shell-fs-1440-html-target.png') });
    result.screenshots.push('_runtime/shell-fs-1440-html-target.png');
    await ensureWindowed(page, 'A9b cleanup');
  }

  // ============================================================ A5: exit control click
  try {
    await tryFullscreen(page, "document.getElementById('rr4-shell').requestFullscreen()");
    await sleep(350);
    await page.click('#rr4sFsExit');
    await sleep(800);
    const exitClickActive = await page.evaluate(() => !!document.fullscreenElement);
    result.fullscreen.exitButtonPath = exitClickActive ? 'click ignored (still fullscreen)' : 'click exited fullscreen';
    record('A11', 'Clicking #rr4sFsExit leaves fullscreen', !exitClickActive,
      exitClickActive ? 'still fullscreen after a real click (button unwired)' : 'exited');
    if (exitClickActive) await ensureWindowed(page, 'A11 cleanup');
  } catch (e) {
    result.fullscreen.exitButtonPath = `error: ${e.message}`;
    record('A11', 'Clicking #rr4sFsExit leaves fullscreen', false, e.message);
    await ensureWindowed(page, 'A11 cleanup');
  }

  // ============================================================ A6: mobile
  await page.setViewport({ ...MOBILE, deviceScaleFactor: 2 });
  await sleep(500);
  const gM0 = await shellGeometry(page);
  result.geometry.mobileWindowed = gM0;
  const mobileBarOk = !!gM0.bar && gM0.bar.rect.h > 0;
  await page.screenshot({ path: path.join(OUT, 'shell-fs-390-windowed.png') });
  result.screenshots.push('_runtime/shell-fs-390-windowed.png');

  let mobilePath = null;
  await page.click('#rr4sFs');
  await sleep(900);
  let mobileActive = await page.evaluate(() => !!document.fullscreenElement);
  if (mobileActive) mobilePath = 'button #rr4sFs';
  else {
    try {
      await tryFullscreen(page, "document.getElementById('rr4-shell').requestFullscreen()");
      mobilePath = 'shell.requestFullscreen() fallback';
      mobileActive = true;
    } catch (e) {
      mobilePath = `none (${e.message})`;
    }
  }
  await sleep(500);
  const gMs = await shellGeometry(page);
  result.geometry.mobileFullscreen = gMs;
  const mobileFill = gMs.frame && gMs.viewport &&
    approx(gMs.frame.rect.w, gMs.viewport.w, 2) && approx(gMs.frame.rect.h, gMs.viewport.h, 2);
  record('A12', 'Mobile 390x844: fullscreen hides the bar and the iframe fills the viewport',
    !!mobileActive && mobileBarOk && gMs.bar?.display === 'none' && !!mobileFill,
    `path=${mobilePath}; viewport ${gMs.viewport.w}x${gMs.viewport.h}; bar display=${gMs.bar?.display}; frame ${gMs.frame?.rect.w}x${gMs.frame?.rect.h} at y=${gMs.frame?.rect.y}`);
  await page.screenshot({ path: path.join(OUT, 'shell-fs-390.png') });
  result.screenshots.push('_runtime/shell-fs-390.png');

  await page.keyboard.press('Escape');
  await sleep(600);
  if (await page.evaluate(() => !!document.fullscreenElement)) {
    await page.evaluate(async () => {
      if (document.fullscreenElement) await document.exitFullscreen();
    }).catch(() => {});
    await sleep(300);
  }

  // Back to desktop for the fill checks.
  await page.setViewport({ ...DESKTOP, deviceScaleFactor: 1 });
  await sleep(400);

  // ============================================================ B1: /play embedded
  await page.click('.rr4s-nav [data-view="play"]');
  const playFrame = await waitFrame(page, '/play?', 25000);
  await waitFor('/play shell chrome injected', () => playFrame.evaluate(() => !!document.getElementById('rr4-shell-chrome')).catch(() => false), { timeout: 20000 });
  await waitFor('#play-bar present', () => playFrame.evaluate(() => !!document.getElementById('play-bar')).catch(() => false), { timeout: 30000 });
  const playView = await playFrame.evaluate(VIEW_FN);
  result.geometry.play = playView;

  const playUrlOk = /\/play\?/.test(playView.href) && /embedded=1/.test(playView.search) && /threads=0/.test(playView.search);
  record('B1', '/play embedded via the shell carries embedded=1 and threads=0', playUrlOk, playView.href);
  record('B2', 'Embedded /play hides #play-bar', playView.bar?.display === 'none',
    `display=${playView.bar?.display}`);
  record('B3', 'Embedded /play hides #play-foot', playView.foot?.display === 'none',
    `display=${playView.foot?.display}`);
  const playFill = playView.game && playView.inner &&
    approx(playView.game.rect.w, playView.inner.w, 2) && approx(playView.game.rect.h, playView.inner.h, 2) &&
    approx(playView.game.rect.y, 0, 2);
  const stageFill = playView.stage && approx(playView.stage.rect.h, playView.inner.h, 2);
  record('B4', 'Embedded /play: #game (and #play-stage) fill the iframe', !!playFill && !!stageFill,
    `iframe ${playView.inner.w}x${playView.inner.h}; #game ${playView.game?.rect.w}x${playView.game?.rect.h} at y=${playView.game?.rect.y}; #play-stage h=${playView.stage?.rect.h}; padding=${playView.stage?.padding}`);

  const shellBarPlay = await shellGeometry(page);
  const oneBarPlay = shellBarPlay.bar && playView.game &&
    approx((await page.evaluate(() => document.getElementById('rr4sFrame').getBoundingClientRect().top)), shellBarPlay.bar.rect.h, 1.5);
  record('B5', 'Embedded /play: the shell bar is the only top bar and the iframe starts below it', !!oneBarPlay,
    `shell bar h=${shellBarPlay.bar?.rect.h}; frame y=${(await page.evaluate(() => document.getElementById('rr4sFrame').getBoundingClientRect().top))}; shell bar rect y=${shellBarPlay.bar?.rect.y}`);

  // The parent ENTER gesture already unlocked audio; embedded /play must not
  // stack a second CLICK TO RACE gate on top of the game.
  await waitFor('/play core start', () => playFrame.evaluate(() =>
    !!(window.__R4 && window.__R4.startedAt)).catch(() => false), { timeout: 45000 }).catch(() => null);
  await sleep(2200);
  const embeddedState = await playFrame.evaluate(() => {
    const g = document.getElementById('soundGate');
    return {
      embedded: !!(window.__R4 && window.__R4.embedded),
      coreStarted: !!(window.__R4 && window.__R4.startedAt),
      gateHidden: !g || g.hidden || getComputedStyle(g).display === 'none',
      gateDisplay: g ? getComputedStyle(g).display : 'missing',
    };
  });
  record('B13', 'Embedded /play skips the second CLICK TO RACE gate',
    embeddedState.embedded === true && embeddedState.gateHidden === true,
    JSON.stringify(embeddedState));

  const shellStatePlay = await page.evaluate(() => window.RR4Shell.getState());
  record('A13', 'Soundtrack ducks while a /play* view is active',
    shellStatePlay.ducked === true && shellStatePlay.effectiveVolume < shellStatePlay.volume,
    `ducked=${shellStatePlay.ducked} volume=${shellStatePlay.volume} effective=${shellStatePlay.effectiveVolume}`);
  await page.screenshot({ path: path.join(OUT, 'shell-fs-play.png') });
  result.screenshots.push('_runtime/shell-fs-play.png');

  // ============================================================ B2: /multiplayer
  await page.click('.rr4s-nav [data-view="multiplayer"]');
  const mpFrame = await waitFrame(page, '/multiplayer', 20000);
  await waitFor('multiplayer body', () => mpFrame.evaluate(() => !!document.body && document.readyState !== 'loading').catch(() => false), { timeout: 15000 });
  await sleep(400);
  const mpView = await mpFrame.evaluate(VIEW_FN);
  result.geometry.multiplayer = mpView;
  record('B6', '/multiplayer embedded via the shell carries embedded=1', /embedded=1/.test(mpView.search), mpView.href);
  const mpShellGeom = await shellGeometry(page);
  const mpFrameTop = await page.evaluate(() => document.getElementById('rr4sFrame').getBoundingClientRect().top);
  const mpOneBar = !!mpShellGeom.bar && mpShellGeom.bar.rect.h > 0 && approx(mpFrameTop, mpShellGeom.bar.rect.h, 1.5);
  const mpTopBars = mpView.topBars.filter((b) => b.position === 'fixed' || b.position === 'sticky');
  record('B7', 'Embedded /multiplayer: only the shell top bar at the top of the viewport',
    mpOneBar && mpTopBars.length === 0,
    `shell bar h=${mpShellGeom.bar?.rect.h}; frame y=${mpFrameTop.toFixed(1)}; fixed/sticky top bars inside frame=${JSON.stringify(mpTopBars)}; top element=${probeLabel(mpView.topProbe)}`);

  const shellStateMp = await page.evaluate(() => window.RR4Shell.getState());
  record('B14', 'Soundtrack returns to full level outside /play*',
    shellStateMp.ducked === false && Math.abs(shellStateMp.effectiveVolume - shellStateMp.volume) < 0.001,
    `view=${shellStateMp.view} ducked=${shellStateMp.ducked} volume=${shellStateMp.volume} effective=${shellStateMp.effectiveVolume}`);
  await page.screenshot({ path: path.join(OUT, 'shell-fs-multiplayer.png') });
  result.screenshots.push('_runtime/shell-fs-multiplayer.png');

  // ============================================================ B3: /docs
  await page.click('.rr4s-nav [data-view="docs"]');
  const docsFrame = await waitFrame(page, '/docs/', 25000);
  await waitFor('docs body', () => docsFrame.evaluate(() => !!document.body && document.readyState !== 'loading').catch(() => false), { timeout: 25000 });
  await sleep(1200);
  const docsView = await docsFrame.evaluate(VIEW_FN);
  result.geometry.docs = docsView;
  const docsEmbedParam = /embedded=1/.test(docsView.search);
  record('B8', 'Embedded /docs carries embedded=1', docsEmbedParam, docsView.href);
  // A second top bar is a sticky/fixed strip near the top, not a full-height
  // layout container that happens to use position:sticky (Zudoku's grid/sidebar).
  const docsTopBars = docsView.topBars.filter((b) => (b.position === 'fixed' || b.position === 'sticky') && b.h > 0 && b.h < 200 && b.top < 60);
  const docsHasSecondBar = docsTopBars.length > 0;
  record('B9', 'Embedded /docs: no second (docs) top bar at the top of the viewport', !docsHasSecondBar,
    docsHasSecondBar
      ? `docs renders its own ${docsTopBars.map((b) => `${b.tag}#${b.id || b.cls.split(/\s+/)[0] || ''}(${b.position},h=${b.h})`).join(', ')}`
      : `top element=${probeLabel(docsView.topProbe)}; header hidden by #rr4-shell-docs`);

  // F must work while the frame owns the focus, not only on the shell chrome.
  let iframeFs = false;
  try {
    await docsFrame.focus('body');
    await page.keyboard.press('f');
    await sleep(800);
    iframeFs = await page.evaluate(() => !!document.fullscreenElement);
  } catch { /* ignore */ }
  const iframeFsEl = await page.evaluate(() => {
    const e = document.fullscreenElement;
    return e ? (e.id || e.tagName) : 'null';
  });
  record('A14', 'F pressed inside the iframe toggles shell fullscreen', iframeFs,
    `fullscreenElement=${iframeFsEl}`);
  if (iframeFs) {
    await page.keyboard.press('Escape');
    await sleep(500);
    if (await page.evaluate(() => !!document.fullscreenElement)) {
      await page.evaluate(async () => { if (document.fullscreenElement) await document.exitFullscreen(); }).catch(() => {});
      await sleep(300);
    }
  }
  if (docsHasSecondBar) {
    result.knownIssues.push({
      item: 'HANDOFF P1 #3',
      note: 'docs renders its own header/nav inside the shell iframe; only the /play* view has #play-bar hidden by the injected #rr4-shell-chrome style',
      detail: docsTopBars,
    });
  }
  await page.screenshot({ path: path.join(OUT, 'shell-fs-docs.png') });
  result.screenshots.push('_runtime/shell-fs-docs.png');

  // ============================================================ B4: synthetic /play-net
  const netUrl = '/play-net?embedded=1&threads=0';
  await page.evaluate((src) => {
    document.getElementById('rr4sFrame').src = src;
  }, netUrl);
  const netFrame = await waitFrame(page, '/play-net', 25000);
  await waitFor('/play-net shell chrome injected', () => netFrame.evaluate(() => !!document.getElementById('rr4-shell-chrome')).catch(() => false), { timeout: 25000 });
  await waitFor('#play-bar present (net)', () => netFrame.evaluate(() => !!document.getElementById('play-bar')).catch(() => false), { timeout: 30000 });
  const netView = await netFrame.evaluate(VIEW_FN);
  result.geometry.playNet = netView;
  record('B10', 'Synthetic embedded /play-net?embedded=1&threads=0 hides #play-bar and #play-foot',
    netView.bar?.display === 'none' && netView.foot?.display === 'none',
    `#play-bar display=${netView.bar?.display}; #play-foot display=${netView.foot?.display}; iframe ${netView.inner.w}x${netView.inner.h}; #game ${netView.game?.rect.w}x${netView.game?.rect.h} (geometry early, core not awaited)`);
  record('B11', 'Embedded /play-net: #game/#play-stage fill the iframe (early geometry, core not awaited)',
    !!netView.game && approx(netView.game.rect.w, netView.inner.w, 2) && approx(netView.game.rect.h, netView.inner.h, 2),
    `#game ${netView.game?.rect.w}x${netView.game?.rect.h}; #play-stage ${netView.stage?.rect.w}x${netView.stage?.rect.h} padding=${netView.stage?.padding}`);
  await page.screenshot({ path: path.join(OUT, 'shell-fs-play-net.png') });
  result.screenshots.push('_runtime/shell-fs-play-net.png');

  const netShell = await shellGeometry(page);
  const netFrameTop = await page.evaluate(() => document.getElementById('rr4sFrame').getBoundingClientRect().top);
  record('B12', 'Embedded /play-net: shell bar is the only top bar and the iframe starts below it',
    !!netShell.bar && netShell.bar.rect.h > 0 && approx(netFrameTop, netShell.bar.rect.h, 1.5),
    `shell bar h=${netShell.bar?.rect.h}; frame y=${netFrameTop.toFixed(1)}`);

  // ============================================================ app bug evidence
  const unwired = [];
  if (result.fullscreen.buttonClickListeners === 0) {
    unwired.push('enter.html:63 #rr4sFs has 0 click listeners (enter.js never binds it)');
  }
  if (result.fullscreen.exitButtonClickListeners === 0) {
    unwired.push('enter.html:66 #rr4sFsExit has 0 click listeners (enter.js never binds it)');
  }
  if (unwired.length) {
    result.knownIssues.push({
      item: 'HANDOFF P1 #1 - fullscreen shell button is styled but unwired',
      files: ['_server/public/enter.html:63', '_server/public/enter.html:66', '_server/public/js/enter.js', '_server/public/css/enter.css:449-468'],
      note: 'enter.html ships both buttons and enter.css ships the :fullscreen rules, but enter.js has no requestFullscreen/exitFullscreen/fullscreenchange code; a real click on #rr4sFs or #rr4sFsExit does nothing.',
      detail: unwired,
    });
  }

  // ============================================================ errors
  const errorCount = consoleErrors.length + pageErrors.length;
  record('E1', 'No unexpected console/page errors (COOP/ICE warnings and the known docs React #418 ignored)', errorCount === 0,
    `${consoleErrors.length} console error, ${pageErrors.length} pageerror; ignored: ${ignoredConsole.length} COOP/ICE, ${knownConsole.length} known React #418; ${consoleWarnings.length} other warnings`);

  // ============================================================ verdict
  const fsVerifiedByButton = result.fullscreen.buttonClickEntered === true;
  const fsVerifiedByFallback = !!pathUsed && pathUsed !== 'none';
  if (fsVerifiedByButton) {
    result.fullscreen.verdict = 'verified';
    result.fullscreen.reason = 'A real click on #rr4sFs entered fullscreen and the CSS/UI transition was measured.';
  } else if (fsVerifiedByFallback && result.fullscreen.buttonClickListeners === 0) {
    result.fullscreen.verdict = 'app-unwired; API+CSS verified via fallback';
    result.fullscreen.reason = 'Headless Chrome supports the Fullscreen API (a user-gesture evaluate entered fullscreen on #rr4-shell and the bar/iframe transition matched the CSS), but a real click on #rr4sFs did nothing because enter.js binds no handler. This is not a headless limit.';
  } else if (fsVerifiedByFallback) {
    result.fullscreen.verdict = 'headless-limited';
    result.fullscreen.reason = 'The button has a handler, but headless did not honour the click; the CSS/UI transition was verified through a user-gesture requestFullscreen fallback.';
  } else {
    result.fullscreen.verdict = 'unverified';
    result.fullscreen.reason = 'Neither the button nor the fallback entered fullscreen.';
  }
} catch (err) {
  record('X1', 'Harness completed without throwing', false, err && err.stack ? err.stack.split('\n').slice(0, 3).join(' | ') : String(err));
} finally {
  result.durationMs = Date.now() - t0;
  result.checks = checks;
  result.console = { errors: consoleErrors, warnings: consoleWarnings, pageErrors, ignored: ignoredConsole, known: knownConsole };
  // B8/B9 were the old /docs second-bar gap; the shell now loads the manual as
  // /docs/introduction?embedded=1 and injects #rr4-shell-docs to hide the header.
  const KNOWN_CHECKS = {};
  for (const c of checks) if (KNOWN_CHECKS[c.id]) c.known = KNOWN_CHECKS[c.id];
  const failed = checks.filter((c) => !c.pass);
  const knownFailed = failed.filter((c) => c.known);
  const unexpectedFailed = failed.filter((c) => !c.known);
  result.summary = {
    total: checks.length,
    passed: checks.length - failed.length,
    failed: failed.length,
    failedIds: failed.map((c) => c.id),
    knownFailedIds: knownFailed.map((c) => c.id),
    unexpectedFailedIds: unexpectedFailed.map((c) => c.id),
    fullscreenVerdict: result.fullscreen.verdict,
  };

  const jsonPath = path.join(OUT, 'shell-fs.json');
  fs.writeFileSync(jsonPath, JSON.stringify(result, null, 2));

  const lines = [];
  lines.push('R4 shell fullscreen + one-top-bar evidence');
  lines.push(`run:      ${result.startedAt}  (${result.durationMs} ms)`);
  lines.push(`base:     ${BASE}`);
  lines.push(`chrome:   ${result.chrome.version}  headless=${result.chrome.headless}  ${CHROME}`);
  lines.push(`result:   ${result.summary.passed}/${result.summary.total} checks passed${failed.length ? '  FAILED: ' + failed.map((c) => c.id).join(', ') : ''}`);
  if (knownFailed.length || unexpectedFailed.length) {
    lines.push(`          unexpected FAIL: ${unexpectedFailed.length ? unexpectedFailed.map((c) => c.id).join(', ') : 'none'}`);
    lines.push(`          known FAIL:      ${knownFailed.length ? knownFailed.map((c) => c.id).join(', ') : 'none'}`);
  }
  lines.push(`fullscreen: ${result.fullscreen.verdict}`);
  lines.push(`  path:     ${result.fullscreen.pathUsed}`);
  lines.push(`  button:   click entered=${result.fullscreen.buttonClickEntered}  click listeners=${result.fullscreen.buttonClickListeners}  exit listeners=${result.fullscreen.exitButtonClickListeners}`);
  lines.push(`  escape:   ${result.fullscreen.escapePath}   verdict=${result.fullscreen.escapeVerdict}   exit-button: ${result.fullscreen.exitButtonPath}`);
  lines.push(`  verdict:  ${result.fullscreen.verdict}`);
  lines.push(`  reason:   ${result.fullscreen.reason}`);
  lines.push('');
  lines.push('geometry');
  const g = result.geometry;
  const fmt = (label, s) => {
    if (!s) return lines.push(`  ${label}: not recorded`);
    lines.push(`  ${label}: viewport=${s.viewport.w}x${s.viewport.h} bar=${s.bar ? `${s.bar.display} h=${s.bar.rect.h}` : 'n/a'} frame=${s.frame ? `${s.frame.rect.w}x${s.frame.rect.h}@y${s.frame.rect.y}` : 'n/a'} fs=${s.fullscreen.active ? (s.fullscreen.id || s.fullscreen.tag) : 'no'}`);
  };
  fmt('desktop windowed ', g.desktopWindowed);
  fmt('desktop fullscreen', g.desktopFullscreen);
  fmt('fullscreen <html> ', g.desktopFullscreenDocumentElement);
  fmt('after Escape     ', g.afterEscape);
  fmt('mobile windowed  ', g.mobileWindowed);
  fmt('mobile fullscreen', g.mobileFullscreen);
  if (g.play) lines.push(`  /play embedded   : iframe=${g.play.inner.w}x${g.play.inner.h} #game=${g.play.game?.rect.w}x${g.play.game?.rect.h} #play-bar=${g.play.bar?.display} #play-foot=${g.play.foot?.display} shellChrome=${g.play.shellChrome}`);
  if (g.multiplayer) lines.push(`  /multiplayer     : iframe=${g.multiplayer.inner.w}x${g.multiplayer.inner.h} search="${g.multiplayer.search}" fixed/sticky top bars=${g.multiplayer.topBars.filter((b) => b.position === 'fixed' || b.position === 'sticky').length}`);
  if (g.docs) lines.push(`  /docs            : iframe=${g.docs.inner.w}x${g.docs.inner.h} search="${g.docs.search}" second top bar=${g.docs.topBars.some((b) => b.position === 'fixed' || b.position === 'sticky')}`);
  if (g.playNet) lines.push(`  /play-net        : iframe=${g.playNet.inner.w}x${g.playNet.inner.h} #play-bar=${g.playNet.bar?.display} #play-foot=${g.playNet.foot?.display} #game=${g.playNet.game?.rect.w}x${g.playNet.game?.rect.h} shellChrome=${g.playNet.shellChrome}`);
  lines.push('');
  lines.push('checks');
  for (const c of checks) lines.push(`  ${c.pass ? 'PASS' : 'FAIL'}  ${c.id}  ${c.name}${c.detail ? '  -- ' + c.detail : ''}`);
  lines.push('');
  lines.push(`console: ${consoleErrors.length} error, ${pageErrors.length} pageerror, ${consoleWarnings.length} other warning, ${ignoredConsole.length} ignored (COOP / ICE), ${knownConsole.length} known (React #418)`);
  for (const e of consoleErrors.slice(0, 12)) lines.push(`  [${e.type}] ${e.text}`);
  for (const e of pageErrors.slice(0, 12)) lines.push(`  [pageerror] ${e.message}`);
  for (const e of consoleWarnings.slice(0, 6)) lines.push(`  [warning] ${e.text}`);
  if (result.knownIssues.length) {
    lines.push('');
    lines.push('known issues / app bugs');
    for (const k of result.knownIssues) lines.push(`  - ${k.item}: ${k.note}`);
  }
  lines.push('');
  lines.push(`screenshots: ${result.screenshots.join(', ')}`);
  const log = lines.join('\n');
  fs.writeFileSync(path.join(OUT, 'shell-fs.log'), log);
  console.log('\n' + log);

  if (page) await page.close().catch(() => {});
  if (browser) await browser.close().catch(() => {});
}
