# LAN netplay report — EmulatorJS / Ridge Racer Type 4

**Status: working on the LAN with EmulatorJS 4.3.0-pre (nightly), now driven by
the 2P LOUNGE instead of a hand-created room.**
The relay, room discovery, join, WebRTC video, and guest→host input were
verified with two independent Chrome browser contexts and the real R4 disc
(21/21 core checks; `NETPLAY-INTEGRATION.md` §6). The normal path is
**`/` → ENTER → 2P LOUNGE → both READY → `/play-net`** with the rolled race; the
manual **CREATE ROOM** / **JOIN** panel described below is the fallback and the
debugging path. Scoped results: lounge UI + handoff `harness-verified` 33/33,
raw `/mp` transport `harness-verified` 22/22, host VS Battle macro
`harness-verified host-only` 6/6, two-browser race with a guest driving P2
`harness-verified two-browser` 40/40 (two browser contexts on one host; two
physical machines unverified; guest audio absent — the stream is video-only). The `/play` page still runs
EmulatorJS **4.2.3**, whose netplay is
experimental and only handshakes reliably; see
[Wiring into `/play`](#6-wiring-into-play).
(While this report was being written, a parallel main-page QA run on
`localhost:8090` was already opening/joining rooms on this same relay with
`gameID 4`, confirming the relay accepts the real `/play` origin.)

No native game process (`Ridge_Racer_4_Recompiled.exe`) was launched for any of
these tests.

---

## 1. What was installed

| Item | Detail |
| --- | --- |
| Official repo | <https://github.com/EmulatorJS/EmulatorJS-Netplay> |
| Default branch | `rust` (Axum + Socket.IO), commit `4090ca7` — **not built**, no Rust toolchain on this host |
| Server used | Node `server.js` from the `main` branch, commit `9e8a6e6` (2025-09-19) |
| npm package | `emulatorjs-netplay` does **not** exist on npm (404) |
| Local server | `_server/netplay/server.js` — upstream protocol unchanged, plus `/health`, room/join logs, `HOST`/`PORT` env, default `PORT=3010`; deps `socket.io 4.8.4`, `express 5.3.0`, `cors 2.8.6` |
| Client used for proof | EmulatorJS `4.3.0-pre` nightly (`cdn.emulatorjs.org/nightly/data`) |
| Legacy client also tested | EmulatorJS `4.2.3` (the version currently installed for `/play`) |
| Test core | `pcsx_rearmed` with the real `disc/r4.chd` (341 MB) and `game/bios/openbios.bin` |

The Rust branch is protocol-compatible and can be used later (`cargo run`), but
it is not required. The Node relay is official, smaller, and was the one
tested here.

---

## 2. Start the relay

```powershell
cd _server\netplay
npm install                         # once
powershell -ExecutionPolicy Bypass -File .\start-netplay.ps1
```

Tested on Node **v24.10.0** (Windows). Node 20+ should work.

Equivalent explicit command:

```powershell
$env:PORT = '3010'
$env:HOST = '0.0.0.0'
node server.js
```

* Port: **TCP 3010** (HTTP + Socket.IO on the same listener).
* Default upstream port is 3000; this local copy defaults to 3010 so it does
  not collide with the main app on 8080.
* Health check: `http://127.0.0.1:3010/health`
* Room list: `http://127.0.0.1:3010/list?domain=<host:port>&game_id=<id>`
* Stop: `powershell -ExecutionPolicy Bypass -File .\stop-netplay.ps1`

### Firewall

On the host, allow inbound **TCP 3010** on the Private profile:

```powershell
# elevated PowerShell
powershell -ExecutionPolicy Bypass -File .\firewall-netplay.ps1
# or manually:
New-NetFirewallRule -DisplayName "RR4 Netplay 3010" -Direction Inbound `
  -Protocol TCP -LocalPort 3010 -Action Allow -Profile Private
```

The test harness uses **TCP 3011**; the helper script opens both. WebRTC media
uses ephemeral **UDP** ports on the two browsers, not on the relay. Windows may
prompt for Chrome's UDP traffic on first use; allow it on Private networks.
No router port-forwarding is needed for same-subnet LAN play. For internet play,
forward TCP 3010 and add a TURN server (see caveats).

Find this machine's LAN address with `ipconfig`. `LAN-URL.txt` is the
convenience note the launchers print/share; set it to
`http://<host-lan-ip>:8080/` for the current host.

---

## 3. Client settings

### 3.1 Recommended: EmulatorJS 4.3.0-pre

```js
window.EJS_gameID = 4;                         // numeric, unique per game
window.EJS_netplayServer = `http://${location.hostname}:3010`;
window.EJS_netplayICEServers = [];             // LAN: empty is enough
window.EJS_Buttons = { netplay: true };        // default true in 4.3; harmless
```

That is the whole netplay config. `EJS_netplayServer` must be absolute; the
client strips trailing `/`. `EJS_netplayICEServers` accepts the documented
array shape (`[{ urls: 'stun:...' }]`, optional TURN username/credential).

4.3 netplay is **enabled by default** (`netplayEnabled = true`), uses
Socket.IO for signalling and WebRTC for host canvas/audio + guest inputs.
The host runs the game; the guest renders the host's streamed canvas and sends
its pad/keyboard input over a WebRTC data channel.

### 3.2 Legacy: EmulatorJS 4.2.3 (current `/play`)

4.2.3 hides the netplay button unless **all** of these are set:

```js
window.EJS_DEBUG_XX = true;
window.EJS_EXPERIMENTAL_NETPLAY = true;
window.EJS_Buttons = { netplay: true };
window.EJS_gameID = 4;                         // must be a number
window.EJS_netplayServer = `http://${location.hostname}:3010`;
```

4.2.3 **ignores** `EJS_netplayICEServers` (the option exists in the docs but
there is no `RTCPeerConnection` in 4.2.3's netplay code). It relays inputs and
save states over Socket.IO only; it does not stream video. It also registers
its `Module.postMainLoop` hook after the core has already started, so
`netplay.currentFrame` stays `0` and the host never broadcasts its own inputs.
Handshake/join works; full 2-player input sync does not. See
[Wiring into `/play`](#6-wiring-into-play) for options.

### 3.3 LAN room-discovery rules

* Both players must use the **same page origin**, including port. Room discovery
  sends `domain: window.location.host`; `http://localhost:8080/play` and
  `http://localhost:8080/play` are different domains.
* Both players must use the **same numeric `EJS_gameID`**.
* Use the LAN IP in the URL on both machines, e.g.
  `http://localhost:8080/play` (not `localhost` on one side).
* A full room (`current === max`) disappears from `/list`; that is upstream
  behaviour, not a failure.
* Room passwords: 4.2.3's `joinRoom` does not send the password (commented out
  upstream); 4.3 does. The manual panel's **CREATE ROOM** sets none; the shell
  auto-host uses the rolled `raceId` as the password and the guest joins with
  the same one. The 21/21 transport tests used no password.

---

## 4. Test evidence

All tests used two independent Chrome `BrowserContext`s on the same host, a
standalone harness in `_server/netplay/`, and the relay on `:3010`.

### 4.1 EmulatorJS 4.2.3 + NES (`test-netplay.mjs`)

**19/19 checks passed.** Verified: netplay button visible with the flags,
player-name dialog, create room, `/list` advertisement, second context sees the
room, joins as client, both sides show 2 players, host pushes a save state,
Socket.IO relay carries `sync-control` both ways, host leave updates the client
list, no page errors.

Known limitation recorded as a passing "expected" check:
`netplay.currentFrame` stayed `0` on the host, so host-originated input frames
were not broadcast. Log: `_runtime/netplay-test.log`.

### 4.2 EmulatorJS 4.3.0-pre + NES (`test-netplay-43.mjs`)

**15/15 checks passed.** Verified: room creation/join, WebRTC peer
`connected`, data channel `open`, guest receives a live host canvas stream
(`readyState 4`, `currentTime` advancing), guest input arrives at the host's
emulator as player 2, no page errors. Log: `_runtime/netplay43-test.log`.

### 4.3 EmulatorJS 4.3.0-pre + PSX + real R4 CHD (`test-netplay-psx.mjs`)

**14/14 checks passed** with `EJS_netplayICEServers = []` (no STUN/TURN).

* Host boot: **3–4 s** with `disc/r4.chd` (341 MB) + `openbios.bin`.
* Guest boot: **3–4 s**; both sides see 2 players.
* WebRTC: `connected` / `connected`, data channel `open`.
* ICE selected **host ↔ host UDP** (`rttMs: 0` on localhost) — no relay/TURN.
* Guest video: 480×278, `readyState 4`, `currentTime` advances; the guest
  screenshot shows the actual R4/Namco picture.
* Guest input: host receives `{player:1,index:0,value:1}` and its
  `gameManager.functions.simulateInput` is called for player 2.
* No page errors. (The `requestfailed: ... net::ERR_ABORTED` entries for the
  CHD/core are Chrome cancelling the reader after EmulatorJS has the bytes, not
  failed downloads.)

Logs: `_runtime/netplay-psx-test-ice0.log` (no ICE servers),
`_runtime/netplay-psx-test.log` (with STUN). Screenshots:
`_runtime/netplay-psx-host-game.png`, `netplay-psx-guest-game.png`,
`netplay-psx-guest-webrtc.png`, `netplay-psx-host-room.png`,
`netplay-psx-room-list.png`, `netplay-psx-host-boot.png`.

Host (authoritative R4) / guest (streamed R4, same frame):

![Host playing R4](../_runtime/netplay-psx-host-game.png)
![Guest receiving the R4 stream](../_runtime/netplay-psx-guest-game.png)

### 4.4 ROM format finding (important)

| R4 input | Result |
| --- | --- |
| `disc/r4.chd` (341 MB) | **Works**, boots in 3–4 s, recommended |
| `R4 ... .7z` (345 MB) | Works, but EmulatorJS decompresses to a 621 MB bin in MEMFS; boot ~43–46 s in headless |
| raw `R4 ... .bin` (621 MB) | Fails in 4.3-pre's `downloadFile` with `NotReadableError` while building the Blob; not usable |
| `.cue` alone | Only the `.cue` is fetched; the referenced `.bin` is not auto-downloaded |

Use the CHD (the main `/play` already does). If a raw bin must be used, load it
directly (auto-cue) rather than the `.cue`, and expect high memory use.

---

## 5. LAN latency / ICE caveats

* **Topology:** 4.3 is host-authoritative. The host runs the PSX core and
  encodes its canvas + audio to each guest; guests send only inputs. This is the
  right model for R4: one machine pays the emulation cost, the guest is a thin
  client.
* **ICE on LAN:** with an empty `EJS_netplayICEServers`, Chrome uses host
  candidates and connects directly. 4.3 logs `No ICE servers configured.
  Connections will only work on LAN.` — that is expected, not an error. The
  test selected host↔host UDP and reported 0 ms RTT on localhost; a real LAN is
  typically ~1–5 ms. STUN is optional on one subnet and does not improve a
  direct host candidate.
* **When host candidates fail:** Wi-Fi access-point client isolation, multiple
  subnets/VLANs, VPN adapters, or restrictive Windows firewall. Fix by disabling
  AP isolation, putting both players on the same subnet, or adding a TURN
  server. TURN is required across NAT/internet; STUN alone only helps discover
  the public address.
* **Video/CPU:** the host encodes a video stream (observed 480×278 in headless;
  a GPU-backed browser can negotiate higher). The pinned bundle captured at
  30 fps; since 2026-11-06 `play-net.js` drives `captureStream(0)` +
  `requestFrame()` at ~59 fps with a 4 Mbps/60 ceiling (HIGH = 8 Mbps). Expect
  **0.9–2.5 Mbps upstream** per guest and 30–80 ms encode/decode + network
  latency. A weak host CPU or 2.4 GHz Wi-Fi will show as stutter on the guest,
  not as input lag on the host.
* **Keep the host tab foreground.** Chrome throttles `requestAnimationFrame`
  and canvas capture in background/minimized tabs. The test browser used
  `--disable-background-timer-throttling` / `--disable-renderer-backgrounding`
  and brought the host page forward; a normal host that alt-tabs away may see
  the guest stream drop to a slideshow.
* **Audio is absent, not merely unverified.** 4.3 tries to capture host audio
  from `Module.AL.currentCtx`, which is `null` under RWebAudio, so the stream is
  video-only (`No audio tracks captured - guests will have no audio`; measured
  host tracks `["video:live"]`, guest `remoteEls: 0`, no inbound audio RTP).
  A guest click cannot unlock audio that is never sent; the fix is an RWebAudio
  tap on the host (`_runtime/analysis/05-audio.md`).
* **Host departure:** in 4.3-pre the guest is **not** promoted to host; it
  remains in the room without video until it leaves/rejoins. The relay does
  transfer ownership server-side, but the 4.3 client does not adopt it. Treat
  the host as the session owner; restart the room if the host leaves.
* **HTTPS:** current LAN pages are HTTP, so `http://<lan-ip>:3010` is fine. If
  `/play` is later served over HTTPS, the relay must also be HTTPS/WSS or the
  browser blocks it as mixed content. Put the relay behind Caddy/nginx or proxy
  `/netplay` from the main server.
* **Browser support:** tested with Chrome (headless). Edge should behave the
  same. Firefox/Safari WebRTC is expected to work but was not tested.

---

## 6. Wiring into `/play`

### Current state (2026-11-05)

`/play` is still the verified single-player page: `public/js/play.js` loads
EmulatorJS **4.2.3** from `/emulator/data`, sets `EJS_gameID` (4 for R4, 5 for
Rage Racer, 6 for Ridge 1994), `EJS_core='psx'`, `EJS_gameUrl='/rom/r4.chd'`,
`EJS_biosUrl='/bios/openbios.bin'`, but does **not** set `EJS_netplayServer`,
`EJS_DEBUG_XX`, `EJS_EXPERIMENTAL_NETPLAY`, or `EJS_Buttons.netplay`. Netplay is
hidden there by design.

The parallel netplay page now exists: `/play-net` (alias `/play?netplay=1`) runs
the pinned 4.3.0-pre data from `/emulator43/data/`, and `/play` links to it as
**MULTIPLAYER**. The shell drives it: `/` → ENTER → 2P LOUNGE rolls the race,
then both browsers are handed to `/play-net` with `mpRole`/`mpRoom`/`mpRace`/
`mpTrackIndex`/`mpCar*`. The host auto-hosts `R4-<code>` and runs the VS Battle
macro; the guest auto-joins and its input stays gated until `race-live`.
After the race, the game page's **REMATCH** chip sends that seat back to
`/multiplayer?room=<code>&host=1|0`; the host recreates the same code, the guest
retries `join`, and both press READY for a fresh plan.

With 4.2.3 itself, adding the flags gives a working room/handshake but broken
host→guest input broadcast (`currentFrame` stays 0). It is not a usable 2P
experience without a shim or an upgrade. A read-only probe of the real `/play`
with the flags injected before load confirmed `gameID=4`,
`netplayUrl=http://127.0.0.1:3010`, and a visible Netplay button; the page itself
just never sets them (`_runtime/netplay-play42-probe.png`).

### Recommended path (adopted)

A **parallel 4.3 netplay page** was chosen over changing the verified `/play`:

1. Serve the tested 4.3 data at `/emulator43/data/` →
   `_server/netplay/ejs-data-nightly/`.
2. `play-net.html` uses the same R4 CHD, BIOS, and chrome, plus:
   ```js
   window.EJS_gameID = 4;                         // 5 for Rage Racer
   window.EJS_netplayServer = `http://${location.hostname}:3010`;
   window.EJS_netplayICEServers = [];             // LAN
   window.EJS_Buttons = { netplay: true };
   ```
3. The relay runs on 3010; `/play` links to the page as **MULTIPLAYER**.

This leaves `/play`'s 4.2.3 single-player path untouched.

### If `/play` itself must become netplay-capable

Upgrade `public/emulator/data` to the 4.3.0-pre nightly build and add the four
lines above. Note that 4.3 moved some UI internals under
`EJS_emulator.frontend` (e.g. `frontend.handleResize`, frontend elements), so
`play.js`'s fullscreen-resize and gamepad auto-assign helpers need a short
compatibility pass. Netplay itself does not depend on that chrome.

### If staying on 4.2.3

At minimum add the flags and button config, then add a frame-loop shim after
netplay joins (untested here; 4.3 is preferred):

```js
setInterval(() => {
  const e = window.EJS_emulator, np = e && e.netplay;
  if (!e || !e.isNetplay || !np) return;
  const f = e.gameManager.getFrameNum() - np.init_frame;
  np.currentFrame = f;
  if (np.owner && np.inputsData[f - 1]) {
    np.sendMessage({
      'sync-control': np.inputsData[f - 1].map((v) => ({ ...v, frame: v.frame + 10 })),
    });
  }
}, 16);
```

Even with the shim, 4.2.3 guests run their own full PSX emulator and receive
save-state syncs, which is heavier and less robust than 4.3's streamed host.

---

## 7. Remaining work / blockers

1. **Parallel-page decision — done.** `/play-net` runs the 4.3.0-pre snapshot and
   `/play` stays 4.2.3 single-player. The remaining gap is evidence, not wiring.
2. **Two-browser race proof — done on one host.** The lounge UI + handoff is
   33/33, the host macro 6/6 (host-only), and `node test-mp-race-e2e.mjs` is
   **40/40** `harness-verified two-browser` (`_runtime/mp-race-e2e.json`,
   `summary.failed === 0`): the guest drives P2 after `race-live`, the race frame
   is race-like (`frames.race.raceLike === true`, current artifact `yellowPct`
   0.1, `nonBlackPct` 64.6, `meanLum` 78.3), the guest stream advances, and the
   guest pad is recorded on the host as `player 1, index 0, value 1` with zero
   player-0 records.
3. **Two physical machines**: the harness used two browser contexts on one host.
   The operator has since played a full 2P VS Battle across two physical machines
   on the LAN and reports it works (`manually verified two-machine`, 2026-11-06);
   the wired/Wi-Fi mix was not recorded.
4. **Remote audio is absent** (not "untested"): the 4.3 host has no capturable
   OpenAL context, so the stream is video-only.
5. **Host leave/rejoin** is not seamless in 4.3-pre; the relay promotes the guest
   but the client keeps waiting for the old host. Show a "host left, rejoin"
   message or restart the room.
6. **4.3 data footprint / pinning**: the tested nightly data + PSX cores are in
   `_server/netplay/ejs-data-nightly/` and served at `/emulator43/data/`.
   4.3.0-pre is unreleased, so pin the snapshot rather than loading `nightly`
   from the CDN at runtime.
7. **Shell polish:** the fullscreen shell button is wired and covered by
   `_server/test-shell-fs.mjs` (30/30), and `/docs/introduction` logs a React
   #418 hydration warning when
   embedded. Netplay's `No ICE servers configured` is expected; COOP is sent on
   loopback/HTTPS only, so a plain-HTTP LAN origin has no COOP warning. Do not
   report "0 console errors".

---

## 8. Files

Probes added with the lounge (run from `_server`): `node test-mp-lobby-ui.mjs`
(33/33 lounge UI + handoff), `node mp-ws-probe.mjs` (22/22 raw `/mp`),
`node mp-macro-test.mjs` (6/6 host-only macro), `node test-mp-race-e2e.mjs`
(40/40 two-browser race, guest P2), and
`node mp-heartbeat-probe.mjs [port]` (heartbeat / host promotion / stale rooms).

| Path | What |
| --- | --- |
| `_server/netplay/server.js` | relay (upstream Node + `/health`, logging, `PORT=3010`) |
| `_server/netplay/package.json` | `express`, `socket.io`, `cors` |
| `_server/netplay/start-netplay.ps1` / `.bat` | start on 3010 |
| `_server/netplay/stop-netplay.ps1` | stop listener on 3010 |
| `_server/netplay/firewall-netplay.ps1` | inbound TCP 3010/3011 (Private) |
| `_server/netplay/serve-test.mjs` | static harness on 3011 (`/disc`, `/bios`, `/root`) |
| `_server/netplay/test-page.html` | 4.2.3 + NES harness |
| `_server/netplay/test-page-nightly.html` | 4.3-pre harness; `?psx=1`, `&ice=0` |
| `_server/netplay/test-netplay.mjs` | 4.2.3 handshake/relay test |
| `_server/netplay/test-netplay-43.mjs` | 4.3 NES WebRTC test |
| `_server/netplay/test-netplay-psx.mjs` | 4.3 PSX + real R4 CHD test |
| `_server/netplay/probe-play-42.mjs` | read-only probe of the real `/play` with flags injected |
| `_server/mp-ws-probe.mjs` | raw `/mp` transport probe (22/22) |
| `_server/test-mp-lobby-ui.mjs` | two-browser lounge UI + handoff (33/33) |
| `_server/mp-macro-test.mjs` | host-only R4 VS Battle macro (6/6) |
| `_server/test-mp-race-e2e.mjs` | two-browser race + guest P2 (40/40) |
| `_server/mp-heartbeat-probe.mjs` | `/mp` heartbeat / host promotion / stale rooms |
| `_server/netplay/README.md` | quick start / layout |
| `_runtime/netplay-psx-*.png` | host/guest R4 screenshots |
| `_runtime/netplay-psx-test-ice0.log` | 14/14 PSX test, no STUN |
| `_runtime/netplay-test.log` | 19/19 4.2.3 handshake test |
| `_runtime/netplay43-test.log` | 15/15 4.3 NES test |
