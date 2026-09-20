export interface BunCpuSample {
  timestamp: number
  /** Protocol order: bottom frame first, current top frame last. */
  stackFrames: { name: string, file: string, line: number, column: number }[]
}

export interface BunSamplingResult {
  kind: 'cpu-samples-not-async-wait-stack'
  requestedDurationMs: number
  elapsedMs: number
  receivedBytes: number
  sampleCount: number
  truncated: boolean
  stackTraces: BunCpuSample[]
}

const MAX_BYTES = 8 * 1024 * 1024
const MAX_SAMPLES = 5000
const MAX_FRAMES = 64

function inspectorUrl(value: string): string {
  if (typeof value !== 'string' || value.length > 320 || !/^ws:\/\/127\.0\.0\.1:[1-9]\d{0,4}\/[a-zA-Z0-9/_-]*$/.test(value)) {
    throw new Error('Inspector address must be a loopback WebSocket URL with an explicit port')
  }
  try {
    const url = new URL(value)
    if (Number(url.port) < 1 || Number(url.port) > 65535) throw new Error()
    return url.href
  } catch { throw new Error('Invalid loopback inspector address') }
}

function safeFrame(frame: any): BunCpuSample['stackFrames'][number] {
  const name = typeof frame?.name === 'string' && /^[a-zA-Z_$][\w$ .:<>()-]{0,159}$/.test(frame.name)
    ? frame.name : '[anonymous-or-redacted]'
  const basename = typeof frame?.url === 'string' ? frame.url.split(/[\\/]/).at(-1) : undefined
  const file = basename && /^[a-zA-Z0-9_.-]{1,160}$/.test(basename) ? basename : '[unavailable]'
  return {
    name,
    file,
    line: Number.isInteger(frame?.line) ? frame.line : -1,
    column: Number.isInteger(frame?.column) ? frame.column : -1,
  }
}

/**
 * Fixed-command sampling client for an already enabled Bun inspector. Never sends
 * Runtime.evaluate, pause, reload, breakpoint or user-supplied protocol commands.
 * Protocol: bun-inspector-protocol ScriptProfiler.startTracking / stopTracking.
 * Bun 1.3.14 can defer both commands until a busy JS loop yields. Start sampling
 * before reproducing a suspected stall; a permanently blocked VM may only time out.
 */
export function sampleBunProcess(wsUrl: string, durationMs = 1000): Promise<BunSamplingResult> {
  const url = inspectorUrl(wsUrl)
  if (!Number.isFinite(durationMs) || durationMs < 10 || durationMs > 10_000) {
    throw new Error('Sampling duration must be between 10 and 10000 milliseconds')
  }
  return new Promise((resolve, reject) => {
    const startedAt = performance.now()
    let socket: WebSocket
    let finished = false
    let startSent = false
    let stopSent = false
    let stopAcknowledged = false
    let receivedBytes = 0
    let samples: unknown[] | undefined
    let sampleTimer: ReturnType<typeof setTimeout> | undefined
    const deadline = setTimeout(() => fail('Inspector sampling timed out; the target may be unresponsive'), durationMs + 5000)

    function cleanup() {
      clearTimeout(deadline)
      if (sampleTimer) clearTimeout(sampleTimer)
      // Best effort on error: do not leave a successfully delivered start unpaired.
      if (socket?.readyState === WebSocket.OPEN && startSent && !stopSent) sendStop()
      socket?.close()
    }

    function fail(message: string) {
      if (finished) return
      finished = true
      cleanup()
      reject(new Error(message))
    }

    function sendStop() {
      stopSent = true
      try { socket.send(JSON.stringify({ id: 2, method: 'ScriptProfiler.stopTracking' })) }
      catch { fail('Inspector connection failed while stopping sampling') }
    }

    function complete() {
      if (finished || !stopAcknowledged || !samples) return
      finished = true
      const selected = samples.slice(0, MAX_SAMPLES)
      const truncated = samples.length > MAX_SAMPLES || selected.some((sample: any) => Array.isArray(sample?.stackFrames) && sample.stackFrames.length > MAX_FRAMES)
      const stackTraces = selected.map((sample: any) => ({
        timestamp: typeof sample?.timestamp === 'number' ? sample.timestamp : 0,
        stackFrames: Array.isArray(sample?.stackFrames) ? sample.stackFrames.slice(-MAX_FRAMES).map(safeFrame) : [],
      }))
      cleanup()
      resolve({
        kind: 'cpu-samples-not-async-wait-stack',
        requestedDurationMs: durationMs,
        elapsedMs: Math.round(performance.now() - startedAt),
        receivedBytes,
        sampleCount: samples.length,
        truncated,
        stackTraces,
      })
    }

    try { socket = new WebSocket(url) }
    catch { fail('Unable to open inspector connection'); return }
    socket.onopen = () => {
      try {
        startSent = true
        socket.send(JSON.stringify({ id: 1, method: 'ScriptProfiler.startTracking', params: { includeSamples: true } }))
      } catch { fail('Unable to start inspector sampling') }
    }
    socket.onerror = () => fail('Inspector connection error')
    socket.onclose = () => fail('Inspector connection closed before sampling completed')
    socket.onmessage = event => {
      if (finished) return
      if (typeof event.data !== 'string') { fail('Unexpected binary inspector response'); return }
      receivedBytes += Buffer.byteLength(event.data)
      if (receivedBytes > MAX_BYTES) { fail('Inspector response exceeded the sampling size limit'); return }
      let message: any
      try { message = JSON.parse(event.data) }
      catch { fail('Invalid inspector response'); return }
      if (message?.error && (message.id === 1 || message.id === 2)) {
        fail('Inspector rejected the fixed ScriptProfiler command')
        return
      }
      if (message?.id === 1 && !sampleTimer) sampleTimer = setTimeout(sendStop, durationMs)
      if (message?.id === 2) stopAcknowledged = true
      if (message?.method === 'ScriptProfiler.trackingComplete') {
        samples = Array.isArray(message.params?.samples?.stackTraces) ? message.params.samples.stackTraces : []
      }
      complete()
    }
  })
}

if (import.meta.main) {
  try {
    const address = process.env.CC_HAHA_BUN_INSPECTOR_URL
    if (!address) throw new Error('Set CC_HAHA_BUN_INSPECTOR_URL to the existing loopback inspector address')
    console.log(JSON.stringify(await sampleBunProcess(address, Number(process.argv[2] ?? 1000)), null, 2))
  } catch (error) {
    console.error(error instanceof Error ? error.message : 'Sampling failed')
    process.exitCode = 1
  }
}
