@echo off
setlocal
rem Add/update the inbound TCP 3010 rule on ALL profiles for the netplay relay.
rem The WLAN is often Public; a Private-only rule blocks guests.
rem Double-click this file and accept the UAC prompt.

net session >nul 2>&1
if errorlevel 1 (
  echo Elevating...
  powershell -NoProfile -Command "Start-Process -FilePath '%~f0' -WorkingDirectory '%~dp0' -Verb RunAs"
  exit /b
)

powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0netplay\firewall-netplay.ps1"
echo.
echo Done. Same-subnet LAN play needs no router port-forward.
pause
