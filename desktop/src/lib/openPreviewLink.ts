import { handlePreviewLink } from './handlePreviewLink'
import { getServerBaseUrl } from './desktopRuntime'
import { getDesktopHost } from './desktopHost'
import { useBrowserPanelStore } from '../stores/browserPanelStore'
import { useWorkspacePanelStore } from '../stores/workspacePanelStore'
import { remoteBrowserDestination, useBrowserLinkPreference } from './browserLinkPreference'
import { classifyPreviewLink } from './previewLinkRouter'

/**
 * Local artifacts and development URLs keep their workbench previews. Remote
 * links follow the current device's preference, shared by body links and cards.
 *
 * {@link handlePreviewLink} stays dependency-injected for testing; this is the
 * one place that binds it to the real stores, so the markdown body, the output
 * cards and the user prompt bubble cannot drift apart.
 *
 * Returns true when the link was handled (the caller should preventDefault).
 */
export function openPreviewLink(href: string, sessionId: string): boolean {
  const host = getDesktopHost()
  const classified = classifyPreviewLink(href)
  return handlePreviewLink(href, {
    remoteBrowser: classified.kind === 'remote'
      ? remoteBrowserDestination(classified.url!, host.isDesktop, useBrowserLinkPreference.getState().preference)
      : undefined,
    sessionId,
    serverBaseUrl: getServerBaseUrl(),
    openBrowser: (id, url) => useBrowserPanelStore.getState().open(id, url),
    openFilePreview: (id, path, reveal) => {
      void useWorkspacePanelStore.getState().openPreview(id, path, 'file', undefined, reveal)
    },
    openExternal: (url) => {
      void host.shell.open(url)
        .catch(() => window.open(url, '_blank', 'noopener,noreferrer'))
    },
  })
}
