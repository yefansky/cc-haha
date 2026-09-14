import { isLoopbackHostname } from './desktopRuntime'

/** Encode filesystem segments once; # and ? in filenames are not URL suffixes. */
export function localPathToFileUrl(path: string): string {
  const normalized = path.replace(/\\/g, '/')
  if (normalized.startsWith('//')) throw new Error('Network file paths are not supported in the preview')
  if (!normalized.startsWith('/') && !/^[a-z]:\//i.test(normalized)) {
    throw new Error('An absolute local file path is required')
  }
  const encoded = normalized.split('/').map(encodeURIComponent).join('/')
  return `file://${normalized.startsWith('/') ? '' : '/'}${encoded.replace(/^([a-z])%3A/i, '$1:')}`
}

/** Upgrade only this app's own local-preview URLs, never another HTTP server. */
export function resolveNativeLocalPreview(url: string, serverUrl: string, workDir?: string | null): string {
  const parsed = new URL(url)
  if (!isLoopbackHostname(parsed.hostname) || parsed.origin !== new URL(serverUrl).origin) return url
  if (parsed.pathname.startsWith('/local-file/')) {
    const path = decodeURIComponent(parsed.pathname.slice('/local-file/'.length))
    return localPathToFileUrl(/^[a-z]:\//i.test(path) ? path : `/${path}`) + parsed.search + parsed.hash
  }
  const match = /^\/preview-fs\/[^/]+\/(.*)$/.exec(parsed.pathname)
  if (!match || !workDir) return url
  const relative = decodeURIComponent(match[1]!)
  // Legacy URLs may carry an absolute path after the session segment.
  const path = /^(?:[a-z]:[\\/]|\/)/i.test(relative)
    ? relative : `${workDir.replace(/[\\/]+$/, '')}/${relative}`
  return new URL(localPathToFileUrl(path) + parsed.search + parsed.hash).href
}
