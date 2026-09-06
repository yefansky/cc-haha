import type { ProviderBusinessUi } from '../types'
import { KsccLogin } from './KsccLogin'

export const ksccBusinessUi: ProviderBusinessUi = {
  id: 'kscc',
  presetId: 'kscc',
  titleKey: 'settings.kscc.title',
  descriptionKey: 'settings.kscc.subtitle',
  LoginPanel: KsccLogin,
}
