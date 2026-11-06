# Ridge Racer (1994, original PlayStation) — native browser entry

Added the original **Ridge Racer** as a third native EmulatorJS title, key `ridge`, id `6`.

## Source

| Item | Value |
| --- | --- |
| Download | `<download-dir>\Ridge Racer (USA).7z` |
| Size | 366,411,418 bytes |
| SHA-256 | `92F6E200EACAA1C956A3FB1B6A95BADD8424E3B6D7D6E8DA8B7DB885A057DDFF` |
| Archive contents | 14 BIN tracks + 1 CUE, 467,181,662 bytes raw |
| Disc | Ridge Racer (USA) |
| Serial | **SCUS-94300** (found in Track 01) |
| Region | USA |
| Media | CD-ROM, 1 data track (MODE2/2352) + 13 audio tracks |

The user's `.7z` was complete and stable when inspected (Chrome had already renamed it from
`.crdownload`; no `.crdownload` remained in `<download-dir>`). It was extracted to
`<temp>\ridge-racer-extract`; the original download was
left untouched.

Note: the decompilation reference is the Japanese **SLPS-00001** release; the user's download is the
USA **SCUS-94300** release, so `region: 'USA'` reflects the actual disc.

## Conversion

Tool: `<repo>\_runtime\ejs-assets\tools\chdman.exe` (MAME 0.289, bundled with EJS assets).

```powershell
& '<repo>\_runtime\ejs-assets\tools\chdman.exe' createcd `
  -i '<temp>\ridge-racer-extract\Ridge Racer (USA).cue' `
  -o '<repo>\disc\ridge-racer.chd'
```

| Item | Value |
| --- | --- |
| Output | `<repo>\disc\ridge-racer.chd` |
| Size | 309,882,296 bytes |
| SHA-256 | `3E8EB8EA6FEEF27974EB8AD60A476747E7025F3753560B7AFCE5692658FFDDCB` |
| CHD SHA1 | `8ac66ea834865a693bb2e437b8aedb9cd1256649` |
| Logical size | 486,290,304 bytes |
| Verification | `chdman verify` — "Raw SHA1 verification successful! Overall SHA1 verification successful!" |
| Served at | `http://localhost:8080/rom/ridge-racer.chd` → HTTP 200 / 206, 309,882,296 bytes |

The `/rom` static route already serves `disc/`; no server route changes were needed.

## Manifest changes

`public/js/play.js` and `public/js/play-net.js` — new `GAMES.ridge` entry (same fields as r4/rage):

```js
ridge: {
  id: 6,
  name: 'Ridge Racer',
  subtitle: 'RIDGE RACER',
  region: 'USA',
  rom: '/rom/ridge-racer.chd',
  cue: '',
  bios: '/bios/openbios.bin',
  bytes: 309882296,
  available: true,
},
```

Brand labels are now selected per game key:

- `play.js`: `r4` → `RIDGE RACER TYPE 4`, `rage` → `RAGE RACER`, `ridge` → `RIDGE RACER`.
- `play-net.js`: `r4` → `RIDGE RACER TYPE 4 2P`, `rage` → `RAGE RACER 2P`, `ridge` → `RIDGE RACER 1P`.

The game selector is generated from `GAMES`, so it now lists Ridge Racer Type 4 / Rage Racer /
Ridge Racer with no extra selector code.

## Boot evidence (Brave 156.0.8078.74, headless, localhost:8080)

| Check | Result |
| --- | --- |
| `http://localhost:8080/play?game=ridge` | booted, `__R4.startedAt` set, `bootMs` 2985 (final run), status RUNNING, 0 page/console errors |
| `http://<host-lan-ip>:8080/play?game=ridge` | HTTP 200 (LAN origin; same server) |
| ROM request | `/rom/ridge-racer.chd` HTTP 206 then 200 (range + full) |
| Brand | `RIDGE RACER` |
| Selector | `r4: Ridge Racer Type 4`, `rage: Rage Racer`, `ridge: Ridge Racer` (selected `ridge`) |
| Foot ROM | `ridge-racer.chd` |
| `http://localhost:8080/play` (R4) | booted, status RUNNING, brand `RIDGE RACER TYPE 4`, 0 errors |
| `http://localhost:8080/play?game=rage` | page loads, brand `RAGE RACER`, ROM `rage-racer.chd`, 0 errors |
| `http://localhost:8080/play-net?game=ridge` | page loads, brand `RIDGE RACER 1P`, selector selected `ridge`, ROM `ridge-racer.chd`, 0 errors |

Screenshots (all under `<repo>\_runtime\`):

- `ridge-title-00.png` — Ridge Racer title/logo screen (Namco 1993/1994 copyright).
- `ridge-title-06.png` — main menu (Course/Transmission/Car/Sound Select, START).
- `ridge-capture-ridge-02.png` — "PRODUCED BY namco" boot sequence.
- `ridge-capture-ridge-04.png` — attract-mode race.
- `ridge-verify-ridge.png` — initial page frame (black while the disc loads; expected).
- `ridge-verify-r4-title.png` — R4 intro, regression check.
- `ridge-verify-rage.png` — Rage page with `RAGE RACER` label.
- `ridge-netplay.png` — netplay page for `ridge`.

Raw verification data: `_runtime/ridge-verify-result.json`.

Repro scripts: `_server/verify-ridge.mjs`, `_server/capture-ridge.mjs`, `_server/title-ridge.mjs`,
`_server/r4-title-check.mjs`.

## Caveats

- **Single-player only.** Original Ridge Racer has no split-screen 2P mode; the netplay entry is
  therefore labelled `RIDGE RACER 1P` and runs a single emulated player. R4 remains the 2P title.
- The initial canvas is black for several seconds while the 309 MB CHD streams/loads; the title
  appears after the Namco boot sequence (~20–30 s on the headless SwiftShader test).
- The DLSS agent's `.dlss5-ready` marker appeared after the 15-minute wait; `play.js` and
  `play-net.js` were rewritten at 00:17:34. The `ridge` manifest/brand edits were re-checked after
  that rewrite, `node --check` passes on both files, and `verify-ridge.mjs` re-ran successfully
  (Ridge and R4 both boot, 0 errors).
- Source download preserved at `<download-dir>\Ridge Racer (USA).7z`. No game data was taken
  from `rr-decomp`; the repo was used only as a title/region reference.
- Native `Ridge_Racer_4_Recompiled.exe` / rr-decomp executables were not launched.
