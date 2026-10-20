import type { CustomerRow, Env, RequestRow, SubscriptionRow } from '../env';
import { nowSec } from './crypto';
import { planForPriceId } from './plans';
import { idOf, subscriptionPeriodEnd, type StripeSubscription } from './stripe';

// ---------- Kunder ----------

export function normalizeEmail(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const e = raw.trim().toLowerCase();
  if (e.length < 3 || e.length > 254) return null;
  // Pragmatisk validering: ét @, ingen mellemrum, domæne med punktum
  if (!/^[^\s@<>()"',;]+@[^\s@<>()"',;]+\.[^\s@<>()"',;]{2,}$/.test(e)) return null;
  return e;
}

export async function getCustomerByEmail(db: D1Database, email: string): Promise<CustomerRow | null> {
  return db.prepare('SELECT * FROM customers WHERE email = ?').bind(email).first<CustomerRow>();
}

export async function getCustomerById(db: D1Database, id: number): Promise<CustomerRow | null> {
  return db.prepare('SELECT * FROM customers WHERE id = ?').bind(id).first<CustomerRow>();
}

export async function getCustomerByStripeId(db: D1Database, stripeId: string): Promise<CustomerRow | null> {
  return db.prepare('SELECT * FROM customers WHERE stripe_customer_id = ?').bind(stripeId).first<CustomerRow>();
}

/**
 * Opretter eller kobler en kunde ud fra e-mail. Findes e-mailen allerede,
 * sættes Stripe-kunde-ID'et (og navn hvis det mangler).
 */
export async function upsertCustomer(
  db: D1Database,
  args: { email: string; name?: string | null; stripeCustomerId?: string | null },
): Promise<CustomerRow> {
  const now = nowSec();
  const name = args.name ? args.name.slice(0, 200) : null;
  // Hvis Stripe-ID'et allerede er knyttet til en anden e-mail (kunden har skiftet e-mail i Stripe),
  // opdateres den eksisterende række i stedet for at oprette en dublet.
  if (args.stripeCustomerId) {
    const byStripe = await getCustomerByStripeId(db, args.stripeCustomerId);
    if (byStripe && byStripe.email !== args.email) {
      const clash = await getCustomerByEmail(db, args.email);
      if (!clash) {
        await db
          .prepare('UPDATE customers SET email = ?, name = COALESCE(?, name), updated_at = ? WHERE id = ?')
          .bind(args.email, name, now, byStripe.id)
          .run();
        return (await getCustomerById(db, byStripe.id))!;
      }
      return byStripe;
    }
  }
  await db
    .prepare(
      `INSERT INTO customers (email, name, stripe_customer_id, created_at, updated_at)
       VALUES (?1, ?2, ?3, ?4, ?4)
       ON CONFLICT(email) DO UPDATE SET
         name = COALESCE(customers.name, excluded.name),
         stripe_customer_id = COALESCE(excluded.stripe_customer_id, customers.stripe_customer_id),
         updated_at = excluded.updated_at`,
    )
    .bind(args.email, name, args.stripeCustomerId ?? null, now)
    .run();
  return (await getCustomerByEmail(db, args.email))!;
}

export interface CustomerListRow extends CustomerRow {
  plan: string | null;
  status: string | null;
  cancel_at_period_end: number | null;
  payment_failed: number | null;
  open_requests: number;
}

export async function listCustomers(db: D1Database): Promise<CustomerListRow[]> {
  const { results } = await db
    .prepare(
      `SELECT c.*, s.plan, s.status, s.cancel_at_period_end, s.payment_failed,
         (SELECT COUNT(*) FROM requests r WHERE r.customer_id = c.id AND r.status != 'resolved') AS open_requests
       FROM customers c
       LEFT JOIN subscriptions s ON s.id = (
         SELECT id FROM subscriptions s2 WHERE s2.customer_id = c.id
         ORDER BY (s2.status IN ('active','trialing','past_due','unpaid','incomplete')) DESC, s2.started_at DESC LIMIT 1)
       ORDER BY c.created_at DESC
       LIMIT 500`,
    )
    .all<CustomerListRow>();
  return results;
}

// ---------- Abonnementer ----------

export async function upsertSubscription(
  env: Env,
  customerId: number,
  sub: StripeSubscription,
  extra: { paymentFailed?: boolean } = {},
): Promise<void> {
  const item = sub.items?.data?.[0];
  const priceId = item?.price?.id ?? null;
  const amount = item?.price?.unit_amount != null ? item.price.unit_amount * (item.quantity ?? 1) : null;
  const now = nowSec();
  const pf = extra.paymentFailed === undefined ? null : extra.paymentFailed ? 1 : 0;
  // past_due/unpaid betyder altid fejlet betaling; active nulstiller flaget
  const statusFailed = sub.status === 'past_due' || sub.status === 'unpaid' ? 1 : sub.status === 'active' ? 0 : null;
  await env.DB.prepare(
    `INSERT INTO subscriptions (id, customer_id, status, plan, price_id, item_id, amount, currency, started_at,
        current_period_end, cancel_at_period_end, cancel_at, canceled_at, payment_failed, updated_at, interval, offer_id)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, COALESCE(?14, ?15, 0), ?16, ?17, ?18)
     ON CONFLICT(id) DO UPDATE SET
       customer_id = excluded.customer_id,
       status = excluded.status,
       plan = excluded.plan,
       price_id = excluded.price_id,
       item_id = excluded.item_id,
       amount = excluded.amount,
       currency = excluded.currency,
       started_at = excluded.started_at,
       current_period_end = excluded.current_period_end,
       cancel_at_period_end = excluded.cancel_at_period_end,
       cancel_at = excluded.cancel_at,
       canceled_at = excluded.canceled_at,
       payment_failed = COALESCE(?14, ?15, subscriptions.payment_failed),
       updated_at = excluded.updated_at,
       interval = COALESCE(excluded.interval, subscriptions.interval),
       offer_id = COALESCE(excluded.offer_id, subscriptions.offer_id)`,
  )
    .bind(
      sub.id,
      customerId,
      sub.status,
      planForPriceId(env, priceId),
      priceId,
      item?.id ?? null,
      amount,
      item?.price?.currency ?? null,
      sub.start_date ?? sub.created ?? null,
      subscriptionPeriodEnd(sub),
      sub.cancel_at_period_end ? 1 : 0,
      sub.cancel_at ?? null,
      sub.canceled_at ?? null,
      pf,
      statusFailed,
      now,
      item?.price?.recurring?.interval ?? null,
      offerIdOf(sub),
    )
    .run();
}

function offerIdOf(sub: StripeSubscription): number | null {
  const n = Number.parseInt(sub.metadata?.veyro_offer ?? '', 10);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

export async function setPaymentFailed(db: D1Database, subId: string, failed: boolean): Promise<void> {
  await db
    .prepare('UPDATE subscriptions SET payment_failed = ?, updated_at = ? WHERE id = ?')
    .bind(failed ? 1 : 0, nowSec(), subId)
    .run();
}

/** Kundens "aktuelle" abonnement: et ikke-afsluttet foretrækkes, ellers det nyeste. */
export async function getCurrentSubscription(db: D1Database, customerId: number): Promise<SubscriptionRow | null> {
  return db
    .prepare(
      `SELECT * FROM subscriptions WHERE customer_id = ?
       ORDER BY (status IN ('active','trialing','past_due','unpaid','incomplete')) DESC,
                COALESCE(started_at, 0) DESC
       LIMIT 1`,
    )
    .bind(customerId)
    .first<SubscriptionRow>();
}

export { idOf };

// ---------- Henvendelser ----------

export async function createRequest(
  db: D1Database,
  args: { customerId: number; type: string; title: string; description: string },
): Promise<number> {
  const now = nowSec();
  const r = await db
    .prepare(
      `INSERT INTO requests (customer_id, type, title, description, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'received', ?, ?) RETURNING id`,
    )
    .bind(args.customerId, args.type, args.title, args.description, now, now)
    .first<{ id: number }>();
  return r!.id;
}

export async function listRequestsForCustomer(db: D1Database, customerId: number): Promise<RequestRow[]> {
  const { results } = await db
    .prepare('SELECT * FROM requests WHERE customer_id = ? ORDER BY created_at DESC, id DESC LIMIT 200')
    .bind(customerId)
    .all<RequestRow>();
  return results;
}

export interface AdminRequestRow extends RequestRow {
  email: string;
  name: string | null;
}

export async function listAllRequests(db: D1Database, status: string | null): Promise<AdminRequestRow[]> {
  const sql = `SELECT r.*, c.email, c.name FROM requests r JOIN customers c ON c.id = r.customer_id
    ${status ? 'WHERE r.status = ?' : ''}
    ORDER BY (r.status = 'resolved') ASC, r.created_at DESC, r.id DESC LIMIT 500`;
  const stmt = db.prepare(sql);
  const { results } = await (status ? stmt.bind(status) : stmt).all<AdminRequestRow>();
  return results;
}

export async function updateRequestStatus(db: D1Database, id: number, status: string): Promise<boolean> {
  const r = await db
    .prepare('UPDATE requests SET status = ?, updated_at = ? WHERE id = ?')
    .bind(status, nowSec(), id)
    .run();
  return (r.meta.changes ?? 0) > 0;
}

// ---------- Rate limiting ----------

/**
 * Fast vindue-tæller. Returnerer true hvis handlingen er tilladt.
 * Nøgler bør være hashede, så der ikke gemmes rå IP-adresser.
 */
export async function rateLimit(db: D1Database, key: string, limit: number, windowSec: number): Promise<boolean> {
  const now = nowSec();
  const row = await db
    .prepare(
      `INSERT INTO rate_limits (key, count, reset_at) VALUES (?1, 1, ?2)
       ON CONFLICT(key) DO UPDATE SET
         count = CASE WHEN rate_limits.reset_at <= ?3 THEN 1 ELSE rate_limits.count + 1 END,
         reset_at = CASE WHEN rate_limits.reset_at <= ?3 THEN ?2 ELSE rate_limits.reset_at END
       RETURNING count`,
    )
    .bind(key, now + windowSec, now)
    .first<{ count: number }>();
  return (row?.count ?? 1) <= limit;
}

// ---------- Oprydning ----------

export async function cleanup(db: D1Database): Promise<void> {
  const now = nowSec();
  await db.batch([
    db.prepare('DELETE FROM login_tokens WHERE expires_at < ?').bind(now - 3600),
    db.prepare('DELETE FROM sessions WHERE expires_at < ?').bind(now),
    db.prepare('DELETE FROM rate_limits WHERE reset_at < ?').bind(now),
    db.prepare('DELETE FROM webhook_events WHERE received_at < ?').bind(now - 60 * 86400),
  ]);
}
