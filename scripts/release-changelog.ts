#!/usr/bin/env bun
// Conventional Commits syntax: https://www.conventionalcommits.org/zh-hans/v1.0.0/
// Like conventional-changelog, group commit-derived notes by type. Only the
// explicitly authored Chinese user summary is published, never the debug body.
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { mergeHistory, publishedHistory, readHistorySeed, type ChangelogEntry } from './changelog-history'

const groups: Record<string, string> = {
  feat: '新增功能', fix: '问题修复', perf: '速度与稳定性', revert: '撤回改动',
  docs: '说明文档', refactor: '内部维护', build: '安装与打包',
  ci: '发布维护', test: '测试维护', style: '代码整理', chore: '其他维护',
}
const fields = ['改动说明', '修改原因', '解决问题', '更新日志'] as const
export type Commit = { hash: string, message: string }

export function validateReadableNote(note: string): void {
  if (!/[\u3400-\u9fff]/u.test(note) || note.length < 8) {
    throw new Error('更新日志须用完整中文句子说明具体变化')
  }
  // Version numbers and product names with Chinese explanations are allowed;
  // untranslated jargon and acronyms must not leak into the user-facing copy.
  const unexplained = note.replace(/[A-Za-z][A-Za-z0-9.+_-]*[（(][^）)\n]*[\u3400-\u9fff][^）)\n]*[）)]/gu, '')
  if (/[A-Za-z]/u.test(unexplained)) {
    throw new Error('更新日志中的英文名称必须紧跟中文解释；其余内容请改用中文')
  }
  if (/[<>]|https?:|`|\[[^\]]*\]\(/u.test(note) || /^(优化体验|修复问题|提升稳定性|若干修复|常规更新)[。！!]?$/u.test(note)) {
    throw new Error('更新日志须写具体变化，不得使用空话、代码、网页标签或链接')
  }
}

export function parseCommit(commit: Commit) {
  const lines = commit.message.replace(/\r\n/g, '\n').trim().split('\n')
  const header = /^([a-z]+)(?:\(([^()\n]+)\))?(!)?: (.+)$/i.exec(lines[0] ?? '')
  if (!header || !Object.hasOwn(groups, header[1]!.toLowerCase())) throw new Error('标题须使用约定式提交类型，例如 fix(更新): 修复更新后看不到改动说明的问题')
  if (lines[1]?.trim()) throw new Error('标题与正文之间必须留一个空行')
  if (!/[\u3400-\u9fff]/u.test(header[4]!)) throw new Error('提交标题须用中文说明具体改动')
  const sections: Record<string, string[]> = {}
  let current = ''
  for (const line of lines.slice(2)) {
    const field = /^(改动说明|修改原因|解决问题|更新日志|BREAKING CHANGE|BREAKING-CHANGE)[：:]\s*(.*)$/.exec(line)
    if (field) {
      current = field[1]!
      if (sections[current]) throw new Error(`重复字段：${current}`)
      sections[current] = [field[2]!]
    } else if (/^[\w-]+: /.test(line)) {
      current = '' // Standard trailers such as Co-authored-by are never release copy.
    } else if (current) {
      sections[current]!.push(line)
    }
  }
  for (const field of fields) {
    if (!sections[field]?.join('\n').trim()) throw new Error(`提交正文缺少“${field}：”`)
  }
  const notes = sections['更新日志']!.map(line => line.trim().replace(/^[-*] /, '')).filter(Boolean)
  for (const note of notes) validateReadableNote(note)
  const breaking = !!header[3] || !!sections['BREAKING CHANGE'] || !!sections['BREAKING-CHANGE']
  const migration = (sections['BREAKING CHANGE'] ?? sections['BREAKING-CHANGE'])?.join(' ').trim()
  if (breaking) {
    if (!migration) throw new Error('不兼容改动必须通过 BREAKING CHANGE: 用中文说明影响和用户要做什么')
    validateReadableNote(migration)
  }
  return { type: header[1]!.toLowerCase(), notes, migration }
}

export function renderChangelog(version: string, commits: Commit[]): string {
  if (!/^\d+\.\d+\.\d+(?:-[\w.-]+)?$/.test(version)) throw new Error('版本号无效')
  const sections = new Map<string, Set<string>>()
  const add = (group: string, note: string) => {
    if (!sections.has(group)) sections.set(group, new Set())
    sections.get(group)!.add(note)
  }
  for (const commit of commits) {
    try {
      const parsed = parseCommit(commit)
      if (parsed.migration) add('更新前请注意', parsed.migration)
      for (const note of parsed.notes) add(groups[parsed.type]!, note)
    } catch (error) {
      throw new Error(`提交 ${commit.hash.slice(0, 12)} 的更新说明不合格：${(error as Error).message}`)
    }
  }
  const result = [`# ${version} 版本更新内容`]
  for (const group of ['更新前请注意', ...new Set(Object.values(groups))]) {
    const notes = sections.get(group)
    if (notes?.size) result.push(`## ${group}\n\n${[...notes].map(note => `- ${note}`).join('\n')}`)
  }
  if (!commits.length) result.push('本次重新打包，功能与上一发布版本相同。')
  return result.join('\n\n') + '\n'
}

function git(root: string, args: string[]): string {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 32 * 1024 * 1024 }).trim()
}

function resolveCommit(root: string, ref: string): string {
  if (!/^[\w./-]+$/.test(ref) || ref.startsWith('-')) throw new Error('提交起点须为标签、分支或完整提交编号')
  const object = git(root, ['rev-parse', '--verify', '--end-of-options', ref])
  // rev-list peels annotated tags without a caret expression (Bun on Windows
  // can strip carets while invoking Git through child_process).
  const commit = git(root, ['rev-list', '-1', object, '--'])
  if (!/^[a-f0-9]{40,64}$/.test(commit)) throw new Error('指定起点不是有效提交')
  return commit
}

export function readCommits(root: string, from: string, to = 'HEAD'): Commit[] {
  // Resolve untrusted refs before using a revision range or command options.
  const start = resolveCommit(root, from)
  const end = resolveCommit(root, to)
  git(root, ['merge-base', '--is-ancestor', start, end])
  const hashes = git(root, ['rev-list', '--reverse', '--topo-order', '--no-merges', `${start}..${end}`]).split('\n').filter(Boolean)
  return hashes.map(hash => ({ hash, message: git(root, ['show', '-s', '--format=%B', hash]) }))
}

type PublishedRelease = { tag_name: string, draft: boolean, prerelease: boolean, assets: Array<{ name: string }> }

export function previousRelease(root: string, releases: PublishedRelease[], version: string, channel: string): string {
  const candidates: Array<{ tag: string, distance: number }> = []
  for (const release of releases) {
    if (release.draft || release.prerelease || release.tag_name === `v${version}` || !/^v\d+\.\d+\.\d+$/.test(release.tag_name)) continue
    const metadata = channel === 'windows' ? 'latest.yml' : 'latest-mac.yml'
    if (!release.assets.some(asset => asset.name === metadata)) continue
    try {
      const hash = resolveCommit(root, release.tag_name)
      execFileSync('git', ['merge-base', '--is-ancestor', hash, 'HEAD'], { cwd: root, stdio: 'pipe' })
      candidates.push({ tag: release.tag_name, distance: Number(git(root, ['rev-list', '--count', `${hash}..HEAD`])) })
    } catch {
      // Tags on unrelated branches are not a baseline for this build.
    }
  }
  candidates.sort((a, b) => a.distance - b.distance || b.tag.localeCompare(a.tag, undefined, { numeric: true }))
  if (!candidates[0]) throw new Error('没有找到同一发布渠道的已发布祖先版本。首次接入请用 --from 明确起点，不能猜测范围。')
  return candidates[0].tag
}

export function writeChangelog(root: string, version: string, markdown: string, from: string, commit: string, previous: ChangelogEntry[] = [], date = new Date().toISOString()) {
  // The release asset carries generated history forward without committing build output.
  // Curated seed entries may correct early historical summaries on later releases.
  const releases = mergeHistory(previous, readHistorySeed(root), [{ version, markdown, from, commit, date, source: 'generated' }])
  const files = {
    [`release-notes/v${version}.md`]: markdown,
    'desktop/public/CHANGELOG.md': markdown,
    'desktop/public/changelog.json': JSON.stringify({ version, markdown, from, commit, history: { schemaVersion: 1, releases } }, null, 2) + '\n',
    // electron-builder's standard release-notes.md resource populates latest*.yml.
    'desktop/build/release-notes.md': markdown,
  }
  for (const [file, content] of Object.entries(files)) {
    const target = resolve(root, file)
    mkdirSync(dirname(target), { recursive: true })
    writeFileSync(target, content, 'utf8')
  }
}

export function downloadPublishedHistory(repo: string, release: PublishedRelease): ChangelogEntry[] {
  if (!release.assets.some(asset => asset.name === 'changelog.json')) return [] // Before history support: use the checked-in backfill.
  const directory = mkdtempSync(resolve(tmpdir(), 'cc-haha-history-'))
  try {
    const output = resolve(directory, 'changelog.json')
    execFileSync('gh', ['release', 'download', release.tag_name, '--repo', repo, '--pattern', 'changelog.json', '--output', output], { stdio: 'pipe' })
    return publishedHistory(JSON.parse(readFileSync(output, 'utf8')), release.tag_name.replace(/^v/, ''))
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
}

export function collectPublishedHistory(releases: PublishedRelease[], version: string, seed: ChangelogEntry[], download: (release: PublishedRelease) => ChangelogEntry[]): ChangelogEntry[] {
  let history = seed
  // Overlapping builds may start at the same baseline. Fill published gaps
  // instead of assuming the newest archive already contains every older release.
  const candidates = releases.filter(release => !release.draft && !release.prerelease
    && /^v\d+\.\d+\.\d+$/.test(release.tag_name)
    && release.tag_name.slice(1).localeCompare(version, 'en', { numeric: true }) < 0
    && release.assets.some(asset => asset.name === 'changelog.json'))
    .sort((a, b) => b.tag_name.localeCompare(a.tag_name, 'en', { numeric: true }))
  for (const release of candidates) {
    if (history.some(entry => entry.version === release.tag_name.slice(1))) continue
    history = mergeHistory(download(release), history)
  }
  return history
}

export function verifyUpdateNotes(notes: { version: string, markdown: string }, metadata: { version?: string, releaseNotes?: unknown }) {
  if (metadata.version !== notes.version || metadata.releaseNotes !== notes.markdown) {
    throw new Error('自动更新数据的版本或说明与包内日志不一致，停止发布')
  }
}

if (import.meta.main) {
  try {
    const args = process.argv.slice(2)
    const value = (name: string) => {
      const index = args.indexOf(name)
      return index < 0 ? undefined : args[index + 1]
    }
    const root = resolve(value('--root') ?? '.')
    const messageFile = value('--check-message')
    const metadataDir = value('--verify-metadata')
    if (metadataDir) {
      const { parse } = await import('yaml')
      const notes = JSON.parse(readFileSync(resolve(root, 'desktop/public/changelog.json'), 'utf8'))
      const directory = resolve(root, metadataDir)
      const files = readdirSync(directory).filter(file => /^latest.*\.yml$/.test(file))
      if (!files.length) throw new Error('没有找到自动更新数据文件')
      for (const file of files) verifyUpdateNotes(notes, parse(readFileSync(resolve(directory, file), 'utf8')))
      console.log('自动更新数据与包内更新日志一致。')
    } else if (messageFile) {
      parseCommit({ hash: '待提交', message: readFileSync(messageFile, 'utf8') })
      console.log('提交说明检查通过；发布前仍需人工核对文案是否准确、通俗。')
    } else {
      const version = value('--version') ?? JSON.parse(readFileSync(resolve(root, 'desktop/package.json'), 'utf8')).version
      let from = value('--from') ?? (process.env.CC_HAHA_CHANGELOG_FROM?.trim() || undefined)
      const repo = process.env.GITHUB_REPOSITORY
      let previous: ChangelogEntry[] = []
      if (repo) {
        if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) throw new Error('GITHUB_REPOSITORY 格式无效')
        const pages = JSON.parse(execFileSync('gh', ['api', '--paginate', '--slurp', `repos/${repo}/releases?per_page=100`], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 }))
        const releases: PublishedRelease[] = pages.flat()
        // Even an explicit commit baseline must retain the previous published archive.
        from ??= previousRelease(root, releases, version, value('--channel') ?? 'windows')
        previous = collectPublishedHistory(releases, version, readHistorySeed(root), release => downloadPublishedHistory(repo, release))
      }
      if (!from) throw new Error('请设置 GITHUB_REPOSITORY 或指定 --from')
      const markdown = renderChangelog(version, readCommits(root, from))
      if (args.includes('--dry')) console.log(markdown)
      else writeChangelog(root, version, markdown, from, git(root, ['rev-parse', 'HEAD']), previous)
      console.log(`更新日志范围：${from}..HEAD`)
    }
  } catch (error) {
    console.error((error as Error).message)
    process.exitCode = 1
  }
}
