import type { Env } from '../env';
import { nowSec } from './crypto';
import { normalizeEmail, upsertCustomer } from './db';
import { parseKr, VAT_PERCENT, vatRateId } from './invoices';
import { idOf, StripeError, stripeRequest, type Params } from './stripe';
import { logError } from './errlog';
import { onOfferActivated } from './prospects';

/**
 * Tilbud med individuel pris → personligt betalingslink → Stripe Checkout (abonnement).
 *
 * Stripe Billing er det eneste system, der opkræver abonnementet. Hjemmesiden (veyro.dk) modtager kun
 * forespørgsler og opkræver intet, så samme ydelse ikke kan blive betalt to steder.
 *
 * Forløb:
 *  1. Admin opretter tilbuddet. Kunden og prisen oprettes i Stripe med det samme (fast Price-objekt),
 *     så beløbet ligger fast og ikke kan ændres via linket.
 *  2. Kunden åbner /tilbud/<token>, ser ydelse, pris, moms, interval og opsigelsesvilkår og godkender.
 *  3. Kunden sendes til en Stripe Checkout-session (mode=subscription) for netop den kunde og pris.
 *  4. Først når en verificeret webhook (checkout.session.completed / async_payment_succeeded) bekræfter
 *     tilmelding og første betaling, markeres tilbuddet og kunden som aktive.
 */

export type Interval = 'month' | 'year';
export type OfferStatus = 'open' | 'processing' | 'active' | 'withdrawn' | 'ended';

export interface OfferRow {
  id: number;
  token: string;
  email: string;
  name: string;
  company: string | null;
  cvr: string | null;
  phone: string | null;
  address: string | null;
  postal_code: string | null;
  city: string | null;
  service: string;
  description: string | null;
  amount: number;
  interval: Interval;
  setup_amount: number;
  setup_description: string | null;
  vat: number;
  setup_settled: number;
  first_charge_at: number | null;
  settled_note: string | null;
  status: OfferStatus;
  valid_until: number;
  stripe_customer_id: string | null;
  stripe_price_id: string | null;
  stripe_setup_price_id: string | null;
  checkout_gen: number;
  checkout_session_id: string | null;
  checkout_url: string | null;
  checkout_expires_at: number | null;
  subscription_id: string | null;
  accepted_at: number | null;
  activated_at: number | null;
  emailed_at: number | null;
  created_by: string;
  created_at: number;
  updated_at: number;
}

export const DEFAULT_VALID_DAYS = 14;
/** Stripe kræver mindst 48 timer til første opkrævning, når første periode allerede er betalt. */
export const MIN_FIRST_CHARGE_SEC = 2 * 86400 + 3600;
/** En Checkout-session gælder i 23 timer; linket på /tilbud/<token> laver en ny, når den er udløbet. */
export const CHECKOUT_TTL_SEC = 23 * 3600;

export const INTERVAL_LABEL: Record<Interval, { per: string; short: string; every: string; noun: string }> = {
  month: { per: 'pr. måned', short: '/md.', every: 'hver måned', noun: 'måned' },
  year: { per: 'pr. år', short: '/år', every: 'hvert år', noun: 'år' },
};

export function isInterval(v: unknown): v is Interval {
  return v === 'month' || v === 'year';
}

export function vatOf(net: number, vat: boolean | number): number {
  return vat ? Math.round((net * VAT_PERCENT) / 100) : 0;
}

/** Beløb kunden ser på tilbuddet (øre). */
export function offerTotals(o: Pick<OfferRow, 'amount' | 'setup_amount' | 'vat' | 'setup_settled' | 'first_charge_at'>) {
  const recurringVat = vatOf(o.amount, o.vat);
  const setup = o.setup_settled ? 0 : o.setup_amount;
  const setupVat = vatOf(setup, o.vat);
  const firstRecurring = o.first_charge_at ? 0 : o.amount + recurringVat;
  return {
    recurringNet: o.amount,
    recurringVat,
    recurringTotal: o.amount + recurringVat,
    setupNet: setup,
    setupVat,
    setupTotal: setup + setupVat,
    dueNow: firstRecurring + setup + setupVat,
  };
}

// ---------- Formular ----------

export interface OfferForm {
  email: string;
  name: string;
  company: string;
  cvr: string;
  phone: string;
  address: string;
  postal_code: string;
  city: string;
  service: string;
  description: string;
  price: string;
  interval: string;
  setup_price: string;
  setup_description: string;
  vat: boolean;
  setup_settled: boolean;
  first_charge: string; // yyyy-mm-dd eller tom
  settled_note: string;
  valid_days: string;
  confirm_existing: boolean;
}

export function readOfferForm(body: Record<string, unknown>): OfferForm {
  const str = (k: string) => (typeof body[k] === 'string' ? (body[k] as string).trim() : '');
  return {
    email: str('email'),
    name: str('name'),
    company: str('company'),
    cvr: str('cvr'),
    phone: str('phone'),
    address: str('address'),
    postal_code: str('postal_code'),
    city: str('city'),
    service: str('service'),
    description: str('description'),
    price: str('price'),
    interval: str('interval') || 'month',
    setup_price: str('setup_price'),
    setup_description: str('setup_description'),
    vat: body['vat'] === '1',
    setup_settled: body['setup_settled'] === '1',
    first_charge: str('first_charge'),
    settled_note: str('settled_note'),
    valid_days: str('valid_days') || String(DEFAULT_VALID_DAYS),
    confirm_existing: body['confirm_existing'] === '1',
  };
}

export interface OfferDraft {
  email: string;
  name: string;
  company: string | null;
  cvr: string | null;
  phone: string | null;
  address: string | null;
  postal_code: string | null;
  city: string | null;
  service: string;
  description: string | null;
  amount: number;
  interval: Interval;
  setup_amount: number;
  setup_description: string | null;
  vat: boolean;
  setup_settled: boolean;
  first_charge_at: number | null;
  settled_note: string | null;
  valid_until: number;
}

/** "2026-11-01" -> kl. 12 dansk tid den dag (unix-sekunder). */
export function parseDate(s: string): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) return null;
  const t = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 10, 0, 0);
  const d = new Date(t);
  if (d.getUTCMonth() !== Number(m[2]) - 1) return null;
  return Math.floor(t / 1000);
}

export function validateOffer(f: OfferForm, now = nowSec()): { draft: OfferDraft } | { error: string; field: string } {
  const opt = (s: string, max: number) => (s ? s.slice(0, max) : null);
  const email = normalizeEmail(f.email);
  if (!email) return { error: 'Skriv en gyldig e-mail til kunden.', field: 'email' };
  if (!f.name || f.name.length > 100) return { error: 'Skriv kontaktpersonens navn (højst 100 tegn).', field: 'name' };
  if (f.company.length > 120) return { error: 'Firmanavnet må højst være 120 tegn.', field: 'company' };
  const cvr = f.cvr.replace(/\s/g, '').replace(/^DK/i, '');
  if (cvr && !/^\d{8}$/.test(cvr)) return { error: 'CVR-nummeret skal være 8 cifre.', field: 'cvr' };
  if (f.phone.length > 40) return { error: 'Telefonnummeret er for langt.', field: 'phone' };
  if (f.address.length > 200 || f.city.length > 100) return { error: 'Adressen er for lang.', field: 'address' };
  if (f.postal_code && !/^\d{4}$/.test(f.postal_code)) return { error: 'Postnummeret skal være 4 cifre.', field: 'postal_code' };
  if (!f.service || f.service.length > 120) return { error: 'Skriv ydelsens navn (højst 120 tegn).', field: 'service' };
  if (f.description.length > 1000) return { error: 'Beskrivelsen må højst være 1000 tegn.', field: 'description' };
  const amount = parseKr(f.price);
  if (amount === null) return { error: 'Skriv en gyldig pris i kr. ekskl. moms, fx 1.500 eller 1499,50.', field: 'price' };
  if (amount < 300) return { error: 'Prisen skal være mindst 3 kr.', field: 'price' };
  if (!isInterval(f.interval)) return { error: 'Vælg månedlig eller årlig betaling.', field: 'interval' };
  let setup = 0;
  if (f.setup_price) {
    const s = parseKr(f.setup_price);
    if (s === null) return { error: 'Skriv et gyldigt engangsbeløb i kr. ekskl. moms.', field: 'setup_price' };
    setup = s;
    if (!f.setup_description || f.setup_description.length > 120) return { error: 'Skriv hvad engangsbeløbet dækker (højst 120 tegn), fx Oprettelse.', field: 'setup_description' };
  }
  if (f.setup_settled && !setup) return { error: 'Der er intet engangsbeløb at markere som betalt.', field: 'setup_settled' };
  let firstChargeAt: number | null = null;
  if (f.first_charge) {
    firstChargeAt = parseDate(f.first_charge);
    if (firstChargeAt === null) return { error: 'Skriv datoen for første opkrævning som åååå-mm-dd.', field: 'first_charge' };
    if (firstChargeAt < now + MIN_FIRST_CHARGE_SEC) return { error: 'Første opkrævning skal ligge mindst 3 dage ude i fremtiden.', field: 'first_charge' };
    if (firstChargeAt > now + 730 * 86400) return { error: 'Første opkrævning kan højst ligge 2 år ude i fremtiden.', field: 'first_charge' };
  }
  if ((f.setup_settled || firstChargeAt) && !f.settled_note) {
    return { error: 'Skriv hvilken faktura eller betaling, der allerede dækker beløbet (fx fakturanummer).', field: 'settled_note' };
  }
  if (f.settled_note.length > 200) return { error: 'Noten må højst være 200 tegn.', field: 'settled_note' };
  const days = Number.parseInt(f.valid_days, 10);
  if (!Number.isInteger(days) || days < 1 || days > 90) return { error: 'Linket skal gælde mellem 1 og 90 dage.', field: 'valid_days' };
  return {
    draft: {
      email,
      name: f.name,
      company: opt(f.company, 120),
      cvr: cvr || null,
      phone: opt(f.phone, 40),
      address: opt(f.address, 200),
      postal_code: opt(f.postal_code, 4),
      city: opt(f.city, 100),
      service: f.service,
      description: opt(f.description, 1000),
      amount,
      interval: f.interval,
      setup_amount: setup,
      setup_description: setup ? f.setup_description : null,
      vat: f.vat,
      setup_settled: f.setup_settled,
      first_charge_at: firstChargeAt,
      settled_note: opt(f.settled_note, 200),
      valid_until: now + days * 86400,
    },
  };
}

// ---------- Database ----------

export function newToken(): string {
  const b = crypto.getRandomValues(new Uint8Array(32));
  return btoa(String.fromCharCode(...b)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function isToken(t: string): boolean {
  return /^[A-Za-z0-9_-]{43}$/.test(t);
}

export async function getOffer(db: D1Database, id: number): Promise<OfferRow | null> {
  return db.prepare('SELECT * FROM offers WHERE id = ?').bind(id).first<OfferRow>();
}

export async function getOfferByToken(db: D1Database, token: string): Promise<OfferRow | null> {
  if (!isToken(token)) return null;
  return db.prepare('SELECT * FROM offers WHERE token = ?').bind(token).first<OfferRow>();
}

export async function listOffers(db: D1Database, email?: string): Promise<OfferRow[]> {
  const stmt = email
    ? db.prepare('SELECT * FROM offers WHERE email = ? ORDER BY created_at DESC, id DESC LIMIT 100').bind(email)
    : db.prepare('SELECT * FROM offers ORDER BY created_at DESC, id DESC LIMIT 200');
  return (await stmt.all<OfferRow>()).results;
}

export function offerLink(env: Env, o: Pick<OfferRow, 'token'>): string {
  return `${env.APP_URL.replace(/\/+$/, '')}/tilbud/${o.token}`;
}

/** Visningsstatus: et åbent tilbud efter gyldighedsdatoen er udløbet. */
export function offerState(o: OfferRow, now = nowSec()): 'open' | 'expired' | Exclude<OfferStatus, 'open'> {
  if (o.status === 'open' && o.valid_until < now) return 'expired';
  return o.status;
}

// ---------- Tjek for dobbelt fakturering ----------

export interface ExistingBilling {
  subscriptions: Array<{ id: string; status: string; amount: number; interval: string | null }>;
  invoices: Array<{ id: string; number: string | null; status: string | null; total: number; created: number }>;
  offers: Array<{ id: number; service: string; status: string }>;
}

/**
 * Finder løbende abonnementer, fakturaer fra de sidste 90 dage og andre aktive tilbud til samme kunde,
 * så admin tager stilling, før der oprettes et nyt betalingslink.
 */
export async function existingBilling(env: Env, email: string, stripeCustomerId: string | null): Promise<ExistingBilling> {
  const out: ExistingBilling = { subscriptions: [], invoices: [], offers: [] };
  const { results } = await env.DB.prepare(
    "SELECT id, service, status FROM offers WHERE email = ? AND status IN ('open','processing','active') ORDER BY id DESC LIMIT 20",
  )
    .bind(email)
    .all<{ id: number; service: string; status: string }>();
  out.offers = results;
  if (!stripeCustomerId) return out;
  const subs = await stripeRequest<{ data: Array<{ id: string; status: string; items: { data: Array<{ quantity?: number; price: { unit_amount: number | null; recurring?: { interval: string } | null } }> } }> }>(
    env,
    'GET',
    '/v1/subscriptions',
    { customer: stripeCustomerId, status: 'all', limit: 20 },
  );
  out.subscriptions = (subs.data ?? [])
    .filter((s) => ['active', 'trialing', 'past_due', 'unpaid', 'incomplete', 'paused'].includes(s.status))
    .map((s) => ({
      id: s.id,
      status: s.status,
      amount: s.items.data.reduce((sum, i) => sum + (i.price.unit_amount ?? 0) * (i.quantity ?? 1), 0),
      interval: s.items.data[0]?.price.recurring?.interval ?? null,
    }));
  const since = nowSec() - 90 * 86400;
  const inv = await stripeRequest<{ data: Array<{ id: string; number: string | null; status: string | null; total: number; created: number }> }>(
    env,
    'GET',
    '/v1/invoices',
    { customer: stripeCustomerId, limit: 20, 'created[gte]': since },
  );
  out.invoices = (inv.data ?? [])
    .filter((i) => i.created >= since && ['open', 'paid'].includes(i.status ?? ''))
    .map((i) => ({ id: i.id, number: i.number, status: i.status, total: i.total, created: i.created }));
  return out;
}

export function hasExisting(e: ExistingBilling): boolean {
  return e.subscriptions.length > 0 || e.invoices.length > 0 || e.offers.length > 0;
}

// ---------- Stripe: kunde og fast pris ----------

/** Finder kunden i Stripe på e-mail (eller opretter den) og opdaterer navn, adresse og CVR. */
export async function ensureStripeCustomer(env: Env, d: OfferDraft, key: string): Promise<string> {
  const found = await stripeRequest<{ data: Array<{ id: string }> }>(env, 'GET', '/v1/customers', { email: d.email, limit: 1 });
  const params: Params = {
    name: d.company ?? d.name,
    email: d.email,
    'preferred_locales[0]': 'da',
    'metadata[source]': 'veyro-tilbud',
    'metadata[contact_name]': d.name,
    'metadata[cvr]': d.cvr ?? '',
  };
  if (d.phone) params.phone = d.phone;
  if (d.address) {
    params['address[line1]'] = d.address;
    params['address[postal_code]'] = d.postal_code ?? '';
    params['address[city]'] = d.city ?? '';
    params['address[country]'] = 'DK';
  }
  const existing = found.data?.[0];
  if (existing) {
    await stripeRequest(env, 'POST', `/v1/customers/${existing.id}`, params);
    return existing.id;
  }
  const created = await stripeRequest<{ id: string }>(env, 'POST', '/v1/customers', params, { idempotencyKey: `${key}-customer` });
  if (d.cvr) {
    // CVR som momsnummer på fakturaerne. Afviser Stripe det, fortsætter vi uden (CVR står også i metadata).
    await stripeRequest(env, 'POST', `/v1/customers/${created.id}/tax_ids`, { type: 'eu_vat', value: `DK${d.cvr}` }, { idempotencyKey: `${key}-taxid` }).catch(
      () => undefined,
    );
  }
  return created.id;
}

/** Opretter ydelsen og den faste pris i Stripe. Beløbet kan derefter ikke ændres via betalingslinket. */
export async function createOfferPrices(env: Env, d: OfferDraft, key: string): Promise<{ priceId: string; setupPriceId: string | null }> {
  const product = await stripeRequest<{ id: string }>(
    env,
    'POST',
    '/v1/products',
    { name: d.service, 'metadata[source]': 'veyro-tilbud', ...(d.description ? { description: d.description.slice(0, 500) } : {}) },
    { idempotencyKey: `${key}-product` },
  );
  const price = await stripeRequest<{ id: string }>(
    env,
    'POST',
    '/v1/prices',
    {
      product: product.id,
      currency: 'dkk',
      unit_amount: d.amount,
      'recurring[interval]': d.interval,
      tax_behavior: 'exclusive',
      'metadata[source]': 'veyro-tilbud',
    },
    { idempotencyKey: `${key}-price` },
  );
  let setupPriceId: string | null = null;
  if (d.setup_amount && !d.setup_settled) {
    const sp = await stripeRequest<{ id: string }>(
      env,
      'POST',
      '/v1/prices',
      {
        currency: 'dkk',
        unit_amount: d.setup_amount,
        tax_behavior: 'exclusive',
        'product_data[name]': d.setup_description ?? 'Oprettelse',
        'metadata[source]': 'veyro-tilbud',
      },
      { idempotencyKey: `${key}-setup-price` },
    );
    setupPriceId = sp.id;
  }
  return { priceId: price.id, setupPriceId };
}

/** Opretter tilbuddet (kunde + priser i Stripe, række i D1). `key` gør dobbelt indsendelse harmløs. */
export async function createOffer(env: Env, d: OfferDraft, opts: { key: string; createdBy: string; stripeCustomerId: string }): Promise<OfferRow> {
  const dup = await env.DB.prepare('SELECT id FROM offers WHERE form_key = ?').bind(opts.key).first<{ id: number }>();
  if (dup) return (await getOffer(env.DB, dup.id))!;
  const prices = await createOfferPrices(env, d, opts.key);
  const now = nowSec();
  const row = await env.DB.prepare(
    `INSERT INTO offers (form_key, token, email, name, company, cvr, phone, address, postal_code, city, service, description, amount, interval,
       setup_amount, setup_description, vat, setup_settled, first_charge_at, settled_note, status, valid_until,
       stripe_customer_id, stripe_price_id, stripe_setup_price_id, created_by, created_at, updated_at)
     VALUES (?26, ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19, 'open', ?20, ?21, ?22, ?23, ?24, ?25, ?25)
     ON CONFLICT(form_key) DO UPDATE SET updated_at = offers.updated_at
     RETURNING id`,
  )
    .bind(
      newToken(),
      d.email,
      d.name,
      d.company,
      d.cvr,
      d.phone,
      d.address,
      d.postal_code,
      d.city,
      d.service,
      d.description,
      d.amount,
      d.interval,
      d.setup_amount,
      d.setup_description,
      d.vat ? 1 : 0,
      d.setup_settled ? 1 : 0,
      d.first_charge_at,
      d.settled_note,
      d.valid_until,
      opts.stripeCustomerId,
      prices.priceId,
      prices.setupPriceId,
      opts.createdBy,
      now,
      opts.key,
    )
    .first<{ id: number }>();
  return (await getOffer(env.DB, row!.id))!;
}

export async function withdrawOffer(env: Env, o: OfferRow): Promise<void> {
  if (o.status !== 'open') throw new StripeError('Kun åbne tilbud kan trækkes tilbage.', 400);
  await expireOpenSession(env, o);
  await env.DB.prepare("UPDATE offers SET status = 'withdrawn', checkout_session_id = NULL, checkout_url = NULL, checkout_expires_at = NULL, updated_at = ? WHERE id = ? AND status = 'open'")
    .bind(nowSec(), o.id)
    .run();
}

export async function extendOffer(env: Env, o: OfferRow, days = DEFAULT_VALID_DAYS): Promise<void> {
  if (o.status !== 'open') throw new StripeError('Kun åbne tilbud kan forlænges.', 400);
  await env.DB.prepare('UPDATE offers SET valid_until = ?, updated_at = ? WHERE id = ?').bind(nowSec() + days * 86400, nowSec(), o.id).run();
}

async function expireOpenSession(env: Env, o: OfferRow): Promise<void> {
  if (!o.checkout_session_id) return;
  try {
    await stripeRequest(env, 'POST', `/v1/checkout/sessions/${o.checkout_session_id}/expire`);
  } catch (err) {
    // Allerede udløbet eller gennemført: det sidste fanges af webhooken.
    if (!(err instanceof StripeError && err.status === 400)) throw err;
  }
}

// ---------- Stripe Checkout ----------

interface CheckoutSession {
  id: string;
  url: string | null;
  status: 'open' | 'complete' | 'expired' | null;
  payment_status?: string;
  expires_at?: number;
  mode?: string;
  customer?: string | { id: string } | null;
  subscription?: string | { id: string } | null;
  metadata?: Record<string, string>;
}

function checkoutText(o: OfferRow): string {
  const iv = INTERVAL_LABEL[o.interval];
  const t = offerTotals(o);
  const kr = (n: number) => (n / 100).toLocaleString('da-DK', { minimumFractionDigits: n % 100 ? 2 : 0, maximumFractionDigits: 2 }) + ' kr.';
  const first = o.first_charge_at
    ? ` Første periode er allerede betalt; første opkrævning sker ${new Date(o.first_charge_at * 1000).toLocaleDateString('da-DK', { timeZone: 'Europe/Copenhagen' })}.`
    : '';
  return (
    `Løbende abonnement: ${o.service}, ${kr(t.recurringNet)} ekskl. moms (${kr(t.recurringTotal)} inkl. moms) ${iv.per}. ` +
    `Betalingen trækkes automatisk ${iv.every}, til du opsiger.${first} ` +
    'Du kan opsige når som helst i kundepanelet på kunde.veyro.dk. Abonnementet stopper ved udgangen af den betalte periode.'
  ).slice(0, 1200);
}

async function createSession(env: Env, o: OfferRow, gen: number): Promise<CheckoutSession> {
  const base = env.APP_URL.replace(/\/+$/, '');
  const now = nowSec();
  const params: Params = {
    mode: 'subscription',
    customer: o.stripe_customer_id,
    client_reference_id: `offer-${o.id}`,
    locale: 'da',
    'line_items[0][price]': o.stripe_price_id,
    'line_items[0][quantity]': 1,
    billing_address_collection: 'required',
    'customer_update[address]': 'auto',
    'customer_update[name]': 'auto',
    payment_method_collection: 'always',
    expires_at: now + CHECKOUT_TTL_SEC,
    success_url: `${base}/tilbud/${o.token}/tak?session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${base}/tilbud/${o.token}`,
    'metadata[veyro_offer]': String(o.id),
    'subscription_data[metadata][veyro_offer]': String(o.id),
    'subscription_data[metadata][source]': 'veyro-tilbud',
    'subscription_data[description]': o.service.slice(0, 500),
    'custom_text[submit][message]': checkoutText(o),
    'managed_payments[enabled]': 'false',
    'branding_settings[display_name]': 'Veyro',
    'branding_settings[background_color]': '#F4F2EC',
    'branding_settings[button_color]': '#FF5A1F',
    'branding_settings[border_style]': 'rounded',
    'branding_settings[font_family]': 'inter',
    'branding_settings[logo][type]': 'url',
    'branding_settings[logo][url]': `${base}/static/logo.png`,
    'branding_settings[icon][type]': 'url',
    'branding_settings[icon][url]': `${base}/static/icon.png`,
  };
  const tax = o.vat ? await vatRateId(env) : null;
  if (tax) params['line_items[0][tax_rates][0]'] = tax;
  if (o.stripe_setup_price_id && !o.setup_settled) {
    params['line_items[1][price]'] = o.stripe_setup_price_id;
    params['line_items[1][quantity]'] = 1;
    if (tax) params['line_items[1][tax_rates][0]'] = tax;
  }
  if (o.first_charge_at) params['subscription_data[trial_end]'] = o.first_charge_at;

  // Samme nøgle for samme "generation", så to samtidige klik giver samme session.
  const key = `offer-${o.id}-cs-${gen}`;
  let p = params;
  for (let attempt = 0; ; attempt++) {
    try {
      return await stripeRequest<CheckoutSession>(env, 'POST', '/v1/checkout/sessions', p, { idempotencyKey: attempt ? `${key}-${attempt}` : key });
    } catch (err) {
      // Valgfrie felter (udseende, sprog, managed payments), som en ældre API-version ikke kender, droppes hellere end at betalingen ikke kan åbnes.
      const opt =
        err instanceof StripeError && err.status === 400 && attempt < 3
          ? ['branding_settings', 'managed_payments', 'custom_text', 'locale'].find((k) => err.message.includes(k))
          : undefined;
      if (!opt) throw err;
      p = Object.fromEntries(Object.entries(p).filter(([k]) => !k.startsWith(opt)));
    }
  }
}

export type CheckoutResult = { url: string } | { state: 'active' | 'processing' | 'expired' | 'withdrawn' | 'ended' | 'busy' | 'first-charge-passed' };

/**
 * Giver kunden én gyldig Checkout-session til tilbuddet. En åben session genbruges; en udløbet
 * erstattes. Gentagne klik (også samtidige) fører til samme session, så der ikke opstår dobbelte abonnementer.
 */
export async function checkoutForOffer(env: Env, offerId: number, now = nowSec()): Promise<CheckoutResult> {
  for (let round = 0; round < 12; round++) {
    const o = await getOffer(env.DB, offerId);
    if (!o) return { state: 'withdrawn' };
    const st = offerState(o, now);
    if (st !== 'open') return { state: st };
    if (o.first_charge_at && o.first_charge_at < now + 48 * 3600) return { state: 'first-charge-passed' };

    if (o.checkout_session_id) {
      const cs = await stripeRequest<CheckoutSession>(env, 'GET', `/v1/checkout/sessions/${o.checkout_session_id}`);
      if (cs.status === 'complete') {
        // Betalingen er gennemført i Stripe, men webhooken er ikke nået frem endnu.
        await env.DB.prepare("UPDATE offers SET status = 'processing', accepted_at = COALESCE(accepted_at, ?), updated_at = ? WHERE id = ? AND status = 'open'")
          .bind(now, now, o.id)
          .run();
        return { state: 'processing' };
      }
      if (cs.status === 'open' && cs.url && (cs.expires_at ?? o.checkout_expires_at ?? 0) > now + 600) return { url: cs.url };
      if (cs.status === 'open') await expireOpenSession(env, o);
    }

    // Kun den forespørgsel, der får "generationen", opretter en ny session.
    const claimed = await env.DB.prepare(
      `UPDATE offers SET checkout_gen = checkout_gen + 1, checkout_session_id = NULL, checkout_url = NULL, checkout_expires_at = NULL, updated_at = ?
       WHERE id = ? AND checkout_gen = ? RETURNING checkout_gen`,
    )
      .bind(now, o.id, o.checkout_gen)
      .first<{ checkout_gen: number }>();
    if (!claimed) {
      // En anden forespørgsel er i gang: vent på dens session.
      await new Promise((r) => setTimeout(r, 400));
      const again = await getOffer(env.DB, offerId);
      if (again?.checkout_url && again.checkout_gen > o.checkout_gen) return { url: again.checkout_url };
      continue;
    }
    const cs = await createSession(env, o, claimed.checkout_gen);
    await env.DB.prepare('UPDATE offers SET checkout_session_id = ?, checkout_url = ?, checkout_expires_at = ?, updated_at = ? WHERE id = ? AND checkout_gen = ?')
      .bind(cs.id, cs.url, cs.expires_at ?? now + CHECKOUT_TTL_SEC, now, o.id, claimed.checkout_gen)
      .run();
    if (!cs.url) throw new StripeError('Stripe returnerede ingen betalingsside.', 502);
    return { url: cs.url };
  }
  return { state: 'busy' };
}

// ---------- Webhooks ----------

export type ActivationOutcome = { kind: 'ignored' } | { kind: 'activated' | 'processing' | 'already'; offer: OfferRow; subId: string } | { kind: 'duplicate'; offer: OfferRow; subId: string };

/**
 * Kaldes fra checkout.session.completed og checkout.session.async_payment_succeeded.
 * Sessionen hentes frisk fra Stripe; hændelsens indhold stoles ikke på alene.
 */
export async function activateFromSession(env: Env, sessionId: string): Promise<ActivationOutcome> {
  const cs = await stripeRequest<CheckoutSession>(env, 'GET', `/v1/checkout/sessions/${encodeURIComponent(sessionId)}`);
  const offerId = Number.parseInt(cs.metadata?.veyro_offer ?? '', 10);
  if (cs.mode !== 'subscription' || !Number.isSafeInteger(offerId) || cs.status !== 'complete') return { kind: 'ignored' };
  const o = await getOffer(env.DB, offerId);
  if (!o) return { kind: 'ignored' };
  const subId = idOf(cs.subscription);
  if (!subId || idOf(cs.customer) !== o.stripe_customer_id) {
    throw new StripeError(`Checkout-session ${cs.id} passer ikke til tilbud ${o.id}`, 400);
  }
  // Højst ét abonnement pr. tilbud: et andet abonnement på samme tilbud er en dublet.
  if (o.subscription_id && o.subscription_id !== subId) return { kind: 'duplicate', offer: o, subId };

  const paid = cs.payment_status === 'paid' || cs.payment_status === 'no_payment_required';
  const now = nowSec();
  const res = await env.DB.prepare(
    `UPDATE offers SET subscription_id = ?1,
       status = CASE WHEN ?2 = 1 THEN 'active' WHEN status = 'active' THEN 'active' ELSE 'processing' END,
       accepted_at = COALESCE(accepted_at, ?3),
       activated_at = CASE WHEN ?2 = 1 THEN COALESCE(activated_at, ?3) ELSE activated_at END,
       updated_at = ?3
     WHERE id = ?4 AND (subscription_id IS NULL OR subscription_id = ?1)`,
  )
    .bind(subId, paid ? 1 : 0, now, o.id)
    .run();
  if (!res.meta.changes) return { kind: 'duplicate', offer: o, subId };

  const customer = await upsertCustomer(env.DB, { email: o.email, name: o.name, stripeCustomerId: o.stripe_customer_id });
  await env.DB.prepare(
    `UPDATE customers SET company = COALESCE(?, company), cvr = COALESCE(?, cvr), phone = COALESCE(?, phone),
       address = COALESCE(?, address), postal_code = COALESCE(?, postal_code), city = COALESCE(?, city), updated_at = ? WHERE id = ?`,
  )
    .bind(o.company, o.cvr, o.phone, o.address, o.postal_code, o.city, now, customer.id)
    .run();
  const updated = (await getOffer(env.DB, o.id))!;
  if (!paid) return { kind: 'processing', offer: updated, subId };
  // Tilbud fra et kundeemne: knyt emnet til den nye kunde (historik, tid og udgifter følger med)
  await onOfferActivated(env.DB, o.id, customer.id).catch((err) => logError(env.DB, 'kundeemne.tilbud-betalt', err));
  return { kind: o.status === 'active' ? 'already' : 'activated', offer: updated, subId };
}

/** Annullerer et abonnement, der er opstået som dublet på et allerede betalt tilbud. */
export async function cancelDuplicate(env: Env, subId: string): Promise<void> {
  await stripeRequest(env, 'DELETE', `/v1/subscriptions/${subId}`, { prorate: 'false', invoice_now: 'false' });
}

export async function onSessionExpired(env: Env, sessionId: string): Promise<void> {
  await env.DB.prepare('UPDATE offers SET checkout_session_id = NULL, checkout_url = NULL, checkout_expires_at = NULL, updated_at = ? WHERE checkout_session_id = ?')
    .bind(nowSec(), sessionId)
    .run();
}

export async function onAsyncPaymentFailed(env: Env, sessionId: string): Promise<OfferRow | null> {
  const o = await env.DB.prepare('SELECT * FROM offers WHERE checkout_session_id = ?').bind(sessionId).first<OfferRow>();
  if (!o || o.status === 'active') return null;
  await env.DB.prepare(
    "UPDATE offers SET status = 'open', subscription_id = NULL, checkout_session_id = NULL, checkout_url = NULL, checkout_expires_at = NULL, updated_at = ? WHERE id = ?",
  )
    .bind(nowSec(), o.id)
    .run();
  return o;
}

export async function onSubscriptionEnded(env: Env, subId: string): Promise<void> {
  await env.DB.prepare("UPDATE offers SET status = 'ended', updated_at = ? WHERE subscription_id = ? AND status IN ('active','processing')")
    .bind(nowSec(), subId)
    .run();
}

export async function getOfferBySubscription(db: D1Database, subId: string): Promise<OfferRow | null> {
  return db.prepare('SELECT * FROM offers WHERE subscription_id = ?').bind(subId).first<OfferRow>();
}

// ---------- Betalingshistorik ----------

export interface PaymentRow {
  invoice_id: string;
  stripe_customer_id: string | null;
  subscription_id: string | null;
  number: string | null;
  status: 'paid' | 'failed' | 'open' | 'void';
  amount_due: number | null;
  amount_paid: number | null;
  currency: string | null;
  attempt_count: number | null;
  billing_reason: string | null;
  period_start: number | null;
  period_end: number | null;
  next_attempt_at: number | null;
  hosted_invoice_url: string | null;
  invoice_pdf: string | null;
  created: number | null;
  updated_at: number;
}

/** Gemmer en faktura fra en webhook. En betalt faktura bliver ikke "fejlet" igen af en sen hændelse. */
export async function recordInvoice(env: Env, inv: any, status: PaymentRow['status'], subId: string | null): Promise<PaymentRow['status']> {
  const line = inv?.lines?.data?.find((l: any) => l?.period) ?? inv?.lines?.data?.[0];
  const row = await env.DB.prepare(
    `INSERT INTO payments (invoice_id, stripe_customer_id, subscription_id, number, status, amount_due, amount_paid, currency, attempt_count,
        billing_reason, period_start, period_end, next_attempt_at, hosted_invoice_url, invoice_pdf, created, updated_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17)
     ON CONFLICT(invoice_id) DO UPDATE SET
       status = CASE WHEN payments.status IN ('paid','void') AND excluded.status IN ('failed','open') THEN payments.status ELSE excluded.status END,
       number = COALESCE(excluded.number, payments.number),
       amount_due = excluded.amount_due,
       amount_paid = MAX(COALESCE(excluded.amount_paid, 0), COALESCE(payments.amount_paid, 0)),
       attempt_count = MAX(COALESCE(excluded.attempt_count, 0), COALESCE(payments.attempt_count, 0)),
       next_attempt_at = excluded.next_attempt_at,
       hosted_invoice_url = COALESCE(excluded.hosted_invoice_url, payments.hosted_invoice_url),
       invoice_pdf = COALESCE(excluded.invoice_pdf, payments.invoice_pdf),
       subscription_id = COALESCE(excluded.subscription_id, payments.subscription_id),
       updated_at = excluded.updated_at
     RETURNING status`,
  )
    .bind(
      String(inv.id),
      idOf(inv.customer),
      subId,
      inv.number ?? null,
      status,
      inv.amount_due ?? inv.total ?? null,
      inv.amount_paid ?? null,
      inv.currency ?? null,
      inv.attempt_count ?? null,
      inv.billing_reason ?? null,
      line?.period?.start ?? inv.period_start ?? null,
      line?.period?.end ?? inv.period_end ?? null,
      status === 'failed' ? (inv.next_payment_attempt ?? null) : null,
      inv.hosted_invoice_url ?? null,
      inv.invoice_pdf ?? null,
      inv.created ?? null,
      nowSec(),
    )
    .first<{ status: PaymentRow['status'] }>();
  return row?.status ?? status;
}

export async function listPayments(db: D1Database, stripeCustomerId: string): Promise<PaymentRow[]> {
  return (
    await db.prepare('SELECT * FROM payments WHERE stripe_customer_id = ? ORDER BY COALESCE(created, 0) DESC LIMIT 100').bind(stripeCustomerId).all<PaymentRow>()
  ).results;
}

// ---------- Prisændring for én kunde ----------

interface PriceSub {
  id: string;
  status: string;
  schedule?: string | { id: string } | null;
  billing_cycle_anchor?: number;
  current_period_end?: number;
  customer: string | { id: string };
  items: {
    data: Array<{
      id: string;
      quantity?: number;
      current_period_end?: number;
      current_period_start?: number;
      tax_rates?: Array<{ id: string }>;
      price: { id: string; unit_amount: number | null; currency: string; product: string | { id: string }; recurring?: { interval: string } | null };
    }>;
  };
}

/** Næste fornyelsesdatoer (samme dag i måneden som abonnementets ankerdato, som Stripe gør). */
export function renewalDates(periodEnd: number, interval: Interval, count: number, anchor?: number): number[] {
  const end = new Date(periodEnd * 1000);
  const anchorDay = new Date((anchor ?? periodEnd) * 1000).getUTCDate();
  const out = [periodEnd];
  for (let k = 1; k < count; k++) {
    const y = end.getUTCFullYear() + (interval === 'year' ? k : 0);
    const m = end.getUTCMonth() + (interval === 'month' ? k : 0);
    const last = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
    out.push(Math.floor(Date.UTC(y, m, Math.min(anchorDay, last), end.getUTCHours(), end.getUTCMinutes(), end.getUTCSeconds()) / 1000));
  }
  return out;
}

export function recurringItem(sub: PriceSub) {
  return sub.items.data.find((i) => i.price.recurring) ?? sub.items.data[0];
}

export async function getPriceSub(env: Env, subId: string): Promise<PriceSub> {
  return stripeRequest<PriceSub>(env, 'GET', `/v1/subscriptions/${subId}`);
}

export function periodEndOf(sub: PriceSub): number | null {
  const it = recurringItem(sub);
  return sub.current_period_end ?? it?.current_period_end ?? null;
}

export interface PriceChangeRow {
  id: number;
  subscription_id: string;
  old_amount: number | null;
  new_amount: number;
  interval: string | null;
  effective_at: number;
  schedule_id: string | null;
  status: 'scheduled' | 'canceled';
  notified_at: number | null;
  created_by: string;
  created_at: number;
}

export async function listPriceChanges(db: D1Database, subIds: string[]): Promise<PriceChangeRow[]> {
  if (!subIds.length) return [];
  const q = subIds.map(() => '?').join(',');
  return (
    await db
      .prepare(`SELECT * FROM price_changes WHERE subscription_id IN (${q}) ORDER BY created_at DESC, id DESC LIMIT 50`)
      .bind(...subIds)
      .all<PriceChangeRow>()
  ).results;
}

/**
 * Ny pris for ét abonnement uden forholdsmæssig afregning.
 * effectiveAt = null: fra næste betalingsperiode. Ellers en senere fornyelsesdato (via et Stripe-abonnementsskema).
 * Andre kunders priser påvirkes ikke, fordi der altid oprettes en ny Price til netop dette abonnement.
 */
export async function changeSubscriptionPrice(
  env: Env,
  subId: string,
  newAmount: number,
  effectiveAt: number | null,
  opts: { key: string; createdBy: string },
): Promise<{ effectiveAt: number; oldAmount: number | null; interval: Interval; changeId: number }> {
  let sub = await getPriceSub(env, subId);
  if (!['active', 'trialing', 'past_due'].includes(sub.status)) throw new StripeError('Prisen kan kun ændres på et aktivt abonnement.', 400);
  const item = recurringItem(sub);
  if (!item) throw new StripeError('Abonnementet har ingen linje.', 400);
  const interval: Interval = item.price.recurring?.interval === 'year' ? 'year' : 'month';
  const periodEnd = periodEndOf(sub);
  if (!periodEnd) throw new StripeError('Abonnementets næste betalingsdato er ukendt.', 400);
  const allowed = renewalDates(periodEnd, interval, 12, sub.billing_cycle_anchor);
  if (effectiveAt !== null && !allowed.includes(effectiveAt)) throw new StripeError('Vælg en af abonnementets fornyelsesdatoer.', 400);
  const target = effectiveAt ?? periodEnd;

  // En tidligere planlagt prisændring erstattes af den nye.
  const scheduleId = idOf(sub.schedule ?? null);
  if (scheduleId) {
    await stripeRequest(env, 'POST', `/v1/subscription_schedules/${scheduleId}/release`, {}, { idempotencyKey: `${opts.key}-release` });
    sub = await getPriceSub(env, subId);
  }
  // Det beløb, kunden betaler nu: en endnu ikke trådt i kraft ændring tæller ikke.
  const pendingOld = await env.DB.prepare(
    "SELECT old_amount, old_price_id FROM price_changes WHERE subscription_id = ? AND status = 'scheduled' AND effective_at > ? ORDER BY id ASC LIMIT 1",
  )
    .bind(subId, nowSec())
    .first<{ old_amount: number | null; old_price_id: string | null }>();
  await env.DB.prepare("UPDATE price_changes SET status = 'canceled' WHERE subscription_id = ? AND status = 'scheduled' AND effective_at > ?")
    .bind(subId, nowSec())
    .run();

  const cur = recurringItem(sub)!;
  // Er en ændring til "næste periode" allerede lagt på abonnementet, er det stadig den gamle pris, der gælder nu.
  const currentPriceId = pendingOld?.old_price_id ?? cur.price.id;
  const product = idOf(cur.price.product)!;
  const price = await stripeRequest<{ id: string }>(
    env,
    'POST',
    '/v1/prices',
    { product, currency: cur.price.currency || 'dkk', unit_amount: newAmount, 'recurring[interval]': interval, tax_behavior: 'exclusive', 'metadata[source]': 'veyro-prisaendring' },
    { idempotencyKey: `${opts.key}-price` },
  );
  const taxIds = (cur.tax_rates ?? []).map((t) => (typeof t === 'string' ? t : t.id));
  let newScheduleId: string | null = null;

  if (target === periodEnd) {
    // Gælder fra næste faktura. proration_behavior=none: ingen efterregning for den løbende periode.
    const params: Params = { 'items[0][id]': cur.id, 'items[0][price]': price.id, proration_behavior: 'none' };
    taxIds.forEach((t, i) => (params[`items[0][tax_rates][${i}]`] = t));
    await stripeRequest(env, 'POST', `/v1/subscriptions/${subId}`, params, { idempotencyKey: `${opts.key}-update` });
  } else {
    const sched = await stripeRequest<{ id: string; phases: Array<{ start_date: number; end_date: number }> }>(
      env,
      'POST',
      '/v1/subscription_schedules',
      { from_subscription: subId },
      { idempotencyKey: `${opts.key}-schedule` },
    );
    newScheduleId = sched.id;
    const qty = cur.quantity ?? 1;
    const params: Params = {
      end_behavior: 'release',
      proration_behavior: 'none',
      'phases[0][start_date]': sched.phases[0]!.start_date,
      'phases[0][end_date]': target,
      'phases[0][items][0][price]': currentPriceId,
      'phases[0][items][0][quantity]': qty,
      'phases[0][proration_behavior]': 'none',
      'phases[1][items][0][price]': price.id,
      'phases[1][items][0][quantity]': qty,
      'phases[1][proration_behavior]': 'none',
      'phases[1][duration][interval]': interval,
      'phases[1][duration][interval_count]': 1,
    };
    taxIds.forEach((t, i) => {
      params[`phases[0][items][0][tax_rates][${i}]`] = t;
      params[`phases[1][items][0][tax_rates][${i}]`] = t;
    });
    try {
      await stripeRequest(env, 'POST', `/v1/subscription_schedules/${sched.id}`, params, { idempotencyKey: `${opts.key}-phases` });
    } catch (err) {
      // Ældre API-versioner kender ikke phases[].duration, men har iterations.
      if (!(err instanceof StripeError && err.status === 400 && err.message.includes('duration'))) throw err;
      const legacy = Object.fromEntries(Object.entries(params).filter(([k]) => !k.startsWith('phases[1][duration]')));
      legacy['phases[1][iterations]'] = 1;
      await stripeRequest(env, 'POST', `/v1/subscription_schedules/${sched.id}`, legacy, { idempotencyKey: `${opts.key}-phases-legacy` });
    }
  }

  const old = pendingOld ? pendingOld.old_amount : cur.price.unit_amount != null ? cur.price.unit_amount * (cur.quantity ?? 1) : null;
  const row = await env.DB.prepare(
    `INSERT INTO price_changes (subscription_id, old_amount, new_amount, interval, effective_at, old_price_id, new_price_id, schedule_id, status, created_by, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'scheduled', ?, ?) RETURNING id`,
  )
    .bind(subId, old, newAmount * (cur.quantity ?? 1), interval, target, currentPriceId, price.id, newScheduleId, opts.createdBy, nowSec())
    .first<{ id: number }>();
  return { effectiveAt: target, oldAmount: old, interval, changeId: row!.id };
}

export async function markPriceChangeNotified(db: D1Database, id: number): Promise<void> {
  await db.prepare('UPDATE price_changes SET notified_at = ? WHERE id = ?').bind(nowSec(), id).run();
}

