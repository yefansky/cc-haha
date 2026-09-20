export type ObservationMode = 'off' | 'basic' | 'detailed'

/** Callers supply static diagnostic labels, never user text, tool arguments or credentials. */
export interface OperationMetadata {
  sessionId?: string
  parentId?: string
  kind?: string
  waitingFor?: string
}

export interface ObservedOperation extends OperationMetadata {
  id: string
  name: string
  state: string
  startedAt: number
  changedAt: number
  startStack?: string
  stackKind?: 'operation-start-not-current-cpu-stack'
}

export interface ObservationEvent {
  sequence: number
  at: number
  type: 'begin' | 'phase' | 'end' | 'configure'
  operation?: ObservedOperation
  outcome?: string
  mode?: ObservationMode
}

export interface OperationHandle {
  readonly id: string
  phase(state: string, waitingFor?: string): void
  end(outcome?: string): void
}

const MAX_ACTIVE = 256
const MAX_EVENTS = 256
const MAX_LISTENERS = 16
const noopHandle: OperationHandle = Object.freeze({ id: '', phase() {}, end() {} })

function label(value: unknown): string | undefined {
  return typeof value === 'string' && /^[a-zA-Z0-9_.:-]{1,96}$/.test(value)
    ? value
    : undefined
}

function captureStartStack(): string {
  // Keep only source basenames and line/column coordinates, not usernames or directories.
  return (new Error().stack ?? '').split('\n').slice(2, 14).map(line => {
    const location = line.match(/([^/\\\s():]+:\d+:\d+)\)?$/)?.[1]
    const functionName = line.match(/^\s*at (?:async )?([a-zA-Z_$][\w$]*(?:\.[a-zA-Z_$][\w$]*)*)\s+\(/)?.[1]
    return location ? `at ${functionName ? `${functionName} ` : ''}${location}` : 'at [unavailable]'
  }).join('\n')
}

/** Bounded process-local recorder. No disk/network I/O and no background timer. */
export class RuntimeObservation {
  private mode: ObservationMode = 'basic'
  private detailedUntil: number | undefined
  private active = new Map<string, ObservedOperation>()
  private events: ObservationEvent[] = []
  private eventCursor = 0
  private sequence = 0
  private operationSequence = 0
  private listeners = new Set<(event: ObservationEvent) => void>()
  private counters = { started: 0, completed: 0, droppedActive: 0, droppedEvents: 0, listenerErrors: 0 }

  constructor(private readonly now: () => number = Date.now) {}

  configure(options: { mode: ObservationMode, durationMs?: number }): void {
    if (!['off', 'basic', 'detailed'].includes(options.mode)) throw new Error('Invalid observation mode')
    this.mode = options.mode
    const duration = options.durationMs ?? 60_000
    this.detailedUntil = this.mode === 'detailed'
      ? this.now() + Math.min(300_000, Math.max(1_000, Number.isFinite(duration) ? duration : 60_000))
      : undefined
    // Turning off observation must not leave a frozen set of supposedly active operations.
    if (this.mode === 'off') this.active.clear()
    this.emit({ type: 'configure', mode: this.mode })
  }

  begin(name: string, metadata: OperationMetadata = {}): OperationHandle {
    this.expire()
    if (this.mode === 'off') return noopHandle
    if (this.active.size >= MAX_ACTIVE) {
      this.counters.droppedActive++
      return noopHandle
    }
    const at = this.now()
    const operation: ObservedOperation = {
      id: `op-${++this.operationSequence}`,
      name: label(name) ?? 'redacted',
      state: 'running',
      startedAt: at,
      changedAt: at,
      sessionId: label(metadata.sessionId),
      parentId: label(metadata.parentId),
      kind: label(metadata.kind),
      waitingFor: label(metadata.waitingFor),
    }
    if (this.mode === 'detailed') {
      operation.startStack = captureStartStack()
      operation.stackKind = 'operation-start-not-current-cpu-stack'
    }
    this.active.set(operation.id, operation)
    this.counters.started++
    this.emit({ type: 'begin', operation: { ...operation } })
    return {
      id: operation.id,
      phase: (state, waitingFor) => {
        this.expire()
        if (!this.active.has(operation.id)) return
        const nextState = label(state) ?? 'redacted'
        const nextWaitingFor = label(waitingFor)
        if (operation.state === nextState && operation.waitingFor === nextWaitingFor) return
        operation.state = nextState
        operation.waitingFor = nextWaitingFor
        operation.changedAt = this.now()
        this.emit({ type: 'phase', operation: { ...operation } })
      },
      end: (outcome = 'completed') => {
        this.expire()
        if (!this.active.delete(operation.id)) return
        operation.changedAt = this.now()
        this.counters.completed++
        this.emit({ type: 'end', operation: { ...operation }, outcome: label(outcome) ?? 'redacted' })
      },
    }
  }

  snapshot() {
    this.expire()
    const at = this.now()
    const chronological = this.events.length < MAX_EVENTS
      ? this.events
      : [...this.events.slice(this.eventCursor), ...this.events.slice(0, this.eventCursor)]
    return {
      capturedAt: at,
      config: { mode: this.mode, detailedUntil: this.detailedUntil, maxActive: MAX_ACTIVE, maxEvents: MAX_EVENTS },
      active: [...this.active.values()].map(operation => ({
        ...operation,
        durationMs: Math.max(0, at - operation.startedAt),
        phaseDurationMs: Math.max(0, at - operation.changedAt),
      })),
      events: chronological.map(event => ({ ...event, operation: event.operation ? { ...event.operation } : undefined })),
      counters: { ...this.counters },
    }
  }

  /** Listener must do bounded work (e.g. postMessage), never synchronous logging or I/O. */
  subscribe(listener: (event: ObservationEvent) => void): () => void {
    if (this.listeners.size >= MAX_LISTENERS) return () => {}
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  private expire(): void {
    if (this.detailedUntil !== undefined && this.now() >= this.detailedUntil) {
      this.mode = 'basic'
      this.detailedUntil = undefined
      this.emit({ type: 'configure', mode: 'basic' })
    }
  }

  private emit(data: Omit<ObservationEvent, 'sequence' | 'at'>): void {
    const event: ObservationEvent = { ...data, sequence: ++this.sequence, at: this.now() }
    if (event.operation) Object.freeze(event.operation)
    Object.freeze(event)
    if (this.events.length < MAX_EVENTS) this.events.push(event)
    else {
      this.events[this.eventCursor] = event
      this.eventCursor = (this.eventCursor + 1) % MAX_EVENTS
      this.counters.droppedEvents++
    }
    for (const listener of this.listeners) {
      try { listener(event) } catch { this.counters.listenerErrors++ }
    }
  }
}

export const runtimeObservation = new RuntimeObservation()
