import type { WorkspaceComparison } from '@/api/sessions'

export type WorkspaceComparisonInputScope =
  | 'file-full'
  | 'positioned-patch'
  | 'replacement-fragment'
  | 'proposed-content'

export type WorkspaceComparisonInputDisabledReason =
  | 'positioned_patch'
  | 'replacement_fragment'
  | 'baseline_unknown'

export interface WorkspaceComparisonOrigin {
  id: string
  host: 'workspace' | 'checkpoint' | 'tool'
  path: string | null
  revision: string | null
}

export interface WorkspaceComparisonHostCapabilities {
  all: boolean
  same: boolean
  differences: boolean
  context: boolean
  navigation: boolean
  swap: boolean
  edit: boolean
  merge: boolean
  save: boolean
  encoding: boolean
  anchors: boolean
  settings: boolean
  comment: boolean
  hunkAction: boolean
}

export interface WorkspaceComparisonTextPair {
  left: { content: string; lineStart: number }
  right: { content: string; lineStart: number }
}

interface WorkspaceComparisonInputBase {
  scope: WorkspaceComparisonInputScope
  origin: WorkspaceComparisonOrigin
  path: string
  value: string
  capabilities: WorkspaceComparisonHostCapabilities
}

export interface WorkspaceFileFullComparisonInput extends WorkspaceComparisonInputBase {
  scope: 'file-full'
  comparison: WorkspaceComparison
  disabledReason: null
}

export interface WorkspaceReadonlyComparisonInput extends WorkspaceComparisonInputBase {
  scope: Exclude<WorkspaceComparisonInputScope, 'file-full'>
  disabledReason: WorkspaceComparisonInputDisabledReason
  textPair?: WorkspaceComparisonTextPair
}

export interface WorkspaceReplacementFragmentComparisonInput extends WorkspaceReadonlyComparisonInput {
  scope: 'replacement-fragment'
  disabledReason: 'replacement_fragment'
  textPair: WorkspaceComparisonTextPair
}

export type WorkspaceComparisonInput =
  | WorkspaceFileFullComparisonInput
  | WorkspaceReadonlyComparisonInput

export type WorkspaceFileFullComparisonInputResult =
  | { state: 'ok'; input: WorkspaceFileFullComparisonInput }
  | { state: 'unavailable'; reason: 'incomplete' }

const readonlyCapabilities: WorkspaceComparisonHostCapabilities = {
  all: false,
  same: false,
  differences: true,
  context: true,
  navigation: true,
  swap: true,
  edit: false,
  merge: false,
  save: false,
  encoding: false,
  anchors: false,
  settings: false,
  comment: false,
  hunkAction: false,
}

function completeSide(side: WorkspaceComparison['left']) {
  return (
    (side.state === 'missing' && !side.exists)
    || (side.state === 'ok' && side.exists && typeof side.content === 'string')
  )
}

function writableUtf8Side(side: WorkspaceComparison['left']) {
  if (!side.writable) return false
  if (!side.exists && side.state === 'missing') return true
  return side.state === 'ok' && side.actualEncoding === 'utf8'
}

export function createFileFullComparisonInput({
  originId,
  path,
  value,
  comparison,
  revision = null,
}: {
  originId: string
  path: string
  value: string
  comparison: WorkspaceComparison
  revision?: string | null
}): WorkspaceFileFullComparisonInputResult {
  if (!completeSide(comparison.left) || !completeSide(comparison.right)) {
    return { state: 'unavailable', reason: 'incomplete' }
  }
  const canWrite = writableUtf8Side(comparison.left) || writableUtf8Side(comparison.right)
  return {
    state: 'ok',
    input: {
      scope: 'file-full',
      origin: { id: originId, host: 'workspace', path, revision },
      path,
      value,
      comparison,
      disabledReason: null,
      capabilities: {
        all: true,
        same: true,
        differences: true,
        context: true,
        navigation: true,
        swap: true,
        edit: canWrite,
        merge: canWrite,
        save: canWrite,
        encoding: true,
        anchors: comparison.left.exists && comparison.right.exists,
        settings: true,
        comment: true,
        hunkAction: false,
      },
    },
  }
}

function sanitizePatchPath(path: string) {
  const sanitized = path.replace(/[\r\n\t]/g, ' ').replace(/\\/g, '/').trim()
  return sanitized || 'untitled'
}

function contentLines(content: string) {
  if (content.length === 0) return []
  const normalized = content.replace(/\r\n?/g, '\n')
  const lines = normalized.split('\n')
  if (lines.at(-1) === '') lines.pop()
  return lines
}

function buildFragmentPatch(path: string, oldString: string, newString: string) {
  const safePath = sanitizePatchPath(path)
  const header = [
    `diff --git a/${safePath} b/${safePath}`,
    `--- a/${safePath}`,
    `+++ b/${safePath}`,
  ]
  if (oldString === newString) return header.join('\n')
  const oldLines = contentLines(oldString)
  const newLines = contentLines(newString)
  const hunk = `@@ -1,${oldLines.length} +1,${newLines.length} @@`
  return [...header, hunk, ...oldLines.map((line) => `-${line}`), ...newLines.map((line) => `+${line}`)].join('\n')
}

function createReadonlyInput({
  scope,
  originId,
  originHost,
  path,
  value,
  disabledReason,
  revision = null,
  hostCapabilities,
  textPair,
}: {
  scope: WorkspaceReadonlyComparisonInput['scope']
  originId: string
  originHost: WorkspaceComparisonOrigin['host']
  path: string
  value: string
  disabledReason: WorkspaceComparisonInputDisabledReason
  revision?: string | null
  hostCapabilities?: Partial<Pick<WorkspaceComparisonHostCapabilities, 'comment' | 'hunkAction'>>
  textPair?: WorkspaceComparisonTextPair
}): WorkspaceReadonlyComparisonInput {
  return {
    scope,
    origin: { id: originId, host: originHost, path, revision },
    path,
    value,
    disabledReason,
    ...(textPair ? { textPair } : {}),
    capabilities: { ...readonlyCapabilities, ...hostCapabilities },
  }
}

export function createPositionedPatchComparisonInput({
  originId,
  path,
  value,
  revision = null,
  hostCapabilities,
}: {
  originId: string
  path: string
  value: string
  revision?: string | null
  hostCapabilities?: Partial<Pick<WorkspaceComparisonHostCapabilities, 'comment' | 'hunkAction'>>
}) {
  return createReadonlyInput({
    scope: 'positioned-patch',
    originId,
    originHost: 'checkpoint',
    path,
    value,
    disabledReason: 'positioned_patch',
    revision,
    hostCapabilities,
  })
}

export function createReplacementFragmentComparisonInput({
  originId,
  path,
  oldString,
  newString,
}: {
  originId: string
  path: string
  oldString: string
  newString: string
}): WorkspaceReplacementFragmentComparisonInput {
  const textPair: WorkspaceComparisonTextPair = {
    left: { content: oldString, lineStart: 1 },
    right: { content: newString, lineStart: 1 },
  }
  return {
    ...createReadonlyInput({
    scope: 'replacement-fragment',
    originId,
    originHost: 'tool',
    path,
    value: buildFragmentPatch(path, oldString, newString),
    disabledReason: 'replacement_fragment',
    textPair,
    }),
    scope: 'replacement-fragment',
    disabledReason: 'replacement_fragment',
    textPair,
  }
}

export function createProposedContentComparisonInput({
  originId,
  path,
  content,
}: {
  originId: string
  path: string
  content: string
}) {
  return createReadonlyInput({
    scope: 'proposed-content',
    originId,
    originHost: 'tool',
    path,
    value: buildFragmentPatch(path, '', content),
    disabledReason: 'baseline_unknown',
  })
}
