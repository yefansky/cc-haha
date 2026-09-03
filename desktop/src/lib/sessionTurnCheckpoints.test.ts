import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  getTurnCheckpoints: vi.fn(),
}))

vi.mock('../api/sessions', () => ({
  sessionsApi: {
    getTurnCheckpoints: mocks.getTurnCheckpoints,
  },
}))

import {
  clearSessionTurnCheckpointCache,
  getSessionTurnCheckpointSnapshot,
  loadSessionTurnCheckpoints,
} from './sessionTurnCheckpoints'

describe('sessionTurnCheckpoints', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    clearSessionTurnCheckpointCache()
  })

  it('shares one in-flight checkpoint request between session surfaces', async () => {
    let resolve!: (value: unknown) => void
    mocks.getTurnCheckpoints.mockReturnValue(new Promise((next) => { resolve = next }))

    const transcriptRequest = loadSessionTurnCheckpoints('session-1')
    const composerRequest = loadSessionTurnCheckpoints('session-1')

    expect(transcriptRequest).toBe(composerRequest)
    expect(mocks.getTurnCheckpoints).toHaveBeenCalledTimes(1)

    resolve({
      checkpoints: [{
        target: { targetUserMessageId: 'turn-1', userMessageIndex: 0 },
        code: { available: true, filesChanged: ['src/app.ts'] },
      }],
    })

    await expect(transcriptRequest).resolves.toHaveLength(1)
    expect(getSessionTurnCheckpointSnapshot('session-1')).toMatchObject({
      loading: false,
      error: null,
      checkpoints: [{ code: { filesChanged: ['src/app.ts'] } }],
    })
  })

  it('filters malformed checkpoint records before publishing them', async () => {
    mocks.getTurnCheckpoints.mockResolvedValue({
      checkpoints: [
        { target: null, code: null },
        {
          target: { targetUserMessageId: 'turn-2', userMessageIndex: 1 },
          code: { available: true, filesChanged: ['src/valid.ts'] },
        },
      ],
    })

    await loadSessionTurnCheckpoints('session-2')

    expect(getSessionTurnCheckpointSnapshot('session-2').checkpoints).toHaveLength(1)
  })
})
