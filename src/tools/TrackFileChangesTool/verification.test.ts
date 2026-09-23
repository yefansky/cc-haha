import { afterEach, beforeEach, expect, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, rm, stat, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { getEmptyToolPermissionContext, type ToolUseContext } from '../../Tool.js'
import { getIsInteractive, getOriginalCwd, getSessionId, setIsInteractive, setOriginalCwd, switchSession } from '../../bootstrap/state.js'
import { fileHistoryMakeSnapshot, fileHistoryTrackEdit, resolveBackupPath, type FileHistoryState } from '../../utils/fileHistory.js'
import { runWithCwdOverride } from '../../utils/cwd.js'
import { beginShellChangeScan, finishShellChangeScan } from './shellScan.js'
import { verifyReportedPaths } from './verification.js'

const originalConfig = process.env.CLAUDE_CONFIG_DIR
const originalDisabled = process.env.CLAUDE_CODE_DISABLE_FILE_CHECKPOINTING
const originalInteractive = getIsInteractive()
const originalCwd = getOriginalCwd()
const originalSession = getSessionId()
let root: string
let state: FileHistoryState
let context: ToolUseContext

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'verify-report-'))
  process.env.CLAUDE_CONFIG_DIR = join(root, 'config')
  delete process.env.CLAUDE_CODE_DISABLE_FILE_CHECKPOINTING
  setIsInteractive(true)
  setOriginalCwd(root)
  state = { snapshots: [], trackedFiles: new Set(), snapshotSequence: 0 }
  context = {
    updateFileHistoryState: updater => { state = updater(state) },
    getAppState: () => ({ toolPermissionContext: getEmptyToolPermissionContext() }),
  } as ToolUseContext
  await fileHistoryMakeSnapshot(context.updateFileHistoryState, randomUUID())
})

afterEach(async () => {
  switchSession(originalSession)
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
  for (const path of paths) await fileHistoryTrackEdit(context.updateFileHistoryState, path, state.snapshots.at(-1)!.messageId)
}

test('history verification proves edits/additions/deletions, ignoring unchanged, touch and absent-to-absent', async () => {
  const names = ['edit', 'delete', 'touch', 'unchanged', 'new', 'absent'].map(name => join(root, name))
  for (const path of names.slice(0, 4)) await writeFile(path, 'before')
  await register(names)
  const before = await stat(names[0]!)
  await writeFile(names[0]!, 'AFTERS')
  await utimes(names[0]!, before.atime, before.mtime)
  await rm(names[1]!)
  await utimes(names[2]!, new Date(), new Date(Date.now() + 2000))
  await writeFile(names[4]!, 'new')
  const result = await verifyReportedPaths(names, context)
  expect(result.reported).toEqual([names[0]!, names[1]!, names[4]!])
  expect(result.unverified).toEqual([])
  expect(result.failed).toEqual([])
})

test('unbacked claims are unverified, including existing files and nonexistent deletion claims', async () => {
  const file = join(root, 'old.txt'), missing = join(root, 'missing.txt')
  await writeFile(file, 'existing')
  const result = await verifyReportedPaths([file, missing], context)
  expect(result.reported).toEqual([])
  expect(result.unverified.map(item => item.path)).toEqual([file, missing])
})

test('missing backups and unreadable non-file targets fail rather than becoming absence evidence', async () => {
  const file = join(root, 'file.txt'), nonFile = join(root, 'non-file')
  await writeFile(file, 'old')
  await register([file, nonFile])
  const backup = Object.values(state.snapshots.at(-1)!.trackedFileBackups).find(entry => entry.backupFileName !== null)!
  await rm(resolveBackupPath(backup.backupFileName!))
  await mkdir(nonFile)
  const result = await verifyReportedPaths([file, nonFile], context)
  expect(result.reported).toEqual([])
  expect(result.failed).toHaveLength(2)
})

test('empty scope supports delayed background report after context recreation', async () => {
  const out = join(root, 'out'), file = join(out, 'new.html')
  await mkdir(out)
  await runWithCwdOverride(root, () => beginShellChangeScan({ patterns: [{ base_dir: out, include: ['**/*.html'] }] }, [], context))
  await writeFile(file, 'new')
  const recreated = { ...context, updateFileHistoryState: (updater: Parameters<ToolUseContext['updateFileHistoryState']>[0]) => { state = updater(state) } } as ToolUseContext
  expect((await verifyReportedPaths([file], recreated)).reported).toEqual([file])
})

test('scope evidence does not leak to another session or later turn', async () => {
  const out = join(root, 'out'), file = join(out, 'new.txt')
  await mkdir(out)
  const scan = await runWithCwdOverride(root, () => beginShellChangeScan({ patterns: [{ base_dir: out, include: ['*.txt'] }] }, [], context))
  await writeFile(file, 'new')
  const session = getSessionId()
  switchSession(randomUUID() as ReturnType<typeof getSessionId>)
  expect((await verifyReportedPaths([file], context)).unverified).toHaveLength(1)
  switchSession(session)
  expect((await verifyReportedPaths([file], context)).reported).toEqual([file])
  await fileHistoryMakeSnapshot(context.updateFileHistoryState, randomUUID())
  await finishShellChangeScan(scan, true, context)
  expect((await verifyReportedPaths([file], context)).unverified).toHaveLength(1)
})

test('scope matching never invents additions for pre-existing files excluded by case or directory', async () => {
  const out = join(root, 'out'), upper = join(out, 'A.HTML'), excluded = join(out, 'cache', 'old.html')
  await mkdir(join(out, 'cache'), { recursive: true })
  await writeFile(upper, 'old')
  await writeFile(excluded, 'old')
  await runWithCwdOverride(root, () => beginShellChangeScan({ patterns: [{ base_dir: out, include: ['**/*.html'], exclude: ['cache/**'] }] }, [], context))
  const paths = [upper, excluded]
  if (process.platform === 'win32') paths.push(join(out, 'a.html'))
  const result = await verifyReportedPaths(paths, context)
  expect(result.reported).toEqual([])
  expect(result.unverified).toHaveLength(2)
})

test('scope begin rejects failed enumeration; partial scans cannot prove absence', async () => {
  const missing = join(root, 'no-directory')
  await expect(runWithCwdOverride(root, () => beginShellChangeScan({ patterns: [{ base_dir: missing, include: ['*.txt'] }] }, [], context))).rejects.toThrow('complete scope baseline')
  await mkdir(missing)
  const file = join(missing, 'after.txt')
  await writeFile(file, 'after')
  expect((await verifyReportedPaths([file], context)).unverified).toHaveLength(1)
})

test('foreground scan emits v1 evidence for actual changes only', async () => {
  const file = join(root, 'change.txt'), kept = join(root, 'kept.txt'), fresh = join(root, 'new.txt')
  await writeFile(file, 'before')
  await writeFile(kept, 'before')
  const scan = await runWithCwdOverride(root, () => beginShellChangeScan({ patterns: [{ base_dir: root, include: ['*.txt'] }] }, [file, kept], context))
  await writeFile(file, 'after')
  await writeFile(fresh, 'new')
  const report = await runWithCwdOverride(root, () => finishShellChangeScan(scan, false, context))
  const result = JSON.parse(report.slice('file_changes_report: '.length))
  expect(result.evidence_version).toBe(1)
  expect(result.reported.sort()).toEqual([file, fresh].sort())
  expect(result.unverified).toEqual([])
  expect(result.failed).toEqual([])
})
