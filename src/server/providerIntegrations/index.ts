import { ProviderIntegrationRegistry } from './registry.js'
import { ksccIntegration } from './kscc.js'
import { seasunIntegration } from './seasun/index.js'

// Composition root: adding a business does not change the storage/router/runtime frameworks.
export const providerIntegrations = new ProviderIntegrationRegistry([ksccIntegration, seasunIntegration])
