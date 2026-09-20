export interface BoundaryTraceInput {
  layer: string
  direction: 'in' | 'out'
  event: string
  correlationId: string
  outcome?: string
  metadata?: {
    sessionId?: string
    parentCorrelationId?: string
    peerPid?: number
    transport?: 'http' | 'websocket' | 'sdk' | 'ipc'
    queueDepth?: number
    statusCode?: number
  }
}

export interface BoundaryTraceEntry extends BoundaryTraceInput {
  recordingId: string
  seq: number
  timestamp: number
  pid: number
}

export interface BoundaryTraceSnapshot {
  recordingId: string | null
  recording: boolean
  startedAt: number | null
  stoppedAt: number | null
  expiresAt: number | null
  capacity: number
  dropped: number
  rejected: number
  entries: BoundaryTraceEntry[]
}

type TraceChange = { type: 'entry', entry: BoundaryTraceEntry } | { type: 'reset' | 'stop', snapshot: BoundaryTraceSnapshot }
const CAPACITY = 2048
const identifier = (value: unknown): value is string => typeof value === 'string' && /^[a-zA-Z0-9_.:-]{1,128}$/.test(value)
const integer = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0

/** Opt-in boundary evidence only. Never pass request payloads or free-form diagnostic text. */
export class RuntimeBoundaryTrace {
  private recordingId: string | null = null
  private recording = false
  private startedAt: number | null = null
  private stoppedAt: number | null = null
  private expiresAt: number | null = null
  private sequence = 0
  private dropped = 0
  private rejected = 0
  private entries: BoundaryTraceEntry[] = []
  private cursor = 0
  private listeners = new Set<(change: TraceChange) => void>()

  constructor(private readonly now: () => number = Date.now, private readonly pid = process.pid) {}

  start(recordingId: string = crypto.randomUUID(), durationMs = 600_000): BoundaryTraceSnapshot {
    if (!identifier(recordingId)) throw new Error('Invalid recording ID')
    this.recordingId = recordingId
    this.recording = true
    this.startedAt = this.now()
    this.expiresAt = this.startedAt + Math.max(1, Math.min(1_800_000, Number.isFinite(durationMs) ? durationMs : 600_000))
    this.stoppedAt = null
    this.sequence = this.dropped = this.rejected = this.cursor = 0
    this.entries = []
    const snapshot = this.snapshot()
    this.emit({ type: 'reset', snapshot })
    return snapshot
  }

  stop(): BoundaryTraceSnapshot {
    if (this.recording) this.stoppedAt = this.now()
    this.recording = false
    const snapshot = this.snapshot()
    this.emit({ type: 'stop', snapshot })
    return snapshot
  }

  record(input: BoundaryTraceInput): void {
    this.expire()
    if (!this.recording || !this.recordingId) return
    if (!identifier(input.layer) || !identifier(input.event) || !identifier(input.correlationId) ||
      !['in', 'out'].includes(input.direction) || (input.outcome !== undefined && !identifier(input.outcome))) {
      this.rejected++
      return
    }
    const metadata: NonNullable<BoundaryTraceInput['metadata']> = {}
    const source = input.metadata
    if (source) {
      if (identifier(source.sessionId)) metadata.sessionId = source.sessionId
      if (identifier(source.parentCorrelationId)) metadata.parentCorrelationId = source.parentCorrelationId
      if (integer(source.peerPid)) metadata.peerPid = source.peerPid
      if (integer(source.queueDepth)) metadata.queueDepth = source.queueDepth
      if (integer(source.statusCode) && source.statusCode <= 599) metadata.statusCode = source.statusCode
      if (['http', 'websocket', 'sdk', 'ipc'].includes(source.transport ?? '')) metadata.transport = source.transport
    }
    const entry: BoundaryTraceEntry = Object.freeze({
      recordingId: this.recordingId, seq: ++this.sequence, timestamp: this.now(), pid: this.pid,
      layer: input.layer, direction: input.direction, event: input.event,
      correlationId: input.correlationId, outcome: input.outcome,
      metadata: Object.freeze(metadata),
    })
    if (this.entries.length < CAPACITY) this.entries.push(entry)
    else { this.entries[this.cursor] = entry; this.cursor = (this.cursor + 1) % CAPACITY; this.dropped++ }
    this.emit({ type: 'entry', entry })
  }

  snapshot(): BoundaryTraceSnapshot {
    this.expire()
    return {
      recordingId: this.recordingId, recording: this.recording, startedAt: this.startedAt,
      stoppedAt: this.stoppedAt, expiresAt: this.expiresAt, capacity: CAPACITY, dropped: this.dropped, rejected: this.rejected,
      entries: this.entries.length < CAPACITY ? [...this.entries] : [...this.entries.slice(this.cursor), ...this.entries.slice(0, this.cursor)],
    }
  }

  subscribe(listener: (change: TraceChange) => void): () => void {
    if (this.listeners.size >= 16) return () => {}
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  private emit(change: TraceChange): void {
    for (const listener of this.listeners) { try { listener(change) } catch {} }
  }

  private expire(): void {
    if (this.recording && this.expiresAt !== null && this.now() >= this.expiresAt) this.stop()
  }
}

export const runtimeBoundaryTrace = new RuntimeBoundaryTrace()

export interface BoundaryContractHop {
  layer: string
  direction: 'in' | 'out'
  event: string
  outcome?: string
}

/** Checks only named boundary observations, never claims internal correctness or guesses missing hops. */
export function inspectBoundaryContract(
  snapshots: BoundaryTraceSnapshot[],
  correlationId: string,
  expected: BoundaryContractHop[],
): { status: 'complete' | 'incomplete' | 'unknown', observed: number, missing: BoundaryContractHop[], reason: string } {
  const ids = new Set(snapshots.map(snapshot => snapshot.recordingId))
  if (!expected.length || !snapshots.length || ids.size !== 1 || ids.has(null)) {
    return { status: 'unknown', observed: 0, missing: [...expected], reason: 'No contract or no single matching recording.' }
  }
  const entries = snapshots.flatMap(snapshot => snapshot.entries).filter(entry => entry.correlationId === correlationId)
  const missing = expected.filter(hop => !entries.some(entry => entry.layer === hop.layer && entry.direction === hop.direction && entry.event === hop.event &&
    (hop.outcome === undefined || entry.outcome === hop.outcome)))
  if (snapshots.some(snapshot => snapshot.dropped > 0 || snapshot.rejected > 0)) {
    return { status: 'unknown', observed: entries.length, missing, reason: 'Recording contains dropped or rejected evidence.' }
  }
  return {
    status: missing.length ? 'incomplete' : 'complete', observed: entries.length, missing,
    reason: missing.length ? 'Expected boundary observations are absent; cause is not inferred.' : 'All explicitly named boundary observations exist; this is not proof of internal correctness or cross-process ordering.',
  }
}
