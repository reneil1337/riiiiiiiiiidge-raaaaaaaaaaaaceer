/* Race Day — watch-only spectator board (/race-day?spectate=1).
 *
 * A 51st person (or somebody on a phone) watches the race with no seat, no
 * telemetry and no start button: this module reads the shared client store and
 * paints a top-12 leaderboard, the battle for the lead, a race clock derived
 * from the leader's raceTimeMs (never a local timer) and a party row.
 *
 * Ownership: this file only. It never edits mmo.html / mmo.css / mmo-ui.js and
 * it injects its own stylesheet + its own panel, so ui-main keeps
 * #mmoStandingsBody and the 50-slot grid untouched.
 *
 * Wire protocol: _runtime/analysis/20-mmo-contract.md §3 (`spectate` in,
 * `welcome|event|grid|queue|countdown|standings|result|party|feed` out).
 * Scale: 500 drivers → the server sends top N at 2 Hz; the board caps at
 * 12 rows + 1 party row and patches changed cells only, keyed by seat.
 */

export const SPECTATE_VERSION = '1.0.0';

export const SPECTATE_LIMITS = Object.freeze({
  MAX_ROWS: 12,
  DEFAULT_MAX: 50,
  /** contract default RR4_MMO_RESULTS_MS — the result frame carries no nextAt */
  RESULTS_MS: 20000,
  NEXT_RACE_TICK_MS: 500,
  FLASH_MS: 900,
});

const CONTROL_TAGS = /^(BUTTON|INPUT|SELECT|TEXTAREA|A)$/;
const CELLS = 5;

/* ------------------------------------------------------------- helpers ---- */

function h(tag, attrs, children) {
  const node = document.createElement(tag);
  if (attrs) {
    for (const key of Object.keys(attrs)) {
      const value = attrs[key];
      if (value === null || value === undefined || value === false) continue;
      if (key === 'class') node.className = value;
      else if (key === 'text') node.textContent = String(value); // text only, never HTML
      else if (value === true) node.setAttribute(key, '');
      else node.setAttribute(key, String(value));
    }
  }
  for (const child of children || []) {
    if (child === null || child === undefined || child === false) continue;
    node.appendChild(typeof child === 'string' ? document.createTextNode(child) : child);
  }
  return node;
}

function numOrNull(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function textOf(value, fallback = '') {
  return typeof value === 'string' && value.trim() ? value.trim() : fallback;
}

function readParams() {
  try {
    return new URLSearchParams((typeof location !== 'undefined' && location.search) || '');
  } catch { return new URLSearchParams(''); }
}

/** M:SS.d — the race clock and every lap/best time in the board. */
export function fmtClock(ms) {
  const n = numOrNull(ms);
  if (n === null || n < 0) return '—';
  const tenths = Math.round(n / 100);
  return `${Math.floor(tenths / 600)}:${String(Math.floor(tenths / 10) % 60).padStart(2, '0')}.${tenths % 10}`;
}

/** mm:ss — the next-race countdown. */
function fmtMmss(ms) {
  const total = Math.max(0, Math.ceil((numOrNull(ms) || 0) / 1000));
  return `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
}

function gapText(row) {
  if (!row) return '—';
  if (row.position === 1) return '—';
  if (row.gapLap || row.gapMs === null || row.gapMs === undefined) return 'LAP';
  return `+${Math.max(0, row.gapMs / 1000).toFixed(1)}`;
}

function battleGap(row) {
  if (!row) return '+0.0';
  if (row.position === 1) return '+0.0';
  if (row.gapLap || row.gapMs === null || row.gapMs === undefined) return 'LAP';
  return `+${Math.max(0, row.gapMs / 1000).toFixed(1)}`;
}

/** The server sends full team names; mmo.css keys colours by short team id. */
export function teamKey(team) {
  const t = String(team || '').trim().toLowerCase();
  if (!t) return 'none';
  if (t === 'sol' || t.startsWith('solv')) return 'sol';
  if (t === 'pac' || t.startsWith('pac')) return 'pac';
  if (t === 'map' || t.startsWith('mic') || t.startsWith('map')) return 'map';
  if (t === 'dig' || t.startsWith('dig')) return 'dig';
  return 'none';
}

function teamLabel(team) {
  const key = teamKey(team);
  if (key === 'sol') return 'SOL';
  if (key === 'pac') return 'PAC';
  if (key === 'map') return 'MAP';
  if (key === 'dig') return 'DIG';
  return '';
}

function phaseOf(state) {
  const ev = state && state.event ? state.event : null;
  const st = ev && typeof ev.state === 'string' ? ev.state : 'lobby';
  if (st === 'grid' || st === 'countdown' || st === 'racing' || st === 'results') return st;
  const cd = state && state.countdown ? state.countdown : null;
  if (cd && numOrNull(cd.n) > 0) return 'countdown';
  return 'lobby';
}

function normalizeRow(raw) {
  const r = raw && typeof raw === 'object' ? raw : {};
  return {
    seat: numOrNull(r.seat) || 0,
    name: textOf(r.name, '—').slice(0, 24),
    team: textOf(r.team, ''),
    teamKey: teamKey(r.team),
    bot: r.bot === true,
    position: numOrNull(r.position),
    lap: numOrNull(r.lap),
    raceTimeMs: numOrNull(r.raceTimeMs),
    bestLapMs: numOrNull(r.bestLapMs),
    gapMs: numOrNull(r.gapMs),
    gapLap: r.gapLap === true,
    state: textOf(r.state, ''),
    finished: r.finished === true || r.state === 'finished',
  };
}

function seatRows(seats) {
  return (Array.isArray(seats) ? seats : [])
    .filter((s) => s && numOrNull(s.seat) > 0 && textOf(s.name, ''))
    .sort((a, b) => a.seat - b.seat)
    .slice(0, SPECTATE_LIMITS.MAX_ROWS)
    .map((s, i) => normalizeRow({
      seat: s.seat,
      name: s.name,
      team: s.team,
      bot: s.bot,
      state: s.state,
      position: i + 1,
    }));
}

/* ----------------------------------------------------------- stylesheet --- */

const CSS = `
/* Race Day — spectator board. Injected by mmo-spectate.js (mmo.css untouched). */
.mmo-sp{display:flex;flex-direction:column;min-width:0;min-height:0;overflow:hidden;gap:0}
.mmo-sp *{box-sizing:border-box}
.mmo-sp [hidden]{display:none !important}
.mmo-sp-head{position:sticky;top:0;z-index:3;gap:3px 8px}
.mmo-sp-title{display:flex;align-items:baseline;gap:8px;margin:0;color:#fff;font-family:var(--mmo-display,Bahnschrift,"Arial Narrow","Segoe UI",sans-serif);font-size:12px;font-weight:700;letter-spacing:.14em;text-transform:uppercase}
.mmo-sp-title b{font-weight:800;font-style:italic}
.mmo-sp-chips{display:flex;flex-wrap:wrap;align-items:center;gap:4px}
.mmo-sp-chip{display:inline-flex;align-items:center;padding:2px 6px;border:1px solid var(--mmo-line-soft,rgba(255,255,255,.08));border-radius:2px;color:var(--mmo-muted,#9aa0ae);font-family:var(--mmo-mono,"Cascadia Mono",Consolas,monospace);font-size:7px;font-weight:700;letter-spacing:.12em;text-transform:uppercase;white-space:nowrap}
.mmo-sp-chip[data-state="grid"]{border-color:var(--mmo-accent-2,#29d3ff);color:var(--mmo-accent-2,#29d3ff)}
.mmo-sp-chip[data-state="countdown"]{border-color:var(--mmo-yellow,#ffd166);color:var(--mmo-yellow,#ffd166)}
.mmo-sp-chip[data-state="racing"]{border-color:var(--mmo-ok,#6ef2a2);color:var(--mmo-ok,#6ef2a2)}
.mmo-sp-chip[data-state="results"]{background:var(--mmo-accent,#e10600);border-color:var(--mmo-accent,#e10600);color:#fff}
.mmo-sp-chip[data-watch="1"]{border-color:var(--mmo-accent-2,#29d3ff);color:var(--mmo-accent-2,#29d3ff)}
.mmo-sp-action{display:inline-flex;align-items:center;justify-content:center;min-height:18px;padding:2px 6px;border:1px solid var(--mmo-line-soft,rgba(255,255,255,.08));border-radius:2px;color:var(--mmo-muted,#9aa0ae);font-family:var(--mmo-mono,Consolas,monospace);font-size:7px;font-weight:700;letter-spacing:.12em;text-decoration:none;text-transform:uppercase}
.mmo-sp-action:hover{border-color:var(--mmo-accent,#e10600);color:#fff}
.mmo-sp-action:focus-visible{outline:2px solid var(--mmo-accent-2,#29d3ff);outline-offset:1px}
.mmo-sp-life{margin:0;padding:5px 9px;border-bottom:1px solid var(--mmo-line-soft,rgba(255,255,255,.06));color:#fff;font-family:var(--mmo-display,Bahnschrift,"Arial Narrow",sans-serif);font-size:11px;font-style:italic;font-weight:700;letter-spacing:.1em;line-height:1.3;text-transform:uppercase}
.mmo-sp-fill{display:flex;flex-wrap:wrap;align-items:center;gap:4px 8px;margin:0;padding:3px 9px;border-bottom:1px solid var(--mmo-line-soft,rgba(255,255,255,.06));color:var(--mmo-muted,#9aa0ae);font-family:var(--mmo-mono,Consolas,monospace);font-size:8px;letter-spacing:.04em}
.mmo-sp-bar{color:var(--mmo-ok,#6ef2a2);letter-spacing:.02em;white-space:nowrap}
.mmo-sp-battle{display:flex;flex-wrap:wrap;align-items:baseline;gap:3px 8px;margin:0;padding:4px 9px;border-bottom:1px solid var(--mmo-line-soft,rgba(255,255,255,.06));font-family:var(--mmo-mono,Consolas,monospace);font-size:8px;letter-spacing:.04em}
.mmo-sp-lead{color:var(--mmo-yellow,#ffd166);letter-spacing:.1em;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:100%}
.mmo-sp-gaps{color:var(--mmo-text,#f2f3f7);font-variant-numeric:tabular-nums;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:100%}
.mmo-sp-battle[data-flash="1"]{animation:mmo-sp-flash .9s ease-out 1}
@keyframes mmo-sp-flash{0%{background:rgba(225,6,0,.32)}100%{background:transparent}}
.mmo-sp-count{display:flex;align-items:center;justify-content:center;gap:10px;padding:4px 9px;border-bottom:1px solid var(--mmo-line-soft,rgba(255,255,255,.06))}
.mmo-sp-countn{color:#fff;font-family:var(--mmo-display,Bahnschrift,"Arial Narrow",sans-serif);font-size:34px;font-style:italic;font-weight:800;line-height:1;letter-spacing:.02em;animation:mmo-sp-pop .32s ease-out 1}
.mmo-sp-countlabel{color:var(--mmo-yellow,#ffd166);font-family:var(--mmo-mono,Consolas,monospace);font-size:7px;letter-spacing:.16em;text-transform:uppercase}
@keyframes mmo-sp-pop{0%{transform:scale(1.35);opacity:.35}100%{transform:scale(1);opacity:1}}
.mmo-sp-board{position:relative;display:block;flex:1 1 auto;min-height:0;overflow-x:hidden;overflow-y:auto;border-top:1px solid var(--mmo-line-soft,rgba(255,255,255,.06));-webkit-overflow-scrolling:touch}
.mmo-sp-rows{display:block}
.mmo-sp-hrow,.mmo-sp-row{display:grid;grid-template-columns:2.6ch minmax(0,1fr) 3.2ch 6.6ch 6.2ch;align-items:center;gap:0 6px;padding:0 9px}
.mmo-sp-hrow{position:sticky;top:0;z-index:2;min-height:20px;border-bottom:1px solid var(--mmo-line,rgba(255,255,255,.12));background:var(--mmo-sunken,#0a0c12)}
.mmo-sp-hrow [role="columnheader"]{color:var(--mmo-dim,#6f7684);font-family:var(--mmo-mono,Consolas,monospace);font-size:7px;font-weight:700;letter-spacing:.14em;text-transform:uppercase}
.mmo-sp-hrow [role="columnheader"]:nth-child(1){text-align:left}
.mmo-sp-hrow [role="columnheader"]:nth-child(3),
.mmo-sp-hrow [role="columnheader"]:nth-child(4),
.mmo-sp-hrow [role="columnheader"]:nth-child(5){text-align:right}
.mmo-sp-row{min-height:24px;border-bottom:1px solid rgba(255,255,255,.035);border-left:2px solid transparent}
.mmo-sp-row[data-pos="1"]{border-left-color:var(--mmo-yellow,#ffd166)}
.mmo-sp-row[data-pos="2"]{border-left-color:#c9ced8}
.mmo-sp-row[data-pos="3"]{border-left-color:#c98a4a}
.mmo-sp-row[data-empty="1"]{border-left-color:transparent}
.mmo-sp-row [role="cell"]{min-width:0;display:flex;align-items:center;font-family:var(--mmo-mono,Consolas,monospace);font-size:9px;color:var(--mmo-muted,#9aa0ae);font-variant-numeric:tabular-nums}
.mmo-sp-row [data-cell="pos"]{color:var(--sp-team,#fff);font-size:9.5px;font-weight:700;font-style:italic}
.mmo-sp-row [data-cell="name"]{gap:4px}
.mmo-sp-row [data-cell="lap"],
.mmo-sp-row [data-cell="best"],
.mmo-sp-row [data-cell="gap"]{justify-content:flex-end;white-space:nowrap}
.mmo-sp-row [data-cell="best"]{color:var(--mmo-accent-2,#29d3ff)}
.mmo-sp-row [data-cell="gap"]{color:#cfe3ff}
.mmo-sp-row[data-team="sol"]{--sp-team:var(--mmo-sol,#7fa8ff)}
.mmo-sp-row[data-team="pac"]{--sp-team:var(--mmo-pac,#ff6b5a)}
.mmo-sp-row[data-team="map"]{--sp-team:var(--mmo-map,#ff8fb3)}
.mmo-sp-row[data-team="dig"]{--sp-team:var(--mmo-dig,#2dd4e8)}
.mmo-sp-name{min-width:0;overflow:hidden;color:#fff;font-size:9.5px;letter-spacing:.04em;text-overflow:ellipsis;white-space:nowrap;text-transform:uppercase}
.mmo-sp-bot{flex:0 0 auto;padding:0 3px;border:1px dotted var(--mmo-dim,#6f7684);border-radius:2px;color:var(--mmo-dim,#6f7684);font-size:6px;letter-spacing:.1em}
.mmo-sp-dot{flex:0 0 auto;width:6px;height:6px;border-radius:50%;background:var(--mmo-accent-2,#29d3ff);box-shadow:0 0 0 1px rgba(41,211,255,.4)}
.mmo-sp-note{color:var(--mmo-dim,#6f7684);font-size:8px;letter-spacing:.1em}
.mmo-sp-friends{display:flex;flex-wrap:wrap;align-items:center;gap:4px 8px;padding:4px 9px;border-top:1px solid var(--mmo-line,rgba(255,255,255,.12));background:rgba(41,211,255,.05);font-family:var(--mmo-mono,Consolas,monospace);font-size:8px}
.mmo-sp-friends-label{color:var(--mmo-accent-2,#29d3ff);font-size:7px;letter-spacing:.14em;text-transform:uppercase}
.mmo-sp-friend{display:inline-flex;align-items:center;gap:4px;padding:1px 5px;border:1px solid rgba(41,211,255,.35);border-radius:2px;color:#fff;letter-spacing:.04em;white-space:nowrap}
.mmo-sp-friend i{width:6px;height:6px;border-radius:50%;background:var(--mmo-accent-2,#29d3ff)}
.mmo-sp-next{margin:0;padding:4px 9px;border-top:1px solid var(--mmo-line,rgba(255,255,255,.12));color:var(--mmo-muted,#9aa0ae);font-family:var(--mmo-mono,Consolas,monospace);font-size:8px;letter-spacing:.14em;text-transform:uppercase}
.mmo-sp-next b{color:var(--mmo-yellow,#ffd166);font-variant-numeric:tabular-nums}
.mmo-sp-foot{margin:0;padding:3px 9px 4px;color:var(--mmo-dim,#6f7684);font-family:var(--mmo-mono,Consolas,monospace);font-size:7px;letter-spacing:.12em;text-transform:uppercase}
#mmoMain > .mmo-sp{grid-area:standings}
#mmoSpectateBoard[data-conn="closed"]{opacity:.82}
/* Spectate mode: the driver furniture is not the spectator's. */
body[data-mmo-spectate="1"] #mmoLfg,
body[data-mmo-spectate="1"] #mmoStandings,
body[data-mmo-spectate="1"] #mmoResults,
body[data-mmo-spectate="1"] #mmoCountdown{display:none !important}
body[data-mmo-spectate="1"] .mmo-main{grid-template-columns:minmax(0,1fr) minmax(0,1.15fr);grid-template-areas:"grid standings"}
@media (max-width:1024px){
  body[data-mmo-spectate="1"] .mmo-main{grid-template-columns:minmax(0,1fr) minmax(0,1fr);grid-template-areas:"grid standings"}
}
@media (max-width:760px){
  .mmo-sp-board{max-height:56vh}
  .mmo-sp-hrow,.mmo-sp-row{grid-template-columns:2.4ch minmax(0,1fr) 3ch 6.2ch 5.8ch;gap:0 5px;padding:0 7px}
  .mmo-sp-row{min-height:30px}
  .mmo-sp-countn{font-size:44px}
  .mmo-sp-action{min-width:44px;min-height:44px;padding:4px 8px;font-size:8px}
  body[data-mmo-spectate="1"] .mmo-main{grid-template-columns:minmax(0,1fr);grid-template-areas:"standings" "grid"}
}
@media (pointer:coarse){
  .mmo-sp-action{min-width:44px;min-height:44px;padding:4px 10px;font-size:8px}
  .mmo-sp-friend{min-height:44px;padding:2px 8px}
}
@media (prefers-reduced-motion:reduce){
  .mmo-sp-battle[data-flash="1"]{animation:none !important;background:rgba(225,6,0,.18)}
  .mmo-sp-countn{animation:none !important}
  .mmo-sp-row,.mmo-sp-friend,.mmo-sp-action{transition:none !important}
}
`;

function installStyles() {
  if (typeof document === 'undefined') return;
  try {
    if (document.getElementById('mmo-spectate-css')) return;
    const style = document.createElement('style');
    style.id = 'mmo-spectate-css';
    style.textContent = CSS; // static text, no user data
    (document.head || document.documentElement).appendChild(style);
  } catch { /* a blocked <style> must not stop the board */ }
}

/* ---------------------------------------------------------------- mount --- */

export function mountSpectate(root, clientArg, options) {
  if (typeof document === 'undefined') return null;
  const opts = options && typeof options === 'object' ? options : {};
  const scope = typeof root === 'string'
    ? document.querySelector(root)
    : (root && root.nodeType === 1 ? root : document.getElementById('mmoApp') || document.body);
  if (!scope) return null;
  if (scope.__mmoSpectate) return scope.__mmoSpectate;

  installStyles();

  const params = readParams();
  const spectateMode = opts.spectate === true || params.get('spectate') === '1';
  const partyFromUrl = String(params.get('party') || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6);

  let client = clientArg || null;
  let unsubscribe = null;
  let destroyed = false;
  let lastState = null;
  let lastPhase = '';
  let lastLeadKey = '';
  let lastFriendsSig = '';
  let lastFinishedAt = 0;
  let spectatorOverride = null; // mmo-client drops counts.spectators from `event`
  let flashTimer = 0;
  let tickTimer = 0;
  let rafId = 0;
  let rafFallback = 0;

  const stats = { renders: 0, cellWrites: 0, rowWrites: 0, leadChanges: 0, frames: 0 };
  const rowCache = new Map(); // seat -> { el, cells, sig }
  let emptyRow = null;

  if (spectateMode) {
    try {
      document.body.dataset.mmoSpectate = '1';
      document.documentElement.dataset.mmoSpectate = '1';
    } catch { /* optional */ }
  }

  /* ---- host + markup (built once; every later change patches a node) ---- */

  function resolveHost() {
    const existing = scope.querySelector ? scope.querySelector('[data-mmo-spectate-panel]') : null;
    if (existing) return existing;
    const byId = (scope.querySelector && scope.querySelector('#mmoSpectate'))
      || document.getElementById('mmoSpectate');
    // #mmoSpectate is the LFG "WATCH ONLY" button in the current page shell, so
    // only adopt it when it is a container. Otherwise own a panel in #mmoMain.
    if (byId && !CONTROL_TAGS.test(String(byId.tagName || '')) && !byId.querySelector('[data-mmo-spectate-panel]')) {
      byId.classList.add('mmo-sp');
      byId.setAttribute('data-mmo-spectate-panel', '1');
      byId.setAttribute('aria-labelledby', 'mmoSpectateTitle');
      return byId;
    }
    const panel = h('section', {
      class: 'mmo-panel mmo-sp',
      id: 'mmoSpectateBoard',
      'data-mmo-spectate-panel': '1',
      'aria-labelledby': 'mmoSpectateTitle',
      'data-conn': 'closed',
    });
    const main = document.getElementById('mmoMain') || (scope.querySelector && scope.querySelector('#mmoMain'));
    const app = document.getElementById('mmoApp') || scope;
    if (main) main.appendChild(panel);
    else if (app) app.appendChild(panel);
    return panel;
  }

  const host = resolveHost();
  if (!host) return null;

  const head = h('div', { class: 'mmo-panelhead mmo-sp-head' });
  const title = h('h2', { class: 'mmo-sp-title', id: 'mmoSpectateTitle' }, [
    h('b', null, ['WATCHING']),
    h('span', { class: 'mmo-panelnote', 'data-sp-note': '1' }, ['NO SEAT · LIVE 2 HZ']),
  ]);
  const chips = h('div', { class: 'mmo-sp-chips' });
  const phaseChip = h('span', { class: 'mmo-sp-chip', 'data-sp-phase': '1', 'data-state': 'lobby' }, ['LOBBY']);
  const clockChip = h('span', { class: 'mmo-sp-chip mmo-num', 'data-sp-clock': '1' }, ['0:00.0']);
  const watchChip = h('span', { class: 'mmo-sp-chip', 'data-sp-watching': '1', 'data-watch': '1', hidden: true }, ['']);
  const actions = h('div', { class: 'mmo-sp-chips' }, [
    h('a', { class: 'mmo-sp-action', href: '/race-day' }, ['RACE DAY']),
    h('a', { class: 'mmo-sp-action', href: '/multiplayer' }, ['2P LOUNGE']),
  ]);
  chips.appendChild(phaseChip);
  chips.appendChild(clockChip);
  chips.appendChild(watchChip);
  head.appendChild(title);
  head.appendChild(chips);
  head.appendChild(actions);

  const life = h('p', { class: 'mmo-sp-life', 'data-sp-life': '1' }, ['WAITING FOR DRIVERS · 0/50']);

  const bar = h('span', { class: 'mmo-sp-bar', 'data-sp-bar': '1', 'aria-hidden': 'true' }, ['[----------]']);
  const fillText = h('span', { 'data-sp-filltext': '1' }, ['0 / 50 SEATED · 0%']);
  const fill = h('p', {
    class: 'mmo-sp-fill', 'data-sp-fill': '1', role: 'progressbar',
    'aria-label': 'Grid fill', 'aria-valuemin': '0', 'aria-valuemax': '50', 'aria-valuenow': '0',
  }, [bar, fillText]);

  const leadLive = h('span', {
    class: 'mmo-sp-lead', 'data-sp-lead': '1', 'aria-live': 'polite', 'aria-atomic': 'true',
  }, ['LEAD · WAITING']);
  const gaps = h('span', { class: 'mmo-sp-gaps', 'data-sp-gaps': '1', 'aria-live': 'off' }, ['P1 — · P2 — · P3 —']);
  const battle = h('p', { class: 'mmo-sp-battle', 'data-sp-battle': '1' }, [leadLive, gaps]);

  const countN = h('b', { class: 'mmo-sp-countn', 'data-sp-countn': '1' }, ['3']);
  const countdown = h('div', { class: 'mmo-sp-count', 'data-sp-count': '1', hidden: true }, [
    countN,
    h('span', { class: 'mmo-sp-countlabel' }, ['GET READY']),
  ]);

  const hrow = h('div', { class: 'mmo-sp-hrow', role: 'row' }, [
    h('div', { role: 'columnheader' }, ['POS']),
    h('div', { role: 'columnheader' }, ['DRIVER']),
    h('div', { role: 'columnheader' }, ['LAP']),
    h('div', { role: 'columnheader' }, ['BEST']),
    h('div', { role: 'columnheader' }, ['GAP']),
  ]);
  const rowsHost = h('div', { class: 'mmo-sp-rows', role: 'rowgroup', 'data-sp-rows': '1' });
  const board = h('div', {
    class: 'mmo-sp-board', 'data-sp-board': '1', role: 'table',
    'aria-label': 'Top 12 live leaderboard', 'aria-colcount': String(CELLS),
    'data-sp-scroll': '1',
  }, [hrow, rowsHost]);

  function buildEmptyRow() {
    const cells = [];
    cells.push(h('div', { role: 'cell', 'data-cell': 'pos' }, ['—']));
    cells.push(h('div', { role: 'cell', 'data-cell': 'name' }, [
      h('span', { class: 'mmo-sp-note', 'data-sp-note-text': '1' }, ['WAITING FOR THE GRID']),
    ]));
    for (let i = 2; i < CELLS; i += 1) cells.push(h('div', { role: 'cell', 'data-cell': String(i) }, ['—']));
    return h('div', { class: 'mmo-sp-row', role: 'row', 'data-empty': '1', 'data-sp-empty': '1' }, cells);
  }
  emptyRow = buildEmptyRow();
  rowsHost.appendChild(emptyRow);

  const friends = h('div', { class: 'mmo-sp-friends', 'data-sp-friends': '1', role: 'group', 'aria-label': 'Your friends', hidden: true });
  const nextRace = h('p', { class: 'mmo-sp-next', 'data-sp-next': '1', hidden: true }, ['NEXT RACE IN ', h('b', { 'data-sp-nextn': '1' }, ['00:20'])]);
  const foot = h('p', { class: 'mmo-sp-foot' }, ['WATCH ONLY · NO SEAT · NO TELEMETRY']);

  host.appendChild(head);
  host.appendChild(life);
  host.appendChild(fill);
  host.appendChild(battle);
  host.appendChild(countdown);
  host.appendChild(board);
  host.appendChild(friends);
  host.appendChild(nextRace);
  host.appendChild(foot);

  /* ---- patching helpers (text only, counted) ---- */

  function write(node, value) {
    if (!node) return false;
    const text = String(value);
    if (node.textContent === text) return false;
    node.textContent = text;
    stats.cellWrites += 1;
    return true;
  }

  function attr(node, name, value) {
    if (!node) return false;
    const next = value === null || value === undefined ? '' : String(value);
    if (node.getAttribute(name) === next) return false;
    if (next === '') node.removeAttribute(name);
    else node.setAttribute(name, next);
    return true;
  }

  function makeRow(seat) {
    const pos = h('div', { role: 'cell', 'data-cell': 'pos' }, ['—']);
    const dot = h('i', { class: 'mmo-sp-dot', 'data-sp-party': '1', hidden: true });
    const name = h('span', { class: 'mmo-sp-name', 'data-sp-name': '1' }, ['—']);
    const bot = h('span', { class: 'mmo-sp-bot', hidden: true }, ['BOT']);
    const nameCell = h('div', { role: 'cell', 'data-cell': 'name' }, [dot, name, bot]);
    const lap = h('div', { role: 'cell', 'data-cell': 'lap' }, ['—']);
    const best = h('div', { role: 'cell', 'data-cell': 'best' }, ['—']);
    const gap = h('div', { role: 'cell', 'data-cell': 'gap' }, ['—']);
    const el = h('div', {
      class: 'mmo-sp-row', role: 'row', 'data-sp-row': '1', 'data-seat': String(seat),
    }, [pos, nameCell, lap, best, gap]);
    stats.rowWrites += 1;
    return { el, cells: { pos, name, dot, bot, lap, best, gap, nameCell }, sig: '' };
  }

  /* ---- reading the store ---- */

  function countsOf(state) {
    const ev = state && state.event && state.event.counts ? state.event.counts : {};
    const grid = state && state.grid && state.grid.counts ? state.grid.counts : {};
    const seated = Math.max(0, numOrNull(ev.seated) ?? numOrNull(grid.seated) ?? 0);
    const max = Math.max(1, numOrNull(ev.max) ?? numOrNull(grid.max) ?? SPECTATE_LIMITS.DEFAULT_MAX);
    return { seated, max: Math.max(max, seated) };
  }

  function spectatorsOf(state) {
    if (spectatorOverride !== null) return spectatorOverride;
    const counts = state && state.event ? state.event.counts : null;
    if (counts && numOrNull(counts.spectators) !== null) return counts.spectators;
    if (state && state.event && numOrNull(state.event.spectators) !== null) return state.event.spectators;
    if (state && numOrNull(state.spectators) !== null) return state.spectators;
    return null; // absent → hide the chip, never fake a 0
  }

  function partyOf(state) {
    const p = state && state.party ? state.party : null;
    const code = String((p && p.code) || partyFromUrl || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6);
    const members = p && Array.isArray(p.members)
      ? p.members.filter((m) => m && (m.name || m.driverId)).map((m) => ({
        name: textOf(m.name, 'FRIEND').slice(0, 24),
        seat: numOrNull(m.seat) || 0,
        driverId: textOf(m.driverId, ''),
      }))
      : [];
    return { code, members };
  }

  function isMember(row, party) {
    if (!row) return false;
    const name = String(row.name || '').toUpperCase();
    return party.members.some((m) => (
      (m.seat > 0 && m.seat === row.seat)
      || (name && m.name && m.name.toUpperCase() === name)
    ));
  }

  function rowsFor(state, phase) {
    if (phase === 'racing' || phase === 'results') {
      const src = phase === 'results'
        ? (state.results && state.results.rows) || []
        : (state.standings && state.standings.rows) || [];
      return src
        .map(normalizeRow)
        .filter((r) => r.seat > 0 && r.name !== '—')
        .sort((a, b) => (numOrNull(a.position) ?? 999) - (numOrNull(b.position) ?? 999) || a.seat - b.seat)
        .slice(0, SPECTATE_LIMITS.MAX_ROWS);
    }
    return seatRows(state.grid && state.grid.seats);
  }

  /** The race clock is the leader's elapsed time — never a local stopwatch. */
  function raceClockMs(rows) {
    const timed = rows.filter((r) => numOrNull(r.raceTimeMs) !== null && numOrNull(r.lap) !== null);
    if (!timed.length) return null;
    const maxLap = Math.max(...timed.map((r) => r.lap));
    const leaders = timed.filter((r) => r.lap === maxLap);
    return Math.min(...leaders.map((r) => r.raceTimeMs));
  }

  function nextRaceText() {
    if (!lastFinishedAt) return '--:--';
    const left = lastFinishedAt + SPECTATE_LIMITS.RESULTS_MS - Date.now();
    return fmtMmss(Math.max(0, left));
  }

  /* ---- the board ---- */

  function paintRows(state, phase, party) {
    const rows = rowsFor(state, phase);
    const seen = new Set();
    let index = 0;
    for (const row of rows) {
      seen.add(row.seat);
      let entry = rowCache.get(row.seat);
      if (!entry) {
        entry = makeRow(row.seat);
        rowCache.set(row.seat, entry);
        // Append now; the ordering pass below places it correctly.
        rowsHost.appendChild(entry.el);
      }
      attr(entry.el, 'data-team', row.teamKey === 'none' ? null : row.teamKey);
      attr(entry.el, 'data-pos', row.position === null ? null : String(row.position));
      attr(entry.el, 'data-party', isMember(row, party) ? '1' : null);
      attr(entry.el, 'data-finished', row.finished ? '1' : null);
      write(entry.cells.pos, row.position === null ? '—' : String(row.position));
      write(entry.cells.name, row.name);
      write(entry.cells.lap, row.lap === null ? '—' : String(row.lap));
      write(entry.cells.best, fmtClock(row.bestLapMs));
      write(entry.cells.gap, gapText(row));
      if (entry.cells.dot.hidden !== !isMember(row, party)) entry.cells.dot.hidden = !isMember(row, party);
      if (entry.cells.bot.hidden !== !row.bot) entry.cells.bot.hidden = !row.bot;
      const label = [
        `P${row.position === null ? '?' : row.position}`,
        row.name,
        row.team ? `team ${row.team}` : '',
        row.lap === null ? '' : `lap ${row.lap}`,
        row.bestLapMs === null ? '' : `best ${fmtClock(row.bestLapMs)}`,
        row.position === 1 ? 'leader' : `gap ${gapText(row)}`,
      ].filter(Boolean).join(', ');
      attr(entry.el, 'aria-label', label);
      // Place this row at its index inside the rowgroup (cheap no-op when stable).
      const target = rowsHost.children[index];
      if (target !== entry.el) rowsHost.insertBefore(entry.el, target || null);
      index += 1;
    }
    for (const [seat, entry] of Array.from(rowCache.entries())) {
      if (seen.has(seat)) continue;
      if (entry.el.parentNode) entry.el.remove();
      rowCache.delete(seat);
    }
    emptyRow.hidden = rows.length > 0;
    if (emptyRow.hidden === false) {
      rowsHost.appendChild(emptyRow);
      const note = emptyRow.querySelector('[data-sp-note-text]');
      if (note) {
        write(note, phase === 'lobby'
          ? 'WAITING FOR THE GRID'
          : phase === 'grid' ? 'GRID LOCKED' : 'NO TIMING YET');
      }
    }
    attr(board, 'aria-rowcount', String(rows.length + 1));
    return rows;
  }

  function paintFriends(party, rows, phase) {
    if (!party.code) {
      if (!friends.hidden) friends.hidden = true;
      lastFriendsSig = '';
      return;
    }
    const chipsOut = [];
    if (!party.members.length) {
      chipsOut.push(h('span', { class: 'mmo-sp-friend' }, [
        h('i', null, []),
        `PARTY ${party.code} · NO MEMBERS YET`,
      ]));
    } else {
      for (const member of party.members.slice(0, 2)) {
        const row = rows.find((r) => (member.seat > 0 && r.seat === member.seat)
          || (member.name && r.name && r.name.toUpperCase() === member.name.toUpperCase()));
        const where = row
          ? `P${row.position === null ? '?' : row.position} ${row.position === 1 ? 'LEADER' : gapText(row)}`
          : (member.seat > 0 ? `SEAT ${member.seat}` : (phase === 'racing' || phase === 'results' ? 'ON TRACK' : 'WATCHING'));
        chipsOut.push(h('span', { class: 'mmo-sp-friend' }, [h('i', null, []), `${member.name} · ${where}`]));
      }
    }
    const sig = party.code + '|' + phase + '|' + chipsOut.map((c) => c.textContent).join('|');
    if (sig === lastFriendsSig) { if (friends.hidden) friends.hidden = false; return; }
    lastFriendsSig = sig;
    while (friends.firstChild) friends.removeChild(friends.firstChild);
    friends.appendChild(h('span', { class: 'mmo-sp-friends-label' }, [`YOUR FRIENDS · ${party.code}`]));
    for (const chip of chipsOut) friends.appendChild(chip);
    friends.hidden = false;
    stats.rowWrites += 1;
  }

  function syncTicker(phase) {
    const wantResults = phase === 'results';
    if (wantResults && !tickTimer) {
      tickTimer = setInterval(() => {
        if (destroyed) return;
        const b = nextRace.querySelector('[data-sp-nextn]');
        write(b, nextRaceText());
      }, SPECTATE_LIMITS.NEXT_RACE_TICK_MS);
    } else if (!wantResults && tickTimer) {
      clearInterval(tickTimer);
      tickTimer = 0;
    }
  }

  /* ---- paint ---- */

  function flush(stateOverride) {
    if (destroyed) return null;
    const state = stateOverride || (client && client.state) || window.__R4_MMO && window.__R4_MMO.state || null;
    if (!state) return null;
    lastState = state;
    stats.renders += 1;

    const phase = phaseOf(state);
    const counts = countsOf(state);
    const party = partyOf(state);
    const rows = paintRows(state, phase, party);

    // Event header bits.
    const index = numOrNull(state.event && state.event.index);
    const plan = state.event && state.event.plan ? state.event.plan : null;
    const track = plan ? textOf(plan.trackName, '') : '';
    const carClass = plan ? textOf(plan.carClass, '') : '';
    if (phase !== lastPhase) {
      lastPhase = phase;
      attr(host, 'data-phase', phase);
      attr(phaseChip, 'data-state', phase);
      write(phaseChip, phase.toUpperCase());
    }
    attr(host, 'data-conn', state.conn === 'open' ? 'open' : (state.conn === 'closed' ? 'closed' : 'linking'));
    const note = host.querySelector('[data-sp-note]');
    if (note) {
      const link = state.conn === 'open' ? 'LIVE 2 HZ'
        : state.conn === 'closed' ? 'OFFLINE' : 'LINKING';
      write(note, `#${index === null ? '—' : index} · NO SEAT · ${link}`);
    }

    // Lifecycle + fill meter.
    const seated = counts.seated;
    const max = counts.max;
    const pct = Math.min(100, Math.round((seated / max) * 100));
    const filled = Math.round((seated / max) * 10);
    if (phase === 'lobby') {
      write(life, `WAITING FOR DRIVERS · ${seated}/${max}`);
    } else if (phase === 'grid') {
      write(life, `GRID LOCKED${track ? ` · ${track.toUpperCase()}` : ''}`);
    } else if (phase === 'countdown') {
      const n = numOrNull(state.countdown && state.countdown.n);
      write(life, `COUNTDOWN · ${n === null ? 'GET READY' : n}`);
    } else if (phase === 'racing') {
      const lap = numOrNull(state.standings && state.standings.lap);
      write(life, `LIVE${lap ? ` · LAP ${lap}` : ''}${track ? ` · ${track.toUpperCase()}` : ''}${carClass ? ` · CLASS ${carClass}` : ''}`);
    } else {
      const finished = state.results && Array.isArray(state.results.rows) ? state.results.rows.length : 0;
      write(life, `RACE COMPLETE · ${seated || finished} DRIVERS${track ? ` · ${track.toUpperCase()}` : ''}`);
    }
    write(bar, `[${'#'.repeat(filled)}${'-'.repeat(10 - filled)}]`);
    write(fillText, `${seated} / ${max} SEATED · ${pct}%`);
    attr(fill, 'aria-valuemax', String(max));
    attr(fill, 'aria-valuenow', String(seated));
    attr(fill, 'aria-valuetext', `${seated} of ${max} seated`);

    // Race clock (leader raceTimeMs), then the countdown overlay.
    const clockMs = raceClockMs(rows);
    if (phase === 'results' && state.results) {
      lastFinishedAt = numOrNull(state.results.finishedAt) || lastFinishedAt || Date.now();
    } else if (phase !== 'racing' && phase !== 'countdown') {
      lastFinishedAt = 0;
    }
    const clockText = (phase === 'lobby' || phase === 'grid' || clockMs === null) ? '0:00.0' : fmtClock(clockMs);
    write(clockChip, clockText);

    const cdN = phase === 'countdown' ? numOrNull(state.countdown && state.countdown.n) : null;
    countdown.hidden = phase !== 'countdown' || cdN === null;
    if (!countdown.hidden) write(countN, String(cdN));

    // Battle for the lead + the single polite live region.
    const timed = phase === 'racing' || phase === 'results';
    const lead = rows[0] || null;
    const leadKey = timed && lead ? `${phase}:${lead.seat}:${lead.name}` : `pre:${phase}`;
    if (leadKey !== lastLeadKey) {
      lastLeadKey = leadKey;
      stats.leadChanges += 1;
      write(leadLive, timed && lead
        ? `LEAD · ${lead.name}`
        : (phase === 'grid' ? 'LEAD · GRID LOCKED' : 'LEAD · WAITING FOR GREEN'));
      battle.dataset.flash = '1';
      if (flashTimer) clearTimeout(flashTimer);
      flashTimer = setTimeout(() => {
        flashTimer = 0;
        if (battle && battle.dataset) delete battle.dataset.flash;
      }, SPECTATE_LIMITS.FLASH_MS);
    }
    const top3 = rows.slice(0, 3);
    const gapLine = timed && top3.length
      ? top3.map((r, i) => `P${i + 1} ${battleGap(r)}`).join(' · ')
      : 'P1 — · P2 — · P3 —';
    write(gaps, gapLine);
    attr(battle, 'data-leader', timed && lead ? String(lead.seat) : null);

    // Spectator count: absent field → hidden chip, not a fake 0.
    const watching = spectatorsOf(state);
    if (watching === null) {
      if (!watchChip.hidden) watchChip.hidden = true;
      write(watchChip, '');
    } else {
      write(watchChip, `${watching} WATCHING`);
      if (watchChip.hidden) watchChip.hidden = false;
    }

    // Party row + next-race countdown.
    paintFriends(party, rows, phase);
    nextRace.hidden = phase !== 'results';
    if (!nextRace.hidden) write(nextRace.querySelector('[data-sp-nextn]'), nextRaceText());
    syncTicker(phase);

    return state;
  }

  /* ---- subscription ---- */

  function schedule() {
    if (rafId || rafFallback) return;
    const run = () => {
      rafId = 0;
      if (rafFallback) { clearTimeout(rafFallback); rafFallback = 0; }
      flush();
    };
    if (typeof requestAnimationFrame === 'function') rafId = requestAnimationFrame(run);
    else rafFallback = setTimeout(run, 16);
    // A backgrounded tab throttles rAF; the board must not go stale at 2 Hz.
    rafFallback = setTimeout(() => {
      if (rafId && typeof cancelAnimationFrame === 'function') cancelAnimationFrame(rafId);
      rafId = 0;
      flush();
    }, 260);
  }

  function attach(nextClient) {
    if (nextClient) client = nextClient;
    if (unsubscribe) { unsubscribe(); unsubscribe = null; }
    if (client && typeof client.subscribe === 'function') {
      unsubscribe = client.subscribe(() => {
        stats.frames += 1;
        schedule();
      });
    }
    flush();
    return api;
  }

  function inject(frame) {
    if (frame && typeof frame === 'object') {
      const counts = frame.counts || (frame.payload && frame.payload.counts);
      const n = counts ? numOrNull(counts.spectators) : null;
      // The client store rebuilds event.counts and drops unknown keys, so a
      // server-provided spectator count is cached here before the store eats it.
      if (n !== null) spectatorOverride = n;
    }
    let applied = 'none';
    if (client && client._debug && typeof client._debug.inject === 'function') {
      applied = client._debug.inject(frame);
    }
    flush();
    return applied;
  }

  function render(state) {
    return flush(state || null);
  }

  function destroy() {
    destroyed = true;
    if (unsubscribe) { unsubscribe(); unsubscribe = null; }
    if (flashTimer) { clearTimeout(flashTimer); flashTimer = 0; }
    if (tickTimer) { clearInterval(tickTimer); tickTimer = 0; }
    if (rafId && typeof cancelAnimationFrame === 'function') cancelAnimationFrame(rafId);
    if (rafFallback) clearTimeout(rafFallback);
    if (spectateMode && typeof document !== 'undefined' && document.body) {
      try { delete document.body.dataset.mmoSpectate; } catch { /* optional */ }
    }
  }

  const api = {
    mount: mountSpectate,
    render,
    inject,
    flush: () => flush(null),
    attach,
    destroy,
    host,
    panel: host,
    get state() { return lastState || (client && client.state) || null; },
    get client() { return client; },
    get party() { return partyOf(lastState || (client && client.state) || null); },
    stats: () => ({ ...stats, rows: rowCache.size }),
    version: SPECTATE_VERSION,
    limits: SPECTATE_LIMITS,
  };

  try {
    Object.defineProperty(scope, '__mmoSpectate', { value: api, configurable: true, enumerable: false });
  } catch { scope.__mmoSpectate = api; }

  // Tell the server we are watching (no seat, no telemetry, no queue).
  if (spectateMode && client && typeof client.spectate === 'function') {
    try { client.spectate(); } catch { /* the client retries on open */ }
  }

  attach(client);
  publish(api);
  return api;
}

/* ------------------------------------------------- window + auto-mount ---- */

function publish(api) {
  if (typeof window === 'undefined') return;
  const facade = {
    mount: mountSpectate,
    render: (state) => (api ? api.render(state) : null),
    inject: (frame) => (api ? api.inject(frame) : 'none'),
    flush: () => (api ? api.flush() : null),
    stats: () => (api ? api.stats() : null),
    get spectate() { return api; },
    get panel() { return api ? api.panel : null; },
    version: SPECTATE_VERSION,
  };
  try {
    window.__R4_MMO_SPECTATE = facade;
  } catch { /* a locked window is not fatal */ }
}

function autoMount() {
  if (typeof document === 'undefined' || typeof window === 'undefined') return null;
  const root = document.getElementById('mmoApp') || document.body;
  if (!root) return null;
  const params = readParams();
  if (params.get('spectate') !== '1') {
    publish(null);
    return null;
  }
  const bind = () => {
    const c = window.__R4_MMO && window.__R4_MMO.client;
    if (!c) return null;
    const api = mountSpectate(root, c, { spectate: true });
    publish(api);
    return api;
  };
  const api = bind();
  if (api) return api;
  // mmo-client.js normally boots first; give a slow module graph 2 s.
  let tries = 0;
  const timer = setInterval(() => {
    tries += 1;
    if (bind() || tries > 20) clearInterval(timer);
  }, 100);
  return null;
}

if (typeof document !== 'undefined' && typeof window !== 'undefined') {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => {
      try { autoMount(); } catch { /* never blank the page */ }
    });
  } else {
    try { autoMount(); } catch { /* never blank the page */ }
  }
}

export default mountSpectate;
