import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { ChevronDown, Download, FileText, FolderOpen, Loader2, RefreshCw, ShieldCheck } from 'lucide-react'
import { sessionsApi } from '../../api/sessions'
import { tracesApi } from '../../api/traces'
import { formatBytes } from '../../lib/formatBytes'
import { getDesktopHost } from '../../lib/desktopHost'
import { parseTraceRequestBody } from '../../lib/trace/requestParse'
import type { NormalizedBlock, NormalizedMessage } from '../../lib/trace/types'
import type { TraceCallRecord, TraceRawBody, TraceSession } from '../../types/trace'
import { MarkdownRenderer } from '../markdown/MarkdownRenderer'
import { CopyButton } from '../shared/CopyButton'

const POLL_INTERVAL_MS = 1_500
const LARGE_BODY_BYTES = 100 * 1024
const MAX_MARKDOWN_RENDER_CHARS = 500_000
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
  const request = useMemo(() => parseTraceRequestBody(text, call.source), [call.source, text])
  if (!request) {
    return <div className="rounded border border-dashed border-[var(--color-border)] p-2 text-[10px] text-[var(--color-text-tertiary)]">此请求不是可解析的 JSON；请在下方查看原始内容。</div>
  }

  const toolNames = new Map<string, string>()
  for (const message of request.messages) {
    for (const block of message.content) {
      if (block.type === 'tool_use' && block.id) toolNames.set(block.id, block.name)
    }
  }

  return (
    <div className="flex flex-col gap-2">
      {request.system !== undefined ? (
        <details open className="rounded border border-[var(--color-border)]">
          <summary className="cursor-pointer px-2 py-1.5 text-[11px] font-medium text-[var(--color-text-primary)]">系统提示</summary>
          <div className="border-t border-[var(--color-border)] p-2"><ReadableContent value={request.system} /></div>
        </details>
      ) : null}
      <details open className="rounded border border-[var(--color-border)]">
        <summary className="cursor-pointer px-2 py-1.5 text-[11px] font-medium text-[var(--color-text-primary)]">消息链（{request.messages.length}）</summary>
        <div className="flex flex-col gap-1.5 border-t border-[var(--color-border)] p-2">
          {request.messages.map((message, index) => <ContextMessageView key={index} message={message} index={index} toolNames={toolNames} />)}
          {request.messages.length === 0 ? <div className="text-[10px] text-[var(--color-text-tertiary)]">无消息</div> : null}
        </div>
      </details>
      {request.tools.length > 0 ? (
        <details className="rounded border border-[var(--color-border)]">
          <summary className="cursor-pointer px-2 py-1.5 text-[11px] font-medium text-[var(--color-text-primary)]">工具定义（{request.tools.length}）</summary>
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
        <summary className="cursor-pointer px-2 py-1.5 text-[11px] font-medium text-[var(--color-text-primary)]">模型与参数</summary>
        <div className="max-h-56 overflow-auto border-t border-[var(--color-border)] p-2"><JsonValueView value={request.params} /></div>
      </details>
    </div>
  )
}

const ROLE_LABELS: Record<NormalizedMessage['role'], string> = {
  system: '系统',
  user: '用户',
  assistant: '助手',
  tool: '工具',
}

function ContextMessageView({ message, index, toolNames }: { message: NormalizedMessage; index: number; toolNames: Map<string, string> }) {
  const contentBytes = message.content.reduce((total, block) => total + byteLength(blockText(block)), 0)
  const summaryLabel = messageSummaryLabel(message, toolNames)
  return (
    <details className="rounded border border-[var(--color-border)] bg-[var(--color-surface-container-low)]">
      <summary className="cursor-pointer px-2 py-1.5 text-[10px] text-[var(--color-text-primary)]">
        {index + 1}. {summaryLabel} · 协议角色：{ROLE_LABELS[message.role]} · {message.content.length} 个内容块 · {formatBytes(contentBytes)}
      </summary>
      <div className="flex flex-col gap-2 border-t border-[var(--color-border)] p-2">
        {message.content.map((block, blockIndex) => <ContextBlockView key={blockIndex} block={block} toolNames={toolNames} />)}
      </div>
    </details>
  )
}

function messageSummaryLabel(message: NormalizedMessage, toolNames: Map<string, string>): string {
  const toolResult = message.content.find((block): block is Extract<NormalizedBlock, { type: 'tool_result' }> => block.type === 'tool_result')
  if (toolResult) {
    return `${toolResult.isError ? '工具执行失败' : '工具执行回包'} · ${toolResult.toolUseId ? toolNames.get(toolResult.toolUseId) ?? toolResult.toolUseId : '未知工具'}`
  }
  const toolUse = message.content.find((block): block is Extract<NormalizedBlock, { type: 'tool_use' }> => block.type === 'tool_use')
  if (toolUse) return `工具调用 · ${toolUse.name || '未命名工具'}`
  return ROLE_LABELS[message.role]
}

function ContextBlockView({ block, toolNames }: { block: NormalizedBlock; toolNames: Map<string, string> }) {
  switch (block.type) {
    case 'text':
      return <ContentBlock label="文本 · Markdown / 表格 / Mermaid / 代码高亮"><ReadableContent value={block.text} /></ContentBlock>
    case 'thinking':
      return <ContentBlock label="推理内容"><ReadableContent value={block.thinking} /></ContentBlock>
    case 'tool_use':
      return <ContentBlock label={`工具调用 · ${block.name || '未命名工具'}`} meta={block.id}><JsonValueView value={block.input} /></ContentBlock>
    case 'tool_result': {
      const toolName = block.toolUseId ? toolNames.get(block.toolUseId) : undefined
      return <ContentBlock label={`${block.isError ? '工具执行失败' : '工具执行回包'} · ${toolName ?? block.toolUseId ?? '未知工具'}`}><ReadableContent value={block.content} /></ContentBlock>
    }
    case 'image':
      return <ContentBlock label={`图像内容${block.mediaType ? ` · ${block.mediaType}` : ''}`} />
  }
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

function ReadableContent({ value }: { value: unknown }) {
  const text = contentToText(value)
  if (!text) return <span className="text-[10px] text-[var(--color-text-tertiary)]">（空）</span>
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

function JsonValueView({ value, depth = 0 }: { value: unknown; depth?: number }) {
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
        {Array.isArray(value) ? '数组' : '对象'} · {entries.length} 项
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
  const replacementCount = Array.from(text).filter((char) => char === '\ufffd').length
  if (replacementCount === 0) return null
  return (
    <div className="mb-2 rounded border border-[var(--color-warning)]/50 bg-[var(--color-warning)]/10 px-2 py-1.5 text-[10px] leading-4 text-[var(--color-text-secondary)]">
      检测到 {replacementCount} 个 “�”。这说明工具回包在进入审计前已经按错误编码解码，原始字节未保留，不能可靠地自动还原为 GBK；请让产生该回包的命令以 UTF-8 输出。原始 JSON 仍可用于确认损坏发生的位置。
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
