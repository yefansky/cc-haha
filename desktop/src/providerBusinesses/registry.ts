import { ksccBusinessUi } from './kscc/registration'
import { seasunBusinessUi } from './seasun/registration'
import type { ProviderBusinessUi } from './types'

// Only bundled, explicitly imported businesses can contribute settings UI.
export const providerBusinesses: readonly ProviderBusinessUi[] = [ksccBusinessUi, seasunBusinessUi]
