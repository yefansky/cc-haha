import { createCipheriv, createHash, randomBytes } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import type { Session } from 'electron'
import { describe, expect, it, vi } from 'vitest'
import { decryptWpsCookie, prepareWpsLoginSession, readWpsCookieRows } from './wpsLoginSession'

function encryptedCookie(version: number, host = '.wps.cn') {
  const key = randomBytes(32), iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  const plain = Buffer.concat([...(version >= 24 ? [createHash('sha256').update(host).digest()] : []), Buffer.from('fixture-session')])
  const encrypted_value = Buffer.concat([Buffer.from('v10'), iv, cipher.update(plain), cipher.final(), cipher.getAuthTag()])
  return { key, row: { host_key: '.wps.cn', name: 'wps_sid', path: '/', value: '', encrypted_value,
    expires_utc: 0, last_access_utc: 0, is_secure: 1, is_httponly: 1, samesite: 1, version } }
}

describe('WPS desktop session reuse', () => {
  it('reads real SQLite Chromium timestamps beyond safe integers and filters unrelated cookies', () => {
    const db = new DatabaseSync(':memory:')
    try {
      db.exec("CREATE TABLE meta(key TEXT,value TEXT); INSERT INTO meta VALUES('version','24'); CREATE TABLE cookies(host_key TEXT,name TEXT,path TEXT,value TEXT,encrypted_value BLOB,expires_utc INTEGER,last_access_utc INTEGER,is_secure INTEGER,is_httponly INTEGER,samesite INTEGER)")
      const insert = db.prepare('INSERT INTO cookies VALUES(?,?,?,\'\',?,13435239666000000,13431286060000000,1,1,1)')
      insert.run('.wps.cn', 'wps_sid', '/', new Uint8Array())
      insert.run('.wps.cn', 'unrelated', '/', new Uint8Array())
      insert.run('.evil.test', 'wps_sid', '/', new Uint8Array())
      const rows = readWpsCookieRows(db)
      expect(rows).toHaveLength(1)
      expect(rows[0]).toMatchObject({ expires_utc: 13435239666000000, samesite: 1, version: 24 })
    } finally { db.close() }
  })
  it.each([23, 24])('decrypts Chromium cookie format version %s', version => {
    const { key, row } = encryptedCookie(version)
    expect(decryptWpsCookie(row, key)).toBe('fixture-session')
  })
  it('rejects corrupted encryption and mismatched host binding', () => {
    const { key, row } = encryptedCookie(24, '.other.test')
    expect(() => decryptWpsCookie(row, key)).toThrow('Invalid WPS cookie host')
    row.encrypted_value[row.encrypted_value.length - 1] = row.encrypted_value[row.encrypted_value.length - 1]! ^ 1
    expect(() => decryptWpsCookie(row, key)).toThrow()
  })
  it('does not silently overwrite the account already selected in cc-haha', async () => {
    const cookies = { get: vi.fn(async () => [{}]), set: vi.fn() }, read = vi.fn()
    await prepareWpsLoginSession({ cookies } as unknown as Session, read)
    expect(read).not.toHaveBeenCalled()
    expect(cookies.set).not.toHaveBeenCalled()
  })
  it('imports the desktop identity before login only when the destination has no session', async () => {
    const cookies = { get: vi.fn(async () => []), set: vi.fn() }
    const cookie = { url: 'https://account.wps.cn/', domain: '.wps.cn', name: 'wps_sid', value: 'fixture', secure: true }
    await prepareWpsLoginSession({ cookies } as unknown as Session, async () => cookie)
    expect(cookies.get).toHaveBeenCalledWith({ url: 'https://account.wps.cn/', name: 'wps_sid' })
    expect(cookies.set).toHaveBeenCalledExactlyOnceWith(cookie)
  })
  it('leaves interactive login available when desktop credentials are unavailable', async () => {
    const cookies = { get: vi.fn(async () => []), set: vi.fn() }
    await prepareWpsLoginSession({ cookies } as unknown as Session, async () => null)
    expect(cookies.set).not.toHaveBeenCalled()
  })
})
