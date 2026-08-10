import { describe, expect, it } from 'vitest'
import { translate, type Locale } from '../../i18n'
import { getFileIdentity, getWorkspaceStatusLabel } from './fileIdentity'

describe('getFileIdentity', () => {
  it.each([
    ['src/App.tsx', { shortLabel: 'TSX', languageLabel: 'TypeScript React', icon: 'code' }],
    ['main.py', { shortLabel: 'PY', languageLabel: 'Python', icon: 'code' }],
    ['cmd/main.go', { shortLabel: 'GO', languageLabel: 'Go', icon: 'code' }],
    ['src/lib.rs', { shortLabel: 'RS', languageLabel: 'Rust', icon: 'code' }],
    ['Source/main.cpp', { shortLabel: 'C++', languageLabel: 'C++', icon: 'code' }],
    ['Include/runtime.hpp', { shortLabel: 'H++', languageLabel: 'C++ header', icon: 'code' }],
    ['scripts/bootstrap.lua', { shortLabel: 'LUA', languageLabel: 'Lua', icon: 'code' }],
    ['scripts/build.bat', { shortLabel: 'BAT', languageLabel: 'Windows batch', icon: 'code' }],
    ['src/Program.cs', { shortLabel: 'C#', languageLabel: 'C#', icon: 'code' }],
    ['Game.sln', { shortLabel: 'SLN', languageLabel: 'Visual Studio solution', icon: 'config' }],
    ['Game.vcproj', { shortLabel: 'VCP', languageLabel: 'Visual C++ project', icon: 'config' }],
    ['Game.vcxproj', { shortLabel: 'VCX', languageLabel: 'Visual C++ project', icon: 'config' }],
    ['data/report.csv', { shortLabel: 'CSV', languageLabel: 'CSV table', icon: 'document' }],
    ['data/report.tab', { shortLabel: 'TAB', languageLabel: 'Tab-delimited table', icon: 'document' }],
    ['config.yaml', { shortLabel: 'YAML', languageLabel: 'YAML', icon: 'config' }],
    ['docker/Dockerfile', { shortLabel: 'DKR', languageLabel: 'Dockerfile', icon: 'config' }],
    ['Makefile', { shortLabel: 'MAKE', languageLabel: 'Makefile', icon: 'config' }],
    ['.gitignore', { shortLabel: 'GIT', languageLabel: 'Git ignore', icon: 'config' }],
    ['notes', { shortLabel: 'TXT', languageLabel: 'Plain text', icon: 'document' }],
    ['assets/hero.png', { shortLabel: 'IMG', languageLabel: 'PNG image', icon: 'image' }],
  ])('recognizes %s', (path, expected) => {
    expect(getFileIdentity(path)).toEqual(expected)
  })
})

describe('getWorkspaceStatusLabel', () => {
  const locales: Locale[] = ['en', 'zh', 'zh-TW', 'jp', 'kr']

  it.each(locales)('returns readable labels for every status in %s', (locale) => {
    const t = (key: Parameters<typeof translate>[1]) => translate(locale, key)
    const labels = [
      'modified',
      'added',
      'deleted',
      'renamed',
      'untracked',
      'copied',
      'type_changed',
      'unknown',
    ].map((status) => getWorkspaceStatusLabel(status as Parameters<typeof getWorkspaceStatusLabel>[0], t))

    expect(labels.every((label) => label.length > 0 && !label.startsWith('workspace.status.'))).toBe(true)
  })
})
