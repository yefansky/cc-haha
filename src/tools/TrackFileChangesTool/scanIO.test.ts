import { expect, test } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readScanDirectory, withScanIO } from './scanIO.js'

test('asynchronous scan I/O is queued with at most two operations running', async () => {
  let active = 0, peak = 0
  const results = await Promise.all(Array.from({ length: 30 }, (_, i) => withScanIO(async () => {
    peak = Math.max(peak, ++active)
    await new Promise(resolve => setTimeout(resolve, 2))
    active--
    return i
  })))
  expect(peak).toBe(2)
  expect(results).toEqual(Array.from({ length: 30 }, (_, i) => i))
})
test('duplicate directory reads share in-flight work but a later scan sees new files', async () => {
  const root = await mkdtemp(join(tmpdir(), 'scan-queue-'))
  try {
    const first = readScanDirectory(root), second = readScanDirectory(root)
    expect(first).toBe(second)
    await first
    await writeFile(join(root, 'new.txt'), 'new')
    expect((await readScanDirectory(root)).map(entry => entry.name)).toEqual(['new.txt'])
  } finally { await rm(root, { recursive: true, force: true }) }
})
test('queue overload is explicit and failed operations release their slot', async () => {
  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  const jobs = Array.from({ length: 130 }, () => withScanIO(async () => { await gate }))
  try { await expect(withScanIO(async () => {})).rejects.toThrow('busy') }
  finally { release(); await Promise.all(jobs) }
  await expect(withScanIO(async () => { throw new Error('read failed') })).rejects.toThrow('read failed')
  expect(await withScanIO(async () => 'recovered')).toBe('recovered')
})
