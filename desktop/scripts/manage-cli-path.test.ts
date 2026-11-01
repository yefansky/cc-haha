import { describe, expect, it } from 'vitest'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

describe.skipIf(process.platform !== 'win32')('installed CLI ownership and PATH transitions', () => {
  it('preserves literal environment references and registry value kinds without accessing the real registry', () => {
    const helper = path.join(import.meta.dirname, '../build/manage-cli-path.ps1').replaceAll("'", "''")
    const body = `
$ErrorActionPreference='Stop'
$ProgressPreference='SilentlyContinue'
. '${helper}'
function Assert($condition,$message) { if(-not $condition) { throw $message } }
$script:fake=[pscustomobject]@{Value='%USERPROFILE%\\tools;C:\\keep';Kind=[Microsoft.Win32.RegistryValueKind]::ExpandString;Present=$true;Disposed=0;Reads=0;Writes=0}
$script:fake | Add-Member ScriptMethod GetValue { param($name,$fallback,$options)
  if($options -ne [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames) { throw 'unexpected expansion option' }
  $this.Reads++; return $this.Value
}
$script:fake | Add-Member ScriptMethod GetValueNames { if($this.Present) { return @('pAtH') }; return @() }
$script:fake | Add-Member ScriptMethod GetValueKind { param($name) return $this.Kind }
$script:fake | Add-Member ScriptMethod SetValue { param($name,$value,$kind) $this.Value=$value; $this.Kind=$kind; $this.Present=$true; $this.Writes++ }
$script:fake | Add-Member ScriptMethod Dispose { $this.Disposed++ }
$script:targets=@()
function Get-CliEnvironmentKey($Target,$Writable) { $script:targets+=($Target+':'+$Writable); return $script:fake }
foreach($scope in @('User','Machine')) {
  foreach($kind in @([Microsoft.Win32.RegistryValueKind]::ExpandString,[Microsoft.Win32.RegistryValueKind]::String)) {
    $script:fake.Value='%USERPROFILE%\\tools;C:\\keep'; $script:fake.Kind=$kind; $script:fake.Present=$true
    $original=Get-CliScopePath $scope
    Assert ($original -ceq '%USERPROFILE%\\tools;C:\\keep') 'literal variable must remain unexpanded'
    Set-CliScopePath $scope ($original+';G:\\application\\bin')
    Assert ($script:fake.Kind -eq $kind) 'existing registry kind must survive'
    Assert ($script:fake.Value -ceq '%USERPROFILE%\\tools;C:\\keep;G:\\application\\bin') 'only requested entry may change'
  }
}
$script:fake.Present=$false
Set-CliScopePath User '%USERPROFILE%\\tools'
Assert ($script:fake.Kind -eq [Microsoft.Win32.RegistryValueKind]::ExpandString) 'new PATH defaults to ExpandString'
Assert ($script:fake.Disposed -eq 9) 'all opened keys disposed'
Assert ($script:targets -contains 'User:False') 'user read seam'
Assert ($script:targets -contains 'Machine:True') 'machine write seam'
function Get-CliEnvironmentKey($Target,$Writable) { return $null }
Assert ((Get-CliScopePath User) -eq '') 'missing read-only key returns empty PATH'
Write-Output 'raw registry transitions passed'
`
    const result = spawnSync('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(body, 'utf16le').toString('base64')], { encoding: 'utf8', windowsHide: true, timeout: 30_000 })
    expect(result.stderr).toBe('')
    expect(result.status).toBe(0)
    expect(result.stdout).toContain('raw registry transitions passed')
  })
  it('updates twice and only removes owned additions; preserves modified/unowned files and existing commands', () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'cli-owner-'))
    const quote = (s: string) => `'${s.replaceAll("'", "''")}'`
    const body = `
$ErrorActionPreference='Stop'
$ProgressPreference='SilentlyContinue'
. ${quote(path.join(import.meta.dirname, '../build/manage-cli-path.ps1'))}
$root=${quote(root)}
$script:testPath='C:\\keep'
$script:registration=$null
function Get-CliScopePath($Target) { $script:testPath }
function Set-CliScopePath($Target,$Value) { $script:testPath=$Value }
function Get-CliRegistration($Target) { $script:registration }
function Set-CliRegistration($Target,$Entry,$Added) { $script:registration=[pscustomobject]@{PathEntry=$Entry;AddedByInstaller=[int]$Added} }
function Remove-CliRegistration($Target) { $script:registration=$null }
function Get-CliExistingCommand { $script:existingCommand }
function Send-CliEnvironmentChanged {}
function Assert($condition,$message) { if(-not $condition) { throw $message } }
$script:existingCommand=$null
$payload=Join-Path $root 'payload'
$bin=Join-Path $root '中文 & bin'
New-Item -ItemType Directory -Path $payload | Out-Null
foreach($f in $script:CliFiles) { Set-Content -LiteralPath (Join-Path $payload $f) -Value 'test' }
@{owner=$script:CliOwner} | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $payload 'cli-manifest.json')
Assert ((Invoke-CliRegistration Install $bin User $payload) -like 'installed*') 'fresh install'
Assert ($script:registration.AddedByInstaller -eq 1) 'owns addition'
$oldPath=$script:testPath
Invoke-CliRegistration Install $bin User $payload | Out-Null
Assert ($script:testPath -eq $oldPath) 'idempotent update'
Invoke-CliRegistration Uninstall $bin User '' | Out-Null
Assert ($script:testPath -eq 'C:\\keep') 'owned PATH removed'
Assert (-not (Test-Path -LiteralPath (Join-Path $bin 'cc-haha.cmd'))) 'owned wrapper removed'
Set-Content -LiteralPath (Join-Path $bin 'cc-haha.cmd') -Value 'user code'
Assert ((Invoke-CliRegistration Install $bin User $payload) -like 'conflict_files*') 'unknown command preserved'
Assert ((Get-Content -LiteralPath (Join-Path $bin 'cc-haha.cmd') -Raw).Trim() -eq 'user code') 'unknown content intact'
Remove-Item -LiteralPath (Join-Path $bin 'cc-haha.cmd')
$script:testPath='C:\\keep;'+$bin
Invoke-CliRegistration Install $bin Machine $payload | Out-Null
Assert ($script:registration.AddedByInstaller -eq 0) 'preexisting path not owned'
Set-Content -LiteralPath (Join-Path $bin 'README.md') -Value 'user changed'
Invoke-CliRegistration Uninstall $bin Machine '' | Out-Null
Assert ($script:testPath.EndsWith($bin)) 'preexisting PATH retained'
Assert (Test-Path -LiteralPath (Join-Path $bin 'README.md')) 'modified file retained'
Remove-Item -LiteralPath (Join-Path $bin 'README.md')
$script:testPath='C:\\keep'
$script:existingCommand='C:\\other\\cc-haha.cmd'
Assert ((Invoke-CliRegistration Install $bin User $payload) -like 'conflict_command*') 'existing command wins'
Assert ($script:testPath -eq 'C:\\keep') 'command conflict does not register'
Write-Output 'all transitions passed'
`
    try {
      const result = spawnSync('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(body, 'utf16le').toString('base64')], { encoding: 'utf8', windowsHide: true, timeout: 30_000 })
      expect(result.stderr).toBe('')
      expect(result.status).toBe(0)
      expect(result.stdout).toContain('all transitions passed')
    } finally { rmSync(root, { recursive: true, force: true }) }
  })
})
