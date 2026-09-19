import { afterEach, describe, expect, it } from 'bun:test'
import { mkdtemp, mkdir, opendir, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import * as path from 'node:path'
import {
  FileReferenceGate, resolveWorkspaceFileReference,
  type FileReferenceDependencies, type FileReferenceProbe, type PreparedFileReferenceScope,
} from './workspaceFileReferenceResolver'

const scope: PreparedFileReferenceScope = { workDir: '/repo', permissionGeneration: 'server-v1', pathStyle: 'posix' }
const found = (file: string, canonicalPath = file): FileReferenceProbe => ({ state: 'found', path: file, canonicalPath })
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => { resolve = done })
  return { promise, resolve }
}
function dependencies(overrides: Partial<FileReferenceDependencies> = {}): FileReferenceDependencies {
  return {
    gate: new FileReferenceGate(), prepareScope: async () => scope,
    probeFile: async () => ({ state: 'missing' }),
    listDirectory: async () => ({ state: 'ok', entries: [], complete: true }), ...overrides,
  }
}
const fixtures: string[] = []
afterEach(async () => { for (const root of fixtures.splice(0)) await rm(root, { recursive: true, force: true }) })

describe('bounded file reference core', () => {
  it('resolves the explicit target first and never searches after an absolute miss', async () => {
    let lists = 0
    const deps = dependencies({
      probeFile: async (file) => file === '/repo/exact.md' ? found(file) : { state: 'missing' },
      listDirectory: async () => { lists++; throw new Error('should not enumerate') },
    })
    expect((await resolveWorkspaceFileReference({ reference: 'exact.md' }, deps)).path).toBe('/repo/exact.md')
    const missing = await resolveWorkspaceFileReference({ reference: '/elsewhere/exact.md', candidates: ['/repo/exact.md'] }, deps)
    expect(missing.state).toBe('missing'); expect(missing.complete).toBe(true); expect(lists).toBe(0)
  })
  it('rejects malformed, huge, network, device, URL and drive-relative inputs without broad work', async () => {
    let probes = 0
    const deps = dependencies({ probeFile: async () => { probes++; return { state: 'missing' } } })
    for (const reference of ['https://example.org/a.md', 'file:///tmp/a.md', '//server/share/a.md', '\\\\?\\C:\\a.md', 'C:a.md', '../a.md']) {
      expect((await resolveWorkspaceFileReference({ reference }, deps)).state).toBe('invalid')
    }
    for (const request of [null, { reference: {} }, { reference: 'x'.repeat(4097) }, { reference: 'a.md', candidates: Array(100_000).fill('a.md') }, { reference: 'a.md', contextDirectories: {} }]) {
      expect((await resolveWorkspaceFileReference(request as never, deps)).state).toBe('invalid')
    }
    expect(probes).toBe(0)
  })
  it('preserves qualified suffixes and does not substitute another same basename', async () => {
    const probes: string[] = []
    const result = await resolveWorkspaceFileReference({ reference: 'docs/a.md', candidates: ['/repo/other/a.md', '/repo/nested/docs/a.md'] }, dependencies({
      probeFile: async (file) => { probes.push(file); return file === '/repo/nested/docs/a.md' ? found(file) : { state: 'missing' } },
    }))
    expect(result.path).toBe('/repo/nested/docs/a.md')
    expect(probes).toEqual(['/repo/docs/a.md', '/repo/nested/docs/a.md'])
  })
  it('deduplicates canonical aliases but preserves distinct POSIX case identities', async () => {
    const request = { reference: 'index.md', candidates: ['/repo/a/index.md', '/repo/b/index.md'] }
    const result = await resolveWorkspaceFileReference(request, dependencies({
      probeFile: async (file) => file === '/repo/index.md' ? { state: 'missing' } : found(file, '/repo/real/index.md'),
    }))
    expect(result.state).toBe('resolved'); expect(result.candidates).toHaveLength(1)
    const ambiguous = await resolveWorkspaceFileReference(request, dependencies({
      probeFile: async (file) => file === '/repo/index.md' ? { state: 'missing' }
        : found(file, file.includes('/a/') ? '/repo/A/index.md' : '/repo/a/index.md'),
    }))
    expect(ambiguous.state).toBe('ambiguous')
  })
  it('folds Windows identity case and rejects incomplete rooted Windows references', async () => {
    const deps = dependencies({
      prepareScope: async () => ({ ...scope, workDir: 'G:\\repo', pathStyle: 'windows' }),
      probeFile: async (file) => file === 'G:\\repo\\a.md' ? { state: 'missing' }
        : found(file, file.includes('one') ? 'G:\\REAL\\a.md' : 'g:\\real\\a.md'),
    })
    expect((await resolveWorkspaceFileReference({ reference: 'a.md', candidates: ['one/a.md', 'two/a.md'] }, deps)).state).toBe('resolved')
    expect((await resolveWorkspaceFileReference({ reference: '/docs/a.md' }, deps)).state).toBe('invalid')
  })
  it('caps total precise probes at 8, concurrency at 2, and marks clipped candidates incomplete', async () => {
    let active = 0, maxActive = 0
    const result = await resolveWorkspaceFileReference({ reference: 'a.md', candidates: Array.from({ length: 12 }, (_, n) => `/repo/${n}/a.md`) }, dependencies({
      probeFile: async (file) => {
        active++; maxActive = Math.max(active, maxActive); await wait(2); active--
        return file === '/repo/0/a.md' ? found(file) : { state: 'missing' }
      },
    }))
    expect(result.state).toBe('incomplete'); expect(result.complete).toBe(false)
    expect(result.stats.exactProbes).toBe(8); expect(maxActive).toBe(2)
  })
  it('caps roots, depth, directories and ALL visited entries without claiming missing', async () => {
    const roots = await resolveWorkspaceFileReference({ reference: 'a.md', contextDirectories: ['/a', '/b', '/c', '/d'] }, dependencies())
    expect(roots.state).toBe('incomplete'); expect(roots.stats.directories).toBe(3)
    const depth = await resolveWorkspaceFileReference({ reference: 'a.md' }, dependencies({
      listDirectory: async () => ({ state: 'ok', entries: [{ name: 'next', kind: 'directory' }], complete: true }),
    }))
    expect(depth.state).toBe('incomplete'); expect(depth.stats.directories).toBe(3)
    const dirs = await resolveWorkspaceFileReference({ reference: 'a.md' }, dependencies({
      listDirectory: async (dir) => ({ state: 'ok', entries: dir === '/repo'
        ? Array.from({ length: 20 }, (_, n) => ({ name: String(n), kind: 'directory' as const })) : [], complete: true }),
    }))
    expect(dirs.state).toBe('incomplete'); expect(dirs.stats.directories).toBe(12)
    const entries = await resolveWorkspaceFileReference({ reference: 'a.md' }, dependencies({
      listDirectory: async (_dir, _scope, limit) => ({ state: 'ok', entries: Array.from({ length: limit }, (_, n) => ({ name: `unrelated-${n}`, kind: 'file' as const })), complete: false }),
    }))
    expect(entries.state).toBe('incomplete'); expect(entries.stats.entries).toBe(256)
  })
  it('never turns denied, disappearing directories, I/O errors or symlink skips into missing', async () => {
    for (const state of ['denied', 'missing', 'error'] as const) {
      const result = await resolveWorkspaceFileReference({ reference: 'a.md' }, dependencies({
        listDirectory: async () => ({ state, error: '/secret/unauthorized/path' }),
      }))
      expect(result.state).not.toBe('missing'); expect(result.complete).toBe(false)
      expect(JSON.stringify(result)).not.toContain('/secret/unauthorized/path')
    }
    const result = await resolveWorkspaceFileReference({ reference: 'a.md' }, dependencies({
      listDirectory: async () => ({ state: 'ok', entries: [{ name: 'junction', kind: 'symlink' }], complete: true }),
    }))
    expect(result.state).toBe('incomplete')
  })
  it('includes scope preparation in the deadline and ignores its late completion', async () => {
    const pending = deferred<PreparedFileReferenceScope>(); let probes = 0
    const result = await resolveWorkspaceFileReference({ reference: 'a.md', timeoutMs: 15 }, dependencies({
      prepareScope: () => pending.promise,
      probeFile: async () => { probes++; return { state: 'missing' } },
    }))
    expect(result.state).toBe('incomplete'); expect(result.scope).toBeNull(); expect(result.stats.elapsedMs).toBeLessThan(200)
    pending.resolve(scope); await wait(5); expect(probes).toBe(0)
  })
  it('returns on a late directory I/O without scheduling another read', async () => {
    const pending = deferred<Awaited<ReturnType<FileReferenceDependencies['listDirectory']>>>(); let lists = 0
    const result = await resolveWorkspaceFileReference({ reference: 'a.md', timeoutMs: 15 }, dependencies({
      listDirectory: async () => { lists++; return pending.promise },
    }))
    expect(result.state).toBe('incomplete')
    pending.resolve({ state: 'ok', entries: [{ name: 'next', kind: 'directory' }], complete: true })
    await wait(5); expect(lists).toBe(1)
  })
  it('keeps global capacity occupied by uncancellable I/O across repeated timeouts', async () => {
    const gate = new FileReferenceGate(); const pending = deferred<PreparedFileReferenceScope>()
    let active = 0, maxActive = 0, starts = 0
    const deps = dependencies({ gate, prepareScope: async () => {
      starts++; active++; maxActive = Math.max(maxActive, active)
      const ready = await pending.promise; active--; return ready
    } })
    const first = await Promise.all(Array.from({ length: 24 }, () => resolveWorkspaceFileReference({ reference: 'a.md', timeoutMs: 15 }, deps)))
    expect(first.every((result) => result.state === 'incomplete')).toBe(true)
    for (let i = 0; i < 3; i++) {
      expect((await resolveWorkspaceFileReference({ reference: 'a.md', timeoutMs: 5 }, deps)).state).toBe('incomplete')
    }
    expect(starts).toBe(2); expect(maxActive).toBe(2); expect(active).toBe(2)
    pending.resolve(scope); await wait(5)
    expect((await resolveWorkspaceFileReference({ reference: 'a.md' }, deps)).state).toBe('missing')
    expect(active).toBe(0)
  })
  it('honors cancellation while queued, without beginning metadata work', async () => {
    const abort = new AbortController(); abort.abort(); let calls = 0
    const result = await resolveWorkspaceFileReference({ reference: 'a.md' }, dependencies({
      prepareScope: async () => { calls++; return scope },
    }), abort.signal)
    expect(result.state).toBe('incomplete'); expect(calls).toBe(0)
  })

  it('uses real temporary metadata, authorized roots and canonical junction identity without granting access', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'cc-haha-bounded-resolver-')); fixtures.push(root)
    const workspace = path.join(root, 'workspace'); const outside = path.join(root, 'outside')
    const nested = path.join(workspace, 'docs'); await mkdir(nested, { recursive: true }); await mkdir(outside)
    await writeFile(path.join(nested, '中文.md'), 'PRIVATE CONTENT MUST NOT BE RETURNED')
    await writeFile(path.join(outside, 'secret.md'), 'secret')
    await symlink(nested, path.join(workspace, 'alias'), process.platform === 'win32' ? 'junction' : 'dir')
    await symlink(outside, path.join(workspace, 'escape'), process.platform === 'win32' ? 'junction' : 'dir')
    let closes = 0
    const allowed = (file: string) => { const rel = path.relative(workspace, file); return !path.isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${path.sep}`) }
    const deps = dependencies({
      prepareScope: async () => ({ workDir: workspace, permissionGeneration: 'immutable', pathStyle: process.platform === 'win32' ? 'windows' : 'posix' }),
      probeFile: async (file) => {
        try {
          const canonical = await realpath(file)
          if (!allowed(canonical)) return { state: 'denied' }
          return (await stat(canonical)).isFile() ? found(file, canonical) : { state: 'missing' }
        } catch (error) { return { state: (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'missing' : 'error' } }
      },
      listDirectory: async (dir, _scope, limit, operation) => {
        const canonical = await realpath(dir)
        if (!allowed(canonical)) return { state: 'denied' }
        const cursor = await opendir(canonical)
        const entries = []
        try {
          while (entries.length < limit && !operation.signal.aborted) {
            const entry = await cursor.read()
            if (!entry) return { state: 'ok', entries, complete: true }
            if (operation.signal.aborted) break
            entries.push({ name: entry.name, kind: entry.isSymbolicLink() ? 'symlink' as const : entry.isDirectory() ? 'directory' as const : entry.isFile() ? 'file' as const : 'other' as const })
          }
          return { state: 'ok', entries, complete: false }
        } finally { await cursor.close(); closes++ }
      },
    })
    const result = await resolveWorkspaceFileReference({ reference: '中文.md', candidates: [path.join(nested, '中文.md'), path.join(workspace, 'alias', '中文.md')] }, deps)
    expect(result.state).toBe('resolved'); expect(result.candidates).toHaveLength(1)
    expect(JSON.stringify(result)).not.toContain('PRIVATE CONTENT')
    expect((await resolveWorkspaceFileReference({ reference: 'secret.md', contextDirectories: [outside] }, deps)).state).not.toBe('resolved')
    expect((await resolveWorkspaceFileReference({ reference: path.join(workspace, 'escape', 'secret.md') }, deps)).state).toBe('denied')
    expect(closes).toBeGreaterThan(0)
  })
})
