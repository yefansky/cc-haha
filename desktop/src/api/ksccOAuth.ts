import { api } from './client'

export type KsccOAuthStatus = {
  loggedIn: boolean
  pending: boolean
  active: boolean
}

export const ksccOAuthApi = {
  start() {
    return api.post<{ authorizeUrl?: string; reusedLocalLogin: boolean }>('/api/kscc-oauth/start', {})
  },
  status() {
    return api.get<KsccOAuthStatus>('/api/kscc-oauth')
  },
}
