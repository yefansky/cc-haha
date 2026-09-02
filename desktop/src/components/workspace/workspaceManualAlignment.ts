export type WorkspaceManualAlignmentSourceSide = 'left' | 'right'

export type WorkspaceManualAlignmentStaleReason =
  | 'line_changed'
  | 'ambiguous'
  | 'source_changed'
  | 'content_unavailable'

export interface WorkspaceManualAlignmentSignature {
  previous: string
  current: string
  next: string
}

export interface WorkspaceManualAlignmentEndpoint {
  lineNumber: number
  signature: WorkspaceManualAlignmentSignature
}

export interface WorkspaceManualAlignmentAnchor {
  id: string
  state: 'valid' | 'stale'
  left: WorkspaceManualAlignmentEndpoint
  right: WorkspaceManualAlignmentEndpoint
  staleReason?: WorkspaceManualAlignmentStaleReason
}

export type WorkspaceManualAlignmentValidationReason =
  | 'duplicate'
  | 'crossing'
  | 'out_of_range'
  | 'stale_selection'

export type WorkspaceManualAlignmentValidation =
  | { state: 'ok' }
  | { state: 'error'; reason: WorkspaceManualAlignmentValidationReason; conflictAnchorId?: string }

interface AlignmentLine {
  serialized: string
}

function splitLines(content: string): AlignmentLine[] {
  const lines: AlignmentLine[] = []
  const newline = /\r\n|\n|\r/g
  let start = 0
  let match = newline.exec(content)
  while (match) {
    lines.push({ serialized: content.slice(start, match.index) + match[0] })
    start = match.index + match[0].length
    match = newline.exec(content)
  }
  if (start < content.length) lines.push({ serialized: content.slice(start) })
  return lines
}

export function countWorkspaceManualAlignmentLines(content: string) {
  return splitLines(content).length
}

function signatureAt(lines: AlignmentLine[], index: number): WorkspaceManualAlignmentSignature {
  return {
    previous: index > 0 ? lines[index - 1]!.serialized : '<BOF>',
    current: lines[index]!.serialized,
    next: index + 1 < lines.length ? lines[index + 1]!.serialized : '<EOF>',
  }
}

function endpoint(content: string, lineNumber: number): WorkspaceManualAlignmentEndpoint {
  const lines = splitLines(content)
  if (lineNumber < 1 || lineNumber > lines.length) {
    throw new RangeError(`Manual alignment line ${lineNumber} is outside the source.`)
  }
  return { lineNumber, signature: signatureAt(lines, lineNumber - 1) }
}

export function createManualAlignmentAnchor(
  id: string,
  leftContent: string,
  rightContent: string,
  leftLine: number,
  rightLine: number,
): WorkspaceManualAlignmentAnchor {
  return {
    id,
    state: 'valid',
    left: endpoint(leftContent, leftLine),
    right: endpoint(rightContent, rightLine),
  }
}

export function validateManualAlignmentCandidate(
  anchors: WorkspaceManualAlignmentAnchor[],
  leftContent: string,
  rightContent: string,
  leftLine: number,
  rightLine: number,
  expectedRevision: number,
  currentRevision: number,
): WorkspaceManualAlignmentValidation {
  if (expectedRevision !== currentRevision) return { state: 'error', reason: 'stale_selection' }
  if (
    leftLine < 1
    || leftLine > countWorkspaceManualAlignmentLines(leftContent)
    || rightLine < 1
    || rightLine > countWorkspaceManualAlignmentLines(rightContent)
  ) return { state: 'error', reason: 'out_of_range' }

  const valid = anchors.filter((anchor) => anchor.state === 'valid')
  const duplicate = valid.find((anchor) => (
    anchor.left.lineNumber === leftLine || anchor.right.lineNumber === rightLine
  ))
  if (duplicate) return { state: 'error', reason: 'duplicate', conflictAnchorId: duplicate.id }

  const ordered = [
    ...valid.map((anchor) => ({ left: anchor.left.lineNumber, right: anchor.right.lineNumber, id: anchor.id })),
    { left: leftLine, right: rightLine, id: '' },
  ].sort((left, right) => left.left - right.left)
  for (let index = 1; index < ordered.length; index += 1) {
    if (ordered[index - 1]!.right >= ordered[index]!.right) {
      const conflict = ordered[index - 1]!.id || ordered[index]!.id
      return {
        state: 'error',
        reason: 'crossing',
        ...(conflict ? { conflictAnchorId: conflict } : {}),
      }
    }
  }
  return { state: 'ok' }
}

function sameSignature(left: WorkspaceManualAlignmentSignature, right: WorkspaceManualAlignmentSignature) {
  return left.previous === right.previous && left.current === right.current && left.next === right.next
}

function relocateEndpoint(
  endpointValue: WorkspaceManualAlignmentEndpoint,
  beforeContent: string,
  afterContent: string,
): { state: 'valid'; endpoint: WorkspaceManualAlignmentEndpoint } | { state: 'stale'; reason: WorkspaceManualAlignmentStaleReason } {
  const before = splitLines(beforeContent)
  const after = splitLines(afterContent)
  const oldIndex = endpointValue.lineNumber - 1
  if (oldIndex < 0 || oldIndex >= before.length) return { state: 'stale', reason: 'line_changed' }

  let prefix = 0
  while (prefix < before.length && prefix < after.length && before[prefix]!.serialized === after[prefix]!.serialized) {
    prefix += 1
  }
  let suffix = 0
  while (
    suffix < before.length - prefix
    && suffix < after.length - prefix
    && before[before.length - 1 - suffix]!.serialized === after[after.length - 1 - suffix]!.serialized
  ) suffix += 1

  let mappedIndex: number | null = null
  if (oldIndex < prefix) mappedIndex = oldIndex
  else if (oldIndex >= before.length - suffix) mappedIndex = after.length - (before.length - oldIndex)

  const matches = after.flatMap((_, index) => (
    sameSignature(signatureAt(after, index), endpointValue.signature) ? [index] : []
  ))
  if (matches.length > 1) return { state: 'stale', reason: 'ambiguous' }
  if (mappedIndex === null || matches.length !== 1 || matches[0] !== mappedIndex) {
    return { state: 'stale', reason: 'line_changed' }
  }
  return {
    state: 'valid',
    endpoint: { lineNumber: mappedIndex + 1, signature: signatureAt(after, mappedIndex) },
  }
}

export function rebaseManualAlignmentAnchors(
  anchors: WorkspaceManualAlignmentAnchor[],
  sourceSide: WorkspaceManualAlignmentSourceSide,
  beforeContent: string,
  afterContent: string,
): WorkspaceManualAlignmentAnchor[] {
  return anchors.map((anchor) => {
    if (anchor.state === 'stale') return { ...anchor, left: { ...anchor.left }, right: { ...anchor.right } }
    const relocated = relocateEndpoint(anchor[sourceSide], beforeContent, afterContent)
    if (relocated.state === 'stale') {
      return {
        ...anchor,
        left: { ...anchor.left },
        right: { ...anchor.right },
        state: 'stale',
        staleReason: relocated.reason,
      }
    }
    return {
      ...anchor,
      left: sourceSide === 'left' ? relocated.endpoint : { ...anchor.left },
      right: sourceSide === 'right' ? relocated.endpoint : { ...anchor.right },
      state: 'valid',
      staleReason: undefined,
    }
  })
}

export function staleManualAlignmentAnchors(
  anchors: WorkspaceManualAlignmentAnchor[],
  staleReason: WorkspaceManualAlignmentStaleReason,
): WorkspaceManualAlignmentAnchor[] {
  return anchors.map((anchor) => ({
    ...anchor,
    left: { ...anchor.left },
    right: { ...anchor.right },
    state: 'stale',
    staleReason,
  }))
}
