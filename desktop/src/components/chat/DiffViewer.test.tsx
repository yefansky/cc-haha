// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest'
import { render, screen } from '@testing-library/react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'

vi.mock('../workspace/WorkspaceReadonlyComparisonSurface', () => ({
  WorkspaceReadonlyComparisonSurface: ({ input }: {
    input: { scope: string; origin: { id: string }; value: string }
  }) => (
    <div
      data-testid="readonly-diff"
      data-scope={input.scope}
      data-origin-id={input.origin.id}
      data-value={input.value}
    />
  ),
}))

import { DiffViewer } from './DiffViewer'

describe('DiffViewer', () => {
  it('renders replacement statistics from paired changed rows in production SSR', () => {
    const markup = renderToStaticMarkup(
      <DiffViewer
        filePath="src/example.ts"
        oldString={'a\nb'}
        newString={'a\nc\nd'}
        scope="replacement-fragment"
        originId="tool:edit-statistics"
      />,
    )

    expect(markup).toContain('>+2<')
    expect(markup).toContain('>-1<')
    expect(markup).not.toContain('>+3<')
    expect(markup).not.toContain('>-2<')
  })

  it('adapts Edit old/new arguments as a replacement fragment with the supplied tool identity', () => {
    render(
      <DiffViewer
        filePath="src/example.ts"
        oldString="const a = 1"
        newString="const a = 2"
        scope="replacement-fragment"
        originId="tool:edit-1"
      />,
    )

    const diff = screen.getByTestId('readonly-diff')
    expect(diff).toHaveAttribute('data-scope', 'replacement-fragment')
    expect(diff).toHaveAttribute('data-origin-id', 'tool:edit-1')
    expect(diff.getAttribute('data-value')).toContain('-const a = 1')
    expect(diff.getAttribute('data-value')).toContain('+const a = 2')
    expect(screen.getByText('src/example.ts')).toBeInTheDocument()
  })

  it('adapts Write content as proposed content without inventing a missing or empty baseline', () => {
    render(
      <DiffViewer
        filePath="src/new.ts"
        newString={'first\nsecond'}
        scope="proposed-content"
        originId="tool:write-1"
      />,
    )

    const diff = screen.getByTestId('readonly-diff')
    expect(diff).toHaveAttribute('data-scope', 'proposed-content')
    expect(diff).toHaveAttribute('data-origin-id', 'tool:write-1')
    expect(diff.getAttribute('data-value')).toContain('+first\n+second')
    expect(diff.getAttribute('data-value')).not.toContain('/dev/null')
    expect(screen.getByText('+2')).toBeInTheDocument()
    expect(screen.getByText('-0')).toBeInTheDocument()
  })

  it('counts newline-only changes once per side and equal fragments as zero', () => {
    const { rerender } = render(
      <DiffViewer
        filePath="src/example.ts"
        oldString={'a\n'}
        newString="a"
        scope="replacement-fragment"
      />,
    )

    expect(screen.getByText('+1')).toBeInTheDocument()
    expect(screen.getByText('-1')).toBeInTheDocument()

    rerender(
      <DiffViewer
        filePath="src/example.ts"
        oldString={'same\nlines'}
        newString={'same\nlines'}
        scope="replacement-fragment"
      />,
    )

    expect(screen.getByText('+0')).toBeInTheDocument()
    expect(screen.getByText('-0')).toBeInTheDocument()
  })

  it('counts an empty Write proposal as zero without inventing deletions', () => {
    render(
      <DiffViewer
        filePath="src/empty.ts"
        newString=""
        scope="proposed-content"
        originId="tool:write-empty"
      />,
    )

    expect(screen.getByText('+0')).toBeInTheDocument()
    expect(screen.getByText('-0')).toBeInTheDocument()
  })

  it('uses a deterministic fallback identity when an isolated caller has no host id', () => {
    const { rerender } = render(
      <DiffViewer filePath="src/example.ts" oldString="old" newString="new" />,
    )
    const first = screen.getByTestId('readonly-diff').getAttribute('data-origin-id')

    rerender(<DiffViewer filePath="src/example.ts" oldString="old" newString="new" />)

    expect(screen.getByTestId('readonly-diff')).toHaveAttribute('data-origin-id', first)
    expect(first).toMatch(/^tool-fallback:replacement-fragment:/)
  })
})
