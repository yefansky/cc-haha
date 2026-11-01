import { randomUUID } from 'node:crypto'
import { stat } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import { buildClaudeCliArgs, resolveClaudeCliLauncher } from '../utils/desktopBundledCli.js'
import { HEADLESS_SCHEMA_VERSION, HEADLESS_ERRORS, HEADLESS_COMMANDS, getHeadlessCapabilities, renderHeadlessHelp, type HeadlessCommandName } from './headlessCommandCatalog.js'
import { redactHeadlessValue } from '../utils/headlessRedaction.js'
export { redactHeadlessText, redactHeadlessValue } from '../utils/headlessRedaction.js'

type ProviderName = string
export type HeadlessArguments = {
  command: HeadlessCommandName
  provider: ProviderName
  model: string
  cwd: string
  json: boolean
  timeoutMs: number
  nativeArgs: string[]
  noNetwork?: boolean
  all?: boolean
  helpCommand?: string
  manual?: boolean
}
class CliError extends Error {
  constructor(readonly code: string, message: string) { super(message) }
}

function safeHeadlessError(error: unknown) {
  const rawCode = error && typeof error === 'object' && 'code' in error ? String(error.code) : ''
  const code = error instanceof CliError || HEADLESS_ERRORS.some(item => item.code === rawCode) ? rawCode : 'CLI_ERROR'
  const definition = HEADLESS_ERRORS.find(item => item.code === code)
  return { code, message: error instanceof CliError ? error.message : definition ? `${definition.meaning}；${definition.action}` : '操作未完成，请检查本机配置' }
}

export async function aggregateHeadlessProviders(command: string, ids: string[], query: (id: string) => Promise<unknown>) {
  const results = await Promise.all(ids.map(async provider_id => {
    try { return { provider_id, status: 'ok' as const, data: await query(provider_id), error: null } }
    catch (error) { return { provider_id, status: 'error' as const, data: null, error: safeHeadlessError(error) } }
  }))
  const failed = results.filter(item => item.status === 'error').length
  return { schema_version: HEADLESS_SCHEMA_VERSION, command, status: !failed ? 'ok' : failed === results.length ? 'error' : 'partial', results }
}

export function parseHeadlessArguments(args: string[], callerDir = process.cwd()): HeadlessArguments {
  const explicitCommand = HEADLESS_COMMANDS.some(command => command.name === args[0])
  const command: HeadlessCommandName = !args.length ? 'help' : explicitCommand ? args[0] as HeadlessCommandName : 'run'
  const result: HeadlessArguments = { command, provider: '', model: '', cwd: callerDir, json: args.includes('--json') || args.some((v, i) => v === '--output-format=json' || v === '--output-format' && args[i + 1] === 'json'), timeoutMs: 600_000, nativeArgs: [] }
  let providerSeen = false
  if (command === 'help' || args.includes('--help') || args.includes('-h')) {
    result.command = 'help'
    result.helpCommand = command === 'help' ? args[1] && !args[1].startsWith('-') ? args[1] : undefined : command === 'run' && !explicitCommand ? undefined : command
    result.manual = args.includes('--manual')
    if (result.helpCommand && !HEADLESS_COMMANDS.some(c => c.name === result.helpCommand)) throw new CliError('INVALID_ARGUMENT', '未知帮助命令，请运行 cc-haha help')
    return result
  }
  for (let i = explicitCommand ? 1 : 0; i < args.length; i++) {
    const arg = args[i]!
    if (arg === '--help' || arg === '-h') { result.command = 'help'; continue }
    const equalsAt = arg.indexOf('=')
    const flag = equalsAt < 0 ? arg : arg.slice(0, equalsAt)
    const inline = equalsAt < 0 ? undefined : arg.slice(equalsAt + 1)
    if (['--provider', '--model', '--cwd', '--output-format', '--timeout-ms'].includes(flag!)) {
      if (command !== 'run' && ['--model', '--cwd'].includes(flag) || ['providers', 'capabilities'].includes(command) && flag === '--timeout-ms') throw new CliError('INVALID_ARGUMENT', '此参数不适用于该查询命令，请运行对应 help')
      const value = inline ?? args[++i]
      if (!value || value.startsWith('--')) throw new CliError('INVALID_ARGUMENT', `${flag} 缺少参数`)
      if (flag === '--provider') {
        if (!value.trim()) throw new CliError('INVALID_PROVIDER', '请使用已保存服务商 ID 或 kscc/tokenhub 别名')
        result.provider = value; providerSeen = true
      } else if (flag === '--model') result.model = value
      else if (flag === '--cwd') result.cwd = resolve(callerDir, value)
      else if (flag === '--output-format') {
        if (!['text', 'json'].includes(value)) throw new CliError('INVALID_ARGUMENT', '输出格式只能是 text 或 json')
        result.json = value === 'json'
      } else {
        result.timeoutMs = Number(value)
        if (!Number.isSafeInteger(result.timeoutMs) || result.timeoutMs < 1 || result.timeoutMs > 86_400_000) throw new CliError('INVALID_ARGUMENT', '超时必须为 1 至 86400000 毫秒')
      }
    } else if (arg === '--json') result.json = true
    else if (arg === '--all') result.all = true
    else if (arg === '--no-network' && ['models', 'pricing', 'usage'].includes(command)) result.noNetwork = true
    else result.nativeArgs.push(arg)
  }
  if (result.command === 'help') return result
  if (result.all && !['models', 'pricing', 'usage'].includes(command)) throw new CliError('INVALID_ARGUMENT', '--all 仅适用于 models/pricing/usage')
  if (result.all && providerSeen) throw new CliError('INVALID_ARGUMENT', '--all 与单个 --provider 不能同时使用')
  if (['run', 'models', 'pricing', 'usage', 'login'].includes(command) && !providerSeen && !result.all) throw new CliError('INVALID_PROVIDER', '请指定 --provider <ID|kscc|tokenhub>；查询全部可用 --all')
  if (['providers', 'capabilities'].includes(command) && providerSeen) throw new CliError('INVALID_ARGUMENT', '此发现命令不需要 --provider')
  if (command === 'run') {
    if (!result.nativeArgs.some(a => a === '-p' || a === '--print')) throw new CliError('INVALID_ARGUMENT', '无界面调用需要 -p 参数')
    if (!result.model.trim()) throw new CliError('INVALID_ARGUMENT', '请指定 --model')
    if (result.nativeArgs.some(a => ['--input-format', '--sdk-url', '--permission-prompt-tool', '--verbose', '--debug', '-d', '--debug-file', '--debug-to-stderr'].some(f => a === f || a.startsWith(`${f}=`)))) throw new CliError('INVALID_ARGUMENT', '该选项不适用于单次无界面调用')
  } else if (result.nativeArgs.length) throw new CliError('INVALID_ARGUMENT', '子命令包含不支持的参数')
  return result
}

export function buildNativeHeadlessCommand(args: string[], env: NodeJS.ProcessEnv = process.env): string[] {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
  // Tests and existing desktop launchers use the same explicit launcher seam.
  if (env.CLAUDE_CLI_PATH) {
    const launcher = resolveClaudeCliLauncher({ cliPath: env.CLAUDE_CLI_PATH, execPath: process.execPath })!
    return buildClaudeCliArgs(launcher, args, env.CLAUDE_APP_ROOT)
  }
  const executable = process.execPath.toLowerCase()
  if (executable.includes('claude-sidecar') || /(?:^|[\\/])cc-haha(?:\.exe)?$/.test(executable)) return [process.execPath, 'cli', '--app-root', env.CLAUDE_APP_ROOT ?? dirname(process.execPath), ...args]
  return [process.execPath, '--no-env-file', '--feature=TRANSCRIPT_CLASSIFIER', '--preload', resolve(root, 'preload.ts'), resolve(root, 'src/entrypoints/cli.tsx'), ...args]
}

async function withinDeadline<T>(operation: Promise<T>, deadline: number, controller?: AbortController): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([operation, new Promise<never>((_, reject) => {
      timer = setTimeout(() => { reject(new CliError('TIMEOUT', '操作超过总时限')); controller?.abort() }, Math.max(1, deadline - Date.now()))
    })])
  } finally { clearTimeout(timer) }
}

export async function executeNativeHeadless(options: HeadlessArguments, env: NodeJS.ProcessEnv, secrets: string[], runId: string) {
  const started = Date.now()
  const args = [...options.nativeArgs, '--model', options.model, '--output-format', 'stream-json', '--verbose', '--no-session-persistence']
  // dontAsk retains configured allow/deny rules and rejects an unresolved prompt.
  if (!args.some(a => a === '--permission-mode' || a.startsWith('--permission-mode='))) args.push('--permission-mode', 'dontAsk')
  const command = buildNativeHeadlessCommand(args, env)
  const child = spawn(command[0]!, command.slice(1), { cwd: options.cwd, env, windowsHide: true, detached: process.platform !== 'win32', stdio: ['pipe', 'pipe', 'pipe'] })
  let stopCode: string | undefined
  let lastResult: Record<string, unknown> | undefined
  let stderrSeen = false
  const assistantUsage = new Map<string, { model: string; usage: Record<string, number> }>()
  const toolCalls = new Map<string, string>()
  const stop = (code: string) => {
    if (stopCode) return
    stopCode = code
    if (process.platform === 'win32' && child.pid) {
      const killer = spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' })
      killer.on('error', () => child.kill())
      killer.on('close', code => { if (code) child.kill() })
    } else if (child.pid) {
      try { process.kill(-child.pid, 'SIGKILL') } catch { child.kill('SIGKILL') }
    }
  }
  const onInterrupt = () => stop('INTERRUPTED')
  const onTerminate = () => stop('INTERRUPTED')
  process.once('SIGINT', onInterrupt)
  process.once('SIGTERM', onTerminate)
  const timer = setTimeout(() => stop('TIMEOUT'), options.timeoutMs)
  const lines = createInterface({ input: child.stdout! })
  lines.on('line', line => {
    if (line.length > 16_000_000) { stop('OUTPUT_LIMIT'); return }
    try {
      const message = JSON.parse(line)
      if (message.type === 'result') lastResult = message
      if (message.type === 'assistant' && message.message?.id && message.message?.usage) {
        assistantUsage.set(message.message.id, { model: message.message.model ?? options.model, usage: message.message.usage })
      }
      if (message.type === 'assistant' && Array.isArray(message.message?.content)) {
        for (const block of message.message.content) {
          if (block.type === 'tool_use' && typeof block.id === 'string' && typeof block.name === 'string' && /^[A-Za-z][A-Za-z0-9_]{0,100}$/.test(block.name)) toolCalls.set(block.id, block.name)
        }
      }
    } catch { /* Non-protocol diagnostics never contaminate stdout. */ }
  })
  child.stderr!.on('data', () => { stderrSeen = true })
  child.stdin!.on('error', () => undefined)
  // Native print mode accepts a prompt argument or piped UTF-8 text.
  if (process.stdin.isTTY) child.stdin!.end()
  else process.stdin.pipe(child.stdin!)
  try {
    const exitCode = await new Promise<number>((accept, reject) => {
      child.once('error', () => reject(new CliError('CLI_START_FAILED', '无法启动编程代理进程')))
      child.once('close', code => accept(code ?? 1))
    })
    const code = stopCode ? stopCode === 'TIMEOUT' ? 124 : 130 : exitCode || (lastResult?.is_error ? 1 : 0)
    const result = lastResult ?? { type: 'result', subtype: 'error_during_execution', result: '', is_error: true, usage: {}, modelUsage: {}, errors: [stderrSeen ? '编程代理未返回有效结果，请检查登录、模型和工具权限' : '编程代理未返回有效结果'] }
    const safe = redactHeadlessValue(result, secrets)
    const resultModel = Object.keys(safe.modelUsage ?? {})[0] ?? options.model
    const toolUsage: Record<string, number> = {}
    for (const name of toolCalls.values()) toolUsage[name] = (toolUsage[name] ?? 0) + 1
    return { result: { ...safe, schema_version: HEADLESS_SCHEMA_VERSION, provider: options.provider, model: resultModel, requested_model: options.model, run_id: runId, exit_code: code, is_error: !!safe.is_error || code !== 0, tool_usage: toolUsage, ...(stopCode ? { error_code: stopCode } : {}), duration_ms: safe.duration_ms ?? Date.now() - started, wall_duration_ms: Date.now() - started } as Record<string, any>, assistantUsage, exitCode: code }
  } finally {
    clearTimeout(timer)
    process.off('SIGINT', onInterrupt); process.off('SIGTERM', onTerminate)
    process.stdin.unpipe(child.stdin!)
    lines.close()
  }
}

export async function runCcHaha(rawArgs = process.argv.slice(2)): Promise<number> {
  const write = process.stdout.write.bind(process.stdout)
  const runId = randomUUID()
  const started = Date.now()
  const controller = new AbortController()
  const onInterrupt = () => controller.abort()
  process.once('SIGINT', onInterrupt); process.once('SIGTERM', onInterrupt)
  const wantsJson = rawArgs.includes('--json') || rawArgs.some((v, i) => v === '--output-format=json' || v === '--output-format' && rawArgs[i + 1] === 'json')
  let options: HeadlessArguments | undefined
  let runtime: Awaited<ReturnType<typeof import('../server/services/headlessProviderRuntime.js')['createHeadlessProviderRuntime']>> | undefined
  // Provider/library console output is deliberately suppressed; only this entry owns stdout.
  const originalLog = console.log, originalWarn = console.warn, originalError = console.error
  console.log = console.warn = console.error = () => undefined
  try {
    options = parseHeadlessArguments(rawArgs, process.env.CALLER_DIR || process.cwd())
    const deadline = started + options.timeoutMs
    if (options.command === 'help') { write(renderHeadlessHelp(options.helpCommand, options.manual)); return 0 }
    if (options.command === 'capabilities') { write(`${JSON.stringify(getHeadlessCapabilities(), null, options.json ? undefined : 2)}\n`); return 0 }
    if (!(await stat(options.cwd).catch(() => null))?.isDirectory()) throw new CliError('WORKDIR_INVALID', '工作目录不存在或不是目录')
    const auth = await import('../server/services/headlessProviderAuth.js')
    if (options.command === 'providers') {
      const data = await withinDeadline(auth.listHeadlessProviders(), deadline, controller)
      write(`${JSON.stringify(data, null, options.json ? undefined : 2)}\n`)
      return 0
    }
    if (options.command !== 'run') {
      const query = async (id: string) => withinDeadline(options!.command === 'models' ? auth.listHeadlessModels(id, { signal: controller.signal, noNetwork: options!.noNetwork })
        : options!.command === 'login' ? auth.loginHeadlessProvider(id, { onAuthorizeUrl: url => { if (!controller.signal.aborted) process.stderr.write(`请在本人已打开的浏览器中完成授权：${url}\n`) }, timeoutMs: options!.timeoutMs, signal: controller.signal })
        : options!.command === 'pricing' ? (await import('../server/services/headlessProviderPricing.js')).getHeadlessProviderPricing(id, { signal: controller.signal })
        : (await import('../server/services/headlessProviderUsage.js')).getHeadlessProviderUsage(id, { noNetwork: options!.noNetwork, signal: controller.signal }), deadline, controller)
      const data = options.all ? await aggregateHeadlessProviders(options.command, (await auth.listHeadlessProviders()).providers.map(item => item.id), query) : await query(options.provider)
      const safeData = await auth.redactHeadlessProviderMetadata(data)
      write(options.json ? `${JSON.stringify(safeData)}\n` : `${JSON.stringify(safeData, null, 2)}\n`)
      return options.all && 'status' in data && data.status !== 'ok' ? 1 : 0
    }
    const provider = await withinDeadline(auth.selectHeadlessProvider(options.provider), deadline)
    const { createHeadlessProviderRuntime } = await import('../server/services/headlessProviderRuntime.js')
    runtime = await createHeadlessProviderRuntime(provider, options.model, options.cwd)
    options.timeoutMs = Math.max(1, deadline - Date.now())
    const output = await executeNativeHeadless(options, runtime.env, runtime.secrets, runId)
    output.result.provider_id = provider.id
    const { projectHeadlessRunCost } = await import('../server/services/headlessProviderPricing.js')
    Object.assign(output.result, projectHeadlessRunCost(output.result, runtime.secrets))
    try {
      const { recordHeadlessUsage } = await import('../server/services/headlessProviderUsage.js')
      for (const [id, value] of output.assistantUsage) {
        await recordHeadlessUsage({ provider: options.provider, providerId: provider.id, model: value.model, runId, messageId: id, usage: value.usage }, { secretValues: runtime.secrets })
      }
      if (!output.assistantUsage.size && Object.keys(output.result.usage ?? {}).length) await recordHeadlessUsage({ provider: options.provider, providerId: provider.id, model: options.model, runId, requestId: runId, messageId: runId, usage: output.result.usage }, { secretValues: runtime.secrets })
    } catch { output.result.warnings = ['本机用量记录失败，本次结果仍有效'] }
    const safeResult = redactHeadlessValue(output.result, runtime.secrets)
    write(options.json ? `${JSON.stringify(safeResult)}\n` : `${safeResult.result || safeResult.errors?.join('\n') || safeResult.error_code || ''}\n`)
    return output.exitCode
  } catch (error) {
    const { code, message } = safeHeadlessError(error)
    const exitCode = code === 'TIMEOUT' ? 124 : 1
    const result = { type: 'result', subtype: 'error_during_execution', schema_version: HEADLESS_SCHEMA_VERSION, provider: options?.provider ?? null, provider_id: null, model: options?.model ?? null, run_id: runId, result: '', is_error: true, usage: {}, modelUsage: {}, total_cost_usd: null, cost: { status: 'unknown', billed_cost: null, currency: null, client_estimate: { status: 'unavailable', billed: false, currency: 'USD', total_cost_usd: null, model_usage: [] } }, duration_ms: Date.now() - started, exit_code: exitCode, error_code: code, errors: [message] }
    let safeResult = result
    if (options?.provider) {
      try { safeResult = await (await import('../server/services/headlessProviderAuth.js')).redactHeadlessProviderMetadata(result) } catch { safeResult = { ...result, provider: null } }
    }
    write(wantsJson ? `${JSON.stringify(safeResult)}\n` : `${message}（${code}）\n`)
    return exitCode
  } finally {
    runtime?.dispose()
    process.off('SIGINT', onInterrupt); process.off('SIGTERM', onInterrupt)
    console.log = originalLog; console.warn = originalWarn; console.error = originalError
  }
}

if (import.meta.main) process.exit(await runCcHaha())
