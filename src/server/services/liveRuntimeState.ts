import { conversationService } from './conversationService.js'
import { getSessionRuntimeObservation } from '../ws/handler.js'

/** Read existing memory only. Never load transcripts, refresh indexes or touch a CLI. */
export function getLiveRuntimeState() {
  const processes = conversationService.getRuntimeObservation()
  return {
    sessions: processes.sessions.map(session => ({
      ...session,
      orchestration: getSessionRuntimeObservation(session.sessionId),
    })),
    totalSessions: processes.totalSessions,
    truncated: processes.truncated,
  }
}
