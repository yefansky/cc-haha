/** Metadata-only coordination. Cached paths are advisory, not authorization.
 * Navigation must perform an authoritative exact-target check even when the
 * downstream preview happens to serve its own cached file content. */
export type FileResolutionRequest = {
  reference: string
  candidates?: string[]
  contextDirectories?: string[]
  timeoutMs?: number
}
export type FileResolutionResult = {
  state: 'resolved' | 'ambiguous' | 'missing' | 'incomplete' | 'denied' | 'invalid' | 'error'
  path?: string
  candidates?: Array<{ path: string; source: string }>
  complete: boolean
  error?: string
  scope?: { workDir: string; permissionGeneration: string | number } | null
  stats?: { elapsedMs: number; exactProbes: number; directories: number; entries: number }
}
export type FileResolutionContext = {
  server: string
  sessionId: string
  workDir: string
  permissionGeneration: string | number
  evidenceRevision: string
}
export type FileResolutionTransport = (
  request: FileResolutionRequest, context: FileResolutionContext, signal: AbortSignal,
) => Promise<FileResolutionResult>
type Waiter = { resolve: (value: FileResolutionResult) => void; reject: (error: unknown) => void; cleanup: () => void }
type Job = {
  key: string; scope: string; context: FileResolutionContext; request: FileResolutionRequest
  deadline: number; controller: AbortController; waiters: Set<Waiter>
  timer: ReturnType<typeof setTimeout>; done: boolean
  fresh: boolean
}
const incomplete = (error: string): FileResolutionResult => ({ state: 'incomplete', complete: false, error })
const scopeOf = (context: FileResolutionContext) => JSON.stringify([context.server, context.sessionId, context.workDir, context.permissionGeneration])
const pathKey = (path: string) => {
  const normalized = path.replace(/\\/g, '/')
  return /^[a-z]:\//i.test(normalized) ? normalized.toLowerCase() : normalized
}

export class AssistantFileResolutionCoordinator {
  private cache = new Map<string, { result: FileResolutionResult; expires: number }>()
  private pending = new Map<string, Job>()
  private queue: Job[] = []
  private active = 0
  private freshSequence = 0
  private cacheHits = new WeakSet<FileResolutionResult>()
  wasCacheHit(result: FileResolutionResult) { return this.cacheHits.has(result) }
  constructor(private transport: FileResolutionTransport, private now: () => number = Date.now) {}

  get metrics() { return { cached: this.cache.size, pending: this.pending.size, queued: this.queue.length, active: this.active } }

  resolve(request: FileResolutionRequest, context: FileResolutionContext, signal?: AbortSignal, fresh = false): Promise<FileResolutionResult> {
    if (signal?.aborted) return Promise.reject(signal.reason ?? new DOMException('Aborted', 'AbortError'))
    if ((request.candidates?.length ?? 0) > 8 || (request.contextDirectories?.length ?? 0) > 3) {
      return Promise.resolve(incomplete('候选数量超过定位预算，未截断为唯一目标'))
    }
    const bounded = { ...request, candidates: request.candidates ? [...request.candidates] : undefined, contextDirectories: request.contextDirectories ? [...request.contextDirectories] : undefined }
    const scope = scopeOf(context)
    const key = JSON.stringify([scope, context.evidenceRevision, bounded.reference, bounded.candidates, bounded.contextDirectories, fresh ? ++this.freshSequence : 0])
    const cached = this.cache.get(key)
    if (cached && cached.expires > this.now()) {
      this.cache.delete(key); this.cache.set(key, cached)
      const result = { ...cached.result }
      this.cacheHits.add(result)
      return Promise.resolve(result)
    }
    this.cache.delete(key)
    let job = this.pending.get(key)
    if (!job) {
      if (this.queue.length >= 16) return Promise.resolve(incomplete('定位队列已满，请稍后重试'))
      const budget = Math.max(0, Math.min(500, request.timeoutMs ?? 500))
      job = {
        key, scope, request: bounded, context, deadline: this.now() + budget,
        controller: new AbortController(), waiters: new Set(), done: false, fresh,
        timer: undefined as unknown as ReturnType<typeof setTimeout>,
      }
      const created = job
      job.timer = setTimeout(() => {
        this.finish(created, incomplete('定位超时，搜索未完成'))
        created.controller.abort()
        this.pump()
      }, budget)
      this.pending.set(key, job)
      this.queue.push(job)
    }
    const target = job
    const promise = new Promise<FileResolutionResult>((resolve, reject) => {
      const cancel = () => {
        target.waiters.delete(waiter)
        waiter.cleanup()
        reject(signal?.reason ?? new DOMException('Aborted', 'AbortError'))
        if (!target.waiters.size && !target.done) {
          this.finish(target, incomplete('已取消'))
          target.controller.abort()
          this.pump()
        }
      }
      const waiter: Waiter = { resolve, reject, cleanup: () => signal?.removeEventListener('abort', cancel) }
      target.waiters.add(waiter)
      signal?.addEventListener('abort', cancel, { once: true })
    })
    this.pump()
    return promise
  }

  /** Called on workspace/server/auth/roots changes. Aborted late responses may
   * not repopulate either cache or UI, even when an identical key is reopened. */
  invalidate(context?: Pick<FileResolutionContext, 'server' | 'sessionId'>): void {
    const matches = (scope: string) => {
      if (!context) return true
      const [server, session] = JSON.parse(scope) as string[]
      return server === context.server && session === context.sessionId
    }
    for (const key of this.cache.keys()) {
      const [scope] = JSON.parse(key) as string[]
      if (matches(scope!)) this.cache.delete(key)
    }
    for (const job of [...this.pending.values()]) {
      if (!matches(job.scope)) continue
      this.finish(job, incomplete('定位上下文已变化，请重试'))
      job.controller.abort()
    }
    this.pump()
  }

  private finish(job: Job, result: FileResolutionResult): void {
    if (job.done) return
    job.done = true
    clearTimeout(job.timer)
    if (this.pending.get(job.key) === job) this.pending.delete(job.key)
    this.queue = this.queue.filter((queued) => queued !== job)
    for (const waiter of job.waiters) { waiter.cleanup(); waiter.resolve(result) }
    job.waiters.clear()
  }

  private pump(): void {
    while (this.active < 2 && this.queue.length) {
      const job = this.queue.shift()!
      if (job.done) continue
      const remaining = job.deadline - this.now()
      if (remaining <= 0) { this.finish(job, incomplete('定位超时，搜索未完成')); continue }
      this.active++
      void Promise.resolve().then(() => this.transport({ ...job.request, timeoutMs: remaining }, job.context, job.controller.signal))
        .then((response) => {
          if (job.done || this.pending.get(job.key) !== job) return
          if (this.now() >= job.deadline) { this.finish(job, incomplete('定位超时，搜索未完成')); return }
          let result = response
          const requested = pathKey(job.request.reference)
          if (/^(?:[a-z]:\/|\/)/i.test(requested) && result.state === 'resolved'
            && pathKey(result.path ?? '') !== requested) result = incomplete('完整路径不会被替换为其他目标')
          if (result.state === 'resolved' && (!result.complete || !result.path || !result.scope)) result = { ...result, state: 'incomplete', complete: false }
          const ttl = job.fresh || !result.scope ? 0 : result.complete && result.state === 'resolved' ? 30_000
            : result.complete && (result.state === 'missing' || result.state === 'ambiguous') ? 2_000 : 0
          if (ttl) {
            this.cache.delete(job.key)
            this.cache.set(job.key, { result, expires: this.now() + ttl })
            while (this.cache.size > 128) this.cache.delete(this.cache.keys().next().value!)
          }
          this.finish(job, result)
        }).catch((error: unknown) => {
          this.finish(job, incomplete(error instanceof Error ? error.message : '定位失败'))
        }).finally(() => {
          // A transport that ignores abort keeps its slot until it actually
          // settles; timed-out requests must not cause unbounded hidden I/O.
          this.active--
          this.pump()
        })
    }
  }
}
