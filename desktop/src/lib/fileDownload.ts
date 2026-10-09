import { getBaseUrl } from '../api/client'
import { isAbsoluteLocalPath, localFileUrl } from './handlePreviewLink'

export function workspaceFileDownloadUrl(sessionId: string, filePath: string, workDir?: string): string {
  const base = getBaseUrl().replace(/\/$/, '')
  let normalized = filePath.replace(/\\/g, '/')
  const root = workDir?.replace(/\\/g, '/').replace(/\/+$/, '')
  // Workspace authorization is session-scoped. A workspace file does not
  // necessarily have a global /local-file grant, especially after restart.
  if (root) {
    const windows = /^[a-z]:\//i.test(normalized)
    const candidate = windows ? normalized.toLowerCase() : normalized
    const prefix = `${windows ? root.toLowerCase() : root}/`
    if (candidate.startsWith(prefix)) normalized = normalized.slice(root.length + 1)
  }
  const url = isAbsoluteLocalPath(normalized)
    ? localFileUrl(base, normalized)
    : `${base}/preview-fs/${encodeURIComponent(sessionId)}/${normalized.split('/').map(encodeURIComponent).join('/')}`
  return `${url}?download=1`
}

/** Never turn an arbitrary web page into a credential-bearing download. */
export function previewFileDownloadUrl(value: string): string | null {
  try {
    const url = new URL(value)
    const base = new URL(getBaseUrl())
    if (url.origin !== base.origin || url.username || url.password) return null
    const prefix = base.pathname.replace(/\/$/, '')
    const route = url.pathname.slice(prefix.length)
    if (!url.pathname.startsWith(`${prefix}/`) ||
      !/^\/(?:local-file\/.+|preview-fs\/[^/]+\/.+)$/.test(route)) return null
    url.searchParams.set('download', '1')
    url.hash = ''
    return url.href
  } catch {
    return null
  }
}
