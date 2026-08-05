import { describe, expect, it } from 'vitest'
import {
  PRODUCT_AUTHORS,
  PRODUCT_ISSUES_URL,
  PRODUCT_RELEASES_URL,
  PRODUCT_REPOSITORY,
  PRODUCT_UPDATE_FEED,
} from './productBranding'

describe('product branding', () => {
  it('uses the customized fork for repository, releases, and issue feedback', () => {
    expect(PRODUCT_REPOSITORY).toBe('https://github.com/yefansky/cc-haha')
    expect(PRODUCT_RELEASES_URL).toBe(`${PRODUCT_REPOSITORY}/releases`)
    expect(PRODUCT_ISSUES_URL).toBe(`${PRODUCT_REPOSITORY}/issues`)
    expect(PRODUCT_UPDATE_FEED).toEqual({ provider: 'github', owner: 'yefansky', repo: 'cc-haha' })
  })

  it('credits both the original author and the customization author', () => {
    expect(PRODUCT_AUTHORS).toEqual([
      { name: '程序员阿江-Relakkes', url: 'https://github.com/NanmiCoder', role: 'original' },
      { name: '叶帆', url: 'https://github.com/yefansky', role: 'customization' },
    ])
  })
})
