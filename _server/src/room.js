// Single-cabinet lobby: two seats, spectators, ready state, chat.
const RESERVE_MS = 20000;
const MAX_CHAT = 80;

const BAD_WORDS = [
  'fuck', 'shit', 'bitch', 'cunt', 'asshole', 'dick', 'piss', 'slut',
  'nigger', 'faggot', 'retard',
];

function cleanName(name) {
  return String(name || '').replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, 16) || 'DRIVER';
}

function cleanChat(text) {
  let s = String(text || '').replace(/[\u0000-\u001f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 220);
  for (const w of BAD_WORDS) {
    s = s.replace(new RegExp(w, 'gi'), '*'.repeat(w.length));
  }
  return s;
}

export class Room {
  constructor({ name }) {
    this.name = name;
    this.clients = new Map();
    this.seats = { 1: null, 2: null };
    this.hostId = null;
    this.lastHostId = null;
    this.chat = [];
    this.phase = 'lobby';
    this.countdown = 0;
    this.raceStartedAt = 0;
    this.nextChatAt = new Map();
  }

  join(clientId, name) {
    name = cleanName(name);
    let c = this.clients.get(clientId);
    if (c) {
      c.name = name;
      c.connected = true;
      c.lastSeen = Date.now();
    } else {
      c = {
        id: clientId,
        name,
        connected: true,
        joinedAt: Date.now(),
        lastSeen: Date.now(),
      };
      this.clients.set(clientId, c);
      this.system(`${name} joined the cabinet`);
    }
    for (const seat of [1, 2]) {
      const s = this.seats[seat];
      if (s && s.clientId === clientId) {
        s.name = name;
        s.connected = true;
        s.reservedUntil = 0;
        c.seat = seat;
      }
    }
    if (this.lastHostId === clientId) {
      // The host refreshed or briefly dropped; give the role back.
      this.hostId = clientId;
      this.lastHostId = null;
    }
    if (!this.hostId || !this.clients.has(this.hostId)) this.hostId = clientId;
    return c;
  }

  seatOf(clientId) {
    for (const seat of [1, 2]) {
      const s = this.seats[seat];
      if (s && s.clientId === clientId) return seat;
    }
    return 0;
  }

  takeSeat(clientId, seat) {
    seat = Number(seat);
    if (seat !== 1 && seat !== 2) return { ok: false, error: 'invalid seat' };
    const c = this.clients.get(clientId);
    if (!c) return { ok: false, error: 'join first' };
    const current = this.seats[seat];
    if (current && current.clientId !== clientId) {
      // A disconnected driver keeps a short reconnect grace. After that a new
      // driver may take the seat; the old client returns as a spectator.
      const graceOver = !current.connected && current.reservedUntil &&
        (current.reservedUntil - Date.now()) < (RESERVE_MS - 5000);
      if (!graceOver) return { ok: false, error: 'seat taken' };
    }
    const old = this.seatOf(clientId);
    if (old) this.seats[old] = null;
    this.seats[seat] = {
      clientId,
      name: c.name,
      ready: false,
      connected: true,
      reservedUntil: 0,
      since: Date.now(),
    };
    c.seat = seat;
    this.system(`${c.name} took P${seat}`);
    return { ok: true, seat };
  }

  leaveSeat(clientId) {
    const seat = this.seatOf(clientId);
    if (!seat) return false;
    const c = this.clients.get(clientId);
    this.seats[seat] = null;
    if (c) c.seat = 0;
    this.system(`${c?.name || 'DRIVER'} left P${seat}`);
    return true;
  }

  setReady(clientId, value) {
    const seat = this.seatOf(clientId);
    if (!seat) return false;
    const s = this.seats[seat];
    s.ready = !!value;
    return true;
  }

  setPhase(phase, countdown = 0) {
    this.phase = phase;
    this.countdown = countdown;
    if (phase === 'race') this.raceStartedAt = Date.now();
  }

  allReady() {
    return !!(this.seats[1]?.ready && this.seats[2]?.ready &&
      this.seats[1]?.connected && this.seats[2]?.connected);
  }

  disconnect(clientId) {
    const c = this.clients.get(clientId);
    if (!c) return;
    c.connected = false;
    c.lastSeen = Date.now();
    const seat = this.seatOf(clientId);
    if (seat) {
      const s = this.seats[seat];
      s.connected = false;
      s.reservedUntil = Date.now() + RESERVE_MS;
      s.ready = false;
    }
    this.system(`${c.name} left the cabinet`);
    if (this.hostId === clientId) {
      this.lastHostId = clientId;
      this.hostId = null;
      const candidates = [...this.clients.values()]
        .filter(x => x.connected && x.id !== clientId)
        .sort((a, b) => (this.seatOf(b.id) ? 1 : 0) - (this.seatOf(a.id) ? 1 : 0) || a.joinedAt - b.joinedAt);
      if (candidates.length) this.hostId = candidates[0].id;
    }
    // Drop reservations after the grace period.
    setTimeout(() => {
      for (const seat of [1, 2]) {
        const s = this.seats[seat];
        if (s && s.clientId === clientId && !s.connected && s.reservedUntil && s.reservedUntil <= Date.now()) {
          this.seats[seat] = null;
        }
      }
    }, RESERVE_MS + 1000).unref?.();
  }

  chatMessage(clientId, text) {
    const c = this.clients.get(clientId);
    if (!c) return null;
    const now = Date.now();
    const last = this.nextChatAt.get(clientId) || 0;
    if (now < last) return null;
    this.nextChatAt.set(clientId, now + 900);
    text = cleanChat(text);
    if (!text) return null;
    const msg = { id: `${now}-${Math.random().toString(36).slice(2, 7)}`, name: c.name, text, at: now, system: false };
    this.chat.push(msg);
    if (this.chat.length > MAX_CHAT) this.chat.shift();
    return msg;
  }

  system(text) {
    const msg = { id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`, name: 'SYSTEM', text, at: Date.now(), system: true };
    this.chat.push(msg);
    if (this.chat.length > MAX_CHAT) this.chat.shift();
    return msg;
  }

  state(viewerId) {
    const seats = {};
    for (const seat of [1, 2]) {
      const s = this.seats[seat];
      seats[seat] = s ? {
        seat,
        name: s.name,
        ready: s.ready,
        connected: s.connected,
        mine: s.clientId === viewerId,
        reserved: !s.connected,
      } : { seat, name: null, ready: false, connected: false, mine: false, reserved: false };
    }
    const viewers = [...this.clients.values()].filter(c => c.connected);
    return {
      name: this.name,
      hostId: this.hostId,
      youAreHost: this.hostId === viewerId,
      mySeat: this.seatOf(viewerId),
      phase: this.phase,
      countdown: this.countdown,
      raceStartedAt: this.raceStartedAt,
      allReady: this.allReady(),
      seats,
      viewers: viewers.map(c => ({
        id: c.id,
        name: c.name,
        seat: this.seatOf(c.id),
        host: c.id === this.hostId,
      })),
      chat: this.chat.slice(-40),
    };
  }
}
