/* Ridge Racer Type 4 — entrance gate + soundtrack player.
 *
 * Owns /js/music-player.js and /css/music-player.css only. Reads the music
 * manifest produced by the server, renders the "ENTER THE CABINET" gate and a
 * compact NOW PLAYING strip, and keeps one HTMLAudioElement for playback.
 *
 * Manifest shape:
 *   { defaultGame, games: { key: { title, theme, tracks: [
 *       { id, title, file, duration, kind } ] } } }
 * `file` is relative to /music/. Both /api/music and /music/manifest.json are
 * tried, in that order.
 */
(function () {
  'use strict';

  const MANIFEST_URLS = ['/api/music', '/music/manifest.json'];
  const ENTERED_KEY = 'rr4-music-entered';
  const VOLUME_KEY = 'rr4-music-volume';
  const MUTED_KEY = 'rr4-music-muted';
  const DEFAULT_VOLUME = 0.42;
  const LOOP_PLAYLIST = true;
  const REDUCED = !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);

  const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));

  const readNumber = (key, fallback) => {
    try {
      const raw = localStorage.getItem(key);
      if (raw === null || raw === '') return fallback;
      const n = Number(raw);
      return Number.isFinite(n) ? n : fallback;
    } catch { return fallback; }
  };
  const readFlag = (key) => {
    try { return localStorage.getItem(key) === '1'; } catch { return false; }
  };
  const write = (key, value) => {
    try { localStorage.setItem(key, String(value)); } catch { /* private mode */ }
  };
  const sessionEntered = () => {
    try { return sessionStorage.getItem(ENTERED_KEY) === '1'; } catch { return false; }
  };
  const rememberEntered = () => {
    try { sessionStorage.setItem(ENTERED_KEY, '1'); } catch { /* ignore */ }
  };

  const state = {
    ready: false,
    offline: false,
    noTracks: false,
    entered: sessionEntered(),
    gateOpen: false,
    expanded: !(window.matchMedia && window.matchMedia('(max-width: 640px)').matches),
    expandTouched: false,
    manifest: null,
    source: null,
    game: null,
    gameTitle: '',
    tracks: [],
    index: 0,
    track: null,
    playing: false,
    userPaused: false,
    needsGesture: false,
    volume: clamp(readNumber(VOLUME_KEY, DEFAULT_VOLUME), 0, 1),
    muted: readFlag(MUTED_KEY),
    error: '',
    failed: new Set(),
    failStreak: 0,
    loadToken: 0,
    introThenGame: null,
    audioContextState: 'n/a',
  };

  let audio = null;
  let audioCtx = null;
  let player = null;
  let gate = null;
  let toastEl = null;
  let toastTimer = 0;
  let fadeTimer = 0;
  let gateLeaveTimer = 0;
  let observersStarted = false;
  const els = {};

  const mount = (id) => {
    let el = document.getElementById(id);
    if (!el) {
      el = document.createElement('div');
      el.id = id;
      document.body.appendChild(el);
    }
    return el;
  };

  // ---------------------------------------------------------------------------
  // Manifest reading / normalisation
  // ---------------------------------------------------------------------------
  const isObject = (v) => !!v && typeof v === 'object' && !Array.isArray(v);

  const prettyName = (file) => {
    const base = String(file || '').split('/').pop().replace(/\.[a-z0-9]+$/i, '')
      .replace(/[-_]+/g, ' ').trim();
    if (!base) return 'Untitled';
    return base.replace(/\b\w/g, (c) => c.toUpperCase());
  };

  const rectifiedDuration = (value) => {
    let n = Number(value);
    if (!Number.isFinite(n) && typeof value === 'string' && value.includes(':')) {
      const parts = value.split(':').map(Number);
      if (parts.every((p) => Number.isFinite(p))) {
        n = parts.reduce((total, part) => total * 60 + part, 0);
      }
    }
    if (!Number.isFinite(n) || n <= 0) return 0;
    return n > 36000 ? n / 1000 : n; // tolerate manifests written in ms
  };

  const resolveTrackUrl = (file) => {
    const raw = String(file || '').trim().replace(/\\/g, '/');
    if (!raw) return '';
    if (/^(https?:)?\/\//i.test(raw)) {
      try { return new URL(raw, location.href).href; } catch { return raw; }
    }
    try {
      if (raw.startsWith('/')) return new URL(raw, location.origin).href;
      const rel = raw.replace(/^\.?\//, '').replace(/^music\//i, '');
      return new URL(rel, location.origin + '/music/').href;
    } catch {
      return '/music/' + raw.replace(/^\.?\//, '');
    }
  };

  const normaliseManifest = (raw) => {
    if (!isObject(raw)) return null;
    let gamesSrc = isObject(raw.games) ? raw.games : null;
    if (!gamesSrc) {
      // Tolerate a bare { r4: {...}, rage: {...} } map.
      const candidate = {};
      for (const [key, value] of Object.entries(raw)) {
        if (!isObject(value)) continue;
        if ([value.tracks, value.playlist, value.songs, value.items].some(Array.isArray)) {
          candidate[key] = value;
        }
      }
      if (Object.keys(candidate).length) gamesSrc = candidate;
    }
    if (!gamesSrc) return null;

    const games = {};
    for (const [key, value] of Object.entries(gamesSrc)) {
      if (!isObject(value)) continue;
      const list = [value.tracks, value.playlist, value.songs, value.items].find(Array.isArray) || [];
      const tracks = [];
      list.forEach((t, i) => {
        if (!isObject(t)) return;
        const file = t.file || t.src || t.url || t.path;
        if (typeof file !== 'string' || !file.trim()) return;
        const id = String(t.id || t.slug || `${key}-${i + 1}`);
        tracks.push({
          id,
          title: String(t.title || t.name || t.label || prettyName(file)),
          kind: String(t.kind || t.type || '').toLowerCase(),
          duration: rectifiedDuration(t.duration || t.seconds || t.length),
          file,
          url: resolveTrackUrl(file),
        });
      });
      if (!tracks.length) {
        // Keep empty games so an in-progress extraction does not silently
        // swap the player onto a different game's soundtrack.
        games[key] = {
          key,
          title: String(value.title || value.name || key),
          theme: String(value.theme || key),
          tracks: [],
        };
        continue;
      }
      games[key] = {
        key,
        title: String(value.title || value.name || key),
        theme: String(value.theme || key),
        tracks,
      };
    }
    const keys = Object.keys(games);
    if (!keys.length) return null;
    const wantedDefault = raw.defaultGame || raw.default || raw.game;
    const defaultGame = typeof wantedDefault === 'string' && games[wantedDefault] ? wantedDefault : keys[0];
    return { defaultGame, games };
  };

  const loadManifest = async () => {
    for (const url of MANIFEST_URLS) {
      let response;
      try {
        response = await fetch(url, { cache: 'no-store', headers: { Accept: 'application/json' } });
      } catch { continue; }
      if (!response.ok) continue;
      let raw;
      try {
        const text = await response.text();
        raw = JSON.parse(text.replace(/^\uFEFF/, ''));
      } catch { continue; }
      const manifest = normaliseManifest(raw);
      if (manifest) {
        state.source = url;
        return manifest;
      }
    }
    return null;
  };

  const themeToGame = (value) => {
    if (!state.manifest || !value) return null;
    if (state.manifest.games[value]) return value;
    const hit = Object.values(state.manifest.games).find((g) => g.theme === value);
    return hit ? hit.key : null;
  };

  const resolveGameKey = (manifest) => {
    const select = document.getElementById('gameSelect');
    const fromSelect = select && select.value ? select.value.toLowerCase() : '';
    let fromQuery = '';
    try { fromQuery = (new URLSearchParams(location.search).get('game') || '').toLowerCase(); } catch { /* ignore */ }
    if (fromSelect && manifest.games[fromSelect]) return fromSelect;
    if (fromQuery && manifest.games[fromQuery]) return fromQuery;
    if (manifest.games[manifest.defaultGame]) return manifest.defaultGame;
    return Object.keys(manifest.games)[0];
  };

  const findR4IntroTrack = () => {
    const r4 = state.manifest && state.manifest.games && state.manifest.games.r4;
    if (!r4 || !Array.isArray(r4.tracks)) return null;
    return r4.tracks.find((t) =>
      t.kind === 'intro' || t.id === 'r4-intro' || /^r4-intro/.test(t.id) ||
      /you the one for me/i.test(t.title)) || null;
  };

  const startIndexFor = (key, tracks) => {
    if (key === 'r4') {
      const intro = tracks.findIndex((t) =>
        t.kind === 'intro' || t.id === 'r4-intro' || /^r4-intro/.test(t.id) ||
        /you the one for me/i.test(t.title));
      if (intro >= 0) return intro;
    }
    return 0;
  };

  // ---------------------------------------------------------------------------
  // Audio
  // ---------------------------------------------------------------------------
  const effectiveVolume = () => (state.muted ? 0 : state.volume);

  const stopFade = () => {
    if (fadeTimer) { clearInterval(fadeTimer); fadeTimer = 0; }
  };

  const applyVolume = () => {
    if (!audio) return;
    audio.volume = clamp(effectiveVolume(), 0, 1);
  };

  const fadeToTarget = (target, ms) => {
    stopFade();
    if (!audio) return;
    if (REDUCED || !ms) { audio.volume = clamp(target, 0, 1); return; }
    const started = performance.now();
    audio.volume = 0;
    fadeTimer = setInterval(() => {
      if (!audio) { stopFade(); return; }
      const k = Math.min(1, (performance.now() - started) / ms);
      audio.volume = clamp(target * k, 0, 1);
      if (k >= 1) stopFade();
    }, 40);
  };

  const ensureAudio = () => {
    if (audio) return audio;
    audio = new Audio();
    audio.preload = 'auto';
    applyVolume();
    audio.addEventListener('play', () => {
      state.playing = true;
      state.needsGesture = false;
      updateUI();
    });
    audio.addEventListener('playing', () => {
      state.failStreak = 0;
    });
    audio.addEventListener('pause', () => {
      state.playing = false;
      updateUI();
    });
    audio.addEventListener('ended', onEnded);
    audio.addEventListener('error', onAudioError);
    audio.addEventListener('timeupdate', updateClock);
    audio.addEventListener('loadedmetadata', () => {
      if (state.track && Number.isFinite(audio.duration) && audio.duration > 0) {
        state.track.duration = audio.duration;
      }
      updateClock();
    });
    return audio;
  };

  const ensureAudioContext = () => {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return null;
    try {
      if (!audioCtx || audioCtx.state === 'closed') audioCtx = new Ctx();
      if (audioCtx.state === 'suspended') audioCtx.resume().catch(() => {});
      state.audioContextState = audioCtx.state;
    } catch {
      state.audioContextState = 'unavailable';
    }
    return audioCtx;
  };

  const applyTrackDuration = () => {
    if (!audio) return 0;
    if (Number.isFinite(audio.duration) && audio.duration > 0) return audio.duration;
    return state.track && state.track.duration ? state.track.duration : 0;
  };

  const attemptPlay = async (opts) => {
    const options = opts || {};
    const a = ensureAudio();
    if (!state.track || !a.src) {
      state.error = 'NO TRACK SELECTED';
      updateUI();
      return false;
    }
    try {
      if (options.fadeIn && !state.muted) fadeToTarget(effectiveVolume(), 620);
      else applyVolume();
      await a.play();
      state.userPaused = false;
      state.needsGesture = false;
      state.error = '';
      state.playing = true;
      updateUI();
      return true;
    } catch (err) {
      stopFade();
      applyVolume();
      state.playing = false;
      state.needsGesture = !!(err && (err.name === 'NotAllowedError' || err.name === 'SecurityError'));
      const allFailed = state.tracks.length > 0 && state.failStreak >= state.tracks.length;
      state.error = allFailed
        ? 'SOUNDTRACK OFFLINE — CHECK /music'
        : state.needsGesture ? 'AUDIO BLOCKED — PRESS PLAY' : 'PLAYBACK FAILED — PRESS PLAY';
      updateUI();
      toast(state.error + (err && err.message ? ` · ${err.message}` : ''));
      return false;
    }
  };

  const loadTrack = (index, opts) => {
    const options = opts || {};
    const total = state.tracks.length;
    if (!total) return false;

    stopFade();
    state.index = ((Math.trunc(index) % total) + total) % total;
    state.track = state.tracks[state.index];
    state.error = '';
    state.loadToken += 1;
    const token = state.loadToken;

    const a = ensureAudio();
    try { a.pause(); } catch { /* ignore */ }
    a.src = state.track.url;
    applyVolume();
    try { a.load(); } catch { /* ignore */ }
    updateUI();

    if (options.autoplay) {
      // If a stale error fires from the previous source, onAudioError compares
      // state.track before skipping, so this is safe.
      attemptPlay({ fadeIn: !!options.fadeIn });
    } else {
      state.playing = false;
      updateUI();
    }
    return token > 0;
  };

  const onEnded = () => {
    // The cabinet always opens on the R4 intro, then hands over to the game
    // that was active when ENTER was pressed.
    if (state.introThenGame) {
      const nextGame = state.introThenGame;
      state.introThenGame = null;
      state.tracks = [];
      state.track = null;
      state.index = 0;
      applyGame(nextGame, { force: true, fadeIn: true, source: 'intro-handoff' });
      return;
    }
    if (!state.tracks.length) return;
    if (!LOOP_PLAYLIST && state.index >= state.tracks.length - 1) {
      state.userPaused = true;
      state.playing = false;
      updateUI();
      return;
    }
    if (state.userPaused) return;
    loadTrack(state.index + 1, { autoplay: true });
  };

  const onAudioError = () => {
    const failedTrack = state.track;
    if (!failedTrack || !state.ready) return;
    if (!state.failed.has(failedTrack.url)) {
      state.failed.add(failedTrack.url);
      const code = audio && audio.error ? audio.error.code : 'unknown';
      console.warn('[rr4-music] could not load', failedTrack.url, 'code', code);
    }
    state.failStreak += 1;
    if (state.failStreak >= state.tracks.length) {
      state.playing = false;
      state.error = 'SOUNDTRACK OFFLINE — CHECK /music';
      updateUI();
      toast(state.error);
      return;
    }
    const token = state.loadToken;
    window.setTimeout(() => {
      if (token !== state.loadToken) return;
      loadTrack(state.index + 1, { autoplay: !state.userPaused });
    }, 220);
  };

  // ---------------------------------------------------------------------------
  // Controls
  // ---------------------------------------------------------------------------
  const persistEntry = () => {
    state.entered = true;
    rememberEntered();
  };

  const play = async () => {
    if (!state.ready || state.offline || state.noTracks) return false;
    ensureAudioContext();
    persistEntry();
    if (state.gateOpen) hideGate();
    if (!state.track && state.tracks.length) {
      loadTrack(startIndexFor(state.game, state.tracks), { autoplay: false });
    }
    state.userPaused = false;
    const ok = await attemptPlay({ fadeIn: true });
    updateUI();
    return ok;
  };

  const pause = () => {
    state.userPaused = true;
    stopFade();
    if (audio) { try { audio.pause(); } catch { /* ignore */ } }
    state.playing = false;
    updateUI();
  };

  const togglePlay = () => (state.playing ? (pause(), true) : play());

  const goNext = (auto) => {
    if (!state.ready || !state.tracks.length) return false;
    const shouldPlay = state.entered && !state.userPaused;
    return loadTrack(state.index + 1, { autoplay: shouldPlay, fadeIn: false, auto: !!auto });
  };

  const goPrev = () => {
    if (!state.ready || !state.tracks.length) return false;
    if (audio && audio.currentTime > 3) {
      try { audio.currentTime = 0; } catch { /* ignore */ }
      if (!state.userPaused) attemptPlay();
      return true;
    }
    const shouldPlay = state.entered && !state.userPaused;
    return loadTrack(state.index - 1, { autoplay: shouldPlay, fadeIn: false });
  };

  const setVolume = (value) => {
    stopFade();
    state.volume = clamp(Number(value), 0, 1);
    if (state.volume > 0) state.muted = false;
    applyVolume();
    write(VOLUME_KEY, state.volume);
    write(MUTED_KEY, state.muted ? '1' : '0');
    updateUI();
  };

  const setMuted = (muted) => {
    stopFade();
    state.muted = !!muted;
    applyVolume();
    write(MUTED_KEY, state.muted ? '1' : '0');
    updateUI();
  };

  const setExpanded = (expanded) => {
    state.expanded = !!expanded;
    if (!player) return;
    player.dataset.expanded = String(state.expanded);
    if (els.toggle) {
      els.toggle.setAttribute('aria-expanded', String(state.expanded));
      els.toggle.setAttribute('aria-label', state.expanded ? 'Collapse music player' : 'Expand music player');
    }
  };

  const toast = (message) => {
    if (!message) return;
    if (!toastEl) {
      toastEl = document.createElement('div');
      toastEl.className = 'rr4m-toast';
      toastEl.id = 'rr4m-toast';
      toastEl.setAttribute('role', 'status');
      toastEl.setAttribute('aria-live', 'polite');
      document.body.appendChild(toastEl);
    }
    toastEl.textContent = String(message);
    toastEl.classList.add('is-on');
    window.clearTimeout(toastTimer);
    toastTimer = window.setTimeout(() => {
      if (toastEl) toastEl.classList.remove('is-on');
    }, 6000);
  };

  // ---------------------------------------------------------------------------
  // Gate
  // ---------------------------------------------------------------------------
  const buildGate = () => {
    const host = mount('rr4-music-gate');
    host.innerHTML = `
      <div class="rr4m-gate" role="dialog" aria-modal="true" aria-labelledby="rr4m-gate-title" aria-describedby="rr4m-gate-copy" hidden>
        <div class="rr4m-gate-panel">
          <button class="rr4m-gate-close" type="button" aria-label="Skip audio and close the cabinet gate">&times;</button>
          <p class="rr4m-gate-kicker">RIDGE RACER TYPE 4 // CABINET LINK</p>
          <h1 class="rr4m-gate-title" id="rr4m-gate-title"><span>RIDGE</span><span>RACER</span><em>Type 4</em></h1>
          <p class="rr4m-gate-lead">ENTER THE CABINET</p>
          <div class="rr4m-gate-allowance">AUDIO ALLOWANCE</div>
          <p class="rr4m-gate-copy" id="rr4m-gate-copy">Starts with You The One For Me (R4 intro), then the active game's soundtrack.</p>
          <button class="rr4m-gate-enter" type="button">
            <span>ENTER</span><span class="rr4m-gate-enter-ico" aria-hidden="true">&#9656;</span>
          </button>
          <button class="rr4m-gate-skip" type="button">SKIP AUDIO</button>
          <p class="rr4m-gate-msg" role="status" aria-live="polite"></p>
          <p class="rr4m-gate-hint">Click to unlock browser audio &middot; no autoplay before ENTER</p>
        </div>
      </div>`;
    gate = host.querySelector('.rr4m-gate');
    els.gateEnter = gate.querySelector('.rr4m-gate-enter');
    els.gateSkip = gate.querySelector('.rr4m-gate-skip');
    els.gateClose = gate.querySelector('.rr4m-gate-close');
    els.gateMsg = gate.querySelector('.rr4m-gate-msg');
    const gateAction = (fn) => (event) => {
      // Keep the unlock click from falling through to the emulator canvas,
      // which can open the EJS pause menu on phones.
      event.preventDefault();
      event.stopPropagation();
      fn();
    };
    els.gateEnter.addEventListener('click', gateAction(enterCabinet));
    els.gateSkip.addEventListener('click', gateAction(skipAudio));
    els.gateClose.addEventListener('click', gateAction(skipAudio));
    gate.addEventListener('keydown', onGateKeydown);
  };

  const showGate = () => {
    if (!gate || state.entered || state.offline || state.noTracks) return;
    state.gateOpen = true;
    gate.hidden = false;
    document.body.classList.add('rr4m-gate-open');
    updateUI();
    window.setTimeout(() => {
      if (state.gateOpen && els.gateEnter) els.gateEnter.focus({ preventScroll: true });
    }, REDUCED ? 0 : 60);
  };

  const hideGate = () => {
    if (!gate || !state.gateOpen) {
      if (gate) { gate.hidden = true; gate.classList.remove('is-leaving'); }
      document.body.classList.remove('rr4m-gate-open');
      return;
    }
    state.gateOpen = false;
    document.body.classList.remove('rr4m-gate-open');
    gate.classList.add('is-leaving');
    window.clearTimeout(gateLeaveTimer);
    gateLeaveTimer = window.setTimeout(() => {
      if (!gate) return;
      gate.hidden = true;
      gate.classList.remove('is-leaving');
    }, REDUCED ? 0 : 280);
    updateUI();
    if (player) {
      const selector = state.expanded ? '.rr4m-btn-play' : '.rr4m-toggle';
      const focusTarget = player.querySelector(selector);
      if (focusTarget) window.setTimeout(() => focusTarget.focus({ preventScroll: true }), 60);
    }
  };

  const enterCabinet = async () => {
    if (!state.ready) { toast('AUDIO MANIFEST STILL LOADING'); return; }
    ensureAudioContext(); // keep this inside the click gesture
    persistEntry();
    state.userPaused = false;

    // Start with "You The One For Me" even when the selected game is Rage
    // Racer or Ridge Racer, then hand the playlist over to the active game.
    const intro = findR4IntroTrack();
    if (intro && state.game !== 'r4') {
      state.introThenGame = state.game;
      state.tracks = [intro];
      state.index = 0;
      state.failed = new Set();
      state.failStreak = 0;
      loadTrack(0, { autoplay: false });
    } else if (!state.track && state.tracks.length) {
      loadTrack(startIndexFor(state.game, state.tracks), { autoplay: false });
    }
    if (els.gateMsg) {
      els.gateMsg.textContent = 'LINKING AUDIO...';
      els.gateMsg.removeAttribute('data-tone');
    }
    hideGate();
    await attemptPlay({ fadeIn: true });
  };

  const skipAudio = () => {
    persistEntry();
    state.userPaused = true;
    if (state.ready && !state.track && state.tracks.length) {
      loadTrack(startIndexFor(state.game, state.tracks), { autoplay: false });
    }
    hideGate();
    toast('AUDIO SKIPPED — PRESS PLAY ANY TIME');
    updateUI();
  };

  const onGateKeydown = (event) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      skipAudio();
      return;
    }
    if (event.key !== 'Tab' || !gate) return;
    const focusables = Array.from(gate.querySelectorAll('button:not([disabled])'))
      .filter((el) => el.offsetParent !== null);
    if (!focusables.length) return;
    const first = focusables[0];
    const last = focusables[focusables.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  };

  // ---------------------------------------------------------------------------
  // Persistent player
  // ---------------------------------------------------------------------------
  const buildPlayer = () => {
    const host = mount('rr4-music-player');
    host.innerHTML = `
      <section class="rr4m" id="rr4m" data-expanded="true" data-state="loading" aria-label="Ridge Racer music player" hidden>
        <div class="rr4m-head">
          <button class="rr4m-toggle" type="button" aria-expanded="true" aria-controls="rr4m-body" aria-label="Collapse music player">
            <span class="rr4m-dot" aria-hidden="true"></span>
            <span class="rr4m-mini">
              <span class="rr4m-kicker">NOW PLAYING</span>
              <span class="rr4m-title">AUDIO LINK...</span>
              <span class="rr4m-game">RIDGE RACER</span>
            </span>
          </button>
          <button class="rr4m-mini-play" type="button" data-act="play" aria-label="Play music" aria-pressed="false">
            <span class="rr4m-ico" aria-hidden="true">&#9654;</span>
          </button>
        </div>
        <div class="rr4m-progress" aria-hidden="true"><i></i></div>
        <div class="rr4m-body" id="rr4m-body">
          <div class="rr4m-row">
            <button class="rr4m-btn" type="button" data-act="prev" aria-label="Previous track">&#9664;&#9664;</button>
            <button class="rr4m-btn rr4m-btn-play" type="button" data-act="play" aria-label="Play music" aria-pressed="false">
              <span class="rr4m-ico" aria-hidden="true">&#9654;</span>
            </button>
            <button class="rr4m-btn" type="button" data-act="next" aria-label="Next track">&#9654;&#9654;</button>
            <div class="rr4m-vol">
              <button class="rr4m-btn rr4m-btn-mute" type="button" data-act="mute" aria-label="Mute music" aria-pressed="false">VOL</button>
              <input class="rr4m-range" type="range" min="0" max="100" step="1" value="42" aria-label="Music volume" />
            </div>
          </div>
          <div class="rr4m-meta">
            <span class="rr4m-meta-game">RIDGE RACER</span>
            <span class="rr4m-time">--:-- / --:--</span>
          </div>
          <p class="rr4m-status" role="status" aria-live="polite"></p>
        </div>
      </section>`;
    player = host.querySelector('.rr4m');
    els.toggle = player.querySelector('.rr4m-toggle');
    els.title = player.querySelector('.rr4m-title');
    els.game = player.querySelector('.rr4m-game');
    els.metaGame = player.querySelector('.rr4m-meta-game');
    els.time = player.querySelector('.rr4m-time');
    els.count = player.querySelector('.rr4m-count');
    els.status = player.querySelector('.rr4m-status');
    els.progress = player.querySelector('.rr4m-progress i');
    els.playButtons = Array.from(player.querySelectorAll('[data-act="play"]'));
    els.range = player.querySelector('.rr4m-range');
    els.mute = player.querySelector('[data-act="mute"]');
    els.prev = player.querySelector('[data-act="prev"]');
    els.next = player.querySelector('[data-act="next"]');

    els.toggle.addEventListener('click', () => {
      if (state.offline || state.noTracks) { retryManifest(); return; }
      state.expandTouched = true;
      setExpanded(!state.expanded);
    });
    els.playButtons.forEach((button) => button.addEventListener('click', togglePlay));
    els.prev.addEventListener('click', goPrev);
    els.next.addEventListener('click', () => goNext(false));
    els.mute.addEventListener('click', () => setMuted(!state.muted));
    els.range.addEventListener('input', () => setVolume(Number(els.range.value) / 100));
    els.range.addEventListener('change', () => setVolume(Number(els.range.value) / 100));
    player.addEventListener('keydown', onPlayerKeydown);
    setExpanded(state.expanded);

    const compact = window.matchMedia && window.matchMedia('(max-width: 640px)');
    if (compact && typeof compact.addEventListener === 'function') {
      compact.addEventListener('change', (event) => {
        if (!state.expandTouched) setExpanded(!event.matches);
      });
    }
  };

  const onPlayerKeydown = (event) => {
    if (event.ctrlKey || event.metaKey || event.altKey) return;
    const target = event.target;
    const tag = target && target.tagName ? target.tagName : '';
    const isRange = target && target.matches && target.matches('input[type="range"]');
    if (tag === 'INPUT' && !isRange) return;

    if (event.key === 'ArrowLeft' && !isRange) {
      event.preventDefault();
      goPrev();
    } else if (event.key === 'ArrowRight' && !isRange) {
      event.preventDefault();
      goNext(false);
    } else if ((event.key === 'm' || event.key === 'M') && !isRange) {
      event.preventDefault();
      setMuted(!state.muted);
    } else if (event.key === ' ' && tag !== 'BUTTON' && !isRange) {
      event.preventDefault();
      togglePlay();
    }
  };

  const onGlobalKeydown = (event) => {
    if (event.altKey && (event.key === 'm' || event.key === 'M') && !event.ctrlKey && !event.metaKey) {
      event.preventDefault();
      setMuted(!state.muted);
    }
  };

  // ---------------------------------------------------------------------------
  // UI state
  // ---------------------------------------------------------------------------
  const statusText = () => {
    if (state.offline) return 'MUSIC OFFLINE — RETRY';
    if (state.noTracks) return 'MUSIC OFFLINE — NO TRACKS';
    if (!state.ready) return 'LINKING AUDIO...';
    if (state.error) return state.error;
    if (state.needsGesture) return 'PRESS PLAY TO UNLOCK AUDIO';
    if (state.playing) return 'ON AIR · LOOPING SIDE';
    if (state.userPaused) return 'PAUSED · PRESS PLAY';
    return 'AUDIO ARMED';
  };

  const fmtTime = (seconds) => {
    if (!Number.isFinite(seconds) || seconds < 0) return '--:--';
    const whole = Math.floor(seconds);
    const minutes = Math.floor(whole / 60);
    const secs = whole % 60;
    return `${minutes}:${String(secs).padStart(2, '0')}`;
  };

  const updateClock = () => {
    if (!els.time) return;
    const duration = applyTrackDuration();
    const current = audio ? (audio.currentTime || 0) : 0;
    els.time.textContent = `${fmtTime(current)} / ${fmtTime(duration)}`;
    if (els.progress) {
      const pct = duration > 0 ? clamp((current / duration) * 100, 0, 100) : 0;
      els.progress.style.width = `${pct.toFixed(1)}%`;
    }
    try {
      if ('mediaSession' in navigator && typeof navigator.mediaSession.setPositionState === 'function' &&
          duration > 0 && Number.isFinite(current)) {
        navigator.mediaSession.setPositionState({
          duration: Math.max(duration, 0.001),
          playbackRate: 1,
          position: clamp(current, 0, Math.max(duration - 0.001, 0)),
        });
      }
    } catch { /* ignore */ }
  };

  const updateMediaSession = () => {
    if (!('mediaSession' in navigator) || !state.track) {
      if ('mediaSession' in navigator) {
        try { navigator.mediaSession.playbackState = state.playing ? 'playing' : 'paused'; } catch { /* ignore */ }
      }
      return;
    }
    try {
      if (typeof window.MediaMetadata === 'function') {
        navigator.mediaSession.metadata = new window.MediaMetadata({
          title: state.track.title,
          artist: state.gameTitle || 'Ridge Racer',
          album: state.game === 'r4' ? 'Ridge Racer Type 4' : (state.gameTitle || 'Ridge Racer'),
        });
      }
      navigator.mediaSession.playbackState = state.playing ? 'playing' : 'paused';
    } catch { /* ignore */ }
  };

  const updateUI = () => {
    if (!player) return;
    const gameTitle = state.gameTitle || (state.manifest && state.manifest.games[state.game]
      ? state.manifest.games[state.game].title : 'RIDGE RACER');
    const total = state.tracks.length;
    const count = total ? `${state.index + 1}/${total}` : '--/--';
    const unavailable = state.offline || state.noTracks;
    const title = unavailable ? 'MUSIC OFFLINE' : (state.track ? state.track.title : 'AUDIO LINK...');

    els.title.textContent = title;
    els.title.title = title;
    els.game.textContent = state.offline
      ? 'MANIFEST UNAVAILABLE'
      : state.noTracks ? 'NO TRACKS FOR THIS GAME' : gameTitle.toUpperCase();
    els.metaGame.textContent = state.offline
      ? 'MANIFEST UNAVAILABLE'
      : state.noTracks ? 'NO TRACKS FOR THIS GAME' : `${gameTitle.toUpperCase()} · SIDE ${count}`;
    els.status.textContent = statusText();
    els.status.dataset.tone = state.error ? 'error' : '';
    els.status.hidden = !els.status.textContent;
    els.range.value = String(Math.round(state.volume * 100));
    els.range.setAttribute('aria-valuetext', `${Math.round(state.volume * 100)} percent${state.muted ? ' (muted)' : ''}`);
    els.mute.textContent = state.muted ? 'MUTE' : 'VOL';
    els.mute.setAttribute('aria-label', state.muted ? 'Unmute music' : 'Mute music');
    els.mute.setAttribute('aria-pressed', String(state.muted));

    const label = state.playing ? 'Pause music' : 'Play music';
    const icon = state.playing ? '\u275A\u275A' : '\u25B6';
    els.playButtons.forEach((button) => {
      button.setAttribute('aria-label', label);
      button.setAttribute('aria-pressed', String(state.playing));
      const glyph = button.querySelector('.rr4m-ico');
      if (glyph) glyph.textContent = icon;
    });

    let mode = 'ready';
    if (unavailable) mode = 'offline';
    else if (!state.ready) mode = 'loading';
    else if (state.error && !state.playing) mode = 'error';
    else if (state.playing) mode = 'playing';
    else if (state.needsGesture) mode = 'blocked';
    else if (state.userPaused) mode = 'paused';
    player.dataset.state = mode;
    player.dataset.expanded = String(state.expanded);
    player.hidden = unavailable ? false : (!state.ready || (!state.entered && state.gateOpen));
    els.toggle.setAttribute('aria-expanded', String(unavailable ? false : state.expanded));
    els.toggle.setAttribute('aria-label', state.offline
      ? 'Music offline. Retry manifest.'
      : state.noTracks ? 'No tracks for this game. Retry manifest.'
        : (state.expanded ? 'Collapse music player' : 'Expand music player'));
    els.toggle.title = state.offline || state.noTracks
      ? 'Retry soundtrack manifest'
      : (state.expanded ? 'Collapse player' : 'Expand player');
    updateMediaSession();
    updateClock();
  };

  // ---------------------------------------------------------------------------
  // Game switching
  // ---------------------------------------------------------------------------
  const applyGame = (key, opts) => {
    const options = opts || {};
    if (!state.manifest || !state.manifest.games[key]) return false;
    const game = state.manifest.games[key];
    const changed = state.game !== key;
    if (changed) state.introThenGame = null;

    state.game = key;
    state.gameTitle = game.title;
    state.tracks = game.tracks;
    state.noTracks = game.tracks.length === 0;
    state.failed = new Set();
    state.failStreak = 0;
    state.index = startIndexFor(key, game.tracks);
    state.track = null;
    state.error = '';
    state.loadToken += 1;

    // Theme hook: other agents key their CSS off body[data-game].
    const theme = game.theme || key;
    if (document.body.dataset.game !== theme) document.body.dataset.game = theme;

    const select = document.getElementById('gameSelect');
    if (options.syncSelect !== false && select && select.value !== key) {
      const hasOption = Array.from(select.options || []).some((opt) => opt.value === key);
      if (hasOption) select.value = key;
    }

    if (state.noTracks) {
      stopFade();
      state.playing = false;
      if (audio) {
        try { audio.pause(); } catch { /* ignore */ }
        try { audio.removeAttribute('src'); audio.load(); } catch { /* ignore */ }
      }
      if (state.gateOpen) hideGate();
      updateUI();
      return true;
    }

    if (!changed && options.force !== true) {
      updateUI();
      return true;
    }

    const shouldAutoplay = state.entered && !state.userPaused;
    loadTrack(state.index, {
      autoplay: shouldAutoplay,
      fadeIn: options.fadeIn === true && shouldAutoplay,
    });
    if (!state.entered && !state.gateOpen) showGate();
    updateUI();
    return true;
  };

  const setGame = (key) => {
    const normalised = String(key || '').toLowerCase();
    if (!state.manifest || !state.manifest.games[normalised]) return false;
    return applyGame(normalised, { fadeIn: true, source: 'api' });
  };

  const inferBrandGame = (text) => {
    const label = String(text || '').replace(/\s+/g, ' ').toUpperCase();
    if (/TYPE\s*4/.test(label)) return 'r4';
    if (/RAGE\s*RACER/.test(label)) return 'rage';
    if (/RIDGE\s*RACER/.test(label)) return 'ridge';
    return null;
  };

  const startObservers = () => {
    if (observersStarted) return;
    observersStarted = true;

    const select = document.getElementById('gameSelect');
    if (select) {
      select.addEventListener('change', () => {
        const key = String(select.value || '').toLowerCase();
        if (state.manifest && state.manifest.games[key]) {
          applyGame(key, { fadeIn: true, source: 'select', syncSelect: false });
        }
      });
    }

    const brand = document.getElementById('brandGame');
    const observer = new MutationObserver((records) => {
      if (!state.manifest) return;

      const bodyRecord = records.some((r) => r.type === 'attributes' && r.target === document.body);
      if (bodyRecord) {
        const fromTheme = themeToGame(document.body.dataset.game);
        if (fromTheme && fromTheme !== state.game) {
          applyGame(fromTheme, { fadeIn: true, source: 'body', syncSelect: true });
          return;
        }
      }

      if (!brand) return;
      const brandChanged = records.some((r) => r.type !== 'attributes' &&
        (r.target === brand || brand.contains(r.target)));
      if (!brandChanged) return;
      const inferred = inferBrandGame(brand.textContent);
      if (inferred && state.manifest.games[inferred] && inferred !== state.game) {
        applyGame(inferred, { fadeIn: true, source: 'brand' });
      }
    });
    observer.observe(document.body, { attributes: true, attributeFilter: ['data-game'] });
    if (brand) observer.observe(brand, { childList: true, subtree: true, characterData: true });

    document.addEventListener('keydown', onGlobalKeydown);
  };

  // ---------------------------------------------------------------------------
  // Boot / retry
  // ---------------------------------------------------------------------------
  const applyManifest = (manifest) => {
    state.manifest = manifest;
    state.offline = false;
    state.ready = true;
    state.error = '';
    const key = resolveGameKey(manifest);
    applyGame(key, { fadeIn: false, force: true, syncSelect: false });
    if (!state.entered) showGate();
    updateUI();
    startObservers();
  };

  const retryManifest = async () => {
    if (state.offline || state.noTracks) {
      state.offline = false;
      state.noTracks = false;
      state.ready = false;
      state.error = '';
      updateUI();
    }
    const manifest = await loadManifest();
    if (!manifest) {
      state.ready = true;
      state.offline = true;
      if (gate) gate.hidden = true;
      document.body.classList.remove('rr4m-gate-open');
      updateUI();
      return;
    }
    applyManifest(manifest);
  };

  const boot = async () => {
    // Inside the cabinet shell the parent owns the soundtrack and the gate.
    // Do not create a second audio element or a second ENTER overlay.
    if (window.self !== window.top) {
      if (!document.body.dataset.game) document.body.dataset.game = 'r4';
      state.offline = true;
      state.ready = true;
      return;
    }
    buildGate();
    buildPlayer();

    // Media session handlers are harmless when unsupported.
    try {
      if ('mediaSession' in navigator) {
        navigator.mediaSession.setActionHandler('play', () => { play(); });
        navigator.mediaSession.setActionHandler('pause', () => { pause(); });
        navigator.mediaSession.setActionHandler('nexttrack', () => { goNext(false); });
        navigator.mediaSession.setActionHandler('previoustrack', () => { goPrev(); });
      }
    } catch { /* ignore */ }

    const manifest = await loadManifest();
    if (!manifest) {
      state.ready = true;
      state.offline = true;
      updateUI();
      return;
    }
    applyManifest(manifest);
  };

  const getState = () => ({
    ready: state.ready,
    offline: state.offline,
    noTracks: state.noTracks,
    entered: state.entered,
    gateOpen: state.gateOpen,
    game: state.game,
    gameTitle: state.gameTitle,
    theme: document.body ? (document.body.dataset.game || null) : null,
    index: state.index,
    track: state.track ? {
      id: state.track.id,
      title: state.track.title,
      url: state.track.url,
      kind: state.track.kind,
      duration: state.track.duration,
    } : null,
    trackCount: state.tracks.length,
    playing: state.playing,
    paused: !state.playing,
    userPaused: state.userPaused,
    needsGesture: state.needsGesture,
    volume: state.volume,
    muted: state.muted,
    error: state.error || null,
    source: state.source,
    audioContext: state.audioContextState,
    loop: LOOP_PLAYLIST,
  });

  const skipToEnd = () => {
    if (!audio || !Number.isFinite(audio.duration) || audio.duration <= 0) return false;
    try { audio.currentTime = Math.max(0, audio.duration - 0.05); } catch { return false; }
    return true;
  };

  window.RR4Music = { getState, next: goNext, prev: goPrev, play, pause, setGame, skipToEnd };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot, { once: true });
  } else {
    boot();
  }
})();
