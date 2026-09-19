import { afterEach, beforeEach, expect, mock, spyOn, test } from 'bun:test'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import * as os from 'node:os'
import { SessionService } from '../services/sessionService.js'
import { WorkspaceService } from '../services/workspaceService.js'
import { captureSourceFingerprint, serializeSourceFingerprint } from '../services/localIndex/sourceFingerprint.js'
import { SESSION_SUMMARY_PARSER_VERSION } from '../services/localIndex/sessionProjector.js'
import type { IndexedWorkspaceSnapshot, LocalIndexGateway } from '../services/localIndex/sessionIndex.js'
const id = '12345678-1234-4234-8234-123456789abc'
let root: string, work: string, file: string, row: IndexedWorkspaceSnapshot
let service: SessionService, rows: IndexedWorkspaceSnapshot[], ready: boolean, lookups: number
let priorConfig: string | undefined
const op = (ms = 500) => ({ signal: new AbortController().signal, deadline: Date.now() + ms })
let forbiddenCalls = 0
const forbidden = () => { forbiddenCalls++; throw new Error('Forbidden transcript fallback') }
beforeEach(async () => {
  forbiddenCalls = 0
  priorConfig = process.env.CLAUDE_CONFIG_DIR
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'bounded-scope-independent-'))
  process.env.CLAUDE_CONFIG_DIR = root
  work = path.join(root, 'work'); await fs.mkdir(work)
  const projectDir = 'fixture-project'; await fs.mkdir(path.join(root, 'projects', projectDir), { recursive: true })
  file = path.join(root, 'projects', projectDir, `${id}.jsonl`)
  const handle = await fs.open(file, 'w')
  try { await handle.write('NOT_VALID_JSON_FULL_PARSE_MUST_NOT_HAPPEN'); await handle.truncate(64 * 1024 * 1024) } finally { await handle.close() }
  const exactTime = new Date('2026-09-18T00:00:00.000Z')
  await fs.utimes(file, exactTime, exactTime)
  const fingerprint = await captureSourceFingerprint({ path: file, indexedBytes: 64 * 1024 * 1024, parserVersion: SESSION_SUMMARY_PARSER_VERSION })
  row = { filePath: file, projectDir, workDir: work, source: { path: file, size: fingerprint.size, mtimeMs: fingerprint.mtimeMs, fileIdentity: fingerprint.fileIdentity, fingerprint: serializeSourceFingerprint(fingerprint), indexedBytes: fingerprint.indexedBytes, parserVersion: fingerprint.parserVersion, state: 'ready', lastErrorCode: null, updatedAtMs: Date.now() } }
  rows = [row]; ready = true; lookups = 0
  const gateway = {
    getMode: () => 'on', getPublicStatus: () => ({ mode: 'on', state: ready ? 'ready' : 'building', lastUpdatedAt: 'fixture' }), isSessionScopeReady: () => ready,
    getWorkspaceSnapshots: () => { lookups++; return rows },
    listSessions: forbidden, findSessionFiles: forbidden, start: forbidden, rebuild: forbidden,
  } as unknown as LocalIndexGateway
  service = new SessionService(gateway)
  for (const name of ['getSessionWorkDir', 'readJsonlFile', 'findSessionFile', 'findSessionFiles', 'scanSessionListSummary']) spyOn(service as any, name).mockImplementation(forbidden)
  // Metadata path may stat/realpath, but cannot open/read transcript bytes.
  spyOn(fs, 'readFile').mockImplementation(forbidden)
  spyOn(fs, 'open').mockImplementation(forbidden)
})
afterEach(async () => {
  const forbiddenCount = forbiddenCalls
  mock.restore()
  if (priorConfig === undefined) delete process.env.CLAUDE_CONFIG_DIR; else process.env.CLAUDE_CONFIG_DIR = priorConfig
  const resolved = path.resolve(root)
  if (path.dirname(resolved) !== path.resolve(os.tmpdir()) || !path.basename(resolved).startsWith('bounded-scope-independent-')) throw new Error('Unsafe cleanup')
  await fs.rm(resolved, { recursive: true, force: true })
  expect(forbiddenCount).toBe(0)
})
test('active in-memory scope requires neither ready index nor transcript and rejects later scope changes', async () => {
  ready = false
  let active = work
  const snapshot = await service.getFileReferenceWorkDirSnapshot(id, op(), () => active)
  expect(snapshot.workDir).toBe(work); expect(lookups).toBe(0)
  await snapshot.validate(op())
  active = path.join(root, 'other')
  await expect(snapshot.validate(op())).rejects.toThrow()
})
test('fresh indexed 64 MiB malformed transcript resolves using metadata only', async () => {
  const snapshot = await service.getFileReferenceWorkDirSnapshot(id, op())
  expect(snapshot.workDir).toBe(work)
  await snapshot.validate(op())
  expect(lookups).toBe(1)
})
test('cold and duplicate index results fail closed without list or transcript fallback', async () => {
  ready = false
  await expect(service.getFileReferenceWorkDirSnapshot(id, op())).rejects.toThrow()
  expect(lookups).toBe(0)
  ready = true; rows = [row, { ...row, workDir: path.join(root, 'other') }]
  await expect(service.getFileReferenceWorkDirSnapshot(id, op())).rejects.toThrow()
  expect(lookups).toBe(1)
})
test('stale fingerprint fields and a new active session invalidate indexed metadata', async () => {
  row.source.mtimeMs--
  await expect(service.getFileReferenceWorkDirSnapshot(id, op())).rejects.toThrow()
  row.source.mtimeMs++
  let active = ''
  const snapshot = await service.getFileReferenceWorkDirSnapshot(id, op(), () => active)
  active = work
  await expect(snapshot.validate(op())).rejects.toThrow()
})
test('expired or cancelled metadata operations do no index work', async () => {
  await expect(service.getFileReferenceWorkDirSnapshot(id, op(-1))).rejects.toThrow()
  const controller = new AbortController(); controller.abort()
  await expect(service.getFileReferenceWorkDirSnapshot(id, { signal: controller.signal, deadline: Date.now() + 500 })).rejects.toThrow()
  expect(lookups).toBe(0)
})
test('workspace endpoint uses dedicated scope preparation and never the legacy callback', async () => {
  const workspace = new WorkspaceService(forbidden, undefined, undefined, undefined, (sessionId, operation) => service.getFileReferenceWorkDirSnapshot(sessionId, operation))
  const result = await workspace.resolveFileReference(id, { reference: path.join(work, 'missing.md') })
  expect(result.state).toBe('missing')
  expect(result.scope?.workDir).toBe(work)
})
test('insufficient remaining SQLite busy-wait budget refuses the query while active memory stays usable', async () => {
  await expect(service.getFileReferenceWorkDirSnapshot(id, op(50))).rejects.toThrow()
  expect(lookups).toBe(0)
  expect((await service.getFileReferenceWorkDirSnapshot(id, op(50), () => work)).workDir).toBe(work)
})
test('real same-size transcript replacement with restored mtime invalidates historical snapshot on Windows', async () => {
  const snapshot = await service.getFileReferenceWorkDirSnapshot(id, op())
  const before = await fs.stat(file)
  const replacement = `${file}.replacement`
  // Setup mutation uses writeFile/truncate, not the forbidden read/open paths.
  await new Promise(resolve => setTimeout(resolve, 25))
  await fs.writeFile(replacement, 'SAME_SIZE_REPLACEMENT')
  await fs.truncate(replacement, before.size)
  await fs.utimes(replacement, before.atime, before.mtime)
  await fs.rename(replacement, file)
  await fs.utimes(file, before.atime, before.mtime)
  const after = await fs.stat(file)
  expect(after.size).toBe(before.size)
  expect(after.mtimeMs).toBe(before.mtimeMs)
  expect(after.ctimeMs !== before.ctimeMs || after.ino !== before.ino).toBe(true)
  await expect(snapshot.validate(op())).rejects.toThrow()
})
