import { afterEach, describe, expect, test } from 'vitest'
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { GatewayCredentials, type SafeStorageLike } from './gatewayCredentials'

const dirs: string[] = []
const secret = 'cgk_fake.ONLY_TEST_SECRET_123456'
const url = 'https://gateway.example:8443'
function directory() {
  const dir = mkdtempSync(join(tmpdir(), 'gateway-credentials-test-'))
  dirs.push(dir)
  return dir
}
function storage(backend = 'gnome_libsecret', available = true): SafeStorageLike {
  const key = randomBytes(32)
  return {
    isEncryptionAvailable: () => available,
    getSelectedStorageBackend: () => backend,
    encryptString(value) {
      const iv = randomBytes(12)
      const cipher = createCipheriv('aes-256-gcm', key, iv)
      const body = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()])
      return Buffer.concat([iv, cipher.getAuthTag(), body])
    },
    decryptString(value) {
      const cipher = createDecipheriv('aes-256-gcm', key, value.subarray(0, 12))
      cipher.setAuthTag(value.subarray(12, 28))
      return Buffer.concat([cipher.update(value.subarray(28)), cipher.final()]).toString('utf8')
    },
  }
}
function setup(platform: NodeJS.Platform = 'win32', safeStorage = storage()) {
  const dir = directory()
  return { dir, file: join(dir, 'gateway-access.json'), safeStorage,
    create: () => new GatewayCredentials({ directory: dir, safeStorage, platform }) }
}
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })

describe('GatewayCredentials', () => {
  test('fixed errors expose code without requiring message parsing', () => {
    const fixture = setup()
    const credentials = fixture.create()
    writeFileSync(fixture.file, '{invalid')
    const cases = [
      { action: () => credentials.save({ gatewayUrl: url, accessKey: '' }), code: 'CONFIG_INVALID' },
      { action: fixture.create, code: 'STORAGE_ERROR' },
    ]
    for (const { action, code } of cases) {
      let caught: unknown
      try { action() } catch (error) { caught = error }
      expect(caught).toBeInstanceOf(Error)
      expect(caught).toMatchObject({ code, message: code })
    }
  })

  test('absent file is side-effect free and secret-free', () => {
    const fixture = setup()
    expect(fixture.create().getConfig()).toEqual({ gatewayUrl: '', autoStart: false, hasKey: false, credentialStorage: 'none' })
    expect(fixture.create().getAccessKey()).toBeUndefined()
    expect(readdirSync(fixture.dir)).toEqual([])
  })

  test('Windows encrypted save reload preserve replace and clear drive the whole transition', () => {
    const fixture = setup()
    const credentials = fixture.create()
    expect(credentials.save({ gatewayUrl: url, accessKey: secret, autoStart: true })).toEqual({ gatewayUrl: url, hasKey: true, credentialStorage: 'encrypted', autoStart: true })
    const raw = readFileSync(fixture.file, 'utf8')
    expect(raw).not.toContain(secret)
    expect(raw).not.toContain(Buffer.from(secret).toString('base64'))
    expect(JSON.parse(raw).version).toBe(1)
    const reload = fixture.create()
    expect(reload.getAccessKey()).toBe(secret)
    reload.save({ gatewayUrl: 'https://OTHER.example/' })
    expect(reload.getConfig().gatewayUrl).toBe('https://other.example')
    expect(reload.getConfig().autoStart).toBe(true)
    expect(reload.getAccessKey()).toBe(secret)
    reload.save({ gatewayUrl: url, accessKey: 'replacement', autoStart: false })
    expect(fixture.create().getAccessKey()).toBe('replacement')
    expect(reload.clearKey()).toEqual({ gatewayUrl: url, hasKey: false, credentialStorage: 'none', autoStart: false })
    expect(fixture.create().getAccessKey()).toBeUndefined()
    expect(readdirSync(fixture.dir)).toEqual(['gateway-access.json'])
  })

  for (const backend of ['basic_text', 'unknown', '', 'future_backend']) {
    test(`Linux ${backend} only persists public config and loses key on restart`, () => {
      const fixture = setup('linux', storage(backend))
      const credentials = fixture.create()
      expect(credentials.save({ gatewayUrl: url, accessKey: secret, autoStart: true }).credentialStorage).toBe('memory')
      credentials.save({ gatewayUrl: url })
      expect(credentials.getAccessKey()).toBe(secret)
      expect(JSON.parse(readFileSync(fixture.file, 'utf8'))).toEqual({ version: 1, gatewayUrl: url, autoStart: true })
      expect(fixture.create().getConfig()).toEqual({ gatewayUrl: url, autoStart: true, hasKey: false, credentialStorage: 'none' })
      credentials.clearKey()
      expect(credentials.getAccessKey()).toBeUndefined()
    })
  }
  for (const backend of ['gnome_libsecret', 'kwallet', 'kwallet5', 'kwallet6']) {
    test(`Linux secure ${backend} survives restart`, () => {
      const fixture = setup('linux', storage(backend))
      expect(fixture.create().save({ gatewayUrl: url, accessKey: secret }).credentialStorage).toBe('encrypted')
      expect(fixture.create().getAccessKey()).toBe(secret)
    })
  }
  test('unavailable or throwing backend is memory only without invoking crypto', () => {
    for (const throwing of [false, true]) {
      const safeStorage = storage()
      safeStorage.isEncryptionAvailable = () => { if (throwing) throw new Error(secret); return false }
      safeStorage.encryptString = () => { throw new Error('must not encrypt') }
      const fixture = setup('linux', safeStorage)
      expect(fixture.create().save({ gatewayUrl: url, accessKey: secret }).credentialStorage).toBe('memory')
    }
  })
  for (const version of [undefined, 0]) {
    test(`configuration-only legacy ${version} migrates on explicit save`, () => {
      const fixture = setup()
      const old = JSON.stringify({ version, gatewayUrl: url })
      writeFileSync(fixture.file, old)
      const credentials = fixture.create()
      expect(readFileSync(fixture.file, 'utf8')).toBe(old)
      expect(credentials.getConfig().autoStart).toBe(false)
      credentials.save({ gatewayUrl: url, accessKey: secret })
      expect(JSON.parse(readFileSync(fixture.file, 'utf8')).version).toBe(1)
      expect(fixture.create().getAccessKey()).toBe(secret)
    })
  }
  for (const raw of ['{bad', 'null', '[]', '{"version":99}', JSON.stringify({ gatewayUrl: url, accessKey: secret }),
    JSON.stringify({ version: 1, gatewayUrl: url, autoStart: false, encryptedKey: '%%%' })]) {
    test(`invalid or unknown record is preserved: ${raw.slice(0, 20)}`, () => {
      const fixture = setup()
      writeFileSync(fixture.file, raw)
      expect(fixture.create).toThrow('STORAGE_ERROR')
      expect(readFileSync(fixture.file, 'utf8')).toBe(raw)
    })
  }
  test('ciphertext decrypt failure and backend loss never overwrite the original', () => {
    const fixture = setup()
    const credentials = fixture.create()
    credentials.save({ gatewayUrl: url, accessKey: secret })
    const original = readFileSync(fixture.file, 'utf8')
    fixture.safeStorage.decryptString = () => { throw new Error(secret) }
    for (const action of [fixture.create, () => credentials.getConfig(), () => credentials.getAccessKey(),
      () => credentials.save({ gatewayUrl: url, accessKey: 'new' }), () => credentials.clearKey()]) {
      expect(action).toThrow(/^STORAGE_ERROR$/)
      expect(readFileSync(fixture.file, 'utf8')).toBe(original)
    }
    fixture.safeStorage.isEncryptionAvailable = () => false
    expect(fixture.create).toThrow(/^STORAGE_ERROR$/)
    expect(readFileSync(fixture.file, 'utf8')).toBe(original)
  })
  test('encryption failure is sanitized and does not change state or file', () => {
    const fixture = setup()
    const credentials = fixture.create()
    credentials.save({ gatewayUrl: url })
    const original = readFileSync(fixture.file, 'utf8')
    fixture.safeStorage.encryptString = () => { throw new Error(secret) }
    expect(() => credentials.save({ gatewayUrl: url, accessKey: secret })).toThrow(/^STORAGE_ERROR$/)
    expect(credentials.getConfig().hasKey).toBe(false)
    expect(readFileSync(fixture.file, 'utf8')).toBe(original)
  })
  test('Linux secure-to-basic_text transition protects existing ciphertext', () => {
    const fixture = setup('linux')
    const credentials = fixture.create()
    credentials.save({ gatewayUrl: url, accessKey: secret })
    const original = readFileSync(fixture.file, 'utf8')
    fixture.safeStorage.getSelectedStorageBackend = () => 'basic_text'
    expect(fixture.create).toThrow(/^STORAGE_ERROR$/)
    expect(() => credentials.save({ gatewayUrl: url, accessKey: 'replacement' })).toThrow(/^STORAGE_ERROR$/)
    expect(() => credentials.clearKey()).toThrow(/^STORAGE_ERROR$/)
    expect(readFileSync(fixture.file, 'utf8')).toBe(original)
  })
  test('well-formed but foreign ciphertext is preserved without automatic recovery', () => {
    const fixture = setup()
    fixture.create().save({ gatewayUrl: url, accessKey: secret })
    const original = readFileSync(fixture.file, 'utf8')
    expect(() => new GatewayCredentials({ directory: fixture.dir, safeStorage: storage(), platform: 'win32' })).toThrow(/^STORAGE_ERROR$/)
    expect(readFileSync(fixture.file, 'utf8')).toBe(original)
  })
  test('out-of-band modification and stale instances cannot overwrite the latest file', () => {
    const fixture = setup()
    const first = fixture.create()
    const stale = fixture.create()
    first.save({ gatewayUrl: url, accessKey: secret })
    const original = readFileSync(fixture.file, 'utf8')
    expect(() => stale.save({ gatewayUrl: url })).toThrow(/^STORAGE_ERROR$/)
    expect(readFileSync(fixture.file, 'utf8')).toBe(original)
    writeFileSync(fixture.file, 'corrupt')
    expect(() => first.clearKey()).toThrow(/^STORAGE_ERROR$/)
    expect(readFileSync(fixture.file, 'utf8')).toBe('corrupt')
    expect(first.getAccessKey()).toBe(secret)
  })
  test('invalid values never write and expose only CONFIG_INVALID', () => {
    const fixture = setup()
    const credentials = fixture.create()
    for (const input of [
      { gatewayUrl: url, accessKey: '' }, { gatewayUrl: url, accessKey: 'key with space' },
      { gatewayUrl: url, accessKey: 'x'.repeat(4097) }, { gatewayUrl: url, autoStart: 'yes' },
      ...['', 'file:///x', 'https://u:secret@host', 'https://host/path', 'https://host?q=secret', 'https://host#secret', 'https://host\n'].map(gatewayUrl => ({ gatewayUrl })),
    ]) expect(() => credentials.save(input as never)).toThrow(/^CONFIG_INVALID$/)
    expect(readdirSync(fixture.dir)).toEqual([])
  })
  test('HTTP LAN config is supported without claiming encryption of transport', () => {
    const fixture = setup()
    expect(fixture.create().save({ gatewayUrl: 'http://192.168.1.5:8000' }).gatewayUrl).toBe('http://192.168.1.5:8000')
  })
  test('write failure preserves old in-memory state and sanitizes path errors', () => {
    const dir = directory()
    const parent = join(dir, 'not-a-directory')
    const credentials = new GatewayCredentials({ directory: parent, safeStorage: storage(), platform: 'win32' })
    writeFileSync(parent, secret)
    expect(() => credentials.save({ gatewayUrl: url, accessKey: secret })).toThrow(/^STORAGE_ERROR$/)
    expect(credentials.getConfig().hasKey).toBe(false)
    expect(readFileSync(parent, 'utf8')).toBe(secret)
  })
})
