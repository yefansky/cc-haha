import { sessionsApi, type SessionTurnCheckpoint } from '../api/sessions'

export type SessionTurnCheckpointSnapshot = {
  checkpoints: SessionTurnCheckpoint[]
  loading: boolean
  error: string | null
}

const EMPTY_SNAPSHOT: SessionTurnCheckpointSnapshot = {
  checkpoints: [],
  loading: false,
  error: null,
}

const snapshotBySession = new Map<string, SessionTurnCheckpointSnapshot>()
const listenersBySession = new Map<string, Set<() => void>>()
const requestBySession = new Map<string, {
  source: typeof sessionsApi.getTurnCheckpoints
  promise: Promise<SessionTurnCheckpoint[]>
}>()

function isSessionTurnCheckpoint(value: unknown): value is SessionTurnCheckpoint {
  if (!value || typeof value !== 'object') return false
  const checkpoint = value as Partial<SessionTurnCheckpoint>
  return (
    Boolean(checkpoint.target) &&
    typeof checkpoint.target?.targetUserMessageId === 'string' &&
    typeof checkpoint.target?.userMessageIndex === 'number' &&
    Boolean(checkpoint.code) &&
    typeof checkpoint.code?.available === 'boolean' &&
    Array.isArray(checkpoint.code?.filesChanged) &&
    (checkpoint.restoreAvailable === undefined ||
      typeof checkpoint.restoreAvailable === 'boolean') &&
    (checkpoint.unverifiedChangeSources === undefined ||
      (Array.isArray(checkpoint.unverifiedChangeSources) &&
        checkpoint.unverifiedChangeSources.every((source) => typeof source === 'string')))
  )
}

export function normalizeSessionTurnCheckpoints(response: unknown): SessionTurnCheckpoint[] {
  if (!response || typeof response !== 'object') return []
  const checkpoints = (response as { checkpoints?: unknown }).checkpoints
  if (!Array.isArray(checkpoints)) return []
  return checkpoints.filter(isSessionTurnCheckpoint)
}

function publishSnapshot(sessionId: string, snapshot: SessionTurnCheckpointSnapshot) {
  snapshotBySession.set(sessionId, snapshot)
  listenersBySession.get(sessionId)?.forEach((listener) => listener())
}

export function getSessionTurnCheckpointSnapshot(sessionId: string): SessionTurnCheckpointSnapshot {
  return snapshotBySession.get(sessionId) ?? EMPTY_SNAPSHOT
}

export function subscribeSessionTurnCheckpoints(sessionId: string, listener: () => void): () => void {
  const listeners = listenersBySession.get(sessionId) ?? new Set<() => void>()
  listeners.add(listener)
  listenersBySession.set(sessionId, listeners)
  return () => {
    listeners.delete(listener)
    if (listeners.size === 0) listenersBySession.delete(sessionId)
  }
}

/**
 * Share the checkpoint request between the transcript and composer strip.
 * Both surfaces refresh on the same completed-turn transition, so keeping the
 * in-flight promise here avoids two identical API scans while still publishing
 * the newest result to every mounted consumer.
 */
export function loadSessionTurnCheckpoints(sessionId: string): Promise<SessionTurnCheckpoint[]> {
  const pending = requestBySession.get(sessionId)
  if (pending?.source === sessionsApi.getTurnCheckpoints) return pending.promise

  const previous = getSessionTurnCheckpointSnapshot(sessionId)
  publishSnapshot(sessionId, { ...previous, loading: true, error: null })

  let request: Promise<SessionTurnCheckpoint[]>
  request = sessionsApi.getTurnCheckpoints(sessionId)
    .then((response) => {
      const checkpoints = normalizeSessionTurnCheckpoints(response)
      publishSnapshot(sessionId, { checkpoints, loading: false, error: null })
      return checkpoints
    })
    .catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error)
      publishSnapshot(sessionId, { checkpoints: [], loading: false, error: message })
      throw error
    })
    .finally(() => {
      if (requestBySession.get(sessionId)?.promise === request) requestBySession.delete(sessionId)
    })

  requestBySession.set(sessionId, { source: sessionsApi.getTurnCheckpoints, promise: request })
  return request
}

export function clearSessionTurnCheckpointCache(sessionId?: string) {
  if (sessionId) {
    snapshotBySession.delete(sessionId)
    requestBySession.delete(sessionId)
    listenersBySession.get(sessionId)?.forEach((listener) => listener())
    return
  }
  const sessionIds = [...snapshotBySession.keys()]
  snapshotBySession.clear()
  requestBySession.clear()
  sessionIds.forEach((id) => listenersBySession.get(id)?.forEach((listener) => listener()))
}
