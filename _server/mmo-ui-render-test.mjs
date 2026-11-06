// Race Day UI — synthetic-render evidence for public/js/mmo-ui.js.
//
// Drives Brave via puppeteer-core against the already-running cabinet on :8080
// (never starts or stops a server). Injects synthetic /mmo frames through
// window.__R4_MMO.client._debug.inject so the real client store is exercised,
// then asserts the rendered DOM and writes 3 screenshots.
//
// Transport: the page's own WebSocket is replaced by a stub that opens and then
// stays silent (page.evaluateOnNewDocument). A live /mmo would (a) already own
// seq 1..9, so the injected fixtures answered 'stale' — 7/26 — and (b) keep
// repainting a real race over whatever the fixture drew. With the stub the real
// client store starts empty and the fixtures are its only writer; every
// injection takes the next seq from the client's own counter.
//
// Run: node mmo-ui-render-test.mjs          (MMO_DEBUG=1 prints each injection)
// Writes: _runtime/mmo-ui-render.json, _runtime/mmo-ui.log,
//         _runtime/mmo-ui-grid.png, _runtime/mmo-ui-countdown.png,
//         _runtime/mmo-ui-results.png

import puppeteer from 'puppeteer-core';
import fs from 'node:fs';
import path from 'node:path';

const BRAVE = 'C:/Program Files/BraveSoftware/Brave-Browser/Application/brave.exe';
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const BASE = 'http://127.0.0.1:8080';
const OUT = path.resolve('../_runtime');
const URL_UNDER_TEST = `${BASE}/mmo.html`;

fs.mkdirSync(OUT, { recursive: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const logLines = [];

function record(id, name, pass, detail = '', extra) {
  const entry = { id, name, pass: !!pass, detail: String(detail || '') };
  if (extra !== undefined) entry.extra = extra;
  results.push(entry);
  const line = `${pass ? 'PASS' : 'FAIL'}  ${id}  ${name}${detail ? '  -- ' + detail : ''}`;
  logLines.push(line);
  console.log(line);
  return entry;
}

const IGNORE_CONSOLE = [
  /Failed to load resource/i,
  /WebSocket connection to/i,
  /net::ERR_/i,
  /favicon/i,
  /No ICE servers/i,
  /\/js\/mmo-lfg\.js/i,
  /\/css\/mmo(-lfg)?\.css/i,
];

const consoleErrors = [];
const pageErrors = [];

/* Build the synthetic frames once (the same objects are injected in order). */
function buildFrames() {
  const now = Date.now();
  const teams = ['Solvalou', 'Pac Racing Club', 'Micro Mouse Mappy', 'Dig Racing Team'];
  const seats = [];
  for (let seat = 1; seat <= 50; seat += 1) {
    if (seat > 37) {
      seats.push({ seat, team: teams[seat % 4], name: '', driverId: '', bot: false, state: 'empty', connected: true });
      continue;
    }
    const mine = seat === 7;
    const bot = !mine && seat % 5 === 0;
    seats.push({
      seat,
      name: mine ? 'PLAYER 07' : (bot ? `BOT-${String(seat).padStart(2, '0')}` : `DRIVER-${String(seat).padStart(2, '0')}`),
      team: mine ? 'Pac Racing Club' : teams[seat % 4],
      driverId: mine ? 'drv-you' : (bot ? `bot-${seat}` : `drv-${seat}`),
      bot,
      state: seat === 2 ? 'finished' : 'seated',
      connected: seat === 9 ? false : true,
    });
  }

  const standingsRows = [];
  for (let pos = 1; pos <= 10; pos += 1) {
    const seat = pos;
    const lapDown = pos === 6;
    standingsRows.push({
      seat,
      name: pos === 7 ? 'PLAYER 07' : `DRIVER-${String(seat).padStart(2, '0')}`,
      team: teams[seat % 4],
      lap: lapDown ? 1 : 2,
      raceTimeMs: pos === 7 ? 41200 : 40400 + pos * 700,
      gapMs: lapDown ? null : (pos === 1 ? null : 800 + (pos - 2) * 120),
      gapLap: lapDown,
      position: pos,
      bot: seat % 5 === 0,
      state: 'racing',
    });
  }
  // Partner row beyond the top 10 so the board stays keyed by seat.
  standingsRows.push({
    seat: 11, name: 'NEIGHBOUR', team: teams[3], lap: 1, raceTimeMs: 38000,
    gapMs: null, gapLap: true, position: 11, bot: false, state: 'racing',
  });

  const resultRows = [];
  for (let pos = 1; pos <= 50; pos += 1) {
    const seat = pos;
    resultRows.push({
      seat,
      name: pos === 7 ? 'PLAYER 07' : `DRIVER-${String(seat).padStart(2, '0')}`,
      team: teams[seat % 4],
      position: pos,
      raceTimeMs: pos === 7 ? 241200 : 238000 + pos * 1450,
      bestLapMs: pos === 7 ? 39800 : 39900 + pos * 60,
      gapMs: pos === 1 ? null : (pos - 1) * 1450,
      bot: seat % 5 === 0,
      state: 'finished',
    });
  }

  return [
    { type: 'welcome', seq: 1, driverId: 'drv-you', you: { seat: 7, team: 'Pac Racing Club', name: 'PLAYER 07' }, state: 'grid', event: { id: 'ev12', index: 12, state: 'grid', plan: { trackIndex: 4, trackName: 'Phantomile', carClass: 'D4' } }, max: 50, min: 4, bots: true },
    { type: 'grid', seq: 2, seats, counts: { seated: 37, queued: 0, max: 50 } },
    { type: 'countdown', seq: 3, n: 3, startsAt: now + 3000 },
    { type: 'event', seq: 4, id: 'ev12', index: 12, state: 'racing', plan: { trackIndex: 4, trackName: 'Phantomile', carClass: 'D4' }, counts: { seated: 37, queued: 0, max: 50 } },
    { type: 'standings', seq: 5, rows: standingsRows, you: { position: 7, gapMs: 800, gapLap: false }, lap: 2, top: 50 },
    { type: 'feed', seq: 6, at: now - 8000, text: 'P3 — Solvalou took the lead' },
    { type: 'feed', seq: 7, at: now - 3000, text: 'PLAYER 07 set 0:39.8' },
    { type: 'feed', seq: 8, at: now - 3000, text: 'PLAYER 07 set 0:39.8' },
    { type: 'result', seq: 9, rows: resultRows, you: { position: 7, raceTimeMs: 241200 }, finishedAt: now },
  ];
}

/* ---------- transport stub + injection helper --------------------------- */

/** Replace the page's WebSocket with one that opens and then stays silent. */
const STUB_SOCKET = () => {
  class StubSocket extends EventTarget {
    constructor(url) {
      super();
      this.url = String(url);
      this.readyState = 0; // CONNECTING
      this.binaryType = 'blob';
      setTimeout(() => {
        if (this.readyState !== 0) return;
        this.readyState = 1; // OPEN: the page settles on a live-looking chip
        this.dispatchEvent(new Event('open'));
      }, 0);
    }
    send() { /* the server is never on the other end */ }
    close() {
      if (this.readyState === 3) return;
      this.readyState = 3;
      this.dispatchEvent(new Event('close'));
    }
  }
  window.WebSocket = StubSocket;
  window.__R4_MMO_STUB_WS = true;
};

/** Inject fixtures with the client's own next seq, so none answers 'stale'.
 *  The client does not commit every frame (a duplicate feed line returns before
 *  `patch.seq` lands), so the counter is kept here and only floored by the
 *  store's own seq — otherwise the second duplicate poisons every later inject. */
const injectFixtures = (items) => {
  const client = window.__R4_MMO.client;
  const ui = window.__R4_MMO_UI.ui;
  if (!Number.isFinite(window.__R4_MMO_TEST_SEQ)) window.__R4_MMO_TEST_SEQ = 0;
  const applied = [];
  for (const frame of items) {
    window.__R4_MMO_TEST_SEQ = Math.max(window.__R4_MMO_TEST_SEQ, client.state.seq || 0) + 1;
    applied.push(client._debug.inject({ ...frame, seq: window.__R4_MMO_TEST_SEQ }));
  }
  ui.flush();
  return { seq: window.__R4_MMO_TEST_SEQ, storeSeq: client.state.seq, applied };
};

async function inject(page, items) {
  const out = await page.evaluate(injectFixtures, items);
  if (process.env.MMO_DEBUG) console.log('[inject]', JSON.stringify(out.applied), 'seq=', out.seq, items.map((f) => f.type).join(','));
  return out;
}

/* ---------- DOM probes (run inside the page) ---------------------------- */

const PROBE_EMPTY = () => {
  const text = (sel) => {
    const el = document.querySelector(sel);
    return el ? el.textContent.replace(/\s+/g, ' ').trim() : null;
  };
  return {
    slots: document.querySelectorAll('#mmoGrid [data-seat]').length,
    gridCount: text('#mmoGridCount'),
    track: text('[data-mmo-track]'),
    state: text('#mmoState'),
    conn: text('#mmoConn'),
    open: Array.from(document.querySelectorAll('#mmoGrid [data-seat]')).filter((el) => (el.querySelector('.mmo-slot-name') || {}).textContent === 'OPEN').length,
  };
};

const PROBE_GRID = () => {
  const slots = Array.from(document.querySelectorAll('#mmoGrid [data-seat]'));
  const bySeat = (n) => slots.find((el) => Number(el.dataset.seat) === n) || null;
  const you = bySeat(7);
  const bot = slots.find((el) => el.dataset.bot === '1') || null;
  const offline = slots.find((el) => el.dataset.offline === '1') || null;
  const finished = slots.find((el) => el.dataset.finished === '1') || null;
  const pick = (el) => el ? {
    state: el.dataset.state,
    team: el.dataset.team,
    name: (el.querySelector('.mmo-slot-name') || {}).textContent || '',
    meta: (el.querySelector('.mmo-slot-meta') || {}).textContent || '',
    aria: el.getAttribute('aria-label') || '',
    tabindex: el.getAttribute('tabindex'),
  } : null;
  return {
    slots: slots.length,
    you: pick(you),
    bot: pick(bot),
    offline: pick(offline),
    finished: pick(finished),
    empty: pick(bySeat(50)),
    tabStops: slots.filter((el) => el.getAttribute('tabindex') === '0').length,
    minusOne: slots.filter((el) => el.getAttribute('tabindex') === '-1').length,
    gridAria: (document.getElementById('mmoGrid') || {}).getAttribute
      ? document.getElementById('mmoGrid').getAttribute('aria-label') : '',
    gridCount: (document.querySelector('#mmoGridCount') || {}).textContent || '',
    eventNum: (document.querySelector('[data-mmo-event-num]') || {}).textContent || '',
    state: (document.querySelector('#mmoState') || {}).textContent || '',
    stateAttr: (document.querySelector('#mmoState') || {}).getAttribute('data-state'),
    conn: (document.querySelector('#mmoConn') || {}).textContent || '',
    connAttr: (document.querySelector('#mmoConn') || {}).getAttribute('data-conn'),
    connLink: (document.querySelector('#mmoConn') || {}).getAttribute('data-link'),
    connDot: !!document.querySelector('#mmoConn i'),
    track: (document.querySelector('[data-mmo-track]') || {}).textContent || '',
    car: (document.querySelector('[data-mmo-car]') || {}).textContent || '',
    seat: (document.querySelector('[data-mmo-seat]') || {}).textContent || '',
    team: (document.querySelector('#mmoTeam') || {}).textContent || '',
    teamAttr: (document.querySelector('#mmoTeam') || {}).getAttribute('data-team'),
  };
};

const PROBE_COUNTDOWN = () => {
  const el = document.getElementById('mmoCountdown');
  if (!el) return null;
  const num = document.querySelector('[data-mmo-countdown-n]');
  const style = getComputedStyle(el);
  return {
    hidden: el.hidden,
    text: num ? num.textContent.trim() : null,
    label: el.getAttribute('aria-label'),
    live: el.getAttribute('aria-live'),
    atom: el.getAttribute('aria-atomic'),
    reduced: el.getAttribute('data-reduced-motion'),
    display: style.display,
    animation: getComputedStyle(num || el).animationName,
    transform: getComputedStyle(num || el).transform,
    go: el.getAttribute('data-go'),
  };
};

const PROBE_STANDINGS = () => {
  const body = document.getElementById('mmoStandingsBody');
  const rows = body ? Array.from(body.querySelectorAll('tr')) : [];
  const managed = rows.filter((tr) => tr.dataset.mmoRow === '1');
  const youRow = document.getElementById('mmoYourRow');
  const cell = (tr, i) => {
    const tds = tr.querySelectorAll('td');
    return tds[i] ? tds[i].textContent.trim() : '';
  };
  return {
    rows: managed.length,
    note: rows.filter((tr) => tr.classList.contains('mmo-row-note')).length,
    first: managed[0] ? [0, 1, 2, 3, 4, 5].map((i) => cell(managed[0], i)) : null,
    youInBody: managed.filter((tr) => tr.dataset.you === '1').length,
    youInBodyClass: managed.filter((tr) => tr.classList.contains('is-you')).length,
    lapDown: managed.some((tr) => /LAP DOWN/.test(tr.textContent || '')),
    headerCells: rows.length ? Array.from(rows[0].querySelectorAll('th,td')).length : 0,
    yourRow: youRow ? {
      text: youRow.textContent.replace(/\s+/g, ' ').trim(),
      live: youRow.getAttribute('aria-live'),
      aria: youRow.getAttribute('aria-label'),
      pos: (youRow.querySelector('[data-mmo-you-pos]') || {}).textContent || '',
      gap: (youRow.querySelector('[data-mmo-you-gap]') || {}).textContent || '',
      tabular: getComputedStyle(youRow.querySelector('[data-mmo-you-gap]') || youRow).fontVariantNumeric,
    } : null,
  };
};

const PROBE_RESULTS = () => {
  const wrap = document.getElementById('mmoResults');
  const body = document.getElementById('mmoResultsBody');
  const rows = body ? Array.from(body.querySelectorAll('tr')).filter((tr) => tr.dataset.mmoRow === '1') : [];
  const youRow = document.getElementById('mmoYourResult');
  const podium = Array.from(document.querySelectorAll('#mmoPodium [data-place]')).map((el) => ({
    place: el.dataset.place,
    name: (el.querySelector('.mmo-podium-name') || {}).textContent || '',
    meta: (el.querySelector('.mmo-podium-meta') || {}).textContent || '',
    aria: el.getAttribute('aria-label') || '',
  }));
  const next = document.getElementById('mmoNextRace');
  const status = document.querySelector('#mmoResults [data-mmo-status]');
  const active = document.activeElement;
  return {
    hidden: wrap ? wrap.hidden : null,
    tabindex: wrap ? wrap.getAttribute('tabindex') : null,
    role: wrap ? wrap.getAttribute('role') : null,
    modal: wrap ? wrap.getAttribute('aria-modal') : null,
    labelledby: wrap ? wrap.getAttribute('aria-labelledby') : null,
    live: wrap ? wrap.getAttribute('aria-live') : null,
    focusInside: wrap ? wrap.contains(active) : false,
    activeId: active ? (active.id || active.tagName) : '',
    status: status ? status.textContent.replace(/\s+/g, ' ').trim() : '',
    statusRole: status ? status.getAttribute('role') : null,
    nextLive: next ? next.getAttribute('aria-live') : null,
    skip: !!document.querySelector('#mmoResults [data-mmo-skip]'),
    backHref: (document.querySelector('#mmoResults [data-mmo-back]') || {}).getAttribute
      ? document.querySelector('#mmoResults [data-mmo-back]').getAttribute('href') : null,
    rows: rows.length,
    tabStops: rows.filter((tr) => tr.getAttribute('tabindex') === '0').length,
    note: body ? body.querySelectorAll('.mmo-row-note').length : 0,
    youRow: youRow ? {
      pos: youRow.querySelectorAll('td')[0].textContent.trim(),
      who: youRow.querySelectorAll('td')[1].textContent.trim(),
      total: youRow.querySelectorAll('td')[3].textContent.trim(),
      best: youRow.querySelectorAll('td')[4].textContent.trim(),
      gap: youRow.querySelectorAll('td')[5].textContent.trim(),
      cls: youRow.className,
      pinned: youRow.getAttribute('data-pinned'),
      aria: youRow.getAttribute('aria-label'),
    } : null,
    podium,
    nextText: next ? next.textContent.replace(/\s+/g, ' ').trim() : '',
    hasOne: document.querySelectorAll('#mmoYourResult').length,
  };
};

const PROBE_FEED = () => {
  const host = document.getElementById('mmoFeed');
  if (!host) return null;
  const lines = Array.from(host.querySelectorAll('.mmo-feed-line'));
  const stamps = lines.map((li) => (li.querySelector('[data-mmo-stamp]') || {}).textContent || '');
  return {
    role: host.getAttribute('role'),
    live: host.getAttribute('aria-live'),
    count: lines.length,
    placeholders: host.querySelectorAll('[data-placeholder]').length,
    texts: lines.map((li) => li.textContent.replace(/\s+/g, ' ').trim()),
    stamps,
    stamped: stamps.filter((s) => /^\d\d:\d\d$/.test(s)).length,
  };
};

const PROBE_STALE = () => {
  const app = document.getElementById('mmoApp');
  return {
    busy: app ? app.getAttribute('aria-busy') : null,
    stale: app ? app.getAttribute('data-stale') : null,
    conn: app ? app.getAttribute('data-conn') : null,
    slots: document.querySelectorAll('#mmoGrid [data-seat]').length,
    resultsRows: document.querySelectorAll('#mmoResultsBody tr[data-mmo-row="1"]').length,
    youStillThere: !!document.getElementById('mmoYourResult'),
    connChip: (document.getElementById('mmoConn') || {}).textContent || '',
  };
};

/* ---------- run -------------------------------------------------------- */

let browser = null;
const result = { startedAt: new Date().toISOString(), base: BASE, browser: null, checks: results };

try {
  const executablePath = fs.existsSync(BRAVE) ? BRAVE : CHROME;
  browser = await puppeteer.launch({
    executablePath,
    headless: true,
    protocolTimeout: 120000,
    defaultViewport: { width: 1440, height: 900 },
    args: [
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-background-timer-throttling',
      '--disable-renderer-backgrounding',
      '--autoplay-policy=no-user-gesture-required',
      '--window-size=1440,900',
    ],
  });
  result.browser = await browser.version();

  const page = await browser.newPage();
  await page.setViewport({ width: 1440, height: 900 });
  page.on('console', (m) => {
    if (m.type() !== 'error') return;
    const text = m.text();
    if (IGNORE_CONSOLE.some((rx) => rx.test(text))) return;
    consoleErrors.push(text);
  });
  page.on('pageerror', (e) => pageErrors.push({ message: e.message, stack: String(e.stack || '').slice(0, 400) }));

  await page.evaluateOnNewDocument(STUB_SOCKET);
  const response = await page.goto(URL_UNDER_TEST, { waitUntil: 'domcontentloaded', timeout: 30000 });

  await page.waitForFunction(() => !!(window.__R4_MMO_UI && window.__R4_MMO_UI.ui), { timeout: 15000 });
  await page.waitForFunction(() => !!(window.__R4_MMO && window.__R4_MMO.client), { timeout: 15000 });
  await page.evaluate(() => window.__R4_MMO_UI.ui.flush());
  await sleep(120);

  /* U0 also proves the a11y stylesheet is wired (C6: --mmo-dim #949cad) and
   * that the page's transport is the stub, so the store starts empty. */
  const shell = await page.evaluate(() => ({
    links: Array.from(document.querySelectorAll('link[rel="stylesheet"]')).map((l) => l.getAttribute('href')),
    dim: getComputedStyle(document.documentElement).getPropertyValue('--mmo-dim').trim().toLowerCase(),
    stubbed: window.__R4_MMO_STUB_WS === true,
    conn: window.__R4_MMO.client.state.conn,
    eventState: window.__R4_MMO.client.state.event.state,
  }));
  record('U0',
    'mmo.html 200 + /css/mmo-a11y.css linked (--mmo-dim #949cad)',
    !!response && response.status() === 200 && shell.links.includes('/css/mmo-a11y.css')
      && (shell.dim === '#949cad' || shell.dim === 'rgb(148, 156, 173)'),
    `status=${response ? response.status() : 'none'} dim=${shell.dim} styles=${shell.links.join(',')} stub=${shell.stubbed} conn=${shell.conn} event=${shell.eventState}`);

  /* 1. Empty state: no event yet. */
  const empty = await page.evaluate(PROBE_EMPTY);
  record('U1', 'grid shell renders 50 slots', empty.slots === 50, `slots=${empty.slots}`);
  record('U2', 'no event reads WAITING FOR RACE DAY', /WAITING FOR RACE DAY/i.test(empty.track || ''), `track=${empty.track}`);
  record('U3', 'empty slots read OPEN', empty.open >= 40, `open=${empty.open}`);
  record('U4', 'grid count starts at n/50', /^\d+\/50$/.test(empty.gridCount || ''), `grid=${empty.gridCount}`);

  /* 2. Inject welcome + grid. */
  const frames = buildFrames();
  await inject(page, frames.slice(0, 2));
  await sleep(120);
  const grid = await page.evaluate(PROBE_GRID);
  record('U5', 'header: event index + GRID LOCKED pill', grid.eventNum.trim() === '#12' && /GRID LOCKED/.test(grid.state), `num=${grid.eventNum} state=${grid.state}/${grid.stateAttr}`);
  record('U6', 'header: track + car plan', /Phantomile/.test(grid.track) && /D4/.test(grid.car), `track=${grid.track} car=${grid.car}`);
  record('U7', 'header: 37/50 seated + live/reconnect chip with dot', grid.gridCount.trim() === '37/50' && grid.connDot && /^(LIVE|RECONNECTING|OFFLINE)$/.test(grid.conn.trim()) && /^(online|slow|offline|linking)$/.test(grid.connAttr || '') && !!grid.connLink, `count=${grid.gridCount} conn="${grid.conn.trim()}"/${grid.connAttr}/${grid.connLink} dot=${grid.connDot}`);
  record('U8', 'your seat/team chips', grid.seat.trim() === '7' && /Pac Racing Club/.test(grid.team) && grid.teamAttr === 'pac', `seat=${grid.seat} team=${grid.team}/${grid.teamAttr}`);
  record('U9', 'you slot highlighted (data-state=you + YOU)', grid.you && grid.you.state === 'you' && /YOU/.test(grid.you.meta) && /PLAYER 07/.test(grid.you.name), `you=${JSON.stringify(grid.you)}`);
  record('U10', 'bot slot labelled BOT', grid.bot && /\bBOT\b/.test(grid.bot.meta), `bot=${JSON.stringify(grid.bot)}`);
  record('U11', 'offline slot dimmed via data-state', grid.offline && grid.offline.state === 'offline' && /OFFLINE/.test(grid.offline.meta), `offline=${JSON.stringify(grid.offline)}`);
  record('U12', 'finished slot marked + position placeholder', grid.finished && grid.finished.state === 'finished' && /^P/.test(grid.finished.meta), `finished=${JSON.stringify(grid.finished)}`);
  record('U13', 'grid: one roving tab stop + labelled seat', grid.you && grid.you.tabindex === '0' && grid.tabStops === 1 && grid.minusOne === 49 && /Seat 7, PLAYER 07/.test(grid.you.aria) && /seats, \d+ occupied/.test(grid.gridAria || ''), `tabindex=${grid.you && grid.you.tabindex} stops=${grid.tabStops}/-1=${grid.minusOne} aria=${grid.you && grid.you.aria} grid="${grid.gridAria}"`);
  record('U14', 'empty slot reads OPEN + dashed state', grid.empty && grid.empty.state === 'empty' && grid.empty.name === 'OPEN', `empty=${JSON.stringify(grid.empty)}`);
  await page.screenshot({ path: path.join(OUT, 'mmo-ui-grid.png') });

  /* 3. Countdown. */
  await inject(page, [frames[2]]);
  await sleep(120);
  const cd = await page.evaluate(PROBE_COUNTDOWN);
  record('U15', 'countdown overlay visible 3-2-1', cd && !cd.hidden && /^(3|2|1|GO)$/.test(cd.text || ''), `text=${cd && cd.text} hidden=${cd && cd.hidden}`);
  record('U16', 'countdown is polite + atomic, static label (one mutation/digit)', cd && cd.live === 'polite' && cd.atom === 'true' && cd.label === 'Race start countdown', `live=${cd && cd.live} atomic=${cd && cd.atom} label="${cd && cd.label}"`);
  await page.screenshot({ path: path.join(OUT, 'mmo-ui-countdown.png') });

  await page.emulateMediaFeatures([{ name: 'prefers-reduced-motion', value: 'reduce' }]);
  await page.evaluate(() => window.__R4_MMO_UI.ui.flush());
  await sleep(80);
  const cdReduced = await page.evaluate(PROBE_COUNTDOWN);
  record('U17', 'reduced motion: no animation / no transform', cdReduced && cdReduced.reduced === '1' && (cdReduced.animation === 'none' || cdReduced.animation === '') && (cdReduced.transform === 'none' || cdReduced.transform === ''), `animation=${cdReduced && cdReduced.animation} transform=${cdReduced && cdReduced.transform} flag=${cdReduced && cdReduced.reduced}`);
  await page.emulateMediaFeatures([{ name: 'prefers-reduced-motion', value: 'no-preference' }]);

  /* 4. Racing + standings (the result frame comes last, in step 5). */
  await inject(page, frames.slice(3, 8));
  await sleep(120);
  const standing = await page.evaluate(PROBE_STANDINGS);
  record('U18', 'standings: top 10 rendered', standing.rows >= 10 && standing.rows <= 12, `rows=${standing.rows} note=${standing.note}`);
  record('U19', 'standings: leader row is P1 + lap + time + gap', standing.first && standing.first[0] === 'P1' && standing.first[3] === '2' && /^0:\d\d\.\d$/.test(standing.first[4]) && standing.first[5] === '—', `first=${JSON.stringify(standing.first)}`);
  record('U20', 'standings: you row highlighted in body', standing.youInBody === 1 && standing.youInBodyClass === 1, `you=${standing.youInBody}/${standing.youInBodyClass}`);
  record('U21', 'standings: lap-down gap reads LAP DOWN', standing.lapDown, `lapDown=${standing.lapDown}`);
  record('U22', 'pinned your row: P7 / 50 · lap · time · gap', !!standing.yourRow && /P7 \/ 50/.test(standing.yourRow.pos) && /LAP 2/.test(standing.yourRow.text) && /0:41\.2/.test(standing.yourRow.text) && /\+0\.8/.test(standing.yourRow.gap), `row=${standing.yourRow && standing.yourRow.text}`);
  record('U23', 'your row is aria-live=polite + tabular numerals', standing.yourRow && standing.yourRow.live === 'polite' && /tabular-nums/.test(standing.yourRow.tabular || ''), `live=${standing.yourRow && standing.yourRow.live} fvn=${standing.yourRow && standing.yourRow.tabular}`);

  // Same standings tick again (next seq): the keyed diff must patch, not duplicate.
  await inject(page, [frames[4]]);
  await sleep(80);
  const repeat = await page.evaluate(PROBE_STANDINGS);
  const gridAfter = await page.evaluate(PROBE_GRID);
  record('U23a', 'repeat standings tick patches in place (no duplicate rows)', repeat.rows === standing.rows && repeat.youInBody === 1, `rows ${standing.rows} -> ${repeat.rows}`);
  record('U12b', 'finished slot gains its live position', /^P2/.test(gridAfter.finished.meta), `meta=${gridAfter.finished && gridAfter.finished.meta}`);

  const feed = await page.evaluate(PROBE_FEED);
  record('U24', 'feed is role=log, newest last, de-duplicated', feed && feed.role === 'log' && feed.count === 2 && feed.placeholders === 0, `count=${feed && feed.count} ph=${feed && feed.placeholders}`);
  record('U25', 'feed timestamps are mm:ss', feed && feed.stamped === feed.count && feed.count > 0, `stamps=${JSON.stringify(feed && feed.stamps)}`);

  /* 5. Results — a modal dialog that takes focus and announces once. */
  await page.evaluate(() => {
    const btn = document.getElementById('mmoBots');
    if (btn) btn.focus(); // the element the dialog must give focus back to
  });
  const focusBefore = await page.evaluate(() => (document.activeElement ? (document.activeElement.id || document.activeElement.tagName) : ''));
  await inject(page, [frames[8]]);
  await sleep(150);
  const res = await page.evaluate(PROBE_RESULTS);
  record('U26', 'results: section shown, 50 rows, no note row', res.hidden === false && res.rows === 50 && res.note === 0, `hidden=${res.hidden} rows=${res.rows} note=${res.note}`);
  record('U27', 'results: your row highlighted + pinned', !!res.youRow && /is-you/.test(res.youRow.cls) && res.youRow.pinned === '1' && res.youRow.pos === 'P7' && res.hasOne === 1, `you=${JSON.stringify(res.youRow)}`);
  record('U28', 'results: total/best/gap columns', !!res.youRow && /^\d:\d\d\.\d$/.test(res.youRow.total) && /^\d:\d\d\.\d$/.test(res.youRow.best) && /^\+\d+\.\d$/.test(res.youRow.gap), `total=${res.youRow && res.youRow.total} best=${res.youRow && res.youRow.best} gap=${res.youRow && res.youRow.gap}`);
  record('U29', 'results: podium filled with P1..P3 + labels', res.podium.length === 3 && res.podium.every((p) => p.name && p.name !== '—') && res.podium[0].place === '1', `podium=${JSON.stringify(res.podium)}`);
  record('U30', 'results: next-race text, aria-live=off (no 1x/s announcements)', /NEXT RACE IN \d\d:\d\d/.test(res.nextText) && res.nextLive === 'off', `text=${res.nextText} live=${res.nextLive}`);
  await page.evaluate(() => {
    const el = document.getElementById('mmoResults');
    if (el) el.scrollIntoView({ block: 'start' });
  });
  await sleep(200);
  await page.screenshot({ path: path.join(OUT, 'mmo-ui-results.png') });

  /* focus is handed back when the next event replaces the sheet */
  const returned = await page.evaluate(() => {
    const ui = window.__R4_MMO_UI.ui;
    ui.render({ conn: 'open', event: { id: 'ev12', index: 12, state: 'lobby' } });
    ui.flush();
    const active = document.activeElement;
    const wrap = document.getElementById('mmoResults');
    return {
      hidden: wrap ? wrap.hidden : null,
      active: active ? (active.id || active.tagName) : '',
      restored: active === document.getElementById('mmoBots'),
      rows: document.querySelectorAll('#mmoResultsBody tr[data-mmo-row="1"]').length,
    };
  });
  record('U31', 'results dialog: role/modal/labelledby, focus in then handed back, one status line',
    res.role === 'dialog' && res.modal === 'true' && res.labelledby === 'mmoResultsTitle'
      && res.live === null && res.tabindex === '-1' && res.skip && res.backHref === '/race-day'
      && res.focusInside && res.activeId === 'mmoResults'
      && res.statusRole === 'status' && /^Results ready\. You finished P7 of \d+\./.test(res.status)
      && res.tabStops === 0 && focusBefore === 'mmoBots'
      && returned.hidden === true && returned.restored && returned.rows === 50,
    `role=${res.role} modal=${res.modal} labelledby=${res.labelledby} live=${res.live} tabindex=${res.tabindex} skip=${res.skip} back=${res.backHref} focus=${res.activeId}/inside=${res.focusInside} status="${res.status}"/${res.statusRole} rowStops=${res.tabStops} before=${focusBefore} after=${returned.active}/restored=${returned.restored} rows=${returned.rows}`);

  /* 6. Disconnected: last board kept, dimmed, never blank. */
  await page.evaluate(() => {
    const ui = window.__R4_MMO_UI.ui;
    ui.render({ conn: 'reconnecting', attempt: 2 });
    ui.flush();
  });
  await sleep(120);
  const stale = await page.evaluate(PROBE_STALE);
  record('U32', 'disconnect keeps the board + aria-busy', stale.busy === 'true' && stale.stale === '1' && stale.slots === 50 && stale.resultsRows === 50, `busy=${stale.busy} stale=${stale.stale} slots=${stale.slots} rows=${stale.resultsRows}`);
  record('U33', 'disconnect chip reads RECONNECTING', /RECONNECTING/.test(stale.connChip), `chip=${stale.connChip}`);

  /* 8. Slow-network badge + >50 seats never render. */
  const slow = await page.evaluate(() => {
    const ui = window.__R4_MMO_UI.ui;
    const base = ui.snapshot();
    ui.render({ ...JSON.parse(JSON.stringify(base)), slow: true, conn: 'open' });
    ui.flush();
    const badge = document.getElementById('mmoQualityBadge');
    return { text: badge ? badge.textContent.trim() : null, slow: badge ? badge.getAttribute('data-slow') : null, aria: badge ? badge.getAttribute('aria-label') : null };
  });
  record('U33a', 'slow network shows SLOW on #mmoQualityBadge', slow.text === 'SLOW' && slow.slow === '1' && /slow/i.test(slow.aria || ''), `badge=${JSON.stringify(slow)}`);

  const cappedSeats = [];
  for (let seat = 1; seat <= 60; seat += 1) {
    cappedSeats.push({ seat, name: `DRIVER-${seat}`, team: 'Solvalou', driverId: `d${seat}`, bot: false, state: 'seated', connected: true });
  }
  await inject(page, [{ type: 'grid', seats: cappedSeats, counts: { seated: 60, queued: 0, max: 60 } }]);
  const capped = await page.evaluate(() => {
    const slots = Array.from(document.querySelectorAll('#mmoGrid [data-seat]'));
    return {
      slots: slots.length,
      maxSeat: Math.max(...slots.map((el) => Number(el.dataset.seat))),
      tabStops: slots.filter((el) => el.getAttribute('tabindex') === '0').length,
      gridCount: (document.getElementById('mmoGridCount') || {}).textContent || '',
    };
  });
  record('U33b', '>50 seats never render (capped at 50 slots, still one tab stop)', capped.slots === 50 && capped.maxSeat === 50 && capped.tabStops === 1, `slots=${capped.slots} maxSeat=${capped.maxSeat} stops=${capped.tabStops} count=${capped.gridCount}`);

  /* 7. Error budget (known console noise allowed, page errors must be zero). */
  record('U34', 'zero page errors', pageErrors.length === 0, `pageErrors=${pageErrors.length}`, pageErrors.slice(0, 5));
  record('U35', 'zero unexpected console errors', consoleErrors.length === 0, `consoleErrors=${consoleErrors.length}`, consoleErrors.slice(0, 5));
} catch (err) {
  record('UX', 'harness completed without throwing', false, String(err && err.stack || err).slice(0, 600));
} finally {
  if (browser) await browser.close().catch(() => {});
}

const passed = results.filter((r) => r.pass).length;
result.passed = passed;
result.total = results.length;
result.ok = passed === results.length;
result.finishedAt = new Date().toISOString();
result.pageErrors = pageErrors;
result.consoleErrors = consoleErrors;

fs.writeFileSync(path.join(OUT, 'mmo-ui-render.json'), JSON.stringify(result, null, 2));
fs.writeFileSync(path.join(OUT, 'mmo-ui.log'), logLines.join('\n') + '\n');
console.log(`\n${result.ok ? 'PASS' : 'FAIL'}  ${passed}/${results.length} checks  ->  _runtime/mmo-ui-render.json`);
process.exit(result.ok ? 0 : 1);
