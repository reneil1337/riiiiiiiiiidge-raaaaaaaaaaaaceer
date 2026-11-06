/* Ridge Racer Type 4 — cabinet entry shell.
 *
 * The soundtrack lives in this parent document, so it survives every
 * navigation inside the iframe (/play, /docs, /lobby). The first ENTER click
 * is the browser audio gesture; the R4 intro always plays first.
 */

(() => {
  const $ = (sel) => document.querySelector(sel);
  const gate = $('#rr4-enter');
  const shell = $('#rr4-shell');
  const frame = $('#rr4sFrame');
  const loadOverlay = $('#rr4sLoad');
  const enterBtn = $('#rr4eEnter');
  const skipBtn = $('#rr4eSkip');
  const msg = $('#rr4eMsg');
  const gameSel = $('#rr4sGame');
  const trackEl = $('#rr4sTrack');
  const playBtn = $('#rr4sPlay');
  const prevBtn = $('#rr4sPrev');
  const nextBtn = $('#rr4sNext');
  const volEl = $('#rr4sVol');
  const toastEl = $('#rr4sToast');
  const fsBtn = $('#rr4sFs');
  const fsExit = $('#rr4sFsExit');
  const viewButtons = Array.from(document.querySelectorAll('[data-view]'));

  // Fullscreen: put the whole document in fullscreen so the shell bar can leave
  // the grid and the iframe takes the full viewport (see enter.css :fullscreen).
  const fsSupported = typeof document.documentElement.requestFullscreen === 'function';
  const syncFsUi = () => {
    const on = !!document.fullscreenElement;
    document.body.classList.toggle('is-fs', on);
    if (fsExit) fsExit.hidden = !on;
    if (fsBtn) fsBtn.setAttribute('aria-pressed', on ? 'true' : 'false');
  };
  const toggleFs = async () => {
    if (!fsSupported) { toast('FULLSCREEN NOT SUPPORTED'); return; }
    try {
      if (document.fullscreenElement) await document.exitFullscreen();
      else await document.documentElement.requestFullscreen({ navigationUI: 'hide' });
    } catch {
      toast('FULLSCREEN BLOCKED');
    }
    syncFsUi();
  };
  if (fsBtn) {
    if (!fsSupported) fsBtn.disabled = true;
    fsBtn.addEventListener('click', toggleFs);
    fsBtn.setAttribute('aria-pressed', 'false');
  }
  if (fsExit) {
    fsExit.addEventListener('click', () => {
      if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
    });
  }
  document.addEventListener('fullscreenchange', syncFsUi);
  document.addEventListener('keydown', (event) => {
    if (event.key !== 'f' && event.key !== 'F') return;
    if (event.ctrlKey || event.metaKey || event.altKey) return;
    const t = event.target;
    if (t && /^(INPUT|SELECT|TEXTAREA)$/.test(t.tagName)) return;
    event.preventDefault();
    toggleFs();
  });

  const VOLUME_KEY = 'rr4-shell-volume';
  const DEFAULT_VOLUME = 0.42;
  const LOOP = true;
  // The soundtrack must not fight the race audio. While a /play* view is in the
  // frame the parent track keeps playing, but at a background level.
  const RACE_DUCK = 0.22;

  // Race Day (the 50-driver MMO room) is a plain same-origin iframe view, like
  // /welcome: it never ducks the cabinet soundtrack and never owns an <audio>.
  const RACE_DAY_PATH = '/race-day';

  // Views whose iframe keeps the shell's F/Escape shortcut. The mirroring is
  // same-origin only, so a new view must be listed here to keep F working while
  // the frame owns the focus. /race-day is same-origin, so F keeps working.
  const KEY_MIRROR_PATHS = [
    '/play', '/play-net', '/welcome', '/games', '/multiplayer', '/lobby',
    '/docs', '/race-day',
  ];

  const state = {
    manifest: null,
    game: 'r4',
    // Always start at the ENTER gate. A refresh must never skip the
    // audio-permission gesture or drop the player straight into a game.
    entered: false,
    userPaused: false,
    tracks: [],
    index: 0,
    track: null,
    playing: false,
    introThenGame: null,
    view: 'welcome',
    // Invite link: /?mmo=1 or /?party=ABCD lands the driver in the Race Day queue.
    mmo: false,
    party: null,
    volume: clamp(Number(localStorage.getItem(VOLUME_KEY) || DEFAULT_VOLUME), 0, 1),
  };

  let audio = null;
  let toastTimer = 0;
  let frameHooked = false;

  function clamp(n, min, max) {
    return Math.max(min, Math.min(max, Number.isFinite(n) ? n : min));
  }

  function toast(text) {
    if (!toastEl) return;
    toastEl.textContent = String(text || '');
    toastEl.classList.add('is-on');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toastEl.classList.remove('is-on'), 5200);
  }

  function setMsg(text) {
    if (msg) msg.textContent = String(text || '');
  }

  function manifestGame(key) {
    return state.manifest && state.manifest.games && state.manifest.games[key];
  }

  function normaliseTrack(t) {
    if (!t || !t.file) return null;
    const file = String(t.file).replace(/\\/g, '/').replace(/^\/?music\//, '').replace(/^\//, '');
    return {
      ...t,
      file,
      url: /^https?:/i.test(file) ? file : `/music/${file}`,
      kind: t.kind || (/intro|one for me/i.test(`${t.id || ''} ${t.title || ''}`) ? 'intro' : 'track'),
    };
  }

  function normaliseManifest(raw) {
    if (!raw || !raw.games) return null;
    const games = {};
    for (const [key, game] of Object.entries(raw.games)) {
      const tracks = (game.tracks || game.playlist || game.songs || [])
        .map(normaliseTrack)
        .filter(Boolean);
      games[key] = {
        key,
        title: game.title || key.toUpperCase(),
        theme: game.theme || key,
        tracks,
      };
    }
    if (!games.r4) return null;
    return { defaultGame: raw.defaultGame || 'r4', games };
  }

  async function loadManifest() {
    for (const url of ['/api/music', '/music/manifest.json']) {
      try {
        const res = await fetch(url, { cache: 'no-cache' });
        if (!res.ok) continue;
        const data = normaliseManifest(await res.json());
        if (data) return data;
      } catch {
        // try the next source
      }
    }
    return null;
  }

  function tracksFor(key) {
    const game = manifestGame(key);
    return game ? game.tracks : [];
  }

  function findIntro() {
    const r4 = manifestGame('r4');
    if (!r4) return null;
    return r4.tracks.find((t) =>
      t.kind === 'intro' || t.id === 'r4-intro' || /^r4-intro/.test(t.id || '') ||
      /you the one for me/i.test(t.title || '')) || null;
  }

  function startIndex(key) {
    if (key === 'r4') {
      const i = tracksFor('r4').findIndex((t) =>
        t.kind === 'intro' || t.id === 'r4-intro' || /^r4-intro/.test(t.id || '') ||
        /you the one for me/i.test(t.title || ''));
      if (i >= 0) return i;
    }
    return 0;
  }

  function ensureAudio() {
    if (audio) return audio;
    audio = new Audio();
    audio.preload = 'metadata';
    audio.volume = effectiveVolume();
    audio.addEventListener('playing', () => {
      state.playing = true;
      syncPlayer();
    });
    audio.addEventListener('pause', () => {
      state.playing = false;
      syncPlayer();
    });
    audio.addEventListener('ended', onEnded);
    audio.addEventListener('error', () => {
      if (!state.tracks.length) return;
      toast('TRACK UNAVAILABLE // SKIPPING');
      setTimeout(() => next(true), 250);
    });
    return audio;
  }

  const isRaceView = () => typeof state.view === 'string' && state.view.indexOf('play') === 0;

  function effectiveVolume() {
    const base = clamp(state.volume, 0, 1);
    return clamp(isRaceView() ? base * RACE_DUCK : base, 0, 1);
  }

  function applyVolume() {
    if (audio) audio.volume = effectiveVolume();
    if (volEl && String(volEl.value) !== String(Math.round(state.volume * 100))) {
      volEl.value = String(Math.round(state.volume * 100));
    }
  }

  function syncPlayer() {
    if (trackEl) {
      trackEl.textContent = state.track
        ? `${state.track.title || state.track.id || 'TRACK'}`
        : 'AUDIO LINK...';
    }
    if (playBtn) {
      playBtn.textContent = state.playing ? '❚❚' : '▶';
      playBtn.setAttribute('aria-pressed', String(state.playing));
      playBtn.setAttribute('aria-label', state.playing ? 'Pause music' : 'Play music');
    }
    document.body.dataset.game = state.game;
    if (gameSel && gameSel.value !== state.game) gameSel.value = state.game;
  }

  function loadTrack(index, autoplay) {
    if (!state.tracks.length) return false;
    const total = state.tracks.length;
    state.index = ((Math.trunc(index) % total) + total) % total;
    state.track = state.tracks[state.index];
    const a = ensureAudio();
    a.pause();
    a.src = state.track.url;
    applyVolume();
    syncPlayer();
    if (autoplay) {
      a.play()
        .then(() => { state.playing = true; syncPlayer(); })
        .catch((err) => {
          state.playing = false;
          syncPlayer();
          const blocked = err && (err.name === 'NotAllowedError' || err.name === 'SecurityError');
          toast(blocked ? 'AUDIO BLOCKED // PRESS PLAY' : 'AUDIO ERROR // PRESS PLAY');
        });
    }
    return true;
  }

  function play() {
    if (!state.tracks.length) return;
    state.userPaused = false;
    const a = ensureAudio();
    if (!state.track) loadTrack(startIndex(state.game), false);
    a.play()
      .then(() => { state.playing = true; syncPlayer(); })
      .catch(() => toast('AUDIO BLOCKED // PRESS PLAY'));
  }

  function pause() {
    state.userPaused = true;
    if (audio) audio.pause();
    state.playing = false;
    syncPlayer();
  }

  function next(auto) {
    if (!state.tracks.length) return;
    const atEnd = state.index >= state.tracks.length - 1;
    if (auto && !LOOP && atEnd) {
      state.playing = false;
      syncPlayer();
      return;
    }
    loadTrack(state.index + 1, !state.userPaused);
  }

  function prev() {
    if (!state.tracks.length) return;
    if (audio && audio.currentTime > 3) {
      audio.currentTime = 0;
      if (!state.userPaused) play();
      return;
    }
    loadTrack(state.index - 1, !state.userPaused);
  }

  function onEnded() {
    if (state.introThenGame) {
      const handoff = state.introThenGame;
      state.introThenGame = null;
      setGame(handoff, { autoplay: true, navigate: false, force: true });
      return;
    }
    if (state.userPaused) return;
    next(true);
  }

  function setGame(key, opts) {
    const options = opts || {};
    if (!manifestGame(key)) return false;
    const changed = state.game !== key;
    if (!changed) {
      // START on the already-active game must not restart the intro or jump
      // the playlist; CHECK DISC DECK should keep the music where it is.
      if (options.autoplay) play();
      else syncPlayer();
      return true;
    }
    state.introThenGame = null;

    state.game = key;
    state.tracks = tracksFor(key);
    state.index = startIndex(key);
    state.track = state.tracks[state.index] || null;
    state.userPaused = options.autoplay === false ? state.userPaused : false;
    document.body.dataset.game = key;
    if (gameSel) gameSel.value = key;

    if (state.entered && options.autoplay !== false) {
      loadTrack(state.index, true);
    } else {
      syncPlayer();
    }

    if (options.navigate && state.view === 'play') {
      frame.src = playUrl(key);
    } else if (state.view === 'play' && frame.contentDocument) {
      const doc = frame.contentDocument;
      if (doc.body) doc.body.dataset.game = key;
      const sel = doc.getElementById('gameSelect');
      if (sel && sel.value !== key) {
        sel.value = key;
        sel.dispatchEvent(new Event('change', { bubbles: true }));
      }
    }
    return true;
  }

  function playUrl(key) {
    // The shell iframe is not a cross-origin-isolated document, so force the
    // non-threaded PCSX core. A direct /play on localhost can still use threads.
    return `/play?game=${encodeURIComponent(key)}&embedded=1&threads=0`;
  }

  function normaliseParty(value) {
    const code = String(value || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8);
    return code || null;
  }

  // One builder for every entry into the MMO room: the nav button, the /welcome
  // card, the invite link and the in-frame click interceptor all use it, so the
  // embedded flag and the party code can never diverge.
  function raceDayUrl(params) {
    const party = normaliseParty((params && params.get && params.get('party')) || state.party);
    if (party) state.party = party;
    let url = `${RACE_DAY_PATH}?embedded=1`;
    if (party) url += `&party=${encodeURIComponent(party)}`;
    return url;
  }

  function framePath() {
    try {
      return String(frame.contentWindow.location.pathname || '').replace(/\/+$/, '');
    } catch {
      return '';
    }
  }

  function frameSearch() {
    try {
      return String(frame.contentWindow.location.search || '');
    } catch {
      return '';
    }
  }

  // The `/mp` room owns `drive` (live|ghost) and `turn` (host|guest); the shell
  // only forwards them. Read the view URL first, then the shell URL, so a
  // rematch message from an older page still keeps the drive mode it was in.
  function viewParam(name) {
    for (const search of [frameSearch(), String(location.search || '')]) {
      try {
        const value = new URLSearchParams(search).get(name);
        if (value) return value;
      } catch {
        // try the next source
      }
    }
    return '';
  }

  // Absent/unknown `mpGhost` means `live` and absent/unknown `mpTurn` means
  // `host`; never invent a ghost room or a guest turn from a bad value.
  function driveChoice(value, fallback) {
    const k = String(value || '').toLowerCase();
    return k === 'ghost' || k === 'live' ? k : fallback;
  }

  function turnChoice(value, fallback) {
    const k = String(value || '').toLowerCase();
    return k === 'host' || k === 'guest' ? k : fallback;
  }

  function setActiveView(view) {
    const previous = state.view;
    state.view = view;
    for (const btn of viewButtons) {
      const is = btn.dataset.view === view;
      btn.classList.toggle('is-active', is);
    }
    if (previous !== view) {
      applyVolume();
      if (isRaceView() && state.entered && !state.duckNoticed) {
        state.duckNoticed = true;
        toast('SOUNDTRACK DUCKED // GAME AUDIO');
      }
    }
  }

  function loadView(view, force) {
    setActiveView(view);
    if (!loadOverlay.classList.contains('is-off')) {
      // keep the current overlay animation; frame load will hide it
    } else {
      loadOverlay.classList.remove('is-off');
    }
    if (view === 'docs') frame.src = '/docs/introduction?embedded=1';
    else if (view === 'lobby') frame.src = '/lobby';
    else if (view === 'welcome') frame.src = '/welcome?embedded=1';
    else if (view === 'games') frame.src = '/games?embedded=1';
    else if (view === 'multiplayer') frame.src = '/multiplayer?embedded=1';
    else if (view === 'race-day') {
      // Same-origin iframe view: full soundtrack (no duck), one top bar.
      // Re-selecting RACE DAY while it is already open must not reload the
      // page, or the driver would drop out of the LFG queue. `force` is only
      // used when an invite code has to be applied to an open room.
      if (force || framePath() !== RACE_DAY_PATH) frame.src = raceDayUrl();
      else loadOverlay.classList.add('is-off');
    } else frame.src = playUrl(state.game);
  }

  function onFrameClick(event) {
    const a = event.target && event.target.closest ? event.target.closest('a[href]') : null;
    if (!a || a.target === '_blank' || a.hasAttribute('download')) return;
    let url;
    try { url = new URL(a.href, location.href); } catch { return; }
    if (url.origin !== location.origin) return;

    const path = url.pathname;
    // Never load the parent shell inside its own iframe.
    if (path === '/' || path === '/enter' || path === '/enter/') {
      event.preventDefault();
      loadView('games');
      return;
    }
    if (path === '/welcome' || path === '/welcome/' || path === '/welcome.html') {
      event.preventDefault();
      loadView('welcome');
      return;
    }
    if (path === '/games' || path === '/games/' || path === '/games.html') {
      event.preventDefault();
      loadView('games');
      return;
    }
    if (path === '/multiplayer' || path === '/multiplayer/' || path === '/multiplayer.html') {
      event.preventDefault();
      loadView('multiplayer');
      return;
    }
    if (path === '/lobby' || path === '/lobby/') {
      event.preventDefault();
      loadView('lobby');
      return;
    }
    if (path === '/race-day' || path === '/race-day/' || path === '/race-day.html') {
      // The /welcome hub card, the /games CTA and the /multiplayer footer line
      // all link here; keep the same view loader so the one-top-bar rule and
      // the parent-owned soundtrack still hold.
      event.preventDefault();
      const party = normaliseParty(url.searchParams.get('party'));
      if (party) state.party = party;
      if (!party && framePath() === RACE_DAY_PATH) return;
      loadView('race-day', !!party);
      return;
    }
    if (path.startsWith('/play')) {
      event.preventDefault();
      const requested = url.searchParams.get('game');
      if (manifestGame(requested)) setGame(requested, { autoplay: true, navigate: false });
      setActiveView('play');
      url.searchParams.set('embedded', '1');
      // The shell iframe is not cross-origin isolated; force the non-threaded core.
      url.searchParams.set('threads', '0');
      frame.src = path + '?' + url.searchParams.toString();
    }
  }

  function hookFrame() {
    let doc;
    try { doc = frame.contentDocument; } catch { return; }
    if (!doc || !doc.body) return;
    frameHooked = true;

    const path = frame.contentWindow.location.pathname;
    if (path.startsWith('/docs')) setActiveView('docs');
    else if (path.startsWith('/play')) setActiveView('play');
    else if (path.startsWith('/race-day')) setActiveView('race-day');
    else if (path.startsWith('/welcome')) setActiveView('welcome');
    else if (path.startsWith('/games')) setActiveView('games');
    else if (path.startsWith('/multiplayer')) setActiveView('multiplayer');
    else if (path === '/lobby') setActiveView('lobby');

    if (!doc.documentElement.dataset.rr4ShellClick) {
      doc.documentElement.dataset.rr4ShellClick = '1';
      doc.addEventListener('click', onFrameClick, true);
    }

    // Keys typed while the game has focus land in the iframe, not the shell, so
    // the shell's own F handler never fires mid-race. Mirror it into the frame
    // and handle Escape there too (same-origin, so top.document is reachable).
    // KEY_MIRROR_PATHS is the allow-list: /play*, /welcome, /docs, /multiplayer,
    // /lobby and /race-day all keep F; an unlisted frame falls back to its own F.
    if (KEY_MIRROR_PATHS.some((p) => path.startsWith(p)) && !doc.documentElement.dataset.rr4ShellKeys) {
      doc.documentElement.dataset.rr4ShellKeys = '1';
      doc.addEventListener('keydown', (event) => {
        if (event.ctrlKey || event.metaKey || event.altKey) return;
        const t = event.target;
        if (t && /^(INPUT|SELECT|TEXTAREA)$/.test(t.tagName)) return;
        if (event.key === 'f' || event.key === 'F') {
          event.preventDefault();
          toggleFs();
        } else if (event.key === 'Escape' && document.fullscreenElement) {
          document.exitFullscreen().catch(() => {});
        }
      }, true);
    }

    // One top bar only: the shell owns navigation/game switching. Hide the
    // app's own header inside the iframe and give the stage that space back.
    if ((path.startsWith('/play')) && !doc.getElementById('rr4-shell-chrome')) {
      const style = doc.createElement('style');
      style.id = 'rr4-shell-chrome';
      style.textContent = [
        '#play-bar,#play-foot{display:none!important}',
        'html,body,#play-shell{height:100%!important;overflow:hidden!important}',
        '#play-stage{padding:0!important;height:100%!important;display:flex!important;align-items:center!important;justify-content:center!important}',
        '#game{width:100%!important;height:100%!important;max-width:none!important;aspect-ratio:auto!important;border:0!important;border-radius:0!important}',
        '#game canvas{width:100%!important;height:100%!important;object-fit:contain!important}',
      ].join('\n');
      (doc.head || doc.documentElement).appendChild(style);
    }

    // Docs: the shell bar is the only top bar, so the field manual's own sticky
    // header goes away when it is embedded. The sidebar stays.
    if (path.startsWith('/docs') && !doc.getElementById('rr4-shell-docs')) {
      const style = doc.createElement('style');
      style.id = 'rr4-shell-docs';
      style.textContent = [
        'header.sticky,header[class*="sticky"]{display:none!important}',
        ':root{--header-height:0px!important}',
        'main{padding-top:0!important;margin-top:0!important}',
        'body{padding-top:0!important}',
      ].join('\n');
      (doc.head || doc.documentElement).appendChild(style);
    }

    const sel = doc.getElementById('gameSelect');
    if (sel) {
      if (manifestGame(sel.value) && sel.value !== state.game) {
        // The iframe selected a different disc (via a direct /play link):
        // follow it without starting a second audio element.
        setGame(sel.value, { autoplay: false, navigate: false });
      }
      if (!sel.dataset.rr4ShellBound) {
        sel.dataset.rr4ShellBound = '1';
        sel.addEventListener('change', () => {
          if (sel.value && sel.value !== state.game) setGame(sel.value, { autoplay: true, navigate: false });
        });
      }
    }
    doc.body.dataset.game = state.game;
  }

  async function enterCabinet(skip) {
    if (!state.manifest) {
      setMsg('AUDIO MANIFEST STILL LOADING');
      return;
    }
    state.entered = true;
    state.userPaused = !!skip;

    if (!skip) {
      const intro = findIntro();
      if (intro && state.game !== 'r4') {
        state.introThenGame = state.game;
        state.tracks = [intro];
        state.index = 0;
        state.track = intro;
        loadTrack(0, true);
      } else {
        state.tracks = tracksFor(state.game);
        state.index = startIndex(state.game);
        state.track = state.tracks[state.index] || null;
        loadTrack(state.index, true);
      }
    } else {
      state.tracks = tracksFor(state.game);
      state.index = startIndex(state.game);
      state.track = state.tracks[state.index] || null;
      loadTrack(state.index, false);
    }

    gate.classList.add('is-live');
    shell.hidden = false;
    document.body.classList.add('is-live');
    syncPlayer();
    // Invite link (?mmo=1 / ?party=ABCD): the friend pastes one URL and lands in
    // the Race Day queue instead of the hub. Everything else opens the hub.
    loadView(state.mmo || state.party ? 'race-day' : 'welcome');
    if (state.mmo || state.party) {
      toast(state.party ? `RACE DAY INVITE // PARTY ${state.party}` : 'RACE DAY // LFG QUEUE');
    }
    if (!skip) {
      const a = ensureAudio();
      try {
        await a.play();
        state.playing = true;
        syncPlayer();
      } catch (err) {
        setMsg(err && err.name === 'NotAllowedError' ? 'AUDIO BLOCKED // PRESS PLAY' : 'AUDIO ERROR // PRESS PLAY');
      }
    }
  }

  function attemptResume() {
    if (!state.entered || !state.tracks.length) return;
    state.userPaused = false;
    if (!state.track) loadTrack(startIndex(state.game), false);
    const a = ensureAudio();
    a.play().then(() => {
      state.playing = true;
      syncPlayer();
    }).catch(() => toast('PRESS PLAY TO RESUME AUDIO'));
  }

  function bind() {
    enterBtn.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      enterCabinet(false);
    });
    skipBtn.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      enterCabinet(true);
    });

    for (const btn of viewButtons) {
      btn.addEventListener('click', () => {
        const view = btn.dataset.view;
        if (view) loadView(view);
      });
    }

    gameSel.addEventListener('change', () => {
      setGame(gameSel.value, { autoplay: true, navigate: state.view === 'play' });
    });

    playBtn.addEventListener('click', () => {
      if (state.playing) pause(); else play();
    });
    prevBtn.addEventListener('click', prev);
    nextBtn.addEventListener('click', () => next(false));
    volEl.addEventListener('input', () => {
      state.volume = clamp(volEl.value / 100, 0, 1);
      localStorage.setItem(VOLUME_KEY, String(state.volume));
      applyVolume();
    });

    frame.addEventListener('load', () => {
      loadOverlay.classList.add('is-off');
      setTimeout(hookFrame, 60);
    });

    // Disc keys the cabinet can boot. The music manifest decides the theme and
    // playlist, but the netplay handoff must carry the room's disc even if that
    // manifest failed to load - falling back to r4 would boot the wrong disc.
    const DISC_KEYS = ['r4', 'rage', 'ridge'];
    const discKey = (key, fallback) => {
      const k = String(key || '').toLowerCase();
      return DISC_KEYS.includes(k) ? k : fallback;
    };

    window.addEventListener('message', (event) => {
      if (event.origin !== window.location.origin) return;
      const data = event.data;
      if (data && data.type === 'rr4-race' && data.code) {
        // Both drivers are ready; the lobby has rolled the grid. Hand both
        // browsers to the EmulatorJS 4.3 netplay page with their role. The
        // disc travels with them: the room's game picks the theme/playlist
        // here and the `/play-net?game=` key there. Unknown/missing keys fall
        // back to R4 (`mp-games.json` default).
        const gameKey = discKey(data.game, 'r4');
        setGame(gameKey, { autoplay: true, navigate: false });
        setActiveView('play');
        const role = data.role === 'host' ? 'host' : 'guest';
        const raceId = data.raceId ? `&mpRace=${encodeURIComponent(data.raceId)}` : '';
        const trackIndex = Number.isFinite(Number(data.trackIndex)) ? `&mpTrackIndex=${Number(data.trackIndex)}` : '';
        const hostCar = (data.cars || []).find((c) => c.role === 'host');
        const guestCar = (data.cars || []).find((c) => c.role === 'guest');
        const carHost = hostCar && Number.isFinite(Number(hostCar.carIndex)) ? `&mpCarHost=${Number(hostCar.carIndex)}` : '';
        const carGuest = guestCar && Number.isFinite(Number(guestCar.carIndex)) ? `&mpCarGuest=${Number(guestCar.carIndex)}` : '';
        // Drive mode rides along with the disc: a ghost room is turn-based Time
        // Trial on the host core, so the netplay page needs to know it before
        // boot. `mpGhost` is always sent (absent means live) and `mpTurn` only
        // matters for ghost rooms.
        const ghostParam = `&mpGhost=${data.drive === 'ghost' ? 'ghost' : 'live'}`;
        const turnParam = data.drive === 'ghost' ? `&mpTurn=${data.turn === 'guest' ? 'guest' : 'host'}` : '';
        const liveParam = data.drive === 'ghost' ? '&mpLiveGhost=1' : '';
        frame.src = `/play-net?embedded=1&threads=0&mpRole=${role}&mpRoom=${encodeURIComponent(data.code)}${raceId}${trackIndex}${carHost}${carGuest}&game=${encodeURIComponent(gameKey)}${ghostParam}${turnParam}${liveParam}`;
        toast(`GRID LOCKED // ${data.track || 'RANDOM TRACK'}`);
      } else if (data && data.type === 'rr4-rematch' && data.code) {
        // One-click rematch from the game page: reload the lounge with the same
        // code. The host auto-creates it, the guest auto-joins it. The disc is
        // carried through too, so a Rage/Ridge rematch does not silently fall
        // back to the R4 theme and plan tables.
        const room = String(data.code).toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 4);
        if (room.length !== 4) return;
        const role = data.role === 'host' ? 'host' : 'guest';
        const gameKey = discKey(data.game, discKey(state.game, 'r4'));
        // Ghost rooms must survive the reload or the rematch would silently
        // become a live shared car. The game page sends the next turn (it owns
        // the flip); the current `/play-net` URL carries the live values, so an
        // older message without them still keeps the mode it was racing in.
        const drive = driveChoice(data.drive, driveChoice(viewParam('drive'), driveChoice(viewParam('mpGhost'), 'live')));
        const turn = turnChoice(data.turn, turnChoice(viewParam('turn'), turnChoice(viewParam('mpTurn'), 'host')));
        setGame(gameKey, { autoplay: true, navigate: false });
        setActiveView('multiplayer');
        frame.src = `/multiplayer?room=${encodeURIComponent(room)}&host=${role === 'host' ? '1' : '0'}&embedded=1&game=${encodeURIComponent(gameKey)}&drive=${drive}&turn=${turn}`;
        toast(`REMATCH // ROOM ${room}`);
      } else if (data && data.type === 'rr4-game' && manifestGame(data.game)) {
        setGame(data.game, { autoplay: !state.userPaused, navigate: false });
      }
    });
  }

  async function boot() {
    volEl.value = String(Math.round(state.volume * 100));
    enterBtn.disabled = true;
    enterBtn.querySelector('span').textContent = 'LINKING AUDIO';
    bind();

    state.manifest = await loadManifest();
    if (!state.manifest) {
      setMsg('MUSIC MANIFEST MISSING // START THE SERVER');
      enterBtn.disabled = false;
      enterBtn.querySelector('span').textContent = 'ENTER';
      return;
    }

    const params = new URLSearchParams(location.search);
    const fromQuery = (params.get('game') || '').toLowerCase();
    if (manifestGame(fromQuery)) state.game = fromQuery;
    // Race Day invite link: ?mmo=1 (any value that reads as true) and/or a party
    // code both mean "open /race-day after ENTER". The `embedded` flag here only
    // describes the parent shell, so it is untouched.
    state.mmo = /^(1|true|yes|on)$/i.test(params.get('mmo') || '');
    state.party = normaliseParty(params.get('party'));
    state.tracks = tracksFor(state.game);
    state.index = startIndex(state.game);
    state.track = state.tracks[state.index] || null;
    document.body.dataset.game = state.game;
    gameSel.value = state.game;

    enterBtn.disabled = false;
    enterBtn.querySelector('span').textContent = 'ENTER';

  }

  window.RR4Shell = {
    getState: () => ({
      game: state.game,
      view: state.view,
      entered: state.entered,
      track: state.track && { id: state.track.id, title: state.track.title, file: state.track.file },
      playing: state.playing,
      userPaused: state.userPaused,
      volume: state.volume,
      effectiveVolume: effectiveVolume(),
      ducked: isRaceView(),
      mmo: state.mmo,
      party: state.party,
      tracks: state.tracks.length,
      time: audio ? audio.currentTime : 0,
      duration: audio && Number.isFinite(audio.duration) ? audio.duration : null,
    }),
    play, pause, next: () => next(false), prev, setGame, loadView, attemptResume,
  };

  boot();
})();
