// Rapporter over kassesalg. Alle tal beregnes fra databasen: gennemførte (betalte) kassesalg i perioden
// og refusioner gennemført i perioden. Salg, der afventer betaling eller er annulleret, tæller ikke med.
// Beløb er inkl. moms; momsen er den, der står på salget (og for refusioner beregnet med salgets momssats).
import { vatOf } from './calc';

const TZ = 'Europe/Copenhagen';

/** Dato (YYYY-MM-DD) i dansk tid for et tidspunkt. */
export function localDate(unixSec: number): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(unixSec * 1000));
}

function tzOffsetSec(at: Date): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: TZ,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(at);
  const n = (t: string) => Number(parts.find((p) => p.type === t)!.value);
  const asUtc = Date.UTC(n('year'), n('month') - 1, n('day'), n('hour'), n('minute'), n('second'));
  return Math.round((asUtc - at.getTime()) / 1000);
}

/** Midnat i dansk tid for en dato (YYYY-MM-DD) som Unix-tid. */
export function dayStart(date: string): number {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  const guess = Date.UTC(y, m - 1, d) / 1000;
  const off = tzOffsetSec(new Date(guess * 1000));
  const t = guess - off;
  // Rettelse omkring skift til/fra sommertid
  return guess - tzOffsetSec(new Date(t * 1000));
}

export function isDate(s: unknown): s is string {
  return typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(s + 'T00:00:00Z'));
}

export function addDays(date: string, n: number): string {
  const d = new Date(date + 'T12:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

export interface Report {
  from: string;
  to: string;
  sales: { count: number; gross: number; discount: number; total: number; vat: number };
  refunds: { count: number; amount: number; vat: number };
  net: number;
  netVat: number;
  average: number;
  methods: { label: string; method: string; count: number; amount: number; refunded: number }[];
  products: { sku: string; name: string; quantity: number; amount: number; refundedQty: number }[];
  staff: { email: string; count: number; total: number; refunded: number }[];
  days: { date: string; total: number; refunds: number; count: number }[];
  cash: { sales: number; received: number; change: number; refunds: number; rounding: number; net: number };
}

/** Rapport for datoerne from..to (begge inklusive, dansk tid). */
export async function buildReport(db: D1Database, from: string, to: string): Promise<Report> {
  const start = dayStart(from);
  const end = dayStart(addDays(to, 1));
  // Gennemførte salg: betalt (også hvis de senere er refunderet). Afventende og annullerede tæller ikke.
  const DONE = `s.status IN ('betalt', 'delvist_refunderet', 'refunderet') AND s.created_at >= ?1 AND s.created_at < ?2`;
  const SALES = `FROM pos_sales s WHERE ${DONE}`;
  const REFUNDS = `FROM pos_refunds r JOIN pos_sales s ON s.id = r.sale_id
    WHERE r.status = 'gennemfoert' AND r.created_at >= ?1 AND r.created_at < ?2`;
  const [sales, refunds, methods, refundMethods, products, refundedProducts, staff, staffRefunds, rows, refundRows, cash, cashRefunds] = await db.batch([
    db.prepare(`SELECT COUNT(*) AS count, COALESCE(SUM(s.subtotal), 0) AS gross, COALESCE(SUM(s.discount), 0) AS discount,
      COALESCE(SUM(s.total + s.rounding), 0) AS total, COALESCE(SUM(s.vat_amount), 0) AS vat ${SALES}`).bind(start, end),
    db.prepare(`SELECT COUNT(*) AS count, COALESCE(SUM(r.amount), 0) AS amount,
      COALESCE(SUM(ROUND(r.amount * s.vat_rate_bp * 1.0 / (10000 + s.vat_rate_bp))), 0) AS vat ${REFUNDS}`).bind(start, end),
    db.prepare(`SELECT p.label, p.method, COUNT(*) AS count, SUM(p.amount) AS amount
      FROM pos_payments p JOIN pos_sales s ON s.id = p.sale_id
      WHERE p.status = 'gennemfoert' AND ${DONE}
      GROUP BY p.method, p.label ORDER BY amount DESC`).bind(start, end),
    db.prepare(`SELECT rp.label, rp.method, SUM(rp.amount) AS amount FROM pos_refund_payments rp JOIN pos_refunds r ON r.id = rp.refund_id
      WHERE rp.status = 'gennemfoert' AND r.status = 'gennemfoert' AND r.created_at >= ?1 AND r.created_at < ?2 GROUP BY rp.method, rp.label`).bind(start, end),
    db.prepare(`SELECT l.sku, l.name, SUM(l.quantity) AS quantity, SUM(l.line_total - l.line_discount - l.order_discount) AS amount
      FROM pos_sale_lines l JOIN pos_sales s ON s.id = l.sale_id
      WHERE ${DONE}
      GROUP BY l.sku, l.name ORDER BY quantity DESC, amount DESC LIMIT 15`).bind(start, end),
    db.prepare(`SELECT l.sku, l.name, SUM(rl.quantity) AS quantity FROM pos_refund_lines rl JOIN pos_refunds r ON r.id = rl.refund_id
      JOIN pos_sale_lines l ON l.id = rl.sale_line_id
      WHERE r.status = 'gennemfoert' AND r.created_at >= ?1 AND r.created_at < ?2 GROUP BY l.sku, l.name`).bind(start, end),
    db.prepare(`SELECT s.staff_email AS email, COUNT(*) AS count, SUM(s.total + s.rounding) AS total ${SALES} GROUP BY s.staff_email ORDER BY total DESC`).bind(start, end),
    db.prepare(`SELECT s.staff_email AS email, SUM(r.amount) AS amount ${REFUNDS} GROUP BY s.staff_email`).bind(start, end),
    db.prepare(`SELECT s.created_at, s.total + s.rounding AS total ${SALES}`).bind(start, end),
    db.prepare(`SELECT r.created_at, r.amount ${REFUNDS}`).bind(start, end),
    db.prepare(`SELECT COALESCE(SUM(p.amount), 0) AS sales, COALESCE(SUM(p.received), 0) AS received, COALESCE(SUM(p.change_given), 0) AS change,
      (SELECT COALESCE(SUM(s.rounding), 0) ${SALES}) AS rounding
      FROM pos_payments p JOIN pos_sales s ON s.id = p.sale_id
      WHERE p.method = 'kontant' AND p.status = 'gennemfoert' AND ${DONE}`).bind(start, end),
    db.prepare(`SELECT COALESCE(SUM(rp.amount), 0) AS amount FROM pos_refund_payments rp JOIN pos_refunds r ON r.id = rp.refund_id
      WHERE rp.method = 'kontant' AND rp.status = 'gennemfoert' AND r.status = 'gennemfoert' AND r.created_at >= ?1 AND r.created_at < ?2`).bind(start, end),
  ]);
  type R<T> = { results: T[] };
  const sal = (sales as R<Report['sales']>).results[0]!;
  const ref = (refunds as R<{ count: number; amount: number; vat: number }>).results[0]!;
  const refByMethod = new Map((refundMethods as R<{ label: string; method: string; amount: number }>).results.map((r) => [`${r.method}|${r.label}`, r.amount]));
  const methodRows = (methods as R<{ label: string; method: string; count: number; amount: number }>).results.map((m) => ({
    ...m,
    refunded: refByMethod.get(`${m.method}|${m.label}`) ?? 0,
  }));
  // Refusioner på en betalingsform uden salg i perioden (salget lå før perioden)
  for (const [k, amount] of refByMethod) {
    if (!methodRows.some((m) => `${m.method}|${m.label}` === k)) {
      const [method, label] = k.split('|') as [string, string];
      methodRows.push({ label, method, count: 0, amount: 0, refunded: amount });
    }
  }
  const refQty = new Map((refundedProducts as R<{ sku: string; name: string; quantity: number }>).results.map((r) => [`${r.sku}|${r.name}`, r.quantity]));
  const staffRef = new Map((staffRefunds as R<{ email: string; amount: number }>).results.map((r) => [r.email, r.amount]));
  const dayMap = new Map<string, { date: string; total: number; refunds: number; count: number }>();
  for (let d = from; d <= to; d = addDays(d, 1)) dayMap.set(d, { date: d, total: 0, refunds: 0, count: 0 });
  for (const r of (rows as R<{ created_at: number; total: number }>).results) {
    const x = dayMap.get(localDate(r.created_at));
    if (x) {
      x.total += r.total;
      x.count++;
    }
  }
  for (const r of (refundRows as R<{ created_at: number; amount: number }>).results) {
    const x = dayMap.get(localDate(r.created_at));
    if (x) x.refunds += r.amount;
  }
  const c = (cash as R<{ sales: number; received: number; change: number; rounding: number }>).results[0]!;
  const cr = (cashRefunds as R<{ amount: number }>).results[0]!.amount;
  return {
    from,
    to,
    sales: sal,
    refunds: ref,
    net: sal.total - ref.amount,
    netVat: sal.vat - ref.vat,
    average: sal.count ? Math.round(sal.total / sal.count) : 0,
    methods: methodRows,
    products: (products as R<{ sku: string; name: string; quantity: number; amount: number }>).results.map((p) => ({ ...p, refundedQty: refQty.get(`${p.sku}|${p.name}`) ?? 0 })),
    staff: (staff as R<{ email: string; count: number; total: number }>).results.map((s) => ({ ...s, refunded: staffRef.get(s.email) ?? 0 })),
    days: [...dayMap.values()],
    cash: { sales: c.sales, received: c.received, change: c.change, refunds: cr, rounding: c.rounding, net: c.sales - cr },
  };
}

export { vatOf };
