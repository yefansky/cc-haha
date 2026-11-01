[CmdletBinding()]
param(
  [ValidateSet('Install','Uninstall')][string]$Action = 'Install',
  [string]$BinDirectory,
  [ValidateSet('User','Machine')][string]$Scope = 'User',
  [string]$PayloadDirectory
)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$script:CliOwner = 'com.claude-code-haha.desktop'
$script:CliFiles = @('cc-haha.cmd','README.md','HELP.md','capabilities.json','cli-manifest.json')
function Get-CliFileHash([string]$File) {
  $stream = [IO.File]::OpenRead($File)
  $sha = [Security.Cryptography.SHA256]::Create()
  try { return [BitConverter]::ToString($sha.ComputeHash($stream)).Replace('-','') }
  finally { $sha.Dispose(); $stream.Dispose() }
}

# These small OS seams also let fixture tests exercise the real transition
# without touching the developer's registry or PATH.
function Get-CliEnvironmentKey([string]$Target, [bool]$Writable) {
  $root = if ($Target -eq 'Machine') { [Microsoft.Win32.Registry]::LocalMachine } else { [Microsoft.Win32.Registry]::CurrentUser }
  $subkey = if ($Target -eq 'Machine') { 'SYSTEM\CurrentControlSet\Control\Session Manager\Environment' } else { 'Environment' }
  if ($Writable) { return $root.CreateSubKey($subkey) }
  return $root.OpenSubKey($subkey, $false)
}
function Get-CliScopePath([string]$Target) {
  $key = Get-CliEnvironmentKey $Target $false
  if ($null -eq $key) { return '' }
  try {
    # Environment.GetEnvironmentVariable expands REG_EXPAND_SZ; retain the
    # original %VARIABLE% spelling so an unrelated entry is never rewritten.
    return [string]$key.GetValue('Path', '', [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)
  } finally { $key.Dispose() }
}
function Set-CliScopePath([string]$Target, [string]$Value) {
  $key = Get-CliEnvironmentKey $Target $true
  try {
    $kind = [Microsoft.Win32.RegistryValueKind]::ExpandString
    if ($key.GetValueNames() -contains 'Path') { $kind = $key.GetValueKind('Path') }
    $key.SetValue('Path', $Value, $kind)
  } finally { if ($null -ne $key) { $key.Dispose() } }
}
function Get-CliOwnerKey([string]$Target) {
  $root = if ($Target -eq 'Machine') { 'HKLM:' } else { 'HKCU:' }
  return "$root\Software\Claude Code Haha\HeadlessCli"
}
function Get-CliRegistration([string]$Target) { Get-ItemProperty -LiteralPath (Get-CliOwnerKey $Target) -ErrorAction SilentlyContinue }
function Set-CliRegistration([string]$Target, [string]$Entry, [bool]$Added) {
  $key = Get-CliOwnerKey $Target
  New-Item -Path $key -Force | Out-Null
  New-ItemProperty -LiteralPath $key -Name PathEntry -Value $Entry -PropertyType String -Force | Out-Null
  New-ItemProperty -LiteralPath $key -Name AddedByInstaller -Value ([int]$Added) -PropertyType DWord -Force | Out-Null
}
function Remove-CliRegistration([string]$Target) { Remove-Item -LiteralPath (Get-CliOwnerKey $Target) -Force -ErrorAction SilentlyContinue }
function Get-CliExistingCommand { Get-Command cc-haha -ErrorAction SilentlyContinue | Select-Object -First 1 -ExpandProperty Source }
function Get-CliNormalizedPath([string]$Value) { [Environment]::ExpandEnvironmentVariables($Value.Trim().Trim('"')).TrimEnd('\','/').ToLowerInvariant() }
function Send-CliEnvironmentChanged {
  Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class CcHahaCliEnvironment {
 [DllImport("user32.dll", CharSet=CharSet.Auto)] public static extern IntPtr SendMessageTimeout(IntPtr h, uint m, IntPtr w, string l, uint f, uint t, out IntPtr r);
}
'@ -ErrorAction SilentlyContinue
  $result = [IntPtr]::Zero
  [void][CcHahaCliEnvironment]::SendMessageTimeout([IntPtr]0xffff,0x1a,[IntPtr]::Zero,'Environment',2,5000,[ref]$result)
}

function Invoke-CliRegistration([string]$Operation, [string]$Bin, [string]$Target, [string]$Payload) {
  if (-not [IO.Path]::IsPathRooted($Bin)) { throw 'CLI bin directory must be absolute.' }
  $Bin = [IO.Path]::GetFullPath($Bin).TrimEnd('\')
  $ownerFile = Join-Path $Bin '.cc-haha-cli-owner.json'
  $owner = $null
  if (Test-Path -LiteralPath $ownerFile) {
    try { $owner = Get-Content -LiteralPath $ownerFile -Raw | ConvertFrom-Json } catch { throw 'CLI ownership record is invalid; existing files were preserved.' }
    if ($owner.owner -ne $script:CliOwner) { throw 'CLI directory ownership conflicts; existing files were preserved.' }
  }
  $registration = Get-CliRegistration $Target
  $pathValue = Get-CliScopePath $Target
  $segments = @($pathValue -split ';' | Where-Object { $_ -and $_.Trim() })
  $sameRegistration = $registration -and ((Get-CliNormalizedPath $registration.PathEntry) -eq (Get-CliNormalizedPath $Bin))
  if ($Operation -eq 'Uninstall') {
    if ($sameRegistration -and $registration.AddedByInstaller -eq 1) {
      $next = @($segments | Where-Object { (Get-CliNormalizedPath $_) -ne (Get-CliNormalizedPath $Bin) }) -join ';'
      Set-CliScopePath $Target $next
      Send-CliEnvironmentChanged
    }
    if ($sameRegistration) { Remove-CliRegistration $Target }
    if ($owner) {
      foreach ($file in $script:CliFiles) {
        $targetFile = Join-Path $Bin $file
        if ((Test-Path -LiteralPath $targetFile) -and ((Get-CliFileHash $targetFile) -eq $owner.hashes.$file)) { Remove-Item -LiteralPath $targetFile }
      }
      Remove-Item -LiteralPath $ownerFile
    }
    return 'uninstalled_owned_entries'
  }
  $manifest = Get-Content -LiteralPath (Join-Path $Payload 'cli-manifest.json') -Raw | ConvertFrom-Json
  if ($manifest.owner -ne $script:CliOwner) { throw 'CLI payload ownership is invalid.' }
  foreach ($file in $script:CliFiles) {
    if (-not (Test-Path -LiteralPath (Join-Path $Payload $file) -PathType Leaf)) { throw 'CLI payload is incomplete.' }
    $existing = Join-Path $Bin $file
    if ((Test-Path -LiteralPath $existing) -and (-not $owner -or ((Get-CliFileHash $existing) -ne $owner.hashes.$file))) {
      return 'conflict_files_preserved_use_resources_cli_cc_haha_cmd'
    }
  }
  if (Test-Path -LiteralPath (Join-Path $Bin 'cc-haha.exe')) { return 'conflict_executable_preserved_use_resources_cli_cc_haha_cmd' }
  New-Item -ItemType Directory -Path $Bin -Force | Out-Null
  $hashes = @{}
  foreach ($file in $script:CliFiles) {
    Copy-Item -LiteralPath (Join-Path $Payload $file) -Destination (Join-Path $Bin $file) -Force
    $hashes[$file] = Get-CliFileHash (Join-Path $Bin $file)
  }
  @{owner=$script:CliOwner;hashes=$hashes} | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath $ownerFile -Encoding UTF8
  $alreadyPresent = @($segments | Where-Object { (Get-CliNormalizedPath $_) -eq (Get-CliNormalizedPath $Bin) }).Count -gt 0
  $existingCommand = Get-CliExistingCommand
  if (-not $alreadyPresent -and $existingCommand -and ((Get-CliNormalizedPath $existingCommand) -ne (Get-CliNormalizedPath (Join-Path $Bin 'cc-haha.cmd')))) {
    return 'conflict_command_preserved_use_installed_bin_absolute_path'
  }
  $added = $sameRegistration -and $registration.AddedByInstaller -eq 1
  if (-not $alreadyPresent) {
    Set-CliScopePath $Target (($segments + $Bin) -join ';')
    $added = $true
    Send-CliEnvironmentChanged
  }
  Set-CliRegistration $Target $Bin $added
  return 'installed_new_terminals_use_updated_path'
}

if ($MyInvocation.InvocationName -ne '.') {
  try { Write-Output (Invoke-CliRegistration $Action $BinDirectory $Scope $PayloadDirectory) }
  catch { Write-Error ('cc-haha CLI registration failed: ' + $_.Exception.Message); exit 1 }
}
