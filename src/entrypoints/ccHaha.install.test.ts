import { expect, test } from 'bun:test'
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

test.skipIf(process.platform !== 'win32')('Windows installer preserves unrelated launchers and writes a usable Unicode wrapper without changing user PATH', async () => {
  const sandbox = await mkdtemp(join(tmpdir(), 'cc-haha-install-'))
  const directory = join(sandbox, '中文 目录=安装')
  const launcher = join(directory, 'cc-haha.cmd')
  const userPathBefore = process.env.PATH
  const install = async () => {
    const child = Bun.spawn(['powershell.exe', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', resolve('scripts/install-headless-cli.ps1'), '-Executable', process.execPath, '-InstallDirectory', directory, '-ConfigDirectory', sandbox], { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe', windowsHide: true })
    return { stdout: await new Response(child.stdout).text(), stderr: await new Response(child.stderr).text(), code: await child.exited }
  }
  try {
    await mkdir(directory)
    await writeFile(launcher, 'rem unrelated user file')
    expect((await install()).code).not.toBe(0)
    expect(await readFile(launcher, 'utf8')).toBe('rem unrelated user file')
    await rm(launcher)
    expect((await install()).code).toBe(0)
    const child = Bun.spawn(['cmd.exe', '/d', '/c', launcher, '--version'], { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe', windowsHide: true })
    const text = await new Response(child.stdout).text()
    expect(await child.exited).toBe(0)
    expect(text.trim()).toMatch(/^\d+\.\d+\.\d+/)
    const wrapper = await readFile(launcher, 'utf8')
    expect(wrapper).toContain('if not defined CLAUDE_CONFIG_DIR')
    expect(wrapper).toContain(sandbox)
    expect((await install()).code).toBe(0)
    expect(process.env.PATH).toBe(userPathBefore)
  } finally { await rm(sandbox, { recursive: true, force: true }) }
}, 20000)
