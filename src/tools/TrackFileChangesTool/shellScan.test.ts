import { expect, test } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beginShellChangeScan } from './shellScan.js'

test('repeated and concurrent scans reuse an unchanged fingerprint and invalidate it on real change', async () => {
  const root = await mkdtemp(join(tmpdir(), 'scan-cache-'))
  const path = join(root, 'file.txt')
  try {
    await writeFile(path, 'a'.repeat(1024 * 1024))
    const [first, second] = await Promise.all([beginShellChangeScan({ file_paths: [path] }, [path]), beginShellChangeScan({ file_paths: [path] }, [path])])
    expect(first!.before.get(path)).toBe(second!.before.get(path))
    const repeated = await beginShellChangeScan({ file_paths: [path] }, [path])
    expect(repeated!.before.get(path)).toBe(first!.before.get(path))
    await writeFile(path, 'changed')
    const changed = await beginShellChangeScan({ file_paths: [path] }, [path])
    expect(changed!.before.get(path)?.digest).not.toBe(first!.before.get(path)?.digest)
    expect(changed!.before.get(path)).not.toBe(first!.before.get(path))
  } finally { await rm(root, { recursive: true, force: true }) }
})
