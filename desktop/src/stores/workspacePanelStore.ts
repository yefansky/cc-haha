import { create } from 'zustand'
import {
  sessionsApi,
  type WorkspaceDiffResult,
  type WorkspaceReadFileResult,
  type WorkspaceStatusResult,
  type WorkspaceTreeResult,
} from '../api/sessions'

export const WORKSPACE_PANEL_DEFAULT_WIDTH = 860
export const WORKSPACE_PANEL_MIN_WIDTH = 420
export const WORKSPACE_PANEL_MAX_WIDTH = 1120

export type WorkspacePanelView = 'changed' | 'all'
export type WorkbenchMode = 'workspace' | 'browser' | 'context-audit' | 'review'
export type WorkspacePreviewKind = 'file' | 'diff'
export type WorkspacePreviewCloseScope = 'current' | 'others' | 'left' | 'right' | 'all'
export type WorkspaceDiffSource =
  | { kind: 'workspace' }
  | {
      kind: 'turn'
      targetUserMessageId: string
      userMessageIndex: number
    }
export type WorkspacePanelOrigin = {
  sourceTurnKey: string
  sourceElementId: string
}
export type WorkspacePreviewState =
  | 'loading'
  | WorkspaceReadFileResult['state']
  | WorkspaceDiffResult['state']

export type WorkspacePreviewTab = {
  id: string
  path: string
  kind: WorkspacePreviewKind
  title: string
  language?: string
  content?: string
  dataUrl?: string
  mimeType?: string
  previewType?: 'text' | 'image'
  diff?: string
  diffSource?: WorkspaceDiffSource
  state?: WorkspacePreviewState
  error?: string
  size?: number
}

export type WorkspaceMountedRoot = {
  path: string
  label: string
}

export type WorkspacePanelSessionState = {
  isOpen: boolean
  activeView: WorkspacePanelView
  hasUserSelectedView?: boolean
}

type WorkspaceStatusCacheEntry = {
  result: WorkspaceStatusResult
  loadedAt: number
}

type WorkspacePanelLoadingState = {
  statusBySession: Record<string, boolean | undefined>
  treeBySessionPath: Record<string, boolean | undefined>
  previewByTabId: Record<string, boolean | undefined>
}

type WorkspacePanelErrorState = {
  statusBySession: Record<string, string | null | undefined>
  treeBySessionPath: Record<string, string | null | undefined>
  previewByTabId: Record<string, string | null | undefined>
  previewRefreshStateByTabId: Record<string, WorkspacePreviewState | null | undefined>
}

type WorkspacePanelStore = {
  panelBySession: Record<string, WorkspacePanelSessionState | undefined>
  modeBySession: Record<string, WorkbenchMode | undefined>
  width: number
  statusBySession: Record<string, WorkspaceStatusResult | undefined>
  statusCacheByWorkDir: Record<string, WorkspaceStatusCacheEntry | undefined>
  workDirKeyBySession: Record<string, string | undefined>
  expandedPathsBySession: Record<string, string[] | undefined>
  treeBySessionPath: Record<string, Record<string, WorkspaceTreeResult | undefined> | undefined>
  previewTabsBySession: Record<string, WorkspacePreviewTab[] | undefined>
  activePreviewTabIdBySession: Record<string, string | null | undefined>
  originBySession: Record<string, WorkspacePanelOrigin | undefined>
  mountedRoots: WorkspaceMountedRoot[]
  loading: WorkspacePanelLoadingState
  errors: WorkspacePanelErrorState

  isPanelOpen: (sessionId: string) => boolean
  getActiveView: (sessionId: string) => WorkspacePanelView
  getMode: (sessionId: string) => WorkbenchMode
  getOrigin: (sessionId: string) => WorkspacePanelOrigin | null
  clearOrigin: (sessionId: string) => void
  setMode: (sessionId: string, mode: WorkbenchMode) => void
  openPanel: (sessionId: string) => void
  closePanel: (sessionId: string) => void
  togglePanel: (sessionId: string) => void
  setWidth: (width: number) => void
  setActiveView: (sessionId: string, view: WorkspacePanelView) => void
  addMountedRoot: (path: string) => void
  removeMountedRoot: (path: string) => void
  registerSessionWorkDir: (sessionId: string, workDir?: string) => void
  loadStatus: (sessionId: string, options?: { force?: boolean }) => Promise<void>
  preloadStatus: (sessionId: string) => void
  loadTree: (sessionId: string, path?: string) => Promise<void>
  toggleTreeNode: (sessionId: string, path: string) => Promise<void>
  openPreview: (
    sessionId: string,
    path: string,
    kind: WorkspacePreviewKind,
    origin?: WorkspacePanelOrigin,
    diffSource?: WorkspaceDiffSource,
  ) => Promise<void>
  closePreview: (sessionId: string, tabId: string) => void
  closePreviewTabs: (sessionId: string, tabId: string, scope: WorkspacePreviewCloseScope) => void
  clearSession: (sessionId: string) => void
  resetSessionUi: (sessionId: string) => void
}

const DEFAULT_PANEL_STATE: WorkspacePanelSessionState = {
  isOpen: false,
  activeView: 'changed',
}

const DEFAULT_WORKBENCH_MODE: WorkbenchMode = 'workspace'
const WORKSPACE_MOUNTS_STORAGE_KEY = 'cc-haha-workspace-mounted-roots'

function mountedRootLabel(value: string): string {
  const normalized = value.replace(/[\\/]+$/, '')
  const parts = normalized.split(/[\\/]/).filter(Boolean)
  return parts[parts.length - 1] ?? value
}

function readMountedRoots(): WorkspaceMountedRoot[] {
  if (typeof localStorage === 'undefined') return []
  try {
    const parsed = JSON.parse(localStorage.getItem(WORKSPACE_MOUNTS_STORAGE_KEY) ?? '[]') as unknown
    if (!Array.isArray(parsed)) return []
    const seen = new Set<string>()
    return parsed.flatMap((item) => {
      if (!item || typeof item !== 'object' || typeof (item as WorkspaceMountedRoot).path !== 'string') return []
      const path = (item as WorkspaceMountedRoot).path.trim()
      if (!path || seen.has(path.toLowerCase())) return []
      seen.add(path.toLowerCase())
      return [{ path, label: typeof (item as WorkspaceMountedRoot).label === 'string' && (item as WorkspaceMountedRoot).label.trim() ? (item as WorkspaceMountedRoot).label : mountedRootLabel(path) }]
    })
  } catch {
    return []
  }
}

function persistMountedRoots(roots: WorkspaceMountedRoot[]): void {
  try { localStorage.setItem(WORKSPACE_MOUNTS_STORAGE_KEY, JSON.stringify(roots)) } catch { /* local storage unavailable */ }
}

const statusRequestIds = new Map<string, number>()
const treeRequestIds = new Map<string, number>()
const previewRequestIds = new Map<string, number>()
const WORKSPACE_STATUS_CACHE_TTL_MS = 15_000

function getWorkDirCacheKey(workDir: string) {
  return workDir.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
}

function nextRequestId(store: Map<string, number>, key: string) {
  const requestId = (store.get(key) ?? 0) + 1
  store.set(key, requestId)
  return requestId
}

function invalidateRequest(store: Map<string, number>, key: string) {
  store.set(key, (store.get(key) ?? 0) + 1)
}

function isLatestRequest(store: Map<string, number>, key: string, requestId: number) {
  return store.get(key) === requestId
}

export function clampWorkspacePanelWidth(width: number) {
  if (!Number.isFinite(width)) return WORKSPACE_PANEL_DEFAULT_WIDTH
  const rounded = Math.round(width)
  return Math.min(WORKSPACE_PANEL_MAX_WIDTH, Math.max(WORKSPACE_PANEL_MIN_WIDTH, rounded))
}

function getSessionPanelState(
  panelBySession: Record<string, WorkspacePanelSessionState | undefined>,
  sessionId: string,
) {
  return panelBySession[sessionId] ?? DEFAULT_PANEL_STATE
}

function makeTreeKey(sessionId: string, path: string) {
  return `${sessionId}::${path}`
}

export function getWorkspacePreviewTabId(
  path: string,
  kind: WorkspacePreviewKind,
  diffSource: WorkspaceDiffSource = { kind: 'workspace' },
) {
  if (kind !== 'diff' || diffSource.kind === 'workspace') return `${kind}:${path}`
  return `${kind}:${path}:turn:${diffSource.targetUserMessageId}`
}

function makePreviewKey(sessionId: string, tabId: string) {
  return `${sessionId}::${tabId}`
}

function getPathTitle(path: string) {
  if (!path) return 'Workspace'
  const segments = path.split('/').filter(Boolean)
  return segments[segments.length - 1] ?? path
}

function stripSessionKeys<T>(record: Record<string, T>, sessionId: string) {
  const prefix = `${sessionId}::`
  return Object.fromEntries(
    Object.entries(record).filter(([key]) => !key.startsWith(prefix)),
  ) as Record<string, T>
}

function removeRecordKey<T>(record: Record<string, T>, key: string) {
  if (!(key in record)) return record
  const { [key]: _removed, ...rest } = record
  return rest
}

function removeRecordKeys<T>(record: Record<string, T>, keys: string[]) {
  let next = record
  for (const key of keys) {
    next = removeRecordKey(next, key)
  }
  return next
}

function invalidateSessionScopedRequests(store: Map<string, number>, sessionId: string) {
  const prefix = `${sessionId}::`
  for (const key of store.keys()) {
    if (key.startsWith(prefix)) {
      invalidateRequest(store, key)
    }
  }
}

function upsertPreviewTab(
  tabs: WorkspacePreviewTab[],
  tabId: string,
  update: WorkspacePreviewTab | ((current: WorkspacePreviewTab) => WorkspacePreviewTab),
) {
  const index = tabs.findIndex((tab) => tab.id === tabId)
  if (index < 0) return tabs

  const current = tabs[index]!
  const next = typeof update === 'function' ? update(current) : update
  const nextTabs = [...tabs]
  nextTabs[index] = next
  return nextTabs
}

export const useWorkspacePanelStore = create<WorkspacePanelStore>((set, get) => ({
  panelBySession: {},
  modeBySession: {},
  width: WORKSPACE_PANEL_DEFAULT_WIDTH,
  statusBySession: {},
  statusCacheByWorkDir: {},
  workDirKeyBySession: {},
  expandedPathsBySession: {},
  treeBySessionPath: {},
  previewTabsBySession: {},
  activePreviewTabIdBySession: {},
  originBySession: {},
  mountedRoots: readMountedRoots(),
  loading: {
    statusBySession: {},
    treeBySessionPath: {},
    previewByTabId: {},
  },
  errors: {
    statusBySession: {},
    treeBySessionPath: {},
    previewByTabId: {},
    previewRefreshStateByTabId: {},
  },

  isPanelOpen: (sessionId) => getSessionPanelState(get().panelBySession, sessionId).isOpen,
  getActiveView: (sessionId) => getSessionPanelState(get().panelBySession, sessionId).activeView,
  getMode: (sessionId) => get().modeBySession[sessionId] ?? DEFAULT_WORKBENCH_MODE,
  getOrigin: (sessionId) => get().originBySession[sessionId] ?? null,
  clearOrigin: (sessionId) => set((state) => ({
    originBySession: removeRecordKey(state.originBySession, sessionId),
  })),

  setMode: (sessionId, mode) =>
    set((state) => ({
      modeBySession: {
        ...state.modeBySession,
        [sessionId]: mode,
      },
    })),

  openPanel: (sessionId) =>
    set((state) => ({
      panelBySession: {
        ...state.panelBySession,
        [sessionId]: {
          ...getSessionPanelState(state.panelBySession, sessionId),
          isOpen: true,
        },
      },
    })),

  closePanel: (sessionId) =>
    set((state) => ({
      panelBySession: {
        ...state.panelBySession,
        [sessionId]: {
          ...getSessionPanelState(state.panelBySession, sessionId),
          isOpen: false,
        },
      },
    })),

  togglePanel: (sessionId) =>
    set((state) => {
      const panel = getSessionPanelState(state.panelBySession, sessionId)
      return {
        panelBySession: {
          ...state.panelBySession,
          [sessionId]: {
            ...panel,
            isOpen: !panel.isOpen,
          },
        },
      }
    }),

  setWidth: (width) => set({ width: clampWorkspacePanelWidth(width) }),

  setActiveView: (sessionId, view) =>
    set((state) => ({
      panelBySession: {
        ...state.panelBySession,
        [sessionId]: {
          ...getSessionPanelState(state.panelBySession, sessionId),
          activeView: view,
          hasUserSelectedView: true,
        },
      },
    })),

  addMountedRoot: (path) => set((state) => {
    const normalized = path.trim()
    if (!normalized || state.mountedRoots.some((root) => root.path.toLowerCase() === normalized.toLowerCase())) return state
    const mountedRoots = [...state.mountedRoots, { path: normalized, label: mountedRootLabel(normalized) }]
    persistMountedRoots(mountedRoots)
    return { mountedRoots }
  }),

  removeMountedRoot: (path) => set((state) => {
    const mountedRoots = state.mountedRoots.filter((root) => root.path !== path)
    persistMountedRoots(mountedRoots)
    return { mountedRoots }
  }),

  registerSessionWorkDir: (sessionId, workDir) => {
    if (!workDir?.trim()) return
    const workDirKey = getWorkDirCacheKey(workDir)
    set((state) => ({
      workDirKeyBySession: {
        ...state.workDirKeyBySession,
        [sessionId]: workDirKey,
      },
    }))
  },

  loadStatus: async (sessionId, options) => {
    const requestId = nextRequestId(statusRequestIds, sessionId)
    const knownWorkDirKey = get().workDirKeyBySession[sessionId]
    const cached = knownWorkDirKey ? get().statusCacheByWorkDir[knownWorkDirKey] : undefined

    // A session's normal reload remains a real refresh. The cache is for a
    // different session that happens to point at the same checkout.
    if (!options?.force && !get().statusBySession[sessionId] && cached && Date.now() - cached.loadedAt < WORKSPACE_STATUS_CACHE_TTL_MS) {
      set((state) => ({
        statusBySession: { ...state.statusBySession, [sessionId]: cached.result },
        loading: {
          ...state.loading,
          statusBySession: { ...state.loading.statusBySession, [sessionId]: false },
        },
        errors: {
          ...state.errors,
          statusBySession: { ...state.errors.statusBySession, [sessionId]: cached.result.error ?? null },
        },
      }))
      return
    }

    set((state) => ({
      loading: {
        ...state.loading,
        statusBySession: {
          ...state.loading.statusBySession,
          [sessionId]: true,
        },
      },
      errors: {
        ...state.errors,
        statusBySession: {
          ...state.errors.statusBySession,
          [sessionId]: null,
        },
      },
    }))

    try {
      const result = await sessionsApi.getWorkspaceStatus(sessionId)
      if (!isLatestRequest(statusRequestIds, sessionId, requestId)) return

      set((state) => {
        const panel = getSessionPanelState(state.panelBySession, sessionId)
        const nextActiveView =
          !panel.hasUserSelectedView && result.state === 'ok'
            ? result.changedFiles.length > 0 ? 'changed' : 'all'
            : panel.activeView

        const workDirKey = getWorkDirCacheKey(result.workDir)
        return {
          panelBySession: {
            ...state.panelBySession,
            [sessionId]: {
              ...panel,
              activeView: nextActiveView,
            },
          },
          statusBySession: {
            ...state.statusBySession,
            [sessionId]: result,
          },
          statusCacheByWorkDir: {
            ...state.statusCacheByWorkDir,
            [workDirKey]: { result, loadedAt: Date.now() },
          },
          workDirKeyBySession: {
            ...state.workDirKeyBySession,
            [sessionId]: workDirKey,
          },
          loading: {
            ...state.loading,
            statusBySession: {
              ...state.loading.statusBySession,
              [sessionId]: false,
            },
          },
          errors: {
            ...state.errors,
            statusBySession: {
              ...state.errors.statusBySession,
              [sessionId]: result.error ?? null,
            },
          },
        }
      })
    } catch (error) {
      if (!isLatestRequest(statusRequestIds, sessionId, requestId)) return

      set((state) => ({
        loading: {
          ...state.loading,
          statusBySession: {
            ...state.loading.statusBySession,
            [sessionId]: false,
          },
        },
        errors: {
          ...state.errors,
          statusBySession: {
            ...state.errors.statusBySession,
            [sessionId]: error instanceof Error ? error.message : 'Failed to load workspace status',
          },
        },
      }))
    }
  },

  preloadStatus: (sessionId) => {
    void get().loadStatus(sessionId)
  },

  loadTree: async (sessionId, path = '') => {
    const treeKey = makeTreeKey(sessionId, path)
    const requestId = nextRequestId(treeRequestIds, treeKey)

    set((state) => ({
      loading: {
        ...state.loading,
        treeBySessionPath: {
          ...state.loading.treeBySessionPath,
          [treeKey]: true,
        },
      },
      errors: {
        ...state.errors,
        treeBySessionPath: {
          ...state.errors.treeBySessionPath,
          [treeKey]: null,
        },
      },
    }))

    try {
      const result = await sessionsApi.getWorkspaceTree(sessionId, path)
      if (!isLatestRequest(treeRequestIds, treeKey, requestId)) return

      set((state) => ({
        treeBySessionPath: {
          ...state.treeBySessionPath,
          [sessionId]: {
            ...state.treeBySessionPath[sessionId],
            [path]: result,
          },
        },
        loading: {
          ...state.loading,
          treeBySessionPath: {
            ...state.loading.treeBySessionPath,
            [treeKey]: false,
          },
        },
        errors: {
          ...state.errors,
          treeBySessionPath: {
            ...state.errors.treeBySessionPath,
            [treeKey]: result.error ?? null,
          },
        },
      }))
    } catch (error) {
      if (!isLatestRequest(treeRequestIds, treeKey, requestId)) return

      set((state) => ({
        loading: {
          ...state.loading,
          treeBySessionPath: {
            ...state.loading.treeBySessionPath,
            [treeKey]: false,
          },
        },
        errors: {
          ...state.errors,
          treeBySessionPath: {
            ...state.errors.treeBySessionPath,
            [treeKey]: error instanceof Error ? error.message : 'Failed to load workspace tree',
          },
        },
      }))
    }
  },

  toggleTreeNode: async (sessionId, path) => {
    let shouldLoad = false

    set((state) => {
      const expanded = new Set(state.expandedPathsBySession[sessionId] ?? [])
      if (expanded.has(path)) {
        expanded.delete(path)
      } else {
        expanded.add(path)
        if (!state.treeBySessionPath[sessionId]?.[path]) {
          shouldLoad = true
        }
      }

      return {
        expandedPathsBySession: {
          ...state.expandedPathsBySession,
          [sessionId]: [...expanded],
        },
      }
    })

    if (shouldLoad) {
      await get().loadTree(sessionId, path)
    }
  },

  openPreview: async (sessionId, path, kind, origin, diffSource = { kind: 'workspace' }) => {
    // Ensure the workspace panel is visible — openPreview is now triggered from places
    // where the panel may be closed (e.g. the chat "打开方式" menu / turn-changes card),
    // not only from inside the already-open file tree. Opening a file always switches the
    // unified workbench into file ("workspace") mode.
    get().openPanel(sessionId)
    get().setMode(sessionId, 'workspace')
    if (origin) {
      set((state) => ({
        originBySession: {
          ...state.originBySession,
          [sessionId]: origin,
        },
      }))
    }
    const tabId = getWorkspacePreviewTabId(path, kind, diffSource)
    const requestKey = makePreviewKey(sessionId, tabId)
    const existing = get().previewTabsBySession[sessionId]?.find((tab) => tab.id === tabId)

    const requestId = nextRequestId(previewRequestIds, requestKey)

    if (existing) {
      set((state) => ({
        activePreviewTabIdBySession: {
          ...state.activePreviewTabIdBySession,
          [sessionId]: tabId,
        },
        loading: {
          ...state.loading,
          previewByTabId: {
            ...state.loading.previewByTabId,
            [requestKey]: true,
          },
        },
        errors: {
          ...state.errors,
          previewByTabId: {
            ...state.errors.previewByTabId,
            [requestKey]: null,
          },
          previewRefreshStateByTabId: {
            ...state.errors.previewRefreshStateByTabId,
            [requestKey]: null,
          },
        },
      }))
    } else {
      const baseTab: WorkspacePreviewTab = {
        id: tabId,
        path,
        kind,
        title: getPathTitle(path),
        ...(kind === 'diff' ? { diffSource } : {}),
        state: 'loading',
      }

      set((state) => ({
        previewTabsBySession: {
          ...state.previewTabsBySession,
          [sessionId]: [...(state.previewTabsBySession[sessionId] ?? []), baseTab],
        },
        activePreviewTabIdBySession: {
          ...state.activePreviewTabIdBySession,
          [sessionId]: tabId,
        },
        loading: {
          ...state.loading,
          previewByTabId: {
            ...state.loading.previewByTabId,
            [requestKey]: true,
          },
        },
        errors: {
          ...state.errors,
          previewByTabId: {
            ...state.errors.previewByTabId,
            [requestKey]: null,
          },
          previewRefreshStateByTabId: {
            ...state.errors.previewRefreshStateByTabId,
            [requestKey]: null,
          },
        },
      }))
    }

    try {
      if (kind === 'diff') {
        const result = diffSource.kind === 'turn'
          ? await sessionsApi.getTurnCheckpointDiff(
              sessionId,
              diffSource.targetUserMessageId,
              path,
              diffSource.userMessageIndex,
            )
          : await sessionsApi.getWorkspaceDiff(sessionId, path)
        if (!isLatestRequest(previewRequestIds, requestKey, requestId)) return
        if (!get().previewTabsBySession[sessionId]?.some((tab) => tab.id === tabId)) return

        set((state) => {
          const tabs = state.previewTabsBySession[sessionId] ?? []
          const current = tabs.find((tab) => tab.id === tabId)
          const preserveSuccessfulPayload = current?.state === 'ok' && result.state !== 'ok'
          return {
            previewTabsBySession: {
              ...state.previewTabsBySession,
              [sessionId]: preserveSuccessfulPayload
                ? tabs
                : upsertPreviewTab(tabs, tabId, (tab) => ({
                    ...tab,
                    diff: result.diff ?? '',
                    diffSource,
                    content: undefined,
                    language: undefined,
                    size: undefined,
                    state: result.state,
                    error: result.error,
                  })),
            },
            loading: {
              ...state.loading,
              previewByTabId: {
                ...state.loading.previewByTabId,
                [requestKey]: false,
              },
            },
            errors: {
              ...state.errors,
              previewByTabId: {
                ...state.errors.previewByTabId,
                [requestKey]: result.error ?? null,
              },
              previewRefreshStateByTabId: {
                ...state.errors.previewRefreshStateByTabId,
                [requestKey]: preserveSuccessfulPayload ? result.state : null,
              },
            },
          }
        })
        return
      }

      const result = await sessionsApi.getWorkspaceFile(sessionId, path)
      if (!isLatestRequest(previewRequestIds, requestKey, requestId)) return
      if (!get().previewTabsBySession[sessionId]?.some((tab) => tab.id === tabId)) return

      set((state) => {
        const tabs = state.previewTabsBySession[sessionId] ?? []
        const current = tabs.find((tab) => tab.id === tabId)
        const preserveSuccessfulPayload = current?.state === 'ok' && result.state !== 'ok'
        return {
          previewTabsBySession: {
            ...state.previewTabsBySession,
            [sessionId]: preserveSuccessfulPayload
              ? tabs
              : upsertPreviewTab(tabs, tabId, (tab) => ({
                  ...tab,
                  content: result.content,
                  dataUrl: result.dataUrl,
                  mimeType: result.mimeType,
                  previewType: result.previewType ?? 'text',
                  diff: undefined,
                  language: result.language,
                  size: result.size,
                  state: result.state,
                  error: result.error,
                })),
          },
          loading: {
            ...state.loading,
            previewByTabId: {
              ...state.loading.previewByTabId,
              [requestKey]: false,
            },
          },
          errors: {
            ...state.errors,
            previewByTabId: {
              ...state.errors.previewByTabId,
              [requestKey]: result.error ?? null,
            },
            previewRefreshStateByTabId: {
              ...state.errors.previewRefreshStateByTabId,
              [requestKey]: preserveSuccessfulPayload ? result.state : null,
            },
          },
        }
      })
    } catch (error) {
      if (!isLatestRequest(previewRequestIds, requestKey, requestId)) return
      if (!get().previewTabsBySession[sessionId]?.some((tab) => tab.id === tabId)) return

      set((state) => {
        const tabs = state.previewTabsBySession[sessionId] ?? []
        const message = error instanceof Error ? error.message : 'Failed to load workspace preview'
        const current = tabs.find((tab) => tab.id === tabId)
        const preserveSuccessfulPayload = current?.state === 'ok'

        return {
          previewTabsBySession: {
            ...state.previewTabsBySession,
            [sessionId]: preserveSuccessfulPayload
              ? tabs
              : upsertPreviewTab(tabs, tabId, (tab) => ({
                  ...tab,
                  state: 'error',
                  error: message,
                })),
          },
          loading: {
            ...state.loading,
            previewByTabId: {
              ...state.loading.previewByTabId,
              [requestKey]: false,
            },
          },
          errors: {
            ...state.errors,
            previewByTabId: {
              ...state.errors.previewByTabId,
              [requestKey]: message,
            },
            previewRefreshStateByTabId: {
              ...state.errors.previewRefreshStateByTabId,
              [requestKey]: null,
            },
          },
        }
      })
    }
  },

  closePreview: (sessionId, tabId) => {
    get().closePreviewTabs(sessionId, tabId, 'current')
  },

  closePreviewTabs: (sessionId, tabId, scope) => {
    set((state) => {
      const tabs = state.previewTabsBySession[sessionId] ?? []
      const index = tabs.findIndex((tab) => tab.id === tabId)
      if (index < 0) {
        const requestKey = makePreviewKey(sessionId, tabId)
        invalidateRequest(previewRequestIds, requestKey)
        return {
          loading: {
            ...state.loading,
            previewByTabId: removeRecordKey(state.loading.previewByTabId, requestKey),
          },
          errors: {
            ...state.errors,
            previewByTabId: removeRecordKey(state.errors.previewByTabId, requestKey),
            previewRefreshStateByTabId: removeRecordKey(state.errors.previewRefreshStateByTabId, requestKey),
          },
        }
      }

      let nextTabs: WorkspacePreviewTab[]
      switch (scope) {
        case 'others':
          nextTabs = [tabs[index]!]
          break
        case 'left':
          nextTabs = tabs.slice(index)
          break
        case 'right':
          nextTabs = tabs.slice(0, index + 1)
          break
        case 'all':
          nextTabs = []
          break
        case 'current':
        default:
          nextTabs = tabs.filter((tab) => tab.id !== tabId)
          break
      }

      const nextTabIds = new Set(nextTabs.map((tab) => tab.id))
      const closingTabIds = tabs.map((tab) => tab.id).filter((id) => !nextTabIds.has(id))
      const requestKeys = closingTabIds.map((id) => makePreviewKey(sessionId, id))
      for (const key of requestKeys) {
        invalidateRequest(previewRequestIds, key)
      }

      const activeTabId = state.activePreviewTabIdBySession[sessionId] ?? null

      let nextActiveTabId = activeTabId
      if (scope === 'all' || nextTabs.length === 0) {
        nextActiveTabId = null
      } else if (!activeTabId || !nextTabIds.has(activeTabId)) {
        const targetTab = nextTabs.find((tab) => tab.id === tabId)
        nextActiveTabId = targetTab?.id ?? nextTabs[Math.min(index, nextTabs.length - 1)]?.id ?? null
      } else if (scope === 'others') {
        nextActiveTabId = tabId
      } else if (activeTabId === tabId && scope === 'current') {
        if (nextTabs.length === 0) {
          nextActiveTabId = null
        } else if (index >= nextTabs.length) {
          nextActiveTabId = nextTabs[nextTabs.length - 1]!.id
        } else {
          nextActiveTabId = nextTabs[index]!.id
        }
      }

      return {
        previewTabsBySession: {
          ...state.previewTabsBySession,
          [sessionId]: nextTabs.length > 0 ? nextTabs : undefined,
        },
        activePreviewTabIdBySession: {
          ...state.activePreviewTabIdBySession,
          [sessionId]: nextActiveTabId,
        },
        loading: {
          ...state.loading,
          previewByTabId: removeRecordKeys(state.loading.previewByTabId, requestKeys),
        },
        errors: {
          ...state.errors,
          previewByTabId: removeRecordKeys(state.errors.previewByTabId, requestKeys),
          previewRefreshStateByTabId: removeRecordKeys(state.errors.previewRefreshStateByTabId, requestKeys),
        },
      }
    })
  },

  clearSession: (sessionId) => {
    invalidateRequest(statusRequestIds, sessionId)
    invalidateSessionScopedRequests(treeRequestIds, sessionId)
    invalidateSessionScopedRequests(previewRequestIds, sessionId)

    set((state) => ({
      panelBySession: removeRecordKey(state.panelBySession, sessionId),
      modeBySession: removeRecordKey(state.modeBySession, sessionId),
      statusBySession: removeRecordKey(state.statusBySession, sessionId),
      workDirKeyBySession: removeRecordKey(state.workDirKeyBySession, sessionId),
      expandedPathsBySession: removeRecordKey(state.expandedPathsBySession, sessionId),
      treeBySessionPath: removeRecordKey(state.treeBySessionPath, sessionId),
      previewTabsBySession: removeRecordKey(state.previewTabsBySession, sessionId),
      activePreviewTabIdBySession: removeRecordKey(state.activePreviewTabIdBySession, sessionId),
      originBySession: removeRecordKey(state.originBySession, sessionId),
      loading: {
        statusBySession: removeRecordKey(state.loading.statusBySession, sessionId),
        treeBySessionPath: stripSessionKeys(state.loading.treeBySessionPath, sessionId),
        previewByTabId: stripSessionKeys(state.loading.previewByTabId, sessionId),
      },
      errors: {
        statusBySession: removeRecordKey(state.errors.statusBySession, sessionId),
        treeBySessionPath: stripSessionKeys(state.errors.treeBySessionPath, sessionId),
        previewByTabId: stripSessionKeys(state.errors.previewByTabId, sessionId),
        previewRefreshStateByTabId: stripSessionKeys(state.errors.previewRefreshStateByTabId, sessionId),
      },
    }))
  },

  resetSessionUi: (sessionId) => {
    get().clearSession(sessionId)
  },
}))
