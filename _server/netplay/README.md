# RR4 LAN netplay (standalone)

Self-hosted [EmulatorJS netplay](https://github.com/EmulatorJS/EmulatorJS-Netplay)
relay + a standalone harness used to prove LAN 2-player works without touching
the main `/play` page.

Full findings: [`../NETPLAY-REPORT.md`](../NETPLAY-REPORT.md). Current
integration and launch instructions: [`../NETPLAY-INTEGRATION.md`](../NETPLAY-INTEGRATION.md).

## Start the relay

```powershell
cd _server\netplay
npm install          # once
powershell -ExecutionPolicy Bypass -File .\start-netplay.ps1
# or:  .\start-netplay.bat
```

Listens on **TCP 3010** (`PORT`/`HOST` env override). If the port is already
in use, run `stop-netplay.ps1` first. Health check:

```powershell
Invoke-RestMethod http://127.0.0.1:3010/health
```

Firewall (elevated PowerShell; TCP 3010 on all profiles, because the WLAN is
often classified Public):

```powershell
powershell -ExecutionPolicy Bypass -File .\firewall-netplay.ps1
```

Stop it:

```powershell
powershell -ExecutionPolicy Bypass -File .\stop-netplay.ps1
```

## Standalone harness (ports 3011 + 3010)

```powershell
$env:PORT=3011; node serve-test.mjs
```

Open `http://<LAN-IP>:3011/test-page-nightly.html?psx=1&ice=0` for the
EmulatorJS 4.3-pre + PSX/R4 test, or `test-page.html` for the 4.2.3/NES test.
The page builds `EJS_netplayServer` from `location.hostname`, so open it via
the LAN IP on both machines (not `localhost` on one and the IP on the other).

## Tests

```powershell
node test-netplay.mjs        # EmulatorJS 4.2.3 + NES: handshake/relay
node test-netplay-43.mjs     # EmulatorJS 4.3-pre + NES: WebRTC video/input
node test-netplay-psx.mjs    # EmulatorJS 4.3-pre + PSX + real R4 CHD
$env:ICE='0'; node test-netplay-psx.mjs   # no STUN, LAN host candidates only
node test-play-net.mjs       # live /play netplay page, two Brave contexts
```

`test-play-net.mjs` starts/reuses the main app on `:8090` and the relay on
`:3010`, then exercises the real `/play` netplay page with the R4 CHD. Set
`APP_PORT`, `NP_PATH`, or `SINGLE_PATH` to point it at a different origin or
path (for example the live `:8080` server with `/play-net.html`).

Screenshots/logs are written to `..\..\_runtime\netplay*`.

## Client config (4.3-pre, recommended)

```js
window.EJS_gameID = 4;                       // numeric, unique per game
window.EJS_netplayServer = `http://${location.hostname}:3010`;
window.EJS_netplayICEServers = [];           // LAN: empty is enough
window.EJS_Buttons = { netplay: true };      // default true in 4.3, harmless
```

`EJS_netplayICEServers` accepts `[{ urls: 'stun:...' }]` and optional TURN
credentials. STUN is not required on one subnet; TURN is only for NAT/internet.

## Client config (4.2.3, legacy)

4.2.3 hides netplay unless **all** of these are set:

```js
window.EJS_DEBUG_XX = true;
window.EJS_EXPERIMENTAL_NETPLAY = true;
window.EJS_Buttons = { netplay: true };
window.EJS_gameID = 4;
window.EJS_netplayServer = `http://${location.hostname}:3010`;
```

4.2.3 ignores `EJS_netplayICEServers` and its frame hook is registered after
the core main loop starts, so host input does not broadcast (`currentFrame`
stays 0). Use 4.3-pre for real input sync, or see the report for a shim.

## Layout

| Path | Purpose |
| --- | --- |
| `server.js` | upstream Node relay (`EmulatorJS-Netplay@main`) + `/health` |
| `serve-test.mjs` | static harness on :3011; also exposes `/disc`, `/bios`, `/root` read-only |
| `test-page.html` | 4.2.3 + NES harness |
| `test-page-nightly.html` | 4.3-pre harness; `?psx=1` for R4, `&ice=0` for no STUN |
| `ejs-data/` | EmulatorJS 4.2.3 source data (unminified) |
| `ejs-data-nightly/` | EmulatorJS 4.3.0-pre nightly data |
| `EmulatorJS-Netplay-node/` | upstream Node server clone (`main`, commit `9e8a6e6`) |
| `EmulatorJS-Netplay/` | upstream default `rust` branch clone (not built; no cargo) |
| `EmulatorJS-src/` | EmulatorJS 4.2.3 source, used to inspect netplay code |
