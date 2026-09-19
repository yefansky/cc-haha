import { afterEach, beforeEach, expect, test } from 'bun:test'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { WorkspaceService } from '../services/workspaceService.js'
import { clearFilesystemAccessRootsForTests, isWithinRegisteredFilesystemRoot } from '../services/filesystemAccessRoots.js'
import { handleWorkspaceFileReferenceRoute } from './workspaceFileReference.js'

let root: string, work: string, alternate: string, outside: string
let service: WorkspaceService
let server: ReturnType<typeof Bun.serve>
let current: string
beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'file-ref-independent-http-'))
  work = path.join(root, 'workspace'); alternate = path.join(root, 'alternate'); outside = path.join(root, 'outside')
  for (const directory of [work, alternate, outside]) await fs.mkdir(directory)
  current = work
  clearFilesystemAccessRootsForTests()
  service = new WorkspaceService(async id => id === 'fixture' ? current : null)
  server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: req => handleWorkspaceFileReferenceRoute(req, 'fixture', service) })
})
afterEach(async () => {
  server?.stop(true)
  // Remove only our own junction before recursively deleting our temporary tree.
  try { await fs.unlink(path.join(work, 'mounted')) } catch {}
  const resolved = path.resolve(root), temp = path.resolve(os.tmpdir())
  if (path.dirname(resolved) !== temp || !path.basename(resolved).startsWith('file-ref-independent-http-')) throw new Error('Unsafe test cleanup path')
  await fs.rm(resolved, { recursive: true, force: true })
  clearFilesystemAccessRootsForTests()
})
async function request(body: unknown) {
  const response = await fetch(`http://127.0.0.1:${server.port}/api/sessions/fixture/workspace/resolve-file-reference`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
  expect(response.status).toBe(200)
  return await response.json() as { state: string; complete: boolean; path?: string; scope: { workDir: string; permissionGeneration: string }; stats: { directories: number } }
}
test('real HTTP and filesystem resolve a unique nested file then detect missing exact target', async () => {
  await fs.mkdir(path.join(work, 'notes'))
  const file = path.join(work, 'notes', 'unique.md')
  await fs.writeFile(file, 'PRIVATE_FIXTURE_BODY_NOT_METADATA')
  const first = await request({ reference: 'unique.md' })
  expect(first.state).toBe('resolved'); expect(first.complete).toBe(true)
  expect(path.resolve(first.path!)).toBe(file)
  expect(JSON.stringify(first)).not.toContain('PRIVATE_FIXTURE_BODY_NOT_METADATA')
  const exact = await request({ reference: first.path })
  expect(exact.state).toBe('resolved'); expect(exact.stats.directories).toBe(0)
  await fs.unlink(file)
  const gone = await request({ reference: first.path })
  expect(gone.state).toBe('missing'); expect(gone.stats.directories).toBe(0)
})
test('real junction requires an existing session grant and resolver never registers one', async () => {
  const file = path.join(outside, 'private.md')
  await fs.writeFile(file, 'not returned')
  await fs.symlink(outside, path.join(work, 'mounted'), process.platform === 'win32' ? 'junction' : 'dir')
  const linked = path.join(work, 'mounted', 'private.md')
  expect(isWithinRegisteredFilesystemRoot(file)).toBe(false)
  expect((await request({ reference: linked })).state).toBe('denied')
  expect(isWithinRegisteredFilesystemRoot(file)).toBe(false)
  await service.registerExternalRoot('fixture', outside)
  const granted = await request({ reference: linked })
  expect(granted.state).toBe('resolved'); expect(granted.stats.directories).toBe(0)
  // A different service/session has no session grant even though process roots exist.
  service = new WorkspaceService(async () => work)
  expect((await request({ reference: linked })).state).toBe('denied')
})
test('actual session workdir changes alter scope and reject the former complete target', async () => {
  const file = path.join(work, 'scope.md')
  await fs.writeFile(file, 'scope fixture')
  const before = await request({ reference: file })
  expect(before.state).toBe('resolved')
  current = alternate
  const after = await request({ reference: file })
  expect(after.state).toBe('denied')
  expect(after.scope.workDir).not.toBe(before.scope.workDir)
  current = work
  expect((await request({ reference: file })).state).toBe('resolved')
})
test('workdir changing during one real HTTP lookup never returns an old resolved target', async () => {
  const file = path.join(work, 'changing.md')
  await fs.writeFile(file, 'fixture')
  let calls = 0
  service = new WorkspaceService(async () => ++calls === 1 ? work : alternate)
  const result = await request({ reference: file })
  expect(result.state).toBe('incomplete')
  expect(result.complete).toBe(false)
  expect(result.path).toBeUndefined()
})
