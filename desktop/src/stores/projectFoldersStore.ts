import { create } from 'zustand'

export interface ProjectFolder {
  path: string
  label: string
}
export interface ProjectFolders {
  mountedRoots: ProjectFolder[]
  pinnedFolders: ProjectFolder[]
  showHiddenFolders: boolean
}
export const EMPTY_PROJECT_FOLDERS: ProjectFolders = { mountedRoots: [], pinnedFolders: [], showHiddenFolders: false }
export const PROJECT_FOLDERS_STORAGE_KEY = 'cc-haha-project-folders'
const LEGACY_STORAGE_KEY = 'cc-haha-workspace-mounted-roots'
type FolderStorage = Pick<Storage, 'getItem' | 'setItem'>
interface PersistedState {
  version: 1
  projects: Record<string, ProjectFolders>
  legacyClaimedBy?: string
}
interface ProjectFoldersStore extends PersistedState {
  initializeProject: (projectPath: string) => boolean
  addMountedRoot: (projectPath: string, path: string) => boolean
  removeMountedRoot: (projectPath: string, path: string) => boolean
  pinFolder: (projectPath: string, path: string) => boolean
  unpinFolder: (projectPath: string, path: string) => boolean
  setShowHiddenFolders: (projectPath: string, show: boolean) => boolean
}

function normalizeAbsolutePath(value: string): string {
  if (typeof value !== 'string' || /[\u0000-\u001f]/.test(value)) return ''
  const path = value.trim().replace(/\\/g, '/')
  const drive = /^[A-Za-z]:\//.test(path)
  const unc = path.startsWith('//')
  if (!drive && !path.startsWith('/')) return ''
  const parts = path.slice(drive ? 3 : unc ? 2 : 1).split('/').filter(Boolean)
  const minimum = unc ? 2 : 0
  if (unc && (parts.length < 2 || parts.slice(0, 2).some(part => part === '.' || part === '..' || part.includes(':')))) return ''
  const resolved: string[] = []
  for (const part of parts) {
    if (part === '.') continue
    if (part === '..') {
      if (resolved.length <= minimum) return ''
      resolved.pop()
    } else {
      if ((drive || unc) && /[:*?"<>|]/.test(part)) return ''
      resolved.push(part)
    }
  }
  return `${drive ? path.slice(0, 3) : unc ? '//' : '/'}${resolved.join('/')}`
}

export function normalizeProjectFolderKey(path: string): string {
  const normalized = normalizeAbsolutePath(path)
  return /^[A-Za-z]:\//.test(normalized) || normalized.startsWith('//') ? normalized.toLowerCase() : normalized
}

function folder(path: string): ProjectFolder {
  return { path, label: path.split('/').filter(Boolean).at(-1) ?? path }
}

function inside(path: string, root: string): boolean {
  const key = normalizeProjectFolderKey(path)
  const rootKey = normalizeProjectFolderKey(root)
  return !!key && !!rootKey && (key === rootKey || key.startsWith(`${rootKey.replace(/\/$/, '')}/`))
}

function readFolders(value: unknown): ProjectFolder[] {
  if (!Array.isArray(value)) return []
  const result: ProjectFolder[] = []
  for (const entry of value) {
    const path = normalizeAbsolutePath(typeof entry === 'string' ? entry : entry?.path)
    if (path && !result.some(item => normalizeProjectFolderKey(item.path) === normalizeProjectFolderKey(path))) {
      const label = typeof entry?.label === 'string' ? entry.label.trim() : ''
      result.push({ path, label: label || folder(path).label })
    }
  }
  return result
}

function defaultStorage(): FolderStorage | undefined {
  try { return typeof localStorage === 'undefined' ? undefined : localStorage } catch { return undefined }
}

export function readProjectFoldersState(storage = defaultStorage()): PersistedState {
  const result: PersistedState = { version: 1, projects: {} }
  try {
    const saved = JSON.parse(storage?.getItem(PROJECT_FOLDERS_STORAGE_KEY) ?? 'null')
    if (saved?.version !== 1 || !saved.projects || typeof saved.projects !== 'object') return result
    if (typeof saved.legacyClaimedBy === 'string') result.legacyClaimedBy = saved.legacyClaimedBy
    for (const [rawKey, rawValue] of Object.entries(saved.projects)) {
      const key = normalizeProjectFolderKey(rawKey)
      if (!key || !rawValue || typeof rawValue !== 'object') continue
      const value = rawValue as Partial<ProjectFolders>
      const mountedRoots = readFolders(value.mountedRoots)
      result.projects[key] = {
        mountedRoots,
        pinnedFolders: readFolders(value.pinnedFolders).filter(item => inside(item.path, key) || mountedRoots.some(root => inside(item.path, root.path))),
        showHiddenFolders: value.showHiddenFolders === true,
      }
    }
  } catch { /* Corrupt or unavailable storage must not prevent browsing. */ }
  return result
}

export function createProjectFoldersStore(storage = defaultStorage()) {
  return create<ProjectFoldersStore>((set, get) => {
    const save = (state: PersistedState) => {
      set(state)
      try { storage?.setItem(PROJECT_FOLDERS_STORAGE_KEY, JSON.stringify({ version: 1, projects: state.projects, legacyClaimedBy: state.legacyClaimedBy })) } catch { /* Continue with in-memory preferences. */ }
    }
    const update = (projectPath: string, change: (current: ProjectFolders, key: string) => ProjectFolders | null) => {
      const key = normalizeProjectFolderKey(projectPath)
      if (!key) return false
      const state = get()
      const next = change(state.projects[key] ?? EMPTY_PROJECT_FOLDERS, key)
      if (!next) return false
      save({ version: 1, projects: { ...state.projects, [key]: next }, legacyClaimedBy: state.legacyClaimedBy })
      return true
    }
    return {
      ...readProjectFoldersState(storage),
      initializeProject: (projectPath) => {
        const key = normalizeProjectFolderKey(projectPath)
        if (!key) return false
        const state = get()
        if (state.projects[key] && state.legacyClaimedBy) return false
        let legacy: ProjectFolder[] = []
        if (!state.legacyClaimedBy) {
          try { legacy = readFolders(JSON.parse(storage?.getItem(LEGACY_STORAGE_KEY) ?? '[]')) } catch { /* Keep legacy data untouched for recovery. */ }
        }
        const current = state.projects[key] ?? EMPTY_PROJECT_FOLDERS
        const mountedRoots = readFolders([...current.mountedRoots, ...legacy]).filter(root => normalizeProjectFolderKey(root.path) !== key)
        save({ version: 1, projects: { ...state.projects, [key]: { ...current, mountedRoots } }, legacyClaimedBy: state.legacyClaimedBy ?? key })
        return true
      },
      addMountedRoot: (projectPath, input) => update(projectPath, (current, key) => {
        const path = normalizeAbsolutePath(input)
        if (!path || normalizeProjectFolderKey(path) === key || current.mountedRoots.some(root => normalizeProjectFolderKey(root.path) === normalizeProjectFolderKey(path))) return null
        return { ...current, mountedRoots: [...current.mountedRoots, folder(path)] }
      }),
      removeMountedRoot: (projectPath, path) => update(projectPath, current => {
        const mountedRoots = current.mountedRoots.filter(root => normalizeProjectFolderKey(root.path) !== normalizeProjectFolderKey(path))
        if (mountedRoots.length === current.mountedRoots.length) return null
        return { ...current, mountedRoots, pinnedFolders: current.pinnedFolders.filter(item => !inside(item.path, path)) }
      }),
      pinFolder: (projectPath, input) => update(projectPath, (current, key) => {
        const path = normalizeAbsolutePath(input)
        if (!path || (!inside(path, key) && !current.mountedRoots.some(root => inside(path, root.path))) || current.pinnedFolders.some(item => normalizeProjectFolderKey(item.path) === normalizeProjectFolderKey(path))) return null
        return { ...current, pinnedFolders: [...current.pinnedFolders, folder(path)] }
      }),
      unpinFolder: (projectPath, path) => update(projectPath, current => {
        const pinnedFolders = current.pinnedFolders.filter(item => normalizeProjectFolderKey(item.path) !== normalizeProjectFolderKey(path))
        return pinnedFolders.length === current.pinnedFolders.length ? null : { ...current, pinnedFolders }
      }),
      setShowHiddenFolders: (projectPath, showHiddenFolders) => update(projectPath, current => ({ ...current, showHiddenFolders })),
    }
  })
}

export const useProjectFoldersStore = createProjectFoldersStore()
