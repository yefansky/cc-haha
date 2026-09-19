import { describe, expect, it } from 'vitest'
import { localPathToFileUrl, resolveNativeLocalPreview } from './localBrowserFile'

describe('local browser documents', () => {
  const server = 'http://127.0.0.1:1234'
  it.each([
    '/local-file/看板/周报.html',
    '/preview-fs/s//看板/周报.html',
  ])('rejects a drive-less Windows path before upgrading %s', (path) => {
    expect(() => resolveNativeLocalPreview(`${server}${path}`, server, 'G:/项目'))
      .toThrow('Windows 文件路径缺少盘符')
  })
  it('rejects previously saved drive-less native URLs without guessing a drive', () => {
    expect(() => resolveNativeLocalPreview('file:///看板/周报.html', server, 'G:/项目'))
      .toThrow('Windows 文件路径缺少盘符')
    expect(resolveNativeLocalPreview('file:///G:/site/a.html#chart', server, 'G:/项目'))
      .toBe('file:///G:/site/a.html#chart')
  })
  it('uses native Windows semantics when workDir has not arrived, without overriding a POSIX workspace', () => {
    for (const url of [`${server}/local-file/看板/a.html`, 'file:///看板/a.html']) {
      expect(() => resolveNativeLocalPreview(url, server, undefined, 'windows')).toThrow('缺少盘符')
    }
    expect(resolveNativeLocalPreview(`${server}/local-file/tmp/a.html`, server, '/repo', 'windows'))
      .toBe('file:///tmp/a.html')
  })
  it('rejects Windows drive-relative names instead of making them a workspace child', () => {
    expect(() => resolveNativeLocalPreview(`${server}/preview-fs/s/C%3Apage.html`, server, 'G:/项目'))
      .toThrow('盘符相对路径')
    expect(() => resolveNativeLocalPreview(`${server}/local-file/C%3Apage.html`, server, 'G:/项目'))
      .toThrow('缺少盘符')
  })
  it('keeps real POSIX absolute and relative paths on POSIX workspaces', () => {
    expect(resolveNativeLocalPreview(`${server}/local-file/tmp/周报.html`, server, '/repo'))
      .toBe('file:///tmp/%E5%91%A8%E6%8A%A5.html')
    expect(resolveNativeLocalPreview(`${server}/preview-fs/s//tmp/a.html`, server, '/repo'))
      .toBe('file:///tmp/a.html')
    expect(resolveNativeLocalPreview(`${server}/preview-fs/s/docs/a.html`, server, '/repo'))
      .toBe('file:///repo/docs/a.html')
  })
  it.each([
    '/local-file/G%3A/site%2Fpage.html',
    '/local-file/G%3A/site%5Cpage.html',
    '/preview-fs/s/docs%2fpage.html',
    '/preview-fs/s/%5c%5cserver/share/page.html',
  ])('rejects encoded path separators in %s', (path) => {
    expect(() => resolveNativeLocalPreview(`${server}${path}`, server, 'G:/项目'))
      .toThrow('编码后的路径分隔符')
  })
  it.each([
    `${server}/local-file//server/share/page.html`,
    `${server}/preview-fs/s///server/share/page.html`,
    'file://server/share/page.html',
  ])('does not authorize network paths: %s', (url) => {
    expect(() => resolveNativeLocalPreview(url, server, 'G:/项目')).toThrow('Network file paths')
  })
  it('preserves literal punctuation and percent-looking names through one decoding pass', () => {
    expect(resolveNativeLocalPreview(`${server}/preview-fs/s/看板/a%20%231%3F%252F.html#chart`, server, 'G:/项目'))
      .toBe('file:///G:/%E9%A1%B9%E7%9B%AE/%E7%9C%8B%E6%9D%BF/a%20%231%3F%252F.html#chart')
    expect(resolveNativeLocalPreview(`${server}/preview-fs/s//G:/site/page.html`, server, 'G:/项目'))
      .toBe('file:///G:/site/page.html')
  })
  it('preserves Chinese, spaces and literal URL punctuation on Windows', () => {
    const url = localPathToFileUrl('G:\\看板\\a #1?.html')
    expect(url).toBe('file:///G:/%E7%9C%8B%E6%9D%BF/a%20%231%3F.html')
    expect(new URL('./二页.html', url).href).toBe('file:///G:/%E7%9C%8B%E6%9D%BF/%E4%BA%8C%E9%A1%B5.html')
    expect(new URL('../assets/app.js', url).href).toBe('file:///G:/assets/app.js')
  })
  it('upgrades only the configured server and preserves anchors', () => {
    const server = 'http://127.0.0.1:1234'
    expect(resolveNativeLocalPreview(`${server}/local-file/G%3A/site/a%20b.html#chart`, server))
      .toBe('file:///G:/site/a%20b.html#chart')
    expect(resolveNativeLocalPreview(`${server}/preview-fs/s/docs/page.html`, server, 'G:/项目'))
      .toBe('file:///G:/%E9%A1%B9%E7%9B%AE/docs/page.html')
    const other = 'https://example.com/local-file/etc/passwd'
    expect(resolveNativeLocalPreview(other, server, '/repo')).toBe(other)
    expect(resolveNativeLocalPreview(other, 'https://example.com', '/repo')).toBe(other)
    expect(() => localPathToFileUrl('//server/share/a.html')).toThrow()
  })
})
