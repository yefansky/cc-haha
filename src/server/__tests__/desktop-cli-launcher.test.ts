import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test'
import { chmod, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { spawnSync } from 'node:child_process'
import * as execution from '../../utils/execFileNoThrow.js'
import { resolveClaudeCliLauncher } from '../../utils/desktopBundledCli.js'

import {
  buildWindowsLauncherWrapper,
  buildWindowsUserPathRegistrationScript,
  ensureDesktopCliLauncherInstalled,
  getDesktopCliCommandName,
} from '../services/desktopCliLauncherService.js'

const isWindows = process.platform === 'win32'
const unixOnly = isWindows ? it.skip : it
const windowsOnly = isWindows ? it : it.skip

const ORIGINAL_HOME = process.env.HOME
const ORIGINAL_USERPROFILE = process.env.USERPROFILE
const ORIGINAL_SHELL = process.env.SHELL
const ORIGINAL_PATH = process.env.PATH
const ORIGINAL_CLAUDE_CLI_PATH = process.env.CLAUDE_CLI_PATH
const ORIGINAL_CLAUDE_CONFIG_DIR = process.env.CLAUDE_CONFIG_DIR

describe('Windows desktop CLI PATH registry semantics', () => {
  windowsOnly('preserves raw PATH and its type while making the new command directory usable', () => {
    const production = buildWindowsUserPathRegistrationScript()
    const open = "$key = [Microsoft.Win32.Registry]::CurrentUser.CreateSubKey('Environment')"
    const notify = "  [void][NativeMethods]::SendMessageTimeout($HWND_BROADCAST, $WM_SETTINGCHANGE, [IntPtr]::Zero, 'Environment', $SMTO_ABORTIFHUNG, 5000, [ref]$result)"
    expect(production.split(open)).toHaveLength(2)
    expect(production.split(notify)).toHaveLength(2)
    // Replace only the registry-open and OS notification boundaries. Execute
    // the real script, including normalization, type choice, and second run.
    const fixture = production.replace(open, '$key = $script:fake').replace(notify, '  $script:notified++')
    const body = `
$ErrorActionPreference='Stop'
$ProgressPreference='SilentlyContinue'
$env:USERPROFILE='G:\\fake current user'
$env:CC_HAHA_TEST_SENTINEL='G:\\expanded sentinel'
function Assert($condition,$message) { if(-not $condition) { throw $message } }
foreach($kind in @([Microsoft.Win32.RegistryValueKind]::ExpandString,[Microsoft.Win32.RegistryValueKind]::String)) {
  $original='  %CC_HAHA_TEST_SENTINEL%\\tools;;C:\\keep; '
  $script:fake=[pscustomobject]@{Value=$original;Kind=$kind;Present=$true;Writes=0;Disposed=0}
  $script:notified=0
  $script:fake | Add-Member ScriptMethod GetValue { param($name,$fallback,$options)
    if($options -ne [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames) { throw 'raw read required' }; return $this.Value
  }
  $script:fake | Add-Member ScriptMethod GetValueNames { if($this.Present) { return @('pAtH') }; return @() }
  $script:fake | Add-Member ScriptMethod GetValueKind { param($name) return $this.Kind }
  $script:fake | Add-Member ScriptMethod SetValue { param($name,$value,$newKind) $this.Value=$value; $this.Kind=$newKind; $this.Present=$true; $this.Writes++ }
  $script:fake | Add-Member ScriptMethod Dispose { $this.Disposed++ }
  $run=[scriptblock]::Create([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${Buffer.from(fixture, 'utf8').toString('base64')}')))
  & $run
  $entry=if($kind -eq [Microsoft.Win32.RegistryValueKind]::String) { 'G:\\fake current user\\.local\\bin' } else { '%USERPROFILE%\\.local\\bin' }
  Assert ($script:fake.Value -ceq ($entry+';'+$original)) 'unrelated raw PATH entries must be byte-identical'
  Assert ($script:fake.Kind -eq $kind) 'existing registry type preserved'
  $effectiveEntry=if($kind -eq [Microsoft.Win32.RegistryValueKind]::ExpandString) { [Environment]::ExpandEnvironmentVariables($entry) } else { $entry }
  Assert ($effectiveEntry -ceq 'G:\\fake current user\\.local\\bin') 'new directory must work for both value kinds'
  & $run
  Assert ($script:fake.Writes -eq 1) 'second registration is a no-op'
  Assert ($script:notified -eq 1) 'only actual writes broadcast'
  Assert ($script:fake.Disposed -eq 2) 'keys disposed on write and no-op'
  $script:fake.Present=$false; $script:fake.Value=''; $script:fake.Writes=0
  & $run
  Assert ($script:fake.Kind -eq [Microsoft.Win32.RegistryValueKind]::ExpandString) 'missing PATH defaults to ExpandString'
}
Write-Output 'desktop raw PATH transitions passed'
`
    const result = spawnSync(join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'), ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(body, 'utf16le').toString('base64')], { encoding: 'utf8', windowsHide: true, timeout: 30_000 })
    expect(result.stderr).toBe('')
    expect(result.status).toBe(0)
    expect(result.stdout).toContain('desktop raw PATH transitions passed')
  })
})

describe('ensureDesktopCliLauncherInstalled', () => {
  let tempHome = ''
  let tempSourceDir = ''

  beforeEach(async () => {
    tempHome = await mkdtemp(join(tmpdir(), 'desktop-cli-home-'))
    tempSourceDir = await mkdtemp(join(tmpdir(), 'desktop-cli-source-'))
    process.env.HOME = tempHome
    process.env.USERPROFILE = tempHome
    process.env.SHELL = '/bin/zsh'
    process.env.PATH = ''
    delete process.env.CLAUDE_CONFIG_DIR
  })

  afterEach(async () => {
    if (ORIGINAL_HOME === undefined) {
      delete process.env.HOME
    } else {
      process.env.HOME = ORIGINAL_HOME
    }

    if (ORIGINAL_USERPROFILE === undefined) {
      delete process.env.USERPROFILE
    } else {
      process.env.USERPROFILE = ORIGINAL_USERPROFILE
    }

    if (ORIGINAL_SHELL === undefined) {
      delete process.env.SHELL
    } else {
      process.env.SHELL = ORIGINAL_SHELL
    }

    if (ORIGINAL_PATH === undefined) {
      delete process.env.PATH
    } else {
      process.env.PATH = ORIGINAL_PATH
    }

    if (ORIGINAL_CLAUDE_CLI_PATH === undefined) {
      delete process.env.CLAUDE_CLI_PATH
    } else {
      process.env.CLAUDE_CLI_PATH = ORIGINAL_CLAUDE_CLI_PATH
    }

    if (ORIGINAL_CLAUDE_CONFIG_DIR === undefined) {
      delete process.env.CLAUDE_CONFIG_DIR
    } else {
      process.env.CLAUDE_CONFIG_DIR = ORIGINAL_CLAUDE_CONFIG_DIR
    }

    await rm(tempHome, { recursive: true, force: true })
    await rm(tempSourceDir, { recursive: true, force: true })
  })

  unixOnly('installs a launcher wrapper in the user bin dir and configures PATH', async () => {
    const sourcePath = join(tempSourceDir, 'claude-sidecar')
    await writeFile(sourcePath, '#!/bin/sh\necho desktop-sidecar\n', 'utf8')
    await chmod(sourcePath, 0o755)
    process.env.CLAUDE_CLI_PATH = sourcePath

    const status = await ensureDesktopCliLauncherInstalled()
    const launcherPath = join(tempHome, '.local', 'bin', 'claude-haha')
    const shellConfigPath = join(tempHome, '.zshrc')

    expect(status.supported).toBe(true)
    expect(status.installed).toBe(true)
    expect(status.command).toBe('claude-haha')
    expect(status.launcherPath).toBe(launcherPath)
    expect(status.availableInNewTerminals).toBe(true)
    expect(status.needsTerminalRestart).toBe(true)
    expect(status.configTarget).toBe(shellConfigPath)

    const launcher = await readFile(launcherPath, 'utf8')
    expect(launcher).toContain(`SIDECAR='${sourcePath}'`)
    expect(launcher).toContain('cli --app-root "$APP_ROOT" "$@"')
    expect(launcher).toContain('/usr/bin/script -q /dev/null')
    expect(await readFile(shellConfigPath, 'utf8')).toContain(
      'export PATH="$HOME/.local/bin:$PATH"',
    )
  })

  unixOnly('pins portable config dir in the installed launcher wrapper', async () => {
    const sourcePath = join(tempSourceDir, 'claude-sidecar')
    const portableDir = join(tempHome, 'portable-config')
    await writeFile(sourcePath, '#!/bin/sh\necho desktop-sidecar\n', 'utf8')
    await chmod(sourcePath, 0o755)
    process.env.CLAUDE_CLI_PATH = sourcePath
    process.env.CLAUDE_CONFIG_DIR = portableDir

    await ensureDesktopCliLauncherInstalled()

    const launcher = await readFile(join(tempHome, '.local', 'bin', 'claude-haha'), 'utf8')
    expect(launcher).toContain(`export CLAUDE_CONFIG_DIR='${portableDir}'`)
  })

  it('uses a Windows cmd launcher so portable env can be injected', () => {
    expect(getDesktopCliCommandName('win32')).toBe('claude-haha.cmd')

    process.env.CLAUDE_CONFIG_DIR = 'C:\\Portable\\ClaudeConfig'
    const wrapper = buildWindowsLauncherWrapper('C:\\Apps\\cc-haha\\claude-sidecar.exe')

    expect(wrapper).toContain('set "CLAUDE_CONFIG_DIR=C:\\Portable\\ClaudeConfig"')
    expect(wrapper).toContain(
      '"%SIDECAR%" cli --app-root "%APP_ROOT%" %*',
    )
  })

  it('reports unsupported status when the current launcher is not a bundled sidecar', async () => {
    const sourcePath = join(tempSourceDir, 'claude')
    await writeFile(sourcePath, '#!/bin/sh\necho plain-cli\n', 'utf8')
    process.env.CLAUDE_CLI_PATH = sourcePath

    const status = await ensureDesktopCliLauncherInstalled()

    expect(status.supported).toBe(false)
    expect(status.installed).toBe(false)
    expect(status.command).toBe('claude-haha')
  })

  it('returns before launcher installation or OS execution for a script-kind override', async () => {
    const sourcePath = join(import.meta.dir, 'fixtures', 'mock-sdk-cli.ts')
    process.env.CLAUDE_CLI_PATH = sourcePath
    expect(resolveClaudeCliLauncher({ cliPath: sourcePath, execPath: process.execPath })?.kind).toBe('script')
    const exec = spyOn(execution, 'execFileNoThrow').mockImplementation(() => {
      throw new Error('script-kind must not execute PATH or registry commands')
    })
    try {
      const status = await ensureDesktopCliLauncherInstalled()
      expect(status.supported).toBe(false)
      expect(status.installed).toBe(false)
      expect(status.pathConfigured).toBe(false)
      expect(status.configTarget).toBeNull()
      expect(status.lastError).toBeNull()
      expect(exec).not.toHaveBeenCalled()
      expect(await readdir(tempHome)).toEqual([])
    } finally { exec.mockRestore() }
  })
})
