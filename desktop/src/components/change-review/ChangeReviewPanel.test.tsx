// @vitest-environment jsdom

import '@testing-library/jest-dom'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { api } = vi.hoisted(() => ({
  api: {
    getTurnCheckpoints: vi.fn(),
    getTurnCheckpointDiff: vi.fn(),
    getWorkspaceStatus: vi.fn(),
    getWorkspaceDiff: vi.fn(),
    getWorkspaceFile: vi.fn(),
    writeWorkspaceFile: vi.fn(),
    revertWorkspaceFile: vi.fn(),
  },
}))

vi.mock('../../api/sessions', () => ({ sessionsApi: api }))
vi.mock('../workspace/WorkspaceDiffSurface', () => ({
  WorkspaceDiffSurface: ({ renderHunkAction }: { renderHunkAction?: (hunkId: string) => ReactNode }) => <div data-testid="workspace-diff-surface">{renderHunkAction?.('hunk-1')}</div>,
}))

import { ChangeReviewPanel } from './ChangeReviewPanel'

const checkpoints = {
  checkpoints: [{
    target: { targetUserMessageId: 'turn-1', userMessageIndex: 0, userMessageCount: 1 },
    workDir: 'C:/workspace',
    code: { available: true, filesChanged: ['C:/workspace/src/changed.ts', 'C:/workspace/docs/readme.md'], insertions: 5, deletions: 1 },
  }],
}

beforeEach(() => {
  api.getTurnCheckpoints.mockResolvedValue(checkpoints)
  api.getTurnCheckpointDiff.mockResolvedValue({ state: 'ok', diff: 'diff --git a/src/changed.ts b/src/changed.ts' })
  api.getWorkspaceStatus.mockResolvedValue({ changedFiles: [] })
  api.getWorkspaceDiff.mockResolvedValue({ state: 'ok', diff: 'diff --git a/legacy.md b/legacy.md' })
  api.getWorkspaceFile.mockResolvedValue({ state: 'ok', content: 'new text\n' })
  api.writeWorkspaceFile.mockResolvedValue({ state: 'ok', content: 'old text\n' })
  api.revertWorkspaceFile.mockResolvedValue({ state: 'ok', content: 'old text\n' })
})

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe('ChangeReviewPanel', () => {
  it('shows only the latest turn in a flat list and filters it', async () => {
    render(<ChangeReviewPanel sessionId="review-session" />)

    await screen.findByText('src/changed.ts')
    expect(screen.getByText('+5')).toBeInTheDocument()
    expect(screen.getByText('-1')).toBeInTheDocument()

    fireEvent.change(screen.getByRole('textbox', { name: '筛选文件' }), { target: { value: 'readme' } })
    expect(screen.getByText('docs/readme.md')).toBeInTheDocument()
    expect(screen.queryByText('src/changed.ts')).not.toBeInTheDocument()
  })

  it('opens a turn-bound diff without scanning workspace status', async () => {
    render(<ChangeReviewPanel sessionId="review-session" />)

    fireEvent.click(await screen.findByText('src/changed.ts'))

    await waitFor(() => expect(api.getTurnCheckpointDiff).toHaveBeenCalledWith('review-session', 'turn-1', 'C:/workspace/src/changed.ts', 0))
    expect(api.getTurnCheckpoints).toHaveBeenCalledTimes(1)
    expect(screen.getByTestId('workspace-diff-surface')).toBeInTheDocument()
    expect(screen.getByText('docs/readme.md')).toBeInTheDocument()
  })

  it('uses the latest checkpoint that contains changed files, not a later text-only turn', async () => {
    api.getTurnCheckpoints.mockResolvedValueOnce({
      checkpoints: [
        checkpoints.checkpoints[0],
        {
          ...checkpoints.checkpoints[0],
          target: { targetUserMessageId: 'turn-2', userMessageIndex: 1, userMessageCount: 2 },
          code: { available: true, filesChanged: [], insertions: 0, deletions: 0 },
        },
      ],
    })
    render(<ChangeReviewPanel sessionId="review-session" />)

    expect(await screen.findByText('src/changed.ts')).toBeInTheDocument()
    expect(screen.getByText('+5')).toBeInTheDocument()
    expect(api.getWorkspaceStatus).not.toHaveBeenCalled()
  })

  it('does not scan the workspace when a legacy session has no checkpoint', async () => {
    api.getTurnCheckpoints.mockResolvedValueOnce({ checkpoints: [] })
    render(<ChangeReviewPanel sessionId="legacy-session" />)

    expect(await screen.findByText('没有可审阅的本轮修改。')).toBeInTheDocument()
    expect(api.getWorkspaceStatus).not.toHaveBeenCalled()
  })

  it('does not scan the workspace when a checkpoint has no file paths', async () => {
    api.getTurnCheckpoints.mockResolvedValueOnce({
      checkpoints: [{
        ...checkpoints.checkpoints[0],
        code: { available: false, filesChanged: [], insertions: 0, deletions: 0 },
      }],
    })
    render(<ChangeReviewPanel sessionId="legacy-empty-checkpoint" />)

    expect(await screen.findByText('没有可审阅的本轮修改。')).toBeInTheDocument()
    expect(api.getWorkspaceStatus).not.toHaveBeenCalled()
  })

  it('opens multiple files in tabs while keeping the flat list visible', async () => {
    render(<ChangeReviewPanel sessionId="review-session" />)

    fireEvent.click(await screen.findByText('src/changed.ts'))
    fireEvent.click(screen.getByText('docs/readme.md'))

    await waitFor(() => expect(api.getTurnCheckpointDiff).toHaveBeenCalledTimes(2))
    expect(screen.getByRole('button', { name: 'Close changed.ts' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Close readme.md' })).toBeInTheDocument()
    expect(screen.getAllByText('src/changed.ts')).toHaveLength(1)
  })
})
