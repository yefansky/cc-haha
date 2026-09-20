import { observeOperation } from '../utils/runtimeObservationScopes.js'

const resources = new Set(['sessions', 'conversations', 'settings', 'models', 'providers',
  'diagnostics', 'status', 'search', 'agents', 'tasks', 'workspace', 'traces'])

export function observeHttpRequest(request: Request, url: URL, operation: () => Promise<Response>) {
  const resource = url.pathname.split('/')[2] ?? ''
  const method = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(request.method) ? request.method : 'OTHER'
  // No URL, query, body, filename or arbitrary path segment enters the recorder.
  return observeOperation(`http.${method}.${resources.has(resource) ? resource : 'other'}`, operation, { kind: 'http' })
}
