import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import '@testing-library/jest-dom'
import { ProviderBusinessSections } from '@/components/settings/ProviderBusinessSections'
import { useProviderStore } from '@/stores/providerStore'
import { useSettingsStore } from '@/stores/settingsStore'
import { browserHost } from '@/lib/desktopHost/browserHost'
import { useSeasunStore } from './store'
import { parseSeasunStatus } from './types'

const initialProviders = useProviderStore.getState()
const initialSeasun = useSeasunStore.getState()
const initialSettings = useSettingsStore.getState()
const models = ['gpt-5.6-luna', 'grok-4.6', 'claude-sonnet-4-6', 'deepseek-v4-flash']
const provider = { id: 'seasun-test', presetId: 'seasun', name: 'Seasun', baseUrl: 'https://aihub.seasungame.com/airoute', apiKey: '***', apiFormat: 'anthropic', models: { main: models[0], haiku: models[0], sonnet: models[0], opus: models[0] }, modelCatalog: models.map(id => ({ id, capabilities: [] })) }
const flush = async () => { for (let i = 0; i < 16; i++) await Promise.resolve() }

describe('registered Seasun business UI', () => {
  let connected: boolean
  let access: 'ready' | 'unassigned' | 'unknown'
  let activeId: string
  let requestPaths: string[]
  const status = () => parseSeasunStatus({ phase: connected ? 'connected' : 'idle', identityConnected: connected, loggedIn: connected, modelAccess: access, providerId: connected ? provider.id : undefined, active: activeId === provider.id })
  beforeEach(() => {
    connected = false; access = 'unknown'; activeId = 'other-test'; requestPaths = []
    useSeasunStore.setState(initialSeasun)
    useProviderStore.setState({ ...initialProviders, providers: [], activeId: null })
    useSettingsStore.setState({ locale: 'zh' })
    window.desktopHost = { ...browserHost, providerBusinesses: { seasun: {
      login: vi.fn(async () => { connected = true; return status() }),
      cancel: vi.fn(async () => status()),
    } } }
    vi.stubGlobal('fetch', vi.fn(async (raw: string, init?: RequestInit) => {
      const url = new URL(raw); requestPaths.push(`${init?.method || 'GET'} ${url.pathname}`)
      if (url.pathname === '/api/provider-integrations/seasun/status') return Response.json(status())
      if (url.pathname === '/api/kscc-oauth') return Response.json({ loggedIn: false, pending: false, active: false })
      if (url.pathname === '/api/providers') return Response.json({ providers: connected ? [provider] : [], activeId })
      if (url.pathname === `/api/providers/${provider.id}/activate`) { activeId = provider.id; return Response.json({ ok: true }) }
      if (url.pathname === '/api/providers/other-test/activate') { activeId = 'other-test'; return Response.json({ ok: true }) }
      if (url.pathname === '/api/models/current') return Response.json({ model: { id: models[0], name: models[0] } })
      if (url.pathname === '/api/models') return Response.json({ models: [], provider: { id: activeId, name: 'test' } })
      if (url.pathname === '/api/effort') return Response.json({ level: 'medium', available: ['medium'] })
      if (url.pathname === '/api/permissions/mode') return Response.json({ mode: 'default' })
      if (url.pathname === '/api/settings/user') return Response.json({})
      if (url.pathname === '/api/h5-access') return Response.json({ enabled: false })
      if (url.pathname === '/api/traces/settings') return Response.json({ enabled: false, fullBodies: false })
      throw new Error('Unexpected mocked route')
    }))
  })
  afterEach(() => {
    cleanup(); useSeasunStore.setState(initialSeasun); useProviderStore.setState(initialProviders); useSettingsStore.setState(initialSettings)
    window.desktopHost = undefined; vi.unstubAllGlobals(); vi.restoreAllMocks()
  })

  it('saves sign-in without activating, preserves all model families, and activates only explicitly', async () => {
    render(<ProviderBusinessSections />); await act(flush)
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '登录 Seasun' })); await flush() })
    expect(screen.getByText('身份已连接')).toBeInTheDocument()
    expect(screen.getByText('模型权限尚未确认。')).toBeInTheDocument()
    expect(useProviderStore.getState().activeId).toBe('other-test')
    expect(requestPaths.some(path => path.endsWith('/activate'))).toBe(false)
    for (const model of models) expect(screen.getByText(model)).toBeInTheDocument()
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '设为默认' })); await flush() })
    expect(useProviderStore.getState().activeId).toBe(provider.id)
    expect(screen.getByText('当前正在使用')).toBeInTheDocument()
    await act(async () => { await useProviderStore.getState().activateProvider('other-test'); await flush() })
    expect(screen.queryByText('当前正在使用')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: '设为默认' })).toBeEnabled()
    expect(requestPaths.some(path => path.includes('/seasun/start') || path.includes('/seasun/complete'))).toBe(false)
  })

  it('keeps an identity connection when permissions are unassigned and does not claim model readiness', async () => {
    access = 'unassigned'; render(<ProviderBusinessSections />); await act(flush)
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '登录 Seasun' })); await flush() })
    expect(screen.getByText('身份已连接')).toBeInTheDocument()
    expect(screen.getByText('模型权限尚未分配，已保留账号连接。')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '设为默认' })).toBeDisabled()
    expect(useProviderStore.getState().providers).toHaveLength(1)
  })

  it('explains the desktop login requirement in H5 while retaining existing provider use', async () => {
    connected = true; window.desktopHost = browserHost
    render(<ProviderBusinessSections />); await act(flush)
    expect(screen.getByText(/请在 cc-haha 桌面端完成登录/)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '重新连接' })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: '设为默认' })).toBeEnabled()
  })

  it('keeps unconfirmed cancellation distinct from verified server state without rendering secrets', async () => {
    let finishLogin!: (value: ReturnType<typeof status>) => void
    window.desktopHost!.providerBusinesses!.seasun.login = vi.fn(() => new Promise<ReturnType<typeof status>>(resolve => { finishLogin = resolve }))
    window.desktopHost!.providerBusinesses!.seasun.cancel = vi.fn(async () => parseSeasunStatus({ phase: 'error', errorCode: 'cancel_unconfirmed', token: 'must-not-render' }))
    render(<ProviderBusinessSections />); await act(flush)
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '登录 Seasun' })); await flush() })
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '取消登录' })); await flush() })
    expect(screen.getByRole('alert')).toHaveTextContent('服务端取消尚未确认')
    await act(async () => { finishLogin(status()); await flush() })
    expect(screen.getByRole('alert')).toHaveTextContent('服务端取消尚未确认')
    expect(screen.queryByText('must-not-render')).not.toBeInTheDocument()
  })
})
