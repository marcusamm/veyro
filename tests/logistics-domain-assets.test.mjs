import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { fetchLogisticsSite, LOGISTICS_ORIGIN } from '../src/logistics-site';
import { PUBLIC_LOGISTICS_PATHS } from '../src/lib/logistics-seo';

// Exercise the actual Cloudflare asset service. A plain fetch mock cannot catch
// its automatic .html -> extensionless redirects (including our branded 404).
let runtime;
let env;
const request = (path, options = {}) => fetchLogisticsSite(new Request(LOGISTICS_ORIGIN + path, options), env);

beforeAll(() => {
  runtime = new Miniflare(convertV4MiniflareOptions({
    name: 'logistics-native-assets-test',
    modules: true,
    compatibilityDate: '2026-10-01',
    script: 'export default { fetch(request, env) { return env.ASSETS.fetch(request); } };',
    assets: {
      directory: fileURLToPath(new URL('../public/', import.meta.url)),
      binding: 'ASSETS',
      run_worker_first: true,
      routerConfig: { has_user_worker: true },
      assetConfig: { html_handling: 'auto-trailing-slash', not_found_handling: 'none' },
    },
  }));
  env = {
    ASSETS: {
      fetch: req => runtime.dispatchFetch(req.url, { method: req.method, headers: req.headers, redirect: 'manual' }),
    },
    DB: { prepare() { throw new Error('Static routes must not access the database'); } },
  };
});

afterAll(async () => { await runtime?.dispose(); });

describe('Logistics domain with native Cloudflare assets', () => {
  it('documents why the branded error asset must be requested without .html', async () => {
    const redirect = await env.ASSETS.fetch(new Request(LOGISTICS_ORIGIN + '/logistics-site/404.html'));
    expect(redirect.status).toBe(307);
    expect(redirect.headers.get('location')).toBe('/logistics-site/404');
  });

  it.each(PUBLIC_LOGISTICS_PATHS.map(path => path.slice('/logistik'.length)))('serves the generated public page %s', async path => {
    const response = await request(path);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/html');
    expect(response.headers.get('x-robots-tag')).toBeNull();
    expect(response.headers.get('referrer-policy')).toBe('same-origin');
    const html = await response.text();
    expect(html).toContain('Logistikværktøjer');
    expect(html).not.toContain('/logistics-site/');
  });

  it.each(['/mine/', '/vaerktoejer/tco/?saved=test', '/vaerktoejer/eoq/?resume=1'])('keeps private shell %s uncached and unindexed', async path => {
    const response = await request(path);
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.headers.get('x-robots-tag')).toBe('noindex, nofollow');
    expect(response.headers.get('set-cookie')).toBeNull();
    expect(await response.text()).toContain('data-account-origin=""');
  });

  it.each([
    ['/assets/styles.css', 'text/css'],
    ['/assets/account.mjs', 'text/javascript'],
    ['/fonts/instrument-sans-latin-400-normal.woff2', 'font/woff2'],
    ['/downloads/tco.xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'],
    ['/logo.svg', 'image/svg+xml'],
    ['/sitemap.xml', 'application/xml'],
  ])('serves %s with the correct content type', async (path, type) => {
    const response = await request(path);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain(type);
    expect((await response.arrayBuffer()).byteLength).toBeGreaterThan(0);
  });

  it.each(['/unknown', '/assets/missing.mjs', '/api/session', '/admin'])('returns a real branded 404 for %s', async path => {
    const response = await request(path);
    expect(response.status).toBe(404);
    expect(response.headers.get('content-type')).toContain('text/html');
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await response.text()).toContain('<title>Siden findes ikke · Logistikværktøjer</title>');
  });

  it('supports HEAD and conditional asset requests', async () => {
    const response = await request('/assets/styles.css');
    const etag = response.headers.get('etag');
    expect(etag).toBeTruthy();
    await response.arrayBuffer();
    const conditional = await request('/assets/styles.css', { headers: { 'If-None-Match': etag } });
    expect(conditional.status).toBe(304);
    expect(await conditional.text()).toBe('');
    const head = await request('/', { method: 'HEAD' });
    expect(head.status).toBe(200);
    expect(await head.text()).toBe('');
  });
});
