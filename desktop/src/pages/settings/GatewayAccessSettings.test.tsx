import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import '@testing-library/jest-dom'
import { GatewayAccessSettings } from './GatewayAccessSettings'
import { browserHost } from '@/lib/desktopHost/browserHost'
import { GATEWAY_ERROR_CODES, type GatewayConfig, type GatewayHost, type GatewayStatus, type GatewayTestResult } from '@/lib/desktopHost/gatewayTypes'
import { useSettingsStore } from '@/stores/settingsStore'
import { en } from '@/i18n/locales/en'
import { zh } from '@/i18n/locales/zh'
import { zh as zhTW } from '@/i18n/locales/zh-TW'
import { jp } from '@/i18n/locales/jp'
import { kr } from '@/i18n/locales/kr'

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

describe('GatewayAccessSettings', () => {
  let gateway: GatewayHost
  let config: GatewayConfig
  let status: GatewayStatus
  let listener: (next: GatewayStatus) => void
  let unsubscribe: ReturnType<typeof vi.fn>
  let original: typeof window.desktopHost

  beforeEach(() => {
    original = window.desktopHost
    useSettingsStore.getState().setLocale('en')
    config = { gatewayUrl: 'https://gateway.example', hasKey: true, credentialStorage: 'encrypted', autoStart: false }
    status = { generation: 0, state: 'stopped' }
    unsubscribe = vi.fn()
    gateway = {
      getConfig: vi.fn(async () => config),
      saveConfig: vi.fn(async input => {
        config = { ...config, gatewayUrl: input.gatewayUrl, autoStart: input.autoStart ?? config.autoStart, hasKey: !!input.accessKey || config.hasKey }
        return config
      }),
      clearKey: vi.fn(async () => { config = { ...config, hasKey: false, credentialStorage: 'none' }; return config }),
      getStatus: vi.fn(async () => status),
      onStatus: vi.fn(async handler => { listener = handler; return unsubscribe }),
      testConnection: vi.fn(async () => ({ localReady: true, gatewayConnected: true, keyAccepted: true, endToEndVerified: false })),
      start: vi.fn(async () => { status = { generation: status.generation + 1, state: 'online' }; listener(status); return status }),
      stop: vi.fn(async () => { status = { generation: status.generation + 1, state: 'stopped' }; listener(status); return status }),
    }
    window.desktopHost = { ...browserHost, isDesktop: true, gateway }
  })
  afterEach(() => { cleanup(); window.desktopHost = original })

  async function ready() {
    render(<GatewayAccessSettings />)
    await waitFor(() => expect(screen.getByRole('button', { name: 'Start connection' })).toBeEnabled())
    return userEvent.setup()
  }

  it('saves the typed key once, clears the password input, and preserves the key on later saves', async () => {
    const user = await ready()
    const key = screen.getByLabelText('Access key')
    expect(key).toHaveAttribute('type', 'password')
    await user.type(key, 'cgk_test.private-secret')
    await user.click(screen.getByRole('switch'))
    expect(screen.getByRole('button', { name: 'Start connection' })).toBeDisabled()
    await user.click(screen.getByRole('button', { name: 'Save gateway settings' }))
    await waitFor(() => expect(key).toHaveValue(''))
    expect(gateway.saveConfig).toHaveBeenLastCalledWith({ gatewayUrl: config.gatewayUrl, accessKey: 'cgk_test.private-secret', autoStart: true })
    await user.click(screen.getByRole('switch'))
    await user.click(screen.getByRole('button', { name: 'Save gateway settings' }))
    expect(gateway.saveConfig).toHaveBeenLastCalledWith({ gatewayUrl: config.gatewayUrl, autoStart: false })
    await user.click(screen.getByRole('button', { name: 'Clear saved key' }))
    await screen.findByText('No key configured.')
    expect(screen.getByRole('button', { name: 'Start connection' })).toBeDisabled()
  })

  it('locks duplicate operations during async save and clears the key only after success', async () => {
    const user = await ready()
    const save = deferred<GatewayConfig>()
    vi.mocked(gateway.saveConfig).mockReturnValueOnce(save.promise)
    await user.type(screen.getByLabelText('Access key'), 'secret')
    await user.click(screen.getByRole('button', { name: 'Save gateway settings' }))
    expect(screen.getByLabelText('Access key')).toHaveValue('secret')
    expect(screen.getByLabelText('Access key')).toBeDisabled()
    await user.click(screen.getByRole('button', { name: 'Save gateway settings' }))
    expect(gateway.saveConfig).toHaveBeenCalledTimes(1)
    await act(async () => save.resolve(config))
    expect(screen.getByLabelText('Access key')).toHaveValue('')
  })

  it('drives start and stop from host results and ignores old generation events', async () => {
    const user = await ready()
    await user.click(screen.getByRole('button', { name: 'Start connection' }))
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('Online'))
    for (const name of ['Save gateway settings', 'Clear saved key', 'Test connection', 'Start connection']) {
      expect(screen.getByRole('button', { name })).toBeDisabled()
    }
    expect(screen.getByLabelText('Gateway URL')).toBeDisabled()
    act(() => listener({ generation: 0, state: 'error', code: 'KEY_INVALID' }))
    expect(screen.getByRole('status')).toHaveTextContent('Online')
    await user.click(screen.getByRole('button', { name: 'Stop connection' }))
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('Stopped'))
    expect(gateway.stop).toHaveBeenCalledTimes(1)
    expect(screen.getByRole('button', { name: 'Test connection' })).toBeEnabled()
  })

  it('does not replace a newer event with a late same-generation action response', async () => {
    const user = await ready()
    const start = deferred<GatewayStatus>()
    vi.mocked(gateway.start).mockReturnValueOnce(start.promise)
    await user.click(screen.getByRole('button', { name: 'Start connection' }))
    act(() => listener({ generation: 1, state: 'online' }))
    await act(async () => start.resolve({ generation: 1, state: 'connecting' }))
    expect(screen.getByRole('status')).toHaveTextContent('Online')
  })

  it('distinguishes handshake from end-to-end proof and prevents duplicate tests', async () => {
    const user = await ready()
    const test = deferred<GatewayTestResult>()
    vi.mocked(gateway.testConnection).mockReturnValueOnce(test.promise)
    await user.click(screen.getByRole('button', { name: 'Test connection' }))
    for (const name of ['Save gateway settings', 'Clear saved key', 'Test connection', 'Start connection']) {
      expect(screen.getByRole('button', { name })).toBeDisabled()
    }
    await user.click(screen.getByRole('button', { name: 'Test connection' }))
    expect(gateway.testConnection).toHaveBeenCalledTimes(1)
    await act(async () => test.resolve({ localReady: true, gatewayConnected: true, keyAccepted: true, endToEndVerified: false }))
    const results = screen.getByLabelText('Connection test results')
    expect(within(results).getAllByText('Verified')).toHaveLength(3)
    expect(within(results).getByText('H5 end-to-end verified').parentElement).toHaveTextContent('Not verified')
    vi.mocked(gateway.testConnection).mockResolvedValueOnce({ localReady: true, gatewayConnected: true, keyAccepted: true, endToEndVerified: true })
    await user.click(screen.getByRole('button', { name: 'Test connection' }))
    await waitFor(() => expect(within(screen.getByLabelText('Connection test results')).getAllByText('Verified')).toHaveLength(4))
  })

  it('warns for HTTP and memory-only storage including restart consequences', async () => {
    config = { ...config, gatewayUrl: 'http://192.168.1.2:8080', credentialStorage: 'memory' }
    await ready()
    expect(screen.getByText(/HTTP is unencrypted/)).toBeInTheDocument()
    expect(screen.getByText(/After restarting the app, enter it again/)).toBeInTheDocument()
  })

  it.each(GATEWAY_ERROR_CODES)('maps %s without showing raw diagnostics', async code => {
    const user = await ready()
    vi.mocked(gateway.testConnection).mockRejectedValueOnce({ code, message: 'private-secret raw subprocess log' })
    await user.click(screen.getByRole('button', { name: 'Test connection' }))
    expect(await screen.findByRole('alert')).toHaveTextContent(en[`settings.gateway.error.${code}`])
    expect(screen.queryByText(/private-secret/)).not.toBeInTheDocument()
  })

  it('maps unknown failures to a fixed generic error and preserves unsaved key', async () => {
    const user = await ready()
    await user.type(screen.getByLabelText('Access key'), 'unsaved-secret')
    vi.mocked(gateway.saveConfig).mockRejectedValueOnce(new Error('raw-secret'))
    await user.click(screen.getByRole('button', { name: 'Save gateway settings' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Could not connect to the gateway.')
    expect(screen.getByLabelText('Access key')).toHaveValue('unsaved-secret')
  })

  it('does not expose native controls or call host methods in a browser', () => {
    window.desktopHost = { ...browserHost, gateway }
    const { container } = render(<GatewayAccessSettings />)
    expect(container).toBeEmptyDOMElement()
    expect(gateway.getConfig).not.toHaveBeenCalled()
    expect(gateway.onStatus).not.toHaveBeenCalled()
  })

  it('unsubscribes even when subscription resolves after unmount and ignores late callbacks', async () => {
    const subscription = deferred<() => void>()
    vi.mocked(gateway.onStatus).mockImplementation(handler => { listener = handler; return subscription.promise })
    const view = render(<GatewayAccessSettings />)
    await screen.findByDisplayValue(config.gatewayUrl)
    view.unmount()
    await act(async () => subscription.resolve(unsubscribe))
    expect(unsubscribe).toHaveBeenCalledTimes(1)
    act(() => listener({ generation: 99, state: 'error', code: 'KEY_INVALID' }))
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it('keeps a subscription event ahead of a late loading snapshot and unsubscribes normally', async () => {
    const snapshot = deferred<GatewayStatus>()
    vi.mocked(gateway.getStatus).mockReturnValueOnce(snapshot.promise)
    const view = render(<GatewayAccessSettings />)
    act(() => listener({ generation: 1, state: 'online' }))
    await act(async () => snapshot.resolve({ generation: 0, state: 'stopped' }))
    expect(screen.getByRole('status')).toHaveTextContent('Online')
    expect(screen.getByRole('button', { name: 'Test connection' })).toBeDisabled()
    view.unmount()
    expect(unsubscribe).toHaveBeenCalledTimes(1)
  })

  it('keeps all gateway translation keys present in all five locales', () => {
    const keys = Object.keys(en).filter(key => key.startsWith('settings.gateway.'))
    for (const locale of [en, zh, zhTW, jp, kr]) {
      expect(Object.keys(locale).filter(key => key.startsWith('settings.gateway.')).sort()).toEqual([...keys].sort())
      for (const key of keys) expect(locale[key as keyof typeof en].length).toBeGreaterThan(0)
    }
  })
})
