export type WindowOpenHandlerResult = { action: 'deny' } | { action: 'allow' }

export type NavigationGuardWebContents = {
  getURL?(): string
  loadURL?(url: string): Promise<unknown>
  setWindowOpenHandler(handler: (details: { url: string }) => WindowOpenHandlerResult): void
  on(
    event: 'will-navigate',
    handler: (event: { preventDefault: () => void }, url: string) => void,
  ): unknown
}

export type NavigationGuardOptions = {
  openExternal: (url: string) => void
}

function isLoopbackHostname(hostname: string): boolean {
  const normalized = hostname
    .trim()
    .replace(/^\[/, '')
    .replace(/\]$/, '')
    .toLowerCase()

  if (normalized === 'localhost' || normalized === '::1') return true
  const parts = normalized.split('.')
  return parts.length === 4 &&
    parts[0] === '127' &&
    parts.every((part) => /^\d+$/.test(part) && Number(part) >= 0 && Number(part) <= 255)
}

export function isHttpUrl(url: string): boolean {
  try {
    const { protocol } = new URL(url)
    return protocol === 'http:' || protocol === 'https:'
  } catch {
    return false
  }
}

export function isAllowedMainWindowNavigationUrl(url: string): boolean {
  try {
    const parsed = new URL(url)
    if (parsed.protocol === 'file:') return true
    if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
      return isLoopbackHostname(parsed.hostname)
    }
    return false
  } catch {
    return false
  }
}

/**
 * Main app window guard. The renderer is a single-page app loaded from a fixed
 * entry; it should never spawn an uncontrolled child window. Any window.open /
 * target=_blank with an http(s) URL is routed to the system browser and the
 * Electron popup is denied. Top-level navigation is restricted to local
 * renderer entries so a remote page cannot inherit the privileged preload.
 */
export function installMainWindowNavigationGuards(
  webContents: NavigationGuardWebContents,
  { openExternal }: NavigationGuardOptions,
): void {
  webContents.setWindowOpenHandler(({ url }) => {
    if (isHttpUrl(url)) openExternal(url)
    return { action: 'deny' }
  })
  webContents.on('will-navigate', (event, url) => {
    if (isAllowedMainWindowNavigationUrl(url)) return
    event.preventDefault()
    if (isHttpUrl(url)) openExternal(url)
  })
}

/**
 * Preview (WebContentsView) guard. The preview renders untrusted remote pages,
 * so it must keep working as a browser: in-page http(s) navigation is allowed.
 * Popups are denied (http(s) ones handed to the system browser), and navigation
 * to custom schemes is blocked. Local documents explicitly opened by the host
 * may follow local links; remote documents cannot navigate into local files.
 */
export function installPreviewNavigationGuards(
  webContents: NavigationGuardWebContents,
  { openExternal }: NavigationGuardOptions,
): void {
  const localNavigation = (url: string) => {
    try {
      const target = new URL(url)
      const source = new URL(webContents.getURL?.() ?? '')
      return source.protocol === 'file:' && !source.hostname &&
        target.protocol === 'file:' && !target.hostname
    } catch { return false }
  }
  webContents.setWindowOpenHandler(({ url }) => {
    if (isHttpUrl(url)) openExternal(url)
    else if (localNavigation(url)) void webContents.loadURL?.(url).catch(() => {})
    return { action: 'deny' }
  })
  webContents.on('will-navigate', (event, url) => {
    if (!isHttpUrl(url) && !localNavigation(url)) event.preventDefault()
  })
}
