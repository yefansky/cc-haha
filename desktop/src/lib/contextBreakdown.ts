import type { SessionContextSnapshot } from '../api/sessions'
import type { TranslationKey } from '../i18n'

export type ContextBreakdownRow = {
  name: string
  label: string
  tokens: number
  color: string
  hint?: string
  items: Array<{ name: string; tokens: number }>
}

type Translate = (key: TranslationKey, params?: Record<string, string | number>) => string
const capacity = new Set(['free space', 'autocompact buffer', 'compact buffer'])
const definitions: Array<[string, TranslationKey, string]> = [
  ['System prompt', 'contextBreakdown.system', '#9ca3af'],
  ['System tools', 'contextBreakdown.tools', '#b482d5'],
  ['Memory files', 'contextBreakdown.rules', '#41a76b'],
  ['Skills', 'contextBreakdown.skills', '#edb45f'],
  ['MCP tools', 'contextBreakdown.mcp', '#b590ad'],
  ['Custom agents', 'contextBreakdown.agents', '#7e9fbf'],
  ['Messages', 'contextBreakdown.messages', '#a76988'],
]
const fallbackLabels: Record<string, TranslationKey> = {
  'Input tokens': 'contextBreakdown.input', 'Output tokens': 'contextBreakdown.output',
  'Cache read': 'contextBreakdown.cacheRead', 'Cache write': 'contextBreakdown.cacheWrite',
  'Estimated context': 'contextBreakdown.estimated',
}

/** A presentation projection only: never changes provider accounting or invents missing categories. */
export function buildContextBreakdown(context: SessionContextSnapshot, t: Translate) {
  const categories = context.categories.filter(c => Number.isFinite(c.tokens) && c.tokens > 0
    && !c.isDeferred && !capacity.has(c.name.toLowerCase()))
  const rows: ContextBreakdownRow[] = categories.map(category => {
    const name = category.name.replace('[ANT-ONLY] ', '')
    const definition = definitions.find(d => d[0] === name)
    let items: ContextBreakdownRow['items'] = []
    let hint: string | undefined
    switch (name) {
      case 'System prompt': items = context.systemPromptSections ?? []; break
      case 'System tools': items = context.systemTools ?? []; break
      case 'Memory files':
        items = context.memoryFiles.map(f => ({ name: f.path, tokens: f.tokens }))
        hint = t('contextBreakdown.rulesHint'); break
      case 'Skills':
        items = context.skills?.skillFrontmatter ?? []
        hint = t('contextBreakdown.skillsHint'); break
      case 'MCP tools':
        items = context.mcpTools.filter(f => f.isLoaded !== false).map(f => ({ name: `${f.serverName} / ${f.name}`, tokens: f.tokens })); break
      case 'Custom agents':
        items = context.agents.map(f => ({ name: `${f.agentType} (${f.source})`, tokens: f.tokens })); break
      case 'Messages': {
        hint = t('contextBreakdown.messagesHint')
        const b = context.messageBreakdown
        if (b) items = [
          { name: t('contextBreakdown.user'), tokens: b.userMessageTokens },
          { name: t('contextBreakdown.assistant'), tokens: b.assistantMessageTokens },
          { name: t('contextBreakdown.calls'), tokens: b.toolCallTokens },
          { name: t('contextBreakdown.results'), tokens: b.toolResultTokens },
          { name: t('contextBreakdown.attachments'), tokens: b.attachmentTokens },
        ]
        break
      }
    }
    return {
      name: category.name, label: definition ? t(definition[1]) : fallbackLabels[name] ? t(fallbackLabels[name]) : name,
      tokens: category.tokens, color: definition?.[2] ?? '#818cf8', hint,
      items: items.filter(i => Number.isFinite(i.tokens) && i.tokens > 0).slice().sort((a, b) => b.tokens - a.tokens),
    }
  })
  const order = (name: string) => {
    const index = definitions.findIndex(d => d[0] === name.replace('[ANT-ONLY] ', ''))
    return index < 0 ? definitions.length : index
  }
  rows.sort((a, b) => order(a.name) - order(b.name))
  const categoryTotal = rows.reduce((sum, row) => sum + row.tokens, 0)
  const difference = context.totalTokens - categoryTotal
  if (difference > 0) rows.push({
    name: 'Unattributed usage', label: t('contextBreakdown.unknown'), tokens: difference,
    color: '#64748b', hint: t('contextBreakdown.unknownHint'), items: [],
  })
  const fallback = categories.some(c => Object.prototype.hasOwnProperty.call(fallbackLabels, c.name))
  return {
    rows,
    note: t(fallback ? 'contextBreakdown.fallback' : 'contextBreakdown.note'),
    mismatch: difference < 0 ? t('contextBreakdown.mismatch', { tokens: Math.round(-difference).toLocaleString() }) : undefined,
  }
}
