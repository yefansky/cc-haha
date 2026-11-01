---
title: 无界面调用服务商
nav_title: 服务商命令行
description: 让人和代码代理离线发现命令，按已保存服务商查询模型、价格证据和额度，执行编程任务。
order: 4
---

# 无界面调用服务商

`cc-haha` 命令行复用现有编程代理、工具和服务商配置。可以直接读写文件、执行命令，也能发现本机服务商、模型、定价证据和用量。KSCC 与 Token Hub 沿用现有本人授权，无需安装它们的客户端。命令行本身不会打开窗口或对话框。

## 先让人和代码代理发现命令

```powershell
cc-haha help
cc-haha help models
cc-haha models --help
cc-haha capabilities --json
```

`help` 提供中文教学和可复制示例，`help <命令>` 与 `<命令> --help` 等价。`capabilities` 提供机器可读的命令参数、互斥条件、模式、支持状态、成功与失败输出结构和错误恢复方法。它们不读取授权、不联网、不要求桌面端或源码目录；独立 EXE 中已编入说明。完整离线说明用 `cc-haha help --manual`，更新后的手工 `install-headless-cli.ps1` 还会在命令目录生成同源 `HELP.md`、`README.md` 和 `capabilities.json`。仅运行旧包装器不会自动得到这些文件，需要用新版 EXE 和安装脚本重新安装。

推荐其他 codeagent 的顺序是：读 `capabilities` → 读 `providers` 并选择精确 ID → 读该 ID 的 `models`、`pricing`、`usage` → 明确模型和权限后执行任务。下文的 `saved-provider-id`、`model-id` 都是占位值，必须替换为查询得到的实际 ID。

## 安装与配置目录

包含此功能的新版 Windows 桌面安装/更新包已自带 `cc-haha`，不需要先获取源码。先按[安装版命令行](../start/install.md#windows-安装版命令行)检查 PATH 与实际入口；稳定入口在实际安装目录的 `bin\cc-haha.cmd`，同目录有离线说明。旧终端或 agent 宿主需重新启动才能继承更新后的 PATH；发现同名旧 CLI 时列出来源并显式选择，不删除安装目录外的用户手工入口。安装树属于应用管理，升级/卸载可能整体替换或移除，请勿存放需永久保留的自定义脚本；同目录入口冲突可使用安装目录的 `resources\cli\cc-haha.cmd` 备用入口，安装诊断见同目录 `registration-status.txt`。安装包装入口遵循显式 `CLAUDE_CONFIG_DIR`，否则跟随当前用户桌面 app-mode 的自定义/便携目录，默认使用 `~/.claude`。

下面是仍可独立使用的**源码与手工部署**路线，需要 Git 和 Bun。获取自己的 cc-haha 仓库后，在仓库根目录安装锁定依赖，再使用 `bin\cc-haha.cmd`。这里以 `G:\tools\cc-haha` 为例：

```powershell
Set-Location G:\tools\cc-haha
$env:TEMP = 'G:\tools\cc-haha\.runtime\cli-temp'
$env:TMP = $env:TEMP
$env:BUN_INSTALL_CACHE_DIR = 'G:\tools\cc-haha\.runtime\bun-cache'
$env:npm_config_cache = 'G:\tools\cc-haha\.runtime\npm-cache'
New-Item -ItemType Directory -Force $env:TEMP | Out-Null
bun install --frozen-lockfile
$cc = 'G:\tools\cc-haha\bin\cc-haha.cmd'
```

无需运行桌面端、前端开发服务器或网关。也可把仓库 `bin` 目录加入当前终端的 PATH：`$env:PATH = 'G:\tools\cc-haha\bin;' + $env:PATH`，然后直接输入 `cc-haha`。这不会修改系统 PATH。

需要长期使用已编译程序时，先自行把已验证的 `cc-haha.exe` 放到稳定路径，再用安装脚本生成包装入口和离线说明。**脚本引用 `-Executable` 指定的文件，不复制或搬迁 EXE；安装后不能删除或移动该文件。** 例如：

```powershell
New-Item -ItemType Directory -Force 'G:\tools\cc-haha-cli\runtime' | Out-Null
Copy-Item -LiteralPath 'G:\build\cc-haha.exe' -Destination 'G:\tools\cc-haha-cli\runtime\cc-haha.exe'
& .\scripts\install-headless-cli.ps1 -Executable 'G:\tools\cc-haha-cli\runtime\cc-haha.exe' -InstallDirectory 'G:\tools\cc-haha-cli\bin' -ConfigDirectory "$env:USERPROFILE\.claude" -AddToUserPath
```

把示例配置目录换成自己桌面端实际使用的目录。`-InstallDirectory` 本身就是包装入口和说明文件所在目录；`-AddToUserPath` 将它直接加入用户 PATH，不会再添加一层 `bin`。不要把同名 `cc-haha.exe` 放到命令目录，以免优先执行 EXE 而绕过配置包装器。重开终端后使用短命令；已运行的 GUI 继承旧 PATH，可先使用固定绝对入口 `G:\tools\cc-haha-cli\bin\cc-haha.cmd`，无需中断会话。显式 `-ConfigDirectory` 是包装器回退值，调用方已有的 `CLAUDE_CONFIG_DIR` 优先。源码包装和裸 EXE 仍沿用标准默认目录。

**源码/手工独立入口的配置目录必须与自己已登录的桌面端一致。** 它们沿用当前进程的 `CLAUDE_CONFIG_DIR`；未设置时使用本机用户目录下 `.claude`。如果桌面启动脚本用了另外的数据目录，先将 `CLAUDE_CONFIG_DIR` 设为那个已存在目录。不要新建一个空目录后期待自动找到桌面授权，也不要复制其他用户或其他机器的令牌。配置目录应位于本人用户目录并受本机权限保护；对既有自定义桌面目录，沿用其位置和权限。

## 登录

```powershell
& $cc login --provider kscc
& $cc login --provider tokenhub
```

已有授权时直接复用。KSCC 别名缺少授权时在终端显示本人授权地址，手动在浏览器完成，命令不会自动启动浏览器。Token Hub 当前支持复用及刷新已保存授权；首次 KOA 登录、旧版本没有保存管理端刷新凭据或服务端要求重新登录时，先在桌面端由本人完成授权。其他自定义服务商返回 `LOGIN_UNSUPPORTED`，请在桌面端配置；不会假装登录成功。明确 ID 的失效企业身份需在桌面端精确重连，避免重新授权覆盖同类其他配置。

在线 Token Hub 模型与额度查询遇到授权过期时，会由同一套凭据机制尝试一次刷新并保存轮换结果；必须重新登录时终止并提示。`usage --no-network` 只读本机计量，不触发服务端查询或刷新。不要把令牌写进命令参数、提示词、脚本或日志。

Token Hub 的管理端授权与模型调用密钥独立。目录或额度查询提示“需要重新登录”，不代表模型调用密钥已经失效；已知获准模型的编程调用仍可能正常，应分别检查两个结果。

## 单次编程任务

```powershell
& $cc -p '回复 OK' --provider kscc --model glm-5.1 --output-format json
& $cc -p '读取 README 并说明如何运行测试' --provider tokenhub --model '<models 返回的模型名>' --cwd 'G:\work\项目 A'
& $cc -p '修复当前测试并执行验证' --provider kscc --model glm-5.1 --cwd 'G:\work\项目 A' --allowed-tools 'Read,Edit,Write,PowerShell' --max-turns 12 --timeout-ms 600000
```

第三个例子显式允许读写与 PowerShell 工具，请仅对可信任务授予所需权限。沿用原有工具许可和路径规则；默认使用非交互权限模式 `dontAsk`，需要人工批准且未获授权的工具会被拒绝。命令不会等待权限对话框。`--cwd` 选择工作目录，并不构成操作系统沙箱；不希望访问其他路径时还应使用相应工具权限和隔离目录。不要用无限制权限作为日常默认值。

`--output-format text` 返回结果文本，`json` 返回一个 JSON 对象，包括结果、实际模型、普通输入与输出 token、缓存 token、耗时、运行标识和退出状态。`tool_usage` 仅列工具名称与尝试次数，不含参数；次数不能独立证明执行成功，权限拒绝另见 `permission_denials`。机器读取 stdout；诊断写 stderr。超时、缺授权、模型受限、工具权限失败和执行失败均应检查退出码及结果状态，不能只搜索输出中是否有 “OK”。上游没有返回 usage 时，不把未知消费当作实际零消费。

**JSON v2 迁移：** 检查 `schema_version=2`。旧字段保留，但没有服务商真实计价证据时 `total_cost_usd` 和 `modelUsage.<模型>.costUSD` 为 `null`，不再把客户端内部估价当账单。原估价只放在 `cost.client_estimate`，标记 `billed=false`；客户端须先看 `cost.status`，不能假定成本字段一定是数字。预检失败的 `provider_id`、`model` 可以是 `null`，失败结构见 `capabilities.output_schemas.error`，不能用成功结构解析所有结果。

## 模型和额度

```powershell
& $cc providers --json
& $cc models --provider kscc
& $cc models --provider tokenhub
& $cc models --provider saved-provider-id --json --no-network
& $cc pricing --all --json
& $cc usage --provider tokenhub --json
```

`providers` 列出全部本机已保存配置，输出稳定 `id/provider_id`、名称、预设、是否当前默认及各查询的支持状态；不枚举互联网所有厂商，也不输出密钥或携带身份的接口地址。`--provider` 精确 ID 优先；`kscc`、`tokenhub` 是兼容别名，同类有多个配置时返回 `AMBIGUOUS_PROVIDER`，按 `providers` 中的 ID 选择。一个配置的 ID 即使叫 `all` 也按 ID 解释。

独立编程调用支持普通 `anthropic_compatible` 运行时，沿原机制适配 Anthropic、OpenAI Chat 和 Responses 协议。已有 `openai_oauth`、`grok_oauth` 专用官方身份运行时本轮不扩展：仍可列出配置/目录/定价状态/本机用量，但 `providers` 会标出运行不支持，执行返回 `RUNTIME_UNSUPPORTED`，不会暗中依赖桌面端或默认端口。

`models`、`pricing`、`usage` 必须且只能选择 `--provider <ID或别名>` 或 `--all` 之一。聚合逐项保留成功和安全错误，`status=partial/error` 时退出码非零；不能因一项失败丢掉其他结果。查询命令不支持的筛选参数会明确拒绝，不会静默忽略。

模型目录现在包含协议与来源、能力及来源、上下文窗口及来源、是否实时/配置快照，以及权限证据。`--no-network` 只读本机保存目录或模型映射，`freshness=configured` 不是实时目录。未知能力以来源 `unknown` 标记，未知上下文为 `null`。列出、可用声明、额度超限和真实调用许可是不同证据；`call_access` 和 `permission.status` 未探测时为 `unknown`，不会逐模型发计费探测请求。KSCC 的 `quota_limited=false` 不保证有调用权限，403“模型限制”仍需换获准模型或联系管理员。

`pricing` 当前没有取得已核实的账户单价，明确输出 `status=unknown`，币种、输入/输出/缓存单价为 `null`，附 `source` 和检查时间。规范单位为每百万 token；这不表示已经知道对应价格。模型逐项也保留未知状态。不会猜价格接口、套用 Claude 单价、把未知解释成免费，或把余额查询当作定价查询。

`usage` 查询近 1 小时、24 小时、7 天此机新命令行的 token 消耗，按稳定 `provider_id` 与模型分列、同一请求去重，缓存独立显示。同预设多个账户不会混算。旧 v1 没有 Provider ID 的记录只列入 `legacy_usage`，不猜归属，也不能与新记录相加。它不回溯旧桌面日志，不包含其他客户端或其他机器；没有记录不是账号历史消费为零。

`provider_preset` 标明已选配置的实际预设，未选中已保存配置时为 `null`。汇总脚本应据此校验服务商角色，不能因为自定义配置 ID 恰好叫 `kscc` 就把它算作企业 KSCC 或带入旧 KSCC 记录；角色未知或不匹配时应明确保留无数值状态。

KSCC 和其他没有余额接口的自定义服务商明确写“服务端不提供”；超限状态在模型目录查看。Token Hub 查询账户级三窗口额度，查询失败区分未授权、不支持和暂不可用，不用旧缓存假装实时余额。模型调用密钥、模型单价和账户余额是三种独立事实。两台机器同账号余额不能相加。

预计耗尽时间使用同一账号、币种、额度窗口内至少相隔一分钟的两次服务端快照：剩余金额除以观测消费速度。没有余额、未知或无限额度、样本不足、没有正向消费时不给日期；预计晚于周期重置时只说明本周期内不会耗尽。变化速度和其他客户端消费会影响预测，不保证未来结果。可在不联网时查看本机计量：

```powershell
& $cc usage --provider kscc --json --no-network
```

## 用其他模型做子任务

在现有 cc-haha 会话的 PowerShell 或 Bash 工具里调用相同命令，就能把独立子任务交给另一服务商或模型，无需新增调度器。例如主会话使用一个模型，安排 KSCC 检查测试目录：

```powershell
& 'G:\tools\cc-haha\bin\cc-haha.cmd' -p '只读检查 tests 目录，列出遗漏的边界测试，不修改文件' --provider kscc --model glm-5.1 --cwd 'G:\work\项目 A' --output-format json
```

可同时启动两个独立 CLI，分别指定服务商、模型和工作目录。每次运行有独立标识，额度归属依据该次调用，不读取全局默认模型来猜。并行写代码时应使用互不重叠的目录或独立 Git 工作树；两个代理同时修改同一个文件仍会冲突。

## 第二台 Windows 机器

第二台 Windows 机器可安装包含此功能的同一桌面版本，再按安装版发现步骤检查；使用源码路线时，检出同一提交、安装同一锁定依赖，把上述 `G:\tools\cc-haha` 换为该机实际路径，例如 `F:\tools\cc-haha`。缓存和临时目录也一起换到 F 盘。配置目录使用第二台机器本人用户目录，分别完成本人授权，不从第一台复制令牌。

部署后依次运行 KSCC 的 `回复 OK` JSON 命令、Token Hub 列表中的获准模型、两个 `models` 和两个 `usage`。再在临时工作目录验证“读文件 → 修改文件 → 执行校验命令”完整链路。第一台机器的成功结果不等于第二台已验收。
