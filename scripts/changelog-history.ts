import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'

export type ChangelogEntry = {
  version: string
  date: string
  markdown: string
  commit: string
  from: string | null
  source: 'backfilled' | 'generated'
  sourceCommits?: string[]
  comparison?: string
}

export function parseHistory(data: unknown): ChangelogEntry[] {
  const archive = data as { schemaVersion?: number, releases?: ChangelogEntry[] } | null
  if (archive?.schemaVersion !== 1 || !Array.isArray(archive.releases)) throw new Error('更新历史格式不支持，请检查历史归档')
  const seen = new Set<string>()
  for (const entry of archive.releases) {
    if (!entry || !/^\d+\.\d+\.\d+(?:-[\w.-]+)?$/.test(entry.version) || seen.has(entry.version)
      || typeof entry.date !== 'string' || !Number.isFinite(Date.parse(entry.date))
      || typeof entry.markdown !== 'string' || !entry.markdown.trim()
      || typeof entry.commit !== 'string' || !entry.commit
      || !(entry.from === null || typeof entry.from === 'string')
      || !['backfilled', 'generated'].includes(entry.source)) throw new Error('更新历史存在无效内容或重复版本')
    seen.add(entry.version)
  }
  return archive.releases
}

export function readHistorySeed(root: string): ChangelogEntry[] {
  const path = resolve(root, 'release-notes/history.json')
  return existsSync(path) ? parseHistory(JSON.parse(readFileSync(path, 'utf8'))) : []
}

export function mergeHistory(...archives: ChangelogEntry[][]): ChangelogEntry[] {
  const entries = new Map<string, ChangelogEntry>()
  for (const archive of archives) for (const entry of archive) entries.set(entry.version, entry)
  return [...entries.values()].sort((a, b) => b.version.localeCompare(a.version, 'en', { numeric: true }))
}

export function publishedHistory(data: unknown, expectedVersion: string): ChangelogEntry[] {
  const notes = data as { version?: string, markdown?: string, history?: unknown } | null
  if (notes?.version !== expectedVersion || typeof notes.markdown !== 'string') throw new Error('上个发布版本的更新历史与版本不一致')
  const history = parseHistory(notes.history)
  if (!history.some(entry => entry.version === notes.version && entry.markdown === notes.markdown)) throw new Error('上个发布版本的更新历史缺少自身说明')
  return history
}
