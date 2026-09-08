import { isAbsolute, resolve } from 'node:path'
import { z } from 'zod/v4'
import { getOriginalCwd } from '../../bootstrap/state.js'
import { buildTool, type ToolDef, type ToolUseContext } from '../../Tool.js'
import { fileHistoryEnabled, fileHistoryTrackEdit, type FileHistoryState } from '../../utils/fileHistory.js'
import { expandPath } from '../../utils/path.js'
import { checkReadPermissionForTool } from '../../utils/permissions/filesystem.js'
import type { PermissionDecision } from '../../utils/permissions/PermissionResult.js'
import { FileReadTool } from '../FileReadTool/FileReadTool.js'
import { resolveTrackingPaths } from './batchPaths.js'
import { TRACK_FILE_CHANGES_PROMPT, TRACK_FILE_CHANGES_TOOL_NAME } from './prompt.js'

const inputSchema = z.object({
  file_paths: z.array(z.string().min(1)).max(1000).optional(),
  patterns: z.array(z.object({
    base_dir: z.string().min(1),
    include: z.array(z.string().min(1)).min(1),
    exclude: z.array(z.string().min(1)).optional(),
  })).max(100).optional(),
}).refine(input => Boolean(input.file_paths?.length || input.patterns?.length), 'Provide file_paths or patterns')

type Input = z.infer<typeof inputSchema>
type Output = {
  registered: string[]
  failed: Array<{ path: string, reason: string }>
  truncated: boolean
}

function readDecision(path: string, context: ToolUseContext): PermissionDecision {
  return checkReadPermissionForTool(FileReadTool, { file_path: expandPath(path) }, context.getAppState().toolPermissionContext)
}

function historyState(context: ToolUseContext): FileHistoryState | undefined {
  let captured: FileHistoryState | undefined
  context.updateFileHistoryState(state => { captured = state; return state })
  return captured
}

function pathIdentity(path: string): string {
  const absolute = isAbsolute(path) ? resolve(path) : resolve(getOriginalCwd(), path)
  return process.platform === 'win32' ? absolute.toLowerCase() : absolute
}

export const TrackFileChangesTool = buildTool({
  name: TRACK_FILE_CHANGES_TOOL_NAME,
  searchHint: 'register script shell file changes before execution',
  maxResultSizeChars: 100_000,
  strict: true,
  alwaysLoad: true,
  inputSchema,
  async description() { return 'Register target files and preserve their contents before external modifications' },
  async prompt() { return TRACK_FILE_CHANGES_PROMPT },
  userFacingName() { return 'Track file changes' },
  isReadOnly() { return true },
  isConcurrencySafe() { return false },
  toAutoClassifierInput(input) { return JSON.stringify(input) },
  renderToolUseMessage(input) { return `${input.file_paths?.length ?? 0} files, ${input.patterns?.length ?? 0} patterns` },
  backfillObservableInput(input) {
    if (input.file_paths) input.file_paths = input.file_paths.map(path => expandPath(path))
    if (input.patterns) input.patterns = input.patterns.map(pattern => ({ ...pattern, base_dir: expandPath(pattern.base_dir) }))
  },
  async checkPermissions(input, context): Promise<PermissionDecision> {
    let blocked: PermissionDecision | undefined
    await resolveTrackingPaths(input, { checkPath: async path => {
      const decision = readDecision(path, context)
      if (decision.behavior !== 'allow' && (blocked?.behavior !== 'deny')) blocked = decision
      return { allowed: decision.behavior === 'allow', reason: decision.behavior === 'allow' ? undefined : decision.message }
    } })
    return blocked ?? { behavior: 'allow', updatedInput: input }
  },
  async call(input: Input, context: ToolUseContext): Promise<{ data: Output }> {
    const resolved = await resolveTrackingPaths(input, { checkPath: async path => {
      const decision = readDecision(path, context)
      return { allowed: decision.behavior !== 'deny', reason: decision.behavior === 'deny' ? decision.message : undefined }
    } })
    const data: Output = { registered: [], failed: [...resolved.failed], truncated: resolved.truncated }
    const snapshot = historyState(context)?.snapshots.at(-1)
    const unavailable = !fileHistoryEnabled() ? 'File history is disabled' : !snapshot ? 'No active file-history snapshot' : undefined
    for (const path of resolved.filePaths) {
      if (unavailable) { data.failed.push({ path, reason: unavailable }); continue }
      const decision = readDecision(path, context)
      if (decision.behavior === 'deny') { data.failed.push({ path, reason: decision.message }); continue }
      try {
        await fileHistoryTrackEdit(context.updateFileHistoryState, path, snapshot!.messageId)
        const latest = historyState(context)?.snapshots.at(-1)
        const saved = latest?.messageId === snapshot!.messageId && Object.entries(latest.trackedFileBackups)
          .some(([key, backup]) => Boolean(backup) && pathIdentity(key) === pathIdentity(path))
        if (saved) data.registered.push(path)
        else data.failed.push({ path, reason: 'Could not preserve a backup in the active snapshot' })
      } catch {
        data.failed.push({ path, reason: 'Could not preserve a backup in the active snapshot' })
      }
    }
    return { data }
  },
  mapToolResultToToolResultBlockParam(data, toolUseID) {
    return { type: 'tool_result', tool_use_id: toolUseID, content: JSON.stringify(data), is_error: data.failed.length > 0 || data.truncated }
  },
} satisfies ToolDef<typeof inputSchema, Output>)
