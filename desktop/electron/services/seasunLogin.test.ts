import { EventEmitter } from 'node:events'
import type { BrowserWindow, BrowserWindowConstructorOptions } from 'electron'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SeasunLoginService, createSeasunBackendRequest, isSeasunCallback, isSeasunLoginUrl, isSeasunIpcSource, isSeasunIpcSender, isSeasunWpsPage } from './seasunLogin'

const LOGIN = 'https://sso.seasungame.com/seasun-login/#/auth/login?channel=tokenHub&redirect=ccswitch%3A%2F%2Fseasun-sso%2Fcallback'
const CALLBACK = 'ccswitch://seasun-sso/callback?token=fake-token&verifySign=fake-sign&tokenType=8'
const WPS_START = 'https://sso.seasungame.com/management/sso/apis/pub/wps/authorize?channel=tokenHub&redirect=ccswitch%3A%2F%2Fseasun-sso%2Fcallback'
const WPS_AUTH = 'https://openapi.wps.cn/oauth2/auth?state=fake-state'
const WPS_RETURN = 'https://sso.seasungame.com/management/sso/apis/pub/wps/callback?code=fake-code&state=fake-state'
const CONNECTED = { phase: 'connected', identityConnected: true, loggedIn: true, pending: false, active: false, modelAccess: 'unknown', providerId: 'seasun-test' }
const flush = async () => { for (let i = 0; i < 8; i++) await Promise.resolve() }

class FakeWindow extends EventEmitter {
  destroyed = false
  readonly session = Object.assign(new EventEmitter(), {
    setPermissionRequestHandler: vi.fn(), setPermissionCheckHandler: vi.fn(),
    clearStorageData: vi.fn(async () => {}), clearCache: vi.fn(async () => {}),
    cookies: { flushStore: vi.fn(async () => {}) },
  })
  readonly webContents = Object.assign(new EventEmitter(), {
    session: this.session, mainFrame: { url: LOGIN, frames: [] as unknown[] }, setWindowOpenHandler: vi.fn(),
    getURL: () => this.webContents.mainFrame.url,
  })
  focus = vi.fn()
  loadURL = vi.fn(async (url: string) => {
    this.webContents.mainFrame.url = url
    this.webContents.emit('did-navigate', {}, url)
  })
  isDestroyed() { return this.destroyed }
  destroy() { this.destroyed = true; this.emit('closed') }
  navigate(url: string, source = LOGIN, isMainFrame = true) {
    const event = { preventDefault: vi.fn(), url, isMainFrame, frame: this.webContents.mainFrame,
      initiator: source === this.webContents.mainFrame.url ? this.webContents.mainFrame : { url: source } }
    this.webContents.emit('will-frame-navigate', event)
    return event
  }
}

function harness(prepareSession?: (session: import('electron').Session) => Promise<void>) {
  const parent = new FakeWindow()
  const windows: FakeWindow[] = []
  const options: BrowserWindowConstructorOptions[] = []
  const request = vi.fn(async (action: string, _body: Record<string, unknown>): Promise<unknown> => {
    if (action === 'start') return { authorizeUrl: LOGIN, attemptId: 'fake-attempt', completionSecret: 'main-only-fake', expiresAt: Date.now() + 600_000 }
    if (action === 'cancel') return { ...CONNECTED, phase: 'cancelled', loggedIn: false, identityConnected: false }
    return CONNECTED
  })
  const service = new SeasunLoginService({ request, prepareSession, createWindow: config => {
    options.push(config); const window = new FakeWindow(); windows.push(window); return window as unknown as BrowserWindow
  } })
  return { parent: parent as unknown as BrowserWindow, windows, options, request, service }
}

afterEach(() => vi.useRealTimers())

describe('Seasun login trust boundary', () => {
  it('prepares reusable cookies before sending the first navigation', async () => {
    let ready!: () => void
    const h = harness(() => new Promise<void>(resolve => { ready = resolve }))
    const result = h.service.login(h.parent); await flush()
    expect(h.windows[0]!.loadURL).not.toHaveBeenCalled()
    ready(); await flush()
    expect(h.windows[0]!.loadURL).toHaveBeenCalledWith(LOGIN)
    await h.service.cancel(); await result
    expect(h.windows[0]!.session.cookies.flushStore).toHaveBeenCalledOnce()
    expect(h.windows[0]!.session.clearStorageData).not.toHaveBeenCalled()
  })

  it('does not navigate if the user cancels during desktop session preparation', async () => {
    let ready!: () => void
    const h = harness(() => new Promise<void>(resolve => { ready = resolve }))
    const result = h.service.login(h.parent); await flush()
    await h.service.cancel()
    ready(); await flush()
    expect((await result).phase).toBe('cancelled')
    expect(h.windows[0]!.loadURL).not.toHaveBeenCalled()
  })

  it('falls back to interactive login after a desktop cookie read failure', async () => {
    const h = harness(async () => { throw new Error('fixture failure') })
    const result = h.service.login(h.parent); await flush()
    expect(h.windows[0]!.loadURL).toHaveBeenCalledWith(LOGIN)
    await h.service.cancel(); await result
  })
  it.each([
    'http://openapi.wps.cn/oauth2/auth', 'https://openapi.wps.cn.evil.test/oauth2/auth',
    'https://evil.test/?next=https://account.wps.cn', 'https://user@account.wps.cn/',
    'https://account.wps.cn:8443/', 'https://sso.seasungame.com/management/other',
    'https://sso.seasungame.com/management/sso/apis/pub/wps/callback/extra',
  ])('does not expand WPS navigation to unrelated targets: %s', url => {
    expect(isSeasunWpsPage(url)).toBe(false)
  })

  it('follows WPS authorization, account switching and the SSO ticket return before completing once', async () => {
    const h = harness(); const result = h.service.login(h.parent); await flush()
    const window = h.windows[0]!
    expect(window.navigate(WPS_START).preventDefault).not.toHaveBeenCalled()
    for (const url of [WPS_AUTH, 'https://openapi.wps.cn/view/v7/person/authorize', 'https://account.wps.cn/v1/changeaccount', WPS_RETURN]) {
      const event = { preventDefault: vi.fn(), frame: null, initiator: null }
      window.webContents.emit('will-redirect', event, url, false, true)
      expect(event.preventDefault).not.toHaveBeenCalled()
      await window.loadURL(url)
    }
    const returned = 'https://sso.seasungame.com/seasun-login/#/auth/wps-callback?ticket=fake-ticket'
    expect(window.navigate(returned, WPS_RETURN).preventDefault).not.toHaveBeenCalled()
    await window.loadURL(returned)
    window.navigate(CALLBACK, returned)
    window.navigate(CALLBACK, returned)
    expect((await result).phase).toBe('connected')
    expect(h.request.mock.calls.filter(([action]) => action === 'complete')).toHaveLength(1)
    expect(window.session.clearStorageData).not.toHaveBeenCalled()
  })

  it('forgets WPS child history only after a full return to a fresh SSO document', async () => {
    const h = harness(); const result = h.service.login(h.parent); await flush()
    const window = h.windows[0]!
    window.navigate(WPS_START)
    await window.loadURL(WPS_AUTH)
    window.webContents.emit('frame-created', {}, { frame: { parent: window.webContents.mainFrame, detached: false } })
    expect(window.navigate('https://account.wps.cn/login', WPS_AUTH, false).preventDefault).not.toHaveBeenCalled()
    expect(window.navigate(CALLBACK, WPS_AUTH, false).preventDefault).toHaveBeenCalled()
    expect(h.request.mock.calls.some(([action]) => action === 'complete')).toBe(false)
    await window.loadURL(LOGIN)
    window.webContents.emit('will-frame-navigate', { url: CALLBACK, isMainFrame: true, frame: null, initiator: null, preventDefault: vi.fn() })
    expect((await result).phase).toBe('connected')
  })

  it.each([WPS_AUTH, WPS_START.replace('tokenHub', 'other'), WPS_START.replace('ccswitch', 'evil')])('requires the trusted SSO start before WPS navigation: %s', async url => {
    const h = harness(); const result = h.service.login(h.parent); await flush()
    expect(h.windows[0]!.navigate(url).preventDefault).toHaveBeenCalled()
    expect((await result).phase).toBe('error')
  })

  it('does not allow an iframe to initiate the WPS flow in the top frame', async () => {
    const h = harness(); const result = h.service.login(h.parent); await flush()
    const window = h.windows[0]!
    window.webContents.emit('will-frame-navigate', {
      url: WPS_START, isMainFrame: true, frame: window.webContents.mainFrame,
      initiator: { url: LOGIN }, preventDefault: vi.fn(),
    })
    expect((await result).phase).toBe('error')
  })

  it('still rejects unrelated navigation after WPS has started', async () => {
    const h = harness(); const result = h.service.login(h.parent); await flush()
    const window = h.windows[0]!
    window.navigate(WPS_START)
    await window.loadURL(WPS_AUTH)
    expect(window.navigate('https://evil.test/', WPS_AUTH, false).preventDefault).toHaveBeenCalled()
    window.navigate('https://evil.test/', WPS_AUTH)
    expect((await result).phase).toBe('error')
  })

  it('does not erase children in the returned SSO document', async () => {
    const h = harness(); const result = h.service.login(h.parent); await flush()
    const window = h.windows[0]!
    window.navigate(WPS_START)
    await window.loadURL(WPS_AUTH)
    window.webContents.mainFrame.frames.push({ url: LOGIN })
    await window.loadURL(LOGIN)
    window.webContents.emit('will-frame-navigate', { url: CALLBACK, isMainFrame: true, frame: null, initiator: null, preventDefault: vi.fn() })
    expect((await result).phase).toBe('error')
  })

  it('never accepts final credentials directly from WPS', async () => {
    const h = harness(); const result = h.service.login(h.parent); await flush()
    h.windows[0]!.navigate(WPS_START)
    await h.windows[0]!.loadURL(WPS_AUTH)
    h.windows[0]!.navigate(CALLBACK, WPS_AUTH)
    expect((await result).phase).toBe('error')
    expect(h.request.mock.calls.some(([action]) => action === 'complete')).toBe(false)
  })

  it('keeps cancellation effective while WPS is open', async () => {
    const h = harness(); const result = h.service.login(h.parent); await flush()
    h.windows[0]!.navigate(WPS_START)
    await h.windows[0]!.loadURL(WPS_AUTH)
    await h.service.cancel()
    h.windows[0]!.navigate(CALLBACK)
    expect((await result).phase).toBe('cancelled')
    expect(h.request.mock.calls.some(([action]) => action === 'complete')).toBe(false)
  })

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
    expect(h.options[0]!.webPreferences?.partition).toBe('persist:seasun-login')
    expect(h.options[0]!.webPreferences?.preload).toBeUndefined()
    h.request.mockImplementation(async action => action === 'complete' ? { ...CONNECTED, token: 'never-render', completionSecret: 'never-render' } : CONNECTED)
    expect(h.windows[0]!.navigate(CALLBACK).preventDefault).toHaveBeenCalled()
    h.windows[0]!.navigate(CALLBACK)
    const status = await result
    expect(status).toEqual(CONNECTED)
    expect(h.request.mock.calls.filter(([action]) => action === 'complete')).toHaveLength(1)
    expect(h.windows[0]!.destroyed).toBe(true)
    expect(h.windows[0]!.session.clearStorageData).not.toHaveBeenCalled()
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

  it.each(['missing-target', 'missing-all'] as const)('accepts a committed SSO main document with %s navigation metadata', async mode => {
    const h = harness(); const result = h.service.login(h.parent); await flush()
    const window = h.windows[0]!
    const event = { url: CALLBACK, isMainFrame: true, frame: null,
      initiator: mode === 'missing-target' ? window.webContents.mainFrame : null, preventDefault: vi.fn() }
    window.webContents.emit('will-frame-navigate', event)
    expect((await result).phase).toBe('connected')
    expect(event.preventDefault).toHaveBeenCalledOnce()
    expect(h.request.mock.calls.filter(([action]) => action === 'complete')).toHaveLength(1)
  })

  it.each(['child-initiator', 'unknown-initiator-with-child', 'deleted-child', 'frame-evidence-error', 'wrong-target', 'uncommitted-document', 'changed-frame', 'untrusted-current-page'] as const)('rejects callback from %s despite targeting the main frame', async mode => {
    const h = harness(); const result = h.service.login(h.parent); await flush()
    const window = h.windows[0]!, main = window.webContents.mainFrame
    const child = { url: LOGIN }
    if (mode === 'unknown-initiator-with-child') main.frames.push(child)
    if (mode === 'deleted-child') {
      main.frames.push(child)
      window.webContents.emit('frame-created', {}, { frame: { ...child, parent: main, detached: false } })
      main.frames.pop()
      // A later trusted document commit does not erase the earlier iframe evidence.
      window.webContents.emit('did-navigate', {}, LOGIN)
    }
    if (mode === 'frame-evidence-error') window.webContents.emit('frame-created', {}, { get frame() { throw new Error('detached frame') } })
    if (mode === 'uncommitted-document') window.webContents.emit('did-navigate', {}, 'about:blank')
    if (mode === 'changed-frame') window.webContents.mainFrame = { url: LOGIN, frames: [] }
    if (mode === 'untrusted-current-page') main.url = 'https://evil.test/'
    window.webContents.emit('will-frame-navigate', {
      url: CALLBACK, isMainFrame: true, preventDefault: vi.fn(),
      frame: mode === 'wrong-target' ? child : null,
      initiator: mode === 'child-initiator' ? child : null,
    })
    expect((await result).phase).toBe('error')
    expect(h.request.mock.calls.some(([action]) => action === 'complete')).toBe(false)
    expect(h.request.mock.calls.some(([action]) => action === 'cancel')).toBe(true)
  })

  it('accepts a verified main-frame initiator after child history but rejects unreadable metadata', async () => {
    const h = harness(); const result = h.service.login(h.parent); await flush()
    const window = h.windows[0]!, main = window.webContents.mainFrame
    window.webContents.emit('frame-created', {}, { frame: { url: LOGIN, parent: main, detached: false } })
    window.navigate(CALLBACK)
    expect((await result).phase).toBe('connected')

    const other = harness(); const rejected = other.service.login(other.parent); await flush()
    other.windows[0]!.webContents.emit('will-frame-navigate', {
      url: CALLBACK, isMainFrame: true, preventDefault: vi.fn(),
      get initiator() { throw new Error('frame destroyed') },
    })
    expect((await rejected).phase).toBe('error')
    expect(other.request.mock.calls.some(([action]) => action === 'complete')).toBe(false)
  })

  it('applies the same missing-metadata and iframe boundary to redirects', async () => {
    for (const withChild of [false, true]) {
      const h = harness(); const result = h.service.login(h.parent); await flush()
      const window = h.windows[0]!
      if (withChild) window.webContents.mainFrame.frames.push({ url: LOGIN })
      const event = { preventDefault: vi.fn(), frame: null, initiator: null }
      window.webContents.emit('will-redirect', event, CALLBACK, false, true)
      expect((await result).phase).toBe(withChild ? 'error' : 'connected')
      expect(event.preventDefault).toHaveBeenCalledOnce()
      expect(h.request.mock.calls.some(([action]) => action === 'complete')).toBe(!withChild)
    }
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

  it('retains its login session when the user has already closed the native window', async () => {
    const h = harness(); const result = h.service.login(h.parent); await flush()
    h.windows[0]!.destroy()
    expect((await result).phase).toBe('cancelled')
    expect(h.windows[0]!.session.clearStorageData).not.toHaveBeenCalled()
    expect(h.windows[0]!.session.clearCache).not.toHaveBeenCalled()
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
