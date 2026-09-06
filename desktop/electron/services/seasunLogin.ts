import { randomUUID } from 'node:crypto'
import { pathToFileURL } from 'node:url'
import type { BrowserWindow, BrowserWindowConstructorOptions, Session, WebFrameMain } from 'electron'
import { localSeasunStatus, parseSeasunStatus, type SeasunStatus } from '../../src/providerBusinesses/seasun/types'

const SSO_ORIGIN = 'https://sso.seasungame.com'
const MAX_LOGIN_MS = 10 * 60 * 1000
type LoginStart = { attemptId: string; completionSecret: string; authorizeUrl: string; expiresAt: string | number }
type LoginAction = 'start' | 'complete' | 'cancel'
type BackendAccess = { serverUrl: string; localToken: string; integrationToken: string }

export function createSeasunBackendRequest(resolveAccess: () => Promise<BackendAccess>, request: typeof fetch = fetch) {
  return async (action: LoginAction, body: Record<string, unknown>): Promise<unknown> => {
    const access = await resolveAccess()
    const server = new URL(access.serverUrl)
    if (server.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(server.hostname)
      || server.username || server.password || server.search || server.hash || server.pathname !== '/') throw new Error('Desktop server unavailable')
    const response = await request(new URL(`/api/provider-integrations/seasun/${action}`, server), {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(60_000),
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${access.localToken}`, 'X-CC-Haha-Desktop-Integration': access.integrationToken },
      body: JSON.stringify(body),
    })
    if (!response.ok) throw new Error('Seasun sign-in failed')
    return response.json()
  }
}
type LoginDeps = {
  createWindow(options: BrowserWindowConstructorOptions): BrowserWindow
  request(action: LoginAction, body: Record<string, unknown>): Promise<unknown>
}
type Attempt = {
  result: Promise<SeasunStatus>
  resolve(status: SeasunStatus): void
  window?: BrowserWindow
  session?: Session
  credentials?: LoginStart
  timer?: ReturnType<typeof setTimeout>
  settled: boolean
  accepting: boolean
  cancelled: boolean
  parent: BrowserWindow
  parentClosed(): void
}

export function isSeasunIpcSource(raw: string, rendererEntry: string): boolean {
  try {
    const expected = /^https?:/.test(rendererEntry) ? new URL(rendererEntry) : pathToFileURL(rendererEntry)
    const actual = new URL(raw)
    return actual.protocol === expected.protocol && actual.host === expected.host && actual.pathname === expected.pathname
      && actual.search === expected.search && !actual.username && !actual.password
  } catch { return false }
}

export function isSeasunIpcSender(event: { sender: unknown; senderFrame: { url: string } | null }, window: BrowserWindow | null, entry: string): boolean {
  return !!window && event.sender === window.webContents && event.senderFrame === window.webContents.mainFrame
    && isSeasunIpcSource(event.senderFrame.url, entry)
}

export function isSeasunPage(raw: string): boolean {
  try {
    const url = new URL(raw)
    return url.origin === SSO_ORIGIN && !url.username && !url.password && !url.port
      && url.pathname.startsWith('/seasun-login/')
  } catch { return false }
}

export function isSeasunLoginUrl(raw: string): boolean {
  if (!isSeasunPage(raw)) return false
  const url = new URL(raw)
  const [route, query = ''] = url.hash.slice(1).split('?')
  const params = new URLSearchParams(query)
  return url.pathname === '/seasun-login/' && !url.search && route === '/auth/login' && params.size === 2
    && params.getAll('channel').length === 1 && params.get('channel') === 'tokenHub'
    && params.getAll('redirect').length === 1 && params.get('redirect') === 'ccswitch://seasun-sso/callback'
}

export function isSeasunCallback(raw: string): boolean {
  try {
    const url = new URL(raw)
    if (url.protocol !== 'ccswitch:' || url.hostname !== 'seasun-sso' || url.pathname !== '/callback'
      || url.username || url.password || url.port || url.hash) return false
    const allowed = new Set(['token', 'verifySign', 'tokenType', 'reqKey', 'sign', 'name'])
    for (const key of url.searchParams.keys()) {
      if (!allowed.has(key) || url.searchParams.getAll(key).length !== 1) return false
    }
    for (const key of ['token', 'verifySign']) {
      const value = url.searchParams.get(key)
      if (!value?.trim() || value.length > 16384 || /[\u0000-\u001f\u007f]/.test(value)) return false
    }
    return raw.length <= 65536 && (!url.searchParams.has('tokenType') || url.searchParams.get('tokenType') === '8')
  } catch { return false }
}

/** No renderer, URL, or exception text is used as a backend target. */
export class SeasunLoginService {
  private attempt: Attempt | null = null
  constructor(private readonly deps: LoginDeps) {}

  login(parent: BrowserWindow): Promise<SeasunStatus> {
    if (this.attempt) {
      this.attempt.window?.focus()
      return this.attempt.result
    }
    let resolve!: Attempt['resolve']
    const result = new Promise<SeasunStatus>(done => { resolve = done })
    const attempt: Attempt = {
      result, resolve, parent, settled: false, accepting: true, cancelled: false,
      parentClosed: () => { void this.cancel() },
    }
    this.attempt = attempt
    parent.webContents.once('destroyed', attempt.parentClosed)
    attempt.timer = setTimeout(() => { void this.cancel('expired') }, MAX_LOGIN_MS)
    void this.open(attempt)
    return result
  }

  async cancel(phase: 'cancelled' | 'expired' | 'error' = 'cancelled'): Promise<SeasunStatus> {
    const attempt = this.attempt
    const status = localSeasunStatus(phase)
    if (!attempt) return status
    if (attempt.cancelled) return attempt.result
    attempt.cancelled = true
    attempt.accepting = false
    this.closeWindow(attempt)
    // Invalidate remotely before resolving cancellation, including during exchange.
    const confirmed = attempt.credentials ? await this.cancelRemote(attempt.credentials) : status
    const result = confirmed?.phase === 'connected' ? confirmed
      : confirmed ? { ...confirmed, phase } : { ...status, phase: 'error' as const, errorCode: 'cancel_unconfirmed' }
    this.finish(attempt, result)
    return parseSeasunStatus(result)
  }

  private async cancelRemote(credentials: LoginStart) {
    try {
      return parseSeasunStatus(await this.deps.request('cancel', { attemptId: credentials.attemptId, completionSecret: credentials.completionSecret }))
    } catch { return null }
  }

  private async open(attempt: Attempt) {
    try {
      const raw = await this.deps.request('start', {}) as Partial<LoginStart>
      if (typeof raw.attemptId !== 'string' || !raw.attemptId || typeof raw.completionSecret !== 'string'
        || !raw.completionSecret || typeof raw.authorizeUrl !== 'string' || !isSeasunLoginUrl(raw.authorizeUrl)) {
        throw new Error('Invalid login contract')
      }
      const expires = typeof raw.expiresAt === 'number' ? raw.expiresAt : Date.parse(String(raw.expiresAt))
      if (!Number.isFinite(expires) || expires <= Date.now()) throw new Error('Expired login contract')
      const credentials = raw as LoginStart
      attempt.credentials = credentials
      if (attempt.cancelled || attempt.settled) { await this.cancelRemote(credentials); return }
      clearTimeout(attempt.timer)
      attempt.timer = setTimeout(() => { void this.cancel('expired') }, Math.min(MAX_LOGIN_MS, expires - Date.now()))
      const window = this.deps.createWindow({
        width: 1000, height: 800, parent: attempt.parent, title: 'Seasun Token Hub · cc-haha',
        autoHideMenuBar: true,
        webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true, webSecurity: true, partition: `seasun-login-${randomUUID()}` },
      })
      attempt.window = window
      const contents = window.webContents
      attempt.session = contents.session
      contents.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false))
      contents.session.setPermissionCheckHandler(() => false)
      contents.session.on('will-download', event => event.preventDefault())
      contents.on('will-attach-webview', event => event.preventDefault())
      let committedSsoFrame: WebFrameMain | null = null
      // Sticky for this dedicated window: removing an iframe must not erase its provenance.
      let subframeObserved = false
      contents.on('frame-created', (_event, details) => {
        try {
          if (!details.frame || details.frame.detached || details.frame.parent !== null) subframeObserved = true
        } catch { subframeObserved = true }
      })
      contents.on('did-navigate', (_event, url) => {
        try {
          committedSsoFrame = isSeasunPage(url) ? contents.mainFrame : null
          if (contents.mainFrame.frames.length > 0) subframeObserved = true
        } catch { committedSsoFrame = null; subframeObserved = true }
      })
      // window.open provides no reliable initiating frame identity, so never consume it.
      contents.setWindowOpenHandler(() => ({ action: 'deny' }))
      const trustedSource = (event: { frame?: WebFrameMain | null; initiator?: WebFrameMain | null }) => {
        try {
          const main = contents.mainFrame
          if (main !== committedSsoFrame || !isSeasunPage(main.url) || !isSeasunPage(contents.getURL())) return false
          // Electron's frame is the navigation target, not its initiator, and may be null.
          if (event.frame && event.frame !== main) return false
          if (event.initiator) return event.initiator === main && isSeasunPage(event.initiator.url)
          // With no initiator metadata, trust only this committed, childless SSO document.
          // An iframe targeting _top must never inherit the top frame's trust.
          return !subframeObserved && main.frames.length === 0
        } catch { return false }
      }
      const navigate = (event: { preventDefault(): void; frame?: WebFrameMain | null; initiator?: WebFrameMain | null }, target: string, isMainFrame: boolean) => {
        if (!isMainFrame) { event.preventDefault(); return }
        if (isSeasunCallback(target)) {
          const trusted = trustedSource(event)
          event.preventDefault()
          if (trusted) void this.complete(attempt, target)
          else void this.cancel('error')
          return
        }
        if (!isSeasunPage(target)) { event.preventDefault(); void this.cancel('error') }
      }
      contents.on('will-frame-navigate', event => navigate(event, event.url, event.isMainFrame))
      contents.on('will-redirect', (event, url, _inPlace, isMainFrame) => navigate(event, url, isMainFrame))
      window.on('closed', () => { if (!attempt.settled && !attempt.cancelled) void this.cancel() })
      await window.loadURL(credentials.authorizeUrl)
    } catch {
      if (!attempt.cancelled && !attempt.settled) await this.cancel('error')
    }
  }

  private async complete(attempt: Attempt, callbackUrl: string) {
    if (attempt !== this.attempt || !attempt.accepting || attempt.cancelled || attempt.settled || !attempt.credentials) return
    attempt.accepting = false
    try {
      const result = await this.deps.request('complete', {
        attemptId: attempt.credentials.attemptId, completionSecret: attempt.credentials.completionSecret, callbackUrl,
      })
      if (!attempt.cancelled && !attempt.settled) this.finish(attempt, parseSeasunStatus(result))
    } catch {
      if (!attempt.cancelled && !attempt.settled) await this.cancel('error')
    }
  }

  private finish(attempt: Attempt, status: SeasunStatus) {
    if (attempt.settled) return
    attempt.settled = true
    clearTimeout(attempt.timer)
    attempt.parent.webContents.removeListener('destroyed', attempt.parentClosed)
    this.closeWindow(attempt)
    attempt.credentials = undefined
    if (this.attempt === attempt) this.attempt = null
    attempt.resolve(parseSeasunStatus(status))
  }

  private closeWindow(attempt: Attempt) {
    if (attempt.window && !attempt.window.isDestroyed()) attempt.window.destroy()
    const session = attempt.session
    attempt.session = undefined
    if (session) {
      void session.clearStorageData().catch(() => {})
      void session.clearCache().catch(() => {})
    }
  }
}
