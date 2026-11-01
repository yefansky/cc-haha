import { describe, expect, it } from 'vitest'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
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
})
