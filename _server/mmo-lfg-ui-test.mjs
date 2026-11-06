// Race Day — LFG panel evidence (mmo-lfg.js / mmo-lfg.css).
//
// Drives the installed Brave via puppeteer-core against a throwaway MMO
// cabinet instance (default http://127.0.0.1:8097; pass another base as argv[2]).
// Does not start or stop any server, does not use git.
//
// Run: node mmo-lfg-ui-test.mjs [base]
// Writes: _runtime/mmo-lfg-desktop-1440x900.png,
//         _runtime/mmo-lfg-mobile-390x844.png,
//         _runtime/mmo-lfg-ui.json
//
// Covers the ui-lfg contract (20-mmo-contract.md §3.1/§4.2/§5): queue button,
// queue frames, position/ETA + local countdown, fill meter + MIN marker,
// start-now gating, bots config frame, party create/copy, spectate, offline
// retry, no layout shift, 0 horizontal overflow, 0 page errors.
//
// The target server may be shared with other agents, so every `queue`/`grid`/
// `event`/`error` assertion injects a frame and reads the DOM in the SAME
// evaluate — the panel is synchronous with client.subscribe().

import puppeteer from 'puppeteer-core';
import fs from 'node:fs';

const BRAVE = 'C:/Program Files/BraveSoftware/Brave-Browser/Application/brave.exe';
const BASE = (process.argv[2] || 'http://127.0.0.1:8097').replace(/\/+$/, '');
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

async function waitFor(label, fn, { timeout = 15000, interval = 100 } = {}) {
  const started = Date.now();
  let last = null;
  while (Date.now() - started < timeout) {
    try {
      last = await fn();
      if (last) return last;
    } catch (e) { last = e.message; }
    await sleep(interval);
  }
  throw new Error(`timeout waiting for ${label}; last=${JSON.stringify(last)}`);
}

/* --------------------------------------------------------------- console -- */

const pageErrors = [];
const consoleErrors = [];
const KNOWN_RX = /Minified React error #418|react\.dev\/errors\/418|No ICE servers configured|invalid core option/i;

function watchPage(page, tag) {
  page.on('pageerror', (err) => pageErrors.push({ tag, text: String(err && err.message || err) }));
  page.on('console', (m) => {
    if (m.type() !== 'error') return;
    const text = m.text();
    if (KNOWN_RX.test(text)) return;
    consoleErrors.push({ tag, text });
  });
}

/* ------------------------------------------------------------------ run --- */

const result = {
  at: new Date().toISOString(),
  base: BASE,
  browser: null,
  checks,
  screenshots: [],
  frames: { sent: [], injected: [] },
  pageErrors,
  consoleErrors,
};

let browser = null;
let mainPage = null;

const inject = (page, frame) => page.evaluate((f) => window.__R4_MMO_LFG.inject(f), frame);

const sentCount = (page, type) => page.evaluate((t) => window.__R4_MMO.client._debug.sentCount(t), type);

// Inject a frame and read the panel in one evaluate so a live shared server
// cannot slip its own frame between the two.
const injectRead = (page, frame) => page.evaluate((f) => {
  const applied = window.__R4_MMO_LFG.inject(f);
  const text = (sel) => {
    const el = document.querySelector(sel);
    return el ? String(el.textContent || '').replace(/\s+/g, ' ').trim() : null;
  };
  const btn = document.getElementById('mmoLfgBtn');
  const start = document.getElementById('mmoStart');
  const eta = document.getElementById('mmoEta');
  const bar = document.querySelector('#mmoFill [data-mmo-fill-bar]');
  const progress = document.querySelector('#mmoFill [role="progressbar"]');
  const track = document.querySelector('#mmoFill .mmo-fill-track') || (bar && bar.parentElement);
  const rect = bar ? bar.getBoundingClientRect() : { width: 0 };
  const tRect = track ? track.getBoundingClientRect() : { width: 0 };
  const err = document.querySelector('[data-mmo-lfg-error]');
  const state = window.__R4_MMO.client.state;
  return {
    applied,
    btn: btn ? btn.textContent.trim() : null,
    btnWidth: btn ? Math.round(btn.getBoundingClientRect().width * 10) / 10 : 0,
    btnHeight: btn ? Math.round(btn.getBoundingClientRect().height * 10) / 10 : 0,
    btnTitle: btn ? btn.getAttribute('title') : null,
    btnDisabled: btn ? btn.disabled : null,
    queue: text('#mmoLfgQueue'),
    eta: eta ? eta.textContent.trim() : null,
    etaLine: eta ? eta.parentElement.textContent.replace(/\s+/g, ' ').trim() : null,
    startLabel: start ? start.textContent.trim() : null,
    startDisabled: start ? start.disabled : null,
    honest: text('[data-mmo-lfg-honest]'),
    error: err ? { text: err.textContent.trim(), hidden: err.hidden } : null,
    fill: {
      text: text('#mmoFill [data-mmo-fill-text]'),
      width: bar ? bar.style.width : null,
      now: progress ? progress.getAttribute('aria-valuenow') : null,
      min: progress ? progress.getAttribute('aria-valuemin') : null,
      max: progress ? progress.getAttribute('aria-valuemax') : null,
      label: progress ? progress.getAttribute('aria-label') : null,
      ratio: tRect.width ? (rect.width / tRect.width) : 0,
    },
    counts: { min: state.event.counts.min, max: state.event.counts.max, seated: state.event.counts.seated },
    queueState: { position: state.queue.position, size: state.queue.size },
  };
}, frame);

try {
  browser = await puppeteer.launch({
    executablePath: BRAVE,
    headless: true,
    protocolTimeout: 240000,
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
  result.browser = await browser.version();
  try {
    await browser.defaultBrowserContext().overridePermissions(BASE, ['clipboard-read', 'clipboard-write']);
  } catch { /* clipboard permission is best-effort; execCommand fallback exists */ }

  /* ======================================================= L1: mount ===== */

  mainPage = await browser.newPage();
  await mainPage.setViewport({ ...DESKTOP, deviceScaleFactor: 1 });
  watchPage(mainPage, 'race-day');

  const resp = await mainPage.goto(`${BASE}/race-day`, { waitUntil: 'domcontentloaded', timeout: 30000 });
  record('L1', '/race-day serves the Race Day page', resp && resp.status() === 200, `status=${resp && resp.status()}`);

  await waitFor('lfg mount + socket open', () => mainPage.evaluate(() => {
    const g = window.__R4_MMO;
    return !!(window.__R4_MMO_LFG && window.__R4_MMO_LFG.lfg && g && g.client && g.client.state.conn === 'open');
  }), { timeout: 20000 });

  const mounted = await mainPage.evaluate(() => {
    const api = window.__R4_MMO_LFG.lfg;
    const bar = document.querySelector('#mmoFill [data-mmo-fill-bar]');
    const progress = document.querySelector('#mmoFill [role="progressbar"]');
    const mark = document.querySelector('#mmoFill [data-mmo-min-mark]');
    return {
      hasApi: !!api,
      hasBar: !!bar,
      hasText: !!document.querySelector('#mmoFill [data-mmo-fill-text]'),
      progressLabel: progress && progress.getAttribute('aria-label'),
      hasLive: progress ? progress.hasAttribute('aria-live') : true,
      markText: mark ? mark.textContent.trim() : null,
      markLeft: mark ? mark.style.left : null,
      btn: document.getElementById('mmoLfgBtn').textContent.trim(),
      startDisabled: document.getElementById('mmoStart').disabled,
      botsPressed: document.getElementById('mmoBots').getAttribute('aria-pressed'),
      copyDisabled: document.getElementById('mmoCopyLink').disabled,
      partyInput: !!document.querySelector('[data-mmo-party-input]'),
      createBtn: !!document.querySelector('[data-mmo-party-create]'),
      queueLive: document.getElementById('mmoLfgQueue').getAttribute('aria-live'),
      etaLive: document.getElementById('mmoEta').getAttribute('aria-live'),
      honesty: !!document.querySelector('[data-mmo-lfg-honest]'),
      min: window.__R4_MMO.client.state.event.counts.min,
      max: window.__R4_MMO.client.state.event.counts.max,
    };
  });
  result.mount = mounted;

  record('L2', 'mountLfg auto-mounts on #mmoLfg and owns the fill bar/text/progressbar',
    mounted.hasApi && mounted.hasBar && mounted.hasText && mounted.progressLabel === 'Grid fill',
    `progressbar aria-label=${mounted.progressLabel}`);
  record('L3', 'MIN marker rendered at the MIN_DRIVERS threshold (min/max)',
    new RegExp(`^MIN ${mounted.min}$`).test(String(mounted.markText))
      && mounted.markLeft === `${Math.round((mounted.min / mounted.max) * 1000) / 10}%`,
    `text=${mounted.markText} left=${mounted.markLeft} (server min=${mounted.min} max=${mounted.max})`);
  record('L4', 'idle LFG: FIND ME A RACE, START disabled, bots off, copy disabled',
    mounted.btn === 'FIND ME A RACE' && mounted.startDisabled === true
      && mounted.botsPressed === 'false' && mounted.copyDisabled === true,
    `btn=${mounted.btn} startDisabled=${mounted.startDisabled} aria-pressed=${mounted.botsPressed}`);
  record('L5', 'aria-live on the queue line + ETA, not on the meter',
    mounted.queueLive === 'polite' && mounted.etaLive === 'polite' && mounted.hasLive === false,
    `aria-live: queue=${mounted.queueLive} eta=${mounted.etaLive} progressbar=${mounted.hasLive ? 'present' : 'none'}`);
  record('L6', 'party CREATE + code JOIN controls exist (the shell has no such markup)',
    mounted.partyInput && mounted.createBtn === true);

  /* ============================================== L7: queue round-trip ==== */

  await mainPage.evaluate(() => window.__R4_MMO.client._debug.clearSent());
  await mainPage.evaluate(() => document.getElementById('mmoLfgBtn').click());
  await waitFor('queue sent', async () => (await sentCount(mainPage, 'queue')) > 0, { timeout: 8000 });
  await sleep(200);
  const afterQueue = await mainPage.evaluate(() => ({
    btn: document.getElementById('mmoLfgBtn').textContent.trim(),
    queueLine: document.getElementById('mmoLfgQueue').textContent.trim(),
    sentQueue: window.__R4_MMO.client._debug.sentCount('queue'),
    position: window.__R4_MMO.client.state.queue.position,
    seat: window.__R4_MMO.client.state.you.seat,
  }));
  result.frames.sent.push({ type: 'queue' });
  record('L7', 'FIND ME A RACE sends a `queue` frame and the button flips to LEAVE QUEUE',
    afterQueue.sentQueue === 1 && afterQueue.btn === 'LEAVE QUEUE',
    `sentQueue=${afterQueue.sentQueue} btn=${afterQueue.btn} position=${afterQueue.position} seat=${afterQueue.seat}`);
  record('L8', 'server queue frame renders a position + the QUEUED timer',
    /(NEXT IN|#\d+ IN QUEUE|IN QUEUE)/.test(afterQueue.queueLine) && /QUEUED \d\d:\d\d/.test(afterQueue.queueLine),
    `line="${afterQueue.queueLine}"`);

  /* ============================ L9/L10/L11: injected position + local ETA = */

  const pos12 = await injectRead(mainPage, { type: 'queue', position: 12, size: 37, etaMs: 18000, fillMs: 60000, party: null });
  result.frames.injected.push({ type: 'queue', position: 12, size: 37, etaMs: 18000 });
  record('L9', 'queue frame position 12 renders "#12 IN QUEUE"',
    pos12.applied === 'applied' && /#12 IN QUEUE/.test(String(pos12.queue)), `line="${pos12.queue}"`);
  record('L10', 'etaMs renders STARTS IN 00:18', /STARTS IN 00:18/.test(String(pos12.etaLine)), `line="${pos12.etaLine}"`);

  const etaRecompute = await mainPage.evaluate(async () => {
    const api = window.__R4_MMO_LFG.lfg;
    const client = window.__R4_MMO.client;
    const read = () => document.querySelector('#mmoEta').parentElement.textContent.replace(/\s+/g, ' ').trim();
    // Silence the live socket for 2.2 s so the measurement is the panel's own
    // countdown, not a server queue frame racing in mid-window.
    client.close();
    api.inject({ type: 'queue', position: 12, size: 37, etaMs: 18000, fillMs: 60000, party: null });
    const first = read();
    await new Promise((r) => setTimeout(r, 2200));
    const second = read();
    const stable = client.state.queue.position === 12;
    client.connect();
    return { first, second, stable };
  });
  const secs = (t) => Number((/STARTS IN 00:(\d\d)/.exec(String(t)) || [])[1]);
  record('L11', 'ETA counts down locally each second (never a stale server string)',
    etaRecompute.stable === true && secs(etaRecompute.first) === 18
      && secs(etaRecompute.second) >= 14 && secs(etaRecompute.second) <= 17,
    `first="${etaRecompute.first}" after 2.2 s "${etaRecompute.second}" stable=${etaRecompute.stable}`);

  const pos1 = await injectRead(mainPage, { type: 'queue', position: 1, size: 37, etaMs: 18000, fillMs: 60000, party: null });
  record('L12', 'queue position 1 renders NEXT IN', /NEXT IN/.test(String(pos1.queue)), `line="${pos1.queue}"`);

  /* ======================================== L13–L15: fill meter 0/4/50 === */

  const meter = [];
  for (const seated of [0, 4, 50]) {
    meter.push(await injectRead(mainPage, { type: 'grid', counts: { seated, queued: 37, max: 50 }, seats: [] }));
  }
  result.meter = meter.map((m, i) => ({ seated: [0, 4, 50][i], fill: m.fill }));
  const meterOk = (i, seated) => {
    const m = meter[i].fill;
    const pct = Math.round((seated / 50) * 1000) / 10;
    return m.now === String(seated) && m.min === '0' && m.max === '50' && m.label === 'Grid fill'
      && m.width === `${pct}%` && String(m.text).includes(`${seated} / 50`);
  };
  record('L13', 'fill 0/50 → width 0 %, aria-valuenow 0', meterOk(0, 0), JSON.stringify(meter[0].fill));
  record('L14', 'fill 4/50 → width 8 %, aria-valuenow 4, text "4 / 50"', meterOk(1, 4), JSON.stringify(meter[1].fill));
  record('L15', 'fill 50/50 → width 100 %, aria-valuenow 50', meterOk(2, 50), JSON.stringify(meter[2].fill));

  const meterPaint = await mainPage.evaluate(async () => {
    const api = window.__R4_MMO_LFG.lfg;
    const client = window.__R4_MMO.client;
    for (let attempt = 0; attempt < 5; attempt += 1) {
      api.inject({ type: 'grid', counts: { seated: 25, queued: 37, max: 50 }, seats: [] });
      const c0 = client.state.event.counts;
      await new Promise((r) => setTimeout(r, 450)); // let the .3s width transition land
      if (client.state.event.counts !== c0) continue;
      const bar = document.querySelector('#mmoFill [data-mmo-fill-bar]');
      const track = document.querySelector('#mmoFill .mmo-fill-track') || bar.parentElement;
      return {
        stable: true,
        drawn: Math.round((bar.getBoundingClientRect().width / track.getBoundingClientRect().width) * 1000) / 10,
        now: document.querySelector('#mmoFill [role="progressbar"]').getAttribute('aria-valuenow'),
      };
    }
    return { stable: false };
  });
  record('L16', 'painted bar matches aria-valuenow (25/50 → 50 % of the track)',
    meterPaint.stable === true && Math.abs(meterPaint.drawn - 50) < 2 && meterPaint.now === '25',
    `drawn=${meterPaint.drawn}% aria-valuenow=${meterPaint.now} stable=${meterPaint.stable}`);

  /* ============================================ L17: start-now gating ==== */

  const min = mounted.min;
  const max = mounted.max;
  const underSize = Math.max(0, min - 1);
  const overSize = Math.min(max, min + 8);
  const under = await injectRead(mainPage, { type: 'queue', position: 1, size: underSize, etaMs: 30000, fillMs: 60000, party: null });
  const over = await injectRead(mainPage, { type: 'queue', position: 1, size: overSize, etaMs: 18000, fillMs: 60000, party: null });
  record('L17', `START disabled under MIN (${underSize} < ${min}) and labelled START WITH ${underSize} (never START NOW)`,
    under.startDisabled === true && under.startLabel === `START WITH ${underSize}`,
    `label="${under.startLabel}" disabled=${under.startDisabled}`);
  record('L18', `START enables at ${overSize} ≥ ${min} as START WITH ${overSize} + the honest empty-seat line`,
    over.startDisabled === false && over.startLabel === `START WITH ${overSize}`
      && new RegExp(`STARTS WITH ${overSize}/${max} — EMPTY SEATS STAY OPEN`).test(String(over.honest)),
    `label="${over.startLabel}" honest="${over.honest}"`);

  /* =================================================== L19: no shift ===== */

  const widths = await mainPage.evaluate(async () => {
    const client = window.__R4_MMO.client;
    const api = window.__R4_MMO_LFG.lfg;
    const w = () => Math.round(document.getElementById('mmoLfgBtn').getBoundingClientRect().width * 10) / 10;
    const h = () => Math.round(document.getElementById('mmoLfgBtn').getBoundingClientRect().height * 10) / 10;
    const out = {};
    api.inject({ type: 'event', state: 'lobby' });
    out.find = { w: w(), h: h() };
    api.inject({ type: 'event', state: 'countdown' });
    out.next = { w: w(), h: h(), label: document.getElementById('mmoLfgBtn').textContent.trim() };
    out.spectate = null;
    api.inject({ type: 'event', state: 'lobby' });
    return out;
  });
  record('L19', 'primary button box is identical across FIND ME A RACE → JOIN NEXT RACE (no layout shift)',
    widths.find.w === widths.next.w && widths.find.h === widths.next.h,
    `find=${widths.find.w}×${widths.find.h} next=${widths.next.w}×${widths.next.h} label="${widths.next.label}"`);

  /* ================================================== L20: bots toggle === */

  await mainPage.evaluate(() => window.__R4_MMO.client._debug.clearSent());
  await mainPage.evaluate(() => document.getElementById('mmoBots').click());
  await sleep(200);
  const bots = await mainPage.evaluate(() => ({
    pressed: document.getElementById('mmoBots').getAttribute('aria-pressed'),
    sentConfig: window.__R4_MMO.client._debug.sentCount('config'),
    configFrame: window.__R4_MMO.client._debug.sent().filter((m) => m.type === 'config'),
    stored: localStorage.getItem('rr4.mmo.bots'),
    badge: (() => { const b = document.querySelector('[data-mmo-bots-badge]'); return b && !b.hidden ? b.textContent.trim() : null; })(),
    note: (() => { const n = document.querySelector('[data-mmo-bots-note]'); return n ? n.textContent.trim() : null; })(),
    unsupported: window.__R4_MMO_LFG.lfg.configUnsupported,
  }));
  result.bots = bots;
  result.frames.sent.push({ type: 'config', bots: true });
  record('L20', 'bots toggle sends `config {bots:true}`, persists it and shows DEMO — BOTS ON',
    bots.pressed === 'true' && bots.sentConfig === 1 && bots.stored === '1' && bots.badge === 'DEMO — BOTS ON',
    `aria-pressed=${bots.pressed} configFrames=${bots.sentConfig} localStorage=${bots.stored} badge=${bots.badge}`);
  record('L21', 'bots explainer is one honest line (names ?bots=1 when the server ignores config)',
    !!bots.note && /bot/i.test(bots.note) && bots.note.length > 30,
    `note="${bots.note}" serverIgnoredConfig=${bots.unsupported}`);
  await sleep(1100); // _server/src/mmo.js rate-limits an unseated config toggle to 1/s
  const botsOff = await mainPage.evaluate(() => {
    document.getElementById('mmoBots').click();
    return {
      pressed: document.getElementById('mmoBots').getAttribute('aria-pressed'),
      stored: localStorage.getItem('rr4.mmo.bots'),
      sentConfig: window.__R4_MMO.client._debug.sentCount('config'),
      hidden: (() => { const b = document.querySelector('[data-mmo-bots-badge]'); return !b || b.hidden; })(),
    };
  });
  record('L22', 'toggling bots back off sends config {bots:false}, clears the badge and stores 0',
    botsOff.pressed === 'false' && botsOff.stored === '0' && botsOff.sentConfig === 2 && botsOff.hidden === true,
    `aria-pressed=${botsOff.pressed} stored=${botsOff.stored} configFrames=${botsOff.sentConfig}`);
  await mainPage.evaluate(() => document.getElementById('mmoBots').click()); // back on for the screenshots

  /* ===================================================== L23: party ====== */

  await mainPage.evaluate(() => document.querySelector('[data-mmo-party-create]').click());
  const partyCode = await waitFor('party frame', () => mainPage.evaluate(() => {
    const s = window.__R4_MMO.client.state;
    return (s.party && s.party.code) || null;
  }), { timeout: 8000 });
  await sleep(150);
  const party = await mainPage.evaluate(() => ({
    code: document.getElementById('mmoPartyCode').textContent.trim(),
    copy: document.getElementById('mmoCopyLink').textContent.trim(),
    copyDisabled: document.getElementById('mmoCopyLink').disabled,
    status: document.querySelector('[data-mmo-party-status]').textContent.trim(),
    note: document.querySelector('[data-mmo-party-note]').textContent.trim(),
    input: document.querySelector('[data-mmo-party-input]').value,
    sentCreate: window.__R4_MMO.client._debug.sentCount('party:create'),
  }));
  result.party = party;
  result.frames.sent.push({ type: 'party:create' });
  record('L23', 'CREATE PARTY returns a code, shows PARTY <CODE> · n/2 and enables COPY INVITE LINK',
    /^[A-Z0-9]{4,6}$/.test(partyCode) && party.code === partyCode && party.copyDisabled === false
      && party.copy === 'COPY INVITE LINK' && party.status.startsWith(`PARTY ${partyCode} · `),
    `code=${partyCode} shown=${party.code} status="${party.status}" copy="${party.copy}"`);
  record('L24', 'party note states the same-race/same-team promise',
    /same race/i.test(party.note) && /same team/i.test(party.note), `note="${party.note}"`);

  const codeEcho = await mainPage.evaluate(() => {
    const api = window.__R4_MMO_LFG.lfg;
    const issued = api.partyCode;
    // mmo-client.js's `queue` branch truncates a party code to 4 chars; the
    // panel must keep the code mmo.js actually issued.
    if (issued.length > 4) {
      api.inject({ type: 'queue', position: 3, size: 5, etaMs: 20000, fillMs: 60000, party: { code: issued.slice(0, 4), size: 1 } });
    }
    return { issued, kept: api.partyCode, shown: document.getElementById('mmoPartyCode').textContent.trim() };
  });
  record('L24b', 'a 4-char prefix echoed by the client does not truncate the party code shown/copied',
    codeEcho.issued.length >= 4 && codeEcho.kept === codeEcho.issued && codeEcho.shown === codeEcho.issued,
    `issued=${codeEcho.issued} kept=${codeEcho.kept} shown=${codeEcho.shown}`);

  await mainPage.evaluate(() => document.getElementById('mmoCopyLink').click());
  await sleep(250);
  const copyState = await mainPage.evaluate(() => ({
    label: document.getElementById('mmoCopyLink').textContent.trim(),
    flag: document.getElementById('mmoLfg').getAttribute('data-copied'),
  }));
  record('L25', 'COPY INVITE LINK writes /race-day?party=<CODE> and flashes COPIED',
    copyState.label === 'COPIED' && copyState.flag === '1',
    `label="${copyState.label}" data-copied=${copyState.flag}`);
  await sleep(1600);
  const copyReverted = await mainPage.evaluate(() => document.getElementById('mmoCopyLink').textContent.trim());
  record('L26', 'the COPIED flash reverts to COPY INVITE LINK', copyReverted === 'COPY INVITE LINK', `label="${copyReverted}"`);

  /* ============================================ L27: grid|countdown copy = */

  await inject(mainPage, { type: 'event', state: 'countdown', index: 12, plan: { trackIndex: 4, trackName: 'Phantomile', carClass: 'R4' } });
  await sleep(120);
  const locked = await mainPage.evaluate(() => ({
    eta: document.getElementById('mmoEta').textContent.trim(),
    line: document.querySelector('#mmoEta').parentElement.textContent.replace(/\s+/g, ' ').trim(),
    btn: document.getElementById('mmoLfgBtn').textContent.trim(),
    title: document.getElementById('mmoLfgBtn').getAttribute('title'),
    disabled: document.getElementById('mmoLfgBtn').disabled,
  }));
  result.busy = locked;
  record('L27', 'countdown → GRID LOCKED, no START gate, button stays enabled with the race-in-progress tooltip',
    locked.eta === 'GRID LOCKED' && /GRID LOCKED/.test(locked.line) && locked.btn === 'LEAVE QUEUE'
      && locked.disabled === false && locked.title === 'RACE IN PROGRESS — QUEUE JOINS THE NEXT ONE',
    `eta="${locked.line}" btn="${locked.btn}" enabled=${!locked.disabled} title="${locked.title}"`);

  const busyIdle = await injectRead(mainPage, { type: 'queue', position: 0, size: 4, etaMs: 12000, fillMs: 60000, party: { code: partyCode, size: 1 } });
  const busyRacing = await injectRead(mainPage, { type: 'event', state: 'racing' });
  record('L28', 'racing → JOIN NEXT RACE (queueing for the next event stays allowed)',
    busyRacing.btn === 'JOIN NEXT RACE' && busyRacing.btnDisabled === false
      && busyRacing.btnTitle === 'RACE IN PROGRESS — QUEUE JOINS THE NEXT ONE',
    `before="${busyIdle.btn}" btn="${busyRacing.btn}" disabled=${busyRacing.btnDisabled}`);

  /* ================================================= L29: queue full ===== */

  await injectRead(mainPage, { type: 'event', state: 'lobby', index: 12 });
  const full = await injectRead(mainPage, { type: 'error', code: 'full', message: 'grid is full' });
  record('L29', 'error.code=full renders GRID FULL — QUEUE FOR THE NEXT RACE',
    full.error && full.error.hidden === false && full.error.text === 'GRID FULL — QUEUE FOR THE NEXT RACE',
    `text="${full.error && full.error.text}" hidden=${full.error && full.error.hidden}`);

  /* ============================================ desktop screenshot ======= */
  // Compose the contract's example panel: 37/50, #12 in queue, ETA 00:18, a party.
  await inject(mainPage, { type: 'grid', counts: { seated: 37, queued: 37, max: 50 }, seats: [] });
  await inject(mainPage, {
    type: 'queue', position: 12, size: 37, etaMs: 18000, fillMs: 60000,
    party: { code: partyCode, size: 1 },
  });
  await sleep(600);
  const overflowDesktop = await mainPage.evaluate(() => ({
    scrollW: document.documentElement.scrollWidth,
    clientW: document.documentElement.clientWidth,
    bodyW: document.body.scrollWidth,
    panel: (() => { const p = document.getElementById('mmoLfg'); const r = p.getBoundingClientRect(); return { w: Math.round(r.width), h: Math.round(r.height) }; })(),
    fixed: (() => {
      // the panel has a fixed box: the label churn above must not have resized it
      return window.__R4_MMO_LFG.lfg.els.panel === document.getElementById('mmoLfg');
    })(),
  }));
  await mainPage.screenshot({ path: `${OUT}/mmo-lfg-desktop-1440x900.png` });
  result.screenshots.push(`${OUT}/mmo-lfg-desktop-1440x900.png`);
  record('L30', 'desktop 1440×900 has no horizontal overflow',
    overflowDesktop.scrollW - overflowDesktop.clientW <= 1,
    `scrollWidth=${overflowDesktop.scrollW} clientWidth=${overflowDesktop.clientW} lfg=${overflowDesktop.panel.w}×${overflowDesktop.panel.h}`);

  /* ================================================= L31: mobile shot ===== */

  const mobile = await browser.newPage();
  await mobile.setViewport({ ...MOBILE, deviceScaleFactor: 1 });
  watchPage(mobile, 'mobile');
  await mobile.goto(`${BASE}/race-day`, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await waitFor('mobile lfg + socket', () => mobile.evaluate(() => {
    const g = window.__R4_MMO;
    return !!(window.__R4_MMO_LFG && window.__R4_MMO_LFG.lfg && g && g.client && g.client.state.conn === 'open');
  }), { timeout: 20000 });
  await mobile.evaluate(() => window.__R4_MMO.client._debug.clearSent());
  await mobile.evaluate(() => document.getElementById('mmoLfgBtn').click());
  await mobile.evaluate(() => document.querySelector('[data-mmo-party-create]').click());
  await waitFor('mobile party', () => mobile.evaluate(() => {
    const s = window.__R4_MMO.client.state;
    return (s.party && s.party.code) || null;
  }), { timeout: 8000 });
  await mobile.evaluate(() => window.__R4_MMO_LFG.inject({ type: 'grid', counts: { seated: 37, queued: 37, max: 50 }, seats: [] }));
  await mobile.evaluate(() => {
    const s = window.__R4_MMO.client.state;
    const code = (s.party && s.party.code) || '';
    window.__R4_MMO_LFG.inject({ type: 'queue', position: 12, size: 37, etaMs: 18000, fillMs: 60000, party: code ? { code, size: 1 } : null });
  });
  await sleep(600);
  const overflowMobile = await mobile.evaluate(() => ({
    scrollW: document.documentElement.scrollWidth,
    clientW: document.documentElement.clientWidth,
    bodyW: document.body.scrollWidth,
    widest: (() => {
      let worst = { sel: '', right: 0 };
      document.querySelectorAll('#mmoLfg *, #mmoEvent *').forEach((el) => {
        const r = el.getBoundingClientRect();
        if (r.right > worst.right) worst = { sel: el.id || el.className || el.tagName, right: Math.round(r.right) };
      });
      return worst;
    })(),
  }));
  await mobile.screenshot({ path: `${OUT}/mmo-lfg-mobile-390x844.png` });
  result.screenshots.push(`${OUT}/mmo-lfg-mobile-390x844.png`);
  record('L31', 'mobile 390×844 has no horizontal overflow',
    overflowMobile.scrollW - overflowMobile.clientW <= 1,
    `scrollWidth=${overflowMobile.scrollW} clientWidth=${overflowMobile.clientW} widestRight=${overflowMobile.widest.right} (${overflowMobile.widest.sel})`);

  /* ================================================= L32: spectating ===== */

  const spec = await browser.newPage();
  await spec.setViewport({ ...MOBILE, deviceScaleFactor: 1 });
  watchPage(spec, 'spectate');
  await spec.goto(`${BASE}/race-day?spectate=1&name=SPECTATOR`, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await waitFor('spectate mount', () => spec.evaluate(() => {
    const g = window.__R4_MMO;
    return !!(window.__R4_MMO_LFG && g && g.client && g.client.state.conn === 'open');
  }), { timeout: 20000 });
  await sleep(300);
  const watching = await spec.evaluate(() => ({
    btn: document.getElementById('mmoLfgBtn').textContent.trim(),
    queue: document.getElementById('mmoLfgQueue').textContent.trim(),
    flag: document.getElementById('mmoLfg').getAttribute('data-spectating'),
    seat: window.__R4_MMO.client.state.you.seat,
  }));
  record('L32', '?spectate=1 shows WATCHING + TAKE A SEAT NEXT RACE',
    watching.flag === '1' && watching.btn === 'TAKE A SEAT NEXT RACE' && /WATCHING/.test(watching.queue),
    `btn="${watching.btn}" line="${watching.queue}" seat=${watching.seat}`);

  await spec.evaluate(() => document.getElementById('mmoLfgBtn').click());
  await waitFor('spectator queued', () => spec.evaluate(() => {
    const s = window.__R4_MMO.client.state;
    return (s.queue.position > 0 || s.you.seat > 0) ? true : null;
  }), { timeout: 8000 });
  const tookSeat = await spec.evaluate(() => ({
    flag: document.getElementById('mmoLfg').getAttribute('data-spectating'),
    btn: document.getElementById('mmoLfgBtn').textContent.trim(),
    seat: window.__R4_MMO.client.state.you.seat,
    position: window.__R4_MMO.client.state.queue.position,
    sentQueue: window.__R4_MMO.client._debug.sentCount('queue'),
  }));
  record('L33', 'TAKE A SEAT NEXT RACE queues the spectator (queue frame + position/seat)',
    tookSeat.flag === '0' && tookSeat.btn === 'LEAVE QUEUE' && (tookSeat.position > 0 || tookSeat.seat > 0),
    `btn="${tookSeat.btn}" position=${tookSeat.position} seat=${tookSeat.seat} queueFrames=${tookSeat.sentQueue}`);
  await spec.close();

  /* ============================================ L33b: ?party= auto-join === */

  const joiner = await browser.newPage();
  await joiner.setViewport({ ...DESKTOP, deviceScaleFactor: 1 });
  watchPage(joiner, 'party-join');
  await joiner.goto(`${BASE}/race-day?party=${partyCode}&name=JOINER`, { waitUntil: 'domcontentloaded', timeout: 30000 });
  const joined = await waitFor('party auto-join', () => joiner.evaluate((code) => {
    const g = window.__R4_MMO;
    if (!(window.__R4_MMO_LFG && g && g.client && g.client.state.conn === 'open')) return null;
    const s = g.client.state;
    const got = (s.party && s.party.code) || '';
    if (got !== code) return null;
    return {
      code: got,
      size: s.party.size,
      members: (s.party.members || []).length,
      joinFrames: window.__R4_MMO.client._debug.sentCount('party:join'),
      shown: document.getElementById('mmoPartyCode').textContent.trim(),
      status: document.querySelector('[data-mmo-party-status]').textContent.trim(),
      lfgCode: window.__R4_MMO_LFG.lfg.partyCode,
    };
  }, partyCode), { timeout: 15000 });
  result.partyJoin = joined;
  record('L33b', '?party=<CODE> auto-joins the party mmo.js issued (full code, not the 4-char prefix)',
    joined.code === partyCode && joined.lfgCode === partyCode && joined.size === 2 && joined.members === 2
      && joined.shown === partyCode,
    `code=${joined.code} size=${joined.size}/2 members=${joined.members} joinFrames=${joined.joinFrames} status="${joined.status}"`);

  const bothSeats = await waitFor('host sees 2/2', () => mainPage.evaluate(() => {
    const s = window.__R4_MMO.client.state;
    const size = (s.party && s.party.size) || 0;
    const status = document.querySelector('[data-mmo-party-status]').textContent.trim();
    return size === 2 && /2\/2/.test(status) ? { size, status } : null;
  }), { timeout: 12000 });
  record('L33c', 'the first member sees the party fill to 2/2 (same race, same team promise)',
    bothSeats.size === 2 && /2\/2/.test(bothSeats.status), `status="${bothSeats.status}"`);
  await joiner.close();

  /* ============================================ L34/L35: offline+retry === */

  await mainPage.evaluate(() => window.__R4_MMO.client.close());
  await waitFor('offline row', () => mainPage.evaluate(() => {
    const row = document.querySelector('[data-mmo-lfg-conn]');
    const retry = document.querySelector('[data-mmo-reconnect]');
    return !!(row && !row.hidden && retry && !retry.hidden);
  }), { timeout: 6000 });
  const offline = await mainPage.evaluate(() => ({
    conn: window.__R4_MMO.client.state.conn,
    btn: document.getElementById('mmoLfgBtn').textContent.trim(),
    btnDisabled: document.getElementById('mmoLfgBtn').disabled,
    row: document.querySelector('[data-mmo-lfg-conn]').textContent.replace(/\s+/g, ' ').trim(),
  }));
  record('L34', 'offline shows the RECONNECT row and an OFFLINE primary button',
    offline.conn === 'closed' && offline.btnDisabled === true && /RECONNECT/.test(offline.row) && offline.btn === 'OFFLINE',
    `conn=${offline.conn} btn="${offline.btn}" row="${offline.row}"`);
  await mainPage.evaluate(() => document.querySelector('[data-mmo-reconnect]').click());
  const backOnline = await waitFor('reconnect', () => mainPage.evaluate(() => {
    const c = window.__R4_MMO.client.state.conn;
    return c === 'open' ? c : null;
  }), { timeout: 20000, interval: 150 });
  const afterRetry = await mainPage.evaluate(() => ({
    conn: window.__R4_MMO.client.state.conn,
    rowHidden: (() => { const r = document.querySelector('[data-mmo-lfg-conn]'); return !r || r.hidden; })(),
    btn: document.getElementById('mmoLfgBtn').textContent.trim(),
  }));
  record('L35', 'RECONNECT calls client.connect(), the socket reopens and the row hides',
    backOnline === 'open' && afterRetry.rowHidden === true && afterRetry.btn !== 'OFFLINE',
    `conn=${afterRetry.conn} rowHidden=${afterRetry.rowHidden} btn="${afterRetry.btn}"`);

  /* ==================================================== page errors ====== */

  record('L36', 'no uncaught page errors on any page', pageErrors.length === 0,
    pageErrors.length ? JSON.stringify(pageErrors).slice(0, 400) : '0 pageerror events');
  record('L37', 'no unexpected console errors', consoleErrors.length === 0,
    consoleErrors.length ? JSON.stringify(consoleErrors).slice(0, 400) : '0 console errors (known noise filtered)');
} catch (err) {
  record('ERR', 'harness completed without throwing', false, String(err && err.message || err));
} finally {
  result.checks = checks;
  result.passed = checks.filter((c) => c.pass).length;
  result.failed = checks.filter((c) => !c.pass).length;
  result.pageErrors = pageErrors;
  result.consoleErrors = consoleErrors;
  try { fs.writeFileSync(`${OUT}/mmo-lfg-ui.json`, JSON.stringify(result, null, 2)); } catch { /* ignore */ }
  if (browser) { try { await browser.close(); } catch { /* ignore */ } }
  console.log('');
  console.log(`RESULT ${result.passed}/${checks.length} passed, ${result.failed} failed  (${BASE})`);
  console.log(`screenshots: ${result.screenshots.join(', ') || 'none'}`);
  console.log(`json: ${OUT}/mmo-lfg-ui.json`);
  if (result.failed) process.exitCode = 1;
}
