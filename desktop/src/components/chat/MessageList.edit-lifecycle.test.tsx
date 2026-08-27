import { beforeEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MessageList } from './MessageList'
import { sessionsApi } from '../../api/sessions'
import { useChatStore } from '../../stores/chatStore'
import { useSessionStore } from '../../stores/sessionStore'
import { useSettingsStore } from '../../stores/settingsStore'
import { useTabStore } from '../../stores/tabStore'
import { useUIStore } from '../../stores/uiStore'
import { useWorkspaceChatContextStore } from '../../stores/workspaceChatContextStore'
import { useWorkspacePanelStore } from '../../stores/workspacePanelStore'
import type { PerSessionState } from '../../stores/chatStore'

const SESSION_ID = 'edit-lifecycle-session'

function makeSessionState(overrides: Partial<PerSessionState> = {}): PerSessionState {
  return {
    messages: [],
    chatState: 'idle',
    connectionState: 'connected',
    streamingText: '',
    streamingToolInput: '',
    activeToolUseId: null,
    activeToolName: null,
    activeThinkingId: null,
    pendingPermission: null,
    pendingComputerUsePermission: null,
    tokenUsage: { input_tokens: 0, output_tokens: 0 },
    streamingResponseChars: 0,
    elapsedSeconds: 0,
    statusVerb: '',
    apiRetry: null,
    slashCommands: [],
    agentTaskNotifications: {},
    elapsedTimer: null,
    composerPrefill: null,
    ...overrides,
  }
}

describe('MessageList edit replacement lifecycle', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    useSettingsStore.setState({ locale: 'en' })
    useUIStore.setState({ pendingSettingsTab: null })
    useTabStore.setState({
      activeTabId: SESSION_ID,
      tabs: [{ sessionId: SESSION_ID, title: 'Edit lifecycle', type: 'session', status: 'idle' }],
    })
    useSessionStore.setState({ sessions: [], activeSessionId: null, isLoading: false, error: null })
    useWorkspaceChatContextStore.setState(useWorkspaceChatContextStore.getInitialState(), true)
    useWorkspacePanelStore.setState(useWorkspacePanelStore.getInitialState(), true)
    vi.spyOn(sessionsApi, 'getTurnCheckpoints').mockImplementation(() => new Promise(() => {}))
    vi.spyOn(sessionsApi, 'getWorkspaceStatus').mockResolvedValue({
      state: 'ok',
      workDir: '/tmp/edit-lifecycle',
      repoName: 'edit-lifecycle',
      branch: null,
      isGitRepo: false,
      changedFiles: [],
    })
  })

  it('uses the bounded replacement path instead of waiting for generic rewind', async () => {
    let resolveReplacement!: (value: Awaited<ReturnType<typeof sessionsApi.replaceMessage>>) => void
    const replacementPending = new Promise<Awaited<ReturnType<typeof sessionsApi.replaceMessage>>>((resolve) => {
      resolveReplacement = resolve
    })
    const replaceMessage = vi.spyOn(sessionsApi, 'replaceMessage').mockReturnValue(replacementPending)
    const rewind = vi.spyOn(sessionsApi, 'rewind').mockResolvedValue({
      target: { targetUserMessageId: 'user-1', userMessageIndex: 0, userMessageCount: 1 },
      conversation: { messagesRemoved: 2, removedMessageIds: ['user-1', 'assistant-1'] },
      code: { available: false, filesChanged: [], insertions: 0, deletions: 0 },
      mode: 'conversation',
    })
    const sendMessage = vi.fn()

    useChatStore.setState({
      sendMessage,
      sessions: {
        [SESSION_ID]: makeSessionState({
          messages: [
            {
              id: 'first-ui',
              transcriptMessageId: 'user-1',
              type: 'user_text',
              content: 'first prompt',
              timestamp: 1,
            },
            { id: 'assistant-1', type: 'assistant_text', content: 'first reply', timestamp: 2 },
          ],
        }),
      },
    })

    render(<MessageList />)
    fireEvent.click((await screen.findAllByRole('button', { name: 'Edit this prompt' }))[0]!)
    fireEvent.change(await screen.findByRole('textbox', { name: 'Edit prompt' }), {
      target: { value: 'edited first prompt' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Send' }))

    await waitFor(() => expect(replaceMessage).toHaveBeenCalledWith(SESSION_ID, {
      targetUserMessageId: 'user-1',
      expectedContent: 'first prompt',
    }))
    expect(rewind).not.toHaveBeenCalled()
    expect(sendMessage).not.toHaveBeenCalled()
    expect((screen.getByRole('button', { name: 'Send' }) as HTMLButtonElement).disabled).toBe(true)

    await act(async () => {
      resolveReplacement({
        target: { targetUserMessageId: 'user-1', userMessageIndex: 0, userMessageCount: 1 },
        conversation: { messagesRemoved: 2, removedMessageIds: ['user-1', 'assistant-1'] },
        mode: 'edit',
      })
      await Promise.resolve()
    })

    await waitFor(() => expect(sendMessage).toHaveBeenCalledWith(
      SESSION_ID,
      'edited first prompt',
      undefined,
      {
        displayContent: 'edited first prompt',
        displayAttachments: undefined,
        replaceFromMessageId: 'first-ui',
      },
    ))
  })
})
