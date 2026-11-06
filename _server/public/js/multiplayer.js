/* R4 2P head-to-head lobby.
 * Rooms live on the cabinet's /mp websocket. Both players ready -> server
 * rolls a track + cars -> this page hands the roles to the shell, which loads
 * the EmulatorJS 4.3 netplay page for the actual race.
 */

(() => {
  const $ = (s) => document.querySelector(s);
  const nameEl = $('#mName');
  const codeEl = $('#mCode');
  const createEl = $('#mCreate');
  const joinEl = $('#mJoin');
  const refreshEl = $('#mRefresh');
  const roomsEl = $('#mRooms');
  const roomEl = $('#mRoom');
  const roomCodeEl = $('#mRoomCode');
  const inviteEl = $('#mInvite');
  const copyEl = $('#mCopy');
  const leaveEl = $('#mLeave');
  const readyEl = $('#mReady');
  const trackEl = $('#mTrack');
  const carsEl = $('#mCars');
  const raceEl = $('#mRace');
  const raceTrackEl = $('#mRaceTrack');
  const raceCarsEl = $('#mRaceCars');
  const raceKickerEl = $('#mRaceKicker');
  const countEl = $('#mCount');
  const gameEl = $('#mGame');
  const gameHintEl = $('#mGameHint');
  const roomGameEl = $('#mRoomGame');
  const roomGameSelEl = $('#mRoomGameSel');
  const driveEl = $('#mDrive');
  const driveFieldEl = $('#mDriveField');
  const roomDriveRowEl = $('#mRoomDriveRow');
  const roomDriveEl = $('#mRoomDrive');
  const roomDriveSelEl = $('#mRoomDriveSel');
  const roomTurnEl = $('#mRoomTurn');
  const turnNowEl = $('#mTurnNow');
  const turnSelEl = $('#mTurnSel');

  // Error/status line next to READY. Built here rather than in the HTML so a
  // failed join/reconnect keeps the room card on screen with a recoverable
  // message plus a RETRY path.
  const statusEl = document.createElement('p');
  statusEl.id = 'mStatus';
  statusEl.className = 'mempty';
  statusEl.hidden = true;
  statusEl.setAttribute('role', 'status');
  statusEl.setAttribute('aria-live', 'polite');
  const statusTextEl = document.createElement('span');
  const retryEl = document.createElement('button');
  retryEl.type = 'button';
  retryEl.className = 'mlinkbtn';
  retryEl.textContent = 'RETRY';
  retryEl.hidden = true;
  statusEl.append(statusTextEl, retryEl);
  statusEl.style.flexBasis = '100%';

  const TEAMS = ['Solvalou', 'Pac Racing Club', 'Micro Mouse Mappy', 'Dig Racing Team'];
  const params = new URLSearchParams(location.search);
  const storedName = (() => {
    try { return localStorage.getItem('rr4.mp.name') || ''; } catch { return ''; }
  })();

  // ---- discs -------------------------------------------------------------
  // `/mp-games.json` is the single source of truth (served straight from
  // _server/public). Fetched once at boot; the tiny inline fallback below only
  // keeps the lounge usable when that fetch fails.
  const MP_GAMES_FALLBACK = {
    r4: {
      key: 'r4', name: 'Ridge Racer Type 4', short: 'R4',
      mode: 'versus', modeLabel: 'VS BATTLE',
      seatsLabel: 'Split screen - one car per driver',
    },
    rage: {
      key: 'rage', name: 'Rage Racer', short: 'RAGE',
      mode: 'shared-car', modeLabel: 'SHARED CAR',
      seatsLabel: 'One car - both pads drive it',
    },
    ridge: {
      key: 'ridge', name: 'Ridge Racer', short: 'RIDGE',
      mode: 'shared-car', modeLabel: 'SHARED CAR',
      seatsLabel: 'One car - both pads drive it',
    },
  };
  let games = MP_GAMES_FALLBACK;
  let defaultGameKey = 'r4';
  let gamePicked = false;

  // Deep link wins, then the last choice, then the project default.
  const requestedGame = String(params.get('game') || '').trim().toLowerCase();
  const storedGame = (() => {
    try { return localStorage.getItem('rr4.mp.game') || ''; } catch { return ''; }
  })();

  function gameKeys() {
    return Object.keys(games).filter((k) => games[k] && typeof games[k] === 'object');
  }

  // Never trust a key that is not in the manifest; unknown keys fall back to
  // the manifest default (the server does the same).
  function normaliseGame(key) {
    const wanted = String(key || '').trim().toLowerCase();
    const keys = gameKeys();
    if (keys.includes(wanted)) return wanted;
    if (keys.includes(defaultGameKey)) return defaultGameKey;
    return keys[0] || 'r4';
  }

  function gameEntry(key) {
    return games[normaliseGame(key)] || MP_GAMES_FALLBACK.r4;
  }

  function fillGameOptions(select, selected) {
    if (!select) return normaliseGame(selected);
    const key = normaliseGame(selected);
    select.innerHTML = '';
    for (const k of gameKeys()) {
      const g = games[k];
      const o = document.createElement('option');
      o.value = k;
      o.textContent = `${String(g.short || k).toUpperCase()} // ${String(g.name || k).toUpperCase()}`;
      select.appendChild(o);
    }
    select.value = key;
    return key;
  }

  // ---- drive mode (Route A: live shared car vs ghost turn-based time trial) --
  // `live` is the untouched shared-car mode (both pads drive one car). `ghost`
  // is one driver per run on the host core; the run you finish becomes the
  // other seat's replay. R4 keeps today's VS Battle and never sends a drive.
  const DRIVE_LABEL = { live: 'LIVE', ghost: 'GHOST' };
  const TURN_LABEL = { host: 'HOST', guest: 'GUEST' };
  const DRIVE_HINT_GHOST = "GHOST · TURN-BASED TIME TRIAL - THE RUN YOU FINISH BECOMES THE OTHER'S GHOST";

  function normaliseDrive(value) {
    return String(value || '').trim().toLowerCase() === 'ghost' ? 'ghost' : 'live';
  }

  function normaliseTurn(value) {
    return String(value || '').trim().toLowerCase() === 'guest' ? 'guest' : 'host';
  }

  // Ghost/one-car modes only exist on the shared-car discs; R4 is two cars.
  function driveSupported(key) {
    return gameEntry(key).mode === 'shared-car';
  }

  function renderGameHint() {
    if (!gameHintEl) return;
    const g = gameEntry(localGame);
    if (g.mode === 'shared-car' && localDrive === 'ghost') {
      gameHintEl.textContent = DRIVE_HINT_GHOST;
      return;
    }
    gameHintEl.textContent = `${g.modeLabel || 'MODE'} · ${g.seatsLabel || 'Two seats, one room'}`;
  }

  function persistGame(key) {
    try { localStorage.setItem('rr4.mp.game', key); } catch { /* ignore */ }
  }

  function persistDrive(mode) {
    try { localStorage.setItem('rr4.mp.drive', normaliseDrive(mode)); } catch { /* ignore */ }
  }

  // Start-card segmented control: LIVE | GHOST. Ghost is only selectable on a
  // shared-car disc, so R4 shows the control disabled with LIVE active.
  function renderDriveControls() {
    const supported = driveSupported(currentGame());
    if (driveEl) {
      const shown = supported ? localDrive : 'live';
      for (const btn of driveEl.querySelectorAll('[data-drive]')) {
        const on = btn.dataset.drive === shown;
        btn.setAttribute('aria-pressed', String(on));
        btn.classList.toggle('is-on', on);
        btn.disabled = !supported || !!room;
        btn.title = supported
          ? (room ? 'This room already has a drive. LEAVE to start another.' : '')
          : 'Ghost is a shared-car disc mode: choose Rage Racer or Ridge Racer 1994.';
      }
    }
    if (driveFieldEl) {
      driveFieldEl.classList.toggle('is-off', !supported);
      driveFieldEl.title = supported ? '' : 'R4 is two cars (VS Battle) - ghost needs Rage or Ridge.';
    }
    renderGameHint();
  }

  function setLocalGame(key, persist) {
    localGame = normaliseGame(key);
    if (gameEl) gameEl.value = localGame;
    renderDriveControls();
    if (persist) persistGame(localGame);
    return localGame;
  }

  function setLocalDrive(mode, persist) {
    localDrive = normaliseDrive(mode);
    if (persist) persistDrive(localDrive);
    renderDriveControls();
    return localDrive;
  }

  // The start selector is the source of that screen's choice; a selection
  // made without a change event (autofill, restored form state) still counts.
  function currentGame() {
    if (gameEl && gameEl.value) localGame = normaliseGame(gameEl.value);
    return localGame;
  }

  async function loadGames() {
    try {
      const res = await fetch('/mp-games.json', { headers: { accept: 'application/json' } });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      const list = data && data.games;
      if (!list || typeof list !== 'object') throw new Error('bad manifest');
      const next = {};
      for (const k of Object.keys(list)) {
        const g = list[k];
        if (!g || typeof g !== 'object') continue;
        next[k] = { ...g, key: g.key || k };
      }
      if (!Object.keys(next).length) throw new Error('empty manifest');
      games = next;
      defaultGameKey = data.defaultGame && next[data.defaultGame] ? data.defaultGame : 'r4';
      // Re-resolve the current choice against the manifest (fetch order: r4,
      // rage, ridge) and repaint whatever is already on screen.
      fillGameOptions(gameEl, gamePicked ? localGame : requestedGame || localGame);
      setLocalGame(gamePicked ? localGame : requestedGame || localGame, false);
      if (roomGameSelEl) fillGameOptions(roomGameSelEl, room ? room.game : localGame);
      if (room) renderRoom(room);
    } catch {
      /* keep the inline fallback; the page still works */
    }
  }

  let localGame = normaliseGame(requestedGame || storedGame || defaultGameKey);

  // Drive/turn mirror `game`: a rematch deep link wins, then the last choice,
  // then `live`/`host`. A ghost pick is remembered across discs but only takes
  // effect on a shared-car disc.
  const requestedDrive = String(params.get('drive') || '').trim().toLowerCase();
  const storedDrive = (() => {
    try { return localStorage.getItem('rr4.mp.drive') || ''; } catch { return ''; }
  })();
  let localDrive = normaliseDrive(requestedDrive || storedDrive || 'live');
  // `?turn=` is a rematch hint for the host's create. Once a room answers, the
  // room's turn wins; with no `turn` in the URL the lounge keeps the room's.
  const requestedTurn = params.has('turn') ? normaliseTurn(params.get('turn')) : '';
  let localTurn = requestedTurn || 'host';

  let ws = null;
  let myId = null;
  let myRole = null;
  let room = null;
  let ready = false;
  let listTimer = 0;
  let reconnectTimer = 0;
  let countTimer = 0;
  let raceStarted = false;
  let autoJoinTried = false;
  // Room code to re-join after a dropped socket. Kept separate from `room`
  // so the stale room plan can be cleared without losing the re-sync target.
  let rejoinCode = '';

  nameEl.value = storedName || 'PLAYER';
  if (params.get('room')) codeEl.value = params.get('room').toUpperCase().slice(0, 4);

  // Rematch URL: /multiplayer?room=CODE&host=1 (host) or &host=0 (guest). The
  // host creates the same code again; the guest retries until that room exists.
  const urlRoom = (() => {
    const raw = (params.get('room') || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 4);
    return raw.length === 4 ? raw : '';
  })();
  const urlHost = params.get('host') === '1';
  let autoRoomTimer = 0;
  let autoRoomTries = 0;
  let autoRoomPending = false;

  function stopAutoRoom() {
    if (autoRoomTimer) { clearInterval(autoRoomTimer); autoRoomTimer = 0; }
    autoRoomPending = false;
    if (/^WAITING FOR HOST/.test(statusTextEl.textContent || '')) clearStatus();
  }

  function startAutoRoom() {
    if (!urlRoom || room || autoRoomTimer) return;
    autoRoomPending = true;
    autoRoomTries = 0;
    const tick = () => {
      if (room) { stopAutoRoom(); return; }
      if (autoRoomTries >= 30) {
        stopAutoRoom();
        setStatus(`Room ${urlRoom} not found - ask the host to open the rematch, then RETRY.`, { retry: true });
        return;
      }
      autoRoomTries += 1;
      send({ type: 'join', name: playerName(), code: urlRoom });
    };
    tick();
    autoRoomTimer = setInterval(tick, 2000);
  }

  function wsUrl() {
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    return `${proto}//${location.host}/mp`;
  }

  function send(message) {
    try {
      if (ws && ws.readyState === 1) ws.send(JSON.stringify(message));
    } catch { /* ignore */ }
  }

  function toast(text) {
    // The lobby uses the status area rather than a transient toast.
    const el = $('#mRooms');
    if (el) {
      const p = document.createElement('p');
      p.className = 'mempty';
      p.textContent = text;
      el.prepend(p);
    }
  }

  function setStatus(text, options = {}) {
    const value = String(text || '');
    statusTextEl.textContent = value;
    statusEl.hidden = !value;
    statusEl.style.color = options.tone === 'ok' ? 'var(--m-ok)' : 'var(--m-yellow)';
    retryEl.hidden = !(value && options.retry);
  }

  function clearStatus() {
    setStatus('');
  }

  // Server 'error' messages must stay readable: while the room card is on
  // screen keep it and show the message next to READY with a RETRY button.
  function showError(message) {
    const text = String(message || 'Lobby error');
    if (!roomEl.hidden) setStatus(text, { retry: true });
    else toast(text);
  }

  function retryRoom() {
    clearStatus();
    if (room) send({ type: 'join', name: playerName(), code: room.code });
    else if (rejoinCode) send({ type: 'join', name: playerName(), code: rejoinCode });
    else send({ type: 'list' });
  }

  // CREATE ROOM only applies to the start screen; leave the current room first.
  function syncStartControls() {
    createEl.disabled = !!room;
    createEl.title = room ? 'LEAVE the room before creating another.' : '';
    if (gameEl) {
      // The disc is chosen when the room is created; change it from the room
      // card (host only) while the lobby is still open.
      gameEl.disabled = !!room;
      gameEl.title = room ? 'This room already has a disc. LEAVE to start another.' : '';
    }
    renderDriveControls();
  }

  // Keep the status line visible: beside the start controls while looking for
  // a room, next to READY once the room card is on screen.
  function placeStatus() {
    const host = roomEl.hidden ? $('#mStart') : roomEl;
    if (host && statusEl.parentElement !== host) host.appendChild(statusEl);
  }

  function playerName() {
    const n = String(nameEl.value || '').trim().slice(0, 20) || 'PLAYER';
    nameEl.value = n;
    try { localStorage.setItem('rr4.mp.name', n); } catch { /* ignore */ }
    return n;
  }

  function renderRooms(list) {
    if (room) return;
    roomsEl.innerHTML = '';
    const entries = Array.isArray(list) ? list : [];
    if (!entries.length) {
      const p = document.createElement('p');
      p.className = 'mempty';
      p.textContent = 'No open rooms. Create one, or ask the host for the code.';
      roomsEl.appendChild(p);
      return;
    }
    for (const r of entries) {
      const row = document.createElement('div');
      row.className = 'mroom-row';
      const code = document.createElement('span');
      code.className = 'mroom-code';
      code.textContent = r.code;
      const host = document.createElement('span');
      host.className = 'mroom-host';
      host.textContent = `HOST: ${r.host || 'PLAYER'}`;
      const count = document.createElement('span');
      count.className = 'mroom-count';
      count.textContent = `${r.players || 1}/${r.max || 2}`;
      // The room's disc is decided by the host; show it so a guest knows what
      // they are joining (absent on an older cabinet).
      const roomGame = r.game && games[String(r.game)] ? games[String(r.game)] : null;
      const disc = document.createElement('span');
      if (roomGame) {
        disc.className = 'mroom-game';
        disc.textContent = String(roomGame.short || roomGame.key || r.game).toUpperCase();
      }
      const join = document.createElement('button');
      join.className = 'mbtn';
      join.type = 'button';
      join.textContent = 'JOIN';
      join.addEventListener('click', () => joinRoom(r.code));
      // A ghost room is turn-based single-driver runs, not a live two-car race.
      let driveBadge = null;
      if (r.drive === 'ghost') {
        driveBadge = document.createElement('span');
        driveBadge.className = 'mroom-drive';
        driveBadge.textContent = 'GHOST';
      }
      row.append(...[code, roomGame ? disc : null, driveBadge, host, count, join].filter(Boolean));
      roomsEl.appendChild(row);
    }
  }

  function fillTeams(select) {
    select.innerHTML = '';
    for (const t of TEAMS) {
      const o = document.createElement('option');
      o.value = t;
      o.textContent = t;
      select.appendChild(o);
    }
  }
  const p1Team = $('#mP1Team');
  const p2Team = $('#mP2Team');
  fillTeams(p1Team);
  fillTeams(p2Team);

  function renderRoom(state) {
    // The room's disc wins over this browser's own pick; an older cabinet sends
    // no game, so fall back to the local selection so the card still renders.
    const roomGameKey = normaliseGame(state.game || localGame);
    const roomGame = gameEntry(roomGameKey);
    const sharedCar = roomGame.mode === 'shared-car';
    // Same rule for the drive/turn: the room wins, the local pick only fills in
    // for a cabinet that does not echo those fields yet.
    const roomDrive = sharedCar ? normaliseDrive(state.drive || localDrive) : 'live';
    const roomTurn = roomDrive === 'ghost' ? normaliseTurn(state.turn || localTurn) : 'host';
    const ghost = sharedCar && roomDrive === 'ghost';
    room = { ...state, game: roomGameKey, drive: roomDrive, turn: roomTurn };
    roomEl.hidden = false;
    roomCodeEl.textContent = state.code;
    const invite = `${location.origin}/multiplayer?room=${encodeURIComponent(state.code)}&game=${encodeURIComponent(roomGameKey)}`
      + (sharedCar ? `&drive=${encodeURIComponent(roomDrive)}` : '')
      + (ghost ? `&turn=${encodeURIComponent(roomTurn)}` : '');
    inviteEl.textContent = invite;
    inviteEl.title = invite;

    const players = state.players || [];
    const me = players.find((p) => p.id === myId) || null;
    myRole = me ? me.role : myRole;
    ready = !!(me && me.ready);

    const p1 = players.find((p) => p.role === 'host') || players[0] || null;
    const p2 = players.find((p) => p.role === 'guest') || players[1] || null;

    const setSlot = (prefix, player, select, isMe) => {
      $(`#m${prefix}Name`).textContent = player ? player.name : 'WAITING…';
      $(`#m${prefix}Ready`).textContent = player ? (player.ready ? 'READY' : 'NOT READY') : 'WAITING';
      $(`#m${prefix}Ready`).classList.toggle('is-ready', !!(player && player.ready));
      select.disabled = !isMe || !player;
      if (player && player.team && select.value !== player.team) select.value = player.team;
      if (!player) select.value = TEAMS[0];
    };
    setSlot('P1', p1, p1Team, p1 && p1.id === myId);
    setSlot('P2', p2, p2Team, p2 && p2.id === myId);

    // Disc row: both seats read the room's disc + mode. Only the host may
    // switch it, and only while the lobby is still open.
    const locked = !!(state.started || raceStarted);
    const isHost = myRole === 'host';
    if (roomGameEl) {
      roomGameEl.textContent = `${String(roomGame.name || roomGameKey).toUpperCase()} // ${roomGame.modeLabel || 'VS BATTLE'}`;
    }
    if (roomGameSelEl) {
      fillGameOptions(roomGameSelEl, roomGameKey);
      roomGameSelEl.disabled = !isHost || locked;
      roomGameSelEl.title = locked
        ? 'The disc is locked once the race payload arrives.'
        : (isHost ? '' : 'Only the host can change the disc.');
    }

    // Drive row: the room's drive for both seats, the host-only switch, and (in
    // a ghost room) this run's driver. Both lock once the race payload lands.
    if (roomDriveRowEl) roomDriveRowEl.hidden = !sharedCar;
    if (roomDriveEl) {
      roomDriveEl.textContent = sharedCar
        ? `DRIVE ${DRIVE_LABEL[roomDrive]} // ${ghost ? 'TURN-BASED TIME TRIAL' : 'SHARED CAR'}`
        : `DRIVE ${DRIVE_LABEL.live} // VS BATTLE`;
    }
    if (roomDriveSelEl) {
      roomDriveSelEl.value = roomDrive;
      roomDriveSelEl.disabled = !sharedCar || !isHost || locked;
      roomDriveSelEl.title = !sharedCar
        ? 'R4 is a two-car VS Battle - ghost needs Rage or Ridge.'
        : (locked ? 'The drive is locked once the race payload arrives.'
          : (isHost ? '' : 'Only the host can change the drive.'));
    }
    if (roomTurnEl) roomTurnEl.hidden = !ghost;
    if (turnNowEl) turnNowEl.textContent = `TURN ${TURN_LABEL[roomTurn]}`;
    if (turnSelEl) {
      turnSelEl.value = roomTurn;
      turnSelEl.disabled = !ghost || !isHost || locked;
      turnSelEl.title = locked
        ? 'The turn is locked once the race payload arrives.'
        : (isHost ? '' : 'Only the host can set this run\'s driver.');
    }

    readyEl.textContent = ready ? 'READY // WAITING FOR RIVAL' : 'READY';
    readyEl.setAttribute('aria-pressed', String(ready));
    readyEl.disabled = !me;

    if (state.started && state.track) {
      trackEl.textContent = state.track;
      const rolled = state.cars || [];
      if (sharedCar) {
        // One car on the disc. Ghost keeps one car line and names the driver
        // instead of claiming both pads drive.
        const hostCar = rolled.find((c) => c.role === 'host') || rolled[0] || null;
        const carLine = hostCar ? `SHARED // ${hostCar.car}` : 'SHARED CAR // ONE CAR';
        carsEl.textContent = ghost ? `${carLine} · DRIVER: ${TURN_LABEL[roomTurn]}` : carLine;
      } else {
        carsEl.textContent = rolled
          .map((c) => `${c.role === 'host' ? 'P1' : 'P2'} ${c.team} ${c.car}`)
          .join(' · ');
      }
    } else {
      trackEl.textContent = 'FIRST TRACK ROLLS ON READY';
      if (ghost) carsEl.textContent = `Driver: ${TURN_LABEL[roomTurn]} · one car, the run you finish becomes the other's ghost.`;
      else carsEl.textContent = sharedCar
        ? 'Both drivers ready → one shared car, both pads drive it.'
        : 'Both drivers ready → random cars, first track.';
    }
    // The room is authoritative once it answers: adopt its drive/turn locally
    // so a rematch from this seat keeps them (a `?drive=`/`?turn=` link only
    // seeds the host's create).
    if (sharedCar) {
      localDrive = roomDrive;
      localTurn = roomTurn;
    }
    clearStatus();
    syncStartControls();
    placeStatus();
  }

  function showStart() {
    if (countTimer) { clearInterval(countTimer); countTimer = 0; }
    stopAutoRoom();
    raceStarted = false;
    raceEl.hidden = true;
    countEl.textContent = '3';
    roomEl.hidden = true;
    room = null;
    myRole = null;
    ready = false;
    rejoinCode = '';
    autoJoinTried = false;
    readyEl.disabled = true;
    readyEl.textContent = 'READY';
    readyEl.setAttribute('aria-pressed', 'false');
    clearStatus();
    syncStartControls();
    placeStatus();
    roomsEl.innerHTML = '';
    send({ type: 'list' });
  }

  function createRoom() {
    const code = String(codeEl.value || '').trim().toUpperCase();
    // The join guard below requires exactly 4 [A-Z0-9] chars, so a shorter
    // created code would be unjoinable. Empty means "roll one" on the server.
    if (code && !/^[A-Z0-9]{4}$/.test(code)) {
      setStatus('Room code must be 4 letters/digits, or leave JOIN CODE empty to roll one.');
      codeEl.focus();
      return;
    }
    codeEl.value = code;
    clearStatus();
    // A created room carries the disc + drive; a join never does (the room's
    // wins). `turn` is only meaningful in a ghost room.
    const gameKey = currentGame();
    const drive = driveSupported(gameKey) ? localDrive : 'live';
    const turn = drive === 'ghost' ? normaliseTurn(localTurn) : 'host';
    send({ type: 'create', name: playerName(), code, game: gameKey, drive, turn });
  }

  function joinRoom(code) {
    const c = String(code || codeEl.value || '').trim().toUpperCase().slice(0, 4);
    if (c.length !== 4) { toast('Enter a four-character room code.'); return; }
    codeEl.value = c;
    send({ type: 'join', name: playerName(), code: c });
  }

  function leaveRoom() {
    send({ type: 'leave' });
    showStart();
  }

  function setReady(next) {
    ready = !!next;
    send({ type: 'ready', ready });
    readyEl.textContent = ready ? 'READY // WAITING FOR RIVAL' : 'READY';
    readyEl.setAttribute('aria-pressed', String(ready));
  }

  function startRace(data) {
    if (raceStarted) return;
    raceStarted = true;
    const role = data.role || myRole || 'guest';
    // The race payload is broadcast to both sockets and carries the room's
    // disc + mode; fall back to the room card / local pick on older cabinets.
    const gameKey = normaliseGame(data.game || (room && room.game) || localGame);
    const entry = gameEntry(gameKey);
    const mode = String(data.mode || entry.mode || 'versus');
    const sharedCar = mode === 'shared-car';
    // Ghost is one driver per run on the host core; `live` is the untouched
    // shared-car path (both pads drive). R4 stays two cars either way.
    const drive = sharedCar ? normaliseDrive(data.drive || (room && room.drive) || localDrive) : 'live';
    const ghost = drive === 'ghost';
    const turn = ghost ? normaliseTurn(data.turn || (room && room.turn) || localTurn) : 'host';
    const track = data.track || 'RANDOM TRACK';
    const cars = Array.isArray(data.cars) ? data.cars : [];
    raceTrackEl.textContent = track;
    if (raceKickerEl) {
      raceKickerEl.textContent = ghost
        ? `DRIVER: ${TURN_LABEL[turn]}`
        : (sharedCar ? 'SHARED CAR // BOTH PADS DRIVE' : 'GRID LOCKED // TEAMS READY');
    }
    if (sharedCar) {
      // One car on the disc: live merges both pads into the host car, ghost
      // gates the other pad and swaps in the peer's tape for the replay.
      const hostCar = cars.find((c) => c.role === 'host') || cars[0] || null;
      const carLine = hostCar ? `SHARED // ${hostCar.car}` : 'SHARED // ONE CAR';
      raceCarsEl.textContent = ghost ? `${carLine}   ·   DRIVER: ${TURN_LABEL[turn]}` : carLine;
    } else {
      raceCarsEl.textContent = cars
        .map((c) => `${c.role === 'host' ? 'P1' : 'P2'} ${c.team} // ${c.car}`)
        .join('   ·   ');
    }
    raceEl.hidden = false;
    let n = 3;
    countEl.textContent = String(n);
    clearInterval(countTimer);
    countTimer = setInterval(() => {
      n -= 1;
      countEl.textContent = n > 0 ? String(n) : 'GO';
      if (n < 0) {
        clearInterval(countTimer);
        countTimer = 0;
        if (window.parent && window.parent !== window) {
          window.parent.postMessage({
            type: 'rr4-race',
            code: data.code,
            raceId: data.raceId || '',
            role,
            game: gameKey,
            track,
            trackIndex: data.trackIndex,
            cars,
            // Route A ghost: the shell adds `mpGhost`/`mpTurn` to the netplay
            // URL; `live` keeps the shared-car handoff unchanged.
            drive,
            turn,
          }, location.origin);
        } else {
          // Standalone page: carry the plan the room already rolled (same
          // params the shell builds in enter.js) so /play-net does not reroll.
          const trackIndex = data.trackIndex != null && Number.isFinite(Number(data.trackIndex))
            ? `&mpTrackIndex=${Number(data.trackIndex)}` : '';
          const hostCar = cars.find((c) => c.role === 'host');
          const guestCar = cars.find((c) => c.role === 'guest');
          const carHost = hostCar && Number.isFinite(Number(hostCar.carIndex))
            ? `&mpCarHost=${Number(hostCar.carIndex)}` : '';
          const carGuest = guestCar && Number.isFinite(Number(guestCar.carIndex))
            ? `&mpCarGuest=${Number(guestCar.carIndex)}` : '';
          const ghostParam = sharedCar ? `&mpGhost=${encodeURIComponent(drive)}` : '';
          const turnParam = ghost ? `&mpTurn=${encodeURIComponent(turn)}` : '';
          const liveParam = ghost ? '&mpLiveGhost=1' : '';
          location.href = `/play-net?threads=0&mpRole=${encodeURIComponent(role)}&mpRoom=${encodeURIComponent(data.code)}&mpRace=${encodeURIComponent(data.raceId || '')}${trackIndex}${carHost}${carGuest}&game=${encodeURIComponent(gameKey)}${ghostParam}${turnParam}${liveParam}`;
        }
      }
    }, 900);
  }

  function connect() {
    clearTimeout(reconnectTimer);
    ws = new WebSocket(wsUrl());
    ws.addEventListener('open', () => {
      clearInterval(listTimer);
      send({ type: 'list' });
      // Re-join the room we were in (or the one we dropped from) so a
      // reconnect re-syncs instead of silently sitting in no room.
      const code = room ? room.code : rejoinCode;
      if (code) send({ type: 'join', name: playerName(), code });
      else if (urlRoom && urlHost) {
        // Rematch host: recreate the same code. The server reclaims it when the
        // old room only holds dead sockets from the previous race.
        if (!autoJoinTried) { autoJoinTried = true; createRoom(); }
      } else if (urlRoom) {
        // Rematch guest: the host may not have created the room yet.
        autoJoinTried = true;
        startAutoRoom();
      }
      listTimer = setInterval(() => { if (!room) send({ type: 'list' }); }, 2500);
    });
    ws.addEventListener('message', (event) => {
      let msg;
      try { msg = JSON.parse(event.data); } catch { return; }
      if (msg.type === 'hello') {
        myId = msg.id;
        renderRooms(msg.rooms);
      } else if (msg.type === 'rooms') {
        renderRooms(msg.rooms);
      } else if (msg.type === 'joined') {
        myRole = msg.role;
        if (msg.id) myId = msg.id;
        rejoinCode = '';
        stopAutoRoom();
        roomCodeEl.textContent = msg.code;
        roomEl.hidden = false;
        // A fresh room always allows a fresh 3-2-1 handoff.
        if (countTimer) { clearInterval(countTimer); countTimer = 0; }
        raceStarted = false;
        raceEl.hidden = true;
        countEl.textContent = '3';
        clearStatus();
        syncStartControls();
        placeStatus();
      } else if (msg.type === 'room') {
        renderRoom(msg);
      } else if (msg.type === 'race') {
        renderRoom({
          ...(room || {}),
          started: true,
          game: msg.game || room?.game,
          mode: msg.mode,
          modeLabel: msg.modeLabel,
          drive: msg.drive || room?.drive,
          turn: msg.turn || room?.turn,
          track: msg.track,
          trackIndex: msg.trackIndex,
          cars: msg.cars,
          players: room?.players || [],
        });
        startRace({ ...msg, role: myRole });
      } else if (msg.type === 'left') {
        stopAutoRoom();
        showStart();
        renderRooms(msg.rooms);
      } else if (msg.type === 'error') {
        if (autoRoomPending && /room not found/i.test(msg.message || '')) {
          setStatus(`WAITING FOR HOST // ROOM ${urlRoom}`);
        } else {
          showError(msg.message);
        }
      }
    });
    ws.addEventListener('close', () => {
      clearInterval(listTimer);
      // Drop the stale plan and role so the next room (or the reconnect) can
      // run its own race, but remember the code to re-sync with.
      if (room) rejoinCode = room.code;
      if (countTimer) { clearInterval(countTimer); countTimer = 0; }
      raceStarted = false;
      raceEl.hidden = true;
      countEl.textContent = '3';
      room = null;
      myRole = null;
      ready = false;
      autoJoinTried = false;
      readyEl.disabled = true;
      readyEl.textContent = 'READY';
      readyEl.setAttribute('aria-pressed', 'false');
      syncStartControls();
      placeStatus();
      if (rejoinCode && !roomEl.hidden) setStatus(`LINK LOST // RETRYING ROOM ${rejoinCode}`, { retry: true });
      reconnectTimer = setTimeout(connect, 1500);
    });
    ws.addEventListener('error', () => {});
  }

  createEl.addEventListener('click', createRoom);
  joinEl.addEventListener('click', () => joinRoom(codeEl.value));
  refreshEl.addEventListener('click', () => send({ type: 'list' }));
  leaveEl.addEventListener('click', leaveRoom);
  readyEl.addEventListener('click', () => setReady(!ready));
  retryEl.addEventListener('click', retryRoom);
  p1Team.addEventListener('change', () => send({ type: 'team', team: p1Team.value }));
  p2Team.addEventListener('change', () => send({ type: 'team', team: p2Team.value }));
  if (gameEl) {
    gameEl.addEventListener('change', () => {
      gamePicked = true;
      setLocalGame(gameEl.value, true);
    });
  }
  if (roomGameSelEl) {
    roomGameSelEl.addEventListener('change', () => {
      const key = normaliseGame(roomGameSelEl.value);
      roomGameSelEl.value = key;
      send({ type: 'setgame', game: key });
    });
  }
  if (driveEl) {
    // Start card: LIVE | GHOST. Picking a drive persists it for the next room.
    driveEl.addEventListener('click', (event) => {
      const btn = event.target.closest('[data-drive]');
      if (!btn || btn.disabled || room) return;
      setLocalDrive(btn.dataset.drive, true);
    });
  }
  if (roomDriveSelEl) {
    roomDriveSelEl.addEventListener('change', () => {
      const next = normaliseDrive(roomDriveSelEl.value);
      roomDriveSelEl.value = next;
      // Repaint optimistically so the host's own card moves before the
      // server's `room` broadcast lands; the server stays authoritative.
      localDrive = next;
      persistDrive(next);
      send({ type: 'drive', drive: next });
      if (room) renderRoom({ ...room, drive: next, turn: next === 'ghost' ? room.turn || localTurn : 'host' });
    });
  }
  if (turnSelEl) {
    turnSelEl.addEventListener('change', () => {
      const next = normaliseTurn(turnSelEl.value);
      turnSelEl.value = next;
      localTurn = next;
      send({ type: 'turn', turn: next });
      if (room) renderRoom({ ...room, turn: next });
    });
  }
  copyEl.addEventListener('click', async () => {
    try { await navigator.clipboard.writeText(inviteEl.textContent); copyEl.textContent = 'COPIED'; }
    catch { copyEl.textContent = 'SELECT CODE'; }
  });
  codeEl.addEventListener('keydown', (e) => { if (e.key === 'Enter') joinRoom(codeEl.value); });

  placeStatus();
  syncStartControls();
  // Start card disc selector: inline list first, then the manifest (which is
  // authoritative). A rematch deep link (?game=…) is already applied here, so
  // the auto create/join below uses the right disc.
  fillGameOptions(gameEl, localGame);
  setLocalGame(localGame, false);
  loadGames();
  connect();
})();
