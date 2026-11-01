import { describe, expect, it } from 'vitest'
import { mkdtemp, mkdir, copyFile, readFile, rm, writeFile } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
import os from 'node:os'
import path from 'node:path'
import { prepareHeadlessCli } from './prepare-headless-cli'
import { getHeadlessCapabilities, renderHeadlessHelp } from '../../src/entrypoints/headlessCommandCatalog'

describe('packaged headless CLI payload', () => {
  it('ships executable wrapper plus instructions from the actual command catalog', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'cli-payload-'))
    try {
      await prepareHeadlessCli(dir, 'x86_64-pc-windows-msvc')
      expect(await readFile(path.join(dir, 'HELP.md'), 'utf8')).toBe(renderHeadlessHelp(undefined, true))
      expect(JSON.parse(await readFile(path.join(dir, 'capabilities.json'), 'utf8'))).toEqual(getHeadlessCapabilities())
      const wrapper = await readFile(path.join(dir, 'cc-haha.cmd'), 'utf8')
      expect(wrapper).toContain('headless --app-root "%APP_ROOT%." --desktop-config %*')
      expect(wrapper).toContain('..\\app.asar.unpacked\\src-tauri\\binaries\\claude-sidecar-x86_64-pc-windows-msvc.exe')
      expect(wrapper).not.toContain('set "CLAUDE_CONFIG_DIR=')
      const manifest = JSON.parse(await readFile(path.join(dir, 'cli-manifest.json'), 'utf8'))
      expect(manifest.mode).toBe('headless')
      expect(path.resolve(dir, manifest.sidecar_relative_path)).toContain('resources')
    } finally { await rm(dir, { recursive: true, force: true }) }
  })
  it.skipIf(process.platform !== 'win32')('runs both installed and fallback wrappers with UTF8, special paths, and the original exit status', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), '中文 !&%=cli-'))
    try {
      const payload = path.join(root, 'resources/cli')
      const bin = path.join(root, 'bin')
      const binaries = path.join(root, 'resources/app.asar.unpacked/src-tauri/binaries')
      await Promise.all([mkdir(bin, { recursive: true }), mkdir(binaries, { recursive: true })])
      await prepareHeadlessCli(payload, 'x86_64-pc-windows-msvc')
      await copyFile(path.join(payload, 'cc-haha.cmd'), path.join(bin, 'cc-haha.cmd'))
      const source = path.join(root, 'fixture.ts')
      await writeFile(source, 'console.log(JSON.stringify({text:"中文输出",args:process.argv.slice(2)}));process.exit(process.argv.includes("--exit-test")?7:0)')
      const bunPath = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', "bun -e 'console.log(process.execPath)'"], { encoding: 'utf8', windowsHide: true, timeout: 15_000 }).stdout.trim()
      const compile = spawnSync(bunPath, ['build', '--compile', source, '--outfile', path.join(binaries, 'claude-sidecar-x86_64-pc-windows-msvc.exe')], { encoding: 'utf8', windowsHide: true, timeout: 30_000 })
      expect(compile.status).toBe(0)
      for (const directory of [bin, payload]) {
        const run = spawnSync('cmd.exe', ['/d', '/s', '/c', `""${path.join(directory, 'cc-haha.cmd')}" --exit-test"`], { encoding: 'utf8', windowsVerbatimArguments: true, windowsHide: true, timeout: 15_000 })
        expect(run.stderr).toBe('')
        expect(run.status).toBe(7)
        const result = JSON.parse(run.stdout.trim())
        expect(result.text).toBe('中文输出')
        expect(result.args[0]).toBe('headless')
        expect(result.args.slice(-2)).toEqual(['--desktop-config', '--exit-test'])
        const psCode = `& '${path.join(directory, 'cc-haha.cmd').replaceAll("'", "''")}' --exit-test; exit $LASTEXITCODE`
        const ps = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(psCode, 'utf16le').toString('base64')], { encoding: 'utf8', windowsHide: true, timeout: 15_000 })
        expect(ps.status).toBe(7)
        expect(JSON.parse(ps.stdout.trim()).text).toBe('中文输出')
      }
    } finally { await rm(root, { recursive: true, force: true }) }
  }, 60_000)
})
