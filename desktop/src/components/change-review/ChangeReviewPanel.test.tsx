// @vitest-environment jsdom

import '@testing-library/jest-dom'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import type { ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { api } = vi.hoisted(() => ({
  api: {
    getTurnCheckpoints: vi.fn(),
    getTurnCheckpointDiff: vi.fn(),
    getWorkspaceFile: vi.fn(),
    writeWorkspaceFile: vi.fn(),
    rewind: vi.fn(),
  },
}))

vi.mock('../../api/sessions', () => ({ sessionsApi: api }))
vi.mock('../workspace/WorkspaceDiffSurface', () => ({
  WorkspaceDiffSurface: ({ renderHunkAction }: { renderHunkAction?: (hunkId: string) => ReactNode }) => (
    <div data-testid="workspace-diff-surface">{renderHunkAction?.('hunk-1')}</div>
  ),
}))

import { ChangeReviewPanel } from './ChangeReviewPanel'

const checkpoints = {
  checkpoints: [
    {
      target: { targetUserMessageId: 'turn-1', userMessageIndex: 0, userMessageCount: 2 },
      workDir: 'C:/workspace',
      createdAt: '2026-08-14T01:02:03.000Z',
      prompt: 'Build the first step',
      code: {
        available: true,
        filesChanged: ['C:/workspace/src/first.ts'],
        insertions: 3,
        deletions: 1,
      },
    },
    {
      target: { targetUserMessageId: 'turn-2', userMessageIndex: 1, userMessageCount: 2 },
      workDir: 'C:/workspace',
      createdAt: '2026-08-14T02:03:04.000Z',
      prompt: 'Update docs',
      code: {
        available: true,
        filesChanged: ['C:/workspace/src/second.ts', 'C:/workspace/docs/readme.md'],
        insertions: 5,
        deletions: 2,
      },
    },
  ],
}

beforeEach(() => {
  window.localStorage.removeItem('cc-haha.change-review.timeline-width')
  api.getTurnCheckpoints.mockResolvedValue(checkpoints)
  api.getTurnCheckpointDiff.mockResolvedValue({ state: 'ok', diff: 'diff --git a/file b/file' })
  api.getWorkspaceFile.mockResolvedValue({ state: 'ok', content: 'new text\n' })
  api.writeWorkspaceFile.mockResolvedValue({ state: 'ok', content: 'old text\n' })
  api.rewind.mockResolvedValue({ mode: 'files', conversation: { messagesRemoved: 0 }, code: { filesChanged: [] } })
})

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe('ChangeReviewPanel checkpoint timeline', () => {
  it('shows every checkpoint newest-first and expands the latest one by default', async () => {
    render(<ChangeReviewPanel sessionId="review-session" />)

    const latest = await screen.findByRole('button', { name: /Checkpoint #2.*Latest/ })
    const first = screen.getByRole('button', { name: /Checkpoint #1/ })
    expect(latest).toHaveAttribute('aria-expanded', 'true')
    expect(first).toHaveAttribute('aria-expanded', 'false')
    expect(screen.getByRole('button', { name: 'src/second.ts' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'src/first.ts' })).not.toBeInTheDocument()

    fireEvent.click(first)
    expect(screen.getByRole('button', { name: 'src/first.ts' })).toBeInTheDocument()
  })

  it('opens the diff bound to the checkpoint and file that was clicked', async () => {
    render(<ChangeReviewPanel sessionId="review-session" />)

    fireEvent.click(await screen.findByRole('button', { name: /Checkpoint #1/ }))
    fireEvent.click(screen.getByRole('button', { name: 'src/first.ts' }))

    await waitFor(() => expect(api.getTurnCheckpointDiff).toHaveBeenCalledWith(
      'review-session',
      'turn-1',
      'C:/workspace/src/first.ts',
      0,
    ))
    expect(screen.getByTestId('workspace-diff-surface')).toBeInTheDocument()
  })

  it('filters files and prompt summaries across the whole timeline', async () => {
    render(<ChangeReviewPanel sessionId="review-session" />)
    await screen.findByRole('button', { name: /Checkpoint #2/ })

    fireEvent.change(screen.getByRole('searchbox', { name: 'Filter checkpoint files' }), {
      target: { value: 'first' },
    })
    expect(screen.getByRole('button', { name: /Checkpoint #1/ })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Checkpoint #1.*Latest/ })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Checkpoint #2/ })).not.toBeInTheDocument()
  })

  it('resizes the checkpoint timeline by dragging its divider and remembers the width', async () => {
    render(<ChangeReviewPanel sessionId="review-session" />)
    await screen.findByRole('button', { name: /Checkpoint #2/ })

    const timeline = screen.getByTestId('change-review-timeline')
    const divider = screen.getByRole('separator', { name: 'Resize checkpoint list' })
    expect(timeline).toHaveStyle({ width: '400px' })

    fireEvent.mouseDown(divider, { button: 0, clientX: 400 })
    fireEvent.mouseMove(window, { clientX: 600 })
    expect(timeline).toHaveStyle({ width: '600px' })
    fireEvent.mouseUp(window)

    expect(window.localStorage.getItem('cc-haha.change-review.timeline-width')).toBe('600')

    fireEvent.keyDown(divider, { key: 'Home' })
    expect(timeline).toHaveStyle({ width: '280px' })
    fireEvent.doubleClick(divider)
    expect(timeline).toHaveStyle({ width: '400px' })
  })

  it('restores one file through files-only rewind without trimming the conversation', async () => {
    render(<ChangeReviewPanel sessionId="review-session" />)

    fireEvent.click(await screen.findByRole('button', {
      name: 'Revert src/second.ts to this checkpoint',
    }))
    const dialog = screen.getByRole('dialog')
    fireEvent.click(within(dialog).getByRole('button', { name: 'Revert' }))

    await waitFor(() => expect(api.rewind).toHaveBeenCalledWith('review-session', {
      targetUserMessageId: 'turn-2',
      userMessageIndex: 1,
      mode: 'files',
      paths: ['C:/workspace/src/second.ts'],
    }))
  })

  it('reverts all files from the earliest checkpoint while preserving messages', async () => {
    render(<ChangeReviewPanel sessionId="review-session" />)

    fireEvent.click(await screen.findByRole('button', { name: 'Revert all' }))
    const dialog = screen.getByRole('dialog')
    fireEvent.click(within(dialog).getByRole('button', { name: 'Revert' }))

    await waitFor(() => expect(api.rewind).toHaveBeenCalledWith('review-session', {
      targetUserMessageId: 'turn-1',
      userMessageIndex: 0,
      mode: 'files',
    }))
  })

  it('does not scan version control when a session has no checkpoint', async () => {
    api.getTurnCheckpoints.mockResolvedValueOnce({ checkpoints: [] })
    render(<ChangeReviewPanel sessionId="legacy-session" />)

    expect(await screen.findByText('No checkpoint changes')).toBeInTheDocument()
    expect(api.getTurnCheckpoints).toHaveBeenCalledTimes(1)
  })
})
