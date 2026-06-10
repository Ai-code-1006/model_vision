$ErrorActionPreference = "Stop"

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$configPath = Join-Path $scriptDir "config.json"
$configText = Get-Content $configPath -Raw
$listenPortMatch = [regex]::Match($configText, '"listen_port"\s*:\s*(\d+)')
if (-not $listenPortMatch.Success) {
  throw "listen_port is missing in $configPath"
}
$listenPort = [int]$listenPortMatch.Groups[1].Value

function Get-RouterPid {
  $connection = Get-NetTCPConnection -LocalAddress 127.0.0.1 -LocalPort $listenPort -State Listen -ErrorAction SilentlyContinue |
    Select-Object -First 1
  if ($connection) {
    return $connection.OwningProcess
  }
  return $null
}

$routerPid = Get-RouterPid
if (-not $routerPid) {
  Write-Output "No router process is listening on port $listenPort"
  exit 0
}

Stop-Process -Id $routerPid -Force
Write-Output "Router stopped (PID $routerPid)"
