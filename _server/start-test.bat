@echo off
setlocal
cd /d "%~dp0"
title Ridge Racer Type 4 LAN Arcade (TEST STREAM)
set RR4_NO_AUTOSTART=1
set RR4_STREAM_SOURCE=test
echo Starting the LAN cabinet in TEST mode (no game launch, looping capture).

rem --- Optional LAN netplay relay on TCP 3010 ---
if /i "%RR4_NO_NETPLAY%"=="1" (
  echo Netplay relay: skipped ^(RR4_NO_NETPLAY=1^).
  echo Start start-netplay.bat manually for 2P LAN.
) else (
  powershell -NoProfile -Command "try { $r = Invoke-WebRequest -UseBasicParsing http://127.0.0.1:3010/health -TimeoutSec 1; if ($r.StatusCode -eq 200) { exit 0 } } catch {}; exit 1" >nul 2>nul
  if errorlevel 1 (
    echo Starting the netplay relay on TCP 3010 in a minimized window...
    start "RR4 Netplay Relay 3010" /min "%~dp0start-netplay.bat"
  ) else (
    echo Netplay relay already listening on TCP 3010.
  )
)

echo For 2P LAN netplay, open http://^<LAN-IP^>:8080/play-net on both machines.
echo If guests cannot connect, run firewall-netplay.bat once ^(TCP 3010, all profiles^).
echo.
start "" "http://localhost:8080/"
node src/server.js
pause
