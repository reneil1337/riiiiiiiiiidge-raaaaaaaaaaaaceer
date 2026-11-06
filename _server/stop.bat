@echo off
setlocal
echo Stopping the R4 LAN cabinet and netplay relay...
taskkill /IM Ridge_Racer_4_Recompiled.exe /F >nul 2>nul
rem Get-NetTCPConnection is locale-independent; netstat state names are
rem localized (e.g. "ABHÖREN" instead of "LISTENING" on German Windows).
for /f %%a in ('powershell -NoProfile -Command "Get-NetTCPConnection -LocalPort 8080 -ErrorAction SilentlyContinue | Where-Object RemotePort -eq 0 | Select-Object -ExpandProperty OwningProcess -Unique"') do (
  taskkill /PID %%a /F >nul 2>nul
)
for /f %%a in ('powershell -NoProfile -Command "Get-NetTCPConnection -LocalPort 3010 -ErrorAction SilentlyContinue | Where-Object RemotePort -eq 0 | Select-Object -ExpandProperty OwningProcess -Unique"') do (
  taskkill /PID %%a /F >nul 2>nul
)
echo Done.
timeout /t 2 >nul
