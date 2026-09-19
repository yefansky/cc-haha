import { describe, expect, it } from 'vitest'
import { remoteBrowserDestination } from './browserLinkPreference'

describe('browser destination per device', () => {
  const web = 'https://example.com/page'
  const auth = 'https://openapi.wps.cn/oauth2/auth?client_id=example&response_type=code&redirect_uri=http%3A%2F%2Flocalhost%3A3000%2Fcallback'
  it('uses the existing desktop browser profile in auto mode', () => {
    expect(remoteBrowserDestination(web, true)).toBe('system')
    expect(remoteBrowserDestination(auth, true)).toBe('system')
  })
  it('keeps remote H5 website previews in app but sends OAuth to the current browser', () => {
    expect(remoteBrowserDestination(web, false)).toBe('in-app')
    expect(remoteBrowserDestination(auth, false)).toBe('system')
  })
  it.each([true, false])('honors an explicit device preference (desktop=%s)', (desktop) => {
    expect(remoteBrowserDestination(web, desktop, 'in-app')).toBe('in-app')
    expect(remoteBrowserDestination(web, desktop, 'system')).toBe('system')
  })
})
