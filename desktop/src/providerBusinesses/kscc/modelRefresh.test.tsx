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

it('opens on the cached catalog, refreshes in the background, and reveals the synced model on the next open', async () => {
  const nextCatalog = ['kept', 'deepseekv-4.1-flash'].map(id => ({ id, capabilities: [] }))
  let finishPickerRefresh!: () => void
  const refresh = vi.spyOn(providersApi, 'refreshModelCatalog')
    .mockImplementationOnce(async () => ({ provider: saved })) // 启动自动刷新：目录未变
    .mockImplementationOnce(() => new Promise(resolve => { // 打开列表触发的后台刷新
      finishPickerRefresh = () => {
        saved = { ...saved, modelCatalog: nextCatalog }
        resolve({ provider: saved })
      }
    }))
  const onSelection = vi.fn()
  await useProviderStore.getState().fetchProviders()
  await act(async () => {}) // 启动自动刷新落地，之后打开列表才会发起新的后台刷新
  expect(useProviderStore.getState().modelRefreshStatus[provider.id]?.pending).toBe(false)
  expect(useProviderStore.getState().modelRefreshProviderIds).toEqual([provider.id])
  expect(useProviderStore.getState().providers[0]?.modelCatalog?.map(model => model.id)).toContain('removed')
  expect(useProviderStore.getState().isLoading).toBe(false)
  expect(refresh).toHaveBeenCalledTimes(1)

  render(<ModelSelector runtimeKey="busy-session" runtimeSelection={{ providerId: provider.id, modelId: 'kept' }} onRuntimeSelectionChange={onSelection} />)
  const trigger = screen.getByRole('button', { name: 'kept, KSCC' })
  await act(async () => { fireEvent.click(trigger) })
  // 打开瞬间显示本地缓存，刷新仍在后台，不阻塞列表。
  expect(screen.getByRole('button', { name: 'removed' })).toBeInTheDocument()
  expect(screen.queryByRole('button', { name: 'deepseekv-4.1-flash' })).not.toBeInTheDocument()
  expect(refresh).toHaveBeenCalledTimes(2)

  await act(async () => { fireEvent.click(trigger) }) // 关闭
  await act(async () => { finishPickerRefresh() }) // 后台刷新完成并写入缓存
  await act(async () => { fireEvent.click(trigger) }) // 再次打开：节流窗口内不重复请求
  expect(await screen.findByRole('button', { name: 'deepseekv-4.1-flash' })).toBeInTheDocument()
  expect(screen.queryByRole('button', { name: 'removed' })).not.toBeInTheDocument()
  expect(refresh).toHaveBeenCalledTimes(2)
  expect(onSelection).not.toHaveBeenCalled()
  expect(useProviderStore.getState().activeId).toBeNull()
  await act(async () => { await useProviderStore.getState().fetchProviders() })
  expect(refresh).toHaveBeenCalledTimes(2)
})

it('refreshes again on a later open once the picker throttle window has passed', async () => {
  let now = 1_000_000
  vi.spyOn(Date, 'now').mockImplementation(() => now)
  const refresh = vi.spyOn(providersApi, 'refreshModelCatalog').mockImplementation(async () => ({ provider: saved }))
  await useProviderStore.getState().fetchProviders()
  await act(async () => {}) // 启动自动刷新落地
  render(<ModelSelector runtimeKey="later-open-session" runtimeSelection={{ providerId: provider.id, modelId: 'kept' }} />)
  const trigger = screen.getByRole('button', { name: 'kept, KSCC' })

  await act(async () => { fireEvent.click(trigger) }) // 打开 → 后台刷新
  await act(async () => { fireEvent.click(trigger) }) // 关闭
  await act(async () => { fireEvent.click(trigger) }) // 立刻重开：仍在节流窗口内
  expect(refresh).toHaveBeenCalledTimes(2)

  now += 61_000
  await act(async () => { fireEvent.click(trigger) }) // 关闭
  await act(async () => { fireEvent.click(trigger) }) // 窗口过后再打开 → 重新刷新
  expect(refresh).toHaveBeenCalledTimes(3)
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

it('refreshes two providers together without reporting the superseded list request as a failure', async () => {
  const second = { ...structuredClone(provider), id: 'seasun-test', presetId: 'seasun' }
  vi.mocked(providersApi.list).mockResolvedValue({ providers: [saved, second], activeId: provider.id, modelRefreshProviderIds: [provider.id, second.id] })
  vi.spyOn(providersApi, 'refreshModelCatalog').mockImplementation(async id => ({ provider: id === second.id ? second : saved }))
  await useProviderStore.getState().fetchProviders()
  await Promise.all([provider.id, second.id].map(id => useProviderStore.getState().refreshModelCatalog(id)))
  for (const id of [provider.id, second.id]) {
    expect(useProviderStore.getState().modelRefreshStatus[id]).toMatchObject({ pending: false, updatedAt: expect.any(Number) })
    expect(useProviderStore.getState().modelRefreshStatus[id]?.failed).not.toBe(true)
  }
  expect(useProviderStore.getState().activeId).toBe(provider.id)
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

it('both simultaneous refreshes report failure when their newest shared reload fails', async () => {
  const second = { ...structuredClone(provider), id: 'seasun-test', presetId: 'seasun' }
  vi.mocked(providersApi.list).mockResolvedValueOnce({ providers: [saved, second], activeId: null, modelRefreshProviderIds: [provider.id, second.id] })
    .mockRejectedValue(new Error('list offline'))
  vi.spyOn(providersApi, 'refreshModelCatalog').mockImplementation(async id => ({ provider: id === second.id ? second : saved }))
  await useProviderStore.getState().fetchProviders()
  await Promise.all([provider.id, second.id].map(id => useProviderStore.getState().refreshModelCatalog(id)))
  for (const id of [provider.id, second.id]) expect(useProviderStore.getState().modelRefreshStatus[id]).toMatchObject({ pending: false, failed: true })
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
