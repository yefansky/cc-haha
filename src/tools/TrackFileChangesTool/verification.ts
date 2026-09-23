import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { lstat, realpath } from 'node:fs/promises'
import { isAbsolute, relative, resolve } from 'node:path'
import picomatch from 'picomatch'
import type { ToolUseContext } from '../../Tool.js'
import { getOriginalCwd, getSessionId } from '../../bootstrap/state.js'
import { resolveBackupPath, type FileHistoryState } from '../../utils/fileHistory.js'
import type { TrackingPathInput } from './batchPaths.js'
import { withScanIO } from './scanIO.js'

export type Fingerprint = { signature: string; digest: string }
export type VerificationResult = {
  reported: string[]
  unverified: Array<{ path: string; reason: string }>
  failed: Array<{ path: string; reason: string }>
}
export type ScanBaseline = {
  targets: TrackingPathInput
  before: Map<string, Fingerprint | null>
}

export function trackingPathKey(path: string): string {
  const absolute = resolve(getOriginalCwd(), path)
  return process.platform === 'win32' ? absolute.toLowerCase() : absolute
}

const fingerprints = new Map<string, Fingerprint>()
const pendingHashes = new Map<string, Promise<Fingerprint | null>>()
const signature = (stat: Awaited<ReturnType<typeof lstat>>) => [stat.dev, stat.ino, stat.size, stat.mtimeMs, stat.ctimeMs].join(':')

export async function fingerprint(path: string): Promise<Fingerprint | null> {
  const key = trackingPathKey(path)
  let stat: Awaited<ReturnType<typeof lstat>>
  try { stat = await withScanIO(() => lstat(path)) } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') { fingerprints.delete(key); return null }
    throw error
  }
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Scan target is not a regular file')
  const stamp = signature(stat)
  const cached = fingerprints.get(key)
  if (cached?.signature === stamp) return cached
  const requestKey = key + '\0' + stamp
  const pending = pendingHashes.get(requestKey)
  if (pending) return pending
  const request = withScanIO(async () => {
    const hash = createHash('sha256')
    for await (const chunk of createReadStream(path)) hash.update(chunk)
    const after = await lstat(path)
    if (signature(after) !== stamp || !after.isFile() || after.isSymbolicLink()) throw new Error('File changed during scanning; retry registration after the writer finishes')
    const result = { signature: stamp, digest: hash.digest('hex') }
    fingerprints.delete(key)
    fingerprints.set(key, result)
    if (fingerprints.size > 1000) fingerprints.delete(fingerprints.keys().next().value!)
    return result
  })
  pendingHashes.set(requestKey, request)
  try { return await request }
  finally { if (pendingHashes.get(requestKey) === request) pendingHashes.delete(requestKey) }
}

// Scope evidence is deliberately process-local. A resumed session can still use
// persisted file-history backups, but cannot infer absence from a lost scope.
const scopes = new Map<string, ScanBaseline[]>()
const scopeOwners = new WeakMap<ScanBaseline, string>()

function currentHistory(context: ToolUseContext): FileHistoryState | undefined {
  let history: FileHistoryState | undefined
  context.updateFileHistoryState?.(state => { history = state; return state })
  return history
}

function turnKey(history: FileHistoryState | undefined): string | undefined {
  const messageId = history?.snapshots.at(-1)?.messageId
  return messageId ? getSessionId() + '\0' + messageId : undefined
}

export function rememberShellBaseline(scan: ScanBaseline, context: ToolUseContext): void {
  const key = turnKey(currentHistory(context))
  if (!key) return
  const owner = scopeOwners.get(scan)
  if (owner && owner !== key) return
  scopeOwners.set(scan, key)
  const existing = scopes.get(key) ?? []
  if (!existing.includes(scan)) existing.push(scan)
  if (existing.length > 64) existing.shift()
  scopes.set(key, existing)
  if (scopes.size > 100) scopes.delete(scopes.keys().next().value!)
}

function inScope(path: string, pattern: NonNullable<TrackingPathInput['patterns']>[number]): boolean {
  const name = relative(resolve(pattern.base_dir), resolve(path)).replace(/\\/g, '/')
  if (!name || name === '..' || name.startsWith('../') || isAbsolute(name)) return false
  if (name.split('/').slice(0, -1).some(part => ['.git', '.svn', '.hg'].includes(part.toLowerCase()))) return false
  const includes = pattern.include.filter(p => !p.startsWith('!'))
  const excludes = [...(pattern.exclude ?? []), ...pattern.include.filter(p => p.startsWith('!')).map(p => p.slice(1))]
  const options = { dot: true }
  if (!picomatch(includes, options)(name)) return false
  const excluded = excludes.length ? picomatch(excludes, options) : () => false
  if (excluded(name)) return false
  const parts = name.split('/')
  for (let i = 1; i < parts.length; i++) {
    const directory = parts.slice(0, i).join('/')
    if (excluded(directory) || excluded(directory + '/')) return false
  }
  return true
}

export function baselineForPath(scan: ScanBaseline, path: string): Fingerprint | null | undefined {
  const key = trackingPathKey(path)
  for (const [beforePath, before] of scan.before) {
    if (trackingPathKey(beforePath) === key) return before
  }
  return scan.targets.patterns?.some(pattern => inScope(path, pattern)) ? null : undefined
}

export async function verifyReportedPaths(paths: string[], context: ToolUseContext): Promise<VerificationResult> {
  const result: VerificationResult = { reported: [], unverified: [], failed: [] }
  const history = currentHistory(context)
  const snapshot = history?.snapshots.at(-1)
  const key = turnKey(history)
  const baselines = key ? scopes.get(key) ?? [] : []
  const backups = new Map(Object.entries(snapshot?.trackedFileBackups ?? {}).map(([path, backup]) => [trackingPathKey(path), backup]))
  const seen = new Set<string>()
  for (const path of paths) {
    const normalized = trackingPathKey(path)
    if (seen.has(normalized)) continue
    seen.add(normalized)
    try {
      let before: Fingerprint | null | undefined
      const backup = backups.get(normalized)
      if (backup) {
        if (backup.backupFileName === null) before = null
        else {
          before = await fingerprint(resolveBackupPath(backup.backupFileName))
          if (before === null) throw new Error('The pre-write backup is missing; cannot verify the reported change')
        }
      } else {
        // Use the filesystem spelling for case-sensitive glob matching, just
        // like the directory walker, even on a case-insensitive filesystem.
        let actualPath = path
        try { actualPath = await realpath(path) } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
        }
        for (const baseline of baselines) {
          before = baselineForPath(baseline, actualPath)
          if (before !== undefined) break
        }
      }
      if (before === undefined) {
        result.unverified.push({ path, reason: 'No pre-write baseline for this session and turn. Scope evidence may have been lost on restart; a post-write claim alone cannot verify a change.' })
        continue
      }
      const after = await fingerprint(path)
      if ((before?.digest ?? null) !== (after?.digest ?? null)) result.reported.push(path)
    } catch (error) { result.failed.push({ path, reason: String(error) }) }
  }
  return result
}
