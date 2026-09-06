import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SessionListItem } from '../types/session'
import { useSessionRuntimeStore } from './sessionRuntimeStore'

const EXPECTED_GROK_SELECTION = {
  providerId: 'grok-official',
  modelId: 'grok-4.5',
  effortLevel: 'high',
}

describe('sessionRuntimeStore runtime cleanup', () => {
  beforeEach(() => {
    localStorage.clear()
    useSessionRuntimeStore.setState({ selections: {}, revision: 0, selectionRevisions: {}, pendingKeys: {} })
  })

  it('discards retired Grok selections before persisting them', () => {
    useSessionRuntimeStore.getState().setSelection('session-grok', {
      providerId: 'grok-official',
      modelId: 'grok-build',
      effortLevel: 'max',
    })

    expect(useSessionRuntimeStore.getState().selections['session-grok']).toEqual(
      EXPECTED_GROK_SELECTION,
    )
    expect(JSON.parse(localStorage.getItem('cc-haha-session-runtime')!)).toEqual({
      'session-grok': EXPECTED_GROK_SELECTION,
    })
  })

  it('does not let retired Grok session metadata restore the removed model', () => {
    useSessionRuntimeStore.getState().syncFromSessions([{
      id: 'session-restored-grok',
      runtimeProviderId: 'grok-official',
      runtimeModelId: 'grok-build',
      effortLevel: 'max',
    } as SessionListItem])

    expect(useSessionRuntimeStore.getState().selections['session-restored-grok']).toEqual(
      EXPECTED_GROK_SELECTION,
    )
  })

  it('cleans a retired Grok selection loaded from localStorage', async () => {
    localStorage.setItem('cc-haha-session-runtime', JSON.stringify({
      'session-loaded-grok': {
        providerId: 'grok-official',
        modelId: 'grok-build',
        effortLevel: 'max',
      },
    }))
    vi.resetModules()

    const { useSessionRuntimeStore: loadedStore } = await import('./sessionRuntimeStore')

    expect(loadedStore.getState().selections['session-loaded-grok']).toEqual(
      EXPECTED_GROK_SELECTION,
    )
    expect(JSON.parse(localStorage.getItem('cc-haha-session-runtime')!)).toEqual({
      'session-loaded-grok': EXPECTED_GROK_SELECTION,
    })
  })

  it('preserves a custom-provider xhigh selection loaded from localStorage', async () => {
    localStorage.setItem('cc-haha-session-runtime', JSON.stringify({
      'session-loaded-kimi': {
        providerId: 'kimi-provider',
        modelId: 'k3',
        effortLevel: 'xhigh',
      },
    }))
    vi.resetModules()

    const { useSessionRuntimeStore: loadedStore } = await import('./sessionRuntimeStore')

    const expectedSelection = {
      providerId: 'kimi-provider',
      modelId: 'k3',
      effortLevel: 'xhigh',
    }
    expect(loadedStore.getState().selections['session-loaded-kimi']).toEqual(
      expectedSelection,
    )
    expect(JSON.parse(localStorage.getItem('cc-haha-session-runtime')!)).toEqual({
      'session-loaded-kimi': expectedSelection,
    })
  })
})


describe('session list and runtime switch ordering', () => {
  it('ignores pending and older responses but accepts a fresh list after confirmation', () => {
    useSessionRuntimeStore.setState({ selections: {}, revision: 0, selectionRevisions: {}, pendingKeys: {} })
    const store = useSessionRuntimeStore.getState()
    const list = [{ id: 's', runtimeProviderId: 'a', runtimeModelId: 'shared' } as SessionListItem]
    store.syncFromSessions(list, 0)
    const before = useSessionRuntimeStore.getState().revision
    store.setSelection('s', { providerId: 'b', modelId: 'shared' })
    store.setPending('s', true)
    store.syncFromSessions(list, useSessionRuntimeStore.getState().revision)
    expect(useSessionRuntimeStore.getState().selections.s?.providerId).toBe('b')
    store.setSelection('s', { providerId: 'b', modelId: 'shared' })
    store.setPending('s', false)
    store.syncFromSessions(list, before)
    expect(useSessionRuntimeStore.getState().selections.s?.providerId).toBe('b')
    store.syncFromSessions(list, useSessionRuntimeStore.getState().revision)
    expect(useSessionRuntimeStore.getState().selections.s?.providerId).toBe('a')
    store.moveSelection('s', 'new')
    expect(useSessionRuntimeStore.getState().selectionRevisions.s).toBeGreaterThan(0)
    store.clearSelection('new')
    expect(useSessionRuntimeStore.getState().pendingKeys.new).toBeUndefined()
    expect(useSessionRuntimeStore.getState().selectionRevisions.new).toBeGreaterThan(0)
    store.syncFromSessions([{ ...list[0], id: 'new' } as SessionListItem], 0)
    expect(useSessionRuntimeStore.getState().selections.new).toBeUndefined()
  })
})
