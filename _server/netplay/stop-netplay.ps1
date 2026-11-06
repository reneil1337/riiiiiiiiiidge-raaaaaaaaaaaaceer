# Stop the process listening on the netplay port (default 3010).
param([int]$Port = 3010)

# Get-NetTCPConnection is locale-independent. RemotePort 0 identifies the
# listener; netstat state names are localized (e.g. "ABHÖREN" on German
# Windows), so do not match "LISTENING" here.
$pids = @(Get-NetTCPConnection -LocalPort $Port -ErrorAction SilentlyContinue |
  Where-Object { $_.RemotePort -eq 0 -and $_.OwningProcess -gt 0 } |
  Select-Object -ExpandProperty OwningProcess -Unique)

if (-not $pids) {
  # Fallback for hosts where Get-NetTCPConnection hides the owning process.
  foreach ($line in (netstat -ano | Select-String ":$Port\s")) {
    if ($line.Line -match "^\s*TCP\s+\S+:$Port\s+(?:0\.0\.0\.0|\[::\]):0\s+\S+\s+(\d+)\s*$") {
      $pids += [int]$Matches[1]
    }
  }
  $pids = $pids | Sort-Object -Unique | Where-Object { $_ -ne 0 }
}

if (-not $pids) { Write-Host "No listener on :$Port"; exit 0 }
foreach ($procId in $pids) {
  Write-Host "Stopping pid $procId on :$Port"
  Stop-Process -Id $procId -Force -ErrorAction SilentlyContinue
}
