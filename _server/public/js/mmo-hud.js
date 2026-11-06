/* Race Day — in-race HUD for /play (?mmo=1&event=<id>&seat=<n>&team=<t>).
 *
 * Dependency-free ESM, no bundler. play.js mounts this with a dynamic import
 * only when ?mmo=1 is present, so /play is untouched without the flag.
 *
 * Contract: _runtime/analysis/20-mmo-contract.md §4.3 (HUD), §5 (module
 * boundary: `mountMmoHud(client, opts)`, `window.__R4_MMO.readTelemetry()`),
 * §8 (honesty: never invent a lap, never pass a stopwatch off as RAM).
 *
 * Rules kept here:
 *   - the overlay is a SIBLING of #game, positioned from its measured box (so
 *     embedded/fullscreen/mobile all work without duplicating play.css), never
 *     inside EmulatorJS, and it never creates an HTMLAudioElement;
 *   - pointer-events: none on the root, auto only on the toggle + finish link;
 *   - `aria-live="polite"` sits on the position chip only (the timer would spam);
 *   - mmo-client.js publishes the facade on /play but never connects; the HUD is
 *     the only thing that opens the /mmo socket, and only when ?mmo=1 mounted it;
 *   - telemetry: the confirmed PSX RAM fields (race clock `0x800F4E2F`, speed
 *     `0x800AC0EE`, see `_runtime/analysis/14-ram-telemetry.md`) once the
 *     main-menu label anchor validates; the stopwatch started at GO
 *     (`countdown.startsAt`) is only the fallback and stays labelled
 *     `stopwatch`. `lapSource` says where the lap came from (`ram` | `time`);
 *     the RAM lap byte is still a candidate, so `lap` is `null` until it passes.
 */

import { createMmoClient } from './mmo-client.js';

export const HUD_VERSION = '1.0.0';

const RACE_DAY_URL = '/race-day';
const MAX_SEATS_FALLBACK = 50;
const RACE_TIMEOUT_MS = 600000;   // contract §2 RACE_TIMEOUT_MS default
const LAP_ESTIMATE_MS = 60000;    // R4 laps are ~1 min; only used to *infer* a lap
const RENDER_MS = 100;            // the timer shows tenths, so ~10 Hz is enough
const READ_CACHE_MS = 40;         // one RAM read per tick even with two callers
const TOP_ROWS = 5;
const FINISH_LINGER = 4;          // finished samples still offered so the client can send `finish`

/* ---------------------------------------------------------------------------
 * PSX RAM fields (KSEG0 virtual addresses) — CONFIRMED.
 *
 * Source: `_runtime/analysis/14-ram-telemetry.md` §1/§4 (probe
 * `_server/rr4-telemetry-probe.mjs`: two runs, different course/car, plus
 * screenshot-vs-RAM ground truth at `_runtime/ram-ground/`).
 *
 *   0x800F4E2F  race clock, u32 LE, UNALIGNED, 1 count = 1 ms
 *   0x8010C24F  the same clock, second copy — identical in every sample, used
 *               here as a stale/partial-read check
 *   0x800AC0EE  speed, u16 LE, 8.8 fixed point -> km/h = raw / 64 (clamp 0..400)
 *   0x800AC273  lap, u8 — CANDIDATE ONLY (§2: one 0->2 step at 55.5 s, never 1).
 *               Adopted only when the series behaves like a lap counter; else
 *               `lap:null` + `lapSource:'time'`, never an invented lap.
 *
 * Clock semantics: `0xFFFFFFFF` = track loading **or** results screen,
 * `0` = grid before GO, `>0` = racing (total race time in ms, never resets per
 * lap). So `finished` requires a live (>0) sample first: `0` is never a finish.
 *
 * The live 2 MiB window still has to be located at run time. The heap can hold
 * stale save-state copies of the main-menu label table (0x800A2180, 16-byte
 * stride), and only one copy is live, so a base is accepted only when all five
 * labels spell out — the same validation the probe uses. The table itself is
 * transient (gone once a race runs), so it is resolved at boot / in the menu and
 * then cached for the session; candidate bases are watched for movement so a
 * stale copy that keeps its labels can be displaced by the live window.
 * ------------------------------------------------------------------------- */
const RAM = Object.freeze({
  anchor: 0x800a2180,              // 'WELCOME' label table (play-net.js anchor)
  clock: 0x800f4e2f,               // u32 LE, ms, 1 count = 1 ms
  clockMirror: 0x8010c24f,         // same value, used for read consistency
  speed: 0x800ac0ee,               // u16 LE, 8.8 fixed -> km/h = raw / 64
  lap: 0x800ac273,                 // candidate u8 (validated across two samples)
  menuSel: 0x800ac801,             // main-menu selection byte (plausibility)
});

const CLOCK_SENTINEL = 0xffffffff;  // loading | results screen — not a finish alone
const CLOCK_MAX_MS = 1800000;       // > 30 min: the word is not a race clock
const CLOCK_CAP_MS = 599999;        // measured: the TIME ATTACK clock pins at 9:59.999
const SPEED_8_8 = 64;               // 8.8 fixed point -> km/h
const SPEED_MAX_KPH = 400;
const LAP_MAX_CANDIDATE = 9;        // R4 races are 3 laps; >9 is not a lap byte
const LAP_MIN_STEP_MS = 10000;      // no R4 lap is shorter than this
const FROZEN_DROP_MS = 3000;        // a >0 clock frozen this long is a stale copy

/* ---------- helpers ------------------------------------------------------- */

const num = (v, fallback = 0) => (typeof v === 'number' && Number.isFinite(v) ? v : fallback);

export function fmtTime(ms) {
  if (!Number.isFinite(ms) || ms < 0) return '—';
  const tenths = Math.round(ms / 100) / 10;
  const m = Math.floor(tenths / 60);
  const s = tenths - m * 60;
  return `${m}:${s < 10 ? '0' + s.toFixed(1) : s.toFixed(1)}`;
}

export function fmtGap(ms) {
  return Number.isFinite(ms) ? (Math.abs(ms) / 1000).toFixed(1) : '—';
}

function mk(tag, cls, text) {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text != null) node.textContent = text;
  return node;
}

/* ---------------------------------------------------------------------------
 * Telemetry reader
 *
 * `read()` → `{raceTimeMs, lap, speedKph, state, source, lapSource, bestLapMs}`
 * or null. `detail()` explains the mode for harnesses/consoles.
 * ------------------------------------------------------------------------- */
export function createRr4TelemetryReader(options = {}) {
  const opts = options || {};
  const getState = typeof opts.getState === 'function' ? opts.getState : () => null;

  const st = {
    mode: 'stopwatch',            // 'stopwatch' | 'ram'
    reason: 'ram-not-sampled',
    goAt: 0,
    goEventId: null,
    fallbackGoAt: 0,
    finished: false,
    finishedAt: 0,
    finishedSamples: 0,
    anchor: null,                 // heap offset of the label table (0x800A2180)
    anchorAt: 0,
    anchorLabels: false,          // the five labels read back at the last look
    cands: [],                    // {base, clock} — live-copy disambiguation
    lastScan: 0,
    scans: 0,
    clock: null,                  // last raw u32 read at RAM.clock
    mirror: null,
    lastLive: 0,                  // last live (>0) race time, ms
    lastLiveAt: 0,
    samples: 0,                   // live race samples seen in this race
    prevClock: null,
    prevFrame: null,
    frozenSince: 0,
    mismatches: 0,
    lastRam: null,                // last good RAM sample (partial-read hold)
    lap: { raw: null, prev: null, adopted: null, ok: true, hold: 0, lastStepAt: 0, rejected: '' },
    lapSource: 'time',
    best: null,
    lastSample: null,
    lastReadAt: 0,
  };

  function heap() {
    const em = typeof window !== 'undefined' ? window.EJS_emulator : null;
    const gm = em && (em.gameManager || null);
    const M = (gm && gm.Module) || (em && em.Module) || null;
    const H = M && M.HEAPU8;
    return { em, gm, M, H };
  }

  /* R4's main-menu label table is the only stable JS-side anchor:
   * WELCOME / DEMONSTRATION / GRAND PRIX / TIME ATTACK / VS BATTLE at a 16-byte
   * stride (the same anchors play-net.js and mp-calibrate.mjs use). All five are
   * required: the heap also carries stale save-state copies, and a stale copy
   * read as RAM telemetry is exactly the lie this HUD must not tell. The probe
   * saw the live window at heap offsets 6.8 M / 11.4 M / 78.9 M, so the first
   * pass is bounded and every fourth pass walks the whole heap once. */
  const ANCHOR_STRIDE_TO_TA = 48;   // WELCOME -> TIME ATTACK
  const RAM_SCAN_LIMIT = 128 * 1024 * 1024;
  const MAX_CANDIDATES = 8;
  const bytes = (s) => Array.from(s, (c) => c.charCodeAt(0));
  const WELCOME = bytes('WELCOME');
  const LABELS = [
    { at: 0, pat: WELCOME },                            // 0x800A2180
    { at: 16, pat: bytes('DEMONSTRATION') },
    { at: 32, pat: bytes('GRAND PRIX') },
    { at: ANCHOR_STRIDE_TO_TA, pat: bytes('TIME ATTACK') },
    { at: ANCHOR_STRIDE_TO_TA + 16, pat: bytes('VS BATTLE') },
  ];
  const TA_FIRST = LABELS[3].pat[0];

  function eqAt(H, at, p) {
    if (at < 0 || at + p.length > H.length) return false;
    for (let i = 0; i < p.length; i += 1) if (H[at + i] !== p[i]) return false;
    return true;
  }

  function labelsAt(H, base) {
    if (base == null || base < 0) return false;
    return LABELS.every((label) => eqAt(H, base + label.at, label.pat));
  }

  function findAnchors(H, limit) {
    const hi = Math.min(H.length - 64, limit);
    const hits = [];
    let p = 0;
    while (hits.length < MAX_CANDIDATES) {
      const i = H.indexOf(TA_FIRST, p);
      if (i < 0 || i >= hi) break;
      p = i + 1;
      const base = i - ANCHOR_STRIDE_TO_TA;
      if (labelsAt(H, base)) hits.push(base);
    }
    return hits;
  }

  function off(addr) {
    if (st.anchor == null) return null;
    // st.anchor is the heap position of the label table at 0x800A2180; the PSX
    // RAM window starts RAM.anchor bytes before it. (Same derivation as
    // mp-calibrate.mjs: ramStart = base - (0x800A2180 - 0x80000000).)
    const ramStart = st.anchor - (RAM.anchor - 0x80000000);
    const at = ramStart + (addr - 0x80000000);
    return at >= 0 ? at : null;
  }

  function u8(H, addr) {
    const at = off(addr);
    if (at == null || at + 1 > H.length) return null;
    return H[at];
  }

  function u16(H, addr) {
    const at = off(addr);
    if (at == null || at + 2 > H.length) return null;
    return H[at] | (H[at + 1] << 8);
  }

  /* The race clock lives at an unaligned address (0x800F4E2F), so every byte is
   * read explicitly; the mirror copy must agree or the window is stale/partial. */
  function u32(H, addr) {
    const at = off(addr);
    if (at == null || at + 4 > H.length) return null;
    return (H[at] | (H[at + 1] << 8) | (H[at + 2] << 16) | (H[at + 3] << 24)) >>> 0;
  }

  function rd32At(H, base, addr) {
    const at = base - (RAM.anchor - 0x80000000) + (addr - 0x80000000);
    if (at < 0 || at + 4 > H.length) return null;
    return (H[at] | (H[at + 1] << 8) | (H[at + 2] << 16) | (H[at + 3] << 24)) >>> 0;
  }

  function clockSane(v) {
    return v === 0 || v === CLOCK_SENTINEL || (v > 0 && v < CLOCK_MAX_MS);
  }

  /* Several label tables can exist at once (save-state buffers). Score each by
   * the things only the live window answers: both clock copies agree, the word
   * is a plausible clock, the menu selection byte is a plausible index. The
   * current base gets a small hysteresis bonus while it still spells the labels,
   * and a base that has been *seen* to move wins outright (trackCandidates). */
  function scoreBase(H, base) {
    if (!labelsAt(H, base)) return -1;
    const clock = rd32At(H, base, RAM.clock);
    const mirror = rd32At(H, base, RAM.clockMirror);
    const selAt = base - (RAM.anchor - 0x80000000) + (RAM.menuSel - 0x80000000);
    const sel = selAt >= 0 && selAt < H.length ? H[selAt] : 255;
    let score = 0;
    if (clock != null && clock === mirror) score += 4;
    if (clock != null && clockSane(clock)) score += 2;
    if (clock != null && clock > 0 && clock < CLOCK_MAX_MS) score += 1;
    if (sel <= 10) score += 1;
    if (base === st.anchor) score += 2;
    return score;
  }

  function adoptAnchor(base, now) {
    if (st.anchor !== base) {
      st.prevClock = null;
      st.frozenSince = 0;
    }
    st.anchor = base;
    st.anchorAt = now;
    st.anchorLabels = true;
  }

  function resolveAnchor(H, now) {
    if (now - st.lastScan < 1000) return st.anchor;
    st.lastScan = now;
    st.scans += 1;
    const limit = st.scans % 4 === 0 ? H.length : RAM_SCAN_LIMIT;
    const hits = findAnchors(H, limit);
    if (!hits.length) { st.reason = 'no-ram-anchor'; return null; }
    let best = null;
    let bestScore = -1;
    for (const base of hits) {
      const score = scoreBase(H, base);
      if (score > bestScore) { best = base; bestScore = score; }
    }
    const known = new Set(st.cands.map((c) => c.base));
    for (const base of hits) if (!known.has(base)) st.cands.push({ base, clock: rd32At(H, base, RAM.clock) });
    st.cands = st.cands.filter((c) => hits.includes(c.base)).slice(0, MAX_CANDIDATES);
    if (best == null) { st.reason = 'no-ram-anchor'; return null; }
    adoptAnchor(best, now);
    st.reason = `ram-anchored ${st.cands.length} copies`;
    return best;
  }

  /* Stale-copy guard: a saved RAM image keeps the labels *and* a frozen clock.
   * Watch every anchored candidate for movement; the one whose clock advances is
   * the live window, so adopt it even if the labels only exist in the copy. */
  function trackCandidates(H, now) {
    if (st.cands.length < 2) return;
    let live = null;
    for (const c of st.cands) {
      const clock = rd32At(H, c.base, RAM.clock);
      if (clock == null) continue;
      if (c.clock != null && clock > c.clock && clock < CLOCK_MAX_MS) live = c.base;
      c.clock = clock;
    }
    if (live != null && live !== st.anchor) {
      adoptAnchor(live, now);
      st.reason = 'ram-live-copy';
    }
  }

  /* Speed: u16 LE, 8.8 fixed point. km/h = raw / 64 (§1: raw 9728 = 152 km/h).
   * The field is SIGNED 8.8: a car rolling backwards against a wall reads
   * 0xFC00 = -16 km/h, so it must be decoded as i16 — an unsigned read would
   * clamp to 400 km/h. Negative (standstill / reversing) reports 0. */
  function speedKphNow(H) {
    const raw = u16(H, RAM.speed);
    if (raw == null) return 0;
    const fixed = raw & 0x8000 ? raw - 0x10000 : raw;
    if (fixed <= 0) return 0;
    return Math.max(0, Math.min(SPEED_MAX_KPH, Math.round(fixed / SPEED_8_8)));
  }

  function resetRace() {
    st.lastLive = 0;
    st.lastLiveAt = 0;
    st.samples = 0;
    st.finished = false;
    st.finishedSamples = 0;
    st.lap = { raw: null, prev: null, adopted: null, ok: true, hold: 0, lastStepAt: 0, rejected: '' };
    st.lapSource = 'time';
  }

  /* Lap candidate 0x800AC273 is UNCONFIRMED (§2: one 0->2 step at clock 55.5 s,
   * never 1). Adopt it only when it behaves like one: two samples at the same
   * value, steps of exactly +1, never backwards, and >= LAP_MIN_STEP_MS of race
   * clock between steps. Anything else -> `lap:null` + `lapSource:'time'`
   * (never invent a lap). A raw 0 is ambiguous (pre-race or 0-based lap 1), so
   * it stays null as well and the HUD falls back to its time estimate. */
  function trackLap(raw, clockMs) {
    const L = st.lap;
    if (raw == null || raw > LAP_MAX_CANDIDATE) { L.ok = false; L.adopted = null; L.raw = raw; return; }
    L.raw = raw;
    if (L.prev == null) { L.prev = raw; return; }
    if (raw === L.prev) {
      L.hold += 1;
    } else {
      const step = raw - L.prev;
      if (step !== 1 || clockMs - L.lastStepAt < LAP_MIN_STEP_MS) {
        L.ok = false;
        L.rejected = `step ${L.prev}->${raw}${step !== 1 ? ' (not +1)' : ' too soon'}`;
      } else {
        L.lastStepAt = clockMs;
        L.hold = 0;
      }
      L.prev = raw;
    }
    L.adopted = L.ok && L.hold >= 1 && raw >= 1 ? Math.min(99, raw) : null;
    st.lapSource = L.adopted != null ? 'ram' : 'time';
  }

  /* One RAM sample (4 Hz safe: five loads once the anchor is cached). Returns
   * `{state, raceTimeMs, speedKph, clock, at}` or null when this tick cannot be
   * read (no heap / no anchor / partial read); the caller then holds the last
   * good RAM sample for up to a second before it falls back to the stopwatch. */
  function ramTick(now) {
    const { gm, H } = heap();
    if (!H) { st.reason = 'heap-missing'; return null; }
    const frames = gm && typeof gm.getFrameNum === 'function' ? num(gm.getFrameNum(), 0) : 0;

    if (st.anchor == null) {
      if (resolveAnchor(H, now) == null) return null;
    }
    trackCandidates(H, now);
    // Labels are transient (gone once a race runs): remember the strong check,
    // but never throw away a cached base just because the text is gone.
    st.anchorLabels = labelsAt(H, st.anchor);

    const clock = u32(H, RAM.clock);
    const mirror = u32(H, RAM.clockMirror);
    st.clock = clock;
    st.mirror = mirror;
    if (clock == null || mirror == null) { st.reason = 'ram-field-missing'; return null; }
    if (!clockSane(clock)) {
      // reused heap or a stale copy: re-resolve from the labels next tick.
      st.anchor = null;
      st.cands.length = 0;
      st.prevClock = null;
      st.frozenSince = 0;
      st.mismatches = 0;
      st.reason = 'ram-clock-insane';
      return null;
    }
    // The second clock copy is only maintained once the game is really racing
    // (it reads 0 while the track loads), so it is a confidence signal and not
    // a gate: a live clock with no mirror is the confirmed `0x800F4E2F` field.
    if (mirror === clock) {
      st.mismatches = 0;
    } else {
      st.mismatches += 1;
      if (clock > 0 && clock < CLOCK_MAX_MS && st.mismatches >= 3) {
        st.anchor = null;
        st.cands.length = 0;
        st.prevClock = null;
        st.frozenSince = 0;
        st.mismatches = 0;
        st.reason = 'ram-mirror-mismatch';
        return null;
      }
    }

    // A >0 clock that stops moving while the core keeps running is a stale copy.
    // The display cap (9:59.999) is a legitimately frozen live value, so it is
    // excluded — otherwise a long TIME ATTACK would churn the anchor every 3 s.
    if (clock > 0 && clock < CLOCK_MAX_MS && clock !== CLOCK_CAP_MS) {
      const framesMoved = st.prevFrame != null && frames !== st.prevFrame;
      if (st.prevClock === clock && framesMoved) {
        if (!st.frozenSince) st.frozenSince = now;
      } else if (st.prevClock !== clock) {
        st.frozenSince = 0;
      }
      if (st.frozenSince && now - st.frozenSince > FROZEN_DROP_MS) {
        st.anchor = null;
        st.cands.length = 0;
        st.prevClock = null;
        st.frozenSince = 0;
        st.reason = 'ram-clock-frozen';
        return null;
      }
    } else {
      st.frozenSince = 0;
    }
    st.prevClock = clock;
    st.prevFrame = frames;

    if (clock === CLOCK_SENTINEL) {
      // loading, or the results screen. `0` must never be read as a finish, so
      // `finished` requires a live (>0) sample first (§4).
      if (!st.finished && st.lastLive > 0) { st.finished = true; st.finishedAt = now; }
      st.reason = st.finished ? 'ram::result-screen' : 'ram::loading';
      return {
        state: st.finished ? 'finished' : 'countdown',
        raceTimeMs: st.finished ? st.lastLive : null,
        speedKph: 0,
        clock,
        at: now,
      };
    }

    if (clock === 0) {
      // grid before GO. A grid after a finished race is a new race.
      if (st.finished || st.lastLive > 0) resetRace();
      st.reason = 'ram::grid';
      return { state: 'countdown', raceTimeMs: 0, speedKph: 0, clock, at: now };
    }

    // racing
    if (st.finished) { st.finished = false; st.finishedSamples = 0; st.reason = 'ram::new-race'; }
    else if (st.lastLive > 0 && clock + 1000 < st.lastLive) { st.samples = 0; st.reason = 'ram::clock-reset'; }
    st.lastLive = clock;
    st.lastLiveAt = now;
    st.samples += 1;
    trackLap(u8(H, RAM.lap), clock);
    st.reason = 'ram::racing';
    return { state: 'racing', raceTimeMs: clock, speedKph: speedKphNow(H), clock, at: now };
  }

  function goAt(now) {
    const state = getState() || {};
    const evt = state.event || {};
    const id = evt.id == null ? null : evt.id;
    if (st.goEventId !== id) {          // a new event restarts the clock
      st.goEventId = id;
      st.goAt = 0;
      st.fallbackGoAt = 0;
      resetRace();
    }
    const startsAt = num(state.countdown && state.countdown.startsAt, 0);
    if (startsAt > 0) { st.goAt = startsAt; return startsAt; }
    if (st.goAt > 0) return st.goAt;
    if (!st.fallbackGoAt) st.fallbackGoAt = now;
    return st.fallbackGoAt;
  }

  function read() {
    const now = Date.now();
    if (st.lastSample && now - st.lastReadAt < READ_CACHE_MS) return st.lastSample;
    st.lastReadAt = now;
    const state = getState() || {};
    const evt = state.event || {};
    const res = state.results || null;
    const start = goAt(now);

    /* RAM first. `null` means this tick could not be read; hold the last good
     * RAM sample for up to a second before the stopwatch takes over, so a single
     * torn read never relabels a live race as `stopwatch`. */
    let ram = ramTick(now);
    if (ram) {
      st.lastRam = ram;
      st.mode = 'ram';
    } else if (st.lastRam && now - st.lastRam.at < 1000) {
      ram = st.lastRam;
      st.mode = 'ram';
    } else {
      st.mode = 'stopwatch';
    }

    // The server's results frame is a second finish signal (RAM finish wins).
    if (!ram && !st.finished) {
      if (evt.state === 'results') { st.finished = true; st.reason = 'server::results'; }
      else if (res && res.you && Number.isFinite(res.you.raceTimeMs)) {
        st.finished = true;
        st.reason = 'server::result-rows';
      }
    }

    let raceTimeMs;
    let speedKph = 0;
    let raceState;
    if (ram) {
      raceTimeMs = ram.raceTimeMs;
      speedKph = ram.state === 'racing' ? ram.speedKph : 0;
      raceState = ram.state;
    } else {
      // Stopwatch fallback: the exception, not the default. Starts at the
      // announced GO (`countdown.startsAt`) or at first read.
      raceTimeMs = Math.max(0, now - start);
      if (st.finished) {
        raceTimeMs = res && res.you && Number.isFinite(res.you.raceTimeMs) ? res.you.raceTimeMs : raceTimeMs;
        raceState = 'finished';
      } else if (raceTimeMs >= RACE_TIMEOUT_MS) {
        st.finished = true;
        st.reason = 'stopwatch::race-timeout';
        raceState = 'finished';
      } else {
        raceState = raceTimeMs <= 0 ? 'countdown' : 'racing';
      }
    }

    const source = ram ? 'ram' : 'stopwatch';
    if (st.finished && raceState !== 'finished') raceState = 'finished';

    if (st.finished) {
      st.finishedSamples += 1;
      // Offer a few `finished` samples so the client can send its `finish`
      // frame, then stop the stream (no more telemetry leaves the tab).
      if (st.finishedSamples > FINISH_LINGER) { st.lastSample = null; return null; }
    }

    const sample = {
      raceTimeMs: raceTimeMs == null ? null : Math.round(raceTimeMs),
      // RAM lap when the candidate validated, otherwise null: the HUD (and the
      // client) fall back to the time estimate and `lapSource` says so.
      lap: st.lapSource === 'ram' ? st.lap.adopted : null,
      speedKph,
      state: raceState,
      source,
      lapSource: st.lapSource,
      bestLapMs: st.best,
    };
    st.lastSample = sample;
    return sample;
  }

  function finish(why) {
    if (st.finished) return;
    st.finished = true;
    st.finishedAt = Date.now();
    st.reason = why || 'finished';
    st.lastSample = null;
    st.lastReadAt = 0;
  }

  function detail() {
    return {
      version: HUD_VERSION,
      mode: st.mode,
      source: st.mode === 'ram' ? 'ram' : 'stopwatch',
      reason: st.reason,
      // The four fields a harness/console needs to reason about the reader.
      addr: RAM.clock,
      clock: st.clock,
      lastLive: st.lastLive,
      samples: st.samples,
      lapSource: st.lapSource,
      lapRaw: st.lap.raw,
      bestLapMs: st.best,
      finished: st.finished,
      goAt: st.goAt || st.fallbackGoAt || 0,
      ram: {
        anchor: st.anchor,
        anchorLabels: st.anchorLabels,
        anchorAt: st.anchorAt,
        copies: st.cands.length,
        scans: st.scans,
        clockAddr: RAM.clock,
        clockMirrorAddr: RAM.clockMirror,
        clockMirror: st.mirror,
        speedAddr: RAM.speed,
        lapAddr: RAM.lap,
        lapOk: st.lap.ok,
        lapRejected: st.lap.rejected || null,
        verdict: st.mode === 'ram' ? 'ram' : 'fallback',
      },
    };
  }

  return { read, finish, detail, reset() { st.lastSample = null; st.lastReadAt = 0; } };
}

/* One reader per page: the mounted HUD and the exported
 * `readRr4Telemetry` share it, so both see the same clock. */
let stateRef = () => (typeof window !== 'undefined' && window.__R4_MMO ? window.__R4_MMO.state : null);
const sharedReader = createRr4TelemetryReader({ getState: () => stateRef() });

/** `window.__R4_MMO.setTelemetrySource(readRr4Telemetry, 'ram'|'stopwatch')`. */
export function readRr4Telemetry() {
  return sharedReader.read();
}
readRr4Telemetry.source = 'ram';

/* ---------------------------------------------------------------------------
 * HUD
 * ------------------------------------------------------------------------- */

function resolveClient(candidate) {
  if (candidate && typeof candidate.subscribe === 'function' && typeof candidate.setTelemetrySource === 'function') return candidate;
  const facade = typeof window !== 'undefined' ? window.__R4_MMO : null;
  if (facade && facade.client) return facade.client;
  return createMmoClient();
}

const TEAM_SLUGS = ['sol', 'pac', 'map', 'dig'];

export function teamSlug(team) {
  const raw = typeof team === 'number' ? String(team) : String(team == null ? '' : team).trim().toLowerCase();
  if (!raw) return '';
  if (TEAM_SLUGS.includes(raw)) return raw;
  const asNumber = Number(raw);
  if (Number.isFinite(asNumber)) return TEAM_SLUGS[((Math.round(asNumber) % 4) + 4) % 4];
  return TEAM_SLUGS.find((slug) => raw.startsWith(slug)) || '';
}

export function mountMmoHud(client, opts = {}) {
  if (typeof window === 'undefined' || typeof document === 'undefined') return null;
  const facade = window.__R4_MMO;
  if (facade && facade.hud && facade.hud.__singleton) return facade.hud;

  const options = opts || {};
  const params = window.__R4_MMO_PARAMS || {};
  const cfg = {
    event: options.event != null ? options.event : params.event,
    seat: options.seat != null ? options.seat : params.seat,
    team: options.team != null ? options.team : params.team,
    connect: options.connect !== false,
  };
  const cli = resolveClient(client);
  stateRef = () => (cli ? cli.state : null);

  /* --- DOM --------------------------------------------------------------- */
  const hud = mk('div', 'mmo-hud');
  hud.id = 'mmoHud';
  hud.hidden = true;
  // Inline fallbacks so a not-yet-loaded stylesheet can never leave an
  // unstyled block in the page flow for a frame.
  hud.style.position = 'fixed';
  hud.style.pointerEvents = 'none';
  hud.style.zIndex = '10';
  hud.dataset.live = '0';
  hud.setAttribute('role', 'group');
  hud.setAttribute('aria-label', 'Race Day HUD');

  const top = mk('div', 'mmo-hud-top');
  const pos = mk('span', 'mmo-hud-pos', `P— / ${MAX_SEATS_FALLBACK}`);
  pos.id = 'mmoHudPos';
  pos.setAttribute('aria-live', 'polite');
  pos.setAttribute('aria-atomic', 'true');
  const toggle = mk('button', 'mmo-hud-toggle', 'BOARD');
  toggle.id = 'mmoHudToggle';
  toggle.type = 'button';
  toggle.setAttribute('aria-expanded', 'false');
  toggle.setAttribute('aria-controls', 'mmoHudBoard');
  toggle.title = 'Toggle the mini board (M)';
  const slow = mk('span', 'mmo-hud-slow', 'SLOW');
  slow.id = 'mmoHudSlow';
  slow.hidden = true;
  top.append(pos, toggle, slow);

  const clock = mk('div', 'mmo-hud-clock');
  const lapEl = mk('span', 'mmo-hud-lap', 'LAP 1');
  lapEl.id = 'mmoHudLap';
  const timeEl = mk('span', 'mmo-hud-time', '0:00.0');
  timeEl.id = 'mmoHudTime';
  const bestEl = mk('span', 'mmo-hud-best', 'BEST —');
  bestEl.id = 'mmoHudBest';
  const sep1 = mk('span', 'mmo-hud-dot', '·');
  const sep2 = mk('span', 'mmo-hud-dot', '·');
  sep1.setAttribute('aria-hidden', 'true');
  sep2.setAttribute('aria-hidden', 'true');
  clock.append(lapEl, sep1, timeEl, sep2, bestEl);

  const gaps = mk('div', 'mmo-hud-gaps');
  gaps.id = 'mmoHudGaps';
  gaps.hidden = true;
  const gapAhead = mk('span', 'mmo-hud-gap mmo-hud-gap-ahead', '▲ +0.0');
  gapAhead.id = 'mmoHudGapAhead';
  gapAhead.hidden = true;
  const gapBehind = mk('span', 'mmo-hud-gap mmo-hud-gap-behind', '▼ −0.0');
  gapBehind.id = 'mmoHudGapBehind';
  gapBehind.hidden = true;
  gaps.append(gapAhead, gapBehind);

  const board = mk('div', 'mmo-hud-board');
  board.id = 'mmoHudBoard';
  board.hidden = true;
  const boardHead = mk('div', 'mmo-hud-board-head');
  const boardLap = mk('span', 'mmo-hud-board-lap', 'LAP 1');
  boardHead.append(mk('span', 'mmo-hud-board-title', 'TOP 5'), boardLap);
  const boardList = mk('ol', 'mmo-hud-board-list');
  boardList.id = 'mmoHudBoardList';
  boardList.setAttribute('aria-label', 'Race Day mini board: top 5 and you');
  board.append(boardHead, boardList);

  const finishCard = mk('div', 'mmo-hud-finish');
  finishCard.id = 'mmoHudFinish';
  finishCard.hidden = true;
  const finishTitle = mk('div', 'mmo-hud-finish-title', 'FINISHED');
  finishTitle.id = 'mmoHudFinishTitle';
  const finishLink = mk('a', 'mmo-hud-finish-link', 'BACK TO RACE DAY');
  finishLink.id = 'mmoHudFinishLink';
  finishLink.href = RACE_DAY_URL;
  finishCard.append(finishTitle, finishLink);

  const sourceEl = mk('div', 'mmo-hud-source', 'TELEM STOPWATCH');
  sourceEl.id = 'mmoHudSource';
  sourceEl.title = 'Where the HUD numbers come from (RAM vs stopwatch)';

  const wrap = mk('div', 'mmo-hud-wrap');
  wrap.append(top, clock, gaps, board, finishCard, sourceEl);
  hud.append(wrap);

  // Sibling of #game: appended to <body> and positioned from #game's measured
  // box, so EmulatorJS can never remove or restyle it.
  document.body.appendChild(hud);

  /* --- telemetry + socket ------------------------------------------------ */
  const reader = sharedReader;
  const previousLabel = cli && cli.telemetrySource;
  if (cli && typeof cli.setTelemetrySource === 'function') {
    cli.setTelemetrySource(readRr4Telemetry, reader.detail().mode === 'ram' ? 'ram' : 'stopwatch');
  }
  // mmo-client.js publishes the facade on /play but does not connect: the HUD
  // opens the /mmo socket, and only because ?mmo=1 loaded this module.
  if (cfg.connect && cli && typeof cli.connect === 'function') {
    try { cli.connect(); } catch { /* the client retries with backoff */ }
  }

  /* --- render ------------------------------------------------------------ */
  let timer = 0;
  let raf = 0;
  let box = { w: 0, h: 0, compact: false };
  let boardOpen = false;
  let done = false;
  let finalMs = 0;
  let finalLap = 1;
  let unmounted = false;

  function syncBox() {
    const game = document.getElementById('game');
    if (!game) return false;
    const rect = game.getBoundingClientRect();
    if (rect.width < 80 || rect.height < 60) return false;
    const w = Math.round(rect.width);
    const h = Math.round(rect.height);
    const compact = w < 560;
    if (w !== box.w || h !== box.h) {
      hud.style.left = `${Math.round(rect.left)}px`;
      hud.style.top = `${Math.round(rect.top)}px`;
      hud.style.width = `${w}px`;
      hud.style.height = `${h}px`;
      hud.dataset.compact = compact ? '1' : '0';
      box = { w, h, compact };
    }
    return true;
  }

  function setupVisible() {
    const setup = document.getElementById('setup');
    return !!setup && !setup.hidden;
  }

  function rowsOf(state) {
    return state && state.standings && Array.isArray(state.standings.rows) ? state.standings.rows : [];
  }

  function gapModel(state) {
    const rows = rowsOf(state);
    const mine = state && state.you ? state.you : {};
    const youSeat = mine.seat != null ? mine.seat : cfg.seat;
    const myRow = rows.find((r) => r && r.seat === youSeat)
      || rows.find((r) => r && mine.position != null && r.position === mine.position);
    let aheadMs = Number.isFinite(mine.gapMs) ? mine.gapMs : null;
    let aheadLap = !!(state && state.standings && state.standings.you && state.standings.you.gapLap);
    let behindMs = null;
    if (myRow && myRow.position != null) {
      const ahead = rows.find((r) => r && r.position === myRow.position - 1);
      const behind = rows.find((r) => r && r.position === myRow.position + 1);
      if (aheadMs == null && ahead && Number.isFinite(ahead.raceTimeMs) && Number.isFinite(myRow.raceTimeMs)) {
        if (ahead.lap === myRow.lap) aheadMs = myRow.raceTimeMs - ahead.raceTimeMs;
        else aheadLap = true;
      }
      if (behind && Number.isFinite(behind.raceTimeMs) && Number.isFinite(myRow.raceTimeMs) && behind.lap === myRow.lap) {
        behindMs = myRow.raceTimeMs - behind.raceTimeMs;
      }
    }
    return { aheadMs, aheadLap, behindMs };
  }

  function renderBoard(state) {
    const rows = rowsOf(state);
    boardList.textContent = '';
    if (!rows.length) return 0;
    const lapped = num(state.standings && state.standings.lap, 0);
    boardLap.textContent = lapped ? `LAP ${lapped}` : 'LAP —';
    const myPos = state && state.you ? state.you.position : null;
    const youSeat = state && state.you ? state.you.seat : cfg.seat;
    const sorted = rows.slice().sort((a, b) => num(a.position, 99) - num(b.position, 99));
    const top = sorted.slice(0, TOP_ROWS);
    const mine = rows.find((r) => r && (r.seat === youSeat || (myPos != null && r.position === myPos)));
    const wanted = mine && !top.includes(mine) ? top.concat([mine]) : top;
    for (const row of wanted) {
      const isYou = mine && row === mine;
      const li = mk('li', 'mmo-hud-board-row' + (isYou ? ' is-you' : ''));
      const p = mk('span', 'mmo-hud-board-pos', `P${num(row.position, 0) || '—'}`);
      const n = mk('span', 'mmo-hud-board-name', String(row.name || (row.bot ? 'BOT' : 'DRIVER')).slice(0, 12));
      const t = mk('span', 'mmo-hud-board-time', fmtTime(num(row.raceTimeMs, NaN)));
      if (isYou) li.dataset.you = '1';
      if (row.bot) n.dataset.bot = '1';
      li.append(p, n, t);
      boardList.appendChild(li);
    }
    return wanted.length;
  }

  function paint() {
    if (unmounted) return;
    if (!syncBox() || setupVisible()) { hud.hidden = true; return; }
    hud.hidden = false;
    hud.dataset.live = window.__R4 && window.__R4.startedAt ? '1' : '0';

    const state = (cli && cli.state)
      || (typeof window !== 'undefined' && window.__R4_MMO && window.__R4_MMO.client
        ? window.__R4_MMO.client.state
        : null);
    const sample = cli ? cli.readTelemetry() : reader.read();
    if (sample) {
      if (Number.isFinite(sample.raceTimeMs)) finalMs = Math.max(finalMs, sample.raceTimeMs);
      // `lap` stays null until the RAM lap candidate validates, so the chip falls
      // back to the time estimate below and `lapSource` still says `time`.
      if (Number.isFinite(sample.lap)) finalLap = sample.lap;
    }

    const max = num(state && state.event && state.event.counts && state.event.counts.max, 0)
      || num(state && state.grid && state.grid.counts && state.grid.counts.max, 0)
      || MAX_SEATS_FALLBACK;
    const position = state && state.results && Number.isFinite(state.results.you.position)
      ? state.results.you.position
      : num(state && state.you ? state.you.position : NaN, 0) || 0;
    const posLabel = `P${position || '—'} / ${max}`;
    if (pos.textContent !== posLabel) pos.textContent = posLabel;

    const detailNow = reader.detail();
    // Lap precedence: a confirmed RAM lap, then the board's lap for you, then
    // the time estimate. The reader reports `lapSource:'time'` while the RAM
    // counter is unconfirmed, and a placeholder lap of 1 must not outrank the
    // board (that made the HUD say LAP 1 next to a board showing LAP 2).
    const boardLap = num(state && state.standings ? state.standings.lap : NaN, 0);
    const ramLap = sample && Number.isFinite(sample.lap)
      && (sample.lapSource === 'ram' || detailNow.lapSource === 'ram');
    const lapShown = ramLap
      ? sample.lap
      : boardLap > 0
        ? Math.min(99, boardLap)
        : (detailNow.goAt > 0 && sample && Number.isFinite(sample.raceTimeMs)
          ? Math.min(99, 1 + Math.floor(sample.raceTimeMs / LAP_ESTIMATE_MS))
          : finalLap);
    const lapLabel = `LAP ${lapShown}`;
    if (lapEl.textContent !== lapLabel) lapEl.textContent = lapLabel;
    const shownMs = sample ? sample.raceTimeMs : finalMs;
    const timeLabel = fmtTime(shownMs);
    if (timeEl.textContent !== timeLabel) timeEl.textContent = timeLabel;
    const best = sample && Number.isFinite(sample.bestLapMs) ? sample.bestLapMs : reader.detail().bestLapMs;
    const bestLabel = `BEST ${Number.isFinite(best) ? fmtTime(best) : '—'}`;
    if (bestEl.textContent !== bestLabel) bestEl.textContent = bestLabel;

    const gap = gapModel(state);
    if (Number.isFinite(gap.aheadMs)) {
      gapAhead.hidden = false;
      const text = `▲ +${fmtGap(gap.aheadMs)}`;
      if (gapAhead.textContent !== text) gapAhead.textContent = text;
      gapAhead.title = `${fmtGap(gap.aheadMs)} s behind the car ahead`;
    } else if (gap.aheadLap) {
      gapAhead.hidden = false;
      if (gapAhead.textContent !== '▲ +1 LAP') gapAhead.textContent = '▲ +1 LAP';
      gapAhead.title = 'The car ahead is a lap up';
    } else {
      gapAhead.hidden = true;
    }
    if (Number.isFinite(gap.behindMs)) {
      gapBehind.hidden = false;
      const text = `▼ −${fmtGap(gap.behindMs)}`;
      if (gapBehind.textContent !== text) gapBehind.textContent = text;
      gapBehind.title = `${fmtGap(gap.behindMs)} s ahead of the car behind`;
    } else {
      gapBehind.hidden = true;
    }
    gaps.hidden = gapAhead.hidden && gapBehind.hidden;

    const youRow = rowsOf(state).find((r) => r && state.you && r.seat === state.you.seat);
    const isSlow = !!(state && (state.slow === true
      || (state.you && state.you.slow === true)
      || (youRow && youRow.state === 'slow')
      || (state.error && state.error.code === 'rate')));
    slow.hidden = !isSlow;

    const src = String((cli && cli.telemetrySource) || reader.detail().mode || 'none').toUpperCase();
    const srcText = `TELEM ${src}`;
    if (sourceEl.textContent !== srcText) sourceEl.textContent = srcText;
    sourceEl.dataset.source = src.toLowerCase();

    if (boardOpen) renderBoard(state);

    const finished = (sample && sample.state === 'finished')
      || !!(state && ((state.event && state.event.state === 'results')
        || (state.results && Number.isFinite(state.results.you.raceTimeMs))));
    if (finished) {
      const next = `FINISHED ${position ? 'P' + position : 'P—'} · ${fmtTime(shownMs)}`;
      if (finishTitle.textContent !== next) finishTitle.textContent = next;
      if (!done) {
        done = true;
        finishCard.hidden = false;
        hud.dataset.finished = '1';
      }
    }

    if (Number.isFinite(best) && best > 0) bestEl.dataset.best = '1';
  }

  function render() {
    if (raf || unmounted) return;
    raf = window.requestAnimationFrame(() => { raf = 0; try { paint(); } catch { /* never break the game */ } });
  }

  function loop() {
    if (unmounted) return;
    render();
    timer = window.setTimeout(loop, RENDER_MS);
  }

  function toggleBoard(force) {
    boardOpen = typeof force === 'boolean' ? force : !boardOpen;
    board.hidden = !boardOpen;
    toggle.setAttribute('aria-expanded', boardOpen ? 'true' : 'false');
    toggle.classList.toggle('is-open', boardOpen);
    if (boardOpen) renderBoard(cli ? cli.state : null);
    return boardOpen;
  }

  const onKey = (e) => {
    if (!e || (e.key !== 'm' && e.key !== 'M')) return;
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    const t = e.target;
    if (t && /^(INPUT|SELECT|TEXTAREA)$/.test(t.tagName)) return;
    e.preventDefault();
    toggleBoard();
  };
  document.addEventListener('keydown', onKey);
  const onToggleClick = () => toggleBoard();
  toggle.addEventListener('click', onToggleClick);

  const onResize = () => render();
  window.addEventListener('resize', onResize);
  document.addEventListener('fullscreenchange', onResize);

  // Every client frame coalesces into one paint per animation frame.
  const unsub = cli && typeof cli.subscribe === 'function' ? cli.subscribe(() => render()) : () => {};
  render();
  loop();

  const api = {
    __singleton: true,
    version: HUD_VERSION,
    client: cli,
    root: hud,
    params: cfg,
    reader,
    telemetrySource: () => (cli ? cli.telemetrySource : reader.detail().mode),
    telemetryDetail: () => reader.detail(),
    readTelemetry: () => readRr4Telemetry(),
    toggle: toggleBoard,
    isOpen: () => boardOpen,
    refresh: () => { reader.reset(); render(); },
    destroy() {
      unmounted = true;
      window.clearTimeout(timer);
      if (raf) window.cancelAnimationFrame(raf);
      document.removeEventListener('keydown', onKey);
      toggle.removeEventListener('click', onToggleClick);
      window.removeEventListener('resize', onResize);
      document.removeEventListener('fullscreenchange', onResize);
      try { unsub(); } catch { /* ignore */ }
      hud.remove();
      if (window.__R4_MMO && window.__R4_MMO.hud === api) {
        window.__R4_MMO.hud = null;
        if (previousLabel && cli) cli.setTelemetrySource(null);
      }
    },
  };

  if (window.__R4_MMO) {
    window.__R4_MMO.hud = api;
    window.__R4_MMO.telemetryDetail = () => reader.detail();
  }
  return api;
}

export default mountMmoHud;

/* Auto-mount when play.js set the parameters (the dynamic-import path). */
if (typeof window !== 'undefined' && typeof document !== 'undefined') {
  const boot = () => {
    try {
      if (!window.__R4_MMO_PARAMS) return;
      if (window.__R4_MMO && window.__R4_MMO.hud) return;
      mountMmoHud(null, {});
    } catch (err) {
      const rec = { message: 'mmo-hud: ' + String((err && err.message) || err) };
      if (window.__R4) (window.__R4.errors || (window.__R4.errors = [])).push(rec);
      else if (window.console) console.warn('[mmo-hud]', rec.message);
    }
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot, { once: true });
  else boot();
}
