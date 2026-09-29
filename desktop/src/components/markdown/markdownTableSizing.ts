import { t } from '../../i18n'

export type ColumnMeasure = { natural: number; min: number }
export const MAX_COLUMN_WIDTH = 960
const clamp = (value: number, min: number, max = MAX_COLUMN_WIDTH) => Math.max(min, Math.min(max, value))

/** Protect short values first; share the remaining space between long prose columns. */
export function allocateTableWidths(columns: ColumnMeasure[], available: number, manual: Map<number, number>) {
  const ideal = columns.map((column, i) => clamp(manual.get(i) ?? column.natural, column.min))
  const floor = columns.map((column, i) => manual.has(i) || ideal[i]! <= 240
    ? ideal[i]!
    : Math.max(column.min, 180))
  const total = ideal.reduce((sum, width) => sum + width, 0)
  if (total <= available) return ideal
  const minimum = floor.reduce((sum, width) => sum + width, 0)
  const ratio = Math.max(0, (available - minimum) / (total - minimum || 1))
  return ideal.map((width, i) => floor[i]! + (width - floor[i]!) * ratio)
}

/** Enhances sanitized, simple Markdown tables only. No document content is rewritten. */
export function enhanceDocumentTables(root: HTMLElement, saved: Map<number, Map<number, number>>) {
  const cleanups: Array<() => void> = []
  root.querySelectorAll<HTMLTableElement>('.md-table-wrap > table').forEach((table, tableIndex) => {
    const wrapper = table.parentElement!
    const headers = Array.from(table.tHead?.rows[0]?.cells ?? [])
    // Raw HTML may contain grouped headers, spans or nested tables; preserve native layout there.
    if (!headers.length || table.querySelector('table, colgroup') || table.tHead!.rows.length !== 1
      || Array.from(table.rows).some(row => row.cells.length !== headers.length
        || Array.from(row.cells).some(cell => cell.colSpan !== 1 || cell.rowSpan !== 1))) return

    const manual = saved.get(tableIndex) ?? new Map<number, number>()
    saved.set(tableIndex, manual)
    let measures: ColumnMeasure[] = []
    let widths: number[] = []
    let frame = 0
    let disposed = false
    let needsMeasure = true
    let lastWidth = -1
    let drag: { index: number; x: number; width: number; previous: number | undefined; pointer: number } | null = null
    const originalWidth = table.style.width
    const originalLayout = table.style.tableLayout
    const group = document.createElement('colgroup')
    const cols = headers.map(() => group.appendChild(document.createElement('col')))
    table.prepend(group)
    table.classList.add('md-sized-table')
    wrapper.classList.add('md-table-sized-wrap')

    const reset = document.createElement('button')
    reset.type = 'button'
    reset.className = 'md-table-reset'
    reset.textContent = t('markdown.table.reset')
    reset.title = t('markdown.table.resetHint')
    reset.hidden = true
    wrapper.before(reset)
    const handles = headers.map((header, i) => {
      const handle = document.createElement('span')
      handle.className = 'md-column-resizer'
      handle.tabIndex = 0
      handle.setAttribute('role', 'separator')
      handle.setAttribute('aria-orientation', 'vertical')
      handle.setAttribute('aria-label', t('markdown.table.resize', { column: header.textContent?.trim() || i + 1 }))
      handle.title = t('markdown.table.resizeHint')
      header.append(handle)
      return handle
    })

    function measure() {
      // One native max-content layout measures all rows, including bold/code/link fonts.
      group.style.display = 'none'
      table.classList.add('md-table-measuring')
      measures = headers.map((header, i) => {
        const range = document.createRange()
        range.selectNodeContents(header)
        range.setEndBefore(handles[i]!)
        const headerWidth = range.getBoundingClientRect().width + 37
        return { natural: Math.ceil(header.getBoundingClientRect().width + 2), min: clamp(headerWidth, 72, 240) }
      })
      table.classList.remove('md-table-measuring')
      group.style.display = ''
      needsMeasure = false
    }

    function apply() {
      if (disposed || wrapper.clientWidth <= 0) return
      if (needsMeasure) measure()
      widths = allocateTableWidths(measures, wrapper.clientWidth - 2, manual)
      table.style.tableLayout = 'fixed'
      table.style.width = `${widths.reduce((sum, width) => sum + width, 2)}px`
      widths.forEach((width, i) => {
        cols[i]!.style.width = `${width}px`
        handles[i]!.setAttribute('aria-valuemin', String(Math.ceil(measures[i]!.min)))
        handles[i]!.setAttribute('aria-valuemax', String(MAX_COLUMN_WIDTH))
        handles[i]!.setAttribute('aria-valuenow', String(Math.round(width)))
      })
      reset.hidden = manual.size === 0
    }

    function schedule(remeasure = false) {
      needsMeasure ||= remeasure
      if (!frame && !disposed) frame = requestAnimationFrame(() => { frame = 0; apply() })
    }

    function setWidth(index: number, width: number) {
      manual.set(index, clamp(width, measures[index]!.min))
      apply()
    }

    function stopDrag(cancel: boolean) {
      if (!drag) return
      const previous = drag
      drag = null
      if (cancel) {
        if (previous.previous === undefined) manual.delete(previous.index)
        else manual.set(previous.index, previous.previous)
      }
      const handle = handles[previous.index]!
      if (handle.hasPointerCapture?.(previous.pointer)) handle.releasePointerCapture(previous.pointer)
      wrapper.classList.remove('md-table-resizing')
      apply()
    }

    handles.forEach((handle, index) => {
      handle.onpointerdown = event => {
        if (event.button !== 0 || !widths.length || drag) return
        event.preventDefault()
        event.stopPropagation()
        handle.focus({ preventScroll: true })
        drag = { index, x: event.clientX, width: widths[index]!, previous: manual.get(index), pointer: event.pointerId }
        handle.setPointerCapture(event.pointerId)
        wrapper.classList.add('md-table-resizing')
      }
      handle.onpointermove = event => {
        if (!drag || drag.pointer !== event.pointerId) return
        setWidth(index, drag.width + event.clientX - drag.x)
      }
      handle.onpointerup = event => { if (drag?.pointer === event.pointerId) stopDrag(false) }
      handle.onpointercancel = () => stopDrag(true)
      handle.onlostpointercapture = () => stopDrag(false)
      handle.ondblclick = event => {
        event.preventDefault()
        event.stopPropagation()
        if (measures.length) setWidth(index, measures[index]!.natural)
      }
      handle.onclick = event => event.stopPropagation()
      handle.onkeydown = event => {
        if (event.key === 'Escape') { stopDrag(true); return }
        if (!widths.length || !['ArrowLeft', 'ArrowRight', 'Home', 'End', 'Enter'].includes(event.key)) return
        event.preventDefault()
        event.stopPropagation()
        const delta = event.shiftKey ? 40 : 10
        setWidth(index, event.key === 'Home' ? measures[index]!.min
          : event.key === 'End' ? MAX_COLUMN_WIDTH
            : event.key === 'Enter' ? measures[index]!.natural
              : widths[index]! + (event.key === 'ArrowLeft' ? -delta : delta))
      }
    })
    reset.onclick = () => { stopDrag(false); manual.clear(); apply() }
    const onBlur = () => stopDrag(true)
    window.addEventListener('blur', onBlur)
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(() => {
      if (Math.abs(wrapper.clientWidth - lastWidth) < 1) return
      lastWidth = wrapper.clientWidth
      schedule()
    })
    observer?.observe(wrapper)
    const onLoad = () => schedule(true)
    table.addEventListener('load', onLoad, true)
    void document.fonts?.ready.then(() => { if (!disposed) schedule(true) })
    apply()
    cleanups.push(() => {
      disposed = true
      stopDrag(true)
      cancelAnimationFrame(frame)
      observer?.disconnect()
      window.removeEventListener('blur', onBlur)
      table.removeEventListener('load', onLoad, true)
      handles.forEach(handle => handle.remove())
      group.remove()
      reset.remove()
      table.classList.remove('md-sized-table', 'md-table-measuring')
      wrapper.classList.remove('md-table-sized-wrap')
      table.style.width = originalWidth
      table.style.tableLayout = originalLayout
    })
  })
  return () => cleanups.forEach(cleanup => cleanup())
}
