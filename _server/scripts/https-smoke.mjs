#!/usr/bin/env node
// https-smoke.mjs — edge/header smoke test for the R4 cabinet server.
//
// Usage:
//   node scripts/https-smoke.mjs                        # http://127.0.0.1:8080
//   node scripts/https-smoke.mjs http://127.0.0.1:8095  # throwaway instance
//   node scripts/https-smoke.mjs https://127.0.0.1:8444 # TLS instance (self-signed ok)
//
// Proves, against a real socket: strong ETag + Range/If-Range/If-None-Match,
// Accept-Ranges/Content-Range/immutable/CORP on the disc, brotli/gzip on text
// assets with Vary, keep-alive 65 s, COOP/COEP on the game document and its
// shell ancestors, /api/netplay-config, the docs redirect table, /api/music,
// /api/health and the /mp websocket upgrade.
//
// Exit code 0 = every check passed.

import http from 'node:http';
import https from 'node:https';
import zlib from 'node:zlib';
import { WebSocket } from 'ws';

const base = (process.argv[2] || 'http://127.0.0.1:8080').replace(/\/+$/, '');
const target = new URL(base);
const secure = target.protocol === 'https:';
const transport = secure ? https : http;
const agent = new transport.Agent({ keepAlive: true });
const insecure = { rejectUnauthorized: false };

let pass = 0;
const failures = [];
function check(name, ok, detail = '') {
  if (ok) { pass++; console.log(`PASS ${name}${detail ? ' — ' + detail : ''}`); }
  else { failures.push(name); console.log(`FAIL ${name}${detail ? ' — ' + detail : ''}`); }
}

function request(path, { method = 'GET', headers = {}, body = null, readBody = false } = {}) {
  return new Promise((resolve, reject) => {
    const opts = {
      method,
      headers,
      agent,
      ...(secure ? insecure : {}),
    };
    const req = transport.request(base + path, opts, (res) => {
      const chunks = [];
      res.on('data', (c) => { if (readBody) chunks.push(c); });
      res.on('end', () => resolve({
        status: res.statusCode,
        headers: res.headers,
        raw: res.rawHeaders,
        body: Buffer.concat(chunks),
      }));
    });
    req.setTimeout(8000, () => req.destroy(new Error('timeout ' + path)));
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

const strong = (tag) => Boolean(tag) && tag.startsWith('"') && tag.endsWith('"');
const has = (res, name) => Boolean(res.headers[name]);

// ---- 1. game document + shell ancestors ----------------------------------
const play = await request('/play', { readBody: true });
check('GET /play 200', play.status === 200, `status=${play.status}`);
check('/play cache-control no-cache', /no-cache/.test(play.headers['cache-control'] || ''));
const shell = await request('/', { readBody: true });
check('GET / 200', shell.status === 200, `status=${shell.status}`);
const trustworthy = secure || /^(localhost|127\.0\.0\.1|\[::1\])$/.test(target.hostname);
if (trustworthy) {
  for (const [label, res] of [['/play', play], ['/', shell]]) {
    check(`${label} COOP same-origin`, res.headers['cross-origin-opener-policy'] === 'same-origin');
    check(`${label} COEP credentialless`, res.headers['cross-origin-embedder-policy'] === 'credentialless',
      res.headers['cross-origin-embedder-policy']);
  }
  for (const path of ['/welcome', '/games', '/multiplayer']) {
    const r = await request(path, { readBody: true });
    check(`GET ${path} 200`, r.status === 200, `status=${r.status}`);
    check(`${path} COOP`, r.headers['cross-origin-opener-policy'] === 'same-origin');
    check(`${path} COEP`, r.headers['cross-origin-embedder-policy'] === 'credentialless',
      r.headers['cross-origin-embedder-policy']);
  }
} else {
  check('LAN plain-HTTP shell sends no COOP/COEP (documented no-op)', !has(shell, 'cross-origin-opener-policy'));
}

// ---- 2. disc transport: strong ETag, Range, If-Range, 304 ----------------
const disc = await request('/rom/r4.chd', { method: 'HEAD' });
const discTag = disc.headers.etag;
check('HEAD /rom/r4.chd 200', disc.status === 200, `status=${disc.status}`);
check('/rom ETag is strong', strong(discTag), String(discTag));
check('/rom Accept-Ranges: bytes', disc.headers['accept-ranges'] === 'bytes');
check('/rom Cache-Control immutable', /immutable/.test(disc.headers['cache-control'] || ''), disc.headers['cache-control']);
check('/rom CORP cross-origin', disc.headers['cross-origin-resource-policy'] === 'cross-origin');

const range = await request('/rom/r4.chd', { headers: { Range: 'bytes=0-99' } });
check('Range 0-99 -> 206', range.status === 206, `status=${range.status}`);
check('Content-Range present', /^bytes 0-99\/\d+$/.test(range.headers['content-range'] || ''), range.headers['content-range']);

const ifRange = await request('/rom/r4.chd', { headers: { Range: 'bytes=0-99', 'If-Range': discTag } });
check('If-Range(strong served tag) -> 206', ifRange.status === 206, `status=${ifRange.status} len=${ifRange.headers['content-length']}`);

const legacy = await request('/rom/r4.chd', { headers: { Range: 'bytes=0-99', 'If-Range': `W/${discTag}` } });
check('If-Range(weak form of same tag) -> 206', legacy.status === 206, `status=${legacy.status}`);

const notModified = await request('/rom/r4.chd', { headers: { 'If-None-Match': discTag } });
check('If-None-Match(served tag) -> 304', notModified.status === 304, `status=${notModified.status}`);

const bytesRange = await request('/rom/r4.chd', {
  headers: { Range: 'bytes=999999999-', 'Accept-Encoding': 'br' },
});
check('Range unsatisfiable -> 416', bytesRange.status === 416, `status=${bytesRange.status}`);
check('/rom is never content-encoded', !bytesRange.headers['content-encoding']);

// ---- 3. compression ------------------------------------------------------
const br = await request('/emulator/data/emulator.min.js', {
  headers: { 'Accept-Encoding': 'br' },
  readBody: true,
});
check('brotli: Content-Encoding br', br.headers['content-encoding'] === 'br', br.headers['content-encoding']);
check('brotli: Vary Accept-Encoding', /accept-encoding/i.test(br.headers.vary || ''), br.headers.vary);
check('brotli: body < 200 KB', br.body.length > 1024 && br.body.length < 200 * 1024, `${br.body.length} B`);
if (br.headers['content-encoding'] === 'br') {
  const inflated = zlib.brotliDecompressSync(br.body);
  check('brotli: decompresses to the raw file', inflated.length === 426343, `${inflated.length} B`);
}

const gz = await request('/js/play.js', { headers: { 'Accept-Encoding': 'gzip' }, readBody: true });
const plainJs = await request('/js/play.js', { readBody: true });
check('gzip: Content-Encoding gzip', gz.headers['content-encoding'] === 'gzip', gz.headers['content-encoding']);
check('gzip: smaller than raw js', gz.body.length < plainJs.body.length, `${gz.body.length} B < ${plainJs.body.length} B`);

// ---- 4. keep-alive -------------------------------------------------------
const ka = String(play.headers['keep-alive'] || '');
check('Keep-Alive timeout >= 60 s', /timeout=(6[0-9]|[7-9][0-9]|\d{3,})/.test(ka), ka || '(absent)');
if (play.headers.connection) check('Connection: keep-alive', play.headers.connection === 'keep-alive', play.headers.connection);

// ---- 5. netplay config endpoint -----------------------------------------
const netplay = await request('/api/netplay-config', { readBody: true });
let np = null;
try { np = JSON.parse(netplay.body.toString('utf8')); } catch { /* reported below */ }
check('GET /api/netplay-config 200', netplay.status === 200, `status=${netplay.status}`);
check('netplay relayUrl derives from request origin',
  Boolean(np?.relayUrl) && np.relayUrl.startsWith(`${secure ? 'https' : 'http'}://${target.hostname}:`), np?.relayUrl);
check('netplay game ids 4/5/6', np?.gameIds?.r4 === 4 && np?.gameIds?.rage === 5 && np?.gameIds?.ridge === 6);

// ---- 6. docs-contract routes --------------------------------------------
const docs = await request('/docs');
check('/docs -> 301 /docs/introduction', docs.status === 301 && docs.headers.location === '/docs/introduction',
  `${docs.status} ${docs.headers.location}`);
for (const [from, to] of Object.entries({
  '/docs/games': '/docs/games/ridge-racer-type-4',
  '/docs/play': '/docs/play/browser',
  '/docs/multiplayer': '/docs/multiplayer/lan',
})) {
  const r = await request(from);
  check(`${from} -> 301 ${to}`, r.status === 301 && r.headers.location === to, `${r.status} ${r.headers.location}`);
}

// ---- 7. app endpoints ----------------------------------------------------
const music = await request('/api/music', { readBody: true });
check('GET /api/music 200', music.status === 200, `status=${music.status}`);
check('/api/music is JSON', /application\/json/.test(music.headers['content-type'] || ''));
const health = await request('/api/health', { readBody: true });
check('GET /api/health 200', health.status === 200, `status=${health.status}`);

// ---- 8. /mp websocket upgrade still works -------------------------------
const wsUrl = `${secure ? 'wss' : 'ws'}://${target.host}${target.pathname.replace(/\/$/, '')}/mp`;
const wsResult = await new Promise((resolve) => {
  let settled = false;
  const done = (v) => { if (!settled) { settled = true; resolve(v); } };
  const ws = new WebSocket(wsUrl, secure ? { rejectUnauthorized: false } : {});
  const timer = setTimeout(() => { try { ws.terminate(); } catch { /* ignore */ } done('timeout'); }, 5000);
  ws.on('open', () => { clearTimeout(timer); try { ws.close(); } catch { /* ignore */ } done('open'); });
  ws.on('error', (e) => { clearTimeout(timer); done(e?.message || 'error'); });
});
check('/mp upgrade opens', wsResult === 'open', String(wsResult));

agent.destroy();
console.log('');
console.log(`${pass} passed, ${failures.length} failed${failures.length ? ': ' + failures.join(', ') : ''}`);
process.exit(failures.length ? 1 : 0);
