import { afterAll, beforeAll, expect, test } from 'bun:test'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { buildExternalSubagentArgs, buildExternalSubagentEnv, classifySubagentFailure, executeRoutedSubagentProcess, resolveExternalSubagentCommand, runRoutedSubagent } from './subagentRouting.js'

let directory: string
const saved = { ...process.env }
beforeAll(async () => {
  const root = resolve('artifacts')
  await mkdir(root, { recursive: true })
  directory = await mkdtemp(join(root, 'subagent-routing-'))
  await mkdir(join(directory, 'cc-haha'))
  await writeFile(join(directory, 'calls'), '{}\n')
  await writeFile(join(directory, 'cc-haha', 'providers.json'), JSON.stringify({ schemaVersion: 1, activeId: 'unrelated', providers: [
    { id: 'alternative', presetId: 'custom', name: 'alternative', apiKey: 'secret-fallback-key', baseUrl: 'http://fallback.invalid', apiFormat: 'anthropic', models: { main: 'target', haiku: 'target', sonnet: 'target', opus: 'target' } },
  ] }))
  await writeFile(join(directory, 'fake.ts'), `
    const fs = await import('node:fs/promises')
    const args = process.argv.slice(2)
    await fs.appendFile(process.env.CLAUDE_CONFIG_DIR + '/calls', JSON.stringify({ base: process.env.ANTHROPIC_BASE_URL, args }) + '\\n')
    const failure = process.env.ANTHROPIC_BASE_URL === 'http://broken.invalid'
    if (process.env.FAKE_ACTIVITY === '1') console.log(JSON.stringify({type:'assistant',message:{content:[{type:'tool_use',id:'one',name:'Read'}]}}))
    if (process.env.FAKE_API_ERROR === '1') console.log(JSON.stringify({type:'assistant',error:'server_error',message:{content:[{type:'text',text:'API Error: Connection error.'}]}}))
    if (process.env.FAKE_EFFORT_PROBE === '1') {
      const { configureEffortParams } = await import(${JSON.stringify(resolve('src/services/api/claude.ts').replaceAll('\\', '/'))})
      const { resolveAppliedEffort } = await import(${JSON.stringify(resolve('src/utils/effort.ts').replaceAll('\\', '/'))})
      const { anthropicToOpenaiChat } = await import(${JSON.stringify(resolve('src/server/proxy/transform/anthropicToOpenaiChat.ts').replaceAll('\\', '/'))})
      const model = args[args.indexOf('--model')+1]
      const output_config = {}
      configureEffortParams(resolveAppliedEffort(model, undefined), output_config, {}, [], model)
      const body = anthropicToOpenaiChat({model,messages:[{role:'user',content:'hi'}],max_tokens:16,output_config})
      console.log(JSON.stringify({type:'result',result:JSON.stringify({reasoning_effort:body.reasoning_effort}),is_error:false}))
      process.exit(0)
    }
    console.log(JSON.stringify(failure ? {type:'result',is_error:true,errors:['Connection error ECONNREFUSED']} : {type:'result',result:JSON.stringify({model:args[args.indexOf('--model')+1],effort:process.env.CLAUDE_CODE_EFFORT_LEVEL,subagentModel:process.env.CLAUDE_CODE_SUBAGENT_MODEL,routeIdentity:process.env.CC_HAHA_SUBAGENT_PROVIDER_ID,thinkingBudget:process.env.MAX_THINKING_TOKENS,base:process.env.ANTHROPIC_BASE_URL,key:process.env.ANTHROPIC_API_KEY,args}),is_error:false}))
  `)
  process.env.CLAUDE_CONFIG_DIR = directory
  process.env.CLAUDE_CLI_PATH = join(directory, 'fake.ts')
  process.env.CLAUDE_CODE_SUBAGENT_MODEL = 'stale-global'
  process.env.ANTHROPIC_API_KEY = 'secret-inherited-key'
  process.env.ANTHROPIC_BASE_URL = 'http://parent.invalid'
  delete process.env.CC_HAHA_TRACE_PROVIDER_ID
  delete process.env.CC_HAHA_SUBAGENT_PROVIDER_ID
})
afterAll(async () => {
  for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key]
  Object.assign(process.env, saved)
  await rm(directory, { recursive: true, force: true })
})
const options = () => ({ model: 'target', effort: 'high' as const, parentModel: 'parent', cwd: directory, prompt: 'hello', signal: new AbortController().signal, allowedTools: ['Read'] })

test('KSCC CLI keeps its own identity instead of inheriting the host provider snapshot', () => {
  const inherited = { PATH: 'keep', ANTHROPIC_API_KEY: 'host-key', ANTHROPIC_BASE_URL: 'http://host-proxy', CLAUDE_CONFIG_DIR: 'host-config', CC_HAHA_SUBAGENT_PROVIDER_ID: 'host-id', MAX_THINKING_TOKENS: '2048' }
  expect(buildExternalSubagentEnv('kscc', inherited)).toEqual({ PATH: 'keep' })
  expect(inherited.ANTHROPIC_API_KEY).toBe('host-key')
  expect(buildExternalSubagentEnv('codex', inherited).MAX_THINKING_TOKENS).toBeUndefined()
})

test('inherits actual process route, constrains tools and applies explicit model/effort without shared mutation', async () => {
  const before = await readFile(join(directory, 'cc-haha/providers.json'), 'utf8')
  const result = await runRoutedSubagent({ ...options(), maxTurns: 3 })
  expect(result).toContain('[route {"method":"cli","cli":"cc-haha","model":"target","effort":"high","provider":"inherited"}]')
  expect(result).toContain('http://parent.invalid')
  expect(result).toContain('"effort":"high"')
  expect(result).not.toContain('stale-global')
  expect(result).not.toContain('secret-inherited-key')
  expect(result).toContain('"--tools","Read"')
  expect(result).toContain('"--max-turns","3"')
  expect(result).not.toContain('--allowedTools')
  expect(process.env.CLAUDE_CODE_SUBAGENT_MODEL).toBe('stale-global')
  expect(process.env.ANTHROPIC_BASE_URL).toBe('http://parent.invalid')
  expect(await readFile(join(directory, 'cc-haha/providers.json'), 'utf8')).toBe(before)
})

test('fallback after initial connection error uses same model and records actual selected provider', async () => {
  process.env.ANTHROPIC_BASE_URL = 'http://broken.invalid'
  try {
    const result = await runRoutedSubagent(options())
    expect(result).toContain('"provider":"alternative"')
    expect(result).toContain('"model":"target"')
    expect(result).toContain('previous_attempts=inherited:ROUTE_UNAVAILABLE')
    expect(result).not.toContain('secret-fallback-key')
  } finally { process.env.ANTHROPIC_BASE_URL = 'http://parent.invalid' }
})

test('explicit provider is locked and never falls back', async () => {
  const path = join(directory, 'cc-haha/providers.json')
  const before = await readFile(path, 'utf8')
  const config = JSON.parse(before)
  config.providers[0].baseUrl = 'http://broken.invalid'
  await writeFile(path, JSON.stringify(config))
  const calls = (await readFile(join(directory, 'calls'), 'utf8')).trim().split('\n').length
  try {
    await expect(runRoutedSubagent({ ...options(), provider: 'alternative' })).rejects.toThrow('alternative:ROUTE_UNAVAILABLE')
    expect((await readFile(join(directory, 'calls'), 'utf8')).trim().split('\n').length).toBe(calls + 1)
  } finally { await writeFile(path, before) }
})

test('connection failure after tool activity never retries', async () => {
  process.env.ANTHROPIC_BASE_URL = 'http://broken.invalid'
  process.env.FAKE_ACTIVITY = '1'
  const calls = (await readFile(join(directory, 'calls'), 'utf8')).trim().split('\n').length
  try {
    await expect(runRoutedSubagent(options())).rejects.toThrow('未自动重跑')
    expect((await readFile(join(directory, 'calls'), 'utf8')).trim().split('\n').length).toBe(calls + 1)
  } finally {
    process.env.ANTHROPIC_BASE_URL = 'http://parent.invalid'
    delete process.env.FAKE_ACTIVITY
  }
})

test('SDK assistant API-error text is not user-visible activity and may fall back before any tool', async () => {
  process.env.ANTHROPIC_BASE_URL = 'http://broken.invalid'
  process.env.FAKE_API_ERROR = '1'
  try {
    const result = await runRoutedSubagent(options())
    expect(result).toContain('"provider":"alternative"')
  } finally {
    process.env.ANTHROPIC_BASE_URL = 'http://parent.invalid'
    delete process.env.FAKE_API_ERROR
  }
})

test('inherited routing still works with unreadable saved provider index', async () => {
  const path = join(directory, 'cc-haha/providers.json')
  const before = await readFile(path, 'utf8')
  await writeFile(path, 'invalid json')
  try { expect(await runRoutedSubagent(options())).toContain('http://parent.invalid') }
  finally { await writeFile(path, before) }
})

test('explicit effort crosses child environment, native request configuration and actual OpenAI proxy transformation', async () => {
  process.env.FAKE_EFFORT_PROBE = '1'
  process.env.CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS = '1'
  try {
    for (const [model, effort] of [['grok-4.7', 'medium'], ['mimo-2.5-pro', 'high']] as const) {
      const result = await runRoutedSubagent({ ...options(), model, effort })
      expect(result).toContain(`"reasoning_effort":"${effort}"`)
    }
    expect(process.env.CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS).toBe('1')
  } finally {
    delete process.env.FAKE_EFFORT_PROBE
    if (saved.CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS === undefined) delete process.env.CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS
    else process.env.CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS = saved.CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS
  }
}, 30_000)

test('parallel routes have independent effort/provider and preserve desktop default', async () => {
  const [parent, alternate] = await Promise.all([
    runRoutedSubagent({ ...options(), effort: 'low' }),
    runRoutedSubagent({ ...options(), provider: 'alternative', effort: 'high' }),
  ])
  expect(parent).toContain('"effort":"low"')
  expect(parent).toContain('http://parent.invalid')
  expect(alternate).toContain('"effort":"high"')
  expect(alternate).toContain('http://fallback.invalid')
  expect(alternate).toContain('"routeIdentity":"alternative"')
  expect(process.env.ANTHROPIC_BASE_URL).toBe('http://parent.invalid')
})

test('native child receives parent deny/ask rules without new allows and plan mode cannot reach writing or delegation tools', async () => {
  const permissions = { deny: ['Read(./private/**)', 'Bash(curl:*)'], ask: ['Read(./review/**)'], planMode: true }
  const result = await runRoutedSubagent({ ...options(), allowedTools: ['Read', 'Bash', 'Write', 'Edit', 'Agent', 'Skill', 'WebFetch'], permissions })
  const payload = JSON.parse(result.split('\n').slice(1).join('\n'))
  const args = payload.args as string[]
  const settings = JSON.parse(args[args.indexOf('--settings') + 1]!)
  expect(settings).toEqual({ permissions: { deny: permissions.deny, ask: permissions.ask } })
  expect(settings.permissions.allow).toBeUndefined()
  expect(args[args.indexOf('--permission-mode') + 1]).toBe('dontAsk')
  expect(args[args.indexOf('--tools') + 1]).toBe('Read,WebFetch')
  expect(permissions.planMode).toBe(true)
})

test('external CLIs reject dynamic parent permission rules they cannot preserve', async () => {
  for (const cli of ['codex', 'cursor', 'kscc']) {
    await expect(runRoutedSubagent({ ...options(), cli, permissions: { deny: ['Read(./private/**)'], ask: [], planMode: false } })).rejects.toThrow('PERMISSION_UNSUPPORTED')
    await expect(runRoutedSubagent({ ...options(), cli, permissions: { deny: [], ask: ['Read(./review/**)'], planMode: false } })).rejects.toThrow('PERMISSION_UNSUPPORTED')
  }
})

test('native isolation preserves parent thinking disabled, manual budget and adaptive configuration without shared mutation', async () => {
  const before = process.env.MAX_THINKING_TOKENS
  process.env.MAX_THINKING_TOKENS = '9999'
  try {
    for (const [thinkingConfig, budget, alwaysThinkingEnabled] of [
      [{ type: 'disabled' }, '0', false],
      [{ type: 'enabled', budgetTokens: 2048 }, '2048', true],
      [{ type: 'adaptive' }, undefined, true],
    ] as const) {
      const result = await runRoutedSubagent({ ...options(), thinkingConfig, permissions: { deny: ['Write'], ask: [], planMode: false } })
      const payload = JSON.parse(result.split('\n').slice(1).join('\n'))
      expect(payload.thinkingBudget).toBe(budget)
      const args = payload.args as string[]
      const settings = JSON.parse(args[args.indexOf('--settings') + 1]!)
      expect(settings.alwaysThinkingEnabled).toBe(alwaysThinkingEnabled)
      expect(settings.permissions.deny).toEqual(['Write'])
      expect(process.env.MAX_THINKING_TOKENS).toBe('9999')
    }
  } finally {
    if (before === undefined) delete process.env.MAX_THINKING_TOKENS
    else process.env.MAX_THINKING_TOKENS = before
  }
})

test('serialized child rules merge with existing allows and the real permission pipeline still denies deny/ask tools', async () => {
  const { default: mergeWith } = await import('lodash-es/mergeWith.js')
  const { settingsMergeCustomizer } = await import('../../utils/settings/settings.js')
  const { getEmptyToolPermissionContext } = await import('../../Tool.js')
  const { hasPermissionsToUseTool } = await import('../../utils/permissions/permissions.js')
  const result = await runRoutedSubagent({ ...options(), permissions: { deny: ['Read'], ask: ['Grep'], planMode: false } })
  const args = JSON.parse(result.split('\n').slice(1).join('\n')).args as string[]
  const incoming = JSON.parse(args[args.indexOf('--settings') + 1]!)
  const merged = mergeWith({ permissions: { allow: ['Read', 'Grep'], deny: ['Write'] } }, incoming, settingsMergeCustomizer)
  expect(merged.permissions.allow).toEqual(['Read', 'Grep'])
  expect(merged.permissions.deny).toEqual(['Write', 'Read'])
  const toolPermissionContext = {
    ...getEmptyToolPermissionContext(), mode: 'dontAsk' as const,
    alwaysAllowRules: { localSettings: merged.permissions.allow },
    alwaysDenyRules: { flagSettings: merged.permissions.deny },
    alwaysAskRules: { flagSettings: merged.permissions.ask },
  }
  const context = {
    abortController: new AbortController(), getAppState: () => ({ toolPermissionContext }), setAppState: () => {},
  }
  for (const name of ['Read', 'Grep']) {
    const tool = { name, inputSchema: { parse: (value: unknown) => value }, requiresUserInteraction: () => false, checkPermissions: async () => ({ behavior: 'allow' }) }
    const decision = await hasPermissionsToUseTool(tool as never, {}, context as never, {} as never, 'tool_permission_route_test')
    expect(decision.behavior).toBe('deny')
  }
}, 30_000)

test('exit zero without a protocol result is failure and child startup errors are safe', async () => {
  const base = { ...options(), env: { ...process.env }, protocol: 'native' as const }
  await expect(executeRoutedSubagentProcess([process.execPath, '-e', 'console.log("diagnostic only")'], base)).rejects.toThrow('SUBAGENT_FAILED')
  await expect(executeRoutedSubagentProcess([join(directory, 'missing.exe')], base)).rejects.toThrow('CLI_UNAVAILABLE')
})

test('abort and timeout terminate a running child instead of continuing fallback', async () => {
  const controller = new AbortController()
  const command = [process.execPath, '-e', 'setInterval(()=>{},1000)']
  const base = { ...options(), env: { ...process.env }, protocol: 'native' as const }
  const promise = executeRoutedSubagentProcess(command, { ...base, signal: controller.signal })
  setTimeout(() => controller.abort(), 50)
  await expect(promise).rejects.toThrow('INTERRUPTED')
  await expect(executeRoutedSubagentProcess(command, { ...base, timeoutMs: 50 })).rejects.toThrow('TIMEOUT')
  await expect(executeRoutedSubagentProcess([process.execPath, '-e', 'console.log("x".repeat(5000000));setInterval(()=>{},1000)'], base)).rejects.toThrow('OUTPUT_LIMIT')
})

test('external CLI arguments use verified read-only modes and never bypass permission checks', async () => {
  const codex = buildExternalSubagentArgs('codex', 'grok', 'high')
  expect(codex).toContain('read-only')
  expect(codex).toContain('model_reasoning_effort="high"')
  expect(buildExternalSubagentArgs('cursor', 'm', 'medium', 'linux')).toContain('m[effort=medium]')
  expect(buildExternalSubagentArgs('cursor', 'm', 'medium', 'darwin')).toContain('enabled')
  expect(() => buildExternalSubagentArgs('cursor', 'm', 'medium', 'win32')).toThrow('CLI_SANDBOX_UNAVAILABLE')
  expect(buildExternalSubagentArgs('kscc', 'm', 'low')).toContain('Read,Glob,Grep')
  await expect(runRoutedSubagent({ ...options(), cli: 'codex', provider: 'alternative' })).rejects.toThrow('PROVIDER_UNSUPPORTED')
  await expect(runRoutedSubagent({ ...options(), cli: 'codex', maxTurns: 3 })).rejects.toThrow('LIMIT_UNSUPPORTED')
  expect(() => buildExternalSubagentArgs('grok', 'm')).toThrow('CLI_UNSUPPORTED')
  expect(() => buildExternalSubagentArgs('codex', 'm', 8)).toThrow('EFFORT_UNSUPPORTED')
})

test('failures expose safe actionable categories without leaking raw child diagnostics', async () => {
  const cases = [
    ['Workspace Trust Required: Do you trust the contents of this directory?', 'WORKSPACE_UNTRUSTED'],
    ['Sandbox mode is enabled but not available on this system. Sandbox requires macOS or Linux.', 'CLI_SANDBOX_UNAVAILABLE'],
    ['Authentication failed: invalid API key sk-very-secret-token-value', 'AUTH_REQUIRED'],
    ['Model grok-4.7 is not available', 'MODEL_UNAVAILABLE'],
    ["error: unknown option '--effort'", 'CLI_ARGUMENT_ERROR'],
  ]
  for (const [diagnostic, code] of cases) {
    expect(classifySubagentFailure(diagnostic!)).toBe(code)
    const script = `process.stderr.write(${JSON.stringify(diagnostic)});process.exit(1)`
    try {
      await executeRoutedSubagentProcess([process.execPath, '-e', script], { ...options(), env: { ...process.env }, protocol: 'native' })
      throw new Error('expected failure')
    } catch (error) {
      expect((error as { code: string }).code).toBe(code!)
      expect((error as Error).message).not.toContain(diagnostic!)
      expect((error as Error).message).not.toContain('sk-very-secret-token-value')
    }
  }
})

test('Windows app installations are discoverable without PATH and npm wrappers need no command shell', async () => {
  if (process.platform !== 'win32') return
  const local = join(directory, 'local')
  const app = join(directory, 'roaming')
  const codex = join(local, 'OpenAI', 'Codex', 'bin', 'installed', 'codex.exe')
  const cursor = join(local, 'cursor-agent', 'cursor-agent.ps1')
  const kscc = join(app, 'npm', 'node_modules', '@seasun', 'kscc', 'kscc.exe')
  for (const path of [codex, cursor, kscc]) {
    await mkdir(join(path, '..'), { recursive: true })
    await writeFile(path, '')
  }
  const env = { PATH: '', LOCALAPPDATA: local, APPDATA: app }
  expect(resolveExternalSubagentCommand('codex', env)).toEqual([codex])
  expect(resolveExternalSubagentCommand('cursor-agent', env)).toEqual(['powershell.exe', '-NoProfile', '-NonInteractive', '-File', cursor])
  expect(resolveExternalSubagentCommand('kscc', env)).toEqual([kscc])
  // npm also installs a POSIX shell script without an extension. Windows
  // CreateProcess cannot execute that file; it must reach the native binary.
  await writeFile(join(app, 'npm', 'kscc'), '#!/bin/sh\n')
  expect(resolveExternalSubagentCommand('kscc', { ...env, PATH: join(app, 'npm') })).toEqual([kscc])
})
