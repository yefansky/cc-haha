import { describe, it, expect, beforeEach, afterEach } from 'bun:test'
import { WsBridge } from '../ws-bridge.js'
import { WebSocketServer, type WebSocket as WsServerSocket } from 'ws'
import { WechatQuestions, withWechatInteractionHint } from '../../wechat/questions.js'

async function waitFor(
  predicate: () => boolean,
  timeoutMs = 500,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return true
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  return predicate()
}

describe('WsBridge', () => {
  let bridge: WsBridge

  beforeEach(() => {
    bridge = new WsBridge('ws://127.0.0.1:19999', 'test')
  })

  afterEach(() => {
    bridge.destroy()
  })

  it('connectSession connects with provided sessionId', () => {
    const result = bridge.connectSession('chat-1', 'my-uuid-session-id')
    expect(result).toBe(true)
    expect(bridge.hasSession('chat-1')).toBe(true)
    expect(bridge.getSessionId('chat-1')).toBe('my-uuid-session-id')
    expect(bridge.isSessionOpen('chat-1', 'my-uuid-session-id')).toBe(false)
  })

  it('connectSession for different chatIds creates separate sessions', () => {
    bridge.connectSession('chat-1', 'uuid-1')
    bridge.connectSession('chat-2', 'uuid-2')
    expect(bridge.hasSession('chat-1')).toBe(true)
    expect(bridge.hasSession('chat-2')).toBe(true)
  })

  it('resetSession removes the session', () => {
    bridge.connectSession('chat-reset', 'uuid-reset')
    bridge.resetSession('chat-reset')
    expect(bridge.hasSession('chat-reset')).toBe(false)
  })

  it('sendUserMessage returns false when no open connection', () => {
    bridge.connectSession('chat-offline', 'uuid-offline')
    expect(bridge.sendUserMessage('chat-offline', 'hello')).toBe(false)
  })

  it('sendPermissionResponse returns false when no open connection', () => {
    bridge.connectSession('chat-perm', 'uuid-perm')
    expect(bridge.sendPermissionResponse('chat-perm', 'req-1', true)).toBe(false)
  })

  it('sendStopGeneration returns false when no open connection', () => {
    bridge.connectSession('chat-stop', 'uuid-stop')
    expect(bridge.sendStopGeneration('chat-stop')).toBe(false)
  })

  it('destroy cleans up all sessions without leaking connecting-socket errors', async () => {
    bridge.connectSession('a', 'uuid-a')
    bridge.connectSession('b', 'uuid-b')
    const sockets = [...(bridge as any).sessions.values()]
      .map((session: any) => session.ws)
    bridge.destroy()
    expect(bridge.hasSession('a')).toBe(false)
    expect(bridge.hasSession('b')).toBe(false)

    for (const ws of sockets) {
      const settled = await waitFor(() => (
        ws.readyState === ws.CLOSED
        && ws.listenerCount('open') === 0
        && ws.listenerCount('error') === 0
        && ws.listenerCount('close') === 0
      ))
      expect(settled).toBe(true)
      expect(ws.readyState).toBe(ws.CLOSED)
      expect(ws.listenerCount('open')).toBe(0)
      expect(ws.listenerCount('error')).toBe(0)
      expect(ws.listenerCount('close')).toBe(0)
    }
  })
})

// ---------------------------------------------------------------------------
// Integration: per-chat handler serialization
//
// Reproduces the feishu text→tool→text race: a slow handler on msg 1 must
// complete BEFORE msg 2's handler starts, otherwise msg 2 reads the stale
// state msg 1's continuation is about to clear.
// ---------------------------------------------------------------------------

describe('WsBridge: handler serialization', () => {
  let server: WebSocketServer
  let port: number
  let connections: WsServerSocket[]
  let serverUrl: string

  beforeEach(async () => {
    connections = []
    // port 0 → let the OS pick a free one
    server = new WebSocketServer({ port: 0 })
    server.on('connection', (ws) => {
      connections.push(ws)
    })
    await new Promise<void>((resolve) => server.on('listening', () => resolve()))
    port = (server.address() as { port: number }).port
    serverUrl = `ws://127.0.0.1:${port}`
  })

  afterEach(async () => {
    // Forcibly kill any server-side sockets (not graceful close) so
    // WebSocketServer.close() doesn't wait for client FIN.
    for (const ws of connections) {
      try { ws.terminate() } catch {}
    }
    await new Promise<void>((resolve) => {
      const t = setTimeout(() => resolve(), 500) // hard cap
      server.close(() => {
        clearTimeout(t)
        resolve()
      })
    })
  })

  async function waitForServerConnection(): Promise<WsServerSocket> {
    if (connections[0]) return connections[0]
    await new Promise<void>((resolve, reject) => {
      const onConnection = () => {
        clearTimeout(timer)
        resolve()
      }
      const timer = setTimeout(() => {
        server.off('connection', onConnection)
        reject(new Error('Timed out waiting for test WebSocket connection'))
      }, 500)
      server.once('connection', onConnection)
    })
    return connections[0]!
  }

  it('authenticates websocket connections with the desktop local access token', async () => {
    let requestUrl = ''
    server.once('connection', (_ws, request) => {
      requestUrl = request.url || ''
    })
    const bridge = new WsBridge(serverUrl, 'test', 'adapter secret/with spaces')

    bridge.connectSession('chat-auth', 'sess-auth')
    expect(await bridge.waitForOpen('chat-auth')).toBe(true)
    await waitForServerConnection()

    expect(new URL(requestUrl, serverUrl).searchParams.get('token'))
      .toBe('adapter secret/with spaces')
    bridge.destroy()
  })

  it('delivers text question answers on the existing permission protocol over a real socket', async () => {
    const bridge = new WsBridge(serverUrl, 'wechat')
    const questions = new WechatQuestions()
    bridge.onServerMessage('wx', (msg) => {
      if (msg.type === 'permission_request') questions.add(msg.requestId, msg.input)
      if (msg.type === 'permission_resolved') questions.delete(msg.requestId)
    })
    try {
      bridge.connectSession('wx', 'wx-session')
      expect(await bridge.waitForOpen('wx')).toBe(true)
      const ws = await waitForServerConnection()
      const input = { questions: [{ question: '继续吗？', header: '确认', multiSelect: false,
        options: [{ label: '继续', description: '继续操作' }, { label: '停止', description: '结束' }] }] }
      ws.send(JSON.stringify({ type: 'permission_request', requestId: 'ask-1', toolName: 'AskUserQuestion', input }))
      expect(await waitFor(() => questions.has('ask-1'))).toBe(true)
      const reply = questions.reply('1', true)
      expect(reply.kind).toBe('answer')
      const received = new Promise<any>(resolve => ws.once('message', raw => resolve(JSON.parse(raw.toString()))))
      if (reply.kind === 'answer') {
        expect(bridge.sendPermissionResponse('wx', reply.requestId, true, undefined, reply.updatedInput)).toBe(true)
      }
      expect(await received).toEqual({ type: 'permission_response', requestId: 'ask-1', allowed: true,
        updatedInput: { ...input, answers: { '继续吗？': '继续' } } })
      ws.send(JSON.stringify({ type: 'permission_resolved', requestId: 'ask-1', permissionType: 'tool' }))
      expect(await waitFor(() => !questions.has('ask-1'))).toBe(true)
      expect(questions.reply('接着聊', true).kind).toBe('unhandled')
    } finally { bridge.destroy() }
  })

  it('keeps other adapter messages and ordinary approvals unchanged', async () => {
    const bridge = new WsBridge(serverUrl, 'telegram')
    try {
      bridge.connectSession('other', 'other-session')
      expect(await bridge.waitForOpen('other')).toBe(true)
      const ws = await waitForServerConnection()
      const messages: any[] = []
      ws.on('message', raw => messages.push(JSON.parse(raw.toString())))
      bridge.sendUserMessage('other', '选择方案')
      bridge.sendPermissionResponse('other', 'bash-1', true, 'always')
      bridge.sendUserMessage('other', withWechatInteractionHint('/clear'))
      expect(await waitFor(() => messages.length === 3)).toBe(true)
      expect(messages).toEqual([
        { type: 'user_message', content: '选择方案' },
        { type: 'permission_response', requestId: 'bash-1', allowed: true, rule: 'always' },
        { type: 'user_message', content: '/clear' },
      ])
    } finally { bridge.destroy() }
  })

  it('processes handler calls in strict FIFO order per chatId', async () => {
    const bridge = new WsBridge(serverUrl, 'test')
    const events: string[] = []

    // The handler simulates an async side effect that takes varying time.
    // If handlers ran concurrently, fast msgs could finish before slow ones,
    // producing an out-of-order `events` array.
    bridge.onServerMessage('chat-1', async (msg: any) => {
      const tag = msg.tag as string
      const delay = msg.delay as number
      events.push(`start:${tag}`)
      await new Promise((r) => setTimeout(r, delay))
      events.push(`end:${tag}`)
    })

    bridge.connectSession('chat-1', 'sess-1')
    const ok = await bridge.waitForOpen('chat-1')
    expect(ok).toBe(true)
    const serverWs = await waitForServerConnection()

    // Blast three messages back-to-back. msg1 is slow, msg2/msg3 are fast.
    // With serialization: start:1, end:1, start:2, end:2, start:3, end:3
    // Without serialization: start:1, start:2, start:3, end:2, end:3, end:1
    serverWs.send(JSON.stringify({ tag: '1', delay: 40 }))
    serverWs.send(JSON.stringify({ tag: '2', delay: 5 }))
    serverWs.send(JSON.stringify({ tag: '3', delay: 5 }))

    // Wait long enough for all three handlers to run serially
    await new Promise((r) => setTimeout(r, 200))

    expect(events).toEqual([
      'start:1', 'end:1',
      'start:2', 'end:2',
      'start:3', 'end:3',
    ])

    bridge.destroy()
  })

  it('handler error does not break the chain (subsequent messages still run)', async () => {
    const bridge = new WsBridge(serverUrl, 'test')
    const events: string[] = []

    bridge.onServerMessage('chat-err', async (msg: any) => {
      if (msg.throw) {
        events.push('throwing')
        throw new Error('boom')
      }
      events.push(`ok:${msg.tag}`)
    })

    bridge.connectSession('chat-err', 'sess-err')
    await bridge.waitForOpen('chat-err')
    const serverWs = await waitForServerConnection()

    serverWs.send(JSON.stringify({ throw: true }))
    serverWs.send(JSON.stringify({ tag: 'after' }))

    await new Promise((r) => setTimeout(r, 80))

    expect(events).toEqual(['throwing', 'ok:after'])

    bridge.destroy()
  })

  it('forgets a chat when the server closes the session normally', async () => {
    const bridge = new WsBridge(serverUrl, 'test')
    bridge.onServerMessage('chat-deleted', () => {})
    bridge.connectSession('chat-deleted', 'sess-deleted')
    await bridge.waitForOpen('chat-deleted')

    const serverWs = await waitForServerConnection()
    serverWs.close(1000, 'session deleted')

    await new Promise((resolve) => setTimeout(resolve, 50))

    expect(bridge.hasSession('chat-deleted')).toBe(false)
    await new Promise((resolve) => setTimeout(resolve, 1_100))
    expect(connections).toHaveLength(1)

    bridge.destroy()
  })

  it('resetSession clears the handler chain', async () => {
    const bridge = new WsBridge(serverUrl, 'test')
    bridge.onServerMessage('chat-reset', () => {})
    bridge.connectSession('chat-reset', 'sess-reset')
    await bridge.waitForOpen('chat-reset')
    const staleSession = (bridge as any).sessions.get('chat-reset')
    expect(staleSession.ws.listenerCount('message')).toBeGreaterThan(0)

    bridge.resetSession('chat-reset')
    expect(bridge.hasSession('chat-reset')).toBe(false)
    expect(staleSession.ws.listenerCount('message')).toBe(0)
    await new Promise<void>((resolve) => {
      if (staleSession.ws.readyState === staleSession.ws.CLOSED) {
        resolve()
        return
      }
      staleSession.ws.once('close', () => resolve())
    })
    expect(staleSession.ws.listenerCount('close')).toBe(0)
    expect(staleSession.ws.listenerCount('error')).toBe(0)

    bridge.destroy()
  })

  it('does not dispatch stale messages from a socket reset before reconnect', async () => {
    const bridge = new WsBridge(serverUrl, 'test')
    const events: string[] = []

    bridge.onServerMessage('chat-resume', (msg: any) => {
      events.push(String(msg.tag))
    })
    bridge.connectSession('chat-resume', 'sess-old')
    expect(await bridge.waitForOpen('chat-resume')).toBe(true)
    const oldServerWs = await waitForServerConnection()

    bridge.resetSession('chat-resume')
    bridge.onServerMessage('chat-resume', (msg: any) => {
      events.push(String(msg.tag))
    })
    bridge.connectSession('chat-resume', 'sess-new')
    expect(await bridge.waitForOpen('chat-resume')).toBe(true)
    const newServerWs = connections[1]!

    oldServerWs.send(JSON.stringify({ tag: 'stale-old' }))
    newServerWs.send(JSON.stringify({ tag: 'fresh-new' }))

    await new Promise((resolve) => setTimeout(resolve, 80))

    expect(events).toEqual(['fresh-new'])

    bridge.destroy()
  })
})
