import type { SavedProvider } from '../types/provider.js'
import { ApiError } from '../middleware/errorHandler.js'
import { ProviderService } from './providerService.js'
import { KsccOAuthService } from './ksccOAuthService.js'
import { refreshSeasunModelCatalog } from '../providerIntegrations/seasun/credentials.js'
import { setTimeout as delay } from 'node:timers/promises'

export type HeadlessProviderName = 'kscc' | 'tokenhub'
export class HeadlessProviderError extends Error {
  constructor(public readonly code: string, message: string) { super(message); this.name = 'HeadlessProviderError' }
}

function integrationId(name: HeadlessProviderName) {
  if (name === 'kscc') return 'kscc'
  if (name === 'tokenhub') return 'seasun'
  throw new HeadlessProviderError('INVALID_PROVIDER', '请选择 kscc 或 tokenhub')
}

function safeError(error: unknown): HeadlessProviderError {
  if (error instanceof HeadlessProviderError) return error
  if (error instanceof ApiError && error.statusCode === 401) return new HeadlessProviderError('LOGIN_REQUIRED', '授权已过期，请重新登录 cc-haha')
  if (error instanceof ApiError && error.statusCode === 403) return new HeadlessProviderError('PERMISSION_DENIED', '当前账号无此操作权限')
  return new HeadlessProviderError('PROVIDER_UNAVAILABLE', '服务商查询失败，请检查连接或重新登录')
}

/** Internal credential-bearing object. Never serialize this return value to CLI output. */
export async function selectHeadlessProvider(name: HeadlessProviderName): Promise<SavedProvider> {
  const presetId = integrationId(name)
  try {
    const { providers } = await new ProviderService().listProviders({ readOnly: true })
    const provider = providers.find(value => value.presetId === presetId && value.apiKey)
    if (!provider) throw new HeadlessProviderError('LOGIN_REQUIRED', '本机尚未保存该服务商身份，请先登录 cc-haha')
    return provider
  } catch (error) { throw safeError(error) }
}

export type HeadlessModel = {
  id: string
  listed: true
  catalog_access: 'available' | 'unknown'
  quota_limited: boolean | null
  source: string
  checked_at: string
}

export async function listHeadlessModels(name: HeadlessProviderName, options?: { signal?: AbortSignal }): Promise<{ provider: HeadlessProviderName; models: HeadlessModel[]; checked_at: string }> {
  const provider = await selectHeadlessProvider(name)
  const checked_at = new Date().toISOString()
  try {
    if (name === 'kscc') {
      const entries = await new KsccOAuthService({ signal: options?.signal }).fetchModelEntries(provider.apiKey, provider.baseUrl.replace(/\/+$/, ''))
      const seen = new Set<string>()
      const models = entries.flatMap(entry => {
        if (typeof entry.model !== 'string' || !entry.model.trim() || seen.has(entry.model.trim())) return []
        const id = entry.model.trim(); seen.add(id)
        return [{ id, listed: true as const, catalog_access: 'unknown' as const,
          quota_limited: typeof entry.quotaLimited === 'boolean' ? entry.quotaLimited : null,
          source: 'kscc_model_catalog', checked_at }]
      })
      return { provider: name, models, checked_at }
    }
    const entries = await refreshSeasunModelCatalog(provider, options)
    return { provider: name, models: entries.map(entry => ({ id: entry.id, listed: true, catalog_access: 'available',
      quota_limited: null, source: 'tokenhub_model_catalog', checked_at })), checked_at }
  } catch (error) { throw safeError(error) }
}

export async function loginHeadlessProvider(name: HeadlessProviderName, options: {
  onAuthorizeUrl?: (url: string) => void
  timeoutMs?: number
  pollIntervalMs?: number
  signal?: AbortSignal
} = {}): Promise<{ provider: HeadlessProviderName; logged_in: true }> {
  integrationId(name)
  try {
    options.signal?.throwIfAborted()
    await listHeadlessModels(name, options)
    return { provider: name, logged_in: true }
  } catch (error) {
    if (options.signal?.aborted) throw new HeadlessProviderError('LOGIN_CANCELLED', '登录已取消')
    const safe = safeError(error)
    if (name === 'tokenhub' || safe.code !== 'LOGIN_REQUIRED') throw safe
  }
  if (name === 'tokenhub') throw new HeadlessProviderError('LOGIN_REQUIRED', '请先使用 cc-haha 完成本人授权；当前不支持首次无界面登录')
  if (!options.onAuthorizeUrl) throw new HeadlessProviderError('LOGIN_REQUIRED', '需要本人在浏览器完成授权；当前调用未提供终端授权提示通道')
  const timeoutMs = Math.max(1, Math.min(options.timeoutMs ?? 300_000, 300_000))
  const deadline = Date.now() + timeoutMs
  const auth = new KsccOAuthService({ activateOnAuthorization: false, persistPendingLogin: false, requestTimeoutMs: Math.min(15_000, timeoutMs), signal: options.signal })
  try {
    const start = await auth.start()
    if (start.reusedLocalLogin) return { provider: name, logged_in: true }
    if (!start.authorizeUrl) throw new HeadlessProviderError('LOGIN_REQUIRED', '登录服务未提供授权地址')
    const url = new URL(start.authorizeUrl)
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash || !/^\/l\/[^/]+$/.test(url.pathname)) {
      throw new HeadlessProviderError('LOGIN_FAILED', '登录服务返回的授权地址无效')
    }
    options.signal?.throwIfAborted()
    options.onAuthorizeUrl(url.toString())
    while (Date.now() < deadline) {
      options.signal?.throwIfAborted()
      if ((await auth.status()).loggedIn) return { provider: name, logged_in: true }
      await delay(Math.min(options.pollIntervalMs ?? 1000, Math.max(1, deadline - Date.now())), undefined, { signal: options.signal })
    }
    throw new HeadlessProviderError('LOGIN_TIMEOUT', '等待本人授权超时，请重新运行登录命令')
  } catch (error) {
    if (options.signal?.aborted) throw new HeadlessProviderError('LOGIN_CANCELLED', '登录已取消')
    throw safeError(error)
  }
}
