import { expect, test } from 'bun:test'
import { ConversationService } from './conversationService.js'

test('SDK permission arrival and cancellation drive metadata without observation consuming the decision', () => {
  const service = new ConversationService()
  const state = {
    proc: { pid: 123 }, sdkSocket: { send() {} }, startupPending: false, startupExitCode: null,
    pendingOutbound: [], pendingControlRequests: new Map(), pendingPermissionRequests: new Map(),
    outputCallbacks: [], seenSdkMessageUuids: new Set(), sdkMessages: [], initMessage: null,
  }
  // Register a fake transport only; drive the production payload handler for every state change.
  ;(service as any).sessions.set('observation-session', state)
  service.handleSdkPayload('observation-session', JSON.stringify({
    type: 'control_request', request_id: 'question-1', request: {
      subtype: 'can_use_tool', tool_name: 'AskUserQuestion', tool_use_id: 'tool-1',
      input: { questions: ['private-question-secret'] }, description: 'private-description-secret',
    },
  }))
  const snapshot = service.getRuntimeObservation()
  expect(snapshot.sessions[0]?.pendingPermissionCount).toBe(1)
  expect(snapshot.sessions[0]?.pendingPermissions[0]?.toolName).toBe('AskUserQuestion')
  expect(snapshot.sessions[0]?.lastSdkType).toBe('control_request')
  expect(JSON.stringify(snapshot)).not.toContain('secret')
  service.getRuntimeObservation()
  expect(service.getPendingPermissionRequests('observation-session')).toHaveLength(1)
  service.handleSdkPayload('observation-session', JSON.stringify({ type: 'control_cancel_request', request_id: 'question-1' }))
  expect(service.getRuntimeObservation().sessions[0]?.pendingPermissionCount).toBe(0)
})
