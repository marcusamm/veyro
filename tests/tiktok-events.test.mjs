import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import tiktok from '../src/site/tiktok';
vi.mock('../src/site/content', () => ({ loadSite: vi.fn(async () => ({pages:[{handle:'priser',published:true,archived:false}],products:[]})) }));
vi.mock('../src/lib/db', () => ({ rateLimit: vi.fn(async () => true) }));
import { rateLimit } from '../src/lib/db';
const token = 'test-secret-not-a-real-token';
const env = { DB: {}, TIKTOK_EVENTS_ACCESS_TOKEN: token };
const sample = () => ({ eventId:crypto.randomUUID(), path:'/', marketing:true, tiktok:true, consentVersion:2, consentAt:Date.now(),ttclid:'ad-click' });
let upstream;
function send(body=sample(),headers={},bindings=env,origin='https://veyro.dk') {
  return tiktok.request(new Request(origin+'/events', {method:'POST', headers:{Origin:origin,'Content-Type':'application/json','CF-Connecting-IP':'192.0.2.1','User-Agent':'Mozilla/5.0 Safari/604.1',...headers},body:typeof body==='string'?body:JSON.stringify(body)}),{},bindings);
}
beforeEach(()=>{upstream=vi.fn(async()=>new Response(JSON.stringify({code:0}),{status:200}));vi.stubGlobal('fetch',upstream);vi.mocked(rateLimit).mockResolvedValue(true);});
afterEach(()=>vi.unstubAllGlobals());
describe('TikTok server relay',()=>{
  it('sends an allowlisted payload to TikTok with the same ID and a server-only secret',async()=>{
    const b={...sample(),path:'/en/pages/priser/',email:'never@example.com',token:'private',ip:'client-injection'};
    const r=await send(b,{Cookie:'_ttp=cookie-id; unrelated=private','X-Forwarded-For':'client-ip'});
    expect(r.status).toBe(200);expect(await r.json()).toEqual({accepted:true});
    const [url,options]=upstream.mock.calls[0];
    expect(url).toBe('https://business-api.tiktok.com/open_api/v1.3/event/track/');
    expect(options.headers['Access-Token']).toBe(token);expect(options.redirect).toBe('manual');
    const payload=JSON.parse(options.body),e=payload.data[0];
    expect(payload.event_source_id).toBe('DBMMVK3C77UDLIGRBECG');
    expect(e.event_id).toBe(b.eventId);expect(e.event).toBe('Pageview');
    expect(e.page.url).toBe('https://veyro.dk/en/pages/priser');
    expect(e.user).toEqual({ip:'192.0.2.1',user_agent:'Mozilla/5.0 Safari/604.1',ttp:'cookie-id',ttclid:'ad-click'});
    expect(options.body).not.toMatch(/never@example|client-injection|private|test-secret/);
    expect(r.headers.get('Cache-Control')).toBe('private, no-store');
  });
  it.each(['/','/en','/en/','/pages/priser'])('allows public page %s',async path=>expect((await send({...sample(),path})).status).toBe(200));
  it.each([{marketing:false},{tiktok:false},{consentVersion:1},{consentAt:0},{consentAt:Date.now()+999999},{consentAt:'now'}])('does not forward without current consent %j',async patch=>{
    expect((await send({...sample(),...patch})).status).toBe(204);expect(upstream).not.toHaveBeenCalled();
  });
  it.each([{DNT:'1'},{'Sec-GPC':'1'},{'User-Agent':'Googlebot'}])('respects privacy and bot signals %j',async headers=>{expect((await send(sample(),headers)).status).toBe(204);expect(upstream).not.toHaveBeenCalled();});
  it.each(['/login','/cart','/admin','/demo/test/','/pages/missing','//evil.example','/sv/','/?email=private','/pages/priser#private'])('rejects private, unknown and noncanonical paths %s',async path=>{expect((await send({...sample(),path})).status).toBe(400);expect(upstream).not.toHaveBeenCalled();});
  it.each(['https://veyro.se','https://ny.veyro.dk','https://kunde.veyro.dk','http://veyro.dk'])('does not forward from %s',async host=>{expect((await send(sample(),{},env,host)).status).toBe(404);expect(upstream).not.toHaveBeenCalled();});
  it('rejects cross-origin, oversized and malformed input',async()=>{
    expect((await send(sample(),{Origin:'https://other.example'})).status).toBe(403);
    expect((await send(sample(),{'Sec-Fetch-Site':'cross-site'})).status).toBe(403);
    expect((await send(sample(),{'Content-Type':'text/plain'})).status).toBe(415);
    expect((await send('bad-json')).status).toBe(400);
    expect((await send({...sample(),eventId:'bad'})).status).toBe(400);
    expect((await send({...sample(),extra:'x'.repeat(3000)})).status).toBe(413);
    expect(upstream).not.toHaveBeenCalled();
  });
  it('requires a secret and applies abuse protection',async()=>{
    expect((await send(sample(),{},{DB:{}})).status).toBe(503);
    vi.mocked(rateLimit).mockResolvedValue(false);
    expect((await send()).status).toBe(429);expect(upstream).not.toHaveBeenCalled();
  });
  it('omits malformed click/cookie identifiers',async()=>{
    await send({...sample(),ttclid:'private@example.com'},{Cookie:'_ttp=private@example.com'});
    expect(JSON.parse(upstream.mock.calls[0][1].body).data[0].user).not.toHaveProperty('ttclid');
    expect(JSON.parse(upstream.mock.calls[0][1].body).data[0].user).not.toHaveProperty('ttp');
  });
  it('reports upstream rejection and outages without leaking secrets or vendor text',async()=>{
    upstream.mockResolvedValueOnce(new Response(JSON.stringify({code:40001,message:token}),{status:200}));
    const r=await send();expect(r.status).toBe(502);expect(await r.text()).not.toContain(token);
    upstream.mockRejectedValueOnce(new Error(token));
    expect((await send()).status).toBe(503);
    upstream.mockResolvedValueOnce(new Response('not-json'));
    expect((await send()).status).toBe(502);
  });
});
