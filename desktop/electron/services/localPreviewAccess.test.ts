import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, mkdir, writeFile, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { LocalPreviewAccess } from './localPreviewAccess'

const fixtures: string[] = []
afterEach(async () => { for (const root of fixtures.splice(0)) await rm(root, { recursive: true, force: true }) })
describe('local preview access', () => {
  it('grants the opened directory and children, denying siblings, missing files and junction escapes', async () => {
    const root = await mkdtemp(join(tmpdir(), 'cc-haha-local-preview-'))
    fixtures.push(root)
    const site = join(root, '中文 site')
    const outside = join(root, 'unrelated')
    await mkdir(site); await mkdir(outside)
    for (const file of [join(site, 'index.html'), join(site, 'page.html'), join(outside, 'secret.txt')]) await writeFile(file, 'fixture')
    const url = (file: string) => pathToFileURL(file).href
    const access = new LocalPreviewAccess()
    expect(await access.allows(url(join(site, 'index.html')))).toBe(false)
    await access.authorize(url(join(site, 'index.html')))
    expect(await access.allows(url(join(site, 'page.html')))).toBe(true)
    expect(await access.allows(url(join(outside, 'secret.txt')))).toBe(false)
    expect(await access.allows(url(join(site, 'missing.html')))).toBe(false)
    await symlink(outside, join(site, 'linked'), process.platform === 'win32' ? 'junction' : 'dir')
    expect(await access.allows(url(join(site, 'linked', 'secret.txt')))).toBe(false)
    expect(await access.allows('file://server/share/index.html')).toBe(false)
  })
})
