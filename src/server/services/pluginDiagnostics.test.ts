import { expect, test } from 'bun:test'
import { parsePluginDiagnosticEvents } from './pluginDiagnostics.js'
import { projectDiagnosticEventForSharing } from './diagnosticsShare.js'

test('projects new startup and Git correlation fields for the page and shared export', () => {
  const sessionId = '91436acc-2855-4e0b-84d6-9af9bd5cd16d'
  const raw = JSON.stringify({ event: 'git_process_completed', timestamp: new Date().toISOString(), level: 'warn', data: { sessionId, pid: 1, ppid: 2, child_pid: 3, trace_id: sessionId, git_operation_id: sessionId, phase: 'cache_reload', source: 'headless', credential_policy: 'inherited', market_id: '0123456789abcdef', operation: 'clone', errorCategory: 'authentication', code: 128, stderr: 'PRIVATE_SECRET', url: 'https://private.example/repo' } })
  const event = parsePluginDiagnosticEvents(raw)[0]!
  expect(event.sessionId).toBe(sessionId)
  expect(event.details).toMatchObject({ phase: 'cache_reload', source: 'headless', credential_policy: 'inherited', child_pid: 3, trace_id: sessionId, market_id: '0123456789abcdef' })
  const shared = JSON.stringify(projectDiagnosticEventForSharing(event))
  expect(shared).toContain('inherited')
  expect(shared).toContain(sessionId)
  expect(shared).not.toContain('PRIVATE_SECRET')
  expect(shared).not.toContain('private.example')
})
