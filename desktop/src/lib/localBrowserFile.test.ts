import { describe, expect, it } from 'vitest'
import { localPathToFileUrl, resolveNativeLocalPreview } from './localBrowserFile'

describe('local browser documents', () => {
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
