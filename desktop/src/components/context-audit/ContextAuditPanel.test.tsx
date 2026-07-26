import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import '@testing-library/jest-dom'
import { describe, expect, it, vi } from 'vitest'
import { ContextAuditPanel } from './ContextAuditPanel'

const auditApiMock = vi.hoisted(() => ({
  getTrace: vi.fn(),
  getTraceCall: vi.fn(),
  getTraceRawBody: vi.fn(),
  createTraceDiagnosticBundle: vi.fn(),
  rename: vi.fn(),
}))

const testRequest = JSON.stringify({
  model: 'audit-test',
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

    const resultSummary = (await screen.findAllByText(/工具执行回包.*Glob.*Read/))
      .find((element) => element.tagName === 'SUMMARY')
    expect(resultSummary).toBeDefined()
    fireEvent.click(resultSummary!)

    expect(await screen.findByText(/关联的工具调用.*Glob/)).toBeInTheDocument()
    expect(await screen.findByText(/关联的工具调用.*Read/)).toBeInTheDocument()
    expect(screen.getAllByText('**/*.md').length).toBeGreaterThan(0)
    expect(screen.getAllByText('docs/process.md').length).toBeGreaterThan(0)
  })
})
