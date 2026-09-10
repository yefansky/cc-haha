import { afterEach, beforeEach, expect, test } from 'bun:test'
import { randomUUID, type UUID } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { existsSync } from 'node:fs'
import { getIsInteractive, getOriginalCwd, setIsInteractive, setOriginalCwd } from '../../bootstrap/state.js'
import { getEmptyToolPermissionContext, type ToolUseContext } from '../../Tool.js'
import type { AssistantMessage } from '../../types/message.js'
import { fileHistoryGetDiffStats, type FileHistoryState } from '../../utils/fileHistory.js'
import { prepareShellFileChanges as prepareShellFileChangesImpl, shellFileChangesSchema } from './shellTracking.js'
import { runWithCwdOverride } from '../../utils/cwd.js'
import { TrackFileChangesTool } from './TrackFileChangesTool.js'
import { BashTool } from '../BashTool/BashTool.js'
import { PowerShellTool } from '../PowerShellTool/PowerShellTool.js'

const saved = { config: process.env.CLAUDE_CONFIG_DIR, disabled: process.env.CLAUDE_CODE_DISABLE_FILE_CHECKPOINTING, shell: process.env.CLAUDE_CODE_SHELL, interactive: getIsInteractive(), cwd: getOriginalCwd() }
let root: string
let state: FileHistoryState
let context: ToolUseContext
let id: UUID
const parent = { uuid: randomUUID() } as AssistantMessage
function prepareShellFileChanges(options: Parameters<typeof prepareShellFileChangesImpl>[0]) {
  return runWithCwdOverride(root, () => prepareShellFileChangesImpl(options))
}
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'shell-tracking-'))
  process.env.CLAUDE_CONFIG_DIR = join(root, 'config')
  delete process.env.CLAUDE_CODE_DISABLE_FILE_CHECKPOINTING
  if (process.platform === 'win32') {
    const bash = [resolve(dirname(Bun.which('git')!), '../bin/bash.exe'), join(process.env.ProgramFiles ?? 'C:/Program Files', 'Git/bin/bash.exe')].find(existsSync)
    if (bash) process.env.CLAUDE_CODE_SHELL = bash
  }
  setIsInteractive(true)
  setOriginalCwd(root)
  await mkdir(join(root, 'files'))
  id = randomUUID() as UUID
  state = { snapshots: [{ messageId: id, trackedFileBackups: {}, timestamp: new Date() }], trackedFiles: new Set(), snapshotSequence: 1 }
  context = { updateFileHistoryState: updater => { state = updater(state) }, getAppState: () => ({ toolPermissionContext: getEmptyToolPermissionContext(), tasks: {} }), setAppState: () => {}, setToolJSX: () => {}, abortController: new AbortController() } as ToolUseContext
})
afterEach(async () => {
  setOriginalCwd(saved.cwd)
  setIsInteractive(saved.interactive)
  for (const [key, value] of [['CLAUDE_CONFIG_DIR', saved.config], ['CLAUDE_CODE_DISABLE_FILE_CHECKPOINTING', saved.disabled], ['CLAUDE_CODE_SHELL', saved.shell]]) {
    if (value === undefined) delete process.env[key!]
    else process.env[key!] = value
  }
  await Bun.sleep(50)
  await rm(root, { recursive: true, force: true })
})

test.each([BashTool, PowerShellTool])('$name runs an ordinary model script without a file-change declaration', async tool => {
  const path = join(root, 'files', 'source.txt')
  await writeFile(path, 'before')
  const python = Bun.which('python')!.replaceAll('\\', '/')
  const command = `${tool.name === 'PowerShell' ? '& ' : ''}'${python}' -c "from pathlib import Path;Path(r'${path.replaceAll('\\', '/')}').write_text('after')"`
  const result = await tool.call({ command }, context, undefined, parent)
  expect(result.data.interrupted).toBe(false)
  expect(await readFile(path, 'utf8')).toBe('after')
  // An undeclared shell write is not evidence of a captured baseline.
  expect(state.trackedFiles.size).toBe(0)
  expect(tool.inputSchema.safeParse({ command: 'python batch.py', file_changes: { file_paths: [path] } }).success).toBe(true)
})

test.each([BashTool, PowerShellTool])('$name accepts serialized declarations while retaining the object API contract', tool => {
  for (const declaration of [{ read_only: true }, { file_paths: ['G:/repo/文件.txt'] }, { patterns: [{ base_dir: 'G:/repo', include: ['src/**'] }] }]) {
    const result = tool.inputSchema.safeParse({ command: 'python check.py', file_changes: JSON.stringify(declaration) })
    expect(result.success).toBe(true)
    if (result.success) expect(result.data.file_changes).toEqual(declaration)
  }
  for (const invalid of ['read_only', 'null', '[]', '{}', '{"read_only":false}', '{"read_only":true,"file_paths":["a"]}', '{bad json']) {
    expect(tool.inputSchema.safeParse({ command: 'python check.py', file_changes: invalid }).success).toBe(false)
  }
})

const executableTools = process.platform === 'win32' || Bun.which('pwsh') ? [BashTool, PowerShellTool] : [BashTool]
test.each(executableTools)('$name registers declared targets and runs a real Python edit', async tool => {
  const path = join(root, 'files', 'source.txt')
  await writeFile(path, 'before')
  const python = Bun.which('python')!.replaceAll('\\', '/')
  const command = `${tool.name === 'PowerShell' ? '& ' : ''}'${python}' -c "from pathlib import Path;Path(r'${path.replaceAll('\\', '/')}').write_text('after')"`
  const result = await tool.call({ command, file_changes: { file_paths: [path] } }, context, undefined, parent)
  expect(result.data.interrupted).toBe(false)
  expect(await readFile(path, 'utf8')).toBe('after')
  expect((await fileHistoryGetDiffStats(state, id))?.filesChanged).toHaveLength(1)
})

test('batch registration captures real Python GBK edits, deletions and new files, without unchanged entries', async () => {
  const changed = join(root, 'files', 'changed.txt')
  const removed = join(root, 'files', 'removed.txt')
  const same = join(root, 'files', 'same.txt')
  const created = join(root, 'files', 'created.txt')
  await writeFile(changed, Buffer.from([0xd6, 0xd0]))
  await writeFile(removed, 'delete me')
  await writeFile(same, 'keep me')
  const targets = { file_paths: [created], patterns: [{ base_dir: join(root, 'files'), include: ['*.txt'] }] }
  await prepareShellFileChanges({ fileChanges: targets, knownReadOnly: false, context, parentMessage: parent })
  expect((await fileHistoryGetDiffStats(state, id))?.filesChanged).toEqual([])
  const child = Bun.spawn(['python', '-c', 'from pathlib import Path; import sys; Path(sys.argv[1]).write_bytes(bytes([0xb9,0xfa])); Path(sys.argv[2]).unlink(); Path(sys.argv[3]).write_text("created")', changed, removed, created], { stdout: 'pipe', stderr: 'pipe' })
  expect(await child.exited).toBe(0)
  const paths = (await fileHistoryGetDiffStats(state, id))?.filesChanged ?? []
  expect(paths).toHaveLength(3)
  expect(paths.some(path => path.endsWith('same.txt'))).toBe(false)
})

test('permits known reads and explicit read-only scripts without creating backups', async () => {
  await prepareShellFileChanges({ knownReadOnly: true, context, parentMessage: parent })
  await prepareShellFileChanges({ fileChanges: { read_only: true }, knownReadOnly: false, context, parentMessage: parent })
  await prepareShellFileChanges({ knownReadOnly: false, context })
  expect(state.trackedFiles.size).toBe(0)
})

test('rejects conflicting declarations and unavailable backups', async () => {
  expect(shellFileChangesSchema.safeParse({ read_only: true, file_paths: ['source.txt'] }).success).toBe(false)
  state.snapshots = []
  await expect(prepareShellFileChanges({ fileChanges: { file_paths: [join(root, 'files', 'source.txt')] }, knownReadOnly: false, context, parentMessage: parent })).rejects.toThrow('FILE_CHANGES_INCOMPLETE')
})

test('refuses a batch containing a denied file without executing the command', async () => {
  const allowed = join(root, 'files', 'public.txt')
  const denied = join(root, 'files', 'secret.txt')
  await writeFile(allowed, 'before')
  await writeFile(denied, 'secret')
  const permissions = getEmptyToolPermissionContext()
  permissions.alwaysDenyRules = { userSettings: ['Read(**/secret.txt)'] }
  context.getAppState = () => ({ toolPermissionContext: permissions }) as ReturnType<ToolUseContext['getAppState']>
  await expect(runWithCwdOverride(root, () => BashTool.call({ command: 'exit 0', file_changes: { file_paths: [allowed, denied] } }, context, undefined, parent))).rejects.toThrow('FILE_CHANGES_PERMISSION')
  expect(state.trackedFiles.size).toBe(0)
  expect(await readFile(allowed, 'utf8')).toBe('before')
})

test('allows explicitly pre-registered one-use approval without an approval loop, but does not authorize another target', async () => {
  const path = join(root, 'files', 'review.txt')
  const another = join(root, 'files', 'another-review.txt')
  await writeFile(path, 'before')
  const permissions = getEmptyToolPermissionContext()
  permissions.alwaysAskRules = { userSettings: ['Read(**/*review.txt)'] }
  context.getAppState = () => ({ toolPermissionContext: permissions }) as ReturnType<ToolUseContext['getAppState']>
  const options = { fileChanges: { file_paths: [path] }, knownReadOnly: false, context, parentMessage: parent }
  await expect(prepareShellFileChanges(options)).rejects.toThrow('FILE_CHANGES_PERMISSION')
  // Simulate the standalone tool after its normal one-use permission approval.
  expect((await runWithCwdOverride(root, () => TrackFileChangesTool.call({ file_paths: [path] }, context))).data.failed).toEqual([])
  await prepareShellFileChanges(options)
  await expect(prepareShellFileChanges({ ...options, fileChanges: { file_paths: [path, another] } })).rejects.toThrow('FILE_CHANGES_PERMISSION')
})

test('keeps explicitly disabled history compatible without false registration', async () => {
  process.env.CLAUDE_CODE_DISABLE_FILE_CHECKPOINTING = '1'
  await prepareShellFileChanges({ knownReadOnly: false, context, parentMessage: parent })
  await prepareShellFileChanges({ fileChanges: { file_paths: [join(root, 'none.txt')] }, knownReadOnly: false, context, parentMessage: parent })
  expect(state.trackedFiles.size).toBe(0)
})

test('does not run a command when a glob selects zero targets', async () => {
  await expect(BashTool.call({ command: 'exit 0', file_changes: { patterns: [{ base_dir: join(root, 'files'), include: ['*.missing'] }] } }, context, undefined, parent)).rejects.toThrow('FILE_CHANGES_EMPTY')
  expect(state.trackedFiles.size).toBe(0)
})

test('cancellation prevents even a read-only declaration from starting a command', async () => {
  context.abortController.abort()
  await expect(prepareShellFileChanges({ fileChanges: { read_only: true }, knownReadOnly: true, context, parentMessage: parent })).rejects.toThrow('cancelled')
  expect(state.trackedFiles.size).toBe(0)
})

test('does not reuse an old snapshot after permissions are checked in a new turn', async () => {
  const path = join(root, 'files', 'review.txt')
  await writeFile(path, 'before')
  await runWithCwdOverride(root, () => TrackFileChangesTool.call({ file_paths: [path] }, context))
  const permissions = getEmptyToolPermissionContext()
  permissions.alwaysAskRules = { userSettings: ['Read(**/review.txt)'] }
  context.getAppState = () => {
    state = { ...state, snapshots: [{ messageId: randomUUID() as UUID, trackedFileBackups: {}, timestamp: new Date() }] }
    return { toolPermissionContext: permissions } as ReturnType<ToolUseContext['getAppState']>
  }
  await expect(prepareShellFileChanges({ fileChanges: { file_paths: [path] }, knownReadOnly: false, context, parentMessage: parent })).rejects.toThrow('FILE_CHANGES_PERMISSION')
})
