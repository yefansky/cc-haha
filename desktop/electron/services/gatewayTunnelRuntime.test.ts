import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process'
import { createServer, type Server } from 'node:http'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { GatewayTunnelRuntime } from './gatewayTunnelRuntime'
import type { GatewayConfig, GatewaySaveInput, GatewayStatus } from '../../src/lib/desktopHost/gatewayTypes'

const secret = 'test-only-key-秘密'
const token = 'test-only-forwarder'
const online = `process.stdout.write(JSON.stringify({event:'state',state:'online'})+'\\n')`
const stdinProgram = `
let input = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', chunk => {
  input += chunk
  if (!input.includes('\\n')) return
  const value = JSON.parse(input.slice(0,input.indexOf('\\n')))
  if (value.access_key !== ${JSON.stringify(secret)} || value.forwarder_token !== ${JSON.stringify(token)}) process.exit(9)
  ${online}
})
setInterval(() => {}, 1000)
`

class MemoryCredentials {
  key: string | undefined = secret
  config: GatewayConfig = { gatewayUrl: 'http://127.0.0.1:9999', hasKey: true, credentialStorage: 'memory', autoStart: false }
  getConfig() { return { ...this.config, hasKey: !!this.key } }
  getAccessKey() { return this.key }
  save(input: GatewaySaveInput) {
    this.config.gatewayUrl = input.gatewayUrl
    if (input.autoStart !== undefined) this.config.autoStart = input.autoStart
    if (input.accessKey !== undefined) this.key = input.accessKey
    return this.getConfig()
  }
  clearKey() { this.key = undefined; return this.getConfig() }
}

async function until(predicate: () => boolean | Promise<boolean>) {
  const deadline = Date.now() + 4000
  while (!(await predicate())) {
    if (Date.now() > deadline) throw new Error('condition timed out')
    await new Promise(resolve => setTimeout(resolve, 10))
  }
}

describe('GatewayTunnelRuntime real child boundary', () => {
  let server: Server
  let upstream: string
  let credentials: MemoryCredentials
  let runtimes: GatewayTunnelRuntime[]
  let children: ChildProcess[]
  let calls: { executable: string, args: readonly string[], options: SpawnOptions }[]

  beforeEach(async () => {
    credentials = new MemoryCredentials()
    runtimes = []
    children = []
    calls = []
    server = createServer((request, response) => {
      response.writeHead(request.url === '/health' ? 200 : 404)
      response.end('ok')
    })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    upstream = `http://127.0.0.1:${(server.address() as { port: number }).port}`
  })

  afterEach(async () => {
    await Promise.all(runtimes.map(runtime => runtime.stop()))
    for (const runtime of runtimes) runtime.disposeSync()
    for (const child of children) {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
    }
    await until(() => children.every(child => child.exitCode !== null || child.signalCode !== null))
    server.closeAllConnections()
    await new Promise<void>(resolve => server.close(() => resolve()))
  })

  function make(program = stdinProgram, extra: Partial<ConstructorParameters<typeof GatewayTunnelRuntime>[0]> = {}) {
    const injected = ((executable: string, args: readonly string[], options: SpawnOptions) => {
      calls.push({ executable, args, options })
      // A real Node child stands in for the packaged Python executable; all
      // observable runtime spawn options and pipes are retained, with no home/env.
      const child = spawn(process.execPath, ['-e', program], { ...options, env: {} })
      children.push(child)
      return child
    }) as typeof spawn
    const runtime = new GatewayTunnelRuntime({ credentials, resolveExecutable: () => 'packaged-client', resolveLocal: async () => ({ upstreamUrl: upstream, forwarderToken: token }), spawn: injected, ...extra })
    runtimes.push(runtime)
    return runtime
  }

  it('starts from one UTF8 secret line with stdin open, emits safe status, and reaps on stop', async () => {
    const events: GatewayStatus[] = []
    const runtime = make()
    runtime.subscribe(value => events.push(value))
    await runtime.start()
    await until(async () => (await runtime.getStatus()).state === 'online')
    expect(children[0]!.stdin?.writableEnded).toBe(false)
    expect(calls[0]!.args).toEqual(['--gateway', credentials.config.gatewayUrl, '--upstream', upstream])
    expect(calls[0]!.options.shell).toBe(false)
    expect(calls[0]!.options.windowsHide).toBe(true)
    expect(JSON.stringify(calls)).not.toContain(secret)
    expect(JSON.stringify(calls)).not.toContain(token)
    expect(calls[0]!.options.env).not.toHaveProperty('CC_HAHA_TUNNEL_ACCESS_KEY')
    expect(JSON.stringify(events)).not.toContain(secret)
    expect((await runtime.stop()).state).toBe('stopped')
    expect(children[0]!.exitCode !== null || children[0]!.signalCode !== null).toBe(true)
  })

  it('tests health and actual key handshake, without claiming H5 end-to-end verification', async () => {
    const runtime = make()
    expect(await runtime.testConnection()).toEqual({ localReady: true, gatewayConnected: true, keyAccepted: true, endToEndVerified: false })
    expect((await runtime.getStatus()).state).toBe('stopped')
    expect(children[0]!.exitCode !== null || children[0]!.signalCode !== null).toBe(true)
  })

  it('running rejects test/save/clear and repeated start does not spawn twice', async () => {
    const runtime = make()
    await Promise.all([runtime.start(), runtime.start()])
    await expect(runtime.testConnection()).rejects.toMatchObject({ code: 'BUSY' })
    await expect(runtime.saveConfig({ gatewayUrl: 'http://localhost:1' })).rejects.toMatchObject({ code: 'BUSY' })
    await expect(runtime.clearKey()).rejects.toMatchObject({ code: 'BUSY' })
    expect(children).toHaveLength(1)
  })

  it('testing reserves exclusivity before its first await and stop interrupts it', async () => {
    const runtime = make('setInterval(()=>{},1000)')
    const test = runtime.testConnection()
    await expect(runtime.start()).rejects.toMatchObject({ code: 'BUSY' })
    await expect(runtime.testConnection()).rejects.toMatchObject({ code: 'BUSY' })
    await until(() => children.length === 1)
    await runtime.stop()
    expect(await test).toMatchObject({ keyAccepted: false, code: 'PROCESS_EXITED' })
    expect((await runtime.getStatus()).state).toBe('stopped')
  })

  it('stop interrupts an unresolved local resolver and its late completion cannot resurrect', async () => {
    let resolve!: (local: { upstreamUrl: string, forwarderToken: string }) => void
    const runtime = make(stdinProgram, { resolveLocal: () => new Promise(done => { resolve = done }) })
    const start = runtime.start()
    await until(() => !!resolve)
    await runtime.stop()
    await start
    resolve({ upstreamUrl: upstream, forwarderToken: token })
    await new Promise(done => setTimeout(done, 20))
    expect(children).toHaveLength(0)
    expect((await runtime.getStatus()).state).toBe('stopped')
  })

  it('serializes stop/start and ignores late output and close from the old process', async () => {
    const runtime = make()
    await runtime.start()
    const old = children[0]!
    const stop = runtime.stop()
    const start = runtime.start()
    await Promise.all([stop, start])
    await until(async () => (await runtime.getStatus()).state === 'online')
    const status = await runtime.getStatus()
    old.stdout?.emit('data', Buffer.from('{"event":"state","state":"terminal_error","error_code":"KEY_INVALID"}\n'))
    old.emit('close', 9)
    expect(await runtime.getStatus()).toEqual(status)
    expect(children).toHaveLength(2)
  })

  it('only restores desired running state and re-resolves the actual port', async () => {
    let resolutions = 0
    const runtime = make(stdinProgram, { resolveLocal: async () => { resolutions++; return { upstreamUrl: upstream, forwarderToken: token } } })
    await runtime.localServerChanged()
    expect(resolutions).toBe(0)
    await runtime.start()
    await runtime.localServerChanged()
    expect(resolutions).toBe(2)
    expect(children).toHaveLength(2)
    const restoring = runtime.localServerChanged()
    await runtime.stop()
    await restoring
    await runtime.localServerChanged()
    expect(children).toHaveLength(2)
    expect((await runtime.getStatus()).state).toBe('stopped')
  })

  it('retains desired running across local unavailability and coalesces startup notifications', async () => {
    let unavailable = false
    const runtime = make(stdinProgram, { resolveLocal: async () => {
      if (unavailable) throw new Error('local offline')
      return { upstreamUrl: upstream, forwarderToken: token }
    } })
    await runtime.start()
    unavailable = true
    await runtime.localServerChanged()
    expect(await runtime.getStatus()).toMatchObject({ state: 'error', code: 'LOCAL_SERVER_UNAVAILABLE' })
    unavailable = false
    server.closeAllConnections()
    await new Promise<void>(resolve => server.close(() => resolve()))
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    upstream = `http://127.0.0.1:${(server.address() as { port: number }).port}`
    await Promise.all([runtime.localServerChanged(), runtime.localServerChanged(), runtime.localServerChanged()])
    await until(async () => (await runtime.getStatus()).state === 'online')
    expect(children).toHaveLength(2)
    expect(calls[1]!.args.at(-1)).toBe(upstream)
  })

  it('explicit start retries a failed local resolution and a failed automatic restore', async () => {
    let unavailable = true
    const runtime = make(stdinProgram, { resolveLocal: async () => {
      if (unavailable) throw new Error('offline')
      return { upstreamUrl: upstream, forwarderToken: token }
    } })
    expect(await runtime.start()).toMatchObject({ state: 'error', code: 'LOCAL_SERVER_UNAVAILABLE' })
    unavailable = false
    await runtime.start()
    await until(async () => (await runtime.getStatus()).state === 'online')
    unavailable = true
    await runtime.localServerChanged()
    expect((await runtime.getStatus()).code).toBe('LOCAL_SERVER_UNAVAILABLE')
    unavailable = false
    await runtime.start()
    await until(async () => (await runtime.getStatus()).state === 'online')
    expect(children).toHaveLength(2)
  })

  it('late stdin error and close cannot overwrite stopped state', async () => {
    const runtime = make()
    await runtime.start()
    const old = children[0]!
    const stopping = runtime.stop()
    old.stdin?.emit('error', new Error('EPIPE secret'))
    await stopping
    const stopped = await runtime.getStatus()
    old.stdin?.emit('error', new Error('late EPIPE'))
    old.emit('close', 1)
    await Promise.resolve()
    expect(await runtime.getStatus()).toEqual(stopped)
    expect(stopped.state).toBe('stopped')
  })

  it('preserves whitelisted storage errors and hides arbitrary messages', async () => {
    const runtime = make()
    credentials.save = () => { throw new Error('CONFIG_INVALID') }
    await expect(runtime.saveConfig({ gatewayUrl: 'https://example.test' })).rejects.toMatchObject({ code: 'CONFIG_INVALID' })
    credentials.save = () => { throw new Error(secret) }
    await expect(runtime.saveConfig({ gatewayUrl: 'https://example.test' })).rejects.toMatchObject({ message: 'STORAGE_ERROR' })
  })

  it('reports an actual spawn ENOENT as CLIENT_NOT_INSTALLED', async () => {
    const runtime = make(stdinProgram, { spawn, resolveExecutable: () => `${process.execPath}.missing-test-only` })
    expect((await runtime.testConnection()).code).toBe('CLIENT_NOT_INSTALLED')
  })

  it('bounds non-emitting test connection and kills its child on timeout', async () => {
    const runtime = make('setInterval(()=>{},1000)')
    const started = Date.now()
    expect((await runtime.testConnection()).code).toBe('CONNECTION_FAILED')
    expect(Date.now() - started).toBeLessThan(17500)
    expect(children[0]!.exitCode !== null || children[0]!.signalCode !== null).toBe(true)
  }, 20000)

  it.each(['KEY_INVALID', 'KEY_REVOKED', 'KEY_IN_USE', 'TLS_ERROR'] as const)('reports %s without raw stderr', async code => {
    const runtime = make(`process.stderr.write(${JSON.stringify(secret)});process.stdout.write(JSON.stringify({event:'state',state:${JSON.stringify(code === 'KEY_IN_USE' ? 'backoff' : 'terminal_error')},error_code:${JSON.stringify(code)}})+'\\n');setInterval(()=>{},1000)`)
    const result = await runtime.testConnection()
    expect(result.code).toBe(code)
    expect(result.keyAccepted).toBe(false)
    expect(result.gatewayConnected).toBe(code !== 'TLS_ERROR')
    expect(JSON.stringify(result)).not.toContain(secret)
  })

  it.each([
    '{"event":"state","state":"online","secret":"must-not-leak"}\n',
    'x'.repeat(9000),
    '{"event":"state","state":"online","attempt":true}\n',
    '{"event":"state","state":"online","retry_delay":31}\n',
  ])('rejects non-whitelisted or oversized stdout %#', async output => {
    const runtime = make(`process.stdout.write(${JSON.stringify(output)});setInterval(()=>{},1000)`)
    expect((await runtime.testConnection()).code).toBe('PROTOCOL_ERROR')
  })

  it('distinguishes missing executable and missing key without spawning', async () => {
    const runtime = make(stdinProgram, { resolveExecutable: () => { throw new Error('secret path') } })
    expect((await runtime.testConnection()).code).toBe('CLIENT_NOT_INSTALLED')
    credentials.key = undefined
    expect((await runtime.testConnection()).code).toBe('KEY_REQUIRED')
    expect(children).toHaveLength(0)
  })

  it('rejects non-loopback upstream and oversized secrets before spawning', async () => {
    const invalid = make(stdinProgram, { resolveLocal: async () => ({ upstreamUrl: 'http://example.com', forwarderToken: token }) })
    expect((await invalid.testConnection()).code).toBe('LOCAL_SERVER_UNAVAILABLE')
    const large = make()
    credentials.key = '中'.repeat(4000)
    expect((await large.testConnection()).code).toBe('CONFIG_INVALID')
    expect(children).toHaveLength(0)
  })

  it('sanitizes config returns, preserves omitted key, and clears only on explicit request', async () => {
    const runtime = make()
    Object.assign(credentials.config, { accessKey: secret })
    expect(await runtime.getConfig()).not.toHaveProperty('accessKey')
    expect(await runtime.saveConfig({ gatewayUrl: 'https://example.test', autoStart: true })).toMatchObject({ hasKey: true, autoStart: true })
    expect(credentials.key).toBe(secret)
    await expect(runtime.saveConfig({ gatewayUrl: 'https://example.test', accessKey: '' })).rejects.toMatchObject({ code: 'CONFIG_INVALID' })
    expect((await runtime.clearKey()).hasKey).toBe(false)
  })

  it('disposes synchronously and cannot restart or auto-restore afterward', async () => {
    const runtime = make()
    await runtime.start()
    runtime.disposeSync()
    await until(() => children[0]!.exitCode !== null || children[0]!.signalCode !== null)
    await expect(runtime.start()).rejects.toMatchObject({ code: 'PROCESS_EXITED' })
    await runtime.localServerChanged()
    expect(children).toHaveLength(1)
  })
})
