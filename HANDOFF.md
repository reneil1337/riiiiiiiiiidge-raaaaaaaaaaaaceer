# RIDGE RACER TYPE 4 — SESSION HANDOFF

**Date:** 2026-11-06  
**Workspace:** `<repo>`  
**Purpose:** Everything the next session needs to continue the cabinet, the docs, and the direct 2P build.

Read in this order:

1. `AGENTS.md` — mandatory documentation/verification rules
2. `HANDOFF.md` — this file
3. `README.md`, `START-HERE.md`
4. `docs/README.md`
5. `REA-ANALYSIS.md`, `docs/pages/engineering/rea.mdx`

---

## 1. Current state at a glance

The cabinet is live on **port 8080** and the netplay relay on **3010**.

| URL | What it is | State |
|---|---|---|
| `/` | R4 cabinet **ENTER** login shell (parent-owned audio) | Working; refresh always returns to ENTER |
| `/welcome` | **WELCOME TO RIDGE CITY** hub after ENTER | Working |
| `/games` | Machine check for all three discs | Working |
| `/multiplayer` | **2P LOUNGE**: 4-char room, DISC selector (r4/rage/ridge), DRIVE `LIVE`/`GHOST` + TURN selectors, four teams, both READY, server-rolled plan | `harness-verified` 33/33 lounge UI (R4) + 32/32 multi-disc lounge UI + 36/36 ghost lounge UI; `/mp` 16/16 multi-disc, 22/22 R4 transport |
| `/race-day` | **RACE DAY**: 50-seat mass start, LFG queue, parties of 2, live standings, results | `harness-verified` 12/12 protocol, 41/41 two-browser; 550 synthetic sockets load-probed |
| `/play` | Standalone browser player (own ENTER gate) | Working |
| `/play-net` | EmulatorJS netplay page + auto host/join + host macro (R4) / manual shared car (Rage/Ridge) / ghost tape replay + live ghost (Rage/Ridge) | R4: `harness-verified host-only` 6/6, `harness-verified two-browser` 40/40; Rage/Ridge `netplay transport; in-game mode unverified`; ghost: `harness-verified ghost replay (sequential)` 40/40 + `harness-verified ghost rendered (in-game)` 36/36 |
| `/lobby` | Original lobby + native host-stream fallback | Present |
| `/docs` | Zudoku field manual (built to `docs/dist/docs`) | Served; rebuild + relink after page changes |
| `/music` + `/api/music` | Extracted soundtrack + generated manifest | 57 tracks, manifest generated |
| `/mp` (WebSocket) | Lobby transport for `/multiplayer` | Restarted 2026-11-06; serves the 20 s heartbeat, host promotion and stale-room sweep |

Processes seen in this workspace:

```text
node src/server.js          -> :8080 (cabinet + docs + /mp)   restarted 2026-11-06
node server.js (relay)      -> :3010 (EmulatorJS relay)
```

`:8080` was restarted on **2026-11-06** and now serves the heartbeat build.
`_server/mp-ws-probe.mjs` against it records the app-level `pong` and one server
heartbeat ping, so the earlier stale-process caveat is gone. The heartbeat itself
was also proved on a throwaway `:8095` instance with
`_server/mp-heartbeat-probe.mjs` (10/10, console only). The process does **not**
yet serve the multi-disc `/mp` (a `room` frame has no `game`/`mode`) — see §2.11
before a manual DISC-selector test.

If the server is restarted, re-verify: `/`, `/welcome`, `/games`, `/multiplayer`,
`/play`, `/play-net`, `/lobby`, `/docs`, `/docs/introduction`, `/api/music`
(all returned 200 when checked in this session), and the `/docs` section
redirects (`/docs/games`, `/docs/play`, `/docs/multiplayer` → first page).

---

## 2. What was built in this session

### 2.1 Persistent cabinet shell

Files:

```text
_server/public/enter.html
_server/public/js/enter.js
_server/public/css/enter.css
```

Behaviour:

- `/` always shows the **ENTER THE CABINET** gate. It is **never skipped** on
  refresh; nothing is persisted in sessionStorage/localStorage.
- The page always starts in **Ridge Racer Type 4** mode.
- ENTER starts **“You The One For Me”** (R4 intro) in the parent document.
- The parent owns the only `HTMLAudioElement`; nothing inside the iframe creates
  a second one (`music-player.js` skips itself inside an iframe).
- **WELCOME / GAMES / 2P / PLAY / DOCS / LOBBY** load inside `#rr4sFrame`, so the
  soundtrack survives navigation.
- The shell top bar is the **only top bar**. For `/play*` documents the shell
  injects `#play-bar,#play-foot{display:none!important}` into the iframe
  (`enter.js`, around the `rr4-shell-chrome` block) and gives the stage the
  remaining space.
- `rr4-race` messages from the lounge build the handoff URL:
  `/play-net?embedded=1&threads=0&mpRole=…&mpRoom=<code>&mpRace=<raceId>&mpTrackIndex=0-7&mpCarHost=0-7&mpCarGuest=0-7`.
- Fullscreen shell button (`⛶`) is wired: it fullscreen the document itself so
  the bar leaves the grid and the iframe fills the viewport; `F` toggles, the
  EXIT control and Esc leave. Verified by `_server/test-shell-fs.mjs` (A4/A9/A11/
  A12 pass; the document, not `#rr4-shell`, is the fullscreen element).

### 2.2 Welcome hub, machine check, 2P lounge

```text
_server/public/welcome.html      + css/welcome.css        WELCOME TO RIDGE CITY (/welcome)
_server/public/games.html        + css/games.css          machine check (/games)
_server/public/multiplayer.html  + js/multiplayer.js      + css/multiplayer.css   2P LOUNGE
```

- Hub buttons: **MACHINE CHECK** (`/games`), **2P LOUNGE** (`/multiplayer`) and
  **FIELD MANUAL** (`/docs/introduction`); the shell bar adds **PLAY**, **DOCS**
  and **LOBBY** (`/lobby`). Four team cards: Solvalou, Pac Racing Club, Micro
  Mouse Mappy, Dig Racing Team.
- `/games` offers START / CHECK DISC DECK per disc and a 2P HEAD-TO-HEAD CTA. No
  disc boots from that page until the user clicks.
- `/multiplayer` creates or joins a **4-character room code**, assigns the four
  teams, and starts nothing until **both** players are READY.
- The server rolls one of the eight R4 courses **in in-game menu order** — Helter
  Skelter, Wonderhill, Edge of the Earth, Out of Blue, Phantomile, Brightest
  Nite, Heaven and Hell, Shooting Hoops — plus a **preset car per driver**
  (`D1–D4`, `G1–G4`), and broadcasts one `race` payload with `role: host|guest`.
  Both browsers therefore receive the same plan.
- The lounge shows a 3-2-1 **GO** overlay, then posts `rr4-race` to the shell.

### 2.3 `/mp` lobby transport (heartbeat, promotion, cleanup)

`_server/src/server.js`:

- `MP_HEARTBEAT_MS = 20000` — every silent socket is terminated, which also drops
  its player slot and its room.
- Host promotion when the host socket dies; the surviving guest becomes host and
  receives a fresh `room` broadcast.
- Room-list broadcasts on create/join/leave/ready.
- Application message `{type:'ping'}` → `{type:'pong', at, …}`.
- `MP_STALE_ROOM_MS = 5 min` sweep drops rooms nobody is touching.

Verified on a throwaway instance (`node src/server.js` on `:8095`) with
`_server/mp-heartbeat-probe.mjs`: **10/10 checks passed**
(create/join, `ping`→`pong`, full room hidden, host promotion, room removed on
leave, silent socket terminated, zombie room swept). The probe prints its checks
and exits non-zero on failure. It is console-only and writes no JSON file. The
long-running `:8080` was restarted on 2026-11-06 and serves this build; the raw
`/mp` probe observes the app-level `pong` and a server ping there.

### 2.4 Netplay page: auto host/join, host macro, guest gate

`_server/public/js/play-net.js`:

- Parses `mpRole`, `mpRoom`, `mpRace`, `mpTrackIndex` (`0–7`), `mpCarHost`
  (`0–7`), `mpCarGuest` (`0–7`). Missing or invalid values fall back to a random
  roll; the shell handoff and the standalone lounge handoff both carry the three
  index params, so the plan is never rerolled on the way in.
- Host: retry loop (visible stage log) auto-hosts `R4-<code>` with password
  `raceId`. Guest: retries `/list` on the relay until that exact room exists,
  joins, and logs every host stage it receives.
- Host menu macro:
  1. waits for the core, 2 players, an open data channel;
  2. reads R4's main-menu selection byte `0x800AC801` (label table
     `0x800A2180`) to prove it is on the main menu before pressing anything;
  3. Down ×2 → **VS BATTLE** → car P1 (`Right` × `mpCarHost`) → car data →
     AT/MT → AT → car P2 (player index 1, `Right` × `mpCarGuest`) → course
     (`Right` × `mpTrackIndex`) → Circle;
  4. emits `race:starting`, then `race-live` 20 s after the course confirm, once
     the grid is up.
- Car presses are paced against the pad-ack byte `0x800ABD9F`: the macro keeps
  pressing `Right` until the byte has moved exactly `carIndex` steps, because a
  busy host (WebRTC encoding) can swallow a press. The course list does not
  update that byte, so course presses use exact fixed pacing. Stage records keep
  `presses`/`delta` for both.
- The macro harness also does a **frame check**: the final capture must be the
  race, not the yellow car/course menu (`yellowFrac` 0). That check is part of
  the 6/6.
- Course order was calibrated one `Right` per index from Helter Skelter, wrapping
  at 8; car order is `Right` from the default `D1`. Calibration screenshots:
  `_runtime/calib/`.
- Guest gate: `gameManager.simulateInput` is wrapped and **drops input** until
  the host's `race-live` message arrives over the netplay data channel. The host
  also mirrors stage/plan updates into the guest's stage log.

### 2.5 Evidence collected (scoped)

| Harness | Result | Evidence |
|---|---|---|
| `_server/test-mp-lobby-ui.mjs` | 33/33 — two browsers enter the shell, open `/multiplayer`, create/join one room, both READY, same track + car lines, identical `/play-net` `mp*` URL | `_runtime/mp-lobby-ui.json`, `_runtime/mp-lobby-ui-{host,guest}[-room].png`, `.log` |
| `_server/mp-ws-probe.mjs` | 22/22 — raw `/mp` handshake, both-ready race payload, app-level `pong`, server heartbeat ping, room gone after leave | `_runtime/mp-lobby-ws.json` |
| `_server/mp-macro-test.mjs` | 6/6 — real R4 host walks VS Battle to `race:live`, renders the split-screen race, and the frame check proves the final frame is the race (`yellowFrac` 0) | `_runtime/mp-macro-evidence.json`, `_runtime/mp-macro-final.png`, `mp-macro-0*.png` |
| `_server/test-mp-race-e2e.mjs` | 40/40 — two browser contexts, real `/play-net` in both, plan matches the lounge roll, macro reaches `race:live`, race frame metrics pass, guest video `currentTime` advances, guest pad recorded on the host as player 1 / index 0 / value 1 with zero player-0 records | `_runtime/mp-race-e2e.json`, `_runtime/mp-race-e2e-*.png` |
| `_server/mp-heartbeat-probe.mjs` | 10/10 — heartbeat, host promotion, room cleanup, `ping`→`pong` on `:8095` | probe output (console only) |

Scope limits to keep quoting:

- The lounge-UI harness **holds the `/play-net` document** by request
  interception, so it proves the plan and the URL, not the emulator boot.
- The macro harness is **host-only** (synthetic room, no guest browser): 6/6.
- The two-browser race is `harness-verified two-browser` at **40/40**
  (`_runtime/mp-race-e2e.json`, `summary.failed === 0`): real emulator in both
  tabs, `frames.race.raceLike === true` (`yellowPct` 0.1, `nonBlackPct` 64.6 on
  the current artifact), guest stream advancing, guest pad on the host core. It
  is **two contexts on one host**; the operator has since played the same 2P VS
  Battle across **two physical machines** on the LAN (2026-11-06,
  `manually verified two-machine`: no harness, no capture, connection mix not
  recorded), and the guest proof here is a host-stream P2 input test (guest-side
  gameplay parity is not asserted). Guest audio is measured **absent**
  (video-only stream).
- Expected console noise: the netplay `No ICE servers configured` warning and
  the React #418 hydration warning on `/docs/introduction`. Never report
  "0 console errors". COOP/COEP is no longer noise: the server sends it only on
  loopback/HTTPS, so a plain-HTTP LAN origin has no COOP warning.

### 2.6 Music library

- R4: 29 tracks (intro, 27 in-game XA, “One More Win”)
- Rage Racer: 16 CD tracks
- Ridge Racer 1994: 12 CD tracks
- `/api/music`, `/music/manifest.json`, `/music/<game>/*.mp3`
- Manifest generated by `_server/scripts/build-music-manifest.mjs`.

### 2.7 Docs

- Zudoku under `docs/`, `basePath: "/docs"`, built to `docs/dist/docs`, served by
  `_server/src/server.js` at `/docs`.
- Pages cover games, play paths, LAN, R4 2P, REA, architecture, controls,
  troubleshooting, legal, music. The `/welcome` hub, one-top-bar shell and 2P
  lounge handoff are described.
- The intro uses `title: ""` + `sidebar_label` + `seo.title` to avoid a duplicate
  auto-H1; it still emits a non-fatal React hydration warning (#418).
- Rebuild after any page/theme change: `cd docs; npm run build`, then
  `npm run verify` (checks every built page for 200 + one H1, every internal
  `/docs/...` link, the app routes and the section redirects against the
  running cabinet). The docs site is rebuilt and route-checked for this session
  (all `/docs/multiplayer/*`, `/docs/engineering/architecture`,
  `/docs/reference/troubleshooting` and `/docs/introduction` return 200;
  `/docs/multiplayer` 301s to `/docs/multiplayer/lan`; `/docs` 301s straight to
  `/docs/introduction`).

### 2.8 Friction pass (2026-11-06)

Small UX/ops changes, each covered by `_server/test-shell-fs.mjs` or the 2P suite:

- **Soundtrack ducking.** `enter.js` plays the parent track at ~22 % while a
  `/play*` view is active (`ducked`/`effectiveVolume` on
  `window.RR4Shell.getState()`), restoring the slider level on other views.
- **`F` inside the frame.** The shell mirrors `F`/`Esc` from the same-origin
  iframe, so fullscreen works while the game has focus, not only on the shell bar.
- **No second audio gate.** Embedded `/play` and `/play-net`
  (`?embedded=1`) skip EmulatorJS's **CLICK TO RACE** gate; the parent ENTER
  gesture unlocked audio, and the next click unlocks the core.
- **Guest status chip.** The collapsed netplay chip shows the seat, the room and
  `P2 LOCKED` / `P2 LIVE` plus the host's menu stage; the panel's role pill shows
  the same lock state.
- **`/docs` in one hop.** The server 301s `/docs` and `/docs/` to
  `/docs/introduction` (no JS stub), in addition to the section redirects.
- **App scripts revalidate.** `/js/*.js` and `/css/*.css` are `no-cache` + ETag,
  so a change no longer waits out a one-hour `max-age`; `?v=` stays as
  belt-and-braces.
- **Play URL hygiene.** Booting from `?game=` no longer leaves `setup=1` behind,
  so a reload stays in the game instead of reopening the disc deck.
- **One-click rematch.** The game page's **REMATCH** chip posts
  `{type:'rr4-rematch', code, role}` to the shell, which reloads
  `/multiplayer?room=<code>&host=1|0&embedded=1`. The host recreates the same
  code (the server reclaims it when the old room only holds dead sockets); the
  guest retries `join` until it exists. Covered by
  `_server/test-mp-lobby-ui.mjs` (R01–R05, and a second race start).
- **One-command evidence.** `node verify-mp.mjs` runs `/mp`, the lounge UI, the
  shell test and the host macro in one table; `--full` adds the two-browser race.
- **Calibration timeout.** `mp-calibrate.mjs` caps every frame read, so a starved
  renderer reports a timeout instead of hanging the run.

### 2.9 Performance + networking pass (2026-11-06)

Three code packages landed and the manual was re-aligned with them. Evidence is
in `_runtime/bench-native-after-play-perf*.json`,
`_runtime/bench-netplay-after-netplay-tune.json` and
`_runtime/edge-headers-2026-11-06.txt`; the readable summary is
`docs/pages/play/performance.mdx`.

- **`/play`**: volume no longer defaults to 0 when the localStorage key is
  missing (0.70 default; the first `keydown` or gamepad button also unlocks
  audio). `preserveDrawingBuffer` is off unless a ghost recording is possible
  (`?rec=1`, stored REC arm, or AUTHENTIC on a secure context; `?pb=1|0` forces
  it), WebGL is `alpha:false`/`premultipliedAlpha:false`, the fullscreen backing
  store is capped at `min(100vw, 1280px, 100vh*4/3)` (1920×1080 → 1280×960), the
  DLSS 5 grade applies to `#game` only, QUALITY presets
  (`?quality=authentic|balanced|perf|auto`, stored as `rr4.play.quality`) and
  `navigator.storage.persist()` on secure contexts. Bench:
  **60.19–60.24 emu fps**, CV 1.17–1.27 %, input p50 12.7–14.1 / p95 34.0–38.1 ms,
  warm boot 1568–2475 ms, canvas 960×720. `test-shell-fs.mjs` stays 30/30.
- **`/play-net`**: host capture is 60 fps (`captureStream(0)` +
  `requestFrame()`, 8 Mbps/60 ceiling, keyframe on `race-live`/join/freeze).
  Measured host encode **29.29 → 59.08 fps**, guest decoded **29.29 → 57.44**,
  0.92–2.50 Mbps, jitter 11.4 ms, loss 0 %, RTT 0–1 ms. Guest **presented** fps
  is 42–55 (pinned 140 Hz blit duplicates frames) — do not claim a solid 60.
  Guest input is sent once (Socket.IO duplicate suppressed while the data channel
  is open); the 40/40 race now records 2 host records for one press+release.
  Guest QUALITY AUTO/LOW/MED/HIGH + a 2 s `getStats()` line in the stage log and
  `window.__R4NET.stats`. `mp-ws-probe.mjs` 22/22, `mp-macro-test.mjs` 6/6,
  `test-mp-race-e2e.mjs` 40/40.
- **Server edge**: strong ETags everywhere (`If-Range` + `Range` → **206**,
  `If-None-Match` → **304**; the old weak tag made `If-Range` re-send the whole
  357,817,282-byte CHD), brotli/gzip for text assets only
  (`emulator.min.js` 426,343 → 106,924 B br), `keepAliveTimeout` 65 s, opt-in
  `RR4_TLS=1` HTTPS listener on `RR4_TLS_PORT` (default 8443), COOP/COEP for the
  shell document whitelist on loopback/HTTPS (`COEP: credentialless`), and
  `GET /api/netplay-config`. `node scripts/https-smoke.mjs
  http://127.0.0.1:8080` = 47/47 (35/35 on a plain-HTTP LAN origin). The relay
  fold-in is **not** done: `play-net.js` still hardcodes `:3010`.
- `:8080` was restarted on 2026-11-06 with this build; the `:3010` relay was
  **not** restarted and is untouched.

### 2.10 Race Day MMO (`feat/mmo-race-day`, 2026-11-06)

A third room next to the 2P lounge: **one race, up to 50 drivers, one shared
clock, one leaderboard**. Every driver runs R4 locally in their own browser, so
there is no video streaming and no per-driver cost on the server; the server owns
the event and the standings.

Files (new):

```text
_server/src/mmo.js                 Race Day event server (~/mmo room, telemetry, LFG)
_server/src/server.js              additive mount only: import, /race-day document,
                                   attachMmo({server,tlsServer}), /api/mmo/status
_server/public/mmo.html            /race-day page (grid, LFG, standings, results)
_server/public/css/mmo.css         page layout (desktop 1440x900 + mobile 390x844)
_server/public/css/mmo-lfg.css     LFG panel
_server/public/css/mmo-hud.css     /play in-race HUD
_server/public/js/mmo-client.js    /mmo socket, reconnect, state store, telemetry writer
_server/public/js/mmo-ui.js        grid, header, standings, countdown, results, feed
_server/public/js/mmo-lfg.js       queue button, fill/ETA, party code, START NOW, bots
_server/public/js/mmo-spectate.js  watch-only board (?spectate=1)
_server/public/js/mmo-hud.js       /play HUD + RAM telemetry reader
_server/mmo-protocol-test.mjs      /mmo protocol harness (12/12)
_server/mmo-load-probe.mjs         N-socket load probe (synthetic clients)
_server/test-mmo-ui.mjs            two-browser Race Day e2e (41/41)
_server/mmo-shots.mjs              screenshot harness (24/24)
```

Product and contract:

- **Entry points:** RACE DAY in the shell top bar (between PLAY and 2P), the
  primary RACE DAY card on `/welcome`, the RACE DAY CTA on `/games` (R4 only;
  Rage/Ridge show it disabled with the reason), the cross-link strip on
  `/multiplayer`, and `/` with `?mmo=1` or `?party=CODE` (lands on `/race-day`
  after ENTER). Invite link `/race-day?party=CODE`; `?spectate=1` is a
  standings-only board; `?bots=1` / `RR4_MMO_BOTS=1` fills empty seats with
  clearly labelled bots for a one-human demo.
- **State machine:** `lobby → grid (5 s) → countdown (3-2-1 + startsAt) →
  racing → results (20 s) → lobby`, next event id `index + 1`. The server rolls
  one of the eight R4 courses in in-game menu order, a `D` or `G` car class and
  `laps: 3`; the plan is frozen at `grid` and identical for every client.
- **Seats/teams:** seats 1..50; the team cycles with the seat (seat 1 →
  `Solvalou`, then `Pac Racing Club`, `Micro Mouse Mappy`, `Dig Racing Team`),
  and the server prefers the emptiest team; a party of ≤2 tries to share a team.
  Bots occupy real seats and are labelled `BOT`.
- **Telemetry (RE-confirmed, `_runtime/analysis/14-ram-telemetry.md`):** race
  clock `0x800F4E2F` (u32 LE, 1 count = 1 ms; mirror `0x8010C24F`), speed
  `0x800AC0EE` (u16 LE, 8.8 fixed point, km/h = raw / 64), finish when the clock
  flips from a live value to `0xFFFFFFFF`. **Lap counter is unconfirmed.** The
  server clamps `lap` 1..99, `raceTimeMs` 0..3,600,000 and `speedKph` 0..400,
  rejects a backwards `raceTimeMs`, and derives standings from telemetry (never
  from a client-claimed position). `mmo-hud.js` is RAM-first: the label-table
  anchor plus a moving, monotonic clock is what makes it claim `ram`
  (measured 8/8 live samples, 1007 ms per wall second; the in-game clock pins at
  `9:59.999`). A stopwatch is the fallback only when no anchored clock exists;
  the finish transition (`0xFFFFFFFF` after a live clock) is still unverified
  end-to-end because the probe's car never completed three laps.
- **LFG:** the panel is the only thing that starts a human race (`queue`,
  `START NOW` at ≥ `MIN_DRIVERS`, party create/join, spectate, `config {bots}`).
  Standings sort is lap desc then `raceTimeMs` asc; top-N + self + neighbours,
  full 50 rows only in `result`.
- **Environment knobs** (`RR4_MMO_MAX` 50, `RR4_MMO_MIN` 4, `RR4_MMO_FILL_MS`
  60000, `RR4_MMO_GRID_MS` 5000, `RR4_MMO_COUNTDOWN_MS` 3000,
  `RR4_MMO_RESULTS_MS` 20000, `RR4_MMO_RACE_TIMEOUT_MS` 600000,
  `RR4_MMO_HEARTBEAT_MS` 20000, `RR4_MMO_SLOW_BACKLOG` 65536,
  `RR4_MMO_BOTS`). The harnesses shorten a race day with these; the product
  defaults above are unchanged.

Evidence for this branch:

| Harness | Result | Evidence |
|---|---|---|
| `_server/mmo-protocol-test.mjs` | **12/12** — hello/welcome, seating + team balance, start-now lifecycle, plan stability, telemetry ordering, clamps, ~2 Hz standings, finish→result→lobby, heartbeat, seat reclaim, `/api/mmo/status`, 60-client fanout | `_runtime/mmo-protocol.json` |
| `_server/mmo-load-probe.mjs --drivers 550` | **550 sockets / 550 seats** at `RR4_MMO_MAX=550`, **0 dropped**; standings cadence 1.93–1.95 Hz, broadcast p95 527–528 ms (p99 531), grid ≤1,973 B, standings ≤1,290 B, ~1.1–1.4 MB/s total egress | `_runtime/mmo-load-550-single.json` (12/12 gates), `_runtime/mmo-load.json` (ramp) |
| `_server/test-mmo-ui.mjs` | **41/41** — two browsers: ENTER → RACE DAY → LFG → countdown → standings → results, party invite, spectate, `/play?mmo=1` HUD (ROM held, no emulator boot) | `_runtime/mmo-e2e.json`, `_runtime/mmo-e2e-*.png` |
| `_server/mmo-shots.mjs` | **24/24** captures — 1440×900 + 390×844 for lobby/LFG/grid/countdown/standings/HUD/results/spectate/shell entry | `_runtime/mmo-shots.json`, `_runtime/mmo-shot-*.png` |
| existing 2P suite | **unchanged and green** — `/mp` 22/22, lounge 33/33, shell 30/30, macro 6/6, race 40/40 | the `mp-*` artifacts listed in §2.5 |

Honest limits (quote these, not the headline):

- 550 was proved with **synthetic WebSocket clients**, not 550 humans and not 550
  browser cores, and against a server on the same host as the probe.
  **50 is the MVP target**; 500 is the architecture target.
- No ghost cars in Race Day, no video for spectators (they read standings), and no
  persistence: a `:8080` restart begins a new race day with a new event id.
- Telemetry is client-reported with plausibility clamps; there is no anti-cheat
  beyond that and a server-side monotonic clock.
- The in-race HUD is opt-in: `/play?mmo=1&event=<id>&seat=<n>&team=<t>`
  (+ `&game=r4&threads=0`). The `/race-day` page does not auto-navigate today;
  its FINISHED card on `/play` links back to `/race-day`.
- `/race-day` was added to `server.js`; a running process older than this branch
  answers 404 there and has no `WS /mmo`. Restart `:8080` (do not assume it).

### 2.11 Multi-disc 2P lounge (Rage/Ridge shared car, 2026-11-06)

The lounge now covers all three discs instead of R4 only. The disc truth did not
change: **only R4 has a real two-car VS Battle**. Rage Racer and Ridge Racer
1994 are single-player discs, so their 2P mode is a **shared car** — the host
starts a normal single-player race by hand and the guest pad is merged onto the
host's car (`guestPlayerIndex: 0`).

Files (new/changed):

```text
_server/public/mp-games.json       NEW  disc manifest, single source of truth
_server/src/server.js              /mp reads the manifest: create {game}, host-only
                                        setgame before the lock, guest adopts the room's
                                        disc, room/list game+mode, race payload +game/
                                        mode/guestPlayerIndex/trackSelection/trackCount/
                                        carCount; /mp-games.json is served no-cache
_server/public/js/multiplayer.js    DISC selector, mode hint, room-card disc change
                                        (host only), guest selector disabled, invite URL
                                        &game=, handoff &game= data from the server
_server/public/multiplayer.html/.css  selector + room card markup/styles
_server/public/js/play-net.js       fetches /mp-games.json; per-disc plan lists/max; room
                                        prefix from the manifest; macro:auto only for R4;
                                        manual mode + race-live for Rage/Ridge; shared-car
                                        host remap 1 -> 0 via functions.simulateInput;
                                        guest live in shared-car; 2P VS / 2P SHARED brand
_server/public/js/enter.js          shell handoff appends &game=; rematch keeps the disc
_server/mp-games-probe.mjs         NEW  raw /mp + manifest harness (16/16)
_server/test-mp-games-ui.mjs       NEW  two-browser disc-selector/takeover harness (32/32)
```

Behaviour, in one place:

- **Host creates the disc.** `create` carries `game` (default `r4`). Only the
  host may `setgame` and only before the grid locks; a guest `setgame` or a
  late one gets an `error`. A change clears the old `track`/`cars`.
- **Guest adopts.** `join` sends the code only; the room's disc wins. Room state
  and the room list carry `game`/`mode` so both seats show the same disc.
- **Plans come from the manifest.** r4: 8 courses in in-game menu order + 8
  preset cars; rage: 4 courses + `CAR 1–4`; ridge: 1 course (Seaside Route 765) +
  `Solvalou`/`Mappy`/`Bosconian`/`Nebulasray`. Handoff `mpTrackIndex` is 0–7 /
  0–3 / 0 and `game=` always travels with it.
- **Rooms are prefixed per disc:** `R4-`, `RAGE-`, `RIDGE-` (from the manifest).
- **R4 is untouched:** `macro: auto`, `macroVerified: true`, the same menu byte
  `0x800AC801`, the same car/course press pacing, the same `race-live` guest gate.
- **Rage/Ridge:** `macro: manual`. The host walks no menus; it starts a
  single-player race by hand. `play-net.js` wraps
  `gameManager.functions.simulateInput` so guest player 1 becomes player 0 (both
  pads drive the host car), marks the guest live from boot (no `race-live` gate),
  logs `MANUAL 2P - host starts a single-player race; both pads drive.`, and
  shows `GUEST P2 SHARED` → `GUEST P2 LIVE` / `2P SHARED` instead of
  `P2 LOCKED` → `P2 LIVE` / `2P VS`.
- **Rematch keeps the disc:** `{type:'rr4-rematch', code, role, game}` →
  `/multiplayer?room=…&host=1|0&embedded=1&game=<key>`; a guest deep link
  (`?game=…`) is adopted but the room's disc still wins once joined.
- **The live `:8080` is on this build (restarted 2026-11-06).** Before the
  restart it answered `create {game:'rage'}` with a `room` frame **without**
  `game`/`mode` and served `/mp-games.json` with `max-age=3600`; the restarted
  process answers with `game`/`mode` and `no-cache`. Any later `src/server.js`
  edit needs another restart before a manual browser check; the harnesses below
  spawn their own instances and do not need it.

Evidence for this change:

| Harness | Result | Evidence |
|---|---|---|
| `_server/mp-games-probe.mjs` | **16/16** — `/mp-games.json` shape, per-disc rolls (r4 8/8, rage 4/4, ridge 1/4), room/list `game`+`mode`, host-only `setgame`, guest adoption, invalid-key fallback, unchanged R4 `race` shape, identical payloads, cleanup. Spawns its own `:8097` (never `:8080`); no browser | `_runtime/mp-games.json` |
| `_server/test-mp-games-ui.mjs` | **32/32** — two browsers: RAGE and RIDGE select/create/join/host disc change/READY/GO, both handoffs carry `game=`, shared-car overlay + one car line, R4 regression (VS card + two cars + `game=r4`), `?game=` deep link, `localStorage` persistence, 390×844 overflow. `/play-net` held, so no emulator boot | `_runtime/mp-games-ui.json`, `_runtime/mp-games-lounge-host.png`, `mp-games-lounge-mobile.png`, `mp-games-grid-rage.png`, `mp-games-grid-ridge.png` |
| `_server/test-mp-shared-car.mjs` | **14/14 host-only** — the real Rage core boots, `mode=shared-car`/`macro=manual`, plan clamps to 4/4, room `RAGE-TEST`, brand `2P SHARED`, no R4 menu stage, and the `player 1 → 0` remap installs and counts a press. One browser, no guest, **no live drive** | `_runtime/mp-shared-car.json`, `_runtime/mp-shared-car-rage.png` |
| `_server/mp-ws-probe.mjs` | **22/22 unchanged** — the legacy R4 probe (no `game`) still gets the same R4 `race` shape; re-run 2026-11-06 16:16 against the restarted `:8080` | `_runtime/mp-lobby-ws.json` |
| `_server/test-mp-lobby-ui.mjs` | **33/33 unchanged** — the R4 lounge UI/rematch path still passes | `_runtime/mp-lobby-ui.json` |
| `_server/mp-macro-test.mjs` / `_server/test-mp-race-e2e.mjs` | **6/6** / **40/40**, re-run 2026-11-06 16:20 against the restarted build, still **R4-only** evidence — do not reuse for Rage/Ridge | `_runtime/mp-macro-evidence.json`, `_runtime/mp-race-e2e.json` |

Commands that produced this (each harness starts and kills its own throwaway
cabinet, so the live `:8080` is not restarted):

```powershell
cd _server
node mp-games-probe.mjs        # 16/16 -> _runtime/mp-games.json
node test-mp-games-ui.mjs      # 32/32 -> _runtime/mp-games-ui.json + 4 screenshots
node test-mp-shared-car.mjs    # 14/14 host-only -> _runtime/mp-shared-car.json
node mp-ws-probe.mjs           # 22/22 R4 regression -> _runtime/mp-lobby-ws.json
node test-mp-lobby-ui.mjs      # 33/33 R4 regression -> _runtime/mp-lobby-ui.json
```

The live cabinet is already on this build (restarted 2026-11-06). After any
further `src/server.js` edit, restart `:8080` before a manual browser check:

```powershell
cd _server
.\start-test.bat               # web server only; restarts :8080 with this build
```

Known gaps (quote these):

- **Rage/Ridge in-game play is unverified.** The Rage core boots and the manual
  shared-car remap installs under `test-mp-shared-car.mjs` (14/14, host-only),
  but no harness has driven a live shared-car race (no guest, no full lap). The
  label is `netplay transport; in-game mode unverified`, never "2P works".
- **No automatic macro on Rage/Ridge.** There is no menu address and no course
  calibration for them; the host starts the race by hand. Do not document a
  Rage/Ridge menu byte or a lap address.
- **R4 is unchanged.** The macro, the guest gate, the room prefix `R4-`, the
  handoff for an R4 room, and the 6/6 + 40/40 evidence all still apply to R4
  only.
- Docs for this area: `docs/pages/multiplayer/shared-car.mdx` (+ the lounge/lan
  pages and the game pages); `/docs/multiplayer/shared-car` returned 200 on the
  running `:8080` when checked 2026-11-06. The manifest is the contract — if a
  name, id, mode, track count or car count changes, change
  `_server/public/mp-games.json` first and re-run both harnesses.

Next agent command (works from a clean shell, no `:8080` dependency):

```powershell
cd _server
node mp-games-probe.mjs; node test-mp-games-ui.mjs; node test-mp-shared-car.mjs; node mp-ws-probe.mjs
```

### 2.12 Ghost — Route A replay + Route B live ghost (Rage/Ridge, 2026-11-06)

A **third** 2P mode next to the R4 VS Battle and the shared car, and the only one
that is not simultaneous: **GHOST is turn-based on the host core**. One seat
drives (the other pad is gated), the game records the run into its own native
tape, and the peer gets a ghost out of it in two ways:

- **Route A — post-race native replay** (`ghost replay (sequential)`): the
  built-in results screen plays the other seat's previous tape full screen.
- **Route B — live ghost** (`ghost rendered (in-game)`): the peer tape is applied
  to a spare rival car slot every frame while the race runs, so the game's own
  renderer draws a second car. **Ridge Racer 1994's race screen and Rage Racer
  Grand Prix only**; Rage **Time Attack** never draws the rival slots and stays
  replay-only (`draw-path-unverified`). Opt-in flag `mpLiveGhost=1`, which the
  shell and the standalone lounge append for every `drive: ghost` room (the
  product default); `mpLiveGhost=0`/absent leaves Route A byte-identical.
  Runtime RAM injection only: a stub written after boot plus ONE repointed shipped
  word, restored after the run. **Drawn, not simulated** — no collision, no AI.

Design and probes: `_runtime/ghost-research/` (`IMPLEMENTATION-A.md`,
`tape-probe.md`, `rage-finish-probe.md`, `ridge-rea.md`, `rage-rea.md`,
`live-ghost-probe.md`, `ridge-live-ghost.md`, `ghost-tape.md`).

Files (new/changed):

```text
_server/public/multiplayer.html / css/multiplayer.css   DRIVE LIVE|GHOST start control,
                                                        room-card DRIVE + TURN rows,
                                                        rooms-list GHOST badge, DRIVER overlay
_server/public/js/multiplayer.js     drive/turn selectors (host-only before the lock), guest
                                     read-only, invite URL +drive/turn, handoff +mpGhost/mpTurn,
                                     rematch payload drive/turn, localStorage rr4.mp.drive
_server/public/js/enter.js           shell handoff + rematch reload carry drive/turn
                                     (a ghost rematch flips the turn)
_server/src/server.js                /mp: create {game,drive,turn}, host-only drive/turn,
                                     room state drive/turn, room list drive, race payload +drive/turn
_server/public/js/play-net.js        ghost engine (window.__R4GHOST): PSX RAM scan, tape
                                     capture/swap, Ridge BSS staging + 0x80080434 pointer,
                                     Rage scene-12 finish arm, turn gate, WATCH RIVAL,
                                     IndexedDB rr4-ghost/runs
_server/test-mp-ghost-replay.mjs     NEW  engine harness (40/40)
_server/test-mp-live-ghost.mjs       NEW  Route B live ghost harness (36/36)
_server/test-mp-ghost-lobby.mjs      NEW  two-browser lounge/rematch harness (36/36)
```

Contract:

- `drive`: `live` | `ghost` (default `live`); `turn`: `host` | `guest` (default
  `host`, only meaningful in ghost). Both are whitelisted in `create` and
  host-only afterwards (`{type:'drive'}` / `{type:'turn'}`), rejected once
  `started` or from the guest. The **server never flips the turn**; the page
  flips it on rematch and passes it back through the lounge URL.
- Handoff adds `&mpGhost=ghost&mpTurn=host|guest`; `live` rooms send
  `mpGhost=live` and no `mpTurn`, and an R4 room sends no `mpTurn` (the shell
  still emits `mpGhost=live`; the standalone lounge omits it). Rematch reload is
  `/multiplayer?room=<code>&host=1|0&embedded=1&game=<key>&drive=ghost&turn=<next>`.
- Lounge: `DRIVE LIVE|GHOST` is enabled only for `rage`/`ridge` (`R4` shows it
  disabled with `RAGE + RIDGE ONLY`), the ghost hint reads
  `GHOST · TURN-BASED TIME TRIAL - THE RUN YOU FINISH BECOMES THE OTHER'S GHOST`,
  the room card reads `DRIVE GHOST // TURN-BASED TIME TRIAL` with a host-only
  `TURN HOST|GUEST`, and GO shows `DRIVER: HOST|GUEST` with one
  `SHARED // <car> · DRIVER: …` line (live keeps `SHARED CAR // BOTH PADS DRIVE`).
- Engine: the PSX 2 MiB window is found by scanning `Module.HEAPU8` for the exe
  text at `0x80010000` (`ramBase = hit - 0x80000000`, cached). Tapes live in
  IndexedDB `rr4-ghost` → `runs`, key `${room}:${game}`, one record per seat,
  newest wins, cap 43,200 B, in-memory fallback.
  **Ridge Racer 1994** — screen id `0x801D6D28` (7 results, 8 replay setup,
  9 playback), count `0x801EB020`, recorder idle `0x801D6D18`, 40-byte records;
  capture on screen 7 clamped to **161 records**, stage into a zeroed BSS run and
  repoint the applier pointer `0x80080434` (writes at the documented fixed base
  `0x8006CE7C` never reach the applier); swap before the results wait ends, never
  on 8/9; `WATCH RIVAL` arms 8 → 9. **Rage Racer** — scene `0x801E3FEC`, tape
  `0x801E8804`, count `0x8019C874`, write `0x801E48B8`, read `0x801F30C4`,
  wrapped `0x8009E994`, mode `0x801E4AB4` (stride 48 GP / 28 TA); capture at the
  first scene-17 tick (15/16 are only a fallback), swap at 16/17 for a same-mode
  peer only (else `GHOST // MODE MISMATCH`), re-seed count/write/read/wrapped;
  `replayNow()` in scene 12 arms the RACE frame's own finish branch
  (`g_RacePhase` `0x801E6B7C` = 4, `lap = raceLength + 1`, finish timer 0) so the
  game calls `BeginReplay` + `SetScene(17)` itself — **no scene poke**.
- Turn gate (host only): wraps `gameManager.functions.simulateInput`. `turn=host`
  keeps player 0 and drops player 1; `turn=guest` keeps player 1 remapped to 0
  and drops player 0 (`mpGhost.gatedInputs` / `.remappedInputs`). The shared-car
  remap is not installed in ghost mode. A ghost guest installs no local gate and
  is live from boot, but only the host's gate decides who drives.
- Scheduler: one ~16 ms interval, capture once per run, swap once before the
  replay, log `GHOST // CAPTURED <seat> <n>f` / `GHOST // REPLAY <peer> <n>f` /
  `GHOST // NONE`; panel status `GHOST // REPLAY HOST RUN` /
  `GHOST // WAITING FOR RIVAL` / `GHOST // NO TAPE YET`; chip prefixed `GHOST`.
- Route B (`mpLiveGhost=1`, `window.__R4NET.live`): the stub is installed at boot
  and the hook word is **only applied inside the race**, restored outside — a
  boot-time patch stalls Rage's scene-32 prologue. **Ridge Racer 1994:** hook
  `0x80015014` `0x0C0092E3` → `0x0C07A984`, stub `0x801EA610` (208 B / 52 words) in
  a runtime-verified quiet BSS band (a guard word above the scratch re-places the
  block if the game writes over it), slot 11 `0x801EDA10` (array base
  `0x801ECE34`; the old `0x801FDA10` was `0x10000` high), tape `0x801E4840`
  (600 × 40 B), applier `0x8002A894`, `0x80080434` saved/restored per apply, count
  gate `0x801EB020`. **Rage Racer Grand Prix:** hook `0x8003875C` `0x27BDFFD8` →
  `0x0807D1C0`, stub `0x801F4700` (324 B / 81 words), slot `g_Cars[10]`
  `0x801F4194`, tape in the second buffer `0x801F4850` (inside the 43,008 B free
  span), pointers `0x8009EDAC`/`0x8019C4AC` swapped per apply, recorder
  `0x80036F4C` **kept** so A still captures the same run. Panel statuses
  `GHOST // LIVE (RIDGE)` / `GHOST // LIVE (RAGE GP)`, else
  `GHOST // REPLAY (draw-path-unverified|not-in-race|guest-core)`; the LIVE row
  carries an ON/OFF toggle and `SYNTHETIC <n>f x <stride> B @ 0x…`.
  `mpLiveGhost` absent → no stub, no patch, no LIVE row (A unchanged);
  `mpGhost=live` and R4 keep B off. The ghost is drawn, not simulated.

Evidence for this change:

| Harness | Result | Evidence |
|---|---|---|
| `_server/test-mp-ghost-replay.mjs` | **40/40** — Ridge: 161×40 synthetic tape staged in a zeroed BSS run with the applier pointer repointed, replay reached (8→9), live car pose equal to the tape on every sampled frame (53–54 samples, 27 distinct playback frames) and 322/322 peer samples, mirrored peer tape changes the rendered frame; Rage: real TA run captured, scene-12 arm → scene 17 (no poke), 107/107 pose samples, mirrored-tape frame change; turn gate both ways; IndexedDB reopen; `mpGhost=live`/R4/ghost-guest paths off; no page errors | `_runtime/mp-ghost-replay.json`, `_runtime/mp-ghost-ridge-replay*.png`, `_runtime/mp-ghost-rage-{menu,select,race,scene17,replay,frozen-a,frozen-b}.png` |
| `_server/test-mp-live-ghost.mjs` | **36/36** — own `:8088` cabinet, one real host core per disc, synthetic tapes: Rage GP stub `0x801F4700` (324 B / 81 words) and Ridge stub `0x801EA610` (208 B / 52 words) read back byte-identical; the shipped words `0x27BDFFD8` / `0x0C0092E3` are repointed only inside the race (toggles 2); the ghost slot (`0x801F4194` / `0x801EDA10`) carries the tape pose **16/16** on both discs; the A/B frame delta beats the noise floor (Rage 1118 cells / 16.17 % vs 0; Ridge 846 / 12.24 % vs 83); the player still drives (298 / 318 units); the stub survives ~10 s; the Ridge band re-places once; A still captures in the same run (recorder kept); the turn gate is unchanged both ways; `mpLiveGhost` absent → no stub/patch/LIVE row and A reaches its replay (screen 9); `mpGhost=live` and R4 keep B off; 0 page errors; the spawned cabinet is killed and `:8080` re-probed | `_runtime/mp-live-ghost.json`, `_runtime/mp-live-ghost-rage-{off,on}.png`, `_runtime/mp-live-ghost-ridge-{off,on}.png`, `_runtime/mp-live-ghost-a-replay.png` |
| `_server/test-mp-ghost-lobby.mjs` | **36/36** — two browsers: R4 drive control disabled + unchanged invite/handoff, RIDGE LIVE/GHOST + `rr4.mp.drive`, room `DRIVE GHOST`/host-only `TURN`, guest read-only, rooms-list `GHOST` badge, `DRIVER: GUEST` overlay, both handoffs `mpGhost=ghost&mpTurn=guest`, rematch flips to `turn=host` + same code, `live` regression, 390×844 no overflow, 0 page errors | `_runtime/mp-ghost-lobby.json`, `_runtime/mp-ghost-lobby-{host,overlay,mobile,rematch}.png` |
| existing 2P suite | **unchanged and green** — 16/16, 32/32, 22/22, 33/33, 30/30, 6/6, 40/40 R4 race | the `mp-*` artifacts in §2.5 / §2.11 |

Commands (each harness spawns and kills its own cabinet; `:8080` is untouched):

```powershell
cd _server
node test-mp-live-ghost.mjs    # 36/36 -> _runtime/mp-live-ghost.json (own :8088, walks)
node test-mp-ghost-replay.mjs  # 40/40 -> _runtime/mp-ghost-replay.json (own :8096, walks)
node test-mp-ghost-lobby.mjs   # 36/36 -> _runtime/mp-ghost-lobby.json (own :8093)
node mp-ws-probe.mjs           # 22/22 R4 regression
node test-mp-lobby-ui.mjs      # 33/33 R4 lounge regression
node test-mp-race-e2e.mjs      # 40/40 R4 race regression
```

Known gaps (quote these):

- **The live ghost is drawn, not simulated.** Route B applies a tape pose to a
  spare rival slot every frame: no physics, no collision, no shadow, no AI, and no
  second car you can race or hit. It is also **mode-gated**: Ridge's race screen
  and Rage **Grand Prix** only. Rage **Time Attack** never draws the rival slots
  and stays a post-race replay (`draw-path-unverified`) — never call a TA ghost a
  ghost car.
- **The harness tapes are synthetic.** Ridge uses a 161-record tape built from
  the live pose (and a 600-record tape for the live-ghost staging); the Rage rival
  is a real short Time Attack run captured through the product (100 subframes → 50
  samples, ~1.7 s of tape) plus a synthetic 240-subframe GP tape for Route B, and
  the A run is stopped by the finish arm, not by crossing the line. **No human lap
  has been recorded.**
- **Ridge writes do not land at the documented fixed base.** The tape is staged
  in a zeroed BSS run with the applier pointer `0x80080434` repointed; 161
  records is the A applier cap before the screen dispatch table `0x8006E7BC`, and
  Route B stages 600 records in the quiet band and loops the cursor.
- **The engine harnesses are host-only** (one real core per disc, relay optional,
  no guest GUI). It is not a two-machine result, and the ramp/turn gate is proved
  by synthetic pad presses, not by two humans.
- **R4 is untouched** by ghost mode (`mpGhost`/`mpLiveGhost` are ignored for R4)
  and its 6/6 + 40/40 evidence stays R4-only.
- Docs page for this area: `docs/pages/multiplayer/ghost-run.mdx` (written by the
  docs session; keep `ghost replay (sequential)` for A, `ghost rendered
  (in-game)` for B, and the 36/36 + 40/40 + 36/36 numbers aligned with this file).

Next agent command (works from a clean shell, no `:8080` dependency):

```powershell
cd _server
node test-mp-live-ghost.mjs; node test-mp-ghost-replay.mjs; node test-mp-ghost-lobby.mjs; node mp-ws-probe.mjs; node test-mp-lobby-ui.mjs
```

---

## 3. Reverse-engineering findings (important)

No full R4 decomp exists in the workspace or publicly. The best available R4 RE
data is **`tetrisgm/RidgeRacerType4Recomp`** (partial symbol map, seeds, generated
instruction-level C, WIDESCREEN/ONLINE_BATTLE docs). The local `_runtime/r4-seeds.txt`
is a first-pass JAL-target list (1,178 addresses, no names).

Key R4 addresses/strings recovered:

- Main menu label table `0x800A2180`, 16-byte stride:
  `WELCOME, DEMONSTRATION, GRAND PRIX, TIME ATTACK, VS BATTLE, GARAGE, RECORDS, SAVE AND LOAD, OPTIONS, EXTRA TRIAL, LINK BATTLE, EPILOGUE, MUSIC PLAYER`
- The shipped macro reads the menu selection byte as **`0x800AC801`** (label
  base + 0x281). `0x800ACC40` was the earlier probe address for the same list.
  Menu state block `0x800AC808`.
- Menu draw consumer around `0x8005C7F0`; scene dispatch `0x8001E78C`.
- Course table `0x800A19E8` (8 × 0x18): Helter Skelter, Out of Blue, Edge of the
  Earth, Brightest Nite, Wonderhill, Heaven and Hell, Phantomile, Shooting Hoops.
  (Table order ≠ in-game menu order — the macro/lobby use **menu** order.)
- VS/link lobby strings `0x80035A84–0x80036410`; overlay module entries **659–672**
  in `R4.BIN`; entry 661 contains `PLAYER 2` / `job_vs_car_info0`.
- Pad buffers: P1 `0x8010C2D2` / `0x8011457A`; P2 `0x8010C2FA` / `0x8011459D`.

Menu automation (empirically calibrated in EJS):

- EJS PSX button indices: Cross 0, Circle 8, Select 2, Start 3, Up 4, Down 5,
  Left 6, Right 7, Triangle 9.
- Title → VS battle: Start (skip intro) → Start (WELCOME) → Down ×2 → Circle →
  Circle → car P1.
- Car select: P1 uses player 0; the P2 screen requires **player 1** input
  (`simulateInput(1, …)`), not player 0. Three Circle presses with ~1.5 s spacing
  advance each car screen reliably. Car order: D1, D2, D3, D4, G1, G2, G3, G4
  (clamps at G4).
- Course select: 8 courses wrap; Left/Right changes course; Circle confirms.
- **There is no in-game RANDOM option.** Random must come from menu movement.
- `__R4NET.simulateInput(player, …)` ignores its `player` argument on the host
  (host = P1, guest = P2). The macro uses
  `EJS_emulator.gameManager.functions.simulateInput(player, …)` for P2.
- Native `--debug-port` exists in the binary but is compiled out
  (`PSX_NO_DEBUG_TOOLS`), so it does nothing. A rebuild with
  `-DPSX_DEBUG_TOOLS=ON` is required; this revision only supports pad-1 debug
  input.
- Native `recomp-net` is stubbed (`netplay start failed (-1)`); do not rebuild it
  first.
- Native `keybinds.ini` maps `[player2]` identically to `[player1]`, and
  `settings.toml` has `p2_device = "none"`. `_server/src/input.js` has the
  distinct P2 map (I/J/K/L, Tab/Backspace, …) the relay actually uses.

---

## 4. Known bugs / open work (priority order)

### P0 — finish the 2P proof (closed 2026-11-06, except hardware)

1. **Two-browser guest proof — done.** `_server/test-mp-race-e2e.mjs` runs two
   browser contexts, both land on the real `/play-net`, the host macro walks to
   `race:live`, and the guest pad is recorded on the host core as player 1 /
   index 0 / value 1 with zero player-0 records. **40/40**,
   `_runtime/mp-race-e2e.json` + `_runtime/mp-race-e2e-*.png`,
   `harness-verified two-browser`.
2. **Two physical machines — confirmed by hand; guest audio is measured
   `absent`.** The 40/40 run is two contexts on one host, but the operator has
   played a full 2P VS Battle across two physical machines on the LAN
   (2026-11-06) and reports it works (`manually verified two-machine`; no harness
   run, wired/Wi-Fi mix not recorded). Remote audio is not "unheard": the 4.3
   host captures from `Module.AL.currentCtx`, which is `null` under
   RWebAudio, so the stream is video-only (`[NETPLAY HOST] No audio tracks
   captured - guests will have no audio`; measured host tracks `["video:live"]`,
   guest `remoteEls: 0`, no inbound audio RTP).
3. **Docs rebuild — done.** `cd docs; npm run build` succeeds and the routes are
   checked (`/docs/multiplayer/lounge`, `/docs/multiplayer/r4-2p`,
   `/docs/engineering/architecture`, `/docs/reference/troubleshooting`,
   `/docs/introduction` → 200; `/docs/multiplayer` → 301
   `/docs/multiplayer/lan`; one `<h1>` per page).
4. **`:8080` restart — done 2026-11-06.** It now serves the heartbeat build;
   `mp-ws-probe.mjs` observes `pong` and a server ping. Restart again after
   future `/mp` edits.
5. **Standalone `/multiplayer` handoff** — fixed 2026-11-05: it now appends
   `mpTrackIndex`/`mpCarHost`/`mpCarGuest` from the server's `race` message, so
   `/play-net` keeps the rolled plan outside the shell too.
6. **Fullscreen shell button** (`#rr4sFs` / `#rr4sFsExit`) — wired 2026-11-05:
   `document.documentElement.requestFullscreen()`, `fullscreenchange` sync, `F`
   shortcut, exit button. `_server/test-shell-fs.mjs` passes **30/30**
   (A4/A9/A11/A12 included); the document, not `#rr4-shell`, is the fullscreen
   element, and the harness accepts either.
7. **Docs hydration warning #418** on `/docs/introduction`; non-fatal, expected
   console noise. Do not call it "0 console errors".

### P1 — polish

1. Docs pages still need a screenshot/step section for the shell fullscreen
   button; the host macro now has the two-browser proof and the frame-check
   screenshots (`_runtime/mp-race-e2e-*.png`).
2. Embedded `/play-net` and `/lobby` fill and mobile layout need the same
   screenshot pass `/play` already had.
3. **Fixed 2026-11-05:** embedded docs no longer show a second bar — the shell
   injects `header.sticky{display:none}` when the frame is `/docs*` and opens the
   field manual as `/docs/introduction?embedded=1`.
4. Docs route `/multiplayer` (→ `/multiplayer/lan`) collides with the app route
   `/multiplayer`. Keep the distinction documented.
5. Audio ducking during a race **is implemented**: `enter.js:72` `RACE_DUCK =
   0.22`, applied by `effectiveVolume()` for any view whose name starts with
   `play`; `_runtime/shell-fs.json` A13 proves duck (`ducked=true volume=0.42
   effective=0.0924`) and B14 proves restore.
6. `mp-heartbeat-probe.mjs` prints to the console and writes no evidence file.
   Consider writing `_runtime/mp-heartbeat.json`.
7. **Rage/Ridge shared car is unproven in game.** The lounge disc selector,
   host-only `setgame`, guest adoption, `game=` handoff and the player 1 → 0
   remap exist and are covered by `mp-games-probe.mjs` (16/16) and
   `test-mp-games-ui.mjs` (32/32), but no harness boots Rage/Ridge on
   `/play-net`. Next step: a two-browser harness that holds nothing, selects
   RAGE, starts a single-player race by hand on the host, presses a pad on the
   guest and records the remapped player-0 input on the host core. Until then
   the label stays `netplay transport; in-game mode unverified`.
8. **Doc follow-through for the shared car.** `docs/pages/multiplayer/shared-car.mdx`
   must be linked from the lounge/lan/game pages with the `&game=` handoff and
   the "no macro, no second car" limits; rebuild the manual (`cd docs; npm run
   build; npm run verify`) before calling the feature done.

### P2 — native recomp 2P path

1. Fix `RidgeRacer4Recomp/keybinds.ini` P2 bindings or make `_server/src/input.js`
   parse the INI.
2. Set `p2_device = "keyboard"` or a second pad GUID.
3. Native host-stream `/lobby` already has seats/ready/countdown/start; add a
   native key macro if “both players in one recompiled instance” is required.
4. Native debug server and `recomp-net` are compiled out; rebuilding with
   `-DPSX_DEBUG_TOOLS=ON` and a newer psxrecomp is the deterministic route.
5. The native host-stream needs the native game + ffmpeg + a foreground window;
   `start-test.bat` has no native cabinet.

---

## 5. Current commands

Start cabinet + relay (normal):

```powershell
cd _server
.\start-test.bat
```

Start manually:

```powershell
cd _server
node src/server.js
# separate window:
cd netplay
$env:PORT='3010'; node server.js
```

2P evidence (server must already be running; the macro needs the real disc):

```powershell
cd _server
node verify-mp.mjs           # fast set in one table (22/22, 33/33, 30/30, 6/6)
node verify-mp.mjs --full    # + the two-browser race
# or individually:
node test-mp-lobby-ui.mjs    # lounge UI + handoff -> _runtime/mp-lobby-ui.json
node mp-ws-probe.mjs         # raw /mp            -> _runtime/mp-lobby-ws.json
node mp-games-probe.mjs      # multi-disc /mp     -> _runtime/mp-games.json
node test-mp-games-ui.mjs    # multi-disc lounge  -> _runtime/mp-games-ui.json
node test-mp-live-ghost.mjs  # live ghost (B)     -> _runtime/mp-live-ghost.json
node test-mp-ghost-replay.mjs # ghost engine (A)   -> _runtime/mp-ghost-replay.json
node test-mp-ghost-lobby.mjs  # ghost lounge       -> _runtime/mp-ghost-lobby.json
node test-shell-fs.mjs       # shell/fullscreen   -> _runtime/shell-fs.json
node mp-macro-test.mjs       # host-only macro    -> _runtime/mp-macro-evidence.json
node test-mp-race-e2e.mjs    # two-browser race    -> _runtime/mp-race-e2e.json
```

The two multi-disc harnesses spawn their own throwaway cabinet (`mp-games-probe`
on `:8097`, `test-mp-games-ui` on `:8093`) and kill only that child; neither
needs the live `:8080`. The ghost harnesses follow the same rule: the live-ghost
harness spawns its own cabinet on `:8088` (walks to the next free port, one real
host core per disc) and re-probes `:8080` at the end, the engine harness on
`:8096` (walks) and the lounge harness on `:8093`, each killing only its own tree.

Race Day evidence (the protocol/load probes expect a throwaway instance on
`:8097`; the e2e spawns and kills its own cabinet on `:8093`; the screenshot
harness drives the running `:8080` unless `RR4_BASE` overrides it):

```powershell
cd _server
# throwaway instance for the protocol + load probes:
$env:RR4_PORT='8097'; $env:RR4_NO_AUTOSTART='1'; $env:RR4_STREAM_SOURCE='test'; $env:RR4_MMO_MAX='550'; node src/server.js
# second window:
node mmo-protocol-test.mjs              # 12/12 -> _runtime/mmo-protocol.json
node mmo-load-probe.mjs --drivers 550   # 550 sockets -> _runtime/mmo-load.json
node test-mmo-ui.mjs                    # 41/41 two-browser -> _runtime/mmo-e2e.json
node mmo-shots.mjs                      # 24/24 captures -> _runtime/mmo-shots.json
```

`:8080` is the live cabinet: `/race-day`, `/mmo.html` and `/api/mmo/status`
return 200 there and `ws://127.0.0.1:8080/mmo` accepts a socket (checked
2026-11-06). Restart `:8080` after any `src/mmo.js` or mount change.

Heartbeat / host promotion / stale rooms on a throwaway instance:

```powershell
cd _server
# start a throwaway instance first:
$env:RR4_PORT='8095'; $env:RR4_NO_AUTOSTART='1'; $env:RR4_STREAM_SOURCE='test'; node src/server.js
# second window:
node mp-heartbeat-probe.mjs 8095
```

Probe result in this session: **10/10 checks passed** (`ALL CHECKS PASSED`;
console only, no JSON file).

Docs:

```powershell
cd docs
npm install
npm run build
npm run verify             # against the running :8080 (app routes + 301s)
```

Edge headers / TLS (server change):

```powershell
cd _server
node scripts/https-smoke.mjs http://127.0.0.1:8080     # 47/47
node scripts/https-smoke.mjs http://<host-lan-ip>:8080 # 35/35, no COOP by design
powershell -ExecutionPolicy Bypass -File scripts\make-cert.ps1
.\start.ps1 -Tls                                      # HTTPS :8443 beside :8080
node scripts/https-smoke.mjs https://localhost:8443    # 47/47
```

`RR4_TLS=1` (plus `RR4_TLS_PORT`, `RR4_TLS_CERT`/`RR4_TLS_KEY`, default
`certs/rr4-cert.pem` / `rr4-key.pem`) starts the second listener; a missing cert
logs one line and leaves `:8080` serving HTTP.

Music manifest:

```powershell
cd _server
node scripts/build-music-manifest.mjs
```

Native recomp:

```powershell
& "<repo>\Play Ridge Racer 4.bat"
```

Recommended Chrome flags for the harnesses are already in the scripts. The
two-browser harnesses (`test-mp-lobby-ui.mjs`, `test-mp-race-e2e.mjs`) set a
generous `protocolTimeout` because two EmulatorJS pages exceed the default.

---

## 6. File ownership / key paths

```text
_server/public/enter.html            default ENTER shell
_server/public/js/enter.js           shell audio/nav/theme/fullscreen/2P handoff (+&game=)
_server/public/css/enter.css         shell + gate + fullscreen
_server/public/welcome.html          Ridge City hub
_server/public/css/welcome.css
_server/public/games.html             machine check
_server/public/css/games.css
_server/public/multiplayer.html       2P lounge
_server/public/js/multiplayer.js      lobby UI + DISC selector + DRIVE/TURN + race handoff URL
_server/public/css/multiplayer.css
_server/public/mp-games.json          disc manifest (single source of truth)
_server/public/play-net.html          netplay page shell
_server/public/js/play-net.js         auto host/join, R4 macro, shared-car remap, ghost A tape engine,
                                      ghost B live-ghost stub + one-word patch, guest gate/gate-less
_server/public/mmo.html               Race Day page (/race-day)
_server/public/js/mmo-client.js       /mmo socket, state store, reconnect
_server/public/js/mmo-ui.js           grid/standings/countdown/results/feed
_server/public/js/mmo-lfg.js           LFG queue, party code, START NOW, bots
_server/public/js/mmo-spectate.js      watch-only board (?spectate=1)
_server/public/js/mmo-hud.js           /play HUD + RAM telemetry reader
_server/public/css/mmo.css            /mmo-lfg.css            /mmo-hud.css
_server/src/server.js                 Express/WS, /mp, /race-day, /welcome, /multiplayer
_server/src/mmo.js                    Race Day event server (/mmo, /api/mmo/status)
_server/test-mp-lobby-ui.mjs          two-browser lounge UI harness
_server/mp-ws-probe.mjs               raw /mp WebSocket probe
_server/mp-games-probe.mjs            multi-disc manifest + /mp probe (16/16)
_server/test-mp-games-ui.mjs          multi-disc lounge UI/handoff harness (32/32)
_server/mp-macro-test.mjs             host-only macro harness
_server/test-mp-race-e2e.mjs          two-browser race harness (guest P2)
_server/test-mp-ghost-replay.mjs      ghost engine harness (Ridge tape swap, Rage arm)
_server/test-mp-ghost-lobby.mjs       ghost lounge/handoff/rematch harness
_server/test-mp-live-ghost.mjs        live ghost (Route B) stub + patch harness
_server/mp-heartbeat-probe.mjs        heartbeat/promotion/stale-room probe
_server/mp-calibrate.mjs              course/car calibration run
_server/scripts/make-cert.ps1         self-signed cert for the opt-in TLS listener
_server/scripts/https-smoke.mjs       edge-header smoke (47/47 / 35/35 LAN)
_server/public/music/                 tracks + generated manifest
_server/scripts/build-music-manifest.mjs
docs/                                 Zudoku field manual
docs/pages/play/performance.mdx       measured fps/latency/transport + limits
docs/pages/multiplayer/r4-2p.mdx       2P page (must match this file)
docs/pages/multiplayer/shared-car.mdx  Rage/Ridge shared-car page
_runtime/mp-lobby-ui*                 lounge UI evidence + screenshots
_runtime/mp-lobby-ws.json             raw /mp evidence
_runtime/mp-games.json                multi-disc /mp + manifest evidence (16/16)
_runtime/mp-games-ui.json             multi-disc lounge UI evidence (32/32)
_runtime/mp-games-*.png               disc-selector/shared-car screenshots
_runtime/mp-macro-evidence.json       macro stages (host-only, 6/6)
_runtime/mp-race-e2e.json             two-browser race evidence (40/40)
_runtime/mp-race-e2e-*.png            race/grid screenshots (host + guest)
_runtime/mp-ghost-replay.json         ghost engine evidence (40/40, Route A)
_runtime/mp-ghost-*.png               ghost replay screenshots (Ridge + Rage)
_runtime/mp-live-ghost.json           live ghost evidence (36/36, Route B)
_runtime/mp-live-ghost-*.png          live ghost on/off pair (Rage GP, Ridge) + A replay
_runtime/mp-ghost-lobby.json          ghost lounge/rematch evidence (36/36)
_runtime/mp-ghost-lobby-*.png         DRIVE/TURN, overlay, mobile, rematch captures
_runtime/ghost-research/              Route A design + tape/Rage finish probes (REA)
_runtime/mmo-protocol.json            /mmo protocol evidence (12/12)
_runtime/mmo-load*.json               550-socket load evidence (synthetic clients)
_runtime/mmo-e2e.json                 two-browser Race Day evidence (41/41)
_runtime/mmo-shots.json               Race Day capture manifest (24/24)
_runtime/mmo-shot-*.png               Race Day screenshots (desktop + mobile)
_runtime/calib/                       course/car calibration screenshots
_runtime/r4-seeds.txt                 PSXRecomp seed list
analysis/*.json                       REA evidence
```

Root docs and their owners in a parallel session: `README.md`, `START-HERE.md`,
`AGENTS.md`, `HANDOFF.md`, `HANDOFF-PROMPT.md` (root docs owner); `docs/**` and
`_server/README.md` (docs owner); `_server/NETPLAY-*.md` (netplay docs owner).
Assign disjoint files before editing.

---

## 7. Copy-paste handoff prompt for a fresh session

```text
You are picking up the Ridge Racer Type 4 cabinet at <repo> on Windows.

Read first, in this order:
1. <repo>\AGENTS.md
2. <repo>\HANDOFF.md
3. <repo>\README.md and START-HERE.md
4. <repo>\docs\README.md

Server state: :8080 cabinet + :3010 relay should be running. :8080 was restarted on 2026-11-06
and serves the /mp heartbeat build. Verify:
  / /welcome /games /multiplayer /race-day /play /play-net /lobby /docs/introduction /api/music
  /api/mmo/status; /docs/games /docs/play /docs/multiplayer (each 301s to its first docs page)
Do not kill processes another session is using without checking.

Current UX:
- / always shows ENTER; refresh always returns to ENTER. Parent owns the only audio element.
- ENTER starts the R4 intro ("You The One For Me") and opens /welcome (WELCOME TO RIDGE CITY).
- Shell top bar is the only top bar; it injects CSS into /play* iframes that hides #play-bar/#play-foot.
- Hub -> GAMES (/games) / 2P LOUNGE (/multiplayer) / PLAY / DOCS (/docs) / LOBBY (/lobby).
- /multiplayer: 4-char room code, DISC selector (r4/rage/ridge from /mp-games.json), four teams,
  both READY -> server rolls from that disc's manifest and sends both browsers the same
  /play-net?embedded=1&threads=0&mpRole=..&mpRoom=..&mpRace=..&mpTrackIndex=..&mpCarHost=..&mpCarGuest=..&game=..
  R4 = 2 cars / VS Battle / automatic macro. Rage + Ridge = 1 shared car, manual host start, no macro.
  Rage/Ridge rooms also offer DRIVE LIVE|GHOST: GHOST is turn-based (host-only
  TURN HOST|GUEST, handoff +mpGhost=ghost&mpTurn=..&mpLiveGhost=1); the finished run is
  drawn on track (Ridge race screen + Rage Grand Prix) and replayed full screen on the
  other seat as `ghost replay (sequential)`; a rematch flips the turn. Rage TA is replay-only.

Evidence already banked (do not redo blindly):
- 16/16 multi-disc /mp + manifest (per-disc rolls, host-only setgame, guest adoption):
  node mp-games-probe.mjs -> _runtime/mp-games.json
- 32/32 multi-disc lounge UI (RAGE/RIDGE handoff game=, shared-car overlay, R4 regression):
  node test-mp-games-ui.mjs -> _runtime/mp-games-ui.json + _runtime/mp-games-*.png
- 33/33 two-browser lounge UI + handoff: node test-mp-lobby-ui.mjs -> _runtime/mp-lobby-ui.json
- 22/22 raw /mp WS (incl. app-level pong + server heartbeat ping on the restarted :8080):
  node mp-ws-probe.mjs -> _runtime/mp-lobby-ws.json
- 6/6 host-only VS Battle macro, reaches race:live, final frame is the race on a real disc:
  node mp-macro-test.mjs -> _runtime/mp-macro-evidence.json + _runtime/mp-macro-final.png
- 40/40 harness-verified two-browser race, guest drives P2 (two contexts on one host):
  node test-mp-race-e2e.mjs -> _runtime/mp-race-e2e.json + _runtime/mp-race-e2e-*.png
- 40/40 ghost replay engine (Ridge 161-record tape swap + Rage scene-12 arm -> 17, turn gate,
  IndexedDB; host-only, synthetic tapes) and 36/36 ghost lounge (DRIVE/TURN, mpGhost/mpTurn
  handoff, rematch turn flip): node test-mp-ghost-replay.mjs, node test-mp-ghost-lobby.mjs
  -> _runtime/mp-ghost-replay.json, _runtime/mp-ghost-lobby.json + mp-ghost-*.png
- 36/36 live ghost (Route B): RAM stub + one repointed word, ghost slot pose == tape 16/16 on
  Ridge's race screen and Rage GP, A/B delta vs noise floor, turn gate unchanged, flag matrix;
  node test-mp-live-ghost.mjs -> _runtime/mp-live-ghost.json + mp-live-ghost-*.png
- 12/12 /mmo protocol, 41/41 Race Day two-browser, 24/24 captures; 550 synthetic sockets
  load-probed (not 550 humans): node mmo-protocol-test.mjs, node test-mmo-ui.mjs,
  node mmo-shots.mjs, node mmo-load-probe.mjs --drivers 550 -> _runtime/mmo-*.json

Remaining P0:
1. Two physical machines: repeat the 40/40 two-browser race with one wired and one Wi-Fi client on
   the real router. The two-context run is on one host. Guest audio is measured ABSENT (video-only
   stream: the 4.3 host has no capturable OpenAL context), so "verify guest audio" is a fix item,
   not a listen item.
2. Docs: rebuild after page changes (cd docs; npm run build; npm run verify) and re-check the routes
   + one <h1> per page.
3. Restart :8080 after any future /mp edit; run mp-ws-probe.mjs to confirm pong + server ping.
   The :8080 process checked on 2026-11-06 predates the multi-disc /mp (a create with game=rage
   answers a room without game/mode), so restart it before manual DISC-selector testing.
4. Rage/Ridge shared car is verified only in the lobby (16/16 + 32/32). No harness has driven a live
   shared-car race: label stays `netplay transport; in-game mode unverified`, and no Rage/Ridge menu
   or lap address is claimed.
5. Ghost has both doors: Route A (post-race native replay) is 40/40 engine + 36/36 lounge; Route B
   (live ghost) is 36/36 and covers **Ridge's race screen + Rage Grand Prix only** — Rage **Time
   Attack** is replay-only (`draw-path-unverified`). The ghost is DRAWN, not simulated (no collision,
   no AI); synthetic harness tapes, no human lap. Next useful step: capture one real human Ridge/Rage
   lap through the product, then re-run the live-ghost harness with it. Never write "ghost car" for
   Rage TA, and never claim collision or "two cars on track".

Known evidence/RE data:
- Host reads R4 menu selection byte 0x800AC801 (labels 0x800A2180) before pressing buttons:
  Down x2 -> VS BATTLE -> car P1 (Right x carHost) -> car data -> AT/MT -> AT ->
  car P2 (player index 1, Right x carGuest) -> course (Right x trackIndex) -> Circle.
- Car presses are paced against the pad-ack byte 0x800ABD9F: retry Right until exactly carIndex
  steps land. The course list does not update that byte, so course presses use exact fixed
  pacing. Stage records keep presses/delta. race-live goes out 20 s after the course confirm.
- EJS buttons: Cross 0, Circle 8, Select 2, Start 3, Up 4, Down 5, Left 6, Right 7.
- Guest input is gated in the R4 lounge handoff: gameManager.simulateInput drops input until the host
  sends race-live. A manual `/play-net` join (no mpRole/mpRoom) is not gated; the guest chip shows
  `P2 LOCKED` / `P2 LIVE`. In shared-car mode (Rage/Ridge) the guest is live from boot, the host
  remaps its pad to core player 0 via functions.simulateInput, and the chip reads `GUEST P2 SHARED`.
- Native --debug-port is compiled out; recomp-net is stubbed; native keybinds.ini P2 == P1 and
  p2_device="none".

Known bugs: docs #418 hydration warning (expected noise, not a failure). The
soundtrack ducks to 22 % during a `/play*` view (`enter.js:72`, shell-fs A13/B14),
so "no audio ducking" is stale.
Shell fullscreen and the embedded-docs second bar were fixed 2026-11-05 and are
covered by `_server/test-shell-fs.mjs`.

Rules:
- Update AGENTS.md/README/START-HERE/docs in the same change.
- cd docs && npm run build after docs changes; verify /docs routes and the DOCS link.
- Never persist ENTER; refresh must always show the gate.
- Keep one top bar and the parent-owned audio; no second audio element in the iframe.
- Do not claim 0 console errors ("No ICE servers configured" + React #418 are expected; COOP is only sent on
  loopback/HTTPS, so plain-HTTP LAN has no COOP warning).
- Report exact files changed and test evidence, with scoped labels (6/6 host-only != 40/40 two-browser).

Start by verifying the live routes, then run the 2P harnesses (lobby UI, /mp, macro, e2e race)
before adding more design.
```
