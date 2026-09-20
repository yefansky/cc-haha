// Kept self-contained so its function source can also run inside a compiled Bun executable.
export async function runtimeObservationWorker() {
  const { mkdir, writeFile, chmod, unlink } = await import('node:fs/promises')
  let server: ReturnType<typeof Bun.serve> | undefined
  let descriptorPath = ''
  let latest: unknown = null
  let observedAt: number | null = null
  let heartbeatAt: number | null = null
  let token = ''
  let host = ''
  let pid = 0
  let parentPid = 0
  let role = ''
  let serial = 0
  let transitionDeliveryIncomplete = false
  let boundaryTrace: { recordingId: string | null, recording: boolean, entries: unknown[], capacity: number, dropped: number, [key: string]: unknown } | null = null
  let boundaryDeliveryIncomplete = false
  const recentTransitions: unknown[] = []
  const operations = new Map<string, unknown>()
  const pending = new Map<number, { resolve: (value: Response) => void, timer: ReturnType<typeof setTimeout> }>()
  const reply = (data: unknown, status = 200) => Response.json(data, { status, headers: { 'Cache-Control': 'no-store' } })
  const worker = globalThis as unknown as { onmessage: (event: MessageEvent) => void, postMessage: (data: unknown) => void }
  worker.onmessage = async ({ data }) => {
    if (data.type === 'snapshot') {
      latest = data.snapshot
      boundaryTrace = data.boundaryTrace ?? boundaryTrace
      boundaryDeliveryIncomplete = false
      observedAt = data.observedAt
      heartbeatAt = Date.now()
      operations.clear()
      for (const operation of data.snapshot?.runtime?.active ?? []) operations.set(operation.id, operation)
      transitionDeliveryIncomplete = false
    } else if (data.type === 'transition') {
      const event = data.event
      if (recentTransitions.length >= 256) recentTransitions.shift()
      recentTransitions.push(event)
      if (event.operation) {
        if (event.type === 'end') operations.delete(event.operation.id)
        else if (operations.size < 256 || operations.has(event.operation.id)) operations.set(event.operation.id, event.operation)
      }
      if (event.type === 'configure' && event.mode === 'off') operations.clear()
      worker.postMessage({ type: 'transition-ack' })
    } else if (data.type === 'transition-overflow') {
      transitionDeliveryIncomplete = true
    } else if (data.type === 'boundary') {
      const change = data.change
      if (change.type !== 'entry') {
        boundaryTrace = change.snapshot
        boundaryDeliveryIncomplete = false
      } else if (boundaryTrace && change.entry.recordingId === boundaryTrace.recordingId) {
        if (boundaryTrace.entries.length >= boundaryTrace.capacity) {
          boundaryTrace.entries.shift()
          boundaryTrace.dropped++
        }
        boundaryTrace.entries.push(change.entry)
      }
      worker.postMessage({ type: 'boundary-ack' })
    } else if (data.type === 'boundary-overflow') {
      boundaryDeliveryIncomplete = true
    } else if (data.type === 'configured') {
      const request = pending.get(data.id)
      if (request) {
        clearTimeout(request.timer)
        pending.delete(data.id)
        request.resolve(reply({ applied: data.applied, pending: false, configuration: data.configuration, boundaryTrace: data.boundaryTrace }))
      }
    } else if (data.type === 'stop') {
      server?.stop(true)
      if (descriptorPath) await unlink(descriptorPath).catch(() => {})
      worker.postMessage({ type: 'stopped' })
    } else if (data.type === 'init') {
      try {
        token = data.token
        pid = data.pid
        parentPid = data.parentPid
        role = data.role
        server = Bun.serve({
          hostname: '127.0.0.1', port: 0,
          async fetch(request) {
            if (request.headers.get('host') !== host || request.headers.has('origin') ||
                [...request.headers.keys()].some(key => key === 'forwarded' || key.startsWith('x-forwarded-')) ||
                request.headers.get('authorization') !== `Bearer ${token}`) return reply({ error: 'forbidden' }, 403)
            const url = new URL(request.url)
            if (request.method === 'GET' && url.pathname === '/snapshot') {
              const now = Date.now()
              const heartbeatAgeMs = heartbeatAt === null ? null : now - heartbeatAt
              return reply({ pid, parentPid, role, sampledAt: now, observedAt, heartbeatAgeMs,
                stale: heartbeatAgeMs === null || heartbeatAgeMs > 2500,
                evidence: 'last-known-instrumented-state', snapshot: latest,
                operations: [...operations.values()], recentTransitions, transitionDeliveryIncomplete,
                boundaryTrace, boundaryDeliveryIncomplete })
            }
            if (request.method !== 'POST' || !['/configure', '/recording'].includes(url.pathname)) return reply({ error: 'not_found' }, 404)
            if (pending.size >= 4) return reply({ error: 'busy' }, 429)
            // Bound streamed bodies as well as Content-Length; never parse arbitrary debug commands.
            const reader = request.body?.getReader()
            if (!reader) return reply({ error: 'invalid_configuration' }, 400)
            let body = ''
            const decoder = new TextDecoder()
            try {
              while (true) {
                const part = await Promise.race([reader.read(), new Promise<never>((_, reject) => setTimeout(() => reject(new Error('timeout')), 1000))])
                if (part.done) break
                body += decoder.decode(part.value, { stream: true })
                if (body.length > 1024) { void reader.cancel(); return reply({ error: 'too_large' }, 413) }
              }
              const input = JSON.parse(body)
              const isRecording = url.pathname === '/recording'
              if (isRecording ? (!input || !['start', 'stop'].includes(input.action) ||
                Object.keys(input).some(key => !['action', 'recordingId', 'durationMs'].includes(key)) ||
                (input.recordingId !== undefined && (typeof input.recordingId !== 'string' || !/^[a-zA-Z0-9_.:-]{1,128}$/.test(input.recordingId))) ||
                (input.durationMs !== undefined && (!Number.isFinite(input.durationMs) || input.durationMs < 1 || input.durationMs > 1800000))) :
                (!input || !['off', 'basic', 'detailed'].includes(input.mode) ||
                Object.keys(input).some(key => !['mode', 'durationMs'].includes(key)) ||
                (input.durationMs !== undefined && (!Number.isFinite(input.durationMs) || input.durationMs < 1 || input.durationMs > 600000)))) {
                return reply({ error: 'invalid_configuration' }, 400)
              }
              const id = ++serial
              const expiresAt = Date.now() + 1000
              return await new Promise<Response>(resolve => {
                const timer = setTimeout(() => {
                  pending.delete(id)
                  resolve(reply({ applied: false, pending: true, requestId: id, expiresAt,
                    message: 'Main thread has not acknowledged; request expires instead of replaying after a long stall.' }, 202))
                }, 500)
                pending.set(id, { resolve, timer })
                worker.postMessage({ type: isRecording ? 'recording' : 'configure', id, input, expiresAt })
              })
            } catch { return reply({ error: 'invalid_configuration' }, 400) }
          },
        })
        host = `127.0.0.1:${server.port}`
        const descriptor = { pid, parentPid, role, url: `http://${host}`, token }
        await mkdir(data.directory, { recursive: true, mode: 0o700 })
        descriptorPath = `${data.directory}/${pid}.json`
        await writeFile(descriptorPath, JSON.stringify(descriptor), { mode: 0o600 })
        await chmod(descriptorPath, 0o600)
        worker.postMessage({ type: 'ready', descriptor })
      } catch {
        server?.stop(true)
        if (descriptorPath) await unlink(descriptorPath).catch(() => {})
        worker.postMessage({ type: 'failed' })
      }
    }
  }
  worker.postMessage({ type: 'loaded' })
}
