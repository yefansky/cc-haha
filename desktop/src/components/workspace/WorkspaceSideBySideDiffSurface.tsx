import {
  memo,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
} from 'react'
import {
  ArrowLeftRight,
  ArrowRight,
  ChevronDown,
  ChevronUp,
  CornerDownLeft,
  FileCode2,
  MessageSquare,
  Plus,
  Redo2,
  Save,
  SlidersHorizontal,
  Undo2,
} from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { IconButton } from '@/components/ui/IconButton'
import { SegmentedControl } from '@/components/ui/SegmentedControl'
import { useDismissable } from '@/hooks/useDismissable'
import { useAnchoredPosition } from '@/hooks/useAnchoredPosition'
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
  applyWorkspaceComparisonSettings,
  addWorkspaceManualAlignmentAnchor,
  clearWorkspaceManualAlignmentAnchors,
  editWorkspaceComparisonLine,
  getWorkspaceComparisonCapability,
  insertWorkspaceComparisonText,
  isWorkspaceComparisonSessionDirty,
  mergeWorkspaceComparisonSection,
  mergeWorkspaceComparisonRow,
  removeWorkspaceManualAlignmentAnchor,
  redoWorkspaceComparisonSession,
  undoWorkspaceComparisonSession,
  workspaceComparisonSessionToComparison,
  type WorkspaceComparisonSession,
  type WorkspaceComparisonSourceSide,
} from './workspaceComparisonSession'
import { countWorkspaceManualAlignmentLines } from './workspaceManualAlignment'
import { createDefaultWorkspaceComparisonSettings } from './workspaceComparisonSettings'
import { WorkspaceComparisonSettingsPanel } from './WorkspaceComparisonSettingsPanel'
import { requestWorkspaceComparisonModel } from './workspaceComparisonRuntime'

const EMPTY_EXPANDED_CONTEXT_SEPARATOR_IDS: ReadonlySet<string> = new Set()

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
  onSave?: (session: WorkspaceComparisonSession) => void | Promise<void>
  saving?: boolean
  saveError?: string | null
  onEncodingChange?: (
    sourceSide: WorkspaceComparisonSourceSide,
    encoding: WorkspaceTextEncoding,
  ) => void | Promise<void>
  encodingChangingSide?: WorkspaceComparisonSourceSide | null
  onRequestWriteAccess?: (sourceSide: WorkspaceComparisonSourceSide) => void | Promise<void>
  writeAccessChangingSide?: WorkspaceComparisonSourceSide | null
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

const DirectEditableLine = memo(function DirectEditableLine({
  value,
  display,
  active,
  ariaLabel,
  difference,
  onFocus,
  onChange,
  onBlur,
}: {
  value: string
  display: ReactNode
  active: boolean
  ariaLabel: string
  difference: boolean
  onFocus: () => void
  onChange: (value: string) => void
  onBlur: () => void
}) {
  return (
    <span
      data-diff-pane-natural-content=""
      data-side="new"
      className="relative grid w-max min-w-full items-stretch whitespace-pre"
    >
      <span aria-hidden="true" className="invisible col-start-1 row-start-1 px-3 whitespace-pre">
        {value || ' '}
      </span>
      <span
        aria-hidden="true"
        className={`pointer-events-none col-start-1 row-start-1 px-3 whitespace-pre ${active ? 'invisible' : ''}`}
      >
        {display}
      </span>
      <textarea
        data-testid="workspace-diff-direct-editor"
        aria-label={ariaLabel}
        aria-multiline="true"
        value={value}
        rows={Math.max(1, value.split('\n').length)}
        wrap="off"
        spellCheck={false}
        onFocus={onFocus}
        onChange={(event) => onChange(event.target.value)}
        onBlur={onBlur}
        className={`absolute inset-0 m-0 h-full w-full cursor-text resize-none overflow-hidden border-0 bg-transparent px-3 py-0 font-mono text-[13px] leading-5 outline-none caret-[var(--color-code-fg)] ${
          active
            ? difference
              ? 'text-[var(--color-diff-removed-text)]'
              : 'text-[var(--color-code-fg)]'
            : 'text-transparent'
        }`}
      />
    </span>
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

interface DirectEditDraft {
  sourceSide: WorkspaceComparisonSourceSide
  lineNumber: number
  revision: number
  mode: 'replace' | 'insert'
  originalText: string
  text: string
}

interface ManualAlignmentDraft {
  revision: number
  sourceSide: WorkspaceComparisonSourceSide
  lineNumber: number
  previousViewMode: WorkspaceSideBySideViewMode
  previousShowAllRows: boolean
}

function isNativeTextHistoryTarget(target: EventTarget | null) {
  if (!(target instanceof Element)) return false
  return Boolean(target.closest('textarea, input, [contenteditable]:not([contenteditable="false"]), [role="textbox"]'))
}

interface DiffLineContextMenu {
  rowId: string
  sourceSide: WorkspaceComparisonSourceSide
  lineNumber: number | null
  x: number
  y: number
}

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
  onRequestWriteAccess,
  writeAccessChangingSide,
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
  const projectionIdentity = `${sourceIdentity}|${comparisonSession?.revision ?? 0}|${comparisonSession?.settingsRevision ?? 0}`
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
  const [leftPanePercent, setLeftPanePercent] = useState(50)
  const [resizingPanes, setResizingPanes] = useState(false)
  const [activeSectionId, setActiveSectionId] = useState<string | null>(null)
  const [pendingScrollTarget, setPendingScrollTarget] = useState<{
    projectionIdentity: string
    sectionId: string
  } | null>(null)
  const [contextExpansion, setContextExpansion] = useState<{
    projectionIdentity: string
    separatorIds: ReadonlySet<string>
  }>(() => ({ projectionIdentity, separatorIds: EMPTY_EXPANDED_CONTEXT_SEPARATOR_IDS }))
  const [directEditDraft, setDirectEditDraft] = useState<DirectEditDraft | null>(null)
  const directEditChanged = Boolean(
    directEditDraft && directEditDraft.text !== directEditDraft.originalText,
  )
  const [manualAlignmentDraft, setManualAlignmentDraft] = useState<ManualAlignmentDraft | null>(null)
  const [manualAlignmentError, setManualAlignmentError] = useState<string | null>(null)
  const [lineContextMenu, setLineContextMenu] = useState<DiffLineContextMenu | null>(null)
  const [showComparisonSettings, setShowComparisonSettings] = useState(false)
  const pendingActiveSectionIndexRef = useRef<number | null>(null)
  const lastMutationSectionIndexRef = useRef<number | null>(null)
  const rowElementsRef = useRef(new Map<string, HTMLDivElement>())
  const lineContextMenuRef = useRef<HTMLDivElement>(null)
  const lineContextTriggerRef = useRef<HTMLElement | null>(null)
  const comparisonSurfaceRef = useRef<HTMLDivElement>(null)
  const pendingSurfaceFocusRevisionRef = useRef<number | null>(null)
  const pendingLineFocusRef = useRef<{
    sourceSide: WorkspaceComparisonSourceSide
    lineNumber: number
    minimumRevision?: number
    fallbackToSurface?: boolean
  } | null>(null)
  const lineActionsDescriptionId = useId()
  const lineContextAnchorRect = useMemo(() => {
    const viewportWidth = typeof window === 'undefined' ? 0 : window.innerWidth
    const viewportHeight = typeof window === 'undefined' ? 0 : window.innerHeight
    const x = Math.max(8, Math.min(lineContextMenu?.x ?? 0, Math.max(8, viewportWidth - 8)))
    const y = Math.max(8, Math.min(lineContextMenu?.y ?? 0, Math.max(8, viewportHeight - 8)))
    return { top: y, right: x, bottom: y, left: x }
  }, [lineContextMenu?.x, lineContextMenu?.y])
  const { style: lineContextMenuPositionStyle } = useAnchoredPosition({
    open: lineContextMenu !== null,
    anchorRect: lineContextAnchorRect,
    floatingRef: lineContextMenuRef,
    offset: 0,
    viewportMargin: 8,
  })
  const expandedContextSeparatorIds = contextExpansion.projectionIdentity === projectionIdentity
    ? contextExpansion.separatorIds
    : EMPTY_EXPANDED_CONTEXT_SEPARATOR_IDS
  const projectedFiles = useMemo(() => files.map((file) => ({
    file,
    items: projectWorkspaceSideBySideFile(file, viewMode, 3, expandedContextSeparatorIds),
  })), [expandedContextSeparatorIds, files, viewMode])
  const sourceFiles = useMemo(() => files.map((file) => file.source), [files])
  const placeholderInsertionLines = useMemo(() => {
    const result = new Map<string, number>()
    files.forEach((file) => {
      file.rows.forEach((pair, index) => {
        if (pair.right) return
        const nextLine = file.rows.slice(index + 1)
          .find((candidate) => candidate.right?.newLine !== null && candidate.right?.newLine !== undefined)
          ?.right?.newLine
        const previousLine = [...file.rows.slice(0, index)]
          .reverse()
          .find((candidate) => candidate.right?.newLine !== null && candidate.right?.newLine !== undefined)
          ?.right?.newLine
        result.set(pair.id, nextLine ?? ((previousLine ?? 0) + 1))
      })
    })
    return result
  }, [files])
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
  const comparisonContentRef = useRef<HTMLDivElement>(null)
  const paneScrollbarRefs = useRef<Record<'old' | 'new', HTMLDivElement | null>>({ old: null, new: null })
  const programmaticPaneScrollTargetsRef = useRef(new WeakMap<HTMLElement, number>())
  const [paneScrollWidths, setPaneScrollWidths] = useState<Record<'old' | 'new', number>>({ old: 1, new: 1 })

  const syncPaneScroll = useCallback((side: 'old' | 'new', scrollLeft: number, source: HTMLElement) => {
    const updateScrollLeft = (element: HTMLElement | null, suppressFeedback: boolean) => {
      if (!element || element === source || element.scrollLeft === scrollLeft) return
      if (suppressFeedback) programmaticPaneScrollTargetsRef.current.set(element, scrollLeft)
      element.scrollLeft = scrollLeft
      if (!suppressFeedback) return
      requestAnimationFrame(() => {
        if (programmaticPaneScrollTargetsRef.current.get(element) === scrollLeft) {
          programmaticPaneScrollTargetsRef.current.delete(element)
        }
      })
    }
    const scrollbar = paneScrollbarRefs.current[side]
    updateScrollLeft(scrollbar, false)
    comparisonContentRef.current
      ?.querySelectorAll<HTMLElement>(`[data-diff-pane-scroll-content][data-side="${side}"]`)
      .forEach((element) => {
        updateScrollLeft(element, true)
      })
  }, [])

  const handlePaneScroll = useCallback((side: 'old' | 'new', source: HTMLElement) => {
    const programmaticTarget = programmaticPaneScrollTargetsRef.current.get(source)
    if (programmaticTarget !== undefined) {
      programmaticPaneScrollTargetsRef.current.delete(source)
      if (source.scrollLeft === programmaticTarget) return
    }
    syncPaneScroll(side, source.scrollLeft, source)
  }, [syncPaneScroll])

  const measurePaneScrollWidths = useCallback(() => {
    const root = comparisonContentRef.current
    if (!root) return
    const next = { old: 1, new: 1 }
    for (const side of ['old', 'new'] as const) {
      root.querySelectorAll<HTMLElement>(`[data-diff-pane-natural-content][data-side="${side}"]`)
        .forEach((element) => {
          next[side] = Math.max(next[side], element.scrollWidth)
        })
    }
    setPaneScrollWidths((current) => (
      current.old === next.old && current.new === next.new ? current : next
    ))
  }, [])

  useLayoutEffect(() => {
    const root = comparisonContentRef.current
    if (!root) return
    measurePaneScrollWidths()
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(measurePaneScrollWidths)
    observer.observe(root)
    root.querySelectorAll<HTMLElement>('[data-diff-pane-natural-content]')
      .forEach((element) => observer.observe(element))
    return () => observer.disconnect()
  }, [leftPanePercent, measurePaneScrollWidths, projectedFiles, showAllRows, swapped, visibleRowIds])

  const updatePaneSplit = (clientX: number) => {
    const bounds = comparisonContentRef.current?.getBoundingClientRect()
    if (!bounds || bounds.width <= 0) return
    const next = Math.round(((clientX - bounds.left) / bounds.width) * 100)
    setLeftPanePercent(Math.min(80, Math.max(20, next)))
  }

  useEffect(() => {
    if (!resizingPanes) return
    const previousCursor = document.body.style.cursor
    const previousUserSelect = document.body.style.userSelect
    document.body.style.cursor = 'col-resize'
    document.body.style.userSelect = 'none'
    const handlePointerMove = (event: PointerEvent) => updatePaneSplit(event.clientX)
    const handlePointerUp = () => setResizingPanes(false)
    window.addEventListener('pointermove', handlePointerMove)
    window.addEventListener('pointerup', handlePointerUp)
    window.addEventListener('pointercancel', handlePointerUp)
    return () => {
      window.removeEventListener('pointermove', handlePointerMove)
      window.removeEventListener('pointerup', handlePointerUp)
      window.removeEventListener('pointercancel', handlePointerUp)
      document.body.style.cursor = previousCursor
      document.body.style.userSelect = previousUserSelect
    }
  }, [resizingPanes])

  const paneGridStyle: CSSProperties = {
    gridTemplateColumns: `minmax(0, ${leftPanePercent}%) minmax(0, ${100 - leftPanePercent}%)`,
  }

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
    if (!pendingScrollTarget) return
    if (pendingScrollTarget.projectionIdentity !== projectionIdentity) {
      setPendingScrollTarget(null)
      return
    }
    const section = model.sections.find((candidate) => candidate.id === pendingScrollTarget.sectionId)
    const target = section?.rowIds.find((rowId) => rowElementsRef.current.has(rowId))
    if (!target) return
    rowElementsRef.current.get(target)?.scrollIntoView?.({ block: 'center', inline: 'nearest' })
    setPendingScrollTarget(null)
  }, [model.sections, pendingScrollTarget, projectedFiles, projectionIdentity, showAllRows, viewMode])

  useEffect(() => {
    if (commentDraft) editorRef.current?.focus()
  }, [commentDraft])

  const sideLabel = (side: 'old' | 'new') => t(`workspace.diffReview.side.${side}`)
  const sourceSideLabel = (side: WorkspaceComparisonSourceSide) => (
    side === 'left' ? sideLabel('old') : sideLabel('new')
  )
  const capabilityMessage = (side: WorkspaceComparisonSourceSide) => {
    const capability = getWorkspaceComparisonCapability(comparisonSession, side)
    if (capability.allowed) return null
    return t(`workspace.diffEdit.disabled.${capability.reason ?? 'unavailable'}`)
  }
  const canRequestSideWriteAccess = (side: WorkspaceComparisonSourceSide) => {
    const capability = getWorkspaceComparisonCapability(comparisonSession, side)
    return Boolean(
      onRequestWriteAccess
      && comparisonSession
      && capability.reason === 'not_writable'
      && comparisonSession[side].source.kind === 'working_tree'
      && comparisonSession[side].readOnlyReason === 'Registered external roots are read-only.',
    )
  }

  const manualAlignmentDisabledReason = (() => {
    if (recomputing) return t('workspace.comparisonSettings.recomputing')
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

  const closeManualAlignmentDraft = useCallback(() => {
    if (manualAlignmentDraft) {
      pendingLineFocusRef.current = {
        sourceSide: manualAlignmentDraft.sourceSide,
        lineNumber: manualAlignmentDraft.lineNumber,
      }
      setViewMode(manualAlignmentDraft.previousViewMode)
      setShowAllRows(manualAlignmentDraft.previousShowAllRows)
    }
    setManualAlignmentDraft(null)
    setLineContextMenu(null)
  }, [manualAlignmentDraft])

  const startManualAlignment = (
    sourceSide: WorkspaceComparisonSourceSide,
    lineNumber: number,
  ) => {
    if (!comparisonSession || manualAlignmentDisabledReason) return
    setManualAlignmentDraft({
      revision: comparisonSession.revision,
      sourceSide,
      lineNumber,
      previousViewMode: viewMode,
      previousShowAllRows: showAllRows,
    })
    setManualAlignmentError(null)
    setLineContextMenu(null)
    setViewMode('all')
    setShowAllRows(true)
  }

  const selectManualAlignmentTarget = (
    sourceSide: WorkspaceComparisonSourceSide,
    lineNumber: number,
  ) => {
    if (!comparisonSession || !manualAlignmentDraft || sourceSide === manualAlignmentDraft.sourceSide) return
    const leftLine = manualAlignmentDraft.sourceSide === 'left'
      ? manualAlignmentDraft.lineNumber
      : lineNumber
    const rightLine = manualAlignmentDraft.sourceSide === 'right'
      ? manualAlignmentDraft.lineNumber
      : lineNumber
    const outcome = addWorkspaceManualAlignmentAnchor(
      comparisonSession,
      leftLine,
      rightLine,
      manualAlignmentDraft.revision,
    )
    if (outcome.state === 'error') {
      setManualAlignmentError(t(`workspace.manualAlignment.error.${outcome.reason}`))
      return
    }
    closeManualAlignmentDraft()
    pendingLineFocusRef.current = {
      sourceSide,
      lineNumber,
      minimumRevision: outcome.session.revision,
      fallbackToSurface: true,
    }
    setManualAlignmentError(null)
    onComparisonSessionChange?.(outcome.session)
  }

  useEffect(() => {
    if (!manualAlignmentDraft) return
    const handleEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      event.stopPropagation()
      event.stopImmediatePropagation()
      closeManualAlignmentDraft()
    }
    document.addEventListener('keydown', handleEscape, true)
    return () => document.removeEventListener('keydown', handleEscape, true)
  }, [closeManualAlignmentDraft, manualAlignmentDraft])

  const dismissLineContextMenu = useCallback((reason: 'outside' | 'escape' | 'scroll' | 'resize') => {
    setLineContextMenu(null)
    if (reason === 'escape') lineContextTriggerRef.current?.focus()
  }, [])

  useDismissable({
    open: lineContextMenu !== null,
    refs: [lineContextMenuRef],
    triggerRef: lineContextTriggerRef,
    onDismiss: dismissLineContextMenu,
    closeOnEscape: !manualAlignmentDraft,
    stopEscapePropagation: true,
    closeOnViewportChange: true,
  })

  useEffect(() => {
    if (!lineContextMenu) return
    const menu = lineContextMenuRef.current
    const firstItem = menu?.querySelector<HTMLElement>('[role="menuitem"]:not([disabled])')
    if (firstItem) firstItem.focus()
    else menu?.focus()
  }, [lineContextMenu])

  useEffect(() => {
    const pending = pendingLineFocusRef.current
    if (!pending) return
    if (
      pending.minimumRevision !== undefined
      && (comparisonSession?.revision ?? -1) < pending.minimumRevision
    ) return
    const cell = comparisonContentRef.current?.querySelector<HTMLElement>(
      `[data-diff-cell][data-source-side="${pending.sourceSide}"][data-source-line="${pending.lineNumber}"]`,
    )
    if (cell) {
      cell.focus()
      pendingLineFocusRef.current = null
    } else if (pending.fallbackToSurface) {
      comparisonSurfaceRef.current?.focus({ preventScroll: true })
      pendingLineFocusRef.current = null
    }
  }, [comparisonSession?.revision, manualAlignmentDraft, projectionIdentity, showAllRows, viewMode])

  useEffect(() => {
    const minimumRevision = pendingSurfaceFocusRevisionRef.current
    if (minimumRevision === null || (comparisonSession?.revision ?? -1) < minimumRevision) return
    comparisonSurfaceRef.current?.focus({ preventScroll: true })
    pendingSurfaceFocusRevisionRef.current = null
  }, [comparisonSession?.revision, projectionIdentity])

  const beginDirectEdit = (
    sourceSide: WorkspaceComparisonSourceSide,
    lineNumber: number,
    text: string,
    mode: DirectEditDraft['mode'] = 'replace',
  ) => {
    if (
      !comparisonSession
      || !onComparisonSessionChange
      || !getWorkspaceComparisonCapability(comparisonSession, sourceSide).allowed
    ) return
    setCommentDraft(null)
    setDirectEditDraft({
      sourceSide,
      lineNumber,
      revision: comparisonSession.revision,
      mode,
      originalText: text,
      text,
    })
  }

  const sessionWithDirectEdit = () => {
    if (!comparisonSession || !directEditDraft) return comparisonSession
    if (directEditDraft.text === directEditDraft.originalText) return comparisonSession
    return directEditDraft.mode === 'insert'
      ? insertWorkspaceComparisonText(
          comparisonSession,
          directEditDraft.sourceSide,
          directEditDraft.lineNumber,
          directEditDraft.text,
          directEditDraft.revision,
        )
      : editWorkspaceComparisonLine(
          comparisonSession,
          directEditDraft.sourceSide,
          directEditDraft.lineNumber,
          directEditDraft.text,
          directEditDraft.revision,
        )
  }

  const commitDirectEdit = () => {
    const next = sessionWithDirectEdit()
    setDirectEditDraft(null)
    if (next && next !== comparisonSession) {
      pendingActiveSectionIndexRef.current = Math.max(0, activeSectionIndex)
      lastMutationSectionIndexRef.current = Math.max(0, activeSectionIndex)
      onComparisonSessionChange?.(next)
    }
    return next
  }

  const mergeSection = (sectionId: string, sourceSide: WorkspaceComparisonSourceSide) => {
    if (!comparisonSession || recomputing) return
    const sectionIndex = model.sections.findIndex((section) => section.id === sectionId)
    const next = mergeWorkspaceComparisonSection(
      comparisonSession,
      model,
      sectionId,
      sourceSide,
      comparisonSession.revision,
    )
    if (next === comparisonSession) return
    pendingActiveSectionIndexRef.current = Math.max(0, sectionIndex)
    lastMutationSectionIndexRef.current = Math.max(0, sectionIndex)
    pendingSurfaceFocusRevisionRef.current = next.revision
    onComparisonSessionChange?.(next)
  }

  const mergeRow = (rowId: string, sourceSide: WorkspaceComparisonSourceSide) => {
    if (!comparisonSession || recomputing) return
    const sectionIndex = model.sections.findIndex((section) => section.rowIds.includes(rowId))
    const next = mergeWorkspaceComparisonRow(
      comparisonSession,
      model,
      rowId,
      sourceSide,
      comparisonSession.revision,
    )
    setLineContextMenu(null)
    if (next === comparisonSession) return
    pendingActiveSectionIndexRef.current = Math.max(0, sectionIndex)
    lastMutationSectionIndexRef.current = Math.max(0, sectionIndex)
    const sourceRow = model.files.flatMap((file) => file.rows).find((row) => row.id === rowId)
    const sourceLineNumber = sourceSide === 'left'
      ? sourceRow?.left?.oldLine
      : sourceRow?.right?.newLine
    if (sourceLineNumber !== null && sourceLineNumber !== undefined) {
      pendingLineFocusRef.current = {
        sourceSide,
        lineNumber: sourceLineNumber,
        minimumRevision: next.revision,
        fallbackToSurface: true,
      }
    } else {
      pendingSurfaceFocusRevisionRef.current = next.revision
    }
    onComparisonSessionChange?.(next)
  }

  const toggleApproximateComparison = () => {
    if (!comparisonSession || recomputing) return
    const outcome = applyWorkspaceComparisonSettings(comparisonSession, {
      ...comparisonSession.comparisonSettings,
      ignoreWhitespace: !comparisonSession.comparisonSettings.ignoreWhitespace,
    })
    if (outcome.state !== 'ok') return
    onComparisonSessionChange?.(outcome.session)
  }

  const navigateComparisonHistory = (direction: 'undo' | 'redo') => {
    if (!comparisonSession) return
    const base = sessionWithDirectEdit() ?? comparisonSession
    const next = direction === 'undo'
      ? undoWorkspaceComparisonSession(base)
      : redoWorkspaceComparisonSession(base)
    setDirectEditDraft(null)
    if (next === comparisonSession) return
    if (lastMutationSectionIndexRef.current !== null) {
      pendingActiveSectionIndexRef.current = lastMutationSectionIndexRef.current
    }
    setLineContextMenu(null)
    onComparisonSessionChange?.(next)
  }

  const handleHistoryKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (!(event.ctrlKey || event.metaKey) || event.altKey || isNativeTextHistoryTarget(event.target)) return
    const key = event.key.toLowerCase()
    const direction = key === 'y' || (key === 'z' && event.shiftKey)
      ? 'redo'
      : key === 'z'
        ? 'undo'
        : null
    if (!direction || !comparisonSession) return
    event.preventDefault()
    event.stopPropagation()
    navigateComparisonHistory(direction)
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
    setPendingScrollTarget({ projectionIdentity, sectionId: target.id })
  }

  const expandContextSeparator = (separatorId: string) => {
    setContextExpansion((current) => {
      const separatorIds = current.projectionIdentity === projectionIdentity
        ? current.separatorIds
        : EMPTY_EXPANDED_CONTEXT_SEPARATOR_IDS
      return {
        projectionIdentity,
        separatorIds: new Set([...separatorIds, separatorId]),
      }
    })
    setShowAllRows(true)
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
    pairId: string,
    row: WorkspaceDiffRow | null,
    side: 'old' | 'new',
    lineEndingDifference?: { left: string; right: string },
  ) => {
    if (!row) {
      const sourceSide: WorkspaceComparisonSourceSide = side === 'old' ? 'left' : 'right'
      const hasLineActions = Boolean(comparisonSession && model.kind === 'comparison')
      const insertionLine = placeholderInsertionLines.get(pairId)
      const directEditing = directEditDraft?.mode === 'insert'
        && directEditDraft.sourceSide === sourceSide
        && directEditDraft.lineNumber === insertionLine
      const canDirectInsert = Boolean(
        sourceSide === 'right'
        && insertionLine
        && comparisonSession
        && onComparisonSessionChange
        && !manualAlignmentDraft
        && getWorkspaceComparisonCapability(comparisonSession, sourceSide).allowed,
      )
      const openPlaceholderMenu = (trigger: HTMLElement, x: number, y: number) => {
        if (!hasLineActions) return
        lineContextTriggerRef.current = trigger
        setLineContextMenu({ rowId: pairId, sourceSide, lineNumber: null, x, y })
      }
      return (
        <div
          data-diff-placeholder=""
          data-diff-tone="placeholder"
          data-side={side}
          data-source-side={sourceSide}
          role={hasLineActions ? 'gridcell' : undefined}
          tabIndex={hasLineActions && !canDirectInsert ? 0 : undefined}
          aria-hidden={hasLineActions ? undefined : true}
          aria-keyshortcuts={hasLineActions ? 'Shift+F10' : undefined}
          aria-describedby={hasLineActions ? lineActionsDescriptionId : undefined}
          aria-label={hasLineActions ? t('workspace.diffEdit.placeholderActionsLabel', {
            side: sourceSideLabel(sourceSide),
          }) : undefined}
          onContextMenu={(event) => {
            if (!hasLineActions) return
            event.preventDefault()
            openPlaceholderMenu(event.currentTarget, event.clientX, event.clientY)
          }}
          onKeyDown={(event) => {
            if (!hasLineActions || (!(event.shiftKey && event.key === 'F10') && event.key !== 'ContextMenu')) return
            event.preventDefault()
            const bounds = event.currentTarget.getBoundingClientRect()
            openPlaceholderMenu(event.currentTarget, bounds.left + 12, bounds.top + 12)
          }}
          className="grid min-h-5 min-w-0 overflow-hidden border-r border-[var(--color-border)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-[var(--color-border-focus)]"
          style={{ gridTemplateColumns: `${gutterWidth} minmax(0, 1fr)` }}
        >
          <span aria-hidden="true" className="bg-[var(--color-code-bg)]" />
          <span
            aria-hidden={canDirectInsert ? undefined : true}
            data-diff-placeholder-fill=""
            className="min-w-0 bg-[var(--color-surface-container-high)] focus-within:bg-[var(--color-code-bg)]"
            style={{
              backgroundImage: 'repeating-linear-gradient(135deg, transparent 0, transparent 5px, var(--color-border) 5px, var(--color-border) 6px)',
            }}
          >
            {canDirectInsert && (
              <DirectEditableLine
                value={directEditing ? directEditDraft!.text : ''}
                display=" "
                active={directEditing}
                ariaLabel={t('workspace.diffEdit.directInsertLabel', { line: insertionLine ?? '' })}
                difference
                onFocus={() => {
                  if (!directEditing) beginDirectEdit(sourceSide, insertionLine!, '', 'insert')
                }}
                onChange={(text) => setDirectEditDraft((current) => current
                  && current.mode === 'insert'
                  && current.sourceSide === sourceSide
                  && current.lineNumber === insertionLine
                    ? { ...current, text }
                    : {
                        sourceSide,
                        lineNumber: insertionLine!,
                        revision: comparisonSession!.revision,
                        mode: 'insert',
                        originalText: '',
                        text,
                      })}
                onBlur={commitDirectEdit}
              />
            )}
          </span>
        </div>
      )
    }
    const line = rowLine(row, side)
    const canComment = Boolean(onAddComment && row.selectable && row.side === side && line !== null && !manualAlignmentDraft)
    const selected = commentDraft?.selection.rowIds.includes(row.id) ?? false
    const sourceSide: WorkspaceComparisonSourceSide = side === 'old' ? 'left' : 'right'
    const directEditing = directEditDraft?.mode === 'replace'
      && directEditDraft.sourceSide === sourceSide
      && directEditDraft.lineNumber === line
    const canDirectEdit = Boolean(
      sourceSide === 'right'
      && line !== null
      && row.selectable
      && comparisonSession
      && onComparisonSessionChange
      && !manualAlignmentDraft
      && getWorkspaceComparisonCapability(comparisonSession, sourceSide).allowed,
    )
    const hasLineActions = Boolean(line !== null && row.selectable && comparisonSession && model.kind === 'comparison')
    const openLineContextMenu = (trigger: HTMLElement, x: number, y: number) => {
      if (!hasLineActions || line === null) return
      lineContextTriggerRef.current = trigger
      setLineContextMenu({ rowId: pairId, sourceSide, lineNumber: line, x, y })
    }
    return (
      <div
        data-diff-cell=""
        data-diff-tone={isDifferenceRow(row) ? 'difference' : 'normal'}
        data-side={side}
        data-source-side={sourceSide}
        data-source-line={line ?? undefined}
        data-manual-alignment-target={manualAlignmentDraft && sourceSide !== manualAlignmentDraft.sourceSide ? '' : undefined}
        role={hasLineActions ? 'gridcell' : undefined}
        tabIndex={hasLineActions ? 0 : undefined}
        aria-keyshortcuts={hasLineActions ? 'Shift+F10' : undefined}
        aria-describedby={hasLineActions ? lineActionsDescriptionId : undefined}
        onClick={() => {
          if (manualAlignmentDraft && line !== null) selectManualAlignmentTarget(sourceSide, line)
        }}
        onContextMenu={(event) => {
          if (!hasLineActions) return
          event.preventDefault()
          openLineContextMenu(event.currentTarget, event.clientX, event.clientY)
        }}
        onKeyDown={(event) => {
          if (!hasLineActions || (!(event.shiftKey && event.key === 'F10') && event.key !== 'ContextMenu')) return
          event.preventDefault()
          const bounds = event.currentTarget.getBoundingClientRect()
          openLineContextMenu(event.currentTarget, bounds.left + 12, bounds.top + 12)
        }}
        className={`group grid min-h-5 min-w-0 overflow-hidden border-r border-[var(--color-border)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-[var(--color-border-focus)] ${manualAlignmentDraft && sourceSide !== manualAlignmentDraft.sourceSide ? 'cursor-crosshair' : ''} ${cellTone(row)}`}
        style={{ gridTemplateColumns: `${gutterWidth} minmax(0, 1fr)` }}
      >
        <span className="relative flex select-none items-center justify-end bg-[var(--color-code-bg)] pl-[2ch] pr-[1ch] text-[11px] tabular-nums text-[var(--color-text-tertiary)] group-hover:bg-[var(--color-surface-hover)]">
          <span data-diff-line-number="" data-side={side}>{line ?? ''}</span>
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
          data-diff-pane-scroll-content=""
          data-side={side}
        data-direct-editing={directEditing ? '' : undefined}
        onScroll={(event) => handlePaneScroll(side, event.currentTarget)}
        className="min-w-0 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
      >
          <span
            data-diff-pane-scroll-track=""
            className="flex w-max min-w-full items-center whitespace-pre"
            style={{ minWidth: `${paneScrollWidths[side]}px` }}
          >
            {canDirectEdit ? (
              <DirectEditableLine
                value={directEditing ? directEditDraft!.text : row.text}
                display={row.selectable && row.text && highlightResult.tokensByRowId[row.id]
                  ? (
                      <HighlightedLine
                        row={row}
                        tokens={highlightResult.tokensByRowId[row.id]!}
                        wordRanges={highlightResult.wordRangesByRowId[row.id] ?? []}
                        emphasizeWholeLine={!lineEndingDifference}
                      />
                    )
                  : row.text || ' '}
                active={directEditing}
                ariaLabel={t('workspace.diffEdit.directEditorLabel', { line: line ?? '' })}
                difference={isDifferenceRow(row)}
                onFocus={() => {
                  if (!directEditing) beginDirectEdit(sourceSide, line!, row.text)
                }}
                onChange={(text) => setDirectEditDraft((current) => current
                  && current.mode === 'replace'
                  && current.sourceSide === sourceSide
                  && current.lineNumber === line
                    ? { ...current, text }
                    : {
                        sourceSide,
                        lineNumber: line!,
                        revision: comparisonSession!.revision,
                        mode: 'replace',
                        originalText: row.text,
                        text,
                      })}
                onBlur={commitDirectEdit}
              />
            ) : (
              <span
                data-diff-pane-natural-content=""
                data-side={side}
                className="flex w-max items-center px-3 whitespace-pre"
              >
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
              </span>
            )}
          </span>
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
        className="grid min-h-5 min-w-0 overflow-hidden border-r border-[var(--color-border)] bg-[var(--color-diff-highlight-bg)] text-[var(--color-text-secondary)]"
        style={{ gridTemplateColumns: `${gutterWidth} minmax(0, 1fr)` }}
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
      const expandable = viewMode === 'context' && item.hiddenCount !== null && item.hiddenCount > 0
      return (
        <div
          key={item.id}
          data-diff-separator=""
          className="grid w-full min-w-0 border-y border-[var(--color-border)] bg-[var(--color-surface-container)] text-center text-[11px] text-[var(--color-text-tertiary)]"
          style={paneGridStyle}
        >
          <span className="col-span-2 flex min-h-6 items-center justify-center gap-1.5 py-0.5">
            {expandable && item.hiddenCount !== null && (
              <IconButton
                icon={<Plus aria-hidden="true" />}
                label={t(item.hiddenCount === 1
                  ? 'workspace.diffView.expandHiddenLine'
                  : 'workspace.diffView.expandHiddenLines', { count: item.hiddenCount })}
                size="2xs"
                tone="muted"
                bordered
                onClick={() => expandContextSeparator(item.id)}
              />
            )}
            <span>
              {item.hiddenCount === null
                ? t('workspace.diffView.hiddenUnknown')
                : t('workspace.diffView.hiddenLines', { count: item.hiddenCount })}
            </span>
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
        className={`grid w-full min-w-0 ${active ? 'outline outline-1 outline-offset-[-1px] outline-[var(--color-info)]' : ''}`}
        style={paneGridStyle}
      >
        {isSectionFirstRow && section && comparisonSession && (
          <div
            data-testid={`workspace-diff-merge-actions-${section.id}`}
            className="col-span-2 flex items-center justify-center gap-2 border-y border-[var(--color-border)] bg-[var(--color-surface-container-low)] px-2 py-1"
          >
            {(['left', 'right'] as const).map((sourceSide) => {
              const targetSide = sourceSide === 'left' ? 'right' : 'left'
              const reason = recomputing
                ? t('workspace.comparisonSettings.recomputing')
                : capabilityMessage(targetSide)
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
              : renderCell(pair.id, side === 'old' ? pair.left : pair.right, side, pair.lineEndingDifference)}
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
    <div
      ref={comparisonSurfaceRef}
      data-testid="workspace-side-by-side-diff-scroll"
      className={className}
      tabIndex={-1}
      onKeyDown={handleHistoryKeyDown}
    >
      <span id={lineActionsDescriptionId} className="sr-only">
        {t('workspace.diffEdit.lineActionsShortcutHint')}
      </span>
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
        <Button
          variant={comparisonSettings.ignoreWhitespace ? 'tonal' : 'ghost'}
          size="sm"
          aria-pressed={comparisonSettings.ignoreWhitespace}
          title={t('workspace.comparisonSettings.approximateDescription')}
          disabled={!comparisonSession || recomputing}
          onClick={toggleApproximateComparison}
          icon={<span aria-hidden="true">≈</span>}
        >
          {t('workspace.comparisonSettings.approximate')}
        </Button>
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
        {comparisonSession && (
          <>
            <IconButton
              icon={<Undo2 aria-hidden="true" />}
              label={t('workspace.diffEdit.undo')}
              size="sm"
              aria-keyshortcuts="Control+Z Meta+Z"
              disabled={comparisonSession.undoStack.length === 0 && !directEditChanged}
              onClick={() => navigateComparisonHistory('undo')}
            />
            <IconButton
              icon={<Redo2 aria-hidden="true" />}
              label={t('workspace.diffEdit.redo')}
              size="sm"
              aria-keyshortcuts="Control+Y Meta+Y Control+Shift+Z Meta+Shift+Z"
              disabled={comparisonSession.redoStack.length === 0 || directEditChanged}
              onClick={() => navigateComparisonHistory('redo')}
            />
            <Button
              variant="primary"
              size="sm"
              disabled={!isWorkspaceComparisonSessionDirty(comparisonSession) && !directEditChanged}
              loading={saving}
              onClick={() => {
                const exactSession = commitDirectEdit()
                if (exactSession) void onSave?.(exactSession)
              }}
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
            {t('workspace.manualAlignment.prompt.target', {
              side: sourceSideLabel(manualAlignmentDraft.sourceSide),
              line: manualAlignmentDraft.lineNumber,
              target: sourceSideLabel(manualAlignmentDraft.sourceSide === 'left' ? 'right' : 'left'),
            })}
          </span>
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
                onClick={() => {
                  const next = removeWorkspaceManualAlignmentAnchor(comparisonSession, anchor.id)
                  if (next === comparisonSession) return
                  pendingSurfaceFocusRevisionRef.current = next.revision
                  onComparisonSessionChange?.(next)
                }}
                className="rounded px-1 hover:bg-[var(--color-surface-hover)]"
              >×</button>
            </span>
          ))}
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              const next = clearWorkspaceManualAlignmentAnchors(comparisonSession)
              if (next === comparisonSession) return
              pendingSurfaceFocusRevisionRef.current = next.revision
              onComparisonSessionChange?.(next)
            }}
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
      <div
        ref={comparisonContentRef}
        data-testid="workspace-side-by-side-diff-content"
        className="relative w-full min-w-0 pb-3"
      >
        <div
          data-workspace-code=""
          data-testid="workspace-code"
          data-highlight-engine={highlightResult.engine}
          role="grid"
          aria-label={`${path} diff`}
          className="m-0 w-full min-w-0 font-mono text-[13px] leading-5 text-[var(--color-code-fg)]"
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
                <div
                  className="sticky top-10 z-[var(--z-raised)] grid w-full min-w-0 border-b border-[var(--color-border)] bg-[var(--color-surface-glass)] text-[11px] font-semibold text-[var(--color-text-secondary)] backdrop-blur"
                  style={paneGridStyle}
                >
                  {visualSides.map((side) => (
                    <div key={side} data-visual-header={side} className="flex min-w-0 items-center gap-2 overflow-hidden border-r border-[var(--color-border)] px-3 py-1.5">
                      <span
                        className="min-w-0 flex-1 truncate"
                        title={`${sideLabel(side)} · ${side === 'old' ? file.oldPath ?? '/dev/null' : file.newPath ?? '/dev/null'}`}
                      >
                        {sideLabel(side)} · {side === 'old' ? file.oldPath ?? '/dev/null' : file.newPath ?? '/dev/null'}
                      </span>
                      {comparisonSession && (() => {
                        const sourceSide = side === 'old' ? 'left' : 'right'
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
                            {canRequestSideWriteAccess(sourceSide) && (
                              <Button
                                variant="secondary"
                                size="sm"
                                loading={writeAccessChangingSide === sourceSide}
                                onClick={() => void onRequestWriteAccess?.(sourceSide)}
                              >
                                {writeAccessChangingSide === sourceSide
                                  ? t('workspace.diffEdit.writeAccessLoading')
                                  : t('workspace.diffEdit.requestWriteAccess')}
                              </Button>
                            )}
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
        <div
          role="separator"
          aria-label={t('workspace.diffView.resizePanes')}
          aria-orientation="vertical"
          aria-valuemin={20}
          aria-valuemax={80}
          aria-valuenow={leftPanePercent}
          tabIndex={0}
          data-testid="workspace-diff-pane-resize-handle"
          onPointerDown={(event) => {
            if (event.button !== 0) return
            event.preventDefault()
            updatePaneSplit(event.clientX)
            setResizingPanes(true)
          }}
          onDoubleClick={() => setLeftPanePercent(50)}
          onKeyDown={(event) => {
            if (event.key === 'ArrowLeft') {
              event.preventDefault()
              setLeftPanePercent((current) => Math.max(20, current - 5))
            } else if (event.key === 'ArrowRight') {
              event.preventDefault()
              setLeftPanePercent((current) => Math.min(80, current + 5))
            } else if (event.key === 'Home') {
              event.preventDefault()
              setLeftPanePercent(20)
            } else if (event.key === 'End') {
              event.preventDefault()
              setLeftPanePercent(80)
            }
          }}
          className="group absolute inset-y-0 z-[var(--z-sticky)] w-3 -translate-x-1/2 cursor-col-resize touch-none outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-border-focus)]"
          style={{ left: `${leftPanePercent}%` }}
        >
          <span className="pointer-events-none absolute inset-y-0 left-1/2 w-px -translate-x-1/2 bg-[var(--color-border)] transition-colors group-hover:bg-[var(--color-border-focus)]" />
        </div>
        <div className="sticky bottom-0 left-0 z-[var(--z-raised)] w-full min-w-0 bg-[var(--color-surface-container-lowest)]">
          {displayRows.length > lineLimit && (
            <div className="flex items-center gap-3 border-t border-[var(--color-border)] px-3 py-2 text-xs text-[var(--color-text-tertiary)]">
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
          <div
            data-testid="workspace-diff-pane-scrollbars"
            className="grid w-full min-w-0 border-t border-[var(--color-border)]"
            style={paneGridStyle}
          >
            {visualSides.map((side) => (
              <div
                key={side}
                className="grid min-w-0 border-r border-[var(--color-border)]"
                style={{ gridTemplateColumns: `${gutterWidth} minmax(0, 1fr)` }}
              >
                <span aria-hidden="true" className="bg-[var(--color-code-bg)]" />
                <div
                  ref={(element) => {
                    paneScrollbarRefs.current[side] = element
                  }}
                  data-testid={`workspace-diff-pane-scrollbar-${side}`}
                  data-side={side}
                  tabIndex={0}
                  aria-label={t('workspace.diffView.scrollPane', { side: sideLabel(side) })}
                  onScroll={(event) => handlePaneScroll(side, event.currentTarget)}
                  className="h-5 min-w-0 overflow-x-scroll overflow-y-hidden bg-[var(--color-code-bg)] outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--color-border-focus)]"
                >
                  <div
                    aria-hidden="true"
                    className="h-px min-w-full"
                    style={{ width: `${paneScrollWidths[side]}px` }}
                  />
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
      {lineContextMenu && (() => {
        const targetSide = lineContextMenu.sourceSide === 'left' ? 'right' : 'left'
        const copyReason = recomputing
          ? t('workspace.comparisonSettings.recomputing')
          : capabilityMessage(targetSide)
        const copyReasonId = copyReason ? 'workspace-diff-line-copy-disabled-reason' : undefined
        return (
          <div
            ref={lineContextMenuRef}
            role="menu"
            tabIndex={-1}
            aria-label={t('workspace.diffEdit.lineMenu')}
            className="fixed z-[var(--z-dropdown)] min-w-48 rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-surface-container-lowest)] p-1 shadow-[var(--shadow-card)]"
            style={lineContextMenuPositionStyle}
            onKeyDown={(event) => {
              if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return
              event.preventDefault()
              const items = [...event.currentTarget.querySelectorAll<HTMLElement>('[role="menuitem"]:not([disabled])')]
              const index = items.indexOf(document.activeElement as HTMLElement)
              const offset = event.key === 'ArrowDown' ? 1 : -1
              items[(index + offset + items.length) % items.length]?.focus()
            }}
          >
            {manualAlignmentDraft ? (
              <button
                type="button"
                role="menuitem"
                onClick={closeManualAlignmentDraft}
                className="flex w-full items-center rounded-[var(--radius-sm)] px-3 py-1.5 text-left text-[12px] text-[var(--color-text-primary)] hover:bg-[var(--color-surface-hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-border-focus)]"
              >
                {t('workspace.manualAlignment.cancel')}
              </button>
            ) : lineContextMenu.lineNumber !== null ? (
              <button
                type="button"
                role="menuitem"
                disabled={Boolean(manualAlignmentDisabledReason)}
                title={manualAlignmentDisabledReason ?? undefined}
                onClick={() => startManualAlignment(lineContextMenu.sourceSide, lineContextMenu.lineNumber!)}
                className="flex w-full items-center rounded-[var(--radius-sm)] px-3 py-1.5 text-left text-[12px] text-[var(--color-text-primary)] hover:bg-[var(--color-surface-hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-border-focus)] disabled:cursor-not-allowed disabled:opacity-40"
              >
                {t('workspace.manualAlignment.contextAction')}
              </button>
            ) : null}
            <button
              type="button"
              role="menuitem"
              disabled={Boolean(copyReason)}
              aria-describedby={copyReasonId}
              title={copyReason ?? undefined}
              onClick={() => mergeRow(lineContextMenu.rowId, lineContextMenu.sourceSide)}
              className="flex w-full items-center rounded-[var(--radius-sm)] px-3 py-1.5 text-left text-[12px] text-[var(--color-text-primary)] hover:bg-[var(--color-surface-hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-border-focus)] disabled:cursor-not-allowed disabled:opacity-40"
            >
              {t('workspace.diffEdit.copyLine', { target: sourceSideLabel(targetSide) })}
            </button>
            {copyReason && <span id={copyReasonId} className="sr-only">{copyReason}</span>}
          </div>
        )
      })()}
    </div>
  )
}
