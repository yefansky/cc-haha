import { afterEach, describe, expect, it } from 'vitest'
import { getDefaultBaseUrl, setBaseUrl } from '../api/client'
import { previewFileDownloadUrl, workspaceFileDownloadUrl } from './fileDownload'
afterEach(() => setBaseUrl(getDefaultBaseUrl()))
describe('file download URLs', () => {
  it('uses the current gateway and encodes reserved filename characters exactly once', () => {
    setBaseUrl('https://gateway.example')
    expect(workspaceFileDownloadUrl('s', 'docs/报告 #1?%25.md')).toBe('https://gateway.example/preview-fs/s/docs/%E6%8A%A5%E5%91%8A%20%231%3F%2525.md?download=1')
    expect(workspaceFileDownloadUrl('s', 'G:\\报告\\a.html')).toBe('https://gateway.example/local-file/G%3A/%E6%8A%A5%E5%91%8A/a.html?download=1')
  })
  it('only adds downloads to current-server local file routes', () => {
    setBaseUrl('https://gateway.example')
    expect(previewFileDownloadUrl('https://gateway.example/preview-fs/s/a.html#section')).toBe('https://gateway.example/preview-fs/s/a.html?download=1')
    for (const value of ['https://other.example/local-file/a.html', 'https://gateway.example/api/config', 'javascript:alert(1)', 'https://user:pass@gateway.example/local-file/a']) {
      expect(previewFileDownloadUrl(value)).toBeNull()
    }
  })
  it('keeps absolute files inside the workspace on the session authorization route after restart', () => {
    setBaseUrl('https://gateway.example')
    expect(workspaceFileDownloadUrl('s', 'G:\\Repo\\docs\\报告.md', 'g:/repo')).toBe('https://gateway.example/preview-fs/s/docs/%E6%8A%A5%E5%91%8A.md?download=1')
    expect(workspaceFileDownloadUrl('s', '/repo/docs/a.md', '/repo')).toBe('https://gateway.example/preview-fs/s/docs/a.md?download=1')
    expect(workspaceFileDownloadUrl('s', '/repo-other/a.md', '/repo')).toBe('https://gateway.example/local-file/repo-other/a.md?download=1')
  })
})
