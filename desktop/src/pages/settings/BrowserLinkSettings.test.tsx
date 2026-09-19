import '@testing-library/jest-dom'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
vi.mock('../../i18n', () => ({ useTranslation: () => (key: string) => key }))
import { BrowserLinkSettings } from './BrowserLinkSettings'
import { useBrowserLinkPreference } from '../../lib/browserLinkPreference'
afterEach(() => { cleanup(); useBrowserLinkPreference.getState().setPreference('auto') })
it('saves the browser selection locally without a server settings request', () => {
  render(<BrowserLinkSettings />)
  fireEvent.click(screen.getByRole('button', { name: 'openWith.currentDeviceBrowser' }))
  expect(useBrowserLinkPreference.getState().preference).toBe('system')
  expect(JSON.parse(localStorage.getItem('cc-haha-browser-link-preference')!).state.preference).toBe('system')
  fireEvent.click(screen.getByRole('button', { name: 'settings.browserLinks.auto' }))
  expect(useBrowserLinkPreference.getState().preference).toBe('auto')
})
