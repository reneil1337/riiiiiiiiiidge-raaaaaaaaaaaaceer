@echo off
setlocal
cd /d "%~dp0netplay"
title RR4 Netplay Relay (TCP 3010)
set PORT=3010
set HOST=0.0.0.0

where node >nul 2>nul
if errorlevel 1 (
  echo Node.js 20 or newer is required.
  pause
  exit /b 1
)

if not exist node_modules (
  echo Installing netplay relay dependencies...
  call npm install
  if errorlevel 1 (
    echo npm install failed.
    pause
    exit /b 1
  )
)

echo.
echo RR4 netplay relay -^> http://0.0.0.0:3010
echo Health: http://127.0.0.1:3010/health
echo Keep this window open while playing. Ctrl+C to stop.
echo.
echo Main app: start it separately with start.bat or start-test.bat.
echo Then open  http://^<LAN-IP^>:8080/play-net  on BOTH machines.
echo Allow inbound TCP 3010 on ALL firewall profiles once:
echo   right-click firewall-netplay.bat -^> Run as administrator.
echo.
node server.js
pause
