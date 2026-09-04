import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  closeWorkspacePreviewPersistentCacheForTests,
  deleteWorkspacePreviewPersistentCachePrefix,
  getWorkspacePreviewPersistentCache,
  setWorkspacePreviewPersistentCache,
  WORKSPACE_PREVIEW_CACHE_DATABASE_NAME,
  WORKSPACE_PREVIEW_CACHE_MAX_ENTRIES,
} from './workspacePreviewPersistentCache'

type FakeDatabaseRecord = {
  version: number
  stores: Map<string, Map<IDBValidKey, unknown>>
}

class FakeIndexedDbFactory {
  private readonly databases = new Map<string, FakeDatabaseRecord>()

  open(name: string, version?: number): IDBOpenDBRequest {
    const request = {} as IDBOpenDBRequest
    setTimeout(() => {
      const existing = this.databases.get(name)
      const requestedVersion = version ?? existing?.version ?? 1
      if (existing && requestedVersion < existing.version) {
        Object.assign(request, { error: new DOMException('Version too old', 'VersionError') })
        request.onerror?.(new Event('error'))
        return
      }
      const record = existing ?? { version: requestedVersion, stores: new Map() }
      const needsUpgrade = !existing || requestedVersion > record.version
      if (needsUpgrade) record.version = requestedVersion
      this.databases.set(name, record)
      const database = new FakeDatabase(record)
      Object.assign(request, { result: database })
      if (needsUpgrade) request.onupgradeneeded?.(new Event('upgradeneeded') as IDBVersionChangeEvent)
      request.onsuccess?.(new Event('success'))
    }, 0)
    return request
  }

  putRaw(databaseName: string, storeName: string, key: string, value: unknown) {
    const record = this.databases.get(databaseName)
    if (!record) throw new Error(`Missing fake database: ${databaseName}`)
    const store = record.stores.get(storeName)
    if (!store) throw new Error(`Missing fake object store: ${storeName}`)
    store.set(key, structuredClone(value))
  }

  keys(databaseName: string, storeName: string): string[] {
    const store = this.databases.get(databaseName)?.stores.get(storeName)
    return store ? [...store.keys()].map(String) : []
  }
}

class FakeDatabase {
  onversionchange: ((this: IDBDatabase, ev: IDBVersionChangeEvent) => unknown) | null = null

  constructor(private readonly record: FakeDatabaseRecord) {}

  get objectStoreNames(): DOMStringList {
    return {
      contains: (name: string) => this.record.stores.has(name),
      item: (index: number) => [...this.record.stores.keys()][index] ?? null,
      get length() { return 0 },
      [Symbol.iterator]: function* () {},
    } as DOMStringList
  }

  createObjectStore(name: string): IDBObjectStore {
    const values = new Map<IDBValidKey, unknown>()
    this.record.stores.set(name, values)
    return new FakeObjectStore(values, null) as unknown as IDBObjectStore
  }

  transaction(storeName: string, mode?: IDBTransactionMode): IDBTransaction {
    const values = this.record.stores.get(storeName)
    if (!values) throw new DOMException(`Missing store ${storeName}`, 'NotFoundError')
    return new FakeTransaction(values, mode ?? 'readonly') as unknown as IDBTransaction
  }

  close() {}
}

class FakeTransaction {
  oncomplete: ((this: IDBTransaction, ev: Event) => unknown) | null = null
  onerror: ((this: IDBTransaction, ev: Event) => unknown) | null = null
  onabort: ((this: IDBTransaction, ev: Event) => unknown) | null = null
  error: DOMException | null = null
  private pending = 0
  private completionScheduled = false

  constructor(
    private readonly values: Map<IDBValidKey, unknown>,
    private readonly mode: IDBTransactionMode,
  ) {}

  objectStore(): IDBObjectStore {
    return new FakeObjectStore(this.values, this) as unknown as IDBObjectStore
  }

  enqueue<T>(operation: () => T): IDBRequest<T> {
    const request = {} as IDBRequest<T>
    this.pending += 1
    setTimeout(() => {
      try {
        Object.assign(request, { result: structuredClone(operation()) })
        request.onsuccess?.(new Event('success'))
      } catch (error) {
        const failure = error instanceof DOMException
          ? error
          : new DOMException(String(error), 'UnknownError')
        Object.assign(request, { error: failure })
        this.error = failure
        request.onerror?.(new Event('error'))
        this.onerror?.call(this as unknown as IDBTransaction, new Event('error'))
      } finally {
        this.pending -= 1
        this.scheduleCompletion()
      }
    }, 0)
    return request
  }

  assertWritable() {
    if (this.mode === 'readonly') throw new DOMException('Readonly transaction', 'ReadOnlyError')
  }

  private scheduleCompletion() {
    if (this.completionScheduled) return
    this.completionScheduled = true
    setTimeout(() => {
      this.completionScheduled = false
      if (this.pending > 0) {
        this.scheduleCompletion()
        return
      }
      if (!this.error) {
        this.oncomplete?.call(this as unknown as IDBTransaction, new Event('complete'))
      }
    }, 0)
  }
}

class FakeObjectStore {
  constructor(
    private readonly values: Map<IDBValidKey, unknown>,
    private readonly transaction: FakeTransaction | null,
  ) {}

  get(key: IDBValidKey): IDBRequest<unknown> {
    return this.enqueue(() => this.values.get(key))
  }

  getAll(): IDBRequest<unknown[]> {
    return this.enqueue(() => [...this.values.values()])
  }

  getAllKeys(): IDBRequest<IDBValidKey[]> {
    return this.enqueue(() => [...this.values.keys()])
  }

  put(value: unknown): IDBRequest<IDBValidKey> {
    return this.enqueue<IDBValidKey>(() => {
      this.transaction?.assertWritable()
      const key = (value as { key?: unknown })?.key
      if (typeof key !== 'string') throw new DOMException('Missing key', 'DataError')
      this.values.set(key, structuredClone(value))
      return key
    })
  }

  delete(key: IDBValidKey): IDBRequest<undefined> {
    return this.enqueue(() => {
      this.transaction?.assertWritable()
      this.values.delete(key)
      return undefined
    })
  }

  private enqueue<T>(operation: () => T): IDBRequest<T> {
    if (this.transaction) return this.transaction.enqueue(operation)
    const request = {} as IDBRequest<T>
    Object.assign(request, { result: operation() })
    return request
  }
}

function diffPayload(path: string, diff = `diff for ${path}`) {
  return {
    kind: 'diff' as const,
    result: { state: 'ok' as const, path, diff },
  }
}

describe('workspacePreviewPersistentCache', () => {
  let factory: FakeIndexedDbFactory

  beforeEach(async () => {
    await closeWorkspacePreviewPersistentCacheForTests()
    factory = new FakeIndexedDbFactory()
    vi.stubGlobal('indexedDB', factory)
  })

  afterEach(async () => {
    await closeWorkspacePreviewPersistentCacheForTests()
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('reads a successful payload after the module connection is reopened', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(1_000)
    await setWorkspacePreviewPersistentCache('session\0src/a.ts', diffPayload('src/a.ts'))
    await closeWorkspacePreviewPersistentCacheForTests()

    await expect(getWorkspacePreviewPersistentCache('session\0src/a.ts')).resolves.toEqual({
      payload: diffPayload('src/a.ts'),
      cachedAt: 1_000,
    })
  })

  it('rejects expired and incompatible-schema entries and removes them', async () => {
    const now = vi.spyOn(Date, 'now').mockReturnValue(5_000)
    await setWorkspacePreviewPersistentCache('expired', diffPayload('expired.ts'))
    now.mockReturnValue(5_000 + 7 * 24 * 60 * 60 * 1000 + 1)
    await expect(getWorkspacePreviewPersistentCache('expired')).resolves.toBeNull()

    factory.putRaw(WORKSPACE_PREVIEW_CACHE_DATABASE_NAME, 'previews', 'bad-version', {
      key: 'bad-version',
      schemaVersion: 999,
      cachedAt: 5_000,
      expiresAt: Number.MAX_SAFE_INTEGER,
      lastAccessedAt: 5_000,
      byteSize: 10,
      payload: diffPayload('bad.ts'),
    })
    await expect(getWorkspacePreviewPersistentCache('bad-version')).resolves.toBeNull()
    expect(factory.keys(WORKSPACE_PREVIEW_CACHE_DATABASE_NAME, 'previews')).not.toContain('bad-version')
  })

  it('deletes every matching prefix without disturbing other sessions', async () => {
    await setWorkspacePreviewPersistentCache('session-a\0one', diffPayload('one.ts'))
    await setWorkspacePreviewPersistentCache('session-a\0two', diffPayload('two.ts'))
    await setWorkspacePreviewPersistentCache('session-b\0one', diffPayload('other.ts'))

    await deleteWorkspacePreviewPersistentCachePrefix('session-a\0')

    await expect(getWorkspacePreviewPersistentCache('session-a\0one')).resolves.toBeNull()
    await expect(getWorkspacePreviewPersistentCache('session-a\0two')).resolves.toBeNull()
    await expect(getWorkspacePreviewPersistentCache('session-b\0one')).resolves.toMatchObject({
      payload: { result: { path: 'other.ts' } },
    })
  })

  it('trims least-recently-used entries when the count limit is exceeded', async () => {
    const now = vi.spyOn(Date, 'now')
    for (let index = 0; index <= WORKSPACE_PREVIEW_CACHE_MAX_ENTRIES; index += 1) {
      now.mockReturnValue(10_000 + index)
      await setWorkspacePreviewPersistentCache(`entry-${index}`, diffPayload(`${index}.ts`))
    }

    await expect(getWorkspacePreviewPersistentCache('entry-0')).resolves.toBeNull()
    await expect(getWorkspacePreviewPersistentCache(`entry-${WORKSPACE_PREVIEW_CACHE_MAX_ENTRIES}`))
      .resolves.toMatchObject({ payload: { result: { path: `${WORKSPACE_PREVIEW_CACHE_MAX_ENTRIES}.ts` } } })
    expect(factory.keys(WORKSPACE_PREVIEW_CACHE_DATABASE_NAME, 'previews'))
      .toHaveLength(WORKSPACE_PREVIEW_CACHE_MAX_ENTRIES)
  })

  it('silently degrades when IndexedDB is unavailable and skips failed payloads', async () => {
    await closeWorkspacePreviewPersistentCacheForTests()
    vi.stubGlobal('indexedDB', undefined)
    await expect(setWorkspacePreviewPersistentCache('key', diffPayload('a.ts'))).resolves.toBeUndefined()
    await expect(getWorkspacePreviewPersistentCache('key')).resolves.toBeNull()

    vi.stubGlobal('indexedDB', factory)
    await setWorkspacePreviewPersistentCache('error', {
      kind: 'diff',
      result: { state: 'error', path: 'a.ts', error: 'failed' },
    })
    await expect(getWorkspacePreviewPersistentCache('error')).resolves.toBeNull()
  })
})
