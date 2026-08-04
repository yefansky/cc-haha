import { create } from 'zustand'
import { ksccOAuthApi, type KsccOAuthStatus } from '../api/ksccOAuth'

const POLL_INTERVAL_MS = 2_000

type KsccOAuthState = {
  status: KsccOAuthStatus | null
  isLoading: boolean
  error: string | null
  fetchStatus: () => Promise<void>
  login: () => Promise<{ authorizeUrl?: string; reusedLocalLogin: boolean }>
  startPolling: () => void
  stopPolling: () => void
}

export const useKsccOAuthStore = create<KsccOAuthState>((set, get) => {
  let timer: ReturnType<typeof setTimeout> | null = null
  let polling = false
  return {
    status: null,
    isLoading: false,
    error: null,
    fetchStatus: async () => {
      try {
        set({ status: await ksccOAuthApi.status(), error: null })
      } catch (error) {
        set({ error: error instanceof Error ? error.message : String(error) })
      }
    },
    login: async () => {
      set({ isLoading: true, error: null })
      try {
        const result = await ksccOAuthApi.start()
        set({ isLoading: false })
        return result
      } catch (error) {
        set({ isLoading: false, error: error instanceof Error ? error.message : String(error) })
        throw error
      }
    },
    startPolling: () => {
      if (polling) return
      polling = true
      const next = () => {
        timer = setTimeout(async () => {
          await get().fetchStatus()
          if (get().status?.loggedIn || !polling) {
            get().stopPolling()
          } else {
            next()
          }
        }, POLL_INTERVAL_MS)
      }
      next()
    },
    stopPolling: () => {
      polling = false
      if (timer) clearTimeout(timer)
      timer = null
    },
  }
})
