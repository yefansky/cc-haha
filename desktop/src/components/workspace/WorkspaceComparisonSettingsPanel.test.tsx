import '@testing-library/jest-dom/vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { WorkspaceComparisonSettingsPanel } from './WorkspaceComparisonSettingsPanel'
import { createDefaultWorkspaceComparisonSettings } from './workspaceComparisonSettings'

describe('WorkspaceComparisonSettingsPanel', () => {
  it('keeps edits in a draft and applies a complete validated snapshot atomically', () => {
    const onApply = vi.fn()
    const original = createDefaultWorkspaceComparisonSettings('a.cpp')
    render(<WorkspaceComparisonSettingsPanel path="a.cpp" settings={original} onApply={onApply} onCancel={() => {}} />)

    fireEvent.change(screen.getByLabelText('Algorithm profile'), { target: { value: 'precise' } })
    fireEvent.click(screen.getByLabelText('Ignore case'))
    expect(original.profile).toBe('balanced')
    fireEvent.click(screen.getByRole('button', { name: 'Apply settings' }))
    expect(onApply).toHaveBeenCalledWith(expect.objectContaining({ profile: 'precise', ignoreCase: true }))
  })

  it('shows compile errors, retains the old applied settings, and supports cancel/defaults', () => {
    const onApply = vi.fn()
    const onCancel = vi.fn()
    render(<WorkspaceComparisonSettingsPanel
      path="a.cpp"
      settings={{ ...createDefaultWorkspaceComparisonSettings('a.cpp'), profile: 'fast' }}
      onApply={onApply}
      onCancel={onCancel}
    />)
    fireEvent.click(screen.getByRole('button', { name: 'Add rule' }))
    fireEvent.change(screen.getByLabelText('Rule pattern 1'), { target: { value: '(?=x)' } })
    fireEvent.click(screen.getByRole('button', { name: 'Apply settings' }))
    const alert = screen.getByRole('alert')
    const pattern = screen.getByLabelText('Rule pattern 1')
    expect(alert).toHaveTextContent('lookaround')
    expect(pattern).toHaveAttribute('aria-invalid', 'true')
    expect(pattern).toHaveAttribute('aria-describedby', alert.id)
    expect(onApply).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Restore defaults' }))
    expect(screen.getByLabelText('Algorithm profile')).toHaveValue('balanced')
    fireEvent.click(screen.getByRole('button', { name: 'Cancel settings' }))
    expect(onCancel).toHaveBeenCalledOnce()
  })

  it('disables Apply with an explicit fail-closed reason for incomplete comparisons', () => {
    render(<WorkspaceComparisonSettingsPanel
      path="a.cpp"
      settings={createDefaultWorkspaceComparisonSettings('a.cpp')}
      disabledReason="Complete decoded content is required."
      onApply={() => {}}
      onCancel={() => {}}
    />)
    expect(screen.getByRole('button', { name: 'Apply settings' })).toBeDisabled()
    expect(screen.getByRole('status')).toHaveTextContent('Complete decoded content is required.')
  })
})
