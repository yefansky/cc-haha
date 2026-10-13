import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileNoThrowWithCwd } from '../execFileNoThrow.js'
import { backgroundPluginGitOptions, isBackgroundPluginUpdate, PLUGIN_UPDATE_INTERVAL_MS, runBackgroundPluginUpdate } from './backgroundUpdate.js'
import { gitClone } from './marketplaceManager.js'

const directories: string[] = []
async function directory() {
  const result = await mkdtemp(join(tmpdir(), 'plugin-background-'))
  directories.push(result)
  return result
}
afterEach(async () => {
  await Promise.all(directories.splice(0).map(dir => rm(dir, { recursive: true, force: true })))
})

describe('automatic plugin maintenance', () => {
  test('shares cooldown across independent calls and retries after one hour', async () => {
    const dir = await directory()
    let count = 0
    const update = async () => { count++ }
    expect(await runBackgroundPluginUpdate(dir, update, 1000)).toBe('updated')
    expect(await runBackgroundPluginUpdate(dir, update, 1001)).toBe('recent')
    expect(await runBackgroundPluginUpdate(dir, update, 1000 + PLUGIN_UPDATE_INTERVAL_MS)).toBe('updated')
    expect(count).toBe(2)
  })

  test('does not retry a failed remote on the next conversation, releases the lock', async () => {
    const dir = await directory()
    await expect(runBackgroundPluginUpdate(dir, async () => { throw new Error('remote failed') }, 1000)).rejects.toThrow('remote failed')
    expect(await runBackgroundPluginUpdate(dir, async () => { throw new Error('must not run') }, 1001)).toBe('recent')
    expect(await runBackgroundPluginUpdate(dir, async () => {}, 1000 + PLUGIN_UPDATE_INTERVAL_MS)).toBe('updated')
    expect(isBackgroundPluginUpdate()).toBe(false)
  })

  test('only one concurrent conversation owns the cache', async () => {
    const dir = await directory()
    let entered!: () => void
    let finish!: () => void
    const started = new Promise<void>(resolve => { entered = resolve })
    const pending = new Promise<void>(resolve => { finish = resolve })
    const first = runBackgroundPluginUpdate(dir, async () => { entered(); await pending }, 1000)
    await started
    try {
      expect(await runBackgroundPluginUpdate(dir, async () => { throw new Error('duplicate') }, 1001)).toBe('busy')
      expect(isBackgroundPluginUpdate()).toBe(false)
    } finally { finish(); await first }
  })

  test('independent CLI processes share the cache lock and last-attempt time', async () => {
    const dir = await directory()
    const entered = join(dir, 'entered')
    const childFile = join(dir, 'child.ts')
    const modulePath = join(import.meta.dir, 'backgroundUpdate.ts').replaceAll('\\', '/')
    await writeFile(childFile, `import {writeFile} from 'node:fs/promises'; import {runBackgroundPluginUpdate} from ${JSON.stringify(modulePath)}; await runBackgroundPluginUpdate(${JSON.stringify(dir)}, async () => {await writeFile(${JSON.stringify(entered)}, 'yes'); await Bun.sleep(1500)}, 1000)`)
    const child = Bun.spawn([process.execPath, childFile], { stdout: 'pipe', stderr: 'pipe' })
    try {
      for (let i = 0; i < 100 && !(await Bun.file(entered).exists()); i++) await Bun.sleep(20)
      expect(await Bun.file(entered).exists()).toBe(true)
      expect(await runBackgroundPluginUpdate(dir, async () => { throw new Error('second process') }, 1001)).toBe('busy')
      expect(await child.exited).toBe(0)
      expect(await runBackgroundPluginUpdate(dir, async () => { throw new Error('after process exit') }, 1002)).toBe('recent')
    } finally {
      child.kill()
      await child.exited
    }
  })

  test('recovers from invalid state or a clock moved backwards', async () => {
    const dir = await directory()
    await writeFile(join(dir, '.background-update-attempt'), 'invalid')
    expect(await runBackgroundPluginUpdate(dir, async () => {}, 2000)).toBe('updated')
    expect(await runBackgroundPluginUpdate(dir, async () => {}, 1000)).toBe('updated')
  })

  test('scope applies to nested Git fallbacks but leaves concurrent manual operations alone', async () => {
    const dir = await directory()
    const args = ['clone', 'test']
    const env = { GCM_INTERACTIVE: 'always' }
    expect(backgroundPluginGitOptions('git', args, env)).toEqual({ args, env })
    await runBackgroundPluginUpdate(dir, async () => {
      await Promise.resolve()
      const options = backgroundPluginGitOptions('C:\\Program Files\\Git\\cmd\\git.exe', args, env)
      expect(options.args).toEqual(['-c', 'credential.helper=', ...args])
      expect(options.env?.GCM_INTERACTIVE).toBe('never')
      expect(backgroundPluginGitOptions('K:\\tools\\git.bat', args, env).args[0]).toBe('-c')
      expect(backgroundPluginGitOptions('K:\\tools\\git.cmd', args, env).args[0]).toBe('-c')
      expect(backgroundPluginGitOptions('powershell.exe', args, env)).toEqual({ args, env })
    })
    expect(backgroundPluginGitOptions('git', args, env)).toEqual({ args, env })
    expect(env.GCM_INTERACTIVE).toBe('always')
  })

  test('real Git invokes helper manually, never during automatic maintenance', async () => {
    const dir = await directory()
    const marker = join(dir, 'helper-invoked')
    const helper = join(dir, 'helper.js')
    await writeFile(helper, `require('fs').writeFileSync(${JSON.stringify(marker)}, 'called')`)
    const config = join(dir, 'gitconfig')
    const command = `!node '${helper.replaceAll('\\', '/')}'`
    await writeFile(config, `[credential]\n\thelper = ${JSON.stringify(command)}\n`)
    const options = {
      cwd: dir, timeout: 5000, input: 'protocol=https\nhost=example.invalid\n\n',
      env: { GIT_CONFIG_GLOBAL: config, GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never' },
    }
    await execFileNoThrowWithCwd('git', ['credential', 'fill'], options)
    expect(await readFile(marker, 'utf8')).toBe('called')
    await rm(marker)
    await runBackgroundPluginUpdate(dir, async () => {
      const result = await execFileNoThrowWithCwd('git', ['credential', 'fill'], options)
      expect(result.code).not.toBe(0)
    })
    await expect(readFile(marker)).rejects.toThrow()
  })

  test('a 401 during marketplace re-clone cannot escape the background credential policy', async () => {
    const dir = await directory()
    const marker = join(dir, 'clone-helper')
    const helper = join(dir, 'clone-helper.js')
    await writeFile(helper, `require('fs').writeFileSync(${JSON.stringify(marker)}, 'called')`)
    const config = join(dir, 'gitconfig')
    await writeFile(config, `[credential]\n\thelper = ${JSON.stringify(`!node '${helper.replaceAll('\\', '/')}'`)}\n`)
    const originalGlobal = process.env.GIT_CONFIG_GLOBAL
    const originalSystem = process.env.GIT_CONFIG_NOSYSTEM
    process.env.GIT_CONFIG_GLOBAL = config
    process.env.GIT_CONFIG_NOSYSTEM = '1'
    const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response('authentication required', { status: 401, headers: { 'WWW-Authenticate': 'Basic realm="test"' } }) })
    try {
      // This is the pre-fix re-clone behavior: terminal prompts are disabled,
      // but the credential helper still runs after the server challenges Git.
      expect((await gitClone(`${server.url}repo.git`, join(dir, 'before'))).code).not.toBe(0)
      expect(await readFile(marker, 'utf8')).toBe('called')
      await rm(marker)
      await runBackgroundPluginUpdate(dir, async () => {
        expect((await gitClone(`${server.url}repo.git`, join(dir, 'after'))).code).not.toBe(0)
      })
      await expect(readFile(marker)).rejects.toThrow()
    } finally {
      server.stop(true)
      if (originalGlobal === undefined) delete process.env.GIT_CONFIG_GLOBAL
      else process.env.GIT_CONFIG_GLOBAL = originalGlobal
      if (originalSystem === undefined) delete process.env.GIT_CONFIG_NOSYSTEM
      else process.env.GIT_CONFIG_NOSYSTEM = originalSystem
    }
  })

  test('unreachable Git remote fails quietly and emits network evidence plus cooldown', async () => {
    const dir = await directory()
    const diagnostics = join(dir, 'cli-diagnostics.jsonl')
    const originalDiagnostics = process.env.CLAUDE_CODE_DIAGNOSTICS_FILE
    process.env.CLAUDE_CODE_DIAGNOSTICS_FILE = diagnostics
    const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response('unused') })
    const url = `${server.url}repo.git`
    server.stop(true)
    try {
      await runBackgroundPluginUpdate(dir, async () => {
        const result = await execFileNoThrowWithCwd('git', ['clone', url, join(dir, 'clone')], {
          cwd: dir, timeout: 5000,
          env: { GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: join(dir, 'empty-config') },
        })
        expect(result.code).not.toBe(0)
      })
      expect(await runBackgroundPluginUpdate(dir, async () => { throw new Error('must not retry') })).toBe('recent')
      const events = (await readFile(`${diagnostics}.${process.pid}.current.jsonl`, 'utf8')).trim().split('\n').map(line => JSON.parse(line))
      const git = events.find(event => event.event === 'plugin_git_completed')
      expect(git.data.operation).toBe('clone')
      expect(git.data.errorCategory).toBe('network')
      expect(git.data.interactive).toBe(false)
      expect(events.find(event => event.event === 'plugin_background_skipped').data.reason).toBe('recent')
      expect(JSON.stringify(events)).not.toContain(url)
    } finally {
      if (originalDiagnostics === undefined) delete process.env.CLAUDE_CODE_DIAGNOSTICS_FILE
      else process.env.CLAUDE_CODE_DIAGNOSTICS_FILE = originalDiagnostics
    }
  })

})
