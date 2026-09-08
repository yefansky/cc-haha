import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import '@testing-library/jest-dom'
import { ProjectFoldersDialog } from './ProjectFoldersDialog'
import { normalizeProjectFolderKey, useProjectFoldersStore } from '@/stores/projectFoldersStore'

vi.mock('@/i18n', () => ({
  useTranslation: () => (key: string, params?: Record<string, string>) => params?.folder ? `${key} ${params.folder}` : key,
}))
vi.mock('@/components/composite/DirectoryPicker', () => ({
  DirectoryPicker: ({ onChange }: { onChange: (path: string) => void }) => (
    <div><button onClick={() => onChange('/fixtures/external')}>Select external</button><button onClick={() => onChange('/fixtures/project')}>Select project</button></div>
  ),
}))

describe('ProjectFoldersDialog', () => {
  beforeEach(() => {
    localStorage.clear()
    useProjectFoldersStore.setState({ projects: {} })
  })
  afterEach(cleanup)

  it('adds, searches and detaches folders without changing another project', () => {
    useProjectFoldersStore.getState().addMountedRoot('/fixtures/other', '/fixtures/external')
    render(<ProjectFoldersDialog projectPath="/fixtures/project" onClose={vi.fn()} />)
    const add = screen.getByRole('button', { name: 'workspace.addAttachedFolder' })
    expect(add).toBeDisabled()
    fireEvent.click(screen.getByRole('button', { name: 'Select external' }))
    fireEvent.click(add)
    expect(screen.getByText('/fixtures/external')).toBeInTheDocument()
    fireEvent.change(screen.getByRole('textbox', { name: 'workspace.searchAttachedFolders' }), { target: { value: 'absent' } })
    expect(screen.getByText('workspace.noMatchingAttachedFolders')).toBeInTheDocument()
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'external' } })
    fireEvent.click(screen.getByRole('button', { name: 'workspace.removeAttachedFolder external' }))
    expect(screen.getByText('workspace.noAttachedFolders')).toBeInTheDocument()
    expect(useProjectFoldersStore.getState().projects[normalizeProjectFolderKey('/fixtures/other')]?.mountedRoots).toHaveLength(1)
  })

  it('prevents selecting the project itself or a duplicate and retains mounts on reopen', () => {
    const first = render(<ProjectFoldersDialog projectPath="/fixtures/project" onClose={vi.fn()} />)
    fireEvent.click(screen.getByRole('button', { name: 'Select project' }))
    expect(screen.getByRole('button', { name: 'workspace.addAttachedFolder' })).toBeDisabled()
    fireEvent.click(screen.getByRole('button', { name: 'Select external' }))
    fireEvent.click(screen.getByRole('button', { name: 'workspace.addAttachedFolder' }))
    first.unmount()
    render(<ProjectFoldersDialog projectPath="/fixtures/project" onClose={vi.fn()} />)
    expect(screen.getByText('/fixtures/external')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Select external' }))
    expect(screen.getByRole('button', { name: 'workspace.addAttachedFolder' })).toBeDisabled()
  })
})
