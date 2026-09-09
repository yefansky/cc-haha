import { randomUUID } from 'node:crypto'
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { GatewayConfig, GatewaySaveInput } from '../../src/lib/desktopHost/gatewayTypes'

export interface SafeStorageLike {
  isEncryptionAvailable(): boolean
  encryptString(value: string): Buffer
  decryptString(value: Buffer): string
  getSelectedStorageBackend?(): string
}

type RecordV1 = { version: 1; gatewayUrl: string; autoStart: boolean; encryptedKey?: string }
const fail = (code: 'STORAGE_ERROR' | 'CONFIG_INVALID'): never => { throw Object.assign(new Error(code), { code }) }

function gatewayUrl(value: unknown): string {
  if (typeof value !== 'string' || !value || value.length > 2048 || /\s|\p{Cc}/u.test(value)) return fail('CONFIG_INVALID')
  try {
    const url = new URL(value)
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password ||
      url.search || url.hash || url.pathname !== '/' || value.includes('?') || value.includes('#')) return fail('CONFIG_INVALID')
    return url.origin
  } catch { return fail('CONFIG_INVALID') }
}

function validKey(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && Buffer.byteLength(value, 'utf8') <= 4096 && !/\s|\p{Cc}/u.test(value)
}

/** Main-process only. Never expose getAccessKey through IPC. */
export class GatewayCredentials {
  private readonly file: string
  private readonly safeStorage: SafeStorageLike
  private readonly platform: NodeJS.Platform
  private record: RecordV1 = { version: 1, gatewayUrl: '', autoStart: false }
  private memoryKey?: string
  private original?: string

  constructor({ directory, safeStorage, platform = process.platform }: {
    directory: string
    safeStorage: SafeStorageLike
    platform?: NodeJS.Platform
  }) {
    this.file = join(directory, 'gateway-access.json')
    this.safeStorage = safeStorage
    this.platform = platform
    try {
      this.original = this.readRaw()
      if (this.original === undefined) return
      const data = JSON.parse(this.original)
      if (!data || typeof data !== 'object' || Array.isArray(data)) return fail('STORAGE_ERROR')
      // The only pre-v1 fixture is configuration-only; never migrate plaintext secrets.
      const legacy = data.version === undefined || data.version === 0
      const allowed = legacy ? ['version', 'gatewayUrl', 'autoStart'] : ['version', 'gatewayUrl', 'autoStart', 'encryptedKey']
      if ((!legacy && data.version !== 1) || Object.keys(data).some(key => !allowed.includes(key))) return fail('STORAGE_ERROR')
      if (typeof data.gatewayUrl !== 'string' || (!legacy && typeof data.autoStart !== 'boolean') ||
        (data.autoStart !== undefined && typeof data.autoStart !== 'boolean')) return fail('STORAGE_ERROR')
      const normalized = data.gatewayUrl === '' ? '' : gatewayUrl(data.gatewayUrl)
      if (data.encryptedKey !== undefined && (typeof data.encryptedKey !== 'string' || !data.encryptedKey ||
        data.encryptedKey.length > 65536 || Buffer.from(data.encryptedKey, 'base64').toString('base64') !== data.encryptedKey)) return fail('STORAGE_ERROR')
      this.record = { version: 1, gatewayUrl: normalized, autoStart: data.autoStart ?? false,
        ...(data.encryptedKey === undefined ? {} : { encryptedKey: data.encryptedKey }) }
      if (this.record.encryptedKey !== undefined) this.decrypt()
    } catch { fail('STORAGE_ERROR') }
  }

  private readRaw(): string | undefined {
    try { return readFileSync(this.file, 'utf8') } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
      return fail('STORAGE_ERROR')
    }
  }

  private secure(): boolean {
    try {
      if (!this.safeStorage.isEncryptionAvailable()) return false
      if (this.platform !== 'linux') return true
      return ['gnome_libsecret', 'kwallet', 'kwallet5', 'kwallet6'].includes(this.safeStorage.getSelectedStorageBackend?.() ?? '')
    } catch { return false }
  }

  private decrypt(): string | undefined {
    if (this.record.encryptedKey === undefined) return undefined
    try {
      if (!this.secure()) return fail('STORAGE_ERROR')
      const key = this.safeStorage.decryptString(Buffer.from(this.record.encryptedKey, 'base64'))
      if (!validKey(key)) return fail('STORAGE_ERROR')
      return key
    } catch { return fail('STORAGE_ERROR') }
  }

  getConfig(): GatewayConfig {
    // Recheck backend availability; protected ciphertext must not silently become "no key".
    const encrypted = this.record.encryptedKey !== undefined
    if (encrypted) this.decrypt()
    return { gatewayUrl: this.record.gatewayUrl, autoStart: this.record.autoStart,
      hasKey: encrypted || this.memoryKey !== undefined,
      credentialStorage: encrypted ? 'encrypted' : this.memoryKey !== undefined ? 'memory' : 'none' }
  }

  getAccessKey(): string | undefined { return this.decrypt() ?? this.memoryKey }

  save(input: GatewaySaveInput): GatewayConfig {
    if (!input || typeof input !== 'object' || Array.isArray(input) ||
      Object.keys(input).some(key => !['gatewayUrl', 'accessKey', 'autoStart'].includes(key)) ||
      (input.autoStart !== undefined && typeof input.autoStart !== 'boolean') ||
      (input.accessKey !== undefined && !validKey(input.accessKey))) return fail('CONFIG_INVALID')
    const url = gatewayUrl(input.gatewayUrl)
    this.getConfig()
    const next: RecordV1 = { ...this.record, gatewayUrl: url, autoStart: input.autoStart ?? this.record.autoStart }
    let memory = this.memoryKey
    if (input.accessKey !== undefined) {
      if (this.secure()) {
        try {
          const encrypted = this.safeStorage.encryptString(input.accessKey)
          if (!Buffer.isBuffer(encrypted) || encrypted.length === 0 || encrypted.length > 49152 ||
            this.safeStorage.decryptString(encrypted) !== input.accessKey) return fail('STORAGE_ERROR')
          next.encryptedKey = encrypted.toString('base64')
          memory = undefined
        } catch { return fail('STORAGE_ERROR') }
      } else {
        delete next.encryptedKey
        memory = input.accessKey
      }
    }
    this.persist(next)
    this.memoryKey = memory
    return this.getConfig()
  }

  clearKey(): GatewayConfig {
    this.getConfig()
    const next = { ...this.record }
    delete next.encryptedKey
    this.persist(next)
    this.memoryKey = undefined
    return this.getConfig()
  }

  private persist(next: RecordV1): void {
    const temporary = `${this.file}.${randomUUID()}.tmp`
    let fd: number | undefined
    try {
      // Do not overwrite corruption or another instance's update since our snapshot.
      if (this.readRaw() !== this.original) return fail('STORAGE_ERROR')
      mkdirSync(join(this.file, '..'), { recursive: true, mode: 0o700 })
      fd = openSync(temporary, 'wx', 0o600)
      const raw = JSON.stringify(next) + '\n'
      writeFileSync(fd, raw, 'utf8')
      fsyncSync(fd)
      closeSync(fd)
      fd = undefined
      renameSync(temporary, this.file)
      this.record = next
      this.original = raw
    } catch { fail('STORAGE_ERROR') } finally {
      if (fd !== undefined) { try { closeSync(fd) } catch { /* Preserve the fixed storage error. */ } }
      try { if (existsSync(temporary)) unlinkSync(temporary) } catch { /* Never expose filesystem error text. */ }
    }
  }
}
