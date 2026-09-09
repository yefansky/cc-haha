import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { publishedHistory, readHistorySeed } from '../../scripts/changelog-history'

export function readPackagedChangelog(desktopRoot: string, required = false) {
  const path = resolve(desktopRoot, 'public/changelog.json')
  if (!existsSync(path)) {
    if (required) throw new Error('发布构建缺少包内更新日志，请先运行 scripts/release-changelog.ts')
    return null
  }
  const data = JSON.parse(readFileSync(path, 'utf8'))
  const version = JSON.parse(readFileSync(resolve(desktopRoot, 'package.json'), 'utf8')).version
  if (data.version !== version || typeof data.markdown !== 'string' || !data.markdown.trim()) {
    throw new Error('包内更新日志与应用版本不一致或内容为空，请重新生成')
  }
  return { version: data.version as string, markdown: data.markdown as string }
}

export function readPackagedHistory(desktopRoot: string) {
  const path = resolve(desktopRoot, 'public/changelog.json')
  if (!existsSync(path)) return readHistorySeed(resolve(desktopRoot, '..'))
  const notes = readPackagedChangelog(desktopRoot, true)!
  return publishedHistory(JSON.parse(readFileSync(path, 'utf8')), notes.version)
}
