import { afterEach, beforeEach, expect, it, mock, spyOn } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { handleWebSocket, __resetWebSocketHandlerStateForTests, __registerPendingSessionStartupForTests } from '../ws/handler.js'
import { conversationService } from '../services/conversationService.js'
import { sessionService } from '../services/sessionService.js'
import { ProviderService } from '../services/providerService.js'
import { SettingsService } from '../services/settingsService.js'

let directory: string
let previousConfig: string | undefined
let running = false
let failProvider: string | undefined
const starts: any[] = []
const metadata = new Map<string, any>()
const callbacks = new Set<(message: any) => void>()
let sentUserMessages = 0
const provider = (id: string) => ({ id, name: id, presetId: 'custom', apiKey: `fake-${id}`,
  baseUrl: `http://${id}.invalid`, apiFormat: 'anthropic', models: { main: `${id}-main`, sonnet: 'shared' } })
const providers = [provider('a'), provider('b')]
let socket: any

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'runtime-pair-test-'))
  previousConfig = process.env.CLAUDE_CONFIG_DIR
  process.env.CLAUDE_CONFIG_DIR = directory
  running = false; failProvider = undefined; starts.length = 0; metadata.clear(); callbacks.clear(); sentUserMessages = 0
  const sent: any[] = []
  socket = { data: { sessionId: crypto.randomUUID(), channel: 'client', connectedAt: Date.now(), clientKind: 'full', sdkToken: null, serverPort: 1, serverHost: '127.0.0.1' },
    send: (raw: string) => sent.push(JSON.parse(raw)), close() {}, sent }
  spyOn(ProviderService.prototype, 'getProvider').mockImplementation(async id => providers.find(p => p.id === id) as any)
  spyOn(ProviderService.prototype, 'listProviders').mockResolvedValue({ activeId: 'a', providers } as any)
  spyOn(ProviderService.prototype, 'getManagedSettings').mockResolvedValue({ model: 'a-main' })
  spyOn(SettingsService.prototype, 'getUserSettings').mockResolvedValue({} as any)
  spyOn(SettingsService.prototype, 'getPermissionMode').mockResolvedValue('default')
  spyOn(sessionService, 'getSessionLaunchInfo').mockImplementation(async id => metadata.get(id) ?? { workDir: directory })
  spyOn(sessionService, 'getSessionWorkDir').mockResolvedValue(directory)
  spyOn(sessionService, 'appendSessionMetadata').mockImplementation(async (id, value) => { metadata.set(id, { ...metadata.get(id), ...value }) })
  spyOn(conversationService, 'hasSession').mockImplementation(() => running)
  spyOn(conversationService, 'getSessionWorkDir').mockReturnValue(directory)
  spyOn(conversationService, 'getSessionPermissionMode').mockReturnValue('default')
  spyOn(conversationService, 'stopSession').mockImplementation(() => { running = false })
  spyOn(conversationService, 'onOutput').mockImplementation((_id, callback) => { callbacks.add(callback) })
  spyOn(conversationService, 'removeOutputCallback').mockImplementation((_id, callback) => { callbacks.delete(callback) })
  spyOn(conversationService, 'clearOutputCallbacks').mockImplementation(() => { callbacks.clear() })
  spyOn(conversationService, 'sendMessage').mockImplementation(async (_id, _text, _attachments, options) => {
    options?.onCommitted?.(); sentUserMessages++; return true
  })
  spyOn(conversationService, 'startSession').mockImplementation(async (_id, _dir, _url, options) => {
    starts.push(options)
    if (options?.providerId === failProvider) throw new Error('PRIVATE_STARTUP_SECRET')
    running = true
  })
  handleWebSocket.open(socket)
  await settle(() => socket.sent.some((m: any) => m.type === 'permission_requests_snapshot'))
})

afterEach(async () => {
  __resetWebSocketHandlerStateForTests(); mock.restore()
  if (previousConfig === undefined) delete process.env.CLAUDE_CONFIG_DIR
  else process.env.CLAUDE_CONFIG_DIR = previousConfig
  await rm(directory, { recursive: true, force: true })
})

async function settle(predicate: () => boolean) {
  for (let i = 0; i < 150; i++) {
    if (predicate()) return
    await new Promise(resolve => setTimeout(resolve, 5))
  }
  throw new Error('Runtime transition did not settle')
}
function select(providerId: string, modelId: string, requestId?: string) {
  handleWebSocket.message(socket, JSON.stringify({ type: 'set_runtime_config', providerId, modelId, ...(requestId ? { requestId } : {}) }))
}
const applied = (id: string) => socket.sent.some((m: any) => m.type === 'runtime_config_applied' && m.requestId === id)

it('switches same-name models as explicit pairs and acknowledges repeated selections and legacy clients', async () => {
  select('a', 'shared', 'a1'); await settle(() => applied('a1'))
  running = true
  select('b', 'shared', 'b1'); await settle(() => applied('b1'))
  expect(starts.at(-1)).toMatchObject({ providerId: 'b', model: 'shared' })
  expect(metadata.get(socket.data.sessionId)).toMatchObject({ runtimeProviderId: 'b', runtimeModelId: 'shared' })
  select('b', 'shared', 'b2'); await settle(() => applied('b2'))
  const previous = socket.sent.length
  select('a', 'shared'); await settle(() => socket.sent.slice(previous).some((m: any) => m.type === 'runtime_config_applied'))
  expect(starts.at(-1)).toMatchObject({ providerId: 'a', model: 'shared' })
  expect((await new ProviderService().listProviders()).activeId).toBe('a')
})

it('restores the confirmed pair after a failed restart and can restart it again', async () => {
  select('a', 'shared', 'a'); await settle(() => applied('a'))
  running = true; failProvider = 'b'
  select('b', 'shared', 'failed-b')
  await settle(() => socket.sent.some((m: any) => m.type === 'runtime_config_failed' && m.requestId === 'failed-b'))
  expect(socket.sent.find((m: any) => m.type === 'runtime_config_failed')).toMatchObject({ providerId: 'b', modelId: 'shared', restored: { providerId: 'a', modelId: 'shared' } })
  expect(metadata.get(socket.data.sessionId)).toMatchObject({ runtimeProviderId: 'a', runtimeModelId: 'shared' })
  expect(JSON.stringify(socket.sent)).not.toContain('PRIVATE_STARTUP_SECRET')
  failProvider = undefined
  handleWebSocket.message(socket, JSON.stringify({ type: 'user_message', content: 'resume confirmed provider', messageUuid: crypto.randomUUID() }))
  await settle(() => sentUserMessages === 1)
  expect(starts.at(-1)).toMatchObject({ providerId: 'a', model: 'shared' })
})

it('serializes rapid changes so an old failed request cannot replace the later confirmed pair', async () => {
  select('a', 'shared', 'initial'); await settle(() => applied('initial'))
  running = true; failProvider = 'b'
  select('b', 'shared', 'old'); select('a', 'a-main', 'latest')
  await settle(() => applied('latest'))
  expect(metadata.get(socket.data.sessionId)).toMatchObject({ runtimeProviderId: 'a', runtimeModelId: 'a-main' })
  expect(socket.sent.filter((m: any) => m.type === 'runtime_config_applied').at(-1)).toMatchObject({ requestId: 'latest', providerId: 'a', modelId: 'a-main' })
})

it('rejects an invalid provider/model pair without changing persisted configuration', async () => {
  select('a', 'shared', 'confirmed'); await settle(() => applied('confirmed'))
  select('a', 'b-main', 'invalid')
  await settle(() => socket.sent.some((m: any) => m.type === 'runtime_config_failed' && m.requestId === 'invalid'))
  expect(metadata.get(socket.data.sessionId)).toMatchObject({ runtimeProviderId: 'a', runtimeModelId: 'shared' })
  expect(starts).toHaveLength(0)
})

it.each([false, true])('waits for pending startup and only acknowledges a persisted pair (failure=%s)', async fail => {
  select('a', 'shared', 'confirmed'); await settle(() => applied('confirmed'))
  let finish!: () => void
  let reject!: () => void
  const startup = new Promise<void>((resolve, no) => { finish = resolve; reject = () => no(new Error('fake startup failure')) })
  __registerPendingSessionStartupForTests(socket.data.sessionId, startup)
  select('b', 'shared', 'pending')
  await new Promise(resolve => setTimeout(resolve, 25))
  expect(applied('pending')).toBe(false)
  expect(metadata.get(socket.data.sessionId).runtimeProviderId).toBe('a')
  if (fail) reject()
  else { running = true; finish() }
  await settle(() => socket.sent.some((m: any) => m.requestId === 'pending' && ['runtime_config_applied', 'runtime_config_failed'].includes(m.type)))
  expect(metadata.get(socket.data.sessionId).runtimeProviderId).toBe(fail ? 'a' : 'b')
  expect(applied('pending')).toBe(!fail)
})

it('does not acknowledge a failed metadata commit and stops the uncommitted replacement runtime', async () => {
  select('a', 'shared', 'confirmed'); await settle(() => applied('confirmed'))
  running = true
  spyOn(sessionService, 'appendSessionMetadata').mockImplementation(async (id, value) => {
    if (value.runtimeProviderId === 'b') throw new Error('PRIVATE_PERSIST_FAILURE')
    metadata.set(id, { ...metadata.get(id), ...value })
  })
  select('b', 'shared', 'persist-fail')
  await settle(() => socket.sent.some((m: any) => m.type === 'runtime_config_failed' && m.requestId === 'persist-fail'))
  expect(applied('persist-fail')).toBe(false)
  expect(running).toBe(false)
  expect(metadata.get(socket.data.sessionId).runtimeProviderId).toBe('a')
  expect(JSON.stringify(socket.sent)).not.toContain('PRIVATE_PERSIST_FAILURE')
})

it('repairs a historical mismatched model within its explicit provider instead of guessing the other provider', async () => {
  metadata.set(socket.data.sessionId, { workDir: directory, runtimeProviderId: 'a', runtimeModelId: 'b-main' })
  running = true
  select('b', 'shared', 'new-b')
  await settle(() => applied('new-b'))
  expect(socket.sent.some((m: any) => m.type === 'runtime_config_applied' && m.providerId === 'a' && m.modelId === 'a-main')).toBe(true)
  expect(starts.at(-1)).toMatchObject({ providerId: 'b', model: 'shared' })
})

it('defers rapid selections until the active turn completes and restores the original confirmed pair on failure', async () => {
  select('a', 'shared', 'confirmed'); await settle(() => applied('confirmed'))
  running = true
  handleWebSocket.message(socket, JSON.stringify({ type: 'user_message', content: 'offline turn', messageUuid: crypto.randomUUID() }))
  await settle(() => sentUserMessages === 1)
  select('b', 'b-main', 'deferred-first'); select('b', 'shared', 'deferred-last')
  await new Promise(resolve => setTimeout(resolve, 35))
  expect(starts).toHaveLength(0)
  expect(applied('deferred-first') || applied('deferred-last')).toBe(false)
  expect(metadata.get(socket.data.sessionId).runtimeProviderId).toBe('a')
  failProvider = 'b'
  for (const callback of [...callbacks]) callback({ type: 'result', subtype: 'success', result: '', usage: {} })
  await settle(() => socket.sent.some((m: any) => m.type === 'runtime_config_failed' && m.requestId === 'deferred-last'))
  expect(starts).toHaveLength(1)
  expect(starts[0]).toMatchObject({ providerId: 'b', model: 'shared' })
  expect(metadata.get(socket.data.sessionId)).toMatchObject({ runtimeProviderId: 'a', runtimeModelId: 'shared' })
})
