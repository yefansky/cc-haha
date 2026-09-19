import { create } from 'zustand'
import { persist } from 'zustand/middleware'

export type BrowserLinkPreference = 'auto' | 'in-app' | 'system'

// A phone and the Electron desktop must never overwrite each other's choice.
// This preference belongs to this client, not the server's shared settings.
export const useBrowserLinkPreference = create<{
  preference: BrowserLinkPreference
  setPreference: (preference: BrowserLinkPreference) => void
}>()(persist((set) => ({
  preference: 'auto',
  setPreference: (preference) => set({ preference }),
}), { name: 'cc-haha-browser-link-preference' }))

export function remoteBrowserDestination(
  url: string,
  isDesktop: boolean,
  preference: BrowserLinkPreference = 'auto',
): 'in-app' | 'system' {
  if (preference === 'system' || preference === 'in-app') return preference
  // An OAuth login cannot finish inside H5's sandboxed document-preview iframe.
  // On the web, "system" means the current device's browser, not the work PC.
  const parsed = new URL(url)
  const oauth = parsed.searchParams.has('client_id') && parsed.searchParams.has('response_type')
  return isDesktop || oauth ? 'system' : 'in-app'
}
