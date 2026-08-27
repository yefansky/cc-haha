import { createHash } from 'node:crypto'
import type {
  ReplaceUserTurnError,
  ReplaceUserTurnPhase,
  ReplaceUserTurnRequest,
  ReplaceUserTurnResult,
  ReplaceUserTurnState,
} from './events.js'

export type ReplaceUserTurnOperationState = ReplaceUserTurnState

export type ReplaceUserTurnOperationPhase = ReplaceUserTurnPhase

export type ReplaceUserTurnRegistryRejectionCode =
  | 'REPLACE_OPERATION_ID_REUSED'
  | 'REPLACE_TARGET_CONFLICT'
  | 'REPLACE_SESSION_BUSY'

export type ReplaceUserTurnRegistryErrorCode =
  | 'REPLACE_OPERATION_NOT_FOUND'
  | 'REPLACE_INVALID_OPERATION_TRANSITION'
  | 'REPLACE_INVALID_OPERATION_PHASE'
  | 'REPLACE_INVALID_CLAIM_RELEASE'

export type ReplaceUserTurnOperationResult = ReplaceUserTurnResult

export type ReplaceUserTurnOperationError = ReplaceUserTurnError

/**
 * The entire user-visible request is fingerprinted, but it is never retained by
 * the registry. Extra protocol fields are included automatically so adding a
 * future precondition cannot silently weaken idempotency.
 */
export type ReplaceUserTurnFingerprintInput = ReplaceUserTurnRequest

export interface ReplaceUserTurnOperationSeed {
  readonly operationId: string
  readonly targetUserMessageId: string
  readonly expectedLatestUserMessageId: string
  readonly replacementMessageUuid: string
  readonly requestFingerprint: string
}

export interface ReplaceUserTurnOperationSnapshot {
  readonly sessionId: string
  readonly operationId: string
  readonly targetUserMessageId: string
  readonly expectedLatestUserMessageId: string
  readonly replacementMessageUuid: string
  readonly state: ReplaceUserTurnOperationState
  readonly phase: ReplaceUserTurnOperationPhase
  readonly destructiveBoundaryCrossed: boolean
  readonly createdAtMs: number
  readonly updatedAtMs: number
  /** Protocol-facing alias of updatedAtMs. */
  readonly updatedAt: number
  readonly startedAtMs?: number
  readonly admittedAtMs?: number
  readonly terminalAtMs?: number
  readonly result?: Readonly<ReplaceUserTurnOperationResult>
  readonly error?: Readonly<ReplaceUserTurnOperationError>
}

export type ReplaceUserTurnAcceptResult =
  | {
    readonly kind: 'accepted'
    readonly record: ReplaceUserTurnOperationSnapshot
  }
  | {
    readonly kind: 'existing'
    readonly record: ReplaceUserTurnOperationSnapshot
  }
  | {
    readonly kind: 'rejected'
    readonly code: ReplaceUserTurnRegistryRejectionCode
    readonly record: ReplaceUserTurnOperationSnapshot
  }

export interface ReplaceUserTurnOperationRegistryOptions {
  readonly clock?: () => number
  readonly terminalTtlMs?: number
  readonly maxTerminalRecordsPerSession?: number
}

export interface ReplaceUserTurnPhaseOptions {
  readonly destructiveBoundaryCrossed?: boolean
}

export interface ReplaceUserTurnFailureOptions {
  readonly destructiveBoundaryCrossed?: boolean
  /**
   * Releasing a target claim requires evidence about why it is safe. A
   * pre-destructive release is rejected once the destructive boundary has been
   * crossed; rollback_confirmed represents an independently verified rollback.
   */
  readonly claimReleaseReason?: 'pre_destructive' | 'rollback_confirmed'
}

export interface ReplaceUserTurnIndeterminateOptions {
  readonly destructiveBoundaryCrossed?: boolean
}

interface ReplaceUserTurnOperationRecord {
  sessionId: string
  operationId: string
  targetUserMessageId: string
  expectedLatestUserMessageId: string
  replacementMessageUuid: string
  requestFingerprint: string
  state: ReplaceUserTurnOperationState
  phase: ReplaceUserTurnOperationPhase
  destructiveBoundaryCrossed: boolean
  createdAtMs: number
  updatedAtMs: number
  startedAtMs?: number
  admittedAtMs?: number
  terminalAtMs?: number
  result?: Readonly<ReplaceUserTurnOperationResult>
  error?: Readonly<ReplaceUserTurnOperationError>
  claimReleaseReason?: NonNullable<ReplaceUserTurnFailureOptions['claimReleaseReason']>
}

const DEFAULT_TERMINAL_TTL_MS = 15 * 60 * 1000
const DEFAULT_MAX_TERMINAL_RECORDS_PER_SESSION = 32

const PHASE_ORDER: Readonly<Record<ReplaceUserTurnOperationPhase, number>> = {
  preflight: 0,
  stopping: 1,
  trimmed: 2,
  starting_runtime: 3,
  admitting: 4,
  awaiting_replay: 5,
}

const ACTIVE_STATES = new Set<ReplaceUserTurnOperationState>([
  'queued',
  'running',
  'admitted',
  'indeterminate',
])

const TERMINAL_STATES = new Set<ReplaceUserTurnOperationState>([
  'committed',
  'failed',
])

function canonicalFingerprintValue(
  value: unknown,
  ancestors: Set<object>,
): string {
  if (value === undefined) return '["undefined"]'
  if (value === null) return 'null'
  if (typeof value === 'string' || typeof value === 'boolean') {
    return JSON.stringify(value)
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new TypeError('replace_user_turn fingerprint input must contain finite numbers')
    }
    return Object.is(value, -0) ? '0' : JSON.stringify(value)
  }

  if (typeof value !== 'object') {
    throw new TypeError(`replace_user_turn fingerprint input contains unsupported ${typeof value}`)
  }
  if (ancestors.has(value)) {
    throw new TypeError('replace_user_turn fingerprint input must not contain cycles')
  }
  ancestors.add(value)
  try {
    if (Array.isArray(value)) {
      return `[${value.map(item => canonicalFingerprintValue(item, ancestors)).join(',')}]`
    }
    const objectValue = value as Record<string, unknown>
    const fields = Object.keys(objectValue).sort().map(key => (
      `${JSON.stringify(key)}:${canonicalFingerprintValue(objectValue[key], ancestors)}`
    ))
    return `{${fields.join(',')}}`
  } finally {
    ancestors.delete(value)
  }
}

/** Returns a stable SHA-256 hex digest without retaining request content. */
export function fingerprintReplaceUserTurnRequest(
  input: ReplaceUserTurnFingerprintInput,
): string {
  return createHash('sha256')
    .update(canonicalFingerprintValue(input, new Set()), 'utf8')
    .digest('hex')
}

function deepFreeze<T>(value: T): Readonly<T> {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child)
    Object.freeze(value)
  }
  return value
}

function cloneResult(
  result: ReplaceUserTurnOperationResult,
): Readonly<ReplaceUserTurnOperationResult> {
  return deepFreeze({ messagesRemoved: result.messagesRemoved })
}

function cloneError(
  error: ReplaceUserTurnOperationError,
): Readonly<ReplaceUserTurnOperationError> {
  const cloned: ReplaceUserTurnOperationError = {
    code: error.code,
    message: error.message,
    retryable: error.retryable,
    newOperationRequired: error.newOperationRequired,
  }
  return deepFreeze(cloned)
}

function snapshotOf(record: ReplaceUserTurnOperationRecord): ReplaceUserTurnOperationSnapshot {
  const snapshot: ReplaceUserTurnOperationSnapshot = {
    sessionId: record.sessionId,
    operationId: record.operationId,
    targetUserMessageId: record.targetUserMessageId,
    expectedLatestUserMessageId: record.expectedLatestUserMessageId,
    replacementMessageUuid: record.replacementMessageUuid,
    state: record.state,
    phase: record.phase,
    destructiveBoundaryCrossed: record.destructiveBoundaryCrossed,
    createdAtMs: record.createdAtMs,
    updatedAtMs: record.updatedAtMs,
    updatedAt: record.updatedAtMs,
    ...(record.startedAtMs === undefined ? {} : { startedAtMs: record.startedAtMs }),
    ...(record.admittedAtMs === undefined ? {} : { admittedAtMs: record.admittedAtMs }),
    ...(record.terminalAtMs === undefined ? {} : { terminalAtMs: record.terminalAtMs }),
    ...(record.result === undefined ? {} : { result: cloneResult(record.result) }),
    ...(record.error === undefined ? {} : { error: cloneError(record.error) }),
  }
  return deepFreeze(snapshot) as ReplaceUserTurnOperationSnapshot
}

export class ReplaceUserTurnOperationRegistryError extends Error {
  constructor(
    readonly code: ReplaceUserTurnRegistryErrorCode,
    message: string,
  ) {
    super(message)
    this.name = 'ReplaceUserTurnOperationRegistryError'
  }
}

/**
 * Invariants:
 * - A session has at most one active operation, including indeterminate work.
 * - A target is claimed by at most one retained operation. A failed owner may
 *   release it only with a verified pre-destructive or rollback reason, without
 *   deleting its idempotency record.
 * - Request fingerprints stay internal; exposing them would leak a brute-force
 *   oracle for low-entropy message content.
 * - Request bodies and attachments never enter registry records; only their
 *   SHA-256 fingerprint does.
 * - `trimmed` and every later phase permanently mark the destructive boundary.
 * - Only committed/failed records are subject to lazy TTL/capacity eviction.
 * - Every public read returns a detached, deeply frozen snapshot.
 */
export class ReplaceUserTurnOperationRegistry {
  private readonly clock: () => number
  private readonly terminalTtlMs: number
  private readonly maxTerminalRecordsPerSession: number
  private readonly recordsBySession = new Map<
    string,
    Map<string, ReplaceUserTurnOperationRecord>
  >()
  private readonly targetClaimsBySession = new Map<string, Map<string, string>>()
  private readonly activeOperationBySession = new Map<string, string>()

  constructor(options: ReplaceUserTurnOperationRegistryOptions = {}) {
    this.clock = options.clock ?? Date.now
    this.terminalTtlMs = options.terminalTtlMs ?? DEFAULT_TERMINAL_TTL_MS
    this.maxTerminalRecordsPerSession = options.maxTerminalRecordsPerSession ??
      DEFAULT_MAX_TERMINAL_RECORDS_PER_SESSION

    if (!Number.isFinite(this.terminalTtlMs) || this.terminalTtlMs < 0) {
      throw new RangeError('terminalTtlMs must be a finite non-negative number')
    }
    if (
      !Number.isInteger(this.maxTerminalRecordsPerSession) ||
      this.maxTerminalRecordsPerSession < 0
    ) {
      throw new RangeError('maxTerminalRecordsPerSession must be a non-negative integer')
    }
  }

  accept(sessionId: string, seed: ReplaceUserTurnOperationSeed): ReplaceUserTurnAcceptResult {
    this.cleanupSession(sessionId)
    const records = this.recordsBySession.get(sessionId)
    const existing = records?.get(seed.operationId)
    if (existing) {
      if (existing.requestFingerprint === seed.requestFingerprint) {
        return { kind: 'existing', record: snapshotOf(existing) }
      }
      return {
        kind: 'rejected',
        code: 'REPLACE_OPERATION_ID_REUSED',
        record: snapshotOf(existing),
      }
    }

    const claimedOperationId = this.targetClaimsBySession
      .get(sessionId)
      ?.get(seed.targetUserMessageId)
    if (claimedOperationId) {
      const owner = records?.get(claimedOperationId)
      return this.rejectAndRemember(
        sessionId,
        seed,
        'REPLACE_TARGET_CONFLICT',
        owner
          ? `Target is already claimed by replace operation ${owner.operationId}`
          : 'Target is already claimed by another replace operation',
      )
    }

    const activeOperationId = this.activeOperationBySession.get(sessionId)
    if (activeOperationId) {
      const owner = records?.get(activeOperationId)
      return this.rejectAndRemember(
        sessionId,
        seed,
        'REPLACE_SESSION_BUSY',
        owner
          ? `Session already has active replace operation ${owner.operationId}`
          : 'Session already has an active replace operation',
      )
    }

    const now = this.clock()
    const record: ReplaceUserTurnOperationRecord = {
      sessionId,
      operationId: seed.operationId,
      targetUserMessageId: seed.targetUserMessageId,
      expectedLatestUserMessageId: seed.expectedLatestUserMessageId,
      replacementMessageUuid: seed.replacementMessageUuid,
      requestFingerprint: seed.requestFingerprint,
      state: 'queued',
      phase: 'preflight',
      destructiveBoundaryCrossed: false,
      createdAtMs: now,
      updatedAtMs: now,
    }
    const sessionRecords = records ?? new Map<string, ReplaceUserTurnOperationRecord>()
    if (!records) this.recordsBySession.set(sessionId, sessionRecords)
    sessionRecords.set(seed.operationId, record)

    let targetClaims = this.targetClaimsBySession.get(sessionId)
    if (!targetClaims) {
      targetClaims = new Map()
      this.targetClaimsBySession.set(sessionId, targetClaims)
    }
    targetClaims.set(seed.targetUserMessageId, seed.operationId)
    this.activeOperationBySession.set(sessionId, seed.operationId)
    return { kind: 'accepted', record: snapshotOf(record) }
  }

  get(sessionId: string, operationId: string): ReplaceUserTurnOperationSnapshot | undefined {
    this.cleanupSession(sessionId)
    const record = this.recordsBySession.get(sessionId)?.get(operationId)
    return record ? snapshotOf(record) : undefined
  }

  markRunning(sessionId: string, operationId: string): ReplaceUserTurnOperationSnapshot {
    const record = this.requireRecord(sessionId, operationId)
    if (record.state === 'running') return snapshotOf(record)
    this.requireState(record, ['queued'], 'running')
    const now = this.clock()
    record.state = 'running'
    record.startedAtMs = now
    record.updatedAtMs = now
    return snapshotOf(record)
  }

  markPhase(
    sessionId: string,
    operationId: string,
    phase: ReplaceUserTurnOperationPhase,
    options: ReplaceUserTurnPhaseOptions = {},
  ): ReplaceUserTurnOperationSnapshot {
    const record = this.requireRecord(sessionId, operationId)
    this.requireState(record, ['running'], `phase ${phase}`)
    if (PHASE_ORDER[phase] < PHASE_ORDER[record.phase]) {
      throw new ReplaceUserTurnOperationRegistryError(
        'REPLACE_INVALID_OPERATION_PHASE',
        `Cannot move replace operation ${operationId} from phase ${record.phase} to ${phase}`,
      )
    }

    if (record.phase !== phase || options.destructiveBoundaryCrossed) {
      record.phase = phase
      record.destructiveBoundaryCrossed = record.destructiveBoundaryCrossed ||
        options.destructiveBoundaryCrossed === true ||
        PHASE_ORDER[phase] >= PHASE_ORDER.trimmed
      record.updatedAtMs = this.clock()
    }
    return snapshotOf(record)
  }

  markAdmitted(
    sessionId: string,
    operationId: string,
    result?: ReplaceUserTurnOperationResult,
  ): ReplaceUserTurnOperationSnapshot {
    const record = this.requireRecord(sessionId, operationId)
    if (record.state === 'admitted') return snapshotOf(record)
    this.requireState(record, ['running'], 'admitted')
    const now = this.clock()
    record.state = 'admitted'
    record.phase = 'awaiting_replay'
    record.destructiveBoundaryCrossed = true
    record.admittedAtMs = now
    record.updatedAtMs = now
    if (result !== undefined) record.result = cloneResult(result)
    return snapshotOf(record)
  }

  markCommitted(
    sessionId: string,
    operationId: string,
    result?: ReplaceUserTurnOperationResult,
  ): ReplaceUserTurnOperationSnapshot {
    const record = this.requireRecord(sessionId, operationId)
    if (record.state === 'committed') return snapshotOf(record)
    this.requireState(record, ['admitted', 'indeterminate'], 'committed')
    const now = this.clock()
    record.state = 'committed'
    record.phase = 'awaiting_replay'
    record.destructiveBoundaryCrossed = true
    record.updatedAtMs = now
    record.terminalAtMs = now
    record.error = undefined
    if (result !== undefined) record.result = cloneResult(result)
    this.releaseActiveOperation(record)
    this.cleanupSession(sessionId)
    return snapshotOf(record)
  }

  markFailed(
    sessionId: string,
    operationId: string,
    error: ReplaceUserTurnOperationError,
    options: ReplaceUserTurnFailureOptions = {},
  ): ReplaceUserTurnOperationSnapshot {
    const record = this.requireRecord(sessionId, operationId)
    if (record.state === 'failed') {
      if (
        options.claimReleaseReason !== undefined &&
        options.claimReleaseReason !== record.claimReleaseReason
      ) {
        throw new ReplaceUserTurnOperationRegistryError(
          'REPLACE_INVALID_CLAIM_RELEASE',
          `Cannot change the claim release decision for failed replace operation ${operationId}`,
        )
      }
      this.validateClaimReleaseReason(
        operationId,
        record.destructiveBoundaryCrossed || options.destructiveBoundaryCrossed === true,
        options.claimReleaseReason,
      )
      return snapshotOf(record)
    }
    this.requireState(record, ['queued', 'running', 'admitted', 'indeterminate'], 'failed')
    const destructiveBoundaryCrossed = record.destructiveBoundaryCrossed ||
      options.destructiveBoundaryCrossed === true
    this.validateClaimReleaseReason(
      operationId,
      destructiveBoundaryCrossed,
      options.claimReleaseReason,
    )
    const now = this.clock()
    record.state = 'failed'
    record.destructiveBoundaryCrossed = destructiveBoundaryCrossed
    record.updatedAtMs = now
    record.terminalAtMs = now
    record.error = cloneError(error)
    record.claimReleaseReason = options.claimReleaseReason
    this.releaseActiveOperation(record)
    if (options.claimReleaseReason) this.releaseTargetClaim(record)
    this.cleanupSession(sessionId)
    return snapshotOf(record)
  }

  markIndeterminate(
    sessionId: string,
    operationId: string,
    error?: ReplaceUserTurnOperationError,
    options: ReplaceUserTurnIndeterminateOptions = {},
  ): ReplaceUserTurnOperationSnapshot {
    const record = this.requireRecord(sessionId, operationId)
    if (record.state === 'indeterminate') return snapshotOf(record)
    this.requireState(record, ['running', 'admitted'], 'indeterminate')
    record.state = 'indeterminate'
    record.destructiveBoundaryCrossed = record.destructiveBoundaryCrossed ||
      options.destructiveBoundaryCrossed === true
    record.updatedAtMs = this.clock()
    if (error !== undefined) record.error = cloneError(error)
    return snapshotOf(record)
  }

  hasActiveSessionOperation(sessionId: string): boolean {
    this.cleanupSession(sessionId)
    const operationId = this.activeOperationBySession.get(sessionId)
    if (!operationId) return false
    const record = this.recordsBySession.get(sessionId)?.get(operationId)
    return record !== undefined && ACTIVE_STATES.has(record.state)
  }

  /** Clears all state between tests. Production lifecycle code must not call this. */
  resetForTests(): void {
    this.recordsBySession.clear()
    this.targetClaimsBySession.clear()
    this.activeOperationBySession.clear()
  }

  private requireRecord(
    sessionId: string,
    operationId: string,
  ): ReplaceUserTurnOperationRecord {
    this.cleanupSession(sessionId)
    const record = this.recordsBySession.get(sessionId)?.get(operationId)
    if (!record) {
      throw new ReplaceUserTurnOperationRegistryError(
        'REPLACE_OPERATION_NOT_FOUND',
        `Replace operation ${operationId} was not found for session ${sessionId}`,
      )
    }
    return record
  }

  private rejectAndRemember(
    sessionId: string,
    seed: ReplaceUserTurnOperationSeed,
    code: Exclude<ReplaceUserTurnRegistryRejectionCode, 'REPLACE_OPERATION_ID_REUSED'>,
    message: string,
  ): ReplaceUserTurnAcceptResult {
    const now = this.clock()
    const record: ReplaceUserTurnOperationRecord = {
      sessionId,
      operationId: seed.operationId,
      targetUserMessageId: seed.targetUserMessageId,
      expectedLatestUserMessageId: seed.expectedLatestUserMessageId,
      replacementMessageUuid: seed.replacementMessageUuid,
      requestFingerprint: seed.requestFingerprint,
      state: 'failed',
      phase: 'preflight',
      destructiveBoundaryCrossed: false,
      createdAtMs: now,
      updatedAtMs: now,
      terminalAtMs: now,
      error: cloneError({
        code,
        message,
        retryable: false,
        newOperationRequired: true,
      }),
    }
    let records = this.recordsBySession.get(sessionId)
    if (!records) {
      records = new Map()
      this.recordsBySession.set(sessionId, records)
    }
    records.set(seed.operationId, record)
    const snapshot = snapshotOf(record)
    this.cleanupSession(sessionId)
    return { kind: 'rejected', code, record: snapshot }
  }

  private requireState(
    record: ReplaceUserTurnOperationRecord,
    allowed: readonly ReplaceUserTurnOperationState[],
    next: string,
  ): void {
    if (allowed.includes(record.state)) return
    throw new ReplaceUserTurnOperationRegistryError(
      'REPLACE_INVALID_OPERATION_TRANSITION',
      `Cannot move replace operation ${record.operationId} from ${record.state} to ${next}`,
    )
  }

  private releaseActiveOperation(record: ReplaceUserTurnOperationRecord): void {
    if (this.activeOperationBySession.get(record.sessionId) === record.operationId) {
      this.activeOperationBySession.delete(record.sessionId)
    }
  }

  private releaseTargetClaim(record: ReplaceUserTurnOperationRecord): void {
    const claims = this.targetClaimsBySession.get(record.sessionId)
    if (claims?.get(record.targetUserMessageId) === record.operationId) {
      claims.delete(record.targetUserMessageId)
      if (claims.size === 0) this.targetClaimsBySession.delete(record.sessionId)
    }
  }

  private validateClaimReleaseReason(
    operationId: string,
    destructiveBoundaryCrossed: boolean,
    reason: ReplaceUserTurnFailureOptions['claimReleaseReason'],
  ): void {
    if (!reason) return
    if (reason === 'pre_destructive' && destructiveBoundaryCrossed) {
      throw new ReplaceUserTurnOperationRegistryError(
        'REPLACE_INVALID_CLAIM_RELEASE',
        `Cannot release replace operation ${operationId} as pre-destructive after crossing the destructive boundary`,
      )
    }
    if (reason === 'rollback_confirmed' && !destructiveBoundaryCrossed) {
      throw new ReplaceUserTurnOperationRegistryError(
        'REPLACE_INVALID_CLAIM_RELEASE',
        `Cannot release replace operation ${operationId} as rollback-confirmed before crossing the destructive boundary`,
      )
    }
  }

  private cleanupSession(sessionId: string): void {
    const records = this.recordsBySession.get(sessionId)
    if (!records) return
    const now = this.clock()
    const terminal = [...records.values()]
      .filter(record => TERMINAL_STATES.has(record.state))
      .sort((left, right) => (
        (left.terminalAtMs ?? left.updatedAtMs) - (right.terminalAtMs ?? right.updatedAtMs) ||
        left.createdAtMs - right.createdAtMs ||
        left.operationId.localeCompare(right.operationId)
      ))

    const expired = terminal.filter(record => (
      now - (record.terminalAtMs ?? record.updatedAtMs) >= this.terminalTtlMs
    ))
    const expiredIds = new Set(expired.map(record => record.operationId))
    const retained = terminal.filter(record => !expiredIds.has(record.operationId))
    const excessCount = Math.max(0, retained.length - this.maxTerminalRecordsPerSession)
    const evicted = [...expired, ...retained.slice(0, excessCount)]

    for (const record of evicted) {
      if (records.get(record.operationId) !== record) continue
      records.delete(record.operationId)
      this.releaseTargetClaim(record)
    }
    if (records.size === 0) this.recordsBySession.delete(sessionId)
  }
}

export const replaceUserTurnOperationRegistry = new ReplaceUserTurnOperationRegistry()
