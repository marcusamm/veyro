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

  it('sender besked om ny ordre til salg@veyro.dk ved gennemført checkout', async () => {
    const { makeSubscription } = await import('./mock-server.mjs');
    const sub = makeSubscription({ id: 'sub_D', customer: 'cus_D', price: 'price_business_test' });
    await setMockState(stack.mock, { customers: { cus_D: { id: 'cus_D', email: 'dorte@example.dk', name: 'Dorte <Design>' } }, subscriptions: { sub_D: sub } });
    const before = (await emails()).length;
    const r = await signedWebhook(stack.base, {
      id: 'evt_order_D',
      type: 'checkout.session.completed',
      data: { object: { id: 'cs_D', mode: 'subscription', customer: 'cus_D', subscription: 'sub_D', customer_details: { email: 'dorte@example.dk', name: 'Dorte <Design>' } } },
    });
    expect(r.status).toBe(200);
    const mail = await waitFor(async () => (await emails()).slice(before).find((e) => e.to[0] === 'salg@veyro.dk'));
    expect(mail.subject).toContain('Ny ordre: Business');
    expect(mail.reply_to).toBe('dorte@example.dk');
    expect(mail.html).toContain('Dorte &lt;Design&gt;');
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
  it('kræver konto før betaling: anonyme sendes til opret', async () => {
    const c = new Client(stack.base);
    const page = await c.get('/bestil');
    expect(page.html).toContain('Mest populær');
    expect(page.html).toContain('299 kr.');
    expect(page.html).toContain('1.099 kr.');
    expect(page.html).toContain('href="/opret?plan=business"');
    const login = await c.get('/login');
    const res = await c.post('/bestil', { _csrf: csrfFrom(login.html), plan: 'business' });
    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toBe('/opret?plan=business');
  });

  it('opret konto → bekræft e-mail → betaling med Veyros udseende', async () => {
    const c = new Client(stack.base);
    const form = await c.get('/opret?plan=business');
    expect(form.html).toContain('Opret din konto');
    expect(form.html).toContain('Business');
    const sent = await c.post('/opret?plan=business', { _csrf: csrfFrom(form.html), name: 'Nina Nielsen', email: 'Nina@Example.dk' });
    expect(sent.status).toBe(200);
    expect(sent.html).toContain('Tjek din indbakke');
    const mail = await waitFor(async () => (await emails()).filter((e) => e.to[0] === 'nina@example.dk').pop());
    expect(mail.subject).toContain('opret din konto');
    expect(mail.text).toContain('Hej Nina');
    const token = mail.text.match(/token=([A-Za-z0-9_-]+)/)[1];
    const confirm = await c.get('/login/bekraeft?token=' + token);
    const done = await c.post('/login/bekraeft', { _csrf: csrfFrom(confirm.html), token });
    expect(done.status).toBe(303);
    expect(done.headers.get('location')).toBe('/bestil?plan=business&besked=konto-oprettet');
    const plans = await c.get('/bestil?plan=business&besked=konto-oprettet');
    expect(plans.html).toContain('Din konto er oprettet');
    expect(plans.html).toContain('Gå til betaling');

    const res = await c.post('/bestil', { _csrf: csrfFrom(plans.html), plan: 'business' });
    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toMatch(/^https:\/\/checkout\.stripe\.com\//);
    const call = (await calls()).filter((x) => x.path === '/v1/checkout/sessions').pop();
    expect(call.params).toMatchObject({
      mode: 'subscription',
      locale: 'da',
      customer_email: 'nina@example.dk',
      'line_items[0][price]': 'price_business_test',
      billing_address_collection: 'required',
      'tax_id_collection[enabled]': 'true',
      'managed_payments[enabled]': 'false',
      'branding_settings[button_color]': '#FF5A1F',
      'branding_settings[font_family]': 'inter',
    });
    expect(call.params['branding_settings[logo][url]']).toMatch(/\/static\/logo\.png$/);
  });

  it('opret med eksisterende e-mail sender login-link og opretter ingen dublet', async () => {
    const c = new Client(stack.base);
    const form = await c.get('/opret');
    const sent = await c.post('/opret', { _csrf: csrfFrom(form.html), name: 'Bo', email: 'bo@example.dk' });
    expect(sent.html).toContain('Tjek din indbakke');
    const mail = await waitFor(async () => (await emails()).filter((e) => e.to[0] === 'bo@example.dk' && e.subject.includes('login')).pop());
    expect(mail).toBeTruthy();
  });

  it('opret kræver navn og gyldig e-mail', async () => {
    const c = new Client(stack.base);
    const form = await c.get('/opret');
    const noName = await c.post('/opret', { _csrf: csrfFrom(form.html), name: ' ', email: 'x@example.dk' });
    expect(noName.status).toBe(400);
    expect(noName.html).toContain('Skriv dit navn');
    const badEmail = await c.post('/opret', { _csrf: csrfFrom(form.html), name: 'X', email: 'ikke-en-mail' });
    expect(badEmail.status).toBe(400);
  });

  it('serverer logo, ikon og skrifttype', async () => {
    for (const [path, type] of [['/static/logo.png', 'image/png'], ['/static/icon.png', 'image/png'], ['/static/inter-tight.woff2', 'font/woff2']]) {
      const r = await fetch(stack.base + path);
      expect(r.status).toBe(200);
      expect(r.headers.get('content-type')).toBe(type);
      expect((await r.arrayBuffer()).byteLength).toBeGreaterThan(1000);
    }
  });

  it('fremhæver planen fra ?plan= (links fra veyro.dk) og ignorerer ukendte', async () => {
    const c = new Client(stack.base);
    const page = await c.get('/bestil?plan=premium');
    expect(page.html).toContain('class="plan selected" id="premium"');
    expect(page.html.match(/ selected"/g)).toHaveLength(1);
    const bad = await c.get('/bestil?plan=gratis');
    expect(bad.status).toBe(200);
    expect(bad.html).not.toContain(' selected"');
  });

  it('sender eksisterende kunder til planskift i stedet for ny Checkout', async () => {
    const { client } = await as('anna@example.dk');
    const page = await client.get('/bestil');
    const res = await client.post('/bestil', { _csrf: csrfFrom(page.html), plan: 'starter' });
    expect(res.headers.get('location')).toBe('/konto/plan?besked=har-abonnement');
  });
});

describe('Henvendelser', () => {
  it('opretter, lister og sender notifikation til salg@veyro.dk', async () => {
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
    const mail = await waitFor(async () => (await emails()).slice(before).find((e) => e.to[0] === 'salg@veyro.dk'));
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
    expect(r.headers.get('location')).toBe('/admin/login');
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

describe('Admin: login via mail-link', () => {
  async function requestLink(client, email) {
    const page = await client.get('/admin/login');
    const before = (await emails()).length;
    const r = await client.post('/admin/login', { _csrf: csrfFrom(page.html), email });
    expect(r.status).toBe(200);
    expect(r.html).toContain('Tjek din indbakke');
    return before;
  }

  it('login-siden er ikke linket fra kundesiderne', async () => {
    const { client } = await as('anna@example.dk');
    for (const p of ['/login', '/bestil', '/opret']) {
      expect((await new Client(stack.base).get(p)).html).not.toContain('/admin/login');
    }
    expect((await client.get('/konto')).html).not.toContain('/admin');
    expect((await client.get('/admin/fakturaer')).status).toBe(403);
  });

  it('kunder får intet link, men samme svar', async () => {
    const before = await requestLink(new Client(stack.base), 'anna@example.dk');
    await new Promise((r) => setTimeout(r, 300));
    expect((await emails()).slice(before).some((e) => e.to[0] === 'anna@example.dk')).toBe(false);
  });

  it('admin logger ind via link og forbliver logget ind i et år', async () => {
    const client = new Client(stack.base);
    const before = await requestLink(client, ADMIN_EMAIL.toUpperCase());
    const mail = await waitFor(async () => (await emails()).slice(before).find((e) => e.to[0] === ADMIN_EMAIL));
    expect(mail.subject).toContain('admin');
    const link = mail.text.match(/https?:\/\/\S+\/login\/bekraeft\?token=[A-Za-z0-9_%-]+/)[0];
    const confirm = await client.get(link.replace(stack.base, ''));
    const res = await fetch(stack.base + '/login/bekraeft', {
      method: 'POST', redirect: 'manual',
      headers: { Cookie: client.cookieHeader(), 'Content-Type': 'application/x-www-form-urlencoded', Origin: stack.base, 'CF-Connecting-IP': client.ip },
      body: new URLSearchParams({ _csrf: csrfFrom(confirm.html), token: decodeURIComponent(new URL(link).searchParams.get('token')) }).toString(),
    });
    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toBe('/admin');
    const cookie = res.headers.getSetCookie().find((c) => c.startsWith('vk_session='));
    expect(Number(cookie.match(/Max-Age=(\d+)/i)[1])).toBe(365 * 86400);
    client.store(res);
    expect((await client.get('/admin/fakturaer')).status).toBe(200);
    expect((await client.get('/admin/adgangskode')).status).toBe(404);
  });

  it('kunders login varer stadig 30 dage', async () => {
    await seedCustomer(stack, { email: 'carl@example.dk', name: 'Carl', cus: 'cus_C', sub: 'sub_C', price: 'price_starter_test', start: now() - 40 * DAY });
    const client = new Client(stack.base);
    const page = await client.get('/login');
    const before = (await emails()).length;
    await client.post('/login', { _csrf: csrfFrom(page.html), email: 'carl@example.dk' });
    const mail = await waitFor(async () => (await emails()).slice(before).find((e) => e.to[0] === 'carl@example.dk'));
    const link = mail.text.match(/https?:\/\/\S+\/login\/bekraeft\?token=[A-Za-z0-9_%-]+/)[0];
    const confirm = await client.get(link.replace(stack.base, ''));
    const res = await fetch(stack.base + '/login/bekraeft', {
      method: 'POST', redirect: 'manual',
      headers: { Cookie: client.cookieHeader(), 'Content-Type': 'application/x-www-form-urlencoded', Origin: stack.base, 'CF-Connecting-IP': client.ip },
      body: new URLSearchParams({ _csrf: csrfFrom(confirm.html), token: decodeURIComponent(new URL(link).searchParams.get('token')) }).toString(),
    });
    const cookie = res.headers.getSetCookie().find((c) => c.startsWith('vk_session='));
    expect(Number(cookie.match(/Max-Age=(\d+)/i)[1])).toBe(30 * 86400);
  });
});

describe('Admin: fakturaer', () => {
  const mockInvoices = async () => (await fetch(stack.mock.url + '/__mock/invoices')).json();
  const setMock = (s) => fetch(stack.mock.url + '/__mock/state', { method: 'POST', body: JSON.stringify(s) });
  const formFrom = (html, extra) => ({
    _csrf: csrfFrom(html),
    key: html.match(/name="key" value="([^"]+)"/)[1],
    days: '8',
    vat: '1',
    line0_qty: '1',
    ...extra,
  });

  it('kunder har ikke adgang', async () => {
    const { client } = await as('anna@example.dk');
    expect((await client.get('/admin/fakturaer')).status).toBe(403);
  });

  it('opretter og sender en faktura med moms til en ny kunde', async () => {
    const { client } = await as(ADMIN_EMAIL);
    const page = await client.get('/admin/fakturaer');
    expect(page.status).toBe(200);
    expect(page.html).toContain('Ny engangsfaktura');
    const before = (await calls()).length;
    const res = await client.post('/admin/fakturaer', formFrom(page.html, {
      email: 'Lager@Firma.dk', name: 'Firma ApS', action: 'send',
      line0_desc: 'Opsætning af ordresystem', line0_price: '4.500', line1_desc: 'Oplæring', line1_qty: '2', line1_price: '750,50',
    }));
    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toMatch(/^\/admin\/fakturaer\?besked=sendt#in_/);
    const inv = (await mockInvoices()).at(-1);
    expect(inv.customer_email).toBe('lager@firma.dk');
    expect(inv.status).toBe('open');
    expect(inv._sent).toBe(1);
    // (4500 + 2 * 750,50) * 1,25 = 7500,50 * 1,25
    expect(inv.total).toBe(Math.round(600100 * 1.25));
    expect(inv._params.collection_method).toBe('send_invoice');
    expect(inv._params['managed_payments[enabled]']).toBe('false');
    const made = (await calls()).slice(before);
    expect(made.filter((c) => c.path === '/v1/tax_rates' && c.method === 'POST')).toHaveLength(1);
    expect(made.find((c) => c.path === '/v1/invoices' && c.method === 'POST').idempotencyKey).toMatch(/^admin-inv-/);
    const list = await client.get('/admin/fakturaer?besked=sendt');
    expect(list.html).toContain('Fakturaen er sendt til kunden');
    expect(list.html).toContain('Firma ApS');
    expect(list.html).toContain('Afventer betaling');
  });

  it('gemmer kladde uden moms til eksisterende kunde, og kladden kan sendes', async () => {
    const { client } = await as(ADMIN_EMAIL);
    const page = await client.get('/admin/fakturaer');
    const res = await client.post('/admin/fakturaer', formFrom(page.html, {
      email: 'anna@example.dk', name: 'Anna Jensen', action: 'draft', vat: '', line0_desc: 'Ekstra arbejde', line0_price: '1000',
    }));
    expect(res.status).toBe(303);
    const inv = (await mockInvoices()).at(-1);
    expect(inv.customer).toBe('cus_A');
    expect(inv.status).toBe('draft');
    expect(inv.total).toBe(100000);
    expect(inv._params['default_tax_rates[0]']).toBeUndefined();
    const list = await client.get('/admin/fakturaer');
    expect(list.html).toContain(`/admin/fakturaer/${inv.id}/send`);
    const sent = await client.post(`/admin/fakturaer/${inv.id}/send`, { _csrf: csrfFrom(list.html) });
    expect(sent.status).toBe(303);
    const after = (await mockInvoices()).find((i) => i.id === inv.id);
    expect(after.status).toBe('open');
    expect(after._sent).toBe(1);
    const paid = await client.post(`/admin/fakturaer/${inv.id}/betalt`, { _csrf: csrfFrom(list.html) });
    expect(paid.status).toBe(303);
    expect((await mockInvoices()).find((i) => i.id === inv.id).status).toBe('paid');
  });

  it('kladder kan slettes, og ugyldige id’er afvises', async () => {
    const { client } = await as(ADMIN_EMAIL);
    const page = await client.get('/admin/fakturaer');
    await client.post('/admin/fakturaer', formFrom(page.html, { email: 'bo@example.dk', name: 'Bo', action: 'draft', line0_desc: 'Test', line0_price: '10' }));
    const inv = (await mockInvoices()).at(-1);
    const del = await client.post(`/admin/fakturaer/${inv.id}/slet`, { _csrf: csrfFrom(page.html) });
    expect(del.status).toBe(303);
    expect((await mockInvoices()).some((i) => i.id === inv.id)).toBe(false);
    expect((await client.post('/admin/fakturaer/abc/slet', { _csrf: csrfFrom(page.html) })).status).toBe(400);
    expect((await client.post(`/admin/fakturaer/${inv.id}/hack`, { _csrf: csrfFrom(page.html) })).status).toBe(400);
  });

  it('viser valideringsfejl og bevarer det indtastede', async () => {
    const { client } = await as(ADMIN_EMAIL);
    const page = await client.get('/admin/fakturaer');
    const n = (await mockInvoices()).length;
    const bad = await client.post('/admin/fakturaer', formFrom(page.html, { email: 'x@firma.dk', name: 'X', action: 'send', line0_desc: 'Noget', line0_price: 'abc' }));
    expect(bad.status).toBe(400);
    expect(bad.html).toContain('Linje 1: skriv en gyldig pris');
    expect(bad.html).toContain('value="Noget"');
    const empty = await client.post('/admin/fakturaer', formFrom(page.html, { email: 'x@firma.dk', name: 'X', action: 'send' }));
    expect(empty.html).toContain('mindst én linje');
    expect((await mockInvoices()).length).toBe(n);
  });

  it('dobbelt indsendelse bruger samme engangsnøgle', async () => {
    const { client } = await as(ADMIN_EMAIL);
    const page = await client.get('/admin/fakturaer');
    const form = formFrom(page.html, { email: 'bo@example.dk', name: 'Bo', action: 'draft', line0_desc: 'Dobbelt', line0_price: '20' });
    const before = (await calls()).length;
    await client.post('/admin/fakturaer', form);
    await client.post('/admin/fakturaer', form);
    const keys = (await calls()).slice(before).filter((c) => c.path === '/v1/invoices' && c.method === 'POST').map((c) => c.idempotencyKey);
    expect(keys).toHaveLength(2);
    expect(keys[0]).toBe(keys[1]);
  });

  it('prøver igen uden managed_payments, hvis Stripe ikke kender parameteren', async () => {
    const { client } = await as(ADMIN_EMAIL);
    await setMock({ rejectManagedPayments: true });
    const page = await client.get('/admin/fakturaer');
    const res = await client.post('/admin/fakturaer', formFrom(page.html, { email: 'bo@example.dk', name: 'Bo', action: 'draft', line0_desc: 'Fallback', line0_price: '30' }));
    await setMock({ rejectManagedPayments: false });
    expect(res.status).toBe(303);
    expect((await mockInvoices()).at(-1)._params['managed_payments[enabled]']).toBeUndefined();
  });

  it('viser Stripes fejl uden at miste formularen', async () => {
    const { client } = await as(ADMIN_EMAIL);
    await setMock({ failNext: '/v1/invoiceitems' });
    const page = await client.get('/admin/fakturaer');
    const res = await client.post('/admin/fakturaer', formFrom(page.html, { email: 'bo@example.dk', name: 'Bo', action: 'send', line0_desc: 'Fejl', line0_price: '40' }));
    expect(res.status).toBe(502);
    expect(res.html).toContain('Stripe svarede: Simuleret fejl');
    expect(res.html).toContain('value="Fejl"');
  });
});

describe('Admin: abonnementer', () => {
  const subState = async (id) => (await fetch(stack.mock.url + '/__mock/subscriptions/' + id)).json();
  const subStateFor = subState;
  const coupons = async () => (await fetch(stack.mock.url + '/__mock/coupons')).json();
  const formFrom = (html, extra) => ({ _csrf: csrfFrom(html), key: html.match(/name="key" value="([^"]+)"/)[1], days: '8', vat: '1', line0_qty: '1', ...extra });
  const newSubId = (res) => res.headers.get('location').split('#')[1];

  it('kunder har ikke adgang', async () => {
    const { client } = await as('anna@example.dk');
    expect((await client.get('/admin/abonnementer')).status).toBe(403);
  });

  it('opretter abonnement med første måned gratis og tilbud på første betalte måned', async () => {
    const { client } = await as(ADMIN_EMAIL);
    const page = await client.get('/admin/abonnementer');
    expect(page.html).toContain('Opret med første måned gratis');
    const res = await client.post('/admin/abonnementer', formFrom(page.html, {
      email: 'drift@lagerfirma.dk', name: 'Lagerfirma ApS', action: 'free',
      line0_desc: 'Internt system til ordrer og varekontrol', line0_price: '2.500', offer: '50', offer_kind: 'pct',
    }));
    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toContain('besked=oprettet-gratis');
    const sub = await subState(newSubId(res));
    expect(sub.status).toBe('trialing');
    const p = sub._params;
    expect(p.collection_method).toBe('send_invoice');
    expect(p['items[0][price_data][unit_amount]']).toBe('250000');
    expect(p['items[0][price_data][recurring][interval]']).toBe('month');
    expect(p['default_tax_rates[0]']).toBeTruthy();
    // Prøveperioden slutter om ca. en måned
    const days = (Number(p.trial_end) - Date.now() / 1000) / 86400;
    expect(days).toBeGreaterThan(26);
    expect(days).toBeLessThan(33);
    const coupon = (await coupons())[sub.discounts[0]];
    expect(coupon.percent_off).toBe(50);
    expect(coupon.duration).toBe('repeating');
    expect(coupon.duration_in_months).toBe(2);
    const list = await client.get('/admin/abonnementer');
    expect(list.html).toContain('Lagerfirma ApS');
    expect(list.html).toContain('Gratis måned');
    expect(list.html).toContain('Tilbud: 50 % rabat');
  });

  it('opretter abonnement med betaling fra start, ændrer pris og giver tilbud i én måned', async () => {
    const { client } = await as(ADMIN_EMAIL);
    const page = await client.get('/admin/abonnementer');
    const res = await client.post('/admin/abonnementer', formFrom(page.html, {
      email: 'bo@example.dk', name: 'Bo Hansen', action: 'paid', vat: '',
      line0_desc: 'Hjemmeside med bestilling', line0_price: '1500', line1_desc: 'Ekstra bruger', line1_qty: '3', line1_price: '100',
    }));
    expect(res.status).toBe(303);
    const id = newSubId(res);
    let sub = await subState(id);
    expect(sub.status).toBe('active');
    expect(sub._params.trial_end).toBeUndefined();
    expect(sub._params['default_tax_rates[0]']).toBeUndefined();
    expect(sub.items.data).toHaveLength(2);
    expect(sub.items.data[1].quantity).toBe(3);

    const list = await client.get('/admin/abonnementer');
    const item = sub.items.data[0].id;
    const priced = await client.post(`/admin/abonnementer/${id}/pris`, { _csrf: csrfFrom(list.html), item, price: '1.750' });
    expect(priced.status).toBe(303);
    sub = await subState(id);
    expect(sub.items.data[0].price.unit_amount).toBe(175000);
    expect(sub._proration).toBe('none');

    const offered = await client.post(`/admin/abonnementer/${id}/tilbud`, { _csrf: csrfFrom(list.html), offer: '500', offer_kind: 'kr' });
    expect(offered.status).toBe(303);
    sub = await subState(id);
    const coupon = (await coupons())[sub.discounts[0]];
    expect(coupon.amount_off).toBe(50000);
    expect(coupon.duration).toBe('once');
    const removed = await client.post(`/admin/abonnementer/${id}/fjern-tilbud`, { _csrf: csrfFrom(list.html) });
    expect(removed.status).toBe(303);
    expect((await subState(id)).discounts).toHaveLength(0);

    expect((await client.post(`/admin/abonnementer/${id}/opsig`, { _csrf: csrfFrom(list.html) })).status).toBe(303);
    expect((await subState(id)).cancel_at_period_end).toBe(true);
    expect((await client.post(`/admin/abonnementer/${id}/genoptag`, { _csrf: csrfFrom(list.html) })).status).toBe(303);
    expect((await subState(id)).cancel_at_period_end).toBe(false);
  });

  it('sender velkomstmail med kortlink; kortet gør abonnementet automatisk', async () => {
    const { client } = await as(ADMIN_EMAIL);
    const page = await client.get('/admin/abonnementer');
    const before = (await emails()).length;
    const res = await client.post('/admin/abonnementer', formFrom(page.html, {
      email: 'kort@kunde.dk', name: 'Karen Kort', action: 'free', line0_desc: 'Ordresystem', line0_price: '1000',
    }));
    const id = newSubId(res);
    const mail = await waitFor(async () => (await emails()).slice(before).find((e) => e.to[0] === 'kort@kunde.dk'));
    expect(mail.subject).toContain('betalingskort');
    expect(mail.text).toContain('Hej Karen');
    expect(mail.text).toContain('første måned er gratis');
    const link = mail.text.match(/https?:\/\/\S+\/kort\/(sub_[^\s]+)/);
    const token = link[1];
    expect(token.startsWith(id + '.')).toBe(true);

    const visitor = new Client(stack.base);
    const cardPage = await visitor.get('/kort/' + token);
    expect(cardPage.status).toBe(200);
    expect(cardPage.html).toContain('Tilføj betalingskort');
    expect((await visitor.get('/kort/' + token.slice(0, -1) + (token.endsWith('a') ? 'b' : 'a'))).status).toBe(400);
    expect((await visitor.get('/kort/sub_A.9999999999.' + '0'.repeat(40))).status).toBe(400);

    const go = await visitor.post('/kort/' + token, { _csrf: csrfFrom(cardPage.html) });
    expect(go.status).toBe(303);
    const csId = go.headers.get('location').split('/').pop();
    const cs = (await calls()).filter((c) => c.path === '/v1/checkout/sessions' && c.method === 'POST').at(-1).params;
    expect(cs.mode).toBe('setup');
    expect(cs['metadata[veyro_subscription]']).toBe(id);

    const done = await visitor.get(`/kort/${token}/tak?session_id=${csId}`);
    expect(done.status).toBe(200);
    expect(done.html).toContain('dit kort er tilføjet');
    const sub = await subState(id);
    expect(sub.collection_method).toBe('charge_automatically');
    expect(sub.default_payment_method).toBe('pm_card_' + csId);

    const list = await client.get('/admin/abonnementer');
    expect(list.html).toContain('Kort tilknyttet');
  });

  it('webhook for kort-opsætning gør også abonnementet automatisk', async () => {
    const { client } = await as(ADMIN_EMAIL);
    const page = await client.get('/admin/abonnementer');
    const res = await client.post('/admin/abonnementer', formFrom(page.html, { email: 'hook@kunde.dk', name: 'Hook', action: 'paid', line0_desc: 'X', line0_price: '100' }));
    const id = newSubId(res);
    const list = await client.get('/admin/abonnementer');
    expect(list.html).toContain(`/admin/abonnementer/${id}/kortlink`);
    const before = (await emails()).length;
    expect((await client.post(`/admin/abonnementer/${id}/kortlink`, { _csrf: csrfFrom(list.html) })).status).toBe(303);
    expect((await emails()).slice(before).some((e) => e.to[0] === 'hook@kunde.dk')).toBe(true);
    const cus = (await subState(id)).customer;
    const csRes = await fetch(stack.mock.url + '/v1/checkout/sessions', { method: 'POST', headers: { Authorization: 'Bearer sk_test_mock', 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ mode: 'setup', customer: cus, 'metadata[veyro_subscription]': id }).toString() });
    const cs = await csRes.json();
    const hook = await signedWebhook(stack.base, { id: 'evt_setup_' + id, type: 'checkout.session.completed', data: { object: { id: cs.id, mode: 'setup', metadata: { veyro_subscription: id } } } });
    expect(hook.status).toBe(200);
    expect((await subState(id)).collection_method).toBe('charge_automatically');
    const mail = await waitFor(async () => (await emails()).slice(before).find((e) => e.to[0] === 'salg@veyro.dk'));
    expect(mail.subject).toContain('Tilbud accepteret');
    expect(mail.reply_to).toBe('hook@kunde.dk');
  });

  it('kunder med særaftale kan ikke skifte til en standardplan', async () => {
    await seedCustomer(stack, { email: 'saer@example.dk', name: 'Sær', cus: 'cus_S', sub: 'sub_S', price: 'price_custom', start: now() - 40 * DAY });
    const { client } = await as('saer@example.dk');
    const page = await client.get('/konto/plan');
    expect(page.html).toContain('særaftale');
    expect(page.html).not.toContain('/konto/plan/bekraeft?plan=');
    const post = await client.post('/konto/plan', { _csrf: csrfFrom(page.html), plan: 'premium' });
    expect(post.headers.get('location')).toBe('/konto/plan');
    expect((await subStateFor('sub_S')).items.data[0].price.id).toBe('price_custom');
  });

  it('afviser ugyldige værdier', async () => {
    const { client } = await as(ADMIN_EMAIL);
    const page = await client.get('/admin/abonnementer');
    const bad = await client.post('/admin/abonnementer', formFrom(page.html, { email: 'x@firma.dk', name: 'X', action: 'free', line0_desc: 'Noget', line0_price: '100', offer: '150', offer_kind: 'pct' }));
    expect(bad.status).toBe(400);
    expect(bad.html).toContain('fra 1 til 100');
    expect(bad.html).toContain('value="Noget"');
    const subs = Object.keys(await (await fetch(stack.mock.url + '/__mock/state', { method: 'POST', body: '{}' })).json());
    expect(subs).toBeTruthy();
    expect((await client.post('/admin/abonnementer/sub_A/pris', { _csrf: csrfFrom(page.html), item: 'si_A', price: 'abc' })).status).toBe(400);
    expect((await client.post('/admin/abonnementer/xyz/opsig', { _csrf: csrfFrom(page.html) })).status).toBe(400);
    expect((await client.post('/admin/abonnementer/sub_A/slet', { _csrf: csrfFrom(page.html) })).status).toBe(400);
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
