import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { chromium } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ADMIN_EMAIL, Client, ROOT, login, seedCustomer, startStack } from './harness.mjs';

let stack, admin;
const ua = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Version/18.0 Mobile/15E148 Safari/604.1';
const event = (overrides = {}) => ({ type: 'pageview', eventId: randomUUID(), path: '/', consent: true, consentVersion: 2, ...overrides });
function sql(query) {
  return JSON.parse(execFileSync(path.join(ROOT, 'node_modules/.bin/wrangler'), ['d1', 'execute', 'veyro-kundepanel', '--local', '--persist-to', stack.persist, '--config', path.join(ROOT, '.wrangler-test.toml'), '--json', '--command', query], { cwd: ROOT, env: { ...process.env, WRANGLER_SEND_METRICS: 'false', CI: '1' }, stdio: 'pipe' }).toString())[0].results;
}
async function post(client, body, headers = {}) {
  const res = await fetch(stack.site + '/analytics/events', { method: 'POST', redirect: 'manual', headers: { Origin: stack.site, 'Content-Type': 'application/json', 'User-Agent': ua, Cookie: client.cookieHeader(), 'CF-Connecting-IP': client.ip, ...headers }, body: JSON.stringify(body) });
  client.store(res);
  return Object.assign(res, { textBody: await res.text() });
}
beforeAll(async () => {
  stack = await startStack({ minMonths: 0 });
  admin = (await login(stack, ADMIN_EMAIL)).client;
});
afterAll(async () => { await stack?.stop(); });

describe('Consent-only visitor analytics', () => {
  it('marks only successful public content, without setting tracking cookies on page loads', async () => {
    const client = new Client(stack.site);
    client.cookies.set('veyro_language', 'da');
    for (const p of ['/', '/en/', '/sv/pages/priser', '/pages/hosting']) {
      const response = await client.get(p);
      expect(response.status, p).toBe(200);
      expect(response.html, p).toContain('data-analytics-page="true"');
      expect(response.headers.getSetCookie().join(' ')).not.toMatch(/veyro_visit/);
    }
    for (const p of ['/cart', '/en/cart', '/pages/not-a-page', '/products/starter', '/admin', '/demo/not-a-demo']) {
      expect((await client.get(p)).html, p).not.toContain('data-analytics-page="true"');
    }
  });

  it('rejects missing/legacy consent, DNT, GPC and known bots before recording', async () => {
    const client = new Client(stack.site);
    for (const [body, headers] of [
      [event({ consent: false }), {}], [event({ consentVersion: 1 }), {}],
      [event(), { DNT: '1' }], [event(), { 'Sec-GPC': '1' }], [event(), { 'User-Agent': 'Googlebot' }],
    ]) {
      const r = await post(client, body, headers);
      expect(r.status).toBe(204);
      expect(client.cookies.size).toBe(0);
    }
    expect(sql('SELECT COUNT(*) n FROM site_analytics_sessions')[0].n).toBe(0);
  });

  it('rejects cross-origin/invalid/oversized events and private or nonexistent paths', async () => {
    const client = new Client(stack.site);
    expect((await post(client, event(), { Origin: 'https://attacker.example' })).status).toBe(403);
    expect((await post(client, event(), { Origin: '' })).status).toBe(403);
    expect((await post(client, event(), { 'Content-Type': 'text/plain' })).status).toBe(415);
    expect((await post(client, event({ extra: 'a'.repeat(5000) }))).status).toBe(413);
    for (const p of ['/admin', '/cart', '/demo/holm-tomrer/', '/pages/not-a-page', '/pages/kontakt?email=private@example.com', '/en/pages/priser#private', '//example.com/']) {
      expect((await post(client, event({ path: p }))).status, p).toBe(400);
    }
    expect((await post(client, event({ eventId: 'not-uuid' }))).status).toBe(400);
    expect((await post(client, event({ activeSeconds: '25' }))).status).toBe(400);
    expect(sql('SELECT COUNT(*) n FROM site_analytics_visitors')[0].n).toBe(0);
  });

  it('records one browser and a full ordered journey, deduplicates retries, bounds engagement, and identifies returning visits', async () => {
    const client = new Client(stack.site);
    const first = event({ referrer: 'https://www.google.com/search?q=private+search' });
    const r = await post(client, first);
    expect(r.status, r.textBody).toBe(200);
    expect(JSON.parse(r.textBody)).toEqual({ accepted: true });
    expect(r.headers.getSetCookie().join(' ')).toMatch(/HttpOnly/);
    expect(r.headers.getSetCookie().join(' ')).toMatch(/SameSite=Lax/i);
    expect(r.headers.getSetCookie().join(' ')).toMatch(/Max-Age=7776000/i);
    const visitor = client.cookies.get('veyro_visitor');
    const session = client.cookies.get('veyro_visit');
    expect(visitor).toBeTruthy(); expect(session).toBeTruthy();
    await post(client, first);
    const next = event({ path: '/pages/hosting' });
    await post(client, next);
    expect(client.cookies.get('veyro_visit')).toBe(session);
    sql(`UPDATE site_analytics_pageviews SET viewed_at = viewed_at - 60 WHERE id = '${next.eventId}'`);
    await post(client, { ...next, type: 'engagement', activeSeconds: 45, scrollDepth: 80 });
    await post(client, { ...next, type: 'engagement', activeSeconds: 20, scrollDepth: 20 });
    let row = sql(`SELECT * FROM site_analytics_sessions WHERE id = '${session}'`)[0];
    expect(row.pageviews).toBe(2); expect(row.active_seconds).toBe(45);
    expect(row.source).toBe('www.google.com'); expect(row.is_returning).toBe(0);
    expect(row.device).toBe('mobile'); expect(row.os).toBe('iOS'); expect(row.browser).toBe('Safari');
    const page = sql(`SELECT * FROM site_analytics_pageviews WHERE id = '${next.eventId}'`)[0];
    expect(page.scroll_depth).toBe(80);
    const detail = await admin.get('/admin/besoegende/' + session);
    expect(detail.status).toBe(200); expect(detail.html).toContain('/pages/hosting'); expect(detail.html).toContain('www.google.com');
    expect(detail.headers.get('cache-control')).toContain('no-store');
    expect(detail.html).not.toContain('private+search');
    const other = new Client(stack.site);
    expect(JSON.parse((await post(other, { ...next, type: 'engagement', activeSeconds: 50 })).textBody).accepted).toBe(false);
    expect(other.cookies.size).toBe(0);
    sql(`UPDATE site_analytics_sessions SET last_seen_at = last_seen_at - 1801 WHERE id = '${session}'`);
    expect(JSON.parse((await post(client, { ...next, type: 'engagement', activeSeconds: 99 })).textBody).accepted).toBe(false);
    await post(client, event({ path: '/pages/priser' }));
    expect(client.cookies.get('veyro_visitor')).toBe(visitor);
    expect(client.cookies.get('veyro_visit')).not.toBe(session);
    row = sql(`SELECT * FROM site_analytics_sessions WHERE id = '${client.cookies.get('veyro_visit')}'`)[0];
    expect(row.is_returning).toBe(1);
    const overview = await admin.get('/admin/besoegende?periode=7');
    expect(overview.status).toBe(200); expect(overview.html).toContain('Besøgende');
    expect(overview.html).toContain('Tilbagevendende');
    expect((await post(client, { type: 'revoke', consent: false, consentVersion: 2 })).status).toBe(204);
    expect(client.cookies.size).toBe(0);
  });

  it('keeps overview and session details private to admins', async () => {
    const anon = new Client(stack.base);
    expect((await anon.get('/admin/besoegende')).status).toBe(303);
    expect((await anon.get('/admin/besoegende/' + randomUUID())).status).toBe(303);
    await seedCustomer(stack, { email: 'analytics-customer@example.com', name: 'Local test customer', cus: 'cus_analytics_test', sub: 'sub_analytics_test', price: 'price_starter_test', start: Math.floor(Date.now() / 1000), status: 'active' });
    const customer = (await login(stack, 'analytics-customer@example.com')).client;
    expect((await customer.get('/admin/besoegende')).status).toBe(403);
    expect((await customer.get('/admin/besoegende/' + randomUUID())).status).toBe(403);
    expect((await admin.get('/admin/besoegende/not-a-session')).status).toBe(404);
  });

  it('tracks an actual browser journey only after a fresh choice and withdraws on the cart page', async () => {
    const browser = await chromium.launch({ headless: true });
    try {
      const context = await browser.newContext({ userAgent: ua });
      await context.addCookies([{ name: 'veyro_language', value: 'da', url: stack.site }]);
      await context.route('**/*', route => ['localhost', '127.0.0.1'].includes(new URL(route.request().url()).hostname) ? route.continue() : route.abort());
      const page = await context.newPage();
      await page.goto(stack.site);
      await page.locator('[data-cookie-action="customize"]').click();
      expect(await page.locator('[data-consent="analytics"]').isChecked()).toBe(false);
      expect((await context.cookies()).filter(c => c.name.includes('veyro_visit'))).toHaveLength(0);
      await page.locator('label.toggle').filter({ has: page.locator('[data-consent="analytics"]') }).click();
      expect(await page.locator('[data-consent="analytics"]').isChecked()).toBe(true);
      await page.locator('[data-cookie-action="save"]').click();
      await expect.poll(async () => (await context.cookies()).some(c => c.name === 'veyro_visitor')).toBe(true);
      const visitor = (await context.cookies()).find(c => c.name === 'veyro_visitor').value;
      await page.goto(stack.site + '/pages/hosting');
      await expect.poll(async () => sql(`SELECT COUNT(*) n FROM site_analytics_pageviews p JOIN site_analytics_sessions s ON s.id=p.session_id WHERE s.visitor_id='${visitor}'`)[0].n).toBe(2);
      await page.goto(stack.site + '/cart');
      await page.locator('[data-cookie-open]').first().click();
      await page.locator('label.toggle').filter({ has: page.locator('[data-consent="analytics"]') }).click();
      expect(await page.locator('[data-consent="analytics"]').isChecked()).toBe(false);
      await page.locator('[data-cookie-action="save"]').click();
      await expect.poll(async () => (await context.cookies()).filter(c => c.name.includes('veyro_visit')).length).toBe(0);
      expect(sql(`SELECT COUNT(*) n FROM site_analytics_pageviews p JOIN site_analytics_sessions s ON s.id=p.session_id WHERE s.visitor_id='${visitor}'`)[0].n).toBe(2);
    } finally { await browser.close(); }
  });
});
