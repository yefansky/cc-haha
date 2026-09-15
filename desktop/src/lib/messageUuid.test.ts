import { afterEach, describe, expect, it, vi } from 'vitest'
import { createMessageUuid } from './messageUuid'

afterEach(() => vi.unstubAllGlobals())

describe('createMessageUuid', () => {
  it('preserves the native UUID method and its receiver', () => {
    const cryptoApi = { randomUUID() { expect(this).toBe(cryptoApi); return 'native-uuid' } }
    vi.stubGlobal('crypto', cryptoApi)
    expect(createMessageUuid()).toBe('native-uuid')
  })

  it('uses secure random bytes and sets UUID version and variant on HTTP', () => {
    const cryptoApi = { getRandomValues(bytes: Uint8Array) {
      expect(this).toBe(cryptoApi)
      expect(bytes).toHaveLength(16)
      return bytes.fill(255)
    } }
    vi.stubGlobal('crypto', cryptoApi)
    expect(createMessageUuid()).toBe('ffffffff-ffff-4fff-bfff-ffffffffffff')
  })

  it('generates distinct well-formed identifiers with the HTTP-compatible API', () => {
    const getRandomValues = globalThis.crypto.getRandomValues.bind(globalThis.crypto)
    vi.stubGlobal('crypto', { getRandomValues })
    const ids = Array.from({ length: 1000 }, () => createMessageUuid())
    expect(new Set(ids).size).toBe(ids.length)
    for (const id of ids) expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
  })
})
