import { AsyncLocalStorage } from 'node:async_hooks'
import { createHash, randomUUID } from 'node:crypto'
import { logForDiagnosticsNoPII } from '../diagLogs.js'

type Context = { source: 'headless' | 'internal_git'; phase: 'startup' | 'delisting' | 'cache_reload'; trace_id: string; market_id?: string }
const context = new AsyncLocalStorage<Context>()
export function getPluginDiagnosticContext(): Partial<Context> { return context.getStore() ?? {} }
export function marketplaceDiagnosticId(name: string): string { return createHash('sha256').update(name).digest('hex').slice(0, 16) }
export function pluginDiagnosticEvent(level: 'info' | 'warn', event: string, data: Record<string, unknown> = {}): void {
  logForDiagnosticsNoPII(level, event, { ...getPluginDiagnosticContext(), pid: process.pid, ppid: process.ppid, ...data })
}
export async function withPluginDiagnosticScope<T>(phase: Context['phase'], fn: () => Promise<T>, market_id?: string): Promise<T> {
  const parent = context.getStore()
  const value: Context = { source: parent?.source ?? (phase === 'startup' ? 'headless' : 'internal_git'), trace_id: parent?.trace_id ?? randomUUID(), phase, ...(market_id ? { market_id } : parent?.market_id ? { market_id: parent.market_id } : {}) }
  return context.run(value, fn)
}
