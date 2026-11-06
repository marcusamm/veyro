import { readFile, readdir } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import * as miniflare from 'miniflare';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import worker from '../src/index';
import { ANALYTICS_CONSENT_VERSION } from '../src/lib/site-analytics';
import { startMock, RESEND_KEY } from './mock-server.mjs';

const DK = 'https://veyro.dk';
const SE = 'https://veyro.se';
const TEST_PRODUCT = 'local-swedish-test-plan';
let mf, mock, db, env, nextClient = 0;

// Real dispatcher, route middleware, renderer and D1. DNS, production storage,
// payments and real email delivery are never used by this domain integration suite.
class Visitor {
  constructor(origin = SE, country = 'SE') {
    this.origin = origin;
    this.country = country;
    this.cookies = new Map();
    this.ip = `192.0.2.${++nextClient}`;
  }
  async request(path, options = {}) {
    const url = new URL(path, this.origin);
    if (url.origin !== this.origin) throw new Error('Use a separate cookie jar for another origin');
    const headers = new Headers({
      Cookie: [...this.cookies].map(([key, value]) => `${key}=${value}`).join('; '),
      'CF-Connecting-IP': this.ip,
      'User-Agent': 'Veyro domain integration test',
    });
    for (const [key, value] of new Headers(options.headers)) headers.set(key, value);
    const request = new Request(url, { ...options, headers });
    if (this.country !== undefined) Object.defineProperty(request, 'cf', { value: { country: this.country } });
    const pending = [];
    const response = await worker.fetch(request, env, { waitUntil: promise => pending.push(promise) });
    await Promise.all(pending);
    for (const cookie of response.headers.getSetCookie()) {
      const pair = cookie.split(';')[0], separator = pair.indexOf('=');
      const key = pair.slice(0, separator), value = pair.slice(separator + 1);
      if (!value || /Max-Age=0/i.test(cookie)) this.cookies.delete(key);
      else this.cookies.set(key, value);
    }
    return { status: response.status, headers: response.headers, html: await response.text() };
  }
  get(path, headers = {}) { return this.request(path, { headers }); }
  post(path, body, extraHeaders = {}) {
    return this.request(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Origin: this.origin, ...extraHeaders },
      body: new URLSearchParams(body),
    });
  }
}

function target(response, origin) {
  expect(response.headers.get('location')).toBeTruthy();
  return new URL(response.headers.get('location'), origin);
}

function contactFields(html, fields = {}) {
  const formId = html.match(/id="(Contact-[^"]+)"/)?.[1];
  expect(formId).toBeTruthy();
  const start = html.indexOf(`id="${formId}"`);
  const form = html.slice(start, html.indexOf('</form>', start));
  const returnTo = form.match(/name="return_to" value="([^"]+)"/)?.[1];
  expect(returnTo).toBe('/pages/kontakt');
  expect(form).toContain('name="site_language" value="sv"');
  return { form_type: 'contact', form_id: formId, return_to: returnTo, site_language: 'sv', website_url: '', ...fields };
}

const emails = async () => (await fetch(`${mock.url}/__mock/emails`)).json();
const count = async table => (await db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).first()).n;
const schemas = html => [...html.matchAll(/<script\b[^>]*type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/g)].map(match => JSON.parse(match[1]));

beforeAll(async () => {
  const options = {
    modules: true, compatibilityDate: '2026-10-01',
    script: 'export default { fetch() { return new Response("Local D1 only"); } };',
    d1Databases: { DB: 'swedish-marketing-domain-tests' },
  };
  mf = new miniflare.Miniflare(miniflare.convertV4MiniflareOptions ? miniflare.convertV4MiniflareOptions(options) : options);
  db = await mf.getD1Database('DB');
  const migrations = new URL('../migrations/', import.meta.url);
  for (const name of (await readdir(migrations)).filter(name => name.endsWith('.sql')).sort()) {
    await db.exec((await readFile(new URL(name, migrations), 'utf8')).replace(/--[^\n]*/g, '').replace(/\s+/g, ' ').trim());
  }
  // Production's historical starter/business/premium products are deliberately
  // drafts. Exercise the supported cart with an explicitly published local fixture.
  await db.prepare('INSERT INTO site_content (key, value, updated_at, updated_by) VALUES (?, ?, ?, ?)').bind(
    `product:${TEST_PRODUCT}`,
    JSON.stringify({ handle: TEST_PRODUCT, title: 'LOCAL TEST Svenskt abonnemang', type: 'Abonnement', price: 59900, interval: 'month', status: 'active', description: 'LOCAL TEST Publicerat abonnemang för domäntest.' }),
    Date.now(), 'local-domain-integration-test',
  ).run();
  mock = await startMock();
  env = {
    DB: db, APP_URL: 'https://kunde.veyro.dk', SITE_URL: DK,
    SITE_HOSTS: 'veyro.dk,www.veyro.dk,veyro.se,www.veyro.se,ny.veyro.dk,localhost',
    ADMIN_EMAILS: '', DEV_MODE: '1', NOTIFY_EMAIL: 'local-domain-notifications@example.test',
    RESEND_API_KEY: RESEND_KEY, RESEND_API_BASE: mock.url,
    STRIPE_SECRET_KEY: 'sk_test_unused', STRIPE_WEBHOOK_SECRET: 'whsec_unused',
    PRICE_STARTER: 'price_test_starter', PRICE_BUSINESS: 'price_test_business', PRICE_PREMIUM: 'price_test_premium',
  };
});

afterAll(async () => { await mock?.close(); await mf?.dispose(); });

describe('Swedish public domain routing and SEO', () => {
  it.each([
    ['SE', 'da'], ['DK', 'en'], ['US', 'da'], [undefined, 'en'],
  ])('serves Swedish at the root despite country %s and preference %s', async (country, preference) => {
    const visitor = new Visitor(SE, country);
    visitor.cookies.set('veyro_language', preference);
    const response = await visitor.get('/');
    expect(response.status).toBe(200);
    expect(response.headers.get('content-language')).toBe('sv');
    expect(response.headers.get('x-robots-tag')).toBeNull();
    expect(response.html).toContain('<html class="no-js" lang="sv">');
    expect(response.html).toContain('299 SEK');
    expect(response.html).toContain(`<link rel="canonical" href="${SE}/">`);
    expect(response.html).toContain('<meta property="og:locale" content="sv_SE">');
  });

  it.each([
    ['https://www.veyro.se', '/pages/priser?utm_source=test', SE + '/pages/priser?utm_source=test'],
    [DK, '/sv', SE + '/'],
    [DK, '/sv/', SE + '/'],
    [DK, '/sv/pages/priser?ydelse=webshop&webshop_niveau=120', SE + '/pages/priser?ydelse=webshop&webshop_niveau=120'],
    [SE, '/sv/pages/priser?utm_source=test', SE + '/pages/priser?utm_source=test'],
    [SE, '/en/pages/priser?utm_source=test', DK + '/en/pages/priser?utm_source=test'],
  ])('permanently canonicalizes %s%s', async (origin, path, expected) => {
    const response = await new Visitor(origin).get(path);
    expect(response.status).toBe(301);
    expect(target(response, origin).href).toBe(expected);
  });

  it('routes a Swedish visitor from .dk directly to .se without saving an automatic preference', async () => {
    const visitor = new Visitor(DK, 'SE');
    const response = await visitor.get('/pages/webshop?webshop_niveau=120');
    expect(response.status).toBe(302);
    expect(target(response, DK).href).toBe(SE + '/pages/webshop?webshop_niveau=120');
    expect(response.headers.get('cache-control')).toContain('no-store');
    expect(visitor.cookies.has('veyro_language')).toBe(false);
  });

  it.each(['da', 'en'])('switches to %s on .dk and consumes the preference there without a country loop', async language => {
    const swedish = new Visitor(SE, 'SE');
    const first = await swedish.get(`/pages/kontakt?lang=${language}&ydelse=pakke-webshop&webshop_niveau=120`);
    expect(first.status).toBe(302);
    const destination = target(first, SE);
    expect(destination.origin).toBe(DK);
    expect(destination.pathname).toBe(`${language === 'en' ? '/en' : ''}/pages/kontakt`);
    expect(destination.searchParams.get('lang')).toBe(language);
    expect(destination.searchParams.get('webshop_niveau')).toBe('120');
    const danishDomain = new Visitor(DK, 'SE');
    const consumed = await danishDomain.get(destination.href);
    expect(consumed.status).toBe(302);
    expect(danishDomain.cookies.get('veyro_language')).toBe(language);
    const clean = target(consumed, DK);
    expect(clean.origin).toBe(DK);
    expect(clean.searchParams.has('lang')).toBe(false);
    const page = await danishDomain.get(clean.href);
    expect(page.status).toBe(200);
    expect(page.headers.get('content-language')).toBe(language);
    expect(page.html).toContain('value="120" selected');
  });

  it('uses matching canonical, OG, hreflang and business identities on Swedish service pages', async () => {
    const response = await new Visitor().get('/pages/hosting');
    expect(response.status).toBe(200);
    expect(response.html).toContain(`<link rel="canonical" href="${SE}/pages/hosting">`);
    expect(response.html).toContain(`<meta property="og:url" content="${SE}/pages/hosting">`);
    for (const [language, url] of [['da', DK + '/pages/hosting'], ['en', DK + '/en/pages/hosting'], ['sv', SE + '/pages/hosting']]) {
      expect(response.html).toContain(`hreflang="${language}" href="${url}"`);
    }
    expect(response.html).not.toMatch(/href="(?:https:\/\/veyro\.se)?\/sv(?:\/|\?)/);
    const data = schemas(response.html);
    expect(data.find(item => item['@type'] === 'Service')).toMatchObject({ url: SE + '/pages/hosting', provider: { '@id': DK + '/#organization' } });
    expect(data.find(item => item['@type'] === 'ProfessionalService')).toMatchObject({ '@id': DK + '/#organization', address: { addressCountry: 'DK' } });
    expect(data.find(item => item['@type'] === 'BreadcrumbList').itemListElement.map(item => item.item)).toEqual([
      SE + '/', SE + '/pages/ydelser', SE + '/pages/hosting',
    ]);
  });

  it.each([DK, SE])('publishes own-domain sitemap locations and reciprocal language alternates on %s', async origin => {
    const visitor = new Visitor(origin);
    const sitemap = await visitor.get('/sitemap.xml');
    expect(sitemap.status).toBe(200);
    const locations = [...sitemap.html.matchAll(/<loc>([^<]+)<\/loc>/g)].map(match => new URL(match[1]));
    expect(locations.length).toBeGreaterThan(10);
    expect(locations.every(url => url.origin === origin)).toBe(true);
    expect(locations.some(url => /^\/sv(?:\/|$)/.test(url.pathname))).toBe(false);
    if (origin === SE) expect(locations.some(url => /^\/en(?:\/|$)/.test(url.pathname))).toBe(false);
    else expect(locations.some(url => url.pathname === '/en/')).toBe(true);
    for (const [language, url] of [['da', DK + '/'], ['en', DK + '/en/'], ['sv', SE + '/']]) {
      expect(sitemap.html).toContain(`hreflang="${language}" href="${url}"`);
    }
    const robots = await visitor.get('/robots.txt');
    expect(robots.html).toContain(`Sitemap: ${origin}/sitemap.xml`);
    expect(robots.html).not.toMatch(/^Disallow: \/$/m);
  });

  it('keeps preview hosts noindex with their existing language paths', async () => {
    const preview = new Visitor('https://ny.veyro.dk', 'DK');
    const response = await preview.get('/sv/pages/priser');
    expect(response.status).toBe(200);
    expect(response.headers.get('content-language')).toBe('sv');
    expect(response.headers.get('x-robots-tag')).toContain('noindex');
    expect((await preview.get('/robots.txt')).html).toContain('Disallow: /');
  });

  it('returns a Swedish 404 without interpreting prefix lookalikes as language routes', async () => {
    for (const path of ['/missing-domain-test', '/svenska']) {
      const response = await new Visitor().get(path);
      expect(response.status).toBe(404);
      expect(response.headers.get('content-language')).toBe('sv');
      expect(response.html).toContain('Sidan finns inte');
    }
  });

  it('accepts consented same-origin Swedish analytics while keeping the Swedish report path distinct', async () => {
    const visitor = new Visitor();
    const page = await visitor.get('/pages/priser');
    expect(page.html).toContain('data-analytics-page="true"');
    expect(visitor.cookies.has('__Host-veyro_visitor')).toBe(false);
    const before = await count('site_analytics_pageviews');
    const event = { type: 'pageview', eventId: randomUUID(), path: '/pages/priser', consent: true, consentVersion: ANALYTICS_CONSENT_VERSION };
    const postEvent = (body, headers = {}) => visitor.request('/analytics/events', {
      method: 'POST', headers: { Origin: SE, 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body),
    });
    expect((await postEvent({ ...event, consent: false })).status).toBe(204);
    expect(await count('site_analytics_pageviews')).toBe(before);
    const accepted = await postEvent(event);
    expect(accepted.status, accepted.html).toBe(200);
    expect(JSON.parse(accepted.html)).toEqual({ accepted: true });
    expect(await db.prepare('SELECT path FROM site_analytics_pageviews WHERE id = ?').bind(event.eventId).first()).toEqual({ path: '/sv/pages/priser' });
    const tracking = accepted.headers.getSetCookie().filter(cookie => cookie.startsWith('__Host-veyro_'));
    expect(tracking).toHaveLength(2);
    for (const cookie of tracking) {
      expect(cookie).toMatch(/Secure/);
      expect(cookie).toMatch(/HttpOnly/);
      expect(cookie).not.toMatch(/Domain=/i);
    }
    expect((await postEvent({ ...event, eventId: randomUUID() }, { Origin: DK })).status).toBe(403);
    expect(await count('site_analytics_pageviews')).toBe(before + 1);
  });
});

describe('Swedish same-origin enquiry and cart flows', () => {
  it('saves and emails Swedish webshop pricing while retaining the canonical internal DKK amount', async () => {
    const visitor = new Visitor(), email = 'local-swedish-webshop@example.test';
    const before = await count('subscriptions');
    const page = await visitor.get('/pages/kontakt?ydelse=pakke-webshop&webshop_niveau=120');
    expect(page.html).toContain('599 SEK');
    expect(page.html).toContain('value="120" selected');
    const result = await visitor.post('/contact', contactFields(page.html, {
      'contact[name]': 'LOCAL TEST Svensk kund', 'contact[email]': email,
      'contact[Samtykke]': 'Ja', 'contact[Ydelse]': 'Pakke: Webshop', 'contact[Webshopniveau]': '120',
      'contact[body]': 'LOCAL TEST Förfrågan om en webbshop.',
      'contact[Vist webshoppris]': '1 SEK', 'contact[Webshoppris DKK ekskl. moms]': '1 kr.',
    }));
    expect(result.status).toBe(303);
    const destination = target(result, SE);
    expect(destination.origin).toBe(SE);
    expect(destination.pathname).toBe('/pages/kontakt');
    expect(destination.searchParams.get('kontakt')).toBe('ok');
    const thanks = await visitor.get(destination.href);
    expect(thanks.status).toBe(200);
    expect(thanks.headers.get('content-language')).toBe('sv');
    const lead = await db.prepare('SELECT * FROM leads WHERE email = ?').bind(email).first();
    expect(JSON.parse(lead.fields)).toMatchObject({ 'Webshopniveau-id': '120', 'Webshoppris DKK ekskl. moms': '399 kr./md. ekskl. moms' });
    expect(JSON.parse(lead.fields)['Vist webshoppris']).toContain('599 SEK');
    const mail = (await emails()).find(item => item.reply_to === email);
    expect(mail.text).toContain('599 SEK');
    expect(mail.text).toContain('399 kr./md. ekskl. moms');
    expect(await count('subscriptions')).toBe(before);
  });

  it('keeps Swedish error copy, submitted content and tier selection on validation errors', async () => {
    const visitor = new Visitor();
    const page = await visitor.get('/pages/kontakt');
    const result = await visitor.post('/contact', contactFields(page.html, {
      'contact[name]': 'LOCAL TEST Behåll', 'contact[email]': 'invalid-email',
      'contact[Samtykke]': 'Ja', 'contact[Ydelse]': 'Pakke: Webshop', 'contact[Webshopniveau]': '120',
      'contact[body]': 'LOCAL TEST Behåll denna förfrågan.',
    }));
    expect(result.status).toBe(422);
    expect(result.headers.get('content-language')).toBe('sv');
    expect(result.html).toContain('name="return_to" value="/pages/kontakt"');
    expect(result.html).toContain('value="120" selected');
    expect(result.html).toContain('LOCAL TEST Behåll denna förfrågan.');
    expect(result.html).not.toContain('Indtast en gyldig e-mailadresse');
  });

  it('rejects cross-origin enquiry/cart submissions even from the Danish Veyro host', async () => {
    const visitor = new Visitor();
    const page = await visitor.get('/pages/kontakt');
    const before = await count('leads');
    for (const origin of [DK, 'https://example.invalid']) {
      const rejected = await visitor.post('/contact', contactFields(page.html, {
        'contact[email]': 'local-rejected-sweden@example.test', 'contact[Samtykke]': 'Ja',
      }), { Origin: origin });
      expect(rejected.status).toBe(403);
      expect((await visitor.post('/cart/add', { id: TEST_PRODUCT, site_language: 'sv' }, { Origin: origin })).status).toBe(403);
    }
    expect(await count('leads')).toBe(before);
    expect(visitor.cookies.has('veyro_cart')).toBe(false);
  });

  it('keeps product, add, update, change and clear operations on Swedish root URLs', async () => {
    const shopper = new Visitor();
    const product = await shopper.get(`/products/${TEST_PRODUCT}`);
    expect(product.status).toBe(200);
    expect(product.html).toContain('name="site_language" value="sv"');
    expect(product.html).toContain('SEK');
    // Domain is authoritative even if a stale form sends an obsolete language.
    const added = await shopper.post('/cart/add', { id: TEST_PRODUCT, quantity: '1', site_language: 'da' });
    expect(added.status).toBe(303);
    expect(target(added, SE).href).toBe(SE + '/cart');
    const cart = await shopper.get('/cart');
    expect(cart.headers.get('content-language')).toBe('sv');
    expect(cart.headers.get('x-robots-tag')).toContain('noindex');
    expect(cart.html).toContain('SEK');
    expect(cart.html).toContain('href="/cart/change?line=1&quantity=0"');
    const updated = await shopper.post('/cart/update', { 'updates[]': '2', site_language: 'sv' });
    expect(target(updated, SE).href).toBe(SE + '/cart');
    expect((await shopper.get('/cart')).html).toMatch(/site-header__count[^>]*>2</);
    const changed = await shopper.get('/cart/change?line=1&quantity=0');
    expect(target(changed, SE).href).toBe(SE + '/cart');
    expect(shopper.cookies.has('veyro_cart')).toBe(false);
    await shopper.post('/cart/add', { id: TEST_PRODUCT });
    const cleared = await shopper.post('/cart/clear', {});
    expect(target(cleared, SE).href).toBe(SE + '/cart');
    expect(shopper.cookies.has('veyro_cart')).toBe(false);
  });
});
