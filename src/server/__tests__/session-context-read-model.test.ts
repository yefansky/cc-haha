import { describe, expect, it, spyOn } from 'bun:test'
import { handleSessionsApi } from '../api/sessions.js'
import { conversationService } from '../services/conversationService.js'
import { SessionContextReadModel } from '../services/sessionContextReadModel.js'
import { sessionService } from '../services/sessionService.js'

type Context = { model: string; totalTokens: number }

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => { resolve = done })
  return { promise, resolve }
}

const estimate: Context = { model: 'transcript', totalTokens: 120 }
const never = <T>() => new Promise<T>(() => {})
const makeModel = (options: ConstructorParameters<typeof SessionContextReadModel>[0] = {}) =>
  new SessionContextReadModel({ shortBudgetMs: 5, hardTimeoutMs: 100, ...options })

describe('SessionContextReadModel', () => {
  it('returns fast live context without reading the transcript', async () => {
    const model = makeModel({ shortBudgetMs: 20 })
    let transcriptReads = 0
    const result = await model.read<Context>({
      sessionId: 'fast-live',
      identity: {},
      readLive: async () => ({ model: 'live', totalTokens: 140 }),
      readTranscript: async () => { transcriptReads += 1; return estimate },
    })
    expect(result.context).toEqual({ model: 'live', totalTokens: 140 })
    expect(transcriptReads).toBe(0)
  })

  it('returns live when it settles after the budget but before the transcript', async () => {
    const model = makeModel()
    const result = await model.read<Context>({
      sessionId: 'live-beats-transcript',
      identity: {},
      readLive: async () => { await Bun.sleep(15); return { model: 'live', totalTokens: 140 } },
      readTranscript: async () => { await Bun.sleep(40); return estimate },
    })
    expect(result.context).toEqual({ model: 'live', totalTokens: 140 })
    expect(result.contextEstimate).toBeUndefined()
  })

  it('returns stale live after the budget without scanning the transcript', async () => {
    const model = makeModel({ freshForMs: 0 })
    const identity = {}
    await model.read<Context>({
      sessionId: 'stale-live', identity,
      readLive: async () => ({ model: 'cached-live', totalTokens: 130 }),
      readTranscript: async () => estimate,
    })
    await Bun.sleep(2)
    let transcriptReads = 0
    const result = await model.read<Context>({
      sessionId: 'stale-live', identity,
      readLive: async () => await never<Context>(),
      readTranscript: async () => { transcriptReads += 1; return estimate },
    })
    expect(result.context).toEqual({ model: 'cached-live', totalTokens: 130 })
    expect(result.contextStatus).toMatchObject({ freshness: 'stale', refreshing: true })
    expect(transcriptReads).toBe(0)
  })

  it('returns a transcript estimate quickly while a live control never settles', async () => {
    const model = makeModel({ shortBudgetMs: 10, hardTimeoutMs: 40 })
    const startedAt = performance.now()
    const result = await model.read<Context>({
      sessionId: 'slow-live',
      identity: {},
      readTranscript: async () => estimate,
      readLive: async () => await never<Context>(),
    })
    expect(performance.now() - startedAt).toBeLessThan(100)
    expect(result).toMatchObject({
      contextEstimate: estimate,
      contextStatus: { source: 'transcript', freshness: 'estimated', refreshing: true },
    })
  })

  it('reads the transcript after a fast live failure', async () => {
    const model = makeModel({ shortBudgetMs: 20 })
    const result = await model.read<Context>({
      sessionId: 'failed-live', identity: {},
      readLive: async () => { throw new Error('live unavailable') },
      readTranscript: async () => estimate,
    })
    expect(result.contextEstimate).toEqual(estimate)
    expect(result.contextStatus.refreshing).toBe(false)
    expect(result.error).toBe('live unavailable')
  })

  it('returns typed pending when transcript is empty or never settles', async () => {
    for (const readTranscript of [
      async () => null,
      async () => await never<Context | null>(),
    ]) {
      const model = makeModel()
      const startedAt = performance.now()
      const result = await model.read<Context>({
        sessionId: crypto.randomUUID(), identity: {}, readTranscript,
        readLive: async () => await never<Context>(),
      })
      expect(performance.now() - startedAt).toBeLessThan(100)
      expect(result.contextStatus).toEqual({ source: 'none', freshness: 'pending', refreshing: true })
    }
  })

  it('single-flights transcript fallback for concurrent reads', async () => {
    const model = makeModel()
    let transcriptReads = 0
    const input = {
      sessionId: 'transcript-single-flight', identity: {},
      readLive: async () => await never<Context>(),
      readTranscript: async () => { transcriptReads += 1; return await never<Context | null>() },
    }
    const results = await Promise.all(Array.from({ length: 10 }, () => model.read(input)))
    expect(transcriptReads).toBe(1)
    expect(results.every(result => result.contextStatus.freshness === 'pending')).toBe(true)
  })

  it('bounds session state and aborts the oldest live refresh on eviction', async () => {
    const model = makeModel({ shortBudgetMs: 2, maxStates: 2 })
    const signals: AbortSignal[] = []
    for (const sessionId of ['lru-1', 'lru-2', 'lru-3']) {
      await model.read<Context>({
        sessionId, identity: {}, readTranscript: async () => null,
        readLive: async signal => {
          signals.push(signal)
          return await never<Context>()
        },
      })
    }
    expect(model.getStateCountForTests()).toBe(2)
    expect(signals[0]?.aborted).toBe(true)
    expect(signals[1]?.aborted).toBe(false)
  })

  it('starts one live control for ten concurrent reads of the same identity', async () => {
    const model = makeModel()
    const live = deferred<Context>()
    let liveCalls = 0
    const input = {
      sessionId: 'single-flight',
      identity: {},
      readTranscript: async () => estimate,
      readLive: async () => {
        liveCalls += 1
        return await live.promise
      },
    }
    const results = await Promise.all(Array.from({ length: 10 }, () => model.read(input)))
    expect(liveCalls).toBe(1)
    expect(results.every(result => result.contextEstimate === estimate)).toBe(true)
    live.resolve({ model: 'live', totalTokens: 140 })
  })

  it('clears single-flight state after the hard live timeout', async () => {
    const model = makeModel({ hardTimeoutMs: 25 })
    let liveCalls = 0
    const input = {
      sessionId: 'timeout-cleanup',
      identity: {},
      readTranscript: async () => estimate,
      readLive: async () => {
        liveCalls += 1
        return await never<Context>()
      },
    }

    await model.read(input)
    await Bun.sleep(40)
    const second = await model.read(input)
    expect(liveCalls).toBe(2)
    expect(second.contextStatus.refreshing).toBe(true)
  })

  it('does not let an old identity overwrite a newer live result', async () => {
    const model = makeModel({ freshForMs: 1_000 })
    const oldLive = deferred<Context>()
    const oldIdentity = {}
    let identity = oldIdentity
    let liveCalls = 0
    const read = () => model.read({
      sessionId: 'identity-change', identity,
      readTranscript: async () => estimate,
      readLive: async () => {
        liveCalls += 1
        return identity === oldIdentity
          ? await oldLive.promise
          : { model: 'new-live', totalTokens: 160 }
      },
    })
    await read()
    identity = {}
    const newer = await read()
    oldLive.resolve({ model: 'old-live', totalTokens: 999 })
    await Promise.resolve()
    const cached = await read()
    expect(newer.context).toEqual({ model: 'new-live', totalTokens: 160 })
    expect(cached.context).toEqual(newer.context)
    expect(liveCalls).toBe(2)
  })

  it('wires active context-only inspection to the fast transcript fallback', async () => {
    const sessionId = `context-read-api-${crypto.randomUUID()}`
    const oldLive = deferred<Context>()
    let identity: object = { type: 'system', subtype: 'init', session_id: 'old' }
    let liveCalls = 0
    const snapshotSpy = spyOn(sessionService, 'getInspectionTranscriptSnapshot').mockResolvedValue({
      launchInfo: { workDir: process.cwd() },
      metadata: { model: 'transcript' }, usage: null, contextEstimate: estimate,
    } as never)
    const spies = [
      spyOn(conversationService, 'hasSession').mockReturnValue(true),
      spyOn(conversationService, 'getSessionWorkDir').mockReturnValue(process.cwd()),
      spyOn(conversationService, 'getSessionPermissionMode').mockReturnValue('default'),
      spyOn(conversationService, 'getSessionInitMessage').mockImplementation(() => identity),
      spyOn(conversationService, 'requestControl').mockImplementation(async () => {
        liveCalls += 1
        if ((identity as { session_id: string }).session_id === 'old') return await oldLive.promise
        return { model: 'new-live', totalTokens: 160 }
      }),
      snapshotSpy,
    ]

    try {
      const url = new URL(`http://localhost/api/sessions/${sessionId}/inspection?contextOnly=1`)
      const inspect = async () => await (await handleSessionsApi(
        new Request(url), url, ['api', 'sessions', sessionId, 'inspection'],
      )).json() as any
      const startedAt = performance.now()
      const body = await inspect()
      expect(performance.now() - startedAt).toBeLessThan(500)
      expect(body.contextEstimate).toEqual(estimate)
      expect(body.contextStatus).toEqual({ source: 'transcript', freshness: 'estimated', refreshing: true })

      identity = { type: 'system', subtype: 'init', session_id: 'new' }
      expect((await inspect()).context).toEqual({ model: 'new-live', totalTokens: 160 })
      expect(liveCalls).toBe(2)
      expect(snapshotSpy).toHaveBeenCalledTimes(1)
    } finally {
      oldLive.resolve({ model: 'old-live', totalTokens: 999 })
      for (const spy of spies) spy.mockRestore()
    }
  })
})
