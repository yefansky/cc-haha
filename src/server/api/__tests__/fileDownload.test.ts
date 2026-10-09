import { afterAll, describe, expect, it } from 'bun:test'
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import * as path from 'node:path'
import { handlePreviewFs } from '../previewFs'
import { handleLocalFile } from '../localFile'

const root = mkdtempSync(path.join(homedir(), '.download-test-'))
afterAll(() => rmSync(root, { recursive: true, force: true }))
const resolveWorkDir = async (id: string) => id === 's' ? root : null
const html = '<html><head></head><body><img src="/image.png">原始报告</body></html>'
const md = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('# 报告\r\n' + '内容\r\n'.repeat(100000))])
writeFileSync(path.join(root, '报告 #1.html'), html)
writeFileSync(path.join(root, '报告.md'), md)
mkdirSync(path.join(root, 'folder'))
function request(name: string, download = true) {
  return new URL(`http://localhost/preview-fs/s/${encodeURIComponent(name)}${download ? '?download=1' : ''}`)
}
describe('file downloads', () => {
  it('downloads original HTML bytes with a Unicode attachment name; viewing still transforms HTML', async () => {
    const response = await handlePreviewFs(request('报告 #1.html'), resolveWorkDir)
    expect(response.status).toBe(200)
    expect(response.headers.get('content-disposition')).toContain("filename*=UTF-8''%E6%8A%A5%E5%91%8A%20%231.html")
    expect(response.headers.get('content-type')).toBe('application/octet-stream')
    expect(response.headers.get('access-control-expose-headers')).toBe('Content-Disposition')
    expect(await response.text()).toBe(html)
    const preview = await handlePreviewFs(request('报告 #1.html', false), resolveWorkDir)
    expect(preview.headers.get('content-disposition')).toBeNull()
    expect(preview.headers.get('content-type')).toContain('text/html')
    expect(await preview.text()).toContain('<base href=')
  })
  it('preserves large Markdown, BOM and CRLF rather than saving the truncated preview', async () => {
    const response = await handlePreviewFs(request('报告.md'), resolveWorkDir)
    expect(Buffer.from(await response.arrayBuffer())).toEqual(md)
  })
  it('supports absolute-path downloads and leaves inline behavior intact', async () => {
    const encoded = path.join(root, '报告.md').replace(/\\/g, '/').split('/').map(encodeURIComponent).join('/')
    const url = new URL(`http://localhost/local-file/${encoded.replace(/^\//, '')}`)
    const inline = await handleLocalFile(url)
    expect(inline.headers.get('content-disposition')).toBeNull()
    url.searchParams.set('download', '1')
    const download = await handleLocalFile(url)
    expect(download.headers.get('content-disposition')).toContain('attachment;')
    expect(Buffer.from(await download.arrayBuffer())).toEqual(md)
  })
  it('retains range support, missing-file checks and workspace boundary checks', async () => {
    const response = await handlePreviewFs(request('报告.md'), resolveWorkDir, new Headers({ range: 'bytes=0-2' }))
    expect(response.status).toBe(206)
    expect(Buffer.from(await response.arrayBuffer())).toEqual(md.subarray(0, 3))
    expect((await handlePreviewFs(request('missing.md'), resolveWorkDir)).status).toBe(404)
    expect((await handlePreviewFs(request('folder'), resolveWorkDir)).status).toBe(404)
    expect((await handlePreviewFs(request('../escape.md'), resolveWorkDir)).status).toBe(403)
    expect((await handlePreviewFs(new URL('http://localhost/preview-fs/unknown/a.md?download=1'), resolveWorkDir)).status).toBe(404)
  })
})
