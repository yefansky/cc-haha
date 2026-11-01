import type { ApiFormat, ProviderModelCatalogEntry, SavedProvider } from '../types/provider.js'
import { ApiError } from '../middleware/errorHandler.js'
import { ProviderService } from './providerService.js'
import { KsccOAuthService } from './ksccOAuthService.js'
import { refreshSeasunModelCatalog } from '../providerIntegrations/seasun/credentials.js'
import { setTimeout as delay } from 'node:timers/promises'
import { providerIntegrations } from '../providerIntegrations/index.js'
import { redactHeadlessValue } from '../../utils/headlessRedaction.js'

export type HeadlessProviderReference = string
export type HeadlessProviderName = HeadlessProviderReference
export class HeadlessProviderError extends Error {
  constructor(public readonly code: string, message: string) { super(message); this.name = 'HeadlessProviderError' }
}

const aliasPreset = (reference: string) => reference === 'kscc' ? 'kscc' : reference === 'tokenhub' ? 'seasun' : undefined
const providerAlias = (preset: string) => preset === 'kscc' ? 'kscc' : preset === 'seasun' ? 'tokenhub' : undefined
const metadataSecrets = (providers: SavedProvider[]) => providers.flatMap(provider => [provider.apiKey, provider.imageGeneration?.apiKey]).filter((value): value is string => !!value)

/** Shared query-output guard. Credentials remain private to this local read. */
export async function redactHeadlessProviderMetadata<T>(value: T): Promise<T> {
  try {
    const { providers } = await new ProviderService().listProviders({ readOnly: true })
    return redactHeadlessValue(value, metadataSecrets(providers)) as T
  } catch (error) { throw safeError(error) }
}

export type HeadlessProviderSummary = {
  id: string; provider_id: string; name: string; preset: string; alias?: 'kscc' | 'tokenhub'
  configured: true; active: boolean; status: 'configured'; credential_status: 'present' | 'unknown'
  capabilities: { run: boolean; run_status: 'supported' | 'unsupported'; run_reason: string; models: 'remote' | 'local'; pricing: 'unknown'; usage: 'local_tokens_and_account_quota' | 'local_tokens'; login: 'enterprise' | 'manual' }
}

/** Public projection only: no endpoint, credential, notes or arbitrary saved fields. */
export async function listHeadlessProviders(): Promise<{ schema_version: 2; providers: HeadlessProviderSummary[]; checked_at: string }> {
  try {
    const index = await new ProviderService().listProviders({ readOnly: true })
    return redactHeadlessValue({ schema_version: 2, checked_at: new Date().toISOString(), providers: index.providers.map((provider): HeadlessProviderSummary => ({
      id: provider.id, provider_id: provider.id, name: provider.name, preset: provider.presetId,
      ...(providerAlias(provider.presetId) ? { alias: providerAlias(provider.presetId) } : {}),
      configured: true, active: index.activeId === provider.id, status: 'configured', credential_status: provider.apiKey ? 'present' : 'unknown',
      capabilities: { run: !provider.runtimeKind || provider.runtimeKind === 'anthropic_compatible',
        run_status: !provider.runtimeKind || provider.runtimeKind === 'anthropic_compatible' ? 'supported' : 'unsupported',
        run_reason: !provider.runtimeKind || provider.runtimeKind === 'anthropic_compatible' ? '沿现有API兼容运行时；当前账号和模型可用性仍需分别核验' : '独立命令行尚未支持此专用OAuth运行时；配置仍可查询，不自动启动其他授权流程',
        models: providerIntegrations.forPreset(provider.presetId)?.fetchModelCatalog ? 'remote' : 'local', pricing: 'unknown',
        usage: provider.presetId === 'seasun' ? 'local_tokens_and_account_quota' : 'local_tokens', login: providerAlias(provider.presetId) ? 'enterprise' : 'manual' },
    })) }, metadataSecrets(index.providers))
  } catch (error) { throw safeError(error) }
}

function safeError(error: unknown): HeadlessProviderError {
  if (error instanceof HeadlessProviderError) return error
  if (error instanceof ApiError && error.statusCode === 401) return new HeadlessProviderError('LOGIN_REQUIRED', '授权已过期，请重新登录 cc-haha')
  if (error instanceof ApiError && error.statusCode === 403) return new HeadlessProviderError('PERMISSION_DENIED', '当前账号无此操作权限')
  return new HeadlessProviderError('PROVIDER_UNAVAILABLE', '服务商查询失败，请检查连接或重新登录')
}

/** Internal credential-bearing object. Never serialize this return value to CLI output. */
export async function selectHeadlessProvider(name: HeadlessProviderName): Promise<SavedProvider> {
  try {
    const { providers } = await new ProviderService().listProviders({ readOnly: true })
    const exact = providers.find(provider => provider.id === name)
    if (exact) return exact
    const presetId = aliasPreset(name)
    if (!presetId) throw new HeadlessProviderError('INVALID_PROVIDER', '服务商不存在，请使用 providers 列出的准确标识')
    const matches = providers.filter(value => value.presetId === presetId)
    if (matches.length > 1) throw new HeadlessProviderError('AMBIGUOUS_PROVIDER', '该别名对应多个配置，请使用 providers 列出的准确标识')
    if (!matches.length) throw new HeadlessProviderError('LOGIN_REQUIRED', '本机尚未保存该服务商身份，请先登录 cc-haha')
    return matches[0]!
  } catch (error) { throw safeError(error) }
}

export type HeadlessModel = {
  id: string
  listed: true
  catalog_access: 'available' | 'unknown'
  quota_limited: boolean | null
  source: string
  checked_at: string
  protocol: ApiFormat | null
  protocol_source: 'configured' | 'catalog' | 'unknown'
  capabilities: string[]
  capabilities_source: 'configured' | 'catalog' | 'unknown'
  context_window_tokens: number | null
  context_source: 'configured' | 'unknown'
  freshness: 'live' | 'configured'
  call_access: 'unknown'
  permission: { status: 'unknown'; source: 'not_probed'; checked_at: null }
}

export async function listHeadlessModels(name: HeadlessProviderName, options?: { signal?: AbortSignal; noNetwork?: boolean }): Promise<{ schema_version: 2; provider: HeadlessProviderReference; provider_id: string; status: 'ok'; models: HeadlessModel[]; checked_at: string }> {
  const provider = await selectHeadlessProvider(name)
  const checked_at = new Date().toISOString()
  try {
    const project = (entry: ProviderModelCatalogEntry, source: string, freshness: 'live' | 'configured', catalogAccess: HeadlessModel['catalog_access'], quotaLimited: boolean | null = null): HeadlessModel => {
      const context = provider.modelContextWindows?.[entry.id]
      return { id: entry.id, listed: true, catalog_access: catalogAccess, quota_limited: quotaLimited, source, checked_at,
        protocol: entry.transport?.apiFormat ?? provider.apiFormat ?? null,
        protocol_source: entry.transport ? freshness === 'live' ? 'catalog' : 'configured' : provider.apiFormat ? 'configured' : 'unknown', capabilities: [...entry.capabilities],
        capabilities_source: entry.capabilities.length ? freshness === 'live' ? 'catalog' : 'configured' : 'unknown',
        context_window_tokens: typeof context === 'number' && Number.isSafeInteger(context) && context > 0 ? context : null,
        context_source: typeof context === 'number' && Number.isSafeInteger(context) && context > 0 ? 'configured' : 'unknown',
        freshness, call_access: 'unknown', permission: { status: 'unknown', source: 'not_probed', checked_at: null } }
    }
    const result = (models: HeadlessModel[]) => redactHeadlessProviderMetadata({ schema_version: 2 as const, provider: name, provider_id: provider.id, status: 'ok' as const, models, checked_at })
    if (provider.presetId === 'kscc' && !options?.noNetwork) {
      if (!provider.apiKey) throw new HeadlessProviderError('LOGIN_REQUIRED', '服务商尚未保存有效授权')
      const entries = await new KsccOAuthService({ signal: options?.signal }).fetchModelEntries(provider.apiKey, provider.baseUrl.replace(/\/+$/, ''))
      const seen = new Set<string>()
      const models = entries.flatMap(entry => {
        if (typeof entry.model !== 'string' || !entry.model.trim() || seen.has(entry.model.trim())) return []
        const id = entry.model.trim(); seen.add(id)
        const configured = provider.modelCatalog?.find(model => model.id === id)
        const model = project(configured ?? { id, capabilities: [] }, 'kscc_model_catalog', 'live', 'unknown', typeof entry.quotaLimited === 'boolean' ? entry.quotaLimited : null)
        model.capabilities_source = configured?.capabilities.length ? 'configured' : 'unknown'
        model.protocol_source = configured?.transport || provider.apiFormat ? 'configured' : 'unknown'
        return [model]
      })
      return result(models)
    }
    const integration = providerIntegrations.forPreset(provider.presetId)
    if (integration?.fetchModelCatalog && !options?.noNetwork) {
      const entries = provider.presetId === 'seasun' ? await refreshSeasunModelCatalog(provider, options) : await integration.fetchModelCatalog(provider)
      return result(entries.map(entry => project(entry, `${providerAlias(provider.presetId) ?? 'provider'}_model_catalog`, 'live', 'available')))
    }
    const catalog = provider.modelCatalog?.length ? provider.modelCatalog : [...new Set(Object.values(provider.models).filter(Boolean))].map(id => ({ id, capabilities: [] }))
    return result(catalog.map(entry => project(entry, provider.modelCatalog?.length ? 'configured_catalog' : 'model_mapping', 'configured', 'unknown')))
  } catch (error) { throw safeError(error) }
}

export async function loginHeadlessProvider(name: HeadlessProviderName, options: {
  onAuthorizeUrl?: (url: string) => void
  timeoutMs?: number
  pollIntervalMs?: number
  signal?: AbortSignal
} = {}): Promise<{ schema_version: 2; provider: HeadlessProviderReference; provider_id: string; logged_in: true }> {
  let selected: SavedProvider | undefined
  try { selected = await selectHeadlessProvider(name) } catch (error) {
    if (!(error instanceof HeadlessProviderError) || error.code !== 'LOGIN_REQUIRED' || name !== 'kscc') throw error
  }
  if (selected && !providerAlias(selected.presetId)) throw new HeadlessProviderError('LOGIN_UNSUPPORTED', '此服务商需在原有配置界面或客户端手动授权；命令行不创建新的登录流程')
  const completed = async () => redactHeadlessProviderMetadata({ schema_version: 2 as const, provider: name, provider_id: (await selectHeadlessProvider(name)).id, logged_in: true as const })
  try {
    options.signal?.throwIfAborted()
    await listHeadlessModels(name, options)
    return await completed()
  } catch (error) {
    if (options.signal?.aborted) throw new HeadlessProviderError('LOGIN_CANCELLED', '登录已取消')
    const safe = safeError(error)
    if (name !== 'kscc' || safe.code !== 'LOGIN_REQUIRED') throw safe
  }
  // The legacy KSCC exchange saves by preset, so it cannot safely reauthorize one
  // of several same-preset accounts. Validation by exact ID above remains supported.
  const saved = await new ProviderService().listProviders({ readOnly: true })
  if (saved.providers.filter(provider => provider.presetId === 'kscc').length > 1) throw new HeadlessProviderError('LOGIN_REQUIRED', '多个同类配置请先在配置界面对准确服务商重新授权')
  if (!options.onAuthorizeUrl) throw new HeadlessProviderError('LOGIN_REQUIRED', '需要本人在浏览器完成授权；当前调用未提供终端授权提示通道')
  const timeoutMs = Math.max(1, Math.min(options.timeoutMs ?? 300_000, 300_000))
  const deadline = Date.now() + timeoutMs
  const auth = new KsccOAuthService({ activateOnAuthorization: false, persistPendingLogin: false, requestTimeoutMs: Math.min(15_000, timeoutMs), signal: options.signal })
  try {
    const start = await auth.start()
    if (start.reusedLocalLogin) return await completed()
    if (!start.authorizeUrl) throw new HeadlessProviderError('LOGIN_REQUIRED', '登录服务未提供授权地址')
    const url = new URL(start.authorizeUrl)
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash || !/^\/l\/[^/]+$/.test(url.pathname)) {
      throw new HeadlessProviderError('LOGIN_FAILED', '登录服务返回的授权地址无效')
    }
    options.signal?.throwIfAborted()
    options.onAuthorizeUrl(url.toString())
    while (Date.now() < deadline) {
      options.signal?.throwIfAborted()
      if ((await auth.status()).loggedIn) return await completed()
      await delay(Math.min(options.pollIntervalMs ?? 1000, Math.max(1, deadline - Date.now())), undefined, { signal: options.signal })
    }
    throw new HeadlessProviderError('LOGIN_TIMEOUT', '等待本人授权超时，请重新运行登录命令')
  } catch (error) {
    if (options.signal?.aborted) throw new HeadlessProviderError('LOGIN_CANCELLED', '登录已取消')
    throw safeError(error)
  }
}
