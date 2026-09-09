import { useEffect, useId, useRef, useState } from 'react'
import { Globe, Play, Square, Unplug } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { Card } from '@/components/ui/Card'
import { Input } from '@/components/ui/Input'
import { Switch } from '@/components/ui/Switch'
import { useTranslation } from '@/i18n'
import { getDesktopHost } from '@/lib/desktopHost'
import type { GatewayConfig, GatewayErrorCode, GatewayStatus, GatewayTestResult } from '@/lib/desktopHost/gatewayTypes'

const errorKeys = {
  CONFIG_INVALID: 'settings.gateway.error.CONFIG_INVALID',
  KEY_REQUIRED: 'settings.gateway.error.KEY_REQUIRED',
  KEY_INVALID: 'settings.gateway.error.KEY_INVALID',
  KEY_REVOKED: 'settings.gateway.error.KEY_REVOKED',
  KEY_IN_USE: 'settings.gateway.error.KEY_IN_USE',
  PROTOCOL_ERROR: 'settings.gateway.error.PROTOCOL_ERROR',
  LOCAL_SERVER_UNAVAILABLE: 'settings.gateway.error.LOCAL_SERVER_UNAVAILABLE',
  CLIENT_NOT_INSTALLED: 'settings.gateway.error.CLIENT_NOT_INSTALLED',
  CONNECTION_FAILED: 'settings.gateway.error.CONNECTION_FAILED',
  TLS_ERROR: 'settings.gateway.error.TLS_ERROR',
  STORAGE_ERROR: 'settings.gateway.error.STORAGE_ERROR',
  BUSY: 'settings.gateway.error.BUSY',
  PROCESS_EXITED: 'settings.gateway.error.PROCESS_EXITED',
} as const
const stateKeys = {
  stopped: 'settings.gateway.state.stopped',
  testing: 'settings.gateway.state.testing',
  connecting: 'settings.gateway.state.connecting',
  online: 'settings.gateway.state.online',
  backoff: 'settings.gateway.state.backoff',
  error: 'settings.gateway.state.error',
  stopping: 'settings.gateway.state.stopping',
} as const
const resultKeys = {
  localReady: 'settings.gateway.localReady',
  gatewayConnected: 'settings.gateway.gatewayConnected',
  keyAccepted: 'settings.gateway.keyAccepted',
  endToEndVerified: 'settings.gateway.endToEndVerified',
} as const

function safeCode(error: unknown): GatewayErrorCode {
  const code = typeof error === 'object' && error !== null && 'code' in error ? error.code : error
  return typeof code === 'string' && Object.hasOwn(errorKeys, code) ? code as GatewayErrorCode : 'CONNECTION_FAILED'
}

export function GatewayAccessSettings() {
  const t = useTranslation()
  const [host] = useState(getDesktopHost)
  const titleId = useId()
  const errorId = useId()
  const [config, setConfig] = useState<GatewayConfig | null>(null)
  const [gatewayUrl, setGatewayUrl] = useState('')
  const [accessKey, setAccessKey] = useState('')
  const [autoStart, setAutoStart] = useState(false)
  const [status, setStatus] = useState<GatewayStatus>({ generation: -1, state: 'stopped' })
  const [result, setResult] = useState<GatewayTestResult | null>(null)
  const [error, setError] = useState<GatewayErrorCode | null>(null)
  const [busy, setBusy] = useState(true)
  const mounted = useRef(false)
  const actionLock = useRef(false)
  const latestStatus = useRef(status)
  const statusRevision = useRef(0)

  function acceptStatus(next: GatewayStatus) {
    if (!mounted.current || next.generation < latestStatus.current.generation) return
    latestStatus.current = next
    statusRevision.current += 1
    setStatus(next)
  }

  function acceptConfig(next: GatewayConfig) {
    setConfig(next)
    setGatewayUrl(next.gatewayUrl)
    setAutoStart(next.autoStart)
  }

  useEffect(() => {
    if (!host.isDesktop || !host.gateway) return
    let active = true
    let unsubscribe: (() => void) | undefined
    mounted.current = true
    const revision = statusRevision.current
    void host.gateway.onStatus(next => {
      if (active) acceptStatus(next)
    }).then(dispose => {
      if (!active) dispose()
      else unsubscribe = dispose
    }).catch(reason => { if (active) setError(safeCode(reason)) })
    void Promise.all([host.gateway.getConfig(), host.gateway.getStatus()]).then(([nextConfig, nextStatus]) => {
      if (!active) return
      acceptConfig(nextConfig)
      // An initial snapshot must not overwrite an event received during loading.
      if (statusRevision.current === revision) acceptStatus(nextStatus)
    }).catch(reason => { if (active) setError(safeCode(reason)) }).finally(() => {
      if (active) setBusy(false)
    })
    return () => {
      active = false
      mounted.current = false
      unsubscribe?.()
    }
  }, [host])

  if (!host.isDesktop || !host.gateway) return null

  const running = !['stopped', 'error'].includes(status.state)
  const locked = busy || running || !config
  const dirty = !!config && (gatewayUrl !== config.gatewayUrl || autoStart !== config.autoStart || accessKey.length > 0)
  const canConnect = !locked && !dirty && !!config?.hasKey && !!gatewayUrl
  const shownError = error ?? result?.code ?? status.code
  const warningClass = 'text-xs rounded-[var(--radius-md)] bg-[var(--color-warning-container)] text-[var(--color-on-warning-container)] p-3'

  async function run(action: () => Promise<void>) {
    if (actionLock.current) return
    actionLock.current = true
    setBusy(true)
    setError(null)
    setResult(null)
    try { await action() } catch (reason) {
      if (mounted.current) setError(safeCode(reason))
    } finally {
      actionLock.current = false
      if (mounted.current) setBusy(false)
    }
  }

  async function transition(action: () => Promise<GatewayStatus>) {
    const revision = statusRevision.current
    const next = await action()
    if (next.generation > latestStatus.current.generation || revision === statusRevision.current) acceptStatus(next)
  }

  return (
    <section aria-labelledby={titleId} className="mt-6">
      <Card radius="xl" surface="low" padding="none" className="p-4 space-y-3">
        <h3 id={titleId} className="flex items-center gap-2 text-sm font-semibold text-[var(--color-text-primary)]">
          <Globe size={16} aria-hidden="true" />{t('settings.gateway.title')}
        </h3>
        <p className="text-xs text-[var(--color-text-secondary)]">{t('settings.gateway.description')}</p>
        <p role="status" className="text-xs text-[var(--color-text-secondary)]">{t(stateKeys[status.state])}</p>
        <Input label={t('settings.gateway.gatewayUrl')} value={gatewayUrl} disabled={locked} size="md"
          aria-describedby={shownError ? errorId : undefined} onChange={event => setGatewayUrl(event.target.value)} />
        <Input label={t('settings.gateway.accessKey')} type="password" autoComplete="new-password" spellCheck={false}
          value={accessKey} disabled={locked} size="md" onChange={event => setAccessKey(event.target.value)}
          aria-describedby={shownError ? errorId : undefined}
          hint={t(config?.hasKey ? 'settings.gateway.keyConfigured' : 'settings.gateway.keyMissing')} />
        <Switch label={t('settings.gateway.autoStart')} checked={autoStart} onChange={setAutoStart} disabled={locked} size="sm" />
        {gatewayUrl.trim().toLowerCase().startsWith('http:') && <p className={warningClass}>{t('settings.gateway.httpWarning')}</p>}
        {config?.credentialStorage === 'memory' && <p className={warningClass}>{t('settings.gateway.memoryWarning')}</p>}
        {dirty && <p className="text-xs text-[var(--color-text-secondary)]">{t('settings.gateway.saveFirst')}</p>}
        <div className="flex flex-wrap gap-2">
          <Button size="sm" variant="secondary" disabled={locked || !dirty} onClick={() => void run(async () => {
            const next = await host.gateway.saveConfig({ gatewayUrl, autoStart, ...(accessKey ? { accessKey } : {}) })
            if (mounted.current) { acceptConfig(next); setAccessKey('') }
          })}>{t('settings.gateway.save')}</Button>
          <Button size="sm" variant="secondary" disabled={locked || !config?.hasKey} onClick={() => void run(async () => {
            const next = await host.gateway.clearKey()
            if (mounted.current) { acceptConfig(next); setAccessKey('') }
          })}>{t('settings.gateway.clearKey')}</Button>
          <Button size="sm" variant="secondary" disabled={!canConnect} icon={<Unplug size={14} aria-hidden="true" />}
            onClick={() => void run(async () => {
              const next = await host.gateway.testConnection()
              if (mounted.current) setResult(next)
              await transition(() => host.gateway.getStatus())
            })}>{t('settings.gateway.test')}</Button>
          <Button size="sm" disabled={!canConnect} icon={<Play size={14} aria-hidden="true" />}
            onClick={() => void run(() => transition(() => host.gateway.start()))}>{t('settings.gateway.start')}</Button>
          <Button size="sm" variant="secondary" disabled={busy || !running || status.state === 'stopping' || status.state === 'testing'}
            icon={<Square size={14} aria-hidden="true" />} onClick={() => void run(() => transition(() => host.gateway.stop()))}>
            {t('settings.gateway.stop')}
          </Button>
        </div>
        {shownError && <p id={errorId} role="alert" className="text-xs text-[var(--color-error)]">{t(errorKeys[safeCode(shownError)])}</p>}
        {result && <dl aria-label={t('settings.gateway.testResults')} className="grid grid-cols-2 gap-2 text-xs text-[var(--color-text-secondary)]">
          {(Object.keys(resultKeys) as Array<keyof typeof resultKeys>).map(key => <div key={key}>
            <dt>{t(resultKeys[key])}</dt><dd>{t(result[key] ? 'settings.gateway.verified' : 'settings.gateway.notVerified')}</dd>
          </div>)}
        </dl>}
      </Card>
    </section>
  )
}
