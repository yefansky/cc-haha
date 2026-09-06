import type { ComponentType } from 'react'
import type { TranslationKey } from '@/i18n/locales/en'

/** Compile-time presentation metadata; each business owns its login workflow. */
export interface ProviderBusinessUi {
  id: string
  presetId: string
  titleKey: TranslationKey
  descriptionKey: TranslationKey
  LoginPanel: ComponentType
}
