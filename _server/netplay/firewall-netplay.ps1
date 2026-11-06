# Allow LAN clients to reach the netplay relay and the test harness.
# Run from an elevated PowerShell.
#
# TCP 3010 is opened on ALL profiles (Domain, Private, Public). The WLAN
# adapter is often classified Public; a Private-only rule silently blocks
# guests. This matches the known-good "RR4 Netplay 3010 (Any)" rule.
$rules = @(
  @{ Name = 'RR4 Netplay 3010'; Port = 3010; Profile = 'Any' },
  @{ Name = 'RR4 Netplay Harness 3011'; Port = 3011; Profile = 'Private' }
)
foreach ($r in $rules) {
  $existing = Get-NetFirewallRule -DisplayName $r.Name -ErrorAction SilentlyContinue
  if (-not $existing) {
    New-NetFirewallRule -DisplayName $r.Name -Direction Inbound -Protocol TCP `
      -LocalPort $r.Port -Action Allow -Profile $r.Profile | Out-Null
    Write-Host "Added inbound TCP $($r.Port) on $($r.Profile) ($($r.Name))"
  } else {
    # Update old rules in place: the 3010 rule used to be Private-only.
    Set-NetFirewallRule -DisplayName $r.Name -Enabled True -Action Allow `
      -Profile $r.Profile | Out-Null
    Write-Host "Updated inbound TCP $($r.Port) on $($r.Profile) ($($r.Name))"
  }
}

# Older manual setup may have created this exact rule name; keep it on Any too.
$alias = 'RR4 Netplay 3010 (Any)'
if (Get-NetFirewallRule -DisplayName $alias -ErrorAction SilentlyContinue) {
  Set-NetFirewallRule -DisplayName $alias -Enabled True -Action Allow -Profile Any | Out-Null
  Write-Host "Confirmed inbound TCP 3010 on Any ($alias)"
}
