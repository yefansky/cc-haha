import { useEffect, useMemo, useRef, useState } from 'react'
import type { WorkspaceSideBySideDiffSurfaceProps } from './WorkspaceSideBySideDiffSurface'
import type { WorkspaceSideBySideRow } from './workspaceSideBySideModel'
import { requestWorkspaceComparisonModel } from './workspaceComparisonRuntime'
import { createDefaultWorkspaceComparisonSettings } from './workspaceComparisonSettings'
import { editWorkspaceComparisonLine, getWorkspaceComparisonCapability, isWorkspaceComparisonSessionDirty, redoWorkspaceComparisonSession, undoWorkspaceComparisonSession, workspaceComparisonSessionToComparison, type WorkspaceComparisonSourceSide } from './workspaceComparisonSession'

export function canCompareAsTable(props: WorkspaceSideBySideDiffSurfaceProps) {
  const c = props.comparison
  const complete = (s: { state: string; exists: boolean; content?: string } | undefined) => s && ((s.state === 'ok' && typeof s.content === 'string') || (s.state === 'missing' && !s.exists))
  if (props.textPair || !(props.comparisonSession || (complete(c?.left) && complete(c?.right)))) return false
  return /\.(tab|tsv)$/i.test(props.path) || [props.comparisonSession?.left.content ?? c?.left.content, props.comparisonSession?.right.content ?? c?.right.content].some(text => {
    const lines = text?.split(/\r\n|\n|\r/, 9).filter(Boolean) ?? []
    return lines.length > 1 && lines.every(line => line.includes('\t'))
  })
}
export function tableCells(row: WorkspaceSideBySideRow, side: WorkspaceComparisonSourceSide) { return row[side]?.text.split('\t') ?? null }
export function sortedTableRows(rows: WorkspaceSideBySideRow[], column: number, direction: number) {
  if (!direction) return rows
  const collator = new Intl.Collator(undefined, { numeric: true })
  return rows.map(row => ({ row, key: (row.right?.text ?? row.left?.text ?? '').split('\t', column + 1)[column] ?? '' }))
    .sort((a, b) => direction * collator.compare(a.key, b.key)).map(item => item.row)
}
const ROW = 28, COLUMN = 150, GUTTER = 60
const SIDES = ['left', 'right'] as const
export function WorkspaceTableCompareSurface(props: WorkspaceSideBySideDiffSurfaceProps) {
  const session = props.comparisonSession
  const comparison = useMemo(() => session ? workspaceComparisonSessionToComparison(session) : props.comparison, [session, props.comparison])
  const [result, setResult] = useState<{ input: typeof comparison; rows: WorkspaceSideBySideRow[]; warning: boolean } | null>(null)
  const [error, setError] = useState('')
  const [filter, setFilter] = useState('all')
  const [sort, setSort] = useState({ column: 0, direction: 0 })
  const [detailLeft, setDetailLeft] = useState(0)
  const [selected, setSelected] = useState<string | null>(null)
  const [top, setTop] = useState(0)
  const [size, setSize] = useState({ height: 400, width: 600 })
  const [scrolls, setScrolls] = useState({ left: 0, right: 0 })
  const [draft, setDraft] = useState<{ side: WorkspaceComparisonSourceSide; line: number; column: number; cells: string[]; value: string; revision: number } | null>(null)
  const panes = useRef<{ left: HTMLDivElement | null; right: HTMLDivElement | null }>({ left: null, right: null })
  const container = useRef<HTMLDivElement>(null)
  useEffect(() => {
    let active = true
    setError('')
    void requestWorkspaceComparisonModel({ table: true, value: '', comparison, path: props.path, sessionRevision: session?.revision ?? 0, settingsRevision: session?.settingsRevision ?? 0, anchors: session?.manualAnchors ?? [], settings: session?.comparisonSettings ?? createDefaultWorkspaceComparisonSettings(props.path) }).then(response => {
      if (active) setResult({ input: comparison, rows: response.model.files.flatMap(file => file.rows).filter(row => row.left || row.right), warning: response.model.diagnostics.alignment.some(item => item.reason === 'work_unit_budget') })
    }).catch(reason => { if (active) setError(String(reason)) })
    return () => { active = false }
  }, [comparison, props.path, session])
  useEffect(() => {
    if (!container.current) return
    const observer = new ResizeObserver(entries => setSize({ height: entries[0]!.contentRect.height, width: entries[0]!.contentRect.width / 2 }))
    observer.observe(container.current)
    return () => observer.disconnect()
  }, [])
  const current = result?.input === comparison
  const allRows = useMemo(() => result?.rows ?? [], [result])
  const header = allRows[0]
  const columns = useMemo(() => {
    let count = 1
    for (const row of allRows) for (const side of SIDES) {
      const text = row[side]?.text
      if (text !== undefined) {
        let fields = 1
        for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 9) fields++
        count = Math.max(count, fields)
      }
    }
    return count
  }, [allRows])
  const rows = useMemo(() => sortedTableRows(allRows.slice(1).filter(row => filter === 'all' || (filter === 'same' ? row.kind === 'context' : row.kind !== 'context')), sort.column, sort.direction), [allRows, filter, sort])
  const activeRow = allRows.find(row => row.id === selected) ?? rows[0]
  const start = Math.max(0, Math.floor(top / ROW) - 3)
  const visible = rows.slice(start, start + Math.ceil(size.height / ROW) + 7)
  useEffect(() => { setTop(0); for (const side of SIDES) if (panes.current[side]) panes.current[side]!.scrollTop = 0 }, [filter, sort])
  const detailFrom = Math.max(0, Math.floor((detailLeft - GUTTER) / COLUMN) - 1)
  const detailTo = Math.min(columns, detailFrom + Math.ceil(size.width * 2 / COLUMN) + 3)
  const commit = () => {
    if (!draft || !session || !props.onComparisonSessionChange) return
    if (/[\t\r\n]/.test(draft.value)) { setError('单元格不能包含制表符或换行'); return }
    if (draft.revision !== session.revision) { setError('比较内容已更新，请重新选择单元格'); setDraft(null); return }
    const cells = [...draft.cells]
    while (cells.length <= draft.column) cells.push('')
    cells[draft.column] = draft.value
    props.onComparisonSessionChange(editWorkspaceComparisonLine(session, draft.side, draft.line, cells.join('\t'), draft.revision))
    setDraft(null)
  }
  const headers = (side: WorkspaceComparisonSourceSide, from: number, to: number) => Array.from({ length: to - from }, (_, offset) => {
    const column = from + offset
    return <button type="button" key={column} style={{ position: 'absolute', left: GUTTER + column * COLUMN, width: COLUMN, height: ROW, borderRight: '1px solid #8885', overflow: 'hidden', whiteSpace: 'nowrap', textAlign: 'left', padding: '0 6px' }} onClick={() => setSort(old => ({ column, direction: old.column === column ? (old.direction === 1 ? -1 : old.direction === -1 ? 0 : 1) : 1 }))}>{column + 1}: {header ? tableCells(header, side)?.[column] : ''}{sort.column === column && sort.direction ? sort.direction === 1 ? ' ↑' : ' ↓' : ''}</button>
  })
  const cellsView = (row: WorkspaceSideBySideRow, side: WorkspaceComparisonSourceSide, from: number, to: number) => {
    const cells = tableCells(row, side), other = tableCells(row, side === 'left' ? 'right' : 'left')
    return Array.from({ length: to - from }, (_, offset) => {
      const column = from + offset, changed = !cells || !other || cells[column] !== other[column]
      return <div role="gridcell" key={column} title={cells?.[column] ?? ''} onDoubleClick={() => {
        const line = row[side]?.oldLine ?? row[side]?.newLine
        if (!cells || !line || !session || !current || !props.onComparisonSessionChange || !getWorkspaceComparisonCapability(session, side).allowed) return
        setDraft({ side, line, column, cells, value: cells[column] ?? '', revision: session.revision })
      }} style={{ position: 'absolute', top: 0, left: GUTTER + column * COLUMN, width: COLUMN, height: ROW, padding: '3px 6px', overflow: 'hidden', whiteSpace: 'nowrap', borderRight: '1px solid #8884', background: !cells ? 'repeating-linear-gradient(135deg, transparent, transparent 4px, #8883 4px, #8883 5px)' : changed ? side === 'left' ? '#ef444430' : '#22c55e30' : undefined }}>{cells?.[column] ?? ''}</div>
    })
  }
  return <div className="flex min-h-0 flex-1 flex-col bg-[var(--color-code-bg)] text-[12px] text-[var(--color-text-primary)]" data-testid="table-compare">
    <div className="flex flex-wrap items-center gap-3 border-b p-2">
      <label>显示 <select aria-label="表格差异筛选" value={filter} onChange={event => setFilter(event.target.value)}><option value="all">全部</option><option value="differences">差异</option><option value="same">相同</option></select></label>
      <span>{rows.length} 行 · {columns} 列</span><button type="button" onClick={() => setSort({ column: 0, direction: 0 })}>恢复文件顺序</button>
      {session && <><button type="button" disabled={!current || !session.undoStack.length} onClick={() => props.onComparisonSessionChange?.(undoWorkspaceComparisonSession(session))}>撤销</button><button type="button" disabled={!current || !session.redoStack.length} onClick={() => props.onComparisonSessionChange?.(redoWorkspaceComparisonSession(session))}>重做</button><button type="button" disabled={!current || !!draft || props.saving || !props.onSave || !isWorkspaceComparisonSessionDirty(session)} onClick={() => void props.onSave?.(session)}>保存</button></>}
      {!current && <span role="status">正在对齐表格…</span>}
    </div>
    {(error || props.saveError) && <div role="alert">{error || props.saveError}</div>}
    {result?.warning && <div role="status">部分行使用快速对齐，请核对新增和删除行。</div>}
    {draft && <form className="flex gap-2 p-2" onSubmit={event => { event.preventDefault(); commit() }}><label>第 {draft.line} 行，第 {draft.column + 1} 列 <input autoFocus aria-label="编辑单元格" value={draft.value} onChange={event => setDraft({ ...draft, value: event.target.value })} onKeyDown={event => { if (event.key === 'Escape') setDraft(null) }} /></label><button type="submit">应用</button><button type="button" onClick={() => setDraft(null)}>取消</button></form>}
    <div ref={container} className="flex min-h-0 flex-1" style={{ opacity: current ? 1 : .5 }}>
      {SIDES.map(side => {
        const from = Math.max(0, Math.floor((scrolls[side] - GUTTER) / COLUMN) - 1), to = Math.min(columns, from + Math.ceil(size.width / COLUMN) + 3)
        return <div key={side} className="flex min-w-0 flex-1 flex-col border-r">
          <div className="truncate border-b px-2" title={comparison?.[side].source.path}>{side === 'left' ? '左侧' : '右侧'} · {comparison?.[side].source.path} · {comparison?.[side].actualEncoding} · {comparison?.[side].lineEnding}</div>
          <div ref={element => { panes.current[side] = element }} data-testid={`table-pane-${side}`} style={{ overflow: 'auto', flex: 1, minHeight: 0 }} onScroll={event => {
            const element = event.currentTarget; setTop(element.scrollTop); setScrolls(old => ({ ...old, [side]: element.scrollLeft }))
            const other = panes.current[side === 'left' ? 'right' : 'left']; if (other && other.scrollTop !== element.scrollTop) other.scrollTop = element.scrollTop
          }}>
            <div role="grid" style={{ position: 'relative', width: GUTTER + columns * COLUMN, height: (rows.length + 1) * ROW }}>
              <div role="row" style={{ position: 'sticky', top: 0, height: ROW, background: 'var(--color-code-bg)', zIndex: 2 }}>{headers(side, from, to)}</div>
              {visible.map((row, index) => <div role="row" key={row.id} onClick={() => setSelected(row.id)} aria-selected={activeRow?.id === row.id} style={{ position: 'absolute', top: (start + index + 1) * ROW, height: ROW, width: '100%', borderBottom: '1px solid #8884', background: activeRow?.id === row.id ? '#3b82f622' : undefined }}><span style={{ position: 'sticky', left: 0, display: 'inline-block', width: GUTTER, zIndex: 1, background: 'var(--color-code-bg)', height: ROW }}>{row[side]?.oldLine ?? row[side]?.newLine ?? '—'}</span>{cellsView(row, side, from, to)}</div>)}
            </div>
          </div>
        </div>
      })}
    </div>
    <div className="shrink-0 border-t" data-testid="table-row-detail" onScroll={event => setDetailLeft(event.currentTarget.scrollLeft)} style={{ maxHeight: 150, overflow: 'auto' }}><div className="sticky left-0">当前行详情 · 左 {activeRow?.left?.oldLine ?? '—'} / 右 {activeRow?.right?.newLine ?? '—'}</div><div style={{ width: GUTTER + columns * COLUMN }}><div style={{ position: 'relative', height: ROW }}>{headers('right', detailFrom, detailTo)}</div>{activeRow && SIDES.map(side => <div key={side} style={{ position: 'relative', height: ROW }}><span>{side === 'left' ? '左侧' : '右侧'}</span>{cellsView(activeRow, side, detailFrom, detailTo)}</div>)}</div></div>
  </div>
}
