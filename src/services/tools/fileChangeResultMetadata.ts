import { ShellError } from '../../utils/errors.js'

// Keep only runtime-generated change evidence when child agents omit raw tool
// results. Console output is intentionally never promoted into this metadata.
export function preserveFileChangeResultMetadata(toolName: string, result: unknown): unknown {
  if (!result || typeof result !== 'object') return undefined
  if ((toolName === 'Bash' || toolName === 'PowerShell') && 'fileChangeReport' in result &&
    typeof result.fileChangeReport === 'string') {
    return { fileChangeReport: result.fileChangeReport }
  }
  if (toolName === 'TrackFileChanges' && 'evidence_version' in result &&
    result.evidence_version === 1 && 'reported' in result && Array.isArray(result.reported)) {
    return { evidence_version: 1, reported: result.reported }
  }
  return undefined
}

export function preserveToolErrorMetadata(error: unknown, content: string): unknown {
  if (error instanceof ShellError && error.fileChangeReport) {
    return { error: content, fileChangeReport: error.fileChangeReport }
  }
  return `Error: ${content}`
}
