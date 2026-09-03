import '@testing-library/jest-dom/vitest'
import { useState } from 'react'
import { act, createEvent, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { WorkspaceComparison, WorkspaceComparisonSide } from '@/api/sessions'
import { useSettingsStore } from '../../stores/settingsStore'
import { WorkspaceSideBySideDiffSurface } from './WorkspaceSideBySideDiffSurface'
import {
  createWorkspaceComparisonSession,
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
      onSave={async () => {
        const outcome = await saveWorkspaceComparisonSession(session, writer)
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
    expect(screen.getByTestId('workspace-side-by-side-diff-content')).toHaveClass('w-max')
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
    expect(content.style.getPropertyValue('--workspace-diff-left-pane')).toBe('70%')
    expect(content.style.getPropertyValue('--workspace-diff-right-pane')).toBe('30%')

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

  it('keeps long code intrinsically wide for horizontal reading', () => {
    const longLine = 'const label = "this line stays readable without wrapping or shrinking into the viewport"'
    render(<WorkspaceSideBySideDiffSurface value={`@@ -1 +1 @@\n-${longLine}\n+${longLine} changed`} path="src/a.ts" />)

    const content = screen.getByTestId('workspace-side-by-side-diff-content')
    expect(content).toHaveClass('min-w-full', 'w-max')
    expect(screen.getByText(longLine)).toHaveClass('whitespace-pre')
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

    fireEvent.click(screen.getByRole('radio', { name: 'All' }))
    expect(screen.getByText('new three')).toBeInTheDocument()
    expect(screen.getAllByText('four')).toHaveLength(2)

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

  it('edits full multiline content in memory, recomputes rows, and supports undo', () => {
    render(<EditableHarness value={comparison(side('one\nold\nthree\n'), side('one\nnew\nthree\n'))} />)

    fireEvent.click(screen.getAllByRole('button', { name: 'Edit' })[1]!)
    const editor = screen.getByRole('textbox', { name: 'Full text editor for the new side' })
    fireEvent.change(editor, { target: { value: 'one\ninserted\nchanged last' } })
    fireEvent.click(screen.getByRole('button', { name: 'Apply in memory' }))

    expect(screen.getByText('inserted')).toBeInTheDocument()
    expect(screen.getByText('changed last')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Save' })).toBeEnabled()
    fireEvent.click(screen.getByRole('button', { name: 'Undo last comparison action' }))
    expect(screen.getByText('new')).toBeInTheDocument()
    expect(screen.queryByText('changed last')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled()
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

    fireEvent.click(screen.getByRole('button', { name: 'Edit new line 2 directly' }))
    const inlineEditor = screen.getByRole('textbox', { name: 'Direct editor for new line 2' })
    fireEvent.change(inlineEditor, { target: { value: 'same' } })
    fireEvent.keyDown(inlineEditor, { key: 'Enter' })

    expect(screen.getByText('0 of 0 differences')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Save' })).toBeEnabled()
    expect(screen.getByRole('button', { name: 'Undo last comparison action' })).toBeEnabled()
    const editHighlightKeys = highlightRequestSpy.mock.calls.map(([request]) => request.cacheKey)
    expect(new Set(editHighlightKeys).size).toBeGreaterThan(1)

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
    expect(screen.getAllByText('left')).toHaveLength(2)
    expect(screen.queryByText('right')).not.toBeInTheDocument()
  })

  it('keeps GBK working sources editable while preserving read-only source protection', () => {
    const readonlyLeft = side('base\n', {
      source: { kind: 'git_head', path: 'src/a.ts', revision: 'abc' },
      writable: false,
      readOnlyReason: 'Git HEAD is read-only.',
    })
    const gbkRight = side('工作\n', { actualEncoding: 'gbk' })
    render(<EditableHarness value={comparison(readonlyLeft, gbkRight)} />)

    const editButtons = screen.getAllByRole('button', { name: 'Edit' })
    expect(editButtons[0]).toBeDisabled()
    expect(editButtons[0]).toHaveAttribute('title', 'This source is read-only.')
    expect(editButtons[1]).toBeEnabled()
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

  it('arms source-side manual alignment, confirms after swap, and supports delete, clear, and shared undo', () => {
    render(<EditableHarness value={comparison(
      side('head\nsame\nvoid Render(){ DrawTargetOld(); }\nsame\nvoid Render(){ DrawOther(); }\nsame\ntail\n'),
      side('head\nsame\nvoid Render(){ DrawOther(); }\nsame\nvoid Render(){ DrawTargetNew(); }\nsame\ntail\n'),
    )} />)

    const autoLeftRow = screen.getByText('void Render(){ DrawTargetOld(); }').closest('[data-side-by-side-row]')
    const autoRightRow = screen.getByText('void Render(){ DrawTargetNew(); }').closest('[data-side-by-side-row]')
    expect(autoLeftRow).not.toBe(autoRightRow)
    expect(autoLeftRow).not.toHaveTextContent('DrawTargetNew')
    expect(autoLeftRow?.querySelector('[data-diff-placeholder][data-side="new"]')).toBeInTheDocument()
    expect(autoRightRow?.querySelector('[data-diff-placeholder][data-side="old"]')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Swap left and right views' }))
    fireEvent.click(screen.getByRole('button', { name: 'Align lines manually' }))
    fireEvent.click(screen.getByRole('button', { name: 'Select old line 3 as the left alignment anchor' }))
    fireEvent.click(screen.getByRole('button', { name: 'Select new line 5 as the right alignment anchor' }))
    fireEvent.click(screen.getByRole('button', { name: 'Confirm alignment' }))

    expect(screen.getByText('L3 ↔ R5')).toBeInTheDocument()
    const anchorRow = screen.getByTestId('workspace-manual-anchor-row-manual-anchor-1')
    expect(anchorRow).toHaveTextContent('DrawTargetOld')
    expect(anchorRow).toHaveTextContent('DrawTargetNew')
    expect(anchorRow.querySelector('[data-diff-placeholder]')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled()

    fireEvent.click(screen.getByRole('button', { name: 'Delete alignment L3 ↔ R5' }))
    expect(screen.queryByText('L3 ↔ R5')).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Undo last comparison action' }))
    expect(screen.getByText('L3 ↔ R5')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Clear all alignments' }))
    expect(screen.queryByText('L3 ↔ R5')).not.toBeInTheDocument()
  })

  it('shows stale anchors after an endpoint edit and disables alignment for patch-only and zero-line sides', () => {
    const value = comparison(side('head\nleft anchor\ntail\n'), side('head\nright anchor\ntail\n'))
    const { rerender } = render(<EditableHarness value={value} />)
    fireEvent.click(screen.getByRole('button', { name: 'Align lines manually' }))
    fireEvent.click(screen.getByRole('button', { name: 'Select old line 2 as the left alignment anchor' }))
    fireEvent.click(screen.getByRole('button', { name: 'Select new line 2 as the right alignment anchor' }))
    fireEvent.click(screen.getByRole('button', { name: 'Confirm alignment' }))
    fireEvent.click(screen.getAllByRole('button', { name: 'Edit' })[0]!)
    fireEvent.change(screen.getByRole('textbox', { name: 'Full text editor for the old side' }), {
      target: { value: 'head\nchanged\ntail\n' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Apply in memory' }))
    expect(screen.getByText('Stale alignment')).toBeInTheDocument()

    rerender(<WorkspaceSideBySideDiffSurface value={diff} path="src/a.ts" />)
    expect(screen.getByRole('button', { name: 'Align lines manually' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Align lines manually' })).toHaveAttribute(
      'title',
      'Manual alignment requires complete content for both sides.',
    )

    rerender(<EditableHarness value={comparison(side(''), side(''))} />)
    expect(screen.getByRole('button', { name: 'Align lines manually' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Align lines manually' })).toHaveAttribute(
      'title',
      'Both sides need at least one real text line.',
    )
  })

  it('opens atomic comparison settings, applies equivalence without dirtying files, and keeps raw text visible', () => {
    render(<EditableHarness value={comparison(side('VALUE\n'), side('value\n'))} />)
    expect(screen.getByText('0 of 1 differences')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('radio', { name: 'All' }))
    fireEvent.click(screen.getByRole('button', { name: 'Comparison settings' }))
    fireEvent.click(screen.getByLabelText('Ignore case'))
    fireEvent.click(screen.getByRole('button', { name: 'Apply settings' }))

    expect(screen.getByText('0 of 0 differences')).toBeInTheDocument()
    expect(screen.getByText('VALUE')).toBeInTheDocument()
    expect(screen.getByText('value')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled()
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
    const session = createWorkspaceComparisonSession(fullComparison)!
    expect(session.comparisonSettings.profile).toBe('balanced')

    const { rerender } = render(
      <WorkspaceSideBySideDiffSurface
        value={diff}
        comparison={fullComparison}
        comparisonSession={session}
        path="src/a.ts"
        onAddComment={vi.fn()}
        renderHunkAction={(hunkId) => <span data-testid="worker-patch-action" data-hunk-id={hunkId} />}
      />,
    )

    expect(instances).toHaveLength(1)
    expect(modelBuildSpy.mock.calls.some(([, currentComparison]) => currentComparison !== undefined)).toBe(false)
    expect(screen.getByRole('status')).toHaveTextContent('Recomputing comparison')
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
    expect(screen.getByText('new three')).toBeInTheDocument()

    await act(async () => {
      instances[0]!.onerror?.({ message: 'stop test worker' } as ErrorEvent)
      await Promise.resolve()
    })
  })
})
