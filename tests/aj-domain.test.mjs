import { describe, expect, it } from 'vitest';
import worker from '../src/index';
import { isAjRequest } from '../src/aj/app';
import { ajOrigin, manageLink } from '../src/aj/store';

const workshop = 'https://aj-auto-slagelse.dk';
const legacy = 'https://aj.veyro.dk';
const www = 'https://www.aj-auto-slagelse.dk';
const insecureWorkshop = 'http://aj-auto-slagelse.dk';

function request(origin, path, options = {}, env = {}) {
  return worker.fetch(new Request(origin + path, options), env, { waitUntil() {} });
}

describe('AJ Auto workshop domains', () => {
  it('dispatches only the exact allowed hosts to the workshop', () => {
    for (const origin of [workshop, www, legacy]) {
      expect(isAjRequest(new Request(origin), {}), origin).toBe(true);
    }
    for (const origin of ['https://aj-auto-slagelse.dk.example.test', 'https://shop.aj-auto-slagelse.dk', 'https://kunde.veyro.dk']) {
      expect(isAjRequest(new Request(origin, { headers: { 'X-Forwarded-Host': 'aj-auto-slagelse.dk' } }), {}), origin).toBe(false);
    }
  });

  it.each([workshop, legacy])('keeps booking, admin and discovery on %s', async origin => {
    const response = await request(origin, '/booking');
    expect(response.status).toBe(200);
    expect(response.headers.get('location')).toBeNull();
    expect(response.headers.get('x-robots-tag')).toBeNull();
    expect(await response.text()).toContain(`<link rel="canonical" href="${origin}/booking">`);

    const robots = await request(origin, '/robots.txt');
    expect(await robots.text()).toContain(`Sitemap: ${origin}/sitemap.xml`);
    const sitemap = await request(origin, '/sitemap.xml');
    const locations = [...(await sitemap.text()).matchAll(/<loc>([^<]+)<\/loc>/g)].map(match => match[1]);
    expect(locations).toContain(origin + '/booking');
    expect(locations.every(address => new URL(address).origin === origin)).toBe(true);

    for (const path of ['/admin', '/booking/aftale']) {
      const privatePage = await request(origin, path);
      expect(privatePage.status, path).toBe(200);
      expect(privatePage.headers.get('x-robots-tag'), path).toContain('noindex');
    }
    expect(manageLink(ajOrigin({}, origin), 'sample-token')).toBe(origin + '/booking/aftale#token=sample-token');
  });

  it.each([www, insecureWorkshop])('redirects reads on %s to the HTTPS apex without losing the deep link', async origin => {
    const path = '/booking/aftale?source=website&next=https%3A%2F%2Fexample.test';
    for (const method of ['GET', 'HEAD']) {
      const response = await request(origin, path, { method, headers: { 'X-Forwarded-Host': 'elsewhere.example.test' } });
      expect(response.status, method).toBe(308);
      expect(response.headers.get('location'), method).toBe(workshop + path);
    }
  });

  it('keeps staff writes on their own origin and never forwards a www write', async () => {
    const path = '/api/admin/logout';
    const post = (target, origin) => request(target, path, {
      method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' }, body: '{}',
    });
    for (const [target, origin] of [[workshop, legacy], [legacy, workshop], [www, www], [insecureWorkshop, insecureWorkshop]]) {
      const denied = await post(target, origin);
      expect(denied.status).toBe(403);
      expect(denied.headers.get('location')).toBeNull();
      expect(denied.headers.get('set-cookie')).toBeNull();
    }
    for (const origin of [workshop, legacy]) {
      const allowed = await post(origin, origin);
      expect(allowed.status).toBe(200);
      expect(await allowed.json()).toEqual({ ok: true });
    }
  });
});
