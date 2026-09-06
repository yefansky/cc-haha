import type { ProviderBusinessUi } from '../types'
import { SeasunLoginPanel } from './SeasunLoginPanel'

export const seasunBusinessUi: ProviderBusinessUi = {
  id: 'seasun', presetId: 'seasun', titleKey: 'settings.seasun.title',
  descriptionKey: 'settings.seasun.subtitle', LoginPanel: SeasunLoginPanel,
}
