import { useTranslation } from '../../i18n'
import { SettingsPill, SettingsSection } from '../../components/settings/SettingsSection'
import { useBrowserLinkPreference } from '../../lib/browserLinkPreference'

export function BrowserLinkSettings() {
  const t = useTranslation()
  const { preference, setPreference } = useBrowserLinkPreference()
  return <SettingsSection title={t('settings.browserLinks.title')} description={t('settings.browserLinks.description')}>
    <div className="flex flex-wrap gap-2">
      {(['auto', 'in-app', 'system'] as const).map((value) => <SettingsPill
        key={value} selected={preference === value} onClick={() => setPreference(value)}
      >{t(value === 'auto' ? 'settings.browserLinks.auto' : value === 'in-app' ? 'openWith.inAppBrowser' : 'openWith.currentDeviceBrowser')}</SettingsPill>)}
    </div>
    <p className="mt-2 text-sm text-[var(--color-text-secondary)]">{t('settings.browserLinks.autoDescription')}</p>
  </SettingsSection>
}
