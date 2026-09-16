import { describe, expect, it } from 'vitest'
import { resolveAssistantFileLink as resolve } from './assistantFileLink'

describe('assistant file link targets and titles', () => {
  it('anchors source files to unique turn evidence and preserves line/column', () => {
    expect(resolve('send.py:12:3', { workDir: 'G:/repo', referencedFiles: ['G:/repo/项目/scripts/send.py'] }))
      .toEqual({ href: 'G:/repo/项目/scripts/send.py:12:3', title: 'G:/repo/项目/scripts/send.py:12:3' })
  })
  it('does not guess among duplicate basenames', () => {
    expect(resolve('send.py', { workDir: 'G:/repo', changedFiles: ['G:/repo/a/send.py', 'G:/repo/b/send.py'] }))
      .toEqual({ href: 'send.py', title: 'send.py\n文件引用未唯一定位' })
  })
  it('uses a unique suffix before basename ambiguity and deduplicates evidence', () => {
    const file = 'G:/repo/项目/scripts/send.py'
    expect(resolve('scripts/send.py', { workDir: 'G:/repo', changedFiles: [file, 'G:/repo/other/send.py'], referencedFiles: [file] }).title).toBe(file)
  })
  it('preserves existing document reconciliation', () => {
    expect(resolve('notes.md#L42', { workDir: 'G:/repo', changedFiles: ['G:/repo/docs/notes.md'] }))
      .toEqual({ href: 'docs/notes.md:42', title: 'G:/repo/docs/notes.md:42' })
  })
  it('uses the same workspace-relative fallback as the open-with menu', () => {
    expect(resolve('src/send.py', { workDir: 'G:\\my repo' })).toEqual({ href: 'src/send.py', title: 'G:/my repo/src/send.py' })
  })
  it('preserves external absolute paths, Chinese and spaces', () => {
    const file = 'D:/私人 文件/send.py'
    expect(resolve(file, { workDir: 'G:/repo' })).toEqual({ href: file, title: file })
  })
  it('does not claim unresolved home or missing workspace paths are absolute', () => {
    expect(resolve('send.py', {}).title).toBe('send.py\n完整路径尚未解析')
    expect(resolve('~/send.py', { workDir: 'G:/repo' }).title).toContain('完整路径尚未解析')
  })
  it('leaves remote links and anchors alone', () => {
    expect(resolve('https://example.com/send.py', {})).toEqual({ href: 'https://example.com/send.py' })
    expect(resolve('#section', {})).toEqual({ href: '#section' })
  })
})


it('decodes explicit Chinese paths without decoding separators or double escapes', () => {
  expect(resolve('scripts/%E4%B8%AD%E6%96%87%20send.py', { workDir: 'G:/repo' }).title).toBe('G:/repo/scripts/中文 send.py')
  expect(resolve('scripts%2Fsend.py', { workDir: 'G:/repo' })).toEqual({ href: 'scripts%2Fsend.py' })
  expect(resolve('scripts/%2520send.py', { workDir: 'G:/repo' })).toEqual({ href: 'scripts/%2520send.py' })
})

it('does not crash rendering on malformed file URL escapes', () => {
  expect(resolve('file:///tmp/%zz.py', {})).toEqual({ href: 'file:///tmp/%zz.py' })
})
