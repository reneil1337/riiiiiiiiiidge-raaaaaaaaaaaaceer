@echo off
setlocal
cd /d "%~dp0"
set PORT=3010
set HOST=0.0.0.0
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js 20 or newer is required.
  pause
  exit /b 1
)
echo RR4 netplay relay -^> http://0.0.0.0:3010  (Ctrl+C to stop)
echo Health: http://127.0.0.1:3010/health
node server.js
