import { afterEach, describe, expect, test } from 'bun:test'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { collectPublishedHistory, downloadPublishedHistory, parseCommit, previousRelease, readCommits, renderChangelog, validateReadableNote, verifyUpdateNotes, writeChangelog } from './release-changelog'
import { readPackagedChangelog, readPackagedHistory } from '../desktop/scripts/packaged-changelog'
import { parseHistory, publishedHistory, readHistorySeed } from './changelog-history'

const directories: string[] = []
const note = '更新后可以在关于页面查看当前版本的改动，断网时也能阅读。'
const message = (type = 'fix', text = note) => `${type}(更新): 修复更新后看不到说明的问题\n\n改动说明：将更新说明放进安装包。\n修改原因：原来的说明重启后丢失。\n解决问题：用户能在更新后查看改动。\n更新日志：\n- ${text}`
function temp() { const dir = mkdtempSync(join(tmpdir(), 'cc-haha-changelog-')); directories.push(dir); return dir }
function git(root: string, ...args: string[]) { return execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim() }
function commit(root: string, text: string) {
  const path = join(root, '.git/TEST_MESSAGE')
  writeFileSync(path, text, 'utf8')
  git(root, 'commit', '--allow-empty', '--file', path)
}
afterEach(() => { for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true }) })

describe('commit-derived release notes', () => {
  test('fills history gaps from overlapping release builds and never hides archive errors', () => {
    const entry = (version: string) => ({ version, date: '2026-09-01', markdown: note, commit: 'abc', from: null, source: 'generated' as const })
    const release = (version: string, draft = false) => ({ tag_name: `v${version}`, draft, prerelease: false, assets: [{ name: 'changelog.json' }] })
    const releases = [release('1.0.1'), release('1.0.2'), release('1.0.3', true), release('1.0.4')]
    const visited: string[] = []
    const history = collectPublishedHistory(releases, '1.0.4', [], value => {
      visited.push(value.tag_name)
      return [entry(value.tag_name.slice(1)), entry('1.0.0')]
    })
    expect(history.map(item => item.version)).toEqual(['1.0.2', '1.0.1', '1.0.0'])
    expect(visited).toEqual(['v1.0.2', 'v1.0.1'])
    expect(() => collectPublishedHistory(releases, '1.0.4', [], () => { throw new Error('download failed') })).toThrow('download failed')
    expect(downloadPublishedHistory('unused/repo', { ...release('1.0.0'), assets: [] })).toEqual([])
  })
  test('backfilled history covers real releases with readable Chinese and traceable commits', () => {
    const entries = readHistorySeed(process.cwd())
    expect(entries).toHaveLength(41)
    expect(entries[0]!.version).toBe('0.6.47')
    expect(entries.at(-1)!.version).toBe('0.5.3')
    expect(entries.some(entry => entry.version === '0.6.37')).toBe(false)
    for (const entry of entries) {
      expect(entry.commit).toMatch(/^[a-f0-9]{40}$/)
      expect(entry.sourceCommits?.length).toBeGreaterThan(0)
      for (const line of entry.markdown.split('\n').filter(line => line.startsWith('- '))) validateReadableNote(line.slice(2))
    }
  })
  test('carries earlier generated versions through consecutive releases and deduplicates a retry', () => {
    const root = temp()
    mkdirSync(join(root, 'desktop'))
    let previous = [] as ReturnType<typeof publishedHistory>
    for (const version of ['1.2.3', '1.2.4', '1.2.5', '1.2.5']) {
      writeFileSync(join(root, 'desktop/package.json'), JSON.stringify({ version }))
      const markdown = renderChangelog(version, [{ hash: 'abc', message: message() }])
      writeChangelog(root, version, markdown, 'v1.2.2', 'abc', previous, '2026-09-10T00:00:00Z')
      const data = JSON.parse(readFileSync(join(root, 'desktop/public/changelog.json'), 'utf8'))
      previous = publishedHistory(data, version)
      expect(readPackagedHistory(join(root, 'desktop'))).toEqual(previous)
    }
    expect(previous.map(entry => entry.version)).toEqual(['1.2.5', '1.2.4', '1.2.3'])
    expect(() => publishedHistory({ version: '1.2.5', markdown: note }, '1.2.5')).toThrow('格式')
    expect(() => publishedHistory({ version: '1.2.4' }, '1.2.5')).toThrow('不一致')
    expect(() => parseHistory({ schemaVersion: 1, releases: [previous[0], previous[0]] })).toThrow('重复')
  })
  test('ordinary development embeds historical records without requiring current release notes', () => {
    const root = temp()
    mkdirSync(join(root, 'release-notes'))
    const seed = { schemaVersion: 1, releases: [{ version: '1.0.0', date: '2026-09-01', markdown: note, commit: 'abc', from: null, source: 'backfilled' }] }
    writeFileSync(join(root, 'release-notes/history.json'), JSON.stringify(seed))
    expect(readPackagedChangelog(join(root, 'desktop'))).toBeNull()
    expect(readPackagedHistory(join(root, 'desktop'))).toEqual(seed.releases)
  })
  test.each(['unknown', 'constructor'])('rejects unsupported commit type %s', type => {
    expect(() => parseCommit({ hash: 'abc', message: message(type) })).toThrow('类型')
  })
  test('publishes only authored user notes, groups in Chinese and removes duplicate bullets', () => {
    const body = message() + '\n\nCo-authored-by: Name <name@example.com>'
    const output = renderChangelog('1.2.3', [{ hash: 'abc', message: body }, { hash: 'def', message: body }])
    expect(output).toContain('## 问题修复')
    expect(output.split(note)).toHaveLength(2)
    expect(output).not.toMatch(/Co-authored|修改原因|name@example|fix\(/)
    expect(parseCommit({ hash: 'abc', message: message('FEAT') }).type).toBe('feat')
  })
  test.each(['修改原因', '改动说明', '解决问题', '更新日志'])('rejects a missing %s field', field => {
    expect(() => parseCommit({ hash: 'abc', message: message().replace(new RegExp(`${field}：[^\\n]*\\n?`), '') })).toThrow()
  })
  test.each(['Optimize UX with IPC', '修复 IPC 状态的 bug', '优化体验', '<script>修改更新显示</script>', '修复 `state` 读取失败的问题'])('rejects unreadable or unsafe copy: %s', text => {
    expect(() => validateReadableNote(text)).toThrow()
  })
  test('permits a necessary technical name only with an immediate Chinese explanation', () => {
    expect(() => validateReadableNote('修复 GitHub（代码托管平台）上的安装包下载失败问题。')).not.toThrow()
  })
  test('requires migration instructions for incompatible changes and puts them first', () => {
    expect(() => parseCommit({ hash: 'abc', message: message('feat!') })).toThrow()
    const breaking = message('feat').replace('feat(更新):', 'feat(更新)!:') + '\n\nBREAKING CHANGE: 旧版设置无法自动读取，更新前请先导出设置，更新后重新导入。'
    const output = renderChangelog('2.0.0', [{ hash: 'abc', message: breaking }])
    expect(output.indexOf('更新前请注意')).toBeLessThan(output.indexOf('问题修复') === -1 ? output.indexOf('新增功能') : output.indexOf('问题修复'))
  })
  test('uses successful ancestor releases and includes commits after failed builds, with no merge duplication', () => {
    const root = temp()
    git(root, 'init', '-b', 'main')
    git(root, 'config', 'user.name', 'Test')
    git(root, 'config', 'user.email', 'test@example.invalid')
    git(root, 'commit', '--allow-empty', '-m', 'legacy baseline')
    git(root, 'tag', 'v1.0.0')
    git(root, 'checkout', '-b', 'feature')
    commit(root, message('feat'))
    git(root, 'checkout', 'main')
    commit(root, message())
    git(root, 'tag', 'v1.0.1') // failed/draft build must not hide this fix
    git(root, 'merge', '--no-ff', 'feature', '-m', 'Merge branch feature')
    git(root, 'tag', 'v1.0.2') // current tag excluded on retry
    const release = (tag_name: string, draft = false) => ({ tag_name, draft, prerelease: false, assets: [{ name: 'latest.yml' }] })
    const from = previousRelease(root, [release('v1.0.0'), release('v1.0.1', true), release('v1.0.2')], '1.0.2', 'windows')
    expect(from).toBe('v1.0.0')
    const commits = readCommits(root, from)
    expect(commits).toHaveLength(2)
    const output = renderChangelog('1.0.2', commits)
    expect(output).toContain('新增功能')
    expect(output).toContain('问题修复')
    expect(output).not.toContain('legacy baseline')
    expect(() => previousRelease(root, [], '1.0.2', 'windows')).toThrow('明确起点')
  })
  test('release body, packaged markdown, updater resource and embedded UI content are identical', () => {
    const root = temp()
    mkdirSync(join(root, 'desktop'))
    writeFileSync(join(root, 'desktop/package.json'), JSON.stringify({ version: '1.2.3' }))
    const markdown = renderChangelog('1.2.3', [{ hash: 'abc', message: message() }])
    writeChangelog(root, '1.2.3', markdown, 'v1.2.2', 'abc')
    expect(readPackagedChangelog(join(root, 'desktop'), true)).toEqual({ version: '1.2.3', markdown })
    for (const file of ['release-notes/v1.2.3.md', 'desktop/public/CHANGELOG.md', 'desktop/build/release-notes.md']) {
      expect(readFileSync(join(root, file), 'utf8')).toBe(markdown)
    }
    writeFileSync(join(root, 'desktop/package.json'), JSON.stringify({ version: '1.2.4' }))
    expect(() => readPackagedChangelog(join(root, 'desktop'), true)).toThrow('不一致')
  })
  test('development may omit notes but release builds must fail if they are absent', () => {
    const root = temp()
    expect(readPackagedChangelog(root)).toBeNull()
    expect(() => readPackagedChangelog(root, true)).toThrow('缺少')
  })
  test('rejects a packaged update feed with missing, different or stale notes', () => {
    const notes = { version: '1.2.3', markdown: note }
    expect(() => verifyUpdateNotes(notes, { version: '1.2.3', releaseNotes: note })).not.toThrow()
    expect(() => verifyUpdateNotes(notes, { version: '1.2.3' })).toThrow()
    expect(() => verifyUpdateNotes(notes, { version: '1.2.2', releaseNotes: note })).toThrow()
    expect(() => verifyUpdateNotes(notes, { version: '1.2.3', releaseNotes: '别的版本说明' })).toThrow()
  })
})
