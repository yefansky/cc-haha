export type UserDecisionResponse =
  | {
      kind: 'answer'
      answers: Readonly<Record<string, string>>
    }
  | {
      kind: 'clarify'
      message: string
    }

export type UserDecisionSemanticState =
  | { status: 'open' }
  | { status: 'answered' }
  | { status: 'superseded'; supersededById: string }
  | { status: 'cancelled'; reason: string }

export type RuntimeBinding =
  | { status: 'attached'; requestId: string }
  | { status: 'detached' }

export type DeliveryFailure = {
  code: string
  message: string
}

export type DeliveryRoute =
  | { status: 'runtime_callback'; requestId: string }
  | { status: 'recovery_turn' }

export type DeliveryAttempt =
  | { status: 'idle' }
  | {
      status: 'sending'
      attemptId: string
      route: DeliveryRoute
    }
  | {
      status: 'retryable_failed'
      attemptId: string
      route: DeliveryRoute
      error: DeliveryFailure
    }
  | {
      status: 'accepted'
      attemptId: string
      route: DeliveryRoute
    }
  | {
      status: 'indeterminate'
      attemptId: string
      route: DeliveryRoute
    }

export type UserDecision = {
  decisionId: string
  response: UserDecisionResponse | null
  semanticState: UserDecisionSemanticState
  runtimeBinding: RuntimeBinding
  deliveryAttempt: DeliveryAttempt
  usedAttemptIds: readonly string[]
}

export type SubmissionRoute =
  | DeliveryRoute
  | {
      status: 'unavailable'
      decisionStatus: Exclude<UserDecisionSemanticState['status'], 'open'>
    }

export function createUserDecision(input: {
  decisionId: string
  requestId?: string
}): UserDecision {
  return {
    decisionId: input.decisionId,
    response: null,
    semanticState: { status: 'open' },
    runtimeBinding: input.requestId
      ? { status: 'attached', requestId: input.requestId }
      : { status: 'detached' },
    deliveryAttempt: { status: 'idle' },
    usedAttemptIds: [],
  }
}

export function selectSubmissionRoute(decision: UserDecision): SubmissionRoute {
  if (decision.semanticState.status !== 'open') {
    return {
      status: 'unavailable',
      decisionStatus: decision.semanticState.status,
    }
  }
  if (decision.runtimeBinding.status === 'attached') {
    return {
      status: 'runtime_callback',
      requestId: decision.runtimeBinding.requestId,
    }
  }
  return { status: 'recovery_turn' }
}

export function detachRuntime(decision: UserDecision): UserDecision {
  if (decision.runtimeBinding.status === 'detached') return decision
  return { ...decision, runtimeBinding: { status: 'detached' } }
}

export function attachRuntime(decision: UserDecision, requestId: string): UserDecision {
  if (
    decision.runtimeBinding.status === 'attached' &&
    decision.runtimeBinding.requestId === requestId
  ) {
    return decision
  }
  return { ...decision, runtimeBinding: { status: 'attached', requestId } }
}

export function startDeliveryAttempt(
  decision: UserDecision,
  attemptId: string,
  response: UserDecisionResponse,
): UserDecision {
  assertOpen(decision)
  if (
    decision.deliveryAttempt.status !== 'idle' &&
    decision.deliveryAttempt.status !== 'retryable_failed'
  ) {
    throw new Error(`Cannot submit while delivery is ${decision.deliveryAttempt.status}`)
  }
  if (decision.usedAttemptIds.includes(attemptId)) {
    throw new Error(`Cannot reuse delivery attempt ${attemptId}`)
  }
  if (decision.response && !responsesEqual(decision.response, response)) {
    throw new Error('Cannot change a recorded decision response during retry')
  }
  const route: DeliveryRoute = decision.runtimeBinding.status === 'attached'
    ? { status: 'runtime_callback', requestId: decision.runtimeBinding.requestId }
    : { status: 'recovery_turn' }
  return {
    ...decision,
    response: decision.response ?? response,
    deliveryAttempt: { status: 'sending', attemptId, route },
    usedAttemptIds: [...decision.usedAttemptIds, attemptId],
  }
}

export function failDeliveryAttempt(
  decision: UserDecision,
  attemptId: string,
  error: DeliveryFailure,
): UserDecision {
  if (decision.semanticState.status !== 'open') return decision
  const current = decision.deliveryAttempt
  if (current.status !== 'sending' || current.attemptId !== attemptId) return decision
  return {
    ...decision,
    deliveryAttempt: {
      status: 'retryable_failed',
      attemptId,
      route: current.route,
      error,
    },
  }
}

export function acceptDeliveryAttempt(
  decision: UserDecision,
  attemptId: string,
): UserDecision {
  if (decision.semanticState.status !== 'open') return decision
  const current = decision.deliveryAttempt
  if (current.status !== 'sending' || current.attemptId !== attemptId) return decision
  return {
    ...decision,
    deliveryAttempt: {
      status: 'accepted',
      attemptId,
      route: current.route,
    },
  }
}

export function markDeliveryAttemptIndeterminate(
  decision: UserDecision,
  attemptId: string,
): UserDecision {
  if (decision.semanticState.status !== 'open') return decision
  const current = decision.deliveryAttempt
  if (current.status !== 'sending' || current.attemptId !== attemptId) return decision
  return {
    ...decision,
    deliveryAttempt: {
      status: 'indeterminate',
      attemptId,
      route: current.route,
    },
  }
}

export function markDecisionAnswered(
  decision: UserDecision,
  response: UserDecisionResponse | null,
): UserDecision {
  if (decision.semanticState.status !== 'open') return decision
  if (decision.response && response && !responsesEqual(decision.response, response)) {
    throw new Error('Answered response does not match the recorded decision response')
  }
  return {
    ...decision,
    response: decision.response ?? response,
    semanticState: { status: 'answered' },
  }
}

export function supersedeDecision(
  decision: UserDecision,
  supersededById: string,
): UserDecision {
  if (decision.semanticState.status !== 'open') return decision
  return {
    ...decision,
    semanticState: { status: 'superseded', supersededById },
  }
}

export function cancelDecision(decision: UserDecision, reason: string): UserDecision {
  if (decision.semanticState.status !== 'open') return decision
  return {
    ...decision,
    semanticState: { status: 'cancelled', reason },
  }
}

function assertOpen(decision: UserDecision): void {
  if (decision.semanticState.status !== 'open') {
    throw new Error(`Cannot submit ${decision.semanticState.status} decision`)
  }
}

function responsesEqual(left: UserDecisionResponse, right: UserDecisionResponse): boolean {
  if (left.kind !== right.kind) return false
  if (left.kind === 'clarify' && right.kind === 'clarify') {
    return left.message === right.message
  }
  if (left.kind !== 'answer' || right.kind !== 'answer') return false
  const leftEntries = Object.entries(left.answers)
  const rightEntries = Object.entries(right.answers)
  return leftEntries.length === rightEntries.length && leftEntries.every(
    ([question, value]) => right.answers[question] === value,
  )
}
