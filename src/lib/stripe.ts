import type { Env } from '../env';
import { hmacSha256Hex, timingSafeEqual } from './crypto';

/**
 * Minimal Stripe REST-klient baseret på fetch (form-encoded), uden SDK.
 * STRIPE_API_BASE kan pege på en lokal mock under test.
 */

export type Params = Record<string, string | number | boolean | null | undefined>;

export class StripeError extends Error {
  constructor(
    message: string,
    public status: number,
    public code?: string,
  ) {
    super(message);
  }
}

function apiBase(env: Env): string {
  return (env.STRIPE_API_BASE || 'https://api.stripe.com').replace(/\/+$/, '');
}

function encode(params: Params): string {
  const body = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null) continue;
    body.append(k, String(v));
  }
  return body.toString();
}

export async function stripeRequest<T = any>(
  env: Env,
  method: 'GET' | 'POST' | 'DELETE',
  path: string,
  params: Params = {},
  opts: { idempotencyKey?: string } = {},
): Promise<T> {
  if (!env.STRIPE_SECRET_KEY) throw new StripeError('STRIPE_SECRET_KEY mangler', 500);
  let url = apiBase(env) + path;
  const headers: Record<string, string> = {
    Authorization: `Bearer ${env.STRIPE_SECRET_KEY}`,
  };
  let body: string | undefined;
  const encoded = encode(params);
  if (method === 'GET' || method === 'DELETE') {
    if (encoded) url += (url.includes('?') ? '&' : '?') + encoded;
  } else {
    headers['Content-Type'] = 'application/x-www-form-urlencoded';
    body = encoded;
    if (opts.idempotencyKey) headers['Idempotency-Key'] = opts.idempotencyKey;
  }
  const res = await fetch(url, { method, headers, body });
  const text = await res.text();
  let data: any;
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    throw new StripeError(`Ugyldigt svar fra Stripe (${res.status})`, res.status);
  }
  if (!res.ok) {
    const err = data?.error ?? {};
    throw new StripeError(err.message || `Stripe-fejl (${res.status})`, res.status, err.code);
  }
  return data as T;
}

// ---- Typer for de felter vi bruger ----

export interface StripeSubscription {
  id: string;
  object: 'subscription';
  customer: string | { id: string };
  status: string;
  start_date?: number;
  created?: number;
  current_period_end?: number; // ældre API-versioner
  cancel_at_period_end: boolean;
  cancel_at: number | null;
  canceled_at: number | null;
  items: {
    data: Array<{
      id: string;
      current_period_end?: number; // nyere API-versioner
      quantity?: number;
      price: { id: string; unit_amount: number | null; currency: string };
    }>;
  };
}

export interface StripeCustomer {
  id: string;
  email: string | null;
  name: string | null;
  deleted?: boolean;
}

export interface StripeInvoice {
  id: string;
  number: string | null;
  status: string | null;
  created: number;
  total: number;
  amount_due: number;
  amount_paid: number;
  currency: string;
  hosted_invoice_url: string | null;
  invoice_pdf: string | null;
}

export function idOf(v: string | { id: string } | null | undefined): string | null {
  if (!v) return null;
  return typeof v === 'string' ? v : v.id;
}

export function subscriptionPeriodEnd(sub: StripeSubscription): number | null {
  return sub.current_period_end ?? sub.items?.data?.[0]?.current_period_end ?? null;
}

// ---- Webhook-signatur (Web Crypto) ----

/**
 * Verificerer Stripe-Signature-headeren: t=<tid>,v1=<hmac>[,v1=...].
 * HMAC-SHA256 over "<t>.<rå body>" med webhook-hemmeligheden.
 */
export async function verifyStripeSignature(
  payload: string,
  header: string | null | undefined,
  secret: string,
  toleranceSec = 300,
  now = Math.floor(Date.now() / 1000),
): Promise<boolean> {
  if (!header || !secret) return false;
  let timestamp: number | null = null;
  const signatures: string[] = [];
  for (const part of header.split(',')) {
    const idx = part.indexOf('=');
    if (idx < 0) continue;
    const k = part.slice(0, idx).trim();
    const v = part.slice(idx + 1).trim();
    if (k === 't') timestamp = Number.parseInt(v, 10);
    else if (k === 'v1') signatures.push(v);
  }
  if (timestamp === null || !Number.isFinite(timestamp) || signatures.length === 0) return false;
  if (Math.abs(now - timestamp) > toleranceSec) return false;
  const expected = await hmacSha256Hex(secret, `${timestamp}.${payload}`);
  return signatures.some((s) => timingSafeEqual(s, expected));
}
