import { useCallback, useEffect, useMemo, useState } from 'react'
import { Check, FileCode2, Pencil, RefreshCw, Undo2, X } from 'lucide-react'
import {
  sessionsApi,
  type SessionTurnCheckpoint,
  type WorkspaceChangedFile,
  type WorkspaceDiffResult,
} from '../../api/sessions'
import { WorkspaceDiffSurface } from '../workspace/WorkspaceDiffSurface'
import { buildHunkRevertContent } from './reviewDiffActions'

type ReviewFile = WorkspaceChangedFile & { sourcePath: string }
type ReviewFileState = { file: ReviewFile; diff: WorkspaceDiffResult }

function displayName(path: string) {
  return path.split('/').filter(Boolean).at(-1) || path
}

function toReviewPath(filePath: string, workDir?: string) {
  const normalizedPath = filePath.replace(/\\/g, '/')
  const normalizedWorkDir = workDir?.replace(/\\/g, '/').replace(/\/+$/, '')
  return normalizedWorkDir && normalizedPath.startsWith(`${normalizedWorkDir}/`)
    ? normalizedPath.slice(normalizedWorkDir.length + 1)
    : normalizedPath
}

function checkpointFiles(checkpoint: SessionTurnCheckpoint | null): ReviewFile[] {
  if (!checkpoint) return []
  return checkpoint.code.filesChanged.map((sourcePath) => ({
    sourcePath,
    path: toReviewPath(sourcePath, checkpoint.workDir),
    status: 'modified' as const,
    additions: 0,
    deletions: 0,
  })).sort((left, right) => left.path.localeCompare(right.path))
}

function ReviewEditor({ value, saving, onCancel, onSave }: { value: string; saving: boolean; onCancel: () => void; onSave: (value: string) => void }) {
  const [draft, setDraft] = useState(value)
  useEffect(() => setDraft(value), [value])
  return <div className="flex min-h-0 flex-1 flex-col bg-[var(--color-code-bg)]">
    <div className="flex h-10 shrink-0 items-center gap-2 border-b border-[var(--color-text-primary)]/10 bg-[var(--color-surface)] px-4">
      <span className="text-[12px] font-medium text-[var(--color-text-secondary)]">Editing</span>
      <div className="ml-auto flex items-center gap-1.5">
        <button type="button" onClick={onCancel} disabled={saving} className="inline-flex h-7 items-center gap-1 rounded-[var(--radius-sm)] px-2 text-[12px] text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-hover)]">Cancel</button>
        <button type="button" onClick={() => onSave(draft)} disabled={saving || draft === value} className="inline-flex h-7 items-center gap-1 rounded-[var(--radius-sm)] bg-[var(--color-info)] px-2 text-[12px] font-medium text-white disabled:cursor-not-allowed disabled:opacity-40"><Check size={13} aria-hidden="true" />{saving ? 'Saving' : 'Save'}</button>
      </div>
    </div>
    <textarea aria-label="Edit file content" value={draft} onChange={(event) => setDraft(event.target.value)} spellCheck={false} className="min-h-0 flex-1 resize-none bg-transparent px-5 py-4 font-[var(--font-mono)] text-[13px] leading-5 text-[var(--color-code-fg)] outline-none" />
  </div>
}

/** Session-scoped review: fast turn evidence first, no full workspace scan on mount. */
export function ChangeReviewPanel({ sessionId }: { sessionId: string }) {
  const [checkpoint, setCheckpoint] = useState<SessionTurnCheckpoint | null>(null)
  const [files, setFiles] = useState<ReviewFile[]>([])
  const [openFiles, setOpenFiles] = useState<ReviewFileState[]>([])
  const [activePath, setActivePath] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [revertingHunkId, setRevertingHunkId] = useState<string | null>(null)
  const [revertingFile, setRevertingFile] = useState(false)
  const [editorContent, setEditorContent] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [filterQuery, setFilterQuery] = useState('')

  const refresh = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const response = await sessionsApi.getTurnCheckpoints(sessionId)
      // The last completed turn can be text-only/read-only. Review should show
      // the most recent turn that actually has cc checkpointed file changes,
      // matching the change card in the transcript.
      const nextCheckpoint = [...response.checkpoints].reverse().find((candidate) => (
        candidate.code.available && candidate.code.filesChanged.length > 0
      )) ?? null
      const nextFiles = checkpointFiles(nextCheckpoint)
      setCheckpoint(nextCheckpoint)
      // Review is deliberately scoped to the current turn. Do not fall back to
      // `svn status` here: that scans the whole checkout, is slow on large SVN
      // workspaces, and includes changes from other sessions/windows.
      const reviewFiles = nextFiles
      setFiles(reviewFiles)
      setOpenFiles((current) => current.filter((item) => reviewFiles.some((file) => file.path === item.file.path)))
      setActivePath((current) => reviewFiles.some((file) => file.path === current) ? current : null)
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : 'Unable to load the turn review')
    } finally {
      setLoading(false)
    }
  }, [sessionId])

  useEffect(() => { void refresh() }, [refresh])

  const active = useMemo(() => openFiles.find((item) => item.file.path === activePath) ?? null, [activePath, openFiles])
  const visibleFiles = useMemo(() => {
    const query = filterQuery.trim().toLowerCase()
    return files.filter((file) => !query || file.path.toLowerCase().includes(query))
  }, [files, filterQuery])

  const openFile = useCallback(async (file: ReviewFile) => {
    const existing = openFiles.find((item) => item.file.path === file.path)
    if (existing) {
      setActivePath(file.path)
      setEditorContent(null)
      return
    }
    setError(null)
    setEditorContent(null)
    try {
      const diff = checkpoint
        ? await sessionsApi.getTurnCheckpointDiff(sessionId, checkpoint.target.targetUserMessageId, file.sourcePath, checkpoint.target.userMessageIndex)
        : await sessionsApi.getWorkspaceDiff(sessionId, file.sourcePath)
      setOpenFiles((current) => [...current, { file, diff }])
      setActivePath(file.path)
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : 'Unable to load the file diff')
    }
  }, [checkpoint, openFiles, sessionId])

  const openEditor = useCallback(async () => {
    if (!active) return
    const file = await sessionsApi.getWorkspaceFile(sessionId, active.file.path)
    if (file.state !== 'ok' || typeof file.content !== 'string') {
      setError('Unable to edit this file as text')
      return
    }
    setEditorContent(file.content)
  }, [active, sessionId])

  const saveEditor = useCallback(async (content: string) => {
    if (!active || editorContent === null) return
    setSaving(true)
    try {
      const result = await sessionsApi.writeWorkspaceFile(sessionId, { path: active.file.path, expectedContent: editorContent, content })
      if (result.state !== 'ok') throw new Error(result.error ?? 'Unable to save file')
      setEditorContent(null)
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : 'Unable to save file')
    } finally {
      setSaving(false)
    }
  }, [active, editorContent, sessionId])

  const revertFile = useCallback(async () => {
    if (!active) return
    setRevertingFile(true)
    try {
      const file = await sessionsApi.getWorkspaceFile(sessionId, active.file.path)
      const expectedContent = file.state === 'ok' && typeof file.content === 'string' ? file.content : file.state === 'missing' ? null : undefined
      if (expectedContent === undefined) throw new Error('Unable to safely revert this file')
      const result = await sessionsApi.revertWorkspaceFile(sessionId, { path: active.file.path, expectedContent })
      if (result.state !== 'ok') throw new Error(result.error ?? 'Unable to revert file')
      setOpenFiles((current) => current.filter((item) => item.file.path !== active.file.path))
      setActivePath(null)
      setEditorContent(null)
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : 'Unable to revert file')
    } finally {
      setRevertingFile(false)
    }
  }, [active, sessionId])

  const revertHunk = useCallback(async (hunkId: string) => {
    if (!active || active.diff.state !== 'ok') return
    setRevertingHunkId(hunkId)
    try {
      const file = await sessionsApi.getWorkspaceFile(sessionId, active.file.path)
      if (file.state !== 'ok' || typeof file.content !== 'string') throw new Error('Unable to read file')
      const content = buildHunkRevertContent(file.content, active.diff.diff ?? '', active.file.path, hunkId)
      if (content === null) throw new Error('This hunk overlaps a later change')
      const result = await sessionsApi.writeWorkspaceFile(sessionId, { path: active.file.path, expectedContent: file.content, content })
      if (result.state !== 'ok') throw new Error(result.error ?? 'Unable to revert hunk')
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : 'Unable to revert hunk')
    } finally {
      setRevertingHunkId(null)
    }
  }, [active, sessionId])

  const closeTab = (path: string) => {
    const remaining = openFiles.filter((item) => item.file.path !== path)
    setOpenFiles(remaining)
    if (activePath === path) setActivePath(remaining.at(-1)?.file.path ?? null)
  }

  return <section data-testid="change-review-panel" className="flex min-h-0 flex-1 flex-col bg-[var(--color-surface)]">
    <header className="flex h-12 shrink-0 items-center gap-3 border-b border-[var(--color-text-primary)]/10 px-5">
      <span className="text-[13px] font-semibold text-[var(--color-text-primary)]">上一轮</span>
      <span className="font-[var(--font-mono)] text-[13px] tabular-nums"><span className="text-[var(--color-success)]">+{checkpoint?.code.insertions ?? files.reduce((total, file) => total + file.additions, 0)}</span><span className="ml-1 text-[var(--color-error)]">-{checkpoint?.code.deletions ?? files.reduce((total, file) => total + file.deletions, 0)}</span></span>
      <button type="button" onClick={() => void refresh()} aria-label="刷新修改清单" className="ml-auto inline-flex h-7 w-7 items-center justify-center rounded-[var(--radius-sm)] text-[var(--color-text-tertiary)] hover:bg-[var(--color-surface-hover)] hover:text-[var(--color-text-primary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-border-focus)]"><RefreshCw size={14} className={loading ? 'animate-spin' : ''} aria-hidden="true" /></button>
      {active && editorContent === null && <><button type="button" onClick={() => void revertFile()} disabled={revertingFile} className="inline-flex h-7 items-center gap-1 rounded-[var(--radius-sm)] px-2 text-[12px] text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-hover)] disabled:opacity-50"><Undo2 size={13} aria-hidden="true" />回退文件</button><button type="button" onClick={() => void openEditor()} className="inline-flex h-7 items-center gap-1 rounded-[var(--radius-sm)] px-2 text-[12px] text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-hover)]"><Pencil size={13} aria-hidden="true" />编辑</button></>}
    </header>
    {error && <div role="alert" className="border-b border-[var(--color-error)]/20 bg-[var(--color-error)]/8 px-5 py-2 text-[12px] text-[var(--color-error)]">{error}</div>}
    <div className="flex min-h-0 flex-1">
      <aside className="flex w-[280px] shrink-0 flex-col border-r border-[var(--color-text-primary)]/10 bg-[var(--color-surface-container-low)]">
        <div className="border-b border-[var(--color-text-primary)]/10 px-3 py-2.5"><input aria-label="筛选文件" value={filterQuery} onChange={(event) => setFilterQuery(event.target.value)} placeholder="筛选文件..." className="h-8 w-full rounded-[var(--radius-sm)] bg-[var(--color-surface-container)] px-3 text-[12px] text-[var(--color-text-primary)] outline-none placeholder:text-[var(--color-text-tertiary)] focus:ring-2 focus:ring-[var(--color-info)]/30" /></div>
        <div className="min-h-0 flex-1 overflow-auto py-2">{visibleFiles.map((file) => <button key={file.path} type="button" onClick={() => void openFile(file)} title={file.path} className={`flex min-h-9 w-full items-center gap-2 px-3 text-left text-[12px] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--color-border-focus)] ${activePath === file.path ? 'bg-[var(--color-surface-hover)] text-[var(--color-text-primary)]' : 'text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-hover)]'}`}><FileCode2 size={13} className="shrink-0 text-[var(--color-success)]" aria-hidden="true" /><span className="min-w-0 flex-1 truncate">{file.path}</span><span className="shrink-0 font-[var(--font-mono)] text-[10px]"><span className="text-[var(--color-success)]">+{file.additions}</span><span className="ml-1 text-[var(--color-error)]">-{file.deletions}</span></span></button>)}{!loading && visibleFiles.length === 0 && <div className="px-3 py-8 text-center text-[13px] text-[var(--color-text-tertiary)]">没有可审阅的本轮修改。</div>}</div>
      </aside>
      <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
        {openFiles.length > 0 && <div className="flex h-9 shrink-0 overflow-x-auto border-b border-[var(--color-text-primary)]/10 bg-[var(--color-surface-container-low)]">{openFiles.map((item) => <div key={item.file.path} className={`flex h-9 max-w-[220px] shrink-0 items-center gap-1 border-r border-[var(--color-text-primary)]/10 pl-3 text-[12px] ${activePath === item.file.path ? 'bg-[var(--color-surface)] text-[var(--color-text-primary)]' : 'text-[var(--color-text-secondary)]'}`}><button type="button" onClick={() => { setActivePath(item.file.path); setEditorContent(null) }} className="min-w-0 flex-1 truncate text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-border-focus)]">{displayName(item.file.path)}</button><button type="button" aria-label={`Close ${displayName(item.file.path)}`} onClick={() => closeTab(item.file.path)} className="mr-1 inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-[var(--radius-sm)] hover:bg-[var(--color-surface-hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-border-focus)]"><X size={13} aria-hidden="true" /></button></div>)}</div>}
        {!active ? <div className="flex flex-1 items-center justify-center px-5 text-[13px] text-[var(--color-text-tertiary)]">从左侧修改清单选择一个文件进行审阅。</div> : editorContent !== null ? <ReviewEditor value={editorContent} saving={saving} onCancel={() => setEditorContent(null)} onSave={(value) => void saveEditor(value)} /> : active.diff.state === 'ok' ? <div className="flex min-h-0 flex-1 flex-col"><div className="flex h-9 shrink-0 items-center gap-2 border-b border-[var(--color-text-primary)]/10 px-5 font-[var(--font-mono)] text-[12px] text-[var(--color-text-secondary)]"><FileCode2 size={14} className="text-[var(--color-success)]" aria-hidden="true" /><span className="min-w-0 flex-1 truncate">{active.file.path}</span></div><WorkspaceDiffSurface value={active.diff.diff ?? ''} path={active.file.path} hideSingleFileHeader renderHunkAction={(hunkId) => <button type="button" aria-label="撤销此差异块" disabled={revertingHunkId === hunkId} onClick={() => void revertHunk(hunkId)} className="ml-auto inline-flex h-6 shrink-0 items-center gap-1 rounded-[var(--radius-sm)] px-2 font-[var(--font-body)] text-[11px] font-medium text-[var(--color-text-secondary)] opacity-0 transition-[opacity,color,background-color] hover:bg-[var(--color-surface-hover)] hover:text-[var(--color-text-primary)] group-hover:opacity-100 focus:opacity-100 disabled:cursor-wait disabled:opacity-70"><Undo2 aria-hidden="true" size={12} />撤销此块</button>} /></div> : <div className="px-5 py-8 text-[13px] text-[var(--color-text-tertiary)]">{active.diff.error ?? '无法加载此文件的差异。'}</div>}
      </div>
    </div>
  </section>
}
