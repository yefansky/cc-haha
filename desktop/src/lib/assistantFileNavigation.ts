import { AssistantFileResolutionCoordinator, type FileResolutionResult, type FileResolutionTransport } from './assistantFileResolution'
import { parseFilePathRef } from './filePathBoundary'
import { isAbsoluteLocalPath } from './handlePreviewLink'
import { resolveAssistantFileLink } from './assistantFileLink'
import type { MessageFileEvidence } from './assistantFileEvidence'

export type FileNavigationContext = {
  server: string; sessionId: string; workDir: string; generation: string
  evidence?: MessageFileEvidence; changedFiles?: string[]; referencedFiles?: string[]
}
export type FileNavigationResult = FileResolutionResult & { href?: string; compatibility?: boolean }

/** Derive precise candidates by directory overlap, before any directory scan.
 * For known /brain/users/me/index.md and users/me/reports/a.html, the overlap
 * users/me produces /brain/users/me/reports/a.html. Never parse shell prose. */
export function deriveFileReferenceHints(reference: string, knownFiles: string[], workDir: string) {
  const path = reference.replace(/\\/g, '/')
  const windows = /^[a-z]:\//i.test(workDir)
  const key = (value: string) => windows ? value.toLowerCase() : value
  const ranked = new Map<string, { path: string; score: number }>()
  const dirs = new Map<string, string>()
  if (!isAbsoluteLocalPath(path) && !path.startsWith('~') && !path.split('/').includes('..')) {
    const parts = path.replace(/^\.\//, '').split('/')
    for (const raw of knownFiles) {
      const file = raw.replace(/\\/g, '/')
      if (!isAbsoluteLocalPath(file)) continue
      const dir = file.slice(0, file.lastIndexOf('/'))
      if (key(file).endsWith(`/${key(path)}`)) ranked.set(key(file), { path: file, score: 1000 })
      const directoryParts = dir.split('/')
      for (let length = Math.min(parts.length - 1, directoryParts.length); length > 0; length--) {
        if (key(directoryParts.slice(-length).join('/')) !== key(parts.slice(0, length).join('/'))) continue
        const candidate = `${dir}/${parts.slice(length).join('/')}`
        ranked.set(key(candidate), { path: candidate, score: length })
        dirs.set(key(dir), dir)
        break
      }
    }
  }
  const candidates = [...ranked.values()].sort((a, b) => b.score - a.score).map((item) => item.path)
  if (workDir) dirs.set(key(workDir), workDir)
  return { candidates, contextDirectories: [...dirs.values()], complete: candidates.length <= 8 && dirs.size <= 3 }
}

export class AssistantFileNavigator {
  private coordinator: AssistantFileResolutionCoordinator
  private unsupported = new Map<string, number>()
  private observedScopes = new Map<string, string>()
  constructor(transport: FileResolutionTransport, private legacyVerify?: (path: string, context: FileNavigationContext, signal?: AbortSignal, timeoutMs?: number) => Promise<boolean>) {
    this.coordinator = new AssistantFileResolutionCoordinator(async (request, context, signal) => {
      try { return await transport(request, context, signal) }
      catch (error) {
        const status = (error as { status?: number }).status
        if (status === 404 || status === 405) {
          this.unsupported.set(context.server, Date.now() + 2000)
          while (this.unsupported.size > 16) this.unsupported.delete(this.unsupported.keys().next().value!)
          return { state: 'error', complete: false, error: 'unsupported' }
        }
        throw error
      }
    })
  }
  invalidate() { this.coordinator.invalidate(); this.unsupported.clear(); this.observedScopes.clear() }
  private observe(result: FileResolutionResult, context: FileNavigationContext) {
    if (!result.scope) return
    const key = JSON.stringify([context.server, context.sessionId, context.workDir])
    const value = JSON.stringify(result.scope)
    const old = this.observedScopes.get(key)
    this.observedScopes.set(key, value)
    while (this.observedScopes.size > 128) this.observedScopes.delete(this.observedScopes.keys().next().value!)
    // First observation does not destroy the just-warmed cache. A later server
    // permission/root generation invalidates prior advisory and negative hits.
    if (old !== undefined && old !== value) this.coordinator.invalidate(context)
  }

  async resolve(href: string, context: FileNavigationContext, signal?: AbortSignal): Promise<FileNavigationResult> {
    const started = Date.now()
    const ref = parseFilePathRef(href)
    if (!ref) return { state: 'invalid', complete: false, error: '无法识别文件路径' }
    const position = ref.line ? `:${ref.line}${ref.column ? `:${ref.column}` : ''}` : ''
    const explicit = isAbsoluteLocalPath(ref.path)
    const windows = /^[a-z]:[\\/]/i.test(context.workDir)
    const indexed = context.evidence?.index.lookup(ref.path, context.evidence.cutoff, windows)
    const known = explicit ? [] : [...(context.changedFiles ?? []), ...(context.referencedFiles ?? []), ...(context.evidence?.index.knownFiles(context.evidence.cutoff) ?? [])]
    const synchronous = resolveAssistantFileLink(href, { workDir: context.workDir, changedFiles: context.changedFiles, referencedFiles: indexed?.candidates ?? context.referencedFiles })
    const fallback = async (): Promise<FileNavigationResult> => {
      const result: FileNavigationResult = { state: 'error', complete: false, error: '自动定位需要服务升级' }
      if (synchronous.blocked || !(explicit || synchronous.verified)) return result
      if (this.legacyVerify) {
        const remaining = 500 - (Date.now() - started)
        if (remaining <= 0 || !(await this.legacyVerify(parseFilePathRef(synchronous.href)?.path ?? synchronous.href, context, signal, remaining))) return { state: 'denied', complete: false, error: '自动定位需要服务升级；原文件访问校验未通过' }
      }
      return { ...result, href: synchronous.href, compatibility: true }
    }
    if ((this.unsupported.get(context.server) ?? 0) > Date.now()) return fallback()
    const hints = deriveFileReferenceHints(ref.path, known, context.workDir)
    if (!explicit && !hints.complete) return { state: 'incomplete', complete: false, candidates: hints.candidates.slice(0, 5).map((path) => ({ path, source: 'evidence' })), error: '候选超过定位预算，请选择完整路径' }
    const identity = { server: context.server, sessionId: context.sessionId, workDir: context.workDir, permissionGeneration: context.generation,
      evidenceRevision: `${context.evidence?.revision ?? JSON.stringify(context.referencedFiles ?? [])}|${JSON.stringify(context.changedFiles ?? [])}` }
    const initialBudget = 500 - (Date.now() - started)
    if (initialBudget <= 0) return { state: 'incomplete', complete: false, error: '定位超时，搜索未完成' }
    const result = await this.coordinator.resolve({ reference: ref.path, candidates: explicit ? undefined : hints.candidates, contextDirectories: explicit ? undefined : hints.contextDirectories, timeoutMs: initialBudget }, identity, signal, explicit)
    this.observe(result, context)
    if (result.error === 'unsupported') return fallback()
    if (signal?.aborted || result.state !== 'resolved' || !result.path || !result.complete) return result
    if (explicit || !this.coordinator.wasCacheHit(result)) return { ...result, href: `${result.path}${position}` }
    // Advisory cache may be stale, and preview content itself may be cached.
    // Always authorize the exact selected target before letting the UI open it.
    const remaining = 500 - (Date.now() - started)
    if (remaining <= 0) return { state: 'incomplete', complete: false, error: '定位超时，搜索未完成' }
    const checked = await this.coordinator.resolve({ reference: result.path, timeoutMs: remaining }, identity, signal, true)
    this.observe(checked, context)
    if (checked.state !== 'resolved' || !checked.path || !checked.complete) return checked
    return { ...checked, href: `${checked.path}${position}` }
  }
}
