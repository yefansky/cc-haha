import { describe, expect, test } from 'bun:test'
import {
  FOREGROUND_BLOCKING_BUDGET_MS,
  scheduleForegroundAutoBackground,
} from './foregroundAutoBackground.js'

type CommandStatus = 'running' | 'backgrounded' | 'completed' | 'killed'

function createHarness(status: CommandStatus = 'running') {
  const command = { status }
  let scheduledCallback: (() => void) | undefined
  let scheduledDelay: number | undefined
  let unrefCount = 0
  let backgroundCount = 0

  const scheduled = scheduleForegroundAutoBackground({
    command,
    policy: {
      isMainThread: true,
      runInBackground: undefined,
      backgroundTasksDisabled: false,
      autoBackgroundAllowed: true,
    },
    background() {
      backgroundCount += 1
      command.status = 'backgrounded'
    },
    schedule(callback, delayMs) {
      scheduledCallback = callback
      scheduledDelay = delayMs
      return {
        unref() {
          unrefCount += 1
        },
      }
    },
  })

  return {
    command,
    scheduled,
    runScheduledCallback: () => scheduledCallback?.(),
    getScheduledDelay: () => scheduledDelay,
    getUnrefCount: () => unrefCount,
    getBackgroundCount: () => backgroundCount,
  }
}

describe('foreground auto-background policy', () => {
  test('moves a still-running main-thread command to the background after the budget', () => {
    const harness = createHarness()

    expect(harness.scheduled).toBe(true)
    expect(harness.getScheduledDelay()).toBe(FOREGROUND_BLOCKING_BUDGET_MS)
    expect(harness.getUnrefCount()).toBe(1)

    harness.runScheduledCallback()

    expect(harness.command.status).toBe('backgrounded')
    expect(harness.getBackgroundCount()).toBe(1)
  })

  test('does not background a command that completed before the budget', () => {
    const harness = createHarness()
    harness.command.status = 'completed'

    harness.runScheduledCallback()

    expect(harness.getBackgroundCount()).toBe(0)
  })

  test.each([
    ['sub-agent command', { isMainThread: false }],
    ['explicit background command', { runInBackground: true }],
    ['background tasks disabled', { backgroundTasksDisabled: true }],
    ['command excluded from automatic backgrounding', { autoBackgroundAllowed: false }],
  ] as const)('does not schedule a %s', (_name, override) => {
    const scheduled = scheduleForegroundAutoBackground({
      command: { status: 'running' },
      policy: {
        isMainThread: true,
        runInBackground: undefined,
        backgroundTasksDisabled: false,
        autoBackgroundAllowed: true,
        ...override,
      },
      background() {
        throw new Error('background must not run')
      },
      schedule() {
        throw new Error('timer must not be scheduled')
      },
    })

    expect(scheduled).toBe(false)
  })
})
