import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { ChevronDown, Download, FileText, FolderOpen, Loader2, RefreshCw, ShieldCheck } from 'lucide-react'
import { sessionsApi } from '../../api/sessions'
import { tracesApi } from '../../api/traces'
import { formatBytes } from '../../lib/formatBytes'
import { formatDurationMs } from '../../lib/trace/formatters'
import { getDesktopHost } from '../../lib/desktopHost'
import { parseTraceRequestBody } from '../../lib/trace/requestParse'
import { useChatStore } from '../../stores/chatStore'
import { useSessionStore } from '../../stores/sessionStore'
import { useTabStore } from '../../stores/tabStore'
import type { NormalizedBlock, NormalizedMessage } from '../../lib/trace/types'
import type { TraceCallRecord, TraceRawBody, TraceSession } from '../../types/trace'
import { MarkdownRenderer } from '../markdown/MarkdownRenderer'
import { CopyButton } from '@/components/ui/CopyButton'
import { useTranslation, type TranslationKey } from '../../i18n'

const POLL_INTERVAL_MS = 1_500
const LARGE_BODY_BYTES = 100 * 1024
const MAX_MARKDOWN_RENDER_CHARS = 500_000
const HIGH_TOKEN_COUNT = 50_000
type Translate = ReturnType<typeof useTranslation>

type BodyLoad = {
  text: string
  isFull: boolean
  file?: string
}

type ToolCallReference = {
  id: string
  name: string
  input: unknown
}

export type MessageTimingVisual = {
  durationMs?: number
  visual?: RelativeMetricVisual
  attribution?: 'previous-response' | 'following-request'
}

export type HistoricalRequest = {
  call: TraceCallRecord
  messages: NormalizedMessage[]
}

type ContextAuditPanelProps = {
  sessionId: string
}

/**
 * A session-local audit surface for the model request bodies that actually left
 * cc-haha. It intentionally never invents file attribution: a file is shown
 * only when its path occurs explicitly in the captured request text.
 */
export function ContextAuditPanel({ sessionId }: ContextAuditPanelProps) {
  const t = useTranslation()
  const [trace, setTrace] = useState<TraceSession | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [exporting, setExporting] = useState(false)

  const refresh = async () => {
    try {
      const next = await sessionsApi.getTrace(sessionId)
      setTrace(next)
      setError(null)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    setTrace(null)
    setLoading(true)
    setError(null)
    void refresh()
    const timer = window.setInterval(() => void refresh(), POLL_INTERVAL_MS)
    return () => window.clearInterval(timer)
  }, [sessionId])

  const calls = useMemo(
    () => (trace?.calls ?? []).slice().sort((left, right) => right.startedAt.localeCompare(left.startedAt)),
    [trace?.calls],
  )
  const totalRequestBytes = calls.reduce((total, call) => total + call.request.body.bytes, 0)
  const capturedFullCount = calls.filter((call) => Boolean(call.request.body.fullCapture)).length

  const download = async () => {
    setExporting(true)
    try {
      const payload = await tracesApi.exportSession(sessionId)
      const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' })
      const href = URL.createObjectURL(blob)
      const anchor = document.createElement('a')
      anchor.href = href
      anchor.download = `cc-haha-context-audit-${sessionId}.json`
      anchor.click()
      URL.revokeObjectURL(href)
    } finally {
      setExporting(false)
    }
  }

  const openFolder = async () => {
    const storageDir = trace ? await tracesApi.getSettings().then((settings) => settings.storageDir) : null
    if (storageDir && getDesktopHost().capabilities.shell) {
      await getDesktopHost().shell.openPath(storageDir)
    }
  }

  return (
    <div className="flex h-full min-h-0 flex-col bg-[var(--color-surface)]">
      <header className="shrink-0 border-b border-[var(--color-border)] px-4 py-3">
        <div className="flex items-center gap-2">
          <ShieldCheck size={17} className="text-[var(--color-info)]" aria-hidden="true" />
          <div className="min-w-0 flex-1">
            <h2 className="text-sm font-semibold text-[var(--color-text-primary)]">{t('contextAudit.title')}</h2>
            <p className="mt-0.5 text-[11px] leading-4 text-[var(--color-text-tertiary)]">
              {t('contextAudit.description')}
            </p>
          </div>
          <button
            type="button"
            aria-label={t('contextAudit.refreshLabel')}
            title={t('contextAudit.refresh')}
            onClick={() => void refresh()}
            className="inline-flex h-7 w-7 items-center justify-center rounded-md text-[var(--color-text-tertiary)] hover:bg-[var(--color-surface-hover)] hover:text-[var(--color-text-primary)]"
          >
            <RefreshCw size={14} className={loading ? 'animate-spin' : ''} />
          </button>
        </div>
        <div className="mt-3 grid grid-cols-3 gap-2">
          <Metric label={t('contextAudit.requestCount')} value={String(calls.length)} />
          <Metric label={t('contextAudit.totalBytes')} value={formatBytes(totalRequestBytes)} />
          <Metric label={t('contextAudit.fullCaptures')} value={`${capturedFullCount}/${calls.length}`} />
        </div>
        <div className="mt-3 flex flex-wrap gap-2">
          <button
            type="button"
            onClick={() => void download()}
            disabled={exporting || !trace}
            className="inline-flex items-center gap-1.5 rounded-md border border-[var(--color-border)] px-2 py-1 text-[11px] font-medium text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)] disabled:opacity-50"
          >
            {exporting ? <Loader2 size={13} className="animate-spin" /> : <Download size={13} />}
            {t('contextAudit.exportJson')}
          </button>
          <button
            type="button"
            onClick={() => void openFolder()}
            disabled={!trace || !getDesktopHost().capabilities.shell}
            title={getDesktopHost().capabilities.shell ? t('contextAudit.openTraceFolder') : t('contextAudit.desktopFolderOnly')}
            className="inline-flex items-center gap-1.5 rounded-md border border-[var(--color-border)] px-2 py-1 text-[11px] font-medium text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)] disabled:opacity-50"
          >
            <FolderOpen size={13} />
            {t('contextAudit.openFolder')}
          </button>
        </div>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto p-3">
        {loading && !trace ? <LoadingState /> : null}
        {error ? <div role="alert" className="rounded-md border border-[var(--color-error)]/30 bg-[var(--color-error)]/10 p-3 text-xs text-[var(--color-error)]">{error}</div> : null}
        {!loading && !error && calls.length === 0 ? <EmptyState /> : null}
        <div className="flex flex-col gap-2">
          {calls.map((call, index) => (
            <ContextAuditCall
              key={call.id}
              sessionId={sessionId}
              call={call}
              previous={findPreviousCall(trace?.calls ?? [], call)}
              allCalls={trace?.calls ?? []}
              newestIndex={index}
              callCount={calls.length}
            />
          ))}
        </div>
      </div>
    </div>
  )
}

function ContextAuditCall({
  sessionId,
  call,
  previous,
  allCalls,
  newestIndex,
  callCount,
}: {
  sessionId: string
  call: TraceCallRecord
  previous: TraceCallRecord | undefined
  allCalls: TraceCallRecord[]
  newestIndex: number
  callCount: number
}) {
  const t = useTranslation()
  const [open, setOpen] = useState(false)
  const [currentBody, setCurrentBody] = useState<BodyLoad>({ text: call.request.body.preview, isFull: false })
  const [previousBody, setPreviousBody] = useState<BodyLoad | null>(null)
  const [messageTimings, setMessageTimings] = useState<MessageTimingVisual[] | null>(null)
  const [detail, setDetail] = useState<TraceCallRecord | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [diagnosticQuestion, setDiagnosticQuestion] = useState('')
  const [creatingDiagnostic, setCreatingDiagnostic] = useState(false)
  const [diagnosticError, setDiagnosticError] = useState<string | null>(null)

  useEffect(() => {
    if (!open) return
    let cancelled = false
    const load = async () => {
      try {
        const [currentDetail, priorDetail] = await Promise.all([
          sessionsApi.getTraceCall(sessionId, call.id),
          previous ? sessionsApi.getTraceCall(sessionId, previous.id) : Promise.resolve(null),
        ])
        const nextCall = currentDetail.call
        const priorCall = priorDetail?.call ?? null
        const [request, priorRequest, historicalRequests] = await Promise.all([
          loadRequestBody(sessionId, nextCall),
          priorCall ? loadRequestBody(sessionId, priorCall) : Promise.resolve(null),
          loadHistoricalRequests(sessionId, allCalls),
        ])
        if (cancelled) return
        setDetail(nextCall)
        setCurrentBody(request)
        setPreviousBody(priorRequest)
        const parsedCurrent = parseTraceRequestBody(request.text, nextCall.source)
        setMessageTimings(parsedCurrent ? buildMessageTimingVisuals(parsedCurrent.messages, historicalRequests) : null)
        setLoadError(null)
      } catch (cause) {
        if (!cancelled) setLoadError(cause instanceof Error ? cause.message : String(cause))
      }
    }
    void load()
    return () => { cancelled = true }
  }, [allCalls, call.id, open, previous?.id, sessionId])

  const activeCall = detail ?? call
  const analysis = useMemo(
    () => analyzeRequest(activeCall, currentBody.text, previousBody?.text ?? null, t),
    [activeCall, currentBody.text, previousBody?.text, t],
  )
  const risks = getRisks(activeCall, currentBody, analysis, t)

  const createDiagnosticSession = async () => {
    setCreatingDiagnostic(true)
    setDiagnosticError(null)
    try {
      const bundle = await sessionsApi.createTraceDiagnosticBundle(sessionId, activeCall.id, {
        question: diagnosticQuestion,
        ...(previous ? { comparisonCallId: previous.id } : {}),
      })
      const newSessionId = await useSessionStore.getState().createSession(bundle.workDir)
      const diagnosticTitle = t('contextAudit.diagnosticTitle')
      await sessionsApi.rename(newSessionId, diagnosticTitle)
      useSessionStore.getState().updateSessionTitle(newSessionId, diagnosticTitle)
      useTabStore.getState().openTab(newSessionId, diagnosticTitle)
      const chat = useChatStore.getState()
      chat.connectToSession(newSessionId, { prewarm: false })
      chat.setComposerDraft(newSessionId, { input: bundle.prompt, attachments: [] })
    } catch (cause) {
      setDiagnosticError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setCreatingDiagnostic(false)
    }
  }

  return (
    <details
      className="group overflow-hidden rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-container-low)]"
      onToggle={(event) => setOpen((event.currentTarget as HTMLDetailsElement).open)}
    >
      <summary className="flex cursor-pointer list-none items-center gap-2 px-3 py-2.5 hover:bg-[var(--color-surface-hover)]">
        <ChevronDown size={15} className="shrink-0 transition-transform group-open:rotate-180" />
        <span className="min-w-0 flex-1">
          <span className="flex items-center gap-2">
            <span className="text-xs font-semibold text-[var(--color-text-primary)]">{t('contextAudit.requestNumber', { number: callCount - newestIndex })}</span>
            {activeCall.status === 'pending' ? <Status label={t('contextAudit.sending')} tone="warning" /> : null}
            {activeCall.status === 'error' || activeCall.error ? <Status label={t('contextAudit.failed')} tone="error" /> : null}
          </span>
          <span className="mt-1 flex gap-2 overflow-hidden text-[10px] text-[var(--color-text-tertiary)]">
            <span>{formatDate(activeCall.startedAt)}</span>
            <span className="truncate">{activeCall.model ?? t('contextAudit.unknownModel')}</span>
          </span>
        </span>
        <span className="shrink-0 text-right text-[11px] text-[var(--color-text-secondary)]">
          <span className="block font-mono">{formatBytes(activeCall.request.body.bytes)}</span>
          <span className="block text-[10px] text-[var(--color-text-tertiary)]">{formatInputTokens(activeCall, t)}</span>
        </span>
      </summary>

      {open ? (
        <div className="border-t border-[var(--color-border)] px-3 py-3">
          {loadError ? <div role="alert" className="mb-2 text-xs text-[var(--color-error)]">{t('contextAudit.loadFullFailed', { error: loadError })}</div> : null}
          {risks.length > 0 ? (
            <div className="mb-3 flex flex-wrap gap-1.5">
              {risks.map((risk) => <Status key={risk} label={risk} tone="warning" />)}
            </div>
          ) : null}

          <details open className="rounded-md border border-[var(--color-border)] bg-[var(--color-surface)]">
            <summary className="cursor-pointer px-2.5 py-2 text-xs font-medium text-[var(--color-text-primary)]">{t('contextAudit.statsAndDiff')}</summary>
            <div className="border-t border-[var(--color-border)] p-2.5">
              <div className="grid grid-cols-2 gap-2">
                <Metric label={t('contextAudit.requestSize')} value={formatBytes(activeCall.request.body.bytes)} />
                <Metric label={t('contextAudit.roundTripDuration')} value={formatDurationMs(activeCall.durationMs)} />
                <Metric label={t('contextAudit.systemPrompt')} value={formatBytes(analysis.systemBytes)} />
                <Metric label={t('contextAudit.messages')} value={t('contextAudit.messageCounts', { total: analysis.messages, user: analysis.userMessages, assistant: analysis.assistantMessages })} />
                <Metric label={t('contextAudit.toolDefinitions')} value={t('contextAudit.itemCount', { count: analysis.tools })} />
                <Metric label={t('contextAudit.sincePrevious')} value={analysis.deltaLabel} />
                <Metric label={t('contextAudit.fileHints')} value={t('contextAudit.itemCount', { count: analysis.files.length })} />
              </div>
              <p className="mt-2 text-[10px] leading-4 text-[var(--color-text-tertiary)]">{t('contextAudit.durationHint')}</p>
              {analysis.files.length > 0 ? (
                <div className="mt-3">
                  <p className="text-[10px] leading-4 text-[var(--color-text-tertiary)]">{t('contextAudit.fileHintExplanation')}</p>
                  <div className="mt-1.5 max-h-36 overflow-y-auto rounded border border-[var(--color-border)] bg-[var(--color-surface-container-low)]">
                    {analysis.files.map((file) => (
                      <div key={file.path} className="flex items-center gap-2 border-b border-[var(--color-border)]/60 px-2 py-1.5 text-[10px] last:border-b-0">
                        <FileText size={12} className="shrink-0 text-[var(--color-text-tertiary)]" />
                        <span className="min-w-0 flex-1 truncate font-mono text-[var(--color-text-secondary)]" title={file.path}>{file.path}</span>
                        <span className="shrink-0 text-[var(--color-text-tertiary)]">{file.kind === 'content' ? t('contextAudit.contentKind') : t('contextAudit.markerKind')} {formatBytes(file.contextBytes)}</span>
                      </div>
                    ))}
                  </div>
                </div>
              ) : null}
              <details className="mt-3 rounded border border-[var(--color-border)] bg-[var(--color-surface-container-low)]">
                <summary className="cursor-pointer px-2 py-1.5 text-[10px] font-medium text-[var(--color-text-primary)]">{t('contextAudit.cacheAndMaterials')}</summary>
                <div className="space-y-3 border-t border-[var(--color-border)] p-2">
                  <p className="text-[10px] leading-4 text-[var(--color-text-tertiary)]">{t('contextAudit.cacheExplanation')}</p>
                  <div className="grid grid-cols-2 gap-2">
                    <Metric label={t('contextAudit.candidatePrefix')} value={analysis.cachePrefix.label} />
                    <Metric label={t('contextAudit.candidatePrefixSize')} value={formatBytes(analysis.cachePrefix.bytes)} />
                    <Metric label={t('contextAudit.serverCacheRead')} value={formatTokenMetric(activeCall.usage?.cacheReadInputTokens, t)} />
                    <Metric label={t('contextAudit.serverCacheCreation')} value={formatTokenMetric(activeCall.usage?.cacheCreationInputTokens, t)} />
                    <Metric label={t('contextAudit.compactionObservation')} value={analysis.compaction.label} />
                    <Metric label={t('contextAudit.messageBody')} value={formatBytes(analysis.messageBytes)} />
                  </div>
                  <MessageFootprint messages={analysis.messageFootprints} />
                  <MaterialWatch materials={analysis.materials} />
                  <p className="text-[10px] leading-4 text-[var(--color-text-tertiary)]">{t('contextAudit.attentionRiskHint')}</p>
                </div>
              </details>
            </div>
          </details>

          <details className="mt-2 rounded-md border border-[var(--color-border)] bg-[var(--color-surface)]">
            <summary className="cursor-pointer px-2.5 py-2 text-xs font-medium text-[var(--color-text-primary)]">{t('contextAudit.redactedRequest')}</summary>
            <div className="border-t border-[var(--color-border)] p-2.5">
              <div className="mb-2 flex items-center gap-2 text-[10px] text-[var(--color-text-tertiary)]">
                <span>{currentBody.isFull ? t('contextAudit.fullLocalBody') : t('contextAudit.requestCopy')}</span>
                {currentBody.file ? <span className="truncate font-mono">{currentBody.file}</span> : null}
                <CopyButton text={currentBody.text} label={t('contextAudit.copyBody')} copiedLabel={t('contextAudit.copied')} className="ml-auto shrink-0 rounded border border-[var(--color-border)] px-1.5 py-0.5 hover:text-[var(--color-text-primary)]" />
              </div>
          <FormattedRequestView call={activeCall} text={currentBody.text} messageTimings={messageTimings} />
              <details className="mt-2 rounded border border-[var(--color-border)] bg-[var(--color-surface-container-low)]">
                <summary className="cursor-pointer px-2 py-1.5 text-[10px] text-[var(--color-text-secondary)]">{t('contextAudit.rawJson')}</summary>
                <pre className="max-h-[520px] overflow-auto whitespace-pre-wrap break-words border-t border-[var(--color-border)] p-2 font-mono text-[10px] leading-4 text-[var(--color-text-secondary)]">{currentBody.text || t('contextAudit.emptyBody')}</pre>
              </details>
            </div>
          </details>

          <details className="mt-2 rounded-md border border-[var(--color-border)] bg-[var(--color-surface)]">
            <summary className="cursor-pointer px-2.5 py-2 text-xs font-medium text-[var(--color-text-primary)]">{t('contextAudit.createDiagnostic')}</summary>
            <div className="space-y-2 border-t border-[var(--color-border)] p-2.5">
              <p className="text-[10px] leading-4 text-[var(--color-text-tertiary)]">
                {t('contextAudit.diagnosticDescription')}
              </p>
              <textarea
                value={diagnosticQuestion}
                onChange={(event) => setDiagnosticQuestion(event.target.value)}
                rows={3}
                placeholder={t('contextAudit.diagnosticPlaceholder')}
                className="w-full resize-y rounded border border-[var(--color-border)] bg-[var(--color-surface-container-low)] px-2 py-1.5 text-xs text-[var(--color-text-primary)] outline-none focus:border-[var(--color-brand)]"
              />
              {!currentBody.isFull ? <p className="text-[10px] leading-4 text-[var(--color-warning)]">{t('contextAudit.diagnosticUnavailable')}</p> : null}
              {diagnosticError ? <p role="alert" className="text-[10px] text-[var(--color-error)]">{diagnosticError}</p> : null}
              <button
                type="button"
                onClick={() => void createDiagnosticSession()}
                disabled={creatingDiagnostic || !currentBody.isFull}
                title={currentBody.isFull ? undefined : t('contextAudit.diagnosticNeedsFullBody')}
                className="inline-flex items-center gap-1.5 rounded-md border border-[var(--color-border)] px-2 py-1 text-[11px] font-medium text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)] disabled:cursor-not-allowed disabled:opacity-50"
              >
                {creatingDiagnostic ? <Loader2 size={13} className="animate-spin" /> : <FileText size={13} />}
                {t('contextAudit.createDiagnostic')}
              </button>
            </div>
          </details>
        </div>
      ) : null}
    </details>
  )
}

type JsonRecord = Record<string, unknown>

type MessageFootprint = {
  index: number
  role: NormalizedMessage['role']
  label: string
  bytes: number
  blocks: number
  distanceFromTail: number
}

export type RelativeMetricVisual = {
  share: number
  relativeWidth: number
  rank: number
}

export type MessageSizeVisual = RelativeMetricVisual & {
  bytes: number
}

const MOST_EXPENSIVE_MESSAGE_COUNT = 7

export function buildRelativeMetricVisuals(values: number[]): RelativeMetricVisual[] {
  const total = values.reduce((sum, value) => sum + value, 0)
  const largestValue = Math.max(0, ...values)
  const ranks = values
    .map((value, index) => ({ value, index }))
    .sort((left, right) => right.value - left.value || left.index - right.index)
    .reduce<number[]>((result, entry, sortedIndex) => {
      result[entry.index] = sortedIndex + 1
      return result
    }, [])

  return values.map((value, index) => ({
    share: total === 0 ? 0 : value / total,
    relativeWidth: largestValue === 0 ? 0 : value / largestValue,
    rank: ranks[index] ?? index + 1,
  }))
}

export function buildMessageSizeVisuals(bytes: number[]): MessageSizeVisual[] {
  return buildRelativeMetricVisuals(bytes).map((visual, index) => ({ ...visual, bytes: bytes[index]! }))
}

function MessageSizeBar({ visual }: { visual: MessageSizeVisual }) {
  const t = useTranslation()
  const isTopConsumer = visual.rank <= MOST_EXPENSIVE_MESSAGE_COUNT
  const percentage = Math.round(visual.share * 100)
  const title = isTopConsumer
    ? t('contextAudit.messageShareRanked', { percentage, rank: visual.rank })
    : t('contextAudit.messageShareUnranked', { percentage })
  const fillOpacity = isTopConsumer ? 0.22 + (visual.relativeWidth * 0.68) : 0.12

  return (
    <span className="flex shrink-0 items-center gap-1.5" title={title} aria-label={title}>
      {isTopConsumer ? <span className="w-5 text-right font-mono text-[9px] font-medium text-[var(--color-info)]">#{visual.rank}</span> : null}
      <span className="h-1.5 w-16 overflow-hidden rounded-full bg-[var(--color-info)]/10" aria-hidden="true">
        <span
          className="block h-full rounded-full bg-[var(--color-info)]"
          style={{ width: `${visual.relativeWidth * 100}%`, opacity: fillOpacity }}
        />
      </span>
    </span>
  )
}

function CallMetricBar({
  label,
  visual,
  tone,
  title,
  unavailable = false,
  showRank = true,
}: {
  label: string
  visual?: RelativeMetricVisual
  tone: 'info' | 'warning'
  title: string
  unavailable?: boolean
  showRank?: boolean
}) {
  const t = useTranslation()
  const isTopConsumer = showRank && !unavailable && (visual?.rank ?? Infinity) <= MOST_EXPENSIVE_MESSAGE_COUNT
  const color = tone === 'info' ? 'var(--color-info)' : 'var(--color-warning)'
  const fillOpacity = showRank && isTopConsumer ? 0.22 + ((visual?.relativeWidth ?? 0) * 0.68) : 0.5
  const suffix = unavailable
    ? t('contextAudit.noTiming')
    : showRank
      ? isTopConsumer
        ? t('contextAudit.callShareRanked', { rank: visual?.rank ?? 0, percentage: Math.round((visual?.share ?? 0) * 100) })
        : t('contextAudit.callShare', { percentage: Math.round((visual?.share ?? 0) * 100) })
      : t('contextAudit.sharedTurnTiming')

  return (
    <span className="flex items-center gap-1" title={`${title} ${suffix}`} aria-label={`${label} ${suffix}`}>
      <span className="w-3 font-mono text-[9px] text-[var(--color-text-tertiary)]">{label}</span>
      <span className="h-1.5 w-12 overflow-hidden rounded-full" style={{ backgroundColor: `color-mix(in srgb, ${color} 10%, transparent)` }} aria-hidden="true">
        <span
          className="block h-full rounded-full"
          style={{ width: `${unavailable ? 0 : (visual?.relativeWidth ?? 0) * 100}%`, backgroundColor: color, opacity: fillOpacity }}
        />
      </span>
      {isTopConsumer ? <span className="w-3 font-mono text-[9px]" style={{ color }}>#{visual?.rank}</span> : <span className="w-3" />}
    </span>
  )
}

type ReadMaterial = {
  path: string
  bytes: number
  messageIndex: number
  distanceFromTail: number
  fingerprint: string
  watched: boolean
  state: 'first' | 'retained' | 'updated' | 'evicted'
}

function MessageFootprint({ messages }: { messages: MessageFootprint[] }) {
  const t = useTranslation()
  if (messages.length === 0) return null
  return (
    <details className="rounded border border-[var(--color-border)] bg-[var(--color-surface)]">
      <summary className="cursor-pointer px-2 py-1.5 text-[10px] font-medium text-[var(--color-text-primary)]">{t('contextAudit.messageFootprint', { count: messages.length })}</summary>
      <div className="max-h-48 overflow-y-auto border-t border-[var(--color-border)]">
        {messages.map((message) => (
          <div key={message.index} className="grid grid-cols-[auto_1fr_auto] items-center gap-2 border-b border-[var(--color-border)]/60 px-2 py-1.5 text-[10px] last:border-b-0">
            <span className="font-mono text-[var(--color-text-tertiary)]">{message.index}.</span>
            <span className="min-w-0 truncate text-[var(--color-text-secondary)]">{t('contextAudit.messageFootprintRow', { label: message.label, blocks: message.blocks, distance: message.distanceFromTail })}</span>
            <span className="font-mono text-[var(--color-text-primary)]">{formatBytes(message.bytes)}</span>
          </div>
        ))}
      </div>
    </details>
  )
}

function MaterialWatch({ materials }: { materials: ReadMaterial[] }) {
  const t = useTranslation()
  const watched = materials.filter((material) => material.watched)
  if (watched.length === 0) return <p className="text-[10px] text-[var(--color-text-tertiary)]">{t('contextAudit.noWatchedMaterials')}</p>
  return (
    <div>
      <p className="mb-1 text-[10px] font-medium text-[var(--color-text-primary)]">{t('contextAudit.watchedMaterials')}</p>
      <div className="max-h-48 overflow-y-auto rounded border border-[var(--color-border)] bg-[var(--color-surface)]">
        {watched.map((material) => (
          <div key={`${material.path}:${material.state}`} className="border-b border-[var(--color-border)]/60 px-2 py-1.5 text-[10px] last:border-b-0">
            <div className="flex items-center gap-2">
              <span className={`rounded px-1 py-0.5 ${material.state === 'evicted' ? 'bg-[var(--color-warning)]/10 text-[var(--color-warning)]' : 'bg-[var(--color-success)]/10 text-[var(--color-success)]'}`}>{t(`contextAudit.materialState.${material.state}` as TranslationKey)}</span>
              <span className="min-w-0 flex-1 truncate font-mono text-[var(--color-text-secondary)]" title={material.path}>{material.path}</span>
            </div>
            <div className="mt-1 text-[var(--color-text-tertiary)]">{t('contextAudit.materialDetails', { bytes: formatBytes(material.bytes), message: material.messageIndex || '—', distance: material.distanceFromTail || '—', fingerprint: material.fingerprint })}</div>
          </div>
        ))}
      </div>
    </div>
  )
}

function FormattedRequestView({ call, text, messageTimings }: { call: TraceCallRecord; text: string; messageTimings: MessageTimingVisual[] | null }) {
  const t = useTranslation()
  const request = useMemo(() => parseTraceRequestBody(text, call.source), [call.source, text])
  if (!request) {
    return <div className="rounded border border-dashed border-[var(--color-border)] p-2 text-[10px] text-[var(--color-text-tertiary)]">{t('contextAudit.unparseableJson')}</div>
  }

  const toolCalls = collectToolCalls(request.messages)
  const messageSizeVisuals = buildMessageSizeVisuals(
    request.messages.map((message) => byteLength(JSON.stringify(message.content))),
  )

  return (
    <div className="flex flex-col gap-2">
      {request.system !== undefined ? (
        <details className="rounded border border-[var(--color-border)]">
          <summary className="cursor-pointer px-2 py-1.5 text-[11px] font-medium text-[var(--color-text-primary)]">{t('contextAudit.systemPrompt')}</summary>
          <div className="border-t border-[var(--color-border)] p-2"><ReadableContent value={request.system} /></div>
        </details>
      ) : null}
      <details open className="rounded border border-[var(--color-border)]">
        <summary className="cursor-pointer px-2 py-1.5 text-[11px] font-medium text-[var(--color-text-primary)]">{t('contextAudit.messageChain', { count: request.messages.length })}</summary>
        <div className="flex flex-col gap-1.5 border-t border-[var(--color-border)] p-2">
          <p className="text-[10px] leading-4 text-[var(--color-text-tertiary)]">{t('contextAudit.barExplanation')}</p>
          {request.messages.map((message, index) => <ContextMessageView key={index} message={message} index={index} toolCalls={toolCalls} sizeVisual={messageSizeVisuals[index]!} timing={messageTimings?.[index]} />)}
          {request.messages.length === 0 ? <div className="text-[10px] text-[var(--color-text-tertiary)]">{t('contextAudit.noMessages')}</div> : null}
        </div>
      </details>
      {request.tools.length > 0 ? (
        <details className="rounded border border-[var(--color-border)]">
          <summary className="cursor-pointer px-2 py-1.5 text-[11px] font-medium text-[var(--color-text-primary)]">{t('contextAudit.toolDefinitionsCount', { count: request.tools.length })}</summary>
          <div className="border-t border-[var(--color-border)] p-2">
            {request.tools.map((tool, index) => (
              <details key={index} className="border-b border-[var(--color-border)]/70 py-1 last:border-b-0">
                <summary className="cursor-pointer font-mono text-[10px] text-[var(--color-text-secondary)]">{toolName(tool, index)}</summary>
                <div className="mt-1"><JsonValueView value={tool} /></div>
              </details>
            ))}
          </div>
        </details>
      ) : null}
      <details className="rounded border border-[var(--color-border)]">
        <summary className="cursor-pointer px-2 py-1.5 text-[11px] font-medium text-[var(--color-text-primary)]">{t('contextAudit.modelAndParameters')}</summary>
        <div className="max-h-56 overflow-auto border-t border-[var(--color-border)] p-2"><JsonValueView value={request.params} /></div>
      </details>
    </div>
  )
}

function roleLabel(role: NormalizedMessage['role'], t: Translate): string {
  return t(`contextAudit.role.${role}` as TranslationKey)
}

function ContextMessageView({ message, index, toolCalls, sizeVisual, timing }: { message: NormalizedMessage; index: number; toolCalls: Map<string, ToolCallReference>; sizeVisual: MessageSizeVisual; timing: MessageTimingVisual | undefined }) {
  const t = useTranslation()
  const contentBytes = message.content.reduce((total, block) => total + byteLength(blockText(block)), 0)
  const summaryLabel = messageSummaryLabel(message, toolCalls, t)
  const toolParameters = messageToolParameterSummary(message, toolCalls, t)
  return (
    <details className="rounded border border-[var(--color-border)] bg-[var(--color-surface-container-low)]">
      <summary className="flex cursor-pointer items-center gap-2 px-2 py-1.5 text-[10px] text-[var(--color-text-primary)]">
        <span className="min-w-0 flex-1">
          <span className="block truncate">{t('contextAudit.messageSummary', { index: index + 1, summary: summaryLabel, role: roleLabel(message.role, t), blocks: message.content.length, bytes: formatBytes(contentBytes) })}</span>
          {toolParameters ? <span className="block truncate font-mono text-[9px] text-[var(--color-text-tertiary)]" title={toolParameters}>{t('contextAudit.parameters', { parameters: toolParameters })}</span> : null}
        </span>
        <span className="flex shrink-0 items-center gap-2">
          <MessageSizeBar visual={sizeVisual} />
          <CallMetricBar label={t('contextAudit.durationShort')} visual={timing?.visual} tone="warning" title={messageTimingTitle(timing, t)} unavailable={timing?.durationMs === undefined} />
          <span className="w-9 font-mono text-right text-[9px] text-[var(--color-text-secondary)]">{formatDurationMs(timing?.durationMs)}</span>
        </span>
      </summary>
      <div className="flex flex-col gap-2 border-t border-[var(--color-border)] p-2">
        {message.content.map((block, blockIndex) => <ContextBlockView key={blockIndex} block={block} toolCalls={toolCalls} />)}
      </div>
    </details>
  )
}

function messageSummaryLabel(message: NormalizedMessage, toolCalls: Map<string, ToolCallReference>, t: Translate): string {
  const toolResults = message.content.filter((block): block is Extract<NormalizedBlock, { type: 'tool_result' }> => block.type === 'tool_result')
  if (toolResults.length > 0) {
    const toolLabels = toolResults.map((result) => result.toolUseId ? toolCalls.get(result.toolUseId)?.name ?? result.toolUseId : t('contextAudit.unknownTool'))
    const status = toolResults.every((result) => result.isError) ? t('contextAudit.toolFailed') : t('contextAudit.toolResult')
    return t('contextAudit.toolListSummary', { status, tools: toolLabels.join(t('contextAudit.listSeparator')) })
  }
  const toolUses = message.content.filter((block): block is Extract<NormalizedBlock, { type: 'tool_use' }> => block.type === 'tool_use')
  if (toolUses.length > 0) return t('contextAudit.toolListSummary', { status: t('contextAudit.toolCall'), tools: toolUses.map((toolUse) => toolUse.name || t('contextAudit.unnamedTool')).join(t('contextAudit.listSeparator')) })
  return roleLabel(message.role, t)
}

function messageToolParameterSummary(message: NormalizedMessage, toolCalls: Map<string, ToolCallReference>, t: Translate): string | null {
  const references: ToolCallReference[] = []
  for (const block of message.content) {
    if (block.type === 'tool_use') references.push({ id: block.id ?? '', name: block.name ?? '', input: block.input })
    if (block.type === 'tool_result' && block.toolUseId) {
      const reference = toolCalls.get(block.toolUseId)
      if (reference) references.push(reference)
    }
  }
  if (references.length === 0) return null
  return references.map((reference) => toolCallParameterSummary(reference, t)).join(t('contextAudit.parameterSeparator'))
}

function toolCallParameterSummary(toolCall: ToolCallReference, t: Translate): string {
  const name = toolCall.name || t('contextAudit.unnamedTool')
  if (!isJsonRecord(toolCall.input)) return `${name}(${compactValue(toolCall.input)})`
  const input = toolCall.input
  const lowerName = name.toLowerCase()
  const select = (...keys: string[]) => keys
    .map((key) => input[key])
    .find((value) => value !== undefined && value !== '')

  if (lowerName === 'read') return `${name}(${compactValue(select('file_path', 'filePath', 'path'))})`
  if (lowerName === 'grep') {
    const pattern = compactValue(select('pattern', 'query'))
    const path = compactValue(select('path', 'directory', 'cwd'))
    const glob = compactValue(select('glob', 'include'))
    return `${name}(${[pattern, path && t('contextAudit.pathParameter', { path }), glob && `glob=${glob}`].filter(Boolean).join(t('contextAudit.argumentSeparator'))})`
  }
  if (lowerName === 'bash' || lowerName === 'shell') return `${name}(${compactValue(select('command', 'cmd', 'script'))})`
  const entries = Object.entries(input).slice(0, 2).map(([key, value]) => `${key}=${compactValue(value)}`)
  return `${name}(${entries.join(t('contextAudit.argumentSeparator')) || t('contextAudit.noParameters')})`
}

function compactValue(value: unknown): string {
  if (value === undefined || value === null || value === '') return '—'
  const text = typeof value === 'string' ? value : JSON.stringify(value)
  return text.length > 96 ? `${text.slice(0, 93)}…` : text
}

function ContextBlockView({ block, toolCalls }: { block: NormalizedBlock; toolCalls: Map<string, ToolCallReference> }) {
  const t = useTranslation()
  switch (block.type) {
    case 'text':
      return <ContentBlock label={t('contextAudit.textContent')}><ReadableContent value={block.text} /></ContentBlock>
    case 'thinking':
      return <ContentBlock label={t('contextAudit.thinkingContent')}><ReadableContent value={block.thinking} /></ContentBlock>
    case 'tool_use':
      return <ContentBlock label={t('contextAudit.toolLabel', { tool: block.name || t('contextAudit.unnamedTool') })} meta={block.id}><JsonValueView value={block.input} /></ContentBlock>
    case 'tool_result': {
      const toolCall = block.toolUseId ? toolCalls.get(block.toolUseId) : undefined
      const toolName = toolCall?.name
      return <ContentBlock label={t('contextAudit.toolListSummary', { status: block.isError ? t('contextAudit.toolFailed') : t('contextAudit.toolResult'), tools: toolName ?? block.toolUseId ?? t('contextAudit.unknownTool') })} meta={block.toolUseId}>
        {toolCall ? <AssociatedToolCallView toolCall={toolCall} /> : <div className="mb-2 rounded border border-[var(--color-warning)]/30 bg-[var(--color-warning)]/10 px-2 py-1 text-[10px] text-[var(--color-text-secondary)]">{t('contextAudit.missingToolCall')}</div>}
        <ReadableContent value={block.content} stripReadLineNumbers={toolName?.toLowerCase() === 'read'} />
      </ContentBlock>
    }
    case 'image':
      return <ContentBlock label={block.mediaType ? t('contextAudit.imageContentTyped', { mediaType: block.mediaType }) : t('contextAudit.imageContent')} />
  }
}

function AssociatedToolCallView({ toolCall }: { toolCall: ToolCallReference }) {
  const t = useTranslation()
  return (
    <details open className="mb-2 rounded border border-[var(--color-info)]/30 bg-[var(--color-info)]/5 px-2 py-1.5">
      <summary className="cursor-pointer text-[10px] font-medium text-[var(--color-text-primary)]">
        {t('contextAudit.associatedToolCall', { tool: toolCall.name || t('contextAudit.unnamedTool') })}
        <span className="ml-1 font-mono font-normal text-[var(--color-text-tertiary)]">{toolCall.id}</span>
      </summary>
      <div className="mt-1.5 border-t border-[var(--color-info)]/20 pt-1.5">
        <div className="mb-1 text-[10px] text-[var(--color-text-secondary)]">{t('contextAudit.callParameters')}</div>
        <JsonValueView value={toolCall.input} />
      </div>
    </details>
  )
}

function ContentBlock({ label, meta, children }: { label: string; meta?: string; children?: ReactNode }) {
  return (
    <div className="rounded border border-[var(--color-border)] bg-[var(--color-surface)] p-2">
      <div className="mb-1 flex min-w-0 items-center gap-1.5 text-[10px] font-medium text-[var(--color-text-secondary)]">
        <span className="truncate">{label}</span>
        {meta ? <span className="truncate font-mono text-[9px] font-normal text-[var(--color-text-tertiary)]">{meta}</span> : null}
      </div>
      {children}
    </div>
  )
}

function ReadableContent({ value, stripReadLineNumbers = false }: { value: unknown; stripReadLineNumbers?: boolean }) {
  const t = useTranslation()
  const rawText = contentToText(value)
  const text = stripReadLineNumbers ? stripToolReadLineNumbers(rawText) : rawText
  if (!text) return <span className="text-[10px] text-[var(--color-text-tertiary)]">{t('contextAudit.empty')}</span>
  const parsedJson = tryParseJsonText(extractJsonPayload(text))
  if (parsedJson !== null) return <JsonValueView value={parsedJson} />
  if (text.length > MAX_MARKDOWN_RENDER_CHARS) {
    return <>
      <EncodingNotice text={text} />
      <pre className="max-h-[420px] overflow-auto whitespace-pre-wrap break-words rounded bg-[var(--color-surface-container-low)] p-2 font-mono text-[10px] leading-4 text-[var(--color-text-secondary)]">{beautifyDisplayText(text)}</pre>
    </>
  }
  return <>
    <EncodingNotice text={text} />
    <MarkdownRenderer content={beautifyDisplayText(text)} variant="compact" cache={false} className="context-audit-markdown break-words text-xs leading-5" />
  </>
}

/**
 * The Read tool prefixes every returned source line with its original line
 * number. That is useful to the agent, but turns `# heading`, `| table |`, and
 * `{ json }` into ordinary prose in a human reader. This is display-only: the
 * captured request and the raw JSON remain untouched for audit evidence.
 */
function stripToolReadLineNumbers(text: string): string {
  const lines = text.split(/\r?\n/)
  // A single tool-result block can contain several files separated by labels,
  // so a whole-block ratio is unreliable: a short Markdown table after a long
  // prose preamble would keep its `12 | ...` prefixes and fail to render. This
  // branch is only reached for the Read tool, whose protocol guarantees this
  // leading source-line number on every returned source line.
  return lines.map((line) => /^(\d+)(?:\s(.*))?$/.exec(line)?.[2] ?? line).join('\n')
}

function JsonValueView({ value, depth = 0 }: { value: unknown; depth?: number }) {
  const t = useTranslation()
  if (value === null) return <code className="font-mono text-[10px] text-[var(--color-text-tertiary)]">null</code>
  if (typeof value === 'string') return <>
    <EncodingNotice text={value} />
    <code className="whitespace-pre-wrap break-words font-mono text-[10px] text-[var(--color-text-secondary)]">{beautifyDisplayText(value)}</code>
  </>
  if (typeof value === 'number' || typeof value === 'boolean') return <code className="font-mono text-[10px] text-[var(--color-info)]">{String(value)}</code>
  if (value === undefined) return <code className="font-mono text-[10px] text-[var(--color-text-tertiary)]">undefined</code>

  const entries = Array.isArray(value) ? value.map((item, index) => [String(index), item] as const) : Object.entries(value as JsonRecord)
  if (byteLength(safeJson(value)) > 96 * 1024) {
    return <pre className="max-h-72 overflow-auto whitespace-pre-wrap break-words rounded bg-[var(--color-surface-container-low)] p-2 font-mono text-[10px] leading-4 text-[var(--color-text-secondary)]">{safeJson(value)}</pre>
  }
  return (
    <details open={depth < 1} className="rounded border border-[var(--color-border)]/70 bg-[var(--color-surface-container-low)] px-1.5 py-1">
      <summary className="cursor-pointer font-mono text-[10px] text-[var(--color-text-secondary)]">
        {t(Array.isArray(value) ? 'contextAudit.arrayItems' : 'contextAudit.objectItems', { count: entries.length })}
      </summary>
      <div className="mt-1.5 space-y-1 border-t border-[var(--color-border)]/60 pt-1.5">
        {entries.map(([key, child]) => (
          <div key={key} className="grid grid-cols-[minmax(72px,auto)_1fr] gap-x-2 text-[10px]">
            <span className="truncate font-mono text-[var(--color-brand)]" title={key}>{key}</span>
            <div className="min-w-0"><JsonValueView value={child} depth={depth + 1} /></div>
          </div>
        ))}
      </div>
    </details>
  )
}

function EncodingNotice({ text }: { text: string }) {
  const t = useTranslation()
  const replacementCount = Array.from(text).filter((char) => char === '\ufffd').length
  if (replacementCount === 0) return null
  return (
    <div className="mb-2 rounded border border-[var(--color-warning)]/50 bg-[var(--color-warning)]/10 px-2 py-1.5 text-[10px] leading-4 text-[var(--color-text-secondary)]">
      {t('contextAudit.encodingWarning', { count: replacementCount })}
    </div>
  )
}

function beautifyDisplayText(text: string): string {
  // JSON.parse has already turned ordinary \n and \\ into real newlines and path separators.
  // This only cleans the two escaped forms that sometimes arrive inside nested tool strings.
  return text.replace(/\\\\/g, '\\').replace(/\\\//g, '/')
}

function tryParseJsonText(text: string): unknown | null {
  const trimmed = text.trim()
  if ((!trimmed.startsWith('{') && !trimmed.startsWith('[')) || trimmed.length > 2_000_000) return null
  try {
    return JSON.parse(trimmed) as unknown
  } catch {
    return null
  }
}

function extractJsonPayload(text: string): string {
  const trimmed = text.trim()
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) return trimmed
  // Some command tools emit a bare language marker before a JSON document.
  // Accept only a short marker so ordinary prose containing JSON is not reclassified.
  const match = /^(?:json|JSON|application\/json)\s*\r?\n([\s\S]+)$/i.exec(trimmed)
  return match?.[1]?.trim() ?? trimmed
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2) ?? 'null'
  } catch {
    return String(value)
  }
}

function blockText(block: NormalizedBlock): string {
  switch (block.type) {
    case 'text': return block.text
    case 'thinking': return block.thinking
    case 'tool_use': return safeJson(block.input)
    case 'tool_result': return contentToText(block.content)
    case 'image': return block.mediaType ?? '[image]'
  }
}

function contentToText(value: unknown): string {
  if (typeof value === 'string') return value
  if (!Array.isArray(value)) return value === undefined ? '' : JSON.stringify(value, null, 2)
  return value.map((block) => {
    if (typeof block === 'string') return block
    if (!isJsonRecord(block)) return JSON.stringify(block)
    if (typeof block.text === 'string') return block.text
    if (typeof block.thinking === 'string') return block.thinking
    if (typeof block.content === 'string') return block.content
    return JSON.stringify(block, null, 2)
  }).join('\n\n')
}

function toolName(value: unknown, index: number): string {
  if (!isJsonRecord(value)) return `tool-${index + 1}`
  if (typeof value.name === 'string') return value.name
  return isJsonRecord(value.function) && typeof value.function.name === 'string' ? value.function.name : `tool-${index + 1}`
}

function isJsonRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

async function loadRequestBody(sessionId: string, call: TraceCallRecord): Promise<BodyLoad> {
  if (!call.request.body.fullCapture) {
    return { text: call.request.body.preview, isFull: false }
  }
  try {
    const raw = await sessionsApi.getTraceRawBody(sessionId, call.id, 'request')
    return rawBodyToLoad(raw)
  } catch {
    return { text: call.request.body.preview, isFull: false }
  }
}

async function loadHistoricalRequests(sessionId: string, calls: TraceCallRecord[]): Promise<HistoricalRequest[]> {
  const orderedCalls = calls.slice().sort((left, right) => left.startedAt.localeCompare(right.startedAt))
  const requests: HistoricalRequest[] = []
  // Raw bodies can be large; bound parallel local reads so opening an audit item
  // does not make the desktop app contend with hundreds of files at once.
  for (let index = 0; index < orderedCalls.length; index += 4) {
    const batch = await Promise.all(orderedCalls.slice(index, index + 4).map(async (historicalCall) => {
      const body = await loadRequestBody(sessionId, historicalCall)
      const parsed = parseTraceRequestBody(body.text, historicalCall.source)
      return parsed ? { call: historicalCall, messages: parsed.messages } : null
    }))
    requests.push(...batch.filter((request): request is HistoricalRequest => request !== null))
  }
  return requests
}

export function buildMessageTimingVisuals(
  messages: NormalizedMessage[],
  history: HistoricalRequest[],
): MessageTimingVisual[] {
  const durations = messages.map((message) => {
    const firstSeenIndex = history.findIndex((request) => request.messages.some((candidate) => messageSignature(candidate) === messageSignature(message)))
    if (firstSeenIndex < 0) return undefined
    // An assistant message is generated by the response to the request just before
    // its first appearance in a later request. User/tool-result messages instead
    // initiate the request in which they first appear.
    const associated = message.role === 'assistant'
      ? history[firstSeenIndex - 1]?.call
      : history[firstSeenIndex]?.call
    return associated?.durationMs
  })
  const knownDurations = durations.filter((duration): duration is number => duration !== undefined)
  const visuals = buildRelativeMetricVisuals(knownDurations)
  let visualIndex = 0

  return durations.map((duration, index) => {
    if (duration === undefined) return {}
    const attribution: MessageTimingVisual['attribution'] = messages[index]?.role === 'assistant'
      ? 'previous-response'
      : 'following-request'
    return { durationMs: duration, visual: visuals[visualIndex++]!, attribution }
  })
}

function messageSignature(message: NormalizedMessage): string {
  return `${message.role}:${JSON.stringify(message.content)}`
}

function messageTimingTitle(timing: MessageTimingVisual | undefined, t: Translate): string {
  if (!timing?.durationMs) return t('contextAudit.timingUnavailable')
  return timing.attribution === 'previous-response'
    ? t('contextAudit.timingPreviousResponse')
    : t('contextAudit.timingFollowingRequest')
}

function rawBodyToLoad(raw: TraceRawBody): BodyLoad {
  return { text: raw.content, isFull: true, file: raw.file }
}

function findPreviousCall(calls: TraceCallRecord[], call: TraceCallRecord): TraceCallRecord | undefined {
  return calls
    .filter((candidate) => candidate.startedAt < call.startedAt)
    .sort((left, right) => right.startedAt.localeCompare(left.startedAt))[0]
}

function analyzeRequest(call: TraceCallRecord, body: string, previousBody: string | null, t: Translate) {
  const parsed = parseTraceRequestBody(body, call.source)
  const system = parsed?.system ?? ''
  const messages = parsed?.messages ?? []
  const signatures = messages.map((message) => `${message.role}:${JSON.stringify(message.content)}`)
  const priorParsed = previousBody ? parseTraceRequestBody(previousBody, call.source) : null
  const priorMessages = priorParsed?.messages ?? []
  const priorSignatures = new Set((priorParsed?.messages ?? []).map((message) => `${message.role}:${JSON.stringify(message.content)}`))
  const currentSignatures = new Set(signatures)
  const newMessages = signatures.filter((signature) => !priorSignatures.has(signature)).length
  const omittedMessages = Array.from(priorSignatures).filter((signature) => !currentSignatures.has(signature)).length
  const retainedMessages = signatures.length - newMessages
  const systemChanged = previousBody !== null && (priorParsed?.system ?? '') !== system
  const toolsChanged = previousBody !== null && JSON.stringify(priorParsed?.tools ?? []) !== JSON.stringify(parsed?.tools ?? [])
  const deltaLabel = previousBody === null
    ? t('contextAudit.noPreviousRequest')
    : t('contextAudit.deltaSummary', {
        added: newMessages,
        omitted: omittedMessages,
        retained: retainedMessages,
        systemChange: systemChanged ? t('contextAudit.systemChangedSuffix') : '',
        toolsChange: toolsChanged ? t('contextAudit.toolsChangedSuffix') : '',
      })
  const text = [system, ...messages.map((message) => JSON.stringify(message.content))].join('\n')
  const messageFootprints = messages.map((message, index) => ({
    index: index + 1,
    role: message.role,
    label: messageSummaryLabel(message, collectToolCalls(messages), t),
    bytes: byteLength(JSON.stringify(message.content)),
    blocks: message.content.length,
    distanceFromTail: messages.length - index,
  }))
  const currentMaterials = extractReadMaterials(messages)
  const priorMaterials = extractReadMaterials(priorMessages)
  const materials = compareMaterials(currentMaterials, priorMaterials, messages.length)
  const cachePrefix = getCandidateCachePrefix(parsed, priorParsed, t)
  const compaction = getCompactionObservation(parsed, priorParsed, omittedMessages, t)

  return {
    systemBytes: byteLength(system),
    messageBytes: messageFootprints.reduce((total, message) => total + message.bytes, 0),
    messages: messages.length,
    userMessages: messages.filter((message) => message.role === 'user').length,
    assistantMessages: messages.filter((message) => message.role === 'assistant').length,
    tools: parsed?.tools.length ?? 0,
    files: extractExplicitFileHints(text),
    deltaLabel,
    messageFootprints,
    materials,
    cachePrefix,
    compaction,
  }
}

function collectToolCalls(messages: NormalizedMessage[]): Map<string, ToolCallReference> {
  const calls = new Map<string, ToolCallReference>()
  for (const message of messages) {
    for (const block of message.content) {
      if (block.type === 'tool_use' && block.id) {
        calls.set(block.id, { id: block.id, name: block.name, input: block.input })
      }
    }
  }
  return calls
}

function extractReadMaterials(messages: NormalizedMessage[]): Array<Omit<ReadMaterial, 'distanceFromTail' | 'watched' | 'state'>> {
  const calls = new Map<string, { name: string; input: unknown }>()
  for (const message of messages) {
    for (const block of message.content) {
      if (block.type === 'tool_use' && block.id) calls.set(block.id, { name: block.name, input: block.input })
    }
  }
  const materials: Array<Omit<ReadMaterial, 'distanceFromTail' | 'watched' | 'state'>> = []
  for (const [messageIndex, message] of messages.entries()) {
    for (const block of message.content) {
      if (block.type !== 'tool_result' || !block.toolUseId) continue
      const call = calls.get(block.toolUseId)
      if (call?.name.toLowerCase() !== 'read') continue
      const path = readToolPath(call.input)
      if (!path) continue
      const content = contentToText(block.content)
      materials.push({ path, bytes: byteLength(content), messageIndex: messageIndex + 1, fingerprint: shortFingerprint(content) })
    }
  }
  return materials
}

function readToolPath(input: unknown): string | null {
  if (!isJsonRecord(input)) return null
  for (const key of ['file_path', 'filePath', 'path']) {
    const value = input[key]
    if (typeof value === 'string' && value.trim()) return value.trim()
  }
  return null
}

function compareMaterials(
  current: Array<Omit<ReadMaterial, 'distanceFromTail' | 'watched' | 'state'>>,
  previous: Array<Omit<ReadMaterial, 'distanceFromTail' | 'watched' | 'state'>>,
  messageCount: number,
): ReadMaterial[] {
  const currentByPath = new Map(current.map((item) => [item.path, item]))
  const previousByPath = new Map(previous.map((item) => [item.path, item]))
  const paths = new Set([...currentByPath.keys(), ...previousByPath.keys()])
  return Array.from(paths).map((path) => {
    const item = currentByPath.get(path)
    const prior = previousByPath.get(path)
    const watched = isWatchedMaterial(path)
    if (!item) return { path, bytes: 0, messageIndex: 0, distanceFromTail: 0, fingerprint: prior?.fingerprint ?? '—', watched, state: 'evicted' as const }
    const state: ReadMaterial['state'] = !prior ? 'first' : prior.fingerprint === item.fingerprint ? 'retained' : 'updated'
    return { ...item, distanceFromTail: messageCount - item.messageIndex + 1, watched, state }
  }).sort((left, right) => Number(right.watched) - Number(left.watched) || right.bytes - left.bytes)
}

function isWatchedMaterial(path: string): boolean {
  const normalized = path.replace(/\\/g, '/').toLowerCase()
  return /(?:^|\/)(?:process|design)\.md$/.test(normalized)
    || /(?:^|\/)(?:任务范围|任务指标)\.md$/.test(normalized)
    || /项目大脑\/(?:启动|主流程|主规则|index)\.md$/.test(normalized)
}

function shortFingerprint(value: string): string {
  let hash = 2166136261
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index)
    hash = Math.imul(hash, 16777619)
  }
  return (hash >>> 0).toString(16).padStart(8, '0')
}

function getCandidateCachePrefix(current: ReturnType<typeof parseTraceRequestBody>, previous: ReturnType<typeof parseTraceRequestBody>, t: Translate) {
  if (!current || !previous) return { bytes: 0, label: t('contextAudit.noPreviousRequest') }
  const segments = [
    ['system', current.system ?? '', previous.system ?? ''],
    ['tools', safeJson(current.tools), safeJson(previous.tools)],
    ...current.messages.map((message, index) => [`message-${index + 1}`, safeJson({ role: message.role, content: message.content }), previous.messages[index] ? safeJson({ role: previous.messages[index]!.role, content: previous.messages[index]!.content }) : undefined] as const),
  ] as const
  let bytes = 0
  let matchedMessages = 0
  let stableSystemAndTools = true
  for (const [label, currentValue, previousValue] of segments) {
    if (currentValue !== previousValue) {
      if (label === 'system' || label === 'tools') stableSystemAndTools = false
      break
    }
    bytes += byteLength(currentValue)
    if (label.startsWith('message-')) matchedMessages += 1
  }
  const prefix = stableSystemAndTools
    ? t('contextAudit.stablePrefix', { count: matchedMessages })
    : t('contextAudit.systemOrToolsChanged')
  return { bytes, label: prefix }
}

function getCompactionObservation(current: ReturnType<typeof parseTraceRequestBody>, previous: ReturnType<typeof parseTraceRequestBody>, omittedMessages: number, t: Translate) {
  if (!previous) return { label: t('contextAudit.noPreviousRequest') }
  const text = (current?.messages ?? []).flatMap((message) => message.content).map(blockText).join('\n')
  if (/session is being continued from a previous conversation|context for continuing work|上下文已压缩/i.test(text)) return { label: t('contextAudit.summaryCompactionDetected') }
  if (isJsonRecord(current?.params?.context_management)) return { label: t('contextAudit.apiContextEditing') }
  if (omittedMessages > 0) return { label: t('contextAudit.omittedCount', { count: omittedMessages }) }
  return { label: t('contextAudit.noCompactionObserved') }
}

function extractExplicitFileHints(text: string): Array<{ path: string; contextBytes: number; kind: 'content' | 'marker' }> {
  const paths = new Map<string, { contextBytes: number; kind: 'content' | 'marker' }>()
  // This is the only case where "内容" is an exact captured file payload
  // size. Everything else is deliberately labelled as a path marker.
  for (const match of text.matchAll(/<file\s+path=["']([^"']+)["'][^>]*>([\s\S]*?)<\/file>/gi)) {
    const path = match[1]?.trim()
    if (!path || path.length > 512) continue
    paths.set(path, { contextBytes: byteLength(match[2] ?? ''), kind: 'content' })
  }
  const patterns = [
    /<(?:file|path)>([^<\n]+)<\/(?:file|path)>/gi,
    /(?:^|\n)\s*(?:file(?:\s+path)?|path|文件(?:路径)?|路径)\s*[:：]\s*([^\n]+)/gi,
  ]
  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) {
      const path = match[1]?.trim()
      if (!path || path.length > 512) continue
      const existing = paths.get(path)
      if (existing?.kind === 'content') continue
      paths.set(path, { contextBytes: (existing?.contextBytes ?? 0) + byteLength(match[0]), kind: 'marker' })
    }
  }
  return Array.from(paths.entries())
    .map(([path, value]) => ({ path, ...value }))
    .sort((left, right) => right.contextBytes - left.contextBytes)
}

function getRisks(call: TraceCallRecord, body: BodyLoad, analysis: ReturnType<typeof analyzeRequest>, t: Translate): string[] {
  const risks: string[] = []
  if (!body.isFull && call.request.body.truncated) risks.push(t('contextAudit.risk.truncated'))
  if (call.request.body.bytes >= LARGE_BODY_BYTES) risks.push(t('contextAudit.risk.largeRequest'))
  if ((call.usage?.inputTokens ?? 0) >= HIGH_TOKEN_COUNT) risks.push(t('contextAudit.risk.highTokens'))
  if (analysis.messages >= 40) risks.push(t('contextAudit.risk.longChain'))
  return risks
}

function byteLength(value: string): number {
  return new TextEncoder().encode(value).length
}

function formatInputTokens(call: TraceCallRecord, t: Translate): string {
  const count = call.usage?.inputTokens
  return typeof count === 'number' && count > 0 ? `${count.toLocaleString()} tokens` : t('contextAudit.tokensNotReturned')
}

function formatTokenMetric(value: number | undefined, t: Translate): string {
  return typeof value === 'number' && value >= 0 ? `${value.toLocaleString()} tokens` : t('contextAudit.providerDidNotReturn')
}

function formatDate(value: string): string {
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString()
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0 rounded-md bg-[var(--color-surface-container)] px-2 py-1.5">
      <div className="truncate text-[9px] text-[var(--color-text-tertiary)]">{label}</div>
      <div className="truncate text-[11px] font-medium text-[var(--color-text-primary)]" title={value}>{value}</div>
    </div>
  )
}

function Status({ label, tone }: { label: string; tone: 'success' | 'warning' | 'error' | 'muted' }) {
  const toneClass = {
    success: 'bg-[var(--color-success)]/10 text-[var(--color-success)]',
    warning: 'bg-[var(--color-warning)]/10 text-[var(--color-warning)]',
    error: 'bg-[var(--color-error)]/10 text-[var(--color-error)]',
    muted: 'bg-[var(--color-surface-container)] text-[var(--color-text-tertiary)]',
  }[tone]
  return <span className={`rounded px-1.5 py-0.5 text-[9px] font-medium ${toneClass}`}>{label}</span>
}

function LoadingState() {
  const t = useTranslation()
  return <div className="flex items-center justify-center gap-2 p-8 text-xs text-[var(--color-text-tertiary)]"><Loader2 size={14} className="animate-spin" />{t('contextAudit.loading')}</div>
}

function EmptyState() {
  const t = useTranslation()
  return <div className="rounded-lg border border-dashed border-[var(--color-border)] p-5 text-center text-xs leading-5 text-[var(--color-text-tertiary)]">{t('contextAudit.emptyState')}</div>
}
