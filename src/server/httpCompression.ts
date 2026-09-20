import { gzip } from 'node:zlib'
import { promisify } from 'node:util'

const gzipAsync = promisify(gzip)

export function acceptsGzip(value: string | null): boolean {
  const encodings = (value ?? '').split(',').map((entry) => {
    const [name, ...parameters] = entry.trim().toLowerCase().split(';')
    const quality = parameters.find((parameter) => parameter.trim().startsWith('q='))
    return { name, quality: quality ? Number(quality.trim().slice(2)) : 1 }
  })
  const selected = encodings.find((entry) => entry.name === 'gzip')
    ?? encodings.find((entry) => entry.name === '*')
  return !!selected && selected.quality > 0 && selected.quality <= 1
}

/** Compress before forwarding through the gateway's bounded HTTP tunnel. */
export async function privateJsonResponse(request: Request, value: unknown): Promise<Response> {
  const body = JSON.stringify(value)
  const headers = new Headers({
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'private, no-store',
    'Vary': 'Accept-Encoding',
  })
  if (body.length >= 1024 && acceptsGzip(request.headers.get('Accept-Encoding'))) {
    const compressed = await gzipAsync(body)
    headers.set('Content-Encoding', 'gzip')
    headers.set('Content-Length', String(compressed.byteLength))
    return new Response(compressed, { headers })
  }
  return new Response(body, { headers })
}
