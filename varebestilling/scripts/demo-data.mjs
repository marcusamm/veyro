// Demodata til at vise systemet frem: en fiktiv byggevarehandel med 120 dages salgshistorik,
// så sikkerhedslager, genbestillingspunkter og varsler har noget at regne på. Varerne og de
// seneste ordrer svarer til eksemplet på veyro.dk. Alle navne og tal er fiktive.
//
//   node scripts/demo-data.mjs > demo.sql
//   npx wrangler d1 execute <database> --remote --file demo.sql
//
// SLETTER alle varer, ordrer og lagerhistorik i databasen, før demodata indsættes.

import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const DAY = 86400;

// [sku, navn, kategori, enhed, pris i kr., lager nu, salg pr. dag, leveringstid i dage]
export const DEMO_PRODUCTS = [
  ['VN-1001', 'Arbejdshandsker, str. L', 'Værnemidler', 'par', 49, 120, 4.2, 7],
  ['VN-1002', 'Arbejdshandsker, str. XL', 'Værnemidler', 'par', 49, 58, 2.1, 7],
  ['VN-1060', 'Sikkerhedsbriller, klar', 'Værnemidler', 'stk.', 79, 34, 0.8, 10],
  ['VN-1070', 'Høreværn med hovedbøjle', 'Værnemidler', 'stk.', 149, 21, 0.4, 10],
  ['VN-1022', 'Skruer 4×40, 200 stk.', 'Befæstelse', 'pk.', 89, 64, 2.6, 5],
  ['VN-1023', 'Skruer 5×60, 100 stk.', 'Befæstelse', 'pk.', 99, 38, 1.1, 5],
  ['VN-1025', 'Rawplugs 6 mm, 100 stk.', 'Befæstelse', 'pk.', 39, 44, 0.9, 5],
  ['VN-1014', 'Malertape 25 mm', 'Maling', 'rulle', 35, 18, 2.2, 7],
  ['VN-1041', 'Spartelmasse 1 L', 'Maling', 'spand', 129, 7, 0.5, 14],
  ['VN-1030', 'Afdækningsplast 4×5 m', 'Maling', 'stk.', 59, 9, 1.0, 7],
  ['VN-1050', 'Pensel 50 mm', 'Maling', 'stk.', 45, 76, 1.4, 7],
  ['VN-1080', 'Bor-sæt HSS 1–10 mm', 'Værktøj', 'sæt', 199, 15, 0.2, 14],
  ['VN-1090', 'Affaldssække, kraftige, 10 stk.', 'Diverse', 'rulle', 69, 48, 1.2, 5],
];

const CUSTOMERS = [
  ['Mikkel Larsen', 'Larsen Byg ApS', 'mikkel@larsenbyg.example', '20 11 22 33'],
  ['Jonas Holm', 'Holm Tømrer', 'jonas@holmtomrer.example', '30 44 55 66'],
  ['Sara Nielsen', 'Nielsen Malerfirma', 'sara@nielsenmaler.example', '40 12 34 56'],
  ['Anders Berg', '', 'anders.berg@example.dk', '50 98 76 54'],
  ['Katrine Due', 'Due Ejendomsservice', 'katrine@dueservice.example', '60 23 45 67'],
  ['Peter Riis', 'Riis Entreprise A/S', 'peter@riisentreprise.example', '70 70 12 12'],
  ['Line Mortensen', 'LM Rengøring', 'line@lmrengoring.example', '22 33 44 55'],
];

const SOURCES = ['hjemmeside', 'hjemmeside', 'hjemmeside', 'hjemmeside', 'telefon', 'telefon', 'email', 'direkte'];

/** Deterministisk tilfældighed, så demoen ser ens ud hver gang. */
function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function poisson(lambda, rand) {
  const L = Math.exp(-lambda);
  let k = 0;
  let p = 1;
  do {
    k++;
    p *= rand();
  } while (p > L);
  return k - 1;
}

const q = (v) => (v === null ? 'NULL' : typeof v === 'number' ? String(v) : `'${String(v).replace(/'/g, "''")}'`);
const token = (n) => `demo${String(n).padStart(28, '0')}`;

/**
 * @param opts.compact Historikken genereres af databasen selv (få, korte SQL-sætninger, fx til
 *   D1-konsollen); ellers skrives hver ordre ud (samme tal hver gang, bruges til skærmbilleder).
 */
export function demoSql(now = Math.floor(Date.now() / 1000), opts = {}) {
  opts = { settings: true, compact: false, ...opts };
  const rand = rng(20261018);
  const out = [];
  out.push('DELETE FROM stock_movements;', 'DELETE FROM order_events;', 'DELETE FROM order_lines;', 'DELETE FROM orders;', 'DELETE FROM products;');
  if (opts.settings) {
    const settings = {
      shop_name: 'Nordlys Byggevarer',
      tagline: 'Bestil byggevarer og værnemidler',
      intro: 'Bestil inden kl. 14, så pakker vi samme dag.\nAfhentning på lageret i Aarhus eller levering på byggepladsen.',
      contact_email: 'ordre@nordlys.example',
      contact_phone: '86 00 00 00',
      address: 'Industrivej 12, 8200 Aarhus N',
      accent_color: '#FF5A1F',
      delivery_fee: '14900',
      free_delivery_from: '150000',
      low_stock_default: '5',
      lead_time_days: '7',
      service_level: '95',
      forecast_days: '90',
      reorder_warn_days: '7',
    };
    for (const [k, v] of Object.entries(settings)) {
      out.push(`INSERT INTO settings (key, value) VALUES (${q(k)}, ${q(v)}) ON CONFLICT(key) DO UPDATE SET value = excluded.value;`);
    }
  }
  const created = now - 120 * DAY;
  DEMO_PRODUCTS.forEach(([sku, name, cat, unit, price, stock, , lead], i) => {
    out.push(
      `INSERT INTO products (id, sku, name, category, description, unit, price, image_url, track_stock, stock, low_stock_threshold, lead_time_days, active, sort_order, created_at, updated_at)
       VALUES (${i + 1}, ${q(sku)}, ${q(name)}, ${q(cat)}, '', ${q(unit)}, ${price * 100}, '', 1, ${stock}, NULL, ${lead === 7 ? 'NULL' : lead}, 1, ${i}, ${created}, ${created});`,
    );
  });

  // Salgshistorik: afsluttede ordrer de seneste 120 dage (dagens salg er de nye ordrer nedenfor)
  let orderId = 0;
  let number = 1000;
  const orders = [];
  const lines = [];
  if (opts.compact) {
    orderId = 360;
    number = 1360;
  }
  for (let d = opts.compact ? 0 : 120; d >= 1; d--) {
    const weekend = new Date((now - d * DAY) * 1000).getUTCDay() % 6 === 0;
    const n = weekend ? 1 : 3 + Math.floor(rand() * 3);
    const dayOrders = [];
    for (let k = 0; k < n; k++) {
      orderId++;
      number++;
      const t = now - d * DAY + 7 * 3600 + Math.floor(rand() * 9 * 3600);
      const c = CUSTOMERS[Math.floor(rand() * CUSTOMERS.length)];
      dayOrders.push({ id: orderId, number, t, c, source: SOURCES[Math.floor(rand() * SOURCES.length)], lines: [] });
    }
    DEMO_PRODUCTS.forEach(([sku, name, , unit, price, , perDay], i) => {
      const qty = poisson(perDay * (weekend ? 0.3 : 1.25), rand);
      if (!qty) return;
      dayOrders[Math.floor(rand() * dayOrders.length)].lines.push({ pid: i + 1, sku, name, unit, price: price * 100, qty });
    });
    for (const o of dayOrders) {
      if (!o.lines.length) continue;
      orders.push(o);
      for (const l of o.lines) lines.push({ ...l, order: o.id });
    }
  }

  // Dagens ordrer som på hjemmesidens eksempel
  const p = (sku) => DEMO_PRODUCTS.findIndex((x) => x[0] === sku) + 1;
  const line = (sku, qty) => {
    const x = DEMO_PRODUCTS[p(sku) - 1];
    return { pid: p(sku), sku, name: x[1], unit: x[3], price: x[4] * 100, qty };
  };
  const recent = [
    { status: 'annulleret', c: CUSTOMERS[4], source: 'hjemmeside', ago: 6.5, lines: [line('VN-1050', 2), line('VN-1014', 2)] },
    { status: 'afsluttet', c: CUSTOMERS[3], source: 'direkte', ago: 5, lines: [line('VN-1080', 1)] },
    { status: 'bekraeftet', c: CUSTOMERS[2], source: 'email', ago: 3, lines: [line('VN-1050', 1), line('VN-1090', 1)] },
    { status: 'ny', c: CUSTOMERS[1], source: 'telefon', ago: 1.2, lines: [line('VN-1022', 3), line('VN-1001', 2)] },
    { status: 'ny', c: CUSTOMERS[0], source: 'hjemmeside', ago: 0.3, lines: [line('VN-1030', 9), line('VN-1014', 12), line('VN-1041', 2)] },
  ];
  for (const r of recent) {
    orderId++;
    number++;
    const o = { id: orderId, number, t: now - Math.round(r.ago * 3600), c: r.c, source: r.source, status: r.status, lines: r.lines };
    orders.push(o);
    for (const l of o.lines) lines.push({ ...l, order: o.id });
  }

  for (const o of orders) {
    const status = o.status ?? 'afsluttet';
    const subtotal = o.lines.reduce((s, l) => s + l.price * l.qty, 0);
    const deducted = status === 'ny' || status === 'annulleret' ? 0 : 1;
    out.push(
      `INSERT INTO orders (id, number, token, status, stock_deducted, customer_name, customer_email, customer_phone, company, delivery, source, address, postcode, city, note, subtotal, delivery_fee, total, internal_note, created_at, updated_at)
       VALUES (${o.id}, ${o.number}, ${q(token(o.id))}, ${q(status)}, ${deducted}, ${q(o.c[0])}, ${q(o.c[2])}, ${q(o.c[3])}, ${q(o.c[1])}, 'afhentning', ${q(o.source)}, '', '', '', '', ${subtotal}, 0, ${subtotal}, '', ${o.t}, ${o.t});`,
    );
    out.push(`INSERT INTO order_events (order_id, status, message, actor, created_at) VALUES (${o.id}, 'ny', ${q(o.source === 'hjemmeside' ? 'Bestilling modtaget' : 'Oprettet af medarbejder')}, ${q(o.source === 'hjemmeside' ? 'kunde' : 'demo@veyro.dk')}, ${o.t});`);
    if (status !== 'ny') {
      if (status !== 'annulleret') out.push(`INSERT INTO order_events (order_id, status, message, actor, created_at) VALUES (${o.id}, 'bekraeftet', 'Status ændret', 'demo@veyro.dk', ${o.t + 1200});`);
      if (status === 'afsluttet') out.push(`INSERT INTO order_events (order_id, status, message, actor, created_at) VALUES (${o.id}, 'afsluttet', 'Status ændret', 'demo@veyro.dk', ${o.t + 3 * 3600});`);
      if (status === 'annulleret') out.push(`INSERT INTO order_events (order_id, status, message, actor, created_at) VALUES (${o.id}, 'annulleret', 'Status ændret', 'demo@veyro.dk', ${o.t + 1800});`);
    }
  }
  if (opts.compact) out.push(...compactHistory(now));
  // Ordrelinjer i bidder, så hver sætning ikke bliver for lang
  for (let i = 0; i < lines.length; i += 200) {
    const values = lines
      .slice(i, i + 200)
      .map((l) => `(${l.order}, ${l.pid}, ${q(l.sku)}, ${q(l.name)}, ${q(l.unit)}, ${l.price}, ${l.qty}, ${l.price * l.qty})`)
      .join(',\n');
    out.push(`INSERT INTO order_lines (order_id, product_id, sku, name, unit, unit_price, quantity, line_total) VALUES\n${values};`);
  }

  // Lagerhistorik: varemodtagelser og en optælling, så "Seneste ændringer" har indhold
  const mv = (sku, change, after, reason, ago) =>
    out.push(`INSERT INTO stock_movements (product_id, change, stock_after, reason, order_id, actor, created_at) VALUES (${p(sku)}, ${change}, ${after}, ${q(reason)}, NULL, 'demo@veyro.dk', ${now - Math.round(ago * 3600)});`);
  DEMO_PRODUCTS.forEach(([sku, , , , , stock]) => mv(sku, stock, stock, 'Optælling', 30 * 24));
  mv('VN-1022', 50, 64, 'Varemodtagelse', 2);
  mv('VN-1014', -2, 18, 'Optælling (svind)', 4);
  mv('VN-1001', 60, 120, 'Varemodtagelse', 26);
  // Tallene beregnes forfra ved næste visning
  out.push('UPDATE products SET forecast_at = NULL, reorder_alerted = 0;');
  return out.join('\n');
}

/** 120 dage × 3 afsluttede ordrer med spredt (men fast) antal omkring hver vares salg pr. dag. */
function compactHistory(now) {
  // VALUES i stedet for UNION ALL: D1 tillader kun få led i en sammensat SELECT
  const rates = DEMO_PRODUCTS.map(([sku, , , , , , perDay]) => `(${q(sku)}, ${perDay})`).join(', ');
  const customers = CUSTOMERS.map((c, i) => `(${i}, ${q(c[0])}, ${q(c[1])}, ${q(c[2])}, ${q(c[3])})`).join(', ');
  const sources = SOURCES.map((x, i) => `(${i}, ${q(x)})`).join(', ');
  return [
    `INSERT INTO orders (id, number, token, status, stock_deducted, customer_name, customer_email, customer_phone, company, delivery, source, subtotal, delivery_fee, total, created_at, updated_at)
     WITH RECURSIVE n(i) AS (SELECT 0 UNION ALL SELECT i + 1 FROM n WHERE i < 359),
     c(i, name, company, email, phone) AS (VALUES ${customers}), s(i, source) AS (VALUES ${sources})
     SELECT n.i + 1, 1001 + n.i, 'demo' || printf('%028d', n.i + 1), 'afsluttet', 1, c.name, c.email, c.phone, c.company, 'afhentning', s.source, 0, 0, 0,
       ${now} - (120 - n.i / 3) * 86400 + 25200 + (n.i % 3) * 10800, ${now} - (120 - n.i / 3) * 86400 + 25200 + (n.i % 3) * 10800
     FROM n JOIN c ON c.i = (n.i * 7 + n.i / 5) % ${CUSTOMERS.length} JOIN s ON s.i = (n.i * 3 + n.i / 7) % ${SOURCES.length};`,
    `INSERT INTO order_lines (order_id, product_id, sku, name, unit, unit_price, quantity, line_total)
     SELECT order_id, id, sku, name, unit, price, qty, price * qty FROM (
       SELECT o.id AS order_id, p.id, p.sku, p.name, p.unit, p.price,
         CAST(r.rate / 3.0 * (CASE WHEN strftime('%w', o.created_at, 'unixepoch') IN ('0', '6') THEN 0.3 ELSE 1.25 END) * 2 * ((o.id * 7919 + p.id * 104729) % 1000) / 1000.0
           + ((o.id * 6271 + p.id * 3359) % 1000) / 1000.0 AS INTEGER) AS qty
       FROM orders o CROSS JOIN products p JOIN (WITH r(sku, rate) AS (VALUES ${rates}) SELECT * FROM r) r ON r.sku = p.sku
       WHERE o.id <= 360
     ) WHERE qty > 0;`,
    `DELETE FROM orders WHERE id <= 360 AND NOT EXISTS (SELECT 1 FROM order_lines WHERE order_id = orders.id);`,
    `UPDATE orders SET subtotal = (SELECT SUM(line_total) FROM order_lines WHERE order_id = orders.id), total = (SELECT SUM(line_total) FROM order_lines WHERE order_id = orders.id) WHERE id <= 360;`,
    `INSERT INTO order_events (order_id, status, message, actor, created_at) SELECT id, 'ny', 'Bestilling modtaget', 'kunde', created_at FROM orders WHERE id <= 360;`,
    `INSERT INTO order_events (order_id, status, message, actor, created_at) SELECT id, 'afsluttet', 'Status ændret', 'demo@veyro.dk', created_at + 7200 FROM orders WHERE id <= 360;`,
  ];
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const file = args.find((a) => !a.startsWith('--'));
  const sql = demoSql(undefined, { compact: args.includes('--kompakt') });
  if (file) writeFileSync(file, sql);
  else process.stdout.write(sql);
}
