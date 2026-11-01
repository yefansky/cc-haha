import { describe, expect, it } from 'vitest'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const helper = join(import.meta.dirname, 'windows-installed-cli-smoke.ps1')
const quote = (value: string) => "'" + value.replaceAll("'", "''") + "'"

function run(body: string) {
  const temp = mkdtempSync(join(tmpdir(), 'installed-cli-smoke-'))
  try {
    const code = [
      "$ErrorActionPreference='Stop';$ProgressPreference='SilentlyContinue';Set-StrictMode -Version Latest",
      '. ' + quote(helper), '$root=' + quote(temp),
      "$install=Join-Path $root '中文 安装&目录';$bin=Join-Path $install 'bin';$config=Join-Path $root 'isolated-config'",
      'New-Item -ItemType Directory -Force $bin | Out-Null',
      "$sidecar=Join-Path $install 'resources/app.asar.unpacked/src-tauri/binaries/claude-sidecar-x86_64-pc-windows-msvc.exe'",
      'New-Item -ItemType Directory -Force (Split-Path -Parent $sidecar) | Out-Null',
      "Set-Content -LiteralPath $sidecar 'fixture'",
      "foreach($name in @('HELP.md','README.md')) { Set-Content -LiteralPath (Join-Path $bin $name) 'cc-haha offline manual' -Encoding UTF8 }",
      "Set-Content -LiteralPath (Join-Path $bin 'capabilities.json') '{\"program\":\"cc-haha\",\"schema_version\":2,\"manual\":{\"bundled\":true}}'",
      "Set-Content -LiteralPath (Join-Path $bin 'cli-manifest.json') '{\"owner\":\"com.claude-code-haha.desktop\",\"mode\":\"headless\",\"sidecar_relative_path\":\"../resources/app.asar.unpacked/src-tauri/binaries/claude-sidecar-x86_64-pc-windows-msvc.exe\"}'",
      'function Assert($ok,$message) { if(-not $ok) {throw $message} }',
      body, "Write-Output 'fixture passed'",
    ].join('\n')
    const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(code, 'utf16le').toString('base64')], { encoding: 'utf8', timeout: 60_000 })
    expect(result.stderr).toBe('')
    expect(result.status).toBe(0)
    expect(result.stdout).toContain('fixture passed')
  } finally { rmSync(temp, { recursive: true, force: true }) }
}

describe.skipIf(process.platform !== 'win32')('installed CLI assertions without installation or registry writes', () => {
  it('checks raw PATH after GUI startup before running an updater', () => {
    const script = readFileSync(join(import.meta.dirname, 'windows-installer-smoke.ps1'), 'utf8')
    const guiEnd = script.indexOf('-IsolatedUserProfile $userProfile')
    const reinstall = script.indexOf("-Stage 'Sibling-prefix process reinstall'", guiEnd)
    expect(guiEnd).toBeGreaterThan(0)
    expect(reinstall).toBeGreaterThan(guiEnd)
    expect(script.slice(guiEnd, reinstall)).toContain('Assert-CliPathSentinel -Key $cliPathKey -State $cliPathState')
  })

  it('drives a hidden subprocess through a quoted installed wrapper', () => run([
    "$cmd=@'",
    '@echo off',
    'if "%~1"=="help" (echo cc-haha offline manual&exit /b 0)',
    'if "%~1"=="capabilities" (echo {"program":"cc-haha","schema_version":2,"manual":{"bundled":true}}&exit /b 0)',
    'echo {"schema_version":2,"providers":[]}', 'exit /b 0', "'@",
    "Set-Content -LiteralPath (Join-Path $bin 'cc-haha.cmd') -Value $cmd -Encoding ASCII",
    'Assert-InstalledCli -InstallDirectory $install -ConfigDirectory $config',
    "Assert (-not (Test-Path -LiteralPath $config)) 'query assertion created config'",
  ].join('\n')))

  it('rejects missing resources and stale targets before executing commands', () => run([
    "function Invoke-InstalledCliQuery { throw 'must not execute' }",
    '$failed=$false',
    "try { Assert-InstalledCli -InstallDirectory $install -ConfigDirectory $config } catch { $failed=$_.Exception.Message -like 'Installed CLI resource missing:*' }",
    "Assert $failed 'missing wrapper was accepted'",
    "Set-Content -LiteralPath (Join-Path $bin 'cc-haha.cmd') 'fixture'",
    "Set-Content -LiteralPath (Join-Path $bin 'cli-manifest.json') '{\"owner\":\"com.claude-code-haha.desktop\",\"mode\":\"headless\",\"sidecar_relative_path\":\"../old-version.exe\"}'",
    '$failed=$false',
    "try { Assert-InstalledCli -InstallDirectory $install -ConfigDirectory $config } catch { $failed=$_.Exception.Message -like 'Installed CLI manifest*' }",
    "Assert $failed 'stale target was accepted'",
  ].join('\n')))

  it('rejects stale capabilities and manual even with the same schema version', () => run([
    "Set-Content -LiteralPath (Join-Path $bin 'cc-haha.cmd') 'fixture'",
    'function Invoke-InstalledCliQuery {',
    '  param($Launcher,$Arguments,$ConfigDirectory,[switch]$DiscoverFromPath)',
    "  if($Arguments[0] -eq 'capabilities') { return '{\"program\":\"cc-haha\",\"schema_version\":2,\"manual\":{\"bundled\":true}}' }",
    "  if($Arguments[0] -eq 'help') { return 'cc-haha offline manual' }",
    "  return '{\"schema_version\":2,\"providers\":[]}'",
    '}',
    "Set-Content -LiteralPath (Join-Path $bin 'capabilities.json') '{\"program\":\"cc-haha\",\"schema_version\":2,\"manual\":{\"bundled\":true},\"stale\":true}' -Encoding UTF8",
    '$failed=$false',
    "try { Assert-InstalledCli -InstallDirectory $install -ConfigDirectory $config } catch { $failed=$_.Exception.Message -eq 'Installed CLI documentation is stale.' }",
    "Assert $failed 'same-schema stale capabilities were accepted'",
    "Set-Content -LiteralPath (Join-Path $bin 'capabilities.json') '{\"program\":\"cc-haha\",\"schema_version\":2,\"manual\":{\"bundled\":true}}' -Encoding UTF8",
    "Set-Content -LiteralPath (Join-Path $bin 'HELP.md') 'cc-haha old manual' -Encoding UTF8",
    '$failed=$false',
    "try { Assert-InstalledCli -InstallDirectory $install -ConfigDirectory $config } catch { $failed=$_.Exception.Message -eq 'Installed CLI manual differs from its runtime.' }",
    "Assert $failed 'stale manual was accepted'",
  ].join('\n')))

  it('seeds, detects expansion or kind loss, and restores raw PATH using only an in-memory key', () => run([
    "$key=[pscustomobject]@{Raw='G:\\original;%USERPROFILE%\\tools';Kind=[Microsoft.Win32.RegistryValueKind]::String;Exists=$true}",
    "$key | Add-Member ScriptMethod GetValue { param($name,$fallback,$options) Assert ($options -eq [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames) 'PATH read expanded variables'; if($this.Exists){return $this.Raw};return $null }",
    "$key | Add-Member ScriptMethod GetValueKind { param($name) return $this.Kind }",
    "$key | Add-Member ScriptMethod SetValue { param($name,$value,$kind) $this.Raw=$value;$this.Kind=$kind;$this.Exists=$true }",
    "$key | Add-Member ScriptMethod DeleteValue { param($name,$throw) $this.Exists=$false }",
    "foreach($kind in @([Microsoft.Win32.RegistryValueKind]::String,[Microsoft.Win32.RegistryValueKind]::ExpandString)) {",
    " $key.Kind=$kind;$key.Raw='G:\\original;%USERPROFILE%\\tools';$key.Exists=$true",
    " $state=Set-CliPathSentinel -Key $key -Sentinel '%CC_HAHA_CLI_SMOKE_PATH%\\tools'",
    ' Assert-CliPathSentinel -Key $key -State $state',
    " $key.Raw=$key.Raw.Replace('%CC_HAHA_CLI_SMOKE_PATH%','G:\\expanded');$failed=$false",
    ' try { Assert-CliPathSentinel -Key $key -State $state } catch { $failed=$true }',
    " Assert $failed 'expanded sentinel was accepted'",
    ' Restore-CliPathSentinel -Key $key -State $state',
    " Assert ($key.Raw -eq 'G:\\original;%USERPROFILE%\\tools' -and $key.Kind -eq $kind) 'original raw value or kind not restored'",
    " $state=Set-CliPathSentinel -Key $key -Sentinel '%CC_HAHA_CLI_SMOKE_PATH%\\tools';$key.Kind=[Microsoft.Win32.RegistryValueKind]::String;$failed=$false",
    ' try { Assert-CliPathSentinel -Key $key -State $state } catch { $failed=$true }',
    " Assert $failed 'lost registry kind was accepted'; Restore-CliPathSentinel -Key $key -State $state",
    '}',
    "$key.Exists=$false;$state=Set-CliPathSentinel -Key $key -Sentinel '%CC_HAHA_CLI_SMOKE_PATH%\\tools';Restore-CliPathSentinel -Key $key -State $state",
    "Assert (-not $key.Exists) 'restore created an originally absent PATH value'",
  ].join('\n')))
})
