import { describe, expect, test } from 'bun:test'
import { LocalGatewaySetup } from '../localGatewaySetup.js'
const origin = 'http://127.0.0.1:3467', token = 'a'.repeat(64)
function fixture() {
  let calls = 0, target = 'http://127.0.0.1:18080'
  const runtime = { getConfig: async () => ({gatewayUrl:target}), getStatus:async()=>({state:'stopped'}), saveConfig:async()=>{calls++;return{}}, testConnection:async()=>{calls++;return{}}, start:async()=>{calls++;return{}}, stop:async()=>{calls++;return{}}, clearKey:async()=>{calls++;return{}}, disposeSync:()=>{} }
  const handler = new LocalGatewaySetup({origin:()=>origin,token:()=>token,runtime:()=>runtime as any,localOnly:true})
  async function request(path:string, body?:unknown, headers:Record<string,string>={}, missingOrigin=false) {
    return (await handler.handle(new Request(origin+'/_local/gateway'+path, {method:body===undefined?'GET':'POST',headers:{host:'127.0.0.1:3467',...(body===undefined?{}:{'content-type':'application/json',...(missingOrigin?{}:{origin})}),...headers},body:body===undefined?undefined:JSON.stringify(body)}),'127.0.0.1'))!
  }
  async function login(){const r=await request('/login',{token});expect(r.status).toBe(200);const headers={cookie:r.headers.get('set-cookie')!.split(';')[0]};const state=await(await request('/state',undefined,headers)).json();return {headers,csrf:state.csrf}}
  return {request,login,handler,get calls(){return calls},set target(value:string){target=value}}
}
describe('independent local gateway security acceptance',()=>{
  test('non-ASCII equal character count fails closed without throwing',async()=>{
    const f=fixture()
    expect((await f.request('/login',{token:'汉'.repeat(64)})).status).toBe(401)
    const {headers}=await f.login()
    expect((await f.request('/action',{action:'start',csrf:'汉'.repeat(64)},headers)).status).toBe(403)
    expect(f.calls).toBe(0)
  })
  test('valid session and CSRF cannot bypass origin and forwarder boundary',async()=>{
    const f=fixture(),{headers,csrf}=await f.login()
    for(const extra of [{origin:'null'},{origin:'http://127.0.0.1:18080'},{host:'127.0.0.1:3467,evil.invalid'},{'x-cc-haha-gateway-forwarder':'Bearer '+token},{forwarded:'for=127.0.0.1'}]){
      expect((await f.request('/action',{action:'start',csrf},{...headers,...extra})).status).toBe(403)
    }
    expect((await f.request('/action',{action:'start',csrf},headers,true)).status).toBe(403)
    expect((await f.request('/login',{token},{},true)).status).toBe(403)
    expect(f.calls).toBe(0)
    expect((await f.request('/action',{action:'start',csrf},headers)).status).toBe(200)
    expect(f.calls).toBe(1)
  })
  test('persisted external target is rejected at execution; expired and logged out sessions cannot replay',async()=>{
    const f=fixture(),{headers,csrf}=await f.login()
    f.target='http://example.invalid'
    for(const action of ['test','start'])expect((await f.request('/action',{action,csrf},headers)).status).toBe(400)
    expect(f.calls).toBe(0)
    expect((await f.request('/action',{action:'logout',csrf},headers)).status).toBe(200)
    expect((await f.request('/state',undefined,headers)).status).toBe(401)
    expect((await f.request('/action',{action:'stop',csrf},headers)).status).toBe(401)
    const next=await f.login(), now=Date.now
    try { Date.now=()=>now()+12*60*60*1000+1; expect((await f.request('/state',undefined,next.headers)).status).toBe(401) }
    finally { Date.now=now }
    expect(f.calls).toBe(0)
  })
  test('oversize requests fail before authentication or runtime side effects',async()=>{
    const f=fixture()
    expect((await f.request('/login',{token,padding:'x'.repeat(8192)})).status).toBe(413)
    expect(f.calls).toBe(0)
  })
})
