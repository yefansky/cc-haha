import { Columns3, LayoutPanelLeft, PanelLeft, PanelRight } from 'lucide-react'

import { SettingsPageHeader, SettingsSection } from '@/components/settings/SettingsSection'
import { SegmentedControl } from '@/components/ui/SegmentedControl'
import { useTranslation } from '../../i18n'
import { useUIStore, type LayoutStyle, type SessionSidebarPlacement } from '../../stores/uiStore'

export function LayoutSettings() {
  const t = useTranslation()
  const layoutStyle = useUIStore((state) => state.layoutStyle)
  const sessionSidebarPlacement = useUIStore((state) => state.sessionSidebarPlacement)
  const setLayoutStyle = useUIStore((state) => state.setLayoutStyle)
  const setSessionSidebarPlacement = useUIStore((state) => state.setSessionSidebarPlacement)

  const layoutItems = [
    {
      value: 'classic',
      label: t('settings.layout.classic'),
      icon: <LayoutPanelLeft size={15} strokeWidth={2} aria-hidden="true" />,
    },
    {
      value: 'vscode',
      label: t('settings.layout.vscode'),
      icon: <Columns3 size={15} strokeWidth={2} aria-hidden="true" />,
    },
  ] satisfies ReadonlyArray<{ value: LayoutStyle; label: string; icon: JSX.Element }>

  const placementItems = [
    {
      value: 'left',
      label: t('settings.layout.sidebarLeft'),
      icon: <PanelLeft size={15} strokeWidth={2} aria-hidden="true" />,
    },
    {
      value: 'right',
      label: t('settings.layout.sidebarRight'),
      icon: <PanelRight size={15} strokeWidth={2} aria-hidden="true" />,
    },
  ] satisfies ReadonlyArray<{ value: SessionSidebarPlacement; label: string; icon: JSX.Element }>

  return (
    <div className="mx-auto w-full max-w-[820px]">
      <SettingsPageHeader
        title={t('settings.layout.title')}
        description={t('settings.layout.description')}
      />

      <SettingsSection
        title={t('settings.layout.modeTitle')}
        description={t('settings.layout.modeDescription')}
      >
        <SegmentedControl
          items={layoutItems}
          value={layoutStyle}
          onChange={setLayoutStyle}
          label={t('settings.layout.modeTitle')}
          appearance="raised"
          layout="fill"
        />
        <div className="mt-3 rounded-[var(--radius-lg)] border border-[var(--color-border)] bg-[var(--color-surface-container-low)] p-4 text-[13px] leading-6 text-[var(--color-text-secondary)]">
          {layoutStyle === 'vscode'
            ? t('settings.layout.vscodeDescription')
            : t('settings.layout.classicDescription')}
        </div>
      </SettingsSection>

      <SettingsSection
        title={t('settings.layout.sidebarTitle')}
        description={t('settings.layout.sidebarDescription')}
      >
        <SegmentedControl
          items={placementItems}
          value={sessionSidebarPlacement}
          onChange={setSessionSidebarPlacement}
          label={t('settings.layout.sidebarTitle')}
          appearance="raised"
          layout="fill"
        />
      </SettingsSection>
    </div>
  )
}
