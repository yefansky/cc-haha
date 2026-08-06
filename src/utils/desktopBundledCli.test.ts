import { describe, expect, test } from 'bun:test'
import path from 'node:path'
import { buildClaudeCliArgs, type ClaudeCliLauncher } from './desktopBundledCli.js'

const scriptLauncher: ClaudeCliLauncher = {
  command: path.join('fixtures', 'mock-cli.ts'),
  kind: 'script',
  requiresAppRoot: false,
}

describe('buildClaudeCliArgs', () => {
  test('reuses the running Bun executable for script launchers on Windows', () => {
    const bunExe = String.raw`C:\tools\bun.exe`

    expect(buildClaudeCliArgs(scriptLauncher, ['--print'], undefined, bunExe)).toEqual([
      bunExe,
      scriptLauncher.command,
      '--print',
    ])
  })

  test('keeps the PATH fallback when the current executable is not Bun', () => {
    expect(buildClaudeCliArgs(scriptLauncher, ['--print'], undefined, '/app/claude-sidecar')).toEqual([
      'bun',
      scriptLauncher.command,
      '--print',
    ])
  })
})
