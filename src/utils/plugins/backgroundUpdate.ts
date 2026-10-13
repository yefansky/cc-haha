import { AsyncLocalStorage } from 'node:async_hooks'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { logForDiagnosticsNoPII } from '../diagLogs.js'
import { lock } from '../lockfile.js'

const backgroundUpdate = new AsyncLocalStorage<boolean>()
export const PLUGIN_UPDATE_INTERVAL_MS = 60 * 60 * 1000

export function isBackgroundPluginUpdate(): boolean {
  return backgroundUpdate.getStore() === true
}

// Only automatic plugin maintenance inherits this policy. Explicit Git and
// manual plugin operations remain outside this async context.
export function backgroundPluginGitOptions(file: string, args: string[], env?: NodeJS.ProcessEnv) {
  if (!isBackgroundPluginUpdate() || !/^git(?:\.(?:exe|cmd|bat))?$/i.test(basename(file.replaceAll('\\', '/')))) {
    return { args, env }
  }
  return {
    args: ['-c', 'credential.helper=', ...args],
    env: {
      ...env,
      GIT_TERMINAL_PROMPT: '0',
      GIT_ASKPASS: '',
      GCM_INTERACTIVE: 'never',
      GCM_GUI_PROMPT: '0',
      GIT_SSH_COMMAND: 'ssh -o BatchMode=yes -o StrictHostKeyChecking=yes',
    },
  }
}

// New conversations start independent CLI processes using the same cache.
// Lock across processes, and persist attempts (including failures) so a broken
// remote does not get retried on every conversation. Manual updates bypass this.
export async function runBackgroundPluginUpdate(
  directory: string,
  update: () => Promise<void>,
  now = Date.now(),
): Promise<'updated' | 'busy' | 'recent'> {
  await mkdir(directory, { recursive: true })
  const statePath = join(directory, '.background-update-attempt')
  let release: () => Promise<void>
  try {
    release = await lock(statePath, { realpath: false, retries: 0, stale: 300_000, update: 30_000 })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ELOCKED') {
      logForDiagnosticsNoPII('info', 'plugin_background_skipped', { reason: 'busy', pid: process.pid })
      return 'busy'
    }
    throw error
  }
  try {
    const previous = await readFile(statePath, 'utf8').then(Number, error => {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      return NaN
    })
    if (Number.isFinite(previous) && now >= previous && now - previous < PLUGIN_UPDATE_INTERVAL_MS) {
      logForDiagnosticsNoPII('info', 'plugin_background_skipped', { reason: 'recent', retry_after_ms: PLUGIN_UPDATE_INTERVAL_MS - (now - previous), pid: process.pid })
      return 'recent'
    }
    await writeFile(statePath, String(now), 'utf8')
    logForDiagnosticsNoPII('info', 'plugin_background_started', { pid: process.pid })
    const started = Date.now()
    try {
      await backgroundUpdate.run(true, update)
      logForDiagnosticsNoPII('info', 'plugin_background_completed', { duration_ms: Date.now() - started, pid: process.pid })
    } catch (error) {
      logForDiagnosticsNoPII('warn', 'plugin_background_failed', { pid: process.pid })
      throw error
    }
    return 'updated'
  } finally {
    await release()
  }
}
