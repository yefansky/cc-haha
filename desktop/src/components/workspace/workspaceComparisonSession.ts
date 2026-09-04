import type {
  WorkspaceComparison,
  WorkspaceComparisonSide,
  WorkspaceComparisonSourceKind,
  WorkspaceWriteRequest,
  WorkspaceWriteResult,
} from '@/api/sessions'
import type {
  WorkspaceSideBySideDiffSection,
  WorkspaceSideBySideModel,
  WorkspaceSideBySideRow,
} from './workspaceSideBySideModel'
import {
  createManualAlignmentAnchor,
  rebaseManualAlignmentAnchors,
  staleManualAlignmentAnchors,
  validateManualAlignmentCandidate,
  type WorkspaceManualAlignmentAnchor,
  type WorkspaceManualAlignmentValidationReason,
} from './workspaceManualAlignment'
import {
  cloneWorkspaceComparisonSettings,
  createDefaultWorkspaceComparisonSettings,
  validateWorkspaceComparisonSettings,
  type WorkspaceComparisonSettings,
  type WorkspaceComparisonSettingsValidation,
} from './workspaceComparisonSettings'

export type WorkspaceComparisonSourceSide = 'left' | 'right'

export type WorkspaceComparisonCapabilityReason =
  | 'patch_only'
  | 'not_writable'
  | 'unsupported_encoding'
  | 'unavailable'

export interface WorkspaceComparisonSideBuffer {
  sourceSide: WorkspaceComparisonSourceSide
  source: {
    kind: WorkspaceComparisonSourceKind
    path: string
    revision: string
  }
  originExists: boolean
  originContent: string | null
  exists: boolean
  content: string
  contentFingerprint?: string
  originActualEncoding?: WorkspaceComparisonSide['actualEncoding']
  requestedEncoding: WorkspaceComparisonSide['requestedEncoding']
  actualEncoding?: WorkspaceComparisonSide['actualEncoding']
  bom: WorkspaceComparisonSide['bom']
  originLineEnding: WorkspaceComparisonSide['lineEnding']
  lineEnding: WorkspaceComparisonSide['lineEnding']
  writable: boolean
  readOnlyReason?: string
  dirty: boolean
}

interface WorkspaceComparisonSnapshot {
  left: Pick<WorkspaceComparisonSideBuffer, 'exists' | 'content' | 'actualEncoding' | 'lineEnding'>
  right: Pick<WorkspaceComparisonSideBuffer, 'exists' | 'content' | 'actualEncoding' | 'lineEnding'>
  manualAnchors: WorkspaceManualAlignmentAnchor[]
}

export interface WorkspaceComparisonSession {
  schemaVersion: 1
  left: WorkspaceComparisonSideBuffer
  right: WorkspaceComparisonSideBuffer
  manualAnchors: WorkspaceManualAlignmentAnchor[]
  nextManualAnchorSequence: number
  revision: number
  settingsRevision: number
  comparisonSettings: WorkspaceComparisonSettings
  undoStack: WorkspaceComparisonSnapshot[]
  redoStack: WorkspaceComparisonSnapshot[]
}

export type WorkspaceComparisonSettingsApplyOutcome =
  | { state: 'ok'; session: WorkspaceComparisonSession }
  | { state: 'error'; session: WorkspaceComparisonSession; validation: WorkspaceComparisonSettingsValidation & { state: 'error' } }

export type WorkspaceManualAlignmentAddOutcome =
  | { state: 'ok'; session: WorkspaceComparisonSession; anchor: WorkspaceManualAlignmentAnchor }
  | {
      state: 'error'
      session: WorkspaceComparisonSession
      reason: WorkspaceManualAlignmentValidationReason
      conflictAnchorId?: string
    }

export interface WorkspaceComparisonCapability {
  allowed: boolean
  reason?: WorkspaceComparisonCapabilityReason
  detail?: string
}

export type WorkspaceComparisonWriteRequest = WorkspaceWriteRequest

export type WorkspaceComparisonWriter = (
  request: WorkspaceComparisonWriteRequest,
) => Promise<WorkspaceWriteResult>

export type WorkspaceComparisonSaveOutcome =
  | { state: 'ok'; session: WorkspaceComparisonSession }
  | {
      state: 'conflict' | 'error'
      session: WorkspaceComparisonSession
      sourceSide: WorkspaceComparisonSourceSide
      error?: string
    }

const MAX_UNDO_DEPTH = 50

function completeContent(side: WorkspaceComparisonSide): string | null {
  if (side.state === 'missing' && !side.exists) return ''
  if (side.state === 'ok' && side.exists && typeof side.content === 'string') return side.content
  return null
}

function createSideBuffer(
  sourceSide: WorkspaceComparisonSourceSide,
  side: WorkspaceComparisonSide,
): WorkspaceComparisonSideBuffer | null {
  const content = completeContent(side)
  if (content === null) return null
  return {
    sourceSide,
    source: { ...side.source },
    originExists: side.exists,
    originContent: side.exists ? content : null,
    exists: side.exists,
    content,
    ...(side.contentFingerprint ? { contentFingerprint: side.contentFingerprint } : {}),
    ...(side.actualEncoding ? { originActualEncoding: side.actualEncoding } : {}),
    requestedEncoding: side.requestedEncoding,
    ...(side.actualEncoding ? { actualEncoding: side.actualEncoding } : {}),
    bom: side.bom,
    originLineEnding: side.lineEnding,
    lineEnding: side.lineEnding,
    writable: side.writable,
    ...(side.readOnlyReason ? { readOnlyReason: side.readOnlyReason } : {}),
    dirty: false,
  }
}

export function createWorkspaceComparisonSession(
  comparison: WorkspaceComparison | undefined,
): WorkspaceComparisonSession | null {
  if (!comparison) return null
  const left = createSideBuffer('left', comparison.left)
  const right = createSideBuffer('right', comparison.right)
  if (!left || !right) return null
  return {
    schemaVersion: 1,
    left,
    right,
    manualAnchors: [],
    nextManualAnchorSequence: 1,
    revision: 0,
    settingsRevision: 0,
    comparisonSettings: createDefaultWorkspaceComparisonSettings(right.source.path || left.source.path),
    undoStack: [],
    redoStack: [],
  }
}

export function applyWorkspaceComparisonSettings(
  session: WorkspaceComparisonSession,
  draft: WorkspaceComparisonSettings,
): WorkspaceComparisonSettingsApplyOutcome {
  const validation = validateWorkspaceComparisonSettings(draft)
  if (validation.state === 'error') return { state: 'error', session, validation }
  return {
    state: 'ok',
    session: {
      ...session,
      comparisonSettings: cloneWorkspaceComparisonSettings(draft),
      settingsRevision: session.settingsRevision + 1,
      revision: session.revision + 1,
      redoStack: [],
    },
  }
}

export function isWorkspaceComparisonSessionDirty(session: WorkspaceComparisonSession | null | undefined) {
  return Boolean(session?.left.dirty || session?.right.dirty)
}

function isMissingWritableWorkingSide(side: WorkspaceComparisonSideBuffer) {
  return side.source.kind === 'working_tree' && !side.originExists
}

function isDeletedSupportedWorkingSide(side: WorkspaceComparisonSideBuffer) {
  return side.source.kind === 'working_tree'
    && !side.exists
    && (side.originActualEncoding === 'utf8' || side.originActualEncoding === 'gbk')
}

export function getWorkspaceComparisonCapability(
  session: WorkspaceComparisonSession | null | undefined,
  sourceSide: WorkspaceComparisonSourceSide,
): WorkspaceComparisonCapability {
  if (!session) return { allowed: false, reason: 'patch_only' }
  const side = session[sourceSide]
  if (!side.writable) {
    return { allowed: false, reason: 'not_writable', ...(side.readOnlyReason ? { detail: side.readOnlyReason } : {}) }
  }
  if (side.source.kind !== 'working_tree') {
    return { allowed: false, reason: 'not_writable', ...(side.readOnlyReason ? { detail: side.readOnlyReason } : {}) }
  }
  if (
    (side.actualEncoding !== 'utf8' && side.actualEncoding !== 'gbk')
    && !isMissingWritableWorkingSide(side)
    && !isDeletedSupportedWorkingSide(side)
  ) {
    return { allowed: false, reason: 'unsupported_encoding' }
  }
  return { allowed: true }
}

function sideDirty(side: WorkspaceComparisonSideBuffer) {
  return side.exists !== side.originExists
    || (side.exists && side.content !== (side.originContent ?? ''))
}

function detectLineEnding(content: string): WorkspaceComparisonSide['lineEnding'] {
  const crlf = (content.match(/\r\n/g) ?? []).length
  const withoutCrlf = content.replace(/\r\n/g, '')
  const lf = (withoutCrlf.match(/\n/g) ?? []).length
  const cr = (withoutCrlf.match(/\r/g) ?? []).length
  const kinds = [crlf > 0, lf > 0, cr > 0].filter(Boolean).length
  if (kinds > 1) return 'mixed'
  if (crlf > 0) return 'crlf'
  if (lf > 0) return 'lf'
  if (cr > 0) return 'cr'
  return 'none'
}

function snapshot(session: WorkspaceComparisonSession): WorkspaceComparisonSnapshot {
  const take = (side: WorkspaceComparisonSideBuffer) => ({
    exists: side.exists,
    content: side.content,
    actualEncoding: side.actualEncoding,
    lineEnding: side.lineEnding,
  })
  return {
    left: take(session.left),
    right: take(session.right),
    manualAnchors: session.manualAnchors.map((anchor) => ({
      ...anchor,
      left: { ...anchor.left, signature: { ...anchor.left.signature } },
      right: { ...anchor.right, signature: { ...anchor.right.signature } },
    })),
  }
}

function withUndo(
  session: WorkspaceComparisonSession,
  mutate: (next: WorkspaceComparisonSession) => void,
): WorkspaceComparisonSession {
  const next: WorkspaceComparisonSession = {
    ...session,
    left: { ...session.left, source: { ...session.left.source } },
    right: { ...session.right, source: { ...session.right.source } },
    manualAnchors: session.manualAnchors.map((anchor) => ({
      ...anchor,
      left: { ...anchor.left, signature: { ...anchor.left.signature } },
      right: { ...anchor.right, signature: { ...anchor.right.signature } },
    })),
    revision: session.revision + 1,
    undoStack: [...session.undoStack.slice(-(MAX_UNDO_DEPTH - 1)), snapshot(session)],
    redoStack: [],
  }
  mutate(next)
  next.left.dirty = sideDirty(next.left)
  next.right.dirty = sideDirty(next.right)
  return next
}

export function editWorkspaceComparisonSide(
  session: WorkspaceComparisonSession,
  sourceSide: WorkspaceComparisonSourceSide,
  content: string,
): WorkspaceComparisonSession {
  if (!getWorkspaceComparisonCapability(session, sourceSide).allowed) return session
  const current = session[sourceSide]
  if (current.exists && current.content === content) return session
  return withUndo(session, (next) => {
    const side = next[sourceSide]
    const beforeContent = side.content
    side.exists = true
    side.content = content
    if (!side.originExists) side.actualEncoding = 'utf8'
    side.lineEnding = detectLineEnding(content)
    next.manualAnchors = rebaseManualAlignmentAnchors(
      next.manualAnchors,
      sourceSide,
      beforeContent,
      content,
    )
  })
}

export function editWorkspaceComparisonLine(
  session: WorkspaceComparisonSession,
  sourceSide: WorkspaceComparisonSourceSide,
  lineNumber: number,
  text: string,
  expectedRevision: number,
): WorkspaceComparisonSession {
  if (expectedRevision !== session.revision) return session
  if (!Number.isInteger(lineNumber) || lineNumber < 1) return session
  if (!getWorkspaceComparisonCapability(session, sourceSide).allowed) return session
  const lines = splitContent(session[sourceSide].content)
  const line = lines[lineNumber - 1]
  if (!line || line.text === text) return session
  const fallbackSide = sourceSide === 'left' ? session.right : session.left
  const replacement = text
    .replace(/\r\n|\r|\n/g, '\n')
    .replace(/\n/g, preferredEnding(session[sourceSide], fallbackSide))
  const content = lines.map((candidate, index) => (
    `${index === lineNumber - 1 ? replacement : candidate.text}${candidate.ending}`
  )).join('')
  return editWorkspaceComparisonSide(session, sourceSide, content)
}

export function insertWorkspaceComparisonText(
  session: WorkspaceComparisonSession,
  sourceSide: WorkspaceComparisonSourceSide,
  beforeLineNumber: number,
  text: string,
  expectedRevision: number,
): WorkspaceComparisonSession {
  if (expectedRevision !== session.revision) return session
  if (!Number.isInteger(beforeLineNumber) || beforeLineNumber < 1 || text.length === 0) return session
  if (!getWorkspaceComparisonCapability(session, sourceSide).allowed) return session
  const side = session[sourceSide]
  const fallbackSide = sourceSide === 'left' ? session.right : session.left
  const lines = splitContent(side.content)
  if (beforeLineNumber > lines.length + 1) return session
  const ending = preferredEnding(side, fallbackSide)
  const insertion = text.replace(/\r\n|\r|\n/g, '\n').replace(/\n/g, ending)
  const offset = lines.slice(0, beforeLineNumber - 1).reduce(
    (total, line) => total + line.text.length + line.ending.length,
    0,
  )
  const before = side.content.slice(0, offset)
  const after = side.content.slice(offset)
  const separatorBefore = before && !/(?:\r\n|\r|\n)$/.test(before) ? ending : ''
  const separatorAfter = after && !/(?:\r\n|\r|\n)$/.test(insertion) ? ending : ''
  return editWorkspaceComparisonSide(
    session,
    sourceSide,
    `${before}${separatorBefore}${insertion}${separatorAfter}${after}`,
  )
}

export function addWorkspaceManualAlignmentAnchor(
  session: WorkspaceComparisonSession,
  leftLine: number,
  rightLine: number,
  expectedRevision: number,
): WorkspaceManualAlignmentAddOutcome {
  const validation = validateManualAlignmentCandidate(
    session.manualAnchors,
    session.left.content,
    session.right.content,
    leftLine,
    rightLine,
    expectedRevision,
    session.revision,
  )
  if (validation.state === 'error') {
    return { ...validation, session }
  }
  const anchor = createManualAlignmentAnchor(
    `manual-anchor-${session.nextManualAnchorSequence}`,
    session.left.content,
    session.right.content,
    leftLine,
    rightLine,
  )
  return {
    state: 'ok',
    anchor,
    session: withUndo(session, (next) => {
      next.manualAnchors = [...next.manualAnchors, anchor]
        .sort((left, right) => left.left.lineNumber - right.left.lineNumber)
      next.nextManualAnchorSequence += 1
    }),
  }
}

export function removeWorkspaceManualAlignmentAnchor(
  session: WorkspaceComparisonSession,
  anchorId: string,
): WorkspaceComparisonSession {
  if (!session.manualAnchors.some((anchor) => anchor.id === anchorId)) return session
  return withUndo(session, (next) => {
    next.manualAnchors = next.manualAnchors.filter((anchor) => anchor.id !== anchorId)
  })
}

export function clearWorkspaceManualAlignmentAnchors(
  session: WorkspaceComparisonSession,
): WorkspaceComparisonSession {
  if (session.manualAnchors.length === 0) return session
  return withUndo(session, (next) => {
    next.manualAnchors = []
  })
}

interface ContentLine {
  text: string
  ending: string
}

function splitContent(content: string): ContentLine[] {
  const lines: ContentLine[] = []
  const newline = /\r\n|\n|\r/g
  let start = 0
  let match = newline.exec(content)
  while (match) {
    lines.push({ text: content.slice(start, match.index), ending: match[0] })
    start = match.index + match[0].length
    match = newline.exec(content)
  }
  if (start < content.length) lines.push({ text: content.slice(start), ending: '' })
  return lines
}

function preferredEnding(side: WorkspaceComparisonSideBuffer, fallback: WorkspaceComparisonSideBuffer) {
  if (side.lineEnding === 'crlf') return '\r\n'
  if (side.lineEnding === 'cr') return '\r'
  if (side.lineEnding === 'lf') return '\n'
  if (fallback.lineEnding === 'crlf') return '\r\n'
  if (fallback.lineEnding === 'cr') return '\r'
  return '\n'
}

function sourceLineNumber(row: WorkspaceSideBySideRow, side: WorkspaceComparisonSourceSide) {
  return side === 'left' ? row.left?.oldLine ?? null : row.right?.newLine ?? null
}

function sectionRows(model: WorkspaceSideBySideModel, section: WorkspaceSideBySideDiffSection) {
  const file = model.files.find((candidate) => candidate.id === section.fileId)
  if (!file || !file.complete) return null
  const rows = file.rows.filter((row) => (
    row.kind === 'context' || row.kind === 'change' || row.kind === 'existence'
  ))
  const rowIds = new Set(section.rowIds)
  return { file, rows, selected: rows.filter((row) => rowIds.has(row.id)) }
}

function comparisonRow(model: WorkspaceSideBySideModel, rowId: string) {
  if (model.kind !== 'comparison') return null
  for (const file of model.files) {
    if (!file.complete) continue
    const rowIndex = file.rows.findIndex((row) => row.id === rowId)
    if (rowIndex < 0) continue
    const row = file.rows[rowIndex]!
    if (row.kind !== 'context' && row.kind !== 'change') return null
    return { file, row, rowIndex }
  }
  return null
}

function insertionIndexAfterRow(
  rows: WorkspaceSideBySideRow[],
  rowIndex: number,
  targetSide: WorkspaceComparisonSourceSide,
  targetLineCount: number,
) {
  const nextLine = rows
    .slice(rowIndex + 1)
    .map((row) => sourceLineNumber(row, targetSide))
    .find((line): line is number => line !== null)
  if (nextLine !== undefined) return nextLine - 1
  const previousLine = rows
    .slice(0, rowIndex)
    .reverse()
    .map((row) => sourceLineNumber(row, targetSide))
    .find((line): line is number => line !== null)
  return previousLine ?? targetLineCount
}

function lineMatchesRow(
  lines: ContentLine[],
  row: WorkspaceSideBySideRow,
  sourceSide: WorkspaceComparisonSourceSide,
) {
  const lineNumber = sourceLineNumber(row, sourceSide)
  if (lineNumber === null) return true
  const sourceRow = sourceSide === 'left' ? row.left : row.right
  return Boolean(sourceRow && lines[lineNumber - 1]?.text === sourceRow.text)
}

export function mergeWorkspaceComparisonRow(
  session: WorkspaceComparisonSession,
  model: WorkspaceSideBySideModel,
  rowId: string,
  sourceSide: WorkspaceComparisonSourceSide,
  expectedRevision: number,
): WorkspaceComparisonSession {
  if (expectedRevision !== session.revision) return session
  const targetSide: WorkspaceComparisonSourceSide = sourceSide === 'left' ? 'right' : 'left'
  if (!getWorkspaceComparisonCapability(session, targetSide).allowed) return session
  const resolved = comparisonRow(model, rowId)
  if (!resolved) return session

  const source = session[sourceSide]
  const target = session[targetSide]
  const sourceLines = splitContent(source.content)
  const targetLines = splitContent(target.content)
  if (
    !lineMatchesRow(sourceLines, resolved.row, sourceSide)
    || !lineMatchesRow(targetLines, resolved.row, targetSide)
  ) return session

  const sourceLineNumberValue = sourceLineNumber(resolved.row, sourceSide)
  const targetLineNumberValue = sourceLineNumber(resolved.row, targetSide)
  if (sourceLineNumberValue === null && targetLineNumberValue === null) return session
  const replacement = sourceLineNumberValue === null
    ? []
    : [sourceLines[sourceLineNumberValue - 1]!]
  const targetStart = targetLineNumberValue === null
    ? insertionIndexAfterRow(resolved.file.rows, resolved.rowIndex, targetSide, targetLines.length)
    : targetLineNumberValue - 1
  const targetDeleteCount = targetLineNumberValue === null ? 0 : 1
  const ending = preferredEnding(target, source)
  const inserted = replacement.map((line) => ({ text: line.text, ending }))
  const nextLines = [...targetLines]
  nextLines.splice(targetStart, targetDeleteCount, ...inserted)
  for (let index = 0; index < nextLines.length - 1; index += 1) {
    if (!nextLines[index]!.ending) nextLines[index]!.ending = ending
  }
  if (nextLines.length > 0 && targetStart + inserted.length >= nextLines.length) {
    const sourceLast = replacement.at(-1)
    if (sourceLast && !sourceLast.ending) nextLines.at(-1)!.ending = ''
  }
  const content = nextLines.map((line) => line.text + line.ending).join('')
  const removingWholeExistingTarget = !source.exists
    && targetLineNumberValue !== null
    && targetLines.length === 1
    && replacement.length === 0
  const nextExists = removingWholeExistingTarget ? false : true
  const nextContent = nextExists ? content : ''
  if (target.exists === nextExists && target.content === nextContent) return session

  return withUndo(session, (next) => {
    const nextTarget = next[targetSide]
    const beforeContent = nextTarget.content
    nextTarget.exists = nextExists
    nextTarget.content = nextContent
    if (!nextTarget.originExists && nextTarget.exists) nextTarget.actualEncoding = 'utf8'
    nextTarget.lineEnding = nextTarget.exists ? detectLineEnding(nextTarget.content) : 'none'
    next.manualAnchors = rebaseManualAlignmentAnchors(
      next.manualAnchors,
      targetSide,
      beforeContent,
      nextTarget.content,
    )
  })
}

export function mergeWorkspaceComparisonSection(
  session: WorkspaceComparisonSession,
  model: WorkspaceSideBySideModel,
  sectionId: string,
  sourceSide: WorkspaceComparisonSourceSide,
  expectedRevision: number = session.revision,
): WorkspaceComparisonSession {
  if (expectedRevision !== session.revision) return session
  const targetSide: WorkspaceComparisonSourceSide = sourceSide === 'left' ? 'right' : 'left'
  if (!getWorkspaceComparisonCapability(session, targetSide).allowed || model.kind !== 'comparison') return session
  const section = model.sections.find((candidate) => candidate.id === sectionId)
  if (!section) return session
  const resolved = sectionRows(model, section)
  if (!resolved || resolved.selected.length === 0) return session

  const source = session[sourceSide]
  const target = session[targetSide]
  if (section.existenceOnly) {
    return withUndo(session, (next) => {
      const nextTarget = next[targetSide]
      const beforeContent = nextTarget.content
      nextTarget.exists = source.exists
      nextTarget.content = source.exists ? source.content : ''
      nextTarget.actualEncoding = source.exists
        ? nextTarget.originExists
          ? nextTarget.actualEncoding
          : 'utf8'
        : undefined
      nextTarget.lineEnding = source.exists ? source.lineEnding : 'none'
      next.manualAnchors = staleManualAlignmentAnchors(
        rebaseManualAlignmentAnchors(next.manualAnchors, targetSide, beforeContent, nextTarget.content),
        'content_unavailable',
      )
    })
  }
  const sourceLines = splitContent(source.content)
  const targetLines = splitContent(target.content)
  const selectedSourceLines = resolved.selected
    .map((row) => sourceLineNumber(row, sourceSide))
    .filter((line): line is number => line !== null)
  const selectedTargetLines = resolved.selected
    .map((row) => sourceLineNumber(row, targetSide))
    .filter((line): line is number => line !== null)

  const replacement = selectedSourceLines.length === 0
    ? []
    : sourceLines.slice(Math.min(...selectedSourceLines) - 1, Math.max(...selectedSourceLines))
  let targetStart: number
  let targetDeleteCount: number
  if (selectedTargetLines.length > 0) {
    targetStart = Math.min(...selectedTargetLines) - 1
    targetDeleteCount = Math.max(...selectedTargetLines) - Math.min(...selectedTargetLines) + 1
  } else {
    const selectedIds = new Set(section.rowIds)
    const firstSelectedIndex = resolved.rows.findIndex((row) => selectedIds.has(row.id))
    const nextTargetLine = resolved.rows
      .slice(firstSelectedIndex + resolved.selected.length)
      .map((row) => sourceLineNumber(row, targetSide))
      .find((line): line is number => line !== null)
    targetStart = nextTargetLine ? nextTargetLine - 1 : targetLines.length
    targetDeleteCount = 0
  }

  const ending = preferredEnding(target, source)
  const inserted = replacement.map((line) => ({ text: line.text, ending }))
  const nextLines = [...targetLines]
  nextLines.splice(targetStart, targetDeleteCount, ...inserted)
  for (let index = 0; index < nextLines.length - 1; index += 1) {
    if (!nextLines[index]!.ending) nextLines[index]!.ending = ending
  }
  if (nextLines.length > 0 && targetStart + inserted.length >= nextLines.length) {
    const sourceLast = replacement.at(-1)
    if (sourceLast && !sourceLast.ending) nextLines.at(-1)!.ending = ''
  }
  const content = nextLines.map((line) => line.text + line.ending).join('')
  const removingWholeExistingTarget = !source.exists
    && selectedTargetLines.length === targetLines.length
    && targetLines.length > 0

  return withUndo(session, (next) => {
    const nextTarget = next[targetSide]
    const beforeContent = nextTarget.content
    nextTarget.exists = removingWholeExistingTarget ? false : true
    nextTarget.content = removingWholeExistingTarget ? '' : content
    if (!nextTarget.originExists && nextTarget.exists) nextTarget.actualEncoding = 'utf8'
    nextTarget.lineEnding = nextTarget.exists ? detectLineEnding(nextTarget.content) : 'none'
    next.manualAnchors = rebaseManualAlignmentAnchors(
      next.manualAnchors,
      targetSide,
      beforeContent,
      nextTarget.content,
    )
  })
}

export function undoWorkspaceComparisonSession(session: WorkspaceComparisonSession): WorkspaceComparisonSession {
  const previous = session.undoStack.at(-1)
  if (!previous) return session
  return restoreWorkspaceComparisonSnapshot(
    session,
    previous,
    session.undoStack.slice(0, -1),
    [...session.redoStack.slice(-(MAX_UNDO_DEPTH - 1)), snapshot(session)],
  )
}

function restoreWorkspaceComparisonSnapshot(
  session: WorkspaceComparisonSession,
  target: WorkspaceComparisonSnapshot,
  undoStack: WorkspaceComparisonSnapshot[],
  redoStack: WorkspaceComparisonSnapshot[],
): WorkspaceComparisonSession {
  const restore = (
    side: WorkspaceComparisonSideBuffer,
    value: WorkspaceComparisonSnapshot[WorkspaceComparisonSourceSide],
  ): WorkspaceComparisonSideBuffer => ({
    ...side,
    ...value,
    dirty: value.exists !== side.originExists || (value.exists && value.content !== (side.originContent ?? '')),
  })
  return {
    ...session,
    left: restore(session.left, target.left),
    right: restore(session.right, target.right),
    manualAnchors: target.manualAnchors.map((anchor) => ({
      ...anchor,
      left: { ...anchor.left, signature: { ...anchor.left.signature } },
      right: { ...anchor.right, signature: { ...anchor.right.signature } },
    })),
    // Revisions are optimistic-concurrency tokens, so history navigation must
    // never reuse an earlier value after the user creates a new branch.
    revision: session.revision + 1,
    undoStack,
    redoStack,
  }
}

export function redoWorkspaceComparisonSession(session: WorkspaceComparisonSession): WorkspaceComparisonSession {
  const next = session.redoStack.at(-1)
  if (!next) return session
  return restoreWorkspaceComparisonSnapshot(
    session,
    next,
    [...session.undoStack.slice(-(MAX_UNDO_DEPTH - 1)), snapshot(session)],
    session.redoStack.slice(0, -1),
  )
}

export function discardWorkspaceComparisonSession(session: WorkspaceComparisonSession): WorkspaceComparisonSession {
  const reset = (side: WorkspaceComparisonSideBuffer): WorkspaceComparisonSideBuffer => ({
    ...side,
    exists: side.originExists,
    content: side.originContent ?? '',
    actualEncoding: side.originActualEncoding,
    lineEnding: side.originLineEnding,
    dirty: false,
  })
  const left = reset(session.left)
  const right = reset(session.right)
  const rebasedLeft = rebaseManualAlignmentAnchors(
    session.manualAnchors,
    'left',
    session.left.content,
    left.content,
  )
  return {
    ...session,
    left,
    right,
    manualAnchors: rebaseManualAlignmentAnchors(rebasedLeft, 'right', session.right.content, right.content),
    revision: 0,
    undoStack: [],
    redoStack: [],
  }
}

export function acceptWorkspaceComparisonSave(
  session: WorkspaceComparisonSession,
  sourceSide: WorkspaceComparisonSourceSide,
  savedContent?: string | null,
  result?: WorkspaceWriteResult,
): WorkspaceComparisonSession {
  const next = {
    ...session,
    left: { ...session.left },
    right: { ...session.right },
    revision: session.revision + 1,
    undoStack: [] as WorkspaceComparisonSnapshot[],
    redoStack: [] as WorkspaceComparisonSnapshot[],
  }
  const side = next[sourceSide]
  if (savedContent === null) {
    side.exists = false
    side.content = ''
  } else if (typeof savedContent === 'string') {
    side.exists = true
    side.content = savedContent
  }
  side.originExists = side.exists
  side.originContent = side.exists ? side.content : null
  side.originActualEncoding = side.actualEncoding
  side.originLineEnding = side.lineEnding
  if (result?.actualEncoding) {
    side.actualEncoding = result.actualEncoding
    side.originActualEncoding = result.actualEncoding
  }
  if (result?.bom) side.bom = result.bom
  if (result?.lineEnding) {
    side.lineEnding = result.lineEnding
    side.originLineEnding = result.lineEnding
  }
  side.contentFingerprint = result?.contentFingerprint
  side.dirty = false
  return next
}

function sameSourceIdentity(
  left: WorkspaceComparisonSideBuffer,
  right: WorkspaceComparisonSideBuffer,
) {
  return left.source.kind === right.source.kind && left.source.path === right.source.path
}

export function reloadWorkspaceComparisonSession(
  previous: WorkspaceComparisonSession,
  comparison: WorkspaceComparison | undefined,
): WorkspaceComparisonSession | null {
  const reloaded = createWorkspaceComparisonSession(comparison)
  if (!reloaded) return null
  let anchors = previous.manualAnchors
  for (const sourceSide of ['left', 'right'] as const) {
    const before = previous[sourceSide]
    const after = reloaded[sourceSide]
    anchors = sameSourceIdentity(before, after)
      ? rebaseManualAlignmentAnchors(anchors, sourceSide, before.content, after.content)
      : staleManualAlignmentAnchors(anchors, 'source_changed')
  }
  return {
    ...reloaded,
    comparisonSettings: cloneWorkspaceComparisonSettings(previous.comparisonSettings),
    settingsRevision: previous.settingsRevision,
    manualAnchors: anchors,
    nextManualAnchorSequence: previous.nextManualAnchorSequence,
    revision: previous.revision + 1,
  }
}

export async function saveWorkspaceComparisonSession(
  session: WorkspaceComparisonSession,
  writer: WorkspaceComparisonWriter,
): Promise<WorkspaceComparisonSaveOutcome> {
  let next = session
  for (const sourceSide of ['left', 'right'] as const) {
    const side = next[sourceSide]
    if (!side.dirty) continue
    const capability = getWorkspaceComparisonCapability(next, sourceSide)
    if (!capability.allowed) {
      return {
        state: 'error',
        session: next,
        sourceSide,
        error: capability.reason,
      }
    }
    let result: WorkspaceWriteResult
    try {
      const expectedFingerprint = side.originExists ? side.contentFingerprint : null
      const lineEnding = side.originExists && side.originLineEnding !== 'none'
        ? side.originLineEnding
        : side.lineEnding
      result = await writer({
        path: side.source.path,
        expectedContent: side.originExists ? side.originContent : null,
        content: side.exists ? side.content : null,
        ...(expectedFingerprint !== undefined
          ? {
              expectedFingerprint,
              encoding: side.actualEncoding ?? side.originActualEncoding ?? 'utf8',
              bom: side.bom === 'utf8' ? 'utf8' : 'none',
              lineEnding,
            }
          : {}),
      })
    } catch (error) {
      return {
        state: 'error',
        session: next,
        sourceSide,
        error: error instanceof Error ? error.message : String(error),
      }
    }
    if (result.state !== 'ok') {
      return {
        state: result.state === 'conflict' ? 'conflict' : 'error',
        session: next,
        sourceSide,
        ...(result.error ? { error: result.error } : {}),
      }
    }
    next = acceptWorkspaceComparisonSave(
      next,
      sourceSide,
      side.exists ? result.content ?? side.content : null,
      result,
    )
  }
  return { state: 'ok', session: next }
}

function comparisonSide(side: WorkspaceComparisonSideBuffer): WorkspaceComparisonSide {
  return {
    source: { ...side.source },
    exists: side.exists,
    state: side.exists ? 'ok' : 'missing',
    ...(side.exists ? { content: side.content } : {}),
    ...(side.contentFingerprint ? { contentFingerprint: side.contentFingerprint } : {}),
    requestedEncoding: side.requestedEncoding,
    ...(side.actualEncoding ? { actualEncoding: side.actualEncoding } : {}),
    bom: side.bom,
    lineEnding: side.lineEnding,
    writable: side.writable,
    ...(side.readOnlyReason ? { readOnlyReason: side.readOnlyReason } : {}),
  }
}

export function workspaceComparisonSessionToComparison(
  session: WorkspaceComparisonSession,
): WorkspaceComparison {
  return {
    schemaVersion: 1,
    left: comparisonSide(session.left),
    right: comparisonSide(session.right),
  }
}
