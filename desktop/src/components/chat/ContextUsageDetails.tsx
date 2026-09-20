import type { ContextBreakdownRow } from '../../lib/contextBreakdown'

export type ContextUsageDetailsStatus = 'ready' | 'pending' | 'loading' | 'unavailable'

export type ContextUsageDetailsProps = {
  variant: 'popover' | 'sheet'
  modelLabel: string
  percentageLabel: string
  usedTokens: number
  freeTokens: number
  maxTokens: number
  categories: ContextBreakdownRow[]
  breakdownNote?: string
  mismatchNote?: string
  updatedAtLabel?: string
  estimate?: boolean
  status: ContextUsageDetailsStatus
  labels: {
    title: string
    used: string
    free: string
    window: string
    estimate: string
    pendingDetail: string
    loading: string
    unavailableDetail: string
  }
}

function formatNumber(value: number) {
  return new Intl.NumberFormat().format(value)
}

function formatTokens(value: number, window = false) {
  if (value < 1000) return formatNumber(Math.round(value))
  const thousands = (value / 1000).toFixed(1)
  return `${window ? thousands.replace(/\.0$/, '') : thousands}K`
}

function exactTokens(value: number) {
  return `${formatNumber(value)} Tokens`
}

function CategoryBars({ categories, maxTokens }: {
  categories: ContextBreakdownRow[]
  maxTokens: number
}) {
  if (categories.length === 0) return null
  return (
    <div className="mt-4">
      <div data-testid="context-stacked-bar" className="mb-3 flex h-1.5 overflow-hidden rounded-full bg-[var(--color-surface-hover)]" aria-hidden="true">
        {categories.map(category => (
          <span key={category.name} title={`${category.label}: ${exactTokens(category.tokens)}`}
            className="h-full shrink-0" style={{ backgroundColor: category.color, width: `${maxTokens > 0 ? category.tokens / maxTokens * 100 : 0}%` }} />
        ))}
      </div>
      <div className="mb-2 text-right text-[10px] text-[var(--color-text-tertiary)]">Tokens · 1K = 1,000 Tokens</div>
      <div className="space-y-1">
        {categories.map(category => {
          const row = (
            <span className="flex min-w-0 flex-1 items-center gap-2 py-1 text-xs">
              <span className="h-2.5 w-2.5 shrink-0 rounded-sm" style={{ backgroundColor: category.color }} />
              <span className="min-w-0 flex-1 break-words text-[var(--color-text-primary)]">{category.label}</span>
              <span title={exactTokens(category.tokens)} className="shrink-0 font-mono tabular-nums text-[var(--color-text-secondary)]">{formatTokens(category.tokens)}</span>
            </span>
          )
          return category.items.length || category.hint ? (
            <details key={category.name} className="group">
              <summary className="flex cursor-pointer list-none items-center gap-1 rounded-sm focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--color-brand)]">
                {row}<span aria-hidden="true" className="text-[10px] text-[var(--color-text-tertiary)] group-open:rotate-90">›</span>
              </summary>
              <div className="mb-2 ml-4 border-l border-[var(--color-border)] pl-3 text-[11px] text-[var(--color-text-secondary)]">
                {category.hint && <p className="mb-2 leading-5">{category.hint}</p>}
                {category.items.map((item, index) => (
                  <div key={`${item.name}-${index}`} className="flex items-start justify-between gap-3 py-1">
                    <span className="min-w-0 break-all">{item.name}</span>
                    <span title={exactTokens(item.tokens)} className="shrink-0 font-mono tabular-nums">{formatTokens(item.tokens)}</span>
                  </div>
                ))}
              </div>
            </details>
          ) : <div key={category.name} className="pr-2">{row}</div>
        })}
      </div>
    </div>
  )
}

/**
 * Shared context-usage body for the desktop popover and mobile/H5 sheet.
 * Presentation shells own chrome (portal, sheet header); this only paints data.
 */
export function ContextUsageDetails({
  variant,
  modelLabel,
  percentageLabel,
  usedTokens,
  freeTokens,
  maxTokens,
  categories,
  breakdownNote,
  mismatchNote,
  updatedAtLabel,
  estimate = false,
  status,
  labels,
}: ContextUsageDetailsProps) {
  if (variant === 'sheet') {
    return (
      <div data-testid="context-usage-details" data-variant="sheet">
        <div className="flex items-end justify-between gap-4">
          <div
            className="text-4xl font-bold leading-none text-[var(--color-text-primary)]"
            style={{ fontFamily: 'var(--font-headline)' }}
          >
            {percentageLabel}
          </div>
          {estimate && status === 'ready' && (
            <span className="mb-1 rounded-full border border-[var(--color-border)] px-2 py-1 text-[10px] font-semibold uppercase tracking-[0.08em] text-[var(--color-text-tertiary)]">
              {labels.estimate}
            </span>
          )}
        </div>

        {status === 'ready' ? (
          <div className="mt-5">
            <div className="mb-3 text-right font-mono text-xs text-[var(--color-text-secondary)]" title={`${exactTokens(usedTokens)} / ${exactTokens(maxTokens)}`}>
              ~{formatTokens(usedTokens)} / {maxTokens > 0 ? formatTokens(maxTokens, true) : '--'} Tokens
            </div>
            <div className="grid grid-cols-3 gap-2 font-mono text-xs">
              <div className="rounded-[var(--radius-lg)] bg-[var(--color-surface-container)] p-3">
                <div className="text-[var(--color-text-tertiary)]">{labels.used}</div>
                <div title={exactTokens(usedTokens)} className="mt-1 text-[var(--color-text-primary)]">~{formatTokens(usedTokens)}</div>
              </div>
              <div className="rounded-[var(--radius-lg)] bg-[var(--color-surface-container)] p-3">
                <div className="text-[var(--color-text-tertiary)]">{labels.free}</div>
                <div title={exactTokens(freeTokens)} className="mt-1 text-[var(--color-text-primary)]">~{formatTokens(freeTokens)}</div>
              </div>
              <div className="rounded-[var(--radius-lg)] bg-[var(--color-surface-container)] p-3">
                <div className="text-[var(--color-text-tertiary)]">{labels.window}</div>
                <div title={exactTokens(maxTokens)} className="mt-1 text-[var(--color-text-primary)]">{maxTokens > 0 ? formatTokens(maxTokens, true) : '--'}</div>
              </div>
            </div>
            <CategoryBars categories={categories} maxTokens={maxTokens} />
            {breakdownNote && <p className="mt-3 text-[11px] leading-5 text-[var(--color-text-tertiary)]">{breakdownNote}</p>}
            {mismatchNote && <p className="mt-2 text-[11px] leading-5 text-[var(--color-warning)]">{mismatchNote}</p>}
            {updatedAtLabel && (
              <div className="mt-4 text-[11px] text-[var(--color-text-tertiary)]">
                {updatedAtLabel}
              </div>
            )}
          </div>
        ) : (
          <div className="mt-5 rounded-[var(--radius-lg)] bg-[var(--color-surface-container)] p-4 text-sm leading-6 text-[var(--color-text-secondary)]">
            {status === 'pending'
              ? labels.pendingDetail
              : status === 'loading'
                ? labels.loading
                : labels.unavailableDetail}
          </div>
        )}
      </div>
    )
  }

  return (
    <div data-testid="context-usage-details" data-variant="popover">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="text-xs font-semibold tracking-[0.08em] text-[var(--color-text-tertiary)]">
            {labels.title}
          </div>
          <div className="mt-1 truncate text-base font-bold text-[var(--color-text-primary)]">
            {modelLabel}
          </div>
        </div>
        {/* The headline serif carries the one large number on the panel —
            the same treatment the handoff gives every hero statistic. */}
        <div
          className="shrink-0 text-[27px] font-bold leading-none text-[var(--color-text-primary)]"
          style={{ fontFamily: 'var(--font-headline)' }}
        >
          {percentageLabel}
        </div>
      </div>

      {status === 'ready' ? (
        <>
          <div className="mt-3 flex items-baseline justify-between gap-2 text-xs text-[var(--color-text-secondary)]">
            <span>{labels.used} / {labels.window}</span>
            <span className="font-mono tabular-nums" title={`${exactTokens(usedTokens)} / ${exactTokens(maxTokens)}`}>~{formatTokens(usedTokens)} / {maxTokens > 0 ? formatTokens(maxTokens, true) : '--'} Tokens</span>
          </div>
          <CategoryBars categories={categories} maxTokens={maxTokens} />
            {breakdownNote && <p className="mt-3 text-[11px] leading-5 text-[var(--color-text-tertiary)]">{breakdownNote}</p>}
            {mismatchNote && <p className="mt-2 text-[11px] leading-5 text-[var(--color-warning)]">{mismatchNote}</p>}
          {updatedAtLabel && (
            <div className="mt-4 text-xs text-[var(--color-text-tertiary)]">
              {updatedAtLabel}
              {estimate && (
                <span className="ml-2 inline-flex rounded-full border border-[var(--color-border)] px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-[0.08em]">
                  {labels.estimate}
                </span>
              )}
            </div>
          )}
        </>
      ) : status === 'pending' ? (
        <div className="mt-4 text-sm leading-6 text-[var(--color-text-secondary)]">
          {labels.pendingDetail}
        </div>
      ) : (
        <div className="mt-4 text-sm leading-6 text-[var(--color-text-secondary)]">
          {status === 'loading' ? labels.loading : labels.unavailableDetail}
        </div>
      )}
    </div>
  )
}
