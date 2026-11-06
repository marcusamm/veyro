import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import * as miniflare from 'miniflare';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import worker from '../src/index';
import { SAMPLES } from '../src/lib/logistics-calculations.mjs';
import { canonicalizeInput } from '../src/lib/logistics-input.mjs';
import { startMock, RESEND_KEY } from './mock-server.mjs';

const ORIGIN = 'https://xn--logistikvrktjer-5lb32a.dk';
const PORTAL = 'https://kunde.veyro.dk';
const TEST_EMAIL = suffix => `logistics-domain-${suffix}@example.com`;
const input = canonicalizeInput('eoq', SAMPLES.eoq);
const hash = value => createHash('sha256').update(value).digest('hex');
const csrfFrom = html => html.match(/name="_csrf" value="([^"]+)"/)?.[1];
let mf, mock, env, db, clientNumber = 0;

// Exercise the real dispatcher, auth middleware and D1 queries at their real HTTPS
// origins. Only assets and email delivery are local; no customer or live provider is used.
class DomainClient {
  constructor(origin = ORIGIN) {
    this.origin = origin;
    this.cookies = new Map();
    this.ip = `192.0.2.${++clientNumber}`;
  }
  async request(path, options = {}) {
    const url = new URL(path, this.origin);
    // This client is deliberately host-scoped, like __Host- cookies in a browser.
    if (url.origin !== this.origin) throw new Error('Use a separate cookie jar for another origin');
    const headers = new Headers({ Cookie: [...this.cookies].map(([key, value]) => `${key}=${value}`).join('; '), 'CF-Connecting-IP': this.ip });
    for (const [key, value] of new Headers(options.headers)) headers.set(key, value);
    const pending = [];
    const res = await worker.fetch(new Request(url, { ...options, headers }), env, { waitUntil: promise => pending.push(promise) });
    await Promise.all(pending);
    for (const cookie of res.headers.getSetCookie()) {
      const [pair] = cookie.split(';'), separator = pair.indexOf('=');
      const key = pair.slice(0, separator), value = pair.slice(separator + 1);
      if (/Max-Age=0/i.test(cookie) || !value) this.cookies.delete(key);
      else this.cookies.set(key, value);
    }
    const html = await res.text();
    return { status: res.status, headers: res.headers, html, json: () => JSON.parse(html) };
  }
  get(path) { return this.request(path); }
  post(path, fields, extraHeaders = {}) {
    return this.request(path, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', Origin: this.origin, ...extraHeaders }, body: new URLSearchParams(fields) });
  }
}

const session = async client => (await client.get('/logistik/api/session')).json();
const customer = email => db.prepare('SELECT * FROM customers WHERE email = ?').bind(email).first();
const count = async table => (await db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).first()).n;
const emails = async () => (await fetch(`${mock.url}/__mock/emails`)).json();
const post = async (client, path, fields = {}, headers = {}) => client.post(path, { _csrf: (await session(client)).csrf, ...fields }, headers);
async function requestLink(email, name = 'TEST Domain User') {
  const client = new DomainClient(), page = await client.get('/logistik/login');
  const sent = await client.post('/logistik/login', { _csrf: csrfFrom(page.html), name, email });
  expect(sent.status, sent.html).toBe(200);
  const mail = (await emails()).filter(item => item.to.includes(email)).at(-1);
  expect(mail).toBeDefined();
  const link = new URL(mail.text.match(/https:\/\/\S+\/logistik\/verify\?token=\S+/)[0]);
  expect(link.origin).toBe(ORIGIN);
  expect(mail.html).toContain(link.href);
  expect(env.APP_URL).toBe(PORTAL);
  return { client, mail, link, token: link.searchParams.get('token') };
}
async function confirm(flow) {
  const page = await flow.client.get(flow.link.href);
  expect(page.status, page.html).toBe(200);
  return flow.client.post('/logistik/verify', { _csrf: csrfFrom(page.html), token: flow.token });
}
async function signup(email, name) {
  const flow = await requestLink(email, name), response = await confirm(flow);
  expect(response.status, response.html).toBe(303);
  expect(response.headers.get('location')).toBe('/logistik/mine/');
  return flow;
}
async function save(client, name = 'TEST Dedicated-domain calculation') {
  const response = await post(client, '/logistik/api/calculations', { toolId: 'eoq', name, input: JSON.stringify(input) });
  expect(response.status, response.html).toBe(201);
  return response.json().calculation;
}
async function portalLogin(email) {
  const client = new DomainClient(PORTAL), page = await client.get('/login');
  expect((await session(client)).authenticated).toBe(false);
  const sent = await client.post('/login', { _csrf: csrfFrom(page.html), email, kundepanel: '1' });
  expect(sent.status, sent.html).toBe(200);
  const mail = (await emails()).filter(item => item.to.includes(email) && item.text.includes('/login/bekraeft?token=')).at(-1);
  const link = new URL(mail.text.match(/https:\/\/\S+\/login\/bekraeft\?token=\S+/)[0]);
  expect(link.origin).toBe(PORTAL);
  const confirmation = await client.get(link.href);
  const loggedIn = await client.post('/login/bekraeft', { _csrf: csrfFrom(confirmation.html), token: link.searchParams.get('token') });
  expect(loggedIn.status, loggedIn.html).toBe(303);
  expect(loggedIn.headers.get('location')).toBe('/konto');
  return client;
}

beforeAll(async () => {
  const options = {
    modules: true, compatibilityDate: '2026-10-01',
    script: 'export default { fetch() { return new Response("D1 test binding"); } };',
    d1Databases: { DB: 'logistics-domain-auth-tests' },
  };
  // The installed Wrangler may provide Miniflare 4 or its 5 compatibility bridge.
  mf = new miniflare.Miniflare(miniflare.convertV4MiniflareOptions ? miniflare.convertV4MiniflareOptions(options) : options);
  db = await mf.getD1Database('DB');
  const migrations = new URL('../migrations/', import.meta.url);
  for (const name of (await readdir(migrations)).filter(name => name.endsWith('.sql')).sort()) {
    // D1 exec executes one line at a time. Flatten migration SQL after removing
    // line comments so multi-line statements and triggers stay intact.
    const sql = (await readFile(new URL(name, migrations), 'utf8')).replace(/--[^\n]*/g, '').replace(/\s+/g, ' ').trim();
    await db.exec(sql);
  }
  mock = await startMock();
  env = {
    DB: db, APP_URL: PORTAL, SITE_HOSTS: 'veyro.dk,www.veyro.dk', SITE_URL: 'https://veyro.dk',
    ADMIN_EMAILS: '', DEV_MODE: '1', RESEND_API_KEY: RESEND_KEY, RESEND_API_BASE: mock.url,
    STRIPE_SECRET_KEY: 'sk_test_unused', STRIPE_WEBHOOK_SECRET: 'whsec_unused',
    PRICE_STARTER: 'price_test_starter', PRICE_BUSINESS: 'price_test_business', PRICE_PREMIUM: 'price_test_premium',
    ASSETS: { async fetch(request) {
      const url = new URL(request.url);
      const relative = url.pathname.replace(/^\//, '') + (url.pathname.endsWith('/') ? 'index.html' : '');
      const file = new URL(`../public/${relative}`, import.meta.url);
      if (!fileURLToPath(file).startsWith(fileURLToPath(new URL('../public/', import.meta.url)))) return new Response(null, { status: 404 });
      try {
        const contents = await readFile(file);
        return new Response(contents, { headers: { 'Content-Type': relative.endsWith('.html') ? 'text/html; charset=utf-8' : 'text/javascript; charset=utf-8' } });
      } catch { return new Response(null, { status: 404 }); }
    } },
  };
});
afterAll(async () => { await mock?.close(); await mf?.dispose(); });

describe('Dedicated logistics domain with shared Veyro accounts', () => {
  it('serves guest calculators and a private account shell without saving identity or calculations', async () => {
    const guest = new DomainClient(), customersBefore = await count('customers'), savesBefore = await count('logistics_calculations');
    for (const path of ['/', '/vaerktoejer/eoq/', '/mine/', '/vaerktoejer/eoq/?saved=unknown', '/vaerktoejer/eoq/?resume=test']) {
      const response = await guest.get(path);
      expect(response.status, path).toBe(200);
      expect(response.headers.get('set-cookie')).toBeNull();
      if (path.includes('mine') || path.includes('?')) {
        expect(response.headers.get('cache-control')).toBe('no-store');
        expect(response.headers.get('x-robots-tag')).toContain('noindex');
      }
    }
    expect(await session(guest)).toMatchObject({ authenticated: false, email: null });
    expect((await guest.get('/logistik/api/calculations')).status).toBe(401);
    expect((await post(guest, '/logistik/api/calculations', { toolId: 'eoq', name: 'TEST Guest', input: JSON.stringify(input) })).status).toBe(401);
    expect(await count('customers')).toBe(customersBefore);
    expect(await count('logistics_calculations')).toBe(savesBefore);
  });

  it('emails the canonical domain and creates an account only after confirmation POST', async () => {
    const email = TEST_EMAIL('confirmation'), flow = await requestLink(email, 'TEST Confirmed User');
    expect(await customer(email)).toBeNull();
    const before = await count('sessions');
    for (let scan = 0; scan < 2; scan++) {
      const response = await flow.client.get(flow.link.href);
      expect(response.status).toBe(200);
      expect(response.html).toContain('action="/logistik/verify"');
      expect(await customer(email)).toBeNull();
      expect((await db.prepare('SELECT used_at FROM login_tokens WHERE token_hash = ?').bind(hash(flow.token)).first()).used_at).toBeNull();
    }
    expect(await count('sessions')).toBe(before);
    const verified = await confirm(flow);
    expect(verified.status, verified.html).toBe(303);
    const cookies = verified.headers.getSetCookie().filter(value => value.startsWith('__Host-vk_session='));
    expect(cookies).toHaveLength(1);
    expect(cookies[0]).toMatch(/Path=\//i);
    expect(cookies[0]).toMatch(/Secure/i);
    expect(cookies[0]).toMatch(/HttpOnly/i);
    expect(cookies[0]).toMatch(/SameSite=Lax/i);
    expect(cookies[0]).not.toMatch(/Domain=/i);
    expect(await customer(email)).toMatchObject({ name: 'TEST Confirmed User', stripe_customer_id: null });
    expect(await session(flow.client)).toMatchObject({ authenticated: true, email });
    const destination = await flow.client.get(verified.headers.get('location'));
    expect(destination.status).toBe(308);
    expect(destination.headers.get('location')).toBe(`${ORIGIN}/mine/`);
  });

  it('saves and retrieves the same calculation from new-domain login and ordinary Veyro login', async () => {
    const email = TEST_EMAIL('shared'), { client } = await signup(email);
    const originalCustomer = await customer(email), calculation = await save(client);
    const retrieved = await client.get(`/logistik/api/calculations/${calculation.id}`);
    expect(retrieved.status).toBe(200);
    expect(retrieved.json().calculation).toMatchObject({ id: calculation.id, input, name: 'TEST Dedicated-domain calculation' });
    expect(retrieved.headers.get('cache-control')).toBe('private, no-store');
    expect(retrieved.headers.get('x-robots-tag')).toContain('noindex');
    // Shared account/data is not cross-domain cookie SSO: this new cookie jar
    // must complete its own normal Veyro login before it can read the record.
    const portal = await portalLogin(email);
    expect(portal.cookies.get('__Host-vk_session')).not.toBe(client.cookies.get('__Host-vk_session'));
    const listed = await portal.get('/logistik/api/calculations');
    expect(listed.json().calculations.map(item => item.id)).toContain(calculation.id);
    expect((await portal.get(`/logistik/api/calculations/${calculation.id}`)).json().calculation.input).toEqual(input);
    expect((await customer(email)).id).toBe(originalCustomer.id);
    expect(env.APP_URL).toBe(PORTAL);
  });

  it('reuses an existing account without overwriting its profile, billing or saved records', async () => {
    const email = TEST_EMAIL('duplicate'), { client } = await signup(email, 'TEST Existing Customer');
    const calculation = await save(client, 'TEST Preserve This');
    await db.prepare('UPDATE customers SET stripe_customer_id = ?, company = ? WHERE email = ?').bind('cus_test_preserve_domain', 'TEST Existing Company', email).run();
    const before = await customer(email);
    const again = await signup(email, 'TEST Different Signup Name');
    expect(await customer(email)).toEqual(before);
    expect((await db.prepare('SELECT COUNT(*) AS n FROM customers WHERE email = ?').bind(email).first()).n).toBe(1);
    expect((await again.client.get(`/logistik/api/calculations/${calculation.id}`)).status).toBe(200);
  });

  it('rejects cross-origin POSTs even from the Veyro portal, and leaves a rejected verification usable', async () => {
    const flow = await requestLink(TEST_EMAIL('csrf'));
    const page = await flow.client.get(flow.link.href), csrf = csrfFrom(page.html);
    for (const origin of ['https://example.invalid', PORTAL, 'null']) {
      const rejected = await flow.client.post('/logistik/verify', { _csrf: csrf, token: flow.token }, { Origin: origin });
      expect(rejected.status).toBe(403);
    }
    expect(await customer(TEST_EMAIL('csrf'))).toBeNull();
    expect((await confirm(flow)).status).toBe(303);
    const before = await count('logistics_calculations');
    for (const origin of ['https://example.invalid', PORTAL]) {
      expect((await post(flow.client, '/logistik/api/calculations', { toolId: 'eoq', name: 'TEST Rejected', input: JSON.stringify(input) }, { Origin: origin })).status).toBe(403);
    }
    expect(await count('logistics_calculations')).toBe(before);
  });

  it('rejects replay of the single-use token without creating another session', async () => {
    const flow = await signup(TEST_EMAIL('replay')), before = await count('sessions');
    expect((await flow.client.get(flow.link.href)).status).toBe(400);
    expect((await post(flow.client, '/logistik/verify', { token: flow.token })).status).toBe(400);
    expect(await count('sessions')).toBe(before);
  });

  it('hides saved data from guests and other verified accounts', async () => {
    const owner = await signup(TEST_EMAIL('owner')), other = await signup(TEST_EMAIL('other'));
    const calculation = await save(owner.client, 'TEST Owner Private Record');
    const path = `/logistik/api/calculations/${calculation.id}`;
    const guest = new DomainClient();
    expect((await guest.get(path)).status).toBe(401);
    const hidden = await other.client.get(path);
    expect(hidden.status).toBe(404);
    expect(hidden.html).not.toContain('TEST Owner Private Record');
    expect((await other.client.get('/logistik/api/calculations')).json().calculations).toEqual([]);
    expect((await post(other.client, path, { name: 'TEST Unauthorized Update', version: '1', input: JSON.stringify(input) })).status).toBe(404);
    expect((await owner.client.get(path)).json().calculation.name).toBe('TEST Owner Private Record');
  });

  it('logs out the dedicated-domain session without logging out the separate portal session', async () => {
    const email = TEST_EMAIL('logout'), { client } = await signup(email), portal = await portalLogin(email);
    const calculation = await save(client);
    const response = await post(client, '/logistik/logout');
    expect(response.status).toBe(303);
    expect(client.cookies.has('__Host-vk_session')).toBe(false);
    expect((await session(client)).authenticated).toBe(false);
    expect((await client.get(`/logistik/api/calculations/${calculation.id}`)).status).toBe(401);
    expect((await session(portal)).authenticated).toBe(true);
    expect((await portal.get(`/logistik/api/calculations/${calculation.id}`)).status).toBe(200);
  });
});
