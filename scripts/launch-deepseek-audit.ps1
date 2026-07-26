[CmdletBinding()]
param(
  [string]$DataDir
)

$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot
if ([string]::IsNullOrWhiteSpace($DataDir)) {
  $DataDir = Join-Path $repoRoot '.cc-haha-audit'
}

if (-not (Test-Path -LiteralPath (Join-Path $repoRoot 'desktop\package.json'))) {
  throw "Claude Code Haha repository was not found at: $repoRoot"
}
$bunCommand = Get-Command bun -ErrorAction SilentlyContinue
if (-not $bunCommand) {
  throw 'Bun was not found. Install Bun before launching the source desktop app.'
}
$bunExe = if ($bunCommand.CommandType -eq 'Application') {
  $bunCommand.Source
} else {
  Join-Path $env:APPDATA 'npm\node_modules\bun\bin\bun.exe'
}
if (-not (Test-Path -LiteralPath $bunExe)) {
  throw "A runnable bun.exe was not found. Install Bun or add it to PATH: $bunExe"
}
# electron-dev.ts starts nested `bun` processes, which cannot resolve an npm
# PowerShell shim. Put the real executable directory on PATH for those children.
$bunDir = Split-Path -Parent $bunExe
$env:Path = "$bunDir;$env:Path"
$env:PATH = "$bunDir;$env:PATH"

New-Item -ItemType Directory -Force -Path $DataDir | Out-Null

$env:CLAUDE_CONFIG_DIR = $DataDir
$env:CC_HAHA_TRACE_API_CALLS = '1'
$env:DISABLE_TELEMETRY = '1'
$env:CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = '1'
$env:NO_PROXY = 'localhost,127.0.0.1,::1'
$env:no_proxy = $env:NO_PROXY

Write-Host 'Starting Claude Code Haha with API Trace enabled.' -ForegroundColor Cyan
Write-Host "Isolated data directory: $DataDir" -ForegroundColor DarkCyan
Write-Host 'Configure DeepSeek in Settings > Providers > Add Provider, then select the built-in DeepSeek preset.' -ForegroundColor DarkCyan

Push-Location (Join-Path $repoRoot 'desktop')
try {
  $sidecarPath = Join-Path (Get-Location) 'src-tauri\binaries\claude-sidecar-x86_64-pc-windows-msvc.exe'
  $sidecarSources = @(
    (Join-Path $repoRoot 'src\services\api\traceCapture.ts'),
    (Join-Path $repoRoot 'src\server\api\sessions.ts'),
    (Join-Path $repoRoot 'src\server\api\traces.ts'),
    (Join-Path $repoRoot 'src\utils\shell\powershellProvider.ts'),
    (Join-Path (Get-Location) 'scripts\build-sidecars.ts')
  )
  $sidecarNeedsBuild = -not (Test-Path -LiteralPath $sidecarPath)
  if (-not $sidecarNeedsBuild) {
    $sidecarWriteTime = (Get-Item -LiteralPath $sidecarPath).LastWriteTimeUtc
    $newerSource = $sidecarSources | Where-Object {
      (Test-Path -LiteralPath $_) -and (Get-Item -LiteralPath $_).LastWriteTimeUtc -gt $sidecarWriteTime
    } | Select-Object -First 1
    $sidecarNeedsBuild = $null -ne $newerSource
  }
  if ($sidecarNeedsBuild) {
    Write-Host 'Building the local desktop sidecar because its source changed...' -ForegroundColor Cyan
    & $bunExe run build:sidecars
    if ($LASTEXITCODE -ne 0 -or -not (Test-Path -LiteralPath $sidecarPath)) {
      throw 'Desktop sidecar build failed. See the output above for details.'
    }
  }
  & $bunExe run electron:dev
} finally {
  Pop-Location
}
