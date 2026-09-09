import { mkdtemp, mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, expect, test, vi } from 'vitest'
import { stageGatewayBundle } from './stage-gateway-bundle'

const roots: string[] = []
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'gateway-stage-test-'))
  roots.push(root)
  const source = path.join(root, 'source')
  const destination = path.join(root, 'installed')
  await mkdir(source)
  await writeFile(path.join(source, 'client'), 'new-client')
  return { root, source, destination }
}

test('installs a complete bundle and replaces an existing bundle', async () => {
  const { root, source, destination } = await fixture()
  await stageGatewayBundle(source, destination)
  expect(await readFile(path.join(destination, 'client'), 'utf8')).toBe('new-client')
  await writeFile(path.join(destination, 'obsolete'), 'old')
  await writeFile(path.join(source, 'client'), 'newer-client')
  await stageGatewayBundle(source, destination)
  expect(await readFile(path.join(destination, 'client'), 'utf8')).toBe('newer-client')
  expect(await readdir(destination)).toEqual(['client'])
  expect((await readdir(root)).filter(name => name.startsWith('.gateway-stage-'))).toEqual([])
})

test('failed preparation leaves the old installation untouched', async () => {
  const { root, destination } = await fixture()
  await mkdir(destination)
  await writeFile(path.join(destination, 'client'), 'working-client')
  await expect(stageGatewayBundle(path.join(root, 'missing-source'), destination)).rejects.toThrow()
  expect(await readFile(path.join(destination, 'client'), 'utf8')).toBe('working-client')
})

test('a locked installation is not deleted or changed', async () => {
  const { source, destination } = await fixture()
  await mkdir(destination)
  await writeFile(path.join(destination, 'client'), 'working-client')
  const move = vi.fn(rename).mockRejectedValueOnce(Object.assign(new Error('locked'), { code: 'EACCES' }))
  await expect(stageGatewayBundle(source, destination, move)).rejects.toThrow('locked')
  expect(await readFile(path.join(destination, 'client'), 'utf8')).toBe('working-client')
})

test('failed activation rolls back the previous complete installation', async () => {
  const { source, destination } = await fixture()
  await mkdir(destination)
  await writeFile(path.join(destination, 'client'), 'working-client')
  const move = vi.fn(rename).mockImplementationOnce(rename).mockRejectedValueOnce(new Error('activation failed'))
  await expect(stageGatewayBundle(source, destination, move)).rejects.toThrow('activation failed')
  expect(await readFile(path.join(destination, 'client'), 'utf8')).toBe('working-client')
})

test('failed rollback retains the old bundle for recovery', async () => {
  const { root, source, destination } = await fixture()
  await mkdir(destination)
  await writeFile(path.join(destination, 'client'), 'working-client')
  const move = vi.fn(rename).mockImplementationOnce(rename)
    .mockRejectedValueOnce(new Error('activation failed'))
    .mockRejectedValueOnce(new Error('rollback failed'))
  await expect(stageGatewayBundle(source, destination, move)).rejects.toThrow('previous bundle retained')
  const backups = (await readdir(root)).filter(name => name.startsWith('.gateway-stage-'))
  expect(backups).toHaveLength(1)
  expect(await readFile(path.join(root, backups[0], 'previous', 'client'), 'utf8')).toBe('working-client')
})
