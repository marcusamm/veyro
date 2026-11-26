import { afterEach, describe, expect, it, vi } from 'vitest';
import gateway from './worker.ts';

const origin = 'https://mail.veyro.dk';
const clientIP = '192.0.2.78';

function request(path, options = {}, enabled = '1') {
  const env = {WEBMAIL_ENABLED: enabled, VEYRO_MAIL_ORIGIN_TOKEN: 'trusted-edge', ASSETS: {fetch: vi.fn()}};
  return gateway.fetch(new Request(origin + path, options), env);
}

afterEach(() => vi.unstubAllGlobals());

describe('AI protocol boundary', () => {
  it('publishes canonical discovery addresses and obeys the mailbox kill switch', async () => {
    const result = await request('/.well-known/oauth-protected-resource/mcp');
    expect(await result.json()).toMatchObject({resource: origin + '/mcp', authorization_servers: [origin]});
    const metadata = await request('/.well-known/oauth-authorization-server');
    expect(await metadata.json()).toMatchObject({registration_endpoint:origin+'/ai/register', code_challenge_methods_supported:['S256']});
    expect((await request('/mcp', {}, '0')).status).toBe(503);
    expect((await request('/.well-known/oauth-authorization-server', {}, '0')).status).toBe(503);
  });

  it('forwards only trusted credential, IP and protocol headers, never ambient cookies or client-supplied identity', async () => {
    const auth = 'Bearer test-bound-credential';
    const challenge = 'Bearer resource_metadata="'+origin+'/.well-known/oauth-protected-resource/mcp"';
    const fetch = vi.fn(async () => Response.json({error:'invalid_token'}, {status:401,headers:{'WWW-Authenticate':challenge}}));
    vi.stubGlobal('fetch',fetch);
    const headers = {Authorization:auth,'X-Veyro-AI-Authorization':'Bearer injected',
      'X-Veyro-Origin-Token':'spoof','Cookie':'__Host-veyro_session=browser-session','X-CSRF-Token':'private-csrf',
      'X-Veyro-Client-IP':'203.0.113.1','CF-Connecting-IP':clientIP,'Content-Type':'application/json','MCP-Protocol-Version':'2025-11-25'};
    const response = await request('/mcp?credential=query', {method:'POST',headers,body:'{"jsonrpc":"2.0","id":1,"method":"initialize"}'});
    const [url, upstream] = fetch.mock.calls[0];
    expect(url).toBe('https://post.veyro.dk/webmail-api/api/ai/protocol/mcp');
    expect(upstream.headers.get('X-Veyro-AI-Authorization')).toBe(auth);
    expect(upstream.headers.get('X-Veyro-Origin-Token')).toBe('trusted-edge');
    expect(upstream.headers.get('X-Veyro-Client-IP')).toBe(clientIP);
    expect(upstream.headers.has('Authorization')).toBe(false);
    expect(upstream.headers.has('Cookie')).toBe(false);
    expect(upstream.headers.has('X-CSRF-Token')).toBe(false);
    expect(response.headers.get('WWW-Authenticate')).toBe(challenge);
  });

  it('accepts form encoded token exchange and requires browser session and origin for consent', async () => {
    const fetch = vi.fn(async () => Response.json({}));
    vi.stubGlobal('fetch',fetch);
    const headers = {Authorization:'Basic fixture','Content-Type':'application/x-www-form-urlencoded'};
    expect((await request('/ai/token', {method:'POST', headers, body:'grant_type=authorization_code'})).status).toBe(200);
    expect(fetch.mock.calls[0][1].headers.get('X-Veyro-AI-Authorization')).toBe('Basic fixture');
    expect((await request('/api/ai/authorize', {method:'POST',headers:{'Content-Type':'application/json'},body:'{}'})).status).toBe(401);
    const browser = {'Content-Type':'application/json',Cookie:'__Host-veyro_session=fixture'};
    expect((await request('/api/ai/authorize', {method:'POST',headers:browser,body:'{}'})).status).toBe(403);
    expect((await request('/mcp', {method:'POST',headers:{Origin:'https://untrusted.test','Content-Type':'application/json'},body:'{}'})).status).toBe(403);
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
