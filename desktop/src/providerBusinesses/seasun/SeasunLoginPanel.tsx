import { useEffect, useState } from 'react'
import { Button } from '@/components/ui/Button'
import { useTranslation } from '@/i18n'
import { getDesktopHost } from '@/lib/desktopHost'
import { useProviderStore } from '@/stores/providerStore'
import { useSeasunStore } from './store'

export function SeasunLoginPanel() {
  const t = useTranslation()
  const { status, busy, cancelling, error, refresh, login, cancel } = useSeasunStore()
  const { providers, activeId, activateProvider } = useProviderStore()
  const [switching, setSwitching] = useState(false)
  const [switchFailed, setSwitchFailed] = useState(false)
  const desktopLogin = !!getDesktopHost().providerBusinesses?.seasun
  const provider = providers.find(item => item.presetId === 'seasun' && (!status?.providerId || item.id === status.providerId))
  const models = provider?.modelCatalog ?? []
  const active = !!provider && activeId === provider.id
  useEffect(() => { void refresh() }, [refresh])

  async function activate() {
    if (!provider) return
    setSwitching(true); setSwitchFailed(false)
    try { await activateProvider(provider.id) }
    catch { setSwitchFailed(true) }
    finally { setSwitching(false) }
  }

  return <div className="flex flex-col gap-3 text-sm">
    <p className="text-[var(--color-text-secondary)]">{t('settings.seasun.description')}</p>
    <div role="status" className="text-[var(--color-text-primary)]">
      {status?.identityConnected ? t('settings.seasun.connected') : t('settings.seasun.notConnected')}
      {active && <span className="ml-2">{t('settings.seasun.active')}</span>}
    </div>
    {status?.identityConnected && <p className="text-[var(--color-text-secondary)]">
      {t(status.modelAccess === 'ready' ? 'settings.seasun.ready' : status.modelAccess === 'unassigned' ? 'settings.seasun.unassigned' : 'settings.seasun.unknown')}
    </p>}
    {!desktopLogin && <p className="text-[var(--color-text-secondary)]">{t('settings.seasun.desktopRequired')}</p>}
    {busy && <p className="text-[var(--color-text-secondary)]">{t(cancelling ? 'settings.seasun.cancelling' : 'settings.seasun.waiting')}</p>}
    {status?.phase === 'expired' && <p role="alert" className="text-[var(--color-error)]">{t('settings.seasun.expired')}</p>}
    <div className="flex flex-wrap items-center gap-2">
      {desktopLogin && <Button size="sm" onClick={() => void login()} disabled={busy}>
        {t(status?.identityConnected ? 'settings.seasun.reconnect' : 'settings.seasun.login')}
      </Button>}
      {desktopLogin && busy && <Button size="sm" variant="secondary" disabled={cancelling} onClick={() => void cancel()}>{t('settings.seasun.cancel')}</Button>}
      <Button size="sm" variant="secondary" disabled={busy} onClick={() => void refresh()}>{t('settings.seasun.refresh')}</Button>
      {provider && !active && <Button size="sm" variant="secondary" disabled={busy || switching || !models.length || status?.modelAccess === 'unassigned'} onClick={() => void activate()}>
        {t('settings.seasun.setDefault')}
      </Button>}
    </div>
    {models.length > 0 && <details className="rounded-[var(--radius-md)] border border-[var(--color-border-separator)] p-3">
      <summary className="cursor-pointer focus-visible:ring-2 focus-visible:ring-[var(--color-border-focus)]">{t('settings.seasun.models', { count: models.length })}</summary>
      <ul className="mt-2 flex flex-col gap-1 text-[var(--color-text-secondary)]">{models.map(model => <li key={model.id}>{model.name || model.id}</li>)}</ul>
    </details>}
    {(error || switchFailed) && <p role="alert" className="text-[var(--color-error)]">
      {t(error === 'cancel_unconfirmed' ? 'settings.seasun.cancelUnconfirmed' : 'settings.seasun.failed')}
    </p>}
  </div>
}
