# fork 差异与修改约束

本地图针对核验时的 HEAD 加未提交工作区。官网文档、缓存的上游 Git ref、本地提交历史和未提交改动分别标记；不把“当前文档未写到”一律称为 fork 原创。

## 版本边界

- 核验 HEAD：`eeca4362acd4d10e4f21e30678bd914ed216c89d`，分支 `main`。
- `origin` 为 `NanmiCoder/cc-haha`，`fork` 为 `yefansky/cc-haha`。
- 本地缓存 `origin/main=b1b5a6d6781459a2879171688816246ea034594f`；`fork/main=5ffede7e18727e0c20e9f20e3f2f8cf5c07454b9`；**本次没有 fetch，不能称为远端最新状态**。
- 对本地缓存 `origin/main`：HEAD 独有 110 个提交，反方向 137 个；共同祖先为 `38e2f1125306c5881731d61a0c5d3b6e8c1df90d`。这是历史分叉证据，不是 247 项功能差异。

## 已提交历史中的重点

| 本地提交 | 变化 | 后续修改应联查 |
| --- | --- | --- |
| `eeca4362` | 受限网关会话传输 | Server 转发鉴权、Electron 网关运行时与权限隔离 |
| `e1a940ed` | 会话 Provider 随选中模型切换 | UI 选择、Server 已应用运行态、Provider 环境 |
| `a92d63a7` | 隔离的 Seasun Token Hub 集成 | Provider 注册、鉴权来源、请求协议，不向通用层散落业务判断 |
| `1a83a35c` / `15fb4131` / `01626ae3` | 左右对照与工作区编辑流程 | 比较来源、编辑会话、保存冲突、Git/SVN |
| `4bdee72d` | 合并工作区状态扫描 | 在途请求合并、缓存身份和 UI 刷新，不用重复扫描制造阻塞 |

这些提交位于本地 `origin/main..HEAD`，只能证明当前可见历史，不能推断远端是否随后吸收了同类功能。

## 本次读取到的未提交扩展

| 扩展 | 核实入口 | 修改约束 |
| --- | --- | --- |
| 子 Agent 长思考进度 | `src/tools/AgentTool/agentStreamProgress.ts` → `src/utils/sdkEventQueue.ts` → `src/cli/print.ts` → `src/server/ws/handler.ts` | 独立排出事件，不能再次等父生成器产出才显示；token 估计与真实 usage 分开 |
| 文件更改基线登记 | `src/tools/TrackFileChangesTool/TrackFileChangesTool.ts:38`；`src/constants/fileChangeTracking.ts:1` | 工具只读但非并发；Bash/PowerShell 涉及文件更改时遵循当前 `file_changes`/登记契约，未登记的受检请求会拒绝执行 |
| 文件编码保持 | `src/utils/textEncoding.ts:7`：`decodeTextFile`；`:25`：`encodeTextFile` | 读缓存、编辑、历史快照、写回同时保持字节身份，不能默认全部 UTF-8 |
| 比较页写授权修复 | `desktop/src/components/workspace/WorkspacePanel.tsx`：`handleRequestWriteAccess` | 授权只改变能力，保留当前比较内容/历史/指纹；避免 force 重开丢编辑态 |
| 本机网关设置及鉴权 | `src/server/localGatewaySetup.ts`、`desktop/electron/services/gatewayCredentials.ts`、`gatewayTunnelRuntime.ts` | 不把 localhost、转发已鉴权和管理端授权混成一类 |

上述是**本次之前已有的代码改动**，不是这次文档任务实现的功能。文件追踪的拒绝逻辑不是本次审计证实的通用 shell 沙箱，不能承诺能识别任何任意脚本中的写操作。

## 文档不能替代的事实

- “官网新增”不等于“本 fork 已实现”：`builtInAgentOverrides` 和原生 Swift 电脑操作尤需核对。
- “实现存在”不等于“当前构建启用”：压缩、流式执行、fork 子 Agent 和缓存各有条件。
- “测试文件存在”不等于“本轮测试通过”：本次仅做静态交叉核验和文档校验。
- “工作区曾通过测试”不等于“未来版本继续成立”：运行 [verify_snapshot.py](verify_snapshot.py) 检测证据漂移，再重读相关实现。

继续开发时遵循 [根 AGENTS](../AGENTS.md) 和更近目录规则，保护所有未提交文件。源码地图提供方向和边界，不赋予提交、推送、发布或访问真实账号的额外授权。
