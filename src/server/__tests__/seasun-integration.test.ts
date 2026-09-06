import { afterEach, beforeEach, expect, test } from 'bun:test'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { SeasunAuthService } from '../providerIntegrations/seasun/auth.js'
import { exchangeSeasunCallback, parseSeasunCallback, parseSeasunModels, SEASUN_GATEWAY } from '../providerIntegrations/seasun/protocol.js'
import { ProviderService } from '../services/providerService.js'
import { matchesDesktopCapability } from '../providerIntegrations/desktopCapability.js'
import { handleApiRequest } from '../router.js'

let home: string
let previous: string | undefined
const callback = 'ccswitch://seasun-sso/callback?token=fake-sso&verifySign=fake-sign&tokenType=8'
const models = [
  { public_model: 'response-model', enabled: true, available: true, status: 'active', capabilities: ['responses'], clients: ['codex'] },
  { public_model: 'chat-model', enabled: true, available: true, status: 'active', capabilities: ['chat'], clients: ['codex', 'grok'] },
  { public_model: 'claude-client-model', enabled: true, available: true, status: 'active', capabilities: ['chat'], clients: ['claude'] },
  { public_model: 'unconfirmed', enabled: true, available: true, status: 'active', capabilities: ['chat'], clients: ['codex'] },
]
beforeEach(async () => { previous = process.env.CLAUDE_CONFIG_DIR; home = await fs.mkdtemp(path.join(os.tmpdir(), 'seasun-test-')); process.env.CLAUDE_CONFIG_DIR = home })
afterEach(async () => { if (previous === undefined) delete process.env.CLAUDE_CONFIG_DIR; else process.env.CLAUDE_CONFIG_DIR = previous; await fs.rm(home, { recursive: true, force: true }) })

test('actual exchange contract saves one provider, keeps KSCC active and never claims directory proves access', async () => {
  const service = new ProviderService()
  const kscc = await service.upsertIntegratedProvider('kscc', { apiKey: 'old-key', baseUrl: 'http://kscc.test', modelCatalog: [{ id: 'old', capabilities: [] }] })
  const calls: string[] = []
  const request = (async (input, init) => {
    const url = new URL(String(input)); calls.push(url.pathname)
    if (calls.length === 1) {
      expect(init?.redirect).toBe('manual')
      expect(url.searchParams.get('sourceChannel')).toBe('tokenHub')
      expect(url.searchParams.get('sourceTokenType')).toBe('8')
      return new Response(null, { status: 302, headers: { location: 'https://aihub.seasungame.com/#access_token=fake-manager' } })
    }
    expect(new Headers(init?.headers).get('Authorization')).toBe('Bearer fake-manager')
    return Response.json({ code: 0, data: { apiKey: 'fake-model-key', models } })
  }) as typeof fetch
  const auth = new SeasunAuthService({ exchange: (raw, signal) => exchangeSeasunCallback(raw, signal, request) })
  const attempt = await auth.start()
  const result = await auth.complete({ ...attempt, callbackUrl: callback })
  expect(result.phase).toBe('connected')
  expect(result.modelAccess).toBe('unknown')
  expect(result.active).toBe(false)
  expect(JSON.stringify(result)).not.toMatch(/fake-model-key|fake-sso|fake-manager|completionSecret/)
  const index = await service.listProviders()
  expect(index.activeId).toBe(kscc.id)
  expect(index.providers).toHaveLength(2)
  const provider = index.providers.find(value => value.presetId === 'seasun')!
  expect(provider.modelCatalog?.map(value => value.transport?.apiFormat)).toEqual(['openai_responses', 'openai_chat', 'anthropic'])
  expect(calls).toHaveLength(2)
  await auth.complete({ ...attempt, callbackUrl: callback })
  expect(calls).toHaveLength(2)
  expect(await fs.readFile(path.join(home, 'cc-haha/provider-integrations/seasun-state.json'), 'utf8')).not.toMatch(/fake-|token|secret/i)
})

test('cancel during exchange prevents saving even when transport ignores abort; expiration is fail closed', async () => {
  let finish!: (value: any) => void
  let saved = 0, now = 0
  const auth = new SeasunAuthService({ now: () => now, exchange: () => new Promise(resolve => { finish = resolve }), save: async () => { saved++; return { id: 'never' } } })
  const attempt = await auth.start()
  const pending = auth.complete({ ...attempt, callbackUrl: callback })
  expect((await auth.cancel(attempt)).phase).toBe('cancelled')
  finish({ apiKey: 'key', modelCatalog: parseSeasunModels(models), identityConnected: true })
  expect((await pending).phase).toBe('cancelled')
  expect(saved).toBe(0)
  const second = await auth.start(); now = second.expiresAt + 1
  expect((await auth.complete({ ...second, callbackUrl: callback })).phase).toBe('expired')
  expect(saved).toBe(0)
})

test('no coding models remains identity connected and unknown; malformed callbacks and desktop capability reject', async () => {
  const auth = new SeasunAuthService({ exchange: async () => ({ apiKey: '', modelCatalog: [], identityConnected: true }) })
  const attempt = await auth.start()
  expect((await auth.complete({ ...attempt, callbackUrl: callback })).identityConnected).toBe(true)
  expect((await new ProviderService().listProviders()).providers).toHaveLength(0)
  for (const value of [callback + '&token=duplicate', callback + '&unknown=x', callback.replace('tokenType=8', 'tokenType=1'), callback + '&name=%0a']) expect(() => parseSeasunCallback(value)).toThrow()
  expect(matchesDesktopCapability('same', 'same')).toBe(true)
  expect(matchesDesktopCapability('other', 'same')).toBe(false)
  const url = new URL('http://localhost/api/provider-integrations/seasun/start')
  expect((await handleApiRequest(new Request(url, { method: 'POST' }), url)).status).toBe(403)
  expect(parseSeasunModels(models).every(value => value.transport!.endpoint.startsWith(SEASUN_GATEWAY))).toBe(true)
})
