import { describe, expect, it } from 'bun:test'
import { handleWorkspaceFileReferenceRoute } from './workspaceFileReference.js'
import type { WorkspaceService } from '../services/workspaceService.js'

describe('file reference HTTP budget and input boundary', () => {
  it('rejects malformed and oversized bodies before calling the service', async () => {
    let calls = 0
    const service = { resolveFileReference: async () => { calls++; throw new Error('not called') } } as Pick<WorkspaceService, 'resolveFileReference'>
    for (const body of ['{', 'null', '[]', 'x'.repeat(65537)]) {
      const response = await handleWorkspaceFileReferenceRoute(new Request('http://localhost/resolve', { method: 'POST', body }), 's', service)
      expect((await response.json()).state).toBe('invalid')
    }
    expect(calls).toBe(0)
  })
  it('counts request-body time in the same budget and never sends expired work to the service', async () => {
    let calls = 0
    const service = { resolveFileReference: async () => { calls++; throw new Error('not called') } } as Pick<WorkspaceService, 'resolveFileReference'>
    const body = new ReadableStream({ start(controller) {
      setTimeout(() => { controller.enqueue(new TextEncoder().encode('{"reference":"a.md","timeoutMs":1}')); controller.close() }, 20)
    } })
    const response = await handleWorkspaceFileReferenceRoute(new Request('http://localhost/resolve', { method: 'POST', body }), 's', service)
    expect((await response.json()).state).toBe('incomplete'); expect(calls).toBe(0)
  })
})
