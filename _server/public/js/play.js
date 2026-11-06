/* Ridge Racer Type 4 — native browser player (EmulatorJS / PCSX-ReARMed).
 *
 * Self-hosted: no CDN at runtime. EmulatorJS 4.2.3 lives in
 * /emulator/data/, the disc image is served from /rom/, BIOS from /bios/.
 *
 * URL parameters (all optional):
 *   ?game=r4|rage          pick a title (default r4)
 *   ?bios=openbios|hle     BIOS choice (default openbios)
 *   ?bios=/bios/foo.bin    explicit BIOS url
 *   ?cue=auto|direct|file  auto-cue (default), raw BIN, or the real .cue
 *   ?threads=1             request the threaded core (needs COOP/COEP, on by default)
 *   ?quality=authentic|balanced|perf|auto   quality preset (default authentic)
 *   ?pb=1|0                force preserveDrawingBuffer on/off (ghost capture)
 *   ?rec=1                 arm ghost recording (keeps preserveDrawingBuffer)
 *   ?debug=1               load unminified EmulatorJS sources
 *
 * Quality presets are documented in docs/pages/play/browser.mdx; the measured
 * evidence behind the defaults is _runtime/analysis/01-core-perf.md §1.4/§2.4
 * and _runtime/analysis/13-weak-client.md §4-§5.
 */
(() => {
  'use strict';

  // ---------------------------------------------------------------------
  // Game manifest. Rage Racer is a placeholder until its ROM is dropped
  // into the disc folder with the name below.
  // ---------------------------------------------------------------------
  const GAMES = {
    r4: {
      id: 4,
      name: 'Ridge Racer Type 4',
      subtitle: 'RIDGE RACER TYPE 4',
      region: 'USA',
      // Compressed CHD (341 MiB) is the default: same disc, ~45% less to fetch.
      rom: '/rom/r4.chd',
      // Fallback if the CHD is unavailable: raw single-track BIN (+ cue).
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
      // Multi-track disc compressed to one CHD (17 tracks, 495 MB).
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
  // The shell loads this page with ?embedded=1 after its own ENTER gesture. The
  // parent already unlocked the browser audio, so do not stack a second
  // "CLICK TO RACE" gate on top of the game; unlock on the next click instead.
  const embedded = qs.get('embedded') === '1' && window.parent !== window;
  const gameKey = (qs.get('game') || 'r4').toLowerCase();
  let game = GAMES[gameKey] || GAMES.r4;
  let selectedKey = null;

  // ---------------------------------------------------------------------
  // Race Day MMO (?mmo=1&event=<id>&seat=<n>&team=<t>).
  // The HUD module, its stylesheet and the /mmo socket are loaded only when
  // the flag is present, so /play is otherwise byte-for-byte unchanged.
  // ---------------------------------------------------------------------
  const mmoOn = qs.get('mmo') === '1';
  const mmoSeatRaw = qs.get('seat');
  const mmoSeat = mmoSeatRaw != null && mmoSeatRaw !== '' && Number.isFinite(Number(mmoSeatRaw))
    ? Number(mmoSeatRaw)
    : null;
  const mmoParams = mmoOn
    ? { event: qs.get('event') || null, seat: mmoSeat, team: qs.get('team') || null }
    : null;
  if (mmoOn) window.__R4_MMO_PARAMS = mmoParams;

  // A Race Day handoff boots the disc straight away (the seat/event is already
  // locked by the server); ?game= keeps its existing "no setup=1 left behind"
  // rule, and ?setup=1 still opens the deck.
  const startImmediately = qs.get('autostart') === '1' || qs.get('start') === '1' ||
    (!!qs.get('game') && qs.get('setup') !== '1') ||
    (mmoOn && qs.get('setup') !== '1');

  const biosMode = (qs.get('bios') || 'openbios').toLowerCase();
  const cueMode = (qs.get('cue') || 'auto').toLowerCase();
  // Threads need SharedArrayBuffer -> cross-origin isolation -> HTTPS or
  // localhost. Plain-HTTP LAN origins are not trustworthy, so default off
  // there and only enable when explicitly requested or the context is secure.
  const useThreads = qs.get('threads') === '1' ||
    (qs.get('threads') !== '0' && qs.get('threads') !== 'false' && window.isSecureContext);
  const debug = qs.get('debug') === '1';

  let biosUrl = game.bios;
  if (biosMode === 'hle' || biosMode === 'none' || biosMode === '0') biosUrl = '';
  else if (biosMode.startsWith('/')) biosUrl = biosMode;

  // ---------------------------------------------------------------------
  // Quality presets. Resolved before boot(): EJS_defaultOptions, EJS_threads
  // and the WebGL context attributes are read exactly once, by the loader and
  // the core. Three levers, in the measured order of effect:
  //   1. pixels  - the fullscreen backing-store cap (play.css, CSS only)
  //   2. present - preserveDrawingBuffer / alpha on the WebGL context
  //   3. core    - icache (+6 %, accuracy trade) and frameskip (last resort)
  // ---------------------------------------------------------------------
  const QUALITY_KEY = 'rr4.play.quality';
  const QUALITY_TIERS = ['authentic', 'balanced', 'perf'];
  const DEFAULT_TIER = 'authentic';
  // 1280x960 is exactly 2x the 640x480 core output and 44 % cheaper than
  // fullscreen 1920x1080. play.css enforces it; canvas.width is never written.
  const FULLSCREEN_CAP_PX = 1280;
  // Only option ids that exist in this build's pcsx_rearmed table (dumped from
  // the live core in _runtime/analysis/01-core-perf.md §1.4; the shipped
  // reports/pcsx_rearmed.json only carries defaultWebGL2). Anything unknown is
  // dropped at boot and reported, never guessed.
  const KNOWN_CORE_OPTIONS = new Set([
    'pcsx_rearmed_icache_emulation',
    'pcsx_rearmed_frameskip_type',
    'pcsx_rearmed_frameskip_threshold',
  ]);
  const QUALITY_CORE_OPTIONS = {
    // No override at all: the compiled core defaults are today's look.
    authentic: {},
    // The only repeatable core win in this build (+6 % at 4x CPU, measured).
    balanced: { pcsx_rearmed_icache_emulation: 'disabled' },
    // Frameskip skips the blit, not the interpreter -> last step only.
    perf: {
      pcsx_rearmed_icache_emulation: 'disabled',
      pcsx_rearmed_frameskip_type: 'auto_threshold',
      pcsx_rearmed_frameskip_threshold: '33',
    },
  };

  const qsQuality = (qs.get('quality') || '').toLowerCase();
  let storedQuality = '';
  try { storedQuality = (localStorage.getItem(QUALITY_KEY) || '').toLowerCase(); } catch { /* ignore */ }
  const validQuality = (v) => v === 'auto' || QUALITY_TIERS.includes(v);
  let qualityMode = DEFAULT_TIER;
  let qualitySource = 'default';
  if (validQuality(qsQuality)) { qualityMode = qsQuality; qualitySource = 'url'; }
  else if (validQuality(storedQuality)) { qualityMode = storedQuality; qualitySource = 'stored'; }
  if (qualitySource === 'url') {
    try { localStorage.setItem(QUALITY_KEY, qualityMode); } catch { /* ignore */ }
  }
  // The tier in effect. AUTO starts at the default and only ever ratchets down.
  let qualityTier = qualityMode === 'auto' ? DEFAULT_TIER : qualityMode;

  // preserveDrawingBuffer costs a full-buffer copy per present, so it is only
  // on when a ghost recording can actually start: an armed recorder (?rec=1,
  // or a previous REC press) or the AUTHENTIC tier on a secure context (where
  // the REC button is usable). Plain-HTTP LAN is not a secure context, so it
  // pays nothing; ghost capture there is tab capture (getDisplayMedia).
  const recArmed = qs.get('rec') === '1' || (() => {
    try { return localStorage.getItem('rr4.ghost.rec') === '1'; } catch { return false; }
  })();
  const pbParam = (qs.get('pb') || '').toLowerCase();
  const preserveDrawingBuffer = pbParam === '1' ? true
    : (pbParam === '0' ? false
      : (recArmed || (qualityTier === 'authentic' && !!window.isSecureContext)));

  // ---------------------------------------------------------------------
  // Diagnostics surface (read by test-ejs.mjs / DevTools).
  // ---------------------------------------------------------------------
  const state = {
    game: gameKey,
    gameName: game.name,
    core: 'psx',
    bios: biosUrl || 'HLE (none)',
    cue: cueMode,
    threads: useThreads,
    t0: performance.now(),
    events: [],
    errors: [],
    rom: null,
    canvas: null,
    startedAt: null,
    readyAt: null,
    bootMs: null,
    embedded,
    quality: {
      mode: qualityMode,
      tier: qualityTier,
      why: qualitySource,
      drops: 0,
      at: 0,
    },
    pb: preserveDrawingBuffer,
    alpha: false,
    fullscreenCapPx: FULLSCREEN_CAP_PX,
  };
  if (mmoOn) state.mmo = { ...mmoParams, hud: null };
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
  const qualitySelect = $('#qualitySelect');
  const setupQuality = $('#setupQuality');
  const footQuality = $('#footQuality');

  // ---------------------------------------------------------------------
  // Pre-boot disc deck. No ROM request or EJS loader until START.
  // ---------------------------------------------------------------------
  const setupEl = $('#setup');
  const setupStart = $('#setupStart');
  const setupEject = $('#setupEject');
  const discList = $('#discList');
  const discArt = $('#discArt');
  const discName = $('#discName');
  const discMeta = $('#discMeta');
  const discCount = $('#discCount');
  const setupFilter = $('#setupFilter');
  const setupVolume = $('#setupVolume');
  const setupFullscreen = $('#setupFullscreen');
  const setupPads = $('#setupPads');
  const localDisc = $('#localDisc');
  const ejectBtn = $('#ejectBtn');
  const ghostBtn = $('#ghostBtn');
  const ghostList = $('#ghostList');
  const ghostRefresh = $('#ghostRefresh');
  const ghostSelected = $('#ghostSelected');
  const ghostVideo = $('#ghostVideo');
  const ghostBadge = $('#ghostBadge');
  const ghostClose = $('#ghostClose');
  const gameEl = $('#game');
  let selectedGhost = null;
  let ghostRecorder = null;
  let ghostStream = null;
  let ghostSourceVideo = null;
  let ghostChunks = [];
  let ghostTimer = null;
  const VOLUME_KEY = 'rr4.play.volume';
  const FULLSCREEN_KEY = 'rr4.play.fullscreen';
  const DEFAULT_VOLUME = 0.7;
  // A missing localStorage key must fall back to DEFAULT_VOLUME, not to 0:
  // Number(null) === 0 used to leave EJS_volume at 0 (emulator muted) on a
  // fresh profile, and only a pointer click ever un-muted it.
  const getVolume = () => {
    let raw = null;
    try { raw = localStorage.getItem(VOLUME_KEY); } catch { /* ignore */ }
    if (raw == null || raw === '') return DEFAULT_VOLUME;
    const v = Number(raw);
    return Number.isFinite(v) && v >= 0 && v <= 1 ? v : DEFAULT_VOLUME;
  };
  const getFullscreen = () => {
    try { return localStorage.getItem(FULLSCREEN_KEY) === '1'; } catch { return false; }
  };

  const discMetaFor = (g) => {
    if (!g) return 'Select a disc from the library';
    const mb = g.bytes ? `${(g.bytes / 1048576).toFixed(0)} MB` : 'size unknown';
    return `${g.region || 'PSX'} - ${mb} - ${g.available === false ? 'not installed' : 'ready to insert'}`;
  };

  const setTray = (g, key) => {
    if (!g || !key) {
      discArt.classList.remove('loaded');
      discArt.innerHTML = 'NO<br>DISC';
      discName.textContent = 'NO DISC';
      discMeta.textContent = 'Select a disc from the library';
      setupStart.disabled = true;
      if (footRom) footRom.textContent = '-';
      if (footTiming) footTiming.textContent = '-';
      setStatus('NO DISC', 'loading');
      return;
    }
    discArt.classList.add('loaded');
    discArt.textContent = (g.subtitle || g.name || 'DISC').replace(/\s+/g, ' ').slice(0, 12);
    discName.textContent = g.name;
    discMeta.textContent = discMetaFor(g);
    setupStart.disabled = false;
    if (footRom) footRom.textContent = decodeURIComponent(g.rom).split('/').pop();
    if (footTiming) footTiming.textContent = '-';
    setStatus('DISC READY', 'loading');
  };

  const selectDisc = (key) => {
    if (key === 'local') {
      if (!game || !game.local) return;
    } else if (!GAMES[key]) return;
    else game = GAMES[key];
    selectedKey = key;
    selectedGhost = null;
    if (ghostSelected) ghostSelected.textContent = 'NO GHOST SELECTED';
    state.game = key;
    state.gameName = game.name;
    if (discList) {
      discList.querySelectorAll('.disc-card').forEach((el) => {
        el.classList.toggle('selected', el.dataset.key === key);
      });
    }
    if (ejectBtn) ejectBtn.hidden = !state.startedAt;
    if (setupEl && !setupEl.hidden) {
      setTray(game, key);
      loadGhosts();
      const url = new URL(location.href);
      url.searchParams.set('game', key);
      url.searchParams.set('setup', '1');
      history.replaceState(null, '', url);
    }
  };

  const clearTray = () => {
    selectedKey = null;
    game = GAMES[gameKey] || GAMES.r4;
    state.game = null;
    state.gameName = null;
    if (discList) discList.querySelectorAll('.disc-card').forEach((el) => el.classList.remove('selected'));
    setTray(null, null);
  };

  const renderDiscs = () => {
    if (!discList) return;
    discList.innerHTML = '';
    let n = 0;
    for (const [key, g] of Object.entries(GAMES)) {
      if (!g.available) continue;
      n++;
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'disc-card';
      btn.dataset.key = key;
      btn.innerHTML = `<span class="mini-disc"></span><span><strong></strong><small></small></span><span class="badge">READY</span>`;
      btn.querySelector('strong').textContent = g.name;
      btn.querySelector('small').textContent = `${g.region || 'PSX'} - ${(g.bytes / 1048576).toFixed(0)} MB`;
      btn.addEventListener('click', () => selectDisc(key));
      discList.appendChild(btn);
    }
    if (discCount) discCount.textContent = `${n} disc${n === 1 ? '' : 's'}`;
  };

  const fmtGhostDate = (t) => {
    try { return new Date(t).toLocaleString(); } catch { return ''; }
  };

  const renderGhosts = (list) => {
    if (!ghostList) return;
    ghostList.innerHTML = '';
    if (!list || !list.length) {
      ghostList.innerHTML = '<span class="ghost-empty">No ghost clips for this disc yet. Race, press REC GHOST, then stop to upload.</span>';
      return;
    }
    for (const g of list) {
      const row = document.createElement('div');
      row.className = 'ghost-row' + (selectedGhost && selectedGhost.id === g.id ? ' active' : '');
      const name = document.createElement('span');
      name.className = 'ghost-name';
      name.textContent = `${g.name || 'GHOST'} - ${fmtGhostDate(g.createdAt)}`;
      name.title = name.textContent;
      const use = document.createElement('button');
      use.type = 'button';
      use.textContent = selectedGhost && selectedGhost.id === g.id ? 'IN USE' : 'USE';
      use.addEventListener('click', () => {
        selectedGhost = g;
        if (ghostSelected) ghostSelected.textContent = `GHOST: ${g.name || g.id}`;
        renderGhosts(list);
      });
      row.append(name, use);
      ghostList.appendChild(row);
    }
  };

  const loadGhosts = async () => {
    if (!ghostList) return;
    const key = selectedKey || 'r4';
    try {
      const r = await fetch(`/api/ghosts?game=${encodeURIComponent(key)}`, { cache: 'no-store' });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const data = await r.json();
      renderGhosts(data.ghosts || []);
    } catch {
      ghostList.innerHTML = '<span class="ghost-empty">Ghost service unavailable on this server.</span>';
    }
  };

  const stopGhostPlayback = () => {
    if (ghostVideo) {
      try { ghostVideo.pause(); } catch { /* ignore */ }
      ghostVideo.hidden = true;
      ghostVideo.removeAttribute('src');
    }
    if (ghostBadge) ghostBadge.hidden = true;
  };

  const startGhostPlayback = () => {
    if (!selectedGhost || !ghostVideo) return;
    stopGhostPlayback();
    ghostVideo.src = selectedGhost.url;
    ghostVideo.loop = true;
    ghostVideo.currentTime = 0;
    ghostVideo.hidden = false;
    ghostBadge.hidden = false;
    ghostVideo.play().catch(() => {});
  };

  const setGhostRecording = (on) => {
    if (!ghostBtn) return;
    ghostBtn.classList.toggle('recording', on);
    ghostBtn.innerHTML = on
      ? '<span class="btn-ico" aria-hidden="true">■</span> STOP GHOST'
      : '<span class="btn-ico" aria-hidden="true">●</span> REC GHOST';
  };

  const uploadGhost = async (blob) => {
    const key = selectedKey || state.game || 'r4';
    const fallback = `PLAYER ${new Date().toLocaleTimeString()}`;
    let name = fallback;
    try { name = (prompt('Name this LAN ghost:', localStorage.getItem('rr4.ghost.name') || fallback) || fallback).trim().slice(0, 48); } catch { /* ignore */ }
    try { localStorage.setItem('rr4.ghost.name', name); } catch { /* ignore */ }
    const r = await fetch(`/api/ghosts?game=${encodeURIComponent(key)}&name=${encodeURIComponent(name)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'video/webm' },
      body: blob,
    });
    if (!r.ok) throw new Error(`upload HTTP ${r.status}`);
    await loadGhosts();
  };

  const stopGhostRecording = () => {
    if (ghostTimer) { clearTimeout(ghostTimer); ghostTimer = null; }
    if (ghostRecorder && ghostRecorder.state !== 'inactive') {
      try { ghostRecorder.stop(); } catch { /* ignore */ }
    }
    setGhostRecording(false);
  };

  const startGhostRecording = async () => {
    if (ghostRecorder && ghostRecorder.state === 'recording') { stopGhostRecording(); return; }
    const canvas = document.querySelector('#game canvas');
    if (!navigator.mediaDevices?.getDisplayMedia) {
      setStatus('GHOST REC: OPEN LOCALHOST', 'error');
      return;
    }
    // Arm the recorder for the next boot too: preserveDrawingBuffer is a
    // context-creation attribute, so it can only be decided at load time.
    try { localStorage.setItem('rr4.ghost.rec', '1'); } catch { /* ignore */ }
    if (!canvas || !window.MediaRecorder || typeof canvas.captureStream !== 'function') {
      setStatus('GHOST REC UNAVAILABLE', 'error');
      return;
    }
    try {
      // Preferred: capture the tab. This records the actual rendered game
      // (EJS's WebGL canvas is black when captured directly after present).
      // Fallback: canvas -> video element -> MediaRecorder.
      let recordStream = null;
      try {
        recordStream = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: 30 }, audio: false });
        document.body.classList.add('ghost-recording');
      } catch {
        recordStream = null;
      }
      if (recordStream) {
        ghostStream = recordStream;
      } else {
        if (!preserveDrawingBuffer) {
          // Canvas capture is black without preserveDrawingBuffer, so say so
          // instead of uploading a black clip (BALANCED/PERF, or ?pb=0).
          setStatus('GHOST REC: USE TAB CAPTURE', 'error');
          return;
        }
        ghostStream = canvas.captureStream(30);
        ghostSourceVideo = document.createElement('video');
        ghostSourceVideo.className = 'ghost-source';
        ghostSourceVideo.muted = true;
        ghostSourceVideo.autoplay = true;
        ghostSourceVideo.playsInline = true;
        ghostSourceVideo.srcObject = ghostStream;
        document.querySelector('#game')?.appendChild(ghostSourceVideo);
        await ghostSourceVideo.play().catch(() => {});
        await new Promise((resolve) => {
          if (ghostSourceVideo.readyState >= 2) return resolve();
          const t = setTimeout(resolve, 1500);
          ghostSourceVideo.addEventListener('loadeddata', () => { clearTimeout(t); resolve(); }, { once: true });
        });
        await new Promise((r) => setTimeout(r, 1200));
        recordStream = ghostSourceVideo.captureStream(30);
      }
      const mime = MediaRecorder.isTypeSupported('video/webm;codecs=vp9')
        ? 'video/webm;codecs=vp9'
        : (MediaRecorder.isTypeSupported('video/webm;codecs=vp8') ? 'video/webm;codecs=vp8' : 'video/webm');
      ghostChunks = [];
      ghostRecorder = new MediaRecorder(recordStream, { mimeType: mime, videoBitsPerSecond: 2500000 });
      ghostRecorder.ondataavailable = (e) => { if (e.data && e.data.size) ghostChunks.push(e.data); };
      ghostRecorder.onstop = async () => {
        const blob = new Blob(ghostChunks, { type: 'video/webm' });
        ghostChunks = [];
        try { ghostStream?.getTracks().forEach((t) => t.stop()); } catch { /* ignore */ }
        try { ghostSourceVideo?.remove(); } catch { /* ignore */ }
        document.body.classList.remove('ghost-recording');
        ghostStream = null;
        ghostSourceVideo = null;
        ghostRecorder = null;
        if (blob.size < 1000) { setStatus('GHOST TOO SHORT', 'error'); return; }
        try {
          await uploadGhost(blob);
          setStatus('GHOST SAVED', 'running');
        } catch (e) {
          setStatus('GHOST UPLOAD FAILED', 'error');
          console.warn('[ghost] upload failed', e);
        }
      };
      ghostRecorder.start(1000);
      setGhostRecording(true);
      setStatus('RECORDING GHOST', 'running');
      ghostTimer = setTimeout(stopGhostRecording, 120000);
    } catch (e) {
      setGhostRecording(false);
      setStatus('GHOST REC FAILED', 'error');
      console.warn('[ghost] record failed', e);
    }
  };

  ghostBtn?.addEventListener('click', startGhostRecording);
  ghostRefresh?.addEventListener('click', loadGhosts);
  ghostClose?.addEventListener('click', stopGhostPlayback);
  ghostVideo?.addEventListener('ended', () => { stopGhostPlayback(); });

  const syncSetupParam = (visible) => {
    const url = new URL(location.href);
    if (visible) url.searchParams.set('setup', '1');
    else url.searchParams.delete('setup');
    if (url.toString() !== location.href) history.replaceState(null, '', url);
  };

  const showSetup = () => {
    if (!setupEl) return;
    setupEl.hidden = false;
    syncSetupParam(true);
    if (overlay) overlay.hidden = true;
    if (gameEl) gameEl.style.display = 'none';
    if (ejectBtn) ejectBtn.hidden = true;
    if (ghostBtn) ghostBtn.hidden = true;
    if (footRom && !selectedKey) footRom.textContent = '-';
    if (footTiming && !selectedKey) footTiming.textContent = '-';
    stopGhostPlayback();
    setStatus('NO DISC', 'loading');
  };

  const hideSetup = () => {
    if (setupEl) setupEl.hidden = true;
    // Booting straight from ?game= must not leave setup=1 behind: a reload
    // would otherwise open the disc deck instead of the running game.
    syncSetupParam(false);
    if (overlay) overlay.hidden = false;
    if (gameEl) gameEl.style.display = '';
    if (ejectBtn) ejectBtn.hidden = false;
    if (ghostBtn) ghostBtn.hidden = false;
  };

  const updatePads = () => {
    if (!setupPads) return;
    const pads = navigator.getGamepads ? [...navigator.getGamepads()].filter(Boolean) : [];
    setupPads.textContent = pads.length
      ? `CONTROLLERS: ${pads.length} connected - ${pads.map((p) => p.id.split('(')[0].trim()).join(', ')}`
      : 'CONTROLLERS: keyboard ready - connect a pad';
  };

  const startDisc = () => {
    if (!selectedKey) return;
    hideSetup();
    setStatus('LOADING EMULATOR...', 'loading');
    setOverlay(game.subtitle || game.name, 'Downloading disc image...', discMetaFor(game), 0);
    if (overlayBar) overlayBar.classList.add('indeterminate');
    probe().then((ok) => {
      if (ok) boot();
      else {
        showSetup();
        setStatus('NO DISC', 'error');
      }
    });
  };

  const ejectDisc = () => {
    stopGhostRecording();
    stopGhostPlayback();
    if (state.startedAt) {
      const key = selectedKey || state.game || gameKey;
      location.href = `/play?game=${encodeURIComponent(key)}&setup=1`;
      return;
    }
    clearTray();
  };

  renderDiscs();
  if (setupVolume) setupVolume.value = String(Math.round(getVolume() * 100));
  if (setupFullscreen) setupFullscreen.checked = getFullscreen();
  updatePads();
  window.addEventListener('gamepadconnected', updatePads);
  window.addEventListener('gamepaddisconnected', updatePads);
  setupStart?.addEventListener('click', startDisc);
  setupEject?.addEventListener('click', ejectDisc);
  ejectBtn?.addEventListener('click', ejectDisc);
  localDisc?.addEventListener('change', () => {
    const f = localDisc.files && localDisc.files[0];
    if (!f) return;
    game = {
      ...GAMES.r4,
      id: 7,
      local: true,
      name: f.name.replace(/\.[^.]+$/, ''),
      subtitle: f.name.replace(/\.[^.]+$/, '').toUpperCase(),
      region: 'LOCAL',
      rom: URL.createObjectURL(f),
      fallbackRom: '',
      cue: '',
      bytes: f.size,
      available: true,
    };
    selectDisc('local');
  });

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
    console.error('[r4]', message, detail || '');
  };

  // Presentation filters. "DLSS 5" is a real-time colour/contrast grade
  // inspired by the Visual Enhancer; the other choices are CSS overlays.
  // The grade is applied to #game only (the old code filtered #play-stage, so
  // every stage pixel - gradients, shadow, boot overlay - paid for it too).
  const filterSelect = $('#filterSelect');
  const FILTERS = ['dlss5', 'off', 'scanlines', 'crt', 'vignette', 'sharp'];
  let activeFilter = 'dlss5';
  let gameStarted = false;
  let dlss5Ready = false;
  // The enhancer is a CSS grade (and guest-video grade in netplay).
  // EJS's own GLSL shader path can black out the WebGL canvas, so it is not used.
  const DLSS5_FILTER = 'contrast(1.08) saturate(1.18) brightness(1.02)';
  const gradeBox = () => document.querySelector('#game');
  // PERFORMANCE drops the grade; the filtered layer is then gone entirely.
  const gradeAllowed = () => qualityTier !== 'perf';
  // data-filter is the truthful state of the CSS overlay layer. When the grade
  // is on it must read "dlss5" so the matching image-rendering rule fires (the
  // old code wrote "off", which made body[data-filter="dlss5"] dead CSS).
  const gradeAttr = () => (gradeAllowed() ? 'dlss5' : 'off');
  const setDlss5Stage = (on) => {
    const box = gradeBox();
    const want = !!on && gradeAllowed();
    if (box) box.style.filter = want ? DLSS5_FILTER : '';
    document.body.dataset.filter = want ? 'dlss5' : 'off';
  };
  const applyFilter = (value, persist) => {
    const v = FILTERS.includes(value) ? value : 'dlss5';
    activeFilter = v;
    if (v === 'dlss5') {
      if (gameStarted && dlss5Ready) setDlss5Stage(true);
      else {
        document.body.dataset.filter = gradeAttr();
        const box = gradeBox();
        if (box) box.style.filter = '';
      }
    } else {
      document.body.dataset.filter = v;
      const box = gradeBox();
      if (box) box.style.filter = '';
    }
    if (persist !== false) {
      try { localStorage.setItem('rr4.play.filter.v2', v); } catch { /* ignore */ }
    }
    if (filterSelect) filterSelect.value = v;
    if (setupFilter) setupFilter.value = v;
  };
  if (filterSelect) {
    let saved = 'dlss5';
    try { saved = localStorage.getItem('rr4.play.filter.v2') || 'dlss5'; } catch { /* ignore */ }
    applyFilter(saved, false);
    filterSelect.addEventListener('change', () => applyFilter(filterSelect.value));
  }
  setupFilter?.addEventListener('change', () => applyFilter(setupFilter.value));
  setupVolume?.addEventListener('input', () => {
    try { localStorage.setItem(VOLUME_KEY, String(Number(setupVolume.value) / 100)); } catch { /* ignore */ }
  });
  setupFullscreen?.addEventListener('change', () => {
    try { localStorage.setItem(FULLSCREEN_KEY, setupFullscreen.checked ? '1' : '0'); } catch { /* ignore */ }
  });

  // ---------------------------------------------------------------------
  // Quality presets: UI + application.
  // Core options are boot-time only, so a change after boot applies the CSS /
  // live part immediately and records that the core knobs need a reload.
  // Frameskip is the one core variable that is safe to set on a live core.
  // ---------------------------------------------------------------------
  const coreOptionsTable = () => {
    try { return String(window.EJS_emulator?.gameManager?.getCoreOptions?.() || ''); } catch { return ''; }
  };
  const coreOptionKnown = (id) => {
    const table = coreOptionsTable();
    if (table) return table.includes(id + '|');   // live table wins
    return KNOWN_CORE_OPTIONS.has(id);            // pre-boot: verified allowlist
  };
  // Merged into window.EJS_defaultOptions before the loader script is appended.
  const qualityCoreOptions = () => {
    const out = {};
    const dropped = [];
    for (const [id, value] of Object.entries(QUALITY_CORE_OPTIONS[qualityTier] || {})) {
      if (coreOptionKnown(id)) out[id] = value;
      else dropped.push(id);                      // never guess an option id
    }
    state.quality.coreOptions = out;
    state.quality.droppedCoreOptions = dropped;
    if (dropped.length) console.info('[r4] quality: core option(s) not in this build:', dropped.join(', '));
    return out;
  };
  const syncQualityUi = () => {
    const shown = qualityMode === 'auto' ? 'auto' : qualityTier;
    if (qualitySelect) qualitySelect.value = shown;
    if (setupQuality) setupQuality.value = shown;
    if (footQuality) {
      footQuality.textContent = `Q ${qualityTier.toUpperCase()}${qualityMode === 'auto' ? ' AUTO' : ''}`;
      footQuality.title = `Quality ${qualityTier} - ${qualityMode}${state.quality.why ? ' (' + state.quality.why + ')' : ''}. Core options apply on reload.`;
    }
    document.body.dataset.quality = qualityTier;
  };
  const applyQuality = (tier, why, live) => {
    if (!QUALITY_TIERS.includes(tier)) tier = 'balanced';
    qualityTier = tier;
    state.quality.tier = tier;
    state.quality.why = why || state.quality.why;
    state.quality.at = Math.round(performance.now());
    if (live) state.quality.needsReload = true;
    document.body.dataset.quality = tier;
    // The grade belongs to the tier (PERFORMANCE = off) and only to the
    // dlss5 choice; other filters own #game's overlay layers themselves.
    if (activeFilter === 'dlss5') setDlss5Stage(gameStarted && dlss5Ready);
    // Frameskip is live-safe; icache / context attributes are boot-time only.
    // changeSettingOption() updates EJS's settings store *and* the core
    // (menuOptionChanged -> gameManager.setVariable); setVariable() alone would
    // reach the core but leave getSettingValue()/the menu showing the old value.
    if (live && tier === 'perf' && window.EJS_emulator) {
      const em = window.EJS_emulator;
      const setOpt = (id, value) => {
        if (!coreOptionKnown(id)) return;
        if (typeof em.changeSettingOption === 'function') em.changeSettingOption(id, value);
        else em.gameManager.setVariable(id, value);
      };
      try {
        setOpt('pcsx_rearmed_frameskip_type', 'auto_threshold');
        setOpt('pcsx_rearmed_frameskip_threshold', '33');
        state.quality.liveCoreOptions = ['pcsx_rearmed_frameskip_type', 'pcsx_rearmed_frameskip_threshold'];
      } catch { /* core not ready / refused */ }
    }
    if (qualityMode === 'auto') {
      try { localStorage.setItem(QUALITY_KEY + '.autoTier', tier); } catch { /* ignore */ }
    }
    mark('quality', { mode: qualityMode, tier, why: state.quality.why, drops: state.quality.drops });
    syncQualityUi();
  };

  // AUTO: one 120-interval rAF window, ratchet down only, max two steps, 8 s
  // cooldown, never a reload and never an upgrade mid-session.
  const autoQuality = { window: 0, cooldown: 0, timer: null };
  const sampleFrameGaps = (n = 120) => new Promise((resolve) => {
    const gaps = [];
    let last = performance.now();
    const frame = (t) => {
      gaps.push(t - last);
      last = t;
      if (gaps.length < n) requestAnimationFrame(frame);
      else resolve(gaps.slice(1));
    };
    requestAnimationFrame(frame);
  });
  const startAutoQuality = () => {
    if (qualityMode !== 'auto' || autoQuality.timer) return;
    if (state.quality.drops >= 2 || qualityTier === 'perf' || autoQuality.window >= 6) return;
    autoQuality.timer = setTimeout(async () => {
      autoQuality.timer = null;
      if (qualityMode !== 'auto') return;
      autoQuality.window += 1;
      const gaps = (await sampleFrameGaps(120)).sort((a, b) => a - b);
      if (gaps.length > 10) {
        const p95 = gaps[Math.min(gaps.length - 1, Math.floor(gaps.length * 0.95))];
        const mean = gaps.reduce((a, b) => a + b, 0) / gaps.length;
        // Headless rAF is uncapped (~4 ms): only judge fps at display cadence.
        const capped = mean >= 8;
        const fps = mean > 0 ? 1000 / mean : 0;
        const bad = p95 > 25 || (capped && fps < 55);
        state.quality.sample = { window: autoQuality.window, p95: +p95.toFixed(1), fps: +fps.toFixed(0), capped, bad };
        mark('quality-sample', state.quality.sample);
        if (bad && state.quality.drops < 2 && performance.now() >= autoQuality.cooldown) {
          const idx = QUALITY_TIERS.indexOf(qualityTier);
          const next = QUALITY_TIERS[Math.min(QUALITY_TIERS.length - 1, idx + 1)];
          if (next && next !== qualityTier) {
            state.quality.drops += 1;
            autoQuality.cooldown = performance.now() + 8000;
            applyQuality(next, `auto: p95 ${p95.toFixed(1)} ms, ${fps.toFixed(0)} fps`, true);
          }
        }
      }
      startAutoQuality();
    }, 1000);
  };
  const setQualityMode = (value, persist) => {
    const v = validQuality(value) ? value : DEFAULT_TIER;
    qualityMode = v;
    if (persist !== false) {
      try { localStorage.setItem(QUALITY_KEY, v); } catch { /* ignore */ }
    }
    applyQuality(v === 'auto' ? DEFAULT_TIER : v, 'manual', !!state.startedAt);
    if (v === 'auto') startAutoQuality();
  };
  qualitySelect?.addEventListener('change', () => setQualityMode(qualitySelect.value));
  setupQuality?.addEventListener('change', () => setQualityMode(setupQuality.value));
  // Boot tier is reflected immediately: body[data-quality], the select and the
  // footer chip all show the tier that is actually in effect.
  document.body.dataset.quality = qualityTier;
  syncQualityUi();

  overlayTitle.textContent = game.subtitle;
  const brandGame = $('#brandGame');
  const brandLabel = {
    r4: 'RIDGE RACER <em>TYPE 4</em>',
    rage: 'RAGE <em>RACER</em>',
    ridge: 'RIDGE <em>RACER</em>',
  }[gameKey] || 'RIDGE RACER <em>TYPE 4</em>';
  if (brandGame) brandGame.innerHTML = brandLabel;
  document.title = `${game.name} // Native Browser`;
  if (overlayHint && game.bytes) {
    overlayHint.textContent = `${Math.round(game.bytes / 1048576)} MB - served from this machine`;
  }
  overlayKicker.textContent = game.available ? 'NATIVE - NO STREAM' : 'ROM PENDING';
  footRom.textContent = decodeURIComponent(game.rom).split('/').pop();
  footCore.textContent = debug ? 'pcsx_rearmed (debug)' : 'pcsx_rearmed';

  // Game picker
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
      if (setupEl && !setupEl.hidden) {
        selectDisc(select.value);
        return;
      }
      const url = new URL(location.href);
      url.searchParams.set('game', select.value);
      url.searchParams.set('autostart', '1');
      location.href = url.toString();
    });
  }

  // ---------------------------------------------------------------------
  // Fullscreen (button, floating exit, F shortcut)
  // ---------------------------------------------------------------------
  const fsSupported = typeof document.documentElement.requestFullscreen === 'function';
  const setFsUi = (on) => {
    document.body.classList.toggle('fs', on);
    if (fsExit) fsExit.hidden = !on;
    if (fsBtn) {
      fsBtn.setAttribute('aria-pressed', on ? 'true' : 'false');
      fsBtn.innerHTML = `<span class="btn-ico" aria-hidden="true">⛶</span> ${on ? 'EXIT FULLSCREEN' : 'FULLSCREEN'}`;
    }
    state.fs = on;
    mark('fullscreen', { on });
    // EmulatorJS sizes the canvas from the parent box; nudge it after the
    // layout switch so the game fills the viewport.
    setTimeout(() => {
      try { window.EJS_emulator?.handleResize?.(); } catch { /* ignore */ }
      syncStageBox('fullscreen');
    }, 120);
  };

  // The backing store follows the CSS box 1:1 in CSS pixels (measured in
  // 01-core-perf §1.5), so the 1280x960 fullscreen cap in play.css *is* the
  // resolution cap. Record what the browser actually chose - so the bench and
  // the docs can assert it - and re-nudge EJS after a resize. canvas.width is
  // never written here: the core glue owns it and fighting it loops.
  let stageBoxTimer = null;
  const syncStageBox = (why) => {
    const c = document.querySelector('#game canvas');
    if (!c) return;
    const r = c.getBoundingClientRect();
    const next = {
      why: why || 'sync',
      tier: qualityTier,
      fs: !!state.fs,
      capPx: FULLSCREEN_CAP_PX,
      cssW: Math.round(r.width),
      cssH: Math.round(r.height),
      backingW: c.width,
      backingH: c.height,
    };
    const prev = state.box;
    state.box = next;
    if (!prev || prev.cssW !== next.cssW || prev.cssH !== next.cssH ||
        prev.backingW !== next.backingW || prev.backingH !== next.backingH) {
      mark('stage-box', next);
    }
  };
  window.addEventListener('resize', () => {
    clearTimeout(stageBoxTimer);
    stageBoxTimer = setTimeout(() => {
      try { window.EJS_emulator?.handleResize?.(); } catch { /* ignore */ }
      syncStageBox('resize');
    }, 250);
  });

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
  // Click-to-race / audio unlock gate. EJS_startOnLoaded starts the video,
  // but WebAudio stays suspended until a user gesture on most browsers.
  // ---------------------------------------------------------------------
  let gateTimer = null;
  const hideGate = () => {
    if (gateTimer) { clearTimeout(gateTimer); gateTimer = null; }
    if (soundGate) soundGate.hidden = true;
  };

  // Keyboard/gamepad events must land on the emulator canvas, not on the
  // dismissed gate button. Clicking the canvas worked; focus it explicitly.
  const focusGame = () => {
    const canvas = document.querySelector('#game canvas');
    if (canvas) {
      canvas.tabIndex = 0;
      try { canvas.focus({ preventScroll: true }); } catch { try { canvas.focus(); } catch { /* ignore */ } }
    }
  };

  // EmulatorJS auto-assigns pads only on its 'connected' event. Pads already
  // present before the emulator boots can stay "Not Connected"; fill any empty
  // player slot with a detected pad, matching EJS's own assignment format.
  const autoAssignPads = () => {
    const em = window.EJS_emulator;
    const gp = em && em.gamepad;
    const sel = em && em.gamepadSelection;
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
      try { em.updateGamepadLabels(); } catch { /* ignore */ }
      try { em.gamepad.emit('gamepadselected', sel); } catch { /* ignore */ }
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
  const audioContext = () => {
    const em = window.EJS_emulator;
    const al = em?.Module?.AL?.currentCtx;
    return al?.audioCtx || em?.Module?.SDL2?.audioContext || em?.audioContext || null;
  };
  const unlockAudio = async () => {
    const em = window.EJS_emulator;
    try { if (em && em.paused) em.play(); } catch { /* ignore */ }
    try {
      const ctx = audioContext();
      if (ctx && ctx.state === 'suspended') await ctx.resume();
    } catch { /* ignore */ }
    // Restore the stored/default level instead of a hard-coded 0.7: a stored 0
    // must stay 0, and a fresh profile must not be forced to anything else.
    try { if (em && em.muted) em.setVolume(getVolume()); } catch { /* ignore */ }
    if (!state.audioUnlocked) {
      state.audioUnlocked = true;
      mark('audio-unlock', { ctx: audioContext()?.state || 'n/a', volume: getVolume() });
    }
    hideGate();
    focusGame();
  };
  // Keyboard-only and pad-only players must not stay muted (the old code only
  // unlocked on pointer/gate clicks). Throttled so a held key cannot spam
  // focusGame()/setVolume().
  let lastUnlockTry = 0;
  const gestureUnlock = () => {
    if (!state.startedAt) return;
    const ctx = audioContext();
    if (state.audioUnlocked && (!ctx || ctx.state === 'running')) return;
    const now = performance.now();
    if (now - lastUnlockTry < 500) return;
    lastUnlockTry = now;
    unlockAudio();
  };
  // EJS has no gamepad gesture hook of its own; poll cheaply for the first
  // button press after boot (and stop after a minute or on the first press).
  let padUnlockTimer = null;
  const watchFirstPadPress = () => {
    if (padUnlockTimer || typeof navigator.getGamepads !== 'function') return;
    padUnlockTimer = setInterval(() => {
      const pads = [...(navigator.getGamepads() || [])].filter(Boolean);
      const pressed = pads.some((p) => (p.buttons || []).some((b) => b && (b.pressed || b.value > 0.4)));
      if (!pressed) return;
      clearInterval(padUnlockTimer);
      padUnlockTimer = null;
      gestureUnlock();
    }, 250);
    setTimeout(() => {
      if (padUnlockTimer) { clearInterval(padUnlockTimer); padUnlockTimer = null; }
    }, 60000);
  };
  const showGate = () => {
    if (!soundGate || state.audioUnlocked) return;
    // Embedded in the shell: the parent ENTER click already granted audio, so
    // keep the stage clean and unlock silently on the first interaction.
    if (embedded) { hideGate(); return; }
    // If the core already has a running AudioContext, the gate is pointless.
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
    if (['Shift', 'Control', 'Alt', 'Meta', 'Tab'].includes(e.key)) return;
    gestureUnlock();
  }, true);
  document.addEventListener('pointerdown', (e) => {
    if (soundGate && !soundGate.hidden) return; // the gate's own click handles it
    if (state.startedAt) unlockAudio();
  }, { capture: true, passive: true });
  window.addEventListener('gamepadconnected', () => { watchFirstPadPress(); gestureUnlock(); });

  // ---------------------------------------------------------------------
  // Footer: always report the disc image, never the 0.5 MB BIOS.
  // ---------------------------------------------------------------------
  const updateFooter = () => {
    if (!footTiming) return;
    const romRec = state.rom && state.rom.loaded > 1048576 ? state.rom : null;
    const totalBytes = game.bytes || romRec?.total || 0;
    const mb = totalBytes ? (totalBytes / 1048576).toFixed(0) : (romRec?.mb ?? null);
    const boot = state.bootMs != null ? ` · boot ${(state.bootMs / 1000).toFixed(1)}s` : '';
    if (romRec) {
      footTiming.textContent = `ROM ${mb} MB in ${(romRec.ms / 1000).toFixed(1)}s${boot}`;
    } else if (mb) {
      footTiming.textContent = `ROM ${mb} MB · cached${boot}`;
    } else {
      footTiming.textContent = '—';
    }
  };

  // WebGL context policy (measured: _runtime/analysis/01-core-perf.md §2.1).
  // EJS asks for alpha:true + premultipliedAlpha:true, so the compositor blends
  // the whole canvas every frame even though the game is opaque. And
  // preserveDrawingBuffer is only needed for canvas capture (REC GHOST); it
  // costs a full-buffer copy on every present, so it is gated rather than
  // forced on every context. ?pb=1 / ?pb=0 force the old/new behaviour.
  (() => {
    const orig = HTMLCanvasElement.prototype.getContext;
    if (!orig) return;
    HTMLCanvasElement.prototype.getContext = function (type, attrs) {
      if (type === 'webgl' || type === 'webgl2' || type === 'experimental-webgl') {
        attrs = Object.assign({}, attrs || {}, {
          alpha: false,
          premultipliedAlpha: false,
          preserveDrawingBuffer,
        });
        state.context = {
          alpha: false,
          premultipliedAlpha: false,
          preserveDrawingBuffer,
          forced: pbParam === '1' || pbParam === '0',
          tier: qualityTier,
        };
      }
      return orig.call(this, type, attrs);
    };
  })();

  // Zero-CDN shim: EmulatorJS checks cdn.emulatorjs.org for updates on ready.
  // Serve that check from the self-hosted data folder instead.
  const nativeFetch = window.fetch.bind(window);
  window.fetch = (input, init) => {
    const raw = typeof input === 'string' ? input : (input && input.url) || '';
    const m = /^https?:\/\/cdn\.emulatorjs\.org\/[^/]+\/data\/(.*)$/.exec(raw);
    if (m) return nativeFetch('/emulator/data/' + m[1], init);
    return nativeFetch(input, init);
  };

  // Instrument XHR so we can report real ROM transfer timing. EmulatorJS also
  // GETs the BIOS (*.bin) through the same path, so keep every transfer and
  // surface the largest one as "the ROM".
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

  // Mirror EmulatorJS's own loading text into the overlay + progress bar.
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
        if (!label) label = 'Working…';
        if (mb) label = `${label} ${mb[1]} MB`;
        setOverlay(null, label, pct ? `${pct[1]}%` : overlayHint.textContent, pct ? Number(pct[1]) : undefined);
        if (overlayBar && !pct) overlayBar.classList.add('indeterminate');
      }
    }
    if (err && err.innerText) {
      const msg = err.innerText.trim();
      if (msg && !state.errors.some(e => e.message === msg)) showError(msg, 'EmulatorJS reported an error');
    }
    if (state.startedAt) {
      clearInterval(pollTimer);
      pollTimer = null;
    }
  };

  // ---------------------------------------------------------------------
  // ROM presence probe before booting (keeps Rage Racer a clean placeholder).
  // ---------------------------------------------------------------------
  const probeUrl = async (url) => {
    // A 1-byte Range GET doubles as a Range-support check and avoids the
    // ERR_ABORTED noise Chrome reports for an unconsumed HEAD response.
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
        // CHD missing? Fall back to the raw BIN transparently.
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
        setOverlay(null, 'Downloading disc image…', `${(r.len / 1048576).toFixed(0)} MB · served from this machine`, 0);
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
  // Persistent storage (P6). One request, after the first successful boot, so
  // the cached disc image in IndexedDB is less likely to be evicted. Secure
  // contexts only: plain-HTTP LAN has no navigator.storage.persist(), and this
  // must never throw or block the game.
  // ---------------------------------------------------------------------
  let persistAsked = false;
  const requestPersistentStorage = async () => {
    if (persistAsked) return;
    persistAsked = true;
    const log = (extra) => mark('storage-persist', { secure: !!window.isSecureContext, ...extra });
    if (!window.isSecureContext || !navigator.storage || !navigator.storage.persist) {
      log({ persisted: null, why: window.isSecureContext ? 'no-api' : 'insecure-origin' });
      return;
    }
    try {
      const already = navigator.storage.persisted ? await navigator.storage.persisted() : false;
      const granted = already === true ? true : await navigator.storage.persist();
      state.persisted = granted;
      log({ persisted: granted, already });
      console.info('[r4] storage.persist() ->', granted, already ? '(already granted)' : '');
    } catch (e) {
      log({ persisted: null, error: e && e.message ? e.message : String(e) });
    }
  };

  // ---------------------------------------------------------------------
  // Boot
  // ---------------------------------------------------------------------
  const boot = () => {
    const romName = decodeURIComponent(game.rom).split('/').pop();
    const useCueFile = cueMode === 'file' && /\.bin$/i.test(game.rom);
    // Core-option policy for the resolved tier. loader.js reads
    // window.EJS_defaultOptions once (config.defaultOptions = ...), and
    // emulator.js applies it after Module.callMain(), so the keys must be the
    // core's real option ids. Unknown ids are dropped, never guessed.
    const qualityOptions = qualityCoreOptions();
    window.EJS_defaultOptions = { ...qualityOptions };
    window.EJS_player = '#game';
    window.EJS_core = 'psx';                     // -> pcsx_rearmed
    window.EJS_gameUrl = useCueFile ? game.cue : game.rom;
    if (useCueFile) {
      // Boot the real MODE2/2352 cue sheet; the BIN is preloaded into the
      // emulator FS under the exact name the cue references.
      window.EJS_externalFiles = { ['/' + romName]: game.rom };
    }
    window.EJS_pathtodata = '/emulator/data/';
    window.EJS_gameName = game.name;
    window.EJS_gameID = game.id;
    window.EJS_biosUrl = biosUrl;
    window.EJS_startOnLoaded = true;
    window.EJS_language = 'en-US';
    window.EJS_disableAutoLang = false;
    window.EJS_color = '#e10600';
    window.EJS_volume = getVolume();
    window.EJS_fullscreenOnLoaded = getFullscreen();
    // auto (default): let EmulatorJS generate a cue sheet for the single-track
    // BIN. direct: hand the raw BIN to the core. file: use the real .cue.
    window.EJS_disableCue = cueMode === 'direct';
    // Cache the disc image in IndexedDB after the first download so a LAN
    // player does not re-download 621 MB on every visit. EmulatorJS 4.2.3
    // reads EJS_CacheLimit (default 1 GiB); EJS_cacheConfig is kept for
    // forward compatibility with newer loaders.
    window.EJS_CacheLimit = 1073741824;
    window.EJS_cacheConfig = {
      enabled: true,
      cacheMaxSizeMB: 4096,
      cacheMaxAgeMins: 10080,
    };
    window.EJS_threads = useThreads;
    window.EJS_disableDatabases = false;
    if (debug) window.EJS_DEBUG_XX = true;

    window.EJS_ready = () => {
      state.readyAt = performance.now();
      mark('ready');
      setStatus('CORE READY', 'loading');
      setOverlay(null, 'Starting game…', null, 96);
    };

    window.EJS_onGameStart = () => {
      mark('start');
      // Race Day HUD: announce the first real frame instead of polling __R4.
      try { window.dispatchEvent(new CustomEvent('rr4:started', { detail: { at: Date.now() } })); } catch { /* ignore */ }
      setStatus('RUNNING', 'running');
      hideOverlay();
      const canvas = document.querySelector('#game canvas');
      if (canvas) {
        state.canvas = { width: canvas.width, height: canvas.height, cssW: canvas.clientWidth, cssH: canvas.clientHeight };
      }
      focusGame();
      watchFirstPadPress();
      requestPersistentStorage();
      syncStageBox('start');
      if (qualityMode === 'auto') startAutoQuality();
      if (selectedGhost) startGhostPlayback();
      setTimeout(autoAssignPads, 600);
      setTimeout(() => { gameStarted = true; }, 700);
      setTimeout(() => { if (!dlss5Ready) activateDlss5(); }, 8000);
      setTimeout(() => { if (audioContext()?.state === 'running') { state.audioUnlocked = true; hideGate(); } }, 700);
      // Browser-side truth for the disc transfer (independent of the XHR hook).
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
      if (footTiming && state.rom && state.rom.ms != null) {
        updateFooter();
      }
      // Offer the gesture that unlocks WebAudio (auto-hides; never blocks play).
      setTimeout(showGate, 600);
      updateFooter();
    };

    mark('loader-request');
    const s = document.createElement('script');
    s.src = '/emulator/data/loader.js';
    s.async = true;
    s.onload = () => mark('loader-loaded');
    s.onerror = () => showError('EmulatorJS loader failed to load', '/emulator/data/loader.js');
    document.head.appendChild(s);

    pollTimer = setInterval(poll, 400);
    mark('boot-config', {
      bios: biosUrl || 'HLE',
      cue: cueMode,
      threads: useThreads,
      quality: qualityMode,
      tier: qualityTier,
      coreOptions: qualityOptions,
      droppedCoreOptions: state.quality.droppedCoreOptions,
      pb: preserveDrawingBuffer,
      alpha: false,
      fullscreenCapPx: FULLSCREEN_CAP_PX,
    });
  };

  // Keep uncaught errors visible in the overlay instead of a silent black box.
  window.addEventListener('error', (e) => {
    const msg = e && e.message ? e.message : 'Script error';
    if (!/ResizeObserver/.test(msg)) state.errors.push({ message: msg, source: e.filename, line: e.lineno });
  });
  window.addEventListener('unhandledrejection', (e) => {
    const r = e && e.reason;
    state.errors.push({ message: 'unhandledrejection: ' + (r && r.message ? r.message : String(r)) });
  });

  // ---------------------------------------------------------------------
  // Race Day HUD (?mmo=1). The stylesheet and the ESM module are fetched only
  // when the flag is present; the module owns the overlay, the telemetry reader
  // and the /mmo socket, and play.js only hands it the parsed params.
  // ---------------------------------------------------------------------
  if (mmoOn) {
    const hudCss = document.createElement('link');
    hudCss.rel = 'stylesheet';
    hudCss.id = 'mmoHudCss';
    hudCss.href = '/css/mmo-hud.css';
    document.head.appendChild(hudCss);
    import('/js/mmo-hud.js').then((mod) => {
      if (!mod || typeof mod.mountMmoHud !== 'function') return;
      state.mmo.hud = mod.mountMmoHud(null, {
        event: mmoParams.event,
        seat: mmoParams.seat,
        team: mmoParams.team,
      });
      mark('mmo-hud', { event: mmoParams.event, seat: mmoParams.seat, team: mmoParams.team });
    }).catch((err) => {
      state.errors.push({ message: 'mmo-hud: ' + (err && err.message ? err.message : String(err)) });
      console.warn('[r4] mmo-hud failed', err);
    });
  }

  if (startImmediately) {
    selectedKey = gameKey;
    selectDisc(gameKey);
    hideSetup();
    probe().then((ok) => { if (ok) boot(); else showSetup(); });
  } else {
    showSetup();
    if (qs.get('game')) selectDisc(gameKey);
  }
})();

