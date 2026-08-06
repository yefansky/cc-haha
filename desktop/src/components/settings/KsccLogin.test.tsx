import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import '@testing-library/jest-dom'

const { openMock, startMock, statusMock } = vi.hoisted(() => ({
  openMock: vi.fn(),
  startMock: vi.fn(),
  statusMock: vi.fn(),
}))

vi.mock('../../api/ksccOAuth', () => ({
  ksccOAuthApi: { start: startMock, status: statusMock },
}))

import { KsccLogin } from './KsccLogin'
import { useKsccOAuthStore } from '../../stores/ksccOAuthStore'
import { useProviderStore } from '../../stores/providerStore'
import { browserHost } from '../../lib/desktopHost/browserHost'
import { useSettingsStore } from '../../stores/settingsStore'
import type { SavedProvider } from '../../types/provider'

const initialState = useKsccOAuthStore.getState()
const initialProviderState = useProviderStore.getState()
let resolveStatus: ((value: { loggedIn: boolean; pending: boolean; active: boolean }) => void) | null = null

const ksccProvider: SavedProvider = {
  id: 'kscc-provider',
  presetId: 'kscc',
  name: 'KSCC',
  apiKey: '***',
  baseUrl: 'http://kscc.test',
  apiFormat: 'anthropic',
  models: { main: 'glm-5', haiku: 'glm-5', sonnet: 'glm-5', opus: 'glm-5' },
}

describe('KsccLogin', () => {
  beforeEach(() => {
    startMock.mockReset()
    statusMock.mockImplementation(() => new Promise<{ loggedIn: boolean; pending: boolean; active: boolean }>((resolve) => {
      resolveStatus = resolve
    }))
    openMock.mockReset()
    useSettingsStore.setState({ locale: 'zh' })
    window.desktopHost = {
      ...browserHost,
      kind: 'electron',
      isDesktop: true,
      capabilities: { ...browserHost.capabilities, shell: true },
      shell: { ...browserHost.shell, open: openMock },
    }
    useKsccOAuthStore.setState({ ...initialState, status: null, error: null, isLoading: false })
    useProviderStore.setState({ ...initialProviderState, providers: [], activeId: null, isLoading: false })
  })

  afterEach(() => {
    act(() => useKsccOAuthStore.getState().stopPolling())
    useKsccOAuthStore.setState(initialState)
    useProviderStore.setState(initialProviderState)
    cleanup()
    vi.restoreAllMocks()
  })

  it('opens the KSCC sign-in page and begins polling', async () => {
    const url = 'http://kscc.test/l/login-id'
    startMock.mockResolvedValue({ authorizeUrl: url, reusedLocalLogin: false })
    render(<KsccLogin />)
    await screen.findByRole('button', { name: '\u767B\u5F55\u5E76\u542F\u7528 KSCC' })
    await waitFor(() => expect(statusMock).toHaveBeenCalled())
    await act(async () => {
      resolveStatus?.({ loggedIn: false, pending: false, active: false })
      await Promise.resolve()
    })

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: '\u767B\u5F55\u5E76\u542F\u7528 KSCC' }))
      await new Promise((resolve) => setTimeout(resolve, 0))
    })

    expect(openMock).toHaveBeenCalledWith(url)
    expect(useKsccOAuthStore.getState().isLoading).toBe(false)
  })

  it('shows the logged-in state and a switch button when KSCC is not active', async () => {
    statusMock.mockResolvedValue({ loggedIn: true, pending: false, active: false })
    const activateProvider = vi.fn().mockResolvedValue(undefined)
    useProviderStore.setState({ providers: [ksccProvider], activeId: null, isLoading: false, activateProvider })

    render(<KsccLogin />)

    expect(await screen.findByText('KSCC 已登录，可在下方服务商列表切换')).toBeInTheDocument()
    const switchButton = screen.getByRole('button', { name: '切换为 KSCC' })
    await waitFor(() => expect(switchButton).toBeEnabled())
    fireEvent.click(switchButton)
    await waitFor(() => expect(activateProvider).toHaveBeenCalledWith(ksccProvider.id))
    await waitFor(() => expect(statusMock).toHaveBeenCalledTimes(2))
  })

  it('shows the active logged-in state without offering a provider switch', async () => {
    statusMock.mockResolvedValue({ loggedIn: true, pending: false, active: true })
    useProviderStore.setState({ providers: [ksccProvider], activeId: ksccProvider.id, isLoading: false })
    const { container } = render(<KsccLogin />)

    await waitFor(() => expect(useKsccOAuthStore.getState().status?.active).toBe(true))
    await waitFor(() => expect(container.textContent).toContain('KSCC'))
    expect(container.querySelectorAll('button')).toHaveLength(1)
  })
})
