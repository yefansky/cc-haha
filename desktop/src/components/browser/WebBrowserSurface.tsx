import { useState } from 'react'
import { useTranslation } from '../../i18n'
import { useBrowserPanelStore } from '../../stores/browserPanelStore'
import { BrowserAddressBar } from './BrowserAddressBar'
import { resolveBrowserNavigationUrl } from './BrowserSurface'

/** The H5 client has no native preview window. Keep generated HTML in an
 * opaque-origin sandbox so it cannot read the parent application's session. */
export function WebBrowserSurface({ sessionId }: { sessionId: string }) {
  const t = useTranslation()
  const session = useBrowserPanelStore((state) => state.bySession[sessionId])
  const [reload, setReload] = useState(0)
  const store = useBrowserPanelStore.getState()
  if (!session) return null
  const url = resolveBrowserNavigationUrl(session.url, sessionId)
  const safeUrl = /^https?:\/\//i.test(url) ? url : ''

  return (
    <div className="flex h-full min-h-0 min-w-0 flex-col">
      <BrowserAddressBar url={url} canGoBack={session.canGoBack} canGoForward={session.canGoForward}
        loading={session.loading && Boolean(safeUrl)}
        onNavigate={(value) => store.navigate(sessionId, resolveBrowserNavigationUrl(value, sessionId))}
        onBack={() => store.goBack(sessionId)} onForward={() => store.goForward(sessionId)}
        onReload={() => { store.setLoading(sessionId, true); setReload((value) => value + 1) }}
        onOpenExternal={() => { if (safeUrl) window.open(safeUrl, '_blank', 'noopener,noreferrer') }} />
      {safeUrl ? (
        <iframe key={`${safeUrl}:${reload}`} title={t('workbench.modeBrowser')}
          src={safeUrl} sandbox="allow-scripts" referrerPolicy="no-referrer"
          className="min-h-0 w-full flex-1 border-0 bg-white"
          onLoad={() => store.setLoading(sessionId, false)}
          onError={() => store.setLoading(sessionId, false)} />
      ) : url ? (
        <p role="alert" className="break-all p-4 text-sm">{t('browser.loadFailed')}: {url}</p>
      ) : null}
    </div>
  )
}
