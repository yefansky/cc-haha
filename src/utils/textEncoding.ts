import { isUtf8 } from 'node:buffer'
import iconv from 'iconv-lite'

export type TextFileEncoding = 'utf8' | 'utf8-bom' | 'gbk' | 'utf16le'

/** Detect the entire byte sequence; an ASCII header alone cannot identify GBK. */
export function decodeTextFile(bytes: Buffer): { content: string; encoding: TextFileEncoding } {
  if (bytes[0] === 0xff && bytes[1] === 0xfe) {
    const content = bytes.toString('utf16le')
    if (!Buffer.from(content, 'utf16le').equals(bytes)) throw new Error('Invalid UTF-16 file; refusing a lossy read.')
    return { content, encoding: 'utf16le' }
  }
  const bom = bytes.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf]))
  if (isUtf8(bytes)) {
    return { content: bytes.subarray(bom ? 3 : 0).toString('utf8'), encoding: bom ? 'utf8-bom' : 'utf8' }
  }
  if (!bom) {
    const content = iconv.decode(bytes, 'gbk')
    if (iconv.encode(content, 'gbk').equals(bytes)) return { content, encoding: 'gbk' }
  }
  throw new Error('File is not losslessly decodable as UTF-8 or GBK; refusing to modify its encoding.')
}

/** Complete encoding and loss checks before opening/truncating the destination. */
export function encodeTextFile(content: string, encoding: TextFileEncoding): Buffer {
  if (encoding === 'gbk') {
    const bytes = iconv.encode(content, 'gbk')
    if (iconv.decode(bytes, 'gbk') !== content) {
      throw new Error('New content contains characters that GBK cannot represent; file was not written. Preserve the original encoding and use representable characters.')
    }
    return bytes
  }
  const body = encoding === 'utf8-bom' && content.startsWith('\uFEFF') ? content.slice(1) : content
  const codec = encoding === 'utf16le' ? 'utf16le' : 'utf8'
  const bytes = Buffer.from(body, codec)
  if (bytes.toString(codec) !== body) throw new Error('New content contains invalid Unicode; file was not written.')
  return encoding === 'utf8-bom' ? Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), bytes]) : bytes
}
