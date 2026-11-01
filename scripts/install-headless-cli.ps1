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
function Read-CliDocument([string]$Arguments) {
  $startInfo = [Diagnostics.ProcessStartInfo]::new()
  $startInfo.FileName = $cliExecutable
  $startInfo.Arguments = $Arguments
  $startInfo.UseShellExecute = $false
  $startInfo.CreateNoWindow = $true
  $startInfo.RedirectStandardOutput = $true
  $startInfo.RedirectStandardError = $true
  $startInfo.StandardOutputEncoding = [Text.UTF8Encoding]::new($false)
  $process = [Diagnostics.Process]::Start($startInfo)
  try {
    $outputTask = $process.StandardOutput.ReadToEndAsync()
    $errorTask = $process.StandardError.ReadToEndAsync()
    if (-not $process.WaitForExit(15000)) { $process.Kill(); throw 'CLI manual export timed out.' }
    if ($process.ExitCode -ne 0) { throw 'Executable does not support offline CLI documentation export.' }
    return $outputTask.GetAwaiter().GetResult()
  } finally { $process.Dispose() }
}
$manualText = Read-CliDocument 'help --manual'
$capabilitiesText = Read-CliDocument 'capabilities --json'
$capabilities = $capabilitiesText | ConvertFrom-Json
if ($capabilities.program -ne 'cc-haha' -or $capabilities.schema_version -lt 2 -or -not $capabilities.manual.bundled) { throw 'Executable does not expose a supported cc-haha documentation contract.' }
foreach ($documentName in @('HELP.md', 'README.md', 'capabilities.json')) {
  $documentPath = Join-Path $cliBinDirectory $documentName
  if (Test-Path -LiteralPath $documentPath) {
    $existingDocument = Get-Content -Raw -Encoding UTF8 -LiteralPath $documentPath
    if ($documentName -eq 'capabilities.json') {
      try { $managedDocument = ($existingDocument | ConvertFrom-Json).program -eq 'cc-haha' } catch { $managedDocument = $false }
    } else { $managedDocument = $existingDocument.Contains('cc-haha managed offline document') }
    if (-not $managedDocument) { throw 'Refusing to overwrite an unrelated installed document.' }
  }
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
$readme = @(
  '<!-- cc-haha managed offline document -->', '# cc-haha offline command guide', '',
  'This installer references the supplied stable executable; it does not copy or relocate it.',
  ('Executable: ' + $cliExecutable),
  ('Configuration fallback: ' + $(if ($cliConfigDirectory) { $cliConfigDirectory } else { 'CLAUDE_CONFIG_DIR or user ~/.claude' })),
  'An explicitly set CLAUDE_CONFIG_DIR takes precedence. No credentials are copied.', '',
  'Start here: cc-haha help', 'Full offline manual: cc-haha help --manual',
  'For codeagents: cc-haha capabilities --json', 'Select a provider: cc-haha providers --json', '',
  'Read HELP.md and capabilities.json beside this file. They are exported from this exact executable.',
  'Keep this bin directory separate from cc-haha.exe so the configuration wrapper is not bypassed.',
  'Unknown upstream prices/billed costs are null; client estimates are never provider billing evidence.'
) -join "`r`n"
[IO.File]::WriteAllText((Join-Path $cliBinDirectory 'HELP.md'), "<!-- cc-haha managed offline document -->`r`n" + $manualText, [Text.UTF8Encoding]::new($false))
[IO.File]::WriteAllText((Join-Path $cliBinDirectory 'README.md'), $readme, [Text.UTF8Encoding]::new($false))
[IO.File]::WriteAllText((Join-Path $cliBinDirectory 'capabilities.json'), $capabilitiesText, [Text.UTF8Encoding]::new($false))
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
[pscustomobject]@{ launcher = $launcherPath; executable = $cliExecutable; manual = (Join-Path $cliBinDirectory 'HELP.md'); capabilities = (Join-Path $cliBinDirectory 'capabilities.json'); defaultConfigDirectory = $cliConfigDirectory; addedToUserPath = [bool]$AddToUserPath; restartTerminal = [bool]$AddToUserPath } | ConvertTo-Json -Compress
