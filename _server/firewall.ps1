$ErrorActionPreference = 'Stop'
$name = 'Ridge Racer 4 LAN (TCP 8080)'
$rule = Get-NetFirewallRule -DisplayName $name -ErrorAction SilentlyContinue
if (-not $rule) {
  New-NetFirewallRule -DisplayName $name -Direction Inbound -Protocol TCP -LocalPort 8080 -Action Allow -Profile Any | Out-Null
  Write-Host "Added firewall rule: $name" -ForegroundColor Green
} else {
  Write-Host "Firewall rule already exists: $name" -ForegroundColor Green
}
