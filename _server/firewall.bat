@echo off
setlocal
cd /d "%~dp0"
netsh advfirewall firewall show rule name="Ridge Racer 4 LAN (TCP 8080)" >nul 2>nul
if not errorlevel 1 (
  echo Firewall rule already exists.
  timeout /t 2 >nul
  exit /b 0
)
powershell -NoProfile -ExecutionPolicy Bypass -Command "Start-Process powershell -Verb RunAs -ArgumentList '-NoProfile -ExecutionPolicy Bypass -File \"%~dp0firewall.ps1\"'"
