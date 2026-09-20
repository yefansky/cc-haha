import { afterEach, describe, expect, it, vi } from 'vitest'
import { buildRendererDebugSnapshot, installRendererDebugObservation, parseRendererDebugSnapshot } from './liveDebugObservation'

afterEach(() => vi.useRealTimers())
describe('renderer observation metadata', () => {
  it('reports state transitions only while enabled and never includes message or permission contents', () => {
    vi.useFakeTimers()
    let toggle: (enabled: boolean) => void = () => {}
    const report = vi.fn()
    const sessions = { session1: { chatState: 'thinking', connectionState: 'connected',
      pendingPermissions: { request1: { secret: 'private text' } }, queuedUserMessages: [{ text: 'private text' }] } }
    const stop = installRendererDebugObservation(() => buildRendererDebugSnapshot(sessions), {
      subscribe: handler => { toggle = handler; return () => {} }, report,
    })
    vi.advanceTimersByTime(5000)
    expect(report).not.toHaveBeenCalled()
    toggle(true)
    expect(report.mock.lastCall?.[0].sessions[0]).toEqual({ sessionId: 'session1', chatState: 'thinking',
      connectionState: 'connected', pendingPermissionCount: 1, queuedMessageCount: 1 })
    sessions.session1.chatState = 'permission_pending'
    vi.advanceTimersByTime(1000)
    expect(report.mock.lastCall?.[0].sessions[0].chatState).toBe('permission_pending')
    expect(JSON.stringify(report.mock.calls)).not.toContain('private text')
    toggle(false)
    const count = report.mock.calls.length
    vi.advanceTimersByTime(5000)
    expect(report).toHaveBeenCalledTimes(count)
    stop()
  })
  it('bounds sessions, strips unknown fields and rejects malformed metadata', () => {
    const state = buildRendererDebugSnapshot(Object.fromEntries(Array.from({ length: 100 }, (_, i) => [
      `session${i}`, { chatState: 'idle', connectionState: 'disconnected' },
    ])))
    expect(state.sessions).toHaveLength(64)
    expect(state.truncated).toBe(true)
    expect(parseRendererDebugSnapshot({ ...state, privateText: 'secret' })).toEqual(state)
    expect(parseRendererDebugSnapshot({ sessions: [{ sessionId: 'secret prompt text' }], truncated: false })).toBeNull()
  })
})
