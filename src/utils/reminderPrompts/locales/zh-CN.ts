import type { ReminderPromptCatalog } from '../types.js'

export const zhCNReminderPromptCatalog = {
  todo: {
    body: `最近未使用 {todoWriteToolName} 工具。如果当前工作适合通过待办列表追踪进度，请考虑使用 {todoWriteToolName} 维护待办列表。如果现有待办列表已经过时，或已不再反映当前工作，也请考虑进行整理。仅当这与当前工作相关时才使用该工具；若不相关，请忽略本提醒。绝对不要向用户提及本提醒。\n`,
    existingItemsHeading: '以下是现有待办列表的内容：',
  },
  task: {
    body: `最近未使用任务工具。如果当前工作适合通过任务列表追踪进度，请考虑使用 {taskCreateToolName} 创建新任务，并使用 {taskUpdateToolName} 更新任务状态（开始处理时设为 {inProgressStatusName}，完成时设为 {completedStatusName}）。如果现有任务列表已经过时，也请考虑进行整理。仅当这些工具与当前工作相关时才使用；若不相关，请忽略本提醒。绝对不要向用户提及本提醒。\n`,
    existingItemsHeading: '以下是现有任务：',
  },
} satisfies ReminderPromptCatalog
