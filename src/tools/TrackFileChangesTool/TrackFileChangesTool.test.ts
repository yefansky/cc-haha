import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { randomUUID, type UUID } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rename, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { getIsInteractive, getOriginalCwd, setIsInteractive, setOriginalCwd } from '../../bootstrap/state.js'
import { getEmptyToolPermissionContext, type ToolUseContext } from '../../Tool.js'
import { runWithCwdOverride } from '../../utils/cwd.js'
import { fileHistoryGetDiffStats, fileHistoryRewind, type FileHistoryState } from '../../utils/fileHistory.js'
import { TrackFileChangesTool } from './TrackFileChangesTool.js'

const originalConfig = process.env.CLAUDE_CONFIG_DIR
const originalDisabled = process.env.CLAUDE_CODE_DISABLE_FILE_CHECKPOINTING
const originalInteractive = getIsInteractive()
const originalCwd = getOriginalCwd()
let root: string
let state: FileHistoryState
let id: UUID
let context: ToolUseContext

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'track-file-changes-'))
  process.env.CLAUDE_CONFIG_DIR = join(root, 'config')
  delete process.env.CLAUDE_CODE_DISABLE_FILE_CHECKPOINTING
  setIsInteractive(true)
  setOriginalCwd(join(root, 'project'))
  await mkdir(getOriginalCwd())
  id = randomUUID() as UUID
  state = { snapshots: [{ messageId: id, trackedFileBackups: {}, timestamp: new Date() }], trackedFiles: new Set(), snapshotSequence: 1 }
  context = {
    updateFileHistoryState: updater => { state = updater(state) },
    getAppState: () => ({ toolPermissionContext: getEmptyToolPermissionContext() }),
  } as ToolUseContext
})

afterEach(async () => {
  setOriginalCwd(originalCwd)
  setIsInteractive(originalInteractive)
  if (originalConfig === undefined) delete process.env.CLAUDE_CONFIG_DIR
  else process.env.CLAUDE_CONFIG_DIR = originalConfig
  if (originalDisabled === undefined) delete process.env.CLAUDE_CODE_DISABLE_FILE_CHECKPOINTING
  else process.env.CLAUDE_CODE_DISABLE_FILE_CHECKPOINTING = originalDisabled
  await Bun.sleep(50)
  await rm(root, { recursive: true, force: true })
})

async function register(paths: string[]) {
  return runWithCwdOverride(getOriginalCwd(), () => TrackFileChangesTool.call({ file_paths: paths }, context))
}

describe('TrackFileChanges', () => {
  test('linked project paths report the real target; explicit permitted targets can be backed up', async () => {
    const external = join(root, 'external')
    await mkdir(external)
    const file = join(external, 'check.py')
    await writeFile(file, 'before')
    await symlink(external, join(getOriginalCwd(), 'linked'), process.platform === 'win32' ? 'junction' : 'dir')
    const rejected = await register([join(getOriginalCwd(), 'linked/check.py')])
    expect(rejected.data.registered).toEqual([])
    expect(rejected.data.failed[0]?.reason).toContain('symbolic link')
    expect(rejected.data.failed[0]?.reason).toContain(file)
    expect((await register([file])).data.registered).toEqual([file])
    expect(await readFile(file, 'utf8')).toBe('before')
  })
  test('registers without a false change, detects an external write and retains the original on repeated registration', async () => {
    const file = join(getOriginalCwd(), 'source.txt')
    await writeFile(file, 'before\n')
    const first = await register(['source.txt', file])
    expect(first.data.registered).toEqual([file])
    expect(first.data.failed).toEqual([])
    expect((await fileHistoryGetDiffStats(state, id))?.filesChanged).toEqual([])
    const command = Bun.spawn([process.execPath, '-e', 'require("node:fs").writeFileSync(process.argv[1], "after\\n")', file], { stdout: 'pipe', stderr: 'pipe' })
    expect(await command.exited).toBe(0)
    await register([file])
    expect((await fileHistoryGetDiffStats(state, id))?.filesChanged).toHaveLength(1)
    await fileHistoryRewind(updater => { state = updater(state) }, id)
    expect(await readFile(file, 'utf8')).toBe('before\n')
  })

  test('captures both sides of a rename and a previously absent file', async () => {
    const oldPath = join(getOriginalCwd(), 'old.txt')
    const newPath = join(getOriginalCwd(), 'new.txt')
    await writeFile(oldPath, 'original\n')
    expect((await register([oldPath, newPath])).data.registered).toHaveLength(2)
    expect((await fileHistoryGetDiffStats(state, id))?.filesChanged).toEqual([])
    await rename(oldPath, newPath)
    expect((await fileHistoryGetDiffStats(state, id))?.filesChanged).toHaveLength(2)
    await fileHistoryRewind(updater => { state = updater(state) }, id)
    expect(await readFile(oldPath, 'utf8')).toBe('original\n')
    expect(await Bun.file(newPath).exists()).toBe(false)
  })

  test('reports disabled history, missing snapshots and failed directory backups without claiming success', async () => {
    const file = join(getOriginalCwd(), 'source.txt')
    await writeFile(file, 'before')
    process.env.CLAUDE_CODE_DISABLE_FILE_CHECKPOINTING = '1'
    expect((await register([file])).data.failed[0]?.reason).toContain('disabled')
    delete process.env.CLAUDE_CODE_DISABLE_FILE_CHECKPOINTING
    expect((await register([getOriginalCwd()])).data.registered).toEqual([])
    expect((await register([getOriginalCwd()])).data.failed).toHaveLength(1)
    state.snapshots = []
    expect((await register([file])).data.failed[0]?.reason).toContain('snapshot')
    expect(await readFile(file, 'utf8')).toBe('before')
  })

  test('uses read permission for every path, so an allowed file cannot hide a denied second file', async () => {
    const permissions = getEmptyToolPermissionContext()
    permissions.alwaysDenyRules = { userSettings: ['Read(**/secret.txt)'] }
    context.getAppState = () => ({ toolPermissionContext: permissions }) as ReturnType<ToolUseContext['getAppState']>
    const publicFile = join(getOriginalCwd(), 'public.txt')
    const secret = join(getOriginalCwd(), 'secret.txt')
    await writeFile(publicFile, 'public')
    await writeFile(secret, 'secret')
    const decision = await runWithCwdOverride(getOriginalCwd(), () => TrackFileChangesTool.checkPermissions({ file_paths: [publicFile, secret] }, context))
    expect(decision.behavior).toBe('deny')
    const result = await register([secret])
    expect(result.data.registered).toEqual([])
    expect(result.data.failed).toHaveLength(1)
    expect(state.trackedFiles.size).toBe(0)
  })

  test('retains read approval requirements and rejects an empty registration request', async () => {
    const permissions = getEmptyToolPermissionContext()
    permissions.alwaysAskRules = { userSettings: ['Read(**/review.txt)'] }
    context.getAppState = () => ({ toolPermissionContext: permissions }) as ReturnType<ToolUseContext['getAppState']>
    const file = join(getOriginalCwd(), 'review.txt')
    await writeFile(file, 'before')
    expect((await runWithCwdOverride(getOriginalCwd(), () => TrackFileChangesTool.checkPermissions({ file_paths: [file] }, context))).behavior).toBe('ask')
    expect(state.trackedFiles.size).toBe(0)
    expect(TrackFileChangesTool.inputSchema.safeParse({}).success).toBe(false)
    expect(TrackFileChangesTool.inputSchema.safeParse({ file_paths: [], patterns: [] }).success).toBe(false)
  })

  test('registers a glob batch, reports actual additions/deletions/edits and leaves unchanged files out', async () => {
    const project = getOriginalCwd()
    for (const name of ['a.txt', 'b.txt', 'kept.txt', 'deleted.txt']) await writeFile(join(project, name), 'before\n')
    const result = await runWithCwdOverride(project, () => TrackFileChangesTool.call({
      file_paths: ['new.txt'], patterns: [{ base_dir: project, include: ['*.txt'] }],
    }, context))
    expect(result.data.registered).toHaveLength(5)
    expect(result.data.failed).toEqual([])
    expect(result.data.truncated).toBe(false)
    expect((await fileHistoryGetDiffStats(state, id))?.filesChanged).toEqual([])
    const command = Bun.spawn([process.execPath, '-e', 'const fs = require("node:fs"); for (const p of ["a.txt", "b.txt", "new.txt"]) fs.writeFileSync(p, "after\\n"); fs.unlinkSync("deleted.txt")'], { cwd: project, stdout: 'pipe', stderr: 'pipe' })
    expect(await command.exited).toBe(0)
    expect((await fileHistoryGetDiffStats(state, id))?.filesChanged).toHaveLength(4)
    await fileHistoryRewind(updater => { state = updater(state) }, id)
    for (const name of ['a.txt', 'b.txt', 'kept.txt', 'deleted.txt']) expect(await readFile(join(project, name), 'utf8')).toBe('before\n')
    expect(await Bun.file(join(project, 'new.txt')).exists()).toBe(false)
  })
})
