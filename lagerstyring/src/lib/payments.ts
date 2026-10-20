// Betalingsopfølgning på udstedte fakturaer. Betalinger registreres manuelt; det er ikke en
// bankafstemning. Status beregnes altid ud fra fakturaen, kreditnotaer og registrerede betalinger.

import type { InvoiceRow } from '../env';
import { todayDk } from './format';

export type PayMethod = 'bankoverforsel' | 'mobilepay' | 'kort' | 'kontant' | 'modregning' | 'andet';
export const METHOD_LABEL: Record<PayMethod, string> = {
  bankoverforsel: 'Bankoverførsel',
  mobilepay: 'MobilePay',
  kort: 'Kort',
  kontant: 'Kontant',
  modregning: 'Modregning',
  andet: 'Andet',
};
export const isMethod = (s: unknown): s is PayMethod => typeof s === 'string' && s in METHOD_LABEL;

export interface PaymentRow {
  id: number;
  invoice_id: number;
  paid_on: string;
  amount: number;
  currency: string;
  method: PayMethod;
  reference: string;
  note: string;
  created_by: string;
  created_at: number;
  deleted_by: string | null;
  deleted_at: number | null;
}

export type DocState = 'kladde' | 'udstedt' | 'delvist_krediteret' | 'fuldt_krediteret';
export const DOC_STATE_LABEL: Record<DocState, string> = {
  kladde: 'Kladde',
  udstedt: 'Udstedt',
  delvist_krediteret: 'Delvist krediteret',
  fuldt_krediteret: 'Fuldt krediteret',
};

export type PayState = 'ikke_betalt' | 'delvist_betalt' | 'betalt' | 'forfalden' | 'overbetalt' | 'ingen';
export const PAY_STATE_LABEL: Record<PayState, string> = {
  ikke_betalt: 'Ikke betalt',
  delvist_betalt: 'Delvist betalt',
  betalt: 'Betalt',
  forfalden: 'Forfalden',
  overbetalt: 'Overbetaling',
  ingen: '–',
};
export const PAY_STATE_TAG: Record<PayState, string> = {
  ikke_betalt: 'tag-ready',
  delvist_betalt: 'tag-low',
  betalt: 'tag-ok',
  forfalden: 'tag-crit',
  overbetalt: 'tag-fail',
  ingen: 'tag-off',
};

export interface PayStatus {
  doc: DocState;
  pay: PayState;
  credited: number;
  paid: number;
  /** Rest at betale (negativ = overbetalt) */
  outstanding: number;
  /** Betalinger i anden valuta end DKK (tæller ikke med i resten) */
  foreign: number;
  overdueDays: number;
}

export function payStatus(inv: Pick<InvoiceRow, 'kind' | 'status' | 'total' | 'due_date'>, credited: number, payments: Pick<PaymentRow, 'amount' | 'currency' | 'deleted_at'>[], today = todayDk()): PayStatus {
  const live = payments.filter((p) => !p.deleted_at);
  const paid = live.filter((p) => p.currency === 'DKK').reduce((a, p) => a + p.amount, 0);
  const foreign = live.filter((p) => p.currency !== 'DKK').length;
  const doc: DocState = inv.status === 'kladde' ? 'kladde' : credited <= 0 ? 'udstedt' : credited >= inv.total ? 'fuldt_krediteret' : 'delvist_krediteret';
  const outstanding = inv.total - credited - paid;
  let pay: PayState = 'ingen';
  let overdueDays = 0;
  if (inv.kind === 'faktura' && inv.status === 'udstedt') {
    if (outstanding < 0) pay = 'overbetalt';
    else if (outstanding === 0) pay = 'betalt';
    else if (inv.due_date && inv.due_date < today) {
      pay = 'forfalden';
      overdueDays = Math.round((Date.parse(today) - Date.parse(inv.due_date)) / 86400000);
    } else pay = paid > 0 ? 'delvist_betalt' : 'ikke_betalt';
  }
  return { doc, pay, credited, paid, outstanding, foreign, overdueDays };
}

export async function invoicePayments(db: D1Database, invoiceId: number): Promise<PaymentRow[]> {
  const { results } = await db.prepare('SELECT * FROM invoice_payments WHERE invoice_id = ? ORDER BY paid_on, id').bind(invoiceId).all<PaymentRow>();
  return results;
}

export async function creditedTotal(db: D1Database, invoiceId: number): Promise<number> {
  const r = await db.prepare("SELECT COALESCE(SUM(total), 0) AS n FROM invoices WHERE credit_of = ? AND kind = 'kreditnota' AND status = 'udstedt'").bind(invoiceId).first<{ n: number }>();
  return r?.n ?? 0;
}

/** Alle udstedte fakturaer med betalingsstatus (til oversigten og eksporten). */
export async function invoicesWithStatus(db: D1Database, where = '', args: (string | number)[] = []): Promise<(InvoiceRow & { job_number: string; job_name: string; customer_name: string; st: PayStatus })[]> {
  const [{ results: invs }, { results: pays }, { results: credits }] = await Promise.all([
    db
      .prepare(`SELECT i.*, j.number AS job_number, j.name AS job_name, j.customer_name FROM invoices i JOIN jobs j ON j.id = i.job_id WHERE i.status = 'udstedt' ${where} ORDER BY i.number DESC`)
      .bind(...args)
      .all<InvoiceRow & { job_number: string; job_name: string; customer_name: string }>(),
    db.prepare('SELECT invoice_id, amount, currency, deleted_at FROM invoice_payments WHERE deleted_at IS NULL').all<Pick<PaymentRow, 'invoice_id' | 'amount' | 'currency' | 'deleted_at'>>(),
    db.prepare("SELECT credit_of, SUM(total) AS n FROM invoices WHERE kind = 'kreditnota' AND status = 'udstedt' AND credit_of IS NOT NULL GROUP BY credit_of").all<{ credit_of: number; n: number }>(),
  ]);
  const cm = new Map(credits.map((c) => [c.credit_of, c.n]));
  const today = todayDk();
  return invs.map((i) => ({ ...i, st: payStatus(i, cm.get(i.id) ?? 0, pays.filter((p) => p.invoice_id === i.id), today) }));
}

/** Mulig dobbeltregistrering: samme beløb og dato (eller samme reference) på samme faktura. */
export function duplicatePayment(existing: PaymentRow[], p: { amount: number; paid_on: string; reference: string }): PaymentRow | null {
  return existing.find((e) => !e.deleted_at && ((e.amount === p.amount && e.paid_on === p.paid_on) || (p.reference && e.reference === p.reference))) ?? null;
}
