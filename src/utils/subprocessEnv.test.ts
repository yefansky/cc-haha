import { afterEach, describe, expect, test } from 'bun:test'

import { subprocessEnv } from './subprocessEnv.js'

const originalLocalAccessToken = process.env.CC_HAHA_LOCAL_ACCESS_TOKEN
const originalScrubFlag = process.env.CLAUDE_CODE_SUBPROCESS_ENV_SCRUB
const originalGatewayToken = process.env.CC_HAHA_GATEWAY_FORWARDER_TOKEN

afterEach(() => {
  if (originalGatewayToken === undefined) delete process.env.CC_HAHA_GATEWAY_FORWARDER_TOKEN
  else process.env.CC_HAHA_GATEWAY_FORWARDER_TOKEN = originalGatewayToken
  if (originalLocalAccessToken === undefined) {
    delete process.env.CC_HAHA_LOCAL_ACCESS_TOKEN
  } else {
    process.env.CC_HAHA_LOCAL_ACCESS_TOKEN = originalLocalAccessToken
  }

  if (originalScrubFlag === undefined) {
    delete process.env.CLAUDE_CODE_SUBPROCESS_ENV_SCRUB
  } else {
    process.env.CLAUDE_CODE_SUBPROCESS_ENV_SCRUB = originalScrubFlag
  }
})

describe('subprocessEnv', () => {
  test('never forwards the gateway capability to an actual tool child', async () => {
    process.env.CC_HAHA_GATEWAY_FORWARDER_TOKEN = 'isolated-test-forwarder'
    delete process.env.CLAUDE_CODE_SUBPROCESS_ENV_SCRUB
    const env = subprocessEnv()
    const child = Bun.spawn([process.execPath, '-e', 'process.stdout.write(String(process.env.CC_HAHA_GATEWAY_FORWARDER_TOKEN === undefined))'], {
      env: {
        SystemRoot: process.env.SystemRoot,
        ...(env.CC_HAHA_GATEWAY_FORWARDER_TOKEN !== undefined
          ? { CC_HAHA_GATEWAY_FORWARDER_TOKEN: env.CC_HAHA_GATEWAY_FORWARDER_TOKEN }
          : {}),
      }, stdout: 'pipe', stderr: 'pipe',
    })
    expect(await new Response(child.stdout).text()).toBe('true')
    expect(await child.exited).toBe(0)
    expect(process.env.CC_HAHA_GATEWAY_FORWARDER_TOKEN).toBe('isolated-test-forwarder')
  })
  test('never exposes the desktop local access token to tool subprocesses', () => {
    process.env.CC_HAHA_LOCAL_ACCESS_TOKEN = 'desktop-local-secret'
    delete process.env.CLAUDE_CODE_SUBPROCESS_ENV_SCRUB

    const env = subprocessEnv()

    expect(env.CC_HAHA_LOCAL_ACCESS_TOKEN).toBeUndefined()
    expect(process.env.CC_HAHA_LOCAL_ACCESS_TOKEN).toBe('desktop-local-secret')
  })
})
