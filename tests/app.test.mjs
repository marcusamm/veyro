import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  ADMIN_EMAIL,
  Client,
  csrfFrom,
  login,
  seedCustomer,
  setMockState,
  signedWebhook,
  startStack,
  waitFor,
} from './harness.mjs';

const DAY = 86400;
const now = () => Math.floor(Date.now() / 1000);
let stack;

const calls = async () => (await fetch(stack.mock.url + '/__mock/calls')).json();
const emails = async () => (await fetch(stack.mock.url + '/__mock/emails')).json();
// Genbrug af login-sessioner pr. e-mail (så rate-limit på link-anmodninger ikke rammes i tests)
const sessions = new Map();
async function as(email) {
  if (!sessions.has(email)) sessions.set(email, await login(stack, email));
  return sessions.get(email);
}

beforeAll(async () => {
  stack = await startStack({ minMonths: 12 });
  // Kunde A: Business, startet for 10 dage siden (bundet af MIN_MONTHS=12)
  await seedCustomer(stack, { email: 'anna@example.dk', name: 'Anna Jensen', cus: 'cus_A', sub: 'sub_A', price: 'price_business_test', start: now() - 10 * DAY });
  // Kunde B: Starter, startet for 2 år siden (binding udløbet)
  await seedCustomer(stack, { email: 'bo@example.dk', name: 'Bo Hansen', cus: 'cus_B', sub: 'sub_B', price: 'price_starter_test', start: now() - 730 * DAY });
  // Kunde E: bruges kun til login-tests
  await seedCustomer(stack, { email: 'eva@example.dk', name: 'Eva', cus: 'cus_E', sub: 'sub_E', price: 'price_starter_test', start: now() - 40 * DAY });
});

afterAll(async () => {
  await stack?.stop();
});

describe('Stripe-webhook', () => {
  it('afviser ugyldig signatur', async () => {
    const event = { id: 'evt_bad', type: 'customer.subscription.updated', data: { object: { id: 'sub_A' } } };
    const res = await signedWebhook(stack.base, event, 'whsec_forkert');
    expect(res.status).toBe(400);
    const noHeader = await fetch(stack.base + '/stripe/webhook', { method: 'POST', body: JSON.stringify(event) });
    expect(noHeader.status).toBe(400);
  });

  it('afviser for gammelt tidsstempel (replay)', async () => {
    const event = { id: 'evt_old', type: 'customer.subscription.updated', data: { object: { id: 'sub_A' } } };
    const res = await signedWebhook(stack.base, event, undefined, { timestamp: now() - 3600 });
    expect(res.status).toBe(400);
  });

  it('accepterer gyldig signatur og er idempotent', async () => {
    const event = { id: 'evt_ok_1', type: 'customer.subscription.updated', data: { object: { id: 'sub_A', customer: 'cus_A' } } };
    const r1 = await signedWebhook(stack.base, event);
    expect(r1.status).toBe(200);
    expect(await r1.json()).toEqual({ received: true });
    const r2 = await signedWebhook(stack.base, event);
    expect(await r2.json()).toEqual({ received: true, duplicate: true });
  });

  it('opretter kunde fra subscription.created selv uden checkout-hændelse', async () => {
    const { makeSubscription } = await import('./mock-server.mjs');
    const sub = makeSubscription({ id: 'sub_C', customer: 'cus_C', price: 'price_premium_test' });
    await setMockState(stack.mock, { customers: { cus_C: { id: 'cus_C', email: 'Carl@Example.dk', name: 'Carl' } }, subscriptions: { sub_C: sub } });
    const r = await signedWebhook(stack.base, { id: 'evt_c1', type: 'customer.subscription.created', data: { object: sub } });
    expect(r.status).toBe(200);
    const { client } = await login(stack, 'carl@example.dk');
    const dash = await client.get('/konto');
    expect(dash.html).toContain('Premium');
  });
});

describe('Magic-link-login', () => {
  it('fuldt flow: link → bekræft → session → dashboard', async () => {
    const { client, link, redirect } = await login(stack, 'eva@example.dk');
    expect(redirect).toBe('/konto');
    const sessionCookie = [...client.cookies.keys()].find((k) => k.includes('vk_session'));
    expect(sessionCookie).toBeTruthy();
    // Engangs: samme token kan ikke bruges igen
    const c2 = new Client(stack.base);
    const page = await c2.get(new URL(link).pathname + new URL(link).search);
    expect(page.status).toBe(200);
    const again = await c2.post('/login/bekraeft', { _csrf: csrfFrom(page.html), token: new URL(link).searchParams.get('token') });
    expect(again.status).toBe(400);
    expect(again.html).toContain('Linket virker ikke længere');
  });

  it('session-cookie er HttpOnly og SameSite=Lax med 30 dages levetid', async () => {
    const c = new Client(stack.base);
    const page = await c.get('/login');
    await c.post('/login', { _csrf: csrfFrom(page.html), email: 'bo@example.dk' });
    const mail = await waitFor(async () => (await emails()).filter((e) => e.to[0] === 'bo@example.dk').pop());
    const token = mail.text.match(/token=([A-Za-z0-9_-]+)/)[1];
    const confirm = await c.get('/login/bekraeft?token=' + token);
    const res = await fetch(stack.base + '/login/bekraeft', {
      method: 'POST',
      redirect: 'manual',
      headers: { Cookie: c.cookieHeader(), 'Content-Type': 'application/x-www-form-urlencoded', Origin: stack.base },
      body: new URLSearchParams({ _csrf: csrfFrom(confirm.html), token }).toString(),
    });
    const sc = res.headers.getSetCookie().find((s) => s.startsWith('vk_session='));
    expect(sc).toMatch(/HttpOnly/i);
    expect(sc).toMatch(/SameSite=Lax/i);
    expect(sc).toMatch(/Max-Age=2592000/);
  });

  it('afslører ikke, om e-mailen findes, og sender ingen mail til ukendte', async () => {
    const c = new Client(stack.base);
    const page = await c.get('/login');
    const before = (await emails()).length;
    const unknown = await c.post('/login', { _csrf: csrfFrom(page.html), email: 'ukendt@example.dk' });
    const known = await c.post('/login', { _csrf: csrfFrom(page.html), email: 'eva@example.dk' });
    expect(unknown.status).toBe(200);
    expect(known.status).toBe(200);
    const strip = (h) => h.replace(/name="_csrf" value="[^"]+"/g, '');
    expect(strip(unknown.html)).toBe(strip(known.html));
    await waitFor(async () => (await emails()).length > before);
    const sent = (await emails()).slice(before);
    expect(sent.some((e) => e.to[0] === 'ukendt@example.dk')).toBe(false);
    expect(sent[0].subject).toBe('Dit login-link til Veyro');
    expect(sent[0].from).toBe('Veyro <kontakt@veyro.dk>');
  });

  it('afviser ugyldig e-mail', async () => {
    const c = new Client(stack.base);
    const page = await c.get('/login');
    const res = await c.post('/login', { _csrf: csrfFrom(page.html), email: 'ikke-en-email' });
    expect(res.status).toBe(400);
    expect(res.html).toContain('gyldig e-mailadresse');
  });

  it('rate-limiter link-anmodninger pr. e-mail', async () => {
    const c = new Client(stack.base);
    const page = await c.get('/login');
    const statuses = [];
    for (let i = 0; i < 4; i++) {
      const r = await c.post('/login', { _csrf: csrfFrom(page.html), email: 'spam@example.dk' }, { 'CF-Connecting-IP': `10.0.0.${i}` });
      statuses.push(r.status);
    }
    expect(statuses).toEqual([200, 200, 200, 429]);
  });

  it('rate-limiter link-anmodninger pr. IP', async () => {
    const c = new Client(stack.base);
    const page = await c.get('/login');
    const statuses = [];
    for (let i = 0; i < 11; i++) {
      const r = await c.post('/login', { _csrf: csrfFrom(page.html), email: `ip${i}@example.dk` }, { 'CF-Connecting-IP': '192.0.2.77' });
      statuses.push(r.status);
    }
    expect(statuses.slice(0, 10).every((s) => s === 200)).toBe(true);
    expect(statuses[10]).toBe(429);
  });

  it('uden login sendes man til /login', async () => {
    const c = new Client(stack.base);
    const r = await c.get('/konto');
    expect(r.status).toBe(303);
    expect(r.headers.get('location')).toBe('/login');
  });

  it('log ud sletter sessionen', async () => {
    const { client } = await login(stack, 'carl@example.dk');
    const dash = await client.get('/konto');
    const out = await client.post('/logout', { _csrf: csrfFrom(dash.html) });
    expect(out.status).toBe(303);
    const after = await client.get('/konto');
    expect(after.status).toBe(303);
  });
});

describe('CSRF', () => {
  it('afviser POST uden eller med forkert token', async () => {
    const { client } = await as('anna@example.dk');
    const none = await client.post('/konto/henvendelser', { type: 'bug', title: 'Test', description: 'En beskrivelse her' });
    expect(none.status).toBe(403);
    const wrong = await client.post('/konto/henvendelser', { _csrf: 'forkert', type: 'bug', title: 'Test', description: 'En beskrivelse her' });
    expect(wrong.status).toBe(403);
  });

  it('afviser POST fra fremmed origin, selv med gyldigt token', async () => {
    const { client } = await as('anna@example.dk');
    const page = await client.get('/konto/henvendelser');
    const r = await client.post(
      '/konto/henvendelser',
      { _csrf: csrfFrom(page.html), type: 'bug', title: 'Test', description: 'En beskrivelse her' },
      { Origin: 'https://evil.example' },
    );
    expect(r.status).toBe(403);
  });

  it('afviser login-POST uden anonymt CSRF-token', async () => {
    const r = await fetch(stack.base + '/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'email=anna%40example.dk',
    });
    expect(r.status).toBe(403);
  });
});

describe('Dashboard', () => {
  it('viser plan, status, næste betaling og startdato', async () => {
    const { client } = await as('anna@example.dk');
    const r = await client.get('/konto');
    expect(r.status).toBe(200);
    expect(r.html).toContain('Hej Anna');
    expect(r.html).toContain('Business');
    expect(r.html).toContain('Aktiv');
    expect(r.html).toContain('599 kr.');
    expect(r.html).toContain('Næste betaling');
    expect(r.html).toContain('Startdato');
    expect(r.html).toMatch(/kan opsiges fra \d+\. \w+ \d{4}/);
    expect(r.headers.get('content-security-policy')).toContain("frame-ancestors 'none'");
  });

  it('viser "Betaling fejlet" efter invoice.payment_failed, og nulstiller ved invoice.paid', async () => {
    const r1 = await signedWebhook(stack.base, { id: 'evt_fail_B', type: 'invoice.payment_failed', data: { object: { id: 'in_1', subscription: 'sub_B' } } });
    expect(r1.status).toBe(200);
    const { client } = await as('bo@example.dk');
    expect((await client.get('/konto')).html).toContain('Betaling fejlet');
    // Nyere API-format: subscription under parent.subscription_details
    const r2 = await signedWebhook(stack.base, {
      id: 'evt_paid_B',
      type: 'invoice.paid',
      data: { object: { id: 'in_1', parent: { subscription_details: { subscription: 'sub_B' } } } },
    });
    expect(r2.status).toBe(200);
    const d = await client.get('/konto');
    expect(d.html).not.toContain('Betaling fejlet');
    expect(d.html).toContain('Aktiv');
  });
});

describe('Skift plan', () => {
  it('viser bekræftelse og opdaterer abonnementet med proration', async () => {
    const { client } = await as('anna@example.dk');
    const choose = await client.get('/konto/plan');
    expect(choose.html).toContain('Din nuværende plan');
    expect(choose.html).toContain('/konto/plan/bekraeft?plan=premium');
    const confirm = await client.get('/konto/plan/bekraeft?plan=premium');
    expect(confirm.status).toBe(200);
    expect(confirm.html).toContain('Bekræft opgradering');
    expect(confirm.html).toContain('Forventet beløb på næste faktura');
    const res = await client.post('/konto/plan', { _csrf: csrfFrom(confirm.html), plan: 'premium' });
    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toBe('/konto?besked=plan-skiftet');
    const update = (await calls()).filter((c) => c.path === '/v1/subscriptions/sub_A' && c.method === 'POST').pop();
    expect(update.params['items[0][price]']).toBe('price_premium_test');
    expect(update.params['items[0][id]']).toBe('si_A');
    expect(update.params.proration_behavior).toBe('create_prorations');
    expect(update.idempotencyKey).toBeTruthy();
    const dash = await client.get('/konto?besked=plan-skiftet');
    expect(dash.html).toContain('Premium');
    expect(dash.html).toContain('1.099 kr.');
    expect(dash.html).toContain('Din plan er skiftet');
  });

  it('afviser ugyldig plan uden at kalde Stripe', async () => {
    const { client } = await as('anna@example.dk');
    const page = await client.get('/konto/plan');
    const before = (await calls()).length;
    const res = await client.post('/konto/plan', { _csrf: csrfFrom(page.html), plan: 'gratis' });
    expect(res.status).toBe(303);
    expect((await calls()).length).toBe(before);
  });
});

describe('Opsigelse og genoptagelse (MIN_MONTHS=12)', () => {
  it('blokerer opsigelse inden for bindingsperioden', async () => {
    const { client } = await as('anna@example.dk');
    const page = await client.get('/konto/opsig');
    expect(page.html).toContain('kan tidligst opsiges fra');
    const before = (await calls()).length;
    const res = await client.post('/konto/opsig', { _csrf: csrfFrom(page.html) });
    expect(res.status).toBe(403);
    expect((await calls()).length).toBe(before);
  });

  it('tillader opsigelse efter bindingsperioden og genoptagelse', async () => {
    const { client } = await as('bo@example.dk');
    const page = await client.get('/konto/opsig');
    expect(page.html).toContain('Ja, opsig abonnementet');
    const res = await client.post('/konto/opsig', { _csrf: csrfFrom(page.html) });
    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toBe('/konto?besked=opsagt');
    const cancel = (await calls()).filter((c) => c.path === '/v1/subscriptions/sub_B' && c.method === 'POST').pop();
    expect(cancel.params.cancel_at_period_end).toBe('true');
    const dash = await client.get('/konto');
    expect(dash.html).toMatch(/Opsagt pr\. \d+\. \w+ \d{4}/);
    expect(dash.html).toContain('Fortsæt abonnementet');
    // Planskift er blokeret mens opsigelse er afventende
    expect((await client.get('/konto/plan')).html).toContain('Dit abonnement er opsagt');

    const resume = await client.post('/konto/genoptag', { _csrf: csrfFrom(dash.html) });
    expect(resume.status).toBe(303);
    const r = (await calls()).filter((c) => c.path === '/v1/subscriptions/sub_B' && c.method === 'POST').pop();
    expect(r.params.cancel_at_period_end).toBe('false');
    const after = await client.get('/konto');
    expect(after.html).toContain('Aktiv');
    expect(after.html).not.toContain('Opsagt pr.');
  });

  it('viser en venlig fejl, hvis Stripe fejler', async () => {
    const { client } = await as('bo@example.dk');
    const page = await client.get('/konto/opsig');
    await setMockState(stack.mock, { failNext: '/v1/subscriptions/sub_B' });
    const res = await client.post('/konto/opsig', { _csrf: csrfFrom(page.html) });
    expect(res.headers.get('location')).toBe('/konto?besked=stripe-fejl');
    expect((await client.get('/konto?besked=stripe-fejl')).html).toContain('fejl hos vores betalingsudbyder');
  });
});

describe('Fakturaer og betalingskort', () => {
  it('lister fakturaer med PDF-links og åbner Billing Portal til kortskift', async () => {
    await setMockState(stack.mock, {
      invoices: [
        { id: 'in_10', customer: 'cus_A', number: 'VEY-0001', status: 'paid', created: now() - 5 * DAY, total: 59900, amount_due: 59900, amount_paid: 59900, currency: 'dkk', hosted_invoice_url: 'https://invoice.stripe.com/i/x', invoice_pdf: 'https://pay.stripe.com/invoice/x/pdf' },
        { id: 'in_11', customer: 'cus_A', number: null, status: 'draft', created: now(), total: 1, amount_due: 1, amount_paid: 0, currency: 'dkk', hosted_invoice_url: null, invoice_pdf: null },
        { id: 'in_12', customer: 'cus_B', number: 'VEY-0002', status: 'paid', created: now(), total: 29900, amount_due: 29900, amount_paid: 29900, currency: 'dkk', hosted_invoice_url: null, invoice_pdf: 'https://pay.stripe.com/other' },
      ],
    });
    const { client } = await as('anna@example.dk');
    const page = await client.get('/konto/fakturaer');
    expect(page.html).toContain('VEY-0001');
    expect(page.html).toContain('599,00 kr.');
    expect(page.html).toContain('https://pay.stripe.com/invoice/x/pdf');
    expect(page.html).not.toContain('VEY-0002'); // anden kundes faktura
    const portal = await client.post('/konto/betalingskort', { _csrf: csrfFrom(page.html) });
    expect(portal.status).toBe(303);
    expect(portal.headers.get('location')).toBe('https://billing.stripe.com/p/session/test_123');
    const call = (await calls()).filter((c) => c.path === '/v1/billing_portal/sessions').pop();
    expect(call.params['flow_data[type]']).toBe('payment_method_update');
    expect(call.params.customer).toBe('cus_A');
  });
});

describe('Bestilling (Stripe Checkout)', () => {
  it('opretter Checkout-session med dansk sprog, adresse og CVR', async () => {
    const c = new Client(stack.base);
    const page = await c.get('/bestil');
    expect(page.html).toContain('Mest populær');
    expect(page.html).toContain('299 kr.');
    expect(page.html).toContain('1.099 kr.');
    const res = await c.post('/bestil', { _csrf: csrfFrom(page.html), plan: 'business' });
    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toMatch(/^https:\/\/checkout\.stripe\.com\//);
    const call = (await calls()).filter((x) => x.path === '/v1/checkout/sessions').pop();
    expect(call.params).toMatchObject({
      mode: 'subscription',
      locale: 'da',
      'line_items[0][price]': 'price_business_test',
      billing_address_collection: 'required',
      'tax_id_collection[enabled]': 'true',
    });
  });

  it('sender eksisterende kunder til planskift i stedet for ny Checkout', async () => {
    const { client } = await as('anna@example.dk');
    const page = await client.get('/bestil');
    const res = await client.post('/bestil', { _csrf: csrfFrom(page.html), plan: 'starter' });
    expect(res.headers.get('location')).toBe('/konto/plan?besked=har-abonnement');
  });
});

describe('Henvendelser', () => {
  it('opretter, lister og sender notifikation til kontakt@veyro.dk', async () => {
    const { client } = await as('anna@example.dk');
    const page = await client.get('/konto/henvendelser');
    expect(page.html).toContain('Du har ikke sendt nogen henvendelser endnu');
    const before = (await emails()).length;
    const res = await client.post('/konto/henvendelser', {
      _csrf: csrfFrom(page.html),
      type: 'content',
      title: 'Ferielukning i juli <script>',
      description: 'Vi har åbent 9-17 fra 1. november.\nTak!',
    });
    expect(res.status).toBe(303);
    const list = await client.get('/konto/henvendelser?besked=henvendelse-oprettet');
    expect(list.html).toContain('Ferielukning i juli &lt;script&gt;');
    expect(list.html).not.toContain('Ferielukning i juli <script>');
    expect(list.html).toContain('Modtaget');
    expect(list.html).toContain('Indholdsændring');
    const mail = await waitFor(async () => (await emails()).slice(before).find((e) => e.to[0] === 'kontakt@veyro.dk'));
    expect(mail.subject).toContain('Ny henvendelse');
    expect(mail.reply_to).toBe('anna@example.dk');
    expect(mail.html).toContain('&lt;script&gt;');
  });

  it('validerer input', async () => {
    const { client } = await as('anna@example.dk');
    const page = await client.get('/konto/henvendelser');
    const res = await client.post('/konto/henvendelser', { _csrf: csrfFrom(page.html), type: 'hack', title: 'x', description: 'kort' });
    expect(res.status).toBe(400);
    expect(res.html).toContain('Vælg en type.');
    expect(res.html).toContain('mindst 3 tegn');
    expect(res.html).toContain('mindst 10 tegn');
  });

  it('kunder ser kun egne henvendelser', async () => {
    const { client } = await as('bo@example.dk');
    const page = await client.get('/konto/henvendelser');
    expect(page.html).not.toContain('Ferielukning i juli');
  });
});

describe('Admin', () => {
  it('nægter kunder adgang', async () => {
    const { client } = await as('anna@example.dk');
    const r = await client.get('/admin');
    expect(r.status).toBe(403);
    const page = await client.get('/konto');
    const post = await client.post('/admin/henvendelser/1/status', { _csrf: csrfFrom(page.html), status: 'resolved' });
    expect(post.status).toBe(403);
  });

  it('nægter anonyme adgang', async () => {
    const r = await new Client(stack.base).get('/admin/kunder');
    expect(r.status).toBe(303);
    expect(r.headers.get('location')).toBe('/login');
  });

  it('admin (ikke-kunde) kan logge ind, se kunder og ændre status', async () => {
    const { client, redirect } = await login(stack, ADMIN_EMAIL);
    expect(redirect).toBe('/admin');
    const overview = await client.get('/admin');
    expect(overview.status).toBe(200);
    const customers = await client.get('/admin/kunder');
    expect(customers.html).toContain('anna@example.dk');
    expect(customers.html).toContain('bo@example.dk');
    const reqs = await client.get('/admin/henvendelser');
    expect(reqs.html).toContain('Ferielukning i juli');
    const id = reqs.html.match(/action="\/admin\/henvendelser\/(\d+)\/status"/)[1];
    const res = await client.post(`/admin/henvendelser/${id}/status`, { _csrf: csrfFrom(reqs.html), status: 'in_progress' });
    expect(res.status).toBe(303);
    const bad = await client.post(`/admin/henvendelser/${id}/status`, { _csrf: csrfFrom(reqs.html), status: 'slettet' });
    expect(bad.status).toBe(400);

    const anna = await as('anna@example.dk');
    const list = await anna.client.get('/konto/henvendelser');
    expect(list.html).toContain('I gang');
  });
});

describe('Udviklingstilstand uden Resend-nøgle', () => {
  let dev;
  beforeAll(async () => {
    dev = await startStack({ minMonths: 0, devMode: true, resend: false });
    await seedCustomer(dev, { email: 'dev@example.dk', name: 'Dev', cus: 'cus_D', sub: 'sub_D', price: 'price_starter_test', start: now() - DAY });
  });
  afterAll(async () => dev?.stop());

  it('viser linket på skærmen (DEV_MODE=1) og logger det', async () => {
    const c = new Client(dev.base);
    const page = await c.get('/login');
    const r = await c.post('/login', { _csrf: csrfFrom(page.html), email: 'dev@example.dk' });
    expect(r.html).toContain('Udviklingstilstand');
    const link = r.html.match(/href="(http[^"]+\/login\/bekraeft\?token=[^"]+)"/)[1];
    await waitFor(() => dev.logs().includes('/login/bekraeft?token='));
    const confirm = await c.get(new URL(link).pathname + new URL(link).search);
    const done = await c.post('/login/bekraeft', { _csrf: csrfFrom(confirm.html), token: new URL(link).searchParams.get('token') });
    expect(done.status).toBe(303);
    const dash = await c.get('/konto');
    // MIN_MONTHS=0: ingen binding → opsigelse tilgængelig med det samme
    expect(dash.html).toContain('Opsig abonnement');
  });
});
