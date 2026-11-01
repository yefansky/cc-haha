import { randomUUID } from 'node:crypto'
import { stat } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import { buildClaudeCliArgs, resolveClaudeCliLauncher } from '../utils/desktopBundledCli.js'

type ProviderName = 'kscc' | 'tokenhub'
export type HeadlessArguments = {
  command: 'run' | 'models' | 'usage' | 'login' | 'help'
  provider: ProviderName
  model: string
  cwd: string
  json: boolean
  timeoutMs: number
  nativeArgs: string[]
  noNetwork?: boolean
}
class CliError extends Error {
  constructor(readonly code: string, message: string) { super(message) }
}

export function parseHeadlessArguments(args: string[], callerDir = process.cwd()): HeadlessArguments {
  const command = ['models', 'usage', 'login'].includes(args[0] ?? '') ? args[0] as HeadlessArguments['command'] : 'run'
  const result: HeadlessArguments = { command, provider: 'kscc', model: '', cwd: callerDir, json: args.includes('--json') || args.some((v, i) => v === '--output-format=json' || v === '--output-format' && args[i + 1] === 'json'), timeoutMs: 600_000, nativeArgs: [] }
  let providerSeen = false
  for (let i = command === 'run' ? 0 : 1; i < args.length; i++) {
    const arg = args[i]!
    if (arg === '--help' || arg === '-h') { result.command = 'help'; continue }
    const equalsAt = arg.indexOf('=')
    const flag = equalsAt < 0 ? arg : arg.slice(0, equalsAt)
    const inline = equalsAt < 0 ? undefined : arg.slice(equalsAt + 1)
    if (['--provider', '--model', '--cwd', '--output-format', '--timeout-ms'].includes(flag!)) {
      const value = inline ?? args[++i]
      if (!value || value.startsWith('--')) throw new CliError('INVALID_ARGUMENT', `${flag} 缺少参数`)
      if (flag === '--provider') {
        if (value !== 'kscc' && value !== 'tokenhub') throw new CliError('INVALID_PROVIDER', '服务商只能是 kscc 或 tokenhub')
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
    else if (arg === '--no-network' && command === 'usage') result.noNetwork = true
    else result.nativeArgs.push(arg)
  }
  if (result.command === 'help') return result
  if (!providerSeen) throw new CliError('INVALID_PROVIDER', '请指定 --provider kscc 或 tokenhub')
  if (command === 'run') {
    if (!result.nativeArgs.some(a => a === '-p' || a === '--print')) throw new CliError('INVALID_ARGUMENT', '无界面调用需要 -p 参数')
    if (!result.model.trim()) throw new CliError('INVALID_ARGUMENT', '请指定 --model')
    if (result.nativeArgs.some(a => ['--input-format', '--sdk-url', '--permission-prompt-tool', '--verbose', '--debug', '-d', '--debug-file', '--debug-to-stderr'].some(f => a === f || a.startsWith(`${f}=`)))) throw new CliError('INVALID_ARGUMENT', '该选项不适用于单次无界面调用')
  } else if (result.nativeArgs.length) throw new CliError('INVALID_ARGUMENT', '子命令包含不支持的参数')
  return result
}

export function redactHeadlessText(value: string, secrets: string[] = []): string {
  let text = value
  for (const secret of secrets) if (secret.length >= 4) text = text.replaceAll(secret, '[已打码]').replaceAll(encodeURIComponent(secret), '[已打码]')
  return text.replace(/\bBearer\s+[A-Za-z0-9._~+\/-]+=*/gi, 'Bearer [已打码]')
    .replace(/\b(?:sk|sess)-[A-Za-z0-9_-]{12,}/g, '[已打码]')
}

export function redactHeadlessValue(value: unknown, secrets: string[]): any {
  if (typeof value === 'string') return redactHeadlessText(value, secrets)
  if (Array.isArray(value)) return value.map(item => redactHeadlessValue(item, secrets))
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [redactHeadlessText(key, secrets), redactHeadlessValue(item, secrets)]))
  return value
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
    return { result: { ...safe, schema_version: 1, provider: options.provider, model: resultModel, requested_model: options.model, run_id: runId, exit_code: code, is_error: !!safe.is_error || code !== 0, tool_usage: toolUsage, ...(stopCode ? { error_code: stopCode } : {}), duration_ms: safe.duration_ms ?? Date.now() - started, wall_duration_ms: Date.now() - started } as Record<string, any>, assistantUsage, exitCode: code }
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
    if (options.command === 'help') { write('cc-haha -p "提示词" --provider kscc|tokenhub --model <模型> [--output-format text|json] [--cwd <目录>] [--timeout-ms 600000]\ncc-haha models|usage|login --provider kscc|tokenhub [--json]\n工具权限沿用 --allowed-tools / --permission-mode；默认拒绝需要交互审批的操作。\n'); return 0 }
    if (!(await stat(options.cwd).catch(() => null))?.isDirectory()) throw new CliError('WORKDIR_INVALID', '工作目录不存在或不是目录')
    const auth = await import('../server/services/headlessProviderAuth.js')
    if (options.command !== 'run') {
      const data = await withinDeadline(options.command === 'models' ? auth.listHeadlessModels(options.provider, { signal: controller.signal })
        : options.command === 'login' ? auth.loginHeadlessProvider(options.provider, { onAuthorizeUrl: url => { if (!controller.signal.aborted) process.stderr.write(`请在本人已打开的浏览器中完成授权：${url}\n`) }, timeoutMs: options.timeoutMs, signal: controller.signal })
        : (await import('../server/services/headlessProviderUsage.js')).getHeadlessProviderUsage(options.provider, { noNetwork: options.noNetwork, signal: controller.signal }), deadline, controller)
      write(options.json ? `${JSON.stringify(data)}\n` : `${JSON.stringify(data, null, 2)}\n`)
      return 0
    }
    const provider = await withinDeadline(auth.selectHeadlessProvider(options.provider), deadline)
    const { createHeadlessProviderRuntime } = await import('../server/services/headlessProviderRuntime.js')
    runtime = await createHeadlessProviderRuntime(provider, options.model, options.cwd)
    options.timeoutMs = Math.max(1, deadline - Date.now())
    const output = await executeNativeHeadless(options, runtime.env, runtime.secrets, runId)
    try {
      const { recordHeadlessUsage } = await import('../server/services/headlessProviderUsage.js')
      for (const [id, value] of output.assistantUsage) await recordHeadlessUsage({ provider: options.provider, model: value.model, runId, messageId: id, usage: value.usage })
      if (!output.assistantUsage.size && Object.keys(output.result.usage ?? {}).length) await recordHeadlessUsage({ provider: options.provider, model: options.model, runId, requestId: runId, messageId: runId, usage: output.result.usage })
    } catch { output.result.warnings = ['本机用量记录失败，本次结果仍有效'] }
    write(options.json ? `${JSON.stringify(output.result)}\n` : `${output.result.result || output.result.errors?.join('\n') || output.result.error_code || ''}\n`)
    return output.exitCode
  } catch (error) {
    const safeCodes = new Set(['LOGIN_REQUIRED', 'PERMISSION_DENIED', 'PROVIDER_UNAVAILABLE', 'LOGIN_TIMEOUT', 'LOGIN_CANCELLED', 'INVALID_PROVIDER', 'TIMEOUT', 'INTERRUPTED'])
    const errorCode = error && typeof error === 'object' && 'code' in error ? String(error.code) : ''
    const code = error instanceof CliError || safeCodes.has(errorCode) ? errorCode : 'CLI_ERROR'
    const message = error instanceof CliError ? error.message : code === 'LOGIN_REQUIRED' ? '本机身份不可用，请运行 login 或在 cc-haha 完成本人授权' : '操作未完成，请检查登录状态、模型、网络与本机配置'
    const exitCode = code === 'TIMEOUT' ? 124 : 1
    const result = { type: 'result', subtype: 'error_during_execution', schema_version: 1, provider: options?.provider ?? null, model: options?.model ?? null, run_id: runId, result: '', is_error: true, usage: {}, modelUsage: {}, duration_ms: Date.now() - started, exit_code: exitCode, error_code: code, errors: [message] }
    write(wantsJson ? `${JSON.stringify(result)}\n` : `${message}（${code}）\n`)
    return exitCode
  } finally {
    runtime?.dispose()
    process.off('SIGINT', onInterrupt); process.off('SIGTERM', onInterrupt)
    console.log = originalLog; console.warn = originalWarn; console.error = originalError
  }
}

if (import.meta.main) process.exit(await runCcHaha())
