import {
  memo,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from 'react'
import {
  ArrowLeftRight,
  ArrowRight,
  ChevronDown,
  ChevronUp,
  CornerDownLeft,
  FileCode2,
  Link2,
  MessageSquare,
  Pencil,
  Plus,
  Save,
  SlidersHorizontal,
  Undo2,
  X,
} from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { IconButton } from '@/components/ui/IconButton'
import { SegmentedControl } from '@/components/ui/SegmentedControl'
import type { WorkspaceComparison, WorkspaceTextEncoding } from '@/api/sessions'
import { useTranslation } from '../../i18n'
import {
  WORKSPACE_PLAIN_TEXT_LINE_THRESHOLD,
  WORKSPACE_PREVIEW_LINE_LIMIT,
  type WorkspaceDiffCommentSelection,
} from './WorkspaceDiffSurface'
import {
  createWorkspaceDiffHighlightCacheKey,
  requestWorkspaceDiffHighlight,
} from './workspaceDiffHighlightRuntime'
import type {
  WorkspaceDiffHighlightResult,
  WorkspaceDiffHighlightToken,
  WorkspaceDiffWordRange,
} from './workspaceDiffHighlighter'
import {
  getCompatibleDiffRange,
  type WorkspaceDiffRow,
  type WorkspaceDiffSelection,
} from './workspaceDiffModel'
import {
  buildWorkspaceSideBySideModel,
  buildWorkspaceSideBySideTextPairModel,
  projectWorkspaceSideBySideFile,
  type WorkspaceSideBySideDiffSection,
  type WorkspaceSideBySideModel,
  type WorkspaceSideBySideViewItem,
  type WorkspaceSideBySideViewMode,
} from './workspaceSideBySideModel'
import type { WorkspaceComparisonTextPair } from './workspaceComparisonInput'
import {
  editWorkspaceComparisonSide,
  applyWorkspaceComparisonSettings,
  addWorkspaceManualAlignmentAnchor,
  clearWorkspaceManualAlignmentAnchors,
  editWorkspaceComparisonLine,
  getWorkspaceComparisonCapability,
  isWorkspaceComparisonSessionDirty,
  mergeWorkspaceComparisonSection,
  removeWorkspaceManualAlignmentAnchor,
  undoWorkspaceComparisonSession,
  workspaceComparisonSessionToComparison,
  type WorkspaceComparisonSession,
  type WorkspaceComparisonSourceSide,
} from './workspaceComparisonSession'
import { countWorkspaceManualAlignmentLines } from './workspaceManualAlignment'
import { createDefaultWorkspaceComparisonSettings } from './workspaceComparisonSettings'
import { WorkspaceComparisonSettingsPanel } from './WorkspaceComparisonSettingsPanel'
import { requestWorkspaceComparisonModel } from './workspaceComparisonRuntime'

export interface WorkspaceSideBySideDiffSurfaceProps {
  value: string
  comparison?: WorkspaceComparison
  path: string
  className?: string
  lineLimit?: number
  hideSingleFileHeader?: boolean
  onAddComment?: (selection: WorkspaceDiffCommentSelection, note: string) => void
  renderHunkAction?: (hunkId: string) => ReactNode
  comparisonSession?: WorkspaceComparisonSession | null
  onComparisonSessionChange?: (session: WorkspaceComparisonSession) => void
  onSave?: () => void | Promise<void>
  saving?: boolean
  saveError?: string | null
  onEncodingChange?: (
    sourceSide: WorkspaceComparisonSourceSide,
    encoding: WorkspaceTextEncoding,
  ) => void | Promise<void>
  encodingChangingSide?: WorkspaceComparisonSourceSide | null
  fullOnlyDisabledReason?: string
  textPair?: WorkspaceComparisonTextPair
  modelOverride?: WorkspaceSideBySideModel
}

function hasCompleteComparisonContent(comparison: WorkspaceComparison | undefined) {
  if (!comparison) return false
  const complete = (side: WorkspaceComparison['left']) => (
    (side.state === 'missing' && !side.exists)
    || (side.state === 'ok' && side.exists && typeof side.content === 'string')
  )
  return complete(comparison.left) && complete(comparison.right)
}

function comparisonSourceIdentity(comparison: WorkspaceComparison | undefined, path: string) {
  if (!comparison) return `patch:${path}`
  const identity = (side: WorkspaceComparison['left']) => (
    `${side.source.kind}:${side.source.path}:${side.source.revision}`
  )
  return `${path}|${identity(comparison.left)}|${identity(comparison.right)}`
}

function comparisonHighlightIdentity(
  value: string,
  comparison: WorkspaceComparison | undefined,
) {
  if (!comparison) return value
  const side = (candidate: WorkspaceComparison['left']) => [
    candidate.source.kind,
    candidate.source.path,
    candidate.source.revision,
    candidate.state,
    candidate.exists ? 'exists' : 'missing',
    candidate.content ?? '',
  ].join('\0')
  return `${value}\0left\0${side(comparison.left)}\0right\0${side(comparison.right)}`
}

const plainHighlightResult: WorkspaceDiffHighlightResult = {
  engine: 'plain',
  tokensByRowId: {},
  wordRangesByRowId: {},
}

function tokenStyle(token: WorkspaceDiffHighlightToken): CSSProperties {
  const fontStyle = token.fontStyle ?? 0
  return {
    color: token.color,
    fontStyle: fontStyle & 1 ? 'italic' : undefined,
    fontWeight: fontStyle & 2 ? 700 : undefined,
    textDecoration: [
      fontStyle & 4 ? 'underline' : '',
      fontStyle & 8 ? 'line-through' : '',
    ].filter(Boolean).join(' ') || undefined,
  }
}

function overlapsRange(start: number, end: number, ranges: WorkspaceDiffWordRange[]) {
  return ranges.some((range) => start < range.end && end > range.start)
}

const HighlightedLine = memo(function HighlightedLine({
  row,
  tokens,
  wordRanges,
  emphasizeWholeLine,
}: {
  row: WorkspaceDiffRow
  tokens: WorkspaceDiffHighlightToken[]
  wordRanges: WorkspaceDiffWordRange[]
  emphasizeWholeLine: boolean
}) {
  const wholeLineDifference = emphasizeWholeLine
    && isDifferenceRow(row)
    && wordRanges.length === 0
  let offset = 0
  return (
    <>
      {tokens.map((token, tokenIndex) => {
        const tokenStart = offset
        const tokenEnd = tokenStart + token.content.length
        offset = tokenEnd
        const boundaries = new Set([tokenStart, tokenEnd])
        wordRanges.forEach((range) => {
          if (range.start > tokenStart && range.start < tokenEnd) boundaries.add(range.start)
          if (range.end > tokenStart && range.end < tokenEnd) boundaries.add(range.end)
        })
        const points = [...boundaries].sort((left, right) => left - right)
        return points.slice(0, -1).map((start, partIndex) => {
          const end = points[partIndex + 1]!
          const changed = wholeLineDifference || overlapsRange(start, end, wordRanges)
          const style = tokenStyle(token)
          return (
            <span
              key={`${tokenIndex}-${partIndex}`}
              data-diff-word-change={changed ? row.kind : undefined}
              className={changed
                ? 'bg-[var(--color-diff-removed-word)] text-[var(--color-diff-removed-text)]'
                : undefined}
              style={{
                ...style,
                color: changed ? 'var(--color-diff-removed-text)' : style.color,
              }}
            >
              {token.content.slice(start - tokenStart, end - tokenStart)}
            </span>
          )
        })
      })}
    </>
  )
})

function cellTone(row: WorkspaceDiffRow | null) {
  if (!row) return 'bg-[var(--color-code-bg)]'
  if (row.kind === 'addition' || row.kind === 'deletion') {
    return 'bg-[var(--color-diff-removed-bg)]'
  }
  if (row.kind === 'hunk') return 'bg-[var(--color-diff-highlight-bg)]'
  return 'bg-[var(--color-code-bg)] hover:bg-[var(--color-surface-hover)]'
}

function isDifferenceRow(row: WorkspaceDiffRow) {
  return row.kind === 'addition' || row.kind === 'deletion'
}

function rowLine(row: WorkspaceDiffRow, side: 'old' | 'new') {
  return side === 'old' ? row.oldLine : row.newLine
}

interface CommentDraft {
  anchorId: string
  selection: WorkspaceDiffSelection
  note: string
}

interface InlineEditDraft {
  sourceSide: WorkspaceComparisonSourceSide
  lineNumber: number
  revision: number
  text: string
}

type ManualAlignmentDraft =
  | { phase: 'left'; revision: number; previousViewMode: WorkspaceSideBySideViewMode; previousShowAllRows: boolean }
  | { phase: 'right'; revision: number; leftLine: number; previousViewMode: WorkspaceSideBySideViewMode; previousShowAllRows: boolean }
  | { phase: 'ready'; revision: number; leftLine: number; rightLine: number; previousViewMode: WorkspaceSideBySideViewMode; previousShowAllRows: boolean }

export function WorkspaceSideBySideDiffSurface({
  value,
  comparison,
  path,
  className = 'min-h-0 flex-1 overflow-auto bg-[var(--color-code-bg)]',
  lineLimit = WORKSPACE_PREVIEW_LINE_LIMIT,
  hideSingleFileHeader = false,
  onAddComment,
  renderHunkAction,
  comparisonSession,
  onComparisonSessionChange,
  onSave,
  saving = false,
  saveError,
  onEncodingChange,
  encodingChangingSide,
  fullOnlyDisabledReason,
  textPair,
  modelOverride,
}: WorkspaceSideBySideDiffSurfaceProps) {
  const t = useTranslation()
  const effectiveComparison = useMemo(() => comparisonSession
    ? workspaceComparisonSessionToComparison(comparisonSession)
    : comparison, [comparison, comparisonSession])
  const comparisonSettings = useMemo(
    () => comparisonSession?.comparisonSettings ?? createDefaultWorkspaceComparisonSettings(path),
    [comparisonSession?.comparisonSettings, path],
  )
  const workerAvailable = typeof Worker !== 'undefined'
  const needsWorker = workerAvailable
    && hasCompleteComparisonContent(effectiveComparison)
    && (
      comparisonSettings.profile !== 'fast'
      || comparisonSettings.language === 'cpp'
      || comparisonSettings.rules.some((rule) => rule.enabled)
    )
  const sourceIdentity = comparisonSourceIdentity(effectiveComparison, path)
  const [runtimeModel, setRuntimeModel] = useState<{
    sourceIdentity: string
    comparisonReference: WorkspaceComparison | undefined
    sessionRevision: number
    settingsRevision: number
    model: ReturnType<typeof buildWorkspaceSideBySideModel>
  } | null>(null)
  const synchronousModel = useMemo(
    () => modelOverride
      ?? (textPair
      ? buildWorkspaceSideBySideTextPairModel(textPair, path, comparisonSettings)
      : needsWorker
      ? null
      : buildWorkspaceSideBySideModel(value, effectiveComparison, path, comparisonSession?.manualAnchors, comparisonSettings)),
    [comparisonSession?.manualAnchors, comparisonSettings, effectiveComparison, modelOverride, needsWorker, path, textPair, value],
  )
  const lastTrustedModel = runtimeModel?.sourceIdentity === sourceIdentity ? runtimeModel : null
  const patchFallbackModel = useMemo(
    () => needsWorker && !lastTrustedModel
      ? buildWorkspaceSideBySideModel(value, undefined, path)
      : null,
    [lastTrustedModel, needsWorker, path, value],
  )
  const runtimeRequestRef = useRef(0)
  useEffect(() => {
    if (!needsWorker) {
      runtimeRequestRef.current += 1
      return
    }
    const requestRevision = ++runtimeRequestRef.current
    const sessionRevision = comparisonSession?.revision ?? 0
    const settingsRevision = comparisonSession?.settingsRevision ?? 0
    void requestWorkspaceComparisonModel({
      sessionRevision,
      settingsRevision,
      value,
      comparison: effectiveComparison,
      path,
      anchors: comparisonSession?.manualAnchors ?? [],
      settings: comparisonSettings,
    }).then((result) => {
      if (runtimeRequestRef.current !== requestRevision) return
      if (result.sessionRevision !== sessionRevision || result.settingsRevision !== settingsRevision) return
      setRuntimeModel({
        sourceIdentity,
        comparisonReference: effectiveComparison,
        sessionRevision,
        settingsRevision,
        model: result.model,
      })
    }).catch(() => {
      if (runtimeRequestRef.current !== requestRevision) return
      const fallbackSettings = {
        ...comparisonSettings,
        profile: 'fast' as const,
        language: 'text' as const,
        rules: [],
      }
      setRuntimeModel({
        sourceIdentity,
        comparisonReference: effectiveComparison,
        sessionRevision,
        settingsRevision,
        model: buildWorkspaceSideBySideModel(
          value,
          effectiveComparison,
          path,
          comparisonSession?.manualAnchors,
          fallbackSettings,
        ),
      })
    })
    return () => { runtimeRequestRef.current += 1 }
  }, [comparisonSession?.manualAnchors, comparisonSession?.revision, comparisonSession?.settingsRevision, comparisonSettings, effectiveComparison, needsWorker, path, sourceIdentity, value])
  const runtimeModelCurrent = lastTrustedModel
    && lastTrustedModel.comparisonReference === effectiveComparison
    && lastTrustedModel.sessionRevision === (comparisonSession?.revision ?? 0)
    && lastTrustedModel.settingsRevision === (comparisonSession?.settingsRevision ?? 0)
  const recomputing = needsWorker && !runtimeModelCurrent
  const model = synchronousModel ?? lastTrustedModel?.model ?? patchFallbackModel!
  const files = model.files
  const [viewMode, setViewMode] = useState<WorkspaceSideBySideViewMode>('context')
  const [swapped, setSwapped] = useState(false)
  const [activeSectionId, setActiveSectionId] = useState<string | null>(null)
  const [editingSide, setEditingSide] = useState<WorkspaceComparisonSourceSide | null>(null)
  const [editDraft, setEditDraft] = useState('')
  const [inlineEditDraft, setInlineEditDraft] = useState<InlineEditDraft | null>(null)
  const [manualAlignmentDraft, setManualAlignmentDraft] = useState<ManualAlignmentDraft | null>(null)
  const [manualAlignmentError, setManualAlignmentError] = useState<string | null>(null)
  const [showComparisonSettings, setShowComparisonSettings] = useState(false)
  const pendingActiveSectionIndexRef = useRef<number | null>(null)
  const lastMutationSectionIndexRef = useRef<number | null>(null)
  const pendingScrollSectionIdRef = useRef<string | null>(null)
  const rowElementsRef = useRef(new Map<string, HTMLDivElement>())
  const projectedFiles = useMemo(() => files.map((file) => ({
    file,
    items: projectWorkspaceSideBySideFile(file, viewMode),
  })), [files, viewMode])
  const sourceFiles = useMemo(() => files.map((file) => file.source), [files])
  const displayRows = useMemo(() => projectedFiles.flatMap(({ items }) => items.flatMap((item) => (
    item.kind === 'row' ? [item.row] : []
  ))), [projectedFiles])
  const [showAllRows, setShowAllRows] = useState(false)
  const visibleRowIds = useMemo(() => new Set(
    (showAllRows ? displayRows : displayRows.slice(0, lineLimit)).map((row) => row.id),
  ), [displayRows, lineLimit, showAllRows])
  const allSourceRows = useMemo(() => sourceFiles.flatMap((file) => (
    (['old', 'new'] as const).flatMap((side) => file.rows.filter((row) => row.side === side))
  )), [sourceFiles])
  const lineNumberCharacters = useMemo(() => allSourceRows.reduce((maximum, row) => Math.max(
    maximum,
    row.oldLine === null ? 0 : String(row.oldLine).length,
    row.newLine === null ? 0 : String(row.newLine).length,
  ), 3), [allSourceRows])
  const gutterWidth = `${lineNumberCharacters + 3}ch`
  const usePlainLargePreview = allSourceRows.length > WORKSPACE_PLAIN_TEXT_LINE_THRESHOLD
  const highlightCacheKey = useMemo(
    () => createWorkspaceDiffHighlightCacheKey(
      path,
      comparisonHighlightIdentity(value, effectiveComparison),
    ),
    [effectiveComparison, path, value],
  )
  const [highlightState, setHighlightState] = useState<{
    cacheKey: string | null
    result: WorkspaceDiffHighlightResult
  }>({ cacheKey: null, result: plainHighlightResult })
  const highlightResult = !usePlainLargePreview && highlightState.cacheKey === highlightCacheKey
    ? highlightState.result
    : plainHighlightResult
  const [commentDraft, setCommentDraft] = useState<CommentDraft | null>(null)
  const editorRef = useRef<HTMLTextAreaElement>(null)

  const modeItems = useMemo(() => {
    const unavailableTitle = fullOnlyDisabledReason ?? (
      model.fullViewUnavailableReason
        ? t(`workspace.diffView.unavailable.${model.fullViewUnavailableReason}`)
        : undefined
    )
    return ([
    { value: 'all' as const, label: t('workspace.diffView.mode.all') },
    { value: 'differences' as const, label: t('workspace.diffView.mode.differences') },
    { value: 'context' as const, label: t('workspace.diffView.mode.context') },
    { value: 'same' as const, label: t('workspace.diffView.mode.same') },
  ]).map((item) => ({
    ...item,
    disabled: (item.value === 'all' || item.value === 'same') && Boolean(unavailableTitle),
    title: (item.value === 'all' || item.value === 'same') && unavailableTitle
      ? unavailableTitle
      : undefined,
    }))
  }, [fullOnlyDisabledReason, model.fullViewUnavailableReason, t])
  const activeSectionIndex = activeSectionId
    ? model.sections.findIndex((section) => section.id === activeSectionId)
    : -1
  const sectionByRowId = useMemo<ReadonlyMap<string, WorkspaceSideBySideDiffSection>>(() => new Map(
    model.sections.flatMap((section) => section.rowIds.map((rowId) => [rowId, section] as const)),
  ), [model.sections])
  const hasPreviousSection = activeSectionIndex > 0
  const hasNextSection = model.sections.length > 0 && activeSectionIndex < model.sections.length - 1

  useEffect(() => {
    if (usePlainLargePreview) {
      setHighlightState({ cacheKey: null, result: plainHighlightResult })
      return
    }
    let cancelled = false
    setHighlightState({ cacheKey: null, result: plainHighlightResult })
    requestWorkspaceDiffHighlight({ cacheKey: highlightCacheKey, files: sourceFiles, path }).then((result) => {
      if (!cancelled) setHighlightState({ cacheKey: highlightCacheKey, result })
    })
    return () => {
      cancelled = true
    }
  }, [highlightCacheKey, path, sourceFiles, usePlainLargePreview])

  useEffect(() => {
    setCommentDraft(null)
    setShowAllRows(false)
  }, [path, value])

  useEffect(() => {
    if (
      manualAlignmentDraft
      && comparisonSession
      && manualAlignmentDraft.revision !== comparisonSession.revision
    ) {
      setViewMode(manualAlignmentDraft.previousViewMode)
      setShowAllRows(manualAlignmentDraft.previousShowAllRows)
      setManualAlignmentDraft(null)
      setManualAlignmentError(t('workspace.manualAlignment.error.stale_selection'))
    }
  }, [comparisonSession?.revision, manualAlignmentDraft, t])

  useEffect(() => {
    if (model.fullViewUnavailableReason && (viewMode === 'all' || viewMode === 'same')) {
      setViewMode('context')
    }
  }, [model.fullViewUnavailableReason, viewMode])

  useEffect(() => {
    const desiredIndex = pendingActiveSectionIndexRef.current
    if (desiredIndex !== null) {
      const nextSection = model.sections[Math.min(desiredIndex, Math.max(0, model.sections.length - 1))]
      setActiveSectionId(nextSection?.id ?? null)
      pendingActiveSectionIndexRef.current = null
      return
    }
    if (activeSectionId && !model.sections.some((section) => section.id === activeSectionId)) {
      setActiveSectionId(null)
    }
  }, [activeSectionId, model.sections])

  useEffect(() => {
    const sectionId = pendingScrollSectionIdRef.current
    if (!sectionId) return
    const section = model.sections.find((candidate) => candidate.id === sectionId)
    const target = section?.rowIds.find((rowId) => rowElementsRef.current.has(rowId))
    if (!target) return
    rowElementsRef.current.get(target)?.scrollIntoView?.({ block: 'center' })
    pendingScrollSectionIdRef.current = null
  }, [model.sections, projectedFiles, showAllRows, viewMode])

  useEffect(() => {
    if (commentDraft) editorRef.current?.focus()
  }, [commentDraft])

  useEffect(() => {
    if (
      inlineEditDraft
      && (!comparisonSession || inlineEditDraft.revision !== comparisonSession.revision)
    ) setInlineEditDraft(null)
  }, [comparisonSession?.revision, inlineEditDraft])

  const sideLabel = (side: 'old' | 'new') => t(`workspace.diffReview.side.${side}`)
  const sourceSideLabel = (side: WorkspaceComparisonSourceSide) => (
    side === 'left' ? sideLabel('old') : sideLabel('new')
  )
  const capabilityMessage = (side: WorkspaceComparisonSourceSide) => {
    const capability = getWorkspaceComparisonCapability(comparisonSession, side)
    if (capability.allowed) return null
    return t(`workspace.diffEdit.disabled.${capability.reason ?? 'unavailable'}`)
  }

  const manualAlignmentDisabledReason = (() => {
    if (fullOnlyDisabledReason) return fullOnlyDisabledReason
    if (!comparisonSession || model.kind !== 'comparison') {
      return t('workspace.manualAlignment.disabled.incomplete')
    }
    if (
      !comparisonSession.left.exists
      || !comparisonSession.right.exists
      || countWorkspaceManualAlignmentLines(comparisonSession.left.content) === 0
      || countWorkspaceManualAlignmentLines(comparisonSession.right.content) === 0
    ) return t('workspace.manualAlignment.disabled.no_lines')
    return null
  })()

  const selectManualAlignmentLine = (
    sourceSide: WorkspaceComparisonSourceSide,
    lineNumber: number,
  ) => {
    if (!manualAlignmentDraft) return
    if (manualAlignmentDraft.phase === 'left' && sourceSide === 'left') {
      setManualAlignmentDraft({
        ...manualAlignmentDraft,
        phase: 'right',
        leftLine: lineNumber,
      })
      return
    }
    if (manualAlignmentDraft.phase === 'right' && sourceSide === 'right') {
      setManualAlignmentDraft({
        ...manualAlignmentDraft,
        phase: 'ready',
        rightLine: lineNumber,
      })
    }
  }

  const closeManualAlignmentDraft = () => {
    if (manualAlignmentDraft) {
      setViewMode(manualAlignmentDraft.previousViewMode)
      setShowAllRows(manualAlignmentDraft.previousShowAllRows)
    }
    setManualAlignmentDraft(null)
  }

  const confirmManualAlignment = () => {
    if (!comparisonSession || manualAlignmentDraft?.phase !== 'ready') return
    const outcome = addWorkspaceManualAlignmentAnchor(
      comparisonSession,
      manualAlignmentDraft.leftLine,
      manualAlignmentDraft.rightLine,
      manualAlignmentDraft.revision,
    )
    if (outcome.state === 'error') {
      setManualAlignmentError(t(`workspace.manualAlignment.error.${outcome.reason}`))
      return
    }
    closeManualAlignmentDraft()
    setManualAlignmentError(null)
    onComparisonSessionChange?.(outcome.session)
  }

  const beginEdit = (side: WorkspaceComparisonSourceSide) => {
    if (!comparisonSession || !getWorkspaceComparisonCapability(comparisonSession, side).allowed) return
    setEditingSide(side)
    setEditDraft(comparisonSession[side].content)
  }

  const applyEdit = () => {
    if (!comparisonSession || !editingSide) return
    const next = editWorkspaceComparisonSide(comparisonSession, editingSide, editDraft)
    if (next !== comparisonSession) {
      pendingActiveSectionIndexRef.current = Math.max(0, activeSectionIndex)
      onComparisonSessionChange?.(next)
    }
    setEditingSide(null)
  }

  const beginInlineEdit = (
    sourceSide: WorkspaceComparisonSourceSide,
    lineNumber: number,
    text: string,
  ) => {
    if (
      !comparisonSession
      || !onComparisonSessionChange
      || !getWorkspaceComparisonCapability(comparisonSession, sourceSide).allowed
    ) return
    setCommentDraft(null)
    setInlineEditDraft({
      sourceSide,
      lineNumber,
      revision: comparisonSession.revision,
      text,
    })
  }

  const applyInlineEdit = () => {
    if (!comparisonSession || !inlineEditDraft) return
    if (comparisonSession.revision !== inlineEditDraft.revision) {
      setInlineEditDraft(null)
      return
    }
    const next = editWorkspaceComparisonLine(
      comparisonSession,
      inlineEditDraft.sourceSide,
      inlineEditDraft.lineNumber,
      inlineEditDraft.text,
      inlineEditDraft.revision,
    )
    if (next !== comparisonSession) {
      pendingActiveSectionIndexRef.current = Math.max(0, activeSectionIndex)
      onComparisonSessionChange?.(next)
    }
    setInlineEditDraft(null)
  }

  const mergeSection = (sectionId: string, sourceSide: WorkspaceComparisonSourceSide) => {
    if (!comparisonSession) return
    const sectionIndex = model.sections.findIndex((section) => section.id === sectionId)
    const next = mergeWorkspaceComparisonSection(comparisonSession, model, sectionId, sourceSide)
    if (next === comparisonSession) return
    pendingActiveSectionIndexRef.current = Math.max(0, sectionIndex)
    lastMutationSectionIndexRef.current = Math.max(0, sectionIndex)
    onComparisonSessionChange?.(next)
  }

  const navigateToSection = (direction: 'previous' | 'next') => {
    const targetIndex = direction === 'previous'
      ? activeSectionIndex - 1
      : activeSectionIndex + 1
    const target = model.sections[targetIndex]
    if (!target) return
    if (viewMode === 'same') setViewMode('context')
    setShowAllRows(true)
    setActiveSectionId(target.id)
    pendingScrollSectionIdRef.current = target.id
  }

  const submitComment = () => {
    if (!commentDraft) return
    const note = commentDraft.note.trim()
    if (!note) return
    const { side, lineStart, lineEnd, quote, hunkId } = commentDraft.selection
    onAddComment?.({
      side,
      lineStart,
      lineEnd,
      quote,
      hunkId,
    }, note)
    setCommentDraft(null)
  }

  const beginComment = (row: WorkspaceDiffRow, extend: boolean) => {
    const anchorId = extend && commentDraft ? commentDraft.anchorId : row.id
    const selection = getCompatibleDiffRange(allSourceRows, anchorId, row.id)
      ?? getCompatibleDiffRange(allSourceRows, row.id, row.id)
    if (!selection) return
    setCommentDraft((current) => ({
      anchorId: selection.startId === selection.endId ? row.id : anchorId,
      selection,
      note: current?.note ?? '',
    }))
  }

  const renderCell = (
    row: WorkspaceDiffRow | null,
    side: 'old' | 'new',
    lineEndingDifference?: { left: string; right: string },
  ) => {
    if (!row) {
      return (
        <div
          aria-hidden="true"
          data-diff-placeholder=""
          data-diff-tone="placeholder"
          data-side={side}
          className="grid min-h-5 border-r border-[var(--color-border)]"
          style={{ gridTemplateColumns: `${gutterWidth} minmax(max-content, 1fr)` }}
        >
          <span aria-hidden="true" className="bg-[var(--color-code-bg)]" />
          <span
            aria-hidden="true"
            data-diff-placeholder-fill=""
            className="bg-[var(--color-surface-container-high)]"
            style={{
              backgroundImage: 'repeating-linear-gradient(135deg, transparent 0, transparent 5px, var(--color-border) 5px, var(--color-border) 6px)',
            }}
          />
        </div>
      )
    }
    const line = rowLine(row, side)
    const canComment = Boolean(onAddComment && row.selectable && row.side === side && line !== null)
    const selected = commentDraft?.selection.rowIds.includes(row.id) ?? false
    const sourceSide: WorkspaceComparisonSourceSide = side === 'old' ? 'left' : 'right'
    const inlineEditing = inlineEditDraft?.sourceSide === sourceSide
      && inlineEditDraft.lineNumber === line
    const canInlineEdit = Boolean(
      line !== null
      && row.selectable
      && comparisonSession
      && onComparisonSessionChange
      && !manualAlignmentDraft
      && getWorkspaceComparisonCapability(comparisonSession, sourceSide).allowed,
    )
    const selectableForManualAlignment = line !== null && (
      (manualAlignmentDraft?.phase === 'left' && sourceSide === 'left')
      || (manualAlignmentDraft?.phase === 'right' && sourceSide === 'right')
    )
    return (
      <div
        data-diff-cell=""
        data-diff-tone={isDifferenceRow(row) ? 'difference' : 'normal'}
        data-side={side}
        className={`group grid min-h-5 border-r border-[var(--color-border)] ${cellTone(row)}`}
        style={{ gridTemplateColumns: `${gutterWidth} minmax(max-content, 1fr)` }}
      >
        <span className="relative flex select-none items-center justify-end bg-[var(--color-code-bg)] pl-[2ch] pr-[1ch] text-[11px] tabular-nums text-[var(--color-text-tertiary)] group-hover:bg-[var(--color-surface-hover)]">
          {selectableForManualAlignment ? (
            <button
              type="button"
              data-diff-line-number=""
              data-side={side}
              aria-label={t('workspace.manualAlignment.selectLine', {
                side: sourceSideLabel(sourceSide),
                line: line ?? '',
                source: sourceSide,
              })}
              onClick={() => selectManualAlignmentLine(sourceSide, line!)}
              className="rounded px-1 hover:bg-[var(--color-info)] hover:text-[var(--color-surface)]"
            >
              {line ?? ''}
            </button>
          ) : <span data-diff-line-number="" data-side={side}>{line ?? ''}</span>}
          {canComment && (
            <button
              type="button"
              aria-label={t('workspace.diffReview.commentLineAria', {
                path,
                side: sideLabel(side),
                line: line ?? '',
              })}
              aria-pressed={selected}
              onClick={(event) => beginComment(row, event.shiftKey)}
              className={`absolute inset-y-0 right-0 inline-flex w-5 items-center justify-center rounded-[var(--radius-sm)] text-[var(--color-text-tertiary)] opacity-0 transition-[color,background-color,opacity,transform] duration-100 hover:bg-[var(--color-info)] hover:text-[var(--color-surface)] active:scale-[0.96] group-hover:opacity-100 focus:opacity-100 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-[-1px] focus-visible:outline-[var(--color-info)] ${selected ? 'bg-[var(--color-info)] text-[var(--color-surface)] opacity-100' : ''}`}
            >
              {selected ? <MessageSquare aria-hidden="true" size={12} /> : <Plus aria-hidden="true" size={13} />}
            </button>
          )}
        </span>
        <span
          data-row-text={row.text}
          data-inline-editing={inlineEditing ? '' : undefined}
          onDoubleClick={() => {
            if (canInlineEdit) beginInlineEdit(sourceSide, line!, row.text)
          }}
          className="flex min-w-max items-center px-3 whitespace-pre"
        >
          {inlineEditing && inlineEditDraft ? (
            <span className="flex min-w-[28rem] flex-1 items-center gap-1.5 py-0.5">
              <input
                autoFocus
                aria-label={t('workspace.diffEdit.inlineEditorLabel', {
                  side: sourceSideLabel(sourceSide),
                  line,
                })}
                value={inlineEditDraft.text}
                onChange={(event) => setInlineEditDraft((current) => current
                  ? { ...current, text: event.target.value }
                  : null)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
                    event.preventDefault()
                    applyInlineEdit()
                  }
                  if (event.key === 'Escape') {
                    event.preventDefault()
                    setInlineEditDraft(null)
                  }
                }}
                spellCheck={false}
                className="h-7 min-w-0 flex-1 rounded border border-[var(--color-border-focus)] bg-[var(--color-surface-container-lowest)] px-2 font-mono text-[13px] text-[var(--color-code-fg)] outline-none"
              />
              <IconButton
                icon={<CornerDownLeft aria-hidden="true" />}
                label={t('workspace.diffEdit.inlineApply', { line })}
                size="sm"
                onClick={applyInlineEdit}
              />
              <IconButton
                icon={<X aria-hidden="true" />}
                label={t('common.cancel')}
                size="sm"
                onClick={() => setInlineEditDraft(null)}
              />
            </span>
          ) : (
            <>
              <span className={`whitespace-pre ${isDifferenceRow(row) ? 'text-[var(--color-diff-removed-text)]' : ''} ${row.kind === 'metadata' ? 'font-semibold text-[var(--color-text-secondary)]' : ''} ${row.kind === 'hunk' ? 'font-semibold text-[var(--color-warning)]' : ''}`}>
                {row.selectable && row.text && highlightResult.tokensByRowId[row.id]
                  ? (
                      <HighlightedLine
                        row={row}
                        tokens={highlightResult.tokensByRowId[row.id]!}
                        wordRanges={highlightResult.wordRangesByRowId[row.id] ?? []}
                        emphasizeWholeLine={!lineEndingDifference}
                      />
                    )
                  : row.text || ' '}
              </span>
              {lineEndingDifference && (side === 'old' ? lineEndingDifference.left : lineEndingDifference.right) === '' && (
                <span
                  data-line-ending-difference="no-final-newline"
                  className="ml-3 select-none italic text-[var(--color-text-tertiary)]"
                >
                  {t('workspace.comparisonInput.noFinalNewline')}
                </span>
              )}
              {canInlineEdit && (
                <button
                  type="button"
                  aria-label={t('workspace.diffEdit.inlineEdit', {
                    side: sourceSideLabel(sourceSide),
                    line: line ?? '',
                  })}
                  onClick={() => beginInlineEdit(sourceSide, line!, row.text)}
                  className="ml-2 inline-flex h-5 w-5 shrink-0 items-center justify-center rounded text-[var(--color-text-tertiary)] opacity-0 hover:bg-[var(--color-surface-hover)] hover:text-[var(--color-text-primary)] group-hover:opacity-100 focus:opacity-100 focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--color-info)]"
                >
                  <Pencil aria-hidden="true" size={12} />
                </button>
              )}
            </>
          )}
        </span>
      </div>
    )
  }

  const renderExistenceCell = (sourceSide: WorkspaceComparisonSourceSide, visualSide: 'old' | 'new') => {
    const exists = effectiveComparison?.[sourceSide].exists ?? false
    return (
      <div
        data-testid={`workspace-diff-existence-${sourceSide}`}
        data-source-exists={String(exists)}
        data-side={visualSide}
        className="grid min-h-5 border-r border-[var(--color-border)] bg-[var(--color-diff-highlight-bg)] text-[var(--color-text-secondary)]"
        style={{ gridTemplateColumns: `${gutterWidth} minmax(max-content, 1fr)` }}
      >
        <span aria-hidden="true" className="bg-[var(--color-code-bg)]" />
        <span className="flex min-w-max items-center px-3 italic">
          {exists ? '0 B' : t('workspace.previewState.missing')}
        </span>
      </div>
    )
  }

  const renderEditor = () => commentDraft && (
    <div className="col-span-2 border-y border-[var(--color-border)] bg-[var(--color-surface-container-low)] px-3 py-2">
      <div className="mx-auto max-w-3xl overflow-hidden rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-surface-container-lowest)] shadow-[var(--shadow-card)]">
        <div className="flex min-h-9 items-center gap-2 px-3 pt-2">
          <MessageSquare aria-hidden="true" size={14} className="text-[var(--color-text-secondary)]" />
          <span className="text-[12px] font-semibold text-[var(--color-text-primary)]">{t('workspace.localComment')}</span>
          <span className="ml-auto text-[11px] text-[var(--color-text-tertiary)]">
            {sideLabel(commentDraft.selection.side)} L{commentDraft.selection.lineStart}{commentDraft.selection.lineEnd === commentDraft.selection.lineStart ? '' : `-L${commentDraft.selection.lineEnd}`}
          </span>
        </div>
        <textarea
          ref={editorRef}
          aria-label={t('workspace.diffReview.editorLabel')}
          value={commentDraft.note}
          placeholder={t('workspace.commentPlaceholder')}
          onChange={(event) => setCommentDraft((current) => current ? { ...current, note: event.target.value } : null)}
          onKeyDown={(event) => {
            if (event.key === 'Escape') setCommentDraft(null)
            if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) submitComment()
          }}
          rows={2}
          className="block w-full resize-y bg-transparent px-3 py-2 font-[var(--font-body)] text-[13px] leading-5 text-[var(--color-text-primary)] outline-none placeholder:text-[var(--color-text-tertiary)]"
        />
        <div className="flex items-center justify-end gap-2 px-2 pb-2">
          <Button variant="ghost" size="base" onClick={() => setCommentDraft(null)}>{t('common.cancel')}</Button>
          <button
            type="button"
            aria-label={t('workspace.diffReview.submitAria')}
            disabled={!commentDraft.note.trim()}
            onClick={submitComment}
            className="inline-flex h-8 items-center justify-center gap-1.5 rounded-[var(--radius-md)] bg-[var(--color-info)] px-3 text-[12px] font-medium text-[var(--color-surface)] hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-border-focus)] disabled:cursor-not-allowed disabled:opacity-35"
          >
            <CornerDownLeft aria-hidden="true" size={14} />
            <span>{t('workspace.diffReview.submit')}</span>
          </button>
        </div>
      </div>
    </div>
  )

  const visualSides = swapped ? (['new', 'old'] as const) : (['old', 'new'] as const)
  const unavailableMessage = !recomputing && model.fullViewUnavailableReason
    ? t(`workspace.diffView.unavailable.${model.fullViewUnavailableReason}`)
    : null

  const renderProjectedItem = (item: WorkspaceSideBySideViewItem) => {
    if (item.kind === 'separator') {
      return (
        <div
          key={item.id}
          data-diff-separator=""
          className="grid min-w-full grid-cols-2 border-y border-[var(--color-border)] bg-[var(--color-surface-container)] text-center text-[11px] text-[var(--color-text-tertiary)]"
        >
          <span className="col-span-2 py-0.5">
            {item.hiddenCount === null
              ? t('workspace.diffView.hiddenUnknown')
              : t('workspace.diffView.hiddenLines', { count: item.hiddenCount })}
          </span>
        </div>
      )
    }
    const pair = item.row
    if (!visibleRowIds.has(pair.id)) return null
    const section = sectionByRowId.get(pair.id)
    const active = activeSectionId !== null && section?.id === activeSectionId
    const isSectionFirstRow = section?.rowIds[0] === pair.id
    return (
      <div
        key={pair.id}
        ref={(element) => {
          if (element) rowElementsRef.current.set(pair.id, element)
          else rowElementsRef.current.delete(pair.id)
        }}
        data-side-by-side-row=""
        data-testid={pair.manualAnchorId
          ? `workspace-manual-anchor-row-${pair.manualAnchorId}`
          : pair.kind === 'existence'
            ? 'workspace-diff-existence-row'
            : undefined}
        data-active-diff-section={active ? '' : undefined}
        role="row"
        className={`grid min-w-full grid-cols-2 ${active ? 'outline outline-1 outline-offset-[-1px] outline-[var(--color-info)]' : ''}`}
      >
        {isSectionFirstRow && section && comparisonSession && (
          <div
            data-testid={`workspace-diff-merge-actions-${section.id}`}
            className="col-span-2 flex items-center justify-center gap-2 border-y border-[var(--color-border)] bg-[var(--color-surface-container-low)] px-2 py-1"
          >
            {(['left', 'right'] as const).map((sourceSide) => {
              const targetSide = sourceSide === 'left' ? 'right' : 'left'
              const reason = capabilityMessage(targetSide)
              const sourceVisualPane = sourceSide === 'left' ? 'old' : 'new'
              const pointsRight = visualSides[0] === sourceVisualPane
              const label = t('workspace.diffEdit.merge', {
                source: sourceSideLabel(sourceSide),
                target: sourceSideLabel(targetSide),
              })
              const reasonId = reason
                ? `workspace-diff-merge-reason-${section.id}-${sourceSide}`
                : undefined
              return (
                <span key={sourceSide} title={reason ?? label}>
                  <IconButton
                    label={label}
                    showTooltip={!reason}
                    size="xs"
                    tone="muted"
                    bordered
                    disabled={Boolean(reason)}
                    aria-describedby={reasonId}
                    data-source-side={sourceSide}
                    data-target-side={targetSide}
                    onClick={() => mergeSection(section.id, sourceSide)}
                    icon={(
                      <ArrowRight
                        aria-hidden="true"
                        data-merge-arrow-direction={pointsRight ? 'right' : 'left'}
                        className={pointsRight ? undefined : 'rotate-180'}
                        style={{ color: 'var(--color-warning)' }}
                      />
                    )}
                  />
                  {reason && <span id={reasonId} className="sr-only">{reason}</span>}
                </span>
              )
            })}
          </div>
        )}
        {visualSides.map((side) => (
          <div key={side} data-visual-pane={side} className="contents">
            {pair.kind === 'existence'
              ? renderExistenceCell(side === 'old' ? 'left' : 'right', side)
              : renderCell(side === 'old' ? pair.left : pair.right, side, pair.lineEndingDifference)}
          </div>
        ))}
        {commentDraft && (pair.left?.id === commentDraft.selection.endId || pair.right?.id === commentDraft.selection.endId)
          ? renderEditor()
          : null}
        {isSectionFirstRow && section.sourceGroupId ? renderHunkAction?.(section.sourceGroupId) : null}
      </div>
    )
  }

  return (
    <div data-testid="workspace-side-by-side-diff-scroll" className={className}>
      <div className="sticky top-0 left-0 z-[var(--z-sticky)] flex min-w-max items-center gap-2 border-b border-[var(--color-border)] bg-[var(--color-surface-glass)] px-3 py-1.5 backdrop-blur">
        <SegmentedControl
          items={modeItems}
          value={viewMode}
          onChange={setViewMode}
          label={t('workspace.diffView.modeLabel')}
          size="sm"
          appearance="raised"
        />
        <span className="ml-auto text-[11px] tabular-nums text-[var(--color-text-tertiary)]">
          {t('workspace.diffView.sectionStatus', {
            current: activeSectionIndex < 0 ? 0 : activeSectionIndex + 1,
            total: model.sections.length,
          })}
        </span>
        <IconButton
          icon={<ChevronUp aria-hidden="true" />}
          label={t('workspace.diffView.previousSection')}
          size="sm"
          disabled={!hasPreviousSection}
          onClick={() => navigateToSection('previous')}
        />
        <IconButton
          icon={<ChevronDown aria-hidden="true" />}
          label={t('workspace.diffView.nextSection')}
          size="sm"
          disabled={!hasNextSection}
          onClick={() => navigateToSection('next')}
        />
        <IconButton
          icon={<ArrowLeftRight aria-hidden="true" />}
          label={t('workspace.diffView.swapSides')}
          size="sm"
          pressed={swapped}
          onClick={() => setSwapped((current) => !current)}
        />
        <IconButton
          icon={<SlidersHorizontal aria-hidden="true" />}
          label={fullOnlyDisabledReason
            ? `${t('workspace.comparisonSettings.open')}: ${fullOnlyDisabledReason}`
            : t('workspace.comparisonSettings.open')}
          size="sm"
          pressed={showComparisonSettings}
          disabled={Boolean(fullOnlyDisabledReason)}
          onClick={() => {
            if (fullOnlyDisabledReason) return
            setShowComparisonSettings((current) => !current)
          }}
        />
        <Button
          variant="ghost"
          size="sm"
          disabled={Boolean(manualAlignmentDisabledReason) || Boolean(manualAlignmentDraft)}
          title={manualAlignmentDisabledReason ?? undefined}
          onClick={() => {
            if (!comparisonSession || manualAlignmentDisabledReason) return
            setManualAlignmentDraft({
              phase: 'left',
              revision: comparisonSession.revision,
              previousViewMode: viewMode,
              previousShowAllRows: showAllRows,
            })
            setManualAlignmentError(null)
            setViewMode('all')
            setShowAllRows(true)
          }}
          icon={<Link2 aria-hidden="true" size={13} />}
        >
          {t('workspace.manualAlignment.arm')}
        </Button>
        {comparisonSession && (
          <>
            <IconButton
              icon={<Undo2 aria-hidden="true" />}
              label={t('workspace.diffEdit.undo')}
              size="sm"
              disabled={comparisonSession.undoStack.length === 0}
              onClick={() => {
                if (lastMutationSectionIndexRef.current !== null) {
                  pendingActiveSectionIndexRef.current = lastMutationSectionIndexRef.current
                }
                onComparisonSessionChange?.(undoWorkspaceComparisonSession(comparisonSession))
              }}
            />
            <Button
              variant="primary"
              size="sm"
              disabled={!isWorkspaceComparisonSessionDirty(comparisonSession)}
              loading={saving}
              onClick={() => void onSave?.()}
              icon={<Save aria-hidden="true" size={13} />}
            >
              {t('workspace.diffEdit.save')}
            </Button>
          </>
        )}
      </div>
      {showComparisonSettings && !fullOnlyDisabledReason && (
        <WorkspaceComparisonSettingsPanel
          path={path}
          settings={comparisonSettings}
          disabledReason={comparisonSession ? null : t('workspace.comparisonSettings.disabled.incomplete')}
          onCancel={() => setShowComparisonSettings(false)}
          onApply={(draft) => {
            if (!comparisonSession) return
            const outcome = applyWorkspaceComparisonSettings(comparisonSession, draft)
            if (outcome.state !== 'ok') return
            onComparisonSessionChange?.(outcome.session)
            setShowComparisonSettings(false)
          }}
        />
      )}
      {recomputing && (
        <div role="status" className="sticky left-0 min-w-max border-b border-[var(--color-border)] bg-[var(--color-info-container)] px-3 py-1 text-[11px] text-[var(--color-text-secondary)]">
          {t('workspace.comparisonSettings.recomputing')}
        </div>
      )}
      {(model.diagnostics.alignment.some((entry) => entry.reason === 'work_unit_budget')
        || model.diagnostics.comparison.includes('rules_skipped_budget')
        || model.diagnostics.comparison.includes('lexer_fallback')) && (
        <div role="status" className="sticky left-0 min-w-max border-b border-[var(--color-border)] bg-[var(--color-warning-container)] px-3 py-1 text-[11px] text-[var(--color-on-warning-container)]">
          {model.diagnostics.comparison.includes('rules_skipped_budget')
            ? t('workspace.comparisonSettings.diagnostic.rulesSkipped')
            : model.diagnostics.comparison.includes('lexer_fallback')
              ? t('workspace.comparisonSettings.diagnostic.lexerFallback')
              : t('workspace.comparisonSettings.diagnostic.fallback', { profile: comparisonSettings.profile })}
        </div>
      )}
      {manualAlignmentDraft && (
        <div className="sticky left-0 flex min-w-max items-center gap-2 border-b border-[var(--color-border)] bg-[var(--color-info-container)] px-3 py-1.5 text-[11px] text-[var(--color-text-primary)]">
          <span>
            {manualAlignmentDraft.phase === 'left'
              ? t('workspace.manualAlignment.prompt.left')
              : manualAlignmentDraft.phase === 'right'
                ? t('workspace.manualAlignment.prompt.right', { line: manualAlignmentDraft.leftLine })
                : t('workspace.manualAlignment.prompt.ready', {
                    left: manualAlignmentDraft.leftLine,
                    right: manualAlignmentDraft.rightLine,
                  })}
          </span>
          {manualAlignmentDraft.phase === 'ready' && (
            <Button variant="primary" size="sm" onClick={confirmManualAlignment}>
              {t('workspace.manualAlignment.confirm')}
            </Button>
          )}
          <Button variant="ghost" size="sm" onClick={closeManualAlignmentDraft}>
            {t('common.cancel')}
          </Button>
        </div>
      )}
      {comparisonSession && comparisonSession.manualAnchors.length > 0 && (
        <div className="sticky left-0 flex min-w-max items-center gap-2 border-b border-[var(--color-border)] bg-[var(--color-surface-container-low)] px-3 py-1 text-[11px]">
          {comparisonSession.manualAnchors.map((anchor) => (
            <span key={anchor.id} className="inline-flex items-center gap-1 rounded border border-[var(--color-border)] px-2 py-0.5">
              <span>{anchor.state === 'stale'
                ? t('workspace.manualAlignment.stale')
                : `L${anchor.left.lineNumber} ↔ R${anchor.right.lineNumber}`}</span>
              <button
                type="button"
                aria-label={t('workspace.manualAlignment.delete', {
                  left: anchor.left.lineNumber,
                  right: anchor.right.lineNumber,
                })}
                onClick={() => onComparisonSessionChange?.(
                  removeWorkspaceManualAlignmentAnchor(comparisonSession, anchor.id),
                )}
                className="rounded px-1 hover:bg-[var(--color-surface-hover)]"
              >×</button>
            </span>
          ))}
          <Button
            variant="ghost"
            size="sm"
            onClick={() => onComparisonSessionChange?.(
              clearWorkspaceManualAlignmentAnchors(comparisonSession),
            )}
          >
            {t('workspace.manualAlignment.clear')}
          </Button>
        </div>
      )}
      {manualAlignmentError && (
        <div role="alert" className="sticky left-0 min-w-max border-b border-[var(--color-error)] bg-[var(--color-error-container)] px-3 py-1.5 text-[11px] text-[var(--color-on-error-container)]">
          {manualAlignmentError}
        </div>
      )}
      {saveError && (
        <div role="alert" className="sticky left-0 min-w-max border-b border-[var(--color-error)] bg-[var(--color-error-container)] px-3 py-1.5 text-[11px] text-[var(--color-on-error-container)]">
          {saveError}
        </div>
      )}
      {unavailableMessage && (
        <div
          role="status"
          data-testid="workspace-diff-view-degraded"
          className="sticky left-0 min-w-max border-b border-[var(--color-border)] bg-[var(--color-warning-container)] px-3 py-1.5 text-[11px] text-[var(--color-on-warning-container)]"
        >
          {t('workspace.diffView.patchNotice', { reason: unavailableMessage })}
        </div>
      )}
      {editingSide && comparisonSession ? (
        <div data-testid="workspace-diff-editor" className="sticky left-0 flex min-h-[24rem] min-w-full flex-col gap-2 bg-[var(--color-code-bg)] p-3">
          <div className="flex items-center gap-2 text-[12px] text-[var(--color-text-secondary)]">
            <Pencil aria-hidden="true" size={14} />
            <strong>{t('workspace.diffEdit.editorTitle', { side: sourceSideLabel(editingSide) })}</strong>
            <span className="ml-auto">{t('workspace.diffEdit.inMemoryNotice')}</span>
          </div>
          <textarea
            autoFocus
            aria-label={t('workspace.diffEdit.editorLabel', { side: sourceSideLabel(editingSide) })}
            value={editDraft}
            onChange={(event) => setEditDraft(event.target.value)}
            spellCheck={false}
            className="min-h-[20rem] w-full flex-1 resize-y rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-surface-container-lowest)] p-3 font-mono text-[13px] leading-5 text-[var(--color-code-fg)] outline-none focus:border-[var(--color-border-focus)]"
          />
          <div className="flex justify-end gap-2">
            <Button variant="ghost" size="sm" onClick={() => setEditingSide(null)}>{t('common.cancel')}</Button>
            <Button variant="primary" size="sm" onClick={applyEdit}>{t('workspace.diffEdit.apply')}</Button>
          </div>
        </div>
      ) : <div data-testid="workspace-side-by-side-diff-content" className="relative min-w-full w-max pb-3">
        <div
          data-workspace-code=""
          data-testid="workspace-code"
          data-highlight-engine={highlightResult.engine}
          role="grid"
          aria-label={`${path} diff`}
          className="m-0 min-w-full font-mono text-[13px] leading-5 text-[var(--color-code-fg)]"
        >
          {projectedFiles.map(({ file, items }) => {
            if (!items.some((item) => item.kind === 'row' && visibleRowIds.has(item.row.id))) return null
            const displayPath = file.newPath ?? file.oldPath ?? path
            const displayName = displayPath.split('/').pop() ?? displayPath
            const displayDirectory = displayPath.slice(0, Math.max(0, displayPath.length - displayName.length))
            const showFileHeader = !hideSingleFileHeader || files.length > 1
            return (
              <section key={file.id} aria-label={displayPath}>
                {showFileHeader && (
                  <div data-testid="workspace-side-by-side-file-header" className="sticky left-0 flex h-9 items-center gap-2 border-y border-[var(--color-border)] bg-[var(--color-surface-glass)] px-4 text-[12px]">
                    <FileCode2 aria-hidden="true" size={14} className="text-[var(--color-text-tertiary)]" />
                    <span>{displayDirectory && <span className="text-[var(--color-text-tertiary)]">{displayDirectory}</span>}<strong>{displayName}</strong></span>
                  </div>
                )}
                <div className="sticky top-10 z-[var(--z-raised)] grid min-w-full grid-cols-2 border-b border-[var(--color-border)] bg-[var(--color-surface-glass)] text-[11px] font-semibold text-[var(--color-text-secondary)] backdrop-blur">
                  {visualSides.map((side) => (
                    <div key={side} data-visual-header={side} className="flex min-w-[28rem] items-center gap-2 border-r border-[var(--color-border)] px-3 py-1.5">
                      <span>{sideLabel(side)} · {side === 'old' ? file.oldPath ?? '/dev/null' : file.newPath ?? '/dev/null'}</span>
                      {comparisonSession && (() => {
                        const sourceSide = side === 'old' ? 'left' : 'right'
                        const reason = capabilityMessage(sourceSide)
                        return (
                          <>
                            <select
                              aria-label={t('workspace.diffEncoding.sideLabel', {
                                side: sourceSideLabel(sourceSide),
                              })}
                              value={comparisonSession[sourceSide].requestedEncoding}
                              disabled={!onEncodingChange || encodingChangingSide === sourceSide}
                              onChange={(event) => void onEncodingChange?.(
                                sourceSide,
                                event.target.value as WorkspaceTextEncoding,
                              )}
                              className="ml-auto h-7 rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-surface)] px-1.5 text-[10px] font-normal text-[var(--color-text-primary)]"
                            >
                              <option value="auto">{t('workspace.encodingAuto')}</option>
                              <option value="utf8">UTF-8</option>
                              <option value="gbk">GBK</option>
                            </select>
                            <Button
                              variant="ghost"
                              size="sm"
                              disabled={Boolean(reason)}
                              title={reason ?? undefined}
                              onClick={() => beginEdit(sourceSide)}
                              icon={<Pencil aria-hidden="true" size={12} />}
                            >
                              {t('workspace.diffEdit.edit')}
                            </Button>
                          </>
                        )
                      })()}
                    </div>
                  ))}
                </div>
                {items.map(renderProjectedItem)}
              </section>
            )
          })}
          {displayRows.length === 0 && (
            <div className="sticky left-0 px-4 py-10 text-center text-[12px] text-[var(--color-text-tertiary)]">
              {t('workspace.diffView.empty')}
            </div>
          )}
        </div>
        {displayRows.length > lineLimit && (
          <div className="sticky bottom-0 left-0 flex items-center gap-3 border-t border-[var(--color-border)] bg-[var(--color-surface-container-lowest)] px-3 py-2 text-xs text-[var(--color-text-tertiary)]">
            <span>
              {showAllRows
                ? t('workspace.previewAllLines', { total: displayRows.length })
                : t('workspace.previewLineLimit', { count: visibleRowIds.size, total: displayRows.length })}
            </span>
            <Button variant="ghost" size="sm" onClick={() => setShowAllRows((current) => !current)} className="ml-auto">
              {showAllRows ? t('workspace.collapsePreview') : t('workspace.showAllLoadedLines')}
            </Button>
          </div>
        )}
      </div>}
    </div>
  )
}
