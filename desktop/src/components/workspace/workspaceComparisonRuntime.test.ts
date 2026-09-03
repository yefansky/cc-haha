import { afterEach, describe, expect, it, vi } from 'vitest'
import type { WorkspaceComparison } from '@/api/sessions'
import {
  computeWorkspaceComparisonModel,
  createWorkspaceComparisonRevisionGate,
  requestWorkspaceComparisonModel,
  resetWorkspaceComparisonRuntimeForTests,
} from './workspaceComparisonRuntime'
import { createDefaultWorkspaceComparisonSettings } from './workspaceComparisonSettings'

const comparison: WorkspaceComparison = {
  schemaVersion: 1,
  left: {
    source: { kind: 'git_head', path: 'a.cpp', revision: 'head' }, exists: true, state: 'ok', content: 'VALUE\n',
    requestedEncoding: 'auto', actualEncoding: 'utf8', bom: 'none', lineEnding: 'lf', writable: false,
  },
  right: {
    source: { kind: 'working_tree', path: 'a.cpp', revision: 'working' }, exists: true, state: 'ok', content: 'value\n',
    requestedEncoding: 'auto', actualEncoding: 'utf8', bom: 'none', lineEnding: 'lf', writable: true,
  },
}

describe('workspaceComparisonRuntime', () => {
  afterEach(() => {
    resetWorkspaceComparisonRuntimeForTests()
    vi.unstubAllGlobals()
  })
  it('computes the pure model from a serializable worker request', () => {
    const settings = createDefaultWorkspaceComparisonSettings('a.cpp')
    settings.ignoreCase = true
    const result = computeWorkspaceComparisonModel({
      id: 1, sessionRevision: 2, settingsRevision: 3, value: '', comparison, path: 'a.cpp', anchors: [], settings,
    })
    expect(result).toMatchObject({ id: 1, sessionRevision: 2, settingsRevision: 3, model: { files: [{ rows: [{ kind: 'context' }] }] } })
  })

  it('accepts only the latest submitted revision and discards stale completions', async () => {
    const accepted: number[] = []
    const gate = createWorkspaceComparisonRevisionGate<{ id: number }>((value) => accepted.push(value.id))
    let resolveFirst!: (value: { id: number }) => void
    let resolveSecond!: (value: { id: number }) => void
    const first = gate.submit(new Promise((resolve) => { resolveFirst = resolve }))
    const second = gate.submit(new Promise((resolve) => { resolveSecond = resolve }))
    resolveSecond({ id: 2 })
    resolveFirst({ id: 1 })
    await Promise.all([first, second])
    expect(accepted).toEqual([2])
  })

  it('reuses a completed alignment for the same source revisions, settings and content', async () => {
    const instances: FakeWorker[] = []
    class FakeWorker {
      onmessage: ((event: MessageEvent<unknown>) => void) | null = null
      onerror: ((event: ErrorEvent) => void) | null = null
      terminate = vi.fn()
      postMessage = vi.fn()
      constructor() { instances.push(this) }
    }
    vi.stubGlobal('Worker', FakeWorker)
    const cachedComparison: WorkspaceComparison = {
      ...comparison,
      left: { ...comparison.left, source: { ...comparison.left.source, revision: 'cache-head' } },
      right: { ...comparison.right, source: { ...comparison.right.source, revision: 'cache-working' } },
    }
    const settings = createDefaultWorkspaceComparisonSettings('cache.cpp')
    const input = {
      sessionRevision: 0,
      settingsRevision: 0,
      value: 'cache-value',
      comparison: cachedComparison,
      path: 'cache.cpp',
      anchors: [],
      settings,
    }

    const first = requestWorkspaceComparisonModel(input)
    instances[0]!.onmessage?.({
      data: computeWorkspaceComparisonModel({ ...input, id: 1 }),
    } as MessageEvent)
    await first
    const second = await requestWorkspaceComparisonModel(input)

    expect(instances).toHaveLength(1)
    expect(instances[0]!.postMessage).toHaveBeenCalledOnce()
    expect(second).toMatchObject({ sessionRevision: 0, settingsRevision: 0 })
  })

  it('does not reuse alignment when a source revision changes', async () => {
    const instances: FakeWorker[] = []
    class FakeWorker {
      onmessage: ((event: MessageEvent<unknown>) => void) | null = null
      onerror: ((event: ErrorEvent) => void) | null = null
      terminate = vi.fn()
      postMessage = vi.fn()
      constructor() { instances.push(this) }
    }
    vi.stubGlobal('Worker', FakeWorker)
    const settings = createDefaultWorkspaceComparisonSettings('revision.cpp')
    const baseInput = {
      sessionRevision: 0,
      settingsRevision: 0,
      value: 'revision-value',
      comparison,
      path: 'revision.cpp',
      anchors: [],
      settings,
    }

    const first = requestWorkspaceComparisonModel(baseInput)
    instances[0]!.onmessage?.({ data: computeWorkspaceComparisonModel({ ...baseInput, id: 1 }) } as MessageEvent)
    await first
    const changedInput = {
      ...baseInput,
      comparison: {
        ...comparison,
        right: { ...comparison.right, source: { ...comparison.right.source, revision: 'working-2' } },
      },
    }
    const second = requestWorkspaceComparisonModel(changedInput)

    expect(instances[0]!.postMessage).toHaveBeenCalledTimes(2)
    instances[0]!.onmessage?.({ data: computeWorkspaceComparisonModel({ ...changedInput, id: 2 }) } as MessageEvent)
    await second
  })

  it('terminates a failed worker and recreates it for the next request', async () => {
    const instances: FakeWorker[] = []
    class FakeWorker {
      onmessage: ((event: MessageEvent<unknown>) => void) | null = null
      onerror: ((event: ErrorEvent) => void) | null = null
      terminate = vi.fn()
      postMessage = vi.fn()
      constructor() { instances.push(this) }
    }
    vi.stubGlobal('Worker', FakeWorker)
    const settings = createDefaultWorkspaceComparisonSettings('a.cpp')
    const input = { sessionRevision: 1, settingsRevision: 1, value: '', comparison, path: 'a.cpp', anchors: [], settings }

    const first = requestWorkspaceComparisonModel(input)
    instances[0]!.onerror?.({ message: 'boom' } as ErrorEvent)
    await expect(first).rejects.toThrow('boom')
    expect(instances[0]!.terminate).toHaveBeenCalledOnce()

    const second = requestWorkspaceComparisonModel(input)
    expect(instances).toHaveLength(2)
    instances[1]!.onmessage?.({
      data: computeWorkspaceComparisonModel({ ...input, id: 2 }),
    } as MessageEvent)
    await expect(second).resolves.toMatchObject({ id: 2 })
    instances[1]!.onerror?.({ message: 'cleanup' } as ErrorEvent)
    expect(instances[1]!.terminate).toHaveBeenCalledOnce()
  })
})
