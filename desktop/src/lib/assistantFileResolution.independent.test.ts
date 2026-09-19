import { afterEach, expect, it, vi } from 'vitest'
import { AssistantFileResolutionCoordinator, type FileResolutionContext, type FileResolutionResult } from './assistantFileResolution'
import { AssistantFileEvidenceIndex } from './assistantFileEvidence'
const context: FileResolutionContext = { server: 'test', sessionId: 's', workDir: '/w', permissionGeneration: 1, evidenceRevision: '1' }
const found = (path: string): FileResolutionResult => ({ state: 'resolved', complete: true, path, scope: { workDir: '/w', permissionGeneration: 1 } })
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(r => { resolve = r }); return { promise, resolve } }
const tick = async () => { for (let n = 0; n < 10; n++) await Promise.resolve() }
afterEach(() => vi.useRealTimers())
it('R14 invalidated late response cannot overwrite a newer same-key result or repopulate its cache', async () => {
  vi.useFakeTimers()
  const old = deferred<FileResolutionResult>(), fresh = deferred<FileResolutionResult>()
  let calls = 0
  const c = new AssistantFileResolutionCoordinator(() => (++calls === 1 ? old.promise : fresh.promise))
  const first = c.resolve({ reference: 'x.md' }, context)
  await tick(); c.invalidate(context)
  expect((await first).state).toBe('incomplete')
  const second = c.resolve({ reference: 'x.md' }, context)
  await tick(); fresh.resolve(found('/w/new/x.md'))
  expect((await second).path).toBe('/w/new/x.md')
  old.resolve(found('/w/old/x.md')); await tick()
  expect((await c.resolve({ reference: 'x.md' }, context)).path).toBe('/w/new/x.md')
  expect(c.metrics.pending).toBe(0)
  expect(calls).toBe(2)
})
it('R15 one cancelled subscriber does not cancel its shared transport or surviving subscriber', async () => {
  const work = deferred<FileResolutionResult>()
  let observed: AbortSignal | undefined, calls = 0
  const c = new AssistantFileResolutionCoordinator((_r, _c, signal) => { calls++; observed = signal; return work.promise })
  const abort = new AbortController()
  const first = c.resolve({ reference: 'x.md' }, context, abort.signal).catch(e => e)
  const second = c.resolve({ reference: 'x.md' }, context)
  await tick(); abort.abort()
  expect((await first).name).toBe('AbortError')
  expect(observed?.aborted).toBe(false)
  work.resolve(found('/w/x.md'))
  expect((await second).state).toBe('resolved')
  expect(calls).toBe(1)
})
it('R16 timeout does not release capacity while an abort-ignoring transport still runs', async () => {
  vi.useFakeTimers()
  const jobs = [deferred<FileResolutionResult>(), deferred<FileResolutionResult>()]
  let calls = 0
  const c = new AssistantFileResolutionCoordinator(() => jobs[calls++]!.promise)
  const first = c.resolve({ reference: 'one.md', timeoutMs: 20 }, context)
  const second = c.resolve({ reference: 'two.md', timeoutMs: 20 }, context)
  await tick(); await vi.advanceTimersByTimeAsync(21)
  expect((await first).state).toBe('incomplete'); expect((await second).state).toBe('incomplete')
  const later = Array.from({ length: 40 }, (_, i) => c.resolve({ reference: `later-${i}.md`, timeoutMs: 20 }, context))
  await tick(); expect(c.metrics.active).toBe(2); expect(c.metrics.queued).toBeLessThanOrEqual(16)
  await vi.advanceTimersByTimeAsync(21)
  expect((await Promise.all(later)).every(r => r.state === 'incomplete')).toBe(true)
  expect(calls).toBe(2)
  jobs[0]!.resolve(found('/w/one.md')); jobs[1]!.resolve(found('/w/two.md')); await tick()
  expect(c.metrics).toEqual({ active: 0, pending: 0, queued: 0, cached: 0 })
})
it('R14 deleted/reordered evidence cannot survive in earlier message cutoffs', () => {
  const index = new AssistantFileEvidenceIndex()
  index.update([{ id: 'read', revision: '1', files: ['/w/a/x.md'] }, { id: 'reply', revision: '1', files: [] }, { id: 'later', revision: '1', files: ['/w/b/x.md'] }])
  expect(index.lookup('x.md', index.cutoff('reply')!, false).candidates).toEqual(['/w/a/x.md'])
  index.update([{ id: 'reply', revision: '2', files: [] }, { id: 'later', revision: '1', files: ['/w/b/x.md'] }])
  expect(index.lookup('x.md', index.cutoff('reply')!, false).state).toBe('unresolved')
  expect(index.lookup('x.md', index.cutoff('later')!, false).candidates).toEqual(['/w/b/x.md'])
})
it('R15 cancelling the final subscriber aborts its transport and late success cannot cache', async () => {
  const work = deferred<FileResolutionResult>()
  let observed: AbortSignal | undefined
  const c = new AssistantFileResolutionCoordinator((_r, _c, signal) => { observed = signal; return work.promise })
  const a = new AbortController(), b = new AbortController()
  const first = c.resolve({ reference: 'x.md' }, context, a.signal).catch(e => e)
  const second = c.resolve({ reference: 'x.md' }, context, b.signal).catch(e => e)
  await tick(); a.abort(); b.abort()
  expect((await first).name).toBe('AbortError'); expect((await second).name).toBe('AbortError')
  expect(observed?.aborted).toBe(true)
  expect(c.metrics.active).toBe(1)
  work.resolve(found('/w/x.md')); await tick()
  expect(c.metrics).toEqual({ active: 0, pending: 0, queued: 0, cached: 0 })
})
