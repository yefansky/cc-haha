import { createHash, timingSafeEqual } from 'node:crypto'

export const GATEWAY_FORWARDER_TOKEN_ENV = 'CC_HAHA_GATEWAY_FORWARDER_TOKEN'
export const GATEWAY_FORWARDER_HEADER = 'X-CC-Haha-Gateway-Forwarder'
export const MIN_GATEWAY_FORWARDER_TOKEN_LENGTH = 32

const MAX_GATEWAY_FORWARDER_TOKEN_LENGTH = 512

function configuredGatewayForwarderToken(): string | null {
  const token = process.env[GATEWAY_FORWARDER_TOKEN_ENV]
  if (
    !token ||
    token.length < MIN_GATEWAY_FORWARDER_TOKEN_LENGTH ||
    token.length > MAX_GATEWAY_FORWARDER_TOKEN_LENGTH ||
    /\s/.test(token)
  ) {
    return null
  }
  return token
}

function bearerToken(request: Request): string | null {
  const header = request.headers.get(GATEWAY_FORWARDER_HEADER)
  if (!header?.startsWith('Bearer ')) return null

  const token = header.slice('Bearer '.length)
  if (!token || token.length > MAX_GATEWAY_FORWARDER_TOKEN_LENGTH || /\s/.test(token)) {
    return null
  }
  return token
}

function tokensEqual(actual: string, expected: string): boolean {
  const actualDigest = createHash('sha256').update(actual).digest()
  const expectedDigest = createHash('sha256').update(expected).digest()
  return timingSafeEqual(actualDigest, expectedDigest)
}

export function hasConfiguredGatewayForwarderToken(): boolean {
  return configuredGatewayForwarderToken() !== null
}

export function isGatewayForwarderAuthorized(request: Request): boolean {
  const expected = configuredGatewayForwarderToken()
  const candidate = bearerToken(request)
  return Boolean(expected && candidate && tokensEqual(candidate, expected))
}

function matchesPathPrefix(pathname: string, prefix: string): boolean {
  return pathname === prefix || pathname.startsWith(`${prefix}/`)
}

export function isGatewayForwarderRestrictedPath(pathname: string): boolean {
  return matchesPathPrefix(pathname, '/_gateway') ||
    matchesPathPrefix(pathname, '/api/h5-access') ||
    matchesPathPrefix(pathname, '/sdk')
}

export function shouldRejectGatewayForwarderRequest(
  request: Request,
  pathname: string,
): boolean {
  if (!request.headers.has(GATEWAY_FORWARDER_HEADER)) return false
  return !isGatewayForwarderAuthorized(request) ||
    isGatewayForwarderRestrictedPath(pathname)
}
