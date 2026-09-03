import type { WorkspaceComparison } from '@/api/sessions'
import type { WorkspaceManualAlignmentAnchor } from './workspaceManualAlignment'
import { buildWorkspaceSideBySideModel, type WorkspaceSideBySideModel } from './workspaceSideBySideModel'
import type { WorkspaceComparisonSettings } from './workspaceComparisonSettings'

export interface WorkspaceComparisonRuntimeRequest {
  id: number
  sessionRevision: number
  settingsRevision: number
  value: string
  comparison?: WorkspaceComparison
  path: string
  anchors: WorkspaceManualAlignmentAnchor[]
  settings: WorkspaceComparisonSettings
}

export interface WorkspaceComparisonRuntimeResult {
  id: number
  sessionRevision: number
  settingsRevision: number
  model: WorkspaceSideBySideModel
}

export function computeWorkspaceComparisonModel(request: WorkspaceComparisonRuntimeRequest): WorkspaceComparisonRuntimeResult {
  return {
    id: request.id,
    sessionRevision: request.sessionRevision,
    settingsRevision: request.settingsRevision,
    model: buildWorkspaceSideBySideModel(
      request.value,
      request.comparison,
      request.path,
      request.anchors,
      request.settings,
    ),
  }
}

let worker: Worker | null = null
let nextId = 1
const WORKSPACE_COMPARISON_CACHE_SIZE = 24
const WORKSPACE_COMPARISON_CACHE_ROW_LIMIT = 80_000
const WORKSPACE_COMPARISON_CACHE_MAX_ENTRY_ROWS = 20_000
const pending = new Map<number, {
  resolve: (result: WorkspaceComparisonRuntimeResult) => void
  reject: (error: Error) => void
}>()
const cachedModels = new Map<string, { model: WorkspaceSideBySideModel; rows: number }>()
const pendingByCacheKey = new Map<string, Promise<WorkspaceComparisonRuntimeResult>>()
let cachedModelRows = 0

function comparisonInputCacheKey(input: Omit<WorkspaceComparisonRuntimeRequest, 'id'>) {
  const sideIdentity = (side: WorkspaceComparison['left'] | undefined) => side
    ? [
        side.source.kind,
        side.source.path,
        side.source.revision,
        side.contentFingerprint ?? '',
        side.state,
        side.exists ? '1' : '0',
        side.requestedEncoding,
      ].join('\0')
    : '-'
  return [
    input.path,
    input.comparison ? '' : input.value,
    String(input.sessionRevision),
    String(input.settingsRevision),
    sideIdentity(input.comparison?.left),
    sideIdentity(input.comparison?.right),
    JSON.stringify(input.anchors),
    JSON.stringify(input.settings),
  ].join('\u0001')
}

function cacheComparisonModel(cacheKey: string, model: WorkspaceSideBySideModel) {
  const rows = model.files.reduce((total, file) => total + file.rows.length, 0)
  if (rows > WORKSPACE_COMPARISON_CACHE_MAX_ENTRY_ROWS) return
  const previous = cachedModels.get(cacheKey)
  if (previous) cachedModelRows -= previous.rows
  cachedModels.delete(cacheKey)
  cachedModels.set(cacheKey, { model, rows })
  cachedModelRows += rows
  while (
    cachedModels.size > WORKSPACE_COMPARISON_CACHE_SIZE
    || cachedModelRows > WORKSPACE_COMPARISON_CACHE_ROW_LIMIT
  ) {
    const oldest = cachedModels.keys().next().value
    if (oldest === undefined) break
    cachedModelRows -= cachedModels.get(oldest)?.rows ?? 0
    cachedModels.delete(oldest)
  }
}

function discardFailedWorker(failedWorker: Worker, error: Error) {
  if (worker === failedWorker) worker = null
  failedWorker.onmessage = null
  failedWorker.onerror = null
  failedWorker.terminate()
  for (const request of pending.values()) request.reject(error)
  pending.clear()
}

function comparisonWorker() {
  if (worker || typeof Worker === 'undefined') return worker
  worker = new Worker(new URL('./workspaceComparison.worker.ts', import.meta.url), { type: 'module' })
  worker.onmessage = (event: MessageEvent<WorkspaceComparisonRuntimeResult & { error?: string }>) => {
    const request = pending.get(event.data.id)
    if (!request) return
    pending.delete(event.data.id)
    if (event.data.error) request.reject(new Error(event.data.error))
    else request.resolve(event.data)
  }
  const createdWorker = worker
  worker.onerror = (event) => {
    const error = new Error(event.message || 'comparison worker failed')
    discardFailedWorker(createdWorker, error)
  }
  return worker
}

export function requestWorkspaceComparisonModel(
  input: Omit<WorkspaceComparisonRuntimeRequest, 'id'>,
): Promise<WorkspaceComparisonRuntimeResult> {
  const request = { ...input, id: nextId++ }
  const cacheKey = comparisonInputCacheKey(input)
  const cached = cachedModels.get(cacheKey)
  if (cached) {
    cachedModels.delete(cacheKey)
    cachedModels.set(cacheKey, cached)
    return Promise.resolve({
      id: request.id,
      sessionRevision: request.sessionRevision,
      settingsRevision: request.settingsRevision,
      model: cached.model,
    })
  }
  const inFlight = pendingByCacheKey.get(cacheKey)
  if (inFlight) return inFlight.then((result) => ({ ...result, id: request.id }))

  const activeWorker = comparisonWorker()
  const calculation = !activeWorker
    ? Promise.resolve().then(() => computeWorkspaceComparisonModel(request))
    : new Promise<WorkspaceComparisonRuntimeResult>((resolve, reject) => {
        pending.set(request.id, { resolve, reject })
        try {
          activeWorker.postMessage(request)
        } catch (error) {
          const failure = error instanceof Error ? error : new Error(String(error))
          discardFailedWorker(activeWorker, failure)
        }
      })
  const cachedCalculation = calculation
    .then((result) => {
      cacheComparisonModel(cacheKey, result.model)
      return result
    })
    .finally(() => pendingByCacheKey.delete(cacheKey))
  pendingByCacheKey.set(cacheKey, cachedCalculation)
  return cachedCalculation
}

export function resetWorkspaceComparisonRuntimeForTests() {
  if (worker) {
    worker.onmessage = null
    worker.onerror = null
    worker.terminate()
    worker = null
  }
  pending.clear()
  pendingByCacheKey.clear()
  cachedModels.clear()
  cachedModelRows = 0
  nextId = 1
}

export function createWorkspaceComparisonRevisionGate<T>(accept: (value: T) => void) {
  let revision = 0
  return {
    submit(promise: Promise<T>) {
      const requestedRevision = ++revision
      return promise.then((value) => {
        if (requestedRevision === revision) accept(value)
        return value
      })
    },
    invalidate() { revision += 1 },
  }
}
