import { afterEach, beforeEach, expect, test } from 'bun:test'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { ProviderService } from '../services/providerService.js'
import { handleProxyRequest } from '../proxy/handler.js'
import { providerRuntimeSnapshots } from '../proxy/runtimeSnapshots.js'
import { resolveModelTransport, resolveProtocolEndpoint } from '../proxy/modelTransport.js'
import { parseSeasunModels } from '../providerIntegrations/seasun/protocol.js'
import { anthropicToOpenaiChat } from '../proxy/transform/anthropicToOpenaiChat.js'
import { anthropicToOpenaiResponses } from '../proxy/transform/anthropicToOpenaiResponses.js'
import { openaiResponsesToAnthropic } from '../proxy/transform/openaiResponsesToAnthropic.js'
import { openaiResponsesStreamToAnthropic } from '../proxy/streaming/openaiResponsesStreamToAnthropic.js'
import { openaiChatStreamToAnthropic } from '../proxy/streaming/openaiChatStreamToAnthropic.js'

let home: string, original: string | undefined, originalFetch: typeof fetch
beforeEach(async () => { original = process.env.CLAUDE_CONFIG_DIR; originalFetch = fetch; home = await fs.mkdtemp(path.join(os.tmpdir(), 'model-transport-')); process.env.CLAUDE_CONFIG_DIR = home })
afterEach(async () => { globalThis.fetch = originalFetch; if (original === undefined) delete process.env.CLAUDE_CONFIG_DIR; else process.env.CLAUDE_CONFIG_DIR = original; await fs.rm(home, { recursive: true, force: true }) })
const catalog = () => parseSeasunModels([
  { public_model: 'r', enabled: true, available: true, status: 'active', clients: ['codex'], capabilities: ['responses'] },
  { public_model: 'c', enabled: true, available: true, status: 'active', clients: ['grok'], capabilities: ['chat'] },
  { public_model: 'a', enabled: true, available: true, status: 'active', clients: ['claude'], capabilities: ['chat'] },
])
const stream = (text: string) => new Response(text).body!

test('one immutable provider snapshot dispatches three protocols; reauthorization and release do not mutate inflight requests', async () => {
  const service = new ProviderService()
  const provider = await service.upsertIntegratedProvider('seasun', { apiKey: 'first-key', baseUrl: '', modelCatalog: catalog() })
  const scope = providerRuntimeSnapshots.create(provider)
  await service.upsertIntegratedProvider('seasun', { apiKey: 'later-key', baseUrl: '', modelCatalog: catalog() })
  const seen: string[] = []
  globalThis.fetch = (async (input, init) => {
    const url = String(input), body = JSON.parse(String(init?.body))
    seen.push(url)
    expect(new Headers(init?.headers).get('Authorization')).toBe('Bearer first-key')
    expect(new Headers(init?.headers).get('ksyun-code-type')).toBeNull()
    if (body.model === 'r') {
      expect(body.include).toEqual(['reasoning.encrypted_content'])
      expect(body.store).toBe(false)
      return Response.json({ id: 'r1', status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: 'response-ok' }] }] })
    }
    if (body.model === 'c') return Response.json({ id: 'c1', choices: [{ index: 0, message: { role: 'assistant', content: 'chat-ok' }, finish_reason: 'stop' }] })
    return Response.json({ id: 'a1', type: 'message', role: 'assistant', model: 'a', content: [{ type: 'text', text: 'anthropic-ok' }], stop_reason: 'end_turn' })
  }) as typeof fetch
  for (const model of ['r', 'c', 'a']) {
    const url = new URL(`http://localhost/proxy/scopes/${scope}/v1/messages`)
    const response = await handleProxyRequest(new Request(url, { method: 'POST', body: JSON.stringify({ model, max_tokens: 10, messages: [{ role: 'user', content: 'hello' }] }) }), url)
    expect(response.status).toBe(200)
    expect((await response.json()).content[0].text).toContain('ok')
  }
  expect(seen.map(value => new URL(value).pathname)).toEqual(['/airoute/responses', '/airoute/v1/chat/completions', '/airoute/anthropic/v1/messages'])
  const held = providerRuntimeSnapshots.read(scope)!
  providerRuntimeSnapshots.release(scope)
  expect(providerRuntimeSnapshots.read(scope)).toBeUndefined()
  expect(held.apiKey).toBe('first-key')
})

test('schema 3 upgrade preserves unknown metadata and never invents transport for ordinary providers', async () => {
  const service = new ProviderService()
  const ordinary = await service.addProvider({ presetId: 'custom', name: 'Old', apiKey: 'old', baseUrl: 'https://example.test', models: { main: 'x', opus: '', sonnet: '', haiku: '' }, apiFormat: 'anthropic' })
  const file = path.join(home, 'cc-haha/providers.json')
  const raw = JSON.parse(await fs.readFile(file, 'utf8'))
  raw.schemaVersion = 3; raw.futureRoot = { retained: true }; raw.providers[0].futureProvider = 42
  raw.providers[0].modelCatalog = [{ id: 'x', capabilities: [], futureEntry: true, transport: { apiFormat: 'anthropic', endpoint: 'https://example.test/v1/messages', futureTransport: 1, features: { futureFeature: 'yes' } } }]
  await fs.writeFile(file, JSON.stringify(raw))
  const { resetPersistentStorageMigrationsForTests } = await import('../services/persistentStorageMigrations.js')
  resetPersistentStorageMigrationsForTests()
  await service.updateProvider(ordinary.id, { name: 'Updated' })
  const updated = JSON.parse(await fs.readFile(file, 'utf8'))
  expect(updated.schemaVersion).toBe(4)
  expect(updated.futureRoot.retained).toBe(true)
  expect(updated.providers[0].futureProvider).toBe(42)
  expect(updated.providers[0].modelCatalog[0]).toMatchObject(raw.providers[0].modelCatalog[0])
  expect(resolveModelTransport({ modelCatalog: undefined }, 'x')).toBeUndefined()
  expect(resolveProtocolEndpoint('https://example.test/v1', 'openai_chat')).toBe('https://example.test/v1/chat/completions')
  expect(resolveProtocolEndpoint('https://example.test/v1/responses', 'openai_responses')).toBe('https://example.test/v1/responses')
  expect(() => resolveModelTransport({ presetId: 'seasun', modelCatalog: [{ id: 'x', capabilities: [], transport: { apiFormat: 'anthropic', endpoint: 'https://attacker.test/v1/messages' } }] }, 'x')).toThrow()
})

test('Responses opaque reasoning round trips without OAuth and strict stream errors never become success', async () => {
  const item = { id: 'rs_1', type: 'reasoning' as const, encrypted_content: 'opaque-test', summary: [] }
  const result = openaiResponsesToAnthropic({ id: 'r1', status: 'completed', output: [item] }, 'r', { preserveOpenAIReasoning: true })
  const next = anthropicToOpenaiResponses({ model: 'r', max_tokens: 12, messages: [{ role: 'assistant', content: result.content }] }, { preserveOpenAIReasoning: true })
  expect(next.input).toContainEqual(item)
  const encryptedStream = 'event: response.output_item.done\ndata: ' + JSON.stringify({ item }) + '\n\nevent: response.completed\ndata: {"response":{"status":"completed"}}\n\n'
  expect(await new Response(openaiResponsesStreamToAnthropic(stream(encryptedStream), 'r', { strictStream: true, preserveReasoning: true })).text()).toContain('redacted_thinking')
  const failed = await new Response(openaiResponsesStreamToAnthropic(stream('event: response.failed\ndata: {"response":{"error":{"message":"failed"}}}\n\n'), 'r', { strictStream: true })).text()
  expect(failed).toContain('event: error')
  expect(failed).not.toContain('event: message_stop')
})

test('Chat keeps tool-result images and reasoning; strict truncated/late/multiple-choice streams reject', async () => {
  const converted = anthropicToOpenaiChat({ model: 'c', max_tokens: 12, messages: [
    { role: 'assistant', content: [{ type: 'thinking', thinking: 'retain' }, { type: 'tool_use', id: 't1', name: 'look', input: {} }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: [{ type: 'text', text: 'image' }, { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AA==' } }] }] },
  ] }, { roundTripReasoningContent: true })
  expect(converted.messages).toContainEqual({ role: 'tool', tool_call_id: 't1', content: 'image' })
  expect(JSON.stringify(converted.messages)).toContain('data:image/png;base64,AA==')
  expect(converted.messages.find(value => value.role === 'assistant')?.reasoning_content).toBe('retain')
  for (const chunks of [
    [{ choices: [{ index: 0, delta: { content: 'partial' }, finish_reason: null }] }],
    [{ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }, { choices: [{ index: 0, delta: { content: 'late' } }] }],
    [{ choices: [{ index: 1, delta: {}, finish_reason: 'stop' }] }],
    [{ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 't1', type: 'function', function: { name: 'look', arguments: '{' } }] }, finish_reason: 'tool_calls' }] }],
  ]) {
    const data = chunks.map(value => `data: ${JSON.stringify(value)}\n\n`).join('') + 'data: [DONE]\n\n'
    const failure = await new Response(openaiChatStreamToAnthropic(stream(data), 'c', { strictStream: true })).text()
    expect(failure).toContain('event: error')
    expect(failure).toContain('invalid_request_error')
    expect(failure).not.toContain('event: message_stop')
  }
})

test('strict Chat applies final tool deltas before validation and emits successful tool completion before replay', async () => {
  for (const finishTogether of [false, true]) {
    const chunks = [
      { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'call-a', type: 'function', function: { name: 'Read', arguments: '{"path":' } }] } }] },
      { choices: [{ index: 0, delta: { tool_calls: [{ index: 1, id: 'call-b', type: 'function', function: { name: 'Read', arguments: '{"path":"b"}' } }, { index: 0, function: { arguments: '"a"}' } }] }, finish_reason: finishTogether ? 'tool_calls' : null }] },
      ...(!finishTogether ? [{ choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] }] : []),
      { choices: [], usage: { prompt_tokens: 3, completion_tokens: 2 } },
    ]
    const data = chunks.map(value => `data: ${JSON.stringify(value)}\n\n`).join('') + 'data: [DONE]\n\n'
    const output = await new Response(openaiChatStreamToAnthropic(stream(data), 'c', { strictStream: true })).text()
    const events = output.split('\n').filter(line => line.startsWith('data: ')).map(line => JSON.parse(line.slice(6)))
    const starts = events.filter(value => value.type === 'content_block_start' && value.content_block.type === 'tool_use')
    expect(starts.map(value => value.content_block.id)).toEqual(['call-a', 'call-b'])
    for (const started of starts) {
      const args = events.filter(value => value.type === 'content_block_delta' && value.index === started.index).map(value => value.delta.partial_json).join('')
      expect(JSON.parse(args).path).toBe(started.content_block.id === 'call-a' ? 'a' : 'b')
    }
    expect(events.filter(value => value.type === 'message_delta').map(value => value.delta.stop_reason)).toEqual(['tool_use'])
    expect(events.filter(value => value.type === 'message_stop')).toHaveLength(1)
    expect(output).not.toContain('event: error')
    const replay = anthropicToOpenaiChat({ model: 'c', max_tokens: 8, messages: [{ role: 'assistant', content: starts.map(value => ({ ...value.content_block, input: { path: value.content_block.id === 'call-a' ? 'a' : 'b' } })) }, { role: 'user', content: starts.map(value => ({ type: 'tool_result', tool_use_id: value.content_block.id, content: 'read-result' })) }] })
    expect(replay.messages.filter(value => value.role === 'tool').map(value => value.tool_call_id)).toEqual(['call-a', 'call-b'])
  }
})

test('strict protocol failures cross real HTTP as SDK errors, without normal completion or remote error disclosure', async () => {
  const { default: Anthropic } = await import('@anthropic-ai/sdk')
  const responsePrefix = 'event: response.created\ndata: {"response":{"id":"fixture-http"}}\n\n'
    + 'event: response.content_part.added\ndata: {"output_index":0,"content_index":0,"part":{"type":"output_text"}}\n\n'
    + 'event: response.output_text.delta\ndata: {"output_index":0,"content_index":0,"delta":"partial"}\n\n'
    + 'event: response.output_text.done\ndata: {"output_index":0,"content_index":0}\n\n'
  const variants = [
    () => openaiResponsesStreamToAnthropic(stream(responsePrefix), 'r', { strictStream: true }),
    () => openaiResponsesStreamToAnthropic(stream('event: response.failed\ndata: {"response":{"error":{"message":"remote-fake-secret"}}}\n\n'), 'r', { strictStream: true }),
    () => openaiChatStreamToAnthropic(stream('data: {"choices":[{"index":0,"delta":{"content":"partial"}}]}\n\n'), 'c', { strictStream: true }),
    () => openaiChatStreamToAnthropic(stream('data: {"error":{"message":"remote-fake-secret"}}\n\n'), 'c', { strictStream: true }),
  ]
  for (const makeBody of variants) {
    const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response(makeBody(), { headers: { 'Content-Type': 'text/event-stream' } }) })
    try {
      const client = new Anthropic({ apiKey: 'fixture-local', baseURL: `http://127.0.0.1:${server.port}`, maxRetries: 0 })
      const received: string[] = []
      let failure: unknown
      try {
        const response = await client.messages.create({ model: 'fixture', max_tokens: 8, stream: true, messages: [{ role: 'user', content: 'test' }] })
        for await (const event of response) received.push(event.type)
      } catch (error) { failure = error }
      expect(failure).toBeDefined()
      expect(String(failure)).toContain('Provider response was interrupted or invalid')
      expect(String(failure)).not.toContain('remote-fake-secret')
      expect(received).not.toContain('message_stop')
    } finally { server.stop(true) }
  }
})
