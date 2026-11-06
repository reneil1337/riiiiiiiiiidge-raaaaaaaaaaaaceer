# Start the RR4 LAN netplay relay on TCP 3010.
# Usage: powershell -ExecutionPolicy Bypass -File start-netplay.ps1
$env:PORT = '3010'
$env:HOST = '0.0.0.0'
Set-Location $PSScriptRoot
Write-Host "RR4 netplay relay -> http://0.0.0.0:3010  (Ctrl+C to stop)"
node server.js
