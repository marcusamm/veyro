import { Hono, type Context } from 'hono';
import type { AppEnv, JobRow, NoticeRow } from '../env';
import { productOverview, productOverviewOne, suppliers } from '../lib/catalog';
import { formatDateTime, formatQty, parseIntStrict, parseKr, parseQty, str } from '../lib/format';
import { adjustStock, isAdjustKind } from '../lib/inventory';
import { MOVE_LABEL, Tx } from '../lib/ledger';
import { addLine, getList, openPurchasesFor, stockList } from '../lib/purchasing';
import { evaluateProducts } from '../lib/notices';
import { normGtin } from '../lib/prices';
import { fetchableUrl, getRetailer, onRetailerSite, productPages, readProductPages, retailers } from '../lib/estimates';
import { productPagesCard } from '../views/priser';
import { requireManager } from '../lib/session';
import { actorOf, idParam, isDemo, newOp, render, runTx } from '../render';
import {
  dashboardPage,
  historyPage,
  newProductPage,
  productPage,
  productsPage,
  productValues,
  type MovementView,
  type ProductFormValues,
} from '../views/lager';
import indkob, { modtagelse } from './indkob';
import demo from './demo';
import faktura from './faktura';
import indstillinger from './indstillinger';
import priser from './priser';
import { lagerKatalog, panelFor } from './produktkatalog';
import { searchPanel } from '../views/produktkatalog';

const lager = new Hono<AppEnv>();
lager.use('*', requireManager);

const NAV = (tab: 'oversigt' | 'varer' | 'historik') => ({ portal: 'lager', tab }) as const;

export const MOVE_SQL = `SELECT m.*, p.name AS product_name, p.unit AS product_unit, p.sku, j.number AS job_number, j.name AS job_name
  FROM movements m LEFT JOIN products p ON p.id = m.product_id LEFT JOIN jobs j ON j.id = m.job_id`;

lager.get('/', async (c) => {
  const db = c.env.DB;
  const products = await productOverview(db);
  const alerts = products.filter((p) => ['genbestil', 'kritisk', 'ingen'].includes(p.plan.status));
  const openByProduct = new Map(await Promise.all(alerts.map(async (p) => [p.id, await openPurchasesFor(db, p.id)] as const)));
  const [{ results: deviations }, { results: waitingJobs }, { results: moves }] = await Promise.all([
    db
      .prepare("SELECT n.*, j.number AS job_number FROM notices n LEFT JOIN jobs j ON j.id = n.job_id WHERE n.open = 1 AND n.kind = 'afvigelse' ORDER BY n.created_at DESC")
      .all<NoticeRow & { job_number: string | null }>(),
    db
      .prepare(
        `SELECT j.id, j.number, j.name, j.planned_date, COUNT(*) AS lines FROM jobs j JOIN job_materials m ON m.job_id = j.id
         WHERE j.status = 'aktiv' AND m.planned > m.issued - m.returned + m.reserved + m.site_received - m.site_returned
         GROUP BY j.id ORDER BY j.planned_date = '', j.planned_date, j.number`,
      )
      .all<Pick<JobRow, 'id' | 'number' | 'name' | 'planned_date'> & { lines: number }>(),
    db.prepare(`${MOVE_SQL} ORDER BY m.id DESC LIMIT 8`).all<MovementView>(),
  ]);
  return render(
    c,
    'Lageroversigt',
    dashboardPage({
      products,
      openByProduct,
      deviations,
      waitingJobs,
      moves,
      csrf: c.get('csrf'),
      ops: alerts.map(() => newOp()),
      flashCode: c.req.query('besked'),
      demo: isDemo(c),
    }),
    NAV('oversigt'),
  );
});

lager.get('/varer', async (c) => {
  const status = c.req.query('status') ?? '';
  const q = (c.req.query('q') ?? '').slice(0, 100);
  return render(c, 'Varer og lager', productsPage({ products: await productOverview(c.env.DB, { all: true }), status, q, flashCode: c.req.query('besked') }), NAV('varer'));
});

interface ProductInput {
  sku: string;
  name: string;
  unit: string;
  whole_units: number;
  category: string;
  supplier_id: number | null;
  lead_time_days: number | null;
  avg_daily_usage: number | null;
  safety_method: 'antal' | 'dage';
  safety_qty: number | null;
  buffer_days: number | null;
  max_stock: number | null;
  purchase_price: number | null;
  sale_price: number | null;
  ean: string;
  mpn: string;
  brand: string;
  variant: string;
  active: number;
  initial_stock: number;
}

function formValues(body: Record<string, unknown>): ProductFormValues {
  const s = (k: string, max = 120) => str(body[k], max);
  return {
    sku: s('sku', 40),
    name: s('name'),
    unit: s('unit', 20),
    whole_units: body['whole_units'] === '1',
    category: s('category', 60),
    supplier_id: s('supplier_id', 12),
    lead_time_days: s('lead_time_days', 6),
    avg_daily_usage: s('avg_daily_usage', 20),
    safety_method: body['safety_method'] === 'dage' ? 'dage' : 'antal',
    safety_qty: s('safety_qty', 20),
    buffer_days: s('buffer_days', 6),
    max_stock: s('max_stock', 20),
    purchase_price: s('purchase_price', 20),
    sale_price: s('sale_price', 20),
    ean: s('ean', 20),
    mpn: s('mpn', 60),
    brand: s('brand', 60),
    variant: s('variant', 60),
    active: body['active'] === '1',
    initial_stock: s('initial_stock', 20),
  };
}

function parseProduct(v: ProductFormValues, isNew: boolean): { input?: ProductInput; errs: string[] } {
  const errs: string[] = [];
  const opt = <T>(raw: string, parse: (s: string) => T | null, label: string): T | null => {
    if (!raw) return null;
    const r = parse(raw);
    if (r === null) errs.push(`${label} er ikke et gyldigt tal.`);
    return r;
  };
  if (!v.sku) errs.push('Angiv et varenummer.');
  if (!v.name) errs.push('Angiv et varenavn.');
  if (!v.unit) errs.push('Angiv en enhed.');
  const days = (s: string) => {
    const n = parseIntStrict(s, { max: 365 });
    return n === null ? null : n;
  };
  const input: ProductInput = {
    sku: v.sku,
    name: v.name,
    unit: v.unit,
    whole_units: v.whole_units ? 1 : 0,
    category: v.category,
    supplier_id: v.supplier_id ? parseIntStrict(v.supplier_id) : null,
    lead_time_days: opt(v.lead_time_days, days, 'Leveringstid'),
    avg_daily_usage: opt(v.avg_daily_usage, parseQty, 'Dagligt forbrug'),
    safety_method: v.safety_method === 'dage' ? 'dage' : 'antal',
    safety_qty: opt(v.safety_qty, parseQty, 'Sikkerhedslager'),
    buffer_days: opt(v.buffer_days, days, 'Bufferdage'),
    max_stock: opt(v.max_stock, parseQty, 'Maksimumbeholdning'),
    purchase_price: opt(v.purchase_price, parseKr, 'Indkøbspris'),
    sale_price: opt(v.sale_price, parseKr, 'Salgspris'),
    ean: v.ean ? (normGtin(v.ean) ?? '') : '',
    mpn: v.mpn,
    brand: v.brand,
    variant: v.variant,
    active: isNew || v.active ? 1 : 0,
    initial_stock: opt(v.initial_stock, parseQty, 'Startbeholdning') ?? 0,
  };
  if (input.whole_units && input.initial_stock % 1000) errs.push('Startbeholdningen skal være et helt antal.');
  if (v.ean && !input.ean) errs.push('EAN er ikke gyldig (8, 12, 13 eller 14 cifre med korrekt kontrolciffer).');
  return errs.length ? { errs } : { input, errs };
}

lager.get('/varer/ny', async (c) =>
  render(
    c,
    'Ny vare',
    newProductPage(productValues(null), { csrf: c.get('csrf'), suppliers: await suppliers(c.env.DB), errs: [], catalog: searchPanel(await panelFor(c, '/lager/varer/ny', { kind: 'ny' }, { perPage: 10 })) }),
    NAV('varer'),
  ),
);

lager.post('/varer/ny', async (c) => {
  const body = await c.req.parseBody();
  const v = formValues(body);
  const { input, errs } = parseProduct(v, true);
  const fail = async (e: string[]) =>
    render(c, 'Ny vare', newProductPage(v, { csrf: c.get('csrf'), suppliers: await suppliers(c.env.DB), errs: e }), NAV('varer'), 400);
  if (!input) return fail(errs);
  const db = c.env.DB;
  const tx = new Tx(db, actorOf(c));
  try {
    const row = await db
      .prepare(
        `INSERT INTO products (sku, name, unit, whole_units, category, supplier_id, lead_time_days, avg_daily_usage, safety_method, safety_qty, buffer_days,
           max_stock, purchase_price, sale_price, ean, mpn, brand, variant, stock, active, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?) RETURNING id`,
      )
      .bind(
        input.sku,
        input.name,
        input.unit,
        input.whole_units,
        input.category,
        input.supplier_id,
        input.lead_time_days,
        input.avg_daily_usage,
        input.safety_method,
        input.safety_qty,
        input.buffer_days,
        input.max_stock,
        input.purchase_price,
        input.sale_price,
        input.ean,
        input.mpn,
        input.brand,
        input.variant,
        input.initial_stock,
        tx.now,
        tx.now,
      )
      .first<{ id: number }>();
    tx.move({ product_id: row!.id, kind: 'oprettet', qty: input.initial_stock, stock_delta: input.initial_stock, unit_cost: input.purchase_price, reason: 'Startbeholdning' });
    await tx.commit();
    await evaluateProducts(c.env, c.get('settings'), [row!.id], tx.actor.email);
    return c.redirect(`/lager/varer/${row!.id}?besked=oprettet`, 303);
  } catch (err) {
    if (String((err as Error).message).includes('UNIQUE')) return fail([`Varenummeret ${input.sku} findes allerede.`]);
    throw err;
  }
});

async function showProduct(
  c: Context<AppEnv>,
  id: number,
  extra: { values?: ProductFormValues; errs?: string[]; moveError?: string; pageError?: string; status?: 200 | 400 | 409 } = {},
) {
  const db = c.env.DB;
  const p = await productOverviewOne(db, id);
  if (!p) return c.notFound();
  const [sups, open, { results: jobs }, { results: moves }, pages, rets] = await Promise.all([
    suppliers(db),
    openPurchasesFor(db, id),
    db
      .prepare(
        `SELECT m.job_id, j.number, j.name, m.reserved, MAX(0, m.planned - (m.issued - m.returned + m.reserved + m.site_received - m.site_returned)) AS waiting
         FROM job_materials m JOIN jobs j ON j.id = m.job_id WHERE m.product_id = ? AND j.status = 'aktiv' AND (m.reserved > 0 OR m.planned > m.issued - m.returned + m.reserved + m.site_received - m.site_returned)
         ORDER BY j.number`,
      )
      .bind(id)
      .all<{ job_id: number; number: string; name: string; reserved: number; waiting: number }>(),
    db.prepare(`${MOVE_SQL} WHERE m.product_id = ? ORDER BY m.id DESC LIMIT 30`).bind(id).all<MovementView>(),
    productPages(db, id),
    retailers(db, { activeOnly: true }),
  ]);
  return render(
    c,
    p.name,
    productPage({
      p,
      values: extra.values ?? productValues(p),
      suppliers: sups,
      open,
      jobs,
      moves,
      csrf: c.get('csrf'),
      op: newOp(),
      op2: newOp(),
      errs: extra.errs ?? [],
      moveError: extra.moveError,
      flashCode: c.req.query('besked'),
      pagesCard: productPagesCard({ productId: id, unit: p.unit, pages, retailers: rets, csrf: c.get('csrf'), error: extra.pageError }),
    }),
    NAV('varer'),
    extra.status ?? 200,
  );
}

lager.get('/varer/:id{[0-9]+}', (c) => showProduct(c, Number(c.req.param('id'))));

lager.post('/varer/:id{[0-9]+}', async (c) => {
  const id = Number(c.req.param('id'));
  const body = await c.req.parseBody();
  const v = formValues(body);
  const { input, errs } = parseProduct(v, false);
  if (!input) return showProduct(c, id, { values: v, errs, status: 400 });
  try {
    await c.env.DB.prepare(
      `UPDATE products SET sku = ?, name = ?, unit = ?, whole_units = ?, category = ?, supplier_id = ?, lead_time_days = ?, avg_daily_usage = ?,
         safety_method = ?, safety_qty = ?, buffer_days = ?, max_stock = ?, purchase_price = ?, sale_price = ?,
         ean = ?, mpn = ?, brand = ?, variant = ?, active = ?, updated_at = ? WHERE id = ?`,
    )
      .bind(
        input.sku,
        input.name,
        input.unit,
        input.whole_units,
        input.category,
        input.supplier_id,
        input.lead_time_days,
        input.avg_daily_usage,
        input.safety_method,
        input.safety_qty,
        input.buffer_days,
        input.max_stock,
        input.purchase_price,
        input.sale_price,
        input.ean,
        input.mpn,
        input.brand,
        input.variant,
        input.active,
        Math.floor(Date.now() / 1000),
        id,
      )
      .run();
  } catch (err) {
    if (String((err as Error).message).includes('UNIQUE')) return showProduct(c, id, { values: v, errs: [`Varenummeret ${input.sku} findes allerede.`], status: 400 });
    throw err;
  }
  // Nye grænser kan give (eller fjerne) en advarsel
  await evaluateProducts(c.env, c.get('settings'), [id], actorOf(c).email);
  return c.redirect(`/lager/varer/${id}?besked=gemt`, 303);
});

// Produktsider hos byggemarkederne (til automatisk pris eller manuel pris med link)
// Sletter en vare. En vare med historik (bevægelser, job, indkøb, fakturaer, returer) eller beholdning
// slettes ikke, da historikken skal kunne følges; den skjules i stedet (inaktiv).
lager.post('/varer/:id{[0-9]+}/slet', async (c) => {
  const id = Number(c.req.param('id'));
  const db = c.env.DB;
  const p = await db.prepare('SELECT stock, reserved FROM products WHERE id = ?').bind(id).first<{ stock: number; reserved: number }>();
  if (!p) return c.notFound();
  const used = await db
    .prepare(
      `SELECT (SELECT COUNT(*) FROM movements WHERE product_id = ?1) + (SELECT COUNT(*) FROM job_materials WHERE product_id = ?1)
            + (SELECT COUNT(*) FROM purchase_lines WHERE product_id = ?1) + (SELECT COUNT(*) FROM invoice_lines WHERE product_id = ?1)
            + (SELECT COUNT(*) FROM job_items WHERE product_id = ?1) + (SELECT COUNT(*) FROM returns WHERE product_id = ?1)
            + (SELECT COUNT(*) FROM bilag_allocations WHERE product_id = ?1 AND done_at IS NOT NULL) AS n`,
    )
    .bind(id)
    .first<{ n: number }>();
  if (p.stock > 0 || p.reserved > 0 || (used?.n ?? 0) > 0) {
    await db.prepare('UPDATE products SET active = 0, updated_at = ? WHERE id = ?').bind(Math.floor(Date.now() / 1000), id).run();
    return c.redirect(`/lager/varer/${id}?besked=vare_skjult`, 303);
  }
  await db.batch([db.prepare('DELETE FROM notices WHERE product_id = ?').bind(id), db.prepare('DELETE FROM products WHERE id = ?').bind(id)]);
  return c.redirect('/lager/varer?besked=vare_slettet', 303);
});

lager.post('/varer/:id{[0-9]+}/produktside', async (c) => {
  const id = Number(c.req.param('id'));
  const db = c.env.DB;
  const body = await c.req.parseBody();
  const r = await getRetailer(db, idParam(String(body['retailer_id'] ?? '')) ?? 0);
  const url = str(body['url'], 500);
  const pack = parseQty(body['pack_qty']);
  if (!r || r.access === 'demo') return showProduct(c, id, { pageError: 'Vælg en butik.', status: 400 });
  if (!fetchableUrl(c.env, url) || !onRetailerSite(r, url)) return showProduct(c, id, { pageError: `Linket skal være en https-adresse hos ${r.website.replace(/^https?:\/\//, '')}.`, status: 400 });
  if (!pack) return showProduct(c, id, { pageError: 'Angiv indholdet pr. salgsenhed.', status: 400 });
  await db
    .prepare(
      `INSERT INTO product_pages (retailer_id, product_id, url, match, sales_unit, pack_qty, created_by, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
       ON CONFLICT(retailer_id, product_id) DO UPDATE SET url = ?3, match = ?4, sales_unit = ?5, pack_qty = ?6, last_status = '', last_ok = 0, last_fetched_at = NULL`,
    )
    .bind(r.id, id, url, body['match'] === 'alternativ' ? 'alternativ' : 'praecis', str(body['sales_unit'], 20) || 'stk.', pack, actorOf(c).email, Math.floor(Date.now() / 1000))
    .run();
  // Læs siden med det samme (hvis butikken er slået til); en fejl vises ved linket
  await readProductPages(c.env, Math.floor(Date.now() / 1000), { productIds: [id], force: true }).catch(() => null);
  return c.redirect(`/lager/varer/${id}?besked=gemt#produktsider`, 303);
});

lager.post('/varer/:id{[0-9]+}/produktside/:pid{[0-9]+}/slet', async (c) => {
  const id = Number(c.req.param('id'));
  const db = c.env.DB;
  const pg = await db.prepare('SELECT * FROM product_pages WHERE id = ? AND product_id = ?').bind(Number(c.req.param('pid')), id).first<{ retailer_id: number }>();
  if (pg) {
    await db.batch([
      db.prepare('DELETE FROM product_pages WHERE id = ?').bind(Number(c.req.param('pid'))),
      db.prepare('DELETE FROM retailer_products WHERE retailer_id = ? AND retailer_sku = ?').bind(pg.retailer_id, `side:${id}`),
    ]);
  }
  return c.redirect(`/lager/varer/${id}?besked=slettet#produktsider`, 303);
});

lager.post('/varer/:id{[0-9]+}/bevaegelse', async (c) => {
  const id = Number(c.req.param('id'));
  const body = await c.req.parseBody();
  const kind = body['kind'];
  const q = parseQty(body['qty']);
  if (!isAdjustKind(kind) || q === null) return showProduct(c, id, { moveError: 'Angiv type og en gyldig mængde.', status: 400 });
  const price = kind === 'modtagelse' && str(body['price'], 20) ? parseKr(body['price']) : null;
  const res = await runTx(c, kind, body['op'], async (tx) => {
    const p = await productOverviewOne(tx.db, id);
    if (!p) throw new Error('Vare findes ikke');
    adjustStock(tx, p, kind, q, str(body['reason'], 200), price);
  });
  if (!res.ok && !res.duplicate) return showProduct(c, id, { moveError: res.error, status: 409 });
  return c.redirect(`/lager/varer/${id}?besked=${res.ok ? 'registreret' : 'dublet'}`, 303);
});

/** Lægger varen på listen til lageropfyldning med den mængde, indkøberen har godkendt. */
lager.post('/varer/:id{[0-9]+}/genbestil', async (c) => {
  const id = Number(c.req.param('id'));
  const body = await c.req.parseBody();
  const q = parseQty(body['qty']);
  const back = (c.req.header('Referer') ?? '').includes('/lager/varer/') ? `/lager/varer/${id}` : '/lager';
  if (!q) return showProduct(c, id, { moveError: 'Angiv en mængde til lageropfyldning.', status: 400 });
  const listId = await stockList(c.env.DB, Math.floor(Date.now() / 1000));
  const res = await runTx(c, 'genbestil', body['op'], async (tx) => {
    const p = await productOverviewOne(tx.db, id);
    const list = await getList(tx.db, listId);
    if (!p || !list) throw new Error('Ikke fundet');
    const qty = p.whole_units ? Math.ceil(q / 1000) * 1000 : q;
    addLine(tx, list, {
      product_id: p.id,
      sku: p.sku,
      name: p.name,
      unit: p.unit,
      supplier_id: p.supplier_id,
      qty,
      unit_price: p.purchase_price,
      expected_date: '',
      deliver_to: 'lager',
      note: `Genbestilling (disponibel ${formatQty(p.plan.available)}, genbestillingspunkt ${formatQty(p.plan.rop)})`,
    });
  });
  if (!res.ok && !res.duplicate) return showProduct(c, id, { moveError: res.error, status: 409 });
  return c.redirect(`${back === '/lager' ? `/lager/indkob/${listId}` : back}?besked=${res.ok ? 'oprettet' : 'dublet'}`, 303);
});

const PAGE = 50;

lager.get('/historik', async (c) => {
  const kind = c.req.query('type') ?? '';
  const page = Math.max(1, parseInt(c.req.query('page') ?? '1', 10) || 1);
  const where = kind && kind in MOVE_LABEL ? 'WHERE m.kind = ?' : '';
  const stmt = c.env.DB.prepare(`${MOVE_SQL} ${where} ORDER BY m.id DESC LIMIT ? OFFSET ?`);
  const { results } = await (where ? stmt.bind(kind, PAGE + 1, (page - 1) * PAGE) : stmt.bind(PAGE + 1, (page - 1) * PAGE)).all<MovementView>();
  return render(c, 'Historik', historyPage({ moves: results.slice(0, PAGE), kind: where ? kind : '', page, more: results.length > PAGE }), NAV('historik'));
});

lager.get('/historik.csv', async (c) => {
  const kind = c.req.query('type') ?? '';
  const where = kind && kind in MOVE_LABEL ? 'WHERE m.kind = ?' : '';
  const stmt = c.env.DB.prepare(`${MOVE_SQL} ${where} ORDER BY m.id DESC LIMIT 10000`);
  const { results } = await (where ? stmt.bind(kind) : stmt).all<MovementView>();
  const cell = (v: unknown) => {
    const s = v === null || v === undefined ? '' : String(v);
    return /[";\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const q = (m: number | null) => (m === null ? '' : formatQty(m).replace(/\./g, ''));
  const rows = [
    ['Tidspunkt', 'Hændelse', 'Varenr.', 'Vare', 'Job', 'Mængde', 'Enhed', 'Ændring fysisk', 'Ændring reserveret', 'Fysisk efter', 'Reserveret efter', 'Medarbejder', 'Årsag'],
    ...results.map((m) => [
      formatDateTime(m.created_at),
      MOVE_LABEL[m.kind] ?? m.kind,
      m.sku ?? '',
      m.product_name ?? '',
      m.job_number ?? '',
      q(m.qty),
      m.product_unit ?? '',
      q(m.stock_delta),
      q(m.reserved_delta),
      m.product_id ? q(m.stock_after) : '',
      m.product_id ? q(m.reserved_after) : '',
      m.actor_name || m.actor,
      m.reason,
    ]),
  ];
  return c.body('﻿' + rows.map((r) => r.map(cell).join(';')).join('\r\n') + '\r\n', 200, {
    'Content-Type': 'text/csv; charset=utf-8',
    'Content-Disposition': 'attachment; filename="lagerhistorik.csv"',
  });
});

lager.route('/indkob', indkob);
lager.route('/modtagelse', modtagelse);
lager.route('/demo', demo);
lager.route('/faktura', faktura);
lager.route('/indstillinger', indstillinger);
lager.route('/priser', priser);
lager.route('/katalog', lagerKatalog);

export default lager;
