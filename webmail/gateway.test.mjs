import { afterEach, describe, expect, it, vi } from 'vitest';
import gateway from './worker.ts';

const host = 'https://mail.veyro.dk';
const enabled = { WEBMAIL_ENABLED: '1' };
const get = (path, init = {}, env = enabled) => gateway.fetch(new Request(host + path, init), env);
const post = (path, headers = {}, env = enabled) => get(path, { method: 'POST', headers, body: 'demo' }, env);
afterEach(() => vi.unstubAllGlobals());

describe('Veyro Mail gateway', () => {
  it('opens the example inbox directly during installation without contacting an origin', async () => {
    const fetch = vi.fn(); vi.stubGlobal('fetch', fetch);
    const entry = await get('/', {}, {});
    expect(entry.status).toBe(200);
    expect(entry.headers.get('Location')).toBeNull();
    const home = await entry.text();
    expect(home).toContain('Indbakke');
    expect(home).toContain('Eksempelpost');
    expect(home).not.toContain('mail.google.com');
    expect(await (await get('/forhaandsvisning', {}, {})).text()).toBe(home);
    expect((await get('/SOGo/', { headers: { Accept: 'text/html' } }, {})).status).toBe(503);
    expect((await post('/SOGo/connect', { Origin: host }, {})).status).toBe(503);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('takes fresh and signed-in visitors straight to SOGo when enabled', async () => {
    const upstream = vi.fn(); vi.stubGlobal('fetch', upstream);
    for (const init of [{}, { headers: { Cookie: '0xHIGHFLYxSOGo=test' } }, { method: 'HEAD' }]) {
      const res = await get('/', init);
      expect(res.status).toBe(302);
      expect(res.headers.get('Location')).toBe('/SOGo/');
      expect(res.headers.get('Cache-Control')).toContain('no-store');
      expect(await res.text()).toBe('');
    }
    expect(upstream).not.toHaveBeenCalled();
  });

  it('keeps the separate preview and its resources available in both modes', async () => {
    for (const env of [{}, enabled]) {
      const preview = await get('/forhaandsvisning', {}, env);
      expect(preview.status).toBe(200);
      expect(preview.headers.get('Content-Security-Policy')).toContain("script-src 'self'");
      expect(await preview.text()).toContain('/forhaandsvisning.js');
      for (const [path, type] of [['/forhaandsvisning.css', 'text/css'], ['/forhaandsvisning.js', 'text/javascript']]) {
        const res = await get(path, {}, env);
        expect(res.status).toBe(200);
        expect(res.headers.get('Content-Type')).toContain(type);
        expect((await res.text()).length).toBeGreaterThan(0);
      }
    }
    for (const path of ['/webmail.css', '/sogo-theme.css']) {
      const res = await get(path, { method: 'HEAD' });
      expect(res.status).toBe(200);
      expect(res.headers.get('Content-Type')).toContain('text/css');
      expect(await res.text()).toBe('');
    }
  });

  it('limits requests to the webmail host, the native application, and same-origin writes', async () => {
    const upstream = vi.fn(); vi.stubGlobal('fetch', upstream);
    expect((await gateway.fetch(new Request('https://other.veyro.dk/SOGo/'), enabled)).status).toBe(404);
    expect((await get('/admin')).status).toBe(404);
    expect((await post('/SOGo/connect', { Origin: 'https://other.veyro.dk' })).status).toBe(403);
    expect((await post('/SOGo/connect')).status).toBe(403);
    expect(upstream).not.toHaveBeenCalled();
  });

  it('forwards only the SOGo request and preserves session and CSRF cookie semantics', async () => {
    let forwarded;
    vi.stubGlobal('fetch', vi.fn(async (target, init) => {
      forwarded = new Request(target, init);
      const headers = new Headers();
      headers.append('Set-Cookie', '0xHIGHFLYxSOGo=synthetic; Path=/SOGo; Domain=post.veyro.dk');
      headers.append('Set-Cookie', 'XSRF-TOKEN=example; Path=/SOGo/');
      headers.append('Set-Cookie', 'SOGoWindowMode=single; Path=/SOGo/');
      return new Response('{}', { headers });
    }));
    const res = await post('/SOGo/connect?language=da', {
      Origin: host,
      Cookie: 'SOGoLogin=synthetic; VeyroOther=unrelated; SOGoWindowMode=single; XSRF-TOKEN=example',
      'X-WebObjects-Remote-User': 'must-not-forward', 'X-Xsrf-Token': 'example',
    });
    expect(res.status).toBe(200);
    expect(forwarded.url).toBe('https://post.veyro.dk/SOGo/connect?language=da');
    expect(forwarded.headers.get('Host')).toBe('mail.veyro.dk');
    expect(forwarded.headers.get('X-WebObjects-Remote-User')).toBeNull();
    expect(forwarded.headers.get('X-Xsrf-Token')).toBe('example');
    expect(forwarded.headers.get('Cookie')).toBe('SOGoLogin=synthetic; SOGoWindowMode=single; XSRF-TOKEN=example');
    expect(await forwarded.text()).toBe('demo');
    expect(res.headers.get('Cache-Control')).toContain('no-store');
    const cookies = res.headers.getSetCookie();
    expect(cookies).toHaveLength(3);
    expect(cookies[0]).toMatch(/Secure.*HttpOnly/);
    expect(cookies.join(' ')).not.toMatch(/Domain=/i);
    expect(cookies[1]).not.toMatch(/HttpOnly/i);
    expect(cookies[2]).toMatch(/^SOGoWindowMode=single; Path=\/SOGo\/; Secure; SameSite=Lax$/);
  });

  it('uses only native redirect destinations without following a credentialed redirect', async () => {
    const upstream = vi.fn()
      .mockResolvedValueOnce(Response.redirect('https://post.veyro.dk/SOGo/so/', 302))
      .mockResolvedValueOnce(Response.redirect('https://accounts.example.test/', 307));
    vi.stubGlobal('fetch', upstream);
    const first = await get('/SOGo/');
    expect(first.status).toBe(302);
    expect(first.headers.get('Location')).toBe(host + '/SOGo/so/');
    expect((await post('/SOGo/connect', { Origin: host })).status).toBe(503);
    expect(upstream).toHaveBeenCalledTimes(2);
    expect(upstream.mock.calls[1][1].redirect).toBe('manual');
  });

  it('returns a service outage without inviting an already migrated user to Gmail', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('Internal detail')));
    const res = await get('/SOGo/', { headers: { Accept: 'text/html' } });
    expect(res.status).toBe(503);
    const body = await res.text();
    expect(body).toContain('Veyro Mail');
    expect(body).toContain('href="/">Prøv igen</a>');
    expect(body).not.toMatch(/mail\.google|Internal detail/);
  });

  it('streams native resources and message content without rewriting message HTML', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('<p>Mail</p>', { headers: { 'Content-Type': 'text/html' } })));
    for (const path of ['/SOGo.woa/WebServerResources/locale/da.html', '/.woa/WebServerResources/locale/da.html', '/SOGo/so/user/Mail/0/folderINBOX/1/view']) {
      expect(await (await get(path)).text()).toBe('<p>Mail</p>');
    }
  });

  it('serves bundled branding without forwarding cookies or user query strings', async () => {
    const assets = { fetch: vi.fn(async req => {
      expect(req.headers.get('Cookie')).toBeNull();
      expect(new URL(req.url).search).toBe('');
      return new Response('branding');
    }) };
    const res = await get('/favicon.svg?test=ok', { headers: { Cookie: 'SOGoLogin=test' } }, { ASSETS: assets });
    expect(await res.text()).toBe('branding');
    expect(assets.fetch).toHaveBeenCalledOnce();
  });
});
