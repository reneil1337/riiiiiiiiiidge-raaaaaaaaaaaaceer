// Race Day — spectator board evidence (public/js/mmo-spectate.js).
//
// Drives Brave via puppeteer-core against the running MMO cabinet on :8097
// (never starts or stops a server), opens /race-day?spectate=1, injects
// synthetic /mmo frames through window.__R4_MMO.client._debug.inject and
// asserts the watch-only contract:
//   - `spectate` is the only intent frame; no queue / telemetry / finish / start
//   - 12 rows max out of a 50-row standings frame, patched cells not rebuilt DOM
//   - lead-change line updates, live race clock comes from the leader raceTimeMs
//   - results frame renders the final table + NEXT RACE IN
//   - 390x844 and 1440x900 screenshots, 0 overflow, 0 page errors
//
// Run: node mmo-spectate-test.mjs
// Writes: _runtime/mmo-spectate.json, _runtime/mmo-spectate.log,
//         _runtime/mmo-spectate-mobile-390x844.png,
//         _runtime/mmo-spectate-desktop-1440x900.png

import puppeteer from 'puppeteer-core';
import fs from 'node:fs';
import path from 'node:path';

const BRAVE = 'C:/Program Files/BraveSoftware/Brave-Browser/Application/brave.exe';
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const BASE = 'http://127.0.0.1:8097';
const OUT = path.resolve('../_runtime');
const MOBILE = { width: 390, height: 844 };
const DESKTOP = { width: 1440, height: 900 };
const SHOT_MOBILE = path.join(OUT, 'mmo-spectate-mobile-390x844.png');
const SHOT_DESKTOP = path.join(OUT, 'mmo-spectate-desktop-1440x900.png');
const SHOT_LIVE = path.join(OUT, 'mmo-spectate-live.png');
const SHOT_RESULTS = path.join(OUT, 'mmo-spectate-results-390x844.png');

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

/* ------------------------------------------------------------- frames ---- */

const TEAMS = ['Solvalou', 'Pac Racing Club', 'Micro Mouse Mappy', 'Dig Racing Team'];
const NAMES = {
  1: 'PLAYER 07', 2: 'DRIVER-02', 3: 'SOLVALOU-03', 4: 'DRIVER-04', 5: 'DRIVER-05',
  6: 'DRIVER-06', 7: 'BOT-07', 8: 'DRIVER-08', 9: 'DRIVER-09', 10: 'DRIVER-10',
  11: 'DRIVER-11', 12: 'DRIVER-12',
};
const nameOf = (seat) => NAMES[seat] || `DRIVER-${String(seat).padStart(2, '0')}`;
const teamOf = (seat) => TEAMS[(seat - 1) % 4];

function gridFrame({ named = 37 } = {}) {
  const seats = [];
  for (let seat = 1; seat <= 50; seat += 1) {
    const occupied = seat <= named;
    const bot = occupied && seat % 7 === 0;
    seats.push({
      seat,
      team: teamOf(seat),
      name: occupied ? (bot && !NAMES[seat] ? `BOT-${String(seat).padStart(2, '0')}` : nameOf(seat)) : '',
      driverId: occupied ? `drv-${seat}` : '',
      bot,
      state: occupied ? 'seated' : 'empty',
      connected: occupied,
    });
  }
  return {
    type: 'grid',
    event: 'evt-1',
    seats,
    counts: { seated: named, queued: named, max: 50 },
  };
}

function eventFrame(state, extra = {}) {
  return {
    type: 'event',
    event: 'evt-1',
    id: 'evt-1',
    index: 12,
    state,
    plan: {
      trackIndex: 4,
      trackName: 'Phantomile',
      carClass: 'D',
      startsAt: Date.now() + 3000,
    },
    counts: { seated: 37, queued: 37, max: 50, ...(extra.counts || {}) },
  };
}

function standingsFrame({ leaderSeat = 1, clock = 41200 } = {}) {
  const order = [];
  for (let seat = 1; seat <= 50; seat += 1) order.push(seat);
  const seats = order.filter((s) => s !== leaderSeat);
  seats.unshift(leaderSeat);
  const rows = seats.map((seat, i) => {
    const position = i + 1;
    const gapLap = position === 6; // one lapped car: gapMs null + gapLap
    const row = {
      seat,
      name: nameOf(seat),
      team: teamOf(seat),
      lap: 2,
      raceTimeMs: i === 0 ? clock : clock + 700 + i * 800,
      gapMs: position === 1 ? 0 : (gapLap ? null : 800 * (position - 1)),
      gapLap,
      position,
      bot: seat === 7,
      state: 'racing',
    };
    if (position === 2) row.bestLapMs = 39800;
    if (position === 3) row.bestLapMs = 40100;
    return row;
  });
  return { type: 'standings', event: 'evt-1', rows, you: null, lap: 2, top: 10 };
}

function resultFrame({ clock = 41200 } = {}) {
  const rows = [];
  for (let position = 1; position <= 50; position += 1) {
    const seat = position;
    rows.push({
      seat,
      name: nameOf(seat),
      team: teamOf(seat),
      lap: 3,
      raceTimeMs: clock + position * 800,
      gapMs: position === 1 ? 0 : 800 * (position - 1),
      gapLap: position === 1,
      position,
      bot: seat === 7,
      state: position <= 44 ? 'finished' : 'dnf',
      finished: position <= 44,
      speedKph: 180 - position,
      ...(position <= 3 ? { bestLapMs: 39600 + position * 100 } : {}),
    });
  }
  return { type: 'result', event: 'evt-1', rows, you: null, finishedAt: Date.now() };
}

function partyFrame() {
  return {
    type: 'party',
    code: 'ABCD',
    size: 2,
    members: [
      { driverId: 'drv-3', name: nameOf(3), seat: 3 },
      { driverId: 'spec-friend', name: 'PHONE-FRIEND', seat: 0 },
    ],
  };
}

/* ------------------------------------------------------------ browser ---- */

const pageErrors = [];
const consoleErrors = [];
const IGNORE_CONSOLE = [
  /Failed to load resource/i,
  /WebSocket/i,
  /net::ERR_/i,
  /favicon/i,
  /No ICE servers/i,
];

let browser = null;

async function main() {
  const executablePath = fs.existsSync(BRAVE) ? BRAVE : CHROME;
  browser = await puppeteer.launch({
    executablePath,
    headless: true,
    protocolTimeout: 120000,
    defaultViewport: MOBILE,
    args: [
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-background-timer-throttling',
      '--disable-renderer-backgrounding',
      '--autoplay-policy=no-user-gesture-required',
      `--window-size=${MOBILE.width},${MOBILE.height}`,
    ],
  });

  const page = await browser.newPage();
  await page.setViewport(MOBILE);
  page.on('pageerror', (err) => pageErrors.push(String(err && err.message || err)));
  page.on('console', (msg) => {
    if (msg.type() !== 'error' && msg.type() !== 'warning') return;
    const text = msg.text();
    if (IGNORE_CONSOLE.some((rx) => rx.test(text))) return;
    if (msg.type() === 'error') consoleErrors.push(text);
  });

  const response = await page.goto(`${BASE}/race-day?spectate=1&party=ABCD`, {
    waitUntil: 'domcontentloaded',
    timeout: 30000,
  });
  record('S1', '/race-day?spectate=1 responds 200', !!response && response.status() === 200,
    `status=${response ? response.status() : 'none'}`);

  await page.waitForFunction(() => !!(window.__R4_MMO && window.__R4_MMO.client), { timeout: 15000 });

  // The page shell does not load this module yet (mmo.html is owned by another
  // agent), so the harness injects it exactly as the final <script> tag would.
  await page.addScriptTag({ type: 'module', url: `${BASE}/js/mmo-spectate.js` });
  await page.waitForFunction(() => !!(window.__R4_MMO_SPECTATE && window.__R4_MMO_SPECTATE.spectate), { timeout: 15000 });
  await sleep(300);

  /* ---- S2: hook + panel ---- */
  const mount = await page.evaluate(() => {
    const api = window.__R4_MMO_SPECTATE;
    const panel = api.panel || document.querySelector('[data-mmo-spectate-panel]');
    return {
      hook: !!(api && typeof api.render === 'function' && typeof api.inject === 'function'),
      panel: !!panel,
      panelId: panel ? (panel.id || panel.tagName) : null,
      inMain: !!(panel && panel.parentElement && panel.parentElement.id === 'mmoMain'),
      spectateMode: document.body.dataset.mmoSpectate === '1',
      hasQueueBtn: !!document.querySelector('#mmoLfgBtn'),
      hiddenLfg: (() => {
        const lfg = document.getElementById('mmoLfg');
        return !!lfg && getComputedStyle(lfg).display === 'none';
      })(),
    };
  });
  record('S2', 'window.__R4_MMO_SPECTATE {render, inject} + panel mounted in #mmoMain',
    mount.hook && mount.panel && mount.inMain && mount.spectateMode,
    `hook=${mount.hook} panel=${mount.panelId} inMain=${mount.inMain} spectate=${mount.spectateMode}`);
  record('S3', 'watch-only: the LFG (queue/start) panel is hidden, no seat controls shown',
    mount.hiddenLfg, `lfqDisplayNone=${mount.hiddenLfg}`);

  /* ---- S4: only the spectate intent is sent ---- */
  const sentLive = await page.evaluate(() => {
    const d = window.__R4_MMO.client._debug;
    const counts = {};
    for (const frame of d.sent()) counts[frame.type] = (counts[frame.type] || 0) + 1;
    return { counts, timers: d.timers() };
  });
  record('S4', 'spectate intent sent on mount', (sentLive.counts.spectate || 0) >= 1,
    `spectate=${sentLive.counts.spectate || 0} hello=${sentLive.counts.hello || 0}`);

  // A real socket paints the server's own event (no injection yet).
  const liveState = await page.evaluate(() => {
    const panel = window.__R4_MMO_SPECTATE.panel;
    const text = (sel) => (panel.querySelector(sel) || {}).textContent || '';
    return {
      conn: window.__R4_MMO.client.state.conn,
      serverPhase: window.__R4_MMO.client.state.event.state,
      phase: text('[data-sp-phase]'),
      life: text('[data-sp-life]'),
      clock: text('[data-sp-clock]'),
      battle: text('[data-sp-battle]'),
      rows: panel.querySelectorAll('[data-sp-row]:not([data-empty])').length,
    };
  });
  await page.screenshot({ path: SHOT_LIVE, fullPage: false });
  record('S4b', 'live socket paints the server event (no injection)',
    liveState.conn === 'open' && ['LOBBY', 'GRID', 'COUNTDOWN', 'RACING', 'RESULTS'].includes(liveState.phase)
      && /WAITING FOR DRIVERS|GRID LOCKED|COUNTDOWN|LIVE|RACE COMPLETE/.test(liveState.life),
    `conn=${liveState.conn} server=${liveState.serverPhase} board=${liveState.phase} "${liveState.life}"`);

  // Inject a live race while the socket is still open: a seated driver would
  // start the 4 Hz telemetry pump here; a spectator must send nothing.
  await page.evaluate((f1, f2) => {
    window.__R4_MMO_SPECTATE.inject(f1);
    window.__R4_MMO_SPECTATE.inject(f2);
  }, eventFrame('racing'), standingsFrame());
  await sleep(1400);
  const sentRacing = await page.evaluate(() => {
    const d = window.__R4_MMO.client._debug;
    return {
      queue: d.sentCount('queue'),
      telemetry: d.sentCount('telemetry'),
      finish: d.sentCount('finish'),
      start: d.sentCount('start'),
      unqueue: d.sentCount('unqueue'),
      history: d.telemetry().length,
      pump: d.timers().pump,
    };
  });
  // mmo-client starts its 4 Hz pump on any racing event; with no telemetry
  // reader installed a spectator's pump is a no-op (history stays empty).
  record('S5', 'no queue / telemetry / finish / start frames while spectating',
    sentRacing.queue === 0 && sentRacing.telemetry === 0 && sentRacing.finish === 0
      && sentRacing.start === 0 && sentRacing.unqueue === 0 && sentRacing.history === 0,
    `queue=${sentRacing.queue} telemetry=${sentRacing.telemetry} finish=${sentRacing.finish} start=${sentRacing.start} history=${sentRacing.history} pumpNoop=${sentRacing.pump}`);

  // Freeze the transport: from here the store is fed only by injected frames.
  await page.evaluate(() => { window.__R4_MMO.client.close(); });
  await sleep(250);

  /* ---- S6: lobby lifecycle + fill mirrored as text ---- */
  const lobby = await page.evaluate((grid, evt) => {
    const api = window.__R4_MMO_SPECTATE;
    api.inject(grid);
    api.inject(evt);
    const panel = api.panel;
    return {
      life: panel.querySelector('[data-sp-life]').textContent,
      bar: panel.querySelector('[data-sp-bar]').textContent,
      fill: panel.querySelector('[data-sp-filltext]').textContent,
      valueNow: panel.querySelector('[data-sp-fill]').getAttribute('aria-valuenow'),
      phase: panel.querySelector('[data-sp-phase]').textContent,
      phaseAttr: panel.querySelector('[data-sp-phase]').dataset.state,
      clock: panel.querySelector('[data-sp-clock]').textContent,
    };
  }, gridFrame(), eventFrame('lobby'));
  record('S6', 'lobby → "WAITING FOR DRIVERS · 37/50" + mirrored fill meter',
    /WAITING FOR DRIVERS · 37\/50/.test(lobby.life) && /37 \/ 50 SEATED/.test(lobby.fill)
      && /^\[#{7}-{3}\]$/.test(lobby.bar) && lobby.valueNow === '37' && lobby.phase === 'LOBBY',
    `life="${lobby.life}" bar="${lobby.bar}" fill="${lobby.fill}"`);
  record('S7', 'lobby clock reads 0:00.0 (nothing runs before the green)',
    lobby.clock === '0:00.0', `clock=${lobby.clock}`);

  /* ---- S8: grid + countdown lifecycle ---- */
  const gridPhase = await page.evaluate((evt) => {
    const api = window.__R4_MMO_SPECTATE;
    api.inject(evt);
    const panel = api.panel;
    return {
      life: panel.querySelector('[data-sp-life]').textContent,
      phase: panel.querySelector('[data-sp-phase]').textContent,
      rows: panel.querySelectorAll('[data-sp-row]').length,
    };
  }, eventFrame('grid'));
  record('S8', 'grid → "GRID LOCKED" + track, board shows the locked seats',
    /GRID LOCKED/.test(gridPhase.life) && /PHANTOMILE/.test(gridPhase.life)
      && gridPhase.phase === 'GRID' && gridPhase.rows === 12,
    `life="${gridPhase.life}" rows=${gridPhase.rows}`);

  const countdown = await page.evaluate((cd, evt) => {
    const api = window.__R4_MMO_SPECTATE;
    api.inject(cd);
    api.inject(evt);
    const panel = api.panel;
    const box = panel.querySelector('[data-sp-count]');
    return {
      hidden: box.hidden,
      n: panel.querySelector('[data-sp-countn]').textContent,
      life: panel.querySelector('[data-sp-life]').textContent,
      phase: panel.querySelector('[data-sp-phase]').textContent,
    };
  }, { type: 'countdown', n: 3, startsAt: Date.now() + 3000 }, eventFrame('countdown'));
  record('S9', 'countdown → the same 3-2-1 overlay', !countdown.hidden && countdown.n === '3'
    && /COUNTDOWN · 3/.test(countdown.life) && countdown.phase === 'COUNTDOWN',
    `n=${countdown.n} life="${countdown.life}"`);

  /* ---- S10: live board from a 50-row standings frame ---- */
  const racing = await page.evaluate((evt, st) => {
    const api = window.__R4_MMO_SPECTATE;
    api.inject(evt);
    api.inject(st);
    const panel = api.panel;
    const rows = Array.from(panel.querySelectorAll('[data-sp-row]:not([data-empty])'));
    const cells = (row, key) => row.querySelector(`[data-cell="${key}"]`).textContent;
    const nameOf2 = (row) => row.querySelector('[data-sp-name]').textContent;
    return {
      rows: rows.length,
      totalInjected: st.rows.length,
      positions: rows.map((r) => r.querySelector('[data-cell="pos"]').textContent),
      first: {
        seat: rows[0].dataset.seat,
        name: nameOf2(rows[0]),
        lap: cells(rows[0], 'lap'),
        best: cells(rows[0], 'best'),
        gap: cells(rows[0], 'gap'),
        botShown: !rows[0].querySelector('[data-cell="name"] .mmo-sp-bot').hidden,
      },
      second: { name: nameOf2(rows[1]), gap: cells(rows[1], 'gap'), best: cells(rows[1], 'best') },
      seventh: {
        name: nameOf2(rows[6]),
        botShown: !rows[6].querySelector('[data-cell="name"] .mmo-sp-bot').hidden,
      },
      sixth: { gap: cells(rows[5], 'gap') },
      emptyHidden: panel.querySelector('[data-sp-empty]').hidden,
      clock: panel.querySelector('[data-sp-clock]').textContent,
      life: panel.querySelector('[data-sp-life]').textContent,
      battle: panel.querySelector('[data-sp-gaps]').textContent,
      lead: panel.querySelector('[data-sp-lead]').textContent,
      phase: panel.querySelector('[data-sp-phase]').textContent,
      stats: api.stats(),
    };
  }, eventFrame('racing'), standingsFrame());
  record('S10', 'standings frame with 50 rows → board renders the top 12 only',
    racing.rows === 12 && racing.totalInjected === 50 && racing.emptyHidden === true
      && racing.positions.join(',') === '1,2,3,4,5,6,7,8,9,10,11,12',
    `domRows=${racing.rows} injected=${racing.totalInjected} positions=${racing.positions.join(',')}`);
  record('S11', 'row cells: name / lap / BEST / GAP (leader + P2 + BOT tag)',
    racing.first.name === 'PLAYER 07' && racing.first.lap === '2' && racing.first.best === '—'
      && racing.first.botShown === false && racing.seventh.botShown === true
      && racing.second.best === '0:39.8' && racing.second.gap === '+0.8' && racing.sixth.gap === 'LAP',
    `p1=${racing.first.name} lap=${racing.first.lap} p2best=${racing.second.best} p2gap=${racing.second.gap} p6gap=${racing.sixth.gap} botTag=${racing.seventh.botShown}`);
  record('S12', 'race clock derived from the leader raceTimeMs (0:41.2)',
    racing.clock === '0:41.2' && /LIVE · LAP 2/.test(racing.life) && racing.phase === 'RACING',
    `clock=${racing.clock} life="${racing.life}"`);
  record('S13', 'battle for the lead line: "P1 +0.0 · P2 +0.8 · P3 +1.6"',
    racing.battle === 'P1 +0.0 · P2 +0.8 · P3 +1.6' && racing.lead === 'LEAD · PLAYER 07',
    `battle="${racing.battle}" lead="${racing.lead}"`);

  /* ---- S14: party row + party dot ---- */
  const party = await page.evaluate((frame) => {
    const api = window.__R4_MMO_SPECTATE;
    api.inject(frame);
    const panel = api.panel;
    const friends = panel.querySelector('[data-sp-friends]');
    const chips = Array.from(friends.querySelectorAll('.mmo-sp-friend')).map((c) => c.textContent);
    const rows = Array.from(panel.querySelectorAll('[data-sp-row]:not([data-empty])'));
    return {
      visible: !friends.hidden,
      label: friends.querySelector('.mmo-sp-friends-label').textContent,
      chips,
      dotted: rows.filter((r) => r.dataset.party === '1').map((r) => r.dataset.seat),
      dotVisible: rows.filter((r) => r.dataset.seat === '3')
        .map((r) => !r.querySelector('[data-sp-party]').hidden),
      rows: rows.length,
    };
  }, partyFrame());
  record('S14', '?party=ABCD → friends row + party dot on the member row',
    party.visible && /YOUR FRIENDS · ABCD/.test(party.label) && party.chips.length === 2
      && party.dotted.join(',') === '3' && party.dotVisible[0] === true && party.rows === 12,
    `chips=${JSON.stringify(party.chips)} dotted=${party.dotted.join(',')} rows=${party.rows}`);

  /* ---- S15: patch, don't rebuild (2 Hz safe) ---- */
  const patch = await page.evaluate((st) => {
    const api = window.__R4_MMO_SPECTATE;
    const panel = api.panel;
    const before = panel.querySelector('[data-sp-rows] [data-sp-row]');
    before.__probe = 'kept';
    const beforeStats = api.stats();
    api.inject(st); // identical payload: nothing may change
    const after = panel.querySelector('[data-sp-rows] [data-sp-row]');
    const afterStats = api.stats();
    return {
      sameNode: before === after && after.__probe === 'kept',
      writes: afterStats.cellWrites - beforeStats.cellWrites,
      rowWrites: afterStats.rowWrites - beforeStats.rowWrites,
      renders: afterStats.renders - beforeStats.renders,
    };
  }, standingsFrame());
  record('S15', 'identical 2 Hz frame patches zero cells and keeps the same row nodes',
    patch.sameNode && patch.writes === 0 && patch.rowWrites === 0 && patch.renders >= 1,
    `sameNode=${patch.sameNode} cellWrites=${patch.writes} rowWrites=${patch.rowWrites} renders=${patch.renders}`);

  /* ---- S16: lead change + a11y ---- */
  const leadChange = await page.evaluate((st) => {
    const api = window.__R4_MMO_SPECTATE;
    const panel = api.panel;
    const before = panel.querySelector('[data-sp-battle]').textContent;
    const beforeLead = panel.querySelector('[data-sp-lead]').textContent;
    const beforeChanges = api.stats().leadChanges;
    api.inject(st);
    const live = panel.querySelectorAll('[aria-live="polite"]');
    const table = panel.querySelector('[role="table"]');
    const hrow = panel.querySelector('.mmo-sp-hrow');
    const rows = panel.querySelectorAll('[role="row"]');
    const cellsCount = panel.querySelectorAll('[role="cell"]').length;
    return {
      before, after: panel.querySelector('[data-sp-battle]').textContent,
      beforeLead, afterLead: panel.querySelector('[data-sp-lead]').textContent,
      changes: api.stats().leadChanges - beforeChanges,
      liveCount: live.length,
      liveText: live.length ? live[0].textContent : '',
      liveAttr: live.length ? live[0].getAttribute('aria-live') : '',
      tableRole: table ? table.getAttribute('role') : '',
      tableLabel: table ? table.getAttribute('aria-label') : '',
      sticky: hrow ? getComputedStyle(hrow).position : '',
      rowRoles: rows.length,
      cells: cellsCount,
      flash: panel.querySelector('[data-sp-battle]').dataset.flash,
    };
  }, standingsFrame({ leaderSeat: 4, clock: 43800 }));
  record('S16', 'lead change updates the battle line and re-announces once',
    leadChange.after !== leadChange.before && /^LEAD · DRIVER-04$/.test(leadChange.afterLead)
      && leadChange.beforeLead === 'LEAD · PLAYER 07' && leadChange.changes === 1,
    `before="${leadChange.beforeLead}" after="${leadChange.afterLead}" battle="${leadChange.after}"`);
  record('S17', 'a11y: one polite live region (the lead line), role=table, sticky header',
    leadChange.liveCount === 1 && leadChange.liveAttr === 'polite'
      && /^LEAD · /.test(leadChange.liveText) && leadChange.tableRole === 'table'
      && /leaderboard/i.test(leadChange.tableLabel) && leadChange.sticky === 'sticky'
      && leadChange.rowRoles === 14 && leadChange.cells === 65,
    `live=${leadChange.liveCount} table=${leadChange.tableRole} sticky=${leadChange.sticky} rows=${leadChange.rowRoles} cells=${leadChange.cells}`);

  /* ---- S18: clock never drifts locally + watching chip ---- */
  const clockNow = await page.evaluate(() => window.__R4_MMO_SPECTATE.panel.querySelector('[data-sp-clock]').textContent);
  await sleep(900);
  const clockLater = await page.evaluate(() => ({
    clock: window.__R4_MMO_SPECTATE.panel.querySelector('[data-sp-clock]').textContent,
    watchingHidden: window.__R4_MMO_SPECTATE.panel.querySelector('[data-sp-watching]').hidden,
  }));
  record('S18', 'clock does not tick locally between frames (no drifting stopwatch)',
    clockNow === clockLater.clock && clockNow === '0:43.8',
    `now=${clockNow} +900ms=${clockLater.clock}`);
  record('S19', 'no counts.spectators in the frame → WATCHING chip hidden (not a fake 0)',
    clockLater.watchingHidden === true, `hidden=${clockLater.watchingHidden}`);

  const watching = await page.evaluate((evt) => {
    const api = window.__R4_MMO_SPECTATE;
    api.inject(evt);
    const chip = api.panel.querySelector('[data-sp-watching]');
    return { hidden: chip.hidden, text: chip.textContent };
  }, eventFrame('racing', { counts: { spectators: 12 } }));
  record('S20', 'server exposes counts.spectators → "12 WATCHING"',
    watching.hidden === false && watching.text === '12 WATCHING',
    `hidden=${watching.hidden} text="${watching.text}"`);

  /* ---- S21: mobile layout (390x844) ---- */
  const mobileLayout = await page.evaluate(() => {
    const doc = document.scrollingElement || document.documentElement;
    const panel = window.__R4_MMO_SPECTATE.panel;
    const board = panel.querySelector('[data-sp-board]');
    const hrow = panel.querySelector('.mmo-sp-hrow');
    const action = panel.querySelector('.mmo-sp-action');
    return {
      viewport: { w: window.innerWidth, h: window.innerHeight },
      docOverflow: doc.scrollWidth - window.innerWidth,
      boardOverflow: board.scrollWidth - board.clientWidth,
      boardWidth: Math.round(board.getBoundingClientRect().width),
      boardRight: Math.round(board.getBoundingClientRect().right),
      actionH: Math.round(action.getBoundingClientRect().height),
      hrowTop: Math.round(hrow.getBoundingClientRect().top),
      panelLeft: Math.round(panel.getBoundingClientRect().left),
    };
  });
  record('S21', 'mobile 390x844: no horizontal scroll, board inside the viewport',
    mobileLayout.viewport.w === 390 && mobileLayout.docOverflow <= 0 && mobileLayout.boardOverflow <= 0
      && mobileLayout.boardRight <= 390,
    `vw=${mobileLayout.viewport.w} docOverflow=${mobileLayout.docOverflow} boardOverflow=${mobileLayout.boardOverflow} right=${mobileLayout.boardRight}`);
  record('S22', 'mobile touch target for the panel actions is >= 44 px',
    mobileLayout.actionH >= 44, `actionHeight=${mobileLayout.actionH}px (pointer:coarse applies in headless)`);
  await page.screenshot({ path: SHOT_MOBILE, fullPage: false });

  /* ---- S23: results ---- */
  const resultsPhase = await page.evaluate((res, evt) => {
    const api = window.__R4_MMO_SPECTATE;
    api.inject(res);
    api.inject(evt);
    const panel = api.panel;
    const rows = Array.from(panel.querySelectorAll('[data-sp-row]:not([data-empty])'));
    const next = panel.querySelector('[data-sp-next]');
    return {
      rows: rows.length,
      first: rows[0].querySelector('[data-sp-name]').textContent,
      firstPos: rows[0].querySelector('[data-cell="pos"]').textContent,
      firstBest: rows[0].querySelector('[data-cell="best"]').textContent,
      nextHidden: next.hidden,
      nextText: next.textContent,
      phase: panel.querySelector('[data-sp-phase]').textContent,
      life: panel.querySelector('[data-sp-life]').textContent,
      clock: panel.querySelector('[data-sp-clock]').textContent,
    };
  }, resultFrame(), eventFrame('results'));
  record('S23', 'results frame → final table (top 12) + NEXT RACE IN 00:xx',
    resultsPhase.rows === 12 && resultsPhase.first === 'PLAYER 07' && resultsPhase.firstPos === '1'
      && resultsPhase.nextHidden === false && /^NEXT RACE IN \d{2}:\d{2}$/.test(resultsPhase.nextText)
      && resultsPhase.phase === 'RESULTS',
    `rows=${resultsPhase.rows} next="${resultsPhase.nextText}" clock=${resultsPhase.clock} life="${resultsPhase.life}"`);
  await page.screenshot({ path: SHOT_RESULTS, fullPage: false });

  /* ---- S24: desktop 1440x900 ---- */
  await page.setViewport(DESKTOP);
  await page.evaluate((evt, st) => {
    const api = window.__R4_MMO_SPECTATE;
    api.inject(evt);
    api.inject(st);
  }, eventFrame('racing'), standingsFrame({ leaderSeat: 4, clock: 43800 }));
  await sleep(300);
  const desktopLayout = await page.evaluate(() => {
    const doc = document.scrollingElement || document.documentElement;
    const panel = window.__R4_MMO_SPECTATE.panel;
    const board = panel.querySelector('[data-sp-board]');
    return {
      viewport: { w: window.innerWidth, h: window.innerHeight },
      docOverflow: doc.scrollWidth - window.innerWidth,
      boardOverflow: board.scrollWidth - board.clientWidth,
      rows: panel.querySelectorAll('[data-sp-row]:not([data-empty])').length,
      gridVisible: (() => {
        const grid = document.getElementById('mmoGrid');
        return !!grid && getComputedStyle(grid).display !== 'none';
      })(),
    };
  });
  record('S24', 'desktop 1440x900: no horizontal scroll, 12 rows, grid context still visible',
    desktopLayout.viewport.w === 1440 && desktopLayout.docOverflow <= 0
      && desktopLayout.boardOverflow <= 0 && desktopLayout.rows === 12 && desktopLayout.gridVisible === true,
    `vw=${desktopLayout.viewport.w} docOverflow=${desktopLayout.docOverflow} boardOverflow=${desktopLayout.boardOverflow} rows=${desktopLayout.rows}`);
  await page.screenshot({ path: SHOT_DESKTOP, fullPage: false });

  /* ---- S25: reduced motion ---- */
  await page.emulateMediaFeatures([{ name: 'prefers-reduced-motion', value: 'reduce' }]);
  const reduced = await page.evaluate((st) => {
    const api = window.__R4_MMO_SPECTATE;
    api.inject(st); // new leader → flash attribute is set
    const panel = api.panel;
    const battle = panel.querySelector('[data-sp-battle]');
    battle.dataset.flash = '1';
    return {
      flash: getComputedStyle(battle).animationName,
      count: getComputedStyle(panel.querySelector('[data-sp-countn]')).animationName,
    };
  }, standingsFrame({ leaderSeat: 6, clock: 44100 }));
  record('S25', 'prefers-reduced-motion: lead flash + countdown animations are off',
    reduced.flash === 'none' && reduced.count === 'none',
    `flash=${reduced.flash} count=${reduced.count}`);
  await page.emulateMediaFeatures([{ name: 'prefers-reduced-motion', value: 'no-preference' }]);

  /* ---- S26: errors ---- */
  record('S26', 'zero page errors', pageErrors.length === 0,
    pageErrors.length ? pageErrors.slice(0, 3).join(' | ') : 'none');
  record('S27', 'zero unexpected console errors', consoleErrors.length === 0,
    consoleErrors.length ? consoleErrors.slice(0, 3).join(' | ') : 'none');

  const passed = results.filter((r) => r.pass).length;
  const summary = {
    at: new Date().toISOString(),
    base: BASE,
    browser: { executablePath, version: await browser.version(), headless: true },
    viewports: { mobile: MOBILE, desktop: DESKTOP },
    shots: [SHOT_LIVE, SHOT_MOBILE, SHOT_DESKTOP, SHOT_RESULTS],
    live: liveState,
    passed,
    total: results.length,
    checks: results,
    stats: await page.evaluate(() => window.__R4_MMO_SPECTATE.stats()),
  };
  fs.writeFileSync(path.join(OUT, 'mmo-spectate.json'), JSON.stringify(summary, null, 2), 'utf8');
  fs.writeFileSync(path.join(OUT, 'mmo-spectate.log'), logLines.join('\r\n') + '\r\n', 'utf8');
  console.log(`\n${passed}/${results.length} checks passed`);
  return passed === results.length ? 0 : 1;
}

let code = 1;
try {
  code = await main();
} catch (err) {
  record('X0', 'harness completed', false, String(err && err.stack || err));
  console.log(String(err && err.stack || err));
  try {
    fs.writeFileSync(path.join(OUT, 'mmo-spectate.json'),
      JSON.stringify({ at: new Date().toISOString(), error: String(err && err.message || err), checks: results }, null, 2), 'utf8');
    fs.writeFileSync(path.join(OUT, 'mmo-spectate.log'), logLines.join('\r\n') + '\r\n', 'utf8');
  } catch { /* ignore */ }
} finally {
  if (browser) { try { await browser.close(); } catch { /* ignore */ } }
}
process.exit(code);
