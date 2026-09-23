import { verifyReportedPaths } from './verification.js'
import { lstat } from 'node:fs/promises'
import { isAbsolute } from 'node:path'
import { expandPath } from '../../utils/path.js'
import type { ToolUseContext } from '../../Tool.js'
import { resolveTrackingPaths } from './batchPaths.js'
import { checkReadPermissionForTool } from '../../utils/permissions/filesystem.js'
import { FileReadTool } from '../FileReadTool/FileReadTool.js'


export async function prepareShellChangeManifest(manifest: string | undefined): Promise<void> {
  if (!manifest) return
  if (!isAbsolute(manifest)) throw new Error('file_changes_manifest must be an absolute path. Command was NOT executed.')
  try { await lstat(expandPath(manifest)) } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
    throw error
  }
  throw new Error('file_changes_manifest already exists. Use a fresh unique path for each command, or TrackFileChanges mode="report" to recover an earlier result. Command was NOT executed.')
}

export async function finishShellFileChanges(manifest: string | undefined, background: boolean, context: ToolUseContext, commandWindow?: { startedAt: string; finishedAt: string }): Promise<string> {
  if (!manifest) return ''
  if (background) return `File-change manifest pending: ${manifest}. After the background task finishes (including failure), call TrackFileChanges with mode="report" and manifest_path=${JSON.stringify(manifest)}. Do not claim the file list is complete yet.`
  try {
    const resolved = await resolveTrackingPaths({ manifest_path: manifest }, { checkPath: async path => {
      const decision = checkReadPermissionForTool(FileReadTool, { file_path: expandPath(path) }, context.getAppState().toolPermissionContext)
      return { allowed: decision.behavior === 'allow', reason: decision.behavior === 'allow' ? undefined : decision.message }
    } })
    const verified = await verifyReportedPaths(resolved.filePaths, context)
    const data = { evidence_version: 1, registered: [], ...verified, failed: [...resolved.failed, ...verified.failed], truncated: resolved.truncated, command_window_start: commandWindow?.startedAt, command_window_end: commandWindow?.finishedAt }
    return 'file_changes_report: ' + JSON.stringify(data) + (data.failed.length || data.truncated || data.unverified.length ? '\nFILE_CHANGES_REPORT_INCOMPLETE: Some candidates could not be verified. Missing pre-write baselines cannot be recovered by registering after writing. Keep these paths unverified; do not rerun the modifying command. For future writes declare file_changes.file_paths or narrow patterns before execution.' : '')
  } catch (error) {
    return 'FILE_CHANGES_REPORT_INCOMPLETE: ' + String(error) + '. Retry TrackFileChanges mode="report", not the modifying command.'
  }
}
