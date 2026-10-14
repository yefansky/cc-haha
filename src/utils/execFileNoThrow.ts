import { randomUUID } from 'node:crypto'
import { getPluginDiagnosticContext, pluginDiagnosticEvent } from './plugins/diagnosticTrace.js'
// This file represents useful wrappers over node:child_process
// These wrappers ease error handling and cross-platform compatbility
// By using execa, Windows automatically gets shell escaping + BAT / CMD handling

import { type ExecaError, execa } from 'execa'
import { getCwd } from '../utils/cwd.js'
import { logError } from './log.js'
import { logForDiagnosticsNoPII } from './diagLogs.js'
import { backgroundPluginGitOptions } from './plugins/backgroundUpdate.js'

export { execSyncWithDefaults_DEPRECATED } from './execFileNoThrowPortable.js'

const MS_IN_SECOND = 1000
const SECONDS_IN_MINUTE = 60

type ExecFileOptions = {
  abortSignal?: AbortSignal
  timeout?: number
  preserveOutputOnError?: boolean
  // Setting useCwd=false avoids circular dependencies during initialization
  // getCwd() -> PersistentShell -> logEvent() -> execFileNoThrow
  useCwd?: boolean
  env?: NodeJS.ProcessEnv
  stdin?: 'ignore' | 'inherit' | 'pipe'
  input?: string
}

export function execFileNoThrow(
  file: string,
  args: string[],
  options: ExecFileOptions = {
    timeout: 10 * SECONDS_IN_MINUTE * MS_IN_SECOND,
    preserveOutputOnError: true,
    useCwd: true,
  },
): Promise<{ stdout: string; stderr: string; code: number; error?: string }> {
  return execFileNoThrowWithCwd(file, args, {
    abortSignal: options.abortSignal,
    timeout: options.timeout,
    preserveOutputOnError: options.preserveOutputOnError,
    cwd: options.useCwd ? getCwd() : undefined,
    env: options.env,
    stdin: options.stdin,
    input: options.input,
  })
}

type ExecFileWithCwdOptions = {
  abortSignal?: AbortSignal
  timeout?: number
  preserveOutputOnError?: boolean
  maxBuffer?: number
  cwd?: string
  env?: NodeJS.ProcessEnv
  shell?: boolean | string | undefined
  stdin?: 'ignore' | 'inherit' | 'pipe'
  input?: string
}

type ExecaResultWithError = {
  shortMessage?: string
  signal?: string
}

/**
 * Extracts a human-readable error message from an execa result.
 *
 * Priority order:
 * 1. shortMessage - execa's human-readable error (e.g., "Command failed with exit code 1: ...")
 *    This is preferred because it already includes signal info when a process is killed,
 *    making it more informative than just the signal name.
 * 2. signal - the signal that killed the process (e.g., "SIGTERM")
 * 3. errorCode - fallback to just the numeric exit code
 */
function getErrorMessage(
  result: ExecaResultWithError,
  errorCode: number,
): string {
  if (result.shortMessage) {
    return result.shortMessage
  }
  if (typeof result.signal === 'string') {
    return result.signal
  }
  return String(errorCode)
}

/**
 * execFile, but always resolves (never throws)
 */
export function execFileNoThrowWithCwd(
  file: string,
  args: string[],
  {
    abortSignal,
    timeout: finalTimeout = 10 * SECONDS_IN_MINUTE * MS_IN_SECOND,
    preserveOutputOnError: finalPreserveOutput = true,
    cwd: finalCwd,
    env: finalEnv,
    maxBuffer,
    shell,
    stdin: finalStdin,
    input: finalInput,
  }: ExecFileWithCwdOptions = {
    timeout: 10 * SECONDS_IN_MINUTE * MS_IN_SECOND,
    preserveOutputOnError: true,
    maxBuffer: 1_000_000,
  },
): Promise<{ stdout: string; stderr: string; code: number; error?: string }> {
  return new Promise(resolve => {
    // Use execa for cross-platform .bat/.cmd compatibility on Windows
    const backgroundOptions = backgroundPluginGitOptions(file, args, finalEnv)
    const backgroundGit = backgroundOptions.args !== args
    const operation = args.find(arg => ['clone', 'pull', 'fetch', 'ls-remote', 'checkout', 'sparse-checkout', 'rev-parse', 'config'].includes(arg)) ?? 'other'
    const started = Date.now()
    const isGit = /^git(?:\.(?:exe|cmd|bat))?$/i.test(file.replaceAll('\\', '/').split('/').at(-1) ?? '')
    const traceGit = isGit && (backgroundGit || Boolean(getPluginDiagnosticContext().trace_id) || ['clone', 'fetch', 'pull', 'ls-remote'].includes(operation))
    const git_operation_id = randomUUID()
    const gitData = { operation, git_operation_id, source: backgroundGit ? 'background_update' : getPluginDiagnosticContext().source ?? 'internal_git', credential_policy: backgroundGit ? 'non_interactive' : 'inherited', remote_kind: args.some(arg => /(?:https?:\/\/|git@)github\.com[/:]/i.test(arg)) ? 'github' : args.some(arg => /^(?:https?:\/\/|ssh:\/\/|git@)/i.test(arg)) ? 'other_remote' : 'implicit' }
    if (traceGit) pluginDiagnosticEvent('info', 'git_process_started', gitData)
    if (backgroundGit) logForDiagnosticsNoPII('info', 'plugin_git_started', { operation, interactive: false, pid: process.pid })
    const child = execa(file, backgroundOptions.args, {
      maxBuffer,
      signal: abortSignal,
      timeout: finalTimeout,
      cwd: finalCwd,
      env: backgroundOptions.env,
      shell,
      stdin: finalStdin,
      input: finalInput,
      reject: false, // Don't throw on non-zero exit codes
    })
    if (traceGit) pluginDiagnosticEvent('info', 'git_process_spawned', { ...gitData, ...(child.pid ? { child_pid: child.pid } : {}) })
    child.then(result => {
        if (traceGit) {
          const stderr = result.stderr || ''
          const errorCategory = !result.failed ? 'none' : /authentication|username|credential|401|403|permission denied/i.test(stderr) ? 'authentication' : /resolve host|connect|timeout|timed out|SSL|certificate/i.test(stderr) ? 'network' : 'git'
          pluginDiagnosticEvent(result.failed ? 'warn' : 'info', 'git_process_completed', { ...gitData, child_pid: child.pid, code: result.exitCode ?? (result.failed ? 1 : 0), errorCategory, duration_ms: Date.now() - started })
        }
        if (backgroundGit) {
          const stderr = result.stderr || ''
          const errorCategory = !result.failed ? 'none' : /authentication|username|credential|401|403|permission denied/i.test(stderr) ? 'authentication' : /resolve host|connect|timeout|timed out|SSL|certificate/i.test(stderr) ? 'network' : 'git'
          logForDiagnosticsNoPII(result.failed ? 'warn' : 'info', 'plugin_git_completed', { operation, code: result.exitCode ?? (result.failed ? 1 : 0), errorCategory, duration_ms: Date.now() - started, interactive: false, pid: process.pid })
        }
        if (result.failed) {
          if (finalPreserveOutput) {
            const errorCode = result.exitCode ?? 1
            void resolve({
              stdout: result.stdout || '',
              stderr: result.stderr || '',
              code: errorCode,
              error: getErrorMessage(
                result as unknown as ExecaResultWithError,
                errorCode,
              ),
            })
          } else {
            void resolve({ stdout: '', stderr: '', code: result.exitCode ?? 1 })
          }
        } else {
          void resolve({
            stdout: result.stdout,
            stderr: result.stderr,
            code: 0,
          })
        }
      })
      .catch((error: ExecaError) => {
        if (backgroundGit) logForDiagnosticsNoPII('warn', 'plugin_git_completed', { operation, code: 1, errorCategory: 'spawn', duration_ms: Date.now() - started, interactive: false, pid: process.pid })
        if (traceGit) pluginDiagnosticEvent('warn', 'git_process_completed', { ...gitData, child_pid: child.pid, code: 1, errorCategory: 'spawn', duration_ms: Date.now() - started })
        logError(error)
        void resolve({ stdout: '', stderr: '', code: 1 })
      })
  })
}
