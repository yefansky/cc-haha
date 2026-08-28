import { describe, expect, it } from 'bun:test'
import {
  acceptDeliveryAttempt,
  attachRuntime,
  cancelDecision,
  createUserDecision,
  detachRuntime,
  failDeliveryAttempt,
  markDecisionAnswered,
  selectSubmissionRoute,
  startDeliveryAttempt,
  supersedeDecision,
  type UserDecisionResponse,
} from './userDecision.js'

const answer: UserDecisionResponse = {
  kind: 'answer',
  answers: { 'Ship it?': 'Yes' },
}

const clarification: UserDecisionResponse = {
  kind: 'clarify',
  message: 'Discuss the rollout risk first',
}

describe('UserDecision', () => {
  it('routes an attached open decision to its runtime callback', () => {
    const decision = createUserDecision({
      decisionId: 'decision-1',
      requestId: 'request-1',
    })

    expect(decision).toEqual({
      decisionId: 'decision-1',
      response: null,
      semanticState: { status: 'open' },
      runtimeBinding: { status: 'attached', requestId: 'request-1' },
      deliveryAttempt: { status: 'idle' },
      usedAttemptIds: [],
    })
    expect(selectSubmissionRoute(decision)).toEqual({
      status: 'runtime_callback',
      requestId: 'request-1',
    })
  })

  it('detaches runtime recovery without closing the decision', () => {
    const attached = createUserDecision({
      decisionId: 'decision-2',
      requestId: 'request-2',
    })
    expect(attachRuntime(attached, 'request-2')).toBe(attached)

    const detached = detachRuntime(attached)

    expect(detached.semanticState).toEqual({ status: 'open' })
    expect(detached.runtimeBinding).toEqual({ status: 'detached' })
    expect(selectSubmissionRoute(detached)).toEqual({ status: 'recovery_turn' })
    expect(startDeliveryAttempt(detached, 'attempt-recovery', answer).deliveryAttempt).toEqual({
      status: 'sending',
      attemptId: 'attempt-recovery',
      route: { status: 'recovery_turn' },
    })

    const reattached = attachRuntime(detached, 'request-2b')
    expect(selectSubmissionRoute(reattached)).toEqual({
      status: 'runtime_callback',
      requestId: 'request-2b',
    })
  })

  it('freezes the submission route when a delivery attempt starts', () => {
    const sending = startDeliveryAttempt(
      createUserDecision({ decisionId: 'decision-route', requestId: 'request-route' }),
      'attempt-route',
      answer,
    )

    const detached = detachRuntime(sending)

    expect(detached.runtimeBinding).toEqual({ status: 'detached' })
    expect(detached.deliveryAttempt).toEqual({
      status: 'sending',
      attemptId: 'attempt-route',
      route: { status: 'runtime_callback', requestId: 'request-route' },
    })

    const recoverySending = startDeliveryAttempt(
      createUserDecision({ decisionId: 'decision-recovery-route' }),
      'attempt-recovery-route',
      answer,
    )
    expect(
      attachRuntime(recoverySending, 'request-attached-later').deliveryAttempt,
    ).toEqual({
      status: 'sending',
      attemptId: 'attempt-recovery-route',
      route: { status: 'recovery_turn' },
    })
  })

  it('keeps accepted delivery separate from a semantically answered decision', () => {
    const sending = startDeliveryAttempt(
      createUserDecision({ decisionId: 'decision-3', requestId: 'request-3' }),
      'attempt-1',
      answer,
    )

    const accepted = acceptDeliveryAttempt(sending, 'attempt-1')

    expect(accepted.deliveryAttempt).toEqual({
      status: 'accepted',
      attemptId: 'attempt-1',
      route: { status: 'runtime_callback', requestId: 'request-3' },
    })
    expect(accepted.response).toEqual(answer)
    expect(accepted.semanticState).toEqual({ status: 'open' })

    const answered = markDecisionAnswered(accepted, answer)
    expect(answered.semanticState).toEqual({ status: 'answered' })
    expect(answered.response).toEqual(answer)
    expect(answered.deliveryAttempt).toEqual(accepted.deliveryAttempt)
  })

  it('hydrates terminal evidence even when a historical response is unavailable', () => {
    const open = createUserDecision({ decisionId: 'decision-hydrated' })
    const answeredWithoutResponse = markDecisionAnswered(open, null)

    expect(answeredWithoutResponse.semanticState).toEqual({ status: 'answered' })
    expect(answeredWithoutResponse.response).toBeNull()

    const sending = startDeliveryAttempt(
      createUserDecision({ decisionId: 'decision-hydrated-recorded' }),
      'attempt-hydrated',
      answer,
    )
    const answeredWithRecordedResponse = markDecisionAnswered(sending, null)
    expect(answeredWithRecordedResponse.semanticState).toEqual({ status: 'answered' })
    expect(answeredWithRecordedResponse.response).toEqual(answer)
  })

  it('retains the structured response after a retryable delivery failure', () => {
    const sending = startDeliveryAttempt(
      createUserDecision({ decisionId: 'decision-4', requestId: 'request-4' }),
      'attempt-1',
      clarification,
    )

    const failed = failDeliveryAttempt(sending, 'attempt-1', {
      code: 'DELIVERY_FAILED',
      message: 'socket unavailable',
    })

    expect(failed.deliveryAttempt).toEqual({
      status: 'retryable_failed',
      attemptId: 'attempt-1',
      route: { status: 'runtime_callback', requestId: 'request-4' },
      error: {
        code: 'DELIVERY_FAILED',
        message: 'socket unavailable',
      },
    })
    expect(failed.response).toEqual(clarification)
  })

  it('allows a retry to replace the previous failed attempt', () => {
    const firstAttempt = startDeliveryAttempt(
      createUserDecision({ decisionId: 'decision-5', requestId: 'request-5' }),
      'attempt-1',
      answer,
    )
    const failed = failDeliveryAttempt(firstAttempt, 'attempt-1', {
      code: 'DELIVERY_FAILED',
      message: 'try again',
    })

    const retry = startDeliveryAttempt(failed, 'attempt-2', answer)

    expect(retry.deliveryAttempt).toEqual({
      status: 'sending',
      attemptId: 'attempt-2',
      route: { status: 'runtime_callback', requestId: 'request-5' },
    })
  })

  it('ignores stale results from an older delivery attempt', () => {
    const firstAttempt = startDeliveryAttempt(
      createUserDecision({ decisionId: 'decision-6', requestId: 'request-6' }),
      'attempt-1',
      answer,
    )
    const retry = startDeliveryAttempt(
      failDeliveryAttempt(firstAttempt, 'attempt-1', {
        code: 'DELIVERY_FAILED',
        message: 'try again',
      }),
      'attempt-2',
      answer,
    )

    expect(acceptDeliveryAttempt(retry, 'attempt-1')).toBe(retry)
    expect(failDeliveryAttempt(retry, 'attempt-1', {
      code: 'LATE_FAILURE',
      message: 'stale',
    })).toBe(retry)
    expect(retry.deliveryAttempt).toEqual({
      status: 'sending',
      attemptId: 'attempt-2',
      route: { status: 'runtime_callback', requestId: 'request-6' },
    })
  })

  it('makes answered, superseded, and cancelled decisions unavailable', () => {
    const open = createUserDecision({ decisionId: 'decision-7', requestId: 'request-7' })
    const terminalDecisions = [
      markDecisionAnswered(open, answer),
      supersedeDecision(open, 'decision-8'),
      cancelDecision(open, 'user_cancelled'),
    ]

    expect(terminalDecisions.map((decision) => decision.semanticState)).toEqual([
      { status: 'answered' },
      { status: 'superseded', supersededById: 'decision-8' },
      { status: 'cancelled', reason: 'user_cancelled' },
    ])
    for (const decision of terminalDecisions) {
      expect(selectSubmissionRoute(decision)).toEqual({
        status: 'unavailable',
        decisionStatus: decision.semanticState.status,
      })
      expect(() => startDeliveryAttempt(decision, 'attempt-terminal', answer)).toThrow(
        `Cannot submit ${decision.semanticState.status} decision`,
      )
    }

    expect(cancelDecision(terminalDecisions[0]!, 'late_cancel')).toBe(terminalDecisions[0])
    expect(markDecisionAnswered(terminalDecisions[1]!, answer)).toBe(terminalDecisions[1])
    expect(supersedeDecision(terminalDecisions[2]!, 'late_turn')).toBe(terminalDecisions[2])

    const answeredWhileSending = markDecisionAnswered(
      startDeliveryAttempt(open, 'attempt-before-terminal', answer),
      answer,
    )
    expect(acceptDeliveryAttempt(answeredWhileSending, 'attempt-before-terminal')).toBe(
      answeredWhileSending,
    )
    expect(failDeliveryAttempt(answeredWhileSending, 'attempt-before-terminal', {
      code: 'LATE_FAILURE',
      message: 'stale after terminal',
    })).toBe(answeredWhileSending)
  })

  it('keeps one immutable response and unique attempt ids across retries', () => {
    const firstAttempt = startDeliveryAttempt(
      createUserDecision({ decisionId: 'decision-immutable', requestId: 'request-immutable' }),
      'attempt-1',
      answer,
    )
    const failed = failDeliveryAttempt(firstAttempt, 'attempt-1', {
      code: 'DELIVERY_FAILED',
      message: 'try again',
    })

    expect(() => startDeliveryAttempt(failed, 'attempt-1', answer)).toThrow(
      'Cannot reuse delivery attempt attempt-1',
    )
    expect(() => startDeliveryAttempt(failed, 'attempt-2', clarification)).toThrow(
      'Cannot change a recorded decision response during retry',
    )

    const retry = startDeliveryAttempt(failed, 'attempt-2', answer)
    expect(retry.usedAttemptIds).toEqual(['attempt-1', 'attempt-2'])
    expect(() => markDecisionAnswered(retry, clarification)).toThrow(
      'Answered response does not match the recorded decision response',
    )
  })

  it('does not allow a sending or accepted attempt to be submitted again', () => {
    const sending = startDeliveryAttempt(
      createUserDecision({ decisionId: 'decision-8', requestId: 'request-8' }),
      'attempt-1',
      answer,
    )
    const accepted = acceptDeliveryAttempt(sending, 'attempt-1')

    expect(() => startDeliveryAttempt(sending, 'attempt-2', answer)).toThrow(
      'Cannot submit while delivery is sending',
    )
    expect(() => startDeliveryAttempt(accepted, 'attempt-2', answer)).toThrow(
      'Cannot submit while delivery is accepted',
    )
  })
})
