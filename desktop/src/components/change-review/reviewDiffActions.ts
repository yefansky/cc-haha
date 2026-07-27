import { parseWorkspaceDiff, type WorkspaceDiffRow } from '../workspace/workspaceDiffModel'

type ReviewHunk = {
  id: string
  oldLines: string[]
  newLines: string[]
}

function getReviewHunk(diff: string, filePath: string, hunkId: string): ReviewHunk | null {
  const file = parseWorkspaceDiff(diff).find((candidate) => (
    candidate.newPath === filePath || candidate.oldPath === filePath
  ))
  if (!file) return null

  const rows: WorkspaceDiffRow[] = file.rows.filter((row) => row.hunkId === hunkId)
  if (rows.length === 0) return null

  return {
    id: hunkId,
    oldLines: rows
      .filter((row) => row.kind === 'context' || row.kind === 'deletion')
      .map((row) => row.text),
    newLines: rows
      .filter((row) => row.kind === 'context' || row.kind === 'addition')
      .map((row) => row.text),
  }
}

function findUniqueLineSequence(lines: string[], needle: string[]): number | null {
  if (needle.length === 0 || needle.length > lines.length) return null
  let result: number | null = null
  for (let start = 0; start <= lines.length - needle.length; start += 1) {
    if (!needle.every((line, index) => lines[start + index] === line)) continue
    if (result !== null) return null
    result = start
  }
  return result
}

/**
 * Computes the file content after reverting just one review hunk. Matching is
 * intentionally exact and unique: stacked edits that moved or duplicated the
 * hunk must be refreshed instead of being overwritten by an unsafe rollback.
 */
export function buildHunkRevertContent(
  currentContent: string,
  diff: string,
  filePath: string,
  hunkId: string,
): string | null {
  const hunk = getReviewHunk(diff, filePath, hunkId)
  if (!hunk) return null

  const hasTrailingNewline = currentContent.endsWith('\n')
  const currentLines = currentContent.split('\n')
  if (hasTrailingNewline) currentLines.pop()

  const matchIndex = findUniqueLineSequence(currentLines, hunk.newLines)
  if (matchIndex === null) return null

  const nextLines = [
    ...currentLines.slice(0, matchIndex),
    ...hunk.oldLines,
    ...currentLines.slice(matchIndex + hunk.newLines.length),
  ]
  return `${nextLines.join('\n')}${hasTrailingNewline ? '\n' : ''}`
}
