import { describe, expect, it, vi } from 'vitest'
import { createElectronHost } from './electronHost'
import { browserHost } from './browserHost'
import { GATEWAY_ERROR_CODES } from './gatewayTypes'
import { ELECTRON_IPC_CHANNELS as IPC, ELECTRON_EVENT_CHANNELS as EVENTS } from '../../../electron/ipc/channels'
import { isElectronIpcChannelAllowedForPetWindow, validateElectronIpcPayload } from '../../../electron/ipc/capabilities'

describe('gateway desktop boundary', () => {
  it.each(GATEWAY_ERROR_CODES)('normalizes Electron serialized rejection %s without a code property', async code => {
    const serialized = new Error(`Error invoking remote method '${IPC.gatewayStart}': Error: ${code}`)
    expect(serialized).not.toHaveProperty('code')
    const host = createElectronHost({ invoke: vi.fn().mockRejectedValue(serialized), subscribe: vi.fn() })
    await expect(host.gateway.start()).rejects.toMatchObject({ message: code, code })
  })
  it.each([
    `Error invoking remote method '${IPC.gatewayStart}': Error: UNKNOWN_CODE`,
    `Error invoking remote method '${IPC.gatewayStart}': Error: secret KEY_INVALID`,
    `Error invoking remote method '${IPC.gatewayStart}': Error: KEY_INVALID secret`,
    `Error invoking remote method '${IPC.gatewayStart}': Error: KEY_INVALID\n`,
    `Error invoking remote method '${IPC.gatewayStart}': Error: secret\nError: KEY_INVALID`,
    `secret Error invoking remote method '${IPC.gatewayStart}': Error: KEY_INVALID`,
    `Error invoking remote method '${IPC.gatewayStop}': Error: KEY_INVALID`,
    'secret Error: KEY_INVALID',
    'KEY_INVALID',
  ])('does not extract codes from unrelated or secret-bearing messages: %s', async message => {
    const original = new Error(message)
    const host = createElectronHost({ invoke: vi.fn().mockRejectedValue(original), subscribe: vi.fn() })
    const result = await host.gateway.start().catch(error => error)
    expect(result).not.toBe(original)
    expect(result).toMatchObject({ message: 'CONNECTION_FAILED', code: 'CONNECTION_FAILED' })
    expect(result).not.toHaveProperty('cause')
    expect(result.stack).not.toContain(message)
  })
  it('does not relay raw rejected IPC errors', async () => {
    const invoke = vi.fn().mockRejectedValue(new Error('private-value'))
    const host = createElectronHost({ invoke, subscribe: vi.fn() })
    await expect(host.gateway.start()).rejects.toMatchObject({ message: 'CONNECTION_FAILED', code: 'CONNECTION_FAILED' })
    invoke.mockRejectedValue(Object.assign(new Error('private-value'), { code: 'KEY_INVALID' }))
    await expect(host.gateway.start()).rejects.toMatchObject({ message: 'KEY_INVALID', code: 'KEY_INVALID' })
  })
  it('projects results and events onto the public allowlist without raw secrets', async () => {
    const invoke = vi.fn().mockResolvedValue({ gatewayUrl: 'https://host', hasKey: true, credentialStorage: 'encrypted', autoStart: false, generation: 2, state: 'online', code: 'raw-secret', accessKey: 'private-value', localReady: true, gatewayConnected: true, keyAccepted: true, endToEndVerified: false })
    const subscribe = vi.fn().mockResolvedValue(() => {})
    const host = createElectronHost({ invoke, subscribe })
    expect(await host.gateway.getConfig()).toEqual({ gatewayUrl: 'https://host', hasKey: true, credentialStorage: 'encrypted', autoStart: false })
    expect(await host.gateway.getStatus()).toEqual({ generation: 2, state: 'online', code: 'CONNECTION_FAILED' })
    expect(await host.gateway.testConnection()).toEqual({ localReady: true, gatewayConnected: true, keyAccepted: true, endToEndVerified: false, code: 'CONNECTION_FAILED' })
    const handler = vi.fn()
    await host.gateway.onStatus(handler)
    subscribe.mock.calls[0]![1]({ generation: 3, state: 'error', code: 'KEY_INVALID', accessKey: 'private-value' })
    expect(handler).toHaveBeenCalledWith({ generation: 3, state: 'error', code: 'KEY_INVALID' })
  })
  it('routes config, lifecycle and status subscription through the bridge', async () => {
    const invoke = vi.fn().mockResolvedValue({})
    const unlisten = vi.fn()
    const subscribe = vi.fn().mockResolvedValue(unlisten)
    const host = createElectronHost({ invoke, subscribe })
    const input = { gatewayUrl: 'https://gateway.example', accessKey: 'test-key' }
    await host.gateway.getConfig()
    await host.gateway.saveConfig(input)
    await host.gateway.clearKey()
    await host.gateway.testConnection()
    await host.gateway.start()
    await host.gateway.stop()
    await host.gateway.getStatus()
    expect(invoke.mock.calls).toEqual([
      [IPC.gatewayGetConfig, undefined], [IPC.gatewaySaveConfig, input],
      [IPC.gatewayClearKey, undefined], [IPC.gatewayTestConnection, undefined],
      [IPC.gatewayStart, undefined], [IPC.gatewayStop, undefined], [IPC.gatewayGetStatus, undefined],
    ])
    const handler = vi.fn()
    const cancel = await host.gateway.onStatus(handler)
    expect(subscribe).toHaveBeenCalledWith(EVENTS.gatewayStatus, expect.any(Function))
    cancel()
    expect(unlisten).toHaveBeenCalledOnce()
  })

  it.each(['getConfig', 'clearKey', 'testConnection', 'start', 'stop', 'getStatus'] as const)('browser rejects %s', async method => {
    await expect(browserHost.gateway[method]()).rejects.toThrow('desktop app runtime')
  })
  it('browser rejects saves and subscriptions', async () => {
    await expect(browserHost.gateway.saveConfig({ gatewayUrl: 'http://localhost' })).rejects.toThrow()
    await expect(browserHost.gateway.onStatus(() => {})).rejects.toThrow()
  })

  it.each(['https://host/path', 'https://user:pass@host', 'https://host?', 'https://host#', 'https://host/', 'https://host:99999', 'file:///tmp', 'https://host\n', 'https://host\\path', 'https://host/../'])('rejects non-origin %s', gatewayUrl => {
    expect(validateElectronIpcPayload(IPC.gatewaySaveConfig, { gatewayUrl })).toBe(false)
  })
  it('allowlists save fields, key size and control characters', () => {
    for (const input of [
      { accessKey: '' }, { accessKey: 'x'.repeat(1025) }, { accessKey: 'secret\n' },
      { accessKey: 'secret\u0085' }, { autoStart: 1 }, { unknown: 'secret' },
    ]) expect(validateElectronIpcPayload(IPC.gatewaySaveConfig, { gatewayUrl: 'https://host', ...input })).toBe(false)
    for (const gatewayUrl of ['http://127.0.0.1:8000', 'https://host', 'http://[::1]:8000']) {
      expect(validateElectronIpcPayload(IPC.gatewaySaveConfig, { gatewayUrl, accessKey: 'x'.repeat(1024), autoStart: false })).toBe(true)
    }
  })
  it('rejects invalid saves before IPC without echoing secrets', async () => {
    const invoke = vi.fn()
    const host = createElectronHost({ invoke, subscribe: vi.fn() })
    await expect(host.gateway.saveConfig({ gatewayUrl: 'https://secret@host', accessKey: 'private-value' })).rejects.toThrow('Invalid Electron IPC payload')
    expect(invoke).not.toHaveBeenCalled()
  })
  it('denies all gateway invoke channels to pet windows and rejects extraneous payloads', () => {
    for (const [name, channel] of Object.entries(IPC).filter(([name]) => name.startsWith('gateway'))) {
      expect(isElectronIpcChannelAllowedForPetWindow(channel)).toBe(false)
      if (name !== 'gatewaySaveConfig') {
        expect(validateElectronIpcPayload(channel, undefined)).toBe(true)
        expect(validateElectronIpcPayload(channel, { accessKey: 'secret' })).toBe(false)
      }
    }
  })
})
