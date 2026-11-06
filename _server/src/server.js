import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import express from 'express';
import compression from 'compression';
import QRCode from 'qrcode';
import { WebSocketServer } from 'ws';
import { GameManager } from './game.js';
import { StreamManager } from './stream.js';
import { Room } from './room.js';
import { attachMmo, mmoStatusHandler } from './mmo.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..');
const config = JSON.parse(fs.readFileSync(path.resolve(rootDir, 'config.json'), 'utf8'));
// Ports: 8080 HTTP cabinet (always on, compatibility), 8443 HTTPS when
// RR4_TLS=1 (opt-in; secure context: SAB/threads, storage.persist,
// getDisplayMedia, service workers), 3010 netplay relay (separate process,
// advertised by /api/netplay-config so the page never hardcodes it).
const httpPort = Number(process.env.RR4_PORT || config.httpPort || 8080);

// Throwaway instances (harnesses, probes, a second copy) must never launch the
// native cabinet: with `autoRestart` on, a game that exits immediately would
// reopen a Ridge Racer window every few seconds. Only the canonical port
// autostarts unless the operator explicitly asks for it.
if (httpPort !== 8080 && process.env.RR4_NO_AUTOSTART === undefined) {
  process.env.RR4_NO_AUTOSTART = '1';
}
const tlsRequested = process.env.RR4_TLS === '1' || config.tls?.enabled === true;
const tlsPort = Number(process.env.RR4_TLS_PORT || config.tls?.port || 8443);
const tlsCertFile = path.resolve(rootDir, process.env.RR4_TLS_CERT || config.tls?.cert || 'certs/rr4-cert.pem');
const tlsKeyFile = path.resolve(rootDir, process.env.RR4_TLS_KEY || config.tls?.key || 'certs/rr4-key.pem');
const relayPort = Number(process.env.RR4_RELAY_PORT || config.netplay?.relayPort || 3010);
const relayOverride = String(process.env.RR4_RELAY_URL || config.netplay?.relayUrl || '').trim().replace(/\/+$/, '');

const app = express();
app.disable('x-powered-by');
// Strong (not `W/`) validator on every generated body. Static files get an
// explicit strong tag in their `setHeaders` (see strongEtag()): a weak ETag is
// illegal in If-Range, and a client that echoes the strong form of a weak tag
// measured a full 357,817,282-byte 200 instead of a 206.
app.set('etag', 'strong');
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  next();
});
// Text assets only (bro ≈ 107 KB vs 426 KB for emulator.min.js, ~75 % off the
// app JS). The disc (/rom/*.chd|bin), BIOS, music and ghosts are already
// dense; compressing them would burn CPU and break byte-exact Range semantics,
// so both the path list and any Range request skip the transform.
const COMPRESSIBLE_TYPE = /^(?:text\/[a-z0-9.+-]+|application\/(?:javascript|json|manifest\+json|xml)|image\/svg\+xml)(?:;|$)/i;
app.use(compression({
  threshold: 1024,
  brotli: { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 8 } },
  filter(req, res) {
    if (req.headers.range) return false;
    if (/^\/(?:rom|bios|music|ghosts)(?:\/|$)/.test(req.path || '')) return false;
    if (req.path && /^\/(?:ws|mp|stream)(?:\/|$)/.test(req.path)) return false;
    const type = res.getHeader('Content-Type');
    return Boolean(type) && COMPRESSIBLE_TYPE.test(String(type));
  },
}));
// ---- native browser emulator (EmulatorJS, no video stream) ----
// /play runs PCSX-ReARMed fully client-side. The disc image and BIOS are
// served as static files; the EmulatorJS release is self-hosted under
// public/emulator/data. COOP/COEP are scoped to this feature only so the
// existing streamed arcade page is untouched.
const romDir = path.resolve(rootDir, '..', 'disc');
const biosDir = path.resolve(rootDir, 'game', 'bios');
const emulatorDir = path.resolve(rootDir, 'public', 'emulator');
// Pinned EmulatorJS 4.3.0-pre nightly snapshot used only by the netplay page.
// The stable single-player page keeps using /emulator/data (4.2.3).
const emulator43Dir = path.resolve(rootDir, 'netplay', 'ejs-data-nightly');
// Zudoku field manual (built with basePath "/docs").
const docsDir = path.resolve(rootDir, '..', 'docs', 'dist', 'docs');
// Music library: audio files plus a generated manifest. The manifest is
// rewritten by scripts/build-music-manifest.mjs when the library changes.
const musicDir = path.resolve(rootDir, 'public', 'music');
const musicManifestPath = path.join(musicDir, 'manifest.json');

function nativeAssetHeaders(res, maxAgeSec) {
  res.setHeader('Cache-Control', `public, max-age=${maxAgeSec}, immutable`);
  // Allow the COEP-isolated /play document to embed these same-origin files
  // even when the page is opened through a different host alias.
  res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
  res.setHeader('Access-Control-Allow-Origin', '*');
}

// Strong opaque validator derived from size+mtime. `serve-static`/`send` only
// stamps its own ETag when the header is still empty, so setting it from
// `setHeaders` (res, path, stat) makes every static mount strong with no extra
// stat call. Both `"…"` and `W/"…"` then satisfy send's If-Range check, so
// nothing that echoed the old weak tag regresses.
function strongEtag(stat) {
  if (!stat || typeof stat.size !== 'number') return null;
  return `"${Number(stat.size).toString(16)}-${Math.floor(Number(stat.mtimeMs) || 0).toString(16)}"`;
}

function setStrongEtag(res, stat) {
  const tag = strongEtag(stat);
  if (tag) res.setHeader('ETag', tag);
}

function setStrongEtagForFile(res, filePath) {
  try { setStrongEtag(res, fs.statSync(filePath)); } catch { /* missing file -> 404 later */ }
}

// COOP/COEP only produce crossOriginIsolated on a trustworthy origin, and the
// frame only isolates when EVERY ancestor sends them too. That is why the
// shell pages (/ , /welcome, /games, /multiplayer) use the same gate as /play.
// On plain-HTTP LAN the headers do nothing and Chromium logs an "ignored"
// error, so they stay loopback/https-only.
// COEP choice: `credentialless`, not `require-corp`. Both isolate the embedded
// /play frame once every document the shell can frame sends COEP: measured on
// Chromium 156, `/docs/introduction` and `/lobby` were blocked outright
// (net::ERR_BLOCKED_BY_RESPONSE) under a COEP shell until they were added to
// ISOLATED_DOCUMENT below; after that both values pass with zero request
// failures. credentialless is preferred because it drops the CORP requirement
// for no-cors subresources, so one future cross-origin embed cannot
// white-screen the shell, and this app has no cookies or credentialed requests
// (all ACAO: *) — the credentialless trade-off costs nothing. `require-corp` is
// a one-line revert if a browser pairing ever needs it; see
// _runtime/analysis/08-server-edge.md.
function isTrustworthyOrigin(req) {
  return Boolean(req.secure) ||
    /^(localhost|127\.0\.0\.1|\[::1\]|::1)$/i.test(req.hostname || '');
}

function applyIsolationHeaders(req, res) {
  if (!isTrustworthyOrigin(req)) return false;
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader('Cross-Origin-Embedder-Policy', 'credentialless');
  res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  return true;
}

// Every document the shell can load into its iframe must carry the same
// COOP/COEP as the shell, or Chromium blocks the nested document outright
// (measured: /docs/introduction and /lobby -> net::ERR_BLOCKED_BY_RESPONSE
// inside a COEP shell). Keep this list in sync with the view list in
// public/js/enter.js (/welcome, /games, /multiplayer, /play, /play-net,
// /docs, /lobby, /music).
const ISOLATED_DOCUMENT = /^\/(?:$|(?:welcome|games|multiplayer|lobby|play|play-net|music)(?:\/|\.html|$)|docs(?:\/|$))/;
app.use((req, res, next) => {
  if (ISOLATED_DOCUMENT.test(req.path || '/')) applyIsolationHeaders(req, res);
  next();
});

function sendShellDocument(req, res, file) {
  const abs = path.resolve(rootDir, 'public', file);
  setStrongEtagForFile(res, abs);
  res.setHeader('Cache-Control', 'no-cache');
  res.sendFile(abs);
}

// Registered before the public/ static handler so /play, /play-net and the
// HTML aliases all get the isolation headers the threaded core needs.
function sendPlayDocument(req, res, file) {
  applyIsolationHeaders(req, res);
  const abs = path.resolve(rootDir, 'public', file);
  setStrongEtagForFile(res, abs);
  res.setHeader('Cache-Control', 'no-cache');
  res.sendFile(abs);
}

app.get(['/play', '/play/', '/play.html'], (req, res) => {
  // /play?netplay=1 is the same-origin netplay entry point. The default
  // (no query) stays on the verified 4.2.3 single-player page.
  const netplay = String(req.query.netplay || '') === '1' ||
    String(req.query.netplay || '').toLowerCase() === 'true';
  sendPlayDocument(req, res, netplay ? 'play-net.html' : 'play.html');
});

app.get(['/play-net', '/play-net/', '/play-net.html'], (req, res) => {
  sendPlayDocument(req, res, 'play-net.html');
});

// Default cabinet entry: the R4 login gate owns the audio element and keeps it
// alive while the iframe navigates to /play, /docs or /lobby.
app.get(['/', '/enter', '/enter/', '/enter.html'], (req, res) => {
  sendShellDocument(req, res, 'enter.html');
});

// The original lobby + host-stream fallback remains available as /lobby.
// It gets the same COOP/COEP as the rest of the shell so the frame can hold it
// (jsmpeg itself only needs a websocket).
app.get(['/lobby', '/lobby/', '/lobby.html'], (req, res) => {
  sendShellDocument(req, res, 'index.html');
});

// Welcome to Ridge City: the first view after ENTER.
app.get(['/welcome', '/welcome/', '/welcome.html'], (req, res) => {
  sendShellDocument(req, res, 'welcome.html');
});

// Machine check: all three discs and their specs.
app.get(['/games', '/games/', '/games.html'], (req, res) => {
  sendShellDocument(req, res, 'games.html');
});

// 2P head-to-head lobby (create/join code, teams, both-ready, random grid).
app.get(['/multiplayer', '/multiplayer/', '/multiplayer.html'], (req, res) => {
  sendShellDocument(req, res, 'multiplayer.html');
});

// Race Day: 50-driver MMO room (one event, one shared clock, live standings).
// Same headers as /play - no-cache + the COOP/COEP the embedded shell needs.
app.get(['/race-day', '/race-day/', '/race-day.html'], (req, res) => {
  sendPlayDocument(req, res, 'mmo.html');
});

// Self-hosted EmulatorJS release. Registered before public/ so the long-lived
// cache policy below wins over the generic 1h static policy.
app.use('/emulator', express.static(emulatorDir, {
  etag: true,
  lastModified: true,
  acceptRanges: true,
  setHeaders(res, filePath, stat) {
    setStrongEtag(res, stat);
    const rel = path.relative(emulatorDir, filePath).split(path.sep).join('/');
    // Cores and shaders are large and immutable for a pinned release.
    if (rel.startsWith('data/cores/') || rel.startsWith('data/localization/') || rel.endsWith('.wasm')) {
      nativeAssetHeaders(res, 31536000);
    } else if (rel === 'data/loader.js' || rel === 'data/emulator.min.js' || rel === 'data/emulator.min.css' || rel === 'data/version.json') {
      res.setHeader('Cache-Control', 'public, max-age=86400');
      res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
    } else {
      nativeAssetHeaders(res, 604800);
    }
  },
}));

// Pinned 4.3.0-pre data for netplay. Kept separate from /emulator/data so the
// stable 4.2.3 single-player path can never be affected by a netplay change.
app.use('/emulator43/data', express.static(emulator43Dir, {
  etag: true,
  lastModified: true,
  acceptRanges: true,
  setHeaders(res, filePath, stat) {
    setStrongEtag(res, stat);
    const rel = path.relative(emulator43Dir, filePath).split(path.sep).join('/');
    if (rel.startsWith('cores/') || rel.startsWith('localization/') || rel.endsWith('.wasm')) {
      nativeAssetHeaders(res, 31536000);
    } else if (rel === 'loader.js' || rel === 'emulator.min.js' || rel === 'emulator.min.css' || rel === 'version.json') {
      res.setHeader('Cache-Control', 'public, max-age=86400');
      res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
    } else {
      nativeAssetHeaders(res, 604800);
    }
  },
}));

// Zudoku writes section redirect stubs as `<section>.html`, but the matching
// `<section>/` directory makes serve-static answer `/docs/<section>` with a 301
// to the directory first, and that directory has no index.html (404). Serve the
// documented section URLs explicitly so they land on the same first page as the
// stub. Trailing-slash variants are covered too.
const DOCS_SECTION_PAGES = {
  '/docs/games': '/docs/games/ridge-racer-type-4',
  '/docs/play': '/docs/play/browser',
  '/docs/multiplayer': '/docs/multiplayer/lan',
};
for (const [from, to] of Object.entries(DOCS_SECTION_PAGES)) {
  app.get([from, `${from}/`], (req, res) => res.redirect(301, to));
}

// The manual's index.html is a client redirect to /docs/introduction. Give the
// bare section URL a server 301 instead, so a fresh visitor does not need JS to
// land on the manual (and /docs/ does not 404 behind the directory redirect).
app.get(['/docs', '/docs/'], (req, res) => res.redirect(301, '/docs/introduction'));

// Zudoku field manual: static site generated at docs/dist/docs with
// basePath "/docs". `extensions: ['html']` makes the clean URLs work.
app.use('/docs', express.static(docsDir, {
  etag: true,
  lastModified: true,
  index: 'index.html',
  extensions: ['html'],
  maxAge: '1h',
  setHeaders(res, filePath, stat) {
    setStrongEtag(res, stat);
    if (filePath.endsWith('.html')) {
      res.setHeader('Cache-Control', 'no-cache');
    }
    res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
  },
}));

// Music library. Registered before the generic public/ handler so audio gets
// Range support and the same cross-origin policy as /rom and /bios. The
// manifest itself stays revalidatable so a rebuild is visible immediately.
app.get('/api/music', (req, res) => {
  let raw;
  try {
    raw = fs.readFileSync(musicManifestPath, 'utf8');
  } catch (e) {
    if (e.code === 'ENOENT') {
      return res.status(404).json({ ok: false, error: 'music manifest missing' });
    }
    return res.status(500).json({ ok: false, error: 'music manifest unreadable' });
  }
  res.setHeader('Cache-Control', 'no-cache');
  try {
    res.json(JSON.parse(raw.replace(/^\uFEFF/, '')));
  } catch {
    res.status(500).json({ ok: false, error: 'music manifest invalid' });
  }
});

// Netplay relay address for /play-net. This endpoint is the TLS-aware,
// same-origin source of truth; the page may keep its legacy
// `http://<hostname>:3010` default until it is switched over (play-net.js is
// owned by another change). Override with `netplay.relayUrl` in config.json or
// RR4_RELAY_URL (e.g. a same-origin reverse-proxied path or wss:// URL);
// `netplay.relayPort` / RR4_RELAY_PORT only change the derived port.
app.get('/api/netplay-config', (req, res) => {
  const hostHeader = String(req.headers.host || '');
  const hostname = hostHeader.replace(/:\d+$/, '') || 'localhost';
  const protocol = req.secure ? 'https' : 'http';
  const relayUrl = relayOverride || `${protocol}://${hostname}:${relayPort}`;
  res.setHeader('Cache-Control', 'no-cache');
  res.json({
    relayUrl,
    relayPort,
    secure: Boolean(req.secure),
    protocol,
    sameOrigin: Boolean(relayOverride) && /^\/(?!\/)/.test(relayOverride),
    socketPath: '/socket.io',
    gameIds: { r4: 4, rage: 5, ridge: 6 },
  });
});

app.use('/music', express.static(musicDir, {
  etag: true,
  lastModified: true,
  acceptRanges: true,
  fallthrough: true,
  index: false,
  setHeaders(res, filePath, stat) {
    setStrongEtag(res, stat);
    const rel = path.relative(musicDir, filePath).split(path.sep).join('/');
    if (rel === 'manifest.json') {
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
      res.setHeader('Access-Control-Allow-Origin', '*');
      return;
    }
    nativeAssetHeaders(res, 604800);
  },
}));

app.use(express.static(path.resolve(rootDir, 'public'), {
  etag: true,
  maxAge: '1h',
  setHeaders(res, filePath, stat) {
    setStrongEtag(res, stat);
    if (filePath.endsWith('.html')) res.setHeader('Cache-Control', 'no-cache');
    // The disc manifest is read at boot and served here; a stale copy would
    // announce tracks/cars the server no longer rolls.
    if (filePath.endsWith('mp-games.json')) res.setHeader('Cache-Control', 'no-cache');
    // App scripts and styles change with every session; revalidate them so a
    // player never keeps an old shell/macro for an hour. EmulatorJS assets are
    // mounted above with their own long-lived policy.
    if (/\.(js|css)$/.test(filePath)) res.setHeader('Cache-Control', 'no-cache');
    if (filePath.endsWith('jsmpeg.js')) res.setHeader('Cache-Control', 'public, max-age=86400');
  },
}));

// Disc images: 621 MB+, must keep Range support for resumable/partial reads.
app.use('/rom', express.static(romDir, {
  etag: true,
  lastModified: true,
  acceptRanges: true,
  fallthrough: true,
  setHeaders(res, filePath, stat) { setStrongEtag(res, stat); nativeAssetHeaders(res, 604800); },
}));

// ---- LAN ghost/replay exchange -----------------------------------------
// Short WebM clips captured from the live canvas. They are intentionally
// stored as media, not as emulator save states, so any browser can watch a
// LAN player's ghost run while racing.
const ghostsDir = path.resolve(rootDir, 'ghosts');
fs.mkdirSync(ghostsDir, { recursive: true });
const ghostIndexPath = path.join(ghostsDir, 'index.json');
function readGhosts() {
  try { return JSON.parse(fs.readFileSync(ghostIndexPath, 'utf8')); } catch { return []; }
}
function writeGhosts(list) {
  fs.writeFileSync(ghostIndexPath, JSON.stringify(list, null, 2));
}
app.get('/api/ghosts', (req, res) => {
  const game = String(req.query.game || '').toLowerCase();
  const list = readGhosts()
    .filter((g) => !game || g.game === game)
    .sort((a, b) => b.createdAt - a.createdAt)
    .map((g) => ({ ...g, url: '/ghosts/' + encodeURIComponent(g.file) }));
  res.json({ ghosts: list });
});
app.post('/api/ghosts', express.raw({ type: 'video/webm', limit: '80mb' }), (req, res) => {
  if (!req.body || !req.body.length) return res.status(400).json({ error: 'empty body' });
  const game = String(req.query.game || 'r4').toLowerCase().replace(/[^a-z0-9_-]/g, '').slice(0, 16) || 'r4';
  const name = String(req.query.name || 'LAN GHOST').replace(/[\r\n]/g, ' ').slice(0, 48);
  const id = Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 7);
  const file = id + '.webm';
  fs.writeFileSync(path.join(ghostsDir, file), req.body);
  const list = readGhosts();
  const rec = { id, file, game, name, createdAt: Date.now(), size: req.body.length };
  list.push(rec);
  writeGhosts(list);
  res.json({ ok: true, ghost: { ...rec, url: '/ghosts/' + encodeURIComponent(file) } });
});
app.use('/ghosts', express.static(ghostsDir, {
  etag: true,
  lastModified: true,
  acceptRanges: true,
  setHeaders(res, filePath, stat) {
    setStrongEtag(res, stat);
    res.setHeader('Cache-Control', 'public, max-age=3600');
  },
}));

app.use('/bios', express.static(biosDir, {
  etag: true,
  lastModified: true,
  acceptRanges: true,
  fallthrough: true,
  setHeaders(res, filePath, stat) { setStrongEtag(res, stat); nativeAssetHeaders(res, 604800); },
}));

const game = new GameManager({ config, rootDir });
const stream = new StreamManager({ config, rootDir });
const room = new Room({ name: config.roomName });
const server = http.createServer(app);
// A ~40-request boot fan-out should not re-handshake because the player idled
// on the disc deck: Node's 5 s default keep-alive is far too short.
server.keepAliveTimeout = 65000;
server.headersTimeout = 66000;
// Opt-in TLS. Imported lazily and never generated at boot: a missing/invalid
// cert logs one line and the cabinet keeps serving plain HTTP on :8080.
let tlsServer = null;
let tlsReason = '';
if (tlsRequested) {
  try {
    const { default: https } = await import('node:https');
    const [key, cert] = [fs.readFileSync(tlsKeyFile), fs.readFileSync(tlsCertFile)];
    tlsServer = https.createServer({ key, cert, minVersion: 'TLSv1.2' }, app);
    tlsServer.keepAliveTimeout = 65000;
    tlsServer.headersTimeout = 66000;
  } catch (e) {
    tlsServer = null;
    tlsReason = e?.code === 'ENOENT'
      ? `missing ${path.relative(rootDir, e.path || tlsCertFile)} - run scripts/make-cert.ps1`
      : (e?.message || String(e));
  }
}
const lobbyWss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 });
const streamWss = new WebSocketServer({ noServer: true });
// Shell 2P lobby: create/join code, team select, both-ready gate, random grid.
const mpWss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 });
const mpRooms = new Map();
// /mp heartbeat: a dead socket must not keep a player slot or a room forever.
const MP_HEARTBEAT_MS = 20000;
// Rooms idle this long with only dead sockets are dropped from the lobby.
const MP_STALE_ROOM_MS = 5 * 60 * 1000;
const MP_TEAMS = ['Solvalou', 'Pac Racing Club', 'Micro Mouse Mappy', 'Dig Racing Team'];
// Multi-disc contract: public/mp-games.json is the single source of truth for
// discs, modes, tracks and cars. The browser fetches the same static file, so
// the server must roll from it too - a room may never announce a disc, track or
// car the page cannot map. A missing/invalid manifest is a boot failure, not a
// silent R4 fallback.
const MP_GAMES_FILE = path.resolve(rootDir, 'public', 'mp-games.json');
const MP_GAMES = (() => {
  const fail = (why) => { throw new Error(`mp-games.json invalid (${why}): ${MP_GAMES_FILE}`); };
  let raw;
  try {
    raw = fs.readFileSync(MP_GAMES_FILE, 'utf8');
  } catch (e) {
    throw new Error(`mp-games.json missing: ${MP_GAMES_FILE} (${e?.message || String(e)})`);
  }
  let parsed;
  try {
    parsed = JSON.parse(raw.replace(/^\uFEFF/, ''));
  } catch (e) {
    throw new Error(`mp-games.json unparseable: ${MP_GAMES_FILE} (${e?.message || String(e)})`);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) fail('not an object');
  const games = parsed.games;
  if (!games || typeof games !== 'object' || Array.isArray(games)) fail('no games map');
  const keys = Object.keys(games);
  if (!keys.length) fail('empty games map');
  for (const key of keys) {
    const g = games[key];
    if (!g || typeof g !== 'object') fail(`game ${key} is not an object`);
    if (!Array.isArray(g.tracks) || !g.tracks.length) fail(`game ${key} has no tracks`);
    if (!Array.isArray(g.cars) || !g.cars.length) fail(`game ${key} has no cars`);
    if (!g.tracks.every((t) => t && typeof t.name === 'string')) fail(`game ${key} has a track without a name`);
    if (!g.cars.every((c) => c && typeof c.name === 'string')) fail(`game ${key} has a car without a name`);
    if (typeof g.mode !== 'string' || typeof g.modeLabel !== 'string') fail(`game ${key} has no mode`);
  }
  if (!games[parsed.defaultGame] || typeof parsed.defaultGame !== 'string') {
    fail(`defaultGame ${String(parsed.defaultGame)} is not in games`);
  }
  return parsed;
})();
const MP_GAME_KEYS = Object.freeze(Object.keys(MP_GAMES.games));
const MP_DEFAULT_GAME = MP_GAMES.defaultGame;
// Manifest entry for a key, or the default game for an unknown key.
function mpGame(key) {
  return MP_GAMES.games[key] || MP_GAMES.games[MP_DEFAULT_GAME];
}
// Whitelisted key exactly as it appears in the manifest, else null. Never
// trust client text: a room stores only a manifest key.
function mpGameKey(key) {
  const k = String(key == null ? '' : key).trim().toLowerCase();
  return MP_GAME_KEYS.includes(k) ? k : null;
}
// Ghost (Route A) room flags. `drive` picks the mode: `live` is the untouched
// shared-car path, `ghost` is turn-based time trial. `turn` names which seat
// drives this run (only meaningful in ghost mode). Both are whitelisted keys,
// never trusted text, and default to `live`/`host` so a room created without
// them behaves exactly as before. The server never flips the turn itself - the
// game page flips it on rematch and passes it back through the lounge URL.
const MP_DRIVE_MODES = Object.freeze(['live', 'ghost']);
const MP_TURNS = Object.freeze(['host', 'guest']);
const MP_DEFAULT_DRIVE = 'live';
const MP_DEFAULT_TURN = 'host';
function mpDriveKey(value) {
  const v = String(value == null ? '' : value).trim().toLowerCase();
  return MP_DRIVE_MODES.includes(v) ? v : null;
}
function mpTurnKey(value) {
  const v = String(value == null ? '' : value).trim().toLowerCase();
  return MP_TURNS.includes(v) ? v : null;
}

const startedAt = Date.now();
let shuttingDown = false;
let lastUncaught = null;
const logLines = [];
function log(...args) {
  const line = args.join(' ');
  logLines.push(`[${new Date().toISOString()}] ${line}`);
  if (logLines.length > 400) logLines.shift();
  console.log(line);
}

function lanUrls() {
  const out = [];
  for (const [name, list] of Object.entries(os.networkInterfaces())) {
    for (const info of list || []) {
      if (info.family !== 'IPv4' || info.internal) continue;
      if (info.address.startsWith('169.254.')) continue;
      out.push({ name, address: info.address, url: `http://${info.address}:${httpPort}/` });
    }
  }
  const score = (u) => {
    if (/tailscale|vpn/i.test(u.name)) return 2;
    if (/^(WLAN|Wi-?Fi|Ethernet)/i.test(u.name)) return 0;
    return u.address.startsWith('192.168.') || /^10\./.test(u.address) ? 0 : 1;
  };
  return out.sort((a, b) => score(a) - score(b) || a.address.localeCompare(b.address));
}

function cabinetStatus() {
  let gameStatus;
  let streamStatus;
  try { gameStatus = game.status(); } catch (e) {
    gameStatus = { state: 'error', error: e.message };
  }
  try { streamStatus = stream.stats(); } catch (e) {
    streamStatus = { running: false, error: e.message };
  }
  return {
    game: gameStatus,
    stream: streamStatus,
    uptimeSec: Math.floor((Date.now() - startedAt) / 1000),
    urls: lanUrls(),
    split: config.split || 'vertical',
    log: logLines.slice(-40),
  };
}

function stateFor(clientId, cabinet) {
  return {
    type: 'state',
    room: room.state(clientId),
    cabinet: cabinet || cabinetStatus(),
    serverTime: Date.now(),
  };
}

function send(ws, obj) {
  if (ws.readyState === 1) {
    try { ws.send(JSON.stringify(obj)); } catch { /* ignore */ }
  }
}

function broadcastLobby(obj) {
  if (shuttingDown) return;
  let cabinet = null;
  for (const ws of lobbyWss.clients) {
    if (ws.readyState !== 1 || !ws.clientId) continue;
    try {
      if (obj.type === 'state') {
        if (!cabinet) cabinet = cabinetStatus();
        send(ws, stateFor(ws.clientId, cabinet));
      } else {
        send(ws, obj);
      }
    } catch (e) {
      log('broadcast failed:', e?.message || String(e));
    }
  }
}

function broadcastState() {
  broadcastLobby({ type: 'state' });
}

function broadcastChat(msg) {
  if (!msg) return;
  broadcastLobby({ type: 'chat', message: msg });
}

function sanitizeMask(mask) {
  const n = Number(mask);
  return Number.isFinite(n) ? (n & 0xFFFF) : 0xFFFF;
}

function validClientId(id) {
  return typeof id === 'string' && /^[A-Za-z0-9_-]{6,64}$/.test(id);
}

// ---- lobby websocket ----
function handleLobbyMessage(ws, msg) {
  if (!msg || typeof msg.type !== 'string') return;

  if (msg.type === 'join') {
    const id = validClientId(msg.clientId) ? msg.clientId : `c_${Math.random().toString(36).slice(2, 12)}`;
    const old = ws.clientId;
    if (old && old !== id) room.disconnect(old);
    ws.clientId = id;
    room.join(id, msg.name);
    send(ws, { type: 'welcome', clientId: id, roomName: config.roomName, split: config.split || 'vertical' });
    broadcastState();
    return;
  }

  if (!ws.clientId) {
    send(ws, { type: 'error', message: 'join first' });
    return;
  }
  const client = room.clients.get(ws.clientId);
  if (client) client.lastSeen = Date.now();

  switch (msg.type) {
    case 'seat': {
      const res = room.takeSeat(ws.clientId, msg.seat);
      if (!res.ok) { send(ws, { type: 'error', message: res.error }); return; }
      game.applyInput(res.seat, 0xFFFF);
      broadcastState();
      broadcastLobby({ type: 'toast', message: `${client?.name || 'DRIVER'} took P${res.seat}`, tone: 'info' });
      break;
    }
    case 'leaveSeat': {
      const seat = room.seatOf(ws.clientId);
      if (seat) {
        game.applyInput(seat, 0xFFFF);
        room.leaveSeat(ws.clientId);
        broadcastState();
      }
      break;
    }
    case 'ready': {
      room.setReady(ws.clientId, !!msg.value);
      broadcastState();
      break;
    }
    case 'input': {
      const seat = room.seatOf(ws.clientId);
      if (!seat) return;
      const now = Date.now();
      if (now - ws.lastInputAt < 4) return; // ~250 Hz cap
      ws.lastInputAt = now;
      ws.inputCount++;
      game.applyInput(seat, sanitizeMask(msg.mask));
      break;
    }
    case 'start': {
      const seat = room.seatOf(ws.clientId);
      if (!seat && ws.clientId !== room.hostId) return;
      if (room.phase === 'countdown') return;
      startSequence();
      break;
    }
    case 'restart': {
      if (ws.clientId !== room.hostId) { send(ws, { type: 'error', message: 'host only' }); return; }
      if (room.phase === 'countdown') return;
      room.setPhase('lobby');
      for (const s of [1, 2]) if (room.seats[s]) room.seats[s].ready = false;
      game.applyInput(1, 0xFFFF);
      game.applyInput(2, 0xFFFF);
      broadcastLobby({ type: 'toast', message: 'Cabinet restarting…', tone: 'warn' });
      broadcastState();
      game.restart().catch((e) => log('restart failed', e.message));
      break;
    }
    case 'chat': {
      const msgOut = room.chatMessage(ws.clientId, msg.text);
      if (msgOut) broadcastChat(msgOut);
      break;
    }
    case 'ping': {
      send(ws, { type: 'pong', t: msg.t, serverTime: Date.now() });
      break;
    }
    case 'resync': {
      send(ws, stateFor(ws.clientId));
      break;
    }
    case 'rumbleTest': {
      broadcastLobby({ type: 'rumble', clientId: ws.clientId, duration: 350 });
      break;
    }
    default:
      break;
  }
}

lobbyWss.on('connection', (ws) => {
  ws.isAlive = true;
  ws.lastInputAt = 0;
  ws.inputCount = 0;
  ws.on('pong', () => { ws.isAlive = true; });
  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString('utf8')); } catch { return; }
    try {
      handleLobbyMessage(ws, msg);
    } catch (e) {
      log('lobby message failed:', e?.stack || e?.message || String(e));
      send(ws, { type: 'error', message: 'server error' });
    }
  });

  ws.on('close', () => {
    try {
      if (!ws.clientId) return;
      const seat = room.seatOf(ws.clientId);
      if (seat) game.applyInput(seat, 0xFFFF);
      room.disconnect(ws.clientId);
      broadcastState();
    } catch (e) {
      log('lobby close failed:', e?.message || String(e));
    }
  });
  ws.on('error', () => {});
});

// ---- video websocket ----
streamWss.on('connection', (ws) => {
  stream.addClient(ws);
});

// ---- shell 2P lobby websocket ----
const MP_CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
function mpCode() {
  let out = '';
  for (let i = 0; i < 4; i++) out += MP_CODE_CHARS[Math.floor(Math.random() * MP_CODE_CHARS.length)];
  return out;
}
function mpSend(ws, message) {
  if (!ws || !message) return;
  try { if (ws.readyState === 1) ws.send(JSON.stringify(message)); } catch { /* ignore */ }
}
function mpRoomState(room) {
  const g = mpGame(room.game);
  return {
    type: 'room',
    code: room.code,
    host: room.host,
    started: room.started,
    game: g.key,
    mode: g.mode,
    modeLabel: g.modeLabel,
    drive: room.drive,
    turn: room.turn,
    trackSelection: g.trackSelect,
    track: room.track || null,
    cars: room.cars || null,
    players: room.players.map((p) => ({
      id: p.id, name: p.name, ready: !!p.ready, team: p.team,
      role: p.id === room.host ? 'host' : 'guest',
    })),
  };
}
function mpBroadcast(room, extra) {
  for (const p of room.players) {
    if (extra) mpSend(p.ws, { ...extra, role: p.id === room.host ? 'host' : 'guest' });
    mpSend(p.ws, mpRoomState(room));
  }
}
function mpList() {
  return [...mpRooms.values()]
    .filter((r) => !r.started && r.players.length < 2)
    .map((r) => {
      const g = mpGame(r.game);
      return {
        code: r.code,
        host: (r.players.find((p) => p.id === r.host) || {}).name || 'HOST',
        players: r.players.length,
        max: 2,
        game: g.key,
        mode: g.mode,
        drive: r.drive,
      };
    });
}
function mpPick(list, seed) {
  return list[Math.abs(seed) % list.length];
}
function mpTouch(room) {
  if (room) room.lastSeen = Date.now();
}
// Room lists change for every lobby client, not just the two players in a room.
function mpBroadcastRooms() {
  if (shuttingDown) return;
  let payload = null;
  for (const ws of mpWss.clients) {
    if (!ws.mp) continue;
    if (!payload) payload = { type: 'rooms', rooms: mpList() };
    mpSend(ws, payload);
  }
}
// Drop rooms that have been idle for a while and whose sockets are all gone
// (backgrounded tab, crashed host, network drop that never sent a close frame).
function mpDropStaleRooms() {
  const now = Date.now();
  let dropped = false;
  for (const room of [...mpRooms.values()]) {
    if (now - (room.lastSeen || 0) < MP_STALE_ROOM_MS) continue;
    if (room.players.some((p) => p.ws && p.ws.readyState === 1)) continue;
    for (const p of room.players) if (p.ws?.mp) p.ws.mp.room = null;
    mpRooms.delete(room.code);
    dropped = true;
    log(`mp room ${room.code} dropped (stale)`);
  }
  return dropped;
}
mpWss.on('connection', (ws) => {
  ws.isAlive = true;
  ws.mp = { id: Math.random().toString(36).slice(2, 10), ws, name: 'PLAYER', room: null, ready: false, team: MP_TEAMS[0] };
  mpSend(ws, { type: 'hello', id: ws.mp.id, rooms: mpList() });
  ws.on('pong', () => { ws.isAlive = true; });

  const roomFor = () => (ws.mp.room ? mpRooms.get(ws.mp.room) : null);
  const leave = () => {
    const room = roomFor();
    if (!room) return;
    room.players = room.players.filter((p) => p !== ws.mp);
    ws.mp.room = null;
    ws.mp.ready = false;
    if (!room.players.length) {
      mpRooms.delete(room.code);
    } else {
      if (room.host === ws.mp.id) room.host = room.players[0].id;
      room.started = false;
      room.track = null;
      room.cars = null;
      for (const p of room.players) p.ready = false;
      mpBroadcast(room);
    }
    ws.mp.room = null;
  };

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString('utf8')); } catch { return; }
    const type = String(msg.type || '');
    mpTouch(roomFor());
    try {
      if (type === 'ping') {
        mpSend(ws, { type: 'pong', at: Date.now() });
        return;
      }
      if (type === 'list') {
        mpSend(ws, { type: 'rooms', rooms: mpList() });
        return;
      }
      if (type === 'create') {
        leave();
        let code = String(msg.code || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 4);
        if (!code) do { code = mpCode(); } while (mpRooms.has(code));
        if (mpRooms.has(code)) {
          // A rematch asks for the same code again. If the old room only holds
          // dead sockets (the tabs already moved to /play-net), reclaim the code
          // instead of silently rolling a new one; a live room still wins.
          const existing = mpRooms.get(code);
          const anyLive = existing.players.some((p) => p.ws && p.ws.readyState === 1);
          if (anyLive) code = mpCode();
          else mpRooms.delete(code);
        }
        const room = {
          code,
          game: mpGameKey(msg.game) || MP_DEFAULT_GAME,
          // Ghost/Route A flags travel with the room, so a guest always sees the
          // host's mode and this run's driver. Unknown values fall back to the
          // live default instead of rejecting the create.
          drive: mpDriveKey(msg.drive) || MP_DEFAULT_DRIVE,
          turn: mpTurnKey(msg.turn) || MP_DEFAULT_TURN,
          host: ws.mp.id,
          players: [],
          started: false,
          track: null,
          cars: null,
          lastSeen: Date.now(),
        };
        mpRooms.set(code, room);
        ws.mp.name = String(msg.name || 'PLAYER').slice(0, 20) || 'PLAYER';
        ws.mp.ready = false;
        ws.mp.room = code;
        room.players.push(ws.mp);
        mpSend(ws, { type: 'joined', code, role: 'host', id: ws.mp.id });
        mpBroadcast(room);
        mpBroadcastRooms();
        return;
      }
      if (type === 'join') {
        const code = String(msg.code || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 4);
        const room = mpRooms.get(code);
        if (!room) { mpSend(ws, { type: 'error', message: 'Room not found' }); return; }
        if (room.started) { mpSend(ws, { type: 'error', message: 'Race already started' }); return; }
        mpTouch(room);
        const mine = room.players.find((p) => p.id === ws.mp.id);
        if (mine) {
          mpSend(ws, { type: 'joined', code, role: mine.id === room.host ? 'host' : 'guest', id: ws.mp.id });
          mpBroadcast(room);
          return;
        }
        if (room.players.length >= 2) { mpSend(ws, { type: 'error', message: 'Room full' }); return; }
        leave();
        // The room's disc wins: a guest's own `game` is ignored, so both seats
        // always see the plan the host created. Same for `drive`/`turn`: the
        // guest adopts the room's values so both seats agree on this run's mode
        // and driver before the grid locks.
        ws.mp.name = String(msg.name || 'PLAYER').slice(0, 20) || 'PLAYER';
        ws.mp.ready = false;
        ws.mp.room = code;
        room.players.push(ws.mp);
        mpSend(ws, { type: 'joined', code, role: 'guest', id: ws.mp.id });
        mpBroadcast(room);
        mpBroadcastRooms();
        return;
      }
      if (type === 'ready') {
        const room = roomFor();
        if (!room || room.started) return;
        ws.mp.ready = !!msg.ready;
        if (room.players.length === 2 && room.players.every((p) => p.ready)) {
          const seed = Date.now();
          const g = mpGame(room.game);
          const trackIndex = Math.abs(seed + room.code.charCodeAt(0)) % g.tracks.length;
          room.started = true;
          room.raceId = room.code + '-' + seed.toString(36) + '-' + Math.random().toString(36).slice(2, 6);
          room.trackIndex = trackIndex;
          room.track = g.tracks[trackIndex].name;
          room.cars = room.players.map((p, i) => {
            const carIndex = Math.abs((seed >> (i * 3)) + i) % g.cars.length;
            return {
              id: p.id, name: p.name, role: p.id === room.host ? 'host' : 'guest',
              team: p.team || MP_TEAMS[(seed + i) % MP_TEAMS.length],
              car: g.cars[carIndex].name, carIndex,
            };
          });
          mpBroadcast(room, {
            type: 'race', code: room.code, raceId: room.raceId,
            track: room.track, trackIndex, cars: room.cars,
            game: g.key, mode: g.mode, guestPlayerIndex: g.guestPlayerIndex,
            drive: room.drive, turn: room.turn,
            trackSelection: g.trackSelect,
            trackCount: g.tracks.length, carCount: g.cars.length,
          });
        } else {
          mpBroadcast(room);
        }
        return;
      }
      if (type === 'team') {
        const room = roomFor();
        if (!room) return;
        if (MP_TEAMS.includes(String(msg.team))) ws.mp.team = String(msg.team);
        mpBroadcast(room);
        return;
      }
      if (type === 'setgame') {
        // Host swaps the disc before the grid locks. A different disc has
        // different tracks/cars, so the old plan must be dropped instead of
        // being re-announced against the new manifest entry.
        const room = roomFor();
        if (!room) { mpSend(ws, { type: 'error', message: 'Join a room first' }); return; }
        if (room.host !== ws.mp.id) { mpSend(ws, { type: 'error', message: 'Only the host can change the disc' }); return; }
        if (room.started) { mpSend(ws, { type: 'error', message: 'Disc cannot change after the grid locks' }); return; }
        const key = mpGameKey(msg.game);
        if (!key) { mpSend(ws, { type: 'error', message: 'Unknown disc' }); return; }
        room.game = key;
        room.track = null;
        room.cars = null;
        mpBroadcast(room);
        mpBroadcastRooms();
        return;
      }
      if (type === 'drive' || type === 'turn') {
        // Host-only, pre-lock only. `drive` swaps the mode, `turn` names this
        // run's driver; neither touches the disc plan. A mode change is not a
        // plan change, so track/cars stay - the plan is rolled in `ready`.
        const room = roomFor();
        const field = type;
        if (!room) { mpSend(ws, { type: 'error', message: 'Join a room first' }); return; }
        if (room.host !== ws.mp.id) {
          mpSend(ws, { type: 'error', message: 'Only the host can change DRIVE/TURN' });
          return;
        }
        if (room.started) { mpSend(ws, { type: 'error', message: 'Grid is locked' }); return; }
        if (field === 'drive') {
          const drive = mpDriveKey(msg.drive);
          if (!drive) { mpSend(ws, { type: 'error', message: 'Unknown drive mode' }); return; }
          room.drive = drive;
        } else {
          const turn = mpTurnKey(msg.turn);
          if (!turn) { mpSend(ws, { type: 'error', message: 'Unknown turn' }); return; }
          room.turn = turn;
        }
        mpBroadcast(room);
        mpBroadcastRooms();
        return;
      }
      if (type === 'leave') {
        leave();
        mpSend(ws, { type: 'left', rooms: mpList() });
        mpBroadcastRooms();
      }
    } catch (e) {
      log('mp message failed:', e?.message || String(e));
      mpSend(ws, { type: 'error', message: 'Server error' });
    }
  });

  ws.on('close', () => {
    try {
      leave();
      mpBroadcastRooms();
    } catch (e) {
      log('mp close failed:', e?.message || String(e));
    }
  });
  ws.on('error', () => {});
});

// Socket.IO-style heartbeat: every silent socket gets terminated, which runs the
// close handler above (drop the player, promote the guest, delete empty rooms).
const mpHeartbeatTimer = setInterval(() => {
  if (shuttingDown) return;
  for (const ws of mpWss.clients) {
    if (ws.isAlive === false) {
      try { ws.terminate(); } catch { /* ignore */ }
      continue;
    }
    ws.isAlive = false;
    try { ws.ping(); } catch { /* ignore */ }
  }
  if (mpDropStaleRooms()) mpBroadcastRooms();
}, MP_HEARTBEAT_MS);
mpHeartbeatTimer.unref?.();
mpWss.on('close', () => clearInterval(mpHeartbeatTimer));

function handleUpgrade(req, socket, head) {
  try {
    if (shuttingDown) { socket.destroy(); return; }
    const url = new URL(req.url || '/', 'http://localhost');
    if (url.pathname === '/ws') {
      lobbyWss.handleUpgrade(req, socket, head, (ws) => lobbyWss.emit('connection', ws, req));
    } else if (url.pathname === '/mp') {
      mpWss.handleUpgrade(req, socket, head, (ws) => mpWss.emit('connection', ws, req));
    } else if (url.pathname === '/stream') {
      streamWss.handleUpgrade(req, socket, head, (ws) => streamWss.emit('connection', ws, req));
    } else {
      socket.destroy();
    }
  } catch (e) {
    log('upgrade failed:', e?.message || String(e));
    try { socket.destroy(); } catch { /* ignore */ }
  }
}
// Same upgrade paths on both listeners: under RR4_TLS=1 the page derives
// `wss://` (multiplayer.js) and must still reach /mp, /ws and /stream.
server.on('upgrade', handleUpgrade);
tlsServer?.on('upgrade', handleUpgrade);
// Race Day (/mmo). Attached after the /mp upgrade handler above so its
// dispatcher can delegate every other path to it unchanged.
attachMmo({ server, tlsServer });

app.get('/api/status', (req, res) => {
  res.json({
    ok: true,
    room: room.state(null),
    cabinet: cabinetStatus(),
    serverTime: Date.now(),
  });
});
app.get('/api/health', (req, res) => {
  res.json({
    ok: !shuttingDown,
    game: game.state,
    stream: !!stream.ffmpeg,
    viewers: stream.clients.size,
    attached: game.attached,
    source: stream.testMode ? 'test' : 'capture',
    uptimeSec: Math.floor((Date.now() - startedAt) / 1000),
    lastUncaught,
  });
});
// Race Day load/probe surface: {ok, event, counts, uptimeSec, clients, p50BroadcastMs}.
app.get('/api/mmo/status', mmoStatusHandler);

// Dynamic join QR: defaults to the first LAN address, or ?url=... for a
// specific host. The landing page uses the static public/img/lan-qr.svg.
app.get('/qr.svg', async (req, res) => {
  try {
    const url = String(req.query.url || lanUrls()[0]?.url || `http://localhost:${httpPort}/`);
    const svg = await QRCode.toString(url, {
      type: 'svg', margin: 1, width: 256,
      color: { dark: '#08090d', light: '#ffffff' },
    });
    res.type('image/svg+xml').send(svg);
  } catch {
    res.status(500).type('text/plain').send('qr failed');
  }
});

// ---- countdown / start ----
let countdownTimer = null;
function startSequence() {
  if (countdownTimer || shuttingDown) return;
  // After the first launch, START is also the menu/confirm button. Do not
  // replay the 3-2-1 countdown every time a player advances a menu.
  if (room.phase === 'race') {
    game.tapStart(1).catch((e) => log('start tap failed:', e.message));
    return;
  }
  room.setPhase('countdown', 3);
  broadcastState();
  let n = 3;
  countdownTimer = setInterval(async () => {
    try {
      if (n > 0) {
        broadcastLobby({ type: 'countdown', value: n });
        n--;
        return;
      }
      clearInterval(countdownTimer);
      countdownTimer = null;
      room.setPhase('race');
      broadcastLobby({ type: 'countdown', value: 0 });
      broadcastLobby({ type: 'rumble', duration: 500 });
      try {
        await game.tapStart(1);
        await new Promise(r => setTimeout(r, 420));
        await game.tapStart(2);
      } catch (e) {
        log('start tap failed', e.message);
      }
      broadcastState();
    } catch (e) {
      log('countdown failed:', e?.message || String(e));
      if (countdownTimer) { clearInterval(countdownTimer); countdownTimer = null; }
    }
  }, 1000);
}

// ---- events ----
game.on('state', () => broadcastState());
game.on('capture', (rect) => {
  try { stream.setCaptureRect(rect); } catch (e) { log('capture rect failed:', e.message); }
});
game.on('ready', () => {
  log('cabinet window ready');
  const rect = game.captureRect();
  if (rect) stream.setCaptureRect(rect);
  broadcastLobby({ type: 'toast', message: 'Cabinet online — press START', tone: 'good' });
  broadcastState();
});
game.on('exit', (info) => {
  log(`cabinet exited code=${info.code}`);
  room.setPhase('lobby');
  broadcastLobby({ type: 'cabinet', state: 'restarting' });
  broadcastState();
});
game.on('log', (line) => {
  if (logLines[logLines.length - 1] !== line) log(line);
});
stream.on('log', (line) => log(line));
stream.on('viewers', (n) => broadcastLobby({ type: 'viewers', viewers: n }));
stream.on('down', () => {
  broadcastLobby({ type: 'stream', state: 'reconnecting' });
  broadcastState();
});

// ---- start ----
server.listen(httpPort, config.host, async () => {
  const urls = lanUrls();
  log(`RIDGE RACER TYPE 4 LAN cabinet listening on :${httpPort}`);
  for (const u of urls) log(`  ${u.url}  (${u.name})`);
  log(`  http://localhost:${httpPort}/`);
  if (process.env.RR4_NO_AUTOSTART !== '1') {
    try {
      if (process.env.RR4_ATTACH === '1' || config.game.attach) {
        log('attaching to the running cabinet window');
        await game.attachExisting();
      } else {
        await game.start();
      }
    } catch (e) {
      log('game start failed:', e.message);
    }
  } else {
    log('autostart disabled (RR4_NO_AUTOSTART=1)');
  }  try {
    await stream.start();
  } catch (e) {
    log('stream start failed:', e.message);
  }
});

server.on('error', (e) => {
  log('http server error:', e?.message || String(e));
  if (e?.code === 'EADDRINUSE') shutdown('EADDRINUSE').catch(() => process.exit(1));
});

if (tlsServer) {
  tlsServer.listen(tlsPort, config.host, () => {
    log(`TLS cabinet listening on :${tlsPort} (secure origin: SAB, storage.persist, capture)`);
    for (const u of lanUrls()) log(`  https://${u.address}:${tlsPort}/  (${u.name})`);
    log(`  https://localhost:${tlsPort}/`);
  });
  tlsServer.on('error', (e) => {
    log(`https server error on :${tlsPort}:`, e?.message || String(e));
  });
} else if (tlsRequested) {
  log(`RR4_TLS=1 but HTTPS is off (${tlsReason || 'unknown reason'}) - plain HTTP :${httpPort} is unaffected`);
}

// ---- keepalive ----
const keepaliveTimer = setInterval(() => {
  if (shuttingDown) return;
  for (const ws of lobbyWss.clients) {
    if (ws.isAlive === false) { ws.terminate(); continue; }
    ws.isAlive = false;
    try { ws.ping(); } catch { /* ignore */ }
  }
  broadcastState();
}, 5000);
keepaliveTimer.unref?.();

// ---- shutdown ----
async function shutdown(reason = 'signal') {
  if (shuttingDown) return;
  shuttingDown = true;
  log(`shutting down (${reason})`);
  clearInterval(keepaliveTimer);
  clearInterval(mpHeartbeatTimer);
  if (countdownTimer) { clearInterval(countdownTimer); countdownTimer = null; }

  for (const ws of lobbyWss.clients) {
    try { ws.close(1001, 'server shutdown'); } catch { /* ignore */ }
  }
  for (const ws of mpWss.clients) {
    try { ws.close(1001, 'server shutdown'); } catch { /* ignore */ }
  }
  for (const ws of streamWss.clients) {
    try { ws.close(1001, 'server shutdown'); } catch { /* ignore */ }
  }
  try { lobbyWss.close(); } catch { /* ignore */ }
  try { mpWss.close(); } catch { /* ignore */ }
  try { streamWss.close(); } catch { /* ignore */ }

  await Promise.allSettled([game.stop(), stream.stop()]);

  try {
    if (!server.listening && !tlsServer?.listening) {
      process.exit(0);
      return;
    }
    let open = 0;
    const done = () => {
      if (--open > 0) return;
      log('http server closed');
      process.exit(0);
    };
    for (const s of [server, tlsServer]) {
      if (!s?.listening) continue;
      open++;
      s.close(done);
    }
    const kill = setTimeout(() => {
      for (const s of [server, tlsServer]) {
        try { s?.closeAllConnections?.(); } catch { /* ignore */ }
      }
    }, 250);
    kill.unref?.();
    const force = setTimeout(() => process.exit(0), 4000);
    force.unref?.();
  } catch {
    process.exit(0);
  }
}

process.on('SIGINT', () => { shutdown('SIGINT').catch(() => process.exit(1)); });
process.on('SIGTERM', () => { shutdown('SIGTERM').catch(() => process.exit(1)); });
process.on('SIGBREAK', () => { shutdown('SIGBREAK').catch(() => process.exit(1)); });
process.on('uncaughtException', (e) => {
  lastUncaught = { message: e?.message || String(e), at: Date.now() };
  log('uncaught', e?.stack || e?.message || String(e));
});
process.on('unhandledRejection', (e) => {
  lastUncaught = { message: e?.message || String(e), at: Date.now() };
  log('unhandled', e?.stack || String(e));
});

