# EmulatorJS / PCSX-ReARMed performance — Ridge Racer Type 4

**Date:** 2026-11-04  
**Scope:** native browser page `http://<host-lan-ip>:8080/play` (test server on :8080), EmulatorJS **4.2.3**, core **pcsx_rearmed**, OpenBIOS, `R4 - Ridge Racer Type 4 (USA).bin`.  
**No main page files were edited.** `play.html`, `play.js`, `play.css` and `server.js` were left untouched. All measurements are from temporary `_server/perf-*.mjs` scripts and `_runtime/perf/` output.

> The native `Ridge_Racer_4_Recompiled.exe` was **not** launched. "R4 runs" below means the PSX core inside EmulatorJS.

> **Post-change numbers:** the P1–P6 pass (2026-11-06: volume default,
> `preserveDrawingBuffer`, fullscreen cap, grade scope, QUALITY presets,
> `storage.persist`) was measured separately and did not move the baseline:
> **60.19–60.24 emu fps**, CV 1.17–1.27 %, input p50 12.7–14.1 / p95 34.0–38.1 ms,
> warm boot 1568–2475 ms, canvas 960×720 / `preserveDrawingBuffer=false` on plain
> HTTP. Evidence `_runtime/bench-native-after-play-perf*.json`; readable summary
> `docs/pages/play/performance.mdx`.

---

## TL;DR

| Question | Answer |
|---|---|
| Real FPS, LAN HTTP, `?threads=0` | **60.0–60.3 fps** in a 3D race/demo on this machine (RTX 5090, Brave headless, hardware D3D11). Intro/credits also 60.0–60.3 fps. |
| `?threads=1` on `127.0.0.1` | Works (`crossOriginIsolated=true`, `SharedArrayBuffer` available). **60.1–60.2 fps**, no measurable gain over `threads=0`. |
| `?threads=1` on LAN HTTP | **Fails hard**: `SharedArrayBuffer` is `undefined`; EJS shows *“Error for site owner / Check console”* and never starts. |
| Canvas resolution | Desktop 1280×900 → **960×720 backing store** (3× native 320×240), CSS 960×720, `image-rendering: pixelated`. Mobile 390×844 @ DPR 3 → **378×283 backing store**, not 960×720. `300×150` is only the pre-boot HTML canvas default. |
| Keep native 320×240? | **Yes** for PCSX-ReARMed. It has no internal-resolution option in this build; the 960×720 canvas is already a 3× integer upscale. |
| ROM cached? | **Yes.** IndexedDB `EmulatorJS-roms` → key `R4%20-…(USA).bin`, 621,421,920 bytes. A warm boot reads the body from IndexedDB and sends only one `GET` + `Range: bytes=0-0` probe (206), no full ROM GET. |
| First LAN load | Measured 592.6 MiB (621.4 MB) in **1.80 s** on this machine (≈330 MiB/s / 346 MB/s, loopback/LAN-IP path). Estimated real LAN: **6–8 s on 1 Gbit**, **10–18 s on Wi-Fi 5**, **52–60 s on 100 Mbit**, plus 1–4 s boot. |
| Audio click required? | In headless and headful Puppeteer the AudioContext was **already `running`** before a click (48 kHz, `baseLatency` 10 ms, `outputLatency` 40 ms). Real browsers may still suspend it; the page **has** a `CLICK TO RACE` gate (`play.html:115-118`, `play.js`), skips it when the context is already running or when `?embedded=1`, auto-hides after 12 s, and (since 2026-11-06) also unlocks on the first `keydown` or gamepad button. |
| Input latency | Keydown → next emulated frame: median **17–26 ms**, p95 **28–45 ms** (synthetic); CDP key press → next frame: median **16–33 ms** (includes Puppeteer round-trips). Estimated input-to-photon ≈ **33–50 ms** at 60 Hz. |

---

## 1. Environment and method

| Item | Value |
|---|---|
| OS / browser | Windows, Brave **156.1.98.62** (Chromium 156), `headless: 'new'` |
| GPU / renderer | **ANGLE (NVIDIA GeForce RTX 5090, Direct3D11)** — headless Brave used the real GPU by default |
| CPU / RAM | Host is a 28-thread desktop; Brave reports a randomised `hardwareConcurrency` (4–32 across runs) |
| Node | v24.10.0, `puppeteer-core` 25.16 |
| Server | `src/server.js` on `0.0.0.0:8080`; `/play` sends COOP/COEP on a loopback host or HTTPS only (a plain-HTTP LAN origin gets neither); `/rom` supports Range + a strong ETag + `Cache-Control: immutable` |
| EJS | 4.2.3 self-hosted under `public/emulator/data` |
| Core | `pcsx_rearmed` (`EJS_core='psx'`), OpenBIOS `/bios/openbios.bin` |
| ROM | 621,421,920 bytes = 592.6 MiB (621.4 MB), USA `.bin` |
| Profile | `_runtime/perf-profile` (persistent Brave profile, so IndexedDB/HTTP cache survive runs) |

**Measurement code:** `_server/perf-ejs.mjs`.

- Boots the real `/play` page, waits for `window.__R4.startedAt`, clicks the EJS start button if needed.
- Runs `requestAnimationFrame` for N seconds and records every frame delta (p50/p95/p99/max, frames < 20 ms, > 33.4 ms).
- Reads `EJS_emulator.gameManager.getFrameNum()` before/after → **emulator-internal frames per second**. This is the core’s `get_current_frame_count`; for PCSX-ReARMed it tracks `retro_run` and is reliable.
- Reads `EJS_emulator.Module.AL.currentCtx.audioCtx` state, canvas backing/CSS sizes, `crossOriginIsolated`, `SharedArrayBuffer`, WebGL renderer, JS heap, and CDP `Performance` metrics (main-thread busy %).
- Reads IndexedDB `EmulatorJS-roms` / `EmulatorJS-bios` / `EmulatorJS-core` and `performance.getEntriesByType('resource')`.
- Measures input latency two ways: in-page `KeyboardEvent` → next frame-count increment, and CDP `page.keyboard.down()` → next frame-count increment.
- Optionally forces a core (`--core`), EJS settings (`--shader`, `--opt key=value`), a 60 Hz rAF cap (`--raf-cap`), CPU throttling (`--cpu-throttle`), a mobile viewport (`--viewport`, `--mobile`), and fast-forward (`--ff-seconds`) to reach 3D gameplay.

### Headless caveats (important)

- **rAF is not vsync-locked in headless.** Default headless ran rAF at **138–240 fps**, not 60. `--disable-frame-rate-limit` did not reliably cap the game page either. The emulator frame counter is still meaningful for PCSX-ReARMed because the core is timed at ~60 Hz; browser rAF numbers are *not* display frame times.
- **No real display/audio device.** GPU is a desktop RTX 5090, not a phone GPU. Audio latency is from `AudioContext` fields, not an acoustic loopback.
- **Mednafen frame counter is not comparable.** With `mednafen_psx_hw` the counter followed the uncapped frontend (240 fps), not a core-timed 60. Mednafen results below are therefore marked “not a valid game FPS”.
- CPU throttling (`Emulation.setCPUThrottlingRate`) approximates a slower CPU, but not slower memory bandwidth, mobile GPU, thermal throttling or browser differences.
- Input latency measured to the **next emulated frame**, not to photons. Add display/compositor latency for the real input-to-photon number.

---

## 2. FPS results

### 2.1 Plain HTTP LAN, `?threads=0`

URL: `http://<host-lan-ip>:8080/play?threads=0`  
Profile: warm cache unless marked cold. 10 s runs; 3 repetitions for the threads comparison.

| Run | Boot wall | Emulator FPS | rAF FPS (headless) | Main thread busy | Canvas |
|---|---:|---:|---:|---:|---|
| cold, first ever | 4.66 s | 58.57 | 138.5 | — | 960×720 |
| warm, first warm run | 2.49 s | 58.81 | 152.8 | — | 960×720 |
| warm, run 1 | 2.09 s | **60.08** | 201.8 | 48.4 % | 960×720 |
| warm, run 2 | 1.26 s | **60.29** | 192.8 | 52.7 % | 960×720 |
| warm, run 3 | 1.14 s | **60.17** | 205.2 | 46.3 % | 960×720 |
| 3D race/demo, 42 s fast-forward | 1.1 s | **60.27** | 236.3 | 34.9 % | 960×720 |
| 3D race/demo, 45 s fast-forward | 1.1 s | **60.19** | 231.7 | 35.9 % | 960×720 |

The first two runs (58.6–58.8) were taken with the default uncapped headless rAF; later runs with `--disable-frame-rate-limit` settled at **60.0–60.3** core-timed fps even though rAF itself was still uncapped (190–236 fps). The 3D race screenshots show actual road/tunnel/city geometry, not just the intro FMV, and still hit 60.2–60.3 fps.

**Conclusion:** PCSX-ReARMed runs R4 at full speed (60 fps, no frameskip; `pcsx_rearmed_frameskip_type=disabled`) on this machine. Main-thread busy is 35–53 %, so there is headroom.

### 2.2 `?threads=1` on localhost (secure context)

URL: `http://127.0.0.1:8080/play?threads=1`

| Run | Boot wall | Emulator FPS | rAF FPS | Main thread busy | Notes |
|---|---:|---:|---:|---:|---|
| cold on localhost origin | 5.63 s | 59.94 | 157.2 | — | ROM re-downloaded on the 127.0.0.1 origin |
| warm run 1 | 2.09 s | 60.18 | 209.3 | 45.4 % | `crossOriginIsolated=true`, SAB present |
| warm run 2 | 1.10 s | 60.19 | 207.5 | 46.0 % | threaded core |
| warm run 3 | 1.06 s | 60.18 | 188.1 | 53.4 % | threaded core |
| 3D race/demo, 42 s fast-forward | 1.1 s | **60.14** | 239.7 | 33.0 % | threaded core |

**No measurable FPS gain** over `threads=0`. The threaded build exposes an extra core option, `pcsx_rearmed_gpu_thread_rendering` (`disabled|sync|async`), but `async` did **not** improve the throttled case (see §2.4). Threads are not worth the HTTPS/COOP/COEP complexity for this core on this hardware.

### 2.3 `?threads=1` on plain HTTP LAN — fails

URL: `http://<host-lan-ip>:8080/play?threads=1`

Result after 45 s:

```
crossOriginIsolated = false
typeof SharedArrayBuffer = "undefined"
EJS error text: "Error for site owner\nCheck console"
started = false, paused = true
```

The server sends COOP/COEP only on a loopback host or HTTPS, so this LAN origin got
**no** isolation headers at all; Chromium therefore has nothing to ignore and logs
no COOP warning (the 2026-11-04 PLAY-QA run saw one, before the header became
conditional). **Never use `?threads=1` on plain HTTP LAN.** The current `play.js`
default is correct: `threads` is off on insecure origins.

### 2.4 CPU-throttle estimate (desktop → weaker client)

Same page, `?threads=0`, warm cache, 6 s, no shader. Chrome CPU throttling is a rough proxy for a slower laptop/phone CPU.

| Throttle | Emulator FPS | Main thread busy | Notes |
|---:|---:|---:|---|
| 1× (native) | 60.1–60.3 | 35–53 % | desktop |
| 2× | **60.23** | 77.5 % | still full speed, little headroom |
| 4× | **37.01** (intro) / **40.17** (welcome/3D scene) | 99.5–100 % | below 60 |
| 6× | 14.41 | 94.8 % | heavily CPU-bound |
| 8× | 12.77 | 93.3 % | heavily CPU-bound |

At 4× throttle, `threads=1` was **33.18 fps** vs **37.01 fps** for `threads=0`; `pcsx_rearmed_gpu_thread_rendering=async` was **33.33 fps**. Threads did not help the throttled case.

**Interpretation (estimated, not a phone measurement):** a mid-range phone CPU is roughly 3–5× slower per core than this desktop. Expect **~30–45 fps on mid-range phones**, **~60 fps on high-end phones/laptops**, and **60 fps on any recent desktop**. The 2× result shows the desktop only has about 1.3× CPU headroom before dropping below 60.

### 2.5 Shaders

PCSX-ReARMed at 960×720, 6 s, no CPU throttle:

| Shader | Emulator FPS | Main thread busy | Notes |
|---|---:|---:|---|
| disabled | 60.1–60.3 | 35–53 % | baseline |
| `4xScaleHQ` | **60.30** | 51.3 % | GPU cost negligible on RTX 5090 |
| `SABR` | **60.13** | 40.1 % | GPU cost negligible |
| `Bicubic` | **60.15** | 37.9 % | GPU cost negligible |

At **4× CPU throttle** the same shaders are no longer free:

| Shader, 4× throttle | Emulator FPS | vs baseline 37.0 |
|---|---:|---:|
| disabled | 37.0 | — |
| `Bicubic` | 31.7 | **−14 %** |
| `4xScaleHQ` | 24.7 | **−33 %** |

**Recommendation:** shaders are free on a desktop GPU, but `4xScaleHQ` is a bad choice on CPU-limited/mobile devices. Use `Bicubic` if you need smoothing on mobile, or no shader.

### 2.6 `mednafen_psx_hw` (optional) — blocked by BIOS

The core boots, but it **cannot load R4 with OpenBIOS**:

- Default `cue=auto` (raw `.bin`): core starts, but RetroArch shows its **Main Menu** (“Load Content”), not the game.
- `cue=file` (EJS auto-generates a cue): game loads far enough to show the PS1 BIOS screen: **“Firmware is missing: scph5501.bin”**.
- Only `openbios.bin` exists in `_server/game/bios`; mednafen wants a real `scph5501.bin` (or compatible) BIOS.

Mednafen exposes useful options (`beetle_psx_hw_internal_resolution` 1x/2x/4x/8x/16x, `beetle_psx_hw_filter`, etc.), but its `getFrameNum()` followed the uncapped frontend (240 fps) rather than a core-timed 60, so no valid game-FPS number could be produced. **Do not switch to mednafen_psx_hw unless a real PS1 BIOS is added and tested.**

---

## 3. Canvas resolution and image sharpness

Measured via `EJS_onGameStart` + `#game canvas`:

| Context | Canvas backing store | CSS size | DPR | CSS `image-rendering` |
|---|---|---:|---:|---|
| Desktop 1280×900, normal | **960×720** | 960×720 | 1 | `pixelated` |
| Mobile 390×844, `isMobile`, DPR 3 | **378×283** | 378×284 | 3 | `pixelated` |
| Before core start | 300×150 | 960×720 | 1 | `pixelated` |

Key findings:

- **The 300×150 you saw is the HTML canvas default before the core sets it.** Once `EJS_onGameStart` fires, the canvas is 960×720 on a 1280×900 desktop. If you measured a CSS box of 960×794, check which element that was: `play.css` forces `#game` to a 4:3 box, so at 960 px wide the canvas should be 960×720, not 960×794.
- **The canvas backing store follows the CSS box size**, not a fixed 3× native size. On desktop the `#game` box is 960×720, so the canvas is exactly 3× native (320×240 → 960×720) and `image-rendering: pixelated` gives crisp integer-scaled pixels at 1:1 CSS/device pixels.
- On mobile the box is only ~378×283, so the canvas backing store is **~1.18× native**, not 3×. That is good for performance but soft/blocky when the phone’s DPR 3 panel displays 378×283 at ~1134×849 physical pixels.
- In fullscreen on a 1920×1080 desktop, `body.fs #game` becomes 100vw×100vh, so the backing store is **expected** to grow to ~1920×1080 while the source is still 320×240. That is 6× upscaling of 320×240; it will look blocky with `pixelated`, smoother with `image-rendering:auto` or a shader. (Fullscreen backing size was inferred from the CSS, not separately measured.)

### Recommendation

1. **Keep native 320×240 for PCSX-ReARMed.** This core build has no “enhanced resolution” option; the only scaling is the canvas upscale. It costs essentially nothing and is the authentic look.
2. **Desktop:** keep `image-rendering: pixelated` and the 960×720 canvas. If you want smoother edges, `Bicubic`/`SABR` are free at 60 fps on this GPU; `4xScaleHQ` is also 60 fps but 33 % slower under 4× CPU throttle.
3. **Mobile:** do **not** force a higher internal resolution. The canvas is only 378×283; raising the canvas backing store to 960×720 would be supersampling and would cost fill rate. If you want a smoother phone image, switch CSS to `image-rendering: auto` (free) or use `Bicubic`.
4. **Mednafen 2x/4x/8x** internal resolution only makes sense with a real BIOS, and the canvas remains 960×720, so >3× is supersampling/anti-aliasing, not more visible detail. Not recommended for this setup.

---

## 4. Input latency and audio

### Input latency

Measured on the warm LAN page, `?threads=0`, 60 fps:

| Method | Median | p95 | Notes |
|---|---:|---:|---|
| In-page `KeyboardEvent` → next `getFrameNum()` increment | **17.6–20.3 ms** | 28.7–45.3 ms | 8 trials/run, 3 runs; optimistic (no OS/browser input path) |
| CDP `page.keyboard.down()` → next `getFrameNum()` increment | **15.96–33.01 ms** | 32.4–51.5 ms | includes Puppeteer/CDP round-trips; upper bound |
| `threads=1`, synthetic | 17.0–22.7 ms | 32.7–40.0 ms | no improvement |
| 4× CPU throttle, synthetic | 25.6–27.3 ms | 26.7–29.7 ms | latency grows under load |
| 4× CPU throttle, CDP | 55.0–60.9 ms | 56.6–62.5 ms | upper bound |

**Estimated input-to-photon:** the emulator samples input once per 60 Hz frame, then the browser composites. Add one display refresh (~16.7 ms) and compositor latency to the ~17–26 ms measured keydown→frame: **≈33–50 ms typical**, up to ~60–70 ms under heavy CPU load. This is in the same range as the native game through a 60 Hz display; no obvious input buffering problem was found.

### Audio

| Check | Result |
|---|---|
| AudioContext state before click (headless, default policy) | `running` |
| AudioContext state before click (headful, `--autoplay-policy=document-user-activation-required`) | `running` |
| Sample rate | 48,000 Hz |
| `baseLatency` | 0.01 s (10 ms) |
| `outputLatency` | 0.04 s (40 ms) |
| Source states | one `running`, others `null` |
| Volume / muted | 0.7 / false |

In both headless and headful Puppeteer the audio context was already running before the test clicked the canvas. However, EJS starts the game programmatically (`EJS_startOnLoaded=true`), and real Chrome/Edge/Safari autoplay policies may still create the context suspended until a user gesture. **The page does have a sound gate**: `public/play.html:115-118` is `<button id="soundGate" class="sound-gate">CLICK TO RACE</button>` and `play.js` shows it only when the context is not already `running`, hides it after 12 s, and skips it entirely inside the shell (`?embedded=1`). Since 2026-11-06 the first `keydown` and the first gamepad button also call the unlock path, and the volume falls back to 0.70 when the localStorage key is missing (it used to resolve to `EJS_volume = 0`).

---

## 5. ROM caching and first-load time

### Is the 621 MB ROM cached?

**Yes, after the first successful load, in the same browser profile and same origin.**

IndexedDB state after the cold run:

```
database: EmulatorJS-roms, store: rom
  key: "R4%20-%20Ridge%20Racer%20Type%204%20(USA).bin"
  content-length: 621421920
  data.byteLength: 621421920
  key: "openbios.bin"
  content-length: 524288
  type: "bios"
database: EmulatorJS-core
  cached core blobs (pcsx_rearmed-wasm.data, …)
```

Warm-load evidence (2026-11-04 run, before the ranged probe replaced the HEAD):

- Network requests: **HEAD `/rom/…bin` only**; **no GET** for the ROM.
- HEAD response: `200`, `fromCache: true`, `Cache-Control: public, max-age=604800, immutable`.
- `window.__R4.rom` is `null` on warm loads because the XHR progress hook never fires (no download).
- Boot wall: **1.0–2.3 s warm** vs **4.2 s cold** on this machine.

Since 2026-11-06 the page probes with `GET` + `Range: bytes=0-0` (206) instead of a
HEAD, still with no full ROM GET; the 2026-11-06 bench measured 1568 / 2475 ms warm.

The browser HTTP cache can also hold the ROM (`immutable`, Range supported), but it is
not the reuse path the page relies on: EmulatorJS reads the bytes from IndexedDB and
only revalidates with the one-byte range probe.

### Quota / persistence

| Context | `navigator.storage` | Quota | Usage | Persisted |
|---|---|---:|---:|---|
| Plain HTTP LAN (`<host-lan-ip>:8080`) | **undefined** (not a secure context) | — | — | — |
| Localhost (`127.0.0.1:8080`) | available | **2,147,483,648 B (2 GiB)** | 470,411,086 B (~448 MiB) | **false** |

- The ROM is 621.4 MB; quota is 2 GiB, so R4 fits. Rage Racer (~634 MB) would also fit, but both plus saves would be close to the limit.
- `navigator.storage.persist()` is only available on secure contexts. On plain HTTP LAN you cannot request persistence, and the browser may evict IndexedDB under storage pressure.
- **Cache is per-origin.** `http://<host-lan-ip>:8080`, `http://127.0.0.1:8080`, `http://desktop-name:8080` and `https://…` are four separate caches. Use one canonical URL for players or they will re-download 621 MB.

### LAN first-load estimates

Measured local transfer (same machine, LAN IP): **592.6 MiB in 1.797 s ≈ 330 MiB/s ≈ 346 MB/s**. This is server/disk/loopback speed, not Wi-Fi. The 621.4 MB payload is the limit for real clients:

| Client link | Realistic throughput | Payload time (621.4 MB) | + boot (est.) |
|---|---:|---:|---:|
| 1 Gbit Ethernet | 100–118 MB/s | **5.3–6.2 s** | **6–8 s** |
| Wi-Fi 6 (1200 Mbit PHY) | 80–110 MB/s | **5.6–7.8 s** | **7–9 s** |
| Wi-Fi 5 (866 Mbit PHY) | 40–70 MB/s | **8.9–15.5 s** | **10–18 s** |
| 100 Mbit Ethernet | 11.2–11.9 MB/s | **52–55 s** | **54–60 s** |
| 2.4 GHz Wi-Fi (150–300 Mbit PHY) | 15–35 MB/s | **18–41 s** | **20–45 s** |

Cold boot on this machine was 4.2 s; warm boot 1.0–2.3 s. On a phone, add IndexedDB write time and slower CPU for the first load; the network is the dominant term for a cold LAN client.

---

## 6. Recommended configuration

### A. Plain HTTP LAN (current default, no threads)

Use:

```
http://<host-lan-ip>:8080/play?threads=0
```

Keep in `play.js` (already the case):

```js
EJS_core = 'psx';                 // pcsx_rearmed
EJS_biosUrl = '/bios/openbios.bin';
EJS_threads = false;
EJS_disableCue = true;            // raw .bin; no cue needed for pcsx
EJS_startOnLoaded = true;
EJS_CacheLimit = 1073741824;      // 1 GiB; R4 (621 MB) fits
```

Recommendations:

- **Do not use `?threads=1` on HTTP.** It fails before boot.
- Keep the canvas at its natural 960×720 desktop size and `image-rendering: pixelated`.
- Keep `pcsx_rearmed_frameskip_type=disabled` on desktops; it holds 60 fps with 35–53 % main-thread load.
- Keep the ROM cache on. Use a single canonical LAN URL for all players.
- Expect **60 fps on this machine**, **~40 fps at 4× CPU throttle**, and **30–45 fps on mid-range phones** (estimated).
- Optional for weak clients: `EJS_defaultOptions = { pcsx_rearmed_frameskip_type: 'auto_threshold' }` to protect audio at the cost of dropped frames. Test on the target; frameskip can hurt a racing game.

### B. Optional HTTPS / localhost (threads available)

Use only if you want `SharedArrayBuffer`/threads or persistent storage:

```
https://<host>:8443/play?threads=1
http://127.0.0.1:8080/play?threads=1
```

Requirements:

- Valid/trusted HTTPS (or localhost) so `isSecureContext === true`.
- COOP `same-origin` + COEP (`credentialless`) from the server on a loopback or HTTPS origin (the shell whitelist covers `/` and `/play*`, so the embedded frame is isolated too).
- Verify `crossOriginIsolated === true` and `typeof SharedArrayBuffer === 'function'` in DevTools.

Measured result: **60.1–60.2 fps**, same as `threads=0`; no gain on this machine. `threads=1` is not harmful, but it adds TLS/COOP/COEP complexity. If you use HTTPS:

- Call `navigator.storage.persist()` once to reduce eviction risk (quota 2 GiB, usage ~448 MiB, currently `persisted=false`).
- Keep the same origin as the LAN URL if possible; otherwise the 621 MB cache is separate.

**Recommendation:** stay on plain HTTP + `threads=0` unless you have a concrete need for threads. If `play.js` keeps its “secure context → threads on” default, explicitly add `?threads=0` to the canonical URL if you want deterministic behavior.

### C. Mobile

Use:

```
http://<host-lan-ip>:8080/play?threads=0
```

- **PCSX-ReARMed**, native 320×240, shader **disabled**.
- Keep `image-rendering: pixelated` for the retro look, or switch to `auto` for smoother edges (no performance cost).
- Do **not** enable `4xScaleHQ` on phones: at 4× CPU throttle it dropped from 37.0 to 24.7 fps (−33 %). `Bicubic` was 31.7 fps (−14 %) if you need smoothing.
- Canvas on a 390×844 phone is ~378×283, not 960×720; resolution scaling will not add visible detail. Don’t force a larger backing store without testing fill rate.
- First load over Wi-Fi 5: ~10–18 s; Wi-Fi 6: ~7–9 s. Cache the ROM and keep the same origin.
- Expect **~30–45 fps on mid-range phones** and **~60 fps on high-end phones** (estimated from 4× CPU throttle + known phone single-thread performance; not measured on a real phone).
- Add a **touch-friendly click-to-unlock** for audio. EJS’s virtual gamepad appears for touch devices; verify it does not overlap the canvas controls in portrait.
- Optional: `pcsx_rearmed_frameskip_type=auto_threshold` if audio crackles on a weak phone; otherwise leave frameskip off for consistent racing.

### D. Resolution / sharpness summary

| Goal | Recommendation | Cost |
|---|---|---|
| Authentic look, best performance | Native 320×240 + `image-rendering: pixelated` + 960×720 canvas on desktop | ~0 |
| Smoother edges on desktop | `Bicubic` or `SABR` shader | 0 fps on RTX 5090; −14 % at 4× CPU throttle for Bicubic |
| Smoother edges on mobile | CSS `image-rendering: auto` (free) or `Bicubic` | auto: 0; Bicubic: −14 % at 4× throttle |
| More internal detail | `mednafen_psx_hw` with 2×/4× internal res | Requires real `scph5501.bin`; canvas stays 960×720; >3× is supersampling |
| Avoid | `4xScaleHQ` on phones | −33 % at 4× CPU throttle |

---

## 7. Concrete recommendations (short list)

1. **Canonical LAN URL:** `http://<host-lan-ip>:8080/play?threads=0` (or the machine’s single stable hostname, not both). Do not use `?threads=1` over HTTP.
2. **Keep PCSX-ReARMed + OpenBIOS + native 320×240.** It measured 60.0–60.3 fps in both intro and 3D race/demo; mednafen needs a real BIOS and is not a drop-in improvement.
3. **Keep `EJS_CacheLimit = 1 GiB` and IndexedDB caching.** Warm boot is 1–2 s and does not re-download the 621 MB ROM. Add `navigator.storage.persist()` on secure contexts; accept best-effort storage on plain HTTP.
4. **Do not add threads for this core on this hardware.** `threads=1` works on localhost but is 60.1–60.2 fps (same as 0) and 33.2 vs 37.0 fps at 4× CPU throttle. Keep it optional for HTTPS only.
5. **The click-to-unlock gate exists — keep it.** `play.html:115-118` renders
   `#soundGate` (`CLICK TO RACE`); `play.js` shows it only when the AudioContext
   is not already `running`, hides it after 12 s, and skips it for `?embedded=1`.
   Since 2026-11-06 the first `keydown`/gamepad button also unlocks audio, and a
   missing volume key means 0.70 instead of 0, so a fresh profile is audible.
6. **Mobile:** `threads=0`, no shader, native resolution, `pixelated`/`auto`, cache the ROM. Expect 30–45 fps mid-range, 60 high-end; test on the actual phone. Avoid `4xScaleHQ`.
7. **If you want sharper desktop output**, use `Bicubic`/`SABR`; they held 60 fps on the RTX 5090. Don’t raise the canvas backing store without measuring on the target display.

---

## 8. Commands used

All commands run from `<repo>\_server`.

### GPU / rAF probes

```powershell
node perf-gpu-probe.mjs
node perf-raf-probe.mjs
```

### Main FPS runs (cold + warm)

```powershell
# Cold: fresh profile, LAN HTTP, no threads
node perf-ejs.mjs --url "http://<host-lan-ip>:8080/play?threads=0" `
  --label lan-threads0-cold --profile "<repo>/_runtime/perf-profile" `
  --fresh --seconds 10

# Warm: same profile/origin
node perf-ejs.mjs --url "http://<host-lan-ip>:8080/play?threads=0" `
  --label lan-threads0-warm --profile "<repo>/_runtime/perf-profile" `
  --seconds 10
```

### Threads comparison (3 runs each, alternating)

```powershell
$runs = @(
  @{ label='t0-run1'; url='http://<host-lan-ip>:8080/play?threads=0' },
  @{ label='t1-run1'; url='http://127.0.0.1:8080/play?threads=1' },
  @{ label='t0-run2'; url='http://<host-lan-ip>:8080/play?threads=0' },
  @{ label='t1-run2'; url='http://127.0.0.1:8080/play?threads=1' },
  @{ label='t0-run3'; url='http://<host-lan-ip>:8080/play?threads=0' },
  @{ label='t1-run3'; url='http://127.0.0.1:8080/play?threads=1' }
)
foreach ($r in $runs) {
  node perf-ejs.mjs --url $r.url --label $r.label `
    --profile "<repo>/_runtime/perf-profile" --seconds 10 `
    --args "--disable-frame-rate-limit"
}
```

### Threads on plain HTTP (expected failure)

```powershell
node perf-ejs.mjs --url "http://<host-lan-ip>:8080/play?threads=1" `
  --label lan-threads1 --profile "<repo>/_runtime/perf-profile" `
  --seconds 3 --boot-timeout 45000
```

### 3D gameplay (fast-forward through the intro)

```powershell
node perf-ejs.mjs --url "http://<host-lan-ip>:8080/play?threads=0" `
  --label gameplay-t0 --ff-seconds 45 `
  --profile "<repo>/_runtime/perf-profile" --seconds 10 `
  --args "--disable-frame-rate-limit"
```

### CPU-throttle estimate

```powershell
foreach ($n in @(2,4,6,8)) {
  node perf-ejs.mjs --url "http://<host-lan-ip>:8080/play?threads=0" `
    --label "pcsx-cpu${n}x" --cpu-throttle $n `
    --profile "<repo>/_runtime/perf-profile" --seconds 6 `
    --args "--disable-frame-rate-limit"
}
```

### Shaders

```powershell
foreach ($s in @('4xScaleHQ','SABR','Bicubic')) {
  node perf-ejs.mjs --url "http://<host-lan-ip>:8080/play?threads=0" `
    --label "pcsx-shader-$s-uncapped" --shader $s --fresh-localstorage `
    --profile "<repo>/_runtime/perf-profile" --seconds 6 `
    --args "--disable-frame-rate-limit"
}
```

### Core / option inspection and mednafen attempt

```powershell
node perf-inspect.mjs "http://<host-lan-ip>:8080/play?threads=0"

node perf-ejs.mjs --url "http://<host-lan-ip>:8080/play?threads=0&cue=file" `
  --label mednafen-cuefile-1x --core mednafen_psx_hw `
  --opt "beetle_psx_hw_internal_resolution=1x(native)" --raf-cap 60 `
  --fresh-localstorage --profile "<repo>/_runtime/perf-profile" --seconds 6
```

### Mobile viewport

```powershell
node perf-ejs.mjs --url "http://<host-lan-ip>:8080/play?threads=0" `
  --label mobile-390x844 --viewport 390x844 --mobile `
  --profile "<repo>/_runtime/perf-profile" --seconds 6 `
  --args "--disable-frame-rate-limit"
```

### Audio policy check

```powershell
node perf-audio-headful.mjs
```

---

## 9. Artifacts

| Path | Contents |
|---|---|
| `_runtime/perf/*.json` | Raw results: boot timing, emulator FPS, rAF deltas, CPU metrics, canvas/audio/cache data, input latency, console tail |
| `_runtime/perf/*.png` | Screenshots at measurement time (intro, 3D race, mobile layout, shaders) |
| `_runtime/perf-profile/` | Persistent Brave profile with the 621 MB ROM in IndexedDB (~1.0 GB on disk; delete to reclaim) |
| `_server/perf-ejs.mjs` | Main measurement harness |
| `_server/perf-inspect.mjs` | Dumps EJS version, core, core options, canvas, settings |
| `_server/perf-gpu-probe.mjs` | WebGL renderer probe for headless modes |
| `_server/perf-raf-probe.mjs` | Headless rAF cadence probe |
| `_server/perf-drive.mjs` | Presses keys through the intro/credits and screenshots each step |
| `_server/perf-skip.mjs` | Fast-forwards the intro and screenshots the menu/race |
| `_server/perf-audio-headful.mjs` | Headful autoplay-policy / AudioContext check |

Selected screenshots:

- `_runtime/perf/lan-threads0-cold.png` — Namco intro, desktop, 960×720.
- `_runtime/perf/gameplay-t0-42.png` — actual 3D city race, 960×720, 60.27 fps.
- `_runtime/perf/skip-01.png`, `skip-04.png`, `skip-07.png` — 3D race/tunnel/city after fast-forward.
- `_runtime/perf/mobile-390x844.png` — mobile layout, 378×283 canvas.
- `_runtime/perf/pcsx-shader-4xScaleHQ-12s.png` — shader rendering (Namco logo) at 60.33 fps.

---

## 10. What is measured vs estimated

| Claim | Type |
|---|---|
| 60.0–60.3 fps, LAN `threads=0`, intro and 3D race | **Measured** (headless Brave, RTX 5090) |
| 60.1–60.2 fps, localhost `threads=1` | **Measured** |
| `threads=1` fails on LAN HTTP | **Measured** |
| 960×720 desktop / 378×283 mobile canvas | **Measured** |
| 621,421,920-byte ROM in IndexedDB; warm load no ROM GET | **Measured** |
| 1.80 s / 330 MiB/s cold transfer on this machine | **Measured** (loopback/LAN-IP path) |
| 4× CPU throttle → 37–40 fps | **Measured** (Chrome CPU throttling proxy) |
| Phone FPS 30–45 mid-range / 60 high-end | **Estimated** from 4× throttle + typical phone single-thread; not measured on a phone |
| LAN first-load 6–8 s (1 Gbit), 10–18 s (Wi-Fi 5), 52–60 s (100 Mbit) | **Estimated** from measured local throughput and link rates |
| Input-to-photon 33–50 ms | **Estimated** from measured keydown→emulated-frame + one 60 Hz refresh |
| Audio click requirement | **Measured in Puppeteer** (running before click); real-browser policy may differ |
| Mednafen FPS | **Not valid** (content failed; frame counter followed frontend) |
