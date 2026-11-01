import { describe, expect, it } from 'vitest'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

describe.skipIf(process.platform !== 'win32')('installed CLI ownership and PATH transitions', () => {
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
