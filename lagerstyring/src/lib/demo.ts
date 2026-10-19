// Demo: fiktive varer, job og indkøbslister, så hele systemet kan afprøves med det samme, og et
// demoforløb, der kører eksemplerne fra kravene igennem den rigtige lagermotor og viser tallene.

import type { Env, JobRow, LabourTypeRow, ProductRow, User } from '../env';
import { execTx } from '../render';
import { productOverviewOne } from './catalog';
import { nowSec, randomToken } from './crypto';
import { addDays, formatQty, todayDk } from './format';
import type { Actor, Tx } from './ledger';
import {
  closeJob,
  getJob,
  getProduct,
  issueReserved,
  jobMaterials,
  planMaterial,
  registerUse,
  releaseReservation,
  returnToStock,
  setPlanned,
  useFromSite,
} from './materials';
import { seedDemoCatalog } from './katalogdemo';
import { importCatalog, refreshList, retailers, type RetailerRow } from './estimates';
import { buildCredit, buildDraft, getInvoice, issueInvoice } from './invoicing';
import { jobItems, lookupItems, manualPriceStmt, preferredRetailerId } from './jobitems';
import { logStmt, syncStage } from './jobs';
import { billRate, internalRate, jobEntries } from './labour';
import { computeQuote, saveQuote } from './quotes';
import { sendPurchaseList } from './notices';
import { ean13, type FeedItem } from './prices';
import { addLine, createList, getList, getLine, lineStatus, LINE_STATUS_LABEL, registerOrder, receiveLine, stockList } from './purchasing';
import { getSettings, saveSettings, type Settings } from './settings';
import { STATUS_LABEL } from './stock';

export const DEMO_USERS = {
  ejer: { email: 'mette@nordlysbyg.example', name: 'Mette Holm', role: 'ejer', alert_mail: 1, purchase_mail: 0 },
  indkober: { email: 'lars@nordlysbyg.example', name: 'Lars Kjær', role: 'indkober', alert_mail: 1, purchase_mail: 1 },
  medarbejder: { email: 'jonas@nordlysbyg.example', name: 'Jonas Berg', role: 'medarbejder', alert_mail: 0, purchase_mail: 0 },
} as const;

const K = 1000;
const kr = (n: number) => Math.round(n * 100);
const DAY = 86400;

async function ensureUsers(db: D1Database): Promise<void> {
  const now = nowSec();
  await db.batch(
    Object.values(DEMO_USERS).map((u) =>
      db
        .prepare('INSERT INTO users (email, name, role, alert_mail, purchase_mail, active, created_at) VALUES (?, ?, ?, ?, ?, 1, ?) ON CONFLICT(email) DO NOTHING')
        .bind(u.email, u.name, u.role, u.alert_mail, u.purchase_mail, now),
    ),
  );
}

/** Lægger demodata ind, hvis databasen er tom, og sørger for, at demobrugerne findes. */
export async function ensureDemo(env: Env): Promise<void> {
  await ensureUsers(env.DB);
  const row = await env.DB.prepare('SELECT COUNT(*) AS n FROM products').first<{ n: number }>();
  if (row?.n) return;
  try {
    await seed(env);
  } catch (err) {
    // To samtidige første besøg: den anden får en UNIQUE-fejl, og data findes allerede
    if (!String((err as Error).message).includes('UNIQUE')) throw err;
  }
}

/** Sletter alle registreringer og lægger demodata ind igen (brugere og logins bevares). */
export async function resetDemo(env: Env): Promise<void> {
  const db = env.DB;
  await db.batch(
    [
      'DELETE FROM price_estimates',
      'DELETE FROM invoice_items',
      'DELETE FROM invoices',
      'DELETE FROM job_quotes',
      'DELETE FROM job_entries',
      'DELETE FROM job_log',
      'DELETE FROM job_items',
      'DELETE FROM job_staff',
      'UPDATE users SET labour_type_id = NULL',
      'DELETE FROM labour_types',
      'DELETE FROM invoice_lines',
      'DELETE FROM invoice_bases',
      'DELETE FROM notices',
      'DELETE FROM mails',
      'DELETE FROM movements',
      'DELETE FROM purchase_lines',
      'DELETE FROM purchase_lists',
      'DELETE FROM job_materials',
      'DELETE FROM jobs',
      'DELETE FROM product_pages',
      'DELETE FROM retailer_products',
      "DELETE FROM retailers WHERE access = 'demo'",
      'DELETE FROM products',
      'DELETE FROM catalog_prices',
      'DELETE FROM catalog_import_words',
      'DELETE FROM catalog_import_rows',
      'UPDATE catalog_sources SET last_import_id = NULL',
      'DELETE FROM catalog_products',
      'DELETE FROM catalog_imports',
      'DELETE FROM catalog_sources',
      'DELETE FROM catalog_words',
      'DELETE FROM suppliers',
      'DELETE FROM ops',
      "DELETE FROM settings WHERE key = 'last_digest_at'",
    ].map((s) => db.prepare(s)),
  );
  await ensureDemo(env);
}

type ProductSeed = Partial<ProductRow> & { sku: string; name: string; unit: string; supplier: string };

const SUPPLIERS: [name: string, email: string, phone: string, lead: number][] = [
  ['Byggegrossisten Nord', 'ordre@byggegrossisten.example', '86 12 34 56', 5],
  ['Stark Erhverv', 'erhverv@stark.example', '70 10 20 30', 3],
  ['El-Grossisten', 'salg@elgrossisten.example', '89 40 50 60', 2],
  ['Maling & Co', 'ordre@malingco.example', '98 76 54 32', 4],
];

const PRODUCTS: ProductSeed[] = [
  // Eksemplet fra kravene: lager 100, forbrug 10/dag, leveringstid 5 dage, sikkerhedslager 20 → genbestillingspunkt 70
  { sku: 'FUG-300', name: 'Fugemasse akryl hvid 300 ml', unit: 'patron', category: 'Fuge og lim', supplier: 'Byggegrossisten Nord', lead_time_days: 5, avg_daily_usage: 10 * K, safety_method: 'antal', safety_qty: 20 * K, stock: 100 * K, purchase_price: kr(28), sale_price: kr(49) },
  // Eksemplet med plader: 18 på lager; jobbet skal bruge 30
  { sku: 'GIP-13', name: 'Gipsplade 13 mm 900×2500', unit: 'stk.', category: 'Plader', supplier: 'Stark Erhverv', lead_time_days: 3, avg_daily_usage: 6 * K, safety_method: 'dage', buffer_days: 2, stock: 18 * K, purchase_price: kr(62), sale_price: kr(99) },
  { sku: 'SKR-435', name: 'Træskruer 4,5×35 (200 stk.)', unit: 'pk.', category: 'Beslag og skruer', supplier: 'Byggegrossisten Nord', avg_daily_usage: 2 * K, safety_method: 'antal', safety_qty: 5 * K, stock: 40 * K, purchase_price: kr(89), sale_price: kr(149) },
  { sku: 'REG-4595', name: 'Reglar 45×95 mm', unit: 'm', whole_units: 0, category: 'Træ', supplier: 'Stark Erhverv', lead_time_days: 5, avg_daily_usage: 30 * K, safety_method: 'dage', buffer_days: 3, stock: 420 * K, purchase_price: kr(18.5), max_stock: 600 * K },
  { sku: 'MIN-95', name: 'Mineraluld 95 mm (5,4 m²)', unit: 'pk.', category: 'Isolering', supplier: 'Byggegrossisten Nord', avg_daily_usage: 1500, safety_method: 'antal', safety_qty: 4 * K, stock: 15 * K, purchase_price: kr(239), sale_price: kr(359) },
  { sku: 'OSB-12', name: 'OSB-plade 12 mm 1220×2440', unit: 'stk.', category: 'Plader', supplier: 'Stark Erhverv', lead_time_days: 5, avg_daily_usage: 1 * K, safety_method: 'antal', safety_qty: 4 * K, stock: 3 * K, purchase_price: kr(169), sale_price: kr(259) },
  { sku: 'MAL-10', name: 'Vægmaling hvid glans 5, 10 l', unit: 'spand', category: 'Maling', supplier: 'Maling & Co', avg_daily_usage: 500, safety_method: 'antal', safety_qty: 2 * K, stock: 3 * K, purchase_price: kr(549), sale_price: kr(849) },
  { sku: 'KAB-3G15', name: 'Installationskabel 3G1,5', unit: 'm', whole_units: 0, category: 'El', supplier: 'El-Grossisten', avg_daily_usage: 15 * K, safety_method: 'antal', safety_qty: 30 * K, stock: 250 * K, purchase_price: kr(6.9), sale_price: kr(12) },
  { sku: 'DAS-1', name: 'Indmuringsdåse 1 modul', unit: 'stk.', category: 'El', supplier: 'El-Grossisten', avg_daily_usage: 4 * K, safety_method: 'antal', safety_qty: 10 * K, stock: 60 * K, purchase_price: kr(7.5), sale_price: kr(15) },
  { sku: 'TAP-50', name: 'Malertape 50 mm', unit: 'rl.', category: 'Maling', supplier: 'Maling & Co', avg_daily_usage: 2 * K, safety_method: 'antal', safety_qty: 6 * K, stock: 24 * K, purchase_price: kr(24), sale_price: kr(45) },
  { sku: 'DAM-2', name: 'Dampspærre 0,20 mm 2×25 m', unit: 'rl.', category: 'Isolering', supplier: 'Byggegrossisten Nord', stock: 2 * K, purchase_price: kr(329) },
  { sku: 'VIN-90', name: 'Vinkelbeslag 90 mm', unit: 'stk.', category: 'Beslag og skruer', supplier: 'Byggegrossisten Nord', avg_daily_usage: 5 * K, safety_method: 'dage', buffer_days: 2, stock: 150 * K, purchase_price: kr(4.2), sale_price: kr(9) },
  { sku: 'SIL-S', name: 'Silikone sanitet hvid 300 ml', unit: 'patron', category: 'Fuge og lim', supplier: 'Byggegrossisten Nord', lead_time_days: 5, avg_daily_usage: 2 * K, safety_method: 'antal', safety_qty: 6 * K, stock: 20 * K, purchase_price: kr(54), sale_price: kr(89) },
  { sku: 'PU-750', name: 'PU-skum 750 ml', unit: 'stk.', category: 'Fuge og lim', supplier: 'Stark Erhverv', avg_daily_usage: 1 * K, safety_method: 'antal', safety_qty: 4 * K, stock: 20 * K, purchase_price: kr(59), sale_price: kr(99) },
  { sku: 'FLI-3060', name: 'Gulvklinker 30×60 grå', unit: 'm²', whole_units: 0, category: 'Fliser', supplier: 'Byggegrossisten Nord', stock: 4 * K, purchase_price: kr(289), sale_price: kr(429) },
];

const OWNER: Actor = { email: DEMO_USERS.ejer.email, name: DEMO_USERS.ejer.name };
const BUYER: Actor = { email: DEMO_USERS.indkober.email, name: DEMO_USERS.indkober.name };
const STAFF: Actor = { email: DEMO_USERS.medarbejder.email, name: DEMO_USERS.medarbejder.name };

async function must(p: Promise<{ ok: boolean; error?: string }>): Promise<void> {
  const r = await p;
  if (!r.ok) throw new Error(`Demodata kunne ikke oprettes: ${'error' in r ? r.error : ''}`);
}

async function insertProducts(env: Env, s: Settings, list: ProductSeed[], sups: Map<string, number>, at: number): Promise<Map<string, ProductRow>> {
  const db = env.DB;
  await db.batch(
    list.map((p) =>
      db
        .prepare(
          `INSERT INTO products (sku, name, unit, whole_units, category, supplier_id, lead_time_days, avg_daily_usage, safety_method, safety_qty, buffer_days,
             max_stock, purchase_price, sale_price, stock, active, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`,
        )
        .bind(
          p.sku,
          p.name,
          p.unit,
          p.whole_units ?? 1,
          p.category ?? '',
          sups.get(p.supplier) ?? null,
          p.lead_time_days ?? null,
          p.avg_daily_usage ?? null,
          p.safety_method ?? null,
          p.safety_qty ?? null,
          p.buffer_days ?? null,
          p.max_stock ?? null,
          p.purchase_price ?? null,
          p.sale_price ?? null,
          p.stock ?? 0,
          at,
          at,
        ),
    ),
  );
  const { results } = await db
    .prepare(`SELECT * FROM products WHERE sku IN (${list.map(() => '?').join(',')})`)
    .bind(...list.map((p) => p.sku))
    .all<ProductRow>();
  const bySku = new Map(results.map((p) => [p.sku, p]));
  await must(
    execTx(env, s, OWNER, 'oprettet', null, (tx) => {
      for (const p of results) tx.move({ product_id: p.id, kind: 'oprettet', qty: p.stock, stock_delta: p.stock, unit_cost: p.purchase_price, reason: 'Startbeholdning' });
    }, at),
  );
  return bySku;
}

async function insertJob(db: D1Database, j: Partial<JobRow> & { number: string; name: string }, at: number): Promise<JobRow> {
  const row = await db
    .prepare(
      `INSERT INTO jobs (number, name, customer_name, customer_email, customer_phone, customer_address, site_address, responsible, planned_date, markup_pct, note,
         status, stage, description, start_date, end_date, customer_cvr, customer_contact, hour_rate, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING *`,
    )
    .bind(
      j.number,
      j.name,
      j.customer_name ?? '',
      j.customer_email ?? '',
      j.customer_phone ?? '',
      j.customer_address ?? '',
      j.site_address ?? '',
      j.responsible ?? '',
      j.planned_date ?? j.start_date ?? '',
      j.markup_pct ?? null,
      j.note ?? '',
      j.status ?? 'aktiv',
      j.stage ?? 'planlagt',
      j.description ?? '',
      j.start_date ?? j.planned_date ?? '',
      j.end_date ?? '',
      j.customer_cvr ?? '',
      j.customer_contact ?? '',
      j.hour_rate ?? null,
      at,
      at,
    )
    .first<JobRow>();
  if (j.responsible) await db.prepare('INSERT INTO job_staff (job_id, email) VALUES (?, ?) ON CONFLICT DO NOTHING').bind(row!.id, j.responsible).run();
  return row!;
}

async function seed(env: Env): Promise<void> {
  const db = env.DB;
  // Fiktive firmaoplysninger (Demodata): CVR, adresse og bankkonto findes ikke
  await saveSettings(db, {
    company_name: 'Nordlys Byg ApS',
    default_markup_pct: 25,
    alert_mail_enabled: true,
    purchase_digest_hours: 0,
    company_address: 'Håndværkervej 12\n8660 Skanderborg',
    company_cvr: '12345678',
    company_email: 'kontor@nordlysbyg.example',
    company_phone: '86 52 00 00',
    bank_reg: '1234',
    bank_account: '0001234567',
    vat_registered: 'ja',
    payment_days: 8,
    invoice_start: 1001,
    quote_valid_days: 30,
    default_hour_rate: kr(575),
    default_internal_cost: kr(360),
    preferred_retailer: 'demo-nord',
  });
  const s = await getSettings(db);
  const now = nowSec();
  const t0 = now - 21 * DAY;
  const today = todayDk();

  await db.batch(SUPPLIERS.map(([name, email, phone, lead]) => db.prepare('INSERT INTO suppliers (name, email, phone, lead_time_days, created_at) VALUES (?, ?, ?, ?, ?)').bind(name, email, phone, lead, t0)));
  const { results: supRows } = await db.prepare('SELECT id, name FROM suppliers').all<{ id: number; name: string }>();
  const sups = new Map(supRows.map((x) => [x.name, x.id]));
  const P = await insertProducts(env, s, PRODUCTS, sups, t0);
  const pid = (sku: string) => P.get(sku)!.id;
  const prod = async (sku: string) => (await getProduct(db, pid(sku)))!;
  const run = (actor: Actor, kind: string, at: number, build: (tx: Tx) => Promise<void> | void) => must(execTx(env, s, actor, kind, null, build, at));

  // --- Afsluttet job med forbrug og godkendt fakturagrundlag ---------------------------------
  const j11 = await insertJob(
    db,
    {
      number: '2026-011',
      name: 'Køkkenrenovering, Lindevej 7',
      customer_name: 'Karen Sørensen',
      customer_email: 'karen.s@mail.example',
      customer_phone: '22 33 44 55',
      customer_address: 'Lindevej 7, 8660 Skanderborg',
      site_address: 'Lindevej 7, 8660 Skanderborg',
      responsible: STAFF.email,
      planned_date: addDays(today, -13),
      end_date: addDays(today, -10),
      description: 'Nye overskabe, fuger i bordplade og maling af vægge og loft i køkkenet.',
    },
    t0 + DAY,
  );
  await run(STAFF, 'forbrug', now - 13 * DAY, async (tx) => {
    await registerUse(tx, j11, await prod('SKR-435'), 3 * K, 'Montering af overskabe');
    await registerUse(tx, j11, await prod('PU-750'), 4 * K);
    await registerUse(tx, j11, await prod('MAL-10'), 3 * K, 'Vægge og loft');
  });
  await run(STAFF, 'planlagt', now - 13 * DAY, async (tx) => {
    await planMaterial(tx, j11, await prod('SIL-S'), 3 * K);
  });
  await run(STAFF, 'udlevering', now - 12 * DAY, async (tx) => {
    await issueReserved(tx, j11, await prod('SIL-S'), 3 * K);
  });
  await run(STAFF, 'retur', now - 11 * DAY, async (tx) => {
    await returnToStock(tx, j11, await prod('PU-750'), 1 * K, 'Ubrugt');
  });
  await run(OWNER, 'job_afsluttet', now - 10 * DAY, async (tx) => closeJob(tx, (await getJob(db, j11.id))!, 'afsluttet'));

  // --- Job 1: tilbygning med planlagte materialer og en liste til leje -----------------------
  const j14 = await insertJob(
    db,
    {
      number: '2026-014',
      name: 'Tilbygning, Fjordvej 12',
      customer_name: 'Anne og Peter Lund',
      customer_email: 'lund.familien@mail.example',
      customer_phone: '40 50 60 70',
      customer_address: 'Fjordvej 12, 8600 Silkeborg',
      site_address: 'Fjordvej 12, 8600 Silkeborg',
      responsible: STAFF.email,
      planned_date: addDays(today, -5),
      end_date: addDays(today, 20),
      description: 'Tilbygning på 18 m² med ydervæg i træskelet, isolering og dampspærre.',
      note: 'Nøgle hos naboen i nr. 10.',
    },
    now - 6 * DAY,
  );
  await run(STAFF, 'planlagt', now - 5 * DAY, async (tx) => {
    await planMaterial(tx, j14, await prod('REG-4595'), 120 * K, 'Skelet til ydervæg');
    await planMaterial(tx, j14, await prod('MIN-95'), 6 * K);
    await planMaterial(tx, j14, await prod('VIN-90'), 40 * K);
    await planMaterial(tx, j14, await prod('DAM-2'), 1 * K);
  });
  await run(STAFF, 'forbrug', now - 4 * DAY, async (tx) => {
    await registerUse(tx, j14, await prod('SKR-435'), 4 * K);
    await registerUse(tx, j14, await prod('REG-4595'), 48 * K, 'Bundrem og stolper');
  });
  // Ekstra liste til leje: en linje uden varenummer
  const rentId = await createList(db, { job_id: j14.id, name: 'Udstyr og leje', responsible: BUYER.name, wanted_date: addDays(today, 1), note: '' }, now - 4 * DAY);
  await run(BUYER, 'linje', now - 4 * DAY, async (tx) => {
    addLine(tx, (await getList(db, rentId))!, {
      product_id: null,
      sku: '',
      name: 'Leje af lift, 2 dage',
      unit: 'stk.',
      supplier_id: sups.get('Stark Erhverv') ?? null,
      qty: 1 * K,
      unit_price: kr(1800),
      expected_date: addDays(today, 1),
      deliver_to: 'arbejdssted',
      note: 'Leveres direkte til arbejdsstedet',
    });
  });
  const rent = await db.prepare('SELECT id FROM purchase_lines WHERE list_id = ?').bind(rentId).first<{ id: number }>();
  await run(BUYER, 'bestilling', now - 3 * DAY, async (tx) => registerOrder(tx, (await getLine(db, rent!.id))!, 1 * K, addDays(today, 1), 'ST-55120', null));

  // --- Job 2: badeværelse, mangler gipsplader (18 af 30) -------------------------------------
  const j15 = await insertJob(
    db,
    {
      number: '2026-015',
      name: 'Badeværelse, Søndergade 4, 2. th.',
      customer_name: 'Boligforeningen Søtoften',
      customer_email: 'drift@sotoften.example',
      customer_phone: '86 00 11 22',
      customer_address: 'Søtoftevej 1, 8000 Aarhus C',
      site_address: 'Søndergade 4, 2. th., 8000 Aarhus C',
      responsible: STAFF.email,
      planned_date: addDays(today, 5),
      end_date: addDays(today, 12),
      markup_pct: 20,
      customer_cvr: '87654321',
      customer_contact: 'Driftsleder Ole Vang',
      description: 'Renovering af badeværelse: nye gipsvægge, skakt og klinker på gulvet.',
    },
    now - 3 * DAY,
  );
  await run(STAFF, 'planlagt', now - 2 * DAY, async (tx) => {
    await planMaterial(tx, j15, await prod('GIP-13'), 30 * K, 'Vægge og skakt');
    await planMaterial(tx, j15, await prod('SIL-S'), 4 * K);
    await planMaterial(tx, j15, await prod('SKR-435'), 2 * K);
  });
  // Klinker leveres direkte til arbejdsstedet (øger ikke hovedlageret)
  const list15 = await db.prepare("SELECT id FROM purchase_lists WHERE job_id = ? AND kind = 'job' ORDER BY id LIMIT 1").bind(j15.id).first<{ id: number }>();
  const fli = await prod('FLI-3060');
  await run(BUYER, 'linje', now - 2 * DAY, async (tx) => {
    addLine(tx, (await getList(db, list15!.id))!, {
      product_id: fli.id,
      sku: fli.sku,
      name: fli.name,
      unit: fli.unit,
      supplier_id: fli.supplier_id,
      qty: 12 * K,
      unit_price: fli.purchase_price,
      expected_date: addDays(today, -1),
      deliver_to: 'arbejdssted',
      note: '',
    });
  });
  const fliLine = await db.prepare('SELECT id FROM purchase_lines WHERE job_id = ? AND product_id = ? AND auto = 0').bind(j15.id, fli.id).first<{ id: number }>();
  await run(BUYER, 'bestilling', now - 2 * DAY, async (tx) => registerOrder(tx, (await getLine(db, fliLine!.id))!, 12 * K, addDays(today, -1), 'BN-88412', null));
  await run(STAFF, 'modtagelse', now - 1 * DAY, async (tx) => receiveLine(tx, (await getLine(db, fliLine!.id))!, 12 * K, null, false));
  await run(STAFF, 'arbejdssted_forbrug', now - 3600 * 5, async (tx) => useFromSite(tx, (await getJob(db, j15.id))!, fli, 9500, 'Gulv lagt'));

  // --- Lageropfyldning: OSB-plader er bestilt (advarslen bliver, til de er modtaget) --------
  const refill = await stockList(db, now - DAY);
  const osb = await prod('OSB-12');
  await run(BUYER, 'genbestil', now - DAY, async (tx) => {
    addLine(tx, (await getList(db, refill))!, {
      product_id: osb.id,
      sku: osb.sku,
      name: osb.name,
      unit: osb.unit,
      supplier_id: osb.supplier_id,
      qty: 10 * K,
      unit_price: osb.purchase_price,
      expected_date: '',
      deliver_to: 'lager',
      note: 'Genbestilling',
    });
  });
  const osbLine = await db.prepare('SELECT id FROM purchase_lines WHERE list_id = ? AND product_id = ?').bind(refill, osb.id).first<{ id: number }>();
  await run(BUYER, 'bestilling', now - DAY, async (tx) => registerOrder(tx, (await getLine(db, osbLine!.id))!, 10 * K, addDays(today, 3), 'ST-55190', null));

  await seedPrices(env, list15!.id, P, now);
  await seedJobEconomy(env, { j11, j14, j15 }, now);
  // Produktkatalog med fiktive demovarer (importeret gennem den rigtige import; ændrer intet lager)
  await seedDemoCatalog(db, OWNER.email, now - 2 * DAY);
}

// --- Job: materialer med priser, timer, prisoverslag og fakturaer ---------------------------------
// Alt er fiktivt (Demodata). Jobbene dækker alle statusser: kladde, planlagt, i gang, afventer
// materialer, afsluttet (med udstedt faktura, kreditnota og en ny kladde) og annulleret.

/** Lagervarer, der er planlagt eller brugt på jobbet, som linjer under jobbets materialer. */
async function stockItems(db: D1Database, jobId: number, at: number): Promise<void> {
  await db
    .prepare(
      `INSERT INTO job_items (job_id, product_id, cost_basis, sku, name, unit, ean, mpn, brand, variant, qty, sale_mode, sale_price, planned_at, sort_order, created_by, created_at, updated_at)
       SELECT m.job_id, p.id, 'lager', p.sku, p.name, p.unit, p.ean, p.mpn, p.brand, p.variant, MAX(m.planned, m.issued - m.returned),
         CASE WHEN p.sale_price IS NULL THEN 'paaslag' ELSE 'manuel' END, p.sale_price, CASE WHEN m.planned > 0 THEN ?2 END, m.id, ?3, ?2, ?2
       FROM job_materials m JOIN products p ON p.id = m.product_id WHERE m.job_id = ?1
       ON CONFLICT(job_id, product_id) WHERE product_id IS NOT NULL DO NOTHING`,
    )
    .bind(jobId, at, STAFF.email)
    .run();
}

/** Materiale fra byggemarkedet (uden varenummer på lageret). */
async function freeItem(db: D1Database, jobId: number, o: { name: string; unit?: string; qty: number; used?: number; ean?: string }, at: number): Promise<number> {
  const row = await db
    .prepare(
      `INSERT INTO job_items (job_id, product_id, cost_basis, name, unit, ean, qty, used_qty, sale_mode, sort_order, created_by, created_at, updated_at)
       VALUES (?1, NULL, 'byggemarked', ?2, ?3, ?4, ?5, ?6, 'paaslag', (SELECT COALESCE(MAX(sort_order), 0) + 1000 FROM job_items WHERE job_id = ?1), ?7, ?8, ?8) RETURNING id`,
    )
    .bind(jobId, o.name, o.unit ?? 'stk.', o.ean ?? '', o.qty, o.used ?? 0, BUYER.email, at)
    .first<{ id: number }>();
  return row!.id;
}

interface EntrySeed {
  phase: 'forventet' | 'faktisk';
  type?: 'tid' | 'omkostning';
  worker?: User | null;
  labour?: LabourTypeRow | null;
  date?: string;
  description?: string;
  qty: number;
  unit?: string;
  price?: number | null;
  cost?: number | null;
  approved?: boolean;
  extra?: boolean;
}

async function entry(db: D1Database, s: Settings, job: JobRow, e: EntrySeed, at: number): Promise<void> {
  const type = e.type ?? 'tid';
  const lt = e.labour ?? null;
  const price = e.price !== undefined ? e.price : type === 'tid' ? billRate(job, lt, s) : null;
  const cost = e.cost !== undefined ? e.cost : type === 'tid' ? internalRate(lt, s) : null;
  await db
    .prepare(
      `INSERT INTO job_entries (job_id, type, phase, worker_email, worker_name, worker_type, work_date, description, qty, unit, internal_cost, unit_price, billable, extra,
         approved_by, approved_at, created_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      job.id,
      type,
      e.phase,
      e.worker?.email ?? '',
      e.worker?.name ?? '',
      lt?.name ?? '',
      e.date ?? '',
      e.description ?? '',
      e.qty,
      type === 'tid' ? 'timer' : (e.unit ?? 'stk.'),
      cost,
      price,
      e.extra ? 1 : 0,
      e.approved ? OWNER.name : null,
      e.approved ? at : null,
      e.worker?.email ?? OWNER.email,
      at,
      at,
    )
    .run();
}

async function quote(env: Env, s: Settings, jobId: number, at: number, o: { shared?: boolean; accepted?: boolean; note?: string } = {}): Promise<number> {
  const db = env.DB;
  const job = (await getJob(db, jobId))!;
  const [items, entries, rs] = await Promise.all([jobItems(db, jobId, await preferredRetailerId(db, s)), jobEntries(db, jobId), retailers(db)]);
  const names = new Map(rs.map((r) => [r.id, r.name]));
  const calc = computeQuote(job, items, entries, s, at, (id) => (id === null ? 'Byggemarked' : (names.get(id) ?? 'Byggemarked')));
  const id = await saveQuote(db, jobId, calc, s, o.note ?? '', OWNER, at);
  if (o.shared || o.accepted)
    await db
      .prepare('UPDATE job_quotes SET shared_at = ?1, shared_by = ?2, accepted_at = ?3, accepted_by = ?4 WHERE id = ?5')
      .bind(at, OWNER.email, o.accepted ? at + 3600 : null, o.accepted ? OWNER.email : null, id)
      .run();
  return id;
}

async function invoice(env: Env, s: Settings, jobId: number, at: number, opts: { mode: 'medgaaet' | 'fast' | 'kombination'; fixed: number | null }, issue: boolean): Promise<number> {
  const db = env.DB;
  const job = (await getJob(db, jobId))!;
  const items = await jobItems(db, jobId, await preferredRetailerId(db, s));
  const id = await buildDraft(db, job, items, s, opts, OWNER, at);
  if (issue) {
    const r = await issueInvoice(db, (await getInvoice(db, id))!, job, items, s, OWNER, at);
    if (!r.ok) throw new Error(`Demofakturaen kunne ikke udstedes: ${r.errors.join(' ')}`);
  }
  return id;
}

async function seedJobEconomy(env: Env, J: { j11: JobRow; j14: JobRow; j15: JobRow }, now: number): Promise<void> {
  const db = env.DB;
  const s = await getSettings(db);
  const today = todayDk();
  const at = (days: number) => Math.round(now - days * DAY);

  // Medarbejdertyper med samlet intern timeomkostning og timepris (Demodata)
  await db.batch([
    db.prepare('INSERT INTO labour_types (name, internal_cost, bill_rate, active, created_at) VALUES (?, ?, ?, 1, ?)').bind('Tømrer', kr(385), kr(595), at(21)),
    db.prepare('INSERT INTO labour_types (name, internal_cost, bill_rate, active, created_at) VALUES (?, ?, ?, 1, ?)').bind('Lærling', kr(190), kr(395), at(21)),
  ]);
  const types = (await db.prepare('SELECT * FROM labour_types').all<LabourTypeRow>()).results;
  const tomrer = types.find((t) => t.name === 'Tømrer')!;
  const laerling = types.find((t) => t.name === 'Lærling')!;
  await db.prepare('UPDATE users SET labour_type_id = ? WHERE email IN (?, ?)').bind(tomrer.id, STAFF.email, OWNER.email).run();
  const jonas = (await db.prepare('SELECT * FROM users WHERE email = ?').bind(STAFF.email).first<User>())!;
  const mette = (await db.prepare('SELECT * FROM users WHERE email = ?').bind(OWNER.email).first<User>())!;

  // --- 2026-011 Køkken (afsluttet): accepteret overslag og udstedt faktura (medgået) ---------
  await stockItems(db, J.j11.id, at(13));
  const j11 = (await getJob(db, J.j11.id))!;
  await entry(db, s, j11, { phase: 'forventet', labour: tomrer, qty: 22 * K, description: 'Montering og maling' }, at(20));
  await quote(env, s, j11.id, at(19), { accepted: true });
  for (const [d, h, txt] of [[13, 7500, 'Overskabe monteret'], [12, 7500, 'Fuger og spartling'], [11, 6000, 'Maling af vægge og loft']] as const)
    await entry(db, s, j11, { phase: 'faktisk', worker: jonas, labour: tomrer, date: addDays(today, -d), qty: h, description: txt, approved: true }, at(d));
  await entry(db, s, j11, { phase: 'faktisk', type: 'omkostning', description: 'Bortkørsel af affald', qty: 1 * K, price: kr(450), cost: kr(300), approved: true }, at(10));
  await invoice(env, s, j11.id, at(9), { mode: 'medgaaet', fixed: null }, true);

  // --- 2026-010 Terrasse (afsluttet): fast pris, kreditnota og ny kladde med ekstraarbejde ---
  const j10 = await insertJob(
    db,
    {
      number: '2026-010',
      name: 'Terrasse, Birkevej 22',
      customer_name: 'Henrik Dahl',
      customer_email: 'henrik.dahl@mail.example',
      customer_phone: '30 40 50 60',
      customer_address: 'Birkevej 22, 8680 Ry',
      site_address: 'Birkevej 22, 8680 Ry',
      responsible: STAFF.email,
      start_date: addDays(today, -19),
      end_date: addDays(today, -15),
      status: 'afsluttet',
      stage: 'afsluttet',
      description: 'Terrasse på 24 m² i trykimprægneret fyr med trappe.',
    },
    at(25),
  );
  const deck = await freeItem(db, j10.id, { name: 'Terrassebrædder fyr 28×120 mm', unit: 'm', qty: 210 * K, used: 204 * K }, at(24));
  const screws = await freeItem(db, j10.id, { name: 'Terrasseskruer A2 4,8×60 (500 stk.)', unit: 'pk.', qty: 2 * K, used: 2 * K }, at(24));
  await db.batch([
    manualPriceStmt(db, deck, null, { price: kr(21.95), vat: 'inkl', sales_unit: 'm', pack_qty: 1 * K, url: '', found_name: 'Terrassebræt fyr 28×120 (Demodata)' }, BUYER, at(24)),
    manualPriceStmt(db, screws, null, { price: kr(399), vat: 'inkl', sales_unit: 'pk.', pack_qty: 1 * K, url: '', found_name: 'Terrasseskruer 500 stk. (Demodata)' }, BUYER, at(24)),
  ]);
  await entry(db, s, j10, { phase: 'forventet', labour: tomrer, qty: 28 * K, description: 'Opbygning af terrasse og trappe' }, at(24));
  await quote(env, s, j10.id, at(23), { accepted: true, note: 'Fast pris efter aftale.' });
  for (const d of [19, 18, 17, 16]) await entry(db, s, j10, { phase: 'faktisk', worker: jonas, labour: tomrer, date: addDays(today, -d), qty: 7500, description: 'Terrasse', approved: true }, at(d));
  await entry(db, s, j10, { phase: 'faktisk', worker: mette, labour: tomrer, date: addDays(today, -15), qty: 3 * K, description: 'Ekstra trappetrin efter kundens ønske', approved: true, extra: true }, at(15));
  const fixed = kr(17500);
  // Faktura med den faste pris; ved en fejl kom ekstraarbejdet ikke med. Den krediteres, og en ny
  // kladde med fast pris plus ekstraarbejde ligger klar til gennemsyn.
  const first = await invoice(env, s, j10.id, at(14), { mode: 'fast', fixed }, true);
  const credit = await buildCredit(db, (await getInvoice(db, first))!, OWNER, at(12));
  await db.prepare("UPDATE invoices SET note = 'Krediteres fuldt, fordi ekstraarbejdet manglede. Erstattes af en ny faktura.' WHERE id = ?").bind(credit).run();
  const job10 = (await getJob(db, j10.id))!;
  const cr = await issueInvoice(db, (await getInvoice(db, credit))!, job10, await jobItems(db, j10.id, await preferredRetailerId(db, s)), s, OWNER, at(12));
  if (!cr.ok) throw new Error(`Demokreditnotaen kunne ikke udstedes: ${cr.errors.join(' ')}`);
  await invoice(env, s, j10.id, at(12), { mode: 'kombination', fixed }, false);

  // --- 2026-012 Vinduer (annulleret) ----------------------------------------------------------
  const j12 = await insertJob(
    db,
    {
      number: '2026-012',
      name: 'Udskiftning af vinduer, Kirkegade 3',
      customer_name: 'Sofie Krogh',
      customer_email: 'sofie.krogh@mail.example',
      customer_address: 'Kirkegade 3, 8660 Skanderborg',
      responsible: STAFF.email,
      start_date: addDays(today, -8),
      status: 'annulleret',
      stage: 'annulleret',
      description: 'Udskiftning af 6 vinduer. Kunden har valgt at udskyde opgaven.',
    },
    at(18),
  );
  await entry(db, s, j12, { phase: 'forventet', labour: tomrer, qty: 30 * K }, at(18));
  await quote(env, s, j12.id, at(17), { shared: true });
  await db.batch([logStmt(db, j12.id, 'status', 'Status ændret fra Planlagt til Annulleret. Kunden udskyder opgaven.', OWNER, at(9))]);

  // --- 2026-014 Tilbygning (i gang): to overslagsversioner, timer til godkendelse --------------
  await stockItems(db, J.j14.id, at(5));
  const j14 = (await getJob(db, J.j14.id))!;
  await entry(db, s, j14, { phase: 'forventet', labour: tomrer, qty: 80 * K, description: 'Skelet, isolering og beklædning' }, at(6));
  await entry(db, s, j14, { phase: 'forventet', type: 'omkostning', description: 'Leje af lift', qty: 1 * K, price: kr(2250), cost: kr(1800) }, at(6));
  await quote(env, s, j14.id, at(6), { shared: true });
  await entry(db, s, j14, { phase: 'forventet', labour: laerling, qty: 24 * K, description: 'Lærling til isolering' }, at(5));
  await quote(env, s, j14.id, at(5), { accepted: true, note: 'Version 2: lærling til isolering tilføjet.' });
  await entry(db, s, j14, { phase: 'faktisk', worker: jonas, labour: tomrer, date: addDays(today, -4), qty: 7500, description: 'Bundrem og stolper', approved: true }, at(4));
  await entry(db, s, j14, { phase: 'faktisk', worker: jonas, labour: tomrer, date: addDays(today, -3), qty: 8 * K, description: 'Skelet til ydervæg' }, at(3));
  await entry(db, s, j14, { phase: 'faktisk', worker: jonas, labour: tomrer, date: addDays(today, -1), qty: 6500, description: 'Remme og vindafstivning' }, at(1));

  // --- 2026-015 Badeværelse (afventer materialer) --------------------------------------------
  await stockItems(db, J.j15.id, at(2));
  const j15 = (await getJob(db, J.j15.id))!;
  await entry(db, s, j15, { phase: 'forventet', labour: tomrer, qty: 30 * K, description: 'Vægge, skakt og gulv' }, at(3));
  await quote(env, s, j15.id, at(2));

  // --- 2026-016 Loft i carport (planlagt): materialer fra byggemarkedet med pakkeomregning ----
  const j16 = await insertJob(
    db,
    {
      number: '2026-016',
      name: 'Loft i carport, Engvej 9',
      customer_name: 'Mikkel og Ida Friis',
      customer_email: 'friis@mail.example',
      customer_phone: '28 29 30 31',
      customer_address: 'Engvej 9, 8660 Skanderborg',
      site_address: 'Engvej 9, 8660 Skanderborg',
      responsible: STAFF.email,
      start_date: addDays(today, 7),
      end_date: addDays(today, 9),
      stage: 'planlagt',
      description: 'Loft af gipsplader i carport på 30 m² med lister.',
    },
    at(2),
  );
  await freeItem(db, j16.id, { name: 'Gipsplade 13 mm 900×2500', qty: 12 * K, ean: DEMO_EAN['GIP-13'] }, at(2));
  // 12 stk. købes som 2 pakker med 10 (8 i overskud, som ikke faktureres)
  await freeItem(db, j16.id, { name: 'Vinkelbeslag 90 mm', qty: 12 * K, ean: DEMO_EAN['VIN-90'] }, at(2));
  await freeItem(db, j16.id, { name: 'Loftliste fyr 21×45 mm', unit: 'm', qty: 30 * K }, at(2));
  await lookupItems(env, await jobItems(db, j16.id, await preferredRetailerId(db, s)), at(2));
  const job16 = (await getJob(db, j16.id))!;
  await entry(db, s, job16, { phase: 'forventet', labour: tomrer, qty: 16 * K, description: 'Montering af loft og lister' }, at(2));
  await quote(env, s, j16.id, at(1));

  // --- 2026-017 Nyt køkken (kladde) ------------------------------------------------------------
  const j17 = await insertJob(
    db,
    {
      number: '2026-017',
      name: 'Nyt køkken, Bakkevej 3',
      customer_name: 'Lone Bech',
      customer_email: 'lone.bech@mail.example',
      customer_address: 'Bakkevej 3, 8600 Silkeborg',
      responsible: STAFF.email,
      stage: 'kladde',
      description: 'Kunden ønsker et overslag på nedtagning af gammelt køkken og montering af nyt.',
    },
    at(0.5),
  );
  await entry(db, s, j17, { phase: 'forventet', labour: tomrer, qty: 40 * K, description: 'Nedtagning og montering' }, at(0.5));
  await freeItem(db, j17.id, { name: 'Køkkenelementer efter kundens valg', qty: 1 * K }, at(0.5));

  for (const id of [J.j14.id, J.j15.id, j16.id]) await syncStage(db, id, now);
}

// --- Prisestimat med demodata ----------------------------------------------------------------
// To fiktive forhandlere med opdigtede priser, markeret "Demodata" overalt. Der er ingen
// produktlinks, fordi siderne ikke findes. EAN-numrene bruger præfiks 20 (internt brug), så de
// ikke er rigtige varers numre.

const DEMO_EAN = {
  'GIP-13': '0' + ean13('200000000013'),
  'VIN-90': '0' + ean13('200000000090'),
};

async function seedPrices(env: Env, listId: number, P: Map<string, ProductRow>, now: number): Promise<void> {
  const db = env.DB;
  const note = 'Fiktiv forhandler i demoen. Priserne er opdigtede (Demodata) og findes ikke hos nogen rigtig forhandler.';
  await db.batch([
    db.prepare("INSERT INTO retailers (key, name, website, access, terms_note, created_at) VALUES ('demo-nord', 'Byggecenter Nord (demo)', '', 'demo', ?, ?)").bind(note, now),
    db.prepare("INSERT INTO retailers (key, name, website, access, terms_note, created_at) VALUES ('demo-syd', 'Trælast Syd (demo)', '', 'demo', ?, ?)").bind(note, now),
    ...Object.entries(DEMO_EAN).map(([sku, ean]) => db.prepare("UPDATE products SET ean = ?, brand = 'Nordlys Demo' WHERE sku = ?").bind(ean, sku)),
  ]);
  const nord = (await db.prepare("SELECT * FROM retailers WHERE key = 'demo-nord'").first<RetailerRow>())!;
  const syd = (await db.prepare("SELECT * FROM retailers WHERE key = 'demo-syd'").first<RetailerRow>())!;
  const item = (o: Partial<FeedItem> & Pick<FeedItem, 'retailer_sku' | 'name' | 'price'>): FeedItem => ({
    ean: '',
    mpn: '',
    brand: '',
    variant: '',
    url: '',
    sales_unit: 'stk.',
    pack_qty: 1 * K,
    content_unit: 'stk.',
    min_qty: 1 * K,
    divisible: 0,
    vat: 'inkl',
    offer_price: null,
    offer_text: '',
    offer_min_qty: null,
    offer_until: '',
    stock_text: '',
    ...o,
  });
  await importCatalog(
    db,
    nord,
    [
      item({ retailer_sku: 'N-1001', ean: DEMO_EAN['GIP-13'], name: 'Gipsplade 13 mm 900×2500', price: kr(79) }),
      item({ retailer_sku: 'N-2040', ean: DEMO_EAN['VIN-90'], name: 'Vinkelbeslag 90 mm, 10 stk.', sales_unit: 'pk.', pack_qty: 10 * K, price: kr(100) }),
      item({ retailer_sku: 'N-3310', name: 'Vægmaling glans 5 hvid 10 l (andet mærke)', sales_unit: 'spand', content_unit: 'spand', price: kr(649) }),
    ],
    'demodata',
    now,
  );
  await importCatalog(
    db,
    syd,
    [
      item({ retailer_sku: 'S-77', ean: DEMO_EAN['GIP-13'], name: 'Gipsplade standard 13 mm 0,9×2,5 m', price: kr(72.5), offer_text: '' }),
      item({ retailer_sku: 'S-91', ean: DEMO_EAN['VIN-90'], name: 'Vinkelbeslag 90 mm, 25 stk.', sales_unit: 'pk.', pack_qty: 25 * K, price: kr(219) }),
    ],
    'demodata',
    now,
  );
  // En ældre pris, der vises som "Tidligere pris – ikke bekræftet"
  await db.prepare("UPDATE retailer_products SET checked_at = ? WHERE retailer_id = ? AND retailer_sku = 'S-91'").bind(now - 20 * DAY, syd.id).run();

  const list = (await getList(db, listId))!;
  const vin = P.get('VIN-90')!;
  const mal = P.get('MAL-10')!;
  await must(
    execTx(env, await getSettings(db), BUYER, 'linje', null, (tx) => {
      for (const [p, q] of [[vin, 12 * K], [mal, 2 * K]] as const) {
        addLine(tx, list, { product_id: p.id, sku: p.sku, name: p.name, unit: p.unit, supplier_id: p.supplier_id, qty: q, unit_price: p.purchase_price, expected_date: '', deliver_to: 'lager', note: '' });
      }
      addLine(tx, list, { product_id: null, sku: '', name: 'Specialbeslag til skakt (tegning 4B)', unit: 'stk.', supplier_id: null, qty: 4 * K, unit_price: null, expected_date: '', deliver_to: 'arbejdssted', note: 'Skal bestilles efter mål' });
    }, now),
  );
  await refreshList(db, listId, BUYER.email, now);
}

// --- Demoforløb ------------------------------------------------------------------------------

export interface DemoCheck {
  label: string;
  expected: string;
  actual: string;
  ok: boolean;
}

export interface DemoStep {
  title: string;
  text: string;
  checks: DemoCheck[];
  link?: { href: string; label: string };
}

const SCENARIO_CATEGORY = 'Demoforløb';

function chk(label: string, expected: string | number, actual: string | number): DemoCheck {
  const e = typeof expected === 'number' ? formatQty(expected) : expected;
  const a = typeof actual === 'number' ? formatQty(actual) : actual;
  return { label, expected: e, actual: a, ok: e === a };
}

/**
 * Kører eksemplerne fra kravene igennem den rigtige lagermotor på nye forløbsvarer og -job og
 * måler tallene efter hvert trin. Tidligere forløb lukkes først, så oversigten ikke fyldes op.
 */
export async function runDemoScenario(env: Env, s: Settings, actor: Actor): Promise<DemoStep[]> {
  const db = env.DB;
  const now = nowSec();
  const steps: DemoStep[] = [];
  const op = () => randomToken(18);
  const run = (kind: string, build: (tx: Tx) => Promise<void> | void, token: string | null = op()) => execTx(env, s, actor, kind, token, build);

  // Ryd op efter tidligere forløb
  const { results: oldJobs } = await db.prepare("SELECT * FROM jobs WHERE number LIKE 'FORLØB-%' AND status = 'aktiv'").all<JobRow>();
  for (const j of oldJobs) await run('job_afsluttet', (tx) => closeJob(tx, j, 'afsluttet'), null);
  await db.batch([
    db.prepare("UPDATE notices SET open = 0, resolved_at = ? WHERE open = 1 AND product_id IN (SELECT id FROM products WHERE category = ?)").bind(now, SCENARIO_CATEGORY),
    db.prepare('UPDATE products SET active = 0 WHERE category = ?').bind(SCENARIO_CATEGORY),
    // Forløbets fakturakladder er aldrig udstedt og fjernes igen
    db.prepare("DELETE FROM invoice_items WHERE invoice_id IN (SELECT i.id FROM invoices i JOIN jobs j ON j.id = i.job_id WHERE i.status = 'kladde' AND j.number LIKE 'FORLØB-%')"),
    db.prepare("DELETE FROM invoices WHERE status = 'kladde' AND job_id IN (SELECT id FROM jobs WHERE number LIKE 'FORLØB-%')"),
  ]);

  const n = ((await db.prepare("SELECT COUNT(*) AS n FROM jobs WHERE number LIKE 'FORLØB-%'").first<{ n: number }>())?.n ?? 0) / 2 + 1;
  const sup = await db.prepare('SELECT id, name FROM suppliers ORDER BY id LIMIT 1').first<{ id: number; name: string }>();
  const supName = sup?.name ?? '';
  const base = { unit: 'stk.', category: SCENARIO_CATEGORY, supplier: supName, lead_time_days: 5, avg_daily_usage: 10 * K, safety_method: 'antal' as const, safety_qty: 20 * K, stock: 100 * K, purchase_price: kr(40), sale_price: kr(65) };
  const sups = new Map(sup ? [[sup.name, sup.id]] : []);
  const P = await insertProducts(
    env,
    s,
    [
      { ...base, sku: `FORLOB${n}-A`, name: `Forløb ${n}: Vare A (direkte forbrug)` },
      { ...base, sku: `FORLOB${n}-B`, name: `Forløb ${n}: Vare B (reservation)` },
      { ...base, sku: `FORLOB${n}-C`, name: `Forløb ${n}: Plader (mangel)`, stock: 18 * K, avg_daily_usage: 6 * K, lead_time_days: 3, safety_method: 'dage', safety_qty: null, buffer_days: 2 },
    ],
    sups,
    now,
  );
  const [A, B, C] = [`FORLOB${n}-A`, `FORLOB${n}-B`, `FORLOB${n}-C`].map((k) => P.get(k)!.id) as [number, number, number];
  const j1 = await insertJob(db, { number: `FORLØB-${n}-1`, name: `Forløb ${n}: Job 1`, customer_name: 'Demo-kunde A/S', site_address: 'Eksempelvej 1, 8000 Aarhus C', responsible: actor.email, planned_date: addDays(todayDk(), 3) }, now);
  const j2 = await insertJob(db, { number: `FORLØB-${n}-2`, name: `Forløb ${n}: Job 2`, customer_name: 'Demo-kunde A/S', site_address: 'Eksempelvej 2, 8000 Aarhus C', responsible: actor.email, planned_date: addDays(todayDk(), 5) }, now);
  const P_ = async (id: number) => (await getProduct(db, id))!;
  const J = async (id: number) => (await getJob(db, id))!;
  const snap = async (id: number) => {
    const p = (await productOverviewOne(db, id))!;
    return { stock: p.stock, reserved: p.reserved, available: p.plan.available, rop: p.plan.rop ?? -1, safety: p.plan.safety ?? -1, status: STATUS_LABEL[p.plan.status] };
  };
  const openNotice = async (id: number) => !!(await db.prepare("SELECT 1 FROM notices WHERE kind = 'lager' AND open = 1 AND product_id = ?").bind(id).first());

  // 1. Genbestillingspunkt
  let a = await snap(A);
  steps.push({
    title: 'Genbestillingspunkt',
    text: 'Vare A: fysisk 100, reserveret 0, dagligt forbrug 10, leveringstid 5 dage, sikkerhedslager 20. Genbestillingspunkt = 10 × 5 + 20.',
    checks: [chk('Sikkerhedslager', 20 * K, a.safety), chk('Genbestillingspunkt', 70 * K, a.rop), chk('Status', 'Normal', a.status)],
    link: { href: `/lager/varer/${A}`, label: 'Se vare A' },
  });

  // 2. Direkte forbrug af 30
  const tok = op();
  await run('forbrug', async (tx) => registerUse(tx, await J(j1.id), await P_(A), 30 * K, 'Demoforløb'), tok);
  a = await snap(A);
  const again = await run('forbrug', async (tx) => registerUse(tx, await J(j1.id), await P_(A), 30 * K, 'Demoforløb'), tok);
  const a2 = await snap(A);
  steps.push({
    title: 'Direkte forbrug af 30',
    text: 'En medarbejder registrerer 30 som brugt på job 1. Formularen sendes derefter en gang til (dobbeltklik eller genindlæsning).',
    checks: [
      chk('Fysisk', 70 * K, a.stock),
      chk('Disponibel', 70 * K, a.available),
      chk('Status', 'Genbestilling nødvendig', a.status),
      chk('Advarsel oprettet', 'Ja', (await openNotice(A)) ? 'Ja' : 'Nej'),
      chk('Samme formular igen', 'Afvist som dublet', again.ok ? 'Trukket igen' : again.duplicate ? 'Afvist som dublet' : again.error),
      chk('Fysisk efter dublet', 70 * K, a2.stock),
    ],
  });

  // 3. Planlagt forbrug: reservation af 30
  await run('planlagt', async (tx) => void (await planMaterial(tx, await J(j1.id), await P_(B), 30 * K, 'Demoforløb')));
  let bq = await snap(B);
  steps.push({
    title: 'Planlagt forbrug: reservér 30',
    text: 'Vare B starter også på 100. Job 1 planlægger 30: den fysiske beholdning er uændret, men det disponible falder.',
    checks: [chk('Fysisk', 100 * K, bq.stock), chk('Reserveret', 30 * K, bq.reserved), chk('Disponibel', 70 * K, bq.available), chk('Status', 'Genbestilling nødvendig', bq.status)],
  });

  // 4. Udlevering
  await run('udlevering', async (tx) => issueReserved(tx, await J(j1.id), await P_(B), 30 * K, 'Demoforløb'));
  bq = await snap(B);
  steps.push({
    title: 'Udlevering af de 30',
    text: 'De reserverede varer udleveres: de trækkes fra den fysiske beholdning, og reservationen fjernes. Intet trækkes to gange.',
    checks: [chk('Fysisk', 70 * K, bq.stock), chk('Reserveret', 0, bq.reserved), chk('Disponibel', 70 * K, bq.available)],
  });

  // 5. Annulleret reservation
  await run('planlagt', async (tx) => void (await planMaterial(tx, await J(j1.id), await P_(B), 10 * K, 'Demoforløb')));
  const mid = await snap(B);
  await run('frigivelse', async (tx) => releaseReservation(tx, await J(j1.id), await P_(B), 10 * K, 'Behov annulleret'));
  bq = await snap(B);
  steps.push({
    title: 'Annullér en reservation',
    text: 'Job 1 reserverer 10 mere, som derefter annulleres. Varerne bliver disponible igen.',
    checks: [chk('Disponibel med reservation', 60 * K, mid.available), chk('Reserveret efter annullering', 0, bq.reserved), chk('Disponibel efter annullering', 70 * K, bq.available)],
  });

  // 6. Mangel: 30 plader, 18 på lager
  await run('planlagt', async (tx) => void (await planMaterial(tx, await J(j2.id), await P_(C), 30 * K, 'Demoforløb')));
  const lines = async (jobId: number) =>
    (await db.prepare('SELECT * FROM purchase_lines WHERE job_id = ? AND product_id = ? AND cancelled = 0').bind(jobId, C).all<{ id: number; qty: number; ordered: number; received: number; ready: number; cancelled: number; list_id: number }>()).results;
  let c = await snap(C);
  let l2 = await lines(j2.id);
  const l1 = await lines(j1.id);
  let mats = await jobMaterials(db, j2.id);
  steps.push({
    title: 'Mangel: 30 plader, 18 på lager',
    text: 'Job 2 skal bruge 30 plader. 18 reserveres, og de 12, der mangler, kommer automatisk på job 2’s egen indkøbsliste.',
    checks: [
      chk('Reserveret til job 2', 18 * K, c.reserved),
      chk('Disponibel', 0, c.available),
      chk('Status', 'Ingen disponible varer', c.status),
      chk('Linjer på job 2’s liste', '1', String(l2.length)),
      chk('Mængde på linjen', 12 * K, l2[0]?.qty ?? 0),
      chk('Linjer på job 1’s lister', '0', String(l1.length)),
      chk('Jobstatus', 'Afventer materialer', mats.some((m) => m.waiting > 0) ? 'Afventer materialer' : 'Materialer klar'),
    ],
    link: { href: `/job/${j2.id}`, label: 'Se job 2' },
  });

  // 7. Ingen dubletter, og behovet ændres
  await run('afstem', (tx) => void tx.jobs.add(j2.id), null);
  const sameCount = (await lines(j2.id)).length;
  await run('behov', async (tx) => setPlanned(tx, await J(j2.id), await P_(C), 35 * K));
  l2 = await lines(j2.id);
  steps.push({
    title: 'Ingen dubletter, og behovet ændres',
    text: 'Indkøbsbehovet beregnes igen uden at lave en ny linje. Behovet hæves derefter til 35, og den samme linje opdateres til 17.',
    checks: [chk('Linjer efter genberegning', '1', String(sameCount)), chk('Linjer efter ændret behov', '1', String(l2.length)), chk('Mængde på linjen', 17 * K, l2[0]?.qty ?? 0)],
  });

  // 8. E-mail med indkøbslisten
  const list = (await getList(db, l2[0]!.list_id))!;
  const buyer =
    (await db.prepare("SELECT * FROM users WHERE active = 1 AND role IN ('indkober', 'ejer') ORDER BY role = 'indkober' DESC, id LIMIT 1").first<User>()) ??
    ({ email: actor.email, name: actor.name, role: 'ejer' } as User);
  const status = await sendPurchaseList(env, s, list, buyer, actor.email);
  const afterMail = (await lines(j2.id))[0]!;
  steps.push({
    title: 'Send indkøbslisten',
    text:
      status === 'sendt'
        ? `Listen er sendt på e-mail til ${buyer.email}.`
        : status === 'simuleret'
          ? `Simuleret: e-mail er ikke sat op, så listen er IKKE sendt til ${buyer.email}. Indholdet ligger i e-mail-loggen.`
          : `E-mailen til ${buyer.email} kunne ikke sendes.`,
    checks: [chk('Status på linjen efter afsendelse', 'Kladde', LINE_STATUS_LABEL[lineStatus(afterMail)])],
    link: { href: '/lager/indstillinger/mails', label: 'Se e-mail-loggen' },
  });

  // 9. Bestilling og delvis modtagelse
  await run('bestilling', async (tx) => registerOrder(tx, (await getLine(db, afterMail.id))!, 17 * K, addDays(todayDk(), 3), 'DEMO-1', null));
  const before = await snap(C);
  await run('modtagelse', async (tx) => receiveLine(tx, (await getLine(db, afterMail.id))!, 10 * K, null, true));
  c = await snap(C);
  const received = (await getLine(db, afterMail.id))!;
  steps.push({
    title: 'Bestilt 17, modtaget 10',
    text: 'Indkøberen registrerer bestillingen. Lageret ændres først, når varerne modtages; de 10 modtagne reserveres straks til job 2.',
    checks: [
      chk('Fysisk efter bestilling (før modtagelse)', 18 * K, before.stock),
      chk('Fysisk efter modtagelse', 28 * K, c.stock),
      chk('Reserveret til job 2', 28 * K, c.reserved),
      chk('Disponibel for andre', 0, c.available),
      chk('Linjestatus', 'Delvist modtaget', LINE_STATUS_LABEL[lineStatus(received)]),
    ],
  });

  // 10. Blokeret forbrug ud over det disponible
  const blocked = await run('forbrug', async (tx) => registerUse(tx, await J(j1.id), await P_(C), 5 * K));
  const c2 = await snap(C);
  steps.push({
    title: 'Forbrug ud over det disponible afvises',
    text: 'Job 1 forsøger at tage 5 plader, men alle plader er reserveret til job 2.',
    checks: [chk('Registreringen', 'Afvist', blocked.ok ? 'Gennemført' : 'Afvist'), chk('Fysisk uændret', 28 * K, c2.stock)],
  });
  if (!blocked.ok) steps[steps.length - 1]!.text += ` Fejlbesked: “${blocked.error}”`;

  // 11. Udlevering og retur
  await run('udlevering', async (tx) => issueReserved(tx, await J(j2.id), await P_(C), 28 * K));
  await run('retur', async (tx) => returnToStock(tx, await J(j2.id), await P_(C), 3 * K, 'Ubrugte plader'));
  c = await snap(C);
  mats = await jobMaterials(db, j2.id);
  const mc = mats.find((m) => m.product_id === C)!;
  steps.push({
    title: 'Udlevering og returnering',
    text: 'De 28 plader udleveres til job 2, og 3 ubrugte returneres til lageret. Returen trækkes fra jobbets forbrug.',
    checks: [chk('Fysisk', 3 * K, c.stock), chk('Jobbets nettoforbrug', 25 * K, mc.issued - mc.returned)],
  });

  // 12. Fakturakladde uden dobbelttælling
  const j2now = await J(j2.id);
  const items2 = await jobItems(db, j2.id, await preferredRetailerId(db, s));
  const draft = await buildDraft(db, j2now, items2, s, { mode: 'medgaaet', fixed: null }, actor, nowSec());
  const lines2 = (await db.prepare("SELECT * FROM invoice_items WHERE invoice_id = ? AND type = 'materiale'").bind(draft).all<{ qty: number; source_key: string }>()).results;
  // Kladden bygges igen: linjerne erstattes, de lægges ikke oven i
  await buildDraft(db, await J(j2.id), items2, s, { mode: 'medgaaet', fixed: null }, actor, nowSec());
  const again2 = (await db.prepare("SELECT COUNT(*) AS n FROM invoice_items WHERE invoice_id = ? AND type = 'materiale'").bind(draft).first<{ n: number }>())?.n ?? 0;
  steps.push({
    title: 'Fakturakladde uden dobbelttælling',
    text: 'Kladden bygger på forbruget (udleveret minus returneret), ikke på indkøbet. Plader, der både er købt og brugt, tælles kun én gang, og bygges kladden igen, erstattes linjerne i stedet for at blive lagt oven i. Kladden er ikke udstedt.',
    checks: [chk('Materialelinjer på kladden', '1', String(lines2.length)), chk('Mængde på linjen', 25 * K, lines2[0]?.qty ?? 0), chk('Materialelinjer efter ny kladde', '1', String(again2))],
    link: { href: `/job/faktura/${draft}`, label: 'Se fakturakladden' },
  });

  return steps;
}
