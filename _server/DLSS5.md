# DLSS 5 visual enhancement in the browser

The user linked <https://github.com/Merserk/dlss5-visual-enhancer>. That project is a
Windows/DirectX application (DLSS NGX, RTX Video, ReShade, frame generation); it cannot be
loaded into the browser page. The browser games therefore use a **real-time DLSS 5
Visual-Enhancer-inspired post-process** on the live output.

## What is applied

`FILTER` menu on `/play` and `/play-net`:

| Choice | Effect |
| --- | --- |
| **DLSS 5** (default) | Stage-level CSS post-process: `contrast(1.08) saturate(1.18) brightness(1.02)` |
| Off | Raw emulator output |
| Scanlines | Dark scanline overlay |
| CRT | Scanlines + vignette + saturation/contrast |
| Vignette | Darkened edges |
| Sharp | Contrast/saturation boost |

The DLSS 5 choice is saved per browser (`rr4.play.filter.v2`). It is applied only after the
first user interaction (or an 8 s fallback / gamepad connect) and after the emulator has a
stable frame, because filtering the WebGL canvas from page load can make Chromium composite it
black.

## Netplay behaviour

- **Single-player (`/play`)**: the stage filter covers the canvas.
- **Netplay guest**: the host's received `<video>` gets the filter.
- **Netplay host**: left raw. Filtering the EmulatorJS 4.3 WebGL canvas/stage is unreliable
  on this build; the guest applies the enhanced look to the received video. This is why the
  host may look unenhanced while the guest looks enhanced.

## Performance

Measured in Brave/Puppeteer at 1280x800 with the R4 CHD: **60.33 emulated fps** with
DLSS 5 on (60.18 Off) on the RTX 5090 ANGLE/D3D11 path. The filter is a single CSS
stage filter; there is no per-frame readback, no neural model, and no extra network
stream. See `DLSS5-QA.md` (29/29 checks; guest stream edge score improves 5.64 -> 6.83).

## Caveat

This is not NVIDIA DLSS 5 / NGX neural rendering. It is a real-time visual grade inspired by
the linked enhancer's look, chosen so the games stay native in the browser at 60 fps. Running
the actual Visual Enhancer pipeline would require the Windows app and per-frame processing
(or an offline pre-enhance pass), not a browser canvas.

Evidence: `_runtime/dlss5-stage-final2.png`, `_runtime/dlss5-8080-20s.png`,
`_runtime/dlss5-ridge-final.png`.
