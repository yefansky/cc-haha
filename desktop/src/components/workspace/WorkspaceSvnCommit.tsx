import { useRef, useState } from 'react'
import { Check } from 'lucide-react'
import { sessionsApi } from '../../api/sessions'
import { useTranslation } from '../../i18n'
import { Button } from '../ui/Button'

export function WorkspaceSvnCommit({ sessionId, workDir, onCommitted }: {
  sessionId: string
  workDir: string
  onCommitted: () => Promise<unknown>
}) {
  const t = useTranslation()
  const storageKey = `workspace.svnCommitDraft:${sessionId}`
  const [message, setMessage] = useState(() => {
    try { return sessionStorage.getItem(storageKey) || '' } catch { return '' }
  })
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const inFlight = useRef(false)
  const updateDraft = (value: string) => {
    setMessage(value)
    try {
      if (value) sessionStorage.setItem(storageKey, value)
      else sessionStorage.removeItem(storageKey)
    } catch { /* The input remains usable when browser storage is unavailable. */ }
  }
  const commit = async () => {
    if (inFlight.current || !message.trim()) return
    inFlight.current = true
    setBusy(true)
    setError('')
    setNotice('')
    try {
      const result = await sessionsApi.commitWorkspaceSvn(sessionId, message.trim())
      if (result.state === 'error') {
        setError(result.error || t('workspace.svnCommitFailed'))
        return
      }
      if (result.state === 'ok') updateDraft('')
      setNotice(t(result.state === 'ok' ? 'workspace.svnCommitSuccess' : 'workspace.svnCommitNoChanges'))
      // Refresh failure must never turn a successful repository commit into a retry prompt.
      await onCommitted().catch(() => {})
    } catch (failure) {
      setError(`${t('workspace.svnCommitFailed')} ${failure instanceof Error ? failure.message : ''}`)
    } finally {
      inFlight.current = false
      setBusy(false)
    }
  }
  return <div className="shrink-0 space-y-2 border-b border-[var(--color-border)] px-3 py-2">
    <textarea
      aria-label={t('workspace.svnCommitMessage')}
      placeholder={t('workspace.svnCommitPlaceholder')}
      value={message} disabled={busy} maxLength={10_000} rows={2}
      onChange={(event) => { updateDraft(event.target.value); setError(''); setNotice('') }}
      onKeyDown={(event) => {
        if (event.key === 'Enter' && (event.ctrlKey || event.metaKey) && !event.nativeEvent.isComposing) {
          event.preventDefault()
          void commit()
        }
      }}
      className="block min-h-14 w-full resize-y rounded-[var(--radius-sm)] border border-[var(--color-border)] bg-[var(--color-surface-container-high)] px-2 py-1.5 text-[12px] text-[var(--color-text-primary)] placeholder:text-[var(--color-text-tertiary)] focus:border-[var(--color-border-focus)] focus:outline-none disabled:opacity-60"
    />
    <Button size="sm" block icon={<Check size={14} />} loading={busy} disabled={!message.trim()} onClick={() => void commit()}>
      {t('workspace.svnCommit')}
    </Button>
    <p title={workDir} className="text-[10px] leading-4 text-[var(--color-text-tertiary)]">{t('workspace.svnCommitScope')}</p>
    {error && <p role="alert" className="break-words text-[11px] text-[var(--color-error)]">{error}</p>}
    {notice && <p role="status" className="text-[11px] text-[var(--color-success)]">{notice}</p>}
  </div>
}
