import type { ProviderModelCatalogEntry } from '../../types/provider.js'

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

export async function exchangeSeasunCallback(raw: string, signal: AbortSignal, request: typeof fetch = fetch) {
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
  if (!accessToken) throw new Error('login_failed')
  const keys = await request(`${SEASUN_MANAGER}/api/v1/auth/me/api-key`, {
    headers: { Authorization: `Bearer ${accessToken}` }, redirect: 'error',
    signal: AbortSignal.any([signal, AbortSignal.timeout(20000)]),
  })
  if (keys.status === 403) return { apiKey: '', modelCatalog: [], identityConnected: true as const }
  if (!keys.ok) throw new Error('login_failed')
  const payload = await boundedJson(keys)
  if (payload.code !== 0 || !payload.data || typeof payload.data !== 'object') throw new Error('login_failed')
  const data = payload.data
  return { apiKey: typeof data.apiKey === 'string' ? data.apiKey : '', modelCatalog: parseSeasunModels(data.models), identityConnected: true as const }
}
