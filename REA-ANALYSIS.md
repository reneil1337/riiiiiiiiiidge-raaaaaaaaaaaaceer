# REA evidence for the R4 LAN cabinet

This project uses [morluto/rea](https://github.com/morluto/rea) as the
reverse-engineering evidence layer. REA is a reverse-engineering agent/CLI, not
a netplay library. Its role was to answer the questions that shaped the
original host-streamed cabinet:

1. **How does the native cabinet receive input?** (PE import evidence)
2. **What is actually inside the browser client?** (static JavaScript evidence)
3. **Can the release's built-in netplay be used?** (runtime strings and failure
   behaviour)

## Scope after the browser pivot

The project now has two play paths, and the REA evidence applies to them
differently:

| Path | Runtime | Does the REA evidence apply? |
|---|---|---|
| **`/play`** (primary) | Self-hosted **EmulatorJS + PCSX-Rearmed** (WebAssembly) in each player's browser. | **Partly.** REA describes the native recompilation and the original browser client, not EmulatorJS. The disc/BIOS layout and the "no usable recomp-net" conclusion still matter; the Win32 input and capture findings do not describe the browser core. |
| **`/`** (fallback) | The native **Ridge Racer Type 4 recompilation** on the host, captured with ffmpeg and relayed through `keybd_event`. | **Fully.** This is the architecture REA was used to design. |

In short: REA evidence still applies to the **native runtime** and the
host-stream fallback. The browser path uses EmulatorJS, whose boot, BIOS,
controller, save-state and netplay behaviour must be verified separately (the
EJS boot report). Do not read the PE/import findings as evidence about
EmulatorJS.

The raw REA Evidence JSON is in `analysis/`; `analysis/*-summary.json` keeps the
parts that shaped the implementation.

## Commands run

```powershell
npx -y rea-agents@latest inspect-pe-imports `
  "<repo>\RidgeRacer4Recomp\Ridge_Racer_4_Recompiled.exe" `
  --json > analysis\pe-imports.json

npx -y rea-agents@latest inspect-desktop-application `
  "<repo>\RidgeRacer4Recomp" `
  --json > analysis\desktop-app.json

npx -y rea-agents@latest analyze-javascript-application `
  "<repo>\_server\public" `
  --json > analysis\web-app.json
```

`inspect-desktop-application` found a native PE image (28,189,464 bytes) and the
supporting `bios/`, `launcher/`, `mods/` and config files. It did not identify an
Electron/Unity runtime, which matches the recompiled-native architecture.

`analyze-web-bundle` was also attempted, but REA requires a live CDP `targetId`
for that command. The live page was checked with Puppeteer instead (see
`_server/test-ui.mjs`, `_server/test-mobile.mjs`, `_server/test-live.mjs`, and
the other `test-*.mjs` scripts).

## What REA showed

### 1. The native input surface is a normal Win32 keyboard window (fallback path)

`analysis/pe-imports-summary.json` records 610 examined imports, including the
relevant `USER32.dll` entries (123 functions):

- `AttachThreadInput`, `SetForegroundWindow`, `SetWindowPos` — focus/window control
- `MapVirtualKeyW`, `GetKeyboardState`, `GetAsyncKeyState` — keyboard state
- `EnumWindows`, `GetWindowTextW` — finding the game window
- `OPENGL32.dll` — the present path
- `GDI32.dll` — window/DC and software presentation support
- `WS2_32.dll` — Winsock exists in the binary

The evidence led to the final input path for the **host-stream fallback**:

```
browser pad state (keyboard / Gamepad API / touch)
  -> Node WebSocket /ws
  -> keybd_event() on the two distinct keyboard pads from keybinds.ini
  -> native game window (foreground, resized, topmost)
```

`/play` does not use this path. In the browser path, EmulatorJS reads the
Gamepad API, keyboard or touch directly inside the page and feeds the
PCSX-Rearmed core; there is no Win32 relay and no host window to focus.

The release binary's TCP debug server is compiled out (`PSX_NO_DEBUG_TOOLS`), so
the relay uses the same USER32 input path the game itself uses. No DLL
injection, virtual gamepad driver, or virtual audio cable is required.

The relay keeps the native window's **frame**. An earlier experiment removed
`WS_CAPTION`/`WS_THICKFRAME` to make a borderless 1280x960 surface, but changing
the style while the SDL/OpenGL window is live can make some runtimes recreate or
quit. The production path only calls `SetWindowPos` (`setWindowRect`) to resize
and pin the window, then focuses it. `makeBorderless()` still exists in
`src/win32.js` for experiments, but `src/game.js` does not use it.

### 2. Built-in netplay is present in the UI but absent from this build (native runtime)

The runtime has a netplay launcher UI and strings for `recomp-net`, but the
shipped executable has no `rnet_*` implementation. Starting a direct LAN match
returns:

```
psxrecomp: netplay start failed (-1) — built without recomp-net, or bind/peer invalid
```

The source tree's `psx_netplay.c` confirms the stub returns `-1` under
`#if !defined(PSX_HAS_RECOMP_NET)`. Rather than rebuild the entire recompiled
game, the LAN cabinet uses the game's **real 2-player split-screen mode** and
relays each browser seat into its own native keyboard pad. This is a genuine
two-player LAN session: both drivers are in the same race, each able to select
their own view, and spectators watch the same cabinet.

This is also why the fallback cabinet has one shared race rather than
peer-to-peer sessions: the game supplies the race, and the browser layer
supplies the seats and input transport.

This finding still governs the `/` fallback. It does **not** apply to `/play`:
EmulatorJS has its own netplay (WebRTC plus a signaling server) and does not use
`recomp-net`. EmulatorJS netplay is being verified and is not yet claimed
working; see `_server/WEBAPP-ROADMAP.md`.

### 3. The browser client is self-contained (lobby and fallback)

`analysis/web-app-summary.json` records 5 relevant files, 4 parsed JavaScript
files, 44,993 visited AST nodes, 36 findings and 0 parse failures. The client is
static HTML/CSS/JS with no build step, no Electron/IPC layer, and no external
runtime dependency. For the `/` fallback, the only "download" for a player is
the page itself plus the bundled jsmpeg decoder.

The `/play` page adds self-hosted EmulatorJS assets and a **one-time disc-image
download** (621 MB `.bin`; a CHD is planned), which is reused from the browser
HTTP cache. That is a deliberate change from the stream-only model: browser
play trades a large first download for local rendering and no host capture. The
EmulatorJS client itself was not part of the REA AST scan.

## Architecture after the pivot

### Primary: native browser play (`/play`)

```
browser (each player)
  └─ /play page
       └─ EmulatorJS loader + PCSX-Rearmed (WebAssembly)
            ├─ ROM   <- host disc image (621 MB .bin; CHD planned), HTTP-cached
            ├─ BIOS  <- OpenBIOS / HLE / retail
            ├─ canvas + Web Audio
            └─ Gamepad API / keyboard / touch
```

- **No host stream.** The game is rendered in the player's browser. The host
  serves the page, EmulatorJS assets, the disc image, and the BIOS over the LAN.
- **One-time download.** The browser fetches the disc image and reuses the
  browser HTTP cache (`/rom` is 7-day immutable; EmulatorJS skips its IndexedDB
  ROM copy). This is the main trade-off versus the stream path.
- **BIOS choice.** OpenBIOS is the default at `/bios/openbios.bin`;
  `?bios=hle` selects HLE; `?bios=/bios/<file>` uses a retail image placed in
  `game/bios/`. BIOS behaviour is still being verified.
- **Controllers and states.** EmulatorJS reads Xbox/PlayStation pads, keyboard,
  and touch, and provides fullscreen plus browser-side save/load states.
- **Netplay is separate.** EmulatorJS netplay uses WebRTC and its own signaling
  server, not `recomp-net`. `/play` leaves `EJS_netplayServer` unset, so it
  falls back to EmulatorJS's public server; the self-hosted server is not wired
  in. It is being verified.

### Fallback: host-streamed native cabinet (`/`)

```
native Ridge Racer Type 4 (2P split-screen, OpenGL, window title RR4-LAN)
        │
        ├── Win32 client-area rect (GetClientRect + ClientToScreen)
        │        │
        │        └── ffmpeg gdigrab ── MPEG-1 video + MP2 audio ── MPEG-TS
        │                                                      │
        │                                              WebSocket /stream
        │                                                      │
        │                                             jsmpeg in every browser
        │
        └── two native keyboard pads (game/keybinds.ini)
                 ▲
                 │ keybd_event (foreground window)
           Node input relay
                 ▲
                 │ WebSocket /ws (PSX pad word per seat)
        browser P1 / P2 / spectators
```

Key properties of the fallback implementation:

- **Native 2P split-screen, not netplay.** Built-in netplay is compiled out;
  the game's own versus mode is the race.
- **Browser input relay.** Each seat sends an active-low PSX pad word; the
  server maps it to the native keys for P1 or P2 and injects them with
  `keybd_event`. The server caps input at roughly 250 Hz and the client resends
  its current mask every 220 ms as a heartbeat.
- **Attach mode.** `RR4_ATTACH=1` (or `game.attach` in `config.json`) attaches to
  an already-running `RR4-LAN` window, or a window found by `RR4_ATTACH_PID`.
  Attach mode never spawns or auto-restarts the game in normal operation. It
  still resizes, pins, focuses, and captures the existing window.
- **Client-area capture.** The server reads the real client rectangle with
  `GetWindowRect`, `GetClientRect`, and `ClientToScreen`, then passes it to
  ffmpeg as `gdigrab` `-offset_x/-offset_y/-video_size`. It is not a fixed
  desktop crop and not a window-style-dependent surface.
- **No window-style changes in production.** The window keeps its native frame;
  the server only moves/resizes it and keeps it topmost.
- **Stream and audio.** ffmpeg captures at up to 60 fps, scales to 960x720,
  encodes MPEG-1 video (4 Mbps target, 5 Mbps max, GOP 30 by default) and
  128 kbps MP2 audio, and broadcasts MPEG-TS over `/stream` to jsmpeg. Audio
  comes from WASAPI loopback of the default speaker (`src/audio.py`); if the
  helper is unavailable, the stream falls back to video-only.
- **Test mode.** `RR4_NO_AUTOSTART=1` disables the game launch, and
  `RR4_STREAM_SOURCE=test` loops `_runtime/capture-test.ts`. This is what
  `start-test.bat` sets; `/play` also works in this mode.
- **One cabinet, two seats.** Extra viewers are spectators. A disconnected
  driver keeps a short reconnect grace (about 5 s) before another player may
  take the seat; the seat record is cleared after about 20 s.

## What changed after the evidence pass

| Earlier assumption or experiment | Final implementation or current state |
|---|---|
| Borderless 1280x960 game window | Frame-preserving 656x519 outer window (typically 640x480 client), topmost. |
| Fixed capture offsets in config | Runtime client-area rectangle from Win32; config values are only a pre-ready fallback. |
| Rebuild the game with `recomp-net` | Keep the release binary and relay browser seats into its real 2P mode. |
| Launch the game only from the server | Managed launch, test mode, and attach mode for an externally launched cabinet. |
| Window style changes for a clean capture | `SetWindowPos` resize/pin only; no `WS_POPUP` style change in production. |
| One keyboard mapping for the host | Two native keyboard pads plus a browser-side P1/P2/auto layout selector. |
| Video-only stream | WASAPI loopback audio with automatic video-only fallback. |
| Host-stream-only play | `/play` runs the game in each browser via EmulatorJS/PCSX-Rearmed; the host stream is the fallback. |
| Players download nothing | `/play` downloads the 621 MB disc image (CHD planned) and reuses the browser HTTP cache; `/` still downloads only the page. |
| Native 2P split-screen is the only multiplayer | `/play` can use EmulatorJS netplay (being verified); the native fallback keeps its 2P split-screen relay. |

## Limitations

- PE imports prove the API surface, not that every import is reachable at
  runtime.
- AST coverage is partial; dynamic property access is not proven.
- REA's desktop scan identifies runtime candidates; it does not execute the
  game.
- REA did **not** analyse EmulatorJS or PCSX-Rearmed. The `/play` boot, BIOS
  handling, controller mapping, caching, save states and netplay still need the
  EJS boot report.
- The multiplayer relay is a shared-cabinet input relay, not a rollback netcode
  implementation. It was chosen because the release's netplay library is
  compiled out. The game's own 2-player mode supplies the actual race.
- The relay depends on the game window being foreground; `keybd_event` is a
  global input path, and host keyboard use can reach the game.
- Attach mode depends on a known window title or PID and does not watch or
  restart the process.
- Audio capture follows the host's default speaker; changing that device
  requires a server restart. `/play` audio is browser-local instead.
- The fallback cabinet supports two drivers because that is the game mode in
  use. `/play`'s player count depends on EmulatorJS controls/netplay.

## Evidence files

| File | What it is |
|---|---|
| `analysis/pe-imports.json` | Full REA PE import Evidence (large) |
| `analysis/pe-imports-summary.json` | The imports that shaped the input bridge |
| `analysis/desktop-app.json` | REA desktop/artifact graph for the runtime folder |
| `analysis/web-app.json` | Full REA static JavaScript Evidence (large) |
| `analysis/web-app-summary.json` | Client inventory and analysis statistics |
