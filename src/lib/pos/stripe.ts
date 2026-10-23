// Kortbetaling i kassen med Stripe Terminal på Veyros Stripe-konto (server-styret integration:
// kortlæseren er forbundet til Stripe over internettet, og serveren sender betalingen til den).
// Kortdata håndteres udelukkende af kortlæseren og Stripe; systemet ser og gemmer aldrig kortnumre.
// Kræver STRIPE_SECRET_KEY og en registreret kortlæser (tmr_...) under Kasse → Indstillinger.
import type { Env } from '../../env';
import { StripeError, stripeRequest, type Params } from '../stripe';

export { StripeError };

async function call<T>(env: Env, method: 'GET' | 'POST', path: string, params: Params = {}, idempotencyKey?: string): Promise<T> {
  try {
    return await stripeRequest<T>(env, method, path, params, { idempotencyKey });
  } catch (err) {
    if (err instanceof StripeError) throw err;
    throw new StripeError('Stripe kunne ikke nås. Tjek internetforbindelsen.', 0, 'network');
  }
}

export interface PaymentIntent {
  id: string;
  status: 'requires_payment_method' | 'requires_confirmation' | 'requires_action' | 'processing' | 'requires_capture' | 'canceled' | 'succeeded';
  amount: number;
  last_payment_error?: { message?: string; code?: string } | null;
}

export interface Reader {
  id: string;
  status: 'online' | 'offline' | null;
  action?: {
    status: 'in_progress' | 'succeeded' | 'failed';
    failure_message?: string | null;
    process_payment_intent?: { payment_intent: string };
  } | null;
}

export function createPaymentIntent(env: Env, args: { amount: number; saleNumber: number; key: string }): Promise<PaymentIntent> {
  return call<PaymentIntent>(
    env,
    'POST',
    '/v1/payment_intents',
    {
      amount: args.amount,
      currency: 'dkk',
      'payment_method_types[]': 'card_present',
      capture_method: 'automatic',
      description: `Kassesalg #${args.saleNumber}`,
      'metadata[pos_sale]': args.saleNumber,
      'metadata[source]': 'kasse',
    },
    `pi-${args.key}`,
  );
}

export function processOnReader(env: Env, readerId: string, paymentIntent: string, key: string): Promise<Reader> {
  return call<Reader>(env, 'POST', `/v1/terminal/readers/${encodeURIComponent(readerId)}/process_payment_intent`, { payment_intent: paymentIntent }, `proc-${key}`);
}

export function getPaymentIntent(env: Env, id: string): Promise<PaymentIntent> {
  return call<PaymentIntent>(env, 'GET', `/v1/payment_intents/${encodeURIComponent(id)}`);
}

export function getReader(env: Env, id: string): Promise<Reader> {
  return call<Reader>(env, 'GET', `/v1/terminal/readers/${encodeURIComponent(id)}`);
}

export async function cancelReaderAction(env: Env, readerId: string): Promise<void> {
  try {
    await call(env, 'POST', `/v1/terminal/readers/${encodeURIComponent(readerId)}/cancel_action`);
  } catch (err) {
    // Ingen igangværende handling på læseren er ikke en fejl her
    if (!(err instanceof StripeError) || err.status !== 400) throw err;
  }
}

export function cancelPaymentIntent(env: Env, id: string): Promise<PaymentIntent> {
  return call<PaymentIntent>(env, 'POST', `/v1/payment_intents/${encodeURIComponent(id)}/cancel`);
}

export interface StripeRefund {
  id: string;
  status: 'pending' | 'requires_action' | 'succeeded' | 'failed' | 'canceled';
  failure_reason?: string | null;
}

export function createRefund(env: Env, args: { paymentIntent: string; amount: number; key: string }): Promise<StripeRefund> {
  return call<StripeRefund>(env, 'POST', '/v1/refunds', { payment_intent: args.paymentIntent, amount: args.amount, 'metadata[source]': 'kasse' }, `re-${args.key}`);
}
