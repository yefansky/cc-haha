import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const html = readFileSync(resolve(__dirname, '../../index.html'), 'utf8')
const script = Array.from(html.matchAll(/<script>([\s\S]*?)<\/script>/g))
  .map(match => match[1])
  .find(body => body?.includes('var bootDeadlineMs'))

describe('startup watchdog on slow gateway connections', () => {
  const handlers: Array<[string, EventListenerOrEventListenerObject, boolean | AddEventListenerOptions | undefined]> = []

  beforeEach(() => {
    vi.useFakeTimers()
    document.body.innerHTML = '<div id="root"></div>'
    window.__CC_HAHA_BOOTSTRAPPED__ = false
    const add = window.addEventListener.bind(window)
    vi.spyOn(window, 'addEventListener').mockImplementation((type, listener, options) => {
      handlers.push([type, listener, options])
      add(type, listener, options)
    })
    if (!script) throw new Error('Startup watchdog script missing')
    // Execute the shipped HTML, including its timer and resource error listener.
    // eslint-disable-next-line no-new-func
    new Function(script)()
  })

  afterEach(() => {
    for (const [type, listener, options] of handlers.splice(0)) {
      window.removeEventListener(type, listener, options)
    }
    delete window.__CC_HAHA_BOOTSTRAPPED__
    delete window.__CC_HAHA_SHOW_STARTUP_ERROR__
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('keeps a slow download in a loading state after eight seconds', () => {
    vi.advanceTimersByTime(8000)
    expect(document.querySelector('h1')?.textContent).toBe('Loading application…')
    expect(document.body.textContent).not.toContain('Desktop startup failed')
  })

  it('does not replace a real startup error with the loading notice', () => {
    window.__CC_HAHA_SHOW_STARTUP_ERROR__?.(new Error('bundle failed'))
    vi.advanceTimersByTime(8000)
    expect(document.querySelector('h1')?.textContent).toBe('Desktop startup failed')
    expect(document.body.textContent).toContain('bundle failed')
  })

  it('still reports failed resources after showing the loading notice', () => {
    vi.advanceTimersByTime(8000)
    const resource = document.createElement('script')
    resource.src = '/assets/missing.js'
    document.head.appendChild(resource)
    resource.dispatchEvent(new Event('error'))
    expect(document.querySelector('h1')?.textContent).toBe('Desktop startup failed')
    expect(document.body.textContent).toContain('/assets/missing.js')
    resource.remove()
  })

  it('leaves a mounted application intact', () => {
    window.__CC_HAHA_BOOTSTRAPPED__ = true
    document.getElementById('root')!.textContent = 'Chat is ready'
    vi.advanceTimersByTime(8000)
    expect(document.getElementById('root')!.textContent).toBe('Chat is ready')
  })
})
