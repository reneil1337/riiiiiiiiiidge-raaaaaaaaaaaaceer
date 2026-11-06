# EmulatorJS / PSX disc & BIOS assets

Status: **ready** — a 341 MiB single-file CHD boots Ridge Racer Type 4 (USA) in the
self-hosted EmulatorJS 4.2.3 / `pcsx_rearmed` build, verified end-to-end in headless
Chrome (title screen + intro movie, no BIOS, no server changes).

Owner of this document: assets subagent. The page (`public/play.html`,
`public/js/play.js`), CSS and `src/server.js` are owned elsewhere and were **read
only** while producing this.

---

## 1. TL;DR for the page owner

`public/js/play.js` currently declares, in the game manifest:

```js
rom: '/rom/R4%20-%20Ridge%20Racer%20Type%204%20(USA).bin',   // 592.6 MiB
cue: '/rom/R4%20-%20Ridge%20Racer%20Type%204%20(USA).cue',
bios: '/bios/openbios.bin',
```

Change only the ROM entry (the CUE entry is unused in `cue=auto` mode):

```js
rom: '/rom/r4.chd',            // 341.2 MiB, single file, verified working
bytes: 357817282,              // line 30; also refreshed at runtime from the probe (line 379)
```

That is the whole change. `/rom/r4.chd` already exists on the live server
(`<repo>\disc\r4.chd`, an NTFS hardlink to
`_runtime/ejs-assets/r4.chd`, 0 extra bytes) and is served by the existing
`app.use('/rom', express.static(romDir, …))` route with `Accept-Ranges`,
`Content-Length`, `Cache-Control: public, max-age=604800, immutable` and CORS.

`play.html` line 29 hard-codes the hint `621 MB · served from this machine`;
it should read `341 MB` when the CHD is used.

No BIOS change is required. `EJS_biosUrl` can stay `/bios/openbios.bin` or become
`''` — the core ends up on HLE either way for R4 (see §2).

`EJS_disableCue` needs no change: both `auto` (EJS generates `r4-0.cue` around the
CHD) and `direct` (`EJS_disableCue = true`, raw `r4.chd` handed to the core) were
tested and both boot.

---

## 2. BIOS options

### What is on this PC

Searched `C:\`, `D:\`, `E:\` for files named `scph5501.bin`, `SCPH1001.BIN`,
`scph101.bin`, `PSXONPSP660.bin`, `scph5500/5502/7001/7502/1000.bin`, for any
`*bios*` file between 128 KiB and 4 MiB, and for any `*.bin`/`*.rom` of exactly
512 KiB or 2 MiB (Downloads, Desktop, Documents, AppData, Program Files, emulator
folders, all drive roots).

**No retail PS1 BIOS dump exists on this machine.** Only OpenBIOS, in three
identical copies:

| Path | Size | MD5 | SHA-1 |
|---|---|---|---|
| `_server\game\bios\openbios.bin` | 524288 | `F87EECA966524EDBD8D70B94A5B96192` | `95419841B5104D552B14810B1ECBE6C1358BCDF1` |
| `RidgeRacer4Recomp\bios\openbios.bin` | 524288 | `F87EECA966524EDBD8D70B94A5B96192` | `95419841B5104D552B14810B1ECBE6C1358BCDF1` |
| `%TEMP%\opencode\psxrecomp\bios\openbios.bin` | 524288 | `F87EECA966524EDBD8D70B94A5B96192` | `95419841B5104D552B14810B1ECBE6C1358BCDF1` |

(OpenBIOS is GPL — see `_server/game/bios/OpenBIOS.LICENSE`. It is redistributable,
but it is not what the core ends up using here.)

### What `pcsx_rearmed` actually does

`pcsx_rearmed` searches its system directory for, in order:
`scph5500.bin`, `scph5501.bin`, `scph5502.bin`, `psxonpsp660.bin`, `scph7001.bin`,
`scph1001.bin`, then any `scph*` file, and validates the content. If nothing
valid is found it silently uses its built-in **HLE** BIOS.

Observed on this build (EJS 4.2.3, `pcsx_rearmed-wasm.data`):

| BIOS passed | Result |
|---|---|
| none (`EJS_biosUrl = ''`) | boots to R4 title/intro — **HLE** |
| `/bios/openbios.bin` | identical, boots to R4 title/intro (OpenBIOS shell never appears) |
| 512 KiB of random bytes renamed `scph5501.bin` | **still boots to R4 title/intro** |

The last row is the important one: an unrecognisable 512 KiB blob does not break
the boot, so the core is falling back to HLE rather than executing the file. The
practical conclusion for this project:

* **Use HLE.** It is the only option verified to work here, it is zero-download,
  and R4's boot, FMV, XA audio streaming and disc access all work with it.
* OpenBIOS is harmless but pointless as configured: it is not named `scph*.bin`
  (so the filename scan misses it), and even when renamed it is not recognised.
  Keeping `EJS_biosUrl='/bios/openbios.bin'` costs one 512 KiB request and changes
  nothing; setting it to `''` is marginally cleaner.
* A retail dump would only matter for BIOS-level UI (memory-card manager, CD
  player) and for the small set of games that need real CD-ROM timing. If one is
  ever dropped into `_server/game/bios/`, name it `scph5501.bin` (US) so the
  filename scan finds it, and verify the hash first.

Expected retail hashes (from the EmulatorJS PlayStation docs / libretro core info):

| File | Region / version | MD5 |
|---|---|---|
| `scph5500.bin` | JP v3.0 | `8dd7d5296a650fac7319bce665a6a53c` |
| `scph5501.bin` | US v3.0 | `490f666e1afb15b7362b406ed1cea246` |
| `scph5502.bin` | EU v3.0 | `32736f17079d0b2b7024407c39bd3050` |
| `psxonpsp660.bin` | PSP PS1 emu | `c53ca5908936d412331790f4426c6c33` |
| `scph101.bin` | US v4.4 | `6e3735ff4c7dc899ee98981385f6f3d0` |
| `scph7001.bin` | US v4.1 | `1e68c231d0896b7eadcad1d7d8e76129` |
| `scph1001.bin` | US v2.0 | `924e392ed05558ffdb115408c263dccf` |

Verify with `Get-FileHash <file> -Algorithm MD5`. Do not redistribute retail dumps.

---

## 3. Disc → CHD conversion

Source (untouched): `disc\R4 - Ridge Racer Type 4 (USA).bin` +
`disc\R4 - Ridge Racer Type 4 (USA).cue` — single track `MODE2/2352`,
264 210 sectors, volume label `R4USA`, PVD `PLAYSTATION`.

Tool: `chdman` 0.289 from the official MAME 0.289 Windows build
(`https://github.com/mamedev/mame/releases/download/mame0289/mame0289b_x64.exe`,
87.6 MB self-extracting 7-Zip; only `chdman.exe` was kept).

```powershell
# one-off tool install (already done)
#   7z-SFX: mame0289b_x64.exe -o<dir> -y   →  <dir>\chdman.exe
#   copied to _runtime\ejs-assets\tools\chdman.exe

& .\_runtime\ejs-assets\tools\chdman.exe createcd `
    -i '<repo>\disc\R4 - Ridge Racer Type 4 (USA).cue' `
    -o '<repo>\_runtime\ejs-assets\r4.chd' `
    -c cdlz,cdzl,cdfl -np 8
# 9.8 s wall clock, "final ratio = 55.3%"
```

Result:

```
Input file:   r4.chd
File Version: 5
Logical size: 646,790,976 bytes
Hunk Size:    19,584 bytes
Total Hunks:  33,027
Unit Size:    2,448 bytes
Total Units:  264,212
Compression:  cdlz (CD LZMA), cdzl (CD Deflate), cdfl (CD FLAC)
CHD size:     357,817,282 bytes
Ratio:        55.3%
SHA1:         f637a55052d40c054ea10b724e639658ab334617
Data SHA1:    6b025bbaaecd4a85ab5bf69d085a4e159dfe89b7
Metadata:     Tag='CHT2' TRACK:1 TYPE:MODE2_RAW SUBTYPE:NONE FRAMES:264210 PREGAP:0
```

Verification performed:

* `chdman verify -i r4.chd` → `Raw SHA1 verification successful! Overall SHA1
  verification successful!` (11.4 s).
* `chdman extractcd` round-trip → 621 421 920-byte BIN, MD5
  `BF1D92037B1B2BE83B459C11F0B89EB6` = **byte-identical to the original BIN**
  (temp copy deleted afterwards).

File hashes:

| File | Size | MiB | MD5 | SHA-1 |
|---|---|---|---|---|
| `r4.chd` | 357 817 282 | 341.2 | `623C50C5654EF96CA9033FAA83F78237` | `6A91320F2FDF9E1602B7CB0F35EA265F1B984389` |
| `r4.zip` (fallback) | 386 878 171 | 369.0 | `6B95EE6F10B25435A4448703CD5438A0` | — |
| original `.bin` | 621 421 920 | 592.6 | — | `75F0DAB5C1F71BA80F3D1E2FEFD043F3F2B9EE2E` |

### Fallback single-file alternatives (measured)

| Format | Size | Works in EJS? | Notes |
|---|---|---|---|
| **CHD** (`cdlz`) | **341.2 MiB (55.3 %)** | **yes, verified** | Best size, per-hunk random access, no client-side decompression |
| ZIP (cue+bin, deflate 9) | 369.0 MiB (62.3 %) | yes, verified | EJS unzips fully in JS → 592 MiB ArrayBuffer in the tab; slower start, more RAM |
| PBP | ~590 MiB | untested | Requires `psxpackager`/`.NET`; ~no compression for a data-only disc, so not worth it here |

ZIP creation command (already run, kept only as a tested fallback):

```powershell
python -c "import zipfile; z=zipfile.ZipFile(r'r4.zip','w',zipfile.ZIP_DEFLATED,compresslevel=9); z.write(r'...\R4 - Ridge Racer Type 4 (USA).cue','R4.cue'); z.write(r'...\R4 - Ridge Racer Type 4 (USA).bin','R4.bin'); z.close()"
```

---

## 4. Loading test (EmulatorJS + CHD)

Harness (mine, throw-away): `_runtime/ejs-assets/test/probe.cjs` — a tiny Node
static server that serves the **real** `public/emulator/data` tree plus the ROM
under `/rom/…`, then boots it in headless Chrome (puppeteer-core already in
`_server/node_modules`) and screenshots the canvas.

Run: `node _runtime\ejs-assets\test\probe.cjs /rom/r4.chd 60000 out.png`

| Case | `EJS_gameUrl` | Result |
|---|---|---|
| CHD, HLE | `/rom/r4.chd` | **boots** — intro FMV playing (`test\probe-chd.png`) |
| CHD, OpenBIOS as `scph5501.bin` | `/rom/r4.chd` | **boots** — R4 title (`test\probe-chd-openbios.png`) |
| CHD, garbage 512 KiB "BIOS" | `/rom/r4.chd` | **boots** — intro (`test\probe-chd-badbios.png`) |
| CHD, `EJS_disableCue = false` (the page's `auto` mode) | `/rom/r4.chd` | **boots** — EJS generates `r4-0.cue`, core still reads the CHD (`test\chd-disablecue-false.png`) |
| CHD, 100 s + Start presses | `/rom/r4.chd` | FMV keeps streaming from CHD for 2+ min (`test\chd-play-a.png`, `-c.png`) |
| ZIP cue+bin | `/rom/r4.zip` | **boots** — credits FMV (`test\probe-zip.png`) |

Numbers from the probe (localhost, warm page cache):

* 357.8 MB fetched in ~0.5 s (669 MB/s / ~5.4 Gbps) — disk and Node are nowhere
  near the bottleneck.
* page navigation → `EJS_emulator.started === true`: **2.06 s** in headless Chrome.

Note on core selection: EJS 4.2.3's bundled `cores.json` does **not** list `chd`
in `pcsx_rearmed`'s extensions (`bin,cue,img,mdf,pbp,toc,cbn,m3u,ccd`). The
emulator still works because, for an unknown extension, `downloadRom()` passes the
raw filename to the core and `pcsx_rearmed` (r24) supports CHD itself. The
`EJS_gameUrl` path is therefore unaffected, but the built-in file picker would
not offer `.chd`. Upstream EmulatorJS docs do list `.chd` for PSX. If a future
EJS upgrade ever regresses this, switch to `/rom/r4.zip` (tested) — no other change.

---

## 5. Serving, caching, Range, IndexedDB

Verified against the live server (`http://localhost:8080`):

```
HEAD /rom/r4.chd   → 200, Content-Length: 357817282, Accept-Ranges: bytes,
                     Cache-Control: public, max-age=604800, immutable,
                     Cross-Origin-Resource-Policy: cross-origin,
                     Access-Control-Allow-Origin: *, ETag, Last-Modified
GET  /rom/r4.chd   (Range: bytes=1000000-1000999)
                   → 206, Content-Range: bytes 1000000-1000999/357817282,
                     Content-Length: 1000
HEAD /bios/openbios.bin → 200, Content-Length: 524288, Accept-Ranges: bytes
```

What EmulatorJS actually needs (from `data/src/emulator.js`):

* **HEAD must return 200 with `Content-Length`.** `downloadGameFile()` does a
  `HEAD` before the `GET` to validate its IndexedDB cache; a 404/405 there throws
  (`res.headers` on `-1`) and the game never starts. Already satisfied.
* **GET must send `Content-Length`.** The download progress bar and the cache
  validation both use `e.total` / `content-length`. Already satisfied.
* **Range is not used by EmulatorJS itself** (it fetches the whole file with XHR
  `responseType=arraybuffer`), but `play.js`'s pre-boot presence probe issues
  `Range: bytes=0-0` and expects a `206` + `Content-Range`, so Range support is
  required for the page as written. Also useful for resumable/partial reads and
  `curl -C -`. Already enabled — keep it.
* **COOP/COEP on `/play`** is what allows `SharedArrayBuffer` → threaded core.
  Keep those headers scoped to `/play` (they are); the ROM/BIOS/emulator routes
  send `Cross-Origin-Resource-Policy: cross-origin` so they still load.

### IndexedDB

`emulator.js` stores the ROM in IndexedDB database **`EmulatorJS-roms`** (store
`rom`), the BIOS in `EmulatorJS-bios`, the core in `EmulatorJS-core`, and save
states in `EmulatorJS-states`, when
`content-length < EJS_CacheLimit` (page sets `1073741824` = 1 GiB).

Consequences for a 341 MiB CHD:

* First visit: 341 MiB over the network **plus** a 341 MiB IndexedDB write (and the
  browser may also keep the 341 MiB HTTP-cache entry because of
  `Cache-Control: immutable`). Expect up to ~700 MiB of client storage for one
  game.
* Repeat visits: EJS still issues `HEAD` (cheap, 304-less) and then reads the ROM
  out of IndexedDB — no network transfer, ~1–2 s to start.
* Cache is keyed by URL basename and validated **only** by `Content-Length`. If
  the CHD is regenerated with the same byte size but different content, clients
  will silently keep the stale copy; bump the filename (e.g. `r4-v2.chd`) when
  replacing it.
* Mobile: Safari's IDB quota can be ~1 GiB per origin; a 341 MiB entry is fine but
  tight next to save states. `play.js` currently sets
  `EJS_disableDatabases = false`; set it to `true` on small-quota devices if you
  prefer pure HTTP caching (the `immutable` header still makes reloads cheap).

---

## 6. Size and transfer-time estimates

357.8 MB (341.2 MiB) CHD vs 621.4 MB (592.6 MiB) BIN+CUE = **−42.4 % (−263.6 MB)**.

| Link (effective) | CHD 341 MiB | BIN+CUE 593 MiB |
|---|---|---|
| localhost / loopback (measured) | 0.5 s | 0.9 s |
| Gigabit Ethernet (~940 Mbps) | ~3.2 s | ~5.6 s |
| Wi-Fi 6, 2×2 laptop (~700 Mbps) | ~4.3 s | ~7.5 s |
| Wi-Fi 6 phone, 1×1 (~450 Mbps) | ~6.7 s | ~11.6 s |
| Wi-Fi 5 phone (~250 Mbps) | ~12 s | ~21 s |
| 2.4 GHz Wi-Fi / 100 Mbps LAN (~70 Mbps) | ~43 s | ~75 s |
| LTE (~20 Mbps) | ~150 s | ~260 s |

Add ~1–3 s for core download/compile on first visit (1.0 MB `pcsx_rearmed-wasm.data`,
cached afterwards by the browser with a 1-week immutable policy). Emulator startup
after the ROM is in memory was measured at ~2 s total on this machine.

---

## 7. Files created / changed

| Path | Size | What |
|---|---|---|
| `_runtime/ejs-assets/r4.chd` | 357 817 282 | **Canonical** single-file disc (CHD v5, cdlz) |
| `_runtime/ejs-assets/r4.zip` | 386 878 171 | Tested ZIP fallback (cue+bin, deflate 9) |
| `_runtime/ejs-assets/bios/scph5501.bin` | 524 288 | OpenBIOS renamed for the BIOS experiment (identical MD5 to the original) |
| `_runtime/ejs-assets/tools/chdman.exe` | 2 684 416 | chdman 0.289 (MAME 0.289, GPL) — conversion tool |
| `_runtime/ejs-assets/test/probe.cjs` | ~7 KB | Headless-Chrome EJS boot probe (dev tool) |
| `_runtime/ejs-assets/test/index.html` | ~1 KB | Probe page (`?rom=&bios=&cue=`) |
| `_runtime/ejs-assets/test/*.png` | small | Evidence screenshots (`probe-chd.png`, `probe-chd-openbios.png`, `probe-chd-badbios.png`, `chd-disablecue-false.png`, `probe-zip.png`, `chd-play-*.png`) |
| `_runtime/ejs-assets/test/bad.bin` | 524 288 | Random-bytes BIOS used for the HLE-fallback proof |
| `disc/r4.chd` | 0 extra | **NTFS hardlink** to `_runtime/ejs-assets/r4.chd`, so the existing `/rom` route serves it without touching `src/server.js`. Original `.bin`/`.cue` untouched. Delete this link if you prefer to add a dedicated `/rom-assets` route. |
| `_server/EJS-ASSETS.md` | this file | — |

Disk cost: ~745 MB for `_runtime/ejs-assets` (CHD + ZIP + tool + test junk), of
which 369 MB is the optional ZIP fallback. Delete `r4.zip` and `test/bad.bin` if
space matters.

---

## 8. Blockers / open items for the page owner

1. `public/js/play.js` still points at the 592.6 MiB BIN. Two-line change in §1
   (`rom: '/rom/r4.chd'`, `bytes: 357817282`).
2. `public/play.html` hint text still says `621 MB · served from this machine`
   (line 29). Should be `341 MB`.
3. `play.js` reports `core: 'psx'` in the debug overlay — correct; EJS resolves
   `psx` → `pcsx_rearmed`. No action.
4. Not tested: real phone/desktop browser over Wi-Fi (only headless Chrome on
   loopback), audio output, and the threaded core (`crossOriginIsolated` was false
   in the probe, so `pcsx_rearmed-wasm.data` was used; the threaded build is the
   same core and EJS picks it automatically on `/play`). CHD support is a property
   of `pcsx_rearmed` itself, not of the wasm/thread split.
5. CHD does not appear in EJS 4.2.3's `cores.json` extension list (see §4). Works
   via `EJS_gameUrl`; would only matter for drag-and-drop/file-picker flows.
