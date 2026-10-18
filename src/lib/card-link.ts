import type { Env } from '../env';
import { hmacSha256Hex, timingSafeEqual } from './crypto';
import { StripeError, stripeRequest } from './stripe';

/**
 * Link, som kunden får på mail for at tilføje et betalingskort til et abonnement.
 * Tokenet er "<sub_id>.<udløb>.<hmac>", så der ikke skal gemmes noget i databasen.
 */

export const CARD_LINK_DAYS = 30;

async function sign(env: Env, payload: string): Promise<string> {
  return (await hmacSha256Hex(env.STRIPE_WEBHOOK_SECRET, `veyro-card-link:${payload}`)).slice(0, 40);
}

export async function makeCardToken(env: Env, subId: string, now = Math.floor(Date.now() / 1000)): Promise<string> {
  const payload = `${subId}.${now + CARD_LINK_DAYS * 86400}`;
  return `${payload}.${await sign(env, payload)}`;
}

/** Returnerer abonnementets id, hvis tokenet er gyldigt og ikke udløbet. */
export async function readCardToken(env: Env, token: string): Promise<string | null> {
  const m = /^(sub_[A-Za-z0-9]{8,64})\.(\d{9,11})\.([0-9a-f]{40})$/.exec(token);
  if (!m || !env.STRIPE_WEBHOOK_SECRET) return null;
  if (Number(m[2]) < Math.floor(Date.now() / 1000)) return null;
  return timingSafeEqual(m[3]!, await sign(env, `${m[1]}.${m[2]}`)) ? m[1]! : null;
}

export async function cardLink(env: Env, subId: string): Promise<string> {
  return `${env.APP_URL.replace(/\/+$/, '')}/kort/${await makeCardToken(env, subId)}`;
}

interface SetupSession {
  id: string;
  mode: string;
  status: string | null;
  customer: string | null;
  metadata?: Record<string, string>;
  setup_intent: { id: string; status?: string; payment_method: string | { id: string } | null } | string | null;
}

/**
 * Efter kunden har tilføjet et kort i Stripe Checkout (setup-mode): gør kortet til standard
 * og lad abonnementet trække betalingen automatisk. Kan kaldes flere gange (fra både
 * retur-siden og webhooken).
 */
export async function attachCardFromSession(env: Env, sessionId: string, expectedSub?: string): Promise<string | null> {
  const cs = await stripeRequest<SetupSession>(env, 'GET', `/v1/checkout/sessions/${encodeURIComponent(sessionId)}`, {
    'expand[0]': 'setup_intent',
  });
  const subId = cs.metadata?.veyro_subscription;
  if (cs.mode !== 'setup' || cs.status !== 'complete' || !subId || !cs.customer) return null;
  if (expectedSub && subId !== expectedSub) return null;
  const si = typeof cs.setup_intent === 'string' ? null : cs.setup_intent;
  const pm = si?.payment_method ? (typeof si.payment_method === 'string' ? si.payment_method : si.payment_method.id) : null;
  if (!pm) return null;

  await stripeRequest(env, 'POST', `/v1/customers/${cs.customer}`, { 'invoice_settings[default_payment_method]': pm });
  const params = { default_payment_method: pm, collection_method: 'charge_automatically' };
  try {
    await stripeRequest(env, 'POST', `/v1/subscriptions/${subId}`, params);
  } catch (err) {
    // Nogle API-versioner kræver, at betalingsfristen fjernes, når der skiftes til automatisk træk.
    if (!(err instanceof StripeError && err.status === 400 && /days_until_due/.test(err.message))) throw err;
    await stripeRequest(env, 'POST', `/v1/subscriptions/${subId}`, { ...params, days_until_due: '' });
  }
  return subId;
}
