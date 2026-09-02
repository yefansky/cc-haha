import * as fs from 'node:fs/promises'
import { constants as fsConstants } from 'node:fs'
import { execFile as execFileCallback } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import * as path from 'node:path'
import { promisify } from 'node:util'
import { diffLines } from 'diff'
import iconv from 'iconv-lite'
import type { MessageEntry } from './sessionService.js'
import type { FileHistorySnapshot } from '../../utils/fileHistory.js'
import { getClaudeConfigHomeDir } from '../../utils/envUtils.js'
import { isWithinRegisteredFilesystemRoot, registerFilesystemAccessRoot } from './filesystemAccessRoots.js'
import { collectErroredToolUseIds } from './transcriptToolResults.js'
import {
  isSameOrInsidePathForPlatform,
  normalizeDriveRootPathForPlatform,
} from './windowsDrivePath.js'

const MAX_PREVIEW_BYTES = 1024 * 1024
const MAX_UNTRACKED_STAT_BYTES = 256 * 1024
const GIT_TIMEOUT_MS = 5_000
const MAX_GIT_BUFFER_BYTES = 2_000_000
const MAX_COMMAND_ERROR_DETAILS_CHARS = 2_048
const AUTO_ENCODING_SAMPLE_BYTES = 16 * 1024
// A status walk over a large legacy working copy can take longer than a small
// Git command. Keep this scoped to status reads so diffs and mutating commands
// still fail quickly when SVN is unavailable.
const SVN_STATUS_TIMEOUT_MS = 30_000
// SVN status XML still needs room for a large set of real changes, but must not
// enumerate ignored build output just to discard it below.
const MAX_SVN_STATUS_BUFFER_BYTES = 16 * 1024 * 1024
const VCS_METADATA_DIRECTORY_NAMES = new Set(['.git', '.svn', '.hg', '.bzr', '.jj', '.sl'])
const PLAINTEXT_FILE_EXTENSIONS = new Set([
  'asm', 'bash', 'bat', 'c', 'cc', 'cfg', 'cjs', 'cmake', 'cmd', 'conf', 'cpp', 'cs', 'css', 'csv', 'cts',
  'def', 'go', 'h', 'hh', 'hpp', 'html', 'i', 'ini', 'inl', 'java', 'js', 'json',
  'jsx', 'lh', 'li', 'log', 'lua', 'm', 'md', 'mjs', 'mm', 'ps1', 'py', 'rc',
  'mts', 'rs', 'sh', 'shell', 'sln', 'sql', 'svg', 'tab', 'targets', 'toml', 'ts', 'tsx', 'tsv',
  'txt', 'vcproj', 'vcxproj', 'xml', 'yaml', 'yml', 'zsh',
])
const PLAINTEXT_FILE_NAMES = new Set([
  'cmakelists.txt', 'dockerfile', 'makefile', 'readme', 'license',
])
const execFile = promisify(execFileCallback)

export function resolveSvnExecutableCandidates(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): string[] {
  const candidates = [env.SVN_EXECUTABLE?.trim(), 'svn']

  if (platform === 'win32') {
    const programFilesRoots = [
      env.ProgramW6432,
      env.ProgramFiles,
      env['ProgramFiles(x86)'],
    ]
    for (const root of programFilesRoots) {
      if (!root) continue
      candidates.push(
        path.join(root, 'TortoiseSVN', 'bin', 'svn.exe'),
        path.join(root, 'Subversion', 'bin', 'svn.exe'),
      )
    }
    if (env.LOCALAPPDATA) {
      candidates.push(path.join(env.LOCALAPPDATA, 'Programs', 'TortoiseSVN', 'bin', 'svn.exe'))
    }
  }

  const seen = new Set<string>()
  return candidates.flatMap((candidate) => {
    if (!candidate) return []
    const key = platform === 'win32' ? candidate.toLowerCase() : candidate
    if (seen.has(key)) return []
    seen.add(key)
    return [candidate]
  })
}

function decodeWorkspaceText(buffer: Buffer, requestedEncoding: WorkspaceTextEncoding): { content: string; encoding: WorkspaceTextEncoding } {
  const encoding = requestedEncoding === 'auto' ? detectWorkspaceTextEncoding(buffer) : requestedEncoding
  return {
    content: new TextDecoder(encoding === 'gbk' ? 'gbk' : 'utf-8').decode(buffer),
    encoding,
  }
}

function decodeCommandOutput(value: string | Buffer | undefined): string {
  if (typeof value === 'string') return value
  return value ? decodeWorkspaceText(value, 'auto').content : ''
}

function detectWorkspaceTextEncoding(buffer: Buffer): WorkspaceTextEncoding {
  // Inspect enough of legacy source files to get past long ASCII headers. When
  // the sample stops in the middle of a UTF-8 character, streaming validation
  // keeps that incomplete trailing sequence from becoming a false GBK signal.
  const sample = buffer.subarray(0, AUTO_ENCODING_SAMPLE_BYTES)
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(sample, { stream: sample.length < buffer.length })
    return 'utf8'
  } catch {
    return 'gbk'
  }
}

function isVcsMetadataDirectoryName(name: string): boolean {
  return VCS_METADATA_DIRECTORY_NAMES.has(name.toLowerCase())
}

const LANGUAGE_MAP: Record<string, string> = {
  bash: 'bash',
  bat: 'bat',
  c: 'c',
  cc: 'cpp',
  cjs: 'javascript',
  cmd: 'bat',
  cpp: 'cpp',
  cs: 'csharp',
  css: 'css',
  cts: 'typescript',
  cxx: 'cpp',
  go: 'go',
  h: 'cpp',
  hh: 'cpp',
  hpp: 'cpp',
  hxx: 'cpp',
  html: 'html',
  inl: 'cpp',
  java: 'java',
  js: 'javascript',
  json: 'json',
  jsx: 'jsx',
  lua: 'lua',
  md: 'markdown',
  mjs: 'javascript',
  mts: 'typescript',
  ps1: 'powershell',
  py: 'python',
  rs: 'rust',
  sh: 'bash',
  shell: 'bash',
  sln: 'ini',
  sql: 'sql',
  ts: 'typescript',
  tsx: 'tsx',
  txt: 'text',
  vcproj: 'xml',
  vcxproj: 'xml',
  xml: 'xml',
  yaml: 'yaml',
  yml: 'yaml',
  zsh: 'bash',
}

const IMAGE_MIME_BY_EXTENSION: Record<string, string> = {
  apng: 'image/apng',
  avif: 'image/avif',
  gif: 'image/gif',
  jpeg: 'image/jpeg',
  jpg: 'image/jpeg',
  png: 'image/png',
  svg: 'image/svg+xml',
  webp: 'image/webp',
}

export type WorkspaceFileStatus =
  | 'modified'
  | 'added'
  | 'deleted'
  | 'renamed'
  | 'untracked'
  | 'copied'
  | 'type_changed'
  | 'unknown'

export type WorkspaceChangedFile = {
  path: string
  oldPath?: string
  status: WorkspaceFileStatus
  additions: number
  deletions: number
  isDirectory?: boolean
  isSymlink?: boolean
}

export type WorkspaceStatusResult = {
  state: 'ok' | 'not_git_repo' | 'missing_workdir' | 'error'
  workDir: string
  repoName: string | null
  branch: string | null
  isGitRepo: boolean
  changedFiles: WorkspaceChangedFile[]
  error?: string
}

export type WorkspaceReadFileResult = {
  state: 'ok' | 'binary' | 'too_large' | 'missing' | 'error'
  path: string
  previewType?: 'text' | 'image'
  content?: string
  dataUrl?: string
  mimeType?: string
  language: string
  size: number
  truncated?: boolean
  readBytes?: number
  encoding?: WorkspaceTextEncoding
  error?: string
}

export type WorkspaceTreeEntry = {
  name: string
  path: string
  isDirectory: boolean
  /** A directory link is intentionally browseable in the local file viewer. */
  isSymlink?: boolean
}

export type WorkspaceTreeResult = {
  state: 'ok' | 'missing' | 'error'
  path: string
  entries: WorkspaceTreeEntry[]
  error?: string
}

export type WorkspaceDiffResult = {
  state: 'ok' | 'missing' | 'not_git_repo' | 'error'
  path: string
  diff?: string
  comparison?: WorkspaceComparison
  error?: string
}

export type WorkspaceComparisonSourceKind =
  | 'git_head'
  | 'svn_base'
  | 'session_baseline'
  | 'working_tree'
  | 'empty'

export type WorkspaceComparisonSideState =
  | 'ok'
  | 'missing'
  | 'binary'
  | 'undecodable'
  | 'too_large'
  | 'unavailable'

export type WorkspaceComparisonSide = {
  source: {
    kind: WorkspaceComparisonSourceKind
    path: string
    revision: string
  }
  exists: boolean
  state: WorkspaceComparisonSideState
  content?: string
  contentFingerprint?: string
  size?: number
  requestedEncoding: WorkspaceTextEncoding
  actualEncoding?: Exclude<WorkspaceTextEncoding, 'auto'>
  bom: 'utf8' | 'none' | 'unknown'
  lineEnding: 'lf' | 'crlf' | 'cr' | 'mixed' | 'none' | 'unknown'
  writable: boolean
  readOnlyReason?: string
  error?: string
}

export type WorkspaceComparison = {
  schemaVersion: 1
  left: WorkspaceComparisonSide
  right: WorkspaceComparisonSide
}

export type WorkspaceWriteResult = {
  state: 'ok' | 'conflict' | 'missing' | 'binary' | 'error'
  path: string
  content?: string
  size?: number
  contentFingerprint?: string
  actualEncoding?: Exclude<WorkspaceTextEncoding, 'auto'>
  bom?: 'utf8' | 'none'
  lineEnding?: WorkspaceComparisonSide['lineEnding']
  error?: string
}

export type WorkspaceWriteOptions = {
  expectedFingerprint?: string | null
  encoding?: Exclude<WorkspaceTextEncoding, 'auto'>
  bom?: 'utf8' | 'none'
  lineEnding?: WorkspaceComparisonSide['lineEnding']
}

type StatusEntry = {
  path: string
  oldPath?: string
  code: string
  status: WorkspaceFileStatus
  isDirectory?: boolean
  isSymlink?: boolean
}

export type WorkspaceTextEncoding = 'auto' | 'utf8' | 'gbk'

type ScopedStatusEntry = {
  repoPath: string
  repoOldPath?: string
  path: string
  oldPath?: string
  status: WorkspaceFileStatus
  isDirectory?: boolean
  absolutePath: string
  canonicalWorkspaceRoot: string
}

type GitRepoInfo =
  | {
      kind: 'not_git_repo'
    }
  | {
      kind: 'ok'
      repoRoot: string
      branch: string | null
    }
  | {
      kind: 'error'
      message: string
    }

type SvnWorkspaceInfo =
  | { kind: 'not_svn_workspace' }
  | { kind: 'ok'; workspaceRoot: string }
  | { kind: 'error'; message: string }

type WorkspacePathResolution = {
  requestedPath: string
  relativePath: string
  absolutePath: string
  workspaceRoot: string
  canonicalWorkspaceRoot: string
  canonicalTargetPath: string
  isExternalRoot: boolean
}

type WorkspaceStatResult =
  | {
      kind: 'ok'
      stat: Awaited<ReturnType<typeof fs.stat>>
    }
  | {
      kind: 'missing'
    }
  | {
      kind: 'error'
      message: string
    }

type GitCommandResult = {
  stdout: string
  stderr: string
  code: number
  failure?: string
  outputLimitExceeded?: boolean
}

type BufferCommandResult = {
  stdout: Buffer
  stderr: string
  code: number
  failure?: string
  outputLimitExceeded?: boolean
}

type DiffStatsResult =
  | {
      kind: 'ok'
      additions: number
      deletions: number
    }
  | {
      kind: 'error'
      message: string
    }

type DiffStatsByRepoPathResult =
  | {
      kind: 'ok'
      statsByRepoPath: Map<string, { additions: number; deletions: number }>
    }
  | {
      kind: 'error'
      message: string
    }

type UntrackedDiffResult =
  | {
      kind: 'ok'
      diff: string
    }
  | {
      kind: 'missing'
    }
  | {
      kind: 'error'
      message: string
  }

type SessionFileChange = WorkspaceChangedFile & {
  diff?: string
}

export function parseStatus(code: string): WorkspaceFileStatus {
  const x = code[0] ?? ' '
  const y = code[1] ?? ' '

  if (code === '??') return 'untracked'
  if (x === 'R' || y === 'R') return 'renamed'
  if (x === 'C' || y === 'C') return 'copied'
  if (x === 'T' || y === 'T') return 'type_changed'
  if (x === 'D' || y === 'D') return 'deleted'
  if (x === 'A' || y === 'A') return 'added'
  if (x === 'M' || y === 'M') return 'modified'
  return 'unknown'
}

export class WorkspaceService {
  private readonly statusRequestsInFlight = new Map<string, Promise<WorkspaceStatusResult>>()

  constructor(
    private readonly resolveSessionWorkDir: (
      sessionId: string,
    ) => Promise<string | null>,
    private readonly resolveSessionMessages: (
      sessionId: string,
    ) => Promise<MessageEntry[]> = async () => [],
    private readonly resolveSessionFileHistorySnapshots: (
      sessionId: string,
    ) => Promise<FileHistorySnapshot[]> = async () => [],
    private readonly resolveSvnExecutables: () => string[] = resolveSvnExecutableCandidates,
  ) {}

  /**
   * Explicitly grant the local file viewer read access to an additional root.
   * This is a user-selected, read-only viewer capability; it does not change
   * an agent session's working directory or grant write permission.
   */
  async registerExternalRoot(rootPath: string): Promise<string> {
    const absolutePath = path.resolve(normalizeDriveRootPathForPlatform(rootPath))
    const stat = await this.safeStat(absolutePath)
    if (stat.kind === 'missing' || !stat.stat.isDirectory()) {
      throw new Error(`Additional workspace folder is missing or not a directory: ${rootPath}`)
    }

    if (stat.kind === 'error') throw new Error(stat.message)
    registerFilesystemAccessRoot(absolutePath)
    return absolutePath
  }

  async getStatus(sessionId: string): Promise<WorkspaceStatusResult> {
    const existingRequest = this.statusRequestsInFlight.get(sessionId)
    if (existingRequest) return existingRequest

    const request = this.computeStatus(sessionId)
    this.statusRequestsInFlight.set(sessionId, request)
    try {
      return await request
    } finally {
      if (this.statusRequestsInFlight.get(sessionId) === request) {
        this.statusRequestsInFlight.delete(sessionId)
      }
    }
  }

  private async computeStatus(sessionId: string): Promise<WorkspaceStatusResult> {
    const workDir = await this.requireWorkDir(sessionId)
    const workspaceInfo = await this.getWorkspaceRoot(workDir)
    if (workspaceInfo.kind === 'missing') {
      return {
        state: 'missing_workdir',
        workDir,
        repoName: null,
        branch: null,
        isGitRepo: false,
        changedFiles: [],
      }
    }
    if (workspaceInfo.kind === 'error') {
      return {
        state: 'error',
        workDir,
        repoName: null,
        branch: null,
        isGitRepo: false,
        changedFiles: [],
        error: workspaceInfo.message,
      }
    }

    const repoInfo = await this.getGitRepoInfo(workDir)
    const sessionChanges = this.mergeSessionFileChanges(
      [
        ...await this.getSessionFileChanges(
          sessionId,
          workspaceInfo.workspaceRoot,
        ),
        ...await this.getFileHistoryChanges(
          sessionId,
          workspaceInfo.workspaceRoot,
        ),
      ],
    )
    const linkedDirectoryChanges = await this.getLinkedSvnDirectoryChanges(
      workspaceInfo.workspaceRoot,
    )

    if (repoInfo.kind === 'not_git_repo') {
      const svnInfo = await this.getSvnWorkspaceInfo(workDir)
      if (svnInfo.kind === 'ok') {
        const svnStatus = await this.getSvnStatus(
          workspaceInfo,
          svnInfo.workspaceRoot,
          sessionChanges,
        )
        if (svnStatus.state === 'ok') {
          svnStatus.changedFiles = this.mergeLinkedDirectoryChanges(
            svnStatus.changedFiles,
            linkedDirectoryChanges,
          )
        }
        return svnStatus
      }
      if (svnInfo.kind === 'error') {
        return {
          state: 'error',
          workDir,
          repoName: null,
          branch: null,
          isGitRepo: false,
          changedFiles: [],
          error: svnInfo.message,
        }
      }
      sessionChanges.sort((a, b) => a.path.localeCompare(b.path))
      return {
        state: 'ok',
        workDir,
        repoName: path.basename(workspaceInfo.workspaceRoot),
        branch: null,
        isGitRepo: false,
        changedFiles: this.mergeLinkedDirectoryChanges(
          sessionChanges.map(({ diff: _diff, ...change }) => change),
          linkedDirectoryChanges,
        ),
      }
    }
    if (repoInfo.kind === 'error') {
      return {
        state: 'error',
        workDir,
        repoName: null,
        branch: null,
        isGitRepo: false,
        changedFiles: [],
        error: repoInfo.message,
      }
    }

    const statusEntries = await this.getStatusEntries(repoInfo.repoRoot)
    if (statusEntries.kind === 'error') {
      return {
        state: 'error',
        workDir,
        repoName: path.basename(repoInfo.repoRoot),
        branch: repoInfo.branch,
        isGitRepo: true,
        changedFiles: [],
        error: statusEntries.message,
      }
    }
    const linkedRootPaths = linkedDirectoryChanges
      .filter((change) => change.isDirectory && change.isSymlink)
      .map((change) => change.path)
    const scopedEntries = this.scopeStatusEntries(
      statusEntries.entries,
      repoInfo.repoRoot,
      workspaceInfo.canonicalWorkspaceRoot,
    ).filter((entry) => !linkedRootPaths.some((linkedRoot) => (
      entry.path === linkedRoot || entry.path.startsWith(`${linkedRoot}/`)
    )))
    const trackedStats = await this.getTrackedDiffStats(repoInfo.repoRoot, scopedEntries)
    if (trackedStats.kind === 'error') {
      return {
        state: 'error',
        workDir,
        repoName: path.basename(repoInfo.repoRoot),
        branch: repoInfo.branch,
        isGitRepo: true,
        changedFiles: [],
        error: trackedStats.message,
      }
    }

    const changedFiles = await Promise.all(
      scopedEntries.map(async (entry) => {
        const stats = entry.isDirectory
          ? { kind: 'ok' as const, additions: 0, deletions: 0 }
          : entry.status === 'untracked'
          ? await this.getDiffStats(repoInfo.repoRoot, entry)
          : {
              kind: 'ok' as const,
              ...(trackedStats.statsByRepoPath.get(entry.repoPath) ?? {
                additions: 0,
                deletions: 0,
              }),
            }

        if (stats.kind === 'error') {
          throw new Error(stats.message)
        }

        return {
          path: entry.path,
          oldPath: entry.oldPath,
          status: entry.status,
          additions: stats.additions,
          deletions: stats.deletions,
          ...(entry.isDirectory ? { isDirectory: true } : {}),
        } satisfies WorkspaceChangedFile
      }),
    ).catch((error) => error as Error)

    if (changedFiles instanceof Error) {
      return {
        state: 'error',
        workDir,
        repoName: path.basename(repoInfo.repoRoot),
        branch: repoInfo.branch,
        isGitRepo: true,
        changedFiles: [],
        error: changedFiles.message,
      }
    }

    changedFiles.sort((a, b) => a.path.localeCompare(b.path))
    const changedFileByPath = new Map(changedFiles.map((file) => [file.path, file]))
    for (const change of sessionChanges) {
      if (!changedFileByPath.has(change.path)) {
        changedFileByPath.set(change.path, {
          path: change.path,
          oldPath: change.oldPath,
          status: change.status,
          additions: change.additions,
          deletions: change.deletions,
        })
      }
    }
    const mergedChangedFiles = [...changedFileByPath.values()]
      .sort((a, b) => a.path.localeCompare(b.path))

    return {
      state: 'ok',
      workDir,
      repoName: path.basename(repoInfo.repoRoot),
      branch: repoInfo.branch,
      isGitRepo: true,
      changedFiles: this.mergeLinkedDirectoryChanges(
        mergedChangedFiles,
        linkedDirectoryChanges,
      ),
    }
  }

  async readFile(
    sessionId: string,
    filePath: string,
    requestedEncoding: WorkspaceTextEncoding = 'auto',
  ): Promise<WorkspaceReadFileResult> {
    const resolvedPath = await this.resolveWorkspacePath(sessionId, filePath)

    const stat = await this.safeStat(resolvedPath.absolutePath)
    if (stat.kind === 'error') {
      return {
        state: 'error',
        path: resolvedPath.relativePath,
        language: this.detectLanguage(resolvedPath.absolutePath),
        size: 0,
        error: stat.message,
      }
    }
    if (stat.kind === 'missing' || !stat.stat.isFile()) {
      return {
        state: 'missing',
        path: resolvedPath.relativePath,
        language: this.detectLanguage(resolvedPath.absolutePath),
        size: 0,
      }
    }

    const language = this.detectLanguage(resolvedPath.absolutePath)
    const imageMimeType = this.detectImageMimeType(resolvedPath.absolutePath)

    let content: Buffer
    try {
      if (!imageMimeType && stat.stat.size > MAX_PREVIEW_BYTES) {
        const fileHandle = await fs.open(resolvedPath.absolutePath, 'r')
        try {
          const previewBuffer = Buffer.alloc(MAX_PREVIEW_BYTES)
          const { bytesRead } = await fileHandle.read(previewBuffer, 0, MAX_PREVIEW_BYTES, 0)
          content = previewBuffer.subarray(0, bytesRead)
        } finally {
          await fileHandle.close()
        }
      } else {
        content = await fs.readFile(resolvedPath.absolutePath)
      }
    } catch (error) {
      return {
        state: 'error',
        path: resolvedPath.relativePath,
        language,
        size: stat.stat.size,
        error: this.formatFsError(
          'Failed to read workspace file',
          resolvedPath.absolutePath,
          error,
        ),
      }
    }
    if (imageMimeType) {
      return {
        state: 'ok',
        path: resolvedPath.relativePath,
        previewType: 'image',
        dataUrl: `data:${imageMimeType};base64,${content.toString('base64')}`,
        mimeType: imageMimeType,
        language: 'image',
        size: stat.stat.size,
      }
    }

    if (content.includes(0)) {
      return {
        state: 'binary',
        path: resolvedPath.relativePath,
        language: 'binary',
        size: stat.stat.size,
      }
    }

    return {
      state: 'ok',
      path: resolvedPath.relativePath,
      previewType: 'text',
      ...decodeWorkspaceText(content, requestedEncoding),
      language,
      size: stat.stat.size,
      truncated: content.length < stat.stat.size,
      readBytes: content.length,
    }
  }

  /**
   * Applies an explicit user review edit. `expectedContent` is an optimistic
   * concurrency guard: review actions must not overwrite a file the user or
   * another agent changed after the diff was rendered.
   */
  async writeTextFile(
    sessionId: string,
    filePath: string,
    expectedContent: string | null,
    content: string | null,
    options?: WorkspaceWriteOptions,
  ): Promise<WorkspaceWriteResult> {
    let resolvedPath: WorkspacePathResolution
    try {
      resolvedPath = await this.resolveWorkspacePath(sessionId, filePath)
    } catch (error) {
      return {
        state: 'error',
        path: this.normalizeRequestedPath(filePath),
        error: error instanceof Error ? error.message : String(error),
      }
    }

    if (resolvedPath.isExternalRoot) {
      return {
        state: 'error',
        path: resolvedPath.relativePath,
        error: 'Registered external roots are read-only.',
      }
    }

    if (options?.expectedFingerprint !== undefined) {
      return await this.writeTextFileWithRawCas(resolvedPath, content, options)
    }

    const current = await this.readTextFileForWrite(resolvedPath.absolutePath)
    if (current.kind === 'error') {
      return { state: 'error', path: resolvedPath.relativePath, error: current.message }
    }
    if (current.kind === 'binary') {
      return { state: 'binary', path: resolvedPath.relativePath }
    }
    if (current.content !== expectedContent) {
      return {
        state: 'conflict',
        path: resolvedPath.relativePath,
        error: 'The file changed after this review was opened. Refresh the diff and try again.',
      }
    }

    if (current.content === null && content !== null) {
      return await this.createTextFileExclusively(resolvedPath, content)
    }

    try {
      if (content === null) {
        if (current.content === null) return { state: 'missing', path: resolvedPath.relativePath }
        await fs.unlink(resolvedPath.absolutePath)
        return { state: 'ok', path: resolvedPath.relativePath }
      }

      await fs.writeFile(resolvedPath.absolutePath, content, 'utf8')
      return {
        state: 'ok',
        path: resolvedPath.relativePath,
        content,
        size: Buffer.byteLength(content),
      }
    } catch (error) {
      return {
        state: 'error',
        path: resolvedPath.relativePath,
        error: this.formatFsError('Failed to write workspace file', resolvedPath.absolutePath, error),
      }
    }
  }

  /** Restores a whole reviewed file to its VCS or session-snapshot baseline. */
  async revertFile(
    sessionId: string,
    filePath: string,
    expectedContent: string | null,
  ): Promise<WorkspaceWriteResult> {
    let resolvedPath: WorkspacePathResolution
    try {
      resolvedPath = await this.resolveWorkspacePath(sessionId, filePath)
    } catch (error) {
      return {
        state: 'error',
        path: this.normalizeRequestedPath(filePath),
        error: error instanceof Error ? error.message : String(error),
      }
    }
    const current = await this.readTextFileForWrite(resolvedPath.absolutePath)
    if (current.kind === 'error') return { state: 'error', path: resolvedPath.relativePath, error: current.message }
    if (current.kind === 'binary') return { state: 'binary', path: resolvedPath.relativePath }
    if (current.content !== expectedContent) {
      return {
        state: 'conflict',
        path: resolvedPath.relativePath,
        error: 'The file changed after this review was opened. Refresh the diff and try again.',
      }
    }

    const gitInfo = await this.getGitRepoInfo(resolvedPath.workspaceRoot)
    if (gitInfo.kind === 'ok') {
      const repoPath = this.toRepoRelativePath(gitInfo.repoRoot, resolvedPath.canonicalTargetPath)
      const statusEntries = await this.getStatusEntries(gitInfo.repoRoot)
      if (statusEntries.kind === 'error') return { state: 'error', path: resolvedPath.relativePath, error: statusEntries.message }
      const entry = statusEntries.entries.find((candidate) => candidate.path === repoPath || candidate.oldPath === repoPath)
      if (!entry) return { state: 'missing', path: resolvedPath.relativePath }
      if (entry.status === 'untracked') {
        if (current.content !== null) await fs.unlink(resolvedPath.absolutePath)
        return { state: 'ok', path: resolvedPath.relativePath }
      }
      const result = await this.runGit(gitInfo.repoRoot, ['restore', '--source=HEAD', '--staged', '--worktree', '--', repoPath])
      if (result.code !== 0) {
        return { state: 'error', path: resolvedPath.relativePath, error: this.formatGitError('Failed to revert reviewed file', ['restore', '--source=HEAD', '--staged', '--worktree', '--', repoPath], gitInfo.repoRoot, result) }
      }
      return await this.readWrittenTextResult(resolvedPath)
    }

    const svnInfo = gitInfo.kind === 'not_git_repo'
      ? await this.getSvnWorkspaceInfo(resolvedPath.workspaceRoot)
      : { kind: 'not_svn_workspace' as const }
    if (svnInfo.kind === 'ok') {
      const repoPath = this.toRepoRelativePath(svnInfo.workspaceRoot, resolvedPath.canonicalTargetPath)
      const entries = await this.getSvnStatusEntries(svnInfo.workspaceRoot)
      if (entries.kind === 'error') return { state: 'error', path: resolvedPath.relativePath, error: entries.message }
      const entry = entries.entries.find((candidate) => candidate.path === repoPath)
      if (!entry) return { state: 'missing', path: resolvedPath.relativePath }
      if (entry.status === 'untracked') {
        if (current.content !== null) await fs.unlink(resolvedPath.absolutePath)
        return { state: 'ok', path: resolvedPath.relativePath }
      }
      const result = await this.runSvn(svnInfo.workspaceRoot, ['revert', '--', repoPath])
      if (result.code !== 0) {
        return { state: 'error', path: resolvedPath.relativePath, error: this.formatSvnError('Failed to revert reviewed file', ['revert', '--', repoPath], svnInfo.workspaceRoot, result) }
      }
      return await this.readWrittenTextResult(resolvedPath)
    }

    const snapshots = await this.resolveSessionFileHistorySnapshots(sessionId).catch(() => [])
    const trackingPath = [...this.collectFileHistoryTrackedPaths(snapshots)].find((candidate) => (
      this.resolveFileHistoryRelativePath(candidate, resolvedPath.workspaceRoot) === resolvedPath.relativePath
    ))
    if (!trackingPath) return { state: 'missing', path: resolvedPath.relativePath }
    const baseline = await this.readFileHistoryBackupContent(
      sessionId,
      this.getEarliestFileHistoryBackupName(trackingPath, snapshots),
    )
    if (baseline === undefined) return { state: 'missing', path: resolvedPath.relativePath }
    try {
      if (baseline === null) {
        if (current.content !== null) await fs.unlink(resolvedPath.absolutePath)
        return { state: 'ok', path: resolvedPath.relativePath }
      }
      await fs.mkdir(path.dirname(resolvedPath.absolutePath), { recursive: true })
      await fs.writeFile(resolvedPath.absolutePath, baseline, 'utf8')
      return { state: 'ok', path: resolvedPath.relativePath, content: baseline, size: Buffer.byteLength(baseline) }
    } catch (error) {
      return { state: 'error', path: resolvedPath.relativePath, error: this.formatFsError('Failed to revert reviewed file', resolvedPath.absolutePath, error) }
    }
  }

  async readTree(
    sessionId: string,
    treePath = '',
  ): Promise<WorkspaceTreeResult> {
    const resolvedPath = await this.resolveWorkspacePath(sessionId, treePath)

    const stat = await this.safeStat(resolvedPath.absolutePath)
    if (stat.kind === 'error') {
      return {
        state: 'error',
        path: resolvedPath.relativePath,
        entries: [],
        error: stat.message,
      }
    }
    if (stat.kind === 'missing' || !stat.stat.isDirectory()) {
      return { state: 'missing', path: resolvedPath.relativePath, entries: [] }
    }

    let entries: import('node:fs').Dirent[]
    try {
      entries = await fs.readdir(resolvedPath.absolutePath, { withFileTypes: true })
    } catch (error) {
      return {
        state: 'error',
        path: resolvedPath.relativePath,
        entries: [],
        error: this.formatFsError(
          'Failed to read workspace directory',
          resolvedPath.absolutePath,
          error,
        ),
      }
    }
    const entriesWithMetadata = await Promise.all(entries.map(async (entry) => {
      const absoluteEntryPath = path.join(resolvedPath.absolutePath, entry.name)
      const isSymlink = entry.isSymbolicLink()
      let isDirectory = entry.isDirectory()
      if (isSymlink) {
        const targetStat = await this.safeStat(absoluteEntryPath)
        isDirectory = targetStat.kind === 'ok' && targetStat.stat.isDirectory()
        // A directory symlink is an intentional local navigation edge. Add it
        // as a viewer root so following it does not get rejected merely because
        // its target is outside the session's primary working directory.
        if (isDirectory) registerFilesystemAccessRoot(absoluteEntryPath)
      }
      return { entry, absoluteEntryPath, isDirectory, isSymlink }
    }))
    const visibleEntries = entriesWithMetadata
      .filter(({ entry, isDirectory }) => !(isDirectory && isVcsMetadataDirectoryName(entry.name)))
      .sort((a, b) => {
        if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1
        return a.entry.name.localeCompare(b.entry.name)
      })
      .map(({ entry, absoluteEntryPath, isDirectory, isSymlink }) => ({
        name: entry.name,
        path: this.resolveTreeEntryPath(resolvedPath, absoluteEntryPath, entry.name),
        isDirectory,
        ...(isSymlink ? { isSymlink: true } : {}),
      }))

    return {
      state: 'ok',
      path: resolvedPath.relativePath,
      entries: visibleEntries,
    }
  }

  async getDiff(
    sessionId: string,
    filePath: string,
    leftRequestedEncoding: WorkspaceTextEncoding = 'auto',
    rightRequestedEncoding: WorkspaceTextEncoding = leftRequestedEncoding,
  ): Promise<WorkspaceDiffResult> {
    let resolvedPath: WorkspacePathResolution
    try {
      resolvedPath = await this.resolveWorkspacePath(sessionId, filePath)
    } catch (error) {
      return {
        state: 'error',
        path: this.normalizeRequestedPath(filePath),
        error: error instanceof Error ? error.message : String(error),
      }
    }

    const vcsProbePath = await this.findNearestExistingDirectory(
      path.dirname(resolvedPath.canonicalTargetPath),
      resolvedPath.canonicalWorkspaceRoot,
    )
    const repoInfo = await this.getGitRepoInfo(vcsProbePath)
    if (repoInfo.kind === 'not_git_repo') {
      const svnInfo = await this.getSvnWorkspaceInfo(vcsProbePath)
      if (svnInfo.kind === 'ok') {
        return await this.getSvnDiff(
          sessionId,
          resolvedPath,
          svnInfo.workspaceRoot,
          leftRequestedEncoding,
          rightRequestedEncoding,
        )
      }
      if (svnInfo.kind === 'error') {
        return {
          state: 'error',
          path: resolvedPath.relativePath,
          error: svnInfo.message,
        }
      }
      const storedDiff = await this.getStoredWorkspaceDiff(
        sessionId,
        resolvedPath.workspaceRoot,
        resolvedPath.relativePath,
      )
      if (storedDiff) {
        return {
          state: 'ok',
          path: resolvedPath.relativePath,
          diff: storedDiff,
          ...await this.getFileHistoryComparisonResult(sessionId, resolvedPath, leftRequestedEncoding, rightRequestedEncoding),
        }
      }
      return { state: 'not_git_repo', path: resolvedPath.relativePath }
    }
    if (repoInfo.kind === 'error') {
      const storedDiff = await this.getStoredWorkspaceDiff(
        sessionId,
        resolvedPath.workspaceRoot,
        resolvedPath.relativePath,
      )
      if (storedDiff) {
        return {
          state: 'ok',
          path: resolvedPath.relativePath,
          diff: storedDiff,
          ...await this.getFileHistoryComparisonResult(sessionId, resolvedPath, leftRequestedEncoding, rightRequestedEncoding),
        }
      }
      return {
        state: 'error',
        path: resolvedPath.relativePath,
        error: repoInfo.message,
      }
    }

    const statusEntries = await this.getStatusEntries(repoInfo.repoRoot)
    if (statusEntries.kind === 'error') {
      const storedDiff = await this.getStoredWorkspaceDiff(
        sessionId,
        resolvedPath.workspaceRoot,
        resolvedPath.relativePath,
      )
      if (storedDiff) {
        return {
          state: 'ok',
          path: resolvedPath.relativePath,
          diff: storedDiff,
          ...await this.getFileHistoryComparisonResult(sessionId, resolvedPath, leftRequestedEncoding, rightRequestedEncoding),
        }
      }
      return {
        state: 'error',
        path: resolvedPath.relativePath,
        error: statusEntries.message,
      }
    }
    const scopedEntries = this.scopeStatusEntries(
      statusEntries.entries,
      repoInfo.repoRoot,
      resolvedPath.canonicalWorkspaceRoot,
    )
    const repoRelativePath = this.toRepoRelativePath(
      repoInfo.repoRoot,
      resolvedPath.canonicalTargetPath,
    )

    const statusEntry = scopedEntries.find(
      (entry) =>
        entry.repoPath === repoRelativePath ||
        entry.repoOldPath === repoRelativePath,
    )

    if (!statusEntry) {
      const storedDiff = await this.getStoredWorkspaceDiff(
        sessionId,
        resolvedPath.workspaceRoot,
        resolvedPath.relativePath,
      )
      if (storedDiff) {
        return {
          state: 'ok',
          path: resolvedPath.relativePath,
          diff: storedDiff,
          ...await this.getFileHistoryComparisonResult(sessionId, resolvedPath, leftRequestedEncoding, rightRequestedEncoding),
        }
      }
      return { state: 'missing', path: resolvedPath.relativePath }
    }

    if (statusEntry.status === 'untracked') {
      const diff = await this.buildUntrackedDiff(
        resolvedPath.canonicalTargetPath,
        resolvedPath.relativePath,
        rightRequestedEncoding,
      )
      if (diff.kind === 'missing') {
        return { state: 'missing', path: resolvedPath.relativePath }
      }
      if (diff.kind === 'error') {
        return {
          state: 'error',
          path: resolvedPath.relativePath,
          error: diff.message,
        }
      }
      return {
        state: 'ok',
        path: resolvedPath.relativePath,
        diff: diff.diff,
        comparison: await this.buildGitComparison(
          resolvedPath,
          repoInfo.repoRoot,
          statusEntry,
          leftRequestedEncoding,
          rightRequestedEncoding,
        ),
      }
    }

    const targetPath = statusEntry.repoPath
    const diff = await this.runGitDiff(repoInfo.repoRoot, targetPath, rightRequestedEncoding)
    if (diff.kind === 'error') {
      return {
        state: 'error',
        path: resolvedPath.relativePath,
        error: diff.message,
        comparison: await this.buildGitComparison(
          resolvedPath,
          repoInfo.repoRoot,
          statusEntry,
          leftRequestedEncoding,
          rightRequestedEncoding,
        ),
      }
    }
    if (!diff.diff.trim()) {
      return { state: 'missing', path: resolvedPath.relativePath }
    }

    return {
      state: 'ok',
      path: resolvedPath.relativePath,
      diff: diff.diff,
      comparison: await this.buildGitComparison(
        resolvedPath,
        repoInfo.repoRoot,
        statusEntry,
        leftRequestedEncoding,
        rightRequestedEncoding,
      ),
    }
  }

  private async buildGitComparison(
    resolvedPath: WorkspacePathResolution,
    repoRoot: string,
    entry: ScopedStatusEntry,
    leftRequestedEncoding: WorkspaceTextEncoding,
    rightRequestedEncoding: WorkspaceTextEncoding,
  ): Promise<WorkspaceComparison> {
    const leftPath = entry.repoOldPath ?? entry.repoPath
    const left = entry.status === 'added' || entry.status === 'untracked'
      ? this.buildMissingComparisonSide('empty', leftPath, leftRequestedEncoding, false, 'Baseline side does not exist.')
      : await this.readGitHeadComparisonSide(repoRoot, leftPath, leftRequestedEncoding)
    const right = await this.readWorkingComparisonSide(resolvedPath, rightRequestedEncoding)
    return { schemaVersion: 1, left, right }
  }

  private async buildSvnComparison(
    resolvedPath: WorkspacePathResolution,
    svnRoot: string,
    entry: ScopedStatusEntry,
    leftRequestedEncoding: WorkspaceTextEncoding,
    rightRequestedEncoding: WorkspaceTextEncoding,
  ): Promise<WorkspaceComparison> {
    const left = entry.status === 'added' || entry.status === 'untracked'
      ? this.buildMissingComparisonSide('empty', entry.repoPath, leftRequestedEncoding, false, 'Baseline side does not exist.')
      : await this.readSvnBaseComparisonSide(svnRoot, entry.repoPath, leftRequestedEncoding)
    const right = await this.readWorkingComparisonSide(resolvedPath, rightRequestedEncoding)
    return { schemaVersion: 1, left, right }
  }

  private async getFileHistoryComparisonResult(
    sessionId: string,
    resolvedPath: WorkspacePathResolution,
    leftRequestedEncoding: WorkspaceTextEncoding,
    rightRequestedEncoding: WorkspaceTextEncoding,
  ): Promise<{ comparison?: WorkspaceComparison }> {
    const snapshots = await this.resolveSessionFileHistorySnapshots(sessionId).catch(() => [])
    const trackingPath = [...this.collectFileHistoryTrackedPaths(snapshots)].find((candidate) => (
      this.resolveFileHistoryRelativePath(candidate, resolvedPath.workspaceRoot) === resolvedPath.relativePath
    ))
    if (!trackingPath) return {}

    const backupFileName = this.getEarliestFileHistoryBackupName(trackingPath, snapshots)
    if (backupFileName === undefined) return {}
    let left: WorkspaceComparisonSide
    if (backupFileName === null) {
      left = this.buildMissingComparisonSide(
        'empty',
        resolvedPath.relativePath,
        leftRequestedEncoding,
        false,
        'Session baseline side does not exist.',
      )
    } else {
      const backupPath = path.join(getClaudeConfigHomeDir(), 'file-history', sessionId, backupFileName)
      try {
        const buffer = await fs.readFile(backupPath)
        left = this.buildComparisonSideFromBuffer(
          buffer,
          'session_baseline',
          resolvedPath.relativePath,
          leftRequestedEncoding,
          false,
          'Session baselines are read-only.',
        )
      } catch (error) {
        left = this.buildUnavailableComparisonSide(
          'session_baseline',
          resolvedPath.relativePath,
          leftRequestedEncoding,
          this.formatFsError('Failed to read session baseline', backupPath, error),
        )
      }
    }

    return {
      comparison: {
        schemaVersion: 1,
        left,
        right: await this.readWorkingComparisonSide(resolvedPath, rightRequestedEncoding),
      },
    }
  }

  private async readGitHeadComparisonSide(
    repoRoot: string,
    repoPath: string,
    requestedEncoding: WorkspaceTextEncoding,
  ): Promise<WorkspaceComparisonSide> {
    const objectSpec = `HEAD:${repoPath}`
    const objectSize = await this.runGit(repoRoot, ['cat-file', '-s', objectSpec])
    const parsedSize = objectSize.code === 0 ? Number.parseInt(objectSize.stdout.trim(), 10) : Number.NaN
    if (Number.isFinite(parsedSize) && parsedSize > MAX_GIT_BUFFER_BYTES) {
      const objectRevision = await this.runGit(repoRoot, ['rev-parse', objectSpec])
      const revision = objectRevision.code === 0 && objectRevision.stdout.trim()
        ? `git-object:${objectRevision.stdout.trim()}`
        : `git-object-size:${parsedSize}`
      return {
        source: { kind: 'git_head', path: repoPath, revision },
        exists: true,
        state: 'too_large',
        contentFingerprint: revision,
        size: parsedSize,
        requestedEncoding,
        bom: 'unknown',
        lineEnding: 'unknown',
        writable: false,
        readOnlyReason: 'Git HEAD baselines are read-only.',
        error: `Workspace comparison source exceeds ${MAX_GIT_BUFFER_BYTES} bytes.`,
      }
    }

    const result = await this.runGitBuffer(repoRoot, ['show', objectSpec])
    if (result.code !== 0) {
      return this.buildUnavailableComparisonSide(
        'git_head',
        repoPath,
        requestedEncoding,
        this.formatGitError('Failed to read Git baseline', ['show', objectSpec], repoRoot, {
          stdout: '',
          stderr: result.stderr,
          code: result.code,
        }),
      )
    }
    return this.buildComparisonSideFromBuffer(
      result.stdout,
      'git_head',
      repoPath,
      requestedEncoding,
      false,
      'Git HEAD baselines are read-only.',
    )
  }

  private async readSvnBaseComparisonSide(
    svnRoot: string,
    repoPath: string,
    requestedEncoding: WorkspaceTextEncoding,
  ): Promise<WorkspaceComparisonSide> {
    const target = await this.resolveSvnBaseTarget(svnRoot, repoPath)
    if (target.kind === 'error') {
      return this.buildUnavailableComparisonSide(
        'svn_base',
        repoPath,
        requestedEncoding,
        target.message,
      )
    }
    const args = ['cat', '-r', target.revision, '--', target.target]
    const result = await this.runSvnBuffer(svnRoot, args)
    if (result.code !== 0) {
      return this.buildUnavailableComparisonSide(
        'svn_base',
        repoPath,
        requestedEncoding,
        this.formatSvnError('Failed to read SVN baseline', args, svnRoot, {
          stdout: '',
          stderr: result.stderr,
          code: result.code,
          failure: result.failure,
        }),
      )
    }
    return this.buildComparisonSideFromBuffer(
      result.stdout,
      'svn_base',
      repoPath,
      requestedEncoding,
      false,
      'SVN BASE baselines are read-only.',
    )
  }

  private async resolveSvnBaseTarget(
    svnRoot: string,
    repoPath: string,
  ): Promise<{ kind: 'ok'; target: string; revision: string } | { kind: 'error'; message: string }> {
    if (process.platform !== 'win32' || /^[\x00-\x7f]+$/.test(repoPath)) {
      return { kind: 'ok', target: repoPath, revision: 'BASE' }
    }

    // Some Windows/TortoiseSVN builds pass non-ASCII argv through the active
    // code page. Resolve both URL and BASE revision from the same target entry
    // while invoking `svn info` only with the ASCII `.` target. In particular,
    // a switched subtree must not inherit the working-copy root URL.
    const infoArgs = ['info', '--xml', '--depth', 'infinity', '.']
    const infoResult = await this.runSvn(svnRoot, infoArgs, MAX_SVN_STATUS_BUFFER_BYTES)
    if (infoResult.code !== 0) {
      return {
        kind: 'error',
        message: this.formatSvnError(
          'Failed to resolve SVN baseline revision',
          infoArgs,
          svnRoot,
          infoResult,
        ),
      }
    }
    return this.resolveSvnBaseIdentityFromInfo(repoPath, infoResult.stdout)
  }

  private resolveSvnBaseIdentityFromInfo(
    repoPath: string,
    infoXml: string,
  ): { kind: 'ok'; target: string; revision: string } | { kind: 'error'; message: string } {
    const normalizedRepoPath = this.normalizeRelativePath(repoPath)
    const lossyRepoPath = normalizedRepoPath.replace(/[^\x00-\x7f]/g, '?')
    const matchingEntries: Array<{
      revision?: string
      url?: string
      relativeUrl?: string
      repositoryRoot?: string
    }> = []
    for (const match of infoXml.matchAll(/<entry\s+([^>]+)>([\s\S]*?)<\/entry>/g)) {
      const attributes = match[1] ?? ''
      const body = match[2] ?? ''
      const entryPath = this.decodeXmlAttribute(/\bpath="([^"]+)"/.exec(attributes)?.[1] ?? '')
      const normalizedEntryPath = this.normalizeRelativePath(entryPath)
      if (
        normalizedEntryPath.toLowerCase() === normalizedRepoPath.toLowerCase()
        || normalizedEntryPath.toLowerCase() === lossyRepoPath.toLowerCase()
      ) {
        matchingEntries.push({
          revision: /\brevision="(\d+)"/.exec(attributes)?.[1],
          url: this.decodeXmlAttribute(/<url>([\s\S]*?)<\/url>/.exec(body)?.[1] ?? '').trim(),
          relativeUrl: this.decodeXmlAttribute(/<relative-url>([\s\S]*?)<\/relative-url>/.exec(body)?.[1] ?? '').trim(),
          repositoryRoot: this.decodeXmlAttribute(/<repository>[\s\S]*?<root>([\s\S]*?)<\/root>/.exec(body)?.[1] ?? '').trim(),
        })
      }
    }
    if (matchingEntries.length !== 1) {
      return {
        kind: 'error',
        message: `Failed to resolve a unique SVN baseline entry for ${this.limitCommandErrorText(repoPath)}.`,
      }
    }
    const [{ revision, url, relativeUrl, repositoryRoot }] = matchingEntries
    const target = url ? this.serializeSvnUrlForCommand(url) : null
    if (!revision || !target) {
      return {
        kind: 'error',
        message: `Failed to resolve a complete SVN baseline identity for ${this.limitCommandErrorText(repoPath)}.`,
      }
    }
    if (relativeUrl || repositoryRoot) {
      const root = repositoryRoot ? this.serializeSvnUrlForCommand(repositoryRoot) : null
      const relativePath = relativeUrl?.startsWith('^/') ? relativeUrl.slice(2) : null
      const expectedTarget = root && relativePath !== null
        ? this.serializeSvnUrlForCommand(`${root.replace(/\/+$/, '')}/${relativePath}`)
        : null
      if (!expectedTarget || expectedTarget !== target) {
        return {
          kind: 'error',
          message: `SVN baseline identity is inconsistent for ${this.limitCommandErrorText(repoPath)}.`,
        }
      }
    }
    return { kind: 'ok', target, revision }
  }

  private serializeSvnUrlForCommand(value: string): string | null {
    if (!value || /[\u0000-\u001f\u007f]/.test(value)) return null
    try {
      const serialized = new URL(value).href
      return /^[\x00-\x7f]+$/.test(serialized) ? serialized : null
    } catch {
      return null
    }
  }

  private async readWorkingComparisonSide(
    resolvedPath: WorkspacePathResolution,
    requestedEncoding: WorkspaceTextEncoding,
  ): Promise<WorkspaceComparisonSide> {
    const writable = await this.resolveWorkingSideWritable(resolvedPath)
    const stat = await this.safeStat(resolvedPath.absolutePath)
    if (stat.kind === 'error') {
      return this.buildUnavailableComparisonSide(
        'working_tree',
        resolvedPath.relativePath,
        requestedEncoding,
        stat.message,
        writable.writable,
        writable.readOnlyReason,
      )
    }
    if (stat.kind === 'missing' || !stat.stat.isFile()) {
      return this.buildMissingComparisonSide(
        'working_tree',
        resolvedPath.relativePath,
        requestedEncoding,
        writable.writable,
        writable.readOnlyReason,
      )
    }
    if (stat.stat.size > MAX_GIT_BUFFER_BYTES) {
      let fingerprint: string
      try {
        fingerprint = await this.fingerprintWorkspaceFile(resolvedPath.absolutePath)
      } catch (error) {
        return this.buildUnavailableComparisonSide(
          'working_tree',
          resolvedPath.relativePath,
          requestedEncoding,
          this.formatFsError('Failed to fingerprint workspace comparison source', resolvedPath.absolutePath, error),
          writable.writable,
          writable.readOnlyReason,
        )
      }
      return {
        source: {
          kind: 'working_tree',
          path: resolvedPath.relativePath,
          revision: fingerprint,
        },
        exists: true,
        state: 'too_large',
        contentFingerprint: fingerprint,
        size: stat.stat.size,
        requestedEncoding,
        bom: 'unknown',
        lineEnding: 'unknown',
        writable: writable.writable,
        ...(writable.readOnlyReason ? { readOnlyReason: writable.readOnlyReason } : {}),
        error: `Workspace comparison source exceeds ${MAX_GIT_BUFFER_BYTES} bytes.`,
      }
    }
    try {
      const buffer = await fs.readFile(resolvedPath.absolutePath)
      return this.buildComparisonSideFromBuffer(
        buffer,
        'working_tree',
        resolvedPath.relativePath,
        requestedEncoding,
        writable.writable,
        writable.readOnlyReason,
      )
    } catch (error) {
      return this.buildUnavailableComparisonSide(
        'working_tree',
        resolvedPath.relativePath,
        requestedEncoding,
        this.formatFsError('Failed to read workspace comparison source', resolvedPath.absolutePath, error),
        writable.writable,
        writable.readOnlyReason,
      )
    }
  }

  private buildComparisonSideFromBuffer(
    buffer: Buffer,
    sourceKind: Exclude<WorkspaceComparisonSourceKind, 'empty'>,
    sourcePath: string,
    requestedEncoding: WorkspaceTextEncoding,
    writable: boolean,
    readOnlyReason?: string,
  ): WorkspaceComparisonSide {
    const fingerprint = this.fingerprintWorkspaceBytes(buffer)
    const base = {
      source: { kind: sourceKind, path: sourcePath, revision: fingerprint },
      exists: true,
      size: buffer.length,
      contentFingerprint: fingerprint,
      requestedEncoding,
      writable,
      ...(!writable && readOnlyReason ? { readOnlyReason } : {}),
    }

    if (buffer.length > MAX_GIT_BUFFER_BYTES) {
      return {
        ...base,
        state: 'too_large',
        bom: this.detectComparisonBom(buffer),
        lineEnding: 'unknown',
        error: `Workspace comparison source exceeds ${MAX_GIT_BUFFER_BYTES} bytes.`,
      }
    }
    const bom = this.detectComparisonBom(buffer)
    if (bom === 'unknown') {
      return {
        ...base,
        state: 'undecodable',
        bom,
        lineEnding: 'unknown',
        error: 'UTF-16 and UTF-32 comparison sources are not supported yet.',
      }
    }
    if (buffer.includes(0)) {
      return { ...base, state: 'binary', bom, lineEnding: 'unknown' }
    }

    const actualEncoding = requestedEncoding === 'auto'
      ? detectWorkspaceTextEncoding(buffer)
      : requestedEncoding
    try {
      const content = new TextDecoder(actualEncoding === 'gbk' ? 'gbk' : 'utf-8', { fatal: true }).decode(buffer)
      return {
        ...base,
        state: 'ok',
        content,
        actualEncoding,
        bom,
        lineEnding: this.detectComparisonLineEnding(content),
      }
    } catch {
      return {
        ...base,
        state: 'undecodable',
        actualEncoding,
        bom,
        lineEnding: 'unknown',
        error: `Workspace comparison source cannot be decoded as ${actualEncoding}.`,
      }
    }
  }

  private async writeTextFileWithRawCas(
    resolvedPath: WorkspacePathResolution,
    content: string | null,
    options: WorkspaceWriteOptions & { expectedFingerprint?: string | null },
  ): Promise<WorkspaceWriteResult> {
    let currentBytes: Buffer | null
    try {
      currentBytes = await fs.readFile(resolvedPath.absolutePath)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') currentBytes = null
      else {
        return {
          state: 'error',
          path: resolvedPath.relativePath,
          error: this.formatFsError('Failed to read workspace file for byte comparison', resolvedPath.absolutePath, error),
        }
      }
    }

    if (currentBytes?.includes(0)) return { state: 'binary', path: resolvedPath.relativePath }
    const currentFingerprint = currentBytes === null ? null : this.fingerprintWorkspaceBytes(currentBytes)
    if (currentFingerprint !== options.expectedFingerprint) {
      return {
        state: 'conflict',
        path: resolvedPath.relativePath,
        error: 'The file bytes changed after this review was opened. Refresh the diff and try again.',
      }
    }

    if (content === null) {
      if (currentBytes === null) return { state: 'missing', path: resolvedPath.relativePath }
      try {
        await fs.unlink(resolvedPath.absolutePath)
        return { state: 'ok', path: resolvedPath.relativePath }
      } catch (error) {
        return {
          state: 'error',
          path: resolvedPath.relativePath,
          error: this.formatFsError('Failed to delete workspace file', resolvedPath.absolutePath, error),
        }
      }
    }

    const prepared = this.prepareEncodedWorkspaceText(content, options)
    if (prepared.kind === 'error') {
      return { state: 'error', path: resolvedPath.relativePath, error: prepared.message }
    }
    const metadata = {
      contentFingerprint: this.fingerprintWorkspaceBytes(prepared.bytes),
      actualEncoding: prepared.encoding,
      bom: prepared.bom,
      lineEnding: prepared.lineEnding,
    }
    if (currentBytes === null) {
      return await this.createTextFileExclusively(resolvedPath, prepared.content, prepared.bytes, metadata)
    }

    try {
      await fs.writeFile(resolvedPath.absolutePath, prepared.bytes)
      return {
        state: 'ok',
        path: resolvedPath.relativePath,
        content: prepared.content,
        size: prepared.bytes.length,
        ...metadata,
      }
    } catch (error) {
      return {
        state: 'error',
        path: resolvedPath.relativePath,
        error: this.formatFsError('Failed to write encoded workspace file', resolvedPath.absolutePath, error),
      }
    }
  }

  private prepareEncodedWorkspaceText(
    content: string,
    options: WorkspaceWriteOptions,
  ):
    | {
        kind: 'ok'
        bytes: Buffer
        encoding: Exclude<WorkspaceTextEncoding, 'auto'>
        bom: 'utf8' | 'none'
        lineEnding: WorkspaceComparisonSide['lineEnding']
        content: string
      }
    | { kind: 'error'; message: string } {
    const encoding = options.encoding ?? 'utf8'
    const bom = options.bom ?? 'none'
    const lineEnding = options.lineEnding ?? this.detectComparisonLineEnding(content)
    if (bom === 'utf8' && encoding !== 'utf8') {
      return { kind: 'error', message: `A UTF-8 BOM cannot be written with ${encoding}.` }
    }

    const normalizedContent = this.applyWorkspaceLineEnding(content, lineEnding)
    const body = encoding === 'gbk'
      ? iconv.encode(normalizedContent, 'gbk')
      : Buffer.from(normalizedContent, 'utf8')
    const roundTrip = encoding === 'gbk'
      ? iconv.decode(body, 'gbk')
      : body.toString('utf8')
    if (roundTrip !== normalizedContent) {
      const expectedCharacters = [...normalizedContent]
      const actualCharacters = [...roundTrip]
      const mismatchIndex = expectedCharacters.findIndex((character, index) => character !== actualCharacters[index])
      const character = expectedCharacters[mismatchIndex < 0 ? expectedCharacters.length - 1 : mismatchIndex] ?? ''
      const codePoint = character.codePointAt(0)
      const label = codePoint === undefined ? 'unknown character' : `U+${codePoint.toString(16).toUpperCase()}`
      return {
        kind: 'error',
        message: `Content cannot be represented losslessly: ${label} is not round-trippable in ${encoding}.`,
      }
    }

    const bytes = bom === 'utf8'
      ? Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), body])
      : body
    return { kind: 'ok', bytes, encoding, bom, lineEnding, content: normalizedContent }
  }

  private applyWorkspaceLineEnding(
    content: string,
    lineEnding: WorkspaceComparisonSide['lineEnding'],
  ): string {
    if (lineEnding === 'mixed' || lineEnding === 'none' || lineEnding === 'unknown') return content
    const separator = lineEnding === 'crlf' ? '\r\n' : lineEnding === 'cr' ? '\r' : '\n'
    return content.replace(/\r\n|\r|\n/g, separator)
  }

  private async createTextFileExclusively(
    resolvedPath: WorkspacePathResolution,
    content: string,
    bytes: Buffer = Buffer.from(content, 'utf8'),
    metadata: Pick<WorkspaceWriteResult, 'contentFingerprint' | 'actualEncoding' | 'bom' | 'lineEnding'> = {},
  ): Promise<WorkspaceWriteResult> {
    const createTarget = await this.resolveExclusiveCreateTarget(resolvedPath)
    if (createTarget.kind === 'error') {
      return { state: 'error', path: resolvedPath.relativePath, error: createTarget.message }
    }

    const temporaryPath = path.join(
      createTarget.parentPath,
      `.${path.basename(createTarget.targetPath)}.cc-haha-create-${randomUUID()}.tmp`,
    )
    let handle: Awaited<ReturnType<typeof fs.open>> | null = null
    try {
      handle = await fs.open(temporaryPath, 'wx', 0o666)
      await this.writePreparedCreateFile(handle, bytes)
      await handle.sync()
      await handle.close()
      handle = null

      try {
        await fs.link(temporaryPath, createTarget.targetPath)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
          return {
            state: 'conflict',
            path: resolvedPath.relativePath,
            error: 'The file changed after this review was opened. Refresh the diff and try again.',
          }
        }
        throw error
      }

      return {
        state: 'ok',
        path: resolvedPath.relativePath,
        content,
        size: bytes.length,
        ...metadata,
      }
    } catch (error) {
      return {
        state: 'error',
        path: resolvedPath.relativePath,
        error: this.formatFsError('Failed to create workspace file', createTarget.targetPath, error),
      }
    } finally {
      if (handle) await handle.close().catch(() => undefined)
      await fs.unlink(temporaryPath).catch(() => undefined)
    }
  }

  private async resolveExclusiveCreateTarget(
    resolvedPath: WorkspacePathResolution,
  ): Promise<
    | { kind: 'ok'; parentPath: string; targetPath: string }
    | { kind: 'error'; message: string }
  > {
    if (resolvedPath.isExternalRoot) {
      return { kind: 'error', message: 'Registered external roots are read-only.' }
    }

    const absoluteParent = path.dirname(resolvedPath.absolutePath)
    const relativeParent = path.relative(resolvedPath.workspaceRoot, absoluteParent)
    if (
      relativeParent === '..'
      || relativeParent.startsWith(`..${path.sep}`)
      || path.isAbsolute(relativeParent)
    ) {
      return { kind: 'error', message: `Path is outside workspace: ${resolvedPath.requestedPath}` }
    }

    try {
      const [parentStat, canonicalParent] = await Promise.all([
        fs.stat(absoluteParent),
        fs.realpath(absoluteParent),
      ])
      if (!parentStat.isDirectory()) {
        return { kind: 'error', message: `Workspace file parent is not a directory: ${absoluteParent}` }
      }

      const expectedCanonicalParent = path.resolve(resolvedPath.canonicalWorkspaceRoot, relativeParent)
      const resolvedTargetParent = path.dirname(resolvedPath.canonicalTargetPath)
      if (
        !this.isSamePath(canonicalParent, expectedCanonicalParent)
        || !this.isSamePath(canonicalParent, resolvedTargetParent)
        || !this.isWithinRoot(canonicalParent, resolvedPath.canonicalWorkspaceRoot)
      ) {
        return {
          kind: 'error',
          message: `Workspace file parent resolves through an unsafe symbolic link: ${resolvedPath.requestedPath}`,
        }
      }

      await this.assertDirectoryWritable(canonicalParent)
      return {
        kind: 'ok',
        parentPath: canonicalParent,
        targetPath: path.join(canonicalParent, path.basename(resolvedPath.absolutePath)),
      }
    } catch (error) {
      return {
        kind: 'error',
        message: this.formatFsError('Workspace file parent is not writable', absoluteParent, error),
      }
    }
  }

  private async assertDirectoryWritable(directoryPath: string): Promise<void> {
    await fs.access(directoryPath, fsConstants.W_OK)
  }

  private async writePreparedCreateFile(
    handle: Awaited<ReturnType<typeof fs.open>>,
    content: string | Uint8Array,
  ): Promise<void> {
    if (typeof content === 'string') await handle.writeFile(content, 'utf8')
    else await handle.writeFile(content)
  }

  private buildMissingComparisonSide(
    sourceKind: 'working_tree' | 'empty',
    sourcePath: string,
    requestedEncoding: WorkspaceTextEncoding,
    writable: boolean,
    readOnlyReason?: string,
  ): WorkspaceComparisonSide {
    return {
      source: {
        kind: sourceKind,
        path: sourcePath,
        revision: `missing:${sourceKind}:${sourcePath}`,
      },
      exists: false,
      state: 'missing',
      requestedEncoding,
      bom: 'none',
      lineEnding: 'none',
      writable,
      ...(!writable && readOnlyReason ? { readOnlyReason } : {}),
    }
  }

  private buildUnavailableComparisonSide(
    sourceKind: Exclude<WorkspaceComparisonSourceKind, 'empty'>,
    sourcePath: string,
    requestedEncoding: WorkspaceTextEncoding,
    error: string,
    writable = false,
    readOnlyReason = 'Comparison source is unavailable.',
  ): WorkspaceComparisonSide {
    return {
      source: {
        kind: sourceKind,
        path: sourcePath,
        revision: `unavailable:${sourceKind}:${sourcePath}`,
      },
      exists: true,
      state: 'unavailable',
      requestedEncoding,
      bom: 'unknown',
      lineEnding: 'unknown',
      writable,
      ...(!writable ? { readOnlyReason } : {}),
      error,
    }
  }

  private fingerprintWorkspaceBytes(buffer: Buffer): string {
    return `sha256:${createHash('sha256').update(buffer).digest('hex')}`
  }

  private async fingerprintWorkspaceFile(filePath: string): Promise<string> {
    const hash = createHash('sha256')
    const handle = await fs.open(filePath, 'r')
    const chunk = Buffer.allocUnsafe(64 * 1024)
    try {
      let position = 0
      for (;;) {
        const { bytesRead } = await handle.read(chunk, 0, chunk.length, position)
        if (bytesRead === 0) break
        hash.update(chunk.subarray(0, bytesRead))
        position += bytesRead
      }
    } finally {
      await handle.close()
    }
    return `sha256:${hash.digest('hex')}`
  }

  private detectComparisonBom(buffer: Buffer): WorkspaceComparisonSide['bom'] {
    if (buffer.length >= 3 && buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf) return 'utf8'
    if (
      (buffer.length >= 2 && ((buffer[0] === 0xff && buffer[1] === 0xfe) || (buffer[0] === 0xfe && buffer[1] === 0xff)))
      || (buffer.length >= 4 && buffer[0] === 0 && buffer[1] === 0 && buffer[2] === 0xfe && buffer[3] === 0xff)
    ) return 'unknown'
    return 'none'
  }

  private detectComparisonLineEnding(content: string): WorkspaceComparisonSide['lineEnding'] {
    const crlf = (content.match(/\r\n/g) ?? []).length
    const withoutCrlf = content.replace(/\r\n/g, '')
    const lf = (withoutCrlf.match(/\n/g) ?? []).length
    const cr = (withoutCrlf.match(/\r/g) ?? []).length
    const styles = Number(crlf > 0) + Number(lf > 0) + Number(cr > 0)
    if (styles === 0) return 'none'
    if (styles > 1) return 'mixed'
    if (crlf > 0) return 'crlf'
    if (lf > 0) return 'lf'
    return 'cr'
  }

  private async resolveWorkingSideWritable(
    resolvedPath: WorkspacePathResolution,
  ): Promise<{ writable: boolean; readOnlyReason?: string }> {
    if (resolvedPath.isExternalRoot) {
      return { writable: false, readOnlyReason: 'Registered external roots are read-only.' }
    }
    try {
      const stat = await this.safeStat(resolvedPath.absolutePath)
      const accessPath = stat.kind === 'ok'
        ? resolvedPath.absolutePath
        : await this.findNearestExistingDirectory(
            path.dirname(resolvedPath.absolutePath),
            resolvedPath.canonicalWorkspaceRoot,
          )
      await fs.access(accessPath, fsConstants.W_OK)
      return { writable: true }
    } catch (error) {
      return {
        writable: false,
        readOnlyReason: this.formatFsError('Workspace comparison source is read-only', resolvedPath.absolutePath, error),
      }
    }
  }

  private async getStoredWorkspaceDiff(
    sessionId: string,
    workspaceRoot: string,
    relativePath: string,
  ): Promise<string | null> {
    // A checkpoint baseline represents the accumulated session result. Prefer it
    // to concatenated tool patches, which can show stale intermediate edits when
    // a file was modified more than once without a VCS commit.
    const fileHistoryDiff = await this.getFileHistoryDiff(
      sessionId,
      workspaceRoot,
      relativePath,
    )
    if (fileHistoryDiff) return fileHistoryDiff

    return await this.getSessionDiff(sessionId, relativePath)
  }

  private async getSessionDiff(
    sessionId: string,
    relativePath: string,
  ): Promise<string | null> {
    const workDir = await this.requireWorkDir(sessionId)
    const changes = await this.getSessionFileChanges(sessionId, workDir)
    const change = changes.find((entry) => entry.path === relativePath)
    if (!change) return null
    if (change.diff?.trim()) return change.diff

    const file = await this.readFile(sessionId, relativePath)
    if (file.state !== 'ok' || file.previewType === 'image' || typeof file.content !== 'string') {
      return null
    }
    return this.buildSyntheticDiff('/dev/null', relativePath, '', file.content)
  }

  private async getSessionFileChanges(
    sessionId: string,
    workspaceRoot: string,
  ): Promise<SessionFileChange[]> {
    let messages: MessageEntry[]
    try {
      messages = await this.resolveSessionMessages(sessionId)
    } catch {
      return []
    }

    const changes = new Map<string, SessionFileChange>()
    const erroredToolUseIds = collectErroredToolUseIds(messages)

    for (const message of messages) {
      if (message.type !== 'tool_use' || !Array.isArray(message.content)) continue

      for (const block of message.content) {
        if (!block || typeof block !== 'object') continue
        const record = block as Record<string, unknown>
        if (record.type !== 'tool_use' || typeof record.name !== 'string') continue
        if (typeof record.id === 'string' && erroredToolUseIds.has(record.id)) continue
        const input = record.input
        if (!input || typeof input !== 'object') continue

        for (const change of this.extractSessionChangesFromTool(
          record.name,
          input as Record<string, unknown>,
          workspaceRoot,
        )) {
          const existing = changes.get(change.path)
          if (!existing) {
            changes.set(change.path, change)
            continue
          }

          changes.set(change.path, {
            ...existing,
            status: existing.status === 'added' ? existing.status : change.status,
            additions: existing.additions + change.additions,
            deletions: existing.deletions + change.deletions,
            diff: [existing.diff, change.diff].filter(Boolean).join('\n'),
          })
        }
      }
    }

    return [...changes.values()]
  }

  private async getFileHistoryChanges(
    sessionId: string,
    workspaceRoot: string,
  ): Promise<SessionFileChange[]> {
    let snapshots: FileHistorySnapshot[]
    try {
      snapshots = await this.resolveSessionFileHistorySnapshots(sessionId)
    } catch {
      return []
    }
    if (snapshots.length === 0) return []

    const changes: SessionFileChange[] = []
    const trackedPaths = this.collectFileHistoryTrackedPaths(snapshots)

    for (const trackingPath of trackedPaths) {
      const relativePath = this.resolveFileHistoryRelativePath(trackingPath, workspaceRoot)
      if (!relativePath) continue

      const beforeContent = await this.readFileHistoryBackupContent(
        sessionId,
        this.getEarliestFileHistoryBackupName(trackingPath, snapshots),
      )
      if (beforeContent === undefined) continue

      const absolutePath = path.resolve(workspaceRoot, relativePath)
      const afterContent = await this.readTextFileOrNull(absolutePath)
      if (beforeContent === afterContent) continue

      const stats = this.countDiffStats(beforeContent ?? '', afterContent ?? '')
      changes.push({
        path: relativePath,
        status: beforeContent === null
          ? 'added'
          : afterContent === null
            ? 'deleted'
            : 'modified',
        additions: stats.additions,
        deletions: stats.deletions,
        diff: this.buildSyntheticDiff(
          beforeContent === null ? '/dev/null' : relativePath,
          afterContent === null ? '/dev/null' : relativePath,
          beforeContent ?? '',
          afterContent ?? '',
        ),
      })
    }

    return changes
  }

  private async getFileHistoryDiff(
    sessionId: string,
    workspaceRoot: string,
    relativePath: string,
  ): Promise<string | null> {
    const changes = await this.getFileHistoryChanges(sessionId, workspaceRoot)
    return changes.find((change) => change.path === relativePath)?.diff ?? null
  }

  private mergeSessionFileChanges(changes: SessionFileChange[]): SessionFileChange[] {
    const merged = new Map<string, SessionFileChange>()
    for (const change of changes) {
      const existing = merged.get(change.path)
      if (!existing) {
        merged.set(change.path, change)
        continue
      }

      merged.set(change.path, {
        ...existing,
        status: change.status,
        additions: change.additions,
        deletions: change.deletions,
        diff: change.diff ?? existing.diff,
      })
    }
    return [...merged.values()]
  }

  private collectFileHistoryTrackedPaths(snapshots: FileHistorySnapshot[]): Set<string> {
    const trackedPaths = new Set<string>()
    for (const snapshot of snapshots) {
      for (const trackingPath of Object.keys(snapshot.trackedFileBackups)) {
        trackedPaths.add(trackingPath)
      }
    }
    return trackedPaths
  }

  private getEarliestFileHistoryBackupName(
    trackingPath: string,
    snapshots: FileHistorySnapshot[],
  ): string | null | undefined {
    for (const snapshot of snapshots) {
      const backup = snapshot.trackedFileBackups[trackingPath]
      if (backup !== undefined) {
        return backup.backupFileName
      }
    }
    return undefined
  }

  private resolveFileHistoryRelativePath(
    trackingPath: string,
    workspaceRoot: string,
  ): string | null {
    const absolutePath = path.isAbsolute(trackingPath)
      ? path.resolve(trackingPath)
      : path.resolve(workspaceRoot, trackingPath)
    if (!this.isWithinRoot(absolutePath, workspaceRoot)) return null
    return this.normalizeRelativePath(path.relative(workspaceRoot, absolutePath))
  }

  private async readFileHistoryBackupContent(
    sessionId: string,
    backupFileName: string | null | undefined,
  ): Promise<string | null | undefined> {
    if (backupFileName === undefined) return undefined
    if (backupFileName === null) return null
    return await this.readTextFileOrNull(
      path.join(getClaudeConfigHomeDir(), 'file-history', sessionId, backupFileName),
    )
  }

  private async readTextFileOrNull(filePath: string): Promise<string | null> {
    try {
      const content = await fs.readFile(filePath)
      if (content.includes(0)) return null
      return content.toString('utf8')
    } catch {
      return null
    }
  }

  private async readTextFileForWrite(filePath: string): Promise<
    | { kind: 'ok'; content: string | null }
    | { kind: 'binary' }
    | { kind: 'error'; message: string }
  > {
    try {
      const content = await fs.readFile(filePath)
      if (content.includes(0)) return { kind: 'binary' }
      return { kind: 'ok', content: content.toString('utf8') }
    } catch (error) {
      const maybeError = error as NodeJS.ErrnoException
      if (maybeError.code === 'ENOENT') return { kind: 'ok', content: null }
      return {
        kind: 'error',
        message: this.formatFsError('Failed to read workspace file', filePath, error),
      }
    }
  }

  private async readWrittenTextResult(resolvedPath: WorkspacePathResolution): Promise<WorkspaceWriteResult> {
    const result = await this.readTextFileForWrite(resolvedPath.absolutePath)
    if (result.kind === 'error') return { state: 'error', path: resolvedPath.relativePath, error: result.message }
    if (result.kind === 'binary') return { state: 'binary', path: resolvedPath.relativePath }
    if (result.content === null) return { state: 'ok', path: resolvedPath.relativePath }
    return {
      state: 'ok',
      path: resolvedPath.relativePath,
      content: result.content,
      size: Buffer.byteLength(result.content),
    }
  }

  private countDiffStats(oldContent: string, newContent: string): { additions: number; deletions: number } {
    let additions = 0
    let deletions = 0
    for (const change of diffLines(oldContent, newContent)) {
      if (change.added) additions += change.count || 0
      if (change.removed) deletions += change.count || 0
    }
    return { additions, deletions }
  }

  private extractSessionChangesFromTool(
    toolName: string,
    input: Record<string, unknown>,
    workspaceRoot: string,
  ): SessionFileChange[] {
    const normalizedToolName = toolName.toLowerCase()
    if (normalizedToolName === 'write') {
      const filePath = this.resolveSessionToolPath(input.file_path ?? input.path, workspaceRoot)
      if (!filePath) return []
      const content = typeof input.content === 'string' ? input.content : ''
      return [{
        path: filePath,
        status: 'added',
        additions: this.countChangedLines(content),
        deletions: 0,
        diff: this.buildSyntheticDiff('/dev/null', filePath, '', content),
      }]
    }

    if (normalizedToolName === 'edit') {
      const filePath = this.resolveSessionToolPath(input.file_path ?? input.path, workspaceRoot)
      if (!filePath) return []
      return [this.buildEditSessionChange(filePath, input)]
    }

    if (normalizedToolName === 'multiedit') {
      const filePath = this.resolveSessionToolPath(input.file_path ?? input.path, workspaceRoot)
      if (!filePath || !Array.isArray(input.edits)) return []
      return input.edits
        .filter((edit): edit is Record<string, unknown> => !!edit && typeof edit === 'object')
        .map((edit) => this.buildEditSessionChange(filePath, edit))
    }

    if (normalizedToolName === 'notebookedit') {
      const filePath = this.resolveSessionToolPath(
        input.notebook_path ?? input.file_path ?? input.path,
        workspaceRoot,
      )
      if (!filePath) return []
      const oldString = typeof input.old_source === 'string' ? input.old_source : ''
      const newString = typeof input.new_source === 'string' ? input.new_source : ''
      return [{
        path: filePath,
        status: oldString ? 'modified' : 'added',
        additions: this.countChangedLines(newString),
        deletions: this.countChangedLines(oldString),
        diff: this.buildSyntheticDiff(filePath, filePath, oldString, newString),
      }]
    }

    if (normalizedToolName === 'apply_patch') {
      return this.extractApplyPatchSessionChanges(input.patch, workspaceRoot)
    }

    return []
  }

  private buildEditSessionChange(
    filePath: string,
    input: Record<string, unknown>,
  ): SessionFileChange {
    const oldString = typeof input.old_string === 'string' ? input.old_string : ''
    const newString = typeof input.new_string === 'string' ? input.new_string : ''
    return {
      path: filePath,
      status: oldString ? 'modified' : 'added',
      additions: this.countChangedLines(newString),
      deletions: this.countChangedLines(oldString),
      diff: this.buildSyntheticDiff(filePath, filePath, oldString, newString),
    }
  }

  private extractApplyPatchSessionChanges(
    patch: unknown,
    workspaceRoot: string,
  ): SessionFileChange[] {
    if (typeof patch !== 'string') return []
    const changes: SessionFileChange[] = []

    for (const line of patch.split('\n')) {
      const match = line.match(/^\*\*\* (?:Add|Update|Delete) File: (.+)$/)
      if (!match?.[1]) continue
      const filePath = this.resolveSessionToolPath(match[1], workspaceRoot)
      if (!filePath) continue
      const status: WorkspaceFileStatus = line.includes('Add File')
        ? 'added'
        : line.includes('Delete File')
          ? 'deleted'
          : 'modified'
      changes.push({
        path: filePath,
        status,
        additions: 0,
        deletions: 0,
      })
    }

    return changes
  }

  private resolveSessionToolPath(
    filePath: unknown,
    workspaceRoot: string,
  ): string | null {
    if (typeof filePath !== 'string' || !filePath.trim()) return null
    const absolutePath = path.isAbsolute(filePath)
      ? path.resolve(filePath)
      : path.resolve(workspaceRoot, filePath)
    if (!this.isWithinRoot(absolutePath, workspaceRoot)) return null
    return this.normalizeRelativePath(path.relative(workspaceRoot, absolutePath))
  }

  private countChangedLines(value: string): number {
    if (!value) return 0
    return value.endsWith('\n')
      ? value.split('\n').length - 1
      : value.split('\n').length
  }

  private buildSyntheticDiff(
    oldPath: string,
    newPath: string,
    oldContent: string,
    newContent: string,
  ): string {
    const oldLines = oldContent ? oldContent.split('\n') : []
    const newLines = newContent ? newContent.split('\n') : []
    if (oldLines.at(-1) === '') oldLines.pop()
    if (newLines.at(-1) === '') newLines.pop()

    return [
      `diff --session ${
        oldPath === '/dev/null' ? '/dev/null' : `a/${oldPath}`
      } ${
        newPath === '/dev/null' ? '/dev/null' : `b/${newPath}`
      }`,
      `--- ${oldPath === '/dev/null' ? '/dev/null' : `a/${oldPath}`}`,
      `+++ ${newPath === '/dev/null' ? '/dev/null' : `b/${newPath}`}`,
      `@@ -1,${oldLines.length} +1,${newLines.length} @@`,
      ...oldLines.map((line) => `-${line}`),
      ...newLines.map((line) => `+${line}`),
    ].join('\n')
  }

  private async requireWorkDir(sessionId: string): Promise<string> {
    const workDir = await this.resolveSessionWorkDir(sessionId)
    if (!workDir) {
      throw new Error(`Session not found: ${sessionId}`)
    }
    return path.resolve(normalizeDriveRootPathForPlatform(workDir))
  }

  private async getWorkspaceRoot(
    workDir: string,
  ): Promise<
    | { kind: 'ok'; workspaceRoot: string; canonicalWorkspaceRoot: string }
    | { kind: 'missing' }
    | { kind: 'error'; message: string }
  > {
    const stat = await this.safeStat(workDir)
    if (stat.kind === 'missing') {
      return { kind: 'missing' }
    }
    if (stat.kind === 'error') {
      return { kind: 'error', message: stat.message }
    }

    try {
      return {
        kind: 'ok',
        workspaceRoot: workDir,
        canonicalWorkspaceRoot: normalizeDriveRootPathForPlatform(await fs.realpath(workDir)),
      }
    } catch (error) {
      return {
        kind: 'error',
        message: this.formatFsError(
          'Failed to canonicalize workspace root',
          workDir,
          error,
        ),
      }
    }
  }

  private async resolveWorkspacePath(
    sessionId: string,
    requestedPath: string,
  ): Promise<WorkspacePathResolution> {
    const workDir = await this.requireWorkDir(sessionId)
    const workspaceRoot = await this.getWorkspaceRoot(workDir)
    if (workspaceRoot.kind === 'missing') {
      throw new Error(`Workspace root is missing: ${workDir}`)
    }
    if (workspaceRoot.kind === 'error') {
      throw new Error(workspaceRoot.message)
    }

    const absolutePath = path.resolve(workDir, requestedPath || '.')
    if (!this.isWithinRoot(absolutePath, workDir)) {
      // Files this session changed outside its workdir (the user pointed the
      // model at an absolute path elsewhere, possibly another drive) are
      // registered as access roots when the turn checkpoint is built. Preview
      // those by absolute path — they have no workspace-relative form — instead
      // of rejecting them as out-of-sandbox.
      if (this.isAbsoluteRequestPath(requestedPath) && isWithinRegisteredFilesystemRoot(absolutePath)) {
        return this.resolveOutsideWorkspacePath(absolutePath, requestedPath)
      }
      throw new Error(`Path is outside workspace: ${requestedPath}`)
    }

    let canonicalTargetPath: string
    try {
      canonicalTargetPath = await this.resolveCanonicalTargetPath(
        workspaceRoot.canonicalWorkspaceRoot,
        absolutePath,
        requestedPath,
      )
    } catch (error) {
      // A directory symlink is an intentional local navigation edge. Resolve it
      // here as well as while listing trees so direct requests do not depend on
      // an earlier parent-tree request registering the link.
      if (
        await this.isDirectorySymlinkInsideWorkspace(
          workspaceRoot.workspaceRoot,
          absolutePath,
        )
      ) {
        registerFilesystemAccessRoot(absolutePath)
        return this.resolveOutsideWorkspacePath(absolutePath, requestedPath)
      }
      // Explicit user-selected viewer roots may also sit outside the primary
      // session working directory.
      if (isWithinRegisteredFilesystemRoot(absolutePath)) {
        return this.resolveOutsideWorkspacePath(absolutePath, requestedPath)
      }
      throw error
    }

    return {
      absolutePath,
      requestedPath,
      workspaceRoot: workspaceRoot.workspaceRoot,
      canonicalWorkspaceRoot: workspaceRoot.canonicalWorkspaceRoot,
      canonicalTargetPath,
      isExternalRoot: false,
      relativePath: this.normalizeRelativePath(
        path.relative(workspaceRoot.workspaceRoot, absolutePath),
      ),
    }
  }

  /**
   * Resolve a path that sits OUTSIDE the session workdir but inside a registered
   * access root (a file this turn actually changed elsewhere). Such a file has no
   * meaningful workspace-relative form, so it is keyed by its absolute request
   * path and rooted at its own containing directory — enough for `readFile`
   * (and a best-effort git diff if that directory happens to be a repo).
   */
  private async resolveOutsideWorkspacePath(
    absolutePath: string,
    requestedPath: string,
  ): Promise<WorkspacePathResolution> {
    let canonicalTargetPath = absolutePath
    try {
      canonicalTargetPath = await fs.realpath(absolutePath)
    } catch {
      // File may not exist yet, or realpath is unavailable — keep the raw path.
    }
    return {
      absolutePath,
      requestedPath,
      workspaceRoot: path.dirname(absolutePath),
      canonicalWorkspaceRoot: path.dirname(canonicalTargetPath),
      canonicalTargetPath,
      isExternalRoot: true,
      relativePath: this.normalizeRequestedPath(requestedPath),
    }
  }

  private async validateCanonicalWorkspacePath(
    canonicalWorkspaceRoot: string,
    absolutePath: string,
    requestedPath: string,
  ): Promise<
    | { kind: 'ok'; canonicalTargetPath: string }
    | { kind: 'error'; message: string }
  > {
    try {
      return {
        kind: 'ok',
        canonicalTargetPath: await this.resolveCanonicalTargetPath(
          canonicalWorkspaceRoot,
          absolutePath,
          requestedPath,
        ),
      }
    } catch (error) {
      return {
        kind: 'error',
        message: error instanceof Error ? error.message : String(error),
      }
    }
  }

  private async resolveCanonicalTargetPath(
    canonicalWorkspaceRoot: string,
    absolutePath: string,
    requestedPath: string,
  ): Promise<string> {
    let probePath = absolutePath
    const missingSuffix: string[] = []

    for (;;) {
      try {
        const canonicalBase = await fs.realpath(probePath)
        const canonicalTarget = path.resolve(canonicalBase, ...missingSuffix)
        if (!this.isWithinRoot(canonicalTarget, canonicalWorkspaceRoot)) {
          throw new Error(`Path is outside workspace: ${requestedPath}`)
        }
        return canonicalTarget
      } catch (error) {
        const err = error as NodeJS.ErrnoException
        if (err.code === 'ENOENT' || err.code === 'ENOTDIR') {
          if (probePath === canonicalWorkspaceRoot) {
            const candidate = path.resolve(canonicalWorkspaceRoot, ...missingSuffix)
            if (!this.isWithinRoot(candidate, canonicalWorkspaceRoot)) {
              throw new Error(`Path is outside workspace: ${requestedPath}`)
            }
            return candidate
          }

          missingSuffix.unshift(path.basename(probePath))
          const parentPath = path.dirname(probePath)
          if (parentPath === probePath) {
            throw err
          }
          probePath = parentPath
          continue
        }

        throw new Error(
          this.formatFsError(
            'Failed to canonicalize workspace path',
            absolutePath,
            error,
          ),
        )
      }
    }
  }

  private async isDirectorySymlinkInsideWorkspace(
    workspaceRoot: string,
    targetPath: string,
  ): Promise<boolean> {
    const relativePath = path.relative(workspaceRoot, targetPath)
    if (!relativePath || relativePath === '..' || relativePath.startsWith(`..${path.sep}`)) {
      return false
    }

    let currentPath = workspaceRoot
    for (const segment of relativePath.split(path.sep)) {
      currentPath = path.join(currentPath, segment)
      try {
        const stat = await fs.lstat(currentPath)
        if (stat.isSymbolicLink()) {
          const targetStat = await this.safeStat(currentPath)
          return targetStat.kind === 'ok' && targetStat.stat.isDirectory()
        }
      } catch {
        return false
      }
    }

    return false
  }

  private isWithinRoot(targetPath: string, rootPath: string): boolean {
    return isSameOrInsidePathForPlatform(targetPath, rootPath)
  }

  private isSamePath(firstPath: string, secondPath: string): boolean {
    return this.isWithinRoot(firstPath, secondPath) && this.isWithinRoot(secondPath, firstPath)
  }

  private isAbsoluteRequestPath(requestedPath: string): boolean {
    const pathApi = process.platform === 'win32' ? path.win32 : path
    return pathApi.isAbsolute(normalizeDriveRootPathForPlatform(requestedPath))
  }

  private normalizeRelativePath(filePath: string): string {
    if (!filePath || filePath === '.') return ''
    return filePath.split(path.sep).join('/')
  }

  private normalizeRequestedPath(filePath: string): string {
    if (!filePath) return ''
    return filePath.split(path.sep).join('/')
  }

  private resolveTreeEntryPath(
    resolvedPath: WorkspacePathResolution,
    absoluteEntryPath: string,
    entryName: string,
  ): string {
    if (this.isAbsoluteRequestPath(resolvedPath.requestedPath)) {
      return absoluteEntryPath
    }
    const parentPath = this.normalizeRequestedPath(resolvedPath.relativePath)
    return parentPath ? path.posix.join(parentPath, entryName) : entryName
  }

  private async getLinkedSvnDirectoryChanges(
    workspaceRoot: string,
  ): Promise<WorkspaceChangedFile[]> {
    let entries: import('node:fs').Dirent[]
    try {
      entries = await fs.readdir(workspaceRoot, { withFileTypes: true })
    } catch {
      return []
    }

    const linkedChanges = await Promise.all(entries
      .filter((entry) => entry.isSymbolicLink())
      .map(async (entry): Promise<WorkspaceChangedFile[]> => {
        const linkPath = path.join(workspaceRoot, entry.name)
        const targetStat = await this.safeStat(linkPath)
        if (targetStat.kind !== 'ok' || !targetStat.stat.isDirectory()) return []

        const logicalRootPath = this.normalizeRelativePath(path.relative(workspaceRoot, linkPath))
        const rootMarker: WorkspaceChangedFile = {
          path: logicalRootPath,
          status: 'modified',
          additions: 0,
          deletions: 0,
          isDirectory: true,
          isSymlink: true,
        }

        let canonicalTarget: string
        try {
          canonicalTarget = await fs.realpath(linkPath)
        } catch {
          return [rootMarker]
        }

        const svnInfo = await this.getSvnWorkspaceInfo(canonicalTarget)
        if (svnInfo.kind !== 'ok') return [rootMarker]
        const statusEntries = await this.getSvnStatusEntries(svnInfo.workspaceRoot)
        if (statusEntries.kind !== 'ok') return [rootMarker]

        const scopedEntries = this.scopeStatusEntries(
          statusEntries.entries,
          svnInfo.workspaceRoot,
          canonicalTarget,
        )
        const changes = await Promise.all(scopedEntries.map(async (statusEntry) => {
          const stats = statusEntry.isDirectory
            ? { kind: 'ok' as const, additions: 0, deletions: 0 }
            : statusEntry.status === 'untracked'
            ? await this.getUntrackedStats(statusEntry.absolutePath)
            : await this.getSvnDiffStatsForCanonicalPath(
                svnInfo.workspaceRoot,
                statusEntry.absolutePath,
              )
          return {
            path: path.posix.join(logicalRootPath, statusEntry.path),
            oldPath: statusEntry.oldPath
              ? path.posix.join(logicalRootPath, statusEntry.oldPath)
              : undefined,
            status: statusEntry.status,
            additions: stats.kind === 'ok' ? stats.additions : 0,
            deletions: stats.kind === 'ok' ? stats.deletions : 0,
            ...(statusEntry.isDirectory ? { isDirectory: true } : {}),
          } satisfies WorkspaceChangedFile
        }))

        return [rootMarker, ...changes]
      }))

    return linkedChanges.flat()
  }

  private mergeLinkedDirectoryChanges(
    changedFiles: WorkspaceChangedFile[],
    linkedChanges: WorkspaceChangedFile[],
  ): WorkspaceChangedFile[] {
    if (linkedChanges.length === 0) return changedFiles
    const changedFileByPath = new Map(changedFiles.map((file) => [file.path, file]))
    const roots = linkedChanges.filter((change) => change.isDirectory && change.isSymlink)

    for (const root of roots) {
      const existing = changedFileByPath.get(root.path)
      const hasNestedChanges = linkedChanges.some((change) => (
        change.path !== root.path && change.path.startsWith(`${root.path}/`)
      ))
      if (existing || hasNestedChanges) {
        changedFileByPath.set(root.path, {
          ...root,
          ...existing,
          isDirectory: true,
          isSymlink: true,
        })
      }
    }
    for (const change of linkedChanges) {
      if (!(change.isDirectory && change.isSymlink)) {
        changedFileByPath.set(change.path, change)
      }
    }

    return [...changedFileByPath.values()].sort((left, right) => left.path.localeCompare(right.path))
  }

  private scopeStatusEntries(
    entries: StatusEntry[],
    repoRoot: string,
    workDir: string,
  ): ScopedStatusEntry[] {
    const workDirFromRepo = this.normalizeRelativePath(path.relative(repoRoot, workDir))

    return entries.flatMap((entry) => {
      const scopedPath = this.rebaseRepoPathToWorkspacePath(entry.path, workDirFromRepo)
      if (scopedPath === null) {
        return []
      }

      const scopedOldPath = entry.oldPath
        ? this.rebaseRepoPathToWorkspacePath(entry.oldPath, workDirFromRepo)
        : undefined

      return [{
        repoPath: entry.path,
        repoOldPath: entry.oldPath,
        path: scopedPath,
        oldPath: scopedOldPath ?? undefined,
        status: entry.status,
        ...(entry.isDirectory ? { isDirectory: true } : {}),
        absolutePath: path.resolve(repoRoot, entry.path),
        canonicalWorkspaceRoot: workDir,
      }]
    })
  }

  private rebaseRepoPathToWorkspacePath(
    repoPath: string,
    workDirFromRepo: string,
  ): string | null {
    const normalizedRepoPath = this.normalizeRelativePath(repoPath)
    if (!workDirFromRepo) {
      return normalizedRepoPath
    }

    const rebasedPath = path.posix.relative(workDirFromRepo, normalizedRepoPath)
    if (
      !rebasedPath ||
      rebasedPath === '.' ||
      rebasedPath === '..' ||
      rebasedPath.startsWith('../')
    ) {
      return null
    }

    return rebasedPath
  }

  private toRepoRelativePath(
    repoRoot: string,
    canonicalTargetPath: string,
  ): string {
    return this.normalizeRelativePath(path.relative(repoRoot, canonicalTargetPath))
  }

  private detectLanguage(filePath: string): string {
    const ext = path.extname(filePath).slice(1).toLowerCase()
    return LANGUAGE_MAP[ext] || 'text'
  }

  private detectImageMimeType(filePath: string): string | null {
    const ext = path.extname(filePath).slice(1).toLowerCase()
    return IMAGE_MIME_BY_EXTENSION[ext] ?? null
  }

  private async safeStat(targetPath: string): Promise<WorkspaceStatResult> {
    try {
      return {
        kind: 'ok',
        stat: await fs.stat(targetPath),
      }
    } catch (error) {
      const err = error as NodeJS.ErrnoException
      if (err.code === 'ENOENT' || err.code === 'ENOTDIR') {
        return { kind: 'missing' }
      }
      return {
        kind: 'error',
        message: this.formatFsError('Failed to stat workspace path', targetPath, error),
      }
    }
  }

  private async getGitRepoInfo(workDir: string): Promise<GitRepoInfo> {
    const rootResult = await this.runGit(workDir, ['rev-parse', '--show-toplevel'])

    if (rootResult.code !== 0) {
      const stderr = rootResult.stderr.trim()
      if (stderr.includes('not a git repository')) {
        return { kind: 'not_git_repo' }
      }
      return {
        kind: 'error',
        message: this.formatGitError(
          'Failed to inspect git repository',
          ['rev-parse', '--show-toplevel'],
          workDir,
          rootResult,
        ),
      }
    }

    let repoRoot: string
    try {
      repoRoot = await fs.realpath(path.resolve(rootResult.stdout.trim()))
    } catch (error) {
      return {
        kind: 'error',
        message: this.formatFsError(
          'Failed to canonicalize git repository root',
          path.resolve(rootResult.stdout.trim()),
          error,
        ),
      }
    }
    const branchResult = await this.runGit(workDir, [
      'rev-parse',
      '--abbrev-ref',
      'HEAD',
    ])

    return {
      kind: 'ok',
      repoRoot,
      branch:
        branchResult.code === 0
          ? branchResult.stdout.trim() || null
          : null,
    }
  }

  private async getSvnWorkspaceInfo(workDir: string): Promise<SvnWorkspaceInfo> {
    let probePath = path.resolve(workDir)
    while (true) {
      const result = await this.runSvn(probePath, ['info', '--show-item', 'wc-root'])
      if (result.code === 0) {
        const reportedRoot = result.stdout.trim()
        if (!reportedRoot) return { kind: 'not_svn_workspace' }
        try {
          return { kind: 'ok', workspaceRoot: await fs.realpath(path.resolve(reportedRoot)) }
        } catch (error) {
          return {
            kind: 'error',
            message: this.formatFsError('Failed to canonicalize SVN workspace root', path.resolve(reportedRoot), error),
          }
        }
      }

      const details = `${result.stderr}\n${result.stdout}`.toLowerCase()
      const canProbeParent = !details
        || details.includes('not a working copy')
        || details.includes('is not a working copy')
        || details.includes('was not found')
        || details.includes('could not display info')
      if (!canProbeParent) {
        return {
          kind: 'error',
          message: this.formatSvnError('Failed to inspect SVN workspace', ['info', '--show-item', 'wc-root'], probePath, result),
        }
      }

      const parentPath = path.dirname(probePath)
      if (parentPath === probePath) return { kind: 'not_svn_workspace' }
      probePath = parentPath
    }
  }

  private async getSvnStatus(
    workspaceInfo: { workspaceRoot: string; canonicalWorkspaceRoot: string },
    svnRoot: string,
    sessionChanges: SessionFileChange[],
  ): Promise<WorkspaceStatusResult> {
    const statusEntries = await this.getSvnStatusEntries(svnRoot)
    if (statusEntries.kind === 'error') {
      return {
        state: 'error',
        workDir: workspaceInfo.workspaceRoot,
        repoName: path.basename(svnRoot),
        branch: null,
        isGitRepo: false,
        changedFiles: [],
        error: statusEntries.message,
      }
    }
    const scopedEntries = this.scopeStatusEntries(
      statusEntries.entries,
      svnRoot,
      workspaceInfo.canonicalWorkspaceRoot,
    )
    const changedFiles = await Promise.all(scopedEntries.map(async (entry) => {
      const stats = entry.isDirectory
        ? { kind: 'ok' as const, additions: 0, deletions: 0 }
        : entry.status === 'untracked'
        ? await this.getUntrackedStats(entry.absolutePath)
        : await this.getSvnDiffStatsForCanonicalPath(svnRoot, entry.absolutePath)
      if (stats.kind === 'error') throw new Error(stats.message)
      return {
        path: entry.path,
        oldPath: entry.oldPath,
        status: entry.status,
        additions: stats.additions,
        deletions: stats.deletions,
        ...(entry.isDirectory ? { isDirectory: true } : {}),
      } satisfies WorkspaceChangedFile
    })).catch((error) => error as Error)

    if (changedFiles instanceof Error) {
      return {
        state: 'error',
        workDir: workspaceInfo.workspaceRoot,
        repoName: path.basename(svnRoot),
        branch: null,
        isGitRepo: false,
        changedFiles: [],
        error: changedFiles.message,
      }
    }

    const changedFileByPath = new Map(changedFiles.map((file) => [file.path, file]))
    for (const change of sessionChanges) {
      if (!changedFileByPath.has(change.path)) {
        changedFileByPath.set(change.path, {
          path: change.path,
          oldPath: change.oldPath,
          status: change.status,
          additions: change.additions,
          deletions: change.deletions,
        })
      }
    }
    return {
      state: 'ok',
      workDir: workspaceInfo.workspaceRoot,
      repoName: path.basename(svnRoot),
      branch: null,
      isGitRepo: false,
      changedFiles: [...changedFileByPath.values()].sort((left, right) => left.path.localeCompare(right.path)),
    }
  }

  private async getSvnDiff(
    sessionId: string,
    resolvedPath: WorkspacePathResolution,
    svnRoot: string,
    leftRequestedEncoding: WorkspaceTextEncoding,
    rightRequestedEncoding: WorkspaceTextEncoding,
  ): Promise<WorkspaceDiffResult> {
    const statusEntries = await this.getSvnStatusEntries(svnRoot)
    if (statusEntries.kind === 'error') {
      return { state: 'error', path: resolvedPath.relativePath, error: statusEntries.message }
    }
    const scopedEntries = this.scopeStatusEntries(
      statusEntries.entries,
      svnRoot,
      resolvedPath.canonicalWorkspaceRoot,
    )
    const repoPath = this.toRepoRelativePath(svnRoot, resolvedPath.canonicalTargetPath)
    const entry = scopedEntries.find((candidate) => candidate.repoPath === repoPath)
    if (!entry) {
      const storedDiff = await this.getStoredWorkspaceDiff(sessionId, resolvedPath.workspaceRoot, resolvedPath.relativePath)
      return storedDiff
        ? {
            state: 'ok',
            path: resolvedPath.relativePath,
            diff: storedDiff,
            ...await this.getFileHistoryComparisonResult(
              sessionId,
              resolvedPath,
              leftRequestedEncoding,
              rightRequestedEncoding,
            ),
          }
        : { state: 'missing', path: resolvedPath.relativePath }
    }
    if (entry.status === 'untracked') {
      const diff = await this.buildUntrackedDiff(entry.absolutePath, entry.path, rightRequestedEncoding)
      return diff.kind === 'ok'
        ? {
            state: 'ok',
            path: resolvedPath.relativePath,
            diff: diff.diff,
            comparison: await this.buildSvnComparison(
              resolvedPath,
              svnRoot,
              entry,
              leftRequestedEncoding,
              rightRequestedEncoding,
            ),
          }
        : diff.kind === 'missing'
          ? { state: 'missing', path: resolvedPath.relativePath }
          : { state: 'error', path: resolvedPath.relativePath, error: diff.message }
    }
    const diff = await this.runSvnDiffForCanonicalPath(
      svnRoot,
      resolvedPath.canonicalTargetPath,
    )
    if (diff.kind === 'error') {
      return {
        state: 'error',
        path: resolvedPath.relativePath,
        error: diff.message,
        comparison: await this.buildSvnComparison(
          resolvedPath,
          svnRoot,
          entry,
          leftRequestedEncoding,
          rightRequestedEncoding,
        ),
      }
    }
    return diff.diff.trim()
      ? {
          state: 'ok',
          path: resolvedPath.relativePath,
          diff: diff.diff,
          comparison: await this.buildSvnComparison(
            resolvedPath,
            svnRoot,
            entry,
            leftRequestedEncoding,
            rightRequestedEncoding,
          ),
        }
      : { state: 'missing', path: resolvedPath.relativePath }
  }

  private async getSvnStatusEntries(
    workspaceRoot: string,
  ): Promise<{ kind: 'ok'; entries: StatusEntry[] } | { kind: 'error'; message: string }> {
    const result = await this.runSvn(
      workspaceRoot,
      ['status', '--xml'],
      MAX_SVN_STATUS_BUFFER_BYTES,
      SVN_STATUS_TIMEOUT_MS,
    )
    if (result.code !== 0) {
      return {
        kind: 'error',
        message: this.formatSvnError('Failed to read SVN status', ['status', '--xml'], workspaceRoot, result),
      }
    }
    const entries: StatusEntry[] = []
    const entryPattern = /<entry\s+path="([^"]+)">[\s\S]*?<wc-status\s+([^>]+)(?:\/>|>[\s\S]*?<\/wc-status>)[\s\S]*?<\/entry>/g
    for (const match of result.stdout.matchAll(entryPattern)) {
      const rawPath = this.decodeXmlAttribute(match[1] ?? '')
      const attributes = match[2] ?? ''
      const item = /\bitem="([^"]+)"/.exec(attributes)?.[1] ?? ''
      const props = /\bprops="([^"]+)"/.exec(attributes)?.[1] ?? ''
      const status = this.parseSvnStatus(item, props)
      if (!status) continue
      entries.push({
        path: this.normalizeRelativePath(rawPath),
        code: item,
        status,
      })
    }

    const enrichedEntries = await Promise.all(entries.map(async (entry) => {
      const absolutePath = path.resolve(workspaceRoot, entry.path)
      const [linkStat, targetStat] = await Promise.all([
        fs.lstat(absolutePath).catch(() => null),
        this.safeStat(absolutePath),
      ])
      return {
        ...entry,
        ...(targetStat.kind === 'ok' && targetStat.stat.isDirectory()
          ? { isDirectory: true as const }
          : {}),
        ...(linkStat?.isSymbolicLink() ? { isSymlink: true as const } : {}),
      }
    }))
    const entryByPath = new Map(enrichedEntries.map((entry) => [entry.path, entry]))

    for (const entry of enrichedEntries) {
      // SVN reports an unversioned junction as a directory. Descending it can
      // duplicate an entire external working copy under a false logical path.
      if (entry.status !== 'untracked' || !entry.isDirectory || entry.isSymlink) continue
      const nestedTextFiles = await this.findUntrackedPlaintextFiles(
        path.resolve(workspaceRoot, entry.path),
        workspaceRoot,
      )
      for (const nestedEntry of nestedTextFiles) {
        if (!entryByPath.has(nestedEntry.path)) entryByPath.set(nestedEntry.path, nestedEntry)
      }
    }

    return { kind: 'ok', entries: [...entryByPath.values()] }
  }

  private async findUntrackedPlaintextFiles(
    directoryPath: string,
    workspaceRoot: string,
  ): Promise<StatusEntry[]> {
    const discovered: StatusEntry[] = []
    const pending = [directoryPath]

    while (pending.length > 0) {
      const currentDirectory = pending.pop()!
      let entries: import('node:fs').Dirent[]
      try {
        entries = await fs.readdir(currentDirectory, { withFileTypes: true })
      } catch {
        continue
      }

      for (const entry of entries) {
        if (entry.isSymbolicLink() || isVcsMetadataDirectoryName(entry.name)) continue
        const absolutePath = path.join(currentDirectory, entry.name)
        if (entry.isDirectory()) {
          pending.push(absolutePath)
          continue
        }
        if (!entry.isFile() || !this.isLikelyPlaintextPath(absolutePath)) continue
        discovered.push({
          path: this.normalizeRelativePath(path.relative(workspaceRoot, absolutePath)),
          code: 'unversioned',
          status: 'untracked',
        })
      }
    }

    return discovered
  }

  private isLikelyPlaintextPath(filePath: string): boolean {
    const fileName = path.basename(filePath).toLowerCase()
    const extension = path.extname(fileName).slice(1)
    return PLAINTEXT_FILE_NAMES.has(fileName) || PLAINTEXT_FILE_EXTENSIONS.has(extension)
  }

  private async runSvnDiffForCanonicalPath(
    svnRoot: string,
    canonicalTargetPath: string,
  ): Promise<{ kind: 'ok'; diff: string } | { kind: 'error'; message: string }> {
    const targetParent = path.dirname(canonicalTargetPath)
    const cwd = await this.findNearestExistingDirectory(targetParent, svnRoot)

    const targetPath = path.relative(cwd, canonicalTargetPath)
    const normalizedTargetPath = this.normalizeRelativePath(targetPath)
    const canPassTargetPath = /^[\x00-\x7f]+$/.test(targetPath)
    // Keep regular source files scoped to one exact target. For names that the
    // Windows SVN executable cannot accept losslessly, run without a target
    // argument and extract the matching diff block. A deleted parent cannot be
    // used as cwd, so widen only to the nearest existing ancestor in that case.
    const args = canPassTargetPath
      ? ['diff', '--', targetPath]
      : ['diff', '--depth', cwd === targetParent ? 'files' : 'infinity']
    const result = await this.runSvn(cwd, args)
    if (result.code !== 0) {
      return {
        kind: 'error',
        message: this.formatSvnError('Failed to read SVN diff', args, cwd, result),
      }
    }

    if (canPassTargetPath) return { kind: 'ok', diff: result.stdout }

    const lossyWindowsTargetPath = normalizedTargetPath.replace(/[^\x00-\x7f]/g, '?')
    const blocks = result.stdout.split(/(?=^Index: )/m)
    const indexedBlocks = blocks.filter((block) => /^Index: /m.test(block))
    const matchingBlock = indexedBlocks.find((block) => {
      const indexPath = /^Index: (.+)\r?$/m.exec(block)?.[1]?.trim()
      if (!indexPath) return false
      const normalizedIndexPath = this.normalizeRelativePath(indexPath)
      return process.platform === 'win32'
        ? normalizedIndexPath.toLowerCase() === normalizedTargetPath.toLowerCase()
          || normalizedIndexPath.toLowerCase() === lossyWindowsTargetPath.toLowerCase()
        : normalizedIndexPath === normalizedTargetPath
    })
    // Some Windows SVN builds replace every non-ASCII character in Index paths
    // with '?'. Match that deterministic lossy name before falling back to the
    // only changed target in a file-parent directory.
    return { kind: 'ok', diff: matchingBlock ?? (indexedBlocks.length === 1 ? indexedBlocks[0]! : '') }
  }

  private parseSvnStatus(item: string, props: string): WorkspaceFileStatus | null {
    if (item === 'unversioned') return 'untracked'
    if (item === 'added') return 'added'
    if (item === 'deleted' || item === 'missing') return 'deleted'
    if (item === 'replaced') return 'renamed'
    if (item === 'modified' || props === 'modified') return 'modified'
    if (item === 'conflicted') return 'unknown'
    return null
  }

  private decodeXmlAttribute(value: string): string {
    return value
      .replace(/&quot;/g, '"')
      .replace(/&apos;/g, "'")
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&amp;/g, '&')
  }

  private async getStatusEntries(
    workDir: string,
  ): Promise<{ kind: 'ok'; entries: StatusEntry[] } | { kind: 'error'; message: string }> {
    const result = await this.runGit(workDir, [
      'status',
      '--porcelain=v1',
      '-z',
      '--untracked-files=all',
    ])

    if (result.code !== 0) {
      return {
        kind: 'error',
        message: this.formatGitError(
          'Failed to read git status',
          ['status', '--porcelain=v1', '-z', '--untracked-files=all'],
          workDir,
          result,
        ),
      }
    }

    const parts = result.stdout.split('\0')
    const entries: StatusEntry[] = []

    for (let i = 0; i < parts.length; i++) {
      const record = parts[i]
      if (!record) continue

      const code = record.slice(0, 2)
      const currentPath = this.normalizeRelativePath(record.slice(3))
      const status = parseStatus(code)

      if (status === 'renamed' || status === 'copied') {
        const oldPath = this.normalizeRelativePath(parts[++i] || '')
        entries.push({
          path: currentPath,
          oldPath,
          code,
          status,
        })
        continue
      }

      entries.push({
        path: currentPath,
        code,
        status,
      })
    }

    return { kind: 'ok', entries }
  }

  private async getDiffStats(
    workDir: string,
    entry: ScopedStatusEntry,
  ): Promise<DiffStatsResult> {
    if (entry.status === 'untracked') {
      const validatedPath = await this.validateCanonicalWorkspacePath(
        entry.canonicalWorkspaceRoot,
        entry.absolutePath,
        entry.path,
      )
      if (validatedPath.kind === 'error') {
        return { kind: 'error', message: validatedPath.message }
      }

      return this.getUntrackedStats(validatedPath.canonicalTargetPath)
    }

    const result = await this.runGit(workDir, [
      'diff',
      '--numstat',
      '--find-renames',
      '--find-copies',
      'HEAD',
      '--',
      entry.repoPath,
    ])

    if (result.code !== 0) {
      return {
        kind: 'error',
        message: this.formatGitError(
          'Failed to read git diff stats',
          [
            'diff',
            '--numstat',
            '--find-renames',
            '--find-copies',
            'HEAD',
            '--',
            entry.repoPath,
          ],
          workDir,
          result,
        ),
      }
    }

    const line = result.stdout.trim().split('\n').find(Boolean)
    if (!line) {
      return {
        kind: 'ok',
        additions: 0,
        deletions: 0,
      }
    }

    const [additions, deletions] = line.split('\t')
    return {
      kind: 'ok',
      additions: additions === '-' ? 0 : parseInt(additions || '0', 10) || 0,
      deletions: deletions === '-' ? 0 : parseInt(deletions || '0', 10) || 0,
    }
  }

  private async getTrackedDiffStats(
    workDir: string,
    entries: ScopedStatusEntry[],
  ): Promise<DiffStatsByRepoPathResult> {
    if (!entries.some((entry) => entry.status !== 'untracked')) {
      return { kind: 'ok', statsByRepoPath: new Map() }
    }

    const result = await this.runGit(workDir, [
      'diff',
      '--numstat',
      '--find-renames',
      '--find-copies',
      'HEAD',
      '--',
    ])

    if (result.code !== 0) {
      return {
        kind: 'error',
        message: this.formatGitError(
          'Failed to read git diff stats',
          [
            'diff',
            '--numstat',
            '--find-renames',
            '--find-copies',
            'HEAD',
            '--',
          ],
          workDir,
          result,
        ),
      }
    }

    const statsByRepoPath = new Map<string, { additions: number; deletions: number }>()
    for (const line of result.stdout.trim().split('\n')) {
      if (!line) continue
      const [additions, deletions, repoPath] = line.split('\t')
      if (!repoPath) continue
      statsByRepoPath.set(this.normalizeRelativePath(repoPath), {
        additions: additions === '-' ? 0 : parseInt(additions || '0', 10) || 0,
        deletions: deletions === '-' ? 0 : parseInt(deletions || '0', 10) || 0,
      })
    }

    return { kind: 'ok', statsByRepoPath }
  }

  private async getUntrackedStats(
    absolutePath: string,
  ): Promise<DiffStatsResult> {
    try {
      const stat = await fs.stat(absolutePath)
      if (!stat.isFile()) {
        return { kind: 'ok', additions: 0, deletions: 0 }
      }
      if (stat.size > MAX_UNTRACKED_STAT_BYTES) {
        return { kind: 'ok', additions: 0, deletions: 0 }
      }

      const content = await fs.readFile(absolutePath, 'utf8')
      return {
        kind: 'ok',
        additions: this.countTextLines(content),
        deletions: 0,
      }
    } catch (error) {
      return {
        kind: 'error',
        message: this.formatFsError(
          'Failed to read untracked workspace file',
          absolutePath,
          error,
        ),
      }
    }
  }

  private countTextLines(content: string): number {
    if (!content) return 0
    const lines = content.split(/\r\n|\r|\n/)
    if (lines[lines.length - 1] === '') {
      lines.pop()
    }
    return lines.length
  }

  private async runGitDiff(
    workDir: string,
    relativePath: string,
    requestedEncoding: WorkspaceTextEncoding,
  ): Promise<{ kind: 'ok'; diff: string } | { kind: 'error'; message: string }> {
    const args = [
      'diff',
      '--no-ext-diff',
      '--binary',
      '--find-renames',
      '--find-copies',
      'HEAD',
      '--',
      relativePath,
    ]
    const result = await this.runGitBuffer(workDir, args)

    if (result.code !== 0) {
      return {
        kind: 'error',
        message: this.formatGitError(
          'Failed to read git diff',
          args,
          workDir,
          {
            stdout: '',
            stderr: result.stderr,
            code: result.code,
            failure: result.failure,
            outputLimitExceeded: result.outputLimitExceeded,
          },
        ),
      }
    }

    return { kind: 'ok', diff: decodeWorkspaceText(result.stdout, requestedEncoding).content }
  }

  private async runGitBuffer(
    workDir: string,
    args: string[],
  ): Promise<BufferCommandResult> {
    try {
      const result = await execFile('git', args, {
        cwd: workDir,
        timeout: GIT_TIMEOUT_MS,
        maxBuffer: MAX_GIT_BUFFER_BYTES,
        encoding: 'buffer',
      })
      return { stdout: result.stdout, stderr: result.stderr.toString('utf8'), code: 0 }
    } catch (error) {
      const err = error as NodeJS.ErrnoException & { stdout?: string | Buffer; stderr?: string | Buffer; code?: number | string }
      const outputLimitExceeded = this.isOutputLimitError(err)
      return {
        stdout: Buffer.alloc(0),
        stderr: outputLimitExceeded ? '' : decodeCommandOutput(err.stderr),
        code: typeof err.code === 'number' ? err.code : 1,
        failure: outputLimitExceeded
          ? `Git command output exceeded ${MAX_GIT_BUFFER_BYTES} bytes.`
          : err.message || (typeof err.code === 'string' ? err.code : undefined),
        ...(outputLimitExceeded ? { outputLimitExceeded: true } : {}),
      }
    }
  }

  private async getSvnDiffStatsForCanonicalPath(
    svnRoot: string,
    canonicalTargetPath: string,
  ): Promise<DiffStatsResult> {
    const result = await this.runSvnDiffForCanonicalPath(svnRoot, canonicalTargetPath)
    if (result.kind === 'error') return result
    return { kind: 'ok', ...this.countSvnDiffStats(result.diff) }
  }

  private countSvnDiffStats(diff: string): { additions: number; deletions: number } {
    let additions = 0
    let deletions = 0
    for (const line of diff.split('\n')) {
      if (line.startsWith('+') && !line.startsWith('+++')) additions += 1
      if (line.startsWith('-') && !line.startsWith('---')) deletions += 1
    }
    return { additions, deletions }
  }

  private async runSvnDiff(
    workspaceRoot: string,
    relativePath: string,
  ): Promise<{ kind: 'ok'; diff: string } | { kind: 'error'; message: string }> {
    const result = await this.runSvn(workspaceRoot, ['diff', '--', relativePath])
    if (result.code !== 0) {
      return {
        kind: 'error',
        message: this.formatSvnError('Failed to read SVN diff', ['diff', '--', relativePath], workspaceRoot, result),
      }
    }
    return { kind: 'ok', diff: result.stdout }
  }

  private async runGit(
    workDir: string,
    args: string[],
  ): Promise<GitCommandResult> {
    try {
      const result = await execFile('git', args, {
        cwd: workDir,
        timeout: GIT_TIMEOUT_MS,
        maxBuffer: MAX_GIT_BUFFER_BYTES,
        encoding: 'utf8',
      })

      return {
        stdout: result.stdout,
        stderr: result.stderr,
        code: 0,
      }
    } catch (error) {
      const err = error as NodeJS.ErrnoException & {
        stdout?: string | Buffer
        stderr?: string | Buffer
        code?: number | string
      }

      return {
        stdout:
          typeof err.stdout === 'string'
            ? err.stdout
            : Buffer.isBuffer(err.stdout)
              ? err.stdout.toString('utf8')
              : '',
        stderr:
          typeof err.stderr === 'string'
            ? err.stderr
            : Buffer.isBuffer(err.stderr)
              ? err.stderr.toString('utf8')
              : '',
        code: typeof err.code === 'number' ? err.code : 1,
      }
    }
  }

  private async runSvn(
    workDir: string,
    args: string[],
    maxBuffer = MAX_GIT_BUFFER_BYTES,
    timeout = GIT_TIMEOUT_MS,
  ): Promise<GitCommandResult> {
    let lastMissingExecutableError: NodeJS.ErrnoException | null = null
    const executables = this.resolveSvnExecutables()

    for (const executable of executables) {
      try {
        const result = await execFile(executable, args, {
          cwd: workDir,
          timeout,
          maxBuffer,
          encoding: 'buffer',
        })
        return {
          stdout: decodeCommandOutput(result.stdout),
          stderr: decodeCommandOutput(result.stderr),
          code: 0,
        }
      } catch (error) {
        const err = error as NodeJS.ErrnoException & {
          stdout?: string | Buffer
          stderr?: string | Buffer
          code?: number | string
          killed?: boolean
        }
        if (err.code === 'ENOENT') {
          lastMissingExecutableError = err
          continue
        }
        const outputLimitExceeded = this.isOutputLimitError(err)
        return {
          stdout: '',
          stderr: outputLimitExceeded ? '' : decodeCommandOutput(err.stderr),
          code: typeof err.code === 'number' ? err.code : 1,
          failure: outputLimitExceeded
            ? `SVN command output exceeded ${maxBuffer} bytes.`
            : err.killed
              ? `SVN command timed out after ${timeout} ms.`
            : err.message || (typeof err.code === 'string' ? err.code : undefined),
          ...(outputLimitExceeded ? { outputLimitExceeded: true } : {}),
        }
      }
    }

    const attempted = executables.length > 0 ? executables.join(', ') : 'svn'
    const workDirStat = await this.safeStat(workDir)
    return {
      stdout: '',
      stderr: '',
      code: 1,
      failure: lastMissingExecutableError
        ? workDirStat.kind === 'missing'
          ? `SVN working directory was not found: ${workDir}`
          : `SVN executable was not found. Tried: ${attempted}`
        : 'No SVN executable candidates were configured.',
    }
  }

  private async runSvnBuffer(
    workDir: string,
    args: string[],
    maxBuffer = MAX_GIT_BUFFER_BYTES,
  ): Promise<BufferCommandResult> {
    let lastMissingExecutableError: NodeJS.ErrnoException | null = null
    const executables = this.resolveSvnExecutables()

    for (const executable of executables) {
      try {
        const result = await execFile(executable, args, {
          cwd: workDir,
          timeout: GIT_TIMEOUT_MS,
          maxBuffer,
          encoding: 'buffer',
        })
        return {
          stdout: result.stdout,
          stderr: decodeCommandOutput(result.stderr),
          code: 0,
        }
      } catch (error) {
        const err = error as NodeJS.ErrnoException & {
          stdout?: string | Buffer
          stderr?: string | Buffer
          code?: number | string
          killed?: boolean
        }
        if (err.code === 'ENOENT') {
          lastMissingExecutableError = err
          continue
        }
        const outputLimitExceeded = this.isOutputLimitError(err)
        return {
          stdout: Buffer.alloc(0),
          stderr: outputLimitExceeded ? '' : decodeCommandOutput(err.stderr),
          code: typeof err.code === 'number' ? err.code : 1,
          failure: outputLimitExceeded
            ? `SVN command output exceeded ${maxBuffer} bytes.`
            : err.killed
            ? `SVN command timed out after ${GIT_TIMEOUT_MS} ms.`
            : err.message || (typeof err.code === 'string' ? err.code : undefined),
          ...(outputLimitExceeded ? { outputLimitExceeded: true } : {}),
        }
      }
    }

    const attempted = executables.length > 0 ? executables.join(', ') : 'svn'
    const workDirStat = await this.safeStat(workDir)
    return {
      stdout: Buffer.alloc(0),
      stderr: '',
      code: 1,
      failure: lastMissingExecutableError
        ? workDirStat.kind === 'missing'
          ? `SVN working directory was not found: ${workDir}`
          : `SVN executable was not found. Tried: ${attempted}`
        : 'No SVN executable candidates were configured.',
    }
  }

  private async findNearestExistingDirectory(
    startPath: string,
    floorPath: string,
  ): Promise<string> {
    let candidate = startPath
    while (true) {
      const candidateStat = await this.safeStat(candidate)
      if (candidateStat.kind === 'ok' && candidateStat.stat.isDirectory()) {
        return candidate
      }

      const parent = path.dirname(candidate)
      const parentFromFloor = path.relative(floorPath, parent)
      if (
        parent === candidate
        || parentFromFloor === '..'
        || parentFromFloor.startsWith(`..${path.sep}`)
        || path.isAbsolute(parentFromFloor)
      ) {
        return floorPath
      }
      candidate = parent
    }
  }

  private async buildUntrackedDiff(
    absolutePath: string,
    relativePath: string,
    requestedEncoding: WorkspaceTextEncoding,
  ): Promise<UntrackedDiffResult> {
    const stat = await this.safeStat(absolutePath)
    if (stat.kind === 'error') {
      return { kind: 'error', message: stat.message }
    }
    if (stat.kind === 'missing' || !stat.stat.isFile()) {
      return { kind: 'missing' }
    }

    let buffer: Buffer
    try {
      buffer = await fs.readFile(absolutePath)
    } catch (error) {
      return {
        kind: 'error',
        message: this.formatFsError(
          'Failed to read untracked workspace file',
          absolutePath,
          error,
        ),
      }
    }
    if (buffer.includes(0)) {
      return {
        kind: 'ok',
        diff: [
          `diff --git a/${relativePath} b/${relativePath}`,
          'new file mode 100644',
          `Binary files /dev/null and b/${relativePath} differ`,
          '',
        ].join('\n'),
      }
    }

    const content = decodeWorkspaceText(buffer, requestedEncoding).content
    const lines = content.split(/\r\n|\r|\n/)
    if (lines[lines.length - 1] === '') {
      lines.pop()
    }

    const hunkLines = lines.map((line) => `+${line}`)
    if (hunkLines.length === 0) {
      hunkLines.push('+')
    }

    return {
      kind: 'ok',
      diff: [
        `diff --git a/${relativePath} b/${relativePath}`,
        'new file mode 100644',
        '--- /dev/null',
        `+++ b/${relativePath}`,
        `@@ -0,0 +1,${hunkLines.length} @@`,
        ...hunkLines,
        '',
      ].join('\n'),
    }
  }

  private formatFsError(
    prefix: string,
    targetPath: string,
    error: unknown,
  ): string {
    const err = error as NodeJS.ErrnoException
    const code = err.code ? `${err.code}: ` : ''
    return `${prefix} (${targetPath}): ${code}${err.message || 'unknown error'}`
  }

  private formatGitError(
    prefix: string,
    args: string[],
    workDir: string,
    result: GitCommandResult,
  ): string {
    const details = result.stderr.trim() || result.failure || `Git exited with code ${result.code}.`
    return `${prefix} (git ${this.formatCommandArgs(args)} in ${this.limitCommandErrorText(workDir)}): ${this.limitCommandErrorText(details)}`
  }

  private formatSvnError(
    prefix: string,
    args: string[],
    workDir: string,
    result: GitCommandResult,
  ): string {
    const stderr = result.stderr.trim()
    // Failed commands may carry partial stdout containing megabytes of source
    // or XML. Never place stdout on the HTTP/UI error surface.
    const details = stderr
      || result.failure
      || (result.stdout.trimStart().startsWith('<?xml')
        ? 'SVN returned XML status output but the command did not complete.'
        : `SVN exited with code ${result.code}.`)
    return `${prefix} (svn ${this.formatCommandArgs(args)} in ${this.limitCommandErrorText(workDir)}): ${this.limitCommandErrorText(details)}`
  }

  private isOutputLimitError(error: NodeJS.ErrnoException): boolean {
    return error.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER'
      || /maxbuffer|stdout maxbuffer|stderr maxbuffer/i.test(error.message ?? '')
  }

  private limitCommandErrorText(value: string): string {
    const normalized = value.replace(/[\r\n\t]+/g, ' ').trim()
    return normalized.length <= MAX_COMMAND_ERROR_DETAILS_CHARS
      ? normalized
      : `${normalized.slice(0, MAX_COMMAND_ERROR_DETAILS_CHARS)}…`
  }

  private formatCommandArgs(args: string[]): string {
    return this.limitCommandErrorText(args.join(' '))
  }
}
