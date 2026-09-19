import type { WorkspaceService } from '../services/workspaceService.js'
import { FILE_REFERENCE_LIMITS, type FileReferenceRequest, type FileReferenceResult } from '../services/workspaceFileReferenceResolver.js'

const MAX_REQUEST_BYTES = 64 * 1024

/** Separate lightweight route for isolated HTTP tests; no provider/session startup. */
export async function handleWorkspaceFileReferenceRoute(req: Request, sessionId: string, service: Pick<WorkspaceService, 'resolveFileReference'>): Promise<Response> {
  const started = Date.now()
  const response = (result: FileReferenceResult) => Response.json(result, { headers: { 'Cache-Control': 'no-store' } })
  const fail = (state: 'invalid' | 'incomplete', error: string) => response({
    state, complete: false, scope: null, error,
    stats: { elapsedMs: Date.now() - started, exactProbes: 0, directories: 0, entries: 0 },
  })
  if (req.method !== 'POST') return new Response('Method not allowed', { status: 405 })
  if (!req.body || Number(req.headers.get('content-length') ?? 0) > MAX_REQUEST_BYTES) return fail('invalid', 'Invalid file reference request')
  const reader = req.body.getReader()
  let expired = false
  let stop!: () => void
  const interrupted = new Promise<never>((_resolve, reject) => { stop = () => { expired = true; reject(new Error('Request deadline reached')) } })
  const timer = setTimeout(stop, FILE_REFERENCE_LIMITS.timeoutMs)
  req.signal.addEventListener('abort', stop, { once: true })
  if (req.signal.aborted) stop()
  let body: FileReferenceRequest
  try {
    const chunks: Uint8Array[] = []
    let length = 0
    for (;;) {
      const { value, done } = await Promise.race([reader.read(), interrupted])
      if (done) break
      length += value.byteLength
      if (length > MAX_REQUEST_BYTES) return fail('invalid', 'File reference request exceeds size limit')
      chunks.push(value)
    }
    const bytes = new Uint8Array(length)
    let offset = 0
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength }
    body = JSON.parse(new TextDecoder().decode(bytes)) as FileReferenceRequest
  } catch {
    return fail(expired ? 'incomplete' : 'invalid', expired ? 'File reference request timed out' : 'Invalid file reference JSON')
  } finally {
    clearTimeout(timer)
    req.signal.removeEventListener('abort', stop)
    void reader.cancel().catch(() => {}).finally(() => reader.releaseLock())
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) return fail('invalid', 'Invalid file reference request')
  if (body.timeoutMs !== undefined && (!Number.isFinite(body.timeoutMs) || body.timeoutMs <= 0)) return fail('invalid', 'Invalid file reference timeout')
  const remaining = Math.min(body.timeoutMs ?? FILE_REFERENCE_LIMITS.timeoutMs, FILE_REFERENCE_LIMITS.timeoutMs) - (Date.now() - started)
  if (remaining <= 0 || req.signal.aborted) return fail('incomplete', 'File reference request timed out')
  const result = await service.resolveFileReference(sessionId, { ...body, timeoutMs: remaining }, req.signal)
  return response({ ...result, stats: { ...result.stats, elapsedMs: Date.now() - started } })
}
