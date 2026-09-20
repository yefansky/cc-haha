import { createServer, type IncomingMessage } from 'node:http'
import { randomBytes, timingSafeEqual } from 'node:crypto'
import { mkdir, writeFile, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import type { BrowserWindow, IpcMain, IpcMainEvent } from 'electron'
import { LIVE_DEBUG_CHANNEL, parseRendererDebugSnapshot, type RendererDebugSnapshot } from '../../src/lib/liveDebugObservation'
import type { RendererRecoveryController } from './rendererLifecycle'

export function authorizedDebugRequest(request: IncomingMessage, token: string): boolean {
  if (request.socket.remoteAddress !== '127.0.0.1') return false
  if (Object.keys(request.headers).some(key => key === 'origin' || key === 'forwarded'
    || key.startsWith('x-forwarded-') || key.includes('gateway') || key.includes('forwarder'))) return false
  const actual = Buffer.from(request.headers.authorization ?? '')
  const expected = Buffer.from(`Bearer ${token}`)
  return actual.length === expected.length && timingSafeEqual(actual, expected)
}

// This control plane belongs to Electron, not the Bun server or the renderer.
// It remains available when either of those event loops stops progressing.
export async function startLiveDebugHost({ window, lifecycle, userData, ipc }: {
  window: BrowserWindow
  lifecycle: RendererRecoveryController
  userData: string
  ipc?: IpcMain
}) {
  const token = randomBytes(32).toString('hex')
  const discovery = join(userData, 'debug-host.json')
  let enabled = false
  let rendererSnapshot: { receivedAt: number; snapshot: RendererDebugSnapshot } | null = null
  const onObservation = (event: IpcMainEvent, payload: unknown) => {
    if (event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame
      || !payload || typeof payload !== 'object') return
    const message = payload as { type?: string; snapshot?: unknown }
    if (message.type === 'subscribe') window.webContents.send(LIVE_DEBUG_CHANNEL, enabled)
    if (enabled && message.type === 'snapshot') {
      const snapshot = parseRendererDebugSnapshot(message.snapshot)
      if (snapshot) rendererSnapshot = { receivedAt: Date.now(), snapshot }
    }
  }
  ipc?.on(LIVE_DEBUG_CHANNEL, onObservation)
  let responsive = true
  let lastRendererEventAt = Date.now()
  let profiling = false
  let closed = false
  let ownAttachment = false
  const debuggerApi = window.webContents.debugger
  const onDebuggerDetached = () => { ownAttachment = false }
  debuggerApi.on('detach', onDebuggerDetached)
  const setResponsive = (value: boolean) => {
    responsive = value
    lastRendererEventAt = Date.now()
  }
  const onResponsive = () => setResponsive(true)
  const onUnresponsive = () => setResponsive(false)
  window.webContents.on('responsive', onResponsive)
  window.webContents.on('unresponsive', onUnresponsive)
  window.webContents.on('render-process-gone', onUnresponsive)
  const detachOwned = () => {
    if (!ownAttachment) return
    ownAttachment = false
    try { if (debuggerApi.isAttached()) debuggerApi.detach() } catch { /* target exited */ }
  }
  const command = async (method: string, params?: Record<string, unknown>) => {
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      return await Promise.race([
        debuggerApi.sendCommand(method, params),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error('Debugger command timed out')), 3000)
        }),
      ])
    } finally { clearTimeout(timer) }
  }
  const server = createServer(async (request, response) => {
    response.setHeader('Content-Type', 'application/json')
    response.setHeader('Cache-Control', 'no-store')
    const reply = (status: number, value: unknown) => {
      response.statusCode = status
      response.end(JSON.stringify(value))
    }
    if (!authorizedDebugRequest(request, token)) { reply(403, { error: 'Forbidden' }); return }
    let url: URL
    try { url = new URL(request.url ?? '/', 'http://127.0.0.1') }
    catch { reply(400, { error: 'Invalid request URL' }); return }
    if (request.method === 'GET' && url.pathname === '/status') {
      reply(200, {
        schemaVersion: 1, observedAt: Date.now(), enabled, profiling,
        host: { pid: process.pid, uptimeSeconds: process.uptime(), memory: process.memoryUsage() },
        renderer: { responsive, lastRendererEventAt, destroyed: window.webContents.isDestroyed() },
        recoveryHeld: lifecycle.isHeld(),
        rendererObservation: rendererSnapshot ? { ...rendererSnapshot,
          ageMs: Date.now() - rendererSnapshot.receivedAt,
          stale: !enabled || Date.now() - rendererSnapshot.receivedAt > 3500 } : null,
        limits: ['Renderer responsiveness is based on Chromium events, not a live JavaScript stack.',
          'The host control plane cannot respond if the Electron main event loop is blocked.'],
      })
      return
    }
    if (request.method === 'POST' && ['/enable', '/disable', '/recovery/resume'].includes(url.pathname)) {
      if (url.pathname === '/enable') { enabled = true; lifecycle.setHeld(true) }
      else { if (url.pathname === '/disable') enabled = false; lifecycle.setHeld(false) }
      if (!window.webContents.isDestroyed()) window.webContents.send(LIVE_DEBUG_CHANNEL, enabled)
      reply(200, { enabled, recoveryHeld: lifecycle.isHeld() })
      return
    }
    if (request.method !== 'POST' || url.pathname !== '/profile') { reply(404, { error: 'Not found' }); return }
    if (!enabled) { reply(409, { error: 'Enable observation first' }); return }
    if (profiling || debuggerApi.isAttached()) { reply(409, { error: 'Debugger already in use' }); return }
    const durationMs = Number(url.searchParams.get('durationMs') ?? 1000)
    if (!Number.isInteger(durationMs) || durationMs < 100 || durationMs > 10000) {
      reply(400, { error: 'durationMs must be an integer between 100 and 10000' }); return
    }
    profiling = true
    try {
      debuggerApi.attach('1.3')
      ownAttachment = true
      await command('Profiler.enable')
      await command('Profiler.setSamplingInterval', { interval: 1000 })
      await command('Profiler.start')
      await new Promise(resolve => setTimeout(resolve, durationMs))
      const result = await command('Profiler.stop')
      reply(200, { durationMs, ...result })
    } catch {
      reply(503, { error: 'Renderer profiling unavailable or timed out; no recovery was performed' })
    } finally {
      detachOwned()
      profiling = false
    }
  })
  server.requestTimeout = 15000
  server.headersTimeout = 5000
  server.maxConnections = 8
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => { server.off('error', reject); resolve() })
  })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Debug host address unavailable')
  try {
    await mkdir(userData, { recursive: true })
    await writeFile(discovery, JSON.stringify({ schemaVersion: 1, pid: process.pid,
      url: `http://127.0.0.1:${address.port}`, token }), { mode: 0o600 })
  } catch (error) { server.close(); throw error }
  const close = async () => {
    if (closed) return
    closed = true
    detachOwned()
    server.closeAllConnections()
    server.close()
    window.webContents.removeListener('responsive', onResponsive)
    window.webContents.removeListener('unresponsive', onUnresponsive)
    window.webContents.removeListener('render-process-gone', onUnresponsive)
    debuggerApi.removeListener('detach', onDebuggerDetached)
    ipc?.removeListener(LIVE_DEBUG_CHANNEL, onObservation)
    await unlink(discovery).catch(() => {})
  }
  window.once('closed', () => { void close() })
  return { close, url: `http://127.0.0.1:${address.port}` }
}
