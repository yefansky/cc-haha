import { app, BrowserWindow, WebContentsView, ipcMain, net } from 'electron'
import { mkdir, readFile, writeFile, symlink } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import assert from 'node:assert/strict'
import { LocalPreviewAccess } from '../../desktop/electron/services/localPreviewAccess'
import { ElectronPreviewService } from '../../desktop/electron/services/preview'
import { createPreviewSessionPartition, configurePreviewSessionPermissions } from '../../desktop/electron/services/previewSession'
import { installPreviewNavigationGuards } from '../../desktop/electron/services/navigationGuards'

const root = process.env.FILE_OPEN_SMOKE_DIR!
if (!root) throw new Error('Use file-open-preview-smoke.cjs to create an isolated directory')
app.setPath('userData', join(root, 'user-data'))
app.setPath('sessionData', join(root, 'session-data'))
app.disableHardwareAcceleration()

async function main() {
  const site = join(root, '中文 site')
  const outside = join(root, 'unrelated')
  await mkdir(site, { recursive: true }); await mkdir(outside)
  const html = join(site, '周报 #1.html')
  const secret = join(outside, 'secret.js')
  await writeFile(html, '<!doctype html><meta charset="utf-8"><title>中文预览成功</title><h1>中文文件预览</h1><script src="./asset.js"></script><script src="../unrelated/secret.js"></script>')
  await writeFile(join(site, 'asset.js'), 'window.fixtureAsset = "同目录资源成功"')
  await writeFile(secret, 'window.leakedSecret = true')
  await writeFile(join(root, 'driver.html'), '<!doctype html><title>isolated smoke driver</title>')
  await writeFile(join(root, 'preview-agent.js'), 'void 0')
  await symlink(outside, join(site, 'linked'), process.platform === 'win32' ? 'junction' : 'dir')
  await app.whenReady()

  const driver = new BrowserWindow({ show: false, webPreferences: { nodeIntegration: true, contextIsolation: false } })
  const parent = new BrowserWindow({ show: false })
  const access = new LocalPreviewAccess()
  const deniedRequests: string[] = []
  let view: WebContentsView
  let ipcCalls = 0
  const service = new ElectronPreviewService({
    previewScriptPath: join(root, 'preview-agent.js'),
    createView: () => {
      view = new WebContentsView({ webPreferences: {
        partition: createPreviewSessionPartition(), contextIsolation: true, nodeIntegration: false, sandbox: true,
      } })
      configurePreviewSessionPermissions(view.webContents.session)
      installPreviewNavigationGuards(view.webContents, { openExternal: async () => { throw new Error('External navigation is forbidden in smoke') } })
      view.webContents.session.protocol.handle('file', async (request) => {
        if (!await access.allows(request.url)) {
          deniedRequests.push(request.url)
          return new Response('outside opened document directory', { status: 403 })
        }
        return net.fetch(request, { bypassCustomProtocol: true })
      })
      return Object.assign(view, { authorizeLocalFile: (url: string) => access.authorize(url) })
    },
  })
  ipcMain.handle('file-open-smoke:open', async (_event, url) => {
    ipcCalls++
    await service.open(parent, url, { x: 0, y: 0, width: 640, height: 480 })
    return view!.webContents.executeJavaScript('({ title: document.title, text: document.querySelector("h1").textContent, asset: window.fixtureAsset, leaked: !!window.leakedSecret })')
  })
  await driver.loadFile(join(root, 'driver.html'))
  await driver.webContents.executeJavaScript(await readFile(join(root, 'resolver.js'), 'utf8'))
  const server = 'http://127.0.0.1:18787'
  const nativeStyle = process.platform === 'win32' ? 'windows' : 'posix'
  async function open(url: string, workDir?: string) {
    return driver.webContents.executeJavaScript(`(async () => {
      try {
        const url = globalThis.resolveNativeLocalPreview(${JSON.stringify(url)}, ${JSON.stringify(server)}, ${JSON.stringify(workDir) ?? 'undefined'}, ${JSON.stringify(nativeStyle)});
        return { ok: true, result: await require('electron').ipcRenderer.invoke('file-open-smoke:open', url) };
      } catch (error) { return { ok: false, error: error.message }; }
    })()`)
  }
  assert.equal(await access.allows(pathToFileURL(html).href), false)
  const valid = await open(`${server}/preview-fs/s/${encodeURIComponent('周报 #1.html')}`, site)
  assert.equal(valid.ok, true)
  assert.deepEqual(valid.result, { title: '中文预览成功', text: '中文文件预览', asset: '同目录资源成功', leaked: false })
  const afterValid = ipcCalls
  const invalidInputs = [
    `${server}/local-file/看板/a.html`, `${server}/preview-fs/s//看板/a.html`,
    'file:///看板/a.html', `${server}/preview-fs/s/C%3Aa.html`,
    `${server}/preview-fs/s/docs%2Fpage.html`, 'file://server/share/page.html',
  ]
  const invalid = []
  // These are specifically Windows path semantics, even on a POSIX CI runner.
  for (const url of invalidInputs) {
    const result = await open(url, 'G:/smoke')
    assert.equal(result.ok, false, url)
    assert.match(result.error, /缺少盘符|盘符相对路径|编码后的路径分隔符|Network file paths/)
    invalid.push({ url, ...result })
  }
  if (process.platform === 'win32') {
    const result = await open('file:///看板/a.html')
    assert.equal(result.ok, false)
    assert.match(result.error, /缺少盘符/)
    invalid.push({ url: 'file:///看板/a.html (without workDir)', ...result })
  }
  assert.equal(ipcCalls, afterValid, 'Invalid paths must fail before native IPC')
  const boundaries = {
    siblingDenied: !await access.allows(pathToFileURL(secret).href),
    junctionEscapeDenied: !await access.allows(pathToFileURL(join(site, 'linked', 'secret.js')).href),
    missingDenied: !await access.allows(pathToFileURL(join(site, 'missing.html')).href),
    uncDenied: !await access.allows('file://server/share/page.html'),
    siblingRequestBlockedByProtocol: deniedRequests.some((url) => url === pathToFileURL(secret).href),
  }
  for (const [name, passed] of Object.entries(boundaries)) assert.equal(passed, true, name)
  await writeFile(join(root, 'result.json'), JSON.stringify({
    passed: true, electron: process.versions.electron, platform: process.platform,
    valid, invalid, ipcCalls, boundaries, deniedRequests,
    scope: 'Production renderer resolver + actual IPC + production ElectronPreviewService and LocalPreviewAccess, hidden isolated windows; no application/session/provider startup.',
  }, null, 2))
  driver.destroy(); parent.destroy()
  app.exit(0)
}
main().catch(async (error) => {
  await writeFile(join(root, 'failure.txt'), error?.stack ?? String(error))
  console.error(error)
  app.exit(1)
})
