import { describe, expect, it, vi } from 'vitest'
import { AssistantFileNavigator, deriveFileReferenceHints } from './assistantFileNavigation'
const context = { server: 'test', sessionId: 's', workDir: 'G:/work', generation: '1' }
describe('reference hint derivation and compatible navigation', () => {
  it('uses longest directory overlap without hardcoded directory names', () => {
    expect(deriveFileReferenceHints('用户/yefan1/看板/a.html', ['G:/work/项目大脑/用户/yefan1/index.md'], 'G:/work').candidates)
      .toEqual(['G:/work/项目大脑/用户/yefan1/看板/a.html'])
    expect(deriveFileReferenceHints('team/alice/reports/a.html', ['/w/docs/team/alice/index.md'], '/w').candidates)
      .toEqual(['/w/docs/team/alice/reports/a.html'])
  })
  it('retains competing exact hints instead of choosing the first', async () => {
    const transport = vi.fn(async () => ({ state: 'ambiguous' as const, complete: true, candidates: [{ path: 'G:/work/a/index.md', source: 'exact' }, { path: 'G:/work/b/index.md', source: 'exact' }], scope: { workDir: 'G:/work', permissionGeneration: 1 } }))
    const navigator = new AssistantFileNavigator(transport)
    const result = await navigator.resolve('index.md', { ...context, referencedFiles: ['G:/work/a/index.md', 'G:/work/b/index.md'] })
    expect(result.href).toBeUndefined()
    expect(transport.mock.calls[0]?.length).toBeGreaterThan(0)
  })
  it('reports excessive overlap hints as incomplete without making a truncated request', async () => {
    const transport = vi.fn()
    const navigator = new AssistantFileNavigator(transport)
    const result = await navigator.resolve('index.md', { ...context, referencedFiles: Array.from({ length: 9 }, (_, n) => `G:/work/${n}/index.md`) })
    expect(result.state).toBe('incomplete')
    expect(transport).not.toHaveBeenCalled()
  })
  it('only uses old-service compatibility after authoritative legacy access succeeds', async () => {
    const transport = vi.fn(async () => { throw Object.assign(new Error('old'), { status: 404 }) })
    const verify = vi.fn(async () => true)
    const navigator = new AssistantFileNavigator(transport, verify)
    expect((await navigator.resolve('G:/work/a.md', context)).compatibility).toBe(true)
    verify.mockResolvedValue(false)
    expect((await navigator.resolve('G:/work/a.md', context)).href).toBeUndefined()
    expect(transport).toHaveBeenCalledTimes(1)
    expect(verify).toHaveBeenCalledTimes(2)
  })
})
