import { afterEach, describe, expect, mock, spyOn, test } from 'bun:test'
import type { ServerWebSocket } from 'bun'
import { conversationService } from '../services/conversationService.js'
import { sessionService } from '../services/sessionService.js'
import { SettingsService } from '../services/settingsService.js'
import {
  __enqueueRuntimeTransitionForTests,
  __markActiveCliRunForTests,
  __markActiveTurnForTests,
  __resetWebSocketHandlerStateForTests,
  closeSessionConnection,
  handleWebSocket,
  type WebSocketData,
} from './handler.js'

function socket(sessionId: string) {
  const sent: string[] = []
  return {
    data: {
      sessionId,
      connectedAt: Date.now(),
      channel: 'client',
      clientKind: 'full',
      sdkToken: null,
      serverPort: 0,
      serverHost: '127.0.0.1',
    },
    send: mock((payload: string) => sent.push(payload)),
    close: mock(() => {}),
    sent,
  } as unknown as ServerWebSocket<WebSocketData> & { sent: string[] }
}

function askMessage(toolUseId: string) {
  return {
    id: `ask-${toolUseId}`,
    type: 'tool_use' as const,
    timestamp: '2026-08-28T00:00:00.000Z',
    content: [{
      type: 'tool_use',
      id: toolUseId,
      name: 'AskUserQuestion',
      input: {
        questions: [
          { question: 'Ship?', options: [{ label: 'Yes' }] },
          { question: 'Notify?', options: [{ label: 'No' }] },
        ],
      },
    }],
  }
}

function installAttachedEvidence(sessionId: string, toolUseId: string) {
  spyOn(sessionService, 'getSessionMessagesWithEvidence').mockResolvedValue({
    messages: [askMessage(toolUseId)],
    transcriptEvidenceComplete: true,
  })
  spyOn(conversationService, 'getPendingPermissionRequests').mockReturnValue([{
    requestId: `request-${sessionId}`,
    toolName: 'AskUserQuestion',
    toolUseId,
    input: askMessage(toolUseId).content[0]!.input,
  }])
}

function installDetachedRuntimePreparation() {
  spyOn(conversationService, 'getPendingPermissionRequests').mockReturnValue([])
  spyOn(sessionService, 'getSessionWorkDir').mockResolvedValue('G:\\recovery-workdir')
  spyOn(sessionService, 'getSessionLaunchInfo').mockResolvedValue({
    filePath: 'G:\\session.jsonl',
    projectDir: 'G:\\',
    workDir: 'G:\\recovery-workdir',
    transcriptMessageCount: 1,
    customTitle: null,
    runtimeModelId: 'test-model',
    runtimeProviderId: null,
    permissionMode: 'default',
  })
  spyOn(SettingsService.prototype, 'getUserSettings').mockResolvedValue({} as any)
  spyOn(conversationService, 'onOutput').mockImplementation(() => {})
}

async function submitAndDrain(
  ws: ReturnType<typeof socket>,
  message: Record<string, unknown>,
): Promise<Record<string, unknown>[]> {
  handleWebSocket.message(ws, JSON.stringify(message))
  await __enqueueRuntimeTransitionForTests(ws.data.sessionId, async () => {})
  return ws.sent.map((payload) => JSON.parse(payload) as Record<string, unknown>)
}

describe('user_decision_response websocket route', () => {
  afterEach(() => {
    __resetWebSocketHandlerStateForTests()
    mock.restore()
  })

  test('delivers a complete attached Ask through its tracked callback without stopping runtime', async () => {
    const sessionId = `decision-attached-${crypto.randomUUID()}`
    const toolUseId = 'ask-attached'
    const ws = socket(sessionId)
    installAttachedEvidence(sessionId, toolUseId)
    const respond = spyOn(conversationService, 'respondToTrackedPermission').mockReturnValue({
      status: 'accepted',
      transport: 'sent',
    })
    const stop = spyOn(conversationService, 'stopSessionForReplacementAndConfirm')

    const messages = await submitAndDrain(ws, {
      type: 'user_decision_response',
      decisionId: toolUseId,
      attemptId: 'attempt-attached',
      response: {
        kind: 'answer',
        answers: { 'Ship?': 'Yes', 'Notify?': 'No' },
      },
    })

    expect(respond).toHaveBeenCalledWith(
      sessionId,
      `request-${sessionId}`,
      true,
      undefined,
      expect.objectContaining({ answers: { 'Ship?': 'Yes', 'Notify?': 'No' } }),
      undefined,
    )
    expect(stop).not.toHaveBeenCalled()
    expect(messages).toContainEqual(expect.objectContaining({
      type: 'user_decision_response_result',
      state: 'accepted',
      route: 'runtime_callback',
    }))
  })

  test('rejects an incomplete answer before claiming or invoking the callback', async () => {
    const sessionId = `decision-incomplete-${crypto.randomUUID()}`
    const toolUseId = 'ask-incomplete'
    const ws = socket(sessionId)
    installAttachedEvidence(sessionId, toolUseId)
    const respond = spyOn(conversationService, 'respondToTrackedPermission')

    const messages = await submitAndDrain(ws, {
      type: 'user_decision_response',
      decisionId: toolUseId,
      attemptId: 'attempt-incomplete',
      response: { kind: 'answer', answers: { 'Ship?': 'Yes' } },
    })

    expect(respond).not.toHaveBeenCalled()
    expect(messages).toContainEqual(expect.objectContaining({
      state: 'rejected',
      error: expect.objectContaining({ code: 'DECISION_RESPONSE_MISMATCH' }),
    }))
  })

  test('redacts uncertain transport detail and keeps later attempts busy without stopping runtime', async () => {
    const sessionId = `decision-indeterminate-${crypto.randomUUID()}`
    const toolUseId = 'ask-indeterminate'
    const ws = socket(sessionId)
    installAttachedEvidence(sessionId, toolUseId)
    const respond = spyOn(conversationService, 'respondToTrackedPermission').mockReturnValue({
      status: 'delivery_failed',
      error: 'private socket and filesystem detail',
    })
    const stop = spyOn(conversationService, 'stopSessionForReplacementAndConfirm')
    const response = { kind: 'answer', answers: { 'Ship?': 'Yes', 'Notify?': 'No' } }

    await submitAndDrain(ws, {
      type: 'user_decision_response',
      decisionId: toolUseId,
      attemptId: 'attempt-unknown',
      response,
    })
    const messages = await submitAndDrain(ws, {
      type: 'user_decision_response',
      decisionId: toolUseId,
      attemptId: 'attempt-later',
      response,
    })

    expect(respond).toHaveBeenCalledTimes(1)
    expect(stop).not.toHaveBeenCalled()
    expect(JSON.stringify(messages)).not.toContain('private socket')
    expect(messages).toContainEqual(expect.objectContaining({
      attemptId: 'attempt-later',
      state: 'rejected',
      error: expect.objectContaining({ code: 'USER_DECISION_DELIVERY_BUSY' }),
    }))
  })

  test('does not stop a detached session while newer foreground work is active', async () => {
    const sessionId = `decision-busy-runtime-${crypto.randomUUID()}`
    const toolUseId = 'ask-detached-busy'
    const ws = socket(sessionId)
    spyOn(sessionService, 'getSessionMessagesWithEvidence').mockResolvedValue({
      messages: [askMessage(toolUseId)],
      transcriptEvidenceComplete: true,
    })
    spyOn(conversationService, 'getPendingPermissionRequests').mockReturnValue([])
    const stop = spyOn(conversationService, 'stopSessionForReplacementAndConfirm')
    __markActiveCliRunForTests(sessionId)

    const messages = await submitAndDrain(ws, {
      type: 'user_decision_response',
      decisionId: toolUseId,
      attemptId: 'attempt-busy-runtime',
      response: {
        kind: 'answer',
        answers: { 'Ship?': 'Yes', 'Notify?': 'No' },
      },
    })

    expect(stop).not.toHaveBeenCalled()
    expect(messages).toContainEqual(expect.objectContaining({
      state: 'retryable_failed',
      error: expect.objectContaining({ code: 'SESSION_RUNTIME_BUSY' }),
    }))
  })

  test('rechecks resumed CLI work that appears while recovery settings are loading', async () => {
    const sessionId = `decision-late-busy-${crypto.randomUUID()}`
    const toolUseId = 'ask-late-busy'
    const ws = socket(sessionId)
    let resolveLaunch!: (value: any) => void
    const launch = new Promise<any>((resolve) => { resolveLaunch = resolve })
    spyOn(sessionService, 'getSessionMessagesWithEvidence').mockResolvedValue({
      messages: [askMessage(toolUseId)],
      transcriptEvidenceComplete: true,
    })
    spyOn(conversationService, 'getPendingPermissionRequests').mockReturnValue([])
    spyOn(sessionService, 'getSessionWorkDir').mockResolvedValue('G:\\recovery-workdir')
    spyOn(sessionService, 'getSessionLaunchInfo').mockReturnValue(launch)
    spyOn(SettingsService.prototype, 'getUserSettings').mockResolvedValue({} as any)
    const stop = spyOn(conversationService, 'stopSessionForReplacementAndConfirm')

    handleWebSocket.message(ws, JSON.stringify({
      type: 'user_decision_response',
      decisionId: toolUseId,
      attemptId: 'attempt-late-busy',
      response: {
        kind: 'answer',
        answers: { 'Ship?': 'Yes', 'Notify?': 'No' },
      },
    }))
    await Promise.resolve()
    await Promise.resolve()
    __markActiveCliRunForTests(sessionId)
    resolveLaunch({
      workDir: 'G:\\recovery-workdir',
      runtimeModelId: 'test-model',
      runtimeProviderId: null,
      permissionMode: 'default',
    })
    await __enqueueRuntimeTransitionForTests(sessionId, async () => {})

    expect(stop).not.toHaveBeenCalled()
    expect(ws.sent.map((payload) => JSON.parse(payload))).toContainEqual(
      expect.objectContaining({
        state: 'retryable_failed',
        error: expect.objectContaining({ code: 'SESSION_RUNTIME_BUSY' }),
      }),
    )
  })

  test('runs detached recovery once in stop, reread, start, orphan order', async () => {
    const sessionId = `decision-detached-success-${crypto.randomUUID()}`
    const toolUseId = 'ask-detached-success'
    const ws = socket(sessionId)
    const order: string[] = []
    let reads = 0
    installDetachedRuntimePreparation()
    spyOn(sessionService, 'getSessionMessagesWithEvidence').mockImplementation(async () => {
      reads += 1
      order.push(`read-${reads}`)
      return { messages: [askMessage(toolUseId)], transcriptEvidenceComplete: true }
    })
    spyOn(conversationService, 'stopSessionForReplacementAndConfirm').mockImplementation(
      async () => { order.push('stop'); return 'stopped' },
    )
    const start = spyOn(conversationService, 'startSession').mockImplementation(
      async () => { order.push('start') },
    )
    const orphan = spyOn(conversationService, 'respondToOrphanedPermission').mockImplementation(
      () => { order.push('orphan'); return { status: 'accepted', transport: 'sent' } },
    )

    const messages = await submitAndDrain(ws, {
      type: 'user_decision_response',
      decisionId: toolUseId,
      attemptId: 'attempt-detached-success',
      response: {
        kind: 'answer',
        answers: { 'Ship?': 'Yes', 'Notify?': 'No' },
      },
    })

    expect(order).toEqual(['read-1', 'stop', 'read-2', 'start', 'orphan'])
    expect(start).toHaveBeenCalledTimes(1)
    expect(start.mock.calls[0]?.[3]).toEqual(expect.objectContaining({
      resumeInterruptedTurn: false,
      transcriptStartupPolicy: 'preserve_existing',
    }))
    expect(orphan).toHaveBeenCalledTimes(1)
    expect(messages).toContainEqual(expect.objectContaining({
      state: 'accepted',
      route: 'orphaned_recovery',
    }))
  })

  test('keeps unconfirmed and thrown stops retryable without duplicate same-attempt stops', async () => {
    installDetachedRuntimePreparation()
    const toolBySession = new Map<string, string>()
    spyOn(sessionService, 'getSessionMessagesWithEvidence').mockImplementation(async (sessionId) => ({
      messages: [askMessage(toolBySession.get(sessionId)!)],
      transcriptEvidenceComplete: true,
    }))
    const stopCounts = new Map<string, number>()
    const stop = spyOn(conversationService, 'stopSessionForReplacementAndConfirm')
      .mockImplementation(async (sessionId) => {
        stopCounts.set(sessionId, (stopCounts.get(sessionId) ?? 0) + 1)
        if (sessionId.includes('throw')) throw new Error('private shutdown detail')
        return 'unconfirmed'
      })
    const start = spyOn(conversationService, 'startSession')
    const orphan = spyOn(conversationService, 'respondToOrphanedPermission')

    for (const mode of ['unconfirmed', 'throw']) {
      const sessionId = `decision-stop-${mode}-${crypto.randomUUID()}`
      const toolUseId = `ask-stop-${mode}`
      toolBySession.set(sessionId, toolUseId)
      const ws = socket(sessionId)
      const response = {
        kind: 'answer',
        answers: { 'Ship?': 'Yes', 'Notify?': 'No' },
      }
      await submitAndDrain(ws, {
        type: 'user_decision_response', decisionId: toolUseId,
        attemptId: `attempt-${mode}`, response,
      })
      await submitAndDrain(ws, {
        type: 'user_decision_response', decisionId: toolUseId,
        attemptId: `attempt-${mode}`, response,
      })
      const messages = await submitAndDrain(ws, {
        type: 'user_decision_response', decisionId: toolUseId,
        attemptId: `attempt-${mode}-retry`, response,
      })

      expect(stopCounts.get(sessionId)).toBe(2)
      expect(JSON.stringify(messages)).not.toContain('private shutdown detail')
      expect(messages).toContainEqual(expect.objectContaining({
        attemptId: `attempt-${mode}-retry`,
        state: 'retryable_failed',
      }))
    }
    expect(stop).toHaveBeenCalledTimes(4)
    expect(start).not.toHaveBeenCalled()
    expect(orphan).not.toHaveBeenCalled()
  })

  test('returns already_resolved when a tool result appears while stop is pending', async () => {
    const sessionId = `decision-resolved-during-stop-${crypto.randomUUID()}`
    const toolUseId = 'ask-resolved-during-stop'
    const ws = socket(sessionId)
    let reads = 0
    let resolveStop!: (value: 'stopped') => void
    const stopResult = new Promise<'stopped'>((resolve) => { resolveStop = resolve })
    installDetachedRuntimePreparation()
    spyOn(sessionService, 'getSessionMessagesWithEvidence').mockImplementation(async () => {
      reads += 1
      return {
        messages: reads === 1
          ? [askMessage(toolUseId)]
          : [
              askMessage(toolUseId),
              {
                id: 'result-during-stop',
                type: 'tool_result',
                timestamp: '2026-08-28T00:00:01.000Z',
                content: [{ type: 'tool_result', tool_use_id: toolUseId, content: 'answered' }],
              },
            ],
        transcriptEvidenceComplete: true,
      }
    })
    const stop = spyOn(conversationService, 'stopSessionForReplacementAndConfirm')
      .mockReturnValue(stopResult)
    const start = spyOn(conversationService, 'startSession')
    const orphan = spyOn(conversationService, 'respondToOrphanedPermission')

    handleWebSocket.message(ws, JSON.stringify({
      type: 'user_decision_response',
      decisionId: toolUseId,
      attemptId: 'attempt-resolved-during-stop',
      response: {
        kind: 'answer',
        answers: { 'Ship?': 'Yes', 'Notify?': 'No' },
      },
    }))
    for (let attempt = 0; attempt < 20 && stop.mock.calls.length === 0; attempt += 1) {
      await Promise.resolve()
    }
    expect(stop).toHaveBeenCalledTimes(1)
    resolveStop('stopped')
    await __enqueueRuntimeTransitionForTests(sessionId, async () => {})

    expect(start).not.toHaveBeenCalled()
    expect(orphan).not.toHaveBeenCalled()
    const messages = ws.sent.map((payload) => JSON.parse(payload) as {
      type?: string
      state?: string
      [key: string]: unknown
    })
    const resultIndex = messages.findIndex((message) =>
      message.type === 'user_decision_response_result' &&
      message.state === 'already_resolved')
    const snapshotIndex = messages.findIndex((message) =>
      message.type === 'permission_requests_snapshot')
    expect(resultIndex).toBeGreaterThanOrEqual(0)
    expect(snapshotIndex).toBe(resultIndex + 1)
    expect(messages[snapshotIndex]).toMatchObject({
      toolRequestIds: [],
      computerUseRequestIds: [],
      turnActive: false,
      userDecisions: {
        transcriptEvidenceComplete: true,
        userDecisionResponseProtocol: 'orphaned-permission-v1',
        decisions: [{
          decisionId: toolUseId,
          semanticState: { status: 'answered' },
          runtimeBinding: { status: 'detached' },
        }],
      },
    })
  })

  test('retains delivery holds on ordinary close and clears them only for permanent deletion', async () => {
    const toolUseId = 'ask-close-lifecycle'
    const respond = spyOn(conversationService, 'respondToTrackedPermission').mockReturnValue({
      status: 'delivery_failed',
      error: 'unknown transport outcome',
    })
    spyOn(conversationService, 'stopSession').mockImplementation(() => {})
    spyOn(conversationService, 'clearOutputCallbacks').mockImplementation(() => {})

    for (const permanentlyDeleted of [false, true]) {
      const sessionId = `decision-close-${permanentlyDeleted}-${crypto.randomUUID()}`
      installAttachedEvidence(sessionId, toolUseId)
      const ws = socket(sessionId)
      const response = {
        kind: 'answer',
        answers: { 'Ship?': 'Yes', 'Notify?': 'No' },
      }
      await submitAndDrain(ws, {
        type: 'user_decision_response', decisionId: toolUseId,
        attemptId: `attempt-initial-${permanentlyDeleted}`, response,
      })
      const callsAfterInitial = respond.mock.calls.length

      if (permanentlyDeleted) conversationService.markSessionDeleted(sessionId)
      closeSessionConnection(sessionId, permanentlyDeleted ? 'session deleted' : 'renderer closed')
      const messages = await submitAndDrain(socket(sessionId), {
        type: 'user_decision_response', decisionId: toolUseId,
        attemptId: `attempt-later-${permanentlyDeleted}`, response,
      })

      if (permanentlyDeleted) {
        expect(respond.mock.calls.length).toBe(callsAfterInitial + 1)
        expect(messages).toContainEqual(expect.objectContaining({
          attemptId: `attempt-later-${permanentlyDeleted}`,
          state: 'indeterminate',
        }))
      } else {
        expect(respond.mock.calls.length).toBe(callsAfterInitial)
        expect(messages).toContainEqual(expect.objectContaining({
          attemptId: `attempt-later-${permanentlyDeleted}`,
          state: 'rejected',
          error: expect.objectContaining({ code: 'USER_DECISION_DELIVERY_BUSY' }),
        }))
      }
    }
  })
})
