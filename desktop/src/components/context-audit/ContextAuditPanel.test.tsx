import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import '@testing-library/jest-dom'
import { describe, expect, it, vi } from 'vitest'
import { buildMessageSizeVisuals, buildMessageTimingVisuals, buildRelativeMetricVisuals, ContextAuditPanel } from './ContextAuditPanel'

const auditApiMock = vi.hoisted(() => ({
  getTrace: vi.fn(),
  getTraceCall: vi.fn(),
  getTraceRawBody: vi.fn(),
  createTraceDiagnosticBundle: vi.fn(),
  rename: vi.fn(),
}))

const testRequest = JSON.stringify({
  model: 'audit-test',
  system: 'system instructions',
  messages: [
    {
      role: 'assistant',
      content: [
        { type: 'tool_use', id: 'toolu-glob', name: 'Glob', input: { pattern: '**/*.md', path: 'docs' } },
        { type: 'tool_use', id: 'toolu-read', name: 'Read', input: { file_path: 'docs/process.md' } },
      ],
    },
    {
      role: 'user',
      content: [
        { type: 'tool_result', tool_use_id: 'toolu-glob', content: 'docs/process.md' },
        { type: 'tool_result', tool_use_id: 'toolu-read', content: '1 # Process' },
      ],
    },
  ],
})

const testCall = {
  id: 'call-1',
  sessionId: 'session-1',
  source: 'anthropic' as const,
  model: 'audit-test',
  status: 'ok' as const,
  startedAt: '2026-07-26T10:00:00.000Z',
  durationMs: 1250,
  request: {
    method: 'POST',
    url: 'https://example.test/v1/messages',
    headers: {},
    body: { contentType: 'json' as const, bytes: testRequest.length, sha256: 'test', preview: testRequest, truncated: false },
  },
}

vi.mock('../../api/sessions', () => ({
  sessionsApi: {
    ...auditApiMock,
  },
}))

vi.mock('../../api/traces', () => ({
  tracesApi: {
    exportSession: vi.fn(),
    getSettings: vi.fn(),
  },
}))

describe('ContextAuditPanel tool result correlation', () => {
  it('shows each matching tool call and its parameters beside a multi-tool result message', async () => {
    auditApiMock.getTrace.mockResolvedValue({
      sessionId: 'session-1',
      summary: { apiCalls: 1, failedCalls: 0, totalDurationMs: 1, totalInputTokens: 0, totalOutputTokens: 0, models: [], updatedAt: null },
      calls: [testCall],
    })
    auditApiMock.getTraceCall.mockResolvedValue({ call: testCall })
    const { container } = render(<ContextAuditPanel sessionId="session-1" />)

    await waitFor(() => expect(auditApiMock.getTrace).toHaveBeenCalledWith('session-1'))
    const callSummary = container.querySelector('details > summary')
    expect(callSummary).not.toBeNull()
    fireEvent.click(callSummary!)

    expect((await screen.findAllByLabelText(/占消息链/)).length).toBeGreaterThanOrEqual(2)
    const systemPromptSummary = (await screen.findAllByText('系统提示'))
      .find((element) => element.tagName === 'SUMMARY')
    expect(systemPromptSummary?.closest('details')).not.toHaveAttribute('open')
    const resultSummary = (await screen.findAllByText(/工具执行回包.*Glob.*Read/))
      .map((element) => element.closest('summary'))
      .find((element): element is HTMLElement => element !== null)
    expect(resultSummary).toBeDefined()
    expect(screen.getAllByText('**/*.md').length).toBeGreaterThan(0)
    expect(screen.getAllByText('docs/process.md').length).toBeGreaterThan(0)
    fireEvent.click(resultSummary!)

    expect(await screen.findByText(/关联的工具调用.*Glob/)).toBeInTheDocument()
    expect(await screen.findByText(/关联的工具调用.*Read/)).toBeInTheDocument()
    expect(screen.getAllByText('**/*.md').length).toBeGreaterThan(0)
    expect(screen.getAllByText('docs/process.md').length).toBeGreaterThan(0)
  })
})

describe('buildMessageTimingVisuals', () => {
  it('associates assistant messages with the prior response and user/tool messages with their following request', () => {
    const user = { role: 'user' as const, content: [{ type: 'text' as const, text: 'start' }] }
    const assistant = { role: 'assistant' as const, content: [{ type: 'text' as const, text: 'tool call' }] }
    const toolResult = { role: 'user' as const, content: [{ type: 'tool_result' as const, toolUseId: 'tool-1', content: 'done' }] }
    const assistantDone = { role: 'assistant' as const, content: [{ type: 'text' as const, text: 'final' }] }
    const call = (id: string, durationMs: number, startedAt: string) => ({ ...testCall, id, durationMs, startedAt })
    const visuals = buildMessageTimingVisuals(
      [user, assistant, toolResult, assistantDone],
      [
        { call: call('call-1', 100, '2026-07-26T10:00:00.000Z'), messages: [user] },
        { call: call('call-2', 200, '2026-07-26T10:00:01.000Z'), messages: [user, assistant] },
        { call: call('call-3', 300, '2026-07-26T10:00:02.000Z'), messages: [user, assistant, toolResult, assistantDone] },
      ],
    )

    expect(visuals.map((visual) => visual.durationMs)).toEqual([100, 100, 300, 200])
    expect(visuals.map((visual) => visual.visual?.rank)).toEqual([3, 4, 1, 2])
    expect(visuals.map((visual) => visual.attribution)).toEqual([
      'following-request',
      'previous-response',
      'following-request',
      'previous-response',
    ])
  })
})

describe('buildMessageSizeVisuals', () => {
  it('ranks the seven largest messages and scales every bar against the largest one', () => {
    const visuals = buildMessageSizeVisuals([100, 80, 60, 50, 40, 30, 20, 10])

    expect(visuals[0]).toMatchObject({ share: expect.closeTo(100 / 390), relativeWidth: 1, rank: 1 })
    expect(visuals[6]).toMatchObject({ relativeWidth: 0.2, rank: 7 })
    expect(visuals[7]).toMatchObject({ relativeWidth: 0.1, rank: 8 })
  })

  it('keeps empty message lists and equal-size messages deterministic', () => {
    expect(buildMessageSizeVisuals([])).toEqual([])
    expect(buildMessageSizeVisuals([0, 0])).toEqual([
      { bytes: 0, share: 0, relativeWidth: 0, rank: 1 },
      { bytes: 0, share: 0, relativeWidth: 0, rank: 2 },
    ])
  })
})

describe('buildRelativeMetricVisuals', () => {
  it('gives the longest operation a full-width duration bar and a stable rank', () => {
    expect(buildRelativeMetricVisuals([500, 2_000, 1_000])).toEqual([
      { share: 1 / 7, relativeWidth: 0.25, rank: 3 },
      { share: 4 / 7, relativeWidth: 1, rank: 1 },
      { share: 2 / 7, relativeWidth: 0.5, rank: 2 },
    ])
  })
})
