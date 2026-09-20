import { useEffect, useId, useRef, useState } from 'react'
import { useTranslation } from '../../i18n'
import { Modal } from '../ui/Modal'
import { Input } from '../ui/Input'
import { Button } from '../ui/Button'

export function ProjectRenameDialog({ title, onSave, onClose }: {
  title: string
  onSave: (name: string) => Promise<void>
  onClose: () => void
}) {
  const t = useTranslation()
  const [name, setName] = useState(title)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState(false)
  const inFlight = useRef(false)
  const inputId = useId()
  useEffect(() => {
    const input = document.getElementById(inputId)
    if (input instanceof HTMLInputElement) {
      input.focus()
      input.select()
    }
  }, [inputId])
  const close = () => { if (!inFlight.current) onClose() }
  const save = async () => {
    const trimmed = name.trim()
    if (!trimmed || trimmed.length > 80 || inFlight.current) return
    inFlight.current = true
    setSaving(true)
    setError(false)
    try {
      await onSave(trimmed)
      onClose()
    } catch {
      setError(true)
    } finally {
      inFlight.current = false
      setSaving(false)
    }
  }
  return (
    <Modal open title={t('sidebar.renameProject')} onClose={close} width={420}
      footer={<>
        <Button variant="secondary" disabled={saving} onClick={close}>{t('common.cancel')}</Button>
        <Button loading={saving} disabled={!name.trim() || name.trim().length > 80} onClick={() => void save()}>{t('common.save')}</Button>
      </>}
    >
      <Input id={inputId} label={t('sidebar.projectName')} value={name} maxLength={80} disabled={saving}
        hint={t('sidebar.renameProjectHint')}
        error={error ? t('sidebar.renameProjectFailed') : undefined}
        autoFocus onFocus={(event) => event.currentTarget.select()}
        onChange={(event) => { setName(event.target.value); setError(false) }}
        onKeyDown={(event) => {
          if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
            event.preventDefault()
            void save()
          }
        }}
      />
    </Modal>
  )
}
