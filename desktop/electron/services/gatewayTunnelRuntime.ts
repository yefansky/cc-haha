import { spawn as nodeSpawn, type ChildProcess } from 'node:child_process'
import { StringDecoder } from 'node:string_decoder'
import type { GatewayConfig, GatewaySaveInput, GatewayStatus, GatewayTestResult, GatewayErrorCode } from '../../src/lib/desktopHost/gatewayTypes'

interface Credentials {
  getConfig(): GatewayConfig
  save(input: GatewaySaveInput): GatewayConfig
  clearKey(): GatewayConfig
  getAccessKey(): string | null | undefined
}

interface Options {
  credentials: Credentials
  resolveLocal: () => Promise<{ upstreamUrl: string, forwarderToken: string }>
  resolveExecutable: () => Promise<string> | string
  spawn?: typeof nodeSpawn
  onStatus?: (status: GatewayStatus) => void
}

const codes = new Set<GatewayErrorCode>(['CONFIG_INVALID', 'KEY_REQUIRED', 'KEY_INVALID', 'KEY_REVOKED', 'KEY_IN_USE', 'PROTOCOL_ERROR', 'LOCAL_SERVER_UNAVAILABLE', 'CLIENT_NOT_INSTALLED', 'CONNECTION_FAILED', 'TLS_ERROR', 'STORAGE_ERROR', 'BUSY', 'PROCESS_EXITED'])
const fail = (code: GatewayErrorCode) => Object.assign(new Error(code), { code })
function errorCode(error: unknown, fallback: GatewayErrorCode): GatewayErrorCode {
  const code = (error as { code?: GatewayErrorCode })?.code
  if (code && codes.has(code)) return code
  const message = error instanceof Error ? error.message as GatewayErrorCode : undefined
  return message && codes.has(message) ? message : fallback
}

function origin(value: string, local = false): string {
  try {
    const url = new URL(value)
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash || url.pathname !== '/' || /[\s\x00-\x1f]/.test(value)) throw 0
    if (local && !['127.0.0.1', '[::1]'].includes(url.hostname)) throw 0
    return url.origin
  } catch { throw fail(local ? 'LOCAL_SERVER_UNAVAILABLE' : 'CONFIG_INVALID') }
}

// A resolver may not support cancellation. Race it without allowing its eventual
// result to spawn a process or change a newer generation.
function cancellable<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => reject(fail('PROCESS_EXITED'))
    if (signal.aborted) { abort(); return }
    signal.addEventListener('abort', abort, { once: true })
    work.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort))
  })
}

type Run = {
  generation: number
  controller: AbortController
  child?: ChildProcess
  exited: Promise<void>
  finishExit: () => void
  result: Promise<GatewayTestResult>
  finish: (code?: GatewayErrorCode, online?: boolean) => void
  localReady: boolean
  testing: boolean
}

export class GatewayTunnelRuntime {
  private status: GatewayStatus = { generation: 0, state: 'stopped' }
  private listeners = new Set<(status: GatewayStatus) => void>()
  private desiredRunning = false
  private disposed = false
  private run?: Run
  private serial: Promise<unknown> = Promise.resolve()

  constructor(private readonly options: Options) {
    if (options.onStatus) this.listeners.add(options.onStatus)
  }

  subscribe(handler: (status: GatewayStatus) => void): () => void {
    this.listeners.add(handler)
    return () => { this.listeners.delete(handler) }
  }

  private publish(state: GatewayStatus['state'], code?: GatewayErrorCode) {
    this.status = { generation: this.status.generation, state, ...(code ? { code } : {}) }
    for (const handler of this.listeners) {
      try { handler({ ...this.status }) } catch { /* Observers cannot break lifecycle cleanup. */ }
    }
  }

  async getStatus(): Promise<GatewayStatus> { return { ...this.status } }
  async getConfig(): Promise<GatewayConfig> {
    try {
      const value = this.options.credentials.getConfig()
      return { gatewayUrl: value.gatewayUrl, hasKey: value.hasKey, credentialStorage: value.credentialStorage, autoStart: value.autoStart }
    } catch { throw fail('STORAGE_ERROR') }
  }
  async saveConfig(input: GatewaySaveInput): Promise<GatewayConfig> {
    if (this.run || this.desiredRunning || ['stopping', 'testing'].includes(this.status.state)) throw fail('BUSY')
    origin(input.gatewayUrl)
    if (input.accessKey !== undefined && (!input.accessKey || typeof input.accessKey !== 'string')) throw fail('CONFIG_INVALID')
    try { this.options.credentials.save(input) } catch (error) { throw fail(errorCode(error, 'STORAGE_ERROR')) }
    return this.getConfig()
  }
  async clearKey(): Promise<GatewayConfig> {
    if (this.run || this.desiredRunning || ['stopping', 'testing'].includes(this.status.state)) throw fail('BUSY')
    try { this.options.credentials.clearKey() } catch { throw fail('STORAGE_ERROR') }
    return this.getConfig()
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.serial.then(operation, operation)
    this.serial = result.catch(() => {})
    return result
  }

  async start(): Promise<GatewayStatus> {
    if (this.disposed) throw fail('PROCESS_EXITED')
    if (this.run?.testing || this.status.state === 'testing') throw fail('BUSY')
    if (this.desiredRunning && (this.run || this.status.state !== 'error')) return this.getStatus()
    this.desiredRunning = true
    const generation = ++this.status.generation
    this.publish('connecting')
    return this.enqueue(async () => {
      if (!this.desiredRunning || generation !== this.status.generation) return this.getStatus()
      await this.launch(false, generation)
      return this.getStatus()
    })
  }

  async testConnection(): Promise<GatewayTestResult> {
    if (this.disposed) throw fail('PROCESS_EXITED')
    if (this.desiredRunning || this.run || this.status.state === 'stopping' || this.status.state === 'testing') throw fail('BUSY')
    const generation = ++this.status.generation
    this.publish('testing')
    return this.enqueue(async () => {
      if (generation !== this.status.generation) return { localReady: false, gatewayConnected: false, keyAccepted: false, endToEndVerified: false, code: 'PROCESS_EXITED' }
      const run = await this.launch(true, generation)
      const result = await run.result
      await this.terminate(run)
      if (this.current(run)) {
        this.run = undefined
        this.publish(result.code ? 'error' : 'stopped', result.code)
      }
      return result
    })
  }

  async stop(): Promise<GatewayStatus> {
    this.desiredRunning = false
    ++this.status.generation
    const run = this.run
    run?.controller.abort()
    run?.finish('PROCESS_EXITED')
    this.publish('stopping')
    return this.enqueue(async () => {
      if (run) await this.terminate(run)
      if (this.run === run) this.run = undefined
      // A later start owns its own queued launch, not this stop's state.
      if (!this.desiredRunning) this.publish('stopped')
      return this.getStatus()
    })
  }

  async localServerChanged(): Promise<void> {
    if (!this.desiredRunning || this.disposed) return
    const run = this.run
    const generation = ++this.status.generation
    run?.controller.abort()
    run?.finish('PROCESS_EXITED')
    await this.enqueue(async () => {
      if (run) await this.terminate(run)
      if (this.run === run) this.run = undefined
      if (this.desiredRunning && generation === this.status.generation && !this.disposed) await this.launch(false, generation)
    })
  }

  disposeSync(): void {
    this.disposed = true
    this.desiredRunning = false
    ++this.status.generation
    this.run?.controller.abort()
    this.run?.finish('PROCESS_EXITED')
    try { this.run?.child?.kill('SIGKILL') } catch { /* Process may already be gone. */ }
    this.listeners.clear()
  }

  private current(run: Run) { return this.run === run && this.status.generation === run.generation }

  private async launch(testing: boolean, generation: number): Promise<Run> {
    let finishExit!: () => void
    let finishResult!: (value: GatewayTestResult) => void
    const run: Run = {
      generation, testing, controller: new AbortController(), localReady: false,
      exited: new Promise(resolve => { finishExit = resolve }), finishExit: () => finishExit(),
      result: new Promise(resolve => { finishResult = resolve }),
      finish: (code, online = false) => finishResult({ localReady: run.localReady, gatewayConnected: online || ['KEY_INVALID', 'KEY_REVOKED', 'KEY_IN_USE', 'PROTOCOL_ERROR'].includes(code ?? ''), keyAccepted: online, endToEndVerified: false, ...(code ? { code } : {}) }),
    }
    this.run = run
    this.publish(testing ? 'testing' : 'connecting')
    const timer = setTimeout(() => {
      run.finish('CONNECTION_FAILED')
      run.controller.abort()
      if (this.current(run)) this.publish('error', 'CONNECTION_FAILED')
      void this.terminate(run)
    }, 15_000)
    try {
      const config = await cancellable(this.getConfig(), run.controller.signal)
      const gateway = origin(config.gatewayUrl)
      let key: string | null | undefined
      try { key = this.options.credentials.getAccessKey() } catch { throw fail('STORAGE_ERROR') }
      if (!key) throw fail('KEY_REQUIRED')
      let local: { upstreamUrl: string, forwarderToken: string }
      try { local = await cancellable(Promise.resolve().then(this.options.resolveLocal), run.controller.signal) }
      catch { throw fail('LOCAL_SERVER_UNAVAILABLE') }
      const upstream = origin(local.upstreamUrl, true)
      try {
        const response = await fetch(`${upstream}/health`, { redirect: 'error', signal: run.controller.signal })
        await response.body?.cancel()
        if (!response.ok) throw 0
      } catch { throw fail('LOCAL_SERVER_UNAVAILABLE') }
      run.localReady = true
      let executable: string
      try { executable = await cancellable(Promise.resolve().then(this.options.resolveExecutable), run.controller.signal) } catch { throw fail('CLIENT_NOT_INSTALLED') }
      if (!executable) throw fail('CLIENT_NOT_INSTALLED')
      const secretLine = JSON.stringify({ access_key: key, forwarder_token: local.forwarderToken })
      if (!local.forwarderToken || Buffer.byteLength(secretLine, 'utf8') > 8192) throw fail('CONFIG_INVALID')
      if (!this.current(run) || run.controller.signal.aborted) throw fail('PROCESS_EXITED')
      // Do not inherit developer/provider credentials, Python hooks, or proxy env.
      const env: NodeJS.ProcessEnv = {}
      for (const name of ['SystemRoot', 'WINDIR', 'TEMP', 'TMP', 'TMPDIR', 'LANG']) {
        if (process.env[name]) env[name] = process.env[name]
      }
      const child = (this.options.spawn ?? nodeSpawn)(executable, ['--gateway', gateway, '--upstream', upstream], { shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], env })
      run.child = child
      const decoder = new StringDecoder('utf8')
      let pending = ''
      const fatal = (code: GatewayErrorCode) => {
        run.finish(code)
        if (this.current(run)) this.publish('error', code)
        void this.terminate(run)
      }
      child.on('error', error => fatal((error as NodeJS.ErrnoException).code === 'ENOENT' || (error as NodeJS.ErrnoException).code === 'EACCES' ? 'CLIENT_NOT_INSTALLED' : 'PROCESS_EXITED'))
      child.once('close', () => {
        clearTimeout(timer)
        run.finishExit()
        run.finish('PROCESS_EXITED')
        if (this.current(run) && !testing) {
          this.run = undefined
          this.desiredRunning = false
          if (this.status.state !== 'error') this.publish('error', 'PROCESS_EXITED')
        }
      })
      child.stdout?.on('data', (buffer: Buffer) => {
        if (!this.current(run) || run.controller.signal.aborted) return
        pending += decoder.write(buffer)
        // Bound both a single line and an input burst; never expose raw output.
        if (Buffer.byteLength(pending) > 65536) { fatal('PROTOCOL_ERROR'); return }
        let newline: number
        while ((newline = pending.indexOf('\n')) !== -1) {
          const line = pending.slice(0, newline)
          pending = pending.slice(newline + 1)
          if (Buffer.byteLength(line) > 8192) { fatal('PROTOCOL_ERROR'); return }
          const event = this.parseEvent(line)
          if (!event) { fatal('PROTOCOL_ERROR'); return }
          if (!testing && event.state === 'backoff') clearTimeout(timer)
          if (event.state === 'online') {
            clearTimeout(timer)
            run.finish(undefined, true)
          } else if (event.code || event.state === 'stopped') run.finish(event.code ?? 'PROCESS_EXITED')
          if (!testing) this.publish(event.state, event.code)
          if (event.state === 'error' || event.state === 'stopped') void this.terminate(run)
        }
        if (Buffer.byteLength(pending) > 8192) fatal('PROTOCOL_ERROR')
      })
      child.stderr?.on('data', () => {})
      child.stdin?.on('error', () => fatal('PROCESS_EXITED'))
      if (!child.stdin) throw fail('PROCESS_EXITED')
      child.stdin.write(`${secretLine}\n`, 'utf8')
      // Keep stdin open: the Python contract is a line, not an EOF-delimited blob.
      if (testing) await cancellable(run.result, run.controller.signal)
    } catch (error) {
      const spawnCode = (error as NodeJS.ErrnoException)?.code
      const code = errorCode(error, spawnCode === 'ENOENT' || spawnCode === 'EACCES' || spawnCode === 'ENOEXEC' ? 'CLIENT_NOT_INSTALLED' : 'CONNECTION_FAILED')
      run.finish(code)
      if (this.current(run)) {
        this.publish('error', code)
        if (!testing && code !== 'LOCAL_SERVER_UNAVAILABLE') this.desiredRunning = false
      }
      await this.terminate(run)
      if (!testing && this.run === run) this.run = undefined
    } finally {
      if (testing || !run.child) clearTimeout(timer)
    }
    return run
  }

  private parseEvent(line: string): { state: GatewayStatus['state'], code?: GatewayErrorCode } | undefined {
    try {
      const value = JSON.parse(line)
      if (!value || Array.isArray(value) || typeof value !== 'object' || Object.keys(value).some(key => !['event', 'state', 'attempt', 'retry_delay', 'error_code'].includes(key))) return
      if (value.attempt !== undefined && (!Number.isSafeInteger(value.attempt) || value.attempt < 0)) return
      if (value.retry_delay !== undefined && (typeof value.retry_delay !== 'number' || !Number.isFinite(value.retry_delay) || value.retry_delay < 0 || value.retry_delay > 30)) return
      const name = value.event === 'state' ? value.state : value.event
      const states: Record<string, GatewayStatus['state']> = { connecting: 'connecting', online: 'online', reconnecting: 'backoff', backoff: 'backoff', auth_failed: 'error', terminal_error: 'error', key_in_use: 'backoff', stopped: 'stopped', stopping: 'stopping' }
      if (typeof name !== 'string' || !Object.hasOwn(states, name)) return
      let code: GatewayErrorCode | undefined
      if (value.error_code !== undefined) {
        if (typeof value.error_code !== 'string') return
        code = codes.has(value.error_code) ? value.error_code : 'CONNECTION_FAILED'
      }
      if (name === 'auth_failed') code ??= 'KEY_INVALID'
      if (name === 'key_in_use') code = 'KEY_IN_USE'
      if (name === 'terminal_error') code ??= 'CONNECTION_FAILED'
      return { state: states[name]!, ...(code ? { code } : {}) }
    } catch { return undefined }
  }

  private async terminate(run: Run): Promise<void> {
    run.controller.abort()
    run.finish('PROCESS_EXITED')
    const child = run.child
    if (!child || child.exitCode !== null || child.signalCode !== null) { run.finishExit(); return }
    child.stdin?.destroy()
    try { child.kill('SIGTERM') } catch { /* Already exited. */ }
    const wait = async (ms: number) => {
      let timer!: ReturnType<typeof setTimeout>
      await Promise.race([run.exited, new Promise<void>(resolve => { timer = setTimeout(resolve, ms) })])
      clearTimeout(timer)
    }
    await wait(750)
    if (child.exitCode === null && child.signalCode === null) {
      try { child.kill('SIGKILL') } catch { /* Already exited. */ }
      await wait(750)
    }
  }
}
