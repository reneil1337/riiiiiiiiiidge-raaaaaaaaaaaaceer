// Race Day — repeatable screenshot harness for every visual state.
//
// Drives Brave via puppeteer-core against the already-running cabinet on :8080
// (never starts or stops a server). Each state is driven DETERMINISTICALLY by
// injecting /mmo frames through window.__R4_MMO.client._debug.inject(frame)
// (the real client store + the real renderers), not by waiting for a live race.
// `--live` adds one real-socket capture on top.
//
// For each capture it asserts:
//   - document.documentElement.scrollWidth <= innerWidth (no horizontal overflow)
//   - no element wider than the viewport (scroll/clip ancestors excluded)
//   - no `undefined` / `NaN` / `null` text node under #mmoApp (#mmoHud on /play)
//   - console + pageerror count (expected noise: the NETPLAY ICE line only)
//
// Run: node mmo-shots.mjs [--quick] [--only <name>] [--live]
// Writes: _runtime/mmo-shots.json + _runtime/mmo-shot-<state>-<viewport>.png
//
// Injected numbers are internally consistent on purpose: positions are
// contiguous, gapMs is the delta to the leader and matches raceTimeMs, lap
// times are plausible R4 lap times (~0:39.8). Nothing here shows a state the
// app cannot produce: every frame is a real contract frame (§3).

import puppeteer from 'puppeteer-core';
import fs from 'node:fs';
import path from 'node:path';

const BRAVE = 'C:/Program Files/BraveSoftware/Brave-Browser/Application/brave.exe';
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const BASE = process.env.RR4_BASE || 'http://127.0.0.1:8080';
const OUT = path.resolve('../_runtime');

const DESKTOP = { width: 1440, height: 900 };
const MOBILE = { width: 390, height: 844 };

const argv = process.argv.slice(2);
const QUICK = argv.includes('--quick');
const LIVE = argv.includes('--live');
const onlyIdx = argv.indexOf('--only');
const ONLY = onlyIdx >= 0 ? String(argv[onlyIdx + 1] || '').trim() : '';

fs.mkdirSync(OUT, { recursive: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const nowMs = () => Date.now();

/* ---------------------------------------------------------------- frames ---
 * Contract frames (§3). One builder per type so every state is spelled once.
 * seq must increase per page; each fixture carries its own counter.
 */

const TEAMS = [
  { name: 'Solvalou', slug: 'sol' },
  { name: 'Pac Racing Club', slug: 'pac' },
  { name: 'Micro Mouse Mappy', slug: 'map' },
  { name: 'Dig Racing Team', slug: 'dig' },
];

const MAX = 50;
const MIN = 4;
const ME = { seat: 7, name: 'PLAYER 07', team: 'Pac Racing Club', driverId: 'drv-shots' };

function seatFixture(seat, seated) {
  if (seat > seated) {
    return { seat, name: '', driverId: '', team: TEAMS[seat % 4].name, bot: false, state: 'empty', connected: true };
  }
  const mine = seat === ME.seat;
  const bot = !mine && seat % 5 === 0;
  return {
    seat,
    name: mine ? ME.name : (bot ? `BOT-${String(seat).padStart(2, '0')}` : `DRIVER-${String(seat).padStart(2, '0')}`),
    team: mine ? ME.team : TEAMS[seat % 4].name,
    driverId: mine ? ME.driverId : (bot ? `bot-${seat}` : `drv-${seat}`),
    bot,
    state: bot ? 'seated' : 'seated',
    connected: true,
  };
}

function seats(seated) {
  const list = [];
  for (let seat = 1; seat <= MAX; seat += 1) list.push(seatFixture(seat, seated));
  return list;
}

function fixture() {
  // The live /mmo socket increments its own global seq and would overwrite an
  // injected frame on the next broadcast (the client drops seq <= lastSeq).
  // Starting at 1e9 makes the injected snapshot sticky for the page's life,
  // which is what makes these captures deterministic on a busy cabinet.
  let seq = 1e9;
  const next = () => (seq += 1);
  return {
    seq: next,
    welcome({ state = 'lobby', plan = null, seated = 0, index = 12, id = 'ev12', seat = null, bots = false } = {}) {
      return {
        type: 'welcome',
        seq: next(),
        driverId: ME.driverId,
        you: { seat, team: seat == null ? '' : ME.team, name: ME.name },
        state,
        event: { id, index, state, plan },
        counts: { seated, queued: 0, max: MAX, min: MIN, bots },
        max: MAX,
        min: MIN,
        bots,
      };
    },
    grid(seated) {
      return { type: 'grid', seq: next(), seats: seats(seated), counts: { seated, queued: 0, max: MAX } };
    },
    event({ state, plan = null, seated = 0, index = 12, id = 'ev12', bots = false }) {
      return {
        type: 'event', seq: next(), id, index, state, plan,
        counts: { seated, queued: 0, max: MAX, min: MIN, bots },
      };
    },
    queue({ position = 0, size = 0, etaMs = null, fillMs = null, party = null } = {}) {
      return { type: 'queue', seq: next(), position, size, etaMs, fillMs, party };
    },
    countdown(n, startsAt) {
      return { type: 'countdown', seq: next(), n, startsAt };
    },
    standings({ rows, you, lap = 1, top = MAX }) {
      return { type: 'standings', seq: next(), rows, you, lap, top };
    },
    result({ rows, you, finishedAt }) {
      return { type: 'result', seq: next(), rows, you, finishedAt };
    },
    party({ code, members }) {
      return { type: 'party', seq: next(), code, size: members.length, members };
    },
    feed(text, at) {
      return { type: 'feed', seq: next(), text, at };
    },
  };
}

const PLAN = { trackIndex: 4, trackName: 'Phantomile', carClass: 'D4' };
// Empty board (pre-race): renders the "WAITING FOR THE GRID" note instead of
// whatever the live socket had painted before the snapshot was injected.
const NO_ROWS = { rows: [], you: { position: null, gapMs: null, gapLap: false }, lap: 0, top: MAX };

/* Racing board: top 10 + you at P7. Contiguous positions, gaps are the real
 * delta to P1's raceTimeMs, one lapped row (P9) for the LAP DOWN path. Race
 * time is total elapsed on lap 2 (leader 1:22.3 ≈ 2 × 0:41 laps, standing
 * start), so the board, the HUD stopwatch and the results sheet agree. */
function standingsRows() {
  const leader = 82310;
  const rows = [];
  for (let pos = 1; pos <= 10; pos += 1) {
    const mine = pos === ME.seat;
    const lapped = pos === 9;
    const lap = lapped ? 1 : 2;
    const raceTimeMs = lapped ? 40050 : leader + (pos - 1) * 230;
    rows.push({
      seat: pos,
      name: mine ? ME.name : `DRIVER-${String(pos).padStart(2, '0')}`,
      team: mine ? ME.team : TEAMS[pos % 4].name,
      position: pos,
      lap,
      raceTimeMs,
      gapMs: pos === 1 || lapped ? null : (pos - 1) * 230,
      gapLap: lapped,
      bot: pos % 5 === 0,
      state: 'racing',
    });
  }
  return rows;
}

/* 50-row results sheet: contiguous positions, total = winner + 1.45 s/place,
 * best lap 0:39.8 + 40 ms/place (plausible, ordered). The winner's 1:22.6 for
 * two laps matches the 0:39.8 best laps and the lap-2 standings board. */
function resultRows() {
  const winner = 82650;
  const rows = [];
  for (let pos = 1; pos <= MAX; pos += 1) {
    const mine = pos === ME.seat;
    rows.push({
      seat: pos,
      name: mine ? ME.name : `DRIVER-${String(pos).padStart(2, '0')}`,
      team: mine ? ME.team : TEAMS[pos % 4].name,
      position: pos,
      raceTimeMs: winner + (pos - 1) * 1450,
      bestLapMs: 39800 + (pos - 1) * 40,
      gapMs: pos === 1 ? null : (pos - 1) * 1450,
      bot: pos % 5 === 0,
      state: 'finished',
    });
  }
  return rows;
}

/* 12-row spectator board (the watch-only panel caps at 12 rows). */
function spectateRows() {
  const leader = 82310;
  const rows = [];
  for (let pos = 1; pos <= 12; pos += 1) {
    rows.push({
      seat: pos,
      name: `DRIVER-${String(pos).padStart(2, '0')}`,
      team: TEAMS[pos % 4].name,
      position: pos,
      lap: 2,
      raceTimeMs: leader + (pos - 1) * 230,
      bestLapMs: 39800 + (pos - 1) * 40,
      gapMs: pos === 1 ? null : (pos - 1) * 230,
      gapLap: false,
      bot: pos % 5 === 0,
      state: 'racing',
    });
  }
  return rows;
}

/* ------------------------------------------------------------ page probes --- */

function probeInPage() {
  const vw = window.innerWidth;
  const de = document.documentElement;
  const root = document.getElementById('mmoApp')
    || document.getElementById('mmoHud')
    || document.body;
  const overflowPx = de.scrollWidth - vw;

  const bad = [];
  const pushBad = (el, text) => {
    let label = el && el.tagName ? el.tagName.toLowerCase() : '?';
    if (el && el.id) label += `#${el.id}`;
    else if (el && el.className && typeof el.className === 'string') label += `.${el.className.trim().split(/\s+/).slice(0, 2).join('.')}`;
    bad.push({ el: label, text: String(text).replace(/\s+/g, ' ').slice(0, 90) });
  };
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, null);
  const badRx = /(?:\bundefined\b|\bNaN\b|\bnull\b)/;
  const SKIP = /^(SCRIPT|STYLE|TEMPLATE|NOSCRIPT)$/;
  let node = walker.nextNode();
  while (node) {
    const text = node.nodeValue || '';
    const parent = node.parentElement;
    const skipped = parent && (SKIP.test(parent.tagName) || (parent.closest && !!parent.closest('script,style,template,noscript')));
    if (!skipped && text.trim() && badRx.test(text)) pushBad(parent, text);
    node = walker.nextNode();
  }
  // Placeholder '[object Object]' means a frame shape was misread.
  if (/\[object Object\]/.test(root.textContent || '')) {
    pushBad(root, '[object Object]');
  }

  const wide = [];
  const els = document.querySelectorAll('body *');
  for (let i = 0; i < els.length; i += 1) {
    const el = els[i];
    const rect = el.getBoundingClientRect();
    if (rect.width <= vw + 1) continue;
    // An element inside a scroll/clip box that itself fits is not an overflow.
    let p = el.parentElement;
    let clipped = false;
    while (p && p !== document.documentElement) {
      const cs = getComputedStyle(p);
      if (/(auto|scroll|hidden|clip)/.test(cs.overflowX)) {
        const pr = p.getBoundingClientRect();
        if (pr.width <= vw + 1) { clipped = true; break; }
      }
      p = p.parentElement;
    }
    if (clipped) continue;
    let label = el.tagName.toLowerCase();
    if (el.id) label += `#${el.id}`;
    else if (typeof el.className === 'string' && el.className.trim()) label += `.${el.className.trim().split(/\s+/)[0]}`;
    wide.push({ el: label, w: Math.round(rect.width), right: Math.round(rect.right) });
  }

  const text = (sel) => {
    const el = document.querySelector(sel);
    return el ? el.textContent.replace(/\s+/g, ' ').trim() : null;
  };
  const count = (sel) => document.querySelectorAll(sel).length;

  return {
    viewport: { w: vw, h: window.innerHeight },
    scrollWidth: de.scrollWidth,
    overflowPx,
    overflow: overflowPx > 0,
    wide: wide.slice(0, 8),
    wideCount: wide.length,
    badText: bad.slice(0, 8),
    badTextCount: bad.length,
    root: root.id || root.tagName.toLowerCase(),
    applied: window.__mmoShotsApplied || null,
    facts: {
      conn: text('#mmoConn'),
      connState: (document.getElementById('mmoConn') || {}).dataset ? document.getElementById('mmoConn').dataset.link : null,
      state: text('#mmoState'),
      gridCount: text('#mmoGridCount'),
      track: text('[data-mmo-track]'),
      car: text('[data-mmo-car]'),
      queue: text('#mmoLfgQueue'),
      eta: text('#mmoEta'),
      code: text('#mmoPartyCode'),
      copy: text('#mmoCopyLink'),
      copyAria: (document.getElementById('mmoCopyLink') || {}).getAttribute ? document.getElementById('mmoCopyLink').getAttribute('aria-label') : null,
      countdown: text('[data-mmo-countdown-n]'),
      countdownHidden: (document.getElementById('mmoCountdown') || {}).hidden,
      standingsRows: count('#mmoStandingsBody tr[data-mmo-row="1"]'),
      yourRow: text('#mmoYourRow'),
      resultsRows: count('#mmoResultsBody tr[data-mmo-row="1"]'),
      podium: count('#mmoPodium [data-place]'),
      yourResult: text('#mmoYourResult'),
      spectate: !!document.getElementById('mmoSpectateBoard'),
      spectateRows: count('#mmoSpectateBoard [data-mmo-sp-row], #mmoSpectateBoard .mmo-sp-row'),
      hud: !!document.getElementById('mmoHud'),
      hudPos: text('#mmoHudPos'),
      hudLap: text('#mmoHudLap'),
      hudTime: text('#mmoHudTime'),
      hudBoardRows: count('#mmoHudBoardList li'),
      mmoCard: text('a.wcard--mmo'),
      invite: text('#mmoPartyInvite'),
      inviteHidden: (document.getElementById('mmoPartyInvite') || {}).hidden,
      inviteCode: text('#mmoPartyInviteCode'),
    },
  };
}

/* --------------------------------------------------------------- fixtures ---
 * One entry per shot. `frames(page, f)` injects; `expect` returns extra detail
 * for the table; `method` says how the state was reached.
 */

const SHOTS = [
  {
    name: 'lobby-empty',
    url: `${BASE}/race-day?name=PLAYER 07`,
    method: 'inject',
    note: 'empty event (0/50, no plan) + client.close() so the chip reads OFFLINE',
    async drive(page) {
      const f = fixture();
      await page.evaluate(() => {
        const c = window.__R4_MMO && window.__R4_MMO.client;
        if (c && typeof c.close === 'function') c.close();
      });
      await inject(page, [
        f.welcome({ state: 'lobby', plan: null, seated: 0 }),
        f.standings(NO_ROWS),
        f.grid(0),
        f.queue({ position: 0, size: 0, etaMs: null }),
      ]);
      await sleep(300);
    },
    expect: (p) => p.facts.gridCount === '0/50' && /OFFLINE/.test(p.facts.conn || ''),
  },
  {
    name: 'lobby-filling',
    url: `${BASE}/race-day?name=PLAYER 07`,
    method: 'inject',
    note: '37/50 seated, queue position 12 of 37, ETA 01:26, my seat 7',
    async drive(page) {
      const f = fixture();
      await inject(page, [
        f.welcome({ state: 'lobby', plan: null, seated: 37, seat: ME.seat, bots: true }),
        f.standings(NO_ROWS),
        f.grid(37),
        f.queue({ position: 12, size: 37, etaMs: 86000, fillMs: 60000 }),
        f.feed('13 SEATS OPEN — DRIVERS 38-50 CAN STILL JOIN', nowMs() - 12000),
      ]);
      await sleep(350);
    },
    expect: (p) => p.facts.gridCount === '37/50' && /12/.test(p.facts.queue || ''),
  },
  {
    name: 'grid-locked',
    url: `${BASE}/race-day?name=PLAYER 07`,
    method: 'inject',
    note: '50/50 seated, plan Phantomile / D4, event #12',
    async drive(page) {
      const f = fixture();
      await inject(page, [
        f.welcome({ state: 'grid', plan: PLAN, seated: MAX, seat: ME.seat, bots: true }),
        f.standings(NO_ROWS),
        f.grid(MAX),
        f.event({ state: 'grid', plan: PLAN, seated: MAX, bots: true }),
        f.queue({ position: 1, size: MAX, etaMs: null }),
      ]);
      await sleep(300);
    },
    expect: (p) => p.facts.gridCount === '50/50' && /GRID LOCKED/.test(p.facts.state || ''),
  },
  {
    name: 'countdown-3',
    url: `${BASE}/race-day?name=PLAYER 07`,
    method: 'inject',
    note: 'event state countdown, countdown n=3 (startsAt = now + 3 s)',
    async drive(page) {
      const f = fixture();
      const t = nowMs();
      await inject(page, [
        f.welcome({ state: 'grid', plan: PLAN, seated: MAX, seat: ME.seat, bots: true }),
        f.standings({ rows: standingsRows(), you: { position: ME.seat, gapMs: 1380, gapLap: false }, lap: 2, top: MAX }),
        f.grid(MAX),
        f.event({ state: 'countdown', plan: PLAN, seated: MAX, bots: true }),
        f.countdown(3, t + 3000),
      ]);
      await sleep(200);
    },
    expect: (p) => p.facts.countdown === '3',
  },
  {
    name: 'countdown-go',
    url: `${BASE}/race-day?name=PLAYER 07`,
    method: 'inject',
    note: 'countdown n=1 with startsAt 120 ms in the past → the 900 ms GO hold',
    async drive(page) {
      const f = fixture();
      const t = nowMs();
      await inject(page, [
        f.welcome({ state: 'grid', plan: PLAN, seated: MAX, seat: ME.seat, bots: true }),
        f.standings({ rows: standingsRows(), you: { position: ME.seat, gapMs: 1380, gapLap: false }, lap: 2, top: MAX }),
        f.grid(MAX),
        f.event({ state: 'countdown', plan: PLAN, seated: MAX, bots: true }),
        f.countdown(1, t - 120),
      ]);
      await sleep(60);
    },
    expect: (p) => p.facts.countdown === 'GO',
    fastShot: true,
  },
  {
    name: 'racing-standings',
    url: `${BASE}/race-day?name=PLAYER 07`,
    method: 'inject',
    note: 'top 10 + you at P7 (lap 2, 1:23.7, +1.4), P9 lapped',
    async drive(page) {
      const f = fixture();
      const rows = standingsRows();
      await inject(page, [
        f.welcome({ state: 'racing', plan: PLAN, seated: MAX, seat: ME.seat, bots: true }),
        f.standings({ rows, you: { position: ME.seat, gapMs: 1380, gapLap: false }, lap: 2, top: MAX }),
        f.grid(MAX),
        f.event({ state: 'racing', plan: PLAN, seated: MAX, bots: true }),
        f.queue({ position: 3, size: 50, etaMs: 42000 }),
        f.feed('P1 — DRIVER-01 took the lead', nowMs() - 9000),
        f.feed('PLAYER 07 set 0:39.8', nowMs() - 3000),
      ]);
      await sleep(350);
      // On a phone the board is stacked below the LFG panel; scroll the standings
      // into view so the capture is the board this shot is about.
      if (page.viewport().width < 600) {
        await page.evaluate(() => {
          const el = document.getElementById('mmoStandings');
          if (el && typeof el.scrollIntoView === 'function') el.scrollIntoView({ block: 'start' });
        });
        await sleep(250);
      }
    },
    expect: (p) => p.facts.standingsRows >= 10 && /P7 \/ 50/.test(p.facts.yourRow || ''),
  },
  {
    name: 'results',
    url: `${BASE}/race-day?name=PLAYER 07`,
    method: 'inject',
    note: '50-row result sheet, podium P1-P3, your row P7 highlighted',
    async drive(page) {
      const f = fixture();
      const rows = resultRows();
      const me = rows[ME.seat - 1];
      await inject(page, [
        f.welcome({ state: 'racing', plan: PLAN, seated: MAX, seat: ME.seat, bots: true }),
        f.standings({ rows: standingsRows(), you: { position: ME.seat, gapMs: 1380 }, lap: 2, top: MAX }),
        f.grid(MAX),
        f.event({ state: 'racing', plan: PLAN, seated: MAX, bots: true }),
        f.result({
          rows,
          you: { position: ME.seat, raceTimeMs: me.raceTimeMs, bestLapMs: me.bestLapMs, gapMs: me.gapMs, lap: 2 },
          finishedAt: nowMs(),
        }),
      ]);
      await sleep(400);
    },
    expect: (p) => p.facts.resultsRows === MAX && p.facts.podium === 3,
  },
  {
    name: 'spectate',
    url: `${BASE}/race-day?spectate=1&party=ABCD&name=PLAYER 07`,
    method: 'inject',
    note: '?spectate=1 board (mmo.html loads mmo-spectate.js itself), 12-row watch-only board',
    async drive(page) {
      // mmo.html loads /js/mmo-spectate.js in the current UI; only fall back to
      // injecting the module tag when the page really does not.
      const pageHasModule = await page.evaluate(
        () => Array.from(document.scripts).some((s) => /\/js\/mmo-spectate\.js/.test(s.src || '')),
      );
      const facadeUp = () => page.evaluate(() => !!(window.__R4_MMO_SPECTATE && window.__R4_MMO_SPECTATE.spectate));
      if (pageHasModule) {
        const deadline = Date.now() + 6000;
        while (Date.now() < deadline && !(await facadeUp())) await sleep(150);
      }
      if (!(await facadeUp())) {
        await page.addScriptTag({ type: 'module', url: `${BASE}/js/mmo-spectate.js` }).catch(() => {});
        await page.waitForFunction(() => !!(window.__R4_MMO_SPECTATE && window.__R4_MMO_SPECTATE.spectate), { timeout: 10000 }).catch(() => {});
        spectateFallback = true;
      }
      const f = fixture();
      await inject(page, [
        f.welcome({ state: 'racing', plan: PLAN, seated: MAX, seat: null }),
        f.event({ state: 'racing', plan: PLAN, seated: MAX }),
        f.grid(MAX),
        f.standings({ rows: spectateRows(), you: { position: null, gapMs: null }, lap: 2, top: MAX }),
        f.countdown(0, 0),
      ]);
      await sleep(400);
    },
    expect: (p) => p.facts.spectate === true,
  },
  {
    name: 'hud',
    url: `${BASE}/play?mmo=1&event=ev12&seat=7&team=pac&game=r4&embedded=1&threads=0`,
    method: 'inject',
    note: 'play document held by request interception (/rom,/bios), HUD mounted from frames',
    async drive(page) {
      await page.waitForFunction(() => !!(window.__R4_MMO && window.__R4_MMO.hud), { timeout: 20000 });
      // /play still shows the music-player's cabinet audio gate when it is not
      // inside the shell iframe; SKIP AUDIO is the real control that reveals the
      // stage. No audio element is created by this harness.
      await page.waitForFunction(() => !!document.querySelector('.rr4m-gate-skip'), { timeout: 15000 }).catch(() => {});
      await page.evaluate(() => {
        const b = document.querySelector('.rr4m-gate-skip');
        if (b) b.click();
      });
      const f = fixture();
      await inject(page, [
        f.welcome({ state: 'racing', plan: PLAN, seated: MAX, seat: ME.seat, bots: true }),
        f.standings({ rows: standingsRows(), you: { position: ME.seat, gapMs: 1380, gapLap: false }, lap: 2, top: MAX }),
        f.grid(MAX),
        f.event({ state: 'racing', plan: PLAN, seated: MAX, bots: true }),
        f.countdown(0, nowMs() - 82400),
        f.feed('PLAYER 07 set 0:39.8', nowMs() - 3000),
      ]);
      // The mini board is a real affordance (B / the toggle chip): open it on
      // desktop so the shot shows the board. On a 390 px stage the board would
      // cover the centre of the game screen, so the chips alone are the state.
      await page.evaluate((wide) => {
        const hud = window.__R4_MMO && window.__R4_MMO.hud;
        if (!wide || !hud) return;
        if (typeof hud.isOpen === 'function' && !hud.isOpen() && typeof hud.toggle === 'function') hud.toggle();
      }, page.viewport().width >= 900);
      await sleep(500);
    },
    expect: (p, vp) => p.facts.hud === true
      && /^1:\d\d\.\d$/.test(p.facts.hudTime || '') && /LAP 2/.test(p.facts.hudLap || '')
      && (vp === 'mobile' ? true : p.facts.hudBoardRows >= 5),
  },
  {
    name: 'welcome-entry',
    url: `${BASE}/welcome`,
    method: 'live',
    note: 'the real /welcome hub; the RACE DAY card is static markup',
    async drive(page) {
      await page.waitForFunction(() => !!document.querySelector('a.wcard--mmo'), { timeout: 15000 });
      await sleep(200);
    },
    expect: (p) => /RACE DAY/i.test(p.facts.mmoCard || ''),
  },
  {
    name: 'shell-embedded',
    url: `${BASE}/`,
    method: 'live',
    note: 'ENTER gate → nav RACE DAY → /race-day?embedded=1 inside #rr4sFrame, 37/50 injected',
    async drive(page) {
      await page.waitForFunction(() => {
        const b = document.getElementById('rr4eEnter');
        const label = b && b.querySelector('span');
        return !!b && !b.disabled && !!label && /^ENTER$/i.test(label.textContent.trim());
      }, { timeout: 25000 });
      await page.click('#rr4eEnter');
      await page.waitForFunction(() => {
        const s = document.getElementById('rr4-shell');
        return !!s && !s.hidden && document.body.classList.contains('is-live');
      }, { timeout: 15000 });
      await page.waitForFunction(() => !!document.querySelector('.rr4s-nav [data-view="race-day"]'), { timeout: 10000 });
      await page.click('.rr4s-nav [data-view="race-day"]');
      // The iframe src is set synchronously but the child document lands a few
      // seconds later, so poll the frame list rather than trusting frame.src.
      let frame = null;
      for (let i = 0; i < 40 && !frame; i += 1) {
        await sleep(250);
        frame = page.frames().find((fr) => /\/race-day/.test(fr.url()));
      }
      if (!frame) throw new Error('race-day iframe not found after nav click');
      await frame.waitForFunction(() => !!(window.__R4_MMO && window.__R4_MMO.client), { timeout: 15000 });
      await frame.waitForFunction(() => {
        const s = document.getElementById('mmoBoot');
        return !s || s.hidden;
      }, { timeout: 12000 }).catch(() => {});
      const f = fixture();
      await frame.evaluate((frames) => {
        const c = window.__R4_MMO.client;
        for (const fr of frames) c._debug.inject(fr);
        if (window.__R4_MMO_UI && window.__R4_MMO_UI.ui) window.__R4_MMO_UI.ui.flush();
      }, [
        f.welcome({ state: 'lobby', plan: null, seated: 37, seat: ME.seat, bots: true }),
        f.standings(NO_ROWS),
        f.grid(37),
        f.queue({ position: 12, size: 37, etaMs: 86000 }),
      ]);
      await sleep(400);
    },
    expect: (p) => p.facts.embedded === true && p.facts.frameGridCount === '37/50',
  },
  {
    name: 'lfg-party',
    url: `${BASE}/race-day?name=PLAYER 07&party=ABCD`,
    method: 'inject',
    note: 'party ABCD via ?party= (invite chip) + 2/2 party frame, queue 12/37',
    async drive(page) {
      const f = fixture();
      const members = [
        { name: ME.name, driverId: ME.driverId, seat: ME.seat },
        { name: 'TAK', driverId: 'drv-tak', seat: 21 },
      ];
      await inject(page, [
        f.welcome({ state: 'lobby', plan: null, seated: 37, seat: ME.seat, bots: true }),
        f.standings(NO_ROWS),
        f.grid(37),
        f.party({ code: 'ABCD', members }),
        f.queue({ position: 12, size: 37, etaMs: 86000, party: { code: 'ABCD', size: 2 } }),
      ]);
      await sleep(450);
    },
    expect: (p) => p.facts.code === 'ABCD' && /ABCD/.test(p.facts.copyAria || '')
      && p.facts.inviteHidden === false && /ABCD/.test(p.facts.invite || ''),
  },
];

/* ------------------------------------------------------------ page plumbing --- */

async function inject(page, frames) {
  return page.evaluate((list) => {
    const facade = window.__R4_MMO || {};
    // The HUD owns its client instance; prefer it so what we inject is what it renders.
    const c = (facade.hud && facade.hud.client) || facade.client || null;
    if (!c || !c._debug || typeof c._debug.inject !== 'function') return { ok: false };
    const applied = [];
    for (const frame of list) applied.push(c._debug.inject(frame));
    window.__mmoShotsApplied = applied;
    if (window.__R4_MMO_UI && window.__R4_MMO_UI.ui) {
      try { window.__R4_MMO_UI.ui.flush(); } catch { /* renderer owns its errors */ }
    }
    return { ok: true, applied };
  }, frames);
}

const EXPECTED_CONSOLE = [
  /\[NETPLAY\] No ICE servers configured/i,
  /Failed to load resource.*favicon/i,
];

function watch(page, sink) {
  page.on('console', (m) => {
    if (m.type() !== 'error' && m.type() !== 'warning') return;
    const text = m.text();
    if (EXPECTED_CONSOLE.some((rx) => rx.test(text))) return;
    sink.push({ kind: `console.${m.type()}`, text: text.slice(0, 300) });
  });
  page.on('pageerror', (e) => sink.push({ kind: 'pageerror', text: String(e.message).slice(0, 300) }));
}

/* Deterministic-socket test double: it opens, never delivers a frame, and keeps
 * the client lifecycle (conn chip, strip, ping timers) intact. A live socket's
 * own frames would otherwise race the injected snapshot and its "never blank
 * the board" carry would leave real rows under an injected header. */
function stubSocket() {
  class StubWebSocket {
    constructor(url) {
      this.url = String(url);
      this.readyState = 0;
      this.protocol = '';
      this.binaryType = 'blob';
      this.onopen = null; this.onmessage = null; this.onclose = null; this.onerror = null;
      setTimeout(() => {
        this.readyState = 1;
        if (typeof this.onopen === 'function') this.onopen({ type: 'open' });
      }, 20);
    }
    send() { /* accepted, dropped: this harness injects frames */ }
    close() {
      if (this.readyState === 3) return;
      this.readyState = 3;
      setTimeout(() => {
        if (typeof this.onclose === 'function') this.onclose({ type: 'close', code: 1000, wasClean: true });
      }, 0);
    }
    addEventListener(type, fn) {
      const key = `on${type}`;
      const prev = this[key];
      this[key] = (event) => { if (typeof prev === 'function') prev.call(this, event); fn.call(this, event); };
    }
    removeEventListener() { /* one listener per type in mmo-client */ }
  }
  try {
    Object.defineProperty(window, 'WebSocket', { value: StubWebSocket, configurable: true, writable: true });
  } catch { window.WebSocket = StubWebSocket; }
}

async function openPage(browser, viewport, { holdPlay, stub } = {}) {
  const page = await browser.newPage();
  await page.setViewport({ ...viewport, deviceScaleFactor: 1 });
  const errors = [];
  watch(page, errors);
  if (stub) await page.evaluateOnNewDocument(stubSocket);
  if (holdPlay) {
    await page.setRequestInterception(true);
    page.on('request', (req) => {
      const url = req.url();
      // Hold the disc/BIOS fetches so the play document never boots the core:
      // the HUD is what we are shooting, the emulator screen is not.
      if (/\/rom\//.test(url) || /\/bios\//.test(url)) return; // never continues
      req.continue().catch(() => {});
    });
  }
  return { page, errors };
}

function selectShots() {
  if (!ONLY) return SHOTS;
  const want = new Set(ONLY.split(',').map((s) => s.trim()).filter(Boolean));
  const picked = SHOTS.filter((s) => want.has(s.name));
  if (!picked.length) {
    console.log(`FAIL  --only ${ONLY}: no shot by that name. Known: ${SHOTS.map((s) => s.name).join(', ')}`);
    process.exit(2);
  }
  return picked;
}

/* ------------------------------------------------------------------ main --- */

const startedAt = new Date();
const t0 = Date.now();
const rows = [];
const log = [];
let spectateFallback = false;

function emit(line) {
  log.push(line);
  console.log(line);
}

let browser = null;
const run = {
  run: 'mmo-shots.mjs',
  startedAt: startedAt.toISOString(),
  base: BASE,
  quick: QUICK,
  live: LIVE,
  only: ONLY || null,
  browser: null,
  shots: [],
  totals: null,
  durationMs: null,
};

try {
  const executablePath = fs.existsSync(BRAVE) ? BRAVE : CHROME;
  browser = await puppeteer.launch({
    executablePath,
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
  run.browser = await browser.version();
  emit(`# Race Day shots — ${run.browser} @ ${BASE}${QUICK ? ' (quick: desktop only)' : ''}`);

  const viewports = QUICK ? [['desktop', DESKTOP]] : [['desktop', DESKTOP], ['mobile', MOBILE]];
  const selected = selectShots();

  for (const shot of selected) {
    for (const [vpName, vp] of viewports) {
      const file = `mmo-shot-${shot.name}-${vpName}.png`;
      const entry = {
        shot: shot.name,
        viewport: vpName,
        path: `_runtime/${file}`,
        overflow: null,
        overflowPx: null,
        wide: [],
        badText: [],
        errors: [],
        method: shot.method,
        note: shot.note,
        socket: null,
        expect: false,
        facts: null,
        pass: false,
        reason: null,
      };
      let page = null;
      try {
        const stub = shot.name !== 'welcome-entry';
        const opened = await openPage(browser, vp, { holdPlay: shot.name === 'hud', stub });
        page = opened.page;
        entry.errors = opened.errors;
        entry.socket = stub ? 'stub-open (no server frames)' : 'live';
        const resp = await page.goto(shot.url, { waitUntil: 'domcontentloaded', timeout: 30000 });
        entry.status = resp ? resp.status() : null;
        spectateFallback = false;
        if (shot.name === 'hud') {
          await page.waitForFunction(() => !!(window.__R4_MMO && window.__R4_MMO.hud), { timeout: 30000 });
        } else if (shot.name === 'shell-embedded' || shot.name === 'welcome-entry') {
          // No /race-day store on these documents; the shots' own drive() waits.
        } else {
          await page.waitForFunction(
            () => !!(window.__R4_MMO && window.__R4_MMO.client) && !!(window.__R4_MMO_UI && window.__R4_MMO_UI.ui),
            { timeout: 20000 },
          );
          // mmo.html's boot strip (LINKING TO RACE DAY) is an overlay: wait for
          // it to hide so the capture is the page, not the boot curtain.
          await page.waitForFunction(() => {
            const s = document.getElementById('mmoBoot');
            return !s || s.hidden;
          }, { timeout: 12000 }).catch(() => {});
        }
        await shot.drive(page);
        if (spectateFallback) {
          entry.method = 'module';
          entry.note = `${entry.note} [mmo.html did not load mmo-spectate.js; the harness mounted the module]`;
        }

        // Shell shot: the states worth checking live inside #rr4sFrame.
        if (shot.name === 'shell-embedded') {
          const frame = page.frames().find((fr) => /\/race-day/.test(fr.url()));
          const probe = await page.evaluate(probeInPage);
          const inFrame = await frame.evaluate(probeInPage);
          entry.overflow = probe.overflow || inFrame.overflow;
          entry.overflowPx = Math.max(probe.overflowPx, inFrame.overflowPx);
          entry.wide = probe.wide.concat(inFrame.wide.map((w) => ({ ...w, inFrame: true })));
          entry.badText = probe.badText.concat(inFrame.badText.map((b) => ({ ...b, inFrame: true })));
          entry.facts = {
            embedded: !!frame,
            barHidden: await page.evaluate(() => {
              const b = document.getElementById('rr4sBar');
              return b ? b.getBoundingClientRect().height > 0 : null;
            }),
            frameGridCount: inFrame.facts.gridCount,
            frameState: inFrame.facts.state,
            frameQueue: inFrame.facts.queue,
            frameTrack: inFrame.facts.track,
          };
          entry.expect = !!shot.expect(entry, vpName);
        } else {
          const probe = await page.evaluate(probeInPage);
          entry.overflow = probe.overflow;
          entry.overflowPx = probe.overflowPx;
          entry.wide = probe.wide;
          entry.badText = probe.badText;
          entry.facts = probe.facts;
          entry.root = probe.root;
          entry.applied = probe.applied;
          entry.scrollWidth = probe.scrollWidth;
          entry.expect = !!shot.expect(entry.facts ? { facts: entry.facts, ...probe } : probe, vpName);
        }

        await page.screenshot({ path: path.join(OUT, file) });
        entry.errors = opened.errors.slice();

        const problems = [];
        if (entry.overflow) problems.push(`h-overflow ${entry.overflowPx}px`);
        if (entry.wide.length) problems.push(`wide ${entry.wide[0].el} ${entry.wide[0].w}px`);
        if (entry.badText.length) problems.push(`bad text ${entry.badText[0].el}: "${entry.badText[0].text}"`);
        if (entry.errors.length) problems.push(`${entry.errors.length} error(s): ${entry.errors[0].text.slice(0, 80)}`);
        if (!entry.expect) problems.push('state assertion failed');
        entry.pass = problems.length === 0;
        entry.reason = problems.join(' | ') || null;
      } catch (err) {
        entry.pass = false;
        entry.reason = `drive failed: ${String(err && err.message || err).slice(0, 200)}`;
        if (page) { try { await page.screenshot({ path: path.join(OUT, `mmo-shot-${shot.name}-${vpName}-failed.png`) }); } catch { /* ignore */ } }
      } finally {
        run.shots.push(entry);
        rows.push(entry);
        emit(`${entry.pass ? 'PASS' : 'FAIL'}  ${entry.shot.padEnd(18)} ${entry.viewport.padEnd(7)} ${entry.method.padEnd(7)} ${entry.pass ? '' : entry.reason}`);
        if (page) { try { await page.close(); } catch { /* ignore */ } }
      }
    }
  }

  /* --live: one real socket state, deliberately not injected. */
  if (LIVE && (!ONLY || ONLY === 'live-lobby')) {
    for (const [vpName, vp] of viewports) {
      const file = `mmo-shot-live-lobby-${vpName}.png`;
      const entry = {
        shot: 'live-lobby', viewport: vpName, path: `_runtime/${file}`,
        overflow: null, wide: [], badText: [], errors: [], method: 'live',
        note: 'real /mmo socket, whatever the server currently serves (no injection)',
        expect: false, facts: null, pass: false, reason: null,
      };
      let page = null;
      try {
        const opened = await openPage(browser, vp);
        page = opened.page;
        entry.errors = opened.errors;
        entry.socket = 'live';
        await page.goto(`${BASE}/race-day`, { waitUntil: 'domcontentloaded', timeout: 30000 });
        await page.waitForFunction(() => {
          const g = window.__R4_MMO;
          return !!(g && g.client) && g.client.state.conn === 'open';
        }, { timeout: 20000 });
        await sleep(1200);
        const state = await page.evaluate(() => {
          const s = window.__R4_MMO.client.state;
          return { conn: s.conn, seated: s.grid.counts.seated, max: s.event.counts.max, phase: s.event.state, elapsed: Date.now() - s.updatedAt };
        });
        const probe = await page.evaluate(probeInPage);
        await page.screenshot({ path: path.join(OUT, file) });
        entry.overflow = probe.overflow;
        entry.overflowPx = probe.overflowPx;
        entry.wide = probe.wide;
        entry.badText = probe.badText;
        entry.facts = { ...probe.facts, liveSocket: state };
        entry.expect = state.conn === 'open';
        const problems = [];
        if (entry.overflow) problems.push(`h-overflow ${entry.overflowPx}px`);
        if (entry.wide.length) problems.push(`wide ${entry.wide[0].el} ${entry.wide[0].w}px`);
        if (entry.badText.length) problems.push(`bad text ${entry.badText[0].el}: "${entry.badText[0].text}"`);
        if (entry.errors.length) problems.push(`${entry.errors.length} error(s): ${entry.errors[0].text.slice(0, 80)}`);
        if (!entry.expect) problems.push('socket never opened');
        entry.pass = problems.length === 0;
        entry.reason = problems.join(' | ') || null;
      } catch (err) {
        entry.reason = `drive failed: ${String(err && err.message || err).slice(0, 200)}`;
      } finally {
        run.shots.push(entry);
        rows.push(entry);
        emit(`${entry.pass ? 'PASS' : 'FAIL'}  ${entry.shot.padEnd(18)} ${entry.viewport.padEnd(7)} live    ${entry.pass ? (entry.facts && entry.facts.liveSocket ? `conn=open ${entry.facts.liveSocket.seated}/${entry.facts.liveSocket.max} phase=${entry.facts.liveSocket.phase}` : '') : entry.reason}`);
        if (page) { try { await page.close(); } catch { /* ignore */ } }
      }
    }
  }
} catch (err) {
  emit(`FAIL  harness: ${String(err && err.stack || err).slice(0, 400)}`);
  run.harnessError = String(err && err.message || err);
} finally {
  if (browser) { try { await browser.close(); } catch { /* ignore */ } }
}

const pass = rows.filter((r) => r.pass).length;
run.totals = { captures: rows.length, pass, fail: rows.length - pass };
run.durationMs = Date.now() - t0;

emit('');
emit(`# ${pass}/${rows.length} captures PASS in ${(run.durationMs / 1000).toFixed(1)}s`);
for (const r of rows.filter((x) => !x.pass)) {
  emit(`# fail: ${r.shot} @ ${r.viewport} — ${r.reason}`);
}

fs.writeFileSync(path.join(OUT, 'mmo-shots.json'), JSON.stringify(run, null, 2), 'utf8');
emit(`# wrote _runtime/mmo-shots.json (${run.shots.length} entries) + ${run.shots.length} png`);

process.exit(pass === rows.length ? 0 : 1);
