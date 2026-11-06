# Rage Racer PC → WebAssembly feasibility

Date: 2026-11-05
Repo: `_runtime/rage-racer-pc` (clone of https://github.com/khasinski/rage-racer-pc, submodules included)
Toolchain: Emscripten **6.0.13**, CMake **3.31.8**, Ninja **1.12.1** (installed under `_runtime/emsdk`, `_runtime/cmake`, `_runtime/ninja`)
Status: **classic renderer boots and plays the opening FMV in WebGL2; the modern renderer is a hard blocker**

---

## 1. Verdict

| Question | Answer |
|---|---|
| Does the C codebase compile to wasm? | **Yes.** 856 objects, `libchdr` + zstd/lzma/miniz + SDL 3.4.12 + PSY-Z + the recovered game all compile. |
| Does it boot in a browser? | **Yes.** CHD mounts, native assets import, menu music is generated, WebGL2 (GLES 3.0) context is created, opening FMV renders with audio-less playback. |
| Is the *modern* renderer available? | **No.** It is written against **SDL3 GPU**, and SDL 3.4.12 has no Emscripten/WebGPU backend. |
| Is the *classic* renderer usable? | Not yet. FMV (direct VRAM upload) draws, but the PS1 primitive path submits packets and rasterises black. |
| Can we ship this in place of the native/streamed cabinet? | **No.** Only worth pursuing as a classic-mode prototype. |
| Best fallback | **EmulatorJS with the Rage Racer PSX disc** (already the critical path). |

**Recommendation: NO-GO for parity; GO (optional) for a classic-only prototype.**

---

## 2. What the port actually is

- `CMakeLists.txt` is C17, one `rage-racer` executable plus tools/tests.
- The renderer is **not OpenGL**. `src/port/modern/*` calls `SDL_GPUTexture`, `SDL_GPUGraphicsPipeline`, `SDL_BeginGPURenderPass`, storage buffers, etc.
- Shaders are embedded **SPIR-V and MSL** (`src/port/modern/shaders/*_spv.h`, `*_msl.h`) and selected via `SDL_GetGPUShaderFormats`. There is no GLSL/WGSL path.
- PSY-Z (`external/psyz`) is the PS1 compatibility layer. Its own renderer is selectable:
  - `PSYZ_RENDERER=sdl3_gpu` (default) → SDL3 GPU, same problem as above.
  - `PSYZ_RENDERER=sdl3_gl` → OpenGL/GLES, and it explicitly supports `PSYZ_VIDEO_GLES` + GLES 3.0.
- The game's video path is PSY-Z → VRAM texture/FBO → present. The "modern" renderer is a second renderer that replaces the present source through `psyz/present_sdl3_gpu.h`.
- No threads in the port (`pthread`/`SDL_CreateThread` absent). SDL/PSY-Z use none for the game loop.
- The disc is read with `fopen`/`fseek`/`fread` through `DiscRawFile`/`DiscIso`, or through `libchdr` for `.chd`. Discovery uses `opendir`/`stat`. All of that works on Emscripten's MEMFS/IDBFS/OPFS.
- The disc picker uses `SDL_ShowOpenFileDialog` and a blocking `SDL_Delay` poll; **the SDL3 Emscripten backend has no file dialog**, so the browser build must set `disc.image` itself.

---

## 3. Build result

Commands (reproducible):

```bat
call _runtime\emsdk\emsdk_env.bat
set PATH=<repo>\_runtime\cmake\bin;<repo>\_runtime\ninja;%PATH%
cd _runtime\rage-racer-pc
emcmake cmake -S . -B build-wasm -G Ninja ^
  -DCMAKE_BUILD_TYPE=Release ^
  -DRAGE_BUILD_PORT=ON -DPSYZ_RENDERER=sdl3_gl ^
  -DBUILD_TESTING=OFF -DRAGE_ENABLE_LINT=OFF -DRAGE_EMBED_AUTHORED_CARS=OFF ^
  "-DRAGE_WASM_PRELOAD_DISC=D:/rr-wasm/disc.bin" "-DRAGE_WASM_PRELOAD_TARGET=/disc/R4.chd"
cmake --build build-wasm --target rage-racer -j 12
```

Artifacts (`build-wasm/`):

| File | Size |
|---|---|
| `rage-racer.wasm` | **2.59 MB** |
| `rage-racer.js` | **0.21 MB** |
| `rage-racer.data` (preloaded disc) | **472.35 MB** (uncompressed CHD) |

Memory: the static image needs **140,891,792 bytes**; the build uses `-sINITIAL_MEMORY=256MB`, `-sMAXIMUM_MEMORY=2GB`, `-sALLOW_MEMORY_GROWTH=1`, `-sSTACK_SIZE=8MB`.

`emcmake` reported the SDL backend table, which is the core finding:

```
Video drivers: dummy emscripten offscreen
Render drivers: ogl_es2
GPU drivers:            <-- empty
Audio drivers: disk dummy emscripten
```

`SDL_GPU` compiles to zero backends on Emscripten because only `d3d12`, `metal`, and `vulkan` exist under `external/psyz/external/SDL/src/gpu/`.

---

## 4. Runtime evidence

Boot log (from the game's own `/stderr` inside MEMFS, browser):

```
rage-port: renderer=classic scale=4.00 aspect=2 fps=-1 draw_distance=1.00 post=1
rage-port: CHD disc opened (17 tracks)
rage-port: disc SLUS_004.03 region=NTSC-U
rage-port: native asset source=live C importer
[I][psyz/src/platform/sdl3_gl.c:383][InitPlatform] opengl es 3.0 initialized
[I][psyz/src/platform/sdl3_gl.c:384][InitPlatform] renderer: WebKit WebGL
[I][psyz/src/platform/sdl3_common.h:301][ConfigureVSync] detected 60.00 Hz monitor
[I][psyz/src/psyz/psyz_spu.c:177][Psyz_SpuInit] SPU emulation initialized
rage-port: generated menu music PCM: /home/web_user/.config/rage-racer/menu_music.v9.NTSC-U.wav
boot: done
```

Scene progression observed: `scene id=1` (boot logo) → `id=5` (FMV, ~60 s) → `id=3` → `id=4`, reaching frame **3699 after ~70 s (~53 fps under SwiftShader/headless Chrome)**.

The opening movie renders correctly (Namco logo, "Teach this sucker a lesson" subtitle). Reproduced after cleanup with `_runtime/wasm-test/canvas-20.png`.

What this proves:

- The recovered game logic, CD/ISO reader, libchdr (zstd/lzma), PSY-Z GTE/SPU/CD, asset importer, and the WebGL2 presentation path all execute in wasm.
- The only thing the browser sees as black is the **PS1 primitive rasteriser** path.

---

## 5. Blockers found, in order of severity

### 5.1 HARD: the modern renderer requires SDL3 GPU (no Emscripten backend)

- `SDL_CreateGPUDevice` cannot succeed: `GPU drivers:` is empty.
- Shaders are SPIR-V/MSL; WebGPU wants WGSL. Metal/D3D12/Vulkan code paths are irrelevant in the browser.
- The renderer uses `SDL_GPU_BUFFERUSAGE_GRAPHICS_STORAGE_READ` (SSBO). **WebGL2 is GLES 3.0 and has no SSBO**, so a WebGL2 rewrite is not a mechanical port either.
- `src/port/modern` is ~7,000 lines (`modern_native_gpu.c` alone 2,251; `modern_renderer.c` 1,889), plus ~250 embedded `.inc` meshes and the shader set.

Two realistic routes:

1. **WebGPU**: add an SDL3 GPU WebGPU backend upstream (or vendor a fork), translate SPIR-V→WGSL (naga/tint) and keep the renderer. Requires WebGPU-capable browsers and an SDL fork.
2. **WebGL2 rewrite** of the modern renderer: replace SSBOs with UBOs/textures, re-emit shaders as GLSL ES 3.00, redo pipeline state. Largest and least attractive.

Per `AGENTS.md`, the shipping contract requires the modern renderer, so a classic-only build does **not** satisfy it.

### 5.2 Classic primitive path rasterises black (debuggable)

- `Psyz_GpuExeque` receives work (e.g. ~50 GP0 words/frame in scene 4, ~15k words during the FMV).
- `DispatchPackets`/`Draw_FlushBuffer` run, GL context is live, and FMV frames uploaded straight into `vram_texture` display correctly through the same present path.
- Therefore the failure is inside PSY-Z's GL primitive draw (shader/attribute/scissor/FBO state under GLES 3.0), not in presentation.
- Ruled out: scaled-VRAM path (`video.internal_scale=1` still black) and missing draw submission.

### 5.3 Audio callback + ASYNCIFY = per-frame wasm trap

- With audio enabled, every frame produced `RuntimeError: function signature mismatch` from a JS→wasm `dynCall` (the SDL audio-stream callback).
- `ASYNCIFY` rewrites callable signatures; a callback invoked from JS with the original signature traps.
- Confirmed by adding `PSYZ_AUDIO_OFF=1`: **zero** page errors for the whole run.
- Fix options: `-sASYNCIFY_REMOVE=audio_callback` (cheap, callback must not unwind), or drive the frame loop with `emscripten_set_main_loop` and drop ASYNCIFY entirely (cleaner, more work).

### 5.4 Disc naming: PAL archive names are required

- `HostFindArchive()` looks for **`RAGE.BIN`** and **`RAGE.STR`**.
- The USA Track 01 BIN in `<repo>\disc` contains `R4.BIN` / `R4.STR` → `failed to initialize disc image`.
- A CHD from `_runtime/ejs-assets/rage-racer.chd` mounts fine (`SLUS_004.03`, NTSC-U, 17 tracks) because its ISO uses the expected names.
- PAL discs are the intended input, so this is a note, not a blocker, but the browser build must be tested with a PAL CUE/CHD.

### 5.5 Browser I/O plumbing still missing

- No file picker on Emscripten → the host page must set `--set disc.image=/disc/...` (or a future upload UI).
- Saves, the generated menu-music WAV, and the remembered disc path go to `/home/web_user/...` in **MEMFS** → lost on reload. Needs IDBFS (or OPFS) mounted over that path.
- `diagnostics.log` calls `freopen(path, "a", stderr)`, so all game logging disappears into the FS after the first line; the test harness had to read `/stderr` via `Module.FS`.

---

## 6. Disc/assets in the browser

The game streams sectors from the image for the whole session (CD audio, FMV, on-demand asset loads), so the **complete image must be readable**, not just a pre-extracted RAGE.BIN.

| Item | Size |
|---|---|
| PAL Track 01 BIN | ~592 MB (USA dump: 592.6 MiB / 621,421,920 B) |
| CHD (zstd/lzma) | 340–475 MB (`rage-racer.chd` = 472 MB, `r4.chd` = 341 MB) |
| wasm + js | 2.8 MB (≈1.2 MB gzip wasm) |
| Modern native-asset cache | extra (generated from disc; not measured) |

Options, best → worst:

1. **OPFS** (Emscripten 6 ships `libopfs.js` / `libwasmfs_opfs.js`): one-time "select your disc" upload writes the file into Origin Private File System, then `FS.mount` it; persists across reloads, no copy into wasm memory. Requires a modern browser and a small custom JS shell.
2. **IDBFS** at `/home/web_user`: works today, but 500 MB in IndexedDB is slow to write and subject to quota/eviction.
3. **`--preload-file`** (what the test used): simple, but forces a 472 MB download before `main()`, holds it in MEMFS, and produces a 472 MB `.data` bundle. Fine for a demo, bad for users.
4. **WORKERFS** (mount a `File` object without copying): needs `-pthread`, which the port otherwise does not need.

Recommended production shape: fetch/upload once → OPFS → `disc.image=/persist/R4.chd` → IDBFS for saves. Offer CHD (≈472 MB) over BIN (≈592 MB), and document that the user must supply their own disc.

---

## 7. Patches applied to make it build/boot

All are in `_runtime/rage-racer-pc` (scratch clone, not committed). None touch `_server`.

| File | Change | Why |
|---|---|---|
| `CMakeLists.txt` | Emscripten block: `SDL3-static` `C_EXTENSIONS ON`; `PATH_MAX=4096`; link flags (`MAX_WEBGL_VERSION=2`, `FULL_ES3`, memory, `ASYNCIFY`, FS export, `EXIT_RUNTIME=0`); `RAGE_WASM_PRELOAD_DISC/TARGET`; `RAGE_WASM_DEBUG/ASYNCIFY` options; stub source | SDL uses `EM_ASM` (GNU C only); no `PATH_MAX` in Emscripten; needed WebGL2 + ES3; disc preload |
| `src/port/wasm/psyz_sdl3gpu_stubs.c` (new) | stubs for `Psyz_*_SDL3GPU`, `Psyz_GpuTextureUploadContext` | modern renderer references the SDL3-GPU bridge unconditionally |
| `external/psyz/psyz/src/platform/sdl3_gl.c` | restored `FixupFlipUV()` (deleted by the SDL3-GPU commit, call left behind); added `Psyz_VideoUploadRgb24Frame()` | GL backend only compiled where implicit declarations are tolerated; FMV upload existed only in the GPU backend |
| `external/psyz/psyz/include/libapi.h` | `#ifndef` guards around `SEEK_SET`/`SEEK_CUR` | collide with Emscripten's `unistd.h` under `-Werror` |
| `include/game/cd.h` | `int CdMix(void*)` (was `void CdMix(u8*)`) | wasm `call_indirect` cannot paper over return-type mismatch; this was the first boot trap |
| `external/psyz/psyz/src/psyz/libgpu.c` | `psyz_cwb(u32*, s32)`, `psyz_otc()` returns `int`, `GPU_Enqueue`/`_addque2`/`_exeque` signatures aligned; `struct Gpu` fields updated | per-frame vtable `call_indirect` traps |
| `external/psyz/decomp/src/libgpu/sys.c` | `struct Gpu.cwc` returns `int` | same ABI cleanup |
| `external/psyz/psyz/src/psyz/libcd.c` | `CD_datasync(int)` returns `int`; `CD_getsector2(void*, int)` | linker "function signature mismatch" warnings |
| `external/psyz/psyz/src/platform/sdl3_audio.c` | `PSYZ_AUDIO_OFF` switch | isolate the ASYNCIFY audio-callback trap |

With these, the build has **no remaining `wasm-ld: function signature mismatch` warnings**.

---

## 8. Effort estimate

| Milestone | Work | Estimate |
|---|---|---|
| Build + boot (done) | toolchain, ABI fixes, stubs | ~1.5 days |
| **Classic-mode playable prototype** | fix PSY-Z GL primitive path on GLES3, audio (ASYNCIFY remove / main-loop refactor), input mapping, OPFS/IDBFS disc + saves, small shell UI | **3–5 weeks** |
| **Modern-renderer parity** (shipping contract) | SDL3 WebGPU backend + SPIR-V→WGSL, or WebGL2 rewrite of ~7k lines incl. SSBO removal, shader translation, validation | **2–4 months** |
| Polish (gamepad, fullscreen, mobile, QA) | | +2–3 weeks |

Assumes one developer already familiar with the port; the modern-renderer route carries high technical risk (no upstream SDL3 WebGPU backend at 3.4.12).

---

## 9. Fallback (recommended)

**EmulatorJS + the Rage Racer PSX disc.** It is the pragmatic path and is already in flight:

- No C/WASM porting risk; the PSX disc is the only payload.
- Expected payload: CHD 340–475 MB (the existing `_runtime/ejs-assets/rage-racer.chd` is 472 MB, `r4.chd` 341 MB) vs. a native-assets + modern-renderer WASM build that would still need the disc.
- EmulatorJS already handles disc mounting, save states, gamepad, and audio in the browser.

Keep the WASM work as an optional "native port in the browser" demo once the classic renderer and audio are fixed; do not block the EmulatorJS critical path on it.

---

## 10. Reproduction / harness

Everything lives under `_runtime`:

```
_runtime/emsdk/                 Emscripten 6.0.13
_runtime/cmake/                 CMake 3.31.8
_runtime/ninja/                 Ninja 1.12.1
_runtime/wabt/                  wasm-objdump for symbolisation
_runtime/rage-racer-pc/         clone + patches
_runtime/rage-racer-pc/build-wasm/       release build (472 MB .data)
_runtime/rage-racer-pc/build-wasm-dbg/   RelWithDebInfo + ASSERTIONS
_runtime/wasm-test/index.html   shell (Module.arguments, PSYZ_AUDIO_OFF)
_runtime/wasm-test/serve.mjs    static server (PORT/ROOT env)
_runtime/wasm-test/canvas.mjs   puppeteer-core harness, saves canvas PNGs
_runtime/wasm-test/canvas-20.png         proof: opening FMV in WebGL2
```

Run:

```bat
cd _runtime\wasm-test
set PORT=8137
set ROOT=<repo>/_runtime/rage-racer-pc/build-wasm
node serve.mjs
:: second terminal
node canvas.mjs 60
```

Chrome is driven headless with `--use-gl=angle --use-angle=swiftshader --enable-unsafe-swiftshader` (software WebGL2; real GPUs will be faster than the observed ~53 fps).

`_runtime/wasm-configure.cmd` and `_runtime/wasm-build.cmd` wrap the configure/build steps.

---

## 11. One-line summary

The port **builds and boots to the point of playing its opening FMV in a browser at ~53 fps**, which validates the whole C/PSY-Z/CD stack on wasm; it is blocked from shipping by the **SDL3-GPU-only modern renderer (no Emscripten backend, SPIR-V/MSL shaders, SSBOs)** plus a **black PS1 primitive path** and an **ASYNCIFY audio-callback trap** — so: **classic prototype feasible in weeks, parity in months, EmulatorJS remains the right answer now.**
