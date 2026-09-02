import type { WorkspaceComparison, WorkspaceComparisonSide } from '@/api/sessions'
import {
  parseWorkspaceDiff,
  type WorkspaceDiffFile,
  type WorkspaceDiffRow,
  type WorkspaceDiffRowKind,
  type WorkspaceDiffSide,
} from './workspaceDiffModel'
import type { WorkspaceManualAlignmentAnchor } from './workspaceManualAlignment'
import type { WorkspaceComparisonTextPair } from './workspaceComparisonInput'
import { prepareWorkspaceComparisonInputs, type PreparedWorkspaceComparisonLine } from './workspaceComparisonLanguage'
import {
  createDefaultWorkspaceComparisonSettings,
  type WorkspaceComparisonSettings,
} from './workspaceComparisonSettings'
import { solveWorkspaceAlignment, type WorkspaceAlignmentDiagnostic } from './workspaceAlignmentSolver'

export type WorkspaceSideBySideRowKind = 'metadata' | 'hunk' | 'context' | 'change' | 'existence'
export type WorkspaceSideBySideViewMode = 'all' | 'differences' | 'context' | 'same'
export type WorkspaceFullViewUnavailableReason =
  | 'patch_only'
  | 'binary'
  | 'undecodable'
  | 'too_large'
  | 'unavailable'
  | 'incomplete'

export interface WorkspaceSideBySideRow {
  id: string
  kind: WorkspaceSideBySideRowKind
  hunkId: string | null
  manualAnchorId?: string
  left: WorkspaceDiffRow | null
  right: WorkspaceDiffRow | null
  equivalenceReason?: 'settings'
  lineEndingDifference?: { left: string; right: string }
}

export interface WorkspaceSideBySideDiffSection {
  id: string
  fileId: string
  rowIds: string[]
  startRowIndex: number
  endRowIndex: number
  sourceGroupId: string | null
  existenceOnly: boolean
  manualAnchorId?: string
}

export interface WorkspaceSideBySideFile {
  id: string
  oldPath: string | null
  newPath: string | null
  source: WorkspaceDiffFile
  rows: WorkspaceSideBySideRow[]
  sections: WorkspaceSideBySideDiffSection[]
  complete: boolean
}

export interface WorkspaceSideBySideModel {
  kind: 'comparison' | 'patch'
  files: WorkspaceSideBySideFile[]
  sections: WorkspaceSideBySideDiffSection[]
  fullViewUnavailableReason: WorkspaceFullViewUnavailableReason | null
  diagnostics: {
    alignment: WorkspaceAlignmentDiagnostic[]
    comparison: string[]
  }
}

export type WorkspaceSideBySideViewItem =
  | { id: string; kind: 'row'; row: WorkspaceSideBySideRow }
  | { id: string; kind: 'separator'; hiddenCount: number | null }

type ContentLine = Pick<PreparedWorkspaceComparisonLine, 'text' | 'ending' | 'lineNumber' | 'comparisonEnding'>

function splitSvnDiff(value: string) {
  const lines = value.split('\n')
  const starts = lines.reduce<number[]>((indexes, line, index) => {
    if (line.startsWith('Index: ')) indexes.push(index)
    return indexes
  }, [])
  if (starts.length === 0 || value.includes('diff --git ')) return [value]

  return starts.map((start, index) => {
    const path = lines[start]!.slice('Index: '.length).trim()
    const end = starts[index + 1] ?? lines.length
    const body = lines.slice(start, end).join('\n')
    return `diff --git a/${path} b/${path}\n${body}`
  })
}

function contentRows(file: WorkspaceSideBySideFile) {
  return file.rows.filter((row) => (
    row.kind === 'context' || row.kind === 'change' || row.kind === 'existence'
  ))
}

function buildSections(fileId: string, rows: WorkspaceSideBySideRow[]) {
  const sections: WorkspaceSideBySideDiffSection[] = []
  let index = 0
  while (index < rows.length) {
    const row = rows[index]!
    if (row.kind === 'existence') {
      sections.push({
        id: `${fileId}-section-existence`,
        fileId,
        rowIds: [row.id],
        startRowIndex: index,
        endRowIndex: index,
        sourceGroupId: null,
        existenceOnly: true,
      })
      index += 1
      continue
    }
    if (row.kind !== 'change') {
      index += 1
      continue
    }
    const start = index
    const sourceGroupId = row.hunkId
    const manualAnchorId = row.manualAnchorId
    const sectionRows: WorkspaceSideBySideRow[] = []
    while (index < rows.length) {
      const candidate = rows[index]!
      if (
        candidate.kind !== 'change'
        || candidate.hunkId !== sourceGroupId
        || candidate.manualAnchorId !== manualAnchorId
      ) break
      sectionRows.push(candidate)
      index += 1
    }
    const first = sectionRows[0]!
    const leftLine = first.left?.oldLine ?? 0
    const rightLine = first.right?.newLine ?? 0
    sections.push({
      id: manualAnchorId
        ? `${fileId}-section-anchor-${manualAnchorId}`
        : `${fileId}-section-${leftLine}-${rightLine}-${sections.length}`,
      fileId,
      rowIds: sectionRows.map((candidate) => candidate.id),
      startRowIndex: start,
      endRowIndex: index - 1,
      sourceGroupId,
      existenceOnly: false,
      ...(manualAnchorId ? { manualAnchorId } : {}),
    })
  }
  return sections
}

function withSections(file: Omit<WorkspaceSideBySideFile, 'sections'>): WorkspaceSideBySideFile {
  const rows = contentRows(file as WorkspaceSideBySideFile)
  const sections = buildSections(file.id, rows)
  if (file.complete) {
    const sectionIdByRowId = new Map(sections.flatMap((section) => (
      section.rowIds.map((rowId) => [rowId, section.id] as const)
    )))
    for (const row of file.rows) {
      const sectionId = sectionIdByRowId.get(row.id)
      if (!sectionId) continue
      row.hunkId = sectionId
      if (row.left) row.left.hunkId = sectionId
      if (row.right) row.right.hunkId = sectionId
    }
    for (const section of sections) section.sourceGroupId = section.id
  }
  return { ...file, sections }
}

function pairFile(file: WorkspaceDiffFile): WorkspaceSideBySideFile {
  const normalizedRows = file.rows.map((row) => {
    if (row.kind !== 'metadata' || row.hunkId !== null) return row
    if (row.text.startsWith('+') && !row.text.startsWith('+++ ')) {
      return { ...row, kind: 'addition' as const, text: row.text.slice(1), prefix: '+', side: 'new' as const }
    }
    if (row.text.startsWith('-') && !row.text.startsWith('--- ')) {
      return { ...row, kind: 'deletion' as const, text: row.text.slice(1), prefix: '-', side: 'old' as const }
    }
    return row
  })
  const normalizedFile = normalizedRows === file.rows ? file : { ...file, rows: normalizedRows }
  const rows: WorkspaceSideBySideRow[] = []
  let index = 0

  while (index < normalizedFile.rows.length) {
    const row = normalizedFile.rows[index]!
    if (row.kind === 'deletion' || row.kind === 'addition') {
      const deletions: WorkspaceDiffRow[] = []
      const additions: WorkspaceDiffRow[] = []
      const hunkId = row.hunkId
      while (index < normalizedFile.rows.length) {
        const candidate = normalizedFile.rows[index]!
        if (candidate.hunkId !== hunkId) break
        if (candidate.kind === 'deletion') deletions.push(candidate)
        else if (candidate.kind === 'addition') additions.push(candidate)
        else break
        index += 1
      }
      const count = Math.max(deletions.length, additions.length)
      for (let pairIndex = 0; pairIndex < count; pairIndex += 1) {
        rows.push({
          id: `${file.id}-pair-${rows.length}`,
          kind: 'change',
          hunkId,
          left: deletions[pairIndex] ?? null,
          right: additions[pairIndex] ?? null,
        })
      }
      continue
    }

    rows.push({
      id: `${file.id}-pair-${rows.length}`,
      kind: row.kind === 'hunk' ? 'hunk' : row.kind === 'context' ? 'context' : 'metadata',
      hunkId: row.hunkId,
      left: row,
      right: row,
    })
    index += 1
  }

  return withSections({
    id: file.id,
    oldPath: file.oldPath,
    newPath: file.newPath,
    source: normalizedFile,
    rows,
    complete: false,
  })
}

function remapFileIdentity(file: WorkspaceDiffFile, fileIndex: number): WorkspaceDiffFile {
  const id = `file-${fileIndex}`
  const hunkIds = new Map<string, string>()
  return {
    ...file,
    id,
    rows: file.rows.map((row, rowIndex) => {
      let hunkId: string | null = null
      if (row.hunkId) {
        const mappedHunkId = hunkIds.get(row.hunkId) ?? `${id}-hunk-${hunkIds.size}`
        hunkIds.set(row.hunkId, mappedHunkId)
        hunkId = mappedHunkId
      }
      return {
        ...row,
        id: `${id}-row-${rowIndex}`,
        hunkId,
      }
    }),
  }
}

export function parseWorkspaceSideBySideDiff(value: string): WorkspaceSideBySideFile[] {
  if (!value) return []
  return splitSvnDiff(value)
    .flatMap((segment) => parseWorkspaceDiff(segment))
    .map(remapFileIdentity)
    .map(pairFile)
}

function createSourceRow(
  fileId: string,
  side: WorkspaceDiffSide,
  line: ContentLine,
  kind: WorkspaceDiffRowKind,
  hunkId: string | null,
): WorkspaceDiffRow {
  return {
    id: `${fileId}-${side}-${line.lineNumber}-${kind}`,
    kind,
    text: line.text,
    prefix: kind === 'deletion' ? '-' : kind === 'addition' ? '+' : ' ',
    hunkId,
    oldLine: side === 'old' ? line.lineNumber : null,
    newLine: side === 'new' ? line.lineNumber : null,
    side,
    selectable: true,
  }
}

function createPairId(fileId: string, left: ContentLine | null, right: ContentLine | null) {
  return `${fileId}-row-${left?.lineNumber ?? 'x'}-${right?.lineNumber ?? 'x'}`
}

function completeContent(side: WorkspaceComparisonSide) {
  if (side.state === 'missing') return side.exists ? null : ''
  if (side.state === 'ok' && side.exists && typeof side.content === 'string') return side.content
  return null
}

function buildCompleteTextPairFile(
  textPair: WorkspaceComparisonTextPair,
  existence: { left: boolean; right: boolean },
  paths: { left: string; right: string },
  path: string,
  manualAnchors: WorkspaceManualAlignmentAnchor[],
  settings: WorkspaceComparisonSettings,
): { file: WorkspaceSideBySideFile; alignment: WorkspaceAlignmentDiagnostic[]; comparison: string[] } | null {
  const fileId = 'comparison-file-0'
  const prepared = prepareWorkspaceComparisonInputs(textPair.left.content, textPair.right.content, settings)
  const leftLines = prepared.left.map((line) => ({
    ...line,
    lineNumber: line.lineNumber + textPair.left.lineStart - 1,
  }))
  const rightLines = prepared.right.map((line) => ({
    ...line,
    lineNumber: line.lineNumber + textPair.right.lineStart - 1,
  }))
  const rows: WorkspaceSideBySideRow[] = []
  const validAnchors = manualAnchors
    .filter((anchor) => (
      anchor.state === 'valid'
      && anchor.left.lineNumber >= 1
      && anchor.left.lineNumber >= textPair.left.lineStart
      && anchor.left.lineNumber < textPair.left.lineStart + leftLines.length
      && anchor.right.lineNumber >= 1
      && anchor.right.lineNumber >= textPair.right.lineStart
      && anchor.right.lineNumber < textPair.right.lineStart + rightLines.length
    ))
    .sort((left, right) => left.left.lineNumber - right.left.lineNumber)
    .filter((anchor, index, sorted) => index === 0 || (
      sorted[index - 1]!.left.lineNumber < anchor.left.lineNumber
      && sorted[index - 1]!.right.lineNumber < anchor.right.lineNumber
    ))
  const alignment = solveWorkspaceAlignment(
    leftLines,
    rightLines,
    validAnchors.map((anchor) => ({
      id: anchor.id,
      leftIndex: anchor.left.lineNumber - textPair.left.lineStart,
      rightIndex: anchor.right.lineNumber - textPair.right.lineStart,
    })),
    settings.profile,
  )
  for (const pair of alignment.pairs) {
    const left = pair.leftIndex === null ? null : leftLines[pair.leftIndex]!
    const right = pair.rightIndex === null ? null : rightLines[pair.rightIndex]!
    const rawEqual = Boolean(left && right && left.text === right.text && left.ending === right.ending)
    const equivalent = Boolean(
      left
      && right
      && left.equivalenceKey === right.equivalenceKey
      && left.comparisonEnding === right.comparisonEnding,
    )
    const equal = pair.hardAnchorId ? rawEqual : equivalent
    const anchorGroupId = pair.hardAnchorId ? `${fileId}-anchor-group-${pair.hardAnchorId}` : null
    rows.push({
      id: pair.hardAnchorId ? `${fileId}-anchor-${pair.hardAnchorId}` : createPairId(fileId, left, right),
      kind: equal ? 'context' : 'change',
      hunkId: equal ? null : anchorGroupId,
      ...(pair.hardAnchorId ? { manualAnchorId: pair.hardAnchorId } : {}),
      ...(equivalent && !rawEqual ? { equivalenceReason: 'settings' as const } : {}),
      ...(left && right && left.text === right.text && left.ending !== right.ending
        ? { lineEndingDifference: { left: left.ending, right: right.ending } }
        : {}),
      left: left ? createSourceRow(fileId, 'old', left, equal ? 'context' : 'deletion', equal ? `${fileId}-same` : anchorGroupId) : null,
      right: right ? createSourceRow(fileId, 'new', right, equal ? 'context' : 'addition', equal ? `${fileId}-same` : anchorGroupId) : null,
    })
  }

  if (rows.length === 0 && existence.left !== existence.right) {
    rows.push({
      id: `${fileId}-row-existence`,
      kind: 'existence',
      hunkId: null,
      left: null,
      right: null,
    })
  }

  const oldPath = paths.left || path
  const newPath = paths.right || path
  const sourceRows = rows.flatMap((row) => [row.left, row.right].filter((candidate): candidate is WorkspaceDiffRow => Boolean(candidate)))
  return { file: withSections({
    id: fileId,
    oldPath,
    newPath,
    source: { id: fileId, oldPath, newPath, rows: sourceRows },
    rows,
    complete: true,
  }), alignment: alignment.diagnostics, comparison: prepared.diagnostics }
}

function buildComparisonFile(
  comparison: WorkspaceComparison,
  path: string,
  manualAnchors: WorkspaceManualAlignmentAnchor[],
  settings: WorkspaceComparisonSettings,
) {
  const leftContent = completeContent(comparison.left)
  const rightContent = completeContent(comparison.right)
  if (leftContent === null || rightContent === null) return null
  return buildCompleteTextPairFile(
    {
      left: { content: leftContent, lineStart: 1 },
      right: { content: rightContent, lineStart: 1 },
    },
    { left: comparison.left.exists, right: comparison.right.exists },
    { left: comparison.left.source.path, right: comparison.right.source.path },
    path,
    manualAnchors,
    settings,
  )
}

function unavailableReason(comparison?: WorkspaceComparison): WorkspaceFullViewUnavailableReason {
  if (!comparison) return 'patch_only'
  const blockingState = [comparison.left.state, comparison.right.state].find((state) => (
    state !== 'ok' && state !== 'missing'
  ))
  if (blockingState === 'binary') return 'binary'
  if (blockingState === 'undecodable') return 'undecodable'
  if (blockingState === 'too_large') return 'too_large'
  if (blockingState === 'unavailable') return 'unavailable'
  return 'incomplete'
}

export function buildWorkspaceSideBySideModel(
  value: string,
  comparison: WorkspaceComparison | undefined,
  path: string,
  manualAnchors: WorkspaceManualAlignmentAnchor[] = [],
  settings: WorkspaceComparisonSettings = createDefaultWorkspaceComparisonSettings(path),
): WorkspaceSideBySideModel {
  const comparisonResult = comparison ? buildComparisonFile(comparison, path, manualAnchors, settings) : null
  if (comparisonResult) {
    return {
      kind: 'comparison',
      files: [comparisonResult.file],
      sections: comparisonResult.file.sections,
      fullViewUnavailableReason: null,
      diagnostics: { alignment: comparisonResult.alignment, comparison: comparisonResult.comparison },
    }
  }
  const files = parseWorkspaceSideBySideDiff(value)
  return {
    kind: 'patch',
    files,
    sections: files.flatMap((file) => file.sections),
    fullViewUnavailableReason: unavailableReason(comparison),
    diagnostics: { alignment: [], comparison: [] },
  }
}

export function buildWorkspaceSideBySideTextPairModel(
  textPair: WorkspaceComparisonTextPair,
  path: string,
  settings: WorkspaceComparisonSettings = createDefaultWorkspaceComparisonSettings(path),
): WorkspaceSideBySideModel {
  const result = buildCompleteTextPairFile(
    textPair,
    { left: true, right: true },
    { left: path, right: path },
    path,
    [],
    settings,
  )
  if (!result) {
    return {
      kind: 'patch',
      files: [],
      sections: [],
      fullViewUnavailableReason: 'patch_only',
      diagnostics: { alignment: [], comparison: [] },
    }
  }
  return {
    kind: 'patch',
    files: [result.file],
    sections: result.file.sections,
    fullViewUnavailableReason: 'patch_only',
    diagnostics: { alignment: result.alignment, comparison: result.comparison },
  }
}

export function summarizeWorkspaceSideBySideModel(model: WorkspaceSideBySideModel) {
  let additions = 0
  let deletions = 0
  for (const file of model.files) {
    for (const row of file.rows) {
      if (row.kind !== 'change') continue
      if (row.left) deletions += 1
      if (row.right) additions += 1
    }
  }
  return { additions, deletions }
}

function selectedIndexes(
  rows: WorkspaceSideBySideRow[],
  sections: WorkspaceSideBySideDiffSection[],
  mode: WorkspaceSideBySideViewMode,
  contextLines: number,
  complete: boolean,
) {
  if (mode === 'all') return rows.map((_, index) => index)
  if (mode === 'differences') return rows.flatMap((row, index) => (
    row.kind === 'change' || row.kind === 'existence' ? [index] : []
  ))
  if (mode === 'same') return rows.flatMap((row, index) => row.kind === 'context' ? [index] : [])

  const indexes = new Set<number>()
  for (const section of sections) {
    const start = Math.max(0, section.startRowIndex - contextLines)
    const end = Math.min(rows.length - 1, section.endRowIndex + contextLines)
    for (let index = start; index <= end; index += 1) {
      if (!complete && rows[index]?.hunkId !== section.sourceGroupId) continue
      indexes.add(index)
    }
  }
  return [...indexes].sort((left, right) => left - right)
}

export function projectWorkspaceSideBySideFile(
  file: WorkspaceSideBySideFile,
  mode: WorkspaceSideBySideViewMode,
  contextLines = 3,
): WorkspaceSideBySideViewItem[] {
  const rows = contentRows(file)
  const indexes = selectedIndexes(rows, file.sections, mode, contextLines, file.complete)
  if (indexes.length === 0) return []

  const items: WorkspaceSideBySideViewItem[] = []
  const addSeparator = (afterIndex: number, beforeIndex: number) => {
    const previous = rows[afterIndex]
    const next = rows[beforeIndex]
    const crossesUnknownPatchGap = !file.complete && previous?.hunkId !== next?.hunkId
    const hiddenCount = crossesUnknownPatchGap ? null : Math.max(0, beforeIndex - afterIndex - 1)
    if (hiddenCount === 0 && !crossesUnknownPatchGap) return
    items.push({
      id: `${file.id}-separator-${afterIndex}-${beforeIndex}`,
      kind: 'separator',
      hiddenCount,
    })
  }

  if (file.complete && indexes[0]! > 0) addSeparator(-1, indexes[0]!)
  indexes.forEach((index, selectedIndex) => {
    if (selectedIndex > 0) addSeparator(indexes[selectedIndex - 1]!, index)
    const row = rows[index]
    if (row) items.push({ id: row.id, kind: 'row', row })
  })
  if (file.complete && indexes.at(-1)! < rows.length - 1) addSeparator(indexes.at(-1)!, rows.length)
  return items
}
