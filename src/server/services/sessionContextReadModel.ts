export type SessionContextSource = 'live' | 'transcript' | 'none'
export type SessionContextFreshness = 'fresh' | 'stale' | 'estimated' | 'pending' | 'unavailable'

export type SessionContextStatus = {
  source: SessionContextSource
  freshness: SessionContextFreshness
  refreshing: boolean
}

export type SessionContextReadResult<T> = {
  context?: T
  contextEstimate?: T
  contextStatus: SessionContextStatus
  error?: string
}

export type SessionContextReadInput<T> = {
  sessionId: string
  identity: unknown
  readLive: (signal: AbortSignal) => Promise<T>
  readTranscript: () => Promise<T | null>
}

type LiveValue = {
  value: unknown | null
  updatedAt: number
}

type LiveRequest = {
  controller: AbortController
  promise: Promise<unknown>
}

type SessionState = {
  identity: unknown
  inFlight?: LiveRequest
  live?: LiveValue
  transcriptRequest?: { promise: Promise<unknown | null> }
  transcript?: LiveValue
}

type ReadModelOptions = {
  shortBudgetMs?: number
  hardTimeoutMs?: number
  freshForMs?: number
  maxStates?: number
}

type LiveOutcome<T> = { type: 'live'; value: T } | { type: 'error'; error: unknown }
type TranscriptOutcome<T> = { type: 'transcript'; value: T | null } | { type: 'transcript-error'; error: unknown }

const DEFAULT_SHORT_BUDGET_MS = 150
const DEFAULT_HARD_TIMEOUT_MS = 20_000
const DEFAULT_FRESH_FOR_MS = 1_000
const DEFAULT_MAX_STATES = 128

function errorMessage(error: unknown): string { return error instanceof Error ? error.message : String(error) }

export class SessionContextReadModel {
  private readonly states = new Map<string, SessionState>()
  private readonly shortBudgetMs: number
  private readonly hardTimeoutMs: number
  private readonly freshForMs: number
  private readonly maxStates: number

  constructor(options: ReadModelOptions = {}) {
    this.shortBudgetMs = options.shortBudgetMs ?? DEFAULT_SHORT_BUDGET_MS
    this.hardTimeoutMs = options.hardTimeoutMs ?? DEFAULT_HARD_TIMEOUT_MS
    this.freshForMs = options.freshForMs ?? DEFAULT_FRESH_FOR_MS
    this.maxStates = Math.max(1, options.maxStates ?? DEFAULT_MAX_STATES)
  }

  async read<T>(input: SessionContextReadInput<T>): Promise<SessionContextReadResult<T>> {
    const state = this.getState(input.sessionId, input.identity)
    if (state.live && Date.now() - state.live.updatedAt <= this.freshForMs) {
      return {
        context: state.live.value as T,
        contextStatus: { source: 'live', freshness: 'fresh', refreshing: false },
      }
    }

    const liveRequest = this.ensureLiveRequest(state, input)
    const liveOutcome = liveRequest.promise.then(
      value => ({ type: 'live' as const, value: value as T }),
      error => ({ type: 'error' as const, error }),
    )
    const first = await this.withBudget(liveOutcome)
    if (first.type === 'live') {
      return {
        context: first.value,
        contextStatus: { source: 'live', freshness: 'fresh', refreshing: false },
      }
    }

    if (state.live) {
      return {
        context: state.live.value as T,
        contextStatus: {
          source: 'live',
          freshness: 'stale',
          refreshing: first.type === 'budget',
        },
        ...(first.type === 'error' ? { error: errorMessage(first.error) } : {}),
      }
    }

    const cachedTranscript = state.transcript && Date.now() - state.transcript.updatedAt <= this.freshForMs
      ? state.transcript
      : null
    if (cachedTranscript) {
      return cachedTranscript.value
        ? this.estimated(cachedTranscript.value as T, state, first)
        : this.pending(state, first.type === 'error' ? first.error : undefined)
    }

    const transcriptRequest = this.ensureTranscriptRequest(state, input)
    const transcriptOutcome: Promise<TranscriptOutcome<T>> = transcriptRequest.promise.then(
      value => ({ type: 'transcript' as const, value }),
      error => ({ type: 'transcript-error' as const, error }),
    )
    let next = await this.withBudget(
      first.type === 'error'
        ? transcriptOutcome
        : Promise.race([liveOutcome, transcriptOutcome]),
    )
    if (next.type === 'budget') return this.pending(state)
    if (next.type === 'live') {
      return {
        context: next.value,
        contextStatus: { source: 'live', freshness: 'fresh', refreshing: false },
      }
    }

    if (next.type === 'transcript' && next.value) {
      return this.estimated(next.value, state, first)
    }

    if (next.type === 'error') {
      const liveError = next.error
      next = await this.withBudget(transcriptOutcome)
      if (next.type === 'transcript' && next.value) {
        return this.estimated(next.value, state, { type: 'error', error: liveError })
      }
      return this.pending(state, liveError)
    }

    return this.pending(
      state,
      next.type === 'transcript-error'
        ? next.error
        : first.type === 'error'
          ? first.error
          : undefined,
    )
  }

  getStateCountForTests(): number { return this.states.size }

  private estimated<T>(
    value: T,
    state: SessionState,
    live: LiveOutcome<T> | { type: 'budget' },
  ): SessionContextReadResult<T> {
    return {
      contextEstimate: value,
      contextStatus: {
        source: 'transcript',
        freshness: 'estimated',
        refreshing: Boolean(state.inFlight),
      },
      ...(live.type === 'error' ? { error: errorMessage(live.error) } : {}),
    }
  }

  private pending<T>(state: SessionState, error?: unknown): SessionContextReadResult<T> {
    const refreshing = Boolean(state.inFlight || state.transcriptRequest)
    return {
      contextStatus: {
        source: 'none',
        freshness: refreshing ? 'pending' : 'unavailable',
        refreshing,
      },
      ...(error === undefined ? {} : { error: errorMessage(error) }),
    }
  }

  private async withBudget<T>(outcome: Promise<T>): Promise<T | { type: 'budget' }> {
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      return await Promise.race([
        outcome,
        new Promise<{ type: 'budget' }>(resolve => {
          timer = setTimeout(() => resolve({ type: 'budget' }), this.shortBudgetMs)
        }),
      ])
    } finally {
      if (timer) clearTimeout(timer)
    }
  }

  private getState(sessionId: string, identity: unknown): SessionState {
    const current = this.states.get(sessionId)
    if (current && Object.is(current.identity, identity)) {
      this.states.delete(sessionId)
      this.states.set(sessionId, current)
      return current
    }

    current?.inFlight?.controller.abort(new Error('Session context identity changed'))
    const state = { identity }
    this.states.delete(sessionId)
    this.states.set(sessionId, state)
    while (this.states.size > this.maxStates) {
      const oldestSessionId = this.states.keys().next().value as string | undefined
      if (!oldestSessionId) break
      const oldest = this.states.get(oldestSessionId)
      this.states.delete(oldestSessionId)
      oldest?.inFlight?.controller.abort(new Error('Session context state evicted'))
    }
    return state
  }

  private ensureTranscriptRequest<T>(
    state: SessionState,
    input: SessionContextReadInput<T>,
  ): { promise: Promise<T | null> } {
    if (state.transcriptRequest) {
      return state.transcriptRequest as { promise: Promise<T | null> }
    }
    const promise = Promise.resolve().then(input.readTranscript).then(value => {
      if (this.states.get(input.sessionId) === state) {
        state.transcript = { value, updatedAt: Date.now() }
      }
      return value
    }).finally(() => {
      if (state.transcriptRequest?.promise === promise) delete state.transcriptRequest
    })
    state.transcriptRequest = { promise }
    return { promise }
  }

  private ensureLiveRequest<T>(
    state: SessionState,
    input: SessionContextReadInput<T>,
  ): LiveRequest {
    if (state.inFlight) return state.inFlight

    const controller = new AbortController()
    let timeout: ReturnType<typeof setTimeout> | undefined
    const aborted = new Promise<never>((_, reject) => {
      controller.signal.addEventListener('abort', () => {
        reject(controller.signal.reason ?? new Error('Live context request aborted'))
      }, { once: true })
      timeout = setTimeout(() => {
        controller.abort(new Error(`Live context request timed out after ${this.hardTimeoutMs}ms`))
      }, this.hardTimeoutMs)
    })
    const promise = Promise.race([
      Promise.resolve().then(() => input.readLive(controller.signal)),
      aborted,
    ]).then(value => {
      if (this.states.get(input.sessionId) === state) {
        state.live = { value, updatedAt: Date.now() }
      }
      return value
    }).finally(() => {
      if (timeout) clearTimeout(timeout)
      if (state.inFlight?.promise === promise) delete state.inFlight
    })

    state.inFlight = { controller, promise }
    return state.inFlight
  }
}

export const sessionContextReadModel = new SessionContextReadModel()
