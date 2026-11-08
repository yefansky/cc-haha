import { beforeEach, describe, expect, it } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import { ToolCallBlock } from './ToolCallBlock'
import { ToolCallGroup } from './ToolCallGroup'
import { useSettingsStore } from '@/stores/settingsStore'

describe('subagent route', () => {
  beforeEach(() => useSettingsStore.setState({ locale: 'en' }))

  it('shows requested route through the real tool group while collapsed', () => {
    render(<ToolCallGroup
      sessionId="route-owner"
      agentTaskNotifications={{}}
      toolCalls={[{ id: 'agent', toolUseId: 'agent', type: 'tool_use', toolName: 'Agent', timestamp: 1, input: { description: 'Inspect source', prompt: 'Inspect files', cli: 'codex', provider: 'tokenhub', model: 'grok-4.7', effort: 'middle' } }]}
      resultMap={new Map()}
      childToolCallsByParent={new Map()}
    />)
    fireEvent.click(screen.getByRole('button', { name: /dispatched an agent/ }))
    const route = screen.getByTestId('agent-requested-route')
    expect(route.textContent).toContain('Requested route')
    expect(route.textContent).toContain('Method: External CLI')
    expect(route.textContent).toContain('CLI: codex')
    expect(route.textContent).toContain('Provider: tokenhub')
    expect(route.textContent).toContain('Model: grok-4.7')
    expect(route.textContent).toContain('Effort: medium')
  })

  it('shows inheritance for old inputs and preserves failure details after expanding', () => {
    render(<ToolCallBlock toolName="Agent" input={{ description: 'Check task', prompt: 'Inspect files' }} result={{ content: 'CLI not found: codex', isError: true }} />)
    const route = screen.getByTestId('agent-requested-route')
    expect(route.textContent).toContain('Method: Native agent')
    expect(route.textContent).toContain('Model: Inherit parent')
    expect(route.textContent).toContain('Effort: Inherit parent')
    expect(route.textContent).toContain('Provider: Parent first; fallback allowed')
    fireEvent.click(screen.getByRole('button', { name: /Check task/ }))
    expect(screen.getAllByText('CLI not found: codex').length).toBeGreaterThan(0)
  })

  it('shows the actual result route separately when fallback chose another provider', () => {
    render(<ToolCallBlock toolName="Agent" input={{ description: 'Routed task', model: 'grok-4.7' }} result={{ content: '[route {"method":"cli","cli":"cc-haha","model":"grok-4.7","effort":"high","provider":"fallback-provider"}]\nDone', isError: false }} />)
    const actual = screen.getByTestId('agent-actual-route')
    expect(actual.textContent).toContain('Actual route')
    expect(actual.textContent).toContain('Provider: fallback-provider')
    expect(actual.textContent).toContain('CLI: cc-haha')
    expect(actual.textContent).toContain('Effort: high')
  })

  it('joins the completed background notification to its original launch card', () => {
    render(<ToolCallGroup
      sessionId="route-owner"
      agentTaskNotifications={{ agent: { taskId: 'task-agent', toolUseId: 'agent', status: 'completed', summary: 'Done', result: '[route {"method":"cli","cli":"cc-haha","model":"grok-4.7","effort":"high","provider":"background-provider"}]\nDone' } }}
      toolCalls={[{ id: 'agent', toolUseId: 'agent', type: 'tool_use', toolName: 'Agent', timestamp: 1, input: { description: 'Background task', model: 'grok-4.7' } }]}
      resultMap={new Map([['agent', { id: 'launch', toolUseId: 'agent', type: 'tool_result', timestamp: 2, content: 'Async agent launched successfully.', isError: false }]])}
      childToolCallsByParent={new Map()}
    />)
    fireEvent.click(screen.getByRole('button', { name: /dispatched an agent/ }))
    expect(screen.getByTestId('agent-actual-route').textContent).toContain('Provider: background-provider')
  })

  it('ignores malformed route output without crashing or claiming success', () => {
    render(<ToolCallBlock toolName="Agent" input={{ description: 'Bad route' }} result={{ content: '[route not-json]', isError: true }} />)
    expect(screen.queryByTestId('agent-actual-route')).toBeNull()
  })

  it('keeps the outer runtime route when the returned text quotes a nested route', () => {
    const route = (provider: string) => `[route ${JSON.stringify({ method: 'cli', cli: 'cc-haha', model: 'grok-4.7', effort: 'medium', provider })}]`
    render(<ToolCallBlock toolName="Agent" input={{ description: 'Nested result' }} result={{ content: `${route('outer-provider')}\nQuoted child output:\n${route('inner-provider')}`, isError: false }} />)
    const actual = screen.getByTestId('agent-actual-route')
    expect(actual.textContent).toContain('Provider: outer-provider')
    expect(actual.textContent).not.toContain('inner-provider')
  })
})
