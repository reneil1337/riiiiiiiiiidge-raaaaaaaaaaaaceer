# EmulatorJS / PCSX-ReARMed — native browser boot report

**Status: WORKING.** Ridge Racer Type 4 boots and plays inside a browser canvas on the
LAN origin `http://<host-lan-ip>:8080/play` with **no video stream** (no ffmpeg, no jsmpeg,
no cabinet window). Verified with headless Brave + Puppeteer on the plain-HTTP LAN origin.

Evidence (screenshots, captured from the real page):

| File | What it shows |
| --- | --- |
| `_runtime/ejs-play/x-after-ff.png` | **R4 gameplay** (third-person race, normal speed), footer `ROM 341 MB · CACHED · BOOT 2.7S` |
| `_runtime/ejs-play/x-8.png` | R4 race with the emulator's "Fast-Forward." indicator |
| `_runtime/ejs-play/08-menu.png` | R4 intro FMV (credit captions) — proves CD/CHD streaming + FMV decode |
| `_runtime/ejs-play/03-started.png` | "CLICK TO RACE / SOUND ON" gate + EJS menu bar + FULLSCREEN button |
| `_runtime/ejs-play/10-fullscreen.png` | Fullscreen mode, game filling the viewport, floating EXIT FULLSCREEN control |
| `_runtime/ejs-play/11-exit-fullscreen.png` | Back to windowed layout after exiting fullscreen |
| `_runtime/ejs-play/13-rage-pending.png` | Rage Racer placeholder ("ROM not installed", no JS errors) |
| `_runtime/ejs-play/12-fs-audio-check.png` | F-shortcut / audio-unlock verification run |

---

## 1. Exact working configuration

| Setting | Value |
| --- | --- |
| EmulatorJS | **v4.2.3** (latest stable, GitHub release `4.2.3.7z`), self-hosted |
| Data path | `/emulator/data/` → `_server/public/emulator/data/` (280 files, 309,375,663 bytes) |
| Core | `EJS_core = 'psx'` → **pcsx_rearmed** |
| Core build | `pcsx_rearmed-wasm.data` (non-threaded) on plain HTTP; `pcsx_rearmed-thread-wasm.data` on `localhost`/HTTPS |
| Game URL | `/rom/r4.chd` (341.2 MiB, 357,817,282 bytes) |
| Fallback game | `/rom/R4 - Ridge Racer Type 4 (USA).bin` (621,421,920 bytes) + real MODE2/2352 cue |
| Cue | `EJS_disableCue = false` (EJS auto-cue). For a `.chd` EJS picks the CHD directly; auto-cue is only used for a raw `.bin`. Both paths boot. |
| BIOS | `EJS_biosUrl = '/bios/openbios.bin'` (OpenBIOS). Core falls back to HLE if the BIOS is not used; both boot. |
| Start | `EJS_startOnLoaded = true`, `EJS_fullscreenOnLoaded = false` |
| Display | `EJS_language='en-US'`, `EJS_disableAutoLang=false`, `EJS_color='#e10600'`, `EJS_volume=0.7` |
| Cache | `EJS_CacheLimit = 1073741824` (1 GiB) → the disc is stored in IndexedDB after the first load |
| Threads | `EJS_threads = window.isSecureContext` (auto). `?threads=1` forces, `?threads=0` disables. **Never enabled by default on plain HTTP.** |
| Isolation headers | `Cross-Origin-Opener-Policy: same-origin` + `Cross-Origin-Embedder-Policy: credentialless` on the document whitelist (`/`, `/welcome`, `/games`, `/multiplayer`, `/lobby`, `/play*`, `/docs/*`, `/music`), and only on a loopback host or HTTPS |
| CDN | none at runtime (verified: zero external requests) |

Boot flag values used in the page (`public/js/play.js`):

```js
window.EJS_player       = '#game';
window.EJS_core         = 'psx';
window.EJS_gameUrl      = '/rom/r4.chd';
window.EJS_pathtodata   = '/emulator/data/';
window.EJS_gameName     = 'Ridge Racer Type 4';
window.EJS_gameID       = 4;
window.EJS_biosUrl      = '/bios/openbios.bin';
window.EJS_startOnLoaded = true;
window.EJS_fullscreenOnLoaded = false;
window.EJS_language     = 'en-US';
window.EJS_disableAutoLang = false;
window.EJS_color        = '#e10600';
window.EJS_volume       = 0.7;
window.EJS_disableCue   = false;              // auto-cue for raw .bin; CHD ignores it
window.EJS_CacheLimit   = 1073741824;
window.EJS_threads      = window.isSecureContext;
```

Since 2026-11-06 `EJS_volume` is `getVolume()`, which falls back to **0.70** when
`localStorage` has no key (it used to be `Number(null) === 0`, i.e. silent), and
the first `keydown`/gamepad button unlocks audio in addition to a pointer click.

### BIOS findings

- `openbios.bin` (512 KiB, `_server/game/bios/`) **works**.
- Full-disk search for `scph5501.bin` / `SCPH1001.BIN` / `scph101.bin` / `scph5500.bin` /
  `scph5502.bin` across `C:\Users`, `C:\Program Files*`, `C:\ProgramData`, `D:\` found **no retail
  BIOS** — only three copies of `openbios.bin`.
- HLE (`EJS_biosUrl=''` / `?bios=hle`) also boots; keep OpenBIOS as the default.

---

## 2. Two-game manifest

`/play` selects a title by query string; `r4` is the default. Rage Racer is wired but its ROM is
not installed yet.

```
/play            → Ridge Racer Type 4 (r4)
/play?game=r4    → Ridge Racer Type 4
/play?game=rage  → Rage Racer (shows "ROM not installed" until the file exists)
```

Manifest shape (`public/js/play.js`):

```js
const GAMES = {
  r4: {
    id: 4,
    name: 'Ridge Racer Type 4',
    subtitle: 'RIDGE RACER TYPE 4',
    region: 'USA',
    rom: '/rom/r4.chd',                                              // default
    fallbackRom: '/rom/R4%20-%20Ridge%20Racer%20Type%204%20(USA).bin',
    cue: '/rom/R4%20-%20Ridge%20Racer%20Type%204%20(USA).cue',
    bios: '/bios/openbios.bin',
    bytes: 357817282,
    available: true,
  },
  rage: {
    id: 5,
    name: 'Rage Racer',
    subtitle: 'RAGE RACER',
    region: 'USA',
    rom: '/rom/Rage%20Racer%20(USA).bin',   // drop the ROM here
    cue: '/rom/Rage%20Racer%20(USA).cue',
    bios: '/bios/openbios.bin',
    bytes: 0,
    available: false,                        // flip to true when the file lands
  },
};
```

To add Rage Racer later: put `Rage Racer (USA).bin` (+ `.cue`) in `<repo>\disc\`,
set `available: true` and `bytes` to the file size (or point `rom` at a `.chd`). No other change
is needed; `/rom` already serves the whole disc folder with Range support.

Other URL params: `?bios=openbios|hle|/bios/file.bin`, `?cue=auto|direct|file`,
`?threads=0|1`, `?debug=1` (unminified EJS sources).

---

## 3. Server changes (`src/server.js`)

Added before the generic `public/` static handler (so policies win) and after it for `/rom`,
`/bios`:

| Route | Source | Headers |
| --- | --- | --- |
| `GET /play`, `/play/`, `/play.html` | `public/play.html` | `COOP: same-origin`, `COEP: credentialless`, `CORP: same-origin`, `Cache-Control: no-cache` — loopback/HTTPS only; a plain-HTTP LAN origin gets no isolation headers |
| `/rom/*` | `<repo>\disc` | strong `ETag` (since 2026-11-06), `Cache-Control: public, max-age=604800, immutable`, `Accept-Ranges: bytes`, `CORP: cross-origin` |
| `/bios/*` | `_server/game/bios` | same as `/rom` |
| `/emulator/*` | `_server/public/emulator` | cores/localization: `max-age=31536000, immutable`; loader/emulator js+css/version.json: `max-age=86400`; rest `max-age=604800` |

Range/HEAD verified:

```
GET/HEAD /rom/r4.chd            → 200 / 206, Content-Range: bytes 0-1023/357817282
GET      /rom/…(USA).bin        → 200, Content-Length: 621421920, Accept-Ranges: bytes
GET      /bios/openbios.bin     → 200, 524288
```

The existing site is untouched: `GET /` returns 200 with the shell document (now
COOP/COEP on loopback/HTTPS only), the same title, and the jsmpeg canvas still present.

---

## 4. Load timings (measured in-page, headless Brave)

| Scenario | Disc bytes | Transfer | Boot to `start` event |
| --- | --- | --- | --- |
| First load, BIN over localhost (127.0.0.1:8099) | 621,421,920 | 1.94 s (≈305 MB/s) | 6.3 s |
| First load, BIN over LAN (<host-lan-ip>:8099) | 621,421,920 | 1.54 s (≈385 MB/s) | 4.8 s |
| First load, BIN over LAN (…:8080) | 621,421,920 | 3.80 s (≈156 MB/s) | 8.4 s |
| **First load, CHD over LAN (…:8080)** | **357,817,282** | **0.96 s (≈355 MB/s)** | **4.5 s** |
| Second load, BIN from IndexedDB cache | — (no GET) | cached | 2.8 s |
| Second load, CHD from IndexedDB cache | — (no GET) | cached | 2.2–2.7 s |

Localhost numbers are RAM/NVMe-bound; the LAN test still runs on the same machine (no Wi-Fi hop).
The CHD is the default because it cuts the first fetch from 621 MB to 341 MB with identical
gameplay.

> Note: `EJS_cacheConfig` (added earlier) is **not read by EmulatorJS 4.2.3** — `loader.js` only
> reads `EJS_CacheLimit`. It is kept for forward compatibility, and `EJS_CacheLimit` is now set
> explicitly to 1 GiB. Cache reuse was verified: the second load issues no `/rom` GET and boots in
> ~2.8 s.

---

## 5. Page features implemented (`public/play.html`, `js/play.js`, `css/play.css`)

- **FULLSCREEN button** in the header, **floating EXIT FULLSCREEN** pill while fullscreen, and an
  **`F`** keyboard shortcut (ignored while typing in the select). Uses
  `document.documentElement.requestFullscreen()` / `exitFullscreen()`, toggles `body.fs`, hides the
  top bar/footer and makes `#game` fill `100vw × 100vh`. Verified: `document.fullscreenElement`
  true, `body.className === 'fs'`, game/canvas 1280×800, exit restores the layout.
- **Click-to-race / sound unlock gate**: appears ~0.6 s after `start`, reads
  `EJS_emulator.Module.AL.currentCtx.audioCtx`, resumes it, calls `EJS_emulator.play()` if paused,
  then hides. It auto-hides after 3.5 s if audio is already running, 12 s otherwise, so it can never
  block the picture. Verified: gate visible → click → `audioUnlocked: true`, AudioContext
  `running` @ 48 kHz, no page errors.
- **Footer disc stat**: reports the largest transferred file (the disc), never the 0.5 MB BIOS.
  Shows `ROM 341 MB in 0.9s · boot 3.3s`, or `ROM 341 MB · cached · boot 2.7s` on a cache hit.
- **Game picker** with `r4` + `rage (ROM pending)`.
- **Zero-CDN shim**: `fetch` to `cdn.emulatorjs.org/<channel>/data/*` is rewritten to
  `/emulator/data/*`. Verified `externalRequests: []` on the LAN run.
- **Favicon**: inline SVG data-URI → no more `404 /favicon.ico`.
- EJS chrome de-emphasised (`#game .ejs_menu_bar { opacity: .28 }`, fades to .96 on hover/focus).
- Canvas box forced to a true 4:3 (EmulatorJS adds `.ejs_parent { width:100%; height:100% }`, which
  otherwise stretches the canvas vertically).

---

## 6. Failures hit and fixes

| Symptom | Cause | Fix |
| --- | --- | --- |
| `Error for site owner / Check console`, no boot on LAN | `EJS_threads=true` while `SharedArrayBuffer` was missing (plain HTTP is not a secure context) | Threads now default to `window.isSecureContext`; non-threaded core on LAN HTTP |
| Footer said `ROM 0.5 MB` | XHR hook recorded the BIOS (`openbios.bin`) after the disc | Keep all transfers, surface the largest; BIOS no longer wins |
| `net::ERR_ABORTED` on the disc URL | HEAD probe whose body was never consumed | Probe with `Range: bytes=0-0` + consume the body (also verifies Range support) |
| `404 /favicon.ico` | no icon | inline SVG favicon |
| Stretched canvas (694 px tall for 890 px wide) | `.ejs_parent { height:100% }` overrides `aspect-ratio` | `#game { height: auto; aspect-ratio: 4/3 }` |
| Port 8099 already taken during testing | other subagent servers on the box | used an isolated instance on 8099 with `RR4_NO_AUTOSTART=1`; final verification on the real `:8080` |

No remaining page errors, no HTTP 4xx/5xx (except the intentional Rage Racer 404), no external
requests.

---

## 7. How to reproduce the test

```powershell
cd _server
$env:RR4_PORT='8099'; $env:RR4_NO_AUTOSTART='1'; $env:RR4_STREAM_SOURCE='test'
node src/server.js            # background
node test-ejs.mjs 'http://<host-lan-ip>:8080/play'
node test-ejs-fs-audio.mjs 'http://<host-lan-ip>:8080/play'
```

`test-ejs.mjs` boots the page, waits for `window.__R4.startedAt`, records console/page/network
errors, clicks the sound gate, presses Start, enters/exits fullscreen, and writes screenshots +
`result.json` to `_runtime/ejs-play/`. `test-ejs-fs-audio.mjs` checks the `F` shortcut and the
WebAudio unlock path.

## 8. Files owned / added

```
_server/public/play.html
_server/public/js/play.js
_server/public/css/play.css
_server/public/emulator/data/**            (EmulatorJS 4.2.3, 280 files, 309 MB)
_server/src/server.js                      (static routes + cache/COOP/COEP headers only)
_server/test-ejs.mjs
_server/test-ejs-fs-audio.mjs
```

The EmulatorJS release archive is kept at `_download/emulatorjs-4.2.3.7z` (289.5 MB) for
re-extraction; the extracted staging copy was removed after copying `data/` into place.
