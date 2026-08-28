import { beforeEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen } from '@testing-library/react'

const { sendMock, forceReconnectMock } = vi.hoisted(() => ({
  sendMock: vi.fn(),
  forceReconnectMock: vi.fn(() => true),
}))

vi.mock('../../api/websocket', () => ({
  wsManager: {
    connect: vi.fn(),
    disconnect: vi.fn(),
    forceReconnect: forceReconnectMock,
    onConnectionState: vi.fn((_sessionId: string, handler: (state: string) => void) => {
      handler('connecting')
      return () => {}
    }),
    onMessage: vi.fn(() => () => {}),
    clearHandlers: vi.fn(),
    send: sendMock,
    sendIfOpen: vi.fn((sessionId: string, message: unknown) => {
      try {
        sendMock(sessionId, message)
        return true
      } catch {
        return false
      }
    }),
  },
}))

vi.mock('../../api/sessions', () => ({
  sessionsApi: {
    getMessages: vi.fn(async () => ({ messages: [] })),
    getSlashCommands: vi.fn(async () => ({ commands: [] })),
  },
}))

import { AskUserQuestion } from './AskUserQuestion'
import { useChatStore } from '../../stores/chatStore'
import { useSettingsStore } from '../../stores/settingsStore'
import { useTabStore } from '../../stores/tabStore'

const ACTIVE_TAB = 'active-tab'

describe('AskUserQuestion', () => {
  beforeEach(() => {
    sendMock.mockReset()
    forceReconnectMock.mockClear()
    useSettingsStore.setState({ locale: 'en' })
    useTabStore.setState({
      activeTabId: ACTIVE_TAB,
      tabs: [{ sessionId: ACTIVE_TAB, title: 'Test', type: 'session', status: 'idle' }],
    })
    useChatStore.setState({
      sessions: {
        [ACTIVE_TAB]: {
          messages: [],
          chatState: 'permission_pending',
          connectionState: 'connected',
          streamingText: '',
          streamingToolInput: '',
          activeToolUseId: null,
          activeToolName: null,
          activeThinkingId: null,
          pendingPermission: {
            requestId: 'perm-1',
            toolName: 'AskUserQuestion',
            toolUseId: 'tool-1',
            input: {
              questions: [
                {
                  question: 'Should we persist data?',
                  options: [{ label: 'No' }, { label: 'Yes' }],
                },
              ],
            },
          },
          pendingComputerUsePermission: null,
          tokenUsage: { input_tokens: 0, output_tokens: 0 },
          streamingResponseChars: 0,
          elapsedSeconds: 0,
          statusVerb: '',
          slashCommands: [],
          agentTaskNotifications: {},
          elapsedTimer: null,
        },
      },
    })
  })

  // Regression: the "no questions" early return used to sit above two useMemo calls,
  // so a mounted instance whose question count crossed zero threw "Rendered fewer/more
  // hooks than expected" and took the surrounding message list down with it. `input` is
  // not stable for the lifetime of the instance — chatStore rebuilds tool_use messages
  // from the transcript under a stable id — so both directions are reachable.
  //
  // These assert on rendering rather than on hook counts, which is what a reader can
  // check: if the early return moves back above a hook, React throws during rerender.
  describe('hook order across a changing question count', () => {
    const ONE_QUESTION = { question: 'Ship it?', options: [{ label: 'Yes' }, { label: 'No' }] }

    it('survives input gaining questions after rendering with none', () => {
      const { rerender } = render(<AskUserQuestion toolUseId="tool-1" input={{}} />)

      rerender(<AskUserQuestion toolUseId="tool-1" input={ONE_QUESTION} />)

      expect(screen.getByText('Ship it?')).toBeTruthy()
    })

    it('survives input losing its questions while mounted', () => {
      const { container, rerender } = render(
        <AskUserQuestion toolUseId="tool-1" input={ONE_QUESTION} />,
      )
      expect(screen.getByText('Ship it?')).toBeTruthy()

      rerender(<AskUserQuestion toolUseId="tool-1" input={{}} />)

      expect(container.textContent).toBe('')
    })
  })

  it('submits answers through permission_response updatedInput instead of sending a chat message', () => {
    render(
      <AskUserQuestion
        toolUseId="tool-1"
        input={{
          questions: [
            {
              question: 'Should we persist data?',
              options: [{ label: 'No' }, { label: 'Yes' }],
            },
          ],
        }}
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: /^No$/ }))
    fireEvent.click(screen.getByRole('button', { name: /submit/i }))

    expect(sendMock).toHaveBeenCalledWith(ACTIVE_TAB, {
      type: 'permission_response',
      requestId: 'perm-1',
      allowed: true,
      updatedInput: {
        questions: [
          {
            question: 'Should we persist data?',
            options: [{ label: 'No' }, { label: 'Yes' }],
          },
        ],
        answers: {
          'Should we persist data?': 'No',
        },
      },
    })
  })

  const publishDecision = (
    decisionId: string,
    question: string,
    labels: string[],
    options: { attachedRequestId?: string; evidenceComplete?: boolean } = {},
  ) => act(() => {
    useChatStore.getState().handleServerMessage(ACTIVE_TAB, {
      type: 'permission_requests_snapshot',
      toolRequestIds: [],
      computerUseRequestIds: [],
      turnActive: true,
      userDecisions: {
        transcriptEvidenceComplete: options.evidenceComplete ?? true,
        userDecisionResponseProtocol: 'orphaned-permission-v1',
        decisions: [{
          decisionId,
          semanticState: { status: 'open' },
          runtimeBinding: options.attachedRequestId
            ? { status: 'attached', requestId: options.attachedRequestId }
            : { status: 'detached' },
          responseCapability: options.attachedRequestId
            ? { status: 'runtime_callback' }
            : options.evidenceComplete === false
              ? { status: 'unavailable', code: 'EVIDENCE_INCOMPLETE' }
              : { status: 'orphaned_recovery' },
          response: null,
          input: { questions: [{ question, options: labels.map((label) => ({ label })) }] },
          inputSource: options.attachedRequestId ? 'live' : 'transcript',
          conflicted: false,
        }],
      },
    } as never)
  })

  it('keeps a dispatched answer in submitting state without claiming it was accepted', () => {
    render(
      <AskUserQuestion
        toolUseId="tool-1"
        input={{
          questions: [{
            question: 'Should we persist data?',
            options: [{ label: 'No' }, { label: 'Yes' }],
          }],
        }}
      />,
    )

    const option = screen.getByRole('button', { name: /^No$/ })
    fireEvent.click(option)
    fireEvent.click(screen.getByRole('button', { name: /submit/i }))

    expect(useChatStore.getState().sessions[ACTIVE_TAB]
      ?.pendingPermissions?.['perm-1']).toMatchObject({ responseState: 'submitting' })
    expect(option).toHaveProperty('disabled', true)
    expect(screen.queryByPlaceholderText('Type your answer...')).toBeNull()
    expect(screen.queryByRole('button', { name: /submit/i })).toBeNull()
    expect(screen.queryByRole('button', { name: /chat about this/i })).toBeNull()
    expect(screen.queryByText('Answered')).toBeNull()
    expect(screen.queryByText('Completed')).toBeNull()
  })

  it('stays actionable when the local websocket send throws', () => {
    sendMock.mockImplementationOnce(() => { throw new Error('socket write failed') })
    render(
      <AskUserQuestion
        toolUseId="tool-1"
        input={{
          questions: [{
            question: 'Should we persist data?',
            options: [{ label: 'No' }, { label: 'Yes' }],
          }],
        }}
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: /^No$/ }))
    expect(() => {
      fireEvent.click(screen.getByRole('button', { name: /submit/i }))
    }).not.toThrow()

    expect(screen.getByRole('button', { name: /^No$/ })).toHaveProperty('disabled', false)
    expect(screen.getByRole('button', { name: /submit/i })).toHaveProperty('disabled', false)
    expect(screen.queryByText('Answered')).toBeNull()
    expect(screen.queryByText('Completed')).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: /submit/i }))
    expect(sendMock).toHaveBeenCalledTimes(2)
  })

  it('restores the draft without claiming a terminal result after delivery fails', () => {
    const input = {
      questions: [{
        question: 'Should we persist data?',
        options: [{ label: 'No' }, { label: 'Yes' }],
      }],
    }
    const { rerender } = render(<AskUserQuestion toolUseId="tool-1" input={input} />)
    const option = screen.getByRole('button', { name: /^No$/ })
    const textarea = screen.getByPlaceholderText('Type your answer...')
    fireEvent.click(option)
    fireEvent.change(textarea, { target: { value: 'Keep this draft' } })
    fireEvent.click(screen.getByRole('button', { name: /submit/i }))
    rerender(<AskUserQuestion toolUseId="tool-1" input={input} result="premature result" />)

    act(() => {
      useChatStore.getState().handleServerMessage(ACTIVE_TAB, {
        type: 'permission_response_failed',
        requestId: 'perm-1',
        permissionType: 'tool',
        code: 'PERMISSION_DELIVERY_FAILED',
        retryable: true,
        message: 'delivery failed',
      })
    })

    expect(option).toHaveProperty('disabled', false)
    expect(textarea).toHaveProperty('value', 'Keep this draft')
    expect(screen.getByRole('button', { name: /submit/i })).toHaveProperty('disabled', false)
    expect(screen.queryByText('Answered')).toBeNull()
    expect(screen.queryByText('Completed')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: /submit/i }))
    expect(sendMock).toHaveBeenCalledTimes(2)
  })

  it('allows multiple selections when a question is marked multiSelect', () => {
    render(
      <AskUserQuestion
        toolUseId="tool-1"
        input={{
          questions: [
            {
              question: 'Which tasks should run?',
              multiSelect: true,
              options: [
                { label: 'Lint' },
                { label: 'Tests' },
                { label: 'Build' },
              ],
            },
          ],
        }}
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: /^Lint$/ }))
    fireEvent.click(screen.getByRole('button', { name: /^Tests$/ }))
    fireEvent.click(screen.getByRole('button', { name: /submit/i }))

    expect(sendMock).toHaveBeenCalledWith(ACTIVE_TAB, {
      type: 'permission_response',
      requestId: 'perm-1',
      allowed: true,
      updatedInput: {
        questions: [
          {
            question: 'Which tasks should run?',
            multiSelect: true,
            options: [
              { label: 'Lint' },
              { label: 'Tests' },
              { label: 'Build' },
            ],
          },
        ],
        answers: {
          'Which tasks should run?': 'Lint, Tests',
        },
      },
    })
  })

  it('preserves multiSelect for single-question input shape', () => {
    render(
      <AskUserQuestion
        toolUseId="tool-1"
        input={{
          question: 'Which tasks should run?',
          multiSelect: true,
          options: [
            { label: 'Lint' },
            { label: 'Tests' },
            { label: 'Build' },
          ],
        }}
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: /^Lint$/ }))
    fireEvent.click(screen.getByRole('button', { name: /^Tests$/ }))
    fireEvent.click(screen.getByRole('button', { name: /submit/i }))

    expect(sendMock).toHaveBeenCalledWith(ACTIVE_TAB, {
      type: 'permission_response',
      requestId: 'perm-1',
      allowed: true,
      updatedInput: {
        question: 'Which tasks should run?',
        multiSelect: true,
        options: [
          { label: 'Lint' },
          { label: 'Tests' },
          { label: 'Build' },
        ],
        answers: {
          'Which tasks should run?': 'Lint, Tests',
        },
      },
    })
  })

  it('responds to the provided session instead of the active tab', () => {
    useTabStore.setState({
      activeTabId: 'other-tab',
      tabs: [
        { sessionId: 'other-tab', title: 'Other', type: 'session', status: 'idle' },
        { sessionId: 'target-tab', title: 'Target', type: 'session', status: 'idle' },
      ],
    })
    useChatStore.setState((state) => ({
      sessions: {
        ...state.sessions,
        'target-tab': {
          ...state.sessions[ACTIVE_TAB]!,
          pendingPermission: {
            requestId: 'perm-target',
            toolName: 'AskUserQuestion',
            toolUseId: 'tool-target',
            input: {
              questions: [
                {
                  question: 'Run tests?',
                  options: [{ label: 'No' }, { label: 'Yes' }],
                },
              ],
            },
          },
        },
      },
    }))

    render(
      <AskUserQuestion
        sessionId="target-tab"
        toolUseId="tool-target"
        input={{
          questions: [
            {
              question: 'Run tests?',
              options: [{ label: 'No' }, { label: 'Yes' }],
            },
          ],
        }}
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: /^Yes$/ }))
    fireEvent.click(screen.getByRole('button', { name: /submit/i }))

    expect(sendMock).toHaveBeenCalledWith('target-tab', {
      type: 'permission_response',
      requestId: 'perm-target',
      allowed: true,
      updatedInput: {
        questions: [
          {
            question: 'Run tests?',
            options: [{ label: 'No' }, { label: 'Yes' }],
          },
        ],
        answers: {
          'Run tests?': 'Yes',
        },
      },
    })
  })

  it('keeps custom responses scoped to each question tab', () => {
    const input = {
      questions: [
        {
          header: 'Q1',
          question: 'First question?',
          options: [{ label: 'A1' }, { label: 'B1' }],
        },
        {
          header: 'Q2',
          question: 'Second question?',
          options: [{ label: 'A2' }, { label: 'B2' }],
        },
      ],
    }

    render(
      <AskUserQuestion
        toolUseId="tool-1"
        input={input}
      />,
    )

    fireEvent.change(screen.getByPlaceholderText('Type your answer...'), {
      target: { value: 'transient-q1' },
    })
    fireEvent.change(screen.getByPlaceholderText('Type your answer...'), {
      target: { value: '' },
    })
    fireEvent.click(screen.getByRole('button', { name: /^A1$/ }))
    fireEvent.change(screen.getByPlaceholderText('Type your answer...'), {
      target: { value: 'custom-q1' },
    })
    fireEvent.click(screen.getByRole('button', { name: /Q2$/ }))

    expect((screen.getByPlaceholderText('Type your answer...') as HTMLTextAreaElement).value).toBe('')

    fireEvent.click(screen.getByRole('button', { name: /^A2$/ }))
    fireEvent.click(screen.getByRole('button', { name: /Q1$/ }))

    expect((screen.getByPlaceholderText('Type your answer...') as HTMLTextAreaElement).value).toBe('custom-q1')

    fireEvent.click(screen.getByRole('button', { name: /submit/i }))

    expect(sendMock).toHaveBeenCalledWith(ACTIVE_TAB, {
      type: 'permission_response',
      requestId: 'perm-1',
      allowed: true,
      updatedInput: {
        ...input,
        answers: {
          'First question?': 'custom-q1',
          'Second question?': 'A2',
        },
      },
    })
  })

  it('uses a multiline custom response box and submits it with Ctrl+Enter', () => {
    render(
      <AskUserQuestion
        toolUseId="tool-1"
        input={{
          questions: [
            {
              question: 'What context should we restore?',
              options: [{ label: 'Skip' }],
            },
          ],
        }}
      />,
    )

    const textarea = screen.getByPlaceholderText('Type your answer...')
    expect(textarea.tagName).toBe('TEXTAREA')
    expect(textarea.getAttribute('rows')).toBe('3')

    fireEvent.change(textarea, {
      target: { value: 'First restored context line\nSecond restored context line' },
    })
    fireEvent.keyDown(textarea, { key: 'Enter' })
    expect(sendMock).not.toHaveBeenCalled()

    fireEvent.keyDown(textarea, { key: 'Enter', ctrlKey: true })

    expect(sendMock).toHaveBeenCalledWith(ACTIVE_TAB, {
      type: 'permission_response',
      requestId: 'perm-1',
      allowed: true,
      updatedInput: {
        questions: [
          {
            question: 'What context should we restore?',
            options: [{ label: 'Skip' }],
          },
        ],
        answers: {
          'What context should we restore?': 'First restored context line\nSecond restored context line',
        },
      },
    })
  })

  it('renders aborted permission results as terminal instead of asking again', () => {
    useChatStore.setState((state) => ({
      sessions: {
        ...state.sessions,
        [ACTIVE_TAB]: {
          ...state.sessions[ACTIVE_TAB]!,
          pendingPermission: null,
          chatState: 'idle',
        },
      },
    }))

    render(
      <AskUserQuestion
        toolUseId="tool-1"
        input={{
          questions: [
            {
              question: 'Which scope?',
              options: [{ label: 'Single page' }, { label: 'Tabs' }],
            },
          ],
        }}
        result="Tool permission request failed: AbortError"
      />,
    )

    expect(screen.queryByPlaceholderText('Type your answer...')).toBeNull()
    expect(screen.queryByRole('button', { name: /submit/i })).toBeNull()
    expect(screen.getByText(/Tool permission request failed: AbortError/)).toBeTruthy()
  })

  it('does not call an open detached decision completed when it carries a non-terminal response', () => {
    act(() => {
      useChatStore.getState().handleServerMessage(ACTIVE_TAB, {
        type: 'permission_requests_snapshot',
        toolRequestIds: [],
        computerUseRequestIds: [],
        turnActive: true,
        userDecisions: {
          transcriptEvidenceComplete: true,
          decisions: [{
            decisionId: 'tool-open-detached',
            semanticState: { status: 'open' },
            runtimeBinding: { status: 'detached' },
            response: { kind: 'answer', answers: { 'Choose a path?': 'Wait' } },
            input: {
              questions: [{
                question: 'Choose a path?',
                options: [{ label: 'Wait' }, { label: 'Continue' }],
              }],
            },
            inputSource: 'transcript',
            conflicted: false,
          }],
        },
      })
    })

    render(
      <AskUserQuestion
        toolUseId="tool-open-detached"
        input={{ questions: [{ question: 'Wrong fallback?', options: [{ label: 'Wrong' }] }] }}
      />,
    )

    expect(screen.getByText('Choose a path?')).toBeTruthy()
    expect(screen.queryByText('Completed')).toBeNull()
    expect(screen.queryByText('Answered')).toBeNull()
    expect(screen.getByRole('button', { name: /^Wait$/ })).toHaveProperty('disabled', true)
    expect(screen.queryByRole('button', { name: /submit/i })).toBeNull()
  })

  it('keeps a modern OPEN decision actionable after a non-terminal error result', () => {
    publishDecision('tool-open-error', 'Try another path?', ['Retry'])
    act(() => {
      useChatStore.getState().handleServerMessage(ACTIVE_TAB, {
        type: 'tool_result',
        toolUseId: 'tool-open-error',
        content: 'runtime stopped before the answer was applied',
        isError: true,
      })
    })

    render(
      <AskUserQuestion
        toolUseId="tool-open-error"
        input={{}}
        result="runtime stopped"
        hasResult
      />,
    )

    expect(screen.queryByText('Completed')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: /^Retry$/ }))
    expect(screen.getByRole('button', { name: /submit/i })).toHaveProperty('disabled', false)
  })

  it('submits an evidence-complete detached decision through the advertised response protocol', () => {
    publishDecision(
      'tool-detached-submit',
      'Resume the original task?',
      ['Resume', 'Cancel'],
    )

    render(<AskUserQuestion toolUseId="tool-detached-submit" input={{}} />)
    const resumeOption = screen.getByRole('button', { name: /^Resume$/ })
    expect(resumeOption.getAttribute('aria-pressed')).toBe('false')
    fireEvent.click(resumeOption)
    expect(resumeOption.getAttribute('aria-pressed')).toBe('true')
    fireEvent.click(screen.getByRole('button', { name: /submit/i }))

    expect(sendMock).toHaveBeenCalledWith(ACTIVE_TAB, {
      type: 'user_decision_response',
      decisionId: 'tool-detached-submit',
      attemptId: expect.any(String),
      response: {
        kind: 'answer',
        answers: { 'Resume the original task?': 'Resume' },
      },
    })
    expect(screen.queryByRole('button', { name: /retry/i })).toBeNull()
    expect(screen.getByRole('button', { name: /^Resume$/ })).toHaveProperty('disabled', true)
    expect(screen.getByRole('status').textContent).toContain('Loading...')
    expect(screen.getByRole('status').textContent).toContain('Resume')
  })

  it('uses the same response protocol for an attached decision instead of the legacy permission message', () => {
    publishDecision('tool-1', 'Should we persist data?', ['No', 'Yes'], {
      attachedRequestId: 'perm-1',
    })
    render(<AskUserQuestion toolUseId="tool-1" input={{}} />)
    fireEvent.click(screen.getByRole('button', { name: /^Yes$/ }))
    fireEvent.click(screen.getByRole('button', { name: /submit/i }))

    expect(sendMock).toHaveBeenCalledWith(ACTIVE_TAB, expect.objectContaining({
      type: 'user_decision_response',
      decisionId: 'tool-1',
    }))
    expect(sendMock.mock.calls.some(([, message]) =>
      (message as { type?: string }).type === 'permission_response')).toBe(false)
  })

  it('shows a retryable response error and retries the frozen answer under a new attempt id', () => {
    publishDecision('tool-retry-submit', 'Retry the answer?', ['Yes'])
    const rendered = render(<AskUserQuestion toolUseId="tool-retry-submit" input={{}} />)
    fireEvent.click(screen.getByRole('button', { name: /^Yes$/ }))
    fireEvent.click(screen.getByRole('button', { name: /submit/i }))
    const first = sendMock.mock.calls.at(-1)?.[1] as {
      attemptId: string
      response: unknown
    }

    act(() => {
      useChatStore.getState().handleServerMessage(ACTIVE_TAB, {
        type: 'user_decision_response_result',
        decisionId: 'tool-retry-submit',
        attemptId: first.attemptId,
        state: 'retryable_failed',
        error: { code: 'TRY_AGAIN', message: 'Recovery was not started.' },
        nextAction: 'retry_new_attempt',
      } as never)
    })
    expect(screen.getByRole('alert').textContent).toContain('Recovery was not started.')
    rendered.unmount()
    render(<AskUserQuestion toolUseId="tool-retry-submit" input={{}} />)
    expect(screen.getByRole('button', { name: /^Yes$/ })).toHaveProperty('disabled', true)
    expect(screen.getByRole('status').textContent).toContain('Yes')
    fireEvent.click(screen.getByRole('button', { name: /retry/i }))
    const second = sendMock.mock.calls.at(-1)?.[1] as typeof first
    expect(second.attemptId).not.toBe(first.attemptId)
    expect(second.response).toEqual(first.response)
  })

  it('lets the user edit an answer that was explicitly rejected before delivery', () => {
    publishDecision('tool-edit-rejected', 'Choose again?', ['No', 'Yes'])
    render(<AskUserQuestion toolUseId="tool-edit-rejected" input={{}} />)
    fireEvent.click(screen.getByRole('button', { name: /^Yes$/ }))
    fireEvent.click(screen.getByRole('button', { name: /submit/i }))
    const first = sendMock.mock.calls.at(-1)?.[1] as { attemptId: string }

    act(() => {
      useChatStore.getState().handleServerMessage(ACTIVE_TAB, {
        type: 'user_decision_response_result',
        decisionId: 'tool-edit-rejected',
        attemptId: first.attemptId,
        state: 'rejected',
        nextAction: 'edit_response',
        error: {
          code: 'DECISION_RESPONSE_MISMATCH',
          message: 'The questions changed before delivery.',
        },
      } as never)
    })

    expect(screen.getByRole('alert').textContent).toContain('questions changed')
    expect(screen.queryByText('Loading...')).toBeNull()
    expect(screen.getByRole('button', { name: /^No$/ })).toHaveProperty('disabled', false)
    fireEvent.click(screen.getByRole('button', { name: /^No$/ }))
    fireEvent.click(screen.getByRole('button', { name: /submit/i }))
    const second = sendMock.mock.calls.at(-1)?.[1] as {
      attemptId: string
      response: { kind: 'answer'; answers: Record<string, string> }
    }
    expect(second.attemptId).not.toBe(first.attemptId)
    expect(second.response.answers).toEqual({ 'Choose again?': 'No' })
  })

  it('checks indeterminate delivery with the same frozen attempt and response', () => {
    publishDecision('tool-indeterminate', 'Continue carefully?', ['Yes'])
    render(<AskUserQuestion toolUseId="tool-indeterminate" input={{}} />)
    fireEvent.click(screen.getByRole('button', { name: /^Yes$/ }))
    fireEvent.click(screen.getByRole('button', { name: /submit/i }))
    const request = sendMock.mock.calls.at(-1)?.[1] as { attemptId: string }
    act(() => {
      useChatStore.getState().handleServerMessage(ACTIVE_TAB, {
        type: 'user_decision_response_result',
        decisionId: 'tool-indeterminate',
        attemptId: request.attemptId,
        state: 'indeterminate',
        error: { code: 'UNKNOWN', message: 'Delivery outcome is unknown.' },
        nextAction: 'verify_same_attempt',
      } as never)
    })

    expect(screen.getByRole('alert').textContent).toContain('Delivery outcome is unknown.')
    expect(screen.queryByText('Loading...')).toBeNull()
    expect(sendMock.mock.calls.filter(([, message]) =>
      (message as { type?: string }).type === 'user_decision_response')).toHaveLength(1)
    fireEvent.click(screen.getByRole('button', { name: /check delivery/i }))
    const repeated = sendMock.mock.calls.at(-1)?.[1] as typeof request & { response: unknown }
    const original = sendMock.mock.calls.filter(([, message]) =>
      (message as { type?: string }).type === 'user_decision_response')[0]?.[1] as typeof repeated
    expect(repeated.attemptId).toBe(original.attemptId)
    expect(repeated.response).toEqual(original.response)
  })

  it('does not guess a replay policy for a non-editable rejection', () => {
    const decisionId = 'tool-verify-busy'
    publishDecision(decisionId, 'Continue once?', ['Yes'])
    render(<AskUserQuestion toolUseId={decisionId} input={{}} />)
    const option = screen.getByRole('button', { name: /^Yes$/ })
    fireEvent.click(option)
    fireEvent.click(screen.getByRole('button', { name: /submit/i }))
    const original = sendMock.mock.calls.at(-1)?.[1] as {
      decisionId: string
      attemptId: string
      response: unknown
    }
    act(() => {
      useChatStore.getState().handleServerMessage(ACTIVE_TAB, {
        type: 'user_decision_response_result',
        decisionId,
        attemptId: original.attemptId,
        state: 'rejected',
        nextAction: 'blocked',
        error: { code: 'USER_DECISION_DELIVERY_BUSY', message: 'delivery busy' },
      } as never)
    })

    const decisionResponses = sendMock.mock.calls
      .map(([, message]) => message as { type?: string })
      .filter((message) => message.type === 'user_decision_response')
    expect(decisionResponses).toEqual([original])
    expect(screen.queryByRole('button', { name: /retry/i })).toBeNull()
    expect(option).toHaveProperty('disabled', true)
    expect(screen.queryByPlaceholderText('Type your answer...')).toBeNull()
  })

  it('resyncs through reconnect without resubmitting the frozen answer', () => {
    const decisionId = 'tool-resync'
    publishDecision(decisionId, 'Refresh ownership?', ['Yes'])
    render(<AskUserQuestion toolUseId={decisionId} input={{}} />)
    fireEvent.click(screen.getByRole('button', { name: /^Yes$/ }))
    fireEvent.click(screen.getByRole('button', { name: /submit/i }))
    const original = sendMock.mock.calls.at(-1)?.[1] as { attemptId: string }
    act(() => {
      useChatStore.getState().handleServerMessage(ACTIVE_TAB, {
        type: 'user_decision_response_result',
        decisionId,
        attemptId: original.attemptId,
        state: 'rejected',
        error: { code: 'USER_DECISION_DELIVERY_BUSY', message: 'refresh ownership' },
        nextAction: 'resync',
      } as never)
    })
    const sendsBefore = sendMock.mock.calls.filter(([, message]) =>
      (message as { type?: string }).type === 'user_decision_response').length

    fireEvent.click(screen.getByRole('button', { name: /refresh question/i }))

    expect(forceReconnectMock).toHaveBeenCalledWith(ACTIVE_TAB)
    expect(sendMock.mock.calls.filter(([, message]) =>
      (message as { type?: string }).type === 'user_decision_response')).toHaveLength(sendsBefore)
    expect(screen.getByRole('alert').textContent).toContain('refresh ownership')
  })

  it('restores a frozen clarification summary without claiming it was answered', () => {
    publishDecision('tool-clarify-hold', 'Which path?', ['A'])
    act(() => {
      useChatStore.setState((state) => ({
        sessions: {
          ...state.sessions,
          [ACTIVE_TAB]: {
            ...state.sessions[ACTIVE_TAB]!,
            userDecisionResponseAttempts: {
              'tool-clarify-hold': {
                attemptId: 'clarify-attempt',
                response: { kind: 'clarify', message: 'Please explain the tradeoff first.' },
                state: 'rejected',
                nextAction: 'blocked',
                error: { code: 'WAIT', message: 'Waiting for authoritative result.' },
              },
            },
          },
        },
      }))
    })
    render(<AskUserQuestion toolUseId="tool-clarify-hold" input={{}} />)
    expect(screen.getByRole('status').textContent)
      .toContain('Please explain the tradeoff first.')
    expect(screen.getByRole('alert').textContent)
      .toContain('Waiting for authoritative result.')
    expect(screen.queryByText('Answered')).toBeNull()
  })

  it('submits a modern OPEN decision and lets the server fresh-check incomplete evidence', () => {
    publishDecision('tool-incomplete-detached', 'Is history complete?', ['No'], {
      evidenceComplete: false,
    })
    render(<AskUserQuestion toolUseId="tool-incomplete-detached" input={{}} />)
    fireEvent.click(screen.getByRole('button', { name: /^No$/ }))
    fireEvent.click(screen.getByRole('button', { name: /submit/i }))
    expect(sendMock).toHaveBeenCalledWith(ACTIVE_TAB, expect.objectContaining({
      type: 'user_decision_response',
      decisionId: 'tool-incomplete-detached',
      response: { kind: 'answer', answers: { 'Is history complete?': 'No' } },
    }))
  })

  it('does not call a missing decision completed while transcript evidence is incomplete', () => {
    act(() => {
      useChatStore.getState().handleServerMessage(ACTIVE_TAB, {
        type: 'permission_requests_snapshot',
        toolRequestIds: [],
        computerUseRequestIds: [],
        turnActive: false,
        userDecisions: {
          transcriptEvidenceComplete: false,
          decisions: [],
        },
      })
    })

    render(
      <AskUserQuestion
        toolUseId="tool-not-yet-projected"
        input={{
          questions: [{
            question: 'Was this history fully inspected?',
            options: [{ label: 'Not yet' }],
          }],
        }}
      />,
    )

    expect(screen.getByText('Was this history fully inspected?')).toBeTruthy()
    expect(screen.queryByText('Completed')).toBeNull()
    expect(screen.queryByText('Answered')).toBeNull()
    expect(screen.getByRole('button', { name: /^Not yet$/ })).toHaveProperty('disabled', true)
    expect(screen.queryByRole('button', { name: /submit/i })).toBeNull()
  })

  it('submits a transcript Ask omitted from an incomplete modern snapshot', () => {
    act(() => {
      useChatStore.setState((state) => ({
        sessions: {
          ...state.sessions,
          [ACTIVE_TAB]: {
            ...state.sessions[ACTIVE_TAB]!,
            messages: [{
              id: 'tool-provisional-transcript-message',
              type: 'tool_use',
              toolName: 'AskUserQuestion',
              toolUseId: 'tool-provisional-transcript',
              input: {
                questions: [{ question: 'Continue?', options: [{ label: 'Yes' }] }],
              },
              timestamp: 1,
            }],
          },
        },
      }))
      useChatStore.getState().handleServerMessage(ACTIVE_TAB, {
        type: 'permission_requests_snapshot',
        toolRequestIds: [],
        computerUseRequestIds: [],
        turnActive: true,
        userDecisions: {
          transcriptEvidenceComplete: false,
          userDecisionResponseProtocol: 'orphaned-permission-v1',
          decisions: [],
        },
      } as never)
    })
    render(
      <AskUserQuestion
        toolUseId="tool-provisional-transcript"
        input={{ questions: [{ question: 'Continue?', options: [{ label: 'Yes' }] }] }}
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: /^Yes$/ }))
    fireEvent.click(screen.getByRole('button', { name: /submit/i }))
    expect(sendMock).toHaveBeenCalledWith(ACTIVE_TAB, expect.objectContaining({
      type: 'user_decision_response',
      decisionId: 'tool-provisional-transcript',
    }))
  })

  it.each([false, true])(
    'does not call an omitted modern Ask completed after an error result (evidenceComplete=%s)',
    (transcriptEvidenceComplete) => {
      const decisionId = `tool-omitted-error-${transcriptEvidenceComplete}`
      act(() => {
        useChatStore.setState((state) => ({
          sessions: {
            ...state.sessions,
            [ACTIVE_TAB]: {
              ...state.sessions[ACTIVE_TAB]!,
              messages: [
                {
                  id: `message-${decisionId}`,
                  type: 'tool_use',
                  toolName: 'AskUserQuestion',
                  toolUseId: decisionId,
                  input: {
                    questions: [{ question: 'Continue?', options: [{ label: 'Yes' }] }],
                  },
                  timestamp: 1,
                },
                {
                  id: `result-${decisionId}`,
                  type: 'tool_result',
                  toolUseId: decisionId,
                  content: 'runtime failed before applying the answer',
                  isError: true,
                  timestamp: 2,
                },
              ],
            },
          },
        }))
        useChatStore.getState().handleServerMessage(ACTIVE_TAB, {
          type: 'permission_requests_snapshot',
          toolRequestIds: [],
          computerUseRequestIds: [],
          turnActive: true,
          userDecisions: {
            transcriptEvidenceComplete,
            userDecisionResponseProtocol: 'orphaned-permission-v1',
            decisions: [],
          },
        } as never)
      })

      render(
        <AskUserQuestion
          toolUseId={decisionId}
          input={{ questions: [{ question: 'Continue?', options: [{ label: 'Yes' }] }] }}
          result="runtime failed before applying the answer"
          hasResult
        />,
      )

      expect(screen.queryByText('Completed')).toBeNull()
      expect(screen.queryByText('Answered')).toBeNull()
      expect(screen.queryByRole('button', { name: /submit/i })).toBeNull()
    },
  )

  describe('chat about this', () => {
    const SCOPE_INPUT = {
      questions: [
        {
          question: 'Which scope?',
          options: [{ label: 'Single page' }, { label: 'Tabs' }],
        },
      ],
    }

    // The whole point of the button: you reach for it precisely when none of
    // the options fit, which is when nothing is selected. Gating it on
    // `allAnswered` like Submit would make it unreachable in its own use case.
    it('stays enabled with nothing selected, unlike submit', () => {
      render(<AskUserQuestion toolUseId="tool-1" input={SCOPE_INPUT} />)

      expect(screen.getByRole('button', { name: /submit/i })).toHaveProperty('disabled', true)
      expect(screen.getByRole('button', { name: /chat about this/i })).toHaveProperty(
        'disabled',
        false,
      )
    })

    it('denies the permission so the text reaches the model, rather than answering', () => {
      render(<AskUserQuestion toolUseId="tool-1" input={SCOPE_INPUT} />)

      fireEvent.click(screen.getByRole('button', { name: /chat about this/i }))

      expect(sendMock).toHaveBeenCalledWith(ACTIVE_TAB, {
        type: 'permission_response',
        requestId: 'perm-1',
        allowed: false,
        denyMessage: '- "Which scope?"\n  (No answer provided)',
      })
    })

    it('carries answers already filled in so the handoff does not discard them', () => {
      render(<AskUserQuestion toolUseId="tool-1" input={SCOPE_INPUT} />)

      fireEvent.click(screen.getByRole('button', { name: /^Tabs$/ }))
      fireEvent.click(screen.getByRole('button', { name: /chat about this/i }))

      expect(sendMock).toHaveBeenCalledWith(ACTIVE_TAB, {
        type: 'permission_response',
        requestId: 'perm-1',
        allowed: false,
        denyMessage: '- "Which scope?"\n  Answer: Tabs',
      })
    })

    it('does not report the handoff as accepted while the response is only submitting', () => {
      render(<AskUserQuestion toolUseId="tool-1" input={SCOPE_INPUT} />)

      fireEvent.click(screen.getByRole('button', { name: /^Tabs$/ }))
      fireEvent.click(screen.getByRole('button', { name: /chat about this/i }))

      expect(screen.queryByText(/Handed back to Claude/)).toBeNull()
      expect(screen.queryByText(/Answered:/)).toBeNull()
      expect(screen.queryByRole('button', { name: /chat about this/i })).toBeNull()
    })

    // Regression: the status badge is rendered from its own branch, so it kept
    // reading "Answered" after a handoff even while the body said otherwise.
    it('does not badge a submitting handoff as answered or handed off', () => {
      render(<AskUserQuestion toolUseId="tool-1" input={SCOPE_INPUT} />)

      fireEvent.click(screen.getByRole('button', { name: /^Tabs$/ }))
      fireEvent.click(screen.getByRole('button', { name: /chat about this/i }))

      expect(screen.queryByText('Handed off')).toBeNull()
      expect(screen.queryByText('Answered')).toBeNull()
    })

    it('reports the handoff only after a terminal tool result arrives', () => {
      const { rerender } = render(
        <AskUserQuestion toolUseId="tool-1" input={SCOPE_INPUT} />,
      )

      fireEvent.click(screen.getByRole('button', { name: /chat about this/i }))
      expect(screen.queryByText(/Handed back to Claude/)).toBeNull()

      rerender(
        <AskUserQuestion
          toolUseId="tool-1"
          input={SCOPE_INPUT}
          result="Continue by asking the user for clarification."
        />,
      )

      expect(screen.queryByText(/Handed back to Claude/)).toBeNull()
      act(() => {
        useChatStore.getState().handleServerMessage(ACTIVE_TAB, {
          type: 'permission_resolved',
          requestId: 'perm-1',
          permissionType: 'tool',
          allowed: false,
        })
      })

      expect(screen.getByText('Handed off')).toBeTruthy()
      expect(screen.getByText(/Handed back to Claude/)).toBeTruthy()
      expect(screen.queryByText('Answered')).toBeNull()
    })

    it('does not carry a failed handoff intent into a later successful answer', () => {
      const { rerender } = render(
        <AskUserQuestion toolUseId="tool-1" input={SCOPE_INPUT} />,
      )
      fireEvent.click(screen.getByRole('button', { name: /chat about this/i }))
      act(() => {
        useChatStore.getState().handleServerMessage(ACTIVE_TAB, {
          type: 'permission_response_failed',
          requestId: 'perm-1',
          permissionType: 'tool',
          code: 'PERMISSION_DELIVERY_FAILED',
          retryable: true,
          message: 'delivery failed',
        })
      })
      fireEvent.click(screen.getByRole('button', { name: /^Tabs$/ }))
      fireEvent.click(screen.getByRole('button', { name: /submit/i }))
      rerender(
        <AskUserQuestion
          toolUseId="tool-1"
          input={SCOPE_INPUT}
          result={{ answers: { 'Which scope?': 'Tabs' } }}
        />,
      )
      act(() => {
        useChatStore.getState().handleServerMessage(ACTIVE_TAB, {
          type: 'permission_resolved',
          requestId: 'perm-1',
          permissionType: 'tool',
          allowed: true,
        })
      })

      expect(screen.getByText('Answered')).toBeTruthy()
      expect(screen.queryByText('Handed off')).toBeNull()
    })

    it('ignores a second click once the handoff is sent', () => {
      render(<AskUserQuestion toolUseId="tool-1" input={SCOPE_INPUT} />)

      const chatButton = screen.getByRole('button', { name: /chat about this/i })
      fireEvent.click(chatButton)
      fireEvent.click(chatButton)

      expect(sendMock).toHaveBeenCalledTimes(1)
    })
  })
})
