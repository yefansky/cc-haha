import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import '@testing-library/jest-dom'
import { providersApi } from '@/api/providers'
import { ksccOAuthApi } from './api'
import { KsccLogin } from './KsccLogin'
import { ModelSelector } from '@/components/controls/ModelSelector'
import { useProviderStore } from '@/stores/providerStore'
import { useSettingsStore } from '@/stores/settingsStore'
import { useKsccOAuthStore } from './store'
import type { SavedProvider } from '@/types/provider'

const provider: SavedProvider = {
  id: 'kscc-test', presetId: 'kscc', name: 'KSCC', apiKey: 'fake', baseUrl: 'http://kscc.test', apiFormat: 'anthropic',
  models: { main: 'kept', haiku: 'kept', sonnet: 'kept', opus: 'kept' },
  modelCatalog: ['kept', 'removed'].map(id => ({ id, capabilities: [] })),
}
let saved: SavedProvider
beforeEach(() => {
  saved = structuredClone(provider)
  useProviderStore.setState(useProviderStore.getInitialState(), true)
  useSettingsStore.setState({ locale: 'zh' })
  vi.spyOn(providersApi, 'list').mockImplementation(async () => ({ providers: [structuredClone(saved)], activeId: null, modelRefreshProviderIds: [provider.id] }))
  vi.spyOn(ksccOAuthApi, 'status').mockResolvedValue({ loggedIn: true, pending: false, active: false })
})
afterEach(async () => {
  cleanup()
  useKsccOAuthStore.getState().stopPolling()
  useKsccOAuthStore.setState(useKsccOAuthStore.getInitialState(), true)
  useProviderStore.setState(useProviderStore.getInitialState(), true)
  vi.restoreAllMocks()
})

it('loads cache immediately, refreshes once at startup, and updates the real selector without changing its session', async () => {
  let finish!: () => void
  const refresh = vi.spyOn(providersApi, 'refreshModelCatalog').mockImplementation(() => new Promise(resolve => {
    finish = () => {
      saved = { ...saved, modelCatalog: ['kept', 'deepseekv-4.1-flash'].map(id => ({ id, capabilities: [] })) }
      resolve({ provider: saved })
    }
  }))
  const onSelection = vi.fn()
  await useProviderStore.getState().fetchProviders()
  expect(useProviderStore.getState().providers[0]?.modelCatalog?.map(model => model.id)).toContain('removed')
  expect(useProviderStore.getState().isLoading).toBe(false)
  render(<ModelSelector runtimeKey="busy-session" runtimeSelection={{ providerId: provider.id, modelId: 'kept' }} onRuntimeSelectionChange={onSelection} />)
  await act(async () => {
    finish()
    await useProviderStore.getState().refreshModelCatalog(provider.id)
  })
  fireEvent.click(screen.getByRole('button', { name: /kept/ }))
  expect(await screen.findByRole('button', { name: /deepseekv-4.1-flash/ })).toBeInTheDocument()
  expect(screen.queryByRole('button', { name: /removed/ })).not.toBeInTheDocument()
  expect(onSelection).not.toHaveBeenCalled()
  expect(useProviderStore.getState().activeId).toBeNull()
  await act(async () => { await useProviderStore.getState().fetchProviders() })
  expect(refresh).toHaveBeenCalledTimes(1)
})

it('keeps cached models after startup failure and the manual button retries through the real store', async () => {
  const refresh = vi.spyOn(providersApi, 'refreshModelCatalog').mockRejectedValueOnce(new Error('offline'))
    .mockImplementation(async () => {
      saved = { ...saved, modelCatalog: [{ id: 'deepseekv-4.1-flash', capabilities: [] }] }
      return { provider: saved }
    })
  await useProviderStore.getState().fetchProviders()
  render(<KsccLogin />)
  expect(await screen.findByText(/刷新失败，已保留/)).toBeInTheDocument()
  expect(useProviderStore.getState().providers[0]?.modelCatalog).toEqual(provider.modelCatalog)
  fireEvent.click(screen.getByRole('button', { name: '刷新模型' }))
  expect(await screen.findByText(/模型已更新/)).toBeInTheDocument()
  await waitFor(() => expect(useProviderStore.getState().providers[0]?.modelCatalog?.[0]?.id).toBe('deepseekv-4.1-flash'))
  expect(refresh).toHaveBeenCalledTimes(2)
})

it('a new client startup refreshes again even after the previous successful sync', async () => {
  const refresh = vi.spyOn(providersApi, 'refreshModelCatalog').mockImplementation(async () => ({ provider: saved }))
  await useProviderStore.getState().fetchProviders()
  await useProviderStore.getState().refreshModelCatalog(provider.id)
  useProviderStore.setState(useProviderStore.getInitialState(), true)
  await useProviderStore.getState().fetchProviders()
  await useProviderStore.getState().refreshModelCatalog(provider.id)
  expect(refresh).toHaveBeenCalledTimes(2)
})

it('does not report success when the saved catalog cannot be reloaded after the POST', async () => {
  vi.spyOn(providersApi, 'refreshModelCatalog').mockImplementation(async () => {
    vi.mocked(providersApi.list).mockRejectedValue(new Error('list offline'))
    return { provider: saved }
  })
  await useProviderStore.getState().fetchProviders()
  await useProviderStore.getState().refreshModelCatalog(provider.id)
  expect(useProviderStore.getState().modelRefreshStatus[provider.id]).toMatchObject({ pending: false, failed: true })
  expect(useProviderStore.getState().modelRefreshStatus[provider.id]?.updatedAt).toBeUndefined()
})

it('marks an existing session model unavailable after removal without silently switching it', async () => {
  vi.spyOn(providersApi, 'refreshModelCatalog').mockImplementation(async () => {
    saved = { ...saved, modelCatalog: [{ id: 'kept', capabilities: [] }] }
    return { provider: saved }
  })
  await useProviderStore.getState().fetchProviders()
  await useProviderStore.getState().refreshModelCatalog(provider.id)
  const changed = vi.fn()
  render(<ModelSelector runtimeKey="old-session" runtimeSelection={{ providerId: provider.id, modelId: 'removed' }} onRuntimeSelectionChange={changed} />)
  expect(await screen.findByRole('button', { name: /removed（已下架，请重选）/ })).toBeInTheDocument()
  expect(changed).not.toHaveBeenCalled()
})
