import { contextBridge, ipcRenderer, webUtils } from 'electron'
import { createElectronHost } from '../src/lib/desktopHost/electronHost'
import type { DesktopHostUnlisten } from '../src/lib/desktopHost/types'
import type { ElectronEventChannel, ElectronIpcChannel } from './ipc/channels'
import { LIVE_DEBUG_CHANNEL, parseRendererDebugSnapshot } from '../src/lib/liveDebugObservation'
import { parseRendererBoundary } from '../src/lib/rendererBoundaryTrace'

const electronHost = createElectronHost({
  getPathForFile(file) {
    return webUtils.getPathForFile(file)
  },
  invoke<T>(channel: ElectronIpcChannel, payload?: unknown): Promise<T> {
    return ipcRenderer.invoke(channel, payload) as Promise<T>
  },
  subscribe<T>(
    channel: ElectronEventChannel,
    handler: (payload: T) => void,
  ): Promise<DesktopHostUnlisten> {
    const listener = (_event: Electron.IpcRendererEvent, payload: T) => handler(payload)
    ipcRenderer.on(channel, listener)
    return Promise.resolve(() => {
      ipcRenderer.removeListener(channel, listener)
    })
  },
})

contextBridge.exposeInMainWorld('desktopHost', electronHost)
contextBridge.exposeInMainWorld('liveDebugObservation', {
  subscribe(handler: (enabled: boolean, recordingId?: string | null) => void) {
    const listener = (_event: Electron.IpcRendererEvent, value: unknown) => {
      if (typeof value === 'boolean') handler(value)
      else if (value && typeof value === 'object') {
        const control = value as { enabled?: unknown; recordingId?: unknown }
        if (typeof control.enabled === 'boolean') handler(control.enabled,
          typeof control.recordingId === 'string' ? control.recordingId : null)
      }
    }
    ipcRenderer.on(LIVE_DEBUG_CHANNEL, listener)
    ipcRenderer.send(LIVE_DEBUG_CHANNEL, { type: 'subscribe' })
    return () => ipcRenderer.removeListener(LIVE_DEBUG_CHANNEL, listener)
  },
  report(value: unknown) {
    const snapshot = parseRendererDebugSnapshot(value)
    if (snapshot) ipcRenderer.send(LIVE_DEBUG_CHANNEL, { type: 'snapshot', snapshot })
  },
  reportBoundary(value: unknown) {
    const event = parseRendererBoundary(value)
    if (event) ipcRenderer.send(LIVE_DEBUG_CHANNEL, { type: 'boundary', event })
  },
})
