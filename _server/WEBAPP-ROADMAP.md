# R4 / Rage Racer native browser arcade — roadmap

Status as of 2026-11-05. One entry shell and three play paths:

- **`/` (shell)** — ENTER gate (parent audio) → **WELCOME TO RIDGE CITY**
  (`/welcome`), with `/games`, `/multiplayer` (2P LOUNGE), `/play`, `/docs` and
  `/lobby` inside the same iframe. Every refresh returns to ENTER.
- **`/play` (primary)** — native browser play with self-hosted EmulatorJS +
  PCSX-Rearmed. **Verified for Ridge Racer Type 4 and Rage Racer.**
- **`/play-net`** — EmulatorJS 4.3.0-pre LAN netplay, normally launched from the
  2P LOUNGE.
- **`/lobby` (fallback)** — the original host-streamed native cabinet.

## Done — shell and 2P lounge

| Area | State |
|---|---|
| `/` ENTER shell | Done; parent-owned audio, `/welcome` in `#rr4sFrame`, one top bar, refresh → ENTER |
| Hub and machine check | Done; `/welcome`, `/games`, `/play`, `/docs`, `/lobby` navigation |
| 2P LOUNGE (`/multiplayer`) | Done; 4-char code, teams, both-ready gate, server-side race roll |
| Race plan | Done; 8 R4 courses in in-game menu order, preset cars `D1–D4`/`G1–G4` |
| Shell handoff | Done; `/play-net?embedded=1&threads=0&mpRole=…&mpRoom=…&mpRace=…&mpTrackIndex=…&mpCarHost=…&mpCarGuest=…` |
| Rematch | Done; game-page **REMATCH** chip reloads `/multiplayer?room=<code>&host=1|0`, host recreates the code, guest retries `join`, second race starts (R01–R05) |
| `/mp` transport | Done; 20 s heartbeat, host promotion, room broadcasts, `ping`/`pong`, 5-min stale sweep |
| Lounge UI + handoff evidence | `harness-verified` 33/33 (`_runtime/mp-lobby-ui.json`) |
| Raw `/mp` evidence | `harness-verified` 22/22 (`_runtime/mp-lobby-ws.json`) |
| Host VS Battle macro | `harness-verified host-only` 6/6, reaches `race:live`, final-frame race check (`_runtime/mp-macro-evidence.json`) |
| Guest input gate | Implemented and exercised; guest `simulateInput` drops input until `race-live`, and the guest pad lands on the host as P2 |
| Two-browser race with guest driving P2 | `harness-verified two-browser` 40/40 (`_runtime/mp-race-e2e.json`); two contexts on one host, two physical machines unverified, guest audio absent |

## Done — native browser play (`/play`)

| Area | State |
|---|---|
| Self-hosted EmulatorJS 4.2.3 + PCSX-Rearmed | Done; `/emulator/data`, no CDN at runtime |
| Ridge Racer Type 4 | Done; `disc/r4.chd` (341 MB), boots to title/gameplay |
| Rage Racer | Done; `disc/rage-racer.chd` (495 MB, 17 tracks), boots |
| ROM serving | Done; `/rom` with HEAD/Content-Length, Range/206, immutable cache, CORS |
| BIOS | Done; OpenBIOS default; PCSX-Rearmed falls back to HLE; no retail BIOS required |
| Caching | Done; `EJS_CacheLimit=1 GiB`; second load skips `/rom` GET |
| Fullscreen | Done on standalone `/play` (header button, `F`, floating exit, `body.fs`) and in the shell (button, `F`, exit control, bar hidden, iframe fills; `test-shell-fs.mjs` 30/30) |
| Audio | Done; click-to-race gate resumes the core audio context |
| Controllers | EmulatorJS Gamepad API (Xbox/PlayStation), keyboard, touch, remapping |
| Save states | EmulatorJS browser-side save/load |
| Game picker | Done; R4 + Rage Racer, `?game=r4` / `?game=rage` |
| Landing integration | Done; **PLAY IN BROWSER** primary, host stream labeled fallback |
| Netplay | Done; `/play-net` on pinned 4.3.0-pre + self-hosted relay on 3010; launched from the 2P LOUNGE |

## Done — host-stream fallback (`/lobby`)

| Area | What is in the code |
|---|---|
| Serving | Express HTTP + `ws` on one port; `/api/status`, `/api/health`. |
| Lobby | P1/P2 seats, spectators, names, READY, host role, countdown, host restart. |
| Reconnect | Stable client ID, seat reclaim grace, host continuity after refresh. |
| Input | Keyboard, Xbox/PlayStation Gamepad API, touch; native keyboard-pad relay. |
| Video/audio | ffmpeg client-area capture, MPEG-TS/jsmpeg, WASAPI loopback MP2, video-only fallback. |
| Modes | Managed launch, test mode, attach mode. |
| Operations | `start.bat`, `start-test.bat`, `stop.bat`, `firewall.bat`, QR maker. |

## Done — LAN netplay (R4 2P)

The self-hosted relay, the 4.3.0-pre client, and the lounge handoff are wired.
A one-click **REMATCH** returns both seats to the same lounge room for another
race (`?room=<code>&host=1|0`; the host recreates the code, the guest retries).
See `NETPLAY-INTEGRATION.md` for commands, the `/mp` message table, heartbeat,
macro steps and scoped evidence labels. Do not promote the host-only macro
result to "2P works": the two-browser 40/40 race is the 2P proof, and it is two
contexts on one host.

## Proposed next

| # | Item | Priority | Notes |
|---|---|---|---|
| 1 | Two physical machines + guest audio | P0 | The two-browser race is 40/40 on one host; repeat with one wired and one Wi-Fi client on the real router. Guest audio is absent (video-only stream), so it needs an RWebAudio tap, not a listening test. |
| 2 | Standalone `/multiplayer` plan params | Done 2026-11-05 | It now carries `mpTrackIndex`/`mpCar*`, so `/play-net` keeps the rolled plan outside the shell. |
| 3 | Shell fullscreen | Done 2026-11-06 | Button + `F` + exit control wired; `test-shell-fs.mjs` 30/30 (bar hidden, iframe fills, mobile). Headless Esc is browser-limited. |
| 4 | Docs hydration warning | P2 | `/docs/introduction` logs React #418 in the embedded shell; the page renders. |
| 5 | Play-page lobby/seat integration | P2 | Carry names/chat/seat state into `/play` outside the lounge; optional room codes. |
| 6 | HTTPS option | P2 | Self-signed TLS enables `SharedArrayBuffer`/threaded core; document the warning. |
| 7 | CHD cache polish | P2 | Verify browser quota behavior for all three CHDs; show a cache-clear control. |
| 8 | Controller presets | P2 | Ship R4/Rage keyboard + Xbox/PS defaults in `EJS_defaultControls`. |
| 9 | Rage Racer PC WASM | P3 | Investigate `khasinski/rage-racer-pc` Emscripten build for the modern renderer; PSX Rage is playable now. |
| 10 | Automated CI | P2 | API/WS tests, lounge UI, macro smoke, headless `/play` boot. |
| 11 | Native 2P input defaults | P3 | `RidgeRacer4Recomp/keybinds.ini` maps P2 identically to P1, and `RidgeRacer4Recomp/settings.toml` has `p2_device = "none"`. The LAN copy in `_server\game\` overrides both. |

## Non-goals

- Rebuilding the recompiled game with `recomp-net`; the release's netplay is
  compiled out.
- Replacing EmulatorJS with a custom PS1 emulator.
- Shipping game data to the public internet; the disc stays on the host and is
  served to the LAN.
