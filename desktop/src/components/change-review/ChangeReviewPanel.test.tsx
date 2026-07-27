// @vitest-environment jsdom

import '@testing-library/jest-dom'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { api } = vi.hoisted(() => ({
  api: {
    getWorkspaceStatus: vi.fn(),
    getWorkspaceDiff: vi.fn(),
    getWorkspaceFile: vi.fn(),
    writeWorkspaceFile: vi.fn(),
    revertWorkspaceFile: vi.fn(),
  },
}))

vi.mock('../../api/sessions', () => ({ sessionsApi: api }))

vi.mock('../workspace/WorkspaceDiffSurface', () => ({
  WorkspaceDiffSurface: ({ renderHunkAction }: { renderHunkAction?: (hunkId: string) => ReactNode }) => (
    <div data-testid="workspace-diff-surface">{renderHunkAction?.('hunk-1')}</div>
  ),
}))

import { ChangeReviewPanel } from './ChangeReviewPanel'

const status = {
  changedFiles: [
    { path: 'src/changed.ts', status: 'modified', additions: 3, deletions: 1 },
    { path: 'docs/readme.md', status: 'added', additions: 2, deletions: 0 },
  ],
}

beforeEach(() => {
  api.getWorkspaceStatus.mockResolvedValue(status)
  api.getWorkspaceDiff.mockResolvedValue({ state: 'ok', diff: 'diff --git a/src/changed.ts b/src/changed.ts' })
  api.getWorkspaceFile.mockResolvedValue({ state: 'ok', content: 'new text\n' })
  api.writeWorkspaceFile.mockResolvedValue({ state: 'ok', content: 'old text\n' })
  api.revertWorkspaceFile.mockResolvedValue({ state: 'ok', content: 'old text\n' })
})

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe('ChangeReviewPanel', () => {
  it('shows accumulated changes and filters the review list', async () => {
    render(<ChangeReviewPanel sessionId="review-session" />)

    await screen.findByText('changed.ts')
    expect(screen.getByText('+5')).toBeInTheDocument()
    expect(screen.getAllByText('-1')).toHaveLength(2)

    fireEvent.change(screen.getByRole('textbox', { name: '筛选文件' }), { target: { value: 'readme' } })
    expect(screen.getByText('readme.md')).toBeInTheDocument()
    expect(screen.queryByText('changed.ts')).not.toBeInTheDocument()
  })

  it('opens an individual colored diff and exposes a scoped hunk rollback', async () => {
    render(<ChangeReviewPanel sessionId="review-session" />)

    fireEvent.click(await screen.findByText('changed.ts'))

    await waitFor(() => expect(api.getWorkspaceDiff).toHaveBeenCalledWith('review-session', 'src/changed.ts'))
    expect(screen.getByTestId('workspace-diff-surface')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '撤销此差异块' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '编辑' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '回退文件' })).toBeInTheDocument()
  })
})
