# LAN netplay integration — EmulatorJS 4.3.0-pre

**Status: transport wired and `harness-verified`; the two-browser race (guest P2)
is `harness-verified two-browser` on one host.**

| Scope | Result |
| --- | --- |
| Relay + WebRTC + guest input as player 2 | **21/21** core checks, run twice (new `:8090` server and live `:8080` server). No page errors; `No ICE servers configured` is expected. COOP is not: the header is now sent on loopback/HTTPS only, so a plain-HTTP LAN origin logs no COOP warning. |
| 2P LOUNGE UI + handoff (`test-mp-lobby-ui.mjs`) | `harness-verified` **33/33**. Lobby UI only: the harness holds the `/play-net` document, so it does not prove the emulator boots. |
| Raw `/mp` transport (`mp-ws-probe.mjs`) | `harness-verified` **22/22**; the saved run is against the restarted `:8080` and records the app-level `pong` plus a server heartbeat ping. |
| Host VS Battle macro (`mp-macro-test.mjs`) | `harness-verified host-only` **6/6**; real R4 boot to `race:live`, split-screen, no guest, plus a final-frame check that the last capture is the race (yellow menu fraction 0). |
| Two-browser race, guest drives P2 (`test-mp-race-e2e.mjs`) | `harness-verified two-browser` **40/40** - `_runtime/mp-race-e2e.json` has `summary.failed === 0`. Two browser contexts on one host; two physical machines remain unverified and guest audio is absent (video-only stream). |

An earlier *doc-only* expanded netplay run reported 33/33 on a different suite
from the lounge UI; its harness and result file are not checked in.

The stable single-player page keeps **EmulatorJS 4.2.3** at `/play`. LAN
netplay is a **parallel mode on the same origin** using the pinned
**EmulatorJS 4.3.0-pre** nightly snapshot:

| URL | What it serves |
| --- | --- |
| `/play-net` | Canonical netplay page, 4.3.0-pre from `/emulator43/data/` |
| `/play?netplay=1` | Same netplay document (alias of `/play-net`) |
| `/play-net.html` | Same page through the generic static handler (works before a server restart) |
| `/play` | Stable single-player, 4.2.3 from `/emulator/data/` |
| `/emulator43/data/` | Pinned 4.3.0-pre nightly snapshot (`_server/netplay/ejs-data-nightly/`) |
| `/emulator/data/` | 4.2.3 snapshot (unchanged) |

The **MULTIPLAYER** button in the `/play` header and the **MULTIPLAYER (2P LAN)**
footer link open `/play-net.html`. The `.html` alias is deliberate: it also
works through `express.static(public)` if the server process was started before
the `/play-net` route was added. A junction at `public/emulator43/data` →
`_server/netplay/ejs-data-nightly` lets that older process serve the 4.3 data
too. `public/play-net/index.html` adds a static redirect so `/play-net` also
works through an older `express.static(public)` process, and `play.html`
redirects `?netplay=1` to `/play-net.html` when it is served statically.
Restart `:8080` once to pick up the native `/play-net` and `/play?netplay=1`
routes.

**4.2.3 netplay is still broken upstream.** Do not claim it works. 4.3-pre is
the netplay client; 4.2.3 remains the single-player client.

---

## 1. Exact URLs for two machines

The normal path is **`/` → ENTER → 2P LOUNGE**, which hands both browsers to
`/play-net` with the rolled race (see §4.1). The direct URLs below are the
manual/debug entry and still work on their own.

Use the **same LAN origin on both machines**, including the port:

```
http://<host-lan-ip>:8080/play-net
```

Equivalent:

```
http://<host-lan-ip>:8080/play?netplay=1
```

Single-player (unchanged, 4.2.3):

```
http://<host-lan-ip>:8080/play
```

Do **not** mix `http://localhost:8080/play-net` on one machine with
`http://<host-lan-ip>:8080/play-net` on the other. Room discovery sends
`domain: window.location.host`; those are different domains. Use the LAN IP on
both sides. If the address is not current, run `ipconfig` or open
`http://localhost:8080/api/status` and use one of the advertised URLs.

Optional URL parameters (same as `/play` where applicable):

| Parameter | Effect |
| --- | --- |
| `?game=r4` | Ridge Racer Type 4 (default; `EJS_gameID=4`) |
| `?game=rage` | Rage Racer (`EJS_gameID=5`) |
| `?bios=hle` | HLE BIOS instead of OpenBIOS |
| `?netserver=http://host:3010` | Override the relay URL |
| `?threads=1` / `?threads=0` | Force threaded / non-threaded core |

---

## 2. Start and stop

### Main web app (port 8080, foreground)

```bat
cd /d "<repo>\_server"
start-test.bat
```

`start-test.bat` is the normal choice for browser play and the lounge: no native
game, and the test stream feeds the `/lobby` fallback. Use `start.bat` only when
you also want the native cabinet for the `/lobby` fallback.

Restarting either script is also how the long-running `:8080` process picks up
server changes such as the `/mp` heartbeat; the running process keeps its old
build until then.

Both scripts now start the relay automatically on **TCP 3010** in a separate
minimized window unless something is already listening there. Set
`RR4_NO_NETPLAY=1` before launching to skip it and print a reminder instead.
The main server still runs in the foreground window.

### Netplay relay (TCP 3010)

The launchers normally do this for you. To run it manually in its own window:

```bat
cd /d "<repo>\_server"
start-netplay.bat
```

`start-netplay.bat` changes into `_server\netplay`, runs `npm install` once if
`node_modules` is missing, then starts the official Node relay with
`PORT=3010`, `HOST=0.0.0.0`.

Checks:

```text
http://127.0.0.1:3010/health
http://localhost:3010/health
http://127.0.0.1:3010/list?domain=<host-lan-ip>:8080&game_id=4
```

Expected `/health` body (fields vary with uptime):

```json
{"ok":true,"service":"rr4-netplay","upstream":"EmulatorJS/EmulatorJS-Netplay@main server.js","port":3010,"uptimeSec":0,"rooms":0,"players":0}
```

### Stop

```bat
cd /d "<repo>\_server"
stop.bat
```

`stop.bat` now stops the native cabinet, the process on 8080, **and** the relay
on 3010. `stop-netplay.bat` stops only the relay.

---

## 3. Firewall (once, UAC)

Right-click **`_server\firewall-netplay.bat`** → **Run as administrator**, or:

```bat
cd /d "<repo>\_server"
firewall-netplay.bat
```

It adds/updates inbound **TCP 3010** for **all profiles (Domain, Private,
Public)**. This matters because the WLAN adapter is often classified
**Public**; a Private-only rule silently blocks guests. It matches the working
`RR4 Netplay 3010 (Any)` rule. The script also opens the old 3011 harness port
on Private.

No router port-forward is needed for same-subnet LAN play. WebRTC media uses
ephemeral UDP between the browsers, not the relay; allow Brave/Chrome on
Private/Public networks if Windows prompts. For play beyond one subnet, forward
TCP 3010 and add STUN/TURN.

---

## 4. Host / guest flow

### 4.1 Shell path (2P LOUNGE) — the normal way

1. Both players open **`/`**, press **ENTER** (the audio gesture), and take
   **2P LOUNGE** from **WELCOME TO RIDGE CITY** (`/welcome`). The direct URL is
   `/multiplayer`.
2. One player creates a room; the code is **4 characters**. The other joins by
   code or from the room list.
3. Both drivers press **READY**. Nothing boots before that; the server rolls the
   grid only when both sockets are ready and broadcasts the same `race` payload
   to both.
4. The shell counts 3-2-1-GO and loads `/play-net` in the same iframe:

   ```text
   /play-net?embedded=1&threads=0&mpRole=host|guest&mpRoom=<code>
             &mpRace=<raceId>&mpTrackIndex=0-7&mpCarHost=0-7&mpCarGuest=0-7
   ```

   `enter.js` parses the `rr4-race` postMessage and keeps those parameter names;
   `play-net.js` reads exactly those. The shell injects CSS into the `/play*`
   iframe to hide `#play-bar` / `#play-foot`, so there is one top bar.
5. The host auto-hosts **`R4-<code>`** with password **`raceId`** (15 attempts,
   visible stage log) and starts the macro when the relay shows 2 players and an
   open data channel. The guest retries `/list` (45 attempts) until the exact
   `R4-<code>` room appears, then joins with the same password.

   The relay `/list` is filtered by `game_id` and capacity, so the exact-name
   match is done client-side in `play-net.js`.

6. The guest core is frozen; the host is authoritative. Do not expect the guest
   to run menus or the race locally.
7. **Rematch (one click).** The game page's **REMATCH** chip posts
   `{type:'rr4-rematch', code, role}` to the shell; the shell reloads
   `/multiplayer?room=<code>&host=1|0&embedded=1`. The host recreates the same
   code — the server reclaims it when the old room only holds dead sockets, so a
   rematch does not roll a new room name — and the guest retries `join` every 2 s
   until it exists. Both press READY for a new server plan and `raceId`.
   `test-mp-lobby-ui.mjs` covers this as R01–R05, including a second race start.

**Fixed 2026-11-05:** the standalone `/multiplayer` page (opened outside the
shell) now appends the same `mpTrackIndex`/`mpCarHost`/`mpCarGuest` as the shell
handoff, so `play-net.js` keeps the rolled plan there too. The shell's **2P
LOUNGE** remains the supported entry.

### 4.2 Manual path (`/play-net` panel) — the fallback

The netplay panel on `/play-net` explains this in the UI:

1. **Host** opens the LAN URL, waits for the emulator and relay pill
   (`RELAY OK :3010`), enters a player name and room name, then clicks
   **CREATE ROOM**.
   * The host machine runs the PSX core.
   * The host streams its canvas + audio to the guest over WebRTC.
   * The host is authoritative; keep the host tab in the foreground.
2. **Guest** opens the **same origin** URL, enters a name, waits for the room
   to appear under **JOIN A ROOM**, and clicks **JOIN**.
   * The guest receives the host's streamed R4 picture.
   * The guest's pad/keyboard input is sent to the host as player 2.
   * **DLSS 5:** the guest applies the visual grade to the received 2D netplay
     canvas; the host canvas is left raw (filtering the 4.3 WebGL canvas can
     composite black). See `DLSS5.md`.
3. The panel collapses after joining and a small chip shows
   `HOST · <room>` or `GUEST · <room>`.
4. Click the chip to reopen the panel, then **LEAVE ROOM** to disconnect.
5. **EJS NETPLAY MENU** opens EmulatorJS's built-in netplay UI as a fallback.

Room discovery rules:

* Same page origin (including port) is simplest. The relay's `/list` filters by
  `game_id` and capacity, not by domain, and `join-room` does not check the
  domain, so a `localhost` host and a LAN-IP guest can still meet on the same
  `:3010`.
* Same numeric `EJS_gameID` (4 for R4, 5 for Rage Racer, 6 for Ridge 1994).
  This is the rule the relay actually enforces.
* No password is set by the panel's **CREATE ROOM**; the built-in EJS menu can
  set one. The shell's auto-host uses the rolled `raceId` (see §4.1).
* A full room (`current === max`) disappears from `/list`; that is upstream
  behavior.

For an actual **2-player race**, use **Ridge Racer Type 4**. R4 has the
two-player split-screen mode. Rage Racer and the original Ridge Racer are
single-player titles: a netplay guest sees the host's stream and can send
input, but there is no second car.

---

## 5. Client configuration

`public/js/play-net.js` selects the title from the same `GAMES` manifest as
`/play` (`?game=r4|rage|ridge`, default R4) and sets:

```js
window.EJS_pathtodata = '/emulator43/data/';
window.EJS_gameID = game.id;                            // 4 r4, 5 rage, 6 ridge
window.EJS_netplayServer = `http://${location.hostname}:3010`;
window.EJS_netplayICEServers = [];                      // LAN host candidates
window.EJS_Buttons = { netplay: true };
```

It also reuses the single-player disc/BIOS/filter/fullscreen/gamepad behavior:

* `EJS_core = 'psx'` → `pcsx_rearmed`
* `EJS_gameUrl = '/rom/r4.chd'` (R4), `/rom/rage-racer.chd` (Rage Racer) or
  `/rom/ridge-racer.chd` (Ridge 1994)
* `EJS_biosUrl = '/bios/openbios.bin'`, or HLE with `?bios=hle`
* `EJS_threads` is off by default (the 4.3 netplay path was verified with the
  non-threaded core); `?threads=1` requires a secure, cross-origin-isolated
  document
* filters, click-to-race/audio unlock, fullscreen/F, gamepad auto-assign
* the 4.3 resize path (`EJS_emulator.frontend.handleResize`) with a fallback to
  the 4.2.3 path (`EJS_emulator.handleResize`)

The 4.2.3 page was not converted. `/play` still loads `/emulator/data/` and
`/js/play.js`; only the header/footer gained a link to the netplay mode.

### Server wiring

`src/server.js`:

* serves `/emulator43/data` from `_server/netplay/ejs-data-nightly/` with the
  same long-cache/CORP/range policy as `/emulator`;
* keeps `/emulator` (4.2.3) intact;
* serves `play-net.html` for `/play-net`, `/play-net.html`, and
  `/play?netplay=1`;
* serves `play.html` for `/play` with no netplay query.

---

## 6. Test evidence

The checked-in `test-play-net.mjs` covers the **21 core** integration checks; it
was run twice end-to-end:

| Run | Origin | Netplay path | Result |
| --- | --- | --- | --- |
| New server code | `http://<host-lan-ip>:8090` | `/play?netplay=1&cache=0` | **21/21** |
| Live server on `:8080` | `http://<host-lan-ip>:8080` | `/play-net.html?cache=0` | **21/21** |

A separate **doc-only** expanded run reported 33/33 on a different suite; that
harness and its result file are not checked in.

Harness: `_server/netplay/test-play-net.mjs`
(`cd _server\netplay && npm run test:play`). It accepts `APP_PORT`,
`NP_PATH`, and `SINGLE_PATH` environment overrides.

* Two **independent Brave browser contexts** (Brave 156.x, puppeteer-core).
* The origin is the **LAN IP**, not localhost.
* The first run used a separate `:8090` server so a running `:8080` was not
  disturbed; the second run used the live `:8080` process and the `.html`
  static alias.
* Relay on `:3010`; real `disc/r4.chd` (341 MB) and
  `_server/game/bios/openbios.bin`.

Machine-readable summary: `_runtime/netplay-integration-results.json`
(the JSON records the 21 core integration checks, all passing).
Logs: `_runtime/netplay-integration.log` (latest `:8090` rerun),
`_runtime/netplay-integration-live8080-console.txt` (live `:8080` run), and
`_runtime/netplay-integration-console.txt` (earlier `:8090` run).

Key checks:

| Check | Evidence |
| --- | --- |
| `/play?netplay=1` serves the netplay document | `play-net.js` + `netplayPanel` present |
| `/play` still serves 4.2.3 | `/js/play.js`, no netplay panel |
| Data folders coexist | `/emulator43/data` boots `4.3.0-pre`; `/emulator/data` = `4.2.3` |
| Host boot | 3 s, version `4.3.0-pre`, path `/emulator43/data/`, canvas 876×657 (the lounge two-tab path is 5.4–6.2 s cold) |
| Host config | `gameID=4`, relay `http://<host-lan-ip>:3010`, empty ICE |
| EJS netplay button | visible |
| Host creates room | relay `/list` advertises `R4 LAN INTEGRATION` for gameID 4 |
| Guest boot | 3–4 s, same 4.3 page/origin (5.5–6.2 s in the two-tab lounge run) |
| Guest sees room | relay row + JOIN button |
| Both see 2 players | `["PLAYER A","PLAYER B"]` on both sides |
| Roles | host `owner=true`; guest `owner=false` |
| WebRTC | `connected` / `connected`, data channel `open` |
| Guest video | `readyState 4`, `currentTime` advances 3.62 → 5.04 |
| Guest input | host PSX `simulateInput` received `[1,0,1]` (player 2) |
| Single-player regression | 4.2.3 booted in 2 s from `/emulator/data/`, canvas 960×720 |
| Page errors | 0 on host, guest, and single-player pages |

The browser console also shows the expected 4.3 LAN warning:

```
[NETPLAY] No ICE servers configured. Connections will only work on LAN.
```

That is intentional with `EJS_netplayICEServers = []`.

### Screenshots

* `_runtime/netplay-integration-host-boot.png`
* `_runtime/netplay-integration-host-room.png`
* `_runtime/netplay-integration-host-game.png` (host R4)
* `_runtime/netplay-integration-room-list.png` (guest panel sees the room)
* `_runtime/netplay-integration-guest-game.png` (guest streamed R4)
* `_runtime/netplay-integration-single.png` (stable 4.2.3 `/play`)

## 8b. Capture / transport tuning (2026-11-06, N1–N6)

`play-net.js` now wraps the pinned bundle; `emulator.min.js` is untouched.

| # | Change | Escape hatch |
| --- | --- | --- |
| N1 | Host capture is `canvas.captureStream(0)` + `track.requestFrame()` once per core frame (rAF-driven), `replaceTrack` on every video sender, `maxBitrate`/`maxFramerate` re-applied on `race-live`, peer create, connect and canvas resize | `?capture=30` (bundle track), `?pin=1` (960×720 offscreen pin) |
| N2 | `r4Keyframe()` = +5 % `maxBitrate` bump + restore; on `race-live`, track `unmute`, a >500 ms encode/decode stall, and a guest `rr4-keyframe` request | `?keyframe=0` |
| N3 | Guest pad input is sent **once**: the Socket.IO `sync-control` copy is suppressed while the WebRTC data channel is open; counters `state.input.dc/relay/dropped` | `?dedup=0` |
| N4 | 2 s `getStats()` line in the stage log + `window.__R4NET.stats` + the collapsed chip | `?stats=0` |
| N5 | Guest QUALITY AUTO/LOW/MED/HIGH (1.5 M/30, 4 M/60, 8 M/60), sent as `{type:'rr4-quality'}`; AUTO starts MED and drops to LOW after two bad 2 s windows, never climbs | `?quality=high` |
| N6 | `image-rendering` follows the real upscale factor; no blur/`backdrop-filter` on `#game`/`#play-stage`; DLSS 5 grade scoped to `#game`; optional desynchronized guest context / attached `<video>` / rVFC blit | `?desync=1`, `?video=attached`, `?draw=bundle\|gated\|qpf\|rvfc` |

Measured (`bench-netplay.mjs`, two contexts, one host, 12 s window):

| Metric | Baseline | After |
| --- | --- | --- |
| host core | 60.15 fps | 60.15 fps |
| host encode | 29.29 fps | **59.08 fps** |
| host bitrate | 683 kbps | 920–2504 kbps (4 M/60 ceiling) |
| guest decoded | 29.29 fps | **57.44 fps** |
| guest presented (rVFC) | 28.86 fps | **42.25 fps** (41–55 across runs) |
| jitter buffer | 9.9 ms | 11.4 ms |
| packet loss / RTT | 0 % / 0 ms | 0 % / 0–1 ms |

Why not a plain `captureStream(60)`: in a live room the EJS WebGL canvas draws
60.2×/s, but `captureStream(60)` of it delivered only **42.8 fps** (Chrome
captures on canvas commit and the core's bursty grid collapses frames);
`applyConstraints({frameRate:60})` stayed at 30.1. `captureStream(0)` +
`requestFrame()` reaches 58.8 fps encoded with no extra copy.

Guest **presented** fps stays below decoded: the guest `<video>` is detached and
consumed by a 140 Hz rAF copy; attaching it, a desynchronized context, an
rVFC blit and a `totalVideoFrames`-gated blit were all measured and none beat the
bundle loop. 0 % packet loss and an 11 ms jitter buffer say the loss is at the
guest media sink, not the transport. Report `decoded` as the stable number.
An unordered/unreliable pad channel (`{ordered:false, maxRetransmits:0}`) needs a
second data channel and a 4 Hz resend; it is **not implemented**.

Evidence: `_runtime/bench-netplay-after-netplay-tune.json` (10 tier checks,
`G-DROP` is the known guest-presented gap), `mp-ws-probe.mjs` 22/22,
`mp-macro-test.mjs` 6/6, `test-mp-race-e2e.mjs` 40/40 (the duplicate guest input
record count drops 4 → 2 for one press+release, i.e. N3).

---

## 7. Shell 2P lounge transport (`/mp`)

`ws://<host>:8080/mp` is the lounge socket used by `public/js/multiplayer.js`. It
is separate from the relay on `:3010`: `/mp` only carries room codes, teams,
ready state and the race roll.

### Messages

| Client -> server | Server -> client |
| --- | --- |
| (connect) | `{type:'hello', id, rooms}` |
| `{type:'create', code, name}` | `{type:'joined', code, role:'host', id}`, then `room` + `rooms` |
| `{type:'join', code, name}` | `{type:'joined', code, role:'guest', id}` (or `{type:'error', message}`), then `room` + `rooms` |
| `{type:'ready', ready}` | `{type:'room', code, host, started, track, cars, players[]}`, or `{type:'race', code, raceId, track, trackIndex, cars}` when both are ready |
| `{type:'team', team}` | `{type:'room'}` |
| `{type:'leave'}` | `{type:'left', rooms}`, then a `rooms` broadcast |
| `{type:'list'}` | `{type:'rooms', rooms:[{code, host, players, max}]}` |
| `{type:'ping'}` | `{type:'pong', at}` |

The server rolls the plan (not the client): one of the 8 courses **in in-game
menu order** and one preset car per driver, then sends the same `race` payload to
both sockets. `raceId` is `<code>-<base36 time>-<random>`.

### Heartbeat, promotion, stale rooms

- **20 s heartbeat** (`MP_HEARTBEAT_MS`). A socket that does not answer the
  protocol-level ping is terminated; the close handler drops the player,
  promotes the guest when the host dies, deletes empty rooms and broadcasts the
  room list.
- **Room-list broadcasts** on create/join/leave/close, so observers see the list
  change without polling.
- **Application-level `ping`** replies with `{type:'pong', at}`; this is separate
  from the protocol ping/pong the heartbeat uses.
- **5-minute stale-room sweep** (`MP_STALE_ROOM_MS`) for rooms whose sockets are
  all gone (crashed tab, network drop with no close frame).
- Host promotion is relay-side only. The EmulatorJS 4.3 client still does not
  adopt the promoted host, so the guest keeps waiting for the old stream.

Verified on a throwaway instance on port **8095** with
`_server/mp-heartbeat-probe.mjs`: create/join, application `ping`/`pong`, full
room hidden from the list, guest promoted after a hard host termination, room
still listed once with one player, room gone after the last player leaves, and a
silent socket terminated by the heartbeat followed by room cleanup. All checks
passed. There is no saved `_runtime/mp-heartbeat-*.json`; the probe prints
`ALL CHECKS PASSED` (10/10, console only) and exits non-zero on failure.

The long-running `:8080` process was **restarted on 2026-11-06** and now serves
this build; `_server/mp-ws-probe.mjs` sees the application `pong` and a server
heartbeat ping there. Restart again after a future `/mp` edit with
`_server\start-test.bat` (web server only) or `_server\start.bat` (web server +
native cabinet). Run the throwaway instance with:

```powershell
cd _server
$env:RR4_PORT='8095'; $env:RR4_NO_AUTOSTART='1'; $env:RR4_STREAM_SOURCE='test'; node src/server.js
# second terminal:
node mp-heartbeat-probe.mjs 8095
```

`:3010` remains the separate EmulatorJS relay process (`netplay/server.js`); it
is not part of `/mp` and is unaffected by restarting the 8080 app.

---

## 8. Host race macro

The host is the race director. `public/js/play-net.js` drives R4's real VS Battle
menus through `gameManager.functions.simulateInput` once netplay reports 2
players and an open data channel.

### Menu verification

R4 stores the current menu/list selection in one byte:

| Address | Meaning |
| --- | --- |
| `0x800AC801` | selection byte (main menu: 0 Grand Prix, 1 Time attack, 2 VS battle) |
| `0x800A2180` | label table; `play-net.js` scans the WASM heap for `WELCOME` / `GRAND PRIX` / `VS BATTLE` to locate it |

The macro reads the byte, presses **Down** and checks that the selection
incremented, then presses **Up** to restore it. That is the proof it is really on
the main menu and not on the Namco logo, WELCOME card or attract movie. It retries
Start up to 26 times. Recalibrate against `_runtime/calib/` with
`node mp-calibrate.mjs plans/attract.json` if the menu changes.

Car presses are paced against the pad-ack byte `0x800ABD9F`: the macro keeps
pressing **Right** until the byte has moved exactly `carIndex` steps, because a
busy host (WebRTC encoding) can swallow a press. The course list does not update
that byte, so course presses use exact fixed pacing. Stage records keep
`presses`/`delta` for both.

### Steps

```text
Down x2 -> VS battle (splash ~7 s)
  -> car P1  (Right x carHost, pad-ack paced) -> Circle (car data) -> Circle (AT/MT) -> Circle (AT)
  -> car P2  (player index 1, Right x carGuest, pad-ack paced) -> Circle x3 -> course select
  -> course  (Right x trackIndex, fixed pacing) -> circle/start -> race live
```

Car presses retry **Right** until `0x800ABD9F` has moved exactly `carIndex`
steps; the course list does not update that byte, so course presses use fixed
pacing. `race-live` is sent 20 s after the course confirm.

EJS input indices used: Cross `0`, Circle `8`, Select `2`, Start `3`, Up `4`,
Down `5`, Left `6`, Right `7`.

### Guest gate

The guest core boots, then freezes. `installGuestGate()` wraps
`gameManager.simulateInput` and returns early while `mp.raceLive` is false, so a
guest pad cannot move the P2 cursor during the host's menu walk. The host sends
`race-start` and then `race-live` over the netplay data channel (`r4-mp`
messages); the guest forwards input only after `race-live`.

Status: **exercised** — `test-mp-race-e2e.mjs` presses the guest pad only after
`race-live` and the host core records it as `player 1, index 0, value 1` with
zero player-0 records (40/40). The host sends `race-live` 20 s after the course
confirm. Since N3 (2026-11-06) the guest sends each event **once**: the Socket.IO
`sync-control` copy is suppressed while the WebRTC data channel is open, so one
press+release now records two host records (down/up) instead of four. The relay
copy remains the fallback when the channel is not open (`?dedup=0` restores the
old double send for A/B).

### Evidence

`node mp-macro-test.mjs` is a host-only puppeteer run against the real disc
(`mpRole=host`, synthetic room). It reached `race:live` with
`menuVerified=true`, the full stage list, split-screen frame captures and no page
errors: **6/6**, `harness-verified host-only`. The sixth check is the final-frame
race check (`yellowFrac` 0). Evidence:
`_runtime/mp-macro-evidence.json`, `_runtime/mp-macro-final.png` and
`_runtime/mp-macro-0*.png` — `mp-macro-06-car-p1-data.png` shows `PRESET G2` for
`mpCarHost=5`, `mp-macro-10-car-p2-data.png` shows `PRESET D3` for
`mpCarGuest=2`, `mp-macro-13-course-locked.png` shows `Out of blue`.

The guest half is proved by `test-mp-race-e2e.mjs` below (40/40,
`harness-verified two-browser`).

---

## 9. Lounge, handoff and transport evidence

Run the whole set in one table from `_server`:

```powershell
node verify-mp.mjs          # /mp, lounge UI, shell, host macro
node verify-mp.mjs --full   # + the two-browser race
```

### 9.1 Two-browser lounge UI (`test-mp-lobby-ui.mjs`)

Run from `_server` against a live `:8080` with the `:3010` relay up:

```powershell
cd _server
node test-mp-lobby-ui.mjs
```

It is `harness-verified`, **33/33**: both browsers press ENTER and load
`/welcome`, open `/multiplayer`, create/join the same 4-character room, see the
same P1/P2 names, both press READY, both see 3-2-1-GO, and both shell iframes
receive `/play-net?...` with identical `mpRoom`, `mpRace`, `mpTrackIndex`,
`mpCarHost`, `mpCarGuest` and the correct `mpRole`.

Scope limits: the harness **holds the `/play-net` document request** so the GO
overlay stays on screen for the screenshots. It proves the lobby UI, the roll and
the handoff URL, not the emulator boot. No page errors were recorded; the only
console output was the iframe `allowfullscreen` warning.

Evidence: `_runtime/mp-lobby-ui.json`, `mp-lobby-ui.log`,
`mp-lobby-ui-{host,guest}.png` (GO), `mp-lobby-ui-{host,guest}-room.png`
(both drivers present, READY armed).

### 9.2 Raw `/mp` transport (`mp-ws-probe.mjs`)

```powershell
cd _server
node mp-ws-probe.mjs
```

`harness-verified`, **22/22**: hello id + rooms, create (joined, stable id, one
player), join, per-socket roles, host READY with no race before the guest is
ready, the identical `race` payload (code, raceId, track, trackIndex, cars,
roles) on both sockets, the application-level `{type:'ping'}` → `{type:'pong'}`
reply, a server-initiated heartbeat ping, a protocol pong, and the room removed
after leave. Read-only; writes `_runtime/mp-lobby-ws.json`. The saved JSON
targets the restarted `:8080` and records `ping/app-level` and
`heartbeat/server-ping` as observed `INFO` lines. Heartbeat, host promotion and
stale-room cleanup are also proved by the `:8095` probe in §7.

### 9.3 Two-browser race (`test-mp-race-e2e.mjs`)

```powershell
cd _server
node test-mp-race-e2e.mjs
```

`harness-verified two-browser`, **40/40** (`_runtime/mp-race-e2e.json`,
`summary.failed === 0`). Two browser contexts on one host load the real
`/play-net` (no request interception), the lounge plan matches the rolled
`mp*` parameters, the host macro reaches `race:live`, and the harness asserts:

- `frames.race.raceLike === true` — the race frame is not the yellow menu
  (`yellowPct` 0.1, `nonBlackPct` 64.6 on the current artifact);
  `frames.course.menuLike === true` is the contrast;
- the guest stream's `currentTime` advances (143.27 s → 145.27 s on the current
  artifact; the saved advance is 2.01 s);
- the guest pad press is recorded on the host core as `player 1, index 0,
  value 1` with **zero** player-0 records, and the gate blocked no press before
  `race:live`. Since N3 the guest sends once, so a press + release records two
  host records (down/up) instead of four.

Screenshots: `_runtime/mp-race-e2e-{host,guest}.png` (the two-car VS grid /
split-screen), `-host-go`/`-guest-go`, `-guest-car-p1`/`-guest-car-p2`,
`-host-course`, `-host-loading`, `-host-live6s`/`-guest-live6s`,
`-guest-before`/`-guest-after`.

Scope: the harness run is two contexts on **one host**; the operator has also
played 2P across **two physical machines** on the LAN (`manually verified
two-machine`, 2026-11-06, connection mix not recorded).
Guest audio is **absent, not just unheard**: the stream is video-only
(`["video:live"]`), and the guest proof is a host-stream P2 input test
(`scopeNote` in the JSON), not guest-side gameplay parity.

---

## 10. Limitations

1. **Host tab must stay foreground.** Chrome/Brave throttle background
   `requestAnimationFrame`/canvas capture. A minimized or backgrounded host tab
   makes the guest stream stutter or freeze.
2. **Host-authoritative WebRTC.** Only the host runs the PSX core and renders
   the game. The guest receives video/audio and sends input as player 2; the
   guest cannot run the race locally.
3. **Host departure.** 4.3-pre does not promote the guest to host in the client.
   The relay transfers ownership server-side, but the guest keeps waiting for
   the old host's stream. Treat the host as the session owner; leave/rejoin or
   restart the room if the host leaves.
4. **Same origin and same gameID.** Both machines must use the same
   `host:port` (LAN IP, not localhost on one side) and the same `EJS_gameID`.
   R4 = 4, Rage Racer = 5.
5. **Empty ICE means one subnet.** With `EJS_netplayICEServers = []`, WebRTC
   uses direct LAN host candidates only. Disable Wi-Fi AP/client isolation,
   avoid VPN adapters and multiple subnets, and keep both machines on the same
   router. Across NAT/internet, add STUN **and** TURN; STUN alone is not enough.
6. **R4 only for 2P.** Ridge Racer Type 4 has the 2-player split-screen mode.
   Rage Racer and the original Ridge Racer are 1P; a guest is a second screen /
   controller, not a second car.
7. **Audio is absent, not unverified.** The 4.3 host captures from
   `Module.AL.currentCtx`, but the 4.3 core uses RWebAudio, so that is `null`:
   `localStream` carries **video only** (`["video:live"]`), the log says
   `No audio tracks captured - guests will have no audio`, and the guest has no
   inbound audio RTP and no remote `<audio>` element. Clicking **CLICK TO RACE**
   before creating the room does not fix it — there is no OpenAL context to
   capture. A real fix needs an RWebAudio tap (`analysis/05-audio.md` #2).
8. **Guest downloads the disc too.** The guest boots its own EmulatorJS
   instance to get the netplay UI, so it downloads the 341 MB CHD before
   joining, then freezes its local core. A thin guest page is possible later.
9. **Two physical machines: run by hand, not by the harness.** The harness used
   two Brave contexts on one host through the real LAN IP; the operator has since
   played a 2P VS Battle across two physical machines on the LAN and reports it
   works (`manually verified two-machine`, 2026-11-06). ICE selected direct host
   candidates in the harness; the wired/Wi-Fi mix of the hand run is not recorded.
10. **4.3.0-pre is pinned.** `_server/netplay/ejs-data-nightly/` is a snapshot,
    not the live CDN. Its `version.json` still contains the upstream stale
    `"version": "4.2.3"` string; the actual `emulator.min.js` reports
    `ejs_version = "4.3.0-pre"`. Pin the snapshot; do not switch the page to
    `cdn.emulatorjs.org/nightly` at runtime.
11. **HTTPS / mixed content.** Current LAN pages are HTTP, so
    `http://<lan-ip>:3010` is fine. If `/play` is served over HTTPS, the relay
    must be HTTPS/WSS or proxied through the main server, otherwise the browser
    blocks mixed content.
12. **4.2.3 netplay is not usable.** Its handshake works but host input frames
    stay at `currentFrame = 0`; it does not stream video. Keep it
    single-player only.
13. **WebRTC setup is retryable.** One test rerun timed out waiting for the
    peer connection (`timeout waiting for WebRTC connected`); an immediate
    rerun connected and passed 21/21. If a guest joins and the stream never
    appears, leave the room and rejoin (or restart the room) before changing
    anything else.
14. **The two-browser race is `harness-verified two-browser` on one host.** The
    lounge UI (33/33), the raw `/mp` (22/22) and the host macro (6/6) are
    verified separately; `test-mp-race-e2e.mjs` (40/40,
    `_runtime/mp-race-e2e.json`) adds the guest driving P2 after `race-live`.
    Two physical machines have since been played by hand and work
    (`manually verified two-machine`, 2026-11-06); guest audio is absent.
15. **Standalone `/multiplayer` plan (fixed 2026-11-05).** It now carries
    `mpTrackIndex`/`mpCar*` like the shell handoff, so the plan the lounge
    announced is the plan `/play-net` runs.
16. **Shell fullscreen** is wired and harness-verified (`_server/test-shell-fs.mjs`
    30/30: button, `F`, exit control, bar hidden, iframe fills; headless Esc is
    browser-limited).
    **`/docs/introduction` logs a React #418 hydration warning** in the embedded
    shell; the page renders. `No ICE servers configured` is also expected. COOP
    is not: the header is sent on loopback/HTTPS only, so a plain-HTTP LAN origin
    has no COOP warning. No page is "0 console errors".

---

## 11. Files changed / added

| Path | Change |
| --- | --- |
| `_server/src/server.js` | `/emulator43/data` static mount; `/play-net`; `/play?netplay=1`; `/mp` lounge socket (heartbeat, promotion, room broadcasts) |
| `_server/public/enter.html` / `js/enter.js` | ENTER shell, parent audio, `/welcome` iframe, `rr4-race` handoff |
| `_server/public/welcome.html` / `games.html` / `multiplayer.html` | hub, machine check, 2P LOUNGE |
| `_server/public/js/multiplayer.js` | room code, teams, READY, race-plan UI, `rr4-race` postMessage |
| `_server/public/play.html` | visible **MULTIPLAYER** header button + footer link |
| `_server/public/play-net.html` | netplay page with host/guest panel |
| `_server/public/play-net/index.html` | static redirect for older server processes |
| `_server/public/emulator43/data` | junction → `_server/netplay/ejs-data-nightly` (static fallback) |
| `_server/public/js/play-net.js` | 4.3 netplay config, room UI, auto host/join, host VS Battle macro, guest gate |
| `_server/public/css/play-net.css` | netplay panel/chip/status styling |
| `_server/public/css/play.css` | MULTIPLAYER button and footer-link styling |
| `_server/start.bat` | starts the relay on 3010 minimized (opt-out `RR4_NO_NETPLAY=1`) |
| `_server/start-test.bat` | starts the relay on 3010 minimized (opt-out `RR4_NO_NETPLAY=1`) |
| `_server/mp-ws-probe.mjs` | raw `/mp` evidence (22/22) |
| `_server/test-mp-lobby-ui.mjs` | two-browser lounge UI + handoff evidence (33/33) |
| `_server/mp-macro-test.mjs` | host-only R4 macro evidence (6/6) |
| `_server/test-mp-race-e2e.mjs` | two-browser race + guest P2 evidence (40/40) |
| `_server/mp-heartbeat-probe.mjs` | heartbeat / promotion / stale-room probe |
| `_server/mp-calibrate.mjs` | course/car order calibration → `_runtime/calib/` |
| `_server/stop.bat` | stops the native cabinet, 8080, and 3010 |
| `_server/start-netplay.bat` | start relay on TCP 3010 |
| `_server/stop-netplay.bat` | stop the TCP 3010 listener |
| `_server/firewall-netplay.bat` | UAC wrapper for the TCP 3010 firewall rule |
| `_server/netplay/firewall-netplay.ps1` | inbound TCP 3010 on all profiles |
| `_server/netplay/test-play-net.mjs` | two-context Brave integration test |
| `_server/netplay/package.json` | `npm run test:play` |
