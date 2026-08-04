import * as fs from 'fs/promises'
import * as os from 'os'
import * as path from 'path'
import { ProviderService } from './providerService.js'
import type { ProviderModelCatalogEntry } from '../types/provider.js'

const DEFAULT_KSCC_BASE_URL = 'http://120.92.138.34'
const LOGIN_TTL_MS = 5 * 60 * 1000

type LoginSession = {
  baseUrl: string
  loginUUID: string
  createdAt: number
}

type KsccModelResponse = {
  code?: number
  data?: Array<{ model?: string; modelType?: string }>
  msg?: string
}

const KSCC_MODEL_CAPABILITIES: ProviderModelCatalogEntry['capabilities'] = [
  'thinking',
  'effort',
  'adaptive_thinking',
  'xhigh_effort',
  'max_effort',
]

export type KsccLoginStatus = {
  loggedIn: boolean
  pending: boolean
  active: boolean
}

export class KsccOAuthService {
  private session: LoginSession | null = null
  private providerService = new ProviderService()

  private baseUrl(): string {
    const value = process.env.KSCC_BASE_URL || DEFAULT_KSCC_BASE_URL
    return value.replace(/\/+$/, '')
  }

  private claudeSettingsPath(): string {
    const configDir = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude')
    return path.join(configDir, 'settings.json')
  }

  private pendingLoginPath(): string {
    const configDir = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude')
    return path.join(configDir, 'kscc-oauth-pending.json')
  }

  private async savePendingLogin(session: LoginSession | null): Promise<void> {
    const filePath = this.pendingLoginPath()
    if (!session) {
      await fs.rm(filePath, { force: true })
      return
    }
    await fs.mkdir(path.dirname(filePath), { recursive: true })
    await fs.writeFile(filePath, JSON.stringify(session), 'utf8')
  }

  private async pendingLogin(): Promise<LoginSession | null> {
    if (this.session) return this.session
    try {
      const parsed = JSON.parse(await fs.readFile(this.pendingLoginPath(), 'utf8')) as Partial<LoginSession>
      if (
        typeof parsed.baseUrl !== 'string' ||
        typeof parsed.loginUUID !== 'string' ||
        typeof parsed.createdAt !== 'number'
      ) return null
      this.session = {
        baseUrl: new URL(parsed.baseUrl).toString().replace(/\/+$/, ''),
        loginUUID: parsed.loginUUID,
        createdAt: parsed.createdAt,
      }
      return this.session
    } catch {
      return null
    }
  }

  private async localKsccToken(): Promise<{ token: string; baseUrl: string } | null> {
    try {
      const raw = await fs.readFile(this.claudeSettingsPath(), 'utf8')
      const settings = JSON.parse(raw) as {
        env?: { KSCC_AUTH_TOKEN?: unknown; BASE_API?: unknown }
        BASE_API?: unknown
      }
      const token = settings.env?.KSCC_AUTH_TOKEN
      if (typeof token !== 'string' || !token.trim()) return null
      const configuredBaseUrl = typeof settings.env?.BASE_API === 'string'
        ? settings.env.BASE_API
        : typeof settings.BASE_API === 'string'
          ? settings.BASE_API
          : this.baseUrl()
      return { token, baseUrl: new URL(configuredBaseUrl).toString().replace(/\/+$/, '') }
    } catch {
      return null
    }
  }

  private async fetchModels(token: string, baseUrl: string): Promise<ProviderModelCatalogEntry[]> {
    const response = await fetch(`${baseUrl}/cli/models`, {
      headers: {
        Authorization: `Bearer ${encodeURIComponent(token)}`,
        'content-type': 'application/json',
        client: 'kscc-cli',
      },
    })
    if (!response.ok) throw new Error(`KSCC model lookup failed (${response.status})`)
    const payload = await response.json() as KsccModelResponse
    if (payload.code === 401) throw new Error('KSCC authorization expired')
    const models = (payload.data ?? []).flatMap((item) => {
      const id = item.model?.trim()
      if (!id) return []
      return [{
        id,
        name: id,
        ...(item.modelType ? { description: item.modelType } : {}),
        capabilities: [...KSCC_MODEL_CAPABILITIES],
      }]
    })
    if (models.length === 0) throw new Error(payload.msg || 'KSCC returned no available models')
    return models
  }

  private async activate(token: string, baseUrl: string): Promise<void> {
    const models = await this.fetchModels(token, baseUrl)
    await this.providerService.upsertKsccProvider({ apiKey: token, baseUrl, modelCatalog: models })
    this.session = null
    await this.savePendingLogin(null)
  }

  async start(): Promise<{ authorizeUrl?: string; reusedLocalLogin: boolean }> {
    const local = await this.localKsccToken()
    if (local) {
      try {
        await this.activate(local.token, local.baseUrl)
        return { reusedLocalLogin: true }
      } catch {
        // A stale local token should fall through to the browser authorization
        // flow, so users always retain a self-service recovery path.
      }
    }

    const baseUrl = this.baseUrl()
    const response = await fetch(`${baseUrl}/cli/login/url`, {
      headers: { 'content-type': 'application/json' },
    })
    if (!response.ok) throw new Error(`KSCC login request failed (${response.status})`)
    const payload = await response.json() as {
      code?: number
      data?: { loginUUID?: string; loginUrl?: string }
      msg?: string
    }
    const loginUUID = payload.data?.loginUUID
    if (payload.code !== 200 || !loginUUID || !payload.data?.loginUrl) {
      throw new Error(payload.msg || 'KSCC did not return a login URL')
    }
    this.session = { baseUrl, loginUUID, createdAt: Date.now() }
    await this.savePendingLogin(this.session)
    return {
      authorizeUrl: new URL(`/l/${encodeURIComponent(loginUUID)}`, `${baseUrl}/`).toString(),
      reusedLocalLogin: false,
    }
  }

  async status(): Promise<KsccLoginStatus> {
    const { providers, activeId } = await this.providerService.listProviders()
    const provider = providers.find((item) => item.presetId === 'kscc')
    if (provider) return { loggedIn: true, pending: false, active: activeId === provider.id }

    const session = await this.pendingLogin()
    if (!session || Date.now() - session.createdAt > LOGIN_TTL_MS) {
      this.session = null
      await this.savePendingLogin(null)
      return { loggedIn: false, pending: false, active: false }
    }
    const url = new URL(`${session.baseUrl}/cli/login/result`)
    url.searchParams.set('loginUUID', session.loginUUID)
    const response = await fetch(url, { headers: { 'content-type': 'application/json' } })
    if (!response.ok) throw new Error(`KSCC login status check failed (${response.status})`)
    const payload = await response.json() as {
      data?: { status?: string; statusDesc?: string; sk?: string }
    }
    if (payload.data?.status === 'success' && payload.data.sk) {
      await this.activate(payload.data.sk, session.baseUrl)
      return { loggedIn: true, pending: false, active: true }
    }
    if (payload.data?.statusDesc) {
      this.session = null
      await this.savePendingLogin(null)
      throw new Error(payload.data.statusDesc)
    }
    return { loggedIn: false, pending: true, active: false }
  }
}

export const ksccOAuthService = new KsccOAuthService()
