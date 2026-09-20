export type RendererBoundaryEvent = {
  recordingId: string; layer: 'renderer' | 'renderer.http'; direction: 'in' | 'out'
  event: string; correlationId: string; outcome?: string; timestamp: number; seq: number
}
let recordingId: string | null = null
let sequence = 0
let report: ((event: RendererBoundaryEvent) => void) | undefined
export function setRendererRecording(id: string | null, send?: (event: RendererBoundaryEvent) => void) {
  if (id !== recordingId) sequence = 0
  recordingId = id
  report = send
}
export function rendererRecordingActive() { return recordingId !== null }
export function parseRendererBoundary(value: unknown): RendererBoundaryEvent | null {
  if (!value || typeof value !== 'object') return null
  const item = value as RendererBoundaryEvent
  if (!['renderer', 'renderer.http'].includes(item.layer) || !['in', 'out'].includes(item.direction)
    || !['user_message', 'permission_response', 'user_decision_response', 'user_message_replay',
      'user_decision_response_result', 'permission_response_failed', 'http.request', 'http.response', 'http.error'].includes(item.event)
    || typeof item.correlationId !== 'string' || !/^[a-zA-Z0-9_:.\/-]{1,256}$/.test(item.correlationId)
    || typeof item.recordingId !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(item.recordingId)
    || !Number.isFinite(item.timestamp) || !Number.isSafeInteger(item.seq) || item.seq < 1
    || (item.outcome !== undefined && !/^[a-z_0-9.]{1,48}$/.test(item.outcome))) return null
  return { layer: item.layer, direction: item.direction, event: item.event,
    correlationId: item.correlationId, recordingId: item.recordingId, timestamp: item.timestamp, seq: item.seq,
    ...(item.outcome ? { outcome: item.outcome } : {}) }
}
export function recordRendererBoundary(event: string, correlationId: unknown, direction: 'in' | 'out', outcome?: string,
  layer: RendererBoundaryEvent['layer'] = 'renderer') {
  if (!recordingId || !report || typeof correlationId !== 'string') return
  const parsed = parseRendererBoundary({ layer, direction, event, correlationId,
    recordingId, timestamp: Date.now(), seq: ++sequence, outcome })
  if (parsed) { try { report(parsed) } catch { /* observation cannot affect delivery */ } }
}
export function recordRendererProtocolBoundary(message: { type: string }, direction: 'in' | 'out') {
  if (!recordingId) return
  const item = message as { type: string; messageUuid?: string; requestId?: string; attemptId?: string; state?: string }
  const id = ['user_message', 'user_message_replay'].includes(item.type) ? item.messageUuid
    : ['user_decision_response', 'user_decision_response_result'].includes(item.type) ? item.attemptId
      : ['permission_response', 'permission_response_failed'].includes(item.type) ? item.requestId : undefined
  recordRendererBoundary(item.type, id, direction, item.type === 'user_decision_response_result' ? item.state : undefined)
}
