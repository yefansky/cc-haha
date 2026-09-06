import type { SavedProvider, ProviderModelTransport, ApiFormat } from '../types/provider.js'
import { ProviderModelTransportSchema } from '../types/provider.js'
import { providerIntegrations } from '../providerIntegrations/index.js'

export function resolveProtocolEndpoint(base: string, format: ApiFormat): string {
  const url = new URL(base)
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error('Invalid Provider endpoint')
  const suffix = format === 'openai_responses' ? '/responses' : format === 'openai_chat' ? '/chat/completions' : '/messages'
  const pathname = url.pathname.replace(/\/+$/, '')
  url.pathname = pathname.endsWith(suffix) ? pathname : pathname + (pathname.endsWith('/v1') ? '' : '/v1') + suffix
  return url.toString()
}

export function resolveModelTransport(provider: Pick<SavedProvider, 'modelCatalog'> & { presetId?: string }, model: string): ProviderModelTransport | undefined {
  if (!provider.modelCatalog?.some(entry => entry.transport)) return undefined
  const candidate = provider.modelCatalog.find(entry => entry.id === model)?.transport
  const transport = candidate ? ProviderModelTransportSchema.parse(candidate) : undefined
  if (!transport) throw new Error('Selected model has no confirmed transport')
  const url = new URL(transport.endpoint)
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error('Invalid Provider endpoint')
  providerIntegrations.forPreset(provider.presetId ?? '')?.validateTransport?.(transport)
  return transport
}
