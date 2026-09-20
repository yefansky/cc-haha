import { describe, expect, test } from 'bun:test'
import { gunzipSync } from 'node:zlib'
import { acceptsGzip, privateJsonResponse } from '../httpCompression'

describe('history response compression before gateway transport', () => {
  test('round trips long multilingual history, attachments and task notifications without loss', async () => {
    const payload = { messages: Array.from({ length: 714 }, (_, id) => ({ id, text: '历史工具调用上下文'.repeat(400) })), taskNotifications: [{ id: 'child', status: 'done' }] }
    const response = await privateJsonResponse(new Request('http://localhost/messages', { headers: { 'Accept-Encoding': 'gzip, deflate, br' } }), payload)
    const bytes = Buffer.from(await response.arrayBuffer())
    expect(response.headers.get('content-encoding')).toBe('gzip')
    expect(Number(response.headers.get('content-length'))).toBe(bytes.length)
    expect(response.headers.get('cache-control')).toContain('no-store')
    expect(response.headers.get('vary')).toBe('Accept-Encoding')
    expect(JSON.parse(gunzipSync(bytes).toString())).toEqual(payload)
    expect(bytes.length).toBeLessThan(Buffer.byteLength(JSON.stringify(payload)) / 5)
  })
  test('honors explicit gzip refusal over wildcard and leaves ordinary JSON compatible', async () => {
    for (const encoding of ['', 'br', 'gzip;q=0, *;q=1', 'gzip;q=bogus']) {
      const payload = { text: '内容'.repeat(1000) }
      const response = await privateJsonResponse(new Request('http://localhost/messages', { headers: { 'Accept-Encoding': encoding } }), payload)
      expect(response.headers.get('content-encoding')).toBeNull()
      expect(await response.json()).toEqual(payload)
    }
    expect(acceptsGzip('br, GZIP; q=0.5')).toBe(true)
  })
  test('does not spend compression work on a new empty session', async () => {
    const response = await privateJsonResponse(new Request('http://localhost/messages', { headers: { 'Accept-Encoding': 'gzip' } }), { messages: [] })
    expect(response.headers.get('content-encoding')).toBeNull()
    expect(await response.json()).toEqual({ messages: [] })
  })
})
