import { useEffect, useMemo, useState } from 'react'
import { ChevronDown, Download, FileText, FolderOpen, Loader2, RefreshCw, ShieldCheck } from 'lucide-react'
import { sessionsApi } from '../../api/sessions'
import { tracesApi } from '../../api/traces'
import { formatBytes } from '../../lib/formatBytes'
import { getDesktopHost } from '../../lib/desktopHost'
import { parseTraceRequestBody } from '../../lib/trace/requestParse'
import type { TraceCallRecord, TraceRawBody, TraceSession } from '../../types/trace'
import { MarkdownRenderer } from '../markdown/MarkdownRenderer'
import { CopyButton } from '../shared/CopyButton'

const POLL_INTERVAL_MS = 1_500
const LARGE_BODY_BYTES = 100 * 1024
const HIGH_TOKEN_COUNT = 50_000

type BodyLoad = {
  text: string
  isFull: boolean
  file?: string
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
            <h2 className="text-sm font-semibold text-[var(--color-text-primary)]">上下文审计</h2>
            <p className="mt-0.5 text-[11px] leading-4 text-[var(--color-text-tertiary)]">
              实际上行请求，最新在前；原文已按密钥规则脱敏，仅保存本机。
            </p>
          </div>
          <button
            type="button"
            aria-label="刷新上下文审计"
            title="刷新"
            onClick={() => void refresh()}
            className="inline-flex h-7 w-7 items-center justify-center rounded-md text-[var(--color-text-tertiary)] hover:bg-[var(--color-surface-hover)] hover:text-[var(--color-text-primary)]"
          >
            <RefreshCw size={14} className={loading ? 'animate-spin' : ''} />
          </button>
        </div>
        <div className="mt-3 grid grid-cols-3 gap-2">
          <Metric label="上行次数" value={String(calls.length)} />
          <Metric label="累计字节" value={formatBytes(totalRequestBytes)} />
          <Metric label="完整原文" value={`${capturedFullCount}/${calls.length}`} />
        </div>
        <div className="mt-3 flex flex-wrap gap-2">
          <button
            type="button"
            onClick={() => void download()}
            disabled={exporting || !trace}
            className="inline-flex items-center gap-1.5 rounded-md border border-[var(--color-border)] px-2 py-1 text-[11px] font-medium text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)] disabled:opacity-50"
          >
            {exporting ? <Loader2 size={13} className="animate-spin" /> : <Download size={13} />}
            导出审计 JSON
          </button>
          <button
            type="button"
            onClick={() => void openFolder()}
            disabled={!trace || !getDesktopHost().capabilities.shell}
            title={getDesktopHost().capabilities.shell ? '打开本机 trace 文件夹' : '仅桌面版可直接打开文件夹'}
            className="inline-flex items-center gap-1.5 rounded-md border border-[var(--color-border)] px-2 py-1 text-[11px] font-medium text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)] disabled:opacity-50"
          >
            <FolderOpen size={13} />
            打开文件夹
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
  newestIndex,
  callCount,
}: {
  sessionId: string
  call: TraceCallRecord
  previous: TraceCallRecord | undefined
  newestIndex: number
  callCount: number
}) {
  const [open, setOpen] = useState(false)
  const [currentBody, setCurrentBody] = useState<BodyLoad>({ text: call.request.body.preview, isFull: false })
  const [previousBody, setPreviousBody] = useState<BodyLoad | null>(null)
  const [detail, setDetail] = useState<TraceCallRecord | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)

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
        const [request, priorRequest] = await Promise.all([
          loadRequestBody(sessionId, nextCall),
          priorCall ? loadRequestBody(sessionId, priorCall) : Promise.resolve(null),
        ])
        if (cancelled) return
        setDetail(nextCall)
        setCurrentBody(request)
        setPreviousBody(priorRequest)
        setLoadError(null)
      } catch (cause) {
        if (!cancelled) setLoadError(cause instanceof Error ? cause.message : String(cause))
      }
    }
    void load()
    return () => { cancelled = true }
  }, [call.id, open, previous?.id, sessionId])

  const activeCall = detail ?? call
  const analysis = useMemo(
    () => analyzeRequest(activeCall, currentBody.text, previousBody?.text ?? null),
    [activeCall, currentBody.text, previousBody?.text],
  )
  const risks = getRisks(activeCall, currentBody, analysis)

  return (
    <details
      className="group overflow-hidden rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-container-low)]"
      onToggle={(event) => setOpen((event.currentTarget as HTMLDetailsElement).open)}
    >
      <summary className="flex cursor-pointer list-none items-center gap-2 px-3 py-2.5 hover:bg-[var(--color-surface-hover)]">
        <ChevronDown size={15} className="shrink-0 transition-transform group-open:rotate-180" />
        <span className="min-w-0 flex-1">
          <span className="flex items-center gap-2">
            <span className="text-xs font-semibold text-[var(--color-text-primary)]">第 {callCount - newestIndex} 条上行</span>
            {activeCall.status === 'pending' ? <Status label="发送中" tone="warning" /> : null}
            {activeCall.status === 'error' || activeCall.error ? <Status label="失败" tone="error" /> : null}
            {currentBody.isFull ? <Status label="完整" tone="success" /> : <Status label="预览" tone="muted" />}
          </span>
          <span className="mt-1 flex gap-2 overflow-hidden text-[10px] text-[var(--color-text-tertiary)]">
            <span>{formatDate(activeCall.startedAt)}</span>
            <span className="truncate">{activeCall.model ?? 'unknown model'}</span>
          </span>
        </span>
        <span className="shrink-0 text-right text-[11px] text-[var(--color-text-secondary)]">
          <span className="block font-mono">{formatBytes(activeCall.request.body.bytes)}</span>
          <span className="block text-[10px] text-[var(--color-text-tertiary)]">{formatInputTokens(activeCall)}</span>
        </span>
      </summary>

      {open ? (
        <div className="border-t border-[var(--color-border)] px-3 py-3">
          {loadError ? <div role="alert" className="mb-2 text-xs text-[var(--color-error)]">加载完整请求失败：{loadError}</div> : null}
          {risks.length > 0 ? (
            <div className="mb-3 flex flex-wrap gap-1.5">
              {risks.map((risk) => <Status key={risk} label={risk} tone="warning" />)}
            </div>
          ) : null}

          <details open className="rounded-md border border-[var(--color-border)] bg-[var(--color-surface)]">
            <summary className="cursor-pointer px-2.5 py-2 text-xs font-medium text-[var(--color-text-primary)]">统计与相邻差异</summary>
            <div className="border-t border-[var(--color-border)] p-2.5">
              <div className="grid grid-cols-2 gap-2">
                <Metric label="请求大小" value={formatBytes(activeCall.request.body.bytes)} />
                <Metric label="系统提示" value={formatBytes(analysis.systemBytes)} />
                <Metric label="消息" value={`${analysis.messages}（用户 ${analysis.userMessages} / 助手 ${analysis.assistantMessages}）`} />
                <Metric label="工具定义" value={`${analysis.tools} 个`} />
                <Metric label="相对上次" value={analysis.deltaLabel} />
                <Metric label="文件线索" value={`${analysis.files.length} 个`} />
              </div>
              {analysis.files.length > 0 ? (
                <div className="mt-3">
                  <p className="text-[10px] leading-4 text-[var(--color-text-tertiary)]">仅展示在实际请求正文中有显式路径标记的文件；“内容”是 XML 文件块中的实际上传字节，“标记”只是路径附近文本，不会伪造磁盘文件大小。</p>
                  <div className="mt-1.5 max-h-36 overflow-y-auto rounded border border-[var(--color-border)] bg-[var(--color-surface-container-low)]">
                    {analysis.files.map((file) => (
                      <div key={file.path} className="flex items-center gap-2 border-b border-[var(--color-border)]/60 px-2 py-1.5 text-[10px] last:border-b-0">
                        <FileText size={12} className="shrink-0 text-[var(--color-text-tertiary)]" />
                        <span className="min-w-0 flex-1 truncate font-mono text-[var(--color-text-secondary)]" title={file.path}>{file.path}</span>
                        <span className="shrink-0 text-[var(--color-text-tertiary)]">{file.kind === 'content' ? '内容 ' : '标记 '}{formatBytes(file.contextBytes)}</span>
                      </div>
                    ))}
                  </div>
                </div>
              ) : null}
            </div>
          </details>

          <details className="mt-2 rounded-md border border-[var(--color-border)] bg-[var(--color-surface)]">
            <summary className="cursor-pointer px-2.5 py-2 text-xs font-medium text-[var(--color-text-primary)]">上行内容（脱敏）</summary>
            <div className="border-t border-[var(--color-border)] p-2.5">
              <div className="mb-2 flex items-center gap-2 text-[10px] text-[var(--color-text-tertiary)]">
                <span>{currentBody.isFull ? '完整本地副本' : '仅有预览副本'}</span>
                {currentBody.file ? <span className="truncate font-mono">{currentBody.file}</span> : null}
                <CopyButton text={currentBody.text} label="复制原文" copiedLabel="已复制" className="ml-auto shrink-0 rounded border border-[var(--color-border)] px-1.5 py-0.5 hover:text-[var(--color-text-primary)]" />
              </div>
              <FormattedRequestView call={activeCall} text={currentBody.text} />
              <details className="mt-2 rounded border border-[var(--color-border)] bg-[var(--color-surface-container-low)]">
                <summary className="cursor-pointer px-2 py-1.5 text-[10px] text-[var(--color-text-secondary)]">原始 JSON（逐字保留）</summary>
                <pre className="max-h-[520px] overflow-auto whitespace-pre-wrap break-words border-t border-[var(--color-border)] p-2 font-mono text-[10px] leading-4 text-[var(--color-text-secondary)]">{currentBody.text || '(空请求体)'}</pre>
              </details>
            </div>
          </details>
        </div>
      ) : null}
    </details>
  )
}

type JsonRecord = Record<string, unknown>

function FormattedRequestView({ call, text }: { call: TraceCallRecord; text: string }) {
  const request = useMemo(() => parseCapturedRequest(text, call.source), [call.source, text])
  if (!request) {
    return <div className="rounded border border-dashed border-[var(--color-border)] p-2 text-[10px] text-[var(--color-text-tertiary)]">此请求不是可解析的 JSON；请在下方查看原始内容。</div>
  }

  const system = request.system
  const messages = Array.isArray(request.messages) ? request.messages : []
  const tools = Array.isArray(request.tools) ? request.tools : []
  const parameters = Object.fromEntries(Object.entries(request).filter(([key]) => !new Set(['system', 'messages', 'tools']).has(key)))

  return (
    <div className="flex flex-col gap-2">
      {system !== undefined ? (
        <details open className="rounded border border-[var(--color-border)]">
          <summary className="cursor-pointer px-2 py-1.5 text-[11px] font-medium text-[var(--color-text-primary)]">系统提示</summary>
          <div className="border-t border-[var(--color-border)] p-2"><ReadableContent value={system} /></div>
        </details>
      ) : null}
      <details open className="rounded border border-[var(--color-border)]">
        <summary className="cursor-pointer px-2 py-1.5 text-[11px] font-medium text-[var(--color-text-primary)]">消息链（{messages.length}）</summary>
        <div className="flex flex-col gap-1.5 border-t border-[var(--color-border)] p-2">
          {messages.map((message, index) => (
            <details key={index} className="rounded border border-[var(--color-border)] bg-[var(--color-surface-container-low)]">
              <summary className="cursor-pointer px-2 py-1.5 text-[10px] text-[var(--color-text-primary)]">
                {index + 1}. {typeof message.role === 'string' ? message.role : 'message'} · {formatBytes(byteLength(contentToText(message.content)))}
              </summary>
              <div className="border-t border-[var(--color-border)] p-2"><ReadableContent value={message.content} /></div>
            </details>
          ))}
          {messages.length === 0 ? <div className="text-[10px] text-[var(--color-text-tertiary)]">无消息</div> : null}
        </div>
      </details>
      {tools.length > 0 ? (
        <details className="rounded border border-[var(--color-border)]">
          <summary className="cursor-pointer px-2 py-1.5 text-[11px] font-medium text-[var(--color-text-primary)]">工具定义（{tools.length}）</summary>
          <div className="border-t border-[var(--color-border)] p-2">
            {tools.map((tool, index) => (
              <details key={index} className="border-b border-[var(--color-border)]/70 py-1 last:border-b-0">
                <summary className="cursor-pointer font-mono text-[10px] text-[var(--color-text-secondary)]">{toolName(tool, index)}</summary>
                <pre className="mt-1 max-h-56 overflow-auto whitespace-pre-wrap break-words rounded bg-[var(--color-surface-container-low)] p-2 font-mono text-[10px] leading-4 text-[var(--color-text-secondary)]">{JSON.stringify(tool, null, 2)}</pre>
              </details>
            ))}
          </div>
        </details>
      ) : null}
      <details className="rounded border border-[var(--color-border)]">
        <summary className="cursor-pointer px-2 py-1.5 text-[11px] font-medium text-[var(--color-text-primary)]">模型与参数</summary>
        <pre className="max-h-56 overflow-auto whitespace-pre-wrap break-words border-t border-[var(--color-border)] p-2 font-mono text-[10px] leading-4 text-[var(--color-text-secondary)]">{JSON.stringify(parameters, null, 2)}</pre>
      </details>
    </div>
  )
}

function ReadableContent({ value }: { value: unknown }) {
  const text = contentToText(value)
  if (!text) return <span className="text-[10px] text-[var(--color-text-tertiary)]">（空）</span>
  if (text.length > 80_000) {
    return <pre className="max-h-[420px] overflow-auto whitespace-pre-wrap break-words rounded bg-[var(--color-surface-container-low)] p-2 font-mono text-[10px] leading-4 text-[var(--color-text-secondary)]">{text}</pre>
  }
  return <MarkdownRenderer content={text} variant="compact" cache={false} className="context-audit-markdown break-words text-xs leading-5" />
}

function parseCapturedRequest(text: string, source: TraceCallRecord['source']): JsonRecord | null {
  try {
    const parsed = JSON.parse(text) as unknown
    if (!isJsonRecord(parsed)) return null
    return source === 'proxy' && isJsonRecord(parsed.anthropic) ? parsed.anthropic : parsed
  } catch {
    return null
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

function rawBodyToLoad(raw: TraceRawBody): BodyLoad {
  return { text: raw.content, isFull: true, file: raw.file }
}

function findPreviousCall(calls: TraceCallRecord[], call: TraceCallRecord): TraceCallRecord | undefined {
  return calls
    .filter((candidate) => candidate.startedAt < call.startedAt)
    .sort((left, right) => right.startedAt.localeCompare(left.startedAt))[0]
}

function analyzeRequest(call: TraceCallRecord, body: string, previousBody: string | null) {
  const parsed = parseTraceRequestBody(body, call.source)
  const system = parsed?.system ?? ''
  const messages = parsed?.messages ?? []
  const signatures = messages.map((message) => `${message.role}:${JSON.stringify(message.content)}`)
  const priorParsed = previousBody ? parseTraceRequestBody(previousBody, call.source) : null
  const priorSignatures = new Set((priorParsed?.messages ?? []).map((message) => `${message.role}:${JSON.stringify(message.content)}`))
  const currentSignatures = new Set(signatures)
  const newMessages = signatures.filter((signature) => !priorSignatures.has(signature)).length
  const omittedMessages = Array.from(priorSignatures).filter((signature) => !currentSignatures.has(signature)).length
  const retainedMessages = signatures.length - newMessages
  const systemChanged = previousBody !== null && (priorParsed?.system ?? '') !== system
  const toolsChanged = previousBody !== null && JSON.stringify(priorParsed?.tools ?? []) !== JSON.stringify(parsed?.tools ?? [])
  const deltaLabel = previousBody === null
    ? '无可比上行'
    : `${newMessages} 新增 / ${omittedMessages} 未继续出现 / ${retainedMessages} 保留${systemChanged ? ' / 系统变更' : ''}${toolsChanged ? ' / 工具变更' : ''}`
  const text = [system, ...messages.map((message) => JSON.stringify(message.content))].join('\n')

  return {
    systemBytes: byteLength(system),
    messages: messages.length,
    userMessages: messages.filter((message) => message.role === 'user').length,
    assistantMessages: messages.filter((message) => message.role === 'assistant').length,
    tools: parsed?.tools.length ?? 0,
    files: extractExplicitFileHints(text),
    deltaLabel,
  }
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

function getRisks(call: TraceCallRecord, body: BodyLoad, analysis: ReturnType<typeof analyzeRequest>): string[] {
  const risks: string[] = []
  if (!body.isFull && call.request.body.truncated) risks.push('正文已截断，不能完整复盘')
  if (call.request.body.bytes >= LARGE_BODY_BYTES) risks.push('单次上行较大，注意力稀释风险')
  if ((call.usage?.inputTokens ?? 0) >= HIGH_TOKEN_COUNT) risks.push('输入 token 很高，接近压缩/换出风险')
  if (analysis.messages >= 40) risks.push('消息链较长，渐进披露可能失效')
  return risks
}

function byteLength(value: string): number {
  return new TextEncoder().encode(value).length
}

function formatInputTokens(call: TraceCallRecord): string {
  const count = call.usage?.inputTokens
  return typeof count === 'number' && count > 0 ? `${count.toLocaleString()} tokens` : 'tokens 未返回'
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
  return <div className="flex items-center justify-center gap-2 p-8 text-xs text-[var(--color-text-tertiary)]"><Loader2 size={14} className="animate-spin" />读取实际请求…</div>
}

function EmptyState() {
  return <div className="rounded-lg border border-dashed border-[var(--color-border)] p-5 text-center text-xs leading-5 text-[var(--color-text-tertiary)]">本会话尚未捕获上行请求。请确认 Trace 已开启，然后发送一条消息。</div>
}
