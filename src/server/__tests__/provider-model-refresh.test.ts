import { afterEach, beforeEach, expect, test } from 'bun:test'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { ProviderService } from '../services/providerService.js'
import { handleProvidersApi } from '../api/providers.js'
import { KsccOAuthService } from '../services/ksccOAuthService.js'
import { ProviderIntegrationRegistry } from '../providerIntegrations/registry.js'
import { ksccIntegration } from '../providerIntegrations/kscc.js'

let directory: string
let previous: string | undefined
let originalFetch: typeof fetch
let service: ProviderService
beforeEach(async () => {
  directory = await fs.mkdtemp(path.join(os.tmpdir(), 'model-refresh-'))
  previous = process.env.CLAUDE_CONFIG_DIR
  process.env.CLAUDE_CONFIG_DIR = directory
  originalFetch = globalThis.fetch
  globalThis.fetch = (() => { throw new Error('Unexpected network') }) as typeof fetch
  service = new ProviderService()
})
afterEach(async () => {
  globalThis.fetch = originalFetch
  if (previous === undefined) delete process.env.CLAUDE_CONFIG_DIR
  else process.env.CLAUDE_CONFIG_DIR = previous
  await fs.rm(directory, { recursive: true, force: true })
})
async function seed() {
  return service.upsertIntegratedProvider('kscc', {
    apiKey: 'fake-key', baseUrl: 'http://kscc.test',
    modelCatalog: ['kept', 'removed'].map(id => ({ id, capabilities: [] })),
  })
}
function response(models = ['kept', 'deepseekv-4.1-flash']) {
  return Response.json({ code: 200, data: models.map(model => ({ model })) })
}
test('refresh route replaces the saved catalog, preserves valid mappings and never activates KSCC', async () => {
  const provider = await seed()
  await service.updateProvider(provider.id, { models: { main: 'kept', haiku: 'removed', sonnet: 'kept', opus: 'kept' }, notes: 'keep notes' })
  await service.activateOfficial()
  globalThis.fetch = (async (input, init) => {
    expect(String(input)).toBe('http://kscc.test/cli/models')
    expect(new Headers(init?.headers).get('Authorization')).toBe('Bearer fake-key')
    return response(['kept', 'deepseekv-4.1-flash', 'kept'])
  }) as typeof fetch
  const url = new URL(`http://localhost/api/providers/${provider.id}/refresh-models`)
  const result = await handleProvidersApi(new Request(url, { method: 'POST' }), url, url.pathname.split('/').filter(Boolean))
  expect(result.status).toBe(200)
  const saved = await service.getProvider(provider.id)
  expect(saved.modelCatalog?.map(model => model.id)).toEqual(['kept', 'deepseekv-4.1-flash'])
  expect(saved.models).toEqual({ main: 'kept', haiku: 'kept', sonnet: 'kept', opus: 'kept' })
  expect(saved.notes).toBe('keep notes')
  expect((await service.listProviders()).activeId).toBeNull()
})
test.each([
  { code: 401, data: [{ model: 'bad' }] },
  { code: 500, data: [{ model: 'bad' }] },
  { code: 200, data: [] },
  { code: 200, data: [{ model: 'kept' }, null] },
  { code: 200, data: [{ model: 'kept' }, { model: 123 }] },
])('invalid upstream response preserves the complete old provider: %j', async payload => {
  const provider = await seed()
  globalThis.fetch = (async () => Response.json(payload)) as typeof fetch
  await expect(service.refreshModelCatalog(provider.id)).rejects.toThrow()
  expect(await service.getProvider(provider.id)).toEqual(provider)
})
test('refresh merges concurrent callers and keeps edits made during network lookup', async () => {
  const provider = await seed()
  let finish!: (value: Response) => void
  let calls = 0
  globalThis.fetch = (() => { calls++; return new Promise<Response>(resolve => { finish = resolve }) }) as typeof fetch
  const first = service.refreshModelCatalog(provider.id)
  const second = new ProviderService().refreshModelCatalog(provider.id)
  while (!finish) await new Promise(resolve => setTimeout(resolve, 1))
  await service.updateProvider(provider.id, { notes: 'edited while fetching' })
  finish(response())
  await Promise.all([first, second])
  expect(calls).toBe(1)
  expect((await service.getProvider(provider.id)).notes).toBe('edited while fetching')
})

test('new models update active provider capability settings without changing its selected model', async () => {
  const provider = await seed()
  globalThis.fetch = (async () => response()) as typeof fetch
  await service.refreshModelCatalog(provider.id)
  const settings = await service.getManagedSettings()
  const env = settings.env as Record<string, string>
  expect(JSON.parse(env.CC_HAHA_PROVIDER_MODEL_CAPABILITIES!)['deepseekv-4.1-flash']).toContain('thinking')
  expect((await service.getProvider(provider.id)).models.main).toBe('kept')
})

test('all removed defaults fall back to an arbitrary upstream model, without a name whitelist', async () => {
  const provider = await seed()
  globalThis.fetch = (async () => response(['future-provider-model-999'])) as typeof fetch
  const updated = await service.refreshModelCatalog(provider.id)
  expect(Object.values(updated.models)).toEqual(Array(4).fill('future-provider-model-999'))
  expect(updated.modelCatalog?.map(model => model.id)).toEqual(['future-provider-model-999'])
})

test('a timed out model refresh preserves the previous catalog and permits retry', async () => {
  const provider = await seed()
  const kscc = new KsccOAuthService({ requestTimeoutMs: 10 })
  const timedService = new ProviderService(new ProviderIntegrationRegistry([{
    ...ksccIntegration,
    fetchModelCatalog: provider => kscc.fetchModels(provider.apiKey, provider.baseUrl),
  }]))
  globalThis.fetch = ((_input, init) => new Promise((_resolve, reject) => {
    init?.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
  })) as typeof fetch
  await expect(timedService.refreshModelCatalog(provider.id)).rejects.toThrow('timed out')
  expect(await service.getProvider(provider.id)).toEqual(provider)
  globalThis.fetch = (async () => response()) as typeof fetch
  expect((await timedService.refreshModelCatalog(provider.id)).modelCatalog).toHaveLength(2)
})

test('background refresh and edits from separate service instances do not lose index writes', async () => {
  const provider = await seed()
  const other = await service.addProvider({ ...provider, presetId: 'custom', name: 'Other' })
  globalThis.fetch = (async () => response()) as typeof fetch
  await Promise.all([
    service.refreshModelCatalog(provider.id),
    new ProviderService().updateProvider(other.id, { notes: 'other edit' }),
    new ProviderService().updateProvider(provider.id, { notes: 'concurrent edit' }),
  ])
  expect((await service.getProvider(other.id)).notes).toBe('other edit')
  const updated = await service.getProvider(provider.id)
  expect(updated.notes).toBe('concurrent edit')
  expect(updated.modelCatalog?.map(model => model.id)).toContain('deepseekv-4.1-flash')
})
test.each(['delete', 'credentials'])('refresh cannot overwrite a provider changed during lookup: %s', async change => {
  const provider = await seed()
  await service.activateOfficial()
  let finish!: (value: Response) => void
  globalThis.fetch = (() => new Promise<Response>(resolve => { finish = resolve })) as typeof fetch
  const pending = service.refreshModelCatalog(provider.id)
  while (!finish) await new Promise(resolve => setTimeout(resolve, 1))
  if (change === 'delete') await service.deleteProvider(provider.id)
  else await service.updateProvider(provider.id, { apiKey: 'replacement-key' })
  finish(response())
  await expect(pending).rejects.toThrow()
  const state = await service.listProviders()
  if (change === 'delete') expect(state.providers).toEqual([])
  else expect(state.providers[0]?.apiKey).toBe('replacement-key')
})
