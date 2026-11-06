# PLAY-QA — native EmulatorJS `/play` on the real LAN origin

**Date:** 2026-11-04 (final run ~23:27 local)
**Origin under test:** `http://<host-lan-ip>:8080/play` (LAN origin, not localhost)
**Server:** existing test server, `RR4_NO_AUTOSTART=1`, `RR4_STREAM_SOURCE=test` (left running)
**Browser:** Brave/Chrome 156.0.8078.74 via `puppeteer-core`, headless new, SwiftShader, fresh profile
**Viewports:** desktop 1280×800; mobile 390×844, DPR 2, touch + Android UA
**App version tested:** `public/play.html` 2427 B, `public/js/play.js` 21048 B, `public/css/play.css` 8920 B (the CHD manifest: `r4.chd` + `rage-racer.chd`)
**Method:** read-only; no app files were edited. Harness: `_server/test-play-qa.mjs`. Raw data: `_runtime/play-qa-result.json`.

> The app changed while QA was running (CHD switch, Rage Racer ROM installed, sound gate + fullscreen added). The results below are from the final run against the stable version listed above. `r4.chd` (341 MiB) is now the active asset; the 621 MB raw BIN is the fallback, so cache was verified for the active CHD rather than the fallback.

---

## Verdict

**9 PASS / 2 FAIL** (plus two medium bugs and two low bugs; see the ranked list below).

| # | Coverage item | Verdict |
|---|---|---|
| 1 | `/play` loads on LAN IP; state reaches `startedAt`/canvas/RUNNING; no page errors | **PASS** (one environmental COOP console error) |
| 2 | Canvas present/sized; renders real game frames, not a frozen black canvas | **PASS** |
| 3 | Keyboard input: click canvas, press Enter/arrow, game advances | **PASS** (but the sound gate swallows the first keypress — bug 2) |
| 4 | Fullscreen control exists and browser fullscreen works | **PASS** |
| 5 | Audio context state; blocked-until-click reported | **PASS** (running before gesture in this headless run) |
| 6 | First vs second load; ROM not re-downloaded when cached | **PASS** (3.34 s → 1.17 s; only a 1-byte Range probe + HEAD) |
| 7 | Mobile 390×844: usable, canvas visible, no horizontal overflow, touch pad visible | **FAIL (Low)** — canvas/pad pass, but header/footer overflow and clip |
| 8 | Game selector: Type 4 selected, Rage Racer pending, no crash | **PASS** (Rage is no longer “pending”; it is installed and boots — spec drift) |
| 9 | Controller: mock Xbox/DualSense detection + EJS control settings | **FAIL (Medium)** — detected, but not auto-assigned; pad input is dead until manual mapping |
| 10 | Performance: rough FPS | **PASS** — emulator counter 60.0 fps |
| 11 | `/` landing links to `/play`; both work | **PASS** |

---

## Evidence by coverage item

### 1. Load / state — PASS

- `window.__R4` existed; `startedAt` set; `status = RUNNING` (`data-state="running"`); canvas present.
- First navigation → game start: **3,340 ms**; in-page `bootMs` **3,258 ms**.
- `state.errors = []`; **0 page errors**, **0 failed requests**, **0 HTTP ≥400**, **0 external requests**.
- Console: **1** browser-level error only:
  `The Cross-Origin-Opener-Policy header has been ignored, because the URL's origin was untrustworthy...`
  This is expected on plain-HTTP LAN origins. `crossOriginIsolated=false`; `threads=false` (the app already defaults threads off on non-secure origins). No JS exception or EmulatorJS error.
- Screenshot: `_runtime/play-qa-01-loading.png`

### 2. Canvas / rendering — PASS

- Desktop canvas backing store **890×667**, CSS box **891×668** at `x=194.7, y=78.5`.
- PSX boot is legitimately black for a moment (`02-intro` canvas: 0 % non-black, 5 colours). The Namco boot logo then appears:
  - `03-title` full page **37.6 %** non-black; canvas clip **2.4 %** non-black, **29** distinct colours.
  - `07-before-input` canvas: **11.1 %** non-black, **68** colours.
- After input the emulator advances to the intro movie and then the RR4 title screen:
  - `08-after-input` canvas: **66.8 %** non-black, **416** colours.
  - `10-after-input-wait` canvas: **66.7 %** non-black, **766** colours (actual “PRESS START BUTTON” title screen).
- Frame-to-frame hashes changed (`05-frame-a` `89b4de…` → `06-frame-b` `430449…`), so the canvas is live, not frozen.
- Screenshots: `_runtime/play-qa-03-title.png`, `play-qa-07-before-input.png`, `play-qa-08-after-input.png`, `play-qa-10-after-input-wait.png`.

### 3. Keyboard input — PASS (with bug 2)

- **Click canvas → Enter/ArrowDown/Enter:** **6** `gameManager.simulateInput()` calls reached the core (`[0,3,1]`, `[0,3,0]`, `[0,5,1]`, `[0,5,0]`, `[0,3,1]`, `[0,3,0]`); focus moved to `#game`; screenshots show Namco logo → intro movie → RR4 title screen.
- **Gate-only path (dismiss “CLICK TO RACE”, then press Enter without clicking canvas):** **0** core inputs; `document.activeElement = BODY`. The gate hides but does not focus the EJS parent. See bug 2.
- Screenshots: `_runtime/play-qa-07-before-input.png` → `play-qa-08-after-input.png` → `play-qa-10-after-input-wait.png`.

### 4. Fullscreen — PASS

- The app exposes a real header control: `#fsBtn` (`title="Fullscreen (F)"`, visible, enabled, 133.9×33 at desktop).
- Trusted click → `document.fullscreenElement = HTML`, `window.__R4.fs = true`, `body.fs = true`, floating `#fsExit` visible, canvas rect **1280×800**, status still `RUNNING`, no errors.
- Exit via Escape restores `fullscreenElement=null`, `body.fs=false`, `#fsExit` hidden, button text back to FULLSCREEN.
- EJS also has its own `Enter Fullscreen` menu control and `EJS_emulator.toggleFullscreen()` exists. The app’s header button is the working path.
- Screenshot: `_runtime/play-qa-11-fullscreen.png`.

### 5. Audio — PASS

- Before any gesture: `EJS_emulator.Module.AL.currentCtx.audioCtx.state = "running"`, 48 kHz; `muted=false`, `volume=0.7`; no “Click to resume Emulator” popup.
- The “CLICK TO RACE” gate is still shown; clicking it hides the gate and the context remains `running`.
- This headless Chrome was launched with `--mute-audio`, so the context state is not proof of audible output. It does show the app’s unlock path is correct; in a normal browser where autoplay leaves WebAudio `suspended`, the gate calls `ctx.resume()` and hides itself.
- Note: the gate is shown even when the context is already `running` (bug 4, low).

### 6. Reload / cache — PASS

- **First load:** navigation → started **3,340 ms**; boot **3,258 ms**; ROM transfer **341.2 MiB in 749 ms (455.6 MiB/s)**, `loaded=357,817,282`, HTTP 200.
- **Second load (same profile, same page reload):** **1,173 ms**; boot **1,035 ms**; **2.85× faster**.
- Second load network:
  - `GET /rom/r4.chd` → **206**, `content-range: bytes 0-0/357817282`, `content-length: 1` (the app’s 1-byte Range probe).
  - `HEAD /rom/r4.chd` → **200**, `content-length: 357817282` (EJS cache validation).
  - **No full GET**, no 341 MB transfer; `state.transfers = []`; `performance` entries `transferMB=0`.
- IndexedDB cache contains `r4.chd` = **357,817,282 bytes** (and `openbios.bin` = 524,288 bytes). Footer reads `ROM 341 MB · CACHED · BOOT 2.0s`.
- The old 621 MB raw BIN was not downloaded because the current manifest uses `r4.chd`. The same EJS IndexedDB path applies to the `fallbackRom` BIN if the CHD is removed.
- Screenshot: `_runtime/play-qa-12-reload.png`.

### 7. Mobile 390×844 — FAIL (Low)

Passing parts:

- Status `RUNNING`; canvas **378×284** at `x=6, y=292.25`; visible and rendering (Namco logo captured in `play-qa-18-mobile-game-1.png`, 2.5 % non-black, 24 colours).
- EJS virtual gamepad is visible (`display:block`, 4 groups: left stick/dpad, Y/X/B/A, Select/Start/Fast/Slow).
- Touch controls work: synthetic touchstart on Start produced **1** `simulateInput`; a real touchscreen tap on Start produced **2** `simulateInput` calls (`[0,3,1]` then `[0,3,0]`).
- No page-level horizontal scroll: `documentElement.scrollWidth = clientWidth = 390`.

Failing part (overflow/clipping):

- `document.body.scrollWidth = 447` (> 390).
- `#fsBtn` is at `x=341.25`, width `106.19` → right edge **447.4**, i.e. ~57 px off-screen; the mobile screenshot shows only the leading “FU…” of the fullscreen button.
- Footer is `nowrap`/`overflow:hidden` and clips the timing/link text (`… ROM 341 MB · CACHED · BOOT 0.9s LAN ARC…`).
- The EJS menu also opens by default over the canvas at start; closing it is needed to see the game. This is upstream EJS behaviour, but it makes the first mobile impression a black canvas with a menu.
- Screenshots: `_runtime/play-qa-16-mobile.png` (header clipping + pad), `play-qa-18-mobile-game-1.png` (actual canvas frame with pad hidden for pixel sampling).

### 8. Game selector — PASS (spec drift)

- Main page: `#gameSelect.value = "r4"`, options are exactly `Ridge Racer Type 4` and `Rage Racer`.
- **Rage Racer is no longer marked “(ROM pending)”** in the current manifest: `rage-racer.chd` now exists and `available: true`.
- `?game=rage` boots: **3,362 ms**, `rage-racer.chd` **472.4 MiB in 979 ms**, status **RUNNING**, no errors; canvas shows the Namco logo (`13b-selector-rage-frame.png`). No crash.
- If the acceptance criterion is literally “Rage Racer shows pending”, the current app no longer satisfies it; that is a content/spec change, not a failure.
- Screenshots: `_runtime/play-qa-13-selector-rage.png`, `play-qa-13b-selector-rage-frame.png`.

### 9. Controller — FAIL (Medium)

- Mock `navigator.getGamepads()` returned:
  - Xbox Wireless Controller (`045e:0b13`), index 0
  - DualSense Wireless Controller (`054c:0ce6`), index 1
- EJS `GamepadHandler` detected **both** (`EJS_emulator.gamepad.gamepads.length = 2`), and the Control Settings dropdown lists both devices.
- But the dropdown value is **“Not Connected”** and `gamepadSelection = ["", "", "", ""]`. Pressing Start on the Xbox pad produced **0** `simulateInput` calls.
- After manually selecting the Xbox pad in Control Settings, the same press produced **2** calls (`[0,3,1]` / `[0,3,0]`).
- Root cause: EJS emits the `connected` event in the GamepadHandler constructor before EJS registers its `connected` listener, so pads already present at page load are never auto-assigned. A pad hot-plugged after start would hit the listener and auto-assign.
- Screenshots: `_runtime/play-qa-14-controller.png` (Not Connected despite options), `play-qa-15-controller-mapped.png` (manual mapping).

### 10. Performance — PASS

- Emulator’s own frame counter: **301 frames / 5.015 s = 60.0 fps**.
- Browser rAF: 227.6 fps (headless runs unthrottled; not representative of a real vsync display).
- No long-frame stalls were observed in the 5 s sample.

### 11. Landing → `/play` — PASS

- `GET /` → **200**; title `Ridge Racer Type 4 // LAN Arcade`.
- `#playBrowserBtn` is visible, `href="/play"`, absolute `http://<host-lan-ip>:8080/play`.
- Clicking it navigated to `/play`; `window.__R4` present; status **RUNNING**; no navigation error.
- Screenshots: `_runtime/play-qa-19-landing.png`, `play-qa-20-landing-to-play.png`.

---

## Bugs, severity-ranked, with exact repro

### 1. Medium — already-connected gamepads are detected but never assigned; pad input is dead

**Impact:** A player who connects an Xbox/DualSense pad before opening `/play` sees it listed in Control Settings but the UI says “Not Connected”; pressing buttons does nothing. The only fix is to manually choose the pad in Control Settings. This breaks the normal “controller already connected” console flow.

**Repro:**
1. Connect an Xbox or DualSense pad (or mock `navigator.getGamepads` before navigation with a standard-mapping pad).
2. Open `http://<host-lan-ip>:8080/play`; wait for `RUNNING`.
3. EJS menu → **Control Settings**. The “Connected Gamepad” dropdown lists the pad, but its value is **Not Connected**.
4. Press Start on the pad → no game response; instrumented `simulateInput` count is **0**.
5. Select the pad in the dropdown, press Start again → input now reaches the core (**2** calls in QA).

**Evidence:** `play-qa-14-controller.png`, `play-qa-15-controller-mapped.png`, `_runtime/play-qa-result.json` → `controller.pressUnmapped=[]`, `controller.pressMapped=[...]`.

---

### 2. Medium — the “CLICK TO RACE” sound gate swallows the first keyboard input and leaves focus outside the emulator

**Impact:** The gate literally says “CLICK ANYWHERE OR PRESS START”, but pressing Enter/Start only dismisses the gate; the game does not receive that Start. `document.activeElement` remains `BODY`, and EJS listens on `#game .ejs_parent`, so keyboard input is dead until the player clicks the canvas a second time. On a keyboard-only or couch setup this looks like the game ignored Start.

**Repro:**
1. Open `/play`; wait for `RUNNING` and the `CLICK TO RACE` gate.
2. Click **CLICK TO RACE** (or press Enter to dismiss it).
3. Press Enter / ArrowDown / Enter.
4. Instrument `EJS_emulator.gameManager.simulateInput`: count is **0**; `document.activeElement` is `BODY`.
5. Click the game canvas once, then press the same keys: count becomes **6**, focus is `#game`, and the game advances.

**Evidence:** `play-qa-07-before-input.png` (before), `play-qa-08-after-input.png` / `play-qa-10-after-input-wait.png` (after canvas click); `_runtime/play-qa-result.json` → `input.caseA_gateOnly.inputCount=0`, `input.caseB_canvasClick.inputCount=6`.

---

### 3. Low — mobile header/footer overflow and clip at 390 px

**Impact:** The fullscreen header button is partly off-screen on a 390 px phone, and the footer timing/link is truncated. The page still works (document does not scroll horizontally; fullscreen is also available from the EJS menu), but the header/footer do not fit.

**Repro:**
1. Open `/play` at 390×844, touch enabled.
2. Inspect `document.body.scrollWidth` → **447** while `documentElement.clientWidth` is **390**.
3. `#fsBtn` rect: `x=341.25, w=106.19` → right edge **447.4**; only the leading part of “FULLSCREEN” is visible.
4. Footer text ends with `… BOOT 0.9s LAN ARC…` (clipped by `overflow:hidden` + `white-space:nowrap`).

**Evidence:** `play-qa-16-mobile.png`; `_runtime/play-qa-result.json` → `mobile.layout.bodyScrollW=447`, `mobile.layout.fsBtn`.

---

### 4. Low — sound gate is shown even when the AudioContext is already running

**Impact:** On a browser where WebAudio is already `running` (this headless run, or a user with permissive autoplay), the gate still covers the game for up to 3.5 s (12 s if the code thinks audio is not live). It is an unnecessary obstruction; the code only uses `audioLive` to shorten the timeout, not to skip the gate.

**Repro:**
1. Open `/play`; wait for `RUNNING`.
2. Before any gesture, evaluate `EJS_emulator.Module.AL.currentCtx.audioCtx.state` → `"running"`.
3. Observe `#soundGate` visible with `CLICK TO RACE` anyway.

**Evidence:** `_runtime/play-qa-result.json` → `audio.before.contexts[0].state="running"`, `audio.gateBefore.hidden=false`.

---

### Info — Rage Racer is no longer “ROM pending”

`rage-racer.chd` (495,297,808 B) now exists; the selector option is `Rage Racer` with no `(ROM pending)` suffix, and `?game=rage` boots to `RUNNING` in ~3.36 s. This contradicts the stated coverage expectation but is not a crash. If the product still wants a pending state, the manifest/asset changed underneath the spec.

### Info — COOP console error on plain-HTTP LAN

Chrome logs one error: `Cross-Origin-Opener-Policy header has been ignored... untrustworthy origin`. The `/play` route sets COOP/COEP, but browsers ignore them on plain HTTP LAN. `crossOriginIsolated=false`, `threads=false`; the app already defaults threads off there. No functional impact observed. If a zero-console-error requirement is strict, serve `/play` over HTTPS or localhost, or treat this as an accepted LAN-HTTP warning.

---

## Screenshot index (`_runtime/`)

| File | Shows |
|---|---|
| `play-qa-01-loading.png` | `/play` loading overlay on the LAN origin |
| `play-qa-02-intro.png` | PSX boot (legitimately black) after start |
| `play-qa-03-title.png` | Actual Namco boot logo (title frame) |
| `play-qa-07-before-input.png` | Namco logo before keyboard test |
| `play-qa-08-after-input.png` | RR4 intro movie after canvas click + Enter/arrows |
| `play-qa-10-after-input-wait.png` | Actual RR4 “PRESS START BUTTON” title screen |
| `play-qa-11-fullscreen.png` | Browser fullscreen via `#fsBtn`, floating EXIT FULLSCREEN |
| `play-qa-12-reload.png` | Second load; footer `ROM 341 MB · CACHED · BOOT 2.0s` |
| `play-qa-13-selector-rage.png` | Rage Racer selected, `RUNNING`, 472 MB CHD |
| `play-qa-13b-selector-rage-frame.png` | Rage Racer Namco frame (boots, no crash) |
| `play-qa-14-controller.png` | Control Settings: both pads listed, value “Not Connected” |
| `play-qa-15-controller-mapped.png` | Manual Xbox mapping selected |
| `play-qa-16-mobile.png` | 390×844: canvas + virtual pad; fullscreen button/footer clipped |
| `play-qa-17-mobile-after-touch.png` | After real touch on virtual Start |
| `play-qa-18-mobile-game-1.png` | Pure mobile canvas frame (Namco logo; pad hidden for sampling) |
| `play-qa-19-landing.png` | `/` landing with PLAY IN BROWSER |
| `play-qa-20-landing-to-play.png` | Landing → `/play` navigation |

---

## Reproduce

```powershell
cd _server
# server already running on <host-lan-ip>:8080 with:
#   RR4_NO_AUTOSTART=1 RR4_STREAM_SOURCE=test
node test-play-qa.mjs
```

The harness creates a fresh browser profile, clears only `_runtime/play-qa-*.png`, writes `_runtime/play-qa-result.json`, and never touches `public/play.html`, `public/js/play.js`, `public/css/play.css`, or `src/server.js`.

---

## Pass 2 — multi-disc 2P lounge (2026-11-06)

**Date:** 2026-11-06
**Origin under test:** throwaway cabinets — `http://127.0.0.1:8097` (`/mp` + manifest), `http://127.0.0.1:8093` (two browsers) and `http://127.0.0.1:8094` (Rage host boot)
**Server:** spawned and killed by each harness (`RR4_NO_AUTOSTART=1` on the non-8080 ports); the live `:8080` is untouched
**Browser:** puppeteer-core, Brave/Chrome, two contexts (host + guest) for the lounge; one context for the Rage host path; desktop 1440×900 and mobile 390×844
**Method:** read-only against the app; harnesses `_server/mp-games-probe.mjs`, `_server/test-mp-games-ui.mjs` and `_server/test-mp-shared-car.mjs`
**Contract:** `_server/public/mp-games.json` (ids 4/5/6, tracks 8/4/1, cars 8/4/4)

### Verdict

**16/16 transport checks, 32/32 UI checks and 14/14 Rage host checks PASS.**
R4's existing suites are unchanged and green (22/22 raw `/mp`, 33/33 lounge UI).
The Rage core now boots under the host harness and the `player 1 → 0` remap
installs; a **live shared-car drive** is still not covered, so Rage/Ridge stay
`netplay transport; in-game mode unverified`.

| # | Coverage item | Verdict |
|---|---|---|
| 1 | `/mp-games.json` served, `version`/`defaultGame`/three keys, per-disc ids and arrays (8/8, 4/4, 1/4) | **PASS** (16/16 probe) |
| 2 | Per-disc roll from the manifest (rage 4 courses + 4 cars, ridge 1 course + 4 cars) | **PASS** |
| 3 | `create {game}` defaults to `r4`; invalid key falls back; guest adopts the room's disc | **PASS** |
| 4 | Host-only `setgame` before the grid locks; guest and post-lock `setgame` rejected | **PASS** |
| 5 | R4 `race` payload shape unchanged (legacy probe 22/22) | **PASS** |
| 6 | DISC selector: RAGE/RIDGE switch the mode hint to `SHARED CAR · One car - both pads drive it` | **PASS** (G01, G25) |
| 7 | Room card + room-list badge show the disc and mode on both seats | **PASS** (G02–G04, G19, G21) |
| 8 | Host can change the disc in the room; the guest follows; guest selector disabled | **PASS** (G05–G09) |
| 9 | Overlay reads `SHARED CAR // BOTH PADS DRIVE` with exactly one `SHARED // <car>` line | **PASS** (G10–G13, G20) |
| 10 | Both `/play-net` handoffs carry `game=rage` / `game=ridge` with matching room/race/track/car params | **PASS** (G15–G18, G20) |
| 11 | R4 regression: VS BATTLE card, two P1/P2 car lines, `game=r4`, track index 0–7 | **PASS** (G21–G24) |
| 12 | `?game=ridge` deep link preselects; `rr4.mp.game` persists across reload | **PASS** (G25, G26) |
| 13 | 390×844: start card and room card have no horizontal overflow | **PASS** (G27, G28) |
| 14 | Rage host path: real core boots, `macro:manual`, plan clamp, `RAGE-` room, `2P SHARED` brand, remap installs and counts a player-1 press | **PASS** (14/14 host-only; no guest/live drive) |

### QA steps (manual, two browsers)

1. **DISC selector.** Open `/multiplayer` (or `/` → ENTER → 2P LOUNGE). The
   start card has a DISC selector defaulting to R4; choose **RAGE RACER** and the
   hint must read `SHARED CAR · One car - both pads drive it`. Reload: the choice
   persists. Open `/multiplayer?game=ridge` and confirm RIDGE is preselected.
2. **Create/join.** Host: **CREATE ROOM** (4-character code). Guest: join the
   code (or the room list). Both room cards and the guest's room-list badge show
   the same disc + `SHARED CAR`.
3. **Host disc swap.** In the room, the host selector is enabled; change to
   RIDGE and confirm both cards update. The guest selector is disabled — a guest
   cannot change the disc. After both READY the selector is gone/disabled.
4. **READY/GO.** Both press READY. The overlay on both seats reads
   `SHARED CAR // BOTH PADS DRIVE`, one course line and one car line
   (`SHARED // <car>`), never `P1 … · P2 …`.
5. **Handoff `game=`.** Watch the `/play-net` request (or the iframe URL): it
   must carry `game=rage|ridge`, the same `mpRoom`/`mpRace`, `mpTrackIndex` in
   range (rage 0–3, ridge 0) and both `mpCar*` indices.
6. **Shared-car drive (manual; host path harness-covered, live drive not).**
   The 14/14 host harness proves the Rage core boots, `mpRun()` enters
   `macro:manual`, the plan clamps to 4/4 and the remap installs. In the manual
   QA the host starts a normal **single-player** race by hand (no macro runs).
   The guest is live from boot and its pad drives the host's car; the chip shows
   `GUEST P2 SHARED` until it joins, then `GUEST P2 LIVE`, and the brand says
   `2P SHARED`. Record the result; until a live drive is captured the label
   stays `netplay transport; in-game mode unverified`.
7. **R4 regression.** Back to the DISC selector → R4: the card reads
   `RIDGE RACER TYPE 4 // VS BATTLE`, the overlay keeps `GRID LOCKED` and two car
   lines, the handoff carries `game=r4` with a track index 0–7, and the R4 macro
   still starts the split-screen race.
8. **Guest adoption.** Reload the guest tab with a different `?game=` than the
   room: once joined, the room's disc wins (the guest's own key is ignored).

### Harness commands

```powershell
cd _server
node mp-games-probe.mjs        # 16/16 -> _runtime/mp-games.json (spawns :8097)
node test-mp-games-ui.mjs      # 32/32 -> _runtime/mp-games-ui.json + mp-games-*.png (:8093)
node test-mp-shared-car.mjs    # 14/14 host-only -> _runtime/mp-shared-car.json (:8094)
# R4 regressions (unchanged):
node mp-ws-probe.mjs           # 22/22 -> _runtime/mp-lobby-ws.json
node test-mp-lobby-ui.mjs      # 33/33 -> _runtime/mp-lobby-ui.json
```

Screenshots: `_runtime/mp-games-lounge-host.png` (1440×900 lounge, RAGE),
`_runtime/mp-games-lounge-mobile.png` (390×844),
`_runtime/mp-games-grid-rage.png`, `_runtime/mp-games-grid-ridge.png`.

### Limits and known gaps

- The first two harnesses **hold `/play-net`** by request interception, so no
  disc downloads and no core boots there. `test-mp-shared-car.mjs` does boot the
  real Rage core, but with one browser and no guest: the manual stage and remap
  install are proved; a **live** shared-car drive is not.
- No automatic macro exists for Rage/Ridge and no menu/lap address is documented
  for them; the host starts the race by hand.
- R4's 6/6 macro and 40/40 two-browser race remain **R4-only** evidence.
- Guest netplay audio is still absent (video-only stream), and the operator
  two-machine run is still R4-only.

---

## Pass 3 — ghost replay, Route A (Rage/Ridge, 2026-11-06)

**Date:** 2026-11-06
**Origin under test:** throwaway cabinets — the ghost engine on its own port
(`:8096`, walking to the next free port; the recorded run used
`http://localhost:8097`) and the lounge on `http://127.0.0.1:8093` (an earlier run
used `:8094`; `--port`/`--base` override)
**Server:** spawned and killed by each harness (`RR4_NO_AUTOSTART=1`); the live
`:8080` is untouched; the `:3010` relay was down for the engine run (only the
host page retries its room)
**Browser:** puppeteer-core, Brave/Chrome; one visible page at a time for the
engine run (EmulatorJS stops drawing in a hidden tab), two contexts for the lounge
**Method:** read-only against the app; harnesses
`_server/test-mp-ghost-replay.mjs` (engine) and
`_server/test-mp-ghost-lobby.mjs` (lounge/rematch)
**Design + probes:** `_runtime/ghost-research/` (`IMPLEMENTATION-A.md`,
`tape-probe.md`, `rage-finish-probe.md`)

### Verdict

**40/40 engine checks and 36/36 lounge checks PASS.** Both suites were re-run at
the end of the session (17:44 and 17:41 on 2026-11-06) with the same 36/36 and
40/40. R4's suites are unchanged and green (22/22 raw `/mp`, 33/33 lounge UI,
30/30 shell, 6/6 macro, 40/40 race).

Ghost mode's Route A is **turn-based with a post-race replay**, labelled
`ghost replay (sequential)`. Route B (Pass 4) adds the live ghost drawn on track
on Ridge's race screen and in Rage Grand Prix; Rage Time Attack stays replay-only.
The tapes in this pass are synthetic short runs.

| # | Coverage item | Verdict |
|---|---|---|
| 1 | R4: `#mDrive` disabled + `RAGE + RIDGE ONLY`, no drive/turn rows, invite unchanged and handoff `game=r4` with no `mpTurn` (the standalone page omits `mpGhost`; the shell emits `mpGhost=live`) | **PASS** (L01–L05) |
| 2 | RIDGE start card: LIVE → GHOST selector, ghost hint, `rr4.mp.drive` persistence | **PASS** (L06–L09) |
| 3 | Room card `DRIVE GHOST // TURN-BASED TIME TRIAL`, host `TURN HOST`, guest read-only, rooms-list `GHOST` badge on the ghost room only | **PASS** (L10–L15) |
| 4 | Host `TURN GUEST` moves both cards; GO overlay `DRIVER: GUEST` with exactly one `SHARED // <car> · DRIVER: …` line and no `BOTH PADS DRIVE` | **PASS** (L16–L18) |
| 5 | Both `/play-net` handoffs carry `game=ridge&mpGhost=ghost&mpTurn=guest` with an identical room/race/track/car plan | **PASS** (L19–L21) |
| 6 | Rematch: shell URL `drive=ghost&turn=host`, host recreates the same code, guest auto-joins, second handoff carries `mpTurn=host` | **PASS** (L22–L27) |
| 7 | LIVE regression: `DRIVE LIVE`, turn row hidden, `SHARED CAR // BOTH PADS DRIVE`, handoff `mpGhost=live` with no `mpTurn` | **PASS** (L28–L30) |
| 8 | 390×844: ghost start card and room card have no horizontal overflow, `?turn=guest` honoured | **PASS** (L31, L32) |
| 9 | Ridge: 161×40 tape staged in a zeroed BSS run, applier pointer `0x80080434` repointed, built-in replay reached (8→9), count never rewritten | **PASS** (R05–R07, R10) |
| 10 | Ridge: the live car pose equals the staged tape on every sampled frame (53–54 samples, 27 distinct playback frames) and a mirrored peer tape is what plays (322/322 samples, rendered frame changes) | **PASS** (R08, R09) |
| 11 | Ridge: IndexedDB `rr4-ghost` round-trip after a database reopen, both seats kept, byte hash equal | **PASS** (R12) |
| 12 | Rage: pad input reaches scene 12, the game tapes the run, capture clamps to a TA tape, the rival is stored and reloaded through the product | **PASS** (G02–G08) |
| 13 | Rage: `replayNow()` in scene 12 arms the RACE finish branch, the game enters scene 17 itself (12→17, no scene poke), `g_SceneTimer` and `g_Replay.read` advance | **PASS** (G09, G10, G12, G13) |
| 14 | Rage: replayed pose equals the tape (107/107 samples, 27 distinct frames) and a mirrored tape changes the frozen rendered frame | **PASS** (G14, G16, G17) |
| 15 | Turn gate: `turn=host` drops a player-1 press and passes player-0; `turn=guest` remaps player-1 to 0 and drops player-0; a ghost guest installs no local gate and is `raceLive` | **PASS** (R11, T01, S01) |
| 16 | `mpGhost=live` keeps the engine off (no capture, no gate, panel hidden) and R4 ignores `mpGhost=ghost` | **PASS** (L01, L02) |
| 17 | No uncaught page errors / unexpected console errors in either suite (the known ICE notice is allow-listed) | **PASS** (R13, G19, T02, P03, L33, L34) |

### QA steps (manual, two browsers)

1. **Pick the disc and the mode.** Open `/multiplayer` on both machines (or
   `/` → ENTER → 2P LOUNGE). Choose **RIDGE RACER** (or RAGE RACER); the start
   card's `DRIVE` control becomes enabled. Select **GHOST**: the hint must read
   `GHOST · TURN-BASED TIME TRIAL - THE RUN YOU FINISH BECOMES THE OTHER'S GHOST`.
   Reload — the choice persists. With **R4** selected the control is disabled
   with `RAGE + RIDGE ONLY`.
2. **Create/join and check the card.** Host **CREATE ROOM**, guest joins by code
   or from the list. Both cards must read `DRIVE GHOST // TURN-BASED TIME TRIAL`,
   the rooms list shows a `GHOST` badge on that room only, and the invite link
   carries `&drive=ghost&turn=…`.
3. **Turn is host-only.** The host switches `TURN GUEST` before the grid locks;
   the guest's selectors are read-only and follow the server frame. A guest
   attempt to change drive/turn must be rejected (server `error`).
4. **READY/GO overlay.** Both press READY. Both overlays must read
   `DRIVER: HOST` (or `DRIVER: GUEST`), with exactly one
   `SHARED // <car> · DRIVER: …` line and no `BOTH PADS DRIVE`.
5. **Handoff.** The `/play-net` request must carry `game=ridge|rage`,
   `mpGhost=ghost`, `mpTurn=<turn>`, the same `mpRoom`/`mpRace`, a valid
   `mpTrackIndex` (rage 0–3, ridge 0) and both `mpCar*`.
6. **Run 1 (host turn).** Only the host pad drives; a guest pad press does
   nothing (the host turn gate drops player 1). Finish/short-run the race. The
   panel logs `GHOST // CAPTURED host <n>f` and the tape is written to IndexedDB
   (`rr4-ghost` → `runs`).
7. **Replay.** On the results screen the other seat's tape must play full screen:
   Ridge shows **WATCH RIVAL** and reaches screens 8 → 9; Rage arms the race's own
   finish branch and enters scene 17. The label must read
   `ghost replay (sequential)` (chip prefixed `GHOST`), and the status must be
   `GHOST // REPLAY HOST RUN`, not a claim of a live car.
8. **Run 2 (rematch flips).** Click **REMATCH** on each tab: the shell reloads
   `/multiplayer?room=…&game=…&drive=ghost&turn=<opposite>`, the host recreates
   the same code, the guest auto-joins, and the second handoff carries the flipped
   `mpTurn`. Now the guest pad drives and the host's earlier run replays.
9. **LIVE regression.** Switch the room to `DRIVE LIVE`: the turn row disappears,
   the overlay returns to `SHARED CAR // BOTH PADS DRIVE` and the handoff is
   `mpGhost=live` with no `mpTurn`. Both pads still drive one car.
10. **R4 regression.** Select R4: `RIDGE RACER TYPE 4 // VS BATTLE`, two car
    lines, no `mpTurn`, and no `mpGhost=ghost`: the shell handoff carries
    `&game=r4&mpGhost=live` (the standalone lounge omits `mpGhost`), which keeps
    the engine off. The R4 macro still starts the split-screen race.
11. **Mobile.** At 390×844 the ghost start card and room card must not overflow
    horizontally and the `TURN` selector must honour `?turn=guest`.

### Harness commands

```powershell
cd _server
node test-mp-ghost-replay.mjs   # 40/40 -> _runtime/mp-ghost-replay.json (own :8096, walks)
node test-mp-ghost-lobby.mjs    # 36/36 -> _runtime/mp-ghost-lobby.json (own :8093/:8094)
# R4 regressions (unchanged):
node mp-ws-probe.mjs            # 22/22
node test-mp-lobby-ui.mjs       # 33/33
node test-shell-fs.mjs          # 30/30 (if the shell changed)
node test-mp-race-e2e.mjs       # 40/40
```

Screenshots: `_runtime/mp-ghost-lobby-host.png` (1440×900 ghost room),
`mp-ghost-lobby-overlay.png` (`DRIVER: GUEST` GO overlay),
`mp-ghost-lobby-mobile.png` (390×844), `mp-ghost-lobby-rematch.png`,
`mp-ghost-ridge-replay.png` / `-ridge-replay-b.png` (played-in versus mirrored
tape), `mp-ghost-rage-{menu,select,race,scene17,replay,frozen-a,frozen-b}.png`.

### Limits and known gaps

- The engine harness is **host-only**: one real core per disc, no guest GUI, and
  the relay was not needed. The turn gate is proved with synthetic pad presses,
  not by two humans.
- Tapes are **synthetic short runs**: Ridge 161 records built from the live pose
  (the applier cap before `0x8006E7BC`), Rage a short Time Attack run captured
  through the product (100 subframes / 50 samples) and stopped by the finish arm
  rather than by crossing the line. **No human lap** has been recorded, and Rage
  **GP** (`mode 1`) is untested.
- Ridge writes at the documented fixed base `0x8006CE7C` do not reach the
  applier, so the tape is staged in a zeroed BSS run with the pointer
  `0x80080434` repointed — that is the product path, not a test-only hack.
- The A replay is **sequential and post-race** in this pass: Route B (the live
  ghost drawn in-game) is Pass 4 below.
- The lounge harness **holds `/play-net`**, so it proves the selectors, plan and
  handoff, not a boot or a tape swap.

---

## Pass 4 — live ghost, Route B (Rage GP + Ridge race, 2026-11-06)

**Date:** 2026-11-06
**Origin under test:** a throwaway cabinet on `:8088` (`--port`/`--base`/
`LIVE_GHOST_BASE` walk to the next free port; the recorded run used
`http://localhost:8088`); `:8080` was up before and after and is re-probed by the
harness
**Server:** spawned and killed by the harness (`RR4_NO_AUTOSTART=1`); the `:3010`
relay was down (the host page only retries its own room, no guest joins)
**Browser:** puppeteer-core, headless Chrome, EmulatorJS 4.3.0-pre, one visible
real host core per disc
**Method:** read-only against the app; harness `_server/test-mp-live-ghost.mjs`
**Design + probes:** `_runtime/ghost-research/` (`live-ghost-probe.md`,
`ridge-live-ghost.md`, `ghost-tape.md`)

### Verdict

**36/36 PASS.** A still passes unchanged (40/40 engine, 36/36 lounge), and the R4
regressions stay green (22/22 `/mp`, 33/33 lounge UI, 6/6 macro, 40/40 race, 30/30
shell).

Route B is a **live ghost rendered in-game**: the peer tape is applied to a spare
rival car slot every frame and drawn by the game's own renderer. It ships for
**Ridge Racer 1994's race screen (screen 1)** and **Rage Racer Grand Prix** only;
Rage **Time Attack** has no rival-slot draw path (`draw-path-unverified`) and
falls back to Route A. The ghost is **drawn, not simulated** — no collision, no
shadow, no AI.

| # | Coverage item | Verdict |
|---|---|---|
| 1 | `mpLiveGhost=1` on a ghost room enables B and leaves A on (`live.enabled`, `ghost.enabled`) | **PASS** (A02) |
| 2 | Rage: the DrawCars-entry stub `0x801F4700` (324 B / 81 words) reads back byte-identical, zero before the write | **PASS** (A03) |
| 3 | Rage: the shipped `0x27BDFFD8` at `0x8003875C` is repointed to `0x0807D1C0` only inside the race and restored between scenes | **PASS** (A04) |
| 4 | Rage: the recorder `0x80036F4C` is **not** nop-ed — the game keeps recording its own arena | **PASS** (A05) |
| 5 | Rage: the tape switches to 48 B GP records in the second buffer; the enable word arms only on scene 12 | **PASS** (A06, A08, A08-armed) |
| 6 | Rage: `g_Cars[10]` `0x801F4194` carries `aiEnabled = 1` in every sample and both draw gates are forced per DrawCars call | **PASS** (A09) |
| 7 | Rage: enabling the ghost changes the rendered RACE frame far beyond the measured scene motion (1118 cells / 16.17 %, noise 0) | **PASS** (A11) |
| 8 | Rage: the ghost slot pose equals the tape record the stub applied, 16/16 samples | **PASS** (A10) |
| 9 | Rage: after the A/B the stub, patch and enable word are intact and the scene is still RACE | **PASS** (A12) |
| 10 | Rage: the player still drives (frames +145, car 298 units, `applied` 806 → 917, 0 page errors) | **PASS** (A13) |
| 11 | Ridge: the quiet-band stub `0x801EA610` (208 B / 52 words) reads back byte-identical, zero before the write | **PASS** (D02) |
| 12 | Ridge: `0x0C0092E3` at `0x80015014` is repointed to `0x0C07A984` only on the race screen and restored outside | **PASS** (D03) |
| 13 | Ridge: the tape lives in the free BSS run at `0x801E4840` (600 × 40 B = 24,000 B) | **PASS** (D04) |
| 14 | Ridge: the pad walk reaches a running race (screen 1, car active, screen counter past 200) and the enable word is 1 only there | **PASS** (D05, D06) |
| 15 | Ridge: slot 11 `0x801EDA10` carries both draw gates (+0x00 = 1, +0x58 = 1) and the staged tape drives the pose (placement sweep moves the slot) | **PASS** (D07, D08) |
| 16 | Ridge: the ghost slot pose equals the tape 16/16 and the frame delta is 846 cells / 12.24 % against an 83-cell noise floor | **PASS** (D08, D09) |
| 17 | Ridge: the stub, patch and enable word survive ~10 s of live ghost (band re-placed once by the guard) | **PASS** (D10) |
| 18 | The turn gate is unchanged with B on: `turn=host` drops P1 and passes P0, `turn=guest` remaps P1 → P0 and drops P0 | **PASS** (D11, B08) |
| 19 | `mpLiveGhost` absent → no stub, no patch, no LIVE row, and A still reaches its own replay (screen 9) | **PASS** (B01–B04) |
| 20 | `mpGhost=live` keeps B off; R4 ignores `mpLiveGhost=1` and the VS path is untouched | **PASS** (B05–B07) |
| 21 | No unexpected page or console errors; the spawned cabinet is killed and `:8080` is untouched | **PASS** (P02, P03) |

### How to check B by hand

1. Lounge: DISC **RAGE RACER**, DRIVE **GHOST**, both READY. The handoff must
   carry `&mpGhost=ghost&mpTurn=…&mpLiveGhost=1` (the shell appends it).
2. On `/play-net`, the netplay panel's GHOST block now has a **LIVE** row: `ON`,
   and a meta line `SYNTHETIC <n>f x <stride> B @ 0x…`.
3. Rage: start **GRAND PRIX** by hand. Status becomes `GHOST // LIVE (RAGE GP)`
   once the tape is staged and the race is up; a rival slot is drawn from the
   tape. Time Attack instead shows `GHOST // REPLAY (draw-path-unverified)`.
4. Ridge: start the normal race. Status becomes `GHOST // LIVE (RIDGE)` and the
   chip gains the `LIVE RIDGE` prefix.
5. Diagnostics: `window.__R4NET.live` (`.armed`, `.error`, `.tape`, `.applied`,
   `.loops`, `.resets`); toggle the row OFF for an A/B, or
   `window.__R4NET.live.setEnable(0)`.

### Harness command

```powershell
cd _server
node test-mp-live-ghost.mjs    # 36/36 -> _runtime/mp-live-ghost.json (own :8088, walks)
# regressions:
node test-mp-ghost-replay.mjs  # 40/40
node test-mp-ghost-lobby.mjs   # 36/36
node mp-ws-probe.mjs; node test-mp-lobby-ui.mjs; node test-mp-race-e2e.mjs
```

Screenshots: `_runtime/mp-live-ghost-rage-{off,on}.png` (Grand Prix, same camera),
`mp-live-ghost-ridge-{off,on}.png` (race screen, chase view) and
`mp-live-ghost-a-replay.png` (the A-only page reaching screen 9 with no LIVE row).

### Limits and known gaps

- **Drawn, not simulated:** a tape pose in a spare rival slot. No collision, no
  shadow, no AI, no second physics car.
- **Mode-gated:** Ridge's race screen and Rage **Grand Prix** only. Rage **Time
  Attack** is replay-only and must never be called a ghost car.
- **Host only:** the guest page reports `GHOST // REPLAY (guest-core)`.
- **Synthetic tapes** (Ridge 161 records for A / 600 for B; Rage a 240-subframe GP
  tape for B), no human lap.
- **RAM injection, not a patch:** one 4-byte word per disc plus a stub, restored
  after the run; another region or a revision needs re-verification.
- A short tape **loops** the cursor, so it repeats its motion rather than stopping.
