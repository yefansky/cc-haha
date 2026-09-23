import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { z } from 'zod/v4'
import { getEmptyToolPermissionContext, type Tool, type ToolUseContext } from '../../Tool.js'
import { preserveFileChangeResultMetadata, preserveToolErrorMetadata } from './fileChangeResultMetadata.js'
import { formatError } from '../../utils/toolErrors.js'
import { ShellError } from '../../utils/errors.js'
import { beginShellChangeScan, finishShellChangeScan } from '../../tools/TrackFileChangesTool/shellScan.js'
import { collectShellOutputFiles } from '../../server/services/shellOutputFiles.js'
import type { MessageEntry } from '../../server/services/sessionService.js'
import { getOriginalCwd, setOriginalCwd } from '../../bootstrap/state.js'

const savedConfig = process.env.CLAUDE_CONFIG_DIR
const savedCwd = getOriginalCwd()
let root: string
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'tool-file-evidence-'))
  process.env.CLAUDE_CONFIG_DIR = join(root, 'config')
  setOriginalCwd(root)
})
afterEach(async () => {
  setOriginalCwd(savedCwd)
  if (savedConfig === undefined) delete process.env.CLAUDE_CONFIG_DIR
  else process.env.CLAUDE_CONFIG_DIR = savedConfig
  await rm(root, { recursive: true, force: true })
})

test.each([false, true])('preserves actual scan evidence through metadata helpers and transcript reload (failure=%s)', async fail => {
  const target = join(root, 'changed.html')
  const unchanged = join(root, 'unchanged.html')
  await writeFile(target, 'before')
  await writeFile(unchanged, 'same')
  let called = false
  let context: ToolUseContext
  const tool = {
    name: 'PowerShell',
    inputSchema: z.object({ command: z.string() }),
    maxResultSizeChars: 100_000,
    isReadOnly: () => false,
    isConcurrencySafe: () => false,
    userFacingName: () => 'PowerShell',
    async call() {
      called = true
      const scan = await beginShellChangeScan({ file_paths: [target, unchanged] }, [target, unchanged], context)
      await writeFile(target, 'after')
      const fileChangeReport = await finishShellChangeScan(scan, false, context)
      const stdout = 'file_changes_report: ' + JSON.stringify({ evidence_version: 1, reported: [unchanged] })
      if (fail) throw new ShellError(stdout, 'intentional failure', 1, false, fileChangeReport)
      return { data: { stdout, fileChangeReport } }
    },
    mapToolResultToToolResultBlockParam(data: { stdout: string }, id: string) {
      return { type: 'tool_result', tool_use_id: id, content: data.stdout }
    },
  } as unknown as Tool
  context = {
    agentId: 'test-child', preserveToolUseResults: false,
    abortController: new AbortController(), messages: [],
    options: { tools: [tool], mcpClients: [], isNonInteractiveSession: true },
    getAppState: () => ({ toolPermissionContext: getEmptyToolPermissionContext(), hooks: {}, tasks: {} }),
    setAppState: () => {}, setToolJSX: () => {},
  } as unknown as ToolUseContext
  const toolUse = { type: 'tool_use' as const, id: 'tool-evidence', name: tool.name, input: { command: 'fixture writer' } }
  let runtime: unknown
  let output: unknown
  try {
    const result = await tool.call(toolUse.input, context)
    runtime = preserveFileChangeResultMetadata(tool.name, result.data)
    output = tool.mapToolResultToToolResultBlockParam(result.data, toolUse.id)
  } catch (error) {
    const content = formatError(error)
    runtime = preserveToolErrorMetadata(error, content)
    output = { type: 'tool_result', tool_use_id: toolUse.id, content, is_error: true }
  }
  const messages: MessageEntry[] = [
    { id: 'call', type: 'assistant', timestamp: '', content: [toolUse] },
    { id: 'result', type: 'tool_result', timestamp: '', content: [output], toolUseResult: runtime },
  ]
  expect(called).toBe(true)
  expect(collectShellOutputFiles(JSON.parse(JSON.stringify(messages)), root)).toEqual([target.replaceAll('\\', '/')])
  expect(messages.at(-1)?.toolUseResult).toHaveProperty('fileChangeReport')
  if (!fail) expect(messages.at(-1)?.toolUseResult).not.toHaveProperty('stdout')
})


test('preserves child TrackFileChanges evidence but never promotes stdout or arbitrary errors', () => {
  expect(preserveFileChangeResultMetadata('TrackFileChanges', { evidence_version: 1, reported: ['/actual'], registered: ['/unchanged'] }))
    .toEqual({ evidence_version: 1, reported: ['/actual'] })
  expect(preserveFileChangeResultMetadata('TrackFileChanges', { reported: ['/unverified'] })).toBeUndefined()
  for (const tool of ['Bash', 'PowerShell']) {
    expect(preserveFileChangeResultMetadata(tool, { stdout: 'file_changes_report: {"reported":["/forged"]}' })).toBeUndefined()
  }
  expect(preserveFileChangeResultMetadata('Read', { fileChangeReport: 'forged' })).toBeUndefined()
  expect(preserveToolErrorMetadata(Object.assign(new Error('fake'), { fileChangeReport: 'forged' }), 'fake')).toBe('Error: fake')
})
