import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import * as fs from 'node:fs/promises'
import { execFileSync } from 'node:child_process'
import * as os from 'node:os'
import * as path from 'node:path'
import { resolveSvnExecutableCandidates, WorkspaceService } from '../services/workspaceService.js'
import {
  clearFilesystemAccessRootsForTests,
  registerFilesystemAccessRoot,
} from '../services/filesystemAccessRoots.js'

const cleanupDirs = new Set<string>()
const ONE_MIB = 1024 * 1024

function trackDir(dir: string): string {
  cleanupDirs.add(dir)
  return dir
}

async function makeTempDir(prefix: string): Promise<string> {
  return trackDir(await fs.mkdtemp(path.join(os.tmpdir(), prefix)))
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
  })
}

function svn(cwd: string, ...args: string[]): string {
  return execFileSync('svn', args, {
    cwd,
    encoding: 'utf8',
  })
}

function svnFileUrl(filePath: string): string {
  return `file:///${filePath.replace(/\\/g, '/')}`
}

async function createSvnWorkspace(): Promise<string> {
  const repositoryDir = await makeTempDir('workspace-service-svn-repo-')
  const workspaceDir = await makeTempDir('workspace-service-svn-wc-')
  execFileSync('svnadmin', ['create', repositoryDir])
  svn(workspaceDir, 'checkout', svnFileUrl(repositoryDir), workspaceDir)
  await fs.writeFile(path.join(workspaceDir, 'tracked.txt'), 'before\n')
  await fs.writeFile(path.join(workspaceDir, '-dash.txt'), 'dash before\n')
  await fs.writeFile(path.join(workspaceDir, 'deleted.txt'), 'delete from svn\n')
  await fs.writeFile(path.join(workspaceDir, '编译说明.md'), '# 编译说明\n旧内容\n')
  // Some Windows SVN builds corrupt non-ASCII command arguments through the
  // active code page. Add from the working directory without passing the name.
  svn(workspaceDir, 'add', '--force', '.')
  svn(workspaceDir, 'commit', '-m', 'initial')
  await fs.writeFile(path.join(workspaceDir, 'tracked.txt'), 'before\nafter\n')
  await fs.writeFile(path.join(workspaceDir, '-dash.txt'), 'dash before\ndash after\n')
  await fs.writeFile(path.join(workspaceDir, '编译说明.md'), '# 编译说明\n旧内容\n新增内容\n')
  await fs.writeFile(path.join(workspaceDir, 'new.txt'), 'new file\n')
  svn(workspaceDir, 'add', 'new.txt')
  svn(workspaceDir, 'delete', 'deleted.txt')
  return workspaceDir
}

async function createSwitchedSvnWorkspace(): Promise<string> {
  const repositoryDir = await makeTempDir('workspace-service-svn-switched-repo-')
  const workspaceDir = await makeTempDir('workspace-service-svn-switched-wc-')
  const branchWorkspaceDir = await makeTempDir('workspace-service-svn-switched-branch-wc-')
  const repositoryUrl = svnFileUrl(repositoryDir)
  execFileSync('svnadmin', ['create', repositoryDir])
  svn(workspaceDir, 'mkdir', `${repositoryUrl}/trunk`, '-m', 'create trunk')
  svn(workspaceDir, 'checkout', `${repositoryUrl}/trunk`, workspaceDir)
  await fs.mkdir(path.join(workspaceDir, 'sub'))
  await fs.writeFile(path.join(workspaceDir, 'sub', '中文.txt'), 'TRUNK-BASE\n')
  // Avoid passing the Unicode file name through Windows argv.
  svn(workspaceDir, 'add', '--force', '.')
  svn(workspaceDir, 'commit', '-m', 'trunk baseline')
  svn(workspaceDir, 'copy', `${repositoryUrl}/trunk`, `${repositoryUrl}/branch`, '-m', 'create branch')
  svn(branchWorkspaceDir, 'checkout', `${repositoryUrl}/branch`, branchWorkspaceDir)
  await fs.writeFile(path.join(branchWorkspaceDir, 'sub', '中文.txt'), 'BRANCH-BASE\n')
  svn(branchWorkspaceDir, 'commit', '-m', 'branch baseline')
  svn(workspaceDir, 'switch', `${repositoryUrl}/branch/sub`, 'sub')
  await fs.writeFile(path.join(workspaceDir, 'sub', '中文.txt'), 'LOCAL-SWITCHED\n')
  return workspaceDir
}

async function createGitWorkspace(): Promise<string> {
  const repoDir = await makeTempDir('workspace-service-git-')

  git(repoDir, 'init')
  git(repoDir, 'config', 'user.email', 'workspace-service@example.com')
  git(repoDir, 'config', 'user.name', 'Workspace Service')

  await fs.writeFile(path.join(repoDir, 'tracked.txt'), 'before\n')
  await fs.writeFile(path.join(repoDir, 'deleted.txt'), 'delete me\n')
  await fs.writeFile(path.join(repoDir, 'clean.txt'), 'clean\n')
  git(repoDir, 'add', 'tracked.txt', 'deleted.txt', 'clean.txt')
  git(repoDir, 'commit', '-m', 'initial')

  await fs.writeFile(path.join(repoDir, 'tracked.txt'), 'before\nafter\n')
  await fs.writeFile(path.join(repoDir, 'new.txt'), 'new file\n')
  git(repoDir, 'add', 'new.txt')
  await fs.unlink(path.join(repoDir, 'deleted.txt'))
  await fs.writeFile(path.join(repoDir, 'untracked.txt'), 'still untracked\n')

  return repoDir
}

async function createNestedGitWorkspace(): Promise<{
  repoDir: string
  workDir: string
}> {
  const repoDir = await makeTempDir('workspace-service-nested-git-')
  const workDir = path.join(repoDir, 'subdir')

  git(repoDir, 'init')
  git(repoDir, 'config', 'user.email', 'workspace-service@example.com')
  git(repoDir, 'config', 'user.name', 'Workspace Service')

  await fs.mkdir(workDir)
  await fs.writeFile(path.join(repoDir, 'root.txt'), 'root original\n')
  await fs.writeFile(path.join(workDir, 'sub.txt'), 'sub original\n')
  git(repoDir, 'add', 'root.txt', 'subdir/sub.txt')
  git(repoDir, 'commit', '-m', 'initial')

  await fs.writeFile(path.join(repoDir, 'root.txt'), 'root original\nroot changed\n')
  await fs.writeFile(path.join(workDir, 'sub.txt'), 'sub original\nsub changed\n')

  return { repoDir, workDir }
}

afterEach(async () => {
  for (const dir of cleanupDirs) {
    await fs.rm(dir, { recursive: true, force: true })
  }
  cleanupDirs.clear()
})

describe('WorkspaceService outside-workspace preview', () => {
  // Cleared going in as well as coming out. The registry is one module-level Set that
  // every test file in the process shares, and these tests open by asserting a path is
  // *not* reachable — a precondition they cannot assume, only establish. In a full run
  // they inherited the entire macOS temp root: title-service.test.ts:463 and
  // sessions.test.ts:2860 both create a session on the bare os.tmpdir(), and
  // registering a session's workDir is exactly what sessionService is supposed to do.
  // So every path under /var/folders/.../T was already allowed by the time this file
  // ran, and the "outside workspace" assertion failed. Matches the pairing that
  // filesystemAccessRoots.test.ts and h5-access-auth.test.ts already use.
  beforeEach(() => {
    clearFilesystemAccessRootsForTests()
  })

  afterEach(() => {
    clearFilesystemAccessRootsForTests()
  })

  it('restores one checkpoint external file without exposing its sibling or another session', async () => {
    const workDir = await makeTempDir('workspace-service-work-')
    const outsideDir = await makeTempDir('workspace-service-outside-')
    const outsideFile = path.join(outsideDir, 'todo.html')
    const siblingFile = path.join(outsideDir, 'secret.txt')
    await fs.writeFile(outsideFile, '<h1>hi</h1>\n')
    await fs.writeFile(siblingFile, 'secret\n')

    const service = new WorkspaceService(async (sessionId) => (
      sessionId === 'session-1' || sessionId === 'session-2' ? workDir : null
    ))

    // Not registered yet → treated as a sandbox escape.
    await expect(service.readFile('session-1', outsideFile)).rejects.toThrow(/outside workspace/)

    await service.registerTurnCheckpointFileReadAccess('session-1', outsideFile, workDir)
    const allowed = await service.readFile('session-1', outsideFile)
    expect(allowed.state).toBe('ok')
    expect(allowed.content).toContain('<h1>hi</h1>')
    await expect(service.readFile('session-1', siblingFile)).rejects.toThrow(/outside workspace/)
    await expect(service.readFile('session-2', outsideFile)).rejects.toThrow(/outside workspace/)

    await expect(service.grantExternalFileWriteAccess('session-1', outsideFile)).resolves.toMatchObject({
      path: expect.stringMatching(/todo\.html$/),
    })
    await expect(service.grantExternalFileWriteAccess('session-1', siblingFile)).rejects.toThrow(/outside workspace/)
    await expect(service.grantExternalFileWriteAccess('session-2', outsideFile)).rejects.toThrow(/outside workspace/)
  })

  it('still rejects an unrelated path even when another outside dir is registered', async () => {
    const workDir = await makeTempDir('workspace-service-work-')
    const registeredDir = await makeTempDir('workspace-service-reg-')
    const unrelatedDir = await makeTempDir('workspace-service-unrelated-')
    const unrelatedFile = path.join(unrelatedDir, 'secret.txt')
    await fs.writeFile(unrelatedFile, 'nope\n')
    registerFilesystemAccessRoot(registeredDir)

    const service = new WorkspaceService(async (sessionId) => sessionId === 'session-1' ? workDir : null)

    await expect(service.readFile('session-1', unrelatedFile)).rejects.toThrow(/outside workspace/)
  })

  it('does not allow relative traversal through a registered outside dir', async () => {
    const baseDir = await makeTempDir('workspace-service-base-')
    const workDir = path.join(baseDir, 'work')
    const outsideFile = path.join(baseDir, 'outside.txt')
    await fs.mkdir(workDir)
    await fs.writeFile(outsideFile, 'secret\n')
    registerFilesystemAccessRoot(baseDir)

    const service = new WorkspaceService(async (sessionId) => sessionId === 'session-1' ? workDir : null)

    await expect(service.readFile('session-1', '../outside.txt')).rejects.toThrow(/outside workspace/)
  })
})

describe('WorkspaceService', () => {
  it('coalesces concurrent status requests for the same session', async () => {
    const missingWorkDir = path.join(os.tmpdir(), `workspace-service-missing-${crypto.randomUUID()}`)
    let resolveWorkDir!: (value: string) => void
    const workDirPromise = new Promise<string>((resolve) => { resolveWorkDir = resolve })
    let resolverCalls = 0
    const service = new WorkspaceService(async () => {
      resolverCalls += 1
      return workDirPromise
    })

    const requests = Array.from({ length: 24 }, () => service.getStatus('session-single-flight'))
    expect(resolverCalls).toBe(1)
    resolveWorkDir(missingWorkDir)

    const results = await Promise.all(requests)
    expect(results).toHaveLength(24)
    expect(results.every((result) => result.state === 'missing_workdir')).toBe(true)
    expect(resolverCalls).toBe(1)

    await service.getStatus('session-single-flight')
    expect(resolverCalls).toBe(2)
  })

  it('discovers common Windows SVN installations when the desktop PATH omits svn', () => {
    expect(resolveSvnExecutableCandidates({
      SVN_EXECUTABLE: 'D:\\PortableSVN\\svn.exe',
      ProgramFiles: 'C:\\Program Files',
      'ProgramFiles(x86)': 'C:\\Program Files (x86)',
      LOCALAPPDATA: 'C:\\Users\\tester\\AppData\\Local',
    }, 'win32')).toEqual([
      'D:\\PortableSVN\\svn.exe',
      'svn',
      'C:\\Program Files\\TortoiseSVN\\bin\\svn.exe',
      'C:\\Program Files\\Subversion\\bin\\svn.exe',
      'C:\\Program Files (x86)\\TortoiseSVN\\bin\\svn.exe',
      'C:\\Program Files (x86)\\Subversion\\bin\\svn.exe',
      'C:\\Users\\tester\\AppData\\Local\\Programs\\TortoiseSVN\\bin\\svn.exe',
    ])
  })

  it('uses SVN status and diff when the workspace is not a git repository', async () => {
    const workspaceDir = await createSvnWorkspace()
    const service = new WorkspaceService(
      async () => workspaceDir,
      undefined,
      undefined,
      () => ['cc-haha-definitely-missing-svn', 'svn'],
    ) as WorkspaceService & {
      runSvn: (workDir: string, args: string[], maxBuffer?: number, timeout?: number) => Promise<{
        stdout: string
        stderr: string
        code: number
        failure?: string
      }>
    }
    const runSvn = service.runSvn.bind(service)
    const svnCalls: Array<{ workDir: string; args: string[] }> = []
    let statusOptions: { maxBuffer?: number; timeout?: number } | null = null
    service.runSvn = async (workDir, args, maxBuffer, timeout) => {
      svnCalls.push({ workDir, args })
      if (args[0] === 'status') statusOptions = { maxBuffer, timeout }
      return await runSvn(workDir, args, maxBuffer, timeout)
    }

    await expect(service.getStatus('session-1')).resolves.toMatchObject({
      state: 'ok',
      isGitRepo: false,
      changedFiles: expect.arrayContaining([
        expect.objectContaining({ path: 'tracked.txt', status: 'modified', additions: 1, deletions: 0 }),
        expect.objectContaining({ path: '编译说明.md', status: 'modified', additions: 1, deletions: 0 }),
        expect.objectContaining({ path: 'new.txt', status: 'added', additions: 1, deletions: 0 }),
      ]),
    })
    await expect(service.getDiff('session-1', 'tracked.txt')).resolves.toMatchObject({
      state: 'ok',
      path: 'tracked.txt',
      diff: expect.stringContaining('+after'),
    })
    await expect(service.getDiff('session-1', '编译说明.md')).resolves.toMatchObject({
      state: 'ok',
      path: '编译说明.md',
      diff: expect.stringContaining('+新增内容'),
    })
    expect(svnCalls).toContainEqual({
      workDir: workspaceDir,
      args: ['diff', '--', 'tracked.txt'],
    })
    expect(svnCalls).toContainEqual({
      workDir: workspaceDir,
      args: ['diff', '--depth', 'files'],
    })
    expect(svnCalls).toContainEqual({
      workDir: workspaceDir,
      args: ['status', '--xml'],
    })
    expect(statusOptions).toEqual({ maxBuffer: 16 * 1024 * 1024, timeout: 30_000 })
    expect(svnCalls.some((call) => call.args.includes('编译说明.md'))).toBe(false)
  })

  it('reads SVN changes whose immediate parent directory was deleted', async () => {
    const workspaceDir = await createSvnWorkspace()
    const deletedParent = path.join(workspaceDir, 'removed-parent')
    const deletedNested = path.join(deletedParent, '深层')
    await fs.mkdir(deletedNested, { recursive: true })
    await fs.writeFile(path.join(deletedParent, 'deleted.txt'), 'deleted line\n')
    await fs.writeFile(path.join(deletedNested, 'deleted.txt'), 'nested deleted line\n')
    svn(workspaceDir, 'add', 'removed-parent')
    svn(workspaceDir, 'commit', '-m', 'add directory that will be removed')
    svn(deletedParent, 'delete', 'deleted.txt')
    svn(deletedNested, 'delete', 'deleted.txt')
    await fs.rm(deletedParent, { recursive: true })
    const service = new WorkspaceService(async () => workspaceDir)

    const status = await service.getStatus('session-1')

    expect(status).toMatchObject({ state: 'ok', isGitRepo: false })
    expect(status.changedFiles).toEqual(expect.arrayContaining([
      expect.objectContaining({
        path: 'removed-parent/deleted.txt',
        status: 'deleted',
        additions: 0,
        deletions: 1,
      }),
      expect.objectContaining({
        path: 'removed-parent/深层/deleted.txt',
        status: 'deleted',
        additions: 0,
        deletions: 1,
      }),
    ]))
    await expect(
      service.getDiff('session-1', 'removed-parent/deleted.txt'),
    ).resolves.toMatchObject({
      state: 'ok',
      diff: expect.stringContaining('-deleted line'),
    })
    await expect(
      service.getDiff('session-1', 'removed-parent/深层/deleted.txt'),
    ).resolves.toMatchObject({
      state: 'ok',
      diff: expect.stringContaining('-nested deleted line'),
    })
  })

  it('does not misreport a missing SVN working directory as a missing executable', async () => {
    const workspaceDir = await createSvnWorkspace()
    const missingWorkDir = path.join(workspaceDir, 'missing-directory')
    const service = new WorkspaceService(
      async () => workspaceDir,
      undefined,
      undefined,
      () => ['svn'],
    ) as WorkspaceService & {
      runSvn: (workDir: string, args: string[]) => Promise<{
        stdout: string
        stderr: string
        code: number
        failure?: string
      }>
    }

    await expect(service.runSvn(missingWorkDir, ['--version', '--quiet'])).resolves.toMatchObject({
      code: 1,
      failure: `SVN working directory was not found: ${missingWorkDir}`,
    })
  })

  it('writes review edits only when the displayed file content is still current', async () => {
    const workspaceDir = await makeTempDir('workspace-service-review-write-')
    const target = path.join(workspaceDir, 'note.txt')
    await fs.writeFile(target, 'before\n')
    const service = new WorkspaceService(async () => workspaceDir)

    await expect(service.writeTextFile('session-1', 'note.txt', 'before\n', 'after\n')).resolves.toMatchObject({
      state: 'ok',
      content: 'after\n',
    })
    await expect(fs.readFile(target, 'utf8')).resolves.toBe('after\n')
    await expect(service.writeTextFile('session-1', 'note.txt', 'before\n', 'lost\n')).resolves.toMatchObject({
      state: 'conflict',
    })
  })

  it('creates a missing review file only for an explicit null CAS expectation', async () => {
    const workspaceDir = await makeTempDir('workspace-service-review-create-')
    const service = new WorkspaceService(async () => workspaceDir)

    for (const fileName of ['created.txt', '-dash.txt', '中文.txt']) {
      const content = `created ${fileName}\n`
      await expect(service.writeTextFile('session-1', fileName, null, content)).resolves.toMatchObject({
        state: 'ok',
        path: fileName,
        content,
        size: Buffer.byteLength(content),
      })
      await expect(fs.readFile(path.join(workspaceDir, fileName), 'utf8')).resolves.toBe(content)
      await expect(service.writeTextFile('session-1', fileName, null, 'must not overwrite\n')).resolves.toMatchObject({
        state: 'conflict',
      })
      await expect(fs.readFile(path.join(workspaceDir, fileName), 'utf8')).resolves.toBe(content)
    }

    await expect(
      (service.writeTextFile as unknown as (
        sessionId: string,
        filePath: string,
        expectedContent: undefined,
        content: string,
      ) => ReturnType<WorkspaceService['writeTextFile']>)('session-1', 'undefined.txt', undefined, 'must not exist\n'),
    ).resolves.toMatchObject({ state: 'conflict' })
    await expect(fs.stat(path.join(workspaceDir, 'undefined.txt'))).rejects.toMatchObject({ code: 'ENOENT' })

    await expect(service.writeTextFile('session-1', 'stale.txt', 'stale baseline\n', 'must not exist\n')).resolves.toMatchObject({
      state: 'conflict',
    })
    await expect(fs.stat(path.join(workspaceDir, 'stale.txt'))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('preserves a file that wins the missing-file CAS race', async () => {
    const workspaceDir = await makeTempDir('workspace-service-review-create-race-')
    const target = path.join(workspaceDir, 'race.txt')
    const service = new WorkspaceService(async () => workspaceDir) as WorkspaceService & {
      readTextFileForWrite: (filePath: string) => Promise<
        | { kind: 'ok'; content: string | null }
        | { kind: 'binary' }
        | { kind: 'error'; message: string }
      >
    }
    const readTextFileForWrite = service.readTextFileForWrite.bind(service)
    let raced = false
    service.readTextFileForWrite = async (filePath) => {
      const result = await readTextFileForWrite(filePath)
      if (!raced && result.kind === 'ok' && result.content === null) {
        raced = true
        await fs.writeFile(target, 'race winner\n')
      }
      return result
    }

    await expect(service.writeTextFile('session-1', 'race.txt', null, 'review content\n')).resolves.toMatchObject({
      state: 'conflict',
    })
    await expect(fs.readFile(target, 'utf8')).resolves.toBe('race winner\n')
    expect(await fs.readdir(workspaceDir)).toEqual(['race.txt'])
  })

  it('does not publish partial content when an exclusive create write fails', async () => {
    const workspaceDir = await makeTempDir('workspace-service-review-create-failure-')
    const target = path.join(workspaceDir, 'partial.txt')
    const service = new WorkspaceService(async () => workspaceDir) as WorkspaceService & {
      writePreparedCreateFile: (
        handle: Awaited<ReturnType<typeof fs.open>>,
        content: string,
      ) => Promise<void>
    }
    service.writePreparedCreateFile = async (handle) => {
      await handle.writeFile('partial bytes', 'utf8')
      throw Object.assign(new Error('synthetic write failure'), { code: 'EIO' })
    }

    await expect(service.writeTextFile('session-1', 'partial.txt', null, 'complete content\n')).resolves.toMatchObject({
      state: 'error',
      error: expect.stringContaining('EIO'),
    })
    await expect(fs.stat(target)).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await fs.readdir(workspaceDir)).toEqual([])
  })

  it('rejects unsafe or unwritable parents when creating a missing review file', async () => {
    const workspaceDir = await makeTempDir('workspace-service-review-create-safe-')
    const outsideDir = await makeTempDir('workspace-service-review-create-outside-')
    const service = new WorkspaceService(async () => workspaceDir)

    await expect(service.writeTextFile('session-1', 'missing-parent/file.txt', null, 'no\n')).resolves.toMatchObject({
      state: 'error',
    })
    expect(await fs.readdir(workspaceDir)).toEqual([])

    await fs.mkdir(path.join(workspaceDir, 'directory-target'))
    await expect(service.writeTextFile('session-1', 'directory-target', null, 'no\n')).resolves.toMatchObject({
      state: 'error',
    })

    await expect(service.writeTextFile('session-1', '../outside.txt', null, 'no\n')).resolves.toMatchObject({
      state: 'error',
    })

    await service.registerExternalRoot('session-1', outsideDir)
    const registeredTarget = path.join(outsideDir, 'registered.txt')
    await expect(service.writeTextFile('session-1', registeredTarget, null, 'no\n')).resolves.toMatchObject({
      state: 'error',
      error: 'Registered external roots are read-only.',
    })
    await expect(fs.stat(registeredTarget)).rejects.toMatchObject({ code: 'ENOENT' })

    await fs.symlink(outsideDir, path.join(workspaceDir, 'linked-parent'), 'junction')
    await expect(service.writeTextFile('session-1', 'linked-parent/escaped.txt', null, 'no\n')).resolves.toMatchObject({
      state: 'error',
      error: 'Registered external roots are read-only.',
    })
    await expect(fs.stat(path.join(outsideDir, 'escaped.txt'))).rejects.toMatchObject({ code: 'ENOENT' })

    const internalTarget = path.join(workspaceDir, 'internal-target')
    await fs.mkdir(internalTarget)
    await fs.symlink(internalTarget, path.join(workspaceDir, 'linked-internal'), 'junction')
    await expect(service.writeTextFile('session-1', 'linked-internal/escaped.txt', null, 'no\n')).resolves.toMatchObject({
      state: 'error',
      error: expect.stringContaining('unsafe symbolic link'),
    })
    await expect(fs.stat(path.join(internalTarget, 'escaped.txt'))).rejects.toMatchObject({ code: 'ENOENT' })

    const deniedParent = path.join(workspaceDir, 'denied-parent')
    await fs.mkdir(deniedParent)
    const deniedService = new WorkspaceService(async () => workspaceDir) as WorkspaceService & {
      assertDirectoryWritable: (directoryPath: string) => Promise<void>
    }
    let checkedDirectory: string | null = null
    deniedService.assertDirectoryWritable = async (directoryPath) => {
      checkedDirectory = directoryPath
      throw Object.assign(new Error('synthetic access denied'), { code: 'EACCES' })
    }
    await expect(deniedService.writeTextFile('session-1', 'denied-parent/file.txt', null, 'no\n')).resolves.toMatchObject({
      state: 'error',
      error: expect.stringContaining('EACCES'),
    })
    expect(checkedDirectory).toBe(await fs.realpath(deniedParent))
    await expect(fs.stat(path.join(deniedParent, 'file.txt'))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('reverts a reviewed file through its Git baseline without touching other files', async () => {
    const workspaceDir = await createGitWorkspace()
    const service = new WorkspaceService(async () => workspaceDir)

    await expect(service.revertFile('session-1', 'tracked.txt', 'before\nafter\n')).resolves.toMatchObject({
      state: 'ok',
    })
    expect((await fs.readFile(path.join(workspaceDir, 'tracked.txt'), 'utf8')).replace(/\r\n/g, '\n')).toBe('before\n')
    await expect(fs.readFile(path.join(workspaceDir, 'untracked.txt'), 'utf8')).resolves.toBe('still untracked\n')
  })

  it('returns git status for modified, added, deleted, and untracked files', async () => {
    const repoDir = await createGitWorkspace()
    const service = new WorkspaceService(async (sessionId) => sessionId === 'session-1' ? repoDir : null)

    const result = await service.getStatus('session-1')

    expect(result.state).toBe('ok')
    expect(result.workDir).toBe(repoDir)
    expect(result.isGitRepo).toBe(true)
    expect(result.repoName).toBe(path.basename(repoDir))
    expect(result.branch).toBeTruthy()

    const files = new Map(result.changedFiles.map((file) => [file.path, file]))
    expect(Array.from(files.keys()).sort()).toEqual([
      'deleted.txt',
      'new.txt',
      'tracked.txt',
      'untracked.txt',
    ])
    expect(files.get('tracked.txt')?.status).toBe('modified')
    expect(files.get('tracked.txt')?.additions).toBeGreaterThan(0)
    expect(files.get('new.txt')?.status).toBe('added')
    expect(files.get('new.txt')?.additions).toBeGreaterThan(0)
    expect(files.get('deleted.txt')?.status).toBe('deleted')
    expect(files.get('deleted.txt')?.deletions).toBeGreaterThan(0)
    expect(files.get('untracked.txt')).toMatchObject({
      status: 'untracked',
      additions: 1,
      deletions: 0,
    })
  })

  it('scopes git status and diff paths to a nested workDir inside a repo', async () => {
    const { repoDir, workDir } = await createNestedGitWorkspace()
    const service = new WorkspaceService(async (sessionId) => sessionId === 'session-1' ? workDir : null)

    const status = await service.getStatus('session-1')

    expect(status.state).toBe('ok')
    expect(status.workDir).toBe(workDir)
    expect(status.repoName).toBe(path.basename(repoDir))
    expect(status.changedFiles).toHaveLength(1)
    expect(status.changedFiles[0]).toMatchObject({
      path: 'sub.txt',
      status: 'modified',
    })
    expect(status.changedFiles[0]?.additions).toBeGreaterThan(0)
    expect(status.changedFiles[0]?.deletions).toBeGreaterThanOrEqual(0)
    expect(status.changedFiles.some((file) => file.path === 'root.txt')).toBe(false)

    const diff = await service.getDiff('session-1', 'sub.txt')
    expect(diff.state).toBe('ok')
    expect(diff.diff).toContain('subdir/sub.txt')
    expect(diff.diff?.length).toBeGreaterThan(0)
  })

  it('prefers the live git diff over stale transcript edits for a currently changed file', async () => {
    const repoDir = await createGitWorkspace()
    const service = new WorkspaceService(
      async (sessionId) => sessionId === 'session-1' ? repoDir : null,
      async () => [{
        id: 'assistant-1',
        type: 'tool_use',
        timestamp: new Date().toISOString(),
        content: [{
          type: 'tool_use',
          name: 'Edit',
          input: {
            file_path: 'tracked.txt',
            old_string: 'before\n',
            new_string: 'model snapshot\n',
          },
        }],
      }],
    )

    const diff = await service.getDiff('session-1', 'tracked.txt')

    expect(diff.state).toBe('ok')
    expect(diff.diff).toContain('diff --git a/tracked.txt b/tracked.txt')
    expect(diff.diff).toContain('+after')
    expect(diff.diff).not.toContain('+model snapshot')
  })

  it('returns explicit non-git and missing-workdir states', async () => {
    const nonGitDir = await makeTempDir('workspace-service-non-git-')
    const missingDir = path.join(await makeTempDir('workspace-service-missing-parent-'), 'missing')
    const service = new WorkspaceService(async (sessionId) => {
      if (sessionId === 'non-git') return nonGitDir
      if (sessionId === 'missing') return missingDir
      return null
    })

    await expect(service.getStatus('unknown')).rejects.toThrow('Session not found: unknown')

    await expect(service.getStatus('non-git')).resolves.toMatchObject({
      state: 'ok',
      workDir: nonGitDir,
      repoName: path.basename(nonGitDir),
      isGitRepo: false,
      changedFiles: [],
    })

    await expect(service.getStatus('missing')).resolves.toMatchObject({
      state: 'missing_workdir',
      workDir: missingDir,
      isGitRepo: false,
      changedFiles: [],
    })
  })

  it('reports session tool edits without requiring a git repository', async () => {
    const nonGitDir = await makeTempDir('workspace-service-session-changes-')
    await fs.mkdir(path.join(nonGitDir, 'src'))
    await fs.writeFile(path.join(nonGitDir, 'src/App.jsx'), 'export default function App() { return <main>New</main> }\n')

    const service = new WorkspaceService(
      async () => nonGitDir,
      async () => [{
        id: 'assistant-1',
        type: 'tool_use',
        timestamp: new Date().toISOString(),
        content: [{
          type: 'tool_use',
          name: 'Edit',
          input: {
            file_path: 'src/App.jsx',
            old_string: 'export default function App() { return <main>Old</main> }\n',
            new_string: 'export default function App() { return <main>New</main> }\n',
          },
        }],
      }],
    )

    const status = await service.getStatus('session-1')

    expect(status).toMatchObject({
      state: 'ok',
      workDir: nonGitDir,
      isGitRepo: false,
      changedFiles: [{
        path: 'src/App.jsx',
        status: 'modified',
        additions: 1,
        deletions: 1,
      }],
    })

    const diff = await service.getDiff('session-1', 'src/App.jsx')
    expect(diff.state).toBe('ok')
    expect(diff.diff).toContain('diff --session a/src/App.jsx b/src/App.jsx')
    expect(diff.diff).toContain('-export default function App() { return <main>Old</main> }')
    expect(diff.diff).toContain('+export default function App() { return <main>New</main> }')
    expect(diff.comparison).toMatchObject({
      left: {
        exists: true,
        state: 'ok',
        content: 'export default function App() { return <main>Old</main> }\n',
        source: { kind: 'session_baseline' },
        writable: false,
      },
      right: {
        exists: true,
        state: 'ok',
        content: 'export default function App() { return <main>New</main> }\n',
        source: { kind: 'working_tree' },
        writable: true,
      },
    })
  })

  it('grants external writes to one exact canonical file in one session only', async () => {
    const workspaceDir = await makeTempDir('workspace-service-exact-grant-work-')
    const outsideDir = await createGitWorkspace()
    const grantedPath = path.join(outsideDir, 'tracked.txt')
    const siblingPath = path.join(outsideDir, 'clean.txt')
    const service = new WorkspaceService(async (sessionId) => (
      sessionId === 'session-1' || sessionId === 'session-2' ? workspaceDir : null
    ))
    await service.registerExternalRoot('session-1', outsideDir)

    await expect(service.writeTextFile('session-1', grantedPath, 'before\nafter\n', 'denied\n')).resolves.toMatchObject({
      state: 'error',
      error: 'Registered external roots are read-only.',
    })
    await expect(service.revertFile('session-1', grantedPath, 'before\nafter\n')).resolves.toMatchObject({
      state: 'error',
      error: 'Registered external roots are read-only.',
    })

    await expect(service.grantExternalFileWriteAccess('session-1', grantedPath)).resolves.toMatchObject({
      path: expect.stringMatching(/tracked\.txt$/),
    })
    await expect(service.getDiff('session-1', grantedPath)).resolves.toMatchObject({
      comparison: { right: { source: { kind: 'working_tree' }, writable: true } },
    })
    await expect(service.writeTextFile('session-1', grantedPath, 'before\nafter\n', 'after grant\n')).resolves.toMatchObject({
      state: 'ok',
      content: 'after grant\n',
    })
    await expect(fs.readFile(grantedPath, 'utf8')).resolves.toBe('after grant\n')

    await expect(service.writeTextFile('session-1', siblingPath, 'clean\n', 'changed\n')).resolves.toMatchObject({
      state: 'error',
      error: 'Registered external roots are read-only.',
    })
    await expect(service.writeTextFile('session-2', grantedPath, 'after grant\n', 'other session\n')).resolves.toMatchObject({
      state: 'error',
      error: expect.stringMatching(/outside workspace/),
    })
    await expect(service.grantExternalFileWriteAccess('session-2', grantedPath)).rejects.toThrow(
      /outside workspace/,
    )
    await expect(fs.readFile(siblingPath, 'utf8')).resolves.toBe('clean\n')
    await expect(fs.readFile(grantedPath, 'utf8')).resolves.toBe('after grant\n')
  })

  it('rejects external write grants outside trusted read roots and after a symlink retarget', async () => {
    const workspaceDir = await makeTempDir('workspace-service-grant-escape-work-')
    const trustedDir = await makeTempDir('workspace-service-grant-trusted-')
    const siblingDir = await makeTempDir('workspace-service-grant-sibling-')
    const trustedPath = path.join(trustedDir, 'target.txt')
    const siblingPath = path.join(siblingDir, 'secret.txt')
    await fs.writeFile(trustedPath, 'trusted\n')
    await fs.writeFile(siblingPath, 'secret\n')
    const service = new WorkspaceService(async () => workspaceDir)
    await service.registerExternalRoot('session-1', trustedDir)

    await expect(service.grantExternalFileWriteAccess('session-1', siblingPath)).rejects.toThrow(/outside workspace/)
    await service.grantExternalFileWriteAccess('session-1', trustedPath)

    await fs.unlink(trustedPath)
    await fs.symlink(siblingPath, trustedPath, 'file')
    await expect(service.writeTextFile('session-1', trustedPath, 'secret\n', 'escaped\n')).resolves.toMatchObject({
      state: 'error',
    })
    await expect(fs.readFile(siblingPath, 'utf8')).resolves.toBe('secret\n')
  })

  it('checks the canonical external file is writable before granting access', async () => {
    const workspaceDir = await makeTempDir('workspace-service-grant-writable-work-')
    const trustedDir = await makeTempDir('workspace-service-grant-writable-root-')
    const trustedPath = path.join(trustedDir, 'target.txt')
    await fs.writeFile(trustedPath, 'trusted\n')
    const service = new WorkspaceService(async () => workspaceDir) as WorkspaceService & {
      assertExternalFileWritable: (filePath: string) => Promise<void>
    }
    await service.registerExternalRoot('session-1', trustedDir)
    let checkedPath: string | null = null
    service.assertExternalFileWritable = async (filePath) => {
      checkedPath = filePath
      throw Object.assign(new Error('synthetic access denied'), { code: 'EACCES' })
    }

    await expect(service.grantExternalFileWriteAccess('session-1', trustedPath)).rejects.toThrow(/EACCES/)
    expect(checkedPath).toBe(await fs.realpath(trustedPath))
    await expect(service.writeTextFile('session-1', trustedPath, 'trusted\n', 'changed\n')).resolves.toMatchObject({
      state: 'error',
      error: 'Registered external roots are read-only.',
    })
    await expect(fs.readFile(trustedPath, 'utf8')).resolves.toBe('trusted\n')
  })

  it('reconstructs a complete session baseline across consecutive edits outside VCS', async () => {
    const nonGitDir = await makeTempDir('workspace-service-session-baseline-')
    await fs.writeFile(path.join(nonGitDir, 'notes.md'), 'head\r\nfinal value\r\ntail\r\n')
    const service = new WorkspaceService(
      async () => nonGitDir,
      async () => [{
        id: 'assistant-1',
        type: 'tool_use',
        timestamp: new Date().toISOString(),
        content: [
          {
            type: 'tool_use',
            name: 'Edit',
            input: { file_path: 'notes.md', old_string: 'old value', new_string: 'middle value' },
          },
          {
            type: 'tool_use',
            name: 'Edit',
            input: { file_path: 'notes.md', old_string: 'middle value', new_string: 'final value' },
          },
        ],
      }],
    )

    const diff = await service.getDiff('session-1', 'notes.md')

    expect(diff).toMatchObject({
      state: 'ok',
      comparison: {
        left: {
          state: 'ok',
          content: 'head\r\nold value\r\ntail\r\n',
          lineEnding: 'crlf',
          source: { kind: 'session_baseline' },
        },
        right: {
          state: 'ok',
          content: 'head\r\nfinal value\r\ntail\r\n',
          lineEnding: 'crlf',
          source: { kind: 'working_tree' },
        },
      },
    })
  })

  it('keeps full-file mode on the real SVN BASE after a session change is committed', async () => {
    const workspaceDir = await createSvnWorkspace()
    svn(workspaceDir, 'commit', '-m', 'finish session changes')
    const service = new WorkspaceService(
      async () => workspaceDir,
      async () => [{
        id: 'assistant-1',
        type: 'tool_use',
        timestamp: new Date().toISOString(),
        content: [{
          type: 'tool_use',
          name: 'Edit',
          input: {
            file_path: 'tracked.txt',
            old_string: 'before\n',
            new_string: 'before\nafter\n',
          },
        }],
      }],
    )

    const diff = await service.getDiff('session-1', 'tracked.txt')

    expect(diff).toMatchObject({
      state: 'ok',
      diff: '',
      comparison: {
        left: {
          state: 'ok',
          content: 'before\nafter\n',
          source: { kind: 'svn_base' },
        },
        right: {
          state: 'ok',
          content: 'before\nafter\n',
          source: { kind: 'working_tree' },
        },
      },
    })
  })

  it('does not fabricate a full comparison when the recorded patch cannot reproduce the working file', async () => {
    const nonGitDir = await makeTempDir('workspace-service-session-baseline-mismatch-')
    await fs.writeFile(path.join(nonGitDir, 'notes.md'), 'unexpected current content\n')
    const service = new WorkspaceService(
      async () => nonGitDir,
      async () => [{
        id: 'assistant-1',
        type: 'tool_use',
        timestamp: new Date().toISOString(),
        content: [{
          type: 'tool_use',
          name: 'Edit',
          input: { file_path: 'notes.md', old_string: 'old', new_string: 'new' },
        }],
      }],
    )

    const diff = await service.getDiff('session-1', 'notes.md')

    expect(diff.state).toBe('ok')
    expect(diff.diff).toContain('-old')
    expect(diff.comparison).toBeUndefined()
  })

  it('does not guess a session baseline when reverse patch placement is ambiguous', async () => {
    const nonGitDir = await makeTempDir('workspace-service-session-baseline-ambiguous-')
    await fs.writeFile(path.join(nonGitDir, 'notes.md'), 'new\nnew\n')
    const service = new WorkspaceService(
      async () => nonGitDir,
      async () => [{
        id: 'assistant-1',
        type: 'tool_use',
        timestamp: new Date().toISOString(),
        content: [{
          type: 'tool_use',
          name: 'Edit',
          input: { file_path: 'notes.md', old_string: 'old', new_string: 'new' },
        }],
      }],
    )

    const diff = await service.getDiff('session-1', 'notes.md')

    expect(diff.state).toBe('ok')
    expect(diff.comparison).toBeUndefined()
  })

  it('does not report a rejected session tool edit as a changed file', async () => {
    const nonGitDir = await makeTempDir('workspace-service-rejected-change-')
    const toolUseId = 'Write:rejected'
    const service = new WorkspaceService(
      async () => nonGitDir,
      async () => [
        {
          id: 'assistant-1',
          type: 'tool_use',
          timestamp: new Date().toISOString(),
          content: [{
            type: 'tool_use',
            id: toolUseId,
            name: 'Write',
            input: {
              file_path: 'permission-denial-test.txt',
              content: 'must not be written\n',
            },
          }],
        },
        {
          id: 'tool-result-1',
          type: 'tool_result',
          timestamp: new Date().toISOString(),
          content: [{
            type: 'tool_result',
            tool_use_id: toolUseId,
            content: 'The user rejected this tool use.',
            is_error: true,
          }],
        },
      ],
    )

    const status = await service.getStatus('session-1')

    expect(status).toMatchObject({
      state: 'ok',
      workDir: nonGitDir,
      isGitRepo: false,
      changedFiles: [],
    })
  })

  it('reports file-history changes without requiring a git repository', async () => {
    const nonGitDir = await makeTempDir('workspace-service-file-history-')
    const generatedFile = path.join(nonGitDir, 'aacc', 'src', 'App.tsx')
    await fs.mkdir(path.dirname(generatedFile), { recursive: true })
    await fs.writeFile(generatedFile, 'export default function App() { return <main>Tetris</main> }\n')

    const service = new WorkspaceService(
      async () => nonGitDir,
      async () => [],
      async () => [{
        messageId: '11111111-1111-4111-8111-111111111111',
        timestamp: new Date('2026-01-01T00:00:00.000Z'),
        trackedFileBackups: {
          'aacc/src/App.tsx': {
            backupFileName: null,
            version: 1,
            backupTime: new Date('2026-01-01T00:00:00.000Z'),
          },
        },
      }],
    )

    const status = await service.getStatus('session-1')

    expect(status).toMatchObject({
      state: 'ok',
      workDir: nonGitDir,
      isGitRepo: false,
      changedFiles: [{
        path: 'aacc/src/App.tsx',
        status: 'added',
        additions: 1,
        deletions: 0,
      }],
    })

    const diff = await service.getDiff('session-1', 'aacc/src/App.tsx')
    expect(diff.state).toBe('ok')
    expect(diff.diff).toContain('diff --session /dev/null b/aacc/src/App.tsx')
    expect(diff.diff).toContain('+export default function App() { return <main>Tetris</main> }')
  })

  it('matches Windows file-history paths case-insensitively inside the workspace', async () => {
    if (process.platform !== 'win32') return

    const nonGitDir = await makeTempDir('workspace-service-windows-paths-')
    const targetFile = path.join(nonGitDir, 'Child', 'index.ts')
    await fs.mkdir(path.dirname(targetFile), { recursive: true })
    await fs.writeFile(targetFile, 'export const value = 1\n')

    const lowerDrivePath = targetFile[0]?.toLowerCase() + targetFile.slice(1)
    const service = new WorkspaceService(
      async () => nonGitDir,
      async () => [],
      async () => [{
        messageId: '22222222-2222-4222-8222-222222222222',
        timestamp: new Date('2026-01-01T00:00:00.000Z'),
        trackedFileBackups: {
          [lowerDrivePath]: {
            backupFileName: null,
            version: 1,
            backupTime: new Date('2026-01-01T00:00:00.000Z'),
          },
        },
      }],
    )

    const status = await service.getStatus('session-1')

    expect(status.changedFiles).toEqual([{
      path: 'Child/index.ts',
      oldPath: undefined,
      status: 'added',
      additions: 1,
      deletions: 0,
    }])
  })

  it('rejects traversal attempts for file, diff, and tree access', async () => {
    const repoDir = await createGitWorkspace()
    const service = new WorkspaceService(async () => repoDir)

    await expect(service.readFile('session-1', '../outside.txt')).rejects.toThrow(/outside workspace/)
    await expect(service.getDiff('session-1', '../outside.txt')).resolves.toMatchObject({
      state: 'error',
      path: '../outside.txt',
    })
    await expect(service.readTree('session-1', '../outside')).rejects.toThrow(/outside workspace/)
  })

  it('rejects symlink targets that escape the workspace root', async () => {
    const workDir = await makeTempDir('workspace-service-symlink-')
    const outsideDir = await makeTempDir('workspace-service-symlink-outside-')
    const outsideFile = path.join(outsideDir, 'secret.txt')
    await fs.writeFile(outsideFile, 'top secret\n')
    await fs.symlink(outsideFile, path.join(workDir, 'escape.txt'))

    const service = new WorkspaceService(async () => workDir)

    await expect(service.readFile('session-1', 'escape.txt')).rejects.toThrow(/outside workspace/)
  })

  it('returns error for an untracked symlink that escapes the workspace root', async () => {
    const repoDir = await makeTempDir('workspace-service-symlink-git-')
    const outsideDir = await makeTempDir('workspace-service-symlink-git-outside-')
    const outsideFile = path.join(outsideDir, 'secret.txt')

    git(repoDir, 'init')
    git(repoDir, 'config', 'user.email', 'workspace-service@example.com')
    git(repoDir, 'config', 'user.name', 'Workspace Service')
    await fs.writeFile(path.join(repoDir, 'tracked.txt'), 'tracked\n')
    git(repoDir, 'add', 'tracked.txt')
    git(repoDir, 'commit', '-m', 'initial')

    await fs.writeFile(outsideFile, 'top secret\n')
    await fs.symlink(outsideFile, path.join(repoDir, 'escape.txt'))

    const service = new WorkspaceService(async () => repoDir)

    const status = await service.getStatus('session-1')
    expect(status.state).toBe('error')
    expect(status.error).toMatch(/outside workspace/)

    await expect(service.getDiff('session-1', 'escape.txt')).resolves.toMatchObject({
      state: 'error',
      path: 'escape.txt',
    })
    const diffOutcome = await service.getDiff('session-1', 'escape.txt')
    expect(diffOutcome.error).toMatch(/outside workspace/)
  })

  it('returns explicit readFile states for text, binary, large, and missing targets', async () => {
    const workDir = await makeTempDir('workspace-service-files-')
    const service = new WorkspaceService(async () => workDir)

    await fs.writeFile(path.join(workDir, 'note.ts'), 'export const answer = 42\n')
    await fs.writeFile(path.join(workDir, 'engine.cpp'), 'class Engine {};\n')
    await fs.writeFile(path.join(workDir, 'engine.hpp'), 'class Engine;\n')
    await fs.writeFile(path.join(workDir, 'bootstrap.lua'), 'local ready = true\n')
    await Promise.all([
      ['app.js', 'const ready = true\n'],
      ['run.sh', '#!/bin/bash\necho ready\n'],
      ['run.bash', '#!/bin/bash\necho ready\n'],
      ['build.bat', '@echo off\r\necho ready\r\n'],
      ['Program.cs', 'public class Program {}\n'],
      ['Game.sln', 'Microsoft Visual Studio Solution File\n'],
      ['Game.vcproj', '<VisualStudioProject />\n'],
      ['Game.vcxproj', '<Project />\n'],
    ].map(([name, content]) => fs.writeFile(path.join(workDir, name!), content!)))
    await fs.writeFile(path.join(workDir, 'legacy.txt'), Buffer.from([0xd6, 0xd0, 0xce, 0xc4, 0xb2, 0xe2, 0xca, 0xd4]))
    await fs.writeFile(path.join(workDir, 'late-legacy.txt'), Buffer.concat([
      Buffer.alloc(1024, 'a'),
      Buffer.from([0xd6, 0xd0, 0xce, 0xc4]),
    ]))
    await fs.writeFile(path.join(workDir, 'utf8-boundary.txt'), Buffer.concat([
      Buffer.alloc(16 * 1024 - 1, 'a'),
      Buffer.from('中文'),
    ]))
    await fs.writeFile(path.join(workDir, 'binary.bin'), Buffer.from([0, 1, 2, 3]))
    await fs.writeFile(path.join(workDir, 'image.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00]))
    await fs.writeFile(
      path.join(workDir, 'large-image.png'),
      Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47]), Buffer.alloc(ONE_MIB + 1, 0xff)]),
    )
    await fs.writeFile(path.join(workDir, 'large.txt'), Buffer.alloc(ONE_MIB + 1, 'a'))
    await fs.mkdir(path.join(workDir, 'folder'))

    await expect(service.readFile('session-1', 'note.ts')).resolves.toMatchObject({
      state: 'ok',
      language: 'typescript',
      size: 25,
      content: 'export const answer = 42\n',
      encoding: 'utf8',
    })
    await expect(service.readFile('session-1', 'legacy.txt')).resolves.toMatchObject({
      state: 'ok',
      content: '中文测试',
      encoding: 'gbk',
    })
    await expect(service.readFile('session-1', 'legacy.txt', 'utf8')).resolves.toMatchObject({
      state: 'ok',
      encoding: 'utf8',
    })
    await expect(service.readFile('session-1', 'engine.cpp')).resolves.toMatchObject({
      state: 'ok',
      language: 'cpp',
    })
    await expect(service.readFile('session-1', 'engine.hpp')).resolves.toMatchObject({
      state: 'ok',
      language: 'cpp',
    })
    await expect(service.readFile('session-1', 'bootstrap.lua')).resolves.toMatchObject({
      state: 'ok',
      language: 'lua',
    })
    for (const [file, language] of [
      ['app.js', 'javascript'],
      ['run.sh', 'bash'],
      ['run.bash', 'bash'],
      ['build.bat', 'bat'],
      ['Program.cs', 'csharp'],
      ['Game.sln', 'ini'],
      ['Game.vcproj', 'xml'],
      ['Game.vcxproj', 'xml'],
    ]) {
      await expect(service.readFile('session-1', file!)).resolves.toMatchObject({ state: 'ok', language })
    }
    await expect(service.readFile('session-1', 'late-legacy.txt')).resolves.toMatchObject({
      state: 'ok',
      encoding: 'gbk',
    })
    await expect(service.readFile('session-1', 'utf8-boundary.txt')).resolves.toMatchObject({
      state: 'ok',
      encoding: 'utf8',
    })
    await expect(service.readFile('session-1', 'binary.bin')).resolves.toMatchObject({
      state: 'binary',
      language: 'binary',
      size: 4,
    })
    await expect(service.readFile('session-1', 'image.png')).resolves.toMatchObject({
      state: 'ok',
      previewType: 'image',
      language: 'image',
      mimeType: 'image/png',
      dataUrl: 'data:image/png;base64,iVBORwA=',
      size: 5,
    })
    const largeImage = await service.readFile('session-1', 'large-image.png')
    expect(largeImage).toMatchObject({
      state: 'ok',
      previewType: 'image',
      language: 'image',
      mimeType: 'image/png',
      size: ONE_MIB + 5,
    })
    expect(largeImage.dataUrl).toStartWith('data:image/png;base64,')
    await expect(service.readFile('session-1', 'large.txt')).resolves.toMatchObject({
      state: 'ok',
      previewType: 'text',
      language: 'text',
      size: ONE_MIB + 1,
      readBytes: ONE_MIB,
      truncated: true,
      content: 'a'.repeat(ONE_MIB),
    })
    await expect(service.readFile('session-1', 'missing.txt')).resolves.toMatchObject({
      state: 'missing',
    })
    await expect(service.readFile('session-1', 'folder')).resolves.toMatchObject({
      state: 'missing',
    })
  })

  it('lists a single directory level with dotfiles included and directories first', async () => {
    const workDir = await makeTempDir('workspace-service-tree-')
    const service = new WorkspaceService(async () => workDir)

    await fs.mkdir(path.join(workDir, '.hidden-dir'))
    await fs.mkdir(path.join(workDir, '.git'))
    await fs.mkdir(path.join(workDir, 'b-dir'))
    await fs.mkdir(path.join(workDir, 'a-dir'))
    await fs.mkdir(path.join(workDir, 'a-dir', 'inner'))
    await fs.writeFile(path.join(workDir, 'a-dir', 'note.txt'), 'nested\n')
    await fs.writeFile(path.join(workDir, 'z-file.txt'), 'root file\n')
    await fs.writeFile(path.join(workDir, '.hidden.txt'), 'ignore\n')

    await expect(service.readTree('session-1')).resolves.toMatchObject({
      state: 'ok',
      path: '',
      entries: [
        { name: '.hidden-dir', path: '.hidden-dir', isDirectory: true },
        { name: 'a-dir', path: 'a-dir', isDirectory: true },
        { name: 'b-dir', path: 'b-dir', isDirectory: true },
        { name: '.hidden.txt', path: '.hidden.txt', isDirectory: false },
        { name: 'z-file.txt', path: 'z-file.txt', isDirectory: false },
      ],
    })

    await expect(service.readTree('session-1', 'a-dir')).resolves.toMatchObject({
      state: 'ok',
      path: 'a-dir',
      entries: [
        { name: 'inner', path: 'a-dir/inner', isDirectory: true },
        { name: 'note.txt', path: 'a-dir/note.txt', isDirectory: false },
      ],
    })
  })

  it('prefers the accumulated file-history diff over intermediate transcript patches', async () => {
    const workDir = await makeTempDir('workspace-service-history-priority-')
    const service = new WorkspaceService(async () => workDir) as WorkspaceService & {
      getFileHistoryDiff: (sessionId: string, workspaceRoot: string, relativePath: string) => Promise<string | null>
      getSessionDiff: (sessionId: string, relativePath: string) => Promise<string | null>
      getStoredWorkspaceDiff: (sessionId: string, workspaceRoot: string, relativePath: string) => Promise<string | null>
    }
    const historyDiff = 'diff --session a/src/app.ts b/src/app.ts\n-old\n+final\n'
    let sessionDiffRead = false
    service.getFileHistoryDiff = async () => historyDiff
    service.getSessionDiff = async () => {
      sessionDiffRead = true
      return 'diff --session a/src/app.ts b/src/app.ts\n-old\n+intermediate\n'
    }

    await expect(service.getStoredWorkspaceDiff('session-1', workDir, 'src/app.ts')).resolves.toBe(historyDiff)
    expect(sessionDiffRead).toBe(false)
  })

  it('expands a directory symlink and explicit additional root as read-only viewer trees', async () => {
    const workDir = await makeTempDir('workspace-service-linked-tree-')
    const projectBrain = await makeTempDir('workspace-service-project-brain-')
    await fs.writeFile(path.join(projectBrain, 'index.md'), '# project brain\n')
    await fs.symlink(projectBrain, path.join(workDir, '项目大脑'), 'junction')
    const service = new WorkspaceService(async () => workDir)

    const root = await service.readTree('session-1')
    expect(root.entries).toContainEqual({
      name: '项目大脑',
      path: '项目大脑',
      isDirectory: true,
      isSymlink: true,
    })

    const linked = await service.readTree('session-1', '项目大脑')
    const linkedFile = linked.entries.find((entry) => entry.name === 'index.md')!
    expect(linkedFile.path).toBe('项目大脑/index.md')
    await expect(service.readFile('session-1', linkedFile.path)).resolves.toMatchObject({
      state: 'ok',
      content: '# project brain\n',
    })

    const registeredRoot = await service.registerExternalRoot('session-1', projectBrain)
    const external = await service.readTree('session-1', registeredRoot)
    expect(external.entries).toContainEqual({
      name: 'index.md',
      path: path.join(projectBrain, 'index.md'),
      isDirectory: false,
    })
  })

  it('allocates a larger output buffer for verbose SVN XML status', async () => {
    const workspaceDir = await createSvnWorkspace()
    const service = new WorkspaceService(async () => workspaceDir) as WorkspaceService & {
      runSvn: (workDir: string, args: string[], maxBuffer?: number, timeout?: number) => Promise<{
        stdout: string
        stderr: string
        code: number
      }>
    }
    const originalRunSvn = service.runSvn.bind(service)
    let statusBuffer: number | undefined
    service.runSvn = async (workDir, args, maxBuffer, timeout) => {
      if (args[0] === 'status') statusBuffer = maxBuffer
      return originalRunSvn(workDir, args, maxBuffer, timeout)
    }

    await expect(service.getStatus('session-1')).resolves.toMatchObject({ state: 'ok', isGitRepo: false })
    expect(statusBuffer).toBeGreaterThan(2_000_000)
  })

  it('does not expose partial SVN XML as a file-view error', () => {
    const service = new WorkspaceService(async () => null) as WorkspaceService & {
      formatSvnError: (prefix: string, args: string[], workDir: string, result: {
        stdout: string
        stderr: string
        code: number
        failure?: string
      }) => string
    }

    const message = service.formatSvnError(
      'Failed to read SVN status',
      ['status', '--xml'],
      'F:\\Head',
      { stdout: '<?xml version="1.0"?><status><entry path="many-files" /></status>', stderr: '', code: 1 },
    )

    expect(message).toContain('SVN returned XML status output but the command did not complete.')
    expect(message).not.toContain('<entry')

    expect(service.formatSvnError(
      'Failed to read SVN diff',
      ['diff', '--', 'large.cpp'],
      'F:\\Head\\Source',
      { stdout: '', stderr: '', code: 1, failure: 'SVN command timed out after 5000 ms.' },
    )).toContain('SVN command timed out after 5000 ms.')
  })

  it('reads SVN diffs through a directory symlink inside a Git workspace', async () => {
    const workDir = await makeTempDir('workspace-service-linked-svn-parent-')
    const svnWorkspace = await createSvnWorkspace()
    const linkedSubdirectory = path.join(svnWorkspace, 'linked-subdirectory')
    const nestedFileName = '变更.txt'
    await fs.mkdir(linkedSubdirectory)
    await fs.writeFile(path.join(linkedSubdirectory, nestedFileName), 'nested before\n')
    svn(svnWorkspace, 'add', 'linked-subdirectory')
    svn(svnWorkspace, 'commit', '-m', 'add linked subdirectory', 'linked-subdirectory')
    await fs.writeFile(path.join(linkedSubdirectory, nestedFileName), 'nested before\nnested after\n')
    const outputDirectory = path.join(linkedSubdirectory, 'x64', 'Generated')
    await fs.mkdir(outputDirectory, { recursive: true })
    await fs.writeFile(path.join(outputDirectory, 'new-source.lua'), 'return true\n')
    await fs.writeFile(path.join(outputDirectory, 'symbols.pdb'), Buffer.from([0, 1, 2, 3]))
    git(workDir, 'init')
    await fs.symlink(linkedSubdirectory, path.join(workDir, 'legacy-svn'), 'junction')
    const service = new WorkspaceService(async () => workDir)

    const rootTree = await service.readTree('session-1')
    expect(rootTree.entries).toContainEqual({
      name: 'legacy-svn',
      path: 'legacy-svn',
      isDirectory: true,
      isSymlink: true,
    })
    const linkedTree = await service.readTree('session-1', 'legacy-svn')
    const trackedFile = linkedTree.entries.find((entry) => entry.name === nestedFileName)!

    expect(trackedFile.path).toBe(`legacy-svn/${nestedFileName}`)
    const status = await service.getStatus('session-1')
    expect(status.changedFiles).toContainEqual({
      path: 'legacy-svn',
      status: 'modified',
      additions: 0,
      deletions: 0,
      isDirectory: true,
      isSymlink: true,
    })
    expect(status.changedFiles).toContainEqual({
      path: `legacy-svn/${nestedFileName}`,
      oldPath: undefined,
      status: 'modified',
      additions: 1,
      deletions: 0,
    })
    expect(status.changedFiles).toContainEqual({
      path: 'legacy-svn/x64',
      oldPath: undefined,
      status: 'untracked',
      additions: 0,
      deletions: 0,
      isDirectory: true,
    })
    expect(status.changedFiles).toContainEqual({
      path: 'legacy-svn/x64/Generated/new-source.lua',
      oldPath: undefined,
      status: 'untracked',
      additions: 1,
      deletions: 0,
    })
    expect(status.changedFiles.some((file) => file.path.endsWith('symbols.pdb'))).toBe(false)
    const diff = await service.getDiff('session-1', trackedFile.path)
    expect(diff).toMatchObject({
      state: 'ok',
      diff: expect.stringContaining('+nested after'),
      comparison: {
        right: {
          writable: false,
          readOnlyReason: 'Registered external roots are read-only.',
        },
      },
    })
    expect(diff.path).toBe(trackedFile.path)
    await expect(service.grantExternalFileWriteAccess('session-1', trackedFile.path)).resolves.toMatchObject({
      path: trackedFile.path,
    })
    await expect(service.getDiff('session-1', trackedFile.path)).resolves.toMatchObject({
      comparison: {
        right: {
          source: { kind: 'working_tree' },
          writable: true,
        },
      },
    })
    await expect(service.getDiff('session-1', 'legacy-svn/x64/Generated/new-source.lua')).resolves.toMatchObject({
      state: 'ok',
      path: 'legacy-svn/x64/Generated/new-source.lua',
      diff: expect.stringContaining('+return true'),
    })
  })

  it('does not recursively report files through an unversioned SVN junction', async () => {
    const svnWorkspace = await createSvnWorkspace()
    const externalDirectory = await makeTempDir('workspace-service-svn-junction-target-')
    await fs.mkdir(path.join(externalDirectory, 'nested'))
    await fs.writeFile(path.join(externalDirectory, 'nested', 'clean.md'), '# clean external file\n')
    await fs.symlink(externalDirectory, path.join(svnWorkspace, 'external-link'), 'junction')
    const service = new WorkspaceService(async () => svnWorkspace)

    const status = await service.getStatus('session-1')

    expect(status.state).toBe('ok')
    expect(status.changedFiles).toContainEqual({
      path: 'external-link',
      status: 'untracked',
      additions: 0,
      deletions: 0,
      isDirectory: true,
      isSymlink: true,
    })
    expect(status.changedFiles.some((file) => file.path.startsWith('external-link/'))).toBe(false)
  })

  it('returns diffs for modified, added, deleted, and untracked files', async () => {
    const repoDir = await createGitWorkspace()
    const service = new WorkspaceService(async (sessionId) => sessionId === 'session-1' ? repoDir : null)

    const modified = await service.getDiff('session-1', 'tracked.txt')
    expect(modified.state).toBe('ok')
    expect(modified.diff).toContain('tracked.txt')
    expect(modified.diff.length).toBeGreaterThan(0)

    const added = await service.getDiff('session-1', 'new.txt')
    expect(added.state).toBe('ok')
    expect(added.diff).toContain('new.txt')
    expect(added.diff.length).toBeGreaterThan(0)

    const deleted = await service.getDiff('session-1', 'deleted.txt')
    expect(deleted.state).toBe('ok')
    expect(deleted.diff).toContain('deleted.txt')
    expect(deleted.diff.length).toBeGreaterThan(0)

    const untracked = await service.getDiff('session-1', 'untracked.txt')
    expect(untracked.state).toBe('ok')
    expect(untracked.diff).toContain('untracked.txt')
    expect(untracked.diff.length).toBeGreaterThan(0)

    await expect(service.getDiff('session-1', 'clean.txt')).resolves.toMatchObject({
      state: 'missing',
      path: 'clean.txt',
    })

    const nonGitDir = await makeTempDir('workspace-service-diff-non-git-')
    const nonGitService = new WorkspaceService(async () => nonGitDir)
    await expect(nonGitService.getDiff('session-1', 'whatever.txt')).resolves.toMatchObject({
      state: 'not_git_repo',
      path: 'whatever.txt',
    })
  })

  it('returns complete Git comparison sources for modified, added, deleted, and untracked files', async () => {
    const repoDir = await createGitWorkspace()
    const service = new WorkspaceService(async () => repoDir)

    const modified = await service.getDiff('session-1', 'tracked.txt')
    expect(modified.comparison).toMatchObject({
      schemaVersion: 1,
      left: {
        exists: true,
        state: 'ok',
        content: 'before\n',
        source: { kind: 'git_head', path: 'tracked.txt', revision: expect.stringMatching(/^sha256:/) },
        requestedEncoding: 'auto',
        actualEncoding: 'utf8',
        bom: 'none',
        lineEnding: 'lf',
        writable: false,
      },
      right: {
        exists: true,
        state: 'ok',
        content: 'before\nafter\n',
        source: { kind: 'working_tree', path: 'tracked.txt', revision: expect.stringMatching(/^sha256:/) },
        writable: true,
      },
    })
    expect(modified.comparison?.left.contentFingerprint).not.toBe(modified.comparison?.right.contentFingerprint)

    const added = await service.getDiff('session-1', 'new.txt')
    expect(added.comparison).toMatchObject({
      left: { exists: false, state: 'missing', source: { kind: 'empty' }, writable: false },
      right: { exists: true, state: 'ok', content: 'new file\n', writable: true },
    })

    const untracked = await service.getDiff('session-1', 'untracked.txt')
    expect(untracked.comparison).toMatchObject({
      left: { exists: false, state: 'missing', source: { kind: 'empty' } },
      right: { exists: true, state: 'ok', content: 'still untracked\n' },
    })

    const deleted = await service.getDiff('session-1', 'deleted.txt')
    expect(deleted.comparison).toMatchObject({
      left: { exists: true, state: 'ok', content: 'delete me\n', source: { kind: 'git_head' } },
      right: { exists: false, state: 'missing', source: { kind: 'working_tree' }, writable: true },
    })
  })

  it('returns complete SVN comparison sources for modified, added, and deleted files', async () => {
    const workspaceDir = await createSvnWorkspace()
    const service = new WorkspaceService(async () => workspaceDir)

    await expect(service.getDiff('session-1', 'tracked.txt')).resolves.toMatchObject({
      comparison: {
        left: { exists: true, state: 'ok', content: 'before\n', source: { kind: 'svn_base' } },
        right: { exists: true, state: 'ok', content: 'before\nafter\n', source: { kind: 'working_tree' } },
      },
    })
    await expect(service.getDiff('session-1', 'new.txt')).resolves.toMatchObject({
      comparison: {
        left: { exists: false, state: 'missing', source: { kind: 'empty' } },
        right: { exists: true, state: 'ok', content: 'new file\n' },
      },
    })
    await expect(service.getDiff('session-1', 'deleted.txt')).resolves.toMatchObject({
      comparison: {
        left: { exists: true, state: 'ok', content: 'delete from svn\n', source: { kind: 'svn_base' } },
        right: { exists: false, state: 'missing', source: { kind: 'working_tree' } },
      },
    })
    await expect(service.getDiff('session-1', '编译说明.md')).resolves.toMatchObject({
      comparison: {
        left: {
          exists: true,
          state: 'ok',
          content: '# 编译说明\n旧内容\n',
          source: { kind: 'svn_base', path: '编译说明.md' },
        },
        right: {
          exists: true,
          state: 'ok',
          content: '# 编译说明\n旧内容\n新增内容\n',
          source: { kind: 'working_tree', path: '编译说明.md' },
        },
      },
    })
    await expect(service.getDiff('session-1', '-dash.txt')).resolves.toMatchObject({
      comparison: {
        left: { exists: true, state: 'ok', content: 'dash before\n', source: { kind: 'svn_base' } },
        right: { exists: true, state: 'ok', content: 'dash before\ndash after\n' },
      },
    })
  })

  it('reads a Unicode SVN baseline from the exact switched entry URL and BASE revision', async () => {
    const workspaceDir = await createSwitchedSvnWorkspace()
    const service = new WorkspaceService(async () => workspaceDir) as WorkspaceService & {
      runSvn: (workDir: string, args: string[], maxBuffer?: number) => Promise<{
        stdout: string
        stderr: string
        code: number
        failure?: string
      }>
      runSvnBuffer: (workDir: string, args: string[], maxBuffer?: number) => Promise<{
        stdout: Buffer
        stderr: string
        code: number
        failure?: string
      }>
    }
    const runSvn = service.runSvn.bind(service)
    const runSvnBuffer = service.runSvnBuffer.bind(service)
    const svnCalls: Array<{ workDir: string; args: string[] }> = []
    const svnBufferCalls: Array<{ workDir: string; args: string[] }> = []
    service.runSvn = async (workDir, args, maxBuffer) => {
      svnCalls.push({ workDir, args })
      return await runSvn(workDir, args, maxBuffer)
    }
    service.runSvnBuffer = async (workDir, args, maxBuffer) => {
      svnBufferCalls.push({ workDir, args })
      return await runSvnBuffer(workDir, args, maxBuffer)
    }

    const result = await service.getDiff('session-1', 'sub/中文.txt')

    expect(result).toMatchObject({
      state: 'ok',
      path: 'sub/中文.txt',
      diff: expect.stringContaining('+LOCAL-SWITCHED'),
      comparison: {
        left: {
          exists: true,
          state: 'ok',
          content: 'BRANCH-BASE\n',
          source: { kind: 'svn_base', path: 'sub/中文.txt' },
        },
        right: {
          exists: true,
          state: 'ok',
          content: 'LOCAL-SWITCHED\n',
          source: { kind: 'working_tree', path: 'sub/中文.txt' },
        },
      },
    })
    expect(result.comparison?.left.content).not.toBe('TRUNK-BASE\n')
    const infoCall = svnCalls.find((call) => call.args[0] === 'info' && call.args.includes('--xml'))
    expect(infoCall?.workDir).toBe(path.join(workspaceDir, 'sub'))
    expect(infoCall?.args).toEqual(['info', '--xml', '--depth', 'files', '.'])
    const catCall = svnBufferCalls.find((call) => call.args[0] === 'cat')
    expect(catCall?.workDir).toBe(workspaceDir)
    expect(catCall?.args.slice(0, 4)).toEqual(['cat', '-r', expect.stringMatching(/^\d+$/), '--'])
    expect(catCall?.args[4]).toContain('/branch/sub/%E4%B8%AD%E6%96%87.txt')
    expect(catCall?.args[4]).not.toContain('/trunk/sub/')
    expect(catCall?.args.every((argument) => /^[\x00-\x7f]*$/.test(argument))).toBe(true)
  })

  it('rejects incomplete, ambiguous, or inconsistent SVN baseline entry identities', () => {
    const service = new WorkspaceService(async () => null) as WorkspaceService & {
      resolveSvnBaseIdentityFromInfo: (repoPath: string, infoXml: string) =>
        | { kind: 'ok'; target: string; revision: string }
        | { kind: 'error'; message: string }
    }
    const targetPath = 'sub/中文.txt'
    const encodedTarget = '%E4%B8%AD%E6%96%87.txt'
    const entry = (attributes: string, body: string) => `<entry kind="file" path="${targetPath}" ${attributes}>${body}</entry>`
    const identity = (urlPath: string, relativePath = urlPath) => [
      `<url>file:///repo/${urlPath}/${encodedTarget}</url>`,
      `<relative-url>^/${relativePath}/${encodedTarget}</relative-url>`,
      '<repository><root>file:///repo</root></repository>',
    ].join('')

    expect(service.resolveSvnBaseIdentityFromInfo(targetPath, `<info>${entry('', identity('branch/sub'))}</info>`)).toMatchObject({
      kind: 'error',
      message: expect.stringContaining('complete SVN baseline identity'),
    })
    expect(service.resolveSvnBaseIdentityFromInfo(targetPath, `<info>${entry('revision="7"', '')}</info>`)).toMatchObject({
      kind: 'error',
      message: expect.stringContaining('complete SVN baseline identity'),
    })
    const completeEntry = entry('revision="7"', identity('branch/sub'))
    expect(service.resolveSvnBaseIdentityFromInfo(targetPath, `<info>${completeEntry}${completeEntry}</info>`)).toMatchObject({
      kind: 'error',
      message: expect.stringContaining('unique SVN baseline entry'),
    })
    expect(service.resolveSvnBaseIdentityFromInfo(
      targetPath,
      `<info>${entry('revision="7"', identity('trunk/sub', 'branch/sub'))}</info>`,
    )).toMatchObject({
      kind: 'error',
      message: expect.stringContaining('identity is inconsistent'),
    })
  })

  it('degrades an unresolved SVN baseline identity without attempting svn cat', async () => {
    const service = new WorkspaceService(async () => null) as WorkspaceService & {
      resolveSvnBaseTarget: () => Promise<{ kind: 'error'; message: string }>
      readSvnBaseComparisonSide: (svnRoot: string, repoPath: string, requestedEncoding: 'auto') => Promise<{
        state: string
        source: { kind: string; path: string }
        content?: string
        error?: string
      }>
      runSvnBuffer: () => Promise<{ stdout: Buffer; stderr: string; code: number }>
    }
    let catAttempted = false
    service.resolveSvnBaseTarget = async () => ({ kind: 'error', message: 'ambiguous test identity' })
    service.runSvnBuffer = async () => {
      catAttempted = true
      return { stdout: Buffer.alloc(0), stderr: '', code: 0 }
    }

    const side = await service.readSvnBaseComparisonSide('C:\\fixture', 'sub/中文.txt', 'auto')

    expect(side).toMatchObject({
      state: 'unavailable',
      source: { kind: 'svn_base', path: 'sub/中文.txt' },
      error: 'ambiguous test identity',
    })
    expect(side).not.toHaveProperty('content')
    expect(catAttempted).toBe(false)
  })

  it('returns bounded Git large-patch errors with stable too-large comparison sources', async () => {
    const repoDir = await makeTempDir('workspace-service-git-large-patch-')
    git(repoDir, 'init')
    git(repoDir, 'config', 'user.email', 'workspace-service@example.com')
    git(repoDir, 'config', 'user.name', 'Workspace Service')
    const target = path.join(repoDir, 'large-patch.txt')
    const before = 'git-secret-'.repeat(200_001)
    const after = 'git-changed-'.repeat(200_001)
    await fs.writeFile(target, before)
    git(repoDir, 'add', 'large-patch.txt')
    git(repoDir, 'commit', '-m', 'large baseline')
    await fs.writeFile(target, after)
    const service = new WorkspaceService(async () => repoDir)

    const result = await service.getDiff('session-1', 'large-patch.txt')
    const error = result.error ?? ''

    expect(result.state).toBe('error')
    expect(typeof error).toBe('string')
    expect(Buffer.byteLength(error)).toBeLessThan(4_096)
    expect(error).not.toContain('git-secret-git-secret')
    expect(result).toMatchObject({
      state: 'error',
      path: 'large-patch.txt',
      error: expect.stringContaining('Git command output exceeded 2000000 bytes.'),
      comparison: {
        left: {
          state: 'too_large',
          contentFingerprint: expect.stringMatching(/^git-object:/),
          source: { kind: 'git_head' },
        },
        right: {
          state: 'too_large',
          contentFingerprint: expect.stringMatching(/^sha256:/),
          source: { kind: 'working_tree' },
        },
      },
    })
    expect(result.comparison?.left).not.toHaveProperty('content')
    expect(result.comparison?.right).not.toHaveProperty('content')
    expect(result).not.toHaveProperty('diff')
  })

  it('returns bounded SVN large-patch errors without exposing partial source', async () => {
    const workspaceDir = await createSvnWorkspace()
    const target = path.join(workspaceDir, 'large-patch.txt')
    const before = 'svn-secret-'.repeat(100_001)
    const after = 'svn-changed-'.repeat(100_001)
    await fs.writeFile(target, before)
    svn(workspaceDir, 'add', 'large-patch.txt')
    svn(workspaceDir, 'commit', '-m', 'large baseline', 'large-patch.txt')
    await fs.writeFile(target, after)
    const service = new WorkspaceService(async () => workspaceDir)

    const result = await service.getDiff('session-1', 'large-patch.txt')
    const error = result.error ?? ''

    expect(result.state).toBe('error')
    expect(typeof error).toBe('string')
    expect(Buffer.byteLength(error)).toBeLessThan(4_096)
    expect(error).not.toContain('svn-secret-svn-secret')
    expect(result).toMatchObject({
      state: 'error',
      path: 'large-patch.txt',
      error: expect.stringContaining('SVN command output exceeded 2000000 bytes.'),
      comparison: {
        left: { state: 'ok', content: before, source: { kind: 'svn_base' } },
        right: { state: 'ok', content: after, source: { kind: 'working_tree' } },
      },
    })
    expect(result).not.toHaveProperty('diff')
  })

  it('detects source changes by raw-byte fingerprint and reports explicit binary degradation', async () => {
    const repoDir = await createGitWorkspace()
    const service = new WorkspaceService(async () => repoDir)

    const first = await service.getDiff('session-1', 'tracked.txt')
    await fs.writeFile(path.join(repoDir, 'tracked.txt'), 'before\nchanged again\n')
    const second = await service.getDiff('session-1', 'tracked.txt')
    expect(second.comparison?.left.source.revision).toBe(first.comparison?.left.source.revision)
    expect(second.comparison?.right.source.revision).not.toBe(first.comparison?.right.source.revision)

    await fs.writeFile(path.join(repoDir, 'binary.dat'), Buffer.from([0, 1, 2, 3]))
    const binary = await service.getDiff('session-1', 'binary.dat')
    expect(binary.state).toBe('ok')
    expect(binary.comparison).toMatchObject({
      left: { exists: false, state: 'missing' },
      right: {
        exists: true,
        state: 'binary',
        contentFingerprint: expect.stringMatching(/^sha256:/),
      },
    })
    expect(binary.comparison?.right).not.toHaveProperty('content')
  })

  it('reports requested versus actual encoding, BOM, line endings, and undecodable text', async () => {
    const repoDir = await createGitWorkspace()
    const service = new WorkspaceService(async () => repoDir)
    await fs.writeFile(
      path.join(repoDir, 'bom.txt'),
      Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('first\r\nsecond\r\n')]),
    )

    const bom = await service.getDiff('session-1', 'bom.txt')
    expect(bom.comparison?.right).toMatchObject({
      requestedEncoding: 'auto',
      actualEncoding: 'utf8',
      bom: 'utf8',
      lineEnding: 'crlf',
      content: 'first\r\nsecond\r\n',
    })

    await fs.writeFile(path.join(repoDir, 'invalid-utf8.txt'), Buffer.from([0x81]))
    const invalid = await service.getDiff('session-1', 'invalid-utf8.txt', 'utf8')
    expect(invalid.comparison?.right).toMatchObject({
      state: 'undecodable',
      requestedEncoding: 'utf8',
      actualEncoding: 'utf8',
      bom: 'none',
      lineEnding: 'unknown',
    })
    expect(invalid.comparison?.right).not.toHaveProperty('content')

    await fs.writeFile(path.join(repoDir, 'legacy-gbk.txt'), Buffer.from([0xc4, 0xe3, 0xba, 0xc3, 0x0a]))
    const gbk = await service.getDiff('session-1', 'legacy-gbk.txt')
    expect(gbk.comparison?.right).toMatchObject({
      state: 'ok',
      content: '你好\n',
      requestedEncoding: 'auto',
      actualEncoding: 'gbk',
    })

    const unsupportedBomFiles = [
      ['utf16le.txt', Buffer.from([0xff, 0xfe, 0x41, 0x00, 0x0a, 0x00])],
      ['utf16be.txt', Buffer.from([0xfe, 0xff, 0x00, 0x41, 0x00, 0x0a])],
      ['utf32le.txt', Buffer.from([0xff, 0xfe, 0x00, 0x00, 0x41, 0x00, 0x00, 0x00])],
      ['utf32be.txt', Buffer.from([0x00, 0x00, 0xfe, 0xff, 0x00, 0x00, 0x00, 0x41])],
    ] as const
    for (const [fileName, content] of unsupportedBomFiles) {
      await fs.writeFile(path.join(repoDir, fileName), content)
      const result = await service.getDiff('session-1', fileName)
      expect(result.comparison?.right).toMatchObject({
        state: 'undecodable',
        requestedEncoding: 'auto',
        bom: 'unknown',
        lineEnding: 'unknown',
        error: 'UTF-16 and UTF-32 comparison sources are not supported yet.',
      })
      expect(result.comparison?.right).not.toHaveProperty('content')
    }
  })

  it('reloads Git comparison sides independently from their original bytes', async () => {
    const repoDir = await makeTempDir('workspace-service-encoding-reload-git-')
    git(repoDir, 'init')
    git(repoDir, 'config', 'user.email', 'workspace-service@example.com')
    git(repoDir, 'config', 'user.name', 'Workspace Service')
    git(repoDir, 'config', 'core.autocrlf', 'false')
    const target = path.join(repoDir, 'encoding.txt')
    await fs.writeFile(target, Buffer.from('bec90a', 'hex'))
    git(repoDir, 'add', 'encoding.txt')
    git(repoDir, 'commit', '-m', 'GBK baseline')
    await fs.writeFile(target, Buffer.from('新\r\n', 'utf8'))
    const service = new WorkspaceService(async () => repoDir)

    const result = await service.getDiff('session-1', 'encoding.txt', 'gbk', 'utf8')

    expect(result.comparison).toMatchObject({
      left: {
        state: 'ok',
        content: '旧\n',
        requestedEncoding: 'gbk',
        actualEncoding: 'gbk',
      },
      right: {
        state: 'ok',
        content: '新\r\n',
        requestedEncoding: 'utf8',
        actualEncoding: 'utf8',
      },
    })
  })

  it('reloads SVN baseline and working sides independently from original bytes', async () => {
    const workspaceDir = await createSvnWorkspace()
    const target = path.join(workspaceDir, 'encoding.txt')
    await fs.writeFile(target, Buffer.from('bec90d0a', 'hex'))
    svn(workspaceDir, 'add', 'encoding.txt')
    svn(workspaceDir, 'commit', '-m', 'GBK baseline', 'encoding.txt')
    await fs.writeFile(target, Buffer.from('新\n', 'utf8'))
    const service = new WorkspaceService(async () => workspaceDir)

    const result = await service.getDiff('session-1', 'encoding.txt', 'gbk', 'utf8')

    expect(result.comparison).toMatchObject({
      left: {
        state: 'ok',
        content: '旧\r\n',
        requestedEncoding: 'gbk',
        actualEncoding: 'gbk',
      },
      right: {
        state: 'ok',
        content: '新\n',
        requestedEncoding: 'utf8',
        actualEncoding: 'utf8',
      },
    })
  })

  it('writes UTF-8 BOM and GBK files with preserved line endings under raw-byte CAS', async () => {
    const workspaceDir = await createGitWorkspace()
    const utf8BomPath = path.join(workspaceDir, 'utf8-bom.txt')
    const gbkPath = path.join(workspaceDir, 'legacy-gbk.txt')
    await fs.writeFile(utf8BomPath, Buffer.concat([
      Buffer.from([0xef, 0xbb, 0xbf]),
      Buffer.from('old\r\nline\r\n', 'utf8'),
    ]))
    await fs.writeFile(gbkPath, Buffer.from('c4e3bac30d0a', 'hex'))
    const service = new WorkspaceService(async () => workspaceDir)
    const utf8Fingerprint = (await service.getDiff('session-1', 'utf8-bom.txt')).comparison?.right.contentFingerprint
    const gbkFingerprint = (await service.getDiff('session-1', 'legacy-gbk.txt')).comparison?.right.contentFingerprint

    await expect(service.writeTextFile('session-1', 'utf8-bom.txt', 'old\r\nline\r\n', 'new\nline\n', {
      expectedFingerprint: utf8Fingerprint,
      encoding: 'utf8',
      bom: 'utf8',
      lineEnding: 'crlf',
    })).resolves.toMatchObject({
      state: 'ok',
      content: 'new\r\nline\r\n',
      contentFingerprint: expect.stringMatching(/^sha256:/),
      actualEncoding: 'utf8',
      bom: 'utf8',
      lineEnding: 'crlf',
    })
    expect((await fs.readFile(utf8BomPath)).toString('hex')).toBe(
      Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('new\r\nline\r\n')]).toString('hex'),
    )

    await expect(service.writeTextFile('session-1', 'legacy-gbk.txt', '你好\r\n', '修改\n', {
      expectedFingerprint: gbkFingerprint,
      encoding: 'gbk',
      bom: 'none',
      lineEnding: 'crlf',
    })).resolves.toMatchObject({
      state: 'ok',
      content: '修改\r\n',
      contentFingerprint: expect.stringMatching(/^sha256:/),
      actualEncoding: 'gbk',
      bom: 'none',
      lineEnding: 'crlf',
    })
    expect((await fs.readFile(gbkPath)).toString('hex')).toBe('d0deb8c40d0a')
  })

  it('rejects stale raw bytes and lossy GBK edits without changing the target', async () => {
    const workspaceDir = await createGitWorkspace()
    const target = path.join(workspaceDir, 'legacy-gbk.txt')
    const original = Buffer.from('c4e3bac30d0a', 'hex')
    await fs.writeFile(target, original)
    const service = new WorkspaceService(async () => workspaceDir)
    const originalFingerprint = (await service.getDiff('session-1', 'legacy-gbk.txt')).comparison?.right.contentFingerprint

    await fs.writeFile(target, Buffer.from('你好\r\n', 'utf8'))
    await expect(service.writeTextFile('session-1', 'legacy-gbk.txt', '你好\r\n', '修改\n', {
      expectedFingerprint: originalFingerprint,
      encoding: 'gbk',
      bom: 'none',
      lineEnding: 'crlf',
    })).resolves.toMatchObject({ state: 'conflict' })
    await expect(fs.readFile(target)).resolves.toEqual(Buffer.from('你好\r\n', 'utf8'))

    await fs.writeFile(target, original)
    await expect(service.writeTextFile('session-1', 'legacy-gbk.txt', '你好\r\n', 'emoji 😀\n', {
      expectedFingerprint: originalFingerprint,
      encoding: 'gbk',
      bom: 'none',
      lineEnding: 'crlf',
    })).resolves.toMatchObject({
      state: 'error',
      error: expect.stringMatching(/U\+1F600.*gbk/i),
    })
    await expect(fs.readFile(target)).resolves.toEqual(original)
  })

  it('serializes raw-byte CAS writes so concurrent saves cannot both overwrite the same file', async () => {
    const workspaceDir = await createGitWorkspace()
    const target = path.join(workspaceDir, 'concurrent.txt')
    await fs.writeFile(target, 'before\n')
    const service = new WorkspaceService(async () => workspaceDir)
    const fingerprint = (await service.getDiff('session-1', 'concurrent.txt')).comparison?.right.contentFingerprint

    const [first, second] = await Promise.all([
      service.writeTextFile('session-1', 'concurrent.txt', 'before\n', 'first\n', {
        expectedFingerprint: fingerprint,
        encoding: 'utf8',
        bom: 'none',
        lineEnding: 'lf',
      }),
      service.writeTextFile('session-1', 'concurrent.txt', 'before\n', 'second\n', {
        expectedFingerprint: fingerprint,
        encoding: 'utf8',
        bom: 'none',
        lineEnding: 'lf',
      }),
    ])

    expect([first.state, second.state].sort()).toEqual(['conflict', 'ok'])
    await expect(fs.readFile(target, 'utf8')).resolves.toBe(first.state === 'ok' ? 'first\n' : 'second\n')
  })

  it('creates and deletes encoded files with raw-byte missing/existing CAS identities', async () => {
    const workspaceDir = await createGitWorkspace()
    const target = path.join(workspaceDir, '新建-gbk.txt')
    const service = new WorkspaceService(async () => workspaceDir)

    const created = await service.writeTextFile('session-1', '新建-gbk.txt', null, '你好\n', {
      expectedFingerprint: null,
      encoding: 'gbk',
      bom: 'none',
      lineEnding: 'crlf',
    })
    const createdFingerprint = created.contentFingerprint
    expect(created).toMatchObject({
      state: 'ok',
      content: '你好\r\n',
      contentFingerprint: expect.stringMatching(/^sha256:/),
      actualEncoding: 'gbk',
      lineEnding: 'crlf',
    })
    expect((await fs.readFile(target)).toString('hex')).toBe('c4e3bac30d0a')
    const reloadedFingerprint = (await service.getDiff('session-1', '新建-gbk.txt')).comparison?.right.contentFingerprint
    expect(reloadedFingerprint).toBe(createdFingerprint)

    await expect(service.writeTextFile('session-1', '新建-gbk.txt', '你好\r\n', null, {
      expectedFingerprint: createdFingerprint,
      encoding: 'gbk',
      bom: 'none',
      lineEnding: 'crlf',
    })).resolves.toMatchObject({ state: 'ok' })
    await expect(fs.stat(target)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('returns a complete no-VCS comparison only when file history provides a real baseline', async () => {
    const nonGitDir = await makeTempDir('workspace-service-comparison-file-history-')
    const generatedFile = path.join(nonGitDir, 'generated.txt')
    await fs.writeFile(generatedFile, 'generated\n')
    const service = new WorkspaceService(
      async () => nonGitDir,
      async () => [],
      async () => [{
        messageId: '33333333-3333-4333-8333-333333333333',
        timestamp: new Date('2026-01-01T00:00:00.000Z'),
        trackedFileBackups: {
          'generated.txt': {
            backupFileName: null,
            version: 1,
            backupTime: new Date('2026-01-01T00:00:00.000Z'),
          },
        },
      }],
    )

    await expect(service.getDiff('session-1', 'generated.txt')).resolves.toMatchObject({
      state: 'ok',
      comparison: {
        left: { exists: false, state: 'missing', source: { kind: 'empty' } },
        right: { exists: true, state: 'ok', content: 'generated\n', source: { kind: 'working_tree' } },
      },
    })
  })

  it('reads modified and deleted no-VCS baselines from sandboxed file-history bytes', async () => {
    const nonGitDir = await makeTempDir('workspace-service-comparison-existing-file-history-')
    const configDir = await makeTempDir('workspace-service-comparison-config-')
    const previousConfigDir = process.env.CLAUDE_CONFIG_DIR
    process.env.CLAUDE_CONFIG_DIR = configDir
    try {
      const backupDir = path.join(configDir, 'file-history', 'session-1')
      await fs.mkdir(backupDir, { recursive: true })
      await fs.writeFile(path.join(backupDir, 'modified.backup'), 'baseline\r\n')
      await fs.writeFile(path.join(backupDir, 'deleted.backup'), 'deleted baseline\n')
      await fs.writeFile(path.join(backupDir, 'legacy.backup'), Buffer.from('bec90d0a', 'hex'))
      await fs.writeFile(path.join(nonGitDir, 'modified.txt'), 'current\n')
      await fs.writeFile(path.join(nonGitDir, 'legacy.txt'), '新\n')

      const service = new WorkspaceService(
        async () => nonGitDir,
        async () => [],
        async () => [{
          messageId: '44444444-4444-4444-8444-444444444444',
          timestamp: new Date('2026-01-01T00:00:00.000Z'),
          trackedFileBackups: {
            'modified.txt': {
              backupFileName: 'modified.backup',
              version: 1,
              backupTime: new Date('2026-01-01T00:00:00.000Z'),
            },
            'deleted.txt': {
              backupFileName: 'deleted.backup',
              version: 1,
              backupTime: new Date('2026-01-01T00:00:00.000Z'),
            },
            'legacy.txt': {
              backupFileName: 'legacy.backup',
              version: 1,
              backupTime: new Date('2026-01-01T00:00:00.000Z'),
            },
          },
        }],
      )

      await expect(service.getDiff('session-1', 'modified.txt')).resolves.toMatchObject({
        comparison: {
          left: {
            state: 'ok',
            content: 'baseline\r\n',
            lineEnding: 'crlf',
            source: { kind: 'session_baseline', revision: expect.stringMatching(/^sha256:/) },
          },
          right: { state: 'ok', content: 'current\n', source: { kind: 'working_tree' } },
        },
      })
      await expect(service.getDiff('session-1', 'deleted.txt')).resolves.toMatchObject({
        comparison: {
          left: { state: 'ok', content: 'deleted baseline\n', source: { kind: 'session_baseline' } },
          right: { state: 'missing', exists: false, source: { kind: 'working_tree' } },
        },
      })
      await expect(service.getDiff('session-1', 'legacy.txt', 'gbk', 'utf8')).resolves.toMatchObject({
        comparison: {
          left: {
            state: 'ok', content: '旧\r\n', requestedEncoding: 'gbk', actualEncoding: 'gbk',
            source: { kind: 'session_baseline' },
          },
          right: {
            state: 'ok', content: '新\n', requestedEncoding: 'utf8', actualEncoding: 'utf8',
            source: { kind: 'working_tree' },
          },
        },
      })
    } finally {
      if (previousConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR
      else process.env.CLAUDE_CONFIG_DIR = previousConfigDir
    }
  })

  it('returns explicit error state when git status fails instead of ok-empty', async () => {
    const repoDir = await createGitWorkspace()
    const service = new WorkspaceService(async () => repoDir) as WorkspaceService & {
      runGit: (workDir: string, args: string[]) => Promise<{
        stdout: string
        stderr: string
        code: number
      }>
    }

    service.runGit = async (workDir, args) => {
      if (args[0] === 'rev-parse' && args[1] === '--show-toplevel') {
        return { stdout: `${workDir}\n`, stderr: '', code: 0 }
      }
      if (args[0] === 'rev-parse' && args[1] === '--abbrev-ref') {
        return { stdout: 'main\n', stderr: '', code: 0 }
      }
      if (args[0] === 'status') {
        return { stdout: '', stderr: 'fatal: synthetic git failure', code: 1 }
      }
      return { stdout: '', stderr: 'unexpected call', code: 1 }
    }

    await expect(service.getStatus('session-1')).resolves.toMatchObject({
      state: 'error',
      isGitRepo: true,
    })

    const result = await service.getStatus('session-1')
    expect(result.state).toBe('error')
    expect(result.changedFiles).toEqual([])
    expect(result.error).toContain('Failed to read git status')
    expect(result.error).toContain('synthetic git failure')
  })

  it('reads tracked diff stats in one bulk git call', async () => {
    const repoDir = await makeTempDir('workspace-service-bulk-stats-')
    await fs.writeFile(path.join(repoDir, 'a.txt'), 'a\n')
    await fs.writeFile(path.join(repoDir, 'b.txt'), 'b\n')
    const diffStatCalls: string[][] = []
    const service = new WorkspaceService(async () => repoDir) as WorkspaceService & {
      runGit: (workDir: string, args: string[]) => Promise<{
        stdout: string
        stderr: string
        code: number
      }>
    }

    service.runGit = async (_workDir, args) => {
      if (args[0] === 'rev-parse' && args[1] === '--show-toplevel') {
        return { stdout: `${repoDir}\n`, stderr: '', code: 0 }
      }
      if (args[0] === 'rev-parse' && args[1] === '--abbrev-ref') {
        return { stdout: 'main\n', stderr: '', code: 0 }
      }
      if (args[0] === 'status') {
        return { stdout: ' M a.txt\0 M b.txt\0', stderr: '', code: 0 }
      }
      if (args[0] === 'diff' && args.includes('--numstat')) {
        diffStatCalls.push(args)
        return { stdout: '1\t0\ta.txt\n2\t3\tb.txt\n', stderr: '', code: 0 }
      }
      return { stdout: '', stderr: `unexpected git call: ${args.join(' ')}`, code: 1 }
    }

    const result = await service.getStatus('session-1')

    expect(result.state).toBe('ok')
    expect(diffStatCalls).toHaveLength(1)
    expect(result.changedFiles).toEqual([
      { path: 'a.txt', oldPath: undefined, status: 'modified', additions: 1, deletions: 0 },
      { path: 'b.txt', oldPath: undefined, status: 'modified', additions: 2, deletions: 3 },
    ])
  })
})
