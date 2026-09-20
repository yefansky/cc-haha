import { describe, expect, test } from 'bun:test'
import { sampleBunProcess } from './bun-sampling.js'

describe('bounded Bun CPU sampling', () => {
  test('rejects remote addresses, credentials, query secrets and invalid durations', () => {
    for (const url of ['ws://example.com:9229/ws', 'ws://127.0.0.1:9229/ws?secret=token', 'ws://user:secret@127.0.0.1:9229/ws', 'ws://127.0.0.1:99999/ws']) {
      expect(() => sampleBunProcess(url)).toThrow()
    }
    for (const duration of [-1, 0, 10_001, Infinity, NaN]) {
      expect(() => sampleBunProcess('ws://127.0.0.1:9229/ws', duration)).toThrow()
    }
  })

  test('sends only profiler commands and strips paths and unapproved response data', async () => {
    const commands: any[] = []
    const server = Bun.serve({
      hostname: '127.0.0.1', port: 0,
      fetch(request, server) { return server.upgrade(request) ? undefined : new Response('', { status: 400 }) },
      websocket: {
        message(ws, data) {
          const command = JSON.parse(String(data))
          commands.push(command)
          ws.send(JSON.stringify({ id: command.id, result: {} }))
          if (command.id === 2) ws.send(JSON.stringify({ method: 'ScriptProfiler.trackingComplete', params: {
            secret: 'never-return', samples: { stackTraces: [{ timestamp: 1, stackFrames: [{ name: 'cpuBusy', url: 'C:\\private\\worker.ts', line: 3, column: 4, arguments: 'never-return' }] }] },
          } }))
        },
      },
    })
    try {
      const result = await sampleBunProcess(`ws://127.0.0.1:${server.port}/test`, 10)
      expect(commands).toEqual([{ id: 1, method: 'ScriptProfiler.startTracking', params: { includeSamples: true } }, { id: 2, method: 'ScriptProfiler.stopTracking' }])
      expect(result.stackTraces[0].stackFrames[0]).toEqual({ name: 'cpuBusy', file: 'worker.ts', line: 3, column: 4 })
      expect(JSON.stringify(result)).not.toMatch(/private|never-return|ws:\/\//)
    } finally { server.stop(true) }
  })

  test('collects named CPU frames from an isolated real Bun process without evaluating or pausing it', async () => {
    const child = Bun.spawn([process.execPath, '--no-env-file', '--inspect=127.0.0.1:0/sampling-fixture', '-e', `
      function knownCpuBusyFrame() {
        const end = performance.now() + 2500
        let result = 0
        while (performance.now() < end) result += Math.sqrt(Math.random())
        return result
      }
      setTimeout(() => { knownCpuBusyFrame(); console.log('BUSY_FINISHED') }, 500)
      setInterval(() => {}, 1000)
    `], { stdout: 'pipe', stderr: 'pipe', env: { PATH: process.env.PATH ?? '', TEMP: process.env.TEMP ?? '', SystemRoot: process.env.SystemRoot ?? '' } })
    const reader = child.stderr.getReader()
    let stderr = ''
    const address = (async () => {
      while (stderr.length < 16384) {
        const chunk = await reader.read()
        if (chunk.done) break
        stderr += new TextDecoder().decode(chunk.value)
        const match = stderr.match(/ws:\/\/127\.0\.0\.1:\d+\/sampling-fixture/)
        if (match) return match[0]
      }
      throw new Error('Fixture inspector address was not available')
    })()
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      const url = await Promise.race([address, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('Fixture startup timed out')), 5000) })])
      const result = await sampleBunProcess(url, 1500)
      expect(result.sampleCount).toBeGreaterThan(0)
      expect(result.stackTraces.some(trace => trace.stackFrames.some(frame => frame.name === 'knownCpuBusyFrame'))).toBe(true)
      expect(child.exitCode).toBeNull()
    } finally {
      if (timer) clearTimeout(timer)
      child.kill()
      await child.exited
      await reader.cancel()
    }
  }, 12_000)

  test('oversized responses fail boundedly and send a cleanup stop command', async () => {
    const commands: string[] = []
    let closed = false
    const server = Bun.serve({
      hostname: '127.0.0.1', port: 0,
      fetch(request, server) { return server.upgrade(request) ? undefined : new Response('', { status: 400 }) },
      websocket: {
        message(ws, data) {
          const command = JSON.parse(String(data))
          commands.push(command.method)
          if (command.id === 1) {
            ws.send(JSON.stringify({ id: 1, result: {} }))
            ws.send(JSON.stringify({ method: 'unrelated', padding: 'x'.repeat(8 * 1024 * 1024) }))
          }
        },
        close() { closed = true },
      },
    })
    try {
      await expect(sampleBunProcess(`ws://127.0.0.1:${server.port}/private-token`, 10)).rejects.toThrow('size limit')
      for (let attempt = 0; attempt < 20 && !closed; attempt++) await Bun.sleep(10)
      expect(commands).toEqual(['ScriptProfiler.startTracking', 'ScriptProfiler.stopTracking'])
      expect(closed).toBe(true)
    } finally { server.stop(true) }
  })

  test('an unresponsive inspector times out, closes and receives best-effort stop', async () => {
    const commands: string[] = []
    let closed = false
    const server = Bun.serve({
      hostname: '127.0.0.1', port: 0,
      fetch(request, server) { return server.upgrade(request) ? undefined : new Response('', { status: 400 }) },
      websocket: {
        message(_ws, data) { commands.push(JSON.parse(String(data)).method) },
        close() { closed = true },
      },
    })
    try {
      await expect(sampleBunProcess(`ws://127.0.0.1:${server.port}/private-token`, 10)).rejects.toThrow('timed out')
      for (let attempt = 0; attempt < 20 && !closed; attempt++) await Bun.sleep(10)
      expect(commands).toEqual(['ScriptProfiler.startTracking', 'ScriptProfiler.stopTracking'])
      expect(closed).toBe(true)
    } finally { server.stop(true) }
  }, 7000)
})
