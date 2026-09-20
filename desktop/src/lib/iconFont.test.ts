import { describe, expect, it, vi } from 'vitest'
import { initializeIconFont } from './iconFont'

describe('icon font on slow remote connections', () => {
  it('keeps text hidden until the actual icon font has loaded', async () => {
    let finish!: () => void
    let ready = false
    const doc = { documentElement: { dataset: {} as Record<string, string> }, fonts: {
      load: vi.fn(() => new Promise<void>((resolve) => { finish = resolve })),
      check: () => ready, addEventListener: vi.fn(), removeEventListener: vi.fn(),
    } }
    initializeIconFont(doc as unknown as Document)
    expect(doc.documentElement.dataset.iconFont).toBe('loading')
    ready = true
    finish()
    await Promise.resolve()
    expect(doc.documentElement.dataset.iconFont).toBe('ready')
  })
  it('does not reveal ligature words on failure and recovers after a later load', async () => {
    let listener!: () => void
    const doc = { documentElement: { dataset: {} as Record<string, string> }, fonts: {
      load: () => Promise.reject(new Error('offline')), check: () => true,
      addEventListener: (_: string, handler: () => void) => { listener = handler }, removeEventListener: vi.fn(),
    } }
    initializeIconFont(doc as unknown as Document)
    await Promise.resolve(); await Promise.resolve()
    expect(doc.documentElement.dataset.iconFont).toBe('loading')
    listener()
    expect(doc.documentElement.dataset.iconFont).toBe('ready')
  })
})
