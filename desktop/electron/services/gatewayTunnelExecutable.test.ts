import { afterEach, expect, test } from 'vitest'
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { resolveGatewayTunnelExecutable } from './gatewayTunnelExecutable'

const dirs: string[] = []
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })
function fixture(packaged = false) {
  const dir = mkdtempSync(path.join(tmpdir(), 'gateway-executable-'))
  dirs.push(dir)
  const desktopRoot = packaged ? path.join(dir, 'app.asar') : dir
  const bundle = path.join(packaged ? `${desktopRoot}.unpacked` : dir, 'src-tauri', 'binaries', 'gateway-tunnel', `${process.platform}-${process.arch}`)
  mkdirSync(bundle, { recursive: true })
  const executable = path.join(bundle, process.platform === 'win32' ? 'cc-haha-tunnel.exe' : 'cc-haha-tunnel')
  writeFileSync(executable, 'fixture')
  chmodSync(executable, 0o755)
  return { desktopRoot, executable }
}
test('resolves staged native executable', () => {
  const f = fixture()
  expect(resolveGatewayTunnelExecutable({ desktopRoot: f.desktopRoot, isPackaged: false, env: {} })).toBe(f.executable)
})
test('packaged resolver ignores hostile development override', () => {
  const f = fixture(true)
  expect(resolveGatewayTunnelExecutable({ desktopRoot: f.desktopRoot, isPackaged: true, env: { CC_HAHA_GATEWAY_CLIENT_PATH: 'missing' } })).toBe(f.executable)
})
test('development explicit absolute override works', () => {
  const f = fixture()
  expect(resolveGatewayTunnelExecutable({ desktopRoot: 'missing', isPackaged: false, env: { CC_HAHA_GATEWAY_CLIENT_PATH: f.executable } })).toBe(f.executable)
})
test('missing, relative override and directory fail closed without path echo', () => {
  const f = fixture()
  for (const override of ['private-relative', f.desktopRoot, path.join(f.desktopRoot, 'absent')]) {
    expect(() => resolveGatewayTunnelExecutable({ desktopRoot: f.desktopRoot, isPackaged: false, env: { CC_HAHA_GATEWAY_CLIENT_PATH: override } })).toThrow('CLIENT_NOT_INSTALLED')
  }
  rmSync(f.executable)
  expect(() => resolveGatewayTunnelExecutable({ desktopRoot: f.desktopRoot, isPackaged: true, env: {} })).toThrow('CLIENT_NOT_INSTALLED')
})
