import { EventEmitter } from 'node:events'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { startLiveDebugHost } from './liveDebugHost'
import { installRendererLifecycle } from './rendererLifecycle'
import { LIVE_DEBUG_CHANNEL } from '../../src/lib/liveDebugObservation'

describe('independent Electron observation host', () => {
  it('authenticates, holds real recovery transitions and profiles without reload or arbitrary commands', async () => {
    const root = await mkdtemp(join(tmpdir(), 'cc-live-debug-'))
    let attached = false
    const debuggerApi = Object.assign(new EventEmitter(), {
      isAttached: () => attached,
      attach: vi.fn(() => { attached = true }),
      detach: vi.fn(() => { attached = false }),
      sendCommand: vi.fn(async (method: string) => method === 'Profiler.stop'
        ? { profile: { nodes: [], samples: [] } } : {}),
    })
    const contents = Object.assign(new EventEmitter(), {
      debugger: debuggerApi, isDestroyed: () => false, reload: vi.fn(), send: vi.fn(),
    })
    const window = Object.assign(new EventEmitter(), { webContents: contents, isDestroyed: () => false })
    const lifecycle = installRendererLifecycle({ window: window as never,
      isQuitting: () => false, recordDiagnostic: value => value, writeSnapshot: () => {},
      onRecoveryExhausted: () => {}, unresponsiveRecoveryDelayMs: 10 })
    const ipc = new EventEmitter()
    const host = await startLiveDebugHost({ window: window as never, lifecycle, userData: root, ipc: ipc as never })
    try {
      const discovery = JSON.parse(await readFile(join(root, 'debug-host.json'), 'utf8'))
      const headers = { Authorization: `Bearer ${discovery.token}` }
      expect((await fetch(`${host.url}/status`)).status).toBe(403)
      const deniedHeaders: Record<string, string>[] = [{ Origin: 'http://localhost' }, { 'X-Forwarded-For': '127.0.0.1' }]
      for (const extra of deniedHeaders) {
        expect((await fetch(`${host.url}/status`, { headers: { ...headers, ...extra } })).status).toBe(403)
      }
      expect((await fetch(`${host.url}/profile`, { headers, method: 'POST' })).status).toBe(409)
      await fetch(`${host.url}/enable`, { headers, method: 'POST' })
      const snapshot = { sessions: [{ sessionId: 'session1', chatState: 'thinking', connectionState: 'connected',
        pendingPermissionCount: 1, queuedMessageCount: 2 }], truncated: false }
      ipc.emit(LIVE_DEBUG_CHANNEL, { sender: {} }, { type: 'snapshot', snapshot })
      expect((await (await fetch(`${host.url}/status`, { headers })).json()).rendererObservation).toBeNull()
      ipc.emit(LIVE_DEBUG_CHANNEL, { sender: contents }, { type: 'snapshot', snapshot })
      contents.emit('unresponsive')
      await new Promise(resolve => setTimeout(resolve, 40))
      const status = await (await fetch(`${host.url}/status`, { headers })).json()
      expect(status.renderer.responsive).toBe(false)
      expect(status.recoveryHeld).toBe(true)
      expect(status.rendererObservation.snapshot).toEqual(snapshot)
      expect(status.rendererObservation.stale).toBe(false)
      expect(contents.reload).not.toHaveBeenCalled()
      const profile = await fetch(`${host.url}/profile?durationMs=100`, { headers, method: 'POST' })
      expect(profile.status).toBe(200)
      expect((await profile.json()).profile.nodes).toEqual([])
      expect(debuggerApi.sendCommand.mock.calls.map(call => call[0])).toEqual([
        'Profiler.enable', 'Profiler.setSamplingInterval', 'Profiler.start', 'Profiler.stop',
      ])
      expect(debuggerApi.detach).toHaveBeenCalledTimes(1)
      attached = true
      expect((await fetch(`${host.url}/profile`, { headers, method: 'POST' })).status).toBe(409)
      expect(debuggerApi.detach).toHaveBeenCalledTimes(1)
      attached = false
      debuggerApi.sendCommand.mockRejectedValueOnce(new Error('gone'))
      expect((await fetch(`${host.url}/profile?durationMs=100`, { headers, method: 'POST' })).status).toBe(503)
      expect(debuggerApi.detach).toHaveBeenCalledTimes(2)
      await fetch(`${host.url}/recovery/resume`, { headers, method: 'POST' })
      await new Promise(resolve => setTimeout(resolve, 10))
      expect(contents.reload).toHaveBeenCalledTimes(1)
    } finally { await host.close(); window.emit('closed'); await rm(root, { recursive: true, force: true }) }
  })
})
