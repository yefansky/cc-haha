import { describe, expect, it } from 'vitest'
import { includeProjectedAsks } from './projectedAskTimeline'
import type { AskUserDecisionProjection, AskUserDecisionView } from '../stores/chatStore'
import type { UIMessage } from '../types/chat'

const text = (id: string, timestamp: number): UIMessage => ({ id, type: 'assistant_text', content: id, timestamp })
const ask = (id: string, timestamp: number): UIMessage => ({ id, type: 'tool_use', toolName: 'AskUserQuestion', toolUseId: id, input: {}, timestamp })
function view(id: string, timestamp?: number, live = false): AskUserDecisionView {
  return {
    source: 'server', toolUseId: id, input: {}, pendingRequest: null,
    terminal: !live, interaction: live ? { mode: 'editing', channel: 'modern' } : { mode: 'settled' },
    decision: {
      decisionId: id, timestamp, input: {}, inputSource: live ? 'live' : 'transcript',
      semanticState: { status: live ? 'open' : 'answered' },
      runtimeBinding: { status: 'detached' }, response: null, conflicted: false,
    },
  }
}
const projection = (...views: AskUserDecisionView[]): AskUserDecisionProjection => ({ source: 'server', active: views.at(-1)!, views })
const ids = (messages: UIMessage[]) => messages.map(m => m.type === 'tool_use' ? m.toolUseId : m.id)

describe('snapshot question timeline', () => {
  it('places answered historical cards before the current live card on an old sidecar', () => {
    const messages = [text('before', 5), ask('new', 30)]
    const result = includeProjectedAsks(messages, projection(view('old-a'), view('old-b'), view('new', undefined, true)))
    expect(ids(result)).toEqual(['before', 'old-a', 'old-b', 'new'])
    expect(result.at(-1)).toBe(messages.at(-1))
  })
  it('puts transcript cards back between the surrounding messages using original time', () => {
    const messages = [text('before', 1), text('between', 15), ask('new', 30)]
    const result = includeProjectedAsks(messages, projection(view('old-a', 10), view('old-b', 20), view('new', 30, true)))
    expect(ids(result)).toEqual(['before', 'old-a', 'between', 'old-b', 'new'])
    expect(result[1]?.timestamp).toBe(10)
  })
  it('does not move or duplicate existing cards when a full transcript arrives', () => {
    const messages = [ask('old-a', 10), text('between', 15), ask('new', 30)]
    const p = projection(view('old-a', 10), view('new', 30, true))
    expect(includeProjectedAsks(messages, p)).toBe(messages)
  })
  it('keeps synthetic ids stable over repeated snapshots and deduplicates snapshot entries', () => {
    const p = projection(view('old', 10), view('old', 10), view('new', 30, true))
    const first = includeProjectedAsks([ask('new', 30)], p)
    expect(ids(first)).toEqual(['old', 'new'])
    expect(includeProjectedAsks(first, p)).toBe(first)
  })
  it('keeps an unanchored old transcript ahead of live messages, and a new live request at the end', () => {
    expect(ids(includeProjectedAsks([text('live text', 20)], projection(view('old'), view('new', undefined, true)))))
      .toEqual(['old', 'live text', 'new'])
  })
  it('preserves snapshot order between historical anchors and leaves existing messages ordered', () => {
    expect(ids(includeProjectedAsks([ask('a', 1), text('middle', 2), ask('c', 3)], projection(view('a'), view('b'), view('c')))))
      .toEqual(['a', 'middle', 'b', 'c'])
  })
  it('never mutates messages or interaction state', () => {
    const messages = Object.freeze([Object.freeze(ask('new', 30))])
    const old = view('old', 10)
    const current = view('new', 30, true)
    includeProjectedAsks(messages as unknown as UIMessage[], projection(old, current))
    expect(old.interaction.mode).toBe('settled')
    expect(current.interaction.mode).toBe('editing')
  })
})
