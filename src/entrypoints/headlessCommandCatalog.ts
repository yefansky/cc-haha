/** One offline source for human help, installed manuals and agent discovery. */
export const HEADLESS_SCHEMA_VERSION = 2
export type HeadlessCommandName = 'run' | 'help' | 'capabilities' | 'providers' | 'models' | 'pricing' | 'usage' | 'login'
type Parameter = { name: string; type: string; required: boolean; description: string }
const provider: Parameter = { name: '--provider', type: 'string', required: true, description: '本机已保存 Provider 的精确 ID，或 kscc/tokenhub 兼容别名；多个配置同属一别名时请改用 ID。' }
const json: Parameter = { name: '--json', type: 'boolean', required: false, description: '输出单个 JSON 对象；也可用 --output-format json。' }
const all: Parameter = { name: '--all', type: 'boolean', required: false, description: '查询所有本机保存的 Provider；逐项错误不丢失其他结果。不能用于 run/login。ID 本身可以叫 all。' }
const noNetwork: Parameter = { name: '--no-network', type: 'boolean', required: false, description: '只读本机目录、定价状态或用量，不查询/刷新远端授权。' }
const timeout: Parameter = { name: '--timeout-ms', type: 'integer', required: false, description: '总时限毫秒，默认 600000，范围 1..86400000；超时返回非零状态。' }
const objectSchema = (properties: Record<string, unknown>, required: string[] = Object.keys(properties)) => ({ type: 'object', properties, required, additionalProperties: true })
const string = { type: 'string' }
const nullableNumber = { type: ['number', 'null'] }
const modelSchema = objectSchema({
  id: string, listed: { const: true }, catalog_access: { enum: ['available', 'unknown'] }, quota_limited: { type: ['boolean', 'null'] },
  protocol: { enum: ['anthropic', 'openai_chat', 'openai_responses', null] }, protocol_source: { enum: ['configured', 'catalog', 'unknown'] },
  capabilities: { type: 'array', items: string }, capabilities_source: { enum: ['configured', 'catalog', 'unknown'] },
  context_window_tokens: nullableNumber, context_source: { enum: ['configured', 'unknown'] }, freshness: { enum: ['live', 'configured'] },
  call_access: { const: 'unknown' }, permission: objectSchema({ status: { const: 'unknown' }, source: { const: 'not_probed' }, checked_at: { type: 'null' } }), source: string, checked_at: string,
})
const errorSchema = objectSchema({ schema_version: { const: 2 }, is_error: { const: true }, exit_code: { type: 'integer', minimum: 1 }, provider: { type: ['string', 'null'] }, provider_id: { type: ['string', 'null'] }, model: { type: ['string', 'null'] }, error_code: string, errors: { type: 'array', items: string } }, ['schema_version', 'is_error', 'exit_code'])
const aggregateSchema = objectSchema({ schema_version: { const: 2 }, command: string, status: { enum: ['ok', 'partial', 'error'], description: 'Query completion only; inspect each data value for unknown/unsupported/auth_required before interpreting prices or balances.' }, results: { type: 'array', items: objectSchema({ provider_id: string, status: { enum: ['ok', 'error'] }, data: { type: ['object', 'null'] }, error: { type: ['object', 'null'] } }) } })
const unknownCost = objectSchema({ status: { const: 'unknown' }, billed_cost: { type: 'null' }, currency: { type: 'null' }, client_estimate: { type: 'object', description: '仅客户端估价；billed=false，不能当服务商报价或账单。' } })

export const HEADLESS_ERRORS = [
  { code: 'INVALID_ARGUMENT', meaning: '命令或参数无效', action: '运行 cc-haha help <命令>' },
  { code: 'INVALID_PROVIDER', meaning: '找不到指定服务商 ID', action: '运行 cc-haha providers --json 并使用精确 ID' },
  { code: 'AMBIGUOUS_PROVIDER', meaning: '兼容别名对应多个已保存配置', action: '从 providers 中选择一个精确 ID' },
  { code: 'LOGIN_REQUIRED', meaning: '缺少或过期的授权', action: '运行 login；Token Hub 首次 KOA 授权须在桌面端由本人完成' },
  { code: 'LOGIN_UNSUPPORTED', meaning: '此服务商不支持命令行登录流程', action: '在桌面端配置该 Provider，再用其 ID 调用' },
  { code: 'RUNTIME_UNSUPPORTED', meaning: '此配置使用当前独立 CLI 尚不支持的专用 OAuth 运行时', action: 'models/pricing/usage 仍可读配置；运行请选普通兼容 Provider 或使用既有桌面路径' },
  { code: 'LOGIN_CANCELLED', meaning: '本人取消或总时限终止登录', action: '需要时重新执行 login' },
  { code: 'LOGIN_TIMEOUT', meaning: '等待本人授权超时', action: '重新运行 login 并在时限内完成本人授权' },
  { code: 'PERMISSION_DENIED', meaning: '服务端拒绝当前操作', action: '检查账号权限；不绕过模型限制' },
  { code: 'PROVIDER_UNAVAILABLE', meaning: '目录或服务暂不可用', action: '检查连接或使用 --no-network 读取本机状态' },
  { code: 'WORKDIR_INVALID', meaning: '工作目录不存在或不是目录', action: '修正 --cwd；它不是操作系统沙箱' },
  { code: 'CLI_START_FAILED', meaning: '无法启动原生编程代理', action: '核对安装产物及本机运行权限' },
  { code: 'TIMEOUT', meaning: '超过总时限', action: '检查状态后调整 --timeout-ms，不自动重发写任务' },
  { code: 'INTERRUPTED', meaning: '收到中断信号', action: '检查已有文件改动再决定是否继续' },
  { code: 'OUTPUT_LIMIT', meaning: '原生输出超过单行安全上限', action: '缩小任务输出后重试' },
  { code: 'CLI_ERROR', meaning: '未分类的安全错误', action: '检查本机配置与命令手册；不会输出原始异常或凭据' },
]

export const HEADLESS_COMMANDS: Array<{
  name: HeadlessCommandName; description: string; usage: string; parameters: Parameter[]
  examples: string[]; notes: string[]; output_schema: Record<string, unknown>
}> = [
  {
    name: 'help', description: '离线学习命令、参数、输出和安全边界。', usage: 'cc-haha help [命令] [--manual]',
    parameters: [{ name: '--manual', type: 'boolean', required: false, description: '输出全部命令的完整离线说明，安装器同源生成 HELP.md。' }],
    examples: ['cc-haha help', 'cc-haha help models', 'cc-haha models --help', 'cc-haha help --manual'],
    notes: ['无需授权、无需网络、无需桌面端或源码目录。帮助内容直接编入独立 EXE。'], output_schema: { type: 'string' },
  },
  {
    name: 'capabilities', description: '让其他 codeagent 获取机器可读的命令契约。', usage: 'cc-haha capabilities --json', parameters: [json],
    examples: ['cc-haha capabilities --json'],
    notes: ['这是程序自身支持的能力，不承诺每个上游模型都支持这些能力。服务商级能力看 providers，模型级证据看 models。'],
    output_schema: objectSchema({ schema_version: { const: 2 }, commands: { type: 'array' }, errors: { type: 'array' }, provider_reference: { type: 'object' }, output_schemas: { type: 'object' } }),
  },
  {
    name: 'providers', description: '枚举本机全部已保存服务商配置，输出精确 ID 和支持状态。', usage: 'cc-haha providers [--json]', parameters: [json],
    examples: ['cc-haha providers --json'],
    notes: ['只读脱敏投影，不输出密钥、令牌、密码或携带身份的接口地址。configured 表示本机配置存在，不代表远端授权已实测有效。'],
    output_schema: objectSchema({ schema_version: { const: 2 }, providers: { type: 'array', items: { type: 'object', required: ['id', 'name', 'capabilities'] } }, checked_at: string }),
  },
  {
    name: 'models', description: '获取模型目录、协议/能力与权限证据；不会收费逐模型探测。', usage: 'cc-haha models (--provider <ID|kscc|tokenhub> | --all) [--json] [--no-network]', parameters: [provider, all, json, noNetwork, timeout],
    examples: ['cc-haha models --provider kscc --json', 'cc-haha models --provider saved-provider-id --no-network --json', 'cc-haha models --all --json'],
    notes: ['未超限、目录列出、服务商声明可用和真实调用许可是不同证据。缺能力/上下文/定价时保留 unknown/null，不根据名称猜测。'],
    output_schema: objectSchema({ schema_version: { const: 2 }, provider: string, provider_id: string, status: { const: 'ok' }, models: { type: 'array', items: modelSchema }, checked_at: string }),
  },
  {
    name: 'pricing', description: '查询服务商定价证据，当前缺少核实价格时明确返回 unknown/null。', usage: 'cc-haha pricing (--provider <ID|kscc|tokenhub> | --all) [--json] [--no-network]', parameters: [provider, all, json, noNetwork, timeout],
    examples: ['cc-haha pricing --provider tokenhub --json', 'cc-haha pricing --all --json'],
    notes: ['单价与剩余额度不同。不会套 Claude 单价，不猜远端价格端点；当前未知价格不是免费。模型价格能力详见该次输出来源。'],
    output_schema: objectSchema({ schema_version: { const: 2 }, provider: string, provider_id: string, status: string, currency: { type: ['string', 'null'] }, unit: string, rates: { type: 'object' }, source: { type: 'object' } }),
  },
  {
    name: 'usage', description: '查询账户级余额支持状态、此机按 Provider/模型的滚动消耗及可计算的耗尽预测。', usage: 'cc-haha usage (--provider <ID|kscc|tokenhub> | --all) [--json] [--no-network]', parameters: [provider, all, json, noNetwork, timeout],
    examples: ['cc-haha usage --provider kscc --json', 'cc-haha usage --all --json --no-network'],
    notes: ['本机窗口为 1h/24h/7d，仅计此 CLI，不包含旧 GUI、其他客户端或其他机器。账户余额不能按机器相加。', 'provider_preset 是已选配置的实际预设或 null；汇总先校验角色，不能因自定义 ID 恰叫 kscc 就把它当企业 KSCC。', '无账户归属的旧记录单列 legacy_usage，不猜归属；没有余额/同单位速度/有效样本就不编造 ETA。'],
    output_schema: objectSchema({ schema_version: { const: 2 }, provider: string, provider_id: { type: ['string', 'null'] }, provider_preset: { type: ['string', 'null'], description: 'Actual selected preset, not inferred from ID/alias text; null when no saved provider is selected.' }, local_usage: { type: 'object' }, legacy_usage: { type: ['object', 'null'] }, server_quota: { type: 'object' }, forecast: { type: 'array' } }),
  },
  {
    name: 'login', description: '复用已保存身份，或按支持状态提示本人登录。', usage: 'cc-haha login --provider <ID|kscc|tokenhub> [--json]', parameters: [provider, json, timeout],
    examples: ['cc-haha login --provider kscc', 'cc-haha login --provider tokenhub --json'],
    notes: ['不自动打开窗口。KSCC 可打印本人授权地址；Token Hub 首次 KOA 登录须在桌面端本人完成。', '其他自定义 Provider 不假装登录成功，返回 LOGIN_UNSUPPORTED。不会修改图形界面默认服务商。'],
    output_schema: objectSchema({ schema_version: { const: 2 }, provider: string, provider_id: string, logged_in: { const: true } }),
  },
  {
    name: 'run', description: '使用既有原生编程代理读取/编辑文件、执行命令并输出单次结果。', usage: 'cc-haha -p "提示词" --provider <ID|kscc|tokenhub> --model <模型> [--cwd <目录>] [--output-format text|json]',
    parameters: [provider, { name: '-p, --print', type: 'string|stdin', required: true, description: '提示词可作参数或 UTF-8 标准输入，完成后退出。' }, { name: '--model', type: 'string', required: true, description: '显式模型 ID；先从 models 查询。' }, { name: '--cwd', type: 'directory', required: false, description: '默认调用者目录；不是操作系统沙箱。' }, { name: '--output-format', type: 'text|json', required: false, description: '默认 text；json 为单个 schema v2 结果。' }, { name: '--allowed-tools', type: 'string[]', required: false, description: '仅为可信任务授予需要的工具；沿原生路径和许可规则。' }, { name: '--permission-mode', type: 'string', required: false, description: '默认 dontAsk，待审批操作直接拒绝；不默认绕过权限。' }, { name: '--max-turns', type: 'integer', required: false, description: '沿用原生代理轮数上限。' }, timeout],
    examples: ['cc-haha -p "回复 OK" --provider kscc --model glm-5.1 --output-format json', 'cc-haha -p "读取 README，总结测试方法" --provider saved-provider-id --model model-id --cwd "G:\\work\\project" --output-format json', 'cc-haha -p "修复测试并验证" --provider tokenhub --model model-id --allowed-tools Read Edit Write Bash --max-turns 8 --timeout-ms 120000 --output-format json'],
    notes: ['每次有独立 run_id、Provider、模型和目录；可以用现有 Bash/PowerShell 并行调用不同模型，写任务需隔离目录/工作树。', '默认不保存会话、提示词历史、工具参数和工具结果，只保存最小用量台账。', 'tool_usage 为尝试次数；执行成功还要看 permission_denials 和实际产物。', 'schema v2 迁移：保留旧成本字段，但 total_cost_usd 与 modelUsage.*.costUSD 在真实价格未知时为 null；旧消费者须检查 schema_version 与 cost.status，不能假定为数值。', '客户端原估价独立放 cost.client_estimate 并标 billed=false；未知 token 消费也不能当实际零消费。'],
    output_schema: objectSchema({ schema_version: { const: 2 }, provider: string, provider_id: string, model: string, run_id: string, result: string, usage: { type: 'object' }, modelUsage: { type: 'object' }, tool_usage: { type: 'object' }, is_error: { const: false }, exit_code: { const: 0 }, total_cost_usd: { type: 'null' }, cost: unknownCost }),
  },
]

export function getHeadlessCapabilities() {
  return {
    schema_version: HEADLESS_SCHEMA_VERSION, program: 'cc-haha', supported_modes: ['single_run', 'query', 'offline_discovery'],
    runtime: 'existing_native_print',
    supported_provider_runtime_kinds: ['anthropic_compatible'],
    unsupported_provider_runtime_kinds: ['openai_oauth', 'grok_oauth'],
    provider_reference: { values: 'saved_provider_id_or_alias', aliases: ['kscc', 'tokenhub'], exact_id_first: true, ambiguous_alias_error: 'AMBIGUOUS_PROVIDER', aggregate: '--all for models/pricing/usage; provider id all is not reserved' },
    authentication: { secrets_in_output: false, interactive_windows: false, tokenhub_first_login: 'desktop_by_account_owner' },
    defaults: { permission_mode: 'dontAsk', session_persistence: false, timeout_ms: 600000 },
    common_output_parameters: { names: ['--json', '--output-format'], formats: ['text', 'json'], description: '--json selects JSON; --output-format text|json is accepted by non-help commands. capabilities always emits JSON.' },
    native_argument_passthrough: { command: 'run', enabled: true, validation: 'existing_native_cli', common_options: ['--tools', '--allowed-tools', '--allowedTools', '--disallowed-tools', '--permission-mode', '--max-turns'], rejected_options: ['--input-format', '--sdk-url', '--permission-prompt-tool', '--verbose', '--debug', '-d', '--debug-file', '--debug-to-stderr'] },
    manual: { bundled: true, command: 'cc-haha help --manual', installed_files: ['HELP.md', 'README.md', 'capabilities.json'] },
    commands: HEADLESS_COMMANDS.map(command => ({
      ...command,
      support_status: { command: 'supported', upstream: ['run', 'models', 'usage', 'login'].includes(command.name) ? 'provider_dependent' : command.name === 'pricing' ? 'verified_prices_unknown' : 'offline' },
      parameters: command.parameters.map(parameter => ['models', 'pricing', 'usage'].includes(command.name) && parameter.name === '--provider' ? { ...parameter, required: false } : parameter),
      input_constraints: ['models', 'pricing', 'usage'].includes(command.name) ? { exactly_one_of: ['--provider', '--all'], provider_all_is_aggregate_alias: false } : {},
      success_schema: command.output_schema,
      failure_schema: errorSchema,
      output_schema: command.name === 'help' ? command.output_schema : { anyOf: [command.output_schema, errorSchema, ...(['models', 'pricing', 'usage'].includes(command.name) ? [aggregateSchema] : [])] },
    })),
    output_schemas: { aggregate: aggregateSchema, error: errorSchema, model: modelSchema },
    errors: HEADLESS_ERRORS,
    exit_codes: { success: 0, failure_or_partial: 1, timeout: 124, interrupted: 130 },
    pricing_policy: 'Unknown upstream prices and billed costs remain null; client estimates are never provider billing evidence.',
    schema_migration: { previous: 1, current: 2, changes: ['Provider selection accepts saved IDs; aliases can be ambiguous.', 'total_cost_usd and modelUsage.*.costUSD are nullable and unknown costs are null.', 'Client estimates only appear under cost.client_estimate with billed=false.', 'Usage is attributed by provider_id; old unattributed records are isolated in legacy_usage.'], consumer_action: 'Check schema_version, cost.status, is_error/exit_code or aggregate status before reading nullable numeric fields.' },
  }
}

export function renderHeadlessHelp(command?: string, manual = false): string {
  const selected = command ? HEADLESS_COMMANDS.filter(item => item.name === command) : manual ? HEADLESS_COMMANDS : []
  if (command && !selected.length) throw new Error('UNKNOWN_HELP_COMMAND')
  const overview = ['# cc-haha 命令行离线说明（schema v2）', '', '先让其他 codeagent 读取：cc-haha capabilities --json', '完整内嵌手册：cc-haha help --manual；单命令：cc-haha help models 或 cc-haha models --help。', '', '离线只读发现（不调用模型、不访问网络）：', '1. cc-haha providers --json', '2. cc-haha models --all --no-network --json', '3. cc-haha pricing --all --no-network --json', '4. cc-haha usage --all --no-network --json', '', '需要最新远端目录或账户余额时，再去掉 --no-network；pricing 当前仍不发请求或猜测价格接口。', '明确选择模型和工具许可后，先看 cc-haha help run；只有执行 run/-p 才会调用模型。', '聚合 status=ok 只表示查询成功，仍须检查各项 data 中的 unknown/unsupported/auth_required，不能把顶层 ok 当成价格或余额已知。', '示例中的 saved-provider-id / model-id 是占位值，必须先 providers/models 查询，再替换为本机真实 ID。', '命令：', ...HEADLESS_COMMANDS.map(item => `- ${item.name}: ${item.description}`), '', '配置：显式 CLAUDE_CONFIG_DIR 优先，否则本机用户 ~/.claude；安装包装器可有本人桌面目录回退。', '不复制凭据、不自动弹窗；默认 dontAsk，未获授权的工具直接拒绝。未知单价/账单是 null，不是零或免费。', '无界面单次调用不是交互式 TUI；不承诺与其他产品全部功能一致。', '安装目录内提供 HELP.md / README.md / capabilities.json，断网和没有源码时也可读。', '完整源码手册：docs/cli/providers.md；英文：docs/en/cli/providers.md。', '']
  for (const item of selected) {
    overview.push(`## ${item.name} — ${item.description}`, '', item.usage, '', '参数：', ...item.parameters.map(p => `- ${p.name} (${p.type}，${p.required ? '必需/与聚合条件互斥' : '可选'})：${p.description}`), '', '示例：', ...item.examples.map(example => `  ${example}`), '', ...item.notes, '')
    if (['models', 'pricing', 'usage'].includes(item.name)) overview.push('选择条件：--provider <精确ID或兼容别名> 与 --all 必须且只能提供一个；--provider all 表示精确 ID all，不是聚合别名。', '')
  }
  if (manual) overview.push('## 错误与恢复', '', ...HEADLESS_ERRORS.map(error => `- ${error.code}：${error.meaning}；${error.action}`), '', '退出码：0 成功；1 失败或聚合部分失败；124 超时；130 中断。', '单次 JSON 必须检查 is_error/exit_code；聚合必须检查 status 及逐项 error。', '')
  return overview.join('\n') + '\n'
}
