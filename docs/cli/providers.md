---
title: 无界面调用服务商
nav_title: 服务商命令行
description: 在 Windows 命令行复用 KSCC 和 Token Hub 授权，执行编程任务并查询模型与额度。
order: 4
---

# 无界面调用服务商

`cc-haha` 命令行复用现有编程代理、工具和服务商授权。可以直接读写文件、执行命令，也能列模型、查询额度；不需要安装 KSCC 或 Token Hub 的客户端。命令行本身不会打开窗口或对话框。

## 安装与配置目录

目前从源码使用，需要 Git 和 Bun。获取自己的 cc-haha 仓库后，在仓库根目录安装锁定依赖，再使用 `bin\cc-haha.cmd`。这里以 `G:\tools\cc-haha` 为例：

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

需要长期使用已编译程序时，可用仓库附带的安装脚本，把已验证的 `cc-haha.exe` 复制到固定目录，并生成命令包装入口：

```powershell
& .\scripts\install-headless-cli.ps1 -Executable 'G:\build\cc-haha.exe' -InstallDirectory 'G:\tools\cc-haha-cli' -ConfigDirectory "$env:USERPROFILE\.claude" -AddToUserPath
```

把示例配置目录换成自己桌面端实际使用的目录。脚本的 `-AddToUserPath` 会将固定安装目录的 `bin` 加入用户 PATH；重开终端后使用。已运行的 GUI 程序继承旧 PATH，可以先使用固定绝对入口 `G:\tools\cc-haha-cli\bin\cc-haha.cmd`，无需为了更新 PATH 中断会话。安装生成的包装入口以显式 `-ConfigDirectory` 为回退值，调用方已经设置的 `CLAUDE_CONFIG_DIR` 优先。源码包装和直接运行裸 EXE 仍沿用下面的标准默认目录。

**配置目录必须与自己已登录的桌面端一致。** 命令沿用当前进程的 `CLAUDE_CONFIG_DIR`；未设置时使用本机用户目录下 `.claude`。如果桌面启动脚本用了另外的数据目录，先将 `CLAUDE_CONFIG_DIR` 设为那个已存在目录。不要新建一个空目录后期待自动找到桌面授权，也不要复制其他用户或其他机器的令牌。配置目录应位于本人用户目录并受本机权限保护；对既有自定义桌面目录，沿用其位置和权限。

## 登录

```powershell
& $cc login --provider kscc
& $cc login --provider tokenhub
```

已有授权时直接复用。KSCC 缺少授权时在终端显示本人授权地址，手动在浏览器完成，命令不会自动启动浏览器。Token Hub 当前支持复用及刷新已保存授权；首次 KOA 登录、旧版本没有保存管理端刷新凭据或服务端要求重新登录时，会明确提示先在 cc-haha 桌面端完成本人授权，再运行命令。它不会在后台弹登录窗口，也不会绕过本人登录。

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

## 模型和额度

```powershell
& $cc models --provider kscc
& $cc models --provider tokenhub
& $cc usage --provider tokenhub --json
```

模型目录中的列出、可用声明、额度超限和真实调用许可是不同证据。KSCC 的 `quota_limited=false` 只说明没有被标记超限，不保证当前账号有模型调用权限；实际遇到 403“模型限制”时换获准模型或联系管理员。普通模型列表不会逐模型发计费探测请求。

`usage` 查询近 1 小时、24 小时、7 天此机新命令行的 token 消耗，按服务商和模型分列、同一请求去重，缓存独立显示。它不回溯旧桌面日志，也不包含其他客户端或其他机器；首次没有记录表示“尚无记录”，不能据此断言账号历史消费为零。

KSCC 未提供剩余数值时明确写“服务端不提供”；超限状态在模型目录查看。Token Hub 查询账户级三窗口额度，查询失败区分未授权、不支持和暂不可用，不用旧缓存假装实时余额。两台机器同账号余额不能相加。

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

在第二台机器检出同一提交、安装同一锁定依赖，把上述 `G:\tools\cc-haha` 换为该机实际路径，例如 `F:\tools\cc-haha`。缓存和临时目录也一起换到 F 盘。配置目录使用第二台机器本人用户目录，分别完成本人授权，不从第一台复制令牌。

部署后依次运行 KSCC 的 `回复 OK` JSON 命令、Token Hub 列表中的获准模型、两个 `models` 和两个 `usage`。再在临时工作目录验证“读文件 → 修改文件 → 执行校验命令”完整链路。第一台机器的成功结果不等于第二台已验收。
