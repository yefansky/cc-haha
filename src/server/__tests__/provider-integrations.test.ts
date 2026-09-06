import { afterEach, beforeEach, describe, expect, test, spyOn } from 'bun:test'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { handleProviderIntegrationsApi } from '../api/provider-integrations.js'
import { handleKsccOAuthApi } from '../api/kscc-oauth.js'
import { ProviderIntegrationRegistry } from '../providerIntegrations/registry.js'
import { providerIntegrations } from '../providerIntegrations/index.js'
import { ksccIntegration } from '../providerIntegrations/kscc.js'
import { ProviderLoginError, type ProviderIntegration } from '../providerIntegrations/types.js'
import { ProviderService } from '../services/providerService.js'
import { ApiError } from '../middleware/errorHandler.js'
import type { SavedProvider } from '../types/provider.js'

let temporaryHome: string
let originalFetch: typeof fetch
let originalEnv: Record<string, string | undefined>
const envKeys = ['HOME', 'USERPROFILE', 'CLAUDE_CONFIG_DIR', 'KSCC_BASE_URL'] as const

beforeEach(async () => {
  temporaryHome = await fs.mkdtemp(path.join(os.tmpdir(), 'provider-integrations-'))
  originalEnv = Object.fromEntries(envKeys.map(key => [key, process.env[key]]))
  process.env.HOME = temporaryHome
  process.env.USERPROFILE = temporaryHome
  process.env.CLAUDE_CONFIG_DIR = temporaryHome
  process.env.KSCC_BASE_URL = 'http://kscc.test'
  originalFetch = globalThis.fetch
  globalThis.fetch = (() => { throw new Error('Unexpected network request') }) as typeof fetch
})

afterEach(async () => {
  globalThis.fetch = originalFetch
  for (const key of envKeys) {
    if (originalEnv[key] === undefined) delete process.env[key]
    else process.env[key] = originalEnv[key]
  }
  await fs.rm(temporaryHome, { recursive: true, force: true })
})

function request(resource: string, method = 'GET', registry = providerIntegrations) {
  const url = new URL(`http://localhost/api/${resource}`)
  return handleProviderIntegrationsApi(new Request(url, { method }), url, url.pathname.split('/').filter(Boolean), registry)
}

describe('Provider integration contracts', () => {
  test('the real router joins generic sign-in with legacy status and rejects unknown integrations', async () => {
    const { handleApiRequest } = await import('../router.js')
    const calls: string[] = []
    globalThis.fetch = (async input => {
      const url = String(input)
      calls.push(url)
      if (url.endsWith('/cli/login/url')) return Response.json({ code: 200, data: { loginUUID: 'router-fixture', loginUrl: 'provided' } })
      if (url.includes('/cli/login/result')) return Response.json({ data: { status: 'success', sk: 'router-fixture-key' } })
      if (url.endsWith('/cli/models')) return Response.json({ code: 200, data: [{ model: 'router-model' }] })
      throw new Error('Unexpected endpoint')
    }) as typeof fetch
    const route = (resource: string, method = 'GET') => {
      const url = new URL(`http://localhost/api/${resource}`)
      return handleApiRequest(new Request(url, { method }), url)
    }
    const started = await route('provider-integrations/kscc/start', 'POST')
    expect(started.status).toBe(200)
    expect(await started.json()).toEqual({ authorizeUrl: 'http://kscc.test/l/router-fixture', reusedLocalLogin: false })
    const completed = await route('kscc-oauth/status')
    expect(completed.status).toBe(200)
    expect(await completed.json()).toEqual({ loggedIn: true, pending: false, active: true })
    const state = await new ProviderService().listProviders()
    expect(state.providers).toHaveLength(1)
    expect(state.activeId).toBe(state.providers[0]!.id)
    expect(state.providers[0]!.models.main).toBe('router-model')
    expect((await route('provider-integrations/not-registered/status')).status).toBe(404)
    expect((await route('not-registered-oauth/status')).status).toBe(404)
    expect(calls).toHaveLength(3)
  })

  test('a second business completes auth -> provider storage -> runtime -> connectivity without KSCC branches', async () => {
    let service: ProviderService
    let pending = false
    let saved: SavedProvider | undefined
    const second: ProviderIntegration = {
      id: 'second', presetId: 'second-preset', legacyAuthResources: ['second-login'],
      activateOnAuthorization: false,
      auth: {
        async start() {
          pending = true
          return { authorizeUrl: 'https://second.test/login', reusedLocalLogin: false, apiKey: 'not-for-ui' }
        },
        async status() {
          if (pending) {
            saved = await service.upsertIntegratedProvider('second', {
              apiKey: 'second-key', baseUrl: 'https://second.test',
              modelCatalog: [{ id: 'second-model', capabilities: [] }],
            })
            pending = false
          }
          return { loggedIn: !!saved, pending, active: false, apiKey: 'not-for-ui' }
        },
      },
      buildAuthorizedProvider(authorization) {
        return {
          name: 'Second', ...authorization, authStrategy: 'api_key',
          apiFormat: 'openai_responses', runtimeKind: 'anthropic_compatible',
          models: { main: 'second-model', opus: 'second-model', sonnet: '', haiku: '' },
        }
      },
      managedEnvKeys: ['SECOND_SESSION'],
      buildRuntimeEnv: ({ provider, workDir }) => ({ SECOND_SESSION: `${provider.models.main}:${workDir}` }),
      testConnectivity: async context => {
        expect(context).toEqual({ baseUrl: 'https://second.test', apiKey: 'second-key', modelId: 'second-model' })
        return { success: true, latencyMs: 1, modelUsed: context.modelId, apiKey: context.apiKey }
      },
    }
    const registry = new ProviderIntegrationRegistry([ksccIntegration, second])
    service = new ProviderService(registry)
    const firstProvider = await service.upsertIntegratedProvider('kscc', {
      apiKey: 'first-key', baseUrl: 'http://kscc.test', modelCatalog: [{ id: 'first-model', capabilities: [] }],
    })
    const started = await request('provider-integrations/second/start', 'POST', registry)
    expect(await started.json()).toEqual({ authorizeUrl: 'https://second.test/login', reusedLocalLogin: false })
    const finished = await request('second-login/status', 'GET', registry)
    expect(await finished.json()).toEqual({ loggedIn: true, pending: false, active: false })
    const state = await service.listProviders()
    expect(state.activeId).toBe(firstProvider.id)
    expect(state.providers).toHaveLength(2)
    expect(saved?.presetId).toBe('second-preset')
    expect(saved?.apiFormat).toBe('openai_responses')
    expect(registry.buildRuntimeEnv(saved!, '/second/work')).toEqual({ SECOND_SESSION: 'second-model:/second/work' })
    const firstRuntime = registry.buildRuntimeEnv(firstProvider, temporaryHome)
    expect(firstRuntime.CC_HAHA_KSCC_PROTOCOL).toBe('1')
    expect(firstRuntime.SECOND_SESSION).toBeUndefined()
    expect(registry.buildRuntimeEnv(saved!, '/second/work')).not.toHaveProperty('CC_HAHA_KSCC_PROTOCOL')
    expect(registry.managedEnvKeys()).toEqual(['CC_HAHA_KSCC_PROTOCOL', 'CC_HAHA_KSCC_HEADERS', 'SECOND_SESSION'])
    expect(registry.buildRuntimeEnv({ ...saved!, presetId: 'unregistered' }, '/work')).toEqual({})
    expect(await service.testProvider(saved!.id)).toEqual({ connectivity: {
      success: true, latencyMs: 1, modelUsed: 'second-model', httpStatus: undefined, error: undefined,
    } })
    expect(JSON.stringify(await request('provider-integrations/second/status', 'GET', registry).then(response => response.json()))).not.toContain('not-for-ui')
    expect(JSON.stringify(saved)).not.toContain('KSCC')
  })

  test('KSCC legacy and generic URLs drive the same login and preserve model selection on reauthorization', async () => {
    const calls: string[] = []
    globalThis.fetch = (async input => {
      const url = String(input)
      calls.push(url)
      if (url.endsWith('/cli/login/url')) return Response.json({ code: 200, data: { loginUUID: 'fake-uuid', loginUrl: 'provided' } })
      if (url.includes('/cli/login/result')) return Response.json({ data: { status: 'success', sk: 'fake-key' } })
      if (url.endsWith('/cli/models')) return Response.json({ code: 200, data: [{ model: 'first' }, { model: 'chosen' }] })
      throw new Error('Unexpected endpoint')
    }) as typeof fetch
    const legacyUrl = new URL('http://localhost/api/kscc-oauth/start')
    const start = await handleKsccOAuthApi(new Request(legacyUrl, { method: 'POST' }), legacyUrl, ['api', 'kscc-oauth', 'start'])
    expect(await start.json()).toEqual({ authorizeUrl: 'http://kscc.test/l/fake-uuid', reusedLocalLogin: false })
    expect(await request('provider-integrations/kscc/status').then(response => response.json())).toEqual({ loggedIn: true, pending: false, active: true })
    const service = new ProviderService()
    const before = await service.listProviders()
    const provider = before.providers.find(value => value.presetId === 'kscc')!
    expect(before.activeId).toBe(provider.id)
    await service.updateProvider(provider.id, { models: { main: 'chosen', haiku: 'chosen', sonnet: 'chosen', opus: 'chosen' }, toolSearchEnabled: false, notes: 'keep my notes' })
    const reauthorized = await service.upsertIntegratedProvider('kscc', {
      apiKey: 'new-fake-key', baseUrl: 'http://kscc.test',
      modelCatalog: [{ id: 'first', capabilities: [] }, { id: 'chosen', capabilities: [] }],
    })
    expect(reauthorized.id).toBe(provider.id)
    expect(reauthorized.models.main).toBe('chosen')
    expect(reauthorized.toolSearchEnabled).toBe(false)
    expect(reauthorized.notes).toBe('keep my notes')
    expect((await service.listProviders()).providerOrder).toEqual(before.providerOrder)
    const removedModel = await service.upsertIntegratedProvider('kscc', {
      apiKey: 'third-fake-key', baseUrl: 'http://kscc.test', modelCatalog: [{ id: 'replacement', capabilities: [] }],
    })
    expect(Object.values(removedModel.models)).toEqual(['replacement', 'replacement', 'replacement', 'replacement'])
    expect(calls).toHaveLength(3)
    expect(await fs.access(path.join(temporaryHome, 'kscc-oauth-pending.json')).then(() => true, () => false)).toBe(false)
  })

  test('old saved Provider fixture remains readable without a shape migration', async () => {
    const fixture = {
      id: 'existing-kscc', presetId: 'kscc', name: 'KSCC', apiKey: 'old-key', baseUrl: 'http://kscc.test',
      authStrategy: 'auth_token_empty_api_key', apiFormat: 'anthropic', runtimeKind: 'anthropic_compatible',
      models: { main: 'old-model', haiku: 'old-model', sonnet: 'old-model', opus: 'old-model' },
      notes: 'old fixture notes', toolSearchEnabled: false,
    }
    await fs.mkdir(path.join(temporaryHome, 'cc-haha'), { recursive: true })
    await fs.writeFile(path.join(temporaryHome, 'cc-haha', 'providers.json'), JSON.stringify({ activeId: fixture.id, providers: [fixture], providerOrder: [fixture.id] }))
    const provider = await new ProviderService().upsertIntegratedProvider('kscc', {
      apiKey: 'refreshed-key', baseUrl: fixture.baseUrl, modelCatalog: [{ id: 'old-model', capabilities: [] }],
    })
    expect(provider.id).toBe(fixture.id)
    expect(provider.models).toEqual(fixture.models)
    expect(provider.notes).toBe(fixture.notes)
    expect(provider.toolSearchEnabled).toBe(false)
    const raw = JSON.parse(await fs.readFile(path.join(temporaryHome, 'cc-haha', 'providers.json'), 'utf8'))
    expect(raw.providers[0]).not.toHaveProperty('integrationId')
    expect(raw.providers[0].presetId).toBe('kscc')
  })

  test('connectivity hooks redact credentials, fail safely and leave ordinary providers on their existing transport', async () => {
    let shouldThrow = false
    const registry = new ProviderIntegrationRegistry([{
      id: 'custom-test', presetId: 'custom-test',
      testConnectivity: async ({ apiKey }) => {
        if (shouldThrow) throw new Error(`remote failure ${apiKey}`)
        return { success: false, latencyMs: 1, error: `rejected ${apiKey}`, secret: apiKey }
      },
    }])
    const service = new ProviderService(registry)
    const provider = await service.addProvider({
      presetId: 'custom-test', name: 'Custom test', apiKey: 'private-key', baseUrl: 'https://private.test',
      apiFormat: 'anthropic', models: { main: 'model', opus: '', sonnet: '', haiku: '' },
    })
    const rejected = await service.testProvider(provider.id)
    expect(rejected.connectivity.error).toBe('rejected [redacted]')
    expect(JSON.stringify(rejected)).not.toContain('private-key')
    shouldThrow = true
    expect((await service.testProvider(provider.id)).connectivity.error).toBe('Provider connectivity check failed')
    const ordinary = await service.addProvider({
      presetId: 'custom', name: 'Ordinary', apiKey: 'ordinary-key', baseUrl: 'https://ordinary.test',
      apiFormat: 'anthropic', models: { main: 'ordinary-model', opus: '', sonnet: '', haiku: '' },
    })
    const urls: string[] = []
    globalThis.fetch = (async input => {
      urls.push(String(input))
      return Response.json({ id: 'message', type: 'message', role: 'assistant', model: 'ordinary-model', content: [{ type: 'text', text: 'ok' }] })
    }) as typeof fetch
    expect((await service.testProvider(ordinary.id)).connectivity.success).toBe(true)
    expect(urls).toEqual(['https://ordinary.test/v1/messages'])
  })

  test('unknown, unsupported and extra auth actions fail closed', async () => {
    const registry = new ProviderIntegrationRegistry([{ id: 'no-auth', presetId: 'no-auth' }])
    for (const route of ['provider-integrations/unknown/start', 'provider-integrations/no-auth/status', 'kscc-oauth/status/extra']) {
      expect((await request(route, 'POST', registry)).status).toBe(404)
    }
    expect((await request('provider-integrations/kscc/start')).status).toBe(404)
  })

  test('duplicate ids, presets and legacy auth resources are rejected', () => {
    const integration = { id: 'one', presetId: 'one', legacyAuthResources: ['old-one'] }
    for (const other of [integration, { id: 'two', presetId: 'one' }, { id: 'two', presetId: 'two', legacyAuthResources: ['old-one'] }]) {
      expect(() => new ProviderIntegrationRegistry([integration, other])).toThrow()
    }
  })

  test('unknown hook failures cannot leak credentials through HTTP or logging; timeout remains actionable', async () => {
    const log = spyOn(console, 'error').mockImplementation(() => {})
    try {
      for (const failure of [new Error('secret-key'), ApiError.badRequest('secret-key')]) {
        const registry = new ProviderIntegrationRegistry([{
          id: 'broken', presetId: 'broken', auth: { start: async () => { throw failure }, status: async () => { throw failure } },
        }])
        for (const [action, method] of [['start', 'POST'], ['status', 'GET']]) {
          const response = await request(`provider-integrations/broken/${action}`, method, registry)
          expect(response.status).toBe(500)
          expect(await response.text()).not.toContain('secret-key')
        }
      }
      const registry = new ProviderIntegrationRegistry([{
        id: 'slow', presetId: 'slow', auth: {
          start: async () => { throw new ProviderLoginError('timeout') },
          status: async () => { throw new ProviderLoginError('timeout') },
        },
      }])
      const timeout = await request('provider-integrations/slow/start', 'POST', registry)
      expect(timeout.status).toBe(504)
      expect(await timeout.json()).toEqual({ error: 'PROVIDER_LOGIN_TIMEOUT', message: 'Provider sign-in request timed out. Try again.' })
      expect(log).not.toHaveBeenCalled()
    } finally {
      log.mockRestore()
    }
  })
})
