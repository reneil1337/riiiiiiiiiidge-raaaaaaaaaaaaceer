# Disc setup / eject and LAN ghosts

## Disc deck

`/play` now opens a **pre-boot disc deck**. No ROM request and no EmulatorJS
loader happen until **INSERT DISC & START**.

- **Disc library**: Type 4, Rage Racer, Ridge Racer (1994), each with region and size.
- **EJECT DISC**: clears the tray.
- **INSERT LOCAL DISC**: `.chd`, `.cue`, `.bin`, `.iso`, `.img`, `.7z`, `.zip` from the local machine.
- **Settings before boot**: FILTER (DLSS 5 default), volume, fullscreen-on-start,
  controller status, netplay links, LAN ghosts.
- **EJECT** in the running header returns to the deck. The page reloads without
  probing or booting the disc, so the ROM is not downloaded again until START.

URL behaviour:

| URL | Behaviour |
| --- | --- |
| `/play` | Disc deck, no disc inserted |
| `/play?game=r4` | Direct link: boots R4 immediately (existing links keep working) |
| `/play?game=r4&setup=1` | Disc deck with R4 selected |
| `/play?autostart=1` | Boot the selected/default disc immediately |

## LAN ghosts

Ghosts are **WebM clips of a run**, stored on the LAN host and played as a
picture-in-picture overlay while another player races. This is the first ghost
layer because R4 has replay saves but no browser-accessible live car-position API.

### Record

1. Start a race.
2. Press **REC GHOST** in the header.
3. Choose **This Tab** in the browser's share prompt. Tab capture needs a secure context: use `http://localhost:8080/play` on the host (or HTTPS). On plain LAN HTTP, press REC GHOST on the host via localhost; the uploaded clip is then available to LAN players.
4. Press **STOP GHOST** when the run is done.
5. Name the ghost; it uploads to the LAN host.

The header/footer hide during recording so the clip is mostly game. Tab capture
is the reliable path; EJS's WebGL canvas is black when captured directly after
present.

### Use

1. Return to the disc deck (EJECT or `/play?game=r4&setup=1`).
2. Under **LAN GHOSTS**, press **USE**.
3. Insert the disc and start. The ghost plays in the bottom-right while you race.

The ghost clip loops. The **LAN GHOST** badge can be closed with X.

### API

- `GET /api/ghosts?game=r4` → `{ ghosts: [...] }`
- `POST /api/ghosts?game=r4&name=...` with `Content-Type: video/webm`
- `GET /ghosts/<file>.webm`

Files live in `_server/ghosts/`; metadata is `_server/ghosts/index.json`.
Keep clips short (≤120 s; the recorder auto-stops at 120 s).

## Limitations

- This is a **ghost replay video**, not an in-game car injected into R4.
- It is not synchronized to the exact race start; it loops from game start.
  The next step is native telemetry/ghost-car injection if a stable R4 RAM
  signature is found.
- R4's own replay saves can be shared later as memory-card files; see
  `IMPROVEMENTS.md`.
