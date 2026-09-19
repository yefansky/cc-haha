import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { WorkspaceService } from '../services/workspaceService.js'
import { clearFilesystemAccessRootsForTests, isWithinRegisteredFilesystemRoot } from '../services/filesystemAccessRoots.js'

let root: string, workDir: string, outside: string
beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'cc-haha-reference-service-'))
  workDir = path.join(root, 'work'); outside = path.join(root, 'outside')
  await fs.mkdir(workDir); await fs.mkdir(outside)
  clearFilesystemAccessRootsForTests()
})
afterEach(async () => {
  const resolved = path.resolve(root)
  if (path.dirname(resolved) !== path.resolve(os.tmpdir()) || !path.basename(resolved).startsWith('cc-haha-reference-service-')) throw new Error('Unsafe cleanup')
  await fs.rm(resolved, { recursive: true, force: true })
  clearFilesystemAccessRootsForTests()
})

describe('WorkspaceService bounded metadata adapter', () => {
  it('returns no body and refuses to count a directory as a file', async () => {
    const service = new WorkspaceService(async () => workDir)
    await fs.mkdir(path.join(workDir, 'notes')); await fs.writeFile(path.join(workDir, 'notes', '中文.md'), 'DO_NOT_READ_THIS_BODY')
    const result = await service.resolveFileReference('s', { reference: '中文.md' })
    expect(result.state).toBe('resolved'); expect(result.stats.directories).toBe(2)
    expect(result.path).toBe(path.join(workDir, 'notes', '中文.md'))
    expect(JSON.stringify(result)).not.toContain('DO_NOT_READ_THIS_BODY')
    expect((await service.resolveFileReference('s', { reference: path.join(workDir, 'notes') })).state).toBe('missing')
  })
  it('does not register junction roots while preserving normal user-directed directory browsing', async () => {
    const service = new WorkspaceService(async () => workDir)
    await fs.writeFile(path.join(outside, 'secret.md'), 'outside')
    await fs.symlink(outside, path.join(workDir, 'linked'), process.platform === 'win32' ? 'junction' : 'dir')
    const target = path.join(workDir, 'linked', 'secret.md')
    const denied = await service.resolveFileReference('s', { reference: target })
    expect(denied.state).toBe('denied'); expect(isWithinRegisteredFilesystemRoot(outside)).toBe(false)
    expect(JSON.stringify(denied)).not.toContain('secret.md')
    // Existing explicit tree navigation retains its own grant policy.
    await service.readTree('s')
    expect(isWithinRegisteredFilesystemRoot(outside)).toBe(true)
    expect((await service.resolveFileReference('s', { reference: target })).state).toBe('resolved')
  })
  it('keeps an exact checkpoint grant scoped to the file, never its parent/siblings', async () => {
    const service = new WorkspaceService(async () => workDir)
    const exact = path.join(outside, 'exact.md'); const sibling = path.join(outside, 'sibling.md')
    await fs.writeFile(exact, 'exact'); await fs.writeFile(sibling, 'sibling')
    await service.registerTurnCheckpointFileReadAccess('s', exact, workDir)
    expect((await service.resolveFileReference('s', { reference: exact })).state).toBe('resolved')
    expect((await service.resolveFileReference('s', { reference: sibling })).state).toBe('denied')
    expect((await service.resolveFileReference('s', { reference: 'sibling.md', contextDirectories: [outside] })).state).toBe('denied')
    expect(isWithinRegisteredFilesystemRoot(sibling)).toBe(false)
  })
  it('reports incomplete if workDir or read grants change during metadata', async () => {
    const file = path.join(workDir, 'exact.md'); await fs.writeFile(file, 'fixture')
    for (const change of ['workDir', 'permission'] as const) {
      let current = workDir
      const service = new WorkspaceService(async () => current)
      const internals = service as unknown as { safeStat(file: string): Promise<unknown> }
      const original = internals.safeStat.bind(service)
      internals.safeStat = async (candidate) => {
        const metadata = await original(candidate)
        if (candidate === file) {
          if (change === 'workDir') current = outside
          else await service.registerExternalRoot('s', outside)
        }
        return metadata
      }
      const result = await service.resolveFileReference('s', { reference: file })
      expect(result.state).toBe('incomplete'); expect(result.path).toBeUndefined(); expect(result.complete).toBe(false)
    }
  })
  it('enumerates at most 256 entries and never calls the general search/read APIs', async () => {
    const service = new WorkspaceService(async () => workDir)
    await Promise.all(Array.from({ length: 270 }, (_, n) => fs.writeFile(path.join(workDir, `entry-${n}.md`), 'fixture')))
    service.readFile = async () => { throw new Error('No body read allowed') }
    service.readTree = async () => { throw new Error('No unbounded tree allowed') }
    const result = await service.resolveFileReference('s', { reference: 'missing.md' })
    expect(result.state).toBe('incomplete'); expect(result.stats.entries).toBe(256); expect(result.stats.directories).toBe(1)
    expect(result.stats.exactProbes).toBe(1)
  })
})
