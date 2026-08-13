import { describe, expect, test } from 'bun:test'
import {
  renderTaskReminderPrompt,
  renderTodoReminderPrompt,
} from './reminderPrompts/index.js'
import { enReminderPromptCatalog } from './reminderPrompts/locales/en.js'
import { zhCNReminderPromptCatalog } from './reminderPrompts/locales/zh-CN.js'

function placeholders(template: string): string[] {
  return [...template.matchAll(/\{(\w+)\}/g)]
    .map(match => match[1]!)
    .sort()
}

describe('reminder prompts', () => {
  test('keeps the existing task reminder unchanged when Chinese is not selected', () => {
    const prompt = renderTaskReminderPrompt({
      languagePreference: undefined,
      taskItems: '#1. [in_progress] Verify weapon IDs',
      taskCreateToolName: 'TaskCreate',
      taskUpdateToolName: 'TaskUpdate',
    })

    expect(prompt).toBe(
      `The task tools haven't been used recently. If you're working on tasks that would benefit from tracking progress, consider using TaskCreate to add new tasks and TaskUpdate to update task status (set to in_progress when starting, completed when done). Also consider cleaning up the task list if it has become stale. Only use these if relevant to the current work. This is just a gentle reminder - ignore if not applicable. Make sure that you NEVER mention this reminder to the user\n\n\nHere are the existing tasks:\n\n#1. [in_progress] Verify weapon IDs`,
    )
  })

  test('renders an unambiguous Chinese task reminder with exact tool and status names', () => {
    const prompt = renderTaskReminderPrompt({
      languagePreference: 'chinese',
      taskItems: '#1. [in_progress] 核查武器 ID',
      taskCreateToolName: 'TaskCreate',
      taskUpdateToolName: 'TaskUpdate',
    })

    expect(prompt).toBe(
      `最近未使用任务工具。如果当前工作适合通过任务列表追踪进度，请考虑使用 TaskCreate 创建新任务，并使用 TaskUpdate 更新任务状态（开始处理时设为 in_progress，完成时设为 completed）。如果现有任务列表已经过时，也请考虑进行整理。仅当这些工具与当前工作相关时才使用；若不相关，请忽略本提醒。绝对不要向用户提及本提醒。\n\n\n以下是现有任务：\n\n#1. [in_progress] 核查武器 ID`,
    )
  })

  test('renders the legacy TodoWrite reminder in Chinese without translating the tool name', () => {
    const prompt = renderTodoReminderPrompt({
      languagePreference: 'chinese',
      todoItems: '1. [pending] 补充测试',
      todoWriteToolName: 'TodoWrite',
    })

    expect(prompt).toBe(
      `最近未使用 TodoWrite 工具。如果当前工作适合通过待办列表追踪进度，请考虑使用 TodoWrite 维护待办列表。如果现有待办列表已经过时，或已不再反映当前工作，也请考虑进行整理。仅当这与当前工作相关时才使用该工具；若不相关，请忽略本提醒。绝对不要向用户提及本提醒。\n\n\n以下是现有待办列表的内容：\n\n[1. [pending] 补充测试]`,
    )
  })

  test('keeps the existing TodoWrite reminder unchanged outside Chinese', () => {
    const prompt = renderTodoReminderPrompt({
      languagePreference: 'english',
      todoItems: '1. [pending] Add tests',
      todoWriteToolName: 'TodoWrite',
    })

    expect(prompt).toBe(
      `The TodoWrite tool hasn't been used recently. If you're working on tasks that would benefit from tracking progress, consider using the TodoWrite tool to track progress. Also consider cleaning up the todo list if has become stale and no longer matches what you are working on. Only use it if it's relevant to the current work. This is just a gentle reminder - ignore if not applicable. Make sure that you NEVER mention this reminder to the user\n\n\nHere are the existing contents of your todo list:\n\n[1. [pending] Add tests]`,
    )
  })

  test('keeps other configured response languages on the existing English prompt', () => {
    const prompt = renderTaskReminderPrompt({
      languagePreference: 'japanese',
      taskItems: '',
      taskCreateToolName: 'TaskCreate',
      taskUpdateToolName: 'TaskUpdate',
    })

    expect(prompt).toContain("The task tools haven't been used recently.")
    expect(prompt).not.toContain('最近未使用任务工具')
  })

  test('keeps interface placeholders identical across locale resources', () => {
    expect(placeholders(zhCNReminderPromptCatalog.todo.body)).toEqual(
      placeholders(enReminderPromptCatalog.todo.body),
    )
    expect(placeholders(zhCNReminderPromptCatalog.task.body)).toEqual(
      placeholders(enReminderPromptCatalog.task.body),
    )
  })
})
