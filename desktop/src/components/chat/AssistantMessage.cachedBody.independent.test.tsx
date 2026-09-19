import '@testing-library/jest-dom'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
const api = vi.hoisted(() => ({ metadata: vi.fn(), file: vi.fn(), status: vi.fn(), tree: vi.fn() }))
vi.mock('../../api/sessions', () => ({ sessionsApi: { resolveFileReference: api.metadata, getWorkspaceFile: api.file, getWorkspaceStatus: api.status, getWorkspaceTree: api.tree } }))
vi.mock('./InlineImageGallery', () => ({ InlineImageGallery: () => null }))
vi.mock('./InlineVideoGallery', () => ({ InlineVideoGallery: () => null }))
vi.mock('./MessageActionBar', () => ({ MessageActionBar: () => null }))
vi.mock('./TurnCompletionStamp', () => ({ TurnCompletionStamp: () => null }))
import { AssistantMessage } from './AssistantMessage'
import { useWorkspacePanelStore } from '../../stores/workspacePanelStore'
import { invalidateAssistantFileNavigation } from '../../lib/useAssistantFileActions'
const initial = useWorkspacePanelStore.getInitialState()
afterEach(() => { cleanup(); useWorkspacePanelStore.getState().clearSession('cached-body-test'); useWorkspacePanelStore.setState(initial, true); invalidateAssistantFileNavigation() })
it('real preview store body cache cannot reopen after metadata permission revocation or deletion', async () => {
  const session = 'cached-body-test', file = 'G:/fixture/docs/cached.md'
  const status = { state: 'ok' as const, workDir: 'G:/fixture', repoName: null, branch: null, isGitRepo: false, changedFiles: [] }
  useWorkspacePanelStore.setState({ statusBySession: { [session]: status } })
  api.status.mockResolvedValue(status)
  api.file.mockResolvedValue({ state: 'ok', path: file, content: 'OLD CACHED BODY', size: 15, language: 'markdown', truncated: false })
  let state = 'resolved'
  const references: string[] = []
  api.metadata.mockImplementation(async (_session, request) => {
    references.push(request.reference)
    return state === 'resolved' ? { state, path: file, complete: true, scope: { workDir: 'G:/fixture', permissionGeneration: '1' } } : { state, complete: state === 'missing' }
  })
  render(<AssistantMessage sessionId={session} content="`cached.md`" />)
  const link = screen.getByRole('link', { name: 'cached.md' })
  fireEvent.click(link)
  await waitFor(() => expect(useWorkspacePanelStore.getState().previewTabsBySession[session]?.[0]?.state).toBe('ok'))
  expect(api.file).toHaveBeenCalledTimes(1)
  fireEvent.click(link)
  await waitFor(() => expect(useWorkspacePanelStore.getState().previewOpenNonceBySession[session]).toBe(2))
  expect(api.file).toHaveBeenCalledTimes(1) // actual preview cache hit, not a stub opener
  expect(references).toEqual(['cached.md', file])
  state = 'denied'
  fireEvent.click(link)
  await waitFor(() => expect(screen.getByRole('alert')).toBeInTheDocument())
  expect(useWorkspacePanelStore.getState().previewOpenNonceBySession[session]).toBe(2)
  state = 'missing'
  fireEvent.click(link)
  await waitFor(() => expect(references).toHaveLength(4))
  expect(useWorkspacePanelStore.getState().previewOpenNonceBySession[session]).toBe(2)
  expect(api.file).toHaveBeenCalledTimes(1)
})
