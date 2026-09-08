import { afterEach, describe, expect, it } from 'bun:test'
import { getIsNonInteractiveSession, setIsInteractive } from '../bootstrap/state.js'
import { drainSdkEvents, enqueueSdkEvent, subscribeSdkEvents } from './sdkEventQueue.js'

const wasNonInteractive = getIsNonInteractiveSession()
afterEach(() => { drainSdkEvents(); setIsInteractive(!wasNonInteractive) })
describe('SDK live progress delivery', () => {
  it('drains while the parent has not yielded and releases its subscription', async () => {
    setIsInteractive(false)
    drainSdkEvents()
    const delivered: string[] = []
    const unsubscribe = subscribeSdkEvents(() => {
      delivered.push(...drainSdkEvents().map(event => event.subtype))
    })
    try {
      let release!: () => void
      const parentWaiting = new Promise<void>(resolve => { release = resolve })
      enqueueSdkEvent({ type: 'system', subtype: 'agent_stream_progress', progress: {
        toolUseId: 'parent-tool', agentId: 'child', description: 'Review', startedAt: 1,
        updatedAt: 2, phase: 'thinking', outputTokensEstimate: 300,
      } })
      expect(delivered).toEqual(['agent_stream_progress'])
      expect(drainSdkEvents()).toHaveLength(0)
      release(); await parentWaiting
    } finally { unsubscribe() }
    enqueueSdkEvent({ type: 'system', subtype: 'session_state_changed', state: 'idle' })
    expect(delivered).toHaveLength(1)
    expect(drainSdkEvents()).toHaveLength(1)
  })
})
