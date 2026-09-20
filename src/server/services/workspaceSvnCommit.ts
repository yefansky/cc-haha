import { execFile as execFileCallback } from 'node:child_process'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { promisify } from 'node:util'
import iconv from 'iconv-lite'

const execFile = promisify(execFileCallback)
const committingRoots = new Set<string>()

function decodeOutput(value: Buffer | string | undefined): string {
  if (typeof value === 'string') return value
  if (!value) return ''
  try { return new TextDecoder('utf-8', { fatal: true }).decode(value) }
  catch { return iconv.decode(value, 'gbk') }
}

export type WorkspaceSvnCommitResult = {
  state: 'ok' | 'no_changes' | 'error'
  output?: string
  error?: string
}

/** Commit only the session directory. Never add unversioned files or expand to the WC root. */
export async function commitWorkspaceSvn(
  workDir: string,
  message: string,
  executables: string[],
): Promise<WorkspaceSvnCommitResult> {
  if (typeof message !== 'string' || !message.trim() || message.length > 10_000 || message.includes('\0')) {
    return { state: 'error', error: 'A commit message of 1–10000 characters is required.' }
  }
  let lockKey: string | undefined
  let messageDir: string | undefined
  try {
    const cwd = await fs.realpath(workDir)
    let executable: string | undefined
    let root: string | undefined
    for (const candidate of executables) {
      try {
        const info = await execFile(candidate, ['info', '--non-interactive', '--xml', '--', '.'], {
          cwd, encoding: 'buffer', timeout: 10_000, maxBuffer: 128 * 1024,
        })
        executable = candidate
        // XML is UTF-8; --show-item can replace Chinese path characters with '?' on Windows.
        const rawRoot = /<wcroot-abspath>([\s\S]*?)<\/wcroot-abspath>/.exec(info.stdout.toString('utf8'))?.[1]
        if (!rawRoot) throw new Error('SVN working-copy root was not returned.')
        const entities: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" }
        const rootPath = rawRoot.replace(/&(amp|lt|gt|quot|apos|#x[\da-fA-F]+|#\d+);/g, (_, entity: string) =>
          entity.startsWith('#') ? String.fromCodePoint(parseInt(entity.slice(entity[1] === 'x' ? 2 : 1), entity[1] === 'x' ? 16 : 10)) : entities[entity]!)
        root = await fs.realpath(rootPath)
        break
      } catch (error) {
        if (executable || (error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      }
    }
    if (!executable || !root) throw new Error('SVN executable or working copy was not found.')
    const key = process.platform === 'win32' ? root.toLowerCase() : root
    if (committingRoots.has(key)) return { state: 'error', error: 'A commit is already running for this SVN working copy.' }
    committingRoots.add(key)
    lockKey = key
    messageDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cc-haha-svn-commit-'))
    const messagePath = path.join(messageDir, 'message.txt')
    await fs.writeFile(messagePath, message.trim(), { encoding: 'utf8', mode: 0o600 })
    // Pass UTF-8 through a file so Windows code-page conversion cannot corrupt Chinese messages.
    // SVN skips unversioned files and external working copies unless explicitly requested.
    const result = await execFile(executable, ['commit', '--non-interactive', '--encoding', 'UTF-8', '--file', messagePath, '--', '.'], {
      cwd, encoding: 'buffer', timeout: 90_000, maxBuffer: 2 * 1024 * 1024,
    })
    const output = [decodeOutput(result.stdout), decodeOutput(result.stderr)].filter(Boolean).join('\n').trim()
    return { state: output ? 'ok' : 'no_changes', output }
  } catch (error) {
    const failure = error as Error & { stderr?: Buffer | string; killed?: boolean }
    return {
      state: 'error',
      error: failure.killed
        ? 'SVN commit timed out. The repository may have accepted it; check SVN history before retrying.'
        : (decodeOutput(failure.stderr) || failure.message || 'SVN commit failed.').slice(0, 4096),
    }
  } finally {
    if (lockKey) committingRoots.delete(lockKey)
    if (messageDir) await fs.rm(messageDir, { recursive: true, force: true }).catch(() => {})
  }
}
