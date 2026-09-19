import { posix, win32 } from 'node:path'

export const FILE_REFERENCE_LIMITS = Object.freeze({
  timeoutMs: 500, exactProbes: 8, concurrency: 2, roots: 3, depth: 2, directories: 12, entries: 256,
})

export type FileReferenceScope = { workDir: string; permissionGeneration: string }
export type FileReferenceRequest = {
  reference: string
  candidates?: string[]
  contextDirectories?: string[]
  timeoutMs?: number
}
export type FileReferenceCandidate = {
  path: string
  source: 'reference' | 'candidate' | 'bounded-search'
}
export type FileReferenceResult = {
  state: 'resolved' | 'ambiguous' | 'missing' | 'incomplete' | 'denied' | 'invalid' | 'error'
  path?: string
  candidates?: FileReferenceCandidate[]
  complete: boolean
  scope: FileReferenceScope | null
  stats: { elapsedMs: number; exactProbes: number; directories: number; entries: number }
  error?: string
}
export type FileReferenceOperation = { signal: AbortSignal; deadline: number }
export type PreparedFileReferenceScope = FileReferenceScope & { pathStyle: 'windows' | 'posix' }
export type FileReferenceProbe =
  | { state: 'found'; path: string; canonicalPath: string }
  | { state: 'missing' | 'denied' | 'error'; error?: string }
export type FileReferenceDirectoryEntry = { name: string; kind: 'file' | 'directory' | 'symlink' | 'other' }
export type FileReferenceDirectory =
  | { state: 'ok'; entries: FileReferenceDirectoryEntry[]; complete: boolean }
  | { state: 'missing' | 'denied' | 'error'; error?: string }

/** These adapters are metadata-only and MUST NOT discover/register new grants.
 * listDirectory must enforce existing session access and read at most limit
 * entries (not a whole readdir followed by slice). Close cursors in finally;
 * when a pending open/read finishes after abort, close without another read.
 */
export type FileReferenceDependencies = {
  gate?: FileReferenceGate
  prepareScope(operation: FileReferenceOperation): Promise<PreparedFileReferenceScope>
  probeFile(path: string, scope: PreparedFileReferenceScope, operation: FileReferenceOperation): Promise<FileReferenceProbe>
  listDirectory(path: string, scope: PreparedFileReferenceScope, limit: number, operation: FileReferenceOperation): Promise<FileReferenceDirectory>
}

/** One gate per server process; bounded queued requests consume their original deadline. */
export class FileReferenceGate {
  private active = 0
  private queue: Array<{ signal: AbortSignal; resolve: (release: (() => void) | null) => void; abort: () => void }> = []
  acquire(signal: AbortSignal): Promise<(() => void) | null> {
    if (signal.aborted) return Promise.resolve(null)
    if (this.active < 2) { this.active++; return Promise.resolve(this.release()) }
    if (this.queue.length >= 16) return Promise.resolve(null)
    return new Promise((resolve) => {
      const item = { signal, resolve, abort: () => {
        this.queue = this.queue.filter((queued) => queued !== item)
        resolve(null)
      } }
      signal.addEventListener('abort', item.abort, { once: true })
      this.queue.push(item)
    })
  }
  private release(): () => void {
    let released = false
    return () => {
      if (released) return
      released = true
      this.active--
      const next = this.queue.shift()
      if (next) {
        next.signal.removeEventListener('abort', next.abort)
        this.active++
        next.resolve(this.release())
      }
    }
  }
}
const sharedGate = new FileReferenceGate()
export class FileReferenceIncompleteError extends Error {}

const STOPPED = Symbol('stopped')
const EXCLUDED_DIRECTORIES = new Set(['.git', '.svn', '.hg', '.bzr', '.jj', '.sl', 'node_modules'])

/** No cache, filesystem enumeration, permission mutation or transport in this core. */
export async function resolveWorkspaceFileReference(
  request: FileReferenceRequest,
  dependencies: FileReferenceDependencies,
  signal?: AbortSignal,
): Promise<FileReferenceResult> {
  const started = Date.now()
  const stats = { elapsedMs: 0, exactProbes: 0, directories: 0, entries: 0 }
  let prepared: PreparedFileReferenceScope | null = null
  const finish = (state: FileReferenceResult['state'], complete: boolean, extra: Partial<FileReferenceResult> = {}): FileReferenceResult => ({
    state, complete,
    scope: prepared ? { workDir: prepared.workDir, permissionGeneration: prepared.permissionGeneration } : null,
    stats: { ...stats, elapsedMs: Date.now() - started }, ...extra,
  })
  if (!request || typeof request.reference !== 'string' || !request.reference.trim()
    || request.reference.length > 4096 || request.reference.includes('\0')
    || [request.candidates, request.contextDirectories].some((list) => list !== undefined
      && (!Array.isArray(list) || list.length > 32 || list.some((item) => typeof item !== 'string' || item.length > 4096 || item.includes('\0'))))
    || (request.timeoutMs !== undefined && (!Number.isFinite(request.timeoutMs) || request.timeoutMs <= 0))) {
    return finish('invalid', false, { error: 'Invalid file reference request' })
  }
  const controller = new AbortController()
  const operation = { signal: controller.signal, deadline: started + Math.min(request.timeoutMs ?? FILE_REFERENCE_LIMITS.timeoutMs, FILE_REFERENCE_LIMITS.timeoutMs) }
  let stop!: () => void
  const stopped = new Promise<typeof STOPPED>((resolve) => { stop = () => { controller.abort(); resolve(STOPPED) } })
  const timer = setTimeout(stop, Math.max(0, operation.deadline - Date.now()))
  signal?.addEventListener('abort', stop, { once: true })
  if (signal?.aborted) stop()
  const expired = () => controller.signal.aborted || Date.now() >= operation.deadline
  let release: (() => void) | null = null
  const pending = new Set<Promise<unknown>>()
  async function run<T>(action: () => Promise<T>): Promise<T | typeof STOPPED> {
    if (expired()) { stop(); return STOPPED }
    // Promise.race attaches rejection handlers even when a late I/O loses.
    const task = Promise.resolve().then<T | typeof STOPPED>(() => expired() ? STOPPED : action())
    pending.add(task)
    task.then(() => pending.delete(task), () => pending.delete(task))
    const value = await Promise.race([task, stopped])
    return expired() ? STOPPED : value
  }
  try {
    const acquired = await (dependencies.gate ?? sharedGate).acquire(controller.signal)
    if (expired() || !acquired) { acquired?.(); return finish('incomplete', false) }
    release = acquired
    const scope = await run(() => dependencies.prepareScope(operation))
    if (scope === STOPPED) return finish('incomplete', false)
    prepared = scope
    const paths = scope.pathStyle === 'windows' ? win32 : posix
    const key = (path: string) => scope.pathStyle === 'windows' ? paths.normalize(path).toLowerCase() : paths.normalize(path)
    const reference = request.reference.trim()
    // Drive-relative references and URL schemes are not workspace-relative paths.
    const invalidPath = (value: string) => /^[a-z]:(?![\\/])/i.test(value)
      || (/^[a-z][a-z\d+.-]*:/i.test(value) && !/^[a-z]:[\\/]/i.test(value))
      || /^[\\/]{2}/.test(value)
      || (scope.pathStyle === 'windows' && /^[\\/]/.test(value))
      || value.split(scope.pathStyle === 'windows' ? /[\\/]/ : /\//).includes('..')
    if ([reference, ...(request.candidates ?? []), ...(request.contextDirectories ?? [])].some(invalidPath)) {
      return finish('invalid', false, { error: 'Use a complete absolute path or a workspace-relative file reference' })
    }
    const absolute = paths.isAbsolute(reference)
    const target = paths.resolve(scope.workDir, reference)
    const matches = new Map<string, FileReferenceCandidate>()
    let truncated = false
    let denied = false
    const add = (probe: Extract<FileReferenceProbe, { state: 'found' }>, source: FileReferenceCandidate['source']) => {
      const identity = key(probe.canonicalPath)
      if (!matches.has(identity)) matches.set(identity, { path: probe.path, source })
    }
    const result = (): FileReferenceResult => {
      const candidates = [...matches.values()]
      if (candidates.length > 1) return finish('ambiguous', !truncated, { candidates })
      if (truncated) return finish('incomplete', false, { candidates })
      if (candidates.length === 1) return finish('resolved', true, { path: candidates[0]!.path, candidates })
      return finish(denied ? 'denied' : 'missing', !denied)
    }
    const probe = async (path: string) => {
      if (expired()) return STOPPED
      stats.exactProbes++
      return run(() => dependencies.probeFile(path, scope, operation))
    }
    const direct = await probe(target)
    if (direct === STOPPED) return finish('incomplete', false)
    if (direct.state === 'found') { add(direct, 'reference'); return result() }
    if (direct.state === 'denied') return finish('denied', false, { error: 'File reference is outside existing session access' })
    if (direct.state === 'error') return finish('error', false, { error: 'File metadata could not be read' })
    // Never silently relocate an explicit absolute file that does not exist.
    if (absolute) return finish('missing', true)

    const normalizedReference = key(paths.normalize(reference)).replace(scope.pathStyle === 'windows' ? /^\.\\/ : /^\.\//, '')
    const compatible = (candidate: string) => {
      const normalized = key(candidate)
      return normalized === normalizedReference || normalized.endsWith(`${paths.sep}${normalizedReference}`)
    }
    const seen = new Set([key(target)])
    const rawCandidates = request.candidates ?? []
    const candidates: string[] = []
    for (const item of rawCandidates) {
      const path = paths.resolve(scope.workDir, item)
      if (!compatible(path) || seen.has(key(path))) continue
      seen.add(key(path)); candidates.push(path)
    }
    const remainingProbes = FILE_REFERENCE_LIMITS.exactProbes - stats.exactProbes
    if (candidates.length > remainingProbes) truncated = true
    const boundedCandidates = candidates.slice(0, remainingProbes)
    for (let index = 0; index < boundedCandidates.length; index += FILE_REFERENCE_LIMITS.concurrency) {
      const batch = await Promise.all(boundedCandidates.slice(index, index + FILE_REFERENCE_LIMITS.concurrency).map(probe))
      for (const item of batch) {
        if (item === STOPPED) { truncated = true; return result() }
        if (item.state === 'found') add(item, 'candidate')
        else if (item.state === 'denied') denied = true
        else if (item.state === 'error') return finish('error', false, { error: 'File metadata could not be read' })
      }
    }
    if (matches.size || truncated) return result()

    const roots = [...new Map([...(request.contextDirectories ?? []), scope.workDir]
      .map((root) => { const resolved = paths.resolve(scope.workDir, root); return [key(resolved), resolved] as const })).values()]
    if (roots.length > FILE_REFERENCE_LIMITS.roots) truncated = true
    const queue = roots.slice(0, FILE_REFERENCE_LIMITS.roots).map((path) => ({ path, depth: 0 }))
    const visited = new Set<string>()
    while (queue.length) {
      if (expired() || stats.directories >= FILE_REFERENCE_LIMITS.directories || stats.entries >= FILE_REFERENCE_LIMITS.entries) {
        truncated = true; break
      }
      const current = queue.shift()!
      if (visited.has(key(current.path))) continue
      visited.add(key(current.path))
      stats.directories++
      const remaining = FILE_REFERENCE_LIMITS.entries - stats.entries
      const listing = await run(() => dependencies.listDirectory(current.path, scope, remaining, operation))
      if (listing === STOPPED) { truncated = true; break }
      if (listing.state === 'error') return finish('error', false, { error: 'Directory metadata could not be read' })
      if (listing.state === 'denied') { denied = true; continue }
      // A disappearing search directory is incomplete, not proof of no file.
      if (listing.state === 'missing') { truncated = true; continue }
      if (listing.state !== 'ok') return finish('error', false, { error: 'Invalid directory metadata' })
      if (!listing.complete || listing.entries.length > remaining) truncated = true
      for (const entry of listing.entries.slice(0, remaining)) {
        stats.entries++
        if (!entry.name || entry.name === '.' || entry.name === '..' || entry.name.includes('\0')
          || entry.name.includes('/') || (scope.pathStyle === 'windows' && entry.name.includes('\\'))) {
          return finish('error', false, { error: 'Invalid directory metadata' })
        }
        const path = paths.join(current.path, entry.name)
        if (entry.kind === 'symlink') { truncated = true; continue }
        if (entry.kind === 'directory') {
          if (EXCLUDED_DIRECTORIES.has(entry.name)) continue
          if (current.depth >= FILE_REFERENCE_LIMITS.depth) truncated = true
          else queue.push({ path, depth: current.depth + 1 })
          continue
        }
        if (entry.kind !== 'file' || !compatible(path)) continue
        // Candidate existence and canonical authorization must still be verified.
        if (stats.exactProbes >= FILE_REFERENCE_LIMITS.exactProbes) { truncated = true; continue }
        const found = await probe(path)
        if (found === STOPPED) { truncated = true; return result() }
        if (found.state === 'found') add(found, 'bounded-search')
        else if (found.state === 'denied') denied = true
        else if (found.state === 'error') return finish('error', false, { error: 'File metadata could not be read' })
        else truncated = true
      }
    }
    return result()
  } catch (error) {
    return finish(expired() || error instanceof FileReferenceIncompleteError ? 'incomplete' : 'error', false, {
      error: 'File metadata could not be read',
    })
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener('abort', stop)
    // A timed-out, non-cancellable I/O still occupies capacity until it settles.
    // Otherwise repeated timeouts could create an unbounded number of live reads.
    if (pending.size) void Promise.allSettled([...pending]).then(() => release?.())
    else release?.()
  }
}
/** Request-local work-directory evidence; validation must never load a transcript. */
export type FileReferenceWorkDirSnapshot = {
  workDir: string
  validate(operation: FileReferenceOperation): Promise<void>
}
