import { expandPath } from '../../utils/path.js'
import type { ToolUseContext } from '../../Tool.js'
import { resolveTrackingPaths, type TrackingPathInput } from './batchPaths.js'
import { baselineForPath, fingerprint, rememberShellBaseline, type Fingerprint } from './verification.js'

export type ShellChangeScan = {
  targets: TrackingPathInput
  before: Map<string, Fingerprint | null>
  startedAt: string
  finishedAt?: string
}

// Internal handoff avoids a second traversal/hash pass when the shell has just
// invoked TrackFileChanges. Nothing is serialized into model-visible output.
const registrationScans = new WeakMap<object, ShellChangeScan>()
export function cacheRegistrationScan(data: object, scan: ShellChangeScan | undefined): void {
  if (scan) registrationScans.set(data, scan)
}
export function takeRegistrationScan(data: object): ShellChangeScan | undefined {
  const scan = registrationScans.get(data)
  registrationScans.delete(data)
  return scan
}

export async function beginShellChangeScan(targets: TrackingPathInput, registered: string[], context?: ToolUseContext, completeScopeResolved = false): Promise<ShellChangeScan | undefined> {
  const before = new Map<string, Fingerprint | null>()
  const paths = new Set(registered)
  if (targets.patterns?.length && !completeScopeResolved) {
    const { checkReadPermissionForTool } = await import('../../utils/permissions/filesystem.js')
    const { FileReadTool } = await import('../FileReadTool/FileReadTool.js')
    const resolved = await resolveTrackingPaths({ patterns: targets.patterns }, { checkPath: async path => {
      if (!context) return { allowed: true }
      const decision = checkReadPermissionForTool(FileReadTool, { file_path: path }, context.getAppState().toolPermissionContext)
      return { allowed: decision.behavior === 'allow', reason: decision.behavior === 'allow' ? undefined : decision.message }
    } })
    if (resolved.failed.length || resolved.truncated) throw new Error('Cannot establish a complete scope baseline: ' + JSON.stringify(resolved))
    for (const path of resolved.filePaths) paths.add(path)
  }
  for (const path of paths) before.set(path, await fingerprint(path))
  const scan = { targets: {
    file_paths: [...paths],
    patterns: targets.patterns?.map(pattern => ({ ...pattern, base_dir: expandPath(pattern.base_dir) })),
  }, before, startedAt: new Date().toISOString() }
  if (context) rememberShellBaseline(scan, context)
  return scan
}

export async function finishShellChangeScan(scan: ShellChangeScan | undefined, background: boolean, context: ToolUseContext): Promise<string> {
  if (!scan) return ''
  rememberShellBaseline(scan, context)
  if (background) return 'FILE_CHANGES_SCAN_PENDING: The command is still running. After completion, reconcile the declared patterns and report new/deleted paths with TrackFileChanges mode="report" or its completion manifest; the inventory is not complete yet.'
  try {
    const { checkReadPermissionForTool } = await import('../../utils/permissions/filesystem.js')
    const { FileReadTool } = await import('../FileReadTool/FileReadTool.js')
    const resolved = await resolveTrackingPaths(scan.targets, { checkPath: async path => {
      const decision = checkReadPermissionForTool(FileReadTool, { file_path: path }, context.getAppState().toolPermissionContext)
      return { allowed: decision.behavior === 'allow', reason: decision.behavior === 'allow' ? undefined : decision.message }
    } })
    const reported: string[] = []
    const unverified: Array<{ path: string; reason: string }> = []
    for (const path of resolved.filePaths) {
      try {
        const before = baselineForPath(scan, path)
        if (before === undefined) { unverified.push({ path, reason: 'No pre-write baseline for this path' }); continue }
        const after = await fingerprint(path)
        if ((after?.digest ?? null) !== (before?.digest ?? null)) reported.push(path)
      } catch (error) { resolved.failed.push({ path, reason: String(error) }) }
    }
    return 'file_changes_report: ' + JSON.stringify({ evidence_version: 1, reported, unverified, registered: [], failed: resolved.failed, truncated: resolved.truncated, command_window_start: scan.startedAt, command_window_end: scan.finishedAt, scan_completed_at: new Date().toISOString() })
      + (resolved.failed.length || resolved.truncated || unverified.length ? '\nFILE_CHANGES_REPORT_INCOMPLETE: Scan was incomplete. Narrow or split the scope and reconcile the actual changes without rerunning the writer.' : '')
  } catch (error) { return 'FILE_CHANGES_REPORT_INCOMPLETE: ' + String(error) }
}
