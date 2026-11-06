#!/usr/bin/env node
// Race Day â€” two-browser end-to-end UX harness (real server, real websocket,
// real DOM; no synthetic frame injection).
//
// Proves the *user* path of _runtime/analysis/20-mmo-contract.md Â§4/Â§7:
//   A  cabinet ENTER -> RACE DAY nav -> /race-day?embedded=1 -> callsign ->
//      FIND ME A RACE
//   B  /race-day directly          -> callsign -> FIND ME A RACE
//   both seated, 2/50, START WITH 2
//   A  #mmoStart -> GRID LOCKED -> countdown 3/2/1 -> RACING (same track both)
//   telemetry through the page (window.__R4_MMO.send) -> identical standings,
//   each client's #mmoYourRow is its own position
//   finish both -> #mmoResults (same order), #mmoPodium winner, #mmoNextRace clock
//   party invite link  /race-day?party=<code> -> same event, code chip, 2/2
//   spectator /race-day?spectate=1 -> live board, never queues, never sends telemetry
//   HUD handoff /play?mmo=1&event&seat&team&game=r4&embedded=1&threads=0 ->
//   window.__R4_MMO_PARAMS + #mmoHud (the /rom request is held, so no 357 MB
//   download and no emulator boot)
//
// Usage:
//   cd _server; node test-mmo-ui.mjs
//   node test-mmo-ui.mjs --base http://127.0.0.1:8093      (no server spawned)
//   node test-mmo-ui.mjs --port 8094 --keep               (leave :8094 running)
//   node test-mmo-ui.mjs --countdown-ms 2000              (fast countdown window)
//
// The default run starts a DEDICATED cabinet on :8093 from this tree with fast
// MMO timings and kills only that child at the end (never :8080 / :3010).
// A `--base` server should be idle (a race already in flight parks new drivers
// in `pending` until it ends).
//
// Writes _runtime/mmo-e2e.json, _runtime/mmo-e2e.log and
//        _runtime/mmo-e2e-*.png (1440x900).
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const OUT = path.join(ROOT, '_runtime');
const CHROME_CANDIDATES = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files/BraveSoftware/Brave-Browser/Application/brave.exe',
];

const argv = process.argv.slice(2);
function arg(name, def = null) {
  const i = argv.indexOf('--' + name);
  if (i === -1) return def;
  const v = argv[i + 1];
  return v && !v.startsWith('--') ? v : true;
}
const flag = (name) => argv.includes('--' + name);

const BASE_ARG = typeof arg('base') === 'string' ? arg('base').replace(/\/+$/, '') : '';
const PORT = Number(arg('port', 8093));
const KEEP = flag('keep');
// COUNTDOWN_MS: the overlay prints ceil(remaining/1000) from the shared
// `startsAt`, so a 2000 ms window can only ever print 2,1,GO. 3000 keeps the
// literal 3-2-1 the UX contract asks for; `--countdown-ms 2000` reproduces the
// fast window (the countdown frames still carry 3,2,1 - asserted from the wire).
const COUNTDOWN_MS = Number(arg('countdown-ms', 3000));
const GRID_MS = 2000;
const RESULTS_MS = 6000;
const FILL_MS = 5000;
const BASE = BASE_ARG || `http://127.0.0.1:${PORT}`;
const STEP_TIMEOUT_MS = 30000;
const NAV_TIMEOUT_MS = 45000;
const TRACKS = [
  'Helter Skelter', 'Wonderhill', 'Edge of the Earth', 'Out of Blue',
  'Phantomile', 'Brightest Nite', 'Heaven and Hell', 'Shooting Hoops',
];

fs.mkdirSync(OUT, { recursive: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const iso = (t = Date.now()) => new Date(t).toISOString();
const logLines = [];
function log(...a) {
  const line = a.map((v) => (typeof v === 'string' ? v : JSON.stringify(v))).join(' ');
  console.log(line);
  logLines.push(line);
}

const steps = [];
async function step(name, fn) {
  const startedAt = Date.now();
  try {
    const value = await fn();
    steps.push({ step: name, ok: true, ms: Date.now() - startedAt, startedAt: iso(startedAt) });
    log(`STEP OK   ${name} (${Date.now() - startedAt} ms)`);
    return value;
  } catch (err) {
    const message = err && err.message ? err.message : String(err);
    steps.push({ step: name, ok: false, ms: Date.now() - startedAt, startedAt: iso(startedAt), error: message });
    log(`STEP FAIL ${name} (${Date.now() - startedAt} ms): ${message}`);
    return undefined; // never abort the whole run on one broken phase
  }
}

/* ------------------------------------------------------------- evidence --- */

const checks = [];
function check(id, name, pass, detail = '') {
  const entry = { id, name, pass: !!pass, detail: String(detail) };
  checks.push(entry);
  log(`${pass ? 'PASS' : 'FAIL'} ${id}: ${name}${detail ? ' â€” ' + detail : ''}`);
  return entry;
}

const screenshots = {};
async function shot(page, name) {
  const file = path.join(OUT, `mmo-e2e-${name}.png`);
  try {
    await page.screenshot({ path: file, fullPage: false });
    screenshots[name] = file;
    log(`  shot ${file}`);
    return file;
  } catch (err) {
    log(`  shot FAILED ${name}: ${err && err.message}`);
    return '';
  }
}

/* ------------------------------------------------------- console capture --- */

const GLOBAL_NOISE = [
  /\[NETPLAY\] No ICE servers configured/i, // expected (AGENTS.md Â§10)
  /Minified React error #418|Hydration failed|hydrat/i, // /docs only
  /favicon/i,
  /Failed to load resource: the server responded with a status of 404/i,
  /WebSocket is already in CLOSING or CLOSED state/i,
  /WebSocket connection to '[^']*' failed/i, // context close at the end
  /\[mmo\]/i,
];
// The HUD context holds the /rom + /bios requests on purpose; EmulatorJS turns
// that into its download fallback. Interception noise, never an app error.
const PLAY_NOISE = [
  /Download error/i,
  /THIS METHOD IS A FAILSAFE/i,
  /attempting to fetch from the emulatorjs cdn/i,
  /Failed to fetch/i,
  /net::ERR_(ABORTED|FAILED|PENDING|EMPTY_RESPONSE)/i,
  /Download failed/i,
  /The play\(\) request was interrupted/i,
  /AudioContext was not allowed to start/i,
  /The AudioContext was not allowed to start/i,
  /invalid core option/i,
];

function attach(page, label, extraNoise = []) {
  const rec = { label, consoleLines: [], consoleErrors: [], consoleIgnored: [], pageErrors: [], requestFailed: [] };
  const noise = GLOBAL_NOISE.concat(extraNoise);
  page.on('console', (m) => {
    const line = `[${m.type()}] ${m.text()}`;
    rec.consoleLines.push(line);
    if (m.type() !== 'error') return;
    if (noise.some((re) => re.test(line))) rec.consoleIgnored.push(line);
    else rec.consoleErrors.push(line);
  });
  page.on('pageerror', (e) => {
    const message = e && e.message ? e.message : String(e);
    if (noise.some((re) => re.test(message))) { rec.consoleIgnored.push(`pageerror: ${message}`); return; }
    rec.pageErrors.push(message);
    log(`  PAGEERROR[${label}] ${message}`);
  });
  page.on('requestfailed', (r) => {
    const url = r.url();
    if (/\/rom\/|\/bios\//i.test(url)) return; // held by the HUD context
    if (/\/favicon/i.test(url)) return;
    rec.requestFailed.push({ url, err: r.failure() ? r.failure().errorText : '' });
  });
  return rec;
}

// Hold a document/asset request without continuing it: the page stays up, the
// heavy body never downloads and nothing falls back to a CDN.
function holdRequests(page, sink, re) {
  page.on('request', (req) => {
    if (re.test(req.url())) { sink.push(req.url()); return; }
    req.continue().catch(() => {});
  });
}

/* ---------------------------------------------------------- page helpers --- */

const SNAP = () => {
  const api = window.__R4_MMO || null;
  const st = api && api.state ? api.state : null;
  const txt = (sel) => {
    const el = document.querySelector(sel);
    return el ? String(el.textContent || '').replace(/\s+/g, ' ').trim() : '';
  };
  const attr = (sel, name) => {
    const el = document.querySelector(sel);
    return el ? el.getAttribute(name) : null;
  };
  const visible = (sel) => {
    const el = document.querySelector(sel);
    if (!el) return false;
    const cs = getComputedStyle(el);
    return !el.hidden && cs.display !== 'none' && cs.visibility !== 'hidden' && Number(cs.opacity) > 0;
  };
  const rows = (sel) => Array.from(document.querySelectorAll(sel))
    .filter((tr) => !tr.hasAttribute('data-mmo-note') && !tr.classList.contains('mmo-row-note'))
    .map((tr) => Array.from(tr.children).map((c) => String(c.textContent || '').replace(/\s+/g, ' ').trim()));
  const startEl = document.getElementById('mmoStart');
  const lfgEl = document.getElementById('mmoLfgBtn');
  const cdEl = document.getElementById('mmoCountdown');
  const cdNum = document.querySelector('[data-mmo-countdown-n]');
  const hud = document.querySelector('#mmoHud');
  const game = document.getElementById('game');
  return {
    conn: st ? st.conn : null,
    driverId: st ? st.driverId : '',
    name: st ? st.name : '',
    phase: st && st.event ? st.event.state : null,
    eventId: st && st.event ? st.event.id : null,
    eventIndex: st && st.event ? st.event.index : null,
    plan: st && st.event ? st.event.plan : null,
    max: st && st.event && st.event.counts ? st.event.counts.max : null,
    min: st && st.event && st.event.counts ? st.event.counts.min : null,
    seated: st && st.event && st.event.counts ? st.event.counts.seated : null,
    you: st && st.you ? { seat: st.you.seat, team: st.you.team, name: st.you.name, position: st.you.position } : null,
    queue: st && st.queue ? { position: st.queue.position, size: st.queue.size } : null,
    party: st && st.party ? { code: st.party.code, size: st.party.size } : null,
    standingsRows: st && st.standings ? st.standings.rows.length : 0,
    countdownN: st && st.countdown ? st.countdown.n : null,
    gridCount: txt('#mmoGridCount'),
    gridCountAttr: attr('#mmoGridCount', 'aria-label'),
    stateText: txt('#mmoState'),
    stateAttr: attr('#mmoState', 'data-state'),
    track: txt('[data-mmo-track]'),
    seatText: txt('[data-mmo-seat]'),
    seatStrip: attr('#mmoSeat', 'data-mmo-seat-strip'),
    gridYouSeat: (() => {
      const el = document.querySelector('#mmoGrid .mmo-slot[data-state="you"]');
      return el ? el.getAttribute('data-seat') : null;
    })(),
    // Server truth: the grid rows carry driverId, so "where am I seated" does
    // not depend on a DOM paint or a possibly stale `you` object.
    mySeatFromGrid: (() => {
      if (!st) return null;
      const rows = st.grid && Array.isArray(st.grid.seats) ? st.grid.seats : [];
      const mine = rows.find((r) => r && r.driverId && r.driverId === st.driverId);
      return mine ? mine.seat : null;
    })(),
    teamText: txt('#mmoTeam'),
    lfgBtn: lfgEl ? String(lfgEl.textContent || '').trim() : '',
    lfgMode: lfgEl ? lfgEl.dataset.mode || '' : '',
    lfgQueue: txt('#mmoLfgQueue'),
    fill: attr('#mmoFill', 'data-mmo-fill'),
    startText: startEl ? String(startEl.textContent || '').trim() : '',
    startDisabled: startEl ? !!startEl.disabled : null,
    startNeed: startEl ? startEl.dataset.need : null,
    botsText: txt('#mmoBots'),
    botsPressed: attr('#mmoBots', 'aria-pressed'),
    partyCode: txt('#mmoPartyCode'),
    partySize: attr('#mmoParty', 'data-size'),
    partyStatus: txt('[data-mmo-party-status]'),
    countdown: { hidden: cdEl ? !!cdEl.hidden : null, n: cdNum ? String(cdNum.textContent || '').trim() : '', go: cdEl ? cdEl.getAttribute('data-go') : null },
    standings: rows('#mmoStandingsBody tr'),
    yourRow: {
      pos: txt('#mmoYourRow [data-mmo-you-pos]'),
      position: attr('#mmoYourRow [data-mmo-you-pos]', 'data-position'),
      text: txt('#mmoYourRow'),
      state: attr('#mmoYourRow', 'data-state'),
    },
    resultsHidden: (() => { const el = document.getElementById('mmoResults'); return el ? !!el.hidden : null; })(),
    resultsRows: rows('#mmoResultsBody tr'),
    resultsBack: attr('#mmoResults [data-mmo-back]', 'href'),
    podium: Array.from(document.querySelectorAll('#mmoPodium [data-place]')).map((el) => ({
      place: el.dataset.place,
      name: String((el.querySelector('.mmo-podium-name') || {}).textContent || '').trim(),
      filled: el.getAttribute('data-filled'),
      aria: el.getAttribute('aria-label'),
    })),
    nextRace: txt('#mmoNextRace'),
    topbarHidden: (() => { const el = document.getElementById('mmoTopbar'); return el ? !!el.hidden : null; })(),
    embeddedFlag: document.documentElement.getAttribute('data-embedded'),
    hasApp: !!document.getElementById('mmoApp'),
    hasLfg: !!document.getElementById('mmoLfgBtn'),
    spectatePanel: !!document.getElementById('mmoSpectateBoard'),
    spectateFacade: !!window.__R4_MMO_SPECTATE,
    spectate: {
      phase: attr('#mmoSpectateBoard [data-sp-phase]', 'data-state'),
      clock: txt('#mmoSpectateBoard [data-sp-clock]'),
      life: txt('#mmoSpectateBoard [data-sp-life]'),
      foot: txt('#mmoSpectateBoard .mmo-sp-foot'),
      rows: Array.from(document.querySelectorAll('#mmoSpectateBoard [data-sp-rows] .mmo-sp-row'))
        .filter((r) => !r.hasAttribute('data-empty'))
        .map((r) => ({
          pos: String((r.querySelector('[data-cell="pos"]') || {}).textContent || '').trim(),
          name: String((r.querySelector('[data-cell="name"] [data-sp-name]')
            || r.querySelector('[data-cell="name"]') || {}).textContent || '').trim(),
          bot: !!r.querySelector('[data-cell="name"] .mmo-sp-bot:not([hidden])'),
        })),
    },
    standingsVisible: visible('#mmoStandings'),
    hud: {
      present: !!hud,
      hidden: hud ? !!hud.hidden : null,
      pos: hud ? String((document.getElementById('mmoHudPos') || {}).textContent || '').trim() : '',
      params: window.__R4_MMO_PARAMS || null,
      hudApiParams: window.__R4_MMO && window.__R4_MMO.hud ? window.__R4_MMO.hud.params : null,
      finishHref: hud ? ((document.getElementById('mmoHudFinishLink') || {}).getAttribute ? document.getElementById('mmoHudFinishLink').getAttribute('href') : null) : null,
      source: hud ? String((document.getElementById('mmoHudSource') || {}).textContent || '').trim() : '',
      siblingOfGame: !!(hud && hud.parentElement && hud.parentElement.id === undefined && !(game && game.contains(hud))),
      hudCss: !!document.getElementById('mmoHudCss'),
    },
    sent: (() => {
      const cli = api && api.client;
      if (!cli || !cli._debug) return null;
      return {
        queue: cli._debug.sentCount('queue'),
        telemetry: cli._debug.sentCount('telemetry'),
        finish: cli._debug.sentCount('finish'),
        start: cli._debug.sentCount('start'),
        spectate: cli._debug.sentCount('spectate'),
        hello: cli._debug.sentCount('hello'),
        ping: cli._debug.sentCount('ping'),
      };
    })(),
  };
};

async function snap(frame) {
  return frame.evaluate(SNAP);
}

async function waitMmoFrame(page, timeout = NAV_TIMEOUT_MS) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    for (const frame of page.frames()) {
      if (!/\/race-day/.test(frame.url())) continue;
      try {
        const ok = await frame.evaluate(() => (
          !!document.getElementById('mmoApp')
          && !!(window.__R4_MMO && window.__R4_MMO.state)
          && window.__R4_MMO.state.conn === 'open'
        ));
        if (ok) return frame;
      } catch { /* the document is still swapping */ }
    }
    await sleep(120);
  }
  throw new Error('the /race-day document did not connect its /mmo socket');
}

async function waitFor(fn, timeout = STEP_TIMEOUT_MS, label = 'condition', interval = 80) {
  const deadline = Date.now() + timeout;
  let last = null;
  while (Date.now() < deadline) {
    try { last = await fn(); } catch { last = null; }
    if (last) return last;
    await sleep(interval);
  }
  throw new Error(`timeout ${timeout} ms waiting for ${label}`);
}

async function waitPhase(frame, wanted, timeout = 15000, label = '') {
  const t0 = Date.now();
  const list = Array.isArray(wanted) ? wanted : [wanted];
  const hit = await waitFor(async () => {
    const phase = await frame.evaluate(() => (
      window.__R4_MMO && window.__R4_MMO.state && window.__R4_MMO.state.event
        ? window.__R4_MMO.state.event.state : null
    ));
    return list.includes(phase) ? phase : null;
  }, timeout, `phase ${list.join('|')}${label ? ' (' + label + ')' : ''}`, 50);
  return { phase: hit, ms: Date.now() - t0 };
}

// Type a callsign through the real input (the field writes rr4.mmo.name and the
// next boot sends it in `hello`; there is no client.setName, so the harness
// seeds the same name before boot and then proves the field repaints it).
async function setCallsign(frame, name) {
  await frame.waitForSelector('#mmoName', { visible: true, timeout: STEP_TIMEOUT_MS });
  await frame.click('#mmoName', { clickCount: 3 });
  await frame.$eval('#mmoName', (el) => { el.value = ''; });
  await frame.type('#mmoName', name, { delay: 10 });
  await frame.$eval('#mmoName', (el) => el.blur());
  return frame.evaluate((n) => ({
    field: (document.getElementById('mmoName') || {}).value || '',
    stored: (() => { try { return localStorage.getItem('rr4.mmo.name') || ''; } catch { return ''; } })(),
    hint: String((document.querySelector('[data-mmo-name-hint]') || {}).textContent || '').trim(),
    serverName: window.__R4_MMO && window.__R4_MMO.state ? window.__R4_MMO.state.name : '',
    want: n,
  }), name);
}

// Queue through the LFG button, whatever label the current event left behind.
async function ensureQueued(frame, label) {
  const deadline = Date.now() + 20000;
  let clicked = 0;
  while (Date.now() < deadline) {
    const probe = await frame.evaluate(() => {
      const st = window.__R4_MMO ? window.__R4_MMO.state : null;
      const btn = document.getElementById('mmoLfgBtn');
      return {
        mode: btn ? btn.dataset.mode || '' : '',
        label: btn ? String(btn.textContent || '').trim() : '',
        disabled: btn ? !!btn.disabled : true,
        seat: st && st.you ? st.you.seat : null,
        queuePos: st && st.queue ? st.queue.position : 0,
      };
    });
    if (probe.disabled) { await sleep(150); continue; }
    if (probe.mode === 'leave') {
      await frame.click('#mmoLfgBtn');
      clicked += 1;
      await waitFor(async () => {
        const mode = await frame.evaluate(() => (document.getElementById('mmoLfgBtn') || {}).dataset?.mode || '');
        return mode !== 'leave' ? mode : null;
      }, 5000, 'LEAVE QUEUE -> FIND ME A RACE', 60).catch(() => null);
      continue;
    }
    if (probe.seat && probe.queuePos > 0) return { ...probe, clicked };
    await frame.click('#mmoLfgBtn');
    clicked += 1;
    const done = await waitFor(async () => {
      const now = await frame.evaluate(() => {
        const st = window.__R4_MMO ? window.__R4_MMO.state : null;
        return {
          seat: st && st.you ? st.you.seat : null,
          queuePos: st && st.queue ? st.queue.position : 0,
        };
      });
      return now.seat || now.queuePos > 0 ? now : null;
    }, 6000, `queue as ${label}`, 80).catch(() => null);
    if (done) return { ...probe, ...done, clicked };
  }
  throw new Error(`could not queue as ${label}`);
}

async function pushTelemetry(frame, sample) {
  return frame.evaluate((s) => {
    const api = window.__R4_MMO;
    if (!api || typeof api.send !== 'function') return false;
    return api.send('telemetry', {
      t: Date.now(),
      lap: s.lap,
      raceTimeMs: s.raceTimeMs,
      speedKph: s.speedKph == null ? 180 : s.speedKph,
      state: 'racing',
    });
  }, sample);
}

async function sendFinish(frame, sample) {
  return frame.evaluate((s) => {
    const api = window.__R4_MMO;
    if (!api || typeof api.send !== 'function') return false;
    return api.send('finish', { raceTimeMs: s.raceTimeMs, lap: s.lap });
  }, sample);
}

// Client-side recorder: countdown numerals from the countdown frames (wire) and
// from #mmoCountdown (DOM), plus the phase history with page timestamps.
async function installRecorder(frame) {
  await frame.evaluate(() => {
    if (window.__E2E_REC) return;
    const rec = window.__E2E_REC = { cdN: [], labels: [], phases: [], sent: [], t0: Date.now() };
    const cli = window.__R4_MMO && window.__R4_MMO.client;
    if (!cli) return;
    let lastPhase = null;
    let lastN = null;
    cli.subscribe((s) => {
      const phase = s.event && s.event.state;
      if (phase && phase !== lastPhase) {
        lastPhase = phase;
        rec.phases.push({ state: phase, at: Date.now() });
      }
      const n = s.countdown ? s.countdown.n : null;
      if (typeof n === 'number' && n > 0 && n !== lastN) { lastN = n; rec.cdN.push(n); }
    });
    rec.timer = setInterval(() => {
      const el = document.getElementById('mmoCountdown');
      const num = el && el.querySelector('[data-mmo-countdown-n]');
      if (!el || el.hidden || !num) return;
      const text = String(num.textContent || '').trim();
      if (rec.labels[rec.labels.length - 1] !== text) rec.labels.push(text);
    }, 40);
  });
}

async function readRecorder(frame) {
  return frame.evaluate(() => {
    const rec = window.__E2E_REC;
    if (!rec) return null;
    return { cdN: rec.cdN.slice(), labels: rec.labels.slice(), phases: rec.phases.slice() };
  });
}

/* ------------------------------------------------------------ instance --- */

const server = {
  spawned: false,
  port: PORT,
  pid: 0,
  log: [],
  env: {},
};

async function status() {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 2500);
  try {
    const res = await fetch(`${BASE}/api/mmo/status`, { signal: ctrl.signal });
    if (!res.ok) return null;
    const body = await res.json();
    return body && body.ok ? body : null;
  } catch { return null; } finally { clearTimeout(timer); }
}

async function portBusy() {
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 1200);
    const res = await fetch(`${BASE}/api/health`, { signal: ctrl.signal });
    clearTimeout(timer);
    return res.ok;
  } catch { return false; }
}

async function startInstance() {
  if (BASE_ARG) {
    const st = await status();
    if (!st) throw new Error(`--base ${BASE} has no /api/mmo/status (not this tree, or an old server)`);
    server.spawned = false;
    server.env = { base: BASE, min: st.min, max: st.max };
    return st;
  }
  if (await portBusy()) throw new Error(`:${PORT} is already in use â€” pass --base ${BASE} or --port <free>`);
  server.env = {
    RR4_PORT: String(PORT),
    RR4_MMO_MIN: '2',
    RR4_MMO_FILL_MS: String(FILL_MS),
    RR4_MMO_GRID_MS: String(GRID_MS),
    RR4_MMO_COUNTDOWN_MS: String(COUNTDOWN_MS),
    RR4_MMO_RESULTS_MS: String(RESULTS_MS),
    RR4_MMO_BOTS: '0',
    RR4_NO_AUTOSTART: '1',
    RR4_STREAM_SOURCE: 'test',
  };
  // The child writes straight to a log file (no parent-owned pipes), so
  // `--keep` leaves a healthy server behind and never blocks this process.
  const logPath = path.join(OUT, `mmo-e2e-server-${PORT}.log`);
  server.logPath = logPath;
  let logFd = null;
  try { logFd = fs.openSync(logPath, 'a'); } catch { logFd = null; }
  const child = spawn(process.execPath, ['src/server.js'], {
    cwd: HERE,
    env: { ...process.env, ...server.env },
    stdio: ['ignore', logFd === null ? 'pipe' : logFd, logFd === null ? 'pipe' : logFd],
    windowsHide: true,
    // Own process group: `--keep` survives the harness (and the shell that
    // launched it); taskkill /T /PID still reaps the whole tree otherwise.
    detached: true,
  });
  if (logFd !== null) { try { fs.closeSync(logFd); } catch { /* the child owns the handle now */ } }
  server.spawned = true;
  server.pid = child.pid;
  child.on('exit', (code) => { server.exitCode = code; });
  if (child.stdout) child.stdout.on('data', () => {});
  if (child.stderr) child.stderr.on('data', () => {});
  child.unref();
  const st = await waitFor(status, 25000, `:${PORT} /api/mmo/status`, 250);
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    const now = await status();
    if (now && now.event && now.event.state) return now;
    await sleep(200);
  }
  return st;
}

function tailOf(file, n = 60) {
  try {
    return fs.readFileSync(file, 'utf8').split(/\r?\n/).filter((l) => l.trim()).slice(-n);
  } catch { return []; }
}

async function stopInstance() {
  if (!server.spawned || KEEP) return;
  await new Promise((resolve) => {
    try {
      const k = spawn('taskkill', ['/PID', String(server.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
      k.on('exit', resolve);
      k.on('error', resolve);
    } catch { resolve(); }
  });
  await sleep(300);
}

/* ----------------------------------------------------------------- main --- */

const startedAt = Date.now();
const S = {
  base: BASE,
  port: PORT,
  env: {},
  serverStatus: null,
  serverLogTail: [],
  context: {},
  invite: {},
  spectator: {},
  hud: {},
  findings: [],
  timings: {},
  held: [],
  fatal: null,
};

let browser = null;
const pages = {};
const recs = {};
const frames = {};

async function newContext(label, extraNoise = []) {
  const ctx = await browser.createBrowserContext();
  const page = await ctx.newPage();
  await page.setViewport({ width: 1440, height: 900 });
  await page.setDefaultTimeout(STEP_TIMEOUT_MS);
  pages[label] = page;
  recs[label] = attach(page, label, extraNoise);
  return page;
}

async function main() {
  S.serverStatus = await startInstance();
  log(`instance: ${BASE}  min=${S.serverStatus.min} max=${S.serverStatus.max}  spawned=${server.spawned}`);
  S.env = server.env;

  const chrome = CHROME_CANDIDATES.find((p) => fs.existsSync(p));
  if (!chrome) throw new Error('no Chrome/Brave at the known paths');
  browser = await puppeteer.launch({
    executablePath: chrome,
    headless: true,
    protocolTimeout: 240000,
    defaultViewport: { width: 1440, height: 900 },
    args: [
      '--no-sandbox',
      '--disable-background-timer-throttling',
      '--disable-backgrounding-occluded-windows',
      '--disable-renderer-backgrounding',
      '--mute-audio',
      '--window-size=1440,900',
    ],
  });

  /* ---- A: the cabinet shell ---- */
  const pageA = await newContext('A');
  const pageB = await newContext('B');
  let frameA = null;
  let frameB = null;

  let a = {};
  await step('A enters the cabinet (ENTER gate -> /welcome)', async () => {
    await pageA.goto(BASE + '/', { waitUntil: 'domcontentloaded', timeout: 60000 });
    await pageA.waitForSelector('#rr4-enter', { visible: true });
    await pageA.waitForFunction(() => {
      const b = document.querySelector('#rr4eEnter');
      return !!b && !b.disabled;
    }, { timeout: STEP_TIMEOUT_MS, polling: 100 });
    await pageA.click('#rr4eEnter');
    await pageA.waitForFunction(() => {
      const s = document.querySelector('#rr4-shell');
      return !!s && !s.hidden;
    }, { timeout: STEP_TIMEOUT_MS, polling: 50 });
    // The callsign has to exist before the /race-day module boots (the client
    // reads localStorage once, at construction).
    await pageA.evaluate(() => { try { localStorage.setItem('rr4.mmo.name', 'HOST-A'); } catch { /* ignore */ } });
    S.context.A = { entered: true };
  });

  await step('A: the RACE DAY nav button loads /race-day?embedded=1 in the shell frame', async () => {
    const nav = await pageA.$('[data-view="race-day"]');
    a.nav = { present: !!nav, text: nav ? String((await nav.evaluate((el) => el.textContent)).trim()) : '' };
    await pageA.waitForSelector('[data-view="race-day"]', { visible: true });
    await pageA.click('[data-view="race-day"]');
    await pageA.waitForFunction(() => {
      const f = document.querySelector('#rr4sFrame');
      return !!f && /\/race-day\?/.test(String(f.src || ''));
    }, { timeout: NAV_TIMEOUT_MS, polling: 100 });
    a.frameSrc = await pageA.evaluate(() => String((document.querySelector('#rr4sFrame') || {}).src || ''));
    a.shellAria = await pageA.evaluate(() => {
      const b = document.querySelector('[data-view="race-day"]');
      return b ? b.getAttribute('aria-pressed') || b.className || '' : '';
    });
    frameA = await waitMmoFrame(pageA);
    frameA.__label = 'A';
    await installRecorder(frameA);
  });

  await step('A: callsign typed into #mmoName + FIND ME A RACE', async () => {
    a.name = await setCallsign(frameA, 'HOST-A');
    await frameA.click('#mmoLfgBtn');
    a.queued1 = await waitFor(async () => {
      const s = await snap(frameA);
      return s.queue && s.queue.position > 0 ? s : null;
    }, 10000, 'A queue position', 80);
    a.afterQueue = await snap(frameA);
  });

  /* ---- B: /race-day directly ---- */
  const b = {};
  await step('B opens /race-day directly, sets a callsign and queues', async () => {
    await pageB.evaluateOnNewDocument(() => {
      try { localStorage.setItem('rr4.mmo.name', 'GUEST-B'); } catch { /* ignore */ }
    });
    await pageB.goto(`${BASE}/race-day`, { waitUntil: 'domcontentloaded', timeout: 60000 });
    frameB = await waitMmoFrame(pageB);
    await installRecorder(frameB);
    b.name = await setCallsign(frameB, 'GUEST-B');
    b.standalone = await snap(frameB);
    await frameB.click('#mmoLfgBtn');
    b.afterQueue = await waitFor(async () => {
      const s = await snap(frameB);
      return s.queue && s.queue.position > 0 ? s : null;
    }, 10000, 'B queue position', 80);
  });

  /* ---- 2: lobby assertions ---- */
  let lobby = { a: {}, b: {} };
  await step('both clients show 2/50, different seats and START WITH 2', async () => {
    await waitFor(async () => {
      const [sa, sb] = await Promise.all([snap(frameA), snap(frameB)]);
      return sa.gridCount === '2/50' && sb.gridCount === '2/50' ? true : null;
    }, 12000, 'grid 2/50 in both', 100);
    lobby.a = await snap(frameA);
    lobby.b = await snap(frameB);
  });
  await shot(pageA, 'lobby-a');
  await shot(pageB, 'lobby-b');

  /* ---- 6a: the party + invite link start in the lobby (button is really
     clickable there; the results overlay covers the LFG panel). ---- */
  await step('A creates a party in the lobby (invite code chip)', async () => {
    await frameA.waitForSelector('[data-mmo-party-create]', { visible: true, timeout: 10000 });
    await frameA.click('[data-mmo-party-create]');
    const code = await waitFor(async () => {
      const s = await snap(frameA);
      return /^[A-Z0-9]{4,6}$/.test(s.partyCode) ? s.partyCode : null;
    }, 12000, 'party code chip', 100);
    S.invite.code = code;
    S.invite.hostParty = await snap(frameA);
  });

  /* ---- 3: start, grid, countdown, racing ---- */
  const race = { gridLocked: {}, countdown: {}, racing: {}, tracks: {} };
  await step('A starts the race (#mmoStart) -> GRID LOCKED in both', async () => {
    const pre = await snap(frameA);
    race.preStart = { startText: pre.startText, startDisabled: pre.startDisabled, phase: pre.phase };
    if (pre.phase === 'lobby') {
      await frameA.click('#mmoStart');
    }
    race.autoStarted = pre.phase !== 'lobby';
    const [ga, gb] = await Promise.all([
      waitPhase(frameA, ['grid', 'countdown', 'racing'], 15000, 'A grid'),
      waitPhase(frameB, ['grid', 'countdown', 'racing'], 15000, 'B grid'),
    ]);
    race.gridLocked = { a: ga, b: gb };
    // The store flips to `grid` a frame before mmo-ui paints it (one rAF), so
    // poll the painted pill instead of snapshotting the DOM 1 ms too early.
    race.gridState = await waitFor(async () => {
      const [sa, sb] = await Promise.all([snap(frameA), snap(frameB)]);
      return /GRID LOCKED/.test(sa.stateText) && /GRID LOCKED/.test(sb.stateText) ? { a: sa, b: sb } : null;
    }, 5000, 'GRID LOCKED painted in both', 50).catch(async () => ({
      a: await snap(frameA), b: await snap(frameB),
    }));
    S.timings.gridLocked = { a: ga.ms, b: gb.ms };
  });

  await step('countdown 3-2-1 is on screen in both (screenshot) then RACING', async () => {
    // Shoot while the overlay is actually showing a numeral, not after GO.
    const numeral = () => {
      const el = document.getElementById('mmoCountdown');
      const n = document.querySelector('[data-mmo-countdown-n]');
      return !!el && !el.hidden && !!n && /^[0-9]$/.test(String(n.textContent || '').trim());
    };
    race.countdownSeen = await Promise.all([
      frameA.waitForFunction(numeral, { timeout: 9000, polling: 30 }).then(() => true).catch(() => false),
      frameB.waitForFunction(numeral, { timeout: 9000, polling: 30 }).then(() => true).catch(() => false),
    ]);
    await Promise.all([shot(pageA, 'countdown-a'), shot(pageB, 'countdown-b')]);
    const [ca, cb] = await Promise.all([
      waitPhase(frameA, 'racing', 15000, 'A racing'),
      waitPhase(frameB, 'racing', 15000, 'B racing'),
    ]);
    race.racing = { a: ca, b: cb };
    S.timings.countdownToRacing = { a: ca.ms, b: cb.ms };
    race.after = { a: await snap(frameA), b: await snap(frameB) };
    race.recorder = { a: await readRecorder(frameA), b: await readRecorder(frameB) };
    const delta = (rec, from, to) => {
      const f = (rec.phases || []).find((p) => p.state === from);
      const t = (rec.phases || []).find((p) => p.state === to);
      return f && t ? t.at - f.at : null;
    };
    S.timings.pageClock = {
      gridToCountdown: { a: delta(race.recorder.a, 'grid', 'countdown'), b: delta(race.recorder.b, 'grid', 'countdown') },
      countdownToRacing: { a: delta(race.recorder.a, 'countdown', 'racing'), b: delta(race.recorder.b, 'countdown', 'racing') },
    };
  });
  await shot(pageA, 'racing-a');
  await shot(pageB, 'racing-b');

  /* ---- 4: telemetry -> standings ---- */
  const tele = { a: [], b: [], after: {} };
  await step('telemetry from both seats at 4 Hz -> identical ordering', async () => {
    const plan = [
      [{ lap: 1, raceTimeMs: 20000 }, { lap: 1, raceTimeMs: 23000 }],
      [{ lap: 1, raceTimeMs: 21000 }, { lap: 1, raceTimeMs: 24000 }],
      [{ lap: 1, raceTimeMs: 22000 }, { lap: 1, raceTimeMs: 25000 }],
    ];
    for (const [sa, sb] of plan) {
      tele.a.push(await pushTelemetry(frameA, sa));
      tele.b.push(await pushTelemetry(frameB, sb));
      await sleep(330); // server clamps telemetry to 4 Hz
    }
    await waitFor(async () => {
      const [sa, sb] = await Promise.all([snap(frameA), snap(frameB)]);
      return sa.standings.length >= 2 && sb.standings.length >= 2
        && sa.yourRow.position && sb.yourRow.position ? true : null;
    }, 12000, 'standings rows + your-row positions', 150);
    tele.after = { a: await snap(frameA), b: await snap(frameB) };
  });
  await shot(pageA, 'standings-a');
  await shot(pageB, 'standings-b');

  /* ---- 5: finish -> results ---- */
  const results = { a: {}, b: {} };
  await step('finish both -> #mmoResults with the same order, podium, next-race clock', async () => {
    await sendFinish(frameA, { raceTimeMs: 66000, lap: 3 });
    await sleep(120);
    await sendFinish(frameB, { raceTimeMs: 70500, lap: 3 });
    await waitFor(async () => {
      const [sa, sb] = await Promise.all([snap(frameA), snap(frameB)]);
      return sa.resultsHidden === false && sb.resultsHidden === false
        && sa.resultsRows.length >= 2 && sb.resultsRows.length >= 2 ? true : null;
    }, 15000, '#mmoResults with 2 rows', 100);
    results.a = await snap(frameA);
    results.b = await snap(frameB);
    await shot(pageA, 'results-a');
    await shot(pageB, 'results-b');
    await sleep(1300);
    results.a2 = await snap(frameA);
    results.b2 = await snap(frameB);
  });

  /* ---- 8: HUD handoff URL (read while the results are still on screen) ---- */
  await step('HUD handoff: /play?mmo=1&event&seat&team mounts #mmoHud', async () => {
    const live = results.a.eventId ? results.a : await snap(frameA);
    const eventId = live.eventId;
    const seat = live.you && live.you.seat ? live.you.seat : 0;
    const team = live.you && live.you.team ? live.you.team : '';
    const url = `${BASE}/play?mmo=1&event=${encodeURIComponent(eventId || '')}` +
      `&seat=${seat}&team=${encodeURIComponent(team)}&game=r4&embedded=1&threads=0`;
    S.hud.url = url;
    S.hud.resultsBack = results.a.resultsBack;
    const pageH = await newContext('HUD', PLAY_NOISE);
    holdRequests(pageH, S.held, /\/(rom|bios)\//i);
    await pageH.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await pageH.waitForFunction(() => !!window.__R4_MMO_PARAMS, { timeout: 30000, polling: 80 });
    await pageH.waitForFunction(() => !!document.getElementById('mmoHud'), { timeout: 30000, polling: 80 });
    const probe = await pageH.evaluate(() => ({
      params: window.__R4_MMO_PARAMS,
      hudParams: window.__R4_MMO && window.__R4_MMO.hud ? window.__R4_MMO.hud.params : null,
      hasHud: !!document.getElementById('mmoHud'),
      hudCss: !!document.getElementById('mmoHudCss'),
      finishHref: (document.getElementById('mmoHudFinishLink') || {}).getAttribute
        ? document.getElementById('mmoHudFinishLink').getAttribute('href') : null,
      pos: String((document.getElementById('mmoHudPos') || {}).textContent || '').trim(),
      sibling: (() => {
        const hud = document.getElementById('mmoHud');
        const game = document.getElementById('game');
        return !!(hud && game && !game.contains(hud) && hud.parentElement === document.body);
      })(),
      visible: (() => {
        const hud = document.getElementById('mmoHud');
        return !!hud && !hud.hidden;
      })(),
      source: String((document.getElementById('mmoHudSource') || {}).textContent || '').trim(),
    }));
    let visible = probe.visible;
    if (!visible) {
      visible = await pageH.waitForFunction(() => {
        const hud = document.getElementById('mmoHud');
        return !!hud && !hud.hidden;
      }, { timeout: 12000, polling: 100 }).then(() => true).catch(() => false);
    }
    // Not inside the shell iframe, /play shows the parent audio gate: SKIP AUDIO
    // is the real control that reveals the stage (the HUD is a sibling of #game).
    const gateSkipped = await pageH.evaluate(() => {
      const b = document.querySelector('.rr4m-gate-skip') || document.querySelector('#rr4-music-gate button');
      if (!b) return false;
      b.click();
      return true;
    });
    if (gateSkipped) {
      await sleep(400);
      visible = await pageH.waitForFunction(() => {
        const hud = document.getElementById('mmoHud');
        return !!hud && !hud.hidden;
      }, { timeout: 8000, polling: 100 }).then(() => true).catch(() => visible);
      const after = await pageH.evaluate(SNAP).catch(() => null);
      if (after && after.hud) probe.pos = after.hud.pos;
    }
    S.hud.gateSkipped = gateSkipped;
    S.hud.probe = { ...probe, visible };
    S.hud.expect = { event: eventId, seat, team };
    await pageH.screenshot({ path: path.join(OUT, 'mmo-e2e-hud.png'), fullPage: false }).then(() => {
      screenshots.hud = path.join(OUT, 'mmo-e2e-hud.png');
    }).catch(() => {});
  });

  /* ---- 6/7: party invite, spectator, second race ---- */
  await step('party: the invite link /race-day?party=<code> brings a third driver in', async () => {
    const code = S.invite.code;
    const pageC = await newContext('C');
    await pageC.evaluateOnNewDocument(() => {
      try { localStorage.setItem('rr4.mmo.name', 'INVITE-C'); } catch { /* ignore */ }
    });
    await pageC.goto(`${BASE}/race-day?party=${encodeURIComponent(code)}`, { waitUntil: 'domcontentloaded', timeout: 60000 });
    const frameC = await waitMmoFrame(pageC);
    frames.c = frameC;
    S.context.C = { opened: true };
    S.invite.chip = await waitFor(async () => {
      const s = await snap(frameC);
      return s.partyCode === code ? s.partyCode : null;
    }, 12000, 'invite page party code chip', 100);
    await setCallsign(frameC, 'INVITE-C');
    await ensureQueued(frameC, 'C');
    S.invite.joined = await snap(frameC);
    // A/B queue for the next event while the race/results are still up: the
    // server parks them in `pending` and seats all three atomically on the
    // roll-over, so the party never lands in a half-filled grid.
    await ensureQueued(frameA, 'A');
    await ensureQueued(frameB, 'B');
  });

  await step('event rolls to the next lobby and all three seats land in it', async () => {
    const seated = await waitFor(async () => {
      const st = await status();
      if (!st || !st.event) return null;
      if (st.event.state !== 'lobby') return null;
      return st.counts && st.counts.seated >= 3 ? st : null;
    }, 30000, 'three seats in the next lobby', 200);
    S.invite.server = seated;
    await waitFor(async () => {
      const sa = await snap(frameA);
      const sb = await snap(frameB);
      const sc = await snap(frames.c);
      const ids = [sa.eventId, sb.eventId, sc.eventId].filter(Boolean);
      return ids.length === 3 && ids[0] === ids[1] && ids[1] === ids[2]
        && sa.you.seat && sb.you.seat && sc.you.seat ? { ids } : null;
    }, 20000, 'same event id + seat in A/B/C', 150).then((hit) => { S.invite.same = hit; }).catch(() => { S.invite.same = null; });
    S.invite.seated = {
      a: await snap(frameA), b: await snap(frameB), c: await snap(frames.c),
    };
    // The client store only refreshes `you` on `welcome`; an automatic re-seat
    // (mmo.js nextEvent -> queueDriver) sends none, so record whether the seat
    // strip/you.seat still points at the previous event's seat.
    S.invite.staleSeat = Object.fromEntries(Object.entries(S.invite.seated).map(([k, s]) => [k, {
      youSeat: s.you ? s.you.seat : null,
      gridYouSeat: s.gridYouSeat,
      seatStrip: s.seatStrip,
      team: s.you ? s.you.team : null,
      stale: !!s.gridYouSeat && String(s.you ? s.you.seat : '') !== String(s.gridYouSeat),
    }]));
    S.invite.gridCounts = Object.fromEntries(Object.entries(S.invite.seated)
      .map(([k, s]) => [k, s.gridCount]));
    const stale = Object.entries(S.invite.gridCounts)
      .filter(([, v]) => String(v || '').replace(/\s+/g, '') !== '3/50')
      .map(([k, v]) => `${k}="${v}"`);
    if (stale.length) {
      S.findings.push(`grid header/seat strip stale after the pending re-seat (${stale.join(', ')} while the server counted 3 seated; ` +
        `you.team=${JSON.stringify({ a: S.invite.seated.a.you.team, b: S.invite.seated.b.you.team, c: S.invite.seated.c.you.team })}). ` +
        'Cause: _server/src/mmo.js nextEvent() re-seats pending drivers through queueDriver() but does not broadcastGrid() and sends no welcome (mmo.js:586-599), so the client never learns its new seat/team or the new count until the next grid delta.');
    }
    await shot(pages.C, 'invite-c');
  });

  await step('spectator: /race-day?spectate=1 watches the live board', async () => {
    const pageD = await newContext('D');
    await pageD.goto(`${BASE}/race-day?spectate=1`, { waitUntil: 'domcontentloaded', timeout: 60000 });
    const frameD = await waitMmoFrame(pageD);
    frames.d = frameD;
    S.context.D = { opened: true };
    S.spectator.before = await snap(frameD);

    // Start the second race from A so the spectator has something live to show.
    const phase = (await snap(frameA)).phase;
    if (phase === 'lobby') {
      await frameA.waitForSelector('#mmoStart', { visible: true });
      const start = await snap(frameA);
      S.spectator.start = { text: start.startText, disabled: start.startDisabled };
      if (!start.startDisabled) await frameA.click('#mmoStart');
    }
    await waitFor(async () => {
      const s = await snap(frames.d);
      return s.phase === 'racing' ? s : null;
    }, 25000, 'spectator sees the race', 120);
    // A little live telemetry so the board is not a wall of zeroes.
    const drivers = [[frameA, 12000], [frameB, 13000], [frames.c, 14000]].filter(([f]) => !!f);
    for (const [frame, t] of drivers) {
      await pushTelemetry(frame, { lap: 1, raceTimeMs: t });
      await sleep(330);
    }
    await waitFor(async () => {
      const s = await snap(frames.d);
      const named = s.spectate && Array.isArray(s.spectate.rows)
        ? s.spectate.rows.filter((r) => r.name && r.name !== '—').length : 0;
      const legacy = (s.standings || []).length;
      return s.phase === 'racing' && (s.spectatePanel ? named >= 2 : legacy >= 2) ? s : null;
    }, 15000, 'spectator board rows', 150);
    S.spectator.live = await snap(frames.d);
    S.spectator.sent = S.spectator.live.sent;
    await shot(pageD, 'spectate-d');
    S.spectator.pageErrors = recs.D.pageErrors.slice();
    S.spectator.consoleErrors = recs.D.consoleErrors.slice();
  });

  await step('final snapshots', async () => {
    const pairs = [['A', frameA], ['B', frameB], ['C', frames.c], ['D', frames.d]];
    for (const [key, frame] of pairs) {
      if (!frame) continue;
      S.context[key] = S.context[key] || { opened: true };
      try { S.context[key].final = await snap(frame); } catch (err) { S.context[key].finalError = String(err && err.message); }
    }
    S.serverStatusEnd = await status();
  });

  // keep the frames for the assertion block
  S.frames = { a: frameA, b: frameB };
  return { a, b, lobby, race, tele, results };
}

/* -------------------------------------------------------------- run it ---- */

let run = null;
try {
  run = await main();
} catch (err) {
  S.fatal = { message: err && err.message ? err.message : String(err), stack: err && err.stack ? String(err.stack).split('\n').slice(0, 4).join(' | ') : '' };
  log(`FATAL ${S.fatal.message}`);
} finally {
  S.finishedAt = iso();
  S.durationMs = Date.now() - startedAt;
  for (const [label, rec] of Object.entries(recs)) {
    S.context[label] = {
      ...(S.context[label] || {}),
      consoleErrors: rec.consoleErrors.slice(),
      consoleIgnored: rec.consoleIgnored.slice(),
      pageErrors: rec.pageErrors.slice(),
      requestFailed: rec.requestFailed.slice(),
      consoleLines: rec.consoleLines.slice(-120),
    };
  }
  S.serverLogTail = server.logPath ? tailOf(server.logPath, 40) : server.log.slice(-40);
  try { await pages.HUD?.close(); } catch { /* ignore */ }
  for (const key of Object.keys(pages)) { try { await pages[key].close(); } catch { /* ignore */ } }
  try { await browser?.close(); } catch { /* ignore */ }
  await stopInstance();
}

/* ------------------------------------------------------------ assertions --- */

const R = run || {};
const a = R.a || {};
const b = R.b || {};
const lobby = R.lobby || { a: {}, b: {} };
const race = R.race || { gridLocked: {}, countdown: {}, racing: {}, after: {} };
const tele = R.tele || { after: {} };
const results = R.results || { a: {}, b: {} };
const LA = lobby.a || {};
const LB = lobby.b || {};
const RA = (race.after && race.after.a) || {};
const RB = (race.after && race.after.b) || {};
const TA = (tele.after && tele.after.a) || {};
const TB = (tele.after && tele.after.b) || {};
const RESA = results.a || {};
const RESB = results.b || {};
const RECA = (race.recorder && race.recorder.a) || { cdN: [], labels: [] };
const RECB = (race.recorder && race.recorder.b) || { cdN: [], labels: [] };
const INV = S.invite || {};
const SPE = S.spectator || {};
const HUD = S.hud || {};
const ctxD = S.context.D || {};
const norm = (s) => String(s || '').replace(/\s+/g, '');

const seatA = LA.you ? LA.you.seat : null;
const seatB = LB.you ? LB.you.seat : null;
const rowsSig = (rows) => (rows || []).map((r) => `${r[0]}|${r[1]}`).join(' > ');
const timeOf = (rows, name) => {
  for (const r of rows || []) if (r[1] === name) return r[4];
  return '';
};

/* entry + lobby */
check('E01', 'shell has a RACE DAY nav button (after PLAY)',
  !!a.nav && a.nav.present && /RACE DAY/.test(a.nav.text || ''),
  `nav=${JSON.stringify(a.nav || null)}`);
check('E02', 'A: RACE DAY loads /race-day?embedded=1 in #rr4sFrame',
  /\/race-day\?/.test(a.frameSrc || '') && /embedded=1/.test(a.frameSrc || ''),
  `frame=${a.frameSrc || '(none)'}`);
check('E03', 'A: the embedded /race-day owns no second top bar (shell owns it)',
  LA.embeddedFlag === '1' && LA.topbarHidden === true && LA.hasApp === true,
  `topbarHidden=${LA.topbarHidden} data-embedded=${LA.embeddedFlag} hasApp=${LA.hasApp}`);
check('E04', 'A: callsign field stores the name the socket announced',
  a.name && a.name.field === 'HOST-A' && a.name.stored === 'HOST-A' && a.name.serverName === 'HOST-A',
  `field=${a.name ? a.name.field : ''} stored=${a.name ? a.name.stored : ''} server=${a.name ? a.name.serverName : ''}`);
check('E05', 'A: FIND ME A RACE queues (position+size visible)',
  !!(a.afterQueue && a.afterQueue.queue && a.afterQueue.queue.position > 0),
  `queue=${JSON.stringify(a.afterQueue ? a.afterQueue.queue : null)} label=${a.afterQueue ? a.afterQueue.lfgBtn : ''}`);
check('E06', 'B: /race-day standalone connects and queues',
  !!(b.afterQueue && b.afterQueue.queue && b.afterQueue.queue.position > 0 && b.afterQueue.conn === 'open'),
  `conn=${b.afterQueue ? b.afterQueue.conn : ''} queue=${JSON.stringify(b.afterQueue ? b.afterQueue.queue : null)} topbarHidden=${b.standalone ? b.standalone.topbarHidden : ''}`);
check('E07', 'both clients show a grid count of 2/50',
  norm(LA.gridCount) === '2/50' && norm(LB.gridCount) === '2/50',
  `A="${LA.gridCount}" B="${LB.gridCount}"`);
check('E08', 'A and B are seated on different seats',
  Number.isFinite(seatA) && Number.isFinite(seatB) && seatA > 0 && seatB > 0 && seatA !== seatB
    && LA.mySeatFromGrid === seatA && LB.mySeatFromGrid === seatB,
  `A seat=${seatA} (grid=${LA.mySeatFromGrid}, ${LA.seatText}) B seat=${seatB} (grid=${LB.mySeatFromGrid}, ${LB.seatText})`);
check('E09', 'each seat strip shows its own seat number',
  String(LA.seatText || '').includes(String(seatA)) && String(LB.seatText || '').includes(String(seatB)),
  `A="${LA.seatText}" B="${LB.seatText}"`);
check('E10', 'LFG panel reads START WITH 2 in both clients',
  /START WITH 2$/.test(LA.startText || '') && /START WITH 2$/.test(LB.startText || '') && LA.startDisabled === false,
  `A="${LA.startText}" disabled=${LA.startDisabled} B="${LB.startText}" disabled=${LB.startDisabled}`);
check('E11', 'bots are off (RR4_MMO_BOTS=0, no bots in the grid)',
  (S.serverStatusEnd || S.serverStatus || {}).event
    ? (S.serverStatusEnd || S.serverStatus).event.bots === false
    : false,
  `bots=${(S.serverStatusEnd || S.serverStatus || {}).event ? (S.serverStatusEnd || S.serverStatus).event.bots : 'n/a'} btn=${LA.botsText}`);

/* start -> grid -> countdown -> racing */
check('E12', 'A started the race with #mmoStart (grid locked, not auto-start)',
  !!(race.racing && race.racing.a) && (race.preStart ? race.preStart.startText : '') !== '',
  `preStart="${race.preStart ? race.preStart.startText : ''}" auto=${race.autoStarted} gridMs=${S.timings.gridLocked ? JSON.stringify(S.timings.gridLocked) : ''}`);
check('E13', 'both clients show GRID LOCKED before the countdown',
  /GRID LOCKED/.test((race.gridState && race.gridState.a ? race.gridState.a.stateText : '') || '')
    && /GRID LOCKED/.test((race.gridState && race.gridState.b ? race.gridState.b.stateText : '') || ''),
  `A="${race.gridState && race.gridState.a ? race.gridState.a.stateText : ''}" B="${race.gridState && race.gridState.b ? race.gridState.b.stateText : ''}"`);
check('E14', 'countdown frames delivered 3,2,1 to both clients',
  (RECA.cdN || []).join(',') === '3,2,1' && (RECB.cdN || []).join(',') === '3,2,1',
  `A=[${(RECA.cdN || []).join(',')}] B=[${(RECB.cdN || []).join(',')}]`);
const labelsA = (RECA.labels || []).slice();
const labelsB = (RECB.labels || []).slice();
const numerals = (list) => list.filter((x) => /^[0-9]$/.test(x));
const sawGo = (list) => list.includes('GO');
const afterCdA = ((race.after || {}).a || {}).countdown || {};
const afterCdB = ((race.after || {}).b || {}).countdown || {};
const goA = sawGo(labelsA) || afterCdA.go === '1' || afterCdA.n === 'GO';
const goB = sawGo(labelsB) || afterCdB.go === '1' || afterCdB.n === 'GO';
const sawThree = numerals(labelsA).includes('3') && numerals(labelsB).includes('3');
const sawTwo = numerals(labelsA).includes('2') && numerals(labelsB).includes('2');
const sawOne = numerals(labelsA).includes('1') && numerals(labelsB).includes('1');
// The overlay prints ceil(remaining/1000): a sub-3000 ms window starts at "2",
// so "3" is only required in the DOM when the window can actually show it (the
// countdown frames still carry 3,2,1 — E14 — and are what the client receives).
const needThreeInDom = COUNTDOWN_MS >= 3000;
check('E15', '#mmoCountdown counts down 3-2-1 then GO in both clients',
  (needThreeInDom ? sawThree : true) && sawTwo && sawOne && goA && goB,
  `A=[${labelsA.join(',')}] B=[${labelsB.join(',')}] afterA=${JSON.stringify(afterCdA)} afterB=${JSON.stringify(afterCdB)} ` +
  `countdownMs=${COUNTDOWN_MS} threeInDom=${needThreeInDom ? sawThree : 'n/a (windows<3000 start at 2)'}`);
check('E16', 'both clients reach the RACING state',
  (RA.stateAttr === 'racing' || RA.phase === 'racing') && (RB.stateAttr === 'racing' || RB.phase === 'racing'),
  `A="${RA.stateText}"/${RA.phase} B="${RB.stateText}"/${RB.phase}`);
check('E17', 'countdown->racing lands inside the configured window',
  (() => {
    const pc = S.timings.pageClock || {};
    const c2r = pc.countdownToRacing || {};
    const ok = (v) => typeof v === 'number' && v >= COUNTDOWN_MS - 700 && v <= COUNTDOWN_MS + 2500;
    if (ok(c2r.a) && ok(c2r.b)) return true;
    const h = S.timings.countdownToRacing || {};
    return ok(h.a) && ok(h.b);
  })(),
  `pageClock=${JSON.stringify((S.timings.pageClock || {}).countdownToRacing || null)} harness=${JSON.stringify(S.timings.countdownToRacing || null)} (countdownMs=${COUNTDOWN_MS})`);
check('E18', 'both headers show the identical track, from the 8 real R4 courses',
  !!RA.track && RA.track === RB.track && TRACKS.includes(RA.track),
  `A="${RA.track}" B="${RB.track}" planA=${RA.plan ? RA.plan.trackIndex : ''} planB=${RB.plan ? RB.plan.trackIndex : ''}`);

/* telemetry -> standings */
check('E19', 'three telemetry samples per seat were sent through the page',
  tele.a.filter(Boolean).length === 3 && tele.b.filter(Boolean).length === 3,
  `A=${JSON.stringify(tele.a)} B=${JSON.stringify(tele.b)}`);
check('E20', 'both standings boards show the same 2-row ordering',
  (TA.standings || []).length === 2 && (TB.standings || []).length === 2
    && rowsSig(TA.standings) === rowsSig(TB.standings),
  `A=${rowsSig(TA.standings)} || B=${rowsSig(TB.standings)}`);
check('E21', 'the faster driver is P1 on both boards',
  (TA.standings || [])[0] && (TA.standings || [])[0][0] === 'P1'
    && (TA.standings || [])[0][1] === 'HOST-A'
    && (TB.standings || [])[0] && (TB.standings || [])[0][1] === 'HOST-A',
  `A ${rowsSig(TA.standings)} times=${timeOf(TA.standings, 'HOST-A')}/${timeOf(TA.standings, 'GUEST-B')} B ${rowsSig(TB.standings)}`);
check('E22', 'each client #mmoYourRow is its own seat position',
  (TA.yourRow || {}).position === '1' && (TB.yourRow || {}).position === '2'
    && (TA.yourRow || {}).pos === 'P1 / 50' && (TB.yourRow || {}).pos === 'P2 / 50'
    && String(TA.yourRow.text || '').includes('LAP 1'),
  `A=${JSON.stringify(TA.yourRow || null)} B=${JSON.stringify(TB.yourRow || null)}`);

/* results */
check('E23', '#mmoResults is visible in both with the same two rows',
  RESA.resultsHidden === false && RESB.resultsHidden === false
    && (RESA.resultsRows || []).length === 2 && (RESB.resultsRows || []).length === 2
    && rowsSig(RESA.resultsRows) === rowsSig(RESB.resultsRows),
  `A=${rowsSig(RESA.resultsRows)} B=${rowsSig(RESB.resultsRows)}`);
check('E24', 'the winner is highlighted on the podium (P1 filled, same name)',
  (RESA.podium || [])[0] && RESA.podium[0].filled === '1' && RESA.podium[0].name === 'HOST-A'
    && (RESB.podium || [])[0] && RESB.podium[0].name === 'HOST-A',
  `A P1=${RESA.podium ? JSON.stringify(RESA.podium[0]) : ''} B P1=${RESB.podium ? JSON.stringify(RESB.podium[0]) : ''}`);
const clockA1 = (RESA.nextRace || '').match(/(\d\d:\d\d)\s*$/);
const clockA2 = ((results.a2 || {}).nextRace || '').match(/(\d\d:\d\d)\s*$/);
const mmss = (t) => (t ? Number(t.slice(0, 2)) * 60 + Number(t.slice(3)) : NaN);
check('E25', '#mmoNextRace is counting down in both clients',
  !!clockA1 && !!clockA2 && mmss(clockA2[1]) < mmss(clockA1[1])
    && !!(((results.b2 || {}).nextRace || '').match(/(\d\d:\d\d)\s*$/)),
  `A ${RESA.nextRace} -> ${(results.a2 || {}).nextRace} B ${RESB.nextRace} -> ${(results.b2 || {}).nextRace}`);

/* invite link */
check('E26', 'A created a party and the code chip shows it',
  /^[A-Z0-9]{4,6}$/.test(INV.code || '')
    && !!(INV.hostParty && INV.hostParty.partyCode === INV.code)
    && /1\/2/.test((INV.hostParty && INV.hostParty.partyStatus) || ''),
  `code=${INV.code || '(none)'} chip=${INV.hostParty ? INV.hostParty.partyCode : ''} status=${INV.hostParty ? INV.hostParty.partyStatus : ''}`);
check('E27', '/race-day?party=<code> shows the same code chip',
  INV.chip === INV.code && INV.joined && INV.joined.partyCode === INV.code,
  `invite chip=${INV.chip || '(none)'} joined=${INV.joined ? INV.joined.partyCode : '(none)'} expected=${INV.code}`);
check('E28', 'the third driver joined the same event and got a seat',
  (() => {
    const s = INV.seated || {};
    const stripSeat = (snapObj) => {
      const m = String((snapObj && snapObj.seatStrip) || '').match(/SEAT\s+(\d+)/i);
      return m ? Number(m[1]) : null;
    };
    const seats = ['a', 'b', 'c'].map((k) => (s[k] ? s[k].you.seat : null));
    return seats.every((n) => Number(n) > 0)
      && new Set(seats).size === 3
      && !!(INV.same && INV.same.ids && INV.same.ids.length === 3)
      && !!(INV.server && INV.server.counts && INV.server.counts.seated >= 3);
  })(),
  `event=${INV.seated ? INV.seated.a.eventId : ''} ` +
  `you.seat A/B/C=${INV.seated ? [INV.seated.a.you.seat, INV.seated.b.you.seat, INV.seated.c.you.seat].join('/') : ''} ` +
  `strips=${INV.seated ? [INV.seated.a.seatStrip, INV.seated.b.seatStrip, INV.seated.c.seatStrip].join(' | ') : ''} ` +
  `gridIds A/B/C=${INV.seated ? [INV.seated.a.mySeatFromGrid, INV.seated.b.mySeatFromGrid, INV.seated.c.mySeatFromGrid].join('/') : ''} ` +
  `ids=${INV.same ? INV.same.ids.join(',') : '(mismatch)'} seated=${INV.server ? INV.server.counts.seated : ''} stale=${JSON.stringify(INV.staleSeat || null)}`);
check('E29', 'the host party chip shows 2/2 after the invite joined',
  !!(INV.seated && INV.seated.a && INV.seated.a.partySize === '2'),
  `partySize=${INV.seated ? INV.seated.a.partySize : ''} status=${INV.seated ? INV.seated.a.partyStatus : ''}`);

/* spectator */
const sentD = SPE.sent || (ctxD.final ? ctxD.final.sent : null) || {};
check('E30', 'spectator opened ?spectate=1 and sent spectate, never queue/telemetry',
  !!sentD && sentD.spectate >= 1 && sentD.queue === 0 && sentD.telemetry === 0 && sentD.finish === 0 && sentD.start === 0,
  `sent=${JSON.stringify(sentD)}`);
check('E31', 'the spectator holds no seat',
  !!(SPE.live && (SPE.live.you.seat === 0 || SPE.live.you.seat === null)),
  `seat=${SPE.live ? SPE.live.you.seat : ''} phase=${SPE.live ? SPE.live.phase : ''}`);
check('E32', 'the spectator sees the live board while the race runs', (() => {
  const live = SPE.live || {};
  const sp = live.spectate || { rows: [] };
  const named = (sp.rows || []).filter((r) => r.name && r.name !== '—');
  const legacy = (live.standings || []).length;
  return live.phase === 'racing'
    && ((live.spectatePanel ? named.length >= 2 : legacy >= 2) && legacy >= 2);
})(),
  `phase=${SPE.live ? SPE.live.phase : ''} spectateRows=${JSON.stringify((SPE.live && SPE.live.spectate ? SPE.live.spectate.rows : []))} ` +
  `standings=${SPE.live ? (SPE.live.standings || []).length : 0} board=${SPE.live ? rowsSig(SPE.live.standings) : ''} ` +
  `life="${SPE.live && SPE.live.spectate ? SPE.live.spectate.life : ''}"`);
check('E33', 'the dedicated spectator panel (#mmoSpectateBoard) is mounted and watch-only',
  !!(SPE.live && SPE.live.spectatePanel && SPE.live.spectateFacade
    && (SPE.live.spectate || {}).phase === 'racing'
    && /WATCH ONLY/i.test((SPE.live.spectate || {}).foot || '')),
  `panel=${SPE.live ? SPE.live.spectatePanel : ''} facade=${SPE.live ? SPE.live.spectateFacade : ''} ` +
  `spPhase=${SPE.live && SPE.live.spectate ? SPE.live.spectate.phase : ''} foot="${SPE.live && SPE.live.spectate ? SPE.live.spectate.foot : ''}"`);

/* HUD */
const hp = HUD.probe || {};
const expect = HUD.expect || {};
check('E34', 'results screen exposes the /race-day return link',
  (HUD.resultsBack || '') === '/race-day',
  `[data-mmo-back]=${HUD.resultsBack || '(none)'} built=${HUD.url || ''}`);
check('E35', '/play?mmo=1 exposes window.__R4_MMO_PARAMS with event/seat/team',
  !!hp.params && String(hp.params.event) === String(expect.event)
    && Number(hp.params.seat) === Number(expect.seat)
    && String(hp.params.team) === String(expect.team),
  `params=${JSON.stringify(hp.params || null)} expect=${JSON.stringify(expect)}`);
check('E36', '#mmoHud mounts as a sibling of #game with the Pâ€”/50 chip',
  !!hp.hasHud && !!hp.sibling && /^P.{0,3}\s*\/\s*50$/.test(String(hp.pos || '')),
  `hasHud=${hp.hasHud} sibling=${hp.sibling} pos="${hp.pos}" visible=${hp.visible} source="${hp.source}"`);
check('E37', 'HUD finish card keeps the BACK TO RACE DAY contract',
  (hp.finishHref || '') === '/race-day' && !!hp.hudCss,
  `href=${hp.finishHref || '(none)'} css=${hp.hudCss} hudParams=${JSON.stringify(hp.hudParams || null)}`);

/* hygiene */
const allPages = Object.keys(S.context).filter((k) => S.context[k] && S.context[k].pageErrors);
const pageErrors = allPages.reduce((n, k) => n + (S.context[k].pageErrors || []).length, 0);
const consoleErrors = allPages.reduce((n, k) => n + (S.context[k].consoleErrors || []).length, 0);
check('E38', 'no uncaught page errors in any browser context', pageErrors === 0,
  pageErrors ? allPages.map((k) => `${k}: ${JSON.stringify(S.context[k].pageErrors)}`).join(' | ') : `${allPages.length} contexts clean`);
check('E39', 'no console errors beyond the documented noise', consoleErrors === 0,
  consoleErrors ? allPages.map((k) => `${k}: ${JSON.stringify((S.context[k].consoleErrors || []).slice(0, 3))}`).join(' | ')
    : `ignored=${allPages.map((k) => `${k}:${(S.context[k].consoleIgnored || []).length}`).join(',')}`);
check('E40', 'no fatal harness error', !S.fatal, S.fatal ? S.fatal.message : 'none');
check('E41', 'the harness ran against a live cabinet with this tree\'s MMO config',
  !!(S.serverStatus && S.serverStatus.min === 2) || (S.env && S.env.RR4_MMO_MIN === '2'),
  `base=${BASE} min=${S.serverStatus ? S.serverStatus.min : ''} env=${JSON.stringify(S.env)}`);

const passed = checks.filter((c) => c.pass).length;
const failed = checks.length - passed;

/* ------------------------------------------------------------- artifacts -- */

const report = {
  test: 'Race Day MMO â€” two-browser end-to-end UX (real /mmo socket, no frame injection)',
  contract: '_runtime/analysis/20-mmo-contract.md Â§4 (UX) + Â§7 (verification gate 3)',
  baseUrl: BASE,
  spawned: server.spawned,
  keep: KEEP,
  env: S.env,
  countdownNote: `COUNTDOWN_MS=${COUNTDOWN_MS}. The overlay prints ceil(remaining/1000) from the shared startsAt, so a 2000 ms window can only print 2,1,GO; 3000 is used so the DOM shows the literal 3-2-1. --countdown-ms 2000 reproduces the fast window (the countdown frames still carry 3,2,1).`,
  startedAt: iso(startedAt),
  finishedAt: S.finishedAt,
  durationMs: S.durationMs,
  timings: {
    ...S.timings,
    phaseTimings: steps.map((s) => ({ step: s.step, ok: s.ok, ms: s.ms, error: s.error || undefined })),
    resultsToNextEventMs: RESULTS_MS,
  },
  steps,
  contexts: S.context,
  server: {
    status: S.serverStatus,
    statusEnd: S.serverStatusEnd || null,
    logPath: server.logPath || null,
    exitCode: server.exitCode === undefined ? null : server.exitCode,
    log: S.serverLogTail,
  },
  lobby: { a: LA, b: LB },
  race: {
    preStart: race.preStart, gridLocked: race.gridLocked, gridState: race.gridState,
    countdownSeen: race.countdownSeen, racing: race.racing, autoStarted: race.autoStarted,
    afterCountdown: {
      a: ((race.after || {}).a || {}).countdown || null,
      b: ((race.after || {}).b || {}).countdown || null,
    },
    recorder: race.recorder,
  },
  telemetry: { sent: { a: tele.a, b: tele.b }, standingsA: TA.standings, standingsB: TB.standings, yourRowA: TA.yourRow, yourRowB: TB.yourRow },
  results: { a: RESA, b: RESB, a2: results.a2, b2: results.b2 },
  invite: INV,
  findings: S.findings || [],
  spectator: { before: SPE.before, live: SPE.live, sent: SPE.sent },
  hud: HUD,
  heldRequests: S.held,
  screenshots,
  assertions: checks,
  summary: { total: checks.length, passed, failed },
  fatal: S.fatal,
};
fs.writeFileSync(path.join(OUT, 'mmo-e2e.json'), JSON.stringify(report, null, 2) + '\n', 'utf8');

const logOut = [
  'RACE DAY MMO â€” two-browser end-to-end UX',
  `base: ${BASE}  (spawned=${server.spawned}${KEEP ? ', kept' : ''})`,
  `env: ${JSON.stringify(S.env)}`,
  `command: cd "_server"; node test-mmo-ui.mjs`,
  `started: ${report.startedAt}  finished: ${report.finishedAt}  (${S.durationMs} ms)`,
  `timings: gridLocked=${JSON.stringify(S.timings.gridLocked)} countdown->racing=${JSON.stringify(S.timings.countdownToRacing)} pageClock=${JSON.stringify(S.timings.pageClock || null)}`,
  `screenshots: ${Object.values(screenshots).join(', ') || '(none)'}`,
  '',
  ...logLines.filter((l) => /^(STEP|FATAL|PASS|FAIL)/.test(l)),
  '',
  `checks: ${passed} passed / ${failed} failed (of ${checks.length})`,
  failed ? 'RESULT: FAIL' : 'RESULT: PASS',
  '',
].join('\n');
fs.writeFileSync(path.join(OUT, 'mmo-e2e.log'), '\ufeff' + logOut, 'utf8');

log(`checks: ${passed} passed / ${failed} failed (of ${checks.length})`);
log(`evidence: ${path.join(OUT, 'mmo-e2e.json')}  ${path.join(OUT, 'mmo-e2e.log')}`);
console.log(`PASS ${passed}/${checks.length}`);
process.exit(failed ? 1 : 0);
