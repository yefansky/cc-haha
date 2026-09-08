import { lstat, readdir } from 'node:fs/promises'
import { isAbsolute, join, relative } from 'node:path'
import picomatch from 'picomatch'
import { expandPath } from '../../utils/path.js'

export type TrackingPathInput = {
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
  const check = async (path: string) => {
    const permission = await options.checkPath(path)
    if (!permission.allowed) failed.push({ path, reason: permission.reason || 'Read permission required' })
    return permission.allowed
  }
  const add = async (path: string) => {
    const key = process.platform === 'win32' ? path.toLowerCase() : path
    if (seen.has(key)) return
    seen.add(key)
    if (filePaths.length >= MAX_FILES) { truncated = true; return }
    if (await check(path)) filePaths.push(path)
  }
  for (const path of input.file_paths ?? []) {
    try { await add(expandPath(path)) } catch (error) { failed.push({ path, reason: String(error) }) }
    if (truncated) break
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
      const excludes = excluded.length ? picomatch(excluded, { dot: true }) : () => false
      const rootStat = await lstat(root)
      if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
        failed.push({ path: root, reason: 'Glob base must be a real directory' }); continue
      }
      const visit = async (directory: string): Promise<void> => {
        // Permissions are checked before descending, not after enumerating a denied subtree.
        const entries = await readdir(directory, { withFileTypes: true })
        for (const entry of entries) {
          if (++visited > MAX_ENTRIES) { truncated = true; return }
          const path = join(directory, entry.name)
          const name = relative(root, path).replace(/\\/g, '/')
          if (excludes(name) || (entry.isDirectory() && excludes(name + '/'))) continue
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
