# Research: improvements that can be extracted

This is the research/next-step map behind the disc deck and LAN ghost layer.

## Already extracted / implemented

| Area | What was added |
| --- | --- |
| Pre-boot setup | Disc deck, eject, library, local disc, filter/volume/fullscreen/controller status, netplay links |
| LAN ghosts | WebM ghost clips, server storage, setup library, PiP playback during a race |
| Visual grade | DLSS 5-style stage filter, default on, 60 fps |
| Netplay | 4.3-pre host/guest, relay 3010, guest stage grade |
| Disc library | Type 4, Rage Racer, original Ridge Racer CHDs |
| Cache | 1 GiB EmulatorJS ROM cache; warm loads avoid re-download |
| Controls | Gamepad auto-assignment, keyboard/touch through EJS, remapping in EJS menu |

## R4-specific patches worth extracting

- **60 FPS / widescreen GameShark patch** for R4 exists (GBAtemp thread by
  AEONG_AEONG, Oct 2026; US/JP). The browser core already runs at ~60 fps, so the
  useful part is the **16:9 HUD/FOV patch**, not the frame-rate code.
  - Source: <https://gbatemp.net/threads/i-created-60-fps-widescreen-cheat-codes-for-ridge-racer-type-4.684958/>
  - Next step: add a `WIDESCREEN` setup option that applies the patch through
  EJS cheats (or a patched CHD) and sets the canvas aspect.
- **R4 replay saves / AV player**: R4 can save replays to a memory card and play
  them in the AV player. These can be exchanged as memory-card files, but are
  not a live ghost car.
- **Opponent minimap positions**: the same patch exposes opponent positions on
  the minimap; useful for a LAN ghost HUD if native telemetry is added.

## Native ghost options (research)

1. **R4 replay/memory-card exchange (easiest real-game option).**
   Export/import a memory card or replay block through EJS; LAN players load the
   replay in the AV player. Not during a race.
2. **RAM telemetry ghost (best live option).**
   Read car position/speed from PCSX-Rearmed RAM at a known address, broadcast
   it over the relay, and draw a ghost marker/car overlay. R4 has GameShark
   addresses for speed/car unlocks, but a stable **car world-position** address
   still needs reverse engineering.
3. **Browser ghost clip (implemented now).**
   Record the tab, store a WebM on the host, play it as a PiP ghost while
   racing. It is visible to LAN players and works today, but it is a video
   replay, not a car injected into the game.

## EmulatorJS improvements still available

- **Save-state exchange**: export/import EJS save states between LAN players.
- **Per-game controller profiles**: store mappings per game instead of one
  browser-wide map.
- **Shader presets**: EJS ships CRT/scale shaders; expose a small preset menu
  alongside the CSS filters.
- **Netplay spectator seats**: relay already supports multiple room players;
  add a watch-only seat and a ghost/spectator overlay.
- **Widescreen / 16:9 canvas**: add a per-game aspect option; pair with the R4
  widescreen patch.
- **Disc metadata**: read the CHD/CUE header and show serial/region/tracks in the
  disc deck instead of hard-coded manifest data.
- **LAN ghost leaderboard**: store best lap/time with each ghost and sort the
  deck by track/car.

## Other projects

- **rr-decomp** (`kazuyette/rr-decomp`) is a matching decompilation + native
  static recompilation of the original Ridge Racer. It is useful as a reference
  and for a future native path, but the browser path remains EmulatorJS + the
  PSX disc. No game data is distributed by that repo.
- **Rage Racer PC WASM** feasibility is documented in `RAGE-WASM-REPORT.md`:
  it builds and boots, but the modern renderer (SDL3 GPU) has no Emscripten
  backend; classic PS1 path still rasterises black. EmulatorJS remains the
  playable path.
- **Merserk DLSS 5 Visual Enhancer** is a Windows/DLSS app; the browser gets a
  real-time stage grade, not NGX. See `DLSS5.md`.

## Recommended order

1. Widescreen/R4 patch option in the disc deck.
2. Save-state and memory-card exchange.
3. Native RAM ghost telemetry (if an R4 car-position signature is found).
4. Spectator seats and a ghost leaderboard.
