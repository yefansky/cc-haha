import { randomUUID } from 'node:crypto'
import type { ProviderRequestAdapter } from './registry.js'

export const ksccRequestAdapter: ProviderRequestAdapter = {
  id: 'kscc',
  applyHeaders(headers, env) {
    if (env.CC_HAHA_KSCC_PROTOCOL !== '1') return
    try {
      const metadata = JSON.parse(env.CC_HAHA_KSCC_HEADERS || '{}') as Record<string, unknown>
      for (const [name, value] of Object.entries(metadata)) {
        if (typeof value === 'string') headers.set(name, value)
      }
    } catch {
      // Preserve the existing behavior for malformed host metadata.
    }
    // KSCC creates a new request id per call, not once per process.
    headers.set('X-KSC-REQUEST-ID', randomUUID())
  },
}
