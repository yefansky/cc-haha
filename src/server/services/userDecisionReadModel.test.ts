import { describe, expect, test } from 'bun:test'
import type { PendingPermissionRequest } from './conversationService.js'
import type { MessageEntry } from './sessionService.js'
import { projectUserDecisions } from './userDecisionReadModel.js'
import {
  ASK_USER_QUESTION_CLARIFY_MESSAGE,
  ASK_USER_QUESTION_CLARIFY_WITH_QUESTIONS_PREFIX,
} from '../../constants/messages.js'

const SESSION_ID = 'session-1'

function askMessage(
  toolUseId: string,
  question = 'Ship it?',
  originalToolUseId?: string,
): MessageEntry {
  return {
    id: `assistant-${toolUseId}`,
    type: 'tool_use',
    timestamp: '2026-08-28T00:00:00.000Z',
    content: [{
      type: 'tool_use',
      name: 'AskUserQuestion',
      id: toolUseId,
      ...(originalToolUseId ? { original_tool_use_id: originalToolUseId } : {}),
      input: {
        questions: [{
          question,
          options: [{ label: 'Yes' }, { label: 'No' }],
        }],
      },
    }],
  }
}

function resultMessage(
  toolUseId: string,
  options: {
    isError?: boolean
    content?: unknown
    toolUseResult?: unknown
  } = {},
): MessageEntry {
  return {
    id: `result-${toolUseId}`,
    type: 'tool_result',
    timestamp: '2026-08-28T00:00:01.000Z',
    content: [{
      type: 'tool_result',
      tool_use_id: toolUseId,
      content: options.content ?? 'done',
      ...(options.isError ? { is_error: true } : {}),
    }],
    ...(options.toolUseResult === undefined
      ? {}
      : { toolUseResult: options.toolUseResult }),
  }
}

function pendingAsk(
  requestId: string,
  toolUseId?: string,
  question = 'Ship it?',
): PendingPermissionRequest {
  return {
    requestId,
    toolName: 'AskUserQuestion',
    ...(toolUseId ? { toolUseId } : {}),
    input: {
      questions: [{
        question,
        options: [{ label: 'Yes' }, { label: 'No' }],
      }],
    },
  }
}

describe('projectUserDecisions', () => {
  test('joins a transcript question to its live callback by exact toolUseId', () => {
    const snapshot = projectUserDecisions({
      sessionId: SESSION_ID,
      messages: [askMessage('ask-1')],
      pendingRequests: [pendingAsk('request-1', 'ask-1')],
      transcriptEvidenceComplete: true,
    })

    expect(snapshot).toMatchObject({
      sessionId: SESSION_ID,
      transcriptEvidenceComplete: true,
      decisions: [{
        inputSource: 'transcript',
        decision: {
          decisionId: 'ask-1',
          semanticState: { status: 'open' },
          runtimeBinding: { status: 'attached', requestId: 'request-1' },
        },
      }],
    })
  })

  test('creates a live-only decision before the streamed tool block arrives', () => {
    const snapshot = projectUserDecisions({
      sessionId: SESSION_ID,
      messages: [],
      pendingRequests: [pendingAsk('request-live', 'ask-live', 'Choose scope?')],
      transcriptEvidenceComplete: true,
    })

    expect(snapshot.decisions).toEqual([expect.objectContaining({
      inputSource: 'live',
      input: expect.objectContaining({
        questions: [expect.objectContaining({ question: 'Choose scope?' })],
      }),
      decision: expect.objectContaining({
        decisionId: 'ask-live',
        semanticState: { status: 'open' },
        runtimeBinding: { status: 'attached', requestId: 'request-live' },
      }),
    })])
  })

  test('lets a successful structured result win over a stale live request', () => {
    const snapshot = projectUserDecisions({
      sessionId: SESSION_ID,
      messages: [
        askMessage('ask-answered', 'Pick one?'),
        resultMessage('ask-answered', {
          content: 'User has answered your questions.',
          toolUseResult: {
            questions: [{ question: 'Pick one?' }],
            answers: { 'Pick one?': 'A' },
          },
        }),
      ],
      pendingRequests: [pendingAsk('request-stale', 'ask-answered', 'Pick one?')],
      transcriptEvidenceComplete: true,
    })

    expect(snapshot.decisions[0]?.decision).toMatchObject({
      response: { kind: 'answer', answers: { 'Pick one?': 'A' } },
      semanticState: { status: 'answered' },
      runtimeBinding: { status: 'detached' },
    })
  })

  test('hydrates an unknown successful result as answered without inventing a response', () => {
    const snapshot = projectUserDecisions({
      sessionId: SESSION_ID,
      messages: [
        askMessage('ask-clarify'),
        resultMessage('ask-clarify', { content: 'Please clarify the constraints.' }),
      ],
      pendingRequests: [],
      transcriptEvidenceComplete: true,
    })

    expect(snapshot.decisions[0]?.decision).toMatchObject({
      response: null,
      semanticState: { status: 'answered' },
      runtimeBinding: { status: 'detached' },
    })
  })

  test('recognizes the shared clarification evidence even when the tool result is an error', () => {
    const clarifyText = `${ASK_USER_QUESTION_CLARIFY_WITH_QUESTIONS_PREFIX}- "Ship it?"\n  (No answer provided)`
    const snapshot = projectUserDecisions({
      sessionId: SESSION_ID,
      messages: [
        askMessage('ask-clarify-error'),
        resultMessage('ask-clarify-error', { isError: true, content: clarifyText }),
      ],
      pendingRequests: [pendingAsk('request-clarify-error', 'ask-clarify-error')],
      transcriptEvidenceComplete: true,
    })

    expect(snapshot.decisions[0]?.decision).toMatchObject({
      response: { kind: 'clarify', message: clarifyText },
      semanticState: { status: 'answered' },
      runtimeBinding: { status: 'detached' },
    })

    const exactSnapshot = projectUserDecisions({
      sessionId: SESSION_ID,
      messages: [
        askMessage('ask-clarify-exact'),
        resultMessage('ask-clarify-exact', {
          isError: true,
          content: ASK_USER_QUESTION_CLARIFY_MESSAGE,
        }),
      ],
      pendingRequests: [],
      transcriptEvidenceComplete: true,
    })
    expect(exactSnapshot.decisions[0]?.decision.semanticState).toEqual({ status: 'answered' })
  })

  test('does not misreport an errored tool result as a user answer', () => {
    const snapshot = projectUserDecisions({
      sessionId: SESSION_ID,
      messages: [
        askMessage('ask-error'),
        resultMessage('ask-error', { isError: true, content: 'Tool failed' }),
      ],
      pendingRequests: [pendingAsk('request-error', 'ask-error')],
      transcriptEvidenceComplete: true,
    })

    expect(snapshot.decisions[0]?.decision).toMatchObject({
      response: null,
      semanticState: { status: 'open' },
      runtimeBinding: { status: 'detached' },
    })
  })

  test('joins an unscoped live binding only when one transcript candidate names it', () => {
    const snapshot = projectUserDecisions({
      sessionId: SESSION_ID,
      messages: [askMessage('parent/ask-unique', 'Nested?', 'ask-unique')],
      pendingRequests: [pendingAsk('request-unique', 'ask-unique', 'Nested?')],
      transcriptEvidenceComplete: true,
    })

    expect(snapshot.decisions).toHaveLength(1)
    expect(snapshot.decisions[0]?.decision).toMatchObject({
      decisionId: 'parent/ask-unique',
      runtimeBinding: { status: 'attached', requestId: 'request-unique' },
    })
  })

  test('fails closed when exact and scoped transcript identities both match one pending id', () => {
    const snapshot = projectUserDecisions({
      sessionId: SESSION_ID,
      messages: [
        askMessage('ask-collision', 'Exact?'),
        askMessage('parent/ask-collision', 'Scoped?', 'ask-collision'),
      ],
      pendingRequests: [pendingAsk('request-collision', 'ask-collision')],
      transcriptEvidenceComplete: true,
    })

    expect(snapshot.decisions.map(({ decision }) => decision.runtimeBinding)).toEqual([
      { status: 'detached' },
      { status: 'detached' },
    ])
  })

  test('keeps multiple questions isolated and rejects ambiguous scoped identities', () => {
    const snapshot = projectUserDecisions({
      sessionId: SESSION_ID,
      messages: [
        askMessage('parent-a/ask-1', 'Nested A?', 'ask-1'),
        askMessage('parent-b/ask-1', 'Nested B?', 'ask-1'),
        askMessage('ask-2', 'Root?'),
        resultMessage('parent-a/ask-1', {
          toolUseResult: {
            questions: [{ question: 'Nested A?' }],
            answers: { 'Nested A?': 'Yes' },
          },
        }),
      ],
      pendingRequests: [
        pendingAsk('request-raw', 'ask-1', 'Nested?'),
        pendingAsk('request-root', 'ask-2', 'Root?'),
      ],
      transcriptEvidenceComplete: false,
    })

    expect(snapshot.transcriptEvidenceComplete).toBe(false)
    expect(snapshot.decisions.map(({ decision }) => decision.decisionId)).toEqual([
      'parent-a/ask-1',
      'parent-b/ask-1',
      'ask-2',
    ])
    expect(snapshot.decisions.map(({ decision }) => ({
      id: decision.decisionId,
      state: decision.semanticState.status,
      binding: decision.runtimeBinding,
    }))).toEqual([
      { id: 'parent-a/ask-1', state: 'answered', binding: { status: 'detached' } },
      { id: 'parent-b/ask-1', state: 'open', binding: { status: 'detached' } },
      { id: 'ask-2', state: 'open', binding: { status: 'attached', requestId: 'request-root' } },
    ])
  })

  test('ignores ordinary permissions and Ask requests without a stable toolUseId', () => {
    const ordinary: PendingPermissionRequest = {
      requestId: 'request-bash',
      toolName: 'Bash',
      toolUseId: 'bash-1',
      input: { command: 'pwd' },
    }
    const snapshot = projectUserDecisions({
      sessionId: SESSION_ID,
      messages: [],
      pendingRequests: [ordinary, pendingAsk('request-missing-id')],
      transcriptEvidenceComplete: true,
    })

    expect(snapshot.decisions).toEqual([])
  })

  test('fails closed when one decision has multiple pending requests', () => {
    const snapshot = projectUserDecisions({
      sessionId: SESSION_ID,
      messages: [askMessage('ask-reissued'), askMessage('ask-other')],
      pendingRequests: [
        pendingAsk('request-old', 'ask-reissued'),
        pendingAsk('request-other', 'ask-other'),
        pendingAsk('request-new', 'ask-reissued'),
      ],
      transcriptEvidenceComplete: true,
    })

    expect(snapshot.decisions.map(({ decision }) => decision.runtimeBinding)).toEqual([
      { status: 'detached' },
      { status: 'attached', requestId: 'request-other' },
    ])
  })

  test('does not create a live-only decision from multiple conflicting pending inputs', () => {
    const snapshot = projectUserDecisions({
      sessionId: SESSION_ID,
      messages: [],
      pendingRequests: [
        pendingAsk('request-live-a', 'ask-live-conflict', 'First live prompt?'),
        pendingAsk('request-live-b', 'ask-live-conflict', 'Second live prompt?'),
      ],
      transcriptEvidenceComplete: true,
    })

    expect(snapshot.decisions).toEqual([])
  })

  test('preserves the first prompt but detaches duplicate tool_use ids with two aliases', () => {
    const snapshot = projectUserDecisions({
      sessionId: SESSION_ID,
      messages: [
        askMessage('parent/ask-duplicate', 'First prompt?', 'ask-original-a'),
        askMessage('parent/ask-duplicate', 'Replacement prompt?', 'ask-original-b'),
      ],
      pendingRequests: [pendingAsk('request-alias-b', 'ask-original-b')],
      transcriptEvidenceComplete: true,
    })

    expect(snapshot.decisions).toHaveLength(1)
    expect(snapshot.decisions[0]).toMatchObject({
      input: {
        questions: [expect.objectContaining({ question: 'First prompt?' })],
      },
      decision: {
        decisionId: 'parent/ask-duplicate',
        runtimeBinding: { status: 'detached' },
      },
      conflicted: true,
    })
  })

  test('detaches duplicate tool_use evidence with one alias but conflicting inputs', () => {
    const snapshot = projectUserDecisions({
      sessionId: SESSION_ID,
      messages: [
        askMessage('parent/ask-input-conflict', 'First prompt?', 'ask-input-conflict'),
        askMessage('parent/ask-input-conflict', 'Second prompt?', 'ask-input-conflict'),
      ],
      pendingRequests: [pendingAsk('request-input-conflict', 'ask-input-conflict')],
      transcriptEvidenceComplete: true,
    })

    expect(snapshot.decisions).toHaveLength(1)
    expect(snapshot.decisions[0]).toMatchObject({
      conflicted: true,
      input: {
        questions: [expect.objectContaining({ question: 'First prompt?' })],
      },
      decision: {
        runtimeBinding: { status: 'detached' },
      },
    })
  })

  test('does not let two alias pending groups overwrite one conflicted decision', () => {
    const snapshot = projectUserDecisions({
      sessionId: SESSION_ID,
      messages: [
        askMessage('parent/ask-two-aliases', 'Same prompt?', 'ask-alias-a'),
        askMessage('parent/ask-two-aliases', 'Same prompt?', 'ask-alias-b'),
      ],
      pendingRequests: [
        pendingAsk('request-alias-a', 'ask-alias-a'),
        pendingAsk('request-alias-b', 'ask-alias-b'),
      ],
      transcriptEvidenceComplete: true,
    })

    expect(snapshot.decisions).toHaveLength(1)
    expect(snapshot.decisions[0]).toMatchObject({
      conflicted: true,
      decision: {
        runtimeBinding: { status: 'detached' },
      },
    })
  })

  test('does not spread message-level answer metadata across multiple result blocks', () => {
    const multiResult: MessageEntry = {
      id: 'result-multiple',
      type: 'tool_result',
      timestamp: '2026-08-28T00:00:01.000Z',
      content: [
        { type: 'tool_result', tool_use_id: 'ask-multi-1', content: 'first done' },
        { type: 'tool_result', tool_use_id: 'ask-multi-2', content: 'second done' },
      ],
      toolUseResult: {
        questions: [{ question: 'First?' }],
        answers: { 'First?': 'Yes' },
      },
    }
    const snapshot = projectUserDecisions({
      sessionId: SESSION_ID,
      messages: [
        askMessage('ask-multi-1', 'First?'),
        askMessage('ask-multi-2', 'Second?'),
        multiResult,
      ],
      pendingRequests: [],
      transcriptEvidenceComplete: true,
    })

    expect(snapshot.decisions.map(({ decision }) => ({
      state: decision.semanticState,
      response: decision.response,
    }))).toEqual([
      { state: { status: 'answered' }, response: null },
      { state: { status: 'answered' }, response: null },
    ])
  })

  test('keeps the first terminal response when late result events arrive', () => {
    const snapshot = projectUserDecisions({
      sessionId: SESSION_ID,
      messages: [
        askMessage('ask-terminal', 'Pick one?'),
        resultMessage('ask-terminal', {
          toolUseResult: {
            questions: [{ question: 'Pick one?' }],
            answers: { 'Pick one?': 'A' },
          },
        }),
        resultMessage('ask-terminal', { isError: true, content: 'late failure' }),
        resultMessage('ask-terminal', {
          toolUseResult: {
            questions: [{ question: 'Pick one?' }],
            answers: { 'Pick one?': 'B' },
          },
        }),
      ],
      pendingRequests: [pendingAsk('request-terminal', 'ask-terminal')],
      transcriptEvidenceComplete: true,
    })

    expect(snapshot.decisions[0]?.decision).toMatchObject({
      semanticState: { status: 'answered' },
      response: { kind: 'answer', answers: { 'Pick one?': 'A' } },
      runtimeBinding: { status: 'detached' },
    })
  })
})
