// Grundlag for fakturering af materialer på et job.
//
// Grundlaget bygger på det faktiske forbrug, ikke på indkøbslisterne, så en vare aldrig tæller to
// gange, fordi den både er købt og senere registreret som brugt:
//   lager:        udleveret eller brugt fra hovedlageret minus returneret (også varer købt til jobbet)
//   arbejdssted:  varer leveret direkte til arbejdsstedet, når de er registreret som brugt
//   direkte:      varer uden varenummer, købt til jobbet (følges kun som indkøb)
// Det, der allerede er godkendt på et tidligere fakturagrundlag, trækkes fra, så intet faktureres to gange.

import type { InvoiceBasisRow, InvoiceLineRow, JobRow } from '../env';
import { formatKr, formatQty, lineAmount } from './format';
import type { Settings } from './settings';
import { Conflict } from './ledger';

export interface ConsumptionLine {
  source: InvoiceLineRow['source'];
  product_id: number | null;
  purchase_line_id: number | null;
  sku: string;
  name: string;
  unit: string;
  qty: number;
  unit_cost: number | null;
  sale_price: number | null;
}

export const SOURCE_LABEL: Record<InvoiceLineRow['source'], string> = {
  lager: 'Fra lager',
  arbejdssted: 'Leveret til arbejdssted',
  direkte: 'Købt direkte til jobbet',
};

/** Gennemsnitlig pris pr. enhed ud fra mængder og beløb (øre). */
function avg(cost: number, qty: number): number {
  return qty > 0 ? Math.round((cost * 1000) / qty) : 0;
}

export async function jobConsumption(db: D1Database, jobId: number): Promise<ConsumptionLine[]> {
  const [{ results: mats }, { results: moves }, { results: direct }] = await Promise.all([
    db
      .prepare(
        `SELECT m.product_id, m.issued, m.returned, m.site_used, p.sku, p.name, p.unit, p.purchase_price, p.sale_price
         FROM job_materials m JOIN products p ON p.id = m.product_id WHERE m.job_id = ? ORDER BY p.name`,
      )
      .bind(jobId)
      .all<{ product_id: number; issued: number; returned: number; site_used: number; sku: string; name: string; unit: string; purchase_price: number | null; sale_price: number | null }>(),
    db
      .prepare(
        `SELECT product_id, kind, SUM(qty) AS qty, SUM(qty * unit_cost) AS cost, SUM(CASE WHEN unit_cost IS NULL THEN qty ELSE 0 END) AS unknown_qty FROM movements
         WHERE job_id = ? AND product_id IS NOT NULL AND kind IN ('forbrug', 'udlevering', 'retur', 'arbejdssted_modtaget')
         GROUP BY product_id, kind`,
      )
      .bind(jobId)
      .all<{ product_id: number; kind: string; qty: number; cost: number | null; unknown_qty: number }>(),
    db
      .prepare(
        `SELECT id, sku, name, unit, received, COALESCE(actual_price, unit_price) AS price FROM purchase_lines
         WHERE job_id = ? AND product_id IS NULL AND received > 0 ORDER BY name`,
      )
      .bind(jobId)
      .all<{ id: number; sku: string; name: string; unit: string; received: number; price: number | null }>(),
  ]);
  const mv = (pid: number, kind: string) => moves.find((m) => m.product_id === pid && m.kind === kind);
  const out: ConsumptionLine[] = [];
  for (const m of mats) {
    const net = m.issued - m.returned;
    if (net > 0) {
      const out1 = [mv(m.product_id, 'forbrug'), mv(m.product_id, 'udlevering')];
      const qtyOut = out1.reduce((s, x) => s + (x?.qty ?? 0), 0);
      const costOut = out1.reduce((s, x) => s + (x?.cost ?? 0), 0);
      const unknown = out1.some((x) => x && x.unknown_qty > 0);
      const unitCost = qtyOut > 0 && !unknown ? avg(costOut / 1000, qtyOut) : null;
      out.push({ source: 'lager', product_id: m.product_id, purchase_line_id: null, sku: m.sku, name: m.name, unit: m.unit, qty: net, unit_cost: unitCost, sale_price: m.sale_price });
    }
    if (m.site_used > 0) {
      const rec = mv(m.product_id, 'arbejdssted_modtaget');
      const unitCost = rec && rec.qty > 0 && rec.unknown_qty === 0 && rec.cost !== null ? avg(rec.cost / 1000, rec.qty) : null;
      out.push({ source: 'arbejdssted', product_id: m.product_id, purchase_line_id: null, sku: m.sku, name: m.name, unit: m.unit, qty: m.site_used, unit_cost: unitCost, sale_price: m.sale_price });
    }
  }
  for (const d of direct) {
    out.push({ source: 'direkte', product_id: null, purchase_line_id: d.id, sku: d.sku, name: d.name, unit: d.unit, qty: d.received, unit_cost: d.price, sale_price: null });
  }
  return out;
}

function key(l: Pick<ConsumptionLine, 'source' | 'product_id' | 'purchase_line_id'>): string {
  return `${l.source}:${l.product_id ?? ''}:${l.purchase_line_id ?? ''}`;
}

/** Forbrug, der endnu ikke er med på et godkendt fakturagrundlag. */
export async function uninvoiced(db: D1Database, jobId: number): Promise<ConsumptionLine[]> {
  const cons = await jobConsumption(db, jobId);
  const { results } = await db
    .prepare(
      `SELECT l.source, l.product_id, l.purchase_line_id, SUM(l.qty) AS qty FROM invoice_lines l JOIN invoice_bases b ON b.id = l.basis_id
       WHERE b.job_id = ? AND b.status = 'godkendt' AND l.include = 1 GROUP BY l.source, l.product_id, l.purchase_line_id`,
    )
    .bind(jobId)
    .all<{ source: InvoiceLineRow['source']; product_id: number | null; purchase_line_id: number | null; qty: number }>();
  const done = new Map(results.map((r) => [key(r), r.qty]));
  return cons.map((c) => ({ ...c, qty: c.qty - (done.get(key(c)) ?? 0) })).filter((c) => c.qty > 0);
}

export function salePrice(c: Pick<ConsumptionLine, 'unit_cost' | 'sale_price'>, markupPct: number): number | null {
  return c.sale_price ?? (c.unit_cost === null ? null : Math.round(c.unit_cost * (1 + markupPct / 100)));
}

export function customerSnapshot(job: JobRow): string {
  return JSON.stringify({
    number: job.number,
    name: job.name,
    customer_name: job.customer_name,
    customer_email: job.customer_email,
    customer_phone: job.customer_phone,
    customer_address: job.customer_address,
    site_address: job.site_address,
  });
}

export type Customer = {
  number: string;
  name: string;
  customer_name: string;
  customer_email: string;
  customer_phone: string;
  customer_address: string;
  site_address: string;
};

export function parseCustomer(raw: string): Customer {
  try {
    return { number: '', name: '', customer_name: '', customer_email: '', customer_phone: '', customer_address: '', site_address: '', ...JSON.parse(raw) };
  } catch {
    return { number: '', name: '', customer_name: '', customer_email: '', customer_phone: '', customer_address: '', site_address: '' };
  }
}

/** Opretter (eller genopretter) jobbets kladde ud fra det forbrug, der ikke er faktureret. */
export async function createDraft(db: D1Database, job: JobRow, s: Settings, actor: string, now: number): Promise<number> {
  const lines = await uninvoiced(db, job.id);
  const markup = job.markup_pct ?? s.default_markup_pct;
  if (lines.some((l) => l.unit_cost === null || salePrice(l, markup) === null)) {
    throw new Conflict('Historisk kostpris mangler. Brug Job → Faktura, hvor manglende priser kan gennemgås i kladden.');
  }
  const basis = await db
    .prepare(
      `INSERT INTO invoice_bases (job_id, customer, created_by, created_at) VALUES (?, ?, ?, ?)
       ON CONFLICT(job_id) WHERE status = 'kladde' DO UPDATE SET customer = excluded.customer RETURNING id`,
    )
    .bind(job.id, customerSnapshot(job), actor, now)
    .first<{ id: number }>();
  const id = basis!.id;
  const stmts = [db.prepare('DELETE FROM invoice_lines WHERE basis_id = ?').bind(id)];
  lines.forEach((l, i) =>
    stmts.push(
      db
        .prepare(
          `INSERT INTO invoice_lines (basis_id, source, product_id, purchase_line_id, sku, name, unit, qty, unit_cost, unit_price, include, sort_order)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)`,
        )
        .bind(id, l.source, l.product_id, l.purchase_line_id, l.sku, l.name, l.unit, l.qty, l.unit_cost, salePrice(l, markup), i),
    ),
  );
  await db.batch(stmts);
  return id;
}

export function totals(lines: Pick<InvoiceLineRow, 'qty' | 'unit_cost' | 'unit_price' | 'include'>[]): { cost: number; sale: number } {
  let cost = 0;
  let sale = 0;
  for (const l of lines) {
    if (!l.include) continue;
    cost += lineAmount(l.unit_cost, l.qty);
    sale += lineAmount(l.unit_price, l.qty);
  }
  return { cost, sale };
}

export async function getBasis(db: D1Database, id: number): Promise<{ basis: InvoiceBasisRow; lines: InvoiceLineRow[] } | null> {
  const basis = await db.prepare('SELECT * FROM invoice_bases WHERE id = ?').bind(id).first<InvoiceBasisRow>();
  if (!basis) return null;
  const { results } = await db.prepare('SELECT * FROM invoice_lines WHERE basis_id = ? ORDER BY sort_order, id').bind(id).all<InvoiceLineRow>();
  return { basis, lines: results };
}

function csvCell(v: string): string {
  return /[";\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
}

function kr(oere: number): string {
  return (oere / 100).toFixed(2).replace('.', ',');
}

/** CSV (semikolon og decimalkomma, så det åbner direkte i dansk Excel). */
export function basisCsv(basis: InvoiceBasisRow, lines: InvoiceLineRow[], s: Settings): string {
  const c = parseCustomer(basis.customer);
  const head = [
    ['Fakturagrundlag', `${s.company_name}`],
    ['Job', `${c.number} ${c.name}`],
    ['Kunde', c.customer_name],
    ['Kundeadresse', c.customer_address],
    ['Arbejdsadresse', c.site_address],
    ['E-mail', c.customer_email],
    ['Telefon', c.customer_phone],
    ['Status', basis.status === 'godkendt' ? `Godkendt ${new Date((basis.approved_at ?? 0) * 1000).toISOString().slice(0, 10)} af ${basis.approved_by}` : 'Kladde (ikke godkendt)'],
    [],
    ['Varenr.', 'Vare', 'Kilde', 'Mængde', 'Enhed', 'Kostpris pr. enhed', 'Salgspris pr. enhed', 'Kostpris i alt', 'Salgspris i alt', 'Faktureres'],
  ];
  const rows = lines.map((l) => [
    l.sku,
    l.name,
    SOURCE_LABEL[l.source],
    formatQty(l.qty).replace(/\./g, ''),
    l.unit,
    kr(l.unit_cost),
    kr(l.unit_price),
    kr(lineAmount(l.unit_cost, l.qty)),
    kr(lineAmount(l.unit_price, l.qty)),
    l.include ? 'Ja' : 'Nej',
  ]);
  const t = totals(lines);
  const foot = [[], ['I alt (faktureres)', '', '', '', '', '', '', kr(t.cost), kr(t.sale), '']];
  return '﻿' + [...head, ...rows, ...foot].map((r) => r.map((v) => csvCell(String(v))).join(';')).join('\r\n') + '\r\n';
}

export { formatKr, formatQty };
