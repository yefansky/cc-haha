import { useState } from 'react'
import { Button } from '@/components/ui/Button'
import { Input } from '@/components/ui/Input'
import { MarkdownRenderer } from '@/components/markdown/MarkdownRenderer'
import { useTranslation } from '@/i18n'
import { getPackagedChangelogHistory } from '@/lib/packagedChangelog'

const PAGE_SIZE = 5

export function ChangelogHistory() {
  const t = useTranslation()
  const [query, setQuery] = useState('')
  const [limit, setLimit] = useState(PAGE_SIZE)
  const history = getPackagedChangelogHistory()
  const search = query.trim().toLocaleLowerCase().replace(/^v(?=\d)/, '')
  const matches = history.filter(entry => `${entry.version}\n${entry.markdown}`.toLocaleLowerCase().includes(search))

  return (
    <section id="changelog-history" tabIndex={-1} aria-labelledby="changelog-history-title" className="mt-4 w-full rounded-[var(--radius-xl)] border border-[var(--color-border)] p-4 focus-visible:ring-2 focus-visible:ring-[var(--color-border-focus)]">
      <h2 id="changelog-history-title" className="text-sm font-semibold text-[var(--color-text-primary)]">{t('update.historyTitle')}</h2>
      <p className="mt-2 text-xs leading-5 text-[var(--color-text-tertiary)]">{t('update.historyHint')}</p>
      <div className="mt-3">
        <Input id="changelog-search" type="search" label={t('update.historySearch')} placeholder={t('update.historySearchPlaceholder')} value={query} onChange={event => { setQuery(event.target.value); setLimit(PAGE_SIZE) }} />
      </div>
      <p aria-live="polite" className="mt-2 text-xs text-[var(--color-text-tertiary)]">{t('update.historyCount', { count: String(matches.length) })}</p>
      <div className="mt-3 space-y-2">
        {matches.slice(0, limit).map((entry, index) => (
          <details key={`${search}:${entry.version}`} open={search || index === 0 ? true : undefined} className="rounded-[var(--radius-lg)] border border-[var(--color-border)] bg-[var(--color-surface-container-low)]">
            <summary className="cursor-pointer rounded-[var(--radius-lg)] px-3 py-3 text-sm text-[var(--color-text-primary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-border-focus)]">
              <span className="font-semibold">{entry.version}</span>
              <time dateTime={entry.date} className="ml-3 text-xs text-[var(--color-text-tertiary)]">{entry.date.slice(0, 10)}</time>
              {entry.source === 'backfilled' && <span className="ml-3 text-xs text-[var(--color-text-tertiary)]">{t('update.historyBackfilled')}</span>}
            </summary>
            <MarkdownRenderer content={entry.markdown} variant="document" className="px-3 pb-3 text-[13px] leading-6 text-[var(--color-text-secondary)] [&_h1]:text-base [&_h2]:text-sm [&_p]:text-[13px] [&_p]:leading-6" />
          </details>
        ))}
      </div>
      {matches.length === 0 && <p className="mt-3 text-sm text-[var(--color-text-secondary)]">{t('update.historyEmpty')}</p>}
      {matches.length > limit && <Button variant="secondary" size="sm" className="mt-3" onClick={() => setLimit(value => value + PAGE_SIZE)}>{t('update.historyMore')}</Button>}
    </section>
  )
}
