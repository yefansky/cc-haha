export type ReminderPromptCatalog = Readonly<{
  todo: Readonly<{
    body: string
    existingItemsHeading: string
  }>
  task: Readonly<{
    body: string
    existingItemsHeading: string
  }>
}>
