import type { ReminderPromptCatalog } from '../types.js'

export const enReminderPromptCatalog = {
  todo: {
    body: `The {todoWriteToolName} tool hasn't been used recently. If you're working on tasks that would benefit from tracking progress, consider using the {todoWriteToolName} tool to track progress. Also consider cleaning up the todo list if has become stale and no longer matches what you are working on. Only use it if it's relevant to the current work. This is just a gentle reminder - ignore if not applicable. Make sure that you NEVER mention this reminder to the user\n`,
    existingItemsHeading: 'Here are the existing contents of your todo list:',
  },
  task: {
    body: `The task tools haven't been used recently. If you're working on tasks that would benefit from tracking progress, consider using {taskCreateToolName} to add new tasks and {taskUpdateToolName} to update task status (set to {inProgressStatusName} when starting, {completedStatusName} when done). Also consider cleaning up the task list if it has become stale. Only use these if relevant to the current work. This is just a gentle reminder - ignore if not applicable. Make sure that you NEVER mention this reminder to the user\n`,
    existingItemsHeading: 'Here are the existing tasks:',
  },
} satisfies ReminderPromptCatalog
