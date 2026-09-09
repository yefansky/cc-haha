import { randomBytes, timingSafeEqual } from 'node:crypto'
import { dirname, join } from 'node:path'
import { GatewayCredentials } from '../../desktop/electron/services/gatewayCredentials.js'
import { GatewayTunnelRuntime } from '../../desktop/electron/services/gatewayTunnelRuntime.js'
import { resolveGatewayTunnelExecutable } from '../../desktop/electron/services/gatewayTunnelExecutable.js'

const ROOT = '/_local/gateway'
const COOKIE = 'cc_haha_local_setup'
const TTL = 12 * 60 * 60 * 1000
const secret = () => randomBytes(32).toString('hex')
const equal = (a: unknown, b: string) => typeof a === 'string' && Buffer.byteLength(a) === Buffer.byteLength(b) && timingSafeEqual(Buffer.from(a), Buffer.from(b))
const loopback = (ip: string | null) => ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(ip ?? '')

type Runtime = Pick<GatewayTunnelRuntime, 'getConfig' | 'getStatus' | 'saveConfig' | 'testConnection' | 'start' | 'stop' | 'clearKey' | 'disposeSync'>
type Session = { csrf: string; expires: number }

/** This control plane is deliberately separate from H5 and the remote forwarder. */
export class LocalGatewaySetup {
  private sessions = new Map<string, Session>()
  private failures = 0
  private blockedUntil = 0
  private runtime?: Runtime

  constructor(private options: {
    origin: () => string
    token: () => string | undefined
    runtime?: () => Runtime
    localOnly?: boolean
  }) {}

  disposeSync() { this.runtime?.disposeSync(); this.sessions.clear() }

  private getRuntime(): Runtime {
    if (this.runtime) return this.runtime
    if (this.options.runtime) return this.runtime = this.options.runtime()
    const directory = process.env.CLAUDE_CONFIG_DIR
    if (!directory) throw new Error('STORAGE_ERROR')
    const credentials = new GatewayCredentials({ directory: join(directory, 'local-gateway'), safeStorage: {
      // A plain Bun process has no OS credential-store bridge. Never persist a key in plaintext.
      isEncryptionAvailable: () => false,
      encryptString: () => { throw new Error('STORAGE_ERROR') },
      decryptString: () => { throw new Error('STORAGE_ERROR') },
    } })
    const forwarderToken = process.env.CC_HAHA_GATEWAY_FORWARDER_TOKEN || secret()
    process.env.CC_HAHA_GATEWAY_FORWARDER_TOKEN = forwarderToken
    this.runtime = new GatewayTunnelRuntime({ credentials,
      resolveLocal: async () => ({ upstreamUrl: this.options.origin(), forwarderToken }),
      resolveExecutable: () => resolveGatewayTunnelExecutable({
        desktopRoot: join(dirname(import.meta.dir), '..', 'desktop'), isPackaged: false,
      }),
    })
    return this.runtime
  }

  private response(value: unknown, status = 200, extra: Record<string, string> = {}) {
    return Response.json(value, { status, headers: { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', ...extra } })
  }

  async handle(req: Request, clientAddress: string | null): Promise<Response | null> {
    const url = new URL(req.url)
    if (url.pathname !== ROOT && !url.pathname.startsWith(ROOT + '/')) return null
    const expected = new URL(this.options.origin())
    const token = this.options.token()
    if (!token || token.length < 32) return this.response({ error: 'LOCAL_SETUP_DISABLED' }, 404)
    if (!loopback(clientAddress) || url.origin !== expected.origin || req.headers.get('host') !== expected.host ||
      ['x-cc-haha-gateway-forwarder', 'forwarded', 'x-forwarded-for', 'x-forwarded-host', 'x-forwarded-proto'].some(name => req.headers.has(name))) {
      return this.response({ error: 'LOCAL_ONLY' }, 403)
    }
    if (req.headers.has('origin') && req.headers.get('origin') !== expected.origin) return this.response({ error: 'ORIGIN_REJECTED' }, 403)
    if (req.headers.get('sec-fetch-site') === 'cross-site') return this.response({ error: 'ORIGIN_REJECTED' }, 403)
    for (const [key, session] of this.sessions) if (session.expires <= Date.now()) this.sessions.delete(key)
    const cookie = (req.headers.get('cookie') ?? '').split(';').map(value => value.trim()).find(value => value.startsWith(COOKIE + '='))?.slice(COOKIE.length + 1)
    const session = cookie ? this.sessions.get(cookie) : undefined
    if (req.method === 'GET' && [ROOT, ROOT + '/'].includes(url.pathname)) {
      const nonce = secret()
      return new Response(page(nonce), { headers: {
        'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store',
        'Content-Security-Policy': `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; connect-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'`,
        'X-Frame-Options': 'DENY', 'Referrer-Policy': 'no-referrer', 'X-Content-Type-Options': 'nosniff',
      } })
    }
    if (req.method === 'GET' && url.pathname === ROOT + '/state') {
      if (!session) return this.response({ error: 'LOGIN_REQUIRED' }, 401)
      try { return this.response({ config: await this.getRuntime().getConfig(), status: await this.getRuntime().getStatus(), csrf: session.csrf, localOnly: !!this.options.localOnly }) }
      catch { return this.response({ error: 'STORAGE_ERROR' }, 500) }
    }
    if (req.method !== 'POST') return this.response({ error: 'METHOD_NOT_ALLOWED' }, 405)
    if (req.headers.get('origin') !== expected.origin) return this.response({ error: 'ORIGIN_REJECTED' }, 403)
    if (req.headers.get('content-type')?.split(';')[0] !== 'application/json') return this.response({ error: 'JSON_REQUIRED' }, 415)
    let body: Record<string, unknown>
    try {
      const reader = req.body?.getReader()
      if (!reader) throw 0
      let text = '', size = 0
      const decoder = new TextDecoder()
      while (true) {
        const item = await reader.read(); if (item.done) break
        size += item.value.length
        if (size > 8192) { await reader.cancel(); return this.response({ error: 'BODY_TOO_LARGE' }, 413) }
        text += decoder.decode(item.value, { stream: true })
      }
      text += decoder.decode()
      body = JSON.parse(text)
      if (!body || typeof body !== 'object' || Array.isArray(body)) throw 0
    } catch { return this.response({ error: 'INVALID_JSON' }, 400) }
    if (url.pathname === ROOT + '/login') {
      if (Date.now() < this.blockedUntil) return this.response({ error: 'LOGIN_COOLDOWN' }, 429)
      if (!equal(body.token, token)) {
        if (++this.failures >= 5) { this.blockedUntil = Date.now() + 60_000; this.failures = 0 }
        return this.response({ error: 'INVALID_CREDENTIAL' }, 401)
      }
      this.failures = 0
      if (cookie) this.sessions.delete(cookie)
      if (this.sessions.size >= 32) this.sessions.delete(this.sessions.keys().next().value!)
      const id = secret(); this.sessions.set(id, { csrf: secret(), expires: Date.now() + TTL })
      return this.response({ ok: true }, 200, { 'Set-Cookie': `${COOKIE}=${id}; Path=${ROOT}; Max-Age=${TTL / 1000}; HttpOnly; SameSite=Strict${expected.protocol === 'https:' ? '; Secure' : ''}` })
    }
    if (url.pathname !== ROOT + '/action') return this.response({ error: 'NOT_FOUND' }, 404)
    if (!session) return this.response({ error: 'LOGIN_REQUIRED' }, 401)
    if (!equal(body.csrf, session.csrf)) return this.response({ error: 'CSRF_REJECTED' }, 403)
    if (body.action === 'logout') {
      this.sessions.delete(cookie!)
      return this.response({ ok: true }, 200, { 'Set-Cookie': `${COOKIE}=; Path=${ROOT}; Max-Age=0; HttpOnly; SameSite=Strict` })
    }
    try {
      const runtime = this.getRuntime()
      let result: unknown
      if (body.action === 'save') {
        if (typeof body.gatewayUrl !== 'string') throw new Error('CONFIG_INVALID')
        const target = new URL(body.gatewayUrl)
        if (this.options.localOnly && !['127.0.0.1', '[::1]'].includes(target.hostname)) throw new Error('CONFIG_INVALID')
        result = await runtime.saveConfig({ gatewayUrl: body.gatewayUrl,
          ...(body.accessKey === undefined ? {} : { accessKey: body.accessKey as string }), autoStart: false })
      } else if (body.action === 'test' || body.action === 'start') {
        // Revalidate persisted targets immediately before any process/network action.
        const target = new URL((await runtime.getConfig()).gatewayUrl)
        if (this.options.localOnly && !['127.0.0.1', '[::1]'].includes(target.hostname)) throw new Error('CONFIG_INVALID')
        result = body.action === 'test' ? await runtime.testConnection() : await runtime.start()
      } else if (body.action === 'stop') result = await runtime.stop()
      else if (body.action === 'clear') result = await runtime.clearKey()
      else return this.response({ error: 'INVALID_ACTION' }, 400)
      return this.response({ result })
    } catch (error) {
      const allowed = ['CONFIG_INVALID', 'KEY_REQUIRED', 'KEY_INVALID', 'KEY_REVOKED', 'KEY_IN_USE', 'PROTOCOL_ERROR', 'LOCAL_SERVER_UNAVAILABLE', 'CLIENT_NOT_INSTALLED', 'CONNECTION_FAILED', 'TLS_ERROR', 'STORAGE_ERROR', 'BUSY', 'PROCESS_EXITED']
      const code = (error as Error)?.message
      return this.response({ error: allowed.includes(code) ? code : 'CONFIG_INVALID' }, 400)
    }
  }
}

function page(nonce: string) { return `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>cc-haha · 本机网关接入</title>
<style nonce="${nonce}">*{box-sizing:border-box}body{margin:0;background:#f3f5f8;color:#1e293b;font:16px system-ui}main{max-width:820px;margin:42px auto;padding:30px;background:white;border:1px solid #dfe5ee;border-radius:18px}h1{margin:0 0 8px}p{line-height:1.7;color:#526176}label{display:block;margin:20px 0 7px}input{width:100%;padding:13px;border:1px solid #aab7c8;border-radius:8px;font:inherit}button{margin:18px 8px 0 0;background:#254cc6;color:white;padding:11px 18px;border:0;border-radius:8px;font:inherit;cursor:pointer}button:disabled{opacity:.5}a{color:#254cc6}pre{white-space:pre-wrap;background:#f2f5fa;padding:16px;border-radius:8px}#notice{min-height:28px;color:#9d3c12}.tag{color:#24704b;background:#e9f6ee;padding:5px 10px;border-radius:7px}details{margin-top:22px}</style>
<main><span class="tag">本机可信控制面</span><h1>cc-haha 网关接入</h1><p>配置连接地址和接入密钥，测试后启动隧道。所有修改由本机服务验证身份；远程 H5 无法访问此控制面。</p>
<form id="login"><label for="token">本机访问凭据</label><input id="token" type="password" autocomplete="off" required><button>登录本机配置</button><p>凭据来自本机启动环境。登录状态用 HttpOnly Cookie 保留 12 小时，注销或服务重启后失效。</p></form>
<section id="settings" hidden><p id="mode"></p><form id="config"><label for="url">网关地址</label><input id="url" type="url" placeholder="http://127.0.0.1:18080" required><label for="key">接入密钥</label><input id="key" type="password" autocomplete="off" placeholder="首次填入；留空保留已保存密钥"><button>保存接入配置</button></form><p id="saved"></p><p>此浏览器接入模式未连接系统安全凭据库，密钥仅保存在服务内存。服务重启后请重新粘贴密钥；不会把密钥写入 Cookie 或明文配置文件。</p><div><button id="test">测试连接</button><button id="start">启动连接</button><button id="stop">停止连接</button><button id="clear">清除密钥</button><button id="logout">退出配置</button></div><h2>连接状态</h2><pre id="status">正在读取…</pre><pre id="result" hidden></pre><a id="remote" hidden target="_blank" rel="noreferrer">打开网关登录页面 →</a></section><p id="notice" role="status"></p></main>
<script nonce="${nonce}">
const root='/_local/gateway';let csrf='',busy=false;const $=id=>document.getElementById(id);const names={stopped:'已停止',testing:'测试中',connecting:'连接中',online:'在线',backoff:'等待重连',error:'错误',stopping:'停止中'};
async function api(path,body){const r=await fetch(root+path,{method:body?'POST':'GET',headers:body?{'Content-Type':'application/json'}:{},body:body?JSON.stringify(body):undefined,credentials:'same-origin'});const data=await r.json();if(!r.ok)throw Error(data.error||'请求失败');return data}
async function refresh(){try{const s=await api('/state');csrf=s.csrf;$('login').hidden=true;$('settings').hidden=false;if(!busy&&document.activeElement!==$('url'))$('url').value=s.config.gatewayUrl;$('saved').textContent=s.config.hasKey?'接入密钥：已保存（仅内存）':'接入密钥：尚未保存';$('mode').textContent=s.localOnly?'当前为本机离线实验：仅允许 127.0.0.1 或 ::1 网关地址。':'请使用可信网关地址；非可信网络应使用 HTTPS。';$('status').textContent='状态：'+(names[s.status.state]||s.status.state)+(s.status.code?'\\n错误：'+s.status.code:'');if(s.config.gatewayUrl){$('remote').href=s.config.gatewayUrl+'/_gateway/login';$('remote').hidden=false}}catch(e){if(e.message==='LOGIN_REQUIRED'){$('login').hidden=false;$('settings').hidden=true;csrf=''}else $('notice').textContent=e.message}}
async function run(fn){if(busy)return;busy=true;document.querySelectorAll('button').forEach(b=>b.disabled=true);$('notice').textContent='处理中…';try{await fn();$('notice').textContent='操作成功'}catch(e){$('notice').textContent=e.message}finally{busy=false;document.querySelectorAll('button').forEach(b=>b.disabled=false);await refresh()}}
$('login').onsubmit=e=>{e.preventDefault();run(async()=>{await api('/login',{token:$('token').value});$('token').value=''})};
$('config').onsubmit=e=>{e.preventDefault();run(async()=>{await api('/action',{action:'save',csrf,gatewayUrl:$('url').value,...($('key').value?{accessKey:$('key').value}:{})});$('key').value=''})};
for(const action of ['test','start','stop','clear','logout'])$(action).onclick=()=>run(async()=>{const d=await api('/action',{action,csrf});if(action==='test'){const r=d.result;$('result').hidden=false;$('result').textContent='本机服务：'+(r.localReady?'已验证':'未通过')+'\\n网关连接：'+(r.gatewayConnected?'已验证':'未通过')+'\\n密钥与协议：'+(r.keyAccepted?'已验证':'未通过')+'\\n端到端调用：请在网关登录后进入 H5 创建会话验证'+(r.code?'\\n错误：'+r.code:'');if(r.code||!r.keyAccepted)throw Error('连接测试未通过：'+(r.code||'CONNECTION_FAILED'))}});
refresh();setInterval(()=>{if(!busy&&csrf)refresh()},2500);
</script></html>` }
