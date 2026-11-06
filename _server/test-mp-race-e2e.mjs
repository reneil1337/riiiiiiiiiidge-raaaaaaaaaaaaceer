// Two-browser proof of the direct 2P head-to-head race (the pending gate).
//
// One Chrome, two independent browser contexts: ENTER shell -> 2P LOUNGE ->
// host creates the room -> guest joins -> both READY -> the shell hands both
// browsers to the REAL /play-net?... document (nothing is intercepted here).
// Both cores boot, the guest joins the host's relay room, the host macro walks
// R4's VS Battle menus to race:live, the guest receives the host stream, the
// guest gate is checked, and guest input is proven to reach the host core as
// PLAYER 2 (player index 1).
//
// Usage: cd "_server"; node test-mp-race-e2e.mjs
// Server: http://localhost:8080 (already running, relay on :3010).
//
// Writes to _runtime/:
//   mp-race-e2e.json                        full evidence + checks
//   mp-race-e2e.log                         summary (checks: N passed / M failed)
//   mp-race-e2e-host.png                    host split-screen after race:live + 6 s
//   mp-race-e2e-guest.png                   guest host-stream at the same moment
//   mp-race-e2e-host-course.png             host course select (course:locked)
//   mp-race-e2e-host-go.png / -guest-go.png 2P lounge GO overlay
//   mp-race-e2e-guest-before.png / -after.png  guest stream around the P2 input
import fs from 'node:fs';
import path from 'node:path';
import puppeteer from 'puppeteer-core';

const BASE = process.env.RR4_MP_BASE || 'http://localhost:8080';
const OUT = '../_runtime';
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const PROFILE = path.join(process.env.TEMP || 'C:/Windows/Temp', 'rr4-e2e-profile');
const STEP_TIMEOUT_MS = 30000;
const NAV_TIMEOUT_MS = 30000;
// Core boot + disc download in two fresh contexts, then the host macro.
const BOOT_TIMEOUT_MS = 300000;
const MACRO_TIMEOUT_MS = 300000;
const JOIN_TIMEOUT_MS = 120000;
const RACE_SHOT_DELAY_MS = 6000;
const RACE_FRAME_DELAY_MS = 18000;
const RACE_VISIBLE_TIMEOUT_MS = 90000;
const INPUT_WAIT_MS = 20000;

fs.mkdirSync(OUT, { recursive: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const iso = (t) => new Date(t).toISOString();
const logLines = [];
const log = (...a) => {
  const line = a.map((v) => (typeof v === 'string' ? v : JSON.stringify(v))).join(' ');
  console.log(line);
  logLines.push(line);
};

const steps = [];
async function step(name, fn) {
  const startedAt = Date.now();
  try {
    const value = await fn();
    steps.push({ name, ok: true, ms: Date.now() - startedAt, startedAt: iso(startedAt) });
    log(`STEP OK   ${name} (${Date.now() - startedAt} ms)`);
    return value;
  } catch (err) {
    const message = err && err.message ? err.message : String(err);
    steps.push({ name, ok: false, ms: Date.now() - startedAt, startedAt: iso(startedAt), error: message });
    log(`STEP FAIL ${name} (${Date.now() - startedAt} ms): ${message}`);
    throw err;
  }
}

function randomCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let out = '';
  for (let i = 0; i < 4; i++) out += chars[Math.floor(Math.random() * chars.length)];
  return out;
}

const CODE = randomCode();

// Expected console noise on this stack (see AGENTS.md): the plain-HTTP COOP
// warning and the netplay empty-ICE warning. The guest stream also logs
// "invalid core option" style lines from the parity core; they are not errors
// this harness owns.
const IGNORED_CONSOLE = [
  /No ICE servers configured/i,
  /invalid core option/i,
  /Cross-Origin-Opener-Policy/i,
  /favicon/i,
];
const consoleIgnored = (line) => IGNORED_CONSOLE.some((re) => re.test(line));

function attach(page, label) {
  const rec = { consoleLines: [], consoleErrors: [], consoleIgnored: [], pageErrors: [], requestFailed: [] };
  page.on('console', (m) => {
    const line = `[${m.type()}] ${m.text()}`;
    rec.consoleLines.push(line);
    if (m.type() === 'error') {
      if (consoleIgnored(line)) rec.consoleIgnored.push(line);
      else rec.consoleErrors.push(line);
    }
  });
  page.on('pageerror', (e) => {
    const msg = e && e.message ? e.message : String(e);
    rec.pageErrors.push({ message: msg, stack: String((e && e.stack) || '').split('\n').slice(0, 4).join(' | ') });
    log(`  PAGEERROR[${label}] ${msg}`);
  });
  page.on('requestfailed', (r) => {
    rec.requestFailed.push({ url: r.url(), err: r.failure() ? r.failure().errorText : '' });
  });
  return rec;
}

// ------------------------------------------------------------------ shell ---
async function shellFrameSrc(page) {
  return page.evaluate(() => {
    const f = document.querySelector('#rr4sFrame');
    return f ? f.src : '';
  });
}

async function waitShellFrameUrl(page, needle, timeout = STEP_TIMEOUT_MS) {
  await page.waitForFunction(
    (n) => {
      const f = document.querySelector('#rr4sFrame');
      return !!f && String(f.src || '').includes(n);
    },
    { timeout, polling: 100 },
    needle,
  );
  return shellFrameSrc(page);
}

async function waitLobbyFrame(page, timeout = STEP_TIMEOUT_MS) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const frame = page.frames().find((f) => /\/multiplayer(\?|$)/.test(f.url()));
    if (frame) {
      try {
        const ok = await frame.evaluate(() => !!document.querySelector('#mName'));
        if (ok) return frame;
      } catch { /* context still swapping */ }
    }
    await sleep(150);
  }
  throw new Error('lobby iframe (/multiplayer) did not appear in the shell');
}

async function enterCabinet(page) {
  await page.goto(BASE + '/', { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForSelector('#rr4-enter', { visible: true, timeout: STEP_TIMEOUT_MS });
  // boot() disables ENTER until the music manifest is loaded.
  await page.waitForFunction(() => {
    const b = document.querySelector('#rr4eEnter');
    return !!b && !b.disabled;
  }, { timeout: STEP_TIMEOUT_MS, polling: 100 });
  await page.click('#rr4eEnter');
  await page.waitForFunction(() => {
    const s = document.querySelector('#rr4-shell');
    return !!s && !s.hidden;
  }, { timeout: STEP_TIMEOUT_MS, polling: 50 });
  const welcomeSrc = await waitShellFrameUrl(page, '/welcome', STEP_TIMEOUT_MS);
  await page.waitForFunction(() => {
    const f = document.querySelector('#rr4sFrame');
    try {
      const d = f.contentDocument;
      return !!d && d.readyState === 'complete' && !!d.body;
    } catch { return false; }
  }, { timeout: STEP_TIMEOUT_MS, polling: 100 });
  return { welcomeSrc, entered: true };
}

async function openLobby(page) {
  await page.click('[data-view="multiplayer"]');
  const src = await waitShellFrameUrl(page, '/multiplayer', STEP_TIMEOUT_MS);
  const frame = await waitLobbyFrame(page);
  // renderRooms() runs on the 'hello'/'rooms' websocket messages and replaces
  // the placeholder text; wait for that so create/join are not sent into a
  // socket that is still connecting.
  await frame.waitForFunction(() => {
    const el = document.querySelector('#mRooms');
    return !!el && !/scanning/i.test(el.textContent || '');
  }, { timeout: STEP_TIMEOUT_MS, polling: 100 });
  return { src, frame };
}

async function fillAndSubmit(frame, name, code, action) {
  await frame.waitForSelector('#mName', { visible: true, timeout: STEP_TIMEOUT_MS });
  await frame.click('#mName', { clickCount: 3 });
  await frame.$eval('#mName', (el) => { el.value = ''; });
  await frame.type('#mName', name, { delay: 8 });
  if (code) {
    await frame.click('#mCode', { clickCount: 3 });
    await frame.$eval('#mCode', (el) => { el.value = ''; });
    await frame.type('#mCode', code, { delay: 8 });
  }
  await frame.click(action === 'create' ? '#mCreate' : '#mJoin');
}

async function snapshotLobby(frame) {
  return frame.evaluate(() => {
    const txt = (sel) => {
      const el = document.querySelector(sel);
      return el ? String(el.textContent || '').trim() : '';
    };
    const overlay = document.querySelector('#mRace');
    let visible = false;
    if (overlay) {
      const cs = getComputedStyle(overlay);
      visible = !overlay.hidden && cs.display !== 'none' && cs.visibility !== 'hidden' && Number(cs.opacity) > 0;
    }
    return {
      roomCode: txt('#mRoomCode'),
      p1: txt('#mP1Name'),
      p2: txt('#mP2Name'),
      p1Ready: txt('#mP1Ready'),
      p2Ready: txt('#mP2Ready'),
      readyPressed: document.querySelector('#mReady')?.getAttribute('aria-pressed') === 'true',
      raceOverlayVisible: visible,
      count: txt('#mCount'),
      track: txt('#mRaceTrack'),
      cars: txt('#mRaceCars'),
      roomTrack: txt('#mTrack'),
      roomCars: txt('#mCars'),
    };
  });
}

function parseMpParams(src) {
  const out = {};
  try {
    const u = new URL(src, BASE);
    for (const k of ['mpRole', 'mpRoom', 'mpRace', 'mpTrackIndex', 'mpCarHost', 'mpCarGuest', 'embedded', 'threads']) {
      out[k] = u.searchParams.get(k);
    }
  } catch { /* leave empty */ }
  return out;
}

// --------------------------------------------------------------- play-net ---
async function waitPlayNetFrame(page, timeout = NAV_TIMEOUT_MS) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const frame = page.frames().find((f) => /\/play-net(\?|$)/.test(f.url()));
    if (frame) {
      try {
        const ok = await frame.evaluate(() => !!window.__R4NET);
        if (ok) return frame;
      } catch { /* document still loading */ }
    }
    await sleep(200);
  }
  throw new Error('play-net iframe did not expose __R4NET');
}

async function prepareFrame(frame) {
  await frame.evaluate(() => {
    try {
      const gate = document.querySelector('#soundGate');
      if (gate && !gate.hidden) gate.click();
    } catch { /* ignore */ }
    try { window.EJS_emulator?.play?.(); } catch { /* ignore */ }
    try { window.__R4NET?.closePanel?.(); } catch { /* ignore */ }
  }).catch(() => {});
}

async function waitCoreStarted(frame, label, timeout = BOOT_TIMEOUT_MS) {
  const t0 = Date.now();
  let last = null;
  while (Date.now() - t0 < timeout) {
    try {
      const s = await frame.evaluate(() => {
        const net = window.__R4NET;
        const started = !!(net && net.snapshot().started);
        const btn = document.querySelector('#game .ejs_start_button');
        if (btn && !started) btn.click();
        const r4 = window.__R4;
        return {
          started,
          hasNet: !!net,
          status: (document.querySelector('#bootStatus') || {}).textContent || '',
          errors: r4 ? (r4.errors || []).slice(-2) : [],
        };
      });
      last = s;
      if (s.started && s.hasNet) {
        await prepareFrame(frame);
        return { ok: true, ms: Date.now() - t0, last: s };
      }
      if (s.errors.length && /BOOT FAILED|ERROR/i.test(s.status)) {
        return { ok: false, ms: Date.now() - t0, last: s };
      }
    } catch { /* frame still swapping */ }
    await sleep(1000);
  }
  return { ok: false, ms: Date.now() - t0, last, timedOut: true };
}

async function readRole(frame) {
  return frame.evaluate(() => {
    const net = window.__R4NET;
    if (!net) return { ready: false };
    let snap = null;
    try { snap = net.snapshot(); } catch (e) { snap = { snapshotError: e && e.message ? e.message : String(e) }; }
    if (snap && snap.rooms) delete snap.rooms;
    const mp = net.mp || {};
    const r4 = window.__R4 || null;
    return {
      ready: true,
      url: location.href,
      planText: (() => { try { return net.planText(); } catch { return null; } })(),
      menuSel: (() => { try { return net.readMenuSel(); } catch { return null; } })(),
      snapshot: snap,
      mp: {
        role: mp.role,
        code: mp.code,
        roomName: mp.roomName,
        raceId: mp.raceId,
        trackIndex: mp.trackIndex,
        carHost: mp.carHost,
        carGuest: mp.carGuest,
        stage: mp.stage,
        hostStage: mp.hostStage,
        menuVerified: mp.menuVerified,
        raceLive: mp.raceLive,
        inputGated: mp.inputGated,
        blockedGuestInputs: mp.blockedGuestInputs,
        raceStartSignalledAt: mp.raceStartSignalledAt,
        auto: mp.auto,
        autoRaceWaiting: mp.autoRaceWaiting,
        stages: (mp.stages || []).slice(-80),
        controlReceived: (mp.controlReceived || []).slice(-10),
      },
      r4: r4 ? {
        bootMs: r4.bootMs,
        startedAt: r4.startedAt,
        netplay: r4.netplay,
        errors: (r4.errors || []).slice(-5),
      } : null,
      logs: (net.logs || []).slice(-20),
    };
  });
}

async function joinState(hostFrame, guestFrame) {
  const [h, g] = await Promise.all([
    hostFrame.evaluate(() => window.__R4NET.snapshot()).catch(() => null),
    guestFrame.evaluate(() => {
      const net = window.__R4NET;
      const snap = net.snapshot();
      const mp = net.mp || {};
      // Sampled with the join poll so the "before race-live" gate numbers are
      // taken as early as the guest is in a room, not after the macro starts.
      snap.gating = {
        inputGated: !!mp.inputGated,
        raceLive: !!mp.raceLive,
        blockedGuestInputs: Number(mp.blockedGuestInputs) || 0,
        stage: mp.stage,
        at: Date.now(),
      };
      return snap;
    }).catch(() => null),
  ]);
  const safe = (s) => (s || { isNetplay: false, owner: false, playerCount: 0, peers: [], session: null, room: null, maxPlayers: 2 });
  const hh = safe(h);
  const gg = safe(g);
  const dcOpen = (s) => (s.peers || []).some((p) => p && p.dc === 'open');
  const hostOk = !!(hh.isNetplay && hh.owner && hh.playerCount >= 2 && dcOpen(hh));
  const guestOk = !!(gg.isNetplay && !gg.owner && dcOpen(gg));
  // Host -> guest control messages ride socket.io rooms keyed by the socket's
  // own sessionId, so "same room name" is not enough: both sockets must be in
  // the *same* relay session or every `data-message` (stage/race-live) is lost.
  const sameSession = !!(hh.session && gg.session && hh.session === gg.session);
  return { h: hh, g: gg, hostOk, guestOk, sameSession, ok: hostOk && guestOk && sameSession, at: iso(Date.now()) };
}

// Pixel probe on the guest's host-stream <video>. The macro only reports stage
// labels; R4's 2P car/course screens sit inside a flat saturated-yellow status
// frame, while a live race fills the frame with track. Reading the guest stream
// (not a screenshot) keeps the "race really started" claim honest.
async function frameProbe(frame, withMotion = true) {
  return frame.evaluate(async (wantMotion) => {
    // EJS keeps the host stream on the netplay object; the <video> may not be
    // inside #game (the guest path draws it into a canvas), so probe in order.
    const em = window.EJS_emulator;
    const np = em && em.netplay;
    const v = (np && np.video) || document.querySelector('#game video') || document.querySelector('video');
    if (!v || !v.videoWidth) return { ok: false, reason: 'no host video' };
    const w = 160;
    const h = Math.max(1, Math.round((w * v.videoHeight) / v.videoWidth));
    const c = document.createElement('canvas');
    c.width = w;
    c.height = h;
    const ctx = c.getContext('2d', { willReadFrequently: true });
    if (!ctx) return { ok: false, reason: 'no 2d ctx' };
    const grab = () => {
      ctx.drawImage(v, 0, 0, w, h);
      return ctx.getImageData(0, 0, w, h).data;
    };
    let data = grab();
    let prev = null;
    if (wantMotion) {
      prev = data;
      await new Promise((r) => setTimeout(r, 320));
      data = grab();
    }
    let yellow = 0;
    let n = 0;
    let leftMin = 255;
    let leftMax = 0;
    let leftSum = 0;
    let leftN = 0;
    let lumSum = 0;
    let dark = 0;
    let biasSum = 0;
    let topSum = 0;
    let topN = 0;
    let botSum = 0;
    let botN = 0;
    let changed = 0;
    const bandW = Math.max(1, Math.round(w * 0.04));
    for (let y = 0; y < h; y += 1) {
      for (let x = 0; x < w; x += 1) {
        const i = (y * w + x) * 4;
        const r = data[i];
        const g = data[i + 1];
        const b = data[i + 2];
        n += 1;
        if (r > 180 && g > 140 && b < 100) yellow += 1;
        const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
        lumSum += lum;
        biasSum += (Math.abs(r - g) + Math.abs(g - b)) / 2;
        if (lum < 24) dark += 1;
        if (y < h / 2) { topSum += lum; topN += 1; } else { botSum += lum; botN += 1; }
        if (x < bandW) {
          if (lum < leftMin) leftMin = lum;
          if (lum > leftMax) leftMax = lum;
          leftSum += lum;
          leftN += 1;
        }
        if (prev) {
          const pl = 0.2126 * prev[i] + 0.7152 * prev[i + 1] + 0.0722 * prev[i + 2];
          if (Math.abs(lum - pl) > 12) changed += 1;
        }
      }
    }
    const yellowFrac = yellow / Math.max(1, n);
    const spread = leftMax - leftMin;
    const mean = leftSum / Math.max(1, leftN);
    const meanLum = lumSum / Math.max(1, n);
    const darkFrac = dark / Math.max(1, n);
    const nonBlackPct = +((100 * (1 - darkFrac))).toFixed(1);
    const colorBias = biasSum / Math.max(1, n);
    const topMean = topSum / Math.max(1, topN);
    const botMean = botSum / Math.max(1, botN);
    const motionPct = prev ? +((100 * changed) / Math.max(1, n)).toFixed(1) : null;
    return {
      ok: true,
      w: v.videoWidth,
      h: v.videoHeight,
      yellowFrac: +yellowFrac.toFixed(3),
      yellowPct: +((100 * yellowFrac)).toFixed(1),
      leftBandSpread: +spread.toFixed(1),
      leftBandMean: +mean.toFixed(1),
      meanLum: +meanLum.toFixed(1),
      darkFrac: +darkFrac.toFixed(3),
      nonBlackPct,
      colorBias: +colorBias.toFixed(1),
      topMean: +topMean.toFixed(1),
      bottomMean: +botMean.toFixed(1),
      motionPct,
      // 2P menu frame: flat saturated yellow.
      menuLike: yellowFrac > 0.12 || (spread < 10 && mean > 120),
      // Race: not the yellow menu, at least a quarter of the frame non-black and
      // not a frozen frame (a grid/start moment moves little, the card is ~all
      // black and is excluded by nonBlackPct).
      // A start-line/countdown frame is legitimately nearly static, so motion is
      // reported but not required: the yellow menus and the black loading card
      // are already excluded by yellowFrac and nonBlackPct.
      raceLike: yellowFrac < 0.30 && nonBlackPct > 25,
      // "VS BATTLE IN '<course>'" card: ~all black, neutral tint, almost no
      // moving pixels (the night race is only ~68% dark and keeps moving).
      cardLike: yellowFrac < 0.05 && darkFrac >= 0.85 && meanLum >= 3 && meanLum <= 70 && colorBias <= 8,
    };
  }, withMotion).catch((e) => ({ ok: false, reason: String(e && e.message ? e.message : e) }));
}

// Host WebGL canvas readback is black (preserveDrawingBuffer:false), so clip a
// screenshot of the canvas with the compositor, decode it in-page and measure
// the 64x48 result: yellowPct (car/course menus are a solid yellow field) and
// nonBlackPct (the VS Battle loading card is mostly black).
async function hostCanvasSnapshotMetrics(page, frame) {
  const rect = await frame.evaluate(() => {
    const c = document.querySelector('#game canvas');
    if (!c) return null;
    const r = c.getBoundingClientRect();
    return { x: r.x, y: r.y, w: r.width, h: r.height };
  }).catch(() => null);
  if (!rect || rect.w < 2 || rect.h < 2) return { ok: false, reason: 'no host canvas rect' };
  const iframe = await page.evaluate(() => {
    const f = document.querySelector('#rr4sFrame');
    if (!f) return { x: 0, y: 0 };
    const r = f.getBoundingClientRect();
    return { x: r.x, y: r.y };
  });
  const viewport = page.viewport() || { width: 1440, height: 900 };
  const x = Math.max(0, Math.round(iframe.x + rect.x));
  const y = Math.max(0, Math.round(iframe.y + rect.y));
  const width = Math.max(1, Math.min(Math.round(rect.w), viewport.width - x));
  const height = Math.max(1, Math.min(Math.round(rect.h), viewport.height - y));
  try {
    const b64 = await page.screenshot({ clip: { x, y, width, height }, encoding: 'base64' });
    return await page.evaluate(async (dataUrl, clipW, clipH) => {
      const img = new Image();
      img.src = dataUrl;
      try { await img.decode(); } catch { return { ok: false, reason: 'decode failed' }; }
      const c = document.createElement('canvas');
      c.width = 64;
      c.height = 48;
      const ctx = c.getContext('2d', { willReadFrequently: true });
      ctx.drawImage(img, 0, 0, 64, 48);
      const d = ctx.getImageData(0, 0, 64, 48).data;
      let n = 0;
      let yellow = 0;
      let nonBlack = 0;
      let lumSum = 0;
      for (let i = 0; i < d.length; i += 4) {
        const r = d[i];
        const g = d[i + 1];
        const b = d[i + 2];
        n += 1;
        const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
        lumSum += lum;
        if (lum > 24) nonBlack += 1;
        if (r > 180 && g > 140 && b < 100) yellow += 1;
      }
      return {
        ok: true,
        source: 'host #game canvas (clipped page screenshot decoded into 64x48)',
        canvas: { w: clipW, h: clipH },
        yellowPct: +((100 * yellow) / n).toFixed(1),
        nonBlackPct: +((100 * nonBlack) / n).toFixed(1),
        meanLum: +(lumSum / n).toFixed(1),
      };
    }, 'data:image/png;base64,' + b64, Math.round(width), Math.round(height));
  } catch (e) {
    return { ok: false, reason: String(e && e.message ? e.message : e) };
  }
}

// Same 64x48 measurement for the guest, drawn from the host-stream <video>
// (already proven readable), plus the media clock.
async function guestVideoFrameMetrics(frame) {
  return frame.evaluate(() => {
    const em = window.EJS_emulator;
    const np = em && em.netplay;
    const v = (np && np.video) || document.querySelector('#game video') || document.querySelector('video');
    if (!v || !v.videoWidth) return { ok: false, reason: 'no host video' };
    const c = document.createElement('canvas');
    c.width = 64;
    c.height = 48;
    const ctx = c.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(v, 0, 0, 64, 48);
    const d = ctx.getImageData(0, 0, 64, 48).data;
    let n = 0;
    let yellow = 0;
    let nonBlack = 0;
    let lumSum = 0;
    for (let i = 0; i < d.length; i += 4) {
      const r = d[i];
      const g = d[i + 1];
      const b = d[i + 2];
      n += 1;
      const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
      lumSum += lum;
      if (lum > 24) nonBlack += 1;
      if (r > 180 && g > 140 && b < 100) yellow += 1;
    }
    return {
      ok: true,
      source: 'guest host-stream video decoded into 64x48',
      video: { w: v.videoWidth, h: v.videoHeight, readyState: v.readyState, time: +v.currentTime.toFixed(3), paused: v.paused },
      yellowPct: +((100 * yellow) / n).toFixed(1),
      nonBlackPct: +((100 * nonBlack) / n).toFixed(1),
      meanLum: +(lumSum / n).toFixed(1),
    };
  }).catch((e) => ({ ok: false, reason: String(e && e.message ? e.message : e) }));
}

// The auto host/join loops in play-net.js are the primary path. Fall back to
// the same public API only when a browser is not in a room at all, and always
// use the host's exact relay session for the guest: creating a second room (or
// joining a stale duplicate) splits the socket.io rooms and silently drops the
// host's stage/race-live control messages.
async function ensureRoom(hostFrame, guestFrame, timeout = JOIN_TIMEOUT_MS) {
  const t0 = Date.now();
  const GRACE_MS = 20000;
  const RETRY_MS = 8000;
  let last = null;
  let hostCreates = 0;
  let guestJoins = 0;
  let repairLeaves = 0;
  let lastHostCreateAt = 0;
  let lastGuestJoinAt = Date.now();
  let lastRepairAt = 0;
  let guestOutPolls = 0;
  while (Date.now() - t0 < timeout) {
    last = await joinState(hostFrame, guestFrame);
    guestOutPolls = last.g && last.g.isNetplay ? 0 : guestOutPolls + 1;
    if (last.g && last.g.isNetplay && !state.gating.before) {
      // First sample where the guest is actually in the room: this is the
      // "before race-live" gate baseline.
      state.gating.before = { ...last.g.gating, session: last.g.session, sample: 'first-join-poll' };
      log(`gating sample at join: ${JSON.stringify(state.gating.before)}`);
    }
    if (last.ok) {
      return {
        ...last,
        method: hostCreates + guestJoins + repairLeaves ? 'auto+harness-fallback' : 'auto',
        ms: Date.now() - t0, hostCreates, guestJoins, repairLeaves,
      };
    }
    const now = Date.now();
    const inGrace = now - t0 < GRACE_MS;

    // Guest is in a room, but a different one than the host: leave and rejoin
    // the host's exact session.
    if (last.h.session && last.g.isNetplay && !last.sameSession && now - lastRepairAt > 5000) {
      lastRepairAt = now;
      repairLeaves += 1;
      log(`join repair: guest session ${last.g.session} != host session ${last.h.session}; leaving`);
      await guestFrame.evaluate(() => {
        try { window.__R4NET.leaveRoom(); } catch { /* ignore */ }
      }).catch(() => {});
      await sleep(900);
      continue;
    }

    // Host is not in a room at all (the in-page auto host gave up).
    if (!last.h.isNetplay && !inGrace && now - lastHostCreateAt > RETRY_MS) {
      lastHostCreateAt = now;
      hostCreates += 1;
      log(`join fallback: host creates room (attempt ${hostCreates})`);
      await hostFrame.evaluate(() => {
        const net = window.__R4NET;
        if (!net || !net.mp) return;
        net.setName('HOST-A');
        net.hostRoom(net.mp.roomName, 2, net.mp.raceId || '');
      }).catch(() => {});
    }

    // Guest is not in a room at all: join the host's exact session. Require a
    // sustained absence so a harness join never races the page's own joinRoom
    // (a double join can make EJS throw while wiring the guest canvas).
    if (last.h.session && !last.g.isNetplay && guestOutPolls >= 3 && now - lastGuestJoinAt > RETRY_MS) {
      lastGuestJoinAt = now;
      guestJoins += 1;
      const sid = last.h.session;
      const roomName = last.h.room || '';
      const max = last.h.maxPlayers || 2;
      log(`join fallback: guest joins host session ${sid}`);
      await guestFrame.evaluate((sessionId, room, maxPlayers) => {
        const net = window.__R4NET;
        if (!net || !net.mp) return;
        net.setName('GUEST-B');
        net.joinRoom(sessionId, room || net.mp.roomName, maxPlayers, net.mp.raceId || null);
      }, sid, roomName, max).catch(() => {});
    }
    await sleep(700);
  }
  return {
    ...(last || {}),
    ok: false,
    timedOut: true,
    ms: Date.now() - t0,
    method: 'auto+harness-fallback',
    hostCreates, guestJoins, repairLeaves,
  };
}

// ---------------------------------------------------------------- main run --
const startedAt = Date.now();
const state = {
  code: CODE,
  contexts: {
    host: { label: 'HOST-A', name: 'HOST-A', roomCode: '', p1: '', p2: '', p1Ready: '', p2Ready: '', readyPressed: false, raceOverlayVisible: false, count: '', track: '', cars: '', roomTrack: '', roomCars: '', shellFrameSrc: '', mpParams: {}, consoleLines: [], consoleErrors: [], consoleIgnored: [], pageErrors: [], requestFailed: [] },
    guest: { label: 'GUEST-B', name: 'GUEST-B', roomCode: '', p1: '', p2: '', p1Ready: '', p2Ready: '', readyPressed: false, raceOverlayVisible: false, count: '', track: '', cars: '', roomTrack: '', roomCars: '', shellFrameSrc: '', mpParams: {}, consoleLines: [], consoleErrors: [], consoleIgnored: [], pageErrors: [], requestFailed: [] },
  },
  entered: { host: false, guest: false },
  welcomeSrc: { host: '', guest: '' },
  lobbySrc: { host: '', guest: '' },
  phases: {},
  boot: { host: null, guest: null },
  snapshots: { host: { before: null, after: null, final: null }, guest: { before: null, after: null, final: null } },
  join: null,
  plan: {
    host: null, guest: null,
    hostPlanText: '', guestPlanText: '',
    lobbyTrack: '', lobbyCars: '',
  },
  macro: {
    reachedLive: false,
    finalStage: null,
    stagePoll: [],
    fallbackUsed: false,
    elapsedMs: null,
    error: null,
    hostLogsTail: [],
  },
  raceVisibleAfterRaceLiveMs: null,
  courseShot: { file: null, atStage: null, at: null },
  loadingShot: null,
  carPanels: { p1: null, p2: null },
  frames: { course: null, race: null },
  raceFrames: null,
  screenshots: {},
  guestVideo: { first: null, second: null, advanceSec: null, dom: [] },
  gating: { before: null, after: null },
  input: { installed: null, guestCallReturn: null, guestCalledAt: null, hostRecords: [], matched: null, player0Records: 0 },
  fatal: null,
};

let browser = null;
let hostPage = null;
let guestPage = null;
let hostRec = null;
let guestRec = null;
let hostLobby = null;
let guestLobby = null;
let hostFrame = null;
let guestFrame = null;

const shot = async (page, file, label) => {
  try {
    await page.screenshot({ path: file });
    state.screenshots[label] = file;
    return file;
  } catch (e) {
    log(`SHOT FAIL ${label}: ${e && e.message ? e.message : e}`);
    return null;
  }
};

try {
  browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: true,
    userDataDir: PROFILE,
    protocolTimeout: 300000,
    defaultViewport: { width: 1440, height: 900 },
    args: [
      '--no-sandbox',
      '--mute-audio',
      '--autoplay-policy=no-user-gesture-required',
      '--enable-unsafe-swiftshader',
      '--use-angle=swiftshader',
      '--disable-background-timer-throttling',
      '--disable-backgrounding-occluded-windows',
      '--disable-renderer-backgrounding',
      '--window-size=1440,900',
      '--force-device-scale-factor=1',
    ],
  });

  const hostCtx = await browser.createBrowserContext();
  const guestCtx = await browser.createBrowserContext();

  hostPage = await hostCtx.newPage();
  guestPage = await guestCtx.newPage();
  await hostPage.setViewport({ width: 1440, height: 900 });
  await guestPage.setViewport({ width: 1440, height: 900 });
  // The app serves its static assets with max-age=1h; without this a warm
  // profile can run a stale play-net.js and invalidate the whole run.
  await hostPage.setCacheEnabled(false);
  await guestPage.setCacheEnabled(false);
  hostRec = attach(hostPage, 'host');
  guestRec = attach(guestPage, 'guest');
  state.phases.launch = iso(Date.now());

  state.phases.enterStart = iso(Date.now());
  await step('both cabinets enter (ENTER gate -> /welcome)', async () => {
    const [h, g] = await Promise.all([enterCabinet(hostPage), enterCabinet(guestPage)]);
    state.entered.host = h.entered;
    state.entered.guest = g.entered;
    state.welcomeSrc.host = h.welcomeSrc;
    state.welcomeSrc.guest = g.welcomeSrc;
  });
  state.phases.enterEnd = iso(Date.now());

  await step('both shells open 2P LOUNGE (/multiplayer)', async () => {
    const [h, g] = await Promise.all([openLobby(hostPage), openLobby(guestPage)]);
    hostLobby = h.frame;
    guestLobby = g.frame;
    state.lobbySrc.host = h.src;
    state.lobbySrc.guest = g.src;
  });

  await step('host creates room ' + CODE, async () => {
    await fillAndSubmit(hostLobby, 'HOST-A', CODE, 'create');
    await hostLobby.waitForFunction(
      (c) => (document.querySelector('#mRoomCode')?.textContent || '').trim() === c,
      { timeout: STEP_TIMEOUT_MS, polling: 100 },
      CODE,
    );
  });

  await step('guest joins room ' + CODE, async () => {
    await fillAndSubmit(guestLobby, 'GUEST-B', CODE, 'join');
    await guestLobby.waitForFunction(
      (c) => (document.querySelector('#mRoomCode')?.textContent || '').trim() === c,
      { timeout: STEP_TIMEOUT_MS, polling: 100 },
      CODE,
    );
  });

  await step('both lounge frames show the same room and both drivers', async () => {
    const check = async (frame) => {
      await frame.waitForFunction(
        (c, a, b) => {
          const t = (s) => (document.querySelector(s)?.textContent || '').trim();
          return t('#mRoomCode') === c && t('#mP1Name') === a && t('#mP2Name') === b;
        },
        { timeout: STEP_TIMEOUT_MS, polling: 100 },
        CODE, 'HOST-A', 'GUEST-B',
      );
    };
    await Promise.all([check(hostLobby), check(guestLobby)]);
  });

  await step('both drivers press READY', async () => {
    await hostLobby.click('#mReady');
    await sleep(120);
    await guestLobby.click('#mReady');
    await Promise.all([
      hostLobby.waitForFunction(() => document.querySelector('#mReady')?.getAttribute('aria-pressed') === 'true', { timeout: STEP_TIMEOUT_MS, polling: 100 }),
      guestLobby.waitForFunction(() => document.querySelector('#mReady')?.getAttribute('aria-pressed') === 'true', { timeout: STEP_TIMEOUT_MS, polling: 100 }),
    ]);
  });

  await step('3-2-1 overlay reaches GO in both browsers + GO screenshots', async () => {
    const go = (frame) => frame.waitForFunction(() => {
      const el = document.querySelector('#mRace');
      const c = (document.querySelector('#mCount')?.textContent || '').trim();
      return !!el && !el.hidden && c === 'GO';
    }, { timeout: STEP_TIMEOUT_MS, polling: 100 });
    await Promise.all([go(hostLobby), go(guestLobby)]);
    state.phases.goOverlay = iso(Date.now());
    const [hs, gs] = await Promise.all([snapshotLobby(hostLobby), snapshotLobby(guestLobby)]);
    Object.assign(state.contexts.host, hs);
    Object.assign(state.contexts.guest, gs);
    state.plan.lobbyTrack = hs.track;
    state.plan.lobbyCars = hs.cars;
    await Promise.all([
      shot(hostPage, `${OUT}/mp-race-e2e-host-go.png`, 'hostGo'),
      shot(guestPage, `${OUT}/mp-race-e2e-guest-go.png`, 'guestGo'),
    ]);
  });

  await step('both shells hand off to the real /play-net?... document', async () => {
    const wait = (page) => page.waitForFunction(
      () => /\/play-net(\?|$)/.test(String(document.querySelector('#rr4sFrame')?.src || '')),
      { timeout: NAV_TIMEOUT_MS, polling: 100 },
    );
    await Promise.all([wait(hostPage), wait(guestPage)]);
    const [hSrc, gSrc] = await Promise.all([shellFrameSrc(hostPage), shellFrameSrc(guestPage)]);
    state.contexts.host.shellFrameSrc = hSrc;
    state.contexts.guest.shellFrameSrc = gSrc;
    state.contexts.host.mpParams = parseMpParams(hSrc);
    state.contexts.guest.mpParams = parseMpParams(gSrc);
    state.phases.handoff = iso(Date.now());
  });

  await step('both iframes load /play-net (no request interception)', async () => {
    const [h, g] = await Promise.all([waitPlayNetFrame(hostPage), waitPlayNetFrame(guestPage)]);
    hostFrame = h;
    guestFrame = g;
    state.contexts.host.playNetUrl = h.url();
    state.contexts.guest.playNetUrl = g.url();
  });

  state.phases.bootStart = iso(Date.now());
  await step('both R4 cores boot in the /play-net iframe', async () => {
    const [h, g] = await Promise.all([
      waitCoreStarted(hostFrame, 'host'),
      waitCoreStarted(guestFrame, 'guest'),
    ]);
    state.boot.host = h;
    state.boot.guest = g;
    state.phases.bootEnd = iso(Date.now());
    if (!h.ok) throw new Error(`host core did not start (${h.ms} ms) ${JSON.stringify(h.last)}`);
    if (!g.ok) throw new Error(`guest core did not start (${g.ms} ms) ${JSON.stringify(g.last)}`);
  });
  // The host tab drives the macro; keep it in front.
  await hostPage.bringToFront();

  await step('both mp plans are readable after boot', async () => {
    const [h, g] = await Promise.all([readRole(hostFrame), readRole(guestFrame)]);
    state.snapshots.host.before = h;
    state.snapshots.guest.before = g;
    state.plan.host = h.mp;
    state.plan.guest = g.mp;
    state.plan.hostPlanText = h.planText || '';
    state.plan.guestPlanText = g.planText || '';
    log(`plan host: "${state.plan.hostPlanText}"  guest: "${state.plan.guestPlanText}"`);
  });

  await step('guest joins the host relay room (2 players, open data channel)', async () => {
    const j = await ensureRoom(hostFrame, guestFrame, JOIN_TIMEOUT_MS);
    state.join = { ...j, at: iso(Date.now()) };
    log(`join: host owner=${j.h && j.h.owner} players=${j.h && j.h.playerCount} session=${j.h && j.h.session} dc=${JSON.stringify(j.h && j.h.peers)}`);
    log(`join: guest isNetplay=${j.g && j.g.isNetplay} owner=${j.g && j.g.owner} session=${j.g && j.g.session} dc=${JSON.stringify(j.g && j.g.peers)} method=${j.method}`);
    if (!j.ok) throw new Error(`guest did not join the relay room: ${JSON.stringify({ sameSession: j.sameSession, h: j.h && { isNetplay: j.h.isNetplay, owner: j.h.owner, playerCount: j.h.playerCount, session: j.h.session, peers: j.h.peers }, g: j.g && { isNetplay: j.g.isNetplay, owner: j.g.owner, session: j.g.session, peers: j.g.peers } })}`);
    state.phases.joined = iso(Date.now());
  });

  await step('guest gating baseline before race-live', async () => {
    // installGuestGate() runs on the guest's 500 ms netplay status interval
    // right after the join, so wait for it rather than racing it.
    const firstSample = state.gating.before;
    await guestFrame.waitForFunction(
      () => !!(window.__R4NET && window.__R4NET.mp && window.__R4NET.mp.inputGated),
      { timeout: 15000, polling: 200 },
    ).catch(() => {});
    const g = await readRole(guestFrame);
    state.gating.before = {
      inputGated: g.mp.inputGated,
      raceLive: g.mp.raceLive,
      blockedGuestInputs: g.mp.blockedGuestInputs,
      blockedAtFirstJoinSample: firstSample ? firstSample.blockedGuestInputs : null,
      raceLiveAtFirstJoinSample: firstSample ? firstSample.raceLive : null,
      stage: g.mp.stage,
      at: iso(Date.now()),
    };
    // "before" snapshot is refreshed here: it is the state both browsers are in
    // just before the host macro walks the menus.
    state.snapshots.guest.before = g;
    log(`gating before: inputGated=${g.mp.inputGated} raceLive=${g.mp.raceLive} blocked=${g.mp.blockedGuestInputs} (first join sample ${JSON.stringify(firstSample && { blocked: firstSample.blockedGuestInputs, raceLive: firstSample.raceLive })})`);
  });

  state.phases.macroStart = iso(Date.now());
  await step('host macro reaches race:live (course + car-panel + loading screenshots)', async () => {
    const t0 = Date.now();
    let lastStage = '';
    let gotCourseShot = false;
    let raceStartingAt = 0;
    const deadline = t0 + MACRO_TIMEOUT_MS;
    const carPanelProbe = async () => guestFrame.evaluate(() => {
      // The preset panel is drawn by the R4 core, so the only DOM text is the
      // EmulatorJS chrome. Record that fact instead of inventing a text source.
      const game = document.querySelector('#game');
      const txt = game ? String(game.innerText || '') : '';
      const nodes = [...document.querySelectorAll('#game *')]
        .filter((e) => /PRESET|Car data|Maker name/i.test(String(e.textContent || '')))
        .slice(0, 3)
        .map((e) => `${e.tagName}.${e.className || ''}:"${String(e.textContent || '').trim().slice(0, 60)}"`);
      return {
        gameTextSample: txt.trim().slice(0, 200),
        matchingNodes: nodes,
        panelTextInDom: nodes.length > 0,
        canvasOnly: nodes.length === 0,
        at: new Date().toISOString(),
      };
    }).catch((e) => ({ panelTextInDom: false, canvasOnly: true, error: String(e && e.message ? e.message : e) }));

    while (Date.now() < deadline) {
      let s;
      try {
        s = await hostFrame.evaluate(() => {
          const net = window.__R4NET;
          if (!net) return null;
          const mp = net.mp || {};
          return {
            stage: mp.stage,
            raceLive: mp.raceLive,
            menuVerified: mp.menuVerified,
            error: (mp.auto && mp.auto.error) || null,
            waiting: !!mp.autoRaceWaiting,
            logs: (net.logs || []).slice(-12),
          };
        });
      } catch (e) {
        // The host tab is busy; keep polling.
        await sleep(400);
        continue;
      }
      if (!s) { await sleep(400); continue; }
      if (s.stage !== lastStage) {
        lastStage = s.stage;
        state.macro.stagePoll.push({ stage: s.stage, at: iso(Date.now()), elapsedMs: Date.now() - t0 });
        log(`host stage ${String(state.macro.stagePoll.length).padStart(2, '0')}: ${s.stage}`);
      }
      if (!state.carPanels.p1 && s.stage === 'car:p1:data') {
        const file = await shot(guestPage, `${OUT}/mp-race-e2e-guest-car-p1.png`, 'guestCarP1');
        state.carPanels.p1 = { file, stage: s.stage, at: iso(Date.now()), dom: await carPanelProbe() };
        log(`guest car-p1 panel shot at ${s.stage}: ${file}`);
      }
      if (!state.carPanels.p2 && s.stage === 'car:p2:data') {
        const file = await shot(guestPage, `${OUT}/mp-race-e2e-guest-car-p2.png`, 'guestCarP2');
        state.carPanels.p2 = { file, stage: s.stage, at: iso(Date.now()), dom: await carPanelProbe() };
        log(`guest car-p2 panel shot at ${s.stage}: ${file}`);
      }
      if (!gotCourseShot && s.stage === 'course:locked') {
        gotCourseShot = true;
        const file = await shot(hostPage, `${OUT}/mp-race-e2e-host-course.png`, 'hostCourse');
        state.courseShot = { file, atStage: s.stage, at: iso(Date.now()) };
        state.frames.course = await frameProbe(guestFrame);
      } else if (!gotCourseShot && s.stage === 'race:starting') {
        // Missed the 1.5 s lock window; the course screen is still up for the
        // Start press, so keep the evidence rather than losing the shot.
        gotCourseShot = true;
        const file = await shot(hostPage, `${OUT}/mp-race-e2e-host-course.png`, 'hostCourse');
        state.courseShot = { file, atStage: s.stage, at: iso(Date.now()) };
        state.frames.course = await frameProbe(guestFrame);
      }
      if (s.stage === 'race:starting' && !raceStartingAt) {
        raceStartingAt = Date.now();
      }
      // Hunt the "VS BATTLE IN '<course>'" card for the whole load: it is ~all
      // black with neutral text, unlike the red course-select fade and unlike a
      // night race (which is only ~68% dark and keeps moving).
      if (raceStartingAt && !(state.loadingShot && state.loadingShot.cardCaptured)) {
        const elapsed = Date.now() - raceStartingAt;
        const p = await frameProbe(guestFrame, false);
        if (p.ok && p.cardLike) {
          const file = await shot(hostPage, `${OUT}/mp-race-e2e-host-loading.png`, 'hostLoading');
          state.screenshots.hostLoading = file;
          state.loadingShot = {
            file,
            phase: `${s.stage}+${elapsed}ms`,
            afterRaceStartingMs: elapsed,
            cardCaptured: true,
            probe: p,
            at: iso(Date.now()),
          };
          log(`host loading card captured: phase=${state.loadingShot.phase} probe=${JSON.stringify(p)}`);
        } else if (elapsed >= 4000 && !(state.loadingShot && state.loadingShot.file)) {
          const file = await shot(hostPage, `${OUT}/mp-race-e2e-host-loading.png`, 'hostLoading');
          state.screenshots.hostLoading = file;
          state.loadingShot = {
            file,
            phase: `fallback race:starting+${elapsed}ms`,
            afterRaceStartingMs: elapsed,
            fallback: true,
            cardCaptured: false,
            probe: p,
            at: iso(Date.now()),
          };
          log(`host loading fallback shot at +${elapsed} ms: probe=${JSON.stringify(p)}`);
        }
      }
      state.macro.finalStage = s.stage;
      state.macro.hostLogsTail = s.logs;
      if (s.stage === 'race:live') {
        state.macro.reachedLive = true;
        state.macro.elapsedMs = Date.now() - t0;
        state.macro.raceLiveAt = Date.now();
        break;
      }
      if (s.stage === 'macro:error') {
        state.macro.error = s.error || 'macro:error';
        break;
      }
      // If the auto-lobby ended in a failed stage, retry the macro once.
      if (!state.macro.fallbackUsed && (s.stage === 'room:join-failed' || s.stage === 'room:host-failed')) {
        state.macro.fallbackUsed = true;
        await hostFrame.evaluate(() => window.__R4NET.mpRun()).catch(() => {});
      }
      await sleep(350);
    }
    state.phases.macroEnd = iso(Date.now());
    if (!state.macro.reachedLive) {
      throw new Error(`host macro did not reach race:live (last stage ${state.macro.finalStage}); host logs: ${JSON.stringify(state.macro.hostLogsTail)}`);
    }
  });

  await step('race:live + 6 s probe, race:live + 18 s race frames on both sides', async () => {
    const liveAt = state.macro.raceLiveAt || Date.now();
    const raceFrameAt = liveAt + RACE_FRAME_DELAY_MS;
    let gotSix = false;
    // Until race:live + 18 s: second chance for the "VS BATTLE IN '<course>'"
    // card (it often appears after race:live while the track keeps loading),
    // and the honest race:live + 6 s pair.
    while (Date.now() < raceFrameAt) {
      const p = await frameProbe(guestFrame, false);
      if (p.ok && p.cardLike && !(state.loadingShot && state.loadingShot.cardCaptured)) {
        const file = await shot(hostPage, `${OUT}/mp-race-e2e-host-loading.png`, 'hostLoading');
        state.loadingShot = {
          ...(state.loadingShot || {}),
          file,
          phase: `race:live+${Date.now() - liveAt}ms`,
          afterRaceLiveMs: Date.now() - liveAt,
          cardCaptured: true,
          probe: p,
          at: iso(Date.now()),
        };
        state.screenshots.hostLoading = file;
        log(`host loading card (post race:live): phase=${state.loadingShot.phase} probe=${JSON.stringify(p)}`);
      }
      if (!gotSix && Date.now() - liveAt >= RACE_SHOT_DELAY_MS) {
        gotSix = true;
        await hostPage.bringToFront();
        await shot(hostPage, `${OUT}/mp-race-e2e-host-live6s.png`, 'hostLive6s');
        await guestPage.bringToFront();
        await sleep(500);
        await shot(guestPage, `${OUT}/mp-race-e2e-guest-live6s.png`, 'guestLive6s');
        state.frames.live6s = await frameProbe(guestFrame);
        log(`race probe at race:live + 6 s: ${JSON.stringify(state.frames.live6s)}`);
        await hostPage.bringToFront();
      }
      await sleep(400);
    }

    // race:live + 18 s: the race should be well underway on both sides.
    await hostPage.bringToFront();
    await shot(hostPage, `${OUT}/mp-race-e2e-host-race.png`, 'hostRaceFrame');
    const hostMetrics = await hostCanvasSnapshotMetrics(hostPage, hostFrame);
    await guestPage.bringToFront();
    await sleep(400);
    await shot(guestPage, `${OUT}/mp-race-e2e-guest-race.png`, 'guestRaceFrame');
    const guestMetrics = await guestVideoFrameMetrics(guestFrame);
    const guestT1 = await guestFrame.evaluate(() => {
      const em = window.EJS_emulator;
      const v = em && em.netplay && em.netplay.video;
      return v ? v.currentTime : null;
    });
    await sleep(2000);
    const guestT2 = await guestFrame.evaluate(() => {
      const em = window.EJS_emulator;
      const v = em && em.netplay && em.netplay.video;
      return v ? v.currentTime : null;
    });
    state.raceFrames = {
      at: iso(Date.now()),
      afterRaceLiveMs: Date.now() - liveAt,
      host: hostMetrics,
      guest: guestMetrics,
      guestAdvanceSec: guestT1 != null && guestT2 != null ? +(guestT2 - guestT1).toFixed(3) : null,
      thresholds: { yellowPctBelow: 30, nonBlackPctAbove: 25 },
    };
    log(`race frames: host ${JSON.stringify(hostMetrics)}`);
    log(`race frames: guest ${JSON.stringify(guestMetrics)} advance=${state.raceFrames.guestAdvanceSec}s`);

    // Then confirm the stream is an opaque race frame and capture the
    // long-standing -host/-guest pair.
    await hostPage.bringToFront();
    const t0 = Date.now();
    let probe = state.frames.live6s || { ok: false };
    while (Date.now() - t0 < RACE_VISIBLE_TIMEOUT_MS) {
      probe = await frameProbe(guestFrame);
      if (probe.ok && probe.raceLike) break;
      await sleep(1200);
    }
    state.frames.race = probe;
    state.raceVisibleAfterRaceLiveMs = Date.now() - liveAt;
    log(`race frame probe: ${JSON.stringify(probe)} after +${state.raceVisibleAfterRaceLiveMs} ms from race:live (course probe ${JSON.stringify(state.frames.course)})`);

    await hostPage.bringToFront();
    await shot(hostPage, `${OUT}/mp-race-e2e-host.png`, 'hostRace');
    // The guest proof is next, so give the guest tab the foreground.
    await guestPage.bringToFront();
    await sleep(600);
    await shot(guestPage, `${OUT}/mp-race-e2e-guest.png`, 'guestRace');
    state.frames.raceConfirmed = await frameProbe(guestFrame);
    log(`race frame probe after shots: ${JSON.stringify(state.frames.raceConfirmed)}`);
    state.phases.raceShots = iso(Date.now());
  });

  await step('guest receives the host stream and it is advancing', async () => {
    const probe = () => guestFrame.evaluate(() => {
      const net = window.__R4NET;
      const s = net.snapshot();
      const em = window.EJS_emulator;
      const npv = em && em.netplay && em.netplay.video;
      const dom = [...document.querySelectorAll('#game video')].map((v) => ({
        w: v.videoWidth, h: v.videoHeight, readyState: v.readyState,
        time: v.currentTime, paused: v.paused, muted: v.muted,
      }));
      return {
        video: s.video,
        netplayVideo: npv ? {
          w: npv.videoWidth, h: npv.videoHeight, readyState: npv.readyState,
          time: npv.currentTime, paused: npv.paused, muted: npv.muted,
        } : null,
        dom, isNetplay: s.isNetplay, owner: s.owner, playerCount: s.playerCount, peers: s.peers,
      };
    });
    const first = await probe();
    await sleep(2000);
    const second = await probe();
    state.guestVideo.first = first;
    state.guestVideo.second = second;
    state.guestVideo.dom = second.dom;
    if (first.video && second.video) {
      state.guestVideo.advanceSec = +(second.video.time - first.video.time).toFixed(3);
    }
    log(`guest video: ${JSON.stringify(first.video)} -> ${JSON.stringify(second.video)} advance=${state.guestVideo.advanceSec}s`);
    state.phases.guestStream = iso(Date.now());
  });

  await step('guest gating after race-live', async () => {
    // The guest learns about race-live over the control channel; give it a moment.
    const deadline = Date.now() + 20000;
    let last = null;
    while (Date.now() < deadline) {
      const g = await readRole(guestFrame);
      last = g;
      if (g.mp.raceLive) break;
      await sleep(500);
    }
    state.gating.after = {
      inputGated: last.mp.inputGated,
      raceLive: last.mp.raceLive,
      blockedGuestInputs: last.mp.blockedGuestInputs,
      hostStage: last.mp.hostStage,
      at: iso(Date.now()),
    };
    // The collapsed netplay chip is the only status the guest sees during the
    // load; it must name the seat and the P2 lock state.
    state.gating.chip = await guestFrame.evaluate(() => {
      const chip = document.getElementById('npChip');
      const text = document.getElementById('npChipText');
      return { text: text ? text.textContent : null, hidden: chip ? chip.hidden : null };
    });
    log(`gating after: inputGated=${last.mp.inputGated} raceLive=${last.mp.raceLive} blocked=${last.mp.blockedGuestInputs} hostStage=${last.mp.hostStage} chip=${JSON.stringify(state.gating.chip)}`);
  });

  await step('guest input reaches the host core as PLAYER 2', async () => {
    const installed = await hostFrame.evaluate(() => {
      const em = window.EJS_emulator;
      const gm = em && em.gameManager;
      if (!gm || !gm.functions || typeof gm.functions.simulateInput !== 'function') {
        return { ok: false, reason: 'gameManager.functions.simulateInput missing' };
      }
      if (!window.__E2E_INPUT) {
        const orig = gm.functions.simulateInput.bind(gm.functions);
        window.__E2E_INPUT = [];
        gm.functions.simulateInput = (player, index, value) => {
          try {
            window.__E2E_INPUT.push({ player, index, value, at: Date.now() });
            if (window.__E2E_INPUT.length > 600) window.__E2E_INPUT.shift();
          } catch { /* ignore */ }
          return orig(player, index, value);
        };
        return { ok: true, installed: true };
      }
      return { ok: true, installed: false };
    });
    state.input.installed = installed;
    if (!installed.ok) throw new Error('cannot instrument the host core: ' + installed.reason);

    await guestPage.bringToFront();
    await shot(guestPage, `${OUT}/mp-race-e2e-guest-before.png`, 'guestBeforeInput');
    const calledAt = Date.now();
    const ret = await guestFrame.evaluate(() => window.__R4NET.simulateInput(0, 0, 1));
    state.input.guestCallReturn = ret;
    state.input.guestCalledAt = iso(calledAt);
    log(`guest simulateInput(0,0,1) returned ${ret}`);

    const deadline = Date.now() + INPUT_WAIT_MS;
    let records = [];
    let matched = null;
    while (Date.now() < deadline) {
      records = await hostFrame.evaluate(() => window.__E2E_INPUT || []).catch(() => []);
      matched = records.find((r) => r.player === 1 && r.index === 0 && r.value === 1 && r.at >= calledAt) || null;
      if (matched) break;
      await sleep(300);
    }
    await sleep(1200);
    await shot(guestPage, `${OUT}/mp-race-e2e-guest-after.png`, 'guestAfterInput');
    // Release the button so the guest is not holding a direction.
    await guestFrame.evaluate(() => window.__R4NET.simulateInput(0, 0, 0)).catch(() => {});
    await sleep(400);
    const after = await hostFrame.evaluate(() => (window.__E2E_INPUT || []).slice(-40)).catch(() => []);
    state.input.hostRecords = after;
    state.input.matched = matched;
    state.input.player0Records = after.filter((r) => r.player === 0).length;
    const guestSide = await readRole(guestFrame);
    state.snapshots.guest.after = guestSide;
    log(`host records after guest input: ${JSON.stringify(after.slice(-8))}`);
    log(`matched PLAYER 2 record: ${JSON.stringify(matched)}`);
  });

  // Final reads for the evidence file.
  const [hFinal, gFinal] = await Promise.all([readRole(hostFrame), readRole(guestFrame)]);
  state.snapshots.host.after = hFinal;
  state.snapshots.host.final = hFinal;
  state.snapshots.guest.final = gFinal;
  state.plan.host = hFinal.mp;
  state.plan.guest = gFinal.mp;
} catch (err) {
  state.fatal = { message: err && err.message ? err.message : String(err), at: iso(Date.now()) };
  log(`FATAL ${state.fatal.message}`);
  for (const [key, frame] of [['host', hostFrame], ['guest', guestFrame]]) {
    if (!frame) continue;
    try {
      const r = await readRole(frame);
      state.snapshots[key].final = r;
      state.plan[key] = r.mp;
      state.macro.hostLogsTail = (r.logs || []).slice(-12);
    } catch { /* ignore */ }
  }
  for (const [key, page] of [['host', hostPage], ['guest', guestPage]]) {
    if (!page) continue;
    try {
      const src = await shellFrameSrc(page);
      state.contexts[key].shellFrameSrc = src;
      state.contexts[key].mpParams = parseMpParams(src);
    } catch { /* ignore */ }
  }
  try { await hostPage?.screenshot({ path: `${OUT}/mp-race-e2e-host-fatal.png` }); } catch { /* ignore */ }
  try { await guestPage?.screenshot({ path: `${OUT}/mp-race-e2e-guest-fatal.png` }); } catch { /* ignore */ }
} finally {
  state.finishedAt = iso(Date.now());
  state.durationMs = Date.now() - startedAt;
  for (const [key, rec] of [['host', hostRec], ['guest', guestRec]]) {
    if (!rec) continue;
    state.contexts[key].consoleErrors = rec.consoleErrors;
    state.contexts[key].consoleIgnored = rec.consoleIgnored;
    state.contexts[key].pageErrors = rec.pageErrors;
    state.contexts[key].requestFailed = rec.requestFailed.filter((r) => !/\/play-net(\?|$)/.test(r.url));
    state.contexts[key].consoleLines = rec.consoleLines.slice(-200);
  }
  try { await hostPage?.close(); } catch { /* ignore */ }
  try { await guestPage?.close(); } catch { /* ignore */ }
  try { await browser?.close(); } catch { /* ignore */ }
}

// -------------------------------------------------------------- assertions --
const A = [];
function check(id, name, pass, detail) {
  const entry = { id, name, pass: !!pass, detail: detail === undefined ? '' : String(detail) };
  A.push(entry);
  log(`${pass ? 'PASS' : 'FAIL'} ${id}: ${name}${entry.detail ? ' - ' + entry.detail : ''}`);
}

const H = state.contexts.host;
const G = state.contexts.guest;
const HP = H.mpParams || {};
const GP = G.mpParams || {};
const hb = state.snapshots.host.before || { mp: {}, snapshot: {} };
const gb = state.snapshots.guest.before || { mp: {}, snapshot: {} };
const ha = state.snapshots.host.after || hb;
const ga = state.snapshots.guest.after || gb;
const planH = state.plan.hostPlanText;
const planG = state.plan.guestPlanText;
const planSame = !!planH && planH === planG;
const CAR_CODES = ['D1', 'D2', 'D3', 'D4', 'G1', 'G2', 'G3', 'G4'];
const TRACK_NAMES = [
  'Helter Skelter', 'Wonderhill', 'Edge of the Earth', 'Out of Blue',
  'Phantomile', 'Brightest Nite', 'Heaven and Hell', 'Shooting Hoops',
];
const planTrack = TRACK_NAMES[Number(ha.mp.trackIndex)] || '';
const planCarHost = CAR_CODES[Number(ha.mp.carHost)] || '';
const planCarGuest = CAR_CODES[Number(ha.mp.carGuest)] || '';
const planMatchesLobby = !!planH
  && !!state.plan.lobbyTrack && planH.includes(state.plan.lobbyTrack)
  && !!planCarHost && planH.includes(planCarHost)
  && !!planCarGuest && planH.includes(planCarGuest)
  && state.plan.lobbyCars.includes(planCarHost)
  && state.plan.lobbyCars.includes(planCarGuest);

check('E01', 'HOST-A enters the cabinet and the shell loads /welcome', state.entered.host && /\/welcome/.test(state.welcomeSrc.host), `frame=${state.welcomeSrc.host}`);
check('E02', 'GUEST-B enters the cabinet and the shell loads /welcome', state.entered.guest && /\/welcome/.test(state.welcomeSrc.guest), `frame=${state.welcomeSrc.guest}`);
check('E03', 'HOST-A shell 2P button loads /multiplayer', /\/multiplayer/.test(state.lobbySrc.host), `frame=${state.lobbySrc.host}`);
check('E04', 'GUEST-B shell 2P button loads /multiplayer', /\/multiplayer/.test(state.lobbySrc.guest), `frame=${state.lobbySrc.guest}`);
check('E05', 'HOST-A created room ' + CODE, H.roomCode === CODE, `room=${H.roomCode || '(none)'} expected=${CODE}`);
check('E06', 'GUEST-B joined the same room code', G.roomCode === CODE && H.roomCode === G.roomCode, `host=${H.roomCode || '(none)'} guest=${G.roomCode || '(none)'}`);
check('E07', 'both drivers are READY (P1 HOST-A, P2 GUEST-B)', H.p1 === 'HOST-A' && H.p2 === 'GUEST-B' && G.p1 === 'HOST-A' && G.p2 === 'GUEST-B' && H.readyPressed && G.readyPressed, `host=${H.p1Ready}/${H.p2Ready} guest=${G.p1Ready}/${G.p2Ready}`);
check('E08', 'the lounge countdown reaches GO in both browsers', H.count === 'GO' && G.count === 'GO', `host=${H.count} guest=${G.count}`);
check('E09', 'HOST-A shell frame is a real /play-net?mpRole=host URL', HP.mpRole === 'host' && /\/play-net(\?|$)/.test(H.shellFrameSrc), H.shellFrameSrc);
check('E10', 'GUEST-B shell frame is a real /play-net?mpRole=guest URL', GP.mpRole === 'guest' && /\/play-net(\?|$)/.test(G.shellFrameSrc), G.shellFrameSrc);
check('E11', 'HOST-A R4 core started inside the /play-net iframe', !!(state.boot.host && state.boot.host.ok), `boot=${state.boot.host ? state.boot.host.ms : '(none)'} ms url=${H.playNetUrl || ''}`);
check('E12', 'GUEST-B R4 core started inside the /play-net iframe', !!(state.boot.guest && state.boot.guest.ok), `boot=${state.boot.guest ? state.boot.guest.ms : '(none)'} ms url=${G.playNetUrl || ''}`);
check('E13', 'both browsers agree on the race plan text', planSame, `host="${planH}" guest="${planG}"`);
check('E14', 'mp trackIndex/carHost/carGuest match the handoff URL on both sides',
  ha.mp.trackIndex === gb.mp.trackIndex && ha.mp.carHost === gb.mp.carHost && ha.mp.carGuest === gb.mp.carGuest
  && String(ha.mp.trackIndex) === String(HP.mpTrackIndex)
  && String(ha.mp.carHost) === String(HP.mpCarHost)
  && String(ha.mp.carGuest) === String(HP.mpCarGuest),
  `host=${ha.mp.trackIndex}/${ha.mp.carHost}/${ha.mp.carGuest} guest=${gb.mp.trackIndex}/${gb.mp.carHost}/${gb.mp.carGuest} url=${HP.mpTrackIndex}/${HP.mpCarHost}/${HP.mpCarGuest}`);
check('E15', 'mp roomName and raceId agree on both sides',
  !!ha.mp.roomName && ha.mp.roomName === gb.mp.roomName && !!ha.mp.raceId && ha.mp.raceId === gb.mp.raceId,
  `room host=${ha.mp.roomName} guest=${gb.mp.roomName} raceId host=${ha.mp.raceId} guest=${gb.mp.raceId}`);
check('E16', 'mp role is host for HOST-A and guest for GUEST-B',
  ha.mp.role === 'host' && gb.mp.role === 'guest' && HP.mpRole === 'host' && GP.mpRole === 'guest',
  `host=${ha.mp.role} guest=${gb.mp.role}`);
check('E17', 'the race plan matches the 2P lounge roll (track + both cars)',
  planMatchesLobby,
  `plan="${planH}" loungeTrack="${state.plan.lobbyTrack}" loungeCars="${state.plan.lobbyCars}"`);
check('E18', 'GUEST-B really joined the host relay room (isNetplay, not owner)',
  !!(state.join && state.join.guestOk) && ga.snapshot.isNetplay === true && ga.snapshot.owner === false,
  `isNetplay=${ga.snapshot.isNetplay} owner=${ga.snapshot.owner} method=${state.join ? state.join.method : '(none)'}`);
check('E19', 'host sees 2 players, both data channels are open, and both sockets share one relay session',
  !!(state.join && state.join.hostOk) && !!(state.join && state.join.sameSession) && ga.snapshot.playerCount === 2,
  `hostPlayers=${state.join && state.join.h ? state.join.h.playerCount : '(none)'} hostSession=${state.join && state.join.h ? state.join.h.session : '(none)'} guestSession=${state.join && state.join.g ? state.join.g.session : '(none)'} sameSession=${state.join ? state.join.sameSession : '(none)'} hostDc=${JSON.stringify(state.join && state.join.h ? state.join.h.peers : null)} guestDc=${JSON.stringify(ga.snapshot.peers)}`);
check('E20', 'host macro reaches race:live', state.macro.reachedLive && state.macro.finalStage === 'race:live', `stage=${state.macro.finalStage} elapsed=${state.macro.elapsedMs} ms error=${state.macro.error || 'none'}`);
const stageNames = ((ha.mp.stages || []).map((s) => s.stage));
check('E21', 'host macro walked menu:ready -> car:p1 -> car:p2 -> course:locked -> race:live',
  stageNames.includes('menu:ready') && stageNames.includes('car:p1') && stageNames.includes('car:p2')
  && stageNames.includes('course:locked') && stageNames.includes('race:live'),
  stageNames.join(' > '));
check('E22', 'host course screenshot captured at course:locked', !!state.courseShot.file && /course/.test(String(state.courseShot.atStage)), `file=${state.courseShot.file} stage=${state.courseShot.atStage}`);
check('E23', 'host split-screen screenshot captured (opaque race frame reached)',
  !!state.screenshots.hostRace && !!state.frames.raceConfirmed && state.frames.raceConfirmed.raceLike === true,
  `file=${state.screenshots.hostRace || '(none)'} raceVisibleAfterRaceLive=${state.raceVisibleAfterRaceLiveMs} ms confirmed=${JSON.stringify(state.frames.raceConfirmed)}`);
const v1 = state.guestVideo.first && state.guestVideo.first.video;
const v2 = state.guestVideo.second && state.guestVideo.second.video;
check('E24', 'guest receives the host video stream', !!v2 && v2.w > 0 && v2.readyState >= 2, `video=${JSON.stringify(v2)}`);
check('E25', 'guest host stream currentTime advances over ~2 s', !!v2 && state.guestVideo.advanceSec !== null && state.guestVideo.advanceSec > 0.5,
  `t1=${v1 ? v1.time : '(none)'} t2=${v2 ? v2.time : '(none)'} advance=${state.guestVideo.advanceSec}s`);
check('E26', 'guest stream screenshot captured at the same moment', !!state.screenshots.guestRace, state.screenshots.guestRace || '(none)');
const gateBefore = state.gating.before || {};
const gateAfter = state.gating.after || {};
check('E27', 'guest input gate is armed before race-live and drops little or nothing',
  gateBefore.inputGated === true && (Number(gateBefore.blockedGuestInputs) || 0) <= 5,
  `inputGated=${gateBefore.inputGated} raceLiveBefore=${gateBefore.raceLive} blockedGuestInputs=${gateBefore.blockedGuestInputs} blockedAtFirstJoinSample=${gateBefore.blockedAtFirstJoinSample} raceLiveAtFirstJoinSample=${gateBefore.raceLiveAtFirstJoinSample}`);
check('E28', 'after race-live the guest gate is engaged and raceLive is true',
  gateAfter.inputGated === true && gateAfter.raceLive === true && ga.mp.raceLive === true,
  `inputGated=${gateAfter.inputGated} raceLive=${gateAfter.raceLive} hostStage=${gateAfter.hostStage}`);
check('E29', 'guest input reaches the host core as PLAYER 2 (player 1, index 0, value 1)',
  !!state.input.matched,
  `matched=${JSON.stringify(state.input.matched)} guestCallReturn=${state.input.guestCallReturn} records=${state.input.hostRecords.length} player0Records=${state.input.player0Records}`);
check('E30', 'no uncaught page errors in either browser',
  H.pageErrors.length === 0 && G.pageErrors.length === 0,
  `host=${JSON.stringify(H.pageErrors)} guest=${JSON.stringify(G.pageErrors)}`);
check('E31', 'no unexpected console errors in either browser (ICE/COOP/core-option noise ignored)',
  H.consoleErrors.length === 0 && G.consoleErrors.length === 0,
  `host=${H.consoleErrors.length} guest=${G.consoleErrors.length} ignoredHost=${H.consoleIgnored.length} ignoredGuest=${G.consoleIgnored.length}`);
check('E32', 'guest received the host race-live stage over the control channel',
  ga.mp.raceLive === true && (ga.mp.controlReceived || []).some((m) => m.type === 'race-live'),
  `raceLive=${ga.mp.raceLive} control=${JSON.stringify((ga.mp.controlReceived || []).slice(-3))}`);
check('E40', 'guest chip shows the seat and P2 live after the race starts',
  !!state.gating.chip && /P2 LIVE/i.test(String(state.gating.chip.text || '')),
  JSON.stringify(state.gating.chip));
check('E33', 'no fatal harness error', !state.fatal, state.fatal ? state.fatal.message : 'none');
const raceFrame = state.frames.race;
const courseFrame = state.frames.course;
check('E34', 'the host stream is a live race frame, not the 2P menu or the VS Battle loading card',
  !!raceFrame && raceFrame.ok === true && raceFrame.raceLike === true && raceFrame.menuLike === false,
  `race=${JSON.stringify(raceFrame)} live6s=${JSON.stringify(state.frames.live6s)} course=${JSON.stringify(courseFrame)}`);
check('E35', 'guest screenshot of the P1 car-data panel at car:p1:data',
  !!state.carPanels.p1 && !!state.carPanels.p1.file && /car/.test(String(state.carPanels.p1.stage)),
  `file=${state.carPanels.p1 && state.carPanels.p1.file} stage=${state.carPanels.p1 && state.carPanels.p1.stage} panelTextInDom=${state.carPanels.p1 && state.carPanels.p1.dom && state.carPanels.p1.dom.panelTextInDom} canvasOnly=${state.carPanels.p1 && state.carPanels.p1.dom && state.carPanels.p1.dom.canvasOnly}`);
check('E36', 'guest screenshot of the P2 car-data panel at car:p2:data',
  !!state.carPanels.p2 && !!state.carPanels.p2.file && /car/.test(String(state.carPanels.p2.stage)),
  `file=${state.carPanels.p2 && state.carPanels.p2.file} stage=${state.carPanels.p2 && state.carPanels.p2.stage} panelTextInDom=${state.carPanels.p2 && state.carPanels.p2.dom && state.carPanels.p2.dom.panelTextInDom} canvasOnly=${state.carPanels.p2 && state.carPanels.p2.dom && state.carPanels.p2.dom.canvasOnly}`);
check('E37', 'host loading/course card captured around race:starting',
  !!state.loadingShot && !!state.loadingShot.file && !!state.loadingShot.probe,
  `file=${state.loadingShot && state.loadingShot.file} phase=${state.loadingShot && state.loadingShot.phase} afterRaceStarting=${state.loadingShot && state.loadingShot.afterRaceStartingMs} ms cardLike=${state.loadingShot && state.loadingShot.probe && state.loadingShot.probe.cardLike} probe=${JSON.stringify(state.loadingShot && state.loadingShot.probe)}`);

const raceFrames = state.raceFrames || {};
const hostFrameMetrics = raceFrames.host || {};
const guestFrameMetrics = raceFrames.guest || {};
check('E38', 'race:live + 18 s: host race frame (yellowPct < 30, nonBlackPct > 25)',
  hostFrameMetrics.ok === true && hostFrameMetrics.yellowPct < 30 && hostFrameMetrics.nonBlackPct > 25,
  `file=${state.screenshots.hostRaceFrame || '(none)'} afterRaceLive=${raceFrames.afterRaceLiveMs} ms metrics=${JSON.stringify(hostFrameMetrics)}`);
check('E39', 'race:live + 18 s: guest race frame (host stream) + media clock still advancing',
  guestFrameMetrics.ok === true && guestFrameMetrics.yellowPct < 30 && guestFrameMetrics.nonBlackPct > 25
  && raceFrames.guestAdvanceSec !== null && raceFrames.guestAdvanceSec > 0.5,
  `file=${state.screenshots.guestRaceFrame || '(none)'} metrics=${JSON.stringify(guestFrameMetrics)} advance=${raceFrames.guestAdvanceSec}s`);

const passed = A.filter((a) => a.pass).length;
const failed = A.length - passed;

const report = {
  test: 'two-browser direct 2P head-to-head race (shell -> lounge -> real /play-net -> host macro -> guest P2 input)',
  scopeNote: 'No request interception: both browsers load the real /play-net document, boot the R4 core, join one relay session and stream. The race itself is asserted from pixels: at race:live + 18 s the host canvas crop and the guest host-stream video are both yellowPct < 30 / nonBlackPct > 25 with the guest media clock still advancing. The guest P2 proof is a host-stream input test (player 1, index 0) plus the host-side input-gate accounting; P2 gameplay parity on the guest core is not asserted.',
  label: 'harness-verified two-browser (two contexts on one host; two physical machines and remote audio unverified)',
  baseUrl: BASE,
  relay: 'http://localhost:3010',
  command: 'cd "_server"; node test-mp-race-e2e.mjs',
  code: CODE,
  startedAt: iso(startedAt),
  finishedAt: state.finishedAt,
  durationMs: state.durationMs,
  phases: state.phases,
  steps,
  boot: { host: state.boot.host, guest: state.boot.guest },
  plan: {
    hostPlanText: planH,
    guestPlanText: planG,
    planAgrees: planSame,
    planMatchesLoungeRoll: planMatchesLobby,
    loungeTrack: state.plan.lobbyTrack,
    loungeCars: state.plan.lobbyCars,
    expectedTrackFromIndex: planTrack,
    expectedCarHost: planCarHost,
    expectedCarGuest: planCarGuest,
    host: state.plan.host,
    guest: state.plan.guest,
    handoffParams: { host: HP, guest: GP },
  },
  join: state.join,
  macro: {
    reachedLive: state.macro.reachedLive,
    finalStage: state.macro.finalStage,
    elapsedMs: state.macro.elapsedMs,
    error: state.macro.error,
    stagePoll: state.macro.stagePoll,
    stages: (ha.mp.stages || []),
    hostLogsTail: state.macro.hostLogsTail,
  },
  gating: state.gating,
  frames: state.frames,
  raceFrames: state.raceFrames,
  raceVisibleAfterRaceLiveMs: state.raceVisibleAfterRaceLiveMs,
  carPanels: state.carPanels,
  loadingShot: state.loadingShot,
  guestVideo: {
    first: state.guestVideo.first && state.guestVideo.first.video,
    second: state.guestVideo.second && state.guestVideo.second.video,
    advanceSec: state.guestVideo.advanceSec,
    dom: state.guestVideo.dom,
  },
  guestInput: state.input,
  snapshots: {
    host: { before: state.snapshots.host.before, after: state.snapshots.host.after },
    guest: { before: state.snapshots.guest.before, after: state.snapshots.guest.after },
  },
  screenshots: {
    ...state.screenshots,
    courseStage: state.courseShot.atStage,
    note: 'Viewport shots (1440x900) of the cabinet shell with the /play-net iframe. -host-go/-guest-go are the 2P lounge GO overlay just before the handoff; -host-course is the host course select during course:locked; -guest-car-p1/-guest-car-p2 are the guest-side copies of the host car-data panels; -host-loading is the VS Battle card / course fade around race:starting; -host-live6s/-guest-live6s are the honest race:live + 6 s moment; -host-race/-guest-race are the race:live + 18 s pair measured with yellowPct/nonBlackPct; -host/-guest are the same split-screen once the stream probe confirms an opaque race frame.',
  },
  console: {
    host: { errors: H.consoleErrors, ignored: H.consoleIgnored, pageErrors: H.pageErrors, requestFailed: H.requestFailed },
    guest: { errors: G.consoleErrors, ignored: G.consoleIgnored, pageErrors: G.pageErrors, requestFailed: G.requestFailed },
    ignoredPatterns: IGNORED_CONSOLE.map((re) => String(re)),
  },
  fatal: state.fatal,
  assertions: A,
  summary: { total: A.length, passed, failed },
};

fs.writeFileSync(`${OUT}/mp-race-e2e.json`, JSON.stringify(report, null, 2) + '\n', 'utf8');

const stageLine = (state.macro.stagePoll || []).map((s) => s.stage).join(' > ');
const logOut = [
  'R4 2P RACE E2E - two independent browser contexts, real /play-net, no interception',
  `base: ${BASE}   relay: http://localhost:3010`,
  `command: cd "_server"; node test-mp-race-e2e.mjs`,
  `room code: ${CODE}   raceId: ${ha.mp.raceId || '(none)'}`,
  `plan: "${planH}" (host) / "${planG}" (guest)`,
  `lounge roll: track="${state.plan.lobbyTrack}" cars="${state.plan.lobbyCars}"`,
  `boot: host ${state.boot.host ? state.boot.host.ms : '?'} ms, guest ${state.boot.guest ? state.boot.guest.ms : '?'} ms`,
  `macro stages: ${stageLine || '(none)'}`,
  `join: ${state.join ? state.join.method : '(none)'} hostPlayers=${state.join && state.join.h ? state.join.h.playerCount : '?'} guestJoined=${state.join ? state.join.guestOk : '?'}`,
  `guest video: ${JSON.stringify(v2)} advance=${state.guestVideo.advanceSec}s`,
  `gating before: ${JSON.stringify(state.gating.before)}`,
  `gating after:  ${JSON.stringify(state.gating.after)}`,
  `frames: course ${JSON.stringify(state.frames.course)}`,
  `frames: race   ${JSON.stringify(state.frames.race)}`,
  `race opaque after race:live: +${state.raceVisibleAfterRaceLiveMs} ms (confirmed ${JSON.stringify(state.frames.raceConfirmed)})`,
  `race:live + 18 s host frame: ${JSON.stringify(state.raceFrames && state.raceFrames.host)}`,
  `race:live + 18 s guest frame: ${JSON.stringify(state.raceFrames && state.raceFrames.guest)} advance=${state.raceFrames && state.raceFrames.guestAdvanceSec}s`,
  `car panels: p1=${state.carPanels.p1 && state.carPanels.p1.file} (domText=${state.carPanels.p1 && state.carPanels.p1.dom && state.carPanels.p1.dom.panelTextInDom}) p2=${state.carPanels.p2 && state.carPanels.p2.file} (domText=${state.carPanels.p2 && state.carPanels.p2.dom && state.carPanels.p2.dom.panelTextInDom})`,
  `loading card: ${state.loadingShot && state.loadingShot.file} (+${state.loadingShot && state.loadingShot.afterRaceStartingMs} ms after race:starting)`,
  `guest input -> host records: ${JSON.stringify(state.input.hostRecords.slice(-6))}`,
  `screenshots: ${Object.values(state.screenshots).filter((v) => typeof v === 'string' && /\.png$/.test(v)).join(', ') || '(none)'}`,
  `started: ${report.startedAt}  finished: ${report.finishedAt}  (${state.durationMs} ms)`,
  '',
  ...logLines.filter((l) => l.startsWith('STEP') || l.startsWith('FATAL') || l.startsWith('PASS') || l.startsWith('FAIL') || l.startsWith('plan') || l.startsWith('join') || l.startsWith('gating') || l.startsWith('host stage') || l.startsWith('guest video') || l.startsWith('guest simulateInput') || l.startsWith('matched') || l.startsWith('race frame') || l.startsWith('SHOT')),
  '',
  `checks: ${passed} passed / ${failed} failed (of ${A.length})`,
  failed ? 'RESULT: FAIL' : 'RESULT: PASS',
  '',
].join('\n');
fs.writeFileSync(`${OUT}/mp-race-e2e.log`, '\ufeff' + logOut, 'utf8');

log(`checks: ${passed} passed / ${failed} failed (of ${A.length})`);
log(`evidence: ${OUT}/mp-race-e2e.json, ${OUT}/mp-race-e2e.log`);
process.exitCode = failed ? 1 : 0;
