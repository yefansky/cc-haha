import '@testing-library/jest-dom/vitest'
import { useState } from 'react'
import { act, createEvent, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { WorkspaceComparison, WorkspaceComparisonSide } from '@/api/sessions'
import { useSettingsStore } from '../../stores/settingsStore'
import { WorkspaceSideBySideDiffSurface } from './WorkspaceSideBySideDiffSurface'
import {
  createWorkspaceComparisonSession,
  editWorkspaceComparisonSide,
  saveWorkspaceComparisonSession,
} from './workspaceComparisonSession'
import { computeWorkspaceComparisonModel, type WorkspaceComparisonRuntimeRequest } from './workspaceComparisonRuntime'

const highlightRequestSpy = vi.hoisted(() => vi.fn())
const modelBuildSpy = vi.hoisted(() => vi.fn())

vi.mock('./workspaceDiffHighlightRuntime', () => ({
  createWorkspaceDiffHighlightCacheKey: (path: string, value: string) => `${path}:${value}`,
  requestWorkspaceDiffHighlight: highlightRequestSpy,
}))

vi.mock('./workspaceSideBySideModel', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./workspaceSideBySideModel')>()
  modelBuildSpy.mockImplementation(actual.buildWorkspaceSideBySideModel)
  return { ...actual, buildWorkspaceSideBySideModel: modelBuildSpy }
})

const diff = [
  'diff --git a/src/a.ts b/src/a.ts',
  '--- a/src/a.ts',
  '+++ b/src/a.ts',
  '@@ -10,3 +10,3 @@',
  ' const stable = true',
  '-const answer = 41',
  '-removeOnly()',
  '+const answer = 42',
  '+insertOnly()',
].join('\n')

const twoHunkPatch = [
  'diff --git a/src/a.ts b/src/a.ts',
  '--- a/src/a.ts',
  '+++ b/src/a.ts',
  '@@ -1,3 +1,3 @@',
  ' stable one',
  '-old first',
  '+new first',
  ' stable two',
  '@@ -10,3 +10,3 @@',
  ' stable ten',
  '-old second',
  '+new second',
  ' stable twelve',
].join('\n')

function side(content: string, overrides: Partial<WorkspaceComparisonSide> = {}): WorkspaceComparisonSide {
  return {
    source: { kind: 'working_tree', path: 'src/a.ts', revision: 'working-tree' },
    exists: true,
    state: 'ok',
    content,
    requestedEncoding: 'auto',
    actualEncoding: 'utf8',
    bom: 'none',
    lineEnding: content.includes('\n') ? 'lf' : 'none',
    writable: true,
    ...overrides,
  }
}

function comparison(left: WorkspaceComparisonSide, right: WorkspaceComparisonSide): WorkspaceComparison {
  return { schemaVersion: 1, left, right }
}

function diffCellForText(text: string, side: 'old' | 'new') {
  const cell = screen.getAllByText(text)
    .map((node) => node.closest<HTMLElement>('[data-diff-cell]'))
    .find((candidate) => candidate?.dataset.side === side)
  if (!cell) throw new Error(`Missing ${side} diff cell for ${text}`)
  return cell
}

const fullComparison = comparison(
  side('one\ntwo\nold three\nfour\nfive\nsix\nseven\nold eight\nnine\n'),
  side('one\ntwo\nnew three\nfour\nfive\nsix\nseven\nnew eight\nnine\n'),
)

function EditableHarness({ value }: { value: WorkspaceComparison }) {
  const [session, setSession] = useState(() => createWorkspaceComparisonSession(value)!)
  return (
    <WorkspaceSideBySideDiffSurface
      value=""
      comparison={value}
      comparisonSession={session}
      onComparisonSessionChange={setSession}
      path="src/a.ts"
    />
  )
}

function HistoryHarness({ value }: { value: WorkspaceComparison }) {
  const [session, setSession] = useState(() => createWorkspaceComparisonSession(value)!)
  return (
    <>
      <WorkspaceSideBySideDiffSurface
        value=""
        comparison={value}
        comparisonSession={session}
        onComparisonSessionChange={setSession}
        path="src/a.ts"
      />
      <output data-testid="history-right-content">{session.right.content}</output>
    </>
  )
}

function InlineSaveHarness({
  value,
  writer,
}: {
  value: WorkspaceComparison
  writer: Parameters<typeof saveWorkspaceComparisonSession>[1]
}) {
  const [session, setSession] = useState(() => createWorkspaceComparisonSession(value)!)
  return (
    <WorkspaceSideBySideDiffSurface
      value=""
      comparison={value}
      comparisonSession={session}
      onComparisonSessionChange={setSession}
      onSave={async (exactSession) => {
        const outcome = await saveWorkspaceComparisonSession(exactSession, writer)
        setSession(outcome.session)
      }}
      path="src/a.ts"
    />
  )
}

function EncodingHarness({ value, onEncodingChange }: {
  value: WorkspaceComparison
  onEncodingChange: (side: 'left' | 'right', encoding: 'auto' | 'utf8' | 'gbk') => void
}) {
  const [session, setSession] = useState(() => createWorkspaceComparisonSession(value)!)
  return (
    <WorkspaceSideBySideDiffSurface
      value=""
      comparison={value}
      comparisonSession={session}
      onComparisonSessionChange={setSession}
      onEncodingChange={onEncodingChange}
      path="src/a.ts"
    />
  )
}

function ExistenceHarness({ value }: { value: WorkspaceComparison }) {
  const [session, setSession] = useState(() => createWorkspaceComparisonSession(value)!)
  return (
    <>
      <WorkspaceSideBySideDiffSurface
        value=""
        comparison={value}
        comparisonSession={session}
        onComparisonSessionChange={setSession}
        path="src/empty.ts"
      />
      <output data-testid="existence-state">
        {JSON.stringify({ left: session.left.exists, right: session.right.exists })}
      </output>
    </>
  )
}

describe('WorkspaceSideBySideDiffSurface', () => {
  beforeEach(() => {
    useSettingsStore.setState({ locale: 'en' })
    highlightRequestSpy.mockReset()
    highlightRequestSpy.mockImplementation(() => new Promise(() => {}))
    modelBuildSpy.mockClear()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('renders old and new panes in one synchronized scroll surface with real line numbers', () => {
    render(<WorkspaceSideBySideDiffSurface value={diff} path="src/a.ts" hideSingleFileHeader />)

    const scroll = screen.getByTestId('workspace-side-by-side-diff-scroll')
    expect(scroll).toHaveClass('overflow-auto')
    expect(screen.getByTestId('workspace-side-by-side-diff-content')).toHaveClass('w-full', 'min-w-0')
    expect(screen.getByRole('grid', { name: 'src/a.ts diff' })).toBeInTheDocument()
    expect(screen.getByText(/^old ·/)).toBeInTheDocument()
    expect(screen.getByText(/^new ·/)).toBeInTheDocument()
    expect(screen.getByText('11', { selector: '[data-diff-line-number][data-side="old"]' })).toBeInTheDocument()
    expect(screen.getByText('11', { selector: '[data-diff-line-number][data-side="new"]' })).toBeInTheDocument()
    expect(screen.getByText('const answer = 41')).toBeInTheDocument()
    expect(screen.getByText('const answer = 42')).toBeInTheDocument()
  })

  it('resizes both comparison panes by dragging the center separator', () => {
    render(<WorkspaceSideBySideDiffSurface value="" comparison={fullComparison} path="src/a.ts" />)

    const content = screen.getByTestId('workspace-side-by-side-diff-content')
    vi.spyOn(content, 'getBoundingClientRect').mockReturnValue({
      x: 100,
      y: 0,
      left: 100,
      top: 0,
      right: 1100,
      bottom: 500,
      width: 1000,
      height: 500,
      toJSON: () => ({}),
    })
    const separator = screen.getByRole('separator', { name: 'Resize comparison panes' })

    expect(separator).toHaveAttribute('aria-valuenow', '50')
    const pointerDown = createEvent.pointerDown(separator)
    Object.defineProperty(pointerDown, 'button', { value: 0 })
    Object.defineProperty(pointerDown, 'clientX', { value: 600 })
    fireEvent(separator, pointerDown)
    const moveTo = (clientX: number) => {
      const pointerMove = createEvent.pointerMove(window)
      Object.defineProperty(pointerMove, 'clientX', { value: clientX })
      fireEvent(window, pointerMove)
    }
    moveTo(0)
    expect(separator).toHaveAttribute('aria-valuenow', '20')
    moveTo(2000)
    expect(separator).toHaveAttribute('aria-valuenow', '80')
    moveTo(800)
    fireEvent(window, createEvent.pointerUp(window))

    expect(separator).toHaveAttribute('aria-valuenow', '70')
    expect(content.querySelector('[data-side-by-side-row]')).toHaveStyle({
      gridTemplateColumns: 'minmax(0, 70%) minmax(0, 30%)',
    })

    fireEvent.keyDown(separator, { key: 'Home' })
    fireEvent.keyDown(separator, { key: 'ArrowLeft' })
    expect(separator).toHaveAttribute('aria-valuenow', '20')
    fireEvent.keyDown(separator, { key: 'End' })
    fireEvent.keyDown(separator, { key: 'ArrowRight' })
    expect(separator).toHaveAttribute('aria-valuenow', '80')
    fireEvent.doubleClick(separator)
    expect(separator).toHaveAttribute('aria-valuenow', '50')
  })

  it('renders an observable placeholder instead of inventing content for an unmatched side', () => {
    render(<WorkspaceSideBySideDiffSurface value={[
      '@@ -1 +1,2 @@',
      ' stable',
      '+inserted',
    ].join('\n')} path="src/a.ts" hideSingleFileHeader />)

    const row = screen.getByText('inserted').closest('[data-side-by-side-row]')
    const placeholder = row?.querySelector('[data-diff-placeholder][data-side="old"]')
    expect(placeholder).toBeInTheDocument()
    expect(placeholder).toHaveAttribute('data-diff-tone', 'placeholder')
    expect(placeholder).toHaveClass('grid')
    const placeholderFill = placeholder?.querySelector('[data-diff-placeholder-fill]')
    expect(placeholderFill).toHaveClass('bg-[var(--color-surface-container-high)]')
    expect(placeholderFill).toHaveStyle({
      backgroundImage: 'repeating-linear-gradient(135deg, transparent 0, transparent 5px, var(--color-border) 5px, var(--color-border) 6px)',
    })
    expect(row?.querySelector('[data-diff-placeholder][data-side="new"]')).toBeNull()
  })

  it('uses Beyond Compare visual semantics without unified diff prefixes or green additions', () => {
    render(<WorkspaceSideBySideDiffSurface value={diff} path="src/a.ts" hideSingleFileHeader />)

    const oldCell = screen.getByText('const answer = 41').closest('[data-diff-cell]')
    const newCell = screen.getByText('const answer = 42').closest('[data-diff-cell]')
    expect(oldCell).toHaveAttribute('data-diff-tone', 'difference')
    expect(newCell).toHaveAttribute('data-diff-tone', 'difference')
    expect(oldCell).toHaveClass('bg-[var(--color-diff-removed-bg)]')
    expect(newCell).toHaveClass('bg-[var(--color-diff-removed-bg)]')
    expect(oldCell).not.toHaveClass('bg-[var(--color-diff-added-bg)]')
    expect(newCell).not.toHaveClass('bg-[var(--color-diff-added-bg)]')
    expect(document.querySelector('[data-diff-prefix]')).not.toBeInTheDocument()
    expect(screen.queryByText('+', { selector: '[data-diff-cell] *' })).not.toBeInTheDocument()
    expect(screen.queryByText('-', { selector: '[data-diff-cell] *' })).not.toBeInTheDocument()
  })

  it('keeps both panes inside the viewport while long lines scroll within their pane', () => {
    const longLine = 'const label = "this line stays readable without wrapping or shrinking into the viewport"'
    render(<WorkspaceSideBySideDiffSurface value={`@@ -1 +1 @@\n-${longLine}\n+${longLine} changed`} path="src/a.ts" />)

    const content = screen.getByTestId('workspace-side-by-side-diff-content')
    expect(content).toHaveClass('w-full', 'min-w-0')
    expect(content).not.toHaveClass('w-max')
    const oldCell = screen.getByText(longLine).closest('[data-diff-cell]')
    const newCell = screen.getByText(`${longLine} changed`).closest('[data-diff-cell]')
    expect(oldCell).toHaveClass('min-w-0', 'overflow-hidden')
    expect(newCell).toHaveClass('min-w-0', 'overflow-hidden')
    expect(screen.getByText(longLine).closest('[data-diff-pane-scroll-content]')).toHaveClass('min-w-0', 'overflow-x-auto', '[scrollbar-width:none]')
    expect(screen.getByText(`${longLine} changed`).closest('[data-diff-pane-scroll-content]')).toHaveClass('min-w-0', 'overflow-x-auto', '[scrollbar-width:none]')
  })

  it('provides independent bottom scrollbars that move every row in their own pane', () => {
    const originalScrollWidth = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'scrollWidth')
    Object.defineProperty(HTMLElement.prototype, 'scrollWidth', {
      configurable: true,
      get(this: HTMLElement) {
        if (!this.hasAttribute('data-diff-pane-natural-content')) return 0
        return this.dataset.side === 'old' ? 960 : 720
      },
    })

    try {
      render(<WorkspaceSideBySideDiffSurface value="" comparison={fullComparison} path="src/a.ts" />)

      const oldScrollbar = screen.getByTestId('workspace-diff-pane-scrollbar-old')
      const newScrollbar = screen.getByTestId('workspace-diff-pane-scrollbar-new')
      const oldRows = [...document.querySelectorAll<HTMLElement>('[data-diff-pane-scroll-content][data-side="old"]')]
      const newRows = [...document.querySelectorAll<HTMLElement>('[data-diff-pane-scroll-content][data-side="new"]')]

      expect(oldScrollbar).toHaveAccessibleName('Scroll old code horizontally')
      expect(newScrollbar).toHaveAccessibleName('Scroll new code horizontally')
      expect(oldScrollbar).toHaveClass('overflow-x-scroll')
      expect(newScrollbar).toHaveClass('overflow-x-scroll')
      expect(oldScrollbar.firstElementChild).toHaveStyle({ width: '960px' })
      expect(newScrollbar.firstElementChild).toHaveStyle({ width: '720px' })

      oldScrollbar.scrollLeft = 120
      fireEvent.scroll(oldScrollbar)
      expect(oldRows.every((row) => row.scrollLeft === 120)).toBe(true)
      expect(newRows.every((row) => row.scrollLeft === 0)).toBe(true)
      expect(newScrollbar.scrollLeft).toBe(0)

      newScrollbar.scrollLeft = 72
      fireEvent.scroll(newScrollbar)
      expect(newRows.every((row) => row.scrollLeft === 72)).toBe(true)
      expect(oldRows.every((row) => row.scrollLeft === 120)).toBe(true)
      expect(oldScrollbar.scrollLeft).toBe(120)

      oldRows[0]!.scrollLeft = 48
      fireEvent.scroll(oldRows[0]!)
      expect(oldScrollbar.scrollLeft).toBe(48)
      expect(oldRows.every((row) => row.scrollLeft === 48)).toBe(true)
      expect(newScrollbar.scrollLeft).toBe(72)
    } finally {
      if (originalScrollWidth) {
        Object.defineProperty(HTMLElement.prototype, 'scrollWidth', originalScrollWidth)
      } else {
        Reflect.deleteProperty(HTMLElement.prototype, 'scrollWidth')
      }
    }
  })

  it('keeps a mixed-width pane at offset 600 when the short row emits its programmatic scroll event', () => {
    const originalScrollWidth = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'scrollWidth')
    Object.defineProperty(HTMLElement.prototype, 'scrollWidth', {
      configurable: true,
      get(this: HTMLElement) {
        if (!this.hasAttribute('data-diff-pane-natural-content')) return 0
        const isLongRow = this.textContent?.includes('eight') ?? false
        if (this.dataset.side === 'new') return isLongRow ? 3137 : 87
        return isLongRow ? 1400 : 64
      },
    })

    try {
      render(<WorkspaceSideBySideDiffSurface value="" comparison={fullComparison} path="src/a.ts" />)

      const oldScrollbar = screen.getByTestId('workspace-diff-pane-scrollbar-old')
      const newScrollbar = screen.getByTestId('workspace-diff-pane-scrollbar-new')
      const oldRows = [...document.querySelectorAll<HTMLElement>('[data-diff-pane-scroll-content][data-side="old"]')]
      const newRows = [...document.querySelectorAll<HTMLElement>('[data-diff-pane-scroll-content][data-side="new"]')]
      const oldTracks = [...document.querySelectorAll<HTMLElement>('[data-diff-pane-scroll-content][data-side="old"] [data-diff-pane-scroll-track]')]
      const newTracks = [...document.querySelectorAll<HTMLElement>('[data-diff-pane-scroll-content][data-side="new"] [data-diff-pane-scroll-track]')]

      expect(oldTracks.every((track) => track.style.minWidth === '1400px')).toBe(true)
      expect(newTracks.every((track) => track.style.minWidth === '3137px')).toBe(true)

      newScrollbar.scrollLeft = 600
      fireEvent.scroll(newScrollbar)
      expect(newRows.every((row) => row.scrollLeft === 600)).toBe(true)

      fireEvent.scroll(newRows[0]!)
      expect(newScrollbar.scrollLeft).toBe(600)
      expect(newRows.every((row) => row.scrollLeft === 600)).toBe(true)
      expect(oldRows.every((row) => row.scrollLeft === 0)).toBe(true)

      oldScrollbar.scrollLeft = 250
      fireEvent.scroll(oldScrollbar)
      expect(oldRows.every((row) => row.scrollLeft === 250)).toBe(true)
      expect(newRows.every((row) => row.scrollLeft === 600)).toBe(true)
      expect(newScrollbar.scrollLeft).toBe(600)
    } finally {
      if (originalScrollWidth) {
        Object.defineProperty(HTMLElement.prototype, 'scrollWidth', originalScrollWidth)
      } else {
        Reflect.deleteProperty(HTMLElement.prototype, 'scrollWidth')
      }
    }
  })

  it('submits a side-aware review comment without making either source editable', () => {
    const onAddComment = vi.fn()
    render(<WorkspaceSideBySideDiffSurface value={diff} path="src/a.ts" onAddComment={onAddComment} />)

    fireEvent.click(screen.getByRole('button', { name: 'Comment on src/a.ts new line 11' }))
    fireEvent.change(screen.getByRole('textbox', { name: 'Review comment' }), {
      target: { value: 'Use the shared constant' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Submit review comment' }))

    expect(onAddComment).toHaveBeenCalledWith(expect.objectContaining({
      side: 'new',
      lineStart: 11,
      lineEnd: 11,
      quote: 'const answer = 42',
    }), 'Use the shared constant')
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument()
  })

  it('keeps the existing Shift range review contract within one side and hunk', () => {
    const onAddComment = vi.fn()
    render(<WorkspaceSideBySideDiffSurface value={diff} path="src/a.ts" onAddComment={onAddComment} />)

    fireEvent.click(screen.getByRole('button', { name: 'Comment on src/a.ts old line 11' }))
    fireEvent.click(screen.getByRole('button', { name: 'Comment on src/a.ts old line 12' }), { shiftKey: true })
    fireEvent.change(screen.getByRole('textbox', { name: 'Review comment' }), {
      target: { value: 'Keep this pair together' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Submit review comment' }))

    expect(onAddComment).toHaveBeenCalledWith(expect.objectContaining({
      side: 'old',
      lineStart: 11,
      lineEnd: 12,
      quote: 'const answer = 41\nremoveOnly()',
    }), 'Keep this pair together')
  })

  it('switches between all, differences, context, and same using complete comparison content', () => {
    render(<WorkspaceSideBySideDiffSurface value={diff} comparison={fullComparison} path="src/a.ts" />)

    fireEvent.click(screen.getByRole('radio', { name: 'Differences' }))
    expect(screen.getByText('new three')).toBeInTheDocument()
    expect(screen.queryByText('four')).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('radio', { name: 'Same' }))
    expect(screen.getAllByText('four')).toHaveLength(2)
    expect(screen.queryByText('new three')).not.toBeInTheDocument()
    const sameRow = screen.getAllByText('four')[0]?.closest('[data-side-by-side-row]')
    expect(sameRow).toHaveClass('w-full', 'min-w-0')
    expect(sameRow?.querySelector('[data-visual-pane="old"]')).toBeInTheDocument()
    expect(sameRow?.querySelector('[data-visual-pane="new"]')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('radio', { name: 'All' }))
    expect(screen.getByText('new three')).toBeInTheDocument()
    expect(screen.getAllByText('four')).toHaveLength(2)
    const changedRow = screen.getByText('new three').closest('[data-side-by-side-row]')
    expect(changedRow).toHaveClass('w-full', 'min-w-0')
    expect(changedRow?.querySelector('[data-visual-pane="old"]')).toHaveTextContent('old three')
    expect(changedRow?.querySelector('[data-visual-pane="new"]')).toHaveTextContent('new three')
    expect(changedRow).toHaveStyle({
      gridTemplateColumns: 'minmax(0, 50%) minmax(0, 50%)',
    })

    fireEvent.click(screen.getByRole('radio', { name: 'Context' }))
    expect(screen.getByText('new eight')).toBeInTheDocument()
  })

  it('keeps full-file modes disabled with a localized reason while patch modes still work', () => {
    render(<WorkspaceSideBySideDiffSurface value={diff} path="src/a.ts" />)

    expect(screen.getByRole('radio', { name: 'All' })).toBeDisabled()
    expect(screen.getByRole('radio', { name: 'Same' })).toBeDisabled()
    expect(screen.getByRole('status')).toHaveTextContent('only patch data is available')
    fireEvent.click(screen.getByRole('radio', { name: 'Differences' }))
    expect(screen.getByText('const answer = 42')).toBeInTheDocument()
  })

  it('reports binary, undecodable, and too-large blockers without hiding patch differences', () => {
    const { rerender } = render(
      <WorkspaceSideBySideDiffSurface
        value={diff}
        comparison={comparison(side('', { state: 'binary', content: undefined }), side('new'))}
        path="src/a.ts"
      />,
    )
    expect(screen.getByRole('status')).toHaveTextContent('a side is binary')

    rerender(
      <WorkspaceSideBySideDiffSurface
        value={diff}
        comparison={comparison(side('', { state: 'undecodable', content: undefined }), side('new'))}
        path="src/a.ts"
      />,
    )
    expect(screen.getByRole('status')).toHaveTextContent('a side cannot be decoded')

    rerender(
      <WorkspaceSideBySideDiffSurface
        value={diff}
        comparison={comparison(side('old'), side('', { state: 'too_large', content: undefined }))}
        path="src/a.ts"
      />,
    )
    expect(screen.getByRole('status')).toHaveTextContent('a side is too large to load')
    expect(screen.getByText('const answer = 42')).toBeInTheDocument()
  })

  it('navigates difference sections without wrapping and leaves Same for a visible Context target', () => {
    render(<WorkspaceSideBySideDiffSurface value="" comparison={fullComparison} path="src/a.ts" />)

    const content = screen.getByTestId('workspace-side-by-side-diff-content')
    const previous = screen.getByRole('button', { name: 'Previous difference' })
    const next = screen.getByRole('button', { name: 'Next difference' })
    const activeRows = () => [...content.querySelectorAll<HTMLElement>('[data-active-diff-section]')]
    expect(previous).toBeDisabled()
    expect(next).toBeEnabled()
    fireEvent.click(screen.getByRole('radio', { name: 'Same' }))
    fireEvent.click(next)
    expect(screen.getByRole('radio', { name: 'Context' })).toBeChecked()
    expect(screen.getByText('1 of 2 differences')).toBeInTheDocument()
    expect(activeRows()).toHaveLength(1)
    expect(activeRows()[0]).toHaveTextContent('old three')
    expect(activeRows()[0]).toHaveTextContent('new three')
    expect(previous).toBeDisabled()
    fireEvent.click(next)
    expect(screen.getByText('2 of 2 differences')).toBeInTheDocument()
    expect(next).toBeDisabled()
    expect(activeRows()).toHaveLength(1)
    expect(activeRows()[0]).toHaveTextContent('old eight')
    expect(activeRows()[0]).toHaveTextContent('new eight')
  })

  it('scrolls every consecutive difference navigation target into view', () => {
    const originalScrollIntoView = HTMLElement.prototype.scrollIntoView
    const scrolledElements: HTMLElement[] = []
    const scrollIntoView = vi.fn(function (this: HTMLElement) {
      scrolledElements.push(this)
    })
    Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
      configurable: true,
      value: scrollIntoView,
    })

    try {
      render(<WorkspaceSideBySideDiffSurface value="" comparison={fullComparison} path="src/a.ts" lineLimit={1} />)
      const next = screen.getByRole('button', { name: 'Next difference' })
      const previous = screen.getByRole('button', { name: 'Previous difference' })

      fireEvent.click(next)
      expect(scrollIntoView).toHaveBeenCalledTimes(1)
      expect(scrolledElements.at(-1)).toHaveAttribute('data-active-diff-section')
      expect(scrolledElements.at(-1)).toHaveTextContent('new three')

      fireEvent.click(next)
      expect(scrollIntoView).toHaveBeenCalledTimes(2)
      expect(scrolledElements.at(-1)).toHaveAttribute('data-active-diff-section')
      expect(scrolledElements.at(-1)).toHaveTextContent('new eight')

      fireEvent.click(previous)
      expect(scrollIntoView).toHaveBeenCalledTimes(3)
      expect(scrolledElements.at(-1)).toHaveAttribute('data-active-diff-section')
      expect(scrolledElements.at(-1)).toHaveTextContent('new three')
      expect(scrollIntoView).toHaveBeenLastCalledWith({ block: 'center', inline: 'nearest' })
    } finally {
      if (originalScrollIntoView) {
        Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
          configurable: true,
          value: originalScrollIntoView,
        })
      } else {
        Reflect.deleteProperty(HTMLElement.prototype, 'scrollIntoView')
      }
    }
  })

  it('expands one complete-file context gap while leaving other gaps collapsed', () => {
    const lines = Array.from({ length: 20 }, (_, index) => `line ${index + 1}`)
    const right = [...lines]
    right[5] = 'changed 6'
    right[15] = 'changed 16'
    const value = comparison(side(`${lines.join('\n')}\n`), side(`${right.join('\n')}\n`))

    render(<WorkspaceSideBySideDiffSurface value="" comparison={value} path="src/a.ts" />)

    expect(screen.queryByText('line 10')).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Expand all 3 hidden unchanged lines in this section' }))
    expect(screen.getAllByText('line 10')).toHaveLength(2)
    expect(screen.getAllByText('line 11')).toHaveLength(2)
    expect(screen.getAllByText('line 12')).toHaveLength(2)
    expect(screen.getByRole('button', { name: 'Expand all 2 hidden unchanged lines in this section' })).toBeEnabled()
    expect(screen.getByRole('button', { name: 'Expand all 1 hidden unchanged line in this section' })).toBeEnabled()
    expect(screen.queryByRole('button', { name: 'Expand all 3 hidden unchanged lines in this section' })).not.toBeInTheDocument()
  })

  it('clears context gap expansion when the comparison source revision changes', () => {
    const lines = Array.from({ length: 20 }, (_, index) => `line ${index + 1}`)
    const right = [...lines]
    right[5] = 'changed 6'
    right[15] = 'changed 16'
    const source = (revision: string) => comparison(
      side(`${lines.join('\n')}\n`, {
        source: { kind: 'git_head', path: 'src/a.ts', revision },
      }),
      side(`${right.join('\n')}\n`, {
        source: { kind: 'working_tree', path: 'src/a.ts', revision },
      }),
    )
    const { rerender } = render(
      <WorkspaceSideBySideDiffSurface value="" comparison={source('revision-1')} path="src/a.ts" />,
    )

    fireEvent.click(screen.getByRole('button', { name: 'Expand all 3 hidden unchanged lines in this section' }))
    expect(screen.getAllByText('line 10')).toHaveLength(2)

    rerender(<WorkspaceSideBySideDiffSurface value="" comparison={source('revision-2')} path="src/a.ts" />)
    expect(screen.queryByText('line 10')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Expand all 3 hidden unchanged lines in this section' })).toBeEnabled()
  })

  it('does not offer context expansion when patch-only omitted rows are unavailable', () => {
    render(<WorkspaceSideBySideDiffSurface value={twoHunkPatch} path="src/a.ts" />)

    expect(screen.getByText('Unchanged lines hidden')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Expand all .* hidden unchanged/ })).not.toBeInTheDocument()
  })

  it('highlights the active patch section across Next and Previous navigation without wrapping', () => {
    render(
      <WorkspaceSideBySideDiffSurface
        value={twoHunkPatch}
        path="src/a.ts"
        renderHunkAction={(hunkId) => <span data-source-hunk-id={hunkId} />}
      />,
    )

    const content = screen.getByTestId('workspace-side-by-side-diff-content')
    const previous = screen.getByRole('button', { name: 'Previous difference' })
    const next = screen.getByRole('button', { name: 'Next difference' })
    const activeRows = () => [...content.querySelectorAll<HTMLElement>('[data-active-diff-section]')]

    expect(activeRows()).toHaveLength(0)
    expect(screen.getByText('0 of 2 differences')).toBeInTheDocument()
    expect(previous).toBeDisabled()
    expect(next).toBeEnabled()
    expect([...content.querySelectorAll<HTMLElement>('[data-source-hunk-id]')]
      .map((element) => element.dataset.sourceHunkId)).toEqual(['file-0-hunk-0', 'file-0-hunk-1'])

    fireEvent.click(next)
    expect(screen.getByText('1 of 2 differences')).toBeInTheDocument()
    expect(activeRows()).toHaveLength(1)
    expect(activeRows()[0]).toHaveTextContent('old first')
    expect(activeRows()[0]).toHaveTextContent('new first')
    expect(screen.getByText('old first')).toBeVisible()
    expect(screen.getByText('new first')).toBeVisible()

    fireEvent.click(next)
    expect(screen.getByText('2 of 2 differences')).toBeInTheDocument()
    expect(activeRows()).toHaveLength(1)
    expect(activeRows()[0]).toHaveTextContent('old second')
    expect(activeRows()[0]).toHaveTextContent('new second')
    expect(next).toBeDisabled()

    fireEvent.click(next)
    expect(screen.getByText('2 of 2 differences')).toBeInTheDocument()
    expect(activeRows()[0]).toHaveTextContent('old second')

    fireEvent.click(previous)
    expect(screen.getByText('1 of 2 differences')).toBeInTheDocument()
    expect(activeRows()).toHaveLength(1)
    expect(activeRows()[0]).toHaveTextContent('old first')
    expect(activeRows()[0]).toHaveTextContent('new first')
  })

  it('swaps only visual panes and keeps comments bound to the original source side across refresh', () => {
    const onAddComment = vi.fn()
    const { rerender } = render(
      <WorkspaceSideBySideDiffSurface
        value={diff}
        comparison={fullComparison}
        path="src/a.ts"
        onAddComment={onAddComment}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: 'Swap left and right views' }))
    const headers = screen.getAllByText(/^(old|new) ·/)
    expect(headers[0]).toHaveTextContent(/^new ·/)
    fireEvent.click(screen.getByRole('button', { name: 'Comment on src/a.ts new line 3' }))
    fireEvent.change(screen.getByRole('textbox', { name: 'Review comment' }), { target: { value: 'new-side note' } })
    fireEvent.click(screen.getByRole('button', { name: 'Submit review comment' }))
    expect(onAddComment).toHaveBeenCalledWith(expect.objectContaining({ side: 'new', lineStart: 3 }), 'new-side note')

    fireEvent.click(screen.getByRole('radio', { name: 'All' }))
    rerender(
      <WorkspaceSideBySideDiffSurface
        value={`${diff}\n`}
        comparison={comparison(fullComparison.left, side(`${fullComparison.right.content}ten\n`))}
        path="src/a.ts"
        onAddComment={onAddComment}
      />,
    )
    expect(screen.getByRole('radio', { name: 'All' })).toBeChecked()
    expect(screen.getAllByText(/^(old|new) ·/)[0]).toHaveTextContent(/^new ·/)
  })

  it('edits the final version directly in the comparison rows, realigns multiline input, and supports undo', () => {
    render(<HistoryHarness value={comparison(side('one\nold\nthree\n'), side('one\nnew\nthree\n'))} />)

    expect(screen.queryByRole('button', { name: 'Edit' })).not.toBeInTheDocument()
    expect(screen.queryByTestId('workspace-diff-editor')).not.toBeInTheDocument()
    const editor = screen.getByRole('textbox', { name: 'Edit final version line 2' })
    fireEvent.focus(editor)
    fireEvent.change(editor, { target: { value: 'inserted\nchanged last' } })
    fireEvent.blur(editor)

    expect(screen.getByTestId('history-right-content')).toHaveTextContent('one inserted changed last three')
    expect(screen.getByRole('button', { name: 'Save' })).toBeEnabled()
    fireEvent.click(screen.getByRole('button', { name: 'Undo last comparison action' }))
    expect(screen.getByTestId('history-right-content')).toHaveTextContent('one new three')
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled()
  })

  it('types directly into a final-side alignment gap and inserts the text before the neighboring line', () => {
    render(<HistoryHarness value={comparison(
      side('head\nremoved\ntail\n'),
      side('head\ntail\n'),
    )} />)

    const editor = screen.getByRole('textbox', { name: 'Insert final version text before line 2' })
    expect(editor).toHaveValue('')
    fireEvent.focus(editor)
    fireEvent.change(editor, { target: { value: 'restored\nextra' } })
    fireEvent.blur(editor)

    expect(screen.getByTestId('history-right-content')).toHaveTextContent('head restored extra tail')
    expect(screen.getByRole('button', { name: 'Save' })).toBeEnabled()
    expect(screen.getByText('1 of 1 differences')).toBeInTheDocument()
  })

  it('undoes and redoes comparison actions from toolbar buttons and Ctrl shortcuts without hijacking text editing', () => {
    render(<>
      <input aria-label="Chat input" />
      <HistoryHarness value={comparison(side('one\nold\nthree\n'), side('one\nnew\nthree\n'))} />
    </>)

    const undo = screen.getByRole('button', { name: 'Undo last comparison action' })
    const redo = screen.getByRole('button', { name: 'Redo last undone comparison action' })
    expect(undo).toBeDisabled()
    expect(redo).toBeDisabled()
    expect(undo).toHaveAttribute('aria-keyshortcuts', 'Control+Z Meta+Z')
    expect(redo).toHaveAttribute('aria-keyshortcuts', 'Control+Y Meta+Y Control+Shift+Z Meta+Shift+Z')

    const editor = screen.getByRole('textbox', { name: 'Edit final version line 2' })
    fireEvent.focus(editor)
    fireEvent.change(editor, { target: { value: 'changed' } })
    fireEvent.keyDown(editor, { key: 'z', ctrlKey: true })
    fireEvent.keyDown(editor, { key: 'y', ctrlKey: true })
    expect(editor).toHaveValue('changed')
    expect(screen.getByTestId('history-right-content')).toHaveTextContent('one new three')
    expect(undo).toBeEnabled()
    expect(redo).toBeDisabled()

    fireEvent.blur(editor)
    const surface = screen.getByTestId('workspace-side-by-side-diff-scroll')
    surface.focus()
    expect(screen.getByRole('button', { name: 'Undo last comparison action' })).toBeEnabled()
    fireEvent.keyDown(surface, {
      key: 'z',
      ctrlKey: true,
    })
    expect(screen.getByTestId('history-right-content')).toHaveTextContent('one new three')
    expect(screen.getByRole('button', { name: 'Redo last undone comparison action' })).toBeEnabled()

    fireEvent.keyDown(surface, {
      key: 'y',
      ctrlKey: true,
    })
    expect(screen.getByTestId('history-right-content')).toHaveTextContent('one changed three')

    const chatInput = screen.getByRole('textbox', { name: 'Chat input' })
    chatInput.focus()
    fireEvent.keyDown(chatInput, { key: 'z', ctrlKey: true })
    expect(screen.getByTestId('history-right-content')).toHaveTextContent('one changed three')
  })

  it('keeps direct text history native while focused and comparison history available after commit', () => {
    const first = render(<HistoryHarness value={comparison(
      side('head\nsame\ntail\n'),
      side('head\nwrong\ntail\n'),
    )} />)

    const inlineEditor = screen.getByRole('textbox', { name: 'Edit final version line 2' })
    fireEvent.focus(inlineEditor)
    fireEvent.change(inlineEditor, { target: { value: 'same' } })
    fireEvent.blur(inlineEditor)
    expect(screen.getByTestId('history-right-content')).toHaveTextContent('head same tail')
    const surface = screen.getByTestId('workspace-side-by-side-diff-scroll')
    surface.focus()
    fireEvent.keyDown(surface, { key: 'z', ctrlKey: true })
    expect(screen.getByTestId('history-right-content')).toHaveTextContent('head wrong tail')
    first.unmount()

    render(<HistoryHarness value={comparison(
      side('head\nleft\ntail\n'),
      side('head\nright\ntail\n'),
    )} />)
    fireEvent.contextMenu(diffCellForText('left', 'old'))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Copy this line to new' }))
    expect(screen.getByTestId('history-right-content')).toHaveTextContent('head left tail')
    expect(screen.getByTestId('workspace-side-by-side-diff-scroll')).toContainElement(document.activeElement as HTMLElement)
    fireEvent.keyDown(document.activeElement!, { key: 'z', ctrlKey: true })
    expect(screen.getByTestId('history-right-content')).toHaveTextContent('head right tail')
  })

  it('edits the writable new line in place after swap and stays automatically aligned after save', async () => {
    const readonlyLeft = side('one\r\nsame\r\nthree\r\n', {
      source: { kind: 'git_head', path: 'src/a.ts', revision: 'abc' },
      writable: false,
      readOnlyReason: 'Git HEAD is read-only.',
      lineEnding: 'crlf',
    })
    const writableRight = side('one\r\nwrong\r\nthree\r\n', { lineEnding: 'crlf' })
    const writer = vi.fn(async (request) => ({
      state: 'ok' as const,
      path: request.path,
      content: request.content ?? undefined,
      lineEnding: 'crlf' as const,
    }))
    render(<InlineSaveHarness value={comparison(readonlyLeft, writableRight)} writer={writer} />)

    expect(screen.getByText('0 of 1 differences')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Edit old line 2 directly' })).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Swap left and right views' }))
    expect(screen.getAllByText(/^(old|new) ·/)[0]).toHaveTextContent(/^new ·/)

    const inlineEditor = screen.getByRole('textbox', { name: 'Edit final version line 2' })
    fireEvent.focus(inlineEditor)
    fireEvent.change(inlineEditor, { target: { value: 'same' } })
    expect(screen.getByRole('button', { name: 'Save' })).toBeEnabled()
    expect(screen.getByRole('button', { name: 'Undo last comparison action' })).toBeEnabled()

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Save' }))
      await Promise.resolve()
    })
    expect(writer).toHaveBeenCalledWith(expect.objectContaining({
      path: 'src/a.ts',
      expectedContent: 'one\r\nwrong\r\nthree\r\n',
      content: 'one\r\nsame\r\nthree\r\n',
    }))
    expect(screen.getByText('0 of 0 differences')).toBeInTheDocument()
    const editHighlightKeys = highlightRequestSpy.mock.calls.map(([request]) => request.cacheKey)
    expect(new Set(editHighlightKeys).size).toBeGreaterThan(1)
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Undo last comparison action' })).toBeDisabled()
  })

  it('merges by original source side after swapping the visual columns', () => {
    render(<EditableHarness value={comparison(side('one\nleft\nthree\n'), side('one\nright\nthree\n'))} />)

    const oldToNew = screen.getByRole('button', { name: 'old → new' })
    const newToOld = screen.getByRole('button', { name: 'new → old' })
    expect(oldToNew).toHaveTextContent('')
    expect(newToOld).toHaveTextContent('')
    expect(oldToNew.querySelector('[data-merge-arrow-direction]')).toHaveAttribute('data-merge-arrow-direction', 'right')
    expect(newToOld.querySelector('[data-merge-arrow-direction]')).toHaveAttribute('data-merge-arrow-direction', 'left')

    fireEvent.click(screen.getByRole('button', { name: 'Swap left and right views' }))
    expect(screen.getAllByText(/^(old|new) ·/)[0]).toHaveTextContent(/^new ·/)
    expect(oldToNew.querySelector('[data-merge-arrow-direction]')).toHaveAttribute('data-merge-arrow-direction', 'left')
    expect(newToOld.querySelector('[data-merge-arrow-direction]')).toHaveAttribute('data-merge-arrow-direction', 'right')
    fireEvent.click(screen.getByRole('button', { name: 'old → new' }))

    expect(screen.getByText('0 of 0 differences')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('radio', { name: 'All' }))
    expect(screen.getByRole('textbox', { name: 'Edit final version line 2' })).toHaveValue('left')
    expect(diffCellForText('left', 'old')).toHaveTextContent('left')
  })

  it('keeps GBK working sources editable while preserving read-only source protection', () => {
    const readonlyLeft = side('base\n', {
      source: { kind: 'git_head', path: 'src/a.ts', revision: 'abc' },
      writable: false,
      readOnlyReason: 'Git HEAD is read-only.',
    })
    const gbkRight = side('工作\n', { actualEncoding: 'gbk' })
    render(<EditableHarness value={comparison(readonlyLeft, gbkRight)} />)

    expect(screen.queryByRole('button', { name: 'Edit' })).not.toBeInTheDocument()
    expect(screen.getByRole('textbox', { name: 'Edit final version line 1' })).toHaveValue('工作')
    expect(diffCellForText('base', 'old').querySelector('textarea')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'old → new' })).toBeEnabled()
    const disabledMerge = screen.getByRole('button', { name: 'new → old' })
    expect(disabledMerge).toBeDisabled()
    expect(disabledMerge).toHaveAccessibleDescription('This source is read-only.')
    expect(disabledMerge.parentElement).toHaveAttribute('title', 'This source is read-only.')
  })

  it('keeps encoding controls bound to source identity when visual panes are swapped', () => {
    const onEncodingChange = vi.fn()
    const value = comparison(
      side('旧\n', { requestedEncoding: 'gbk', actualEncoding: 'gbk' }),
      side('新\n', { requestedEncoding: 'utf8', actualEncoding: 'utf8' }),
    )
    render(<EncodingHarness value={value} onEncodingChange={onEncodingChange} />)

    const oldEncoding = screen.getByRole('combobox', { name: 'old source encoding' })
    const newEncoding = screen.getByRole('combobox', { name: 'new source encoding' })
    expect(oldEncoding).toHaveValue('gbk')
    expect(newEncoding).toHaveValue('utf8')
    fireEvent.change(newEncoding, { target: { value: 'gbk' } })
    expect(onEncodingChange).toHaveBeenLastCalledWith('right', 'gbk')

    fireEvent.click(screen.getByRole('button', { name: 'Swap left and right views' }))
    const swappedEncodings = screen.getAllByRole('combobox')
    expect(swappedEncodings[0]).toHaveAccessibleName('new source encoding')
    expect(swappedEncodings[0]).toHaveValue('utf8')
    expect(swappedEncodings[1]).toHaveAccessibleName('old source encoding')
    expect(swappedEncodings[1]).toHaveValue('gbk')
    fireEvent.change(swappedEncodings[1]!, { target: { value: 'utf8' } })
    expect(onEncodingChange).toHaveBeenLastCalledWith('left', 'utf8')
  })

  it('renders, navigates, swaps, merges, and restores a missing-vs-empty whole-file section', () => {
    const missing = side('', {
      exists: false,
      state: 'missing',
      content: undefined,
      actualEncoding: undefined,
      lineEnding: 'none',
    })
    render(<ExistenceHarness value={comparison(missing, side(''))} />)

    expect(screen.getByText('0 of 1 differences')).toBeInTheDocument()
    expect(screen.getByTestId('workspace-diff-existence-left')).toHaveAttribute('data-source-exists', 'false')
    expect(screen.getByTestId('workspace-diff-existence-right')).toHaveAttribute('data-source-exists', 'true')
    expect(screen.getByTestId('workspace-diff-existence-left')).toHaveTextContent('File not found.')
    expect(screen.getByTestId('workspace-diff-existence-right')).toHaveTextContent('0 B')

    fireEvent.click(screen.getByRole('button', { name: 'Next difference' }))
    expect(screen.getByText('1 of 1 differences')).toBeInTheDocument()
    expect(screen.getByTestId('workspace-diff-existence-row')).toHaveAttribute('data-active-diff-section')

    fireEvent.click(screen.getByRole('button', { name: 'Swap left and right views' }))
    expect(screen.getAllByText(/^(old|new) ·/)[0]).toHaveTextContent(/^new ·/)
    fireEvent.click(screen.getByRole('button', { name: 'old → new' }))
    expect(screen.getByTestId('existence-state')).toHaveTextContent('{"left":false,"right":false}')
    expect(screen.getByText('0 of 0 differences')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Undo last comparison action' }))
    expect(screen.getByTestId('existence-state')).toHaveTextContent('{"left":false,"right":true}')
    expect(screen.getByText('1 of 1 differences')).toBeInTheDocument()
    expect(screen.getByTestId('workspace-diff-existence-row')).toHaveAttribute('data-active-diff-section')
  })

  it('creates an existing empty target from the mirrored whole-file section', () => {
    const missing = side('', {
      exists: false,
      state: 'missing',
      content: undefined,
      actualEncoding: undefined,
      lineEnding: 'none',
    })
    render(<ExistenceHarness value={comparison(side(''), missing)} />)

    fireEvent.click(screen.getByRole('button', { name: 'old → new' }))
    expect(screen.getByTestId('existence-state')).toHaveTextContent('{"left":true,"right":true}')
    expect(screen.getByText('0 of 0 differences')).toBeInTheDocument()
  })

  it('starts manual alignment from a right-side context menu after swap and completes on the opposite line', () => {
    render(<EditableHarness value={comparison(
      side('head\nsame\nvoid Render(){ DrawTargetOld(); }\nsame\nvoid Render(){ DrawOther(); }\nsame\ntail\n'),
      side('head\nsame\nvoid Render(){ DrawOther(); }\nsame\nvoid Render(){ DrawTargetNew(); }\nsame\ntail\n'),
    )} />)

    const autoLeftRow = diffCellForText('void Render(){ DrawTargetOld(); }', 'old').closest('[data-side-by-side-row]')
    const autoRightRow = diffCellForText('void Render(){ DrawTargetNew(); }', 'new').closest('[data-side-by-side-row]')
    expect(autoLeftRow).not.toBe(autoRightRow)
    expect(autoLeftRow).not.toHaveTextContent('DrawTargetNew')
    expect(autoLeftRow?.querySelector('[data-diff-placeholder][data-side="new"]')).toBeInTheDocument()
    expect(autoRightRow?.querySelector('[data-diff-placeholder][data-side="old"]')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Swap left and right views' }))
    expect(screen.queryByRole('button', { name: 'Align lines manually' })).not.toBeInTheDocument()
    fireEvent.contextMenu(diffCellForText('void Render(){ DrawTargetNew(); }', 'new'), { clientX: 80, clientY: 90 })
    expect(screen.getByRole('menu', { name: 'Line actions' })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('menuitem', { name: 'Align to this line' }))
    expect(screen.getByText('new line 5 selected. Select a line from old.')).toBeInTheDocument()
    const targetCell = diffCellForText('void Render(){ DrawTargetOld(); }', 'old')
    fireEvent.click(targetCell)

    expect(screen.getByText('L3 ↔ R5')).toBeInTheDocument()
    const anchorRow = screen.getByTestId('workspace-manual-anchor-row-manual-anchor-1')
    expect(anchorRow).toHaveTextContent('DrawTargetOld')
    expect(anchorRow).toHaveTextContent('DrawTargetNew')
    expect(anchorRow.querySelector('[data-diff-placeholder]')).not.toBeInTheDocument()
    expect(diffCellForText('void Render(){ DrawTargetOld(); }', 'old')).toHaveFocus()
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled()

    fireEvent.click(screen.getByRole('button', { name: 'Delete alignment L3 ↔ R5' }))
    expect(screen.queryByText('L3 ↔ R5')).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Undo last comparison action' }))
    expect(screen.getByText('L3 ↔ R5')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Redo last undone comparison action' }))
    expect(screen.queryByText('L3 ↔ R5')).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Undo last comparison action' }))
    expect(screen.getByText('L3 ↔ R5')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Clear all alignments' }))
    expect(screen.queryByText('L3 ↔ R5')).not.toBeInTheDocument()
  })

  it('cancels armed alignment with Escape or its context menu and ignores same-side line clicks', () => {
    render(<EditableHarness value={comparison(side('head\nleft\ntail\n'), side('head\nright\ntail\n'))} />)

    const sourceCell = diffCellForText('right', 'new')
    sourceCell.focus()
    fireEvent.keyDown(sourceCell, { key: 'F10', shiftKey: true })
    fireEvent.click(screen.getByRole('menuitem', { name: 'Align to this line' }))
    fireEvent.click(diffCellForText('head', 'new'))
    expect(screen.getByText('new line 2 selected. Select a line from old.')).toBeInTheDocument()
    expect(screen.queryByText(/L\d+ ↔ R\d+/)).not.toBeInTheDocument()
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(screen.queryByText('new line 2 selected. Select a line from old.')).not.toBeInTheDocument()
    expect(sourceCell).toHaveFocus()

    fireEvent.contextMenu(diffCellForText('left', 'old'))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Align to this line' }))
    fireEvent.contextMenu(diffCellForText('right', 'new'))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Cancel manual alignment' }))
    expect(screen.queryByText('old line 2 selected. Select a line from new.')).not.toBeInTheDocument()
    expect(screen.queryByText(/L\d+ ↔ R\d+/)).not.toBeInTheDocument()
  })

  it('opens the line menu from the keyboard and reports duplicate and crossing alignment errors', () => {
    render(<EditableHarness value={comparison(
      side('head\nleft two\nleft three\nleft four\ntail\n'),
      side('head\nright two\nright three\nright four\ntail\n'),
    )} />)

    const oldTwo = diffCellForText('left two', 'old')
    oldTwo.focus()
    fireEvent.keyDown(oldTwo, { key: 'F10', shiftKey: true })
    const alignItem = screen.getByRole('menuitem', { name: 'Align to this line' })
    expect(alignItem).toHaveFocus()
    fireEvent.click(alignItem)
    fireEvent.click(diffCellForText('right three', 'new'))
    expect(screen.getByText('L2 ↔ R3')).toBeInTheDocument()

    fireEvent.contextMenu(diffCellForText('left two', 'old'))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Align to this line' }))
    fireEvent.click(diffCellForText('right four', 'new'))
    expect(screen.getByRole('alert')).toHaveTextContent('That line is already used by another alignment.')
    fireEvent.keyDown(document, { key: 'Escape' })

    fireEvent.contextMenu(diffCellForText('left four', 'old'))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Align to this line' }))
    fireEvent.click(diffCellForText('right two', 'new'))
    expect(screen.getByRole('alert')).toHaveTextContent('Alignment anchors cannot cross.')
  })

  it('keeps a pointer-opened line menu inside the viewport and dismisses it on scrolling', () => {
    vi.stubGlobal('innerWidth', 1000)
    vi.stubGlobal('innerHeight', 800)
    const bounds = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      if (this.getAttribute('role') === 'menu') {
        return {
          x: 0, y: 0, left: 0, top: 0, right: 200, bottom: 100,
          width: 200, height: 100, toJSON: () => ({}),
        }
      }
      return {
        x: 0, y: 0, left: 0, top: 0, right: 0, bottom: 0,
        width: 0, height: 0, toJSON: () => ({}),
      }
    })
    render(<EditableHarness value={comparison(side('left\n'), side('right\n'))} />)

    fireEvent.contextMenu(diffCellForText('left', 'old'), { clientX: 995, clientY: 795 })
    const menu = screen.getByRole('menu', { name: 'Line actions' })
    expect(Number.parseFloat(menu.style.left) + 200).toBeLessThanOrEqual(992)
    expect(Number.parseFloat(menu.style.top) + 100).toBeLessThanOrEqual(792)
    expect(menu.style.visibility).toBe('visible')

    fireEvent.scroll(window)
    expect(screen.queryByRole('menu', { name: 'Line actions' })).not.toBeInTheDocument()
    bounds.mockRestore()
  })

  it('focuses the menu itself when a placeholder has no enabled line action', () => {
    const left = side('head\nremoved\ntail\n', {
      source: { kind: 'git_head', path: 'src/a.ts', revision: 'abc' },
      writable: false,
      readOnlyReason: 'Git HEAD is read-only.',
    })
    render(<EditableHarness value={comparison(left, side('head\ntail\n'))} />)
    const removedRow = diffCellForText('removed', 'old').closest('[data-side-by-side-row]')
    const placeholder = removedRow?.querySelector<HTMLElement>('[data-diff-placeholder][data-side="new"]')
    placeholder?.focus()
    fireEvent.keyDown(placeholder!, { key: 'F10', shiftKey: true })

    const menu = screen.getByRole('menu', { name: 'Line actions' })
    expect(screen.getByRole('menuitem', { name: 'Copy this line to old' })).toBeDisabled()
    expect(menu).toHaveFocus()
  })

  it('keeps code text in the gridcell accessible name and exposes the menu shortcut as a description', () => {
    render(<EditableHarness value={comparison(side('readable old\n'), side('readable new\n'))} />)
    const cell = diffCellForText('readable old', 'old')

    expect(cell).not.toHaveAttribute('aria-label')
    expect(cell).toHaveAttribute('aria-keyshortcuts', 'Shift+F10')
    expect(cell).toHaveAccessibleDescription('Open line actions with Shift+F10 or the Menu key.')
    expect(cell).toHaveTextContent('readable old')
  })

  it('copies one replacement or insertion row from its context menu and disables a read-only target', () => {
    const replacement = comparison(side('head\nleft\ntail\n'), side('head\nright\ntail\n'))
    const replacementSession = createWorkspaceComparisonSession(replacement)!
    const replacementChange = vi.fn()
    const first = render(<WorkspaceSideBySideDiffSurface
      value=""
      comparison={replacement}
      comparisonSession={replacementSession}
      onComparisonSessionChange={replacementChange}
      path="src/a.ts"
    />)
    fireEvent.contextMenu(diffCellForText('left', 'old'))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Copy this line to new' }))
    expect(replacementChange.mock.calls[0]?.[0].right.content).toBe('head\nleft\ntail\n')
    first.unmount()

    const insertion = comparison(side('head\ninserted\ntail\n'), side('head\ntail\n'))
    const insertionSession = createWorkspaceComparisonSession(insertion)!
    const insertionChange = vi.fn()
    const second = render(<WorkspaceSideBySideDiffSurface
      value=""
      comparison={insertion}
      comparisonSession={insertionSession}
      onComparisonSessionChange={insertionChange}
      path="src/a.ts"
    />)
    fireEvent.contextMenu(diffCellForText('inserted', 'old'))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Copy this line to new' }))
    expect(insertionChange.mock.calls[0]?.[0].right.content).toBe('head\ninserted\ntail\n')
    second.unmount()

    const deletion = comparison(side('head\ntail\n'), side('head\nremoved\ntail\n'))
    const deletionSession = createWorkspaceComparisonSession(deletion)!
    const deletionChange = vi.fn()
    const third = render(<WorkspaceSideBySideDiffSurface
      value=""
      comparison={deletion}
      comparisonSession={deletionSession}
      onComparisonSessionChange={deletionChange}
      path="src/a.ts"
    />)
    const removedRow = diffCellForText('removed', 'new').closest('[data-side-by-side-row]')
    const oldPlaceholder = removedRow?.querySelector<HTMLElement>('[data-diff-placeholder][data-side="old"]')
    expect(oldPlaceholder).toBeInTheDocument()
    fireEvent.contextMenu(oldPlaceholder!)
    fireEvent.click(screen.getByRole('menuitem', { name: 'Copy this line to new' }))
    expect(deletionChange.mock.calls[0]?.[0].right.content).toBe('head\ntail\n')
    third.unmount()

    render(<EditableHarness value={comparison(
      side('left\n'),
      side('right\n', {
        source: { kind: 'git_head', path: 'src/a.ts', revision: 'abc' },
        writable: false,
        readOnlyReason: 'Git HEAD is read-only.',
      }),
    )} />)
    fireEvent.contextMenu(diffCellForText('left', 'old'))
    const disabledCopy = screen.getByRole('menuitem', { name: 'Copy this line to new' })
    expect(disabledCopy).toBeDisabled()
    expect(disabledCopy).toHaveAccessibleDescription('This source is read-only.')
    expect(screen.queryByRole('button', { name: 'Allow editing this file' })).not.toBeInTheDocument()
  })

  it('offers write access only for a read-only external working-tree target', () => {
    const external = comparison(
      side('left\n'),
      side('right\n', {
        source: { kind: 'working_tree', path: 'D:/external/a.ts', revision: 'working-tree' },
        writable: false,
        readOnlyReason: 'Registered external roots are read-only.',
      }),
    )
    const session = createWorkspaceComparisonSession(external)!
    const requestWriteAccess = vi.fn()
    const { rerender } = render(<WorkspaceSideBySideDiffSurface
      value=""
      comparison={external}
      comparisonSession={session}
      onComparisonSessionChange={() => {}}
      onRequestWriteAccess={requestWriteAccess}
      path="D:/external/a.ts"
    />)

    fireEvent.click(screen.getByRole('button', { name: 'Allow editing this file' }))
    expect(requestWriteAccess).toHaveBeenCalledWith('right')
    rerender(<WorkspaceSideBySideDiffSurface
      value=""
      comparison={external}
      comparisonSession={session}
      onComparisonSessionChange={() => {}}
      onRequestWriteAccess={requestWriteAccess}
      writeAccessChangingSide="right"
      path="D:/external/a.ts"
    />)
    expect(screen.getByRole('button', { name: 'Allowing edit…' })).toBeDisabled()
  })

  it('shows stale anchors after an endpoint edit and omits alignment actions for patch-only and zero-line sides', () => {
    const value = comparison(side('head\nleft anchor\ntail\n'), side('head\nright anchor\ntail\n'))
    const { rerender } = render(<EditableHarness value={value} />)
    fireEvent.contextMenu(diffCellForText('left anchor', 'old'))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Align to this line' }))
    fireEvent.click(diffCellForText('right anchor', 'new'))
    const editor = screen.getByRole('textbox', { name: 'Edit final version line 2' })
    fireEvent.focus(editor)
    fireEvent.change(editor, { target: { value: 'changed' } })
    fireEvent.blur(editor)
    expect(screen.getByText('Stale alignment')).toBeInTheDocument()

    rerender(<WorkspaceSideBySideDiffSurface value={diff} path="src/a.ts" />)
    fireEvent.contextMenu(diffCellForText('const answer = 41', 'old'))
    expect(screen.queryByRole('menuitem', { name: 'Align to this line' })).not.toBeInTheDocument()

    rerender(<EditableHarness value={comparison(side(''), side(''))} />)
    expect(screen.queryByRole('menuitem', { name: 'Align to this line' })).not.toBeInTheDocument()
  })

  it('opens atomic comparison settings, applies equivalence without dirtying files, and keeps raw text visible', () => {
    render(<EditableHarness value={comparison(side('VALUE\n'), side('value\n'))} />)
    expect(screen.getByText('0 of 1 differences')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('radio', { name: 'All' }))
    fireEvent.click(screen.getByRole('button', { name: 'Comparison settings' }))
    fireEvent.click(screen.getByLabelText('Ignore case'))
    fireEvent.click(screen.getByRole('button', { name: 'Apply settings' }))

    expect(screen.getByText('0 of 0 differences')).toBeInTheDocument()
    expect(diffCellForText('VALUE', 'old')).toHaveTextContent('VALUE')
    expect(diffCellForText('value', 'new')).toHaveTextContent('value')
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled()
  })

  it('toggles whitespace approximation from the toolbar without dirtying file buffers', () => {
    const value = comparison(side('one\n'), side(' one\n'))
    const session = createWorkspaceComparisonSession(value)!
    const onChange = vi.fn()
    const { rerender } = render(<WorkspaceSideBySideDiffSurface
      value=""
      comparison={value}
      comparisonSession={session}
      onComparisonSessionChange={onChange}
      path="src/a.ts"
    />)

    const approximate = screen.getByRole('button', { name: 'Minor' })
    expect(approximate).toHaveAttribute('aria-pressed', 'false')
    fireEvent.click(approximate)
    const next = onChange.mock.calls[0]?.[0]
    expect(next).toMatchObject({
      revision: session.revision + 1,
      settingsRevision: session.settingsRevision + 1,
      comparisonSettings: { ignoreWhitespace: true },
      left: { dirty: false },
      right: { dirty: false },
    })

    rerender(<WorkspaceSideBySideDiffSurface
      value=""
      comparison={value}
      comparisonSession={next}
      onComparisonSessionChange={onChange}
      path="src/a.ts"
    />)
    expect(screen.getByRole('button', { name: 'Minor' })).toHaveAttribute('aria-pressed', 'true')
  })

  it('keeps settings visible but fail-closed for patch-only input', () => {
    render(<WorkspaceSideBySideDiffSurface value={diff} path="src/a.ts" />)
    fireEvent.click(screen.getByRole('button', { name: 'Comparison settings' }))
    expect(screen.getByRole('button', { name: 'Apply settings' })).toBeDisabled()
    expect(screen.getByText('Complete decoded content for both sides is required.')).toBeInTheDocument()
  })

  it('does not synchronously build a complete balanced model before its worker result', async () => {
    const instances: FakeWorker[] = []
    class FakeWorker {
      onmessage: ((event: MessageEvent<unknown>) => void) | null = null
      onerror: ((event: ErrorEvent) => void) | null = null
      terminate = vi.fn()
      postMessage = vi.fn()
      constructor() { instances.push(this) }
    }
    vi.stubGlobal('Worker', FakeWorker)
    const initialSession = createWorkspaceComparisonSession(fullComparison)!
    const session = editWorkspaceComparisonSide(
      initialSession,
      'right',
      fullComparison.right.content!.replace('new three', 'edited three'),
    )
    const onComparisonSessionChange = vi.fn()
    expect(session.comparisonSettings.profile).toBe('balanced')

    const { rerender } = render(
      <WorkspaceSideBySideDiffSurface
        value={diff}
        comparison={fullComparison}
        comparisonSession={session}
        onComparisonSessionChange={onComparisonSessionChange}
        path="src/a.ts"
        onAddComment={vi.fn()}
        renderHunkAction={(hunkId) => <span data-testid="worker-patch-action" data-hunk-id={hunkId} />}
      />,
    )

    expect(instances).toHaveLength(1)
    expect(modelBuildSpy.mock.calls.some(([, currentComparison]) => currentComparison !== undefined)).toBe(false)
    expect(screen.getByRole('status')).toHaveTextContent('Recomputing comparison')
    const undo = screen.getByRole('button', { name: 'Undo last comparison action' })
    expect(undo).toBeEnabled()
    fireEvent.click(undo)
    expect(onComparisonSessionChange).toHaveBeenCalledWith(expect.objectContaining({
      right: expect.objectContaining({ content: fullComparison.right.content }),
      redoStack: [expect.any(Object)],
    }))
    expect(screen.getByRole('radio', { name: 'All' })).toBeDisabled()
    expect(screen.getByRole('radio', { name: 'Same' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Comment on src/a.ts new line 11' })).toBeInTheDocument()
    expect(screen.getByTestId('worker-patch-action')).toHaveAttribute('data-hunk-id', expect.stringContaining('hunk'))

    const firstRequest = instances[0]!.postMessage.mock.calls[0]![0] as WorkspaceComparisonRuntimeRequest
    await act(async () => {
      instances[0]!.onmessage?.({ data: computeWorkspaceComparisonModel(firstRequest) } as MessageEvent)
      await Promise.resolve()
    })
    expect(screen.queryByText('Recomputing comparison…')).not.toBeInTheDocument()

    const changedComparison = comparison(fullComparison.left, side(fullComparison.right.content!.replace('new three', 'latest three')))
    modelBuildSpy.mockClear()
    rerender(
      <WorkspaceSideBySideDiffSurface
        value={diff}
        comparison={changedComparison}
        comparisonSession={null}
        path="src/a.ts"
      />,
    )
    expect(modelBuildSpy.mock.calls.some(([, currentComparison]) => currentComparison !== undefined)).toBe(false)
    expect(screen.getByRole('status')).toHaveTextContent('Recomputing comparison')
    expect(screen.getByText('edited three')).toBeInTheDocument()

    await act(async () => {
      instances[0]!.onerror?.({ message: 'stop test worker' } as ErrorEvent)
      await Promise.resolve()
    })
  })
})
