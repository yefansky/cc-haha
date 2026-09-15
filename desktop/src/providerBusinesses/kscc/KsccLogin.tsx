import { useEffect, useState } from 'react'
import { Copy, LogIn } from 'lucide-react'
import { copyTextToClipboard } from '@/lib/clipboard'
import { getDesktopHost } from '@/lib/desktopHost'
import { useTranslation } from '@/i18n'
import { useKsccOAuthStore } from './store'
import { useProviderStore } from '@/stores/providerStore'
import { Button } from '@/components/ui/Button'

export function KsccLogin() {
  const t = useTranslation()
  const [manualUrl, setManualUrl] = useState<string | null>(null)
  const [switchError, setSwitchError] = useState<string | null>(null)
  const [isSwitching, setIsSwitching] = useState(false)
  const { status, isLoading, error, fetchStatus, login, startPolling, stopPolling } = useKsccOAuthStore()
  const { providers, activeId, fetchProviders, activateProvider, refreshModelCatalog, modelRefreshStatus } = useProviderStore()
  const ksccProvider = providers.find((provider) => provider.presetId === 'kscc')
  const refreshStatus = ksccProvider ? modelRefreshStatus[ksccProvider.id] : undefined
  const isActive = providers.some((provider) => provider.id === activeId && provider.presetId === 'kscc')

  useEffect(() => {
    void fetchStatus()
    return () => stopPolling()
  }, [fetchStatus, stopPolling])

  useEffect(() => {
    if (status?.loggedIn) void fetchProviders()
  }, [fetchProviders, status?.loggedIn])

  const signIn = async () => {
    setManualUrl(null)
    try {
      const result = await login()
      if (!result.authorizeUrl) {
        await Promise.all([fetchStatus(), fetchProviders()])
        return
      }
      setManualUrl(result.authorizeUrl)
      try {
        await getDesktopHost().shell.open(result.authorizeUrl)
        setManualUrl(null)
        startPolling()
      } catch {
        // Keep the copyable link visible when the desktop shell cannot open it.
      }
    } catch {
      // The store owns the error state.
    }
  }

  const switchToKscc = async () => {
    setSwitchError(null)
    setIsSwitching(true)
    try {
      let provider = ksccProvider
      if (!provider) {
        await fetchProviders()
        provider = useProviderStore.getState().providers.find((item) => item.presetId === 'kscc')
      }
      if (!provider) throw new Error(t('settings.kscc.providerMissing'))
      await activateProvider(provider.id)
      await fetchStatus()
    } catch (reason) {
      setSwitchError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setIsSwitching(false)
    }
  }

  const copyLink = async () => {
    if (!manualUrl) return
    if (await copyTextToClipboard(manualUrl)) {
      setManualUrl(null)
      startPolling()
    }
  }

  if (status?.loggedIn) {
    const message = isActive
      ? t('settings.kscc.loggedInActive')
      : t('settings.kscc.loggedInInactive')
    return (
      <>
      <div className="flex items-center justify-between gap-3 rounded-lg border border-[var(--color-success)]/25 bg-[var(--color-success)]/5 px-3 py-2">
        <div className="text-sm text-[var(--color-success)]">{message}</div>
        <div className="flex shrink-0 items-center gap-2">
          {ksccProvider && <Button size="sm" variant="secondary" onClick={() => void refreshModelCatalog(ksccProvider.id)} disabled={refreshStatus?.pending}>
            {t(refreshStatus?.pending ? 'settings.kscc.refreshingModels' : 'settings.kscc.refreshModels')}
          </Button>}
          {!isActive && <button type="button" onClick={switchToKscc} disabled={isLoading || isSwitching} className="rounded-md bg-[image:var(--gradient-btn-primary)] px-3 py-1.5 text-xs text-[var(--color-btn-primary-fg)] disabled:opacity-50">
            {isSwitching ? t('settings.kscc.switching') : t('settings.kscc.switch')}
          </button>}
          <button type="button" onClick={signIn} disabled={isLoading} className="rounded-md border border-[var(--color-border-separator)] px-3 py-1.5 text-xs disabled:opacity-50">
            {t('settings.kscc.loginAgain')}
          </button>
        </div>
      </div>
      <div className="mt-2 text-xs text-[var(--color-text-secondary)]" role="status">
        {refreshStatus?.failed ? t('settings.kscc.modelRefreshFailed') : refreshStatus?.updatedAt ? t('settings.kscc.modelsUpdated', { time: new Date(refreshStatus.updatedAt).toLocaleTimeString() }) : t('settings.kscc.modelRefreshOnStartup')}
        {refreshStatus?.defaultChanged && <div>{t('settings.kscc.modelDefaultChanged')}</div>}
      </div>
      {switchError && <div className="mt-2 text-xs text-[var(--color-error)]">{t('settings.kscc.switchFailed', { error: switchError })}</div>}
      </>
    )
  }

  return (
    <div className="flex flex-col gap-2">
      <p className="text-sm text-[var(--color-text-secondary)]">{t('settings.kscc.description')}</p>
      <button type="button" onClick={signIn} disabled={isLoading} className="inline-flex w-fit items-center gap-2 rounded-md bg-[image:var(--gradient-btn-primary)] px-4 py-2 text-sm text-[var(--color-btn-primary-fg)] shadow-[var(--shadow-button-primary)] disabled:opacity-50">
        <LogIn className="h-4 w-4" aria-hidden="true" />
        {isLoading ? t('settings.kscc.connecting') : t('settings.kscc.loginAndEnable')}
      </button>
      {manualUrl && <button type="button" onClick={copyLink} className="inline-flex w-fit items-center gap-1.5 rounded-md border border-[var(--color-border-separator)] px-3 py-1.5 text-xs"><Copy className="h-3.5 w-3.5" aria-hidden="true" />{t('settings.kscc.copyLoginLink')}</button>}
      {status?.pending && <div className="text-xs text-[var(--color-text-tertiary)]">{t('settings.kscc.waitingForBrowser')}</div>}
      {error && <div className="text-xs text-[var(--color-error)]">{t('settings.kscc.loginFailed', { error })}</div>}
    </div>
  )
}
