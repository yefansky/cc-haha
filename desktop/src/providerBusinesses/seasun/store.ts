import { create } from 'zustand'
import { getDesktopHost } from '@/lib/desktopHost'
import { useProviderStore } from '@/stores/providerStore'
import { seasunApi } from './api'
import type { SeasunStatus } from './types'

type SeasunState = {
  status: SeasunStatus | null
  busy: boolean
  cancelling: boolean
  error: 'login_failed' | 'cancel_unconfirmed' | null
  refresh(clearError?: boolean): Promise<void>
  login(): Promise<void>
  cancel(): Promise<void>
}
let operation = 0

export const useSeasunStore = create<SeasunState>((set, get) => ({
  status: null, busy: false, cancelling: false, error: null,
  async refresh(clearError = true) {
    const current = operation
    try {
      const status = await seasunApi.status()
      if (current !== operation) return
      set({ status, ...(clearError ? { error: null } : {}) })
      await useProviderStore.getState().fetchProviders()
    } catch { if (current === operation) set({ error: 'login_failed' }) }
  },
  async login() {
    if (get().busy) return
    const host = getDesktopHost().providerBusinesses?.seasun
    if (!host) { set({ error: 'login_failed' }); return }
    const current = ++operation
    set({ busy: true, cancelling: false, error: null })
    try {
      const status = await host.login()
      if (current !== operation) return
      set({ status, error: status.errorCode === 'cancel_unconfirmed' ? 'cancel_unconfirmed' : status.phase === 'error' ? 'login_failed' : null })
      await get().refresh(false)
    } catch { if (current === operation) set({ error: 'login_failed' }) }
    finally { if (current === operation) set({ busy: false }) }
  },
  async cancel() {
    const host = getDesktopHost().providerBusinesses?.seasun
    if (!host) return
    const current = ++operation
    set({ busy: true, cancelling: true, error: null })
    try {
      const status = await host.cancel()
      if (current !== operation) return
      set({ status, error: status.errorCode === 'cancel_unconfirmed' ? 'cancel_unconfirmed' : status.phase === 'error' ? 'login_failed' : null })
      await get().refresh(false)
    } catch { if (current === operation) set({ error: 'cancel_unconfirmed' }) }
    finally { if (current === operation) set({ busy: false, cancelling: false }) }
  },
}))
