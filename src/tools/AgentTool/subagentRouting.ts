import { spawn } from 'node:child_process'
import { existsSync, readdirSync, statSync } from 'node:fs'
import { delimiter, join } from 'node:path'
import { createInterface } from 'node:readline'
import { buildNativeHeadlessCommand } from '../../entrypoints/ccHaha.js'
import type { EffortValue } from '../../utils/effort.js'
import type { ThinkingConfig } from '../../utils/thinking.js'
import { redactHeadlessText } from '../../utils/headlessRedaction.js'
import { selectHeadlessProvider } from '../../server/services/headlessProviderAuth.js'
import { createHeadlessProviderRuntime } from '../../server/services/headlessProviderRuntime.js'
import { ProviderService } from '../../server/services/providerService.js'
import type { SavedProvider } from '../../server/types/provider.js'
import { getProviderModelCapability } from '../../utils/model/providerModelCapabilities.js'

export type RoutedSubagentOptions = {
  model: string
  effort?: EffortValue
  provider?: string
  cli?: string
  prompt: string
  cwd: string
  signal: AbortSignal
  parentModel: string
  allowedTools?: string[]
  maxTurns?: number
  permissions?: { deny: string[]; ask: string[]; planMode: boolean }
  thinkingConfig?: ThinkingConfig
}

function routeError(code: string, message: string): Error & { code: string } {
  return Object.assign(new Error(`${code}: ${message}`), { code })
}

function routeHeader(cli: string, options: RoutedSubagentOptions, provider: string): string {
  return `[route ${JSON.stringify({ method: 'cli', cli, model: options.model, effort: options.effort ?? 'inherit', provider })}]`
}

export function classifySubagentFailure(message: string): string {
  if (/workspace trust required|do you trust the contents|workspace.{0,30}not trusted/i.test(message)) return 'WORKSPACE_UNTRUSTED'
  if (/sandbox.{0,80}(?:not available|not supported)|sandbox requires macos or linux/i.test(message)) return 'CLI_SANDBOX_UNAVAILABLE'
  if (/unauthenticated|authentication (?:failed|required)|unauthorized|not logged in|login required|please (?:log|sign) in|invalid api key|missing api key|\b401\b/i.test(message)) return 'AUTH_REQUIRED'
  if (/model.{0,80}(?:not found|not supported|unavailable|not available|invalid)|(?:unknown|unsupported|invalid) model/i.test(message)) return 'MODEL_UNAVAILABLE'
  if (/unknown (?:option|argument)|unrecognized (?:option|argument)|unexpected argument|invalid (?:option|argument)|required (?:option|argument).{0,40}missing/i.test(message)) return 'CLI_ARGUMENT_ERROR'
  if (/ECONNREFUSED|ECONNRESET|ENOTFOUND|ETIMEDOUT|connection (?:error|failed)|fetch failed/i.test(message)) return 'ROUTE_UNAVAILABLE'
  return 'SUBAGENT_FAILED'
}

// One bounded child owns its environment and process tree. Never temporarily
// assign routing credentials to process.env: sibling agents run concurrently.
export async function executeRoutedSubagentProcess(command: string[], options: {
  cwd: string
  env: NodeJS.ProcessEnv
  prompt: string
  signal: AbortSignal
  secrets?: string[]
  protocol: 'native' | 'codex' | 'cursor'
  timeoutMs?: number
}): Promise<string> {
  options.signal.throwIfAborted()
  const child = spawn(command[0]!, command.slice(1), {
    cwd: options.cwd, env: options.env, windowsHide: true,
    detached: process.platform !== 'win32', stdio: ['pipe', 'pipe', 'pipe'],
  })
  let stopCode: string | undefined
  let bytes = 0
  let text = ''
  let resultSeen = false
  let failed = false
  let activitySeen = false
  let failureDetails = ''
  const stop = (code: string) => {
    if (stopCode) return
    stopCode = code
    if (process.platform === 'win32' && child.pid) {
      const killer = spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' })
      killer.once('error', () => child.kill())
      killer.once('close', code => { if (code) child.kill() })
    } else if (child.pid) {
      try { process.kill(-child.pid, 'SIGKILL') } catch { child.kill('SIGKILL') }
    }
  }
  const abort = () => stop('INTERRUPTED')
  options.signal.addEventListener('abort', abort, { once: true })
  const timer = setTimeout(() => stop('TIMEOUT'), options.timeoutMs ?? 600_000)
  const bound = (chunk: Buffer) => {
    bytes += chunk.length
    if (bytes > 4_000_000) stop('OUTPUT_LIMIT')
  }
  child.stdout.on('data', bound)
  child.stderr.on('data', bound)
  child.stderr.on('data', chunk => { failureDetails = `${failureDetails}${chunk.toString()}`.slice(-16_000) })
  const lines = createInterface({ input: child.stdout })
  lines.on('line', line => {
    if (stopCode) return
    try {
      const event = JSON.parse(line)
      if (event.error || event.is_error || event.errors) failureDetails = `${failureDetails}${JSON.stringify(event.error ?? event.errors ?? event.result ?? '')}`.slice(-16_000)
      if (event.type === 'assistant' && !event.error && !event.isApiErrorMessage && !event.message?.isApiErrorMessage && Array.isArray(event.message?.content)) {
        activitySeen ||= event.message.content.some((block: { type?: string; text?: string }) =>
          block.type === 'tool_use' || block.type === 'text' && !!block.text)
      }
      if (event.type === 'result') {
        resultSeen = true
        failed ||= !!event.is_error
        text = typeof event.result === 'string' ? event.result : ''
      }
      if (options.protocol === 'codex') {
        if (event.type === 'item.completed' && event.item?.type === 'agent_message') text += `${event.item.text ?? ''}\n`
        if (event.type === 'turn.completed') resultSeen = true
        if (event.type === 'turn.failed' || event.type === 'error') failed = true
      }
    } catch { /* Ignore diagnostics; success requires a terminal protocol event. */ }
  })
  child.stdin.on('error', () => undefined)
  child.stdin.end(options.prompt)
  try {
    const code = await new Promise<number>((resolve, reject) => {
      child.once('error', () => reject(routeError('CLI_UNAVAILABLE', '无法启动指定命令行')))
      child.once('close', code => resolve(code ?? 1))
    })
    if (stopCode) throw routeError(stopCode, '子代理进程已终止')
    if (code || failed || !resultSeen) {
      const category = classifySubagentFailure(failureDetails)
      const errorCode = activitySeen && ['MODEL_UNAVAILABLE', 'ROUTE_UNAVAILABLE'].includes(category) ? 'SUBAGENT_FAILED' : category
      throw routeError(errorCode, `子代理未成功完成（${category}）；未回显可能包含凭据的原始诊断`)
    }
    return redactHeadlessText(text, options.secrets)
  } finally {
    clearTimeout(timer)
    options.signal.removeEventListener('abort', abort)
    lines.close()
  }
}

export function resolveExternalSubagentCommand(name: string, env: NodeJS.ProcessEnv = process.env): string[] {
  const directories = (env.PATH ?? '').split(delimiter).filter(Boolean)
  if (process.platform === 'win32') {
    if (env.APPDATA) directories.push(join(env.APPDATA, 'npm'))
    if (env.LOCALAPPDATA) directories.push(join(env.LOCALAPPDATA, 'cursor-agent'))
    if (name === 'codex' && env.LOCALAPPDATA) {
      const bin = join(env.LOCALAPPDATA, 'OpenAI', 'Codex', 'bin')
      try {
        const versions = readdirSync(bin, { withFileTypes: true })
          .filter(entry => entry.isDirectory())
          .map(entry => join(bin, entry.name))
          .filter(path => existsSync(join(path, 'codex.exe')))
          .sort((left, right) => statSync(join(right, 'codex.exe')).mtimeMs - statSync(join(left, 'codex.exe')).mtimeMs)
        directories.push(...versions)
      } catch { /* App installation is optional; continue with normal discovery. */ }
    }
  }
  const names = process.platform === 'win32' ? [`${name}.exe`, name] : [name]
  for (const directory of directories) {
    for (const candidate of names) {
      const path = join(directory, candidate)
      if (existsSync(path)) return [path]
    }
    if (process.platform === 'win32') {
      // npm's KSCC wrapper points to this native executable; bypass a shell.
      const kscc = join(directory, 'node_modules', '@seasun', 'kscc', 'kscc.exe')
      if (name === 'kscc' && existsSync(kscc)) return [kscc]
      const script = join(directory, `${name}.ps1`)
      if (name === 'cursor-agent' && existsSync(script)) return ['powershell.exe', '-NoProfile', '-NonInteractive', '-File', script]
    }
  }
  throw routeError('CLI_UNAVAILABLE', '本机没有找到指定命令行')
}

export function buildExternalSubagentArgs(cli: string, model: string, effort?: EffortValue, platform: NodeJS.Platform = process.platform): string[] {
  if (typeof effort === 'number') throw routeError('EFFORT_UNSUPPORTED', '外部命令行不支持数值思考深度')
  if (cli === 'codex') return ['exec', '--model', model, '--sandbox', 'read-only', '--ephemeral', '--json', ...(effort ? ['-c', `model_reasoning_effort=${JSON.stringify(effort)}`] : []), '-']
  if (cli === 'cursor') {
    if (platform === 'win32') throw routeError('CLI_SANDBOX_UNAVAILABLE', '当前 Windows Cursor 不支持操作系统沙箱，尚未实测其 ask 模式写保护；请调配 native 或 codex')
    if (effort && /[\[\]]/.test(model)) throw routeError('EFFORT_UNSUPPORTED', '请使用未带参数的模型名称指定思考深度')
    return ['--print', '--mode', 'ask', '--sandbox', 'enabled', '--output-format', 'stream-json', '--model', effort ? `${model}[effort=${effort}]` : model]
  }
  if (cli === 'kscc') return ['--print', '--model', model, '--permission-mode', 'dontAsk', '--tools', 'Read,Glob,Grep', '--no-session-persistence', '--output-format', 'stream-json', '--verbose', ...(effort ? ['--effort', effort] : [])]
  throw routeError('CLI_UNSUPPORTED', '当前未验证此命令行的非交互协议，请选择 codex、cursor 或 kscc')
}

function supports(provider: SavedProvider, model: string): boolean {
  return (!provider.runtimeKind || provider.runtimeKind === 'anthropic_compatible') &&
    (!!provider.modelCatalog?.some(entry => entry.id === model) || Object.values(provider.models).includes(model))
}

export async function runRoutedSubagent(options: RoutedSubagentOptions): Promise<string> {
  const cli = options.cli?.trim().toLowerCase() ?? 'native'
  if (!options.model.trim()) throw routeError('INVALID_MODEL', '必须提供有效模型')
  if (options.maxTurns !== undefined && (!Number.isSafeInteger(options.maxTurns) || options.maxTurns < 1)) throw routeError('INVALID_LIMIT', '轮数限制必须是正整数')
  if (cli !== 'native' && cli !== 'cc-haha') {
    if (options.permissions?.deny.length || options.permissions?.ask.length) throw routeError('PERMISSION_UNSUPPORTED', '外部命令行无法精确保留父代理的动态权限规则')
    if (options.provider) throw routeError('PROVIDER_UNSUPPORTED', '外部命令行使用其自身配置，不支持映射 cc-haha 服务商；请用 native 指定服务商')
    const args = buildExternalSubagentArgs(cli, options.model, options.effort)
    if (options.maxTurns !== undefined) {
      if (cli !== 'kscc') throw routeError('LIMIT_UNSUPPORTED', '此命令行没有已验证的轮数限制参数')
      args.push('--max-turns', String(options.maxTurns))
    }
    const externalEnv = { ...process.env }
    delete externalEnv.MAX_THINKING_TOKENS
    const result = await executeRoutedSubagentProcess([...resolveExternalSubagentCommand(cli === 'cursor' ? 'cursor-agent' : cli), ...args, ...(cli === 'cursor' ? [options.prompt] : [])], {
      ...options, prompt: cli === 'cursor' ? '' : options.prompt, env: externalEnv, protocol: cli === 'codex' ? 'codex' : cli === 'cursor' ? 'cursor' : 'native',
    })
    return `${routeHeader(cli, options, `${cli}-config`)}\n[tools=read-only; native_thinking_mode=not-mapped; external_depth=effort-only]\n${result}`
  }

  const locked = options.provider ? await selectHeadlessProvider(options.provider) : undefined
  // Trace identity is optional. The inherited process environment is the true
  // parent route even when desktop's mutable active provider has since changed.
  const parentId = process.env.CC_HAHA_SUBAGENT_PROVIDER_ID ?? process.env.CC_HAHA_TRACE_PROVIDER_ID
  const candidates: Array<SavedProvider | undefined> = [locked]
  const attempts: string[] = []
  for (const provider of candidates) {
    options.signal.throwIfAborted()
    let runtime: Awaited<ReturnType<typeof createHeadlessProviderRuntime>> | undefined
    const id = provider?.id ?? parentId ?? 'inherited'
    try {
      if (provider) runtime = await createHeadlessProviderRuntime(provider, options.model, options.cwd)
      const env = runtime?.env ?? { ...process.env }
      if (provider) env.CC_HAHA_SUBAGENT_PROVIDER_ID = provider.id
      delete env.CLAUDE_CODE_SUBAGENT_MODEL
      // A noninteractive plan child must not wait for a permission prompt or
      // gain write access through Shell/Agent/Skill. Keep dontAsk and intersect
      // the parent's pool with the verified read-only built-in tools.
      const readOnlyTools = new Set(['Read', 'Glob', 'Grep', 'LS', 'WebFetch', 'WebSearch'])
      const toolNames = (options.allowedTools ?? []).filter(name => !options.permissions?.planMode || readOnlyTools.has(name))
      const args = ['--print', '--model', options.model, '--output-format', 'stream-json', '--verbose', '--no-session-persistence', '--permission-mode', 'dontAsk', '--tools', toolNames.join(',')]
      const settings: { permissions?: { deny: string[]; ask: string[] }; alwaysThinkingEnabled?: boolean } = {}
      if (options.permissions) settings.permissions = { deny: options.permissions.deny, ask: options.permissions.ask }
      if (options.thinkingConfig) {
        settings.alwaysThinkingEnabled = options.thinkingConfig.type !== 'disabled'
        if (options.thinkingConfig.type === 'adaptive') delete env.MAX_THINKING_TOKENS
        else env.MAX_THINKING_TOKENS = options.thinkingConfig.type === 'disabled' ? '0' : String(options.thinkingConfig.budgetTokens)
      }
      if (Object.keys(settings).length) args.push('--settings', JSON.stringify(settings))
      if (options.maxTurns !== undefined) args.push('--max-turns', String(options.maxTurns))
      if (options.effort !== undefined) {
        // Empty provider catalogs mean unknown capability, not an upstream
        // rejection. Explicit low/medium/high must reach the proxy/API; an
        // upstream rejection is then returned to the parent for a decision.
        if ((options.effort === 'xhigh' || options.effort === 'max') &&
          !/^gpt-|^o[1-9](?:-|$)/i.test(options.model) &&
          getProviderModelCapability(options.model, `${options.effort}_effort`, env.CC_HAHA_PROVIDER_MODEL_CAPABILITIES) !== true) {
          throw routeError('EFFORT_UNSUPPORTED', '该模型尚未确认支持此思考深度，请指定 low、medium 或 high')
        }
        env.CLAUDE_CODE_EFFORT_LEVEL = String(options.effort)
        env.CLAUDE_CODE_ALWAYS_ENABLE_EFFORT = '1'
        // Suppressing experimental output_config would silently drop an
        // explicitly requested effort on third-party/scoped proxy routes.
        env.CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS = '0'
      }
      const result = await executeRoutedSubagentProcess(buildNativeHeadlessCommand(args, env), {
        ...options, env, secrets: runtime?.secrets ?? [env.ANTHROPIC_API_KEY ?? '', env.ANTHROPIC_AUTH_TOKEN ?? ''], protocol: 'native',
      })
      return `${routeHeader('cc-haha', options, id)}\n${attempts.length ? `[previous_attempts=${attempts.join(',')}]\n` : ''}${result}`
    } catch (error) {
      const code = (error as { code?: string }).code ?? 'SUBAGENT_FAILED'
      if (options.signal.aborted || ['INTERRUPTED', 'TIMEOUT', 'OUTPUT_LIMIT'].includes(code)) throw routeError(code, '子代理已停止，未继续调配')
      attempts.push(`${id}:${code}`)
      if (!['ROUTE_UNAVAILABLE', 'MODEL_UNAVAILABLE'].includes(code)) throw routeError(code, `${routeHeader('cc-haha', options, id)} attempts=${attempts.join(',')}；未自动重跑以避免重复操作`)
      if (!locked && candidates.length === 1) {
        try {
          const index = await new ProviderService().listProviders({ readOnly: true })
          candidates.push(...index.providers.filter(provider => provider.id !== parentId && supports(provider, options.model)).slice(0, 2))
        } catch { /* The inherited route is independent of saved provider discovery. */ }
      }
    } finally { runtime?.dispose() }
  }
  throw routeError('SUBAGENT_ROUTING_FAILED', `所有允许的路由均未完成；${attempts.join(',')}。可由主代理根据错误重新调配，指定服务商时不会自动换服务商`)
}
