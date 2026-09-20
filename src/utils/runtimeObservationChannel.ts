import { join } from 'node:path'
import { homedir } from 'node:os'
import { unlinkSync, readFileSync } from 'node:fs'
import { runtimeObservation } from './runtimeObservation'
import { runtimeBoundaryTrace } from './runtimeBoundaryTrace'
import { runtimeObservationWorker } from './runtimeObservation.worker'

export interface RuntimeObservationDescriptor {
  pid: number
  parentPid: number
  role: 'server' | 'cli'
  url: string
  token: string
}

/** Independent worker: observing a blocked main thread never depends on its HTTP loop. */
export function startRuntimeObservationChannel(options: {
  role: 'server' | 'cli'
  /** Only bounded, allowlisted runtime metadata; never prompts, tool arguments or credentials. */
  getState?: () => unknown
}): { ready: Promise<RuntimeObservationDescriptor | null>, stop: () => Promise<void> } {
  let worker: Worker | undefined
  let heartbeat: ReturnType<typeof setInterval> | undefined
  let flush: ReturnType<typeof setTimeout> | undefined
  let unsubscribe: (() => void) | undefined
  let unsubscribeBoundary: (() => void) | undefined
  let boundaryEventsInFlight = 0
  let boundaryOverflowReported = false
  let stopped = false
  let eventsInFlight = 0
  let overflowReported = false
  let resolveReady!: (value: RuntimeObservationDescriptor | null) => void
  const ready = new Promise<RuntimeObservationDescriptor | null>(resolve => { resolveReady = resolve })
  const directory = join(process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude'), 'cc-haha', 'live-debug')
  // One startup read lets newly spawned CLIs join a recording without filesystem polling.
  try {
    const lease = JSON.parse(readFileSync(join(directory, 'recording.json'), 'utf8'))
    if (lease.active === true && typeof lease.recordingId === 'string' && Number.isFinite(lease.expiresAt) && lease.expiresAt > Date.now()) {
      runtimeBoundaryTrace.start(lease.recordingId, lease.expiresAt - Date.now())
    }
  } catch {}
  const descriptorPath = join(directory, `${process.pid}.json`)
  const removeDescriptor = () => { try { unlinkSync(descriptorPath) } catch {} }
  let startupTimeout: ReturnType<typeof setTimeout> | undefined
  const publish = () => {
    if (stopped || !worker) return
    try {
      worker.postMessage({ type: 'snapshot', observedAt: Date.now(),
        snapshot: { runtime: runtimeObservation.snapshot(), state: options.getState?.() ?? null }, boundaryTrace: runtimeBoundaryTrace.snapshot() })
    } catch { /* Observation must not affect application execution. */ }
  }
  const stop = async () => {
    if (stopped) return
    stopped = true
    clearInterval(heartbeat)
    clearTimeout(flush)
    clearTimeout(startupTimeout)
    unsubscribe?.()
    unsubscribeBoundary?.()
    resolveReady(null)
    process.removeListener('exit', removeDescriptor)
    // Worker termination releases the private server even when initialization failed.
    worker?.terminate()
    removeDescriptor()
  }
  try {
    // Blob embeds the self-contained worker in both source runs and Bun --compile builds.
    const blob = new Blob([`(${runtimeObservationWorker.toString()})()`], { type: 'application/javascript' })
    const url = URL.createObjectURL(blob)
    worker = new Worker(url)

    worker.unref()
    startupTimeout = setTimeout(() => { void stop() }, 5000)
    startupTimeout.unref()
    worker.onerror = () => { void stop() }
    worker.onmessage = ({ data }) => {
      if (stopped) return
      if (data.type === 'loaded') {
        URL.revokeObjectURL(url)
        worker?.postMessage({ type: 'init', token: crypto.randomUUID() + crypto.randomUUID(), directory, pid: process.pid, parentPid: process.ppid, role: options.role })
      } else if (data.type === 'ready') {
        clearTimeout(startupTimeout)
        process.once('exit', removeDescriptor)
        publish()
        heartbeat = setInterval(publish, 1000)
        heartbeat.unref()
        unsubscribe = runtimeObservation.subscribe(event => {
          if (eventsInFlight < 256) {
            eventsInFlight++
            worker?.postMessage({ type: 'transition', event })
          } else if (!overflowReported) {
            overflowReported = true
            worker?.postMessage({ type: 'transition-overflow' })
          }
          if (!flush) {
            flush = setTimeout(() => { flush = undefined; publish() }, 100)
            flush.unref()
          }
        })
        unsubscribeBoundary = runtimeBoundaryTrace.subscribe(change => {
          if (change.type !== 'entry' || boundaryEventsInFlight < 256) {
            boundaryEventsInFlight++
            worker?.postMessage({ type: 'boundary', change })
          } else if (!boundaryOverflowReported) {
            boundaryOverflowReported = true
            worker?.postMessage({ type: 'boundary-overflow' })
          }
        })
        resolveReady(data.descriptor)
      } else if (data.type === 'boundary-ack') {
        boundaryEventsInFlight = Math.max(0, boundaryEventsInFlight - 1)
        if (boundaryEventsInFlight === 0) boundaryOverflowReported = false
      } else if (data.type === 'transition-ack') {
        eventsInFlight = Math.max(0, eventsInFlight - 1)
        if (eventsInFlight === 0) overflowReported = false
      } else if (data.type === 'configure') {
        let applied = false
        if (Date.now() <= data.expiresAt) {
          try { runtimeObservation.configure(data.input); applied = true } catch {}
        }
        worker?.postMessage({ type: 'configured', id: data.id, applied, configuration: runtimeObservation.snapshot().config })
        publish()
      } else if (data.type === 'recording') {
        let applied = false
        if (Date.now() <= data.expiresAt) {
          try {
            if (data.input.action === 'start') runtimeBoundaryTrace.start(data.input.recordingId, data.input.durationMs)
            else runtimeBoundaryTrace.stop()
            applied = true
          } catch {}
        }
        worker?.postMessage({ type: 'configured', id: data.id, applied, boundaryTrace: runtimeBoundaryTrace.snapshot() })
        publish()
      }
    }
  } catch { void stop() }
  return { ready, stop }
}
