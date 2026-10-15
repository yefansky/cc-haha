import '@testing-library/jest-dom/vitest'
import { useState } from 'react'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { WorkspaceComparisonSide } from '@/api/sessions'
import { WorkspaceSideBySideDiffSurface } from './WorkspaceSideBySideDiffSurface'
import { createWorkspaceComparisonSession } from './workspaceComparisonSession'
const side = (content: string): WorkspaceComparisonSide => ({ source: { kind: 'working_tree', path: 'data.tab', revision: 'working-tree' }, exists: true, state: 'ok', content, requestedEncoding: 'auto', actualEncoding: 'gbk', bom: 'none', lineEnding: 'crlf', writable: true })
beforeEach(() => { vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} }) })
afterEach(() => { cleanup(); vi.unstubAllGlobals() })
it('aligns insertions, sorts naturally, edits the original line and retains CRLF and trailing cells', async () => {
  const saved = vi.fn()
  const left = 'ID\tName\tValue\r\n2\ttwo\t\r\n10\tten\tx\r\n'
  const right = 'ID\tName\tValue\r\n2\ttwo\t\r\n3\tnew\t\r\n10\tten\ty\r\n'
  function Harness() {
    const [session, update] = useState(createWorkspaceComparisonSession({ schemaVersion: 1, left: side(left), right: side(right) })!)
    return <WorkspaceSideBySideDiffSurface path="data.tab" value="" comparisonSession={session} onComparisonSessionChange={update} onSave={saved} />
  }
  render(<Harness />)
  await waitFor(() => expect(screen.queryByText('正在对齐表格…')).not.toBeInTheDocument())
  const leftPane = screen.getByTestId('table-pane-left'), rightPane = screen.getByTestId('table-pane-right')
  expect(within(leftPane).getAllByRole('row')).toHaveLength(4)
  expect(within(leftPane).getAllByRole('row')[2]).toHaveTextContent('—')
  fireEvent.click(within(rightPane).getByRole('button', { name: '1: ID' }))
  fireEvent.click(within(rightPane).getByRole('button', { name: '1: ID ↑' }))
  expect(within(rightPane).getAllByRole('row')[1]).toHaveTextContent('ten')
  fireEvent.doubleClick(within(rightPane).getByTitle('ten'))
  fireEvent.change(screen.getByLabelText('编辑单元格'), { target: { value: 'edited' } })
  fireEvent.click(screen.getByRole('button', { name: '应用' }))
  await waitFor(() => expect(screen.queryByText('正在对齐表格…')).not.toBeInTheDocument())
  fireEvent.click(screen.getByRole('button', { name: /^保存$/ }))
  expect(saved.mock.calls[0]![0].right.content).toBe('ID\tName\tValue\r\n2\ttwo\t\r\n3\tnew\t\r\n10\tedited\ty\r\n')
  expect(saved.mock.calls[0]![0].left.content).toBe(left)
  fireEvent.click(screen.getByRole('button', { name: '撤销' }))
  await waitFor(() => expect(within(rightPane).getByTitle('ten')).toBeInTheDocument())
})
it('virtualizes both axes and can reach the final row without truncating input', async () => {
  const content = ['ID\t'+Array.from({length: 99},(_,i)=>'Col'+i).join('\t'), ...Array.from({ length: 12000 }, (_, i) => [i, ...Array(99).fill('value')].join('\t'))].join('\n')
  render(<WorkspaceSideBySideDiffSurface path="large.tab" value="" comparison={{ schemaVersion: 1, left: side(content), right: side(content) }} />)
  await waitFor(() => expect(screen.queryByText('正在对齐表格…')).not.toBeInTheDocument(), { timeout: 20000 })
  const pane = screen.getByTestId('table-pane-right')
  expect(within(pane).getAllByRole('gridcell').length).toBeLessThan(300)
  fireEvent.scroll(pane, { target: { scrollTop: 11999 * 28, scrollLeft: 14000 } })
  expect(within(pane).getAllByRole('row').some(row => row.textContent?.startsWith('12001'))).toBe(true)
  expect(screen.getByTestId('table-pane-left').scrollTop).toBe(pane.scrollTop)
})
