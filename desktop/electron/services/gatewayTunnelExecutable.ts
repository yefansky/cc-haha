import { accessSync, constants, realpathSync, statSync } from 'node:fs'
import path from 'node:path'

export function resolveGatewayTunnelExecutable({ desktopRoot, isPackaged, env = process.env }: {
  desktopRoot: string
  isPackaged: boolean
  env?: NodeJS.ProcessEnv
}): string {
  try {
    const override = !isPackaged ? env.CC_HAHA_GATEWAY_CLIENT_PATH : undefined
    if (override && !path.isAbsolute(override)) throw new Error()
    const root = path.resolve(desktopRoot).replace(/([\\/])app\.asar(?=[\\/]|$)/, '$1app.asar.unpacked')
    const bundle = path.join(root, 'src-tauri', 'binaries', 'gateway-tunnel', `${process.platform}-${process.arch}`)
    const candidate = override || path.join(bundle, process.platform === 'win32' ? 'cc-haha-tunnel.exe' : 'cc-haha-tunnel')
    const resolved = realpathSync(candidate)
    if (!override) {
      const relative = path.relative(realpathSync(bundle), resolved)
      if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error()
    }
    if (!statSync(resolved).isFile()) throw new Error()
    accessSync(resolved, process.platform === 'win32' ? constants.R_OK : constants.X_OK)
    return resolved
  } catch {
    throw Object.assign(new Error('CLIENT_NOT_INSTALLED'), { code: 'CLIENT_NOT_INSTALLED' })
  }
}
