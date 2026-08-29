export type SessionMutation<T> = () => T | PromiseLike<T>

/**
 * Serializes mutations within one session without coupling unrelated sessions.
 * Operation promises retain their real result; only queue continuation ignores
 * a predecessor's failure so later mutations cannot be poisoned by it.
 */
export class SessionMutationCoordinator {
  private readonly tails = new Map<string, Promise<void>>()

  enqueue<T>(sessionId: string, mutation: SessionMutation<T>): Promise<T> {
    const previous = this.tails.get(sessionId)
    const ready = previous ?? Promise.resolve()
    const operation = ready.then(mutation)
    const tail = operation.then(
      () => undefined,
      () => undefined,
    )

    this.tails.set(sessionId, tail)
    const cleanup = () => {
      if (this.tails.get(sessionId) === tail) {
        this.tails.delete(sessionId)
      }
    }
    void tail.then(cleanup)

    return operation
  }

  async drain(sessionId: string): Promise<{ waited: boolean }> {
    let waited = false
    let observed = this.tails.get(sessionId)
    while (observed) {
      waited = true
      await observed
      const current = this.tails.get(sessionId)
      if (!current || current === observed) return { waited }
      observed = current
    }
    return { waited }
  }

  /** Clears shared state between tests. Production lifecycle cleanup must not call this. */
  resetForTests(): void {
    this.tails.clear()
  }
}

export const sessionMutationCoordinator = new SessionMutationCoordinator()
