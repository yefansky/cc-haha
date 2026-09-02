import { describe, expect, it } from 'vitest'
import {
  compileWorkspaceRulePattern,
  createDefaultWorkspaceComparisonSettings,
  validateWorkspaceComparisonSettings,
} from './workspaceComparisonSettings'

describe('workspaceComparisonSettings', () => {
  it('provides stable profile defaults without creating a mutable shared object', () => {
    const first = createDefaultWorkspaceComparisonSettings('src/main.cpp')
    const second = createDefaultWorkspaceComparisonSettings('README.md')
    expect(first).toMatchObject({ profile: 'balanced', language: 'cpp', ignoreWhitespace: false, ignoreCase: false })
    expect(second.language).toBe('text')
    expect(first.rules).not.toBe(second.rules)
  })

  it('compiles bounded regular-language expressions without using JavaScript RegExp semantics', () => {
    const result = compileWorkspaceRulePattern('(?:TODO|FIXME)[0-9]{1,3}', false)
    expect(result.state).toBe('ok')
    if (result.state !== 'ok') return
    expect(result.compiled.findMatches('todo12 and FIXME7', { transitions: 10_000, matches: 128 })).toMatchObject({
      state: 'ok',
      spans: [{ start: 0, end: 6 }, { start: 11, end: 17 }],
    })
  })

  it('rejects backreferences, lookaround, nullable patterns, excessive repeats, and excessive aggregate state atomically', () => {
    for (const pattern of ['(a)\\1', '(?=a)a', 'a*', 'a{1,33}']) {
      expect(compileWorkspaceRulePattern(pattern, true).state).toBe('error')
    }
    const settings = createDefaultWorkspaceComparisonSettings('a.cpp')
    settings.rules = Array.from({ length: 33 }, (_, index) => ({
      id: `rule-${index}`,
      name: `rule ${index}`,
      enabled: true,
      pattern: 'x',
      caseSensitive: true,
      scope: 'line' as const,
      effect: 'ignore' as const,
      priority: 33 - index,
    }))
    expect(validateWorkspaceComparisonSettings(settings)).toMatchObject({ state: 'error', code: 'too_many_rules' })
  })

  it('fails closed on runtime transition exhaustion', () => {
    const result = compileWorkspaceRulePattern('(a|aa)+b', true)
    expect(result.state).toBe('ok')
    if (result.state !== 'ok') return
    expect(result.compiled.findMatches('a'.repeat(200), { transitions: 64, matches: 128 })).toMatchObject({
      state: 'budget_exceeded',
    })
  })

  it('fails closed instead of returning a partial target after the 128th match', () => {
    const result = compileWorkspaceRulePattern('a', true)
    expect(result.state).toBe('ok')
    if (result.state !== 'ok') return

    expect(result.compiled.findMatches('a'.repeat(129), {
      transitions: 10_000,
      matches: 128,
    })).toMatchObject({
      state: 'budget_exceeded',
      spans: [],
    })
  })
})
