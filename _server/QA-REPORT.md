# QA Report — Ridge Racer Type 4 LAN Arcade

**Date:** 2026-11-04 (22:51–22:54 local)
**Tester:** QA subagent
**Scope:** Browser client, lobby/seats/chat, controller labels + masks, countdown, fullscreen, mobile layout, reconnect, test stream, button reachability.
**Method:** Puppeteer-core driving Brave headless against an isolated server on **:8093** with `RR4_NO_AUTOSTART=1` and `RR4_STREAM_SOURCE=test`. The native `Ridge_Racer_4_Recompiled.exe` was **not** launched.

---

## 1. Environment

| Item | Value |
|---|---|
| OS | Windows (win32) |
| Node | v24.10.0 |
| Browser | Brave `C:/Program Files/BraveSoftware/Brave-Browser/Application/brave.exe`, headless |
| Automation | `puppeteer-core` ^25.16.0 |
| Test server | `http://127.0.0.1:8093/` |
| Server env | `RR4_PORT=8093`, `RR4_NO_AUTOSTART=1`, `RR4_STREAM_SOURCE=test` |
| Stream fixture | `_runtime/capture-test.ts` — MPEG-1, **960x720**, looped by ffmpeg |
| Desktop viewport | 1440x1000 (second context 1280x900) |
| Mobile viewport | 390x844, `isMobile`, `hasTouch`, `deviceScaleFactor: 2` |
| Native game | Not started; `RR4_NO_AUTOSTART=1` |
| Console/page errors | **0** |
| Failed requests | **0** |

> The workspace was being edited concurrently by other agents during QA. These results apply to the stable snapshot below. Re-run `node test-web.mjs` after further edits.

### Tested snapshot

| File | Last write | SHA-256 |
|---|---|---|
| `public/css/style.css` | 22:44:21 | `223700255386F4FE01AFB7D7D7F0AC241590739DC863E82F76532430551E4BA4` |
| `public/index.html` | 22:44:33 | `B5022A41B8B55DD52C22BEF985F035E7C33C88428004AFEF908890517D793CF6` |
| `public/js/app.js` | 22:44:41 | `56F7385F57A8659787F261EFAB5847F5F8D3F629C1FA9328663844EB9C21FFFA` |
| `public/js/controls.js` | 22:39:42 | `1223048EDAD81CFC5F723D8900FF26622359B2CFCC2F912050CC6BBFC24F6A15` |
| `src/server.js` | 22:47:08 | `19B37931EE4E9DBF8D7433B27639F75A1ADA496A15A94FDAAEFB58F42C0DDCF9` |
| `src/room.js` | 22:14:59 | `655F1AB2F859888E2B80D7613018C667275E29E22A40F616ED462178FB58A229` |

---

## 2. Commands

Run the full suite (starts and stops its own test server):

```powershell
cd _server
node test-web.mjs
```

The script internally starts:

```powershell
$env:RR4_PORT="8093"
$env:RR4_NO_AUTOSTART="1"
$env:RR4_STREAM_SOURCE="test"
node src/server.js
```

It frees a stale listener on :8093, waits for `/api/health` and for `stream.bytesPerSec > 0`, runs the checks, then kills the server tree with `taskkill /PID <pid> /T /F`. A server exit code of `1` at the end is the expected forced `taskkill`, not a crash.

Screenshots are written to `<repo>\_runtime\qa-*.png`.

---

## 3. Result summary

**36 checks — 33 PASS / 3 FAIL.**

| Coverage | Checks | Result |
|---|---|---|
| 1. Landing, console errors, fullscreen button | 1.1–1.3 | 3 PASS |
| 2. Join, P1, ready, Xbox + DualSense, masks | 2.1–2.7 | 7 PASS |
| 3. P2 context, seat names, chat round-trip | 3.1–3.2 | 2 PASS |
| 4. START countdown 3/2/1/GO | 4.1–4.2 | 2 PASS |
| 4b. START during race (extra) | 4.3 | **1 FAIL** |
| 5. Fullscreen enter/exit | 5.1–5.2 | 2 PASS |
| 6. Mobile 390x844 | 6.1–6.6 | 6 PASS |
| 7. Refresh/reconnect | 7.1–7.2 | 2 PASS |
| 7b. Host continuity after reconnect (extra) | 7.3 | **1 FAIL** |
| 8. Test stream stats + canvas | 8.1–8.3 | 3 PASS |
| 9. Buttons reachable / fixed overlaps | 9.1–9.6 | 6 PASS |
| 9b. Toast vs touch deck (extra) | 9.7 | **1 FAIL** |

### Per-check detail

| ID | Check | Result | Evidence |
|---|---|---|---|
| 1.1 | Landing loads with join + fullscreen controls | PASS | join, top fullscreen, landing fullscreen all visible |
| 1.2 | No console/page errors on landing | PASS | 0 |
| 1.3 | Landing FULLSCREEN button clickable | PASS | `body.fs`, `document.fullscreenElement=HTML`, exit visible |
| 2.1 | Join with a name enters arcade | PASS | arcade visible |
| 2.2 | Take P1 shows correct seat + HUD | PASS | `P1 // QA P1`, `ARMED` |
| 2.3 | READY toggles to UNREADY | PASS | `UNREADY` |
| 2.4 | Xbox pad labels | PASS | pill `XBOX`, face `Y B A X`, ONLINE |
| 2.5 | Xbox Cross mask | PASS | press `0xBFFF`, neutral `0xFFFF` |
| 2.6 | DualSense labels | PASS | pill `PLAYSTATION`, face `△ ○ ✕ □`, ONLINE |
| 2.7 | DualSense Cross mask | PASS | press `0xBFFF`, neutral `0xFFFF` |
| 3.1 | P2 takes seat; both names correct | PASS | P1 view and P2 view show `QA P1` / `QA P2` |
| 3.2 | Chat round-trips both directions | PASS | P2→P1 and P1→P2 both received |
| 4.1 | START shows 3/2/1/GO | PASS | observed `["3","2","1","GO"]` |
| 4.2 | Overlay hides after GO, no crash | PASS | overlay hidden, 0 page errors |
| 4.3 | START during race does not re-run countdown | **FAIL** | second `3/2/1` countdown observed |
| 5.1 | Fullscreen enters (`body.fs`) + exit button | PASS | `fsClass=true`, exit visible, topbar hidden |
| 5.2 | Exit restores normal view | PASS | `fsClass=false`, exit hidden, topbar visible |
| 6.1 | Mobile landing no horizontal scroll | PASS | scrollWidth 390 / innerWidth 390 |
| 6.2 | Mobile fullscreen button fully visible | PASS | rect `x268 y9 → right378 bottom39` |
| 6.3 | Touch controls visible | PASS | `body.touch`, `display:grid`, 14 buttons |
| 6.4 | Mobile arcade no horizontal scroll | PASS | 390 / 390 |
| 6.5 | Mobile arcade fullscreen button fully visible | PASS | rect fully inside 390x844 |
| 6.6 | Mobile fullscreen `body.fs`, no horizontal scroll | PASS | 390 / 390 |
| 7.1 | Refresh keeps same clientId, reattaches P1 | PASS | `autoJoined=true`, same id, `P1 // QA P1` |
| 7.2 | No duplicate seats/viewers | PASS | server viewers 2, unique ids 2, P1/P2 intact |
| 7.3 | Host role stays with reconnecting host | **FAIL** | `youAreHost` true → false |
| 8.1 | Stream running, bytes/sec > 0 | PASS | source `test`, 376940 B/s, 2 viewers |
| 8.2 | Canvas 960x720 | PASS | canvas 960x720 inside `#screen` |
| 8.3 | Stream info panel live | PASS | `366 KB/S // 2 VIEWERS` |
| 9.1 | No overlapping fixed chrome, mobile fullscreen | PASS | fixed: exit button, stage bar, touch deck; no intersections |
| 9.2 | Desktop buttons reachable/uncovered | PASS | 13 checked, 0 bad |
| 9.3 | Desktop fixed chrome overlap | PASS | only `topbar` fixed; no overlap |
| 9.4 | Mobile buttons reachable/uncovered | PASS | 22 checked, 0 bad |
| 9.5 | Stage-bar buttons not obscured by touch deck | PASS | 0% covered |
| 9.6 | Tapping FULL SPLIT edge does not exit fullscreen | PASS | no overlap |
| 9.7 | Toasts do not cover touch deck in mobile fullscreen | **FAIL** | toast 366x39 overlaps touch deck; L2 hit-tests to `.toast.info` |

---

## 4. Console errors

No console errors, page errors, or failed requests during the run.

```
console/page errors: 0
request failures: 0
```

Server log tail was clean:

```
RIDGE RACER TYPE 4 LAN cabinet listening on :8093
autostart disabled (RR4_NO_AUTOSTART=1)
```

---

## 5. Screenshots

All under `<repo>\_runtime\`:

| File | Shows |
|---|---|
| `qa-landing.png` | Desktop landing, join panel, fullscreen controls, test stream preview |
| `qa-controller-xbox.png` | Controller modal with mocked Xbox pad, A/B/X/Y labels |
| `qa-controller-dualsense.png` | Controller modal with mocked DualSense, △/○/✕/□ labels |
| `qa-two-players.png` | P1 + P2 seats, chat |
| `qa-countdown.png` | Countdown overlay at “3” |
| `qa-fullscreen.png` | Desktop fullscreen with exit button |
| `qa-reconnect.png` | P1 reattached after refresh |
| `qa-mobile-landing.png` | 390x844 landing, no horizontal scroll |
| `qa-mobile-arcade.png` | 390x844 arcade with touch deck |
| `qa-mobile-fullscreen.png` | 390x844 fullscreen, exit button + stage bar + touch deck |
| `qa-mobile-final.png` | Final mobile state |

---

## 6. Bugs (severity ranked)

### BUG 1 — MEDIUM: PRESS START during a race re-runs the countdown and re-injects Start taps

**Repro**

1. Start the test server on :8093 and open `http://127.0.0.1:8093/` in Brave.
2. Join as `QA P1`, take P1, press **PRESS START**.
3. Wait for `3/2/1/GO` and for the room phase to become `race`.
4. Press **PRESS START** again (the button is still enabled and still labelled `PRESS START`).
5. Observe a second `3/2/1/GO` countdown.

**Expected:** START is ignored (or disabled) once the race phase has begun.
**Actual:** `startSequence()` runs again; after the second GO the server calls `game.tapStart(1)` and `game.tapStart(2)` again. In the real cabinet this injects Start key presses after the race has started and can pause or skip game menus.

**Evidence:** check `4.3` — “second 3/2/1 countdown observed”.
**Likely cause:** `src/server.js` `case 'start'` only guards `room.phase === 'countdown'`; it does not guard `race`. `public/js/app.js` leaves `#btnStart` enabled in race.

---

### BUG 2 — LOW/MEDIUM: Host role is permanently lost when the host refreshes/reconnects

**Repro**

1. Browser A joins first as `QA P1` (becomes host).
2. Browser B joins as `QA P2` in a separate context.
3. A takes P1.
4. Refresh A. The app auto-joins with the same `clientId` and reattaches to P1.
5. Check host state: A now has `room.youAreHost === false`; B sees the `RESTART CABINET` host action.

**Expected:** the reconnecting original host keeps (or reclaims) the host role, at least during the 20 s seat reservation window.
**Actual:** host ownership migrates to the other connected client and does not return when the original client rejoins.

**Evidence:** check `7.3` — `before=true after=false`; `7.1` confirms the same clientId reattached to P1.
**Likely cause:** `src/room.js` `disconnect()` reassigns `hostId` to another connected client; `join()` only claims host when `hostId` is empty or missing.

---

### BUG 3 — LOW: Toast notifications cover the touch deck in mobile fullscreen

**Repro**

1. Open the arcade on a 390x844 touch viewport and enter fullscreen (touch deck visible at the bottom).
2. From another client, take/retake a seat (or start a race) so the server broadcasts a toast.
3. Observe the toast at the bottom of the screen.

**Expected:** toasts sit above/below the touch deck without intercepting touches.
**Actual:** the toast spans 366x39 at `y=793` over the touch deck (`y=675…844`). Hit-testing the bottom `L2` button returns `.toast.info`, so shoulder-button taps are blocked while the toast is visible (3.8–5 s). The race-start toast is especially likely to appear during play.

**Evidence:** check `9.7` — `toastRect {x:12,y:793,w:366,h:39}`, `touchRect {y:675,h:169}`, `bottomButton:"L2"`, `bottomButtonCoveredBy:"toast info"`.
**Likely cause:** `.toasts` is `position:fixed; bottom:12px; z-index:120` with default pointer events; `body.fs .touch-controls` is also `position:fixed; bottom:0; z-index:120`, and the toast container appears later in the DOM, so it paints and hit-tests above the deck.

---

## 7. Regression watch / notes

- An earlier snapshot during this QA session had `EXIT FULLSCREEN` overlapping the `FULL SPLIT` button in mobile fullscreen; the tested 22:44 snapshot passes checks `9.1` and `9.6`.
- Test stream content is the fixture `capture-test.ts` (it visibly contains an unrelated desktop recording); this is expected in test mode, not an app defect.
- Gamepads were mocked through `navigator.getGamepads`; rumble hardware and real controller input were not exercised.
- No native cabinet was running, so native input injection, real race start, audio, and cabinet restart were not verified.
- `test-web.mjs` is self-contained: it starts/stops the :8093 server, captures screenshots, and returns exit code `1` when any check fails.
