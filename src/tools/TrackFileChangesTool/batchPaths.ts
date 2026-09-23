import { readScanDirectory, withScanIO } from './scanIO.js'
import { lstat, open } from 'node:fs/promises'
import { isAbsolute, join, relative } from 'node:path'
import picomatch from 'picomatch'
import { expandPath } from '../../utils/path.js'

export type TrackingPathInput = {
  manifest_path?: string
  file_paths?: string[]
  patterns?: Array<{ base_dir: string; include: string[]; exclude?: string[] }>
}
const MAX_FILES = 500
const MAX_ENTRIES = 20_000
const METADATA = new Set(['.git', '.svn', '.hg'])

/** Select paths only; neither glob expressions nor supplied strings are executed. */
export async function resolveTrackingPaths(input: TrackingPathInput, options: {
  checkPath: (path: string) => Promise<{ allowed: boolean; reason?: string }>
}): Promise<{ filePaths: string[]; failed: Array<{ path: string; reason: string }>; truncated: boolean }> {
  const filePaths: string[] = []
  const failed: Array<{ path: string; reason: string }> = []
  const seen = new Set<string>()
  let truncated = false
  let visited = 0
  let pathBytes = 0
  const check = async (path: string) => {
    const permission = await options.checkPath(path)
    if (!permission.allowed) failed.push({ path, reason: permission.reason || 'Read permission required' })
    return permission.allowed
  }
  const add = async (path: string) => {
    const key = process.platform === 'win32' ? path.toLowerCase() : path
    if (seen.has(key)) return
    seen.add(key)
    if (filePaths.length >= MAX_FILES || pathBytes + Buffer.byteLength(JSON.stringify(path), 'utf8') > 48_000) { truncated = true; return }
    if (await check(path)) { filePaths.push(path); pathBytes += Buffer.byteLength(JSON.stringify(path), 'utf8') }
  }
  for (const path of input.file_paths ?? []) {
    try { await add(expandPath(path)) } catch (error) { failed.push({ path, reason: String(error) }) }
    if (truncated) break
  }
  if (input.manifest_path && !truncated) {
    const manifest = expandPath(input.manifest_path)
    try {
      if (await check(manifest)) {
        const handle = await open(manifest, 'r')
        let text: string
        try {
          const stat = await handle.stat()
          if (!stat.isFile() || stat.size > 1024 * 1024) throw new Error('Manifest must be a regular file of at most 1 MiB')
          const buffer = Buffer.alloc(1024 * 1024 + 1)
          const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0)
          if (bytesRead > 1024 * 1024) throw new Error('Manifest exceeds 1 MiB')
          text = buffer.subarray(0, bytesRead).toString('utf8').replace(/^\uFEFF/, '')
        } finally { await handle.close() }
        const paths: unknown = text.trimStart().startsWith('[') ? JSON.parse(text) : text.split(/\r?\n/).filter(line => line.trim())
        if (!Array.isArray(paths) || paths.some(p => typeof p !== 'string' || !isAbsolute(p) || /[\x00-\x1f]/.test(p))) {
          throw new Error('Manifest must contain only absolute file paths (JSON string array or one path per line)')
        }
        for (const path of paths) { await add(expandPath(path)); if (truncated) break }
      }
    } catch (error) { failed.push({ path: manifest, reason: String(error) }) }
  }
  for (const batch of input.patterns ?? []) {
    if (truncated) break
    const root = expandPath(batch.base_dir)
    try {
      if (!await check(root)) continue
      const positive = batch.include.filter(pattern => !pattern.startsWith('!'))
      const excluded = [...(batch.exclude ?? []), ...batch.include.filter(pattern => pattern.startsWith('!')).map(pattern => pattern.slice(1))]
      const patterns = [...positive, ...excluded]
      if (!positive.length || patterns.some(pattern => isAbsolute(pattern) || /^[a-z]:/i.test(pattern) || pattern.split(/[\\/]/).includes('..'))) {
        failed.push({ path: root, reason: 'Use relative glob patterns within base_dir; parent traversal is not supported' })
        continue
      }
      const matches = picomatch(positive, { dot: true })
      // Do not walk unrelated subtrees before applying include patterns. A
      // narrow include in a large workspace must not exhaust MAX_ENTRIES there.
      const bases = positive.map(pattern => picomatch.scan(pattern, { unescape: true }).base.replace(/^\.\//, '').replace(/\/$/, ''))
      const mayContainMatch = (directory: string) => bases.some(base => !base || base === '.'
        || base === directory || base.startsWith(directory + '/') || directory.startsWith(base + '/'))
      const excludes = excluded.length ? picomatch(excluded, { dot: true }) : () => false
      const rootStat = await withScanIO(() => lstat(root))
      if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
        failed.push({ path: root, reason: 'Glob base must be a real directory' }); continue
      }
      const visit = async (directory: string): Promise<void> => {
        // Permissions are checked before descending, not after enumerating a denied subtree.
        const entries = await readScanDirectory(directory)
        for (const entry of entries) {
          if (++visited > MAX_ENTRIES) { truncated = true; return }
          const path = join(directory, entry.name)
          const name = relative(root, path).replace(/\\/g, '/')
          if (excludes(name) || (entry.isDirectory() && excludes(name + '/'))) continue
          if ((entry.isDirectory() || entry.isSymbolicLink()) && !mayContainMatch(name)) continue
          if (entry.isSymbolicLink()) {
            failed.push({ path, reason: 'Linked paths are not followed for tracking' }); continue
          }
          if (entry.isDirectory()) {
            if (METADATA.has(entry.name.toLowerCase())) continue
            if (await check(path)) await visit(path)
          } else if (entry.isFile() && matches(name)) {
            await add(path)
          }
          if (truncated) return
        }
      }
      await visit(root)
    } catch (error) { failed.push({ path: root, reason: String(error) }) }
  }
  return { filePaths, failed, truncated }
}
