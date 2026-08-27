import { createHash } from 'node:crypto'
import type { Stats } from 'node:fs'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'

export type ReplaceUserTurnTranscriptState =
  | 'prepared'
  | 'trimmed'
  | 'rolled_back'
  | 'committed'
  | 'indeterminate'

export type ReplaceUserTurnTranscriptErrorCode =
  | 'REPLACE_TRANSCRIPT_INVALID_INPUT'
  | 'REPLACE_TRANSCRIPT_NOT_FOUND'
  | 'REPLACE_TRANSCRIPT_PATH_UNSAFE'
  | 'REPLACE_TRANSCRIPT_INVALID_JSONL'
  | 'REPLACE_TRANSCRIPT_TARGET_NOT_FOUND'
  | 'REPLACE_TRANSCRIPT_TARGET_NOT_USER'
  | 'REPLACE_TRANSCRIPT_UUID_CONFLICT'
  | 'REPLACE_TRANSCRIPT_CONTENT_MISMATCH'
  | 'REPLACE_TRANSCRIPT_LATEST_USER_MISMATCH'
  | 'REPLACE_TRANSCRIPT_ARTIFACT_CONFLICT'
  | 'REPLACE_TRANSCRIPT_EVIDENCE_CLEANUP_INCOMPLETE'
  | 'REPLACE_TRANSCRIPT_SOURCE_CHANGED'
  | 'REPLACE_TRANSCRIPT_WRITE_FAILED'
  | 'REPLACE_TRANSCRIPT_REPLACEMENT_UUID_MISMATCH'
  | 'REPLACE_TRANSCRIPT_INVALID_STATE'
  | 'REPLACE_TRANSCRIPT_INDETERMINATE'

export class ReplaceUserTurnTranscriptError extends Error {
  constructor(
    public readonly code: ReplaceUserTurnTranscriptErrorCode,
    message: string,
    public readonly state: ReplaceUserTurnTranscriptState,
    public readonly destructiveBoundaryCrossed: boolean,
    options?: ErrorOptions,
  ) {
    super(message, options)
    this.name = 'ReplaceUserTurnTranscriptError'
  }
}

export type PrepareReplaceUserTurnTranscriptInput = {
  sessionId: string
  operationId: string
  targetUserMessageId: string
  expectedLatestUserMessageId: string
  expectedContent: string
  replacementMessageUuid: string
  /**
   * This storage seam cannot atomically compare and rename against writers in
   * another process. Phase 3C callers must hold the session mutation slot and
   * must have stopped and drained the runtime before preparing the transcript.
   */
  writerQuiescence: 'runtime_stopped_and_session_mutation_slot_held'
}

export type ReplaceUserTurnTranscriptRollbackResult =
  | { state: 'not_applied'; cleanupComplete: boolean }
  | { state: 'restored'; cleanupComplete: boolean }
  | { state: 'indeterminate'; cleanupComplete: false }

export type ReplaceUserTurnTranscriptCommitResult = {
  state: 'committed'
  cleanupComplete: boolean
}

export type ReplaceUserTurnTranscriptTrimResult = {
  removedCount: number
  removedMessageIds: string[]
}

export interface PreparedReplaceUserTurnTranscript {
  readonly sessionId: string
  readonly operationId: string
  readonly targetUserMessageId: string
  readonly replacementMessageUuid: string
  readonly messagesRemoved: number
  readonly state: ReplaceUserTurnTranscriptState
  trim(): Promise<ReplaceUserTurnTranscriptTrimResult>
  rollback(): Promise<ReplaceUserTurnTranscriptRollbackResult>
  commit(observedReplacementMessageUuid: string): Promise<ReplaceUserTurnTranscriptCommitResult>
}

type RawEntry = {
  type?: string
  uuid?: string
  message?: { role?: string; content?: unknown }
  [key: string]: unknown
}

type ProjectedMessage = {
  id: string
  type: string
  content: unknown
}

export type ReplaceUserTurnTranscriptDependencies = {
  findSessionFile: (
    sessionId: string,
  ) => Promise<{ filePath: string; projectDir: string } | null>
  getProjectsDir: () => string
  projectMessages: (entries: RawEntry[]) => ProjectedMessage[]
  now: () => number
  invalidateTranscriptCaches: () => void
}

type TranscriptFileIdentity = {
  dev: number
  ino: number
  mode: number
  size: number
  mtimeMs: number
  ctimeMs: number
}

type VerifiedTranscriptMutationPath = {
  transcriptPath: string
  projectDir: string
  projectsRootRealPath: string
}

type StrictJsonlLine = {
  raw: Buffer
  entry: RawEntry | null
}

type PreparedTranscriptArtifacts = {
  backupPath: string
  markerPath: string
}

class ExclusiveEvidenceCleanupError extends Error {
  constructor(options: ErrorOptions) {
    super('Exclusive replacement evidence could not be cleaned up.', options)
    this.name = 'ExclusiveEvidenceCleanupError'
  }
}

function transcriptIdentity(stat: Stats): TranscriptFileIdentity {
  return {
    dev: stat.dev,
    ino: stat.ino,
    mode: stat.mode,
    size: stat.size,
    mtimeMs: stat.mtimeMs,
    ctimeMs: stat.ctimeMs,
  }
}

function transcriptIdentitiesMatch(
  left: TranscriptFileIdentity,
  right: TranscriptFileIdentity,
): boolean {
  return left.dev === right.dev &&
    left.ino === right.ino &&
    left.mode === right.mode &&
    left.size === right.size &&
    left.mtimeMs === right.mtimeMs &&
    left.ctimeMs === right.ctimeMs
}

function transcriptDigest(content: Buffer): string {
  return createHash('sha256').update(content).digest('hex')
}

function isUuidLike(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)
}

function normalizePromptText(text: string): string {
  return text.replace(/\r\n/g, '\n').trim()
}

function extractPromptText(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content.flatMap((block) => {
    if (!block || typeof block !== 'object') return []
    const record = block as Record<string, unknown>
    return record.type === 'text' && typeof record.text === 'string'
      ? [record.text]
      : []
  }).join('\n')
}

function parseJsonlStrictly(content: Buffer): StrictJsonlLine[] {
  const lines: StrictJsonlLine[] = []
  let offset = 0
  while (offset < content.length) {
    const newlineIndex = content.indexOf(0x0a, offset)
    const end = newlineIndex < 0 ? content.length : newlineIndex + 1
    const raw = content.subarray(offset, end)
    let jsonBytes = newlineIndex < 0 ? raw : raw.subarray(0, raw.length - 1)
    if (jsonBytes.length > 0 && jsonBytes[jsonBytes.length - 1] === 0x0d) {
      jsonBytes = jsonBytes.subarray(0, jsonBytes.length - 1)
    }
    const decoded = jsonBytes.toString('utf-8')
    if (!Buffer.from(decoded, 'utf-8').equals(jsonBytes)) {
      throw new ReplaceUserTurnTranscriptError(
        'REPLACE_TRANSCRIPT_INVALID_JSONL',
        'The transcript is not valid UTF-8 JSONL.',
        'prepared',
        false,
      )
    }
    const trimmed = decoded.trim()
    if (!trimmed) {
      lines.push({ raw, entry: null })
    } else {
      let parsed: unknown
      try {
        parsed = JSON.parse(trimmed)
      } catch (error) {
        throw new ReplaceUserTurnTranscriptError(
          'REPLACE_TRANSCRIPT_INVALID_JSONL',
          'The transcript contains an invalid JSONL entry.',
          'prepared',
          false,
          { cause: error },
        )
      }
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new ReplaceUserTurnTranscriptError(
          'REPLACE_TRANSCRIPT_INVALID_JSONL',
          'The transcript contains a non-object JSONL entry.',
          'prepared',
          false,
        )
      }
      lines.push({ raw, entry: parsed as RawEntry })
    }
    offset = end
  }
  return lines
}

async function writeSyncedExclusiveFile(
  filePath: string,
  content: Buffer | string,
  mode: number,
): Promise<void> {
  let handle: fs.FileHandle | undefined
  let created = false
  try {
    handle = await fs.open(filePath, 'wx', mode)
    created = true
    await handle.writeFile(content)
    await handle.sync()
  } catch (error) {
    await handle?.close().catch(() => undefined)
    handle = undefined
    if (created) {
      try {
        await fs.rm(filePath, { force: true })
      } catch (cleanupError) {
        throw new ExclusiveEvidenceCleanupError({
          cause: new AggregateError(
            [error, cleanupError],
            'Replacement evidence write and owned cleanup both failed.',
          ),
        })
      }
    }
    throw error
  } finally {
    await handle?.close().catch(() => undefined)
  }
}

async function writeSyncedTemporaryFile(
  filePath: string,
  content: Buffer,
  mode: number,
): Promise<void> {
  let handle: fs.FileHandle | undefined
  try {
    handle = await fs.open(filePath, 'wx', mode)
    await handle.writeFile(content)
    await handle.sync()
  } finally {
    await handle?.close().catch(() => undefined)
  }
}

async function syncDirectoryBestEffort(directoryPath: string): Promise<void> {
  if (process.platform === 'win32') return
  let handle: fs.FileHandle | undefined
  try {
    handle = await fs.open(directoryPath, 'r')
    await handle.sync()
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code !== 'EINVAL' && code !== 'ENOTSUP' && code !== 'EISDIR') throw error
  } finally {
    await handle?.close().catch(() => undefined)
  }
}

async function readStableTranscriptFile(filePath: string): Promise<{
  content: Buffer
  identity: TranscriptFileIdentity
}> {
  const pathBefore = await fs.lstat(filePath)
  if (!pathBefore.isFile() || pathBefore.isSymbolicLink()) {
    throw new ReplaceUserTurnTranscriptError(
      'REPLACE_TRANSCRIPT_PATH_UNSAFE',
      'The transcript path is not a regular file.',
      'prepared',
      false,
    )
  }
  let handle: fs.FileHandle | undefined
  try {
    handle = await fs.open(filePath, 'r')
    const before = await handle.stat()
    if (!before.isFile()) {
      throw new ReplaceUserTurnTranscriptError(
        'REPLACE_TRANSCRIPT_PATH_UNSAFE',
        'The transcript path is not a regular file.',
        'prepared',
        false,
      )
    }
    const content = await handle.readFile()
    const after = await handle.stat()
    const pathAfter = await fs.lstat(filePath)
    const beforeIdentity = transcriptIdentity(before)
    const afterIdentity = transcriptIdentity(after)
    const pathIdentity = transcriptIdentity(pathAfter)
    if (
      !transcriptIdentitiesMatch(beforeIdentity, afterIdentity) ||
      !transcriptIdentitiesMatch(afterIdentity, pathIdentity) ||
      content.length !== after.size
    ) {
      throw new ReplaceUserTurnTranscriptError(
        'REPLACE_TRANSCRIPT_SOURCE_CHANGED',
        'The transcript changed while it was being read.',
        'prepared',
        false,
      )
    }
    return { content, identity: afterIdentity }
  } finally {
    await handle?.close().catch(() => undefined)
  }
}

async function verifyTranscriptMutationPath(
  verified: VerifiedTranscriptMutationPath,
  sessionId: string,
): Promise<void> {
  const invalid = () => new ReplaceUserTurnTranscriptError(
    'REPLACE_TRANSCRIPT_PATH_UNSAFE',
    'The transcript path failed mutation scope validation.',
    'prepared',
    false,
  )
  if (
    path.basename(verified.projectDir) !== verified.projectDir ||
    path.basename(verified.transcriptPath) !== `${sessionId}.jsonl` ||
    path.basename(path.dirname(verified.transcriptPath)) !== verified.projectDir
  ) throw invalid()

  const parentStat = await fs.lstat(path.dirname(verified.transcriptPath))
  const transcriptStat = await fs.lstat(verified.transcriptPath)
  if (
    !parentStat.isDirectory() ||
    parentStat.isSymbolicLink() ||
    !transcriptStat.isFile() ||
    transcriptStat.isSymbolicLink()
  ) throw invalid()

  const transcriptRealPath = await fs.realpath(verified.transcriptPath)
  const relativePath = path.relative(verified.projectsRootRealPath, transcriptRealPath)
  if (
    relativePath === '..' ||
    relativePath.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relativePath)
  ) throw invalid()
}

class PreparedReplaceUserTurnTranscriptImpl implements PreparedReplaceUserTurnTranscript {
  private currentState: ReplaceUserTurnTranscriptState = 'prepared'
  private destructiveBoundaryCrossed = false
  private trimmedContent: Buffer | null
  private finalCleanupComplete = false
  private rollbackOutcome: 'not_applied' | 'restored' | null = null

  constructor(
    readonly sessionId: string,
    readonly operationId: string,
    readonly targetUserMessageId: string,
    readonly replacementMessageUuid: string,
    readonly messagesRemoved: number,
    private readonly removedMessageIds: string[],
    private readonly verifiedPath: VerifiedTranscriptMutationPath,
    private readonly artifacts: PreparedTranscriptArtifacts,
    private readonly sourceIdentity: TranscriptFileIdentity,
    private readonly sourceDigest: string,
    private readonly trimmedDigest: string,
    trimmedContent: Buffer,
    private readonly invalidateTranscriptCaches: () => void,
  ) {
    this.trimmedContent = trimmedContent
  }

  get state(): ReplaceUserTurnTranscriptState {
    return this.currentState
  }

  async trim(): Promise<ReplaceUserTurnTranscriptTrimResult> {
    if (this.currentState === 'trimmed') return this.cloneTrimResult()
    this.assertState('prepared')

    let liveBefore: Awaited<ReturnType<typeof readStableTranscriptFile>>
    try {
      await verifyTranscriptMutationPath(this.verifiedPath, this.sessionId)
      liveBefore = await readStableTranscriptFile(this.verifiedPath.transcriptPath)
    } catch (error) {
      if (error instanceof ReplaceUserTurnTranscriptError) throw error
      throw new ReplaceUserTurnTranscriptError(
        'REPLACE_TRANSCRIPT_SOURCE_CHANGED',
        'The transcript could not be verified before replacement trim.',
        'prepared',
        false,
        { cause: error },
      )
    }
    const liveBeforeDigest = transcriptDigest(liveBefore.content)
    liveBefore.content.fill(0)
    if (
      !transcriptIdentitiesMatch(liveBefore.identity, this.sourceIdentity) ||
      liveBeforeDigest !== this.sourceDigest
    ) {
      throw new ReplaceUserTurnTranscriptError(
        'REPLACE_TRANSCRIPT_SOURCE_CHANGED',
        'The transcript changed before replacement trim.',
        'prepared',
        false,
      )
    }

    const trimmedContent = this.trimmedContent
    if (!trimmedContent) {
      throw new ReplaceUserTurnTranscriptError(
        'REPLACE_TRANSCRIPT_INVALID_STATE',
        'The prepared transcript content is no longer available.',
        this.currentState,
        false,
      )
    }
    const tempPath = path.join(
      path.dirname(this.verifiedPath.transcriptPath),
      `.${path.basename(this.verifiedPath.transcriptPath)}.replace-${crypto.randomUUID()}.tmp`,
    )
    let renameAttempted = false
    try {
      await writeSyncedTemporaryFile(tempPath, trimmedContent, this.sourceIdentity.mode)
      await verifyTranscriptMutationPath(this.verifiedPath, this.sessionId)
      const liveAtCommit = await readStableTranscriptFile(this.verifiedPath.transcriptPath)
      const liveAtCommitDigest = transcriptDigest(liveAtCommit.content)
      liveAtCommit.content.fill(0)
      if (
        !transcriptIdentitiesMatch(liveAtCommit.identity, this.sourceIdentity) ||
        liveAtCommitDigest !== this.sourceDigest
      ) {
        throw new ReplaceUserTurnTranscriptError(
          'REPLACE_TRANSCRIPT_SOURCE_CHANGED',
          'The transcript changed before replacement trim committed.',
          'prepared',
          false,
        )
      }
      renameAttempted = true
      await fs.rename(tempPath, this.verifiedPath.transcriptPath)
      await syncDirectoryBestEffort(path.dirname(this.verifiedPath.transcriptPath))
      this.currentState = 'trimmed'
      this.destructiveBoundaryCrossed = true
      this.clearTrimmedContent()
      this.invalidateTranscriptCaches()
      return this.cloneTrimResult()
    } catch (error) {
      if (!renameAttempted) {
        if (error instanceof ReplaceUserTurnTranscriptError) throw error
        throw new ReplaceUserTurnTranscriptError(
          'REPLACE_TRANSCRIPT_WRITE_FAILED',
          'The transcript replacement could not be written.',
          'prepared',
          false,
          { cause: error },
        )
      }
      const outcome = await this.readLiveDigest()
      if (outcome === this.trimmedDigest) {
        this.currentState = 'trimmed'
        this.destructiveBoundaryCrossed = true
        this.clearTrimmedContent()
        this.invalidateTranscriptCaches()
        return this.cloneTrimResult()
      }
      if (outcome === this.sourceDigest) {
        throw new ReplaceUserTurnTranscriptError(
          'REPLACE_TRANSCRIPT_WRITE_FAILED',
          'The transcript replacement could not be committed.',
          'prepared',
          false,
          { cause: error },
        )
      }
      this.currentState = 'indeterminate'
      this.destructiveBoundaryCrossed = true
      this.clearTrimmedContent()
      throw new ReplaceUserTurnTranscriptError(
        'REPLACE_TRANSCRIPT_INDETERMINATE',
        'The transcript replacement outcome could not be determined.',
        'indeterminate',
        true,
        { cause: error },
      )
    } finally {
      await fs.rm(tempPath, { force: true }).catch(() => undefined)
    }
  }

  async rollback(): Promise<ReplaceUserTurnTranscriptRollbackResult> {
    if (this.currentState === 'rolled_back') {
      if (!this.finalCleanupComplete) this.finalCleanupComplete = await this.cleanupArtifacts()
      return {
        state: this.rollbackOutcome ?? 'restored',
        cleanupComplete: this.finalCleanupComplete,
      }
    }
    if (this.currentState === 'prepared') {
      this.currentState = 'rolled_back'
      this.rollbackOutcome = 'not_applied'
      this.clearTrimmedContent()
      this.finalCleanupComplete = await this.cleanupArtifacts()
      return { state: 'not_applied', cleanupComplete: this.finalCleanupComplete }
    }
    if (this.currentState !== 'trimmed') {
      if (this.currentState === 'indeterminate') {
        return { state: 'indeterminate', cleanupComplete: false }
      }
      this.assertState('trimmed')
    }
    if (await this.readLiveDigest() !== this.trimmedDigest) {
      this.currentState = 'indeterminate'
      return { state: 'indeterminate', cleanupComplete: false }
    }

    let sourceContent: Buffer
    try {
      const backup = await readStableTranscriptFile(this.artifacts.backupPath)
      sourceContent = backup.content
      if (transcriptDigest(sourceContent) !== this.sourceDigest) {
        sourceContent.fill(0)
        this.currentState = 'indeterminate'
        return { state: 'indeterminate', cleanupComplete: false }
      }
    } catch {
      this.currentState = 'indeterminate'
      return { state: 'indeterminate', cleanupComplete: false }
    }
    const tempPath = path.join(
      path.dirname(this.verifiedPath.transcriptPath),
      `.${path.basename(this.verifiedPath.transcriptPath)}.rollback-${crypto.randomUUID()}.tmp`,
    )
    try {
      await writeSyncedTemporaryFile(tempPath, sourceContent, this.sourceIdentity.mode)
      if (await this.readLiveDigest() !== this.trimmedDigest) {
        this.currentState = 'indeterminate'
        return { state: 'indeterminate', cleanupComplete: false }
      }
      try {
        await fs.rename(tempPath, this.verifiedPath.transcriptPath)
        await syncDirectoryBestEffort(path.dirname(this.verifiedPath.transcriptPath))
      } catch {
        // The digest below is authoritative even when rename reports failure.
      }
      if (await this.readLiveDigest() !== this.sourceDigest) {
        this.currentState = 'indeterminate'
        return { state: 'indeterminate', cleanupComplete: false }
      }
      this.currentState = 'rolled_back'
      this.rollbackOutcome = 'restored'
      this.invalidateTranscriptCaches()
      this.finalCleanupComplete = await this.cleanupArtifacts()
      return { state: 'restored', cleanupComplete: this.finalCleanupComplete }
    } catch {
      this.currentState = 'indeterminate'
      return { state: 'indeterminate', cleanupComplete: false }
    } finally {
      sourceContent.fill(0)
      await fs.rm(tempPath, { force: true }).catch(() => undefined)
    }
  }

  async commit(
    observedReplacementMessageUuid: string,
  ): Promise<ReplaceUserTurnTranscriptCommitResult> {
    if (observedReplacementMessageUuid !== this.replacementMessageUuid) {
      throw new ReplaceUserTurnTranscriptError(
        'REPLACE_TRANSCRIPT_REPLACEMENT_UUID_MISMATCH',
        'The observed replacement message does not match this operation.',
        this.currentState,
        this.destructiveBoundaryCrossed,
      )
    }
    if (this.currentState === 'committed') {
      if (!this.finalCleanupComplete) this.finalCleanupComplete = await this.cleanupArtifacts()
      return { state: 'committed', cleanupComplete: this.finalCleanupComplete }
    }
    this.assertState('trimmed')
    this.currentState = 'committed'
    this.clearTrimmedContent()
    this.finalCleanupComplete = await this.cleanupArtifacts()
    return { state: 'committed', cleanupComplete: this.finalCleanupComplete }
  }

  private assertState(expected: ReplaceUserTurnTranscriptState): void {
    if (this.currentState === expected) return
    throw new ReplaceUserTurnTranscriptError(
      'REPLACE_TRANSCRIPT_INVALID_STATE',
      `This transcript operation cannot run from state ${this.currentState}.`,
      this.currentState,
      this.destructiveBoundaryCrossed,
    )
  }

  private cloneTrimResult(): ReplaceUserTurnTranscriptTrimResult {
    return {
      removedCount: this.messagesRemoved,
      removedMessageIds: [...this.removedMessageIds],
    }
  }

  private clearTrimmedContent(): void {
    this.trimmedContent?.fill(0)
    this.trimmedContent = null
  }

  private async readLiveDigest(): Promise<string | null> {
    try {
      await verifyTranscriptMutationPath(this.verifiedPath, this.sessionId)
      const live = await readStableTranscriptFile(this.verifiedPath.transcriptPath)
      try {
        return transcriptDigest(live.content)
      } finally {
        live.content.fill(0)
      }
    } catch {
      return null
    }
  }

  private async cleanupArtifacts(): Promise<boolean> {
    try {
      await fs.rm(this.artifacts.backupPath, { force: true })
    } catch {
      return false
    }
    try {
      await fs.rm(this.artifacts.markerPath, { force: true })
      await syncDirectoryBestEffort(path.dirname(this.artifacts.markerPath))
      return true
    } catch {
      return false
    }
  }
}

/**
 * Prepare a recoverable replace-user-turn transcript mutation.
 *
 * Filesystems do not provide an atomic content-CAS-plus-rename primitive. The
 * caller must hold the per-session mutation coordinator slot and stop/drain the
 * runtime for prepare + trim. The writerQuiescence token makes that external
 * precondition explicit; digest checks detect accidents but cannot lock a
 * writer in another process.
 */
export async function prepareReplaceUserTurnTranscript(
  input: PrepareReplaceUserTurnTranscriptInput,
  dependencies: ReplaceUserTurnTranscriptDependencies,
): Promise<PreparedReplaceUserTurnTranscript> {
  if (
    !input ||
    typeof input !== 'object' ||
    typeof input.sessionId !== 'string' ||
    typeof input.operationId !== 'string' ||
    typeof input.targetUserMessageId !== 'string' ||
    typeof input.expectedLatestUserMessageId !== 'string' ||
    typeof input.expectedContent !== 'string' ||
    typeof input.replacementMessageUuid !== 'string' ||
    input.writerQuiescence !== 'runtime_stopped_and_session_mutation_slot_held' ||
    !isUuidLike(input.sessionId) ||
    !isUuidLike(input.operationId) ||
    !isUuidLike(input.targetUserMessageId) ||
    !isUuidLike(input.expectedLatestUserMessageId) ||
    !isUuidLike(input.replacementMessageUuid)
  ) {
    throw new ReplaceUserTurnTranscriptError(
      'REPLACE_TRANSCRIPT_INVALID_INPUT',
      'The replace-user-turn transcript input is invalid.',
      'prepared',
      false,
    )
  }

  const found = await dependencies.findSessionFile(input.sessionId)
  if (!found) {
    throw new ReplaceUserTurnTranscriptError(
      'REPLACE_TRANSCRIPT_NOT_FOUND',
      'The transcript was not found.',
      'prepared',
      false,
    )
  }
  let projectsRootRealPath: string
  try {
    projectsRootRealPath = await fs.realpath(dependencies.getProjectsDir())
  } catch (error) {
    throw new ReplaceUserTurnTranscriptError(
      'REPLACE_TRANSCRIPT_PATH_UNSAFE',
      'The transcript root could not be verified.',
      'prepared',
      false,
      { cause: error },
    )
  }
  const verifiedPath: VerifiedTranscriptMutationPath = {
    transcriptPath: found.filePath,
    projectDir: found.projectDir,
    projectsRootRealPath,
  }
  try {
    await verifyTranscriptMutationPath(verifiedPath, input.sessionId)
  } catch (error) {
    if (error instanceof ReplaceUserTurnTranscriptError) throw error
    throw new ReplaceUserTurnTranscriptError(
      'REPLACE_TRANSCRIPT_PATH_UNSAFE',
      'The transcript path could not be verified.',
      'prepared',
      false,
      { cause: error },
    )
  }

  let sourceSnapshot: Awaited<ReturnType<typeof readStableTranscriptFile>>
  try {
    sourceSnapshot = await readStableTranscriptFile(found.filePath)
  } catch (error) {
    if (error instanceof ReplaceUserTurnTranscriptError) throw error
    throw new ReplaceUserTurnTranscriptError(
      'REPLACE_TRANSCRIPT_SOURCE_CHANGED',
      'The transcript could not be read stably.',
      'prepared',
      false,
      { cause: error },
    )
  }
  const rejectPreparedSnapshot = (
    code: ReplaceUserTurnTranscriptErrorCode,
    message: string,
  ): never => {
    sourceSnapshot.content.fill(0)
    throw new ReplaceUserTurnTranscriptError(code, message, 'prepared', false)
  }
  let lines: StrictJsonlLine[]
  let entries: RawEntry[]
  let activeMessages: ProjectedMessage[]
  try {
    lines = parseJsonlStrictly(sourceSnapshot.content)
    entries = lines.flatMap(({ entry }) => entry ? [entry] : [])
    activeMessages = dependencies.projectMessages(entries)
  } catch (error) {
    sourceSnapshot.content.fill(0)
    throw error
  }

  const rawUuids = new Set<string>()
  for (const entry of entries) {
    if (typeof entry.uuid !== 'string') continue
    if (rawUuids.has(entry.uuid)) {
      rejectPreparedSnapshot(
        'REPLACE_TRANSCRIPT_UUID_CONFLICT',
        'The transcript contains a duplicate message UUID.',
      )
    }
    rawUuids.add(entry.uuid)
  }
  if (rawUuids.has(input.replacementMessageUuid)) {
    rejectPreparedSnapshot(
      'REPLACE_TRANSCRIPT_UUID_CONFLICT',
      'The replacement message UUID already exists in the transcript.',
    )
  }

  const targetMessage = activeMessages.find(message => message.id === input.targetUserMessageId)
  if (!targetMessage) {
    const rawTarget = entries.find(entry => entry.uuid === input.targetUserMessageId)
    rejectPreparedSnapshot(
      rawTarget?.message?.role && rawTarget.message.role !== 'user'
        ? 'REPLACE_TRANSCRIPT_TARGET_NOT_USER'
        : 'REPLACE_TRANSCRIPT_TARGET_NOT_FOUND',
      rawTarget?.message?.role && rawTarget.message.role !== 'user'
        ? 'The replacement target is not a user message.'
        : 'The replacement target is not in the active transcript chain.',
    )
  }
  if (targetMessage.type !== 'user') {
    rejectPreparedSnapshot(
      'REPLACE_TRANSCRIPT_TARGET_NOT_USER',
      'The replacement target is not a user message.',
    )
  }
  const userMessages = activeMessages.filter(message => message.type === 'user')
  if (userMessages[userMessages.length - 1]?.id !== input.expectedLatestUserMessageId) {
    rejectPreparedSnapshot(
      'REPLACE_TRANSCRIPT_LATEST_USER_MISMATCH',
      'The transcript contains a newer user turn.',
    )
  }
  if (normalizePromptText(extractPromptText(targetMessage.content)) !== normalizePromptText(input.expectedContent)) {
    rejectPreparedSnapshot(
      'REPLACE_TRANSCRIPT_CONTENT_MISMATCH',
      'The replacement target content no longer matches.',
    )
  }

  const startIndex = activeMessages.findIndex(message => message.id === input.targetUserMessageId)
  const removedMessageIds = activeMessages.slice(startIndex).map(message => message.id)
  const remainingMessageIds = new Set(activeMessages.slice(0, startIndex).map(message => message.id))
  const removedIds = new Set(removedMessageIds)
  const retainedRawLines = lines.flatMap(({ raw, entry }) => {
    if (!entry || typeof entry.uuid !== 'string') return [raw]
    if (removedIds.has(entry.uuid)) return []
    if (
      entry.message?.role &&
      (entry.type === 'user' || entry.type === 'assistant' || entry.type === 'system')
    ) return remainingMessageIds.has(entry.uuid) ? [raw] : []
    return [raw]
  })
  const trimmedContent = Buffer.concat(retainedRawLines)
  const sourceDigest = transcriptDigest(sourceSnapshot.content)
  const trimmedDigest = transcriptDigest(trimmedContent)
  const operationHash = createHash('sha256').update(input.operationId).digest('hex')
  const artifactPrefix = `.${input.sessionId}.replace-turn-${operationHash}`
  const artifactDirectory = path.dirname(found.filePath)
  const artifacts: PreparedTranscriptArtifacts = {
    backupPath: path.join(artifactDirectory, `${artifactPrefix}.backup`),
    markerPath: path.join(artifactDirectory, `${artifactPrefix}.marker`),
  }
  const marker = `${JSON.stringify({
    version: 1,
    kind: 'replace-user-turn-transcript',
    operationId: input.operationId,
    sessionId: input.sessionId,
    targetUserMessageId: input.targetUserMessageId,
    replacementMessageUuid: input.replacementMessageUuid,
    transcriptFileName: path.basename(found.filePath),
    backupFileName: path.basename(artifacts.backupPath),
    source: { sha256: sourceDigest, bytes: sourceSnapshot.content.length },
    trimmed: { sha256: trimmedDigest, bytes: trimmedContent.length },
    createdAt: new Date(dependencies.now()).toISOString(),
  })}\n`

  let backupCreated = false
  let markerCreated = false
  try {
    await writeSyncedExclusiveFile(artifacts.backupPath, sourceSnapshot.content, 0o600)
    backupCreated = true
    await writeSyncedExclusiveFile(artifacts.markerPath, marker, 0o600)
    markerCreated = true
    await syncDirectoryBestEffort(artifactDirectory)
  } catch (error) {
    trimmedContent.fill(0)
    if (error instanceof ExclusiveEvidenceCleanupError) {
      throw new ReplaceUserTurnTranscriptError(
        'REPLACE_TRANSCRIPT_EVIDENCE_CLEANUP_INCOMPLETE',
        'Replacement evidence cleanup could not be confirmed.',
        'indeterminate',
        false,
        { cause: error },
      )
    }
    let cleanupComplete = true
    if (markerCreated) {
      try {
        await fs.rm(artifacts.markerPath, { force: true })
      } catch {
        cleanupComplete = false
      }
    }
    if (backupCreated) {
      try {
        await fs.rm(artifacts.backupPath, { force: true })
      } catch {
        cleanupComplete = false
      }
    }
    if (!cleanupComplete) {
      throw new ReplaceUserTurnTranscriptError(
        'REPLACE_TRANSCRIPT_EVIDENCE_CLEANUP_INCOMPLETE',
        'Replacement evidence cleanup could not be confirmed.',
        'indeterminate',
        false,
        { cause: error },
      )
    }
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
      throw new ReplaceUserTurnTranscriptError(
        'REPLACE_TRANSCRIPT_ARTIFACT_CONFLICT',
        'Replacement transcript evidence already exists for this operation.',
        'prepared',
        false,
        { cause: error },
      )
    }
    throw new ReplaceUserTurnTranscriptError(
      'REPLACE_TRANSCRIPT_WRITE_FAILED',
      'Replacement transcript evidence could not be prepared.',
      'prepared',
      false,
      { cause: error },
    )
  } finally {
    sourceSnapshot.content.fill(0)
  }

  return new PreparedReplaceUserTurnTranscriptImpl(
    input.sessionId,
    input.operationId,
    input.targetUserMessageId,
    input.replacementMessageUuid,
    removedMessageIds.length,
    removedMessageIds,
    verifiedPath,
    artifacts,
    sourceSnapshot.identity,
    sourceDigest,
    trimmedDigest,
    trimmedContent,
    dependencies.invalidateTranscriptCaches,
  )
}
