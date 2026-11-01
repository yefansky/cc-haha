param(
  [Parameter(Mandatory = $true)][string]$Executable,
  [Parameter(Mandatory = $true)][string]$InstallDirectory,
  [string]$ConfigDirectory,
  [switch]$AddToUserPath
)
$ErrorActionPreference = 'Stop'
$cliExecutable = (Resolve-Path -LiteralPath $Executable).Path
if (-not (Test-Path -LiteralPath $cliExecutable -PathType Leaf)) { throw 'Executable must be an existing file.' }
if ([IO.Path]::GetExtension($cliExecutable) -ine '.exe') { throw 'Executable must be a compiled Windows .exe.' }
$cliBinDirectory = [IO.Path]::GetFullPath($InstallDirectory)
$cliConfigDirectory = if ($ConfigDirectory) { (Resolve-Path -LiteralPath $ConfigDirectory).Path } else { $null }
$launcherPath = Join-Path $cliBinDirectory 'cc-haha.cmd'
$marker = 'rem cc-haha managed headless launcher'
if (Test-Path -LiteralPath $launcherPath) {
  if (-not (Get-Content -Raw -LiteralPath $launcherPath).Contains($marker)) { throw 'Refusing to overwrite an unmanaged cc-haha.cmd.' }
}
New-Item -ItemType Directory -Force -Path $cliBinDirectory | Out-Null
$batchExecutable = $cliExecutable.Replace('%', '%%')
$lines = @('@echo off', $marker, 'setlocal', 'for /f "tokens=2 delims=:" %%A in (''chcp'') do set "_CC_HAHA_CP=%%A"', 'chcp 65001 >nul')
if ($cliConfigDirectory) {
  $batchConfig = $cliConfigDirectory.Replace('%', '%%')
  $lines += ('if not defined CLAUDE_CONFIG_DIR set "CLAUDE_CONFIG_DIR=' + $batchConfig + '"')
}
$lines += ('"' + $batchExecutable + '" %*')
$lines += @('set "_CC_HAHA_EXIT=%errorlevel%"', 'chcp %_CC_HAHA_CP% >nul', 'exit /b %_CC_HAHA_EXIT%')
[IO.File]::WriteAllLines($launcherPath, $lines, [Text.UTF8Encoding]::new($false))
if ($AddToUserPath) {
  $existingUserPath = [Environment]::GetEnvironmentVariable('Path', 'User')
  $existingEntries = @($existingUserPath -split ';' | Where-Object { $_ })
  $alreadyPresent = $existingEntries | Where-Object { $_.TrimEnd('\') -ieq $cliBinDirectory.TrimEnd('\') }
  if (-not $alreadyPresent) {
    $nextUserPath = if ([string]::IsNullOrWhiteSpace($existingUserPath)) { $cliBinDirectory } else { $existingUserPath.TrimEnd(';') + ';' + $cliBinDirectory }
    [Environment]::SetEnvironmentVariable('Path', $nextUserPath, 'User')
    if (-not ('CcHahaEnvironmentBroadcast' -as [type])) {
      Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class CcHahaEnvironmentBroadcast {
  [DllImport("user32.dll", SetLastError = true, CharSet = CharSet.Auto)]
  public static extern IntPtr SendMessageTimeout(IntPtr window, uint message, IntPtr parameter, string value, uint flags, uint timeout, out IntPtr result);
}
'@
    }
    $broadcastResult = [IntPtr]::Zero
    [void][CcHahaEnvironmentBroadcast]::SendMessageTimeout([IntPtr]0xffff, 0x1A, [IntPtr]::Zero, 'Environment', 0x2, 5000, [ref]$broadcastResult)
  }
}
[pscustomobject]@{ launcher = $launcherPath; executable = $cliExecutable; defaultConfigDirectory = $cliConfigDirectory; addedToUserPath = [bool]$AddToUserPath; restartTerminal = [bool]$AddToUserPath } | ConvertTo-Json -Compress
