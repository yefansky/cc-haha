import { afterEach, describe, expect, mock, spyOn, test } from 'bun:test'
import { ConversationService } from './conversationService.js'
import { ASK_USER_QUESTION_CLARIFY_WITH_QUESTIONS_PREFIX } from '../../constants/messages.js'

function installSession(
  service: ConversationService,
  send: (data: string) => void,
  pendingPermissionRequestIds: string[] = [],
) {
  ;(service as unknown as {
    sessions: Map<string, unknown>
  }).sessions.set('session-1', {
    sdkSocket: { send },
    pendingOutbound: [],
    pendingPermissionRequests: new Map(
      pendingPermissionRequestIds.map((requestId) => [requestId, {}]),
    ),
    pendingControlRequests: new Map(),
  })
}

describe('ConversationService orphaned Ask permission response', () => {
  afterEach(() => mock.restore())

  test('sends the authoritative toolUseID with a server-generated unexpected request id', () => {
    const service = new ConversationService()
    const sent: unknown[] = []
    installSession(service, (data) => sent.push(JSON.parse(data)))

    expect(service.respondToOrphanedPermission(
      'session-1',
      'ask-root',
      true,
      { questions: [], answers: { 'Ship it?': 'Yes' } },
    )).toEqual({ status: 'accepted', transport: 'sent' })
    expect(sent).toEqual([{
      type: 'control_response',
      response: {
        subtype: 'success',
        request_id: expect.any(String),
        response: {
          behavior: 'allow',
          updatedInput: { questions: [], answers: { 'Ship it?': 'Yes' } },
          toolUseID: 'ask-root',
        },
      },
    }])
    expect((sent[0] as any).response.request_id).not.toBe('attempt-1')
  })

  test('does not reuse any currently tracked runtime request id', () => {
    const service = new ConversationService()
    const sent: any[] = []
    installSession(service, (data) => sent.push(JSON.parse(data)), ['runtime-request-1'])
    spyOn(crypto, 'randomUUID')
      .mockReturnValueOnce('runtime-request-1' as `${string}-${string}-${string}-${string}-${string}`)
      .mockReturnValueOnce('fresh-request-id' as `${string}-${string}-${string}-${string}-${string}`)

    expect(service.respondToOrphanedPermission(
      'session-1',
      'ask-root',
      true,
      { answers: { 'Ship it?': 'Yes' } },
    )).toEqual({ status: 'accepted', transport: 'sent' })
    expect(sent[0].response.request_id).toBe('fresh-request-id')
  })

  test('uses the established Ask clarification denial and reports uncertain send failure', () => {
    const service = new ConversationService()
    const sent: unknown[] = []
    installSession(service, (data) => sent.push(JSON.parse(data)))

    expect(service.respondToOrphanedPermission(
      'session-1',
      'ask-root',
      false,
      undefined,
      '- "Ship it?"\n  (No answer provided)',
    )).toEqual({ status: 'accepted', transport: 'sent' })
    expect(sent).toHaveLength(1)
    expect(sent[0]).toMatchObject({
      response: {
        request_id: expect.any(String),
        response: {
          behavior: 'deny',
          toolUseID: 'ask-root',
          message: expect.stringContaining(ASK_USER_QUESTION_CLARIFY_WITH_QUESTIONS_PREFIX),
        },
      },
    })

    const failed = new ConversationService()
    installSession(failed, () => { throw new Error('socket status unknown') })
    expect(failed.respondToOrphanedPermission(
      'session-1',
      'ask-root',
      true,
      { answers: {} },
    )).toEqual({ status: 'delivery_failed', error: 'socket status unknown' })
  })

  test('rejects a starting runtime and a missing session without queueing side effects', () => {
    const service = new ConversationService()
    ;(service as unknown as { sessions: Map<string, unknown> }).sessions.set('session-1', {
      sdkSocket: null,
      pendingOutbound: [],
      pendingPermissionRequests: new Map(),
      pendingControlRequests: new Map(),
    })

    expect(service.respondToOrphanedPermission(
      'session-1',
      'ask-root',
      true,
      { answers: { 'Ship it?': 'Yes' } },
    )).toEqual({ status: 'rejected', reason: 'session_unavailable' })
    expect((service as any).sessions.get('session-1').pendingOutbound).toEqual([])
    expect(service.respondToOrphanedPermission(
      'missing-session',
      'ask-root',
      true,
      { answers: { 'Ship it?': 'Yes' } },
    )).toEqual({ status: 'rejected', reason: 'session_unavailable' })
  })
})
