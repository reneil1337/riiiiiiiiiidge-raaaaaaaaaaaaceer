// bench-netplay.mjs - WebRTC / netplay observability artifact for /play-net.
//
// Two independent browser contexts boot the real /play-net document (R4 core on
// both sides), one hosts a relay room, the other joins it, and the harness
// samples RTCPeerConnection.getStats() + the guest <video> playback quality for
// a fixed window. No macro runs: this measures the transport and the guest
// presentation, not the VS Battle menu walk.
//
// Usage:
//   node bench-netplay.mjs                       # 12 s sample window
//   node bench-netplay.mjs --seconds 20 --label netplay-before
//   node bench-netplay.mjs --quick               # 8 s, still two contexts
//   node bench-netplay.mjs --tier netplay-lan
//
// Writes _runtime/bench-netplay-<label>.json. Never starts/stops a server.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import puppeteer from 'puppeteer-core';

const ROOT = '..';
const OUT = path.join(ROOT, '_runtime');
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const SCHEMA = 'rr4.bench.netplay/1';

function arg(name, def = null) {
  const i = process.argv.indexOf('--' + name);
  if (i === -1) return def;
  const v = process.argv[i + 1];
  return v && !v.startsWith('--') ? v : true;
}
const flag = (name) => !!arg(name, false);

const QUICK = flag('quick');
const LABEL = String(arg('label', 'netplay-local')).replace(/[^a-zA-Z0-9._-]/g, '-');
const TIER = String(arg('tier', 'netplay-lan'));
const BASE = String(arg('base', 'http://localhost:8080')).replace(/\/$/, '');
const SECONDS = Number(arg('seconds', QUICK ? 8 : 12));
const SETTLE_MS = Number(arg('settle', 3500));
const STRICT = flag('strict');
const SWIFTSHADER = flag('swiftshader');
const CODE = String(arg('code', '') || Array.from({ length: 4 }, () => 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'[Math.floor(Math.random() * 32)]).join(''));
const ROOM = `BENCH-${CODE}`;
const GAME_URL = `${BASE}/play-net?game=r4`;
const PROFILE = String(arg('profile', path.join(ROOT, '_runtime', 'bench-netplay-profile')));

fs.mkdirSync(OUT, { recursive: true });
fs.mkdirSync(PROFILE, { recursive: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log('[netbench]', ...a);
const r1 = (n, d = 1) => (n == null || !Number.isFinite(n) ? null : +n.toFixed(d));

const TIERS = {
  'netplay-lan': {
    label: 'same-subnet LAN baseline: pinned EJS 4.3.0-pre hardcodes canvas.captureStream(30), so 30 fps is the current ceiling',
    checks: [
      { id: 'G-FPS', metric: 'guest.displayFps', op: '>=', value: 26, unit: 'fps', why: 'guest presented frames in headless; the pinned stream itself is 30 fps' },
      { id: 'G-DROP', metric: 'guest.droppedPct', op: '<=', value: 8, unit: '%', why: 'headless presentation proxy: 1 - rVFC/presented; not a display measurement' },
      { id: 'G-LOSS', metric: 'net.inbound.packetLossPct', op: '<=', value: 2, unit: '%', why: 'inbound RTP packet loss' },
      { id: 'RTT', metric: 'net.rttMs', op: '<=', value: 50, unit: 'ms', why: 'LAN round-trip time' },
      { id: 'JBUF', metric: 'net.jitterBufferDelayMs', op: '<=', value: 100, unit: 'ms', why: 'decoded jitter-buffer latency' },
      { id: 'QLIM', metric: 'net.qualityLimitation.nonePct', op: '>=', value: 80, unit: '%', why: 'encoder not limited by CPU/bandwidth' },
      { id: 'KBPS', metric: 'host.sendKbps', op: '>=', value: 150, unit: 'kbps', why: 'stream is real, not a still frame' },
      { id: 'RES', metric: 'guest.video.w', op: '>=', value: 320, unit: 'px', why: 'guest received a real host frame' },
      { id: 'HOST-EMU', metric: 'host.emuFps', op: '>=', value: 59.5, unit: 'fps', why: 'host PSX core still runs at 60' },
      { id: 'HOST-ENC', metric: 'host.encodeFps', op: '>=', value: 28, unit: 'fps', why: 'host encoder keeps up with the 30 fps capture' },
    ],
  },
  'netplay-lan-target': {
    label: 'accepted target after a 60 fps netplay change: same LAN, same two-context harness; 58 fps guest + <=2% loss',
    checks: [
      { id: 'G-FPS', metric: 'guest.displayFps', op: '>=', value: 58, unit: 'fps', why: 'guest presented frames at 60' },
      { id: 'G-DROP', metric: 'guest.droppedPct', op: '<=', value: 2, unit: '%', why: 'presentation loss' },
      { id: 'G-LOSS', metric: 'net.inbound.packetLossPct', op: '<=', value: 2, unit: '%', why: 'inbound RTP packet loss' },
      { id: 'RTT', metric: 'net.rttMs', op: '<=', value: 50, unit: 'ms', why: 'LAN RTT' },
      { id: 'JBUF', metric: 'net.jitterBufferDelayMs', op: '<=', value: 100, unit: 'ms', why: 'jitter buffer' },
      { id: 'HOST-ENC', metric: 'host.encodeFps', op: '>=', value: 58, unit: 'fps', why: '60 fps capture + encode' },
      { id: 'HOST-EMU', metric: 'host.emuFps', op: '>=', value: 59.5, unit: 'fps', why: 'host core at 60' },
      { id: 'KBPS', metric: 'host.sendKbps', op: '>=', value: 600, unit: 'kbps', why: '60 fps needs a higher sustained bitrate' },
    ],
  },
  'netplay-lan-midrange': {
    label: 'mid-range client on the same LAN (headful laptop / software renderer), not a switch+wifi measurement',
    checks: [
      { id: 'G-FPS', metric: 'guest.displayFps', op: '>=', value: 27, unit: 'fps', why: 'guest presented video fps' },
      { id: 'G-DROP', metric: 'guest.droppedPct', op: '<=', value: 5, unit: '%', why: 'presentation loss' },
      { id: 'G-LOSS', metric: 'net.inbound.packetLossPct', op: '<=', value: 3, unit: '%', why: 'packet loss' },
      { id: 'RTT', metric: 'net.rttMs', op: '<=', value: 80, unit: 'ms', why: 'LAN RTT' },
      { id: 'JBUF', metric: 'net.jitterBufferDelayMs', op: '<=', value: 150, unit: 'ms', why: 'jitter buffer' },
    ],
  },
};

const getPath = (obj, dotted) => dotted.split('.').reduce((o, k) => (o == null ? null : o[k]), obj);
function evaluateChecks(result, tierKey) {
  const tier = TIERS[tierKey];
  if (!tier) throw new Error(`unknown tier "${tierKey}" (use ${Object.keys(TIERS).join('|')})`);
  return tier.checks.map((c) => {
    const actual = getPath(result, c.metric);
    let pass = null;
    if (actual != null) {
      if (c.op === '>=') pass = actual >= c.value;
      else if (c.op === '<=') pass = actual <= c.value;
      else if (c.op === '==') pass = actual === c.value;
    }
    return { ...c, actual, pass, tier: tierKey };
  });
}

// Extract the getStats() fields that matter for a host/guest split. Everything
// is raw browser data; the deltas are computed in Node over the sample window.
const STATS_FN = async () => {
  const np = window.EJS_emulator?.netplay;
  const pcs = np?.peerConnections ? Object.values(np.peerConnections) : [];
  const out = { pcCount: pcs.length, pcs: [], video: null, playback: null, frameNum: window.EJS_emulator?.gameManager?.getFrameNum?.() ?? null, guestFrameNum: window.EJS_emulator?.gameManager?.getFrameNum?.() ?? null,
    visibility: document.visibilityState,
    canvas: (() => { const c = document.querySelector('#game canvas'); return c ? { w: c.width, h: c.height, cssW: c.clientWidth, cssH: c.clientHeight } : null; })() };
  const pick = (s) => ({
    timestamp: s.timestamp,
    framesEncoded: s.framesEncoded ?? null,
    framesDecoded: s.framesDecoded ?? null,
    framesPerSecond: s.framesPerSecond ?? null,
    framesSent: s.framesSent ?? null,
    framesReceived: s.framesReceived ?? null,
    keyFramesEncoded: s.keyFramesEncoded ?? null,
    keyFramesDecoded: s.keyFramesDecoded ?? null,
    bytesSent: s.bytesSent ?? null,
    bytesReceived: s.bytesReceived ?? null,
    packetsSent: s.packetsSent ?? null,
    packetsReceived: s.packetsReceived ?? null,
    packetsLost: s.packetsLost ?? null,
    nackCount: s.nackCount ?? null,
    pliCount: s.pliCount ?? null,
    firCount: s.firCount ?? null,
    jitter: s.jitter ?? null,
    jitterBufferDelay: s.jitterBufferDelay ?? null,
    jitterBufferEmittedCount: s.jitterBufferEmittedCount ?? null,
    jitterBufferTargetDelay: s.jitterBufferTargetDelay ?? null,
    totalDecodeTime: s.totalDecodeTime ?? null,
    totalEncodeTime: s.totalEncodeTime ?? null,
    totalProcessingDelay: s.totalProcessingDelay ?? null,
    qualityLimitationReason: s.qualityLimitationReason ?? null,
    qualityLimitationDurations: s.qualityLimitationDurations ?? null,
    freezeCount: s.freezeCount ?? null,
    pauseCount: s.pauseCount ?? null,
    totalFreezesDuration: s.totalFreezesDuration ?? null,
    totalPausesDuration: s.totalPausesDuration ?? null,
    availableOutgoingBitrate: s.availableOutgoingBitrate ?? null,
    roundTripTime: s.roundTripTime ?? null,
    currentRoundTripTime: s.currentRoundTripTime ?? null,
    state: s.state ?? null,
    nominated: s.nominated ?? null,
    localCandidateId: s.localCandidateId ?? null,
    remoteCandidateId: s.remoteCandidateId ?? null,
    codecId: s.codecId ?? null,
  });
  for (const entry of pcs) {
    const pc = entry.pc || entry;
    const o = {
      connectionState: pc?.connectionState ?? null,
      iceConnectionState: pc?.iceConnectionState ?? null,
      dataChannel: entry.dataChannel?.readyState ?? null,
      outbound: null, inbound: null, remoteInbound: null, candidatePair: null, codec: null,
    };
    try {
      const report = await pc.getStats();
      report.forEach((s) => {
        if (s.type === 'outbound-rtp' && s.kind === 'video' && !o.outbound) o.outbound = pick(s);
        else if (s.type === 'inbound-rtp' && s.kind === 'video' && !o.inbound) o.inbound = pick(s);
        else if (s.type === 'remote-inbound-rtp' && s.kind === 'video' && !o.remoteInbound) o.remoteInbound = pick(s);
        else if (s.type === 'candidate-pair' && s.state === 'succeeded' && (!o.candidatePair || s.nominated)) o.candidatePair = pick(s);
        else if (s.type === 'codec' && s.mimeType && /video/i.test(s.mimeType) && s.payloadType != null) o.codec = { mimeType: s.mimeType, clockRate: s.clockRate, payloadType: s.payloadType };
      });
      if (!o.codec) {
        report.forEach((s) => { if (!o.codec && s.type === 'codec' && s.mimeType) o.codec = { mimeType: s.mimeType, clockRate: s.clockRate ?? null }; });
      }
    } catch (e) { o.error = String(e); }
    out.pcs.push(o);
  }
  const v = np?.video || document.querySelector('#game video') || document.querySelector('video');
  if (v) {
    out.video = {
      w: v.videoWidth, h: v.videoHeight, readyState: v.readyState, paused: v.paused,
      currentTime: +v.currentTime.toFixed(3), muted: v.muted,
    };
    if (typeof v.getVideoPlaybackQuality === 'function') {
      const q = v.getVideoPlaybackQuality();
      out.playback = {
        totalVideoFrames: q.totalVideoFrames,
        droppedVideoFrames: q.droppedVideoFrames,
        corruptedVideoFrames: q.corruptedVideoFrames,
        creationTime: q.creationTime ?? null,
      };
    }
  }
  return out;
};

const t0 = Date.now();
const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: true,
  userDataDir: PROFILE,
  protocolTimeout: 240000,
  defaultViewport: { width: 1280, height: 900 },
  args: [
    '--no-sandbox',
    '--mute-audio',
    '--autoplay-policy=no-user-gesture-required',
    ...(SWIFTSHADER ? ['--enable-unsafe-swiftshader', '--use-angle=swiftshader'] : []),
    '--disable-background-timer-throttling',
    '--disable-backgrounding-occluded-windows',
    '--disable-renderer-backgrounding',
    '--disable-background-networking',
    '--window-size=1280,900',
  ],
});
const browserVersion = await browser.version();
const hostCtx = await browser.createBrowserContext();
const guestCtx = await browser.createBrowserContext();
const pages = {};
const logs = { host: { counts: {}, tail: [], errors: [] }, guest: { counts: {}, tail: [], errors: [] } };
const rom = { host: null, guest: null };

function attach(label, page) {
  page.on('console', (m) => {
    const t = m.type();
    const rec = logs[label];
    rec.counts[t] = (rec.counts[t] || 0) + 1;
    if (rec.tail.length < 60) rec.tail.push(`[${t}] ${m.text().slice(0, 300)}`);
  });
  page.on('pageerror', (e) => logs[label].errors.push(String(e.message).slice(0, 300)));
  page.on('response', (r) => {
    if (/\/rom\//.test(r.url()) && r.request().method() === 'GET') {
      const h = r.headers();
      if (Number(h['content-length'] || 0) > 1000000) rom[label] = Number(h['content-length']);
    }
  });
}

async function waitFor(page, label, fn, timeout = 180000) {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    const v = await page.evaluate(fn).catch(() => null);
    if (v) return v;
    await sleep(500);
  }
  throw new Error(`timeout ${label}`);
}

let hostPage, guestPage, sampleStart = null, sampleEnd = null, samples = [];
try {
  hostPage = await hostCtx.newPage();
  guestPage = await guestCtx.newPage();
  await hostPage.setCacheEnabled(false);
  await guestPage.setCacheEnabled(false);
  attach('host', hostPage);
  attach('guest', guestPage);

  log('BOOT host', GAME_URL);
  const hostBootT0 = Date.now();
  await hostPage.goto(GAME_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await waitFor(hostPage, 'host boot', () => !!(window.EJS_emulator && window.__R4?.startedAt && window.__R4NET), 180000);
  const hostBootMs = Date.now() - hostBootT0;
  log('BOOT host took', hostBootMs, 'ms');

  log('BOOT guest');
  const guestBootT0 = Date.now();
  await guestPage.goto(GAME_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await waitFor(guestPage, 'guest boot', () => !!(window.EJS_emulator && window.__R4?.startedAt && window.__R4NET), 180000);
  const guestBootMs = Date.now() - guestBootT0;
  log('BOOT guest took', guestBootMs, 'ms');

  for (const [label, p] of [['host', hostPage], ['guest', guestPage]]) {
    await p.evaluate(() => {
      try { window.EJS_emulator?.play?.(); } catch { /* ignore */ }
      window.__R4NET.closePanel();
    });
  }

  // Host creates the room.
  await hostPage.evaluate((name) => {
    window.__R4NET.setName('BENCH-HOST');
    window.__R4NET.hostRoom(name, 2, '');
  }, ROOM);
  const hostReady = await waitFor(hostPage, 'host room', () => {
    const s = window.__R4NET.snapshot();
    return s.isNetplay && s.owner ? { netplay: s.isNetplay, owner: s.owner, connected: s.connected, room: s.room } : null;
  }, 60000);
  log('HOST ROOM', JSON.stringify(hostReady));

  // Guest finds and joins that exact room.
  let joinInfo = null;
  const joinDeadline = Date.now() + 90000;
  while (Date.now() < joinDeadline) {
    joinInfo = await guestPage.evaluate(async (name) => {
      const rooms = await window.__R4NET.getRooms();
      const hit = Object.entries(rooms).find(([, r]) => r.room_name === name);
      if (!hit) return null;
      window.__R4NET.setName('BENCH-GUEST');
      window.__R4NET.joinRoom(hit[0], hit[1].room_name, 2, '');
      return { sid: hit[0], room: hit[1].room_name };
    }, ROOM);
    if (joinInfo) break;
    await sleep(1000);
  }
  if (!joinInfo) throw new Error('guest never saw the room');
  log('GUEST JOIN', JSON.stringify(joinInfo));
  const guestReady = await waitFor(guestPage, 'guest join', () => {
    const s = window.__R4NET.snapshot();
    return s.isNetplay && !s.owner ? { netplay: s.isNetplay, owner: s.owner, connected: s.connected } : null;
  }, 60000);
  log('GUEST ROOM', JSON.stringify(guestReady));

  // Wait for an open data channel, then for the host stream to present.
  const connected = await waitFor(hostPage, 'peer connected', () => {
    const s = window.__R4NET.snapshot();
    const peers = s.peers || [];
    return peers.length && peers.every((p) => p.state === 'connected' && p.dc === 'open') ? peers : null;
  }, 90000);
  log('PEERS', JSON.stringify(connected));
  await guestPage.evaluate(() => {
    const c = document.querySelector('#game canvas') || document.querySelector('#game video');
    if (c) { const r = c.getBoundingClientRect(); window.__benchClick = [r.x + r.width / 2, r.y + r.height / 2]; }
  });
  const gp = await guestPage.evaluate(() => window.__benchClick || null);
  if (gp) await guestPage.mouse.click(gp[0], gp[1]);
  const hp = await hostPage.evaluate(() => {
    const c = document.querySelector('#game canvas');
    if (!c) return null;
    const r = c.getBoundingClientRect();
    return [r.x + r.width / 2, r.y + r.height / 2];
  });
  if (hp) await hostPage.mouse.click(hp[0], hp[1]);

  await waitFor(guestPage, 'guest video', () => {
    const np = window.EJS_emulator?.netplay;
    const v = np?.video || document.querySelector('#game video');
    return v && v.videoWidth > 0 && v.readyState >= 2 ? { w: v.videoWidth, h: v.videoHeight, rs: v.readyState } : null;
  }, 90000);
  log('GUEST VIDEO up');
  // The two pages share one headless window: only the front tab composites.
  // Bring the guest forward so requestVideoFrameCallback measures presented
  // frames instead of a throttled background tab.
  await guestPage.bringToFront();
  await sleep(SETTLE_MS);

  // -------------------------------------------------------------------------
  // Sample window.
  // -------------------------------------------------------------------------
  sampleStart = Date.now();
  const hostFirst = await hostPage.evaluate(STATS_FN);
  const guestFirst = await guestPage.evaluate(STATS_FN);
  log('SAMPLE start', new Date(sampleStart).toISOString());
  for (let i = 0; i < SECONDS; i++) {
    await sleep(1000);
    const h = await hostPage.evaluate(STATS_FN);
    const g = await guestPage.evaluate(STATS_FN);
    samples.push({ t: Date.now() - sampleStart, host: h, guest: g });
    if ((i + 1) % 4 === 0 || i === SECONDS - 1) {
      const q = g.playback && g.playback.totalVideoFrames;
      log(`t=${i + 1}s hostEnc=${h.pcs[0]?.outbound?.framesPerSecond ?? 'n/a'} guestFrames=${q ?? 'n/a'} guestDropped=${g.playback?.droppedVideoFrames ?? 'n/a'}`);
    }
  }
  sampleEnd = Date.now();
  const hostLast = await hostPage.evaluate(STATS_FN);
  const guestLast = await guestPage.evaluate(STATS_FN);

  // 3 s rVFC check on the guest video. This is the only honest presented-frame
  // counter in headless: getVideoPlaybackQuality() marks every frame dropped
  // when nothing is composited to a display.
  await guestPage.bringToFront();
  const rvfc = await guestPage.evaluate(() => new Promise((resolve) => {
    const np = window.EJS_emulator?.netplay;
    const v = np?.video || document.querySelector('#game video');
    if (!v || typeof v.requestVideoFrameCallback !== 'function') return resolve({ supported: false });
    let frames = 0; const t0 = performance.now();
    const done = () => resolve({ supported: true, frames, ms: Math.round(performance.now() - t0), fps: +((frames / (performance.now() - t0)) * 1000).toFixed(2) });
    const timer = setTimeout(done, 3400);
    const cb = () => { frames++; if (performance.now() - t0 < 3000) v.requestVideoFrameCallback(cb); else { clearTimeout(timer); done(); } };
    v.requestVideoFrameCallback(cb);
  }));

  // -------------------------------------------------------------------------
  // Reduce: cumulative counters from first -> last, plus gauges from samples.
  // -------------------------------------------------------------------------
  const dtSec = (sampleEnd - sampleStart) / 1000;
  const delta = (a, b) => (a != null && b != null ? b - a : null);
  const perSec = (a, b) => { const d = delta(a, b); return d == null ? null : d / dtSec; };
  const pct = (n, d) => (n != null && d ? +((n / d) * 100).toFixed(2) : null);

  const hostOut = (hostLast.pcs[0] || {}).outbound || {};
  const hostOut0 = (hostFirst.pcs[0] || {}).outbound || {};
  const guestIn = (guestLast.pcs[0] || {}).inbound || {};
  const guestIn0 = (guestFirst.pcs[0] || {}).inbound || {};
  const guestPlay = guestLast.playback || {};
  const guestPlay0 = guestFirst.playback || {};
  const pair = (guestLast.pcs[0] || {}).candidatePair || {};
  const hostPair = (hostLast.pcs[0] || {}).candidatePair || {};
  const remoteIn = guestLast.pcs[0]?.remoteInbound || null;
  const hostRemoteIn = hostLast.pcs[0]?.remoteInbound || null;

  const qReasons = {};
  for (const s of samples) {
    const reason = s.host.pcs[0]?.outbound?.qualityLimitationReason;
    if (reason) qReasons[reason] = (qReasons[reason] || 0) + 1;
  }
  const encFrames = delta(hostOut0.framesEncoded, hostOut.framesEncoded);
  const encTime = delta(hostOut0.totalEncodeTime, hostOut.totalEncodeTime);
  const decFrames = delta(guestIn0.framesDecoded, guestIn.framesDecoded);
  const decTime = delta(guestIn0.totalDecodeTime, guestIn.totalDecodeTime);
  const jbDelay = delta(guestIn0.jitterBufferDelay, guestIn.jitterBufferDelay);
  const jbCount = delta(guestIn0.jitterBufferEmittedCount, guestIn.jitterBufferEmittedCount);
  const packetsRecv = delta(guestIn0.packetsReceived, guestIn.packetsReceived);
  const packetsLost = delta(guestIn0.packetsLost, guestIn.packetsLost);
  const videoFrames = delta(guestPlay0.totalVideoFrames, guestPlay.totalVideoFrames);
  const videoDropped = delta(guestPlay0.droppedVideoFrames, guestPlay.droppedVideoFrames);
  const guestOverlay = guestLast.video;

  const rttPick = (() => {
    if (pair.currentRoundTripTime != null) return { ms: pair.currentRoundTripTime * 1000, source: 'guest candidate-pair' };
    if (remoteIn?.roundTripTime != null) return { ms: remoteIn.roundTripTime * 1000, source: 'guest remote-inbound-rtp' };
    if (hostPair.currentRoundTripTime != null) return { ms: hostPair.currentRoundTripTime * 1000, source: 'host candidate-pair' };
    if (hostRemoteIn?.roundTripTime != null) return { ms: hostRemoteIn.roundTripTime * 1000, source: 'host remote-inbound-rtp' };
    return { ms: null, source: null };
  })();
  const net = {
    dtSec: +dtSec.toFixed(2),
    rttMs: rttPick.ms != null ? +rttPick.ms.toFixed(1) : null,
    rttSource: rttPick.source,
    availableOutgoingBitrateMbps: hostOut.availableOutgoingBitrate != null ? +(hostOut.availableOutgoingBitrate / 1e6).toFixed(2)
      : (hostPair.availableOutgoingBitrate != null ? +(hostPair.availableOutgoingBitrate / 1e6).toFixed(2) : null),
    jitterBufferDelayMs: jbDelay != null && jbCount ? +((jbDelay / jbCount) * 1000).toFixed(1) : null,
    inbound: {
      framesPerSecond: guestIn.framesPerSecond ?? null,
      framesDecoded: guestIn.framesDecoded ?? null,
      decodedFps: +((decFrames / dtSec) || 0).toFixed(2),
      packetsReceived: guestIn.packetsReceived ?? null,
      packetsLost: guestIn.packetsLost ?? null,
      packetsLostWindow: packetsLost,
      packetLossPct: pct(packetsLost, (packetsRecv || 0) + (packetsLost || 0)),
      jitterMs: guestIn.jitter != null ? +(guestIn.jitter * 1000).toFixed(1) : null,
      freezeCount: guestIn.freezeCount ?? null,
      totalFreezesDurationMs: guestIn.totalFreezesDuration != null ? +(guestIn.totalFreezesDuration * 1000).toFixed(0) : null,
      nackCount: guestIn.nackCount ?? null,
      pliCount: guestIn.pliCount ?? null,
      avgDecodeMs: decFrames ? +((decTime / decFrames) * 1000).toFixed(2) : null,
    },
    qualityLimitation: {
      last: hostOut.qualityLimitationReason ?? null,
      counts: qReasons,
      nonePct: samples.length ? +(((qReasons.none || 0) / samples.length) * 100).toFixed(1) : null,
    },
    codec: (hostLast.pcs[0] || {}).codec || null,
    pcStates: {
      host: (hostLast.pcs[0] || {}).connectionState ?? null,
      guest: (guestLast.pcs[0] || {}).connectionState ?? null,
      dataChannel: (hostLast.pcs[0] || {}).dataChannel ?? null,
    },
  };
  const hostFrameDelta = delta(hostFirst.frameNum, hostLast.frameNum);
  const decodedFps = decFrames / dtSec;
  const rvfcFps = rvfc.supported ? rvfc.fps : null;
  const displayFps = rvfcFps != null ? rvfcFps : videoFrames / dtSec;
  const presentationLostPct = rvfcFps != null && decodedFps ? pct(Math.max(0, decodedFps - rvfcFps), decodedFps) : null;

  const host = {
    encodeFps: +((encFrames / dtSec) || 0).toFixed(2),
    emuFps: hostFrameDelta != null ? +((hostFrameDelta / dtSec) || 0).toFixed(2) : null,
    frameNumWindow: hostFrameDelta,
    framesEncoded: hostOut.framesEncoded ?? null,
    framesEncodedWindow: encFrames,
    avgEncodeMs: encFrames ? +((encTime / encFrames) * 1000).toFixed(2) : null,
    keyFramesEncoded: hostOut.keyFramesEncoded ?? null,
    bytesSent: hostOut.bytesSent ?? null,
    sendKbps: hostOut.bytesSent != null && hostFirst.pcs[0]?.outbound?.bytesSent != null ? +((delta(hostFirst.pcs[0].outbound.bytesSent, hostOut.bytesSent) * 8 / dtSec / 1000)).toFixed(0) : null,
    framesPerSecondGauge: hostOut.framesPerSecond ?? null,
    resolution: hostFirst.canvas ? `${hostFirst.canvas.w}x${hostFirst.canvas.h}` : null,
    canvas: hostFirst.canvas,
  };
  const guest = {
    displayFps: +displayFps.toFixed(2),
    displayFpsSource: rvfcFps != null ? 'requestVideoFrameCallback (3 s)' : 'getVideoPlaybackQuality delta',
    decodedFps: +decodedFps.toFixed(2),
    emuFps: delta(guestFirst.frameNum, guestLast.frameNum) != null ? +((delta(guestFirst.frameNum, guestLast.frameNum) / dtSec) || 0).toFixed(2) : null,
    frameNumWindow: delta(guestFirst.frameNum, guestLast.frameNum),
    totalVideoFramesWindow: videoFrames,
    droppedVideoFramesWindow: videoDropped,
    droppedPct: presentationLostPct != null ? presentationLostPct : pct(videoDropped, videoFrames),
    droppedBasis: presentationLostPct != null ? 'decoded fps - presented fps (rVFC); headless has no compositor, so getVideoPlaybackQuality reports every frame dropped' : 'getVideoPlaybackQuality',
    video: guestOverlay ? { w: guestOverlay.w, h: guestOverlay.h, readyState: guestOverlay.readyState, paused: guestOverlay.paused, currentTime: guestOverlay.currentTime } : null,
    videoAdvanceSec: guestOverlay && guestFirst.video ? +(guestOverlay.currentTime - guestFirst.video.currentTime).toFixed(3) : null,
    rvfc,
    counts: {
      total: guestPlay.totalVideoFrames ?? null,
      dropped: guestPlay.droppedVideoFrames ?? null,
      corrupted: guestPlay.corruptedVideoFrames ?? null,
    },
    coreFrameNum: { first: guestFirst.frameNum, last: guestLast.frameNum },
  };

  const result = {
    schema: SCHEMA,
    label: LABEL,
    tier: TIER,
    generatedAt: new Date().toISOString(),
    durationMs: Date.now() - t0,
    target: { base: BASE, url: GAME_URL, room: ROOM, seconds: SECONDS, headless: true, viewport: '1280x900', profile: PROFILE },
    env: {
      platform: `${os.platform()} ${os.release()}`, hostname: os.hostname(),
      cpu: (os.cpus()[0] || {}).model || null, cpuCount: os.cpus().length,
      ramGB: +(os.totalmem() / 1073741824).toFixed(1), node: process.version, browser: browserVersion,
      note: `headless Chromium${SWIFTSHADER ? ' with --use-angle=swiftshader: host encode is CPU-rendered' : ' on the default GPU path'}, not an RTX measurement`,
    },
    boot: { hostMs: hostBootMs, guestMs: guestBootMs, hostRomBytes: rom.host, guestRomBytes: rom.guest },
    window: { seconds: +dtSec.toFixed(2), samples: samples.length, start: new Date(sampleStart).toISOString(), end: new Date(sampleEnd).toISOString(), visibility: { host: hostLast.visibility ?? null, guest: guestLast.visibility ?? null } },
    host,
    guest,
    net,
    stream: {
      pinnedCaptureRate: 30,
      captureSource: 'EJS 4.3.0-pre netplay initWebRTCStream(): canvas.captureStream(30)',
      hostEncodeFps: host.encodeFps,
      guestDecodedFps: net.inbound.decodedFps,
      guestPresentedFps: guest.displayFps,
      codec: net.codec?.mimeType ?? null,
      note: 'the 30 fps ceiling is upstream of the transport; a 60 fps change must raise capture and encode together',
    },
    first: { host: hostFirst, guest: guestFirst },
    last: { host: hostLast, guest: guestLast },
    sampleTail: samples.slice(-3),
    console: logs,
  };
  result.checks = evaluateChecks(result, TIER);
  result.outcome = {
    pass: result.checks.every((c) => c.pass !== false),
    evaluated: result.checks.filter((c) => c.pass != null).length,
    skipped: result.checks.filter((c) => c.pass == null).length,
    failed: result.checks.filter((c) => c.pass === false).map((c) => c.id),
  };
  const outPath = path.join(OUT, `bench-netplay-${LABEL}.json`);
  fs.writeFileSync(outPath, JSON.stringify(result, null, 2));

  console.log('');
  console.log(`BENCH NETPLAY  ${LABEL}  room=${ROOM}  ${result.durationMs} ms`);
  console.log(`  boot      host ${hostBootMs} ms   guest ${guestBootMs} ms   rom ${rom.host ?? '?'} / ${rom.guest ?? '?'} B`);
  console.log(`  codec     ${net.codec?.mimeType || 'n/a'}   pc host=${net.pcStates.host} guest=${net.pcStates.guest} dc=${net.pcStates.dataChannel}`);
  console.log(`  host      emu ${host.emuFps ?? 'n/a'} fps  encode ${host.encodeFps} fps  ${host.sendKbps ?? 'n/a'} kbps  avgEnc ${host.avgEncodeMs ?? 'n/a'} ms  limit=${net.qualityLimitation.last}`);
  console.log(`  guest     display ${guest.displayFps} fps (${guest.displayFpsSource})  decoded ${net.inbound.decodedFps} fps  dropped ${guest.droppedPct ?? 'n/a'}%  video ${guest.video?.w}x${guest.video?.h} rs=${guest.video?.readyState} advance=${guest.videoAdvanceSec}s`);
  console.log(`  stream    pinned capture ${result.stream.pinnedCaptureRate} fps  codec ${result.stream.codec ?? 'n/a'}`);
  console.log(`  network   rtt ${net.rttMs ?? 'n/a'} ms  jbuf ${net.jitterBufferDelayMs ?? 'n/a'} ms  loss ${net.inbound.packetLossPct ?? 'n/a'}%  jitter ${net.inbound.jitterMs ?? 'n/a'} ms  avail ${net.availableOutgoingBitrateMbps ?? 'n/a'} Mbps`);
  console.log(`  rVFC      ${rvfc.supported ? rvfc.frames + ' frames in ' + rvfc.ms + ' ms (' + rvfc.fps + ' fps)' : 'unsupported'}`);
  console.log('');
  for (const c of result.checks) {
    const mark = c.pass === true ? 'PASS' : c.pass === false ? 'FAIL' : 'SKIP';
    console.log(`  ${mark.padEnd(4)} ${String(c.id).padEnd(9)} ${String(c.metric).padEnd(38)} ${String(c.actual ?? 'n/a').padStart(9)} ${c.op} ${c.value}${c.unit || ''}`);
  }
  console.log(`\n  ${result.outcome.pass ? 'OK' : 'THRESHOLD FAIL'}  ${result.outcome.evaluated} evaluated, ${result.outcome.skipped} skipped${result.outcome.failed.length ? ', failed: ' + result.outcome.failed.join(',') : ''}`);
  console.log(`  WROTE ${outPath}`);
  if (STRICT && !result.outcome.pass) process.exitCode = 1;

  // Leave cleanly so the relay does not sweep a dead room during the next run.
  for (const p of [hostPage, guestPage]) {
    await p.evaluate(() => { try { window.__R4NET.leaveRoom(); } catch { /* ignore */ } }).catch(() => {});
  }
} catch (e) {
  console.error('BENCH NETPLAY FAILED', e);
  process.exitCode = 1;
} finally {
  await browser.close().catch(() => {});
}
