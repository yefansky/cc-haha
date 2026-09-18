import type { AskUserDecisionProjection } from '../stores/chatStore'
import type { UIMessage } from '../types/chat'

/** A state snapshot is not an append-only stream of newly created questions. */
export function includeProjectedAsks(
  messages: UIMessage[],
  projection: AskUserDecisionProjection,
): UIMessage[] {
  if (projection.source !== 'server') return messages
  const positions = new Map<string, number>()
  messages.forEach((message, index) => {
    if (message.type === 'tool_use' && message.toolName === 'AskUserQuestion') {
      positions.set(message.toolUseId, index)
    }
  })
  const insertions = new Map<number, UIMessage[]>()
  const seen = new Set(positions.keys())
  // Old sidecars have no timestamp. Their snapshot order still supplies a
  // trustworthy next-question anchor, including a question received live.
  const nextAnchors: Array<number | undefined> = []
  let nextAnchor: number | undefined
  for (let i = projection.views.length - 1; i >= 0; i--) {
    nextAnchors[i] = nextAnchor
    const position = positions.get(projection.views[i]!.toolUseId)
    if (position !== undefined) nextAnchor = position
  }
  let previousAnchor: number | undefined
  projection.views.forEach((view, index) => {
    const existing = positions.get(view.toolUseId)
    if (existing !== undefined) previousAnchor = existing
    if (view.source !== 'server' || seen.has(view.toolUseId)) return
    seen.add(view.toolUseId)
    const timestamp = view.decision?.timestamp
    let slot: number
    if (timestamp !== undefined && Number.isFinite(timestamp)) {
      const following = messages.findIndex(message => message.timestamp > timestamp)
      slot = following < 0 ? messages.length : following
    } else if (view.decision?.inputSource === 'live') {
      slot = messages.length
    } else if (nextAnchors[index] !== undefined) {
      slot = nextAnchors[index]!
    } else if (previousAnchor !== undefined) {
      slot = previousAnchor + 1
    } else {
      // Missing transcript history precedes live-only messages. A new live
      // request, unlike historical state, belongs at the end of the timeline.
      slot = 0
    }
    const additions = insertions.get(slot) ?? []
    additions.push({
      id: `user-decision-${view.toolUseId}`,
      type: 'tool_use',
      toolName: 'AskUserQuestion',
      toolUseId: view.toolUseId,
      input: view.input,
      timestamp: timestamp ?? messages[slot]?.timestamp ?? messages.at(-1)?.timestamp ?? 0,
      isPending: false,
    })
    insertions.set(slot, additions)
  })
  if (insertions.size === 0) return messages
  const result: UIMessage[] = []
  messages.forEach((message, index) => {
    result.push(...(insertions.get(index) ?? []), message)
  })
  result.push(...(insertions.get(messages.length) ?? []))
  return result
}
