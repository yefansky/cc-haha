import { afterAll, beforeAll, expect, test } from 'bun:test'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHeadlessProviderRuntime } from './headlessProviderRuntime.js'
import type { SavedProvider } from '../types/provider.js'
import { loadNetworkSettings } from './networkSettings.js'

let configDir: string
const previousConfig = process.env.CLAUDE_CONFIG_DIR
beforeAll(async () => {
  configDir = await mkdtemp(join(tmpdir(), 'cc-haha-headless-env-'))
  process.env.CLAUDE_CONFIG_DIR = configDir
  await mkdir(join(configDir, 'cc-haha'), { recursive: true })
  await writeFile(join(configDir, 'cc-haha', 'providers.json'), JSON.stringify({ activeId: 'desktop-default', providers: [] }))
})
afterAll(async () => {
  if (previousConfig === undefined) delete process.env.CLAUDE_CONFIG_DIR
  else process.env.CLAUDE_CONFIG_DIR = previousConfig
  await rm(configDir, { recursive: true, force: true })
})
const provider = (id: string, baseUrl: string, apiFormat = 'anthropic'): SavedProvider => ({
  id, presetId: 'custom', name: id, apiKey: `key-${id}`, baseUrl, apiFormat,
  models: { main: 'old', haiku: 'old', sonnet: 'old', opus: 'old' },
} as SavedProvider)

test('host-managed explicit env defeats inherited routing without mutating GUI selection or provider', async () => {
  const source = provider('one', 'http://127.0.0.1:1')
  const baseline = await readFile(join(configDir, 'cc-haha/providers.json'), 'utf8')
  const runtime = await createHeadlessProviderRuntime(source, 'chosen-model', configDir, { ANTHROPIC_API_KEY: 'stale', ANTHROPIC_BASE_URL: 'stale', CLAUDE_CODE_OAUTH_TOKEN: 'stale' })
  try {
    expect(runtime.env.ANTHROPIC_BASE_URL).toBe(source.baseUrl)
    expect(runtime.env.ANTHROPIC_MODEL).toBe('chosen-model')
    expect(runtime.env.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined()
    expect(runtime.env.CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST).toBe('1')
    expect(runtime.env.CC_HAHA_TRACE_API_CALLS).toBe('0')
    expect(runtime.env.CALLER_DIR).toBe(configDir)
    expect(source.models.main).toBe('old')
    expect(await readFile(join(configDir, 'cc-haha/providers.json'), 'utf8')).toBe(baseline)
  } finally { runtime.dispose() }
})

test('isolated loopback proxy reuses real translation and rejects other scopes', async () => {
  const upstream = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(req) {
    const body = await req.json() as any
    expect(req.headers.get('authorization')).toBe('Bearer key-two')
    expect(body.model).toBe('loopback-model')
    return Response.json({ id: 'chat-1', object: 'chat.completion', model: body.model, choices: [{ index: 0, message: { role: 'assistant', content: 'OK' }, finish_reason: 'stop' }], usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 } })
  } })
  const runtime = await createHeadlessProviderRuntime(provider('two', `http://127.0.0.1:${upstream.port}/v1`, 'openai_chat'), 'loopback-model', configDir)
  try {
    const response = await fetch(`${runtime.env.ANTHROPIC_BASE_URL}/v1/messages`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: 'loopback-model', max_tokens: 20, messages: [{ role: 'user', content: 'OK' }] }) })
    expect(response.status).toBe(200)
    const message = await response.json() as any
    expect(message.content[0].text).toBe('OK')
    expect(message.usage.input_tokens).toBe(3)
    expect(runtime.secrets).toContain(new URL(runtime.env.ANTHROPIC_BASE_URL!).pathname.split('/').at(-1)!)
    const origin = new URL(runtime.env.ANTHROPIC_BASE_URL!).origin
    expect((await fetch(`${origin}/proxy/v1/messages`, { method: 'POST' })).status).toBe(404)
  } finally { runtime.dispose(); upstream.stop(true) }
})

test('read-only network snapshot preserves legacy index bytes while ordinary GUI load retains upgrade behavior', async () => {
  const index = join(configDir, 'cc-haha/providers.json')
  const legacy = JSON.stringify({ activeId: 'legacy-invalid', providers: [] })
  await writeFile(index, legacy)
  await writeFile(join(configDir, 'settings.json'), JSON.stringify({ network: { aiRequestTimeoutMs: 1, proxy: { mode: 'direct' } } }))
  expect((await loadNetworkSettings({ readOnly: true })).aiRequestTimeoutMs).toBe(30000)
  expect(await readFile(index, 'utf8')).toBe(legacy)
  expect((await loadNetworkSettings()).proxy.mode).toBe('direct')
  expect(await readFile(index, 'utf8')).not.toBe(legacy)
})
