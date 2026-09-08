import { afterEach, expect, test } from 'bun:test'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { resolveTrackingPaths } from './batchPaths.js'
const roots: string[] = []
async function fixture() { const root = await mkdtemp(join(tmpdir(), 'track-batch-')); roots.push(root); return root }
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }) })
const allowed = { checkPath: async () => ({ allowed: true }) }
test('combines arrays and brace/glob expressions, excludes generated files and deduplicates', async () => {
  const root = await fixture()
  await mkdir(join(root, 'src/generated'), { recursive: true })
  for (const path of ['src/a.lua','src/b.ts','src/generated/skip.lua','README']) await writeFile(join(root,path), 'same')
  const result = await resolveTrackingPaths({ file_paths: [join(root,'src/a.lua'), join(root,'new.lua')], patterns: [{ base_dir: root, include: ['src/**/*.{lua,ts}', '!**/generated/**'] }] }, allowed)
  expect(result.filePaths.sort()).toEqual(['src/a.lua','src/b.ts','new.lua'].map(path => join(root,path)).sort())
  expect(result.failed).toEqual([])
  expect(result.truncated).toBe(false)
})
test('checks base permission before traversal and refuses denied descendants', async () => {
  const root = await fixture()
  await mkdir(join(root,'private'))
  await writeFile(join(root,'private/secret.lua'),'secret')
  await writeFile(join(root,'public.lua'),'public')
  const seen: string[] = []
  const result = await resolveTrackingPaths({ patterns: [{ base_dir: root, include: ['**/*.lua'] }] }, { checkPath: async path => { seen.push(path); return { allowed: path !== join(root,'private'), reason:'denied' } } })
  expect(result.filePaths).toEqual([join(root,'public.lua')])
  expect(seen).not.toContain(join(root,'private/secret.lua'))
  const blocked = await resolveTrackingPaths({ patterns: [{ base_dir: join(root,'missing'), include:['**'] }] }, { checkPath: async () => ({allowed:false,reason:'blocked before IO'}) })
  expect(blocked.failed[0]?.reason).toBe('blocked before IO')
})
test('reports overflow rather than claiming a complete batch', async () => {
  const root = await fixture()
  const paths = Array.from({length:501},(_,i)=>join(root,`${i}.txt`))
  const result=await resolveTrackingPaths({file_paths:paths},allowed)
  expect(result.filePaths.length).toBe(500)
  expect(result.truncated).toBe(true)
})
test('rejects escaping patterns and never executes a for expression', async () => {
  const root=await fixture()
  const result=await resolveTrackingPaths({patterns:[{base_dir:root,include:['../*.lua']}]},allowed)
  expect(result.failed.length).toBe(1)
  const empty=await resolveTrackingPaths({patterns:[{base_dir:root,include:['for (const x of files) write(x)']}]},allowed)
  expect(empty.filePaths).toEqual([])
})
