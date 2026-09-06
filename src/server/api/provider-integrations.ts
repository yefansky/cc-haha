import { ApiError, errorResponse } from '../middleware/errorHandler.js'
import { providerIntegrations } from '../providerIntegrations/index.js'
import type { ProviderIntegrationRegistry } from '../providerIntegrations/registry.js'
import { ProviderLoginError } from '../providerIntegrations/types.js'
import type { ProviderLoginStatus } from '../providerIntegrations/types.js'
import { matchesDesktopCapability } from '../providerIntegrations/desktopCapability.js'

function projectStatus(result: ProviderLoginStatus) {
  return { loggedIn: result.loggedIn, pending: result.pending, active: result.active,
    phase: result.phase, providerId: result.providerId, identityConnected: result.identityConnected,
    modelAccess: result.modelAccess, errorCode: result.errorCode, expiresAt: result.expiresAt }
}

function hasDesktopCapability(req: Request): boolean {
  return matchesDesktopCapability(req.headers.get('X-CC-Haha-Desktop-Integration'))
}

export async function handleProviderIntegrationsApi(
  req: Request,
  _url: URL,
  segments: string[],
  registry: ProviderIntegrationRegistry = providerIntegrations,
): Promise<Response> {
  const generic = segments[1] === 'provider-integrations'
  const integration = generic
    ? registry.get(segments[2] ?? '')
    : registry.forLegacyAuthResource(segments[1] ?? '')
  const action = segments[generic ? 3 : 2]
  if (!integration?.auth || segments.length > (generic ? 4 : 3)) {
    return Response.json({ error: 'Not Found' }, { status: 404 })
  }
  try {
    if (req.method !== 'GET' && integration.auth.requiresDesktopCapability && !hasDesktopCapability(req)) {
      return Response.json({ error: 'Desktop sign-in capability required' }, { status: 403 })
    }
    if (action === 'start' && req.method === 'POST') {
      const result = await integration.auth.start()
      // Auth implementations retain all credentials; only the presentation contract crosses HTTP.
      return Response.json({ authorizeUrl: result.authorizeUrl, reusedLocalLogin: result.reusedLocalLogin,
        ...(integration.auth.requiresDesktopCapability ? { attemptId: result.attemptId, completionSecret: result.completionSecret, expiresAt: result.expiresAt } : {}) })
    }
    if ((action === undefined || action === 'status') && req.method === 'GET') {
      const result = await integration.auth.status()
      return Response.json(projectStatus(result))
    }
    if ((action === 'complete' || action === 'cancel') && req.method === 'POST' && integration.auth[action]) {
      const raw = await req.text()
      if (raw.length > 40000) return Response.json({ error: 'Invalid sign-in input' }, { status: 400 })
      const input = JSON.parse(raw)
      if (!input || typeof input.attemptId !== 'string' || typeof input.completionSecret !== 'string' ||
        input.attemptId.length > 128 || input.completionSecret.length > 256 ||
        (action === 'complete' && (typeof input.callbackUrl !== 'string' || input.callbackUrl.length > 36000))) {
        return Response.json({ error: 'Invalid sign-in input' }, { status: 400 })
      }
      const result = action === 'complete'
        ? await integration.auth.complete!({ attemptId: input.attemptId, completionSecret: input.completionSecret, callbackUrl: input.callbackUrl })
        : await integration.auth.cancel!({ attemptId: input.attemptId, completionSecret: input.completionSecret })
      return Response.json(projectStatus(result))
    }
    return Response.json({ error: 'Not Found' }, { status: 404 })
  } catch (error) {
    // Hook exceptions may contain remote bodies or credentials. Do not send them
    // through the generic error logger (including ostensibly public ApiErrors).
    if (error instanceof ProviderLoginError && error.reason === 'timeout') {
      return errorResponse(new ApiError(504, 'Provider sign-in request timed out. Try again.', 'PROVIDER_LOGIN_TIMEOUT'))
    }
    return errorResponse(ApiError.internal('Provider sign-in failed. Try again.'))
  }
}
