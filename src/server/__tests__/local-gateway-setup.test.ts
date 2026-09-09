import { describe, expect, test } from 'bun:test'
import { LocalGatewaySetup } from '../localGatewaySetup.js'
const origin = 'http://127.0.0.1:3467', token = 'a'.repeat(64)
function setup() {
 let calls = 0
 const runtime = {getConfig:async()=>({gatewayUrl:'http://127.0.0.1:18080',hasKey:false,credentialStorage:'none',autoStart:false}),getStatus:async()=>({state:'stopped',generation:0}),saveConfig:async()=>{calls++;return{}},testConnection:async()=>{calls++;return{}},start:async()=>{calls++;return{}},stop:async()=>({}),clearKey:async()=>({}),disposeSync:()=>{}}
 const handler = new LocalGatewaySetup({origin:()=>origin,token:()=>token,runtime:()=>runtime as any,localOnly:true})
 const request = (path:string,body?:unknown,headers:Record<string,string>={},address='127.0.0.1') => handler.handle(new Request(origin+'/_local/gateway'+path,{method:body?'POST':'GET',headers:{host:'127.0.0.1:3467',...(body?{origin,'content-type':'application/json'}:{}),...headers},body:body?JSON.stringify(body):undefined}),address)
 return {request,get calls(){return calls}}
}
describe('local browser gateway control boundary',()=>{
 test('rendered HTML contains a valid executable script and no credential',async()=>{
  const s=setup();const response=(await s.request(''))!;const html=await response.text()
  const script=html.match(/<script nonce="[^"]+">([\s\S]*?)<\/script>/)![1]
  expect(()=>new Function(script)).not.toThrow()
  expect(html).not.toContain(token)
  expect(html).toContain('本机可信控制面')
  expect(html).not.toContain('\\u672C')
  expect(response.headers.get('content-security-policy')).toContain("frame-ancestors 'none'")
 })
 test('login gives persistent HttpOnly session, CSRF protects actions, logout revokes replay',async()=>{
  const s=setup()
  expect((await s.request('/state'))!.status).toBe(401)
  const login=(await s.request('/login',{token}))!
  expect(login.status).toBe(200)
  const setCookie=login.headers.get('set-cookie')!
  expect(setCookie).toContain('HttpOnly');expect(setCookie).toContain('SameSite=Strict');expect(setCookie).toContain('Max-Age=43200');expect(setCookie).not.toContain(token)
  const headers={cookie:setCookie.split(';')[0]}
  const state=await (await s.request('/state',undefined,headers))!.json()
  expect((await s.request('/action',{action:'start'},headers))!.status).toBe(403)
  expect(s.calls).toBe(0)
  expect((await s.request('/action',{action:'save',csrf:state.csrf,gatewayUrl:'http://127.0.0.1:18080',accessKey:'private'},headers))!.status).toBe(200)
  expect(s.calls).toBe(1)
  expect((await s.request('/action',{action:'logout',csrf:state.csrf},headers))!.status).toBe(200)
  expect((await s.request('/state',undefined,headers))!.status).toBe(401)
 })
 test('rejects foreign Origin, remote peer, hostile Host, and any forwarder credentials before runtime',async()=>{
  const s=setup()
  for(const headers of [{origin:'http://127.0.0.1:18080'},{origin:'null'},{host:'evil.invalid'},{'x-cc-haha-gateway-forwarder':'Bearer '+token},{'x-forwarded-for':'127.0.0.1'},{'sec-fetch-site':'cross-site'}])
    expect((await s.request('/login',{token},headers))!.status).toBe(403)
  expect((await s.request('/login',{token},{},'192.168.1.2'))!.status).toBe(403)
  expect(s.calls).toBe(0)
 })
 test('external targets cannot be saved or started in local-only mode; repeated guesses cool down',async()=>{
  const s=setup();const login=(await s.request('/login',{token}))!
  const headers={cookie:login.headers.get('set-cookie')!.split(';')[0]}
  const state=await (await s.request('/state',undefined,headers))!.json()
  expect((await s.request('/action',{action:'save',csrf:state.csrf,gatewayUrl:'http://example.invalid',accessKey:'private'},headers))!.status).toBe(400)
  expect(s.calls).toBe(0)
  for(let i=0;i<5;i++)expect((await s.request('/login',{token:'bad'}))!.status).toBe(401)
  expect((await s.request('/login',{token}))!.status).toBe(429)
 })
})
