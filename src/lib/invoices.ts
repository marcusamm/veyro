import type { Env } from '../env';
import { normalizeEmail } from './db';
import { StripeError, stripeRequest, type Params } from './stripe';

/**
 * Manuelle fakturaer, som admin opretter fra /admin/fakturaer
 * (fx efter et tilbud på en ordre- og lagerløsning).
 * Beløb indtastes i kr. ekskl. moms; moms lægges oveni som en eksklusiv 25 %-sats.
 */

export const MAX_LINES = 5;
export const VAT_PERCENT = 25;

export interface InvoiceLine {
  description: string;
  quantity: number;
  unitAmount: number; // øre ekskl. moms
}

export interface InvoiceDraft {
  email: string;
  name: string;
  lines: InvoiceLine[];
  daysUntilDue: number;
  addVat: boolean;
  memo: string;
}

export interface AdminInvoice {
  id: string;
  number: string | null;
  status: string | null;
  created: number;
  due_date: number | null;
  total: number;
  amount_remaining: number;
  currency: string;
  customer_name: string | null;
  customer_email: string | null;
  hosted_invoice_url: string | null;
  invoice_pdf: string | null;
  livemode?: boolean;
}

/** "1.234,50", "1234.5", "1500" -> øre. Returnerer null ved ugyldigt beløb. */
export function parseKr(raw: unknown): number | null {
  if (typeof raw !== 'string') return null;
  let s = raw.replace(/\s|kr\.?/gi, '');
  if (!s) return null;
  if (s.includes(',')) s = s.replace(/\./g, '').replace(',', '.');
  else if (/^\d{1,3}(\.\d{3})+$/.test(s)) s = s.replace(/\./g, '');
  if (!/^\d+(\.\d{1,2})?$/.test(s)) return null;
  const oere = Math.round(Number(s) * 100);
  if (!Number.isSafeInteger(oere) || oere <= 0 || oere > 100_000_000) return null;
  return oere;
}

export interface DraftForm {
  email: string;
  name: string;
  memo: string;
  days: string;
  vat: boolean;
  lines: Array<{ description: string; quantity: string; price: string }>;
}

export function readDraftForm(body: Record<string, unknown>): DraftForm {
  const str = (k: string) => (typeof body[k] === 'string' ? (body[k] as string).trim() : '');
  const lines = [];
  for (let i = 0; i < MAX_LINES; i++) {
    lines.push({ description: str(`line${i}_desc`), quantity: str(`line${i}_qty`), price: str(`line${i}_price`) });
  }
  return { email: str('email'), name: str('name'), memo: str('memo'), days: str('days'), vat: body['vat'] === '1', lines };
}

/** Validerer formularen. Returnerer enten en kladde eller en fejltekst og feltet, den gælder. */
export function validateDraft(f: DraftForm): { draft: InvoiceDraft } | { error: string; field: string } {
  const email = normalizeEmail(f.email);
  if (!email) return { error: 'Skriv en gyldig e-mail til kunden.', field: 'email' };
  if (!f.name || f.name.length > 100) return { error: 'Skriv kundens navn eller firmanavn (højst 100 tegn).', field: 'name' };
  const days = Number.parseInt(f.days, 10);
  if (!Number.isInteger(days) || days < 0 || days > 90) return { error: 'Betalingsfristen skal være mellem 0 og 90 dage.', field: 'days' };
  if (f.memo.length > 500) return { error: 'Beskeden må højst være 500 tegn.', field: 'memo' };
  const lines: InvoiceLine[] = [];
  for (const [i, l] of f.lines.entries()) {
    if (!l.description && !l.price) continue;
    if (!l.description || l.description.length > 200) return { error: `Linje ${i + 1}: skriv en beskrivelse (højst 200 tegn).`, field: `line${i}_desc` };
    const quantity = l.quantity ? Number(l.quantity) : 1;
    if (!Number.isInteger(quantity) || quantity < 1 || quantity > 1000) return { error: `Linje ${i + 1}: antal skal være et helt tal fra 1 til 1000.`, field: `line${i}_qty` };
    const unitAmount = parseKr(l.price);
    if (unitAmount === null) return { error: `Linje ${i + 1}: skriv en gyldig pris i kr., fx 4.500 eller 4500,00.`, field: `line${i}_price` };
    lines.push({ description: l.description, quantity, unitAmount });
  }
  if (lines.length === 0) return { error: 'Tilføj mindst én linje med beskrivelse og pris.', field: 'line0_desc' };
  return { draft: { email, name: f.name, lines, daysUntilDue: days, addVat: f.vat, memo: f.memo } };
}

export function draftTotals(d: InvoiceDraft): { net: number; vat: number; total: number } {
  const net = d.lines.reduce((s, l) => s + l.unitAmount * l.quantity, 0);
  const vat = d.addVat ? Math.round((net * VAT_PERCENT) / 100) : 0;
  return { net, vat, total: net + vat };
}

/** Finder kunden i Stripe på e-mail, eller opretter den. */
export async function findOrCreateCustomer(env: Env, email: string, name: string, key: string): Promise<string> {
  const found = await stripeRequest<{ data: Array<{ id: string; name: string | null }> }>(env, 'GET', '/v1/customers', { email, limit: 1 });
  const existing = found.data?.[0];
  if (existing) {
    if (!existing.name) await stripeRequest(env, 'POST', `/v1/customers/${existing.id}`, { name });
    return existing.id;
  }
  const created = await stripeRequest<{ id: string }>(
    env,
    'POST',
    '/v1/customers',
    { email, name, 'preferred_locales[0]': 'da', 'metadata[source]': 'veyro-admin' },
    { idempotencyKey: `${key}-customer` },
  );
  return created.id;
}

/** Finder (eller opretter) en eksklusiv dansk momssats på 25 %. */
export async function vatRateId(env: Env): Promise<string> {
  const list = await stripeRequest<{ data: Array<{ id: string; percentage: number; inclusive: boolean; country: string | null }> }>(
    env,
    'GET',
    '/v1/tax_rates',
    { active: 'true', inclusive: 'false', limit: 100 },
  );
  const hit = list.data?.find((r) => r.percentage === VAT_PERCENT && !r.inclusive && (r.country ?? 'DK') === 'DK');
  if (hit) return hit.id;
  const created = await stripeRequest<{ id: string }>(
    env,
    'POST',
    '/v1/tax_rates',
    { display_name: 'Moms', percentage: VAT_PERCENT, inclusive: 'false', country: 'DK', tax_type: 'vat', description: 'Dansk moms 25 %' },
    { idempotencyKey: 'veyro-vat-25-exclusive' },
  );
  return created.id;
}

/** Sender et Stripe-kald; afviser Stripe et ukendt parameter (fx managed_payments), prøves igen uden. */
export async function postWithFallback<T>(env: Env, path: string, params: Params, optional: string, key: string): Promise<T> {
  try {
    return await stripeRequest<T>(env, 'POST', path, params, { idempotencyKey: key });
  } catch (err) {
    if (!(err instanceof StripeError) || err.status !== 400 || !err.message.includes(optional)) throw err;
    const rest = Object.fromEntries(Object.entries(params).filter(([k]) => !k.startsWith(optional)));
    return stripeRequest<T>(env, 'POST', path, rest, { idempotencyKey: `${key}-retry` });
  }
}

/**
 * Opretter fakturaen som kladde i Stripe. Med send=true færdiggøres og e-mailes den til kunden.
 * `key` er en engangsnøgle fra formularen, så et dobbeltklik ikke giver to fakturaer.
 */
export async function createInvoice(env: Env, d: InvoiceDraft, opts: { send: boolean; key: string; createdBy: string }): Promise<AdminInvoice> {
  const customer = await findOrCreateCustomer(env, d.email, d.name, opts.key);
  const taxRate = d.addVat ? await vatRateId(env) : null;

  const params: Params = {
    customer,
    currency: 'dkk',
    collection_method: 'send_invoice',
    days_until_due: d.daysUntilDue,
    auto_advance: 'false',
    pending_invoice_items_behavior: 'exclude',
    'managed_payments[enabled]': 'false',
    'metadata[created_by]': opts.createdBy,
    'metadata[source]': 'veyro-admin',
  };
  if (d.memo) params.description = d.memo;
  if (taxRate) params['default_tax_rates[0]'] = taxRate;
  let inv = await postWithFallback<AdminInvoice>(env, '/v1/invoices', params, 'managed_payments', `${opts.key}-invoice`);

  for (const [i, l] of d.lines.entries()) {
    await stripeRequest(
      env,
      'POST',
      '/v1/invoiceitems',
      { customer, invoice: inv.id, currency: 'dkk', description: l.description, quantity: l.quantity, unit_amount_decimal: String(l.unitAmount) },
      { idempotencyKey: `${opts.key}-item-${i}` },
    );
  }

  if (opts.send) inv = await sendInvoice(env, inv.id);
  else inv = await stripeRequest<AdminInvoice>(env, 'GET', `/v1/invoices/${inv.id}`);
  return inv;
}

/** Færdiggør en kladde (hvis den stadig er kladde) og e-mailer den til kunden. */
export async function sendInvoice(env: Env, id: string): Promise<AdminInvoice> {
  let inv = await stripeRequest<AdminInvoice>(env, 'GET', `/v1/invoices/${id}`);
  if (inv.status === 'draft') inv = await stripeRequest<AdminInvoice>(env, 'POST', `/v1/invoices/${id}/finalize`, { auto_advance: 'false' });
  if (inv.status !== 'open') throw new StripeError('Kun ubetalte fakturaer kan sendes.', 400);
  return stripeRequest<AdminInvoice>(env, 'POST', `/v1/invoices/${id}/send`);
}

export async function listAdminInvoices(env: Env): Promise<AdminInvoice[]> {
  const res = await stripeRequest<{ data: AdminInvoice[] }>(env, 'GET', '/v1/invoices', { limit: 30 });
  return res.data ?? [];
}

export async function deleteDraft(env: Env, id: string): Promise<void> {
  await stripeRequest(env, 'DELETE', `/v1/invoices/${id}`);
}

export async function markPaid(env: Env, id: string): Promise<void> {
  await stripeRequest(env, 'POST', `/v1/invoices/${id}/pay`, { paid_out_of_band: 'true' });
}

export async function voidInvoice(env: Env, id: string): Promise<void> {
  await stripeRequest(env, 'POST', `/v1/invoices/${id}/void`);
}

export function isInvoiceId(id: string): boolean {
  return /^in_[A-Za-z0-9]{8,64}$/.test(id);
}
