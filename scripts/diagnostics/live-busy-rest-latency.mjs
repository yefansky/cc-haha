import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'

// Example A/B run against a source server:
// node scripts/diagnostics/live-busy-rest-latency.mjs --base-url http://127.0.0.1:3456 --work-dir G:\\large-workspace --status-concurrency 24 --output-dir runs
// Compare the JSON summary before/after the fix. The probe only deletes the
// sessions it creates itself and does not read response bodies into the report.

const args = new Map()
for (let index = 2; index < process.argv.length; index += 2) {
  args.set(process.argv[index], process.argv[index + 1])
}

const baseUrl = (args.get('--base-url') || 'http://127.0.0.1:3456').replace(/\/$/, '')
const wsBaseUrl = baseUrl.replace(/^http/, 'ws')
const workDir = args.get('--work-dir') || process.cwd()
const workspaceFile = args.get('--workspace-file') || 'AGENTS.md'
const durationMs = Number(args.get('--duration-ms') || 150_000)
const cycleIntervalMs = Number(args.get('--cycle-interval-ms') || 5_000)
const statusConcurrency = Number(args.get('--status-concurrency') || 0)
const outputDir = path.resolve(args.get('--output-dir') || 'runs')
const prompt = args.get('--prompt') || [
  '这是本地延迟诊断，不要读取或修改任何文件。',
  '请立即使用 Bash 工具原样执行下面这条命令，不要改写命令，也不要做其他事情：',
  `node -e "let n=0;const t=setInterval(()=>console.log(String(++n).padStart(6,'0')+' '+ 'x'.repeat(4000)),20);setTimeout(()=>clearInterval(t),120000)"`,
  '命令结束后只回复“诊断完成”。',
].join('\n')

const ownedSessionIds = new Set()
const samples = []
const statusOperations = []
const stream = {
  connectedAt: null,
  sentAt: null,
  firstEventAt: null,
  firstContentAt: null,
  completedAt: null,
  contentEvents: 0,
  contentChars: 0,
  eventCounts: {},
  error: null,
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function percentile(values, fraction) {
  if (values.length === 0) return null
  const sorted = [...values].sort((left, right) => left - right)
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * fraction) - 1))]
}

function summarize(name) {
  const values = [...samples.flatMap((sample) => sample.operations), ...statusOperations]
    .filter((operation) => operation.name === name)
    .map((operation) => operation.durationMs)
  return {
    count: values.length,
    p50Ms: percentile(values, 0.5),
    p95Ms: percentile(values, 0.95),
    maxMs: values.length > 0 ? Math.max(...values) : null,
  }
}

async function timedFetch(name, url, init) {
  const startedAt = performance.now()
  const startedWallAt = new Date().toISOString()
  try {
    const response = await fetch(url, init)
    const headersAtMs = performance.now() - startedAt
    const text = await response.text()
    let json = null
    try {
      json = text ? JSON.parse(text) : null
    } catch {
      // Preserve only size/status in the report; endpoint payloads may be private.
    }
    return {
      name,
      ok: response.ok,
      status: response.status,
      startedWallAt,
      headersAtMs,
      durationMs: performance.now() - startedAt,
      responseBytes: Buffer.byteLength(text),
      json,
    }
  } catch (error) {
    return {
      name,
      ok: false,
      startedWallAt,
      headersAtMs: null,
      durationMs: performance.now() - startedAt,
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
  if (typeof sessionId === 'string') ownedSessionIds.add(sessionId)
  delete result.json
  return { result, sessionId: typeof sessionId === 'string' ? sessionId : null }
}

async function deleteOwnedSession(sessionId) {
  if (!ownedSessionIds.has(sessionId)) throw new Error(`Refusing to delete unowned session ${sessionId}`)
  const result = await timedFetch('delete', `${baseUrl}/api/sessions/${encodeURIComponent(sessionId)}`, {
    method: 'DELETE',
  })
  delete result.json
  if (result.ok) ownedSessionIds.delete(sessionId)
  return result
}

async function connect(sessionId) {
  const socket = new WebSocket(`${wsBaseUrl}/ws/${encodeURIComponent(sessionId)}`)
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Timed out waiting for WebSocket connection')), 30_000)
    const onOpeningMessage = (event) => {
      const message = JSON.parse(String(event.data))
      stream.firstEventAt ||= new Date().toISOString()
      if (message.type === 'connected') {
        clearTimeout(timeout)
        socket.removeEventListener('message', onOpeningMessage)
        stream.connectedAt = new Date().toISOString()
        resolve()
      }
    }
    socket.addEventListener('message', onOpeningMessage)
    socket.addEventListener('error', () => {
      clearTimeout(timeout)
      reject(new Error('WebSocket connection failed'))
    }, { once: true })
  })

  socket.addEventListener('message', (event) => {
    const message = JSON.parse(String(event.data))
    stream.eventCounts[message.type] = (stream.eventCounts[message.type] || 0) + 1
    if (message.type === 'content_delta') {
      stream.firstContentAt ||= new Date().toISOString()
      stream.contentEvents += 1
      stream.contentChars += String(message.text || '').length
    }
    if (message.type === 'message_complete') stream.completedAt = new Date().toISOString()
    if (message.type === 'error') stream.error = String(message.message || 'unknown stream error')
  })
  return socket
}

async function sampleCycle(index, mainSessionId) {
  const cycleStartedAt = new Date().toISOString()
  const operations = []
  const list = await timedFetch('list', `${baseUrl}/api/sessions?limit=400`)
  delete list.json
  operations.push(list)

  const file = await timedFetch(
    'file',
    `${baseUrl}/api/sessions/${encodeURIComponent(mainSessionId)}/workspace/file?path=${encodeURIComponent(workspaceFile)}`,
  )
  delete file.json
  operations.push(file)

  const created = await createOwnedSession()
  operations.push(created.result)
  if (created.sessionId) operations.push(await deleteOwnedSession(created.sessionId))

  samples.push({ index, cycleStartedAt, operations })
  process.stdout.write(`${JSON.stringify({ event: 'sample', index, operations })}\n`)
}

async function cleanup() {
  for (const sessionId of [...ownedSessionIds]) {
    await deleteOwnedSession(sessionId).catch((error) => {
      process.stderr.write(`cleanup failed for ${sessionId}: ${error instanceof Error ? error.message : String(error)}\n`)
    })
  }
}

async function main() {
  await mkdir(outputDir, { recursive: true })
  const startedAt = new Date().toISOString()
  const main = await createOwnedSession()
  if (!main.sessionId || !main.result.ok) throw new Error(`Could not create main diagnostic session: ${JSON.stringify(main.result)}`)
  const mainSessionId = main.sessionId
  const socket = await connect(mainSessionId)
  stream.sentAt = new Date().toISOString()
  socket.send(JSON.stringify({ type: 'user_message', content: prompt }))
  const statusPromise = Promise.all(Array.from({ length: statusConcurrency }, async (_, index) => {
    const operation = await timedFetch(
      'status',
      `${baseUrl}/api/sessions/${encodeURIComponent(mainSessionId)}/workspace/status`,
    )
    delete operation.json
    operation.index = index
    statusOperations.push(operation)
    process.stdout.write(`${JSON.stringify({ event: 'status', operation })}\n`)
  }))

  const deadline = Date.now() + durationMs
  let cycleIndex = 0
  // Keep sampling for the full requested window. A completed chat turn must not
  // hide a later status-response/connection-pool congestion window.
  while (Date.now() < deadline) {
    cycleIndex += 1
    await sampleCycle(cycleIndex, mainSessionId)
    if (Date.now() < deadline) await sleep(cycleIntervalMs)
  }

  if (!stream.completedAt && !stream.error && socket.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify({ type: 'stop_generation' }))
    await sleep(2_000)
  }
  socket.close()
  await statusPromise

  const finishedAt = new Date().toISOString()
  const report = {
    schemaVersion: 1,
    config: { baseUrl, workDir, workspaceFile, durationMs, cycleIntervalMs, statusConcurrency },
    startedAt,
    finishedAt,
    stream,
    summary: {
      list: summarize('list'),
      file: summarize('file'),
      create: summarize('create'),
      delete: summarize('delete'),
      status: summarize('status'),
    },
    statusOperations,
    samples,
  }
  const stamp = finishedAt.replace(/[:.]/g, '-')
  const reportPath = path.join(outputDir, `live-busy-rest-latency-${stamp}.json`)
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8')
  process.stdout.write(`${JSON.stringify({ event: 'complete', reportPath, summary: report.summary, stream })}\n`)
  await cleanup()
}

process.on('SIGINT', () => {
  void cleanup().finally(() => process.exit(130))
})
process.on('SIGTERM', () => {
  void cleanup().finally(() => process.exit(143))
})

main().catch(async (error) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`)
  await cleanup()
  process.exitCode = 1
})
