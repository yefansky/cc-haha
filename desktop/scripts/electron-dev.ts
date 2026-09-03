import { spawn } from 'node:child_process'
import { existsSync, readdirSync, statSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createServer, type ViteDevServer } from 'vite'

export const DEFAULT_RENDERER_URL = 'http://localhost:1420'
export const LOCAL_NO_PROXY_ENTRIES = ['localhost', '127.0.0.1', '::1']

export function mergeNoProxy(existing: string | undefined, required = LOCAL_NO_PROXY_ENTRIES) {
  const entries = new Set(
    (existing ?? '')
      .split(',')
      .map(entry => entry.trim())
      .filter(Boolean),
  )
  for (const entry of required) entries.add(entry)
  return Array.from(entries).join(',')
}

export function createElectronDevEnv(env: NodeJS.ProcessEnv = process.env) {
  const rendererUrl = env.ELECTRON_RENDERER_URL ?? DEFAULT_RENDERER_URL
  const noProxy = mergeNoProxy(env.NO_PROXY ?? env.no_proxy)
  return {
    ...env,
    ELECTRON_RENDERER_URL: rendererUrl,
    NO_PROXY: noProxy,
    no_proxy: noProxy,
  }
}

export function resolveElectronExecutable(desktopRoot: string, platform = process.platform) {
  const candidates = platform === 'win32'
    ? [path.join(desktopRoot, 'node_modules', 'electron', 'dist', 'electron.exe')]
    : platform === 'darwin'
      ? [path.join(desktopRoot, 'node_modules', 'electron', 'dist', 'Electron.app', 'Contents', 'MacOS', 'Electron')]
      : [path.join(desktopRoot, 'node_modules', 'electron', 'dist', 'electron')]

  const electronPath = candidates.find(candidate => existsSync(candidate))
  if (!electronPath) {
    throw new Error(`Electron executable not found under ${path.join(desktopRoot, 'node_modules', 'electron', 'dist')}. Run "cd desktop && bun install" first.`)
  }
  return electronPath
}

export function resolveSidecarExecutable(
  desktopRoot: string,
  platform = process.platform,
  arch = process.arch,
) {
  const triple = platform === 'win32'
    ? arch === 'arm64' ? 'aarch64-pc-windows-msvc' : 'x86_64-pc-windows-msvc'
    : platform === 'darwin'
      ? arch === 'arm64' ? 'aarch64-apple-darwin' : 'x86_64-apple-darwin'
      : arch === 'arm64' ? 'aarch64-unknown-linux-gnu' : 'x86_64-unknown-linux-gnu'
  return path.join(
    desktopRoot,
    'src-tauri',
    'binaries',
    `claude-sidecar-${triple}${platform === 'win32' ? '.exe' : ''}`,
  )
}

function latestSourceMtime(target: string): number {
  if (!existsSync(target)) return 0
  const stats = statSync(target)
  if (!stats.isDirectory()) return stats.mtimeMs
  let latest = 0
  for (const entry of readdirSync(target, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === '.git' || entry.name.includes('.test.')) continue
    latest = Math.max(latest, latestSourceMtime(path.join(target, entry.name)))
  }
  return latest
}

export function isSidecarBuildStale(
  desktopRoot: string,
  platform = process.platform,
  arch = process.arch,
) {
  const executable = resolveSidecarExecutable(desktopRoot, platform, arch)
  if (!existsSync(executable)) return true
  const repoRoot = path.resolve(desktopRoot, '..')
  const sourceMtime = Math.max(
    latestSourceMtime(path.join(repoRoot, 'src')),
    latestSourceMtime(path.join(desktopRoot, 'sidecars')),
    latestSourceMtime(path.join(desktopRoot, 'scripts', 'build-sidecars.ts')),
    latestSourceMtime(path.join(repoRoot, 'package.json')),
    latestSourceMtime(path.join(desktopRoot, 'package.json')),
  )
  return sourceMtime > statSync(executable).mtimeMs
}

export function resolveSidecarBuildCommand(runtimeExecutable = process.execPath) {
  return {
    command: runtimeExecutable,
    args: ['run', 'build:sidecars'],
  }
}

async function ensureFreshSidecar(desktopRoot: string) {
  if (!isSidecarBuildStale(desktopRoot)) return
  console.log('[electron-dev] Server sources changed; rebuilding the development sidecar...')
  const buildCommand = resolveSidecarBuildCommand()
  const build = spawn(buildCommand.command, buildCommand.args, {
    cwd: desktopRoot,
    env: process.env,
    stdio: 'inherit',
    windowsHide: true,
  })
  const exitCode = await new Promise<number>((resolve, reject) => {
    build.once('error', reject)
    build.once('exit', code => resolve(code ?? 0))
  })
  if (exitCode !== 0) throw new Error(`Development sidecar build failed (exit ${exitCode})`)
}

async function waitForRenderer(rendererUrl: string) {
  const deadline = Date.now() + 30_000
  while (Date.now() < deadline) {
    try {
      const response = await fetch(rendererUrl)
      if (response.ok) return
    } catch {
      await Bun.sleep(250)
    }
  }
  throw new Error(`Timed out waiting for Vite renderer at ${rendererUrl}`)
}

async function startVite(desktopRoot: string) {
  const server = await createServer({
    root: desktopRoot,
    configFile: path.join(desktopRoot, 'vite.config.ts'),
  })
  await server.listen()
  server.printUrls()
  return server
}

async function closeVite(server: ViteDevServer) {
  await server.close().catch(() => undefined)
}

async function main() {
  const desktopRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
  const childEnv = createElectronDevEnv()
  const rendererUrl = childEnv.ELECTRON_RENDERER_URL
  process.env.NO_PROXY = childEnv.NO_PROXY
  process.env.no_proxy = childEnv.no_proxy

  await ensureFreshSidecar(desktopRoot)
  const vite = await startVite(desktopRoot)

  async function stopVite() {
    await closeVite(vite)
  }

  process.on('SIGINT', () => {
    void stopVite().finally(() => process.exit(130))
  })
  process.on('SIGTERM', () => {
    void stopVite().finally(() => process.exit(143))
  })

  await waitForRenderer(rendererUrl)

  const electron = spawn(resolveElectronExecutable(desktopRoot), ['./electron-dist/main.cjs'], {
    cwd: desktopRoot,
    env: childEnv,
    stdio: 'inherit',
    windowsHide: true,
  })

  const exitCode = await new Promise<number>((resolve, reject) => {
    electron.once('error', reject)
    electron.once('exit', code => resolve(code ?? 0))
  })
  await stopVite()
  process.exit(exitCode)
}

if (import.meta.main) {
  await main()
}
