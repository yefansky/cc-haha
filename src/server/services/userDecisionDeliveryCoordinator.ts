import {
  acceptDeliveryAttempt,
  attachRuntime,
  createUserDecision,
  detachRuntime,
  failDeliveryAttempt,
  markDeliveryAttemptIndeterminate,
  startDeliveryAttempt,
  type DeliveryAttempt,
  type DeliveryFailure,
  type DeliveryRoute,
  type RuntimeBinding,
  type UserDecision,
  type UserDecisionResponse,
  type UserDecisionSemanticState,
} from '../userDecision.js'

const OVERSIZED_RETRYABLE_FAILURE: DeliveryFailure = Object.freeze({
  code: 'FAILURE_DETAIL_TOO_LARGE',
  message: 'Retryable failure detail exceeded the configured limit.',
})

export type UserDecisionDeliveryCoordinatorOptions = {
  capacity: number
  maxAttemptsPerDecision: number
  maxResponseBytes: number
  maxFailureBytes: number
}

/** Runtime-opaque authority for mutating one claimed attempt. */
export type UserDecisionDeliveryLease = Readonly<{
  sessionId: string
  decisionId: string
  attemptId: string
  generation: symbol
}>

export type UserDecisionDeliverySnapshot = Readonly<{
  response: UserDecisionResponse
  deliveryAttempt: DeliveryAttempt
  usedAttemptIds: readonly string[]
}>

export type UserDecisionDeliveryClaim = {
  sessionId: string
  decisionId: string
  attemptId: string
  response: UserDecisionResponse
  runtimeBinding: RuntimeBinding
}

type ClaimedDelivery = {
  delivery: UserDecisionDeliverySnapshot
  lease: UserDecisionDeliveryLease
}

export type UserDecisionDeliveryClaimResult =
  | {
      status: 'claimed'
      shouldDeliver: true
      delivery: UserDecisionDeliverySnapshot
      lease: UserDecisionDeliveryLease
    }
  | {
      status: 'replayed'
      shouldDeliver: false
      delivery: UserDecisionDeliverySnapshot
      lease: UserDecisionDeliveryLease
    }
  | {
      status: 'busy'
      shouldDeliver: false
      delivery: UserDecisionDeliverySnapshot
    }
  | {
      status: 'rejected'
      shouldDeliver: false
      code:
        | 'ATTEMPT_RESPONSE_MISMATCH'
        | 'RESPONSE_MISMATCH'
        | 'ATTEMPT_ALREADY_USED'
        | 'ATTEMPT_CAPACITY_EXHAUSTED'
        | 'RESPONSE_TOO_LARGE'
        | 'CAPACITY_EXHAUSTED'
      delivery?: UserDecisionDeliverySnapshot
    }

export type UserDecisionDeliveryTransitionResult =
  | { status: 'updated'; delivery: UserDecisionDeliverySnapshot }
  | { status: 'ignored'; reason: 'stale_lease'; delivery?: UserDecisionDeliverySnapshot }

/**
 * Process-local, bounded adapter around the R0 delivery state machine.
 *
 * This is not a semantic decision store or a durable operation registry. It
 * retains only a deeply frozen delivery slice. Authoritative semantic state and
 * runtime binding are supplied by the read model at the boundary of each claim.
 */
export class UserDecisionDeliveryCoordinator {
  private readonly deliveriesBySession = new Map<string, Map<string, ClaimedDelivery>>()
  private entryCount = 0

  constructor(private readonly options: UserDecisionDeliveryCoordinatorOptions) {
    assertPositiveInteger(options.capacity, 'capacity')
    assertPositiveInteger(options.maxAttemptsPerDecision, 'maxAttemptsPerDecision')
    assertPositiveInteger(options.maxResponseBytes, 'maxResponseBytes')
    assertPositiveInteger(options.maxFailureBytes, 'maxFailureBytes')
    if (options.maxFailureBytes < failureBytes(OVERSIZED_RETRYABLE_FAILURE)) {
      throw new Error('maxFailureBytes cannot hold the bounded fallback failure')
    }
  }

  claim(input: UserDecisionDeliveryClaim): UserDecisionDeliveryClaimResult {
    const response = freezeResponse(input.response)
    if (responseBytes(response) > this.options.maxResponseBytes) {
      return {
        status: 'rejected',
        shouldDeliver: false,
        code: 'RESPONSE_TOO_LARGE',
      }
    }

    const current = this.getEntry(input.sessionId, input.decisionId)
    if (!current) {
      if (this.entryCount >= this.options.capacity) {
        return {
          status: 'rejected',
          shouldDeliver: false,
          code: 'CAPACITY_EXHAUSTED',
        }
      }

      const decision = startDeliveryAttempt(
        applyRuntimeBinding(
          createUserDecision({ decisionId: input.decisionId }),
          input.runtimeBinding,
        ),
        input.attemptId,
        response,
      )
      const entry = createEntry(input, freezeDelivery(decision))
      this.set(input.sessionId, input.decisionId, entry)
      return claimedResult(entry)
    }

    const currentAttempt = current.delivery.deliveryAttempt
    if (
      currentAttempt.status !== 'idle' &&
      currentAttempt.attemptId === input.attemptId
    ) {
      if (!responsesEqual(current.delivery.response, response)) {
        return {
          status: 'rejected',
          shouldDeliver: false,
          code: 'ATTEMPT_RESPONSE_MISMATCH',
          delivery: current.delivery,
        }
      }
      return {
        status: 'replayed',
        shouldDeliver: false,
        delivery: current.delivery,
        lease: current.lease,
      }
    }

    if (
      currentAttempt.status === 'sending' ||
      currentAttempt.status === 'accepted' ||
      currentAttempt.status === 'indeterminate'
    ) {
      return {
        status: 'busy',
        shouldDeliver: false,
        delivery: current.delivery,
      }
    }

    if (!responsesEqual(current.delivery.response, response)) {
      return {
        status: 'rejected',
        shouldDeliver: false,
        code: 'RESPONSE_MISMATCH',
        delivery: current.delivery,
      }
    }

    if (current.delivery.usedAttemptIds.includes(input.attemptId)) {
      return {
        status: 'rejected',
        shouldDeliver: false,
        code: 'ATTEMPT_ALREADY_USED',
        delivery: current.delivery,
      }
    }

    if (current.delivery.usedAttemptIds.length >= this.options.maxAttemptsPerDecision) {
      return {
        status: 'rejected',
        shouldDeliver: false,
        code: 'ATTEMPT_CAPACITY_EXHAUSTED',
        delivery: current.delivery,
      }
    }

    const decision = startDeliveryAttempt(
      temporaryDecision(input.decisionId, current.delivery, input.runtimeBinding),
      input.attemptId,
      response,
    )
    const entry = createEntry(input, freezeDelivery(decision))
    this.set(input.sessionId, input.decisionId, entry)
    return claimedResult(entry)
  }

  /**
   * Records only a failure known to have happened before any side effect. An
   * unknown or timed-out transport outcome must use markIndeterminate() instead.
   * Oversized detail is replaced with one fixed, bounded retryable failure.
   */
  failRetryable(
    lease: UserDecisionDeliveryLease,
    error: DeliveryFailure,
  ): UserDecisionDeliveryTransitionResult {
    const current = this.currentEntryForLease(lease)
    if (!current) return { status: 'ignored', reason: 'stale_lease' }
    const incomingError = { code: error.code, message: error.message }
    const copiedError = failureBytes(incomingError) <= this.options.maxFailureBytes
      ? incomingError
      : OVERSIZED_RETRYABLE_FAILURE
    const decision = failDeliveryAttempt(
      temporaryDecision(
        lease.decisionId,
        current.delivery,
        bindingForDelivery(current.delivery),
      ),
      lease.attemptId,
      copiedError,
    )
    if (decision.deliveryAttempt === current.delivery.deliveryAttempt) {
      return {
        status: 'ignored',
        reason: 'stale_lease',
        delivery: current.delivery,
      }
    }
    current.delivery = freezeDelivery(decision)
    return { status: 'updated', delivery: current.delivery }
  }

  accept(lease: UserDecisionDeliveryLease): UserDecisionDeliveryTransitionResult {
    const current = this.currentEntryForLease(lease)
    if (!current) return { status: 'ignored', reason: 'stale_lease' }
    const decision = acceptDeliveryAttempt(
      temporaryDecision(
        lease.decisionId,
        current.delivery,
        bindingForDelivery(current.delivery),
      ),
      lease.attemptId,
    )
    if (decision.deliveryAttempt === current.delivery.deliveryAttempt) {
      return {
        status: 'ignored',
        reason: 'stale_lease',
        delivery: current.delivery,
      }
    }
    current.delivery = freezeDelivery(decision)
    return { status: 'updated', delivery: current.delivery }
  }

  /** Records an attempted delivery whose externally visible outcome is unknown. */
  markIndeterminate(
    lease: UserDecisionDeliveryLease,
  ): UserDecisionDeliveryTransitionResult {
    const current = this.currentEntryForLease(lease)
    if (!current) return { status: 'ignored', reason: 'stale_lease' }
    const decision = markDeliveryAttemptIndeterminate(
      temporaryDecision(
        lease.decisionId,
        current.delivery,
        bindingForDelivery(current.delivery),
      ),
      lease.attemptId,
    )
    if (decision.deliveryAttempt === current.delivery.deliveryAttempt) {
      return {
        status: 'ignored',
        reason: 'stale_lease',
        delivery: current.delivery,
      }
    }
    current.delivery = freezeDelivery(decision)
    return { status: 'updated', delivery: current.delivery }
  }

  get(sessionId: string, decisionId: string): UserDecisionDeliverySnapshot | undefined {
    return this.getEntry(sessionId, decisionId)?.delivery
  }

  reconcileTerminal(
    sessionId: string,
    decisionId: string,
    semanticState: UserDecisionSemanticState,
  ): boolean {
    if (
      semanticState.status !== 'answered' &&
      semanticState.status !== 'cancelled' &&
      semanticState.status !== 'superseded'
    ) {
      return false
    }
    return this.deleteEntry(sessionId, decisionId)
  }

  /** Only for permanent session deletion or deterministic test reset. */
  clearPermanentlyDeletedSession(sessionId: string): number {
    const sessionDeliveries = this.deliveriesBySession.get(sessionId)
    if (!sessionDeliveries) return 0
    const released = sessionDeliveries.size
    this.deliveriesBySession.delete(sessionId)
    this.entryCount -= released
    return released
  }

  size(): number {
    return this.entryCount
  }

  private currentEntryForLease(
    lease: UserDecisionDeliveryLease,
  ): ClaimedDelivery | undefined {
    const current = this.getEntry(lease.sessionId, lease.decisionId)
    return current?.lease.generation === lease.generation &&
        current.lease.attemptId === lease.attemptId
      ? current
      : undefined
  }

  private getEntry(sessionId: string, decisionId: string): ClaimedDelivery | undefined {
    return this.deliveriesBySession.get(sessionId)?.get(decisionId)
  }

  private set(sessionId: string, decisionId: string, entry: ClaimedDelivery): void {
    let sessionDeliveries = this.deliveriesBySession.get(sessionId)
    if (!sessionDeliveries) {
      sessionDeliveries = new Map<string, ClaimedDelivery>()
      this.deliveriesBySession.set(sessionId, sessionDeliveries)
    }
    if (!sessionDeliveries.has(decisionId)) this.entryCount += 1
    sessionDeliveries.set(decisionId, entry)
  }

  private deleteEntry(sessionId: string, decisionId: string): boolean {
    const sessionDeliveries = this.deliveriesBySession.get(sessionId)
    if (!sessionDeliveries?.delete(decisionId)) return false
    this.entryCount -= 1
    if (sessionDeliveries.size === 0) this.deliveriesBySession.delete(sessionId)
    return true
  }
}

function createEntry(
  input: Pick<UserDecisionDeliveryClaim, 'sessionId' | 'decisionId' | 'attemptId'>,
  delivery: UserDecisionDeliverySnapshot,
): ClaimedDelivery {
  return {
    delivery,
    lease: Object.freeze({
      sessionId: input.sessionId,
      decisionId: input.decisionId,
      attemptId: input.attemptId,
      generation: Symbol('user-decision-delivery-generation'),
    }),
  }
}

function claimedResult(entry: ClaimedDelivery): UserDecisionDeliveryClaimResult {
  return {
    status: 'claimed',
    shouldDeliver: true,
    delivery: entry.delivery,
    lease: entry.lease,
  }
}

function temporaryDecision(
  decisionId: string,
  delivery: UserDecisionDeliverySnapshot,
  runtimeBinding: RuntimeBinding,
): UserDecision {
  return {
    decisionId,
    response: delivery.response,
    semanticState: { status: 'open' },
    runtimeBinding,
    deliveryAttempt: delivery.deliveryAttempt,
    usedAttemptIds: delivery.usedAttemptIds,
  }
}

function applyRuntimeBinding(
  decision: UserDecision,
  binding: RuntimeBinding,
): UserDecision {
  return binding.status === 'attached'
    ? attachRuntime(decision, binding.requestId)
    : detachRuntime(decision)
}

function bindingForDelivery(delivery: UserDecisionDeliverySnapshot): RuntimeBinding {
  const attempt = delivery.deliveryAttempt
  if (attempt.status !== 'idle' && attempt.route.status === 'runtime_callback') {
    return { status: 'attached', requestId: attempt.route.requestId }
  }
  return { status: 'detached' }
}

function freezeDelivery(decision: UserDecision): UserDecisionDeliverySnapshot {
  return Object.freeze({
    response: freezeResponse(decision.response!),
    deliveryAttempt: freezeAttempt(decision.deliveryAttempt),
    usedAttemptIds: Object.freeze([...decision.usedAttemptIds]),
  })
}

function freezeResponse(response: UserDecisionResponse): UserDecisionResponse {
  return response.kind === 'answer'
    ? Object.freeze({
        kind: 'answer' as const,
        answers: Object.freeze({ ...response.answers }),
      })
    : Object.freeze({ kind: 'clarify' as const, message: response.message })
}

function freezeAttempt(attempt: DeliveryAttempt): DeliveryAttempt {
  if (attempt.status === 'idle') return Object.freeze({ status: 'idle' as const })
  const route = freezeRoute(attempt.route)
  if (attempt.status === 'retryable_failed') {
    return Object.freeze({
      status: 'retryable_failed' as const,
      attemptId: attempt.attemptId,
      route,
      error: Object.freeze({
        code: attempt.error.code,
        message: attempt.error.message,
      }),
    })
  }
  return Object.freeze({
    status: attempt.status,
    attemptId: attempt.attemptId,
    route,
  })
}

function freezeRoute(route: DeliveryRoute): DeliveryRoute {
  return route.status === 'runtime_callback'
    ? Object.freeze({ status: 'runtime_callback' as const, requestId: route.requestId })
    : Object.freeze({ status: 'recovery_turn' as const })
}

function responsesEqual(
  recorded: UserDecisionResponse,
  incoming: UserDecisionResponse,
): boolean {
  if (recorded.kind !== incoming.kind) return false
  if (recorded.kind === 'clarify' && incoming.kind === 'clarify') {
    return recorded.message === incoming.message
  }
  if (recorded.kind !== 'answer' || incoming.kind !== 'answer') return false
  const recordedAnswers = Object.entries(recorded.answers)
  const incomingAnswers = Object.entries(incoming.answers)
  return recordedAnswers.length === incomingAnswers.length && recordedAnswers.every(
    ([question, answer]) => incoming.answers[question] === answer,
  )
}

function responseBytes(response: UserDecisionResponse): number {
  return Buffer.byteLength(JSON.stringify(response), 'utf8')
}

function failureBytes(error: DeliveryFailure): number {
  return Buffer.byteLength(JSON.stringify(error), 'utf8')
}

function assertPositiveInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer`)
  }
}
