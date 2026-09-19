// Isolated real-Electron preview smoke. Does not load the application entrypoint,
// user sessions, sidecar or a provider. Retains its temporary evidence directory.
const path = require('node:path')
const fs = require('node:fs')
const os = require('node:os')
const { spawn } = require('node:child_process')
const { build } = require('../../desktop/node_modules/esbuild')

async function run() {
  const repo = path.resolve(__dirname, '../..')
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-haha-file-open-smoke-'))
  const main = path.join(root, 'main.cjs')
  await build({
    entryPoints: [path.join(__dirname, 'file-open-preview-smoke-main.ts')],
    outfile: main, bundle: true, platform: 'node', format: 'cjs', external: ['electron'],
  })
  await build({
    stdin: {
      contents: "import { resolveNativeLocalPreview } from './desktop/src/lib/localBrowserFile'; globalThis.resolveNativeLocalPreview = resolveNativeLocalPreview;",
      resolveDir: repo, loader: 'ts',
    },
    outfile: path.join(root, 'resolver.js'), bundle: true, platform: 'browser', format: 'iife',
    define: { 'import.meta.env': '{}' },
  })
  const executable = require('../../desktop/node_modules/electron')
  const env = { ...process.env, FILE_OPEN_SMOKE_DIR: root }
  delete env.ELECTRON_RUN_AS_NODE
  const child = spawn(executable, [main], { env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
  let output = ''
  for (const stream of [child.stdout, child.stderr]) stream.on('data', (data) => { output += data; process.stdout.write(data) })
  const timeout = setTimeout(() => child.kill(), 45_000)
  const code = await new Promise((resolve, reject) => { child.on('error', reject); child.on('exit', resolve) })
  clearTimeout(timeout)
  fs.writeFileSync(path.join(root, 'electron.log'), output)
  console.log(`Evidence: ${root}`)
  if (code !== 0) throw new Error(`Isolated Electron smoke exited with ${code}`)
  console.log(fs.readFileSync(path.join(root, 'result.json'), 'utf8'))
}
run().catch((error) => { console.error(error); process.exitCode = 1 })
