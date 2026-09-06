import { api } from '@/api/client'
import { parseSeasunStatus } from './types'

export const seasunApi = {
  async status() {
    return parseSeasunStatus(await api.get<unknown>('/api/provider-integrations/seasun/status'))
  },
}
