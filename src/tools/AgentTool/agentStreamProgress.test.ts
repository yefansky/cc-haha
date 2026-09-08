import { describe, expect, it } from 'bun:test'
import type { Message } from '../../types/message.js'
import { createAgentStreamProgress, type AgentStreamProgress } from './agentStreamProgress.js'

describe('subagent stream activity', () => {
  it('publishes thinking before a complete message, throttles, and never sends content', () => {
    let now = 1000
    const updates: AgentStreamProgress[] = []
    const tracker = createAgentStreamProgress({ toolUseId: 'parent', agentId: 'child', description: 'Review' }, p => updates.push(p), () => now)
    const delta = { type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'thinking_delta', thinking: 'abcd' } } } as Message
    tracker.observe(delta)
    for (let i = 0; i < 100; i++) tracker.observe(delta)
    expect(updates).toHaveLength(2)
    now += 500
    tracker.observe(delta)
    expect(updates.at(-1)).toMatchObject({ phase: 'thinking', outputTokensEstimate: 102 })
    expect(JSON.stringify(updates)).not.toContain('abcd')
    tracker.observe({ type: 'assistant', message: { content: [{ type: 'thinking', thinking: 'abcd'.repeat(102) }] } } as Message)
    tracker.finish()
    expect(updates.at(-1)).toMatchObject({ phase: 'finished', outputTokensEstimate: 102 })
  })

  it('isolates concurrent agents and includes tool input without counting complete blocks twice', () => {
    const left: AgentStreamProgress[] = []
    const right: AgentStreamProgress[] = []
    const a = createAgentStreamProgress({ toolUseId: 'a', agentId: 'a1', description: 'A' }, p => left.push(p))
    const b = createAgentStreamProgress({ toolUseId: 'b', agentId: 'b1', description: 'B' }, p => right.push(p))
    a.observe({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'input_json_delta', partial_json: '12345678' } } } as Message)
    a.finish(); b.finish()
    expect(left.at(-1)?.outputTokensEstimate).toBe(2)
    expect(right.at(-1)?.outputTokensEstimate).toBe(0)
  })
})
