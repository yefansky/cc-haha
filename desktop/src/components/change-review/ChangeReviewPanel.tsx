import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
} from 'react'
import { ChevronDown, ChevronRight, Clock3, FileCode2, Pencil, RefreshCw, RotateCcw, Undo2 } from 'lucide-react'
import {
  sessionsApi,
  type SessionTurnCheckpoint,
  type WorkspaceDiffResult,
} from '../../api/sessions'
import { useTranslation } from '../../i18n'
import { Button } from '@/components/ui/Button'
import { ConfirmDialog } from '@/components/ui/ConfirmDialog'
import { EmptyState } from '@/components/ui/EmptyState'
import { IconButton } from '@/components/ui/IconButton'
import { LoadingState } from '@/components/ui/LoadingState'
import { SearchField } from '@/components/ui/SearchField'
import { TextArea } from '@/components/ui/TextArea'
import { WorkspaceDiffSurface } from '../workspace/WorkspaceDiffSurface'
import { buildHunkRevertContent } from './reviewDiffActions'

type ReviewFile = {
  sourcePath: string
  displayPath: string
}

type ActiveReview = {
  checkpoint: SessionTurnCheckpoint
  file: ReviewFile
  diff: WorkspaceDiffResult
}

type RestoreIntent =
  | { kind: 'all'; checkpoint: SessionTurnCheckpoint }
  | { kind: 'file'; checkpoint: SessionTurnCheckpoint; file: ReviewFile }

const TIMELINE_WIDTH_STORAGE_KEY = 'cc-haha.change-review.timeline-width'
const TIMELINE_DEFAULT_WIDTH = 400
const TIMELINE_MIN_WIDTH = 280
const TIMELINE_MAX_WIDTH = 720
const REVIEW_DETAIL_MIN_WIDTH = 360

function clampTimelineWidth(width: number, maximum = TIMELINE_MAX_WIDTH) {
  return Math.min(maximum, Math.max(TIMELINE_MIN_WIDTH, Math.round(width)))
}

function readTimelineWidth() {
  try {
    const value = window.localStorage.getItem(TIMELINE_WIDTH_STORAGE_KEY)
    const parsed = value === null ? Number.NaN : Number.parseInt(value, 10)
    return Number.isFinite(parsed) ? clampTimelineWidth(parsed) : TIMELINE_DEFAULT_WIDTH
  } catch {
    return TIMELINE_DEFAULT_WIDTH
  }
}

function persistTimelineWidth(width: number) {
  try {
    window.localStorage.setItem(TIMELINE_WIDTH_STORAGE_KEY, String(width))
  } catch {
    // Keep the in-memory width when localStorage is unavailable.
  }
}

function checkpointId(checkpoint: SessionTurnCheckpoint) {
  return checkpoint.target.targetUserMessageId
}

function toReviewPath(filePath: string, workDir?: string) {
  const normalizedPath = filePath.replace(/\\/g, '/')
  const normalizedWorkDir = workDir?.replace(/\\/g, '/').replace(/\/+$/, '')
  return normalizedWorkDir && normalizedPath.startsWith(`${normalizedWorkDir}/`)
    ? normalizedPath.slice(normalizedWorkDir.length + 1)
    : normalizedPath
}

function checkpointFiles(checkpoint: SessionTurnCheckpoint): ReviewFile[] {
  return checkpoint.code.filesChanged
    .map((sourcePath) => ({
      sourcePath,
      displayPath: toReviewPath(sourcePath, checkpoint.workDir),
    }))
    .sort((left, right) => left.displayPath.localeCompare(right.displayPath))
}

function formatCheckpointTime(createdAt?: string) {
  if (!createdAt) return null
  const date = new Date(createdAt)
  if (!Number.isFinite(date.getTime())) return null
  return new Intl.DateTimeFormat(undefined, {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).format(date)
}

function ReviewEditor({
  value,
  saving,
  onCancel,
  onSave,
}: {
  value: string
  saving: boolean
  onCancel: () => void
  onSave: (value: string) => void
}) {
  const t = useTranslation()
  const [draft, setDraft] = useState(value)
  useEffect(() => setDraft(value), [value])

  return (
    <div className="flex min-h-0 flex-1 flex-col bg-[var(--color-code-bg)]">
      <div className="flex h-10 shrink-0 items-center gap-2 border-b border-[var(--color-border)] bg-[var(--color-surface)] px-4">
        <span className="text-[12px] font-medium text-[var(--color-text-secondary)]">
          {t('review.editing')}
        </span>
        <div className="ml-auto flex items-center gap-1.5">
          <Button variant="ghost" size="sm" onClick={onCancel} disabled={saving}>
            {t('common.cancel')}
          </Button>
          <Button
            variant="primary"
            size="sm"
            loading={saving}
            disabled={draft === value}
            onClick={() => onSave(draft)}
          >
            {t('common.save')}
          </Button>
        </div>
      </div>
      <TextArea
        label={t('review.editFile')}
        aria-label={t('review.editFile')}
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        spellCheck={false}
        containerClassName="min-h-0 flex-1 [&>label]:sr-only"
        className="h-full resize-none rounded-none border-0 bg-transparent px-5 py-4 font-[var(--font-mono)] text-[13px] leading-5 text-[var(--color-code-fg)] shadow-none"
      />
    </div>
  )
}

/** Session-scoped checkpoint timeline. It never scans the full workspace. */
export function ChangeReviewPanel({ sessionId }: { sessionId: string }) {
  const t = useTranslation()
  const [checkpoints, setCheckpoints] = useState<SessionTurnCheckpoint[]>([])
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set())
  const [active, setActive] = useState<ActiveReview | null>(null)
  const [loading, setLoading] = useState(true)
  const [loadingDiffKey, setLoadingDiffKey] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [filterQuery, setFilterQuery] = useState('')
  const [restoreIntent, setRestoreIntent] = useState<RestoreIntent | null>(null)
  const [restoring, setRestoring] = useState(false)
  const [revertingHunkId, setRevertingHunkId] = useState<string | null>(null)
  const [editorContent, setEditorContent] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [timelineWidth, setTimelineWidth] = useState(readTimelineWidth)
  const splitLayoutRef = useRef<HTMLDivElement>(null)
  const timelineRef = useRef<HTMLElement>(null)
  const timelineDragRef = useRef<{ startX: number; startWidth: number } | null>(null)
  const timelineWidthRef = useRef(timelineWidth)
  timelineWidthRef.current = timelineWidth

  const refresh = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const response = await sessionsApi.getTurnCheckpoints(sessionId)
      const nextCheckpoints = response.checkpoints.filter((checkpoint) => (
        checkpoint.code.available && checkpoint.code.filesChanged.length > 0
      ))
      setCheckpoints(nextCheckpoints)
      const latestId = nextCheckpoints.at(-1) ? checkpointId(nextCheckpoints.at(-1)!) : null
      setExpandedIds((current) => {
        const surviving = new Set([...current].filter((id) => (
          nextCheckpoints.some((checkpoint) => checkpointId(checkpoint) === id)
        )))
        if (surviving.size === 0 && latestId) surviving.add(latestId)
        return surviving
      })
      setActive((current) => current && nextCheckpoints.some((checkpoint) => (
        checkpointId(checkpoint) === checkpointId(current.checkpoint)
        && checkpoint.code.filesChanged.includes(current.file.sourcePath)
      )) ? current : null)
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : t('review.loadError'))
    } finally {
      setLoading(false)
    }
  }, [sessionId, t])

  useEffect(() => { void refresh() }, [refresh])

  const filteredTimeline = useMemo(() => {
    const query = filterQuery.trim().toLowerCase()
    return [...checkpoints].reverse().flatMap((checkpoint, reverseIndex) => {
      const files = checkpointFiles(checkpoint).filter((file) => (
        !query
        || file.displayPath.toLowerCase().includes(query)
        || checkpoint.prompt?.toLowerCase().includes(query)
      ))
      if (files.length === 0) return []
      return [{ checkpoint, files, chronologicalNumber: checkpoints.length - reverseIndex }]
    })
  }, [checkpoints, filterQuery])

  const uniqueFileCount = useMemo(() => new Set(
    checkpoints.flatMap((checkpoint) => checkpoint.code.filesChanged),
  ).size, [checkpoints])

  const openFile = useCallback(async (checkpoint: SessionTurnCheckpoint, file: ReviewFile) => {
    const key = `${checkpointId(checkpoint)}::${file.sourcePath}`
    setLoadingDiffKey(key)
    setError(null)
    setEditorContent(null)
    try {
      const diff = await sessionsApi.getTurnCheckpointDiff(
        sessionId,
        checkpoint.target.targetUserMessageId,
        file.sourcePath,
        checkpoint.target.userMessageIndex,
      )
      setActive({ checkpoint, file, diff })
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : t('review.diffError'))
    } finally {
      setLoadingDiffKey(null)
    }
  }, [sessionId, t])

  const openEditor = useCallback(async () => {
    if (!active) return
    const file = await sessionsApi.getWorkspaceFile(sessionId, active.file.sourcePath)
    if (file.state !== 'ok' || typeof file.content !== 'string') {
      setError(t('review.editUnavailable'))
      return
    }
    setEditorContent(file.content)
  }, [active, sessionId, t])

  const saveEditor = useCallback(async (content: string) => {
    if (!active || editorContent === null) return
    setSaving(true)
    setError(null)
    try {
      const result = await sessionsApi.writeWorkspaceFile(sessionId, {
        path: active.file.sourcePath,
        expectedContent: editorContent,
        content,
      })
      if (result.state !== 'ok') throw new Error(result.error ?? t('review.saveError'))
      setEditorContent(null)
      await openFile(active.checkpoint, active.file)
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : t('review.saveError'))
    } finally {
      setSaving(false)
    }
  }, [active, editorContent, openFile, sessionId, t])

  const revertHunk = useCallback(async (hunkId: string) => {
    if (!active || active.diff.state !== 'ok') return
    setRevertingHunkId(hunkId)
    setError(null)
    try {
      const file = await sessionsApi.getWorkspaceFile(sessionId, active.file.sourcePath)
      if (file.state !== 'ok' || typeof file.content !== 'string') throw new Error(t('review.readError'))
      const content = buildHunkRevertContent(
        file.content,
        active.diff.diff ?? '',
        active.file.displayPath,
        hunkId,
      )
      if (content === null) throw new Error(t('review.hunkConflict'))
      const result = await sessionsApi.writeWorkspaceFile(sessionId, {
        path: active.file.sourcePath,
        expectedContent: file.content,
        content,
      })
      if (result.state !== 'ok') throw new Error(result.error ?? t('review.hunkError'))
      await openFile(active.checkpoint, active.file)
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : t('review.hunkError'))
    } finally {
      setRevertingHunkId(null)
    }
  }, [active, openFile, sessionId, t])

  const confirmRestore = useCallback(async () => {
    if (!restoreIntent) return
    setRestoring(true)
    setError(null)
    try {
      await sessionsApi.rewind(sessionId, {
        targetUserMessageId: restoreIntent.checkpoint.target.targetUserMessageId,
        userMessageIndex: restoreIntent.checkpoint.target.userMessageIndex,
        mode: 'files',
        ...(restoreIntent.kind === 'file' ? { paths: [restoreIntent.file.sourcePath] } : {}),
      })
      setRestoreIntent(null)
      setActive(null)
      setEditorContent(null)
      await refresh()
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : t('review.restoreError'))
    } finally {
      setRestoring(false)
    }
  }, [refresh, restoreIntent, sessionId, t])

  const getTimelineMaximumWidth = useCallback(() => {
    const layoutWidth = splitLayoutRef.current?.getBoundingClientRect().width ?? 0
    if (layoutWidth <= 0) return TIMELINE_MAX_WIDTH
    return Math.max(
      TIMELINE_MIN_WIDTH,
      Math.min(TIMELINE_MAX_WIDTH, layoutWidth - REVIEW_DETAIL_MIN_WIDTH),
    )
  }, [])

  useEffect(() => {
    const clampToLayout = () => {
      const maximum = getTimelineMaximumWidth()
      setTimelineWidth((current) => {
        const next = clampTimelineWidth(current, maximum)
        timelineWidthRef.current = next
        return next
      })
    }
    clampToLayout()
    window.addEventListener('resize', clampToLayout)
    return () => window.removeEventListener('resize', clampToLayout)
  }, [getTimelineMaximumWidth])

  const handleTimelineResizeMove = useCallback((event: globalThis.MouseEvent) => {
    const drag = timelineDragRef.current
    if (!drag) return
    const nextWidth = clampTimelineWidth(
      drag.startWidth + event.clientX - drag.startX,
      getTimelineMaximumWidth(),
    )
    timelineWidthRef.current = nextWidth
    setTimelineWidth(nextWidth)
  }, [getTimelineMaximumWidth])

  const handleTimelineResizeEnd = useCallback(() => {
    if (!timelineDragRef.current) return
    timelineDragRef.current = null
    persistTimelineWidth(timelineWidthRef.current)
    document.body.style.removeProperty('cursor')
    document.body.style.removeProperty('user-select')
    window.removeEventListener('mousemove', handleTimelineResizeMove)
    window.removeEventListener('mouseup', handleTimelineResizeEnd)
  }, [handleTimelineResizeMove])

  const handleTimelineResizeStart = useCallback((event: ReactMouseEvent<HTMLDivElement>) => {
    if (event.button !== 0) return
    event.preventDefault()
    const measuredWidth = timelineRef.current?.getBoundingClientRect().width ?? 0
    timelineDragRef.current = {
      startX: event.clientX,
      startWidth: measuredWidth > 0 ? measuredWidth : timelineWidthRef.current,
    }
    document.body.style.cursor = 'col-resize'
    document.body.style.userSelect = 'none'
    window.addEventListener('mousemove', handleTimelineResizeMove)
    window.addEventListener('mouseup', handleTimelineResizeEnd)
  }, [handleTimelineResizeEnd, handleTimelineResizeMove])

  const resetTimelineWidth = useCallback(() => {
    const nextWidth = clampTimelineWidth(TIMELINE_DEFAULT_WIDTH, getTimelineMaximumWidth())
    timelineWidthRef.current = nextWidth
    setTimelineWidth(nextWidth)
    persistTimelineWidth(nextWidth)
  }, [getTimelineMaximumWidth])

  const handleTimelineResizeKeyDown = useCallback((event: ReactKeyboardEvent<HTMLDivElement>) => {
    let nextWidth: number | null = null
    if (event.key === 'ArrowLeft') nextWidth = timelineWidthRef.current - 16
    if (event.key === 'ArrowRight') nextWidth = timelineWidthRef.current + 16
    if (event.key === 'Home') nextWidth = TIMELINE_MIN_WIDTH
    if (event.key === 'End') nextWidth = getTimelineMaximumWidth()
    if (nextWidth === null) return
    event.preventDefault()
    const clampedWidth = clampTimelineWidth(nextWidth, getTimelineMaximumWidth())
    timelineWidthRef.current = clampedWidth
    setTimelineWidth(clampedWidth)
    persistTimelineWidth(clampedWidth)
  }, [getTimelineMaximumWidth])

  useEffect(() => () => {
    window.removeEventListener('mousemove', handleTimelineResizeMove)
    window.removeEventListener('mouseup', handleTimelineResizeEnd)
    document.body.style.removeProperty('cursor')
    document.body.style.removeProperty('user-select')
  }, [handleTimelineResizeEnd, handleTimelineResizeMove])

  const earliestCheckpoint = checkpoints[0] ?? null
  const latestCheckpointId = checkpoints.at(-1) ? checkpointId(checkpoints.at(-1)!) : null
  const activeKey = active ? `${checkpointId(active.checkpoint)}::${active.file.sourcePath}` : null

  return (
    <section data-testid="change-review-panel" className="flex min-h-0 flex-1 flex-col bg-[var(--color-surface)]">
      <header className="flex h-12 shrink-0 items-center gap-3 border-b border-[var(--color-border)] px-5">
        <div className="min-w-0">
          <h2 className="truncate text-[13px] font-semibold text-[var(--color-text-primary)]">
            {t('review.title')}
          </h2>
          <p className="truncate text-[11px] text-[var(--color-text-tertiary)]">
            {t('review.summary', { checkpoints: checkpoints.length, files: uniqueFileCount })}
          </p>
        </div>
        <div className="ml-auto flex shrink-0 items-center gap-1.5">
          <IconButton
            icon={<RefreshCw size={14} className={loading ? 'animate-spin' : ''} aria-hidden="true" />}
            label={t('review.refresh')}
            onClick={() => void refresh()}
            size="md"
            tone="muted"
            showTooltip={false}
          />
          <Button
            variant="danger-outline"
            size="base"
            icon={<RotateCcw size={14} aria-hidden="true" />}
            disabled={!earliestCheckpoint}
            onClick={() => earliestCheckpoint && setRestoreIntent({ kind: 'all', checkpoint: earliestCheckpoint })}
          >
            {t('review.restoreAll')}
          </Button>
        </div>
      </header>

      {error && (
        <div role="alert" className="border-b border-[var(--color-error)] bg-[var(--color-error-container)] px-5 py-2 text-[12px] text-[var(--color-on-error-container)]">
          {error}
        </div>
      )}

      <div ref={splitLayoutRef} className="flex min-h-0 flex-1">
        <aside
          ref={timelineRef}
          data-testid="change-review-timeline"
          className="flex shrink-0 flex-col bg-[var(--color-surface-container-low)]"
          style={{ width: timelineWidth }}
        >
          <div className="border-b border-[var(--color-border)] p-3">
            <SearchField
              value={filterQuery}
              onChange={setFilterQuery}
              label={t('review.filter')}
              placeholder={t('review.filterPlaceholder')}
              clearLabel={t('review.clearFilter')}
              size="sm"
            />
          </div>
          <div className="min-h-0 flex-1 overflow-auto py-2">
            {loading && checkpoints.length === 0 ? (
              <LoadingState label={t('review.loading')} size="sm" variant="block" />
            ) : filteredTimeline.length === 0 ? (
              <EmptyState
                icon={<Clock3 size={18} />}
                title={t('review.emptyTitle')}
                description={t('review.emptyDescription')}
                size="sm"
                variant="plain"
              />
            ) : filteredTimeline.map(({ checkpoint, files, chronologicalNumber }) => {
              const id = checkpointId(checkpoint)
              const expanded = expandedIds.has(id)
              const time = formatCheckpointTime(checkpoint.createdAt)
              const latest = id === latestCheckpointId
              return (
                <section key={id} className="mx-2 mb-2 overflow-hidden rounded-[var(--radius-lg)] border border-[var(--color-border)] bg-[var(--color-surface)]">
                  <button
                    type="button"
                    aria-expanded={expanded}
                    onClick={() => setExpandedIds((current) => {
                      const next = new Set(current)
                      if (next.has(id)) next.delete(id)
                      else next.add(id)
                      return next
                    })}
                    className="flex w-full items-start gap-2 px-3 py-2.5 text-left transition-colors hover:bg-[var(--color-surface-hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--color-border-focus)]"
                  >
                    {expanded
                      ? <ChevronDown size={15} aria-hidden="true" className="mt-0.5 shrink-0 text-[var(--color-text-tertiary)]" />
                      : <ChevronRight size={15} aria-hidden="true" className="mt-0.5 shrink-0 text-[var(--color-text-tertiary)]" />}
                    <span className="min-w-0 flex-1">
                      <span className="flex items-center gap-2 text-[12px] font-semibold text-[var(--color-text-primary)]">
                        {t('review.checkpoint', { number: chronologicalNumber })}
                        {latest && <span className="rounded-[var(--radius-sm)] bg-[var(--color-info-container)] px-1.5 py-0.5 text-[10px] text-[var(--color-on-info-container)]">{t('review.latest')}</span>}
                      </span>
                      <span className="mt-0.5 block truncate text-[11px] text-[var(--color-text-tertiary)]">
                        {time ?? t('review.timeUnavailable')}{checkpoint.prompt ? ` · ${checkpoint.prompt}` : ''}
                      </span>
                      <span className="mt-1 flex items-center gap-2 font-[var(--font-mono)] text-[10px]">
                        <span className="text-[var(--color-text-secondary)]">{t('review.filesCount', { count: files.length })}</span>
                        <span className="text-[var(--color-success)]">+{checkpoint.code.insertions}</span>
                        <span className="text-[var(--color-error)]">-{checkpoint.code.deletions}</span>
                      </span>
                    </span>
                  </button>
                  {expanded && (
                    <div className="border-t border-[var(--color-border)] py-1">
                      {files.map((file) => {
                        const key = `${id}::${file.sourcePath}`
                        const selected = activeKey === key
                        return (
                          <div key={file.sourcePath} className="flex items-center gap-1 px-1.5">
                            <button
                              type="button"
                              title={file.displayPath}
                              onClick={() => void openFile(checkpoint, file)}
                              className={`flex min-h-8 min-w-0 flex-1 items-center gap-2 rounded-[var(--radius-md)] px-2 text-left text-[12px] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--color-border-focus)] ${
                                selected
                                  ? 'bg-[var(--color-surface-selected)] text-[var(--color-text-primary)]'
                                  : 'text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-hover)]'
                              }`}
                            >
                              <FileCode2 size={13} aria-hidden="true" className="shrink-0 text-[var(--color-success)]" />
                              <span className="min-w-0 flex-1 truncate">{file.displayPath}</span>
                              {loadingDiffKey === key && <span className="text-[10px] text-[var(--color-text-tertiary)]">…</span>}
                            </button>
                            <IconButton
                              icon={<Undo2 size={12} aria-hidden="true" />}
                              label={t('review.restoreFileAria', { path: file.displayPath })}
                              onClick={() => setRestoreIntent({ kind: 'file', checkpoint, file })}
                              size="2xs"
                              tone="muted"
                              hoverTone="danger"
                              showTooltip={false}
                            />
                          </div>
                        )
                      })}
                    </div>
                  )}
                </section>
              )
            })}
          </div>
        </aside>

        <div
          role="separator"
          tabIndex={0}
          aria-orientation="vertical"
          aria-label={t('review.resizeTimeline')}
          aria-valuemin={TIMELINE_MIN_WIDTH}
          aria-valuemax={Math.round(getTimelineMaximumWidth())}
          aria-valuenow={timelineWidth}
          data-testid="change-review-timeline-resize-handle"
          onMouseDown={handleTimelineResizeStart}
          onDoubleClick={resetTimelineWidth}
          onKeyDown={handleTimelineResizeKeyDown}
          className="group relative w-px shrink-0 cursor-col-resize bg-[var(--color-border)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-border-focus)]"
        >
          <div className="absolute inset-y-0 -left-[3px] z-10 w-[7px] transition-colors group-hover:bg-[var(--color-brand)]/20 group-focus-visible:bg-[var(--color-brand)]/20" />
        </div>

        <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
          {!active ? (
            <EmptyState
              icon={<FileCode2 size={20} />}
              title={t('review.selectFileTitle')}
              description={t('review.selectFileDescription')}
              size="lg"
              variant="plain"
              className="min-h-0 flex-1"
            />
          ) : editorContent !== null ? (
            <ReviewEditor
              value={editorContent}
              saving={saving}
              onCancel={() => setEditorContent(null)}
              onSave={(value) => void saveEditor(value)}
            />
          ) : (
            <>
              <div className="flex h-10 shrink-0 items-center gap-2 border-b border-[var(--color-border)] px-4">
                <FileCode2 size={14} aria-hidden="true" className="shrink-0 text-[var(--color-success)]" />
                <span className="min-w-0 flex-1 truncate font-[var(--font-mono)] text-[12px] text-[var(--color-text-secondary)]">
                  {active.file.displayPath}
                </span>
                <Button
                  variant="ghost"
                  size="sm"
                  icon={<Undo2 size={13} aria-hidden="true" />}
                  onClick={() => setRestoreIntent({ kind: 'file', checkpoint: active.checkpoint, file: active.file })}
                >
                  {t('review.restoreFile')}
                </Button>
                <Button variant="ghost" size="sm" icon={<Pencil size={13} aria-hidden="true" />} onClick={() => void openEditor()}>
                  {t('review.edit')}
                </Button>
              </div>
              {active.diff.state === 'ok' ? (
                <WorkspaceDiffSurface
                  value={active.diff.diff ?? ''}
                  path={active.file.displayPath}
                  hideSingleFileHeader
                  renderHunkAction={(hunkId) => (
                    <Button
                      variant="ghost"
                      size="xs"
                      aria-label={t('review.restoreHunk')}
                      loading={revertingHunkId === hunkId}
                      onClick={() => void revertHunk(hunkId)}
                      className="ml-auto opacity-0 group-hover:opacity-100 focus:opacity-100"
                      icon={<Undo2 size={12} aria-hidden="true" />}
                    >
                      {t('review.restoreHunk')}
                    </Button>
                  )}
                />
              ) : (
                <EmptyState
                  icon={<FileCode2 size={18} />}
                  title={t('review.diffUnavailable')}
                  description={active.diff.error ?? t('review.diffError')}
                  variant="plain"
                  className="min-h-0 flex-1"
                />
              )}
            </>
          )}
        </div>
      </div>

      <ConfirmDialog
        open={restoreIntent !== null}
        onClose={() => !restoring && setRestoreIntent(null)}
        onConfirm={confirmRestore}
        title={restoreIntent?.kind === 'all' ? t('review.restoreAllTitle') : t('review.restoreFileTitle')}
        body={restoreIntent?.kind === 'all'
          ? t('review.restoreAllBody')
          : t('review.restoreFileBody', { path: restoreIntent?.file.displayPath ?? '' })}
        confirmLabel={t('review.restore')}
        cancelLabel={t('common.cancel')}
        loading={restoring}
      />
    </section>
  )
}
