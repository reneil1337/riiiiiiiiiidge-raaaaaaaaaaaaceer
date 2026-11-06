# Ridge Racer Type 4 — documentation site

This is the Zudoku 0.93.2 field manual for the Ridge Racer Type 4 native
recompilation, browser arcade, and LAN multiplayer cabinet. It is a static site
built into `docs\dist\docs` and mounted by `_server\src\server.js` at:

```text
http://localhost:8080/docs
http://<host-lan-ip>:8080/docs
```

In production there is no separate docs server: the cabinet Express process
serves the built files.

The default `/` page is the **R4 cabinet entry shell**. It owns the soundtrack
and the only top bar. After ENTER the first view is **WELCOME TO RIDGE CITY**
(`/welcome`), the paddock hub; from there: **GAMES** (`/games`, machine check),
**2P LOUNGE** (`/multiplayer`), **PLAY**, **DOCS** or **LOBBY**. No disc starts
until START is chosen. The docs load inside the iframe under **DOCS**; the old
lobby and the native host-stream fallback are `/lobby`. When checking the docs
in the real cabinet, open `/`, press ENTER, then DOCS — music should keep
playing through navigation.

The 2P path is documented in `pages\multiplayer\lounge.mdx`: the lounge rolls the
course/preset-car plan from the room's disc (`r4` VS Battle, `rage`/`ridge`
shared car or ghost replay), both players press READY, and the shell hands both
browsers to `/play-net` with `mpRole`, `mpRoom`, `mpRace`, `mpTrackIndex`,
`mpCarHost`, `mpCarGuest`, `game` and — in a ghost room —
`mpGhost`/`mpTurn`/`mpLiveGhost`. `pages\multiplayer\shared-car.mdx` covers the Rage
Racer / Ridge Racer 1994 shared car and `pages\multiplayer\ghost-run.mdx` covers
the ghost modes (live ghost + post-race replay). After the race, each tab's
**REMATCH** chip returns that seat to the same lounge room (and the same disc) for
another round.

The **documentation contract** lives in `..\AGENTS.md`. Every behaviour change
must update the relevant page, `README.md`, and `START-HERE.md` in the same
change, then rebuild this site.

## Prerequisites

- Node.js **22.12+** or **20.19+** (Node 24 is what this workspace currently uses)
- npm (installed with Node)
- Windows PowerShell for the commands below

## Install

```powershell
cd docs
npm install
```

For a clean, lockfile-reproducible install:

```powershell
cd docs
npm ci
```

## Commands

| Command | What it does | Result |
| --- | --- | --- |
| `npm run dev` | Zudoku dev server with hot reload | <http://localhost:3000/docs> |
| `npm run build` | Production static build | `<repo>\docs\dist\docs` |
| `npm run verify` | Checks the built site against the running cabinet: page 200s, one H1, internal links, app routes, section redirects | Console pass/fail |
| `npm run preview` | Serves the existing production build | <http://localhost:4000/docs> |
| `npm run lint` | ESLint | Console output |

The dev and preview servers are for working on the manual only. To verify the
real deployment path, use the cabinet server on port 8080.

## How `basePath` and the output path work

`basePath: "/docs"` is set in `zudoku.config.tsx`. It affects the whole site:

- Dev and preview URLs include `/docs` (`/docs/introduction`, not `/introduction`).
- Generated navigation, asset URLs, and redirects are prefixed with `/docs`.
- `npm run build` writes the site to `docs\dist\docs`, not directly to `docs\dist`.
- `docs\dist\docs\index.html` redirects to `/docs/introduction`.
- Section redirect stubs such as `dist\docs\games.html` redirect to their first page.
- `dist\400.html`, `dist\404.html`, and `dist\500.html` are generated alongside
  the `docs` folder; the cabinet server only mounts `dist\docs`.

The server maps clean URLs to HTML files with Express static
`extensions: ['html']`, so `/docs/play/browser` serves
`dist\docs\play\browser.html` without a `.html` suffix.

`dist\` is generated and gitignored. Never edit it by hand; rebuild after source
changes. The port 8080 server serves the last build, not the live dev server.

## Server mount and cache headers

`_server\src\server.js` resolves:

```js
const docsDir = path.resolve(rootDir, '..', 'docs', 'dist', 'docs');

app.use('/docs', express.static(docsDir, {
  etag: true,
  lastModified: true,
  index: 'index.html',
  extensions: ['html'],
  maxAge: '1h',
  setHeaders(res, filePath) {
    if (filePath.endsWith('.html')) {
      res.setHeader('Cache-Control', 'no-cache');
    }
    res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
  },
}));
```

Practical effect:

- HTML pages are `Cache-Control: no-cache` and revalidate on each visit, so a
  rebuild is visible immediately.
- Hashed JS/CSS and copied public assets get `max-age=3600` plus ETag and
  Last-Modified.
- All docs responses include `Cross-Origin-Resource-Policy: cross-origin` so the
  game pages and docs can reference the same assets.
- If `/docs` returns 404, the build is missing or wrote to the wrong path.

## 2P lounge and handoff docs

The canonical page is `pages\multiplayer\lounge.mdx`. It documents the room
lifecycle, the DISC selector, the DRIVE `LIVE`/`GHOST` and TURN `HOST`/`GUEST`
controls, the manifest-driven race plan (`r4` VS Battle, `rage`/`ridge` shared car
or ghost replay), the `/play-net` `mp*` + `game=` + `mpGhost`/`mpTurn` parameters,
the R4 VS Battle macro, the shared-car remap, the ghost turn gate, the guest input
gate, and the one-click **REMATCH** back to the same room and disc (a ghost
rematch flips the turn).
`pages\multiplayer\shared-car.mdx` is the product page for Rage Racer and Ridge
Racer 1994 (one car, both pads).
`pages\multiplayer\ghost-run.mdx` is the product page for the ghost modes
(drive/turn, the two discs' RAM cells, the tape swap, IndexedDB
`rr4-ghost`, the Route B live ghost and its mode matrix, limits).
`pages\multiplayer\lan.mdx` is the
network/firewall overview and `pages\multiplayer\r4-2p.mdx` covers the relay and
WebRTC side.

Keep the evidence labels scoped when you edit them:

| Area | Harness | Label |
| --- | --- | --- |
| Lounge UI + handoff (R4) | `_server/test-mp-lobby-ui.mjs` (33/33) | `harness-verified` |
| Multi-disc manifest + `/mp` plans | `_server/mp-games-probe.mjs` (16/16) | `harness-verified` |
| Multi-disc lounge UI + handoff | `_server/test-mp-games-ui.mjs` (32/32) | `harness-verified` (plan/handoff only; Rage/Ridge in-game mode still unverified) |
| Rage shared-car host path | `_server/test-mp-shared-car.mjs` (14/14) | `harness-verified host-only` (real Rage core boot, manual stage, `player 1 → 0` remap install; no guest, no live drive) |
| Ghost replay engine (Ridge + Rage) | `_server/test-mp-ghost-replay.mjs` (40/40) | `harness-verified ghost replay (sequential, Ridge + Rage)` — native tape capture/swap, pose equals tape, the rendered frame changes, the Rage scene-12 finish arm → 17, the turn gate, IndexedDB; **host-only, synthetic tapes** |
| Live ghost (Route B) | `_server/test-mp-live-ghost.mjs` (36/36) | `harness-verified ghost rendered (in-game)` — the RAM stub + one repointed shipped word, ghost slot pose equals tape 16/16 on Ridge's race screen and Rage Grand Prix, the A/B delta clear of the noise floor, player still driving, turn gate unchanged, `mpLiveGhost` absent / `mpGhost=live` / R4 off; **host-only, synthetic tapes, drawn not simulated, Rage TA replay-only** |
| Ghost lounge (DRIVE / TURN) | `_server/test-mp-ghost-lobby.mjs` (36/36) | `harness-verified` for the lounge side: DRIVE/TURN selectors, `mpGhost`/`mpTurn`/`mpLiveGhost` handoff, rematch turn flip, live regression, 390×844; `/play-net` held, so no core boots |
| Raw `/mp` transport | `_server/mp-ws-probe.mjs` (22/22; app-level `pong` + server heartbeat ping observed) | `harness-verified` |
| Host macro | `_server/mp-macro-test.mjs` (6/6, incl. final-frame race check) | `harness-verified host-only` |
| Guest P2 in a real race | `_server/test-mp-race-e2e.mjs` → `_runtime/mp-race-e2e.json` | `harness-verified two-browser` (40/40, two contexts on one host; two physical machines still unverified and guest audio absent; guest chip shows `P2 LIVE`) |
| Shell fullscreen + embedded fill | `_server/test-shell-fs.mjs` (30/30) | `harness-verified` (headless Escape is browser-limited) |

Run the whole set in one table from `_server`:

```powershell
cd _server
node verify-mp.mjs          # fast: /mp, lounge UI, shell, host macro
node verify-mp.mjs --full   # + the two-browser race (boots two R4 cores)

# multi-disc lounge (each spawns its own throwaway cabinet)
node mp-games-probe.mjs     # manifest + /mp per-game plans (16/16)
node test-mp-games-ui.mjs   # two-browser DISC selector + handoff (32/32)
node test-mp-shared-car.mjs # Rage host: manual stage + remap install (14/14)
node test-mp-live-ghost.mjs   # ghost mode: live ghost stub + patch, A/B (36/36)
node test-mp-ghost-replay.mjs # ghost mode: tape capture/swap + turn gate (40/40)
node test-mp-ghost-lobby.mjs  # ghost mode: DRIVE/TURN + rematch flip (36/36)
```

`verify-mp.mjs` stays the R4 2P wrapper; the three multi-disc harnesses run
separately. Rage Racer and Ridge Racer 1994 are
`netplay transport; in-game mode unverified` — the plan, room, handoff, manual
stage and remap install are proved, a live shared-car drive is not. Ghost mode has
two labels: `harness-verified ghost replay (sequential, Ridge + Rage)` for the
post-race native replay, and `harness-verified ghost rendered (in-game)` for the
live ghost on Ridge's race screen and Rage Grand Prix (drawn, not simulated; Rage
TA replay-only), both with synthetic tapes and no human lap recorded.

`[NETPLAY] No ICE servers configured` and the React #418 hydration warning on
`/docs/introduction` are expected. A plain-HTTP LAN origin has **no** COOP
warning: the cabinet sends COOP/COEP only on loopback/HTTPS. Never write "0
console errors".

## Music player docs

The soundtrack player is documented at `pages\play\music.mdx`. It is part of the
same app and the same docs contract:

- the **ENTER THE CABINET** gate unlocks browser audio;
- the R4 intro **"You The One For Me"** starts first;
- the GAME selector switches both the playlist and the `body[data-game]` theme;
- audio lives in `_server\public\music\<game>\`, is generated into
  `manifest.json`, and is served by `/music` + `/api/music`.

After changing tracks or titles, rebuild the manifest from `_server`:

```powershell
cd _server
node scripts/build-music-manifest.mjs
# or: npm run music:manifest
```

Then update `pages\play\music.mdx` if the behaviour, track counts or file layout
changed. The root `AGENTS.md` makes this mandatory: **behaviour change = docs
change in the same commit.**

## File map

```text
docs\
  zudoku.config.tsx   site title, basePath, navigation, redirects, docs glob,
                      syntax highlighting, light/dark theme
  styles.css          Ridge Racer design system (hero, cards, notes, tables)
  pages\              MDX source; file paths become routes
    introduction.mdx
    start\quickstart.mdx
    games\*.mdx
    play\*.mdx          includes play\music.mdx (ENTER gate + soundtracks)
                        and play\performance.mdx (measured fps/transport table)
    multiplayer\*.mdx
                        includes multiplayer\race-day.mdx (Race Day: 50-seat
                        mass start, WS /mmo, RAM telemetry, 550-socket load)
                        and multiplayer\shared-car.mdx (Rage/Ridge shared car)
                        and multiplayer\ghost-run.mdx (Rage/Ridge ghost: live
                        ghost rendered in-game + post-race replay)
    engineering\*.mdx
    reference\*.mdx
  public\             copied to /docs as-is: logo-light.svg, logo-dark.svg,
                      favicon.svg, banner.svg, banner-dark.svg, img\lan\*.png
                      (LAN / lounge / shared-car / ghost-run screenshots)
  apis\openapi.yaml   OpenAPI source (not currently referenced by the config)
  package.json        Zudoku scripts and dependencies
  tsconfig.json       TypeScript config for the Zudoku config file
  .env.example        optional local environment template
  dist\               generated output; gitignored
```

The content glob is:

```ts
docs: {
  files: "/pages/**/*.{md,mdx}",
}
```

`pages\start\quickstart.mdx` becomes `/docs/start/quickstart`, and
`pages\introduction.mdx` becomes `/docs/introduction`.

## Add a page and add it to navigation

1. Create the file under `docs\pages`, using lowercase kebab-case:

   ```powershell
   New-Item -ItemType Directory -Force "<repo>\docs\pages\reference"
   ```

   `docs\pages\reference\new-page.mdx`:

   ```mdx
   ---
   title: New page
   description: One sentence used for metadata and search results.
   ---

   Normal Markdown content goes here. Zudoku renders the frontmatter `title`
   as the page H1; do not add a second `# New page` heading.
   ```

2. Add its route to the matching category in `zudoku.config.tsx`. Navigation
   paths are **site-relative**: no `/docs` prefix, no `.mdx` extension.

   ```tsx
   {
     type: "category",
     label: "Reference",
     icon: "book",
     items: [
       "/reference/controls",
       "/reference/new-page",
       "/reference/troubleshooting",
       "/reference/legal",
     ],
   },
   ```

3. If the page replaces a section landing page, add or update a redirect:

   ```tsx
   redirects: [
     { from: "/reference", to: "/reference/new-page" },
   ],
   ```

4. Rebuild and check the page in the sidebar, the rendered MDX, and the clean URL.

Order in the `items` array is the sidebar order. A page that is not listed in
`navigation` may still be reachable by URL, but it will not appear in the
sidebar.

## Design system notes

The visual language is dark navy, signal red, cyan timing lines, hard angles,
and condensed italic display type.

### Colors

The custom properties at the top of `styles.css` are the source of truth for the
decorative classes:

| Variable | Value | Use |
| --- | --- | --- |
| `--rr-red` | `#ff2b2b` | signal red, primary actions |
| `--rr-red-deep` | `#b3121c` | gradient depth |
| `--rr-cyan` | `#29d3ff` | timing lines, tags, h3 |
| `--rr-yellow` | `#ffd84a` | strip highlights, route emphasis |
| `--rr-navy` | `#05070f` | dark page background |
| `--rr-navy-2` | `#0a1120` | cards and panels |
| `--rr-line` | `#1b2a45` | borders and dividers |
| `--rr-paper` | `#f7f3e9` | light-mode paper |
| `--rr-ink` | `#0a1020` | light-mode text |

The `theme` block in `zudoku.config.tsx` mirrors these values into Zudoku's
light/dark tokens (primary red, accent cyan, `radius: 0.15rem`). Keep both files
in sync when changing brand colors.

### Fonts

- **Oxanium** — headings, hero titles, buttons, and condensed UI text.
- **JetBrains Mono** — code, kickers, pills, spec labels, and route blocks.
- Fallbacks include Bahnschrift, Arial Narrow, Cascadia Mono, and Consolas.
  Zudoku loads Oxanium/JetBrains Mono from Google Fonts; the fallbacks keep the
  layout usable when that request is blocked.

Typography rules in `styles.css`: h1 is uppercase italic, h2 is uppercase with a
red left border, h3 is uppercase cyan.

### Useful classes

| Group | Classes |
| --- | --- |
| Hero | `rr-hero`, `rr-kicker`, `rr-title` (nested `span`), `rr-sub`, `rr-actions`, `rr-strip` |
| Buttons | `rr-btn`, `rr-btn--primary`, `rr-btn--ghost` |
| Cards | `rr-grid`, `rr-card`, `rr-tag`, `rr-go` |
| R4 team cards | `rr-team-grid`, `rr-card rr-team`, `rr-team--solvalou`, `rr-team--pac`, `rr-team--mappy`, `rr-team--dig` |
| Small UI | `rr-pill`, `rr-pill--red`, `rr-pill--yellow`, `rr-note`, `rr-note--warn`, `rr-note--ok`, `rr-checker`, `rr-spec`, `rr-route` |

These are applied with raw HTML/JSX inside MDX:

```mdx
<div className="rr-hero">
  <div className="rr-kicker">Namco · PlayStation · 1998</div>
  <h1 className="rr-title">Ridge Racer<span>Type 4 // Field Manual</span></h1>
  <p className="rr-sub">Three discs. Two players. One cabinet.</p>
  <div className="rr-actions">
    <a className="rr-btn rr-btn--primary" href="/play">Play in browser</a>
    <a className="rr-btn" href="/docs/multiplayer/lan">LAN multiplayer</a>
  </div>
</div>
```

Use Markdown for normal prose and raw HTML only when a custom class or layout is
required.

## Verify after changes

Build first:

```powershell
cd docs
npm run build
if ($LASTEXITCODE -ne 0) { throw "Docs build failed" }
Get-ChildItem ".\dist\docs" | Select-Object Name
```

Then serve the built site through the real cabinet server:

```powershell
cd _server
.\start-test.bat
# or: npm start
```

`start-test.bat` runs the test stream and netplay relay without launching the
game, which is usually enough for docs checks.

Open and check:

- <http://localhost:8080/docs> → redirects to `/docs/introduction`
- <http://localhost:8080/docs/introduction>
- <http://localhost:8080/docs/start/quickstart>
- <http://localhost:8080/docs/games/ridge-racer-type-4>
- <http://localhost:8080/docs/play/browser>
- <http://localhost:8080/docs/play/performance>
- <http://localhost:8080/docs/play/music>
- <http://localhost:8080/docs/multiplayer/lan>
- <http://localhost:8080/docs/multiplayer/lounge>
- <http://localhost:8080/docs/multiplayer/shared-car>
- <http://localhost:8080/docs/multiplayer/ghost-run>
- <http://localhost:8080/docs/multiplayer/race-day>
- <http://localhost:8080/docs/multiplayer/r4-2p>
- <http://localhost:8080/docs/engineering/rea>
- Section URLs: `/docs/games`, `/docs/play` and `/docs/multiplayer` **301** to
  their first page (`/docs/games/ridge-racer-type-4`, `/docs/play/browser`,
  `/docs/multiplayer/lan`). The cabinet server registers those explicitly in
  `DOCS_SECTION_PAGES` (`_server\src\server.js`); the generated
  `/docs/games.html`, `/docs/play.html` and `/docs/multiplayer.html` stubs stay
  as the fallback for a bare static host.

Verification checklist:

- Sidebar shows the new/renamed page and the active state follows the URL.
- No broken images or 404s in DevTools → Network; the only console noise should
  be, on `/play-net`, the `No ICE servers configured` netplay warning (COOP is
  sent on loopback/HTTPS only, so a plain-HTTP LAN page has no COOP warning).
- Dark and light themes both look correct.
- Desktop (~1440×900) and mobile (~390×844) layouts do not overflow.
- Take before/after screenshots of the affected pages and compare hero, cards,
  tables, and code blocks.
- Confirm HTML cache behavior if it matters:

  ```powershell
  (Invoke-WebRequest "http://localhost:8080/docs/introduction" -Method Head).Headers["Cache-Control"]
  ```

  It should contain `no-cache`.

## Known gotchas

- **Raw HTML links do not get `basePath` applied.** In MDX/JSX, write the full
  docs URL: `href="/docs/play/browser"`. In Markdown, use the site-relative docs
  path: `[Browser arcade](/play/browser)`, which Zudoku prefixes with `/docs`
  automatically. Do not mix the two conventions.
- **App routes outside the docs are intentionally different.** The game pages
  live at `/play`, `/play-net`, `/`, and `/api/*`. Link to those with raw HTML,
  for example `href="/play"`, not `/docs/play`.
- **MDX treats `<` as JSX.** Text such as `<-` or `<host>` can be parsed as a tag
  and break the build. Use backticks (`` `<-` ``, `` `<host>` ``) or `&lt;`.
- **Keep navigation paths in sync with files.** A nav entry must match the route
  derived from `pages\...`, without `.mdx` or `/docs`. Renaming a file without
  updating the nav and redirects leaves dead sidebar entries and stale links.
- **Rebuild before checking port 8080.** The cabinet server does not proxy the
  dev server. `npm run dev` only updates port 3000.
- **Do not edit `dist\`.** It is regenerated by `npm run build` and ignored by
  git.
- **Add redirects when moving pages.** Preserve old URLs with `redirects` in
  `zudoku.config.tsx`; otherwise bookmarks and in-page links break.
- **Section redirect stubs sit next to the section folder.** The build writes
  `dist\docs\multiplayer.html` (a client redirect to `/docs/multiplayer/lan`)
  *and* the `dist\docs\multiplayer\` folder. Express static answers with a 301
  to `/docs/multiplayer/` because the folder exists, and that path has no
  `index.html`, so the clean section URL would 404. Since 2026-11-05 the cabinet
  server registers explicit 301s in `_server\src\server.js`
  (`DOCS_SECTION_PAGES`): `/docs/games`, `/docs/play` and `/docs/multiplayer`
  (with and without the trailing slash) go straight to their first page, so the
  section URLs work again. Keep that table in sync if a section is renamed.
- **Keep filenames lowercase and kebab-cased.** Routes are generated from file
  paths, and case-sensitive hosts may treat `/Docs` differently.
- **Pages with their own hero need one H1.** The intro uses
  `title: ""` + `sidebar_label` + `seo.title` so Zudoku does not render a second
  H1 above the hero. For normal pages, use the frontmatter `title` as the only
  H1 and do not add `# Heading` in the body.

## Legal note

Game discs and BIOS files are user-supplied. The project does not redistribute
game data or retail BIOS dumps. Do not commit `.bin`, `.cue`, `.chd`, BIOS, save,
or memory-card files. OpenBIOS is bundled under its own license; keep
`OpenBIOS.LICENSE` with it. The user-facing details live at
<http://localhost:8080/docs/reference/legal>.
