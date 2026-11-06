/* Race Day — LFG panel (`/race-day`).
 *
 * Owns exactly the "looking for group" experience from
 * `_runtime/analysis/20-mmo-contract.md` §4.2 / §5:
 *   - the primary queue button (`#mmoLfgBtn`), queue position + local ETA,
 *   - the fill meter (`#mmoFill`) with the MIN_DRIVERS marker,
 *   - "start now" (`#mmoStart`) labelled `START WITH <n>`,
 *   - the bots demo toggle (`#mmoBots`) + `config {bots}` frame,
 *   - the party box (`#mmoParty`, `#mmoPartyCode`, `#mmoCopyLink`),
 *   - the seat strip (`#mmoSeat`, `#mmoTeam`, only when it differs from
 *     mmo-ui.js's write) and the callsign field (`#mmoName`).
 *
 * It never renders the grid / standings / results / feed (mmo-ui.js owns
 * those), never rebuilds the shell markup, never uses innerHTML with a value
 * that came off the wire, and does nothing at all when an id is missing.
 *
 * Frames it sends (contract §3.1): `queue`, `unqueue`, `start`,
 * `party:create`, `party:join`, `config {bots}`.
 */

const NAME_KEY = 'rr4.mmo.name';
const BOTS_KEY = 'rr4.mmo.bots';

const BUSY_PHASES = new Set(['grid', 'countdown', 'racing', 'results']);
const DEFAULT_MAX = 50;
const DEFAULT_MIN = 4;
const ERROR_MS = 15000; // how long a server error line stays up
const COPIED_MS = 1600; // "COPIED" flash on the invite button
const SAVED_MS = 2500; // "NAME SAVED" flash on the callsign field
const BOTS_HOLD_MS = 4000; // an optimistic bots flip survives at most this long
const CONFIG_ERR_MS = 2000; // an error this soon after `config` is a refusal
const SLOW_MS = 1000; // "SLOW DOWN" flash for error.code=rate
const PARTY_INPUT_MIN = 4;
const PARTY_INPUT_MAX = 6;
const EMPTY = '—';

/* ---------- tiny helpers (no DOM writes with user data) ------------------ */

function num(value, fallback) {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function clampInt(value, lo, hi, fallback) {
  const n = typeof value === 'number' && Number.isFinite(value) ? Math.round(value) : fallback;
  return Math.min(hi, Math.max(lo, n));
}

function fmtMmSs(ms) {
  const total = Math.max(0, Math.ceil(num(ms, 0) / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

function partyCodeOf(value, len = 6) {
  return String(value || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, len);
}

function readStore(key) {
  try { return (typeof localStorage !== 'undefined' ? localStorage.getItem(key) : '') || ''; } catch { return ''; }
}

function writeStore(key, value) {
  try { if (typeof localStorage !== 'undefined') localStorage.setItem(key, String(value)); } catch { /* private mode */ }
}

function readParam(name) {
  try { return new URLSearchParams(String(location.search || '')).get(name); } catch { return null; }
}

const $id = (id) => {
  try { return document.getElementById(id); } catch { return null; }
};

function setText(el, text) {
  if (!el) return false;
  const value = String(text);
  if (el.textContent === value) return false;
  el.textContent = value; // text only — never innerHTML
  return true;
}

function setAttr(el, name, value) {
  if (!el) return false;
  if (value === null || value === undefined || value === false) {
    if (!el.hasAttribute(name)) return false;
    el.removeAttribute(name);
    return true;
  }
  if (el.getAttribute(name) === String(value)) return false;
  el.setAttribute(name, String(value));
  return true;
}

function keepText(el, text, equivalents) {
  // "Do not fight ui-main": if the node already shows one of the accepted
  // spellings (mmo-ui.js writes the bare seat number / the brand name), leave it.
  if (!el) return false;
  const current = String(el.textContent || '').trim();
  for (const form of equivalents || []) {
    if (current === form) return false;
  }
  return setText(el, text);
}

function firstTextNode(el) {
  if (!el) return null;
  return Array.prototype.find.call(el.childNodes || [], (n) => n && n.nodeType === 3) || null;
}

function button(label, className, attrs) {
  const el = document.createElement('button');
  el.type = 'button';
  if (className) el.className = className;
  el.textContent = label;
  for (const [k, v] of Object.entries(attrs || {})) el.setAttribute(k, v);
  return el;
}

function insertAfter(refEl, el) {
  if (!refEl || !refEl.parentNode || !el) return el;
  refEl.parentNode.insertBefore(el, refEl.nextSibling);
  return el;
}

/* ---------- mount -------------------------------------------------------- */

export function mountLfg(root, clientArg) {
  if (typeof document === 'undefined') return null;
  const scope = (typeof root === 'string' ? document.querySelector(root) : root) || $id('mmoLfg');
  if (!scope) return null;
  if (scope.__mmoLfg) return scope.__mmoLfg;

  let client = clientArg || (typeof window !== 'undefined' && window.__R4_MMO ? window.__R4_MMO.client : null) || null;
  let mounted = true;
  let unsubscribe = null;
  let ticker = 0;
  let destroyPoll = 0;

  const el = {
    app: $id('mmoApp'),
    panel: $id('mmoLfg') || scope,
    btn: $id('mmoLfgBtn'),
    queue: $id('mmoLfgQueue'),
    fill: $id('mmoFill'),
    eta: $id('mmoEta'),
    start: $id('mmoStart'),
    bots: $id('mmoBots'),
    party: $id('mmoParty'),
    code: $id('mmoPartyCode'),
    copy: $id('mmoCopyLink'),
    seat: $id('mmoSeat'),
    team: $id('mmoTeam'),
    badge: $id('mmoQualityBadge'),
    name: $id('mmoName'),
  };

  /* ---- local intent (the server stays the source of truth) ---- */
  const local = {
    wantQueued: false,
    queuedAt: 0,
    etaRef: null, // identity of the last state.queue object we stamped
    etaMs: null,
    etaAt: 0,
    spectating: readParam('spectate') === '1',
    // `bots` is the last value we showed (localStorage is written from it);
    // `botsConfirmed` is the last value a server snapshot confirmed, and
    // `botsIntent` is the optimistic flip that only lives until a snapshot
    // agrees with it or BOTS_HOLD_MS passes. `botsChosen` says the driver (or
    // `?bots=1`) actually picked a value, so a fresh browser follows the
    // server instead of forcing its empty localStorage onto everyone.
    bots: readStore(BOTS_KEY) === '1' || readParam('bots') === '1',
    botsChosen: readStore(BOTS_KEY) === '0' || readStore(BOTS_KEY) === '1' || readParam('bots') === '1',
    botsConfirmed: undefined,
    botsIntent: null,
    botsToggle: null,
    botsReasserted: true,
    configAt: 0,
    configUnsupported: false,
    configHintAt: 0,
    slowUntil: 0,
    slowTimer: 0,
    nameSavedAt: 0,
    error: null,
    errorAt: 0,
    copiedTimer: 0,
    flashTimer: 0,
    statusHoldUntil: 0,
    partyCode: '',
    lastConn: '',
  };

  /* ---- my own nodes (the shell owns its markup, we only add) ---- */
  const mine = {};

  function build() {
    // fill meter: the progressbar is the shell's .mmo-fill-track; the MIN
    // marker has to live inside it so its % position matches the bar.
    if (el.fill) {
      mine.progress = el.fill.querySelector('[role="progressbar"]')
        || (el.fill.getAttribute('role') === 'progressbar' ? el.fill : el.fill.querySelector('.mmo-fill-track'));
      mine.bar = el.fill.querySelector('[data-mmo-fill-bar]');
      mine.fillText = el.fill.querySelector('[data-mmo-fill-text]');
      if (!mine.fillText) {
        mine.fillText = document.createElement('span');
        mine.fillText.className = 'mmo-fill-text';
        mine.fillText.setAttribute('data-mmo-fill-text', '');
        el.fill.appendChild(mine.fillText);
      }
      if (mine.progress) {
        setAttr(mine.progress, 'role', 'progressbar');
        setAttr(mine.progress, 'aria-label', 'Grid fill');
        setAttr(mine.progress, 'aria-valuemin', '0');
        if (!mine.progress.querySelector('[data-mmo-min-mark]')) {
          const mark = document.createElement('span');
          mark.className = 'mmo-lfg-minmark';
          mark.setAttribute('data-mmo-min-mark', '');
          const tip = document.createElement('b');
          tip.className = 'mmo-lfg-minmark-tip';
          tip.textContent = 'MIN 4';
          mark.appendChild(tip);
          mine.progress.appendChild(mark);
          mine.minMark = mark;
          mine.minTip = tip;
        } else {
          mine.minMark = mine.progress.querySelector('[data-mmo-min-mark]');
          mine.minTip = mine.minMark.querySelector('.mmo-lfg-minmark-tip');
        }
      }
    }

    // offline / retry row, right under the primary button
    if (el.btn && el.btn.parentNode && !el.btn.parentNode.querySelector('[data-mmo-lfg-conn]')) {
      const row = document.createElement('p');
      row.className = 'mmo-lfg-conn';
      row.setAttribute('data-mmo-lfg-conn', '');
      row.hidden = true;
      const text = document.createElement('span');
      text.setAttribute('data-mmo-lfg-conn-text', '');
      text.textContent = 'OFFLINE — RACE DAY UNREACHABLE';
      const retry = button('RECONNECT', 'mmo-btn mmo-btn--tiny', { 'data-mmo-reconnect': '' });
      retry.addEventListener('click', () => {
        if (client && typeof client.connect === 'function') client.connect();
      });
      row.append(text, retry);
      insertAfter(el.btn, row);
      mine.connRow = row;
      mine.connText = text;
      mine.retry = retry;
    }

    // "starts with n/50 — empty seats stay open" + the bots explainer.
    // Both reserve their line so nothing jumps when a label appears.
    const actions = el.panel ? el.panel.querySelector('.mmo-lfg-actions') : null;
    if (actions && !actions.parentNode.querySelector('[data-mmo-lfg-honest]')) {
      const honest = document.createElement('p');
      honest.className = 'mmo-lfg-honest';
      honest.setAttribute('data-mmo-lfg-honest', '');
      honest.setAttribute('data-empty', '1');
      const botsNote = document.createElement('p');
      botsNote.className = 'mmo-lfg-note';
      botsNote.setAttribute('data-mmo-bots-note', '');
      botsNote.setAttribute('data-on', '0');
      botsNote.textContent = 'Bots fill empty seats so one human can demo a full grid — every bot is labelled BOT.';
      const err = document.createElement('p');
      err.className = 'mmo-lfg-error';
      err.setAttribute('data-mmo-lfg-error', '');
      err.setAttribute('role', 'status');
      err.hidden = true;
      const anchor = actions.parentNode.insertBefore(honest, actions.nextSibling);
      insertAfter(anchor, botsNote);
      insertAfter(botsNote, err);
      mine.honest = honest;
      mine.botsNote = botsNote;
      mine.errorLine = err;
    }

    // callsign hint ("saved · reload to rename")
    if (el.name && el.name.parentNode && !el.name.parentNode.parentNode.querySelector('[data-mmo-name-hint]')) {
      const hint = document.createElement('span');
      hint.className = 'mmo-lfg-namehint';
      hint.setAttribute('data-mmo-name-hint', '');
      hint.textContent = '';
      el.name.parentNode.parentNode.insertBefore(hint, el.name.parentNode.nextSibling);
      mine.nameHint = hint;
    }

    // party controls (CREATE / JOIN <code>) + status + note
    if (el.party && !el.party.querySelector('[data-mmo-party-actions]')) {
      const rowEl = el.party.querySelector('.mmo-party-row');
      const actions2 = document.createElement('div');
      actions2.className = 'mmo-lfg-party-actions';
      actions2.setAttribute('data-mmo-party-actions', '');
      const create = button('CREATE PARTY', 'mmo-btn mmo-btn--tiny', { 'data-mmo-party-create': '' });
      const label = document.createElement('label');
      label.className = 'mmo-lfg-party-code';
      const sr = document.createElement('span');
      sr.className = 'mmo-sr';
      sr.textContent = 'PARTY CODE';
      const input = document.createElement('input');
      input.type = 'text';
      input.id = 'mmoLfgPartyInput';
      input.className = 'mmo-lfg-party-input';
      // mmo.js issues 5-char codes and accepts up to 6, so the field must not
      // truncate what the driver typed: 4-6 alphanumerics, upper-cased.
      input.maxLength = PARTY_INPUT_MAX;
      input.autocomplete = 'off';
      input.spellcheck = false;
      input.placeholder = 'ABCDE';
      input.setAttribute('data-mmo-party-input', '');
      input.setAttribute('aria-label', `party code (${PARTY_INPUT_MIN} to ${PARTY_INPUT_MAX} characters)`);
      const join = button('JOIN', 'mmo-btn mmo-btn--tiny', { 'data-mmo-party-join': '' });
      label.append(sr, input);
      actions2.append(create, label, join);

      const status = document.createElement('p');
      status.className = 'mmo-lfg-party-status';
      status.setAttribute('data-mmo-party-status', '');
      status.setAttribute('aria-live', 'polite');
      status.textContent = 'SOLO — NO PARTY';

      const note = document.createElement('p');
      note.className = 'mmo-lfg-party-note';
      note.setAttribute('data-mmo-party-note', '');
      note.textContent = 'Party of 2 rides the same race and, when possible, the same team.';

      if (rowEl && rowEl.parentNode === el.party) el.party.insertBefore(actions2, rowEl);
      else el.party.appendChild(actions2);
      const hint = el.party.querySelector('.mmo-party-hint');
      if (hint) {
        insertAfter(hint, status);
        insertAfter(status, note);
      } else {
        el.party.append(status, note);
      }

      mine.partyActions = actions2;
      mine.partyCreate = create;
      mine.partyInput = input;
      mine.partyJoin = join;
      mine.partyStatus = status;
      mine.partyNote = note;

      create.addEventListener('click', () => {
        setPartyStatus('CREATING PARTY…');
        sendFrameParty('create');
      });
      join.addEventListener('click', () => {
        // Normalise (upper-case, drop spaces) but send every character the
        // server issued: mmo-client.js normalises to 5, mmo.js answers 5-char
        // codes and still accepts the 6 the field allows.
        const code = partyCodeOf(input.value, PARTY_INPUT_MAX);
        if (code.length < PARTY_INPUT_MIN) {
          setPartyStatus(`${PARTY_INPUT_MIN}-CHARACTER CODE NEEDED`);
          input.focus();
          return;
        }
        setPartyStatus(`JOINING ${code}…`);
        sendFrameParty('join', code);
      });
      input.addEventListener('input', () => {
        const clean = partyCodeOf(input.value, PARTY_INPUT_MAX);
        if (input.value !== clean) input.value = clean;
      });
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { e.preventDefault(); join.click(); }
      });
    }

    // bots badge in the header status slot, beside #mmoQualityBadge
    if (el.badge && el.badge.parentNode && !el.badge.parentNode.querySelector('[data-mmo-bots-badge]')) {
      const badge = document.createElement('span');
      badge.className = 'mmo-qbadge mmo-lfg-demo';
      badge.setAttribute('data-mmo-bots-badge', '');
      badge.textContent = 'DEMO — BOTS ON';
      badge.hidden = true;
      insertAfter(el.badge, badge);
      mine.botsBadge = badge;
    }
  }

  function sendFrameParty(mode, code) {
    // Not client.setParty(): it truncates to 4 chars, and `_server/src/mmo.js`
    // issues 5-char codes (`partyCode()` loops 5). Send the code as issued.
    if (mode === 'create') {
      if (sendFrame('party:create', {})) return true;
    } else if (sendFrame('party:join', code ? { code } : {})) {
      return true;
    }
    if (typeof client?.setParty === 'function') client.setParty(mode, code);
    return false;
  }

  function sendFrame(type, payload) {
    try {
      if (client && typeof client.send === 'function') return client.send(type, payload);
    } catch { /* a dead socket is the reconnect row's problem */ }
    return false;
  }

  function setPartyStatus(text, holdMs = 4000) {
    setText(mine.partyStatus, text);
    local.statusHoldUntil = Date.now() + holdMs;
  }

  /* ---- derived view ---------------------------------------------------- */

  function viewOf(state) {
    const s = state && typeof state === 'object' ? state : {};
    const event = s.event && typeof s.event === 'object' ? s.event : {};
    const counts = event.counts && typeof event.counts === 'object' ? event.counts : {};
    const q = s.queue && typeof s.queue === 'object' ? s.queue : {};
    const you = s.you && typeof s.you === 'object' ? s.you : {};

    const max = clampInt(counts.max, 1, 1000, DEFAULT_MAX);
    const min = clampInt(counts.min, 0, max, DEFAULT_MIN);
    const seated = clampInt(counts.seated, 0, max, 0);
    const phase = typeof event.state === 'string' && event.state ? event.state : 'lobby';
    const busy = BUSY_PHASES.has(phase);
    const conn = typeof s.conn === 'string' ? s.conn : 'closed';
    const attempt = clampInt(s.attempt, 0, 9999, 0);

    const mySeat = typeof you.seat === 'number' && you.seat > 0 ? Math.round(you.seat) : null;
    const position = clampInt(q.position, 0, 100000, 0);
    const size = clampInt(num(q.size, counts.queued), 0, 100000, 0);

    const queued = local.wantQueued || position > 0 || (mySeat !== null && phase === 'lobby');
    const remainingMs = (() => {
      if (q.etaMs === null || q.etaMs === undefined) return null;
      const base = num(q.etaMs, null);
      if (base === null) return null;
      const age = local.etaRef === q ? Math.max(0, Date.now() - local.etaAt) : 0;
      return Math.max(0, base - age);
    })();
    const queuedMs = queued && local.queuedAt ? Math.max(0, Date.now() - local.queuedAt) : 0;

    const team = typeof you.team === 'string' ? you.team.trim() : '';
    // local.partyCode remembers the full code the server issued: mmo-client.js
    // truncates party codes to 4 chars in its `queue` branch, and mmo.js issues
    // 5-char codes (partyCode()), so the raw state can show a prefix only.
    const partyCode = partyCodeOf(local.partyCode);
    const partySize = clampInt(num((s.party && s.party.size), num((q.party && q.party.size), partyCode ? 1 : 0)), 0, 2, 0);

    return {
      conn, attempt, phase, busy, max, min, seated, position, size, queued, queuedMs,
      remainingMs, mySeat, team, partyCode, partySize,
      spectating: local.spectating && mySeat === null,
      error: local.error,
    };
  }

  /* ---- paint: primary button ------------------------------------------- */

  function paintPrimary(v) {
    const btn = el.btn;
    if (!btn) return;
    const offline = v.conn !== 'open';
    let label;
    if (offline) {
      label = v.conn === 'connecting' ? 'CONNECTING…'
        : v.conn === 'reconnecting' ? `RECONNECTING ${v.attempt || ''}`.trim()
          : 'OFFLINE';
    } else if (v.spectating) {
      label = 'TAKE A SEAT NEXT RACE';
    } else if (v.queued) {
      label = 'LEAVE QUEUE';
    } else if (v.busy) {
      label = 'JOIN NEXT RACE';
    } else {
      label = 'FIND ME A RACE';
    }
    setText(btn, label);
    setAttr(btn, 'data-mode', offline ? 'offline' : v.spectating ? 'seat' : v.queued ? 'leave' : v.busy ? 'next' : 'find');
    setAttr(btn, 'aria-label', offline
      ? `Connection ${v.conn}`
      : v.spectating ? 'Take a seat in the next race'
        : v.queued ? 'Leave the queue'
          : v.busy ? 'Queue for the next race' : 'Find me a race');
    const title = v.busy
      ? 'RACE IN PROGRESS — QUEUE JOINS THE NEXT ONE'
      : v.queued ? 'Leave the queue (Esc)'
        : v.spectating ? 'Give up watching and take the next open seat'
          : 'Join the 50-driver queue';
    setAttr(btn, 'title', title);
    btn.disabled = offline;
  }

  /* ---- paint: queue line + ETA ----------------------------------------- */

  function paintQueueLine(v) {
    if (!el.queue) return;
    setAttr(el.queue, 'aria-live', 'polite');
    const parts = [];
    if (v.spectating && !v.queued) {
      parts.push('WATCHING');
    } else if (v.queued) {
      parts.push(v.position === 1 ? 'NEXT IN' : v.position > 1 ? `#${v.position} IN QUEUE` : 'IN QUEUE');
      parts.push(`QUEUED ${fmtMmSs(v.queuedMs)}`);
    } else {
      parts.push('NOT IN QUEUE');
      if (v.size > 0) parts.push(`${v.size} WAITING`);
    }
    setText(el.queue, parts.join(' · '));
    setAttr(el.queue, 'data-queued', v.queued ? '1' : '0');
  }

  function paintEta(v) {
    const b = el.eta;
    if (!b) return;
    const paragraph = b.parentNode;
    setAttr(b, 'aria-live', 'polite');
    setAttr(b, 'aria-atomic', 'true');
    let lead = 'STARTS IN';
    let value;
    if (v.phase === 'countdown' || v.phase === 'grid') {
      lead = '';
      value = 'GRID LOCKED';
    } else if (v.phase === 'racing' || v.phase === 'results') {
      lead = '';
      value = 'NEXT RACE QUEUE OPEN';
    } else if (v.remainingMs === null) {
      value = '--:--';
    } else if (v.remainingMs === 0) {
      // The server sends etaMs 0 once the driver is seated / the fill window
      // expired: "STARTS IN 00:00" would be a lie, the grid just needs filling.
      lead = '';
      value = 'WAITING FOR THE GRID';
    } else {
      value = fmtMmSs(v.remainingMs);
    }
    if (paragraph) {
      const node = firstTextNode(paragraph);
      if (node) {
        const next = lead ? `${lead} ` : '';
        if (node.nodeValue !== next) node.nodeValue = next;
      } else if (lead) {
        paragraph.insertBefore(document.createTextNode(`${lead} `), b);
      }
    }
    setText(b, value);
    setAttr(b, 'data-mode', v.phase === 'countdown' || v.phase === 'grid'
      ? 'locked'
      : (v.phase === 'racing' || v.phase === 'results' ? 'next' : 'eta'));
  }

  function paintFill(v) {
    if (!el.fill) return;
    const pct = v.max > 0 ? Math.max(0, Math.min(100, (v.seated / v.max) * 100)) : 0;
    if (mine.bar) {
      const width = `${Math.round(pct * 10) / 10}%`;
      if (mine.bar.style.width !== width) mine.bar.style.width = width;
      setAttr(mine.bar, 'data-pct', String(Math.round(pct)));
    }
    setText(mine.fillText, `${v.seated} / ${v.max} SEATED`);
    setAttr(el.fill, 'data-mmo-fill', `${v.seated}/${v.max}`);
    const bar = mine.progress;
    if (bar) {
      setAttr(bar, 'role', 'progressbar');
      setAttr(bar, 'aria-label', 'Grid fill');
      setAttr(bar, 'aria-valuemin', '0');
      setAttr(bar, 'aria-valuemax', String(v.max));
      setAttr(bar, 'aria-valuenow', String(v.seated));
      setAttr(bar, 'aria-valuetext', `${v.seated} of ${v.max} seated`);
      setAttr(bar, 'data-full', v.seated >= v.max ? '1' : '0');
    }
    if (mine.minMark) {
      const show = v.min > 0 && v.max > 0 && v.min <= v.max;
      if (mine.minMark.hidden === show) mine.minMark.hidden = !show;
      if (!show) {
        setAttr(mine.minMark, 'aria-hidden', 'true');
      } else {
        const left = `${Math.round((v.min / v.max) * 1000) / 10}%`;
        if (mine.minMark.style.left !== left) mine.minMark.style.left = left;
        setAttr(mine.minMark, 'data-min', String(v.min));
        setText(mine.minTip, `MIN ${v.min}`);
      }
    }
  }

  /* ---- paint: start now + honest line ---------------------------------- */

  function paintStart(v) {
    const btn = el.start;
    const canStart = v.phase === 'lobby' && v.min > 0 && v.size >= v.min;
    if (btn) {
      setText(btn, `START WITH ${v.size}`);
      setAttr(btn, 'data-need', String(v.min));
      setAttr(btn, 'title', canStart
        ? `Start now with ${v.size} of ${v.max} drivers`
        : `Needs ${v.min} drivers — ${v.size} queued`);
      setAttr(btn, 'aria-label', canStart
        ? `Start now with ${v.size} drivers`
        : `Start now needs ${v.min} drivers, ${v.size} queued`);
      if (btn.disabled === canStart) btn.disabled = !canStart;
    }
    if (mine.honest) {
      const show = v.size >= 2;
      setText(mine.honest, show ? `STARTS WITH ${v.size}/${v.max} — EMPTY SEATS STAY OPEN` : '');
      setAttr(mine.honest, 'data-empty', show ? '0' : '1');
    }
  }

  /* ---- paint: bots ------------------------------------------------------ */

  // The server is the source of truth for the toggle. In order: a `bots`
  // boolean on the client state (a newer mmo-client.js may expose one), then
  // the last confirmed `event.counts.bots`, then localStorage (`?bots=1` seeds
  // it). `counts.bots > 0` is the seat count the server actually broadcasts.
  function confirmedBots(s) {
    const st = s && typeof s === 'object' ? s : {};
    const event = st.event && typeof st.event === 'object' ? st.event : null;
    // `emptyState()` ships `counts.bots:false` before the first frame; only
    // trust a snapshot once the server has actually answered (an event id).
    const live = Boolean(event && event.id != null);
    if (live && typeof st.bots === 'boolean') return st.bots;
    if (live && event) {
      if (typeof event.bots === 'boolean') return event.bots;
      const counts = event.counts && typeof event.counts === 'object' ? event.counts : null;
      if (counts && typeof counts.bots === 'boolean') return counts.bots;
      if (counts && typeof counts.bots === 'number' && Number.isFinite(counts.bots)) return counts.bots > 0;
    }
    if (!live) return undefined;
    const top = st.counts && typeof st.counts === 'object' ? st.counts : null;
    if (top && typeof top.bots === 'boolean') return top.bots;
    if (top && typeof top.bots === 'number' && Number.isFinite(top.bots)) return top.bots > 0;
    return undefined;
  }

  // Painted on/off. The optimistic flip (and a refusal revert) is an *intent*
  // that only survives until a snapshot agrees with it or BOTS_HOLD_MS passes,
  // so the attribute can never diverge from the server permanently.
  function botsOn(s) {
    const confirmed = confirmedBots(s);
    if (typeof confirmed === 'boolean') local.botsConfirmed = confirmed;
    // `event.counts.bots` is a *seat count*, and mid-race the server keeps the
    // bots on track after `config {bots:false}` ("they finish the race they
    // started"), so it can only stand in for the toggle during the lobby.
    const phase = s && s.event && typeof s.event.state === 'string' ? s.event.state : 'lobby';
    const inLobby = phase === 'lobby';
    // A server that ignores `config` is the other case where its seat count
    // says nothing about the toggle: the driver's stored choice wins there.
    const truth = (local.configUnsupported || !inLobby || typeof local.botsConfirmed !== 'boolean')
      ? local.bots
      : local.botsConfirmed;
    const intent = local.botsIntent;
    if (intent) {
      if (truth === intent.value) {
        local.botsIntent = null;
        if (!intent.revert) local.configUnsupported = false; // the frame landed
      } else if (Date.now() - intent.at > BOTS_HOLD_MS) {
        local.botsIntent = null; // no permanent divergence
      } else {
        return intent.value;
      }
    }
    return truth;
  }

  function paintBots(v, s) {
    let on = botsOn(s);
    // One correction per connection when the driver's stored choice disagrees
    // with what the welcome just confirmed (a restarted server, a reconnect).
    // Without this the panel would show the server's value and forget the
    // driver's own pick; sending it on every connect instead burns the 1/s
    // `config` budget before the driver can touch the toggle.
    const phase = s && s.event && typeof s.event.state === 'string' ? s.event.state : 'lobby';
    if (!local.botsIntent && local.botsReasserted === false && local.botsChosen
      && !local.configUnsupported && phase === 'lobby' && typeof local.botsConfirmed === 'boolean'
      && local.botsConfirmed !== local.bots) {
      local.botsReasserted = true;
      local.botsIntent = { value: local.bots, at: Date.now(), revert: false };
      sendConfig(local.bots);
      on = botsOn(s);
    }
    if (!local.botsIntent && on !== local.bots) {
      local.bots = on;
      writeStore(BOTS_KEY, on ? '1' : '0');
    }
    const btn = el.bots;
    if (btn) {
      setText(btn, on ? 'BOTS ON' : 'BOTS OFF');
      setAttr(btn, 'aria-pressed', on ? 'true' : 'false');
      setAttr(btn, 'data-on', on ? '1' : '0');
      setAttr(btn, 'title', local.configUnsupported
        ? 'The server ignores config {bots} — enable bots with ?bots=1 or RR4_MMO_BOTS=1'
        : 'Fills empty seats with bots so one driver can demo a full grid');
    }
    if (mine.botsBadge) mine.botsBadge.hidden = !on;
    if (mine.botsNote) {
      setAttr(mine.botsNote, 'data-on', on ? '1' : '0');
      setText(mine.botsNote, local.configUnsupported
        ? 'This server ignores config {bots} — use ?bots=1 or RR4_MMO_BOTS=1 to fill the grid.'
        : 'Bots fill empty seats so one human can demo a full grid — every bot is labelled BOT.');
    }
  }

  /* ---- paint: party ---------------------------------------------------- */

  function paintParty(v) {
    const code = v.partyCode;
    if (el.code) setText(el.code, code || '----');
    if (el.copy) {
      setText(el.copy, mine.copyLabel || 'COPY INVITE LINK');
      setAttr(el.copy, 'aria-label', code ? `Copy the invite link for party ${code}` : 'Create or join a party first');
      el.copy.disabled = !code;
    }
    if (mine.partyStatus) {
      const text = code ? `PARTY ${code} · ${v.partySize}/2` : 'SOLO — NO PARTY';
      // A transient "JOINING ABCD…" / "CREATING…" line holds only until the
      // party actually exists; a real code always wins.
      const hold = !code && local.statusHoldUntil && Date.now() < local.statusHoldUntil;
      if (!hold) {
        local.statusHoldUntil = 0;
        setText(mine.partyStatus, text);
      }
      if (code && mine.partyInput && mine.partyInput.value !== code) mine.partyInput.value = code;
    }
    setAttr(el.party, 'data-code', code || null);
    setAttr(el.party, 'data-size', String(v.partySize || 0));
  }

  /* ---- paint: seat strip ----------------------------------------------- */

  function paintSeat(v) {
    const seatEl = document && document.querySelector ? document.querySelector('[data-mmo-seat]') : null;
    const teamName = v.team ? v.team.toUpperCase() : '';
    const strip = v.mySeat === null
      ? (teamName ? `NO SEAT · ${teamName}` : 'NO SEAT')
      : `SEAT ${v.mySeat}${teamName ? ` · ${teamName}` : ''}`;
    if (seatEl) {
      const target = v.mySeat === null ? EMPTY : `SEAT ${v.mySeat}`;
      const equivalents = v.mySeat === null
        ? [EMPTY, '']
        : [String(v.mySeat), `SEAT ${v.mySeat}`];
      keepText(seatEl, target, equivalents);
    }
    if (el.team) {
      const target = teamName || 'NO TEAM';
      const equivalents = teamName
        ? [teamName, v.team]
        : ['NO TEAM', EMPTY, ''];
      keepText(el.team, target, equivalents);
      if (v.mySeat === null) setAttr(el.team, 'data-team', 'none');
    }
    if (el.seat) {
      setAttr(el.seat, 'data-mmo-seat-strip', strip);
      setAttr(el.seat, 'aria-label', strip);
    }
  }

  /* ---- paint: callsign ------------------------------------------------- */

  // mmo-client.js has setName(): the name is what `hello` sends, so an Enter
  // (or a blur) commits it in place — the field must not fall back to
  // "SAVED · RELOAD TO RENAME". localStorage keeps it for the next boot.
  function paintName() {
    if (!el.name) return;
    const current = String((client && client.state && client.state.name) || '');
    const typed = String(el.name.value || '').replace(/\s+/g, ' ').trim();
    const canRename = typeof client?.setName === 'function';
    let hint = '';
    if (local.nameSavedAt && Date.now() - local.nameSavedAt < SAVED_MS) hint = 'NAME SAVED';
    else if (typed && current && typed.toUpperCase() !== current.toUpperCase()) {
      hint = canRename ? 'PRESS ENTER TO SAVE' : 'RELOAD TO APPLY';
    }
    if (mine.nameHint) setText(mine.nameHint, hint);
  }

  function commitName() {
    if (!el.name) return '';
    const value = String(el.name.value || '').replace(/\s+/g, ' ').trim().slice(0, 20);
    if (!value) { paintName(); return ''; }
    if (el.name.value !== value) el.name.value = value;
    writeStore(NAME_KEY, value);
    const current = String((client && client.state && client.state.name) || '');
    if (typeof client?.setName === 'function' && value.toUpperCase() !== current.toUpperCase()) {
      try { client.setName(value); } catch { /* optional */ }
    }
    local.nameSavedAt = Date.now();
    paintName();
    return value;
  }

  /* ---- paint: connection, error, spectate ------------------------------ */

  function paintConn(v) {
    if (!mine.connRow) return;
    const offline = v.conn === 'closed';
    const retrying = v.conn === 'reconnecting' && v.attempt > 2;
    mine.connRow.hidden = !(offline || retrying);
    setText(mine.connText, offline
      ? 'OFFLINE — RACE DAY UNREACHABLE'
      : `RECONNECTING (ATTEMPT ${v.attempt})`);
    if (mine.retry) mine.retry.hidden = false;
  }

  function paintError(v) {
    if (!mine.errorLine) return;
    if (local.slowUntil && Date.now() < local.slowUntil) {
      setText(mine.errorLine, 'SLOW DOWN');
      mine.errorLine.hidden = false;
      setAttr(mine.errorLine, 'data-code', 'rate');
      return;
    }
    const err = v.error;
    const fresh = err && Date.now() - local.errorAt < ERROR_MS;
    if (!err || !fresh) {
      mine.errorLine.hidden = true;
      return;
    }
    // A refused `config {bots}` has one honest answer: this server is too old,
    // use ?bots=1 (or RR4_MMO_BOTS=1) until it learns the frame.
    const staleConfig = local.configUnsupported && local.configHintAt
      && Date.now() - local.configHintAt < ERROR_MS;
    const text = err.code === 'state' && staleConfig
      ? 'USE ?bots=1 — SERVER TOO OLD'
      : err.code === 'full'
        ? 'GRID FULL — QUEUE FOR THE NEXT RACE'
        : `${err.code === 'party' ? 'PARTY' : 'SERVER'} — ${String(err.message || err.code).toUpperCase()}`;
    setText(mine.errorLine, text);
    mine.errorLine.hidden = false;
    setAttr(mine.errorLine, 'data-code', err.code || null);
  }

  function paintSpectate(v) {
    setAttr(el.panel, 'data-spectating', v.spectating ? '1' : '0');
    setAttr(el.panel, 'data-phase', v.phase);
    setAttr(el.panel, 'data-conn', v.conn);
  }

  /* ---- paint ----------------------------------------------------------- */

  function paint(stateIn) {
    if (!mounted) return;
    const s = stateIn || (client && client.state) || (typeof window !== 'undefined' && window.__R4_MMO ? window.__R4_MMO.state : null) || {};
    stampQueue(s);
    rememberParty(s);
    const v = viewOf(s);
    paintPrimary(v);
    paintQueueLine(v);
    paintFill(v);
    paintEta(v);
    paintStart(v);
    paintBots(v, s);
    paintParty(v);
    paintSeat(v);
    paintName();
    paintConn(v);
    paintError(v);
    paintSpectate(v);
    return v;
  }

  function rememberParty(s) {
    const q = s && s.queue;
    const p = s && s.party;
    const incoming = partyCodeOf((p && p.code) || (q && q.party && q.party.code) || '');
    if (!incoming) { local.partyCode = ''; return; }
    if (!local.partyCode || incoming === local.partyCode) { local.partyCode = incoming; return; }
    if (incoming.length > local.partyCode.length && incoming.startsWith(local.partyCode)) {
      local.partyCode = incoming; // the full code arrived after a truncated echo
      return;
    }
    if (local.partyCode.startsWith(incoming)) return; // truncated echo of the code we hold
    local.partyCode = incoming; // a different party
  }

  function stampQueue(s) {
    const q = s && s.queue;
    if (!q || q === local.etaRef) return;
    local.etaRef = q;
    local.etaAt = Date.now();
    const pos = clampInt(q.position, 0, 100000, 0);
    if (pos > 0) {
      local.wantQueued = true;
      if (!local.queuedAt) local.queuedAt = Date.now();
    } else if (!local.spectating) {
      local.wantQueued = false;
      local.queuedAt = 0;
    }
    // A `full` refusal is answered by the next successful queue, not by any
    // other frame: only clear it once we actually hold a queue position.
    if (pos > 0 && local.error && local.error.code === 'full') {
      local.error = null;
      local.errorAt = 0;
    }
  }

  /* ---- events ---------------------------------------------------------- */

  function onPrimary() {
    if (!client) return;
    const v = viewOf(client.state);
    if (v.conn !== 'open') { if (typeof client.connect === 'function') client.connect(); return; }
    if (v.queued && !v.spectating) {
      local.wantQueued = false;
      local.queuedAt = 0;
      if (typeof client.unqueue === 'function') client.unqueue();
      else sendFrame('unqueue', {});
    } else {
      local.spectating = false; // TAKE A SEAT / JOIN NEXT RACE both queue
      local.wantQueued = true;
      local.queuedAt = Date.now();
      if (typeof client.queue === 'function') client.queue();
      else sendFrame('queue', {});
    }
    paint(client.state);
  }

  function onStart() {
    if (!client) return;
    if (typeof client.start === 'function') client.start();
    else sendFrame('start', { at: Date.now() });
  }

  function onBotsToggle() {
    const s = client && client.state;
    const before = botsOn(s);
    const want = !before;
    // Remember the pre-toggle value: a refusal must land back on it even if a
    // snapshot already echoed the optimistic value.
    local.botsToggle = { before, at: Date.now() };
    local.botsIntent = { value: want, at: Date.now(), revert: false };
    local.bots = want;
    local.botsChosen = true;
    local.botsReasserted = true;
    writeStore(BOTS_KEY, want ? '1' : '0');
    local.error = null;
    local.errorAt = 0;
    local.slowUntil = 0;
    local.configHintAt = 0;
    sendConfig(want);
    paint(s);
  }

  function sendConfig(want = local.bots) {
    // Contract §3.1 has no `config` row: a stale server answers
    // `error{code:'state'}`, and two toggles inside a second get
    // `error{code:'rate'}`. `onServerError` turns either into a revert.
    local.configAt = Date.now();
    return sendFrame('config', { bots: Boolean(want) });
  }

  // The server refused the toggle: put the switch back where it was, and say
  // why. Never leave the panel claiming bots are on when the server said no.
  function revertBots(kind) {
    const intent = local.botsIntent;
    const toggle = local.botsToggle;
    const now = Date.now();
    let before;
    if (intent && !intent.revert) before = !intent.value; // undo our own flip
    else if (toggle && now - toggle.at < 10000) before = toggle.before; // the flip already acked
    else if (typeof local.botsConfirmed === 'boolean') before = local.botsConfirmed; // server truth
    else before = local.bots;
    local.botsToggle = null;
    local.botsIntent = { value: Boolean(before), at: now, revert: true };
    local.bots = Boolean(before);
    writeStore(BOTS_KEY, local.bots ? '1' : '0');
    local.configAt = 0;
    if (kind === 'rate') {
      local.slowUntil = now + SLOW_MS;
      local.error = null;
      local.errorAt = 0;
      if (local.slowTimer) clearTimeout(local.slowTimer);
      local.slowTimer = setTimeout(() => {
        local.slowTimer = 0;
        local.slowUntil = 0;
        if (mounted) paint(client && client.state);
      }, SLOW_MS + 60);
      return;
    }
    local.configUnsupported = true;
    local.configHintAt = now;
    local.error = { code: 'state', message: 'use ?bots=1' };
    local.errorAt = now;
  }

  function onNameInput() {
    if (!el.name) return;
    // Every keystroke is remembered (a reload keeps the callsign), but the
    // state only changes on Enter / blur, where commitName() calls setName().
    const value = String(el.name.value || '').replace(/\s+/g, ' ').trim().slice(0, 20);
    if (value) writeStore(NAME_KEY, value);
    paintName();
  }

  async function copyInvite() {
    const code = partyCodeOf(local.partyCode
      || (client && client.state && client.state.party && client.state.party.code)
      || (client && client.state && client.state.queue && client.state.queue.party && client.state.queue.party.code)
      || (mine.partyInput && mine.partyInput.value) || '');
    if (!code) return false;
    const origin = (typeof location !== 'undefined' && location.origin && location.origin !== 'null')
      ? location.origin
      : 'http://127.0.0.1:8080';
    const url = `${origin}/race-day?party=${code}`;
    let ok = false;
    try {
      if (typeof navigator !== 'undefined' && navigator.clipboard && navigator.clipboard.writeText) {
        await navigator.clipboard.writeText(url);
        ok = true;
      }
    } catch { ok = false; }
    if (!ok) ok = execCopy(url);
    flashCopy(ok ? 'COPIED' : 'COPY BLOCKED');
    setAttr(el.panel, 'data-copied', ok ? '1' : '0');
    return ok;
  }

  function execCopy(text) {
    try {
      const area = document.createElement('textarea');
      area.value = text;
      area.setAttribute('readonly', '');
      area.style.position = 'fixed';
      area.style.top = '-1000px';
      area.style.opacity = '0';
      document.body.appendChild(area);
      area.select();
      const ok = typeof document.execCommand === 'function' ? document.execCommand('copy') : false;
      document.body.removeChild(area);
      return ok;
    } catch { return false; }
  }

  function flashCopy(label) {
    if (!el.copy) return;
    mine.copyLabel = label;
    setText(el.copy, label);
    if (local.flashTimer) clearTimeout(local.flashTimer);
    local.flashTimer = setTimeout(() => {
      local.flashTimer = 0;
      mine.copyLabel = 'COPY INVITE LINK';
      setText(el.copy, 'COPY INVITE LINK');
      setAttr(el.panel, 'data-copied', null);
    }, COPIED_MS);
  }

  function onKeydown(e) {
    if (e.key !== 'Escape') return;
    const active = document.activeElement;
    const tag = active && active.tagName ? active.tagName.toLowerCase() : '';
    if (tag === 'input' || tag === 'textarea' || tag === 'select') return;
    const v = viewOf(client && client.state);
    if (!v.queued) return;
    local.wantQueued = false;
    local.queuedAt = 0;
    if (typeof client?.unqueue === 'function') client.unqueue();
    paint(client && client.state);
  }

  function onServerError(error) {
    if (!error) return;
    const code = String(error.code || 'error');
    const message = String(error.message || '');
    // A stale server answers the unknown frame with `state`, and the 1/s guard
    // answers a fast second toggle with `rate`; both mean "the toggle did not
    // take", so undo it instead of leaving the switch lying.
    const configish = /unknown frame type config/i.test(message)
      || (local.configAt > 0 && Date.now() - local.configAt < CONFIG_ERR_MS
        && (code === 'state' || code === 'rate'));
    if (configish) {
      local.error = null;
      local.errorAt = 0;
      revertBots(code === 'rate' ? 'rate' : 'state');
      paint(client && client.state);
      return;
    }
    local.error = { code, message };
    local.errorAt = Date.now();
    paint(client && client.state);
  }

  /* ---- boot ------------------------------------------------------------ */

  build();

  if (el.name) {
    const stored = readStore(NAME_KEY);
    if (stored && !el.name.value) el.name.value = stored;
    el.name.addEventListener('input', onNameInput);
    el.name.addEventListener('change', commitName);
    el.name.addEventListener('blur', commitName);
    el.name.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); commitName(); el.name.blur(); }
      else if (e.key === 'Escape') el.name.blur();
    });
  }
  if (el.btn) el.btn.addEventListener('click', onPrimary);
  if (el.start) el.start.addEventListener('click', onStart);
  if (el.bots) {
    el.bots.addEventListener('click', onBotsToggle);
    // `?bots=1` is a choice too: remember it, so a later load without the
    // query keeps the demo grid instead of silently following the server.
    if (readParam('bots') === '1' && readStore(BOTS_KEY) !== '1') writeStore(BOTS_KEY, '1');
    const on = botsOn(client && client.state);
    setText(el.bots, on ? 'BOTS ON' : 'BOTS OFF');
    setAttr(el.bots, 'aria-pressed', on ? 'true' : 'false');
    setAttr(el.bots, 'data-on', on ? '1' : '0');
  }
  if (el.copy) el.copy.addEventListener('click', () => { copyInvite(); });
  document.addEventListener('keydown', onKeydown);

  // `?party=CODE` auto-joins: the code goes into the box and is sent as soon
  // as a socket is open (the client also carries it in `hello`). mmo.js issues
  // 5-char codes, so accept anything from 4 to 6 characters.
  const paramParty = partyCodeOf(readParam('party') || '', PARTY_INPUT_MAX);
  if (paramParty && paramParty.length >= PARTY_INPUT_MIN) {
    if (mine.partyInput) mine.partyInput.value = paramParty;
    setPartyStatus(`JOINING ${paramParty}…`, 12000);
  }

  const feedError = (err) => onServerError(err);
  // mmo-client.js exposes onError only at construction; subscribe covers the
  // state.error frame and the retry loop watches conn transitions.
  let lastErrorAt = 0;
  let lastConn = '';

  function onState(state) {
    if (!mounted) return;
    const conn = state && state.conn;
    if (conn !== lastConn) {
      lastConn = conn;
      if (conn === 'open') {
        // The welcome that follows is the first real bots snapshot; if it
        // disagrees with the driver's stored choice, paintBots re-asserts it
        // once through `config {bots}`.
        local.botsReasserted = false;
        if (paramParty && paramParty.length >= PARTY_INPUT_MIN) {
          const already = partyCodeOf(state && state.party && state.party.code, PARTY_INPUT_MAX);
          if (already !== paramParty) sendFrameParty('join', paramParty);
        }
      }
    }
    const err = state && state.error;
    if (err && err.at && err.at !== lastErrorAt) {
      lastErrorAt = err.at;
      feedError(err);
    }
    paint(state);
  }

  if (client && typeof client.subscribe === 'function') unsubscribe = client.subscribe(onState);
  paint(client && client.state);

  ticker = setInterval(() => {
    if (!mounted) return;
    if (typeof document !== 'undefined' && document.hidden) return; // no work in a hidden tab
    paint(client && client.state);
  }, 1000);

  function destroy() {
    mounted = false;
    if (unsubscribe) { try { unsubscribe(); } catch { /* ignore */ } unsubscribe = null; }
    if (ticker) { clearInterval(ticker); ticker = 0; }
    if (local.flashTimer) { clearTimeout(local.flashTimer); local.flashTimer = 0; }
    if (local.copiedTimer) { clearTimeout(local.copiedTimer); local.copiedTimer = 0; }
    if (local.slowTimer) { clearTimeout(local.slowTimer); local.slowTimer = 0; }
    if (destroyPoll) { clearInterval(destroyPoll); destroyPoll = 0; }
    document.removeEventListener('keydown', onKeydown);
    try { if (scope.__mmoLfg) delete scope.__mmoLfg; } catch { /* frozen */ }
  }

  const api = {
    mount: mountLfg,
    paint: () => paint(client && client.state),
    inject: (frame) => (client && client._debug ? client._debug.inject(frame) : 'no-client'),
    snapshot: () => (client ? client.state : null),
    sent: () => (client && client._debug ? client._debug.sent() : []),
    copyInvite,
    destroy,
    els: el,
    nodes: mine,
    get view() { return viewOf(client && client.state); },
    get bots() { return botsOn(client && client.state); },
    get botsConfirmed() { return local.botsConfirmed; },
    get partyCode() {
      return partyCodeOf(local.partyCode
        || (client && client.state && client.state.party && client.state.party.code) || '', PARTY_INPUT_MAX);
    },
    get spectating() { return local.spectating; },
    get configUnsupported() { return local.configUnsupported; },
  };

  try { scope.__mmoLfg = api; } catch { /* frozen node */ }
  return api;
}

/* ---------- auto-mount on /race-day -------------------------------------- */

function autoMount() {
  if (typeof document === 'undefined' || typeof window === 'undefined') return null;
  if (!document.getElementById('mmoLfg')) return null; // not the Race Day page
  const g = window.__R4_MMO;
  if (!g || !g.client) return null; // mmo-client.js has not booted yet

  const api = mountLfg(document.getElementById('mmoLfg'), g.client);
  try {
    if (!window.__R4_MMO_LFG) {
      window.__R4_MMO_LFG = {
        mount: mountLfg,
        lfg: api,
        inject: (frame) => api.inject(frame),
        paint: () => api.paint(),
        snapshot: () => api.snapshot(),
        sent: () => api.sent(),
      };
    } else if (!window.__R4_MMO_LFG.lfg) {
      window.__R4_MMO_LFG.lfg = api;
    }
  } catch { /* a test hook is nice to have, never required */ }
  return api;
}

if (typeof document !== 'undefined' && typeof window !== 'undefined') {
  // mmo-client.js is an earlier module <script>, so it normally wins the race;
  // poll briefly anyway so a slow/blocked client never strands the panel.
  let tries = 0;
  const start = () => {
    if (autoMount()) return;
    if (tries++ > 40) return;
    const timer = setInterval(() => {
      if (autoMount() || tries++ > 40) clearInterval(timer);
    }, 100);
  };
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start, { once: true });
  } else {
    start();
  }
}

export default mountLfg;
