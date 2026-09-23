import { getAuthToken, getBaseUrl, setApiContext } from '../api/client'
import { getDesktopHost } from './desktopHost'
import type { DesktopHost } from './desktopHost/types'

const RECOVERY_POLL_MS = 5000
const RECOVERY_TIMEOUT_MS = 5000

/** Keep an already mounted renderer attached without resetting its drafts or tabs. */
export function startDesktopServerRecovery(options: {
  onRecovered: () => void
  host?: Pick<DesktopHost, 'isDesktop' | 'runtime'>
}) {
  const host = options.host ?? getDesktopHost()
  if (!host.isDesktop) return () => {}
  let disposed = false
  let inFlight = false
  let revision = 0
  let appliedRevision = 0
  let unlisten: (() => void) | undefined
  let abort: AbortController | undefined

  const check = async () => {
    if (disposed || inFlight) return
    inFlight = true
    const startedRevision = revision
    const controller = new AbortController()
    abort = controller
    let timeout: ReturnType<typeof setTimeout> | undefined
    try {
      const [url, token] = await Promise.race([
        Promise.all([host.runtime.getServerUrl(), host.runtime.getLocalAccessToken()]),
        new Promise<never>((_, reject) => {
          timeout = setTimeout(() => {
            controller.abort()
            reject(new Error('Desktop server recovery timed out'))
          }, RECOVERY_TIMEOUT_MS)
        }),
      ])
      if (disposed || startedRevision !== revision) return
      const changed = url.replace(/\/$/, '') !== getBaseUrl() || (token?.trim() || null) !== getAuthToken()
      if (!changed && startedRevision === appliedRevision) return
      const health = await fetch(`${url.replace(/\/$/, '')}/health`, { signal: controller.signal })
      await health.arrayBuffer()
      if (!health.ok) throw new Error('Recovered desktop server is not healthy')
      if (disposed || startedRevision !== revision) return
      setApiContext(url, token, true)
      appliedRevision = startedRevision
      options.onRecovered()
    } catch {
      // Keep the current UI and retry on the next bounded tick. Never replay HTTP writes.
    } finally {
      clearTimeout(timeout)
      if (abort === controller) abort = undefined
      inFlight = false
      if (!disposed && startedRevision !== revision) void check()
    }
  }
  void host.runtime.onServerChanged?.(() => {
    revision++
    void check()
  }).then(off => { if (disposed) off(); else unlisten = off }).catch(() => {})
  // A bounded fallback also handles old preload bridges and missed events during bootstrap.
  const timer = setInterval(() => { void check() }, RECOVERY_POLL_MS)
  void check()
  return () => {
    disposed = true
    clearInterval(timer)
    abort?.abort()
    unlisten?.()
  }
}
