import { expect, test } from 'bun:test'
import { redactHeadlessText, redactHeadlessValue } from './headlessRedaction.js'

test('shared headless projection redacts known secrets from nested metadata values and keys without changing ordinary null/number evidence', () => {
  const key = 'fixture-key-"\\\nwith-specials'
  const input = { [key]: [{ name: key, encoded: encodeURIComponent(key), amount: null, tokens: 3 }], safe: 'model-a' }
  const result = redactHeadlessValue(input, [key])
  expect(Object.keys(result)).toEqual(['[已打码]', 'safe'])
  expect(result['[已打码]'][0]).toEqual({ name: '[已打码]', encoded: '[已打码]', amount: null, tokens: 3 })
  expect(JSON.stringify(result)).not.toContain('fixture-key')
  expect(result.safe).toBe('model-a')
  expect(Object.keys(input)[0]).toBe(key)
})

test('generic authorization forms are hidden while ordinary model IDs remain unchanged', () => {
  expect(redactHeadlessText('Bearer abc.def-ghi sk-fixturelongcredential')).toBe('Bearer [已打码] [已打码]')
  expect(redactHeadlessText('provider-id model-v2.5')).toBe('provider-id model-v2.5')
})
