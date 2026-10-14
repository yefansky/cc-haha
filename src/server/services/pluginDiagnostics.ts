import { createHash } from 'node:crypto'
import type { DiagnosticEvent } from './diagnosticsService.js'

const summaries: Record<string, string> = {
  plugin_startup_started: '会话启动：开始插件协调（独立于自动更新开关）',
  plugin_startup_completed: '会话启动：插件协调返回结果（请结合失败事件判断）',
  plugin_startup_failed: '会话启动：插件协调发生异常',
  plugin_delisting_started: '会话启动：开始插件下架检查',
  plugin_delisting_inventory: '插件下架检查：已登记市场与已安装插件数量',
  plugin_delisting_completed: '插件下架检查结束',
  plugin_delisting_market_started: '插件下架检查：读取市场',
  plugin_delisting_market_completed: '插件下架检查：市场读取完成',
  plugin_delisting_market_failed: '插件下架检查：市场读取失败',
  plugin_market_cache_hit: '插件市场：本地缓存读取成功',
  plugin_market_cache_miss: '插件市场：缓存缺失或不可用，将尝试远端读取',
  plugin_market_refetch_started: '插件市场：开始远端重新拉取',
  plugin_market_refetch_failed: '插件市场：远端重新拉取失败',
  plugin_market_refetch_completed: '插件市场：远端重新拉取完成',
  git_process_started: '内部 Git 调用：准备启动（详情显示来源和认证策略）',
  git_process_spawned: '内部 Git 调用：子进程信息',
  git_process_completed: '内部 Git 调用：返回结果',
  plugin_background_started: '会话启动触发后台插件维护',
  plugin_background_completed: '后台插件维护结束（个别市场可能失败，请查看前序事件）',
  plugin_background_failed: '后台插件维护异常结束',
  plugin_background_skipped: '跳过后台插件维护：冷却期、其他进程正在更新或已禁用',
  plugin_background_markets: '检查启用自动更新的插件市场数量',
  plugin_marketplace_completed: '插件市场刷新成功',
  plugin_marketplace_failed: '插件市场刷新失败',
  plugin_mirror_failed: '官方市场镜像刷新失败（详情包含 HTTP、网络或文件系统错误类别）',
  plugin_mirror_completed: '官方市场镜像下载成功',
  plugin_mirror_git_fallback: '官方市场镜像失败，回退到 Git（禁止交互登录）',
  plugin_cache_preserved: '后台更新失败，保留现有插件缓存',
  plugin_git_started: '后台插件维护执行 Git（禁止交互登录）',
  plugin_git_completed: '后台插件维护 Git 返回结果',
}
const numericKeys = ['pid', 'ppid', 'child_pid', 'count', 'installed_count', 'code', 'duration_ms', 'retry_after_ms']
const enumValues: Record<string, string[]> = {
  operation: ['clone', 'pull', 'fetch', 'ls-remote', 'checkout', 'sparse-checkout', 'rev-parse', 'config', 'other'],
  reason: ['busy', 'recent', 'disabled', 'missing', 'invalid'],
  source: ['headless', 'internal_git', 'background_update'],
  phase: ['startup', 'delisting', 'cache_reload'],
  remote_kind: ['github', 'other_remote', 'implicit'],
  credential_policy: ['non_interactive', 'inherited'],
  source_type: ['github', 'git', 'url', 'file', 'directory', 'settings'],
  errorCategory: ['none', 'authentication', 'network', 'git', 'spawn'],
}

// Only these specific no-PII CLI events enter the desktop timeline. Never
// expose arbitrary CLI data, raw Git arguments, stderr, URLs or environment.
export function parsePluginDiagnosticEvents(raw: string): DiagnosticEvent[] {
  const events = new Map<string, DiagnosticEvent>()
  for (const line of raw.split('\n')) {
    try {
      const entry = JSON.parse(line)
      if (!Object.hasOwn(summaries, entry.event) || typeof entry.timestamp !== 'string' || !Number.isFinite(Date.parse(entry.timestamp))) continue
      const data = entry.data ?? {}
      const details: Record<string, unknown> = {}
      for (const key of numericKeys) if (typeof data[key] === 'number' && Number.isFinite(data[key])) details[key] = data[key]
      for (const [key, values] of Object.entries(enumValues)) if (values.includes(data[key])) details[key] = data[key]
      if (entry.event === 'plugin_mirror_failed' && typeof data.errorCategory === 'string' && /^(?:http_[1-5][0-9]{2}|fs_E[A-Z]{1,20}|fs_other|timeout|network|zip_parse|empty_latest|other)$/.test(data.errorCategory)) details.errorCategory = data.errorCategory
      for (const key of ['trace_id', 'git_operation_id']) if (typeof data[key] === 'string' && /^[a-f0-9-]{36}$/i.test(data[key])) details[key] = data[key]
      if (typeof data.market_id === 'string' && /^[a-f0-9]{16}$/.test(data.market_id)) details.market_id = data.market_id
      for (const key of ['changed', 'force_remove']) if (typeof data[key] === 'boolean') details[key] = data[key]
      if (data.interactive === false) details.interactive = false
      const id = 'cli-' + createHash('sha256').update(line).digest('hex').slice(0, 32)
      events.set(id, { id, timestamp: entry.timestamp, type: entry.event, severity: entry.level === 'warn' || entry.level === 'error' ? entry.level : 'info', summary: summaries[entry.event], details, ...(typeof data.sessionId === 'string' && /^[a-f0-9-]{36}$/i.test(data.sessionId) ? { sessionId: data.sessionId } : {}) })
    } catch { /* A writer may still be appending the final line. */ }
  }
  return [...events.values()]
}
