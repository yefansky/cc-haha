import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

type HoistedVi = typeof vi & {
  hoisted?: <T>(factory: () => T) => T
}

if (typeof (vi as HoistedVi).hoisted !== 'function') {
  ;(vi as HoistedVi).hoisted = <T>(factory: () => T) => factory()
}

const mocks = vi.hoisted(() => ({
  getWorkspaceStatusMock: vi.fn(),
  getWorkspaceTreeMock: vi.fn(),
  getWorkspaceFileMock: vi.fn(),
  getWorkspaceDiffMock: vi.fn(),
  getTurnCheckpointDiffMock: vi.fn(),
}))

vi.mock('../api/sessions', () => ({
  sessionsApi: {
    getWorkspaceStatus: mocks.getWorkspaceStatusMock,
    getWorkspaceTree: mocks.getWorkspaceTreeMock,
    getWorkspaceFile: mocks.getWorkspaceFileMock,
    getWorkspaceDiff: mocks.getWorkspaceDiffMock,
    getTurnCheckpointDiff: mocks.getTurnCheckpointDiffMock,
  },
}))

import { sessionsApi } from '../api/sessions'
import {
  WORKSPACE_PANEL_DEFAULT_WIDTH,
  WORKSPACE_PANEL_MAX_WIDTH,
  WORKSPACE_PANEL_MIN_WIDTH,
  getWorkspacePreviewTabId,
  useWorkspacePanelStore,
} from './workspacePanelStore'
import {
  addWorkspaceManualAlignmentAnchor,
  editWorkspaceComparisonSide,
} from '../components/workspace/workspaceComparisonSession'
import * as workspacePreviewPersistentCache from '../lib/workspacePreviewPersistentCache'

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

describe('workspacePanelStore', () => {
  const initialState = useWorkspacePanelStore.getInitialState()

  beforeEach(() => {
    vi.clearAllMocks()
    useWorkspacePanelStore.setState(initialState, true)
  })

  afterEach(() => {
    useWorkspacePanelStore.setState(initialState, true)
    vi.restoreAllMocks()
  })

  it('uses hoisted session api mocks', () => {
    expect(sessionsApi.getWorkspaceStatus).toBe(mocks.getWorkspaceStatusMock)
    expect(sessionsApi.getWorkspaceTree).toBe(mocks.getWorkspaceTreeMock)
    expect(sessionsApi.getWorkspaceFile).toBe(mocks.getWorkspaceFileMock)
    expect(sessionsApi.getWorkspaceDiff).toBe(mocks.getWorkspaceDiffMock)
    expect(sessionsApi.getTurnCheckpointDiff).toBe(mocks.getTurnCheckpointDiffMock)
  })

  it('keeps panel open state and active view isolated per session', () => {
    const store = useWorkspacePanelStore.getState()

    expect(store.isPanelOpen('session-a')).toBe(false)
    expect(store.getActiveView('session-a')).toBe('all')
    expect(store.width).toBe(WORKSPACE_PANEL_DEFAULT_WIDTH)

    store.openPanel('session-a')
    store.setActiveView('session-a', 'all')

    expect(useWorkspacePanelStore.getState().isPanelOpen('session-a')).toBe(true)
    expect(useWorkspacePanelStore.getState().getActiveView('session-a')).toBe('all')
    expect(useWorkspacePanelStore.getState().isPanelOpen('session-b')).toBe(false)
    expect(useWorkspacePanelStore.getState().getActiveView('session-b')).toBe('all')

    store.togglePanel('session-b')
    expect(useWorkspacePanelStore.getState().isPanelOpen('session-b')).toBe(true)
    expect(useWorkspacePanelStore.getState().isPanelOpen('session-a')).toBe(true)

    store.closePanel('session-a')
    expect(useWorkspacePanelStore.getState().isPanelOpen('session-a')).toBe(false)
    expect(useWorkspacePanelStore.getState().getActiveView('session-a')).toBe('all')

    store.setWidth(120)
    expect(useWorkspacePanelStore.getState().width).toBe(WORKSPACE_PANEL_MIN_WIDTH)
    store.setWidth(5000)
    expect(useWorkspacePanelStore.getState().width).toBe(WORKSPACE_PANEL_MAX_WIDTH)
  })

  it('persists user-added extra workspace roots and can remove them', () => {
    const root = 'G:\\private_brain\\项目大脑'
    useWorkspacePanelStore.getState().addMountedRoot(root)

    expect(useWorkspacePanelStore.getState().mountedRoots).toContainEqual({
      path: root,
      label: '项目大脑',
    })
    expect(JSON.parse(localStorage.getItem('cc-haha-workspace-mounted-roots')!)).toEqual([
      { path: root, label: '项目大脑' },
    ])

    useWorkspacePanelStore.getState().removeMountedRoot(root)
    expect(useWorkspacePanelStore.getState().mountedRoots).toEqual([])
    expect(JSON.parse(localStorage.getItem('cc-haha-workspace-mounted-roots')!)).toEqual([])
  })

  it('keeps a preview opener origin at session scope after the originating card unmounts', async () => {
    mocks.getWorkspaceDiffMock.mockResolvedValue({ state: 'ok', diff: '' })

    await useWorkspacePanelStore.getState().openPreview('session-origin', 'src/a.ts', 'diff', {
      sourceTurnKey: 'assistant-message-4',
      sourceElementId: 'turn-change-opener-message-4-a',
    })

    expect(useWorkspacePanelStore.getState().getOrigin('session-origin')).toEqual({
      sourceTurnKey: 'assistant-message-4',
      sourceElementId: 'turn-change-opener-message-4-a',
    })

    useWorkspacePanelStore.getState().closePanel('session-origin')
    expect(useWorkspacePanelStore.getState().getOrigin('session-origin')).toEqual({
      sourceTurnKey: 'assistant-message-4',
      sourceElementId: 'turn-change-opener-message-4-a',
    })

    useWorkspacePanelStore.getState().clearOrigin('session-origin')
    expect(useWorkspacePanelStore.getState().getOrigin('session-origin')).toBeNull()
  })

  it('loads workspace status successfully', async () => {
    mocks.getWorkspaceStatusMock.mockResolvedValue({
      state: 'ok',
      workDir: '/repo',
      repoName: 'repo',
      branch: 'main',
      isGitRepo: true,
      changedFiles: [
        {
          path: 'src/a.ts',
          status: 'modified',
          additions: 3,
          deletions: 1,
        },
      ],
    })

    await useWorkspacePanelStore.getState().loadStatus('session-1')

    expect(mocks.getWorkspaceStatusMock).toHaveBeenCalledWith('session-1')
    expect(useWorkspacePanelStore.getState().statusBySession['session-1']).toMatchObject({
      branch: 'main',
      changedFiles: [{ path: 'src/a.ts' }],
    })
    expect(useWorkspacePanelStore.getState().loading.statusBySession['session-1']).toBe(false)
    expect(useWorkspacePanelStore.getState().errors.statusBySession['session-1']).toBeNull()
  })

  it('reuses a recent status scan when another session shares the work directory', async () => {
    const result = {
      state: 'ok' as const,
      workDir: 'G:\\repo',
      repoName: 'repo',
      branch: null,
      isGitRepo: false,
      changedFiles: [{ path: 'src/a.ts', status: 'modified' as const, additions: 1, deletions: 0 }],
    }
    mocks.getWorkspaceStatusMock.mockResolvedValue(result)

    useWorkspacePanelStore.getState().registerSessionWorkDir('session-a', result.workDir)
    useWorkspacePanelStore.getState().registerSessionWorkDir('session-b', result.workDir)
    await useWorkspacePanelStore.getState().loadStatus('session-a')
    await useWorkspacePanelStore.getState().loadStatus('session-b')

    expect(mocks.getWorkspaceStatusMock).toHaveBeenCalledTimes(1)
    expect(useWorkspacePanelStore.getState().statusBySession['session-b']).toEqual(result)

    await useWorkspacePanelStore.getState().loadStatus('session-b', { force: true })
    expect(mocks.getWorkspaceStatusMock).toHaveBeenCalledTimes(2)
  })

  it('defaults new sessions to the all-files view', async () => {
    mocks.getWorkspaceStatusMock.mockResolvedValue({
      state: 'ok',
      workDir: '/repo',
      repoName: 'repo',
      branch: 'main',
      isGitRepo: true,
      changedFiles: [],
    })

    useWorkspacePanelStore.getState().openPanel('session-empty-changes')
    expect(useWorkspacePanelStore.getState().getActiveView('session-empty-changes')).toBe('all')

    await useWorkspacePanelStore.getState().loadStatus('session-empty-changes')

    expect(useWorkspacePanelStore.getState().statusBySession['session-empty-changes']?.changedFiles).toEqual([])
    expect(useWorkspacePanelStore.getState().getActiveView('session-empty-changes')).toBe('all')
  })

  it('keeps the default all-files view when status contains changes', async () => {
    mocks.getWorkspaceStatusMock.mockResolvedValue({
      state: 'ok',
      workDir: '/repo',
      repoName: 'repo',
      branch: 'main',
      isGitRepo: true,
      changedFiles: [
        {
          path: 'src/app.ts',
          status: 'modified',
          additions: 2,
          deletions: 1,
        },
      ],
    })

    useWorkspacePanelStore.getState().openPanel('session-has-changes')
    await useWorkspacePanelStore.getState().loadStatus('session-has-changes')

    expect(useWorkspacePanelStore.getState().getActiveView('session-has-changes')).toBe('all')
  })

  it('keeps the default all-files view when refreshed status gains changes', async () => {
    mocks.getWorkspaceStatusMock
      .mockResolvedValueOnce({
        state: 'ok',
        workDir: '/repo',
        repoName: 'repo',
        branch: 'main',
        isGitRepo: true,
        changedFiles: [],
      })
      .mockResolvedValueOnce({
        state: 'ok',
        workDir: '/repo',
        repoName: 'repo',
        branch: 'main',
        isGitRepo: true,
        changedFiles: [
          {
            path: 'src/app.ts',
            status: 'modified',
            additions: 2,
            deletions: 1,
          },
        ],
      })

    useWorkspacePanelStore.getState().openPanel('session-refresh-changes')
    await useWorkspacePanelStore.getState().loadStatus('session-refresh-changes')
    expect(useWorkspacePanelStore.getState().getActiveView('session-refresh-changes')).toBe('all')

    await useWorkspacePanelStore.getState().loadStatus('session-refresh-changes')

    expect(useWorkspacePanelStore.getState().getActiveView('session-refresh-changes')).toBe('all')
  })

  it('does not override an explicit all-files selection when refreshed status has changes', async () => {
    mocks.getWorkspaceStatusMock.mockResolvedValue({
      state: 'ok',
      workDir: '/repo',
      repoName: 'repo',
      branch: 'main',
      isGitRepo: true,
      changedFiles: [
        {
          path: 'src/app.ts',
          status: 'modified',
          additions: 2,
          deletions: 1,
        },
      ],
    })

    useWorkspacePanelStore.getState().openPanel('session-explicit-all')
    useWorkspacePanelStore.getState().setActiveView('session-explicit-all', 'all')
    await useWorkspacePanelStore.getState().loadStatus('session-explicit-all')

    expect(useWorkspacePanelStore.getState().getActiveView('session-explicit-all')).toBe('all')
  })

  it('does not override an explicit changed-files selection when status is empty', async () => {
    mocks.getWorkspaceStatusMock.mockResolvedValue({
      state: 'ok',
      workDir: '/repo',
      repoName: 'repo',
      branch: 'main',
      isGitRepo: true,
      changedFiles: [],
    })

    useWorkspacePanelStore.getState().openPanel('session-explicit-changed')
    useWorkspacePanelStore.getState().setActiveView('session-explicit-changed', 'changed')
    await useWorkspacePanelStore.getState().loadStatus('session-explicit-changed')

    expect(useWorkspacePanelStore.getState().getActiveView('session-explicit-changed')).toBe('changed')
  })

  it('captures workspace status request errors', async () => {
    mocks.getWorkspaceStatusMock.mockRejectedValue(new Error('status failed'))

    await useWorkspacePanelStore.getState().loadStatus('session-err')

    expect(useWorkspacePanelStore.getState().statusBySession['session-err']).toBeUndefined()
    expect(useWorkspacePanelStore.getState().loading.statusBySession['session-err']).toBe(false)
    expect(useWorkspacePanelStore.getState().errors.statusBySession['session-err']).toBe('status failed')
  })

  it('lazily loads tree nodes when expanding and reuses cached results', async () => {
    mocks.getWorkspaceTreeMock.mockResolvedValue({
      state: 'ok',
      path: '',
      entries: [
        { name: 'src', path: 'src', isDirectory: true },
        { name: 'README.md', path: 'README.md', isDirectory: false },
      ],
    })

    await useWorkspacePanelStore.getState().toggleTreeNode('session-tree', '')

    expect(mocks.getWorkspaceTreeMock).toHaveBeenCalledTimes(1)
    expect(mocks.getWorkspaceTreeMock).toHaveBeenCalledWith('session-tree', '')
    expect(useWorkspacePanelStore.getState().expandedPathsBySession['session-tree']).toEqual([''])
    expect(useWorkspacePanelStore.getState().treeBySessionPath['session-tree']?.['']).toMatchObject({
      entries: [{ path: 'src' }, { path: 'README.md' }],
    })

    await useWorkspacePanelStore.getState().toggleTreeNode('session-tree', '')
    expect(useWorkspacePanelStore.getState().expandedPathsBySession['session-tree']).toEqual([])

    await useWorkspacePanelStore.getState().toggleTreeNode('session-tree', '')
    expect(mocks.getWorkspaceTreeMock).toHaveBeenCalledTimes(1)
    expect(useWorkspacePanelStore.getState().expandedPathsBySession['session-tree']).toEqual([''])
  })

  it('ignores stale tree responses for the same session path', async () => {
    const first = deferred<{ state: 'ok'; path: string; entries: Array<{ name: string; path: string; isDirectory: boolean }> }>()
    const second = deferred<{ state: 'ok'; path: string; entries: Array<{ name: string; path: string; isDirectory: boolean }> }>()

    mocks.getWorkspaceTreeMock
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise)

    const firstLoad = useWorkspacePanelStore.getState().loadTree('session-tree-race', 'src')
    const secondLoad = useWorkspacePanelStore.getState().loadTree('session-tree-race', 'src')

    second.resolve({
      state: 'ok',
      path: 'src',
      entries: [{ name: 'new.ts', path: 'src/new.ts', isDirectory: false }],
    })
    await secondLoad

    first.resolve({
      state: 'ok',
      path: 'src',
      entries: [{ name: 'old.ts', path: 'src/old.ts', isDirectory: false }],
    })
    await firstLoad

    expect(useWorkspacePanelStore.getState().treeBySessionPath['session-tree-race']?.src?.entries).toEqual([
      { name: 'new.ts', path: 'src/new.ts', isDirectory: false },
    ])
  })

  it('openPreview opens the workspace panel when it was closed', async () => {
    mocks.getWorkspaceFileMock.mockResolvedValue({
      state: 'ok', path: 'src/a.ts', content: 'export const a = 1', language: 'typescript', size: 18,
    })
    expect(useWorkspacePanelStore.getState().isPanelOpen('session-closed-preview')).toBe(false)
    await useWorkspacePanelStore.getState().openPreview('session-closed-preview', 'src/a.ts', 'file')
    expect(useWorkspacePanelStore.getState().isPanelOpen('session-closed-preview')).toBe(true)
  })

  it('defaults the workbench mode to "workspace"', () => {
    expect(useWorkspacePanelStore.getState().getMode('session-no-mode')).toBe('workspace')
  })

  it('setMode stores the workbench mode per session', () => {
    const store = useWorkspacePanelStore.getState()
    store.setMode('session-a', 'browser')
    store.setMode('session-b', 'workspace')
    expect(useWorkspacePanelStore.getState().getMode('session-a')).toBe('browser')
    expect(useWorkspacePanelStore.getState().getMode('session-b')).toBe('workspace')
    // Unrelated sessions still fall back to the default.
    expect(useWorkspacePanelStore.getState().getMode('session-c')).toBe('workspace')
  })

  it('openPreview opens the panel and forces "workspace" mode', async () => {
    mocks.getWorkspaceFileMock.mockResolvedValue({
      state: 'ok', path: 'src/a.ts', content: 'export const a = 1', language: 'typescript', size: 18,
    })
    // Start in browser mode (panel could already be showing the browser).
    useWorkspacePanelStore.getState().setMode('session-preview-mode', 'browser')
    expect(useWorkspacePanelStore.getState().getMode('session-preview-mode')).toBe('browser')

    await useWorkspacePanelStore.getState().openPreview('session-preview-mode', 'src/a.ts', 'file')

    expect(useWorkspacePanelStore.getState().isPanelOpen('session-preview-mode')).toBe(true)
    expect(useWorkspacePanelStore.getState().getMode('session-preview-mode')).toBe('workspace')
  })

  it('opens preview tabs, supports multiple kinds, and reuses duplicates without persistence', async () => {
    const storage = typeof globalThis.localStorage === 'undefined' ? null : globalThis.localStorage
    const setItemSpy = storage ? vi.spyOn(storage, 'setItem') : null

    mocks.getWorkspaceFileMock.mockResolvedValue({
      state: 'ok',
      path: 'src/a.ts',
      content: 'export const a = 1',
      language: 'typescript',
      size: 18,
    })
    mocks.getWorkspaceDiffMock.mockResolvedValue({
      state: 'ok',
      path: 'src/a.ts',
      diff: '@@ -1 +1 @@',
    })

    useWorkspacePanelStore.getState().openPanel('session-preview')
    await useWorkspacePanelStore.getState().openPreview('session-preview', 'src/a.ts', 'file')
    await useWorkspacePanelStore.getState().openPreview('session-preview', 'src/a.ts', 'diff')
    await useWorkspacePanelStore.getState().openPreview('session-preview', 'src/a.ts', 'file')

    expect(mocks.getWorkspaceFileMock).toHaveBeenCalledTimes(1)
    expect(mocks.getWorkspaceDiffMock).toHaveBeenCalledTimes(1)

    const tabs = useWorkspacePanelStore.getState().previewTabsBySession['session-preview']
    expect(tabs).toBeDefined()
    expect(tabs).toHaveLength(2)
    expect(tabs![0]).toMatchObject({
      id: 'file:src/a.ts',
      kind: 'file',
      path: 'src/a.ts',
      content: 'export const a = 1',
      language: 'typescript',
    })
    expect(tabs![1]).toMatchObject({
      id: 'diff:src/a.ts',
      kind: 'diff',
      path: 'src/a.ts',
      diff: '@@ -1 +1 @@',
    })
    expect(useWorkspacePanelStore.getState().activePreviewTabIdBySession['session-preview']).toBe('file:src/a.ts')
    if (setItemSpy) {
      expect(setItemSpy).not.toHaveBeenCalled()
    } else {
      expect(storage).toBeNull()
    }
  })

  it('keeps the server comparison snapshot attached to the diff tab', async () => {
    const comparison = {
      schemaVersion: 1 as const,
      left: {
        source: { kind: 'git_head' as const, path: 'src/a.ts', revision: 'sha256:left' },
        exists: true,
        state: 'ok' as const,
        content: 'before\n',
        contentFingerprint: 'sha256:left',
        size: 7,
        requestedEncoding: 'auto' as const,
        actualEncoding: 'utf8' as const,
        bom: 'none' as const,
        lineEnding: 'lf' as const,
        writable: false,
        readOnlyReason: 'Git HEAD baselines are read-only.',
      },
      right: {
        source: { kind: 'working_tree' as const, path: 'src/a.ts', revision: 'sha256:right' },
        exists: true,
        state: 'ok' as const,
        content: 'after\n',
        contentFingerprint: 'sha256:right',
        size: 6,
        requestedEncoding: 'auto' as const,
        actualEncoding: 'utf8' as const,
        bom: 'none' as const,
        lineEnding: 'lf' as const,
        writable: true,
      },
    }
    mocks.getWorkspaceDiffMock.mockResolvedValue({
      state: 'ok',
      path: 'src/a.ts',
      diff: '@@ -1 +1 @@\n-before\n+after',
      comparison,
    })

    await useWorkspacePanelStore.getState().openPreview('session-comparison', 'src/a.ts', 'diff')

    expect(useWorkspacePanelStore.getState().previewTabsBySession['session-comparison']).toMatchObject([{
      id: 'diff:src/a.ts',
      diff: '@@ -1 +1 @@\n-before\n+after',
      comparison,
      comparisonSession: {
        left: { sourceSide: 'left', originContent: 'before\n', content: 'before\n', dirty: false },
        right: { sourceSide: 'right', originContent: 'after\n', content: 'after\n', dirty: false },
        undoStack: [],
      },
    }])
  })

  it('reloads a diff with independent source encodings and reuses them on refresh', async () => {
    const comparison = {
      schemaVersion: 1 as const,
      left: {
        source: { kind: 'git_head' as const, path: '-中文.txt', revision: 'sha256:left' },
        exists: true, state: 'ok' as const, content: '旧\n', requestedEncoding: 'gbk' as const,
        actualEncoding: 'gbk' as const, bom: 'none' as const, lineEnding: 'lf' as const,
        writable: false, readOnlyReason: 'read-only',
      },
      right: {
        source: { kind: 'working_tree' as const, path: '-中文.txt', revision: 'sha256:right' },
        exists: true, state: 'ok' as const, content: '新\n', requestedEncoding: 'utf8' as const,
        actualEncoding: 'utf8' as const, bom: 'none' as const, lineEnding: 'lf' as const, writable: true,
      },
    }
    mocks.getWorkspaceDiffMock.mockResolvedValue({
      state: 'ok',
      path: '-中文.txt',
      diff: '',
      comparison,
    })

    await useWorkspacePanelStore.getState().openPreview(
      'session-encoding',
      '-中文.txt',
      'diff',
      undefined,
      undefined,
      { kind: 'workspace' },
      'auto',
      { left: 'gbk', right: 'utf8' },
    )
    await useWorkspacePanelStore.getState().openPreview(
      'session-encoding', '-中文.txt', 'diff', undefined, undefined, undefined, undefined, undefined, { force: true },
    )

    expect(mocks.getWorkspaceDiffMock).toHaveBeenNthCalledWith(
      1,
      'session-encoding',
      '-中文.txt',
      'auto',
      { left: 'gbk', right: 'utf8' },
    )
    expect(mocks.getWorkspaceDiffMock).toHaveBeenNthCalledWith(
      2,
      'session-encoding',
      '-中文.txt',
      'auto',
      { left: 'gbk', right: 'utf8' },
    )
    expect(useWorkspacePanelStore.getState().previewTabsBySession['session-encoding']?.[0]).toMatchObject({
      comparisonEncodings: { left: 'gbk', right: 'utf8' },
      comparisonSession: {
        left: { requestedEncoding: 'gbk' },
        right: { requestedEncoding: 'utf8' },
      },
    })
  })

  it('preserves a dirty comparison session when a forced refresh result arrives', async () => {
    const comparison = {
      schemaVersion: 1 as const,
      left: {
        source: { kind: 'git_head' as const, path: 'src/a.ts', revision: 'left' },
        exists: true, state: 'ok' as const, content: 'before\n', requestedEncoding: 'auto' as const,
        actualEncoding: 'utf8' as const, bom: 'none' as const, lineEnding: 'lf' as const,
        writable: false, readOnlyReason: 'read-only',
      },
      right: {
        source: { kind: 'working_tree' as const, path: 'src/a.ts', revision: 'right' },
        exists: true, state: 'ok' as const, content: 'after\n', requestedEncoding: 'auto' as const,
        actualEncoding: 'utf8' as const, bom: 'none' as const, lineEnding: 'lf' as const, writable: true,
      },
    }
    mocks.getWorkspaceDiffMock.mockResolvedValue({ state: 'ok', path: 'src/a.ts', diff: 'first', comparison })
    await useWorkspacePanelStore.getState().openPreview('session-dirty-refresh', 'src/a.ts', 'diff')
    const tab = useWorkspacePanelStore.getState().previewTabsBySession['session-dirty-refresh']![0]!
    const dirty = editWorkspaceComparisonSide(tab.comparisonSession!, 'right', 'in memory\n')
    useWorkspacePanelStore.getState().setComparisonSession('session-dirty-refresh', tab.id, dirty)

    mocks.getWorkspaceDiffMock.mockResolvedValue({
      state: 'ok',
      path: 'src/a.ts',
      diff: 'external',
      comparison: { ...comparison, right: { ...comparison.right, content: 'external\n' } },
    })
    await useWorkspacePanelStore.getState().openPreview(
      'session-dirty-refresh', 'src/a.ts', 'diff', undefined, undefined, undefined, undefined, undefined, { force: true },
    )

    expect(mocks.getWorkspaceDiffMock).toHaveBeenCalledTimes(2)
    expect(useWorkspacePanelStore.getState().previewTabsBySession['session-dirty-refresh']?.[0]?.comparisonSession).toMatchObject({
      right: { content: 'in memory\n', originContent: 'after\n', dirty: true },
    })
  })

  it('rebases clean manual anchors when refresh or per-side encoding reload replaces the comparison session', async () => {
    const makeSide = (content: string, requestedEncoding: 'auto' | 'gbk' = 'auto') => ({
      source: { kind: 'working_tree' as const, path: 'src/a.ts', revision: `rev:${content}` },
      exists: true,
      state: 'ok' as const,
      content,
      requestedEncoding,
      actualEncoding: requestedEncoding === 'gbk' ? 'gbk' as const : 'utf8' as const,
      bom: 'none' as const,
      lineEnding: 'lf' as const,
      writable: true,
    })
    const initialComparison = { schemaVersion: 1 as const, left: makeSide('head\nleft anchor\ntail\n'), right: makeSide('head\nright anchor\ntail\n') }
    mocks.getWorkspaceDiffMock.mockResolvedValueOnce({ state: 'ok', path: 'src/a.ts', diff: '', comparison: initialComparison })
    await useWorkspacePanelStore.getState().openPreview('session-anchor-refresh', 'src/a.ts', 'diff')
    const tab = useWorkspacePanelStore.getState().previewTabsBySession['session-anchor-refresh']![0]!
    const added = addWorkspaceManualAlignmentAnchor(tab.comparisonSession!, 2, 2, tab.comparisonSession!.revision)
    if (added.state !== 'ok') throw new Error('anchor add failed')
    useWorkspacePanelStore.getState().setComparisonSession('session-anchor-refresh', tab.id, added.session)

    const reloadedComparison = {
      schemaVersion: 1 as const,
      left: makeSide('inserted\nhead\nleft anchor\ntail\n', 'gbk'),
      right: makeSide('head\nright anchor\ntail\n'),
    }
    mocks.getWorkspaceDiffMock.mockResolvedValueOnce({ state: 'ok', path: 'src/a.ts', diff: '', comparison: reloadedComparison })
    await useWorkspacePanelStore.getState().openPreview(
      'session-anchor-refresh', 'src/a.ts', 'diff', undefined, undefined, { kind: 'workspace' }, 'auto',
      { left: 'gbk', right: 'auto' },
    )

    expect(useWorkspacePanelStore.getState().previewTabsBySession['session-anchor-refresh']?.[0]?.comparisonSession).toMatchObject({
      left: { requestedEncoding: 'gbk', actualEncoding: 'gbk', dirty: false },
      manualAnchors: [{ id: 'manual-anchor-1', state: 'valid', left: { lineNumber: 3 }, right: { lineNumber: 2 } }],
    })
  })

  it('opens a turn-bound diff without falling back to the live workspace diff', async () => {
    mocks.getTurnCheckpointDiffMock.mockResolvedValue({
      state: 'ok',
      path: 'src/a.ts',
      diff: '@@ -1 +1 @@\n-before\n+after',
    })

    await useWorkspacePanelStore.getState().openPreview(
      'session-turn-diff',
      'src/a.ts',
      'diff',
      undefined,
      undefined,
      { kind: 'turn', targetUserMessageId: 'message-1', userMessageIndex: 2 },
    )

    expect(mocks.getTurnCheckpointDiffMock).toHaveBeenCalledWith(
      'session-turn-diff',
      'message-1',
      'src/a.ts',
      2,
    )
    expect(mocks.getWorkspaceDiffMock).not.toHaveBeenCalled()
    expect(useWorkspacePanelStore.getState().previewTabsBySession['session-turn-diff']).toMatchObject([{
      id: 'diff:src/a.ts:turn:message-1',
      kind: 'diff',
      diffSource: { kind: 'turn', targetUserMessageId: 'message-1', userMessageIndex: 2 },
      diff: '@@ -1 +1 @@\n-before\n+after',
    }])
  })

  it('preserves the turn checkpoint source on a file preview for later diff toggling', async () => {
    mocks.getWorkspaceFileMock.mockResolvedValue({
      state: 'ok',
      path: 'src/a.ts',
      content: 'export const a = 1',
      language: 'typescript',
    })

    await useWorkspacePanelStore.getState().openPreview(
      'session-turn-file',
      'src/a.ts',
      'file',
      undefined,
      undefined,
      { kind: 'turn', targetUserMessageId: 'message-1', userMessageIndex: 2 },
    )

    expect(useWorkspacePanelStore.getState().previewTabsBySession['session-turn-file']).toMatchObject([{
      id: 'file:src/a.ts',
      kind: 'file',
      diffSource: { kind: 'turn', targetUserMessageId: 'message-1', userMessageIndex: 2 },
      content: 'export const a = 1',
    }])
  })

  it('reuses an existing successful preview when the same request identity is opened again', async () => {
    mocks.getWorkspaceDiffMock
      .mockResolvedValueOnce({
        state: 'ok',
        path: 'src/a.ts',
        diff: '@@ -1 +1 @@\n-old\n+first',
      })

    await useWorkspacePanelStore.getState().openPreview('session-refresh', 'src/a.ts', 'diff')
    await useWorkspacePanelStore.getState().openPreview('session-refresh', 'src/a.ts', 'diff')

    expect(mocks.getWorkspaceDiffMock).toHaveBeenCalledOnce()
    expect(useWorkspacePanelStore.getState().previewTabsBySession['session-refresh']).toMatchObject([
      {
        id: 'diff:src/a.ts',
        kind: 'diff',
        path: 'src/a.ts',
        diff: '@@ -1 +1 @@\n-old\n+first',
      },
    ])
    expect(useWorkspacePanelStore.getState().loading.previewByTabId['session-refresh::diff:src/a.ts']).toBe(false)
    expect(useWorkspacePanelStore.getState().activePreviewTabIdBySession['session-refresh']).toBe('diff:src/a.ts')
  })

  it('preloads one preview without opening UI and shares the in-flight request with the first open', async () => {
    const preview = deferred<{ state: 'ok'; path: string; diff: string }>()
    mocks.getWorkspaceDiffMock.mockReturnValue(preview.promise)

    const preload = useWorkspacePanelStore.getState().preloadPreview(
      'session-preload', 'src/a.ts', 'diff', { kind: 'workspace' },
    )
    const opening = useWorkspacePanelStore.getState().openPreview(
      'session-preload', 'src/a.ts', 'diff', undefined, undefined, { kind: 'workspace' },
    )

    expect(mocks.getWorkspaceDiffMock).toHaveBeenCalledOnce()
    expect(useWorkspacePanelStore.getState().previewTabsBySession['session-preload']).toEqual([
      expect.objectContaining({ id: 'diff:src/a.ts', state: 'loading' }),
    ])
    preview.resolve({ state: 'ok', path: 'src/a.ts', diff: 'prefetched' })
    await Promise.all([preload, opening])

    expect(useWorkspacePanelStore.getState().previewTabsBySession['session-preload']).toEqual([
      expect.objectContaining({ id: 'diff:src/a.ts', state: 'ok', diff: 'prefetched' }),
    ])
  })

  it('bounds background preview preloads and queues the remainder', async () => {
    const first = deferred<{ state: 'ok'; path: string; content: string; language: string; size: number }>()
    const second = deferred<{ state: 'ok'; path: string; content: string; language: string; size: number }>()
    const third = deferred<{ state: 'ok'; path: string; content: string; language: string; size: number }>()
    mocks.getWorkspaceFileMock.mockImplementation((_sessionId: string, path: string) => {
      if (path === 'src/a.ts') return first.promise
      if (path === 'src/b.ts') return second.promise
      return third.promise
    })

    const preloads = [
      useWorkspacePanelStore.getState().preloadPreview('session-queue', 'src/a.ts', 'file'),
      useWorkspacePanelStore.getState().preloadPreview('session-queue', 'src/b.ts', 'file'),
      useWorkspacePanelStore.getState().preloadPreview('session-queue', 'src/c.ts', 'file'),
    ]

    expect(mocks.getWorkspaceFileMock).toHaveBeenCalledTimes(2)
    first.resolve({ state: 'ok', path: 'src/a.ts', content: 'a', language: 'typescript', size: 1 })
    await first.promise
    await vi.waitFor(() => expect(mocks.getWorkspaceFileMock).toHaveBeenCalledTimes(3))

    second.resolve({ state: 'ok', path: 'src/b.ts', content: 'b', language: 'typescript', size: 1 })
    third.resolve({ state: 'ok', path: 'src/c.ts', content: 'c', language: 'typescript', size: 1 })
    await Promise.all(preloads)
  })

  it('deduplicates repeated background preloads while the request is queued or running', async () => {
    const pending = deferred<{ state: 'ok'; path: string; content: string; language: string; size: number }>()
    mocks.getWorkspaceFileMock.mockReturnValue(pending.promise)

    const preloads = Array.from({ length: 24 }, () => (
      useWorkspacePanelStore.getState().preloadPreview('session-queue-dedupe', 'src/a.ts', 'file')
    ))

    expect(mocks.getWorkspaceFileMock).toHaveBeenCalledOnce()
    pending.resolve({ state: 'ok', path: 'src/a.ts', content: 'a', language: 'typescript', size: 1 })
    await Promise.all(preloads)
    expect(mocks.getWorkspaceFileMock).toHaveBeenCalledOnce()
  })

  it('promotes a clicked file ahead of older background work without duplicating it', async () => {
    const requests = new Map([
      ['src/a.ts', deferred<{ state: 'ok'; path: string; content: string; language: string; size: number }>()],
      ['src/b.ts', deferred<{ state: 'ok'; path: string; content: string; language: string; size: number }>()],
      ['src/c.ts', deferred<{ state: 'ok'; path: string; content: string; language: string; size: number }>()],
      ['src/d.ts', deferred<{ state: 'ok'; path: string; content: string; language: string; size: number }>()],
    ])
    mocks.getWorkspaceFileMock.mockImplementation((_sessionId: string, path: string) => requests.get(path)!.promise)

    const preloads = [...requests.keys()].map((path) => (
      useWorkspacePanelStore.getState().preloadPreview('session-priority-queue', path, 'file')
    ))
    expect(mocks.getWorkspaceFileMock).toHaveBeenCalledTimes(2)

    const clicked = useWorkspacePanelStore.getState().openPreview(
      'session-priority-queue',
      'src/d.ts',
      'file',
    )
    expect(mocks.getWorkspaceFileMock).toHaveBeenCalledTimes(3)
    expect(mocks.getWorkspaceFileMock.mock.calls[2]?.[1]).toBe('src/d.ts')

    requests.get('src/a.ts')!.resolve({
      state: 'ok', path: 'src/a.ts', content: 'a', language: 'typescript', size: 1,
    })
    await vi.waitFor(() => expect(mocks.getWorkspaceFileMock).toHaveBeenCalledTimes(4))

    for (const path of ['src/b.ts', 'src/c.ts', 'src/d.ts']) {
      requests.get(path)!.resolve({ state: 'ok', path, content: path, language: 'typescript', size: path.length })
    }
    await Promise.all([...preloads, clicked])
    expect(mocks.getWorkspaceFileMock).toHaveBeenCalledTimes(4)
  })

  it('keeps a completed preload invisible until open consumes it without another request', async () => {
    mocks.getWorkspaceDiffMock.mockResolvedValue({ state: 'ok', path: 'src/a.ts', diff: 'warm' })

    await useWorkspacePanelStore.getState().preloadPreview(
      'session-warm-cache', 'src/a.ts', 'diff', { kind: 'workspace' },
    )

    expect(useWorkspacePanelStore.getState().previewTabsBySession['session-warm-cache']).toBeUndefined()
    expect(useWorkspacePanelStore.getState().isPanelOpen('session-warm-cache')).toBe(false)

    await useWorkspacePanelStore.getState().openPreview(
      'session-warm-cache', 'src/a.ts', 'diff', undefined, undefined, { kind: 'workspace' },
    )

    expect(mocks.getWorkspaceDiffMock).toHaveBeenCalledOnce()
    expect(useWorkspacePanelStore.getState().previewTabsBySession['session-warm-cache']).toEqual([
      expect.objectContaining({ state: 'ok', diff: 'warm' }),
    ])
  })

  it('hydrates a persisted preview before considering a network request', async () => {
    vi.spyOn(workspacePreviewPersistentCache, 'canUseWorkspacePreviewPersistentCache').mockReturnValue(true)
    vi.spyOn(workspacePreviewPersistentCache, 'getWorkspacePreviewPersistentCache').mockResolvedValue({
      cachedAt: Date.now(),
      payload: {
        kind: 'file',
        result: {
          state: 'ok',
          path: 'docs/cached.md',
          content: 'persisted content',
          language: 'markdown',
          size: 17,
        },
      },
    })

    await useWorkspacePanelStore.getState().openPreview(
      'session-persisted-preview',
      'docs/cached.md',
      'file',
    )

    expect(workspacePreviewPersistentCache.getWorkspacePreviewPersistentCache).toHaveBeenCalledOnce()
    expect(mocks.getWorkspaceFileMock).not.toHaveBeenCalled()
    expect(useWorkspacePanelStore.getState().previewTabsBySession['session-persisted-preview']).toEqual([
      expect.objectContaining({ state: 'ok', content: 'persisted content' }),
    ])
  })

  it('rejects a persisted patch-only workspace diff and upgrades it from the live comparison API', async () => {
    const comparison = {
      schemaVersion: 1 as const,
      left: {
        source: { kind: 'session_baseline' as const, path: 'docs/cached.md', revision: 'left-1' },
        exists: true,
        state: 'ok' as const,
        content: 'old\n',
        contentFingerprint: 'left-1',
        size: 4,
        requestedEncoding: 'auto' as const,
        actualEncoding: 'utf8' as const,
        bom: 'none' as const,
        lineEnding: 'lf' as const,
        writable: false,
      },
      right: {
        source: { kind: 'working_tree' as const, path: 'docs/cached.md', revision: 'right-1' },
        exists: true,
        state: 'ok' as const,
        content: 'new\n',
        contentFingerprint: 'right-1',
        size: 4,
        requestedEncoding: 'auto' as const,
        actualEncoding: 'utf8' as const,
        bom: 'none' as const,
        lineEnding: 'lf' as const,
        writable: true,
      },
    }
    vi.spyOn(workspacePreviewPersistentCache, 'canUseWorkspacePreviewPersistentCache').mockReturnValue(true)
    vi.spyOn(workspacePreviewPersistentCache, 'getWorkspacePreviewPersistentCache').mockResolvedValue({
      cachedAt: Date.now(),
      payload: {
        kind: 'diff',
        result: { state: 'ok', path: 'docs/cached.md', diff: '@@ -1 +1 @@\n-old\n+new' },
      },
    })
    const deletePersisted = vi.spyOn(
      workspacePreviewPersistentCache,
      'deleteWorkspacePreviewPersistentCache',
    ).mockResolvedValue()
    mocks.getWorkspaceDiffMock.mockResolvedValue({
      state: 'ok',
      path: 'docs/cached.md',
      diff: '@@ -1 +1 @@\n-old\n+new',
      comparison,
    })

    await useWorkspacePanelStore.getState().openPreview(
      'session-patch-only-upgrade',
      'docs/cached.md',
      'diff',
    )

    expect(deletePersisted).toHaveBeenCalledOnce()
    expect(mocks.getWorkspaceDiffMock).toHaveBeenCalledOnce()
    expect(useWorkspacePanelStore.getState().previewTabsBySession['session-patch-only-upgrade']).toEqual([
      expect.objectContaining({ state: 'ok', comparison }),
    ])
  })

  it('does not persist a live patch-only workspace response', async () => {
    vi.spyOn(workspacePreviewPersistentCache, 'canUseWorkspacePreviewPersistentCache').mockReturnValue(true)
    vi.spyOn(workspacePreviewPersistentCache, 'getWorkspacePreviewPersistentCache').mockResolvedValue(null)
    const persist = vi.spyOn(
      workspacePreviewPersistentCache,
      'setWorkspacePreviewPersistentCache',
    ).mockResolvedValue()
    mocks.getWorkspaceDiffMock.mockResolvedValue({
      state: 'ok',
      path: 'docs/legacy.md',
      diff: '@@ -1 +1 @@\n-old\n+new',
    })

    await useWorkspacePanelStore.getState().openPreview(
      'session-patch-only-live',
      'docs/legacy.md',
      'diff',
    )

    expect(mocks.getWorkspaceDiffMock).toHaveBeenCalledOnce()
    expect(persist).not.toHaveBeenCalled()
  })

  it('does not let a stale preload overwrite a newer forced result in the cache', async () => {
    const stale = deferred<{ state: 'ok'; path: string; diff: string }>()
    const fresh = deferred<{ state: 'ok'; path: string; diff: string }>()
    mocks.getWorkspaceDiffMock
      .mockReturnValueOnce(stale.promise)
      .mockReturnValueOnce(fresh.promise)

    const preload = useWorkspacePanelStore.getState().preloadPreview(
      'session-preload-race', 'src/a.ts', 'diff', { kind: 'workspace' },
    )
    const forcedOpen = useWorkspacePanelStore.getState().openPreview(
      'session-preload-race', 'src/a.ts', 'diff', undefined, undefined, undefined, undefined, undefined, { force: true },
    )
    fresh.resolve({ state: 'ok', path: 'src/a.ts', diff: 'fresh' })
    await forcedOpen
    stale.resolve({ state: 'ok', path: 'src/a.ts', diff: 'stale' })
    await preload

    useWorkspacePanelStore.getState().closePreview('session-preload-race', 'diff:src/a.ts')
    await useWorkspacePanelStore.getState().openPreview('session-preload-race', 'src/a.ts', 'diff')

    expect(mocks.getWorkspaceDiffMock).toHaveBeenCalledTimes(2)
    expect(useWorkspacePanelStore.getState().previewTabsBySession['session-preload-race']).toEqual([
      expect.objectContaining({ state: 'ok', diff: 'fresh' }),
    ])
  })

  it('does not let a request from before clearSession overwrite a reopened session cache', async () => {
    const stale = deferred<{ state: 'ok'; path: string; diff: string }>()
    const fresh = deferred<{ state: 'ok'; path: string; diff: string }>()
    mocks.getWorkspaceDiffMock
      .mockReturnValueOnce(stale.promise)
      .mockReturnValueOnce(fresh.promise)

    const stalePreload = useWorkspacePanelStore.getState().preloadPreview(
      'session-clear-preload-race', 'src/a.ts', 'diff', { kind: 'workspace' },
    )
    useWorkspacePanelStore.getState().clearSession('session-clear-preload-race')
    const reopened = useWorkspacePanelStore.getState().openPreview(
      'session-clear-preload-race', 'src/a.ts', 'diff',
    )

    fresh.resolve({ state: 'ok', path: 'src/a.ts', diff: 'fresh-after-clear' })
    await reopened
    stale.resolve({ state: 'ok', path: 'src/a.ts', diff: 'stale-before-clear' })
    await stalePreload

    useWorkspacePanelStore.getState().closePreview('session-clear-preload-race', 'diff:src/a.ts')
    await useWorkspacePanelStore.getState().openPreview('session-clear-preload-race', 'src/a.ts', 'diff')

    expect(mocks.getWorkspaceDiffMock).toHaveBeenCalledTimes(2)
    expect(useWorkspacePanelStore.getState().previewTabsBySession['session-clear-preload-race']).toEqual([
      expect.objectContaining({ state: 'ok', diff: 'fresh-after-clear' }),
    ])
  })

  it('keeps the forced default-encoding payload after closing and reopening the tab', async () => {
    mocks.getWorkspaceDiffMock
      .mockResolvedValueOnce({ state: 'ok', path: 'src/a.ts', diff: 'old' })
      .mockResolvedValueOnce({ state: 'ok', path: 'src/a.ts', diff: 'fresh' })

    await useWorkspacePanelStore.getState().openPreview('session-default-encoding-cache', 'src/a.ts', 'diff')
    await useWorkspacePanelStore.getState().openPreview(
      'session-default-encoding-cache', 'src/a.ts', 'diff', undefined, undefined, undefined, undefined, undefined, { force: true },
    )
    useWorkspacePanelStore.getState().closePreview('session-default-encoding-cache', 'diff:src/a.ts')
    await useWorkspacePanelStore.getState().openPreview('session-default-encoding-cache', 'src/a.ts', 'diff')

    expect(mocks.getWorkspaceDiffMock).toHaveBeenCalledTimes(2)
    expect(useWorkspacePanelStore.getState().previewTabsBySession['session-default-encoding-cache']).toEqual([
      expect.objectContaining({ state: 'ok', diff: 'fresh' }),
    ])
  })

  it('invalidates a clean workspace preview after a forced status refresh', async () => {
    mocks.getWorkspaceDiffMock
      .mockResolvedValueOnce({ state: 'ok', path: 'src/a.ts', diff: 'before-turn' })
      .mockResolvedValueOnce({ state: 'ok', path: 'src/a.ts', diff: 'after-turn' })
    mocks.getWorkspaceStatusMock.mockResolvedValue({
      state: 'ok', workDir: '/repo', repoName: 'repo', branch: 'main', isGitRepo: true,
      changedFiles: [{ path: 'src/a.ts', status: 'modified', additions: 1, deletions: 1 }],
    })

    await useWorkspacePanelStore.getState().openPreview('session-turn-invalidates', 'src/a.ts', 'diff')
    await useWorkspacePanelStore.getState().loadStatus('session-turn-invalidates', { force: true })
    await useWorkspacePanelStore.getState().openPreview('session-turn-invalidates', 'src/a.ts', 'diff')

    expect(mocks.getWorkspaceDiffMock).toHaveBeenCalledTimes(2)
    expect(useWorkspacePanelStore.getState().previewTabsBySession['session-turn-invalidates']).toEqual([
      expect.objectContaining({ diff: 'after-turn' }),
    ])
  })

  it('forces a successful preview reload only when explicitly requested', async () => {
    mocks.getWorkspaceDiffMock
      .mockResolvedValueOnce({ state: 'ok', path: 'src/a.ts', diff: 'first' })
      .mockResolvedValueOnce({ state: 'ok', path: 'src/a.ts', diff: 'latest' })

    await useWorkspacePanelStore.getState().openPreview('session-force-refresh', 'src/a.ts', 'diff')
    await useWorkspacePanelStore.getState().openPreview(
      'session-force-refresh', 'src/a.ts', 'diff', undefined, undefined, undefined, undefined, undefined, { force: true },
    )

    expect(mocks.getWorkspaceDiffMock).toHaveBeenCalledTimes(2)
    expect(useWorkspacePanelStore.getState().previewTabsBySession['session-force-refresh']).toEqual([
      expect.objectContaining({ diff: 'latest' }),
    ])
  })

  it('invalidates a cached preview when either comparison encoding changes', async () => {
    mocks.getWorkspaceDiffMock
      .mockResolvedValueOnce({ state: 'ok', path: 'src/a.ts', diff: 'auto' })
      .mockResolvedValueOnce({ state: 'ok', path: 'src/a.ts', diff: 'gbk-right' })

    await useWorkspacePanelStore.getState().openPreview(
      'session-cache-encoding', 'src/a.ts', 'diff', undefined, undefined, undefined, 'auto', { left: 'auto', right: 'auto' },
    )
    await useWorkspacePanelStore.getState().openPreview(
      'session-cache-encoding', 'src/a.ts', 'diff', undefined, undefined, undefined, 'auto', { left: 'auto', right: 'gbk' },
    )

    expect(mocks.getWorkspaceDiffMock).toHaveBeenCalledTimes(2)
    expect(useWorkspacePanelStore.getState().previewTabsBySession['session-cache-encoding']).toEqual([
      expect.objectContaining({ diff: 'gbk-right', comparisonEncodings: { left: 'auto', right: 'gbk' } }),
    ])
  })

  it('keeps the last successful preview payload while a refresh is pending and after it fails', async () => {
    const refresh = deferred<{ state: 'ok'; path: string; diff: string }>()
    mocks.getWorkspaceDiffMock
      .mockResolvedValueOnce({
        state: 'ok',
        path: 'src/a.ts',
        diff: '@@ -1 +1 @@\n-old\n+cached',
      })
      .mockReturnValueOnce(refresh.promise)

    await useWorkspacePanelStore.getState().openPreview('session-stale-refresh', 'src/a.ts', 'diff')
    const refreshPromise = useWorkspacePanelStore.getState().openPreview(
      'session-stale-refresh', 'src/a.ts', 'diff', undefined, undefined, undefined, undefined, undefined, { force: true },
    )
    const previewKey = 'session-stale-refresh::diff:src/a.ts'

    expect(useWorkspacePanelStore.getState().previewTabsBySession['session-stale-refresh']).toEqual([
      expect.objectContaining({ state: 'ok', diff: '@@ -1 +1 @@\n-old\n+cached' }),
    ])
    expect(useWorkspacePanelStore.getState().loading.previewByTabId[previewKey]).toBe(true)

    refresh.reject(new Error('refresh failed'))
    await refreshPromise

    expect(useWorkspacePanelStore.getState().previewTabsBySession['session-stale-refresh']).toEqual([
      expect.objectContaining({ state: 'ok', diff: '@@ -1 +1 @@\n-old\n+cached' }),
    ])
    expect(useWorkspacePanelStore.getState().loading.previewByTabId[previewKey]).toBe(false)
    expect(useWorkspacePanelStore.getState().errors.previewByTabId[previewKey]).toBe('refresh failed')
  })

  it('keeps the last successful file payload and records structured state for a non-ok refresh result', async () => {
    mocks.getWorkspaceFileMock
      .mockResolvedValueOnce({
        state: 'ok',
        path: 'src/a.ts',
        content: 'cached file',
        language: 'typescript',
        size: 11,
      })
      .mockResolvedValueOnce({
        state: 'error',
        path: 'src/a.ts',
      })

    await useWorkspacePanelStore.getState().openPreview('session-file-refresh-error', 'src/a.ts', 'file')
    await useWorkspacePanelStore.getState().openPreview(
      'session-file-refresh-error', 'src/a.ts', 'file', undefined, undefined, undefined, undefined, undefined, { force: true },
    )

    expect(useWorkspacePanelStore.getState().previewTabsBySession['session-file-refresh-error']).toEqual([
      expect.objectContaining({ state: 'ok', content: 'cached file', language: 'typescript' }),
    ])
    expect(useWorkspacePanelStore.getState().errors.previewByTabId['session-file-refresh-error::file:src/a.ts'])
      .toBeNull()
    expect(useWorkspacePanelStore.getState().errors.previewRefreshStateByTabId['session-file-refresh-error::file:src/a.ts'])
      .toBe('error')
  })

  it('keeps the last successful diff payload and records structured state for a non-ok refresh result', async () => {
    mocks.getWorkspaceDiffMock
      .mockResolvedValueOnce({
        state: 'ok',
        path: 'src/a.ts',
        diff: '@@ -1 +1 @@\n-old\n+cached',
      })
      .mockResolvedValueOnce({
        state: 'missing',
        path: 'src/a.ts',
      })

    await useWorkspacePanelStore.getState().openPreview('session-diff-refresh-missing', 'src/a.ts', 'diff')
    await useWorkspacePanelStore.getState().openPreview(
      'session-diff-refresh-missing', 'src/a.ts', 'diff', undefined, undefined, undefined, undefined, undefined, { force: true },
    )

    expect(useWorkspacePanelStore.getState().previewTabsBySession['session-diff-refresh-missing']).toEqual([
      expect.objectContaining({ state: 'ok', diff: '@@ -1 +1 @@\n-old\n+cached' }),
    ])
    expect(useWorkspacePanelStore.getState().errors.previewByTabId['session-diff-refresh-missing::diff:src/a.ts'])
      .toBeNull()
    expect(useWorkspacePanelStore.getState().errors.previewRefreshStateByTabId['session-diff-refresh-missing::diff:src/a.ts'])
      .toBe('missing')
  })

  it('keeps first-load non-ok state on the tab without marking it as a refresh failure', async () => {
    mocks.getWorkspaceDiffMock.mockResolvedValueOnce({
      state: 'missing',
      path: 'src/missing.ts',
    })

    await useWorkspacePanelStore.getState().openPreview('session-initial-missing', 'src/missing.ts', 'diff')

    expect(useWorkspacePanelStore.getState().previewTabsBySession['session-initial-missing']).toEqual([
      expect.objectContaining({ state: 'missing' }),
    ])
    expect(useWorkspacePanelStore.getState().errors.previewByTabId['session-initial-missing::diff:src/missing.ts'])
      .toBeNull()
    expect(useWorkspacePanelStore.getState().errors.previewRefreshStateByTabId['session-initial-missing::diff:src/missing.ts'])
      .toBeNull()
  })

  it('closes exact tab id and preserves sibling preview for the same path', async () => {
    mocks.getWorkspaceFileMock.mockResolvedValue({
      state: 'ok',
      path: 'src/a.ts',
      content: 'export const a = 1',
      language: 'typescript',
      size: 18,
    })
    mocks.getWorkspaceDiffMock.mockResolvedValue({
      state: 'ok',
      path: 'src/a.ts',
      diff: '@@ -1 +1 @@',
    })

    await useWorkspacePanelStore.getState().openPreview('session-close-path', 'src/a.ts', 'file')
    await useWorkspacePanelStore.getState().openPreview('session-close-path', 'src/a.ts', 'diff')

    useWorkspacePanelStore.getState().closePreview('session-close-path', 'diff:src/a.ts')

    expect(useWorkspacePanelStore.getState().previewTabsBySession['session-close-path']).toEqual([
      expect.objectContaining({ id: 'file:src/a.ts' }),
    ])
    expect(useWorkspacePanelStore.getState().activePreviewTabIdBySession['session-close-path']).toBe('file:src/a.ts')
  })

  it('chooses the next sensible active preview when closing the current tab', async () => {
    mocks.getWorkspaceFileMock
      .mockResolvedValueOnce({
        state: 'ok',
        path: 'src/a.ts',
        content: 'a',
        language: 'typescript',
        size: 1,
      })
      .mockResolvedValueOnce({
        state: 'ok',
        path: 'src/b.ts',
        content: 'b',
        language: 'typescript',
        size: 1,
      })
      .mockResolvedValueOnce({
        state: 'ok',
        path: 'src/c.ts',
        content: 'c',
        language: 'typescript',
        size: 1,
      })

    await useWorkspacePanelStore.getState().openPreview('session-close', 'src/a.ts', 'file')
    await useWorkspacePanelStore.getState().openPreview('session-close', 'src/b.ts', 'file')
    await useWorkspacePanelStore.getState().openPreview('session-close', 'src/c.ts', 'file')

    useWorkspacePanelStore.getState().closePreview('session-close', 'file:src/b.ts')

    expect(useWorkspacePanelStore.getState().previewTabsBySession['session-close']).toMatchObject([
      { id: 'file:src/a.ts' },
      { id: 'file:src/c.ts' },
    ])
    expect(useWorkspacePanelStore.getState().activePreviewTabIdBySession['session-close']).toBe('file:src/c.ts')

    useWorkspacePanelStore.getState().closePreview('session-close', 'file:src/c.ts')
    expect(useWorkspacePanelStore.getState().activePreviewTabIdBySession['session-close']).toBe('file:src/a.ts')
  })

  it('closes preview tabs by context-menu scope', () => {
    useWorkspacePanelStore.setState((state) => ({
      ...state,
      previewTabsBySession: {
        ...state.previewTabsBySession,
        'session-preview-scope': [
          { id: 'file:a.ts', path: 'a.ts', kind: 'file', title: 'a.ts', state: 'ok', language: 'typescript', size: 1 },
          { id: 'file:b.ts', path: 'b.ts', kind: 'file', title: 'b.ts', state: 'ok', language: 'typescript', size: 1 },
          { id: 'file:c.ts', path: 'c.ts', kind: 'file', title: 'c.ts', state: 'ok', language: 'typescript', size: 1 },
          { id: 'file:d.ts', path: 'd.ts', kind: 'file', title: 'd.ts', state: 'ok', language: 'typescript', size: 1 },
        ],
      },
      activePreviewTabIdBySession: {
        ...state.activePreviewTabIdBySession,
        'session-preview-scope': 'file:d.ts',
      },
      loading: {
        ...state.loading,
        previewByTabId: {
          ...state.loading.previewByTabId,
          'session-preview-scope::file:c.ts': true,
          'session-preview-scope::file:d.ts': true,
        },
      },
      errors: {
        ...state.errors,
        previewByTabId: {
          ...state.errors.previewByTabId,
          'session-preview-scope::file:c.ts': 'loading',
          'session-preview-scope::file:d.ts': 'loading',
        },
        previewRefreshStateByTabId: {
          ...state.errors.previewRefreshStateByTabId,
          'session-preview-scope::file:c.ts': 'missing',
          'session-preview-scope::file:d.ts': 'error',
        },
      },
    }))

    useWorkspacePanelStore.getState().closePreviewTabs('session-preview-scope', 'file:b.ts', 'right')

    expect(useWorkspacePanelStore.getState().previewTabsBySession['session-preview-scope']).toMatchObject([
      { id: 'file:a.ts' },
      { id: 'file:b.ts' },
    ])
    expect(useWorkspacePanelStore.getState().activePreviewTabIdBySession['session-preview-scope']).toBe('file:b.ts')
    expect(useWorkspacePanelStore.getState().loading.previewByTabId['session-preview-scope::file:c.ts']).toBeUndefined()
    expect(useWorkspacePanelStore.getState().errors.previewByTabId['session-preview-scope::file:d.ts']).toBeUndefined()
    expect(useWorkspacePanelStore.getState().errors.previewRefreshStateByTabId['session-preview-scope::file:c.ts']).toBeUndefined()
    expect(useWorkspacePanelStore.getState().errors.previewRefreshStateByTabId['session-preview-scope::file:d.ts']).toBeUndefined()

    useWorkspacePanelStore.getState().closePreviewTabs('session-preview-scope', 'file:b.ts', 'others')

    expect(useWorkspacePanelStore.getState().previewTabsBySession['session-preview-scope']).toMatchObject([
      { id: 'file:b.ts' },
    ])
    expect(useWorkspacePanelStore.getState().activePreviewTabIdBySession['session-preview-scope']).toBe('file:b.ts')

    useWorkspacePanelStore.getState().closePreviewTabs('session-preview-scope', 'file:b.ts', 'all')

    expect(useWorkspacePanelStore.getState().previewTabsBySession['session-preview-scope']).toBeUndefined()
    expect(useWorkspacePanelStore.getState().activePreviewTabIdBySession['session-preview-scope']).toBeNull()
  })

  it('ignores stale status responses for the same session', async () => {
    const first = deferred<{
      state: 'ok'
      workDir: string
      repoName: string | null
      branch: string | null
      isGitRepo: boolean
      changedFiles: []
      error?: string
    }>()
    const second = deferred<{
      state: 'ok'
      workDir: string
      repoName: string | null
      branch: string | null
      isGitRepo: boolean
      changedFiles: []
      error?: string
    }>()

    mocks.getWorkspaceStatusMock
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise)

    const firstLoad = useWorkspacePanelStore.getState().loadStatus('session-race')
    const secondLoad = useWorkspacePanelStore.getState().loadStatus('session-race', { force: true })

    second.resolve({
      state: 'ok',
      workDir: '/repo',
      repoName: 'repo',
      branch: 'new',
      isGitRepo: true,
      changedFiles: [],
    })
    await secondLoad

    first.resolve({
      state: 'ok',
      workDir: '/repo',
      repoName: 'repo',
      branch: 'old',
      isGitRepo: true,
      changedFiles: [],
    })
    await firstLoad

    expect(useWorkspacePanelStore.getState().statusBySession['session-race']?.branch).toBe('new')
  })

  it('coalesces concurrent status loads and reuses status after success', async () => {
    const status = deferred<{
      state: 'ok'
      workDir: string
      repoName: string | null
      branch: string | null
      isGitRepo: boolean
      changedFiles: []
    }>()
    mocks.getWorkspaceStatusMock.mockReturnValue(status.promise)

    const loads = Array.from({ length: 24 }, () => (
      useWorkspacePanelStore.getState().loadStatus('session-single-flight')
    ))
    expect(mocks.getWorkspaceStatusMock).toHaveBeenCalledTimes(1)

    status.resolve({
      state: 'ok',
      workDir: '/repo',
      repoName: 'repo',
      branch: 'main',
      isGitRepo: true,
      changedFiles: [],
    })
    await Promise.all(loads)

    for (let index = 0; index < 24; index += 1) {
      useWorkspacePanelStore.getState().preloadStatus('session-single-flight')
    }
    expect(mocks.getWorkspaceStatusMock).toHaveBeenCalledTimes(1)

    await useWorkspacePanelStore.getState().loadStatus('session-single-flight')
    expect(mocks.getWorkspaceStatusMock).toHaveBeenCalledTimes(1)
  })

  it('ignores stale preview responses after close and reopen', async () => {
    const first = deferred<{ state: 'ok'; path: string; content: string; language: string; size: number }>()
    const second = deferred<{ state: 'ok'; path: string; content: string; language: string; size: number }>()

    mocks.getWorkspaceFileMock
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise)

    const firstOpen = useWorkspacePanelStore.getState().openPreview('session-preview-race', 'src/a.ts', 'file')
    useWorkspacePanelStore.getState().closePreview('session-preview-race', 'file:src/a.ts')
    const secondOpen = useWorkspacePanelStore.getState().openPreview(
      'session-preview-race', 'src/a.ts', 'file', undefined, undefined, undefined, undefined, undefined, { force: true },
    )

    second.resolve({
      state: 'ok',
      path: 'src/a.ts',
      content: 'new',
      language: 'typescript',
      size: 3,
    })
    await secondOpen

    first.resolve({
      state: 'ok',
      path: 'src/a.ts',
      content: 'old',
      language: 'typescript',
      size: 3,
    })
    await firstOpen

    expect(useWorkspacePanelStore.getState().previewTabsBySession['session-preview-race']).toEqual([
      expect.objectContaining({ id: 'file:src/a.ts', content: 'new' }),
    ])
  })

  it('does not recreate loading or error state when a loading preview is closed before completion', async () => {
    const pending = deferred<{ state: 'ok'; path: string; diff: string }>()
    const tabId = getWorkspacePreviewTabId('src/a.ts', 'diff')
    const previewKey = `session-preview-close::${tabId}`

    mocks.getWorkspaceDiffMock.mockReturnValueOnce(pending.promise)

    const openPromise = useWorkspacePanelStore.getState().openPreview('session-preview-close', 'src/a.ts', 'diff')
    useWorkspacePanelStore.getState().closePreview('session-preview-close', tabId)

    pending.resolve({
      state: 'ok',
      path: 'src/a.ts',
      diff: '@@ -1 +1 @@',
    })
    await openPromise

    expect(useWorkspacePanelStore.getState().previewTabsBySession['session-preview-close']).toBeUndefined()
    expect(useWorkspacePanelStore.getState().activePreviewTabIdBySession['session-preview-close']).toBeNull()
    expect(useWorkspacePanelStore.getState().loading.previewByTabId[previewKey]).toBeUndefined()
    expect(useWorkspacePanelStore.getState().errors.previewByTabId[previewKey]).toBeUndefined()
  })

  it('clears session UI and cached data for clearSession and resetSessionUi', () => {
    useWorkspacePanelStore.setState((state) => ({
      ...state,
      panelBySession: {
        'session-clear': { isOpen: true, activeView: 'all' },
        'session-reset': { isOpen: true, activeView: 'all' },
      },
      modeBySession: {
        'session-clear': 'browser',
        'session-reset': 'browser',
      },
      statusBySession: {
        'session-clear': {
          state: 'ok',
          workDir: '/repo',
          repoName: 'repo',
          branch: 'main',
          isGitRepo: true,
          changedFiles: [],
        },
        'session-reset': {
          state: 'ok',
          workDir: '/repo',
          repoName: 'repo',
          branch: 'main',
          isGitRepo: true,
          changedFiles: [],
        },
      },
      expandedPathsBySession: {
        'session-clear': ['src'],
        'session-reset': ['src'],
      },
      treeBySessionPath: {
        'session-clear': {
          src: { state: 'ok', path: 'src', entries: [] },
        },
        'session-reset': {
          src: { state: 'ok', path: 'src', entries: [] },
        },
      },
      previewTabsBySession: {
        'session-clear': [
          { id: 'file:src/a.ts', path: 'src/a.ts', kind: 'file', title: 'a.ts' },
        ],
        'session-reset': [
          { id: 'file:src/b.ts', path: 'src/b.ts', kind: 'file', title: 'b.ts' },
        ],
      },
      activePreviewTabIdBySession: {
        'session-clear': 'file:src/a.ts',
        'session-reset': 'file:src/b.ts',
      },
      loading: {
        statusBySession: {
          'session-clear': true,
          'session-reset': true,
        },
        treeBySessionPath: {
          'session-clear::src': true,
          'session-reset::src': true,
        },
        previewByTabId: {
          'session-clear::file:src/a.ts': true,
          'session-reset::file:src/b.ts': true,
        },
      },
      errors: {
        statusBySession: {
          'session-clear': 'bad',
          'session-reset': 'bad',
        },
        treeBySessionPath: {
          'session-clear::src': 'bad',
          'session-reset::src': 'bad',
        },
        previewByTabId: {
          'session-clear::file:src/a.ts': 'bad',
          'session-reset::file:src/b.ts': 'bad',
        },
        previewRefreshStateByTabId: {
          'session-clear::file:src/a.ts': 'missing',
          'session-reset::file:src/b.ts': 'error',
        },
      },
    }))

    useWorkspacePanelStore.getState().clearSession('session-clear')
    useWorkspacePanelStore.getState().resetSessionUi('session-reset')

    const state = useWorkspacePanelStore.getState()
    expect(state.panelBySession['session-clear']).toBeUndefined()
    expect(state.panelBySession['session-reset']).toBeUndefined()
    expect(state.modeBySession['session-clear']).toBeUndefined()
    expect(state.modeBySession['session-reset']).toBeUndefined()
    expect(state.statusBySession['session-clear']).toBeUndefined()
    expect(state.statusBySession['session-reset']).toBeUndefined()
    expect(state.expandedPathsBySession['session-clear']).toBeUndefined()
    expect(state.expandedPathsBySession['session-reset']).toBeUndefined()
    expect(state.treeBySessionPath['session-clear']).toBeUndefined()
    expect(state.treeBySessionPath['session-reset']).toBeUndefined()
    expect(state.previewTabsBySession['session-clear']).toBeUndefined()
    expect(state.previewTabsBySession['session-reset']).toBeUndefined()
    expect(state.activePreviewTabIdBySession['session-clear']).toBeUndefined()
    expect(state.activePreviewTabIdBySession['session-reset']).toBeUndefined()
    expect(state.loading.statusBySession['session-clear']).toBeUndefined()
    expect(state.loading.statusBySession['session-reset']).toBeUndefined()
    expect(state.loading.treeBySessionPath['session-clear::src']).toBeUndefined()
    expect(state.loading.treeBySessionPath['session-reset::src']).toBeUndefined()
    expect(state.loading.previewByTabId['session-clear::file:src/a.ts']).toBeUndefined()
    expect(state.loading.previewByTabId['session-reset::file:src/b.ts']).toBeUndefined()
    expect(state.errors.statusBySession['session-clear']).toBeUndefined()
    expect(state.errors.statusBySession['session-reset']).toBeUndefined()
    expect(state.errors.treeBySessionPath['session-clear::src']).toBeUndefined()
    expect(state.errors.treeBySessionPath['session-reset::src']).toBeUndefined()
    expect(state.errors.previewByTabId['session-clear::file:src/a.ts']).toBeUndefined()
    expect(state.errors.previewByTabId['session-reset::file:src/b.ts']).toBeUndefined()
    expect(state.errors.previewRefreshStateByTabId['session-clear::file:src/a.ts']).toBeUndefined()
    expect(state.errors.previewRefreshStateByTabId['session-reset::file:src/b.ts']).toBeUndefined()
  })
})
