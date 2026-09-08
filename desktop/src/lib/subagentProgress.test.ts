import { describe, expect, it } from 'vitest'
import { parseSubagentProgress, updateSubagentProgress, type SubagentProgress } from './subagentProgress'

const progress: SubagentProgress = { toolUseId: 'parent', agentId: 'child', description: 'Review', startedAt: 10, updatedAt: 20, outputTokensEstimate: 30, phase: 'thinking' }
describe('subagent progress projection', () => {
  it('rejects malformed wire data and negative/non-finite counts', () => {
    for (const data of [null, {}, { ...progress, outputTokensEstimate: NaN }, { ...progress, outputTokensEstimate: -1 }, { ...progress, phase: 'fake' }]) expect(parseSubagentProgress(data)).toBeNull()
    expect(parseSubagentProgress(progress)).toEqual(progress)
  })
  it('keeps terminal and newer runs authoritative despite late events', () => {
    const finished = { ...progress, phase: 'finished' as const, updatedAt: 30 }
    const state = updateSubagentProgress({}, finished)
    expect(updateSubagentProgress(state, { ...progress, updatedAt: 40 })).toBe(state)
    const resumed = { ...progress, startedAt: 50, updatedAt: 60 }
    expect(updateSubagentProgress(state, resumed).parent).toEqual(resumed)
    expect(updateSubagentProgress({ parent: resumed }, finished).parent).toEqual(resumed)
  })
})
