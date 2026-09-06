import { useTranslation } from '@/i18n'
import { providerBusinesses } from '@/providerBusinesses/registry'
import type { ProviderBusinessUi } from '@/providerBusinesses/types'

export function ProviderBusinessSections({
  businesses = providerBusinesses,
}: { businesses?: readonly ProviderBusinessUi[] }) {
  const t = useTranslation()
  return businesses.map(({ id, titleKey, descriptionKey, LoginPanel }) => (
    <section
      key={id}
      aria-label={t(titleKey)}
      className="mb-3 rounded-lg border border-[var(--color-border-separator)] bg-[var(--color-surface)] px-4 py-3"
    >
      <div className="mb-2">
        <h3 className="text-sm font-semibold text-[var(--color-text-primary)]">{t(titleKey)}</h3>
        <p className="text-xs text-[var(--color-text-tertiary)]">{t(descriptionKey)}</p>
      </div>
      <LoginPanel />
    </section>
  ))
}
