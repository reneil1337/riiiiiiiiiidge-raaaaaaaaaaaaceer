You are picking up the Ridge Racer Type 4 cabinet at `<repo>` on Windows.

Read first, in this order:
1. `<repo>\AGENTS.md`
2. `<repo>\HANDOFF.md`
3. `<repo>\README.md` and `START-HERE.md`
4. `<repo>\docs\README.md`

Server state: `:8080` cabinet + `:3010` relay should be running. Verify:

```text
/ /welcome /games /multiplayer /play /play-net /lobby /docs/introduction /api/music
```

Do not kill processes another session is using without checking. `:8080` was
restarted on 2026-11-06 and serves the `/mp` heartbeat build; restart it again
after any future `/mp` edit, then re-probe.

Current UX:
- `/` always shows ENTER; refresh always returns to ENTER. The parent document owns the only audio element.
- ENTER plays the R4 intro ("You The One For Me") and opens `/welcome` (WELCOME TO RIDGE CITY).
- One top bar: the shell injects CSS into `/play*` iframes that hides `#play-bar`/`#play-foot`.
- The shell mirrors `F`/`Esc` from the iframe, so fullscreen works while the game has focus; the soundtrack ducks to ~22 % while a `/play*` view is active, and embedded `/play*` skips the second **CLICK TO RACE** gate.
- The guest's collapsed netplay chip shows `GUEST P2 LOCKED` / `P2 LIVE` plus the host's menu stage; `/docs` 301s straight to `/docs/introduction`.
- After a race, the **REMATCH** chip takes both seats back to the same lounge room (`?room=<code>&host=1|0`); the host recreates the code and the guest retries until it exists, then both just press READY again.
- Hub buttons: MACHINE CHECK `/games`, 2P LOUNGE `/multiplayer`, FIELD MANUAL; the shell bar adds PLAY, DOCS and LOBBY `/lobby`.
- `/multiplayer`: 4-character room code, four teams, launch gated on both READY. The server rolls one of the eight R4 courses **in in-game menu order** plus a preset car per driver (`D1–D4`, `G1–G4`) and sends both browsers the same plan:
  `/play-net?embedded=1&threads=0&mpRole=host|guest&mpRoom=<code>&mpRace=<raceId>&mpTrackIndex=0-7&mpCarHost=0-7&mpCarGuest=0-7`.
- `play-net.js` auto-hosts `R4-<code>` with password `raceId` (retry loop, visible stage log); the guest retries `/list` on the relay until that room exists. The host reads R4's menu selection byte `0x800AC801` before pressing buttons; the guest core is frozen and its input is gated until the host sends `race-live`.

Evidence already banked (do not redo blindly):

| Command (`cd _server`) | Result |
|---|---|
| `node test-mp-lobby-ui.mjs` | 33/33 two-browser lounge UI + identical handoff URL -> `_runtime/mp-lobby-ui.json` |
| `node mp-ws-probe.mjs` | 22/22 raw `/mp` handshake/transport, incl. app-level `pong` + server heartbeat ping on the restarted `:8080` -> `_runtime/mp-lobby-ws.json` |
| `node mp-macro-test.mjs` | 6/6 **host-only** real-R4 macro: RAM probe, VS Battle -> car P1 -> car P2 -> course, reaches `race:live`, final frame is the race -> `_runtime/mp-macro-evidence.json`, `_runtime/mp-macro-final.png` |
| `node test-mp-race-e2e.mjs` | 40/40 **two-browser** race, guest drives P2 -> `_runtime/mp-race-e2e.json` + `_runtime/mp-race-e2e-*.png` |
| `node verify-mp.mjs` / `--full` | runs the suites above in one table |
| `node mp-heartbeat-probe.mjs 8095` | 10/10 heartbeat / host promotion / stale rooms on a throwaway instance (console only) |

Remaining P0:
1. **Two physical machines.** The 40/40 two-browser race is two contexts on ONE host. Repeat with one wired and one Wi-Fi client on the real router. Guest audio is **absent** (video-only stream), so it is a fix item, not something to listen for.
2. **Docs rebuild** after page changes (`cd docs; npm run build`), then check `/docs`, `/docs/introduction`, `/docs/multiplayer/r4-2p` and the DOCS link from `/play`; `/docs/games`, `/docs/play` and `/docs/multiplayer` 301 to their first page.
3. **Restart `:8080`** after future `/mp` edits so the 20 s heartbeat, host promotion, room-list broadcasts, `ping`→`pong` and 5-minute stale-room sweep are actually served. The current process already has them.

Known evidence / RE data:
- Host macro: Down ×2 -> VS BATTLE -> car P1 (`Right` × carHost) -> car data -> AT/MT -> AT -> car P2 (player index 1, `Right` × carGuest) -> course (`Right` × trackIndex, wraps at 8) -> Circle.
- Car presses are paced against the pad-ack byte `0x800ABD9F`: retry `Right` until exactly `carIndex` steps land, because a busy host can swallow a press. The course list does not update that byte, so course presses use exact fixed pacing. Stage records keep `presses`/`delta`; `race-live` goes out 20 s after the course confirm.
- Course order (menu order): Helter Skelter, Wonderhill, Edge of the Earth, Out of Blue, Phantomile, Brightest Nite, Heaven and Hell, Shooting Hoops. Car order: `D1 D2 D3 D4 G1 G2 G3 G4`, reached with `Right` from the default `D1`; calibration shots in `_runtime/calib/`.
- EJS buttons: Cross 0, Circle 8, Select 2, Start 3, Up 4, Down 5, Left 6, Right 7.
- On the host, raw P2 input must use `EJS_emulator.gameManager.functions.simulateInput(1, index, value)`; `__R4NET.simulateInput` ignores the player argument.
- No in-game RANDOM; random must be external Left/Right navigation.
- Best R4 RE source: `github.com/tetrisgm/RidgeRacerType4Recomp` (partial symbols/seeds/docs). No full R4 decomp.
- Native `--debug-port` is compiled out; `recomp-net` is stubbed. Native `keybinds.ini` P2 is identical to P1 and `p2_device="none"`.

Known bugs:
- Two physical machines are still **unverified**; the 40/40 race uses two contexts on one host. Guest audio is absent (the netplay stream is video-only).
- Fullscreen shell button is wired and verified (`test-shell-fs.mjs` 30/30); it is no longer labeled untested.
- Docs intro has a non-fatal React #418 hydration warning (expected, not a failure).
- Soundtrack ducking to 22 % during a `/play*` view **is implemented** (`enter.js:72`, shell-fs A13/B14) — the old "no audio ducking" note is stale.
- Expected console noise: netplay `No ICE servers configured`, React #418 on `/docs/introduction`. COOP is sent on loopback/HTTPS only, so a plain-HTTP LAN has no COOP warning. Never claim 0 console errors.

Rules:
- Update `AGENTS.md` / `README.md` / `START-HERE.md` / docs in the same change.
- `cd docs && npm run build` after docs changes; verify `/docs` routes and the DOCS link.
- Never persist ENTER; refresh must always show the gate.
- Keep one top bar and the parent-owned audio; no second audio player in the iframe.
- Report exact files changed and test evidence, with scoped labels (6/6 host-only != 40/40 two-browser).

Start by verifying the live routes and re-running the 2P harnesses (lobby UI, `/mp`, macro,
e2e race) before adding more design.
