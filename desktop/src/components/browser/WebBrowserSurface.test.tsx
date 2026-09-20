import '@testing-library/jest-dom'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { WebBrowserSurface } from './WebBrowserSurface'
import { useBrowserPanelStore } from '../../stores/browserPanelStore'
import { useSettingsStore } from '../../stores/settingsStore'
import { setBaseUrl, getDefaultBaseUrl } from '../../api/client'

beforeEach(() => {
  useBrowserPanelStore.setState(useBrowserPanelStore.getInitialState(), true)
  useSettingsStore.setState({ locale: 'en' })
  setBaseUrl('https://gateway.example')
})
afterEach(() => { cleanup(); setBaseUrl(getDefaultBaseUrl()) })

describe('WebBrowserSurface', () => {
  it('renders local HTML through the current gateway in an isolated frame and supports reload', () => {
    useBrowserPanelStore.getState().open('s', 'G:/reports/报告.html')
    render(<WebBrowserSurface sessionId="s" />)
    const frame = screen.getByTitle('Browser')
    expect(frame).toHaveAttribute('src', 'https://gateway.example/local-file/G%3A/reports/%E6%8A%A5%E5%91%8A.html')
    expect(frame).toHaveAttribute('sandbox', 'allow-scripts')
    fireEvent.load(frame)
    expect(useBrowserPanelStore.getState().bySession.s?.loading).toBe(false)
    fireEvent.click(screen.getByRole('button', { name: 'Reload' }))
    expect(screen.getByTitle('Browser')).not.toBe(frame)
    expect(useBrowserPanelStore.getState().bySession.s?.loading).toBe(true)
  })

  it('navigates back to a prior document and rejects executable URL schemes', () => {
    useBrowserPanelStore.getState().open('s', 'https://gateway.example/one.html')
    render(<WebBrowserSurface sessionId="s" />)
    act(() => useBrowserPanelStore.getState().navigate('s', 'https://gateway.example/two.html'))
    expect(screen.getByTitle('Browser')).toHaveAttribute('src', 'https://gateway.example/two.html')
    fireEvent.click(screen.getByRole('button', { name: 'Back' }))
    expect(screen.getByTitle('Browser')).toHaveAttribute('src', 'https://gateway.example/one.html')
    act(() => useBrowserPanelStore.getState().navigate('s', 'javascript:alert(1)'))
    expect(screen.queryByTitle('Browser')).not.toBeInTheDocument()
    expect(screen.getByRole('alert')).toBeInTheDocument()
  })
})
