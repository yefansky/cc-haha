import { test, expect } from 'bun:test'
import { mkdtemp, rm, readFile, access } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { startRuntimeObservationChannel } from './runtimeObservationChannel'
import { runtimeObservation } from './runtimeObservation'
import { runtimeBoundaryTrace } from './runtimeBoundaryTrace'

test('private channel authenticates and live configuration only changes observation', async () => {
  const root = await mkdtemp(join(tmpdir(), 'observation-channel-'))
  const previous = process.env.CLAUDE_CONFIG_DIR
  const previousMode = runtimeObservation.snapshot().config.mode
  process.env.CLAUDE_CONFIG_DIR = root
  const channel = startRuntimeObservationChannel({ role: 'server', getState: () => ({ activeSessions: 3 }) })
  try {
    const descriptor = await channel.ready
    expect(descriptor).not.toBeNull()
    const { url, token, pid } = descriptor!
    const headers = { authorization: `Bearer ${token}` }
    expect((await fetch(`${url}/snapshot`)).status).toBe(403)
    expect((await fetch(`${url}/snapshot`, { headers: { ...headers, origin: 'http://localhost' } })).status).toBe(403)
    expect((await fetch(`${url}/snapshot`, { headers: { ...headers, 'x-forwarded-for': '127.0.0.1' } })).status).toBe(403)
    const result = await (await fetch(`${url}/snapshot`, { headers })).json()
    expect(result.stale).toBe(false)
    expect(result.snapshot.state.activeSessions).toBe(3)
    const configuration = await (await fetch(`${url}/configure`, { method: 'POST', headers, body: JSON.stringify({ mode: 'detailed', durationMs: 1000 }) })).json()
    expect(configuration.applied).toBe(true)
    expect(configuration.pending).toBe(false)
    expect((await fetch(`${url}/configure`, { method: 'POST', headers, body: JSON.stringify({ mode: 'basic', eval: 'danger' }) })).status).toBe(400)
    const recording = await (await fetch(`${url}/recording`, { method: 'POST', headers, body: JSON.stringify({ action: 'start', recordingId: 'test-recording' }) })).json()
    expect(recording.applied).toBe(true)
    runtimeBoundaryTrace.record({ layer: 'server', direction: 'in', event: 'receive', correlationId: 'command-1' })
    const recorded = await (await fetch(`${url}/snapshot`, { headers })).json()
    expect(recorded.boundaryTrace.recordingId).toBe('test-recording')
    expect(recorded.boundaryTrace.entries[0].correlationId).toBe('command-1')
    const stopped = await (await fetch(`${url}/recording`, { method: 'POST', headers, body: JSON.stringify({ action: 'stop' }) })).json()
    expect(stopped.boundaryTrace.recording).toBe(false)
    expect(stopped.boundaryTrace.entries).toHaveLength(1)
    expect(JSON.parse(await readFile(join(root, 'cc-haha/live-debug', `${pid}.json`), 'utf8')).token).toBe(token)
    await channel.stop()
    expect(await access(join(root, 'cc-haha/live-debug', `${pid}.json`)).then(() => true, () => false)).toBe(false)
  } finally {
    await channel.stop()
    runtimeObservation.configure({ mode: previousMode })
    runtimeBoundaryTrace.stop()
    if (previous === undefined) delete process.env.CLAUDE_CONFIG_DIR
    else process.env.CLAUDE_CONFIG_DIR = previous
    await rm(root, { recursive: true, force: true })
  }
})

test('independent worker observes a synchronous main-thread stall without interrupting it', async () => {
  const root = await mkdtemp(join(tmpdir(), 'observation-stall-'))
  const source = `import { startRuntimeObservationChannel } from ${JSON.stringify(join(import.meta.dir, 'runtimeObservationChannel.ts'))}
import { runtimeObservation } from ${JSON.stringify(join(import.meta.dir, 'runtimeObservation.ts'))}
import { runtimeBoundaryTrace } from ${JSON.stringify(join(import.meta.dir, 'runtimeBoundaryTrace.ts'))}
const c = startRuntimeObservationChannel({role:'cli',getState:()=>({phase:'before-busy-loop'})})
const keep = setInterval(()=>{},1000)
const d = await c.ready
console.log(JSON.stringify(d))
await Bun.sleep(200)
runtimeObservation.configure({mode:'detailed'})
const op=runtimeObservation.begin('synchronous.busy-loop')
op.phase('cpu-bound')
runtimeBoundaryTrace.start('blocked-recording')
runtimeBoundaryTrace.record({layer:'cli',direction:'in',event:'receive',correlationId:'blocked-command'})
const until=Date.now()+4500
while(Date.now()<until) {}
console.log('continued-without-intervention')
await c.stop()
clearInterval(keep)`
  const child = Bun.spawn([process.execPath, '-e', source], { env: { ...process.env, CLAUDE_CONFIG_DIR: root }, stdout: 'pipe', stderr: 'pipe' })
  try {
    const reader = child.stdout.getReader()
    const first = await reader.read()
    const descriptor = JSON.parse(new TextDecoder().decode(first.value).trim())
    expect(descriptor).not.toBeNull()
    const headers = { authorization: `Bearer ${descriptor.token}` }
    await Bun.sleep(3000)
    const before = performance.now()
    const result = await (await fetch(`${descriptor.url}/snapshot`, { headers })).json()
    expect(performance.now() - before).toBeLessThan(1000)
    expect(result.stale).toBe(true)
    expect(result.heartbeatAgeMs).toBeGreaterThan(2500)
    expect(result.snapshot.state.phase).toBe('before-busy-loop')
    expect(result.operations.some((operation: any) => operation.name === 'synchronous.busy-loop' && operation.state === 'cpu-bound' && operation.startStack && operation.stackKind === 'operation-start-not-current-cpu-stack')).toBe(true)
    expect(result.transitionDeliveryIncomplete).toBe(false)
    expect(result.boundaryTrace.entries[0].correlationId).toBe('blocked-command')
    expect(result.boundaryDeliveryIncomplete).toBe(false)
    const response = await fetch(`${descriptor.url}/configure`, { method: 'POST', headers, body: JSON.stringify({ mode: 'detailed' }) })
    expect(response.status).toBe(202)
    expect((await response.json()).pending).toBe(true)
    let rest = ''
    while(true) { const chunk = await reader.read(); if(chunk.done) break; rest += new TextDecoder().decode(chunk.value) }
    expect(rest).toContain('continued-without-intervention')
    expect(await child.exited).toBe(0)
  } finally {
    child.kill()
    await child.exited
    await rm(root, { recursive: true, force: true })
  }
}, 15000)

test('compiled minified executable embeds the worker without a source-file dependency', async () => {
  const root = await mkdtemp(join(tmpdir(), 'observation-compiled-'))
  const entry = join(root, 'fixture.ts')
  const outfile = join(root, process.platform === 'win32' ? 'fixture.exe' : 'fixture')
  const { writeFile } = await import('node:fs/promises')
  await writeFile(entry, `import { startRuntimeObservationChannel } from ${JSON.stringify(join(import.meta.dir, 'runtimeObservationChannel.ts'))}
const keep=setInterval(()=>{},1000)
const channel=startRuntimeObservationChannel({role:'cli'})
const d=await channel.ready
if (!d) process.exit(2)
const r=await fetch(d.url+'/snapshot',{headers:{authorization:'Bearer '+d.token}})
console.log(JSON.stringify({status:r.status,evidence:(await r.json()).evidence}))
await channel.stop()
clearInterval(keep)`)
  try {
    const build = Bun.spawn([process.execPath, 'build', '--compile', '--minify', entry, '--outfile', outfile], { stdout: 'pipe', stderr: 'pipe' })
    const buildError = await new Response(build.stderr).text()
    expect(await build.exited, buildError).toBe(0)
    await rm(entry)
    const run = Bun.spawn([outfile], { cwd: root, env: { ...process.env, CLAUDE_CONFIG_DIR: join(root, 'config') }, stdout: 'pipe', stderr: 'pipe' })
    const output = await new Response(run.stdout).text()
    expect(await run.exited, await new Response(run.stderr).text()).toBe(0)
    expect(JSON.parse(output)).toEqual({ status: 200, evidence: 'last-known-instrumented-state' })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}, 60000)
