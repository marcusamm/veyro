// Kassen (POS) i admin: adgang og roller, ydelser og varer, salg med kontant, kort og delt betaling,
// rabat med godkendelse, lager og oversalg, Stripe Terminal, annullering, refusion, kvittering og rapporter.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ADMIN_EMAIL, Client, csrfFrom, login, seedCustomer, startStack } from './harness.mjs';

let stack;
const sessions = new Map();
async function as(email) {
  if (!sessions.has(email)) {
    const s = await login(stack, email);
    const page = await s.client.get('/admin/kasse/salg');
    s.csrf = csrfFrom(page.html);
    sessions.set(email, s);
  }
  return sessions.get(email);
}

const CASHIER = 'kasse@veyro.dk';
const MANAGER = 'leder@veyro.dk';
const CASHIER2 = 'kasse2@veyro.dk';
const items = {};
let n = 0;
const newKey = () => `testkey${Date.now().toString(36)}${(n++).toString().padStart(6, '0')}`;

async function api(email, path, form) {
  const s = await as(email);
  const res = form ? await s.client.post(path, { _csrf: s.csrf, ...form }) : await s.client.get(path);
  let body;
  try {
    body = JSON.parse(res.html);
  } catch {
    body = { raw: res.html };
  }
  return { status: res.status, body };
}

function sale(email, { lines, payments, discount = null, customer = {}, note = '', total, key = newKey(), approver } = {}) {
  return api(email, '/admin/kasse/api/salg', {
    key,
    lines: JSON.stringify(lines),
    payments: JSON.stringify(payments),
    order_discount: JSON.stringify(discount),
    customer: JSON.stringify(customer),
    note,
    expected_total: String(total),
    ...(approver ? { approver_email: approver.email, approver_pin: approver.pin } : {}),
  });
}

async function createItem(fields) {
  const s = await as(ADMIN_EMAIL);
  const res = await s.client.post('/admin/kasse/varer', { _csrf: s.csrf, active: '1', ...fields });
  expect(res.status, res.html.slice(0, 500)).toBe(303);
  return Number(res.headers.get('location').match(/\/varer\/(\d+)/)[1]);
}

async function itemStock(id) {
  const { body } = await api(ADMIN_EMAIL, '/admin/kasse/api/varer');
  return body.products.find((p) => p.id === id)?.available;
}

const terminal = async () => (await fetch(stack.mock.url + '/__mock/terminal')).json();
const setTerminal = (t) => fetch(stack.mock.url + '/__mock/terminal', { method: 'POST', body: JSON.stringify(t) });
const emails = async () => (await fetch(stack.mock.url + '/__mock/emails')).json();

beforeAll(async () => {
  stack = await startStack();
  await seedCustomer(stack, { email: 'kunde@example.dk', name: 'Karin Kunde', cus: 'cus_K', sub: 'sub_K', price: 'price_business_test' });
});

afterAll(async () => {
  await stack?.stop();
});

describe('Adgang', () => {
  it('kræver login og sender til admin-login', async () => {
    const c = new Client(stack.base);
    const res = await c.get('/admin/kasse');
    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toBe('/admin/login');
    const api = await c.get('/admin/kasse/api/varer');
    expect(api.status).toBe(401);
  });

  it('afviser en kunde uden rolle i kassen', async () => {
    const { client } = await login(stack, 'kunde@example.dk');
    const res = await client.get('/admin/kasse');
    expect(res.status).toBe(403);
    const api = await client.get('/admin/kasse/api/varer');
    expect(api.status).toBe(403);
  });

  it('viser Kasse i admin-menuen og en tom kasse', async () => {
    const { client } = await as(ADMIN_EMAIL);
    const res = await client.get('/admin/kasse');
    expect(res.status).toBe(200);
    expect(res.html).toContain('href="/admin/kasse" aria-current="page">Kasse</a>');
    expect(res.html).toContain('data-pos');
    expect(res.html).toContain('/static/kasse.js');
    const css = await client.get('/static/kasse.css');
    expect(css.headers.get('content-type')).toContain('text/css');
  });
});

describe('Personale og roller', () => {
  it('administrator opretter medarbejdere og PIN-koder', async () => {
    const s = await as(ADMIN_EMAIL);
    for (const [email, role, name] of [[CASHIER, 'cashier', 'Kim Kasse'], [MANAGER, 'manager', 'Lene Leder'], [CASHIER2, 'cashier', 'Kurt']]) {
      const r = await s.client.post('/admin/kasse/personale', { _csrf: s.csrf, email, name, role, active: '1', new: '1' });
      expect(r.status).toBe(303);
    }
    expect((await s.client.post('/admin/kasse/personale/pin', { _csrf: s.csrf, email: MANAGER, pin: '1234' })).status).toBe(303);
    expect((await s.client.post('/admin/kasse/personale/pin', { _csrf: s.csrf, email: CASHIER, pin: '9999' })).status).toBe(303);
    const bad = await s.client.post('/admin/kasse/personale/pin', { _csrf: s.csrf, email: MANAGER, pin: '12' });
    expect(bad.status).toBe(400);
    const page = await s.client.get('/admin/kasse/personale');
    expect(page.html).toContain('Lene Leder');
    expect(page.html).toContain('Leder');
  });

  it('en kasseassistent logger ind til kassen, men ikke resten af admin', async () => {
    const s = await login(stack, CASHIER);
    expect(s.redirect).toBe('/admin/kasse');
    const kasse = await s.client.get('/admin/kasse');
    expect(kasse.status).toBe(200);
    // Kun kassens menupunkt
    expect(kasse.html).not.toContain('href="/admin/kunder"');
    const adm = await s.client.get('/admin/kunder');
    expect(adm.status).toBe(303);
    expect(adm.headers.get('location')).toBe('/admin/kasse');
    for (const p of ['/admin/kasse/indstillinger', '/admin/kasse/personale', '/admin/kasse/rapporter', '/admin/kasse/varer']) {
      expect((await s.client.get(p)).status, p).toBe(403);
    }
    const csrf = csrfFrom((await s.client.get('/admin/kasse/salg')).html);
    const post = await s.client.post('/admin/kasse/indstillinger', { _csrf: csrf, cash_enabled: '1' });
    expect(post.status).toBe(403);
  });

  it('admin-login sender også link til medarbejdere i kassen', async () => {
    const c = new Client(stack.base);
    const page = await c.get('/admin/login');
    const before = (await emails()).length;
    await c.post('/admin/login', { _csrf: csrfFrom(page.html), email: MANAGER });
    const deadline = Date.now() + 5000;
    let mail;
    while (!mail && Date.now() < deadline) {
      mail = (await emails()).slice(before).find((e) => e.to[0] === MANAGER);
      if (!mail) await new Promise((r) => setTimeout(r, 100));
    }
    expect(mail).toBeTruthy();
  });
});

describe('Ydelser og varer', () => {
  it('opretter ydelser og en vare med lager', async () => {
    items.web = await createItem({ name: 'Hjemmeside – opsætning', price: '4.995', category: 'Hjemmesider', unit: 'stk.', sku: 'WEB-SETUP' });
    items.hour = await createItem({ name: 'Konsulenttime', price: '895', category: 'Timer', unit: 'time', sku: 'TIME' });
    items.usb = await createItem({ name: 'USB-nøgle med backup', price: '99,50', category: 'Varer', sku: 'USB-1', barcode: '5701234567890', track_stock: '1', stock: '5' });
    const { body } = await api(ADMIN_EMAIL, '/admin/kasse/api/varer');
    const web = body.products.find((p) => p.id === items.web);
    expect(web).toMatchObject({ name: 'Hjemmeside – opsætning', price: 499500, available: null, sku: 'WEB-SETUP' });
    expect(body.products.find((p) => p.id === items.usb)).toMatchObject({ price: 9950, available: 5, barcode: '5701234567890' });
    expect(body.categories).toEqual(expect.arrayContaining(['Hjemmesider', 'Timer', 'Varer']));
  });

  it('validerer på serveren og afviser dublet-varenummer', async () => {
    const s = await as(ADMIN_EMAIL);
    const r1 = await s.client.post('/admin/kasse/varer', { _csrf: s.csrf, name: '', price: 'abc' });
    expect(r1.status).toBe(400);
    expect(r1.html).toContain('Skriv et navn.');
    const r2 = await s.client.post('/admin/kasse/varer', { _csrf: s.csrf, name: 'Dublet', price: '10', sku: 'web-setup' });
    expect(r2.status).toBe(400);
    expect(r2.html).toContain('Varenummeret er allerede brugt.');
  });

  it('lagerregulering logges og kan ikke gøre lageret negativt', async () => {
    const s = await as(ADMIN_EMAIL);
    const neg = await s.client.post(`/admin/kasse/varer/${items.usb}/lager`, { _csrf: s.csrf, mode: 'add', value: '-10', reason: 'Svind' });
    expect(neg.status).toBe(400);
    const ok = await s.client.post(`/admin/kasse/varer/${items.usb}/lager`, { _csrf: s.csrf, mode: 'set', value: '3', reason: 'Optælling' });
    expect(ok.status).toBe(303);
    expect(await itemStock(items.usb)).toBe(3);
    const page = await s.client.get(`/admin/kasse/varer/${items.usb}`);
    expect(page.html).toContain('Optælling');
    expect(page.html).toContain('Startlager');
  });
});

describe('Salg', () => {
  it('kontantsalg: totaler, moms, øreafrunding, byttepenge og lager', async () => {
    // 4.995 + 2 × 99,50 = 5.194,00; kontant 5.200 → 6 kr. retur
    const key = newKey();
    const r = await sale(CASHIER, {
      key,
      lines: [{ id: items.web, qty: 1 }, { id: items.usb, qty: 2 }],
      payments: [{ key: 'kontant', received: 520000 }],
      total: 519400,
      customer: { name: 'Walk-in Hansen', email: 'hansen@example.dk', phone: '12345678', company: '' },
      note: 'Betalt ved skranken',
    });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.sale).toMatchObject({ status: 'betalt', total: 519400, rounding: 0, change: 600, received: 520000 });
    expect(r.body.sale.number).toBeGreaterThan(1000);
    expect(await itemStock(items.usb)).toBe(1);
    items.cashSale = r.body.sale.id;

    // Samme nøgle igen (dobbeltklik / netværksfejl) giver samme salg og intet ekstra lagertræk
    const again = await sale(CASHIER, { key, lines: [{ id: items.web, qty: 1 }, { id: items.usb, qty: 2 }], payments: [{ key: 'kontant', received: 520000 }], total: 519400 });
    expect(again.body.existing).toBe(true);
    expect(again.body.sale.id).toBe(items.cashSale);
    expect(await itemStock(items.usb)).toBe(1);

    const s = await as(ADMIN_EMAIL);
    const page = await s.client.get(`/admin/kasse/salg/${items.cashSale}`);
    expect(page.html).toContain('Walk-in Hansen');
    expect(page.html).toContain('Heraf moms 25 %');
    expect(page.html).toContain('1.038,80 kr.'); // moms af 5.194 kr.
    expect(page.html).toContain('Betalt ved skranken');
  });

  it('runder kontant af til 50 øre', async () => {
    // 99,50 + 895 = 994,50 → kontant 994,50 (ingen afrunding); 99,50 × 1 alene = 99,50
    const r = await sale(CASHIER, { lines: [{ id: items.hour, qty: 1 }], payments: [{ key: 'kontant' }], discount: { type: 'amount', value: 23 }, total: 89477 });
    // 894,77 → 895,00 (+23 øre)
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.sale).toMatchObject({ total: 89477, rounding: 23 });
    expect(r.body.sale.payments[0].amount).toBe(89500);
  });

  it('afviser oversalg, også når to kasser sælger den sidste vare samtidig', async () => {
    const over = await sale(CASHIER, { lines: [{ id: items.usb, qty: 2 }], payments: [{ key: 'kontant' }], total: 19900 });
    expect(over.status).toBe(409);
    expect(over.body.code).toBe('stock');
    expect(over.body.short[0]).toMatchObject({ itemId: items.usb, available: 1 });
    const both = await Promise.all([
      sale(CASHIER, { lines: [{ id: items.usb, qty: 1 }], payments: [{ key: 'kontant' }], total: 9950 }),
      sale(MANAGER, { lines: [{ id: items.usb, qty: 1 }], payments: [{ key: 'kontant' }], total: 9950 }),
    ]);
    expect(both.map((r) => r.status).sort()).toEqual([200, 409]);
    expect(await itemStock(items.usb)).toBe(0);
  });

  it('opdager ændrede priser og ukendte varer', async () => {
    const r = await sale(CASHIER, { lines: [{ id: items.hour, qty: 1 }], payments: [{ key: 'kontant' }], total: 10000 });
    expect(r.status).toBe(409);
    expect(r.body).toMatchObject({ code: 'price_changed', total: 89500 });
    const u = await sale(CASHIER, { lines: [{ id: 999999, qty: 1 }], payments: [{ key: 'kontant' }], total: 100 });
    expect(u.body.code).toBe('unknown_product');
  });

  it('validerer betalinger: for lidt kontant, ukendt betalingsform, ikke dækket', async () => {
    const short = await sale(CASHIER, { lines: [{ id: items.hour, qty: 1 }], payments: [{ key: 'kontant', received: 50000 }], total: 89500 });
    expect(short.body.code).toBe('cash_short');
    const unknown = await sale(CASHIER, { lines: [{ id: items.hour, qty: 1 }], payments: [{ key: 'bitcoin', amount: 89500 }], total: 89500 });
    expect(unknown.body.code).toBe('payment');
    const partial = await sale(CASHIER, { lines: [{ id: items.hour, qty: 1 }], payments: [{ key: 'kort_terminal', amount: 50000 }], total: 89500 });
    expect(partial.body.message).toContain('dækker ikke');
  });

  it('delt betaling: kort på terminal + kontant', async () => {
    const r = await sale(CASHIER, {
      lines: [{ id: items.web, qty: 1 }],
      payments: [{ key: 'kort_terminal', amount: 400000, reference: 'AUTH 123' }, { key: 'kontant', received: 100000 }],
      total: 499500,
    });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.sale.payments.map((p) => [p.label, p.amount])).toEqual([['Kort (terminal)', 400000], ['Kontant', 99500]]);
    expect(r.body.sale.change).toBe(500);
    items.splitSale = r.body.sale.id;
  });

  it('stor rabat kræver godkendelse med en leders PIN-kode', async () => {
    const lines = [{ id: items.web, qty: 1 }];
    const total = 499500 - Math.round(499500 * 0.2);
    const need = await sale(CASHIER, { lines, payments: [{ key: 'kontant' }], discount: { type: 'pct', value: 2000 }, total });
    expect(need.status).toBe(403);
    expect(need.body.code).toBe('approval_required');
    const wrong = await sale(CASHIER, { lines, payments: [{ key: 'kontant' }], discount: { type: 'pct', value: 2000 }, total, approver: { email: MANAGER, pin: '0000' } });
    expect(wrong.body.code).toBe('approval_invalid');
    const cashierApproves = await sale(CASHIER, { lines, payments: [{ key: 'kontant' }], discount: { type: 'pct', value: 2000 }, total, approver: { email: CASHIER, pin: '9999' } });
    expect(cashierApproves.body.code).toBe('approval_invalid'); // kasseassistentens egen grænse er 10 %
    const ok = await sale(CASHIER, { lines, payments: [{ key: 'kontant' }], discount: { type: 'pct', value: 2000 }, total, approver: { email: MANAGER, pin: '1234' } });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    // Lille rabat kræver ingen godkendelse
    const small = await sale(CASHIER, { lines: [{ id: items.hour, qty: 1, discount: { type: 'pct', value: 1000 } }], payments: [{ key: 'kontant' }], total: 80550 });
    expect(small.status, JSON.stringify(small.body)).toBe(200);
    const s = await as(ADMIN_EMAIL);
    const settings = await s.client.get('/admin/kasse/indstillinger');
    expect(settings.html).toContain('Rabat godkendt');
    expect(settings.html).toContain('godkendt af Lene Leder');
  });

  it('kunde kan vælges fra Veyros kundeliste og findes igen fra tidligere salg', async () => {
    const found = await api(CASHIER, '/admin/kasse/api/kunder?q=Karin');
    expect(found.body.customers[0]).toMatchObject({ name: 'Karin Kunde', email: 'kunde@example.dk' });
    const r = await sale(CASHIER, { lines: [{ id: items.hour, qty: 1 }], payments: [{ key: 'kontant' }], total: 89500, customer: { id: found.body.customers[0].id, name: 'Karin Kunde', email: 'kunde@example.dk' } });
    expect(r.status).toBe(200);
    const earlier = await api(CASHIER, '/admin/kasse/api/kunder?q=hansen');
    expect(earlier.body.customers.some((c) => c.name === 'Walk-in Hansen' && c.id === null)).toBe(true);
    const phone = await api(CASHIER, '/admin/kasse/api/kunder?q=345678');
    expect(phone.body.customers.some((c) => c.name === 'Walk-in Hansen')).toBe(true);
  });
});

describe('Kort med Stripe Terminal', () => {
  it('slås til med en kortlæser i indstillingerne', async () => {
    const s = await as(ADMIN_EMAIL);
    const bad = await s.client.post('/admin/kasse/indstillinger', { _csrf: s.csrf, stripe_reader_id: 'reader1', cash_enabled: '1' });
    expect(bad.status).toBe(400);
    const r = await s.client.post('/admin/kasse/indstillinger', {
      _csrf: s.csrf, store_name: 'Veyro', store_email: 'kontakt@veyro.dk', store_website: 'veyro.dk', cvr: '12345678', receipt_footer: 'Tak for handlen',
      receipt_width: '80mm', vat_rate: '25', discount_presets: '5, 10', cashier_max_discount: '10', manager_max_discount: '50',
      cash_enabled: '1', cash_rounding: '1', card_terminal_enabled: '1', card_terminal_label: 'Kort (terminal)', stripe_reader_id: 'tmr_TEST1',
      other_methods: 'MobilePay', show_out_of_stock: '1', scanner_enabled: '1', scanner_auto_add: '1',
    });
    expect(r.status).toBe(303);
    const page = await (await as(CASHIER)).client.get('/admin/kasse');
    expect(page.html).toContain('stripe_terminal');
    expect(page.html).toContain('andet:MobilePay');
  });

  it('salget afventer, til Stripe har godkendt kortet', async () => {
    const r = await sale(CASHIER, { lines: [{ id: items.hour, qty: 2 }], payments: [{ key: 'stripe_terminal', amount: 179000 }], total: 179000 });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.sale.status).toBe('afventer');
    const t = await terminal();
    const pi = Object.values(t.pis).at(-1);
    expect(pi).toMatchObject({ amount: 179000, currency: 'dkk', payment_method_types: ['card_present'], capture_method: 'automatic' });
    expect(t.readers.tmr_TEST1.action.process_payment_intent.payment_intent).toBe(pi.id);

    const waiting = await api(CASHIER, `/admin/kasse/api/salg/${r.body.sale.id}/status`);
    expect(waiting.body.card.state).toBe('venter');

    await setTerminal({ action: 'succeed', pi: pi.id });
    const paid = await api(CASHIER, `/admin/kasse/api/salg/${r.body.sale.id}/status`);
    expect(paid.body.card.state).toBe('betalt');
    expect(paid.body.sale.status).toBe('betalt');
    items.cardSale = r.body.sale.id;
  });

  it('et afvist kort kan prøves igen, og salget kan annulleres (lageret lægges tilbage)', async () => {
    // Læg varer på lager, så annullering kan tjekkes
    const s = await as(ADMIN_EMAIL);
    await s.client.post(`/admin/kasse/varer/${items.usb}/lager`, { _csrf: s.csrf, mode: 'set', value: '4', reason: 'Varemodtagelse' });
    const r = await sale(CASHIER, { lines: [{ id: items.usb, qty: 2 }], payments: [{ key: 'stripe_terminal', amount: 19900 }], total: 19900 });
    expect(r.body.sale.status).toBe('afventer');
    expect(await itemStock(items.usb)).toBe(2); // trukket med det samme, så andre kasser ikke sælger dem
    const pi = Object.values((await terminal()).pis).at(-1);
    await setTerminal({ action: 'decline', pi: pi.id });
    const declined = await api(CASHIER, `/admin/kasse/api/salg/${r.body.sale.id}/status`);
    expect(declined.body.card.state).toBe('fejlet');
    expect(declined.body.card.message).toContain('afvist');
    const cancel = await api(CASHIER, `/admin/kasse/api/salg/${r.body.sale.id}/annuller`, { reason: 'Kunden fortrød' });
    expect(cancel.status, JSON.stringify(cancel.body)).toBe(200);
    expect(cancel.body.sale.status).toBe('annulleret');
    expect(await itemStock(items.usb)).toBe(4);
    expect((await terminal()).pis[pi.id].status).toBe('canceled');
  });

  it('salget afsluttes i stedet, hvis kortet nåede at blive godkendt før annullering', async () => {
    const r = await sale(CASHIER, { lines: [{ id: items.hour, qty: 1 }], payments: [{ key: 'stripe_terminal', amount: 89500 }], total: 89500 });
    const pi = Object.values((await terminal()).pis).at(-1);
    await setTerminal({ action: 'succeed', pi: pi.id });
    const cancel = await api(CASHIER, `/admin/kasse/api/salg/${r.body.sale.id}/annuller`, {});
    expect(cancel.body).toMatchObject({ ok: true, completed: true });
    expect(cancel.body.sale.status).toBe('betalt');
  });
});

describe('Refusion', () => {
  it('kasseassistent skal have godkendelse; delvis refusion lægger varen på lager', async () => {
    const s = await as(CASHIER);
    const page = await s.client.get(`/admin/kasse/salg/${items.cashSale}`);
    expect(page.status).toBe(200);
    const csrf = csrfFrom(page.html);
    const lineId = [...page.html.matchAll(/name="rq_(\d+)"/g)].map((m) => m[1]);
    expect(lineId.length).toBe(2);
    const usbLine = lineId[1];
    const key = 'refundkey' + Date.now().toString(36) + 'abcdef';
    const noApproval = await s.client.post(`/admin/kasse/salg/${items.cashSale}/refunder`, { _csrf: csrf, key, [`rq_${usbLine}`]: '1', restock: '1', reason: 'Defekt' });
    expect(noApproval.status).toBe(403);
    const before = await itemStock(items.usb);
    const ok = await s.client.post(`/admin/kasse/salg/${items.cashSale}/refunder`, {
      _csrf: csrf, key, [`rq_${usbLine}`]: '1', restock: '1', reason: 'Defekt', approver_email: MANAGER, approver_pin: '1234',
    });
    expect(ok.status, ok.html.slice(0, 300)).toBe(303);
    expect(await itemStock(items.usb)).toBe(before + 1);
    const after = await s.client.get(`/admin/kasse/salg/${items.cashSale}`);
    expect(after.html).toContain('Delvist refunderet');
    expect(after.html).toContain('-99,50 kr.');
    // Samme nøgle igen refunderer ikke to gange
    const again = await s.client.post(`/admin/kasse/salg/${items.cashSale}/refunder`, {
      _csrf: csrf, key, [`rq_${usbLine}`]: '1', restock: '1', reason: 'Defekt', approver_email: MANAGER, approver_pin: '1234',
    });
    expect(again.status).toBe(303);
    expect(await itemStock(items.usb)).toBe(before + 1);
  });

  it('kan ikke refundere mere end solgt', async () => {
    const s = await as(MANAGER);
    const page = await s.client.get(`/admin/kasse/salg/${items.cashSale}`);
    const lineId = [...page.html.matchAll(/name="rq_(\d+)"/g)].map((m) => m[1]);
    const r = await s.client.post(`/admin/kasse/salg/${items.cashSale}/refunder`, { _csrf: csrfFrom(page.html), key: 'refundkeyover' + Date.now(), [`rq_${lineId[1]}`]: '5', reason: 'Test' });
    expect(r.status).toBe(400);
    expect(r.html).toContain('Der kan højst refunderes 1');
  });

  it('kortbetaling via Stripe refunderes til kortet', async () => {
    const s = await as(MANAGER);
    const page = await s.client.get(`/admin/kasse/salg/${items.cardSale}`);
    const lineId = page.html.match(/name="rq_(\d+)"/)[1];
    const r = await s.client.post(`/admin/kasse/salg/${items.cardSale}/refunder`, { _csrf: csrfFrom(page.html), key: 'refundkeycard' + Date.now(), [`rq_${lineId}`]: '2', reason: 'Fortrudt' });
    expect(r.status, r.html.slice(0, 300)).toBe(303);
    const re = (await terminal()).refunds.at(-1);
    expect(re).toMatchObject({ amount: 179000, status: 'succeeded' });
    const after = await s.client.get(`/admin/kasse/salg/${items.cardSale}`);
    expect(after.html).toContain('>Refunderet</span>');
  });

  it('en afvist Stripe-refusion registreres ikke som gennemført', async () => {
    const r = await sale(CASHIER, { lines: [{ id: items.hour, qty: 1 }], payments: [{ key: 'stripe_terminal', amount: 89500 }], total: 89500 });
    const pi = Object.values((await terminal()).pis).at(-1);
    await setTerminal({ action: 'succeed', pi: pi.id });
    await api(CASHIER, `/admin/kasse/api/salg/${r.body.sale.id}/status`);
    await setTerminal({ failRefund: true });
    const s = await as(MANAGER);
    const page = await s.client.get(`/admin/kasse/salg/${r.body.sale.id}`);
    const lineId = page.html.match(/name="rq_(\d+)"/)[1];
    const res = await s.client.post(`/admin/kasse/salg/${r.body.sale.id}/refunder`, { _csrf: csrfFrom(page.html), key: 'refundkeyfail' + Date.now(), [`rq_${lineId}`]: '1', reason: 'Test' });
    expect(res.status).toBe(502);
    expect(res.html).toContain('Simuleret afvist refusion');
    await setTerminal({ failRefund: false });
    const after = await s.client.get(`/admin/kasse/salg/${r.body.sale.id}`);
    expect(after.html).toContain('>Betalt</span>');
  });
});

describe('Historik, kvittering og rapporter', () => {
  it('kasseassistenter ser kun egne salg', async () => {
    const other = await login(stack, CASHIER2);
    const own = await other.client.get(`/admin/kasse/salg/${items.cashSale}`);
    expect(own.status).toBe(404);
    const list = await other.client.get('/admin/kasse/salg');
    expect(list.html).toContain('Du ser dine egne salg.');
    expect(list.html).toContain('Ingen kassesalg matcher.');
  });

  it('filtrerer på status, betalingsform og nummer', async () => {
    const { client } = await as(ADMIN_EMAIL);
    const byStatus = await client.get('/admin/kasse/salg?status=annulleret');
    expect((byStatus.html.match(/href="\/admin\/kasse\/salg\/\d+"/g) ?? []).length).toBe(1);
    const byMethod = await client.get('/admin/kasse/salg?betaling=kort_terminal');
    expect(byMethod.html).toContain(`/admin/kasse/salg/${items.splitSale}`);
    expect(byMethod.html).not.toContain(`/admin/kasse/salg/${items.cashSale}"`);
  });

  it('kvitteringen har butik, nummer, linjer, moms og betaling', async () => {
    const { client } = await as(CASHIER);
    const r = await client.get(`/admin/kasse/salg/${items.splitSale}/kvittering?kopi=1`);
    expect(r.status).toBe(200);
    expect(r.html).toContain('<h1>Veyro</h1>');
    expect(r.html).toContain('CVR 12345678');
    expect(r.html).toContain('KOPI');
    expect(r.html).toContain('Hjemmeside – opsætning');
    expect(r.html).toContain('Heraf moms 25 %');
    expect(r.html).toContain('Kort (terminal) (AUTH 123)');
    expect(r.html).toContain('Retur');
  });

  it('sender kvitteringen på e-mail', async () => {
    const before = (await emails()).length;
    const r = await api(CASHIER, `/admin/kasse/api/salg/${items.splitSale}/send`, { email: 'kunde@example.dk' });
    expect(r.body.ok).toBe(true);
    const mail = (await emails()).slice(before).find((e) => e.to[0] === 'kunde@example.dk');
    expect(mail.subject).toMatch(/^Kvittering #\d+ fra Veyro$/);
    expect(mail.text).toContain('Heraf moms 25 %');
  });

  it('rapporten for i dag regner salg, refusioner og betalingsformer', async () => {
    const { client } = await as(MANAGER);
    const r = await client.get('/admin/kasse/rapporter');
    expect(r.status).toBe(200);
    for (const t of ['Nettosalg', 'Gennemsnit pr. salg', 'Pr. betalingsform', 'Pr. medarbejder', 'Mest solgte', 'Kontanter i kassen', 'Kim Kasse', 'Konsulenttime', 'Kort (Stripe)']) {
      expect(r.html, t).toContain(t);
    }
    const week = await client.get('/admin/kasse/rapporter?fra=2026-01-01&til=2026-01-07');
    expect(week.html).toContain('Salg pr. dag');
    expect(week.html).toContain('Ingen salg i perioden.');
  });
});
