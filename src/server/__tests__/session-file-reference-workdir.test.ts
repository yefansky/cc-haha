import { test, expect, spyOn } from 'bun:test'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import * as os from 'node:os'
import { SessionService } from '../services/sessionService.js'
import { WorkspaceService } from '../services/workspaceService.js'
import type { LocalIndexGateway, IndexedWorkspaceSnapshot } from '../services/localIndex/sessionIndex.js'
import { captureSourceFingerprint, serializeSourceFingerprint } from '../services/localIndex/sourceFingerprint.js'
import { SESSION_SUMMARY_PARSER_VERSION } from '../services/localIndex/sessionProjector.js'

async function removeFixture(root: string): Promise<void> {
  const resolved = path.resolve(root)
  if (path.dirname(resolved) !== path.resolve(os.tmpdir()) || !path.basename(resolved).startsWith('file-reference-')) {
    throw new Error('Refusing cleanup outside the owned fixture directory')
  }
  await fs.rm(resolved, { recursive: true, force: true })
}

test('128 MiB single-line history: cold incomplete, ready metadata resolves without reading or parsing transcript', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'file-reference-large-'))
  const id = 'a0180000-0000-4000-8000-000000000001'
  const projectDir = 'synthetic-project'
  const projects = path.join(root, 'projects')
  const filePath = path.join(projects, projectDir, `${id}.jsonl`)
  const workDir = path.join(root, 'workspace')
  const spies: Array<{ mockRestore(): void }> = []
  try {
    await fs.mkdir(path.dirname(filePath), { recursive: true })
    await fs.mkdir(workDir)
    await fs.writeFile(path.join(workDir, '中文资料.html'), '<p>fixture</p>')
    // A valid, single enormous JSON record; no indexer/provider is started.
    const handle = await fs.open(filePath, 'w')
    try {
      await handle.write('{"type":"user","message":"')
      const chunk = Buffer.alloc(1024 * 1024, 0x78)
      for (let i = 0; i < 128; i++) await handle.write(chunk)
      await handle.write('"}\n')
    } finally { await handle.close() }
    const stat = await fs.stat(filePath)
    const fingerprint = await captureSourceFingerprint({ path: filePath, indexedBytes: stat.size, parserVersion: SESSION_SUMMARY_PARSER_VERSION })
    const row: IndexedWorkspaceSnapshot = {
      filePath, projectDir, workDir,
      source: { path: filePath, size: stat.size, mtimeMs: stat.mtimeMs, fileIdentity: fingerprint.fileIdentity,
        fingerprint: serializeSourceFingerprint(fingerprint), indexedBytes: stat.size,
        parserVersion: SESSION_SUMMARY_PARSER_VERSION, state: 'ready', lastErrorCode: null, updatedAtMs: Date.now() },
    }
    let rows: IndexedWorkspaceSnapshot[] | null = null
    const gateway = {
      getMode: () => 'on', getPublicStatus: () => ({ state: 'ready' }), isSessionScopeReady: () => true,
      getWorkspaceSnapshots: () => rows,
    } as unknown as LocalIndexGateway
    const service = new SessionService(gateway)
    spies.push(spyOn(service as any, 'getProjectsDir').mockReturnValue(projects))
    const forbidden = () => { throw new Error('unbounded transcript path called') }
    for (const method of ['getSessionWorkDir', 'readJsonlFile', 'scanSessionListSummary', 'findSessionFile']) {
      spies.push(spyOn(service as any, method).mockImplementation(forbidden))
    }
    const read = spyOn(fs, 'readFile').mockImplementation(forbidden as any)
    const open = spyOn(fs, 'open').mockImplementation(forbidden as any)
    spies.push(read, open)
    const workspace = new WorkspaceService(forbidden, undefined, undefined, undefined,
      (sessionId, operation) => service.getFileReferenceWorkDirSnapshot(sessionId, operation))
    expect((await workspace.resolveFileReference(id, { reference: '中文资料.html' })).state).toBe('incomplete')
    rows = [row]
    let ticks = 0
    const ticker = setInterval(() => ticks++, 1)
    const start = performance.now()
    const resolved = await workspace.resolveFileReference(id, { reference: '中文资料.html' })
    clearInterval(ticker)
    expect(resolved.state).toBe('resolved')
    expect(performance.now() - start).toBeLessThan(500)
    expect(ticks).toBeGreaterThan(0)
    expect(read).not.toHaveBeenCalled()
    expect(open).not.toHaveBeenCalled()
    // Append changes work-directory evidence even though target is untouched.
    await fs.appendFile(filePath, '{}\n')
    expect((await workspace.resolveFileReference(id, { reference: '中文资料.html' })).state).toBe('incomplete')
    expect(read).not.toHaveBeenCalled()
    expect(open).not.toHaveBeenCalled()
  } finally {
    for (const spy of spies.reverse()) spy.mockRestore()
    await removeFixture(root)
  }
}, 15000)

test('active snapshot is rechecked during metadata probing without legacy resolver', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'file-reference-active-'))
  try {
    await fs.writeFile(path.join(root, 'a.md'), 'fixture')
    let active = root
    const service = new SessionService({} as LocalIndexGateway)
    const workspace = new WorkspaceService(async () => { throw new Error('legacy called') }, undefined, undefined, undefined,
      (id, op) => service.getFileReferenceWorkDirSnapshot(id, op, () => active))
    const original = (workspace as any).safeStat.bind(workspace)
    const probe = spyOn(workspace as any, 'safeStat').mockImplementation(async (target: string) => {
      const result = await original(target)
      if (target.endsWith('a.md')) active = path.join(root, 'changed')
      return result
    })
    try { expect((await workspace.resolveFileReference('live', { reference: 'a.md' })).state).toBe('incomplete') }
    finally { probe.mockRestore() }
  } finally { await removeFixture(root) }
})
