import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ADMIN_EMAIL, Client, csrfFrom, importCsv, login, placeOrder, startStack, waitFor } from './harness.mjs';

let stack;
let admin;
const ids = {};
const product = (sku) => stack.sql(`SELECT * FROM products WHERE sku = '${sku}'`)[0];
const orderByNumber = (n) => stack.sql(`SELECT * FROM orders WHERE number = ${n}`)[0];
const orderIdFrom = (res) => {
  const token = res.headers.get('location').match(/\/ordre\/([A-Za-z0-9_-]+)/)[1];
  return stack.sql(`SELECT * FROM orders WHERE token = '${token}'`)[0];
};
const setStatus = (id, status) => admin.submit(`/admin/ordrer/${id}`, `/admin/ordrer/${id}/status`, { status });

const SETTINGS = {
  shop_name: 'Testbutikken',
  tagline: 'Bestil dine varer',
  intro: '',
  accent_color: '#0E7C66',
  website_url: '',
  contact_email: 'butik@example.dk',
  contact_phone: '11 22 33 44',
  address: 'Testvej 1, 8000 Aarhus C',
  notify_email: '',
  pickup_enabled: '1',
  pickup_info: '',
  delivery_enabled: '1',
  delivery_info: '',
  delivery_fee: '49',
  free_delivery_from: '500',
  min_order: '0',
  low_stock_default: '5',
  terms_url: '',
  privacy_url: '',
};

beforeAll(async () => {
  stack = await startStack();
  admin = await login(stack);
  const res = await admin.submit('/admin/indstillinger', '/admin/indstillinger', SETTINGS);
  expect(res.status).toBe(303);
  const csv = [
    'Varenummer;Navn;Kategori;Pris;Lager;Enhed;Minimum;Lagerstyring',
    'KAF-1;Kaffebønner 1 kg;Kaffe;149,95;10;pose;3;ja',
    'KAF-2;Espresso 500 g;Kaffe;89;2;pose;;ja',
    'TE-1;Grøn te;Te;45;0;æske;;ja',
    'SRV-1;Kaffemaskine-service;Service;599;;stk.;;nej',
  ].join('\n');
  const { res: done } = await importCsv(admin, csv);
  expect(done.html).toContain('4 nye og 0 opdaterede');
  for (const sku of ['KAF-1', 'KAF-2', 'TE-1', 'SRV-1']) ids[sku] = product(sku).id;
}, 180_000);

afterAll(async () => {
  await stack?.stop();
});

describe('Adgang til admin', () => {
  it('kræver login og sender kun link til medarbejdere', async () => {
    const anon = new Client(stack.base);
    const r = await anon.get('/admin/ordrer');
    expect(r.status).toBe(303);
    expect(r.headers.get('location')).toBe('/admin/login?next=%2Fadmin%2Fordrer');
    const before = stack.mail.emails.length;
    const sent = await anon.submit('/admin/login', '/admin/login', { email: 'fremmed@example.dk' });
    expect(sent.status).toBe(200);
    expect(sent.html).toContain('Tjek din indbakke');
    await new Promise((r) => setTimeout(r, 300));
    expect(stack.mail.emails.length).toBe(before);
  });

  it('afviser POST uden gyldigt CSRF-token eller fra fremmed domæne', async () => {
    const r1 = await admin.post('/admin/varer/1/slet', { _csrf: 'forkert' });
    expect(r1.status).toBe(403);
    const page = await admin.get('/admin/varer');
    const r2 = await admin.post('/admin/varer/1/slet', { _csrf: csrfFrom(page.html) }, { Origin: 'https://ond.example' });
    expect(r2.status).toBe(403);
    expect(product('KAF-1')).toBeTruthy();
  });

  it('logget ind kan se oversigt, varer og indstillinger', async () => {
    const dash = await admin.get('/admin');
    expect(dash.status).toBe(200);
    expect(dash.html).toContain('Lavt lager');
    expect(dash.html).toContain('Espresso 500 g'); // 2 på lager <= standard 5
    const varer = await admin.get('/admin/varer?lav=1');
    expect(varer.html).toContain('Espresso 500 g');
    expect(varer.html).not.toContain('Kaffemaskine-service');
  });
});

describe('Webshop', () => {
  it('viser aktive varer med butikkens navn, farve og lagerstatus', async () => {
    const r = await new Client(stack.base).get('/');
    expect(r.status).toBe(200);
    expect(r.html).toContain('Testbutikken');
    expect(r.html).toContain('--accent:#0E7C66');
    expect(r.html).toContain('Kaffebønner 1 kg');
    expect(r.html).toContain('149,95 kr.');
    expect(r.html).toMatch(/Grøn te[\s\S]*Udsolgt/);
    expect(r.html).not.toContain('Veyro');
  });

  it('kan ikke lægge flere i kurven end der er på lager', async () => {
    const c = new Client(stack.base);
    await c.submit('/', '/kurv', { id: String(ids['KAF-2']), qty: '50', back: '/' });
    const cart = await c.get('/kurv');
    expect(cart.html).toMatch(/name="q_\d+" value="2"/);
    const sold = await c.submit('/', '/kurv', { id: String(ids['TE-1']), qty: '1', back: '/' });
    expect(sold.status).toBe(303);
    expect((await c.get('/kurv')).html).not.toContain('Grøn te');
  });

  it('bestillingsarket lægger alle antal i kurven på én gang og holder sig til lageret', async () => {
    const c = new Client(stack.base);
    const sheet = await c.get('/');
    expect(sheet.html).toContain(`name="q_${ids['KAF-1']}"`);
    expect(sheet.html).toContain('Gå til bestilling');
    expect(sheet.html).not.toContain(`name="q_${ids['TE-1']}"`); // udsolgt

    const many = await c.submit('/', '/bestil', { [`q_${ids['KAF-1']}`]: '3', [`q_${ids['KAF-2']}`]: '50', [`q_${ids['TE-1']}`]: '4', back: '/' });
    expect(many.status).toBe(303);
    expect(many.headers.get('location')).toBe('/kurv?besked=justeret');
    let cart = await c.get(many.headers.get('location'));
    expect(cart.html).toContain('sat ned');
    expect(cart.html).toContain(`name="q_${ids['KAF-1']}" value="3"`);
    expect(cart.html).toContain(`name="q_${ids['KAF-2']}" value="2"`);
    expect(cart.html).not.toContain('Grøn te');

    // Arket viser kurvens antal, og et tomt felt fjerner varen
    expect((await c.get('/')).html).toContain(`name="q_${ids['KAF-1']}" value="3"`);
    const fewer = await c.submit('/', '/bestil', { [`q_${ids['KAF-1']}`]: '1', [`q_${ids['KAF-2']}`]: '', back: '/' });
    expect(fewer.headers.get('location')).toBe('/kassen');
    cart = await c.get('/kurv');
    expect(cart.html).toContain(`name="q_${ids['KAF-1']}" value="1"`);
    expect(cart.html).not.toContain('Espresso 500 g');

    const none = await c.submit('/', '/bestil', { [`q_${ids['KAF-1']}`]: '0', back: '/' });
    expect(none.headers.get('location')).toBe('/?fejl=tom');
    expect((await c.get('/?fejl=tom')).html).toContain('Skriv et antal ud for mindst én vare.');
  });

  it('validerer kassen', async () => {
    const c = new Client(stack.base);
    await c.submit('/', '/kurv', { id: String(ids['KAF-1']), qty: '1', back: '/' });
    const r = await c.submit('/kassen', '/kassen', { customer_name: '', customer_email: 'ikke-en-mail', customer_phone: '1', delivery: 'levering' });
    expect(r.status).toBe(400);
    expect(r.html).toContain('Skriv dit navn.');
    expect(r.html).toContain('Indtast en gyldig e-mailadresse.');
    expect(r.html).toContain('Skriv leveringsadressen.');
  });

  it('opretter en ny ordre, reserverer varerne og sender kvittering og besked til butikken', async () => {
    const before = stack.mail.emails.length;
    const { shopper, res } = await placeOrder(stack, [[ids['KAF-1'], 2], [ids['SRV-1'], 1]], {
      delivery: 'levering', address: 'Kundevej 2', postcode: '8000', city: 'Aarhus C', note: 'Ring på',
    });
    expect(res.status).toBe(303);
    const order = orderIdFrom(res);
    expect(order.status).toBe('ny');
    expect(order.number).toBe(1001);
    expect(order.subtotal).toBe(2 * 14995 + 59900);
    expect(order.delivery_fee).toBe(0); // gratis levering over 500 kr.
    expect(order.stock_deducted).toBe(0);
    expect(product('KAF-1').stock).toBe(10); // lager trækkes først ved bekræftelse

    const receipt = await shopper.get(res.headers.get('location'));
    expect(receipt.html).toContain('Tak for din bestilling');
    expect(receipt.html).toContain('#1001');
    expect((await shopper.get('/kurv')).html).toContain('Kurven er tom');

    const mails = await waitFor(() => {
      const m = stack.mail.emails.slice(before);
      return m.length >= 2 ? m : null;
    });
    expect(mails.find((m) => m.to[0] === 'mette@example.dk').subject).toContain('#1001');
    expect(mails.find((m) => m.to[0] === 'butik@example.dk').subject).toContain('Ny bestilling #1001');
    expect(mails[0].from).toBe('Testbutik <ordre@butik.dk>');

    // Reserveret i adminlisten
    const list = await admin.get('/admin/varer?q=KAF-1');
    expect(list.html).toMatch(/data-label="Reserveret" class="right num">2</);
    ids.order1 = order.id;
  });

  it('nye ordrer reserverer varer, så næste kunde ikke kan oversælge', async () => {
    const { res: first } = await placeOrder(stack, [[ids['KAF-2'], 2]]);
    expect(first.status).toBe(303);
    ids.order2 = orderIdFrom(first).id;
    // Varen er reserveret i den nye ordre og kan derfor ikke lægges i kurven af en anden kunde
    const other = new Client(stack.base);
    const shop = await other.get('/');
    expect(shop.html).toMatch(/Espresso 500 g[\s\S]*?Udsolgt/);
    await other.submit('/', '/kurv', { id: String(ids['KAF-2']), qty: '1', back: '/' });
    expect((await other.get('/kurv')).html).toContain('Kurven er tom');
    expect((await other.get('/kassen')).headers.get('location')).toBe('/kurv');
  });

  it('kvitteringssiden kræver det hemmelige link', async () => {
    const r = await new Client(stack.base).get('/ordre/' + 'x'.repeat(32));
    expect(r.status).toBe(404);
  });
});

describe('Ordrestatus og lager', () => {
  it('bekræftelse trækker lageret præcis én gang og logger historik', async () => {
    const r = await setStatus(ids.order1, 'bekraeftet');
    expect(r.status).toBe(303);
    expect(product('KAF-1').stock).toBe(8);
    expect(product('SRV-1').stock).toBe(0); // ingen lagerstyring
    await setStatus(ids.order1, 'klar');
    await setStatus(ids.order1, 'bekraeftet');
    await setStatus(ids.order1, 'klar');
    expect(product('KAF-1').stock).toBe(8);
    const moves = stack.sql(`SELECT * FROM stock_movements WHERE order_id = ${ids.order1}`);
    expect(moves).toHaveLength(1);
    expect(moves[0]).toMatchObject({ change: -2, stock_after: 8, reason: 'Ordre #1001', actor: ADMIN_EMAIL });
    const page = await admin.get(`/admin/ordrer/${ids.order1}`);
    expect(page.html).toContain('Lager er trukket');
    expect(page.html).toContain('Status ændret til klar / afsendt');
  });

  it('afsluttede ordrer er låst', async () => {
    await setStatus(ids.order1, 'afsluttet');
    const r = await setStatus(ids.order1, 'annulleret');
    expect(r.status).toBe(409);
    expect(orderByNumber(1001).status).toBe('afsluttet');
    expect(product('KAF-1').stock).toBe(8);
  });

  it('afviser bekræftelse uden nok på lager – intet trækkes', async () => {
    // Nogen har talt lageret op og fundet kun 1 espresso, men ordre 2 har bestilt 2
    const adj = await admin.submit(`/admin/varer/${ids['KAF-2']}`, `/admin/varer/${ids['KAF-2']}/lager`, { mode: 'set', value: '1', reason: 'Optælling' });
    expect(adj.status).toBe(303);
    const r = await setStatus(ids.order2, 'bekraeftet');
    expect(r.status).toBe(409);
    expect(r.html).toContain('ikke er nok på lager');
    expect(r.html).toContain('bestilt 2, på lager 1');
    const o = stack.sql(`SELECT * FROM orders WHERE id = ${ids.order2}`)[0];
    expect(o).toMatchObject({ status: 'ny', stock_deducted: 0 });
    expect(product('KAF-2').stock).toBe(1);
    expect(stack.sql(`SELECT COUNT(*) AS n FROM order_events WHERE order_id = ${ids.order2}`)[0].n).toBe(1);
  });

  it('annullering af en bekræftet ordre lægger varerne tilbage', async () => {
    await admin.submit(`/admin/varer/${ids['KAF-2']}`, `/admin/varer/${ids['KAF-2']}/lager`, { mode: 'add', value: '4', reason: 'Varemodtagelse' });
    expect(product('KAF-2').stock).toBe(5);
    expect((await setStatus(ids.order2, 'bekraeftet')).status).toBe(303);
    expect(product('KAF-2').stock).toBe(3);
    expect((await setStatus(ids.order2, 'annulleret')).status).toBe(303);
    expect(product('KAF-2').stock).toBe(5);
    // Genåbnet og annulleret igen uden bekræftelse: ingen ændring
    await setStatus(ids.order2, 'ny');
    await setStatus(ids.order2, 'annulleret');
    expect(product('KAF-2').stock).toBe(5);
    const reasons = stack.sql(`SELECT reason, change FROM stock_movements WHERE order_id = ${ids.order2} ORDER BY id`);
    expect(reasons).toEqual([
      { reason: 'Ordre #1002', change: -2 },
      { reason: 'Ordre #1002 annulleret', change: 2 },
    ]);
  });

  it('manuel regulering kan ikke gøre lageret negativt', async () => {
    const r = await admin.submit(`/admin/varer/${ids['KAF-2']}`, `/admin/varer/${ids['KAF-2']}/lager`, { mode: 'add', value: '-99', reason: 'Svind' });
    expect(r.status).toBe(409);
    expect(r.html).toContain('Lageret kan ikke blive negativt');
    expect(product('KAF-2').stock).toBe(5);
  });

  it('sender advarsel, når en ordre får lageret under minimum', async () => {
    const before = stack.mail.emails.length;
    const { res } = await placeOrder(stack, [[ids['KAF-1'], 5]]); // 8 -> 3, minimum 3
    const o = orderIdFrom(res);
    await setStatus(o.id, 'bekraeftet');
    expect(product('KAF-1').stock).toBe(3);
    const warn = await waitFor(() => stack.mail.emails.slice(before).find((m) => m.subject.startsWith('Lavt lager')));
    expect(warn.text).toContain('Kaffebønner 1 kg (KAF-1): 3 tilbage');
    const confirmed = stack.mail.emails.slice(before).find((m) => m.to[0] === 'mette@example.dk' && m.subject.includes('bekræftet'));
    expect(confirmed).toBeTruthy();
  });
});

describe('Automatisk bekræftelse', () => {
  it('trækker lageret med det samme og afviser, hvis varen bliver udsolgt imens', async () => {
    await admin.submit('/admin/indstillinger', '/admin/indstillinger', { ...SETTINGS, auto_confirm: '1' });
    // Kurven fyldes, mens der er 3 på lager …
    const shopper = new Client(stack.base);
    await shopper.submit('/', '/kurv', { id: String(ids['KAF-1']), qty: '3', back: '/' });
    // … og en anden kunde køber 2 imens
    const { res } = await placeOrder(stack, [[ids['KAF-1'], 2]]);
    const o = orderIdFrom(res);
    expect(o).toMatchObject({ status: 'bekraeftet', stock_deducted: 1 });
    expect(product('KAF-1').stock).toBe(1);
    const late = await shopper.submit('/kassen', '/kassen', { customer_name: 'Sen Kunde', customer_email: 'sen@example.dk', customer_phone: '87654321', delivery: 'afhentning' });
    expect(late.status).toBe(409);
    expect(late.html).toContain('udsolgt, mens du handlede');
    expect(product('KAF-1').stock).toBe(1);
    await admin.submit('/admin/indstillinger', '/admin/indstillinger', SETTINGS);
  });
});

describe('Import opdaterer eksisterende varer', () => {
  it('ændrer kun kolonnerne i filen og logger lagerændringer', async () => {
    const { preview, res } = await importCsv(admin, 'SKU;Pris;Lager\nKAF-2;99,00;20\nNY-1;10;\n');
    expect(preview.html).toContain('Ny vare &quot;NY-1&quot; mangler navn');
    expect(res.html).toContain('0 nye og 1 opdaterede');
    const p = product('KAF-2');
    expect(p).toMatchObject({ price: 9900, stock: 20, name: 'Espresso 500 g', category: 'Kaffe', unit: 'pose' });
    const m = stack.sql(`SELECT * FROM stock_movements WHERE product_id = ${p.id} ORDER BY id DESC LIMIT 1`)[0];
    expect(m).toMatchObject({ change: 15, stock_after: 20, reason: 'Import' });
    const hist = await admin.get('/admin/historik');
    expect(hist.html).toContain('Import');
  });

  it('eksporterer varer som CSV', async () => {
    const r = await admin.get('/admin/varer/eksport.csv');
    expect(r.headers.get('content-type')).toContain('text/csv');
    expect(r.html).toContain('KAF-2;Espresso 500 g;Kaffe;99;20;pose');
  });

  it('opretter og redigerer varer manuelt', async () => {
    const r = await admin.submit('/admin/varer/ny', '/admin/varer', {
      sku: 'MAN-1', name: 'Manuel vare', category: 'Diverse', price: '12,50', unit: 'stk.', stock: '7', track_stock: '1', active: '1', sort_order: '0', low_stock_threshold: '',
    });
    expect(r.status).toBe(303);
    expect(product('MAN-1')).toMatchObject({ price: 1250, stock: 7 });
    const dup = await admin.submit('/admin/varer/ny', '/admin/varer', { sku: 'man-1', name: 'Dublet', price: '1', stock: '0', sort_order: '0' });
    expect(dup.status).toBe(409);
    expect(dup.html).toContain('Varenummeret findes allerede');
  });
});
