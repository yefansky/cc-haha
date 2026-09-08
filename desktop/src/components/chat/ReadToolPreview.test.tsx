import { beforeEach, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { ToolCallGroup } from './ToolCallGroup'
import { ToolCallBlock } from './ToolCallBlock'
import { useSettingsStore } from '@/stores/settingsStore'
import { useWorkspacePanelStore } from '@/stores/workspacePanelStore'
import { useTabStore } from '@/stores/tabStore'

const { getWorkspaceFile } = vi.hoisted(() => ({ getWorkspaceFile: vi.fn() }))
vi.mock('@/api/sessions', () => ({ sessionsApi: { getWorkspaceFile } }))

beforeEach(() => {
  vi.clearAllMocks()
  useSettingsStore.setState({ locale: 'en' })
  useTabStore.setState({ activeTabId: 'another-session' })
  useWorkspacePanelStore.setState(useWorkspacePanelStore.getInitialState(), true)
  getWorkspaceFile.mockResolvedValue({ state: 'ok', path: '/repo/read.ts', content: 'current version', language: 'typescript', size: 15 })
})

it('opens the current file in the owning session while preserving the Read result snapshot', async () => {
  const { container } = render(<ToolCallGroup
    sessionId="read-owner"
    agentTaskNotifications={{}}
    toolCalls={[{ id: 'read', toolUseId: 'read', type: 'tool_use', toolName: 'Read', timestamp: 1, input: { file_path: '/repo/read.ts', offset: 20, limit: 2 } }]}
    resultMap={new Map([['read', { id: 'result', toolUseId: 'read', type: 'tool_result', timestamp: 2, content: [{ type: 'text', text: 'original snapshot' }], isError: false }]])}
    childToolCallsByParent={new Map()}
  />)
  expect(getWorkspaceFile).not.toHaveBeenCalled()
  expect(screen.queryByText('Tool Output')).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: 'Open current file' }))
  expect(screen.queryByText('Tool Output')).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: /View read content/ }))
  expect(container.textContent).toContain('original snapshot')
  await waitFor(() => {
    const tabs = useWorkspacePanelStore.getState().previewTabsBySession['read-owner']
    expect(tabs?.[0]?.content).toBe('current version')
    expect(tabs?.[0]?.reveal?.line).toBe(20)
  })
  expect(useWorkspacePanelStore.getState().previewTabsBySession['another-session']).toBeUndefined()
  expect(container.textContent).toContain('original snapshot')
  expect(container.textContent).not.toContain('current version')
})

it('keeps long Read results compact and allows viewing the remaining returned lines', () => {
  const text = Array.from({ length: 30 }, (_, index) => `read-line-${index + 1}`).join('\n')
  const { container } = render(<ToolCallBlock toolName="Read" input={{ file_path: '/repo/long.txt' }} result={{ content: text, isError: false }} />)
  fireEvent.click(screen.getByRole('button', { name: /View read content/ }))
  expect(container.textContent).not.toContain('read-line-30')
  fireEvent.click(screen.getByRole('button', { name: /Show.*12/i }))
  expect(container.textContent).toContain('read-line-30')
  expect(getWorkspaceFile).not.toHaveBeenCalled()
})
