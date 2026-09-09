import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { stageGatewayBundle } from './stage-gateway-bundle'

const desktopRoot = path.resolve(import.meta.dir, '..')
const clientRoot = path.join(desktopRoot, 'gateway-client')
const target = `${process.platform}-${process.arch}`
const expectedTriple: Record<string, string> = {
  'win32-x64': 'x86_64-pc-windows-msvc', 'win32-arm64': 'aarch64-pc-windows-msvc',
  'linux-x64': 'x86_64-unknown-linux-gnu', 'linux-arm64': 'aarch64-unknown-linux-gnu',
  'darwin-x64': 'x86_64-apple-darwin', 'darwin-arm64': 'aarch64-apple-darwin',
}
const triple = process.env.SIDECAR_TARGET_TRIPLE || process.env.TAURI_ENV_TARGET_TRIPLE || process.env.CARGO_BUILD_TARGET
if (!expectedTriple[target] || (triple && triple !== expectedTriple[target])) {
  throw new Error('Gateway client requires a native platform/architecture build')
}
const work = await mkdtemp(path.join(tmpdir(), 'cc-haha-client-stage-'))
try {
  const python = process.env.CC_HAHA_BUILD_PYTHON || (process.platform === 'win32' ? 'python' : 'python3')
  const result = Bun.spawn([python, path.join(clientRoot, 'build.py'), '--target', target, '--output-dir', work], {
    cwd: clientRoot, stdout: 'inherit', stderr: 'inherit', windowsHide: true,
  })
  if (await result.exited !== 0) throw new Error('Gateway client native build failed')
  const source = path.join(work, 'cc-haha-tunnel')
  const manifest = JSON.parse(await readFile(path.join(source, 'manifest.json'), 'utf8'))
  if (manifest.target !== target || manifest.format !== 'pyinstaller-onedir' || manifest.component !== 'tunnel') {
    throw new Error('Gateway client build target mismatch')
  }
  const destination = path.join(desktopRoot, 'src-tauri', 'binaries', 'gateway-tunnel', target)
  await stageGatewayBundle(source, destination)
  console.log(`[build-gateway-tunnel] staged ${destination}`)
} finally {
  await rm(work, { recursive: true, force: true })
}
