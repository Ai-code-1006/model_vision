$ErrorActionPreference = "Stop"

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$configPath = Join-Path $scriptDir "config.json"
$launcherPath = Join-Path $scriptDir "launcher.js"
$claudeSettingsPath = Join-Path $HOME ".claude\settings.json"
$configText = Get-Content $configPath -Raw
$listenPortMatch = [regex]::Match($configText, '"listen_port"\s*:\s*(\d+)')
if (-not $listenPortMatch.Success) {
  throw "listen_port is missing in $configPath"
}
$listenPort = [int]$listenPortMatch.Groups[1].Value

function Repair-ClaudeSettings {
  if (-not (Test-Path $claudeSettingsPath)) {
    return
  }

  $settings = Get-Content -LiteralPath $claudeSettingsPath -Raw | ConvertFrom-Json
  if (-not $settings.env) {
    $settings | Add-Member -MemberType NoteProperty -Name env -Value ([pscustomobject]@{})
  }

  $expectedBaseUrl = "http://127.0.0.1:$listenPort"
  if ($settings.env.ANTHROPIC_BASE_URL -ne $expectedBaseUrl) {
    $settings.env.ANTHROPIC_BASE_URL = $expectedBaseUrl
    $jsonText = $settings | ConvertTo-Json -Depth 20
    $utf8NoBom = New-Object System.Text.UTF8Encoding($false)
    [System.IO.File]::WriteAllText($claudeSettingsPath, "$jsonText`n", $utf8NoBom)
    Write-Output "Claude settings repaired: ANTHROPIC_BASE_URL=$expectedBaseUrl"
  }
}

function Get-RouterPid {
  $connection = Get-NetTCPConnection -LocalAddress 127.0.0.1 -LocalPort $listenPort -State Listen -ErrorAction SilentlyContinue |
    Select-Object -First 1
  if ($connection) {
    return $connection.OwningProcess
  }
  return $null
}

$runningPid = Get-RouterPid
if ($runningPid) {
  Repair-ClaudeSettings
  Write-Output "Router already running with PID $runningPid"
  exit 0
}

Repair-ClaudeSettings
& node $launcherPath

for ($i = 0; $i -lt 8; $i++) {
  Start-Sleep -Milliseconds 500
  $runningPid = Get-RouterPid
  if ($runningPid) {
    Write-Output "Router started with PID $runningPid"
    exit 0
  }
}

Write-Output "Router start requested"
