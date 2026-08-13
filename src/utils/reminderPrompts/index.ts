import { enReminderPromptCatalog } from './locales/en.js'
import { zhCNReminderPromptCatalog } from './locales/zh-CN.js'
import type { ReminderPromptCatalog } from './types.js'

type TodoReminderPromptOptions = {
  languagePreference: string | undefined
  todoItems: string
  todoWriteToolName: string
}

type TaskReminderPromptOptions = {
  languagePreference: string | undefined
  taskItems: string
  taskCreateToolName: string
  taskUpdateToolName: string
}

const IN_PROGRESS_STATUS_NAME = 'in_progress'
const COMPLETED_STATUS_NAME = 'completed'

function getCatalog(
  languagePreference: string | undefined,
): ReminderPromptCatalog {
  return languagePreference === 'chinese'
    ? zhCNReminderPromptCatalog
    : enReminderPromptCatalog
}

function interpolate(
  template: string,
  values: Readonly<Record<string, string>>,
): string {
  return template.replace(/\{(\w+)\}/g, (placeholder, key: string) =>
    Object.hasOwn(values, key) ? values[key]! : placeholder,
  )
}

export function renderTodoReminderPrompt({
  languagePreference,
  todoItems,
  todoWriteToolName,
}: TodoReminderPromptOptions): string {
  const prompt = getCatalog(languagePreference).todo
  let message = interpolate(prompt.body, { todoWriteToolName })
  if (todoItems.length > 0) {
    message += `\n\n${prompt.existingItemsHeading}\n\n[${todoItems}]`
  }
  return message
}

export function renderTaskReminderPrompt({
  languagePreference,
  taskItems,
  taskCreateToolName,
  taskUpdateToolName,
}: TaskReminderPromptOptions): string {
  const prompt = getCatalog(languagePreference).task
  let message = interpolate(prompt.body, {
    taskCreateToolName,
    taskUpdateToolName,
    inProgressStatusName: IN_PROGRESS_STATUS_NAME,
    completedStatusName: COMPLETED_STATUS_NAME,
  })
  if (taskItems.length > 0) {
    message += `\n\n${prompt.existingItemsHeading}\n\n${taskItems}`
  }
  return message
}
