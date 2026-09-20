import { afterEach, expect, test } from 'bun:test'
import { runtimeObservation } from '../utils/runtimeObservation.js'
import { observeHttpRequest } from './runtimeObservationHttp.js'
import { settleResponseOnRequestAbort } from './requestLifecycle.js'

afterEach(() => { runtimeObservation.configure({ mode: 'off' }); runtimeObservation.configure({ mode: 'basic' }) })

test('a disconnected observer cannot finish a pending HTTP operation or expose its input', async () => {
  const abort = new AbortController()
  const url = new URL('http://127.0.0.1/api/sessions/private-filename?token=secret')
  const request = new Request(url, { signal: abort.signal })
  let finish!: (response: Response) => void
  const pending = observeHttpRequest(request, url, () => new Promise(resolve => { finish = resolve }))
  const client = settleResponseOnRequestAbort(request, pending)
  abort.abort()
  expect((await client).status).toBe(499)
  const snapshot = runtimeObservation.snapshot()
  expect(snapshot.active.some(op => op.name === 'http.GET.sessions')).toBe(true)
  expect(JSON.stringify(snapshot)).not.toContain('private-filename')
  expect(JSON.stringify(snapshot)).not.toContain('secret')
  const response = new Response('result')
  finish(response)
  expect(await pending).toBe(response)
  expect(runtimeObservation.snapshot().active).toHaveLength(0)
})
