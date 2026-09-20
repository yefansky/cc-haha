import { test, expect } from 'bun:test'
import { RuntimeBoundaryTrace, inspectBoundaryContract } from './runtimeBoundaryTrace'

test('recording is opt-in, contains only allowlisted boundary metadata, and freezes on stop', () => {
  const recorder = new RuntimeBoundaryTrace(() => 100, 42)
  const input = { layer: 'ui', direction: 'out' as const, event: 'send', correlationId: 'command-1' }
  recorder.record(input)
  expect(recorder.snapshot().entries).toHaveLength(0)
  recorder.start('recording-1')
  recorder.record({ ...input, body: 'private message', metadata: { sessionId: 'session-1', token: 'secret', queueDepth: 2 } } as any)
  const snapshot = recorder.stop()
  recorder.record({ ...input, event: 'must-not-appear' })
  expect(recorder.snapshot()).toEqual(snapshot)
  expect(snapshot.entries[0]).toMatchObject({ recordingId: 'recording-1', pid: 42, seq: 1, timestamp: 100, metadata: { sessionId: 'session-1', queueDepth: 2 } })
  expect(JSON.stringify(snapshot)).not.toContain('private message')
  expect(JSON.stringify(snapshot)).not.toContain('secret')
  recorder.start('recording-2')
  expect(recorder.snapshot().entries).toHaveLength(0)
})

test('bounded ring reports evidence loss and lease expiration freezes data', () => {
  let now = 0
  const recorder = new RuntimeBoundaryTrace(() => now, 7)
  recorder.start('bounded', 1000)
  for (let i = 0; i < 2050; i++) recorder.record({ layer: 'server', direction: 'in', event: 'receive', correlationId: `command-${i}` })
  recorder.record({ layer: 'server', direction: 'in', event: 'a prompt with spaces', correlationId: 'command-bad' })
  const snapshot = recorder.snapshot()
  expect(snapshot.entries).toHaveLength(2048)
  expect(snapshot.dropped).toBe(2)
  expect(snapshot.rejected).toBe(1)
  expect(snapshot.entries[0].seq).toBe(3)
  expect(snapshot.entries.at(-1)?.seq).toBe(2050)
  now = 1000
  recorder.record({ layer: 'server', direction: 'out', event: 'expired', correlationId: 'command-late' })
  expect(recorder.snapshot().recording).toBe(false)
  expect(recorder.snapshot().stoppedAt).toBe(1000)
  expect(recorder.snapshot().entries.at(-1)?.event).toBe('receive')
})

test('explicit boundary contract separates complete observations from absent or lossy evidence', () => {
  const ui = new RuntimeBoundaryTrace(() => 100, 10)
  const server = new RuntimeBoundaryTrace(() => 100, 20)
  ui.start('same-recording')
  server.start('same-recording')
  const contract = [{ layer: 'ui', direction: 'out' as const, event: 'send' }, { layer: 'server', direction: 'in' as const, event: 'receive' }]
  ui.record({ ...contract[0], correlationId: 'command-1' })
  server.record({ ...contract[1], correlationId: 'command-other' })
  const incomplete = inspectBoundaryContract([ui.snapshot(), server.snapshot()], 'command-1', contract)
  expect(incomplete.status).toBe('incomplete')
  expect(incomplete.missing).toEqual([contract[1]])
  server.record({ ...contract[1], correlationId: 'command-1' })
  expect(inspectBoundaryContract([ui.snapshot(), server.snapshot()], 'command-1', contract).status).toBe('complete')
  expect(inspectBoundaryContract([ui.snapshot(), server.snapshot()], 'command-1', []).status).toBe('unknown')
  for (let i = 0; i < 2048; i++) ui.record({ ...contract[0], correlationId: `extra-${i}` })
  expect(inspectBoundaryContract([ui.snapshot(), server.snapshot()], 'command-1', contract).status).toBe('unknown')
  server.start('different-recording')
  expect(inspectBoundaryContract([ui.snapshot(), server.snapshot()], 'command-1', contract).status).toBe('unknown')
})
