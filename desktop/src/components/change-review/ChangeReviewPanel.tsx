import { useCallback, useEffect, useMemo, useState } from 'react'
import { Check, ChevronDown, ChevronLeft, FileCode2, Folder, FolderOpen, PanelRightClose, PanelRightOpen, Pencil, RefreshCw, Undo2, X } from 'lucide-react'
import {
  sessionsApi,
  type WorkspaceChangedFile,
  type WorkspaceDiffResult,
  type WorkspaceStatusResult,
} from '../../api/sessions'
import { WorkspaceDiffSurface } from '../workspace/WorkspaceDiffSurface'
import { buildHunkRevertContent } from './reviewDiffActions'

type ReviewFileState = {
  file: WorkspaceChangedFile
  diff: WorkspaceDiffResult
}

type ChangedTreeNode = {
  name: string
  path: string
  file?: WorkspaceChangedFile
  children: Map<string, ChangedTreeNode>
}

function changeTotals(files: WorkspaceChangedFile[]) {
  return files.reduce((total, file) => ({
    additions: total.additions + file.additions,
    deletions: total.deletions + file.deletions,
  }), { additions: 0, deletions: 0 })
}

function displayName(path: string) {
  return path.split('/').filter(Boolean).at(-1) || path
}

function buildChangedTree(files: WorkspaceChangedFile[]) {
  const root: ChangedTreeNode = { name: '', path: '', children: new Map() }
  for (const file of files) {
    let parent = root
    const parts = file.path.split('/').filter(Boolean)
    parts.forEach((part, index) => {
      const path = [...parts.slice(0, index), part].join('/')
      let node = parent.children.get(part)
      if (!node) {
        node = { name: part, path, children: new Map() }
        parent.children.set(part, node)
      }
      if (index === parts.length - 1) node.file = file
      parent = node
    })
  }
  return root
}

function ReviewTreeFolder({
  node,
  depth,
  activePath,
  onOpen,
}: {
  node: ChangedTreeNode
  depth: number
  activePath: string | null
  onOpen: (file: WorkspaceChangedFile) => void
}) {
  const [expanded, setExpanded] = useState(true)
  const children = [...node.children.values()].sort((left, right) => Number(Boolean(right.file)) - Number(Boolean(left.file)) || left.name.localeCompare(right.name))
  return (
    <>
      {node.name && (
        <button
          type="button"
          onClick={() => setExpanded((current) => !current)}
          className="flex h-7 w-full items-center gap-1.5 pr-2 text-left text-[12px] font-medium text-[var(--color-text-primary)] hover:bg-[var(--color-surface-hover)]"
          style={{ paddingLeft: `${depth * 14 + 8}px` }}
        >
          <ChevronDown size={13} className={`shrink-0 transition-transform ${expanded ? '' : '-rotate-90'}`} aria-hidden="true" />
          {expanded ? <FolderOpen size={13} className="text-[var(--color-warning)]" aria-hidden="true" /> : <Folder size={13} className="text-[var(--color-warning)]" aria-hidden="true" />}
          <span className="min-w-0 truncate">{node.name}</span>
        </button>
      )}
      {expanded && children.map((child) => child.file ? (
    <button
      key={child.path}
      type="button"
      onClick={() => onOpen(child.file!)}
      className={`flex h-7 w-full items-center gap-2 truncate pr-2 text-left text-[12px] ${activePath === child.path ? 'bg-[var(--color-surface-hover)] text-[var(--color-text-primary)]' : 'text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-hover)]'}`}
      style={{ paddingLeft: `${depth * 14 + 12}px` }}
    >
      <FileCode2 size={13} className="shrink-0 text-[var(--color-success)]" aria-hidden="true" />
      <span className="min-w-0 flex-1 truncate">{child.name}</span>
      <span className="text-[10px] tabular-nums"><span className="text-[var(--color-success)]">+{child.file.additions}</span><span className="ml-1 text-[var(--color-error)]">-{child.file.deletions}</span></span>
    </button>
  ) : (
    <ReviewTreeFolder key={child.path} node={child} depth={depth + (node.name ? 1 : 0)} activePath={activePath} onOpen={onOpen} />
  ))}
    </>
  )
}

function ReviewChangeTree({
  node,
  activePath,
  onOpen,
}: {
  node: ChangedTreeNode
  activePath: string | null
  onOpen: (file: WorkspaceChangedFile) => void
}) {
  return <ReviewTreeFolder node={node} depth={0} activePath={activePath} onOpen={onOpen} />
}

function ReviewFileRow({
  file,
  active,
  onOpen,
}: {
  file: WorkspaceChangedFile
  active: boolean
  onOpen: () => void
}) {
  return (
    <button
      type="button"
      onClick={onOpen}
      className={`grid w-full grid-cols-[18px_minmax(0,1fr)_auto] items-center gap-2 border-b border-[var(--color-text-primary)]/10 px-5 py-2 text-left font-[var(--font-mono)] text-[13px] transition-colors ${
        active
          ? 'bg-[var(--color-surface-hover)] text-[var(--color-text-primary)]'
          : 'text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-hover)] hover:text-[var(--color-text-primary)]'
      }`}
    >
      <FileCode2 size={15} className="text-[var(--color-success)]" aria-hidden="true" />
      <span className="min-w-0 truncate"><span className="text-[var(--color-text-tertiary)]">{file.path.slice(0, Math.max(0, file.path.length - displayName(file.path).length))}</span><span className="font-medium text-[var(--color-text-primary)]">{displayName(file.path)}</span></span>
      <span className="flex items-center gap-1.5 text-[12px] tabular-nums">
        <span className="text-[var(--color-success)]">+{file.additions}</span>
        <span className="text-[var(--color-error)]">-{file.deletions}</span>
      </span>
    </button>
  )
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
  onSave: (next: string) => void
}) {
  const [draft, setDraft] = useState(value)

  useEffect(() => setDraft(value), [value])

  return (
    <div className="flex min-h-0 flex-1 flex-col bg-[var(--color-code-bg)]">
      <div className="flex h-10 shrink-0 items-center gap-2 border-b border-[var(--color-text-primary)]/10 bg-[var(--color-surface)] px-4">
        <span className="text-[12px] font-medium text-[var(--color-text-secondary)]">正在编辑</span>
        <div className="ml-auto flex items-center gap-1.5">
          <button type="button" onClick={onCancel} disabled={saving} className="inline-flex h-7 items-center gap-1 rounded-[5px] px-2 text-[12px] text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-hover)]">
            <X size={13} aria-hidden="true" />取消
          </button>
          <button type="button" onClick={() => onSave(draft)} disabled={saving || draft === value} className="inline-flex h-7 items-center gap-1 rounded-[5px] bg-[var(--color-info)] px-2 text-[12px] font-medium text-white disabled:cursor-not-allowed disabled:opacity-40">
            <Check size={13} aria-hidden="true" />{saving ? '保存中' : '保存'}
          </button>
        </div>
      </div>
      <textarea
        aria-label="编辑文件内容"
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        spellCheck={false}
        className="min-h-0 flex-1 resize-none bg-transparent px-5 py-4 font-[var(--font-mono)] text-[13px] leading-5 text-[var(--color-code-fg)] outline-none"
      />
    </div>
  )
}

/** Codex-style, session-scoped change review. All review behavior stays here. */
export function ChangeReviewPanel({ sessionId }: { sessionId: string }) {
  const [status, setStatus] = useState<WorkspaceStatusResult | null>(null)
  const [active, setActive] = useState<ReviewFileState | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [revertingHunkId, setRevertingHunkId] = useState<string | null>(null)
  const [revertingFile, setRevertingFile] = useState(false)
  const [editorContent, setEditorContent] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [filterQuery, setFilterQuery] = useState('')
  const [navigatorOpen, setNavigatorOpen] = useState(false)

  const refresh = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const nextStatus = await sessionsApi.getWorkspaceStatus(sessionId)
      setStatus(nextStatus)
      if (active && !nextStatus.changedFiles.some((file) => file.path === active.file.path)) {
        setActive(null)
        setEditorContent(null)
      }
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : '无法加载修改清单')
    } finally {
      setLoading(false)
    }
  }, [active, sessionId])

  useEffect(() => { void refresh() }, [refresh])

  const totals = useMemo(() => changeTotals(status?.changedFiles ?? []), [status?.changedFiles])
  const visibleFiles = useMemo(() => {
    const query = filterQuery.trim().toLowerCase()
    return (status?.changedFiles ?? []).filter((file) => !query || file.path.toLowerCase().includes(query))
  }, [filterQuery, status?.changedFiles])
  const changedTree = useMemo(() => buildChangedTree(status?.changedFiles ?? []), [status?.changedFiles])

  const openFile = useCallback(async (file: WorkspaceChangedFile) => {
    setError(null)
    setEditorContent(null)
    try {
      const diff = await sessionsApi.getWorkspaceDiff(sessionId, file.path)
      setActive({ file, diff })
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : '无法加载文件差异')
    }
  }, [sessionId])

  const openEditor = useCallback(async () => {
    if (!active) return
    try {
      const file = await sessionsApi.getWorkspaceFile(sessionId, active.file.path)
      if (file.state !== 'ok' || typeof file.content !== 'string') {
        setError('此文件当前无法作为文本编辑。')
        return
      }
      setEditorContent(file.content)
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : '无法读取文件内容')
    }
  }, [active, sessionId])

  const saveEditor = useCallback(async (nextContent: string) => {
    if (!active || editorContent === null) return
    setSaving(true)
    setError(null)
    try {
      const result = await sessionsApi.writeWorkspaceFile(sessionId, {
        path: active.file.path,
        expectedContent: editorContent,
        content: nextContent,
      })
      if (result.state !== 'ok') {
        setError(result.error ?? '保存失败，请刷新后重试。')
        return
      }
      setEditorContent(null)
      await refresh()
      await openFile(active.file)
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : '保存失败')
    } finally {
      setSaving(false)
    }
  }, [active, editorContent, openFile, refresh, sessionId])

  const revertHunk = useCallback(async (hunkId: string) => {
    if (!active || active.diff.state !== 'ok') return
    setRevertingHunkId(hunkId)
    setError(null)
    try {
      const file = await sessionsApi.getWorkspaceFile(sessionId, active.file.path)
      if (file.state !== 'ok' || typeof file.content !== 'string') {
        setError('文件已变更或无法读取，请刷新后重试。')
        return
      }
      const nextContent = buildHunkRevertContent(file.content, active.diff.diff ?? '', active.file.path, hunkId)
      if (nextContent === null) {
        setError('该差异块已与后续修改重叠，无法安全撤销。请刷新后改为手动编辑。')
        return
      }
      const result = await sessionsApi.writeWorkspaceFile(sessionId, {
        path: active.file.path,
        expectedContent: file.content,
        content: nextContent,
      })
      if (result.state !== 'ok') {
        setError(result.error ?? '撤销失败，请刷新后重试。')
        return
      }
      await refresh()
      await openFile(active.file)
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : '撤销失败')
    } finally {
      setRevertingHunkId(null)
    }
  }, [active, openFile, refresh, sessionId])

  const revertFile = useCallback(async () => {
    if (!active) return
    setRevertingFile(true)
    setError(null)
    try {
      const file = await sessionsApi.getWorkspaceFile(sessionId, active.file.path)
      const expectedContent = file.state === 'ok' && typeof file.content === 'string'
        ? file.content
        : file.state === 'missing'
          ? null
          : undefined
      if (expectedContent === undefined) {
        setError('此文件当前无法安全回退，请刷新后重试。')
        return
      }
      const result = await sessionsApi.revertWorkspaceFile(sessionId, {
        path: active.file.path,
        expectedContent,
      })
      if (result.state !== 'ok') {
        setError(result.error ?? '回退文件失败，请刷新后重试。')
        return
      }
      setActive(null)
      setEditorContent(null)
      await refresh()
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : '回退文件失败')
    } finally {
      setRevertingFile(false)
    }
  }, [active, refresh, sessionId])

  return (
    <section data-testid="change-review-panel" className="flex min-h-0 flex-1 flex-col bg-[var(--color-surface)]">
      <header className="flex h-12 shrink-0 items-center gap-3 border-b border-[var(--color-text-primary)]/10 px-5">
        {active ? (
          <button type="button" onClick={() => { setActive(null); setEditorContent(null) }} className="inline-flex h-7 items-center gap-1 rounded-[5px] px-1.5 text-[13px] text-[var(--color-text-primary)] hover:bg-[var(--color-surface-hover)]">
            <ChevronLeft size={16} aria-hidden="true" />修改清单
          </button>
        ) : <span className="text-[13px] font-semibold text-[var(--color-text-primary)]">上一轮</span>}
        <span className="font-[var(--font-mono)] text-[13px] tabular-nums"><span className="text-[var(--color-success)]">+{totals.additions}</span><span className="ml-1 text-[var(--color-error)]">-{totals.deletions}</span></span>
        <button type="button" onClick={() => void refresh()} aria-label="刷新修改清单" className="ml-auto inline-flex h-7 w-7 items-center justify-center rounded-[5px] text-[var(--color-text-tertiary)] hover:bg-[var(--color-surface-hover)] hover:text-[var(--color-text-primary)]">
          <RefreshCw size={14} className={loading ? 'animate-spin' : ''} aria-hidden="true" />
        </button>
        <button type="button" onClick={() => setNavigatorOpen((current) => !current)} aria-label={navigatorOpen ? '隐藏文件' : '显示文件'} className="inline-flex h-7 w-7 items-center justify-center rounded-[5px] text-[var(--color-text-tertiary)] hover:bg-[var(--color-surface-hover)] hover:text-[var(--color-text-primary)]">
          {navigatorOpen ? <PanelRightClose size={15} aria-hidden="true" /> : <PanelRightOpen size={15} aria-hidden="true" />}
        </button>
        {active && editorContent === null && (
          <>
            <button type="button" onClick={() => void revertFile()} disabled={revertingFile} className="inline-flex h-7 items-center gap-1 rounded-[5px] px-2 text-[12px] text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-hover)] hover:text-[var(--color-text-primary)] disabled:cursor-wait disabled:opacity-50">
              <Undo2 size={13} aria-hidden="true" />{revertingFile ? '回退中' : '回退文件'}
            </button>
            <button type="button" onClick={() => void openEditor()} className="inline-flex h-7 items-center gap-1 rounded-[5px] px-2 text-[12px] text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-hover)] hover:text-[var(--color-text-primary)]">
              <Pencil size={13} aria-hidden="true" />编辑
            </button>
          </>
        )}
      </header>

      {error && <div role="alert" className="border-b border-[var(--color-error)]/20 bg-[var(--color-error)]/8 px-5 py-2 text-[12px] text-[var(--color-error)]">{error}</div>}

      {!active ? (
        <div className="flex min-h-0 flex-1">
          <div className="min-h-0 min-w-0 flex-1 overflow-auto">
            <div className="border-b border-[var(--color-text-primary)]/10 px-5 py-2.5">
              <input aria-label="筛选文件" value={filterQuery} onChange={(event) => setFilterQuery(event.target.value)} placeholder="筛选文件..." className="h-8 w-full rounded-[6px] bg-[var(--color-surface-container)] px-3 text-[12px] text-[var(--color-text-primary)] outline-none placeholder:text-[var(--color-text-tertiary)] focus:ring-2 focus:ring-[var(--color-info)]/30" />
            </div>
          {visibleFiles.map((file) => (
            <ReviewFileRow key={`${file.path}:${file.status}`} file={file} active={false} onOpen={() => void openFile(file)} />
          ))}
          {!loading && visibleFiles.length === 0 && (
            <div className="px-5 py-12 text-center text-[13px] text-[var(--color-text-tertiary)]">没有可审阅的修改。</div>
          )}
          </div>
          {navigatorOpen && (
            <aside className="w-[280px] shrink-0 overflow-auto border-l border-[var(--color-text-primary)]/10 bg-[var(--color-surface-container-low)] py-2">
              <div className="px-3 pb-2 text-[12px] font-semibold text-[var(--color-text-primary)]">文件</div>
              <ReviewChangeTree node={changedTree} activePath={null} onOpen={(file) => void openFile(file)} />
            </aside>
          )}
        </div>
      ) : editorContent !== null ? (
        <ReviewEditor value={editorContent} saving={saving} onCancel={() => setEditorContent(null)} onSave={(next) => void saveEditor(next)} />
      ) : active.diff.state === 'ok' ? (
        <div className="flex min-h-0 flex-1 flex-col">
          <div className="flex h-9 shrink-0 items-center gap-2 border-b border-[var(--color-text-primary)]/10 px-5 font-[var(--font-mono)] text-[12px] text-[var(--color-text-secondary)]">
            <FileCode2 size={14} className="text-[var(--color-success)]" aria-hidden="true" />
            <span className="min-w-0 flex-1 truncate">{active.file.path}</span>
            <span className="text-[var(--color-success)]">+{active.file.additions}</span><span className="text-[var(--color-error)]">-{active.file.deletions}</span>
          </div>
          <WorkspaceDiffSurface
            value={active.diff.diff ?? ''}
            path={active.file.path}
            hideSingleFileHeader
            renderHunkAction={(hunkId) => (
              <button
                type="button"
                aria-label="撤销此差异块"
                disabled={revertingHunkId === hunkId}
                onClick={() => void revertHunk(hunkId)}
                className="ml-auto inline-flex h-6 shrink-0 items-center gap-1 rounded-[5px] px-2 font-[var(--font-body)] text-[11px] font-medium text-[var(--color-text-secondary)] opacity-0 transition-[opacity,color,background-color] hover:bg-[var(--color-surface-hover)] hover:text-[var(--color-text-primary)] group-hover:opacity-100 focus:opacity-100 disabled:cursor-wait disabled:opacity-70"
              >
                <Undo2 aria-hidden="true" size={12} />{revertingHunkId === hunkId ? '撤销中' : '撤销此块'}
              </button>
            )}
          />
        </div>
      ) : (
        <div className="px-5 py-8 text-[13px] text-[var(--color-text-tertiary)]">{active.diff.error ?? '无法加载此文件的差异。'}</div>
      )}
    </section>
  )
}
