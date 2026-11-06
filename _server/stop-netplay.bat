@echo off
setlocal
cd /d "%~dp0"
echo Stopping the RR4 netplay relay on TCP 3010...
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0netplay\stop-netplay.ps1" -Port 3010
pause
