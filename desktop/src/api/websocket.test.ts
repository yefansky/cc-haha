import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const clientMocks = vi.hoisted(() => ({
  baseUrl: 'http://127.0.0.1:3456',
  authToken: null as string | null,
}))

vi.mock('./client', () => ({
  getBaseUrl: () => clientMocks.baseUrl,
  getAuthToken: () => clientMocks.authToken,
}))

import { buildSessionWebSocketUrl, wsManager } from './websocket'

type SocketHandler = (() => void) | ((event: { data: string }) => void)

class FakeWebSocket {
  static readonly CONNECTING = 0
  static readonly OPEN = 1
  static readonly CLOSING = 2
  static readonly CLOSED = 3
  static instances: FakeWebSocket[] = []

  readonly url: string
  readyState = FakeWebSocket.CONNECTING
  onopen: SocketHandler | null = null
  onmessage: SocketHandler | null = null
  onclose: SocketHandler | null = null
  onerror: SocketHandler | null = null
  sent: string[] = []
  sendError: Error | null = null

  constructor(url: string) {
    this.url = url
    FakeWebSocket.instances.push(this)
  }

  send(data: string) {
    if (this.sendError) throw this.sendError
    this.sent.push(data)
  }

  close() {
    this.readyState = FakeWebSocket.CLOSED
    ;(this.onclose as (() => void) | null)?.()
  }

  open() {
    this.readyState = FakeWebSocket.OPEN
    ;(this.onopen as (() => void) | null)?.()
  }

  fail() {
    this.readyState = FakeWebSocket.CLOSED
    ;(this.onclose as (() => void) | null)?.()
  }

  receive(message: unknown) {
    ;(this.onmessage as ((event: { data: string }) => void) | null)?.({
      data: JSON.stringify(message),
    })
  }
}

describe('wsManager reconnect buffering', () => {
  const originalWebSocket = globalThis.WebSocket

  beforeEach(() => {
    vi.useFakeTimers()
    clientMocks.baseUrl = 'http://127.0.0.1:3456'
    clientMocks.authToken = null
    FakeWebSocket.instances = []
    globalThis.WebSocket = FakeWebSocket as unknown as typeof WebSocket
    wsManager.disconnectAll()
  })

  afterEach(() => {
    wsManager.disconnectAll()
    globalThis.WebSocket = originalWebSocket
    vi.useRealTimers()
  })

  it('replays queued messages after an unexpected reconnect', async () => {
    wsManager.connect('session-reconnect')
    const states: string[] = []
    wsManager.onConnectionState('session-reconnect', state => states.push(state))

    const firstSocket = FakeWebSocket.instances[0]
    expect(firstSocket?.url).toContain('/ws/session-reconnect')

    firstSocket!.open()
    wsManager.send('session-reconnect', { type: 'user_message', content: 'first' })
    expect(firstSocket!.sent).toEqual([
      JSON.stringify({ type: 'user_message', content: 'first' }),
    ])

    firstSocket!.fail()
    wsManager.send('session-reconnect', { type: 'user_message', content: 'queued while offline' })

    await vi.advanceTimersByTimeAsync(1000)

    const secondSocket = FakeWebSocket.instances[1]
    expect(secondSocket).toBeDefined()
    secondSocket!.open()

    expect(secondSocket!.sent).toEqual([
      JSON.stringify({ type: 'user_message', content: 'queued while offline' }),
      JSON.stringify({ type: 'sync_state' }),
    ])
    expect(states).toEqual(['connecting', 'connected', 'reconnecting', 'reconnecting', 'connected'])
  })

  it.each([
    ['CONNECTING', FakeWebSocket.CONNECTING],
    ['CLOSING', FakeWebSocket.CLOSING],
    ['CLOSED', FakeWebSocket.CLOSED],
  ] as const)('does not queue sendIfOpen while the socket is %s', (_label, readyState) => {
    wsManager.connect('session-current-epoch')
    const socket = FakeWebSocket.instances[0]!
    socket.readyState = readyState

    expect(wsManager.sendIfOpen('session-current-epoch', {
      type: 'user_decision_response',
      decisionId: 'decision-current-epoch',
      attemptId: 'attempt-current-epoch',
      response: { kind: 'clarify', message: 'current epoch only' },
    })).toBe(false)

    socket.open()
    expect(socket.sent).toEqual([])
  })

  it('sends sendIfOpen immediately on OPEN and reports a synchronous send failure', () => {
    wsManager.connect('session-open-send')
    const socket = FakeWebSocket.instances[0]!
    socket.open()
    const message = { type: 'user_message', content: 'immediate' } as const

    expect(wsManager.sendIfOpen('session-open-send', message)).toBe(true)
    expect(socket.sent).toContain(JSON.stringify(message))

    socket.sendError = new Error('send failed')
    expect(wsManager.sendIfOpen('session-open-send', message)).toBe(false)
  })

  it('force reconnect preserves handlers and queued messages', async () => {
    wsManager.connect('session-force-reconnect')
    const states: string[] = []
    const messages: unknown[] = []
    wsManager.onConnectionState('session-force-reconnect', state => states.push(state))
    wsManager.onMessage('session-force-reconnect', message => messages.push(message))

    const firstSocket = FakeWebSocket.instances[0]!
    firstSocket.open()
    expect(wsManager.forceReconnect('session-force-reconnect')).toBe(true)
    wsManager.send('session-force-reconnect', { type: 'user_message', content: 'kept' })

    await vi.advanceTimersByTimeAsync(1000)
    const secondSocket = FakeWebSocket.instances[1]!
    secondSocket.open()
    secondSocket.receive({ type: 'session_state', turnState: 'idle' })

    expect(secondSocket.sent).toEqual([
      JSON.stringify({ type: 'user_message', content: 'kept' }),
      JSON.stringify({ type: 'sync_state' }),
    ])
    expect(messages).toEqual([{ type: 'session_state', turnState: 'idle' }])
    expect(states).toEqual(['connecting', 'connected', 'reconnecting', 'reconnecting', 'connected'])
  })

  it('closes and reconnects a half-open socket when a pong never arrives', async () => {
    wsManager.connect('session-half-open')
    const firstSocket = FakeWebSocket.instances[0]!
    firstSocket.open()

    await vi.advanceTimersByTimeAsync(30_000)
    expect(firstSocket.sent).toContain(JSON.stringify({ type: 'ping' }))

    await vi.advanceTimersByTimeAsync(10_000)
    expect(firstSocket.readyState).toBe(FakeWebSocket.CLOSED)

    await vi.advanceTimersByTimeAsync(1000)
    expect(FakeWebSocket.instances).toHaveLength(2)
  })

  it('keeps a healthy socket open when the server answers the heartbeat', async () => {
    wsManager.connect('session-heartbeat')
    const socket = FakeWebSocket.instances[0]!
    socket.open()

    await vi.advanceTimersByTimeAsync(30_000)
    socket.receive({ type: 'pong' })
    await vi.advanceTimersByTimeAsync(10_000)

    expect(socket.readyState).toBe(FakeWebSocket.OPEN)
    expect(FakeWebSocket.instances).toHaveLength(1)
  })

  it('does not let a stale socket close stop the replacement heartbeat', async () => {
    wsManager.connect('session-stale-close')
    const firstSocket = FakeWebSocket.instances[0]!
    firstSocket.open()
    firstSocket.fail()

    await vi.advanceTimersByTimeAsync(1000)
    const secondSocket = FakeWebSocket.instances[1]!
    secondSocket.open()

    // A browser may deliver a duplicate or delayed close callback for the
    // replaced socket. It must not clear the replacement connection's timer.
    firstSocket.fail()
    await vi.advanceTimersByTimeAsync(30_000)

    expect(secondSocket.sent).toContain(JSON.stringify({ type: 'ping' }))
  })

  it('builds websocket URLs from http and encodes token query params', () => {
    clientMocks.baseUrl = 'http://10.0.0.2:3456'
    clientMocks.authToken = 'h5 token/with?chars'

    expect(buildSessionWebSocketUrl('session-reconnect')).toBe(
      'ws://10.0.0.2:3456/ws/session-reconnect?token=h5+token%2Fwith%3Fchars',
    )
  })

  it('upgrades https backends to wss', () => {
    clientMocks.baseUrl = 'https://remote.example.com'

    expect(buildSessionWebSocketUrl('secure-session')).toBe(
      'wss://remote.example.com/ws/secure-session',
    )
  })

  it('preserves reverse-proxy subpaths when building websocket URLs', () => {
    clientMocks.baseUrl = 'https://public.example.com/app'

    expect(buildSessionWebSocketUrl('s1')).toBe(
      'wss://public.example.com/app/ws/s1',
    )
  })
})
