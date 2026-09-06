import type { SavedProvider } from '../types/provider.js'

/** Each entry is owned by one CLI process, never by the mutable default Provider. */
export class ProviderRuntimeSnapshots {
  private readonly entries = new Map<string, SavedProvider>()
  create(provider: SavedProvider) {
    const id = crypto.randomUUID()
    this.entries.set(id, structuredClone(provider))
    return id
  }
  read(id: string): SavedProvider | undefined {
    const value = this.entries.get(id)
    return value ? structuredClone(value) : undefined
  }
  release(id: string) { this.entries.delete(id) }
}

export const providerRuntimeSnapshots = new ProviderRuntimeSnapshots()
