import { afterEach, describe, expect, mock, spyOn, test } from 'bun:test'
import type { ServerWebSocket } from 'bun'
import { conversationService, type PendingPermissionRequest } from '../services/conversationService.js'
import { sessionService, type SessionMessagesWithEvidence } from '../services/sessionService.js'
import {
  __resetWebSocketHandlerStateForTests,
  closeSessionConnection,
  handleWebSocket,
  type WebSocketData,
} from '../ws/handler.js'

function makeClientSocket(sessionId: string, clientKind: 'full' | 'pet' = 'full') {
  const sent: string[] = []
  return {
    data: {
      sessionId,
      connectedAt: Date.now(),
      channel: 'client',
      clientKind,
      sdkToken: null,
      serverPort: 0,
      serverHost: '127.0.0.1',
    },
    send: mock((payload: string) => {
      sent.push(payload)
    }),
    close: mock(() => {}),
    sent,
  } as unknown as ServerWebSocket<WebSocketData> & { sent: string[] }
}

function deferred<T>(): {
  promise: Promise<T>
  resolve: (value: T) => void
} {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((innerResolve) => {
    resolve = innerResolve
  })
  return { promise, resolve }
}

async function flushMicrotasks(count = 12): Promise<void> {
  for (let index = 0; index < count; index++) await Promise.resolve()
}

function pendingAsk(requestId: string, toolUseId: string): PendingPermissionRequest {
  return {
    requestId,
    toolName: 'AskUserQuestion',
    toolUseId,
    input: {
      questions: [{
        question: 'Ship it?',
        options: [{ label: 'Yes' }, { label: 'No' }],
      }],
    },
  }
}

describe('connection user-decision snapshot', () => {
  afterEach(() => {
    __resetWebSocketHandlerStateForTests()
    mock.restore()
  })

  test('samples pending requests after transcript hydration and flushes queued events after one snapshot', async () => {
    const sessionId = `decision-snapshot-${crypto.randomUUID()}`
    const ws = makeClientSocket(sessionId)
    const transcript = deferred<SessionMessagesWithEvidence>()
    let pendingRequests: PendingPermissionRequest[] = []
    spyOn(conversationService, 'hasSession').mockReturnValue(false)
    spyOn(conversationService, 'getPendingPermissionRequests').mockImplementation(
      () => pendingRequests,
    )
    spyOn(sessionService, 'getSessionMessagesWithEvidence').mockReturnValue(transcript.promise)

    handleWebSocket.open(ws)
    handleWebSocket.message(ws, JSON.stringify({ type: 'ping' }))

    expect(ws.sent.map(payload => JSON.parse(payload))).toEqual([
      { type: 'connected', sessionId },
    ])

    pendingRequests = [pendingAsk('request-1', 'ask-1')]
    transcript.resolve({
      transcriptEvidenceComplete: true,
      messages: [{
        id: 'assistant-ask-1',
        type: 'tool_use',
        timestamp: '2026-08-28T00:00:00.000Z',
        content: [{
          type: 'tool_use',
          name: 'AskUserQuestion',
          id: 'ask-1',
          input: pendingRequests[0]!.input,
        }],
      }],
    })
    await flushMicrotasks()

    expect(ws.sent.map(payload => JSON.parse(payload))).toEqual([
      { type: 'connected', sessionId },
      {
        type: 'permission_request',
        requestId: 'request-1',
        toolName: 'AskUserQuestion',
        toolUseId: 'ask-1',
        input: pendingRequests[0]!.input,
      },
      {
        type: 'permission_requests_snapshot',
        toolRequestIds: ['request-1'],
        computerUseRequestIds: [],
        turnActive: false,
        userDecisions: {
          transcriptEvidenceComplete: true,
          decisions: [{
            decisionId: 'ask-1',
            semanticState: { status: 'open' },
            runtimeBinding: { status: 'attached', requestId: 'request-1' },
            response: null,
            input: pendingRequests[0]!.input,
            inputSource: 'transcript',
            conflicted: false,
          }],
        },
      },
      { type: 'pong' },
    ])
  })

  test('finalizes live-only at the queue bound without dropping queued events', async () => {
    const sessionId = `decision-overflow-${crypto.randomUUID()}`
    const ws = makeClientSocket(sessionId)
    const transcript = deferred<SessionMessagesWithEvidence>()
    const pendingRequests = [pendingAsk('request-overflow', 'ask-overflow')]
    spyOn(conversationService, 'hasSession').mockReturnValue(false)
    spyOn(conversationService, 'getPendingPermissionRequests').mockReturnValue(pendingRequests)
    spyOn(sessionService, 'getSessionMessagesWithEvidence').mockReturnValue(transcript.promise)

    handleWebSocket.open(ws)
    for (let index = 0; index < 256; index += 1) {
      handleWebSocket.message(ws, JSON.stringify({ type: 'ping' }))
    }

    const sent = ws.sent.map(payload => JSON.parse(payload))
    expect(sent.slice(0, 3)).toEqual([
      { type: 'connected', sessionId },
      {
        type: 'permission_request',
        requestId: 'request-overflow',
        toolName: 'AskUserQuestion',
        toolUseId: 'ask-overflow',
        input: pendingRequests[0]!.input,
      },
      expect.objectContaining({
        type: 'permission_requests_snapshot',
        toolRequestIds: ['request-overflow'],
        userDecisions: expect.objectContaining({
          transcriptEvidenceComplete: false,
          decisions: [expect.objectContaining({
            decisionId: 'ask-overflow',
            inputSource: 'live',
          })],
        }),
      }),
    ])
    expect(sent.slice(3)).toHaveLength(256)
    expect(sent.slice(3).every(message => message.type === 'pong')).toBe(true)

    transcript.resolve({ messages: [], transcriptEvidenceComplete: true })
    await flushMicrotasks()
    expect(ws.sent.map(payload => JSON.parse(payload)).filter(
      message => message.type === 'permission_requests_snapshot',
    )).toHaveLength(1)
  })

  test('falls back to a live-only snapshot when transcript hydration fails', async () => {
    const sessionId = `decision-read-failure-${crypto.randomUUID()}`
    const ws = makeClientSocket(sessionId)
    const pendingRequests = [pendingAsk('request-fallback', 'ask-fallback')]
    spyOn(conversationService, 'hasSession').mockReturnValue(false)
    spyOn(conversationService, 'getPendingPermissionRequests').mockReturnValue(pendingRequests)
    spyOn(sessionService, 'getSessionMessagesWithEvidence').mockRejectedValue(
      new Error('transcript unavailable'),
    )

    handleWebSocket.open(ws)
    await flushMicrotasks()

    const snapshots = ws.sent
      .map(payload => JSON.parse(payload))
      .filter(message => message.type === 'permission_requests_snapshot')
    expect(snapshots).toEqual([expect.objectContaining({
      toolRequestIds: ['request-fallback'],
      userDecisions: {
        transcriptEvidenceComplete: false,
          decisions: [expect.objectContaining({
            decisionId: 'ask-fallback',
            inputSource: 'live',
            runtimeBinding: {
              status: 'attached',
              requestId: 'request-fallback',
            },
          })],
      },
    })])
  })

  test('finalizes the connection once when transcript hydration reaches the real deadline', async () => {
    const sessionId = `decision-read-timeout-${crypto.randomUUID()}`
    const ws = makeClientSocket(sessionId)
    const transcript = deferred<SessionMessagesWithEvidence>()
    const pendingRequests = [pendingAsk('request-timeout', 'ask-timeout')]
    spyOn(conversationService, 'hasSession').mockReturnValue(false)
    spyOn(conversationService, 'getPendingPermissionRequests').mockReturnValue(pendingRequests)
    spyOn(sessionService, 'getSessionMessagesWithEvidence').mockReturnValue(transcript.promise)

    handleWebSocket.open(ws)
    await Bun.sleep(1_600)

    const snapshotsBeforeLateRead = ws.sent
      .map(payload => JSON.parse(payload))
      .filter(message => message.type === 'permission_requests_snapshot')
    expect(snapshotsBeforeLateRead).toEqual([expect.objectContaining({
      toolRequestIds: ['request-timeout'],
      userDecisions: expect.objectContaining({
        transcriptEvidenceComplete: false,
      }),
    })])

    transcript.resolve({ messages: [], transcriptEvidenceComplete: true })
    await flushMicrotasks()
    expect(ws.sent.map(payload => JSON.parse(payload)).filter(
      message => message.type === 'permission_requests_snapshot',
    )).toHaveLength(1)
  })

  test('keeps the pet client on the synchronous legacy snapshot path', () => {
    const sessionId = `decision-pet-${crypto.randomUUID()}`
    const ws = makeClientSocket(sessionId, 'pet')
    const readTranscript = spyOn(sessionService, 'getSessionMessagesWithEvidence')
    spyOn(conversationService, 'hasSession').mockReturnValue(false)
    spyOn(conversationService, 'getPendingPermissionRequests').mockReturnValue([
      pendingAsk('private-request', 'private-ask'),
    ])

    handleWebSocket.open(ws)

    expect(readTranscript).not.toHaveBeenCalled()
    expect(ws.sent.map(payload => JSON.parse(payload))).toEqual([
      { type: 'connected', sessionId },
      {
        type: 'permission_requests_snapshot',
        toolRequestIds: [],
        computerUseRequestIds: [],
        turnActive: false,
      },
    ])
  })

  test('drops the barrier and sends nothing after the client closes', async () => {
    const sessionId = `decision-close-${crypto.randomUUID()}`
    const ws = makeClientSocket(sessionId)
    const transcript = deferred<SessionMessagesWithEvidence>()
    spyOn(conversationService, 'hasSession').mockReturnValue(false)
    spyOn(conversationService, 'getPendingPermissionRequests').mockReturnValue([])
    spyOn(sessionService, 'getSessionMessagesWithEvidence').mockReturnValue(transcript.promise)

    handleWebSocket.open(ws)
    handleWebSocket.message(ws, JSON.stringify({ type: 'ping' }))
    handleWebSocket.close(ws, 1000, 'test close')
    transcript.resolve({ messages: [], transcriptEvidenceComplete: true })
    await flushMicrotasks()

    expect(ws.sent.map(payload => JSON.parse(payload))).toEqual([
      { type: 'connected', sessionId },
    ])
  })

  test('drops queued startup output when the session is closed externally', async () => {
    const sessionId = `decision-external-close-${crypto.randomUUID()}`
    const ws = makeClientSocket(sessionId)
    const transcript = deferred<SessionMessagesWithEvidence>()
    spyOn(conversationService, 'hasSession').mockReturnValue(false)
    spyOn(conversationService, 'getPendingPermissionRequests').mockReturnValue([])
    spyOn(sessionService, 'getSessionMessagesWithEvidence').mockReturnValue(transcript.promise)

    handleWebSocket.open(ws)
    handleWebSocket.message(ws, JSON.stringify({ type: 'ping' }))
    expect(closeSessionConnection(sessionId, 'test session closed')).toBe(true)
    transcript.resolve({ messages: [], transcriptEvidenceComplete: true })
    await flushMicrotasks()

    expect(ws.close).toHaveBeenCalledWith(1000, 'test session closed')
    expect(ws.sent.map(payload => JSON.parse(payload))).toEqual([
      { type: 'connected', sessionId },
    ])
  })
})
