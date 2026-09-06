import type { ProviderIntegration } from '../types.js'
import { SEASUN_GATEWAY } from './protocol.js'

export const seasunIntegration: ProviderIntegration = {
  id: 'seasun', presetId: 'seasun', activateOnAuthorization: false, saveOnlyOnAuthorization: true,
  validateTransport(transport) {
    const suffix = transport.apiFormat === 'openai_responses' ? '/responses' : transport.apiFormat === 'openai_chat' ? '/v1/chat/completions' : '/anthropic/v1/messages'
    if (transport.endpoint !== SEASUN_GATEWAY + suffix) throw new Error('Invalid Seasun model endpoint')
  },
  auth: {
    requiresDesktopCapability: true,
    start: async () => (await import('./auth.js')).seasunAuthService.start(),
    status: async () => (await import('./auth.js')).seasunAuthService.status(),
    complete: async input => (await import('./auth.js')).seasunAuthService.complete(input),
    cancel: async input => (await import('./auth.js')).seasunAuthService.cancel(input),
  },
  buildAuthorizedProvider(authorization, existing) {
    const catalog = authorization.modelCatalog ?? []
    const selected = catalog.some(model => model.id === existing?.models.main) ? existing!.models.main : catalog[0]?.id
    if (!selected) throw new Error('Seasun has no confirmed coding model')
    return { ...existing, name: 'Seasun Token Hub', apiKey: authorization.apiKey, baseUrl: SEASUN_GATEWAY,
      authStrategy: 'api_key', apiFormat: 'openai_responses', runtimeKind: 'anthropic_compatible',
      models: { main: selected, haiku: selected, sonnet: selected, opus: selected }, modelCatalog: catalog,
    }
  },
}
