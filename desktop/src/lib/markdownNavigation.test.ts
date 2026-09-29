import { describe, expect, it } from 'vitest'
import { resolveMarkdownDocumentLink } from './markdownNavigation'

describe('document-relative Markdown links', () => {
  it.each([
    ['next.md#t1', 'docs/current.md', 'docs/next.md', 't1'],
    ['../其他%20文档.md#章节', 'docs/current.md', '其他 文档.md', '章节'],
    ['./next.MD', 'G:/repo/docs/current.md', 'G:/repo/docs/next.MD', ''],
    ['../next.markdown', '/repo/docs/current.md', '/repo/next.markdown', ''],
    ['../../next.md', 'docs/current.md', '../next.md', ''],
    ['C:/docs/next.md#x', 'docs/current.md', 'C:/docs/next.md', 'x'],
    ['file:///C:/docs/next.md#x', 'docs/current.md', 'C:/docs/next.md', 'x'],
    ['a%23b.md#x', 'docs/current.md', 'docs/a#b.md', 'x'],
  ])('resolves %s from %s', (href, source, path, fragment) => {
    expect(resolveMarkdownDocumentLink(href, source)).toEqual({ path, fragment })
  })
  it.each(['https://example.com/a.md#x', '//example.com/a.md', 'javascript:evil.md', 'mailto:a.md', '#t1', 'bad%xy.md', 'file://remote/share/a.md', 'report.pdf'])('keeps nonlocal or invalid target out: %s', href => {
    expect(resolveMarkdownDocumentLink(href, 'docs/current.md')).toBeNull()
  })
})
