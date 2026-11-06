// Rage Racer shared-car host evidence (NOT a two-browser race).
//
// Boots `/play-net?game=rage&mpRole=host` in one browser, forces the manual
// shared-car path with `window.__R4NET.mpRun()` and proves:
//   - the page selects the rage manifest entry (mode shared-car, macro manual);
//   - the plan clamps to the four Rage courses / four car slots;
//   - the relay room name uses the RAGE- prefix;
//   - no R4 menu macro runs (`macro:manual` only);
//   - the host installs the player 1 -> player 0 input remap on the real core.
//
// It does NOT prove a live shared drive: there is no guest and no race.
// Run:  cd _server; node test-mp-shared-car.mjs
// Options: --base http://127.0.0.1:8080 (attach), --port <n>, --keep
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.resolve(HERE, '..', '_runtime');
const CHROME_CANDIDATES = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files/BraveSoftware/Brave-Browser/Application/brave.exe',
];
const argv = process.argv.slice(2);
const arg = (name, def = null) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : def;
};
const PORT = Number(arg('--port', 8094));
const BASE_ARG = arg('--base', process.env.RR4_BASE || '');
const BASE = (BASE_ARG || `http://localhost:${PORT}`).replace(/\/+$/, '');
const KEEP = argv.includes('--keep');
const RACE = `shared-${Date.now()}`;
const URL_ = `${BASE}/play-net?game=rage&threads=0&cache=0&bios=hle`
  + `&mpRole=host&mpRoom=TEST&mpRace=${RACE}`
  + '&mpTrackIndex=2&mpCarHost=1&mpCarGuest=3';

const checks = [];
const pageErrors = [];
const consoleErrors = [];
const server = { spawned: false, pid: 0, logPath: '' };
let browser = null;

function check(id, name, pass, detail) {
  checks.push({ id, name, pass: !!pass, detail });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${id}  ${name}  -- ${detail}`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const iso = (t) => new Date(t).toISOString();

async function status() {
  try {
    const res = await fetch(`${BASE}/api/health`, { signal: AbortSignal.timeout(1500) });
    return res.ok ? res.json() : null;
  } catch { return null; }
}

async function startInstance() {
  if (BASE_ARG) {
    const st = await status();
    if (!st) throw new Error(`--base ${BASE} has no /api/health`);
    return { attached: true, ...st };
  }
  const st = await status();
  if (st) throw new Error(`:${PORT} already in use - pass --base ${BASE} or --port <free>`);
  const logPath = path.join(OUT, `mp-shared-car-server-${PORT}.log`);
  const fd = fs.openSync(logPath, 'a');
  server.logPath = logPath;
  const child = spawn(process.execPath, ['src/server.js'], {
    cwd: HERE,
    env: { ...process.env, RR4_PORT: String(PORT), RR4_NO_AUTOSTART: '1', RR4_STREAM_SOURCE: 'test' },
    stdio: ['ignore', fd, fd],
    windowsHide: true,
    detached: true,
  });
  fs.closeSync(fd);
  server.spawned = true;
  server.pid = child.pid;
  for (let i = 0; i < 80; i += 1) {
    const s = await status();
    if (s) return { attached: false, ...s };
    await sleep(250);
  }
  throw new Error(`server on :${PORT} did not answer`);
}

function killServer() {
  if (!server.spawned || KEEP) return;
  try { spawn('taskkill.exe', ['/T', '/F', '/PID', String(server.pid)], { windowsHide: true }); } catch { /* ignore */ }
}

async function waitFor(page, fn, timeout = 60000, step = 500) {
  const t0 = Date.now();
  for (;;) {
    let value;
    try { value = await page.evaluate(fn); } catch { value = null; }
    if (value) return value;
    if (Date.now() - t0 > timeout) return null;
    await sleep(step);
  }
}

try {
  const st = await startInstance();
  console.log(`instance: ${BASE}  spawned=${!st.attached}`);
  const chrome = CHROME_CANDIDATES.find((p) => fs.existsSync(p));
  if (!chrome) throw new Error('no Chrome/Brave at the known paths');
  browser = await puppeteer.launch({
    executablePath: chrome,
    headless: true,
    protocolTimeout: 240000,
    defaultViewport: { width: 1440, height: 900 },
    args: ['--no-sandbox', '--disable-background-timer-throttling', '--mute-audio', '--window-size=1440,900'],
  });
  const page = await browser.newPage();
  page.on('pageerror', (e) => pageErrors.push(String(e && e.message ? e.message : e)));
  page.on('console', (m) => {
    if (m.type() === 'error') consoleErrors.push(String(m.text()).slice(0, 300));
  });

  console.log(`goto ${URL_}`);
  await page.goto(URL_, { waitUntil: 'domcontentloaded', timeout: 60000 });

  const booted = await waitFor(page, () => !!(window.__R4 && window.__R4.startedAt && window.__R4MP), 90000);
  check('01-core', 'Rage Racer core boots on /play-net', !!booted,
    booted ? `boot=${await page.evaluate(() => window.__R4.bootMs)} ms` : 'no startedAt in 90 s');

  const pre = await page.evaluate(() => {
    const m = window.__R4MP || {};
    const r = window.__R4 || {};
    return {
      game: m.game, mode: m.mode, macro: m.macro, macroVerified: m.macroVerified,
      gamesApplied: m.gamesApplied, tracks: (m.tracks || []).length, cars: (m.cars || []).length,
      trackIndex: m.trackIndex, carHost: m.carHost, carGuest: m.carGuest,
      roomName: m.roomName, plan: window.__R4NET && window.__R4NET.planText ? window.__R4NET.planText() : '',
      brand: (document.querySelector('#brandGame') || {}).textContent || '',
      title: document.title, stateGame: r.game,
    };
  });

  check('02-game', 'page runs the rage entry', pre.game === 'rage' && pre.stateGame === 'rage',
    `game=${pre.game} __R4.game=${pre.stateGame}`);
  check('03-mode', 'manifest sets shared-car + manual', pre.mode === 'shared-car' && pre.macro === 'manual',
    `mode=${pre.mode} macro=${pre.macro} applied=${pre.gamesApplied}`);
  check('04-plan', 'plan lists clamp to 4 Rage courses / 4 car slots',
    pre.tracks === 4 && pre.cars === 4 && pre.trackIndex === 2 && pre.carHost === 1 && pre.carGuest === 3,
    `tracks=${pre.tracks} cars=${pre.cars} idx=${pre.trackIndex}/${pre.carHost}/${pre.carGuest}`);
  check('05-plan-names', 'plan text uses the Rage course list', /Lakeside Gate/.test(pre.plan),
    `plan="${pre.plan}"`);
  check('06-room-prefix', 'relay room name uses RAGE-', pre.roomName === 'RAGE-TEST',
    `roomName=${pre.roomName}`);
  check('07-brand', 'brand/title say 2P SHARED (not 1P)', /2P SHARED/.test(pre.brand) && /2P SHARED/.test(pre.title),
    `brand="${pre.brand}" title="${pre.title}"`);

  // Force the manual shared-car path without waiting for a second netplay client.
  const ran = await page.evaluate(() => {
    try { window.__R4NET.mpRun(); return true; } catch (e) { return String(e && e.message ? e.message : e); }
  });
  check('08-manual-run', 'mpRun() enters the manual path', ran === true, `mpRun=${ran}`);

  const remapped = await waitFor(page, () => !!(window.__R4MP && window.__R4MP.coopRemap), 30000, 300);
  const post = await page.evaluate(() => {
    const m = window.__R4MP || {};
    return {
      stage: m.stage, stages: (m.stages || []).map((s) => s.stage),
      coopRemap: m.coopRemap, remappedInputs: m.remappedInputs,
      raceLive: m.raceLive, roomName: m.roomName,
    };
  });
  check('09-remap-install', 'host installs the shared-car input remap', !!remapped && post.coopRemap === true,
    `coopRemap=${post.coopRemap} stage=${post.stage}`);
  check('10-no-r4-macro', 'no R4 menu stages ran', post.stage === 'macro:manual'
    && post.stages.every((s) => !/^(menu|car|course|race):/.test(s)),
    `stages=${post.stages.join(',') || '(none)'}`);
  check('11-guest-live', 'host is live without a race-live handshake', post.raceLive === true,
    `raceLive=${post.raceLive}`);

  // Exercise the wrapper: a player-1 call must reach the core as player 0 and
  // bump the counter; a player-0 call must not.
  const press = await page.evaluate(() => {
    const em = window.EJS_emulator;
    const f = em && em.gameManager && em.gameManager.functions;
    if (!f || typeof f.simulateInput !== 'function') return { ok: false };
    const before = window.__R4MP.remappedInputs || 0;
    f.simulateInput(1, 0, 1);
    const afterGuest = window.__R4MP.remappedInputs || 0;
    f.simulateInput(0, 0, 1);
    const afterHost = window.__R4MP.remappedInputs || 0;
    return { ok: true, before, afterGuest, afterHost };
  });
  check('12-remap-count', 'guest pad (player 1) is folded and counted; player 0 is not',
    press.ok && press.afterGuest === press.before + 1 && press.afterHost === press.afterGuest,
    `before=${press.before} afterGuest=${press.afterGuest} afterHost=${press.afterHost}`);

  const shot = path.join(OUT, 'mp-shared-car-rage.png');
  await page.screenshot({ path: shot });
  check('13-shot', 'screenshot captured', fs.existsSync(shot), shot);

  check('14-page-errors', 'no uncaught page errors', pageErrors.length === 0,
    pageErrors.slice(0, 2).join(' | ') || '0');

  const evidence = {
    ok: checks.every((c) => c.pass),
    run: iso(Date.now()),
    base: BASE,
    url: URL_,
    checks,
    pageErrors,
    consoleErrors,
    screenshots: [shot],
    scopeNote: 'Host-only Rage Racer shared-car evidence: core boot, manifest mode, plan clamp, '
      + 'RAGE- room prefix, manual stage and the player 1 -> 0 remap install/press. '
      + 'No guest, no live drive, no in-game 2P proof. Rage/Ridge remain '
      + '"netplay transport; in-game mode unverified".',
  };
  fs.writeFileSync(path.join(OUT, 'mp-shared-car.json'), JSON.stringify(evidence, null, 2));
  const passed = checks.filter((c) => c.pass).length;
  console.log(`\nchecks: ${passed}/${checks.length} passed`);
  console.log(`evidence: ${path.join(OUT, 'mp-shared-car.json')}`);
  if (!evidence.ok) process.exitCode = 1;
} catch (e) {
  console.error(`FATAL: ${e && e.stack ? e.stack : e}`);
  process.exitCode = 1;
} finally {
  if (browser) { try { await browser.close(); } catch { /* ignore */ } }
  killServer();
  await sleep(300);
}
