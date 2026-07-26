[CmdletBinding(SupportsShouldProcess)]
param()

$ErrorActionPreference = 'Stop'
$repoRoot = (Split-Path -Parent $PSScriptRoot).TrimEnd('\')
$processNames = @('electron.exe', 'node.exe', 'claude-sidecar-x86_64-pc-windows-msvc.exe')

function Get-CcHahaProcesses {
  Get-CimInstance Win32_Process | Where-Object {
    $_.Name -in $processNames -and
    -not [string]::IsNullOrWhiteSpace($_.CommandLine) -and
    $_.CommandLine.IndexOf($repoRoot, [System.StringComparison]::OrdinalIgnoreCase) -ge 0
  }
}

$targets = @(Get-CcHahaProcesses)
if ($targets.Count -eq 0) {
  Write-Host 'cc-haha is not running in this laboratory directory.' -ForegroundColor Yellow
  exit 0
}

Write-Host "Stopping cc-haha processes under: $repoRoot" -ForegroundColor Cyan
if ($WhatIfPreference) {
  $targets | ForEach-Object { Write-Host "Would stop PID $($_.ProcessId): $($_.Name)" -ForegroundColor DarkCyan }
  return
}
foreach ($target in $targets) {
  if ($PSCmdlet.ShouldProcess("PID $($target.ProcessId) $($target.Name)", 'Stop')) {
    Stop-Process -Id $target.ProcessId -Force -ErrorAction SilentlyContinue
  }
}

Start-Sleep -Milliseconds 500
$remaining = @(Get-CcHahaProcesses)
if ($remaining.Count -gt 0) {
  $pids = ($remaining | ForEach-Object ProcessId) -join ', '
  throw "Some cc-haha processes are still running: $pids"
}

Write-Host 'cc-haha has stopped. You can now run startup.bat.' -ForegroundColor Green
