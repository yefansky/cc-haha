import { createProviderRequestHeaders } from './registry.js'
import { ksccRequestAdapter } from './kscc.js'

export const applyProviderRequestHeaders = createProviderRequestHeaders([ksccRequestAdapter])
