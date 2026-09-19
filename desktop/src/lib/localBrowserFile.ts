import { isLoopbackHostname } from './desktopRuntime'

/** Encode filesystem segments once; # and ? in filenames are not URL suffixes. */
export function localPathToFileUrl(path: string, pathStyle?: 'windows' | 'posix'): string {
  let normalized = path.replace(/\\/g, '/')
  if (normalized.startsWith('//')) throw new Error('Network file paths are not supported in the preview')
  // A single leading slash is drive-rooted on Windows, not a complete absolute
  // path. Never guess its drive or silently reinterpret it against the workspace.
  if (pathStyle === 'windows') {
    normalized = normalized.replace(/^\/([a-z]:\/)/i, '$1')
    if (!/^[a-z]:\//i.test(normalized)) {
      throw new Error(`无法定位本地文件：Windows 文件路径缺少盘符，请使用完整路径或工作区相对路径。路径：${path}`)
    }
  }
  if (!normalized.startsWith('/') && !/^[a-z]:\//i.test(normalized)) {
    throw new Error('An absolute local file path is required')
  }
  const encoded = normalized.split('/').map(encodeURIComponent).join('/')
  return `file://${normalized.startsWith('/') ? '' : '/'}${encoded.replace(/^([a-z])%3A/i, '$1:')}`
}

/** Upgrade only this app's own local-preview URLs, never another HTTP server. */
export function resolveNativeLocalPreview(
  url: string,
  serverUrl: string,
  workDir?: string | null,
  nativePathStyle?: 'windows' | 'posix',
): string {
  const parsed = new URL(url)
  // Workspaces own path semantics; native platform is only the startup fallback
  // when the session's workDir has not arrived yet.
  const pathStyle = workDir
    ? /^(?:[a-z]:[\\/]|\\\\)/i.test(workDir) ? 'windows' : 'posix'
    : nativePathStyle
  // Saved history can already contain a malformed file URL from an older build.
  if (parsed.protocol === 'file:') {
    if (parsed.hostname) throw new Error('Network file paths are not supported in the preview')
    localPathToFileUrl(decodePreviewPath(parsed.pathname), pathStyle)
    return url
  }
  if (!isLoopbackHostname(parsed.hostname) || parsed.origin !== new URL(serverUrl).origin) return url
  if (parsed.pathname.startsWith('/local-file/')) {
    const path = decodePreviewPath(parsed.pathname.slice('/local-file/'.length))
    return localPathToFileUrl(/^[a-z]:\//i.test(path) ? path : `/${path}`, pathStyle) + parsed.search + parsed.hash
  }
  const match = /^\/preview-fs\/[^/]+\/(.*)$/.exec(parsed.pathname)
  if (!match || !workDir) return url
  const relative = decodePreviewPath(match[1]!)
  if (pathStyle === 'windows' && /^[a-z]:(?![\\/])/i.test(relative)) {
    throw new Error(`无法定位本地文件：盘符相对路径缺少根目录分隔符，请使用完整路径。路径：${relative}`)
  }
  // Legacy URLs may carry an absolute path after the session segment.
  const path = /^(?:[a-z]:[\\/]|\/)/i.test(relative)
    ? relative : `${workDir.replace(/[\\/]+$/, '')}/${relative}`
  return new URL(localPathToFileUrl(path, pathStyle) + parsed.search + parsed.hash).href
}

function decodePreviewPath(path: string): string {
  // Encoded separators must not turn an apparent filename into a rooted path,
  // traversal, or UNC path when moving from HTTP to native filesystem semantics.
  if (/%(?:2f|5c)/i.test(path)) {
    throw new Error('无法定位本地文件：文件地址包含编码后的路径分隔符，请重新使用完整文件路径。')
  }
  return decodeURIComponent(path)
}
