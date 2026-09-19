import '@testing-library/jest-dom'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
const doubles = vi.hoisted(() => ({ metadata: vi.fn(), open: vi.fn((..._args: unknown[]) => true), menu: vi.fn().mockResolvedValue([]), state: { statusBySession: { incident: { workDir: 'G:/Jx3_Classic/Sword3_Classic' } } } }))
vi.mock('../../api/sessions', () => ({ sessionsApi: { resolveFileReference: doubles.metadata } }))
vi.mock('../../lib/openPreviewLink', () => ({ openPreviewLink: doubles.open }))
vi.mock('../../lib/openWithMenuItems', () => ({ buildOpenWithMenuItemsForHref: doubles.menu }))
vi.mock('../../stores/workspacePanelStore', () => ({ useWorkspacePanelStore: Object.assign((fn: (s: typeof doubles.state) => unknown) => fn(doubles.state), { getState: () => doubles.state }) }))
vi.mock('./InlineImageGallery', () => ({ InlineImageGallery: () => null }))
vi.mock('./InlineVideoGallery', () => ({ InlineVideoGallery: () => null }))
vi.mock('./MessageActionBar', () => ({ MessageActionBar: () => null }))
vi.mock('./TurnCompletionStamp', () => ({ TurnCompletionStamp: () => null }))
import { AssistantMessage } from './AssistantMessage'
import { invalidateAssistantFileNavigation } from '../../lib/useAssistantFileActions'
import { buildTurnReferencedFilesByMessageId } from './MessageList'
import type { UIMessage } from '../../types/chat'
const inbox = 'lilin1/收件/2026-09-16-淬体成锋资料片全景复盘交付.md'
const html = '看板/叶帆周工作汇报_20260907至0913.html'
// Original file-bearing rows; unrelated private prose intentionally omitted.
const incident = '| 组 | 内容 |\n|---|---|\n| ① 归档机制 | `用户/yefan1/归档/` + `index.md` / `私有流程.md` / `私有规则.md` |\n| ② 发件文件 | `' + inbox + '` |\n| ③ 周报 HTML | `' + html + '` |'
const priorFiles = ['项目大脑/index.md', '项目大脑/项目专家/index.md', '项目大脑/看板/index.md'].map(p => 'G:/Jx3_Classic/Sword3_Classic/' + p)
function messages(files = priorFiles, content = incident): UIMessage[] {
  return [...files.map((file_path, i): UIMessage => ({ id: `read-${i}`, type: 'tool_use', toolName: 'Read', toolUseId: `r${i}`, input: { file_path }, timestamp: i + 1 })), { id: 'incident', type: 'assistant_text', content, timestamp: 10 }]
}
beforeEach(() => {
  invalidateAssistantFileNavigation()
  doubles.metadata.mockReset().mockImplementation(async (_session, request) => {
    const scope = { workDir: 'G:/Jx3_Classic/Sword3_Classic', permissionGeneration: 'fixture' }
    const candidates: string[] = request.candidates ?? []
    if (request.reference === 'index.md' && candidates.length > 1) return { state: 'ambiguous', complete: true, scope, candidates: candidates.map(path => ({ path, source: 'candidate' })) }
    const path = candidates[0] ?? (/^[a-z]:/i.test(request.reference) ? request.reference : `${scope.workDir}/${request.reference}`)
    return { state: 'resolved', complete: true, path, scope }
  })
})
afterEach(() => { cleanup(); doubles.open.mockClear(); doubles.menu.mockClear() })
it('preserves original relative inline paths without manufacturing slash-root evidence', async () => {
  const evidence = buildTurnReferencedFilesByMessageId(messages()).get('incident')
  expect(evidence).toEqual(priorFiles)
  render(<AssistantMessage sessionId="incident" content={incident} turnReferencedFiles={evidence} />)
  for (const name of [inbox, html]) {
    fireEvent.click(screen.getByRole('link', { name }))
    await waitFor(() => expect(doubles.open).toHaveBeenLastCalledWith(expect.stringContaining(name), 'incident'))
    expect(doubles.metadata.mock.calls.some(call => call[1].reference === name)).toBe(true)
  }
})
it('blocks ambiguous index click and context menu without creating an unlocated card', async () => {
  render(<AssistantMessage sessionId="incident" content={incident} turnReferencedFiles={buildTurnReferencedFilesByMessageId(messages()).get('incident')} />)
  const link = screen.getByRole('link', { name: 'index.md' })
  fireEvent.click(link)
  fireEvent.contextMenu(link)
  await waitFor(() => expect(screen.getByRole('alert')).toBeInTheDocument())
  expect(doubles.open).not.toHaveBeenCalled()
  expect(doubles.menu).not.toHaveBeenCalled()
  expect(screen.getAllByText('index.md')).toHaveLength(1)
})
it('uses the same uniquely located index for body and output card', async () => {
  const file = 'G:/Jx3_Classic/Sword3_Classic/项目大脑/用户/yefan1/index.md'
  const content = '`index.md`'
  const { container } = render(<AssistantMessage sessionId="incident" content={content} turnChangedFiles={[file]} turnReferencedFiles={buildTurnReferencedFilesByMessageId(messages([file], content)).get('incident')} />)
  fireEvent.click(screen.getByRole('link', { name: 'index.md' }))
  await waitFor(() => expect(doubles.open).toHaveBeenCalledTimes(1))
  const inlineCall = doubles.open.mock.calls.at(-1)
  const button = container.querySelector('button[aria-label]')
  expect(button).not.toBeNull()
  fireEvent.click(button!)
  await waitFor(() => expect(doubles.open).toHaveBeenCalledTimes(2))
  expect(doubles.open.mock.calls.at(-1)).toEqual(inlineCall)
  expect(inlineCall?.[0]).toContain('项目大脑/用户/yefan1/index.md')
})
it('does not let a later Read change the earlier message location', () => {
  const history = messages([priorFiles[0]!], '`index.md`')
  history.push({ id: 'later', type: 'tool_use', toolName: 'Read', toolUseId: 'later-read', input: { file_path: priorFiles[1]! }, timestamp: 11 })
  expect(buildTurnReferencedFilesByMessageId(history).get('incident')).toEqual([priorFiles[0]])
})
