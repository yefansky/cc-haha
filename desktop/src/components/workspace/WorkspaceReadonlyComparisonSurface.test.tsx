import '@testing-library/jest-dom/vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useSettingsStore } from '../../stores/settingsStore'
import {
  createPositionedPatchComparisonInput,
  createProposedContentComparisonInput,
  createReplacementFragmentComparisonInput,
} from './workspaceComparisonInput'
import { WorkspaceReadonlyComparisonSurface } from './WorkspaceReadonlyComparisonSurface'

vi.mock('./workspaceDiffHighlightRuntime', () => ({
  createWorkspaceDiffHighlightCacheKey: (path: string, value: string) => `${path}:${value}`,
  requestWorkspaceDiffHighlight: () => new Promise(() => {}),
}))

describe('WorkspaceReadonlyComparisonSurface', () => {
  beforeEach(() => {
    useSettingsStore.setState({ locale: 'en' })
  })

  it('renders replacement fragments through the shared paired surface with full-only modes disabled', () => {
    const input = createReplacementFragmentComparisonInput({
      originId: 'tool:edit-1',
      path: 'src/a.ts',
      oldString: 'old value',
      newString: 'new value',
    })

    render(<WorkspaceReadonlyComparisonSurface input={input} />)

    const host = screen.getByTestId('workspace-readonly-comparison')
    expect(host).toHaveAttribute('data-comparison-scope', 'replacement-fragment')
    expect(host).toHaveAttribute('data-origin-id', 'tool:edit-1')
    expect(screen.getByTestId('workspace-comparison-scope-notice')).toHaveTextContent(/replacement fragment/i)
    expect(screen.getByRole('grid')).toHaveTextContent('old value')
    expect(screen.getByRole('grid')).toHaveTextContent('new value')
    expect(host.querySelector('[data-diff-prefix]')).not.toBeInTheDocument()
    expect(host.querySelectorAll('[data-diff-tone="difference"]')).toHaveLength(2)
    expect([...host.querySelectorAll('[data-diff-cell]')].some((cell) => (
      cell.className.includes('color-diff-added')
    ))).toBe(false)
    expect(screen.getByRole('radio', { name: 'All' })).toBeDisabled()
    expect(screen.getByRole('radio', { name: 'Same' })).toBeDisabled()
    expect(screen.getByRole('button', { name: /Comparison settings.*tool arguments/i })).toBeDisabled()
    expect(screen.queryByRole('button', { name: 'Save' })).not.toBeInTheDocument()

    const before = [...host.querySelectorAll('[data-visual-header]')].map((element) => element.getAttribute('data-visual-header'))
    fireEvent.click(screen.getByRole('button', { name: 'Swap left and right views' }))
    const after = [...host.querySelectorAll('[data-visual-header]')].map((element) => element.getAttribute('data-visual-header'))
    expect(before).toEqual(['old', 'new'])
    expect(after).toEqual(['new', 'old'])
    expect(host).toHaveAttribute('data-origin-id', 'tool:edit-1')
  })

  it('renders a precise multiline replacement projection instead of whole-fragment delete/add rows', () => {
    const input = createReplacementFragmentComparisonInput({
      originId: 'tool:edit-multiline',
      path: 'src/a.ts',
      oldString: 'a\nb',
      newString: 'a\nc\nd',
    })

    const { container } = render(<WorkspaceReadonlyComparisonSurface input={input} />)
    const rows = [...container.querySelectorAll('[data-side-by-side-row]')]

    expect(rows).toHaveLength(3)
    expect(rows[0]).toHaveTextContent('a')
    expect(rows[1]).toHaveTextContent('b')
    expect(rows[1]).toHaveTextContent('c')
    const oldPlaceholder = rows[2]!.querySelector('[data-side="old"]')
    expect(oldPlaceholder).toHaveAttribute('data-diff-placeholder')
    expect(oldPlaceholder?.querySelector('[data-diff-placeholder-fill]')).toBeInTheDocument()
    expect(rows[2]!.querySelector('[data-side="new"]')).toHaveTextContent('d')
    expect(rows[2]!.querySelector('[data-side="new"]')).toHaveAttribute('data-diff-tone', 'difference')
    expect(screen.getByRole('radio', { name: 'All' })).toBeDisabled()
    expect(screen.getByRole('radio', { name: 'Same' })).toBeDisabled()
  })

  it('visibly identifies a final-newline-only replacement difference', () => {
    const input = createReplacementFragmentComparisonInput({
      originId: 'tool:edit-final-newline',
      path: 'src/a.ts',
      oldString: 'a\n',
      newString: 'a',
    })

    const { container } = render(<WorkspaceReadonlyComparisonSurface input={input} />)

    expect(container.querySelectorAll('[data-side-by-side-row]')).toHaveLength(1)
    expect(screen.getByText('No final newline')).toBeInTheDocument()
  })

  it('labels proposed content as having an unknown baseline instead of a missing old file', () => {
    const input = createProposedContentComparisonInput({
      originId: 'tool:write-1',
      path: 'src/new.ts',
      content: 'proposed line',
    })

    render(<WorkspaceReadonlyComparisonSurface input={input} />)

    expect(screen.getByTestId('workspace-comparison-scope-notice')).toHaveTextContent('current file content is unavailable')
    expect(screen.getByRole('grid')).toHaveTextContent('proposed line')
    expect(screen.getByRole('grid')).not.toHaveTextContent('/dev/null')
    expect(screen.queryByText('Missing')).not.toBeInTheDocument()
  })

  it('passes checkpoint-only hunk and comment actions to the shared surface', () => {
    const onAddComment = vi.fn()
    const input = createPositionedPatchComparisonInput({
      originId: 'checkpoint:s1:m1:src/a.ts',
      path: 'src/a.ts',
      value: [
        'diff --git a/src/a.ts b/src/a.ts',
        '--- a/src/a.ts',
        '+++ b/src/a.ts',
        '@@ -9 +9 @@',
        '-old value',
        '+new value',
      ].join('\n'),
      hostCapabilities: { comment: true, hunkAction: true },
    })

    render(
      <WorkspaceReadonlyComparisonSurface
        input={input}
        onAddComment={onAddComment}
        renderHunkAction={(hunkId) => <button type="button">restore {hunkId}</button>}
      />,
    )

    expect(screen.getByRole('button', { name: /restore file-0-hunk-0/ })).toBeInTheDocument()
    expect(screen.getAllByRole('button', { name: /Comment on/ })).toHaveLength(2)
  })

  it('does not pass host actions when the adapter capability is absent', () => {
    const onAddComment = vi.fn()
    const input = createReplacementFragmentComparisonInput({
      originId: 'tool:edit-no-actions',
      path: 'src/a.ts',
      oldString: 'old',
      newString: 'new',
    })

    render(
      <WorkspaceReadonlyComparisonSurface
        input={input}
        onAddComment={onAddComment}
        renderHunkAction={() => <button type="button">should not render</button>}
      />,
    )

    expect(screen.queryByText('should not render')).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Comment on/ })).not.toBeInTheDocument()
  })
})
