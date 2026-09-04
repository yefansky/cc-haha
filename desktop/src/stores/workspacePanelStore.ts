import { create } from 'zustand'
import {
  sessionsApi,
  type WorkspaceComparison,
  type WorkspaceComparisonEncodings,
  type WorkspaceDiffResult,
  type WorkspaceReadFileResult,
  type WorkspaceTextEncoding,
  type WorkspaceStatusResult,
  type WorkspaceTreeResult,
} from '../api/sessions'
import {
  createWorkspaceComparisonSession,
  isWorkspaceComparisonSessionDirty,
  reloadWorkspaceComparisonSession,
  type WorkspaceComparisonSession,
} from '../components/workspace/workspaceComparisonSession'
import {
  canUseWorkspacePreviewPersistentCache,
  deleteWorkspacePreviewPersistentCache,
  deleteWorkspacePreviewPersistentCachePrefix,
  getWorkspacePreviewPersistentCache,
  setWorkspacePreviewPersistentCache,
  type WorkspacePreviewPayload,
} from '../lib/workspacePreviewPersistentCache'

export const WORKSPACE_PANEL_DEFAULT_WIDTH = 860
export const WORKSPACE_PANEL_MIN_WIDTH = 420
export const WORKSPACE_PANEL_MAX_WIDTH = 3200

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

/**
 * A line the code view should scroll to and mark.
 *
 * `nonce` exists so clicking the same `foo.ts:42` reference twice scrolls back
 * to it: without it, re-opening an already-open tab at an unchanged line is a
 * no-op state update and the view stays wherever the user had scrolled to.
 */
export type WorkspacePreviewReveal = { line: number; column?: number; nonce: number }

export type WorkspacePreviewTab = {
  id: string
  path: string
  kind: WorkspacePreviewKind
  title: string
  reveal?: WorkspacePreviewReveal
  language?: string
  content?: string
  dataUrl?: string
  mimeType?: string
  previewType?: 'text' | 'image'
  diff?: string
  comparison?: WorkspaceComparison
  diffSource?: WorkspaceDiffSource
  state?: WorkspacePreviewState
  error?: string
  size?: number
  textEncoding?: WorkspaceTextEncoding
  comparisonSession?: WorkspaceComparisonSession
  comparisonEncodings?: WorkspaceComparisonEncodings
  /** Exact request inputs that produced the last successful payload. */
  requestIdentity?: string
}

export type WorkspaceOpenPreviewOptions = {
  force?: boolean
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
  previewOpenNonceBySession: Record<string, number | undefined>
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
  loadStatus: (sessionId: string, options?: { force?: boolean; invalidatePreviews?: boolean }) => Promise<void>
  preloadStatus: (sessionId: string) => void
  loadTree: (sessionId: string, path?: string) => Promise<void>
  toggleTreeNode: (sessionId: string, path: string) => Promise<void>
  openPreview: (
    sessionId: string,
    path: string,
    kind: WorkspacePreviewKind,
    origin?: WorkspacePanelOrigin,
    reveal?: { line: number; column?: number },
    diffSource?: WorkspaceDiffSource,
    textEncoding?: WorkspaceTextEncoding,
    comparisonEncodings?: WorkspaceComparisonEncodings,
    options?: WorkspaceOpenPreviewOptions,
  ) => Promise<void>
  preloadPreview: (
    sessionId: string,
    path: string,
    kind: WorkspacePreviewKind,
    diffSource?: WorkspaceDiffSource,
    textEncoding?: WorkspaceTextEncoding,
    comparisonEncodings?: WorkspaceComparisonEncodings,
    options?: WorkspaceOpenPreviewOptions,
  ) => Promise<void>
  closePreview: (sessionId: string, tabId: string) => void
  closePreviewTabs: (sessionId: string, tabId: string, scope: WorkspacePreviewCloseScope) => void
  activatePreview: (sessionId: string, tabId: string) => void
  setComparisonSession: (sessionId: string, tabId: string, comparisonSession: WorkspaceComparisonSession | null) => void
  clearSession: (sessionId: string) => void
  resetSessionUi: (sessionId: string) => void
}

const DEFAULT_PANEL_STATE: WorkspacePanelSessionState = {
  isOpen: false,
  activeView: 'all',
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
const statusRequestsInFlight = new Map<string, Promise<void>>()
const treeRequestIds = new Map<string, number>()
const previewRequestIds = new Map<string, number>()
type WorkspacePreviewCacheEntry = {
  payload: WorkspacePreviewPayload
  cachedAt: number
}

const previewPayloadCache = new Map<string, WorkspacePreviewCacheEntry>()
const previewPayloadRequestsInFlight = new Map<string, Promise<WorkspacePreviewPayload>>()
const previewPayloadRequestTokens = new Map<string, number>()
const previewPersistentSessionClears = new Map<string, Promise<void>>()
const previewForegroundDemand = new Set<string>()
let nextPreviewPayloadRequestToken = 0
const WORKSPACE_PREVIEW_CACHE_SIZE = 16
const WORKSPACE_PREVIEW_REQUEST_CONCURRENCY = 2
const WORKSPACE_STATUS_CACHE_TTL_MS = 15_000

type PreviewRequestPriority = 'foreground' | 'background'
type QueuedPreviewRequest = {
  key: string
  priority: PreviewRequestPriority
  run: () => Promise<WorkspacePreviewPayload>
  resolve: (payload: WorkspacePreviewPayload) => void
  reject: (error: unknown) => void
}

const queuedPreviewRequests: QueuedPreviewRequest[] = []
let activePreviewRequestCount = 0

function drainPreviewRequestQueue() {
  while (
    activePreviewRequestCount < WORKSPACE_PREVIEW_REQUEST_CONCURRENCY &&
    queuedPreviewRequests.length > 0
  ) {
    const queued = queuedPreviewRequests.shift()!
    activePreviewRequestCount += 1
    void queued.run()
      .then(queued.resolve, queued.reject)
      .finally(() => {
        activePreviewRequestCount -= 1
        drainPreviewRequestQueue()
      })
  }
}

function enqueuePreviewRequest(
  key: string,
  priority: PreviewRequestPriority,
  run: () => Promise<WorkspacePreviewPayload>,
) {
  const promise = new Promise<WorkspacePreviewPayload>((resolve, reject) => {
    const request = { key, priority, run, resolve, reject }
    const firstBackgroundIndex = queuedPreviewRequests.findIndex((item) => item.priority === 'background')
    if (priority === 'foreground' && firstBackgroundIndex >= 0) {
      queuedPreviewRequests.splice(firstBackgroundIndex, 0, request)
    } else {
      queuedPreviewRequests.push(request)
    }
  })
  drainPreviewRequestQueue()
  return promise
}

function promoteQueuedPreviewRequest(key: string) {
  const index = queuedPreviewRequests.findIndex((request) => request.key === key)
  if (index < 0 || queuedPreviewRequests[index]?.priority === 'foreground') return
  const [request] = queuedPreviewRequests.splice(index, 1)
  if (!request) return
  request.priority = 'foreground'
  // A direct user action must not wait behind speculative background work.
  // It still resolves the original queued Promise, so every waiter shares the
  // same request and no duplicate fetch is introduced.
  void request.run().then(request.resolve, request.reject)
}

function getWorkDirCacheKey(workDir: string) {
  return workDir.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
}

function nextRequestId(store: Map<string, number>, key: string) {
  const requestId = (store.get(key) ?? 0) + 1
  store.set(key, requestId)
  return requestId
}

let revealNonce = 0
/** Monotonic so a repeat click on the same reference re-triggers the scroll. */
function nextRevealNonce() {
  revealNonce += 1
  return revealNonce
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

function makePreviewRequestIdentity(
  kind: WorkspacePreviewKind,
  diffSource: WorkspaceDiffSource,
  textEncoding: WorkspaceTextEncoding,
  comparisonEncodings?: WorkspaceComparisonEncodings,
) {
  const sourceIdentity = diffSource.kind === 'turn'
    ? `turn:${diffSource.targetUserMessageId}:${diffSource.userMessageIndex}`
    : 'workspace'
  const normalizedComparisonEncodings = comparisonEncodings ?? (
    kind === 'diff' && diffSource.kind === 'workspace'
      ? { left: textEncoding, right: textEncoding }
      : undefined
  )
  const encodingIdentity = normalizedComparisonEncodings
    ? `${normalizedComparisonEncodings.left}:${normalizedComparisonEncodings.right}`
    : '-'
  return `${kind}|${sourceIdentity}|${textEncoding}|${encodingIdentity}`
}

function makePreviewPayloadCacheKey(
  sessionId: string,
  path: string,
  requestIdentity: string,
) {
  return `${sessionId}\0${path}\0${requestIdentity}`
}

function isPatchOnlyWorkspacePayload(
  payload: WorkspacePreviewPayload,
  kind: WorkspacePreviewKind,
  diffSource: WorkspaceDiffSource,
) {
  return kind === 'diff'
    && diffSource.kind === 'workspace'
    && payload.kind === 'diff'
    && payload.result.state === 'ok'
    && payload.result.comparison === undefined
}

function setPreviewPayloadCache(
  cacheKey: string,
  payload: WorkspacePreviewPayload,
  options: { cachedAt?: number; persist?: boolean } = {},
) {
  const entry = { payload, cachedAt: options.cachedAt ?? Date.now() }
  previewPayloadCache.delete(cacheKey)
  previewPayloadCache.set(cacheKey, entry)
  while (previewPayloadCache.size > WORKSPACE_PREVIEW_CACHE_SIZE) {
    const oldest = previewPayloadCache.keys().next().value
    if (oldest === undefined) break
    previewPayloadCache.delete(oldest)
  }
  if (options.persist !== false) {
    void setWorkspacePreviewPersistentCache(cacheKey, payload)
  }
}

function clearSessionPreviewPayloadCache(sessionId: string) {
  const prefix = `${sessionId}\0`
  for (const key of previewPayloadCache.keys()) {
    if (key.startsWith(prefix)) previewPayloadCache.delete(key)
  }
  for (const key of previewPayloadRequestsInFlight.keys()) {
    if (key.startsWith(prefix)) previewPayloadRequestsInFlight.delete(key)
  }
  for (const key of previewPayloadRequestTokens.keys()) {
    if (key.startsWith(prefix)) previewPayloadRequestTokens.delete(key)
  }
  for (const key of previewForegroundDemand) {
    if (key.startsWith(prefix)) previewForegroundDemand.delete(key)
  }
  const pendingClear = deleteWorkspacePreviewPersistentCachePrefix(prefix)
    .finally(() => {
      if (previewPersistentSessionClears.get(sessionId) === pendingClear) {
        previewPersistentSessionClears.delete(sessionId)
      }
    })
  previewPersistentSessionClears.set(sessionId, pendingClear)
}

function requestWorkspacePreviewPayload(
  sessionId: string,
  path: string,
  kind: WorkspacePreviewKind,
  diffSource: WorkspaceDiffSource,
  textEncoding: WorkspaceTextEncoding,
  comparisonEncodings: WorkspaceComparisonEncodings | undefined,
  options: {
    force?: boolean
    cacheResult?: boolean
    priority?: PreviewRequestPriority
  } = {},
) {
  const requestIdentity = makePreviewRequestIdentity(kind, diffSource, textEncoding, comparisonEncodings)
  const cacheKey = makePreviewPayloadCacheKey(sessionId, path, requestIdentity)
  let persistentInvalidation: Promise<void> | null = null
  if (options.force) {
    previewPayloadCache.delete(cacheKey)
    persistentInvalidation = deleteWorkspacePreviewPersistentCache(cacheKey)
  }
  else {
    const cached = previewPayloadCache.get(cacheKey)
    if (cached) {
      setPreviewPayloadCache(cacheKey, cached.payload, {
        cachedAt: cached.cachedAt,
        persist: false,
      })
      return Promise.resolve(cached.payload)
    }
    const existing = previewPayloadRequestsInFlight.get(cacheKey)
    if (existing) {
      if (options.priority === 'foreground') {
        previewForegroundDemand.add(cacheKey)
        promoteQueuedPreviewRequest(cacheKey)
      }
      return existing
    }
  }

  // The token is process-wide monotonic, rather than a per-key generation that
  // can restart after clearSession. This prevents an old request from passing
  // the guard after clear -> reopen reuses the same cache key (ABA).
  nextPreviewPayloadRequestToken += 1
  const requestToken = nextPreviewPayloadRequestToken
  previewPayloadRequestTokens.set(cacheKey, requestToken)

  const runRequest = (): Promise<WorkspacePreviewPayload> => kind === 'diff'
    ? (diffSource.kind === 'turn'
        ? sessionsApi.getTurnCheckpointDiff(
            sessionId,
            diffSource.targetUserMessageId,
            path,
            diffSource.userMessageIndex,
          )
        : comparisonEncodings
          ? sessionsApi.getWorkspaceDiff(sessionId, path, textEncoding, comparisonEncodings)
          : textEncoding === 'auto'
            ? sessionsApi.getWorkspaceDiff(sessionId, path)
            : sessionsApi.getWorkspaceDiff(sessionId, path, textEncoding))
      .then((result) => ({ kind: 'diff' as const, result }))
    : (textEncoding === 'auto'
        ? sessionsApi.getWorkspaceFile(sessionId, path)
        : sessionsApi.getWorkspaceFile(sessionId, path, textEncoding))
      .then((result) => ({ kind: 'file' as const, result }))

  const tracked = (async () => {
    const sessionClear = previewPersistentSessionClears.get(sessionId)
    if (sessionClear) await sessionClear
    if (persistentInvalidation) await persistentInvalidation
    if (!options.force && canUseWorkspacePreviewPersistentCache()) {
      const persisted = await getWorkspacePreviewPersistentCache(cacheKey)
      if (
        persisted
        && previewPayloadRequestTokens.get(cacheKey) === requestToken
      ) {
        if (isPatchOnlyWorkspacePayload(persisted.payload, kind, diffSource)) {
          await deleteWorkspacePreviewPersistentCache(cacheKey)
        } else {
          setPreviewPayloadCache(cacheKey, persisted.payload, {
            cachedAt: persisted.cachedAt,
            persist: false,
          })
          return persisted.payload
        }
      }
    }

    const queueKey = options.force ? `${cacheKey}\0force:${requestToken}` : cacheKey
    const priority = previewForegroundDemand.has(cacheKey)
      ? 'foreground'
      : options.priority ?? 'foreground'
    return priority === 'foreground'
      ? runRequest()
      : enqueuePreviewRequest(queueKey, priority, runRequest)
  })()
    .then((payload) => {
      if (
        options.cacheResult !== false
        && payload.result.state === 'ok'
        && previewPayloadRequestTokens.get(cacheKey) === requestToken
        && previewPayloadCache.get(cacheKey)?.payload !== payload
      ) {
        setPreviewPayloadCache(cacheKey, payload, {
          persist: !isPatchOnlyWorkspacePayload(payload, kind, diffSource),
        })
      }
      return payload
    })
    .finally(() => {
      if (previewPayloadRequestsInFlight.get(cacheKey) === tracked) {
        previewPayloadRequestsInFlight.delete(cacheKey)
        previewForegroundDemand.delete(cacheKey)
      }
    })
  previewPayloadRequestsInFlight.set(cacheKey, tracked)
  return tracked
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
  previewOpenNonceBySession: {},
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

  loadStatus: (sessionId, options) => {
    const existingRequest = statusRequestsInFlight.get(sessionId)
    if (!options?.force && existingRequest) return existingRequest
    if (!options?.force && get().statusBySession[sessionId]) return Promise.resolve()
    if (options?.force && options.invalidatePreviews !== false) {
      clearSessionPreviewPayloadCache(sessionId)
      set((state) => ({
        previewTabsBySession: {
          ...state.previewTabsBySession,
          [sessionId]: state.previewTabsBySession[sessionId]?.map((tab) => (
            tab.diffSource?.kind === 'turn' || isWorkspaceComparisonSessionDirty(tab.comparisonSession)
              ? tab
              : { ...tab, requestIdentity: undefined }
          )),
        },
      }))
    }

    const request = (async () => {
      const requestId = nextRequestId(statusRequestIds, sessionId)
      const knownWorkDirKey = get().workDirKeyBySession[sessionId]
      const cached = knownWorkDirKey ? get().statusCacheByWorkDir[knownWorkDirKey] : undefined

      // The shared checkout cache warms newly created sessions. Once a session
      // has status, normal opens reuse it; explicit refresh remains authoritative.
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
          const workDirKey = getWorkDirCacheKey(result.workDir)
          return {
            panelBySession: {
              ...state.panelBySession,
              [sessionId]: {
                ...panel,
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
    })()

    if (options?.force) return request
    statusRequestsInFlight.set(sessionId, request)
    return request.finally(() => {
      if (statusRequestsInFlight.get(sessionId) === request) {
        statusRequestsInFlight.delete(sessionId)
      }
    })
  },

  preloadStatus: (sessionId) => {
    const state = get()
    if (state.statusBySession[sessionId] || state.loading.statusBySession[sessionId]) return
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

  preloadPreview: async (
    sessionId,
    path,
    kind,
    diffSource = { kind: 'workspace' },
    textEncoding = 'auto',
    comparisonEncodings,
    options,
  ) => {
    const tabId = getWorkspacePreviewTabId(path, kind, diffSource)
    const existing = get().previewTabsBySession[sessionId]?.find((tab) => tab.id === tabId)
    if (isWorkspaceComparisonSessionDirty(existing?.comparisonSession)) return
    await requestWorkspacePreviewPayload(
      sessionId,
      path,
      kind,
      diffSource,
      textEncoding,
      comparisonEncodings,
      { force: options?.force, priority: 'background' },
    )
  },

  openPreview: async (
    sessionId,
    path,
    kind,
    origin,
    reveal,
    diffSource = { kind: 'workspace' },
    textEncoding = 'auto',
    comparisonEncodings,
    options,
  ) => {
    // Ensure the workspace panel is visible — openPreview is now triggered from places
    // where the panel may be closed (e.g. the chat "打开方式" menu / turn-changes card),
    // not only from inside the already-open file tree. Opening a file always switches the
    // unified workbench into file ("workspace") mode.
    get().openPanel(sessionId)
    get().setMode(sessionId, 'workspace')
    set((state) => ({
      previewOpenNonceBySession: {
        ...(state.previewOpenNonceBySession ?? {}),
        [sessionId]: (state.previewOpenNonceBySession?.[sessionId] ?? 0) + 1,
      },
    }))
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
    const effectiveComparisonEncodings = comparisonEncodings ?? existing?.comparisonEncodings ?? (
      existing?.comparisonSession
        ? {
            left: existing.comparisonSession.left.requestedEncoding,
            right: existing.comparisonSession.right.requestedEncoding,
          }
        : undefined
    )
    const requestIdentity = makePreviewRequestIdentity(
      kind,
      diffSource,
      textEncoding,
      effectiveComparisonEncodings,
    )

    const requestId = nextRequestId(previewRequestIds, requestKey)
    // Omitting a reveal must not clear the one already on the tab: reopening the
    // same file from the tree should leave the marked line where it was.
    const nextReveal: WorkspacePreviewReveal | undefined = reveal
      ? { ...reveal, nonce: nextRevealNonce() }
      : existing?.reveal

    // Re-selecting a successful tab is navigation, not an implicit refresh.
    // Keep the exact request identity with the payload so encoding/checkpoint
    // changes invalidate naturally. External changes are refreshed explicitly
    // (or after a completed write), which also protects dirty in-memory edits.
    if (!options?.force && existing?.state === 'ok' && existing.requestIdentity === requestIdentity) {
      set((state) => ({
        previewTabsBySession: {
          ...state.previewTabsBySession,
          [sessionId]: upsertPreviewTab(
            state.previewTabsBySession[sessionId] ?? [],
            tabId,
            (tab) => ({ ...tab, reveal: nextReveal }),
          ),
        },
        activePreviewTabIdBySession: {
          ...state.activePreviewTabIdBySession,
          [sessionId]: tabId,
        },
      }))
      return
    }

    if (existing) {
      set((state) => ({
        previewTabsBySession: {
          ...state.previewTabsBySession,
          [sessionId]: upsertPreviewTab(
            state.previewTabsBySession[sessionId] ?? [],
            tabId,
            (tab) => ({
              ...tab,
              reveal: nextReveal,
              diffSource: kind === 'diff' || diffSource.kind === 'turn' ? diffSource : undefined,
              comparisonEncodings: kind === 'diff' ? effectiveComparisonEncodings : undefined,
            }),
          ),
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
    } else {
      const baseTab: WorkspacePreviewTab = {
        id: tabId,
        path,
        kind,
        title: getPathTitle(path),
        textEncoding,
        ...(kind === 'diff' && effectiveComparisonEncodings
          ? { comparisonEncodings: effectiveComparisonEncodings }
          : {}),
        ...(kind === 'diff' || diffSource.kind === 'turn' ? { diffSource } : {}),
        state: 'loading',
        requestIdentity,
        ...(nextReveal ? { reveal: nextReveal } : {}),
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
      const payload = await requestWorkspacePreviewPayload(
        sessionId,
        path,
        kind,
        diffSource,
        textEncoding,
        effectiveComparisonEncodings,
        {
          force: options?.force,
          cacheResult: !isWorkspaceComparisonSessionDirty(existing?.comparisonSession),
          priority: 'foreground',
        },
      )
      if (kind === 'diff') {
        if (payload.kind !== 'diff') return
        const result = payload.result
        if (!isLatestRequest(previewRequestIds, requestKey, requestId)) return
        if (!get().previewTabsBySession[sessionId]?.some((tab) => tab.id === tabId)) return

        set((state) => {
          const tabs = state.previewTabsBySession[sessionId] ?? []
          const current = tabs.find((tab) => tab.id === tabId)
          const preserveSuccessfulPayload = current?.state === 'ok' && result.state !== 'ok'
          const resolvedComparisonEncodings = effectiveComparisonEncodings ?? (result.comparison
            ? {
                left: result.comparison.left.requestedEncoding,
                right: result.comparison.right.requestedEncoding,
              }
            : undefined)
          return {
            previewTabsBySession: {
              ...state.previewTabsBySession,
              [sessionId]: preserveSuccessfulPayload
                ? tabs
                : upsertPreviewTab(tabs, tabId, (tab) => ({
                    ...tab,
                    diff: result.diff ?? '',
                    comparison: result.comparison,
                    diffSource,
                    content: undefined,
                    language: undefined,
                    size: undefined,
                    state: result.state,
                    error: result.error,
                    textEncoding,
                    comparisonEncodings: resolvedComparisonEncodings,
                    comparisonSession: isWorkspaceComparisonSessionDirty(tab.comparisonSession)
                      ? tab.comparisonSession
                      : tab.comparisonSession
                        ? reloadWorkspaceComparisonSession(tab.comparisonSession, result.comparison) ?? undefined
                        : createWorkspaceComparisonSession(result.comparison) ?? undefined,
                    requestIdentity: makePreviewRequestIdentity(
                      kind,
                      diffSource,
                      textEncoding,
                      resolvedComparisonEncodings,
                    ),
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

      if (payload.kind !== 'file') return
      const result = payload.result
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
                  comparison: undefined,
                  language: result.language,
                  size: result.size,
                  state: result.state,
                  error: result.error,
                  textEncoding,
                  requestIdentity,
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

  activatePreview: (sessionId, tabId) => {
    if (!get().previewTabsBySession[sessionId]?.some((tab) => tab.id === tabId)) return
    set((state) => ({
      activePreviewTabIdBySession: {
        ...state.activePreviewTabIdBySession,
        [sessionId]: tabId,
      },
    }))
  },

  setComparisonSession: (sessionId, tabId, comparisonSession) => {
    set((state) => ({
      previewTabsBySession: {
        ...state.previewTabsBySession,
        [sessionId]: upsertPreviewTab(
          state.previewTabsBySession[sessionId] ?? [],
          tabId,
          (tab) => ({ ...tab, comparisonSession: comparisonSession ?? undefined }),
        ),
      },
    }))
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
    clearSessionPreviewPayloadCache(sessionId)

    set((state) => ({
      panelBySession: removeRecordKey(state.panelBySession, sessionId),
      modeBySession: removeRecordKey(state.modeBySession, sessionId),
      statusBySession: removeRecordKey(state.statusBySession, sessionId),
      workDirKeyBySession: removeRecordKey(state.workDirKeyBySession, sessionId),
      expandedPathsBySession: removeRecordKey(state.expandedPathsBySession, sessionId),
      treeBySessionPath: removeRecordKey(state.treeBySessionPath, sessionId),
      previewTabsBySession: removeRecordKey(state.previewTabsBySession, sessionId),
      activePreviewTabIdBySession: removeRecordKey(state.activePreviewTabIdBySession, sessionId),
      previewOpenNonceBySession: removeRecordKey(state.previewOpenNonceBySession, sessionId),
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
