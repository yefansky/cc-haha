import { describe, it, expect } from 'vitest'
import { buildContextBreakdown } from './contextBreakdown'
import { translate } from '../i18n'
import type { SessionContextSnapshot } from '../api/sessions'
const t = (key: Parameters<typeof translate>[1], params?: Record<string, string | number>) => translate('en', key, params)
const snapshot = (categories: SessionContextSnapshot['categories'], totalTokens: number): SessionContextSnapshot => ({
  categories, totalTokens, rawMaxTokens: 256000, maxTokens: 256000, percentage: 5, gridRows: [], model: 'test', memoryFiles: [], mcpTools: [], agents: [],
})
const cat = (name: string, tokens: number, isDeferred = false) => ({ name, tokens, isDeferred, color: 'promptBorder' })
describe('context source breakdown', () => {
  it('retains all seven sources and excludes capacity and deferred tools', () => {
    const names = ['System prompt', 'System tools', 'Memory files', 'Skills', 'MCP tools', 'Custom agents', 'Messages']
    const data = snapshot([...names.slice().reverse().map(n => cat(n, 100)), cat('Free space', 200000), cat('Autocompact buffer', 33000), cat('Compact buffer', 3000), cat('MCP tools (deferred)', 2000, true)], 700)
    const result = buildContextBreakdown(data, t)
    expect(result.rows.map(r => r.name)).toEqual(names)
    expect(result.rows.reduce((sum, r) => sum + r.tokens, 0)).toBe(700)
    expect(new Set(result.rows.map(r => r.color)).size).toBe(7)
  })
  it('exposes positive gaps without assigning them to messages', () => {
    const result = buildContextBreakdown(snapshot([cat('Messages', 100)], 150), t)
    expect(result.rows.map(r => r.tokens)).toEqual([100, 50])
    expect(result.rows[1]!.label).toBe('Unattributed usage')
  })
  it('reports overestimates without negative usage or rescaling', () => {
    const result = buildContextBreakdown(snapshot([cat('Messages', 200)], 150), t)
    expect(result.rows).toHaveLength(1)
    expect(result.rows[0]!.tokens).toBe(200)
    expect(result.mismatch).toContain('50 tokens')
  })
  it('preserves transcript-only categories without inventing sources', () => {
    const result = buildContextBreakdown(snapshot([cat('Input tokens', 20), cat('Cache read', 80)], 100), t)
    expect(result.rows.map(r => r.name)).toEqual(['Input tokens', 'Cache read'])
    expect(result.note).toContain('Transcript estimate only')
  })
  it('projects available details and excludes unloaded MCP definitions', () => {
    const data = snapshot(['Memory files', 'Skills', 'MCP tools', 'Custom agents'].map(n => cat(n, 100)), 400)
    data.memoryFiles = [{ path: '/rules/CLAUDE.md', type: 'project', tokens: 100 }]
    data.skills = { totalSkills: 2, includedSkills: 2, tokens: 100, skillFrontmatter: [{ name: 'small', source: 'local', tokens: 20 }, { name: 'large', source: 'local', tokens: 80 }] }
    data.mcpTools = [{ name: 'read', serverName: 'docs', tokens: 100, isLoaded: true }, { name: 'unused', serverName: 'docs', tokens: 500, isLoaded: false }]
    data.agents = [{ agentType: 'reviewer', source: 'local', tokens: 100 }]
    const result = buildContextBreakdown(data, t)
    expect(result.rows[0]!.items[0]!.name).toBe('/rules/CLAUDE.md')
    expect(result.rows[1]!.items.map(i => i.name)).toEqual(['large', 'small'])
    expect(data.skills.skillFrontmatter[0]!.name).toBe('small')
    expect(result.rows[2]!.items).toHaveLength(1)
    expect(result.rows[3]!.items[0]!.name).toBe('reviewer (local)')
  })
})
