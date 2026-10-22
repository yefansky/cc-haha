[CmdletBinding()]
param(
  [string]$RepoRoot,
  [string]$BunExe,
  [string]$NodeExe
)

$ErrorActionPreference = 'Stop'
if ([string]::IsNullOrWhiteSpace($RepoRoot)) {
  $RepoRoot = Split-Path -Parent $PSScriptRoot
}
$RepoRoot = (Resolve-Path -LiteralPath $RepoRoot).Path
if ([string]::IsNullOrWhiteSpace($BunExe)) {
  $bunCommand = Get-Command bun -ErrorAction Stop
  $BunExe = if ($bunCommand.CommandType -eq 'Application') {
    $bunCommand.Source
  } else {
    Join-Path $env:APPDATA 'npm\node_modules\bun\bin\bun.exe'
  }
}
if ([string]::IsNullOrWhiteSpace($NodeExe)) {
  $NodeExe = (Get-Command node.exe -ErrorAction Stop).Source
}

# Keep downloads, extraction and native build caches beside this source checkout.
# Only this process and its children inherit these paths; user settings stay intact.
$cacheRoot = Join-Path $RepoRoot '.runtime\source-desktop'
$env:TEMP = Join-Path $cacheRoot 'tmp'
$env:TMP = $env:TEMP
$env:BUN_INSTALL_CACHE_DIR = Join-Path $cacheRoot 'bun-cache'
$env:ELECTRON_CACHE = Join-Path $cacheRoot 'electron-cache'
$env:electron_config_cache = $env:ELECTRON_CACHE
$env:npm_config_cache = Join-Path $cacheRoot 'npm-cache'
$env:npm_config_devdir = Join-Path $cacheRoot 'node-gyp'
New-Item -ItemType Directory -Force -Path $env:TEMP | Out-Null

# A directory or a few sentinel files cannot prove an installation is complete.
# Bun checks both lockfiles on every development launch and restores missing files.
foreach ($directory in @($RepoRoot, (Join-Path $RepoRoot 'desktop'))) {
  Write-Host "Checking source dependencies: $directory" -ForegroundColor Cyan
  Push-Location -LiteralPath $directory
  try {
    & $BunExe install --frozen-lockfile
    if ($LASTEXITCODE -ne 0) {
      throw "Dependency installation failed in $directory (exit $LASTEXITCODE). Check the error above and retry startup.bat."
    }
  } finally {
    Pop-Location
  }
}

# Installing Electron's npm package does not guarantee the runtime was downloaded.
# Its installer validates the installed version and returns immediately when ready.
$desktopRoot = Join-Path $RepoRoot 'desktop'
$electronInstaller = Join-Path $desktopRoot 'node_modules\electron\install.js'
Write-Host 'Checking the Electron desktop runtime...' -ForegroundColor Cyan
& $NodeExe $electronInstaller
if ($LASTEXITCODE -ne 0) {
  throw "Electron runtime installation failed (exit $LASTEXITCODE). Check the download connection and retry startup.bat. Cache: $env:ELECTRON_CACHE"
}
if (-not (Test-Path -LiteralPath (Join-Path $desktopRoot 'node_modules\electron\dist\electron.exe'))) {
  throw 'Electron installation finished without electron.exe. Check the installer output and retry startup.bat.'
}
if (-not (Test-Path -LiteralPath (Join-Path $desktopRoot 'node_modules\node-pty\prebuilds'))) {
  throw 'The node-pty prebuilds are still missing after installation. Check the dependency installation output.'
}
Write-Host 'Source desktop dependencies are ready.' -ForegroundColor Green
