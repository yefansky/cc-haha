import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { isSeasunIpcSender } from './services/seasunLogin'
import {
  configureLocalServerRequestAuth,
  configurePreviewSessionPermissions,
  createPreviewSessionPartition,
  isAllowlistedMainRendererMediaRequest,
} from './services/previewSession'

const desktopRoot = existsSync(path.resolve(process.cwd(), 'electron', 'main.ts'))
  ? process.cwd()
  : path.resolve(process.cwd(), 'desktop')
const mainSource = readFileSync(path.join(desktopRoot, 'electron', 'main.ts'), 'utf8')
const previewServiceSource = mainSource.slice(
  mainSource.indexOf('function getPreviewService()'),
  mainSource.indexOf('function getPetWindowController()'),
)
const mainWindowSource = mainSource.slice(
  mainSource.indexOf('async function createMainWindow()'),
  mainSource.indexOf('if (!acquireSingleInstanceLock'),
)

describe('Electron preview security boundary', () => {
  it('guards every gateway handler before accessing the runtime', () => {
    const methods = ['GetConfig', 'SaveConfig', 'ClearKey', 'TestConnection', 'Start', 'Stop', 'GetStatus']
    for (const method of methods) {
      const start = mainSource.indexOf(`registerHandler(ELECTRON_IPC_CHANNELS.gateway${method},`)
      expect(start).toBeGreaterThan(-1)
      const block = mainSource.slice(start, mainSource.indexOf('\n  })', start))
      expect(block).toMatch(/=>\s*\{\s*requireMainFrame\(event\)/)
    }
    expect(mainSource).toMatch(/const requireMainFrame =[\s\S]*?isSeasunIpcSender\(event, mainWindow, rendererEntry\(\)\)/)
  })

  it('gateway source guard rejects H5, preview, pet and same-origin child frames', () => {
    const frame = { url: 'http://localhost:1420/#/settings' }
    const contents = { mainFrame: frame }
    const window = { webContents: contents } as Parameters<typeof isSeasunIpcSender>[1]
    const event = { sender: contents, senderFrame: frame }
    expect(isSeasunIpcSender(event, window, 'http://localhost:1420/')).toBe(true)
    expect(isSeasunIpcSender(event, null, 'http://localhost:1420/')).toBe(false)
    for (const url of ['http://localhost:1420/', 'http://127.0.0.1:3000/', 'https://gateway.example/', 'http://localhost:1420/pet.html']) {
      expect(isSeasunIpcSender({ sender: {}, senderFrame: { url } }, window, 'http://localhost:1420/')).toBe(false)
      expect(isSeasunIpcSender({ sender: contents, senderFrame: { url } }, window, 'http://localhost:1420/')).toBe(false)
    }
    frame.url = 'https://gateway.example/'
    expect(isSeasunIpcSender(event, window, 'http://localhost:1420/')).toBe(false)
  })
  it('does not give the pet preload the desktop master access token', () => {
    const petPreloadSource = readFileSync(path.join(desktopRoot, 'electron', 'pet-preload.ts'), 'utf8')

    expect(petPreloadSource).toContain('runtimeGetPetAccessToken')
    expect(petPreloadSource).not.toContain('runtimeGetLocalAccessToken')
    expect(mainSource).toContain('resolvePetServerAccess')
  })

  it('uses a fresh in-memory session partition for every remote preview', () => {
    const firstPartition = createPreviewSessionPartition()
    const secondPartition = createPreviewSessionPartition()

    expect(firstPartition.startsWith('cc-haha-preview-')).toBe(true)
    expect(firstPartition.startsWith('persist:')).toBe(false)
    expect(secondPartition).not.toBe(firstPartition)
    expect(mainSource).toContain('partition: createPreviewSessionPartition()')
  })

  it('does not authenticate preview resources and only enables the main media allowlist', () => {
    expect(previewServiceSource).not.toContain('configureLocalServerRequestAuth')
    expect(previewServiceSource).not.toContain('resolveLocalServerAccess')
    expect(mainWindowSource).toContain('configureLocalServerRequestAuth')
    expect(mainWindowSource).toContain('isAllowlistedMainRendererMediaRequest')
  })

  it.each([
    ['open-target icon', 'GET', 'image', 'http://127.0.0.1:49321/api/open-targets/icons/cursor'],
    ['profile avatar', 'GET', 'image', 'http://127.0.0.1:49321/api/desktop-ui/preferences/profile/avatar?v=1'],
    ['path attachment', 'GET', 'image', 'http://127.0.0.1:49321/api/filesystem/file?path=%2Ftmp%2Fimage.png'],
    ['workspace image', 'GET', 'image', 'http://127.0.0.1:49321/preview-fs/session/image.png'],
    ['workspace video range', 'GET', 'media', 'http://127.0.0.1:49321/preview-fs/session/video.mp4'],
  ])('allows the main renderer %s request', (_name, method, resourceType, url) => {
    expect(isAllowlistedMainRendererMediaRequest({
      method,
      resourceType,
      url,
      webContentsId: 42,
    }, 42)).toBe(true)
  })

  it.each([
    ['privileged API image probe', 'GET', 'image', 'http://127.0.0.1:49321/api/sessions'],
    ['allowlisted path through fetch', 'GET', 'xhr', 'http://127.0.0.1:49321/api/open-targets/icons/cursor'],
    ['allowlisted path with mutation', 'POST', 'image', 'http://127.0.0.1:49321/api/filesystem/file?path=%2Ftmp%2Fimage.png'],
  ])('rejects the main renderer %s request', (_name, method, resourceType, url) => {
    expect(isAllowlistedMainRendererMediaRequest({
      method,
      resourceType,
      url,
      webContentsId: 42,
    }, 42)).toBe(false)
  })

  it('rejects allowlisted media from another web contents in the default session', () => {
    expect(isAllowlistedMainRendererMediaRequest({
      method: 'GET',
      resourceType: 'image',
      url: 'http://127.0.0.1:49321/api/open-targets/icons/cursor',
      webContentsId: 99,
    }, 42)).toBe(false)
  })

  it('injects the desktop token only for allowlisted media and preserves range headers', () => {
    let beforeSendHeaders: ((details: {
      method: string
      resourceType: string
      url: string
      webContentsId: number
      requestHeaders: Record<string, string>
    }, callback: (response: { requestHeaders: Record<string, string> }) => void) => void) | undefined
    const webRequest = {
      onBeforeSendHeaders(handler: typeof beforeSendHeaders) {
        beforeSendHeaders = handler
      },
    }

    configureLocalServerRequestAuth(
      webRequest as never,
      () => ({
        serverUrl: 'http://127.0.0.1:49321',
        token: 'desktop-local-token',
      }),
      details => isAllowlistedMainRendererMediaRequest(details, 42),
    )

    const videoCallback = vi.fn()
    beforeSendHeaders?.({
      method: 'GET',
      resourceType: 'media',
      url: 'http://127.0.0.1:49321/preview-fs/session/video.mp4',
      webContentsId: 42,
      requestHeaders: { Accept: 'video/*', Range: 'bytes=0-1023' },
    }, videoCallback)
    expect(videoCallback).toHaveBeenCalledWith({
      requestHeaders: {
        Accept: 'video/*',
        Range: 'bytes=0-1023',
        Authorization: 'Bearer desktop-local-token',
      },
    })

    for (const details of [
      {
        method: 'GET',
        resourceType: 'image',
        url: 'http://127.0.0.1:49321/api/sessions',
        webContentsId: 42,
      },
      {
        method: 'GET',
        resourceType: 'xhr',
        url: 'http://127.0.0.1:49321/api/open-targets/icons/cursor',
        webContentsId: 42,
      },
      {
        method: 'GET',
        resourceType: 'image',
        url: 'https://example.com/api/open-targets/icons/cursor',
        webContentsId: 42,
      },
      {
        method: 'GET',
        resourceType: 'image',
        url: 'http://127.0.0.1:49321/api/open-targets/icons/cursor',
        webContentsId: 99,
      },
    ]) {
      const callback = vi.fn()
      beforeSendHeaders?.({
        ...details,
        requestHeaders: { Accept: '*/*' },
      }, callback)
      expect(callback).toHaveBeenCalledWith({
        requestHeaders: { Accept: '*/*' },
      })
    }
  })

  it('denies preview permission checks and requests by default', () => {
    const handlers: {
      check?: (...args: unknown[]) => boolean
      request?: (...args: unknown[]) => void
      beforeSendHeaders?: (...args: unknown[]) => void
    } = {}
    const session = {
      setPermissionCheckHandler(handler: (...args: unknown[]) => boolean) {
        handlers.check = handler
      },
      setPermissionRequestHandler(handler: (...args: unknown[]) => void) {
        handlers.request = handler
      },
      webRequest: {
        onBeforeSendHeaders(handler: (...args: unknown[]) => void) {
          handlers.beforeSendHeaders = handler
        },
      },
    }

    configurePreviewSessionPermissions(session as never)
    configureLocalServerRequestAuth(session.webRequest as never, () => ({
      serverUrl: 'http://127.0.0.1:49321',
      token: 'preview-local-token',
    }))

    expect(handlers.check?.()).toBe(false)
    const callback = (allowed: boolean) => expect(allowed).toBe(false)
    handlers.request?.(null, 'media', callback)
    expect(mainSource).toContain('configurePreviewSessionPermissions(view.webContents.session)')

    const localCallback = vi.fn()
    handlers.beforeSendHeaders?.({
      url: 'http://127.0.0.1:49321/preview-fs/session/index.css',
      requestHeaders: { Accept: 'text/css' },
    }, localCallback)
    expect(localCallback).toHaveBeenCalledWith({
      requestHeaders: {
        Accept: 'text/css',
        Authorization: 'Bearer preview-local-token',
      },
    })

    const remoteCallback = vi.fn()
    handlers.beforeSendHeaders?.({
      url: 'https://example.com/app.js',
      requestHeaders: { Accept: '*/*' },
    }, remoteCallback)
    expect(remoteCallback).toHaveBeenCalledWith({ requestHeaders: { Accept: '*/*' } })
  })
})
