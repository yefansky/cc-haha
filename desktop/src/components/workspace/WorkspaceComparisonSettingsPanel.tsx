import { useRef, useState } from 'react'
import { ArrowDown, ArrowUp, Plus, Trash2 } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { IconButton } from '@/components/ui/IconButton'
import { useTranslation } from '../../i18n'
import {
  cloneWorkspaceComparisonSettings,
  createDefaultWorkspaceComparisonSettings,
  normalizeWorkspaceComparisonRulePriorities,
  validateWorkspaceComparisonSettings,
  type WorkspaceComparisonRule,
  type WorkspaceComparisonRuleScope,
  type WorkspaceComparisonSettings,
} from './workspaceComparisonSettings'

interface WorkspaceComparisonSettingsPanelProps {
  path: string
  settings: WorkspaceComparisonSettings
  disabledReason?: string | null
  onApply: (settings: WorkspaceComparisonSettings) => void
  onCancel: () => void
}

const scopes: WorkspaceComparisonRuleScope[] = [
  'line', 'keyword', 'identifier', 'number', 'string', 'preprocessor', 'comment', 'operator', 'whitespace',
]

interface WorkspaceComparisonSettingsError {
  message: string
  ruleId?: string
}

const settingsErrorId = 'workspace-comparison-settings-error'

export function WorkspaceComparisonSettingsPanel({
  path,
  settings,
  disabledReason,
  onApply,
  onCancel,
}: WorkspaceComparisonSettingsPanelProps) {
  const t = useTranslation()
  const [draft, setDraft] = useState(() => cloneWorkspaceComparisonSettings(settings))
  const [error, setError] = useState<WorkspaceComparisonSettingsError | null>(null)
  const nextRule = useRef(settings.rules.length + 1)
  const updateRule = (id: string, update: Partial<WorkspaceComparisonRule>) => {
    setDraft((current) => ({
      ...current,
      rules: current.rules.map((rule) => rule.id === id ? { ...rule, ...update } : rule),
    }))
    setError(null)
  }
  const moveRule = (index: number, direction: -1 | 1) => {
    setDraft((current) => {
      const next = [...current.rules]
      const target = index + direction
      if (target < 0 || target >= next.length) return current
      ;[next[index], next[target]] = [next[target]!, next[index]!]
      return { ...current, rules: normalizeWorkspaceComparisonRulePriorities(next) }
    })
  }
  const addRule = () => {
    const sequence = nextRule.current++
    setDraft((current) => ({
      ...current,
      rules: normalizeWorkspaceComparisonRulePriorities([...current.rules, {
        id: `comparison-rule-${sequence}`,
        name: t('workspace.comparisonSettings.rule.defaultName', { number: sequence }),
        enabled: true,
        pattern: 'TODO',
        caseSensitive: true,
        scope: 'line',
        effect: 'ignore',
        priority: 1,
      }]),
    }))
    setError(null)
  }
  const apply = () => {
    const validation = validateWorkspaceComparisonSettings(draft)
    if (validation.state === 'error') {
      setError({ message: validation.message, ruleId: validation.ruleId })
      return
    }
    onApply(cloneWorkspaceComparisonSettings(draft))
  }

  return (
    <section
      role="dialog"
      aria-modal="false"
      aria-labelledby="workspace-comparison-settings-title"
      className="sticky left-0 z-[var(--z-sticky)] min-w-max border-b border-[var(--color-border)] bg-[var(--color-surface-container)] p-3 text-[12px] text-[var(--color-text-primary)] shadow-sm"
    >
      <div className="mb-3 flex items-center gap-3">
        <h3 id="workspace-comparison-settings-title" className="font-semibold">{t('workspace.comparisonSettings.title')}</h3>
        <span className="text-[11px] text-[var(--color-text-tertiary)]">{t('workspace.comparisonSettings.sessionOnly')}</span>
      </div>
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <label className="flex flex-col gap-1">
          <span>{t('workspace.comparisonSettings.profile')}</span>
          <select
            aria-label={t('workspace.comparisonSettings.profile')}
            value={draft.profile}
            onChange={(event) => setDraft((current) => ({ ...current, profile: event.target.value as WorkspaceComparisonSettings['profile'] }))}
            className="rounded border border-[var(--color-border)] bg-[var(--color-code-bg)] px-2 py-1"
          >
            <option value="fast">{t('workspace.comparisonSettings.profile.fast')}</option>
            <option value="balanced">{t('workspace.comparisonSettings.profile.balanced')}</option>
            <option value="precise">{t('workspace.comparisonSettings.profile.precise')}</option>
          </select>
        </label>
        <label className="flex flex-col gap-1">
          <span>{t('workspace.comparisonSettings.language')}</span>
          <select
            aria-label={t('workspace.comparisonSettings.language')}
            value={draft.language}
            onChange={(event) => setDraft((current) => ({ ...current, language: event.target.value as WorkspaceComparisonSettings['language'] }))}
            className="rounded border border-[var(--color-border)] bg-[var(--color-code-bg)] px-2 py-1"
          >
            <option value="text">{t('workspace.comparisonSettings.language.text')}</option>
            <option value="cpp">{t('workspace.comparisonSettings.language.cpp')}</option>
          </select>
        </label>
        <label className="flex items-center gap-2 self-end py-1">
          <input type="checkbox" checked={draft.ignoreWhitespace} onChange={(event) => setDraft((current) => ({ ...current, ignoreWhitespace: event.target.checked }))} />
          {t('workspace.comparisonSettings.ignoreWhitespace')}
        </label>
        <label className="flex items-center gap-2 self-end py-1">
          <input type="checkbox" checked={draft.ignoreCase} onChange={(event) => setDraft((current) => ({ ...current, ignoreCase: event.target.checked }))} />
          {t('workspace.comparisonSettings.ignoreCase')}
        </label>
      </div>
      <div className="mt-3 flex items-center gap-2">
        <strong>{t('workspace.comparisonSettings.rules')}</strong>
        <Button variant="ghost" size="xs" icon={<Plus aria-hidden="true" size={12} />} onClick={addRule}>
          {t('workspace.comparisonSettings.rule.add')}
        </Button>
      </div>
      <div className="mt-1 max-h-48 space-y-1 overflow-auto">
        {draft.rules.map((rule, index) => (
          <div key={rule.id} className="grid grid-cols-[auto_8rem_minmax(10rem,1fr)_8rem_7rem_auto_auto_auto] items-center gap-1 rounded border border-[var(--color-border)] p-1">
            <input
              type="checkbox"
              aria-label={t('workspace.comparisonSettings.rule.enabled', { number: index + 1 })}
              checked={rule.enabled}
              onChange={(event) => updateRule(rule.id, { enabled: event.target.checked })}
            />
            <input aria-label={t('workspace.comparisonSettings.rule.name', { number: index + 1 })} value={rule.name} onChange={(event) => updateRule(rule.id, { name: event.target.value })} className="rounded border border-[var(--color-border)] bg-[var(--color-code-bg)] px-1 py-0.5" />
            <input
              aria-label={t('workspace.comparisonSettings.rule.pattern', { number: index + 1 })}
              aria-invalid={error?.ruleId === rule.id || undefined}
              aria-describedby={error?.ruleId === rule.id ? settingsErrorId : undefined}
              value={rule.pattern}
              onChange={(event) => updateRule(rule.id, { pattern: event.target.value })}
              className="rounded border border-[var(--color-border)] bg-[var(--color-code-bg)] px-1 py-0.5 font-mono"
            />
            <select aria-label={t('workspace.comparisonSettings.rule.scope', { number: index + 1 })} value={rule.scope} onChange={(event) => updateRule(rule.id, { scope: event.target.value as WorkspaceComparisonRuleScope })} className="rounded border border-[var(--color-border)] bg-[var(--color-code-bg)] px-1 py-0.5">
              {scopes.map((scope) => <option key={scope} value={scope}>{t(`workspace.comparisonSettings.scope.${scope}`)}</option>)}
            </select>
            <select aria-label={t('workspace.comparisonSettings.rule.effect', { number: index + 1 })} value={rule.effect} onChange={(event) => updateRule(rule.id, { effect: event.target.value as WorkspaceComparisonRule['effect'] })} className="rounded border border-[var(--color-border)] bg-[var(--color-code-bg)] px-1 py-0.5">
              <option value="important">{t('workspace.comparisonSettings.effect.important')}</option>
              <option value="ignore">{t('workspace.comparisonSettings.effect.ignore')}</option>
            </select>
            <IconButton icon={<ArrowUp aria-hidden="true" />} label={t('workspace.comparisonSettings.rule.up', { number: index + 1 })} size="sm" disabled={index === 0} onClick={() => moveRule(index, -1)} />
            <IconButton icon={<ArrowDown aria-hidden="true" />} label={t('workspace.comparisonSettings.rule.down', { number: index + 1 })} size="sm" disabled={index === draft.rules.length - 1} onClick={() => moveRule(index, 1)} />
            <IconButton icon={<Trash2 aria-hidden="true" />} label={t('workspace.comparisonSettings.rule.delete', { number: index + 1 })} size="sm" onClick={() => { setDraft((current) => ({ ...current, rules: normalizeWorkspaceComparisonRulePriorities(current.rules.filter((candidate) => candidate.id !== rule.id)) })); setError(null) }} />
          </div>
        ))}
      </div>
      {error && <div id={settingsErrorId} role="alert" className="mt-2 text-[var(--color-error)]">{t('workspace.comparisonSettings.compileError', { reason: error.message })}</div>}
      {disabledReason && <div role="status" className="mt-2 text-[var(--color-warning)]">{disabledReason}</div>}
      <div className="mt-3 flex justify-end gap-2">
        <Button variant="ghost" size="sm" onClick={() => { setDraft(createDefaultWorkspaceComparisonSettings(path)); setError(null) }}>{t('workspace.comparisonSettings.defaults')}</Button>
        <Button variant="ghost" size="sm" onClick={onCancel}>{t('workspace.comparisonSettings.cancel')}</Button>
        <Button variant="primary" size="sm" disabled={Boolean(disabledReason)} onClick={apply}>{t('workspace.comparisonSettings.apply')}</Button>
      </div>
    </section>
  )
}
