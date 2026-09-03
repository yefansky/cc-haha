[CmdletBinding()]
param(
  [switch]$Remove,
  [string]$DesktopDirectory
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

if ($env:OS -ne 'Windows_NT') {
  throw 'The cc-haha source desktop shortcut is only supported on Windows.'
}

$scriptPath = $MyInvocation.MyCommand.Path
$scriptDir = Split-Path -Parent $scriptPath
$desktopRoot = (Resolve-Path -LiteralPath (Join-Path $scriptDir '..')).Path
$repoRoot = (Resolve-Path -LiteralPath (Join-Path $desktopRoot '..')).Path
$launcherPath = (Resolve-Path -LiteralPath (Join-Path $repoRoot 'startup.bat')).Path
$iconPath = (Resolve-Path -LiteralPath (Join-Path $desktopRoot 'src-tauri\icons\icon.ico')).Path
$shortcutFileName = 'Claude Code Haha (Source).lnk'

if (-not $DesktopDirectory) {
  $DesktopDirectory = [Environment]::GetFolderPath([Environment+SpecialFolder]::DesktopDirectory)
}
if (-not $DesktopDirectory) {
  throw 'Windows did not return a desktop directory.'
}

$shortcutPath = Join-Path $DesktopDirectory $shortcutFileName
if ($Remove) {
  if (Test-Path -LiteralPath $shortcutPath -PathType Leaf) {
    Remove-Item -LiteralPath $shortcutPath -Force
    Write-Host "Removed source shortcut: $shortcutPath"
  } else {
    Write-Host "Source shortcut is already absent: $shortcutPath"
  }
  exit 0
}

New-Item -ItemType Directory -Path $DesktopDirectory -Force | Out-Null

$shell = New-Object -ComObject WScript.Shell
$shortcut = $null
$legacyShortcut = $null
try {
  $shortcut = $shell.CreateShortcut($shortcutPath)
  $shortcut.TargetPath = $launcherPath
  $shortcut.Arguments = ''
  $shortcut.WorkingDirectory = $repoRoot
  $shortcut.IconLocation = "$iconPath,0"
  $shortcut.Description = 'Launch Claude Code Haha from this source checkout'
  $shortcut.WindowStyle = 7
  $shortcut.Save()

  $legacyShortcutPath = Join-Path $DesktopDirectory 'cc-haha.bat.lnk'
  if ($legacyShortcutPath -ne $shortcutPath -and (Test-Path -LiteralPath $legacyShortcutPath -PathType Leaf)) {
    $legacyShortcut = $shell.CreateShortcut($legacyShortcutPath)
    if ($legacyShortcut.TargetPath -and
        ([IO.Path]::GetFullPath($legacyShortcut.TargetPath) -eq [IO.Path]::GetFullPath($launcherPath))) {
      [void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($legacyShortcut)
      $legacyShortcut = $null
      Remove-Item -LiteralPath $legacyShortcutPath -Force
      Write-Host "Migrated legacy source shortcut: $legacyShortcutPath"
    }
  }
} finally {
  if ($null -ne $legacyShortcut) {
    [void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($legacyShortcut)
  }
  if ($null -ne $shortcut) {
    [void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($shortcut)
  }
  [void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($shell)
}

Write-Host "Created or updated source shortcut: $shortcutPath"
Write-Host "Source checkout: $repoRoot"
