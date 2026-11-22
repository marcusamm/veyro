import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { ADMIN_EMAIL, ROOT, csrfFrom, login, seedCustomer, startStack } from './harness.mjs';
import { customerWebsiteUrl } from '../src/lib/customer-agreement.ts';
import { subscriptionState } from '../src/views/status.ts';

let stack;
let customer;
let admin;
const compId = 'agreement_example_test';
const historicId = 'sub_historical001';
const now = () => Math.floor(Date.now() / 1000);
function sql(command) {
  execFileSync(path.join(ROOT, 'node_modules/.bin/wrangler'), [
    'd1', 'execute', 'veyro-kundepanel', '--local', '--persist-to', stack.persist,
    '--config', path.join(ROOT, '.wrangler-test.toml'), '--command', command,
  ], { cwd: ROOT, env: { ...process.env, CI: '1', WRANGLER_SEND_METRICS: 'false' }, stdio: 'pipe' });
}
const calls = async () => (await fetch(stack.mock.url + '/__mock/calls')).json();
const emails = async () => (await fetch(stack.mock.url + '/__mock/emails')).json();

beforeAll(async () => {
  stack = await startStack({ minMonths: 0 });
  await seedCustomer(stack, { email: 'paid@example.test', name: 'Paid Test', cus: 'cus_paid', sub: 'sub_paidtest001', price: 'price_starter_test' });
  sql(`INSERT INTO customers(id,email,name,company,stripe_customer_id,created_at,updated_at)
    VALUES(2000,'agreement@example.test','Agreement Test','Example Workshop','cus_historical',${now()},${now()});
    INSERT INTO subscriptions(id,customer_id,status,plan,amount,currency,started_at,updated_at,billing_mode,agreement_note,website_url,website_admin_url)
    VALUES('${compId}',2000,'active','starter',0,'dkk',${now()},${now()},'complimentary','Aftalen koster 0 kr. <script>alert(1)</script>','https://workshop.example.test','https://workshop.example.test/admin');
    INSERT INTO subscriptions(id,customer_id,status,plan,amount,currency,started_at,updated_at)
    VALUES('${historicId}',2000,'canceled','starter',29900,'dkk',${now()-86400},${now()});`);
  customer = (await login(stack, 'agreement@example.test')).client;
  admin = (await login(stack, ADMIN_EMAIL)).client;
});
afterAll(async () => { await stack?.stop(); });

describe('Complimentary customer agreements', () => {
  it('shows the free agreement, plan reference and safe website links without billing controls', async () => {
    const page = await customer.get('/konto');
    expect(page.status).toBe(200);
    expect(page.html).toContain('Starter');
    expect(page.html).toContain('299');
    expect(page.html).toContain('din aftale: 0 kr.');
    expect(page.html).toContain('Ingen automatisk opkrævning');
    expect(page.html).toContain('ny skriftlig aftale');
    expect(page.html).toContain('30 kalenderdages varsel');
    expect(page.html).toContain('href="https://workshop.example.test/"');
    expect(page.html).toContain('href="https://workshop.example.test/admin"');
    expect(page.html).not.toContain('<script>alert(1)</script>');
    expect(page.html).toContain('&lt;script&gt;');
    expect(page.html).not.toContain('href="/konto/plan"');
    expect(page.html).not.toContain('href="/konto/opsig"');
  });

  it('blocks forged plan/cancel/resume/card/portal requests without calling Stripe or sending mail', async () => {
    const page = await customer.get('/konto');
    const csrf = csrfFrom(page.html);
    const beforeCalls = (await calls()).length;
    const beforeMails = (await emails()).length;
    for (const route of ['/plan', '/opsig', '/genoptag', '/betalingskort', '/portal']) {
      const result = await customer.post('/konto' + route, { _csrf: csrf, plan: 'premium' });
      expect(result.status, route).toBe(303);
    }
    await customer.get('/konto/plan/bekraeft?plan=premium');
    sql(`UPDATE subscriptions SET cancel_at=${now()+86400} WHERE id='${compId}'`);
    const pending = await customer.post('/konto/genoptag', { _csrf: csrf });
    expect(pending.status).toBe(303);
    sql(`UPDATE subscriptions SET cancel_at=NULL WHERE id='${compId}'`);
    expect((await calls()).length).toBe(beforeCalls);
    expect((await emails()).length).toBe(beforeMails);
  });

  it('still permits historical invoice reads, but displays no payment setup or portal forms', async () => {
    const page = await customer.get('/konto/fakturaer');
    expect(page.status).toBe(200);
    expect(page.html).toContain('eventuelle tidligere fakturaer');
    expect(page.html).toContain('Du skal ikke tilføje et betalingskort');
    expect(page.html).not.toContain('action="/konto/betalingskort"');
    expect(page.html).not.toContain('action="/konto/portal"');
  });

  it('shows the agreement to admins and rejects mutations of the agreement or historical Stripe subscription', async () => {
    const page = await admin.get('/admin/kunder/2000');
    expect(page.status).toBe(200);
    expect(page.html).toContain('aftalt pris: 0 kr.');
    expect(page.html).toContain('ny skriftlig aftale');
    expect(page.html).toContain('Hjemmesidens administration');
    expect(page.html).not.toContain('Ændr pris for denne kunde');
    expect(page.html).not.toContain('/subscriptions/' + compId);
    expect(page.html).not.toContain('<script>alert(1)</script>');
    const before = (await calls()).length;
    const beforeMails = (await emails()).length;
    for (const id of [compId, historicId]) for (const action of ['pris','opsig','genoptag','tilbud','fjern-tilbud','kortlink']) {
      const res = await admin.post(`/admin/abonnementer/${id}/${action}`, { _csrf: csrfFrom(page.html), price: '299', item: 'si_fakeitem001' });
      expect(res.status, action).toBe(403);
    }
    for (const id of [compId, historicId]) for (const action of ['pris','opsig','genoptag']) {
      const res = await admin.post(`/admin/kunder/2000/abonnement/${id}/${action}`, { _csrf: csrfFrom(page.html), price: '299' });
      expect(res.status, action).toBe(403);
    }
    const create = await admin.post('/admin/abonnementer', {
      _csrf: csrfFrom(page.html), email: 'agreement@example.test', name: 'Agreement Test',
      action: 'paid', days: '14', line0_desc: 'Subscription', line0_qty: '1', line0_price: '299',
    });
    expect(create.status).toBe(409);
    expect((await calls()).length).toBe(before);
    expect((await emails()).length).toBe(beforeMails);
  });

  it('preserves standard Stripe customer plan management', async () => {
    const paid = (await login(stack, 'paid@example.test')).client;
    const page = await paid.get('/konto');
    expect(page.status).toBe(200);
    expect(page.html).toContain('href="/konto/plan"');
    const plans = await paid.get('/konto/plan');
    expect(plans.html).toContain('/konto/plan/bekraeft?plan=business');
    expect(plans.html).not.toContain('ny skriftlig aftale');
  });
});

describe('Agreement guards and links', () => {
  it('never makes complimentary subscriptions Stripe-manageable, including cancellation state', () => {
    for (const status of ['active','trialing','past_due','paused','canceled']) {
      expect(subscriptionState({ billing_mode: 'complimentary', status, cancel_at_period_end: 1, current_period_end: now()+86400, payment_failed: 0 }).manageable).toBe(false);
    }
    expect(subscriptionState({ status: 'active', payment_failed: 0 }).manageable).toBe(true);
  });
  it('allows ordinary HTTPS website URLs and rejects unsafe targets', () => {
    expect(customerWebsiteUrl('https://workshop.example.test/admin')).toBe('https://workshop.example.test/admin');
    for (const url of ['javascript:alert(1)','data:text/html,bad','http://example.test','https://user:pass@example.test','https://127.0.0.1','https://localhost','https://example.test:8080','https://example.test\\@evil.test',' https://example.test']) {
      expect(customerWebsiteUrl(url), url).toBe(null);
    }
  });
});
