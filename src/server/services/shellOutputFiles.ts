import path from 'node:path'
import type { MessageEntry } from './sessionService.js'

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

// stdout, stderr and model-visible tool content are untrusted. Only runtime
// metadata may carry verified changes; the version excludes old, unverified
// manifest/report results already persisted in transcripts.
export function collectShellOutputFiles(messages: MessageEntry[], _workDir: string): string[] {
  const calls = new Map<string, string>()
  for (const message of messages) {
    if (!['assistant', 'tool_use'].includes(message.type) || !Array.isArray(message.content)) continue
    for (const block of message.content) {
      if (block?.type === 'tool_use' && typeof block.id === 'string' &&
        /^(Bash|PowerShell|TrackFileChanges)$/i.test(block.name ?? '')) {
        calls.set(block.id, block.name.toLowerCase())
      }
    }
  }
  const files = new Map<string, string>()
  const addReport = (value: unknown) => {
    const data = record(value)
    if (data?.evidence_version !== 1 || !Array.isArray(data.reported)) return
    for (const file of data.reported) {
      if (typeof file !== 'string' || /[\x00-\x1f]/.test(file) || /^(?:[\\/]{2}|[a-z]+:\/\/)/i.test(file)) continue
      const windows = /^[a-z]:[\\/]/i.test(file)
      const paths = windows ? path.win32 : path.posix
      if (!paths.isAbsolute(file)) continue
      const normalized = paths.normalize(file).replace(/\\/g, '/')
      const key = windows ? normalized.toLowerCase() : normalized
      if (!files.has(key)) files.set(key, normalized)
    }
  }
  for (const message of messages) {
    if (message.type !== 'tool_result' || !Array.isArray(message.content)) continue
    // toolUseResult belongs to one execution, never to arbitrary sibling blocks.
    const results = message.content.filter(block => block?.type === 'tool_result')
    if (results.length !== 1) continue
    const tool = calls.get(results[0].tool_use_id)
    const data = record(message.toolUseResult)
    if (!tool || !data) continue
    if (tool === 'trackfilechanges') {
      addReport(data)
    } else if (typeof data.fileChangeReport === 'string') {
      for (const line of data.fileChangeReport.split(/\r?\n/)) {
        if (!line.startsWith('file_changes_report: ')) continue
        try { addReport(JSON.parse(line.slice('file_changes_report: '.length))) }
        catch { /* Incomplete or malformed runtime metadata is not evidence. */ }
      }
    }
  }
  return [...files.values()]
}
