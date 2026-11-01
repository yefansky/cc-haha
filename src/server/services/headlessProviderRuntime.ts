import { buildProviderManagedEnv, getManagedEnvKeys } from './providerRuntimeEnv.js'
import { buildNetworkEnvironment, loadNetworkSettings } from './networkSettings.js'
import { providerIntegrations } from '../providerIntegrations/index.js'
import { providerRuntimeSnapshots } from '../proxy/runtimeSnapshots.js'
import type { SavedProvider } from '../types/provider.js'

/** A run owns its routing snapshot; the mutable desktop default is never activated. */
export async function createHeadlessProviderRuntime(
  provider: SavedProvider,
  model: string,
  cwd: string,
  inherited: NodeJS.ProcessEnv = process.env,
) {
  const snapshot = structuredClone(provider)
  snapshot.models = { ...snapshot.models, main: model }
  const env = { ...inherited }
  for (const key of [...getManagedEnvKeys(), ...providerIntegrations.managedEnvKeys(),
    'CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_UNIX_SOCKET', 'CLAUDE_CODE_ENTRYPOINT',
    'CC_HAHA_LOCAL_ACCESS_TOKEN', 'CC_HAHA_DESKTOP_SERVER_URL',
    'CLAUDE_CODE_DIAGNOSTICS_FILE', 'CLAUDE_CODE_DEBUG_LOGS_DIR', 'CC_HAHA_TRACE_PROVIDER_ID',
    'CC_HAHA_TRACE_PROVIDER_NAME', 'CC_HAHA_TRACE_PROVIDER_FORMAT']) delete env[key]
  const settings = await loadNetworkSettings({ readOnly: true })
  let server: ReturnType<typeof Bun.serve> | undefined
  let scope: string | undefined
  const needsProxy = (snapshot.apiFormat ?? 'anthropic') !== 'anthropic' || !!snapshot.modelCatalog?.some(entry => entry.transport)
  try {
    if (needsProxy) {
      const { handleProxyRequest } = await import('../proxy/handler.js')
      scope = providerRuntimeSnapshots.create(snapshot)
      const route = `/proxy/scopes/${scope}/v1/messages`
      server = Bun.serve({
        hostname: '127.0.0.1', port: 0,
        fetch(req) {
          const url = new URL(req.url)
          if (url.pathname !== route || req.method !== 'POST') return new Response(null, { status: 404 })
          return handleProxyRequest(req, url, { networkSettings: settings, traceCapture: false })
        },
      })
    }
    Object.assign(env, buildProviderManagedEnv(snapshot, {
      serverPort: server?.port,
      ...(scope ? { proxyPath: `/proxy/scopes/${scope}` } : {}),
    }), providerIntegrations.buildRuntimeEnv(snapshot, cwd), buildNetworkEnvironment(settings, env), {
      CALLER_DIR: cwd, PWD: cwd,
      CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST: '1',
      CC_HAHA_HEADLESS_HOST: '1',
      CLAUDE_CODE_ENABLE_TASKS: '1',
      CLAUDE_ENABLE_STREAM_WATCHDOG: '1',
      CLAUDE_STREAM_FIRST_TOKEN_TIMEOUT_MS: String(settings.aiRequestTimeoutMs),
      CLAUDE_STREAM_IDLE_TIMEOUT_MS: '240000',
      CLAUDE_STREAM_MAX_DURATION_MS: '600000',
      CLAUDE_CODE_DISABLE_NONSTREAMING_FALLBACK: '1',
      CC_HAHA_TRACE_API_CALLS: '0',
      CLAUDE_CODE_SKIP_PROMPT_HISTORY: '1',
      DEBUG: '0', DEBUG_SDK: '0',
      DISABLE_TELEMETRY: '1', DISABLE_ERROR_REPORTING: '1',
    })
    return {
      env,
      // Used only for output redaction, never printed or persisted.
      secrets: [provider.apiKey, scope ?? ''].filter(Boolean),
      dispose() {
        server?.stop(true)
        if (scope) providerRuntimeSnapshots.release(scope)
      },
    }
  } catch (error) {
    server?.stop(true)
    if (scope) providerRuntimeSnapshots.release(scope)
    throw error
  }
}
