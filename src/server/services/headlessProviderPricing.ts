import { isHeadlessModelLabel } from './headlessProviderLabels.js'
import type { SavedProvider } from '../types/provider.js'
import { redactHeadlessValue } from '../../utils/headlessRedaction.js'
export { projectHeadlessRunCost } from './headlessProviderCost.js'

type Options = { signal?: AbortSignal; selectProvider?: (reference: string) => Promise<SavedProvider> }
const unknownRates = () => ({ input: null, output: null, cache_read: null, cache_creation: null })

/** No provider-specific price endpoint is inferred from a hostname or model family. */
export async function getHeadlessProviderPricing(reference: string, options: Options = {}) {
  options.signal?.throwIfAborted()
  const select = options.selectProvider ?? (await import('./headlessProviderAuth.js')).selectHeadlessProvider
  const provider = await select(reference)
  options.signal?.throwIfAborted()
  const checkedAt = new Date().toISOString()
  const ids = [...new Set([...(provider.modelCatalog ?? []).map(value => value.id), ...Object.values(provider.models ?? {})])]
    .filter(isHeadlessModelLabel)
  const source = { status: 'unverified' as const, kind: 'not_provided' as const, checked_at: checkedAt, verified_at: null, url: null }
  const result = {
    schema_version: 2,
    provider: reference,
    provider_id: provider.id,
    status: 'unknown' as const,
    currency: null,
    unit: 'per_million_tokens' as const,
    rates: unknownRates(),
    source,
    reason: '未取得此服务商已验证的账户计价；不套用模型厂商、其他客户端或内部估价表，也不猜测价格接口',
    models: ids.map(id => ({ id, status: 'unknown' as const, currency: null, unit: 'per_million_tokens' as const, rates: unknownRates(), source })),
    checked_at: checkedAt,
  }
  return redactHeadlessValue(result, [provider.apiKey, provider.imageGeneration?.apiKey].filter((value): value is string => !!value)) as typeof result
}
