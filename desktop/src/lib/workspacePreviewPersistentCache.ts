import type {
  WorkspaceDiffResult,
  WorkspaceReadFileResult,
} from '../api/sessions'

export type WorkspacePreviewPayload =
  | { kind: 'diff'; result: WorkspaceDiffResult }
  | { kind: 'file'; result: WorkspaceReadFileResult }

export type CachedWorkspacePreviewPayload = {
  payload: WorkspacePreviewPayload
  cachedAt: number
}

export const WORKSPACE_PREVIEW_CACHE_DATABASE_NAME = 'cc-haha-workspace-preview-cache'
export const WORKSPACE_PREVIEW_CACHE_DATABASE_VERSION = 1
// Schema 2 invalidates previews persisted before full workspace comparisons
// became part of the required workspace-diff contract. In particular, a
// patch-only success must not keep full-file mode disabled after an upgrade.
export const WORKSPACE_PREVIEW_CACHE_SCHEMA_VERSION = 2
export const WORKSPACE_PREVIEW_CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000
export const WORKSPACE_PREVIEW_CACHE_MAX_ENTRIES = 64
export const WORKSPACE_PREVIEW_CACHE_MAX_BYTES = 32 * 1024 * 1024

const STORE_NAME = 'previews'

type PersistedWorkspacePreviewEntry = {
  key: string
  schemaVersion: number
  cachedAt: number
  expiresAt: number
  lastAccessedAt: number
  byteSize: number
  payload: WorkspacePreviewPayload
}

let databasePromise: Promise<IDBDatabase | null> | null = null

function indexedDbFactory(): IDBFactory | null {
  try {
    return typeof indexedDB === 'undefined' ? null : indexedDB
  } catch {
    return null
  }
}

export function canUseWorkspacePreviewPersistentCache(): boolean {
  return indexedDbFactory() !== null
}

function openDatabase(): Promise<IDBDatabase | null> {
  if (databasePromise) return databasePromise
  const factory = indexedDbFactory()
  if (!factory) return Promise.resolve(null)

  databasePromise = new Promise((resolve) => {
    let settled = false
    const finish = (database: IDBDatabase | null) => {
      if (settled) {
        database?.close()
        return
      }
      settled = true
      resolve(database)
    }

    try {
      const request = factory.open(
        WORKSPACE_PREVIEW_CACHE_DATABASE_NAME,
        WORKSPACE_PREVIEW_CACHE_DATABASE_VERSION,
      )
      request.onupgradeneeded = () => {
        const database = request.result
        if (!database.objectStoreNames.contains(STORE_NAME)) {
          database.createObjectStore(STORE_NAME, { keyPath: 'key' })
        }
      }
      request.onsuccess = () => {
        const database = request.result
        database.onversionchange = () => {
          database.close()
          if (databasePromise) databasePromise = null
        }
        finish(database)
      }
      request.onerror = () => finish(null)
      request.onblocked = () => finish(null)
    } catch {
      finish(null)
    }
  })

  return databasePromise
}

function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error ?? new Error('IndexedDB request failed'))
  })
}

function transactionDone(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve()
    transaction.onerror = () => reject(transaction.error ?? new Error('IndexedDB transaction failed'))
    transaction.onabort = () => reject(transaction.error ?? new Error('IndexedDB transaction aborted'))
  })
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function isSuccessfulPayload(value: unknown): value is WorkspacePreviewPayload {
  if (!isRecord(value) || (value.kind !== 'diff' && value.kind !== 'file')) return false
  if (!isRecord(value.result) || value.result.state !== 'ok' || typeof value.result.path !== 'string') {
    return false
  }

  if (value.kind === 'diff') {
    return value.result.diff === undefined || typeof value.result.diff === 'string'
  }

  return (
    typeof value.result.language === 'string'
    && typeof value.result.size === 'number'
    && Number.isFinite(value.result.size)
    && (value.result.content === undefined || typeof value.result.content === 'string')
    && (value.result.dataUrl === undefined || typeof value.result.dataUrl === 'string')
  )
}

function isPersistedEntry(value: unknown, now: number): value is PersistedWorkspacePreviewEntry {
  if (!isRecord(value)) return false
  return (
    typeof value.key === 'string'
    && value.schemaVersion === WORKSPACE_PREVIEW_CACHE_SCHEMA_VERSION
    && typeof value.cachedAt === 'number'
    && Number.isFinite(value.cachedAt)
    && typeof value.expiresAt === 'number'
    && Number.isFinite(value.expiresAt)
    && value.expiresAt > now
    && typeof value.lastAccessedAt === 'number'
    && Number.isFinite(value.lastAccessedAt)
    && typeof value.byteSize === 'number'
    && Number.isFinite(value.byteSize)
    && value.byteSize > 0
    && value.byteSize <= WORKSPACE_PREVIEW_CACHE_MAX_BYTES
    && isSuccessfulPayload(value.payload)
  )
}

function serializedByteSize(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value)).byteLength
}

async function deleteEntry(database: IDBDatabase, key: string): Promise<void> {
  const transaction = database.transaction(STORE_NAME, 'readwrite')
  transaction.objectStore(STORE_NAME).delete(key)
  await transactionDone(transaction)
}

async function trimCache(database: IDBDatabase): Promise<void> {
  const transaction = database.transaction(STORE_NAME, 'readwrite')
  const store = transaction.objectStore(STORE_NAME)
  const values = await requestResult(store.getAll()) as unknown[]
  const entries = values
    .filter((value): value is PersistedWorkspacePreviewEntry => isRecord(value) && typeof value.key === 'string')
    .sort((left, right) => {
      const leftAccessed = Number.isFinite(left.lastAccessedAt) ? left.lastAccessedAt : 0
      const rightAccessed = Number.isFinite(right.lastAccessedAt) ? right.lastAccessedAt : 0
      return leftAccessed - rightAccessed
    })
  let totalBytes = entries.reduce(
    (total, entry) => total + (Number.isFinite(entry.byteSize) ? Math.max(0, entry.byteSize) : 0),
    0,
  )
  let remainingEntries = entries.length

  for (const entry of entries) {
    if (
      remainingEntries <= WORKSPACE_PREVIEW_CACHE_MAX_ENTRIES
      && totalBytes <= WORKSPACE_PREVIEW_CACHE_MAX_BYTES
    ) break
    store.delete(entry.key)
    remainingEntries -= 1
    totalBytes -= Number.isFinite(entry.byteSize) ? Math.max(0, entry.byteSize) : 0
  }
  await transactionDone(transaction)
}

export async function getWorkspacePreviewPersistentCache(
  key: string,
): Promise<CachedWorkspacePreviewPayload | null> {
  try {
    const database = await openDatabase()
    if (!database) return null
    const transaction = database.transaction(STORE_NAME, 'readonly')
    const rawEntry = await requestResult(transaction.objectStore(STORE_NAME).get(key))
    await transactionDone(transaction)
    const now = Date.now()
    if (!isPersistedEntry(rawEntry, now)) {
      if (rawEntry !== undefined) await deleteEntry(database, key).catch(() => {})
      return null
    }

    const touchedEntry = { ...rawEntry, lastAccessedAt: now }
    const touchTransaction = database.transaction(STORE_NAME, 'readwrite')
    touchTransaction.objectStore(STORE_NAME).put(touchedEntry)
    await transactionDone(touchTransaction).catch(() => {})
    return { payload: rawEntry.payload, cachedAt: rawEntry.cachedAt }
  } catch {
    return null
  }
}

export async function setWorkspacePreviewPersistentCache(
  key: string,
  payload: WorkspacePreviewPayload,
): Promise<void> {
  if (!key || !isSuccessfulPayload(payload)) return
  try {
    const database = await openDatabase()
    if (!database) return
    const now = Date.now()
    const baseEntry = {
      key,
      schemaVersion: WORKSPACE_PREVIEW_CACHE_SCHEMA_VERSION,
      cachedAt: now,
      expiresAt: now + WORKSPACE_PREVIEW_CACHE_TTL_MS,
      lastAccessedAt: now,
      payload,
    }
    const entry: PersistedWorkspacePreviewEntry = {
      ...baseEntry,
      byteSize: serializedByteSize(baseEntry),
    }
    if (entry.byteSize > WORKSPACE_PREVIEW_CACHE_MAX_BYTES) return

    const transaction = database.transaction(STORE_NAME, 'readwrite')
    transaction.objectStore(STORE_NAME).put(entry)
    await transactionDone(transaction)
    await trimCache(database)
  } catch {
    // Persistence is an optimization. Quota, privacy-mode and corruption
    // failures must never prevent the live preview request from succeeding.
  }
}

export async function deleteWorkspacePreviewPersistentCache(key: string): Promise<void> {
  try {
    const database = await openDatabase()
    if (!database) return
    await deleteEntry(database, key)
  } catch {
    // Best-effort invalidation.
  }
}

export async function deleteWorkspacePreviewPersistentCachePrefix(prefix: string): Promise<void> {
  try {
    const database = await openDatabase()
    if (!database) return
    const transaction = database.transaction(STORE_NAME, 'readwrite')
    const store = transaction.objectStore(STORE_NAME)
    const keys = await requestResult(store.getAllKeys())
    for (const key of keys) {
      if (typeof key === 'string' && key.startsWith(prefix)) store.delete(key)
    }
    await transactionDone(transaction)
  } catch {
    // Best-effort invalidation.
  }
}

/** Close the module-level connection without deleting data, simulating reload. */
export async function closeWorkspacePreviewPersistentCacheForTests(): Promise<void> {
  const pending = databasePromise
  databasePromise = null
  const database = pending ? await pending.catch(() => null) : null
  database?.close()
}
