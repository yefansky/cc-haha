import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { Agent } from 'undici'

// Deterministically models Chromium's per-origin connection queue. In `direct`
// mode every logical status load becomes an HTTP request (the old UI behavior).
// In `coalesced` mode all logical callers share one request (the fixed UI
// behavior). The probe creates and deletes only sessions it owns.

const args = new Map()
for (let index = 2; index < process.argv.length; index += 2) {
  args.set(process.argv[index], process.argv[index + 1])
}

const baseUrl = (args.get('--base-url') || 'http://127.0.0.1:3456').replace(/\/$/, '')
const workDir = args.get('--work-dir') || process.cwd()
const workspaceFile = args.get('--workspace-file') || 'AGENTS.md'
const statusMode = args.get('--status-mode') === 'coalesced' ? 'coalesced' : 'direct'
const logicalStatusCalls = clamp(Number(args.get('--status-calls') || 24), 1, 100)
const connections = clamp(Number(args.get('--connections') || 6), 1, 32)
const actionDelayMs = clamp(Number(args.get('--action-delay-ms') || 1_000), 0, 60_000)
const requestTimeoutMs = clamp(Number(args.get('--request-timeout-ms') || 240_000), 5_000, 600_000)
const iterations = clamp(Number(args.get('--iterations') || 1), 1, 20)
const outputDir = path.resolve(args.get('--output-dir') || 'runs')

const dispatcher = new Agent({ connections, pipelining: 1 })
const ownedSessionIds = new Set()

function clamp(value, minimum, maximum) {
  if (!Number.isFinite(value)) return minimum
  return Math.max(minimum, Math.min(maximum, Math.round(value)))
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function percentile(values, fraction) {
  if (values.length === 0) return null
  const sorted = [...values].sort((left, right) => left - right)
  const index = Math.max(0, Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1))
  return Math.round(sorted[index] * 100) / 100
}

async function timedFetch(name, url, init = {}) {
  const startedAt = new Date().toISOString()
  const started = performance.now()
  try {
    const response = await fetch(url, {
      ...init,
      dispatcher,
      signal: AbortSignal.timeout(requestTimeoutMs),
    })
    const headersMs = performance.now() - started
    const text = await response.text()
    let json = null
    if (name === 'create') {
      try {
        json = text ? JSON.parse(text) : null
      } catch {
        // The error result below retains status and size without response data.
      }
    }
    return {
      name,
      ok: response.ok,
      status: response.status,
      startedAt,
      headersMs: Math.round(headersMs * 100) / 100,
      durationMs: Math.round((performance.now() - started) * 100) / 100,
      responseBytes: Buffer.byteLength(text),
      json,
    }
  } catch (error) {
    return {
      name,
      ok: false,
      status: null,
      startedAt,
      headersMs: null,
      durationMs: Math.round((performance.now() - started) * 100) / 100,
      responseBytes: null,
      error: error instanceof Error ? error.message : String(error),
      json: null,
    }
  }
}

async function createOwnedSession() {
  const result = await timedFetch('create', `${baseUrl}/api/sessions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ workDir, permissionMode: 'bypassPermissions' }),
  })
  const sessionId = result.json?.sessionId
  result.json = undefined
  if (typeof sessionId === 'string') ownedSessionIds.add(sessionId)
  return { result, sessionId: typeof sessionId === 'string' ? sessionId : null }
}

async function deleteOwnedSession(sessionId) {
  if (!ownedSessionIds.has(sessionId)) {
    throw new Error(`Refusing to delete non-owned session ${sessionId}`)
  }
  const result = await timedFetch('delete', `${baseUrl}/api/sessions/${encodeURIComponent(sessionId)}`, {
    method: 'DELETE',
  })
  if (result.ok) ownedSessionIds.delete(sessionId)
  return result
}

async function runIteration(index) {
  const target = await createOwnedSession()
  if (!target.sessionId || !target.result.ok) {
    throw new Error(`Could not create target session: ${JSON.stringify(target.result)}`)
  }

  const statusUrl = `${baseUrl}/api/sessions/${encodeURIComponent(target.sessionId)}/workspace/status`
  const networkStatusOperations = []
  let sharedStatusRequest = null
  const loadStatus = () => {
    if (statusMode === 'coalesced' && sharedStatusRequest) return sharedStatusRequest
    const request = timedFetch('status', statusUrl).then((result) => {
      networkStatusOperations.push(result)
      return result
    })
    if (statusMode === 'coalesced') sharedStatusRequest = request
    return request
  }

  const logicalStatusPromises = Array.from({ length: logicalStatusCalls }, () => loadStatus())
  await sleep(actionDelayMs)
  const actionStarted = performance.now()
  const filePromise = timedFetch(
    'file',
    `${baseUrl}/api/sessions/${encodeURIComponent(target.sessionId)}/workspace/file?path=${encodeURIComponent(workspaceFile)}`,
  )
  const listPromise = timedFetch('list', `${baseUrl}/api/sessions?limit=20`)
  const createDeletePromise = (async () => {
    const created = await createOwnedSession()
    const deleted = created.sessionId ? await deleteOwnedSession(created.sessionId) : null
    return { create: created.result, delete: deleted }
  })()

  const [logicalStatuses, file, list, createDelete] = await Promise.all([
    Promise.all(logicalStatusPromises),
    filePromise,
    listPromise,
    createDeletePromise,
  ])
  const actionWallMs = Math.round((performance.now() - actionStarted) * 100) / 100
  await deleteOwnedSession(target.sessionId)

  return {
    index,
    targetCreate: target.result,
    logicalStatusCallCount: logicalStatuses.length,
    networkStatusRequestCount: networkStatusOperations.length,
    networkStatusOperations,
    actions: { file, list, ...createDelete, wallMs: actionWallMs },
  }
}

function summarize(iterationResults, operationName) {
  const values = iterationResults.flatMap((iteration) => {
    if (operationName === 'status') return iteration.networkStatusOperations.map((item) => item.durationMs)
    const operation = iteration.actions[operationName]
    return operation ? [operation.durationMs] : []
  })
  return {
    count: values.length,
    p50Ms: percentile(values, 0.5),
    p95Ms: percentile(values, 0.95),
    maxMs: values.length ? Math.round(Math.max(...values) * 100) / 100 : null,
  }
}

async function cleanup() {
  for (const sessionId of [...ownedSessionIds]) {
    try {
      await deleteOwnedSession(sessionId)
    } catch (error) {
      process.stderr.write(`cleanup failed for ${sessionId}: ${error instanceof Error ? error.message : String(error)}\n`)
    }
  }
  await dispatcher.close()
}

async function main() {
  await mkdir(outputDir, { recursive: true })
  const startedAt = new Date().toISOString()
  const iterationResults = []
  for (let index = 1; index <= iterations; index += 1) {
    const result = await runIteration(index)
    iterationResults.push(result)
    process.stdout.write(`${JSON.stringify({ event: 'iteration', statusMode, result })}\n`)
  }
  const finishedAt = new Date().toISOString()
  const report = {
    schemaVersion: 1,
    startedAt,
    finishedAt,
    config: {
      baseUrl,
      workDir,
      workspaceFile,
      statusMode,
      logicalStatusCalls,
      connections,
      actionDelayMs,
      requestTimeoutMs,
      iterations,
    },
    summary: {
      status: summarize(iterationResults, 'status'),
      file: summarize(iterationResults, 'file'),
      list: summarize(iterationResults, 'list'),
      create: summarize(iterationResults, 'create'),
      delete: summarize(iterationResults, 'delete'),
    },
    iterations: iterationResults,
  }
  const reportPath = path.join(
    outputDir,
    `workspace-status-queue-${statusMode}-${finishedAt.replace(/[:.]/g, '-')}.json`,
  )
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8')
  process.stdout.write(`${JSON.stringify({ event: 'complete', reportPath, summary: report.summary })}\n`)
}

process.on('SIGINT', () => {
  void cleanup().finally(() => process.exit(130))
})
process.on('SIGTERM', () => {
  void cleanup().finally(() => process.exit(143))
})

main()
  .catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`)
    process.exitCode = 1
  })
  .finally(cleanup)
