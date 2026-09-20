import { setRendererRecording, type RendererBoundaryEvent } from './rendererBoundaryTrace'
export const LIVE_DEBUG_CHANNEL = 'cc-live-debug-observation'
export type RendererDebugSession = {
  sessionId: string
  chatState: string
  connectionState: string
  pendingPermissionCount: number
  queuedMessageCount: number
}
export type RendererDebugSnapshot = { sessions: RendererDebugSession[]; truncated: boolean }
type ObservableSession = {
  chatState: string
  connectionState: string
  pendingPermission?: unknown
  pendingPermissions?: Record<string, unknown>
  queuedUserMessages?: unknown[]
}
export function buildRendererDebugSnapshot(sessions: Record<string, ObservableSession>): RendererDebugSnapshot {
  const entries = Object.entries(sessions)
  return { truncated: entries.length > 64, sessions: entries.slice(0, 64).map(([sessionId, state]) => ({
    sessionId: sessionId.slice(0, 128), chatState: state.chatState,
    connectionState: state.connectionState,
    pendingPermissionCount: Math.max(Object.keys(state.pendingPermissions ?? {}).length, state.pendingPermission ? 1 : 0),
    queuedMessageCount: state.queuedUserMessages?.length ?? 0,
  })) }
}
export function parseRendererDebugSnapshot(value: unknown): RendererDebugSnapshot | null {
  if (!value || typeof value !== 'object') return null
  const data = value as RendererDebugSnapshot
  if (!Array.isArray(data.sessions) || data.sessions.length > 64 || typeof data.truncated !== 'boolean') return null
  const sessions: RendererDebugSession[] = []
  for (const item of data.sessions) {
    if (!item || typeof item.sessionId !== 'string' || item.sessionId.length > 128
      || !/^[a-zA-Z0-9_-]+$/.test(item.sessionId)
      || !['idle', 'thinking', 'compacting', 'tool_executing', 'streaming', 'permission_pending'].includes(item.chatState)
      || !['connected', 'connecting', 'reconnecting', 'disconnected'].includes(item.connectionState)
      || !Number.isSafeInteger(item.pendingPermissionCount) || item.pendingPermissionCount < 0
      || !Number.isSafeInteger(item.queuedMessageCount) || item.queuedMessageCount < 0) return null
    sessions.push({ sessionId: item.sessionId, chatState: item.chatState, connectionState: item.connectionState,
      pendingPermissionCount: item.pendingPermissionCount, queuedMessageCount: item.queuedMessageCount })
  }
  return { sessions, truncated: data.truncated }
}
export type RendererDebugBridge = {
  subscribe(handler: (enabled: boolean, recordingId?: string | null) => void): () => void
  report(snapshot: RendererDebugSnapshot): void
  reportBoundary?(event: RendererBoundaryEvent): void
}
export function installRendererDebugObservation(read: () => RendererDebugSnapshot, bridge?: RendererDebugBridge) {
  const actual = bridge ?? (typeof window === 'undefined' ? undefined
    : (window as unknown as { liveDebugObservation?: RendererDebugBridge }).liveDebugObservation)
  if (!actual) return () => {}
  let timer: ReturnType<typeof setInterval> | undefined
  const unsubscribe = actual.subscribe((enabled, recordingId) => {
    setRendererRecording(recordingId ?? null, actual.reportBoundary)
    clearInterval(timer)
    timer = undefined
    if (!enabled) return
    actual.report(read())
    timer = setInterval(() => actual.report(read()), 1000)
  })
  return () => { clearInterval(timer); unsubscribe(); setRendererRecording(null) }
}
