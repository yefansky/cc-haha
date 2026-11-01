import { expect, test } from 'bun:test'
import { getHeadlessProviderPricing } from './headlessProviderPricing.js'
import type { SavedProvider } from '../types/provider.js'

for (const preset of ['kscc', 'seasun', 'custom']) {
  test(`${preset} prices stay explicitly unknown without an account price contract`, async () => {
    const provider = { id: 'account-a', presetId: preset, apiKey: 'must-not-leak', baseUrl: 'https://not-a-price-endpoint.invalid', models: { main: 'gpt-5.1', haiku: 'gpt-5.1' }, modelCatalog: [{ id: 'glm-5.1' }] } as SavedProvider
    const result = await getHeadlessProviderPricing('account-a', { selectProvider: async () => provider })
    expect(result).toMatchObject({ schema_version: 2, provider_id: 'account-a', status: 'unknown', currency: null, unit: 'per_million_tokens', rates: { input: null, output: null, cache_read: null, cache_creation: null } })
    expect(result.models.map(value => value.id)).toEqual(['glm-5.1', 'gpt-5.1'])
    expect(result.models.every(value => Object.values(value.rates).every(rate => rate === null))).toBe(true)
    expect(result.source.verified_at).toBeNull()
    expect(JSON.stringify(result)).not.toContain('must-not-leak')
    expect(JSON.stringify(result)).not.toContain('not-a-price-endpoint')
  })
}

test('pricing honors cancellation without selecting credentials or network requests', async () => {
  let selected = false
  await expect(getHeadlessProviderPricing('unused', { signal: AbortSignal.abort(), selectProvider: async () => { selected = true; throw new Error('unused') } })).rejects.toThrow()
  expect(selected).toBe(false)
})

test('a credential echoed inside a model label is redacted, not merely field-filtered', async () => {
  const secret = 'fake-private-model-key'
  const value = { id: 'safe-id', apiKey: secret, presetId: 'custom', models: { main: `echo-${secret}` }, modelCatalog: [{ id: secret, name: secret }] } as SavedProvider
  const report = await getHeadlessProviderPricing('safe-id', { selectProvider: async () => value })
  expect(JSON.stringify(report)).not.toContain(secret)
  expect(report.models.some(model => model.id.includes('[已打码]'))).toBe(true)
})

test('opaque runtime model labels retain supported suffixes without inventing prices', async () => {
  const result = await getHeadlessProviderPricing('custom', { selectProvider: async () => ({ id: 'custom', presetId: 'custom', models: { main: 'claude-sonnet-5[1m]' }, apiKey: '' } as SavedProvider) })
  expect(result.models.map(model => model.id)).toEqual(['claude-sonnet-5[1m]'])
  expect(result.models[0]?.rates.input).toBeNull()
})
