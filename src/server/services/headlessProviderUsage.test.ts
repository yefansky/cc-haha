import { afterEach, beforeEach, expect, test } from 'bun:test'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import { getHeadlessProviderUsage, projectHeadlessQuota, recordHeadlessUsage } from './headlessProviderUsage.js'
import type { SavedProvider } from '../types/provider.js'

let directory: string
const now = Date.parse('2026-11-01T10:00:00Z')
const provider = { id: 'test-provider', apiKey: 'fake-only-key' } as SavedProvider
const selectProvider = async () => provider
beforeEach(async () => {
  const root = path.resolve('.runtime/cli-provider-task/usage-tests')
  await fs.mkdir(root, { recursive: true })
  directory = await fs.mkdtemp(path.join(root, 'run-'))
})
afterEach(async () => {
  // mkdtemp is fixed beneath the task's non-system-drive test root.
  if (!directory.startsWith(path.resolve('.runtime/cli-provider-task/usage-tests') + path.sep)) throw new Error('invalid cleanup path')
  await fs.rm(directory, { recursive: true, force: true })
})
const quota = (used: number, extra = {}) => ({ code: 0, data: { currency: 'USD', windows: [
  { kind: 'fixed_5h', enabled: true, quota_amount: 100, used_amount: used, period_start: '2026-11-01T08:00:00Z', period_end: '2026-11-01T23:00:00Z', violated: false },
], ...extra } })

test('concurrent runs, duplicate content blocks and providers stay separate across exact rolling windows', async () => {
  const common = { provider: 'kscc' as const, model: 'same-model', runId: 'run-a', messageId: 'msg-a', requestId: 'req-a', timestamp: new Date(now - 1000).toISOString(), usage: { input_tokens: 10, output_tokens: 2, cache_read_input_tokens: 20, cache_creation_input_tokens: 3 } }
  await Promise.all([
    recordHeadlessUsage(common, { directory }), recordHeadlessUsage(common, { directory }),
    recordHeadlessUsage({ ...common, runId: 'run-b', requestId: 'req-b' }, { directory }),
    recordHeadlessUsage({ ...common, runId: 'run-replayed' }, { directory }),
    recordHeadlessUsage({ ...common, provider: 'tokenhub' }, { directory }),
    recordHeadlessUsage({ ...common, runId: 'at-one-hour', requestId: 'req-hour', timestamp: new Date(now - 3600000).toISOString() }, { directory }),
    recordHeadlessUsage({ ...common, runId: 'at-one-day', requestId: 'req-day', timestamp: new Date(now - 24 * 3600000).toISOString() }, { directory }),
    recordHeadlessUsage({ ...common, runId: 'at-one-week', requestId: 'req-week', timestamp: new Date(now - 7 * 24 * 3600000).toISOString() }, { directory }),
  ])
  const report = await getHeadlessProviderUsage('kscc', { directory, now })
  expect(report.local_usage.windows['1h']).toMatchObject({ requests: 2, input_tokens: 20, output_tokens: 4, cache_read_input_tokens: 40, cache_creation_input_tokens: 6, total_tokens: 70 })
  expect(report.local_usage.windows['24h'].requests).toBe(3)
  expect(report.local_usage.windows['7d'].requests).toBe(4)
  expect(report.server_quota.status).toBe('unsupported')
  expect(report.forecast).toEqual([])
  expect((await getHeadlessProviderUsage('tokenhub', { directory, now, selectProvider, fetchQuota: async () => quota(10) })).local_usage.windows['1h'].requests).toBe(1)
})

test('only numeric counters and hashed identities are saved, incomplete records are visible', async () => {
  await recordHeadlessUsage({ provider: 'kscc', model: 'glm-5.1', runId: 'private-run-id', requestId: 'private-request-id', messageId: 'private-message-id', usage: { input_tokens: 4 } }, { directory })
  const filename = (await fs.readdir(directory))[0]!
  const raw = await fs.readFile(path.join(directory, filename), 'utf8')
  expect(raw).not.toContain('private-')
  await fs.writeFile(path.join(directory, 'event-aaaa.json'), '{bad')
  const report = await getHeadlessProviderUsage('kscc', { directory, now })
  expect(report.local_usage.completeness).toBe('partial')
  expect(report.warnings).toHaveLength(1)
  await expect(recordHeadlessUsage({ provider: 'kscc', model: 'glm-5.1', runId: 'x', usage: { input_tokens: -1 } }, { directory })).rejects.toThrow('INVALID_USAGE_RECORD')
})

test('quota whitelist excludes all server messages and unknown fields, unknown limits do not become zero', () => {
  const projected = projectHeadlessQuota(quota(20, { accessToken: 'never-output-this', message: 'never-output-this' }))
  expect(JSON.stringify(projected)).not.toContain('never-output-this')
  expect(projected.windows[0]?.remaining).toBe(80)
  const unknown = quota(20)
  unknown.data.windows[0]!.quota_amount = Infinity
  expect(projectHeadlessQuota(unknown).windows[0]?.remaining).toBeNull()
  expect(() => projectHeadlessQuota({ code: 0, data: { currency: 'secret-text', windows: [] } })).toThrow('INVALID_QUOTA_RESPONSE')
})

test('account snapshots produce same-currency forecast, never token-priced forecasts or cross-reset slopes', async () => {
  await getHeadlessProviderUsage('tokenhub', { directory, now: now - 3600000, selectProvider, fetchQuota: async () => quota(10) })
  const current = await getHeadlessProviderUsage('tokenhub', { directory, now, selectProvider, fetchQuota: async () => quota(30) })
  // 70 USD remaining / (20 USD / 3600 seconds) = 12600 seconds.
  expect(current.forecast[0]?.seconds_to_exhaustion).toBe(12600)
  expect(current.forecast[0]?.status).toBe('estimated')
  const changed = quota(40)
  changed.data.windows[0]!.period_start = '2026-11-01T09:00:00Z'
  expect((await getHeadlessProviderUsage('tokenhub', { directory, now: now + 3600000, selectProvider, fetchQuota: async () => changed })).forecast[0]?.seconds_to_exhaustion).toBeNull()
  const lower = await getHeadlessProviderUsage('tokenhub', { directory, now: now + 7200000, selectProvider, fetchQuota: async () => quota(5) })
  expect(lower.forecast[0]?.seconds_to_exhaustion).toBeNull()
})

test('unknown, zero and auth errors return bounded safe statuses while local usage stays readable', async () => {
  const unavailable = await getHeadlessProviderUsage('tokenhub', { directory, now, selectProvider, fetchQuota: async () => { throw Object.assign(new Error('secret-error'), { statusCode: 401 }) } })
  expect(unavailable.server_quota.status).toBe('auth_required')
  expect(JSON.stringify(unavailable)).not.toContain('secret-error')
  const zero = await getHeadlessProviderUsage('tokenhub', { directory, now, selectProvider, fetchQuota: async () => quota(100) })
  expect(zero.forecast[0]?.seconds_to_exhaustion).toBe(0)
  const empty = await getHeadlessProviderUsage('tokenhub', { directory, now, selectProvider, fetchQuota: async () => ({ code: 0, data: { currency: 'USD', windows: [] } }) })
  expect(empty.forecast).toEqual([])
})

test('no records, offline mode, login codes and malformed snapshots remain explicit and safe', async () => {
  const empty = await getHeadlessProviderUsage('tokenhub', { directory, now, noNetwork: true, selectProvider: async () => { throw new Error('network must not run') } })
  expect(empty.local_usage.completeness).toBe('no_records')
  expect(empty.local_usage.coverage_started_at).toBeNull()
  expect(empty.server_quota.message).toContain('未联网')
  const missing = await getHeadlessProviderUsage('tokenhub', { directory, now, selectProvider: async () => { throw Object.assign(new Error('private'), { code: 'LOGIN_REQUIRED' }) } })
  expect(missing.server_quota.status).toBe('auth_required')
  await fs.writeFile(path.join(directory, 'quota-aaaa.json'), JSON.stringify({ schema_version: 1, provider: 'tokenhub', provider_hash: 'a'.repeat(64), observed_at: new Date(now).toISOString(), quota: { windows: {} } }))
  const corrupt = await getHeadlessProviderUsage('tokenhub', { directory, now, selectProvider, fetchQuota: async () => quota(10) })
  expect(corrupt.local_usage.completeness).toBe('partial')
})

test('a forecast that crosses reset does not invent a date in the next quota period', async () => {
  const earlyReset = (used: number) => {
    const value = quota(used)
    value.data.windows[0]!.period_end = '2026-11-01T13:00:00Z'
    return value
  }
  await getHeadlessProviderUsage('tokenhub', { directory, now: now - 3600000, selectProvider, fetchQuota: async () => earlyReset(10) })
  const report = await getHeadlessProviderUsage('tokenhub', { directory, now, selectProvider, fetchQuota: async () => earlyReset(30) })
  expect(report.forecast[0]?.status).toBe('resets_before_exhaustion')
  expect(report.forecast[0]?.seconds_to_exhaustion).toBeNull()
  expect(report.forecast[0]?.estimated_exhaustion_at).toBeNull()
})

test('two independent CLI processes can persist concurrently without lost updates', async () => {
  const modulePath = new URL('./headlessProviderUsage.ts', import.meta.url).href
  const processes = ['first', 'second'].map(runId => Bun.spawn([process.execPath, '--eval',
    `const { recordHeadlessUsage } = await import(${JSON.stringify(modulePath)}); await recordHeadlessUsage(${JSON.stringify({ provider: 'kscc', model: 'glm-5.1', runId, usage: { input_tokens: 11 }, timestamp: new Date(now - 100).toISOString() })}, { directory: ${JSON.stringify(directory)} });`],
  { stdout: 'pipe', stderr: 'pipe', env: { ...process.env, CLAUDE_CONFIG_DIR: path.join(directory, 'config') } }))
  for (const process of processes) expect(await process.exited).toBe(0)
  const report = await getHeadlessProviderUsage('kscc', { directory, now })
  expect(report.local_usage.windows['1h'].requests).toBe(2)
  expect(report.local_usage.windows['1h'].total_tokens).toBe(22)
})

test('a nonmonotonic account series and an ended quota period are never extrapolated', async () => {
  for (const [offset, used] of [[-7200000, 10], [-3600000, 40], [0, 20]]) {
    const report = await getHeadlessProviderUsage('tokenhub', { directory, now: now + offset!, selectProvider, fetchQuota: async () => quota(used!) })
    if (offset === 0) {
      expect(report.forecast[0]?.seconds_to_exhaustion).toBeNull()
      expect(report.forecast[0]?.reason).toContain('下降')
    }
  }
  const ended = quota(20)
  ended.data.windows[0]!.period_end = '2026-11-01T09:00:00Z'
  const report = await getHeadlessProviderUsage('tokenhub', { directory, now, selectProvider, fetchQuota: async () => ended })
  expect(report.forecast[0]?.reason).toContain('周期已结束')
})

test('query cancellation reaches the credential query and prevents a late snapshot write', async () => {
  const controller = new AbortController()
  const pending = getHeadlessProviderUsage('tokenhub', { directory, now, selectProvider, signal: controller.signal,
    fetchQuota: async (_provider, options) => {
      expect(options?.signal).toBe(controller.signal)
      controller.abort()
      return quota(10)
    } })
  await expect(pending).rejects.toThrow()
  expect(await fs.readdir(directory)).toEqual([])
})

test('missing measurements are rejected but an explicit measured zero remains valid', async () => {
  await expect(recordHeadlessUsage({ provider: 'kscc', model: 'glm-5.1', runId: 'missing', usage: {} }, { directory })).rejects.toThrow('USAGE_MEASUREMENT_MISSING')
  await recordHeadlessUsage({ provider: 'kscc', model: 'glm-5.1', runId: 'zero', timestamp: new Date(now).toISOString(), usage: { input_tokens: 0 } }, { directory })
  const report = await getHeadlessProviderUsage('kscc', { directory, now })
  expect(report.local_usage.completeness).toBe('recorded_events')
  expect(report.local_usage.windows['1h'].requests).toBe(1)
  expect(report.local_usage.windows['1h'].total_tokens).toBe(0)
})

test('replaying an old request updates its measurement without moving consumption into the current hour', async () => {
  const event = { provider: 'kscc' as const, model: 'glm-5.1', runId: 'old-run', messageId: 'old-message', requestId: 'old-request', usage: { input_tokens: 10 }, timestamp: new Date(now - 7200000).toISOString() }
  await recordHeadlessUsage(event, { directory })
  await recordHeadlessUsage({ ...event, runId: 'replay-run', usage: { input_tokens: 12 }, timestamp: new Date(now).toISOString() }, { directory })
  const report = await getHeadlessProviderUsage('kscc', { directory, now })
  expect(report.local_usage.windows['1h'].requests).toBe(0)
  expect(report.local_usage.windows['24h'].requests).toBe(1)
  expect(report.local_usage.windows['24h'].total_tokens).toBe(12)
  expect(report.local_usage.coverage_started_at).toBe(event.timestamp)
})
