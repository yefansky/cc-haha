import { expect, test } from 'bun:test'
import iconv from 'iconv-lite'
import { decodeTextFile, encodeTextFile } from './textEncoding.js'

test('detects GBK after a long ASCII header, and round trips every byte', () => {
  const bytes = iconv.encode('-- ASCII header\n'.repeat(1000) + '-- 中文注释\n', 'gbk')
  const decoded = decodeTextFile(bytes)
  expect(decoded.encoding).toBe('gbk')
  expect(encodeTextFile(decoded.content, decoded.encoding)).toEqual(bytes)
})

test('does not duplicate a UTF-8 BOM supplied in replacement content', () => {
  expect(encodeTextFile('\uFEFF中文', 'utf8-bom')).toEqual(Buffer.from('\uFEFF中文'))
})

test('rejects malformed bytes and invalid Unicode without substitution', () => {
  expect(() => decodeTextFile(Buffer.from([0xff]))).toThrow('losslessly')
  expect(() => decodeTextFile(Buffer.from([0xef, 0xbb, 0xbf, 0xff]))).toThrow('losslessly')
  expect(() => encodeTextFile('\ud800', 'utf8')).toThrow('invalid Unicode')
})

test('empty and ASCII files use UTF-8; BOM-only files retain their BOM', () => {
  expect(decodeTextFile(Buffer.alloc(0)).encoding).toBe('utf8')
  expect(decodeTextFile(Buffer.from('ascii')).encoding).toBe('utf8')
  const bom = Buffer.from([0xef, 0xbb, 0xbf])
  const decoded = decodeTextFile(bom)
  expect(encodeTextFile(decoded.content, decoded.encoding)).toEqual(bom)
})
