import { afterEach, describe, expect, it, vi } from 'vitest'
const { host, openBrowser, openFile } = vi.hoisted(() => ({
  host: { isDesktop: true, shell: { open: vi.fn().mockResolvedValue(undefined), openPath: vi.fn().mockResolvedValue(undefined) } },
  openBrowser: vi.fn(), openFile: vi.fn(),
}))
vi.mock('./desktopHost', () => ({ getDesktopHost: () => host }))
vi.mock('./desktopRuntime', async (original) => ({ ...await original<object>(), getServerBaseUrl: () => 'https://gateway.example' }))
vi.mock('../stores/browserPanelStore', () => ({ useBrowserPanelStore: { getState: () => ({ open: openBrowser }) } }))
vi.mock('../stores/workspacePanelStore', () => ({ useWorkspacePanelStore: { getState: () => ({ openPreview: openFile }) } }))
import { openPreviewLink } from './openPreviewLink'
import { openWithMenuDeps } from './openWithMenuItems'
import { useBrowserLinkPreference } from './browserLinkPreference'

afterEach(() => { vi.clearAllMocks(); host.isDesktop = true; useBrowserLinkPreference.getState().setPreference('auto') })
describe('device-aware link wiring', () => {
  it('opens desktop websites through the host URL opener', () => {
    openPreviewLink('https://example.com/', 's1')
    expect(host.shell.open).toHaveBeenCalledWith('https://example.com/')
    expect(openBrowser).not.toHaveBeenCalled()
  })
  it('retains H5 in-app previews and treats OAuth as current-device browser navigation', () => {
    host.isDesktop = false
    openPreviewLink('https://example.com/', 's1')
    expect(openBrowser).toHaveBeenCalledWith('s1', 'https://example.com/')
    const auth = 'https://openapi.wps.cn/oauth2/auth?client_id=c&response_type=code&state=s'
    openPreviewLink(auth, 's1')
    expect(host.shell.open).toHaveBeenCalledWith(auth)
  })
  it('device preference does not move local artifacts or development previews outside the app', () => {
    useBrowserLinkPreference.getState().setPreference('system')
    openPreviewLink('out/report.html', 's1')
    openPreviewLink('http://localhost:5173/', 's1')
    expect(openBrowser).toHaveBeenCalledTimes(2)
    expect(host.shell.open).not.toHaveBeenCalled()
  })
  it('URL menu uses open, files use openPath; H5 label names the current device', () => {
    host.isDesktop = false
    const opts = { sessionId: 's1', t: (key: string) => key }
    const urlDeps = openWithMenuDeps({ kind: 'url', url: 'https://example.com/' }, opts)
    urlDeps.openSystem('https://example.com/')
    expect(host.shell.open).toHaveBeenCalledWith('https://example.com/')
    expect(urlDeps.t('openWith.systemBrowser')).toBe('openWith.currentDeviceBrowser')
    openWithMenuDeps({ kind: 'file', absolutePath: 'G:/report.html' }, opts).openSystem('G:/report.html')
    expect(host.shell.openPath).toHaveBeenCalledWith('G:/report.html')
  })
})
