import { realpath } from 'node:fs/promises'
import { dirname, isAbsolute, parse, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

/** Per-view file access; only a host-initiated open grants a document directory. */
export class LocalPreviewAccess {
  private roots = new Set<string>()
  private files = new Set<string>()

  async authorize(url: string): Promise<void> {
    const parsed = new URL(url)
    if (parsed.protocol !== 'file:') return
    if (parsed.hostname) throw new Error('Network file previews are not supported')
    const file = await realpath(fileURLToPath(parsed))
    const root = dirname(file)
    this.files.add(file)
    // Opening a document stored directly in a drive root must not grant the drive.
    if (root !== parse(root).root) this.roots.add(root)
  }

  async allows(url: string): Promise<boolean> {
    try {
      const parsed = new URL(url)
      if (parsed.protocol !== 'file:' || parsed.hostname) return false
      const file = await realpath(fileURLToPath(parsed))
      if (this.files.has(file)) return true
      for (const root of this.roots) {
        const rel = relative(root, file)
        if (!isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`)) return true
      }
    } catch { /* Missing paths and symlink escapes have no capability. */ }
    return false
  }
}
