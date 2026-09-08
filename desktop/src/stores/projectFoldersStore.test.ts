import { describe, expect, it } from 'vitest'
import { createProjectFoldersStore, normalizeProjectFolderKey, PROJECT_FOLDERS_STORAGE_KEY } from './projectFoldersStore'

function memoryStorage() {
  const entries = new Map<string, string>()
  return { getItem: (key: string) => entries.get(key) ?? null, setItem: (key: string, value: string) => { entries.set(key, value) } }
}

describe('projectFoldersStore', () => {
  it('isolates projects and restores attachments, pins and visibility after restart', () => {
    const storage = memoryStorage()
    const store = createProjectFoldersStore(storage)
    store.getState().addMountedRoot('C:/Project', 'D:/Documents')
    store.getState().pinFolder('c:\\project', 'D:/Documents/Guide')
    store.getState().setShowHiddenFolders('C:/Project', true)
    store.getState().initializeProject('C:/Other')
    const restored = createProjectFoldersStore(storage).getState()
    expect(restored.projects['c:/project']).toEqual({ mountedRoots: [{ path: 'D:/Documents', label: 'Documents' }], pinnedFolders: [{ path: 'D:/Documents/Guide', label: 'Guide' }], showHiddenFolders: true })
    expect(restored.projects['c:/other']?.mountedRoots).toEqual([])
    expect(restored.projects['c:/other']?.pinnedFolders).toEqual([])
  })

  it('normalizes Windows paths and rejects relative paths and invalid roots', () => {
    const store = createProjectFoldersStore(memoryStorage())
    expect(store.getState().addMountedRoot('C:/Project', 'D:\\Docs\\')).toBe(true)
    expect(store.getState().addMountedRoot('c:\\project', 'd:/DOCS')).toBe(false)
    for (const path of ['relative', 'C:relative', '//server', 'D:/../../escape', 'D:/bad\u0000name']) {
      expect(store.getState().addMountedRoot('C:/Project', path)).toBe(false)
    }
    expect(normalizeProjectFolderKey('\\\\Server\\Share\\A')).toBe('//server/share/a')
    expect(normalizeProjectFolderKey('/Repo/A')).not.toBe(normalizeProjectFolderKey('/repo/a'))
  })

  it('claims the legacy global fixture once and retains recoverable legacy data', () => {
    const storage = memoryStorage()
    const fixture = JSON.stringify([{ path: 'D:\\Legacy', label: 'My reference folder' }])
    storage.setItem('cc-haha-workspace-mounted-roots', fixture)
    const store = createProjectFoldersStore(storage)
    expect(store.getState().projects).toEqual({})
    store.getState().initializeProject('C:/First')
    expect(store.getState().projects['c:/first']?.mountedRoots).toHaveLength(1)
    expect(store.getState().projects['c:/first']?.mountedRoots[0]?.label).toBe('My reference folder')
    const restored = createProjectFoldersStore(storage)
    restored.getState().initializeProject('C:/Second')
    expect(restored.getState().projects['c:/second']?.mountedRoots).toEqual([])
    expect(storage.getItem('cc-haha-workspace-mounted-roots')).toBe(fixture)
    expect(JSON.parse(storage.getItem(PROJECT_FOLDERS_STORAGE_KEY)!).version).toBe(1)
  })

  it('removes pins inside a detached root without removing sibling-prefix or project pins', () => {
    const store = createProjectFoldersStore(memoryStorage())
    const actions = store.getState()
    actions.addMountedRoot('C:/Project', 'D:/Docs')
    actions.addMountedRoot('C:/Project', 'D:/Docs-old')
    expect(actions.pinFolder('C:/Project', 'E:/Outside')).toBe(false)
    actions.pinFolder('C:/Project', 'D:/Docs/Sub')
    actions.pinFolder('C:/Project', 'D:/Docs-old/Sub')
    actions.pinFolder('C:/Project', 'C:/Project/src')
    expect(actions.pinFolder('C:/Project', 'c:\\project\\SRC')).toBe(false)
    actions.removeMountedRoot('C:/Project', 'd:/DOCS')
    expect(store.getState().projects['c:/project']?.pinnedFolders.map(item => item.path)).toEqual(['D:/Docs-old/Sub', 'C:/Project/src'])
    actions.unpinFolder('C:/Project', 'C:/Project/src')
    expect(store.getState().projects['c:/project']?.pinnedFolders).toHaveLength(1)
  })

  it('remains usable with unavailable or corrupted storage', () => {
    const unavailable = { getItem: () => { throw new Error('disabled') }, setItem: () => { throw new Error('disabled') } }
    const store = createProjectFoldersStore(unavailable)
    expect(store.getState().addMountedRoot('C:/Project', 'D:/Docs')).toBe(true)
    expect(store.getState().projects['c:/project']?.mountedRoots).toHaveLength(1)
    const corrupted = memoryStorage()
    corrupted.setItem(PROJECT_FOLDERS_STORAGE_KEY, '{bad json')
    expect(createProjectFoldersStore(corrupted).getState().projects).toEqual({})
  })

  it('restores only valid folders and treats drive roots and UNC shares as bounded roots', () => {
    const storage = memoryStorage()
    storage.setItem(PROJECT_FOLDERS_STORAGE_KEY, JSON.stringify({ version: 1, projects: {
      'C:/Project': { mountedRoots: [null, { path: 5 }, { path: 'D:/' }], pinnedFolders: [{ path: 'E:/elsewhere' }, { path: 'D:/Sub' }], showHiddenFolders: 'true' },
      relative: { mountedRoots: [] },
    } }))
    const store = createProjectFoldersStore(storage)
    expect(store.getState().projects['c:/project']).toEqual({ mountedRoots: [{ path: 'D:/', label: 'D:' }], pinnedFolders: [{ path: 'D:/Sub', label: 'Sub' }], showHiddenFolders: false })
    expect(store.getState().projects.relative).toBeUndefined()
    expect(store.getState().addMountedRoot('C:/Project', '//Server/Share')).toBe(true)
    expect(store.getState().pinFolder('C:/Project', '//server/share/Sub')).toBe(true)
    expect(store.getState().pinFolder('C:/Project', '//server/share-other/Sub')).toBe(false)
    expect(normalizeProjectFolderKey('//server/share/../Other')).toBe('')
    expect(normalizeProjectFolderKey('C:/')).toBe('c:/')
  })
})
