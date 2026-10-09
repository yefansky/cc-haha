import { useEffect, useRef, useState, type MouseEvent } from 'react'
import { Download } from 'lucide-react'
import { getAuthToken } from '../../api/client'
import { useTranslation } from '../../i18n'
import { previewFileDownloadUrl } from '../../lib/fileDownload'

/** Gateway cookies use a native download (streaming, including on mobile).
 * Bearer-auth H5 prepares a blob, then keeps a user-activated Save link. */
export function FileDownloadLink({ url }: { url: string }) {
  const t = useTranslation()
  const [prepared, setPrepared] = useState<{ source: string; blob: string } | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(false)
  const request = useRef<AbortController | null>(null)
  const safeUrl = previewFileDownloadUrl(url)
  useEffect(() => () => { if (prepared) URL.revokeObjectURL(prepared.blob) }, [prepared])
  useEffect(() => () => { request.current?.abort() }, [url])
  if (!safeUrl) return null
  const ready = prepared?.source === safeUrl ? prepared.blob : null
  const encodedName = new URL(safeUrl).pathname.split('/').pop() || 'download'
  let name = encodedName
  try { name = decodeURIComponent(encodedName) } catch { /* Keep malformed escapes literal. */ }
  async function prepare(event: MouseEvent<HTMLAnchorElement>) {
    event.stopPropagation()
    if (busy) { event.preventDefault(); return }
    const token = getAuthToken()
    if (!token || ready) return
    event.preventDefault()
    const controller = new AbortController()
    request.current = controller
    setBusy(true)
    setError(false)
    try {
      const response = await fetch(safeUrl!, {
        headers: { Authorization: `Bearer ${token}` },
        credentials: 'same-origin', redirect: 'error', cache: 'no-store',
        signal: controller.signal,
      })
      if (!response.ok || !response.headers.get('content-disposition')?.startsWith('attachment;')) {
        throw new Error('download failed')
      }
      const blob = await response.blob()
      if (!controller.signal.aborted) setPrepared({ source: safeUrl!, blob: URL.createObjectURL(blob) })
    } catch {
      if (!controller.signal.aborted) setError(true)
    } finally {
      if (!controller.signal.aborted) setBusy(false)
    }
  }
  const label = t(busy ? 'workspace.downloadPreparing' : ready ? 'workspace.downloadSave' : 'workspace.downloadFile')
  return (
    <span className="relative inline-flex shrink-0">
      <a href={ready || safeUrl} download={name} target="_blank" rel="noopener noreferrer"
        aria-label={label} title={label} aria-disabled={busy} onClick={prepare}
        className="inline-flex min-h-8 items-center gap-1 rounded px-2 text-xs text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-hover)]">
        <Download size={16} aria-hidden="true" /><span>{label}</span>
      </a>
      {error && <span role="alert" className="absolute right-0 top-full z-10 w-52 rounded bg-[var(--color-surface)] p-2 text-xs text-[var(--color-error)]">{t('workspace.downloadFailed')}</span>}
    </span>
  )
}
