import { afterEach, beforeEach, expect, spyOn, test } from 'bun:test'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { SeasunAuthService } from '../providerIntegrations/seasun/auth.js'
import { exchangeSeasunCallback, SEASUN_MANAGER } from '../providerIntegrations/seasun/protocol.js'
import { ProviderService } from '../services/providerService.js'
import { handleApiRequest } from '../router.js'

const model = (id: string, clients = ['codex'], capabilities = ['responses']) => ({ public_model: id, clients, capabilities, enabled: true, available: true, status: 'active' })
let home: string
let previous: string | undefined
let originalFetch: typeof fetch
let directory: unknown
let unauthorized = false
let calls: { path: string; authorization: string | null }[]
beforeEach(async () => {
  previous = process.env.CLAUDE_CONFIG_DIR
  home = await fs.mkdtemp(path.join(os.tmpdir(), 'seasun-refresh-'))
  process.env.CLAUDE_CONFIG_DIR = home
  originalFetch = globalThis.fetch
  directory = [model('kept'), model('removed')]
  unauthorized = false; calls = []
  globalThis.fetch = (async (input, init) => {
    const url = new URL(String(input))
    expect(url.origin).toBe(new URL(SEASUN_MANAGER).origin)
    const authorization = new Headers(init?.headers).get('Authorization')
    calls.push({ path: url.pathname, authorization })
    if (url.pathname.endsWith('/it-sso/callback')) return new Response(null, { status: 302, headers: { location: 'https://aihub.seasungame.com/#access_token=fake-manager&refresh_token=fake-refresh&expires_in=3600' } })
    if (url.pathname.endsWith('/auth/refresh')) {
      expect(authorization).toBeNull()
      expect(JSON.parse(String(init?.body))).toEqual({ refresh_token: 'fake-refresh' })
      return Response.json({ code: 0, data: { access_token: 'fake-renewed', refresh_token: 'fake-rotated', expires_in: 3600 } })
    }
    expect(url.pathname).toBe('/aimanager/api/v1/auth/me/api-key')
    expect(init?.redirect).toBe('error')
    if (unauthorized && authorization !== 'Bearer fake-renewed') return Response.json({}, { status: 401 })
    return Response.json({ code: 0, data: { apiKey: 'fake-model-key', models: directory } })
  }) as typeof fetch
})
afterEach(async () => {
  globalThis.fetch = originalFetch
  if (previous === undefined) delete process.env.CLAUDE_CONFIG_DIR; else process.env.CLAUDE_CONFIG_DIR = previous
  await fs.rm(home, { recursive: true, force: true })
})
async function login() {
  const auth = new SeasunAuthService({ exchange: (raw, signal) => exchangeSeasunCallback(raw, signal) })
  const attempt = await auth.start()
  const result = await auth.complete({ ...attempt, callbackUrl: 'ccswitch://seasun-sso/callback?token=fake-sso&verifySign=fake-sign' })
  expect(result.phase).toBe('connected')
  return (await new ProviderService().listProviders()).providers.find(p => p.presetId === 'seasun')!
}
async function refresh(id: string) {
  const url = new URL(`http://localhost/api/providers/${id}/refresh-models`)
  return handleApiRequest(new Request(url, { method: 'POST' }), url)
}

test('login persists backend refresh credentials; a fresh service updates the directory through the real API without activation', async () => {
  const provider = await login()
  const service = new ProviderService()
  expect(service.modelRefreshProviderIds([provider])).toEqual([provider.id])
  directory = [model('kept'), model('new-chat', ['grok'], ['chat']), model('new-claude', ['claude'], ['chat']), { ...model('disabled'), enabled: false }]
  const response = await refresh(provider.id)
  expect(response.status).toBe(200)
  const text = await response.text()
  expect(text).not.toMatch(/fake-manager|fake-refresh|fake-sso/)
  const saved = await service.getProvider(provider.id)
  expect(saved.models.main).toBe('kept')
  expect(saved.modelCatalog?.map(m => m.id)).toEqual(['kept', 'new-chat', 'new-claude'])
  expect(saved.modelCatalog?.map(m => m.transport?.apiFormat)).toEqual(['openai_responses', 'openai_chat', 'anthropic'])
  expect((await service.listProviders()).activeId).toBeNull()
  expect(calls.at(-1)?.authorization).toBe('Bearer fake-manager')
})

test('expired access token renews once with the refresh token and persists rotation for later startups', async () => {
  const provider = await login()
  unauthorized = true
  directory = [model('new-default')]
  expect((await refresh(provider.id)).status).toBe(200)
  expect((await new ProviderService().getProvider(provider.id)).models.main).toBe('new-default')
  expect(calls.filter(c => c.path.endsWith('/auth/refresh'))).toHaveLength(1)
  expect((await refresh(provider.id)).status).toBe(200)
  expect(calls.filter(c => c.path.endsWith('/auth/refresh'))).toHaveLength(1)
  expect(calls.at(-1)?.authorization).toBe('Bearer fake-renewed')
})

test('old provider without manager credentials requests reconnect and retains its cache', async () => {
  const provider = await new ProviderService().upsertIntegratedProvider('seasun', { apiKey: 'old-key', baseUrl: 'https://aihub.seasungame.com/airoute', modelCatalog: [{ id: 'old', capabilities: [] }] })
  const response = await refresh(provider.id)
  expect(response.status).toBe(401)
  expect(await response.json()).toMatchObject({ error: 'PROVIDER_RECONNECT_REQUIRED' })
  expect((await new ProviderService().getProvider(provider.id)).modelCatalog).toEqual(provider.modelCatalog)
  expect(calls).toHaveLength(0)
})

test('expired login without a refresh token preserves the provider and returns only the reconnect code', async () => {
  const request = globalThis.fetch
  globalThis.fetch = (async (input, init) => String(input).includes('/it-sso/callback')
    ? new Response(null, { status: 302, headers: { location: 'https://aihub.seasungame.com/#access_token=fake-manager' } })
    : request(input, init)) as typeof fetch
  const provider = await login()
  unauthorized = true
  const response = await refresh(provider.id)
  expect(response.status).toBe(401)
  expect(await response.json()).toEqual({ error: 'PROVIDER_RECONNECT_REQUIRED', message: 'Reconnect Seasun to refresh models' })
  expect((await new ProviderService().getProvider(provider.id)).modelCatalog).toEqual(provider.modelCatalog)
  expect(calls.some(c => c.path.endsWith('/auth/refresh'))).toBe(false)
})

test('rejected renewal does not loop or expose credentials and keeps the old catalog', async () => {
  const provider = await login()
  unauthorized = true
  const request = globalThis.fetch
  let renewals = 0
  globalThis.fetch = (async (input, init) => {
    if (String(input).endsWith('/auth/refresh')) { renewals++; return new Response('fake-refresh must not leak', { status: 401 }) }
    return request(input, init)
  }) as typeof fetch
  const response = await refresh(provider.id)
  expect(response.status).toBe(401)
  expect(await response.text()).not.toMatch(/fake-/)
  expect(renewals).toBe(1)
  expect((await new ProviderService().getProvider(provider.id)).modelCatalog).toEqual(provider.modelCatalog)
})

test('concurrent refreshes share the renewal and do not consume the same rotating token twice', async () => {
  const provider = await login()
  unauthorized = true
  const responses = await Promise.all([refresh(provider.id), refresh(provider.id), refresh(provider.id)])
  expect(responses.map(r => r.status)).toEqual([200, 200, 200])
  expect(calls.filter(c => c.path.endsWith('/auth/refresh'))).toHaveLength(1)
})

test('credentials are bound to the saved provider key and cannot silently refresh a different identity', async () => {
  const provider = await login()
  await new ProviderService().updateProvider(provider.id, { apiKey: 'another-key' })
  const before = calls.length
  expect((await refresh(provider.id)).status).toBe(401)
  expect(calls).toHaveLength(before)
})

test('connecting an identity with no assigned models clears the prior identity refresh credentials but preserves its cached provider', async () => {
  const provider = await login()
  directory = []
  const auth = new SeasunAuthService()
  const attempt = await auth.start()
  expect((await auth.complete({ ...attempt, callbackUrl: 'ccswitch://seasun-sso/callback?token=fake-new-user&verifySign=fake-sign' })).phase).toBe('connected')
  const before = calls.length
  expect((await refresh(provider.id)).status).toBe(401)
  expect(calls).toHaveLength(before)
  expect((await new ProviderService().getProvider(provider.id)).modelCatalog).toEqual(provider.modelCatalog)
})

test('a refresh whose deadline expires retains cached models and can be retried', async () => {
  const provider = await login()
  const timeout = spyOn(AbortSignal, 'timeout').mockReturnValue(AbortSignal.abort())
  try {
    expect((await refresh(provider.id)).status).toBe(502)
    expect((await new ProviderService().getProvider(provider.id)).modelCatalog).toEqual(provider.modelCatalog)
  } finally { timeout.mockRestore() }
  expect((await refresh(provider.id)).status).toBe(200)
})

test('an explicit SSO relogin requirement does not attempt token renewal', async () => {
  const provider = await login()
  globalThis.fetch = (async () => Response.json({ reason: 'IT_SSO_RELOGIN_REQUIRED' }, { status: 401 })) as typeof fetch
  expect((await refresh(provider.id)).status).toBe(401)
  expect((await new ProviderService().getProvider(provider.id)).modelCatalog).toEqual(provider.modelCatalog)
})

for (const raw of [[], null, [{ public_model: 'missing-flags' }]]) {
  test(`invalid or empty catalog keeps last saved models: ${JSON.stringify(raw)}`, async () => {
    const provider = await login()
    directory = raw
    expect((await refresh(provider.id)).status).toBeGreaterThanOrEqual(400)
    expect((await new ProviderService().getProvider(provider.id)).modelCatalog).toEqual(provider.modelCatalog)
  })
}
