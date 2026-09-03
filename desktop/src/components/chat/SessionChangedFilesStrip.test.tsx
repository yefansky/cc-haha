import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import '@testing-library/jest-dom'

const mocks = vi.hoisted(() => ({
  getTurnCheckpoints: vi.fn(),
  getWorkspaceStatus: vi.fn(),
  getWorkspaceFile: vi.fn(),
  getWorkspaceDiff: vi.fn(),
  getTurnCheckpointDiff: vi.fn(),
}))

vi.mock('../../api/sessions', () => ({
  sessionsApi: {
    getTurnCheckpoints: mocks.getTurnCheckpoints,
    getWorkspaceStatus: mocks.getWorkspaceStatus,
    getWorkspaceFile: mocks.getWorkspaceFile,
    getWorkspaceDiff: mocks.getWorkspaceDiff,
    getTurnCheckpointDiff: mocks.getTurnCheckpointDiff,
  },
}))

import { SessionChangedFilesStrip } from './SessionChangedFilesStrip'
import { clearSessionTurnCheckpointCache } from '../../lib/sessionTurnCheckpoints'
import { useSettingsStore } from '../../stores/settingsStore'
import { useWorkspacePanelStore } from '../../stores/workspacePanelStore'

function checkpoint(
  id: string,
  userMessageIndex: number,
  filesChanged: string[],
) {
  return {
    target: { targetUserMessageId: id, userMessageIndex },
    workDir: '/repo',
    code: { available: true, filesChanged, insertions: 1, deletions: 0 },
  }
}

describe('SessionChangedFilesStrip', () => {
  const initialWorkspaceState = useWorkspacePanelStore.getInitialState()

  beforeEach(() => {
    vi.clearAllMocks()
    clearSessionTurnCheckpointCache()
    useWorkspacePanelStore.setState(initialWorkspaceState, true)
    useSettingsStore.setState({ locale: 'en' })
    mocks.getWorkspaceFile.mockResolvedValue({
      state: 'ok',
      path: 'src/app.ts',
      content: 'export const app = true',
      language: 'typescript',
      size: 23,
    })
    mocks.getWorkspaceDiff.mockResolvedValue({
      state: 'ok',
      path: 'src/app.ts',
      diff: 'diff --git a/src/app.ts b/src/app.ts',
    })
    mocks.getTurnCheckpointDiff.mockResolvedValue({
      state: 'ok',
      path: 'src/app.ts',
      diff: 'diff --turn a/src/app.ts b/src/app.ts',
    })
  })

  it('collapses a deduplicated union of every turn and opens a fresh workspace diff', async () => {
    mocks.getTurnCheckpoints.mockResolvedValue({
      checkpoints: [
        checkpoint('turn-1', 0, ['/repo/src/app.ts', '/repo/docs/readme.md']),
        checkpoint('turn-2', 1, ['src/app.ts']),
      ],
    })
    mocks.getWorkspaceStatus
      .mockResolvedValueOnce({
        state: 'ok',
        workDir: '/repo',
        repoName: 'repo',
        branch: 'main',
        isGitRepo: true,
        changedFiles: [],
      })
      .mockResolvedValueOnce({
        state: 'ok',
        workDir: '/repo',
        repoName: 'repo',
        branch: 'main',
        isGitRepo: true,
        changedFiles: [{ path: 'src/app.ts', status: 'modified', additions: 1, deletions: 1 }],
      })

    render(
      <SessionChangedFilesStrip
        sessionId="session-union"
        workDir="/repo"
        enabled
        refreshNonce={2}
      />,
    )

    const toggle = await screen.findByRole('button', { name: 'Session file changes: 2' })
    expect(toggle).toHaveAttribute('aria-expanded', 'false')
    expect(screen.queryByRole('button', { name: 'Open src/app.ts from session changes' })).not.toBeInTheDocument()

    fireEvent.click(toggle)
    expect(toggle).toHaveAttribute('aria-expanded', 'true')
    expect(screen.getByRole('button', { name: 'Open docs/readme.md from session changes' })).toBeInTheDocument()

    await act(async () => {
      await useWorkspacePanelStore.getState().loadStatus('session-union')
    })
    fireEvent.click(screen.getByRole('button', { name: 'Open src/app.ts from session changes' }))

    await waitFor(() => {
      expect(mocks.getWorkspaceStatus).toHaveBeenCalledTimes(2)
      expect(mocks.getWorkspaceDiff).toHaveBeenCalledWith('session-union', 'src/app.ts')
    })
    const state = useWorkspacePanelStore.getState()
    expect(state.isPanelOpen('session-union')).toBe(true)
    expect(state.previewTabsBySession['session-union']?.at(-1)).toMatchObject({
      path: 'src/app.ts',
      kind: 'diff',
      diffSource: { kind: 'workspace' },
    })
  })

  it('falls back to the latest turn snapshot when a cumulative file no longer exists', async () => {
    mocks.getTurnCheckpoints.mockResolvedValue({
      checkpoints: [
        checkpoint('turn-old', 0, ['src/app.ts']),
        checkpoint('turn-latest', 2, ['src/app.ts']),
      ],
    })
    mocks.getWorkspaceStatus.mockResolvedValue({
      state: 'ok',
      workDir: '/repo',
      repoName: 'repo',
      branch: 'main',
      isGitRepo: true,
      changedFiles: [],
    })
    mocks.getWorkspaceFile.mockResolvedValue({
      state: 'missing',
      path: 'src/app.ts',
      language: 'text',
      size: 0,
    })

    render(
      <SessionChangedFilesStrip
        sessionId="session-missing"
        workDir="/repo"
        enabled
        refreshNonce={2}
      />,
    )

    fireEvent.click(await screen.findByRole('button', { name: 'Session file changes: 1' }))
    fireEvent.click(screen.getByRole('button', { name: 'Open src/app.ts from session changes' }))

    await waitFor(() => {
      expect(mocks.getTurnCheckpointDiff).toHaveBeenCalledWith(
        'session-missing',
        'turn-latest',
        'src/app.ts',
        2,
      )
    })
    expect(useWorkspacePanelStore.getState().previewTabsBySession['session-missing']?.at(-1)).toMatchObject({
      kind: 'diff',
      diffSource: {
        kind: 'turn',
        targetUserMessageId: 'turn-latest',
        userMessageIndex: 2,
      },
    })
  })
})
