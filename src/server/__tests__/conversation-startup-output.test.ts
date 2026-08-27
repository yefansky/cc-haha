import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from 'bun:test'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  ConversationService,
  ConversationStartupError,
} from '../services/conversationService.js'
import { sessionService } from '../services/sessionService.js'

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

describe('ConversationService startup output', () => {
  let service: ConversationService
  let tmpDir: string
  let sdkServer: ReturnType<typeof Bun.serve> | null
  const originalEnv = new Map<string, string | undefined>()
  const envKeys = [
    'CLAUDE_CLI_PATH',
    'CLAUDE_CONFIG_DIR',
    'CC_HAHA_DISABLE_TERMINAL_SHELL_ENV',
    'MOCK_SDK_STARTUP_STDOUT',
  ]

  beforeEach(async () => {
    service = new ConversationService()
    sdkServer = null
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cc-haha-startup-output-'))
    for (const key of envKeys) {
      originalEnv.set(key, process.env[key])
    }

    process.env.CLAUDE_CLI_PATH = fileURLToPath(
      new URL('./fixtures/mock-startup-exit-cli.ts', import.meta.url),
    )
    process.env.CLAUDE_CONFIG_DIR = tmpDir
    process.env.CC_HAHA_DISABLE_TERMINAL_SHELL_ENV = '1'
    process.env.MOCK_SDK_STARTUP_STDOUT = 'provider rejected request: invalid model id'
  })

  afterEach(async () => {
    await service.stopAllSessionsAndWait(1_000)
    sdkServer?.stop(true)
    mock.restore()
    for (const key of envKeys) {
      const value = originalEnv.get(key)
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    originalEnv.clear()
    await fs.rm(tmpDir, { recursive: true, force: true })
  })

  test('includes CLI stdout when the process exits before SDK messages', async () => {
    let startupError: unknown

    try {
      await service.startSession(
        `startup-output-${crypto.randomUUID()}`,
        tmpDir,
        'ws://127.0.0.1:1/sdk/startup-output?token=test-token',
      )
    } catch (error) {
      startupError = error
    }

    expect(startupError).toBeInstanceOf(ConversationStartupError)
    expect(startupError).toMatchObject({ code: 'CLI_START_FAILED' })
    expect((startupError as Error).message).toContain(
      'CLI exited during startup (code 1): provider rejected request: invalid model id',
    )
  }, 10_000)

  test('confirms replacement shutdown only after process exit and output drain both settle', async () => {
    const sessionId = `replacement-stop-confirmed-${crypto.randomUUID()}`
    expect(await service.stopSessionForReplacementAndConfirm(`${sessionId}-missing`, 1))
      .toBe('not_running')
    const exited = deferred<number>()
    const outputDrain = deferred<void>()
    const kill = mock(() => {})
    ;(service as any).sessions.set(sessionId, {
      proc: { exited: exited.promise, kill },
      pendingControlRequests: new Map(),
      outputDrain: outputDrain.promise,
    })

    const stopping = service.stopSessionForReplacementAndConfirm(sessionId, 100)
    await Promise.resolve()
    exited.resolve(0)
    outputDrain.resolve()

    expect(await stopping).toBe('stopped')
    expect(kill).toHaveBeenCalledWith('SIGTERM')
  })

  test('latches an unconfirmed replacement shutdown until exit and output drain both settle', async () => {
    const sessionId = `replacement-stop-unconfirmed-${crypto.randomUUID()}`
    const exited = deferred<number>()
    const outputDrain = deferred<void>()
    exited.resolve(0)
    ;(service as any).sessions.set(sessionId, {
      proc: { exited: exited.promise, kill: mock(() => {}) },
      pendingControlRequests: new Map(),
      outputDrain: outputDrain.promise,
    })
    spyOn(sessionService, 'getSessionLaunchInfo').mockResolvedValue(null)

    expect(await service.stopSessionForReplacementAndConfirm(sessionId, 1)).toBe('unconfirmed')
    expect(await service.stopSessionForReplacementAndConfirm(sessionId, 1)).toBe('unconfirmed')
    await expect(service.startSession(
      sessionId,
      path.join(tmpDir, 'does-not-exist'),
      'ws://127.0.0.1:1/sdk/replacement-stop?token=test-token',
    )).rejects.toMatchObject({ code: 'CLI_SHUTDOWN_UNCONFIRMED' })

    outputDrain.resolve()
    await Promise.resolve()
    await Promise.resolve()
    expect(await service.stopSessionForReplacementAndConfirm(sessionId, 1)).toBe('not_running')
    await expect(service.startSession(
      sessionId,
      path.join(tmpDir, 'does-not-exist'),
      'ws://127.0.0.1:1/sdk/replacement-stop?token=test-token',
    )).rejects.toMatchObject({ code: 'WORKDIR_INVALID' })
  })

  test('keeps a rejected replacement output drain fail-closed', async () => {
    const sessionId = `replacement-stop-drain-rejected-${crypto.randomUUID()}`
    ;(service as any).sessions.set(sessionId, {
      proc: { exited: Promise.resolve(0), kill: mock(() => {}) },
      pendingControlRequests: new Map(),
      outputDrain: Promise.reject(new Error('output reader failed')),
    })

    expect(await service.stopSessionForReplacementAndConfirm(sessionId, 1)).toBe('unconfirmed')
    expect(await service.stopSessionForReplacementAndConfirm(sessionId, 1)).toBe('unconfirmed')
    await expect(service.startSession(
      sessionId,
      path.join(tmpDir, 'does-not-exist'),
      'ws://127.0.0.1:1/sdk/replacement-stop?token=test-token',
    )).rejects.toMatchObject({ code: 'CLI_SHUTDOWN_UNCONFIRMED' })
  })

  test('preserves an existing transcript during replacement runtime startup', async () => {
    const sessionId = `replacement-preserve-transcript-${crypto.randomUUID()}`
    process.env.CLAUDE_CLI_PATH = fileURLToPath(
      new URL('./fixtures/mock-sdk-cli.ts', import.meta.url),
    )
    spyOn(sessionService, 'getSessionLaunchInfo').mockResolvedValue({
      transcriptMessageCount: 0,
      customTitle: null,
    } as any)
    const clearTranscript = spyOn(sessionService, 'clearSessionTranscript').mockResolvedValue()
    const appendMetadata = spyOn(sessionService, 'appendSessionMetadata').mockResolvedValue()

    sdkServer = Bun.serve<{ sessionId: string }>({
      port: 0,
      fetch(request, server) {
        const sessionIdFromPath = new URL(request.url).pathname.split('/').at(-1) ?? ''
        if (server.upgrade(request, { data: { sessionId: sessionIdFromPath } })) return
        return new Response('upgrade required', { status: 426 })
      },
      websocket: {
        open(socket) {
          service.attachSdkConnection(socket.data.sessionId, socket)
        },
        message() {},
      },
    })

    await service.startSession(
      sessionId,
      tmpDir,
      `ws://127.0.0.1:${sdkServer.port}/sdk/${sessionId}?token=test-token`,
      { transcriptStartupPolicy: 'preserve_existing' },
    )

    expect(clearTranscript).not.toHaveBeenCalled()
    expect(appendMetadata).not.toHaveBeenCalled()
  }, 10_000)
})
