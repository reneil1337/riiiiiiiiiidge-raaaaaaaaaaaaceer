# AGENTS.md — full-stack working contract

This repository is a runnable LAN arcade, a native recompilation workspace, and a
documentation site. **Documentation is part of the definition of done.** A change
is not finished until the relevant docs, commands and screenshots are updated.

## The golden rule

> If you change behaviour, change the docs in the same change.

That means:

1. Update the canonical file for the area (§2).
2. Update the user-facing summary if the change affects how people start or play.
3. Rebuild and verify the docs site (`npm run build && npm run verify`).
4. Run the command you documented.

## 1. Read first

1. `AGENTS.md` — this file (the contract)
2. `HANDOFF.md` — current state, exact commands, known gaps
3. `README.md`, `START-HERE.md` — user-facing entry
4. `docs/README.md` — the manual's own build/verify rules
5. `REA-ANALYSIS.md`, `docs/pages/engineering/rea.mdx` — RE evidence

## 2. Canonical docs per area

| Area | Canonical doc(s) |
| --- | --- |
| Project overview / quick start | `README.md`, `START-HERE.md` |
| Cabinet shell (`/`, `/welcome`, `/games`) | `README.md`, `docs/pages/play/music.mdx`, `_server/README.md` |
| Browser arcade (`/play`) | `_server/README.md`, `docs/pages/play/browser.mdx`, `_server/PLAY-QA.md` |
| Performance + networking numbers | `docs/pages/play/performance.mdx`, `_server/EJS-PERFORMANCE.md`, `_server/NETPLAY-INTEGRATION.md` |
| 2P lounge + race handoff | `docs/pages/multiplayer/lounge.mdx`, `docs/pages/multiplayer/r4-2p.mdx`, `_server/README.md`, `README.md` |
| Shared car (Rage/Ridge 2P) | `docs/pages/multiplayer/shared-car.mdx`, `_server/public/mp-games.json` |
| Ghost (Rage/Ridge) | `docs/pages/multiplayer/ghost-run.mdx`, `_runtime/ghost-research/*` |
| Race Day MMO (`/race-day`, `WS /mmo`) | `docs/pages/multiplayer/race-day.mdx`, `_server/src/mmo.js`, `_server/README.md`, `README.md` |
| LAN / netplay transport | `_server/NETPLAY-INTEGRATION.md`, `_server/NETPLAY-REPORT.md`, `docs/pages/multiplayer/lan.mdx` |
| Host-stream fallback (`/lobby`) | `_server/README.md`, `docs/pages/play/host-stream.mdx` |
| Native Windows recomp | `NATIVE-RECOMP-SETUP.md`, `docs/pages/play/native-recomp.mdx`, `RidgeRacer4Recomp/game.toml` |
| Architecture | `docs/pages/engineering/architecture.mdx`, `_server/README.md` |
| Controls / pads / keyboard | `docs/pages/reference/controls.mdx`, `RidgeRacer4Recomp/input.ini`, `RidgeRacer4Recomp/keybinds.ini`, `_server/src/input.js` |
| Troubleshooting | `docs/pages/reference/troubleshooting.mdx`, `_server/README.md` |
| Music / audio | `_server/public/music/`, `docs/pages/play/music.mdx`, `_server/README.md` |
| Docs site itself | `docs/README.md`, `docs/zudoku.config.tsx`, `docs/styles.css`, `docs/scripts/verify.mjs` |
| Evidence / test matrix | this file §10, `HANDOFF.md` |
| REA evidence | `REA-ANALYSIS.md`, `analysis/*`, `docs/pages/engineering/rea.mdx` |
| Legal / credits | `docs/pages/reference/legal.mdx`, `README.md` |
| Session handoff | `HANDOFF.md`, `HANDOFF-PROMPT.md` |

A new doc page also needs a `docs/zudoku.config.tsx` navigation entry and a verify
URL in `docs/README.md`. A new route needs a test/verification step.

## 3. Stack at a glance

| Component | Entry point | Origin / port | Notes |
| --- | --- | --- | --- |
| Cabinet server | `_server/src/server.js` | `:8080` (`RR4_PORT` overrides) | Express + `ws`; serves everything below except the relay |
| EmulatorJS 4.2.3 | `_server/public/emulator/data/` | `:8080` | Single-player `/play` only |
| EmulatorJS 4.3.0-pre | `_server/public/emulator43/data/` | `:8080` | Netplay `/play-net`; pinned nightly |
| Netplay relay | `_server/netplay/server.js` | `:3010` (`PORT`) | Socket.IO + `/health` + `/list`; separate process |
| Docs site | `docs/` (Zudoku 0.93.2) | `:8080/docs` | Builds to `docs/dist/docs` |
| HTTPS listener (opt-in) | `RR4_TLS=1` in `_server/src/server.js` | `:8443` (`RR4_TLS_PORT`) | Second `node:https` listener beside `:8080`; cert from `_server/scripts/make-cert.ps1`. Missing cert logs once and leaves HTTP running |
| Music | `_server/public/music/` + manifest | `:8080/music`, `/api/music` | 57 extracted tracks (29 R4, 16 Rage, 12 Ridge) |
| Native recomp | `RidgeRacer4Recomp/`, `Play Ridge Racer 4.bat` | desktop | PSXRecomp x64, OpenBIOS |
| Host-stream lobby | `/lobby` + `/ws` + `/stream` | `:8080` | Native window → ffmpeg → jsmpeg fallback |
| Race Day event server | `_server/src/mmo.js` (mounted by `src/server.js`) | `:8080/mmo`, `/api/mmo/status` | `ws` `/mmo` room: seats, event clock, telemetry-derived standings, LFG; in-memory only |

### Routes and sockets

| Path | What it is |
| --- | --- |
| `/` | R4 cabinet **ENTER** shell (parent audio + iframe) |
| `/welcome` | WELCOME TO RIDGE CITY hub |
| `/games` | Machine check for the three discs |
| `/multiplayer` | 2P LOUNGE (room, DISC selector, DRIVE `LIVE`/`GHOST` + TURN `HOST`/`GUEST`, teams, READY, race plan) for `r4`/`rage`/`ridge` |
| `/race-day` | Race Day (50-seat mass start): grid, LFG, standings, results. `?party=CODE` invite, `?spectate=1`, `?bots=1` |
| `/play` | Browser disc deck + game (EmulatorJS 4.2.3); `?mmo=1&event&seat&team` adds the Race Day HUD |
| `/play-net` | Netplay page (EmulatorJS 4.3.0-pre); `mpGhost=ghost` + `mpTurn=host`/`guest` add the Rage/Ridge ghost replay engine |
| `/lobby` | Old lobby + native host-stream fallback |
| `/music`, `/api/music` | Soundtrack player + generated manifest |
| `/api/health`, `/api/status`, `/api/ghosts` | Health, stream state, LAN ghost list/upload |
| `/mp-games.json` | Static disc manifest — the single source of truth for the lounge: keys `r4`/`rage`/`ridge`, ids 4/5/6, room prefixes `R4`/`RAGE`/`RIDGE`, `mode` (`versus`/`shared-car`), `macro` (`auto`/`manual`), track/car arrays (8/8, 4/4, 1/4). Served `no-cache`, read from disk by `src/server.js` |
| `GET /api/mmo/status` | Race Day snapshot: `ok`, `event` (`id`, `index`, `state`, `plan{trackIndex,trackName,carClass,laps}`, `bots`), `counts{seated,queued,max,connected,bots}`, `uptimeSec`, `clients`, `p50BroadcastMs`, `max`, `min`, `path` |
| `GET /api/netplay-config` | Relay URL/port derived from the request origin (`relayUrl`, `relayPort`, `secure`, `protocol`, `sameOrigin`, `socketPath`, `gameIds`). The relay fold-in is **not** done: `play-net.js` still hardcodes `:3010` |
| `/qr.svg`, `/rom/*`, `/bios/*`, `/ghosts/*` | QR, disc images (Range), BIOS, ghost clips |
| `/docs/*` | Built Zudoku manual (`/docs` 301s to `/docs/introduction`) |
| WS `/mp` | 2P lounge transport (rooms, `create {game, drive, turn}`, host-only `setgame`/`drive`/`turn`, READY, per-disc race plan, ping/pong) |
| WS `/mmo` | Race Day transport: `hello`/`queue`/`party:*`/`seat`/`telemetry`/`finish`/`start`/`spectate`/`chat`/`config`/ping; server sends `welcome`/`event`/`grid`/`queue`/`countdown`/`standings`/`result`/`party`/`feed`/`error`/`pong` |
| WS `/ws`, `/stream` | Native lobby seats + jsmpeg stream |

### Discs and data

| File | Bytes | Identity / notes |
| --- | --- | --- |
| `disc/r4.chd` | 357,817,282 | Ridge Racer Type 4 USA, `SLUS-00797`; 2P title |
| `disc/rage-racer.chd` | 495,297,808 | Rage Racer USA, `SLUS-00403`; 4 courses, 17 CD tracks |
| `disc/ridge-racer.chd` | 309,882,296 | Ridge Racer 1994 USA, `SCUS-94300`; 1 course, 14 CD tracks |
| `disc/R4 - Ridge Racer Type 4 (USA).bin` | 621,421,920 | Raw fallback; sha1/md5 in `_server/game/game.toml` |
| `_server/game/bios/openbios.bin` | ~0.5 MB | Bundled OpenBIOS; HLE fallback available |

`_server/game/game.toml` is the native config (serial, entry, seeds, disc hashes,
`bios_hle`, netplay `require_cue`). Do not commit BIOS dumps or disc images.

## 4. Shell contract (`/`)

- The shell always starts at **ENTER**. Never persist “already entered” in
  `sessionStorage`/`localStorage`; refresh must return to the gate.
- The parent document owns the **only** `HTMLAudioElement`. Every view loads in
  its iframe so the soundtrack survives navigation. No view may create a second
  audio element (`music-player.js` skips itself in an iframe).
- ENTER is the audio gesture: it starts the R4 intro ("You The One For Me") even
  when another game is selected, then hands over to that game's playlist.
- First view after ENTER is `/welcome`. Hub: GAMES `/games`, 2P LOUNGE
  `/multiplayer`, PLAY, DOCS `/docs/introduction`, LOBBY `/lobby`. No disc starts
  until the user chooses START or CHECK DISC DECK.
- **One top bar.** The shell injects CSS into `/play*` iframes that hides
  `#play-bar`/`#play-foot` and gives the stage the space back. Embedded `/docs`
  loads with `?embedded=1` and hides the manual's own sticky header
  (`#rr4-shell-docs`).
- Embedded `/play` and `/play-net` must **not** show a second “CLICK TO RACE”
  gate: the parent ENTER already granted audio; the next click unlocks the core.
- `F` works on the shell chrome **and inside the iframe** (the shell mirrors the
  key). Fullscreen targets `document.documentElement` so the bar leaves the grid
  and the stage fills the viewport; `Esc`/the exit control leave.
- The soundtrack **ducks to ~22 %** while a `/play*` view is active and restores
  the slider level afterwards (`window.RR4Shell.getState()` exposes `ducked` and
  `effectiveVolume`).
- Theme and playlist switch together with the GAME selector (`r4`/`rage`/`ridge`)
  in both the shell chrome and the iframe.
- App HTML is `no-cache`; app scripts/styles are `no-cache` + ETag. EmulatorJS
  assets keep their long-lived policy. `?v=` queries are belt-and-braces.
- **Strong ETags** (`"sizehex-mtimehex"`, not `W/`) on every static mount, so
  `If-Range` + `Range` returns **206** instead of re-sending the whole CHD and
  `If-None-Match` returns **304**. `compression` serves brotli/gzip for text
  assets only (`emulator.min.js` 426,343 → 106,924 B br) and skips `/rom`,
  `/bios`, `/music`, `/ghosts` and any `Range` request. `keepAliveTimeout` is
  65 s.
- **COOP/COEP** (`same-origin` / `credentialless`) are sent for the document
  whitelist `/`, `/welcome`, `/games`, `/multiplayer`, `/lobby`, `/play*`,
  `/docs/*`, `/music` — and only on a loopback host or HTTPS. A plain-HTTP LAN
  origin therefore sends **no** COOP/COEP and logs **no** COOP warning; loopback
  and the opt-in `RR4_TLS=1` listener isolate the shell and its embedded
  `/play`, so threads and `navigator.storage.persist()` are available there.

## 5. Browser play paths

### 5.1 `/play` — single player (EmulatorJS 4.2.3)

- `/play` opens the disc deck; `?game=r4|rage|ridge` boots that disc directly,
  `&setup=1` opens the deck preselected, `&embedded=1&threads=0` is the shell path.
- Disc is served from `/rom` with Range + immutable cache; the page sets
  `EJS_CacheLimit = 1 GiB` (IndexedDB) so a reload is fast. Warm reuse reads the
  disc body from IndexedDB and revalidates with one `GET` + `Range: bytes=0-0`
  probe (not a `HEAD`). A hard reload or a private window re-downloads
  ~341–472 MB.
- BIOS: bundled OpenBIOS; `?bios=hle` forces HLE; a retail dump may be referenced
  with `?bios=/bios/<file>`. Never commit it.
- `F`/header button = fullscreen; FILTER defaults to DLSS 5 (a CSS grade applied
  to `#game` only, not NVIDIA DLSS); save states live in the browser; LAN ghosts
  via **REC GHOST** and **LAN GHOSTS** (`/api/ghosts`, `/ghosts/`).
- **QUALITY presets**: `?quality=authentic|balanced|perf|auto`, persisted as
  `localStorage['rr4.play.quality']`, selectable in SETTINGS and the footer.
  AUTHENTIC = the old look; BALANCED = grade on `#game`, `preserveDrawingBuffer`
  off, fullscreen cap 1280×960, `pcsx_rearmed_icache_emulation=disabled`;
  PERF = grade off + `icache_emulation=disabled` + `frameskip_type=auto_threshold`
  / `threshold=33`; AUTO samples ~120 rAF intervals and drops at most two tiers
  (8 s cooldown) and shows the chosen tier. `?pb=1|0` forces
  `preserveDrawingBuffer` either way. Volume defaults to 0.70 and the first
  `keydown`/gamepad button unlocks audio, not only pointer/click.
- Fullscreen canvas backing store is capped at `min(100vw, 1280px, 100vh*4/3)`:
  1920×1080 fullscreen → 1280×960 for the 640×480 core. Windowed stays 960×720.
- `navigator.storage.persist()` is requested once after boot on secure contexts;
  on plain-HTTP LAN it is a guarded no-op.
- Boot from `?game=` must not leave `setup=1` behind, or a reload reopens the deck.

### 5.2 `/play-net` — netplay page (EmulatorJS 4.3.0-pre)

- Host-authoritative: the host runs the PSX core and streams canvas + audio over
  WebRTC; the guest renders the stream and sends pad/keyboard input as **P2**.
  In `shared-car` mode (Rage/Ridge) the host remaps that pad onto its own player
  `0`, so both pads drive one car.
- Same numeric `EJS_gameID` on both sides is the hard rule (R4 = 4, Rage = 5,
  Ridge = 6). Same LAN origin is recommended; `/list` filters by game id only.
- The relay is a separate process on `:3010`; no TURN on one subnet. The relay
  fold-in is not done: `play-net.js` still builds `http://<hostname>:3010`, so an
  HTTPS page needs the relay on `:3010` too (`/api/netplay-config` only reports
  the derived URL).
- **Capture is 60 fps**: `canvas.captureStream(0)` + `track.requestFrame()` per
  core frame, 8 Mbps / 60 fps ceiling, keyframe forced on `race-live`, on join
  and on a freeze. `?capture=30` restores the bundle's 30 fps track.
- Guest pad input is sent **once**: the Socket.IO `sync-control` duplicate is
  suppressed while the WebRTC data channel is open (`?dedup=0` restores it); the
  relay copy is the fallback when the channel is not open.
- Guest **QUALITY** selector AUTO/LOW/MED/HIGH (1.5 Mbps/30, 4/60, 8/60), sent to
  the host as `{type:'rr4-quality'}`. A 2 s `getStats()` line (fps, encoded/
  decoded, quality limitation, jitter, loss, RTT, bitrate) goes to the stage log
  and `window.__R4NET.stats`.
- **Guest audio is absent, not unverified**: the 4.3 host captures from
  `Module.AL.currentCtx`, which is `null` under RWebAudio, so the track list is
  `["video:live"]` (`No audio tracks captured - guests will have no audio`).
  Guest *presented* fps is 42–55 (the pinned loop duplicates); decoded is 57.
- Escape hatches: `?capture=30 ?pin=1 ?keyframe=0 ?dedup=0 ?stats=0 ?quality=
  ?desync=1 ?draw= ?video=attached`.
- The netplay panel is the manual path: host CREATE ROOM, guest JOIN, then the
  host opens R4's 2P mode by hand. The P2 seat is `simulateInput(1, …)`.
- **Ghost replay (Rage/Ridge)** rides the same page: with
  `mpGhost=ghost&mpTurn=host|guest` the host runs a turn-based Time Trial and
  replays the peer's native tape after the run. The full contract (lounge
  selectors, `/mp` messages, tape addresses, turn gate, labels, limits) is in
  §5.3.

### 5.3 `/multiplayer` — 2P lounge contract (r4 / rage / ridge)

- The lounge is the **only** place that creates a race plan, and
  `_server/public/mp-games.json` (served at `/mp-games.json`, read from disk by
  `src/server.js`) is the **single source of truth** for the disc list: keys
  `r4`/`rage`/`ridge`, numeric ids 4/5/6, room prefixes `R4`/`RAGE`/`RIDGE`,
  `mode` (`versus`/`shared-car`), `macro` (`auto`/`manual`), `guestPlayerIndex`,
  `trackSelect` and the track/car arrays (r4 8/8, rage 4/4, ridge 1/4). Do not
  duplicate that list in another file, and do not roll a plan client-side too.
- **DISC selector.** The start card has a DISC selector, default `r4`;
  `?game=rage|ridge` preselects it and the choice persists in
  `localStorage['rr4.mp.game']`. `create` sends
  `{type:'create', name, code, game}`.
- **Host-only `setgame`.** Only the host may change the disc before the grid
  locks: `{type:'setgame', game}` with a whitelisted key and `!room.started`. A
  guest `setgame` and any `setgame` after the lock get an `error`. A change drops
  the old `track`/`cars` (`null`) instead of re-announcing a stale plan.
- **Guest adoption.** `join` sends the code only; the room's disc wins and the
  guest's own `game` is ignored. Room state carries
  `game`/`mode`/`modeLabel`/`trackSelection`, room-list entries carry
  `game`/`mode`, so both seats always show the disc the host created.
- **One plan, both sockets (both READY).**
  `trackIndex = abs(seed + code.charCodeAt(0)) % tracks.length`,
  `carIndex = abs((seed >> (i*3)) + i) % cars.length`. R4 rolls one of the eight
  R4 courses **in in-game menu order** (Helter Skelter, Wonderhill, Edge of the
  Earth, Out of Blue, Phantomile, Brightest Nite, Heaven and Hell, Shooting
  Hoops) and one preset car per driver (`D1–D4`, `G1–G4`). Rage Racer rolls its
  4 courses (Mythical Coast, Over Pass City, Lakeside Gate, The Extreme Oval) and
  `CAR 1–4`; Ridge Racer 1994 rolls its single course (Seaside Route 765) and
  the four cars `Solvalou`/`Mappy`/`Bosconian`/`Nebulasray`. The `race` payload
  adds `game`, `mode`, `guestPlayerIndex`, `trackSelection`, `trackCount` and
  `carCount` next to `code`/`raceId`/`track`/`trackIndex`/`cars`.
- Launch is gated on **both READY**; nothing boots before that.
- Handoff (keep these names; `play-net.js` parses exactly these):

  ```text
  /play-net?embedded=1&threads=0&mpRole=host|guest&mpRoom=<code>
            &mpRace=<raceId>&mpTrackIndex=<0..trackCount-1>
            &mpCarHost=<0..carCount-1>&mpCarGuest=<0..carCount-1>
            &game=r4|rage|ridge[&mpGhost=ghost&mpTurn=host|guest&mpLiveGhost=1|0]
  ```

  `mpTrackIndex` is 0–7 for r4, 0–3 for rage and always 0 for ridge; `mpCar*`
  is 0–7 for r4 and 0–3 for rage/ridge. `mpTurn` only travels in ghost rooms, and
  `mpGhost` is `ghost` only there: the shell's handoff always emits
  `mpGhost` (`live` for a live or R4 room), while the standalone `/multiplayer`
  page omits it outside a shared-car room. `mpLiveGhost=1` (Route B) is appended
  by the shell **and** the standalone lounge for every `drive: ghost` room — it is
  the product default; `mpLiveGhost=0`/absent opts out and leaves Route A
  byte-identical. `play-net.js` treats absent and `live` identically, so R4's VS
  Battle path is unaffected. Standalone `/multiplayer`
  must carry the same `mpTrackIndex`/`mpCar*`/`game`; it does since 2026-11-05/06,
  so `/play-net` never rerolls an announced plan. Invite links
  (`/multiplayer?room=<code>&game=<key>[&drive=&turn=]`) and the rematch reload
  carry `&game=` too, and a rematch keeps the disc.
- **Room prefix comes from the manifest**, not a hardcoded `R4-`:
  `R4-<code>`, `RAGE-<code>`, `RIDGE-<code>`. Host: auto-host that room with
  password `raceId`, retry, visible stage log. Guest: retry `/list` until that
  exact room exists, then join.
- **R4 keeps the automatic macro** (`macro: auto`, `macroVerified: true`): verify
  the main-menu selection byte `0x800AC801` (labels at `0x800A2180`) before
  pressing anything; then Down ×2 → VS BATTLE → car P1 (`Right` × `mpCarHost`) →
  car data → AT/MT → AT → car P2 (player index 1, `Right` × `mpCarGuest`) →
  course (`Right` × `mpTrackIndex`) → Circle. The course list wraps at 8. Car
  presses are paced against the pad-ack byte `0x800ABD9F` (retry `Right` until
  exactly `carIndex` steps land); the course list does not update that byte, so
  course presses use exact fixed pacing. Stage records keep `presses`/`delta`.
  The guest core is frozen and `gameManager.simulateInput` drops input until the
  host sends `race-live`. A manual `/play-net` join (no `mpRole`/`mpRoom`) is
  intentionally **not** gated, because no macro runs.
- **Rage Racer and Ridge Racer 1994 are `macro: manual`, one shared car.** The
  host starts a normal **single-player** race by hand; no R4 macro runs and
  `window.__R4NET.mpRun()` stays a no-op. The host wraps
  `gameManager.functions.simulateInput` (the cwrap function the netplay client
  applies remote input through, **not** `gameManager.simulateInput`) so guest
  player `1` becomes `guestPlayerIndex` `0` — both pads drive the host's car
  (`window.__R4MP.coopRemap`/`.remappedInputs` expose it). The guest is live from
  boot in shared-car mode (no `race-live` gate), the panel stage reads `MANUAL`
  and the chip shows `GUEST P2 SHARED` until the guest joins, then
  `GUEST P2 LIVE` (R4 keeps `P2 LOCKED`/`GUEST P2 LOCKED` until `race-live`).
  There is no split screen, no second car and no automatic menu walk on these
  discs; the brand says `2P SHARED` (R4 stays `2P VS`).
- **GHOST mode is turn-based on the host core (Rage/Ridge only).**
  Room fields `drive`: `live` | `ghost` (default `live`) and `turn`:
  `host` | `guest` (default `host`, only meaningful in ghost). The lounge start
  card has a `DRIVE LIVE|GHOST` segmented control, enabled only for
  `rage`/`ridge` (disabled with the hint `RAGE + RIDGE ONLY` on r4) and
  persisted as `localStorage['rr4.mp.drive']`; the ghost hint is
  `GHOST · TURN-BASED TIME TRIAL - THE RUN YOU FINISH BECOMES THE OTHER'S GHOST`.
  In a ghost room the card reads `DRIVE GHOST // TURN-BASED TIME TRIAL` and adds
  a **host-only** `TURN HOST|GUEST` selector (this run's driver) before the grid
  locks; the guest selector is read-only and the rooms list shows a `GHOST`
  badge. The overlay reads `DRIVER: HOST` / `DRIVER: GUEST` with one
  `SHARED // <car> · DRIVER: …` line; `live` keeps
  `SHARED CAR // BOTH PADS DRIVE`. Invite links carry `&drive=` (and `&turn=`
  in ghost). R4 keeps `drive: live` and hides both rows.
  Two ghost doors ship: **A** = the post-race native replay
  (`ghost replay (sequential)`); **B** = a live ghost drawn on track
  (`ghost rendered (in-game)`) on **Ridge's race screen** and **Rage Grand Prix**
  only — Rage **Time Attack** has no draw path for the rival slots and stays
  replay-only (`draw-path-unverified`).
- **`/mp` ghost messages.** `create {name, code, game, drive?, turn?}` (both
  whitelisted); host-only `{type:'drive', drive}` and `{type:'turn', turn}`
  before `started` — a guest or late frame gets an `error`. Room state carries
  `drive`/`turn`, room-list entries carry `drive` only, and the `race` payload
  adds `drive`/`turn` next to the existing fields. The server never flips the
  turn; the game page flips it on rematch and passes it back through the lounge
  URL.
- **Ghost engine** (`public/js/play-net.js`, `window.__R4GHOST`) runs only for
  `game=rage|ridge`, `mpGhost=ghost` and a lounge `mpRole`. It finds the PSX
  2 MiB window by scanning `Module.HEAPU8` for the loaded exe text at
  `0x80010000` (one signature hit; `ramBase = hit - 0x80000000`, cached per
  page), exposes `rd8/16/32` / `wr8/16/32` plus `captureNow()`/`replayNow()`,
  `state`, `peer`, `tape`, `lastError`, and stores tapes in IndexedDB
  `rr4-ghost` → `runs`, key `${room}:${game}`, one record per seat
  (`host`/`guest`, newest wins), in-memory fallback, cap 43,200 B. Route A's
  render is a **post-race replay of the peer's native tape**.
- **Route B — live ghost** (`window.__R4NET.live`, `mpLiveGhost=1`, default in a
  ghost room): the same tape is also applied to a **spare rival car slot every
  frame** while the race runs, so the game's own renderer draws a second car.
  Runtime RAM injection only — one 4-byte shipped word repointed at a stub written
  after boot, restored after the run; no disc patch. The stub is installed at
  boot but the **hook word is only applied inside the race** and restored outside
  (a boot-time patch stalls Rage's scene-32 prologue).
  **Ridge Racer 1994:** hook `0x80015014` `0x0C0092E3` → `0x0C07A984`, stub
  `0x801EA610` (208 B / 52 words) in a runtime-verified quiet BSS band, slot 11
  `0x801EDA10` (array base `0x801ECE34`; the old `0x801FDA10` was `0x10000` high),
  tape `0x801E4840` (600 × 40 B), applier `0x8002A894` with `0x80080434` saved and
  restored per apply, count gate `0x801EB020`. **Rage Racer Grand Prix:** hook
  `0x8003875C` `0x27BDFFD8` → `0x0807D1C0`, stub `0x801F4700` (324 B / 81 words),
  slot `g_Cars[10]` `0x801F4194`, tape in the second buffer `0x801F4850` inside
  the 43,008 B free span, pointers `0x8009EDAC`/`0x8019C4AC` swapped per apply, and
  the recorder `0x80036F4C` **kept** so A still captures the same run. Panel
  statuses `GHOST // LIVE (RIDGE)` / `(RAGE GP)`, else `GHOST // REPLAY (…)`;
  `draw-path-unverified` = Rage Time Attack (no rival-slot draw path) and falls
  back to A. The ghost is **drawn, not simulated**: no collision, no shadow, no
  AI, no second physics car.
- **Ridge Racer 1994:** screen id `0x801D6D28` (7 results, 8 replay setup,
  9 playback), frame counter `0x80176AE4`, count `0x801EB020`, recorder idle
  `0x801D6D18`, 40-byte records. Capture on screen 7 clamped to **161 records**
  (the applier cap before the screen dispatch table `0x8006E7BC`), stage the peer
  tape in a zeroed BSS run and repoint the applier pointer `0x80080434` at it —
  writes at the documented fixed base `0x8006CE7C` do not reach the applier.
  Swap on screen 7 before the results wait ends, never during 8/9, and never
  rewrite the count. `WATCH RIVAL` arms 8 → 9 from the results screen.
- **Rage Racer:** scene id `0x801E3FEC`, scene timer `0x801E3DC0`, tape base
  `0x801E8804`, count `0x8019C874`, write `0x801E48B8`, read `0x801F30C4`,
  wrapped `0x8009E994`, mode `0x801E4AB4` (1 GP / 0 TA), stride 48 GP / 28 TA.
  Capture at the first scene-17 tick (scenes 15/16 are only a fallback), clamp to
  900 GP / 1542 TA samples and `floor(43200/stride)`; swap at 16/17 only for a
  same-`mode` peer (otherwise `GHOST // MODE MISMATCH`), re-seeding `count`,
  `write = N + 2`, `read = 0`, `wrapped = 0`. `replayNow()` in scene 12 arms the
  RACE frame's own finish branch (`g_RacePhase` `0x801E6B7C` = 4,
  `lap = raceLength + 1`, finish timer 0), so the game calls
  `BeginReplay` + `SetScene(17)` itself — **no scene poke**.
- **Turn gate is host-only.** Ghost mode wraps
  `gameManager.functions.simulateInput` (the cwrap the netplay client applies
  remote input through, **not** `gameManager.simulateInput`): `turn: host` keeps
  player 0 and drops player 1; `turn: guest` keeps player 1 remapped to 0 and
  drops player 0 (`mpGhost.gatedInputs` / `.remappedInputs` count both). The
  shared-car remap is **not** installed in ghost mode. A ghost guest installs no
  local gate, is `raceLive` from boot and still sends input.
- **Scheduler and labels.** One ~16 ms interval reads the screen/scene id,
  captures once when the end screen first appears, swaps once before the replay,
  and logs `GHOST // CAPTURED <seat> <n>f` / `GHOST // REPLAY <peer> <n>f` /
  `GHOST // NONE`. Panel status reads `GHOST // REPLAY HOST RUN`,
  `GHOST // WAITING FOR RIVAL` or `GHOST // NO TAPE YET`; the chip is prefixed
  `GHOST`. Route A's label is exactly **`ghost replay (sequential)`**. Route B
  adds the `LIVE` row (ON/OFF + `SYNTHETIC <n>f x <stride> B @ 0x…`) and the
  statuses `GHOST // LIVE (RIDGE)`, `GHOST // LIVE (RAGE GP)`, else
  `GHOST // REPLAY (<error>)` (`draw-path-unverified`, `not-in-race`,
  `guest-core`). The Route B label is **`ghost rendered (in-game)`**, scoped to
  Ridge's race screen and Rage Grand Prix.
- **Rematch** is one click per seat: the game page posts
  `{type:'rr4-rematch', code, role, game, drive, turn}` to its shell, which
  reloads
  `/multiplayer?room=<code>&host=1|0&embedded=1&game=<key>[&drive=ghost&turn=<next>]`.
  The host recreates the same code (the server reclaims it when the old room
  only holds dead sockets); the guest retries `join` until it exists. A ghost
  rematch **flips the turn** (`host` ↔ `guest`) and keeps `drive: ghost`; never
  roll a new code for a rematch.
- `/mp` has a 20 s heartbeat (silent sockets terminated), host promotion, room
  list broadcasts, `ping`→`pong` and a 5-minute stale-room sweep. Restart `:8080`
  after a `/mp` edit and re-probe.
- The collapsed netplay chip shows the seat, room, `P2 LOCKED`/`P2 LIVE` (R4) or
  `GUEST P2 SHARED` → `GUEST P2 LIVE` (shared car) and the host's stage; the
  panel's role pill mirrors the lock state and every host stage is logged there.
- **Honest limits:** only R4 has a real two-car VS Battle. The disc plan/handoff
  is verified on all three discs (lounge UI 32/32, `/mp` 16/16), but Rage/Ridge
  in-game play is **`netplay transport; in-game mode unverified`** — the
  shared-car input remap is not yet proved in a live race. Never write
  "Rage/Ridge 2P works", and never reuse the R4 macro/race numbers for them.
  Ghost mode now has **two scoped labels**. Route A:
  **`harness-verified ghost replay (sequential, Ridge + Rage)`** (40/40 engine,
  36/36 lounge) — a post-race replay of the other seat's native tape. Route B:
  **`harness-verified ghost rendered (in-game)`** (36/36,
  `test-mp-live-ghost.mjs`) for **Ridge's race screen** and **Rage Grand Prix**
  only, where the tape is applied to a spare rival slot every frame and drawn by
  the game (pose equals tape 16/16, A/B delta clear of the noise floor, player
  still driving, turn gate unchanged). In both: harness tapes are synthetic short
  runs (Ridge 161 records, Rage 100 subframes / 50 samples), the Rage A run is
  stopped by the finish arm rather than a lap, **Rage Time Attack is replay-only**
  (`draw-path-unverified`, never a ghost car), and no human lap has been recorded.
  The live ghost is **drawn, not simulated** — never claim collision, AI, a second
  physics car or "both cars on track"; Rage TA is always `ghost replay
  (sequential)`.

### 5.4 `/race-day` — Race Day (50-driver mass start)

One race, one shared clock, one leaderboard. **Every driver runs their own R4
core in their own browser**; the server owns the event (course, car class, start
signal, seats, standings) and streams no video. Server: `_server/src/mmo.js`
(attached from `_server/src/server.js` with a thin additive mount: the import,
the `/race-day` document route, `attachMmo({server, tlsServer})` and
`GET /api/mmo/status`). Client:
`public/mmo.html` + `js/mmo-client.js`, `js/mmo-ui.js`, `js/mmo-lfg.js`,
`js/mmo-spectate.js`, `js/mmo-hud.js` (+ `css/mmo*.css`).

- **Entry points (keep all of them):** the **RACE DAY** button in the shell top
  bar (between PLAY and 2P), the primary RACE DAY card on `/welcome`
  ("50 DRIVERS · ONE RACE"), the RACE DAY CTA on `/games` (R4 only;
  `aria-disabled` + the reason for Rage Racer / Ridge 1994), the cross-link
  strip on `/multiplayer`, and `/` with `?mmo=1` or `?party=CODE`, which lands
  on `/race-day` after ENTER. Invite link `/race-day?party=CODE`; spectate
  `?spectate=1`; bots demo `?bots=1` or `RR4_MMO_BOTS=1`.
- **State machine:**

  ```text
  lobby ──min queued && (seats==MAX || fill timer)──► grid
  grid ──GRID_MS assemble──► countdown (3,2,1, startsAt) ──► racing
  racing ──everyone finished || race timeout──► results
  results ──RESULTS_MS──► lobby (next event id, index + 1)
  ```

  `lobby` accepts `queue` and assigns seats (team cycles the four teams by seat,
  seat 1 → Solvalou, emptiest team first); `grid` freezes the seat list, the
  course and the car class for the
  whole event; `countdown` broadcasts `startsAt`; `racing` accepts `telemetry`
  at ≤4 Hz and broadcasts standings at 2 Hz; `results` freezes the 50-row table
  and starts the next event. The server rolls one of the eight R4 courses **in
  in-game menu order** and a `D` or `G` car class; plan `laps` is 3.
- **Telemetry contract (RE-confirmed — cite `_runtime/analysis/14-ram-telemetry.md`):**
  race clock `0x800F4E2F` (u32 LE, 1 count = 1 ms; the mirror `0x8010C24F`
  carries the same value), speed `0x800AC0EE` (u16 LE, 8.8 fixed point,
  km/h = raw / 64). **Finish** = the clock flipping from a live value to
  `0xFFFFFFFF`. The **lap counter is unconfirmed** — never document a lap
  address as fact. The browser sends `{t, lap, raceTimeMs, speedKph, state}`;
  the server clamps `lap` 1..99, `raceTimeMs` 0..3,600,000, `speedKph` 0..400,
  refuses a backwards `raceTimeMs`, and derives position from that telemetry —
  never from a client-claimed place. `mmo-hud.js` is RAM-first: it anchors the
  live PSX window on the R4 label table (`0x800A2180`), adopts a base only when
  the clock actually moves, treats a monotonic clock that advances ≈1 ms per
  emulated ms as valid, and caps at `9:59.999` (the in-game timer pins there, so
  a race longer than 10 min reports a pinned time). A stopwatch is the exception,
  used only when no anchored clock can be found.
- **LFG rules:** the LFG panel is the only thing that starts a human race.
  `queue` is idempotent; `start` ("START NOW", labelled "START WITH n") needs
  `MIN_DRIVERS` queued and only works in `lobby` (with bots enabled one queued
  human is enough); `party:create`/`party:join`
  make a party of ≤2 (5-char code, echoed as `party`); `spectate` is a seatless,
  standings-only client; `chat` is ≤120 chars at 1/s and is echoed as a `chat`
  frame; `config {bots}` toggles the demo bots at 1/s without a seat. Bots are
  always labelled `BOT` — never present a bot-only grid as a human race.
- **Scale budget (measured twice at 550 seats, `RR4_MMO_MAX=550`):** standings
  cadence 1.93–1.95 Hz, broadcast p95 527–528 ms (p99 531), grid frame
  ≤1,973 B, standings frame ≤1,290 B at 550 seats (the protocol suite's largest
  frame, at 50 clients, is 1,497 B against a 1,500 B budget), ~1.1–1.4 MB/s
  total egress (1.7–2.5 kB/s per client), 0 dropped.
  Standings carry top-N + self + neighbours; the full 500-row table exists only
  in `result`. Skip a standings tick for a socket with
  `bufferedAmount > 65536`, coalesce grid broadcasts to one per 100 ms, and
  build one shared payload instead of `JSON.stringify` per recipient.
- **Environment knobs** (`_server/src/mmo.js`): `RR4_MMO_MAX` (50),
  `RR4_MMO_MIN` (4), `RR4_MMO_FILL_MS` (60000), `RR4_MMO_GRID_MS` (5000),
  `RR4_MMO_COUNTDOWN_MS` (3000), `RR4_MMO_RESULTS_MS` (20000),
  `RR4_MMO_RACE_TIMEOUT_MS` (600000), `RR4_MMO_HEARTBEAT_MS` (20000),
  `RR4_MMO_SLOW_BACKLOG` (65536), `RR4_MMO_BOTS` (unset). Restart `:8080` after
  a `src/mmo.js` or mount edit; a stale process answers `/race-day` with 404 or
  has no `WS /mmo`.
- **Honest limits:** 550 was proved with **synthetic WebSocket clients**, not 550
  humans and not 550 browser cores; **50 is the MVP target**. No ghost cars on
  track, no spectator video, no persistence (a server restart starts a new race
  day), telemetry is client-reported with plausibility clamps, and bots are
  bots. The in-race HUD is `/play?mmo=1&event=<id>&seat=<n>&team=<t>` (add
  `&game=r4&threads=0`); nothing auto-navigates today, and its FINISHED card
  links back to `/race-day`.

## 6. Native paths

- **Host-stream fallback** `/lobby`: native split-screen rendered by
  `RidgeRacer4Recomp`, captured with ffmpeg and relayed as jsmpeg. Seats/READY
  over `/ws`, stream over `/stream`. It is a fallback, not the normal path.
- **Only `:8080` autostarts the native cabinet.** A throwaway instance
  (`RR4_PORT=8097`, a harness, a second copy) now sets `RR4_NO_AUTOSTART=1`
  itself unless the operator sets it explicitly, because `config.json` has
  `autoRestart: true`: a game that boots and exits would otherwise reopen a
  Ridge Racer window every `restartDelayMs` (2.5 s) forever. The restart backoff
  only resets when a launch survives 20 s, so a crash loop grows 2.5 → 5 → 10 →
  20 s instead of hammering. If windows still appear, look for a stray
  `node src/server.js` (one per port) and kill the tree with `taskkill /T`.
- **Native recomp** (`RidgeRacer4Recomp/`, `Play Ridge Racer 4.bat`): PSXRecomp
  x64 + OpenBIOS. `settings.toml` `fullscreen = 0` is the stable setting
  (exclusive `= 2` switched the desktop to 1024×768 here).
- Known native gaps: `keybinds.ini` `[player2]` duplicates `[player1]` and
  `p2_device = "none"`; `--debug-port` is compiled out (`PSX_NO_DEBUG_TOOLS`);
  `recomp-net` is stubbed (`netplay start failed (-1)`). Do not claim native 2P
  input until a rebuild proves pad 2.

## 7. Music and audio contract

- Audio is extracted from the **user's own discs** into
  `_server/public/music/<game>/`; never redistribute it with the code.
- The manifest is generated, never hand-edited:
  `node scripts/build-music-manifest.mjs` (from `_server/`), served by
  `/api/music` and `/music/manifest.json`.
- Keep the R4 intro first in the R4 playlist. ENTER plays it first regardless of
  the selected game, then hands over. No autoplay before the gesture.
- One `HTMLAudioElement` in the parent document; `/play*` views keep playing but
  duck to ~22 %. The slider sets the un-ducked level.

## 8. Docs site contract

The Zudoku site lives in `docs/` with `basePath: "/docs"` and builds to
`docs/dist/docs`; the cabinet serves it at `/docs`.

```powershell
cd docs
npm install          # once
npm run build        # prerenders the manual into dist\docs
npm run verify       # pages, links, app routes, redirects against :8080
```

- Never edit `dist/`; rebuild it. Do not open `dist/index.html` directly.
- `/docs` and `/docs/` 301 to `/docs/introduction`; `/docs/games`, `/docs/play`
  and `/docs/multiplayer` 301 to their first page (`DOCS_SECTION_PAGES` in
  `_server/src/server.js`). Keep that table in sync with navigation.
- MDX links: docs-internal links are site-relative (`/multiplayer/lounge`); app
  routes are raw HTML (`<a href="/play">`), because Markdown would prefix
  `/docs`. Raw anchors use `/docs/...`.
- Frontmatter `title` is the only H1; a deliberate hero page uses `title: ""` +
  `sidebar_label` + `seo.title`.
- Verify after a build: one H1 per page, no unresolved links, desktop 1440×900 and
  mobile 390×844 screenshots for changed screens, expected console noise only.

## 9. Data accuracy and legal boundary

- Use the exact serials, byte counts and hashes from `_server/game/game.toml` and
  the disc notes; never round away evidence.
- Distinguish **CD tracks** from **courses** (Rage: 4 courses / 17-track disc;
  Ridge 1994: 1 course / 14-track disc; R4 is the 2P title).
- Scoped labels only: `boot-verified`, `harness-verified` (16/16 multi-disc `/mp`,
  32/32 multi-disc lounge UI, 33/33 lounge UI, 22/22 raw `/mp`, 30/30 shell,
  47/47 edge headers, 12/12 `/mmo` protocol, 41/41 Race Day two-browser),
  `harness-verified host-only` (6/6 R4 macro, 14/14 Rage shared-car remap),
  `harness-verified two-browser` (40/40 race, two contexts on one host),
  `manually verified two-machine` (the operator ran a 2P VS Battle across two
  physical machines on the LAN, 2026-11-06 — no harness, no capture),
  `harness-verified synthetic load` (550 WebSocket clients, not 550 humans or
  550 browser cores), `harness-verified ghost replay (sequential, Ridge + Rage)`
  (40/40 engine + 36/36 lounge, the post-race native replay),
  `harness-verified ghost rendered (in-game)` (36/36 live ghost, Ridge race screen
  + Rage Grand Prix only, drawn not simulated, Rage TA replay-only),
  `boots; input mapping unverified`, `manually working`.
  Never promote a host-only result to "2P works", never promote the 40/40
  two-browser run to two-machine, never promote the 550-seat load probe to
  "550 humans raced", and never promote the live ghost to a simulated car or to
  Rage Time Attack.
- Rage Racer and Ridge Racer 1994 in the lounge are
  **`netplay transport; in-game mode unverified`** (shared car, manual start).
  The lobby manifest/plan/handoff is harness-verified for all three discs; that
  is **not** an in-game 2P result for Rage/Ridge. Only R4 is
  `harness-verified two-browser`.
- **Ghost has two scoped labels.** Route A: `harness-verified ghost replay
  (sequential, Ridge + Rage)`. `test-mp-ghost-replay.mjs` 40/40 covers the tape
  capture/swap, the pose-equals-tape proof, the rendered-frame change, the Rage
  scene-12 finish arm → scene 17, the turn gate and the IndexedDB round trip;
  `test-mp-ghost-lobby.mjs` 36/36 covers the DRIVE/TURN selectors, the handoff
  and the rematch turn flip. Route B: `harness-verified ghost rendered
  (in-game)`. `test-mp-live-ghost.mjs` 36/36 covers the runtime stub + one-word
  patch on Ridge's race screen and Rage Grand Prix, the ghost-slot pose equals the
  tape 16/16, the A/B frame delta against the measured noise floor, the player
  still driving, ~10 s of survival, and `mpLiveGhost` absent / `mpGhost=live` / R4
  keeping B off. Both: tapes are synthetic, no human lap is recorded, and Rage
  **Time Attack is replay-only** (`draw-path-unverified`) — never write "ghost
  car", "collision" or "two cars on track" for TA, and never call the live ghost a
  simulated car.
- REA evidence covers the native runtime and the original lobby client, not
  EmulatorJS/PCSX-Rearmed.
- Legal: discs are user-supplied; OpenBIOS is bundled under its license; Namco
  artwork/audio is not redistributed with the code.

## 10. Evidence and test matrix

Each suite is a real harness under `_server/` (the docs verifier lives in
`docs/scripts/verify.mjs`), prints PASS/FAIL, and most write a JSON result plus
screenshots under `_runtime/`.

| Suite | Command | Result | Proves |
| --- | --- | --- | --- |
| Lounge UI + handoff + rematch | `node test-mp-lobby-ui.mjs` | **33/33** | two browsers: ENTER → lounge → same plan/URL → rematch → second race; `/play-net` held, so no emulator boot |
| Multi-disc lounge transport | `node mp-games-probe.mjs` | **16/16** | `/mp-games.json` shape, per-disc rolls (r4 8/8, rage 4/4, ridge 1/4), room/list `game`+`mode`, host-only `setgame` before the lock, guest adoption, invalid-key fallback, unchanged R4 race shape, cleanup (`_runtime/mp-games.json`) |
| Multi-disc lounge UI + handoff | `node test-mp-games-ui.mjs` | **32/32** | two browsers: RAGE and RIDGE select/create/join/host `setgame`/READY/GO, both handoffs carry `game=`, shared-car overlay with one car line, R4 regression, `?game=` deep link, 390×844 overflow (`_runtime/mp-games-ui.json` + `mp-games-*.png`); `/play-net` held, so no emulator boot and no Rage/Ridge in-game proof |
| Rage shared-car host path | `node test-mp-shared-car.mjs` | **14/14** | **host-only, one browser, no guest**: real Rage core boots, `mode=shared-car`/`macro=manual`, plan clamps to 4 courses/4 car slots, room `RAGE-TEST`, brand `2P SHARED`, `mpRun()` = `macro:manual` (no R4 stages), `player 1 → 0` remap installs and counts a press; no live drive (`_runtime/mp-shared-car.json`) |
| Ghost replay engine | `node test-mp-ghost-replay.mjs` | **40/40** | Ridge: a 161×40 synthetic tape staged in a zeroed BSS run with the applier pointer `0x80080434` repointed, the built-in replay reached (8→9), the live car pose equal to the tape on every sampled frame (53–54 exact samples over 27 distinct playback frames) and 322/322 peer samples, and a mirrored peer tape changing the rendered frame; Rage: real TA run captured, scene-12 finish arm → scene 17 with no scene poke, 107/107 pose samples, mirrored-tape frame change; turn gate both ways, IndexedDB round trip, `mpGhost=live`/R4/guest paths off (`_runtime/mp-ghost-replay.json` + `mp-ghost-*.png`); synthetic tapes, host-only |
| Live ghost (Route B) | `node test-mp-live-ghost.mjs` | **36/36** | own `:8088` cabinet: the DrawCars-entry stub `0x801F4700` (324 B / 81 words) and the Ridge stub `0x801EA610` (208 B / 52 words) read back byte-identical; the shipped words `0x27BDFFD8` / `0x0C0092E3` are repointed only inside the race; the ghost slot (`0x801F4194` / `0x801EDA10`) carries the tape pose **16/16** on both discs; the A/B delta beats the measured noise floor (Rage 1118 vs 0 cells, Ridge 846 vs 83); the player still drives (298 / 318 units); the stub survives ~10 s; A still records in the same run (Rage recorder kept); the turn gate is unchanged both ways; `mpLiveGhost` absent, `mpGhost=live` and R4 keep B off; Rage TA reports `draw-path-unverified` and falls back to A (`_runtime/mp-live-ghost.json` + `mp-live-ghost-{rage,ridge}-{off,on}.png`, `mp-live-ghost-a-replay.png`); **drawn, not simulated, synthetic tapes, host-only** |
| Ghost lounge UI + rematch | `node test-mp-ghost-lobby.mjs` | **36/36** | two browsers: R4 drive control disabled and handoff unchanged, RIDGE `LIVE`/`GHOST` + `rr4.mp.drive` persistence, room `DRIVE GHOST` + host-only `TURN` selector (guest read-only), rooms-list `GHOST` badge, `DRIVER: GUEST` overlay, handoff `mpGhost=ghost&mpTurn=guest`, rematch flips to `turn=host`, `live` regression, 390×844 no overflow (`_runtime/mp-ghost-lobby.json` + `mp-ghost-lobby-*.png`); `/play-net` held, so no core boots and no tape swap |
| Raw `/mp` transport | `node mp-ws-probe.mjs` | **22/22** | create/join/roles/race payload, `pong`, server heartbeat ping, cleanup |
| Shell fullscreen + fill | `node test-shell-fs.mjs` | **30/30** | fullscreen/`F`/exit, iframe fill, `F` from inside the frame, no second gate, ducking, one top bar, embedded `/play*`/`/docs` |
| Host VS Battle macro | `node mp-macro-test.mjs` | **6/6** | real R4 host: menu byte, car P1/P2, course, `race:live`, final frame is the race |
| Two-browser race | `node test-mp-race-e2e.mjs` | **40/40** | real `/play-net` both sides, macro, split-screen frames, guest stream advancing, guest P2 on the host core, guest chip |
| Race Day protocol | `node mmo-protocol-test.mjs` | **12/12** | `hello`→`welcome`, seating + team balance, start-now lifecycle, one plan for every client, telemetry ordering, clamps, ~2 Hz standings, finish→result→lobby, heartbeat, seat reclaim, `/api/mmo/status`, 60-client fanout |
| Race Day load | `node mmo-load-probe.mjs --drivers 550` | **550 sockets / 550 seats**, 0 dropped (`_runtime/mmo-load-550-single.json` 12/12 gates) | synthetic WS clients at `RR4_MMO_MAX=550`: cadence 1.93–1.95 Hz, p95 527–528 ms (p99 531), grid ≤1,973 B, standings ≤1,290 B, ~1.1–1.4 MB/s egress. **Not** 550 humans/cores |
| Race Day two-browser UX | `node test-mmo-ui.mjs` | **41/41** | two browsers through ENTER → RACE DAY → LFG → countdown → standings → results, party invite, spectate, `/play?mmo=1` HUD (ROM held) |
| Race Day screenshots | `node mmo-shots.mjs` | **24/24** captures | 1440×900 + 390×844 for lobby/LFG/grid/countdown/standings/HUD/results/spectate/shell entry (`_runtime/mmo-shots.json`) |
| Heartbeat / promotion | `node mp-heartbeat-probe.mjs 8095` | **10/10** | throwaway instance: dead socket, host promotion, stale-room cleanup |
| Edge headers / TLS | `node scripts/https-smoke.mjs <base>` | **47/47** loopback + HTTPS, **35/35** plain-HTTP LAN (no COOP by design) | strong ETag + `If-Range`→206, brotli, keep-alive, COOP/COEP scope, `/api/netplay-config`, section 301s |
| Docs build + links | `cd docs; npm run verify` | pass/fail | every page 200 + one H1, internal links, app routes, redirects |

Run everything: `cd _server; node verify-mp.mjs --full` (fast set without
`--full`). Evidence files: `_runtime/mp-lobby-ui.json`,
`_runtime/mp-lobby-ws.json`, `_runtime/shell-fs.json`,
`_runtime/mp-macro-evidence.json` + `mp-macro-*.png`,
`_runtime/mp-race-e2e.json` + `mp-race-e2e-*.png`, `_runtime/calib/`,
`_runtime/mp-games.json`, `_runtime/mp-games-ui.json` + `mp-games-*.png`,
`_runtime/mp-shared-car.json` + `mp-shared-car-rage.png`,
`_runtime/mp-ghost-replay.json` + `mp-ghost-{ridge,rage}-*.png`,
`_runtime/mp-ghost-lobby.json` + `mp-ghost-lobby-*.png`,
`_runtime/mp-live-ghost.json` +
`mp-live-ghost-{rage,ridge}-{off,on}.png` + `mp-live-ghost-a-replay.png`,
`_runtime/ghost-research/*` (Route A design, the live-ghost probes, tape probes,
Rage TA draw-path probes, Rage finish probe),
`_runtime/bench-native-after-play-perf*.json`,
`_runtime/bench-netplay-after-netplay-tune.json`,
`_runtime/edge-headers-2026-11-06.txt`, `_runtime/play-perf-*.png`,
`_runtime/mmo-protocol.json`, `_runtime/mmo-load.json` /
`mmo-load-550-*.json`, `_runtime/mmo-e2e.json` + `mmo-e2e-*.png`,
`_runtime/mmo-shots.json` + `mmo-shot-*.png`.

The Race Day protocol/load harnesses default to a throwaway instance on
`:8097` (`--base` / `MMO_BASE` overrides) and never restart it;
`test-mmo-ui.mjs` spawns its own cabinet on `:8093` and kills only that child.
`mmo-shots.mjs` needs a running `:8080` (override with `RR4_BASE`). The 550-seat
run needs `RR4_MMO_MAX=550` on the instance under test — 50 is the product
default. `verify-mp.mjs` stays the 2P wrapper; run the four MMO harnesses
separately. The two multi-disc lounge harnesses follow the same pattern:
`mp-games-probe.mjs` spawns a throwaway `:8097` (`--base` / `MP_BASE`, never
`:8080`) and `test-mp-games-ui.mjs` spawns and kills its own `:8093`. The ghost
harnesses do the same: `test-mp-ghost-replay.mjs` spawns its own cabinet on
`:8096` (walks to the next free port, `--port` / `--base` / `GHOST_BASE`), drives
the real `/play-net` pages one at a time, and never touches `:8080`;
`test-mp-ghost-lobby.mjs` spawns and kills its own `:8093` (`--port` / `--base`)
and holds every `/play-net` document, so it boots no core;
`test-mp-live-ghost.mjs` spawns its own `:8088` (walks with `--port` / `--base`,
`LIVE_GHOST_BASE`), boots one real host core per disc, and re-probes `:8080` at the
end to prove it was untouched.

Expected console noise — never claim 0 console errors:

- `[NETPLAY] No ICE servers configured. Connections will only work on LAN.`;
- React #418 hydration warning on `/docs/introduction`;
- EmulatorJS `invalid core option` notices.

COOP/COEP is **not** in that list any more. The server sends it only on a
loopback host or HTTPS, so a plain-HTTP LAN origin has no COOP warning and no
isolation; loopback/`RR4_TLS=1` isolate the shell and its embedded `/play`
(`crossOriginIsolated=true`, `SharedArrayBuffer` and
`navigator.storage.persist` available) with no warning either.

## 11. Verification checklist

Before calling a change done:

- [ ] The command/path in the docs was run successfully.
- [ ] Ports/URLs are correct (app **8080**, relay **3010**; `RR4_PORT` override).
- [ ] Changed config keys appear in the example and the docs.
- [ ] Changed screens/themes have fresh desktop (1440×900) and mobile (390×844)
      screenshots.
- [ ] `cd docs && npm run build` succeeds, then `npm run verify` passes.
- [ ] `/play` returns 200 and `/docs` 301s straight to `/docs/introduction`.
- [ ] `/`, `/welcome`, `/games`, `/multiplayer`, `/race-day`, `/mmo.html`,
      `/api/mmo/status`, `/play-net`, `/lobby`, `/api/music` return 200;
      `/docs/games`, `/docs/play`, `/docs/multiplayer` 301 to their first page.
- [ ] No broken internal links; one H1 per content page.
- [ ] Shell/iframe change → `node test-shell-fs.mjs` passes.
- [ ] Lounge/handoff/macro change → `node verify-mp.mjs` passes (add `--full` for
      the race).
- [ ] Multi-disc lounge change (`mp-games.json`, the DISC selector, `setgame`,
      handoff `game=`, shared-car remap) → `node mp-games-probe.mjs` (16/16),
      `node test-mp-games-ui.mjs` (32/32) and `node test-mp-shared-car.mjs`
      (14/14, host-only), plus the R4 regression
      `node mp-ws-probe.mjs` (22/22) and `node test-mp-lobby-ui.mjs` (33/33).
      `/mp-games.json` must return 200 and match `_server/public/mp-games.json`.
      A `:8080` process older than the change answers `create`/`room` without
      `game`/`mode` — restart it before a manual browser check.
- [ ] Ghost change (`drive`/`turn`, `mpGhost`/`mpTurn`/`mpLiveGhost`, the tape
      swap, the Route B stub/hook) → `node test-mp-live-ghost.mjs` (36/36),
      `node test-mp-ghost-replay.mjs` (40/40) and
      `node test-mp-ghost-lobby.mjs` (36/36), plus the R4 regressions
      `node mp-ws-probe.mjs` (22/22), `node test-mp-lobby-ui.mjs` (33/33) and
      `node test-mp-race-e2e.mjs` (40/40). Labels: `ghost replay (sequential)` for
      the post-race replay; `ghost rendered (in-game)` for the live ghost on
      Ridge's race screen and Rage Grand Prix only — Rage TA is replay-only, and
      the ghost is drawn, never simulated (no collision).
- [ ] `/mp` or server change → restart `:8080`, then `node mp-ws-probe.mjs`.
- [ ] Race Day change (`src/mmo.js`, `/race-day`, `WS /mmo`, `mmo*.js/css`) →
      restart `:8080`, then `node mmo-protocol-test.mjs`, `node test-mmo-ui.mjs`
      and `node mmo-shots.mjs`; add
      `node mmo-load-probe.mjs --drivers 550` against an instance started with
      `RR4_MMO_MAX=550` when the fan-out/broadcast path changed. `WS /mmo` must
      accept a socket and `/api/mmo/status` must answer.
- [ ] Server/header/TLS change → `node scripts/https-smoke.mjs
      http://127.0.0.1:8080` (47/47); for TLS run
      `powershell -File scripts/make-cert.ps1`, `start.ps1 -Tls`, then
      `node scripts/https-smoke.mjs https://localhost:8443`.
- [ ] `AGENTS.md`, `README.md`, `START-HERE.md`, `HANDOFF.md` and the relevant
      docs page agree with each other and with the evidence numbers.

## 12. Editing rules for agents

- Keep changes consistent with the surrounding structure and naming.
- Prefer the dedicated edit/write tools; do not shell-rewrite files with
  encoding-sensitive content.
- Treat unfamiliar files as user work. Do not delete or overwrite them without
  checking.
- When several agents work in parallel, assign **disjoint file ownership**; never
  let two agents edit the same file at once. Subagents must report exact files and
  assumptions.
- Do not run `git reset`, `git clean`, or force-checkout on shared work.
- Do not stop a server or kill a game/relay process another session is using
  unless the task requires it.
- Do not describe an unfinished background task as complete.
- Keep `AGENTS.md`, `README.md`, `START-HERE.md` and the docs page in the same
  change; bump any `?v=YYYYMMDD` script query only when you need a cold fetch
  (app scripts already revalidate).

## 13. Current project map (keep this current)

```text
disc/                          user-supplied CUE/BIN/CHD
RidgeRacer4Recomp/             native recomp release + user state (game.toml)
_server/                       Express app, EmulatorJS, netplay relay, music
  public/enter.html            default R4 login shell (parent audio + iframe)
  public/js/enter.js           shell playlist/nav/theme/fullscreen/2P handoff
  public/welcome.html          WELCOME TO RIDGE CITY hub (/welcome)
  public/games.html            machine check (/games)
  public/multiplayer.html      2P LOUNGE (/multiplayer)
  public/js/multiplayer.js     room code, DISC selector, teams, READY, race plan UI, rematch
  public/mp-games.json         disc manifest (single source of truth: ids 4/5/6, mode, macro, tracks/cars)
  public/play.html             browser disc deck + game (EJS 4.2.3)
  public/play-net.html         netplay page (EJS 4.3.0-pre)
  public/js/play-net.js        auto host/join, macro, guest gate, chips, rematch,
                               ghost A tape engine + ghost B live-ghost stub/patch
  public/mmo.html              Race Day 50-seat mass start (/race-day)
  public/js/mmo-client.js      /mmo socket, state store, reconnect, telemetry writer
  public/js/mmo-ui.js          grid, header, standings, countdown, results, feed
  public/js/mmo-lfg.js         LFG queue, fill/ETA, party code, START NOW, bots
  public/js/mmo-spectate.js    watch-only board (?spectate=1)
  public/js/mmo-hud.js         /play in-race HUD + RAM telemetry reader
  public/css/mmo*.css          Race Day page, LFG and HUD styles
  public/index.html            legacy lobby, served at /lobby
  public/music/                extracted audio + generated manifest
  public/emulator[/43]/data/   pinned EmulatorJS assets (4.2.3 / 4.3.0-pre)
  src/server.js                HTTP/WS, /play, /play-net, /mp, /race-day, /docs, /music
  src/mmo.js                   Race Day event server (/mmo, /api/mmo/status)
  netplay/                     pinned 4.3.0-pre relay + client assets
  mp-ws-probe.mjs              raw /mp evidence (22/22)
  test-mp-lobby-ui.mjs         lounge UI + rematch evidence (33/33)
  mp-macro-test.mjs            host-only R4 macro evidence (6/6)
  test-mp-race-e2e.mjs         two-browser race evidence (40/40)
  mp-games-probe.mjs           multi-disc /mp + manifest evidence (16/16)
  test-mp-games-ui.mjs         multi-disc lounge UI + handoff evidence (32/32)
  test-mp-shared-car.mjs       Rage shared-car host: manual stage + remap install (14/14)
  test-mp-ghost-replay.mjs     ghost replay (sequential): native tape capture/swap,
                               Ridge replay 8->9, Rage scene-12 arm -> 17, turn gate (40/40)
  test-mp-live-ghost.mjs       live ghost (Route B): RAM stub + one word patch, ghost slot
                               pose == tape, A/B frame delta, flag matrix (36/36)
  test-mp-ghost-lobby.mjs      ghost lounge: DRIVE/TURN, handoff, rematch turn flip (36/36)
  test-shell-fs.mjs            fullscreen/embedded evidence (30/30)
  verify-mp.mjs                runs the 2P suites in one table
  mp-heartbeat-probe.mjs       heartbeat/promotion/stale-room probe
  mp-ctrl-probe.mjs            host<->guest data-message probe
  mp-calibrate.mjs + plans/    calibration harness + plan JSONs
  mmo-protocol-test.mjs        /mmo protocol evidence (12/12)
  mmo-load-probe.mjs           550-socket fan-out probe (synthetic clients)
  test-mmo-ui.mjs              two-browser Race Day e2e (41/41)
  mmo-shots.mjs                Race Day screenshots (24/24)
  scripts/make-cert.ps1        self-signed cert for the opt-in TLS listener
  scripts/https-smoke.mjs      edge-header smoke (47/47 loopback+HTTPS, 35/35 LAN)
docs/                          Zudoku manual (built to docs/dist/docs)
  pages/play/performance.mdx   measured fps/latency/transport table + limits
  pages/multiplayer/race-day.mdx  Race Day product, protocol, telemetry contract
  pages/multiplayer/shared-car.mdx  Rage/Ridge shared-car 2P (limits, how to start)
  pages/multiplayer/ghost-run.mdx   ghost for Rage/Ridge: live ghost (Route B,
                                    Ridge race + Rage GP) and replay (Route A)
  scripts/verify.mjs           build/links/routes/redirects verifier
_runtime/                      logs, captures, screenshots, calibration, evidence
_runtime/ghost-research/       ghost design + probes: Route A replay, Route B live ghost,
                              tape format, Rage TA draw-path probe, Rage finish probe (REA)
analysis/                      REA evidence JSON
_tools/ffmpeg/                 capture + audio encoding
NATIVE-RECOMP-SETUP.md         native install notes
REA-ANALYSIS.md                REA evidence write-up
```

## 14. The short version

**Run the build, update the page, update the README, run the harness, and leave
the next agent a command that works.** If it boots, sounds, or hands off to
another browser, it is not done until the docs and the evidence say so.
