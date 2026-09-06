import { timingSafeEqual } from 'node:crypto'

// Consume the private launch capability before any child process or diagnostics
// can inherit process.env. It is never a settings or renderer-accessible token.
const desktopCapability = process.env.CC_HAHA_DESKTOP_INTEGRATION_TOKEN
delete process.env.CC_HAHA_DESKTOP_INTEGRATION_TOKEN

export function matchesDesktopCapability(actual: string | null, expected = desktopCapability): boolean {
  if (!expected || !actual || actual.length > 256) return false
  const a = Buffer.from(actual), b = Buffer.from(expected)
  return a.length === b.length && timingSafeEqual(a, b)
}
