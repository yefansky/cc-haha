# 随桌面分发的独立网关客户端

本目录自包含 Python tunnel 客户端及必要协议、流控模块，不依赖相邻私有仓库。来源提交、原文件路径、原始及迁移后 SHA-256 见 `SOURCE.json`。迁移只调整客户端的共用模块导入；没有引入网关服务端、账户数据库、管理脚本、运行配置或私人文档。

协议与流控模块位于 `cc_haha_tunnel` 包中；不存在 `cc_haha_gateway` 包，也不能导入该包。此版本仍是既有 HTTP/WebSocket 透传，不是端到端加密实现。公网连接必须使用 HTTPS/WSS；网关仍能处理被转发的业务内容。

## 隐私通道接缝：默认禁用

本机客户端保留 `/_privacy/channel` 字节通道接缝，供后续经过验收的安全会话使用。发行入口没有注册处理器，也没有通过命令行启用它的开关；默认访问会被拒绝，不会回退到普通上游。其他 `/_privacy` 路径变体、查询参数和 HTTP 转发同样拒绝。

处理器接口本身不提供加密或认证。外层连接成功不代表身份确认；关闭按中断处理，不代表应用数据完整送达。通道复用现有背压和取消机制，并限制等待发送额度的时间。不要将这个研发接缝描述为可供用户使用的隐私模式。

安装锁定运行依赖后，可运行 `python -I -B -m unittest discover -s desktop/gateway-client/tests -v`（从仓库根目录）。不安装依赖时，仅运行 `python -I -B -S -m unittest discover -s desktop/gateway-client/tests -p test_offline.py -v`。测试中的本地处理器是验证用例，不是产品加密实现。

## 开发运行

需要 Python 3.11 或 3.12。先在自己的虚拟环境中安装 `requirements/runtime.txt`（使用 `pip install --require-hashes --only-binary=:all: -r requirements/runtime.txt`），然后将本目录 `src` 放入 `PYTHONPATH`，运行 `python -m cc_haha_tunnel --help`。密钥仅通过现有环境变量或单行 UTF-8 JSON stdin 交付，不放进命令行。目标上游只允许 literal-loopback 地址。

## 原生构建

在本目录运行 `python build.py --target win32-x64 --output-dir <新的输出目录>`；Linux/macOS 使用对应原生目标与 Python。支持 win32/linux/darwin 的 x64/arm64 原生构建，不支持交叉编译。构建机需要 Python 自带的 `venv` 模块，但不需要系统 `ensurepip` 或手工安装 `python3-venv`：构建器创建不含 pip 的临时环境，再用本地锁文件指定版本和 SHA-256 校验过的 pip wheel 引导。不会运行未校验在线脚本、执行 apt 或向系统 Python 安装包。最终用户不需要安装 Python。

构建器新建临时独立 venv，从 PyPI 按 `requirements-build.txt` 与运行时锁文件安装固定版本和 SHA-256 校验的 wheel，只调用客户端 PyInstaller 入口，并检查收集图中没有网关服务端包。首次构建需要联网取得这些公开依赖。产物为 `<输出目录>/cc-haha-tunnel/`，包含可执行文件、运行时依赖、第三方许可、来源记录和文件哈希清单。已有同名输出时拒绝覆盖；失败不应继续发布。

桌面 `scripts/build-gateway-tunnel.ts` 调用本目录构建，再将通过目标检查的完整包放入 `src-tauri/binaries/gateway-tunnel/<平台-架构>/`。可通过 `CC_HAHA_BUILD_PYTHON` 指定本机 Python 解释器；不再接受私有源码位置。该步骤缺文件、依赖安装失败或目标不匹配时硬失败，不生成缺客户端的安装包。

原生 Windows 构建和 Linux 构建应分别验收；平台版本、系统工具链和签名会影响二进制，依赖哈希锁定不等于跨机器逐字节可复现。更新这些已复制模块时需同时更新来源与哈希，并验证与网关的协议互通。根项目许可的副本位于 `LICENSE.txt`。
