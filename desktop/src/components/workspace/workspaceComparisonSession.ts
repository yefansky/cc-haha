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
  revision: number
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
    revision: session.revision,
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
  if (!Number.isInteger(lineNumber) || lineNumber < 1 || /[\r\n]/.test(text)) return session
  if (!getWorkspaceComparisonCapability(session, sourceSide).allowed) return session
  const lines = splitContent(session[sourceSide].content)
  const line = lines[lineNumber - 1]
  if (!line || line.text === text) return session
  const content = lines.map((candidate, index) => (
    `${index === lineNumber - 1 ? text : candidate.text}${candidate.ending}`
  )).join('')
  return editWorkspaceComparisonSide(session, sourceSide, content)
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

export function mergeWorkspaceComparisonSection(
  session: WorkspaceComparisonSession,
  model: WorkspaceSideBySideModel,
  sectionId: string,
  sourceSide: WorkspaceComparisonSourceSide,
): WorkspaceComparisonSession {
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
    left: restore(session.left, previous.left),
    right: restore(session.right, previous.right),
    manualAnchors: previous.manualAnchors,
    revision: previous.revision,
    undoStack: session.undoStack.slice(0, -1),
  }
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
