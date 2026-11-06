# DLSS 5 browser filter — QA

Tested against `http://<host-lan-ip>:8090` with the current `play.js` /
`play-net.js`, real R4/Rage/Ridge CHDs, Brave + Puppeteer, relay on TCP 3010.

## Result

**29 / 29 checks pass, 0 page errors.**

- `/play?game=r4` and `/play?game=rage` boot and render with FILTER defaulting to DLSS 5.
- FILTER sequence DLSS 5 → Off → Scanlines → CRT → Vignette → Sharp → DLSS 5 works;
  the post-process is active only for DLSS 5 and the CSS overlays apply for the others.
- Netplay host boots, creates a room; guest joins and receives a live stream; guest
  input reaches the host. Guest stage grade improves the received image.
- Mobile 390×844: no horizontal overflow; FILTER menu visible and usable.

## Performance

| Mode | Emulated FPS | Notes |
| --- | --- | --- |
| DLSS 5 | **60.33** | stage CSS filter |
| Off | **60.18** | baseline |

Measured at 1280×800 on the RTX 5090 ANGLE/D3D11 path. The filter is a single
CSS stage filter; no readback and no neural model.

## Visual evidence

- R4 near-frame comparison: edge **2.953** vs **2.722** Off (+8.5%), mean luma
  33.27 vs 36.33.
- Netplay guest: edge **6.83** with DLSS 5 vs **5.637** Off; guest screenshot is
  visibly more saturated/contrasted.
- Rage and Ridge Racer render with the DLSS 5 option selected.

## Design notes

- **Single-player**: stage-level CSS grade.
- **Netplay guest**: stage grade over EJS's 2D netplay canvas (host stream).
- **Netplay host**: raw by design; filtering the 4.3 WebGL canvas/stage can
  composite black on this build. The guest applies the grade to the received
  stream.
- The actual Merserk Visual Enhancer is a Windows/DLSS app; this is a real-time
  visual grade, not NVIDIA NGX neural DLSS.

Evidence: `_runtime/dlss5-result.json`, `_runtime/dlss5-net-guest-dlss5.png`,
`_runtime/dlss5-net-guest-off.png`, `_runtime/dlss5-mobile.png`,
`_runtime/dlss5-r4-compare-static-dlss5.png`, `_runtime/dlss5-r4-compare-static-off.png`.
