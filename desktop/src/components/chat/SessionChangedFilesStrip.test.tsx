import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import '@testing-library/jest-dom'

const mocks = vi.hoisted(() => ({
  copyText: vi.fn(),
  getTurnCheckpoints: vi.fn(),
  getWorkspaceStatus: vi.fn(),
  getWorkspaceFile: vi.fn(),
  getWorkspaceDiff: vi.fn(),
  getTurnCheckpointDiff: vi.fn(),
}))

vi.mock('@/lib/clipboard', () => ({ copyTextToClipboard: mocks.copyText }))

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
  it.each([
    ['src/app.ts', '/repo', '/repo/src/app.ts'],
    ['K:/external/file.lua', '/repo', 'K:/external/file.lua'],
    ['//server/share/file.lua', '/repo', '//server/share/file.lua'],
  ])('copies paths from the context menu for %s without opening the file', async (source, root, absolute) => {
    mocks.getTurnCheckpoints.mockResolvedValue({ checkpoints: [{ ...checkpoint('turn', 0, [source]), workDir: root }] })
    render(<SessionChangedFilesStrip sessionId="copy-path" workDir="/different" enabled refreshNonce={0} />)
    fireEvent.click(await screen.findByRole('button', { name: 'Session file changes: 1' }))
    const row = screen.getByRole('button', { name: /Open.*app.ts|Open.*file.lua/ })
    const open = vi.spyOn(useWorkspacePanelStore.getState(), 'openPreview')
    fireEvent.contextMenu(row, { clientX: 40, clientY: 60 })
    fireEvent.click(screen.getByRole('menuitem', { name: 'Copy absolute path' }))
    await waitFor(() => expect(mocks.copyText).toHaveBeenCalledWith(absolute))
    expect(open).not.toHaveBeenCalled()
    expect(screen.queryByRole('menu')).not.toBeInTheDocument()
    fireEvent.contextMenu(row)
    fireEvent.click(screen.getByRole('menuitem', { name: 'Copy path' }))
    await waitFor(() => expect(mocks.copyText).toHaveBeenLastCalledWith(source))
    fireEvent.contextMenu(row)
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(screen.queryByRole('menu')).not.toBeInTheDocument()
    open.mockRestore()
  })

  it('refreshes confirmed child changes while running, keeps expanded state, and stops polling on completion', async () => {
    vi.useFakeTimers()
    try {
      mocks.getTurnCheckpoints.mockResolvedValueOnce({ checkpoints: [checkpoint('turn', 0, ['/repo/process.md'])] })
        .mockResolvedValue({ checkpoints: [checkpoint('turn', 0, ['/repo/process.md', '/other/child.lua'])] })
      const view = render(<SessionChangedFilesStrip sessionId="live-child" workDir="/repo" enabled live refreshNonce={1} />)
      await act(async () => { await vi.advanceTimersByTimeAsync(0) })
      fireEvent.click(screen.getByRole('button', { name: 'Session file changes: 1' }))
      await act(async () => { await vi.advanceTimersByTimeAsync(3000) })
      expect(screen.getByRole('button', { name: 'Session file changes: 2' })).toHaveAttribute('aria-expanded', 'true')
      expect(screen.getByText('child.lua')).toBeInTheDocument()
      view.rerender(<SessionChangedFilesStrip sessionId="live-child" workDir="/repo" enabled live={false} refreshNonce={1} />)
      await act(async () => { await vi.advanceTimersByTimeAsync(0) })
      const requests = mocks.getTurnCheckpoints.mock.calls.length
      await act(async () => { await vi.advanceTimersByTimeAsync(9000) })
      expect(mocks.getTurnCheckpoints).toHaveBeenCalledTimes(requests)
      view.unmount()
    } finally { vi.useRealTimers() }
  })
  const initialWorkspaceState = useWorkspacePanelStore.getInitialState()

  beforeEach(() => {
    vi.clearAllMocks()
    mocks.copyText.mockResolvedValue(true)
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

  it('shows actual registered-script changes after refresh but not unchanged registered candidates', async () => {
    mocks.getTurnCheckpoints.mockResolvedValueOnce({ checkpoints: [checkpoint('registered', 0, [])] })
      .mockResolvedValue({ checkpoints: [checkpoint('registered', 0, ['/repo/edited.lua', '/repo/new.lua', '/repo/deleted.lua'])] })
    const view = render(<SessionChangedFilesStrip sessionId="registered-script" workDir="/repo" enabled refreshNonce={0} />)
    await waitFor(() => expect(mocks.getTurnCheckpoints).toHaveBeenCalledTimes(1))
    expect(screen.queryByTestId('session-changed-files-strip')).not.toBeInTheDocument()
    view.rerender(<SessionChangedFilesStrip sessionId="registered-script" workDir="/repo" enabled refreshNonce={1} />)
    fireEvent.click(await screen.findByRole('button', { name: 'Session file changes: 3' }))
    expect(screen.getByText('edited.lua')).toBeInTheDocument()
    expect(screen.getByText('new.lua')).toBeInTheDocument()
    expect(screen.getByText('deleted.lua')).toBeInTheDocument()
    expect(screen.queryByText('unchanged.lua')).not.toBeInTheDocument()
  })

  it('warms every deduplicated session file and opens it without a workspace status scan', async () => {
    mocks.getTurnCheckpoints.mockResolvedValue({
      checkpoints: [
        checkpoint('turn-1', 0, ['/repo/src/app.ts', '/repo/docs/readme.md']),
        checkpoint('turn-2', 1, ['src/app.ts']),
      ],
    })
    mocks.getWorkspaceFile.mockImplementation(async (_sessionId: string, path: string) => ({
      state: 'ok',
      path,
      content: `content:${path}`,
      language: 'text',
      size: path.length,
    }))

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

    await waitFor(() => {
      expect(mocks.getWorkspaceFile).toHaveBeenCalledTimes(2)
      expect(mocks.getWorkspaceDiff).toHaveBeenCalledTimes(2)
    })
    expect(useWorkspacePanelStore.getState().previewTabsBySession['session-union']).toBeUndefined()
    fireEvent.click(screen.getByRole('button', { name: 'Open src/app.ts from session changes' }))

    await waitFor(() => {
      expect(useWorkspacePanelStore.getState().previewTabsBySession['session-union']?.at(-1)?.state).toBe('ok')
    })
    expect(mocks.getWorkspaceStatus).not.toHaveBeenCalled()
    expect(mocks.getWorkspaceFile).toHaveBeenCalledTimes(2)
    expect(mocks.getWorkspaceDiff).toHaveBeenCalledWith('session-union', 'docs/readme.md')
    expect(mocks.getWorkspaceDiff).toHaveBeenCalledWith('session-union', 'src/app.ts')
    const state = useWorkspacePanelStore.getState()
    expect(state.isPanelOpen('session-union')).toBe(true)
    expect(state.previewTabsBySession['session-union']?.at(-1)).toMatchObject({
      path: 'src/app.ts',
      kind: 'file',
      content: 'content:src/app.ts',
    })
    await act(async () => {
      await state.openPreview('session-union', 'src/app.ts', 'diff')
    })
    expect(mocks.getWorkspaceDiff).toHaveBeenCalledTimes(2)
    expect(useWorkspacePanelStore.getState().previewTabsBySession['session-union']?.at(-1))
      .toMatchObject({ state: 'ok', kind: 'diff' })
  })

  it('shares a pending session-selection preload across repeated file clicks', async () => {
    const pending = new Promise<{
      state: 'ok'
      path: string
      content: string
      language: string
      size: number
    }>((resolve) => {
      setTimeout(() => resolve({
        state: 'ok',
        path: 'src/app.ts',
        content: 'ready once',
        language: 'typescript',
        size: 10,
      }), 20)
    })
    mocks.getTurnCheckpoints.mockResolvedValue({
      checkpoints: [checkpoint('turn-1', 0, ['src/app.ts'])],
    })
    mocks.getWorkspaceFile.mockReturnValue(pending)

    render(
      <SessionChangedFilesStrip
        sessionId="session-rapid-click"
        workDir="/repo"
        enabled
        refreshNonce={1}
      />,
    )

    const toggle = await screen.findByRole('button', { name: 'Session file changes: 1' })
    await waitFor(() => expect(mocks.getWorkspaceFile).toHaveBeenCalledOnce())
    fireEvent.click(toggle)
    const row = screen.getByRole('button', { name: 'Open src/app.ts from session changes' })
    fireEvent.click(row)
    fireEvent.click(row)
    fireEvent.click(row)

    await waitFor(() => {
      expect(useWorkspacePanelStore.getState().previewTabsBySession['session-rapid-click']?.at(-1)).toMatchObject({
        state: 'ok',
        content: 'ready once',
      })
    })
    expect(mocks.getWorkspaceFile).toHaveBeenCalledOnce()
  })

  it('does not force the same files again when history loading only changes the message count', async () => {
    mocks.getTurnCheckpoints.mockResolvedValue({
      checkpoints: [checkpoint('turn-stable', 0, ['src/app.ts'])],
    })

    const view = render(
      <SessionChangedFilesStrip
        sessionId="session-stable-history"
        workDir="/repo"
        enabled
        refreshNonce={0}
      />,
    )
    await waitFor(() => expect(mocks.getWorkspaceFile).toHaveBeenCalledOnce())

    view.rerender(
      <SessionChangedFilesStrip
        sessionId="session-stable-history"
        workDir="/repo"
        enabled
        refreshNonce={12}
      />,
    )
    await waitFor(() => expect(mocks.getTurnCheckpoints).toHaveBeenCalledTimes(2))

    expect(mocks.getWorkspaceFile).toHaveBeenCalledOnce()
    expect(mocks.getWorkspaceDiff).toHaveBeenCalledOnce()
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
