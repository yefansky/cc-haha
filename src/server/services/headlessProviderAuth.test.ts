import { afterEach, beforeEach, expect, spyOn, test } from 'bun:test'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import * as os from 'node:os'
import { ProviderService } from './providerService.js'
import { listHeadlessModels, loginHeadlessProvider, selectHeadlessProvider } from './headlessProviderAuth.js'
import { fetchSeasunQuota, saveSeasunCredentials } from '../providerIntegrations/seasun/credentials.js'

let directory: string
let originalConfig: string | undefined
let originalFetch: typeof fetch
beforeEach(async () => {
  directory = await fs.mkdtemp(path.join(os.tmpdir(), 'headless-auth-'))
  originalConfig = process.env.CLAUDE_CONFIG_DIR
  process.env.CLAUDE_CONFIG_DIR = directory
  originalFetch = globalThis.fetch
})
afterEach(async () => {
  globalThis.fetch = originalFetch
  if (originalConfig === undefined) delete process.env.CLAUDE_CONFIG_DIR
  else process.env.CLAUDE_CONFIG_DIR = originalConfig
  await fs.rm(directory, { recursive: true, force: true })
})
async function seedKscc() {
  return new ProviderService().upsertIntegratedProvider('kscc', { apiKey: 'fake-secret-model-key', baseUrl: 'http://kscc.test',
    modelCatalog: [{ id: 'glm-test', capabilities: [] }] }, { activate: false })
}
async function seedSeasun() {
  const provider = await new ProviderService().upsertIntegratedProvider('seasun', { apiKey: 'fake-secret-model-key',
    baseUrl: 'https://aihub.seasungame.com/airoute', modelCatalog: [{ id: 'test-model', capabilities: [] }] })
  await saveSeasunCredentials(provider.id, provider.apiKey, { accessToken: 'fake-old-manager', refreshToken: 'fake-old-refresh' })
  return provider
}

test('explicit selection and model lookup preserve desktop defaults and separate quota from permission', async () => {
  const provider = await seedKscc()
  const indexPath = path.join(directory, 'cc-haha', 'providers.json')
  const before = await fs.readFile(indexPath, 'utf8')
  globalThis.fetch = (async () => Response.json({ code: 200, data: [
    { model: 'glm-test', quotaLimited: false }, { model: 'limited', quotaLimited: true }, { model: 'glm-test' },
  ] })) as typeof fetch
  expect((await selectHeadlessProvider('kscc')).id).toBe(provider.id)
  const result = await listHeadlessModels('kscc')
  expect(result.models.map(model => [model.id, model.quota_limited, model.catalog_access])).toEqual([
    ['glm-test', false, 'unknown'], ['limited', true, 'unknown'],
  ])
  expect(JSON.stringify(result)).not.toContain('fake-secret')
  expect(await fs.readFile(indexPath, 'utf8')).toBe(before)
  expect((await new ProviderService().listProviders()).activeId).toBeNull()
})

test('legacy provider selection does not migrate or repair GUI state', async () => {
  const provider = await seedKscc()
  const indexPath = path.join(directory, 'cc-haha', 'providers.json')
  const legacy = JSON.parse(await fs.readFile(indexPath, 'utf8'))
  legacy.schemaVersion = 1
  legacy.activeProviderId = provider.id
  delete legacy.activeId
  legacy.extraUserPreference = 'preserve-me'
  const before = JSON.stringify(legacy)
  await fs.writeFile(indexPath, before)
  globalThis.fetch = (async () => Response.json({ code: 200, data: [{ model: 'glm-test' }] })) as typeof fetch
  expect((await selectHeadlessProvider('kscc')).id).toBe(provider.id)
  await listHeadlessModels('kscc')
  expect(await fs.readFile(indexPath, 'utf8')).toBe(before)
  expect(await Bun.file(path.join(directory, 'cc-haha', 'settings.json')).exists()).toBe(false)
})

test('temporary model lookup failure does not start a new login', async () => {
  await seedKscc()
  const paths: string[] = []
  globalThis.fetch = (async input => { paths.push(new URL(String(input)).pathname); throw new Error('offline') }) as typeof fetch
  await expect(loginHeadlessProvider('kscc', { onAuthorizeUrl: () => { throw new Error('must not start login') } })).rejects.toMatchObject({ code: 'PROVIDER_UNAVAILABLE' })
  expect(paths).toEqual(['/cli/models'])
})

test('cancelled login stops polling and does not save or show a late authorization URL', async () => {
  const controller = new AbortController()
  let polls = 0
  let shown = 0
  globalThis.fetch = (async input => {
    if (String(input).includes('/cli/login/url')) return Response.json({ code: 200, data: { loginUUID: 'fake-id', loginUrl: 'unused' } })
    polls++
    controller.abort()
    return Response.json({ data: { status: 'waiting' } })
  }) as typeof fetch
  await expect(loginHeadlessProvider('kscc', { signal: controller.signal, onAuthorizeUrl: () => { shown++ }, pollIntervalMs: 1 })).rejects.toMatchObject({ code: 'LOGIN_CANCELLED' })
  expect(polls).toBe(1)
  expect(shown).toBe(1)
  expect(await Bun.file(path.join(directory, 'cc-haha/providers.json')).exists()).toBe(false)
  await expect(loginHeadlessProvider('kscc', { signal: controller.signal, onAuthorizeUrl: () => { shown++ } })).rejects.toMatchObject({ code: 'LOGIN_CANCELLED' })
  expect(shown).toBe(1)
})

test('KSCC first login uses existing exchange without activating GUI defaults or persisting pending secrets', async () => {
  let authorizeUrl = ''
  globalThis.fetch = (async input => {
    const url = String(input)
    if (url.includes('/cli/login/url')) return Response.json({ code: 200, data: { loginUUID: 'fake-login-id', loginUrl: 'unused' } })
    if (url.includes('/cli/login/result')) return Response.json({ data: { status: 'success', sk: 'fake-secret-new-key' } })
    return Response.json({ code: 200, data: [{ model: 'glm-test' }] })
  }) as typeof fetch
  const result = await loginHeadlessProvider('kscc', { onAuthorizeUrl: url => { authorizeUrl = url }, timeoutMs: 1000, pollIntervalMs: 1 })
  expect(result).toEqual({ provider: 'kscc', logged_in: true })
  expect(authorizeUrl).toEndWith('/l/fake-login-id')
  expect((await new ProviderService().listProviders()).activeId).toBeNull()
  expect((await selectHeadlessProvider('kscc')).apiKey).toBe('fake-secret-new-key')
  expect(await Bun.file(path.join(directory, 'kscc-oauth-pending.json')).exists()).toBe(false)
  expect(await Bun.file(path.join(directory, 'cc-haha', 'settings.json')).exists()).toBe(false)
})

test('TokenHub without saved identity fails safely without starting interactive authentication', async () => {
  let calls = 0
  globalThis.fetch = (async () => { calls++; throw new Error('fake-secret-network-error') }) as typeof fetch
  await expect(loginHeadlessProvider('tokenhub')).rejects.toMatchObject({ code: 'LOGIN_REQUIRED' })
  expect(calls).toBe(0)
})

test('quota and model management share refresh rotation and retain top-level quota payload', async () => {
  const provider = await seedSeasun()
  let refreshes = 0
  globalThis.fetch = (async (input, init) => {
    const url = String(input)
    if (url.endsWith('/auth/refresh')) {
      refreshes++
      return Response.json({ code: 0, data: { access_token: 'fake-new-manager', refresh_token: 'fake-new-refresh' } })
    }
    if (new Headers(init?.headers).get('Authorization') !== 'Bearer fake-new-manager') return Response.json({}, { status: 401 })
    return Response.json({ code: 0, data: { currency: 'USD', windows: [] } })
  }) as typeof fetch
  expect(await fetchSeasunQuota(provider)).toEqual({ code: 0, data: { currency: 'USD', windows: [] } })
  expect(await fetchSeasunQuota(provider)).toEqual({ code: 0, data: { currency: 'USD', windows: [] } })
  expect(refreshes).toBe(1)
})

test('quota distinguishes unsupported endpoints and forbidden accounts even with non-JSON errors', async () => {
  const provider = await seedSeasun()
  for (const [status, code] of [[404, 'PROVIDER_QUOTA_UNSUPPORTED'], [405, 'PROVIDER_QUOTA_UNSUPPORTED'], [403, 'PROVIDER_PERMISSION_DENIED']] as const) {
    globalThis.fetch = (async () => new Response('fake-secret-remote-body', { status })) as typeof fetch
    await expect(fetchSeasunQuota(provider)).rejects.toMatchObject({ code })
  }
})

test('failed provider requests never expose raw remote errors', async () => {
  await seedKscc()
  globalThis.fetch = (async () => { throw new Error('Bearer fake-secret-leak') }) as typeof fetch
  try { await listHeadlessModels('kscc'); throw new Error('expected rejection') }
  catch (error) { expect(String(error)).not.toContain('fake-secret'); expect(error).toMatchObject({ code: 'PROVIDER_UNAVAILABLE' }) }
})

test('separate CLI processes serialize rotating manager credentials through the same file lock', async () => {
  await seedSeasun()
  const moduleUrl = new URL('../providerIntegrations/seasun/credentials.ts', import.meta.url).href
  const script = `
    import * as fs from 'node:fs/promises'
    import * as path from 'node:path'
    const { fetchSeasunQuota } = await import(${JSON.stringify(moduleUrl)})
    const root = process.env.CLAUDE_CONFIG_DIR
    const provider = JSON.parse(await fs.readFile(path.join(root, 'cc-haha/providers.json'), 'utf8')).providers[0]
    globalThis.fetch = async (url, init) => {
      if (String(url).endsWith('/auth/refresh')) {
        await fs.appendFile(path.join(root, 'renewals.txt'), 'refresh\\n')
        await new Promise(resolve => setTimeout(resolve, 80))
        return Response.json({ code: 0, data: { access_token: 'fake-rotated', refresh_token: 'fake-rotated-refresh' } })
      }
      return new Headers(init.headers).get('Authorization') === 'Bearer fake-rotated'
        ? Response.json({ code: 0, data: { currency: 'USD' } }) : Response.json({}, { status: 401 })
    }
    await fetchSeasunQuota(provider)
  `
  const children = [0, 1].map(() => Bun.spawn([process.execPath, '--eval', script], {
    cwd: process.cwd(), env: { ...process.env, CLAUDE_CONFIG_DIR: directory }, stdout: 'pipe', stderr: 'pipe',
    windowsHide: true,
  }))
  for (const child of children) {
    const [status, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()])
    expect(stderr).toBe('')
    expect(status).toBe(0)
  }
  expect(await fs.readFile(path.join(directory, 'renewals.txt'), 'utf8')).toBe('refresh\n')
}, 15_000)

test('manager rotation save failure does not retry with unpersisted credentials or expose secrets', async () => {
  const provider = await seedSeasun()
  let calls = 0
  globalThis.fetch = (async input => {
    calls++
    return String(input).endsWith('/auth/refresh')
      ? Response.json({ code: 0, data: { access_token: 'fake-new-secret', refresh_token: 'fake-new-refresh' } })
      : Response.json({}, { status: 401 })
  }) as typeof fetch
  const rename = spyOn(fs, 'rename').mockRejectedValueOnce(new Error('fake-secret-storage-error'))
  try {
    await expect(fetchSeasunQuota(provider)).rejects.toMatchObject({ code: 'PROVIDER_MODEL_REFRESH_FAILED' })
    expect(calls).toBe(2)
    const saved = JSON.parse(await fs.readFile(path.join(directory, 'cc-haha/provider-integrations/seasun-credentials.json'), 'utf8'))
    expect(saved.accessToken).toBe('fake-old-manager')
  } finally { rename.mockRestore() }
})

test('stale crashed-process locks recover; a live lock has a bounded wait and makes no upstream request', async () => {
  const provider = await seedSeasun()
  const lockPath = path.join(directory, 'cc-haha/provider-integrations/seasun-credentials.json.lock')
  await fs.mkdir(lockPath)
  const stale = new Date(Date.now() - 120_000)
  await fs.utimes(lockPath, stale, stale)
  let calls = 0
  globalThis.fetch = (async () => { calls++; return Response.json({ code: 0, data: { currency: 'USD' } }) }) as typeof fetch
  await fetchSeasunQuota(provider)
  expect(calls).toBe(1)
  await fs.mkdir(lockPath)
  const started = Date.now()
  await expect(fetchSeasunQuota(provider)).rejects.toMatchObject({ code: 'PROVIDER_CREDENTIALS_UNAVAILABLE' })
  expect(Date.now() - started).toBeLessThan(15_000)
  expect(calls).toBe(1)
}, 20_000)
