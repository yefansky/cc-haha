import { afterEach, describe, expect, it, vi } from 'vitest'
import { AssistantFileResolutionCoordinator, type FileResolutionContext, type FileResolutionResult, type FileResolutionTransport } from './assistantFileResolution'
import { AssistantFileEvidenceIndex } from './assistantFileEvidence'

const context: FileResolutionContext = { server: 'http://local', sessionId: 's', workDir: 'G:/repo', permissionGeneration: 1, evidenceRevision: '1' }
const scope = { workDir: 'G:/repo', permissionGeneration: 1 }
const ok = (path = 'G:/repo/docs/a.md'): FileResolutionResult => ({ state: 'resolved', path, complete: true, scope })
const deferred = () => { let resolve!: (value: FileResolutionResult) => void; const promise = new Promise<FileResolutionResult>((r) => { resolve = r }); return { promise, resolve } }
const flush = async () => { for (let n = 0; n < 10; n++) await Promise.resolve() }
afterEach(() => vi.useRealTimers())

describe('bounded reference coordination', () => {
  it('keeps a historical cache hit after future same-name evidence is appended', async () => {
    const index = new AssistantFileEvidenceIndex()
    const first = { id: 'old', revision: '1', files: ['G:/repo/docs/a.md'] }
    index.update([first])
    const transport = vi.fn<FileResolutionTransport>(async () => ok())
    const core = new AssistantFileResolutionCoordinator(transport)
    await core.resolve({ reference: 'a.md' }, { ...context, evidenceRevision: index.revisionFor('old')! })
    index.update([first, { id: 'future', revision: '1', files: ['G:/repo/other/a.md'] }])
    await core.resolve({ reference: 'a.md' }, { ...context, evidenceRevision: index.revisionFor('old')! })
    expect(transport).toHaveBeenCalledTimes(1)
    expect(index.lookup('a.md', index.cutoff('old')!, true).candidates).toEqual(['G:/repo/docs/a.md'])
  })

  it('rejects over-budget hints without dropping ambiguity or starting I/O', async () => {
    const transport = vi.fn<FileResolutionTransport>(async () => ok())
    const core = new AssistantFileResolutionCoordinator(transport)
    expect((await core.resolve({ reference: 'a.md', candidates: Array(9).fill('a.md') }, context)).state).toBe('incomplete')
    expect((await core.resolve({ reference: 'a.md', contextDirectories: Array(4).fill('docs') }, context)).state).toBe('incomplete')
    expect(transport).not.toHaveBeenCalled()
  })

  it('bounds the pending queue to 16 in addition to two active requests', async () => {
    const held = deferred()
    const transport = vi.fn<FileResolutionTransport>(() => held.promise)
    const core = new AssistantFileResolutionCoordinator(transport)
    const waits = Array.from({ length: 18 }, (_, n) => core.resolve({ reference: `${n}.md` }, context))
    expect((await core.resolve({ reference: 'overflow.md' }, context)).state).toBe('incomplete')
    expect(core.metrics.pending).toBe(18)
    expect(core.metrics.queued).toBe(16)
    core.invalidate(); await Promise.all(waits)
    held.resolve(ok()); await flush()
  })

  it('rejects a logically expired result even before the timeout callback runs', async () => {
    let now = 0
    const held = deferred()
    const core = new AssistantFileResolutionCoordinator(() => held.promise, () => now)
    const wait = core.resolve({ reference: 'a.md' }, context)
    await flush(); now = 501; held.resolve(ok())
    expect((await wait).state).toBe('incomplete')
    expect(core.metrics.cached).toBe(0)
  })

  it('never caches unknown scopes or treats pathless resolved responses as success', async () => {
    for (const result of [{ ...ok(), scope: null }, { ...ok(), scope: undefined }, { ...ok(), path: undefined }, { state: 'missing' as const, complete: true, scope: null }]) {
      const core = new AssistantFileResolutionCoordinator(async () => result)
      const response = await core.resolve({ reference: 'a.md' }, context)
      if (result.state === 'resolved') expect(response.state).toBe('incomplete')
      expect(core.metrics.cached).toBe(0)
    }
  })

  it('singleflights two callers and cancelling one cannot abort the other', async () => {
    const result = deferred()
    const transport = vi.fn<FileResolutionTransport>(() => result.promise)
    const core = new AssistantFileResolutionCoordinator(transport)
    const first = new AbortController()
    const a = core.resolve({ reference: 'a.md' }, context, first.signal).catch((e) => e)
    const b = core.resolve({ reference: 'a.md' }, context)
    await flush()
    first.abort()
    expect((await a).name).toBe('AbortError')
    expect(transport.mock.calls[0]![2].aborted).toBe(false)
    result.resolve(ok())
    expect(await b).toEqual(ok())
    expect(transport).toHaveBeenCalledTimes(1)
  })

  it('aborts when all subscribers cancel and never caches their late response', async () => {
    const result = deferred()
    const transport = vi.fn<FileResolutionTransport>(() => result.promise)
    const core = new AssistantFileResolutionCoordinator(transport)
    const controller = new AbortController()
    const wait = core.resolve({ reference: 'a.md' }, context, controller.signal).catch((e) => e)
    await flush(); controller.abort(); await wait
    expect(transport.mock.calls[0]![2].aborted).toBe(true)
    result.resolve(ok()); await flush()
    expect(core.metrics.cached).toBe(0)
  })

  it('invalidates in-flight identity so late results cannot overwrite a reopened request', async () => {
    const old = deferred(); const next = deferred()
    const transport = vi.fn<FileResolutionTransport>().mockReturnValueOnce(old.promise).mockReturnValueOnce(next.promise)
    const core = new AssistantFileResolutionCoordinator(transport)
    const a = core.resolve({ reference: 'a.md' }, context)
    await flush(); core.invalidate(context)
    expect((await a).state).toBe('incomplete')
    const b = core.resolve({ reference: 'a.md' }, context)
    await flush(); old.resolve(ok('G:/repo/old/a.md')); await flush()
    expect(core.metrics.cached).toBe(0)
    next.resolve(ok()); expect(await b).toEqual(ok())
  })

  it('includes queue time in the 500ms deadline and never exceeds two live transports', async () => {
    vi.useFakeTimers()
    const tasks = [deferred(), deferred(), deferred()]
    let n = 0
    const transport = vi.fn<FileResolutionTransport>(() => tasks[n++]!.promise)
    const core = new AssistantFileResolutionCoordinator(transport)
    const first = core.resolve({ reference: '1.md' }, context)
    const second = core.resolve({ reference: '2.md' }, context)
    const third = core.resolve({ reference: '3.md' }, context)
    await flush()
    expect(transport).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(300)
    tasks[0]!.resolve(ok()); await flush()
    expect(transport.mock.calls[2]![0].timeoutMs).toBe(200)
    await vi.advanceTimersByTimeAsync(200)
    expect((await first).state).toBe('resolved')
    expect((await second).state).toBe('incomplete')
    expect((await third).state).toBe('incomplete')
    expect(core.metrics.active).toBe(2)
    tasks[1]!.resolve(ok()); tasks[2]!.resolve(ok()); await flush()
    expect(core.metrics.cached).toBe(1)
  })

  it('uses 30s positive, 2s missing TTL and a 128-entry LRU', async () => {
    let now = 0
    const transport = vi.fn<FileResolutionTransport>(async (request) => request.reference === 'missing.md' ? { state: 'missing', complete: true, scope } : ok())
    const core = new AssistantFileResolutionCoordinator(transport, () => now)
    await core.resolve({ reference: 'a.md' }, context)
    now = 29_999; await core.resolve({ reference: 'a.md' }, context)
    expect(transport).toHaveBeenCalledTimes(1)
    now = 30_001; await core.resolve({ reference: 'a.md' }, context)
    await core.resolve({ reference: 'missing.md' }, context)
    now += 1999; await core.resolve({ reference: 'missing.md' }, context)
    expect(transport).toHaveBeenCalledTimes(3)
    now += 2; await core.resolve({ reference: 'missing.md' }, context)
    expect(transport).toHaveBeenCalledTimes(4)
    for (let n = 0; n < 130; n++) await core.resolve({ reference: `${n}.md` }, context)
    expect(core.metrics.cached).toBe(128)
    const count = transport.mock.calls.length
    await core.resolve({ reference: '0.md' }, context)
    expect(transport).toHaveBeenCalledTimes(count + 1)
  })

  it('separates evidence, permission, workspace, server and session generations', async () => {
    const transport = vi.fn<FileResolutionTransport>(async () => ok())
    const core = new AssistantFileResolutionCoordinator(transport)
    await core.resolve({ reference: 'a.md' }, context)
    for (const change of [{ evidenceRevision: '2' }, { permissionGeneration: 2 }, { workDir: 'G:/other' }, { server: 'http://other' }, { sessionId: 'other' }]) await core.resolve({ reference: 'a.md' }, { ...context, ...change })
    expect(transport).toHaveBeenCalledTimes(6)
  })

  it('does not cache incomplete or silently replace a complete absolute path', async () => {
    const transport = vi.fn<FileResolutionTransport>(async () => ok('G:/repo/other.md'))
    const core = new AssistantFileResolutionCoordinator(transport)
    expect((await core.resolve({ reference: 'G:/repo/a.md' }, context)).state).toBe('incomplete')
    expect(core.metrics.cached).toBe(0)
    const unfinished = new AssistantFileResolutionCoordinator(async () => ({ ...ok(), complete: false }))
    expect((await unfinished.resolve({ reference: 'a.md' }, context)).state).toBe('incomplete')
    expect(unfinished.metrics.cached).toBe(0)
  })
})
