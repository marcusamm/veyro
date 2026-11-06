import { build } from 'esbuild';
import * as runtime from 'miniflare';
import { afterAll, beforeAll, expect, it } from 'vitest';
let mf, requests=[], replyStatus=200, replyBody='{"code":0}';
beforeAll(async()=>{
  const compiled=await build({entryPoints:['src/site/tiktok.ts'],bundle:true,write:false,format:'esm',platform:'browser',target:'es2022'});
  const options={modules:true,script:compiled.outputFiles[0].text,compatibilityDate:'2026-10-01',
    bindings:{TIKTOK_EVENTS_ACCESS_TOKEN:'test-token'},d1Databases:['DB'],
    outboundService:async request=>{requests.push({url:request.url,token:request.headers.get('Access-Token'),body:await request.json()});return new Response(replyBody,{status:replyStatus,headers:replyStatus===302?{Location:'https://untrusted.example/'}:{'Content-Type':'application/json'}});},
  };
  mf=new runtime.Miniflare(runtime.convertV4MiniflareOptions ? runtime.convertV4MiniflareOptions(options) : options);
  const db=await mf.getD1Database('DB');
  await db.exec('CREATE TABLE site_content (key TEXT, value TEXT, updated_at INTEGER); CREATE TABLE rate_limits (key TEXT PRIMARY KEY, count INTEGER NOT NULL, reset_at INTEGER NOT NULL);');
});
afterAll(async()=>{await mf?.dispose();});
const send=()=>mf.dispatchFetch('https://veyro.dk/events',{method:'POST',headers:{Origin:'https://veyro.dk','Content-Type':'application/json','User-Agent':'Mozilla/5.0','CF-Connecting-IP':'192.0.2.1'},body:JSON.stringify({eventId:crypto.randomUUID(),path:'/',marketing:true,tiktok:true,consentVersion:2,consentAt:Date.now()})});
it('sends through the real Workers runtime, with real D1 validation and rate limiting',async()=>{
 const r=await send();expect(r.status).toBe(200);expect(await r.json()).toEqual({accepted:true});
 expect(requests).toHaveLength(1);expect(requests[0].url).toBe('https://business-api.tiktok.com/open_api/v1.3/event/track/');expect(requests[0].token).toBe('test-token');
});
it('does not follow an upstream redirect or leak the secret to its destination',async()=>{
 const previous=requests.length;replyStatus=302;replyBody='Redirect';
 const r=await send();expect(r.status).toBe(502);expect(requests).toHaveLength(previous+1);expect(requests.at(-1).url).not.toContain('untrusted.example');
});
