import type { ProviderModelCatalogEntry } from '../../types/provider.js'
import { ApiError } from '../../middleware/errorHandler.js'

export type SeasunManagerCredentials = { accessToken: string; refreshToken?: string }
type SeasunAuthorization = { apiKey: string; modelCatalog: ProviderModelCatalogEntry[]; identityConnected: true; credentials?: SeasunManagerCredentials }

export const seasunReconnectRequired = () => new ApiError(401, 'Reconnect Seasun to refresh models', 'PROVIDER_RECONNECT_REQUIRED')
const modelRefreshFailed = () => new ApiError(502, 'Seasun model refresh failed; cached models were retained', 'PROVIDER_MODEL_REFRESH_FAILED')

export const SEASUN_GATEWAY = 'https://aihub.seasungame.com/airoute'
export const SEASUN_MANAGER = 'https://aihub.seasungame.com/aimanager'
export const SEASUN_LOGIN = 'https://sso.seasungame.com/seasun-login/#/auth/login?channel=tokenHub&redirect=ccswitch%3A%2F%2Fseasun-sso%2Fcallback'

export function parseSeasunCallback(raw: string) {
  if (/[\u0000-\u001f\u007f]/.test(raw)) throw new Error('invalid_callback')
  const url = new URL(raw)
  if (url.protocol !== 'ccswitch:' || url.hostname !== 'seasun-sso' || url.pathname !== '/callback' || url.username || url.password || url.port || url.hash) throw new Error('invalid_callback')
  for (const key of url.searchParams.keys()) {
    if (!['token', 'verifySign', 'tokenType', 'reqKey', 'sign', 'name'].includes(key) || url.searchParams.getAll(key).length > 1 || /[\u0000-\u001f\u007f]/.test(url.searchParams.get(key)!)) throw new Error('invalid_callback')
  }
  const token = url.searchParams.get('token'), verifySign = url.searchParams.get('verifySign')
  const tokenType = url.searchParams.get('tokenType') ?? '8'
  if (!token || !verifySign || token.length > 16384 || verifySign.length > 16384 || tokenType !== '8') throw new Error('invalid_callback')
  return { token, verifySign, tokenType }
}

export function parseSeasunModels(raw: unknown): ProviderModelCatalogEntry[] {
  if (!Array.isArray(raw)) return []
  const seen = new Set<string>()
  return raw.flatMap(value => {
    if (!value || typeof value !== 'object' || typeof value.public_model !== 'string' || !value.public_model.trim() || seen.has(value.public_model)) return []
    if (value.enabled !== true || value.available !== true || !['active', 'available'].includes(value.status)) return []
    const clients = Array.isArray(value.clients) ? value.clients : []
    const capabilities = Array.isArray(value.capabilities) ? value.capabilities : []
    const apiFormat = capabilities.includes('responses') && clients.includes('codex') ? 'openai_responses'
      : capabilities.includes('chat') && clients.includes('grok') ? 'openai_chat'
        : clients.includes('claude') ? 'anthropic' : undefined
    if (!apiFormat) return []
    seen.add(value.public_model)
    const suffix = apiFormat === 'openai_responses' ? '/responses' : apiFormat === 'openai_chat' ? '/v1/chat/completions' : '/anthropic/v1/messages'
    return [{ id: value.public_model, capabilities: [], transport: {
      apiFormat, endpoint: SEASUN_GATEWAY + suffix,
      ...(apiFormat !== 'anthropic' ? { features: { preserveReasoning: true, strictStream: true } } : {}),
    } } satisfies ProviderModelCatalogEntry]
  })
}

async function boundedJson(response: Response): Promise<any> {
  const reader = response.body?.getReader()
  if (!reader) throw new Error('login_failed')
  const chunks: Uint8Array[] = []
  let length = 0
  try {
    while (true) {
      const { value, done } = await reader.read()
      if (done) break
      length += value.length
      if (length > 2_000_000) throw new Error('login_failed')
      chunks.push(value)
    }
  } finally { await reader.cancel().catch(() => {}) }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}

export async function exchangeSeasunCallback(raw: string, signal: AbortSignal, request: typeof fetch = fetch): Promise<SeasunAuthorization> {
  const callback = parseSeasunCallback(raw)
  const url = new URL(`${SEASUN_MANAGER}/api/v1/auth/it-sso/callback`)
  for (const [key, value] of Object.entries({ token: callback.token, verifySign: callback.verifySign, sourceChannel: 'tokenHub', sourceTokenType: callback.tokenType, redirect: '/' })) url.searchParams.set(key, value)
  const response = await request(url, { redirect: 'manual', signal: AbortSignal.any([signal, AbortSignal.timeout(20000)]) })
  const location = response.headers.get('location')
  if (response.status < 300 || response.status >= 400 || !location) throw new Error('login_failed')
  const redirect = new URL(location, SEASUN_MANAGER)
  if (redirect.origin !== new URL(SEASUN_MANAGER).origin || redirect.username || redirect.password) throw new Error('login_failed')
  const fragment = new URLSearchParams(redirect.hash.slice(1))
  const tokens = [...fragment.getAll('access_token'), ...redirect.searchParams.getAll('access_token')]
  const accessToken = tokens.length === 1 ? tokens[0] : undefined
  const refreshTokens = [...fragment.getAll('refresh_token'), ...redirect.searchParams.getAll('refresh_token')]
  const refreshToken = refreshTokens[0]
  if (!validToken(accessToken) || refreshTokens.length > 1 || (refreshToken !== undefined && !validToken(refreshToken))) throw new Error('login_failed')
  const credentials = { accessToken, ...(refreshToken ? { refreshToken } : {}) }
  const keys = await request(`${SEASUN_MANAGER}/api/v1/auth/me/api-key`, {
    headers: { Authorization: `Bearer ${accessToken}` }, redirect: 'error',
    signal: AbortSignal.any([signal, AbortSignal.timeout(20000)]),
  })
  if (keys.status === 403) return { apiKey: '', modelCatalog: [], identityConnected: true, credentials }
  if (!keys.ok) throw new Error('login_failed')
  const payload = await boundedJson(keys)
  if (payload.code !== 0 || !payload.data || typeof payload.data !== 'object') throw new Error('login_failed')
  const data = payload.data
  return { apiKey: typeof data.apiKey === 'string' ? data.apiKey : '', modelCatalog: parseSeasunModels(data.models), identityConnected: true, credentials }
}

export function validToken(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 16384 && !/[\s\u0000-\u001f\u007f]/.test(value)
}

/** The manager token is distinct from the model key. Never send either to an inferred endpoint. */
export async function fetchSeasunModels(
  credentials: SeasunManagerCredentials,
  persist: (credentials: SeasunManagerCredentials) => Promise<void>,
  request: typeof fetch = fetch,
) {
  // One total deadline covers bodies, renewal and the single retry.
  const signal = AbortSignal.timeout(20000)
  try {
    let current = credentials
    for (let attempt = 0; attempt < 2; attempt++) {
      const response = await request(`${SEASUN_MANAGER}/api/v1/auth/me/api-key`, {
        headers: { Authorization: `Bearer ${current.accessToken}` }, redirect: 'error', signal,
      })
      const payload = await boundedJson(response).catch(error => { if (response.status === 401) return {}; throw error })
      signal.throwIfAborted()
      if (response.status === 401) {
        if (attempt || payload?.reason === 'IT_SSO_RELOGIN_REQUIRED' || !current.refreshToken) throw seasunReconnectRequired()
        const renewal = await request(`${SEASUN_MANAGER}/api/v1/auth/refresh`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ refresh_token: current.refreshToken }), redirect: 'error', signal,
        })
        if (renewal.status === 401 || renewal.status === 403) {
          await renewal.body?.cancel()
          throw seasunReconnectRequired()
        }
        const renewed = await boundedJson(renewal)
        signal.throwIfAborted()
        if (!renewal.ok) throw modelRefreshFailed()
        if (renewed?.code !== 0 || !validToken(renewed?.data?.access_token) || !validToken(renewed?.data?.refresh_token)) throw seasunReconnectRequired()
        current = { accessToken: renewed.data.access_token, refreshToken: renewed.data.refresh_token }
        // Persist rotation before retrying: the old refresh token may already be invalid.
        await persist(current)
        continue
      }
      if (!response.ok || payload?.code !== 0 || !payload?.data || !validToken(payload.data.apiKey)) throw modelRefreshFailed()
      const raw = payload.data.models
      // Reject malformed entries before filtering disabled/non-coding models, so
      // a partial contract failure cannot silently remove existing choices.
      if (!Array.isArray(raw) || raw.some(value => !value || typeof value.public_model !== 'string' || !value.public_model.trim() ||
        typeof value.enabled !== 'boolean' || typeof value.available !== 'boolean' || typeof value.status !== 'string' ||
        !Array.isArray(value.clients) || !value.clients.every((v: unknown) => typeof v === 'string') ||
        !Array.isArray(value.capabilities) || !value.capabilities.every((v: unknown) => typeof v === 'string'))) throw modelRefreshFailed()
      const modelCatalog = parseSeasunModels(raw)
      if (!modelCatalog.length) throw modelRefreshFailed()
      return { apiKey: payload.data.apiKey as string, modelCatalog }
    }
    throw seasunReconnectRequired()
  } catch (error) {
    if (error instanceof ApiError) throw error
    // Do not expose remote response text, URLs containing tokens, or parser errors.
    throw modelRefreshFailed()
  }
}
