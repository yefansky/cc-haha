import type { ShellCommand } from '../../utils/ShellCommand.js'

export const FOREGROUND_BLOCKING_BUDGET_MS = 15_000

type ForegroundAutoBackgroundPolicy = {
  isMainThread: boolean
  runInBackground: boolean | undefined
  backgroundTasksDisabled: boolean
  autoBackgroundAllowed: boolean
}

type TimeoutHandle = {
  unref(): unknown
}

type TimeoutScheduler = (
  callback: () => void,
  delayMs: number,
) => TimeoutHandle

export function shouldScheduleForegroundAutoBackground(
  policy: ForegroundAutoBackgroundPolicy,
): boolean {
  return (
    policy.isMainThread &&
    policy.runInBackground !== true &&
    !policy.backgroundTasksDisabled &&
    policy.autoBackgroundAllowed
  )
}

export function scheduleForegroundAutoBackground({
  command,
  policy,
  background,
  delayMs = FOREGROUND_BLOCKING_BUDGET_MS,
  schedule = setTimeout,
}: {
  command: Pick<ShellCommand, 'status'>
  policy: ForegroundAutoBackgroundPolicy
  background: () => void
  delayMs?: number
  schedule?: TimeoutScheduler
}): boolean {
  if (!shouldScheduleForegroundAutoBackground(policy)) return false

  schedule(() => {
    if (command.status === 'running') background()
  }, delayMs).unref()
  return true
}
