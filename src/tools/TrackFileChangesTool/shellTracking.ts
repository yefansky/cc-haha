import { isAbsolute, resolve } from 'node:path'

import type { ToolUseContext } from '../../Tool.js'
import type { AssistantMessage } from '../../types/message.js'
import { getOriginalCwd } from '../../bootstrap/state.js'
import { expandPath } from '../../utils/path.js'
import { fileHistoryEnabled } from '../../utils/fileHistory.js'
import { shellFileChangesSchema, type ShellFileChanges } from './trackingSchema.js'
export { shellFileChangesSchema } from './trackingSchema.js'

export async function prepareShellFileChanges(options: {
  fileChanges?: ShellFileChanges
  knownReadOnly: boolean
  context: ToolUseContext
  parentMessage?: AssistantMessage
}): Promise<void> {
  if (!fileHistoryEnabled()) return
  const { context } = options
  const checkCancelled = () => {
    if (context.abortController?.signal.aborted) throw new Error('File-change registration cancelled; command was NOT executed.')
  }
  checkCancelled()
  // Tracking is an optional recovery facility, not a second command permission
  // system. A classifier's "unknown" does not prove a command modifies files.
  // Keep explicit registration fail-closed, without blocking ordinary commands.
  if (options.fileChanges === undefined) return
  const declaration = shellFileChangesSchema.parse(options.fileChanges)
  if ('read_only' in declaration) return
  const { TrackFileChangesTool } = await import('./TrackFileChangesTool.js')
  const decision = await TrackFileChangesTool.checkPermissions(declaration, context)
  checkCancelled()
  const key = (path: string) => {
    const expanded = expandPath(path)
    const absolute = isAbsolute(expanded) ? resolve(expanded) : resolve(getOriginalCwd(), expanded)
    return process.platform === 'win32' ? absolute.toLowerCase() : absolute
  }
  // A standalone TrackFileChanges may have obtained one-use read approval.
  // Already backed-up explicit targets need no second read or new permission UI.
  let trackedPaths: string[] = []
  if (decision.behavior === 'ask') context.updateFileHistoryState(state => {
    trackedPaths = Object.entries(state.snapshots.at(-1)?.trackedFileBackups ?? {}).filter(([, backup]) => Boolean(backup)).map(([path]) => path)
    return state
  })
  if (decision.behavior === 'ask' && !declaration.patterns?.length && declaration.file_paths?.length
    && declaration.file_paths.every(path => trackedPaths.some(tracked => key(tracked) === key(path)))) return
  if (decision.behavior !== 'allow') {
    throw new Error('FILE_CHANGES_PERMISSION: Command was NOT executed. First use TrackFileChanges to obtain read permission and register the targets, then retry with its registered paths in file_changes.file_paths. Denied targets cannot be registered.')
  }
  const result = await TrackFileChangesTool.call(declaration, context)
  if (!result.data.registered.length && !result.data.failed.length && !result.data.truncated) {
    throw new Error('FILE_CHANGES_EMPTY: Command was NOT executed. No targets matched. Correct the glob or provide explicit file_paths for files that will be created.')
  }
  if (result.data.failed.length || result.data.truncated) {
    throw new Error(`FILE_CHANGES_INCOMPLETE: Command was NOT executed. Correct registration targets and retry. ${JSON.stringify(result.data)}`)
  }
  checkCancelled()
}
