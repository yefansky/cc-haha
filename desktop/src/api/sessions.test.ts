import { afterEach, describe, expect, it, vi } from 'vitest'
import { setBaseUrl } from './client'
import { sessionsApi } from './sessions'

describe('sessionsApi', () => {
  afterEach(() => {
    setBaseUrl('http://127.0.0.1:3456')
    vi.restoreAllMocks()
  })

  it('posts branch requests to the session branch endpoint', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch')
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({
      sessionId: 'branch-session',
      title: 'Branch',
      workDir: '/workspace/repo',
      sourceSessionId: 'source-session',
      targetMessageId: 'message-1',
    }), {
      status: 201,
      headers: { 'Content-Type': 'application/json' },
    }))

    setBaseUrl('http://127.0.0.1:49237')
    const result = await sessionsApi.branch('source-session', {
      targetMessageId: 'message-1',
      title: 'Branch',
    })

    expect(result.sessionId).toBe('branch-session')
    expect(fetchMock).toHaveBeenCalledOnce()
    const [url, init] = fetchMock.mock.calls[0]!
    expect(url).toBe('http://127.0.0.1:49237/api/sessions/source-session/branch')
    expect(init).toMatchObject({
      method: 'POST',
      body: JSON.stringify({
        targetMessageId: 'message-1',
        title: 'Branch',
      }),
    })
  })

  it('fetches a single trace call from the call detail endpoint', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch')
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({
      call: { id: 'call-1', sessionId: 'session-1' },
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }))

    const result = await sessionsApi.getTraceCall('session-1', 'call-1')

    expect(result.call.id).toBe('call-1')
    const [url, init] = fetchMock.mock.calls[0]!
    expect(url).toBe('http://127.0.0.1:3456/api/sessions/session-1/trace/calls/call-1')
    expect(init).toMatchObject({ method: 'GET' })
  })

  it('creates a local diagnostic bundle for a captured trace call', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch')
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({
      file: 'C:/audit/diagnostics/session-1/call-1.md',
      directory: 'C:/audit/diagnostics/session-1',
      workDir: 'C:/audit',
      prompt: 'Read the diagnostic bundle.',
      source: { sessionId: 'session-1', callId: 'call-1', rawRequestFile: 'C:/audit/raw.json', comparisonRawRequestFile: null },
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }))

    const result = await sessionsApi.createTraceDiagnosticBundle('session-1', 'call-1', {
      question: 'Why was the rule ignored?',
      comparisonCallId: 'call-0',
    })

    expect(result.workDir).toBe('C:/audit')
    const [url, init] = fetchMock.mock.calls[0]!
    expect(url).toBe('http://127.0.0.1:3456/api/sessions/session-1/trace/calls/call-1/diagnostic-bundle')
    expect(init).toMatchObject({
      method: 'POST',
      body: JSON.stringify({ question: 'Why was the rule ignored?', comparisonCallId: 'call-0' }),
    })
  })

  it('reads pet activity without opening a websocket session', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch')
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({
      state: 'thinking',
      activityState: 'waiting',
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }))

    const result = await sessionsApi.getChatStatus('session-1')

    expect(result.state).toBe('thinking')
    expect(result.activityState).toBe('waiting')
    expect(fetchMock).toHaveBeenCalledOnce()
    const [url, init] = fetchMock.mock.calls[0]!
    expect(url).toBe('http://127.0.0.1:3456/api/sessions/session-1/chat/status')
    expect(init).toMatchObject({ method: 'GET' })
  })

  it('searches the session workspace with an encoded query', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch')
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({
      state: 'ok',
      query: 'Mental Health Controller',
      truncated: false,
      entries: [],
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }))

    const result = await sessionsApi.searchWorkspace('session-1', 'Mental Health Controller')

    expect(result.query).toBe('Mental Health Controller')
    expect(result.truncated).toBe(false)
    const [url, init] = fetchMock.mock.calls[0]!
    expect(url).toBe('http://127.0.0.1:3456/api/sessions/session-1/workspace/search?query=Mental+Health+Controller')
    expect(init).toMatchObject({ method: 'GET' })
  })

  it('forwards an explicit null CAS expectation when creating a workspace file', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch')
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({
      state: 'ok',
      path: '新建/-review.txt',
      content: 'created\n',
      size: 8,
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }))

    const result = await sessionsApi.writeWorkspaceFile('session-1', {
      path: '新建/-review.txt',
      expectedContent: null,
      content: 'created\n',
    })

    expect(result).toMatchObject({ state: 'ok', content: 'created\n', size: 8 })
    const [url, init] = fetchMock.mock.calls[0]!
    expect(url).toBe('http://127.0.0.1:3456/api/sessions/session-1/workspace/file')
    expect(init).toMatchObject({
      method: 'PUT',
      body: JSON.stringify({
        path: '新建/-review.txt',
        expectedContent: null,
        content: 'created\n',
      }),
    })
  })

  it('forwards independent comparison encodings and encoded raw-CAS writes', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch')
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({
      state: 'ok',
      path: '-中文.txt',
      diff: '',
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }))
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({
      state: 'ok',
      path: '-中文.txt',
      content: '修改\r\n',
      size: 6,
      contentFingerprint: 'sha256:new',
      actualEncoding: 'gbk',
      bom: 'none',
      lineEnding: 'crlf',
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }))

    await sessionsApi.getWorkspaceDiff('session-1', '-中文.txt', 'auto', {
      left: 'gbk',
      right: 'utf8',
    })
    const result = await sessionsApi.writeWorkspaceFile('session-1', {
      path: '-中文.txt',
      expectedContent: '原\r\n',
      expectedFingerprint: 'sha256:old',
      content: '修改\n',
      encoding: 'gbk',
      bom: 'none',
      lineEnding: 'crlf',
    })

    expect(result).toMatchObject({
      state: 'ok',
      contentFingerprint: 'sha256:new',
      actualEncoding: 'gbk',
    })
    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      'http://127.0.0.1:3456/api/sessions/session-1/workspace/diff?path=-%E4%B8%AD%E6%96%87.txt&leftEncoding=gbk&rightEncoding=utf8',
    )
    expect(fetchMock.mock.calls[1]?.[1]).toMatchObject({
      method: 'PUT',
      body: JSON.stringify({
        path: '-中文.txt',
        expectedContent: '原\r\n',
        expectedFingerprint: 'sha256:old',
        content: '修改\n',
        encoding: 'gbk',
        bom: 'none',
        lineEnding: 'crlf',
      }),
    })
  })

  it('preserves optional local index progress from session list responses', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch')
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({
      sessions: [],
      total: 0,
      index: {
        mode: 'on',
        state: 'building',
        discovered: 12,
        indexed: 4,
        degradedSources: 0,
        databaseBytes: 4096,
        walBytes: 0,
        lastUpdatedAt: '2026-07-15T00:00:00.000Z',
        lastErrorCode: null,
      },
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }))

    const result = await sessionsApi.list()

    expect(result.index).toMatchObject({
      mode: 'on',
      state: 'building',
      discovered: 12,
      indexed: 4,
    })
  })
})
