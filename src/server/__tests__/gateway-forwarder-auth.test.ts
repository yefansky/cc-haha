import { afterEach, describe, expect, test } from 'bun:test'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { startServer, stopServerRuntimeForShutdown } from '../index.js'
import {
  GATEWAY_FORWARDER_HEADER,
  GATEWAY_FORWARDER_TOKEN_ENV,
  MIN_GATEWAY_FORWARDER_TOKEN_LENGTH,
  hasConfiguredGatewayForwarderToken,
  isGatewayForwarderAuthorized,
  isGatewayForwarderRestrictedPath,
  shouldRejectGatewayForwarderRequest,
} from '../middleware/gatewayForwarderAuth.js'
import { ProviderService } from '../services/providerService.js'

const originalToken = process.env[GATEWAY_FORWARDER_TOKEN_ENV]
const validToken = 'f'.repeat(MIN_GATEWAY_FORWARDER_TOKEN_LENGTH)

function requestWithToken(token: string, scheme = 'Bearer'): Request {
  return new Request('http://127.0.0.1:3456/api/status', {
    headers: { [GATEWAY_FORWARDER_HEADER]: `${scheme} ${token}` },
  })
}

afterEach(() => {
  if (originalToken === undefined) {
    delete process.env[GATEWAY_FORWARDER_TOKEN_ENV]
  } else {
    process.env[GATEWAY_FORWARDER_TOKEN_ENV] = originalToken
  }
})

describe('gatewayForwarderAuth', () => {
  test('authorizes only the configured dedicated bearer token', () => {
    process.env[GATEWAY_FORWARDER_TOKEN_ENV] = validToken

    expect(hasConfiguredGatewayForwarderToken()).toBe(true)
    expect(isGatewayForwarderAuthorized(requestWithToken(validToken))).toBe(true)
    expect(isGatewayForwarderAuthorized(requestWithToken(`${validToken}x`))).toBe(false)
    expect(isGatewayForwarderAuthorized(requestWithToken(validToken, 'Basic'))).toBe(false)
    expect(isGatewayForwarderAuthorized(new Request('http://127.0.0.1:3456/api/status')))
      .toBe(false)
  })

  test('rejects missing, short, or whitespace-containing configuration values', () => {
    for (const token of [
      undefined,
      'f'.repeat(MIN_GATEWAY_FORWARDER_TOKEN_LENGTH - 1),
      `${validToken} suffix`,
    ]) {
      if (token === undefined) {
        delete process.env[GATEWAY_FORWARDER_TOKEN_ENV]
      } else {
        process.env[GATEWAY_FORWARDER_TOKEN_ENV] = token
      }

      expect(hasConfiguredGatewayForwarderToken()).toBe(false)
      expect(isGatewayForwarderAuthorized(requestWithToken(validToken))).toBe(false)
    }
  })

  test('matches only the permanent forwarder deny prefixes', () => {
    for (const pathname of [
      '/_gateway',
      '/_gateway/client-config',
      '/_local/gateway',
      '/_local/gateway/state',
      '/api/h5-access',
      '/api/h5-access/verify',
      '/sdk',
      '/sdk/session-1',
    ]) {
      expect(isGatewayForwarderRestrictedPath(pathname)).toBe(true)
    }

    for (const pathname of [
      '/',
      '/api/status',
      '/api/h5-accessibility',
      '/sdk-tools',
      '/gateway',
    ]) {
      expect(isGatewayForwarderRestrictedPath(pathname)).toBe(false)
    }
  })

  test('rejects restricted paths whenever the forwarder header is present', () => {
    process.env[GATEWAY_FORWARDER_TOKEN_ENV] = validToken
    const validRequest = requestWithToken(validToken)
    const invalidRequest = requestWithToken('wrong-token')
    const missingRequest = new Request('http://127.0.0.1:3456/api/status')

    for (const pathname of [
      '/_gateway/client-config',
      '/_local/gateway',
      '/_local/gateway/state',
      '/api/h5-access/verify',
      '/sdk/session-1',
    ]) {
      expect(shouldRejectGatewayForwarderRequest(validRequest, pathname)).toBe(true)
      expect(shouldRejectGatewayForwarderRequest(invalidRequest, pathname)).toBe(true)
      expect(shouldRejectGatewayForwarderRequest(missingRequest, pathname)).toBe(false)
    }

    expect(shouldRejectGatewayForwarderRequest(validRequest, '/api/status')).toBe(false)
    expect(shouldRejectGatewayForwarderRequest(invalidRequest, '/api/status')).toBe(true)
    expect(shouldRejectGatewayForwarderRequest(missingRequest, '/api/status')).toBe(false)
  })

  test('enforces the forwarder boundary through the real server request path', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'gateway-forwarder-auth-'))
    const h5DistDir = path.join(tmpDir, 'dist')
    const originalConfigDir = process.env.CLAUDE_CONFIG_DIR
    const originalH5DistDir = process.env.CLAUDE_H5_DIST_DIR
    const originalServerAuthRequired = process.env.SERVER_AUTH_REQUIRED
    const originalPort = ProviderService.getServerPort()
    let server: ReturnType<typeof Bun.serve> | undefined

    try {
      process.env.CLAUDE_CONFIG_DIR = tmpDir
      process.env.CLAUDE_H5_DIST_DIR = h5DistDir
      process.env[GATEWAY_FORWARDER_TOKEN_ENV] = validToken
      delete process.env.SERVER_AUTH_REQUIRED
      await fs.mkdir(h5DistDir, { recursive: true })
      await fs.writeFile(
        path.join(h5DistDir, 'index.html'),
        '<!doctype html><html><body>Gateway H5 Shell</body></html>',
        'utf-8',
      )

      server = startServer(0, '127.0.0.1')
      const baseUrl = `http://127.0.0.1:${server.port}`
      const validHeaders = {
        [GATEWAY_FORWARDER_HEADER]: `Bearer ${validToken}`,
      }

      const statusResponse = await fetch(`${baseUrl}/api/status`, {
        headers: validHeaders,
      })
      expect(statusResponse.status).toBe(200)
      const statusText = await statusResponse.text()
      expect(statusText).not.toContain(validToken)
      expect([...statusResponse.headers.values()].join('\n')).not.toContain(validToken)

      const shellResponse = await fetch(`${baseUrl}/`, { headers: validHeaders })
      expect(shellResponse.status).toBe(200)
      await expect(shellResponse.text()).resolves.toContain('Gateway H5 Shell')

      for (const headers of [
        { 'X-Forwarded-For': '203.0.113.10' },
        { [GATEWAY_FORWARDER_HEADER]: 'Bearer wrong-token' },
      ]) {
        const response = await fetch(`${baseUrl}/api/status`, { headers })
        expect(response.status).toBe(403)
      }

      for (const pathname of [
        '/_gateway/client-config',
      '/_local/gateway',
      '/_local/gateway/state',
        '/api/h5-access/verify',
        '/sdk/session-1',
      ]) {
        for (const token of [validToken, 'wrong-token']) {
          const response = await fetch(`${baseUrl}${pathname}`, {
            headers: { [GATEWAY_FORWARDER_HEADER]: `Bearer ${token}` },
          })
          expect(response.status).toBe(403)
          const body = await response.text()
          expect(body).not.toContain(token)
        }
      }
    } finally {
      await stopServerRuntimeForShutdown({ waitForCli: false })
      await server?.stop(true)
      ProviderService.setServerPort(originalPort)
      if (originalConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR
      else process.env.CLAUDE_CONFIG_DIR = originalConfigDir
      if (originalH5DistDir === undefined) delete process.env.CLAUDE_H5_DIST_DIR
      else process.env.CLAUDE_H5_DIST_DIR = originalH5DistDir
      if (originalServerAuthRequired === undefined) delete process.env.SERVER_AUTH_REQUIRED
      else process.env.SERVER_AUTH_REQUIRED = originalServerAuthRequired
      await fs.rm(tmpDir, {
        recursive: true,
        force: true,
        maxRetries: 5,
        retryDelay: 50,
      })
    }
  })
})
