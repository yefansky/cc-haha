import '@testing-library/jest-dom'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
const fixture = vi.hoisted(() => ({
  resolve: vi.fn(), legacy: vi.fn(), open: vi.fn((..._args: unknown[]) => true), menu: vi.fn().mockResolvedValue([]),
  state: { statusBySession: { incident: { workDir: 'G:/fixture' } } },
}))
vi.mock('../../api/sessions', () => ({ sessionsApi: { resolveFileReference: fixture.resolve, getWorkspaceFile: fixture.legacy } }))
vi.mock('../../lib/openPreviewLink', () => ({ openPreviewLink: fixture.open }))
vi.mock('../../lib/openWithMenuItems', () => ({ buildOpenWithMenuItemsForHref: fixture.menu }))
vi.mock('../../lib/desktopRuntime', async orig => ({ ...(await orig<Record<string, unknown>>()), getServerBaseUrl: () => 'http://fixture.invalid' }))
vi.mock('../../stores/workspacePanelStore', () => ({ useWorkspacePanelStore: Object.assign((fn: (s: typeof fixture.state) => unknown) => fn(fixture.state), { getState: () => fixture.state, subscribe: () => () => {} }) }))
vi.mock('../../i18n', () => ({ t: (key: string) => key, useTranslation: () => (key: string) => key }))
vi.mock('./InlineImageGallery', () => ({ InlineImageGallery: () => null }))
vi.mock('./InlineVideoGallery', () => ({ InlineVideoGallery: () => null }))
vi.mock('./MessageActionBar', () => ({ MessageActionBar: () => null }))
vi.mock('./TurnCompletionStamp', () => ({ TurnCompletionStamp: () => null }))
import { AssistantMessage } from './AssistantMessage'
import { invalidateAssistantFileNavigation } from '../../lib/useAssistantFileActions'
const resolved = (path: string) => ({ state: 'resolved', path, complete: true, scope: { workDir: 'G:/fixture', permissionGeneration: '1' }, stats: { directories: 0, exactProbes: 1, entries: 0, elapsedMs: 1 } })
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done }); return { promise, resolve } }
beforeEach(() => { invalidateAssistantFileNavigation(); fixture.resolve.mockReset(); fixture.legacy.mockReset(); fixture.open.mockClear(); fixture.menu.mockClear(); fixture.state.statusBySession.incident.workDir = 'G:/fixture' })
afterEach(() => cleanup())
it('planned missing HTML is not promoted to an output card and cannot navigate', async () => {
  fixture.resolve.mockResolvedValue({ state: 'missing', complete: true, scope: { workDir: 'G:/fixture', permissionGeneration: '1' } })
  render(<AssistantMessage sessionId="incident" content="下一步再生成 `用户/yefan1/看板/planned.html`" />)
  expect(screen.queryByRole('button', { name: 'assistantOutputs.open' })).toBeNull()
  fireEvent.click(screen.getByRole('link', { name: '用户/yefan1/看板/planned.html' }))
  await waitFor(() => expect(screen.getByRole('alert')).toBeInTheDocument())
  expect(fixture.open).not.toHaveBeenCalled()
})
it('body, known artifact card and context menu receive the same verified absolute target', async () => {
  const path = 'G:/fixture/docs/shared.md'
  fixture.resolve.mockResolvedValue(resolved(path))
  render(<AssistantMessage sessionId="incident" content="`docs/shared.md`" turnChangedFiles={[path]} />)
  const body = screen.getByRole('link', { name: 'docs/shared.md' })
  fireEvent.click(body)
  await waitFor(() => expect(fixture.open).toHaveBeenCalledTimes(1))
  fireEvent.click(screen.getByRole('button', { name: 'assistantOutputs.open' }))
  await waitFor(() => expect(fixture.open).toHaveBeenCalledTimes(2))
  expect(fixture.open.mock.calls[1]).toEqual(fixture.open.mock.calls[0])
  expect(fixture.open.mock.calls[0]?.[0]).toBe(path)
  fireEvent.contextMenu(body)
  await waitFor(() => expect(fixture.menu).toHaveBeenCalledWith(path, expect.objectContaining({ sessionId: 'incident' })))
})
it('late click A and component unmount cannot navigate after newer click B', async () => {
  const a = deferred<ReturnType<typeof resolved>>()
  fixture.resolve.mockImplementation((_session, request) => request.reference.includes('a.md') ? a.promise : Promise.resolve(resolved('G:/fixture/b.md')))
  const view = render(<AssistantMessage sessionId="incident" content="`a.md` 与 `b.md`" />)
  fireEvent.click(screen.getByRole('link', { name: 'a.md' }))
  fireEvent.click(screen.getByRole('link', { name: 'b.md' }))
  await waitFor(() => expect(fixture.open).toHaveBeenCalledTimes(1))
  expect(fixture.open.mock.calls[0]?.[0]).toBe('G:/fixture/b.md')
  view.unmount()
  await act(async () => a.resolve(resolved('G:/fixture/a.md')))
  expect(fixture.open).toHaveBeenCalledTimes(1)
})
it('cached location still checks exact metadata before an opener that would serve old cached content', async () => {
  const path = 'G:/fixture/archive/cache.md'
  let allowed = true, exists = true, scans = 0, exact = 0
  fixture.resolve.mockImplementation(async (_session, request) => {
    if (request.reference === 'cache.md') { scans++; return resolved(path) }
    exact++
    return !allowed ? { state: 'denied', complete: false } : !exists ? { state: 'missing', complete: true } : resolved(path)
  })
  // The opener always succeeds, representing a preview with an already cached body.
  render(<AssistantMessage sessionId="incident" content="`cache.md`" />)
  const link = screen.getByRole('link', { name: 'cache.md' })
  fireEvent.click(link)
  await waitFor(() => expect(fixture.open).toHaveBeenCalledTimes(1))
  fireEvent.click(link)
  await waitFor(() => expect(fixture.open).toHaveBeenCalledTimes(2))
  expect(scans).toBe(1); expect(exact).toBe(1)
  allowed = false
  fireEvent.click(link)
  await waitFor(() => expect(screen.getByRole('alert')).toBeInTheDocument())
  expect(fixture.open).toHaveBeenCalledTimes(2)
  allowed = true; exists = false
  fireEvent.click(link)
  await waitFor(() => expect(exact).toBe(3))
  expect(fixture.open).toHaveBeenCalledTimes(2)
  expect(scans).toBe(1)
})
it('unmounting with the only lookup pending prevents all navigation', async () => {
  const work = deferred<ReturnType<typeof resolved>>()
  fixture.resolve.mockReturnValue(work.promise)
  const view = render(<AssistantMessage sessionId="incident" content="`unmount.md`" />)
  fireEvent.click(screen.getByRole('link', { name: 'unmount.md' }))
  await waitFor(() => expect(fixture.resolve).toHaveBeenCalled())
  view.unmount()
  await act(async () => work.resolve(resolved('G:/fixture/unmount.md')))
  expect(fixture.open).not.toHaveBeenCalled()
})
it('workspace change while metadata is pending invalidates the old response', async () => {
  const work = deferred<ReturnType<typeof resolved>>()
  fixture.resolve.mockReturnValue(work.promise)
  const view = render(<AssistantMessage sessionId="incident" content="`moved.md`" />)
  fireEvent.click(screen.getByRole('link', { name: 'moved.md' }))
  await waitFor(() => expect(fixture.resolve).toHaveBeenCalled())
  fixture.state.statusBySession.incident.workDir = 'G:/other'
  view.rerender(<AssistantMessage sessionId="incident" content="`moved.md` updated" />)
  await act(async () => work.resolve(resolved('G:/fixture/moved.md')))
  expect(fixture.open).not.toHaveBeenCalled()
})
it('legacy API 404 never bypasses ambiguity into a basename navigation', async () => {
  fixture.resolve.mockRejectedValue(Object.assign(new Error('legacy'), { status: 404 }))
  render(<AssistantMessage sessionId="incident" content="`index.md`" turnReferencedFiles={['G:/fixture/a/index.md', 'G:/fixture/b/index.md']} />)
  fireEvent.click(screen.getByRole('link', { name: 'index.md' }))
  await waitFor(() => expect(screen.getByRole('alert')).toBeInTheDocument())
  expect(fixture.open).not.toHaveBeenCalled()
})
it('changed message evidence invalidates a pending old target', async () => {
  const work = deferred<ReturnType<typeof resolved>>()
  fixture.resolve.mockReturnValue(work.promise)
  const view = render(<AssistantMessage sessionId="incident" content="`evidence.md`" turnReferencedFiles={['G:/fixture/old/evidence.md']} />)
  fireEvent.click(screen.getByRole('link', { name: 'evidence.md' }))
  await waitFor(() => expect(fixture.resolve).toHaveBeenCalled())
  view.rerender(<AssistantMessage sessionId="incident" content="`evidence.md`" turnReferencedFiles={['G:/fixture/new/evidence.md']} />)
  await act(async () => work.resolve(resolved('G:/fixture/old/evidence.md')))
  expect(fixture.open).not.toHaveBeenCalled()
})
it('a later click in another assistant message owns the same session preview', async () => {
  const old = deferred<ReturnType<typeof resolved>>()
  fixture.resolve.mockImplementation((_session, request) => request.reference.includes('earlier.md') ? old.promise : Promise.resolve(resolved('G:/fixture/later.md')))
  render(<><AssistantMessage sessionId="incident" content="`earlier.md`" /><AssistantMessage sessionId="incident" content="`later.md`" /></>)
  fireEvent.click(screen.getByRole('link', { name: 'earlier.md' }))
  await waitFor(() => expect(fixture.resolve).toHaveBeenCalled())
  fireEvent.click(screen.getByRole('link', { name: 'later.md' }))
  await waitFor(() => expect(fixture.open).toHaveBeenCalledTimes(1))
  expect(fixture.open.mock.calls[0]?.[0]).toBe('G:/fixture/later.md')
  await act(async () => old.resolve(resolved('G:/fixture/earlier.md')))
  expect(fixture.open).toHaveBeenCalledTimes(1)
})
it('relative link with unique tool evidence retains discovery caching on repeated clicks', async () => {
  const path = 'G:/fixture/项目大脑/用户/private/repeated.md'
  const references: string[] = []
  fixture.resolve.mockImplementation(async (_session, request) => { references.push(request.reference); return resolved(path) })
  render(<AssistantMessage sessionId="incident" content="`用户/private/repeated.md`" turnReferencedFiles={[path]} />)
  const link = screen.getByRole('link', { name: '用户/private/repeated.md' })
  fireEvent.click(link)
  await waitFor(() => expect(fixture.open).toHaveBeenCalledTimes(1))
  fireEvent.click(link)
  await waitFor(() => expect(fixture.open).toHaveBeenCalledTimes(2))
  expect(references).toEqual(['用户/private/repeated.md', path])
})
it.each([true, false])('legacy 404 checks old file endpoint authorization before opening an explicit file: %s', async allowed => {
  fixture.resolve.mockRejectedValue(Object.assign(new Error('old backend'), { status: 404 }))
  if (allowed) fixture.legacy.mockResolvedValue({ state: 'ok', content: 'fixture' })
  else fixture.legacy.mockRejectedValue(Object.assign(new Error('outside workspace'), { status: 403 }))
  render(<AssistantMessage sessionId="incident" content="`G:/fixture/legacy.md`" />)
  fireEvent.click(screen.getByRole('link', { name: 'G:/fixture/legacy.md' }))
  await waitFor(() => expect(fixture.legacy).toHaveBeenCalled())
  if (allowed) await waitFor(() => expect(fixture.open).toHaveBeenCalledWith('G:/fixture/legacy.md', 'incident'))
  else {
    await waitFor(() => expect(screen.getByRole('alert')).toBeInTheDocument())
    expect(fixture.open).not.toHaveBeenCalled()
  }
})
it('bare source.ts line and column use metadata resolution and preserve editor reveal suffix', async () => {
  fixture.resolve.mockResolvedValue(resolved('G:/fixture/source.ts'))
  render(<AssistantMessage sessionId="incident" content="`source.ts:42:7`" />)
  fireEvent.click(screen.getByRole('link', { name: 'source.ts:42:7' }))
  await waitFor(() => expect(fixture.open).toHaveBeenCalledWith('G:/fixture/source.ts:42:7', 'incident'))
  expect(fixture.resolve).toHaveBeenCalledTimes(1)
  expect(fixture.resolve.mock.calls[0]?.[1].reference).not.toContain(':42')
})
