import { expect, test } from 'bun:test'
import { FileReferenceGate, resolveWorkspaceFileReference, type FileReferenceDependencies, type PreparedFileReferenceScope } from './workspaceFileReferenceResolver'
const scope: PreparedFileReferenceScope = { workDir: '/w', permissionGeneration: '1', pathStyle: 'posix' }
function deps(overrides: Partial<FileReferenceDependencies> = {}): FileReferenceDependencies {
  return { gate: new FileReferenceGate(), prepareScope: async () => scope, probeFile: async () => ({ state: 'missing' }), listDirectory: async () => ({ state: 'ok', complete: true, entries: [] }), ...overrides }
}
test('R05 one found candidate cannot be unique when additional compatible candidates exceed exact budget', async () => {
  const result = await resolveWorkspaceFileReference({ reference: 'x.md', candidates: Array.from({ length: 9 }, (_, i) => `/w/${i}/x.md`) }, deps({ probeFile: async path => path === '/w/0/x.md' ? { state: 'found', path, canonicalPath: path } : { state: 'missing' } }))
  expect(result.state).toBe('incomplete'); expect(result.complete).toBe(false)
  expect(result.candidates).toHaveLength(1); expect(result.stats.exactProbes).toBeLessThanOrEqual(8)
})
test('R05 one discovered file cannot be unique when directory listing was truncated', async () => {
  const result = await resolveWorkspaceFileReference({ reference: 'x.md' }, deps({
    listDirectory: async path => path === '/w' ? { state: 'ok', complete: true, entries: [{ name: 'a', kind: 'directory' }] } : { state: 'ok', complete: false, entries: [{ name: 'x.md', kind: 'file' }] },
    probeFile: async path => path === '/w/a/x.md' ? { state: 'found', path, canonicalPath: path } : { state: 'missing' },
  }))
  expect(result.state).toBe('incomplete'); expect(result.complete).toBe(false)
  expect(result.candidates?.[0]?.path).toBe('/w/a/x.md')
})
test('R16 expired requests retain shared slots until ignored-abort metadata calls settle', async () => {
  const gate = new FileReferenceGate()
  const release: Array<(value: PreparedFileReferenceScope) => void> = []
  let started = 0
  const backend = deps({ gate, prepareScope: () => { started++; return new Promise(resolve => release.push(resolve)) } })
  const first = [resolveWorkspaceFileReference({ reference: 'a', timeoutMs: 15 }, backend), resolveWorkspaceFileReference({ reference: 'b', timeoutMs: 15 }, backend)]
  expect((await Promise.all(first)).every(r => r.state === 'incomplete')).toBe(true)
  expect(started).toBe(2)
  const later = Array.from({ length: 30 }, (_, i) => resolveWorkspaceFileReference({ reference: String(i), timeoutMs: 15 }, backend))
  expect((await Promise.all(later)).every(r => r.state === 'incomplete')).toBe(true)
  expect(started).toBe(2)
  for (const done of release) done(scope)
  for (let i = 0; i < 10; i++) await Promise.resolve()
  const next = await resolveWorkspaceFileReference({ reference: '/w/missing.md' }, deps({ gate }))
  expect(next.state).toBe('missing'); expect(next.complete).toBe(true)
})
test('R05 deeper unsearched branch prevents one shallow match from being declared unique', async () => {
  const result = await resolveWorkspaceFileReference({ reference: 'x.md' }, deps({
    listDirectory: async path => ({ state: 'ok', complete: true, entries: path === '/w/a' ? [{ name: 'x.md', kind: 'file' }, { name: 'b', kind: 'directory' }] : [{ name: path === '/w' ? 'a' : 'deeper', kind: 'directory' }] }),
    probeFile: async path => path === '/w/a/x.md' ? { state: 'found', path, canonicalPath: path } : { state: 'missing' },
  }))
  expect(result.state).toBe('incomplete'); expect(result.complete).toBe(false)
  expect(result.candidates).toHaveLength(1); expect(result.stats.directories).toBeLessThanOrEqual(12)
})
