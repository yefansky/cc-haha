import { useEffect, useState } from 'react'
import { providersApi } from '@/api/providers'
import type { ProviderTestResult } from '@/types/provider'
import { Button } from '@/components/ui/Button'
import { useTranslation } from '@/i18n'
import { getDesktopHost } from '@/lib/desktopHost'
import { useProviderStore } from '@/stores/providerStore'
import { useSeasunStore } from './store'

export function SeasunLoginPanel() {
  const t = useTranslation()
  const { status, busy, cancelling, error, refresh, login, cancel } = useSeasunStore()
  const { providers, activeId, activateProvider, refreshModelCatalog, modelRefreshStatus } = useProviderStore()
  const [candidate, setCandidate] = useState('')
  const [testing, setTesting] = useState(false)
  const [saving, setSaving] = useState(false)
  const [testResult, setTestResult] = useState<ProviderTestResult | null>(null)
  const [saveFailed, setSaveFailed] = useState(false)
  const [switching, setSwitching] = useState(false)
  const [switchFailed, setSwitchFailed] = useState(false)
  const desktopLogin = !!getDesktopHost().providerBusinesses?.seasun
  const provider = providers.find(item => item.presetId === 'seasun' && (!status?.providerId || item.id === status.providerId))
  const models = provider?.modelCatalog ?? []
  const refreshStatus = provider ? modelRefreshStatus[provider.id] : undefined
  const active = !!provider && activeId === provider.id
  useEffect(() => { void refresh() }, [refresh])
  useEffect(() => { setCandidate(provider?.models.main ?? ''); setTestResult(null) }, [provider?.id, provider?.models.main])

  async function testCandidate() {
    if (!provider || !candidate) return
    setTesting(true); setTestResult(null)
    try { setTestResult(await useProviderStore.getState().testProvider(provider.id, { modelId: candidate })) }
    catch { setTestResult({ connectivity: { success: false, latencyMs: 0 } }) }
    finally { setTesting(false) }
  }

  async function saveCandidate() {
    if (!provider || !candidate) return
    setSaving(true); setTestResult(null); setSaveFailed(false)
    try {
      // Test this exact model before saving it; a catalog entry alone is not proof of access.
      let result: ProviderTestResult
      try { result = await useProviderStore.getState().testProvider(provider.id, { modelId: candidate }) }
      catch { result = { connectivity: { success: false, latencyMs: 0 } } }
      setTestResult(result)
      if (!result.connectivity.success) return
      const latest = useProviderStore.getState().providers.find(item => item.id === provider.id)
      if (!latest?.modelCatalog?.some(model => model.id === candidate) || latest.models.main !== provider.models.main) {
        setSaveFailed(true)
        return
      }
      // Change the default for future work, without switching live session models.
      await providersApi.update(provider.id, { models: { main: candidate, haiku: candidate, sonnet: candidate, opus: candidate } })
      await useProviderStore.getState().fetchProviders()
    } catch { setSaveFailed(true) }
    finally { setSaving(false) }
  }

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
      {provider && <Button size="sm" variant="secondary" disabled={busy || refreshStatus?.pending} onClick={() => void refreshModelCatalog(provider.id)}>
        {t(refreshStatus?.pending ? 'settings.seasun.refreshingModels' : 'settings.seasun.refreshModels')}
      </Button>}
      {provider && !active && <Button size="sm" variant="secondary" disabled={busy || switching || !provider.models.main.trim() || !models.some(model => model.id === provider.models.main) || status?.modelAccess === 'unassigned'} onClick={() => void activate()}>
        {t('settings.seasun.setDefault')}
      </Button>}
    </div>
    {provider && <div role="status" className="text-xs text-[var(--color-text-secondary)]">
      {refreshStatus?.reconnectRequired ? t('settings.seasun.modelReconnectRequired')
        : refreshStatus?.failed ? t('settings.seasun.modelRefreshFailed')
          : refreshStatus?.updatedAt ? t('settings.seasun.modelsUpdated', { time: new Date(refreshStatus.updatedAt).toLocaleTimeString() })
            : t('settings.seasun.modelRefreshOnStartup')}
      {refreshStatus?.defaultChanged && <p>{t('settings.seasun.modelDefaultChanged')}</p>}
    </div>}
    {provider && <div className="flex flex-col gap-2 rounded-[var(--radius-md)] border border-[var(--color-border-separator)] p-3">
      <label htmlFor="seasun-default-model">{t('settings.seasun.chooseModel')}</label>
      {(!provider.models.main || !models.some(model => model.id === provider.models.main)) &&
        <p role="status">{t('settings.seasun.chooseModelHint')}</p>}
      <select id="seasun-default-model" disabled={testing || saving} value={models.some(model => model.id === candidate) ? candidate : ''}
        onChange={event => { setCandidate(event.target.value); setTestResult(null) }}>
        <option value="">{t('settings.seasun.chooseModelPlaceholder')}</option>
        {models.map(model => <option key={model.id} value={model.id}>{model.name || model.id}</option>)}
      </select>
      <div className="flex gap-2">
        <Button size="sm" variant="secondary" disabled={!candidate || !models.some(model => model.id === candidate) || testing || saving} onClick={() => void testCandidate()}>{t('settings.seasun.testModel')}</Button>
        <Button size="sm" disabled={!candidate || !models.some(model => model.id === candidate) || saving || testing} onClick={() => void saveCandidate()}>{t('settings.seasun.saveModel')}</Button>
      </div>
      {testResult && <p role="status">{testResult.connectivity.success
        ? t('settings.seasun.modelTestSuccess', { model: candidate })
        : t('settings.seasun.modelTestFailed', { model: candidate, status: String(testResult.connectivity.httpStatus ?? '—') })}</p>}
      {saveFailed && <p role="alert">{t('settings.seasun.modelSaveFailed')}</p>}
    </div>}
    {(error || switchFailed) && <p role="alert" className="text-[var(--color-error)]">
      {t(error === 'cancel_unconfirmed' ? 'settings.seasun.cancelUnconfirmed' : 'settings.seasun.failed')}
    </p>}
  </div>
}
