import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { ChevronDown, ChevronRight, FileCode2, Files } from 'lucide-react'
import type { SessionTurnCheckpoint } from '../../api/sessions'
import { useTranslation } from '../../i18n'
import {
  getSessionTurnCheckpointSnapshot,
  loadSessionTurnCheckpoints,
  subscribeSessionTurnCheckpoints,
} from '../../lib/sessionTurnCheckpoints'
import {
  getWorkspacePreviewTabId,
  useWorkspacePanelStore,
} from '../../stores/workspacePanelStore'
import { relativizeWorkspacePath } from './CurrentTurnChangeCard'

type SessionChangedFilesStripProps = {
  sessionId: string
  workDir: string | null
  enabled: boolean
  refreshNonce: number
}

type SessionChangedFile = {
  sourcePath: string
  displayPath: string
  checkpoint: SessionTurnCheckpoint
}

function pathKey(path: string, workDir: string | null): string {
  const normalized = path.replace(/\\/g, '/')
  return workDir && /^[a-zA-Z]:[\\/]/.test(workDir) ? normalized.toLowerCase() : normalized
}

export function buildSessionChangedFiles(
  checkpoints: SessionTurnCheckpoint[],
  sessionWorkDir: string | null,
): SessionChangedFile[] {
  const byPath = new Map<string, SessionChangedFile>()

  for (const checkpoint of checkpoints) {
    if (!checkpoint.code.available) continue
    const checkpointWorkDir = checkpoint.workDir ?? sessionWorkDir
    for (const sourcePath of checkpoint.code.filesChanged) {
      const displayPath = relativizeWorkspacePath(sourcePath, checkpointWorkDir)
      const key = pathKey(displayPath, checkpointWorkDir)
      // Keep the latest checkpoint for fallback, but preserve a stable path list.
      byPath.set(key, { sourcePath, displayPath, checkpoint })
    }
  }

  return [...byPath.values()].sort((left, right) => left.displayPath.localeCompare(right.displayPath))
}

export function SessionChangedFilesStrip({
  sessionId,
  workDir,
  enabled,
  refreshNonce,
}: SessionChangedFilesStripProps) {
  const t = useTranslation()
  const [expanded, setExpanded] = useState(false)
  const warmedSignatureBySessionRef = useRef(new Map<string, string>())
  const subscribe = useCallback(
    (listener: () => void) => subscribeSessionTurnCheckpoints(sessionId, listener),
    [sessionId],
  )
  const getSnapshot = useCallback(
    () => getSessionTurnCheckpointSnapshot(sessionId),
    [sessionId],
  )
  const checkpointSnapshot = useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
  const files = useMemo(
    () => buildSessionChangedFiles(checkpointSnapshot.checkpoints, workDir),
    [checkpointSnapshot.checkpoints, workDir],
  )

  useEffect(() => {
    setExpanded(false)
  }, [sessionId])

  useEffect(() => {
    if (!enabled) return
    const workspace = useWorkspacePanelStore.getState()
    workspace.registerSessionWorkDir(sessionId, workDir ?? undefined)
    let cancelled = false
    void loadSessionTurnCheckpoints(sessionId)
      .then((checkpoints) => {
        if (cancelled) return
        const filesToWarm = buildSessionChangedFiles(checkpoints, workDir)
        const signature = filesToWarm.map((file) => (
          `${pathKey(file.displayPath, workDir)}\0${file.checkpoint.target.targetUserMessageId}\0${file.checkpoint.target.userMessageIndex}`
        )).join('\n')
        const previousSignature = warmedSignatureBySessionRef.current.get(sessionId)
        const force = previousSignature !== undefined && previousSignature !== signature
        warmedSignatureBySessionRef.current.set(sessionId, signature)
        for (const file of filesToWarm) {
          void workspace.preloadPreview(
            sessionId,
            file.displayPath,
            'file',
            { kind: 'workspace' },
            'auto',
            undefined,
            { force },
          ).catch(() => {})
        }
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [enabled, refreshNonce, sessionId, workDir])

  const openChangedFile = useCallback(async (file: SessionChangedFile) => {
    const workspace = useWorkspacePanelStore.getState()
    // This strip is the fast, readable view of files touched by the session.
    // Repository comparison remains an explicit workspace view, so opening a
    // row must never wait for a full Git/SVN status scan first.
    await workspace.openPreview(sessionId, file.displayPath, 'file')
    const fileTabId = getWorkspacePreviewTabId(file.displayPath, 'file')
    const fileTab = useWorkspacePanelStore.getState().previewTabsBySession[sessionId]
      ?.find((tab) => tab.id === fileTabId)
    if (fileTab?.state !== 'missing' && fileTab?.state !== 'error') return

    await workspace.openPreview(sessionId, file.displayPath, 'diff', undefined, undefined, {
      kind: 'turn',
      targetUserMessageId: file.checkpoint.target.targetUserMessageId,
      userMessageIndex: file.checkpoint.target.userMessageIndex,
    })
  }, [sessionId])

  if (files.length === 0) return null

  const listId = `session-changed-files-${encodeURIComponent(sessionId)}`

  return (
    <section
      data-testid="session-changed-files-strip"
      className="mb-2 overflow-hidden rounded-[var(--radius-lg)] border border-[var(--color-border)] bg-[var(--color-surface-container-low)]"
    >
      <button
        type="button"
        aria-expanded={expanded}
        aria-controls={listId}
        aria-label={t('chat.sessionChangedFilesToggle', { count: files.length })}
        onClick={() => setExpanded((current) => !current)}
        className="flex w-full items-center gap-2 px-3 py-2 text-left text-xs text-[var(--color-text-secondary)] transition-colors hover:bg-[var(--color-surface-hover)] hover:text-[var(--color-text-primary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--color-border-focus)]"
      >
        {expanded
          ? <ChevronDown size={14} strokeWidth={2} aria-hidden="true" />
          : <ChevronRight size={14} strokeWidth={2} aria-hidden="true" />}
        <Files size={15} strokeWidth={1.9} aria-hidden="true" />
        <span className="min-w-0 flex-1 truncate font-medium">{t('chat.sessionChangedFilesTitle')}</span>
        <span className="rounded-[var(--radius-sm)] bg-[var(--color-surface-container-high)] px-1.5 py-0.5 font-mono text-[11px] text-[var(--color-text-primary)]">
          {files.length}
        </span>
      </button>

      {expanded && (
        <div id={listId} className="max-h-40 overflow-y-auto border-t border-[var(--color-border)] py-1">
          {files.map((file) => {
            const normalizedPath = file.displayPath.replace(/\\/g, '/')
            const fileName = normalizedPath.split('/').pop() || normalizedPath
            const directory = normalizedPath.slice(0, Math.max(0, normalizedPath.length - fileName.length)).replace(/\/$/, '')
            return (
              <button
                key={pathKey(file.displayPath, workDir)}
                type="button"
                title={file.displayPath}
                aria-label={t('chat.sessionChangedFilesOpen', { path: file.displayPath })}
                onClick={() => { void openChangedFile(file) }}
                className="flex w-full min-w-0 items-center gap-2.5 px-3 py-1.5 text-left transition-colors hover:bg-[var(--color-surface-hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--color-border-focus)]"
              >
                <FileCode2 size={15} strokeWidth={1.8} aria-hidden="true" className="shrink-0 text-[var(--color-text-tertiary)]" />
                <span className="min-w-0 flex-1 truncate text-xs font-medium text-[var(--color-text-primary)]">{fileName}</span>
                {directory && (
                  <span className="max-w-[55%] truncate font-mono text-[10px] text-[var(--color-text-tertiary)]">{directory}</span>
                )}
              </button>
            )
          })}
        </div>
      )}
    </section>
  )
}
