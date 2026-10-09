import '@testing-library/jest-dom'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { FileDownloadLink } from './FileDownloadLink'
import { setAuthToken, setBaseUrl, getDefaultBaseUrl } from '../../api/client'
import { useSettingsStore } from '../../stores/settingsStore'
const url = 'https://gateway.example/preview-fs/s/%E6%8A%A5%E5%91%8A.md?download=1'
beforeEach(() => {
  setBaseUrl('https://gateway.example')
  setAuthToken(null)
  useSettingsStore.setState({ locale: 'en' })
})
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); setAuthToken(null); setBaseUrl(getDefaultBaseUrl()) })
describe('FileDownloadLink', () => {
  it('offers a native gateway download without touching the current preview', () => {
    render(<FileDownloadLink url={url} />)
    const link = screen.getByRole('link', { name: 'Download' })
    expect(link).toHaveAttribute('href', url)
    expect(link).toHaveAttribute('download', '报告.md')
    expect(link).toHaveAttribute('target', '_blank')
  })
  it('prepares authenticated H5 content without exposing the token in the URL, then saves by user gesture', async () => {
    setAuthToken('test-secret')
    const blob = new Blob(['# report'])
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, headers: new Headers({ 'content-disposition': 'attachment; filename="report.md"' }), blob: async () => blob })
    vi.stubGlobal('fetch', fetchMock)
    const create = vi.fn().mockReturnValue('blob:prepared')
    const revoke = vi.fn()
    URL.createObjectURL = create
    URL.revokeObjectURL = revoke
    const view = render(<FileDownloadLink url={url} />)
    fireEvent.click(screen.getByRole('link', { name: 'Download' }))
    await waitFor(() => expect(screen.getByRole('link', { name: 'Save file' })).toHaveAttribute('href', 'blob:prepared'))
    expect(fetchMock).toHaveBeenCalledWith(url, expect.objectContaining({ headers: { Authorization: 'Bearer test-secret' }, redirect: 'error' }))
    expect(create).toHaveBeenCalledWith(blob)
    view.unmount()
    expect(revoke).toHaveBeenCalledWith('blob:prepared')
  })
  it('shows a retryable error and never saves an auth error or a legacy inline response as a document', async () => {
    setAuthToken('test-secret')
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, headers: new Headers({ 'content-type': 'text/html' }) }))
    render(<FileDownloadLink url={url} />)
    fireEvent.click(screen.getByRole('link', { name: 'Download' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Download failed')
    expect(screen.getByRole('link', { name: 'Download' })).toBeInTheDocument()
    expect(screen.queryByRole('link', { name: 'Save file' })).not.toBeInTheDocument()
  })
})
