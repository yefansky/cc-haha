import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import '@testing-library/jest-dom'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { useSettingsStore } from '../../stores/settingsStore'
import { useUIStore } from '../../stores/uiStore'
import { LayoutSettings } from './LayoutSettings'

describe('LayoutSettings', () => {
  beforeEach(() => {
    useSettingsStore.setState({ locale: 'en' })
    useUIStore.setState({ layoutStyle: 'classic', sessionSidebarPlacement: 'left' })
  })

  afterEach(() => cleanup())

  it('switches to the VS Code workspace and moves the session list independently', () => {
    render(<LayoutSettings />)

    fireEvent.click(screen.getByRole('radio', { name: 'VS Code style' }))
    expect(useUIStore.getState().layoutStyle).toBe('vscode')
    expect(screen.getByText(/file tree on the left/i)).toBeInTheDocument()

    fireEvent.click(screen.getByRole('radio', { name: 'Far right' }))
    expect(useUIStore.getState().sessionSidebarPlacement).toBe('right')
  })
})
