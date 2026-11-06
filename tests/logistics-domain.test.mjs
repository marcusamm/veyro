import { describe, expect, it, vi } from 'vitest';
import worker from '../src/index';
import { LOGISTICS_ORIGIN, isLogisticsSiteRequest, fetchLogisticsSite } from '../src/logistics-site';

const canonical = 'https://xn--logistikvrktjer-5lb32a.dk';
const aliases = [
  'https://logistikvaerktojer.dk',
  'https://www.logistikvaerktojer.dk',
  'https://www.xn--logistikvrktjer-5lb32a.dk',
];
const publicPages = [
  '/', '/vaerktoejer/', '/excel/', '/om/',
  ...['tco', 'eoq', 'genbestilling', 'abc', 'ladmeter', 'luftfragt', 'palletransport', 'containertransport', 'biltransport']
    .map(tool => `/vaerktoejer/${tool}/`),
];
const branded404 = '<!doctype html><html lang="da"><h1>Den side er ikke på lager.</h1></html>';

function crawlAllowed(robots, path) {
  const matchingRules = [...robots.matchAll(/^(Allow|Disallow): (.+)$/gm)].map(([, action, pattern]) => ({
    allow: action === 'Allow',
    length: pattern.replace(/[$*]/g, '').length,
    expression: new RegExp('^' + pattern.split('*').map(part => part.replace(/[.+?^{}()|[\]\\]/g, '\\$&')).join('.*')),
  })).filter(rule => rule.expression.test(path));
  matchingRules.sort((a, b) => b.length - a.length || Number(b.allow) - Number(a.allow));
  return matchingRules[0]?.allow ?? true;
}

function fixture(assetHandler, accountHandler) {
  const calls = [];
  const db = vi.fn(() => { throw new Error('Public domain must not access the account database'); });
  const env = {
    APP_URL: 'https://kunde.veyro.dk',
    SITE_URL: 'https://veyro.dk',
    SITE_HOSTS: 'veyro.dk,www.veyro.dk,ny.veyro.dk',
    DB: { prepare: db, batch: db, exec: db },
    ASSETS: { fetch: async request => {
      calls.push(request);
      if (assetHandler) return assetHandler(request);
      const pathname = new URL(request.url).pathname;
      return new Response(request.method === 'HEAD' ? null
        : pathname === '/logistics-site/404' ? branded404
        : '<!doctype html><html lang="da"><h1>Logistikværktøjer</h1></html>', {
        headers: { 'Content-Type': 'text/html; charset=utf-8' },
      });
    } },
  };
  const request = (path, options = {}, origin = canonical) => fetchLogisticsSite(new Request(origin + path, options), env, accountHandler);
  return { env, calls, db, request };
}

describe('Dedicated logistics domain boundary', () => {
  it('recognizes only the four owned domain names', () => {
    expect(LOGISTICS_ORIGIN).toBe(canonical);
    for (const origin of [canonical, ...aliases, 'https://logistikværktøjer.dk']) {
      expect(isLogisticsSiteRequest(new Request(origin + '/'))).toBe(true);
    }
    for (const origin of ['https://veyro.dk', 'https://kunde.veyro.dk', 'https://preview.workers.dev',
      'https://logistikvaerktojer.dk.example.com', 'https://other.logistikvaerktojer.dk']) {
      expect(isLogisticsSiteRequest(new Request(origin + '/', {
        headers: { 'X-Forwarded-Host': 'logistikvaerktojer.dk' },
      }))).toBe(false);
    }
  });

  it('dispatches the new homepage before the customer application without DB/session access', async () => {
    const { env, calls, db } = fixture();
    const response = await worker.fetch(new Request(canonical + '/'), env, { waitUntil() {} });
    expect(response.status).toBe(200);
    expect(await response.text()).toContain('Logistikværktøjer');
    expect(calls.map(request => new URL(request.url).pathname)).toEqual(['/logistics-site/']);
    expect(db).not.toHaveBeenCalled();
    expect(response.headers.get('set-cookie')).toBeNull();
  });

  it.each(publicPages)('serves the anonymous page %s with public caching and security headers', async path => {
    const { request, calls, db } = fixture();
    const response = await request(path);
    expect(response.status).toBe(200);
    expect(new URL(calls[0].url).pathname).toBe('/logistics-site' + path);
    expect(response.headers.get('cache-control')).toMatch(/\bpublic\b/);
    expect(response.headers.get('x-robots-tag')).toBeNull();
    expect(response.headers.get('set-cookie')).toBeNull();
    expect(response.headers.get('content-security-policy')).toContain("default-src 'self'");
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    expect(response.headers.get('referrer-policy')).toBe('same-origin');
    expect(response.headers.get('strict-transport-security')).toContain('max-age=');
    expect(db).not.toHaveBeenCalled();
  });

  it.each(aliases)('redirects %s to the fixed canonical origin and retains deep-link query', async alias => {
    const { request, calls, db } = fixture();
    const path = '/vaerktoejer/tco/?utm_source=test&next=https%3A%2F%2Fevil.example';
    const response = await request(path, {}, alias);
    expect(response.status).toBe(308);
    expect(response.headers.get('location')).toBe(canonical + path);
    expect(calls).toHaveLength(0);
    expect(db).not.toHaveBeenCalled();
  });

  it.each([
    ['/vaerktoejer', '/vaerktoejer/'], ['/vaerktoejer/tco', '/vaerktoejer/tco/'],
    ['/excel', '/excel/'], ['/om', '/om/'], ['/index.html', '/'],
    ['/vaerktoejer/tco/index.html', '/vaerktoejer/tco/'],
    ['/logistik', '/'], ['/logistik/', '/'], ['/logistik/vaerktoejer/tco/', '/vaerktoejer/tco/'],
    ['/mine', '/mine/'], ['/logistik/mine/', '/mine/'],
  ])('canonicalizes %s without exposing internal asset paths', async (path, destination) => {
    const { request, calls } = fixture();
    const response = await request(path + '?utm_source=test');
    expect(response.status).toBe(308);
    const target = new URL(response.headers.get('location'), canonical);
    expect(target.href).toBe(canonical + destination + '?utm_source=test');
    expect(target.pathname).not.toContain('/logistics-site');
    expect(calls).toHaveLength(0);
  });

  it.each([
    ['/login', '/login'], ['/login/', '/login'],
    ['/verify', '/verify'], ['/verify/', '/verify'],
  ])('keeps the %s authentication link on the dedicated domain', async (path, destination) => {
    const { request, calls, db } = fixture();
    const response = await request(path + '?token=example-token');
    expect(response.status).toBe(302);
    expect(response.headers.get('location')).toBe(canonical + '/logistik' + destination + '?token=example-token');
    expect(response.headers.get('cache-control')).toContain('no-store');
    expect(response.headers.get('set-cookie')).toBeNull();
    expect(response.headers.get('x-robots-tag')).toContain('noindex');
    expect(calls).toHaveLength(0);
    expect(db).not.toHaveBeenCalled();
  });

  it.each(['saved=example-id', 'resume=1', '%73aved=example-id', 'saved='])('keeps a private editor query (%s) on the same domain without shared caching', async query => {
    const { request, calls, db } = fixture();
    const response = await request('/vaerktoejer/tco/?' + query);
    expect(response.status).toBe(200);
    expect(response.headers.get('location')).toBeNull();
    expect(response.headers.get('cache-control')).toContain('no-store');
    expect(response.headers.get('x-robots-tag')).toContain('noindex');
    expect(calls.map(request => new URL(request.url).pathname)).toEqual(['/logistics-site/vaerktoejer/tco/']);
    expect(new URL(calls[0].url).search).toBe('');
    expect(db).not.toHaveBeenCalled();
  });

  it('serves the identity-free saved-calculations shell on this domain with private caching', async () => {
    const { request, calls, db } = fixture();
    const response = await request('/mine/');
    expect(response.status).toBe(200);
    expect(response.headers.get('location')).toBeNull();
    expect(response.headers.get('cache-control')).toContain('no-store');
    expect(response.headers.get('x-robots-tag')).toContain('noindex');
    expect(response.headers.get('set-cookie')).toBeNull();
    expect(calls.map(request => new URL(request.url).pathname)).toEqual(['/logistics-site/mine/']);
    expect(db).not.toHaveBeenCalled();
  });

  it.each(['/logistik/api/session', '/logistik/api/calculations', '/logistik/api/calculations/example/archive',
    '/logistik/login', '/logistik/verify', '/logistik/logout'])('dispatches only the shared account route %s with the trusted same-origin URL', async path => {
    const returned = new Response('Private account response', {
      headers: {
        'Cache-Control': 'private, no-store', 'X-Robots-Tag': 'noindex, nofollow',
        'Set-Cookie': '__Host-vk_session=test-value; Secure; HttpOnly; SameSite=Lax; Path=/',
      },
    });
    const account = vi.fn(async (request, env) => {
      expect(request.url).toBe(canonical + path);
      expect(request.headers.get('origin')).toBe(canonical);
      expect(request.headers.get('cookie')).toBe('__Host-vk_session=existing');
      expect(await request.text()).toBe('_csrf=existing-csrf');
      expect(env.APP_URL).toBe(canonical);
      expect(env.DB).toBe(state.env.DB);
      return returned;
    });
    const state = fixture(undefined, account);
    const response = await state.request(path, {
      method: 'POST', headers: { Origin: canonical, Cookie: '__Host-vk_session=existing' }, body: '_csrf=existing-csrf',
    });
    expect(response).toBe(returned);
    expect(response.headers.get('set-cookie')).toContain('__Host-vk_session=');
    expect(response.headers.get('cache-control')).toBe('private, no-store');
    expect(response.headers.get('x-robots-tag')).toBe('noindex, nofollow');
    expect(state.env.APP_URL).toBe('https://kunde.veyro.dk');
    expect(account).toHaveBeenCalledTimes(1);
    expect(state.calls).toHaveLength(0);
    expect(state.db).not.toHaveBeenCalled();
  });

  it.each(['/logistik/login-extra', '/logistik/login/other', '/logistik/verify/other',
    '/logistik/logout/other', '/logistik/apiary', '/admin', '/stripe/webhook', '/konto'])('does not forward %s to the shared account app', async path => {
    const account = vi.fn(() => new Response('must not reach account app'));
    const { request, db } = fixture(undefined, account);
    const response = await request(path);
    expect([308, 404]).toContain(response.status);
    expect(account).not.toHaveBeenCalled();
    expect(db).not.toHaveBeenCalled();
  });

  it.each(aliases)('does not forward account POST bodies from noncanonical %s', async alias => {
    const account = vi.fn(() => new Response('must not reach account app'));
    const { request, calls } = fixture(undefined, account);
    const response = await request('/logistik/login', { method: 'POST', body: '_csrf=private' }, alias);
    expect(response.status).toBe(405);
    expect(account).not.toHaveBeenCalled();
    expect(calls).toHaveLength(0);
  });

  it('retains hostile Origin headers so the existing CSRF middleware can reject them', async () => {
    const account = vi.fn((request, env) => {
      expect(request.headers.get('origin')).toBe('https://evil.example');
      expect(request.headers.get('x-forwarded-host')).toBe('evil.example');
      expect(new URL(request.url).origin).toBe(canonical);
      expect(env.APP_URL).toBe(canonical);
      return new Response('Ugyldig anmodning (CSRF).', { status: 403 });
    });
    const { request } = fixture(undefined, account);
    expect((await request('/logistik/api/calculations', {
      method: 'POST', headers: { Origin: 'https://evil.example', 'X-Forwarded-Host': 'evil.example' }, body: '_csrf=example',
    })).status).toBe(403);
    expect(account).toHaveBeenCalledTimes(1);
  });

  it.each(['/admin', '/konto', '/api/session', '/api/calculations', '/webhook',
    '/source-manifest.json', '/does-not-exist/', '/assets/../admin'])('returns a real branded 404 for %s without reaching account handlers', async path => {
    const { request, calls, db } = fixture();
    const response = await request(path);
    expect(response.status).toBe(404);
    expect(await response.text()).toContain('Den side er ikke på lager.');
    expect(calls.map(request => new URL(request.url).pathname)).toEqual(['/logistics-site/404']);
    expect(response.headers.get('x-robots-tag')).toContain('noindex');
    expect(response.headers.get('set-cookie')).toBeNull();
    expect(db).not.toHaveBeenCalled();
  });

  it.each(['POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'])('rejects %s on the public host without reading or forwarding the body', async method => {
    const { request, calls, db } = fixture();
    const response = await request('/login', { method, body: 'private=input' });
    expect(response.status).toBe(405);
    expect(response.headers.get('allow')).toMatch(/GET/);
    expect(response.headers.get('allow')).toMatch(/HEAD/);
    expect(calls).toHaveLength(0);
    expect(db).not.toHaveBeenCalled();
  });

  it.each(['/assets/app.mjs', '/fonts/instrument-sans-latin-400-normal.woff2',
    '/downloads/ladmeter.xlsx', '/logo.svg', '/sitemap.xml'])('maps the public resource %s to the standalone bundle', async path => {
    const { request, calls, db } = fixture();
    expect((await request(path)).status).toBe(200);
    expect(new URL(calls[0].url).pathname).toBe('/logistics-site' + path);
    expect(db).not.toHaveBeenCalled();
  });

  it('keeps HEAD requests bodyless', async () => {
    const { request, calls } = fixture();
    const response = await request('/vaerktoejer/tco/', { method: 'HEAD' });
    expect(response.status).toBe(200);
    expect(await response.text()).toBe('');
    expect(calls[0].method).toBe('HEAD');
  });

  it('rewrites static asset redirects without leaking the internal bundle prefix', async () => {
    const { request } = fixture(() => new Response(null, {
      status: 308, headers: { Location: canonical + '/logistics-site/assets/app.mjs' },
    }));
    const response = await request('/assets/legacy.mjs?utm_source=test');
    expect(response.status).toBe(308);
    expect(new URL(response.headers.get('location'), canonical).href).toBe(canonical + '/assets/app.mjs?utm_source=test');
  });

  it('does not forward incoming identity headers or cookies to the public asset service', async () => {
    const { request, calls, db } = fixture();
    await request('/downloads/ladmeter.xlsx?private=value', {
      headers: { Cookie: '__Host-vk_session=private', Authorization: 'Bearer private', Range: 'bytes=0-99' },
    });
    expect(calls[0].headers.get('cookie')).toBeNull();
    expect(calls[0].headers.get('authorization')).toBeNull();
    expect(calls[0].headers.get('range')).toBe('bytes=0-99');
    expect(new URL(calls[0].url).search).toBe('');
    expect(db).not.toHaveBeenCalled();
  });

  it.each([
    canonical + '/logistics-site/assets/app.mjs',
    'https://external.example/logistics-site/assets/app.mjs',
    canonical + '/admin',
  ])('rejects unsafe or looping asset redirects to %s', async location => {
    const { request } = fixture(assetRequest => new URL(assetRequest.url).pathname === '/logistics-site/404'
      ? new Response(branded404, { headers: { 'Content-Type': 'text/html' } })
      : new Response(null, { status: 308, headers: { Location: location } }));
    const response = await request('/assets/app.mjs');
    expect(response.status).toBe(404);
    expect(response.headers.get('location')).toBeNull();
  });

  it('publishes the new sitemap address and excludes account surfaces from robots', async () => {
    const { request, db } = fixture();
    const response = await request('/robots.txt');
    expect(response.status).toBe(200);
    const robots = await response.text();
    expect(robots).toContain('Sitemap: ' + canonical + '/sitemap.xml');
    expect(robots).not.toContain('https://kunde.veyro.dk');
    for (const path of publicPages) expect(crawlAllowed(robots, path), path).toBe(true);
    for (const path of ['/mine/', '/login', '/verify?token=private', '/api/session', '/admin',
      '/vaerktoejer/tco/?saved=private', '/vaerktoejer/tco/?resume=1', '/source-manifest.json']) {
      expect(crawlAllowed(robots, path), path).toBe(false);
    }
    expect(db).not.toHaveBeenCalled();
  });
});
