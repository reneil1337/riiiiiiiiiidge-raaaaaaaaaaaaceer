#!/usr/bin/env node
// Build public/music/manifest.json from the per-game tracks.json files.
//
// Run from anywhere:
//   node scripts/build-music-manifest.mjs
//   npm run music:manifest        (only if that script has been added)
//
// Source layout (all optional):
//   public/music/r4/tracks.json
//   public/music/rage/tracks.json
//   public/music/ridge/tracks.json
//   public/music/r4-xa/tracks.json      extra tracks folded into r4
//   public/music/titles.json            optional game/track title overrides
//
// tracks.json may be an array, { "tracks": [...] }, { "tracks": { id: ... } },
// or a top-level map of track objects. Track fields id/title/file/duration/kind
// are carried into the manifest; other fields are ignored. Missing audio files
// are dropped with a warning so the manifest never advertises a 404.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const serverDir = path.resolve(scriptDir, '..');
const musicRoot = path.join(serverDir, 'public', 'music');
const manifestPath = path.join(musicRoot, 'manifest.json');

const GAMES = [
  { key: 'r4', title: 'Ridge Racer Type 4', theme: 'r4' },
  { key: 'rage', title: 'Rage Racer', theme: 'rage' },
  { key: 'ridge', title: 'Ridge Racer', theme: 'ridge' },
];
const XA_KEY = 'r4-xa';
const MAX_INDEX = Number.MAX_SAFE_INTEGER;
const AUDIO_RE = /\.(?:mp3|ogg|oga|m4a|aac|wav|flac|opus|webm|xa)$/i;
const warnings = [];

function warn(message) {
  warnings.push(message);
  console.warn(`WARN  ${message}`);
}

function readJson(filePath, label) {
  let text;
  try {
    text = fs.readFileSync(filePath, 'utf8');
  } catch (e) {
    if (e.code !== 'ENOENT') warn(`${label}: ${e.message}`);
    return null;
  }
  try {
    return JSON.parse(text.replace(/^\uFEFF/, ''));
  } catch (e) {
    warn(`${label}: invalid JSON (${e.message})`);
    return null;
  }
}

function isObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function mapEntriesToTracks(value) {
  if (Array.isArray(value)) return value;
  if (!isObject(value)) return [];
  return Object.entries(value).map(([id, entry]) => {
    if (typeof entry === 'string') return { id, file: entry };
    if (isObject(entry)) return entry.id == null ? { id, ...entry } : entry;
    return null;
  }).filter(Boolean);
}

// Accept the common hand-written shapes without guessing at arbitrary JSON.
function extractTrackList(data) {
  if (Array.isArray(data)) return data;
  if (!isObject(data)) return [];
  if (data.file != null || data.src != null || data.path != null || data.url != null) return [data];
  if (Array.isArray(data.tracks)) return data.tracks;
  if (Array.isArray(data.playlist)) return data.playlist;
  if (isObject(data.tracks)) return mapEntriesToTracks(data.tracks);
  if (isObject(data.playlist)) return mapEntriesToTracks(data.playlist);
  if (Array.isArray(data.items)) return data.items;

  const metaKeys = new Set(['key', 'game', 'title', 'name', 'theme', 'generatedAt', 'version']);
  const entries = Object.entries(data).filter(([key]) => !metaKeys.has(key));
  if (entries.length && entries.every(([, value]) => isObject(value) || typeof value === 'string')) {
    return mapEntriesToTracks(Object.fromEntries(entries));
  }
  return [];
}

function numericIndex(value) {
  if (value == null || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function indexFromName(value) {
  const match = String(value || '').match(/^(\d{1,4})(?:\D|$)/);
  return match ? Number(match[1]) : null;
}

function fileStem(file) {
  const clean = String(file || '').split(/[?#]/, 1)[0].replace(/\\/g, '/');
  const base = clean.slice(clean.lastIndexOf('/') + 1);
  const dot = base.lastIndexOf('.');
  return dot > 0 ? base.slice(0, dot) : base;
}

function isIntroTrack(raw, id, file) {
  const kind = String(raw.kind || raw.type || raw.role || '').toLowerCase();
  if (kind === 'intro' || kind === 'opening') return true;
  return /(?:^|[-_\s])(intro|opening)(?:[-_\s]|$)/i.test(String(id || fileStem(file)));
}

function resolveAudioFile(file, gameKey) {
  let decoded = String(file || '').trim();
  if (!decoded || /^(?:[a-z]+:)?\/\//i.test(decoded)) return null;
  try {
    decoded = decodeURIComponent(decoded);
  } catch {
    // Leave malformed escapes as-is; the existence check will decide.
  }
  const normalized = decoded.replace(/\\/g, '/').replace(/[?#].*$/, '');
  const candidates = [];

  if (normalized.startsWith('/music/')) {
    candidates.push(path.resolve(musicRoot, normalized.slice('/music/'.length)));
  } else if (normalized.startsWith('music/')) {
    candidates.push(path.resolve(musicRoot, normalized.slice('music/'.length)));
  } else if (normalized.startsWith(`${gameKey}/`)) {
    candidates.push(path.resolve(musicRoot, normalized));
  } else if (normalized.startsWith('/')) {
    candidates.push(path.resolve(musicRoot, normalized.slice(1)));
  } else {
    // Prefer a file next to its tracks.json, then the library root.
    candidates.push(path.resolve(musicRoot, gameKey, normalized));
    candidates.push(path.resolve(musicRoot, normalized));
  }

  if (path.isAbsolute(normalized)) candidates.push(path.resolve(normalized));

  for (const candidate of candidates) {
    const rel = path.relative(musicRoot, candidate);
    if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) continue;
    try {
      if (fs.statSync(candidate).isFile()) return candidate;
    } catch {
      // Try the next candidate.
    }
  }
  return null;
}

function normalizeTrack(raw, gameKey) {
  if (typeof raw === 'string') raw = { file: raw };
  if (!isObject(raw)) return null;

  const fileRaw = raw.file ?? raw.src ?? raw.path ?? raw.url;
  if (fileRaw == null || !String(fileRaw).trim()) {
    warn(`${gameKey}: dropping track without a file field`);
    return null;
  }
  const file = String(fileRaw).trim();
  const resolved = resolveAudioFile(file, gameKey);
  if (!resolved) {
    warn(`${gameKey}: missing file, dropped: ${file}`);
    return null;
  }

  const fallbackId = fileStem(file) || path.basename(resolved);
  const id = raw.id != null && String(raw.id).trim() ? String(raw.id) : fallbackId;
  const kind = raw.kind != null && String(raw.kind).trim()
    ? String(raw.kind)
    : (isIntroTrack(raw, id, file) ? 'intro' : 'track');
  const index = numericIndex(raw.index ?? raw.order ?? raw.trackNo ?? raw.track_no ?? raw.no)
    ?? indexFromName(id)
    ?? indexFromName(fileStem(file));

  return {
    record: {
      id,
      title: raw.title != null && String(raw.title).trim() ? String(raw.title) : id,
      file,
      duration: raw.duration ?? raw.length ?? raw.seconds ?? null,
      kind,
    },
    index,
    intro: kind.toLowerCase() === 'intro' || kind.toLowerCase() === 'opening',
  };
}

function discoverAudioFiles(gameDir, gameKey) {
  const found = [];
  function walk(dir) {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.isFile() && AUDIO_RE.test(entry.name)) {
        const rel = path.relative(gameDir, full).split(path.sep).join('/');
        const stem = fileStem(rel);
        found.push({
          id: stem,
          title: stem.replace(/[-_]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()),
          file: `${gameKey}/${rel}`,
          kind: isIntroTrack({}, stem, rel) ? 'intro' : 'track',
        });
      }
    }
  }
  walk(path.join(musicRoot, gameKey));
  return found;
}

function loadGame(key, fallbackTitle, fallbackTheme) {
  const gameDir = path.join(musicRoot, key);
  const data = readJson(path.join(gameDir, 'tracks.json'), `${key}/tracks.json`);
  // No tracks.json yet (common while audio is being extracted): use the audio
  // files themselves so the API still has something playable to advertise.
  const source = data == null ? discoverAudioFiles(gameDir, key) : extractTrackList(data);
  const normalized = [];
  for (const raw of source) {
    const track = normalizeTrack(raw, key);
    if (track) normalized.push(track);
  }
  return {
    key,
    title: isObject(data) && typeof data.title === 'string' && data.title.trim()
      ? data.title.trim()
      : fallbackTitle,
    theme: isObject(data) && typeof data.theme === 'string' && data.theme.trim()
      ? data.theme.trim()
      : fallbackTheme,
    tracks: normalized,
  };
}

function byIndex(a, b) {
  const ai = a.index ?? MAX_INDEX;
  const bi = b.index ?? MAX_INDEX;
  if (ai !== bi) return ai - bi;
  return String(a.record.id).localeCompare(String(b.record.id), undefined, { numeric: true });
}

function stripHelpers(track) {
  return track.record;
}

function collectTrackTitles(value, target) {
  if (Array.isArray(value)) {
    for (const entry of value) {
      if (isObject(entry) && entry.id != null && entry.title != null) {
        target[String(entry.id)] = String(entry.title);
      }
    }
    return;
  }
  if (!isObject(value)) return;
  for (const [id, title] of Object.entries(value)) {
    if (typeof title === 'string') target[id] = title;
    else if (isObject(title) && title.title != null) target[id] = String(title.title);
  }
}

function loadTitles() {
  const data = readJson(path.join(musicRoot, 'titles.json'), 'titles.json');
  const result = { games: {}, tracks: {}, globalTracks: {} };
  if (!data) return result;

  if (Array.isArray(data)) {
    for (const entry of data) {
      if (!isObject(entry) || entry.id == null || entry.title == null) continue;
      const id = String(entry.id);
      if (entry.game) {
        result.tracks[String(entry.game)] ||= {};
        result.tracks[String(entry.game)][id] = String(entry.title);
      } else {
        result.globalTracks[id] = String(entry.title);
      }
    }
    return result;
  }
  if (!isObject(data)) return result;

  const gameSource = isObject(data.games) ? data.games : data;
  for (const { key } of GAMES) {
    const entry = gameSource[key];
    if (typeof entry === 'string') {
      result.games[key] = { title: entry };
    } else if (isObject(entry)) {
      result.games[key] = {};
      if (typeof entry.title === 'string') result.games[key].title = entry.title;
      if (typeof entry.theme === 'string') result.games[key].theme = entry.theme;
      result.tracks[key] ||= {};
      if (entry.tracks != null) {
        collectTrackTitles(entry.tracks, result.tracks[key]);
      } else {
        // { "r4": { "01": "Intro", ... } } is a game-scoped track map.
        const trackMap = Object.fromEntries(
          Object.entries(entry).filter(([k, v]) => !['title', 'theme', 'key'].includes(k) &&
            (typeof v === 'string' || isObject(v))),
        );
        collectTrackTitles(trackMap, result.tracks[key]);
      }
    }
  }

  if (data.tracks != null) collectTrackTitles(data.tracks, result.globalTracks);

  // A flat { "<track id>": "<title>" } file is also accepted.
  const reserved = new Set(['games', 'tracks', ...GAMES.map((g) => g.key)]);
  for (const [key, value] of Object.entries(data)) {
    if (reserved.has(key) || typeof value !== 'string') continue;
    result.globalTracks[key] = value;
  }
  return result;
}

function applyTitleOverrides(game, titles) {
  const gameTitles = titles.games[game.key] || {};
  if (gameTitles.title) game.title = gameTitles.title;
  if (gameTitles.theme) game.theme = gameTitles.theme;
  for (const track of game.tracks) {
    const record = track.record || track;
    // Index-based title maps are for soundtrack track numbers (r4 movie 02,
    // Rage CD 03, ...). XA extras are named game-NN and must keep their own
    // titles; applying the index map would label them as the intro/ending.
    const indexKey = /^game-/i.test(String(record.id)) ? null : String(track.index);
    const override = titles.tracks[game.key]?.[record.id]
      ?? (indexKey ? titles.tracks[game.key]?.[indexKey] : null)
      ?? titles.globalTracks[record.id]
      ?? (indexKey ? titles.globalTracks[indexKey] : null);
    if (override != null) record.title = override;
  }
}

function main() {
  if (!fs.existsSync(musicRoot)) fs.mkdirSync(musicRoot, { recursive: true });

  const titles = loadTitles();
  const loaded = new Map();
  for (const def of GAMES) {
    const game = loadGame(def.key, def.title, def.theme);
    loaded.set(def.key, game);
  }

  const xa = loadGame(XA_KEY, 'Ridge Racer Type 4 XA', 'r4');
  applyTitleOverrides(xa, titles);
  const r4 = loaded.get('r4');

  // r4 playlist: intro first, then the optional r4-xa extras, then the
  // regular soundtrack in index order.
  const intros = r4.tracks.filter((t) => t.intro).sort(byIndex);
  const soundtrack = r4.tracks.filter((t) => !t.intro).sort(byIndex);
  const extras = xa.tracks.slice().sort(byIndex);
  r4.tracks = [...intros, ...extras, ...soundtrack];

  for (const def of GAMES) {
    const game = loaded.get(def.key);
    if (def.key !== 'r4') game.tracks.sort(byIndex);
    applyTitleOverrides(game, titles);

    const seen = new Set();
    for (const track of game.tracks) {
      if (seen.has(track.record.id)) {
        warn(`${def.key}: duplicate track id "${track.record.id}"`);
      }
      seen.add(track.record.id);
    }
  }

  const games = {};
  for (const def of GAMES) {
    const game = loaded.get(def.key);
    games[def.key] = {
      key: def.key,
      title: game.title,
      theme: game.theme,
      tracks: game.tracks.map(stripHelpers),
    };
  }

  const manifest = {
    generatedAt: new Date().toISOString(),
    defaultGame: 'r4',
    games,
  };

  const json = `${JSON.stringify(manifest, null, 2)}\n`;
  const tempPath = `${manifestPath}.tmp-${process.pid}`;
  fs.writeFileSync(tempPath, json);
  try {
    fs.renameSync(tempPath, manifestPath);
  } catch {
    fs.writeFileSync(manifestPath, json);
    try { fs.unlinkSync(tempPath); } catch { /* ignore */ }
  }

  console.log(`Music manifest written: ${manifestPath}`);
  for (const def of GAMES) {
    console.log(`  ${def.key.padEnd(5)} ${String(games[def.key].tracks.length).padStart(3)} track(s)  ${games[def.key].title}`);
  }
  console.log(`  ${XA_KEY.padEnd(5)} ${String(xa.tracks.length).padStart(3)} extra(s) merged into r4`);
  const total = GAMES.reduce((n, def) => n + games[def.key].tracks.length, 0);
  console.log(`  total ${total} track(s), ${warnings.length} warning(s)`);
}

main();
