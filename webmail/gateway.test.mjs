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

  it('opens the mailcow user login on its canonical origin for fresh and signed-in visitors', async () => {
    const upstream = vi.fn(); vi.stubGlobal('fetch', upstream);
    for (const [path, init] of [
      ['/', {}], ['/', { headers: { Cookie: 'MCSESSID=example' } }], ['/', { method: 'HEAD' }],
      ['/SOGo/', {}], ['/SOGo/so/', {}], ['/?return_to=https://other.invalid/', {}],
    ]) {
      const res = await get(path, init);
      expect(res.status).toBe(302);
      expect(res.headers.get('Location')).toBe('https://post.veyro.dk/');
      expect(res.headers.get('Referrer-Policy')).toBe('no-referrer');
      expect(res.headers.has('Set-Cookie')).toBe(false);
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
    const css = await get('/webmail.css', { method: 'HEAD' });
    expect(css.status).toBe(200);
    expect(css.headers.get('Content-Type')).toContain('text/css');
    expect(await css.text()).toBe('');
  });

  it('never proxies administration, sign-in submissions or mailbox data on the entry host', async () => {
    const upstream = vi.fn(); vi.stubGlobal('fetch', upstream);
    expect((await gateway.fetch(new Request('https://other.veyro.dk/'), enabled)).status).toBe(404);
    for (const path of ['/admin', '/domainadmin', '/api/v1', '/sogo-auth.php', '/SOGo/so/user/Mail/0/folderINBOX/view']) {
      const res = await get(path);
      expect(res.status).toBe(404);
      expect(res.headers.has('Location')).toBe(false);
    }
    for (const path of ['/', '/SOGo/', '/SOGo/connect']) {
      const res = await post(path, { Origin: host });
      expect(res.status).toBe(405);
      expect(res.headers.get('Allow')).toBe('GET, HEAD');
      expect(res.headers.has('Location')).toBe(false);
    }
    expect(upstream).not.toHaveBeenCalled();
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
