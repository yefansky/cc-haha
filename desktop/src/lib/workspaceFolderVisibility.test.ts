import { describe, expect, it } from 'vitest'
import { isWorkspaceFolderEntryVisible, isWorkspacePathVisible } from './workspaceFolderVisibility'

describe('workspaceFolderVisibility', () => {
  it('hides only underscore and dot prefixed directory entries by default', () => {
    for (const name of ['.git', '_local', '__pycache__']) {
      expect(isWorkspaceFolderEntryVisible({ name, isDirectory: true }, false)).toBe(false)
      expect(isWorkspaceFolderEntryVisible({ name, isDirectory: true }, true)).toBe(true)
      expect(isWorkspaceFolderEntryVisible({ name, isDirectory: false }, false)).toBe(true)
    }
    expect(isWorkspaceFolderEntryVisible({ name: 'docs', isDirectory: true }, false)).toBe(true)
    expect(isWorkspaceFolderEntryVisible({ name: 'my_folder', isDirectory: true }, false)).toBe(true)
  })

  it('filters descendants of hidden directories while preserving dot files in visible directories', () => {
    for (const path of ['.git/config', 'docs/_cache/file.txt', 'docs\\.cache\\file.txt']) {
      expect(isWorkspacePathVisible(path, false, false)).toBe(false)
      expect(isWorkspacePathVisible(path, false, true)).toBe(true)
    }
    for (const path of ['.gitignore', 'docs/.env', 'docs/_index.md', './docs/readme.md']) {
      expect(isWorkspacePathVisible(path, false, false)).toBe(true)
    }
  })

  it('includes the final segment only for directories and supports trailing separators', () => {
    expect(isWorkspacePathVisible('docs/.cache', true, false)).toBe(false)
    expect(isWorkspacePathVisible('docs/_cache/', true, false)).toBe(false)
    expect(isWorkspacePathVisible('docs/_cache', false, false)).toBe(true)
    expect(isWorkspacePathVisible('docs/visible/', true, false)).toBe(true)
    expect(isWorkspacePathVisible('', true, false)).toBe(true)
  })
})
