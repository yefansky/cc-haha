import type { Message } from '../../types/message.js'

export type AgentStreamProgress = {
  toolUseId: string
  agentId: string
  description: string
  startedAt: number
  updatedAt: number
  outputTokensEstimate: number
  phase: 'waiting' | 'thinking' | 'responding' | 'tool' | 'finished'
}

/** Metadata only: no child text is copied into the parent's conversation. */
export function createAgentStreamProgress(
  identity: Pick<AgentStreamProgress, 'toolUseId' | 'agentId' | 'description'>,
  emit: (progress: AgentStreamProgress) => void,
  clock = Date.now,
) {
  const startedAt = clock()
  let chars = 0
  let lastSent = -Infinity
  let phase: AgentStreamProgress['phase'] = 'waiting'
  const publish = (force = false) => {
    const now = clock()
    if (!force && now - lastSent < 500) return
    lastSent = now
    emit({ ...identity, startedAt, updatedAt: now, phase, outputTokensEstimate: Math.round(chars / 4) })
  }
  publish(true)
  return {
    observe(message: Message) {
      const previousPhase = phase
      if (message.type === 'stream_event') {
        const event = message.event
        if (event.type === 'message_start') phase = 'waiting'
        else if (event.type === 'content_block_delta') {
          const delta = event.delta
          if (delta.type === 'thinking_delta') { chars += delta.thinking.length; phase = 'thinking' }
          else if (delta.type === 'text_delta') { chars += delta.text.length; phase = 'responding' }
          else if (delta.type === 'input_json_delta') { chars += delta.partial_json.length; phase = 'tool' }
          else return
        } else return
      } else if (message.type === 'assistant' && message.message.content.some(block => block.type === 'tool_use')) {
        phase = 'tool'
      } else if (message.type === 'user') {
        phase = 'waiting'
      } else return
      publish(previousPhase !== phase)
    },
    finish() { phase = 'finished'; publish(true) },
  }
}
