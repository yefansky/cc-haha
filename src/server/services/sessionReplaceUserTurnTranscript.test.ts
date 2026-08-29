import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { createHash, randomUUID } from 'node:crypto'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import {
  ReplaceUserTurnTranscriptError,
  SessionService,
  type PrepareReplaceUserTurnTranscriptInput,
} from './sessionService.js'

type TranscriptFixture = {
  sessionId: string
  transcriptPath: string
  transcriptDir: string
  firstUserId: string
  firstAssistantId: string
  targetUserId: string
  targetAssistantId: string
  prefixBeforeTarget: string
  raw: string
}

let configDir = ''
let service: SessionService
const WRITER_QUIESCENCE = 'runtime_stopped_and_session_mutation_slot_held' as const

beforeEach(async () => {
  configDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cc-haha-replace-turn-'))
  await fs.mkdir(path.join(configDir, 'projects'), { recursive: true })
  process.env.CLAUDE_CONFIG_DIR = configDir
  service = new SessionService()
})

afterEach(async () => {
  delete process.env.CLAUDE_CONFIG_DIR
  await fs.rm(configDir, { recursive: true, force: true })
})

function userEntry(
  sessionId: string,
  uuid: string,
  parentUuid: string | null,
  content: string,
): Record<string, unknown> {
  return {
    parentUuid,
    isSidechain: false,
    type: 'user',
    message: { role: 'user', content },
    uuid,
    timestamp: '2026-08-27T01:00:00.000Z',
    userType: 'external',
    cwd: '/tmp/replace-turn-test',
    sessionId,
  }
}

function assistantEntry(
  uuid: string,
  parentUuid: string,
  content: string,
): Record<string, unknown> {
  return {
    parentUuid,
    isSidechain: false,
    type: 'assistant',
    message: {
      model: 'test-model',
      id: `msg_${uuid.replace(/-/g, '').slice(0, 20)}`,
      type: 'message',
      role: 'assistant',
      content: [{ type: 'text', text: content }],
    },
    uuid,
    timestamp: '2026-08-27T01:00:01.000Z',
  }
}

async function writeTranscript(
  projectDir: string,
  sessionId: string,
  raw: string,
): Promise<{ transcriptDir: string; transcriptPath: string }> {
  const transcriptDir = path.join(configDir, 'projects', projectDir)
  const transcriptPath = path.join(transcriptDir, `${sessionId}.jsonl`)
  await fs.mkdir(transcriptDir, { recursive: true })
  await fs.writeFile(transcriptPath, raw, 'utf-8')
  return { transcriptDir, transcriptPath }
}

async function createFixture(
  projectDir = '-tmp-replace-turn-transaction',
  sessionId = randomUUID(),
): Promise<TranscriptFixture> {
  const firstUserId = randomUUID()
  const firstAssistantId = randomUUID()
  const targetUserId = randomUUID()
  const targetAssistantId = randomUUID()
  const lines = [
    '{ "type": "session-meta", "isMeta": true, "workDir": "/tmp/replace-turn-test" }',
    JSON.stringify(userEntry(sessionId, firstUserId, null, 'repeat this prompt')),
    JSON.stringify(assistantEntry(firstAssistantId, firstUserId, 'first reply')),
    '{ "type": "custom-metadata", "keep": "verbatim spacing" }',
    JSON.stringify(userEntry(
      sessionId,
      targetUserId,
      firstAssistantId,
      'repeat this prompt',
    )),
    JSON.stringify(assistantEntry(targetAssistantId, targetUserId, 'target reply')),
  ]
  const prefixBeforeTarget = `${lines.slice(0, 4).join('\r\n')}\r\n`
  const raw = `${lines.join('\r\n')}\r\n`
  const paths = await writeTranscript(projectDir, sessionId, raw)
  return {
    sessionId,
    ...paths,
    firstUserId,
    firstAssistantId,
    targetUserId,
    targetAssistantId,
    prefixBeforeTarget,
    raw,
  }
}

function prepareInput(
  fixture: TranscriptFixture,
  overrides: Partial<PrepareReplaceUserTurnTranscriptInput> = {},
): PrepareReplaceUserTurnTranscriptInput {
  return {
    sessionId: fixture.sessionId,
    operationId: randomUUID(),
    targetUserMessageId: fixture.targetUserId,
    expectedLatestUserMessageId: fixture.targetUserId,
    expectedContent: 'repeat this prompt',
    replacementMessageUuid: randomUUID(),
    writerQuiescence: WRITER_QUIESCENCE,
    ...overrides,
  }
}

async function replacementArtifacts(transcriptDir: string): Promise<string[]> {
  return (await fs.readdir(transcriptDir))
    .filter((name) => name.includes('.replace-turn-'))
    .sort()
}

async function expectReplaceError(
  promise: Promise<unknown>,
  code: ReplaceUserTurnTranscriptError['code'],
): Promise<ReplaceUserTurnTranscriptError> {
  try {
    await promise
  } catch (error) {
    expect(error).toBeInstanceOf(ReplaceUserTurnTranscriptError)
    expect((error as ReplaceUserTurnTranscriptError).code).toBe(code)
    return error as ReplaceUserTurnTranscriptError
  }
  throw new Error(`Expected ${code}`)
}

describe('replace-user-turn transcript transaction', () => {
  it('prepares the stable UUID target without changing transcript bytes or leaking content', async () => {
    const fixture = await createFixture()
    const input = prepareInput(fixture, {
      operationId: '11111111-2222-4333-8444-555555555555',
    })
    const prepared = await service.prepareReplaceUserTurnTranscript(input)

    expect(prepared).toMatchObject({
      sessionId: fixture.sessionId,
      operationId: input.operationId,
      targetUserMessageId: fixture.targetUserId,
      replacementMessageUuid: input.replacementMessageUuid,
      messagesRemoved: 2,
      state: 'prepared',
    })
    expect(await fs.readFile(fixture.transcriptPath, 'utf-8')).toBe(fixture.raw)

    const digest = createHash('sha256').update(input.operationId).digest('hex')
    const artifacts = await replacementArtifacts(fixture.transcriptDir)
    expect(artifacts).toEqual([
      `.${fixture.sessionId}.replace-turn-${digest}.backup`,
      `.${fixture.sessionId}.replace-turn-${digest}.marker`,
    ])
    const marker = await fs.readFile(path.join(fixture.transcriptDir, artifacts[1]!), 'utf-8')
    expect(marker).not.toContain('repeat this prompt')
    expect(marker).not.toContain('target reply')

    expect(await prepared.rollback()).toEqual({ state: 'not_applied', cleanupComplete: true })
  })

  it('rejects selector mismatches and malformed runtime assertions without artifacts', async () => {
    const cases: Array<{
      overrides: Partial<PrepareReplaceUserTurnTranscriptInput>
      code: ReplaceUserTurnTranscriptError['code']
    }> = [
      {
        overrides: { targetUserMessageId: randomUUID() },
        code: 'REPLACE_TRANSCRIPT_TARGET_NOT_FOUND',
      },
      {
        overrides: { expectedContent: 'stale prompt content' },
        code: 'REPLACE_TRANSCRIPT_CONTENT_MISMATCH',
      },
      {
        overrides: { expectedLatestUserMessageId: randomUUID() },
        code: 'REPLACE_TRANSCRIPT_LATEST_USER_MISMATCH',
      },
    ]

    for (const [index, testCase] of cases.entries()) {
      const fixture = await createFixture(`-tmp-replace-mismatch-${index}`)
      await expectReplaceError(
        service.prepareReplaceUserTurnTranscript(prepareInput(fixture, testCase.overrides)),
        testCase.code,
      )
      expect(await fs.readFile(fixture.transcriptPath, 'utf-8')).toBe(fixture.raw)
      expect(await replacementArtifacts(fixture.transcriptDir)).toEqual([])
    }

    const invalidFixture = await createFixture('-tmp-invalid-prepare-input')
    const validInput = prepareInput(invalidFixture)
    const prepareUnknown = service.prepareReplaceUserTurnTranscript.bind(service) as (
      input: unknown,
    ) => Promise<unknown>
    const invalidInputs: unknown[] = [
      { ...validInput, expectedContent: 42 },
      { ...validInput, writerQuiescence: { runtime: 'stopped' } },
      { ...validInput, writerQuiescence: 'runtime_stopped' },
      { ...validInput, operationId: 'not-a-uuid' },
    ]
    for (const invalidInput of invalidInputs) {
      await expectReplaceError(
        prepareUnknown(invalidInput),
        'REPLACE_TRANSCRIPT_INVALID_INPUT',
      )
      expect(await fs.readFile(invalidFixture.transcriptPath, 'utf-8'))
        .toBe(invalidFixture.raw)
      expect(await replacementArtifacts(invalidFixture.transcriptDir)).toEqual([])
    }
  })

  it('rejects duplicate transcript UUIDs and replacement UUID collisions without artifacts', async () => {
    const duplicateFixture = await createFixture('-tmp-duplicate-message-uuid')
    const duplicateLine = JSON.stringify(assistantEntry(
      duplicateFixture.targetAssistantId,
      duplicateFixture.targetUserId,
      'a second active message reusing the same UUID',
    ))
    await fs.appendFile(duplicateFixture.transcriptPath, `${duplicateLine}\n`)
    const duplicateRaw = await fs.readFile(duplicateFixture.transcriptPath, 'utf-8')
    await expectReplaceError(
      service.prepareReplaceUserTurnTranscript(prepareInput(duplicateFixture)),
      'REPLACE_TRANSCRIPT_UUID_CONFLICT',
    )
    expect(await fs.readFile(duplicateFixture.transcriptPath, 'utf-8')).toBe(duplicateRaw)
    expect(await replacementArtifacts(duplicateFixture.transcriptDir)).toEqual([])

    const replacementFixture = await createFixture('-tmp-replacement-uuid-collision')
    await expectReplaceError(
      service.prepareReplaceUserTurnTranscript(prepareInput(replacementFixture, {
        replacementMessageUuid: replacementFixture.firstUserId,
      })),
      'REPLACE_TRANSCRIPT_UUID_CONFLICT',
    )
    expect(await fs.readFile(replacementFixture.transcriptPath, 'utf-8'))
      .toBe(replacementFixture.raw)
    expect(await replacementArtifacts(replacementFixture.transcriptDir)).toEqual([])

    const rawDuplicateFixture = await createFixture('-tmp-raw-metadata-uuid-collision')
    const ignoredMetadataUser = JSON.stringify({
      type: 'user',
      isMeta: true,
      uuid: rawDuplicateFixture.targetUserId,
      parentUuid: rawDuplicateFixture.firstAssistantId,
      message: { role: 'user', content: 'metadata-only user entry' },
      timestamp: '2026-08-27T00:59:59.000Z',
    })
    const rawDuplicateTranscript = [
      rawDuplicateFixture.prefixBeforeTarget,
      `${ignoredMetadataUser}\r\n`,
      rawDuplicateFixture.raw.slice(rawDuplicateFixture.prefixBeforeTarget.length),
    ].join('')
    await fs.writeFile(
      rawDuplicateFixture.transcriptPath,
      rawDuplicateTranscript,
      'utf-8',
    )
    await expectReplaceError(
      service.prepareReplaceUserTurnTranscript(prepareInput(rawDuplicateFixture)),
      'REPLACE_TRANSCRIPT_UUID_CONFLICT',
    )
    expect(await fs.readFile(rawDuplicateFixture.transcriptPath, 'utf-8'))
      .toBe(rawDuplicateTranscript)
    expect(await replacementArtifacts(rawDuplicateFixture.transcriptDir)).toEqual([])
  })

  it('atomically trims the UUID-selected tail while preserving prefix bytes and metadata', async () => {
    const fixture = await createFixture()
    const prepared = await service.prepareReplaceUserTurnTranscript(prepareInput(fixture))

    expect(await prepared.trim()).toEqual({
      removedCount: 2,
      removedMessageIds: [fixture.targetUserId, fixture.targetAssistantId],
    })
    expect(prepared.state).toBe('trimmed')
    expect(await fs.readFile(fixture.transcriptPath, 'utf-8')).toBe(fixture.prefixBeforeTarget)
    expect((await fs.readdir(fixture.transcriptDir)).some((name) => name.endsWith('.tmp')))
      .toBe(false)

    await prepared.rollback()
  })

  it('keeps evidence on replacement UUID mismatch and cleans it only on matching commit', async () => {
    const fixture = await createFixture()
    const input = prepareInput(fixture)
    const prepared = await service.prepareReplaceUserTurnTranscript(input)
    await prepared.trim()

    await expectReplaceError(
      prepared.commit(randomUUID()),
      'REPLACE_TRANSCRIPT_REPLACEMENT_UUID_MISMATCH',
    )
    expect(prepared.state).toBe('trimmed')
    expect(await replacementArtifacts(fixture.transcriptDir)).toHaveLength(2)
    expect(await fs.readFile(fixture.transcriptPath, 'utf-8')).toBe(fixture.prefixBeforeTarget)

    expect(await prepared.commit(input.replacementMessageUuid)).toEqual({
      state: 'committed',
      cleanupComplete: true,
    })
    expect(prepared.state).toBe('committed')
    expect(await replacementArtifacts(fixture.transcriptDir)).toEqual([])
    expect(await fs.readFile(fixture.transcriptPath, 'utf-8')).toBe(fixture.prefixBeforeTarget)
  })

  it('rolls a trimmed transcript back byte-for-byte and removes operation evidence', async () => {
    const fixture = await createFixture()
    const prepared = await service.prepareReplaceUserTurnTranscript(prepareInput(fixture))
    await prepared.trim()

    expect(await prepared.rollback()).toEqual({ state: 'restored', cleanupComplete: true })
    expect(prepared.state).toBe('rolled_back')
    expect(await fs.readFile(fixture.transcriptPath)).toEqual(Buffer.from(fixture.raw))
    expect(await replacementArtifacts(fixture.transcriptDir)).toEqual([])
  })

  it('accepts late assistant output but rejects a late user turn through latest-user CAS', async () => {
    const assistantFixture = await createFixture('-tmp-late-assistant')
    const lateAssistantId = randomUUID()
    await fs.appendFile(
      assistantFixture.transcriptPath,
      `${JSON.stringify(assistantEntry(
        lateAssistantId,
        assistantFixture.targetUserId,
        'late output during stop',
      ))}\n`,
    )
    const prepared = await service.prepareReplaceUserTurnTranscript(prepareInput(assistantFixture))
    const trimResult = await prepared.trim()
    expect(trimResult.removedMessageIds).toContain(assistantFixture.targetUserId)
    expect(trimResult.removedMessageIds).toContain(lateAssistantId)
    await prepared.rollback()

    const userFixture = await createFixture('-tmp-late-user')
    const lateUserId = randomUUID()
    await fs.appendFile(
      userFixture.transcriptPath,
      `${JSON.stringify(userEntry(
        userFixture.sessionId,
        lateUserId,
        userFixture.targetAssistantId,
        'newer user turn',
      ))}\n`,
    )
    const afterLateUser = await fs.readFile(userFixture.transcriptPath, 'utf-8')
    await expectReplaceError(
      service.prepareReplaceUserTurnTranscript(prepareInput(userFixture)),
      'REPLACE_TRANSCRIPT_LATEST_USER_MISMATCH',
    )
    expect(await fs.readFile(userFixture.transcriptPath, 'utf-8')).toBe(afterLateUser)
    expect(await replacementArtifacts(userFixture.transcriptDir)).toEqual([])
  })

  it('rejects source changes observed before trim and preserves an append observed before rollback', async () => {
    const beforeTrim = await createFixture('-tmp-source-change-before-trim')
    const preparedBeforeTrim = await service.prepareReplaceUserTurnTranscript(prepareInput(beforeTrim))
    await fs.appendFile(beforeTrim.transcriptPath, '{"type":"external-after-prepare"}\n')
    const externallyChanged = await fs.readFile(beforeTrim.transcriptPath, 'utf-8')

    await expectReplaceError(
      preparedBeforeTrim.trim(),
      'REPLACE_TRANSCRIPT_SOURCE_CHANGED',
    )
    expect(await fs.readFile(beforeTrim.transcriptPath, 'utf-8')).toBe(externallyChanged)
    expect(await preparedBeforeTrim.rollback()).toEqual({
      state: 'not_applied',
      cleanupComplete: true,
    })

    const deletedBeforeTrim = await createFixture('-tmp-source-deleted-before-trim')
    const preparedBeforeDelete = await service.prepareReplaceUserTurnTranscript(
      prepareInput(deletedBeforeTrim),
    )
    await fs.rm(deletedBeforeTrim.transcriptPath)
    try {
      await preparedBeforeDelete.trim()
      throw new Error('Expected deleted transcript trim to fail')
    } catch (error) {
      expect(error).toBeInstanceOf(ReplaceUserTurnTranscriptError)
      expect([
        'REPLACE_TRANSCRIPT_SOURCE_CHANGED',
        'REPLACE_TRANSCRIPT_PATH_UNSAFE',
      ]).toContain((error as ReplaceUserTurnTranscriptError).code)
      expect((error as ReplaceUserTurnTranscriptError).state).toBe('prepared')
      expect((error as ReplaceUserTurnTranscriptError).destructiveBoundaryCrossed).toBe(false)
    }
    expect(preparedBeforeDelete.state).toBe('prepared')
    expect(await preparedBeforeDelete.rollback()).toEqual({
      state: 'not_applied',
      cleanupComplete: true,
    })

    const afterTrim = await createFixture('-tmp-source-change-after-trim')
    const preparedAfterTrim = await service.prepareReplaceUserTurnTranscript(prepareInput(afterTrim))
    await preparedAfterTrim.trim()
    await fs.appendFile(afterTrim.transcriptPath, '{"type":"external-after-trim"}\n')
    const changedTrim = await fs.readFile(afterTrim.transcriptPath, 'utf-8')

    expect(await preparedAfterTrim.rollback()).toEqual({
      state: 'indeterminate',
      cleanupComplete: false,
    })
    expect(preparedAfterTrim.state).toBe('indeterminate')
    expect(await fs.readFile(afterTrim.transcriptPath, 'utf-8')).toBe(changedTrim)
    expect(await replacementArtifacts(afterTrim.transcriptDir)).toHaveLength(2)
  })

  it('rejects malformed JSONL without modifying the transcript or creating artifacts', async () => {
    const fixture = await createFixture()
    const malformed = `${fixture.raw}{"type":"assistant","message":\n`
    await fs.writeFile(fixture.transcriptPath, malformed, 'utf-8')

    await expectReplaceError(
      service.prepareReplaceUserTurnTranscript(prepareInput(fixture)),
      'REPLACE_TRANSCRIPT_INVALID_JSONL',
    )
    expect(await fs.readFile(fixture.transcriptPath, 'utf-8')).toBe(malformed)
    expect(await replacementArtifacts(fixture.transcriptDir)).toEqual([])
  })

  it('rejects hostile operation ids and transcript paths that escape through a symlink', async () => {
    const fixture = await createFixture('-tmp-hostile-operation')
    const hostileOperationId = `..${path.sep}..${path.sep}escaped-operation`
    await expectReplaceError(
      service.prepareReplaceUserTurnTranscript(
        prepareInput(fixture, { operationId: hostileOperationId }),
      ),
      'REPLACE_TRANSCRIPT_INVALID_INPUT',
    )
    expect(await replacementArtifacts(fixture.transcriptDir)).toEqual([])
    expect(await fs.stat(path.join(configDir, 'escaped-operation')).catch(() => null)).toBeNull()

    const conflictOperationId = randomUUID()
    const conflictDigest = createHash('sha256').update(conflictOperationId).digest('hex')
    const conflictingMarkerName =
      `.${fixture.sessionId}.replace-turn-${conflictDigest}.marker`
    const conflictingMarkerPath = path.join(fixture.transcriptDir, conflictingMarkerName)
    await fs.writeFile(conflictingMarkerPath, 'pre-existing evidence must survive\n', 'utf-8')
    await expectReplaceError(
      service.prepareReplaceUserTurnTranscript(
        prepareInput(fixture, { operationId: conflictOperationId }),
      ),
      'REPLACE_TRANSCRIPT_ARTIFACT_CONFLICT',
    )
    expect(await fs.readFile(conflictingMarkerPath, 'utf-8'))
      .toBe('pre-existing evidence must survive\n')
    expect(await replacementArtifacts(fixture.transcriptDir)).toEqual([conflictingMarkerName])
    expect(await fs.readFile(fixture.transcriptPath, 'utf-8')).toBe(fixture.raw)

    const outsideDir = path.join(configDir, 'outside-projects')
    const linkedProjectDir = path.join(configDir, 'projects', '-tmp-linked-project')
    const linkedSessionId = randomUUID()
    const linkedUserId = randomUUID()
    const outsideTranscript = path.join(outsideDir, `${linkedSessionId}.jsonl`)
    await fs.mkdir(outsideDir, { recursive: true })
    const outsideRaw = `${JSON.stringify(userEntry(
      linkedSessionId,
      linkedUserId,
      null,
      'outside prompt',
    ))}\n`
    await fs.writeFile(outsideTranscript, outsideRaw, 'utf-8')
    try {
      await fs.symlink(
        outsideDir,
        linkedProjectDir,
        process.platform === 'win32' ? 'junction' : 'dir',
      )
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code === 'EPERM' || code === 'EACCES' || code === 'ENOTSUP') {
        console.warn(`[conditional skip] symlink/junction creation is unavailable: ${code}`)
        return
      }
      throw error
    }

    await expectReplaceError(
      service.prepareReplaceUserTurnTranscript({
        sessionId: linkedSessionId,
        operationId: randomUUID(),
        targetUserMessageId: linkedUserId,
        expectedLatestUserMessageId: linkedUserId,
        expectedContent: 'outside prompt',
        replacementMessageUuid: randomUUID(),
        writerQuiescence: WRITER_QUIESCENCE,
      }),
      'REPLACE_TRANSCRIPT_PATH_UNSAFE',
    )
    expect(await fs.readFile(outsideTranscript, 'utf-8')).toBe(outsideRaw)
    expect((await fs.readdir(outsideDir)).sort()).toEqual([`${linkedSessionId}.jsonl`])
  })

  it('pins the prepared handle to one physical transcript when duplicate session files reorder', async () => {
    const sessionId = randomUUID()
    const older = await createFixture('-tmp-duplicate-older', sessionId)
    const selected = await createFixture('-tmp-duplicate-selected', sessionId)
    const now = Date.now() / 1_000
    await fs.utimes(older.transcriptPath, now - 20, now - 20)
    await fs.utimes(selected.transcriptPath, now - 10, now - 10)

    const prepared = await service.prepareReplaceUserTurnTranscript(prepareInput(selected))
    await fs.utimes(older.transcriptPath, now, now)
    await prepared.trim()

    expect(await fs.readFile(selected.transcriptPath, 'utf-8')).toBe(selected.prefixBeforeTarget)
    expect(await fs.readFile(older.transcriptPath, 'utf-8')).toBe(older.raw)
    expect(await replacementArtifacts(selected.transcriptDir)).toHaveLength(2)
    expect(await replacementArtifacts(older.transcriptDir)).toEqual([])
    await prepared.rollback()
  })
})
