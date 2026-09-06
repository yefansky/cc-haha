import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import '@testing-library/jest-dom'
import { ProviderBusinessSections } from './ProviderBusinessSections'
import { providerBusinesses } from '@/providerBusinesses/registry'
import { useKsccOAuthStore } from '@/providerBusinesses/kscc/store'
import { useKsccOAuthStore as legacyStore } from '@/stores/ksccOAuthStore'
import { ksccOAuthApi } from '@/providerBusinesses/kscc/api'
import { ksccOAuthApi as legacyApi } from '@/api/ksccOAuth'
import { KsccLogin } from '@/providerBusinesses/kscc/KsccLogin'
import { KsccLogin as LegacyLogin } from './KsccLogin'
import { useProviderStore } from '@/stores/providerStore'
import { useSettingsStore } from '@/stores/settingsStore'
import { browserHost } from '@/lib/desktopHost/browserHost'

const loginState = useKsccOAuthStore.getState()
const providerState = useProviderStore.getState()
const settingsState = useSettingsStore.getState()
const provider = { id: 'kscc-test', presetId: 'kscc', name: 'KSCC', apiKey: 'fake', baseUrl: 'http://kscc.test', models: { main: 'test-model', haiku: 'test-model', sonnet: 'test-model', opus: 'test-model' } }
const flush = async () => { for (let i = 0; i < 12; i += 1) await Promise.resolve() }

describe('registered provider business UI', () => {
  let authenticated: boolean
  let active: boolean
  let requests: string[]
  let open: ReturnType<typeof vi.fn>
  let writeText: ReturnType<typeof vi.fn>

  beforeEach(() => {
    vi.useFakeTimers()
    authenticated = false
    active = false
    requests = []
    open = vi.fn().mockResolvedValue(undefined)
    writeText = vi.fn().mockResolvedValue(undefined)
    useSettingsStore.setState({ locale: 'zh' })
    useKsccOAuthStore.setState({ ...loginState, status: null, isLoading: false, error: null })
    useProviderStore.setState({ ...providerState, providers: [], activeId: null })
    window.desktopHost = { ...browserHost, kind: 'electron', isDesktop: true, capabilities: { ...browserHost.capabilities, shell: true, clipboard: true }, shell: { ...browserHost.shell, open }, clipboard: { ...browserHost.clipboard, writeText } }
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      const pathname = new URL(url).pathname
      requests.push(`${init?.method || 'GET'} ${pathname}`)
      if (pathname === '/api/kscc-oauth/start') return Response.json({ authorizeUrl: 'http://kscc.test/l/test-login', reusedLocalLogin: false })
      if (pathname === '/api/provider-integrations/seasun/status') return Response.json({ phase: 'idle', identityConnected: false, modelAccess: 'unknown' })
      if (pathname === '/api/kscc-oauth') return Response.json({ loggedIn: authenticated, pending: !authenticated, active })
      if (pathname === '/api/providers') return Response.json({ providers: authenticated ? [provider] : [], activeId: active ? provider.id : null })
      if (pathname === `/api/providers/${provider.id}/activate`) { active = true; return Response.json({ ok: true }) }
      if (pathname === '/api/providers/other-test/activate') { active = false; return Response.json({ ok: true }) }
      if (pathname === '/api/models/current') return Response.json({ model: { id: provider.models.main, name: provider.models.main } })
      if (pathname === '/api/models') return Response.json({ models: [], provider: { id: provider.id, name: provider.name } })
      if (pathname === '/api/effort') return Response.json({ level: 'medium', available: ['medium'] })
      if (pathname === '/api/permissions/mode') return Response.json({ mode: 'default' })
      if (pathname === '/api/settings/user') return Response.json({})
      if (pathname === '/api/h5-access') return Response.json({ enabled: false })
      if (pathname === '/api/traces/settings') return Response.json({ enabled: false, fullBodies: false })
      throw new Error(`Unexpected test request: ${pathname}`)
    }))
  })

  afterEach(() => {
    cleanup()
    useKsccOAuthStore.getState().stopPolling()
    useKsccOAuthStore.setState(loginState)
    useProviderStore.setState(providerState)
    useSettingsStore.setState(settingsState)
    vi.useRealTimers()
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('retains one KSCC implementation behind legacy imports', () => {
    expect(new Set(providerBusinesses.map(item => item.id)).size).toBe(providerBusinesses.length)
    expect(new Set(providerBusinesses.map(item => item.presetId)).size).toBe(providerBusinesses.length)
    expect(legacyStore).toBe(useKsccOAuthStore)
    expect(legacyApi).toBe(ksccOAuthApi)
    expect(LegacyLogin).toBe(KsccLogin)
  })

  it('drives registered KSCC login through the real API/store and stops after success', async () => {
    render(<ProviderBusinessSections />)
    await act(flush)
    expect(screen.getByRole('region', { name: 'KSCC' })).toBeInTheDocument()
    expect(screen.getByText('Claude Code 兼容服务')).toBeInTheDocument()
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '登录并启用 KSCC' })); await flush() })
    expect(open).toHaveBeenCalledWith('http://kscc.test/l/test-login')
    expect(requests).toContain('POST /api/kscc-oauth/start')
    authenticated = true
    active = true
    await act(async () => { await vi.advanceTimersByTimeAsync(2000); await flush() })
    expect(useProviderStore.getState().providers.map(item => item.id)).toContain(provider.id)
    expect(useKsccOAuthStore.getState().status?.active).toBe(true)
    const count = requests.length
    await act(async () => { await vi.advanceTimersByTimeAsync(6000); await flush() })
    expect(requests).toHaveLength(count)
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '重新登录' })); await flush() })
    expect(requests.filter(item => item === 'POST /api/kscc-oauth/start')).toHaveLength(2)
  })

  it('retains copy-link fallback and stops its business polling on unmount', async () => {
    open.mockRejectedValue(new Error('No desktop shell'))
    const view = render(<ProviderBusinessSections />)
    await act(flush)
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '登录并启用 KSCC' })); await flush() })
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '复制登录链接' })); await flush() })
    expect(writeText).toHaveBeenCalledWith('http://kscc.test/l/test-login')
    await act(async () => { await vi.advanceTimersByTimeAsync(2000); await flush() })
    expect(requests.filter(item => item === 'GET /api/kscc-oauth')).toHaveLength(2)
    view.unmount()
    const count = requests.length
    await act(async () => { await vi.advanceTimersByTimeAsync(4000); await flush() })
    expect(requests).toHaveLength(count)
  })

  it('activates an authorized business provider through the existing provider action', async () => {
    authenticated = true
    render(<ProviderBusinessSections />)
    await act(flush)
    expect(screen.getByText('KSCC 已登录，可在下方服务商列表切换')).toBeInTheDocument()
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '切换为 KSCC' })); await flush() })
    await act(flush)
    expect(requests).toContain(`POST /api/providers/${provider.id}/activate`)
    expect(useProviderStore.getState().activeId).toBe(provider.id)
    expect(useSettingsStore.getState().error).toBeNull()
    expect(useKsccOAuthStore.getState().status?.active).toBe(true)
    expect(screen.queryByRole('button', { name: '切换为 KSCC' })).not.toBeInTheDocument()
  })

  it('renders a different compiled descriptor without selecting KSCC behavior', async () => {
    render(<ProviderBusinessSections businesses={[{ id: 'test-business', presetId: 'custom', titleKey: 'settings.providers.title', descriptionKey: 'settings.providers.description', LoginPanel: () => <div data-testid="test-business-panel" /> }]} />)
    await act(flush)
    expect(screen.getByTestId('test-business-panel')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '登录并启用 KSCC' })).not.toBeInTheDocument()
    expect(requests).toEqual([])
  })

  it('tracks public provider activation even while the login status remains stale', async () => {
    authenticated = true
    active = true
    render(<ProviderBusinessSections />)
    await act(flush)
    expect(screen.getByText('KSCC 已登录，当前正在使用')).toBeInTheDocument()
    await act(async () => { await useProviderStore.getState().activateProvider('other-test'); await flush() })
    expect(useKsccOAuthStore.getState().status?.active).toBe(true)
    expect(screen.getByText('KSCC 已登录，可在下方服务商列表切换')).toBeInTheDocument()
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '切换为 KSCC' })); await flush() })
    expect(useProviderStore.getState().activeId).toBe(provider.id)
    expect(screen.getByText('KSCC 已登录，当前正在使用')).toBeInTheDocument()
  })
})
