// @vitest-environment node
import http from 'node:http'
import https from 'node:https'
import net from 'node:net'
import tls from 'node:tls'
import { readFileSync } from 'node:fs'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SystemProxyBridge } from './systemProxyBridge'

// Public test-only identity. Trust is scoped to this test's TLS client;
// rejectUnauthorized and hostname verification remain enabled.
const cert = readFileSync(new URL('./fixtures/proxy-test-cert.pem', import.meta.url))
const key = readFileSync(new URL('./fixtures/proxy-test-key.pem', import.meta.url))
const realConnect = tls.connect.bind(tls)
const servers: net.Server[] = []
const sockets = new Set<net.Socket>()
const bridges: SystemProxyBridge[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  await Promise.all(bridges.splice(0).map((bridge) => bridge.stop()))
  for (const socket of sockets) socket.destroy()
  sockets.clear()
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))))
})
function trustTestCA() {
  vi.spyOn(tls, 'connect').mockImplementation(((options: tls.ConnectionOptions) => realConnect({ ...options, ca: cert })) as typeof tls.connect)
}
function listen(server: net.Server): Promise<number> {
  servers.push(server)
  server.on('connection', (socket) => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)) })
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve((server.address() as net.AddressInfo).port)))
}
async function proxy(resolver = async () => 'DIRECT') {
  const bridge = new SystemProxyBridge(resolver)
  bridges.push(bridge)
  return new URL(await bridge.start())
}
async function forward(bridge: URL, target: string, body?: string) {
  return new Promise<{ status: number; body: string }>((resolve, reject) => {
    const request = http.request({ hostname: bridge.hostname, port: bridge.port, path: target,
      method: body ? 'POST' : 'GET', headers: { Host: new URL(target).host, 'Proxy-Authorization': 'Basic do-not-forward' } }, (res) => {
      let response = ''
      res.on('data', (chunk) => { response += chunk })
      res.on('end', () => resolve({ status: res.statusCode!, body: response }))
      res.on('error', reject)
    })
    request.on('error', reject)
    request.end(body)
  })
}
async function tunnelProxy(originPort: number, targets: string[]) {
  const server = http.createServer()
  server.on('connect', (req, client, head) => {
    targets.push(req.url!)
    const upstream = net.connect(originPort, '127.0.0.1', () => {
      client.write('HTTP/1.1 200 Connection Established\r\n\r\n')
      if (head.length) upstream.write(head)
      client.pipe(upstream).pipe(client)
    })
    sockets.add(upstream)
    upstream.on('error', () => client.destroy())
    client.on('error', () => upstream.destroy())
    client.on('close', () => upstream.destroy())
  })
  return listen(server)
}
describe('absolute HTTPS proxy requests (Axios compatibility)', () => {
  it('forwards HTTPS POST once with TLS and strips proxy credentials', async () => {
    trustTestCA()
    const received: string[] = []
    const origin = https.createServer({ cert, key }, (req, res) => {
      expect(req.headers['proxy-authorization']).toBeUndefined()
      let body = ''; req.on('data', (chunk) => { body += chunk }); req.on('end', () => { received.push(body); res.end(req.url) })
    })
    const port = await listen(origin)
    const result = await forward(await proxy(), `https://127.0.0.1:${port}/oauth2/token?test=1`, 'grant_type=test')
    expect(result).toEqual({ status: 200, body: '/oauth2/token?test=1' })
    expect(received).toEqual(['grant_type=test'])
  })
  it('honors system proxy rules and uses CONNECT to the selected upstream', async () => {
    trustTestCA()
    const port = await listen(https.createServer({ cert, key }, (_req, res) => res.end('ok')))
    const targets: string[] = []
    const upstream = await tunnelProxy(port, targets)
    const resolver = vi.fn(async () => `PROXY 127.0.0.1:${upstream}`)
    expect(await forward(await proxy(resolver), `https://origin.example:${port}/`)).toEqual({ status: 200, body: 'ok' })
    expect(targets).toEqual([`origin.example:${port}`])
    expect(resolver).toHaveBeenCalledWith(`https://origin.example:${port}/`)
  })
  it('rejects a certificate for the wrong target hostname even when its CA is trusted', async () => {
    trustTestCA()
    let calls = 0
    const port = await listen(https.createServer({ cert, key }, (_req, res) => { calls++; res.end('bad') }))
    const upstream = await tunnelProxy(port, [])
    expect((await forward(await proxy(async () => `PROXY 127.0.0.1:${upstream}`), `https://wrong.example:${port}/`)).status).toBe(502)
    expect(calls).toBe(0)
  })
  it('rejects an untrusted origin certificate', async () => {
    let calls = 0
    const port = await listen(https.createServer({ cert, key }, (_req, res) => { calls++; res.end('bad') }))
    expect((await forward(await proxy(), `https://127.0.0.1:${port}/`)).status).toBe(502)
    expect(calls).toBe(0)
  })
  it('does not replay a POST when its TLS origin drops after consuming it', async () => {
    trustTestCA()
    let calls = 0
    const port = await listen(https.createServer({ cert, key }, (req) => {
      req.resume(); req.on('end', () => { calls++; req.socket.destroy() })
    }))
    expect((await forward(await proxy(), `https://127.0.0.1:${port}/token`, 'single-use-code')).status).toBe(502)
    expect(calls).toBe(1)
  })
})
