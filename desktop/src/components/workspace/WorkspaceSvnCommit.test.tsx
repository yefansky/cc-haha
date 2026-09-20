// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { WorkspaceSvnCommit } from './WorkspaceSvnCommit'

const commit = vi.hoisted(() => vi.fn())
vi.mock('../../api/sessions', () => ({ sessionsApi: { commitWorkspaceSvn: commit } }))
vi.mock('../../i18n', () => ({ useTranslation: () => (key: string) => key }))
beforeEach(() => { sessionStorage.clear(); commit.mockReset() })
afterEach(cleanup)
describe('SVN commit input', () => {
  it('uses Ctrl+Enter, blocks duplicate submissions and clears the draft after success', async () => {
    let complete!: (value: { state: string }) => void
    commit.mockImplementation(() => new Promise((resolve) => { complete = resolve }))
    const refresh = vi.fn().mockResolvedValue(undefined)
    const view = render(<WorkspaceSvnCommit sessionId="one" workDir="/repo" onCommitted={refresh} />)
    const input = view.getByRole('textbox')
    const button = view.getByRole('button') as HTMLButtonElement
    expect(button.disabled).toBe(true)
    fireEvent.change(input, { target: { value: ' 中文说明 ' } })
    fireEvent.keyDown(input, { key: 'Enter', ctrlKey: true, isComposing: true })
    expect(commit).not.toHaveBeenCalled()
    fireEvent.keyDown(input, { key: 'Enter', ctrlKey: true })
    fireEvent.keyDown(input, { key: 'Enter', ctrlKey: true })
    expect(commit).toHaveBeenCalledTimes(1)
    expect(commit).toHaveBeenCalledWith('one', '中文说明')
    await act(async () => complete({ state: 'ok' }))
    expect((input as HTMLTextAreaElement).value).toBe('')
    expect(refresh).toHaveBeenCalledTimes(1)
    expect(view.getByRole('status').textContent).toContain('svnCommitSuccess')
  })
  it('preserves the draft on errors and remount, supports button submission, and keeps no-change drafts', async () => {
    commit.mockResolvedValueOnce({ state: 'error', error: 'conflict' }).mockResolvedValueOnce({ state: 'no_changes' })
    const props = { sessionId: 'two', workDir: '/repo', onCommitted: vi.fn().mockResolvedValue(undefined) }
    const view = render(<WorkspaceSvnCommit {...props} />)
    fireEvent.change(view.getByRole('textbox'), { target: { value: 'keep my message' } })
    fireEvent.click(view.getByRole('button'))
    await waitFor(() => expect(view.getByRole('alert').textContent).toBe('conflict'))
    view.unmount()
    const remount = render(<WorkspaceSvnCommit {...props} />)
    expect((remount.getByRole('textbox') as HTMLTextAreaElement).value).toBe('keep my message')
    fireEvent.click(remount.getByRole('button'))
    await waitFor(() => expect(remount.getByRole('status').textContent).toContain('svnCommitNoChanges'))
    expect((remount.getByRole('textbox') as HTMLTextAreaElement).value).toBe('keep my message')
  })
})
