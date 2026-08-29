import { describe, expect, test } from 'bun:test'
import type { RuntimeBinding, UserDecisionResponse } from '../userDecision.js'
import {
  UserDecisionDeliveryCoordinator,
  type UserDecisionDeliveryLease,
} from './userDecisionDeliveryCoordinator.js'

const ANSWER: UserDecisionResponse = {
  kind: 'answer',
  answers: { 'Ship it?': 'Yes' },
}
const OTHER_ANSWER: UserDecisionResponse = {
  kind: 'answer',
  answers: { 'Ship it?': 'No' },
}
const ATTACHED: RuntimeBinding = {
  status: 'attached',
  requestId: 'request-1',
}
const DETACHED: RuntimeBinding = { status: 'detached' }

function coordinator(overrides: Partial<{
  capacity: number
  maxAttemptsPerDecision: number
  maxResponseBytes: number
  maxFailureBytes: number
}> = {}) {
  return new UserDecisionDeliveryCoordinator({
    capacity: 4,
    maxAttemptsPerDecision: 3,
    maxResponseBytes: 1_024,
    maxFailureBytes: 1_024,
    ...overrides,
  })
}

function claim(
  target: UserDecisionDeliveryCoordinator,
  input: Partial<Parameters<UserDecisionDeliveryCoordinator['claim']>[0]> = {},
) {
  return target.claim({
    sessionId: 'session-1',
    decisionId: 'ask-1',
    attemptId: 'attempt-1',
    response: ANSWER,
    runtimeBinding: ATTACHED,
    ...input,
  })
}

describe('UserDecisionDeliveryCoordinator', () => {
  test('claims once, replays the same attempt, and freezes its route', () => {
    const target = coordinator()
    const first = claim(target)
    const replay = claim(target, {
      response: { kind: 'answer', answers: { 'Ship it?': 'Yes' } },
      runtimeBinding: DETACHED,
    })

    expect(first).toMatchObject({
      status: 'claimed',
      shouldDeliver: true,
      delivery: {
        deliveryAttempt: {
          status: 'sending',
          route: { status: 'runtime_callback', requestId: 'request-1' },
        },
      },
    })
    expect(replay).toMatchObject({
      status: 'replayed',
      shouldDeliver: false,
      delivery: {
        deliveryAttempt: {
          route: { status: 'runtime_callback', requestId: 'request-1' },
        },
      },
    })
    if (first.status !== 'claimed' || replay.status !== 'replayed') {
      throw new Error('expected claimed delivery and replay')
    }
    expect(replay.lease).toBe(first.lease)
  })

  test('rejects a different response for the same attempt', () => {
    const target = coordinator()
    claim(target)

    expect(claim(target, { response: OTHER_ANSWER })).toMatchObject({
      status: 'rejected',
      shouldDeliver: false,
      code: 'ATTEMPT_RESPONSE_MISMATCH',
    })
  })

  test('keeps other attempts busy while sending, accepted, or indeterminate', () => {
    const holds: ReadonlyArray<{
      status: 'sending' | 'accepted' | 'indeterminate'
      transition: (
        target: UserDecisionDeliveryCoordinator,
        lease: UserDecisionDeliveryLease,
      ) => void
    }> = [
      { status: 'sending', transition: () => {} },
      {
        status: 'accepted',
        transition: (
          target: UserDecisionDeliveryCoordinator,
          lease: UserDecisionDeliveryLease,
        ) => {
          target.accept(lease)
        },
      },
      {
        status: 'indeterminate',
        transition: (
          target: UserDecisionDeliveryCoordinator,
          lease: UserDecisionDeliveryLease,
        ) => {
          target.markIndeterminate(lease)
        },
      },
    ]

    for (const hold of holds) {
      const target = coordinator()
      const first = claim(target, { runtimeBinding: DETACHED })
      if (first.status !== 'claimed') throw new Error('expected claim')
      hold.transition(target, first.lease)

      expect(claim(target)).toMatchObject({
        status: 'replayed',
        shouldDeliver: false,
        delivery: { deliveryAttempt: { status: hold.status } },
      })
      expect(claim(target, { attemptId: 'attempt-2' })).toMatchObject({
        status: 'busy',
        shouldDeliver: false,
        delivery: { deliveryAttempt: { status: hold.status } },
      })
    }
  })

  test('allows only the same response on a new attempt after retryable failure', () => {
    const target = coordinator()
    const first = claim(target)
    if (first.status !== 'claimed') throw new Error('expected claim')
    expect(target.failRetryable(first.lease, {
      code: 'DELIVERY_FAILED',
      message: 'socket closed',
    })).toMatchObject({
      status: 'updated',
      delivery: { deliveryAttempt: { status: 'retryable_failed' } },
    })

    expect(claim(target, {
      attemptId: 'attempt-2',
      response: OTHER_ANSWER,
    })).toMatchObject({ status: 'rejected', code: 'RESPONSE_MISMATCH' })
    expect(claim(target, {
      attemptId: 'attempt-2',
      runtimeBinding: DETACHED,
    })).toMatchObject({
      status: 'claimed',
      shouldDeliver: true,
      delivery: {
        deliveryAttempt: {
          status: 'sending',
          attemptId: 'attempt-2',
          route: { status: 'recovery_turn' },
        },
      },
    })
  })

  test('bounds used attempt ids without forgetting old ids', () => {
    const target = coordinator({ maxAttemptsPerDecision: 2 })
    const first = claim(target)
    if (first.status !== 'claimed') throw new Error('expected claim')
    target.failRetryable(first.lease, { code: 'FAILED', message: 'first failed' })
    const second = claim(target, { attemptId: 'attempt-2' })
    if (second.status !== 'claimed') throw new Error('expected retry claim')
    target.failRetryable(second.lease, { code: 'FAILED', message: 'second failed' })

    expect(claim(target, { attemptId: 'attempt-3' })).toMatchObject({
      status: 'rejected',
      code: 'ATTEMPT_CAPACITY_EXHAUSTED',
    })
    expect(claim(target)).toMatchObject({
      status: 'rejected',
      code: 'ATTEMPT_ALREADY_USED',
    })
    expect(target.get('session-1', 'ask-1')?.usedAttemptIds).toEqual([
      'attempt-1',
      'attempt-2',
    ])
  })

  test('stale leases cannot mutate a newer attempt', () => {
    const target = coordinator()
    const first = claim(target)
    if (first.status !== 'claimed') throw new Error('expected claim')
    target.failRetryable(first.lease, { code: 'FAILED', message: 'retry' })
    const second = claim(target, { attemptId: 'attempt-2' })
    if (second.status !== 'claimed') throw new Error('expected retry claim')

    expect(target.accept(first.lease)).toEqual({
      status: 'ignored',
      reason: 'stale_lease',
    })
    expect(target.failRetryable(first.lease, {
      code: 'LATE_FAILURE',
      message: 'must not overwrite attempt-2',
    })).toEqual({
      status: 'ignored',
      reason: 'stale_lease',
    })
    expect(target.markIndeterminate(first.lease)).toEqual({
      status: 'ignored',
      reason: 'stale_lease',
    })
    expect(target.get('session-1', 'ask-1')?.deliveryAttempt).toMatchObject({
      status: 'sending',
      attemptId: 'attempt-2',
    })
  })

  test('permanent session clearing fences callbacks from a later record', () => {
    const target = coordinator()
    const oldClaim = claim(target)
    if (oldClaim.status !== 'claimed') throw new Error('expected claim')
    expect(target.clearPermanentlyDeletedSession('session-1')).toBe(1)
    const newClaim = claim(target, { attemptId: 'attempt-2' })
    if (newClaim.status !== 'claimed') throw new Error('expected new claim')

    expect(target.accept(oldClaim.lease)).toEqual({
      status: 'ignored',
      reason: 'stale_lease',
    })
    expect(target.accept(newClaim.lease)).toMatchObject({ status: 'updated' })
  })

  test('only authoritative terminal semantic evidence removes a delivery', () => {
    const target = coordinator()
    const current = claim(target)
    if (current.status !== 'claimed') throw new Error('expected claim')
    target.accept(current.lease)

    expect(target.reconcileTerminal('session-1', 'ask-1', { status: 'open' })).toBe(false)
    expect(target.get('session-1', 'ask-1')?.deliveryAttempt.status).toBe('accepted')
    expect(target.reconcileTerminal('session-1', 'ask-1', { status: 'answered' })).toBe(true)
    expect(target.get('session-1', 'ask-1')).toBeUndefined()
  })

  test('accepts every explicit terminal semantic variant', () => {
    const terminalStates = [
      { status: 'answered' as const },
      { status: 'cancelled' as const, reason: 'session closed' },
      { status: 'superseded' as const, supersededById: 'ask-new' },
    ]
    for (const [index, semanticState] of terminalStates.entries()) {
      const target = coordinator()
      claim(target, { decisionId: `ask-${index}` })
      expect(target.reconcileTerminal('session-1', `ask-${index}`, semanticState)).toBe(true)
    }
  })

  test('returns deeply frozen delivery state so callers cannot bypass bounds', () => {
    const target = coordinator()
    const externalAnswers = { 'Ship it?': 'Yes' }
    const first = claim(target, {
      response: { kind: 'answer', answers: externalAnswers },
    })
    if (first.status !== 'claimed') throw new Error('expected claim')
    expect(first.delivery.deliveryAttempt.status).toBe('sending')
    if (first.delivery.deliveryAttempt.status === 'sending') {
      expect(Object.isFrozen(first.delivery.deliveryAttempt.route)).toBe(true)
    }
    externalAnswers['Ship it?'] = 'mutated outside'
    const externalError = { code: 'FAILED', message: 'immutable error' }
    target.failRetryable(first.lease, externalError)
    externalError.code = 'MUTATED'
    externalError.message = 'mutated outside'
    const delivery = target.get('session-1', 'ask-1')!

    expect(Object.isFrozen(delivery)).toBe(true)
    expect(Object.isFrozen(delivery.response)).toBe(true)
    expect(Object.isFrozen(delivery.usedAttemptIds)).toBe(true)
    expect(Object.isFrozen(delivery.deliveryAttempt)).toBe(true)
    if (delivery.response.kind === 'answer') {
      expect(Object.isFrozen(delivery.response.answers)).toBe(true)
    }
    if (delivery.deliveryAttempt.status === 'retryable_failed') {
      expect(Object.isFrozen(delivery.deliveryAttempt.route)).toBe(true)
      expect(Object.isFrozen(delivery.deliveryAttempt.error)).toBe(true)
      expect(delivery.deliveryAttempt.error).toEqual({
        code: 'FAILED',
        message: 'immutable error',
      })
    }
    expect(delivery.response).toEqual(ANSWER)
    expect(() => {
      ;(delivery.usedAttemptIds as string[]).push('forged-attempt')
    }).toThrow()
    expect(target.get('session-1', 'ask-1')?.usedAttemptIds).toEqual(['attempt-1'])
  })

  test('fails closed at entry capacity without evicting active or failed records', () => {
    const target = coordinator({ capacity: 1 })
    const retained = claim(target)
    if (retained.status !== 'claimed') throw new Error('expected claim')
    target.failRetryable(retained.lease, { code: 'FAILED', message: 'retain for retry' })

    expect(claim(target, {
      sessionId: 'session-new',
      decisionId: 'ask-new',
      attemptId: 'attempt-new',
      runtimeBinding: DETACHED,
    })).toEqual({
      status: 'rejected',
      shouldDeliver: false,
      code: 'CAPACITY_EXHAUSTED',
    })
    expect(target.get('session-1', 'ask-1')).toBeDefined()
  })

  test('does not evict an accepted hold when entry capacity is full', () => {
    const target = coordinator({ capacity: 1 })
    const retained = claim(target)
    if (retained.status !== 'claimed') throw new Error('expected claim')
    target.accept(retained.lease)

    expect(claim(target, {
      sessionId: 'session-new',
      decisionId: 'ask-new',
      attemptId: 'attempt-new',
    })).toEqual({
      status: 'rejected',
      shouldDeliver: false,
      code: 'CAPACITY_EXHAUSTED',
    })
    expect(target.get('session-1', 'ask-1')?.deliveryAttempt.status).toBe('accepted')
  })

  test('normalizes oversized retryable failure detail to a bounded record', () => {
    const target = coordinator({ maxFailureBytes: 128 })
    const current = claim(target)
    if (current.status !== 'claimed') throw new Error('expected claim')

    const result = target.failRetryable(current.lease, {
      code: 'x'.repeat(256),
      message: 'y'.repeat(256),
    })
    expect(result).toMatchObject({
      status: 'updated',
      delivery: {
        deliveryAttempt: {
          status: 'retryable_failed',
          error: {
            code: 'FAILURE_DETAIL_TOO_LARGE',
            message: 'Retryable failure detail exceeded the configured limit.',
          },
        },
      },
    })
    if (
      result.status !== 'updated' ||
      result.delivery.deliveryAttempt.status !== 'retryable_failed'
    ) {
      throw new Error('expected bounded retryable failure')
    }
    expect(Buffer.byteLength(
      JSON.stringify(result.delivery.deliveryAttempt.error),
      'utf8',
    )).toBeLessThanOrEqual(128)
  })

  test('rejects oversized responses so total retained response memory is bounded', () => {
    const target = coordinator({ maxResponseBytes: 64 })

    expect(claim(target, {
      response: { kind: 'clarify', message: 'x'.repeat(128) },
    })).toEqual({
      status: 'rejected',
      shouldDeliver: false,
      code: 'RESPONSE_TOO_LARGE',
    })
    expect(target.size()).toBe(0)
  })
})
