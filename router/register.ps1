$ErrorActionPreference = "Stop"

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$startScriptPath = Join-Path $scriptDir "start.ps1"
$taskName = "ClaudeModelRouter"

# Generate VBS launcher with correct absolute path
$vbsPath = Join-Path $scriptDir "start-hidden.vbs"
$vbsContent = @"
Set objShell = CreateObject("WScript.Shell")
objShell.Run "powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File ""$startScriptPath""", 0, False
"@
[System.IO.File]::WriteAllText($vbsPath, $vbsContent, (New-Object System.Text.UTF8Encoding($false)))
Write-Output "Generated: $vbsPath"

# Register scheduled task — login trigger only, no watchdog
# proxy.js is a persistent process that self-heals (repairs settings every 5s)
# If proxy dies, it restarts on next login; manual restart: start.ps1
$vbsExe = Join-Path $env:SystemRoot "System32\wscript.exe"
$action = New-ScheduledTaskAction `
  -Execute $vbsExe `
  -Argument "`"$vbsPath`""

$logonTrigger = New-ScheduledTaskTrigger -AtLogOn
$logonTrigger.Delay = "PT30S"

$settings = New-ScheduledTaskSettingsSet `
  -AllowStartIfOnBatteries `
  -DontStopIfGoingOnBatteries `
  -ExecutionTimeLimit (New-TimeSpan -Minutes 2) `
  -MultipleInstances IgnoreNew `
  -StartWhenAvailable

$principal = New-ScheduledTaskPrincipal `
  -UserId $env:USERNAME `
  -LogonType Interactive `
  -RunLevel Limited

Register-ScheduledTask `
  -TaskName $taskName `
  -Action $action `
  -Trigger $logonTrigger `
  -Settings $settings `
  -Principal $principal `
  -Force | Out-Null

Write-Output "Scheduled task '$taskName' registered (login trigger only)."
