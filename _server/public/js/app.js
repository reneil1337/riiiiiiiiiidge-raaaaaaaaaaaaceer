/* Ridge Racer Type 4 LAN Arcade — browser client */
(function () {
  'use strict';

  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));
  const NEUTRAL = 0xFFFF;
  const VIEW_IDS = new Set(['split', 'p1', 'p2', 'auto']);
  const STALL_MS = 9000;
  const INPUT_GAP_MS = 28;
  const RECONNECT_MS = 1500;
  const RESERVE_MS = 20000;

  function makeId() {
    if (crypto.randomUUID) return crypto.randomUUID().replace(/-/g, '').slice(0, 24);
    return 'c' + Math.random().toString(36).slice(2) + Date.now().toString(36);
  }

  function validClientId(id) {
    return typeof id === 'string' && /^[A-Za-z0-9_-]{6,64}$/.test(id);
  }

  function storageGet(key, fallback) {
    try {
      const value = localStorage.getItem(key);
      return value == null ? fallback : value;
    } catch {
      return fallback;
    }
  }

  function storageSet(key, value) {
    try { localStorage.setItem(key, value); } catch { /* private mode */ }
  }

  const savedView = storageGet('rr4.view', 'split');
  const storedClientId = storageGet('rr4.clientId', '');
  const state = {
    ws: null,
    wsOpen: false,
    joined: false,
    joining: false,
    autojoin: storageGet('rr4.autojoin', '0') === '1',
    clientId: validClientId(storedClientId) ? storedClientId : makeId(),
    name: storageGet('rr4.name', ''),
    roomName: '',
    room: null,
    cabinet: null,
    publicViewers: 0,
    streamReady: false,
    streamLastFrame: 0,
    streamFrames: 0,
    streamStartedAt: 0,
    streamRestarts: 0,
    streamCanvas: null,
    playerCanvas: null,
    streamRestartTimer: null,
    ping: 0,
    lastPingSent: 0,
    view: VIEW_IDS.has(savedView) ? savedView : 'split',
    split: 'vertical',
    soundOn: storageGet('rr4.sound', '1') !== '0',
    mask: NEUTRAL,
    lastSent: -1,
    lastSentAt: 0,
    pendingMask: null,
    inputFlush: null,
    input: null,
    reconnectTimer: null,
    reconnectAttempts: 0,
    joinTimer: null,
    lastStateAt: 0,
    pingTimer: null,
    heartbeatTimer: null,
    statusTimer: null,
    playerWatch: null,
    padInfo: null,
    seat: 0,
    countdownHide: null,
    screenMsgTimer: null,
    chatSeen: new Set(),
    toastAt: 0,
    toastText: '',
    lastFocus: null,
    fsFallback: false,
  };
  storageSet('rr4.clientId', state.clientId);

  function fmtKbps(bytesPerSec) {
    if (!bytesPerSec) return '--';
    return `${Math.round(bytesPerSec / 1024)} KB/S`;
  }

  function toast(text, tone = 'info', ms = 3800) {
    text = String(text || '').trim();
    if (!text) return;
    const now = Date.now();
    if (text === state.toastText && now - state.toastAt < 1400) return;
    state.toastText = text;
    state.toastAt = now;
    const box = $('#toasts');
    if (!box) return;
    const el = document.createElement('div');
    el.className = `toast ${tone}`;
    el.textContent = text;
    box.appendChild(el);
    while (box.children.length > 4) box.firstElementChild.remove();
    setTimeout(() => el.remove(), Math.max(1000, ms));
  }

  function setText(sel, text) {
    const el = $(sel);
    if (el) el.textContent = text;
  }

  function inArcade() {
    const arcade = $('#arcade');
    return !!(arcade && !arcade.hidden);
  }

  function cabinetLabel(cab) {
    const g = cab?.game;
    const s = cab?.stream;
    if (s?.source === 'test') {
      return s.running ? { text: 'TEST STREAM', cls: 'warn' } : { text: 'STREAM OFFLINE', cls: 'bad' };
    }
    if (!g) return { text: 'OFFLINE', cls: 'bad' };
    if (g.state === 'ready' && g.running) return { text: 'CABINET READY', cls: 'good' };
    if (g.state === 'booting' || g.state === 'no-window' || g.state === 'starting') {
      return { text: 'CABINET BOOTING', cls: 'warn' };
    }
    if (g.state === 'exited' || g.state === 'stopped') return { text: 'CABINET RESTARTING', cls: 'bad' };
    return { text: String(g.state || 'OFFLINE').toUpperCase(), cls: 'warn' };
  }

  // ---------------------------------------------------------------- stream
  function streamUrl() {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    return `${proto}://${location.host}/stream`;
  }

  function getCanvas() {
    return state.streamCanvas || $('#streamCanvas') || $('#landingCanvas');
  }

  function moveCanvasTo(container) {
    if (!container) return null;
    let canvas = getCanvas();
    if (!canvas) {
      canvas = document.createElement('canvas');
      container.appendChild(canvas);
    }
    const nextId = container.id === 'screen' ? 'streamCanvas' : 'landingCanvas';
    if (canvas.id !== nextId) canvas.id = nextId;
    if (canvas.parentElement !== container) container.appendChild(canvas);
    state.streamCanvas = canvas;
    updateBootUi();
    return canvas;
  }

  function destroyPlayer() {
    if (state.playerWatch) {
      clearInterval(state.playerWatch);
      state.playerWatch = null;
    }
    const player = state.player;
    state.player = null;
    state.playerCanvas = null;
    state.streamReady = false;
    if (player) {
      try { player.destroy(); } catch { /* ignore */ }
    }
  }

  function createPlayer(canvas) {
    canvas = canvas || getCanvas();
    if (!canvas) return;
    state.streamCanvas = canvas;
    if (!window.JSMpeg) {
      setTimeout(() => createPlayer(canvas), 700);
      return;
    }
    if (state.player) {
      if (state.playerCanvas === canvas) return;
      destroyPlayer();
    }
    state.streamReady = false;
    state.streamLastFrame = 0;
    state.streamFrames = 0;
    state.streamStartedAt = Date.now();
    updateBootUi();
    try {
      state.player = new JSMpeg.Player(streamUrl(), {
        canvas,
        autoplay: true,
        audio: true,
        volume: state.soundOn ? 1 : 0,
        loop: false,
        videoBufferSize: 128 * 1024,
        audioBufferSize: 8 * 1024,
        maxAudioLag: 0.3,
        decodeFirstFrame: true,
        disableGl: false,
        preserveDrawingBuffer: false,
        progressive: false,
        throttled: false,
        // app.js owns reconnects so a dead socket cannot leave a ghost player
        reconnectInterval: 0,
        onVideoDecode: () => {
          state.streamFrames++;
          state.streamLastFrame = Date.now();
          if (!state.streamReady) {
            state.streamReady = true;
            state.streamRestarts = 0;
            updateBootUi();
            showScreenMsg('');
          }
        },
      });
      state.playerCanvas = canvas;
      watchPlayer();
    } catch (e) {
      console.warn('jsmpeg failed', e);
      restartPlayer('player create failed', 2200);
    }
  }

  function watchPlayer() {
    if (state.playerWatch) clearInterval(state.playerWatch);
    state.playerWatch = setInterval(() => {
      const p = state.player;
      if (!p) return;
      if (document.hidden) return;

      const socket = p.source && p.source.socket;
      if (socket && (socket.readyState === 2 || socket.readyState === 3)) {
        restartPlayer('stream socket closed');
        return;
      }

      const last = state.streamLastFrame || state.streamStartedAt || Date.now();
      if (Date.now() - last > STALL_MS) restartPlayer('stream stalled');
    }, 1000);
  }

  function restartPlayer(reason, delay) {
    if (state.streamRestartTimer) return;
    const canvas = state.streamCanvas || getCanvas();
    console.warn('restart stream:', reason);
    state.streamReady = false;
    updateBootUi();
    showScreenMsg('STREAM RECONNECTING…', 2600);
    destroyPlayer();
    const wait = delay != null
      ? delay
      : Math.min(10000, 800 * Math.pow(2, Math.min(state.streamRestarts, 4)));
    state.streamRestarts = Math.min(state.streamRestarts + 1, 5);
    state.streamRestartTimer = setTimeout(() => {
      state.streamRestartTimer = null;
      createPlayer(canvas);
    }, Math.max(300, wait));
  }

  function setBootText(el, text) {
    if (!el) return;
    const textNode = Array.from(el.childNodes).find(n => n.nodeType === 3 && n.nodeValue && n.nodeValue.trim());
    if (textNode) textNode.nodeValue = text;
    else el.insertBefore(document.createTextNode(text), el.firstChild);
  }

  function updateBootUi() {
    const cab = state.cabinet;
    const running = !!cab?.stream?.running;
    const gameState = cab?.game?.state;
    let label = 'CABINET BOOTING';
    if (cab && !running) label = gameState === 'ready' ? 'STREAM OFFLINE' : 'CABINET OFFLINE';
    const preview = $('#previewBoot');
    const idle = $('#screenIdle');
    setBootText(preview, label);
    setBootText(idle, label);
    if (preview) preview.hidden = !!state.streamReady;
    if (idle) idle.hidden = !!state.streamReady;
  }

  function showScreenMsg(text, ms = 3200) {
    const el = $('#screenMsg');
    if (!el) return;
    if (state.screenMsgTimer) {
      clearTimeout(state.screenMsgTimer);
      state.screenMsgTimer = null;
    }
    if (!text) {
      el.hidden = true;
      el.textContent = '';
      return;
    }
    el.textContent = text;
    el.hidden = false;
    state.screenMsgTimer = setTimeout(() => {
      el.hidden = true;
      el.textContent = '';
      state.screenMsgTimer = null;
    }, Math.max(800, ms));
  }

  // ---------------------------------------------------------------- websocket
  function connect() {
    if (state.ws && (state.ws.readyState === 0 || state.ws.readyState === 1)) return;
    if (state.ws) {
      try { state.ws.close(); } catch { /* ignore */ }
      state.ws = null;
    }
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    let ws;
    try {
      ws = new WebSocket(`${proto}://${location.host}/ws`);
    } catch (e) {
      console.warn('lobby connect failed', e);
      scheduleReconnect();
      return;
    }
    state.ws = ws;
    const connectTimer = setTimeout(() => {
      if (ws.readyState === 0) {
        try { ws.close(); } catch { /* ignore */ }
      }
    }, 8000);
    ws.onopen = () => {
      clearTimeout(connectTimer);
      if (state.ws !== ws) return;
      state.wsOpen = true;
      state.reconnectAttempts = 0;
      clearReconnect();
      clearJoinRetry();
      showScreenMsg('');
      renderPing();
      renderInputStatus();
      sendJoin();
      armJoinRetry();
    };
    ws.onmessage = (ev) => {
      if (state.ws !== ws) return;
      let msg;
      try { msg = JSON.parse(ev.data); } catch { return; }
      try { handle(msg); } catch (e) { console.warn('lobby message failed', e); }
    };
    ws.onclose = () => {
      clearTimeout(connectTimer);
      if (state.ws !== ws) return;
      state.ws = null;
      state.wsOpen = false;
      state.ping = 0;
      renderPing();
      renderInputStatus();
      if (state.joined) {
        if (state.reconnectAttempts === 0) toast('Connection lost — reconnecting…', 'warn');
        state.reconnectAttempts++;
        showScreenMsg('CONNECTION LOST — RECONNECTING…', 4500);
        scheduleReconnect();
      }
    };
    ws.onerror = () => {
      try { ws.close(); } catch { /* ignore */ }
    };
  }

  function clearReconnect() {
    if (state.reconnectTimer) {
      clearTimeout(state.reconnectTimer);
      state.reconnectTimer = null;
    }
  }

  function scheduleReconnect() {
    if (state.reconnectTimer || !state.joined) return;
    state.reconnectTimer = setTimeout(() => {
      state.reconnectTimer = null;
      if (!state.joined) return;
      if (state.ws && state.ws.readyState === 1) sendJoin();
      else if (!state.ws) connect();
      if (!state.ws || state.ws.readyState !== 1) scheduleReconnect();
    }, RECONNECT_MS);
  }

  function send(obj) {
    if (state.ws && state.ws.readyState === 1) {
      try { state.ws.send(JSON.stringify(obj)); return true; } catch { return false; }
    }
    return false;
  }

  function sendJoin() {
    if (!state.joined) return false;
    return send({ type: 'join', clientId: state.clientId, name: state.name || 'DRIVER' });
  }

  function clearJoinRetry() {
    if (state.joinTimer) {
      clearTimeout(state.joinTimer);
      state.joinTimer = null;
    }
  }

  function armJoinRetry() {
    if (state.joinTimer) return;
    state.joinTimer = setTimeout(() => {
      state.joinTimer = null;
      if (!state.joined) return;
      if (Date.now() - (state.lastStateAt || 0) < 5000) return;
      if (state.ws && state.ws.readyState === 1) sendJoin();
      armJoinRetry();
    }, 5000);
  }

  function handle(msg) {
    switch (msg.type) {
      case 'welcome':
        state.roomName = msg.roomName;
        if (validClientId(msg.clientId) && msg.clientId !== state.clientId) {
          state.clientId = msg.clientId;
          storageSet('rr4.clientId', state.clientId);
        }
        if (msg.split) applySplit(msg.split);
        state.lastStateAt = Date.now();
        clearJoinRetry();
        state.joining = false;
        break;
      case 'state':
        state.room = msg.room;
        state.cabinet = msg.cabinet;
        state.lastStateAt = Date.now();
        clearJoinRetry();
        state.joining = false;
        render();
        break;
      case 'chat':
        appendChat(msg.message);
        break;
      case 'countdown':
        showCountdown(msg.value);
        if (msg.value === 0) toast('Race starting — tap MY VIEW when the split screen appears.', 'info', 5000);
        break;
      case 'toast':
        toast(msg.message, msg.tone || 'info');
        break;
      case 'rumble':
        if (state.input) state.input.rumble(msg.duration || 350, 0.9, 0.7);
        break;
      case 'pong': {
        const sent = Number(msg.t);
        state.ping = sent ? Math.max(0, Math.round(performance.now() - sent)) : 0;
        renderPing();
        break;
      }
      case 'viewers':
        if (state.cabinet) {
          state.cabinet.stream = state.cabinet.stream || {};
          state.cabinet.stream.viewers = Number(msg.viewers) || 0;
        }
        renderViewers();
        break;
      case 'stream':
        if (msg.state === 'reconnecting') {
          toast('Stream reconnecting…', 'warn');
          state.streamReady = false;
          updateBootUi();
          restartPlayer('server stream restart', 1200);
        }
        break;
      case 'cabinet':
        if (msg.state === 'restarting') {
          toast('Cabinet restarting…', 'warn');
          state.streamReady = false;
          updateBootUi();
          showScreenMsg('CABINET RESTARTING…', 4500);
        }
        break;
      case 'error': {
        const message = String(msg.message || 'Input rejected');
        toast(message, 'bad');
        if (/join first/i.test(message)) sendJoin();
        else if (/seat taken/i.test(message)) send({ type: 'resync' });
        break;
      }
      default:
        break;
    }
  }

  // ---------------------------------------------------------------- render
  function render() {
    const room = state.room;
    const cab = state.cabinet;

    renderCabinet(cab);
    if (!room) {
      renderViewers();
      renderInputStatus();
      updateBootUi();
      return;
    }

    const prevSeat = state.seat;
    state.seat = Number(room.mySeat) || 0;
    if (state.input) state.input.setSeat(state.seat);
    if (prevSeat !== state.seat) {
      state.lastSent = -1;
      if (!state.seat) {
        state.mask = NEUTRAL;
        if (state.input) state.input.releaseAll();
        if (state.view === 'auto') {
          state.view = 'split';
          storageSet('rr4.view', 'split');
        }
      } else if ((state.view === 'p1' || state.view === 'p2') && state.view !== `p${state.seat}`) {
        // A spectator crop is not the new driver's view; menus default to full split.
        state.view = 'split';
        storageSet('rr4.view', 'split');
      }
    }

    const seats = room.seats || {};
    const mySeat = seats[room.mySeat] || null;
    const readyCount = [1, 2].filter(n => seats[n] && seats[n].ready).length;
    const phase = room.phase || 'lobby';

    setText('#readyBadge', phase === 'countdown' ? 'STARTING' : phase === 'race' ? 'RACE'
      : room.allReady ? 'READY 2/2' : readyCount ? `READY ${readyCount}/2` : 'LOBBY');
    const badge = $('#readyBadge');
    if (badge) {
      badge.classList.remove('good', 'warn');
      if (room.allReady) badge.classList.add('good');
      else if (phase !== 'lobby') badge.classList.add('warn');
    }

    setText('#hudSeat', mySeat ? `P${room.mySeat} // ${mySeat.name}` : 'SPECTATOR');
    const hs = $('#hudSeat');
    if (hs) {
      hs.classList.toggle('p1', room.mySeat === 1);
      hs.classList.toggle('p2', room.mySeat === 2);
    }

    const viewers = Array.isArray(room.viewers) ? room.viewers : [];
    const host = viewers.find(v => v.host);
    setText('#arcadeHost', host ? `HOST ${host.name}` : 'HOST --');
    const hostPill = $('#arcadeHost');
    if (hostPill) hostPill.title = host ? `${host.name} is hosting this cabinet` : 'No host connected';

    const btnReady = $('#btnReady');
    if (btnReady) {
      btnReady.disabled = !state.seat;
      btnReady.textContent = mySeat && mySeat.ready ? 'UNREADY' : 'READY';
      btnReady.classList.toggle('secondary', !!(mySeat && mySeat.ready));
      btnReady.classList.toggle('primary', !(mySeat && mySeat.ready));
    }
    const btnStart = $('#btnStart');
    if (btnStart) {
      btnStart.disabled = phase === 'countdown' || (!state.seat && !room.youAreHost);
      btnStart.textContent = phase === 'countdown' ? 'STARTING…' : 'PRESS START';
    }
    const hostActions = $('#hostActions');
    if (hostActions) hostActions.hidden = !room.youAreHost;
    const btnRestart = $('#btnRestart');
    if (btnRestart) btnRestart.disabled = phase === 'countdown';

    const hint = $('#seatHint');
    if (hint) {
      const reserved = [1, 2].some(n => seats[n] && seats[n].name && (!seats[n].connected || seats[n].reserved));
      if (!state.seat) hint.textContent = 'Take a seat to drive the live cabinet fallback. Or play natively in your browser from the top of the page.';
      else if (reserved) hint.textContent = 'A seat is held for a reconnecting driver. The lobby will resume shortly.';
      else if (room.allReady) hint.textContent = 'Both drivers ready. Press START to launch the fallback cabinet.';
      else hint.textContent = 'Use PRESS START to wake the fallback cabinet, then navigate to VS BATTLE with your D-pad or stick.';
    }

    renderViewers();
    renderSeats(room);
    renderChat(room);
    renderPing();
    renderInputStatus();
    updateViewButtons();
    applyView();
    updateBootUi();
  }

  function renderCabinet(cab) {
    const cl = cabinetLabel(cab);
    setText('#cabinetPillText', cl.text);
    const pill = $('#cabinetPill');
    if (pill) {
      pill.classList.remove('good', 'warn', 'bad');
      pill.classList.add(cl.cls);
    }
    const live = !!cab?.stream?.running;
    setText('#landingStatus', `${cl.text} // ${live ? 'LIVE CABINET STREAM' : 'STREAM FALLBACK OFFLINE'}`);
    setText('#infoCabinet', cl.text);
    setText('#infoStream', live
      ? `${fmtKbps(cab.stream.bytesPerSec)} // ${cab.stream.viewers || 0} VIEWERS`
      : 'OFFLINE');
  }

  function viewerCount() {
    const roomN = state.room
      ? (Array.isArray(state.room.viewers) ? state.room.viewers.length : 0)
      : (Number(state.publicViewers) || 0);
    const streamN = Number(state.cabinet?.stream?.viewers);
    return Math.max(roomN, Number.isFinite(streamN) ? streamN : 0);
  }

  function renderViewers() {
    const n = viewerCount();
    setText('#viewerPill', `${n} WATCHING`);
    setText('#landingViewers', `${n} watching`);
    setText('#arcadeViewers', `${n} WATCHING`);
    setText('#infoViewers', String(n));
  }

  function renderPing() {
    setText('#pingPill', state.ping ? `${state.ping} MS` : '-- MS');
    setText('#infoPing', state.ping ? `${state.ping} MS` : '--');
  }

  function renderInputStatus() {
    const el = $('#infoInput');
    if (!el) return;
    let text = '--';
    if (state.joined) {
      if (!state.room?.mySeat) text = 'SPECTATOR';
      else if (!state.ws || state.ws.readyState !== 1) text = 'RECONNECTING';
      else text = 'ARMED';
    }
    el.textContent = text;
    el.classList.toggle('good', text === 'ARMED');
    el.classList.toggle('warn', text === 'RECONNECTING');
    el.style.color = text === 'ARMED' ? 'var(--green)'
      : text === 'RECONNECTING' ? 'var(--amber)'
      : '';
  }

  function seatSignature(room) {
    return [1, 2].map(seat => {
      const s = (room.seats && room.seats[seat]) || {};
      return [s.name || '', s.ready ? 1 : 0, s.connected ? 1 : 0, s.mine ? 1 : 0, s.reserved ? 1 : 0].join(':');
    }).join('|');
  }

  function takeSeat(seat) {
    if (state.seat) releaseInput();
    send({ type: 'seat', seat });
  }

  function leaveSeat() {
    releaseInput();
    send({ type: 'leaveSeat' });
  }

  function renderSeats(room) {
    const root = $('#seatCards');
    if (!root) return;
    const sig = seatSignature(room);
    if (root.dataset.sig === sig) return;

    const focused = document.activeElement;
    const focusSeat = focused && focused.closest && focused.closest('#seatCards') ? focused.dataset.seat : null;
    root.replaceChildren();
    for (const seat of [1, 2]) {
      const s = (room.seats && room.seats[seat]) || {};
      const reserved = !!(s.name && (!s.connected || s.reserved));
      const card = document.createElement('div');
      card.className = `seat-card p${seat}${s.mine ? ' mine' : ''}${s.name ? '' : ' empty'}${reserved ? ' reserved' : ''}`;
      const num = document.createElement('div');
      num.className = 'seat-num';
      num.textContent = `P${seat}`;
      const body = document.createElement('div');
      const name = document.createElement('div');
      name.className = 'seat-name';
      name.textContent = s.name || 'OPEN SEAT';
      const status = document.createElement('div');
      status.className = 'seat-status' + (s.ready ? ' ready' : s.mine ? ' you' : '');
      status.textContent = !s.name ? 'WAITING FOR DRIVER'
        : reserved ? 'RECONNECTING…'
        : s.ready ? 'READY'
        : s.mine ? 'YOUR SEAT'
        : 'IN THE PIT';
      body.append(name, status);

      const action = document.createElement('button');
      action.type = 'button';
      action.dataset.seat = String(seat);
      action.className = `btn ${s.mine ? 'ghost' : s.name ? 'ghost' : 'primary'} small`;
      if (s.mine) {
        action.textContent = 'LEAVE';
        action.setAttribute('aria-label', `Leave seat P${seat}`);
        action.onclick = leaveSeat;
      } else if (!s.name) {
        action.textContent = `TAKE P${seat}`;
        action.setAttribute('aria-label', `Take seat P${seat}`);
        action.onclick = () => takeSeat(seat);
      } else if (reserved) {
        action.textContent = 'RESERVED';
        action.disabled = true;
        action.title = 'Seat held for a reconnecting driver';
        action.setAttribute('aria-label', `Seat P${seat} reserved`);
      } else {
        action.textContent = 'TAKEN';
        action.disabled = true;
        action.setAttribute('aria-label', `Seat P${seat} taken`);
      }
      card.append(num, body, action);
      root.appendChild(card);
    }
    root.dataset.sig = sig;
    if (focusSeat) {
      const again = root.querySelector(`button[data-seat="${focusSeat}"]`);
      if (again) again.focus();
    }
  }

  function chatKey(m) {
    return String(m.id || `${m.at || 0}|${m.name || ''}|${m.text || ''}`);
  }

  function renderChat(room) {
    const log = $('#chatLog');
    if (!log) return;
    const nearBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 40;
    const msgs = Array.isArray(room.chat) ? room.chat : [];
    if (state.chatSeen.size > 400) state.chatSeen.clear();
    const existing = new Map();
    for (const el of Array.from(log.children)) {
      if (el.dataset && el.dataset.chatId) existing.set(el.dataset.chatId, el);
    }
    for (const m of msgs) {
      const key = chatKey(m);
      state.chatSeen.add(key);
      if (existing.has(key)) {
        existing.delete(key);
        continue;
      }
      const line = document.createElement('div');
      line.className = 'chat-line' + (m.system ? ' system' : '');
      line.dataset.chatId = key;
      const b = document.createElement('b');
      b.textContent = m.system ? 'SYSTEM' : (m.name || 'DRIVER');
      line.append(b, document.createTextNode(' ' + String(m.text || '')));
      log.appendChild(line);
    }
    for (const el of existing.values()) el.remove();
    setText('#chatCount', String(msgs.length));
    if (nearBottom) log.scrollTop = log.scrollHeight;
  }

  function appendChat(m) {
    if (!m) return;
    const key = chatKey(m);
    if (state.chatSeen.has(key)) return;
    state.chatSeen.add(key);
    if (state.room) {
      state.room.chat = [...(state.room.chat || []), m].slice(-40);
      renderChat(state.room);
    }
  }

  // ---------------------------------------------------------------- views
  function applySplit(split) {
    const screen = $('#screen');
    if (split) state.split = split;
    if (!state.split) state.split = 'vertical';
    const override = storageGet('rr4.split', 'auto');
    const effective = override === 'auto' ? state.split : override;
    if (screen) screen.classList.toggle('split-horizontal', effective === 'horizontal');
    const select = $('#splitOrientation');
    if (select) select.value = override;
  }

  function normalizeView() {
    let view = VIEW_IDS.has(state.view) ? state.view : 'split';
    const seat = state.seat || Number(state.room?.mySeat) || 0;
    if (seat) {
      if (view === 'split' || view === 'auto') return view;
      if (view === `p${seat}`) return 'auto';
      return 'split';
    }
    return view === 'auto' ? 'split' : view;
  }

  function activeViewId() {
    const seat = state.seat || Number(state.room?.mySeat) || 0;
    const view = normalizeView();
    if (seat) return view === 'split' ? 'split' : 'auto';
    return view === 'p1' || view === 'p2' ? view : 'split';
  }

  function resolveViewMode() {
    const seat = state.seat || Number(state.room?.mySeat) || 0;
    const view = normalizeView();
    if (!seat) return view === 'p1' || view === 'p2' ? view : 'split';
    return view === 'split' ? 'split' : `p${seat}`;
  }

  function viewOptions() {
    const seat = state.seat || Number(state.room?.mySeat) || 0;
    if (seat) {
      return [{ id: 'auto', label: 'MY VIEW' }, { id: 'split', label: 'FULL SPLIT' }];
    }
    return [
      { id: 'p1', label: 'P1 VIEW' },
      { id: 'p2', label: 'P2 VIEW' },
      { id: 'split', label: 'FULL SPLIT' },
    ];
  }

  function updateViewButtons() {
    const root = $('#viewSwitch');
    if (!root) return;
    const options = viewOptions();
    const key = options.map(o => o.id).join('|');
    if (root.dataset.options !== key) {
      const focused = document.activeElement;
      const focusView = focused && focused.closest && focused.closest('#viewSwitch')
        ? focused.dataset.view : null;
      root.replaceChildren();
      for (const opt of options) {
        const b = document.createElement('button');
        b.type = 'button';
        b.textContent = opt.label;
        b.dataset.view = opt.id;
        b.onclick = () => setView(opt.id);
        root.appendChild(b);
      }
      root.dataset.options = key;
      if (focusView) {
        const again = root.querySelector(`button[data-view="${focusView}"]`);
        if (again) again.focus();
      }
    }
    const active = activeViewId();
    for (const b of $$('button[data-view]', root)) {
      const on = b.dataset.view === active;
      b.classList.toggle('active', on);
      b.setAttribute('aria-pressed', on ? 'true' : 'false');
    }
  }

  function setView(view) {
    if (!VIEW_IDS.has(view)) return;
    if (!state.seat && view === 'auto') view = 'split';
    if (state.seat && (view === 'p1' || view === 'p2')) {
      view = view === `p${state.seat}` ? 'auto' : 'split';
    }
    state.view = view;
    storageSet('rr4.view', view);
    updateViewButtons();
    applyView();
  }

  function applyView() {
    const screen = $('#screen');
    if (!screen) return;
    const mode = resolveViewMode();
    screen.classList.remove('view-p1', 'view-p2', 'view-split');
    screen.classList.add(`view-${mode}`);
    const labels = { p1: 'P1 VIEW', p2: 'P2 VIEW', split: 'FULL SPLIT' };
    setText('#hudView', labels[mode] || 'FULL SPLIT');
  }

  function showCountdown(value) {
    const el = $('#countdown');
    const num = $('#countdownNum');
    if (!el || !num) return;
    if (state.countdownHide) {
      clearTimeout(state.countdownHide);
      state.countdownHide = null;
    }
    el.hidden = false;
    const small = el.querySelector('small');
    if (value > 0) {
      num.textContent = String(value);
      if (small) small.textContent = 'GET READY';
    } else {
      num.textContent = 'GO';
      if (small) small.textContent = 'RACE';
      state.countdownHide = setTimeout(() => { el.hidden = true; }, 900);
    }
  }

  // ---------------------------------------------------------------- input
  function initInput() {
    if (!window.RR4Input) return;
    if (state.input) {
      state.input.setSeat(state.seat);
      return;
    }
    state.input = new RR4Input.InputController({
      onChange: (mask) => {
        state.mask = mask;
        if (!state.joined || !inArcade()) return;
        const seat = Number(state.room?.mySeat) || state.seat || 0;
        if (!seat) return;
        sendInput(mask, false);
      },
      onPadStatus: (info) => {
        state.padInfo = info;
        renderPadStatus(info);
      },
      onRumble: () => {},
    }).start();
    const layout = storageGet('rr4.layout', 'auto');
    state.input.setLayout(layout);
    const slot = storageGet('rr4.padSlot', '0');
    state.input.setPadSlot(Number(slot));
    if (matchMedia('(pointer: coarse)').matches) {
      setTimeout(() => state.input && state.input.setTouchVisible(true), 400);
    }
  }

  function sendInput(mask, force, seatOverride) {
    const seat = Number(seatOverride != null
      ? seatOverride
      : (Number(state.room?.mySeat) || state.seat || 0));
    if (!seat) {
      if (force) state.lastSent = -1;
      return false;
    }
    mask = Number(mask) & 0xFFFF;
    if (!force && mask === state.lastSent) return true;

    const now = performance.now();
    if (force || now - state.lastSentAt >= INPUT_GAP_MS) {
      if (state.inputFlush) {
        clearTimeout(state.inputFlush);
        state.inputFlush = null;
      }
      state.pendingMask = null;
      state.lastSent = mask;
      state.lastSentAt = now;
      return send({ type: 'input', mask });
    }

    state.pendingMask = mask;
    if (!state.inputFlush) {
      const wait = Math.max(0, INPUT_GAP_MS - (now - state.lastSentAt));
      state.inputFlush = setTimeout(() => {
        state.inputFlush = null;
        const pending = state.pendingMask;
        state.pendingMask = null;
        if (pending == null) return;
        const seatNow = Number(state.room?.mySeat) || state.seat || 0;
        if (!seatNow) return;
        state.lastSent = pending;
        state.lastSentAt = performance.now();
        send({ type: 'input', mask: pending });
      }, wait);
    }
    return true;
  }

  function releaseInput(force = true) {
    const seat = Number(state.room?.mySeat) || state.seat || 0;
    if (state.input) state.input.releaseAll();
    if (seat && force && state.lastSent !== NEUTRAL) sendInput(NEUTRAL, true, seat);
  }

  function renderPadStatus(info) {
    state.padInfo = info;
    const type = info?.type || 'generic';
    const label = info?.connected ? (window.RR4Input?.padLabel(type) || 'Gamepad').toUpperCase() : 'KEYBOARD';
    setText('#padPill', label);
    const icon = $('#padStatusIcon');
    if (icon) icon.textContent = info?.connected ? '🎮' : '⌨️';
    setText('#padStatusName', info?.connected ? info.name : 'No controller detected');
    setText('#padStatusDetail', info?.connected
      ? `${info.mapping === 'standard' ? 'STANDARD MAPPING' : 'COMPATIBILITY MAPPING'} // ${info.buttons} BUTTONS // ${info.axes} AXES`
      : 'Connect an Xbox or PlayStation pad and press any button.');
    const badge = $('#padStatusBadge');
    if (badge) {
      badge.textContent = info?.connected ? 'ONLINE' : 'OFFLINE';
      badge.classList.toggle('good', !!info?.connected);
    }
    const labels = type === 'playstation'
      ? { triangle: '△', circle: '○', cross: '✕', square: '□' }
      : { triangle: 'Y', circle: 'B', cross: 'A', square: 'X' };
    for (const el of $$('#padFace [data-face]')) {
      el.textContent = labels[el.dataset.face] || el.textContent;
    }
  }

  // ---------------------------------------------------------------- status poll
  async function pollStatus() {
    try {
      const r = await fetch('/api/status', { cache: 'no-store' });
      if (!r.ok) throw new Error(`status ${r.status}`);
      const data = await r.json();
      state.cabinet = data.cabinet;
      state.publicViewers = data.room?.viewers?.length || 0;
      if (!data.cabinet?.stream?.running && state.streamReady) state.streamReady = false;
      renderCabinet(data.cabinet);
      renderViewers();
      updateBootUi();
    } catch {
      setText('#landingStatus', 'CABINET OFFLINE // PLAY IN BROWSER STILL WORKS');
    }
  }

  // ---------------------------------------------------------------- fullscreen
  function isFullscreen() {
    return !!(document.fullscreenElement || document.webkitFullscreenElement ||
      document.body.classList.contains('fs'));
  }

  function syncFullscreenUi() {
    const fs = isFullscreen();
    document.body.classList.toggle('fs', fs);
    const exit = $('#btnExitFs');
    if (exit) exit.hidden = !fs;
  }

  function lockOrientation() {
    try {
      const orientation = screen.orientation;
      if (orientation && typeof orientation.lock === 'function') {
        const result = orientation.lock('landscape');
        if (result && result.catch) result.catch(() => {});
      }
    } catch { /* unsupported */ }
  }

  function unlockOrientation() {
    try {
      if (screen.orientation && typeof screen.orientation.unlock === 'function') {
        screen.orientation.unlock();
      }
    } catch { /* unsupported */ }
  }

  async function enterFullscreen() {
    const target = document.documentElement;
    state.fsFallback = false;
    document.body.classList.add('fs');
    try {
      if (target.requestFullscreen) await target.requestFullscreen({ navigationUI: 'hide' });
      else if (target.webkitRequestFullscreen) target.webkitRequestFullscreen();
      else state.fsFallback = true;
    } catch {
      state.fsFallback = true;
    }
    document.body.classList.add('fs');
    syncFullscreenUi();
    lockOrientation();
    if (state.player?.audioOut?.unlock) state.player.audioOut.unlock();
  }

  async function exitFullscreen() {
    state.fsFallback = false;
    try {
      if (document.fullscreenElement && document.exitFullscreen) await document.exitFullscreen();
      else if (document.webkitFullscreenElement && document.webkitExitFullscreen) document.webkitExitFullscreen();
    } catch { /* ignore */ }
    document.body.classList.remove('fs');
    syncFullscreenUi();
    unlockOrientation();
  }

  function toggleFullscreen() {
    if (isFullscreen()) exitFullscreen();
    else enterFullscreen();
  }

  function onFullscreenChange() {
    const native = !!(document.fullscreenElement || document.webkitFullscreenElement);
    if (native) {
      state.fsFallback = false;
      document.body.classList.add('fs');
    } else if (!state.fsFallback) {
      document.body.classList.remove('fs');
      unlockOrientation();
    }
    syncFullscreenUi();
  }

  // ---------------------------------------------------------------- sound
  function setSound(on) {
    state.soundOn = !!on;
    storageSet('rr4.sound', on ? '1' : '0');
    if (state.player) {
      state.player.volume = on ? 1 : 0;
      if (on && state.player.audioOut?.unlock) state.player.audioOut.unlock();
    }
    const b = $('#btnSound');
    if (b) {
      b.textContent = on ? 'SOUND ON' : 'MUTED';
      b.setAttribute('aria-pressed', on ? 'true' : 'false');
      b.title = on ? 'Mute sound (M)' : 'Unmute sound (M)';
    }
  }

  // ---------------------------------------------------------------- join / views
  function join() {
    if (state.joining) return;
    const nameInput = $('#nameInput');
    const raw = String((nameInput && nameInput.value) || state.name || '').trim();
    state.name = (raw || 'DRIVER').slice(0, 16);
    storageSet('rr4.name', state.name);
    storageSet('rr4.autojoin', '1');
    state.autojoin = true;
    if (nameInput && nameInput.value !== state.name) nameInput.value = state.name;
    if (document.activeElement && document.activeElement.blur) document.activeElement.blur();

    state.joined = true;
    state.joining = true;
    const landing = $('#landing');
    const arcade = $('#arcade');
    if (landing) landing.hidden = true;
    if (arcade) arcade.hidden = false;
    document.body.classList.add('in-arcade');

    const canvas = moveCanvasTo($('#screen')) || $('#landingCanvas') || $('#streamCanvas');
    createPlayer(canvas);
    initInput();
    connect();
    sendJoin();
    armJoinRetry();
    setSound(state.soundOn);
    applySplit(state.split);
    updateViewButtons();
    applyView();
    updateBootUi();
    showScreenMsg('CONNECTING TO CABINET…', 2400);
    if (arcade && typeof arcade.focus === 'function') arcade.focus({ preventScroll: true });
    setTimeout(() => { state.joining = false; }, 1200);
    if (matchMedia('(pointer: coarse)').matches) {
      setTimeout(() => state.input && state.input.setTouchVisible(true), 500);
    }
  }

  function backToLanding() {
    if (!state.joined) return;
    storageSet('rr4.autojoin', '0');
    state.autojoin = false;
    releaseInput();
    const arcade = $('#arcade');
    const landing = $('#landing');
    if (arcade) arcade.hidden = true;
    if (landing) landing.hidden = false;
    document.body.classList.remove('in-arcade');
    moveCanvasTo($('#landingScreen'));
    syncFullscreenUi();
    updateBootUi();
    renderInputStatus();
    const nameInput = $('#nameInput');
    if (nameInput) nameInput.focus();
  }

  // ---------------------------------------------------------------- modals
  function focusables(root) {
    return $$('button,[href],input,select,textarea,[tabindex]:not([tabindex="-1"])', root)
      .filter(el => !el.disabled && el.getAttribute('aria-hidden') !== 'true' && el.offsetParent !== null);
  }

  function openModal(id) {
    const el = document.getElementById(id);
    if (!el) return;
    for (const other of $$('.modal')) {
      if (other !== el && !other.hidden) closeModal(other.id);
    }
    if (el.hidden) state.lastFocus = document.activeElement;
    el.hidden = false;
    const list = focusables(el);
    if (list.length) list[0].focus();
    else {
      el.tabIndex = -1;
      el.focus();
    }
  }

  function closeModal(id) {
    const el = document.getElementById(id);
    if (!el || el.hidden) return;
    el.hidden = true;
    const back = state.lastFocus;
    state.lastFocus = null;
    if (back && document.contains(back) && typeof back.focus === 'function') {
      back.focus({ preventScroll: true });
    }
  }

  // ---------------------------------------------------------------- boot
  function on(sel, event, handler, opts) {
    const el = $(sel);
    if (el) el.addEventListener(event, handler, opts);
  }

  function bind() {
    const nameInput = $('#nameInput');
    if (nameInput && state.name) nameInput.value = state.name;

    on('#joinBtn', 'click', join);
    if (nameInput) {
      nameInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') join(); });
    }
    on('#fsLanding', 'click', async () => {
      await enterFullscreen();
      if (nameInput && nameInput.value.trim()) join();
      else if (nameInput) nameInput.focus();
    });
    on('#brandHome', 'click', (e) => {
      e.preventDefault();
      if (state.joined) backToLanding();
      else if (nameInput) nameInput.focus();
    });
    on('#btnFullscreen', 'click', toggleFullscreen);
    on('#btnFullscreen2', 'click', toggleFullscreen);
    on('#btnFullscreenTop', 'click', toggleFullscreen);
    on('#btnHelpFs', 'click', toggleFullscreen);
    on('#btnExitFs', 'click', exitFullscreen);
    on('#btnSound', 'click', () => setSound(!state.soundOn));
    on('#btnHelp', 'click', () => openModal('modalHelp'));
    on('#btnController', 'click', () => {
      renderPadStatus(state.padInfo || { connected: false });
      openModal('modalController');
    });
    on('#btnTouch', 'click', () => {
      if (!state.input) return toast('Touch controls are not available', 'warn');
      const visible = state.input.toggleTouch();
      toast(visible ? 'Touch pad enabled' : 'Touch pad hidden', 'info', 2200);
    });
    on('#btnReady', 'click', () => {
      const seat = state.room?.seats?.[state.room.mySeat];
      if (!state.room?.mySeat) return toast('Take a seat first', 'warn');
      send({ type: 'ready', value: !seat?.ready });
    });
    on('#btnStart', 'click', () => {
      if (!state.room?.mySeat && !state.room?.youAreHost) return toast('Take a seat first', 'warn');
      send({ type: 'start' });
    });
    on('#btnRestart', 'click', () => {
      if (!confirm('Restart the fallback cabinet? Everyone will be returned to the title screen.')) return;
      send({ type: 'restart' });
    });
    on('#btnRumble', 'click', () => {
      const ok = state.input && state.input.rumble(500, 1, 0.8);
      toast(ok ? 'Rumble sent to your pad' : 'No rumble-capable controller found', ok ? 'good' : 'warn');
    });

    on('#keyboardLayout', 'change', (e) => {
      storageSet('rr4.layout', e.target.value);
      if (state.input) state.input.setLayout(e.target.value);
    });
    on('#padSlot', 'change', (e) => {
      storageSet('rr4.padSlot', e.target.value);
      if (state.input) state.input.setPadSlot(Number(e.target.value));
    });
    on('#splitOrientation', 'change', (e) => {
      storageSet('rr4.split', e.target.value);
      applySplit(state.split || 'vertical');
    });

    const layoutEl = $('#keyboardLayout');
    if (layoutEl) layoutEl.value = storageGet('rr4.layout', 'auto');
    const slotEl = $('#padSlot');
    if (slotEl) slotEl.value = storageGet('rr4.padSlot', '0');
    const splitEl = $('#splitOrientation');
    if (splitEl) splitEl.value = storageGet('rr4.split', 'auto');

    on('#chatForm', 'submit', (e) => {
      e.preventDefault();
      const input = $('#chatInput');
      if (!input) return;
      const text = input.value.trim();
      if (!text) return;
      if (!state.joined) {
        toast('Join the cabinet to chat', 'warn');
        return;
      }
      if (!send({ type: 'chat', text })) toast('Chat offline — reconnecting…', 'warn');
      input.value = '';
      input.focus();
    });

    for (const el of $$('[data-close]')) {
      el.addEventListener('click', () => closeModal(el.dataset.close));
    }
    for (const modal of $$('.modal')) {
      modal.setAttribute('role', 'dialog');
      modal.setAttribute('aria-modal', 'true');
      const title = modal.querySelector('h2');
      if (title) {
        if (!title.id) title.id = `${modal.id}-title`;
        modal.setAttribute('aria-labelledby', title.id);
      }
      modal.addEventListener('click', (e) => { if (e.target === modal) closeModal(modal.id); });
      modal.addEventListener('keydown', (e) => {
        if (e.key !== 'Tab') return;
        const list = focusables(modal);
        if (!list.length) return;
        const first = list[0];
        const last = list[list.length - 1];
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      });
    }

    const chatLog = $('#chatLog');
    if (chatLog) {
      chatLog.setAttribute('role', 'log');
      chatLog.setAttribute('aria-live', 'polite');
      chatLog.setAttribute('aria-relevant', 'additions');
      chatLog.setAttribute('aria-atomic', 'false');
    }
    const viewSwitch = $('#viewSwitch');
    if (viewSwitch) viewSwitch.setAttribute('aria-label', 'Camera view');
    const arcade = $('#arcade');
    if (arcade) arcade.tabIndex = -1;

    window.addEventListener('keydown', (e) => {
      const target = e.target;
      const typing = target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' ||
        target.tagName === 'SELECT' || target.isContentEditable);

      if (e.key === 'Escape') {
        const open = $$('.modal').filter(m => !m.hidden);
        if (open.length) {
          e.preventDefault();
          closeModal(open[open.length - 1].id);
          return;
        }
        if (isFullscreen()) {
          e.preventDefault();
          exitFullscreen();
        }
        return;
      }
      if (typing || e.repeat) return;
      if (e.key === 'f' || e.key === 'F') {
        e.preventDefault();
        toggleFullscreen();
      } else if (e.key === 'm' || e.key === 'M') {
        e.preventDefault();
        setSound(!state.soundOn);
      } else if (e.key === 'h' || e.key === 'H') {
        e.preventDefault();
        openModal('modalHelp');
      }
    });

    document.addEventListener('fullscreenchange', onFullscreenChange);
    document.addEventListener('webkitfullscreenchange', onFullscreenChange);

    window.addEventListener('blur', () => releaseInput());
    window.addEventListener('online', () => {
      if (state.joined && !state.ws) connect();
    });
    window.addEventListener('offline', () => toast('Network offline', 'warn'));

    document.addEventListener('visibilitychange', () => {
      if (document.hidden) {
        releaseInput();
        if (state.input) state.input.releaseAll();
      } else {
        state.streamLastFrame = Date.now();
        renderPing();
      }
    });

    window.addEventListener('beforeunload', () => {
      const arcadeVisible = $('#arcade') && !$('#arcade').hidden;
      storageSet('rr4.autojoin', state.joined && arcadeVisible ? '1' : '0');
      if (state.input) state.input.releaseAll();
      if (state.room?.mySeat || state.seat) sendInput(NEUTRAL, true);
    });

    setSound(state.soundOn);
    applySplit(state.split);
  }

  function startTimers() {
    state.statusTimer = setInterval(pollStatus, 3000);
    state.pingTimer = setInterval(() => {
      if (!state.ws || state.ws.readyState !== 1) return;
      state.lastPingSent = performance.now();
      send({ type: 'ping', t: state.lastPingSent });
    }, 2000);
    state.heartbeatTimer = setInterval(() => {
      if (!state.joined || !inArcade()) return;
      const seat = Number(state.room?.mySeat) || state.seat || 0;
      if (!seat) return;
      if (!state.ws || state.ws.readyState !== 1) return;
      sendInput(state.mask, true);
    }, 250);
  }

  function maybeAutojoin() {
    if (!state.autojoin || !state.name) return;
    const input = $('#nameInput');
    if (input) input.value = state.name;
    setTimeout(() => { if (!state.joined) join(); }, 0);
  }

  document.addEventListener('DOMContentLoaded', () => {
    bind();
    syncFullscreenUi();
    createPlayer($('#landingCanvas'));
    pollStatus();
    startTimers();
    renderPing();
    renderPadStatus({ connected: false });
    updateViewButtons();
    applyView();
    updateBootUi();
    maybeAutojoin();
  });

  // Small debug surface for automated LAN checks.
  window.__RR4 = { state };
})();
