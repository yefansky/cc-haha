import { describe, expect, test } from 'bun:test'
import type { ContentBlockParam } from '@anthropic-ai/sdk/resources/index.mjs'
import type { AssistantMessage } from '../types/message.js'
import type { Attachment } from './attachments.js'
import {
  createAssistantMessage,
  createUserMessage,
  normalizeAttachmentForAPI,
  normalizeMessagesForAPI,
} from './messages.js'

function assistant(
  messageId: string,
  content: AssistantMessage['message']['content'],
): AssistantMessage {
  const message = createAssistantMessage({ content })
  message.message.id = messageId
  return message
}

function toolUse(id: string): AssistantMessage['message']['content'][number] {
  return {
    type: 'tool_use',
    id,
    name: 'Read',
    input: { file_path: `/tmp/${id}` },
  }
}

function toolResult(id: string) {
  return createUserMessage({
    content: [
      {
        type: 'tool_result',
        tool_use_id: id,
        content: 'ok',
      },
    ] as ContentBlockParam[],
  })
}

describe('normalizeMessagesForAPI assistant fragment indexing', () => {
  test('preserves a 10,000-step tool-result chain', () => {
    const messages = [createUserMessage({ content: 'start' })]

    for (let i = 0; i < 10_000; i++) {
      const toolId = `tool-${i}`
      messages.push(
        assistant(`response-${i}`, [toolUse(toolId)]),
        toolResult(toolId),
      )
    }

    const normalized = normalizeMessagesForAPI(messages)
    const assistants = normalized.filter(
      (message): message is AssistantMessage => message.type === 'assistant',
    )
    const toolResults = normalized.filter(message => message.type === 'user')

    expect(normalized).toHaveLength(20_001)
    expect(assistants).toHaveLength(10_000)
    expect(toolResults).toHaveLength(10_001)
    expect(assistants.at(-1)?.message.id).toBe('response-9999')
    expect(toolResults.at(-1)?.message.content).toEqual([
      {
        type: 'tool_result',
        tool_use_id: 'tool-9999',
        content: 'ok',
      },
    ])
  })

  test('merges interleaved response IDs across tool-result messages', () => {
    const normalized = normalizeMessagesForAPI([
      assistant('response-a', [toolUse('tool-a')]),
      toolResult('tool-a'),
      assistant('response-b', [toolUse('tool-b')]),
      toolResult('tool-b'),
      assistant('response-a', [{ type: 'text', text: 'A complete' }]),
      assistant('response-b', [{ type: 'text', text: 'B complete' }]),
    ])

    const assistants = normalized.filter(
      (message): message is AssistantMessage => message.type === 'assistant',
    )

    expect(assistants.map(message => message.message.id)).toEqual([
      'response-a',
      'response-b',
    ])
    expect(assistants[0]!.message.content.map(block => block.type)).toEqual([
      'tool_use',
      'text',
    ])
    expect(assistants[1]!.message.content.map(block => block.type)).toEqual([
      'tool_use',
      'text',
    ])
  })

  test('does not merge the same response ID across a normal user turn', () => {
    const normalized = normalizeMessagesForAPI([
      assistant('response-a', [{ type: 'text', text: 'before' }]),
      createUserMessage({ content: 'next turn' }),
      assistant('response-a', [{ type: 'text', text: 'after' }]),
    ])

    const assistants = normalized.filter(
      (message): message is AssistantMessage => message.type === 'assistant',
    )

    expect(assistants).toHaveLength(2)
    expect(
      assistants.map(message =>
        message.message.content
          .filter(block => block.type === 'text')
          .map(block => block.text)
          .join(''),
      ),
    ).toEqual(['before', 'after'])
  })
})

describe('normalizeAttachmentForAPI reminder language', () => {
  test('uses the Chinese task reminder only when the response language is Chinese', () => {
    const previous = process.env.CLAUDE_CODE_ENABLE_TASKS
    process.env.CLAUDE_CODE_ENABLE_TASKS = '1'
    try {
      const attachment: Attachment = {
        type: 'task_reminder',
        content: [
          {
            id: '1',
            subject: '核查武器 ID',
            description: '核对奖励配置',
            status: 'in_progress',
            blocks: [],
            blockedBy: [],
          },
        ],
        itemCount: 1,
      }

      const [message] = normalizeAttachmentForAPI(attachment, 'chinese')
      expect(message?.message.content).toBe(
        `<system-reminder>\n最近未使用任务工具。如果当前工作适合通过任务列表追踪进度，请考虑使用 TaskCreate 创建新任务，并使用 TaskUpdate 更新任务状态（开始处理时设为 in_progress，完成时设为 completed）。如果现有任务列表已经过时，也请考虑进行整理。仅当这些工具与当前工作相关时才使用；若不相关，请忽略本提醒。绝对不要向用户提及本提醒。\n\n\n以下是现有任务：\n\n#1. [in_progress] 核查武器 ID\n</system-reminder>`,
      )
    } finally {
      if (previous === undefined) delete process.env.CLAUDE_CODE_ENABLE_TASKS
      else process.env.CLAUDE_CODE_ENABLE_TASKS = previous
    }
  })
})
