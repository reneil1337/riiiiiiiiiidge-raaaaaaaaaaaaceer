@echo off
setlocal
cd /d "%~dp0"
title Ridge Racer Type 4 LAN Arcade

where node >nul 2>nul
if errorlevel 1 (
  echo Node.js 20 or newer is required.
  pause
  exit /b 1
)
if not exist "game\Ridge_Racer_4_Recompiled.exe" (
  echo Missing game\Ridge_Racer_4_Recompiled.exe
  pause
  exit /b 1
)
if not exist "..\disc\R4 - Ridge Racer Type 4 (USA).cue" (
  echo Missing the Ridge Racer Type 4 disc image in ..\disc\
  pause
  exit /b 1
)
if not exist "..\_tools\ffmpeg\bin\ffmpeg.exe" (
  echo Missing ..\_tools\ffmpeg\bin\ffmpeg.exe
  pause
  exit /b 1
)

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

for /f %%i in ('powershell -NoProfile -Command "$p=Get-Process Ridge_Racer_4_Recompiled -ErrorAction SilentlyContinue | Select-Object -First 1; if ($p) { $p.Id }"') do set RR4_ATTACH_PID=%%i
if defined RR4_ATTACH_PID (
  set RR4_ATTACH=1
  echo Found a running cabinet window - attaching instead of launching another.
)

rem --- Optional HTTPS on TCP 8443: set RR4_TLS=1 before start.bat ---
rem   cert: powershell -ExecutionPolicy Bypass -File scripts\make-cert.ps1
rem   then: starts both http://<host>:8080/ and https://<host>:8443/
if /i "%RR4_TLS%"=="1" (
  if exist "certs\rr4-cert.pem" (
    echo TLS enabled: https://localhost:8443/ ^(plain HTTP on 8080 stays up^).
  ) else (
    echo RR4_TLS=1 but certs\rr4-cert.pem is missing - run scripts\make-cert.ps1.
    echo Falling back to plain HTTP on 8080 only.
  )
)

echo Starting the R4 LAN cabinet on port 8080...
echo Keep this window open while players are racing.
echo If other devices cannot connect, run firewall.bat once.
echo For 2P LAN netplay, run firewall-netplay.bat once ^(TCP 3010, all profiles^).
echo.
start "" powershell -NoProfile -WindowStyle Hidden -Command "Start-Sleep 3; Start-Process 'http://localhost:8080/'"
node src/server.js
echo.
echo Cabinet stopped.
pause
