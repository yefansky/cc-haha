import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as fs from 'fs/promises'
import * as os from 'os'
import * as path from 'path'
import { KsccOAuthService } from '../services/ksccOAuthService.js'
import { ProviderService } from '../services/providerService.js'

let tmpDir = ''
let originalConfigDir: string | undefined
let originalBaseUrl: string | undefined
let originalFetch: typeof fetch

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cc-haha-kscc-test-'))
  originalConfigDir = process.env.CLAUDE_CONFIG_DIR
  originalBaseUrl = process.env.KSCC_BASE_URL
  originalFetch = globalThis.fetch
  process.env.CLAUDE_CONFIG_DIR = tmpDir
  process.env.KSCC_BASE_URL = 'http://kscc.test'
})

afterEach(async () => {
  globalThis.fetch = originalFetch
  if (originalConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR
  else process.env.CLAUDE_CONFIG_DIR = originalConfigDir
  if (originalBaseUrl === undefined) delete process.env.KSCC_BASE_URL
  else process.env.KSCC_BASE_URL = originalBaseUrl
  await fs.rm(tmpDir, { recursive: true, force: true })
})

describe('KsccOAuthService', () => {
  function hangUntilAborted(init?: RequestInit): Promise<Response> {
    return new Promise((_, reject) => {
      const signal = init?.signal
      if (!signal) {
        reject(new Error('Expected an abort signal'))
        return
      }
      const rejectWithReason = () => reject(signal.reason)
      if (signal.aborted) rejectWithReason()
      else signal.addEventListener('abort', rejectWithReason, { once: true })
    })
  }

  it('imports an existing local KSCC login without exposing its token', async () => {
    await fs.writeFile(path.join(tmpDir, 'settings.json'), JSON.stringify({
      env: { KSCC_AUTH_TOKEN: 'local-token', BASE_API: 'http://kscc.test' },
    }))
    const fetchMock = vi.fn(async (input: string | URL) => {
      expect(String(input)).toBe('http://kscc.test/cli/models')
      return Response.json({
        code: 200,
        data: [
          { model: 'kscc-model', modelType: 'text' },
          { model: 'kscc-model-next', modelType: 'text' },
        ],
      })
    })
    globalThis.fetch = fetchMock as typeof fetch

    const result = await new KsccOAuthService().start()

    expect(result).toEqual({ reusedLocalLogin: true })
    const providers = await new ProviderService().listProviders()
    expect(providers.activeId).not.toBeNull()
    expect(providers.providers).toEqual(expect.arrayContaining([
      expect.objectContaining({
        presetId: 'kscc',
        apiKey: 'local-token',
        models: expect.objectContaining({ main: 'kscc-model' }),
        modelCatalog: [
          expect.objectContaining({
            id: 'kscc-model',
            capabilities: ['thinking', 'effort', 'adaptive_thinking', 'xhigh_effort', 'max_effort'],
          }),
          expect.objectContaining({ id: 'kscc-model-next' }),
        ],
      }),
    ]))
    const settings = await new ProviderService().getManagedSettings()
    expect(settings.env).toMatchObject({
      ANTHROPIC_BASE_URL: 'http://kscc.test',
      ANTHROPIC_API_KEY: '',
      ANTHROPIC_AUTH_TOKEN: 'local-token',
    })
    expect(JSON.parse(String(settings.env.CC_HAHA_PROVIDER_MODEL_CAPABILITIES))).toEqual({
      'kscc-model': 'thinking,effort,adaptive_thinking,xhigh_effort,max_effort',
      'kscc-model-next': 'thinking,effort,adaptive_thinking,xhigh_effort,max_effort',
    })
    expect(settings.env.ANTHROPIC_CUSTOM_HEADERS).toBeUndefined()
  })

  it('uses the KSCC QR login endpoint then activates the returned token', async () => {
    const fetchMock = vi.fn(async (input: string | URL) => {
      const url = String(input)
      if (url === 'http://kscc.test/cli/login/url') {
        return Response.json({ code: 200, data: { loginUUID: 'login-id', loginUrl: 'available' } })
      }
      if (url === 'http://kscc.test/cli/login/result?loginUUID=login-id') {
        return Response.json({ data: { status: 'success', sk: 'browser-token' } })
      }
      if (url === 'http://kscc.test/cli/models') {
        return Response.json({ code: 200, data: [{ model: 'browser-model' }] })
      }
      throw new Error(`Unexpected URL: ${url}`)
    })
    globalThis.fetch = fetchMock as typeof fetch
    await expect(new KsccOAuthService().start()).resolves.toEqual({
      authorizeUrl: 'http://kscc.test/l/login-id',
      reusedLocalLogin: false,
    })
    // A restarted desktop sidecar must be able to resume an in-progress browser login.
    await expect(new KsccOAuthService().status()).resolves.toEqual({ loggedIn: true, pending: false, active: true })
  })

  it('falls back to browser authorization when the local KSCC token has expired', async () => {
    await fs.writeFile(path.join(tmpDir, 'settings.json'), JSON.stringify({
      env: { KSCC_AUTH_TOKEN: 'expired-token', BASE_API: 'http://kscc.test' },
    }))
    globalThis.fetch = vi.fn(async (input: string | URL) => {
      const url = String(input)
      if (url === 'http://kscc.test/cli/models') {
        return Response.json({ code: 401 }, { status: 401 })
      }
      if (url === 'http://kscc.test/cli/login/url') {
        return Response.json({ code: 200, data: { loginUUID: 'replacement-login', loginUrl: 'available' } })
      }
      throw new Error(`Unexpected URL: ${url}`)
    }) as typeof fetch

    await expect(new KsccOAuthService().start()).resolves.toEqual({
      authorizeUrl: 'http://kscc.test/l/replacement-login',
      reusedLocalLogin: false,
    })
  })

  it('times out a hanging local-token model lookup instead of blocking login forever', async () => {
    await fs.writeFile(path.join(tmpDir, 'settings.json'), JSON.stringify({
      env: { KSCC_AUTH_TOKEN: 'local-token', BASE_API: 'http://kscc.test' },
    }))
    globalThis.fetch = vi.fn((_input: string | URL, init?: RequestInit) =>
      hangUntilAborted(init)) as typeof fetch

    await expect(new KsccOAuthService({ requestTimeoutMs: 10 }).start())
      .rejects.toThrow('KSCC model lookup timed out after 1s')
    expect(globalThis.fetch).toHaveBeenCalledTimes(1)
  })

  it('times out a hanging login URL request instead of blocking the button forever', async () => {
    globalThis.fetch = vi.fn((_input: string | URL, init?: RequestInit) =>
      hangUntilAborted(init)) as typeof fetch

    await expect(new KsccOAuthService({ requestTimeoutMs: 10 }).start())
      .rejects.toThrow('KSCC login request timed out after 1s')
  })

  it('keeps the timeout active while reading the login response body', async () => {
    globalThis.fetch = vi.fn((_input: string | URL, init?: RequestInit) =>
      Promise.resolve({
        ok: true,
        status: 200,
        json: () => hangUntilAborted(init),
      } as Response)) as typeof fetch

    await expect(new KsccOAuthService({ requestTimeoutMs: 10 }).start())
      .rejects.toThrow('KSCC login request timed out after 1s')
  })

  it('times out a hanging login status poll instead of leaving a permanent pending request', async () => {
    globalThis.fetch = vi.fn((input: string | URL, init?: RequestInit) => {
      if (String(input) === 'http://kscc.test/cli/login/url') {
        return Promise.resolve(Response.json({
          code: 200,
          data: { loginUUID: 'timeout-login', loginUrl: 'available' },
        }))
      }
      return hangUntilAborted(init)
    }) as typeof fetch
    const service = new KsccOAuthService({ requestTimeoutMs: 10 })
    await service.start()

    await expect(service.status())
      .rejects.toThrow('KSCC login status check timed out after 1s')
  })
})
