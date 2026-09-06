import type { SavedProvider, ProviderTestStepResult, ProviderModelTransport } from '../types/provider.js'

/** Only enumerated recovery reasons may cross the auth boundary, never remote text. */
export class ProviderLoginError extends Error {
  constructor(public readonly reason: 'timeout') {
    super(reason)
  }
}

export type ProviderLoginStart = { authorizeUrl?: string; reusedLocalLogin: boolean; attemptId?: string; completionSecret?: string; expiresAt?: number }
export type ProviderLoginStatus = {
  loggedIn: boolean; pending: boolean; active: boolean
  phase?: 'idle' | 'awaiting_login' | 'exchanging' | 'connected' | 'expired' | 'cancelled' | 'error'
  providerId?: string
  identityConnected?: boolean
  modelAccess?: 'ready' | 'unassigned' | 'unknown'
  errorCode?: 'login_failed' | 'timeout' | 'invalid_callback' | 'permission_unassigned' | 'cancelled' | 'expired'
  expiresAt?: number
}
export type ProviderLoginAttempt = { attemptId: string; completionSecret: string }
export type ProviderAuthorization = {
  apiKey: string
  baseUrl: string
  modelCatalog: SavedProvider['modelCatalog']
}

export type ProviderIntegration = {
  id: string
  presetId: string
  legacyAuthResources?: readonly string[]
  auth?: {
    requiresDesktopCapability?: boolean
    start(): Promise<ProviderLoginStart>
    status(): Promise<ProviderLoginStatus>
    complete?(input: ProviderLoginAttempt & { callbackUrl: string }): Promise<ProviderLoginStatus>
    cancel?(input: ProviderLoginAttempt): Promise<ProviderLoginStatus>
  }
  /** The business chooses protocol/model configuration; storage owns identity/order. */
  buildAuthorizedProvider?: (
    authorization: ProviderAuthorization,
    existing: SavedProvider | undefined,
  ) => Omit<SavedProvider, 'id' | 'presetId'>
  activateOnAuthorization?: boolean
  saveOnlyOnAuthorization?: boolean
  validateTransport?: (transport: ProviderModelTransport) => void
  managedEnvKeys?: readonly string[]
  buildRuntimeEnv?: (context: { provider: SavedProvider; workDir: string }) => Record<string, string>
  testConnectivity?: (context: { baseUrl: string; apiKey: string; modelId: string }) => Promise<ProviderTestStepResult>
}
