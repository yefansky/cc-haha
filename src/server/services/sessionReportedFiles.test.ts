import { afterEach, expect, it, spyOn } from 'bun:test'
import { sessionService, type MessageEntry } from './sessionService.js'
import { listSessionTurnCheckpoints } from './sessionRewindService.js'

const spies: { mockRestore(): void }[] = []
afterEach(() => { for (const spy of spies.splice(0)) spy.mockRestore() })

it('lists historical shell-only output in its owning turn without enabling code restoration', async () => {
  const messages: MessageEntry[] = [
    { id: 'first', type: 'user', timestamp: '', content: 'build board' },
    { id: 'call', type: 'assistant', timestamp: '', content: [{ type: 'tool_use', name: 'Bash', id: 'build', input: { command: 'python build.py' } }] },
    { id: 'result', type: 'tool_result', timestamp: '', content: [{ type: 'tool_result', tool_use_id: 'build', content: 'written: 看板/board.html (123 bytes)' }] },
    { id: 'second', type: 'user', timestamp: '', content: 'read only' },
    { id: 'done', type: 'assistant', timestamp: '', content: 'done' },
  ]
  spies.push(spyOn(sessionService, 'getSessionMessagesWithEvidence').mockResolvedValue({ messages, transcriptEvidenceComplete: true }))
  spies.push(spyOn(sessionService, 'getSessionFileHistorySnapshots').mockResolvedValue([]))
  spies.push(spyOn(sessionService, 'getSessionWorkDir').mockResolvedValue('G:/project'))
  spies.push(spyOn(sessionService, 'getSessionMessageCwd').mockResolvedValue('G:/project'))
  const checkpoints = await listSessionTurnCheckpoints('test-reported-output')
  expect(checkpoints).toHaveLength(1)
  expect(checkpoints[0]?.target.targetUserMessageId).toBe('first')
  expect(checkpoints[0]?.reportedFiles).toEqual(['G:/project/看板/board.html'])
  expect(checkpoints[0]?.code.filesChanged).toEqual([])
  expect(checkpoints[0]?.code.available).toBe(false)
  expect(checkpoints[0]?.restoreAvailable).toBe(false)
})
