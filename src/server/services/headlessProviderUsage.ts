import { createHash, randomUUID } from 'node:crypto'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { usageRecordKey } from '../../utils/usageAccounting.js'
import type { SavedProvider } from '../types/provider.js'

type ProviderName = 'kscc' | 'tokenhub'
export type HeadlessTokenUsage = {
  input_tokens?: number
  output_tokens?: number
  cache_read_input_tokens?: number
  cache_creation_input_tokens?: number
}
type Tokens = Required<HeadlessTokenUsage> & { total_tokens: number }
export type HeadlessUsageInput = {
  provider: ProviderName
  model: string
  runId: string
  usage: HeadlessTokenUsage
  timestamp?: string
  requestId?: string
  messageId?: string
}
type UsageEvent = { schema_version: 1; provider: ProviderName; model: string; host_id: string; run_id: string; identity: string; timestamp: string; usage: Tokens }
type QuotaWindow = { kind: string; enabled: boolean; limit: number | null; used: number | null; remaining: number | null; violated: boolean | null; period_start: string | null; period_end: string | null }
type ServerQuota = { status: 'supported' | 'unsupported' | 'auth_required' | 'permission_denied' | 'temporarily_unavailable'; scope: 'account'; message: string; currency: string | null; windows: QuotaWindow[] }
type QuotaSample = { schema_version: 1; provider: ProviderName; provider_hash: string; observed_at: string; quota: ServerQuota }
type Options = { now?: number; directory?: string; noNetwork?: boolean; signal?: AbortSignal; selectProvider?: (name: ProviderName) => Promise<SavedProvider>; fetchQuota?: (provider: SavedProvider, options?: { signal?: AbortSignal }) => Promise<unknown> }
const tokenKeys = ['input_tokens', 'output_tokens', 'cache_read_input_tokens', 'cache_creation_input_tokens'] as const
const hour = 3600000
const durations = { '1h': hour, '24h': 24 * hour, '7d': 7 * 24 * hour }
const hash = (value: string) => createHash('sha256').update(value).digest('hex')
const hostId = () => hash(os.hostname()).slice(0, 16)
const storageDirectory = () => path.join(process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'), 'cc-haha', 'headless-usage-v1')
const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= Number.MAX_SAFE_INTEGER
const date = (value: unknown): string | null => typeof value === 'string' && Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : null
const object = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}

function tokens(value: HeadlessTokenUsage): Tokens {
  const result: Tokens = { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, total_tokens: 0 }
  for (const key of tokenKeys) {
    if (value[key] !== undefined && (!finite(value[key]) || !Number.isSafeInteger(value[key]))) throw new Error('INVALID_USAGE_RECORD')
    result[key] = value[key] ?? 0
    result.total_tokens += result[key]
  }
  if (!Number.isSafeInteger(result.total_tokens)) throw new Error('INVALID_USAGE_RECORD')
  return result
}

async function writeRecord(directory: string, prefix: string, value: unknown) {
  await fs.mkdir(directory, { recursive: true, mode: 0o700 })
  const file = path.join(directory, `${prefix}-${randomUUID()}.json`)
  const temporary = `${file}.tmp`
  try {
    await fs.writeFile(temporary, JSON.stringify(value), { mode: 0o600, flag: 'wx' })
    await fs.rename(temporary, file)
  } finally { await fs.rm(temporary, { force: true }) }
}

/** Only measurements and hashed identities are persisted, never prompts, responses or credentials. */
export async function recordHeadlessUsage(input: HeadlessUsageInput, options: Pick<Options, 'directory'> = {}): Promise<void> {
  if (!['kscc', 'tokenhub'].includes(input.provider) || !/^[a-zA-Z0-9][a-zA-Z0-9._:/+-]{0,199}$/.test(input.model) || !input.runId) throw new Error('INVALID_USAGE_RECORD')
  if (!tokenKeys.some(key => input.usage[key] !== undefined)) throw new Error('USAGE_MEASUREMENT_MISSING')
  const timestamp = date(input.timestamp ?? new Date().toISOString())
  if (!timestamp) throw new Error('INVALID_USAGE_RECORD')
  // Real upstream identity survives replay/resume across runs. A run is a fallback only
  // when neither a message nor request identity was supplied by the runtime.
  const identity = usageRecordKey({ messageId: input.messageId || (input.requestId ? `request:${input.requestId}` : `run:${input.runId}`), requestId: input.requestId ?? '' })!
  const event: UsageEvent = { schema_version: 1, provider: input.provider, model: input.model, host_id: hostId(), run_id: hash(input.runId), identity: hash(identity), timestamp, usage: tokens(input.usage) }
  await writeRecord(options.directory ?? storageDirectory(), 'event', event)
}

/** Whitelist remote fields: remote messages, unknown fields and identity data never reach output. */
export function projectHeadlessQuota(raw: unknown): ServerQuota {
  const payload = object(raw)
  const data = object(payload.data)
  if (payload.code !== 0 || !Array.isArray(data.windows) || !/^[A-Z]{3}$/.test(String(data.currency))) throw new Error('INVALID_QUOTA_RESPONSE')
  const windows = data.windows.map(item => {
    const value = object(item)
    if (!['fixed_5h', 'fixed_7d', 'user_month'].includes(String(value.kind)) || typeof value.enabled !== 'boolean') throw new Error('INVALID_QUOTA_RESPONSE')
    const limit = finite(value.quota_amount) ? value.quota_amount : null
    const used = finite(value.used_amount) ? value.used_amount : null
    return { kind: String(value.kind), enabled: value.enabled, limit, used, remaining: limit !== null && used !== null ? Math.max(0, limit - used) : null,
      violated: typeof value.violated === 'boolean' ? value.violated : null, period_start: date(value.period_start), period_end: date(value.period_end) }
  })
  return { status: 'supported', scope: 'account', message: '服务端额度；账户级，不能把两台机器的余额相加', currency: String(data.currency), windows }
}

async function readRecords(directory: string): Promise<{ events: UsageEvent[]; samples: QuotaSample[]; partial: boolean }> {
  const result = { events: [] as UsageEvent[], samples: [] as QuotaSample[], partial: false }
  let names: string[]
  try { names = await fs.readdir(directory) } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return result
    throw new Error('USAGE_STORAGE_UNAVAILABLE')
  }
  for (const name of names) {
    if (!/^(event|quota)-[a-f0-9-]+\.json$/.test(name)) continue
    try {
      const stat = await fs.stat(path.join(directory, name))
      if (stat.size > 32768) throw new Error('invalid')
      const item = JSON.parse(await fs.readFile(path.join(directory, name), 'utf8'))
      if (item.schema_version !== 1) throw new Error('invalid')
      if (name.startsWith('event-')) {
        if (!['kscc', 'tokenhub'].includes(item.provider) || typeof item.identity !== 'string' || !/^[a-f0-9]{64}$/.test(item.identity) ||
          !/^[a-f0-9]{64}$/.test(item.run_id) || !/^[a-f0-9]{16}$/.test(item.host_id) || !/^[a-zA-Z0-9][a-zA-Z0-9._:/+-]{0,199}$/.test(item.model) || !date(item.timestamp)) throw new Error('invalid')
        item.usage = tokens(object(item.usage))
        result.events.push(item)
      } else {
        if (!date(item.observed_at) || !/^[a-f0-9]{64}$/.test(item.provider_hash) || !['kscc', 'tokenhub'].includes(item.provider)) throw new Error('invalid')
        const savedQuota = object(item.quota)
        if (savedQuota.status !== 'supported' || !Array.isArray(savedQuota.windows)) throw new Error('invalid')
        // Re-parse persisted measurements with the same whitelist used at the network boundary.
        item.quota = projectHeadlessQuota({ code: 0, data: { currency: savedQuota.currency, windows: savedQuota.windows.map(raw => {
          const value = object(raw)
          return { kind: value.kind, enabled: value.enabled, quota_amount: value.limit, used_amount: value.used, violated: value.violated, period_start: value.period_start, period_end: value.period_end }
        }) } })
        result.samples.push(item)
      }
    } catch { result.partial = true }
  }
  return result
}

function add(total: Tokens, value: Tokens) {
  for (const key of tokenKeys) total[key] += value[key]
  total.total_tokens += value.total_tokens
}

function localUsage(events: UsageEvent[], provider: ProviderName, now: number, partial: boolean) {
  const unique = new Map<string, { event: UsageEvent; consumedAt: number }>()
  for (const event of events) {
    if (event.provider !== provider || event.host_id !== hostId()) continue
    const key = `${event.provider}\0${event.host_id}\0${event.identity}`
    // A later complete lifecycle measurement supersedes an earlier measurement.
    const previous = unique.get(key)
    const consumedAt = Math.min(previous?.consumedAt ?? Number.POSITIVE_INFINITY, Date.parse(event.timestamp))
    const latest = !previous || Date.parse(event.timestamp) > Date.parse(previous.event.timestamp) ||
      (event.timestamp === previous.event.timestamp && event.usage.total_tokens > previous.event.usage.total_tokens) ? event : previous.event
    // Replays may improve a measurement, but never move old consumption into today's window.
    unique.set(key, { event: latest, consumedAt })
  }
  const windows = Object.fromEntries(Object.entries(durations).map(([name, duration]) => {
    const total = tokens({})
    const byModel: Record<string, Tokens> = {}
    let requests = 0
    for (const { event, consumedAt } of unique.values()) {
      const age = now - consumedAt
      if (age < 0 || age >= duration) continue
      add(total, event.usage)
      const current = byModel[event.model] ?? tokens({})
      add(current, event.usage)
      byModel[event.model] = current
      requests++
    }
    return [name, { ...total, requests, by_model: byModel }]
  }))
  const starts = [...unique.values()].map(value => value.consumedAt).filter(value => value <= now)
  const startedAt = starts.reduce((earliest, value) => Math.min(earliest, value), Number.POSITIVE_INFINITY)
  return { scope: 'local_cli' as const, coverage: '仅此机新命令行记录；不含历史桌面、其他客户端或其他机器，历史不能回溯',
    coverage_started_at: starts.length ? new Date(startedAt).toISOString() : null, completeness: partial ? 'partial' : starts.length ? 'recorded_events' : 'no_records', windows }
}

function forecast(quota: ServerQuota, samples: QuotaSample[], providerHash: string, now: number) {
  return quota.windows.filter(window => window.enabled).map(window => {
    const base = { kind: window.kind, status: 'unknown', unit: quota.currency, seconds_to_exhaustion: null as number | null, estimated_exhaustion_at: null as string | null,
      period_end: window.period_end, basis: '服务端同一账户同一窗口额度快照差分', reason: '样本不足；不能用本机 token 推算服务端美元额度' }
    if (window.period_end && Date.parse(window.period_end) <= now) return { ...base, reason: '服务端返回的额度周期已结束，不能沿旧周期预测' }
    if (window.remaining === 0) return { ...base, status: 'exhausted', seconds_to_exhaustion: 0, estimated_exhaustion_at: new Date(now).toISOString(), reason: '服务端剩余额度为零' }
    if (window.remaining === null || window.used === null || !window.period_start || !window.period_end) return { ...base, reason: '服务端额度或窗口未知' }
    const candidates = samples.filter(value => value.provider_hash === providerHash && value.quota?.currency === quota.currency && Date.parse(value.observed_at) < now && Date.parse(value.observed_at) >= now - 24 * hour &&
      value.quota.windows.some(old => old.kind === window.kind && old.enabled && old.limit === window.limit && old.period_start === window.period_start && old.period_end === window.period_end && old.used !== null))
      .sort((a, b) => Date.parse(a.observed_at) - Date.parse(b.observed_at))
    const usedValues = [...candidates.map(value => value.quota.windows.find(old => old.kind === window.kind)!.used!), window.used]
    if (usedValues.some((value, index) => index > 0 && value < usedValues[index - 1]!)) return { ...base, reason: '同周期已用额度下降，存在重置或政策变化，停止外推' }
    const sample = candidates.find(value => Date.parse(value.observed_at) <= now - 60000)
    const old = sample?.quota.windows.find(value => value.kind === window.kind)
    if (!sample || old?.used === null || old?.used === undefined) return base
    const delta = window.used - old.used
    if (delta <= 0) return { ...base, reason: '观测窗口内没有正向消耗，无法估计耗尽时间' }
    const seconds = Math.ceil(window.remaining / delta * (now - Date.parse(sample.observed_at)) / 1000)
    if (!Number.isFinite(seconds) || now + seconds * 1000 > 8.64e15) return { ...base, reason: '观测速度不足以产生可靠的有限耗尽日期' }
    const end = Date.parse(window.period_end)
    if (now + seconds * 1000 >= end) return { ...base, status: 'resets_before_exhaustion', reason: '按观测速度，在本周期重置前不会耗尽；不预测重置后的日期' }
    return { ...base, status: 'estimated', seconds_to_exhaustion: seconds, estimated_exhaustion_at: new Date(now + seconds * 1000).toISOString(), reason: '按账户观测速度线性估算；未来速度可能变化' }
  })
}

export async function getHeadlessProviderUsage(name: ProviderName, options: Options = {}) {
  if (!['kscc', 'tokenhub'].includes(name)) throw new Error('INVALID_PROVIDER')
  options.signal?.throwIfAborted()
  const now = options.now ?? Date.now()
  const directory = options.directory ?? storageDirectory()
  const records = await readRecords(directory)
  let server: ServerQuota = { status: 'unsupported', scope: 'account', message: '服务端不提供剩余数值；模型超限状态见 models 命令', currency: null, windows: [] }
  const warnings: string[] = []
  let providerHash = ''
  if (name === 'tokenhub' && options.noNetwork) server = { ...server, status: 'temporarily_unavailable', message: '未联网；未查询服务端额度' }
  if (name === 'tokenhub' && !options.noNetwork) {
    try {
      const select = options.selectProvider ?? (await import('./headlessProviderAuth.js')).selectHeadlessProvider
      const provider = await select(name)
      providerHash = hash(`${provider.id}\0${provider.apiKey}`)
      const query = options.fetchQuota ?? (await import('../providerIntegrations/seasun/credentials.js')).fetchSeasunQuota
      server = projectHeadlessQuota(await query(provider, { signal: options.signal }))
      options.signal?.throwIfAborted()
      await writeRecord(directory, 'quota', { schema_version: 1, provider: name, provider_hash: providerHash, observed_at: new Date(now).toISOString(), quota: server } satisfies QuotaSample)
    } catch (error) {
      options.signal?.throwIfAborted()
      const status = object(error).statusCode
      const code = object(error).code
      const authRequired = status === 401 || code === 'LOGIN_REQUIRED' || code === 'PROVIDER_RECONNECT_REQUIRED'
      const unsupported = code === 'PROVIDER_QUOTA_UNSUPPORTED'
      server = { ...server, status: authRequired ? 'auth_required' : unsupported ? 'unsupported' : status === 403 ? 'permission_denied' : 'temporarily_unavailable', message: authRequired ? '授权已过期或尚未登录，请运行 login' : unsupported ? '服务端不提供额度查询接口；本机消耗仍可读取' : status === 403 ? '服务端拒绝额度查询' : '额度暂不可查；本机消耗仍可读取' }
      if (server.status === 'temporarily_unavailable') warnings.push('服务端查询或本地额度快照保存失败，未输出上游错误详情')
    }
  }
  if (records.partial) warnings.push('部分本地计量记录损坏或版本不支持，统计不完整')
  return { schema_version: 1, provider: name, host_id: hostId(), observed_at: new Date(now).toISOString(), server_quota: server,
    local_usage: localUsage(records.events, name, now, records.partial), forecast: forecast(server, records.samples, providerHash, now), warnings }
}
