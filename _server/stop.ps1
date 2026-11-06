$ErrorActionPreference = 'SilentlyContinue'
Write-Host 'Stopping the R4 LAN cabinet and netplay relay...' -ForegroundColor Yellow
Get-Process Ridge_Racer_4_Recompiled | Stop-Process -Force
foreach ($port in @(8080, 3010)) {
  # RemotePort 0 identifies the listener; netstat state names are localized.
  $pids = Get-NetTCPConnection -LocalPort $port -ErrorAction SilentlyContinue |
    Where-Object { $_.RemotePort -eq 0 -and $_.OwningProcess -gt 0 } |
    Select-Object -ExpandProperty OwningProcess -Unique
  foreach ($procId in $pids) {
    Stop-Process -Id $procId -Force -ErrorAction SilentlyContinue
  }
}
Write-Host 'Done.' -ForegroundColor Green
