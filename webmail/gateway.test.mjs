import { afterEach, describe, expect, it, vi } from 'vitest';
import gateway from './worker.ts';

const host = 'https://mail.veyro.dk';
const enabled = { WEBMAIL_ENABLED: '1' };
const get = (path, init = {}, env = enabled) => gateway.fetch(new Request(host + path, init), env);
const post = (path, headers = {}, env = enabled) => get(path, { method: 'POST', headers, body: 'demo' }, env);
afterEach(() => vi.unstubAllGlobals());

describe('Veyro Mail gateway', () => {
  it('returns a maintenance response without showing example mail when disabled', async () => {
    const upstream = vi.fn(); vi.stubGlobal('fetch', upstream);
    for (const path of ['/', '/forhaandsvisning', '/forhaandsvisning/', '/SOGo/']) {
      const res = await get(path, { headers: { Accept: 'text/html' } }, {});
      expect(res.status).toBe(503);
      expect(res.headers.has('Location')).toBe(false);
      const body = await res.text();
      expect(body).toContain('Webmail er midlertidigt lukket');
      expect(body).not.toMatch(/Eksempelpost|forhaandsvisning|<form/i);
    }
    expect((await post('/SOGo/connect', { Origin: host }, {})).status).toBe(503);
    expect(upstream).not.toHaveBeenCalled();
  });

  it('opens the mailcow user login on its canonical origin for fresh and signed-in visitors', async () => {
    const upstream = vi.fn(); vi.stubGlobal('fetch', upstream);
    for (const [path, init] of [
      ['/', {}], ['/', { headers: { Cookie: 'MCSESSID=example' } }], ['/', { method: 'HEAD' }],
      ['/forhaandsvisning', {}], ['/forhaandsvisning/', { method: 'HEAD' }],
      ['/forhaandsvisning?return_to=https://other.invalid/', {}], ['/SOGo', {}], ['/SOGo/', {}],
      ['/SOGo/so', {}], ['/SOGo/so/', {}], ['/?return_to=https://other.invalid/', {}],
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

  it('retires the old preview assets in every mode', async () => {
    for (const env of [{}, enabled]) {
      for (const path of ['/forhaandsvisning.css', '/forhaandsvisning.js']) {
        const res = await get(path, {}, env);
        expect(res.status).toBe(404);
        expect(await res.text()).toBe('Siden findes ikke.');
      }
    }
  });

  it('sends old loopback bookmarks to the fixed HTTPS login without accepting sign-in submissions', async () => {
    for (const origin of ['http://localhost:8787', 'http://127.0.0.1:8787', 'http://[::1]:8787']) {
      for (const path of ['/', '/forhaandsvisning', '/forhaandsvisning/']) {
        const response = await gateway.fetch(new Request(origin + path), enabled);
        expect(response.status).toBe(302);
        expect(response.headers.get('Location')).toBe('https://post.veyro.dk/');
        expect(await response.text()).toBe('');
      }
      const write = await gateway.fetch(new Request(origin + '/', { method: 'POST', body: 'demo' }), enabled);
      expect(write.status).toBe(405);
      expect(write.headers.has('Location')).toBe(false);
    }
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
