param(
  [switch]$Test,
  [switch]$NoBrowser,
  [switch]$NoNetplay,
  [switch]$Tls
)
$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath $PSScriptRoot
if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  throw 'Node.js 20 or newer is required.'
}
foreach ($required in @(
  'game\Ridge_Racer_4_Recompiled.exe',
  '..\disc\R4 - Ridge Racer Type 4 (USA).cue',
  '..\_tools\ffmpeg\bin\ffmpeg.exe'
)) {
  if (-not (Test-Path -LiteralPath (Join-Path $PSScriptRoot $required))) {
    throw "Missing required file: $required"
  }
}
if ($Test) {
  $env:RR4_NO_AUTOSTART = '1'
  $env:RR4_STREAM_SOURCE = 'test'
  Remove-Item Env:RR4_ATTACH -ErrorAction SilentlyContinue
  Write-Host 'TEST MODE: looping capture, native game is not launched.' -ForegroundColor Yellow
} else {
  Remove-Item Env:RR4_NO_AUTOSTART -ErrorAction SilentlyContinue
  Remove-Item Env:RR4_STREAM_SOURCE -ErrorAction SilentlyContinue
  $running = Get-Process Ridge_Racer_4_Recompiled -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($running) {
    $env:RR4_ATTACH = '1'
    $env:RR4_ATTACH_PID = [string]$running.Id
    Write-Host 'Found a running cabinet window - attaching instead of launching another.' -ForegroundColor Yellow
  } else {
    Remove-Item Env:RR4_ATTACH -ErrorAction SilentlyContinue
    Remove-Item Env:RR4_ATTACH_PID -ErrorAction SilentlyContinue
  }
}
if ($Tls) {
  # Opt-in HTTPS on :8443 next to the plain HTTP cabinet on :8080. Needs a cert
  # pair; scripts\make-cert.ps1 writes certs\rr4-cert.pem + certs\rr4-key.pem.
  # A missing cert never crashes the server: it logs one line and serves HTTP.
  $env:RR4_TLS = '1'
  $certFile = Join-Path $PSScriptRoot 'certs\rr4-cert.pem'
  $keyFile = Join-Path $PSScriptRoot 'certs\rr4-key.pem'
  if (-not (Test-Path -LiteralPath $certFile) -or -not (Test-Path -LiteralPath $keyFile)) {
    Write-Host 'No TLS cert yet - run: powershell -ExecutionPolicy Bypass -File scripts\make-cert.ps1' -ForegroundColor Yellow
  } else {
    Write-Host 'TLS enabled: https://localhost:8443/ (secure context) keeps http://localhost:8080/' -ForegroundColor Green
  }
}
if (-not $NoNetplay -and $env:RR4_NO_NETPLAY -ne '1') {
  # Get-NetTCPConnection can miss the relay listener on this host; probe /health.
  $relay = $false
  try {
    $health = Invoke-WebRequest -UseBasicParsing http://127.0.0.1:3010/health -TimeoutSec 1
    if ($health.StatusCode -eq 200) { $relay = $true }
  } catch { }
  if ($relay) {
    Write-Host 'Netplay relay already listening on TCP 3010.' -ForegroundColor Green
  } else {
    Write-Host 'Starting the netplay relay on TCP 3010 in a minimized window...' -ForegroundColor Yellow
    $relayBat = Join-Path $PSScriptRoot 'start-netplay.bat'
    Start-Process -FilePath 'cmd.exe' -ArgumentList '/c', "`"$relayBat`"" -WindowStyle Minimized
  }
} else {
  Write-Host 'Netplay relay skipped. Start start-netplay.bat manually for 2P LAN.' -ForegroundColor Yellow
}
if (-not $NoBrowser) {
  if ($Tls) { Start-Process 'https://localhost:8443/' } else { Start-Process 'http://localhost:8080/' }
}
node src/server.js
