import {
  computeWorkspaceComparisonModel,
  type WorkspaceComparisonRuntimeRequest,
} from './workspaceComparisonRuntime'

const workerScope = self as unknown as {
  onmessage: ((event: MessageEvent<WorkspaceComparisonRuntimeRequest>) => void) | null
  postMessage: (value: unknown) => void
}

workerScope.onmessage = (event: MessageEvent<WorkspaceComparisonRuntimeRequest>) => {
  try {
    workerScope.postMessage(computeWorkspaceComparisonModel(event.data))
  } catch (error) {
    workerScope.postMessage({
      id: event.data.id,
      sessionRevision: event.data.sessionRevision,
      settingsRevision: event.data.settingsRevision,
      error: error instanceof Error ? error.message : String(error),
    })
  }
}
