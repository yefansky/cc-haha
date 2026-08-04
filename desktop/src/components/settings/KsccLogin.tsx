import { useEffect, useState } from 'react'
import { Copy, LogIn } from 'lucide-react'
import { copyTextToClipboard } from '@/lib/clipboard'
import { getDesktopHost } from '../../lib/desktopHost'
import { useKsccOAuthStore } from '../../stores/ksccOAuthStore'
import { useProviderStore } from '../../stores/providerStore'

export function KsccLogin() {
  const [manualUrl, setManualUrl] = useState<string | null>(null)
  const [switchError, setSwitchError] = useState<string | null>(null)
  const [isSwitching, setIsSwitching] = useState(false)
  const { status, isLoading, error, fetchStatus, login, startPolling, stopPolling } = useKsccOAuthStore()
  const { providers, fetchProviders, activateProvider } = useProviderStore()
  const ksccProvider = providers.find((provider) => provider.presetId === 'kscc')

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
      if (!provider) throw new Error('KSCC 服务商尚未创建，请重新登录')
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
    const message = status.active
      ? 'KSCC \u5DF2\u767B\u5F55\uFF0C\u5F53\u524D\u6B63\u5728\u4F7F\u7528'
      : 'KSCC \u5DF2\u767B\u5F55\uFF0C\u53EF\u5728\u4E0B\u65B9\u670D\u52A1\u5546\u5217\u8868\u5207\u6362'
    return (
      <>
      <div className="flex items-center justify-between gap-3 rounded-lg border border-[var(--color-success)]/25 bg-[var(--color-success)]/5 px-3 py-2">
        <div className="text-sm text-[var(--color-success)]">{message}</div>
        <div className="flex shrink-0 items-center gap-2">
          {!status.active && <button type="button" onClick={switchToKscc} disabled={isLoading || isSwitching} className="rounded-md bg-[image:var(--gradient-btn-primary)] px-3 py-1.5 text-xs text-[var(--color-btn-primary-fg)] disabled:opacity-50">
            {isSwitching ? '\u6B63\u5728\u5207\u6362\u2026' : '\u5207\u6362\u4E3A KSCC'}
          </button>}
          <button type="button" onClick={signIn} disabled={isLoading} className="rounded-md border border-[var(--color-border-separator)] px-3 py-1.5 text-xs disabled:opacity-50">
            {'\u91CD\u65B0\u767B\u5F55'}
          </button>
        </div>
      </div>
      {switchError && <div className="mt-2 text-xs text-[var(--color-error)]">{'KSCC \u5207\u6362\u5931\u8D25\uFF1A'}{switchError}</div>}
      </>
    )
  }

  return (
    <div className="flex flex-col gap-2">
      <p className="text-sm text-[var(--color-text-secondary)]">{'\u767B\u5F55 KSCC \u3002\u82E5\u672C\u673A KSCC \u5DF2\u767B\u5F55\uFF0C\u4F1A\u76F4\u63A5\u590D\u7528\u8BE5\u767B\u5F55\u6001\uFF1B\u5426\u5219\u6253\u5F00\u767B\u5F55\u9875\u3002'}</p>
      <button type="button" onClick={signIn} disabled={isLoading} className="inline-flex w-fit items-center gap-2 rounded-md bg-[image:var(--gradient-btn-primary)] px-4 py-2 text-sm text-[var(--color-btn-primary-fg)] shadow-[var(--shadow-button-primary)] disabled:opacity-50">
        <LogIn className="h-4 w-4" aria-hidden="true" />
        {isLoading ? '\u6B63\u5728\u8FDE\u63A5 KSCC\u2026' : '\u767B\u5F55\u5E76\u542F\u7528 KSCC'}
      </button>
      {manualUrl && <button type="button" onClick={copyLink} className="inline-flex w-fit items-center gap-1.5 rounded-md border border-[var(--color-border-separator)] px-3 py-1.5 text-xs"><Copy className="h-3.5 w-3.5" aria-hidden="true" />{'\u590D\u5236\u767B\u5F55\u94FE\u63A5'}</button>}
      {status?.pending && <div className="text-xs text-[var(--color-text-tertiary)]">{'\u7B49\u5F85\u5728\u6D4F\u89C8\u5668\u4E2D\u5B8C\u6210 KSCC \u767B\u5F55\u2026'}</div>}
      {error && <div className="text-xs text-[var(--color-error)]">{'KSCC \u767B\u5F55\u5931\u8D25\uFF1A'}{error}</div>}
    </div>
  )
}
