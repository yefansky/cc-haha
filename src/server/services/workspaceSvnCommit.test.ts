import { afterEach, describe, expect, it } from 'bun:test'
import { execFileSync } from 'node:child_process'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { pathToFileURL } from 'node:url'
import { commitWorkspaceSvn } from './workspaceSvnCommit'

const dirs: string[] = []
const svn = (cwd: string, ...args: string[]) => execFileSync('svn', args, { cwd, encoding: 'utf8' })
async function fixture() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cc-svn-commit-test-'))
  dirs.push(dir)
  const repo = path.join(dir, 'repository')
  const wc = path.join(dir, '工作副本')
  execFileSync('svnadmin', ['create', repo])
  await fs.mkdir(wc)
  svn(wc, 'checkout', pathToFileURL(repo).href, '.')
  await fs.mkdir(path.join(wc, 'sub'))
  await fs.writeFile(path.join(wc, 'root.txt'), 'root before')
  await fs.writeFile(path.join(wc, 'sub', 'file.txt'), 'sub before')
  svn(wc, 'add', '--force', '.')
  svn(wc, 'commit', '-m', 'initial')
  return wc
}
afterEach(async () => {
  for (const dir of dirs.splice(0)) await fs.rm(dir, { recursive: true, force: true })
})

describe('SVN quick commit', () => {
  it('commits UTF-8 messages within the session directory and leaves siblings and untracked files alone', async () => {
    const wc = await fixture()
    await fs.writeFile(path.join(wc, 'root.txt'), 'root after')
    await fs.writeFile(path.join(wc, 'sub', 'file.txt'), 'sub after')
    await fs.writeFile(path.join(wc, 'sub', 'private.txt'), 'untracked')
    const message = '修复中文内容\n第二行 & $(echo never)'
    const result = await commitWorkspaceSvn(path.join(wc, 'sub'), message, ['svn'])
    expect(result.state).toBe('ok')
    expect(svn(wc, 'log', '-r', 'HEAD', '--xml')).toContain('修复中文内容')
    expect(svn(wc, 'log', '-r', 'HEAD', '--xml')).toContain('第二行 &amp; $(echo never)')
    expect(svn(wc, 'status', 'root.txt')).toMatch(/^M/)
    expect(svn(wc, 'status', 'sub/file.txt')).toBe('')
    expect(svn(wc, 'status', 'sub/private.txt')).toMatch(/^\?/)
    expect((await commitWorkspaceSvn(path.join(wc, 'sub'), 'no changes', ['svn'])).state).toBe('no_changes')
  })
  it('rejects invalid messages and non-SVN directories', async () => {
    const wc = await fixture()
    expect((await commitWorkspaceSvn(wc, '   ', ['svn'])).state).toBe('error')
    expect((await commitWorkspaceSvn(wc, 'x'.repeat(10001), ['svn'])).state).toBe('error')
    expect((await commitWorkspaceSvn(wc, 'x\0y', ['svn'])).state).toBe('error')
    expect((await commitWorkspaceSvn(path.dirname(wc), 'hello', ['svn'])).state).toBe('error')
    expect(svn(wc, 'log', '-r', 'HEAD', '--xml')).toContain('revision="1"')
  })
  it('reports an out-of-date rejection without retrying or changing local content', async () => {
    const wc = await fixture()
    const other = path.join(path.dirname(wc), 'other')
    svn(wc, 'checkout', svn(wc, 'info', '--show-item', 'url').trim(), other)
    await fs.writeFile(path.join(other, 'root.txt'), 'new remote version')
    svn(other, 'commit', '-m', 'remote change')
    await fs.writeFile(path.join(wc, 'root.txt'), 'my unsaved commit')
    const result = await commitWorkspaceSvn(wc, 'must fail', ['svn'])
    expect(result.state).toBe('error')
    expect(result.error).toContain('out of date')
    expect(await fs.readFile(path.join(wc, 'root.txt'), 'utf8')).toBe('my unsaved commit')
    expect(svn(wc, 'log', '-r', 'HEAD', '--xml')).toContain('revision="2"')
  })
})
