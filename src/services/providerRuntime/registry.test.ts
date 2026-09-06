import { describe, expect, test } from 'bun:test'
import { applyProviderRequestHeaders } from './index.js'
import { createProviderRequestHeaders } from './registry.js'

describe('Provider request adapter registry', () => {
  test('KSCC request ids change per call and do not affect an ordinary provider', () => {
    const env = { CC_HAHA_KSCC_PROTOCOL: '1', CC_HAHA_KSCC_HEADERS: JSON.stringify({ 'ksyun-code-type': 'kscc-sdk-cli', ignored: 5 }) }
    const first = new Headers({ Authorization: 'Bearer first' })
    const second = new Headers({ Authorization: 'Bearer second' })
    applyProviderRequestHeaders(first, env)
    applyProviderRequestHeaders(second, env)
    expect(first.get('ksyun-code-type')).toBe('kscc-sdk-cli')
    expect(first.has('ignored')).toBe(false)
    expect(first.get('X-KSC-REQUEST-ID')).not.toBe(second.get('X-KSC-REQUEST-ID'))
    expect(first.get('Authorization')).toBe('Bearer first')
    const ordinary = new Headers({ Authorization: 'Bearer ordinary' })
    applyProviderRequestHeaders(ordinary, {})
    expect([...ordinary]).toEqual([['authorization', 'Bearer ordinary']])
  })

  test('another request adapter participates through registration only', () => {
    const apply = createProviderRequestHeaders([{
      id: 'second',
      applyHeaders(headers, env) {
        if (env.SECOND_ENABLED === '1') headers.set('second-session', 'second')
      },
    }])
    const headers = new Headers()
    apply(headers, { SECOND_ENABLED: '1' })
    expect(headers.get('second-session')).toBe('second')
    expect(headers.has('X-KSC-REQUEST-ID')).toBe(false)
    expect(() => createProviderRequestHeaders([
      { id: 'same', applyHeaders() {} }, { id: 'same', applyHeaders() {} },
    ])).toThrow()
  })
})
