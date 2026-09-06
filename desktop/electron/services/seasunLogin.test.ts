import { EventEmitter } from 'node:events'
import type { BrowserWindow, BrowserWindowConstructorOptions } from 'electron'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SeasunLoginService, createSeasunBackendRequest, isSeasunCallback, isSeasunLoginUrl, isSeasunIpcSource, isSeasunIpcSender } from './seasunLogin'

const LOGIN = 'https://sso.seasungame.com/seasun-login/#/auth/login?channel=tokenHub&redirect=ccswitch%3A%2F%2Fseasun-sso%2Fcallback'
const CALLBACK = 'ccswitch://seasun-sso/callback?token=fake-token&verifySign=fake-sign&tokenType=8'
const CONNECTED = { phase: 'connected', identityConnected: true, loggedIn: true, pending: false, active: false, modelAccess: 'unknown', providerId: 'seasun-test' }
const flush = async () => { for (let i = 0; i < 8; i++) await Promise.resolve() }

class FakeWindow extends EventEmitter {
  destroyed = false
  readonly session = Object.assign(new EventEmitter(), {
    setPermissionRequestHandler: vi.fn(), setPermissionCheckHandler: vi.fn(),
    clearStorageData: vi.fn(async () => {}), clearCache: vi.fn(async () => {}),
  })
  readonly webContents = Object.assign(new EventEmitter(), {
    session: this.session, mainFrame: { url: LOGIN }, setWindowOpenHandler: vi.fn(),
  })
  focus = vi.fn()
  loadURL = vi.fn(async () => {})
  isDestroyed() { return this.destroyed }
  destroy() { this.destroyed = true; this.emit('closed') }
  navigate(url: string, source = LOGIN, isMainFrame = true) {
    const event = { preventDefault: vi.fn(), url, isMainFrame, frame: { url: source } }
    this.webContents.emit('will-frame-navigate', event)
    return event
  }
}

function harness() {
  const parent = new FakeWindow()
  const windows: FakeWindow[] = []
  const options: BrowserWindowConstructorOptions[] = []
  const request = vi.fn(async (action: string, _body: Record<string, unknown>): Promise<unknown> => {
    if (action === 'start') return { authorizeUrl: LOGIN, attemptId: 'fake-attempt', completionSecret: 'main-only-fake', expiresAt: Date.now() + 600_000 }
    if (action === 'cancel') return { ...CONNECTED, phase: 'cancelled', loggedIn: false, identityConnected: false }
    return CONNECTED
  })
  const service = new SeasunLoginService({ request, createWindow: config => {
    options.push(config); const window = new FakeWindow(); windows.push(window); return window as unknown as BrowserWindow
  } })
  return { parent: parent as unknown as BrowserWindow, windows, options, request, service }
}

afterEach(() => vi.useRealTimers())

describe('Seasun login trust boundary', () => {
  it.each([
    CALLBACK.replace('seasun-sso', 'seasun-sso.evil'), CALLBACK.replace('/callback', '/other'),
    CALLBACK + '&token=duplicate', CALLBACK + '#token=fragment', CALLBACK.replace('tokenType=8', 'tokenType=1'),
    CALLBACK.replace('seasun-sso', 'user@seasun-sso'), CALLBACK.replace('seasun-sso', 'seasun-sso:443'),
    CALLBACK + '&unknown=value', CALLBACK.replace('fake-token', ''),
  ])('rejects malformed or unrelated callbacks', value => expect(isSeasunCallback(value)).toBe(false))

  it('requires the exact official login channel and callback', () => {
    expect(isSeasunLoginUrl(LOGIN)).toBe(true)
    expect(isSeasunLoginUrl(LOGIN.replace('tokenHub', 'other'))).toBe(false)
    expect(isSeasunLoginUrl(LOGIN.replace('sso.seasungame.com', 'sso.seasungame.com.evil'))).toBe(false)
    expect(isSeasunCallback(CALLBACK)).toBe(true)
    expect(isSeasunIpcSource('http://localhost:1234/#/settings', 'http://localhost:1234/')).toBe(true)
    expect(isSeasunIpcSource('http://localhost:9999/', 'http://localhost:1234/')).toBe(false)
    expect(isSeasunIpcSource('http://localhost:1234/other.html', 'http://localhost:1234/')).toBe(false)
    expect(isSeasunIpcSource('file:///wrong/index.html', '/app/index.html')).toBe(false)
  })

  it('requires the expected main window, its main frame, and its exact renderer entry', () => {
    const window = new FakeWindow()
    window.webContents.mainFrame.url = 'http://localhost:1420/'
    const typed = window as unknown as BrowserWindow
    const event = { sender: window.webContents, senderFrame: window.webContents.mainFrame }
    expect(isSeasunIpcSender(event, typed, 'http://localhost:1420/')).toBe(true)
    expect(isSeasunIpcSender({ ...event, sender: {} }, typed, 'http://localhost:1420/')).toBe(false)
    expect(isSeasunIpcSender({ ...event, senderFrame: { url: 'http://localhost:1420/' } }, typed, 'http://localhost:1420/')).toBe(false)
    window.webContents.mainFrame.url = 'http://localhost:1420/untrusted.html'
    expect(isSeasunIpcSender(event, typed, 'http://localhost:1420/')).toBe(false)
  })

  it('uses a single isolated window, consumes one main-frame callback, and returns no secret', async () => {
    const h = harness()
    const result = h.service.login(h.parent)
    await flush()
    expect(h.service.login(h.parent)).toBe(result)
    expect(h.windows[0]!.focus).toHaveBeenCalledOnce()
    expect(h.options[0]!.webPreferences).toMatchObject({ nodeIntegration: false, sandbox: true, contextIsolation: true, webSecurity: true })
    expect(h.options[0]!.webPreferences?.partition).not.toMatch(/^persist:/)
    expect(h.options[0]!.webPreferences?.preload).toBeUndefined()
    h.request.mockImplementation(async action => action === 'complete' ? { ...CONNECTED, token: 'never-render', completionSecret: 'never-render' } : CONNECTED)
    expect(h.windows[0]!.navigate(CALLBACK).preventDefault).toHaveBeenCalled()
    h.windows[0]!.navigate(CALLBACK)
    const status = await result
    expect(status).toEqual(CONNECTED)
    expect(h.request.mock.calls.filter(([action]) => action === 'complete')).toHaveLength(1)
    expect(h.windows[0]!.destroyed).toBe(true)
    expect(h.windows[0]!.session.clearStorageData).toHaveBeenCalledOnce()
  })

  it('does not accept callback from an iframe or an unrelated main document', async () => {
    const h = harness(); const result = h.service.login(h.parent); await flush()
    h.windows[0]!.navigate(CALLBACK, LOGIN, false)
    expect(h.request.mock.calls.some(([action]) => action === 'complete')).toBe(false)
    h.windows[0]!.navigate(CALLBACK, 'https://evil.test/')
    expect((await result).phase).toBe('error')
    expect(h.request.mock.calls.some(([action]) => action === 'complete')).toBe(false)
  })

  it('rejects cross-origin navigation and every popup', async () => {
    const h = harness(); const result = h.service.login(h.parent); await flush()
    const open = h.windows[0]!.webContents.setWindowOpenHandler.mock.calls[0]![0] as (value: unknown) => unknown
    expect(open({ url: CALLBACK })).toEqual({ action: 'deny' })
    h.windows[0]!.navigate('https://evil.test/')
    expect((await result).phase).toBe('error')
  })

  it('cancels an in-flight exchange and discards its late successful result', async () => {
    const h = harness(); const result = h.service.login(h.parent); await flush()
    let complete!: (value: unknown) => void
    h.request.mockImplementation(async action => action === 'complete' ? new Promise(resolve => { complete = resolve }) : { ...CONNECTED, phase: 'cancelled' })
    h.windows[0]!.navigate(CALLBACK)
    await h.service.cancel()
    complete(CONNECTED); await flush()
    expect((await result).phase).toBe('cancelled')
    h.windows[0]!.navigate(CALLBACK)
    expect(h.request.mock.calls.filter(([action]) => action === 'complete')).toHaveLength(1)
    expect(h.request.mock.calls.some(([action]) => action === 'cancel')).toBe(true)
  })

  it('expires and invalidates the backend attempt', async () => {
    vi.useFakeTimers()
    const h = harness(); const result = h.service.login(h.parent); await flush()
    vi.advanceTimersByTime(600_000)
    await flush()
    expect((await result).phase).toBe('expired')
    expect(h.request.mock.calls.some(([action]) => action === 'cancel')).toBe(true)
  })

  it('clears its isolated session when the user has already closed the native window', async () => {
    const h = harness(); const result = h.service.login(h.parent); await flush()
    h.windows[0]!.destroy()
    expect((await result).phase).toBe('cancelled')
    expect(h.windows[0]!.session.clearStorageData).toHaveBeenCalledOnce()
    expect(h.windows[0]!.session.clearCache).toHaveBeenCalledOnce()
  })

  it('closes immediately and reports an unconfirmed cancellation instead of claiming no save', async () => {
    const h = harness(); const result = h.service.login(h.parent); await flush()
    let rejectCancel!: (error: Error) => void
    h.request.mockImplementation(async () => new Promise((_resolve, reject) => { rejectCancel = reject }))
    const cancelled = h.service.cancel()
    expect(h.windows[0]!.destroyed).toBe(true)
    rejectCancel(new Error('private remote failure'))
    expect((await cancelled).errorCode).toBe('cancel_unconfirmed')
    expect((await result).phase).toBe('error')
  })

  it('reports a confirmed completed binding when cancellation loses the server commit race', async () => {
    const h = harness(); const result = h.service.login(h.parent); await flush()
    h.request.mockImplementation(async () => CONNECTED)
    expect((await h.service.cancel()).phase).toBe('connected')
    expect((await result).identityConnected).toBe(true)
  })

  it('cancels a start that finishes after its parent was destroyed', async () => {
    const h = harness(); let started!: (value: unknown) => void
    h.request.mockImplementation(async action => action === 'start' ? new Promise(resolve => { started = resolve }) : CONNECTED)
    const result = h.service.login(h.parent)
    h.parent.webContents.emit('destroyed')
    expect((await result).phase).toBe('cancelled')
    started({ authorizeUrl: LOGIN, attemptId: 'late', completionSecret: 'secret', expiresAt: Date.now() + 1000 })
    await flush()
    expect(h.windows).toHaveLength(0)
    expect(h.request).toHaveBeenLastCalledWith('cancel', { attemptId: 'late', completionSecret: 'secret' })
  })

  it('only sends privileged requests to the trusted loopback server and hides failures', async () => {
    const fetcher = vi.fn<typeof fetch>(async () => Response.json({ error: 'token=secret remote failure' }, { status: 500 }))
    const request = createSeasunBackendRequest(async () => ({ serverUrl: 'http://127.0.0.1:1234', localToken: 'local', integrationToken: 'private' }), fetcher as typeof fetch)
    await expect(request('start', {})).rejects.toThrow('Seasun sign-in failed')
    expect(fetcher.mock.calls[0]![1]).toMatchObject({ redirect: 'error', headers: { 'X-CC-Haha-Desktop-Integration': 'private' } })
    const invalid = createSeasunBackendRequest(async () => ({ serverUrl: 'https://evil.test', localToken: 'local', integrationToken: 'private' }), fetcher as typeof fetch)
    await expect(invalid('start', {})).rejects.toThrow('Desktop server unavailable')
    expect(fetcher).toHaveBeenCalledOnce()
  })
})
