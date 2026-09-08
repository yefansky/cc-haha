import type { BackgroundAgentTask } from '../types/chat'

export type SubagentProgress = {
  toolUseId: string
  agentId: string
  description: string
  startedAt: number
  updatedAt: number
  outputTokensEstimate: number
  phase: 'waiting' | 'thinking' | 'responding' | 'tool' | 'finished'
}

export function parseSubagentProgress(data: unknown): SubagentProgress | null {
  if (!data || typeof data !== 'object') return null
  const p = data as SubagentProgress
  if (typeof p.toolUseId !== 'string' || !p.toolUseId || typeof p.agentId !== 'string' || !p.agentId ||
    typeof p.description !== 'string' || !['waiting', 'thinking', 'responding', 'tool', 'finished'].includes(p.phase) ||
    ![p.startedAt, p.updatedAt, p.outputTokensEstimate].every(n => typeof n === 'number' && Number.isFinite(n) && n >= 0) ||
    p.updatedAt < p.startedAt) return null
  return p
}

export function updateSubagentProgress(current: Record<string, SubagentProgress>, next: SubagentProgress) {
  const previous = current[next.toolUseId]
  if (previous && (previous.startedAt > next.startedAt ||
    (previous.startedAt === next.startedAt && (previous.updatedAt > next.updatedAt ||
      (previous.phase === 'finished' && next.phase !== 'finished'))))) return current
  const result = { ...current, [next.toolUseId]: next }
  const finished = Object.values(result).filter(p => p.phase === 'finished').sort((a, b) => b.updatedAt - a.updatedAt)
  for (const p of finished.slice(64)) delete result[p.toolUseId]
  return result
}

export function getRunningSubagentProgress(session?: {
  subagentProgress?: Record<string, SubagentProgress>
  backgroundAgentTasks?: Record<string, BackgroundAgentTask>
  stopAllSubagentsRequested?: boolean
  chatState: string
}) {
  return Object.values(session?.subagentProgress ?? {}).filter(progress => {
    if (progress.phase === 'finished' || session?.stopAllSubagentsRequested) return false
    const task = Object.values(session?.backgroundAgentTasks ?? {}).find(task => task.toolUseId === progress.toolUseId)
    return task ? task.status === 'running' : session?.chatState !== 'idle'
  })
}
