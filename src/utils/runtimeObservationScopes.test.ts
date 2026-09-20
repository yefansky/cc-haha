import { afterEach, describe, expect, test } from 'bun:test'
import { runtimeObservation } from './runtimeObservation.js'
import { getCurrentObservation, observationCheckpoint, observeGenerator, observeOperation } from './runtimeObservationScopes.js'

afterEach(() => {
  runtimeObservation.configure({ mode: 'off' })
  runtimeObservation.configure({ mode: 'basic' })
})

describe('observation scopes', () => {
  test('async operations preserve values, errors and parent attribution across awaits', async () => {
    const value = { result: 42 }
    let parentId: string | undefined
    await observeOperation('outer', async () => {
      parentId = getCurrentObservation()?.id
      await Promise.resolve()
      expect(await observeOperation('inner', async () => {
        await Promise.resolve()
        const child = runtimeObservation.snapshot().active.find(item => item.id === getCurrentObservation()?.id)
        expect(child).toMatchObject({ parentId, sessionId: 'session-1' })
        return value
      })).toBe(value)
      expect(getCurrentObservation()?.id).toBe(parentId)
    }, { sessionId: 'session-1' })
    const error = new Error('original')
    try {
      await observeOperation('failure', () => { throw error })
      throw new Error('expected original failure')
    } catch (caught) { expect(caught).toBe(error) }
    expect(getCurrentObservation()).toBeUndefined()
    expect(runtimeObservation.snapshot().active).toHaveLength(0)
  })

  test('parallel generators retain separate parents and per-resume checkpoints', async () => {
    const create = (sessionId: string) => observeOperation('parent', () => {
      const parentId = getCurrentObservation()?.id
      return { parentId, iterator: observeGenerator('child', async function* () {
        await Promise.resolve()
        observationCheckpoint('before-yield')
        const firstId = getCurrentObservation()?.id
        const input: string = yield firstId
        await Promise.resolve()
        expect(getCurrentObservation()?.id).toBe(firstId)
        observationCheckpoint('after-yield')
        return input
      }) }
    }, { sessionId })
    const [a, b] = await Promise.all([create('session-a'), create('session-b')])
    const [firstA, firstB] = await Promise.all([a.iterator.next(), b.iterator.next()])
    expect(firstA.value).not.toBe(firstB.value)
    for (const [id, parentId, sessionId] of [[firstA.value, a.parentId, 'session-a'], [firstB.value, b.parentId, 'session-b']]) {
      expect(runtimeObservation.snapshot().active.find(item => item.id === id)).toMatchObject({ parentId, sessionId, state: 'before-yield' })
    }
    expect(await a.iterator.next('result-a')).toEqual({ done: true, value: 'result-a' })
    expect(await b.iterator.next('result-b')).toEqual({ done: true, value: 'result-b' })
    expect(runtimeObservation.snapshot().active).toHaveLength(0)
    expect(getCurrentObservation()).toBeUndefined()
  })

  test('return preserves finally yields and records cancellation only after actual cleanup', async () => {
    let cleaned = false
    const iterator = observeGenerator('cancelled-generator', async function* () {
      try { yield 1 } finally {
        observationCheckpoint('cleanup')
        yield 2
        cleaned = true
      }
      return 3
    })
    expect(runtimeObservation.snapshot().active).toHaveLength(0)
    await iterator.next()
    expect(await iterator.return(9)).toEqual({ done: false, value: 2 })
    expect(runtimeObservation.snapshot().active[0].state).toBe('cleanup')
    expect(cleaned).toBe(false)
    expect(await iterator.next()).toEqual({ done: true, value: 9 })
    expect(cleaned).toBe(true)
    expect(runtimeObservation.snapshot().active).toHaveLength(0)
    expect(runtimeObservation.snapshot().events.at(-1)?.outcome).toBe('cancelled')
  })

  test('throw passes through caught errors and preserves uncaught identity and finally', async () => {
    let cleaned = false
    const error = new Error('original')
    const iterator = observeGenerator('throw-generator', async function* () {
      try {
        try { yield 'first' } catch (caught) {
          expect(caught).toBe(error)
          yield 'caught'
        }
        throw error
      } finally { cleaned = true }
    })
    await iterator.next()
    expect(await iterator.throw(error)).toEqual({ done: false, value: 'caught' })
    expect(runtimeObservation.snapshot().active).toHaveLength(1)
    try {
      await iterator.next()
      throw new Error('expected original failure')
    } catch (caught) { expect(caught).toBe(error) }
    expect(cleaned).toBe(true)
    expect(runtimeObservation.snapshot().active).toHaveLength(0)
    expect(runtimeObservation.snapshot().events.at(-1)?.outcome).toBe('failed')
  })

  test('checkpoints are harmless outside scopes and repeated phases produce no extra events', async () => {
    observationCheckpoint('outside')
    await observeOperation('checkpoints', () => {
      observationCheckpoint('same-phase')
      const count = runtimeObservation.snapshot().events.at(-1)?.sequence
      for (let index = 0; index < 1000; index++) observationCheckpoint('same-phase')
      expect(runtimeObservation.snapshot().events.at(-1)?.sequence).toBe(count)
    })
  })

  test('async disposal and for-await break execute original cleanup', async () => {
    let cleanups = 0
    const create = () => observeGenerator('disposal', async function* () {
      try { yield 1; yield 2 } finally { cleanups++ }
    })
    for await (const value of create()) {
      expect(value).toBe(1)
      break
    }
    const iterator = create()
    await iterator.next()
    await iterator[Symbol.asyncDispose]()
    expect(cleanups).toBe(2)
    expect(runtimeObservation.snapshot().active).toHaveLength(0)
  })
})
