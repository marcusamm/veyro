// Hele forløbet for tilbud med individuel pris: oprettelse → betalingslink → Stripe Checkout →
// webhook-aktivering → fornyelse → prisændring → mislykket betaling → opsigelse.
// Stripe er en lokal simulator (tests/mock-server.mjs); der rammes aldrig et rigtigt Stripe-miljø.
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ADMIN_EMAIL, Client, ROOT, csrfFrom, login, signedWebhook, startStack, waitFor } from './harness.mjs';

const DAY = 86400;
let stack;
let admin;

const calls = async () => (await fetch(stack.mock.url + '/__mock/calls')).json();
const emails = async () => (await fetch(stack.mock.url + '/__mock/emails')).json();
const sim = async () => (await fetch(stack.mock.url + '/__mock/sim')).json();
const simPost = async (p, body) => (await fetch(stack.mock.url + p, { method: 'POST', body: JSON.stringify(body) })).json();
const setState = (s) => fetch(stack.mock.url + '/__mock/state', { method: 'POST', body: JSON.stringify(s) });
let evtN = 0;
const event = (type, object, id) => signedWebhook(stack.base, { id: id ?? `evt_offer_${++evtN}`, type, data: { object } });

function sql(query) {
  const out = execFileSync(
    path.join(ROOT, 'node_modules', '.bin', 'wrangler'),
    ['d1', 'execute', 'veyro-kundepanel', '--local', '--persist-to', stack.persist, '--json', '--command', query],
    { cwd: ROOT, env: { ...process.env, WRANGLER_SEND_METRICS: 'false', CI: '1' }, stdio: 'pipe' },
  ).toString();
  return JSON.parse(out)[0].results;
}

const form = (html, extra) => ({
  _csrf: csrfFrom(html),
  key: html.match(/name="key" value="([^"]+)"/)[1],
  interval: 'month',
  vat: '1',
  valid_days: '14',
  ...extra,
});

async function createOffer(extra) {
  const page = await admin.get('/admin/tilbud');
  const res = await admin.post('/admin/tilbud', form(page.html, extra));
  return { res, page };
}

const offerIdFrom = (res) => Number(res.headers.get('location').match(/^\/admin\/tilbud\/(\d+)/)[1]);
const tokenFor = (id) => sql(`SELECT token FROM offers WHERE id = ${id}`)[0].token;

/** Kunden åbner linket, sætter kryds og sendes til Stripe Checkout. */
async function goToCheckout(token, client = new Client(stack.base)) {
  const page = await client.get(`/tilbud/${token}`);
  const csrf = page.html.includes('name="_csrf"') ? csrfFrom(page.html) : csrfFrom((await client.get('/login')).html);
  const res = await client.post(`/tilbud/${token}`, { _csrf: csrf, accept: '1' });
  return { client, page, res };
}

beforeAll(async () => {
  stack = await startStack({ minMonths: 0 });
  admin = (await login(stack, ADMIN_EMAIL)).client;
});

afterAll(async () => {
  await stack?.stop();
});

describe('Tilbud med individuel pris og betalingslink', () => {
  const S = {}; // delt tilstand mellem trinene

  it('kun admin kan oprette tilbud', async () => {
    const anon = new Client(stack.base);
    const res = await anon.get('/admin/tilbud');
    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toBe('/admin/login');
  });

  it('validerer pris, CVR og "allerede faktureret"', async () => {
    let { res } = await createOffer({ name: 'Mette', email: 'mette@byg.dk', service: 'Drift', price: '' });
    expect(res.status).toBe(400);
    expect(res.html).toContain('Skriv en gyldig pris');
    ({ res } = await createOffer({ name: 'Mette', email: 'mette@byg.dk', service: 'Drift', price: '1000', cvr: '123' }));
    expect(res.status).toBe(400);
    expect(res.html).toContain('CVR-nummeret skal være 8 cifre');
    ({ res } = await createOffer({ name: 'Mette', email: 'mette@byg.dk', service: 'Drift', price: '1000', setup_price: '500', setup_description: 'Opsætning', setup_settled: '1' }));
    expect(res.status).toBe(400);
    expect(res.html).toContain('Skriv hvilken faktura');
    expect(res.html).toContain('value="mette@byg.dk"'); // formularen bevares
  });

  it('opretter kunde og fast pris i Stripe; dobbelt indsendelse giver ét tilbud', async () => {
    const before = (await calls()).length;
    const { page } = await createOffer({});
    const body = form(page.html, {
      name: 'Mette Holm', email: 'Mette@Byg.dk', company: 'Holm Byg ApS', cvr: '12 34 56 78', address: 'Havnegade 1', postal_code: '8000', city: 'Aarhus',
      phone: '+45 12 34 56 78', service: 'Hjemmeside med drift og support', description: 'Hosting, opdateringer og to timers ændringer om måneden.',
      price: '1.499', setup_price: '4.500', setup_description: 'Oprettelse og udvikling',
    });
    const [r1, r2] = await Promise.all([admin.post('/admin/tilbud', body), admin.post('/admin/tilbud', body)]);
    expect(r1.status).toBe(303);
    expect(r2.status).toBe(303);
    S.offerId = offerIdFrom(r1);
    expect(offerIdFrom(r2)).toBe(S.offerId);
    expect(sql("SELECT COUNT(*) AS n FROM offers WHERE email = 'mette@byg.dk'")[0].n).toBe(1);

    const made = (await calls()).slice(before);
    const cust = made.find((c) => c.path === '/v1/customers' && c.method === 'POST');
    expect(cust.params.name).toBe('Holm Byg ApS');
    expect(cust.params['metadata[cvr]']).toBe('12345678');
    expect(cust.params['address[postal_code]']).toBe('8000');
    expect(made.find((c) => c.path.endsWith('/tax_ids')).params.value).toBe('DK12345678');
    const offer = sql(`SELECT * FROM offers WHERE id = ${S.offerId}`)[0];
    const { prices } = await sim();
    expect(prices[offer.stripe_price_id]).toMatchObject({ unit_amount: 149900, recurring: { interval: 'month' }, currency: 'dkk' });
    expect(prices[offer.stripe_setup_price_id]).toMatchObject({ unit_amount: 450000, recurring: null });
    S.token = offer.token;
    S.cus = offer.stripe_customer_id;
    S.priceId = offer.stripe_price_id;
    expect(S.token).toMatch(/^[A-Za-z0-9_-]{43}$/);

    const detail = await admin.get(`/admin/tilbud/${S.offerId}?besked=oprettet`);
    expect(detail.html).toContain(`/tilbud/${S.token}`);
    expect(detail.html).toContain('Sendt, afventer kunden');
  });

  it('sender tilbuddet på mail med personligt link og nøgletal', async () => {
    const page = await admin.get(`/admin/tilbud/${S.offerId}`);
    const res = await admin.post(`/admin/tilbud/${S.offerId}/send`, { _csrf: csrfFrom(page.html) });
    expect(res.status).toBe(303);
    const mail = (await emails()).findLast((e) => e.to[0] === 'mette@byg.dk');
    expect(mail.subject).toBe('Tilbud fra Veyro: Hjemmeside med drift og support');
    expect(mail.text).toContain(`/tilbud/${S.token}`);
    expect(mail.text).toContain('1.499 kr. ekskl. moms pr. måned (1.873,75 kr. inkl. 25 % moms)');
    expect(mail.text).toContain('Oprettelse og udvikling: 4.500 kr. ekskl. moms, betales én gang');
  });

  it('kundens side viser ydelse, pris, moms, interval og opsigelsesvilkår', async () => {
    const res = await new Client(stack.base).get(`/tilbud/${S.token}`);
    expect(res.status).toBe(200);
    for (const s of ['Hjemmeside med drift og support', 'Holm Byg ApS, CVR 12345678', '1.499 kr.', 'Moms 25 %', '374,75 kr.', '1.873,75 kr.', 'pr. måned',
      'Oprettelse og udvikling', 'betales én gang', 'Betales ved tilmelding', '7.498,75 kr.', 'uden binding', 'Opsigelsen gælder fra udgangen af den periode']) {
      expect(res.html).toContain(s);
    }
    expect((await new Client(stack.base).get('/tilbud/' + 'x'.repeat(43))).status).toBe(404);
    expect((await new Client(stack.base).get('/tilbud/kort')).status).toBe(404);
  });

  it('kræver godkendelse af vilkår; linket fører til Checkout med den faste pris', async () => {
    const client = new Client(stack.base);
    const page = await client.get(`/tilbud/${S.token}`);
    const before = (await calls()).length;
    const no = await client.post(`/tilbud/${S.token}`, { _csrf: csrfFrom(page.html) });
    expect(no.status).toBe(400);
    expect(no.html).toContain('Sæt kryds');
    expect((await calls()).slice(before).some((c) => c.path === '/v1/checkout/sessions')).toBe(false);

    // Kunden kan ikke sende sit eget beløb med: felter ud over accept ignoreres.
    const res = await client.post(`/tilbud/${S.token}`, { _csrf: csrfFrom(page.html), accept: '1', price: '1', amount: '100' });
    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toMatch(/^https:\/\/checkout\.stripe\.com\/c\/pay\/cs_offer_/);
    const cs = (await calls()).slice(before).find((c) => c.path === '/v1/checkout/sessions' && c.method === 'POST').params;
    expect(cs.mode).toBe('subscription');
    expect(cs.customer).toBe(S.cus);
    expect(cs['line_items[0][price]']).toBe(S.priceId);
    expect(cs['line_items[1][price]']).toBeTruthy();
    expect(cs['line_items[0][tax_rates][0]']).toBe('txr_vat');
    expect(Object.keys(cs).some((k) => k.includes('price_data') || k.includes('adjustable'))).toBe(false);
    expect(cs['metadata[veyro_offer]']).toBe(String(S.offerId));
    expect(cs['subscription_data[metadata][veyro_offer]']).toBe(String(S.offerId));
    expect(cs['managed_payments[enabled]']).toBe('false');
    expect(cs['custom_text[submit][message]']).toContain('til du opsiger');
    expect(Number(cs.expires_at) - Date.now() / 1000).toBeGreaterThan(22 * 3600);
    S.session = res.headers.get('location').split('/').pop();
  });

  it('gentagne og samtidige klik genbruger samme Checkout-session', async () => {
    const before = (await calls()).filter((c) => c.path === '/v1/checkout/sessions' && c.method === 'POST').length;
    const results = await Promise.all([1, 2, 3].map(() => goToCheckout(S.token)));
    for (const { res } of results) expect(res.headers.get('location')).toContain(S.session);
    const after = (await calls()).filter((c) => c.path === '/v1/checkout/sessions' && c.method === 'POST').length;
    expect(after).toBe(before);
  });

  it('takkesiden er ikke bevis for betaling', async () => {
    const res = await new Client(stack.base).get(`/tilbud/${S.token}/tak?session_id=${S.session}`);
    expect(res.html).toContain('vi venter på bekræftelse');
    expect(sql(`SELECT status FROM offers WHERE id = ${S.offerId}`)[0].status).toBe('open');
    expect(sql("SELECT COUNT(*) AS n FROM customers WHERE email = 'mette@byg.dk'")[0].n).toBe(0);
  });

  it('webhook uden gyldig signatur aktiverer intet', async () => {
    const done = await simPost('/__mock/checkout/complete', { session: S.session });
    S.sub = done.subscription.id;
    S.firstInvoice = done.invoice;
    S.doneSession = done.session;
    expect(S.firstInvoice.amount_due).toBe(Math.round((149900 + 450000) * 1.25));
    const forged = await signedWebhook(stack.base, { id: 'evt_forged', type: 'checkout.session.completed', data: { object: done.session } }, 'whsec_forkert');
    expect(forged.status).toBe(400);
    expect(sql(`SELECT status FROM offers WHERE id = ${S.offerId}`)[0].status).toBe('open');
  });

  it('verificeret webhook aktiverer kunden én gang, også ved gentagne hændelser', async () => {
    const session = S.doneSession;
    const before = (await emails()).length;
    expect((await event('checkout.session.completed', session, 'evt_cs_done')).status).toBe(200);
    expect((await event('checkout.session.completed', session, 'evt_cs_done')).status).toBe(200); // samme hændelse igen
    expect((await event('checkout.session.completed', session)).status).toBe(200); // ny hændelse, samme session
    const offer = sql(`SELECT * FROM offers WHERE id = ${S.offerId}`)[0];
    expect(offer.status).toBe('active');
    expect(offer.subscription_id).toBe(S.sub);
    expect(offer.activated_at).toBeGreaterThan(0);
    const cust = sql("SELECT * FROM customers WHERE email = 'mette@byg.dk'")[0];
    expect(cust).toMatchObject({ company: 'Holm Byg ApS', cvr: '12345678', address: 'Havnegade 1', postal_code: '8000', city: 'Aarhus', stripe_customer_id: S.cus });
    S.customerId = cust.id;
    expect(sql(`SELECT * FROM subscriptions WHERE id = '${S.sub}'`)[0]).toMatchObject({ status: 'active', amount: 149900, interval: 'month', offer_id: S.offerId });
    const sent = (await emails()).slice(before);
    expect(sent.filter((e) => e.to[0] === 'mette@byg.dk' && e.subject.includes('er aktivt'))).toHaveLength(1);
    expect(sent.filter((e) => e.to[0] === 'kontakt@veyro.dk' && e.subject.startsWith('Ny kunde aktiv'))).toHaveLength(1);

    // Linket kan ikke bruges til at betale igen.
    const again = await goToCheckout(S.token);
    expect(again.res.status).toBe(303);
    expect(again.res.headers.get('location')).toBe(`/tilbud/${S.token}`);
    expect((await new Client(stack.base).get(`/tilbud/${S.token}`)).html).toContain('Abonnementet er aktivt');
    expect((await new Client(stack.base).get(`/tilbud/${S.token}/tak`)).html).toContain('dit abonnement er aktivt');
  });

  it('første betaling registreres, og admin ser kundens oversigt', async () => {
    expect((await event('invoice.paid', S.firstInvoice)).status).toBe(200);
    const page = await admin.get(`/admin/kunder/${S.customerId}`);
    expect(page.status).toBe(200);
    for (const s of ['Holm Byg ApS', 'Mette Holm', 'mette@byg.dk', '12345678', 'Havnegade 1, 8000 Aarhus', 'Hjemmeside med drift og support',
      '1.499 kr. ekskl. moms pr. måned', 'Næste betaling', 'Opsigelsesdato', S.firstInvoice.number, 'Betalt', '7.498,75 kr.']) {
      expect(page.html).toContain(s);
    }
    const list = await admin.get('/admin/kunder');
    expect(list.html).toContain(`/admin/kunder/${S.customerId}`);
    expect(list.html).toContain('Individuel pris');
  });

  it('kunden ser abonnementet og kan åbne Stripes kundeportal', async () => {
    const { client } = await login(stack, 'mette@byg.dk');
    const dash = await client.get('/konto');
    expect(dash.html).toContain('1.499 kr. /md. ekskl. moms');
    expect(dash.html).not.toContain('btn btn-primary btn-block" href="/konto/plan"');
    const inv = await client.get('/konto/fakturaer');
    const before = (await calls()).length;
    const res = await client.post('/konto/portal', { _csrf: csrfFrom(inv.html) });
    expect(res.headers.get('location')).toMatch(/^https:\/\/billing\.stripe\.com\//);
    expect((await calls()).slice(before).find((c) => c.path === '/v1/billing_portal/sessions').params.customer).toBe(S.cus);
    S.customer = client;
  });

  it('fornyelse trækker den aftalte pris og opdaterer næste betalingsdato', async () => {
    const r = await simPost('/__mock/renew', { subscription: S.sub });
    expect(r.invoice.amount_due).toBe(Math.round(149900 * 1.25));
    expect((await event('invoice.paid', r.invoice)).status).toBe(200);
    expect((await event('customer.subscription.updated', r.subscription)).status).toBe(200);
    const row = sql(`SELECT current_period_end FROM subscriptions WHERE id = '${S.sub}'`)[0];
    expect(row.current_period_end).toBe(r.subscription.items.data[0].current_period_end);
    expect(sql(`SELECT COUNT(*) AS n FROM payments WHERE subscription_id = '${S.sub}' AND status = 'paid'`)[0].n).toBe(2);
  });

  it('prisændring fra næste periode: kun denne kunde, ingen efterregning, kunden får besked', async () => {
    const page = await admin.get(`/admin/kunder/${S.customerId}`);
    expect(page.html).toContain('(næste periode)');
    const before = (await calls()).length;
    const res = await admin.post(`/admin/kunder/${S.customerId}/abonnement/${S.sub}/pris`, {
      _csrf: csrfFrom(page.html), key: crypto.randomUUID(), price: '1.799', effective: 'next',
    });
    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toContain('besked=pris');
    const made = (await calls()).slice(before);
    const newPrice = made.find((c) => c.path === '/v1/prices' && c.method === 'POST').params;
    expect(newPrice).toMatchObject({ unit_amount: '179900', 'recurring[interval]': 'month' });
    const upd = made.find((c) => c.path === `/v1/subscriptions/${S.sub}` && c.method === 'POST').params;
    expect(upd.proration_behavior).toBe('none');
    expect(upd['items[0][tax_rates][0]']).toBe('txr_vat');
    // Den oprindelige pris (og dermed andre kunder) er uændret.
    expect((await sim()).prices[S.priceId].unit_amount).toBe(149900);
    const mail = (await emails()).findLast((e) => e.to[0] === 'mette@byg.dk');
    expect(mail.subject).toBe('Ny pris på dit abonnement hos Veyro');
    expect(mail.text).toContain('fra 1.499 kr. ekskl. moms pr. måned til 1.799 kr. ekskl. moms pr. måned');
    const after = await admin.get(`/admin/kunder/${S.customerId}`);
    expect(after.html).toContain('Ny pris 1.799 kr. ekskl. moms pr. måned fra');
    expect(after.html).toContain('1.499 kr. ekskl. moms pr. måned'); // nuværende pris vises stadig
    expect(after.html).toContain('Kunden har fået besked');
  });

  it('prisændring på en senere fornyelsesdato erstatter den forrige og bruger et Stripe-skema', async () => {
    const page = await admin.get(`/admin/kunder/${S.customerId}`);
    const dates = [...page.html.matchAll(/<option value="(\d{9,11})">/g)].map((m) => Number(m[1]));
    expect(dates.length).toBeGreaterThanOrEqual(2);
    S.effective = dates[1]; // tredje fornyelse fra nu
    const before = (await calls()).length;
    const res = await admin.post(`/admin/kunder/${S.customerId}/abonnement/${S.sub}/pris`, {
      _csrf: csrfFrom(page.html), key: crypto.randomUUID(), price: '1.999', effective: String(S.effective),
    });
    expect(res.status).toBe(303);
    const made = (await calls()).slice(before);
    const phases = made.find((c) => /^\/v1\/subscription_schedules\/[^/]+$/.test(c.path)).params;
    expect(Number(phases['phases[0][end_date]'])).toBe(S.effective);
    expect(phases['phases[0][items][0][price]']).toBe(S.priceId); // kunden betaler 1.499 indtil da
    expect(phases.proration_behavior).toBe('none');
    expect(phases.end_behavior).toBe('release');
    const changes = sql(`SELECT status, new_amount, old_amount FROM price_changes WHERE subscription_id = '${S.sub}' ORDER BY id`);
    expect(changes).toEqual([
      { status: 'canceled', new_amount: 179900, old_amount: 149900 },
      { status: 'scheduled', new_amount: 199900, old_amount: 149900 },
    ]);
    // Fornyelser: 1.499 indtil den valgte dato, derefter 1.999.
    const amounts = [];
    for (let i = 0; i < 3; i++) {
      const r = await simPost('/__mock/renew', { subscription: S.sub });
      amounts.push(r.invoice.amount_due);
      await event('invoice.paid', r.invoice);
      await event('customer.subscription.updated', r.subscription);
    }
    expect(amounts).toEqual([149900, 149900, 199900].map((a) => Math.round(a * 1.25)));
    expect(sql(`SELECT amount FROM subscriptions WHERE id = '${S.sub}'`)[0].amount).toBe(199900);
  });

  it('mislykket betaling vises for admin og kunde, og en sen fejlhændelse overskriver ikke en betaling', async () => {
    const before = (await emails()).length;
    const r = await simPost('/__mock/renew', { subscription: S.sub, fail: true });
    expect((await event('invoice.payment_failed', r.invoice)).status).toBe(200);
    expect(sql(`SELECT status, payment_failed FROM subscriptions WHERE id = '${S.sub}'`)[0]).toEqual({ status: 'past_due', payment_failed: 1 });
    const page = await admin.get(`/admin/kunder/${S.customerId}`);
    expect(page.html).toContain('Mislykkedes');
    expect(page.html).toContain('Betaling fejlet');
    expect((await emails()).slice(before).some((e) => e.to[0] === 'kontakt@veyro.dk' && e.subject.startsWith('Betaling mislykkedes'))).toBe(true);
    expect((await S.customer.get('/konto')).html).toContain('Betalingen mislykkedes');

    // Kunden skifter kort, og Stripe trækker igen.
    const paid = { ...r.invoice, status: 'paid', amount_paid: r.invoice.amount_due, attempt_count: 2 };
    await setState({ subscriptions: { [S.sub]: { ...r.subscription, status: 'active' } } });
    expect((await event('invoice.paid', paid)).status).toBe(200);
    expect((await event('invoice.payment_failed', r.invoice)).status).toBe(200); // forsinket, gammel hændelse
    expect(sql(`SELECT status FROM payments WHERE invoice_id = '${r.invoice.id}'`)[0].status).toBe('paid');
  });

  it('opsigelse stopper fornyelsen ved periodens udløb', async () => {
    const page = await S.customer.get('/konto/opsig');
    const res = await S.customer.post('/konto/opsig', { _csrf: csrfFrom(page.html) });
    expect(res.status).toBe(303);
    const sub = (await sim()).subscriptions[S.sub];
    expect(sub.cancel_at_period_end).toBe(true);
    const adminPage = await admin.get(`/admin/kunder/${S.customerId}`);
    expect(adminPage.html).toMatch(/Opsagt pr\. \d+\. \w+ \d{4}/);
    expect(adminPage.html).toContain('Fortsæt abonnementet');

    const ended = await simPost('/__mock/end', { subscription: S.sub });
    expect((await event('customer.subscription.deleted', ended)).status).toBe(200);
    expect(sql(`SELECT status FROM offers WHERE id = ${S.offerId}`)[0].status).toBe('ended');
    expect((await admin.get(`/admin/tilbud/${S.offerId}`)).html).toContain('Abonnement stoppet');
  });

  it('advarer om eksisterende fakturering, før et nyt tilbud til samme kunde oprettes', async () => {
    await setState({ subscriptions: { sub_other: { id: 'sub_other', object: 'subscription', customer: S.cus, status: 'active', items: { data: [{ id: 'si_o', price: { id: 'p', unit_amount: 50000, currency: 'dkk', recurring: { interval: 'month' } } }] } } } });
    const base = { name: 'Mette Holm', email: 'mette@byg.dk', service: 'Ekstra side', price: '300' };
    let { res, page } = await createOffer(base);
    expect(res.status).toBe(409);
    expect(res.html).toContain('Kunden har allerede noget i gang');
    expect(res.html).toContain('sub_other');
    expect(res.html).toContain(S.firstInvoice.number);
    res = await admin.post('/admin/tilbud', form(res.html, { ...base, confirm_existing: '1' }));
    expect(res.status).toBe(303);
  });

  it('første periode allerede betalt + oprettelse faktureret: intet opkræves to gange', async () => {
    const first = new Date(Date.now() + 10 * DAY * 1000).toISOString().slice(0, 10);
    const { res } = await createOffer({
      name: 'Jonas', email: 'jonas@cafe.dk', service: 'Webshop-drift', price: '12.000', interval: 'year',
      setup_price: '8.000', setup_description: 'Udvikling', setup_settled: '1', first_charge: first, settled_note: 'Faktura 1042',
    });
    expect(res.status).toBe(303);
    const id = offerIdFrom(res);
    const token = tokenFor(id);
    const view = await new Client(stack.base).get(`/tilbud/${token}`);
    expect(view.html).toContain('pr. år');
    expect(view.html).toContain('Første periode er allerede betalt');
    expect(view.html).toContain('allerede faktureret og opkræves ikke igen');
    const before = (await calls()).length;
    const { res: go } = await goToCheckout(token);
    expect(go.status).toBe(303);
    const cs = (await calls()).slice(before).find((c) => c.path === '/v1/checkout/sessions' && c.method === 'POST').params;
    expect(cs['line_items[1][price]']).toBeUndefined();
    expect(Number(cs['subscription_data[trial_end]'])).toBeGreaterThan(Date.now() / 1000 + 9 * DAY);
    const done = await simPost('/__mock/checkout/complete', { session: go.headers.get('location').split('/').pop() });
    expect(done.invoice.amount_due).toBe(0);
    expect(done.session.payment_status).toBe('no_payment_required');
    await event('checkout.session.completed', done.session);
    expect(sql(`SELECT status FROM offers WHERE id = ${id}`)[0].status).toBe('active');
    expect(sql(`SELECT status, interval FROM subscriptions WHERE id = '${done.subscription.id}'`)[0]).toEqual({ status: 'trialing', interval: 'year' });
    S.yearOffer = { id, token, session: done.session, sub: done.subscription.id };
  });

  it('en ekstra gennemført session på et aktivt tilbud stoppes straks (ingen dobbelt abonnement)', async () => {
    const { id, sub } = S.yearOffer;
    const offer = sql(`SELECT * FROM offers WHERE id = ${id}`)[0];
    const dup = { id: 'cs_offer_dup', object: 'checkout.session', mode: 'subscription', status: 'open', payment_status: 'unpaid', customer: offer.stripe_customer_id,
      metadata: { veyro_offer: String(id) }, expires_at: 0, url: 'x',
      _params: { 'line_items[0][price]': offer.stripe_price_id, 'subscription_data[metadata][veyro_offer]': String(id) } };
    await setState({ offerSessions: { cs_offer_dup: dup } });
    const done = await simPost('/__mock/checkout/complete', { session: 'cs_offer_dup' });
    const before = (await emails()).length;
    expect((await event('checkout.session.completed', done.session)).status).toBe(200);
    expect((await sim()).subscriptions[done.subscription.id].status).toBe('canceled');
    expect(sql(`SELECT subscription_id FROM offers WHERE id = ${id}`)[0].subscription_id).toBe(sub);
    expect((await emails()).slice(before).some((e) => e.subject.startsWith('Dobbelt tilmelding stoppet'))).toBe(true);
  });

  it('udløbne links: tilbud og Checkout-session', async () => {
    const { res } = await createOffer({ name: 'Ida', email: 'ida@frisor.dk', service: 'Booking-side', price: '499' });
    const id = offerIdFrom(res);
    const token = tokenFor(id);
    // Checkout-sessionen udløber hos Stripe → linket laver en ny session med ny engangsnøgle.
    const first = await goToCheckout(token);
    const s1 = first.res.headers.get('location').split('/').pop();
    await fetch(`${stack.mock.url}/v1/checkout/sessions/${s1}/expire`, { method: 'POST', headers: { Authorization: 'Bearer sk_test_mock' } });
    expect((await event('checkout.session.expired', { id: s1, object: 'checkout.session' })).status).toBe(200);
    expect(sql(`SELECT checkout_session_id FROM offers WHERE id = ${id}`)[0].checkout_session_id).toBeNull();
    const second = await goToCheckout(token);
    const s2 = second.res.headers.get('location').split('/').pop();
    expect(s2).not.toBe(s1);
    const keys = (await calls()).filter((c) => c.path === '/v1/checkout/sessions' && c.params['metadata[veyro_offer]'] === String(id)).map((c) => c.idempotencyKey);
    expect(keys).toEqual([`offer-${id}-cs-1`, `offer-${id}-cs-2`]);

    // Tilbuddets gyldighed udløber → ingen betaling, før admin forlænger.
    sql(`UPDATE offers SET valid_until = ${Math.floor(Date.now() / 1000) - 60} WHERE id = ${id}`);
    const view = await new Client(stack.base).get(`/tilbud/${token}`);
    expect(view.html).toContain('Linket til dette tilbud er udløbet');
    const blocked = await goToCheckout(token);
    expect(blocked.res.headers.get('location')).toBe(`/tilbud/${token}`);
    const detail = await admin.get(`/admin/tilbud/${id}`);
    expect(detail.html).toContain('Link udløbet');
    await admin.post(`/admin/tilbud/${id}/forlaeng`, { _csrf: csrfFrom(detail.html) });
    expect((await new Client(stack.base).get(`/tilbud/${token}`)).html).toContain('Godkend og gå til betaling');

    // Tilbagetrækning lukker også den åbne Checkout-session.
    const d2 = await admin.get(`/admin/tilbud/${id}`);
    await admin.post(`/admin/tilbud/${id}/tilbagetraek`, { _csrf: csrfFrom(d2.html) });
    expect((await sim()).offerSessions[s2].status).toBe('expired');
    expect((await new Client(stack.base).get(`/tilbud/${token}`)).html).toContain('trukket tilbage');
  });

  it('asynkron betaling, der fejler, åbner tilbuddet igen', async () => {
    const { res } = await createOffer({ name: 'Ole', email: 'ole@vvs.dk', service: 'Drift', price: '799' });
    const id = offerIdFrom(res);
    const go = await goToCheckout(tokenFor(id));
    const done = await simPost('/__mock/checkout/complete', { session: go.res.headers.get('location').split('/').pop(), paymentStatus: 'unpaid' });
    await event('checkout.session.completed', done.session);
    expect(sql(`SELECT status FROM offers WHERE id = ${id}`)[0].status).toBe('processing');
    await event('checkout.session.async_payment_failed', done.session);
    expect(sql(`SELECT status, subscription_id FROM offers WHERE id = ${id}`)[0]).toEqual({ status: 'open', subscription_id: null });
  });

  it('kunder og anonyme kan ikke bruge admin-handlingerne', async () => {
    const page = await S.customer.get('/konto');
    const r1 = await S.customer.post(`/admin/kunder/${S.customerId}/abonnement/${S.sub}/pris`, { _csrf: csrfFrom(page.html), price: '1', effective: 'next' });
    expect(r1.status).toBe(403);
    const r2 = await S.customer.post(`/admin/tilbud/${S.offerId}/send`, { _csrf: csrfFrom(page.html) });
    expect(r2.status).toBe(403);
  });
});
