import { expect, it, vi } from 'vitest'
import { AssistantFileEvidenceIndex } from './assistantFileEvidence'
import { AssistantFileNavigator, type FileNavigationContext } from './assistantFileNavigation'
import type { FileResolutionResult } from './assistantFileResolution'
const context: FileNavigationContext = { server: 'isolated-test', sessionId: 's', workDir: '/w', generation: '1' }
const success = (path: string): FileResolutionResult => ({ state: 'resolved', path, complete: true, scope: { workDir: '/w', permissionGeneration: '1' } })
it('cached location skips discovery but exact metadata must authorize every navigation', async () => {
  let discovery = 0, exact = 0, allowed = true, exists = true
  const navigator = new AssistantFileNavigator(async request => {
    if (request.reference === 'x.md') { discovery++; return success('/w/nested/x.md') }
    exact++
    return !allowed ? { state: 'denied', complete: false } : !exists ? { state: 'missing', complete: true } : success('/w/nested/x.md')
  })
  expect((await navigator.resolve('x.md', context)).href).toBe('/w/nested/x.md')
  expect((await navigator.resolve('x.md', context)).href).toBe('/w/nested/x.md')
  expect(discovery).toBe(1); expect(exact).toBe(1)
  allowed = false
  const denied = await navigator.resolve('x.md', context)
  expect(denied.state).toBe('denied'); expect(denied.href).toBeUndefined()
  allowed = true; exists = false
  const missing = await navigator.resolve('x.md', context)
  expect(missing.state).toBe('missing'); expect(missing.href).toBeUndefined()
  expect(discovery).toBe(1); expect(exact).toBe(3)
})
it('404 compatibility cannot navigate ambiguous or unverified short names', async () => {
  const navigator = new AssistantFileNavigator(async () => { throw Object.assign(new Error('old service'), { status: 404 }) })
  const result = await navigator.resolve('index.md', { ...context, referencedFiles: ['/w/a/index.md', '/w/b/index.md'] })
  expect(result.href).toBeUndefined(); expect(result.compatibility).not.toBe(true)
  expect((await navigator.resolve('missing.md', context)).href).toBeUndefined()
  const explicit = await navigator.resolve('/w/existing.md', context)
  expect(explicit.compatibility).toBe(true); expect(explicit.href).toBe('/w/existing.md')
})
it('workspace and evidence generations do not reuse old discovery results', async () => {
  let discovery = 0
  const navigator = new AssistantFileNavigator(async request => { if (request.reference === 'x.md') discovery++; return success('/w/nested/x.md') })
  await navigator.resolve('x.md', context)
  await navigator.resolve('x.md', { ...context, generation: '2' })
  await navigator.resolve('x.md', { ...context, referencedFiles: ['/w/new/x.md'] })
  await navigator.resolve('x.md', { ...context, workDir: '/other' })
  expect(discovery).toBe(4)
})
it('new backend permission generation discards both previous positive and negative location entries', async () => {
  let generation = 'old', scans = 0
  const navigator = new AssistantFileNavigator(async request => {
    const scope = { workDir: '/w', permissionGeneration: generation }
    if (request.reference === 'missing.md') return generation === 'old' ? { state: 'missing', complete: true, scope } : { ...success('/w/new/missing.md'), scope }
    if (request.reference === 'x.md') { scans++; return { ...success(`/w/${generation}/x.md`), scope } }
    if (generation === 'new') return { state: 'denied', complete: false, scope }
    return { ...success(request.reference), scope }
  })
  expect((await navigator.resolve('x.md', context)).href).toBe('/w/old/x.md')
  expect((await navigator.resolve('missing.md', context)).state).toBe('missing')
  generation = 'new'
  expect((await navigator.resolve('x.md', context)).state).toBe('denied')
  expect((await navigator.resolve('missing.md', context)).href).toBe('/w/new/missing.md')
  expect((await navigator.resolve('x.md', context)).href).toBe('/w/new/x.md')
  expect(scans).toBe(2)
})
it.each([250, 501])('CPU evidence work consumes the same total lookup deadline (%d ms)', async elapsed => {
  let now = 1000
  const clock = vi.spyOn(Date, 'now').mockImplementation(() => now)
  const index = new AssistantFileEvidenceIndex()
  const extraction = vi.spyOn(index, 'knownFiles').mockImplementation(() => { now += elapsed; return [] })
  const budgets: number[] = []
  const navigator = new AssistantFileNavigator(async request => { budgets.push(request.timeoutMs!); return success('/w/x.md') })
  try {
    const result = await navigator.resolve('x.md', { ...context, evidence: { index, cutoff: 0, revision: 'cpu' } })
    if (elapsed < 500) { expect(result.state).toBe('resolved'); expect(budgets).toEqual([500 - elapsed]) }
    else { expect(result.state).toBe('incomplete'); expect(budgets).toEqual([]) }
  } finally { extraction.mockRestore(); clock.mockRestore() }
})
