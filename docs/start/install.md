---
title: 下载与安装
nav_title: 下载与安装
description: macOS、Windows、Linux 三个平台的安装包，以及系统拦截时的处理办法。
order: 1
---

# 下载与安装

装完就能用，不需要另外安装 Node.js、Python 或 Claude Code——CLI 内核和文件搜索用的 ripgrep 都已经打进安装包里了。

## 挑对安装包

所有安装包都在 [GitHub Releases](https://github.com/NanmiCoder/cc-haha/releases/latest)，按系统和 CPU 架构选一个：

| 你的系统 | 下载 |
|---|---|
| macOS，M 系列芯片 | `Claude-Code-Haha-<版本>-mac-arm64.dmg` |
| macOS，Intel 芯片 | `Claude-Code-Haha-<版本>-mac-x64.dmg` |
| Windows x64 | `Claude-Code-Haha-<版本>-win-x64.exe` |
| Windows ARM64 | `Claude-Code-Haha-<版本>-win-arm64.exe` |
| Linux x64 | `Claude-Code-Haha-<版本>-linux-x86_64.AppImage` 或 `-linux-amd64.deb` |
| Linux ARM64 | `Claude-Code-Haha-<版本>-linux-arm64.AppImage` 或 `-linux-arm64.deb` |

不确定自己是哪种架构：macOS 看「关于本机」里的芯片型号，Windows 看「设置 → 系统 → 系统信息」里的系统类型。别只凭机器牌子猜。

`.blockmap` 和 `latest*.yml` 是应用自动更新用的，不用手动下载。

## macOS

1. 双击 DMG。
2. 把 Claude Code Haha 拖进「应用程序」。
3. 从「应用程序」打开。

### 如果提示「已损坏，无法打开」

这不是文件坏了。macOS 会给从网上下载的安装包打一个隔离标记（quarantine），遇到没有 Apple 签名的应用就直接拒绝启动，报错文案偏偏写成「已损坏」。经过签名和公证的正式版本不会有这一步；如果你拿到的是未签名构建，用下面两种办法之一放行。

**办法一：用官方脚本（推荐）**

从同一个 Release 里把 `install-macos-unsigned.sh` 下载到和 DMG **同一个文件夹**（比如「下载」），然后在终端里跑：

```bash
cd ~/Downloads
bash install-macos-unsigned.sh
```

脚本会自动挑对架构的 DMG、挂载、把应用装进 `/Applications`、清掉隔离标记再打开。已有的旧版本会先移到废纸篓，不会直接覆盖。

**办法二：手动清隔离标记**

已经把应用拖进「应用程序」了，就直接执行：

```bash
xattr -dr com.apple.quarantine "/Applications/Claude Code Haha.app"
```

只对你确认来自本仓库 Release 的安装包这么做。来路不明的应用不要绕过 Gatekeeper。

## Windows

1. 先把正在运行的旧版本完全退出，包括系统托盘里的图标。
2. 双击 `.exe` 安装。
3. **不要**右键选「以管理员身份运行」——安装器是给当前用户装的，用管理员身份反而会让数据目录对不上。

未签名的安装包会触发 SmartScreen 蓝屏提示。确认文件确实来自本仓库 Release 后，点「更多信息」→「仍要运行」。

覆盖升级时安装器会检查旧安装目录里的用户数据。如果它提示「程序仍在运行」，退出主窗口和托盘图标，等几秒让后台的 sidecar、终端和 IM adapter 退干净，再重新运行安装器。别先手动删掉旧安装目录。

### Windows 安装版命令行

包含此功能的新版安装包在首次安装和覆盖升级时同步部署 `cc-haha`，无需另装 Git、Bun、Node.js 或 KSCC/Token Hub 客户端。它复用随包的编程代理和本机授权，执行命令时无需桌面端常驻。

安装器将实际安装目录的 `bin` 注册到对应安装范围的用户或系统 PATH。新开 PowerShell 后执行：

```powershell
where.exe cc-haha
Get-Command cc-haha -All
cc-haha help
cc-haha capabilities --json
cc-haha providers --json
cc-haha models --all --no-network --json
cc-haha pricing --all --no-network --json
cc-haha usage --all --no-network --json
```

最后四项只读发现，不调用模型、不访问网络；`pricing` 返回 unknown/null 时表示没有已验证价格，`usage` 的 unsupported/auth_required 也不等于额度为零。需要最新远端目录或管理额度时，阅读 help 后再去掉 `--no-network`；模型执行另见[服务商命令行](../cli/providers.md)。

实际安装目录下的 `bin\cc-haha.cmd` 是稳定入口，旁边有 `README.md`、`HELP.md`、`capabilities.json` 与 `cli-manifest.json`。它们随安装版本更新；包装器调用同安装内的 sidecar，不依赖开发者源码路径。PATH 未生效时可先用完整路径，例如 `& '实际安装目录\bin\cc-haha.cmd' help`，请把占位目录换成自己的路径。

已运行的终端、编辑器或 codeagent 宿主会保留启动时的环境。新开终端或重启承载 agent 的宿主后再试；仅在旧终端内启动子进程仍可能继承旧 PATH。`where.exe` 或 `Get-Command -All` 列出多个来源时，检查当前选中的是哪一个，必要时显式调用本安装入口。CLI 注册辅助程序不覆盖未知入口、不删除其他 PATH 项或安装目录外的手工 CLI；同目录冲突时保留未知文件，使用安装目录的 `resources\cli\cc-haha.cmd` 备用入口（旁有同源离线说明；诊断见 `resources\cli\registration-status.txt`）。但这不保证整个 NSIS 升级/卸载会保留安装树内自定义文件：应用安装目录由应用管理，可能整体替换或移除，需永久保留的脚本应放在安装目录外。卸载的 PATH 清理只撤销辅助程序自己新增的项；安装目录外的旧 `claude-haha` 不受影响。

配置选择：显式 `CLAUDE_CONFIG_DIR` 优先；安装版包装入口否则只读复用当前用户桌面的 `app-mode.json`，跟随其中自定义/便携目录；默认模式使用用户 `~/.claude`。不要以为安装目录就是数据目录，不要复制或打印凭据。安装时不读取登录、不修改 GUI 配置，也不启动 GUI。

PATH 使程序可查找，无法保证任意 agent 主动调用。可以复制：“本机已安装 cc-haha，请先用 help 和 capabilities 自学，再用 providers 及 models/pricing/usage 的 --all --no-network --json 做只读发现；解释 unknown/null，执行模型前选择准确 Provider ID、模型及最小工具权限。”

## Linux

**AppImage**（免安装，下载即用）：

```bash
chmod +x Claude-Code-Haha-<版本>-linux-x86_64.AppImage
./Claude-Code-Haha-<版本>-linux-x86_64.AppImage
```

启动失败并提示 FUSE 相关错误时，装一下运行库：Ubuntu 22.04 及更早用 `sudo apt install libfuse2`，24.04 及以后用 `libfuse2t64`。

**deb**（装进系统菜单）：

```bash
sudo apt install ./Claude-Code-Haha-<版本>-linux-amd64.deb
```

ARM64 机器换成对应的 `linux-arm64` 文件。

## 从源码跑

想改代码、调试内核，或者只想在终端里用 CLI，可以从源码起：

```bash
git clone https://github.com/NanmiCoder/cc-haha.git
cd cc-haha
bun install
cp .env.example .env
./bin/claude-haha
```

需要 [Bun](https://bun.sh) 和 Git。这条路只跑 CLI，桌面端的构建方式和本地服务参数见 [命令行](../cli/index.md)。

## 升级

**应用内更新（推荐）。** 打开「设置 → 关于 → 应用更新」，点「检查更新」。它会比对当前版本和 GitHub Releases 上的最新版本，有新版就下载，下载完提示「安装并重启」。

更新前先把正在跑的会话停掉，未提交的代码存好。

下载卡住不动，多半是网络到不了 GitHub。同一个面板里有「高级更新代理」，可以切成系统代理或填一个本地 HTTP 代理地址（例如 `http://127.0.0.1:7890`）。这个代理只管应用自己的更新下载，不影响模型请求。

**手动换包。** 从 Releases 下新版安装包，按上面各平台的步骤重装一遍即可。默认模式下，会话、服务商配置、技能、Agent 和记忆存在 `~/.claude`；自定义/便携模式使用桌面设置中的数据目录。覆盖更新不将这些数据迁入命令目录。

:::warning
安装器的数据保护不等于备份。真正重要的东西请自己另存一份。
:::

## Code signing policy

Windows 安装包的签名范围、人工审批、责任角色和验证方法见 [Code signing policy](./code-signing.md)。在 SignPath Foundation 接入完成前，Windows Release 仍会明确标注为未签名；软件联网和本地数据处理方式见[隐私与联网说明](./privacy.md)。

## 装完之后

去 [连接模型服务](./models.md)。没接模型之前，应用能打开，但发不出任何一条消息。

装不上或者打不开，看 [装不上 / 打不开 / 连不上](./troubleshooting.md)。
