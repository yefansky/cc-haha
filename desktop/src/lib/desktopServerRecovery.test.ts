import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getAuthToken, getBaseUrl, setApiContext, subscribeApiContext } from '../api/client'
import { startDesktopServerRecovery } from './desktopServerRecovery'

function deferred<T>() {
  let resolve!: (value: T) => void
  return { promise: new Promise<T>(r => { resolve = r }), resolve: (value: T) => resolve(value) }
}

describe('desktop server recovery', () => {
  let stop: (() => void) | undefined
  let changed: () => void
  let url: string
  let token: string
  const off = vi.fn()
  const recovered = vi.fn()
  const getServerUrl = vi.fn(() => Promise.resolve(url))
  const host = { isDesktop: true, runtime: {
    getServerUrl,
    getLocalAccessToken: vi.fn(() => Promise.resolve(token)),
    onServerChanged: vi.fn((handler: () => void) => { changed = handler; return Promise.resolve(off) }),
  } }
  beforeEach(() => {
    vi.useFakeTimers()
    vi.clearAllMocks()
    url = 'http://127.0.0.1:60132'
    token = 'old-token'
    setApiContext(url, token)
    getServerUrl.mockImplementation(() => Promise.resolve(url))
    vi.stubGlobal('fetch', vi.fn().mockImplementation(() => Promise.resolve(Response.json({ status: 'ok' }))))
  })
  afterEach(() => { stop?.(); vi.unstubAllGlobals(); vi.useRealTimers() })
  const flush = () => vi.advanceTimersByTimeAsync(0)

  it('atomically migrates credentials and URL, and recovers even when a restart reuses the port', async () => {
    stop = startDesktopServerRecovery({ host, onRecovered: recovered })
    await flush()
    expect(recovered).not.toHaveBeenCalled()
    expect(fetch).not.toHaveBeenCalled()
    const contexts: unknown[] = []
    const unsubscribe = subscribeApiContext(() => contexts.push([getBaseUrl(), getAuthToken()]))
    url = 'http://127.0.0.1:62706'
    token = 'new-token'
    changed()
    await flush()
    expect(contexts).toEqual([[url, token]])
    expect(recovered).toHaveBeenCalledTimes(1)
    changed()
    await flush()
    expect(recovered).toHaveBeenCalledTimes(2)
    unsubscribe()
  })

  it('recovers an old preload with no event support by polling without duplicating stable recovery', async () => {
    stop = startDesktopServerRecovery({ host: { ...host, runtime: {
      getServerUrl, getLocalAccessToken: host.runtime.getLocalAccessToken,
    } }, onRecovered: recovered })
    await flush()
    url = 'http://127.0.0.1:62706'
    await vi.advanceTimersByTimeAsync(5000)
    expect(getBaseUrl()).toBe(url)
    expect(recovered).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(15000)
    expect(recovered).toHaveBeenCalledTimes(1)
  })

  it('discards the prior startup result when another server transition arrives in flight', async () => {
    const pending = deferred<string>()
    getServerUrl.mockReturnValueOnce(pending.promise)
    stop = startDesktopServerRecovery({ host, onRecovered: recovered })
    url = 'http://127.0.0.1:63000'
    changed()
    pending.resolve('http://127.0.0.1:62000')
    await flush()
    expect(getBaseUrl()).toBe(url)
    expect(recovered).toHaveBeenCalledTimes(1)
    expect(fetch).toHaveBeenCalledTimes(1)
    expect(fetch).toHaveBeenCalledWith(`${url}/health`, expect.anything())
  })

  it('keeps the old context until health succeeds, then retries automatically', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(new Response('', { status: 503 }))
    url = 'http://127.0.0.1:62706'
    stop = startDesktopServerRecovery({ host, onRecovered: recovered })
    await flush()
    expect(getBaseUrl()).toContain('60132')
    expect(recovered).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(5000)
    expect(getBaseUrl()).toBe(url)
    expect(recovered).toHaveBeenCalledTimes(1)
  })

  it('bounds a hung IPC call and ignores its late result after a later recovery', async () => {
    const pending = deferred<string>()
    getServerUrl.mockReturnValueOnce(pending.promise)
    stop = startDesktopServerRecovery({ host, onRecovered: recovered })
    url = 'http://127.0.0.1:63000'
    await vi.advanceTimersByTimeAsync(10000)
    expect(getBaseUrl()).toBe(url)
    pending.resolve('http://127.0.0.1:62000')
    await flush()
    expect(getBaseUrl()).toBe(url)
    expect(recovered).toHaveBeenCalledTimes(1)
  })

  it('does not publish or reconnect after disposal and releases late subscriptions', async () => {
    const pending = deferred<string>()
    getServerUrl.mockReturnValueOnce(pending.promise)
    stop = startDesktopServerRecovery({ host, onRecovered: recovered })
    stop()
    pending.resolve('http://127.0.0.1:62706')
    await flush()
    expect(recovered).not.toHaveBeenCalled()
    expect(getBaseUrl()).toContain('60132')
    expect(off).toHaveBeenCalledOnce()
  })

  it('never changes browser or H5 connections', async () => {
    stop = startDesktopServerRecovery({ host: { ...host, isDesktop: false }, onRecovered: recovered })
    await vi.advanceTimersByTimeAsync(20000)
    expect(getServerUrl).not.toHaveBeenCalled()
    expect(host.runtime.onServerChanged).not.toHaveBeenCalled()
  })
})
