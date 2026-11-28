import {afterEach, describe, expect, it, vi} from 'vitest';
import gateway from './worker.ts';

const origin = 'https://mail.veyro.dk';
const id = 'cb944dd5-fecb-4c47-8fa8-e4387cb4b41c';
const headers = {Cookie:'__Host-veyro_session=fixture_session', Origin:origin, 'Content-Type':'application/json', 'X-CSRF-Token':'fixture_csrf'};
function setup(enabled = '1') {
  const upstream = vi.fn(async () => Response.json({ok:true})); vi.stubGlobal('fetch',upstream);
  const assets = vi.fn(async () => new Response('team page'));
  const env = {WEBMAIL_ENABLED:enabled, VEYRO_MAIL_ORIGIN_TOKEN:'fixture-origin-token',ASSETS:{fetch:assets}};
  return {upstream,assets,fetch:(path, init = {}) => gateway.fetch(new Request(origin + path,init),env)};
}
afterEach(() => vi.unstubAllGlobals());
describe('company gateway', () => {
  it('requires a signed-in session for every directory, content and document route',async () => {
    const {fetch,upstream} = setup();
    for (const path of ['bootstrap','messages','posts','files','files/'+id,'files/'+id+'/download']) {
      expect((await fetch('/api/team/'+path)).status).toBe(401);
      expect((await fetch('/api/team/'+path,{method:'DELETE',headers})).status).toBe(405);
    }
    expect(upstream).not.toHaveBeenCalled();
    expect((await fetch('/api/team/bootstrap',{headers})).status).toBe(200);
    expect(upstream.mock.lastCall[1].headers.get('Cookie')).toBe(headers.Cookie);
  });
  it('checks exact methods, origin and CSRF before all team writes',async () => {
    const {fetch,upstream} = setup();
    for (const path of ['channels','messages','read','posts','files','messages/'+id+'/delete','posts/'+id+'/update','posts/'+id+'/delete','files/'+id+'/delete']) {
      for (const [invalid,status] of [[{Cookie:''},401],[{Origin:'https://evil.invalid'},403],[{'X-CSRF-Token':''},403],[{'Content-Type':'text/plain'},415]]) {
        expect((await fetch('/api/team/'+path,{method:'POST',headers:{...headers,...invalid},body:'{}'})).status).toBe(status);
      }
    }
    expect(upstream).not.toHaveBeenCalled();
    expect((await fetch('/api/team/channels?actor=admin@other.test',{method:'POST',headers:{...headers,'X-Veyro-Actor':'admin@other.test'},body:'{}'})).status).toBe(200);
    expect(upstream.mock.lastCall[0]).toBe('https://post.veyro.dk/webmail-api/api/team/channels');
    expect(upstream.mock.lastCall[1].headers.has('X-Veyro-Actor')).toBe(false);
  });
  it('does not proxy arbitrary paths or file identifiers',async () => {
    const {fetch,upstream} = setup();
    for (const path of ['directory','files/123','files/not-a-uuid/download','messages/'+id,'posts/'+id+'/anything','users']) {
      expect((await fetch('/api/team/'+path,{headers})).status).toBe(404);
    }
    expect(upstream).not.toHaveBeenCalled();
  });
  it('allows bounded base64 document uploads without raising the ordinary message limit',async () => {
    const {fetch,upstream} = setup();
    const post = (path, size) => fetch(path,{method:'POST',headers:{...headers,'Content-Length':String(size)},body:'{}'});
    expect((await post('/api/team/files',7*1024*1024+1)).status).toBe(413);
    expect((await post('/api/team/messages',256*1024+1)).status).toBe(413);
    expect(upstream).not.toHaveBeenCalled();
    expect((await post('/api/team/files',6*1024*1024)).status).toBe(200);
  });
  it('forces documents to attachment downloads, and never mistakes errors for files',async () => {
    const {fetch,upstream} = setup();
    upstream.mockResolvedValueOnce(new Response('<script>bad()</script>',{headers:{'Content-Type':'text/html','Content-Disposition':'inline'}}));
    const download = await fetch('/api/team/files/'+id+'/download',{headers});
    expect(download.headers.get('Content-Disposition')).toBe('attachment');
    expect(download.headers.get('Content-Type')).toBe('application/octet-stream');
    expect(download.headers.get('Content-Security-Policy')).toBe("default-src 'none'; sandbox");
    upstream.mockResolvedValueOnce(Response.json({error:'not yours'},{status:404}));
    const missing = await fetch('/api/team/files/'+id,{headers});
    expect(missing.status).toBe(404); expect(missing.headers.get('Content-Type')).toContain('application/json');
  });
  it('gates team pages and API when webmail is closed',async () => {
    const {fetch,upstream,assets} = setup('0');
    for (const path of ['/team','/api/team/bootstrap']) expect((await fetch(path,{headers})).status).toBe(503);
    expect(upstream).not.toHaveBeenCalled(); expect(assets).not.toHaveBeenCalled();
  });
});
