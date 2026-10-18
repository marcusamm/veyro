import type { Env } from '../env';
import { findOrCreateCustomer, parseKr, postWithFallback, vatRateId, type DraftForm, type InvoiceDraft, validateDraft } from './invoices';
import { StripeError, stripeRequest, type Params } from './stripe';

/**
 * Abonnementer, som admin opretter fra /admin/abonnementer.
 * Linjerne er månedspriser i kr. ekskl. moms; Stripe sender en faktura hver måned.
 */

export interface Offer {
  kind: 'pct' | 'kr';
  value: number; // procent (1-100) eller øre
}

export interface SubDraft extends InvoiceDraft {
  freeFirstMonth: boolean;
  offer: Offer | null;
}

export interface Coupon {
  name?: string | null;
  percent_off?: number | null;
  amount_off?: number | null;
}

export interface AdminSubscription {
  id: string;
  status: string;
  created: number;
  trial_end: number | null;
  cancel_at_period_end: boolean;
  cancel_at: number | null;
  current_period_end?: number;
  customer: { id: string; email: string | null; name: string | null } | string;
  discounts?: Array<string | { coupon?: Coupon | string; source?: { coupon?: Coupon | string } }>;
  metadata?: Record<string, string>;
  items: {
    data: Array<{
      id: string;
      quantity?: number;
      current_period_end?: number;
      price: { id: string; unit_amount: number | null; product: string | { id: string; name?: string }; currency: string };
    }>;
  };
}

/** Læser et tilbud fra formularen: rabat i kr. eller procent. Tomt felt = intet tilbud. */
export function parseOffer(kind: unknown, raw: unknown): { offer: Offer | null } | { error: string } {
  const s = typeof raw === 'string' ? raw.trim() : '';
  if (!s) return { offer: null };
  if (kind === 'pct') {
    const n = Number(s.replace(',', '.').replace('%', ''));
    if (!Number.isInteger(n) || n < 1 || n > 100) return { error: 'Rabat i procent skal være et helt tal fra 1 til 100.' };
    return { offer: { kind: 'pct', value: n } };
  }
  const oere = parseKr(s);
  if (oere === null) return { error: 'Skriv rabatten i kr., fx 500 eller 499,50.' };
  return { offer: { kind: 'kr', value: oere } };
}

export function validateSubDraft(
  f: DraftForm,
  body: Record<string, unknown>,
): { draft: SubDraft } | { error: string; field: string } {
  const v = validateDraft(f);
  if ('error' in v) return v;
  const o = parseOffer(body['offer_kind'], body['offer']);
  if ('error' in o) return { error: o.error, field: 'offer' };
  return { draft: { ...v.draft, freeFirstMonth: body['action'] === 'free', offer: o.offer } };
}

/** Samme dato næste måned (eller sidste dag i måneden), kl. 12 UTC. */
export function oneMonthFrom(unixSec: number): number {
  const d = new Date(unixSec * 1000);
  const y = d.getUTCFullYear();
  const m = d.getUTCMonth() + 1;
  const last = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
  return Math.floor(Date.UTC(y, m, Math.min(d.getUTCDate(), last), 12) / 1000);
}

/** Opretter en kupon, der giver rabat på et antal måneder (1 = kun næste faktura). */
async function createOfferCoupon(env: Env, offer: Offer, months: number, key: string): Promise<string> {
  const params: Params = {
    name: offer.kind === 'pct' ? `Tilbud ${offer.value} %` : `Tilbud ${(offer.value / 100).toLocaleString('da-DK')} kr.`,
    duration: months === 1 ? 'once' : 'repeating',
    'metadata[source]': 'veyro-admin',
  };
  if (months > 1) params.duration_in_months = months;
  if (offer.kind === 'pct') params.percent_off = offer.value;
  else {
    params.amount_off = offer.value;
    params.currency = 'dkk';
  }
  const coupon = await stripeRequest<{ id: string }>(env, 'POST', '/v1/coupons', params, { idempotencyKey: `${key}-coupon` });
  return coupon.id;
}

export async function createSubscription(env: Env, d: SubDraft, opts: { key: string; createdBy: string }): Promise<{ id: string }> {
  const customer = await findOrCreateCustomer(env, d.email, d.name, opts.key);
  const taxRate = d.addVat ? await vatRateId(env) : null;
  const now = Math.floor(Date.now() / 1000);

  const params: Params = {
    customer,
    currency: 'dkk',
    collection_method: 'send_invoice',
    days_until_due: d.daysUntilDue,
    'managed_payments[enabled]': 'false',
    'metadata[source]': 'veyro-admin',
    'metadata[created_by]': opts.createdBy,
  };
  if (d.memo) params.description = d.memo;
  if (taxRate) params['default_tax_rates[0]'] = taxRate;
  if (d.freeFirstMonth) params.trial_end = oneMonthFrom(now);

  for (const [i, l] of d.lines.entries()) {
    const product = await stripeRequest<{ id: string }>(
      env,
      'POST',
      '/v1/products',
      { name: l.description, 'metadata[source]': 'veyro-admin' },
      { idempotencyKey: `${opts.key}-product-${i}` },
    );
    params[`items[${i}][price_data][currency]`] = 'dkk';
    params[`items[${i}][price_data][product]`] = product.id;
    params[`items[${i}][price_data][unit_amount]`] = l.unitAmount;
    params[`items[${i}][price_data][recurring][interval]`] = 'month';
    params[`items[${i}][quantity]`] = l.quantity;
  }

  // Med gratis første måned dækker tilbuddet den første betalte måned (måned 2).
  if (d.offer) params['discounts[0][coupon]'] = await createOfferCoupon(env, d.offer, d.freeFirstMonth ? 2 : 1, opts.key);

  return postWithFallback<{ id: string }>(env, '/v1/subscriptions', params, 'managed_payments', `${opts.key}-subscription`);
}

export async function listAdminSubscriptions(env: Env): Promise<AdminSubscription[]> {
  // Stripe tillader højst 4 niveauer i expand, så produktnavne og kuponer hentes for sig.
  const res = await stripeRequest<{ data: AdminSubscription[] }>(env, 'GET', '/v1/subscriptions', {
    status: 'all',
    limit: 40,
    'expand[0]': 'data.customer',
    'expand[1]': 'data.discounts',
  });
  const subs = (res.data ?? []).filter((s) => s.status !== 'incomplete_expired');

  const productIds = [...new Set(subs.flatMap((s) => s.items.data.map((i) => (typeof i.price.product === 'string' ? i.price.product : i.price.product.id))))];
  const names = new Map<string, string>();
  for (let i = 0; i < productIds.length; i += 100) {
    const params: Params = { limit: 100 };
    productIds.slice(i, i + 100).forEach((id, n) => (params[`ids[${n}]`] = id));
    const list = await stripeRequest<{ data: Array<{ id: string; name: string }> }>(env, 'GET', '/v1/products', params).catch(() => ({ data: [] }));
    for (const p of list.data ?? []) names.set(p.id, p.name);
  }

  const coupons = new Map<string, Coupon>();
  for (const s of subs) {
    for (const d of s.discounts ?? []) {
      if (typeof d === 'string') continue;
      const c = d.coupon ?? d.source?.coupon;
      if (typeof c === 'string' && !coupons.has(c)) {
        coupons.set(c, await stripeRequest<Coupon>(env, 'GET', `/v1/coupons/${encodeURIComponent(c)}`).catch(() => ({ name: 'Rabat' })));
      }
    }
  }

  for (const s of subs) {
    for (const it of s.items.data) {
      const id = typeof it.price.product === 'string' ? it.price.product : it.price.product.id;
      it.price.product = { id, name: names.get(id) ?? (typeof it.price.product === 'string' ? undefined : it.price.product.name) };
    }
    s.discounts = (s.discounts ?? []).map((d) => {
      if (typeof d === 'string') return d;
      const c = d.coupon ?? d.source?.coupon;
      return { coupon: typeof c === 'string' ? coupons.get(c) : c };
    });
  }
  return subs;
}

export function isSubscriptionId(id: string): boolean {
  return /^sub_[A-Za-z0-9]{8,64}$/.test(id);
}

async function getSub(env: Env, id: string): Promise<AdminSubscription> {
  return stripeRequest<AdminSubscription>(env, 'GET', `/v1/subscriptions/${id}`);
}

/** Ny fast månedspris på én linje fra næste periode (ingen forholdsmæssig afregning). */
export async function changePrice(env: Env, subId: string, itemId: string, unitAmount: number): Promise<void> {
  const sub = await getSub(env, subId);
  const item = sub.items.data.find((i) => i.id === itemId);
  if (!item) throw new StripeError('Linjen findes ikke på abonnementet.', 400);
  const product = typeof item.price.product === 'string' ? item.price.product : item.price.product.id;
  await stripeRequest(env, 'POST', `/v1/subscriptions/${subId}`, {
    'items[0][id]': itemId,
    'items[0][price_data][currency]': item.price.currency || 'dkk',
    'items[0][price_data][product]': product,
    'items[0][price_data][unit_amount]': unitAmount,
    'items[0][price_data][recurring][interval]': 'month',
    proration_behavior: 'none',
  });
}

/** Rabat på næste faktura (én måned). Erstatter et evt. tidligere tilbud. */
export async function giveOffer(env: Env, subId: string, offer: Offer, key: string): Promise<void> {
  const sub = await getSub(env, subId);
  // I en gratis prøvemåned er næste faktura på 0 kr., så rabatten skal også dække måneden efter.
  const months = sub.status === 'trialing' ? 2 : 1;
  const coupon = await createOfferCoupon(env, offer, months, key);
  await stripeRequest(env, 'POST', `/v1/subscriptions/${subId}`, { 'discounts[0][coupon]': coupon });
}

export async function removeOffer(env: Env, subId: string): Promise<void> {
  await stripeRequest(env, 'POST', `/v1/subscriptions/${subId}`, { discounts: '' });
}

export async function setCancelAtPeriodEnd(env: Env, subId: string, cancel: boolean): Promise<void> {
  await stripeRequest(env, 'POST', `/v1/subscriptions/${subId}`, { cancel_at_period_end: cancel ? 'true' : 'false' });
}
