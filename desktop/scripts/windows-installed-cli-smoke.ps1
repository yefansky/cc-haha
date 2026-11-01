# Read-only assertions shared by the ephemeral installer smoke and offline fixtures.
Set-StrictMode -Version Latest

# The caller opens a writable key only after the installer's ephemeral-CI guard.
# Fixtures pass an in-memory key; importing this file never accesses the registry.
function Set-CliPathSentinel {
  param($Key, [string]$Sentinel)
  $raw = $Key.GetValue('Path', $null, [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)
  $state = @{ Exists = $null -ne $raw; Value = $raw; Kind = $null; Sentinel = $Sentinel }
  if ($state.Exists) { $state.Kind = $Key.GetValueKind('Path') }
  $parts = @()
  if ($null -ne $raw -and [string]$raw -ne '') { $parts += [string]$raw }
  $parts += $Sentinel
  $Key.SetValue('Path', ($parts -join ';'), [Microsoft.Win32.RegistryValueKind]::ExpandString)
  return $state
}

function Assert-CliPathSentinel {
  param($Key, $State)
  $raw = [string]$Key.GetValue('Path', $null, [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)
  if ($State.Sentinel -notin @($raw -split ';') -or $Key.GetValueKind('Path') -ne [Microsoft.Win32.RegistryValueKind]::ExpandString) {
    throw 'Installer changed an unrelated raw PATH variable or registry value kind.'
  }
}

function Restore-CliPathSentinel {
  param($Key, $State)
  if ($State.Exists) { $Key.SetValue('Path', $State.Value, $State.Kind) }
  else { $Key.DeleteValue('Path', $false) }
}

function Invoke-InstalledCliQuery {
  param([string]$Launcher, [string[]]$Arguments, [string]$ConfigDirectory, [switch]$DiscoverFromPath)
  $quote = { param($value) "'" + $value.Replace("'", "''") + "'" }
  $launcherLiteral = & $quote $Launcher
  $configLiteral = & $quote $ConfigDirectory
  $argumentsLiteral = (@($Arguments | ForEach-Object { & $quote $_ }) -join ',')
  $code = "`$ErrorActionPreference='Stop';`$ProgressPreference='SilentlyContinue';[Console]::OutputEncoding=[Text.UTF8Encoding]::new(`$false);`$OutputEncoding=[Console]::OutputEncoding;`$env:CLAUDE_CONFIG_DIR=$configLiteral;"
  if ($DiscoverFromPath) {
    $code += "`$env:PATH=[Environment]::GetEnvironmentVariable('Path','Machine')+';'+[Environment]::GetEnvironmentVariable('Path','User');"
    $code += "`$resolved=(Get-Command cc-haha -CommandType Application -ErrorAction Stop).Source;if([IO.Path]::GetFullPath(`$resolved) -ne [IO.Path]::GetFullPath($launcherLiteral)){throw 'CLI discovery resolved another installation'};"
  }
  $code += "& $launcherLiteral @($argumentsLiteral);exit `$LASTEXITCODE"
  $start = [Diagnostics.ProcessStartInfo]::new()
  $start.FileName = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
  $start.Arguments = '-NoLogo -NoProfile -NonInteractive -EncodedCommand ' + [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($code))
  $start.UseShellExecute = $false
  $start.CreateNoWindow = $true
  $start.RedirectStandardOutput = $true
  $start.RedirectStandardError = $true
  $start.StandardOutputEncoding = [Text.UTF8Encoding]::new($false)
  $child = [Diagnostics.Process]::Start($start)
  try {
    $output = $child.StandardOutput.ReadToEndAsync()
    $errorOutput = $child.StandardError.ReadToEndAsync()
    if (-not $child.WaitForExit(30000)) { $child.Kill(); throw 'Installed CLI query timed out.' }
    $text = $output.GetAwaiter().GetResult()
    [void]$errorOutput.GetAwaiter().GetResult()
    if ($child.ExitCode -ne 0) { throw 'Installed CLI offline query failed.' }
    return $text
  } finally { $child.Dispose() }
}

function Assert-InstalledCli {
  param([string]$InstallDirectory, [string]$ConfigDirectory, [switch]$DiscoverFromPath)
  $bin = Join-Path $InstallDirectory 'bin'
  foreach ($name in @('cc-haha.cmd', 'HELP.md', 'README.md', 'capabilities.json', 'cli-manifest.json')) {
    if (-not (Test-Path -LiteralPath (Join-Path $bin $name) -PathType Leaf)) { throw "Installed CLI resource missing: $name" }
  }
  $manifest = Get-Content -LiteralPath (Join-Path $bin 'cli-manifest.json') -Raw -Encoding UTF8 | ConvertFrom-Json
  $sidecar = [IO.Path]::GetFullPath((Join-Path $bin $manifest.sidecar_relative_path))
  $expected = Join-Path $InstallDirectory 'resources\app.asar.unpacked\src-tauri\binaries\claude-sidecar-x86_64-pc-windows-msvc.exe'
  if ($manifest.owner -ne 'com.claude-code-haha.desktop' -or $manifest.mode -ne 'headless' -or $sidecar -ne $expected -or -not (Test-Path -LiteralPath $sidecar -PathType Leaf)) {
    throw 'Installed CLI manifest does not target the installed sidecar.'
  }
  $launcher = Join-Path $bin 'cc-haha.cmd'
  $caps = Invoke-InstalledCliQuery -Launcher $launcher -Arguments @('capabilities', '--json') -ConfigDirectory $ConfigDirectory -DiscoverFromPath:$DiscoverFromPath | ConvertFrom-Json
  if ($caps.program -ne 'cc-haha' -or $caps.schema_version -lt 2 -or -not $caps.manual.bundled) { throw 'Installed CLI capabilities contract is invalid.' }
  $bundled = Get-Content -LiteralPath (Join-Path $bin 'capabilities.json') -Raw -Encoding UTF8 | ConvertFrom-Json
  if (($bundled | ConvertTo-Json -Depth 100 -Compress) -cne ($caps | ConvertTo-Json -Depth 100 -Compress)) { throw 'Installed CLI documentation is stale.' }
  $manual = Invoke-InstalledCliQuery -Launcher $launcher -Arguments @('help', '--manual') -ConfigDirectory $ConfigDirectory
  if ($manual -notmatch 'cc-haha') { throw 'Installed CLI offline manual is missing.' }
  $bundledManual = Get-Content -LiteralPath (Join-Path $bin 'HELP.md') -Raw -Encoding UTF8
  if ($bundledManual.Replace("`r`n", "`n").TrimEnd() -cne $manual.Replace("`r`n", "`n").TrimEnd()) { throw 'Installed CLI manual differs from its runtime.' }
  foreach ($command in @('models', 'pricing', 'usage')) {
    $query = Invoke-InstalledCliQuery -Launcher $launcher -Arguments @($command, '--all', '--no-network', '--json') -ConfigDirectory $ConfigDirectory | ConvertFrom-Json
    if ($query.schema_version -ne $caps.schema_version) { throw 'Installed CLI query schema differs from capabilities.' }
  }
  $providers = Invoke-InstalledCliQuery -Launcher $launcher -Arguments @('providers', '--json') -ConfigDirectory $ConfigDirectory | ConvertFrom-Json
  if (@($providers.providers).Count -ne 0) { throw 'Installed CLI did not honor the empty isolated config directory.' }
  [Console]::Out.WriteLine('Installed CLI discovery, manual and offline metadata passed.')
}

function Assert-CliPathRemoved {
  param([string]$BinDirectory)
  foreach ($scope in @('User', 'Machine')) {
    $entries = [Environment]::GetEnvironmentVariable('Path', $scope) -split ';'
    if (@($entries | Where-Object { $_.TrimEnd('\') -eq $BinDirectory.TrimEnd('\') }).Count -ne 0) {
      throw 'Uninstall left the managed CLI PATH entry behind.'
    }
  }
}
