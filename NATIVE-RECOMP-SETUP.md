# Native Windows Recomp — Setup Notes

Session notes for the native **Ridge Racer Type 4 Recomp** install in this folder.
The browser/LAN arcade in `_server/` is a separate project (see `START-HERE.md` and
`README.md`); those files do **not** describe the native install below.

## What was installed

- Upstream release: <https://github.com/omegakatana92/RidgeRacer4Recomp> — `v1.0.0`
  Windows asset `Ridge_Racer_4_Recomp_Windows.zip` (10.1 MB).
- Install root: `<repo>\RidgeRacer4Recomp\`
- Layout verified as the repaired package:

```
Ridge_Racer_4_Recompiled.exe
game.toml
README.md
bios\openbios.bin
bios\OpenBIOS.LICENSE
launcher\ridgeRacer4.bat
launcher\ridgeRacer4.ps1
```

OpenBIOS is bundled, so no retail BIOS is required for the default launch.

## Disc

- User-supplied USA dump, serial **SLUS-00797** (the only supported target in `game.toml`).
- Archive: `R4 - Ridge Racer Type 4 (USA).7z` (345,558,586 bytes).
- Extracted to `<repo>\disc\`:
  - `R4 - Ridge Racer Type 4 (USA).cue`
  - `R4 - Ridge Racer Type 4 (USA).bin`
- Verification:
  - Track 1 size: **621,421,920 bytes** (matches `game.toml`)
  - Track 1 MD5: **BF1D92037B1B2BE83B459C11F0B89EB6** (matches `game.toml`)
- Runtime launcher reported: `Serial SLUS-00797`, `Region NTSC-U`, `ISO head: OK`,
  `Disc verified`.

## Controller

- Pad: **Xbox One Controller** (XInput slot 0).
- Runtime log confirms: `psxrecomp runtime: opened controller for slot: Xbox One Controller`.
- Launcher shows Player 1: **Xbox One Controller**, **Analog**, **connected**.
- Config in `RidgeRacer4Recomp\settings.toml`:

```toml
[controller]
p1_device = "0300938d5e040000ff02000000007200"  # pad GUID; "gamepad" also worked
p1_mode   = "analog"
p1_deadzone = 3276
```

- `RidgeRacer4Recomp\input.ini` has `[controller] enabled = true`, `device = 0`,
  `deadzone = 3277`, with the standard SDL game-controller mapping
  (`a`=Cross, `b`=Circle, `x`=Square, `y`=Triangle, `start`=Start, `back`=Select).
- Keyboard fallback (`keybinds.ini`): arrows steer, `X`=Cross, `S`=Circle,
  `Z`=Square, `A`=Triangle, `Return`=Start, `Right Shift`=Select.

If the pad is reconnected and is not picked up, set `p1_device = "gamepad"` or
reselect it in the launcher's Player 1 device dropdown.

## How to launch

- Launcher (lets you verify disc/pad and choose OpenBIOS):
  `<repo>\RidgeRacer4Recomp\launcher\ridgeRacer4.bat`
- Direct launch, skipping the built-in launcher:

```powershell
& '<repo>\RidgeRacer4Recomp\Ridge_Racer_4_Recompiled.exe' `
  --no-launcher `
  --bios '<repo>\RidgeRacer4Recomp\bios\openbios.bin' `
  --disc '<repo>\disc\R4 - Ridge Racer Type 4 (USA).cue'
```

- Convenience wrapper created in this session:
  `<repo>\Play Ridge Racer 4.bat` (runs the direct command above).

The CUE directory is the working directory so the relative `FILE` entry in the
CUE resolves.

## Fullscreen findings (important)

`RidgeRacer4Recomp\settings.toml`:

```toml
[video]
window_width = 960
fullscreen   = 0
aspect_ratio = "4:3"
```

- `fullscreen = 2` is labelled **Exclusive** in the Settings UI.
- **Exclusive fullscreen changed the desktop to 1024x768**, which is what caused
  the "zoomed in / display weird" symptom. Closing the game restored 3440x1440.
- `fullscreen = 0` is the stable windowed mode (this is what ran normally). It
  is the value left in place at the end of the session.
- The Settings page documents the in-game hotkey **Fullscreen = Alt+Return**
  (`Alt+Enter`). It did not visibly toggle the window during the windowed test.
- The Borderless numeric value has **not** been verified yet. Likely candidates
  are `1` or `3`; test one at a time and confirm the desktop stays 3440x1440.
- Recommended safe state until Borderless is verified: `fullscreen = 0`.
- Present window size is 960-wide 4:3 (PSX native aspect).

## Session changes on disk

- Added `RidgeRacer4Recomp\` (release install) and `disc\` (user dump).
- Added `Play Ridge Racer 4.bat`.
- Edited `RidgeRacer4Recomp\settings.toml`:
  - controller: `p1_device`, `p1_mode = "analog"`
  - fullscreen: `0` -> `1` -> `2` during testing, then reset to `0`
  - `skip_launcher` toggled during testing, left as `true`
- Runtime-generated files also exist in `RidgeRacer4Recomp\`: `settings.toml`,
  `input.ini`, `keybinds.ini`, `card1.mcd`, `card2.mcd`, `bios.cfg`, `disc.cfg`,
  `overlay_captures.json*`, `cache\`, `mods\`, `psx_*_report.json`.
- Screenshots/logs from this session are only in
  `<temp>\` (temporary).

## Known interference

A second OpenCode session is building the browser/LAN arcade (`_server`,
`_runtime`, `analysis`, `LAN-URL.txt`, `REA-ANALYSIS.md`). It also:

- changed `settings.toml` `p1_device` to the pad GUID,
- ran an `RR4-LAN` instance and briefly set the display to 1024x768,
- killed our launcher process (PID 27728) with `Stop-Process -Force`.

Run only one native instance at a time. For parallel testing use separate copies
and `--window-title` / `--memcard-dir` so the sessions do not overwrite each
other's config or memory cards.

## Not documented / still open

- Borderless fullscreen value and whether it fills 3440x1440 without a mode switch.
- End-to-end confirmation that every pad button reaches the game (the runtime log
  proves the pad is opened; button-by-button verification was not recorded).
- The other session's `_server` browser/LAN work is documented separately in
  `START-HERE.md`, `README.md`, and `_server/README.md`.
