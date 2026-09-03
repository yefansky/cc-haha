import { afterEach, describe, expect, it } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'

const desktopRoot = path.resolve(import.meta.dirname, '..')
const repoRoot = path.resolve(desktopRoot, '..')
const scriptPath = path.join(import.meta.dirname, 'source-desktop-shortcut.ps1')
const temporaryDirectories: string[] = []
const itWindows = process.platform === 'win32' ? it : it.skip

function quotePowerShellLiteral(value: string) {
  return `'${value.replaceAll("'", "''")}'`
}

function runShortcutScript(args: string[]) {
  return spawnSync('powershell.exe', [
    '-NoLogo',
    '-NoProfile',
    '-NonInteractive',
    '-ExecutionPolicy',
    'Bypass',
    '-File',
    scriptPath,
    ...args,
  ], {
    cwd: desktopRoot,
    encoding: 'utf8',
  })
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

describe('Windows desktop shortcuts', () => {
  it('requires the installer to recreate its shortcut after upgrades', () => {
    const packageJson = JSON.parse(readFileSync(path.join(desktopRoot, 'package.json'), 'utf8')) as {
      build?: {
        nsis?: {
          createDesktopShortcut?: boolean | 'always'
          createStartMenuShortcut?: boolean
          shortcutName?: string
        }
      }
    }

    expect(packageJson.build?.nsis).toMatchObject({
      createDesktopShortcut: 'always',
      createStartMenuShortcut: true,
      shortcutName: 'Claude Code Haha',
    })
  })

  itWindows('creates, updates, and removes an isolated source shortcut', () => {
    const temporaryDesktop = mkdtempSync(path.join(tmpdir(), 'cc-haha-source-shortcut-'))
    temporaryDirectories.push(temporaryDesktop)
    const shortcutPath = path.join(temporaryDesktop, 'Claude Code Haha (Source).lnk')
    const legacyShortcutPath = path.join(temporaryDesktop, 'cc-haha.bat.lnk')
    const installArgs = ['-DesktopDirectory', temporaryDesktop]

    const createLegacyCommand = [
      '$shell = New-Object -ComObject WScript.Shell',
      `$shortcut = $shell.CreateShortcut(${quotePowerShellLiteral(legacyShortcutPath)})`,
      `$shortcut.TargetPath = ${quotePowerShellLiteral(path.join(repoRoot, 'startup.bat'))}`,
      `$shortcut.WorkingDirectory = ${quotePowerShellLiteral(repoRoot)}`,
      '$shortcut.Save()',
    ].join('\n')
    const createLegacy = spawnSync('powershell.exe', [
      '-NoLogo',
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      createLegacyCommand,
    ], { encoding: 'utf8' })
    expect(createLegacy.status, createLegacy.stderr || createLegacy.stdout).toBe(0)
    expect(existsSync(legacyShortcutPath)).toBe(true)

    const firstInstall = runShortcutScript(installArgs)
    expect(firstInstall.status, firstInstall.stderr || firstInstall.stdout).toBe(0)
    expect(existsSync(shortcutPath)).toBe(true)
    expect(existsSync(legacyShortcutPath)).toBe(false)

    const inspectCommand = [
      '$shell = New-Object -ComObject WScript.Shell',
      `$shortcut = $shell.CreateShortcut(${quotePowerShellLiteral(shortcutPath)})`,
      '[pscustomobject]@{',
      'TargetPath = $shortcut.TargetPath',
      'Arguments = $shortcut.Arguments',
      'WorkingDirectory = $shortcut.WorkingDirectory',
      'IconLocation = $shortcut.IconLocation',
      'Description = $shortcut.Description',
      '} | ConvertTo-Json -Compress',
    ].join('\n')
    const inspected = spawnSync('powershell.exe', [
      '-NoLogo',
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      inspectCommand,
    ], { encoding: 'utf8' })
    expect(inspected.status, inspected.stderr || inspected.stdout).toBe(0)
    const shortcut = JSON.parse(inspected.stdout.trim()) as Record<string, string>
    expect(path.resolve(shortcut.TargetPath)).toBe(path.join(repoRoot, 'startup.bat'))
    expect(shortcut.Arguments ?? '').toBe('')
    expect(path.resolve(shortcut.WorkingDirectory)).toBe(repoRoot)
    expect(shortcut.IconLocation).toContain(path.join(desktopRoot, 'src-tauri', 'icons', 'icon.ico'))
    expect(shortcut.Description).toContain('source checkout')

    const secondInstall = runShortcutScript(installArgs)
    expect(secondInstall.status, secondInstall.stderr || secondInstall.stdout).toBe(0)
    expect(existsSync(shortcutPath)).toBe(true)

    const remove = runShortcutScript(['-DesktopDirectory', temporaryDesktop, '-Remove'])
    expect(remove.status, remove.stderr || remove.stdout).toBe(0)
    expect(existsSync(shortcutPath)).toBe(false)

    const repeatedRemove = runShortcutScript(['-DesktopDirectory', temporaryDesktop, '-Remove'])
    expect(repeatedRemove.status, repeatedRemove.stderr || repeatedRemove.stdout).toBe(0)
  })
})
