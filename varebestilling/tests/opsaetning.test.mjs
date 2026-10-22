// Kunde oprettet i Veyros admin: bestillingsregler og startkatalog fra "Deploy kunder" (scripts/deploy-kunder.mjs),
// og at samme bestilling sendt flere gange kun giver én ordre og ét lagertræk.
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bygButikSql, validerKunde } from '../../scripts/deploy-kunder.mjs';
import { Client, csrfFrom, login, startStack } from './harness.mjs';

let stack;
let tmp;

// Syntetisk kunde i samme form, som kunde.veyro.dk/api/provisionering leverer den
const kunde = validerKunde(
  'admin:testbageriet',
  'testbageriet',
  {
    kilde: 'admin',
    projekt: 'p_testbageri',
    slug: 'testbageriet',
    navn: 'Testbageriet (syntetisk)',
    adresse: 'testbageriet',
    systemer: { varebestilling: { admins: ['lager@butik.dk'] } },
    udseende: { farve: '#8a3b12' },
    butik: { pickup_enabled: true, delivery_enabled: false, delivery_fee: 0, auto_confirm: false, notify_email: 'ordre@testbageriet.example' },
    startkatalog: [
      { sku: 'BRD-1', name: 'Rugbrød', category: 'Brød', price: 3500, stock: 5, unit: 'stk.', track_stock: true, low_stock_threshold: 2 },
      { sku: 'KAG-1', name: 'Kanelsnegl', category: 'Kager', price: 1800, stock: 20, unit: 'stk.' },
      { sku: 'SRV-1', name: 'Bestilling af lagkage', category: 'Bestilling', price: 25000, track_stock: false },
    ],
  },
  { kundeDomaene: 'veyro.dk', fraAdmin: true },
);

const sqlFil = () => {
  const f = path.join(tmp, `butik-${Date.now()}.sql`);
  writeFileSync(f, bygButikSql(kunde));
  return f;
};
const product = (sku) => stack.sql(`SELECT * FROM products WHERE sku = '${sku}'`)[0];

beforeAll(async () => {
  tmp = mkdtempSync(path.join(os.tmpdir(), 'vb-opsaetning-'));
  stack = await startStack();
}, 180_000);

afterAll(async () => {
  await stack?.stop();
  rmSync(tmp, { recursive: true, force: true });
});

describe('Opsætning fra Veyros admin', () => {
  it('lægger bestillingsregler og startkatalog ind ved første udrulning', () => {
    expect(kunde.systemer[0].domaene).toBe('testbageriet-bestilling.veyro.dk');
    stack.sqlFile(sqlFil());
    expect(stack.sql("SELECT value FROM settings WHERE key = 'shop_name'")[0].value).toBe('Testbageriet (syntetisk)');
    expect(stack.sql("SELECT value FROM settings WHERE key = 'delivery_enabled'")[0].value).toBe('0');
    expect(stack.sql("SELECT value FROM settings WHERE key = 'accent_color'")[0].value).toBe('#8A3B12');
    expect(product('BRD-1')).toMatchObject({ name: 'Rugbrød', price: 3500, stock: 5, low_stock_threshold: 2, track_stock: 1 });
    expect(product('SRV-1').track_stock).toBe(0);
    const mv = stack.sql(`SELECT change, reason FROM stock_movements WHERE product_id = ${product('BRD-1').id}`);
    expect(mv).toEqual([{ change: 5, reason: 'Startlager fra opsætningen' }]);
  });

  it('overskriver aldrig det, kunden selv har rettet, når der udrulles igen', async () => {
    const admin = await login(stack);
    const res = await admin.submit('/admin/indstillinger', '/admin/indstillinger', { shop_name: 'Bageriet ved Torvet', accent_color: '#8A3B12', pickup_enabled: '1', delivery_fee: '0', free_delivery_from: '0', min_order: '0', low_stock_default: '5' });
    expect(res.status).toBe(303);
    stack.sql(`UPDATE products SET price = 3900 WHERE sku = 'BRD-1'`);
    stack.sqlFile(sqlFil());
    expect(stack.sql("SELECT value FROM settings WHERE key = 'shop_name'")[0].value).toBe('Bageriet ved Torvet');
    expect(product('BRD-1').price).toBe(3900);
    expect(stack.sql("SELECT COUNT(*) AS n FROM products WHERE sku = 'BRD-1'")[0].n).toBe(1);
    expect(stack.sql(`SELECT COUNT(*) AS n FROM stock_movements WHERE product_id = ${product('BRD-1').id}`)[0].n).toBe(1);
  });
});

describe('Samme bestilling sendt flere gange', () => {
  async function checkout(shopper) {
    const page = await shopper.get('/kassen');
    const key = page.html.match(/name="bestilling" value="([^"]+)"/)[1];
    return { key, csrf: csrfFrom(page.html) };
  }
  const fields = { customer_name: 'Test Kunde', customer_email: 'kunde@example.dk', customer_phone: '12 34 56 78', delivery: 'afhentning' };

  it('giver én ordre og reserverer kun lageret én gang', async () => {
    const shopper = new Client(stack.base);
    const id = product('BRD-1').id;
    expect((await shopper.submit('/', '/kurv', { id: String(id), qty: '2', back: '/' })).status).toBe(303);
    const { key, csrf } = await checkout(shopper);
    const before = stack.sql('SELECT COUNT(*) AS n FROM orders')[0].n;
    // To samtidige forsøg med samme kurv og nøgle (dobbeltklik / genforsøg efter timeout)
    const cookies = shopper.cookieHeader();
    const send = () =>
      fetch(`${stack.base}/kassen`, {
        method: 'POST',
        redirect: 'manual',
        headers: { Cookie: cookies, 'Content-Type': 'application/x-www-form-urlencoded', Origin: stack.base, 'CF-Connecting-IP': shopper.ip },
        body: new URLSearchParams({ _csrf: csrf, bestilling: key, ...fields }).toString(),
      });
    const [a, b] = await Promise.all([send(), send()]);
    expect(a.status).toBe(303);
    expect(b.status).toBe(303);
    expect(a.headers.get('location')).toBe(b.headers.get('location'));
    // Og igen bagefter (tilbage-knappen + send)
    const c = await send();
    expect(c.headers.get('location')).toBe(a.headers.get('location'));
    expect(stack.sql('SELECT COUNT(*) AS n FROM orders')[0].n).toBe(before + 1);
    const order = stack.sql(`SELECT * FROM orders WHERE client_key = '${key}'`)[0];
    expect(stack.sql(`SELECT SUM(quantity) AS q FROM order_lines WHERE order_id = ${order.id}`)[0].q).toBe(2);
    expect(product('BRD-1').stock).toBe(5); // reserveret, ikke trukket
  });

  it('trækker kun lageret én gang med automatisk bekræftelse', async () => {
    stack.sql("INSERT INTO settings (key, value) VALUES ('auto_confirm', '1') ON CONFLICT(key) DO UPDATE SET value = '1'");
    const shopper = new Client(stack.base);
    const id = product('KAG-1').id;
    await shopper.submit('/', '/kurv', { id: String(id), qty: '3', back: '/' });
    const { key, csrf } = await checkout(shopper);
    const cookies = shopper.cookieHeader();
    const send = () =>
      fetch(`${stack.base}/kassen`, {
        method: 'POST',
        redirect: 'manual',
        headers: { Cookie: cookies, 'Content-Type': 'application/x-www-form-urlencoded', Origin: stack.base, 'CF-Connecting-IP': shopper.ip },
        body: new URLSearchParams({ _csrf: csrf, bestilling: key, ...fields }).toString(),
      });
    const results = await Promise.all([send(), send(), send()]);
    expect(new Set(results.map((r) => r.headers.get('location'))).size).toBe(1);
    expect(product('KAG-1').stock).toBe(17);
    const order = stack.sql(`SELECT * FROM orders WHERE client_key = '${key}'`)[0];
    expect(order.status).toBe('bekraeftet');
    expect(stack.sql(`SELECT COUNT(*) AS n FROM stock_movements WHERE order_id = ${order.id}`)[0].n).toBe(1);
  });
});
