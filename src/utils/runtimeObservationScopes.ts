import { AsyncLocalStorage } from 'async_hooks'
import { runtimeObservation, type OperationHandle, type OperationMetadata } from './runtimeObservation.js'

interface ObservationScope {
  operation: OperationHandle
  sessionId?: string
}

const scopes = new AsyncLocalStorage<ObservationScope>()

export function getCurrentObservation(): OperationHandle | undefined {
  return scopes.getStore()?.operation
}

export function observationCheckpoint(name: string): void {
  getCurrentObservation()?.phase(name)
}

function createScope(name: string, metadata: OperationMetadata, parent = scopes.getStore()): ObservationScope {
  const sessionId = metadata.sessionId ?? parent?.sessionId
  return {
    operation: runtimeObservation.begin(name, {
      ...metadata,
      sessionId,
      parentId: metadata.parentId ?? parent?.operation.id,
    }),
    sessionId,
  }
}

/** Preserves the original resolved value or thrown error, with async-local parent attribution. */
export async function observeOperation<T>(
  name: string,
  operation: () => T | PromiseLike<T>,
  metadata: OperationMetadata = {},
): Promise<T> {
  const scope = createScope(name, metadata)
  try {
    const result = await scopes.run(scope, operation)
    scope.operation.end('completed')
    return result
  } catch (error) {
    scope.operation.end('failed')
    throw error
  }
}

/**
 * Each iterator method re-enters the scope: wrapping only factory creation loses
 * attribution when a consumer resumes the generator from a different async chain.
 * A return that yields from finally remains active until the iterator actually ends.
 */
export function observeGenerator<T, R = any, N = unknown>(
  name: string,
  factory: () => AsyncGenerator<T, R, N>,
  metadata: OperationMetadata = {},
): AsyncGenerator<T, R, N> {
  const parent = scopes.getStore()
  let scope: ObservationScope | undefined
  let iterator: AsyncGenerator<T, R, N> | undefined
  let cancelled = false

  const invoke = async (
    method: 'next' | 'return' | 'throw',
    args: [] | [unknown],
  ): Promise<IteratorResult<T, R>> => {
    scope ??= createScope(name, metadata, parent)
    if (method === 'return') cancelled = true
    try {
      const result = await scopes.run(scope, () => {
        iterator ??= factory()
        if (method === 'next') return iterator.next(...args as [] | [N])
        if (method === 'return') return iterator.return(args[0] as R | PromiseLike<R>)
        return iterator.throw(args[0])
      })
      if (result.done) scope.operation.end(cancelled ? 'cancelled' : 'completed')
      return result
    } catch (error) {
      scope.operation.end('failed')
      throw error
    }
  }

  return {
    next: (...args: [] | [N]) => invoke('next', args),
    return: (value: R | PromiseLike<R>) => invoke('return', [value]),
    throw: (error: unknown) => invoke('throw', [error]),
    [Symbol.asyncIterator]() { return this },
    async [Symbol.asyncDispose]() { await invoke('return', [undefined]) },
  }
}
