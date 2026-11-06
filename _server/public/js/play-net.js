/* Ridge Racer Type 4 - 2P LAN netplay page (EmulatorJS 4.3.0-pre).
 *
 * This page is intentionally separate from the stable single-player /play
 * page. It pins the tested nightly snapshot at /emulator43/data/ and uses
 * the EmulatorJS 4.3 WebRTC netplay client:
 *
 *   host  -> runs the PSX core, streams canvas + audio to guests
 *   guest -> renders the host stream, sends pad/keyboard input to the host
 *
 * URL parameters:
 *   ?game=r4|rage          pick a title (default r4)
 *   ?bios=openbios|hle     BIOS choice (default openbios)
 *   ?cue=auto|direct|file  auto-cue (default), raw BIN, or the real .cue
 *   ?threads=1             request the threaded core (secure origins only)
 *   ?cache=0               disable IndexedDB disc caching (tests)
 *   ?netserver=http://...  override the relay URL (default host:3010)
 *   ?debug=1               load unminified EmulatorJS sources
 *   ?mpGhost=live|ghost    lounge drive mode (ghost = turn-based Time Trial,
 *                          Rage/Ridge only; absent/live keeps today's path)
 *   ?mpTurn=host|guest     which seat drives this run (ghost rooms only)
 *   ?mpLiveGhost=1         Route B: also drive a spare rival car slot from the
 *                          peer tape WHILE racing (Rage Racer Grand Prix /
 *                          Ridge Racer 1994 race screen). RAM stub + one word
 *                          patch at runtime, no disc patch. Ghost rooms only.
 */
(() => {
  'use strict';

  // ---------------------------------------------------------------------
  // Game manifest (same discs as the single-player page).
  // ---------------------------------------------------------------------
  const GAMES = {
    r4: {
      id: 4,
      name: 'Ridge Racer Type 4',
      subtitle: 'RIDGE RACER TYPE 4',
      region: 'USA',
      rom: '/rom/r4.chd',
      fallbackRom: '/rom/R4%20-%20Ridge%20Racer%20Type%204%20(USA).bin',
      cue: '/rom/R4%20-%20Ridge%20Racer%20Type%204%20(USA).cue',
      bios: '/bios/openbios.bin',
      bytes: 357817282,
      available: true,
    },
    rage: {
      id: 5,
      name: 'Rage Racer',
      subtitle: 'RAGE RACER',
      region: 'USA',
      rom: '/rom/rage-racer.chd',
      cue: '',
      bios: '/bios/openbios.bin',
      bytes: 495297808,
      available: true,
    },
    ridge: {
      id: 6,
      name: 'Ridge Racer',
      subtitle: 'RIDGE RACER',
      region: 'USA',
      // Original 1994 PlayStation release (SCUS-94300, USA), 14-track disc.
      rom: '/rom/ridge-racer.chd',
      cue: '',
      bios: '/bios/openbios.bin',
      bytes: 309882296,
      available: true,
    },
  };

  const qs = new URLSearchParams(location.search);
  const gameKey = (qs.get('game') || 'r4').toLowerCase();
  const game = GAMES[gameKey] || GAMES.r4;
  // The disc key the page really runs (`?game=` falls back to r4).
  const mpGameKey = GAMES[gameKey] ? gameKey : 'r4';

  // ---------------------------------------------------------------------
  // Multi-disc 2P metadata. `_server/public/mp-games.json` (served at
  // /mp-games.json) is the single source of truth; MP_META is only a
  // first-paint/failed-fetch fallback so the page still picks the right
  // behaviour per disc:
  //
  //   mode            versus     = real two-car VS Battle (R4)
  //                   shared-car = guest pad merged into the host car
  //   guestPlayerIndex which core player index the guest's pad lands on
  //   macro           auto       = calibrated R4 menu walk
  //                   manual     = host starts a normal 1P race by hand
  //   roomPrefix      the netplay room name prefix (R4- / RAGE- / RIDGE-)
  //
  // Track/car lists come from the manifest (R4 also keeps MP_TRACKS/MP_CARS
  // below, byte-identical to the manifest, for the first paint).
  // ---------------------------------------------------------------------
  const MP_META = {
    r4: { mode: 'versus', modeLabel: 'VS BATTLE', guestPlayerIndex: 1, macro: 'auto', roomPrefix: 'R4', trackCount: 8, carCount: 8 },
    rage: { mode: 'shared-car', modeLabel: 'SHARED CAR', guestPlayerIndex: 0, macro: 'manual', roomPrefix: 'RAGE', trackCount: 4, carCount: 4 },
    ridge: { mode: 'shared-car', modeLabel: 'SHARED CAR', guestPlayerIndex: 0, macro: 'manual', roomPrefix: 'RIDGE', trackCount: 1, carCount: 4 },
  };
  const mpMetaFallback = MP_META[mpGameKey] || MP_META.r4;
  // 2P session label: R4 is a real VS session, Rage/Ridge share one car.
  const mpModeShort = (mode) => (mode === 'versus' ? '2P VS' : '2P SHARED');

  // The netplay host capture (N1) pulls a frame from the EJS WebGL canvas per
  // core frame. The ?pin=1 diagnostic builds an offscreen 960x720 4:3 canvas
  // and captures that instead; it needs preserveDrawingBuffer:true because it
  // reads the WebGL canvas from a rAF loop, which Chrome can clear.
  if (qs.get('capture') !== '30' && qs.get('pin') === '1') {
    try {
      const getCtx = HTMLCanvasElement.prototype.getContext;
      HTMLCanvasElement.prototype.getContext = function (type, opts) {
        const t = String(type);
        if (t === 'webgl' || t === 'webgl2' || t === 'experimental-webgl') {
          opts = Object.assign({}, opts || {}, { preserveDrawingBuffer: true });
        }
        return getCtx.call(this, type, opts);
      };
    } catch { /* ignore */ }
  }

  const biosMode = (qs.get('bios') || 'openbios').toLowerCase();
  const cueMode = (qs.get('cue') || 'auto').toLowerCase();
  // The 4.3 netplay path was verified with the non-threaded PSX core. Keep it
  // off by default and require ?threads=1 plus a secure, cross-origin-isolated
  // document (the .html static alias may be served without COOP/COEP).
  const useThreads = qs.get('threads') === '1' &&
    window.isSecureContext && window.crossOriginIsolated;
  // The shell hands us ?embedded=1 after its own ENTER gesture; the parent owns
  // the audio, so do not show a second "CLICK TO RACE" gate inside the frame.
  const embedded = qs.get('embedded') === '1' && window.parent !== window;
  const debug = qs.get('debug') === '1';
  const cacheEnabled = qs.get('cache') !== '0';
  // The relay is a separate origin on the same LAN host. Absolute URL is
  // required by EmulatorJS; the 4.3 client strips a trailing slash.
  const netplayServer = (qs.get('netserver') ||
    (`http://${location.hostname}:3010`)).replace(/\/+$/, '');

  let biosUrl = game.bios;
  if (biosMode === 'hle' || biosMode === 'none' || biosMode === '0') biosUrl = '';
  else if (biosMode.startsWith('/')) biosUrl = biosMode;

  // ---------------------------------------------------------------------
  // Diagnostics surface (read by test-play-net.mjs / DevTools).
  // ---------------------------------------------------------------------
  const state = {
    game: gameKey,
    gameName: game.name,
    core: 'psx',
    emulator: '4.3.0-pre',
    bios: biosUrl || 'HLE (none)',
    cue: cueMode,
    threads: useThreads,
    embedded,
    netplayServer,
    t0: performance.now(),
    events: [],
    errors: [],
    rom: null,
    canvas: null,
    startedAt: null,
    readyAt: null,
    bootMs: null,
    netplay: {
      available: false,
      version: null,
      joinedAt: null,
      lastRoom: null,
      lastRole: null,
    },
  };
  window.__R4 = state;

  const mark = (name, extra) => {
    state.events.push({ name, at: Math.round(performance.now() - state.t0), ...(extra || {}) });
    if (name === 'start') {
      state.startedAt = Date.now();
      state.bootMs = Math.round(performance.now() - state.t0);
    }
  };

  const $ = (sel) => document.querySelector(sel);
  const statusEl = $('#bootStatus');
  const overlay = $('#bootOverlay');
  const overlayText = $('#overlayText');
  const overlayBar = $('#overlayBar');
  const overlayTitle = $('#overlayTitle');
  const overlayKicker = $('#overlayKicker');
  const overlayHint = $('#overlayHint');
  const footTiming = $('#footTiming');
  const footRom = $('#footRom');
  const footCore = $('#footCore');
  const fsBtn = $('#fsBtn');
  const fsExit = $('#fsExit');
  const soundGate = $('#soundGate');

  // Netplay panel elements.
  const npPanel = $('#netplayPanel');
  const npToggle = $('#npToggle');
  const npClose = $('#npClose');
  const npChip = $('#npChip');
  const npRematch = $('#npRematch');
  const npChipText = $('#npChipText');
  const npRelay = $('#npRelay');
  const npRole = $('#npRole');
  const npPlayers = $('#npPlayers');
  const npRtc = $('#npRtc');
  const npVideo = $('#npVideo');
  const npServer = $('#npServer');
  const npName = $('#npName');
  const npRoomName = $('#npRoomName');
  const npMaxPlayers = $('#npMaxPlayers');
  const npCreate = $('#npCreate');
  const npRefresh = $('#npRefresh');
  const npRooms = $('#npRooms');
  const npMenu = $('#npMenu');
  const npLeave = $('#npLeave');
  const npLog = $('#npLog');
  const npVersion = $('#npVersion');
  const npPath = $('#npPath');
  const npOrigin = $('#npOrigin');

  const setStatus = (text, stateName) => {
    if (statusEl) {
      statusEl.textContent = text;
      statusEl.dataset.state = stateName || 'loading';
    }
  };

  const setOverlay = (title, text, hint, progress) => {
    if (title && overlayTitle) overlayTitle.textContent = title;
    if (text && overlayText) overlayText.textContent = text;
    if (hint && overlayHint) overlayHint.textContent = hint;
    if (overlayBar && typeof progress === 'number') {
      overlayBar.classList.remove('indeterminate');
      overlayBar.style.width = Math.max(2, Math.min(100, progress)) + '%';
    }
  };

  const hideOverlay = () => {
    if (!overlay) return;
    overlay.classList.add('is-hidden');
    setTimeout(() => { overlay.hidden = true; }, 500);
  };

  const showError = (message, detail) => {
    setStatus('ERROR', 'error');
    if (overlay) {
      overlay.hidden = false;
      overlay.classList.remove('is-hidden');
    }
    if (overlayBar) { overlayBar.classList.remove('indeterminate'); overlayBar.style.width = '100%'; overlayBar.style.background = '#ff5a52'; }
    setOverlay('BOOT FAILED', message, detail || '', 100);
    state.errors.push({ message, detail: detail || '' });
    console.error('[r4-net]', message, detail || '');
  };

  // ---------------------------------------------------------------------
  // Presentation filters (same CSS overlays as the single-player page).
  // ---------------------------------------------------------------------
  const filterSelect = $('#filterSelect');
  const FILTERS = ['dlss5', 'off', 'scanlines', 'crt', 'vignette', 'sharp'];
  let activeFilter = 'dlss5';
  let gameStarted = false;
  let dlss5Ready = false;
  // DLSS 5 is a stage colour/contrast grade (and guest-video grade in netplay).
  // The EJS GLSL shader path can black out the WebGL canvas, so it is not used.
  const DLSS5_FILTER = 'contrast(1.08) saturate(1.18) brightness(1.02)';
  const setDlss5Stage = (on) => {
    document.body.dataset.filter = 'off';
    const em = window.EJS_emulator;
    const np = em && em.netplay;
    const guest = !!(em && em.isNetplay && np && !np.owner);
    // Host: leave the raw 4.3 WebGL canvas alone (filtering it can black out).
    // Guest: EJS draws the host stream into a 2D netplay canvas, so the grade is
    // safe. It is scoped to #game only - the stage also holds the side panel, so
    // grading #play-stage filtered 1.7x more surface than the picture.
    const stage = document.querySelector('#game');
    if (stage) stage.style.filter = on && guest ? DLSS5_FILTER : '';
  };
  const applyFilter = (value, persist) => {
    const v = FILTERS.includes(value) ? value : 'dlss5';
    activeFilter = v;
    if (v === 'dlss5') {
      if (gameStarted && dlss5Ready) setDlss5Stage(true);
      else {
        document.body.dataset.filter = 'off';
        const stage = document.querySelector('#game');
        if (stage) stage.style.filter = '';
      }
    } else {
      document.body.dataset.filter = v;
      const stage = document.querySelector('#game');
      if (stage) stage.style.filter = '';
    }
    if (persist !== false) {
      try { localStorage.setItem('rr4.play.filter.v2', v); } catch { /* ignore */ }
    }
    if (filterSelect) filterSelect.value = v;
  };
  if (filterSelect) {
    let saved = 'dlss5';
    try { saved = localStorage.getItem('rr4.play.filter.v2') || 'dlss5'; } catch { /* ignore */ }
    applyFilter(saved, false);
    filterSelect.addEventListener('change', () => applyFilter(filterSelect.value));
  }

  overlayTitle.textContent = game.subtitle;
  const brandGame = $('#brandGame');
  // The disc name stays; the session label follows the room mode. A Ridge 1994
  // 2P session is not "1P" any more - it is one shared car.
  const applyBrand = (mode) => {
    const m = mode || mpMetaFallback.mode;
    const name = {
      r4: 'RIDGE RACER <em>TYPE 4</em>',
      rage: 'RAGE <em>RACER</em>',
      ridge: 'RIDGE <em>RACER</em>',
    }[mpGameKey] || 'RIDGE RACER <em>TYPE 4</em>';
    if (brandGame) brandGame.innerHTML = `${name} ${mpModeShort(m)}`;
    document.title = `${game.name} // ${mpModeShort(m)} LAN Netplay`;
  };
  applyBrand(mpMetaFallback.mode);
  if (overlayHint && game.bytes) {
    overlayHint.textContent = `${Math.round(game.bytes / 1048576)} MB - served from this machine`;
  }
  overlayKicker.textContent = 'NETPLAY 4.3-PRE - HOST STREAMS';
  footRom.textContent = decodeURIComponent(game.rom).split('/').pop();
  footCore.textContent = debug ? 'pcsx_rearmed (debug)' : 'pcsx_rearmed';
  if (npServer) npServer.textContent = `relay: ${netplayServer}`;
  if (npPath) npPath.textContent = '/emulator43/data/';
  if (npOrigin) npOrigin.textContent = `${location.origin}${location.pathname}${location.search}`;

  // Game picker (reloads the page with the same netplay entry point).
  const select = $('#gameSelect');
  if (select) {
    for (const [key, g] of Object.entries(GAMES)) {
      const opt = document.createElement('option');
      opt.value = key;
      opt.textContent = g.name + (g.available ? '' : ' (ROM pending)');
      select.appendChild(opt);
    }
    select.value = gameKey in GAMES ? gameKey : 'r4';
    select.addEventListener('change', () => {
      const url = new URL(location.href);
      url.searchParams.set('game', select.value);
      location.href = url.toString();
    });
  }

  // ---------------------------------------------------------------------
  // Netplay panel: local log + collapse/expand.
  // ---------------------------------------------------------------------
  const logLines = [];
  function npLogLine(msg) {
    const line = `${new Date().toISOString().slice(11, 19)}  ${msg}`;
    logLines.push(line);
    if (logLines.length > 80) logLines.shift();
    if (npLog) npLog.textContent = logLines.join('\n');
    console.log('[r4-net]', msg);
  }
  window.__R4NET_LOGS = logLines;

  let panelOpen = true;
  function setPanel(open) {
    panelOpen = !!open;
    if (npPanel) npPanel.hidden = !panelOpen;
    document.body.classList.toggle('np-open', panelOpen);
    if (npToggle) npToggle.setAttribute('aria-expanded', panelOpen ? 'true' : 'false');
    if (npChip) npChip.hidden = panelOpen;
    if (panelOpen) {
      updateNetplayStatus();
      refreshRooms().catch(() => {});
    } else {
      updateChip();
    }
  }
  npToggle?.addEventListener('click', () => setPanel(!panelOpen));
  npClose?.addEventListener('click', () => setPanel(false));
  npChip?.addEventListener('click', () => setPanel(true));

  const defaultName = (() => {
    let saved = '';
    try { saved = localStorage.getItem('rr4.netplay.name') || ''; } catch { /* ignore */ }
    return saved.trim() || 'PLAYER';
  })();
  if (npName) npName.value = defaultName;
  npName?.addEventListener('change', () => {
    const name = String(npName.value || '').trim() || 'PLAYER';
    npName.value = name;
    try { localStorage.setItem('rr4.netplay.name', name); } catch { /* ignore */ }
    const np = netplay();
    if (np) np.name = name;
  });

  function playerName() {
    return String(npName?.value || defaultName).trim() || 'PLAYER';
  }

  function netplay() {
    const em = window.EJS_emulator;
    return em && em.netplay ? em.netplay : null;
  }

  function netplayButton() {
    const em = window.EJS_emulator;
    return em && em.frontend && em.frontend.elements && em.frontend.elements.bottomBar &&
      em.frontend.elements.bottomBar.netplay && em.frontend.elements.bottomBar.netplay[0];
  }

  function setPill(el, text, stateName) {
    if (!el) return;
    el.textContent = text;
    if (stateName) el.dataset.state = stateName;
  }

  function updateChip() {
    if (!npChip || panelOpen) return;
    const em = window.EJS_emulator;
    const np = netplay();
    const joined = !!(em && em.isNetplay);
    const owner = !!(np && np.owner);
    const room = np && np.extra ? np.extra.room_name : '';
    npChip.dataset.state = joined ? (owner ? 'host' : 'guest') : 'ok';
    npChip.dataset.ghost = ghost.enabled ? '1' : '0';
    npChip.dataset.liveGhost = live.enabled ? (live.armed ? '1' : '0') : '';
    if (npChipText) {
      if (!joined) {
        npChipText.textContent = live.enabled
          ? `${live.armed ? `LIVE ${live.specLabel || ''}`.trim() : 'GHOST'} NETPLAY`
          : (ghost.enabled ? 'GHOST NETPLAY' : '2P NETPLAY');
      } else {
        // Collapsed panel: this chip is the only status a player sees while the
        // race is loading, so it carries the seat, the P2 lock and the host stage.
        // Shared car (Rage/Ridge): both pads drive from boot, so the guest is
        // SHARED until it is LIVE - never "LOCKED" when no macro runs.
        const seat = owner ? 'HOST P1' : (mp.mode !== 'versus'
          ? (mp.raceLive ? 'GUEST P2 LIVE' : 'GUEST P2 SHARED')
          : (mp.raceLive ? 'GUEST P2 LIVE' : 'GUEST P2 LOCKED'));
        const stageLabels = {
          'room:hosting': 'ROOM',
          'menu:boot': 'HOST BOOT',
          'menu:ready': 'HOST MENU',
          'menu:vs': 'VS BATTLE',
          'car:p1': 'CAR P1',
          'car:p2': 'CAR P2',
          'course': 'COURSE',
          'course:locked': 'GRID LOCKED',
          'race:starting': 'GRID',
          'race:live': 'RACE',
          'macro:manual': 'MANUAL',
        };
        const stage = mp.hostStage
          ? (mp.hostStage === 'macro:manual' && ghost.enabled
            ? 'GHOST RUN'
            : (stageLabels[mp.hostStage] || mp.hostStage.toUpperCase()))
          : '';
        // Ghost rooms always lead with the mode so a collapsed chip never reads
        // like a live two-car race. Live/R4 keeps the exact old string.
        npChipText.textContent = [live.enabled
          ? (live.armed ? `LIVE ${live.specLabel || 'GHOST'}`.trim() : 'GHOST')
          : (ghost.enabled ? 'GHOST' : ''), seat, room, stage]
          .filter(Boolean).join(' - ');
      }
    }
    // Debug line: transport counters (N3) + the last getStats sample (N4).
    const counters = state.input || { dc: 0, relay: 0, dropped: 0 };
    npChip.dataset.input = `dc=${counters.dc};relay=${counters.relay};dropped=${counters.dropped}`;
    if (npChipDebug) {
      if (!joined) {
        npChipDebug.hidden = true;
        npChipDebug.textContent = '';
      } else {
        const st = window.__R4NET && window.__R4NET.stats;
        npChipDebug.hidden = false;
        npChipDebug.textContent = `in dc ${counters.dc} / relay ${counters.relay} / drop ${counters.dropped}`
          + (st ? ` | ${st.fps != null ? st.fps : '?'}fps ${st.kbps != null ? st.kbps : '?'}k ${st.qualityLimitationReason || 'ok'}` : '');
      }
    }
  }

  function updateNetplayStatus() {
    const em = window.EJS_emulator;
    const np = netplay();
    const joined = !!(em && em.isNetplay);
    const owner = !!(np && np.owner);
    const players = np && np.players ? Object.keys(np.players).length : 0;
    const max = (np && np.maxPlayers) || Number(npMaxPlayers?.value) || 2;
    const room = np && np.extra ? np.extra.room_name : '';

    setPill(npRole, joined
      ? (owner
        ? 'HOST - AUTHORITATIVE'
        : (mp.mode !== 'versus'
          ? (mp.raceLive ? 'GUEST - P2 LIVE' : 'GUEST - P2 SHARED')
          : (mp.raceLive ? 'GUEST - P2 LIVE' : 'GUEST - P2 LOCKED')))
      : 'NOT JOINED',
      joined ? (owner ? 'host' : 'guest') : 'idle');
    if (npRole) npRole.dataset.ghost = ghost.enabled ? '1' : '0';
    setPill(npPlayers, `${players}/${max}`, players >= 2 ? 'ok' : 'idle');

    const pcs = np && np.peerConnections ? Object.values(np.peerConnections) : [];
    const states = pcs.map((p) => (p.pc ? p.pc.connectionState : p.connectionState) || p.iceConnectionState || 'new');
    const anyConnected = states.some((s) => s === 'connected' || s === 'completed');
    setPill(npRtc, states.length ? `RTC ${states.join(',')}` : 'RTC -', anyConnected ? 'ok' : 'idle');

    const v = np && np.video;
    if (v && v.videoWidth > 0) {
      setPill(npVideo, `VIDEO ${v.videoWidth}x${v.videoHeight} r${v.readyState}`, v.readyState >= 2 ? 'ok' : 'warn');
    } else {
      setPill(npVideo, 'VIDEO -', 'idle');
    }

    if (npLeave) npLeave.disabled = !joined;
    if (npVersion) npVersion.textContent = (em && (em.ejs_version || em.version)) || '4.3.0-pre';
    state.netplay.version = (em && (em.ejs_version || em.version)) || '4.3.0-pre';
    state.netplay.available = !!np;
    state.netplay.lastRole = joined ? (owner ? 'host' : 'guest') : null;
    state.netplay.lastRoom = room || null;

    if (joined && owner && players >= 2 && state.netplay.lastPlayers !== players) {
      npLogLine(`Guest joined - ${players}/${max} players. Host is authoritative.`);
      state.netplay.lastPlayers = players;
    }
    if (joined && !owner && v && v.videoWidth > 0 && !state.netplay.videoLogged) {
      npLogLine(`Receiving host stream (${v.videoWidth}x${v.videoHeight}). Input is sent as player 2.`);
      state.netplay.videoLogged = true;
    }
    renderGhostBlock();
    updateChip();
  }

  // ---------------------------------------------------------------------
  // Relay health + room discovery.
  // ---------------------------------------------------------------------
  async function relayHealth() {
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 2500);
      const res = await fetch(`${netplayServer}/health`, { cache: 'no-store', signal: ctrl.signal });
      clearTimeout(timer);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } catch {
      return null;
    }
  }

  const relayPort = (() => {
    try { return new URL(netplayServer).port || '3010'; } catch { return '3010'; }
  })();

  async function checkRelay() {
    const h = await relayHealth();
    if (h && h.ok) {
      setPill(npRelay, `RELAY OK :${relayPort}`, 'ok');
      state.netplay.relay = { ok: true, ...h };
    } else {
      setPill(npRelay, 'RELAY DOWN', 'error');
      state.netplay.relay = { ok: false };
    }
    return h;
  }

  async function getRooms() {
    const params = new URLSearchParams({
      domain: location.host,
      game_id: String(game.id),
    });
    const res = await fetch(`${netplayServer}/list?${params.toString()}`, { cache: 'no-store' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  }

  function renderRooms(rooms) {
    if (!npRooms) return;
    npRooms.innerHTML = '';
    const entries = Object.entries(rooms || {});
    if (!entries.length) {
      const empty = document.createElement('div');
      empty.className = 'np-empty';
      empty.textContent = 'No open rooms. Host one above, or ask the host to create a room.';
      npRooms.appendChild(empty);
      return;
    }
    for (const [sessionId, room] of entries) {
      const row = document.createElement('div');
      row.className = 'np-room';
      row.dataset.session = sessionId;

      const name = document.createElement('div');
      name.className = 'np-room-name';
      name.textContent = room.room_name || sessionId;
      name.title = `host: ${room.player_name || 'Unknown'}`;

      const count = document.createElement('div');
      count.className = 'np-room-count';
      count.textContent = `${room.current}/${room.max}`;

      const join = document.createElement('button');
      join.type = 'button';
      join.className = 'np-room-join';
      join.textContent = room.hasPassword ? 'PASSWORD' : 'JOIN';
      join.addEventListener('click', () => {
        if (room.hasPassword) {
          const np = netplay();
          if (np && typeof np.showJoinPasswordDialog === 'function') {
            np.showJoinPasswordDialog(sessionId, room.room_name, room.max);
            return;
          }
          const password = window.prompt(`Password for ${room.room_name}`);
          if (!password) return;
          joinRoom(sessionId, room.room_name, room.max, password);
          return;
        }
        joinRoom(sessionId, room.room_name, room.max, null);
      });

      row.appendChild(name);
      row.appendChild(count);
      row.appendChild(join);
      npRooms.appendChild(row);
    }
  }

  let roomsBusy = false;
  async function refreshRooms() {
    if (!npRooms || roomsBusy) return;
    const np = netplay();
    const em = window.EJS_emulator;
    if (!np) {
      npRooms.innerHTML = '<div class="np-empty">Waiting for the emulator to boot...</div>';
      return;
    }
    if (em && em.isNetplay) return; // already in a room
    roomsBusy = true;
    try {
      const rooms = await getRooms();
      renderRooms(rooms);
      state.netplay.rooms = rooms;
    } catch (e) {
      npRooms.innerHTML = '';
      const empty = document.createElement('div');
      empty.className = 'np-empty';
      empty.textContent = `Relay unreachable (${netplayServer}). Start start-netplay.bat.`;
      npRooms.appendChild(empty);
      state.netplay.roomsError = e.message;
    } finally {
      roomsBusy = false;
    }
  }

  // ---------------------------------------------------------------------
  // Netplay actions (used by the panel and by tests).
  // ---------------------------------------------------------------------
  function setName(name) {
    const value = String(name || '').trim() || 'PLAYER';
    if (npName) npName.value = value;
    try { localStorage.setItem('rr4.netplay.name', value); } catch { /* ignore */ }
    const np = netplay();
    if (np) np.name = value;
    return value;
  }

  function hostRoom(roomName, maxPlayers, password) {
    const np = netplay();
    if (!np) { npLogLine('Cannot host: EmulatorJS netplay is not ready yet.'); return false; }
    const name = setName(playerName());
    np.name = name;
    const room = String(roomName || npRoomName?.value || 'R4 NETPLAY').trim() || 'R4 NETPLAY';
    const max = Number(maxPlayers || npMaxPlayers?.value || 2);
    // Unlock WebAudio first so the 4.3 host can capture audio into the stream.
    try { unlockAudio(); } catch { /* ignore */ }
    npLogLine(`Creating room "${room}" (${max} players) as ${name}...`);
    np.openRoom(room, max, password || '');
    return true;
  }

  function joinRoom(sessionId, roomName, maxPlayers, password) {
    const np = netplay();
    if (!np) { npLogLine('Cannot join: EmulatorJS netplay is not ready yet.'); return false; }
    const name = setName(playerName());
    np.name = name;
    // Guest audio unlock: browsers may require a gesture before remote audio.
    try { unlockAudio(); } catch { /* ignore */ }
    npLogLine(`Joining "${roomName || sessionId}" as ${name}...`);
    np.joinRoom(sessionId, roomName || sessionId, Number(maxPlayers || 2), password || null);
    return true;
  }

  function leaveRoom() {
    const np = netplay();
    if (!np) return false;
    npLogLine('Leaving the room.');
    np.leaveRoom();
    state.netplay.videoLogged = false;
    state.netplay.lastPlayers = null;
    setTimeout(() => { refreshRooms().catch(() => {}); updateNetplayStatus(); }, 500);
    return true;
  }

  function openNetplayMenu() {
    const btn = netplayButton();
    if (btn) { btn.click(); npLogLine('Opened the EmulatorJS netplay menu.'); return true; }
    npLogLine('EmulatorJS netplay button is not available.');
    return false;
  }

  function snapshot() {
    const em = window.EJS_emulator;
    const np = netplay();
    const pcs = np && np.peerConnections ? Object.values(np.peerConnections) : [];
    const v = np && np.video;
    return {
      started: !!state.startedAt,
      version: (em && (em.ejs_version || em.version)) || null,
      pathtodata: window.EJS_pathtodata || null,
      netplayServer,
      gameID: window.EJS_gameID,
      isNetplay: !!(em && em.isNetplay),
      owner: !!(np && np.owner),
      connected: !!(np && np.socket && np.socket.connected),
      socket: !!(np && np.socket),
      name: np ? np.name : null,
      players: np && np.players ? Object.values(np.players).map((p) => p.player_name) : [],
      playerCount: np && np.players ? Object.keys(np.players).length : 0,
      maxPlayers: np ? np.maxPlayers : null,
      session: np && np.extra ? np.extra.sessionid : null,
      room: np && np.extra ? np.extra.room_name : null,
      peers: pcs.map((p) => ({
        state: p.pc ? p.pc.connectionState : p.connectionState,
        ice: p.pc ? p.pc.iceConnectionState : p.iceConnectionState,
        dc: p.dataChannel ? p.dataChannel.readyState : null,
      })),
      video: v ? { w: v.videoWidth, h: v.videoHeight, readyState: v.readyState, time: v.currentTime } : null,
      netplayButtonVisible: (() => {
        const b = netplayButton();
        return !!(b && getComputedStyle(b).display !== 'none');
      })(),
      paused: !!(em && em.paused),
      canvas: (() => {
        const c = document.querySelector('#game canvas');
        return c ? { w: c.width, h: c.height, cssW: c.clientWidth, cssH: c.clientHeight } : null;
      })(),
      relay: state.netplay.relay || null,
      rooms: state.netplay.rooms || null,
      ghost: {
        enabled: ghost.enabled,
        game: ghost.game,
        turn: ghost.turn,
        state: ghost.state,
        ramBase: ghost.ramBase,
        captured: ghost.captured,
        swapped: ghost.swapped,
        tape: ghost.tape || null,
        peer: ghost.peer || null,
        storage: { ...ghost.storage },
        gatedInputs: ghost.gatedInputs,
        remappedInputs: ghost.remappedInputs,
      },
      errors: state.errors.slice(-10),
    };
  }

  const api = {
    ready: () => !!netplay(),
    snapshot,
    setName,
    hostRoom,
    joinRoom,
    leaveRoom,
    refreshRooms,
    getRooms,
    openMenu: openNetplayMenu,
    openPanel: () => setPanel(true),
    closePanel: () => setPanel(false),
    togglePanel: () => setPanel(!panelOpen),
    checkRelay,
    simulateInput: (player, index, value) => {
      const np = netplay();
      if (!np || typeof np.simulateInput !== 'function') return false;
      np.simulateInput(player, index, value);
      return true;
    },
    clickNetplayButton: openNetplayMenu,
    logs: logLines,
  };
  window.__R4NET = api;

  // The shell 2P lobby hands both browsers here with the same room code.
  // Auto-create for the host and auto-find/join for the guest so the race
  // starts from the lobby instead of a second manual room setup.
  const mpRole = (qs.get('mpRole') || '').toLowerCase();
  const mpRoom = (qs.get('mpRoom') || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 4);
  const mpRace = (qs.get('mpRace') || '').replace(/[^a-zA-Z0-9-]/g, '').slice(0, 48);

  // The in-game VS Battle course list, in menu order (calibrated: one Right per
  // index from Helter Skelter; index 8 wraps to Helter Skelter). This is the
  // same order the lobby server rolls, and byte-identical to mp-games.json.
  // It is the R4 first-paint/failed-fetch plan only - the manifest replaces it.
  const MP_TRACKS = [
    'Helter Skelter', 'Wonderhill', 'Edge of the Earth', 'Out of Blue',
    'Phantomile', 'Brightest Nite', 'Heaven and Hell', 'Shooting Hoops',
  ];
  const MP_CARS = ['D1', 'D2', 'D3', 'D4', 'G1', 'G2', 'G3', 'G4'];

  // First-paint plan lists per disc. R4 uses the calibrated arrays above; the
  // other discs get generic placeholders until /mp-games.json lands (a failed
  // fetch must still clamp the plan to the right number of courses/cars).
  const mpPlaceholder = (prefix, n) => Array.from(
    { length: Math.max(1, Math.trunc(Number(n) || 1)) },
    (_, i) => `${prefix} ${i + 1}`,
  );
  const mpR4 = mpGameKey === 'r4';
  let mpTracks = mpR4 ? MP_TRACKS.slice() : mpPlaceholder('TRACK', mpMetaFallback.trackCount);
  let mpCars = mpR4 ? MP_CARS.slice() : mpPlaceholder('CAR', mpMetaFallback.carCount);
  // The relay room name prefix comes from the disc (R4- / RAGE- / RIDGE-), never
  // a hardcoded R4-. A manual /play-net join (no mpRace) keeps the bare code.
  let mpRoomPrefix = mpMetaFallback.roomPrefix;
  let mpRoomName = mpRace ? `${mpRoomPrefix}-${mpRoom}` : mpRoom;
  const intParam = (name, max) => {
    const raw = qs.get(name);
    const roll = () => Math.floor(Math.random() * (max + 1));
    if (raw == null || raw === '') return roll();
    const n = Number(raw);
    return Number.isFinite(n) ? Math.max(0, Math.min(max, Math.trunc(n))) : roll();
  };

  // R4 stores the current menu/list selection in one byte. The main menu uses
  // 0 Grand Prix, 1 Time attack, 2 VS battle; the car/course screens reuse the
  // same byte for their own list. Reading it lets the host macro verify that it
  // is really on the main menu before it starts pressing buttons.
  const R4_MENU_SEL = 0x800AC801;
  const R4_LABEL_TABLE = 0x800A2180;
  let menuBase = null;
  let menuBaseCheckedAt = 0;
  function findMenuTable() {
    const em = window.EJS_emulator;
    const gm = em && em.gameManager;
    const M = gm && (gm.Module || em.Module);
    const H = M && M.HEAPU8;
    if (!H || H.length < 7000000) return null;
    const bytes = (s) => Array.from(s).map((c) => c.charCodeAt(0));
    const gp = bytes('GRAND PRIX');
    const wl = bytes('WELCOME');
    const vs = bytes('VS BATTLE');
    const hi = Math.min(H.length - 64, 12000000);
    for (let i = 6000000; i < hi; i += 1) {
      if (H[i] !== gp[0]) continue;
      let ok = true;
      for (let j = 1; j < gp.length; j += 1) if (H[i + j] !== gp[j]) { ok = false; break; }
      if (!ok) continue;
      let w = true;
      for (let j = 0; j < wl.length; j += 1) if (H[i - 32 + j] !== wl[j]) { w = false; break; }
      if (!w) continue;
      let v = true;
      for (let j = 0; j < vs.length; j += 1) if (H[i + 32 + j] !== vs[j]) { v = false; break; }
      if (!v) continue;
      return i - 32;
    }
    return null;
  }
  function readMenuSel() {
    if (menuBase == null && Date.now() - menuBaseCheckedAt > 4000) {
      menuBaseCheckedAt = Date.now();
      menuBase = findMenuTable();
    }
    if (menuBase == null) return null;
    const em = window.EJS_emulator;
    const gm = em && em.gameManager;
    const M = gm && (gm.Module || em.Module);
    const H = M && M.HEAPU8;
    if (!H) return null;
    return H[menuBase + (R4_MENU_SEL - R4_LABEL_TABLE)];
  }

  const R4_PAD_ACK = 0x800ABD9F;
  function readPadAck() {
    if (menuBase == null) return null;
    const em = window.EJS_emulator;
    const gm = em && em.gameManager;
    const M = gm && (gm.Module || em.Module);
    const H = M && M.HEAPU8;
    if (!H) return null;
    return H[menuBase + (R4_PAD_ACK - R4_LABEL_TABLE)];
  }
  // Right presses are paced against the pad-ack byte. While the host is also
  // encoding the WebRTC stream the carousel can swallow a press; the byte then
  // does not move and the macro presses again instead of drifting one car off.
  const pressRight = async (player, count, label) => {
    const start = readPadAck();
    mp.ackLog = mp.ackLog || [];
    const rec = { label, start, presses: 0 };
    mp.ackLog.push(rec);
    if (!count) { rec.end = start; rec.delta = 0; return start; }
    if (start == null) {
      for (let i = 0; i < count; i += 1) await tapPad(player, 7, 350, 1600);
      rec.end = null;
      return null;
    }
    // The pad-ack byte tracks the car carousel but not the course list, so probe
    // it: if it does not move after two presses, pace the remaining presses
    // blindly instead of hammering the D-pad forever.
    let live = false;
    for (let i = 0; i < 2 && rec.presses < count; i += 1) {
      await tapPad(player, 7, 350, 900);
      rec.presses += 1;
      if (((readPadAck() - start + 256) % 256) > 0) { live = true; break; }
    }
    if (!live) {
      while (rec.presses < count) {
        await tapPad(player, 7, 350, 1400);
        rec.presses += 1;
      }
      rec.end = readPadAck();
      rec.delta = rec.end == null ? null : (rec.end - start + 256) % 256;
      return rec.end;
    }
    let guard = 0;
    const limit = count * 3 + 6;
    while (guard < limit) {
      const now = readPadAck();
      const delta = now == null ? 0 : (now - start + 256) % 256;
      if (delta >= count) {
        rec.end = now;
        rec.delta = delta;
        return now;
      }
      await tapPad(player, 7, 350, 900);
      rec.presses += 1;
      guard += 1;
    }
    rec.end = readPadAck();
    rec.delta = rec.end == null ? null : (rec.end - start + 256) % 256;
    return rec.end;
  };

  const mp = {
    role: mpRole === 'host' || mpRole === 'guest' ? mpRole : null,
    code: mpRoom || null,
    roomName: mpRoomName || null,
    raceId: mpRace || null,
    // Multi-disc behaviour: initialised from MP_META + the R4 plan arrays, then
    // overridden from /mp-games.json the moment it lands (before any macro).
    game: mpGameKey,
    mode: mpMetaFallback.mode,
    modeLabel: mpMetaFallback.modeLabel,
    guestPlayerIndex: mpMetaFallback.guestPlayerIndex,
    trackSelection: mpMetaFallback.mode === 'versus' ? 'auto' : 'manual',
    macro: mpMetaFallback.macro,
    macroVerified: mpMetaFallback.macro === 'auto',
    tracks: mpTracks,
    cars: mpCars,
    games: null,
    gameMeta: null,
    gamesApplied: false,
    coopRemap: false,
    remappedInputs: 0,
    // Ghost (Route A): `drive`/`turn` come from `?mpGhost=`/`?mpTurn=` and the
    // engine object is attached below (`mp.ghost` === `window.__R4GHOST`).
    // `live` (the default) leaves every field above untouched.
    drive: 'live',
    turn: null,
    ghost: null,
    trackIndex: intParam('mpTrackIndex', mpTracks.length - 1),
    carHost: intParam('mpCarHost', mpCars.length - 1),
    carGuest: intParam('mpCarGuest', mpCars.length - 1),
    auto: { hostTries: 0, guestTries: 0, joined: false, error: null, lastJoinError: null },
    stage: 'idle',
    stages: [],
    hostStage: null,
    menuVerified: false,
    raceStartSignalledAt: null,
    raceLive: false,
    inputGated: false,
    blockedGuestInputs: 0,
    controlReceived: [],
    signalsSent: 0,
    signalsFailed: 0,
    socketEvents: [],
  };
  state.mp = mp;
  window.__R4MP = mp;
  window.__R4NET.mp = mp;
  window.__R4NET.readMenuSel = readMenuSel;
  window.__R4NET.mpRun = () => autoRace();
  window.__R4NET.ensureMainMenu = () => ensureMainMenu();
  window.__R4NET.guestGate = () => installGuestGate();
  window.__R4NET.planText = () => planText();

  // One-click rematch: the shell owns navigation, so ask it to reload the 2P
  // lounge with the same room code (host auto-creates, guest auto-joins) and the
  // same disc. A standalone tab navigates itself.
  //
  // Ghost rooms also carry `drive` + the NEXT turn (the other seat drives the
  // rematch) so the reload cannot silently fall back to a live shared car. Both
  // are added only in ghost mode: a live/R4 rematch payload and URL stay
  // byte-identical to today.
  const rematch = () => {
    if (!mp.role || !mp.code) return false;
    const ghostDrive = !!(window.__R4GHOST && window.__R4GHOST.enabled);
    const nextTurn = ghostDrive && window.__R4GHOST.turn === 'guest' ? 'host' : 'guest';
    const payload = { type: 'rr4-rematch', code: mp.code, role: mp.role, game: mpGameKey };
    if (ghostDrive) { payload.drive = 'ghost'; payload.turn = nextTurn; }
    payload.at = Date.now();
    if (window.parent && window.parent !== window) {
      try { window.parent.postMessage(payload, location.origin); } catch { /* ignore */ }
      try { npLogLine(`REMATCH requested for room ${mp.code}${ghostDrive ? ` (GHOST, next driver ${nextTurn})` : ''}.`); } catch { /* ignore */ }
      return true;
    }
    const base = `/multiplayer?room=${encodeURIComponent(mp.code)}&host=${mp.role === 'host' ? '1' : '0'}`
      + `&game=${encodeURIComponent(mpGameKey)}`;
    location.href = ghostDrive ? `${base}&drive=ghost&turn=${nextTurn}` : base;
    return true;
  };
  window.__R4NET.rematch = rematch;
  mp.rematch = rematch;
  if (npRematch) {
    npRematch.hidden = !(mp.role && mp.code);
    npRematch.addEventListener('click', rematch);
  }

  const planText = () => `${mp.tracks[mp.trackIndex]} // ${mp.cars[mp.carHost]} vs ${mp.cars[mp.carGuest]}`;

  // ---------------------------------------------------------------------
  // Disc manifest: /mp-games.json replaces MP_META + the fallback plan arrays.
  // It is a local static file, so it lands long before the host macro can run;
  // boot never waits for it. A failed fetch keeps the fallback above, which
  // still selects versus/auto for R4 and shared-car/manual for Rage + Ridge.
  // ---------------------------------------------------------------------
  const mpGameNames = (list, prefix) => (Array.isArray(list) ? list : []).map((entry, i) => {
    if (entry && typeof entry === 'object') {
      const name = entry.name != null ? String(entry.name) : '';
      if (name) return name;
    } else if (typeof entry === 'string' && entry) {
      return entry;
    }
    return `${prefix} ${i + 1}`;
  });

  const applyMpGames = (data) => {
    const list = data && data.games;
    if (!list || typeof list !== 'object') return false;
    // Keep the whole manifest (version/defaultGame/games) plus a direct map.
    mp.games = data;
    mp.gameMap = list;
    const meta = list[mp.game] || list[mpGameKey] ||
      (data.defaultGame ? list[data.defaultGame] : null) || null;
    if (!meta) return false;
    mp.gameMeta = meta;
    if (meta.mode) mp.mode = String(meta.mode);
    if (meta.modeLabel) mp.modeLabel = String(meta.modeLabel);
    const guest = Number(meta.guestPlayerIndex);
    if (Number.isFinite(guest)) mp.guestPlayerIndex = guest === 0 ? 0 : 1;
    if (meta.macro) mp.macro = String(meta.macro);
    if (typeof meta.macroVerified === 'boolean') mp.macroVerified = meta.macroVerified;
    if (meta.trackSelect) mp.trackSelection = String(meta.trackSelect);
    const tracks = mpGameNames(meta.tracks, 'TRACK');
    const cars = mpGameNames(meta.cars, 'CAR');
    if (tracks.length) { mp.tracks = tracks; mpTracks = tracks; }
    if (cars.length) { mp.cars = cars; mpCars = cars; }
    // The plan was clamped against the fallback; re-clamp against the manifest.
    mp.trackIndex = Math.max(0, Math.min(mp.tracks.length - 1, mp.trackIndex));
    mp.carHost = Math.max(0, Math.min(mp.cars.length - 1, mp.carHost));
    mp.carGuest = Math.max(0, Math.min(mp.cars.length - 1, mp.carGuest));
    if (meta.roomPrefix && mpRoomPrefix !== String(meta.roomPrefix)) {
      mpRoomPrefix = String(meta.roomPrefix);
      mpRoomName = mpRace ? `${mpRoomPrefix}-${mpRoom}` : mpRoom;
      if (!mp.auto.joined) mp.roomName = mpRoomName || null;
    }
    mp.gamesApplied = true;
    mp.gamesAppliedAt = Date.now();
    applyBrand(mp.mode);
    try {
      npLogLine(`2P DISC ${meta.short || mp.game}: ${mp.modeLabel} - ${mp.tracks.length} course(s), ${mp.cars.length} car(s), ${mp.macro} sequence.`);
    } catch { /* ignore */ }
    return true;
  };

  fetch('/mp-games.json', { cache: 'no-cache' })
    .then((res) => (res.ok ? res.json() : Promise.reject(new Error(`HTTP ${res.status}`))))
    .then((data) => { applyMpGames(data); })
    .catch((e) => {
      mp.gamesError = e && e.message ? e.message : String(e);
      try { npLogLine(`2P manifest unavailable (${mp.gamesError}) - using the built-in ${mp.game} fallback.`); } catch { /* ignore */ }
    });
  const mpSignal = (payload) => {
    const np = netplay();
    if (!np || typeof np.sendMessage !== 'function') { mp.signalsFailed += 1; return false; }
    try { np.sendMessage({ 'r4-mp': payload }); mp.signalsSent += 1; return true; } catch { mp.signalsFailed += 1; return false; }
  };
  const setStage = (name) => {
    mp.stage = name;
    mp.stages.push({ stage: name, at: Date.now(), sel: mp.role === 'host' ? readMenuSel() : null, ack: mp.role === 'host' ? readPadAck() : null });
    if (mp.stages.length > 80) mp.stages.shift();
    try { npLogLine(`${mp.macro === 'auto' ? 'AUTO RACE' : 'MANUAL RACE'} ${mp.stages.length}: ${name}`); } catch { /* ignore */ }
    if (mp.role === 'host') {
      mp.lastStageSignal = { type: 'stage', stage: name, at: Date.now(), plan: planText() };
      mpSignal(mp.lastStageSignal);
    }
  };

  // Guest side: the host is driving R4's menus, so swallow guest pad/keyboard
  // input until the host signals that the race is live. Without this a guest
  // pad can move the P2 car-select cursor while the host walks the macro.
  function installGuestGate() {
    if (mp.inputGated) return true;
    // Ghost (Route A): the host owns the turn gate; the guest sends pad input
    // immediately (`raceLive`) and never runs the shared-car remap or the R4
    // race-live park. `installGuestGate` returns false so no wrapper is added.
    if (ghost.enabled) {
      ghost.guestLive = true;
      mp.raceLive = true;
      mp.manualJoin = true;
      return false;
    }
    // Shared-car discs (Rage Racer, Ridge 1994) have no 2P menu walk: the host
    // starts a normal single-player race by hand and both pads drive the same
    // car, so the guest is live from boot and no wrapper is installed.
    if (mp.mode !== 'versus') {
      mp.raceLive = true;
      mp.manualJoin = true;
      return false;
    }
    // Manual /play-net panel (no lounge `mpRole`/`mpRoom`): nothing drives the
    // host menus, so the guest must be able to drive as soon as it joins.
    if (mp.role !== 'guest' || !mp.code) {
      mp.raceLive = true;
      mp.manualJoin = true;
      return false;
    }
    const em = window.EJS_emulator;
    const gm = em && em.gameManager;
    if (!em || !em.isNetplay || !gm || typeof gm.simulateInput !== 'function') return false;
    const original = gm.simulateInput.bind(gm);
    gm.simulateInput = (player, index, value) => {
      if (!mp.raceLive) { mp.blockedGuestInputs += 1; return undefined; }
      return original(player, index, value);
    };
    mp.inputGated = true;
    // Belt and braces: if the control channel is lost the guest must still be
    // able to drive once the grid is long gone.
    setTimeout(() => {
      if (!mp.raceLive) {
        mp.raceLive = true;
        mp.gateTimeout = true;
        try { npLogLine('No race-live signal after 3 min - guest input unlocked locally.'); } catch { /* ignore */ }
      }
    }, 180000);
    return true;
  }
  window.__R4NET.mpForceRaceLive = () => { mp.raceLive = true; mp.forcedLive = true; };

  // ---------------------------------------------------------------------
  // Shared-car remap (HOST, mode === 'shared-car').
  //
  // Rage Racer and Ridge Racer 1994 are single-player discs: there is no P2
  // car. The netplay client applies the guest's remote pad through the cwrap
  // function `gameManager.functions.simulateInput` - NOT through
  // `gameManager.simulateInput` (that is the EJS-side method) - so that exact
  // function is wrapped to fold player index 1 onto the host car
  // (`mp.guestPlayerIndex`, 0 for both discs). The wrapper is marked so a
  // reconnect cannot double-wrap, and the retry poll stops once it is in.
  // No menu walk, no RAM read, no claim that these discs have a 2P mode.
  // ---------------------------------------------------------------------
  function installSharedCarRemap() {
    if (mp.mode !== 'shared-car') return false;
    // Ghost mode replaces the shared-car remap with the turn gate: only one
    // seat drives per run, so folding player 1 onto player 0 would let the
    // watching seat steer. Never install both.
    if (ghost.enabled) return true;
    if (mp.coopRemap) return true;
    const em = window.EJS_emulator;
    const gm = em && em.gameManager;
    const fns = gm && gm.functions;
    if (!fns || typeof fns.simulateInput !== 'function') return false;
    if (fns.__rr4CoopWrapped) { mp.coopRemap = true; return true; }
    const original = fns.simulateInput;
    const guest = Number(mp.guestPlayerIndex) === 0 ? 0 : 1;
    const wrapped = function (player, index, value) {
      let target = player;
      if (guest !== 1 && Number(player) === 1) {
        target = guest;
        mp.remappedInputs += 1;
      }
      return original.call(this, target, index, value);
    };
    wrapped.__rr4CoopWrapped = true;
    fns.__rr4CoopWrapped = true;
    fns.simulateInput = wrapped;
    mp.coopRemap = true;
    mp.coopRemapAt = Date.now();
    try {
      npLogLine(`SHARED CAR input remap: player 1 -> player ${guest} (${game.name}). Both pads drive one car.`);
    } catch { /* ignore */ }
    return true;
  }

  function startSharedCarRemapPoll() {
    if (mp.mode !== 'shared-car') return false;
    if (ghost.enabled) return true;
    if (mp.coopRemap) return true;
    if (installSharedCarRemap()) return true;
    if (mp.coopRemapPoll) return false;
    let tries = 0;
    mp.coopRemapPoll = setInterval(() => {
      tries += 1;
      if (installSharedCarRemap()) {
        clearInterval(mp.coopRemapPoll);
        mp.coopRemapPoll = null;
        return;
      }
      // Stop once wrapped; the 600-try (5 min) cap only stops a stray timer
      // when the core never appears (nothing could drive a pad then anyway).
      if (tries >= 600) {
        clearInterval(mp.coopRemapPoll);
        mp.coopRemapPoll = null;
        mp.coopRemapError = 'gameManager.functions.simulateInput never appeared';
        try { npLogLine('SHARED CAR input remap not installed (no gameManager after 5 min).'); } catch { /* ignore */ }
      }
    }, 500);
    return false;
  }
  window.__R4NET.sharedCarRemap = () => installSharedCarRemap();

  // ---------------------------------------------------------------------
  // GHOST (Route A) - turn-based Time Trial on the host core.
  //
  // `?mpGhost=ghost&mpTurn=host|guest` (Rage Racer / Ridge Racer 1994 only,
  // never R4, and only when the lounge handed a role in): exactly one driver is
  // live per run, the disc's own recorder tapes that run, and after the finish
  // the built-in REPLAY screen plays the OTHER seat's previous tape instead of
  // your own. Label: `ghost replay (sequential)` - never a live ghost car.
  //
  // Everything is RAM-only through `Module.HEAPU8` at the located PSX window.
  // The recipe is `_runtime/ghost-research/tape-probe.mjs` (Ridge 16/16,
  // `_runtime/ghost-research/tape-probe.md`); it corrected three things:
  //
  //   Ridge 1994 (SCUS-94300) - replay PROVED
  //     screen       u16 0x801D6D28   (3 = results/finish handler, 8 = replay
  //                                    setup, 9 = playback; 0 = not drawn yet)
  //     tape ptr     u32 0x80080434   the applier reads THROUGH this pointer
  //     tape (doc)        0x8006CE7C   40 B/frame - a write here + read-back
  //                                    passes and the game still ignores it
  //     staging           0x801E0000..0x801F0000 zero run (found 0x801E4840)
  //                                    the tape is written into a zeroed BSS
  //                                    run and the pointer is repointed at it
  //     count        u32 0x801EB020   frames, **161 max** (0x8006E7BC, the
  //                                    screen dispatch table, is 6464 B =
  //                                    161.6 records above the base; 300
  //                                    records freeze the core)
  //     recorder     u32 0x801D6D18   (1 = recording; never swap while 1)
  //     arm          s16 0x801EAFF0 = 1, u32 0x80176CBC = course,
  //                  u32 0x80176CE4 = 0, u16 0x801EB000 = 0,
  //                  u32 0x801EAF90 = 0x80071A0C, u32 0x80131014 = 511
  //                  (results wait -> screen 8 -> 9); fallback when the results
  //                  screen is already over: u16 0x80176AE4 = 0xFFFF +
  //                  u16 0x801D6D28 = 9
  //   Rage Racer (SLUS-00403) - replay PROVED via the race finish arm
  //     `_runtime/ghost-research/rage-finish-probe.md` (21/21): the only supported
  //     door into the replay is the RACE frame's own finish branch. Poking the
  //     scene id from the frontend freezes (BeginReplay never ran), so the
  //     product arms the branch and lets the game enter the replay itself.
  //     scene        s32 0x801E3FEC   (12 = RACE, 15/16 race end - NOT on the
  //                                    finish path -, 17 = REPLAY)
  //     racePhase    s16 0x801E6B7C   4 = the finish branch is armed
  //     lap          s16 0x8009E544   must be raceLength + 1
  //     raceLength   s32 0x801E406C   laps of this run (3 TA / 6 GP)
  //     finishTimer  s16 0x801E4104   the RACE frame counts it 0 -> 131 itself,
  //                                   then calls BeginReplay + SetScene(17)
  //     tape              0x801E8804  43,200 B (0xA8C0)
  //     count        s32 0x8019C874   subframes (GP 1800 / TA 3084)
  //     write        s32 0x801E48B8   subframe cursor
  //     read         s32 0x801F30C4
  //     wrapped      s32 0x8009E994
  //     mode         s16 0x801E4AB4   (1 = GP 48 B/900 samples, 0 = TA 28 B/1542)
  //     The run's tape is captured at the first scene-17 tick (before the peer
  //     swap); 15/16 stay as a harmless fallback. Never capture at 15/16 only.
  //
  // The tape is read/written only on a screen/scene transition, never per frame.
  // Storage: IndexedDB `rr4-ghost` / store `runs`, key `${room}:${game}` ->
  // `{ host?: Tape, guest?: Tape }`, with an in-memory Map fallback. The tape
  // record itself is `{ room, game, mode, stride, count, bytes, seat, turn, at,
  // trackIndex }` and `count` is the value written to the game's own count
  // register (Ridge: frames, Rage: subframes).
  // `mpGhost` absent or `live` never touches any of this.
  // ---------------------------------------------------------------------
  const GHOST_SIG = {
    // 64-byte PS-X EXE text at vaddr 0x80010000 (unique in the 512 MiB heap).
    ridge: '462f4120524143494e4700005254205259554b595500000052542059454c4c4f5720534f4c56414c4f550000525420424c554520534f4c56414c4f5500000000',
    rage: '494e5345525420434f4e54524f4c4c4552000000434f4e54524f4c4c4552204552524f5200000000486f6c642074686520224e6547636f6e2220696e20616e20',
  };
  const GHOST_SIG_VADDR = 0x80010000;
  const GHOST_RAM = {
    ridge: {
      screen: 0x801D6D28,
      frame: 0x80176AE4,
      // The applier reads the current record through this pointer. The game's
      // own buffer is only the default value of that pointer.
      tapePtr: 0x80080434,
      tape: 0x8006CE7C,
      count: 0x801EB020,
      recorder: 0x801D6D18,
      // Replay arm recipe (what 0x8002A6E0 does at race start).
      armEnable: 0x801EAFF0,      // s16 = 1   (screen 8 early-outs at 0)
      courseSave: 0x80176CBC,     // u32 = course id screen 8 restores
      courseCurrent: 0x80080148,  // s16 = live course id (read, never invented)
      recFlag: 0x80176CE4,        // u32 = 0   (recording/demo flag)
      armPause: 0x801EB000,       // u16 = 0   (2 skips the apply)
      armScript: 0x801EAF90,      // u32 = 0x80071A0C (script table)
      resultsWait: 0x80131014,    // u32 = 511 -> screen 8 -> 9
      resultsScreens: [3, 12],
      playback: 9,
      dispatchTable: 0x8006E7BC,
      // Zeroed-BSS scan window for the staged tape (never the fixed base).
      stageLo: 0x801E0000,
      stageHi: 0x801F0000,
      stageFallback: 0x801E4840,  // 6,440 B zero run the probe found
      stride: 40,
      // 0x8006E7BC - 0x8006CE7C = 6464 B = 161.6 records. 161 is the cap.
      maxCount: 161,
      maxBytes: 6440,
    },
    rage: {
      scene: 0x801E3FEC,
      sceneTimer: 0x801E3DC0,
      tape: 0x801E8804,
      count: 0x8019C874,
      write: 0x801E48B8,
      read: 0x801F30C4,
      wrapped: 0x8009E994,
      mode: 0x801E4AB4,
      fadeLevel: 0x801E3FE8,
      fadeStep: 0x801E3FA8,
      // The finish branch inside the RACE frame (rage-finish-probe.md §2):
      // `if (raceLength < lap && g_RacePhase == 4)` it counts the finish timer
      // to 131 itself and then calls BeginReplay + SetScene(17). Both gates are
      // read from RAM, never invented.
      racePhase: 0x801E6B7C,      // s16 = 4 arms the finish branch
      raceLength: 0x801E406C,     // s32 laps of this run
      lap: 0x8009E544,            // s16 player lap counter
      finishTimer: 0x801E4104,    // s16 counted by the RACE frame
      finishCount: 131,
      maxBytes: 43200,
    },
  };
  // Rage scene ids: 12 = RACE (the only scene whose own finish branch enters the
  // replay), 17 = REPLAY. 15/16 are the race-end screens and are NOT on that
  // path (rage-finish-probe.md §2, check C02b).
  const GHOST_RAGE_SCENE = { race: 12, replay: 17 };
  const GHOST_RAGE_FMT = {
    gp: { mode: 1, stride: 48, samples: 900 },
    ta: { mode: 0, stride: 28, samples: 1542 },
  };
  // Both replay doors are proved: Ridge by `tape-probe.mjs` (screen 3 -> 8 -> 9,
  // the swapped tape drives the rendered frame) and Rage by
  // `rage-finish-probe.mjs` (the finish arm enters scene 17, `g_SceneTimer` and
  // `g_Replay.read` advance, 93/95 pose samples match the tape, a swapped tape
  // changes the frame).
  const GHOST_TRIGGER = { ridge: true, rage: true };
  const GHOST_DB_NAME = 'rr4-ghost';
  const GHOST_DB_STORE = 'runs';
  const GHOST_MAX_BYTES = 43200;

  // `mpGhost` is ignored for R4 and when no lounge role was handed over.
  const ghostRequested = String(qs.get('mpGhost') || '').toLowerCase() === 'ghost';
  const ghostTurnParam = String(qs.get('mpTurn') || '').toLowerCase() === 'guest' ? 'guest' : 'host';
  const ghostEnabled = ghostRequested && !!mp.role &&
    (mpGameKey === 'rage' || mpGameKey === 'ridge');

  const ghost = {
    enabled: ghostEnabled,
    mode: ghostEnabled ? 'ghost' : 'live',
    game: ghostEnabled ? mpGameKey : null,
    role: mp.role,
    turn: ghostEnabled ? ghostTurnParam : null,
    peerSeat: ghostEnabled ? (ghostTurnParam === 'guest' ? 'host' : 'guest') : null,
    label: 'ghost replay (sequential)',
    route: 'replay',
    state: ghostEnabled ? 'starting' : 'off',
    ramBase: null,
    tape: null,
    peer: null,
    family: null,
    captured: 0,
    swapped: 0,
    capturedForRun: false,
    swappedForRun: false,
    capturedAt: null,
    replayedAt: null,
    screen: null,
    scene: null,
    raceSeen: false,
    replaySeen: false,
    screenSeen: false,
    lastFrame: null,
    frames: 0,
    gatedInputs: 0,
    remappedInputs: 0,
    gateInstalled: false,
    guestLive: false,
    noneLogged: false,
    lastError: null,
    lastRender: null,
    staging: null,
    arm: null,
    synthetic: null,
    syntheticTape: null,
    replayedSource: null,
    lastCaptureSig: null,
    lastSwapSig: null,
    capLogged: false,
    els: null,
    timer: null,
    storage: { mode: null, key: null, loadedAt: null, savedAt: null, error: null },
    captureNow: null,
    replayNow: null,
    loadSyntheticTape: null,
    reload: null,
    ram: null,
  };

  // --- RAM window -------------------------------------------------------
  const ghostHex = (hex) => {
    const out = new Uint8Array(Math.floor(hex.length / 2));
    for (let i = 0; i < out.length; i += 1) out[i] = parseInt(hex.substr(i * 2, 2), 16);
    return out;
  };
  const ghostSigs = { ridge: ghostHex(GHOST_SIG.ridge), rage: ghostHex(GHOST_SIG.rage) };

  function ghostModule() {
    const em = window.EJS_emulator;
    const gm = em && em.gameManager;
    return (gm && (gm.Module || em.Module)) || (em && em.Module) || null;
  }
  function ghostHeap() {
    // Re-read the view: Emscripten replaces HEAPU8 on memory growth.
    const M = ghostModule();
    return M && M.HEAPU8 ? M.HEAPU8 : null;
  }
  let ghostRamBase = null;
  let ghostRamCheckedAt = 0;

  // Scan the heap for the loaded exe text. The signature sits at vaddr
  // 0x80010000, so the PSX window starts `0x10000` bytes before the hit.
  function findGhostRam() {
    const H = ghostHeap();
    const sig = ghostSigs[mpGameKey] || ghostSigs.ridge;
    if (!H || H.length < 0x210000 + sig.length) return null;
    const hitOffset = GHOST_SIG_VADDR - 0x80000000;
    const limit = H.length - sig.length;
    let i = H.indexOf(sig[0]);
    while (i >= 0 && i <= limit) {
      let ok = true;
      for (let j = 1; j < sig.length; j += 1) {
        if (H[i + j] !== sig[j]) { ok = false; break; }
      }
      if (ok) {
        const base = i - hitOffset;
        if (base >= 0 && base + 0x200000 <= H.length) return base;
      }
      i = H.indexOf(sig[0], i + 1);
    }
    return null;
  }

  function ghostLocateRam(force) {
    if (ghostRamBase != null && !force) return ghostRamBase;
    if (!force && Date.now() - ghostRamCheckedAt < 2000) return ghostRamBase;
    ghostRamCheckedAt = Date.now();
    try {
      const base = findGhostRam();
      if (base != null) {
        ghostRamBase = base;
        ghost.ramBase = base;
        if (ghost.state === 'starting' || ghost.state === 'noram') ghost.state = 'idle';
        try { npLogLine(`GHOST RAM: PSX window at heap 0x${base.toString(16)} (${mpGameKey}).`); } catch { /* ignore */ }
      }
    } catch (e) {
      ghost.lastError = e && e.message ? e.message : String(e);
    }
    return ghostRamBase;
  }

  const ghostAddrOk = (addr) => Number.isFinite(addr) && addr >= 0x80000000 && addr < 0x80200000;
  function ghostOffset(addr) {
    if (ghostRamBase == null || !ghostAddrOk(addr)) return -1;
    return ghostRamBase + (addr - 0x80000000);
  }
  function gReadBytesAt(n, addr) {
    const H = ghostHeap();
    const o = ghostOffset(addr);
    if (!H || o < 0 || o + n > H.length) return null;
    let v = 0;
    for (let i = 0; i < n; i += 1) v += H[o + i] * (2 ** (8 * i));
    return v;
  }
  function gWriteBytesAt(n, addr, value) {
    const H = ghostHeap();
    const o = ghostOffset(addr);
    if (!H || o < 0 || o + n > H.length) return false;
    let v = Number(value) >>> 0;
    for (let i = 0; i < n; i += 1) { H[o + i] = v & 0xff; v >>>= 8; }
    return true;
  }
  function gReadBlock(addr, len) {
    const H = ghostHeap();
    const o = ghostOffset(addr);
    const n = Math.max(0, Math.trunc(Number(len) || 0));
    if (!H || o < 0 || !n || o + n > H.length) return null;
    return H.slice(o, o + n);
  }
  function gWriteBlock(addr, bytes) {
    const H = ghostHeap();
    const o = ghostOffset(addr);
    if (!H || o < 0 || !bytes || !bytes.length || o + bytes.length > H.length) return false;
    H.set(bytes, o);
    return true;
  }
  function ghostSpanZero(addr, len) {
    const H = ghostHeap();
    const o = ghostOffset(addr);
    const n = Math.max(0, Math.trunc(Number(len) || 0));
    if (!H || o < 0 || !n || o + n > H.length) return false;
    for (let i = 0; i < n; i += 1) if (H[o + i] !== 0) return false;
    return true;
  }
  // First all-zero run of `len` bytes in [lo, hi), 0x40-aligned (the probe's
  // scan): a staged tape must not clobber live game data.
  function ghostFindZeroRun(lo, hi, len) {
    const n = Math.max(1, Math.trunc(Number(len) || 0));
    for (let addr = lo; addr + n <= hi; addr += 0x40) if (ghostSpanZero(addr, n)) return addr;
    return null;
  }
  const ghostRam = {
    locate: () => ghostLocateRam(true),
    base: () => ghostRamBase,
    rd8: (addr) => gReadBytesAt(1, addr),
    rd16: (addr) => gReadBytesAt(2, addr),
    rd32: (addr) => gReadBytesAt(4, addr),
    rd16s: (addr) => { const v = gReadBytesAt(2, addr); return v == null ? null : (v << 16) >> 16; },
    rd32s: (addr) => { const v = gReadBytesAt(4, addr); return v == null ? null : v | 0; },
    wr8: (addr, value) => gWriteBytesAt(1, addr, value),
    wr16: (addr, value) => gWriteBytesAt(2, addr, value),
    wr32: (addr, value) => gWriteBytesAt(4, addr, value),
    read: (addr, len) => gReadBlock(addr, len),
    write: (addr, bytes) => gWriteBlock(addr, bytes),
  };

  // --- Storage: IndexedDB `rr4-ghost`/`runs`, in-memory Map fallback -------
  const ghostMemory = new Map();
  let ghostDbPromise = null;
  let ghostFamily = null;

  const ghostKey = () => `${mp.code || 'LOCAL'}:${mpGameKey}`;

  function ghostDbOpen() {
    if (ghostDbPromise) return ghostDbPromise;
    ghostDbPromise = new Promise((resolve) => {
      try {
        if (typeof indexedDB === 'undefined' || !indexedDB) { resolve(null); return; }
        const req = indexedDB.open(GHOST_DB_NAME, 1);
        req.onupgradeneeded = () => {
          const db = req.result;
          if (db && !db.objectStoreNames.contains(GHOST_DB_STORE)) db.createObjectStore(GHOST_DB_STORE);
        };
        req.onsuccess = () => resolve(req.result || null);
        req.onerror = () => resolve(null);
        req.onblocked = () => resolve(null);
      } catch { resolve(null); }
    });
    return ghostDbPromise;
  }

  function ghostBytesU8(bytes) {
    if (!bytes) return null;
    if (bytes instanceof Uint8Array) return bytes;
    if (bytes instanceof ArrayBuffer) return new Uint8Array(bytes);
    try { return new Uint8Array(bytes); } catch { return null; }
  }

  function ghostTapeMeta(tape) {
    if (!tape) return null;
    const bytes = ghostBytesU8(tape.bytes);
    return {
      seat: tape.seat,
      game: tape.game,
      mode: tape.mode,
      stride: tape.stride,
      count: tape.count,
      bytes: bytes ? bytes.length : 0,
      at: tape.at || null,
      turn: tape.turn || null,
      trackIndex: tape.trackIndex,
    };
  }

  function ghostUpdatePeer() {
    const seat = ghost.turn === 'host' ? 'guest' : 'host';
    ghost.peerSeat = seat;
    const tape = ghostFamily && ghostFamily[seat] ? ghostFamily[seat] : null;
    ghost.peer = ghostTapeMeta(tape);
    ghost.peerTape = tape || null;
    return ghost.peer;
  }

  async function ghostStorageLoad() {
    const key = ghostKey();
    ghost.storage.key = key;
    let family = null;
    const db = await ghostDbOpen();
    if (db) {
      family = await new Promise((resolve) => {
        try {
          const tx = db.transaction(GHOST_DB_STORE, 'readonly');
          const req = tx.objectStore(GHOST_DB_STORE).get(key);
          req.onsuccess = () => resolve(req.result || null);
          req.onerror = () => resolve(null);
        } catch { resolve(null); }
      });
      ghost.storage.mode = 'indexeddb';
    }
    if (!family) {
      family = ghostMemory.get(key) || null;
      if (!db) ghost.storage.mode = 'memory';
    }
    ghostFamily = family && typeof family === 'object' ? family : {};
    ghost.family = ghostFamily;
    ghost.storage.loadedAt = Date.now();
    ghost.storage.error = null;
    ghostUpdatePeer();
    renderGhostBlock();
    return ghostFamily;
  }

  async function ghostStorageSave() {
    const key = ghostKey();
    const family = ghostFamily || {};
    ghostMemory.set(key, family);
    const db = await ghostDbOpen();
    if (!db) {
      ghost.storage.mode = 'memory';
      ghost.storage.savedAt = Date.now();
      return false;
    }
    const ok = await new Promise((resolve) => {
      try {
        const tx = db.transaction(GHOST_DB_STORE, 'readwrite');
        tx.objectStore(GHOST_DB_STORE).put(family, key);
        tx.oncomplete = () => resolve(true);
        tx.onerror = () => resolve(false);
        tx.onabort = () => resolve(false);
      } catch { resolve(false); }
    });
    ghost.storage.mode = ok ? 'indexeddb' : 'memory';
    ghost.storage.savedAt = Date.now();
    if (!ok) ghost.storage.error = 'indexeddb put failed';
    ghostUpdatePeer();
    renderGhostBlock();
    return ok;
  }

  function ghostPersist(tape) {
    // Keep both seats, overwrite only the seat that just recorded.
    ghostFamily = ghostFamily && typeof ghostFamily === 'object' ? ghostFamily : {};
    ghostFamily[tape.seat] = tape;
    ghost.family = ghostFamily;
    ghostStorageSave().catch((e) => {
      ghost.storage.mode = 'memory';
      ghost.storage.error = e && e.message ? e.message : String(e);
    });
  }

  // --- Capture / swap (per game) ----------------------------------------
  // What a swap would write: the stored peer tape, or - harness only - the
  // synthetic diagnostic tape from `loadSyntheticTape()`.
  function ghostSwapSource() {
    if (ghost.peerTape) return ghost.peerTape;
    if (ghost.syntheticTape) return ghost.syntheticTape;
    return null;
  }
  function ghostSourceSynthetic() {
    return !ghost.peerTape && !!ghost.syntheticTape;
  }

  function ghostRageFmt() {
    const raw = gReadBytesAt(2, GHOST_RAM.rage.mode);
    const gp = raw === 1;
    return gp ? GHOST_RAGE_FMT.gp : GHOST_RAGE_FMT.ta;
  }

  function ghostCaptureRidge() {
    const R = GHOST_RAM.ridge;
    const recorder = gReadBytesAt(4, R.recorder);
    if (recorder === 1) return null;                 // tape still being written
    const raw = gReadBytesAt(4, R.count);
    if (raw == null) return null;
    const count = Math.max(0, Math.min(R.maxCount, raw));
    if (!count) { ghost.lastError = 'ridge: count register is 0'; return null; }
    // Read through the pointer the applier/recorder use - never the fixed base.
    const ptr = gReadBytesAt(4, R.tapePtr);
    const base = (ptr != null && ghostAddrOk(ptr) && ptr + count * R.stride <= 0x80200000)
      ? ptr : R.tape;
    const bytes = gReadBlock(base, count * R.stride);
    if (!bytes) { ghost.lastError = 'ridge: tape read out of bounds'; return null; }
    ghost.tapeBase = base;
    return {
      room: mp.code || 'LOCAL',
      game: 'ridge',
      mode: 0,
      stride: R.stride,
      count,
      bytes,
      tapeBase: base,
      seat: ghost.turn,
      turn: ghost.turn,
      at: Date.now(),
      trackIndex: mp.trackIndex,
    };
  }

  // The Ridge tape cannot be written at the documented base: `HEAPU8` writes
  // there pass a read-back yet never reach the applier, and the screen dispatch
  // table at 0x8006E7BC is only 161.6 records above it. So the tape is staged in
  // a zeroed BSS run (scan 0x801E0000..0x801F0000, probe-found 0x801E4840) and
  // the applier's tape pointer 0x80080434 is repointed at it.
  let ghostRidgeStage = null;
  let ghostRidgeStageBytes = 0;
  function ghostRidgeStaging(need) {
    const R = GHOST_RAM.ridge;
    const len = Math.max(1, Math.trunc(Number(need) || 0));
    if (ghostRidgeStage != null && ghostRidgeStageBytes >= len) return ghostRidgeStage;
    let addr = ghostFindZeroRun(R.stageLo, R.stageHi, len);
    let found = addr != null;
    if (addr == null) addr = R.stageFallback;
    ghostRidgeStage = addr;
    ghostRidgeStageBytes = len;
    ghost.staging = { addr, bytes: len, found, at: Date.now() };
    try {
      npLogLine(`GHOST // TAPE STAGED 0x${addr.toString(16)} (${len} B${found ? ', zero run' : ', probe fallback'}), pointer 0x${R.tapePtr.toString(16)}`);
    } catch { /* ignore */ }
    return addr;
  }

  // The game's own arming routine for the replay screen (what 0x8002A6E0 does
  // at race start). `mode` 'results' lets the game walk 3 -> 8 -> 9 by expiring
  // its results wait; 'direct' is the probe's fallback when the results screen
  // is already over (rewind the cursor, enter playback screen 9).
  function ghostArmReplayRidge(count, mode) {
    const R = GHOST_RAM.ridge;
    // The course id is READ, never invented: the saved copy first (that is what
    // screen 8 restores), then the live course cell, then 0.
    const saved = gReadBytesAt(4, R.courseSave);
    const live = gReadBytesAt(2, R.courseCurrent);
    const course = (saved != null && saved <= 7) ? saved
      : ((live != null && live <= 7) ? live : 0);
    const writes = [
      [2, R.armEnable, 1],
      [4, R.courseSave, course],
      [2, R.courseCurrent, course],
      [4, R.recFlag, 0],
      [4, R.recorder, 0],
      [2, R.armPause, 0],
      [4, R.armScript, 0x80071A0C],
      [4, R.count, count],
    ];
    if (mode === 'direct') writes.push([2, R.frame, 0xFFFF], [2, R.screen, R.playback]);
    else writes.push([4, R.resultsWait, 511]);
    let ok = true;
    for (const [width, addr, value] of writes) {
      if (!gWriteBytesAt(width, addr, value)) ok = false;
    }
    ghost.arm = {
      mode,
      course,
      count,
      at: Date.now(),
      writes: writes.map(([width, addr, value]) => ({
        addr: `0x${addr.toString(16)}`, width: width * 8, value: `0x${(value >>> 0).toString(16)}`,
      })),
    };
    try {
      npLogLine(`GHOST // ARM RIDGE ${mode} (course ${course}, ${count}f, ${writes.length} writes${ok ? '' : ', FAILED'})`);
    } catch { /* ignore */ }
    return ok;
  }

  function ghostSwapRidge(mode) {
    const R = GHOST_RAM.ridge;
    const src = ghostSwapSource();
    if (!src) return 'none';
    const bytes = ghostBytesU8(src.bytes);
    if (!bytes || !bytes.length) return 'none';
    if (gReadBytesAt(4, R.recorder) === 1) return 'busy';
    const count = Math.max(0, Math.min(R.maxCount, Math.trunc(Number(src.count) || 0),
      Math.floor(bytes.length / R.stride)));
    if (!count) return 'none';
    const len = count * R.stride;
    const stage = ghostRidgeStaging(len);
    if (stage == null) return 'error';
    if (!gWriteBlock(stage, bytes.subarray(0, len))) { ghost.lastError = 'ridge: staged tape write failed'; return 'error'; }
    if (!gWriteBytesAt(4, R.tapePtr, stage)) { ghost.lastError = 'ridge: tape pointer write failed'; return 'error'; }
    if (!ghostArmReplayRidge(count, mode === 'direct' ? 'direct' : 'results')) {
      ghost.lastError = 'ridge: replay arm rejected';
      return 'error';
    }
    ghost.tapeBase = stage;
    return 'ok';
  }

  function ghostCaptureRage() {
    const R = GHOST_RAM.rage;
    const fmt = ghostRageFmt();
    const writeRaw = gReadBytesAt(4, R.write);
    if (writeRaw == null) return null;
    const write = Math.max(0, writeRaw | 0);
    const countRaw = gReadBytesAt(4, R.count);
    const count = Math.max(0, countRaw | 0);
    // While the RACE scene is recording, `write` is the length (subframes).
    // After BeginReplay has seeded the replay, `write` is already `count + 2`
    // and `count` is the tape length - taking `write` there would add one extra
    // (already-overwritten) record. Both are clamped to the format capacity and
    // to the 43,200-byte arena (TA 1542 / GP 900 samples).
    const subframes = (count >= 2 && write === count + 2) ? count : write;
    const capacity = Math.min(fmt.samples, Math.floor(R.maxBytes / fmt.stride));
    const samples = Math.min(capacity, Math.ceil(subframes / 2));
    if (!samples) { ghost.lastError = 'rage: write cursor is 0'; return null; }
    const bytes = gReadBlock(R.tape, samples * fmt.stride);
    if (!bytes) { ghost.lastError = 'rage: tape read out of bounds'; return null; }
    return {
      room: mp.code || 'LOCAL',
      game: 'rage',
      mode: fmt.mode,
      stride: fmt.stride,
      // The playback loop compares `read` against this in SUBFRAMES.
      count: samples * 2,
      samples,
      bytes,
      seat: ghost.turn,
      turn: ghost.turn,
      at: Date.now(),
      trackIndex: mp.trackIndex,
    };
  }

  // Stage the peer tape at the native base and re-seed every cursor. Shared by
  // the scene-12 arm, the scene-17 arm and the auto swap, so the cursor writes
  // exist in exactly one place.
  function ghostSwapRage() {
    const R = GHOST_RAM.rage;
    const src = ghostSwapSource();
    if (!src) return 'none';
    const bytes = ghostBytesU8(src.bytes);
    if (!bytes || !bytes.length) return 'none';
    const fmt = ghostRageFmt();
    if (Number(src.mode) !== fmt.mode || Number(src.stride) !== fmt.stride) return 'mismatch';
    const samples = Math.max(0, Math.min(fmt.samples, Math.floor(R.maxBytes / fmt.stride),
      Math.floor(bytes.length / fmt.stride), Math.floor((Number(src.count) || 0) / 2)));
    if (!samples) return 'none';
    const count = samples * 2;
    if (!gWriteBlock(R.tape, bytes.subarray(0, samples * fmt.stride))) return 'error';
    // BeginReplay has already seeded the read cursor from the local tape, so
    // every cursor is set explicitly: count, write = count + 2, read = 0, wrapped.
    if (!gWriteBytesAt(4, R.count, count)) return 'error';
    if (!gWriteBytesAt(4, R.write, count + 2)) return 'error';
    if (!gWriteBytesAt(4, R.read, 0)) return 'error';
    if (!gWriteBytesAt(4, R.wrapped, 0)) return 'error';
    ghost.tapeBase = R.tape;
    return 'ok';
  }

  // The supported replay door on Rage: `rage-finish-probe.md` §2/§5.
  //   scene 12 (RACE)  stage the peer tape, then arm the finish branch
  //                    (g_RacePhase = 4, lap = raceLength + 1, finishTimer = 0);
  //                    the RACE frame counts 131 frames and calls
  //                    BeginReplay + SetScene(17) itself.
  //   scene 17 (REPLAY) stage the peer tape and reset the cursors - a mid-replay
  //                    swap (probe C08/C09: the frame changes, the cursor keeps
  //                    advancing on the new tape).
  //   before a race      stage only; a scene poke from the frontend is what the
  //                    probe ruled out (BeginReplay/SeedReplayCars never ran), so
  //                    the scene id is only written after a race has been seen.
  function ghostArmReplayRage(manual) {
    const R = GHOST_RAM.rage;
    const src = ghostSwapSource();
    const scene = gReadBytesAt(4, R.scene);
    const staged = ghostSwapRage();
    const arm = {
      game: 'rage',
      scene,
      staged,
      mode: null,
      armed: false,
      manual: !!manual,
      restageAtReplay: false,
      count: src ? Number(src.count) || 0 : 0,
      at: Date.now(),
      writes: [],
    };
    ghost.arm = arm;
    if (staged !== 'ok') {
      try { npLogLine(`GHOST // ARM RAGE staged=${staged} (scene ${scene})`); } catch { /* ignore */ }
      return staged;
    }
    if (scene === GHOST_RAGE_SCENE.replay) {
      arm.mode = 'replay';
      arm.armed = true;
      try { npLogLine(`GHOST // ARM RAGE replay (${arm.count}f, cursors reset)`); } catch { /* ignore */ }
      return 'ok';
    }
    if (scene === GHOST_RAGE_SCENE.race) {
      const raceLength = gReadBytesAt(4, R.raceLength);
      if (raceLength == null) { ghost.lastError = 'rage: race length unreadable'; return 'error'; }
      const lap = (raceLength + 1) & 0xffff;
      const writes = [
        [2, R.racePhase, 4],
        [2, R.lap, lap],
        [2, R.finishTimer, 0],
      ];
      let ok = true;
      for (const [width, addr, value] of writes) {
        if (!gWriteBytesAt(width, addr, value)) ok = false;
      }
      arm.mode = 'race';
      arm.armed = ok;
      arm.raceLength = raceLength;
      arm.lap = lap;
      // The RACE frame keeps recording for a moment; re-stage the peer tape on
      // the first scene-17 tick so BeginReplay can never seed a half-written
      // tape (idempotent: same bytes, same cursors).
      arm.restageAtReplay = ok;
      arm.writes = writes.map(([width, addr, value]) => ({
        addr: `0x${addr.toString(16)}`, width: width * 8, value: `0x${(value >>> 0).toString(16)}`,
      }));
      if (!ok) { ghost.lastError = 'rage: finish gate write failed'; return 'error'; }
      try {
        npLogLine(`GHOST // ARM RAGE race (scene 12, lap ${lap}/${raceLength}, finish timer 0, ${arm.count}f staged)`);
      } catch { /* ignore */ }
      return 'armed';
    }
    // No race and no replay yet: the tape is staged and the game's own finish
    // will pick it up. Poking scene 17 is only safe AFTER a race has run (probe
    // §4.1), which is exactly what `ghost.raceSeen` records.
    arm.mode = 'staged';
    if (ghost.raceSeen && ghostPokeReplayRage()) {
      arm.mode = 'poke';
      arm.armed = true;
      try { npLogLine(`GHOST // ARM RAGE poke -> scene 17 (scene was ${scene})`); } catch { /* ignore */ }
      return 'ok';
    }
    try { npLogLine(`GHOST // ARM RAGE waits for RACE (scene ${scene}, ${arm.count}f staged)`); } catch { /* ignore */ }
    return 'armed';
  }

  // --- Scheduler (one 16 ms watcher, transition-only tape traffic) --------
  function ghostTriggerProved() {
    return !!GHOST_TRIGGER[ghost.game];
  }

  // Panel states, in the probe's language:
  //   READY (RIDGE)   a rival tape is stored and the replay trigger is proved
  //   READY (RAGE)    same on Rage: the finish arm (`g_RacePhase`/lap) enters
  //                   scene 17 (rage-finish-probe.md)
  //   ARMING REPLAY   the Rage finish branch is armed; the RACE frame is
  //                   counting its own 131 frames and will enter scene 17
  //   COLLECTING      no rival tape yet - the run in progress is being taped
  //   NO TAPE YET     this seat's run was captured, the rival has not finished
  function ghostStatusText() {
    if (!ghost.enabled) return 'GHOST // OFF';
    const peer = ghost.peerSeat === 'host' ? 'HOST' : 'GUEST';
    if (ghost.lastError && ghost.state === 'error') return `GHOST // ERROR (${ghost.lastError})`;
    if (ghost.ramBase == null) return 'GHOST // WAITING FOR CORE RAM';
    // Route B: the tape pose is being applied to a spare rival slot in the live
    // race, or it cannot be (no draw path yet) and A's post-race replay is the
    // real offer. `LIVE (RIDGE)` / `LIVE (RAGE GP)` / `LIVE (RAGE TA)` are the
    // only strings the live path claims; `REPLAY` is the honest fallback.
    if (live.enabled) {
      if (live.armed) return `GHOST // LIVE (${live.specLabel || (ghost.game === 'ridge' ? 'RIDGE' : 'RAGE GP')})`;
      return live.error ? `GHOST // REPLAY (${live.error})` : 'GHOST // REPLAY';
    }
    if (ghost.state === 'mismatch') return 'GHOST // MODE MISMATCH';
    if (ghost.state === 'armed') return 'GHOST // ARMING REPLAY';
    if (ghost.state === 'replayed') {
      const who = ghost.replayedSource === 'synthetic' ? 'SYNTHETIC' : peer;
      return `GHOST // REPLAY ${who} RUN`;
    }
    if (ghost.peer) {
      return ghostTriggerProved()
        ? `GHOST // READY (${ghost.game === 'ridge' ? 'RIDGE' : 'RAGE'})`
        : `GHOST // READY (${ghost.game === 'ridge' ? 'RIDGE' : 'RAGE'}, UNVERIFIED)`;
    }
    if (ghost.syntheticTape) return 'GHOST // READY (TEST TAPE)';
    if (ghost.state === 'captured' || ghost.state === 'none') return 'GHOST // NO TAPE YET';
    return 'GHOST // COLLECTING';
  }

  function ghostUi() {
    if (!ghost.els) {
      ghost.els = {
        block: $('#npGhost'),
        status: $('#npGhostStatus'),
        turn: $('#npGhostTurn'),
        peer: $('#npGhostPeer'),
        storage: $('#npGhostStorage'),
        replay: $('#npGhostReplay'),
        liveRow: $('#npGhostLive'),
        liveBtn: $('#npGhostLiveBtn'),
        liveMeta: $('#npGhostLiveMeta'),
      };
    }
    return ghost.els;
  }

  function renderGhostBlock() {
    try {
      const els = ghostUi();
      const block = els.block;
      if (block) block.hidden = !ghost.enabled;
      if (!ghost.enabled) return;
      const statusText = ghostStatusText();
      const turnText = `DRIVER: ${ghost.turn === 'guest' ? 'GUEST' : 'HOST'}`;
      const src = ghostSwapSource();
      const peerText = ghost.peer
        ? `RIVAL TAPE ${ghost.peer.count}f`
        : (ghost.syntheticTape ? `TEST TAPE ${ghost.syntheticTape.count}f` : 'NO RIVAL TAPE');
      const staged = ghost.staging ? ` // TAPE 0x${Number(ghost.staging.addr).toString(16)}` : '';
      const storageText = `${ghost.storage.mode || 'pending'} // ${ghost.storage.key || ghostKey()}${staged}`;
      const liveText = live.enabled
        ? ` // ${live.armed
          ? `LIVE (${live.specLabel || (ghost.game === 'ridge' ? 'RIDGE' : 'RAGE GP')})`
          : 'REPLAY'}${live.error ? ` ${live.error}` : ''}${live.tape ? ` ${live.tape.count}f` : ''}`
        : '';
      // The watcher calls this once per emulated frame; skip the DOM write when
      // nothing visible changed.
      const sig = `${ghost.state}|${statusText}|${turnText}|${peerText}|${storageText}|${!!src}|${liveText}`;
      if (sig === ghost.lastRender) return;
      ghost.lastRender = sig;
      if (els.status) {
        els.status.textContent = statusText;
        els.status.dataset.state = live.enabled && live.armed
          ? 'live'
          : (ghost.peer ? (ghostTriggerProved() ? 'ready' : 'unverified') : ghost.state || 'idle');
      }
      if (els.turn) els.turn.textContent = turnText;
      if (els.peer) els.peer.textContent = peerText;
      if (els.storage) els.storage.textContent = storageText;
      if (els.liveRow) {
        // Route B indicator + A/B toggle. Hidden unless `?mpLiveGhost=1`, so a
        // plain ghost room keeps exactly the A panel.
        els.liveRow.hidden = !live.enabled;
        if (live.enabled) {
          const on = live.enable === 1 || live.armed;
          if (els.liveBtn) {
            els.liveBtn.textContent = on ? 'ON' : 'OFF';
            els.liveBtn.setAttribute('aria-pressed', on ? 'true' : 'false');
            els.liveBtn.dataset.state = on ? 'on' : 'off';
            els.liveBtn.title = live.error
              ? `Live ghost: ${live.error}`
              : 'Toggle the live ghost car (Route B) without leaving the page';
          }
          if (els.liveMeta) {
            const band = live.ridge ? ` // BAND 0x${Number(live.ridge.lo).toString(16)}` : '';
            els.liveMeta.textContent = live.tape
              ? `${String(live.tape.source).toUpperCase()} ${live.tape.count}f x ${live.tape.stride} B @ 0x${Number(live.tape.addr).toString(16)}${band}${live.error ? ` // ${live.error}` : ''}`
              : (live.error || 'no tape yet');
          }
        }
      }
      if (els.replay) {
        // Both replay doors are proved (Ridge: tape-probe screen 3 -> 8 -> 9;
        // Rage: the RACE frame's finish arm -> scene 17), so the button is the
        // plain manual trigger and only needs a tape to exist.
        const unverified = !ghostTriggerProved();
        els.replay.hidden = false;
        els.replay.disabled = !src;
        els.replay.textContent = unverified ? 'WATCH RIVAL (UNVERIFIED)' : 'WATCH RIVAL';
        els.replay.title = !src
          ? 'No tape yet - the rival has to finish a run first'
          : unverified
            ? 'Swap the rival tape in and start the replay screen (Rage replay screen not proved yet)'
            : 'Swap the rival tape into the native replay and start it';
      }
    } catch { /* ignore */ }
  }

  function ghostCommitCapture(tape) {
    ghost.tape = {
      count: tape.count,
      stride: tape.stride,
      mode: tape.mode,
      samples: tape.samples != null ? tape.samples : tape.count,
      bytes: tape.bytes.length,
      at: tape.at,
    };
    ghost.captured += 1;
    ghost.capturedAt = Date.now();
    ghost.lastCaptureSig = ghostTapeSig(tape);
    ghost.state = 'captured';
    ghost.lastError = null;
    ghost.noneLogged = false;
    try { npLogLine(`GHOST // CAPTURED ${tape.seat} ${tape.count}f`); } catch { /* ignore */ }
    ghostPersist(tape);
    renderGhostBlock();
    return true;
  }

  // Cheap tape identity (count + a few sampled bytes). Used to tell "a new run
  // was just recorded" from "the tape we swapped in is still sitting in RAM":
  // after a replay the game returns to the idle screen with a live count, and
  // without this the engine would replay the rival tape forever.
  function ghostTapeSig(tape) {
    if (!tape) return null;
    const bytes = ghostBytesU8(tape.bytes);
    if (!bytes || !bytes.length) return null;
    const take = (from, to) => {
      let s = '';
      for (let i = from; i < to && i < bytes.length; i += 1) s += bytes[i].toString(16).padStart(2, '0');
      return s;
    };
    const mid = Math.max(0, (bytes.length >> 1) - 4);
    return `${Number(tape.count) || 0}/${bytes.length}/${take(0, 8)}/${take(mid, mid + 8)}/${take(Math.max(0, bytes.length - 8), bytes.length)}`;
  }

  function ghostPeerState() {
    const src = ghostSwapSource();
    if (!src) return 'none';
    if (src.game && src.game !== ghost.game) return 'none';
    if (ghost.game === 'rage') {
      const fmt = ghostRageFmt();
      if (Number(src.mode) !== fmt.mode || Number(src.stride) !== fmt.stride) return 'mismatch';
    }
    return 'ok';
  }

  // The probe's own rule: at a results/finish screen let the game walk
  // 3 -> 8 -> 9 (results wait = 511); anywhere else use the direct fallback.
  function ghostRidgeSwapMode() {
    const screen = gReadBytesAt(2, GHOST_RAM.ridge.screen);
    return (screen != null && GHOST_RAM.ridge.resultsScreens.includes(screen))
      ? 'results' : 'direct';
  }

  function ghostCommitSwap(manual) {
    if (ghostRamBase == null && ghostLocateRam() == null) return 'error';
    const src = ghostSwapSource();
    const synthetic = ghostSourceSynthetic();
    const compat = ghostPeerState();
    if (compat === 'none') {
      ghost.state = 'none';
      if (!ghost.noneLogged) {
        ghost.noneLogged = true;
        try { npLogLine('GHOST // NONE'); } catch { /* ignore */ }
      }
      renderGhostBlock();
      return 'none';
    }
    if (compat === 'mismatch') {
      ghost.state = 'mismatch';
      try { npLogLine('GHOST // MODE MISMATCH'); } catch { /* ignore */ }
      renderGhostBlock();
      return 'mismatch';
    }
    let result;
    if (ghost.game === 'ridge') {
      // The swap itself arms the replay (the pointer + 161-record cap are part
      // of the same recipe), so no separate poke is needed on this disc.
      result = ghostSwapRidge(ghostRidgeSwapMode());
    } else {
      // Rage: stage the peer tape and arm the RACE frame's own finish branch
      // (scene 12), or reset the cursors when the replay is already running.
      result = ghostArmReplayRage(manual);
    }
    if (result === 'ok' || result === 'armed') {
      ghost.swapped += 1;
      ghost.replayedAt = Date.now();
      ghost.lastSwapSig = ghostTapeSig(src);
      ghost.state = result === 'armed' ? 'armed' : 'replayed';
      ghost.lastError = null;
      const count = src ? src.count : 0;
      const who = synthetic ? 'SYNTHETIC' : String(ghost.peerSeat || 'peer').toUpperCase();
      ghost.replayedSource = synthetic ? 'synthetic' : (ghost.peerSeat || 'peer');
      try { npLogLine(`GHOST // ${result === 'armed' ? 'ARM' : 'REPLAY'} ${who} ${count}f`); } catch { /* ignore */ }
    } else if (result === 'busy') {
      ghost.state = 'recording';
    } else if (result === 'mismatch') {
      ghost.state = 'mismatch';
      try { npLogLine('GHOST // MODE MISMATCH'); } catch { /* ignore */ }
    } else if (result === 'error') {
      ghost.state = 'error';
      if (!ghost.lastError) ghost.lastError = 'tape write rejected (out of bounds)';
    }
    renderGhostBlock();
    return result;
  }

  // Rage's manual scene poke - only used AFTER a race has run (probe §4.1: a
  // scene-17 poke animates then, and freezes when it is poked from the
  // frontend). The primary door is the finish arm in `ghostArmReplayRage()`.
  function ghostPokeReplayRage() {
    const R = GHOST_RAM.rage;
    const fade = gWriteBytesAt(4, R.fadeLevel, 0x100) && gWriteBytesAt(4, R.fadeStep, 0);
    return gWriteBytesAt(4, R.scene, GHOST_RAGE_SCENE.replay) && fade;
  }

  function ghostResetRun() {
    ghost.capturedForRun = false;
    ghost.swappedForRun = false;
    ghost.noneLogged = false;
    if (ghost.state === 'captured' || ghost.state === 'replayed' || ghost.state === 'armed'
      || ghost.state === 'none' || ghost.state === 'mismatch') ghost.state = 'idle';
  }

  // Ridge: screen 3 is the finish/results handler (the frontend idles there
  // too), 8/9 are the replay - the tape is only ever touched on 3.
  function ghostTickRidge() {
    const R = GHOST_RAM.ridge;
    const screen = gReadBytesAt(2, R.screen);
    if (screen == null) return;
    ghost.screen = screen;
    if (screen !== 0) ghost.screenSeen = true;
    if (screen !== 3 && screen !== 8 && screen !== 9) { ghostResetRun(); return; }
    // Screens 8/9 READ the tape during playback - never write there.
    if (screen !== 3) return;
    // Never poke before the disc has drawn: the screen machine stalls.
    if (!ghost.screenSeen) return;
    if (gReadBytesAt(4, R.recorder) === 1) { ghost.state = 'recording'; return; }
    // Do not "capture" the tape we just swapped in: a new run is recorded
    // before the next screen-3 visit, and swappedForRun resets off 3/8/9.
    if (!ghost.capturedForRun && !ghost.swappedForRun) {
      const tape = ghostCaptureRidge();
      if (tape) { ghost.capturedForRun = true; ghostCommitCapture(tape); }
    }
    if (ghost.capturedForRun && !ghost.swappedForRun) {
      if (ghostAutoSwapGuard()) {
        const r = ghostCommitSwap(false);
        if (r !== 'busy') ghost.swappedForRun = true;
      } else {
        ghost.swappedForRun = true;
      }
    }
  }

  // Auto swap: only when the tape in RAM is a NEW run (not the rival tape we
  // swapped in last time) and the page has not already swapped too often.
  const GHOST_AUTO_SWAP_CAP = 8;
  function ghostAutoSwapGuard() {
    if (ghost.lastCaptureSig && ghost.lastCaptureSig === ghost.lastSwapSig) {
      ghost.lastError = null;
      return false;
    }
    if (ghost.swapped >= GHOST_AUTO_SWAP_CAP) {
      if (!ghost.capLogged) {
        ghost.capLogged = true;
        try { npLogLine(`GHOST // AUTO SWAP CAP ${GHOST_AUTO_SWAP_CAP} reached - manual WATCH RIVAL only`); } catch { /* ignore */ }
      }
      return false;
    }
    return true;
  }

  function ghostTickRage() {
    const R = GHOST_RAM.rage;
    const scene = gReadBytesAt(4, R.scene);
    if (scene == null) return;
    ghost.scene = scene;
    // Scene 12 (RACE) is the run itself: the recorder is writing the tape and
    // the finish branch is the only supported door into the replay, so nothing
    // is captured, swapped or reset while the race is live.
    if (scene === GHOST_RAGE_SCENE.race) {
      ghost.raceSeen = true;
      return;
    }
    if (scene !== 15 && scene !== 16 && scene !== GHOST_RAGE_SCENE.replay) { ghostResetRun(); return; }
    // Capture at the first scene-17 tick (the tape is final there and the peer
    // swap has not happened yet); 15/16 stay as a harmless fallback, but they
    // are NOT on the finish path (rage-finish-probe.md §2, check C02b).
    if (!ghost.capturedForRun && !ghost.swappedForRun) {
      // Route B keeps the Rage recorder (the ghost tape lives in the second
      // buffer and the stub swaps the tape pointers only around the apply), so
      // this arena still holds THIS seat's run and A persists it as usual.
      if (ghostLiveCaptureSuppressed()) {
        ghost.capturedForRun = true;
        ghost.liveCaptureSkipped = (ghost.liveCaptureSkipped || 0) + 1;
      } else {
        const tape = ghostCaptureRage();
        if (tape) { ghost.capturedForRun = true; ghostCommitCapture(tape); }
      }
    }
    if (scene === GHOST_RAGE_SCENE.replay) {
      // The arm at scene 12 staged the peer tape before the RACE frame had
      // finished counting; re-stage it here (idempotent) so BeginReplay can
      // never seed a half-written tape.
      if (ghost.arm && ghost.arm.restageAtReplay) {
        ghost.arm.restageAtReplay = false;
        const re = ghostSwapRage();
        ghost.arm.restage = re;
        if (re !== 'ok') ghost.lastError = `rage: scene-17 restage ${re}`;
      }
      if (ghost.swappedForRun && ghost.state === 'armed') {
        ghost.state = 'replayed';
        const who = ghost.replayedSource === 'synthetic'
          ? 'SYNTHETIC' : String(ghost.peerSeat || 'peer').toUpperCase();
        try { npLogLine(`GHOST // REPLAY ${who} RUN (scene 17)`); } catch { /* ignore */ }
      }
      ghost.replaySeen = true;
    }
    if (ghost.capturedForRun && !ghost.swappedForRun && (scene === 16 || scene === GHOST_RAGE_SCENE.replay)) {
      if (ghostAutoSwapGuard()) {
        const r = ghostCommitSwap(false);
        if (r !== 'busy') ghost.swappedForRun = true;
      } else {
        ghost.swappedForRun = true;
      }
    }
  }

  function ghostTick() {
    if (!ghost.enabled) return;
    if (ghostLocateRam() == null) {
      if (ghost.state === 'starting') ghost.state = 'noram';
      renderGhostBlock();
      return;
    }
    if (ghost.role !== 'host') { ghostUpdatePeer(); return; }   // guest only watches
    // One evaluation per emulated frame; `getFrameNum` is a 1:1 frame hook.
    const em = window.EJS_emulator;
    const gm = em && em.gameManager;
    const n = gm && typeof gm.getFrameNum === 'function' ? gm.getFrameNum() : null;
    if (n != null) {
      if (n === ghost.lastFrame) return;
      ghost.lastFrame = n;
    }
    ghost.frames += 1;
    try {
      // Route B first: the live ghost only writes its own vars/patches, so A's
      // capture/swap guard below is untouched when `mpLiveGhost` is absent.
      if (live.enabled) ghostLiveTick();
      if (ghost.game === 'ridge') ghostTickRidge();
      else ghostTickRage();
    } catch (e) {
      ghost.lastError = e && e.message ? e.message : String(e);
      ghost.state = 'error';
    }
    renderGhostBlock();
  }

  function ghostStartWatcher() {
    if (!ghost.enabled || ghost.timer) return false;
    ghost.timer = setInterval(ghostTick, 16);
    return true;
  }

  // --- Turn gate (host only) --------------------------------------------
  // `gameManager.functions.simulateInput` is the cwrap the netplay client applies
  // remote input through (and the function the local pads funnel into), so one
  // wrapper covers both seats. It also drops the R4 macro's presses, which is
  // fine: ghost rooms are `macro: manual` on Rage/Ridge only.
  function installGhostGate() {
    if (!ghost.enabled || ghost.role !== 'host') return false;
    if (ghost.gateInstalled) return true;
    const em = window.EJS_emulator;
    const gm = em && em.gameManager;
    const fns = gm && gm.functions;
    if (!fns || typeof fns.simulateInput !== 'function') return false;
    if (fns.__rr4GhostWrapped) { ghost.gateInstalled = true; return true; }
    const original = fns.simulateInput;
    const wrapped = function (player, index, value) {
      const p = Number(player);
      if (ghost.turn === 'guest') {
        if (p === 1) { ghost.remappedInputs += 1; return original.call(this, 0, index, value); }
        if (p === 0) { ghost.gatedInputs += 1; return undefined; }
      } else if (p === 1) {
        ghost.gatedInputs += 1;
        return undefined;
      }
      return original.call(this, p, index, value);
    };
    wrapped.__rr4GhostWrapped = true;
    fns.__rr4GhostWrapped = true;
    fns.simulateInput = wrapped;
    ghost.gateInstalled = true;
    ghost.gateInstalledAt = Date.now();
    try {
      npLogLine(ghost.turn === 'guest'
        ? 'GHOST turn gate: guest pad -> player 0, host pad dropped.'
        : 'GHOST turn gate: host pad only, guest pad dropped.');
    } catch { /* ignore */ }
    return true;
  }

  function ghostStartGatePoll() {
    if (!ghost.enabled || ghost.role !== 'host') return false;
    if (installGhostGate()) return true;
    if (ghost.gatePoll) return false;
    let tries = 0;
    ghost.gatePoll = setInterval(() => {
      tries += 1;
      if (installGhostGate()) {
        clearInterval(ghost.gatePoll);
        ghost.gatePoll = null;
        return;
      }
      if (tries >= 600) {
        clearInterval(ghost.gatePoll);
        ghost.gatePoll = null;
        ghost.lastError = 'gameManager.functions.simulateInput never appeared';
      }
    }, 500);
    return false;
  }

  // --- Harness-only synthetic tape --------------------------------------
  // Builds a valid tape out of the CURRENT car pose and stages it exactly like
  // a peer tape, so the replay trigger can be smoked without a second browser.
  // Diagnostic only: it is used by `replayNow()` when no peer tape is stored.
  //
  // Ridge 40 B record (ridge-rea §1.2): +0x00 u16 x/y/z/h/pitch/yaw/roll/extra
  // from car A (0x80080194), +0x10 the same eight from car B (0x801FCE34),
  // +0x20 u32 modelA, +0x24 u32 modelB.
  const GHOST_RIDGE_CAR_A = 0x80080194;
  // The 12-slot rival array is 0x801ECE34 + k*0x114 (ridge-live-ghost.md §5): the
  // documented 0x801FCE34 is 0x10000 too high.
  const GHOST_RIDGE_CAR_B = 0x801ECE34;
  const GHOST_RIDGE_REC_FIELDS = [
    ['x', 0x10], ['y', 0x14], ['z', 0x18], ['h', 0x40],
    ['pitch', 0x20], ['yaw', 0x24], ['roll', 0x28], ['extra', 0x38],
  ];
  // Rage Time Attack 28 B record (rage-rea §4.2), car A at 0x8009E3DC.
  const GHOST_RAGE_CAR_A = 0x8009E3DC;

  function ghostPoseTapeRidge(count) {
    const out = new Uint8Array(count * GHOST_RAM.ridge.stride);
    for (let i = 0; i < count; i += 1) {
      const o = i * GHOST_RAM.ridge.stride;
      for (let f = 0; f < GHOST_RIDGE_REC_FIELDS.length; f += 1) {
        const [name, off] = GHOST_RIDGE_REC_FIELDS[f];
        let va = gReadBytesAt(2, GHOST_RIDGE_CAR_A + off) || 0;
        let vb = gReadBytesAt(2, GHOST_RIDGE_CAR_B + off) || 0;
        if (name === 'x') { va = (va + i * 3) & 0xffff; vb = (vb + i * 3) & 0xffff; }
        if (name === 'z') { va = (va + i * 2) & 0xffff; vb = (vb + i * 2) & 0xffff; }
        if (name === 'yaw') { va = (va + i * 11) & 0xffff; vb = (vb + i * 11) & 0xffff; }
        const ob = o + 0x10 + f * 2;
        out[o + f * 2] = va & 0xff;
        out[o + f * 2 + 1] = (va >>> 8) & 0xff;
        out[ob] = vb & 0xff;
        out[ob + 1] = (vb >>> 8) & 0xff;
      }
      const ma = gReadBytesAt(4, GHOST_RIDGE_CAR_A + 0x08) || 0;
      const mb = gReadBytesAt(4, GHOST_RIDGE_CAR_B + 0x08) || 0;
      for (let k = 0; k < 4; k += 1) {
        out[o + 0x20 + k] = (ma >>> (8 * k)) & 0xff;
        out[o + 0x24 + k] = (mb >>> (8 * k)) & 0xff;
      }
    }
    return out;
  }

  function ghostPoseTapeRage(count) {
    const stride = GHOST_RAGE_FMT.ta.stride;
    const out = new Uint8Array(count * stride);
    const put16 = (o, off, v) => { out[o + off] = v & 0xff; out[o + off + 1] = (v >>> 8) & 0xff; };
    const put32 = (o, off, v) => {
      let x = Number(v) | 0;
      for (let k = 0; k < 4; k += 1) { out[o + off + k] = x & 0xff; x >>= 8; }
    };
    const r16 = (off) => gReadBytesAt(2, GHOST_RAGE_CAR_A + off) || 0;
    const r32 = (off) => gReadBytesAt(4, GHOST_RAGE_CAR_A + off) || 0;
    for (let i = 0; i < count; i += 1) {
      const o = i * stride;
      put16(o, 0x00, (r16(0x00) + i * 6) & 0xffff);      // x
      put16(o, 0x02, r16(0x04));                          // y
      put16(o, 0x04, (r16(0x08) + i * 3) & 0xffff);      // z
      put16(o, 0x06, r16(0x60));                          // modelY
      put16(o, 0x08, r16(0x20));                          // pitch
      put16(o, 0x0a, (r16(0x24) + i * 37) & 0xffff);      // yaw
      put16(o, 0x0c, r16(0x28));                          // roll
      put16(o, 0x0e, r16(0x48));                          // wheel
      put32(o, 0x10, r32(0x8c));                          // tilt
      put32(o, 0x14, (r32(0x30) + i) | 0);                // trackPoint
      put16(o, 0x18, r16(0x44));                          // steering
    }
    return out;
  }

  // `loadSyntheticTape({ count, stride, fill })` -> byte length (0 on failure).
  // `fill` writes a uniform byte tape (the probe's "does the applier read our
  // bytes" test); without it the tape ramps off the live car pose.
  ghost.loadSyntheticTape = (opts) => {
    const o = opts && typeof opts === 'object' ? opts : {};
    if (!ghost.enabled) return 0;
    if (ghostLocateRam() == null) return 0;
    const rawFill = o.fill;
    const fill = (rawFill === undefined || rawFill === null || !Number.isFinite(Number(rawFill)))
      ? null : (Math.trunc(Number(rawFill)) & 0xff);
    try {
      if (ghost.game === 'ridge') {
        const R = GHOST_RAM.ridge;
        const count = Math.max(1, Math.min(R.maxCount, Math.trunc(Number(o.count) || R.maxCount)));
        const stride = R.stride;      // Ridge records are 40 B, nothing else
        let bytes = ghostPoseTapeRidge(count);
        if (fill != null) { bytes = new Uint8Array(count * stride); bytes.fill(fill); }
        const stage = ghostRidgeStaging(bytes.length);
        if (stage == null) return 0;
        if (!gWriteBlock(stage, bytes)) return 0;
        if (!gWriteBytesAt(4, R.tapePtr, stage)) return 0;
        if (!gWriteBytesAt(4, R.count, count)) return 0;
        ghost.tapeBase = stage;
        ghost.syntheticTape = {
          room: mp.code || 'LOCAL', game: 'ridge', mode: 0, stride,
          count, bytes, staged: stage, seat: 'synthetic', turn: ghost.turn,
          at: Date.now(), trackIndex: mp.trackIndex,
        };
      } else {
        const R = GHOST_RAM.rage;
        const fmt = GHOST_RAGE_FMT.ta;                 // synthetic tape is TA only
        const count = Math.max(1, Math.min(fmt.samples, Math.trunc(Number(o.count) || 300)));
        let bytes = ghostPoseTapeRage(count);
        if (fill != null) { bytes = new Uint8Array(count * fmt.stride); bytes.fill(fill); }
        if (!gWriteBlock(R.tape, bytes)) return 0;
        // Same seeding BeginReplay does: count (subframes), write = N + 2, read
        // = 0, wrapped = 0, and Time Attack mode for the 28 B records.
        if (!gWriteBytesAt(2, R.mode, fmt.mode)) return 0;
        if (!gWriteBytesAt(4, R.count, count * 2)) return 0;
        if (!gWriteBytesAt(4, R.write, count * 2 + 2)) return 0;
        if (!gWriteBytesAt(4, R.read, 0)) return 0;
        if (!gWriteBytesAt(4, R.wrapped, 0)) return 0;
        ghost.syntheticTape = {
          room: mp.code || 'LOCAL', game: 'rage', mode: fmt.mode, stride: fmt.stride,
          count: count * 2, samples: count, bytes, seat: 'synthetic', turn: ghost.turn,
          at: Date.now(), trackIndex: mp.trackIndex,
        };
      }
      ghost.synthetic = {
        bytes: ghost.syntheticTape.bytes.length,
        count: ghost.syntheticTape.count,
        stride: ghost.syntheticTape.stride,
        fill,
        at: Date.now(),
      };
      try {
        npLogLine(`GHOST // SYNTHETIC TAPE ${ghost.syntheticTape.count}f x ${ghost.syntheticTape.stride} B = ${ghost.synthetic.bytes} B`
          + `${fill != null ? `, fill 0x${fill.toString(16)}` : ', from the live pose'}`);
      } catch { /* ignore */ }
      ghost.lastRender = null;
      renderGhostBlock();
      return ghost.synthetic.bytes;
    } catch (e) {
      ghost.lastError = e && e.message ? e.message : String(e);
      ghost.state = 'error';
      renderGhostBlock();
      return 0;
    }
  };
  ghost.injectTape = ghost.loadSyntheticTape;

  // --- Public API -------------------------------------------------------
  ghost.captureNow = () => {
    if (!ghost.enabled) return false;
    if (ghostLocateRam() == null) return false;
    const tape = ghost.game === 'ridge' ? ghostCaptureRidge() : ghostCaptureRage();
    if (!tape) { renderGhostBlock(); return false; }
    ghost.capturedForRun = true;
    ghostCommitCapture(tape);
    return true;
  };
  ghost.replayNow = () => {
    if (!ghost.enabled) return false;
    if (ghostLocateRam() == null) { renderGhostBlock(); return false; }
    // Rage returns 'armed' when the finish branch (scene 12) or the staging-only
    // path was taken instead of an immediate scene-17 swap: both are a live
    // replay request, so both count as success.
    const r = ghostCommitSwap(true);
    if (r === 'ok' || r === 'armed') ghost.swappedForRun = true;
    return r === 'ok' || r === 'armed';
  };
  ghost.reload = () => ghostStorageLoad();
  ghost.ram = ghostRam;
  ghost.statusText = ghostStatusText;
  ghost.triggerProved = () => ghostTriggerProved();
  ghost.swapSource = () => ghostSwapSource();
  ghost.ramMap = GHOST_RAM;
  Object.defineProperty(ghost, 'family', {
    get: () => ghostFamily,
    set: (value) => { ghostFamily = value; },
    enumerable: true,
    configurable: true,
  });

  mp.ghost = ghost;
  mp.drive = ghost.enabled ? 'ghost' : 'live';
  mp.turn = ghost.enabled ? ghost.turn : null;
  mp.ghostLabel = ghost.enabled ? ghost.label : null;
  state.ghost = ghost;
  window.__R4GHOST = ghost;
  window.__R4MP.ghost = ghost;
  window.__R4NET.ghost = ghost;

  // ---------------------------------------------------------------------
  // GHOST (Route B) - live ghost car, opt-in with `?mpLiveGhost=1`.
  //
  // A (above) is the post-race replay of the other seat's native tape. B drives
  // a spare rival car slot from that same tape *while the race is running*: a
  // small stub is written into PSX RAM after boot and ONE shipped code word is
  // repointed at it at runtime. No disc patch. The patch word is only live while
  // the race frame can call it, because the Rage GP prologue (scene 32) reuses
  // the stub's headroom and stalls if DrawCars is repointed there.
  //
  // The addresses are the CORRECTED ones: `ridge-live-ghost.md` §5 supersedes the
  // +0x10000 offsets in `ridge-rea.md`.
  //
  //   Ridge Racer 1994 (SCUS-94300) - the race screen (id 1, handler 0x800143CC)
  //     hook    0x80015014  shipped `jal 0x80024B8C` (0x0C0092E3)
  //                        -> `jal <layout.stub>` (assembled at install)
  //     slot    0x801EDA10  slot 11 of the 12-slot rival array
  //                        (0x801ECE34 + k*0x114). 0x801FDA10 - and the
  //                        documented 0x801FCE34 base - are 0x10000 too high.
  //     tapeptr 0x80080434  the live value is 0x8005CE7C, never 0x8006CE7C:
  //                        always go through the pointer, never a fixed base.
  //     count   0x801EB020  forced to 0x7FFF while armed (the applier will not
  //                        pose at count 0), restored when the ghost leaves.
  //     band    0x801E4800..0x801F0000 - tape, stub, vars and the scratch car
  //                        live in ONE zero-tested run inside that band
  //                        (0x8008A000 is live game data during a race; pages
  //                        0x80130000, 0x801FC000, 0x801EE000 and 0x801EAC00
  //                        were all written by the game late in a race). A guard
  //                        word above the scratch is checked every tick; when
  //                        the game writes over it the block is re-placed.
  //     stub    52 words: runs the shipped scene call, then (enabled) saves the
  //                        live pointer, points 0x80080434 at the ghost tape,
  //                        applies one 40 B record to slot 11 with applyReplay
  //                        (0x8002A894), restores the pointer, advances the
  //                        cursor and forces the slot's draw gates
  //                        (+0x00 = 1, +0x58 = 1). It carries the load-delay
  //                        `nop`s from ghost-tape.md §7.1 - without them the
  //                        `lw tape / sw pointer` pair writes the STALE pointer,
  //                        which is why the earlier Ridge ghost never read its
  //                        tape.
  //     The recorder (0x800150B0) is a separate call and is left alone, so a
  //     Ridge run still records itself for A while the ghost is drawn.
  //
  //   Rage Racer (SLUS-00403) - Grand Prix only
  //     hook 0x8003875C  DrawCars() entry, shipped `0x27BDFFD8`
  //                      (`addiu sp,sp,-40`) -> `j 0x801F4700` = `0x0807D1C0`
  //     stub 0x801F4700  the DrawCars-entry variant: keeps the caller's `ra` in
  //                      $k0 (never in RAM), applies one tape subframe with
  //                      ApplyReplayFrameAndTrackPoint (0x8001F8A0) into
  //                      g_Cars[10], then performs the real prologue and jumps
  //                      into the body at 0x80038760.
  //     slot 0x801F4194  g_Cars[10] (stride 0x19C): activeFlag (+0xAC) = 0,
  //                      aiEnabled (+0xBC) = 1, modelIndex (+0xAE) = 10
  //     tape 0x801F4850  the SECOND buffer: 0x801F4800..0x801FF000 is 43,008 B
  //                      measured free below the stack floor and 600 GP records
  //                      (28,800 B) sit inside it. The stub itself ends at
  //                      0x801F4844 (81 words), so the tape starts just above it.
  //                      Before a race the tape is staged in the native arena
  //                      (0x801E8804), which is idle until the race starts.
  //     ptrs 0x8009EDAC (GP) / 0x8019C4AC (TA) are swapped to the ghost tape
  //                      around every apply and restored after, so the game KEEPS
  //                      RECORDING this seat's run into its own 43,200 B arena:
  //                      `0x80036F4C` is NOT nop-ed and A's capture still works
  //                      in the same race (ghost-tape.md §3.2, option b).
  //     DrawCars is gated on `g_GrandPrixMode != 0`, so Time Attack has no live
  //     draw path: `GHOST_B_RAGE.ta` carries `draw-path-unverified`
  //     (`rage-ta-ghost2.md`: 18/30, no second car) and TA falls back to A.
  //
  // Tape: the peer tape A already stored when its stride/mode match, else A's
  // synthetic tape, else a pose tape built from the live car (the
  // `loadSyntheticTape` contract). `mpLiveGhost` absent/0 leaves A byte-identical.
  // `GHOST // LIVE (RIDGE)` / `(RAGE GP)` is the only claim: the ghost is drawn,
  // not simulated - no shadow, no collision, no AI. The turn gate is A's.
  // ---------------------------------------------------------------------
  const GHOST_LIVE_ON = ['1', 'true', 'on', 'yes'];
  const ghostLiveRequested = GHOST_LIVE_ON.includes(String(qs.get('mpLiveGhost') || '').toLowerCase());

  // --- MIPS-I encoder ---------------------------------------------------
  // Every Route B stub is assembled here instead of being hand-encoded: a
  // displacement outside +-32 KiB, a register typo or a `lui` base that is not a
  // full 64 KiB window throws instead of silently writing the wrong word (the
  // `lui $t4, 0x801a` bug class in ghost-tape.md §7.2).
  const GHOST_REG = {
    zero: 0, at: 1, v0: 2, v1: 3, a0: 4, a1: 5, a2: 6, a3: 7,
    t0: 8, t1: 9, t2: 10, t3: 11, t4: 12, t5: 13, t6: 14, t7: 15,
    s0: 16, s1: 17, s2: 18, s3: 19, s4: 20, s5: 21, s6: 22, s7: 23,
    t8: 24, t9: 25, k0: 26, k1: 27, gp: 28, sp: 29, fp: 30, ra: 31,
  };
  function ghostReg(name) {
    const v = GHOST_REG[name];
    if (v == null) throw new Error(`ghost asm: no register ${name}`);
    return v;
  }
  function ghostLo16(base, addr) {
    const d = Number(addr) - Number(base);
    if (!Number.isFinite(d) || d < -0x8000 || d > 0x7fff) {
      throw new Error(`ghost asm: 0x${(Number(addr) >>> 0).toString(16)} is outside +-32 KiB of 0x${(Number(base) >>> 0).toString(16)}`);
    }
    return d & 0xffff;
  }
  function ghostPickBase(addrs) {
    const list = (addrs || []).map((a) => Number(a) >>> 0);
    if (!list.length) throw new Error('ghost asm: no addresses');
    const lo = (Math.min(...list) & 0xffff0000) >>> 0;
    const hi = (((Math.max(...list) >>> 16) + 1) << 16) >>> 0;
    for (let base = lo; base <= hi; base += 0x10000) {
      if (list.every((a) => a - base >= -0x8000 && a - base <= 0x7fff)) return base >>> 0;
    }
    throw new Error(`ghost asm: no single 64 KiB window for ${list.map((a) => `0x${a.toString(16)}`).join(' ')}`);
  }
  function ghostImm(v) {
    const x = Math.trunc(Number(v));
    if (!Number.isFinite(x) || x < -0x8000 || x > 0xffff) throw new Error(`ghost asm: displacement ${x}`);
    return x & 0xffff;
  }
  function ghostEncode(ins, at, fixups) {
    const op = ins.op;
    const rs = ins.rs != null ? ghostReg(ins.rs) : 0;
    const rt = ins.rt != null ? ghostReg(ins.rt) : 0;
    const rd = ins.rd != null ? ghostReg(ins.rd) : 0;
    const lo = ins.lo != null ? ghostImm(ins.lo) : 0;
    switch (op) {
      case 'nop': return 0;
      case 'lui': return ((0x0f << 26) | (rt << 16) | ((Number(ins.base) >>> 16) & 0xffff)) >>> 0;
      case 'lh': return ((0x21 << 26) | (rs << 21) | (rt << 16) | lo) >>> 0;
      case 'lw': return ((0x23 << 26) | (rs << 21) | (rt << 16) | lo) >>> 0;
      case 'lhu': return ((0x25 << 26) | (rs << 21) | (rt << 16) | lo) >>> 0;
      case 'sh': return ((0x29 << 26) | (rs << 21) | (rt << 16) | lo) >>> 0;
      case 'sw': return ((0x2b << 26) | (rs << 21) | (rt << 16) | lo) >>> 0;
      case 'addiu': return ((0x09 << 26) | (rs << 21) | (rt << 16) | ghostImm(ins.imm)) >>> 0;
      case 'andi': return ((0x0c << 26) | (rs << 21) | (rt << 16) | ghostImm(ins.imm)) >>> 0;
      case 'addu': return ((rs << 21) | (rt << 16) | (rd << 11) | 0x21) >>> 0;
      case 'sltu': return ((rs << 21) | (rt << 16) | (rd << 11) | 0x2b) >>> 0;
      case 'beq': fixups.push({ at, label: ins.to }); return ((0x04 << 26) | (rs << 21) | (rt << 16)) >>> 0;
      case 'bne': fixups.push({ at, label: ins.to }); return ((0x05 << 26) | (rs << 21) | (rt << 16)) >>> 0;
      case 'j': return ((0x02 << 26) | ((Number(ins.addr) >>> 2) & 0x03ffffff)) >>> 0;
      case 'jal': return ((0x03 << 26) | ((Number(ins.addr) >>> 2) & 0x03ffffff)) >>> 0;
      case 'jr': return ((rs << 21) | 0x08) >>> 0;
      default: throw new Error(`ghost asm: unknown op ${op}`);
    }
  }
  function ghostAsm(program) {
    const words = [];
    const labels = Object.create(null);
    const fixups = [];
    for (const ins of program) {
      if (typeof ins === 'string') { labels[ins.replace(/:$/, '')] = words.length; continue; }
      words.push(ghostEncode(ins, words.length, fixups));
    }
    for (const f of fixups) {
      const to = labels[f.label];
      if (to == null) throw new Error(`ghost asm: unknown label ${f.label}`);
      const off = to - (f.at + 1);        // the delay slot is the next word
      if (off < -0x8000 || off > 0x7fff) throw new Error(`ghost asm: branch ${f.label} out of range`);
      words[f.at] = (words[f.at] | (off & 0xffff)) >>> 0;
    }
    return words;
  }

  // --- Ridge 1994: race-screen rival-slot ghost -------------------------
  const GHOST_B_RIDGE = {
    key: 'ridge:race',
    label: 'RIDGE',
    game: 'ridge',
    mode: 0,
    stride: 40,
    samples: 600,                      // 600 records = 24,000 B (10 s @ 10 Hz expanded)
    subframes: false,
    screen: 0x801D6D28,
    raceScreen: 1,                     // handler 0x800143CC
    hook: 0x80015014,
    hookShipped: 0x0C0092E3,           // jal 0x80024B8C
    sceneCall: 0x80024B8C,
    apply: 0x8002A894,                 // applyReplay(cursor, carA, carB)
    tapePtr: 0x80080434,               // live value 0x8005CE7C
    countGate: 0x801EB020,             // the applier's frame gate
    player: 0x80080194,
    camera: 0x801ECB84,                // camera X/Y/Z, one u32 each
    slot: 0x801EDA10,                  // slot 11 of 0x801ECE34 + k*0x114
    slotArray: 0x801ECE34,
    slotStride: 0x114,
    slotModel: null,
    bandLo: 0x801E4840,                // the verified-quiet band next to the tape
    bandHi: 0x801F0000,
    tape: 0x801E483C,                  // the measured first zero run (33,656 B)
    tapeBytes: 24000,
    stubRoom: 0x100,                   // 52 words = 208 B, room for 64
    guardWord: 0x600D600D,             // the marker test's magic
  };

  // --- Rage Racer: DrawCars-entry rival-slot ghost ---------------------
  const GHOST_B_RAGE_TA_FMT = {
    key: 'rage:ta',
    label: 'RAGE TA',
    game: 'rage',
    mode: 0,
    stride: 28,
    samples: 1500,                     // 1,500 TA records = 42,000 B
    subframes: true,
    tapeBytes: 42000,
  };
  const GHOST_B_RAGE = {
    gp: {
      key: 'rage:gp',
      label: 'RAGE GP',
      game: 'rage',
      mode: 1,
      stride: 48,
      samples: 600,                    // 600 GP records = 28,800 B (10 s @ 10 Hz)
      subframes: true,
      hook: 0x8003875C,
      hookShipped: 0x27BDFFD8,         // addiu sp,sp,-40 (DrawCars prologue)
      patchWord: 0x0807D1C0,           // j 0x801F4700
      stubAddr: 0x801F4700,
      contAddr: 0x80038760,
      apply: 0x8001F8A0,               // ApplyReplayFrameAndTrackPoint
      slot: 0x801F4194,                // g_Cars[10]
      slotModel: 10,
      tape: 0x801F4850,                // the second buffer (28,800 B below 0x801FF000)
      tapeBoot: 0x801E8804,            // the native arena, idle before a race
      tapeBytes: 28800,
      pointerGp: 0x8009EDAC,
      pointerTa: 0x8019C4AC,
      vars: {
        tape: 0x801F4470, frame: 0x801F4474, count: 0x801F4478, enable: 0x801F447C,
        slot: 0x801F4480, model: 0x801F4484, savedTa: 0x801F4488, savedGp: 0x801F448C,
        scratch: 0x801F4490,
      },
      // The stub reads the scratch car's ADDRESS from 0x801F4490; the applier
      // writes the player half into 0x801F44B0, so the pointer is stable (the
      // earlier variant pointed the word at itself and the apply overwrote it).
      scratchCar: 0x801F44B0,
      // The recorder STAYS SHIPPED: the ghost tape lives in the second buffer and
      // the stub swaps the two tape pointers per apply, so this seat's own run is
      // still recorded for A and for Route A.
      recorder: { addr: 0x80036F4C, shipped: 0x0C007E6A, nop: false },
    },
    // Time Attack never draws its rivals (`DrawCars` is GP-gated) and no per-frame
    // TA draw path is proved yet (`rage-ta-ghost2.md`: 18/30, no second car), so
    // TA keeps A's replay. Fill this object with the same shape (including `hook`
    // and a `stub`) once a TA draw path is proved; `ghostLivePick` then uses it
    // with no other change.
    ta: {
      key: 'rage:ta',
      label: 'RAGE TA',
      game: 'rage',
      mode: 0,
      stride: 28,
      error: 'draw-path-unverified',
      evidence: '_runtime/ghost-research/rage-ta-ghost2.md (18/30, no second car)',
      hook: null,
    },
  };

  const live = {
    enabled: ghostLiveRequested && ghost.enabled,
    requested: ghostLiveRequested,
    route: 'live',
    label: 'live ghost car',
    specLabel: ghost.game === 'ridge' ? 'RIDGE' : 'RAGE GP',
    game: ghost.enabled ? ghost.game : null,
    armed: false,
    installed: false,
    ready: false,
    hook: null,
    patchWord: null,
    stubAddr: null,
    slot: null,
    spec: null,
    specKey: null,
    tape: null,                        // { count, stride, mode, addr, bytes, source, samples }
    tapeAddr: null,
    error: null,
    mode: null,
    scene: null,
    screen: null,
    inRace: false,
    enable: 0,
    override: null,                    // harness/manual A/B: 0 | 1 | null
    frames: 0,
    applied: 0,
    resets: 0,
    loops: 0,
    tries: 0,
    installs: 0,
    patched: false,
    patchToggles: 0,
    refreshes: 0,
    ridge: null,                       // the Ridge layout: { lo, tape, guard, stub, vars, scratch, bytes }
    ridgeReloads: 0,
    ridgeCountSaved: null,
    refreshedAt: null,
    stagedAt: null,
    tapeSig: null,
    hookInfo: null,
    stubInfo: null,
    recorderInfo: null,
    captureSkipped: 0,
    captureKeptLogged: false,
    logLines: [],
    els: null,
  };

  function ghostLiveLog(text) {
    try {
      if (live.logLines.length > 12) live.logLines.shift();
      live.logLines.push(text);
      npLogLine(text);
    } catch { /* ignore */ }
  }

  function ghostStubBytes(words) {
    const out = new Uint8Array(words.length * 4);
    for (let i = 0; i < words.length; i += 1) {
      let v = words[i] >>> 0;
      for (let k = 0; k < 4; k += 1) { out[i * 4 + k] = v & 0xff; v >>>= 8; }
    }
    return out;
  }
  function ghostBytesMatch(a, b) {
    if (!a || !b || a.length !== b.length) return false;
    for (let i = 0; i < a.length; i += 1) if (a[i] !== b[i]) return false;
    return true;
  }
  function ghostJalWord(addr) {
    return ((0x03 << 26) | ((Number(addr) >>> 2) & 0x03ffffff)) >>> 0;
  }

  // Which hook spec applies right now, and which record format the live mode
  // uses. Rage has one proved spec (GP); the TA spec is optional and its absence
  // is the honest `draw-path-unverified` case. The tape is staged in the CURRENT
  // format either way, so the applier's own GP/TA branch always matches.
  function ghostLivePick() {
    if (ghost.game === 'ridge') {
      const S = GHOST_B_RIDGE;
      return { spec: S, fmt: S, mode: 0, drawable: true, label: S.label, reason: null };
    }
    const mode = gReadBytesAt(2, GHOST_RAM.rage.mode);
    const ta = GHOST_B_RAGE.ta;
    const taDrawable = !!(ta && ta.hook && !ta.error);
    const gpDrawable = mode === 1;
    return {
      spec: (mode === 0 && taDrawable) ? ta : GHOST_B_RAGE.gp,
      fmt: mode === 1 ? GHOST_B_RAGE.gp : GHOST_B_RAGE_TA_FMT,
      mode,
      drawable: gpDrawable || (mode === 0 && taDrawable),
      label: mode === 1 ? GHOST_B_RAGE.gp.label : GHOST_B_RAGE_TA_FMT.label,
      reason: gpDrawable || (mode === 0 && taDrawable) ? null : (ta && ta.error) || 'draw-path-unverified',
    };
  }

  // --- Ridge: the quiet band next to the tape ---------------------------
  // tape | guard | stub | vars | scratch, all inside ONE zero-tested run of
  // 0x801E4800..0x801F0000. The guard word is the marker test: it is written once
  // per (re)install and read on every tick, so a page the game rewrites late in
  // the race is detected and the block moves to a fresh zero run.
  function ghostLiveRidgeLayoutAt(lo, tapeBytes) {
    const S = GHOST_B_RIDGE;
    const t = Number(lo) >>> 0;
    const bytes = Math.max(S.stride, Math.trunc(Number(tapeBytes) || S.tapeBytes));
    const guard = Math.ceil((t + bytes) / 4) * 4;
    const stub = Math.ceil((guard + 0x10) / 16) * 16;
    const vars = stub + S.stubRoom;
    const scratch = vars + 0x20;
    return {
      lo: t, tape: t, bytes, guard, stub, vars, scratch,
      need: (scratch + 0xC0 - t) >>> 0,
      at: Date.now(),
    };
  }
  function ghostLiveRidgeGuard(lay) {
    if (!lay) return false;
    return gReadBytesAt(4, lay.guard) === GHOST_B_RIDGE.guardWord;
  }
  function ghostLiveRidgeWriteGuard(lay) {
    if (!lay) return false;
    return gWriteBytesAt(4, lay.guard, GHOST_B_RIDGE.guardWord);
  }
  function ghostLiveRidgeEnsure(wantBytes, inRace) {
    const S = GHOST_B_RIDGE;
    const bytes = Math.max(S.stride, Math.trunc(Number(wantBytes) || S.tapeBytes));
    let cur = live.ridge;
    if (cur && live.installed && !ghostLiveRidgeGuard(cur)) {
      // The marker is gone: the game wrote our page (measured failure mode - the
      // race frame then stops iterating). Move the whole block.
      live.ridge = null;
      live.ridgeReloads += 1;
      ghostLiveLog('GHOST // LIVE RIDGE band rewritten by the game - re-placing the stub block');
      cur = null;
    }
    if (cur && cur.bytes >= bytes) return cur;
    const lo = ghostFindZeroRun(S.bandLo, S.bandHi, bytes + 0x200);
    if (lo != null) {
      const lay = ghostLiveRidgeLayoutAt(lo, bytes);
      live.ridge = lay;
      ghostLiveLog(`GHOST // LIVE RIDGE block 0x${lay.lo.toString(16)} (tape ${bytes} B, stub 0x${lay.stub.toString(16)}, vars 0x${lay.vars.toString(16)}, scratch 0x${lay.scratch.toString(16)}${inRace ? '' : ', boot scan'})`);
      return lay;
    }
    if (cur) return cur;
    const lay = ghostLiveRidgeLayoutAt(S.tape, bytes);
    live.ridge = lay;
    ghostLiveLog(`GHOST // LIVE RIDGE block 0x${lay.lo.toString(16)} (probe default, no zero run found)`);
    return lay;
  }

  // --- Ridge stub -------------------------------------------------------
  function ghostStubRidge(spec) {
    const V = spec.vars;
    const lay = { vars: V.frame, scratch: spec.scratchCar, slot: spec.slot };
    const base = ghostPickBase([V.frame, V.count, V.enable, V.tape, V.ra, V.saved, lay.scratch, lay.slot]);
    const o = (addr) => ghostLo16(base, addr);
    return ghostAsm([
      { op: 'lui', rt: 't0', base },
      { op: 'addu', rd: 't9', rs: 'ra', rt: 'zero' },
      { op: 'sw', rt: 't9', rs: 't0', lo: o(V.ra) },                  // keep the hook's ra
      { op: 'jal', addr: GHOST_B_RIDGE.sceneCall },                    // the shipped call
      { op: 'nop' },
      { op: 'lui', rt: 't0', base },
      { op: 'lw', rt: 't6', rs: 't0', lo: o(V.enable) },
      { op: 'nop' },                                                   // load delay
      { op: 'beq', rs: 't6', rt: 'zero', to: 'end' },
      { op: 'nop' },
      { op: 'lw', rt: 't1', rs: 't0', lo: o(V.frame) },                // cursor
      { op: 'lw', rt: 't2', rs: 't0', lo: o(V.count) },                // count
      { op: 'nop' },                                                   // load delay
      { op: 'sltu', rd: 't3', rs: 't1', rt: 't2' },
      { op: 'beq', rs: 't3', rt: 'zero', to: 'end' },                  // cursor ran out
      { op: 'nop' },
      { op: 'lui', rt: 't4', base: 0x80080000 },
      { op: 'lw', rt: 't5', rs: 't4', lo: 0x0434 },                    // live tape pointer
      { op: 'lw', rt: 't7', rs: 't0', lo: o(V.tape) },                 // ghost tape
      { op: 'nop' },                                                   // <- the missing load delay
      { op: 'sw', rt: 't7', rs: 't4', lo: 0x0434 },                    // apply reads OUR tape
      { op: 'sw', rt: 't5', rs: 't0', lo: o(V.saved) },                // saved in RAM (temps die)
      { op: 'addu', rd: 'a0', rs: 't1', rt: 'zero' },
      { op: 'lui', rt: 'a1', base },
      { op: 'addiu', rt: 'a1', rs: 'a1', imm: o(lay.scratch) },
      { op: 'lui', rt: 'a2', base },
      { op: 'addiu', rt: 'a2', rs: 'a2', imm: o(lay.slot) },
      { op: 'jal', addr: GHOST_B_RIDGE.apply },
      { op: 'nop' },
      { op: 'lui', rt: 't0', base },
      { op: 'lui', rt: 't4', base: 0x80080000 },
      { op: 'lw', rt: 't5', rs: 't0', lo: o(V.saved) },
      { op: 'nop' },                                                   // load delay
      { op: 'sw', rt: 't5', rs: 't4', lo: 0x0434 },                    // restore the live pointer
      { op: 'lw', rt: 't1', rs: 't0', lo: o(V.frame) },
      { op: 'nop' },                                                   // load delay
      { op: 'addiu', rt: 't1', rs: 't1', imm: 1 },
      { op: 'sw', rt: 't1', rs: 't0', lo: o(V.frame) },                // cursor++
      { op: 'lui', rt: 'v0', base },
      { op: 'addiu', rt: 'v0', rs: 'v0', imm: o(lay.slot) },
      { op: 'addiu', rt: 'v1', rs: 'zero', imm: 1 },
      { op: 'sh', rt: 'v1', rs: 'v0', lo: 0x00 },                      // +0x00 = 1 (active)
      { op: 'sw', rt: 'v1', rs: 'v0', lo: 0x58 },                      // +0x58 = 1 (on track, draw)
      { op: 'lui', rt: 't8', base: 0x80080000 },
      { op: 'lhu', rt: 't9', rs: 't8', lo: 0x0196 },                   // player car +0x02
      { op: 'nop' },                                                   // load delay
      { op: 'sh', rt: 't9', rs: 'v0', lo: 0x02 },
      'end:',
      { op: 'lui', rt: 't0', base },
      { op: 'lw', rt: 'ra', rs: 't0', lo: o(V.ra) },
      { op: 'nop' },                                                   // load delay
      { op: 'jr', rs: 'ra' },
      { op: 'nop' },
    ]);
  }

  // --- Rage stub (DrawCars entry) --------------------------------------
  // Faithful to the ghost-tape probe's second-buffer variant: both tape pointers
  // are saved, pointed at the ghost tape for the duration of the apply, then
  // restored - so the game keeps recording its own arena while the ghost plays.
  function ghostStubRage(spec) {
    const V = spec.vars;
    const base = ghostPickBase([
      V.tape, V.frame, V.count, V.enable, V.slot, V.model, V.savedTa, V.savedGp, V.scratch,
      spec.scratchCar, spec.slot,
    ]);
    const v = (addr) => ghostLo16(base, addr);
    const taPtr = ghostLo16(0x801A0000, spec.pointerTa);
    const gpPtr = ghostLo16(0x800A0000, spec.pointerGp);
    // g_GrandPrixMode sits in the 0x801E window, too far from the vars for one base.
    const modeBase = 0x801E0000;
    const mode = ghostLo16(modeBase, GHOST_RAM.rage.mode);
    return ghostAsm([
      { op: 'addu', rd: 'k0', rs: 'ra', rt: 'zero' },                  // caller's ra survives in $k0
      { op: 'lui', rt: 't0', base },
      { op: 'lw', rt: 't6', rs: 't0', lo: v(V.enable) },
      { op: 'nop' },                                                   // load delay
      { op: 'bne', rs: 't6', rt: 'zero', to: 'body' },
      { op: 'nop' },
      { op: 'lw', rt: 'v0', rs: 't0', lo: v(V.slot) },                 // disabled: park the slot
      { op: 'nop' },                                                   // load delay
      { op: 'addiu', rt: 'v1', rs: 'zero', imm: -1 },
      { op: 'sh', rt: 'v1', rs: 'v0', lo: 0xac },
      { op: 'beq', rs: 'zero', rt: 'zero', to: 'done' },
      { op: 'nop' },
      'body:',
      { op: 'lw', rt: 't8', rs: 't0', lo: v(V.slot) },                 // the ghost slot
      { op: 'nop' },                                                   // load delay
      { op: 'lw', rt: 't1', rs: 't0', lo: v(V.frame) },                // subframe cursor
      { op: 'lw', rt: 't2', rs: 't0', lo: v(V.count) },                // subframes
      { op: 'nop' },                                                   // load delay
      { op: 'sltu', rd: 't3', rs: 't1', rt: 't2' },
      { op: 'bne', rs: 't3', rt: 'zero', to: 'wrapped' },
      { op: 'nop' },
      { op: 'addu', rd: 't1', rs: 'zero', rt: 'zero' },                // loop the tape
      'wrapped:',
      { op: 'sw', rt: 't1', rs: 't0', lo: v(V.frame) },
      // save both tape pointers, then point them at the ghost tape
      { op: 'lui', rt: 't4', base: 0x801A0000 },
      { op: 'lw', rt: 't5', rs: 't4', lo: taPtr },
      { op: 'nop' },                                                   // load delay
      { op: 'sw', rt: 't5', rs: 't0', lo: v(V.savedTa) },
      { op: 'lui', rt: 't7', base: 0x800A0000 },
      { op: 'lw', rt: 't9', rs: 't7', lo: gpPtr },
      { op: 'nop' },                                                   // load delay
      { op: 'sw', rt: 't9', rs: 't0', lo: v(V.savedGp) },
      { op: 'lw', rt: 't6', rs: 't0', lo: v(V.tape) },
      { op: 'nop' },                                                   // load delay
      { op: 'sw', rt: 't6', rs: 't4', lo: taPtr },
      { op: 'sw', rt: 't6', rs: 't7', lo: gpPtr },
      // ApplyReplayFrameAndTrackPoint(cursor, player-half car, ghost slot); TA
      // records are one car, so the slot is passed as both arguments.
      { op: 'addu', rd: 'a0', rs: 't1', rt: 'zero' },
      { op: 'lui', rt: 'a1', base },
      { op: 'lw', rt: 'a1', rs: 'a1', lo: v(V.scratch) },              // scratch car POINTER
      { op: 'addu', rd: 'a2', rs: 't8', rt: 'zero' },
      { op: 'lui', rt: 'k1', base: modeBase },
      { op: 'lh', rt: 'k1', rs: 'k1', lo: mode },                      // g_GrandPrixMode
      { op: 'nop' },                                                   // load delay
      { op: 'bne', rs: 'k1', rt: 'zero', to: 'gp' },
      { op: 'nop' },
      { op: 'addu', rd: 'a1', rs: 'a2', rt: 'zero' },
      'gp:',
      { op: 'jal', addr: spec.apply },
      { op: 'nop' },
      // Second apply on the EVEN subframe of the pair. The applier interpolates
      // odd subframes with (recorded + current) / 2 and the game's own track
      // update rewrites g_Cars[10] between frames, so an odd apply lands on a
      // midpoint. Re-applying the even index writes the record verbatim, so the
      // ghost's pose IS the tape record on every frame (measured: 6/16 -> 16/16).
      { op: 'lui', rt: 't0', base },
      { op: 'lui', rt: 'a2', base },
      { op: 'lw', rt: 'a2', rs: 'a2', lo: v(V.slot) },
      { op: 'lw', rt: 't1', rs: 't0', lo: v(V.frame) },
      { op: 'nop' },                                                   // load delay
      { op: 'andi', rt: 'a0', rs: 't1', imm: 0xfffe },
      { op: 'lui', rt: 'a1', base },
      { op: 'lw', rt: 'a1', rs: 'a1', lo: v(V.scratch) },
      { op: 'jal', addr: spec.apply },
      { op: 'nop' },
      { op: 'lui', rt: 't4', base: 0x801A0000 },
      { op: 'lui', rt: 't0', base },
      { op: 'lw', rt: 't5', rs: 't0', lo: v(V.savedTa) },
      { op: 'nop' },                                                   // load delay
      { op: 'sw', rt: 't5', rs: 't4', lo: taPtr },
      { op: 'lui', rt: 't7', base: 0x800A0000 },
      { op: 'lw', rt: 't9', rs: 't0', lo: v(V.savedGp) },
      { op: 'nop' },                                                   // load delay
      { op: 'sw', rt: 't9', rs: 't7', lo: gpPtr },
      { op: 'lw', rt: 't1', rs: 't0', lo: v(V.frame) },
      { op: 'nop' },                                                   // load delay
      { op: 'addiu', rt: 't1', rs: 't1', imm: 1 },
      { op: 'sw', rt: 't1', rs: 't0', lo: v(V.frame) },
      { op: 'lw', rt: 'v0', rs: 't0', lo: v(V.slot) },
      { op: 'nop' },                                                   // load delay
      { op: 'sh', rt: 'zero', rs: 'v0', lo: 0xac },                    // activeFlag = 0 (draw it)
      { op: 'addiu', rt: 'v1', rs: 'zero', imm: 1 },
      { op: 'sw', rt: 'v1', rs: 'v0', lo: 0xbc },                      // aiEnabled = 1
      { op: 'lw', rt: 'v1', rs: 't0', lo: v(V.model) },
      { op: 'nop' },                                                   // load delay
      { op: 'sh', rt: 'v1', rs: 'v0', lo: 0xae },                      // modelIndex
      'done:',
      { op: 'addu', rd: 'ra', rs: 'k0', rt: 'zero' },
      { op: 'addiu', rt: 'sp', rs: 'sp', imm: -40 },                   // the real prologue
      { op: 'j', addr: spec.contAddr },
      { op: 'nop' },
    ]);
  }

  // --- tape builders (diagnostic / fallback) -----------------------------
  // Rage GP record (48 B): player half +0x00..+0x0E, rival half +0x10..+0x1E,
  // tilt +0x20, trackPoint player/rival +0x24/+0x28, steer +0x2C/+0x2E.
  // TA record (28 B): one car, +0x10 tilt, +0x14 trackPoint, +0x18 steer.
  // rage-rea §4.2. `static` writes one identical record (exactly checkable, and
  // the applier's odd-subframe interpolation becomes a no-op).
  function ghostLivePoseTapeRage(fmt, samples, opts) {
    const o = opts && typeof opts === 'object' ? opts : {};
    const fixed = !!o.static;
    const ahead = Number(o.ahead) || 0;
    const left = Number(o.left) || 0;
    const car = GHOST_RAGE_CAR_A;
    const r16 = (off) => gReadBytesAt(2, car + off) || 0;
    const r32 = (off) => gReadBytesAt(4, car + off) || 0;
    const x0 = r16(0x00);
    const y0 = r16(0x04);
    const z0 = r16(0x08);
    const yaw0 = r16(0x24);
    const angle = (yaw0 * 2 * Math.PI) / 4096;
    const fx = Math.sin(angle);
    const fz = Math.cos(angle);
    const lx = -fz;
    const lz = fx;
    const out = new Uint8Array(samples * fmt.stride);
    const put16 = (off, v) => {
      out[off] = v & 0xff;
      out[off + 1] = (v >>> 8) & 0xff;
    };
    const put32 = (off, v) => {
      let x = Number(v) | 0;
      for (let k = 0; k < 4; k += 1) { out[off + k] = x & 0xff; x >>= 8; }
    };
    for (let i = 0; i < samples; i += 1) {
      const base = i * fmt.stride;
      const k = fixed ? 0 : i;
      const d = ahead + (fixed ? 0 : k * 6);
      const l = left + (fixed ? 0 : k * 2);
      const x = Math.round(x0 + fx * d + lx * l) & 0xffff;
      const z = Math.round(z0 + fz * d + lz * l) & 0xffff;
      const yaw = (yaw0 + (fixed ? 0 : k * 37)) & 0xffff;
      const pitch = r16(0x20);
      const roll = r16(0x28);
      const wheel = r16(0x48);
      const modelY = r16(0x60);
      const steer = r16(0x44);
      const tilt = r32(0x8c);
      const tp = r32(0x30);
      put16(base + 0x00, x);
      put16(base + 0x02, y0);
      put16(base + 0x04, z);
      put16(base + 0x06, modelY);
      put16(base + 0x08, pitch);
      put16(base + 0x0a, yaw);
      put16(base + 0x0c, roll);
      put16(base + 0x0e, wheel);
      if (fmt.stride === GHOST_RAGE_FMT.gp.stride) {
        // Rival half -> the ghost slot (ApplyReplayFrame's third argument).
        put16(base + 0x10, x);
        put16(base + 0x12, y0);
        put16(base + 0x14, z);
        put16(base + 0x16, modelY);
        put16(base + 0x18, pitch);
        put16(base + 0x1a, yaw);
        put16(base + 0x1c, roll);
        put16(base + 0x1e, wheel);
        put32(base + 0x20, tilt);
        put32(base + 0x24, tp);
        put32(base + 0x28, tp);
        put16(base + 0x2c, steer);
        put16(base + 0x2e, steer);
      } else {
        put32(base + 0x10, tilt);
        put32(base + 0x14, (tp + k) | 0);
        put16(base + 0x18, steer);
      }
    }
    return out;
  }

  // The camera axis: 0x801ECB84/88/8C are the camera X/Y/Z (`ridge-rea` §3.1).
  // The in-car camera looks from the camera towards the car, so that direction -
  // not the car's yaw - is where a ghost has to be placed for a clean A/B.
  function ghostRidgeCameraAxis() {
    const S = GHOST_B_RIDGE;
    const rdWorld = (addr) => {
      const w = gReadBytesAt(4, addr);
      if (w == null) return null;
      const s = w | 0;
      if (s >= -0x8000 && s <= 0xffff) return s & 0xffff;
      const h = gReadBytesAt(2, addr);
      return h == null ? null : h;
    };
    const cx = rdWorld(S.camera);
    const cz = rdWorld(S.camera + 8);
    if (cx == null || cz == null) return null;
    const x0 = gReadBytesAt(2, S.player + 0x10) || 0;
    const z0 = gReadBytesAt(2, S.player + 0x18) || 0;
    let dx = x0 - cx;
    let dz = z0 - cz;
    if (dx > 0x8000) dx -= 0x10000; else if (dx < -0x8000) dx += 0x10000;
    if (dz > 0x8000) dz -= 0x10000; else if (dz < -0x8000) dz += 0x10000;
    const len = Math.hypot(dx, dz);
    if (!(len > 64) || len > 4000) return null;
    // The in-car camera sits behind the car, so camera -> car is "ahead". If the
    // reading looks like it points backwards, flip it against the car's own yaw
    // (a bad camera read then still places the ghost up the road).
    const yaw = gReadBytesAt(2, S.player + 0x24) || 0;
    const fa = (yaw * 2 * Math.PI) / 4096;
    const dot = (dx / len) * Math.sin(fa) + (dz / len) * Math.cos(fa);
    if (dot < 0) { dx = -dx; dz = -dz; }
    return { fx: dx / len, fz: dz / len, len, dot, cam: { x: cx, z: cz } };
  }

  // Ridge 40 B record: 8 u16 from car A, 8 u16 from car B, modelA, modelB
  // (ridge-rea §1.2). Both halves carry the ghost pose, so the spare slot 11 (the
  // second car) shows it.
  function ghostLivePoseTapeRidge(samples, opts) {
    const o = opts && typeof opts === 'object' ? opts : {};
    const fixed = !!o.static;
    const ahead = Number(o.ahead) || 0;
    const left = Number(o.left) || 0;
    const stride = GHOST_B_RIDGE.stride;
    const out = new Uint8Array(samples * stride);
    const r16 = (off) => gReadBytesAt(2, GHOST_RIDGE_CAR_A + off) || 0;
    const r32 = (off) => gReadBytesAt(4, GHOST_RIDGE_CAR_A + off) || 0;
    const x0 = r16(0x10);
    const z0 = r16(0x18);
    const yaw0 = r16(0x24);
    const cam = o.axis === 'car' ? null : ghostRidgeCameraAxis();
    let fx;
    let fz;
    if (cam) {
      fx = cam.fx;
      fz = cam.fz;
    } else {
      const angle = (yaw0 * 2 * Math.PI) / 4096;
      fx = Math.sin(angle);
      fz = Math.cos(angle);
    }
    const lx = -fz;
    const lz = fx;
    const model = r32(0x08);
    for (let i = 0; i < samples; i += 1) {
      const base = i * stride;
      const k = fixed ? 0 : i;
      const d = ahead + (fixed ? 0 : k * 3);
      const l = left + (fixed ? 0 : k * 2);
      const x = Math.round(x0 + fx * d + lx * l) & 0xffff;
      const z = Math.round(z0 + fz * d + lz * l) & 0xffff;
      const yaw = (yaw0 + (fixed ? 0 : k * 11)) & 0xffff;
      for (let half = 0; half < 2; half += 1) {
        const hb = base + half * 0x10;
        const put = (off, v) => { out[hb + off] = v & 0xff; out[hb + off + 1] = (v >>> 8) & 0xff; };
        put(0x00, x);
        put(0x02, r16(0x14));
        put(0x04, z);
        put(0x06, r16(0x40));
        put(0x08, r16(0x20));
        put(0x0a, yaw);
        put(0x0c, r16(0x28));
        put(0x0e, r16(0x38));
      }
      for (let k2 = 0; k2 < 4; k2 += 1) {
        out[base + 0x20 + k2] = (model >>> (8 * k2)) & 0xff;
        out[base + 0x24 + k2] = (model >>> (8 * k2)) & 0xff;
      }
    }
    return out;
  }

  // --- tape staging ------------------------------------------------------
  function ghostLiveTapeFrom(srcTape, fmt, source) {
    const bytes = ghostBytesU8(srcTape && srcTape.bytes);
    if (!bytes || !bytes.length) return null;
    const cap = Math.min(fmt.samples, Math.floor(fmt.tapeBytes / fmt.stride));
    const samples = Math.min(cap, Math.floor(bytes.length / fmt.stride));
    if (!samples) return null;
    return {
      source,
      samples,
      count: fmt.subframes ? samples * 2 : samples,
      stride: fmt.stride,
      mode: fmt.mode,
      game: fmt.game,
      bytes: bytes.subarray(0, samples * fmt.stride),
    };
  }

  function ghostLiveTapeSource(fmt) {
    const compatible = (t) => !!t && Number(t.stride) === fmt.stride && Number(t.mode) === fmt.mode;
    if (compatible(ghost.peerTape)) {
      const made = ghostLiveTapeFrom(ghost.peerTape, fmt, 'peer');
      if (made) return made;
    }
    if (compatible(ghost.syntheticTape)) {
      const made = ghostLiveTapeFrom(ghost.syntheticTape, fmt, 'synthetic');
      if (made) return made;
    }
    const samples = Math.max(1, Math.min(fmt.samples, Math.floor(fmt.tapeBytes / fmt.stride)));
    const bytes = fmt.game === 'ridge'
      ? ghostLivePoseTapeRidge(samples, {})
      : ghostLivePoseTapeRage(fmt, samples, {});
    return {
      source: 'pose',
      samples,
      count: fmt.subframes ? samples * 2 : samples,
      stride: fmt.stride,
      mode: fmt.mode,
      game: fmt.game,
      bytes,
    };
  }

  // How many bytes the tape will take, WITHOUT building it (the Ridge layout is
  // sized from this on every tick).
  function ghostLiveTapeBytes(fmt) {
    const cap = Math.min(fmt.samples, Math.floor(fmt.tapeBytes / fmt.stride));
    const pick = (t) => (!!t && Number(t.stride) === fmt.stride && Number(t.mode) === fmt.mode ? t : null);
    const src = pick(ghost.peerTape) || pick(ghost.syntheticTape);
    const samples = src && src.bytes && src.bytes.length
      ? Math.min(cap, Math.floor(src.bytes.length / fmt.stride))
      : cap;
    return Math.max(fmt.stride, Math.max(1, samples) * fmt.stride);
  }

  function ghostLiveStageTape(spec, fmt, addr) {
    const form = fmt || spec;
    const src = ghostLiveTapeSource(form);
    if (!src) { live.error = 'no-tape'; return null; }
    const room = form.game === 'ridge' && live.ridge ? live.ridge.bytes : form.tapeBytes;
    const fit = Math.max(1, Math.min(src.samples, Math.floor(room / form.stride)));
    const samples = Math.min(src.samples, fit);
    const count = form.subframes ? samples * 2 : samples;
    const target = Number(addr) || spec.tape;
    const sig = `${spec.key}:${form.mode}:${src.source}:${samples}:${form.stride}:${target}:${live.ridge ? live.ridge.stub : 0}`;
    if (sig === live.tapeSig && live.tape) return live.tape;
    const bytes = samples === src.samples ? src.bytes : src.bytes.subarray(0, samples * form.stride);
    if (!gWriteBlock(target, bytes)) { live.error = 'tape-write'; return live.tape || null; }
    // The stub reads the record count and the tape address from its own vars; the
    // game's own registers are left alone (A owns those).
    if (!gWriteBytesAt(4, spec.vars.count, count)) {
      live.error = 'count-write';
      return live.tape || null;
    }
    if (spec.vars.tape != null && !gWriteBytesAt(4, spec.vars.tape, target)) {
      live.error = 'tape-var-write';
      return live.tape || null;
    }
    live.tape = {
      count,
      samples,
      stride: form.stride,
      mode: form.mode,
      addr: target,
      bootAddr: form.tapeBoot || null,
      bytes: bytes.length,
      source: src.source,
      at: Date.now(),
    };
    live.tapeAddr = target;
    live.tapeSig = sig;
    live.stagedAt = Date.now();
    live.error = null;
    ghostLiveLog(`GHOST // LIVE TAPE ${src.source.toUpperCase()} ${count}f x ${form.stride} B = ${bytes.length} B @ 0x${target.toString(16)} (${form.label || spec.label || form.game})`);
    return live.tape;
  }

  // --- install (stub + one word patch) -----------------------------------
  function ghostLiveResolve(raw) {
    if (!raw) return null;
    if (raw.game !== 'ridge') {
      if (!raw.stub) raw.stub = ghostStubRage(raw);
      return raw;
    }
    const lay = live.ridge;
    if (!lay) return null;
    const vars = {
      frame: lay.vars + 0x00,
      count: lay.vars + 0x04,
      enable: lay.vars + 0x08,
      tape: lay.vars + 0x0C,
      ra: lay.vars + 0x10,
      saved: lay.vars + 0x14,
    };
    const own = {
      ...raw,
      baseKey: raw.key,
      stubAddr: lay.stub,
      vars,
      scratchCar: lay.scratch,
      patchWord: ghostJalWord(lay.stub),
    };
    own.stub = ghostStubRidge(own);
    return own;
  }

  function ghostLiveRecorderInfo(spec) {
    if (!spec.recorder) return null;
    const now = gReadBytesAt(4, spec.recorder.addr);
    live.recorderInfo = {
      addr: spec.recorder.addr,
      shipped: spec.recorder.shipped,
      nop: !!spec.recorder.nop,
      readBack: now,
      applied: spec.recorder.nop ? now === 0 : false,
      at: Date.now(),
    };
    return live.recorderInfo;
  }

  function ghostLiveWriteVars(spec, tape) {
    const vars = spec.vars;
    const t = tape || live.tape;
    gWriteBytesAt(4, vars.frame, 0);
    gWriteBytesAt(4, vars.count, t ? t.count : 0);
    gWriteBytesAt(4, vars.enable, 0);
    if (vars.ra != null) gWriteBytesAt(4, vars.ra, 0);
    if (vars.saved != null) gWriteBytesAt(4, vars.saved, 0);
    if (vars.savedTa != null) gWriteBytesAt(4, vars.savedTa, 0);
    if (vars.savedGp != null) gWriteBytesAt(4, vars.savedGp, 0);
    if (vars.slot != null) gWriteBytesAt(4, vars.slot, spec.slot);
    if (vars.model != null) {
      const model = spec.slotModel != null ? spec.slotModel : (gReadBytesAt(2, spec.slot + 0xAE) || 0);
      gWriteBytesAt(4, vars.model, model & 0xffff);
    }
    if (vars.scratch != null) gWriteBytesAt(4, vars.scratch, spec.scratchCar);
    if (vars.tape != null) gWriteBytesAt(4, vars.tape, t ? t.addr : spec.tape);
  }

  function ghostLiveInstall(spec) {
    if (!spec) return false;
    const hookNow = gReadBytesAt(4, spec.hook);
    if (hookNow === spec.patchWord) {
      live.installed = true;
      live.ready = true;
      live.spec = spec;
      live.specKey = spec.key;
      live.hook = spec.hook;
      live.patchWord = spec.patchWord;
      live.stubAddr = spec.stubAddr;
      live.slot = spec.slot;
      live.patched = true;
      ghostLiveRidgeWriteGuard(live.ridge);
      ghostLiveRecorderInfo(spec);
      return true;
    }
    if (hookNow !== spec.hookShipped) {
      live.error = `hook-word 0x${(Number(hookNow) >>> 0).toString(16)}`;
      return false;
    }
    const bytes = ghostStubBytes(spec.stub);
    const before = gReadBlock(spec.stubAddr, bytes.length);
    if (!gWriteBlock(spec.stubAddr, bytes)) { live.error = 'stub-write'; return false; }
    const back = gReadBlock(spec.stubAddr, bytes.length);
    const match = ghostBytesMatch(back, bytes);
    live.stubInfo = {
      addr: spec.stubAddr, bytes: bytes.length, words: spec.stub.length,
      match, zeroBefore: !!(before && before.every((b) => b === 0)), at: Date.now(),
    };
    if (!match) { live.error = 'stub-readback'; return false; }
    // Variables. Everything the stub dereferences lives here, not in the code.
    ghostLiveWriteVars(spec, live.tape);
    if (spec.vars.scratch != null) gWriteBytesAt(4, spec.vars.scratch, spec.scratchCar);
    // The one word that makes it run.
    if (!gWriteBytesAt(4, spec.hook, spec.patchWord)) { live.error = 'patch-write'; return false; }
    const readBack = gReadBytesAt(4, spec.hook);
    live.hookInfo = {
      addr: spec.hook, shipped: spec.hookShipped, patchWord: spec.patchWord,
      readBack, applied: readBack === spec.patchWord,
      everApplied: readBack === spec.patchWord, at: Date.now(), toggles: 0,
    };
    if (!live.hookInfo.applied) { live.error = 'patch-word'; return false; }
    if (spec.recorder && spec.recorder.nop) ghostLiveSetRecorder(spec, true);
    ghostLiveRecorderInfo(spec);
    ghostLiveRidgeWriteGuard(live.ridge);
    live.spec = spec;
    live.specKey = spec.key;
    live.hook = spec.hook;
    live.patchWord = spec.patchWord;
    live.stubAddr = spec.stubAddr;
    live.slot = spec.slot;
    live.installed = true;
    live.ready = true;
    live.installs += 1;
    live.patched = true;
    live.error = null;
    ghostLiveLog(`GHOST // LIVE STUB 0x${spec.stubAddr.toString(16)} (${bytes.length} B, ${spec.stub.length} words) -> hook 0x${spec.hook.toString(16)} 0x${(spec.hookShipped >>> 0).toString(16)} -> 0x${(spec.patchWord >>> 0).toString(16)}`
      + `${spec.recorder ? (spec.recorder.nop ? ', recorder nop' : ', recorder kept') : ''}${live.stubInfo.zeroBefore ? '' : ', stub area was not zero'}`);
    return true;
  }

  // Restore the shipped words (used when the hook spec, the stub address or the
  // patch word changes, e.g. the Ridge block being re-placed).
  function ghostLiveUnpatch() {
    const spec = live.spec;
    if (!spec) return false;
    try {
      gWriteBytesAt(4, spec.hook, spec.hookShipped);
      if (spec.recorder && spec.recorder.nop && live.recorderInfo && live.recorderInfo.applied) {
        gWriteBytesAt(4, spec.recorder.addr, spec.recorder.shipped);
      }
    } catch { /* ignore */ }
    live.installed = false;
    live.ready = false;
    live.spec = null;
    live.specKey = null;
    return true;
  }

  // --- per-frame state ---------------------------------------------------
  function ghostLiveInRace(spec, pick) {
    if (spec.game === 'ridge') {
      const screen = gReadBytesAt(2, GHOST_B_RIDGE.screen);
      live.screen = screen;
      live.scene = null;
      live.mode = pick ? pick.mode : 0;
      return screen === GHOST_B_RIDGE.raceScreen;
    }
    const scene = gReadBytesAt(4, GHOST_RAM.rage.scene);
    live.scene = scene;
    live.screen = null;
    live.mode = pick ? pick.mode : live.mode;
    return scene === GHOST_RAGE_SCENE.race;
  }

  // The hook is only live while the race frame can call it. Measured: the GP
  // PROLOGUE (scene 32) reuses the BSS headroom the stub lives in and stalls when
  // the DrawCars entry is repointed at it, so every other scene sees the shipped
  // word. Same for the recorder nop (when a spec uses one).
  function ghostLiveSetPatch(spec, on) {
    if (!spec) return false;
    const now = gReadBytesAt(4, spec.hook);
    const target = on ? spec.patchWord : spec.hookShipped;
    if (now === target) {
      live.patched = on;
      if (live.hookInfo) live.hookInfo.readBack = now;
      if (spec.recorder) ghostLiveSetRecorder(spec, on);
      return true;
    }
    if (now !== spec.patchWord && now !== spec.hookShipped) {
      live.error = `hook-word 0x${(Number(now) >>> 0).toString(16)}`;
      return false;
    }
    gWriteBytesAt(4, spec.hook, target);
    const back = gReadBytesAt(4, spec.hook);
    const ok = back === target;
    live.hookInfo = {
      addr: spec.hook, shipped: spec.hookShipped, patchWord: spec.patchWord,
      readBack: back, applied: ok && on, everApplied: (live.hookInfo && live.hookInfo.everApplied) || (ok && on),
      at: Date.now(), toggles: ((live.hookInfo && live.hookInfo.toggles) || 0) + 1,
    };
    if (!ok) { live.error = 'patch-word'; return false; }
    live.patched = on;
    live.patchToggles += 1;
    if (spec.recorder) ghostLiveSetRecorder(spec, on);
    return true;
  }

  function ghostLiveSetRecorder(spec, on) {
    if (!spec.recorder || !spec.recorder.nop) return false;
    const now = gReadBytesAt(4, spec.recorder.addr);
    const target = on ? 0 : spec.recorder.shipped;
    if (now === target) {
      if (live.recorderInfo) live.recorderInfo.readBack = now;
      return true;
    }
    if (now !== 0 && now !== spec.recorder.shipped) return false;
    gWriteBytesAt(4, spec.recorder.addr, target);
    live.recorderInfo = {
      addr: spec.recorder.addr, shipped: spec.recorder.shipped, patch: 0, nop: true,
      readBack: gReadBytesAt(4, spec.recorder.addr), applied: on && gReadBytesAt(4, spec.recorder.addr) === 0,
      at: Date.now(),
    };
    return true;
  }

  // Rewrite the stub + every variable the stub dereferences. Run on every race
  // entry: the headroom is not exclusively ours outside the race frame
  // (live-ghost-probe.md R08c only proved it for the RACE frame).
  function ghostLiveRefresh(spec) {
    const bytes = ghostStubBytes(spec.stub);
    const before = gReadBlock(spec.stubAddr, bytes.length);
    const sameBefore = ghostBytesMatch(before, bytes);
    if (!sameBefore) gWriteBlock(spec.stubAddr, bytes);
    ghostLiveWriteVars(spec, live.tape);
    if (spec.vars.scratch != null) gWriteBytesAt(4, spec.vars.scratch, spec.scratchCar);
    live.enable = 0;
    const back = gReadBlock(spec.stubAddr, bytes.length);
    const match = ghostBytesMatch(back, bytes);
    live.stubInfo = {
      addr: spec.stubAddr, bytes: bytes.length, words: spec.stub.length, match,
      zeroBefore: live.stubInfo ? !!live.stubInfo.zeroBefore : !!(before && before.every((b) => b === 0)),
      clobbered: !sameBefore, at: Date.now(), refreshes: live.refreshes,
    };
    ghostLiveRidgeWriteGuard(live.ridge);
    live.refreshedAt = Date.now();
    live.refreshes += 1;
    if (!match) { live.error = 'stub-clobbered'; return false; }
    return true;
  }

  // Ridge: the applier only writes when `idx < *(0x801EB020)` (the game's own
  // "recorded frames" register, 0 on this race screen), so a live ghost needs a
  // non-zero limit. The game's value is restored when the ghost leaves the race.
  function ghostLiveRidgeCount(inRace) {
    const R = GHOST_RAM.ridge;
    const now = gReadBytesAt(4, R.count);
    if (inRace) {
      if (live.ridgeCountSaved == null) live.ridgeCountSaved = now;
      if (now !== 0x7fff) gWriteBytesAt(4, R.count, 0x7fff);
      return 0x7fff;
    }
    if (live.ridgeCountSaved != null) {
      if (now === 0x7fff) gWriteBytesAt(4, R.count, live.ridgeCountSaved);
      live.ridgeCountSaved = null;
    }
    return now;
  }

  // The Rage stub dereferences the scratch-car word every time it applies a GP
  // record; re-arm it while the ghost is live (the applier writes into the
  // scratch CAR, not into the pointer, so this is a cheap guard).
  function ghostLiveArmScratch(spec) {
    if (!spec || spec.vars.scratch == null || spec.game !== 'rage') return false;
    if (gReadBytesAt(4, spec.vars.scratch) === spec.scratchCar) return true;
    return gWriteBytesAt(4, spec.vars.scratch, spec.scratchCar);
  }

  // Rage KEEPS its recorder (the ghost tape lives in the second buffer and the
  // stub only swaps the tape pointers per apply), so A must still persist this
  // seat's run. The call site stays for the Rage tick's own bookkeeping.
  function ghostLiveCaptureSuppressed() {
    if (live.enabled && live.armed && ghost.game === 'rage' && !live.captureKeptLogged) {
      live.captureKeptLogged = true;
      ghostLiveLog('GHOST // LIVE - Rage recorder kept (ghost tape in the second buffer); this run is still taped for the rival.');
    }
    return false;
  }

  function ghostLiveApplyEnable(spec, on) {
    if (!spec) return 0;
    const want = on ? 1 : 0;
    if (live.enable !== want || gReadBytesAt(4, spec.vars.enable) !== want) {
      gWriteBytesAt(4, spec.vars.enable, want);
      live.enable = want;
    }
    live.armed = want === 1;
    return want;
  }

  function ghostLiveTick() {
    if (!live.enabled) return false;
    live.frames += 1;
    if (ghost.role !== 'host') { live.error = 'guest-core'; return false; }
    if (ghostLocateRam() == null) { live.error = 'no-ram'; return false; }
    try {
      const pick = ghostLivePick();
      const raw = pick.spec;
      live.specLabel = pick.label;
      if (!raw) {
        live.error = pick.reason || 'draw-path-unverified';
        ghostLiveApplyEnable(live.spec, 0);
        return false;
      }
      const inRace = ghostLiveInRace(raw, pick);
      // 1. where the ghost tape lives right now (Ridge: the quiet band; Rage: the
      //    second buffer once a race runs, the idle arena before that).
      let tapeAddr;
      if (raw.game === 'ridge') {
        const lay = ghostLiveRidgeEnsure(ghostLiveTapeBytes(pick.fmt), inRace);
        tapeAddr = lay ? lay.tape : raw.tape;
      } else {
        tapeAddr = inRace ? raw.tape : (raw.tapeBoot || raw.tape);
      }
      live.tapeAddr = tapeAddr;
      // 2. resolve the stub against that layout (Ridge re-assembles, Rage is fixed)
      const spec = ghostLiveResolve(raw);
      if (!spec) { live.error = 'no-layout'; return false; }
      const moved = live.installed && (live.specKey !== spec.key
        || live.stubAddr !== spec.stubAddr || live.patchWord !== spec.patchWord);
      if (moved) { ghostLiveUnpatch(); live.tapeSig = null; }
      if (!live.installed) {
        live.tries += 1;
        if (!ghostLiveInstall(spec)) return false;
      }
      // 3. stage the tape in the format the CURRENT mode uses (Rage GP 48 B / TA
      //    28 B / Ridge 40 B), from boot on, so the applier's branch always matches
      ghostLiveStageTape(spec, pick.fmt, tapeAddr);
      const drawable = pick.drawable && inRace;
      if (!drawable) {
        // Honest split: the mode's draw path is unproved (Rage TA) vs the draw
        // path is fine but the disc is not in a race right now.
        live.error = pick.drawable ? 'not-in-race' : (pick.reason || 'draw-path-unverified');
      } else if (live.tape) {
        live.error = pick.reason || null;
      }
      // 4. a run starts here: the headroom may have been reused by another scene,
      //    so the stub + vars are rewritten and the cursor rewound
      if (inRace && !live.inRace) {
        ghostLiveRefresh(spec);
        live.resets += 1;
      }
      live.inRace = inRace;
      // 5. the shipped word is repointed only while the race frame can call it
      ghostLiveSetPatch(spec, !!inRace);
      if (spec.game === 'ridge') ghostLiveRidgeCount(!!inRace);
      // 6. loop the tape at its count (the Rage stub wraps itself; Ridge stops)
      if (inRace && live.tape) {
        const f = gReadBytesAt(4, spec.vars.frame);
        if (f != null && Number(f) >= live.tape.count) {
          gWriteBytesAt(4, spec.vars.frame, 0);
          live.loops += 1;
        }
      }
      const want = (drawable && !!live.tape) ? 1 : 0;
      const en = live.override == null ? want : live.override;
      if (en === 1) ghostLiveArmScratch(spec);
      ghostLiveApplyEnable(spec, en === 1);
      if (live.armed) live.applied += 1;
      renderGhostBlock();
      return live.armed;
    } catch (e) {
      live.error = e && e.message ? e.message : String(e);
      live.armed = false;
      return false;
    }
  }

  // --- read-back helpers (also the DOM smoke's evidence) -----------------
  function ghostLiveReadSlot() {
    const spec = live.spec;
    if (!spec || ghostRamBase == null) return null;
    const rd = (n, off) => gReadBytesAt(n, spec.slot + off);
    const frame = gReadBytesAt(4, spec.vars.frame);
    const count = gReadBytesAt(4, spec.vars.count);
    const enable = gReadBytesAt(4, spec.vars.enable);
    if (spec.game === 'ridge') {
      return {
        game: 'ridge', frame, count, enable, slot: spec.slot,
        active: rd(2, 0x00), state: rd(4, 0x58), model: rd(4, 0x08),
        x: rd(2, 0x10), y: rd(2, 0x14), z: rd(2, 0x18), h: rd(2, 0x40),
        pitch: rd(2, 0x20), yaw: rd(2, 0x24), roll: rd(2, 0x28), extra: rd(2, 0x38),
      };
    }
    return {
      game: 'rage', frame, count, enable, slot: spec.slot,
      x: rd(2, 0x00), y: rd(2, 0x04), z: rd(2, 0x08),
      pitch: rd(2, 0x20), yaw: rd(2, 0x24), roll: rd(2, 0x28),
      modelY: rd(2, 0x60), steer: rd(2, 0x44), wheel: rd(2, 0x48),
      trackPoint: rd(4, 0x30),
      active: rd(2, 0xAC), model: rd(2, 0xAE), ai: rd(4, 0xBC),
    };
  }

  // Read one record back out of PSX RAM (proves the staged tape is really there).
  function ghostLiveTapeSample(i) {
    const t = live.tape;
    if (!t) return null;
    const idx = Math.max(0, Math.trunc(Number(i) || 0));
    const bytes = gReadBlock(t.addr + idx * t.stride, t.stride);
    return bytes ? Array.from(bytes) : null;
  }

  function ghostLiveTargetAddr(raw, inRace) {
    if (!raw) return null;
    if (raw.game === 'ridge') return live.ridge ? live.ridge.tape : raw.tape;
    return inRace ? raw.tape : (raw.tapeBoot || raw.tape);
  }

  live.install = () => {
    if (!live.enabled) return false;
    if (ghostLocateRam() == null) return false;
    if (live.installed) return true;
    const pick = ghostLivePick();
    if (!pick.spec) return false;
    const inRace = ghostLiveInRace(pick.spec, pick);
    if (pick.spec.game === 'ridge') ghostLiveRidgeEnsure(ghostLiveTapeBytes(pick.fmt), inRace);
    return ghostLiveInstall(ghostLiveResolve(pick.spec));
  };
  live.tick = () => ghostLiveTick();
  live.readSlot = () => ghostLiveReadSlot();
  live.tapeSample = (i) => ghostLiveTapeSample(i);
  live.setEnable = (v) => {
    live.override = (v === null || v === undefined) ? null : (Number(v) ? 1 : 0);
    try { ghostLiveTick(); } catch { /* ignore */ }
    return { enable: live.enable, armed: live.armed, override: live.override };
  };
  live.stage = () => {
    const pick = ghostLivePick();
    if (!pick.spec || ghostLocateRam() == null) return live.tape || null;
    const inRace = ghostLiveInRace(pick.spec, pick);
    if (pick.spec.game === 'ridge') ghostLiveRidgeEnsure(ghostLiveTapeBytes(pick.fmt), inRace);
    const spec = ghostLiveResolve(pick.spec);
    if (!spec) return live.tape || null;
    if (!live.installed || live.stubAddr !== spec.stubAddr) {
      ghostLiveUnpatch();
      if (!ghostLiveInstall(spec)) return live.tape || null;
    }
    live.tapeSig = null;
    return ghostLiveStageTape(spec, pick.fmt, ghostLiveTargetAddr(pick.spec, inRace));
  };
  // Diagnostic tape from the CURRENT car pose (the `loadSyntheticTape` contract,
  // extended with `static` + `ahead`/`left` so a smoke can place the ghost along
  // the camera axis and check the slot pose against one identical record).
  live.synthetic = (opts) => {
    const o = opts && typeof opts === 'object' ? opts : {};
    if (!live.enabled) return 0;
    if (ghostLocateRam() == null) { live.error = 'no-ram'; return 0; }
    const pick = ghostLivePick();
    const raw = pick.spec;
    const fmt = pick.fmt;
    if (!raw) { live.error = pick.reason || 'draw-path-unverified'; return 0; }
    if (!pick.drawable) { live.error = pick.reason || 'draw-path-unverified'; return 0; }
    const inRace = ghostLiveInRace(raw, pick);
    try {
      const cap = Math.min(fmt.samples, Math.floor(fmt.tapeBytes / fmt.stride));
      const want = Math.trunc(Number(o.count) || 0);
      const samples = Math.max(1, Math.min(cap, want || cap));
      const bytes = fmt.game === 'ridge'
        ? ghostLivePoseTapeRidge(samples, o)
        : ghostLivePoseTapeRage(fmt, samples, o);
      ghost.syntheticTape = {
        room: mp.code || 'LOCAL',
        game: fmt.game,
        mode: fmt.mode,
        stride: fmt.stride,
        count: fmt.subframes ? samples * 2 : samples,
        samples,
        bytes,
        seat: 'synthetic',
        turn: ghost.turn,
        at: Date.now(),
        trackIndex: mp.trackIndex,
      };
      ghost.synthetic = {
        bytes: bytes.length, count: ghost.syntheticTape.count, stride: fmt.stride,
        fill: null, static: !!o.static, at: Date.now(),
      };
      live.tapeSig = null;
      if (raw.game === 'ridge') ghostLiveRidgeEnsure(bytes.length, inRace);
      const spec = ghostLiveResolve(raw);
      if (!spec) { live.error = 'no-layout'; return 0; }
      if (!live.installed || live.stubAddr !== spec.stubAddr) {
        ghostLiveUnpatch();
        if (!ghostLiveInstall(spec)) return 0;
      }
      const tape = ghostLiveStageTape(spec, fmt, ghostLiveTargetAddr(raw, inRace));
      ghostLiveLog(`GHOST // LIVE SYNTHETIC ${ghost.syntheticTape.count}f x ${fmt.stride} B${o.static ? ', static pose' : ', from the live pose'} @ 0x${tape ? tape.addr.toString(16) : '?'}`);
      renderGhostBlock();
      return tape ? tape.bytes : 0;
    } catch (e) {
      live.error = e && e.message ? e.message : String(e);
      return 0;
    }
  };
  live.unstage = () => {
    // Put the shipped words back and take the ghost out of the draw list.
    const spec = live.spec;
    if (spec) {
      try {
        gWriteBytesAt(4, spec.vars.enable, 0);
        gWriteBytesAt(2, spec.slot + (spec.game === 'ridge' ? 0x00 : 0xAC), spec.game === 'ridge' ? 0 : 0xffff);
        if (spec.game === 'ridge') ghostLiveRidgeCount(false);
      } catch { /* ignore */ }
    }
    live.enable = 0;
    live.armed = false;
    live.inRace = false;
    return ghostLiveUnpatch();
  };
  live.ridgeBand = () => (live.ridge ? { ...live.ridge } : null);
  live.ragePlan = () => ({
    tape: GHOST_B_RAGE.gp.tape,
    bootTape: GHOST_B_RAGE.gp.tapeBoot,
    stub: GHOST_B_RAGE.gp.stubAddr,
    slot: GHOST_B_RAGE.gp.slot,
    pointerGp: GHOST_B_RAGE.gp.pointerGp,
    pointerTa: GHOST_B_RAGE.gp.pointerTa,
    recorder: GHOST_B_RAGE.gp.recorder.nop ? 'nop' : 'kept',
    ta: GHOST_B_RAGE.ta.error || null,
  });

  ghost.live = live;
  live.state = ghost;
  window.__R4NET.live = live;
  Object.defineProperty(live, 'status', {
    get: () => (live.armed
      ? `LIVE (${live.specLabel || (ghost.game === 'ridge' ? 'RIDGE' : 'RAGE GP')})`
      : (live.error ? `REPLAY (${live.error})` : 'REPLAY')),
    enumerable: false,
  });
  if (live.enabled) {
    ghostLiveLog(`LIVE GHOST armed (Route B, ${ghost.game}) - stub + one word patch in RAM, peer tape ${ghost.turn === 'host' ? 'of the guest' : 'of the host'}.`);
  } else if (ghostLiveRequested) {
    ghostLiveLog('LIVE GHOST requested but the ghost room is off (needs mpGhost=ghost, game=rage|ridge, mpRole).');
  }

  if (ghost.enabled) {
    try {
      npLogLine(`GHOST mode: ${mpGameKey} turn=${ghost.turn} - ${ghost.label}. The finished run becomes the other seat's replay.`);
    } catch { /* ignore */ }
    ghostStorageLoad().catch(() => {});
    ghostStartWatcher();
    ghostStartGatePoll();
    renderGhostBlock();
  }
  $('#npGhostCapture')?.addEventListener('click', () => { ghost.captureNow(); });
  $('#npGhostReplay')?.addEventListener('click', () => { ghost.replayNow(); });
  $('#npGhostLiveBtn')?.addEventListener('click', () => {
    if (!live.enabled) return;
    // Runtime A/B: OFF forces the enable word down, ON returns to the automatic
    // rule (a race + a tape). Never leaves the ghost pinned on outside a race.
    const next = live.override === 0 ? null : 0;
    live.setEnable(next);
    try { npLogLine(`GHOST // LIVE ${next === 0 ? 'OFF (manual)' : 'AUTO'} (tape ${live.tape ? `${live.tape.count}f` : 'none'}).`); } catch { /* ignore */ }
    renderGhostBlock();
  });

  function installMpControlListener() {
    const np = netplay();
    if (!np || !np.socket) return false;
    // EJS can create the Socket.IO client after the first netplay-ready tick,
    // and a reconnect swaps the socket instance: track the instance we bound.
    if (np.__r4ControlSocket === np.socket) return true;
    np.__r4ControlSocket = np.socket;
    np.__r4Control = true;
    if (typeof np.socket.onAny === 'function') {
      np.socket.onAny((event, ...args) => {
        if (mp.socketEvents.length > 30) mp.socketEvents.shift();
        mp.socketEvents.push({ event, keys: args && args[0] && typeof args[0] === 'object' ? Object.keys(args[0]) : null });
      });
    }
    np.socket.on('data-message', (data) => {
      const msg = data && data['r4-mp'];
      if (!msg || !msg.type) return;
      mp.controlReceived.push({ ...msg, receivedAt: Date.now() });
      if (mp.controlReceived.length > 40) mp.controlReceived.shift();
      if (msg.type === 'stage') {
        mp.hostStage = msg.stage;
        try { npLogLine(`HOST STAGE: ${msg.stage}${msg.plan ? ` - ${msg.plan}` : ''}`); } catch { /* ignore */ }
      } else if (msg.type === 'hello') {
        // A guest that joined late asks for the current state; answer with the
        // last stage and, if the grid is already live, the input unlock.
        if (mp.role === 'host') {
          if (mp.lastStageSignal) mpSignal(mp.lastStageSignal);
          if (mp.raceLive) mpSignal({ type: 'race-live', at: Date.now() });
          if (mp.raceStartSignalledAt) mpSignal({ type: 'race-start', plan: planText(), at: mp.raceStartSignalledAt });
        }
      } else if (msg.type === 'race-start') {
        mp.raceStartSignalledAt = Date.now();
        try { npLogLine(`Host starts the race${msg.plan ? ` - ${msg.plan}` : ''}. P2 input unlocks when the grid loads.`); } catch { /* ignore */ }
      } else if (msg.type === 'race-live') {
        mp.raceLive = true;
        try { npLogLine('Race live - guest input is now Player 2.'); } catch { /* ignore */ }
        try { netRaceLive('guest'); } catch { /* ignore */ }
      }
    });
    return true;
  }

  // Host/guest room retry loop with visible status instead of a one-shot latch.
  const autoLobby = async () => {
    if (!mp.role || !mp.code) return;
    const a = window.__R4NET;
    const api = a;
    if (mp.role === 'host') {
      for (let attempt = 0; attempt < 15; attempt += 1) {
        mp.auto.hostTries = attempt + 1;
        const s = api.snapshot();
        if (s.isNetplay && s.owner) { mp.auto.joined = true; setStage('room:hosting'); return; }
        if (!s.started) { await sleep(900); continue; }
        api.setName(playerName());
        setStage(`room:create-${attempt + 1}`);
        api.hostRoom(mp.roomName, 2, mp.raceId || '');
        for (let i = 0; i < 18; i += 1) {
          await sleep(500);
          const t = api.snapshot();
          if (t.isNetplay && t.owner) { mp.auto.joined = true; setStage('room:hosting'); return; }
        }
      }
      mp.auto.error = 'room not created after 15 attempts';
      setStage('room:host-failed');
      return;
    }
    for (let attempt = 0; attempt < 45; attempt += 1) {
      mp.auto.guestTries = attempt + 1;
      const s = api.snapshot();
      if (s.isNetplay && !s.owner) { mp.auto.joined = true; setStage('room:joined'); return; }
      try {
        const rooms = await api.getRooms();
        const match = Object.entries(rooms || {}).find(([, room]) => {
          const name = String((room && room.room_name) || '').toUpperCase();
          const current = Number(room && room.current) || 0;
          const max = Number(room && room.max) || 2;
          return name === mp.roomName.toUpperCase() && current < max;
        });
        if (match) {
          const [sessionId, room] = match;
          api.joinRoom(sessionId, room.room_name || mp.roomName, room.max || 2, mp.raceId || null);
          for (let i = 0; i < 12; i += 1) {
            await sleep(400);
            const t = api.snapshot();
            if (t.isNetplay && !t.owner) { mp.auto.joined = true; setStage('room:joined'); return; }
          }
          mp.auto.lastJoinError = 'join did not complete';
        }
      } catch (e) {
        mp.auto.lastJoinError = e && e.message ? e.message : String(e);
      }
      await sleep(900);
    }
    mp.auto.error = 'room not joined after 45 attempts';
    setStage('room:join-failed');
  };
  if (mp.role && mp.code) setTimeout(() => { autoLobby().catch(() => {}); }, 900);

  // Host-side race director: once both netplay clients are connected, walk the
  // host core through R4's real VS Battle menus and start the split-screen race.
  // The guest core is frozen and only supplies P2 input after the race starts.
  //
  // Calibrated against a live boot (see _runtime/calib/*):
  //   PRESS START -> main menu (selection byte 0x800AC801: 0 GP, 1 TA, 2 VS)
  //   VS battle -> splash (~4 s) -> Car Select Preset Player 1
  //   P1: Right x carHost, Circle (car data) -> Circle (AT/MT) -> Circle (AT)
  //   Car Select Preset Player 2 (input must use player index 1)
  //   P2: Right x carGuest, Circle x3 -> Course Select
  //   Course: Right x trackIndex (0..7 in menu order), Circle = Start
  let autoRaceTried = false;
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const rawPad = (player, index, value) => {
    const gm = window.EJS_emulator && window.EJS_emulator.gameManager;
    if (!gm || !gm.functions || typeof gm.functions.simulateInput !== 'function') return false;
    gm.functions.simulateInput(player, index, value);
    return true;
  };
  const tapPad = async (player, index, hold = 130, settle = 320) => {
    rawPad(player, index, 1);
    await sleep(hold);
    rawPad(player, index, 0);
    await sleep(settle);
  };

  // Press Start until the main-menu selection byte answers a Down probe. This
  // works from any boot state (Namco logo, WELCOME card, R4 logo, attract movie).
  const ensureMainMenu = async () => {
    for (let i = 0; i < 26; i += 1) {
      const sel = readMenuSel();
      if (sel != null && sel >= 0 && sel <= 6) {
        await tapPad(0, 5, 300, 280);          // Down
        const next = readMenuSel();
        await tapPad(0, 4, 300, 220);          // Up, restore
        if (next === sel + 1) {
          mp.menuVerified = true;
          setStage('menu:ready');
          return true;
        }
      }
      setStage('menu:boot');
      await tapPad(0, 3, 300, 1700);           // Start skips the boot sequence
    }
    setStage('menu:unverified');
    return false;
  };

  const moveMenuTo = async (target) => {
    for (let i = 0; i < 10; i += 1) {
      const sel = readMenuSel();
      if (sel === target) return true;
      if (sel == null) break;
      await tapPad(0, 5, 300, 300);
    }
    return readMenuSel() === target;
  };

  // Rage Racer / Ridge Racer 1994 (macro === 'manual'): no menu walk at all.
  // The host browses the disc's own single-player menus by hand and starts a
  // normal race; both pads drive the one car (the remap above folds the guest
  // pad onto player 0). Nothing here reads RAM or claims a 2P mode.
  const manualRace = () => {
    setStage('macro:manual');
    mp.manualStartedAt = Date.now();
    // setStage already sent the plain stage frame; this one carries the mode so
    // a guest can label the panel without guessing.
    mp.lastStageSignal = {
      type: 'stage', stage: 'macro:manual', plan: planText(), mode: mp.mode,
      drive: ghost.enabled ? 'ghost' : 'live', turn: ghost.enabled ? ghost.turn : null, at: Date.now(),
    };
    mpSignal(mp.lastStageSignal);
    mpSignal({ type: 'race-live', mode: mp.mode, at: Date.now() });
    try { netRaceLive('host'); } catch { /* ignore */ }
    if (ghost.enabled) {
      // Ghost replaces the shared car: one driver per run, the other pad gated.
      try { installGhostGate(); } catch { /* ignore */ }
      try { npLogLine(`GHOST TURN-BASED - host starts a solo run; DRIVER: ${ghost.turn.toUpperCase()}.`); } catch { /* ignore */ }
      return;
    }
    try { startSharedCarRemapPoll(); } catch { /* ignore */ }
    try { npLogLine('MANUAL 2P - host starts a single-player race; both pads drive.'); } catch { /* ignore */ }
  };

  const autoRace = async () => {
    if (autoRaceTried || mp.role !== 'host') return;
    autoRaceTried = true;
    mp.raceLive = true;                        // host core is always live
    try {
      try { unlockAudio(); } catch { /* ignore */ }
      // Shared-car discs are manual: keep the calibrated R4 VS Battle walk for
      // `macro === 'auto'` only, in the same order/timings/addresses as before.
      if (mp.macro !== 'auto') { manualRace(); return; }
      setStage('macro:start');
      mpSignal({ type: 'stage', stage: 'macro:start', plan: planText(), at: Date.now() });
      const verified = await ensureMainMenu();
      if (verified) {
        await moveMenuTo(2);
        setStage('menu:vs');
      } else {
        await tapPad(0, 5, 300, 500);
        await tapPad(0, 5, 300, 700);
        setStage('menu:vs');
      }
      await tapPad(0, 8, 350, 9000);           // VS battle splash -> car select P1
      setStage('car:p1');
      await sleep(3500);                       // let the car model + labels draw
      await pressRight(0, mp.carHost, 'carHost');
      await sleep(1800);
      setStage('car:p1:ok');
      await tapPad(0, 8, 350, 500);            // reveal car data
      setStage('car:p1:data');
      await sleep(2200);
      await tapPad(0, 8, 350, 500);            // AT/MT menu
      setStage('car:p1:atmt');
      await sleep(2200);
      await tapPad(0, 8, 350, 5000);           // choose AT -> Player 2 screen
      setStage('car:p2');
      await sleep(3500);                       // Player 2 screen fade + car model
      await pressRight(1, mp.carGuest, 'carGuest');
      await sleep(1800);
      setStage('car:p2:ok');
      await tapPad(1, 8, 350, 500);
      setStage('car:p2:data');
      await sleep(2200);
      await tapPad(1, 8, 350, 500);
      setStage('car:p2:atmt');
      await sleep(2200);
      await tapPad(1, 8, 350, 5000);           // choose AT -> course select
      setStage('course');
      await sleep(3500);
      await pressRight(0, mp.trackIndex, 'trackIndex');
      await sleep(1200);
      setStage('course:locked');
      await sleep(2500);
      mpSignal({ type: 'race-start', plan: planText(), trackIndex: mp.trackIndex, cars: [mp.carHost, mp.carGuest], at: Date.now() });
      mp.raceStartSignalledAt = Date.now();
      setStage('race:starting');
      await tapPad(0, 8, 350, 20000);           // Start -> track load (netplay is slower)
      setStage('race:live');
      mpSignal({ type: 'race-live', at: Date.now() });
      try { netRaceLive('host'); } catch { /* ignore */ }
    } catch (err) {
      mp.auto.error = err && err.message ? err.message : String(err);
      setStage('macro:error');
    }
  };
  if (mp.role === 'host') {
    let waits = 0;
    const autoRacePoll = setInterval(() => {
      if (autoRaceTried) { clearInterval(autoRacePoll); return; }
      waits += 1;
      const em = window.EJS_emulator;
      const np = em && em.netplay;
      if (!em || !state.startedAt || !np || !np.owner) return;
      const players = np.players ? Object.keys(np.players).length : 0;
      const pcs = np.peerConnections ? Object.values(np.peerConnections) : [];
      const dcOpen = pcs.some((p) => p.dataChannel && p.dataChannel.readyState === 'open');
      if (waits % 5 === 0 && !mp.autoRaceTriedLogged) {
        mp.autoRaceTriedLogged = true;
        try { npLogLine(`Auto race waiting: ${players}/2 players, data channel ${dcOpen ? 'open' : 'pending'}.`); } catch { /* ignore */ }
      }
      if (players >= 2 && dcOpen) {
        clearInterval(autoRacePoll);
        mp.autoRaceWaiting = false;
        autoRace();
      } else {
        mp.autoRaceWaiting = true;
        if (waits % 20 === 0) mpSignal({ type: 'stage', stage: `wait:${players}p`, at: Date.now() });
      }
    }, 1000);
  }

  // ---------------------------------------------------------------------
  // Fullscreen (button, floating exit, F shortcut) - 4.3-aware resize.
  // ---------------------------------------------------------------------
  const fsSupported = typeof document.documentElement.requestFullscreen === 'function';
  const nudgeResize = () => {
    const em = window.EJS_emulator;
    try { em?.handleResize?.(); } catch { /* ignore */ }
    try { em?.frontend?.handleResize?.(); } catch { /* ignore */ }
  };
  const setFsUi = (on) => {
    document.body.classList.toggle('fs', on);
    if (fsExit) fsExit.hidden = !on;
    if (fsBtn) {
      fsBtn.setAttribute('aria-pressed', on ? 'true' : 'false');
      fsBtn.innerHTML = `<span class="btn-ico" aria-hidden="true">[]</span> ${on ? 'EXIT FULLSCREEN' : 'FULLSCREEN'}`;
    }
    state.fs = on;
    mark('fullscreen', { on });
    setTimeout(nudgeResize, 120);
  };

  const toggleFs = async () => {
    if (!fsSupported) {
      setStatus('FULLSCREEN N/A', 'error');
      return;
    }
    try {
      if (document.fullscreenElement) await document.exitFullscreen();
      else await document.documentElement.requestFullscreen({ navigationUI: 'hide' });
    } catch (e) {
      state.errors.push({ message: 'fullscreen: ' + (e?.message || String(e)) });
      setStatus('FULLSCREEN BLOCKED', 'error');
    }
  };

  fsBtn?.addEventListener('click', toggleFs);
  fsExit?.addEventListener('click', () => {
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
  });
  document.addEventListener('fullscreenchange', () => setFsUi(!!document.fullscreenElement));
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'f' && e.key !== 'F') return;
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    const t = e.target;
    if (t && /^(INPUT|SELECT|TEXTAREA)$/.test(t.tagName)) return;
    e.preventDefault();
    toggleFs();
  });
  if (!fsSupported) fsBtn?.setAttribute('disabled', '');

  // ---------------------------------------------------------------------
  // Click-to-race / audio unlock gate.
  // ---------------------------------------------------------------------
  let gateTimer = null;
  const hideGate = () => {
    if (gateTimer) { clearTimeout(gateTimer); gateTimer = null; }
    if (soundGate) soundGate.hidden = true;
  };

  const focusGame = () => {
    const canvas = document.querySelector('#game canvas');
    if (canvas) {
      canvas.tabIndex = 0;
      try { canvas.focus({ preventScroll: true }); } catch { try { canvas.focus(); } catch { /* ignore */ } }
    }
  };

  // 4.3 keeps gamepad state on the frontend object (4.2.3 kept it on the
  // emulator). Fill any empty player slot with a detected pad.
  const autoAssignPads = () => {
    const em = window.EJS_emulator;
    const frontend = em && (em.frontend || em);
    const gp = (em && em.gamepad) || (frontend && frontend.gamepad);
    const sel = (frontend && frontend.gamepadSelection) || (em && em.gamepadSelection);
    if (!gp || !Array.isArray(sel) || !Array.isArray(gp.gamepads)) return;
    let changed = false;
    for (const pad of gp.gamepads) {
      if (!pad) continue;
      const id = pad.id + '_' + pad.index;
      if (sel.includes(id)) continue;
      const slot = sel.findIndex((v) => !v || v === 'notconnected');
      if (slot >= 0) { sel[slot] = id; changed = true; }
    }
    if (changed) {
      try { frontend.updateGamepadLabels?.(); } catch { /* ignore */ }
      try { em.updateGamepadLabels?.(); } catch { /* ignore */ }
      try { gp.emit?.('gamepadselected', sel); } catch { /* ignore */ }
      mark('gamepad-autoassign', { selection: sel.slice() });
    }
  };
  window.addEventListener('gamepadconnected', () => setTimeout(autoAssignPads, 120));
  // Filtering a WebGL canvas before its first stable frame can composite black.
  // Apply DLSS 5 on the first real user interaction, after the game is up.
  const activateDlss5 = () => {
    if (dlss5Ready) return;
    dlss5Ready = true;
    if (activeFilter === 'dlss5') {
      setTimeout(() => { if (activeFilter === 'dlss5') setDlss5Stage(true); }, 3000);
    }
  };
  window.addEventListener('pointerdown', activateDlss5, { once: true });
  window.addEventListener('keydown', activateDlss5, { once: true });
  window.addEventListener('gamepadconnected', activateDlss5, { once: true });
  // The guest's host-stream <video> appears only after joining. Apply the
  // DLSS 5 filter to it as soon as EJS inserts it.
  const npGameEl = document.querySelector('#game');
  if (npGameEl && window.MutationObserver) {
    new MutationObserver(() => {
      if (activeFilter === 'dlss5' && gameStarted && dlss5Ready) setDlss5Stage(true);
    }).observe(npGameEl, { childList: true, subtree: true });
  }

  const audioContext = () => {
    const em = window.EJS_emulator;
    const al = em?.Module?.AL?.currentCtx;
    return al?.audioCtx || em?.Module?.SDL2?.audioContext ||
      em?.gameManager?.audioContext || em?.audioContext || null;
  };
  const unlockAudio = async () => {
    const em = window.EJS_emulator;
    try { if (em && em.paused) em.play(); } catch { /* ignore */ }
    try {
      const ctx = audioContext();
      if (ctx && ctx.state === 'suspended') await ctx.resume();
    } catch { /* ignore */ }
    try { if (em && em.muted) em.setVolume(0.7); } catch { /* ignore */ }
    state.audioUnlocked = true;
    mark('audio-unlock', { ctx: audioContext()?.state || 'n/a' });
    hideGate();
    focusGame();
  };
  const showGate = () => {
    if (!soundGate || state.audioUnlocked) return;
    if (embedded) { hideGate(); return; }
    if (audioContext()?.state === 'running') {
      state.audioUnlocked = true;
      hideGate();
      return;
    }
    soundGate.hidden = false;
    gateTimer = setTimeout(hideGate, 12000);
  };
  soundGate?.addEventListener('click', unlockAudio);
  document.addEventListener('keydown', (e) => {
    if (!soundGate || soundGate.hidden) return;
    if (['Shift', 'Control', 'Alt', 'Meta'].includes(e.key)) return;
    unlockAudio();
  }, true);
  document.addEventListener('pointerdown', () => {
    if (soundGate && !soundGate.hidden) return;
    if (state.startedAt) unlockAudio();
  }, { capture: true, passive: true });

  // ---------------------------------------------------------------------
  // Footer: report the disc image, never the 0.5 MB BIOS.
  // ---------------------------------------------------------------------
  const updateFooter = () => {
    if (!footTiming) return;
    const romRec = state.rom && state.rom.loaded > 1048576 ? state.rom : null;
    const totalBytes = game.bytes || romRec?.total || 0;
    const mb = totalBytes ? (totalBytes / 1048576).toFixed(0) : (romRec?.mb ?? null);
    const boot = state.bootMs != null ? ` - boot ${(state.bootMs / 1000).toFixed(1)}s` : '';
    if (romRec) {
      footTiming.textContent = `ROM ${mb} MB in ${(romRec.ms / 1000).toFixed(1)}s${boot}`;
    } else if (mb) {
      footTiming.textContent = `ROM ${mb} MB - cached${boot}`;
    } else {
      footTiming.textContent = '-';
    }
  };

  // Zero-CDN shim: route any EmulatorJS CDN update check to the pinned 4.3
  // snapshot instead of the network.
  const nativeFetch = window.fetch.bind(window);
  window.fetch = (input, init) => {
    const raw = typeof input === 'string' ? input : (input && input.url) || '';
    const m = /^https?:\/\/cdn\.emulatorjs\.org\/[^/]+\/data\/(.*)$/.exec(raw);
    if (m) return nativeFetch('/emulator43/data/' + m[1], init);
    return nativeFetch(input, init);
  };

  // Instrument XHR so the footer can report real ROM transfer timing.
  state.transfers = [];
  (() => {
    const XHR = window.XMLHttpRequest;
    if (!XHR) return;
    const open = XHR.prototype.open;
    const send = XHR.prototype.send;
    XHR.prototype.open = function (method, url, ...rest) {
      this.__r4 = { method: String(method || 'GET').toUpperCase(), url: String(url || '') };
      return open.call(this, method, url, ...rest);
    };
    XHR.prototype.send = function (...args) {
      const meta = this.__r4;
      if (meta && meta.method === 'GET' && /\.(bin|cue|iso|chd|img)(\?|#|$)/i.test(meta.url)) {
        const rec = {
          url: meta.url, start: performance.now(), firstByteAt: null,
          loaded: 0, total: 0, doneAt: null, ms: null, mb: null, mbps: null, status: null,
        };
        state.transfers.push(rec);
        this.addEventListener('progress', (e) => {
          if (rec.firstByteAt === null) rec.firstByteAt = performance.now();
          rec.loaded = e.loaded;
          rec.total = e.total || rec.total;
        });
        this.addEventListener('loadend', () => {
          rec.doneAt = performance.now();
          rec.ms = Math.round(rec.doneAt - rec.start);
          rec.status = this.status;
          rec.mb = rec.loaded ? +(rec.loaded / 1048576).toFixed(1) : null;
          rec.mbps = rec.ms > 0 ? +((rec.loaded / 1048576) / (rec.ms / 1000)).toFixed(1) : null;
          mark('file-loaded', { url: rec.url.split('/').pop(), ms: rec.ms, bytes: rec.loaded });
          if (!state.rom || rec.loaded > (state.rom.loaded || 0)) {
            state.rom = rec;
            updateFooter();
          }
        });
      }
      return send.apply(this, args);
    };
  })();

  // Mirror EmulatorJS loading text into the overlay + progress bar.
  let pollTimer = null;
  const poll = () => {
    const t = document.querySelector('#game .ejs_loading_text');
    const err = document.querySelector('#game .ejs_error_text');
    if (t && t.innerText) {
      const txt = t.innerText.trim();
      if (txt) {
        const pct = /(\d{1,3})\s*%/.exec(txt);
        const mb = /([\d.]+)\s*MB/.exec(txt);
        let label = txt.replace(/\s*\d{1,3}\s*%/, '').replace(/\s*[\d.]+\s*MB/, '').trim();
        if (!label) label = 'Working...';
        if (mb) label = `${label} ${mb[1]} MB`;
        setOverlay(null, label, pct ? `${pct[1]}%` : overlayHint.textContent, pct ? Number(pct[1]) : undefined);
        if (overlayBar && !pct) overlayBar.classList.add('indeterminate');
      }
    }
    if (err && err.innerText) {
      const msg = err.innerText.trim();
      if (msg && !state.errors.some((e) => e.message === msg)) showError(msg, 'EmulatorJS reported an error');
    }
    if (state.startedAt) {
      clearInterval(pollTimer);
      pollTimer = null;
    }
  };

  // ---------------------------------------------------------------------
  // ROM presence probe before booting.
  // ---------------------------------------------------------------------
  const probeUrl = async (url) => {
    const res = await nativeFetch(url, {
      headers: { Range: 'bytes=0-0' },
      cache: 'no-store',
    });
    if (!res.ok) {
      try { await res.arrayBuffer(); } catch { /* consume body */ }
      return { ok: false, status: res.status, len: 0, ranged: false };
    }
    const contentRange = res.headers.get('content-range') || '';
    let len = Number(res.headers.get('content-length') || 0);
    const m = /\/(\d+)\s*$/.exec(contentRange);
    if (m) len = Number(m[1]);
    try { await res.arrayBuffer(); } catch { /* consume body */ }
    return { ok: true, status: res.status, len, ranged: !!contentRange };
  };

  const probe = async () => {
    try {
      let r = await probeUrl(game.rom);
      if (!r.ok && game.fallbackRom) {
        state.fallback = true;
        game.rom = game.fallbackRom;
        if (footRom) footRom.textContent = decodeURIComponent(game.rom).split('/').pop();
        r = await probeUrl(game.rom);
      }
      if (!r.ok) {
        showError(
          `${game.name} ROM not installed`,
          `${decodeURIComponent(game.rom)} returned HTTP ${r.status}. Drop the disc image into the disc folder and reload.`
        );
        return false;
      }
      if (r.len) {
        game.bytes = r.len;
        setOverlay(null, 'Downloading disc image...', `${(r.len / 1048576).toFixed(0)} MB - served from this machine`, 0);
        if (overlayBar) overlayBar.classList.add('indeterminate');
      }
      mark('rom-probe', { status: r.status, bytes: r.len, ranged: r.ranged, fallback: !!state.fallback });
      return true;
    } catch (e) {
      showError('Cannot reach ROM', e && e.message ? e.message : String(e));
      return false;
    }
  };

  // ---------------------------------------------------------------------
  // Boot
  // ---------------------------------------------------------------------
  const boot = () => {
    const romName = decodeURIComponent(game.rom).split('/').pop();
    const useCueFile = cueMode === 'file' && /\.bin$/i.test(game.rom);
    window.EJS_player = '#game';
    window.EJS_core = 'psx';
    window.EJS_gameUrl = useCueFile ? game.cue : game.rom;
    if (useCueFile) {
      window.EJS_externalFiles = { ['/' + romName]: game.rom };
    }
    // Pinned 4.3.0-pre nightly data. 4.2.3 remains at /emulator/data/.
    window.EJS_pathtodata = '/emulator43/data/';
    window.EJS_gameName = game.name;
    window.EJS_gameID = game.id;                 // numeric: required for netplay
    window.EJS_biosUrl = biosUrl;
    window.EJS_startOnLoaded = true;
    window.EJS_fullscreenOnLoaded = false;
    window.EJS_language = 'en-US';
    window.EJS_disableAutoLang = false;
    window.EJS_color = '#e10600';
    window.EJS_volume = 0.7;
    window.EJS_disableCue = cueMode === 'direct';
    window.EJS_CacheLimit = cacheEnabled ? 1073741824 : 0;
    window.EJS_cacheConfig = cacheEnabled
      ? { enabled: true, cacheMaxSizeMB: 4096, cacheMaxAgeMins: 10080 }
      : { enabled: false, cacheMaxSizeMB: 0, cacheMaxAgeMins: 0 };
    window.EJS_threads = useThreads;
    window.EJS_disableDatabases = false;

    // 4.3 netplay: Socket.IO signalling + WebRTC host canvas/audio. Empty ICE
    // is sufficient on one LAN subnet (host candidates connect directly).
    window.EJS_netplayServer = netplayServer;
    window.EJS_netplayICEServers = [];
    window.EJS_Buttons = { netplay: true };
    if (debug) window.EJS_DEBUG_XX = true;

    window.EJS_ready = () => {
      state.readyAt = performance.now();
      mark('ready');
      setStatus('CORE READY', 'loading');
      setOverlay(null, 'Starting game...', null, 96);
      npLogLine('EmulatorJS core ready.');
    };

    window.EJS_onGameStart = () => {
      mark('start');
      setStatus('RUNNING', 'running');
      hideOverlay();
      const canvas = document.querySelector('#game canvas');
      if (canvas) {
        state.canvas = { width: canvas.width, height: canvas.height, cssW: canvas.clientWidth, cssH: canvas.clientHeight };
      }
      focusGame();
      setTimeout(autoAssignPads, 600);
      setTimeout(() => { gameStarted = true; }, 700);
      setTimeout(() => { if (!dlss5Ready) activateDlss5(); }, 8000);
      setTimeout(() => { if (audioContext()?.state === 'running') { state.audioUnlocked = true; hideGate(); } }, 700);
      try {
        state.romResource = performance.getEntriesByType('resource')
          .filter((e) => /\/rom\/.*\.(bin|cue|iso|chd)(\?|$)/i.test(e.name))
          .map((e) => ({
            name: decodeURIComponent(e.name).split('/').pop(),
            durationMs: Math.round(e.duration),
            transferMB: +(e.transferSize / 1048576).toFixed(1),
            encodedMB: +(e.encodedBodySize / 1048576).toFixed(1),
            decodedMB: +(e.decodedBodySize / 1048576).toFixed(1),
          }));
      } catch { /* resource timing may be unavailable */ }
      if (footTiming && state.rom && state.rom.ms != null) updateFooter();
      setTimeout(showGate, 600);
      updateFooter();
      npLogLine(`Game started. Netplay relay: ${netplayServer} (gameID ${game.id}).`);
      waitForNetplay();
    };

    window.EJS_onExit = () => {
      mark('exit');
      setStatus('EXITED', 'error');
      npLogLine('EmulatorJS exited.');
    };

    mark('loader-request');
    const s = document.createElement('script');
    s.src = '/emulator43/data/loader.js';
    s.async = true;
    s.onload = () => mark('loader-loaded');
    s.onerror = () => showError('EmulatorJS 4.3 loader failed to load', '/emulator43/data/loader.js');
    document.head.appendChild(s);

    pollTimer = setInterval(poll, 400);
    mark('boot-config', { bios: biosUrl || 'HLE', cue: cueMode, threads: useThreads, netplayServer });
  };

  // ---------------------------------------------------------------------
  // Netplay performance tuning (N1-N6, 2026-11-06).
  //
  // The WebRTC engine is the pinned 4.3.0-pre bundle, so every change here is an
  // outside-in wrapper around window.EJS_emulator.netplay. Each hook is
  // feature-detected and wrapped in try/catch: a manual /play-net join still
  // works when one of them is unavailable.
  //
  //   ?capture=30   keep the bundle's 30 fps canvas capture        (N1 off)
  //   ?pin=1        960x720 offscreen pin instead of a direct pull   (N1 A/B)
  //   ?keyframe=0   never force an IDR                            (N2 off)
  //   ?dedup=0      keep the duplicate Socket.IO input copy       (N3 off)
  //   ?stats=0      no 2 s getStats line                          (N4 off)
  //   ?quality=...  initial quality AUTO|LOW|MED|HIGH             (N5)
  //   ?desync=1     opt in to a desynchronized guest 2D context    (N6d)
  //   ?draw=...     guest blit: bundle (default) | gated | qpf | rvfc  (N6)
  //   ?video=attached  keep the guest <video> attached off-screen  (N6 R5)
  //
  // Measured in _runtime/analysis/03-netplay-webrtc.md + 12-guest-video.md.
  // ---------------------------------------------------------------------
  const QUALITY = {
    low: { bitrate: 1500000, fps: 30 },
    med: { bitrate: 4000000, fps: 60 },
    high: { bitrate: 8000000, fps: 60 },
  };
  const NET = {
    captureFps: qs.get('capture') === '30' ? 30 : 60,
    keyframe: qs.get('keyframe') !== '0',
    dedup: qs.get('dedup') !== '0',
    stats: qs.get('stats') !== '0',
    desync: qs.get('desync') === '1',
    quality: (() => {
      const v = String(qs.get('quality') || '').toLowerCase();
      if (QUALITY[v] || v === 'auto') return v;
      try {
        const saved = localStorage.getItem('rr4.netplay.quality') || '';
        if (QUALITY[saved] || saved === 'auto') return saved;
      } catch { /* ignore */ }
      return 'auto';
    })(),
  };
  state.input = { dc: 0, relay: 0, dropped: 0 };
  state.quality = { level: NET.quality, applied: null, autoDropped: false, droppedAt: null };
  state.tuning = { captureFps: NET.captureFps, keyframe: NET.keyframe, dedup: NET.dedup, stats: NET.stats, desync: NET.desync };
  const net = {
    np: null, installed: false, track: null, trackKey: '', lastSig: '',
    sender: null, lastStatsLog: 0, logSig: '', lastFrames: null, lastFramesAt: 0,
    lastKeyframeAsk: 0, lastLost: null, autoBad: 0, guestQualitySent: false,
    socketBound: null, desyncOk: null, sample: null, lastSampleAt: 0,
    pullFrame: -1, pullAt: 0, pulled: 0,
  };
  const npQuality = $('#npQuality');
  const npChipDebug = $('#npChipDebug');

  function netPcEntries() {
    const np = netplay();
    if (!np || !np.peerConnections) return [];
    return Object.values(np.peerConnections).filter(Boolean);
  }
  function netPc(entry) {
    if (!entry) return null;
    if (entry.pc) return entry.pc;
    return typeof entry.getSenders === 'function' ? entry : null;
  }
  function netVideoSender(entry) {
    const pc = netPc(entry);
    if (!pc || typeof pc.getSenders !== 'function') return null;
    try {
      return pc.getSenders().find((s) => s && s.track && s.track.kind === 'video') || null;
    } catch { return null; }
  }
  function netOpenDc(entry) {
    const dc = entry && entry.dataChannel;
    return dc && dc.readyState === 'open' ? dc : null;
  }
  function netAnyDcOpen() {
    return netPcEntries().some((e) => !!netOpenDc(e));
  }
  function netCanvas() {
    const em = window.EJS_emulator;
    return (em && em.frontend && em.frontend.canvas) || null;
  }

  function netQualityTarget() {
    const level = state.quality.level === 'auto' ? 'med' : state.quality.level;
    const base = QUALITY[level] || QUALITY.med;
    return { level, bitrate: base.bitrate, fps: NET.captureFps === 30 ? 30 : base.fps };
  }

  // N1: the bundle's captureStream(30) track is replaced with a track that is
  // pulled once per core frame. Measured on this build: a direct
  // captureStream(60) of the EJS WebGL canvas only delivers ~43 fps (Chrome
  // captures on canvas commit and the core's frame grid is bursty), while
  // captureStream(0) + requestFrame() per core frame delivers ~59 fps.
  // One pull per core frame, driven by rAF (which runs after the canvas has been
  // drawn, so Chrome has a frame to hand over).
  function netPull() {
    try {
      const track = net.track;
      if (!track || typeof track.requestFrame !== 'function') return;
      const em = window.EJS_emulator;
      const gm = em && em.gameManager;
      const n = gm && typeof gm.getFrameNum === 'function' ? gm.getFrameNum() : null;
      if (n != null) {
        if (n === net.pullFrame) return;
        net.pullFrame = n;
      } else if (performance.now() - net.pullAt < 8) {
        return;
      }
      net.pullAt = performance.now();
      track.requestFrame();
      net.pulled += 1;
    } catch { /* ignore */ }
  }

  // Fallback only: with the host tab in the background its rAF cadence drops,
  // so the emulator's postMainLoop tops the pull up. When the rAF loop is
  // healthy net.pullAt is always fresh and this never fires (a requestFrame
  // issued from inside the emulation loop only lands ~1 in 2.5 times).
  function netInstallPullHook(np) {
    try {
      if (!np || np.__r4Pull) return;
      np.__r4Pull = true;
      if (typeof np._initModulePostMainLoop !== 'function') return;
      const orig = np._initModulePostMainLoop.bind(np);
      np._initModulePostMainLoop = function () {
        const r = orig();
        try {
          if (performance.now() - net.pullAt > 30) netPull();
        } catch { /* ignore */ }
        return r;
      };
    } catch { /* ignore */ }
  }

  function netDirectTrack(cv, key) {
    try {
      if (!cv) return null;
      // captureStream(0) + requestFrame() per core frame: twice the rate of the
      // bundle's draw-triggered captureStream(30) and no extra copy.
      let track = null;
      try { track = cv.captureStream(0).getVideoTracks()[0]; } catch { track = null; }
      if (!track) {
        try { track = cv.captureStream(NET.captureFps).getVideoTracks()[0]; } catch { track = null; }
      }
      if (!track) return null;
      try { track.contentHint = 'motion'; } catch { /* ignore */ }
      if (net.loop && net.loop.running) {
        net.loop.running = false;
        try { cancelAnimationFrame(net.loop.raf); } catch { /* ignore */ }
      }
      net.pullFrame = -1;
      net.trackOld = net.track;
      net.track = track;
      net.trackKey = key;
      net.lastSig = '';
      // rAF fallback: only needed when the postMainLoop hook never runs.
      const st = { running: true, raf: 0 };
      net.loop = st;
      const loop = () => {
        if (!st.running) return;
        try { netPull(); } catch { /* ignore */ }
        st.raf = requestAnimationFrame(loop);
      };
      st.raf = requestAnimationFrame(loop);
      state.tuning.captureSource = `direct ${key} captureStream(0)+requestFrame(${NET.captureFps})`;
      return track;
    } catch { return null; }
  }

  // Optional A/B (?pin=1): blit the canvas into a fixed 960x720 4:3 offscreen
  // canvas and capture that. Measured ~49 fps encoded and needs
  // preserveDrawingBuffer, so the direct pull above is the default.
  function netPinnedTrack() {
    try {
      if (NET.captureFps <= 30) return null;
      const cv = netCanvas();
      if (!cv || !cv.width || !cv.height) return null;
      const key = `${cv.width}x${cv.height}`;
      if (net.track && net.track.readyState === 'live' && net.trackKey === key) return net.track;
      if (net.pin && net.pin.running) {
        net.pin.running = false;
        try { cancelAnimationFrame(net.pin.raf); } catch { /* ignore */ }
      }
      net.pin = null;
      if (net.loop && net.loop.running) {
        net.loop.running = false;
        try { cancelAnimationFrame(net.loop.raf); } catch { /* ignore */ }
        net.loop = null;
      }
      const W = 960;
      const H = 720;
      const canvas = document.createElement('canvas');
      canvas.width = W;
      canvas.height = H;
      const ctx = canvas.getContext('2d', { alpha: false });
      if (!ctx) return netDirectTrack(cv, key);
      const em = window.EJS_emulator;
      const pin = { canvas, ctx, src: cv, running: true, frame: -1, drawn: 0, raf: 0, track: null };
      net.pin = pin;
      const loop = () => {
        if (!pin.running) return;
        try {
          const gm = em && em.gameManager;
          const n = gm && typeof gm.getFrameNum === 'function' ? gm.getFrameNum() : null;
          if (n == null || n !== pin.frame) {
            pin.frame = n;
            const sw0 = cv.width;
            const sh0 = cv.height;
            if (sw0 && sh0) {
              // Cover-crop to 4:3 so the guest's own crop math sees 1:1.
              const sA = sw0 / sh0;
              const dA = W / H;
              let sx = 0;
              let sy = 0;
              let sw = sw0;
              let sh = sh0;
              if (sA > dA) { sw = sh0 * dA; sx = (sw0 - sw) / 2; }
              else if (sA < dA) { sh = sw0 / dA; sy = (sh0 - sh) / 2; }
              ctx.drawImage(cv, Math.round(sx), Math.round(sy), Math.round(sw), Math.round(sh), 0, 0, W, H);
              pin.drawn += 1;
              // captureStream(0) + requestFrame(): one frame per core frame,
              // instead of Chrome's draw-triggered capture (which coalesces the
              // core's bursty frame grid down to ~40 fps here).
              try { if (pin.track && typeof pin.track.requestFrame === 'function') pin.track.requestFrame(); } catch { /* ignore */ }
            }
          }
        } catch { /* ignore */ }
        pin.raf = requestAnimationFrame(loop);
      };
      pin.raf = requestAnimationFrame(loop);
      let track = null;
      try { track = canvas.captureStream(0).getVideoTracks()[0]; } catch { track = null; }
      if (!track) {
        try { track = canvas.captureStream(NET.captureFps).getVideoTracks()[0]; } catch { track = null; }
      }
      if (!track) {
        pin.running = false;
        return netDirectTrack(cv, key);
      }
      pin.track = track;
      try { track.contentHint = 'motion'; } catch { /* ignore */ }
      net.trackOld = net.track;
      net.track = track;
      net.trackKey = key;
      net.lastSig = '';
      state.tuning.captureSource = `offscreen ${W}x${H} pin from ${key} at ${NET.captureFps} fps`;
      if (net.pinLogged !== key) {
        net.pinLogged = key;
        npLogLine(`NET capture: offscreen ${W}x${H} pin at ${NET.captureFps} fps (source ${key}); direct canvas capture measured ~43 fps.`);
      }
      return track;
    } catch { return null; }
  }

  function netCaptureTrack() {
    try {
      if (NET.captureFps <= 30) return null;
      if (qs.get('pin') === '1') return netPinnedTrack();
      return netDirectTrack(netCanvas(), `${netCanvas() && netCanvas().width}x${netCanvas() && netCanvas().height}`);
    } catch { return null; }
  }

  // N1 + N5: replace the 30 fps track and set the encoder ceiling/framerate.
  async function netApplyHost(reason, force) {
    try {
      const np = netplay();
      if (!np || !np.owner) return false;
      const target = netQualityTarget();
      const entries = netPcEntries();
      if (!entries.length) return false;
      const sig = `${target.level}:${target.bitrate}:${target.fps}:${NET.captureFps}:${net.trackKey}:${entries.length}`;
      if (!force && sig === net.lastSig) return false;
      net.lastSig = sig;
      const track = netCaptureTrack();
      let touched = 0;
      let relayed = false;
      for (const entry of entries) {
        try {
          const sender = netVideoSender(entry);
          if (!sender) continue;
          if (track && sender.track !== track) {
            try { await sender.replaceTrack(track); } catch { /* keep bundle track */ }
          }
          const relay = !!entry.usingRelay;
          relayed = relayed || relay;
          const p = sender.getParameters();
          p.degradationPreference = 'maintain-framerate';
          if (!p.encodings || !p.encodings.length) p.encodings = [{}];
          p.encodings[0].maxBitrate = relay ? Math.min(target.bitrate, 900000) : target.bitrate;
          p.encodings[0].maxFramerate = relay ? Math.min(target.fps, 30) : target.fps;
          p.encodings[0].scaleResolutionDownBy = 1;
          try { if (!p.encodings[0].priority) p.encodings[0].priority = 'high'; } catch { /* ignore */ }
          try { await sender.setParameters(p); touched += 1; } catch { /* ignore */ }
          net.sender = sender;
          // N2: the sender's track unmuting (guest joined/reconnected) is a
          // second good moment for an IDR.
          try {
            const tr = sender.track;
            if (tr && !tr.__r4Unmute) {
              tr.__r4Unmute = true;
              tr.addEventListener('unmute', () => { netKeyframe('track-unmute').catch(() => {}); });
            }
          } catch { /* ignore */ }
        } catch { /* next peer */ }
      }
      // Keep np.localStream in sync so a peer created later (renegotiate,
      // rematch) is offered the 60 fps track instead of the 30 fps one.
      if (track && np.localStream) {
        try {
          const cur = np.localStream.getVideoTracks()[0];
          if (cur && cur !== track) {
            np.localStream.addTrack(track);
            np.localStream.removeTrack(cur);
            try { cur.stop(); } catch { /* ignore */ }
          }
        } catch { /* ignore */ }
      }
      if (net.trackOld && net.trackOld !== net.track) {
        try { net.trackOld.stop(); } catch { /* ignore */ }
        net.trackOld = null;
      }
      let settings = null;
      try { settings = net.sender && net.sender.track ? net.sender.track.getSettings() : null; } catch { settings = null; }
      state.tuning.encode = {
        reason: reason || 'apply', level: target.level, maxBitrate: target.bitrate,
        maxFramerate: target.fps, relay: relayed, senders: touched, settings: settings || null,
      };
      state.quality.applied = target.level;
      const desc = settings
        ? `${settings.width || '?'}x${settings.height || '?'}@${settings.frameRate ? settings.frameRate + 'fps' : 'pull'}`
        : `capture ${NET.captureFps}fps`;
      const logSig = `${desc}|${target.level}|${touched}|${relayed}`;
      if (logSig !== net.logSig) {
        net.logSig = logSig;
        const pull = net.pulled ? ` pull ${net.pulled}` : '';
        npLogLine(`NET host video: ${desc}${pull} max ${Math.round(target.bitrate / 1000)} kbps / ${target.fps} fps (${target.level.toUpperCase()}${relayed ? ', relay' : ''}) - ${reason || 'apply'}.`);
      }
      return touched > 0;
    } catch { return false; }
  }

  // N2: a maxBitrate bump is the only verified way to force one IDR here
  // (replaceTrack and maxFramerate changes do not).
  async function netKeyframe(reason) {
    if (!NET.keyframe) return false;
    try {
      const np = netplay();
      if (!np || !np.owner) return false;
      let ok = false;
      for (const entry of netPcEntries()) {
        const sender = netVideoSender(entry);
        if (!sender) continue;
        try {
          const p = sender.getParameters();
          if (!p.encodings || !p.encodings.length) continue;
          const base = p.encodings[0].maxBitrate || 2500000;
          p.encodings[0].maxBitrate = Math.round(base * 1.05);
          await sender.setParameters(p);
          p.encodings[0].maxBitrate = base;
          await sender.setParameters(p);
          ok = true;
        } catch { /* next peer */ }
      }
      net.lastKeyframeAsk = Date.now();
      if (ok) npLogLine(`NET keyframe forced (${reason || 'manual'}).`);
      return ok;
    } catch { return false; }
  }

  function netRequestKeyframe(reason) {
    try {
      const np = netplay();
      if (!np) return false;
      if (np.owner) return netKeyframe(reason);
      const msg = { type: 'rr4-keyframe', reason: String(reason || ''), at: Date.now() };
      let sent = false;
      for (const entry of netPcEntries()) {
        const dc = netOpenDc(entry);
        if (!dc) continue;
        try { dc.send(JSON.stringify(msg)); sent = true; } catch { /* ignore */ }
      }
      if (!sent) { try { np.sendMessage({ 'r4-net': msg }); sent = true; } catch { /* ignore */ } }
      return sent;
    } catch { return false; }
  }

  function netSendQuality(why) {
    try {
      const np = netplay();
      if (!np || np.owner) return false;
      const msg = { type: 'rr4-quality', level: state.quality.level, at: Date.now() };
      let sent = false;
      for (const entry of netPcEntries()) {
        const dc = netOpenDc(entry);
        if (!dc) continue;
        try { dc.send(JSON.stringify(msg)); sent = true; } catch { /* ignore */ }
      }
      if (!sent) { try { np.sendMessage({ 'r4-net': msg }); sent = true; } catch { /* ignore */ } }
      npLogLine(`NET quality ${state.quality.level.toUpperCase()} requested from the host (${why || 'manual'})${sent ? '' : ' - no channel yet'}.`);
      return sent;
    } catch { return false; }
  }

  // The guest -> host control messages travel on the already-open data channel.
  // The bundle's own dc.onmessage would apply them as pad input, so it is
  // wrapped and rr4-* messages are taken out before it sees them.
  function netHookDc(entry) {
    try {
      const dc = entry && entry.dataChannel;
      if (!dc) return;
      if (dc.__r4Hooked && dc.onmessage === dc.__r4Wrapper) return;
      const orig = dc.onmessage;
      const wrapper = function (e) {
        try {
          const d = JSON.parse(e.data);
          if (d && typeof d.type === 'string' && d.type.indexOf('rr4-') === 0) {
            netOnControl(d, 'dc');
            return undefined;
          }
        } catch { /* not ours */ }
        if (typeof orig === 'function') return orig.call(this, e);
        return undefined;
      };
      dc.__r4Wrapper = wrapper;
      dc.__r4Hooked = true;
      dc.onmessage = wrapper;
    } catch { /* ignore */ }
  }

  function netOnControl(msg, via) {
    try {
      const np = netplay();
      if (!np || !msg || !msg.type) return;
      if (msg.type === 'rr4-quality') {
        if (!np.owner) return;
        const level = String(msg.level || '').toLowerCase();
        if (!QUALITY[level] && level !== 'auto') return;
        state.quality.level = level;
        state.quality.autoDropped = false;
        state.quality.droppedAt = null;
        netSyncQualitySelect();
        npLogLine(`NET host quality -> ${level.toUpperCase()} (guest request via ${via || 'net'}).`);
        netApplyHost(`quality:${level}`, true).then(() => {
          const target = netQualityTarget();
          const ack = { type: 'rr4-quality-ack', applied: target.level, bitrate: target.bitrate, fps: target.fps };
          for (const entry of netPcEntries()) {
            const dc = netOpenDc(entry);
            if (dc) { try { dc.send(JSON.stringify(ack)); } catch { /* ignore */ } }
          }
        }).catch(() => {});
      } else if (msg.type === 'rr4-keyframe') {
        if (np.owner) netKeyframe(`guest:${msg.reason || 'request'}`).catch(() => {});
      } else if (msg.type === 'rr4-quality-ack') {
        npLogLine(`NET host applied ${String(msg.applied || '').toUpperCase()} ${Math.round((msg.bitrate || 0) / 1000)} kbps / ${msg.fps || '?'} fps.`);
      }
    } catch { /* ignore */ }
  }

  function netBindSocket() {
    try {
      const np = netplay();
      if (!np || !np.socket || net.socketBound === np.socket) return;
      net.socketBound = np.socket;
      np.socket.on('data-message', (data) => {
        const msg = data && data['r4-net'];
        if (msg && msg.type) netOnControl(msg, 'relay');
      });
    } catch { /* ignore */ }
  }

  // N3: the guest input already goes over the WebRTC data channel. With that
  // channel open the Socket.IO "sync-control" copy is a second transport for the
  // same event, so it is suppressed. The data-channel message is untouched.
  function netInstallInputDedup(np) {
    try {
      if (!np || np.__r4Dedup) return;
      np.__r4Dedup = true;
      const count = (d) => (d && Array.isArray(d['sync-control']) ? d['sync-control'].length : 1);
      if (typeof np.sendMessage === 'function') {
        const origSend = np.sendMessage.bind(np);
        np.sendMessage = function (d) {
          try {
            if (!np.owner && d && d['sync-control']) {
              if (NET.dedup && netAnyDcOpen()) {
                state.input.dropped += count(d);
                return undefined;
              }
              state.input.relay += count(d);
            }
          } catch { /* ignore */ }
          return origSend(d);
        };
      }
      if (typeof np.simulateInput === 'function') {
        const origSim = np.simulateInput.bind(np);
        np.simulateInput = function (player, index, value) {
          const r = origSim(player, index, value);
          try { if (!np.owner && netAnyDcOpen()) state.input.dc += 1; } catch { /* ignore */ }
          return r;
        };
      }
    } catch { /* ignore */ }
  }

  // N6d: a desynchronized 2D context for the guest blit. Measured on this box it
  // presents ~41 fps against ~55 fps without it, so it is opt-in (?desync=1) and
  // the context is only patched for the roomJoined call that creates it.
  function netPatchGuestContext(np) {
    try {
      if (!NET.desync || !np || np.__r4Desync || typeof np.roomJoined !== 'function') return;
      np.__r4Desync = true;
      const ok = (() => {
        try {
          const c = document.createElement('canvas');
          const ctx = c.getContext('2d', { alpha: false, desynchronized: true });
          const attrs = ctx && ctx.getContextAttributes ? ctx.getContextAttributes() : null;
          return !!(attrs && attrs.desynchronized);
        } catch { return false; }
      })();
      net.desyncOk = ok;
      state.tuning.desynchronized = ok;
      if (!ok) return;
      const orig = np.roomJoined;
      np.roomJoined = function (...args) {
        const proto = window.HTMLCanvasElement && HTMLCanvasElement.prototype;
        const getContext = proto && proto.getContext;
        if (getContext) {
          proto.getContext = function (type, opts) {
            if (String(type) === '2d') opts = Object.assign({}, opts || {}, { desynchronized: true });
            return getContext.call(this, type, opts);
          };
        }
        try { return orig.apply(this, args); }
        finally { if (getContext) proto.getContext = getContext; }
      };
    } catch { /* ignore */ }
  }

  function netSyncQualitySelect() {
    try { if (npQuality) npQuality.value = state.quality.level; } catch { /* ignore */ }
  }

  function netSetQuality(level, why) {
    const lvl = (QUALITY[level] || level === 'auto') ? level : 'auto';
    state.quality.level = lvl;
    state.quality.autoDropped = lvl === 'low';
    state.quality.droppedAt = null;
    netSyncQualitySelect();
    try { localStorage.setItem('rr4.netplay.quality', lvl); } catch { /* ignore */ }
    const np = netplay();
    if (np && np.owner) netApplyHost(`quality:${lvl}`, true).catch(() => {});
    else netSendQuality(why || 'user');
    net.lastSig = '';
    net.logSig = '';
    npLogLine(`NET quality -> ${lvl.toUpperCase()}${why ? ` (${why})` : ''}.`);
    return lvl;
  }

  // N4: one stats line per 2 s (sampled faster so a >500 ms freeze is visible).
  async function netSampleStats() {
    try {
      const np = netplay();
      if (!np) return;
      const entries = netPcEntries();
      if (!entries.length) return;
      const pc = netPc(entries[0]);
      if (!pc || typeof pc.getStats !== 'function') return;
      const now = Date.now();
      if (now - net.lastSampleAt < 700) return;
      net.lastSampleAt = now;
      const report = await pc.getStats();
      let tx = null;
      let rx = null;
      let pair = null;
      report.forEach((s) => {
        if (!s) return;
        const video = s.kind === 'video' || s.mediaType === 'video';
        if (s.type === 'outbound-rtp' && video && !tx) tx = s;
        else if (s.type === 'inbound-rtp' && video && !rx) rx = s;
        else if (s.type === 'candidate-pair' && (s.selected || s.state === 'succeeded')) pair = s;
      });
      const jbMs = rx && rx.jitterBufferDelay != null && rx.jitterBufferEmittedCount
        ? Math.round((rx.jitterBufferDelay / rx.jitterBufferEmittedCount) * 1000) : null;
      const rttMs = pair && pair.currentRoundTripTime != null
        ? Math.round(pair.currentRoundTripTime * 1000)
        : (tx && tx.roundTripTime != null ? Math.round(tx.roundTripTime * 1000) : null);
      const bytes = tx ? (tx.bytesSent ?? null) : (rx ? (rx.bytesReceived ?? null) : null);
      const prev = net.sample;
      const kbps = bytes != null && prev && prev.bytes != null && prev.at && now > prev.at
        ? Math.round(((bytes - prev.bytes) * 8) / (now - prev.at)) : (prev ? prev.kbps : null);
      const m = {
        role: np.owner ? 'host' : 'guest',
        at: now,
        fps: tx ? (tx.framesPerSecond ?? null) : (rx ? (rx.framesPerSecond ?? null) : null),
        framesEncoded: tx ? (tx.framesEncoded ?? null) : null,
        framesDecoded: rx ? (rx.framesDecoded ?? null) : null,
        qualityLimitationReason: tx ? (tx.qualityLimitationReason ?? null) : null,
        jitterBufferMs: jbMs,
        packetsLost: rx ? (rx.packetsLost ?? null) : null,
        roundTripTimeMs: rttMs,
        availableOutgoingBitrate: tx && tx.availableOutgoingBitrate != null
          ? tx.availableOutgoingBitrate
          : (pair && pair.availableOutgoingBitrate != null ? pair.availableOutgoingBitrate : null),
        kbps: kbps != null ? kbps : null,
        resolution: tx ? `${tx.frameWidth || 0}x${tx.frameHeight || 0}`
          : (rx ? `${rx.frameWidth || 0}x${rx.frameHeight || 0}` : null),
        quality: state.quality.level,
        captureFps: NET.captureFps,
        input: { ...state.input },
      };
      net.sample = { at: now, bytes, kbps: m.kbps };
      window.__R4NET.stats = m;
      try {
        if (npChip) {
          npChip.dataset.stats = JSON.stringify(m);
          npChip.dataset.input = `dc=${state.input.dc};relay=${state.input.relay};dropped=${state.input.dropped}`;
        }
      } catch { /* ignore */ }
      // Freeze: no encoded/decoded frame for > 500 ms while the peer is live.
      const frames = tx ? (tx.framesEncoded ?? null) : (rx ? (rx.framesDecoded ?? null) : null);
      const pcLive = pc.connectionState === 'connected' || pc.iceConnectionState === 'connected' || pc.iceConnectionState === 'completed';
      if (frames != null && pcLive) {
        if (net.lastFrames === frames) {
          if (now - net.lastFramesAt > 500 && now - net.lastKeyframeAsk > 4000) {
            npLogLine(`NET freeze > 500 ms (${np.owner ? 'encode' : 'decode'} stalled) - keyframe requested.`);
            netRequestKeyframe('freeze');
          }
        } else {
          net.lastFrames = frames;
          net.lastFramesAt = now;
        }
      }
      if (now - net.lastStatsLog < 2000) return;
      net.lastStatsLog = now;
      const bits = [
        `NET ${m.role} ${m.fps != null ? m.fps + 'fps' : 'fps ?'}`,
        m.framesEncoded != null ? `enc ${m.framesEncoded}` : null,
        m.framesDecoded != null ? `dec ${m.framesDecoded}` : null,
        m.resolution && m.resolution !== '0x0' ? m.resolution : null,
        m.kbps != null ? `${m.kbps} kbps` : null,
        m.qualityLimitationReason ? `limit=${m.qualityLimitationReason}` : null,
        m.jitterBufferMs != null ? `jbuf ${m.jitterBufferMs} ms` : null,
        m.packetsLost != null ? `lost ${m.packetsLost}` : null,
        m.roundTripTimeMs != null ? `rtt ${m.roundTripTimeMs} ms` : null,
        m.availableOutgoingBitrate != null ? `avail ${Math.round(m.availableOutgoingBitrate / 1000)} kbps` : null,
        `q=${m.quality}`,
      ].filter(Boolean);
      npLogLine(bits.join(' '));
      // N5 AUTO: MED -> LOW after two consecutive 2 s windows that are
      // bandwidth-limited or losing packets. It never climbs back mid-race.
      if (state.quality.level === 'auto' && !state.quality.autoDropped) {
        const lostNow = m.packetsLost;
        const lossRising = lostNow != null && net.lastLost != null && lostNow > net.lastLost;
        net.lastLost = lostNow;
        const bad = m.qualityLimitationReason === 'bandwidth' || lossRising;
        net.autoBad = bad ? net.autoBad + 1 : 0;
        if (net.autoBad >= 2) {
          state.quality.autoDropped = true;
          state.quality.droppedAt = now;
          state.quality.level = 'low';
          netSyncQualitySelect();
          if (np.owner) netApplyHost('auto:low', true).catch(() => {});
          else netSendQuality('auto:low');
          npLogLine(`NET AUTO quality -> LOW (${m.qualityLimitationReason || 'loss'} limited for 4 s).`);
        }
      }
    } catch { /* ignore */ }
  }

  // N6a: only an exact integer upscale keeps nearest-neighbour sampling; any
  // other scale (downscale, fractional upscale) uses the browser's filter.
  function netSetImageRendering() {
    try {
      const em = window.EJS_emulator;
      const np = netplay();
      if (!em || !em.isNetplay || !np || np.owner) return;
      const cv = em.netplayCanvas;
      const gameEl = document.querySelector('#game');
      if (!cv || !gameEl) return;
      const bw = cv.width || 0;
      const bh = cv.height || 0;
      const cw = cv.clientWidth || 0;
      const ch = cv.clientHeight || 0;
      if (!bw || !bh || !cw || !ch) return;
      const exact = cw % bw === 0 && ch % bh === 0 && cw >= bw * 2 && ch >= bh * 2;
      gameEl.classList.toggle('np-pixel', exact);
      gameEl.classList.toggle('np-smooth', !exact);
      state.render = {
        bitmap: [bw, bh], box: [cw, ch],
        scale: +(cw / bw).toFixed(3),
        imageRendering: exact ? 'pixelated' : 'auto',
        desynchronized: net.desyncOk,
      };
    } catch { /* ignore */ }
  }

  // N6 (report 12 R1): the bundle re-blits the guest canvas on every rAF even
  // when no new video frame arrived (measured 233 blits/s for 27 frames/s). The
  // patched loop keeps the bundle's crop math verbatim. Measured guest presented
  // fps (3 s rVFC): bundle loop 55, draw inside rVFC 50, gated rAF 42 - the
  // detached <video> is only presented when the plain rAF loop consumes it, so
  // the bundle loop stays the default and the patch is opt-in.
  //   ?draw=bundle  (default) ?draw=gated  ?draw=rvfc
  function netPatchGuestDraw(np) {
    try {
      if (!np || np.__r4Draw || typeof np.drawVideoToCanvas !== 'function') return;
      const mode = qs.get('draw') || 'bundle';
      if (mode === 'bundle') return;
      np.__r4Draw = true;
      const orig = np.drawVideoToCanvas;
      np.drawVideoToCanvas = function () {
        const video = this.video;
        const canvas = this.emu && this.emu.netplayCanvas;
        if (!video || !canvas || typeof video.requestVideoFrameCallback !== 'function') {
          return orig.call(this);
        }
        let ctx = null;
        try { ctx = canvas.getContext('2d', { alpha: false }); } catch { ctx = null; }
        if (!ctx) return orig.call(this);
        try { if (this.stopDrawLoop) this.stopDrawLoop(); } catch { /* ignore */ }
        const self = this;
        let running = true;
        let presented = 0;
        let drawn = -1;
        const bump = () => { presented += 1; video.requestVideoFrameCallback(bump); };
        video.requestVideoFrameCallback(bump);
        const drawOnce = () => {
          if (video.readyState < 2 || !video.videoWidth || !video.videoHeight) return;
          const vw = video.videoWidth;
          const vh = video.videoHeight;
          const nativeRes = self.getNativeResolution ? self.getNativeResolution() : null;
          let nativeAspect = 4 / 3;
          if (nativeRes && nativeRes.width && nativeRes.height) nativeAspect = nativeRes.width / nativeRes.height;
          const videoAspect = vw / vh;
          let srcX = 0;
          let srcY = 0;
          let srcW = vw;
          let srcH = vh;
          if (videoAspect > nativeAspect + 0.05) { srcH = vh; srcW = vh * nativeAspect; srcX = (vw - srcW) / 2; }
          else if (videoAspect < nativeAspect - 0.05) { srcW = vw; srcH = vw / nativeAspect; srcY = 0; }
          srcX = Math.round(srcX);
          srcY = Math.round(srcY);
          srcW = Math.max(1, Math.round(srcW));
          srcH = Math.max(1, Math.round(srcH));
          if (canvas.width !== srcW || canvas.height !== srcH) { canvas.width = srcW; canvas.height = srcH; }
          ctx.fillStyle = '#000';
          ctx.fillRect(0, 0, canvas.width, canvas.height);
          ctx.imageSmoothingEnabled = false;
          ctx.drawImage(video, srcX, srcY, srcW, srcH, 0, 0, canvas.width, canvas.height);
        };
        const draw = () => {
          if (!running || !self.emu.isNetplay || self.owner || !canvas.parentNode) return;
          try { drawOnce(); } catch { /* skip one bad frame */ }
          if (mode === 'rvfc') video.requestVideoFrameCallback(draw);
          else requestAnimationFrame(loop);
        };
        const loop = () => {
          if (!running || !self.emu.isNetplay || self.owner || !canvas.parentNode) return;
          if (mode === 'qpf') {
            let total = null;
            try {
              const q = video.getVideoPlaybackQuality ? video.getVideoPlaybackQuality() : null;
              total = q ? q.totalVideoFrames : null;
            } catch { total = null; }
            if (total == null || total !== drawn) {
              drawn = total;
              try { drawOnce(); } catch { /* skip one bad frame */ }
            }
          } else if (presented !== drawn) {
            drawn = presented;
            try { drawOnce(); } catch { /* skip one bad frame */ }
          }
          requestAnimationFrame(loop);
        };
        if (mode === 'rvfc') video.requestVideoFrameCallback(draw);
        else requestAnimationFrame(loop);
        this.stopDrawLoop = () => { running = false; };
      };
      state.tuning.guestDraw = mode;
    } catch { /* keep the bundle loop */ }
  }

  // N6 (report 12 R5): keep the guest <video> decoded but *attached* off-screen.
  // Measured slightly worse here (41 vs 45 presented), so it is opt-in with
  // ?video=attached; the bundle's detached element stays the default.
  function netAttachGuestVideo(np) {
    try {
      if (!np || np.owner || np.__r4VideoAttached || qs.get('video') !== 'attached') return;
      const v = np.video;
      if (!v) return;
      np.__r4VideoAttached = true;
      if (v.parentNode) return;
      v.classList.add('ejs_netplay_offscreen');
      try { v.disablePictureInPicture = true; } catch { /* ignore */ }
      v.controls = false;
      v.setAttribute('playsinline', '');
      v.setAttribute('webkit-playsinline', '');
      document.body.appendChild(v);
      state.tuning.guestVideo = 'attached-offscreen';
    } catch { /* detached video still decodes */ }
  }

  function netTick() {
    try {
      const np = netplay();
      if (!np) return;
      net.np = np;
      const entries = netPcEntries();
      for (const entry of entries) netHookDc(entry);
      netBindSocket();
      if (np.owner) {
        const cv = netCanvas();
        const key = cv ? `${cv.width}x${cv.height}` : '';
        if (NET.captureFps > 30 && key && net.trackKey && key !== net.trackKey) {
          netApplyHost('canvas-resize', true).catch(() => {});
        }
      } else if (!net.guestQualitySent && netAnyDcOpen()) {
        net.guestQualitySent = true;
        if (state.quality.level !== 'auto') netSendQuality('join');
      }
      if (!np.owner) netAttachGuestVideo(np);
      netSetImageRendering();
      if (NET.stats) netSampleStats();
    } catch { /* ignore */ }
  }

  function netRaceLive(role) {
    try {
      const np = netplay();
      if (np && np.owner) {
        netApplyHost('race-live', true).catch(() => {});
        netKeyframe('race-live').catch(() => {});
      } else {
        netRequestKeyframe('race-live');
      }
      npLogLine(`NET race live (${role || 'net'}) - ${np && np.owner ? '60 fps capture + fresh IDR' : 'IDR requested from the host'}.`);
    } catch { /* ignore */ }
  }

  function netPatchPeers(np) {
    try {
      if (!np || np.__r4PeersPatched) return;
      np.__r4PeersPatched = true;
      if (typeof np.initWebRTCStream === 'function') {
        const origInit = np.initWebRTCStream.bind(np);
        np.initWebRTCStream = async function () {
          const r = await origInit();
          netApplyHost('stream').catch(() => {});
          return r;
        };
      }
      if (typeof np.createPeerConnection === 'function') {
        const origCreate = np.createPeerConnection.bind(np);
        np.createPeerConnection = function (peerId) {
          const pc = origCreate(peerId);
          setTimeout(() => {
            try { netApplyHost(`pc:${peerId}`).catch(() => {}); } catch { /* ignore */ }
            try { netPcEntries().forEach(netHookDc); } catch { /* ignore */ }
          }, 0);
          return pc;
        };
      }
      if (typeof np.adjustVideoBitrate === 'function') {
        const origAdjust = np.adjustVideoBitrate.bind(np);
        np.adjustVideoBitrate = function (pc, usingRelay) {
          const r = origAdjust(pc, usingRelay);
          // EJS resets the ceiling to 2.5 Mbps / 30 fps on connect; re-assert
          // ours just after its own setParameters has landed.
          setTimeout(() => {
            try { netApplyHost(usingRelay ? 'connect-relay' : 'connect', true).catch(() => {}); } catch { /* ignore */ }
          }, 300);
          return r;
        };
      }
    } catch { /* ignore */ }
  }

  function applyNetplayTuning(np) {
    try {
      if (!np) return false;
      net.np = np;
      if (net.installed) return true;
      net.installed = true;
      try { netPatchGuestContext(np); } catch { /* ignore */ }
      try { netPatchGuestDraw(np); } catch { /* ignore */ }
      try { netInstallPullHook(np); } catch { /* ignore */ }
      try { netInstallInputDedup(np); } catch { /* ignore */ }
      try { netPatchPeers(np); } catch { /* ignore */ }
      try { np.__r4Tuned = true; } catch { /* ignore */ }
      netSyncQualitySelect();
      npLogLine(`NET tuning: capture ${NET.captureFps} fps, keyframe ${NET.keyframe ? 'on' : 'off'}, input dedup ${NET.dedup ? 'on' : 'off'}, stats ${NET.stats ? 'on' : 'off'}, quality ${state.quality.level.toUpperCase()}, desync ${net.desyncOk === null ? 'pending' : (net.desyncOk ? 'on' : 'n/a')}.`);
      setInterval(netTick, 750);
      window.addEventListener('resize', () => { try { netSetImageRendering(); } catch { /* ignore */ } });
      document.addEventListener('fullscreenchange', () => { try { netSetImageRendering(); } catch { /* ignore */ } });
      return true;
    } catch { return false; }
  }

  if (npQuality) {
    netSyncQualitySelect();
    npQuality.addEventListener('change', () => netSetQuality(npQuality.value, 'user'));
  }
  window.__R4NET.tuning = () => ({
    captureFps: NET.captureFps, keyframe: NET.keyframe, dedup: NET.dedup, stats: NET.stats,
    desync: net.desyncOk, quality: state.quality, input: { ...state.input },
    track: net.track ? { readyState: net.track.readyState, key: net.trackKey, settings: (() => { try { return net.track.getSettings(); } catch { return null; } })() } : null,
    pin: net.pin ? { drawn: net.pin.drawn, frame: net.pin.frame, running: net.pin.running, size: [net.pin.canvas.width, net.pin.canvas.height], src: [net.pin.src.width, net.pin.src.height] } : null,
    loop: net.loop ? { running: net.loop.running } : null,
    pull: { pulled: net.pulled, frame: net.pullFrame },
    captureSource: state.tuning.captureSource || null,
    sample: net.sample, encode: state.tuning.encode || null,
  });
  window.__R4NET.setQuality = (level) => netSetQuality(level, 'api');
  window.__R4NET.keyframe = () => netKeyframe('api');
  window.__R4NET.pinCanvas = () => (net.pin ? net.pin.canvas : null);
  window.__R4NET.stats = null;

  // ---------------------------------------------------------------------
  // Netplay readiness: wait for EJS_emulator.netplay, then wire the panel.
  // ---------------------------------------------------------------------
  let netplayTimer = null;
  let statusTimer = null;
  let relayChecked = false;

  function waitForNetplay() {
    if (netplayTimer) return;
    netplayTimer = setInterval(() => {
      const np = netplay();
      if (!np) return;
      clearInterval(netplayTimer);
      netplayTimer = null;
      onNetplayReady(np);
    }, 200);
    // Do not poll forever if the 4.3 build failed to construct netplay.
    setTimeout(() => {
      if (netplayTimer) {
        clearInterval(netplayTimer);
        netplayTimer = null;
        if (!netplay()) npLogLine('EmulatorJS netplay object not found (check EJS_netplayServer/gameID).');
      }
    }, 20000);
  }

  function onNetplayReady(np) {
    state.netplay.available = true;
    try { applyNetplayTuning(np); } catch { /* never block the panel */ }
    const em = window.EJS_emulator;
    state.netplay.version = (em && (em.ejs_version || em.version)) || '4.3.0-pre';
    np.name = playerName();
    installMpControlListener();
    if (npVersion) npVersion.textContent = state.netplay.version;
    npLogLine(`Netplay client ready (EmulatorJS ${state.netplay.version}).`);
    npLogLine(`Relay ${netplayServer}; room discovery uses origin ${location.host}, gameID ${game.id}.`);
    checkRelay().then((h) => {
      relayChecked = true;
      if (h && h.ok) {
        npLogLine(`Relay healthy: ${h.rooms || 0} room(s), ${h.players || 0} player(s).`);
      } else {
        npLogLine(`Relay unreachable at ${netplayServer}. Run start-netplay.bat on the host and allow TCP 3010.`);
      }
    });
    updateNetplayStatus();
    refreshRooms().catch(() => {});

    statusTimer = setInterval(() => {
      updateNetplayStatus();
      // The socket may appear after the first ready tick; keep the control
      // channel bound to the current socket instance.
      if (em && em.isNetplay) installMpControlListener();
      if (!relayChecked) return;
      // Refresh the room list while the panel is open and not joined.
      if (panelOpen && !(em && em.isNetplay)) refreshRooms().catch(() => {});
    }, 1000);

    // Reflect a host/guest transition once, even if the panel is collapsed.
    let lastJoined = false;
    setInterval(() => {
      const e = window.EJS_emulator;
      const n = netplay();
      const joined = !!(e && e.isNetplay);
      if (joined && !lastJoined) {
        state.netplay.joinedAt = Date.now();
        const owner = !!(n && n.owner);
        const room = n && n.extra ? n.extra.room_name : '';
        npLogLine(owner
          ? `HOSTING "${room}". Keep this tab in front; guests receive the host stream.`
          : `JOINED "${room}" as guest. The host runs ${game.name}; input is sent as player 2.`);
        installMpControlListener();
        // Ghost: the turn gate replaces the shared-car remap entirely.
        if (ghost.enabled) {
          if (owner) installGhostGate();
        } else if (mp.mode === 'shared-car' && owner) startSharedCarRemapPoll();
        if (!owner) {
          installGuestGate();
          if (ghost.enabled) {
            npLogLine(`Ghost - driver this run is ${ghost.turn.toUpperCase()}; the host gates the other pad and replays the finished tape.`);
          } else if (mp.mode !== 'versus') {
            npLogLine('Shared car - both pads drive the host car from boot; no menu macro runs.');
          } else {
            npLogLine(mp.inputGated
              ? 'Guest input is parked until the host starts the race.'
              : 'Manual netplay join - guest input is live immediately.');
          }
          mpSignal({ type: 'hello', role: 'guest', at: Date.now() });
        }
        setPanel(false);
      } else if (!joined && lastJoined) {
        state.netplay.joinedAt = null;
        state.netplay.videoLogged = false;
        state.netplay.lastPlayers = null;
        npLogLine('Left the room.');
        setPanel(true);
      }
      if (joined && !(n && n.owner) && activeFilter === 'dlss5' && gameStarted && dlss5Ready) {
        setDlss5Stage(true);
      }
      lastJoined = joined;
    }, 500);
  }

  // Panel buttons.
  npCreate?.addEventListener('click', () => {
    hostRoom(npRoomName?.value, npMaxPlayers?.value, '');
  });
  npRefresh?.addEventListener('click', () => {
    npLogLine('Refreshing room list...');
    refreshRooms().catch(() => {});
  });
  npMenu?.addEventListener('click', openNetplayMenu);
  npLeave?.addEventListener('click', leaveRoom);

  // Keep the panel useful before the emulator boots.
  setPanel(true);
  updateNetplayStatus();

  // Keep uncaught errors visible in the overlay instead of a silent black box.
  window.addEventListener('error', (e) => {
    const msg = e && e.message ? e.message : 'Script error';
    if (!/ResizeObserver/.test(msg)) state.errors.push({ message: msg, source: e.filename, line: e.lineno });
  });
  window.addEventListener('unhandledrejection', (e) => {
    const r = e && e.reason;
    const message = r && r.message ? r.message : String(r);
    // EmulatorJS 4.3 builds its netplay chat/menu DOM lazily; an early auto-join
    // can race that and reject with "appendChild of undefined". It is cosmetic:
    // the socket still joins, but keep the console and the error panel clean.
    if (/appendChild/.test(message)) {
      mp.ejsNoise = (mp.ejsNoise || 0) + 1;
      try { npLogLine('EmulatorJS netplay UI race (appendChild) - ignored.'); } catch { /* ignore */ }
      e.preventDefault();
      return;
    }
    state.errors.push({ message: 'unhandledrejection: ' + message });
  });

  probe().then((ok) => { if (ok) boot(); });
})();
