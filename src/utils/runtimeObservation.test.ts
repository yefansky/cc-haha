import { describe, expect, test } from 'bun:test'
import { RuntimeObservation } from './runtimeObservation.js'

describe('runtime observation', () => {
  test('tracks real waiting and completion transitions without changing the operation', () => {
    let now = 100
    const observer = new RuntimeObservation(() => now)
    const parent = observer.begin('session.turn', { sessionId: 'session-1' })
    const child = observer.begin('permission', { parentId: parent.id })
    now = 150
    child.phase('waiting', 'user-input')
    now = 300
    const snapshot = observer.snapshot()
    expect(snapshot.active[1]).toMatchObject({ state: 'waiting', waitingFor: 'user-input', durationMs: 200, phaseDurationMs: 150, parentId: parent.id })
    snapshot.active[1].state = 'corrupted'
    expect(observer.snapshot().active[1].state).toBe('waiting')
    child.phase('running')
    expect(observer.snapshot().active[1].waitingFor).toBeUndefined()
    child.end()
    child.end()
    parent.end('cancelled')
    expect(observer.snapshot().active).toHaveLength(0)
    expect(observer.snapshot().counters.completed).toBe(2)
  })

  test('bounds active operations and chronological event storage', () => {
    const observer = new RuntimeObservation()
    const handles = Array.from({ length: 300 }, () => observer.begin('work'))
    expect(observer.snapshot().active).toHaveLength(256)
    expect(observer.snapshot().counters.droppedActive).toBe(44)
    handles.forEach(handle => handle.end())
    const snapshot = observer.snapshot()
    expect(snapshot.active).toHaveLength(0)
    expect(snapshot.events).toHaveLength(256)
    expect(snapshot.events.every(event => event.type === 'end')).toBe(true)
    expect(snapshot.events.map(event => event.sequence)).toEqual(Array.from({ length: 256 }, (_, index) => 257 + index))
    expect(observer.begin('next').id).not.toBe('')
  })

  test('detailed stacks are opt-in, expire, and never claim to be current CPU stacks', () => {
    let now = 0
    const observer = new RuntimeObservation(() => now)
    observer.begin('basic')
    expect(observer.snapshot().active[0].startStack).toBeUndefined()
    observer.configure({ mode: 'detailed', durationMs: 1000 })
    observer.begin('detailed')
    expect(observer.snapshot().active[1].stackKind).toBe('operation-start-not-current-cpu-stack')
    expect(observer.snapshot().active[1].startStack).not.toMatch(/[\\/]/)
    now = 1001
    observer.begin('expired')
    expect(observer.snapshot().config.mode).toBe('basic')
    expect(observer.snapshot().active[2].startStack).toBeUndefined()
    observer.configure({ mode: 'detailed', durationMs: Infinity })
    expect(observer.snapshot().config.detailedUntil).toBe(now + 60_000)
    observer.configure({ mode: 'detailed', durationMs: 9_000_000 })
    expect(observer.snapshot().config.detailedUntil).toBe(now + 300_000)
  })

  test('only copies bounded metadata fields and rejects paths and prose', () => {
    const observer = new RuntimeObservation()
    const handle = observer.begin('Bearer secret', {
      sessionId: 'C:\\private\\secret',
      kind: 'tool',
      waitingFor: 'https://secret.example',
      ...{ prompt: 'private prompt', apiKey: 'secret' },
    })
    handle.phase('private user message', 'x'.repeat(1000))
    const serialized = JSON.stringify(observer.snapshot())
    expect(serialized).not.toMatch(/private|secret|prompt|apiKey/)
    expect(observer.snapshot().active[0]).toMatchObject({ name: 'redacted', state: 'redacted', kind: 'tool' })
  })

  test('listener failures cannot break business operations and unsubscribe works', () => {
    const observer = new RuntimeObservation()
    let count = 0
    observer.subscribe(() => { throw new Error('listener failure') })
    const unsubscribe = observer.subscribe(() => { count++ })
    const handle = observer.begin('work')
    handle.phase('waiting')
    unsubscribe()
    handle.end()
    expect(count).toBe(2)
    expect(observer.snapshot().counters.listenerErrors).toBe(3)
    expect(observer.snapshot().active).toHaveLength(0)
  })

  test('off clears tracked activity and stale handles cannot resurrect it', () => {
    const observer = new RuntimeObservation()
    const old = observer.begin('work')
    observer.configure({ mode: 'off' })
    const ignored = observer.begin('ignored')
    old.phase('waiting')
    ignored.end()
    expect(observer.snapshot().active).toHaveLength(0)
    observer.configure({ mode: 'basic' })
    old.phase('running')
    old.end()
    expect(observer.snapshot().active).toHaveLength(0)
    expect(observer.begin('new').id).not.toBe('')
  })
})
