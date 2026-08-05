import { describe, expect, it, vi } from 'vitest'
import { configureProductUpdateFeed } from './updateSource'

describe('product update source', () => {
  it('forces electron-updater to use the customized fork release feed', () => {
    const updater = { setFeedURL: vi.fn() }

    configureProductUpdateFeed(updater)

    expect(updater.setFeedURL).toHaveBeenCalledWith({
      provider: 'github',
      owner: 'yefansky',
      repo: 'cc-haha',
    })
  })
})
