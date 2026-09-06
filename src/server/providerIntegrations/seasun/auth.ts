import { randomBytes, timingSafeEqual } from 'node:crypto'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import * as os from 'node:os'
import type { ProviderAuthorization, ProviderLoginAttempt, ProviderLoginStatus } from '../types.js'
import { exchangeSeasunCallback, SEASUN_GATEWAY, SEASUN_LOGIN } from './protocol.js'

type Attempt = ProviderLoginAttempt & { expiresAt: number; controller: AbortController; used: boolean; committing: boolean; operation?: Promise<ProviderLoginStatus> }
type Options = { now?: () => number; exchange?: typeof exchangeSeasunCallback; save?: (value: ProviderAuthorization) => Promise<{ id: string }> }

export class SeasunAuthService {
  private attempt?: Attempt
  private phase: NonNullable<ProviderLoginStatus['phase']> = 'idle'
  private errorCode?: ProviderLoginStatus['errorCode']
  private expiryTimer?: ReturnType<typeof setTimeout>
  constructor(private readonly options: Options = {}) {}
  private now() { return this.options.now?.() ?? Date.now() }
  private statePath() { return path.join(process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'), 'cc-haha', 'provider-integrations', 'seasun-state.json') }
  private expire() {
    if (this.attempt && !this.attempt.committing && this.now() >= this.attempt.expiresAt && ['awaiting_login', 'exchanging'].includes(this.phase)) {
      this.attempt.controller.abort()
      this.phase = 'expired'
      this.errorCode = 'expired'
    }
  }
  async start() {
    if (this.attempt?.committing) await this.attempt.operation
    this.attempt?.controller.abort()
    this.attempt = { attemptId: randomBytes(24).toString('hex'), completionSecret: randomBytes(32).toString('hex'), expiresAt: this.now() + 600000, controller: new AbortController(), used: false, committing: false }
    this.phase = 'awaiting_login'
    this.errorCode = undefined
    if (this.expiryTimer) clearTimeout(this.expiryTimer)
    this.expiryTimer = setTimeout(() => {
      this.expire()
      if (this.phase === 'expired' && this.attempt) this.attempt.completionSecret = ''
    }, 600000)
    this.expiryTimer.unref?.()
    return { authorizeUrl: SEASUN_LOGIN, reusedLocalLogin: false, attemptId: this.attempt.attemptId, completionSecret: this.attempt.completionSecret, expiresAt: this.attempt.expiresAt }
  }
  private match(input: ProviderLoginAttempt) {
    const current = this.attempt
    const a = Buffer.from(input.completionSecret), b = Buffer.from(current?.completionSecret ?? '')
    if (!current || input.attemptId !== current.attemptId || a.length !== b.length || !timingSafeEqual(a, b)) throw new Error('login_failed')
    return current
  }
  async status(): Promise<ProviderLoginStatus> {
    this.expire()
    const state = await fs.readFile(this.statePath(), 'utf8').then(text => JSON.parse(text)).catch(() => ({}))
    const { ProviderService } = await import('../../services/providerService.js')
    const index = await new ProviderService().listProviders()
    const provider = index.providers.find(value => value.presetId === 'seasun')
    return { loggedIn: !!state.identityConnected, pending: this.phase === 'awaiting_login' || this.phase === 'exchanging',
      active: !!provider && index.activeId === provider.id, phase: this.phase === 'idle' && state.identityConnected ? 'connected' : this.phase,
      identityConnected: !!state.identityConnected, modelAccess: 'unknown',
      providerId: provider?.id, errorCode: this.errorCode, expiresAt: this.attempt?.expiresAt }
  }
  async cancel(input: ProviderLoginAttempt) {
    const attempt = this.match(input)
    if (attempt.committing) return await attempt.operation!
    if (this.phase === 'connected') return this.status()
    attempt.controller.abort()
    this.phase = 'cancelled'
    this.errorCode = 'cancelled'
    if (this.expiryTimer) clearTimeout(this.expiryTimer)
    return this.status()
  }
  async complete(input: ProviderLoginAttempt & { callbackUrl: string }) {
    const attempt = this.match(input)
    this.expire()
    if (attempt.used || this.phase !== 'awaiting_login') return this.status()
    attempt.used = true
    this.phase = 'exchanging'
    attempt.operation = this.exchangeAndSave(attempt, input.callbackUrl)
    return attempt.operation
  }
  private async exchangeAndSave(attempt: Attempt, callbackUrl: string): Promise<ProviderLoginStatus> {
    try {
      const result = await (this.options.exchange ?? exchangeSeasunCallback)(callbackUrl, attempt.controller.signal)
      this.expire()
      if (this.attempt !== attempt || attempt.controller.signal.aborted || this.phase !== 'exchanging') return this.status()
      // Commit owns the race from here: cancel awaits its actual result instead of claiming a rollback.
      attempt.committing = true
      if (result.apiKey && result.modelCatalog.length) {
        const save = this.options.save ?? (async authorization => {
          const { ProviderService } = await import('../../services/providerService.js')
          return new ProviderService().upsertIntegratedProvider('seasun', authorization)
        })
        await save({ apiKey: result.apiKey, baseUrl: SEASUN_GATEWAY, modelCatalog: result.modelCatalog })
      }
      const file = this.statePath()
      await fs.mkdir(path.dirname(file), { recursive: true })
      await fs.writeFile(file, JSON.stringify({ version: 1, identityConnected: true, updatedAt: this.now() }), { mode: 0o600 })
      this.phase = 'connected'
      this.errorCode = undefined
    } catch (error) {
      if (this.attempt === attempt && !attempt.controller.signal.aborted) {
        this.phase = 'error'
        this.errorCode = error instanceof Error && error.message === 'invalid_callback' ? 'invalid_callback' : 'login_failed'
      }
    } finally {
      attempt.committing = false
      attempt.controller.abort()
      if (this.attempt === attempt && this.expiryTimer) clearTimeout(this.expiryTimer)
    }
    return this.status()
  }
}

export const seasunAuthService = new SeasunAuthService()
