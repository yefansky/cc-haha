import { describe, expect, it } from 'bun:test'
import { SessionMutationCoordinator } from './sessionMutationCoordinator.js'

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

async function flushMicrotasks(count = 8): Promise<void> {
  for (let index = 0; index < count; index++) await Promise.resolve()
}

describe('SessionMutationCoordinator', () => {
  it('runs mutations for the same session in FIFO order', async () => {
    const coordinator = new SessionMutationCoordinator()
    const releaseFirst = deferred()
    const order: string[] = []

    const first = coordinator.enqueue('session-a', async () => {
      order.push('first:start')
      await releaseFirst.promise
      order.push('first:end')
      return 'first-result'
    })
    const second = coordinator.enqueue('session-a', async () => {
      order.push('second:start')
      order.push('second:end')
      return 'second-result'
    })

    await flushMicrotasks()
    expect(order).toEqual(['first:start'])

    releaseFirst.resolve()
    expect(await first).toBe('first-result')
    expect(await second).toBe('second-result')
    expect(order).toEqual([
      'first:start',
      'first:end',
      'second:start',
      'second:end',
    ])
  })

  it('allows different sessions to mutate in parallel', async () => {
    const coordinator = new SessionMutationCoordinator()
    const releaseFirst = deferred()
    const order: string[] = []

    const first = coordinator.enqueue('session-a', async () => {
      order.push('a:start')
      await releaseFirst.promise
      order.push('a:end')
    })
    const second = coordinator.enqueue('session-b', async () => {
      order.push('b:start')
      order.push('b:end')
    })

    await second
    expect(order).toEqual(['a:start', 'b:start', 'b:end'])

    releaseFirst.resolve()
    await first
    expect(order).toEqual(['a:start', 'b:start', 'b:end', 'a:end'])
  })

  it('returns the real failure to its owner without poisoning the next mutation', async () => {
    const coordinator = new SessionMutationCoordinator()
    const failure = new Error('first mutation failed')
    const order: string[] = []

    const first = coordinator.enqueue('session-a', async () => {
      order.push('first')
      throw failure
    })
    const second = coordinator.enqueue('session-a', async () => {
      order.push('second')
      return 42
    })

    await expect(first).rejects.toBe(failure)
    expect(await second).toBe(42)
    expect(order).toEqual(['first', 'second'])
  })

  it('does not release the underlying mutation when a drain observer times out', async () => {
    const coordinator = new SessionMutationCoordinator()
    const releaseFirst = deferred()
    const observerTimeout = deferred<'timed-out'>()
    let secondStarted = false

    const first = coordinator.enqueue('session-a', () => releaseFirst.promise)
    const drain = coordinator.drain('session-a')
    observerTimeout.resolve('timed-out')

    expect(await Promise.race([drain.then(() => 'drained' as const), observerTimeout.promise]))
      .toBe('timed-out')

    const second = coordinator.enqueue('session-a', async () => {
      secondStarted = true
    })
    await flushMicrotasks()
    expect(secondStarted).toBe(false)

    releaseFirst.resolve()
    await first
    await second
    expect(secondStarted).toBe(true)
  })

  it('keeps draining when a new tail is appended to the session being observed', async () => {
    const coordinator = new SessionMutationCoordinator()
    const releaseFirst = deferred()
    const releaseSecond = deferred()
    let drained = false

    const first = coordinator.enqueue('session-a', () => releaseFirst.promise)
    const drain = coordinator.drain('session-a').then((result) => {
      drained = true
      return result
    })
    const second = coordinator.enqueue('session-a', () => releaseSecond.promise)

    releaseFirst.resolve()
    await first
    await flushMicrotasks()
    expect(drained).toBe(false)

    releaseSecond.resolve()
    await second
    expect(await drain).toEqual({ waited: true })
    expect(drained).toBe(true)
  })

  it('keeps owner failure separate while drain settles and the next mutation runs', async () => {
    const coordinator = new SessionMutationCoordinator()
    const releaseFailure = deferred()
    const failure = new Error('runtime transition failed')
    let nextMutationRan = false
    const operation = coordinator.enqueue('session-a', async () => {
      await releaseFailure.promise
      throw failure
    })
    const drain = coordinator.drain('session-a')
    const nextMutation = coordinator.enqueue('session-a', async () => {
      nextMutationRan = true
      return 42
    })
    const ownerOutcome = operation.catch((error) => error)

    releaseFailure.resolve()
    expect(await ownerOutcome).toBe(failure)
    expect(await nextMutation).toBe(42)
    expect(await drain).toEqual({ waited: true })
    expect(nextMutationRan).toBe(true)
    await flushMicrotasks()

    expect(await coordinator.drain('session-a')).toEqual({ waited: false })
  })

  it('exposes an explicit test-only reset for shared handler state', async () => {
    const coordinator = new SessionMutationCoordinator()
    const release = deferred()
    const operation = coordinator.enqueue('session-a', () => release.promise)

    coordinator.resetForTests()
    expect(await coordinator.drain('session-a')).toEqual({ waited: false })

    release.resolve()
    await operation
  })

  it('only lets the latest tail clean up a session queue', async () => {
    const coordinator = new SessionMutationCoordinator()
    const releaseFirst = deferred()
    const releaseSecond = deferred()
    const order: string[] = []

    const first = coordinator.enqueue('session-a', async () => {
      order.push('first:start')
      await releaseFirst.promise
      order.push('first:end')
    })
    const second = coordinator.enqueue('session-a', async () => {
      order.push('second:start')
      await releaseSecond.promise
      order.push('second:end')
    })

    releaseFirst.resolve()
    await first

    const third = coordinator.enqueue('session-a', async () => {
      order.push('third')
    })
    await flushMicrotasks()
    expect(order).toEqual(['first:start', 'first:end', 'second:start'])

    releaseSecond.resolve()
    await second
    await third
    expect(order).toEqual([
      'first:start',
      'first:end',
      'second:start',
      'second:end',
      'third',
    ])
  })
})
