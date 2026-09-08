import { afterEach, expect, test } from 'bun:test'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import iconv from 'iconv-lite'
import { readFileInRange } from './readFileInRange.js'

const directories: string[] = []
afterEach(async () => {
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true })
})

for (const encoding of ['gbk', 'utf8']) {
  test(`large ${encoding} file detects Chinese beyond the ASCII head and chunk boundary`, async () => {
    const directory = await mkdtemp(join(tmpdir(), 'cc-haha-range-'))
    directories.push(directory)
    const path = join(directory, 'large.lua')
    const head = 'a'.repeat(511) + '\n'
    const content = head.repeat(20480) + '中文注释：保持原样\n'
    await writeFile(path, iconv.encode(content, encoding))
    const result = await readFileInRange(path, 20480, 1)
    expect(result.content).toBe('中文注释：保持原样')
    expect(result.totalLines).toBe(20482)
  })
}

test('streaming UTF-8 handles multibyte characters split across chunks', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'cc-haha-range-'))
  directories.push(directory)
  const path = join(directory, 'boundary.lua')
  const content = 'a'.repeat(512 * 1024 - 1) + '中文\n' + 'x\n'.repeat(5 * 1024 * 1024)
  await writeFile(path, content)
  const result = await readFileInRange(path, 0, 1)
  expect(result.content).toBe(content.split('\n')[0]!)
})

for (const encoding of ['gbk', 'utf8', 'utf16le']) {
  test(`limited Read preserves ${encoding} text without returning the whole file`, async () => {
    const directory = await mkdtemp(join(tmpdir(), 'cc-haha-range-'))
    directories.push(directory)
    const path = join(directory, 'limited.lua')
    const content = '第一行\r\n目标中文\r\n第三行\r\n'
    await writeFile(path, iconv.encode(encoding === 'utf16le' ? '\uFEFF' + content : content, encoding))
    const result = await readFileInRange(path, 1, 1)
    expect(result.content).toBe('目标中文')
    expect(result.lineCount).toBe(1)
    expect(result.totalLines).toBe(4)
  })
}
