// Kassesalg: oprettelse, kortbetaling, annullering, refusion og opslag.
// Alt, der ændrer lager eller betaling, sker i én databasebatch (transaktion), og priser, rabatter og
// moms beregnes altid her på serveren ud fra databasen, aldrig ud fra det, browseren sender.
import type { Env } from '../../env';
import { nowSec } from '../crypto';
import { rateLimit } from '../db';
import { calcSale, refundShare, roundCash, type Discount } from './calc';
import { getItemsByIds, isConstraintError, type PosItemRow } from './items';
import { methodOptions, stripeReady, vatBp, type MethodOption, type PaymentMethod, type PosSettings } from './settings';
import { can, getStaff, verifyPin, type Role, type StaffInfo } from './staff';
import * as stripe from './stripe';
import { isAdmin } from '../session';

export type SaleStatus = 'afventer' | 'betalt' | 'delvist_refunderet' | 'refunderet' | 'annulleret';

export const SALE_STATUS_LABEL: Record<SaleStatus, string> = {
  afventer: 'Afventer betaling',
  betalt: 'Betalt',
  delvist_refunderet: 'Delvist refunderet',
  refunderet: 'Refunderet',
  annulleret: 'Annulleret',
};

export const SALE_STATUSES = Object.keys(SALE_STATUS_LABEL) as SaleStatus[];

export const METHOD_LABEL: Record<PaymentMethod, string> = {
  kontant: 'Kontant',
  kort_terminal: 'Kort (terminal)',
  stripe_terminal: 'Kort (Stripe)',
  andet: 'Andet',
};

export interface PosSaleRow {
  id: number;
  number: number;
  client_key: string;
  source: string;
  status: SaleStatus;
  staff_email: string;
  customer_id: number | null;
  customer_name: string;
  customer_email: string;
  customer_phone: string;
  company: string;
  note: string;
  subtotal: number;
  discount: number;
  total: number;
  vat_amount: number;
  vat_rate_bp: number;
  rounding: number;
  order_discount_type: 'pct' | 'amount' | null;
  order_discount_value: number | null;
  discount_approved_by: string | null;
  refunded: number;
  stock_deducted: number;
  completed_at: number | null;
  created_at: number;
  updated_at: number;
}

export interface PosSaleLineRow {
  id: number;
  sale_id: number;
  item_id: number | null;
  sku: string;
  name: string;
  unit: string;
  unit_price: number;
  quantity: number;
  line_total: number;
  line_discount: number;
  order_discount: number;
  track_stock: number;
}

export interface PosPaymentRow {
  id: number;
  sale_id: number;
  method: PaymentMethod;
  label: string;
  amount: number;
  received: number | null;
  change_given: number | null;
  status: 'afventer' | 'gennemfoert' | 'fejlet' | 'annulleret';
  reference: string;
  provider_ref: string | null;
  error: string | null;
  actor: string;
  created_at: number;
  updated_at: number;
}

export interface PosRefundRow {
  id: number;
  sale_id: number;
  client_key: string;
  amount: number;
  status: 'afventer' | 'gennemfoert' | 'fejlet';
  restock: number;
  reason: string;
  error: string | null;
  actor: string;
  approved_by: string | null;
  created_at: number;
}

export interface PosRefundPaymentRow {
  id: number;
  refund_id: number;
  payment_id: number;
  method: PaymentMethod;
  label: string;
  amount: number;
  status: 'afventer' | 'gennemfoert' | 'fejlet';
  provider_ref: string | null;
  error: string | null;
}

export interface PosRefundLineRow {
  refund_id: number;
  sale_line_id: number;
  quantity: number;
  amount: number;
}

export interface SaleEventRow {
  id: number;
  message: string;
  actor: string;
  created_at: number;
}

/** Salgets id i en batch, før det kendes (nøglen er valideret som [A-Za-z0-9_-]) */
function refByKey(key: string): string {
  return `(SELECT id FROM pos_sales WHERE client_key = '${key.replace(/[^A-Za-z0-9_-]/g, '')}')`;
}

function refById(id: number): string {
  return String(Math.trunc(id));
}

// ---------------- Ydelser, varer og kunder til kassen ----------------

export interface PosProduct {
  id: number;
  sku: string;
  barcode: string;
  name: string;
  category: string;
  unit: string;
  price: number;
  image: string;
  /** null = ingen lagerstyring (kan altid sælges) */
  available: number | null;
}

export async function posProducts(db: D1Database, s: PosSettings): Promise<PosProduct[]> {
  const { results } = await db
    .prepare(
      `SELECT id, sku, barcode, name, category, unit, price, track_stock, stock, image_type IS NOT NULL AS has_image, updated_at FROM pos_items
       WHERE active = 1 ORDER BY category COLLATE NOCASE, sort_order, name COLLATE NOCASE LIMIT 5000`,
    )
    .all<PosItemRow & { has_image: number }>();
  const out: PosProduct[] = [];
  for (const p of results) {
    const available = p.track_stock ? Math.max(0, p.stock) : null;
    if (!s.show_out_of_stock && available === 0) continue;
    out.push({
      id: p.id,
      sku: p.sku,
      barcode: p.barcode ?? '',
      name: p.name,
      category: p.category,
      unit: p.unit,
      price: p.price,
      image: p.has_image ? `/admin/kasse/varer/${p.id}/billede?v=${p.updated_at}` : '',
      available,
    });
  }
  return out;
}

export interface CustomerHit {
  id: number | null;
  name: string;
  email: string;
  phone: string;
  company: string;
}

/** Kunder fra Veyros kundeliste og fra tidligere kassesalg, så de kan vælges igen. */
export async function searchCustomers(db: D1Database, q: string): Promise<CustomerHit[]> {
  const like = '%' + q.replace(/[\\%_]/g, (m) => '\\' + m) + '%';
  const digits = q.replace(/\D/g, '');
  const phone = digits.length >= 3 ? digits : '';
  const [known, earlier] = await db.batch([
    db
      .prepare(
        `SELECT id, COALESCE(name, '') AS name, email, COALESCE(phone, '') AS phone, COALESCE(company, '') AS company FROM customers
         WHERE name LIKE ?1 ESCAPE '\\' OR email LIKE ?1 ESCAPE '\\' OR company LIKE ?1 ESCAPE '\\' OR cvr LIKE ?1 ESCAPE '\\'
           OR (?2 <> '' AND REPLACE(REPLACE(COALESCE(phone, ''), ' ', ''), '-', '') LIKE '%' || ?2 || '%')
         ORDER BY updated_at DESC LIMIT 8`,
      )
      .bind(like, phone),
    db
      .prepare(
        `SELECT NULL AS id, customer_name AS name, customer_email AS email, customer_phone AS phone, company, MAX(created_at) AS last FROM pos_sales
         WHERE customer_id IS NULL AND (customer_name <> '' OR company <> '') AND (customer_name LIKE ?1 ESCAPE '\\' OR customer_email LIKE ?1 ESCAPE '\\'
           OR company LIKE ?1 ESCAPE '\\' OR (?2 <> '' AND REPLACE(REPLACE(customer_phone, ' ', ''), '-', '') LIKE '%' || ?2 || '%'))
         GROUP BY LOWER(customer_email), customer_phone, LOWER(customer_name), LOWER(company) ORDER BY last DESC LIMIT 8`,
      )
      .bind(like, phone),
  ]);
  const out = (known!.results as CustomerHit[]).slice();
  for (const r of earlier!.results as CustomerHit[]) {
    if (r.email && out.some((x) => x.email.toLowerCase() === r.email.toLowerCase())) continue;
    out.push({ id: null, name: r.name, email: r.email, phone: r.phone, company: r.company });
  }
  return out.slice(0, 12);
}

// ---------------- Revisionslog ----------------

export function auditStatement(
  db: D1Database,
  a: { action: string; saleRef?: string | null; detail?: string; actor: string; approvedBy?: string | null; now: number },
): D1PreparedStatement {
  return db
    .prepare(`INSERT INTO pos_audit (action, sale_id, detail, actor, approved_by, created_at) VALUES (?, ${a.saleRef ?? 'NULL'}, ?, ?, ?, ?)`)
    .bind(a.action, a.detail ?? '', a.actor, a.approvedBy ?? null, a.now);
}

export async function audit(db: D1Database, a: { action: string; saleId?: number | null; detail?: string; actor: string; approvedBy?: string | null }): Promise<void> {
  await auditStatement(db, { ...a, saleRef: a.saleId ? refById(a.saleId) : null, now: nowSec() }).run();
}

export interface AuditRow {
  id: number;
  action: string;
  sale_id: number | null;
  sale_number: number | null;
  detail: string;
  actor: string;
  approved_by: string | null;
  created_at: number;
}

export async function listAudit(db: D1Database, limit: number): Promise<AuditRow[]> {
  const { results } = await db
    .prepare('SELECT a.*, s.number AS sale_number FROM pos_audit a LEFT JOIN pos_sales s ON s.id = a.sale_id ORDER BY a.created_at DESC, a.id DESC LIMIT ?')
    .bind(limit)
    .all<AuditRow>();
  return results;
}

function eventStatement(db: D1Database, saleRef: string, message: string, actor: string, now: number): D1PreparedStatement {
  return db.prepare(`INSERT INTO pos_sale_events (sale_id, message, actor, created_at) VALUES (${saleRef}, ?, ?, ?)`).bind(message, actor, now);
}

// ---------------- Godkendelse (PIN) ----------------

export function maxDiscountBp(role: Role, s: PosSettings): number {
  if (role === 'admin') return 10000;
  return Math.round((role === 'manager' ? s.manager_max_discount : s.cashier_max_discount) * 100);
}

export type ApprovalResult = { ok: true; email: string; role: Role } | { ok: false; reason: 'invalid' | 'rate' | 'role' };

/**
 * Tjekker en godkendelse med en anden medarbejders e-mail og PIN-kode.
 * Forsøg tælles pr. e-mail (5 pr. 15 minutter), så en PIN ikke kan gættes.
 */
export async function checkApproval(env: Env, email: string, pin: string, ok: (role: Role) => boolean): Promise<ApprovalResult> {
  const e = email.trim().toLowerCase();
  if (!(await rateLimit(env.DB, 'pin:' + e, 5, 15 * 60))) return { ok: false, reason: 'rate' };
  const row = await getStaff(env.DB, e);
  if (!row || !(await verifyPin(pin, row.pin_hash))) return { ok: false, reason: 'invalid' };
  const role: Role = isAdmin(env, e) ? 'admin' : row.role;
  if (!row.active && role !== 'admin') return { ok: false, reason: 'invalid' };
  if (!ok(role)) return { ok: false, reason: 'role' };
  return { ok: true, email: e, role };
}

// ---------------- Opret salg ----------------

export interface SaleLineInput {
  itemId: number;
  quantity: number;
  discount: Discount | null;
}

export interface SalePaymentInput {
  key: string;
  /** Beløb i øre (ikke kontant; kontant dækker resten) */
  amount: number;
  /** Kontant modtaget (øre) */
  received?: number;
  reference?: string;
}

export interface CustomerInput {
  id: number | null;
  name: string;
  email: string;
  phone: string;
  company: string;
}

export interface CreateSaleInput {
  key: string;
  staff: StaffInfo;
  lines: SaleLineInput[];
  orderDiscount: Discount | null;
  customer: CustomerInput;
  note: string;
  payments: SalePaymentInput[];
  expectedTotal: number;
  approval?: { email: string; pin: string } | null;
}

export interface ShortLine {
  itemId: number;
  name: string;
  quantity: number;
  available: number;
}

export type CreateSaleResult =
  | { ok: true; saleId: number; existing?: boolean; stripeError?: string }
  | {
      ok: false;
      code: 'empty' | 'invalid' | 'unknown_product' | 'price_changed' | 'stock' | 'approval_required' | 'approval_invalid' | 'approval_rate' | 'payment' | 'cash_short';
      message: string;
      short?: ShortLine[];
      total?: number;
    };

async function existingSale(db: D1Database, key: string): Promise<number | null> {
  const r = await db.prepare('SELECT id FROM pos_sales WHERE client_key = ?').bind(key).first<{ id: number }>();
  return r?.id ?? null;
}

export interface PlannedPayment {
  opt: MethodOption;
  amount: number;
  received: number | null;
  change: number | null;
  reference: string;
}

/** Validerer betalingerne mod totalen. Kontant dækker altid resten og afrundes til 50 øre. */
export function planPayments(
  total: number,
  input: SalePaymentInput[],
  options: MethodOption[],
  s: PosSettings,
): { ok: true; rows: PlannedPayment[]; rounding: number } | { ok: false; code: 'payment' | 'cash_short'; message: string } {
  const fail = (message: string, code: 'payment' | 'cash_short' = 'payment') => ({ ok: false as const, code, message });
  if (input.length > 6) return fail('Højst 6 betalinger pr. salg.');
  const rows: PlannedPayment[] = [];
  let cash: SalePaymentInput | null = null;
  let stripeCount = 0;
  let nonCash = 0;
  for (const p of input) {
    const opt = options.find((o) => o.key === p.key);
    if (!opt) return fail('Betalingsformen findes ikke eller er slået fra. Genindlæs kassen.');
    if (opt.method === 'kontant') {
      if (cash) return fail('Kontant kan kun bruges én gang pr. salg.');
      cash = p;
      continue;
    }
    if (opt.method === 'stripe_terminal' && ++stripeCount > 1) return fail('Der kan kun være én kortbetaling på kortlæseren pr. salg.');
    if (!Number.isSafeInteger(p.amount) || p.amount <= 0) return fail(`Skriv et beløb for ${opt.label}.`);
    nonCash += p.amount;
    rows.push({ opt, amount: p.amount, received: null, change: null, reference: (p.reference ?? '').slice(0, 60) });
  }
  if (nonCash > total) return fail('Betalingerne er større end beløbet.');
  let rounding = 0;
  if (cash) {
    const due = total - nonCash;
    if (due <= 0) return fail('Der er intet tilbage at betale kontant.');
    const amount = s.cash_rounding ? roundCash(due) : due;
    rounding = amount - due;
    const received = cash.received === undefined || cash.received === null ? amount : cash.received;
    if (!Number.isSafeInteger(received) || received < amount) return fail('Det modtagne kontantbeløb er for lille.', 'cash_short');
    if (received > amount + 10_000_00) return fail('Det modtagne kontantbeløb er urealistisk stort. Tjek beløbet.', 'cash_short');
    if (amount > 0) {
      const opt = options.find((o) => o.key === 'kontant')!;
      rows.push({ opt, amount, received, change: received - amount, reference: '' });
    }
  } else if (nonCash !== total) {
    return fail('Betalingerne dækker ikke hele beløbet.');
  }
  return { ok: true, rows, rounding };
}

/** Lagertræk (dir = -1) eller tilbagelægning (dir = 1) for et salgs linjer med lagerstyring, med historik. */
function stockStatements(db: D1Database, saleRef: string, dir: 1 | -1, actor: string, now: number, reason: string): D1PreparedStatement[] {
  return [
    // Historikken skrives først (med lageret efter ændringen), derefter ændres lageret.
    // Bliver lageret negativt, fejler CHECK (stock >= 0), og hele batchen rulles tilbage.
    db
      .prepare(
        `INSERT INTO pos_stock_movements (item_id, change, stock_after, reason, sale_id, actor, created_at)
         SELECT i.id, ${dir} * l.quantity, i.stock + ${dir} * l.quantity, ?, ${saleRef}, ?, ?
         FROM pos_sale_lines l JOIN pos_items i ON i.id = l.item_id
         WHERE l.sale_id = ${saleRef} AND l.track_stock = 1 AND i.track_stock = 1`,
      )
      .bind(reason, actor, now),
    db
      .prepare(
        `UPDATE pos_items SET stock = stock + ${dir} * (SELECT SUM(l.quantity) FROM pos_sale_lines l WHERE l.sale_id = ${saleRef} AND l.item_id = pos_items.id AND l.track_stock = 1), updated_at = ?
         WHERE track_stock = 1 AND id IN (SELECT item_id FROM pos_sale_lines WHERE sale_id = ${saleRef} AND track_stock = 1)`,
      )
      .bind(now),
  ];
}

export async function createSale(env: Env, s: PosSettings, input: CreateSaleInput): Promise<CreateSaleResult> {
  const db = env.DB;
  const prev = await existingSale(db, input.key);
  if (prev) return { ok: true, saleId: prev, existing: true };
  if (!input.lines.length) return { ok: false, code: 'empty', message: 'Kurven er tom.' };
  if (input.lines.length > 200) return { ok: false, code: 'invalid', message: 'Højst 200 linjer pr. salg.' };
  if (new Set(input.lines.map((l) => l.itemId)).size !== input.lines.length) {
    return { ok: false, code: 'invalid', message: 'Samme vare står flere gange i kurven.' };
  }

  const items = await getItemsByIds(db, input.lines.map((l) => l.itemId));
  const short: ShortLine[] = [];
  for (const l of input.lines) {
    const p = items.get(l.itemId);
    if (!p || !p.active) {
      return { ok: false, code: 'unknown_product', message: 'En vare i kurven findes ikke længere eller er slået fra. Kassen er opdateret.' };
    }
    if (p.track_stock && l.quantity > p.stock) short.push({ itemId: p.id, name: p.name, quantity: l.quantity, available: Math.max(0, p.stock) });
  }
  if (short.length) return { ok: false, code: 'stock', message: 'Der er ikke nok på lager.', short };

  const vat = vatBp(s);
  const calc = calcSale(
    input.lines.map((l) => ({ unit_price: items.get(l.itemId)!.price, quantity: l.quantity, discount: l.discount })),
    input.orderDiscount,
    vat,
  );
  if (calc.total !== input.expectedTotal) {
    return { ok: false, code: 'price_changed', message: 'Priserne er ændret, siden kassen blev åbnet. Kassen er opdateret; tjek beløbet.', total: calc.total };
  }

  // Store rabatter kræver godkendelse af en med højere grænse
  let approvedBy: string | null = null;
  if (calc.discount > 0 && calc.discount_bp > maxDiscountBp(input.staff.role, s)) {
    if (!input.approval?.email || !input.approval.pin) {
      return { ok: false, code: 'approval_required', message: `Rabatten på ${(calc.discount_bp / 100).toLocaleString('da-DK')} % kræver godkendelse.` };
    }
    const a = await checkApproval(env, input.approval.email, input.approval.pin, (r) => maxDiscountBp(r, s) >= calc.discount_bp);
    if (!a.ok) {
      return a.reason === 'rate'
        ? { ok: false, code: 'approval_rate', message: 'For mange forkerte PIN-koder. Vent 15 minutter.' }
        : a.reason === 'role'
          ? { ok: false, code: 'approval_invalid', message: 'Den medarbejder må ikke godkende så stor en rabat.' }
          : { ok: false, code: 'approval_invalid', message: 'Forkert e-mail eller PIN-kode.' };
    }
    approvedBy = a.email;
  }

  const options = methodOptions(s, env);
  const plan = calc.total === 0 && !input.payments.length ? { ok: true as const, rows: [], rounding: 0 } : planPayments(calc.total, input.payments, options, s);
  if (!plan.ok) return { ok: false, code: plan.code, message: plan.message };
  const stripeRow = plan.rows.find((r) => r.opt.method === 'stripe_terminal');
  if (stripeRow && !stripeReady(s, env)) return { ok: false, code: 'payment', message: 'Kortlæseren er ikke sat op.' };

  // En valgt kunde fra kundelisten skal findes; ellers gemmes kun oplysningerne på salget
  let customerId: number | null = null;
  if (input.customer.id) {
    const row = await db.prepare('SELECT id FROM customers WHERE id = ?').bind(input.customer.id).first<{ id: number }>();
    customerId = row?.id ?? null;
  }

  const now = nowSec();
  const ref = refByKey(input.key);
  const actor = input.staff.email;
  const immediate = !stripeRow;
  const c = input.customer;
  const paidWith = plan.rows.map((r) => r.opt.label).join(' + ') || 'Ingen betaling (0 kr.)';
  const stmts: D1PreparedStatement[] = [
    db
      .prepare(
        `INSERT INTO pos_sales (number, client_key, source, status, staff_email, customer_id, customer_name, customer_email, customer_phone, company, note,
           subtotal, discount, total, vat_amount, vat_rate_bp, rounding, order_discount_type, order_discount_value, discount_approved_by,
           stock_deducted, completed_at, created_at, updated_at)
         VALUES ((SELECT COALESCE(MAX(number), 1000) + 1 FROM pos_sales), ?, 'kasse', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)`,
      )
      .bind(input.key, immediate ? 'betalt' : 'afventer', actor, customerId, c.name, c.email, c.phone, c.company, input.note,
        calc.subtotal, calc.discount, calc.total, calc.vat, vat, plan.rounding, input.orderDiscount?.type ?? null, input.orderDiscount?.value ?? null,
        approvedBy, immediate ? now : null, now, now),
    ...input.lines.map((l, i) => {
      const p = items.get(l.itemId)!;
      const cl = calc.lines[i]!;
      return db
        .prepare(
          `INSERT INTO pos_sale_lines (sale_id, item_id, sku, name, unit, unit_price, quantity, line_total, line_discount, order_discount, track_stock)
           VALUES (${ref}, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(p.id, p.sku, p.name, p.unit, p.price, l.quantity, cl.gross, cl.line_discount, cl.order_discount, p.track_stock);
    }),
    ...plan.rows.map((r) =>
      db
        .prepare(
          `INSERT INTO pos_payments (sale_id, method, label, amount, received, change_given, status, reference, actor, created_at, updated_at)
           VALUES (${ref}, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(r.opt.method, r.opt.label, r.amount, r.received, r.change, r.opt.method === 'stripe_terminal' ? 'afventer' : 'gennemfoert', r.reference, actor, now, now),
    ),
    // Lageret trækkes med det samme, også mens en kortbetaling står på (så to kasser ikke kan sælge
    // den sidste vare). Annulleres salget, lægges varerne tilbage.
    ...stockStatements(db, ref, -1, actor, now, 'Kassesalg'),
    eventStatement(db, ref, immediate ? `Kassesalg. Betalt: ${paidWith}` : 'Kassesalg oprettet, afventer kortbetaling', actor, now),
  ];
  if (approvedBy) {
    stmts.push(
      auditStatement(db, {
        action: 'Rabat godkendt',
        saleRef: ref,
        detail: `${(calc.discount_bp / 100).toLocaleString('da-DK')} % (${calc.discount} øre)`,
        actor,
        approvedBy,
        now,
      }),
    );
  }
  try {
    await db.batch(stmts);
  } catch (err) {
    if (!isConstraintError(err)) throw err;
    const again = await existingSale(db, input.key);
    if (again) return { ok: true, saleId: again, existing: true };
    // Udsolgt i mellemtiden: find de varer, der mangler
    const fresh = await getItemsByIds(db, input.lines.map((l) => l.itemId));
    const now2: ShortLine[] = input.lines
      .map((l) => {
        const p = fresh.get(l.itemId);
        return { itemId: l.itemId, name: p?.name ?? '', quantity: l.quantity, available: p ? (p.track_stock ? Math.max(0, p.stock) : l.quantity) : 0 };
      })
      .filter((x) => x.quantity > x.available);
    if (!now2.length) throw err;
    return { ok: false, code: 'stock', message: 'Lageret er ændret i mellemtiden. Der er ikke nok af en eller flere varer.', short: now2 };
  }
  const saleId = (await existingSale(db, input.key))!;
  if (stripeRow) {
    const e = await startStripePayment(env, s, saleId);
    if (e) return { ok: true, saleId, stripeError: e };
  }
  return { ok: true, saleId };
}

// ---------------- Kortbetaling (Stripe Terminal) ----------------

async function pendingStripePayment(db: D1Database, saleId: number): Promise<PosPaymentRow | null> {
  return db
    .prepare("SELECT * FROM pos_payments WHERE sale_id = ? AND method = 'stripe_terminal' AND status IN ('afventer', 'fejlet') ORDER BY id DESC LIMIT 1")
    .bind(saleId)
    .first<PosPaymentRow>();
}

/** Sender betalingen til kortlæseren. Returnerer en fejltekst, hvis det ikke lykkedes. */
export async function startStripePayment(env: Env, s: PosSettings, saleId: number): Promise<string | null> {
  const db = env.DB;
  const pay = await pendingStripePayment(db, saleId);
  const sale = await db.prepare("SELECT number FROM pos_sales WHERE id = ? AND status = 'afventer'").bind(saleId).first<{ number: number }>();
  if (!pay || !sale) return 'Salget afventer ikke en kortbetaling.';
  if (!stripeReady(s, env)) return 'Kortlæseren er ikke sat op.';
  const now = nowSec();
  const attempt = `${saleId}-${pay.id}-${now}`;
  try {
    let pi = pay.provider_ref ? await stripe.getPaymentIntent(env, pay.provider_ref) : null;
    if (pi?.status === 'succeeded') return null; // Allerede betalt: synkroniseringen afslutter salget
    if (!pi || pi.status === 'canceled') pi = await stripe.createPaymentIntent(env, { amount: pay.amount, saleNumber: sale.number, key: attempt });
    await db.prepare("UPDATE pos_payments SET provider_ref = ?, status = 'afventer', error = NULL, updated_at = ? WHERE id = ?").bind(pi.id, now, pay.id).run();
    await stripe.processOnReader(env, s.stripe_reader_id, pi.id, attempt);
    return null;
  } catch (err) {
    const msg = err instanceof stripe.StripeError ? err.message : 'Kortbetalingen kunne ikke startes.';
    await db.prepare("UPDATE pos_payments SET status = 'fejlet', error = ?, updated_at = ? WHERE id = ?").bind(msg.slice(0, 300), now, pay.id).run();
    return msg;
  }
}

/** Afslutter et salg, når kortbetalingen er gennemført hos Stripe. */
async function completeAfterCard(db: D1Database, saleId: number, paymentId: number, actor: string): Promise<void> {
  const now = nowSec();
  // Kun hvis salget stadig afventer (ellers har en anden allerede afsluttet det)
  const r = await db.batch([
    db.prepare("UPDATE pos_sales SET status = 'betalt', completed_at = ?, updated_at = ? WHERE id = ? AND status = 'afventer'").bind(now, now, saleId),
    db.prepare("UPDATE pos_payments SET status = 'gennemfoert', error = NULL, updated_at = ? WHERE id = ? AND status <> 'gennemfoert'").bind(now, paymentId),
  ]);
  if (r[0]!.meta.changes) await eventStatement(db, refById(saleId), 'Kortbetaling gennemført', actor, now).run();
}

export type CardState = { state: 'betalt' } | { state: 'venter'; message: string } | { state: 'fejlet'; message: string } | { state: 'annulleret' };

/** Henter kortbetalingens status hos Stripe og afslutter salget, hvis den er gennemført. */
export async function syncCardPayment(env: Env, s: PosSettings, saleId: number, actor: string): Promise<CardState> {
  const db = env.DB;
  const sale = await db.prepare('SELECT status FROM pos_sales WHERE id = ?').bind(saleId).first<{ status: SaleStatus }>();
  if (!sale) return { state: 'fejlet', message: 'Salget findes ikke.' };
  if (sale.status === 'annulleret') return { state: 'annulleret' };
  if (sale.status !== 'afventer') return { state: 'betalt' };
  const pay = await pendingStripePayment(db, saleId);
  if (!pay) return { state: 'fejlet', message: 'Ingen kortbetaling på salget.' };
  if (pay.status === 'fejlet' && !pay.provider_ref) return { state: 'fejlet', message: pay.error || 'Kortbetalingen fejlede.' };
  if (!pay.provider_ref) return { state: 'venter', message: 'Starter kortbetaling …' };
  try {
    const pi = await stripe.getPaymentIntent(env, pay.provider_ref);
    if (pi.status === 'succeeded') {
      await completeAfterCard(db, saleId, pay.id, actor);
      return { state: 'betalt' };
    }
    if (pay.status === 'fejlet') return { state: 'fejlet', message: pay.error || 'Kortbetalingen fejlede.' };
    if (pi.last_payment_error?.message && pi.status === 'requires_payment_method') {
      const msg = `Kortet blev afvist: ${pi.last_payment_error.message}`;
      await db.prepare("UPDATE pos_payments SET status = 'fejlet', error = ?, updated_at = ? WHERE id = ?").bind(msg.slice(0, 300), nowSec(), pay.id).run();
      return { state: 'fejlet', message: msg };
    }
    if (s.stripe_reader_id) {
      const reader = await stripe.getReader(env, s.stripe_reader_id);
      if (reader.action?.status === 'failed' && reader.action.process_payment_intent?.payment_intent === pi.id) {
        const msg = reader.action.failure_message || 'Betalingen blev afbrudt på kortlæseren.';
        await db.prepare("UPDATE pos_payments SET status = 'fejlet', error = ?, updated_at = ? WHERE id = ?").bind(msg.slice(0, 300), nowSec(), pay.id).run();
        return { state: 'fejlet', message: msg };
      }
      if (reader.status === 'offline') return { state: 'venter', message: 'Kortlæseren er offline. Tjek strøm og netværk.' };
    }
    return { state: 'venter', message: 'Kunden betaler på kortlæseren …' };
  } catch (err) {
    return { state: 'venter', message: err instanceof stripe.StripeError ? err.message : 'Kunne ikke hente status fra Stripe.' };
  }
}

export type CancelResult = { ok: true; completed?: boolean } | { ok: false; message: string };

/**
 * Annullerer et salg, der afventer kortbetaling. Varerne lægges tilbage på lager, og eventuelle andre
 * betalinger på salget (fx kontant ved delt betaling) markeres som annulleret, så de gives tilbage.
 * Er kortbetalingen nået igennem i mellemtiden, afsluttes salget i stedet.
 */
export async function cancelPendingSale(env: Env, s: PosSettings, saleId: number, actor: string, reason: string): Promise<CancelResult> {
  const db = env.DB;
  const sale = await db.prepare('SELECT status FROM pos_sales WHERE id = ?').bind(saleId).first<{ status: SaleStatus }>();
  if (!sale || sale.status !== 'afventer') return { ok: false, message: 'Salget afventer ikke betaling og kan ikke annulleres her.' };
  const pay = await pendingStripePayment(db, saleId);
  if (pay?.provider_ref) {
    try {
      if (s.stripe_reader_id) await stripe.cancelReaderAction(env, s.stripe_reader_id);
      const pi = await stripe.getPaymentIntent(env, pay.provider_ref);
      if (pi.status === 'succeeded') {
        await completeAfterCard(db, saleId, pay.id, actor);
        return { ok: true, completed: true };
      }
      if (pi.status !== 'canceled') {
        const after = await stripe.cancelPaymentIntent(env, pay.provider_ref);
        if (after.status === 'succeeded') {
          await completeAfterCard(db, saleId, pay.id, actor);
          return { ok: true, completed: true };
        }
      }
    } catch (err) {
      // Kan betalingen ikke annulleres hos Stripe, annulleres salget ikke (kunden kunne blive trukket)
      return { ok: false, message: `Kortbetalingen kunne ikke annulleres hos Stripe: ${err instanceof stripe.StripeError ? err.message : 'ukendt fejl'}. Prøv igen.` };
    }
  }
  const now = nowSec();
  const ref = refById(saleId);
  // Første sætning er vagten: ændrer den intet (salget er ikke længere "afventer"), ruller resten tilbage
  const guard = db
    .prepare(`INSERT INTO pos_sale_events (sale_id, message, actor, created_at) VALUES ((SELECT id FROM pos_sales WHERE id = ?1 AND status = 'afventer'), ?2, ?3, ?4)`)
    .bind(saleId, `Kassesalg annulleret: ${reason}`, actor, now);
  try {
    await db.batch([
      guard,
      ...stockStatements(db, ref, 1, actor, now, 'Kassesalg annulleret'),
      db.prepare(`UPDATE pos_sales SET status = 'annulleret', stock_deducted = 0, updated_at = ? WHERE id = ${ref}`).bind(now),
      db.prepare(`UPDATE pos_payments SET status = 'annulleret', updated_at = ? WHERE sale_id = ${ref} AND status <> 'annulleret'`).bind(now),
      auditStatement(db, { action: 'Salg annulleret', saleRef: ref, detail: reason, actor, now }),
    ]);
  } catch (err) {
    if (!isConstraintError(err)) throw err;
    return { ok: false, message: 'Salget er lige blevet ændret. Genindlæs siden.' };
  }
  return { ok: true };
}

/**
 * Natlig oprydning: salg, der har ventet på kortbetaling i over 30 minutter, afsluttes, hvis Stripe har
 * gennemført betalingen, og annulleres ellers, så varerne kommer tilbage på lager.
 */
export async function reconcilePending(env: Env, s: PosSettings): Promise<void> {
  const { results } = await env.DB.prepare("SELECT id FROM pos_sales WHERE status = 'afventer' AND created_at < ? LIMIT 50")
    .bind(nowSec() - 30 * 60)
    .all<{ id: number }>();
  for (const r of results) {
    try {
      const st = await syncCardPayment(env, s, r.id, 'system');
      if (st.state !== 'betalt') await cancelPendingSale(env, s, r.id, 'system', 'Kortbetalingen blev ikke gennemført');
    } catch (err) {
      console.error('Oprydning af kassesalg fejlede:', (err as Error).message);
    }
  }
}

// ---------------- Opslag ----------------

export interface SaleLine extends PosSaleLineRow {
  refunded_qty: number;
  refunded_amount: number;
}

export interface SaleDetail {
  sale: PosSaleRow;
  lines: SaleLine[];
  payments: PosPaymentRow[];
  refunds: (PosRefundRow & { lines: PosRefundLineRow[]; parts: PosRefundPaymentRow[] })[];
  events: SaleEventRow[];
}

export async function getSale(db: D1Database, saleId: number): Promise<SaleDetail | null> {
  if (!Number.isSafeInteger(saleId) || saleId <= 0) return null;
  const [sale, lines, payments, refunds, rlines, parts, events] = await db.batch([
    db.prepare('SELECT * FROM pos_sales WHERE id = ?').bind(saleId),
    db
      .prepare(
        `SELECT l.*,
           COALESCE((SELECT SUM(rl.quantity) FROM pos_refund_lines rl JOIN pos_refunds r ON r.id = rl.refund_id WHERE rl.sale_line_id = l.id AND r.status <> 'fejlet'), 0) AS refunded_qty,
           COALESCE((SELECT SUM(rl.amount) FROM pos_refund_lines rl JOIN pos_refunds r ON r.id = rl.refund_id WHERE rl.sale_line_id = l.id AND r.status <> 'fejlet'), 0) AS refunded_amount
         FROM pos_sale_lines l WHERE l.sale_id = ? ORDER BY l.id`,
      )
      .bind(saleId),
    db.prepare('SELECT * FROM pos_payments WHERE sale_id = ? ORDER BY id').bind(saleId),
    db.prepare('SELECT * FROM pos_refunds WHERE sale_id = ? ORDER BY id').bind(saleId),
    db.prepare('SELECT rl.* FROM pos_refund_lines rl JOIN pos_refunds r ON r.id = rl.refund_id WHERE r.sale_id = ?').bind(saleId),
    db.prepare('SELECT rp.* FROM pos_refund_payments rp JOIN pos_refunds r ON r.id = rp.refund_id WHERE r.sale_id = ? ORDER BY rp.id').bind(saleId),
    db.prepare('SELECT id, message, actor, created_at FROM pos_sale_events WHERE sale_id = ? ORDER BY created_at, id').bind(saleId),
  ]);
  const row = (sale!.results as PosSaleRow[])[0];
  if (!row) return null;
  const rl = rlines!.results as PosRefundLineRow[];
  const rp = parts!.results as PosRefundPaymentRow[];
  return {
    sale: row,
    lines: lines!.results as SaleLine[],
    payments: payments!.results as PosPaymentRow[],
    refunds: (refunds!.results as PosRefundRow[]).map((r) => ({ ...r, lines: rl.filter((x) => x.refund_id === r.id), parts: rp.filter((x) => x.refund_id === r.id) })),
    events: events!.results as SaleEventRow[],
  };
}

export interface SaleFilter {
  q?: string;
  from?: number;
  to?: number;
  staff?: string;
  method?: PaymentMethod | null;
  status?: SaleStatus | null;
  /** Kun salg fra denne medarbejder (kasseassistenter uden adgang til alle salg) */
  onlyStaff?: string | null;
  limit: number;
  offset: number;
}

export interface SaleListRow {
  id: number;
  number: number;
  created_at: number;
  customer_name: string;
  company: string;
  total: number;
  rounding: number;
  discount: number;
  staff_email: string;
  status: SaleStatus;
  refunded: number;
  methods: string | null;
  item_count: number;
}

export async function listSales(db: D1Database, f: SaleFilter): Promise<SaleListRow[]> {
  const where: string[] = ['1 = 1'];
  const args: (string | number)[] = [];
  if (f.q) {
    const n = f.q.replace(/^#/, '');
    if (/^\d+$/.test(n)) {
      where.push('s.number = ?');
      args.push(Number(n));
    } else {
      const like = '%' + f.q.replace(/[\\%_]/g, (m) => '\\' + m) + '%';
      where.push("(s.customer_name LIKE ? ESCAPE '\\' OR s.customer_email LIKE ? ESCAPE '\\' OR s.company LIKE ? ESCAPE '\\' OR s.note LIKE ? ESCAPE '\\')");
      args.push(like, like, like, like);
    }
  }
  if (f.from) {
    where.push('s.created_at >= ?');
    args.push(f.from);
  }
  if (f.to) {
    where.push('s.created_at < ?');
    args.push(f.to);
  }
  const staff = f.onlyStaff ?? f.staff;
  if (staff) {
    where.push('s.staff_email = ?');
    args.push(staff.toLowerCase());
  }
  if (f.method) {
    where.push("EXISTS (SELECT 1 FROM pos_payments x WHERE x.sale_id = s.id AND x.method = ? AND x.status = 'gennemfoert')");
    args.push(f.method);
  }
  if (f.status) {
    where.push('s.status = ?');
    args.push(f.status);
  }
  const { results } = await db
    .prepare(
      `SELECT s.id, s.number, s.created_at, s.customer_name, s.company, s.total, s.rounding, s.discount, s.staff_email, s.status, s.refunded,
         (SELECT GROUP_CONCAT(label, ' + ') FROM pos_payments x WHERE x.sale_id = s.id AND x.status <> 'fejlet') AS methods,
         (SELECT COALESCE(SUM(quantity), 0) FROM pos_sale_lines WHERE sale_id = s.id) AS item_count
       FROM pos_sales s
       WHERE ${where.join(' AND ')}
       ORDER BY s.created_at DESC, s.id DESC LIMIT ? OFFSET ?`,
    )
    .bind(...args, f.limit, f.offset)
    .all<SaleListRow>();
  return results;
}

export async function saleStaffEmails(db: D1Database): Promise<string[]> {
  const { results } = await db.prepare('SELECT DISTINCT staff_email FROM pos_sales ORDER BY staff_email').all<{ staff_email: string }>();
  return results.map((r) => r.staff_email);
}

// ---------------- Refusion ----------------

export interface RefundInput {
  saleId: number;
  key: string;
  staff: StaffInfo;
  lines: { lineId: number; quantity: number }[];
  restock: boolean;
  reason: string;
  /** Betaling, der refunderes til først */
  paymentId: number | null;
  approval?: { email: string; pin: string } | null;
}

export type RefundResult =
  | { ok: true; refundId: number; amount: number; existing?: boolean }
  | { ok: false; code: 'not_found' | 'state' | 'invalid' | 'approval_required' | 'approval_invalid' | 'approval_rate' | 'stripe' | 'conflict'; message: string };

const REFUND_ORDER: PaymentMethod[] = ['stripe_terminal', 'kort_terminal', 'andet', 'kontant'];

export async function refundSale(env: Env, s: PosSettings, input: RefundInput): Promise<RefundResult> {
  const db = env.DB;
  const prev = await db.prepare('SELECT id, amount FROM pos_refunds WHERE client_key = ?').bind(input.key).first<{ id: number; amount: number }>();
  if (prev) return { ok: true, refundId: prev.id, amount: prev.amount, existing: true };
  const detail = await getSale(db, input.saleId);
  if (!detail) return { ok: false, code: 'not_found', message: 'Salget findes ikke.' };
  if (!['betalt', 'delvist_refunderet'].includes(detail.sale.status)) {
    return { ok: false, code: 'state', message: 'Salget kan ikke refunderes (det er ikke betalt, eller det er allerede refunderet).' };
  }
  if (!input.reason) return { ok: false, code: 'invalid', message: 'Skriv en årsag til refusionen.' };

  let approvedBy: string | null = null;
  if (!can(input.staff.role, 'pos.refund')) {
    if (!input.approval?.email || !input.approval.pin) return { ok: false, code: 'approval_required', message: 'En refusion skal godkendes af en leder eller administrator.' };
    const a = await checkApproval(env, input.approval.email, input.approval.pin, (r) => can(r, 'pos.refund'));
    if (!a.ok) {
      return {
        ok: false,
        code: a.reason === 'rate' ? 'approval_rate' : 'approval_invalid',
        message: a.reason === 'rate' ? 'For mange forkerte PIN-koder. Vent 15 minutter.' : a.reason === 'role' ? 'Den medarbejder må ikke godkende refusioner.' : 'Forkert e-mail eller PIN-kode.',
      };
    }
    approvedBy = a.email;
  }

  // Beløb pr. linje ud fra linjens nettobeløb (efter rabat), så rabatten fordeles retfærdigt
  const chosen: { line: SaleLine; qty: number; amount: number }[] = [];
  for (const r of input.lines) {
    if (r.quantity <= 0) continue;
    const line = detail.lines.find((l) => l.id === r.lineId);
    if (!line) return { ok: false, code: 'invalid', message: 'En linje findes ikke på salget.' };
    if (r.quantity > line.quantity - line.refunded_qty) return { ok: false, code: 'invalid', message: `Der kan højst refunderes ${line.quantity - line.refunded_qty} af ${line.name}.` };
    const net = line.line_total - line.line_discount - line.order_discount;
    chosen.push({ line, qty: r.quantity, amount: refundShare(net, line.quantity, line.refunded_qty, r.quantity) });
  }
  if (!chosen.length) return { ok: false, code: 'invalid', message: 'Vælg mindst én linje at refundere.' };
  let amount = chosen.reduce((a, c) => a + c.amount, 0);

  // Fordel beløbet på salgets betalinger: den valgte først, derefter kort, andre og kontant
  const refundedByPayment = new Map<number, number>();
  for (const r of detail.refunds) {
    if (r.status === 'fejlet') continue;
    for (const p of r.parts) if (p.status !== 'fejlet') refundedByPayment.set(p.payment_id, (refundedByPayment.get(p.payment_id) ?? 0) + p.amount);
  }
  const paid = detail.payments
    .filter((p) => p.status === 'gennemfoert')
    .map((p) => ({ p, left: p.amount - (refundedByPayment.get(p.id) ?? 0) }))
    .filter((x) => x.left > 0)
    .sort(
      (a, b) =>
        (a.p.id === input.paymentId ? -1 : 0) - (b.p.id === input.paymentId ? -1 : 0) || REFUND_ORDER.indexOf(a.p.method) - REFUND_ORDER.indexOf(b.p.method),
    );
  // Er hele salget refunderet, betales også en kontantafrunding tilbage
  const fullyRefunded = detail.lines.every((l) => l.quantity - l.refunded_qty === (chosen.find((c) => c.line.id === l.id)?.qty ?? 0));
  const capacity = paid.reduce((a, x) => a + x.left, 0);
  if (fullyRefunded) amount = capacity;
  if (amount > capacity) amount = capacity;
  const parts: { p: PosPaymentRow; amount: number }[] = [];
  let rest = amount;
  for (const x of paid) {
    if (rest <= 0) break;
    let take = Math.min(rest, x.left);
    // Kontant udbetales i hele 50 øre
    if (x.p.method === 'kontant' && s.cash_rounding && take < x.left) take = Math.min(x.left, roundCash(take));
    if (take <= 0) continue;
    parts.push({ p: x.p, amount: take });
    rest -= take;
  }
  amount = parts.reduce((a, x) => a + x.amount, 0);
  if (amount <= 0 && chosen.some((c) => c.amount > 0)) return { ok: false, code: 'invalid', message: 'Der er ikke mere at refundere på salget.' };

  const now = nowSec();
  const ref = refById(input.saleId);
  const actor = input.staff.email;
  const refRef = `(SELECT id FROM pos_refunds WHERE client_key = '${input.key.replace(/[^A-Za-z0-9_-]/g, '')}')`;
  try {
    await db.batch([
      db
        .prepare(
          `INSERT INTO pos_refunds (sale_id, client_key, amount, status, restock, reason, actor, approved_by, created_at, updated_at)
           VALUES (${ref}, ?, ?, 'afventer', ?, ?, ?, ?, ?, ?)`,
        )
        .bind(input.key, amount, input.restock ? 1 : 0, input.reason, actor, approvedBy, now, now),
      // Vagt: antallet må aldrig overstige det solgte (quantity bliver NULL, og batchen afbrydes)
      ...chosen.map((c) =>
        db
          .prepare(
            `INSERT INTO pos_refund_lines (refund_id, sale_line_id, quantity, amount) VALUES (${refRef}, ?1,
               CASE WHEN ?2 + COALESCE((SELECT SUM(rl.quantity) FROM pos_refund_lines rl JOIN pos_refunds r ON r.id = rl.refund_id
                 WHERE rl.sale_line_id = ?1 AND r.status <> 'fejlet'), 0) <= (SELECT quantity FROM pos_sale_lines WHERE id = ?1) THEN ?2 ELSE NULL END, ?3)`,
          )
          .bind(c.line.id, c.qty, c.amount),
      ),
      ...parts.map((x) =>
        db
          .prepare(`INSERT INTO pos_refund_payments (refund_id, payment_id, method, label, amount, status) VALUES (${refRef}, ?, ?, ?, ?, 'afventer')`)
          .bind(x.p.id, x.p.method, x.p.label, x.amount),
      ),
    ]);
  } catch (err) {
    if (!isConstraintError(err)) throw err;
    const again = await db.prepare('SELECT id, amount FROM pos_refunds WHERE client_key = ?').bind(input.key).first<{ id: number; amount: number }>();
    if (again) return { ok: true, refundId: again.id, amount: again.amount, existing: true };
    return { ok: false, code: 'conflict', message: 'Salget er lige blevet refunderet af en anden. Genindlæs siden.' };
  }
  const refundId = (await db.prepare('SELECT id FROM pos_refunds WHERE client_key = ?').bind(input.key).first<{ id: number }>())!.id;
  const { results: rows } = await db.prepare('SELECT * FROM pos_refund_payments WHERE refund_id = ? ORDER BY id').bind(refundId).all<PosRefundPaymentRow>();

  // Kort via Stripe refunderes først; fejler det, gennemføres intet (heller ikke kontant udbetaling)
  for (const row of rows) {
    if (row.method !== 'stripe_terminal') continue;
    const pay = detail.payments.find((p) => p.id === row.payment_id)!;
    try {
      const re = await stripe.createRefund(env, { paymentIntent: pay.provider_ref ?? '', amount: row.amount, key: `${input.key}-${row.id}` });
      if (re.status === 'failed' || re.status === 'canceled') throw new stripe.StripeError(`Stripe afviste refusionen (${re.failure_reason ?? re.status}).`, 402);
      await db.prepare("UPDATE pos_refund_payments SET status = 'gennemfoert', provider_ref = ? WHERE id = ?").bind(re.id, row.id).run();
    } catch (err) {
      const msg = err instanceof stripe.StripeError ? err.message : 'Refusionen kunne ikke gennemføres hos Stripe.';
      await db.batch([
        db.prepare("UPDATE pos_refund_payments SET status = 'fejlet', error = ? WHERE id = ?").bind(msg.slice(0, 300), row.id),
        db.prepare("UPDATE pos_refund_payments SET status = 'fejlet' WHERE refund_id = ? AND status = 'afventer'").bind(refundId),
        db.prepare("UPDATE pos_refunds SET status = 'fejlet', error = ?, updated_at = ? WHERE id = ?").bind(msg.slice(0, 300), nowSec(), refundId),
        auditStatement(db, { action: 'Refusion fejlede', saleRef: ref, detail: msg.slice(0, 300), actor, approvedBy, now: nowSec() }),
      ]);
      return { ok: false, code: 'stripe', message: msg };
    }
  }

  const total = detail.sale.total + detail.sale.rounding;
  const newRefunded = detail.sale.refunded + amount;
  const status: SaleStatus = fullyRefunded || newRefunded >= total ? 'refunderet' : 'delvist_refunderet';
  const restock = input.restock ? chosen.filter((c) => c.line.item_id !== null && c.line.track_stock === 1) : [];
  const t = nowSec();
  const what = chosen.map((c) => `${c.qty} × ${c.line.name}`).join(', ');
  const kr = (amount / 100).toLocaleString('da-DK', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  await db.batch([
    db.prepare("UPDATE pos_refund_payments SET status = 'gennemfoert' WHERE refund_id = ? AND status = 'afventer'").bind(refundId),
    db.prepare("UPDATE pos_refunds SET status = 'gennemfoert', updated_at = ? WHERE id = ?").bind(t, refundId),
    db.prepare('UPDATE pos_sales SET refunded = refunded + ?, status = ?, updated_at = ? WHERE id = ?').bind(amount, status, t, input.saleId),
    ...restock.flatMap((c) => [
      db
        .prepare(
          `INSERT INTO pos_stock_movements (item_id, change, stock_after, reason, sale_id, actor, created_at)
           SELECT id, ?, stock + ?, ?, ?, ?, ? FROM pos_items WHERE id = ? AND track_stock = 1`,
        )
        .bind(c.qty, c.qty, `Retur kassesalg #${detail.sale.number}`, input.saleId, actor, t, c.line.item_id),
      db.prepare('UPDATE pos_items SET stock = stock + ?, updated_at = ? WHERE id = ? AND track_stock = 1').bind(c.qty, t, c.line.item_id),
    ]),
    eventStatement(db, ref, `Refunderet ${kr} kr. (${what})${restock.length ? ', lagt på lager' : ''}: ${input.reason}`, actor, t),
    auditStatement(db, { action: status === 'refunderet' ? 'Salg refunderet' : 'Delvis refusion', saleRef: ref, detail: `${kr} kr. · ${what} · ${input.reason}`, actor, approvedBy, now: t }),
  ]);
  return { ok: true, refundId, amount };
}
