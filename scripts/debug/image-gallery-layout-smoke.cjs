// Isolated real-Electron gallery layout and input smoke. Uses no user profile,
// application entry point, server sidecar, gateway, provider or user image.
const fs = require('node:fs')
const path = require('node:path')
const { pathToFileURL } = require('node:url')
const { spawn } = require('node:child_process')

async function run() {
  const repo = path.resolve(__dirname, '../..')
  const root = path.resolve(process.env.IMAGE_GALLERY_SMOKE_DIR || path.join(repo, '..', '_cc-haha-image-gallery-smoke'))
  fs.mkdirSync(root, { recursive: true })
  if (!fs.existsSync(path.join(root, 'node_modules'))) fs.symlinkSync(path.join(repo, 'desktop/node_modules'), path.join(root, 'node_modules'), 'junction')
  const moduleUrl = (name) => '/@fs/' + path.join(root, name).replaceAll('\\', '/')
  fs.writeFileSync(path.join(root, 'fixture.html'), '<script type="module">import RefreshRuntime from "/@react-refresh"; RefreshRuntime.injectIntoGlobalHook(window); window.$RefreshReg$=()=>{}; window.$RefreshSig$=()=>type=>type; window.__vite_plugin_react_preamble_installed__=true;</script><div id="root"></div><script type="module" src="' + moduleUrl('fixture.tsx') + '"></script>')
  fs.writeFileSync(path.join(root, 'fixture.tsx'), `
import React, { useState } from 'react'
import { createRoot } from 'react-dom/client'
import { ImageGalleryModal } from '/@fs/${path.join(repo, 'desktop/src/components/chat/ImageGalleryModal.tsx').replaceAll('\\', '/')}'
import '/src/theme/globals.css'
const images = [1,2,3].map(i => ({name: 'image-' + i, src: 'data:image/svg+xml,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="1600" height="1000"><rect width="1600" height="1000" fill="teal"/></svg>')}))
function Fixture() {
  const [open,setOpen] = useState(true); const [index,setIndex] = useState(0)
  window.reopen = () => setOpen(true)
  window.galleryReady = true
  return <ImageGalleryModal open={open} images={images} activeIndex={index} onClose={() => setOpen(false)} onSelect={setIndex}/>
}
document.documentElement.dataset.theme = 'light'
createRoot(document.getElementById('root')).render(<Fixture />)
`)
  const { createServer } = await import(pathToFileURL(path.join(repo, 'desktop/node_modules/vite/dist/node/index.js')).href)
  const server = await createServer({ root: path.join(repo, 'desktop'), configFile: path.join(repo, 'desktop/vite.config.ts'), server: { port: 0, strictPort: false, fs: { allow: [repo, root] } } })
  await server.listen()
  const port = server.httpServer.address().port
  const url = `http://127.0.0.1:${port}${moduleUrl('fixture.html')}`
  fs.writeFileSync(path.join(root, 'main.cjs'), `
const {app,BrowserWindow} = require('electron')
const fs = require('node:fs'); const path = require('node:path')
const root = ${JSON.stringify(root)}
app.setPath('userData', path.join(root,'profile'))
app.setPath('sessionData', path.join(root,'session'))
app.setPath('crashDumps', path.join(root,'crashes'))
const pause = ms => new Promise(r=>setTimeout(r,ms))
const assert = (value,msg) => {if(!value) throw new Error(msg)}
app.on('window-all-closed',()=>{})
app.whenReady().then(async()=>{
 const results=[]
 try {
  for(const config of [
   {name:'maximized',width:1780,height:944,maximize:true},
   {name:'small-window',width:800,height:600},
   {name:'phone',width:390,height:844},
   {name:'compact-phone',width:320,height:480},
   {name:'zoom-150',width:1280,height:800,zoom:1.5},
  ]) {
   const win = new BrowserWindow({show:false,width:config.width,height:config.height,useContentSize:true,titleBarStyle:'hidden',titleBarOverlay:{height:52},webPreferences:{contextIsolation:true}})
   if(config.maximize) win.maximize()
   const wc = win.webContents
   wc.on('console-message',(_event,...args)=>console.log('renderer',...args))
   await win.loadURL(${JSON.stringify(url)})
   wc.setZoomFactor(config.zoom||1)
   for(let attempt=0;attempt<100;attempt++){if(await wc.executeJavaScript('!!document.querySelector("[role=dialog]")'))break;await pause(100)}
   await pause(300)
   const geometry=await wc.executeJavaScript(${JSON.stringify(`(()=>{
    const dialog=document.querySelector('[role=dialog]');const close=dialog.querySelector('button');
    const rect=r=>({x:r.x,y:r.y,width:r.width,height:r.height,right:r.right,bottom:r.bottom});
    const d=dialog.getBoundingClientRect(), c=close.getBoundingClientRect();
    const p=document.createElement('div');p.style.height='env(titlebar-area-height, 0px)';document.body.append(p);const nativeHeight=p.getBoundingClientRect().height;p.remove();
    return {viewport:{width:innerWidth,height:innerHeight},dialog:rect(d),close:rect(c),nativeHeight,hit:document.elementFromPoint(c.x+c.width/2,c.y+c.height/2)===close||close.contains(document.elementFromPoint(c.x+c.width/2,c.y+c.height/2)),appRegion:getComputedStyle(close).webkitAppRegion,stageRegion:getComputedStyle(dialog.parentElement).webkitAppRegion}
   })()`)} )
   console.log(config.name,JSON.stringify(geometry))
   assert(geometry.dialog.y>=63,'top safety margin: '+config.name)
   assert(geometry.close.y>=Math.max(geometry.nativeHeight,52/(config.zoom||1)),'native control overlap: '+config.name)
   // Windows fractional display scale rounds innerWidth to an integer DIP.
   assert(geometry.dialog.x>=15 && geometry.dialog.right<=geometry.viewport.width-15,'horizontal margins: '+config.name)
   assert(geometry.dialog.bottom<=geometry.viewport.height-15,'bottom margin: '+config.name)
   assert(geometry.close.bottom<=geometry.dialog.bottom && geometry.hit,'close control hit: '+config.name)
   assert(geometry.appRegion==='no-drag' && geometry.stageRegion==='no-drag','native drag interference: '+config.name)
   const zoom=wc.getZoomFactor(),x=Math.round((geometry.close.x+geometry.close.width/2)*zoom),y=Math.round((geometry.close.y+geometry.close.height/2)*zoom)
   fs.writeFileSync(path.join(root,config.name+'.png'),(await wc.capturePage()).toPNG())
   wc.sendInputEvent({type:'mouseDown',x,y,button:'left',clickCount:1});wc.sendInputEvent({type:'mouseUp',x,y,button:'left',clickCount:1});await pause(80)
   assert(await wc.executeJavaScript('!document.querySelector("[role=dialog]")'),'mouse close failed: '+config.name)
   await wc.executeJavaScript('window.reopen()');await pause(60)
   wc.sendInputEvent({type:'keyDown',keyCode:'ESC'});wc.sendInputEvent({type:'keyUp',keyCode:'ESC'});await pause(60)
   assert(await wc.executeJavaScript('!document.querySelector("[role=dialog]")'),'Escape close failed: '+config.name)
   await wc.executeJavaScript('window.reopen()');await pause(60)
   wc.sendInputEvent({type:'mouseDown',x:8,y:Math.round((geometry.dialog.y+80)*zoom),button:'left',clickCount:1});wc.sendInputEvent({type:'mouseUp',x:8,y:Math.round((geometry.dialog.y+80)*zoom),button:'left',clickCount:1});await pause(60)
   assert(await wc.executeJavaScript('!document.querySelector("[role=dialog]")'),'backdrop close failed: '+config.name)
   results.push({...config,geometry,mouseClose:true,escapeClose:true,backdropClose:true});win.destroy()
  }
  fs.writeFileSync(path.join(root,'result.json'),JSON.stringify(results,null,2));app.exit(0)
 }catch(error){fs.writeFileSync(path.join(root,'error.txt'),String(error.stack||error));app.exit(1)}
})
`)
  const env = { ...process.env, TEMP: root, TMP: root }
  delete env.ELECTRON_RUN_AS_NODE
  try {
    const child = spawn(require('../../desktop/node_modules/electron'), [path.join(root, 'main.cjs')], { env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    let log = ''
    for (const stream of [child.stdout, child.stderr]) stream.on('data', data => { log += data })
    const timeout = setTimeout(() => child.kill(), 55_000)
    const code = await new Promise((resolve, reject) => { child.on('error', reject); child.on('exit', resolve) })
    clearTimeout(timeout)
    fs.writeFileSync(path.join(root, 'electron.log'), log)
    if (code !== 0) throw new Error(fs.existsSync(path.join(root, 'error.txt')) ? fs.readFileSync(path.join(root, 'error.txt'), 'utf8') : log)
    console.log(fs.readFileSync(path.join(root, 'result.json'), 'utf8'))
    console.log('Evidence: ' + root)
  } finally { await server.close() }
}
run().catch(error => { console.error(error); process.exitCode = 1 })
