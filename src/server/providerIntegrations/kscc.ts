import { ApiError } from '../middleware/errorHandler.js'
import type { ProviderIntegration } from './types.js'
import { ProviderLoginError } from './types.js'
import type { ProviderTestStepResult } from '../types/provider.js'
import { buildKsccRuntimeEnv, buildKsccTestRequest, KSCC_HEADERS_ENV_KEY, KSCC_PROTOCOL_ENV_KEY } from '../services/ksccProtocol.js'
import { getNetworkProxyFetchOptions, loadNetworkSettings } from '../services/networkSettings.js'

export const ksccIntegration: ProviderIntegration = {
  id: 'kscc',
  presetId: 'kscc',
  legacyAuthResources: ['kscc-oauth'],
  auth: {
    // Lazy imports keep business auth out of ProviderService's initialization graph.
    start: () => runKsccAuth('start'),
    status: () => runKsccAuth('status'),
  },
  activateOnAuthorization: true,
  buildAuthorizedProvider(input, existing) {
    const ids = new Set(input.modelCatalog?.map(model => model.id) ?? [])
    const model = existing && ids.has(existing.models.main)
      ? existing.models.main
      : input.modelCatalog?.find(value => value.id.trim())?.id
    if (!model) throw ApiError.badRequest('KSCC did not return any available models')
    return {
      ...(existing ?? {
        toolSearchEnabled: true,
        notes: 'Authorized through KSCC enterprise sign-in',
      }),
      name: 'KSCC',
      apiKey: input.apiKey,
      authStrategy: 'auth_token_empty_api_key',
      baseUrl: input.baseUrl,
      apiFormat: 'anthropic',
      runtimeKind: 'anthropic_compatible',
      models: { main: model, haiku: model, sonnet: model, opus: model },
      modelCatalog: input.modelCatalog,
    }
  },
  managedEnvKeys: [KSCC_PROTOCOL_ENV_KEY, KSCC_HEADERS_ENV_KEY],
  buildRuntimeEnv: ({ workDir }) => buildKsccRuntimeEnv(workDir),
  testConnectivity: ({ baseUrl, apiKey, modelId }) => testKsccConnectivity(baseUrl, apiKey, modelId),
}

async function runKsccAuth<T extends 'start' | 'status'>(action: T): Promise<Awaited<ReturnType<NonNullable<ProviderIntegration['auth']>[T]>>> {
  const { ksccOAuthService, KsccRequestTimeoutError } = await import('../services/ksccOAuthService.js')
  try {
    return await ksccOAuthService[action]() as Awaited<ReturnType<NonNullable<ProviderIntegration['auth']>[T]>>
  } catch (error) {
    if (error instanceof KsccRequestTimeoutError) throw new ProviderLoginError('timeout')
    throw error
  }
}

async function testKsccConnectivity(
  baseUrl: string,
  apiKey: string,
  modelId: string,
): Promise<ProviderTestStepResult> {
  const start = Date.now()
  const networkSettings = await loadNetworkSettings()
  const request = buildKsccTestRequest(baseUrl, apiKey, modelId)
  try {
    const response = await fetch(request.url, {
      method: 'POST',
      headers: request.headers,
      body: JSON.stringify(request.body),
      signal: AbortSignal.timeout(networkSettings.aiRequestTimeoutMs),
      ...getNetworkProxyFetchOptions(networkSettings, request.url),
    })
    const latencyMs = Date.now() - start
    const responseText = await response.text().catch(() => '')
    if (!response.ok) {
      let error = `HTTP ${response.status}`
      try {
        const parsed = JSON.parse(responseText) as { error?: { message?: string } }
        error = parsed.error?.message || error
      } catch {
        if (responseText.trim()) error = responseText.trim().slice(0, 200)
      }
      return { success: false, latencyMs, error, modelUsed: modelId, httpStatus: response.status }
    }

    if (!responseText.includes('"type":"message_start"')) {
      return {
        success: false,
        latencyMs,
        error: 'KSCC returned 200 but no valid message stream',
        modelUsed: modelId,
        httpStatus: response.status,
      }
    }
    return { success: true, latencyMs, modelUsed: modelId, httpStatus: response.status }
  } catch (err: unknown) {
    const latencyMs = Date.now() - start
    if (err instanceof DOMException && err.name === 'TimeoutError') {
      return {
        success: false,
        latencyMs,
        error: `Request timed out (${Math.round(networkSettings.aiRequestTimeoutMs / 1000)}s)`,
        modelUsed: modelId,
      }
    }
    return {
      success: false,
      latencyMs,
      error: err instanceof Error ? err.message : String(err),
      modelUsed: modelId,
    }
  }
}
