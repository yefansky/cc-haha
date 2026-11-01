import { expect, test } from 'bun:test'
import { projectHeadlessRunCost } from './headlessProviderCost.js'

test('native totals and per-model client prices never become billed dollar amounts', () => {
  const result = projectHeadlessRunCost({ total_cost_usd: 2.5, modelUsage: { 'glm-5.1': { inputTokens: 10, outputTokens: 3, cacheReadInputTokens: 40, costUSD: 2.5, key: 'must-not-leak' } }, key: 'must-not-leak' })
  expect(result.total_cost_usd).toBeNull()
  expect(result.cost.billed_cost).toBeNull()
  expect(result.cost.currency).toBeNull()
  expect(result.cost.client_estimate).toMatchObject({ status: 'client_estimate', billed: false, currency: 'USD', total_cost_usd: 2.5 })
  expect(result.modelUsage['glm-5.1']).toEqual({ inputTokens: 10, outputTokens: 3, cacheReadInputTokens: 40, costUSD: null })
  expect(JSON.stringify(result)).not.toContain('must-not-leak')
})

test('missing, invalid and explicit zero client estimates remain distinct from actual cost', () => {
  expect(projectHeadlessRunCost({}).cost.client_estimate.status).toBe('unavailable')
  expect(projectHeadlessRunCost({ total_cost_usd: -5, modelUsage: { m: { costUSD: Infinity } } }).cost.client_estimate.total_cost_usd).toBeNull()
  const zero = projectHeadlessRunCost({ total_cost_usd: 0, modelUsage: { m: { inputTokens: 0, costUSD: 0 } } })
  expect(zero.total_cost_usd).toBeNull()
  expect(zero.cost.client_estimate.total_cost_usd).toBe(0)
  expect(zero.modelUsage.m).toEqual({ inputTokens: 0, costUSD: null })
})

test('cost projection is pure and does not remove the GUI native estimate', () => {
  const raw = { total_cost_usd: 1, modelUsage: { m: { costUSD: 1, inputTokens: 2 } } }
  const before = JSON.stringify(raw)
  projectHeadlessRunCost(raw)
  expect(JSON.stringify(raw)).toBe(before)
})

test('known secrets echoed as model names are redacted in both measurements and estimates', () => {
  const secret = 'fake-echoed-provider-key'
  const report = projectHeadlessRunCost({ modelUsage: { [secret]: { inputTokens: 3, costUSD: 0.25 } } }, [secret])
  expect(JSON.stringify(report)).not.toContain(secret)
  expect(Object.keys(report.modelUsage)).toEqual(['[已打码]'])
})

test('legitimate model suffixes retain token measurements while billed cost remains unknown', () => {
  const result = projectHeadlessRunCost({ modelUsage: { 'claude-sonnet-5[1m]': { inputTokens: 5, costUSD: 0.25 } } })
  expect(result.modelUsage['claude-sonnet-5[1m]']).toEqual({ inputTokens: 5, costUSD: null })
  expect(result.cost.client_estimate.model_usage).toEqual([{ model: 'claude-sonnet-5[1m]', cost_usd: 0.25 }])
})

test('prototype-shaped model keys retain own numeric measurements without polluting objects', () => {
  const names = ['constructor', '__proto__', 'toString', '中文模型[1m]']
  const result = projectHeadlessRunCost({ modelUsage: Object.fromEntries(names.map(model => [model, { inputTokens: 5, costUSD: 0.25 }])) })
  for (const model of names) {
    expect(Object.hasOwn(result.modelUsage, model)).toBe(true)
    expect(result.modelUsage[model]).toEqual({ inputTokens: 5, costUSD: null })
  }
  expect(Object.prototype).not.toHaveProperty('inputTokens')
})
