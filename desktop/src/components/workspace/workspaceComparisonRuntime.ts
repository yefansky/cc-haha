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
const pending = new Map<number, {
  resolve: (result: WorkspaceComparisonRuntimeResult) => void
  reject: (error: Error) => void
}>()

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
  const activeWorker = comparisonWorker()
  if (!activeWorker) return Promise.resolve().then(() => computeWorkspaceComparisonModel(request))
  return new Promise((resolve, reject) => {
    pending.set(request.id, { resolve, reject })
    try {
      activeWorker.postMessage(request)
    } catch (error) {
      const failure = error instanceof Error ? error : new Error(String(error))
      discardFailedWorker(activeWorker, failure)
    }
  })
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
