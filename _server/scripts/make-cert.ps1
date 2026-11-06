<#
  make-cert.ps1 — create the self-signed TLS cert pair used by RR4_TLS=1.

  Generates _server\certs\rr4-cert.pem + _server\certs\rr4-key.pem covering
  localhost, 127.0.0.1, ::1, the machine name and every non-loopback IPv4 on
  this box (so phones/tablets on the LAN can open https://<lan-ip>:8443/).

  Usage:
    powershell -NoProfile -ExecutionPolicy Bypass -File scripts\make-cert.ps1
    powershell ... -File scripts\make-cert.ps1 -Force            # overwrite
    powershell ... -File scripts\make-cert.ps1 -Method Store     # force the
                                                                 # New-SelfSignedCertificate path
    powershell ... -File scripts\make-cert.ps1 -DnsName rr4.lan,<host-lan-ip>

  The browser will warn once per device (self-signed). Trust it properly with
  mkcert instead if you have it:
    winget install --id FiloSottile.mkcert -e
    mkcert -install
    mkcert -cert-file certs\rr4-cert.pem -key-file certs\rr4-key.pem `
           "<host-lan-ip>" localhost 127.0.0.1 ::1

  Raw openssl equivalent (ships with Git for Windows):
    cd _server
    New-Item -ItemType Directory -Force certs | Out-Null
    openssl req -x509 -newkey rsa:2048 -sha256 -days 397 -nodes `
      -keyout certs\rr4-key.pem -out certs\rr4-cert.pem `
      -subj "/CN=rr4-lan" `
      -addext "subjectAltName=DNS:localhost,IP:127.0.0.1,IP:<host-lan-ip>"

  No network access, no CA install, nothing is generated at server boot: a
  missing cert just logs a line and the cabinet keeps serving HTTP :8080.
#>
param(
  [string[]]$DnsName = @(),
  [string]$OutDir = '',
  [int]$Days = 397,
  [ValidateSet('Auto', 'OpenSSL', 'Store')]
  [string]$Method = 'Auto',
  [switch]$Force
)

$ErrorActionPreference = 'Stop'
if (-not $OutDir) { $OutDir = Join-Path (Split-Path -Parent $PSScriptRoot) 'certs' }
$OutDir = [System.IO.Path]::GetFullPath($OutDir)
$certPath = Join-Path $OutDir 'rr4-cert.pem'
$keyPath = Join-Path $OutDir 'rr4-key.pem'

# ---- names ---------------------------------------------------------------
$names = New-Object System.Collections.Generic.List[string]
foreach ($n in @('localhost', '127.0.0.1', '::1', $env:COMPUTERNAME) + $DnsName) {
  if ($n -and -not $names.Contains($n)) { $names.Add($n) }
}
try {
  Get-NetIPAddress -AddressFamily IPv4 -ErrorAction Stop |
    Where-Object { $_.IPAddress -ne '127.0.0.1' -and $_.IPAddress -notlike '169.254.*' } |
    ForEach-Object { if (-not $names.Contains($_.IPAddress)) { $names.Add($_.IPAddress) } }
} catch {
  [System.Net.NetworkInformation.NetworkInterface]::GetAllNetworkInterfaces() |
    Where-Object { $_.OperationalStatus -eq 'Up' } |
    ForEach-Object { $_.GetIPProperties().UnicastAddresses } |
    Where-Object { $_.Address.AddressFamily -eq 'InterNetwork' -and -not $_.Address.ToString().StartsWith('127.') } |
    ForEach-Object { if (-not $names.Contains($_.Address.ToString())) { $names.Add($_.Address.ToString()) } }
}

$dnsNames = @($names | Where-Object { -not ($_ -match '^[0-9.]+$' -or $_ -eq '::1') })
$ipNames = @($names | Where-Object { $_ -match '^[0-9.]+$' -or $_ -eq '::1' })
# openssl wants IPv6 in brackets inside subjectAltName (IP:::1).
$sanParts = @()
$sanParts += $dnsNames | ForEach-Object { "DNS:$_" }
$sanParts += $ipNames | ForEach-Object { if ($_ -eq '::1') { 'IP:::1' } else { "IP:$_" } }
$san = ($sanParts -join ',')

Write-Host "cert names: $($names -join ', ')"

if ((Test-Path $certPath) -and (Test-Path $keyPath) -and -not $Force) {
  Write-Host "already present: $certPath / $keyPath" -ForegroundColor Green
  Write-Host "rerun with -Force to regenerate." -ForegroundColor Yellow
  exit 0
}
New-Item -ItemType Directory -Force -Path $OutDir | Out-Null

# ---- find openssl --------------------------------------------------------
function Find-OpenSsl {
  $cmd = Get-Command openssl -ErrorAction SilentlyContinue
  if ($cmd) { return $cmd.Source }
  foreach ($p in @(
      "$env:ProgramFiles\Git\usr\bin\openssl.exe",
      "$env:ProgramFiles\Git\mingw64\bin\openssl.exe",
      "${env:ProgramFiles(x86)}\Git\usr\bin\openssl.exe",
      "$env:ProgramFiles\OpenSSL-Win64\bin\openssl.exe",
      "$env:ProgramFiles\OpenSSL\bin\openssl.exe",
      "C:\ProgramData\chocolatey\bin\openssl.exe"
    )) {
    if (Test-Path -LiteralPath $p) { return $p }
  }
  return $null
}

$openssl = $null
if ($Method -ne 'Store') { $openssl = Find-OpenSsl }
if ($Method -eq 'OpenSSL' -and -not $openssl) {
  throw 'openssl not found. Install Git for Windows or use -Method Store.'
}

if ($openssl) {
  Write-Host "using openssl: $openssl"
  # -days 397 keeps the pair inside Chromium's 398-day publicly-trusted cap.
  & $openssl req -x509 -newkey rsa:2048 -sha256 -days $Days -nodes `
    -keyout $keyPath -out $certPath `
    -subj '/CN=rr4-lan' -addext "subjectAltName=$san"
  if ($LASTEXITCODE -ne 0) { throw "openssl failed with exit code $LASTEXITCODE" }
} else {
  Write-Host 'openssl not found — falling back to New-SelfSignedCertificate + .NET PEM export.' -ForegroundColor Yellow

  $cert = New-SelfSignedCertificate `
    -Subject 'CN=rr4-lan' `
    -DnsName $dnsNames `
    -TextExtension @("2.5.29.17={text}$san") `
    -KeyAlgorithm RSA -KeyLength 2048 -KeyExportPolicy Exportable `
    -NotAfter (Get-Date).AddDays($Days) `
    -CertStoreLocation 'Cert:\CurrentUser\My'

  function ConvertTo-Pem([string]$label, [byte[]]$der) {
    $b64 = [Convert]::ToBase64String($der, 'InsertLineBreaks')
    return "-----BEGIN $label-----`r`n$b64`r`n-----END $label-----`r`n"
  }
  function ConvertTo-DerLength([int]$len) {
    if ($len -lt 0x80) { return [byte[]]@([byte]$len) }
    $bytes = New-Object System.Collections.Generic.List[byte]
    $tmp = $len
    while ($tmp -gt 0) { $bytes.Insert(0, [byte]($tmp -band 0xFF)); $tmp = $tmp -shr 8 }
    $head = [byte](0x80 -bor $bytes.Count)
    return [byte[]](@($head) + $bytes.ToArray())
  }
  function ConvertTo-DerInteger([byte[]]$raw) {
    $i = 0
    while ($i -lt ($raw.Length - 1) -and $raw[$i] -eq 0) { $i++ }
    $body = [byte[]]$raw[$i..($raw.Length - 1)]
    if ($body[0] -band 0x80) { $body = [byte[]](@([byte]0) + $body) }
    return [byte[]](@([byte]0x02) + (ConvertTo-DerLength $body.Length) + $body)
  }

  $rsa = [System.Security.Cryptography.X509Certificates.RSACertificateExtensions]::GetRSAPrivateKey($cert)
  $p = $rsa.ExportParameters($true)
  # PKCS#1 RSAPrivateKey ::= SEQUENCE { version, n, e, d, p, q, dP, dQ, qInv }
  $parts = @(
    (ConvertTo-DerInteger ([byte[]]@(0))),
    (ConvertTo-DerInteger $p.Modulus),
    (ConvertTo-DerInteger $p.Exponent),
    (ConvertTo-DerInteger $p.D),
    (ConvertTo-DerInteger $p.P),
    (ConvertTo-DerInteger $p.Q),
    (ConvertTo-DerInteger $p.DP),
    (ConvertTo-DerInteger $p.DQ),
    (ConvertTo-DerInteger $p.InverseQ)
  )
  $bodyBytes = New-Object System.Collections.Generic.List[byte]
  foreach ($part in $parts) { foreach ($b in $part) { $bodyBytes.Add($b) } }
  $der = [byte[]](@([byte]0x30) + (ConvertTo-DerLength $bodyBytes.Count) + $bodyBytes.ToArray())

  [System.IO.File]::WriteAllText($certPath, (ConvertTo-Pem 'CERTIFICATE' $cert.RawData), (New-Object System.Text.UTF8Encoding($false)))
  [System.IO.File]::WriteAllText($keyPath, (ConvertTo-Pem 'RSA PRIVATE KEY' $der), (New-Object System.Text.UTF8Encoding($false)))
  Remove-Item -LiteralPath ("Cert:\CurrentUser\My\" + $cert.Thumbprint) -ErrorAction SilentlyContinue
}

Write-Host "wrote $certPath" -ForegroundColor Green
Write-Host "wrote $keyPath" -ForegroundColor Green
Write-Host ''
Write-Host 'enable it:  $env:RR4_TLS = "1"; node src/server.js' -ForegroundColor Cyan
Write-Host '            (or: start.ps1 -Tls)' -ForegroundColor Cyan
Write-Host 'smoke:      node scripts/https-smoke.mjs https://localhost:8443' -ForegroundColor Cyan
