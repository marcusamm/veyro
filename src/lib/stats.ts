// Statistik til admin: besøg, forespørgsler, tilbud, kunder og omsætning for en periode,
// sammenlignet med perioden før. Bruges af /admin/statistik og Excel-udtrækket.
import type { Env } from '../env';
import { OPEN_LEAD_SQL } from '../site/leads';
import { stripeRequest } from './stripe';

export interface Period {
  key: string; // fx "30" eller "2026-10"
  label: string;
  from: string; // YYYY-MM-DD (dansk dato), inklusiv
  to: string; // YYYY-MM-DD, eksklusiv
  fromSec: number;
  toSec: number;
}

const DAY = 86400;

const cphDate = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Copenhagen', year: 'numeric', month: '2-digit', day: '2-digit' });
const cphOffset = new Intl.DateTimeFormat('en-US', { timeZone: 'Europe/Copenhagen', timeZoneName: 'longOffset' });
const monthName = new Intl.DateTimeFormat('da-DK', { month: 'long', year: 'numeric', timeZone: 'UTC' });

/** Dansk dato (YYYY-MM-DD) for et tidspunkt */
export function dayOf(unixSec: number): string {
  return cphDate.format(new Date(unixSec * 1000));
}

/** Unix-sekunder for midnat dansk tid på en dato */
export function midnight(day: string): number {
  const [y, m, d] = day.split('-').map(Number);
  const utc = Date.UTC(y!, m! - 1, d!) / 1000;
  // Forskydningen kan skifte ved sommertid; den gælder kl. 12 samme dag
  const name = cphOffset.formatToParts(new Date((utc + 12 * 3600) * 1000)).find((p) => p.type === 'timeZoneName')?.value ?? 'GMT+01:00';
  const mm = /GMT([+-])(\d{2}):?(\d{2})?/.exec(name);
  const off = mm ? (mm[1] === '-' ? -1 : 1) * (Number(mm[2]) * 3600 + Number(mm[3] ?? 0) * 60) : 3600;
  return utc - off;
}

export function addDays(day: string, n: number): string {
  const [y, m, d] = day.split('-').map(Number);
  return new Date(Date.UTC(y!, m! - 1, d! + n)).toISOString().slice(0, 10);
}

export function daysBetween(from: string, to: string): string[] {
  const out: string[] = [];
  for (let d = from; d < to && out.length < 400; d = addDays(d, 1)) out.push(d);
  return out;
}

function period(key: string, label: string, from: string, to: string): Period {
  return { key, label, from, to, fromSec: midnight(from), toSec: midnight(to) };
}

export const PERIOD_DAYS = [7, 30, 90, 365] as const;

/** ?periode=30 (sidste 30 dage inkl. i dag) eller ?periode=2026-10 (en kalendermåned) */
export function parsePeriod(raw: string | undefined, now = Math.floor(Date.now() / 1000)): Period {
  const today = dayOf(now);
  const m = /^(\d{4})-(\d{2})$/.exec(raw ?? '');
  if (m && +m[2]! >= 1 && +m[2]! <= 12 && +m[1]! >= 2020 && +m[1]! <= 2100) {
    const from = `${m[1]}-${m[2]}-01`;
    const to = +m[2]! === 12 ? `${+m[1]! + 1}-01-01` : `${m[1]}-${String(+m[2]! + 1).padStart(2, '0')}-01`;
    const name = monthName.format(new Date(Date.UTC(+m[1]!, +m[2]! - 1, 1)));
    return period(`${m[1]}-${m[2]}`, name.charAt(0).toUpperCase() + name.slice(1), from, to);
  }
  const n = (PERIOD_DAYS as readonly number[]).includes(Number(raw)) ? Number(raw) : 30;
  return period(String(n), n === 365 ? 'Sidste 12 måneder' : `Sidste ${n} dage`, addDays(today, -(n - 1)), addDays(today, 1));
}

/** Perioden lige før, med samme længde (en måned sammenlignes med måneden før) */
export function previousPeriod(p: Period): Period {
  if (/^\d{4}-\d{2}$/.test(p.key)) {
    const [y, m] = p.key.split('-').map(Number);
    const key = m === 1 ? `${y! - 1}-12` : `${y}-${String(m! - 1).padStart(2, '0')}`;
    return parsePeriod(key);
  }
  const len = daysBetween(p.from, p.to).length;
  return period('forrige', 'Perioden før', addDays(p.from, -len), p.from);
}

/** De seneste 12 kalendermåneder (nyeste først) til månedsvælgeren */
export function recentMonths(now = Math.floor(Date.now() / 1000)): { key: string; label: string }[] {
  const [y, m] = dayOf(now).split('-').map(Number);
  const out: { key: string; label: string }[] = [];
  for (let i = 0; i < 12; i++) {
    const d = new Date(Date.UTC(y!, m! - 1 - i, 1));
    const key = d.toISOString().slice(0, 7);
    const name = monthName.format(d);
    out.push({ key, label: name.charAt(0).toUpperCase() + name.slice(1) });
  }
  return out;
}

// ---------- Data ----------

export interface LeadStatRow {
  id: number;
  kind: string;
  status: string;
  name: string | null;
  email: string;
  company: string | null;
  service: string | null;
  page: string | null;
  cart: string | null;
  created_at: number;
}
export interface OfferStatRow {
  id: number;
  name: string;
  company: string | null;
  email: string;
  service: string;
  amount: number;
  interval: string;
  setup_amount: number;
  vat: number;
  status: string;
  created_at: number;
  activated_at: number | null;
}
export interface CustomerStatRow {
  id: number;
  name: string | null;
  company: string | null;
  email: string;
  created_at: number;
}
export interface PaymentStatRow {
  id: string;
  number: string | null;
  customer: string;
  paidAt: number;
  total: number; // øre inkl. moms
  net: number | null; // øre ekskl. moms, når Stripe oplyser det
  currency: string;
}

export interface Stats {
  period: Period;
  days: string[];
  views: { total: number; byDay: number[]; byPath: { path: string; views: number }[] };
  leads: { rows: LeadStatRow[]; byDay: number[]; byKind: Record<string, number> };
  offers: { rows: OfferStatRow[]; sent: number; activated: number; activatedValue: number };
  customers: { rows: CustomerStatRow[] };
  revenue: { source: 'stripe' | 'database'; error: string | null; rows: PaymentStatRow[]; total: number; byDay: number[] };
}

export interface Snapshot {
  activeSubscriptions: number;
  mrr: number; // øre pr. måned, som beløbene står i Stripe
  openLeads: number;
}

function bucket(days: string[], items: { day: string; n: number }[]): number[] {
  const idx = new Map(days.map((d, i) => [d, i]));
  const out = days.map(() => 0);
  for (const it of items) {
    const i = idx.get(it.day);
    if (i !== undefined) out[i]! += it.n;
  }
  return out;
}

interface StripeListInvoice {
  id: string;
  number: string | null;
  status: string | null;
  created: number;
  total: number;
  total_excluding_tax?: number | null;
  amount_paid: number;
  currency: string;
  customer_email?: string | null;
  customer_name?: string | null;
  status_transitions?: { paid_at?: number | null } | null;
}

/** Betalte fakturaer fra Stripe, hvor betalingen faldt i perioden */
async function stripePayments(env: Env, p: Period): Promise<PaymentStatRow[]> {
  const out: PaymentStatRow[] = [];
  let after: string | undefined;
  // Fakturaer oprettes typisk kort før de betales; 62 dage bagud fanger også sene betalinger
  for (let page = 0; page < 20; page++) {
    const res = await stripeRequest<{ data: StripeListInvoice[]; has_more: boolean }>(env, 'GET', '/v1/invoices', {
      status: 'paid',
      limit: 100,
      'created[gte]': p.fromSec - 62 * DAY,
      'created[lt]': p.toSec,
      starting_after: after,
    });
    for (const inv of res.data ?? []) {
      if (inv.status !== 'paid') continue;
      const paidAt = inv.status_transitions?.paid_at ?? inv.created;
      if (paidAt < p.fromSec || paidAt >= p.toSec) continue;
      out.push({
        id: inv.id,
        number: inv.number,
        customer: inv.customer_name || inv.customer_email || '',
        paidAt,
        total: inv.amount_paid ?? inv.total,
        net: inv.total_excluding_tax ?? null,
        currency: inv.currency,
      });
    }
    if (!res.has_more || !res.data?.length) break;
    after = res.data[res.data.length - 1]!.id;
  }
  return out.sort((a, b) => a.paidAt - b.paidAt);
}

async function dbPayments(db: D1Database, p: Period): Promise<PaymentStatRow[]> {
  const { results } = await db
    .prepare(
      `SELECT p.invoice_id, p.number, p.amount_paid, p.currency, COALESCE(p.created, p.updated_at) AS at, c.name, c.email
       FROM payments p LEFT JOIN customers c ON c.stripe_customer_id = p.stripe_customer_id
       WHERE p.status = 'paid' AND COALESCE(p.created, p.updated_at) >= ? AND COALESCE(p.created, p.updated_at) < ? ORDER BY at`,
    )
    .bind(p.fromSec, p.toSec)
    .all<{ invoice_id: string; number: string | null; amount_paid: number | null; currency: string | null; at: number; name: string | null; email: string | null }>();
  return (results ?? []).map((r) => ({
    id: r.invoice_id,
    number: r.number,
    customer: r.name || r.email || '',
    paidAt: r.at,
    total: r.amount_paid ?? 0,
    net: null,
    currency: r.currency ?? 'dkk',
  }));
}

export async function collectStats(env: Env, p: Period, opts: { details?: boolean } = {}): Promise<Stats> {
  const db = env.DB;
  const days = daysBetween(p.from, p.to);
  const [views, paths, leads, offers, customers] = await db.batch([
    // site_views tælles pr. UTC-dag
    db.prepare('SELECT day, SUM(views) AS n FROM site_views WHERE day >= ? AND day < ? GROUP BY day').bind(p.from, p.to),
    db.prepare('SELECT path, SUM(views) AS views FROM site_views WHERE day >= ? AND day < ? GROUP BY path ORDER BY views DESC LIMIT ?').bind(p.from, p.to, opts.details ? 500 : 10),
    db.prepare("SELECT id, kind, status, name, email, company, service, page, cart, created_at FROM leads WHERE created_at >= ? AND created_at < ? AND status != 'spam' ORDER BY created_at").bind(p.fromSec, p.toSec),
    db.prepare('SELECT id, name, company, email, service, amount, interval, setup_amount, vat, status, created_at, activated_at FROM offers WHERE (created_at >= ?1 AND created_at < ?2) OR (activated_at >= ?1 AND activated_at < ?2) ORDER BY created_at').bind(p.fromSec, p.toSec),
    db.prepare('SELECT id, name, company, email, created_at FROM customers WHERE created_at >= ? AND created_at < ? ORDER BY created_at').bind(p.fromSec, p.toSec),
  ]);
  const viewRows = (views?.results ?? []) as { day: string; n: number }[];
  const leadRows = (leads?.results ?? []) as LeadStatRow[];
  const offerRows = (offers?.results ?? []) as OfferStatRow[];
  const inPeriod = (t: number | null) => t !== null && t >= p.fromSec && t < p.toSec;

  let revenue: Stats['revenue'];
  try {
    const rows = await stripePayments(env, p);
    revenue = { source: 'stripe', error: null, rows, total: 0, byDay: [] };
  } catch (err) {
    const rows = await dbPayments(db, p);
    revenue = { source: 'database', error: err instanceof Error ? err.message : String(err), rows, total: 0, byDay: [] };
  }
  revenue.total = revenue.rows.reduce((s, r) => s + r.total, 0);
  revenue.byDay = bucket(days, revenue.rows.map((r) => ({ day: dayOf(r.paidAt), n: r.total })));

  const byKind: Record<string, number> = {};
  for (const l of leadRows) byKind[l.kind] = (byKind[l.kind] ?? 0) + 1;
  const activated = offerRows.filter((o) => inPeriod(o.activated_at));
  return {
    period: p,
    days,
    views: {
      total: viewRows.reduce((s, r) => s + r.n, 0),
      byDay: bucket(days, viewRows.map((r) => ({ day: r.day, n: r.n }))),
      byPath: (paths?.results ?? []) as { path: string; views: number }[],
    },
    leads: { rows: leadRows, byDay: bucket(days, leadRows.map((l) => ({ day: dayOf(l.created_at), n: 1 }))), byKind },
    offers: {
      rows: offerRows,
      sent: offerRows.filter((o) => inPeriod(o.created_at)).length,
      activated: activated.length,
      activatedValue: activated.reduce((s, o) => s + monthly(o.amount, o.interval), 0),
    },
    customers: { rows: (customers?.results ?? []) as CustomerStatRow[] },
    revenue,
  };
}

/** Beløb pr. måned (et årsbeløb deles med 12) */
export function monthly(amount: number | null, interval: string | null): number {
  return interval === 'year' ? Math.round((amount ?? 0) / 12) : amount ?? 0;
}

export async function snapshot(db: D1Database): Promise<Snapshot> {
  const [subs, open] = await db.batch([
    db.prepare("SELECT amount, interval FROM subscriptions WHERE status IN ('active', 'trialing', 'past_due')"),
    db.prepare(`SELECT COUNT(*) AS n FROM leads WHERE ${OPEN_LEAD_SQL}`),
  ]);
  const rows = (subs?.results ?? []) as { amount: number | null; interval: string | null }[];
  return {
    activeSubscriptions: rows.length,
    mrr: rows.reduce((s, r) => s + monthly(r.amount, r.interval), 0),
    openLeads: ((open?.results ?? [])[0] as { n: number } | undefined)?.n ?? 0,
  };
}

/** Ændring i procent; null når der ikke er noget at sammenligne med */
export function change(now: number, before: number): number | null {
  if (!before) return null;
  return (now - before) / before;
}
