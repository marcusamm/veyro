import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import worker from '../src/index';
import { logisticsRobots, publicLogisticsRequest } from '../src/lib/logistics-seo';

const origin = 'https://kunde.veyro.dk';
const sitemap = readFileSync(new URL('../public/logistik/sitemap.xml', import.meta.url), 'utf8');
const paths = [...sitemap.matchAll(/<loc>([^<]+)<\/loc>/g)].map(match => new URL(match[1]).pathname);
const closed = 'User-agent: *\nDisallow: /\n';

// Evaluate standard wildcard/end-anchor and longest-match robots precedence,
// independently of the app's request classification.
function allowed(robots, path) {
  const rules = [...robots.matchAll(/^(Allow|Disallow): (.+)$/gm)].map(([, action, pattern]) => ({
    allow: action === 'Allow', length: pattern.replace(/[$*]/g, '').length,
    regex: new RegExp('^' + pattern.split('*').map(part => part.replace(/[.+?^{}()|[\]\\]/g, '\\$&')).join('.*')),
  })).filter(rule => rule.regex.test(path)).sort((a, b) => b.length - a.length || Number(b.allow) - Number(a.allow));
  return rules[0]?.allow ?? true;
}

const environment = {
  APP_URL: origin, SITE_HOSTS: 'veyro.dk,www.veyro.dk,ny.veyro.dk', SITE_URL: 'https://veyro.dk',
  ASSETS: { fetch: async () => new Response('<!doctype html><html><h1>Anonymous calculator shell</h1></html>', { headers: { 'Content-Type': 'text/html' } }) },
};
const request = (path, host = origin, overrides = {}, headers = {}) => worker.fetch(
  new Request(host + path, { headers }), { ...environment, ...overrides }, { waitUntil() {} },
);

describe('Public logistics crawl boundary', () => {
  const robots = logisticsRobots(new URL(origin + '/robots.txt'), origin);

  it('allows every canonical page in the published sitemap, using exact route rules', () => {
    expect(paths).toHaveLength(13);
    for (const path of paths) {
      expect(robots).toContain(`Allow: ${path}$\n`);
      expect(allowed(robots, path), path).toBe(true);
      expect(publicLogisticsRequest(new URL(origin + path), origin), path).toBe(true);
      expect(allowed(robots, path + 'private'), path).toBe(false);
    }
    expect(robots).toContain(`Sitemap: ${origin}/logistik/sitemap.xml\n`);
  });

  it.each([
    '/logistik/assets/styles.css', '/logistik/assets/app.mjs', '/logistik/assets/calculations.mjs',
    '/logistik/fonts/instrument-sans-latin-400-normal.woff2', '/logistik/logo.svg',
    '/logistik/downloads/tco.xlsx', '/logistik/downloads/ladmeter.xlsx', '/logistik/sitemap.xml',
  ])('allows the public resource %s', path => {
    expect(allowed(robots, path)).toBe(true);
    expect(publicLogisticsRequest(new URL(origin + path), origin)).toBe(true);
  });

  it.each([
    '/', '/konto', '/login', '/admin', '/tools', '/static/app.js',
    '/logistik/mine/', '/logistik/mine/private', '/logistik/login', '/logistik/verify?token=private',
    '/logistik/logout', '/logistik/api/session', '/logistik/api/calculations', '/logistik/api/calculations/private',
    '/logistik/source-manifest.json', '/logistik/vaerktoejer/not-a-public-tool/',
    '/logistik/vaerktoejer/tco/?saved=private-id', '/logistik/vaerktoejer/tco/?resume=1',
    '/logistik/vaerktoejer/tco/?utm_source=email&saved=private-id',
  ])('keeps %s outside the public crawl boundary', path => {
    expect(allowed(robots, path)).toBe(false);
    expect(publicLogisticsRequest(new URL(origin + path), origin)).toBe(false);
  });

  it.each(['https://preview.workers.dev', 'https://ny.veyro.dk', 'http://localhost:8787', 'https://kunde.veyro.dk.example.com'])('blocks all crawling on %s', host => {
    expect(logisticsRobots(new URL(host + '/robots.txt'), origin)).toBe(closed);
    expect(publicLogisticsRequest(new URL(host + '/logistik/'), origin)).toBe(false);
  });

  it.each(['', undefined, 'not a URL'])('fails closed without a valid canonical APP_URL (%s)', appUrl => {
    expect(logisticsRobots(new URL(origin + '/robots.txt'), appUrl)).toBe(closed);
    expect(publicLogisticsRequest(new URL(origin + '/logistik/'), appUrl)).toBe(false);
  });
});

describe('Worker robots and indexing headers without database/session access', () => {
  it('publishes root rules and leaves the sales website robots policy unchanged', async () => {
    const response = await request('/robots.txt');
    expect(response.status).toBe(200);
    expect(await response.text()).toBe(logisticsRobots(new URL(origin), origin));
    expect(response.headers.get('set-cookie')).toBeNull();
    const sales = await request('/robots.txt', 'https://veyro.dk');
    expect(sales.status).toBe(200);
    expect(await sales.text()).toBe('User-agent: *\nDisallow: /contact\n\nSitemap: https://veyro.dk/sitemap.xml\n');
    expect(sales.headers.get('x-robots-tag')).toBeNull();
  });

  it.each(paths)('serves the anonymous public page %s without noindex or identity cookies', async path => {
    const response = await request(path);
    expect(response.status).toBe(200);
    expect(response.headers.get('x-robots-tag')).toBeNull();
    expect(response.headers.get('set-cookie')).toBeNull();
    expect(response.headers.get('cache-control')).toBe('public, max-age=300');
  });

  it.each([
    '/logistik/mine/', '/logistik/vaerktoejer/tco/?saved=private-id',
    '/logistik/vaerktoejer/tco/?resume=1', '/logistik/vaerktoejer/tco/?saved=',
    '/logistik/vaerktoejer/tco/?%73aved=private-id',
  ])('adds noindex and no-store for the private shell/view %s', async path => {
    const response = await request(path);
    expect(response.status).toBe(200);
    expect(response.headers.get('x-robots-tag')).toBe('noindex, nofollow');
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.headers.get('set-cookie')).toBeNull();
    expect(await response.text()).not.toContain('private-id');
  });

  it('blocks a Worker preview in robots and headers even when forwarded headers claim the canonical host', async () => {
    const host = 'https://preview.workers.dev';
    const headers = { 'X-Forwarded-Host': 'kunde.veyro.dk', 'X-Forwarded-Proto': 'https' };
    const robots = await request('/robots.txt', host, {}, headers);
    expect(await robots.text()).toBe(closed);
    const page = await request('/logistik/', host, {}, headers);
    expect(page.headers.get('x-robots-tag')).toBe('noindex, nofollow');
    const marketingPreview = await request('/robots.txt', 'https://ny.veyro.dk');
    expect(await marketingPreview.text()).toBe(closed);
    expect(marketingPreview.headers.get('x-robots-tag')).toBe('noindex, nofollow');
  });
});
