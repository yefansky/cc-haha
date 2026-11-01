import path from 'node:path'
import os from 'node:os'
import { clearAppManagedPortableEnv, getAppMode } from '../electron/services/appMode'

// Only installed wrappers opt in. The normal server/native CLI and standalone
// headless entry keep their existing configuration selection.
export function applyDesktopHeadlessConfig(
  args: string[], appRoot: string, env: NodeJS.ProcessEnv = process.env,
  home = env.USERPROFILE || env.HOME || os.homedir(),
): string[] {
  if (args[0] !== '--desktop-config') return args
  const next = args.slice(1)
  clearAppManagedPortableEnv(env)
  const userData = path.join(env.APPDATA || path.join(home, 'AppData', 'Roaming'), 'Claude Code Haha')
  const selected = getAppMode({
    getPath: name => name === 'home' ? home : name === 'userData' ? userData : path.resolve(appRoot, '../../../../Claude Code Haha.exe'),
  }, env)
  env.CLAUDE_CONFIG_DIR = selected.activeConfigDir
  return next
}
