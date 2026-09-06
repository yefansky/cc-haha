import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import '@testing-library/jest-dom'
import { ProviderProtocolBadge } from './ProviderProtocolBadge'
import { useSettingsStore } from '@/stores/settingsStore'
import type { ApiFormat, ProviderModelCatalogEntry } from '@/types/provider'

const model = (id: string, apiFormat?: ApiFormat): ProviderModelCatalogEntry => ({ id, capabilities: [], ...(apiFormat ? { transport: { apiFormat, endpoint: 'https://example.test/endpoint' } } : {}) })
const initial = useSettingsStore.getState()

describe('provider list protocol badge', () => {
  beforeEach(() => useSettingsStore.setState({ locale: 'zh' }))
  afterEach(() => { cleanup(); useSettingsStore.setState(initial) })

  it('replaces a single-protocol label when the same provider gains multiple actual transports', () => {
    const view = render(<ProviderProtocolBadge provider={{ apiFormat: 'openai_responses', modelCatalog: [model('gpt', 'openai_responses')] }} />)
    expect(screen.getByText('OpenAI Responses')).toBeInTheDocument()
    view.rerender(<ProviderProtocolBadge provider={{ apiFormat: 'openai_responses', modelCatalog: [model('gpt', 'openai_responses'), model('grok', 'openai_chat'), model('claude', 'anthropic')] }} />)
    expect(screen.getByText('多协议')).toBeInTheDocument()
    expect(screen.queryByText('OpenAI Responses')).not.toBeInTheDocument()
    view.rerender(<ProviderProtocolBadge provider={{ apiFormat: 'openai_chat', modelCatalog: [model('grok', 'openai_chat')] }} />)
    expect(screen.getByText('OpenAI Chat')).toBeInTheDocument()
    expect(screen.queryByText('多协议')).not.toBeInTheDocument()
  })

  it('does not count repeated formats or missing transport metadata as another protocol', () => {
    render(<ProviderProtocolBadge provider={{ apiFormat: 'openai_responses', modelCatalog: [model('one', 'openai_responses'), model('two', 'openai_responses'), model('legacy')] }} />)
    expect(screen.getByText('OpenAI Responses')).toBeInTheDocument()
    expect(screen.queryByText('多协议')).not.toBeInTheDocument()
  })

  it('preserves the absence of a badge for ordinary Anthropic providers', () => {
    const { container } = render(<ProviderProtocolBadge provider={{ apiFormat: 'anthropic', modelCatalog: [model('one', 'anthropic')] }} />)
    expect(container).toBeEmptyDOMElement()
  })

  it('localizes the multi-protocol label without depending on a provider brand', () => {
    useSettingsStore.setState({ locale: 'en' })
    render(<ProviderProtocolBadge provider={{ apiFormat: 'anthropic', modelCatalog: [model('a', 'anthropic'), model('b', 'openai_chat')] }} />)
    expect(screen.getByText('Multiple protocols')).toBeInTheDocument()
  })
})
