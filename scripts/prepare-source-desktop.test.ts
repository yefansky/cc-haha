import { describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'

const helper = path.join(import.meta.dir, 'prepare-source-desktop.ps1')
const nodeExe = Bun.which('node')!
const fixtureParent = path.resolve(import.meta.dir, '..', '.runtime', 'source-desktop-tests')

type Call = { stage: string, cwd: string, args: string[], env?: Record<string, string> }

function fixture(run: (root: string) => void) {
  mkdirSync(fixtureParent, { recursive: true })
  const root = mkdtempSync(path.join(fixtureParent, '源码 启动 '))
  mkdirSync(path.join(root, 'desktop'), { recursive: true })
  for (const directory of [root, path.join(root, 'desktop')]) {
    writeFileSync(path.join(directory, 'package.json'), '{}')
    writeFileSync(path.join(directory, 'bun.lock'), 'fixture lock remains unchanged\n')
  }
  writeFileSync(path.join(root, 'fake-bun.cmd'), `@echo off\r\n"${nodeExe}" "%~dp0fixture-install.cjs" %*\r\nexit /b %errorlevel%\r\n`)
  writeFileSync(path.join(root, 'fixture-install.cjs'), `
const fs = require('node:fs')
const path = require('node:path')
const root = __dirname
const desktop = path.join(root, 'desktop')
const stage = process.cwd() === desktop ? 'desktop' : 'root'
const keys = ['TEMP', 'TMP', 'BUN_INSTALL_CACHE_DIR', 'electron_config_cache', 'npm_config_cache', 'npm_config_devdir']
fs.appendFileSync(path.join(root, 'calls.jsonl'), JSON.stringify({ stage, cwd: process.cwd(), args: process.argv.slice(2), env: Object.fromEntries(keys.map(key => [key, process.env[key]])) }) + '\\n')
if (process.env.FIXTURE_FAIL_STAGE === stage) process.exit(17)
fs.mkdirSync(path.join(process.cwd(), 'node_modules'), { recursive: true })
if (stage === 'desktop') {
  const electron = path.join(desktop, 'node_modules', 'electron')
  fs.mkdirSync(electron, { recursive: true })
  fs.mkdirSync(path.join(desktop, 'node_modules', 'node-pty', 'prebuilds'), { recursive: true })
  fs.writeFileSync(path.join(electron, 'install.js'), \`const fs = require('node:fs'); const path = require('node:path'); fs.appendFileSync(\${JSON.stringify(path.join(root, 'calls.jsonl'))}, JSON.stringify({ stage: 'electron', cwd: process.cwd(), args: process.argv.slice(2) }) + '\\\\n'); if (process.env.FIXTURE_FAIL_STAGE === 'electron') process.exit(23); fs.mkdirSync(path.join(__dirname, 'dist'), { recursive: true }); fs.writeFileSync(path.join(__dirname, 'dist', 'electron.exe'), 'fixture binary');\`)
}
`)
  try {
    run(root)
  } finally {
    // Only the verified per-test child of the checkout-local fixture directory is removed.
    if (!path.resolve(root).startsWith(path.resolve(fixtureParent) + path.sep)) throw new Error('Unsafe fixture cleanup path')
    rmSync(root, { recursive: true, force: true })
  }
}

function prepare(root: string, failStage = '') {
  const result = Bun.spawnSync(['powershell.exe', '-NoLogo', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', helper,
    '-RepoRoot', root, '-BunExe', path.join(root, 'fake-bun.cmd'), '-NodeExe', nodeExe], {
    cwd: root,
    env: { ...process.env, FIXTURE_FAIL_STAGE: failStage },
    stdout: 'pipe',
    stderr: 'pipe',
  })
  return { code: result.exitCode, output: new TextDecoder().decode(result.stdout) + new TextDecoder().decode(result.stderr) }
}

function calls(root: string): Call[] {
  return readFileSync(path.join(root, 'calls.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line))
}

describe.skipIf(process.platform !== 'win32')('source desktop dependency preparation', () => {
  test('restores empty dependencies, repeats safely, and repairs partially removed runtime files', () => fixture(root => {
    const first = prepare(root)
    expect(first.output).not.toContain('ParserError')
    expect(first.code).toBe(0)
    const executable = path.join(root, 'desktop', 'node_modules', 'electron', 'dist', 'electron.exe')
    const prebuilds = path.join(root, 'desktop', 'node_modules', 'node-pty', 'prebuilds')
    expect(existsSync(executable)).toBe(true)
    expect(existsSync(prebuilds)).toBe(true)
    expect(prepare(root).code).toBe(0)
    rmSync(executable)
    rmSync(prebuilds, { recursive: true })
    expect(prepare(root).code).toBe(0)
    expect(existsSync(executable)).toBe(true)
    expect(existsSync(prebuilds)).toBe(true)
    expect(calls(root).map(call => call.stage)).toEqual(['root', 'desktop', 'electron', 'root', 'desktop', 'electron', 'root', 'desktop', 'electron'])
    for (const call of calls(root).filter(call => call.stage !== 'electron')) {
      expect(call.args).toEqual(['install', '--frozen-lockfile'])
      expect(path.resolve(call.cwd)).toBe(path.resolve(call.stage === 'root' ? root : path.join(root, 'desktop')))
      for (const value of Object.values(call.env!)) {
        expect(path.resolve(value).startsWith(path.resolve(root, '.runtime', 'source-desktop') + path.sep)).toBe(true)
      }
    }
    for (const directory of [root, path.join(root, 'desktop')]) {
      expect(readFileSync(path.join(directory, 'bun.lock'), 'utf8')).toBe('fixture lock remains unchanged\n')
    }
  }), 30_000)

  for (const [stage, expectedCalls] of [
    ['root', ['root']],
    ['desktop', ['root', 'desktop']],
    ['electron', ['root', 'desktop', 'electron']],
  ] as const) {
    test(`stops immediately when ${stage} installation fails`, () => fixture(root => {
      const result = prepare(root, stage)
      expect(result.code).not.toBe(0)
      expect(calls(root).map(call => call.stage)).toEqual([...expectedCalls])
      expect(existsSync(path.join(root, 'desktop', 'node_modules', 'electron', 'dist', 'electron.exe'))).toBe(false)
    }), 15_000)
  }
})
