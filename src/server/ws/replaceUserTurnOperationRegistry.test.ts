import { describe, expect, it } from 'bun:test'
import type {
  ReplaceUserTurnError,
  ReplaceUserTurnRequest,
} from './events.js'
import {
  ReplaceUserTurnOperationRegistry,
  ReplaceUserTurnOperationRegistryError,
  fingerprintReplaceUserTurnRequest,
} from './replaceUserTurnOperationRegistry.js'

const SESSION_A = 'session-a'
const SESSION_B = 'session-b'

function createClock(initial = 1_000) {
  let current = initial
  return {
    clock: () => current,
    advance: (milliseconds: number) => {
      current += milliseconds
    },
  }
}

function request(
  operationId: string,
  overrides: Partial<ReplaceUserTurnRequest> = {},
): ReplaceUserTurnRequest {
  return {
    type: 'replace_user_turn',
    operationId,
    targetUserMessageId: 'target-user-message',
    expectedLatestUserMessageId: 'latest-user-message',
    expectedContent: 'original user content',
    replacementMessageUuid: `replacement-${operationId}`,
    content: 'replacement user content',
    attachments: [],
    ...overrides,
  }
}

function accept(
  registry: ReplaceUserTurnOperationRegistry,
  sessionId: string,
  input: ReplaceUserTurnRequest,
) {
  return registry.accept(sessionId, {
    operationId: input.operationId,
    targetUserMessageId: input.targetUserMessageId,
    expectedLatestUserMessageId: input.expectedLatestUserMessageId,
    replacementMessageUuid: input.replacementMessageUuid,
    requestFingerprint: fingerprintReplaceUserTurnRequest(input),
  })
}

function expectRecord(
  outcome: ReturnType<ReplaceUserTurnOperationRegistry['accept']>,
) {
  if (outcome.kind === 'rejected') {
    throw new Error(`expected operation record, received ${outcome.code}`)
  }
  return outcome.record
}

function expectRejected(
  outcome: ReturnType<ReplaceUserTurnOperationRegistry['accept']>,
) {
  if (outcome.kind !== 'rejected') {
    throw new Error(`expected rejection, received ${outcome.kind}`)
  }
  return outcome
}

function expectRegistryErrorCode(
  action: () => unknown,
  code: string,
): void {
  let thrown: unknown
  try {
    action()
  } catch (error) {
    thrown = error
  }
  expect(thrown).toBeInstanceOf(ReplaceUserTurnOperationRegistryError)
  expect((thrown as ReplaceUserTurnOperationRegistryError).code).toBe(code)
}

const preDestructiveFailure: ReplaceUserTurnError = {
  code: 'PRECONDITION_FAILED',
  message: 'The transcript changed before replacement started.',
  retryable: false,
  newOperationRequired: true,
}

describe('ReplaceUserTurnOperationRegistry', () => {
  it('coalesces the same operation and fingerprint onto the existing record', () => {
    const registry = new ReplaceUserTurnOperationRegistry()
    const input = request('operation-1')

    const first = accept(registry, SESSION_A, input)
    const second = accept(registry, SESSION_A, { ...input })

    expect(first.kind).toBe('accepted')
    expect(second.kind).toBe('existing')
    expect(expectRecord(second)).toEqual(expectRecord(first))
    expect(registry.get(SESSION_A, input.operationId)).toEqual(expectRecord(first))
  })

  it('stably rejects operation id reuse with a different fingerprint', () => {
    const registry = new ReplaceUserTurnOperationRegistry()
    const original = request('operation-1')
    const originalRecord = expectRecord(accept(registry, SESSION_A, original))

    const changed = request('operation-1', { content: 'different replacement content' })
    const firstReuse = expectRejected(accept(registry, SESSION_A, changed))
    const repeatedReuse = expectRejected(accept(registry, SESSION_A, changed))

    expect(firstReuse.code).toBe('REPLACE_OPERATION_ID_REUSED')
    expect(repeatedReuse.code).toBe('REPLACE_OPERATION_ID_REUSED')
    expect(repeatedReuse.record).toEqual(firstReuse.record)
    expect(registry.get(SESSION_A, original.operationId)).toEqual(originalRecord)
  })

  it('gives one operation the target claim and replays a stable conflict for another operation', () => {
    const registry = new ReplaceUserTurnOperationRegistry()
    const winner = request('winner')
    const conflicting = request('conflicting', {
      replacementMessageUuid: 'replacement-conflicting',
    })

    expect(accept(registry, SESSION_A, winner).kind).toBe('accepted')
    const firstConflict = expectRejected(accept(registry, SESSION_A, conflicting))
    expect(firstConflict.code).toBe('REPLACE_TARGET_CONFLICT')

    registry.markFailed(
      SESSION_A,
      winner.operationId,
      preDestructiveFailure,
      { destructiveBoundaryCrossed: false, claimReleaseReason: 'pre_destructive' },
    )

    const replayedConflict = accept(registry, SESSION_A, conflicting)
    expect(replayedConflict.kind).toBe('existing')
    const replayedRecord = expectRecord(replayedConflict)
    expect(replayedRecord).toEqual(firstConflict.record)
    expect(replayedRecord.state).toBe('failed')
    expect(replayedRecord.error?.code).toBe('REPLACE_TARGET_CONFLICT')
  })

  it('admits only one active operation per session, while sessions remain independent', () => {
    const registry = new ReplaceUserTurnOperationRegistry()
    const first = request('operation-a', { targetUserMessageId: 'target-a' })
    const sameSession = request('operation-b', { targetUserMessageId: 'target-b' })
    const otherSession = request('operation-c', { targetUserMessageId: 'target-c' })

    expect(accept(registry, SESSION_A, first).kind).toBe('accepted')
    const blocked = expectRejected(accept(registry, SESSION_A, sameSession))
    expect(blocked.code).toBe('REPLACE_SESSION_BUSY')
    expect(registry.hasActiveSessionOperation(SESSION_A)).toBe(true)

    expect(accept(registry, SESSION_B, otherSession).kind).toBe('accepted')
    expect(registry.hasActiveSessionOperation(SESSION_B)).toBe(true)
  })

  it('supports the legal queued to running to admitted to committed lifecycle', () => {
    const clock = createClock()
    const registry = new ReplaceUserTurnOperationRegistry({ clock: clock.clock })
    const input = request('operation-1')

    expect(expectRecord(accept(registry, SESSION_A, input)).state).toBe('queued')
    clock.advance(1)
    expect(registry.markRunning(SESSION_A, input.operationId).state).toBe('running')
    clock.advance(1)
    expect(registry.markAdmitted(SESSION_A, input.operationId, { messagesRemoved: 2 }).state)
      .toBe('admitted')
    clock.advance(1)
    const committed = registry.markCommitted(SESSION_A, input.operationId)
    expect(committed.state).toBe('committed')
    expect(committed.result).toEqual({ messagesRemoved: 2 })
    expect(committed.updatedAtMs).toBe(clock.clock())
    expect(registry.hasActiveSessionOperation(SESSION_A)).toBe(false)
  })

  it('releases a target after a pre-destructive failure', () => {
    const registry = new ReplaceUserTurnOperationRegistry()
    const failed = request('failed-operation')
    const retry = request('new-operation')

    expect(accept(registry, SESSION_A, failed).kind).toBe('accepted')
    registry.markFailed(
      SESSION_A,
      failed.operationId,
      preDestructiveFailure,
      { destructiveBoundaryCrossed: false, claimReleaseReason: 'pre_destructive' },
    )

    expect(accept(registry, SESSION_A, retry).kind).toBe('accepted')
  })

  it('atomically rejects rollback-confirmed release before the destructive boundary', () => {
    const registry = new ReplaceUserTurnOperationRegistry()
    const failed = request('invalid-early-rollback')
    expect(accept(registry, SESSION_A, failed).kind).toBe('accepted')
    const beforeFailure = registry.get(SESSION_A, failed.operationId)

    expectRegistryErrorCode(
      () => registry.markFailed(
        SESSION_A,
        failed.operationId,
        preDestructiveFailure,
        { claimReleaseReason: 'rollback_confirmed' },
      ),
      'REPLACE_INVALID_CLAIM_RELEASE',
    )

    expect(registry.get(SESSION_A, failed.operationId)).toEqual(beforeFailure)
    expect(registry.get(SESSION_A, failed.operationId)?.state).toBe('queued')
    expect(registry.hasActiveSessionOperation(SESSION_A)).toBe(true)
    const sameTarget = request('blocked-after-invalid-early-rollback')
    expect(expectRejected(accept(registry, SESSION_A, sameTarget)).code)
      .toBe('REPLACE_TARGET_CONFLICT')
  })

  it('atomically rejects a pre-destructive release after entering trimmed', () => {
    const registry = new ReplaceUserTurnOperationRegistry()
    const failed = request('invalid-late-pre-destructive')
    expect(accept(registry, SESSION_A, failed).kind).toBe('accepted')
    registry.markRunning(SESSION_A, failed.operationId)
    registry.markPhase(SESSION_A, failed.operationId, 'trimmed', {
      destructiveBoundaryCrossed: true,
    })
    const beforeFailure = registry.get(SESSION_A, failed.operationId)

    expectRegistryErrorCode(
      () => registry.markFailed(
        SESSION_A,
        failed.operationId,
        preDestructiveFailure,
        { claimReleaseReason: 'pre_destructive' },
      ),
      'REPLACE_INVALID_CLAIM_RELEASE',
    )

    expect(registry.get(SESSION_A, failed.operationId)).toEqual(beforeFailure)
    expect(registry.get(SESSION_A, failed.operationId)?.state).toBe('running')
    expect(registry.hasActiveSessionOperation(SESSION_A)).toBe(true)
    const sameTarget = request('blocked-after-invalid-late-release')
    expect(expectRejected(accept(registry, SESSION_A, sameTarget)).code)
      .toBe('REPLACE_TARGET_CONFLICT')
  })

  it('refuses a late pre-destructive claim release after destructive failure', () => {
    const registry = new ReplaceUserTurnOperationRegistry()
    const failed = request('destructive-failure')
    expect(accept(registry, SESSION_A, failed).kind).toBe('accepted')
    registry.markRunning(SESSION_A, failed.operationId)
    registry.markPhase(SESSION_A, failed.operationId, 'trimmed', {
      destructiveBoundaryCrossed: true,
    })
    registry.markFailed(
      SESSION_A,
      failed.operationId,
      preDestructiveFailure,
      { destructiveBoundaryCrossed: true },
    )

    expect(() => registry.markFailed(
      SESSION_A,
      failed.operationId,
      preDestructiveFailure,
      { claimReleaseReason: 'pre_destructive' },
    )).toThrow()
    expect(() => registry.markFailed(
      SESSION_A,
      failed.operationId,
      preDestructiveFailure,
      { claimReleaseReason: 'rollback_confirmed' },
    )).toThrow()

    const sameTarget = request('blocked-after-destructive-failure')
    const conflict = expectRejected(accept(registry, SESSION_A, sameTarget))
    expect(conflict.code).toBe('REPLACE_TARGET_CONFLICT')
  })

  it('releases a destructive failure claim only after rollback is confirmed', () => {
    const registry = new ReplaceUserTurnOperationRegistry()
    const failed = request('rolled-back-failure')
    expect(accept(registry, SESSION_A, failed).kind).toBe('accepted')
    registry.markRunning(SESSION_A, failed.operationId)
    registry.markPhase(SESSION_A, failed.operationId, 'trimmed', {
      destructiveBoundaryCrossed: true,
    })
    const failedSnapshot = registry.markFailed(
      SESSION_A,
      failed.operationId,
      preDestructiveFailure,
      {
        destructiveBoundaryCrossed: true,
        claimReleaseReason: 'rollback_confirmed',
      },
    )

    const retry = request('retry-after-confirmed-rollback')
    expect(accept(registry, SESSION_A, retry).kind).toBe('accepted')
    const replayedFailure = registry.markFailed(
      SESSION_A,
      failed.operationId,
      preDestructiveFailure,
      { claimReleaseReason: 'rollback_confirmed' },
    )
    expect(replayedFailure).toEqual(failedSnapshot)
    expect(registry.hasActiveSessionOperation(SESSION_A)).toBe(true)
    const third = request('blocked-by-retry-owner')
    expect(expectRejected(accept(registry, SESSION_A, third)).code)
      .toBe('REPLACE_TARGET_CONFLICT')
  })

  it('retains indeterminate records and their target claims across TTL and capacity cleanup', () => {
    const clock = createClock()
    const registry = new ReplaceUserTurnOperationRegistry({
      clock: clock.clock,
      terminalTtlMs: 10,
      maxTerminalRecordsPerSession: 0,
    })
    const unknown = request('indeterminate-operation')
    expect(accept(registry, SESSION_A, unknown).kind).toBe('accepted')
    registry.markRunning(SESSION_A, unknown.operationId)
    registry.markPhase(SESSION_A, unknown.operationId, 'trimmed', {
      destructiveBoundaryCrossed: true,
    })
    registry.markIndeterminate(
      SESSION_A,
      unknown.operationId,
      {
        code: 'OUTCOME_UNKNOWN',
        message: 'The replacement outcome could not be proven.',
        retryable: false,
        newOperationRequired: false,
      },
      { destructiveBoundaryCrossed: true },
    )

    clock.advance(20)
    const sameTarget = request('same-target-after-unknown')
    const conflict = expectRejected(accept(registry, SESSION_A, sameTarget))
    expect(conflict.code).toBe('REPLACE_TARGET_CONFLICT')

    // The rejected conflict is terminal and forces the max=0 capacity cleanup
    // on this read. The indeterminate owner is neither TTL nor capacity eligible.
    expect(registry.get(SESSION_A, unknown.operationId)?.state).toBe('indeterminate')
    expect(registry.get(SESSION_A, sameTarget.operationId)).toBeUndefined()
  })

  it('expires committed and failed records after terminal TTL', () => {
    const clock = createClock()
    const registry = new ReplaceUserTurnOperationRegistry({
      clock: clock.clock,
      terminalTtlMs: 100,
    })
    const committed = request('committed')
    expect(accept(registry, SESSION_A, committed).kind).toBe('accepted')
    registry.markRunning(SESSION_A, committed.operationId)
    registry.markAdmitted(SESSION_A, committed.operationId)
    registry.markCommitted(SESSION_A, committed.operationId)

    const failed = request('failed', { targetUserMessageId: 'failed-target' })
    expect(accept(registry, SESSION_A, failed).kind).toBe('accepted')
    registry.markFailed(
      SESSION_A,
      failed.operationId,
      preDestructiveFailure,
      { destructiveBoundaryCrossed: false, claimReleaseReason: 'pre_destructive' },
    )

    clock.advance(101)
    expect(registry.get(SESSION_A, committed.operationId)).toBeUndefined()
    expect(registry.get(SESSION_A, failed.operationId)).toBeUndefined()
  })

  it('bounds terminal history per session by evicting the oldest terminal records', () => {
    const clock = createClock()
    const registry = new ReplaceUserTurnOperationRegistry({
      clock: clock.clock,
      terminalTtlMs: 10_000,
      maxTerminalRecordsPerSession: 2,
    })

    for (let index = 1; index <= 3; index += 1) {
      const input = request(`operation-${index}`, {
        targetUserMessageId: `target-${index}`,
        replacementMessageUuid: `replacement-${index}`,
      })
      expect(accept(registry, SESSION_A, input).kind).toBe('accepted')
      registry.markFailed(
        SESSION_A,
        input.operationId,
        preDestructiveFailure,
        { destructiveBoundaryCrossed: false, claimReleaseReason: 'pre_destructive' },
      )
      clock.advance(1)
    }

    expect(registry.get(SESSION_A, 'operation-1')).toBeUndefined()
    expect(registry.get(SESSION_A, 'operation-2')?.state).toBe('failed')
    expect(registry.get(SESSION_A, 'operation-3')?.state).toBe('failed')
  })

  it('never evicts an active record to satisfy TTL or terminal capacity', () => {
    const clock = createClock()
    const registry = new ReplaceUserTurnOperationRegistry({
      clock: clock.clock,
      terminalTtlMs: 5,
      maxTerminalRecordsPerSession: 0,
    })
    const active = request('active', { targetUserMessageId: 'active-target' })
    expect(accept(registry, SESSION_A, active).kind).toBe('accepted')

    for (let index = 0; index < 3; index += 1) {
      clock.advance(10)
      const terminal = request(`other-session-${index}`, {
        targetUserMessageId: `other-target-${index}`,
      })
      expect(accept(registry, SESSION_B, terminal).kind).toBe('accepted')
      registry.markFailed(
        SESSION_B,
        terminal.operationId,
        preDestructiveFailure,
        { destructiveBoundaryCrossed: false, claimReleaseReason: 'pre_destructive' },
      )
    }

    expect(registry.get(SESSION_A, active.operationId)?.state).toBe('queued')
    expect(registry.hasActiveSessionOperation(SESSION_A)).toBe(true)
  })

  it('fingerprints content and attachments without retaining sensitive request payloads', () => {
    const registry = new ReplaceUserTurnOperationRegistry()
    const sensitive = request('operation-private', {
      expectedContent: 'EXPECTED-CONTENT-MUST-NOT-BE-STORED',
      content: 'REPLACEMENT-CONTENT-MUST-NOT-BE-STORED',
      attachments: [{
        type: 'image',
        name: 'private-image.png',
        data: 'BASE64-ATTACHMENT-MUST-NOT-BE-STORED',
        mimeType: 'image/png',
      }],
    })
    const same = { ...sensitive, attachments: sensitive.attachments?.map((item) => ({ ...item })) }
    const changedContent = { ...sensitive, content: 'changed replacement content' }
    const changedAttachment = {
      ...sensitive,
      attachments: sensitive.attachments?.map((item) => ({ ...item, data: 'different-base64' })),
    }

    const fingerprint = fingerprintReplaceUserTurnRequest(sensitive)
    expect(fingerprintReplaceUserTurnRequest(same)).toBe(fingerprint)
    expect(fingerprintReplaceUserTurnRequest(changedContent)).not.toBe(fingerprint)
    expect(fingerprintReplaceUserTurnRequest(changedAttachment)).not.toBe(fingerprint)

    const record = expectRecord(accept(registry, SESSION_A, sensitive))
    const snapshotJson = JSON.stringify(record)
    expect(snapshotJson).not.toContain('requestFingerprint')
    expect(snapshotJson).not.toContain(sensitive.content)
    expect(snapshotJson).not.toContain(sensitive.expectedContent)
    expect(snapshotJson).not.toContain(sensitive.attachments?.[0]?.data ?? '')
    expect(snapshotJson).not.toContain('private-image.png')
  })
})
