import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { gunzipSync } from 'node:zlib'
import { handleStaticH5Request } from '../staticH5'

let directory: string
const previous = process.env.CLAUDE_H5_DIST_DIR
const content = 'console.log("gateway compression probe");\n'.repeat(3000)

beforeAll(async () => {
  directory = await mkdtemp(path.join(tmpdir(), 'cc-haha-static-gzip-'))
  await mkdir(path.join(directory, 'assets'))
  await writeFile(path.join(directory, 'index.html'), '<div>test</div>')
  await writeFile(path.join(directory, 'assets/probe.js'), content)
  process.env.CLAUDE_H5_DIST_DIR = directory
})

afterAll(async () => {
  if (previous === undefined) delete process.env.CLAUDE_H5_DIST_DIR
  else process.env.CLAUDE_H5_DIST_DIR = previous
  if (directory && path.dirname(directory) === path.resolve(tmpdir())) {
    await rm(directory, { recursive: true, force: true })
  }
})

async function request(encoding?: string, method = 'GET') {
  const url = new URL('http://localhost/assets/probe.js')
  return (await handleStaticH5Request(new Request(url, {
    method,
    headers: encoding ? { 'Accept-Encoding': encoding } : {},
  }), url))!
}

describe('H5 transfer compression', () => {
  test('sends a much smaller gzip bundle that decodes to the exact source', async () => {
    const response = await request('gzip, deflate, br')
    const bytes = Buffer.from(await response.arrayBuffer())
    expect(response.headers.get('content-encoding')).toBe('gzip')
    expect(response.headers.get('vary')).toBe('Accept-Encoding')
    expect(response.headers.get('content-type')).toContain('javascript')
    expect(Number(response.headers.get('content-length'))).toBe(bytes.length)
    expect(bytes.length).toBeLessThan(content.length / 4)
    expect(gunzipSync(bytes).toString()).toBe(content)
  })

  test.each([undefined, 'identity', 'gzip;q=0, *;q=1', 'br', 'gzip;q=invalid'])('honors clients that do not accept gzip: %s', async (encoding) => {
    const response = await request(encoding)
    expect(response.headers.get('content-encoding')).toBeNull()
    expect(await response.text()).toBe(content)
  })

  test('HEAD has the same representation metadata without a body', async () => {
    const get = await request('gzip')
    const head = await request('gzip', 'HEAD')
    expect(head.headers.get('content-encoding')).toBe('gzip')
    expect(head.headers.get('content-length')).toBe(get.headers.get('content-length'))
    expect(await head.text()).toBe('')
  })
})
