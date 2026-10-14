import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execute = promisify(execFile)
const safeNames = new Set(['git.exe', 'git-credential-manager.exe', 'git-credential-manager-core.exe', 'git-credential-manager-ui.exe', 'gitcredentialmanager.ui.exe', 'ssh.exe', 'claude.exe', 'claude code haha.exe', 'claude-sidecar-x86_64-pc-windows-msvc.exe', 'bun.exe', 'node.exe', 'cmd.exe', 'powershell.exe', 'pwsh.exe', 'conhost.exe', 'openconsole.exe', 'windowsterminal.exe', 'explorer.exe', 'services.exe', 'svchost.exe'])
const script = '$ErrorActionPreference="Stop"; @(Get-CimInstance Win32_Process | Select-Object Name,ProcessId,ParentProcessId,CreationDate) | ConvertTo-Json -Depth 3 -Compress'

type ProcessRecord = { name: string; pid: number; ppid: number; startedAt?: string }
export function projectProcessTree(raw: unknown): ProcessRecord[] {
  if (!Array.isArray(raw)) throw new Error('Invalid process snapshot')
  const records = new Map<number, ProcessRecord>()
  for (const value of raw.slice(0, 10000)) {
    if (!value || typeof value !== 'object') continue
    const row = value as Record<string, unknown>
    if (typeof row.ProcessId !== 'number' || !Number.isInteger(row.ProcessId) || row.ProcessId < 0 || typeof row.ParentProcessId !== 'number' || !Number.isInteger(row.ParentProcessId) || row.ParentProcessId < 0) continue
    const name = typeof row.Name === 'string' ? row.Name.toLowerCase() : ''
    const started = typeof row.CreationDate === 'string' && /^\d{4}-\d{2}-\d{2}T[0-9:.+-]+Z?$/.test(row.CreationDate) ? row.CreationDate : undefined
    records.set(row.ProcessId, { name: safeNames.has(name) ? name : 'other_process', pid: row.ProcessId, ppid: row.ParentProcessId, ...(started ? { startedAt: started } : {}) })
  }
  const selected = new Map<number, ProcessRecord>()
  for (const record of records.values()) {
    if (!/^(?:git(?:-credential-manager(?:-core|-ui)?)?\.exe|gitcredentialmanager\.ui\.exe|claude(?: code haha|-sidecar-x86_64-pc-windows-msvc)?\.exe|bun\.exe)$/.test(record.name)) continue
    let current: ProcessRecord | undefined = record
    for (let depth = 0; current && depth < 8 && selected.size < 300; depth++) {
      if (selected.has(current.pid)) break
      selected.set(current.pid, current)
      current = records.get(current.ppid)
    }
  }
  // Include helper descendants even when their executable name is unknown;
  // expose only the fixed 'other_process' category for those names.
  for (let pass = 0; pass < 4 && selected.size < 300; pass++) {
    let added = false
    for (const record of records.values()) {
      if (selected.size >= 300) break
      const parent = selected.get(record.ppid)
      if (!selected.has(record.pid) && parent && parent.name !== 'explorer.exe' && parent.name !== 'services.exe' && parent.name !== 'svchost.exe') {
        selected.set(record.pid, record)
        added = true
      }
    }
    if (!added) break
  }
  return [...selected.values()].sort((a, b) => a.pid - b.pid)
}

export async function collectProcessDiagnostics(
  platform = process.platform,
  run: () => Promise<string> = async () => (await execute('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true, timeout: 5000, maxBuffer: 2_000_000 })).stdout,
): Promise<Record<string, unknown>> {
  const capturedAt = new Date().toISOString()
  if (platform !== 'win32') return { capturedAt, status: 'unsupported_platform', processes: [] }
  try {
    const processes = projectProcessTree(JSON.parse(await run()))
    return { capturedAt, status: 'captured', processes, limitations: ['Snapshot only; exited processes may be absent. Parent PIDs can be reused.', 'No command lines, executable paths, credentials or environment variables are collected.'] }
  } catch {
    return { capturedAt, status: 'unavailable', processes: [], reason: 'process_query_failed_or_timed_out' }
  }
}
