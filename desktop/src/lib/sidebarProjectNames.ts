export const PROJECT_NAMES_STORAGE_KEY = 'cc-haha-sidebar-project-names'

export function normalizeProjectNames(value: unknown): Record<string, string> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  return Object.fromEntries(Object.entries(value)
    .filter(([key, name]) => key.length > 0 && typeof name === 'string' && name.trim().length > 0)
    .slice(0, 2000)
    .map(([key, name]) => [key, (name as string).trim().slice(0, 80)]))
}

export function readProjectNames(): Record<string, string> {
  try {
    return normalizeProjectNames(JSON.parse(localStorage.getItem(PROJECT_NAMES_STORAGE_KEY) || '{}'))
  } catch {
    return {}
  }
}

export function cacheProjectNames(names: Record<string, string>): void {
  try {
    localStorage.setItem(PROJECT_NAMES_STORAGE_KEY, JSON.stringify(names))
  } catch {
    // The server remains the source of truth when browser storage is unavailable.
  }
}
