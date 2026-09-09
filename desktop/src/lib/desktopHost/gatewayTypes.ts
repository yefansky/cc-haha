export const GATEWAY_ERROR_CODES = [
  'CONFIG_INVALID', 'KEY_REQUIRED', 'KEY_INVALID', 'KEY_REVOKED', 'KEY_IN_USE',
  'PROTOCOL_ERROR', 'LOCAL_SERVER_UNAVAILABLE', 'CLIENT_NOT_INSTALLED',
  'CONNECTION_FAILED', 'TLS_ERROR', 'STORAGE_ERROR', 'BUSY', 'PROCESS_EXITED',
] as const

export type GatewayErrorCode = typeof GATEWAY_ERROR_CODES[number]
export type GatewayConfig = {
  gatewayUrl: string
  hasKey: boolean
  credentialStorage: 'encrypted' | 'memory' | 'none'
  autoStart: boolean
}
export type GatewaySaveInput = {
  gatewayUrl: string
  accessKey?: string
  autoStart?: boolean
}
export type GatewayStatus = {
  generation: number
  state: 'stopped' | 'testing' | 'connecting' | 'online' | 'backoff' | 'error' | 'stopping'
  code?: GatewayErrorCode
}
export type GatewayTestResult = {
  localReady: boolean
  gatewayConnected: boolean
  keyAccepted: boolean
  endToEndVerified: boolean
  code?: GatewayErrorCode
}
export type GatewayHost = {
  getConfig(): Promise<GatewayConfig>
  saveConfig(input: GatewaySaveInput): Promise<GatewayConfig>
  clearKey(): Promise<GatewayConfig>
  testConnection(): Promise<GatewayTestResult>
  start(): Promise<GatewayStatus>
  stop(): Promise<GatewayStatus>
  getStatus(): Promise<GatewayStatus>
  onStatus(handler: (status: GatewayStatus) => void): Promise<() => void>
}

const record = (value: unknown): Record<string, unknown> =>
  typeof value === 'object' && value !== null ? value as Record<string, unknown> : {}
const errorCode = (value: unknown): { code?: GatewayErrorCode } => value === undefined ? {} : {
  code: GATEWAY_ERROR_CODES.includes(value as GatewayErrorCode) ? value as GatewayErrorCode : 'CONNECTION_FAILED',
}

export function parseGatewayConfig(value: unknown): GatewayConfig {
  const data = record(value)
  let gatewayUrl = ''
  if (typeof data.gatewayUrl === 'string' && data.gatewayUrl.length <= 2048) {
    try {
      const url = new URL(data.gatewayUrl)
      if (/^https?:$/.test(url.protocol) && data.gatewayUrl === url.origin) gatewayUrl = url.origin
    } catch { /* Invalid configuration is never reflected into the renderer. */ }
  }
  return {
    gatewayUrl,
    hasKey: data.hasKey === true,
    credentialStorage: data.credentialStorage === 'encrypted' || data.credentialStorage === 'memory' ? data.credentialStorage : 'none',
    autoStart: data.autoStart === true,
  }
}

export function parseGatewayStatus(value: unknown): GatewayStatus {
  const data = record(value)
  const states = ['stopped', 'testing', 'connecting', 'online', 'backoff', 'error', 'stopping']
  if (!Number.isSafeInteger(data.generation) || (data.generation as number) < 0 || !states.includes(data.state as string)) {
    return { generation: 0, state: 'error', code: 'CONNECTION_FAILED' }
  }
  return { generation: data.generation as number, state: data.state as GatewayStatus['state'], ...errorCode(data.code) }
}

export function parseGatewayTestResult(value: unknown): GatewayTestResult {
  const data = record(value)
  return {
    localReady: data.localReady === true,
    gatewayConnected: data.gatewayConnected === true,
    keyAccepted: data.keyAccepted === true,
    endToEndVerified: data.endToEndVerified === true,
    ...errorCode(data.code),
  }
}
