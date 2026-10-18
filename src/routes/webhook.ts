import { Hono } from 'hono';
import type { AppEnv, Env } from '../env';
import { attachCardFromSession } from '../lib/card-link';
import { nowSec } from '../lib/crypto';
import { getCustomerByStripeId, normalizeEmail, upsertCustomer, upsertSubscription } from '../lib/db';
import {
  idOf,
  stripeRequest,
  StripeError,
  verifyStripeSignature,
  type StripeCustomer,
  type StripeSubscription,
} from '../lib/stripe';

const webhook = new Hono<AppEnv>();

/** Finder kunden i D1 ud fra Stripe-kunde-ID; opretter den fra Stripe, hvis den mangler. */
async function ensureCustomer(env: Env, stripeCustomerId: string) {
  const existing = await getCustomerByStripeId(env.DB, stripeCustomerId);
  if (existing) return existing;
  const sc = await stripeRequest<StripeCustomer>(env, 'GET', `/v1/customers/${encodeURIComponent(stripeCustomerId)}`);
  const email = normalizeEmail(sc.email);
  if (sc.deleted || !email) return null;
  return upsertCustomer(env.DB, { email, name: sc.name, stripeCustomerId });
}

/** Henter abonnementet frisk fra Stripe (robust over for hændelser i forkert rækkefølge) og gemmer det. */
async function syncSubscription(
  env: Env,
  subId: string,
  fallback?: StripeSubscription,
  extra: { paymentFailed?: boolean } = {},
) {
  let sub: StripeSubscription;
  try {
    sub = await stripeRequest<StripeSubscription>(env, 'GET', `/v1/subscriptions/${encodeURIComponent(subId)}`);
  } catch (err) {
    if (err instanceof StripeError && err.status === 404 && fallback) sub = fallback;
    else throw err;
  }
  const stripeCustomerId = idOf(sub.customer);
  if (!stripeCustomerId) return;
  const customer = await ensureCustomer(env, stripeCustomerId);
  if (!customer) return;
  await upsertSubscription(env, customer.id, sub, extra);
}

function invoiceSubscriptionId(inv: any): string | null {
  return (
    idOf(inv?.subscription) ??
    idOf(inv?.parent?.subscription_details?.subscription) ??
    idOf(inv?.lines?.data?.[0]?.subscription) ??
    idOf(inv?.lines?.data?.[0]?.parent?.subscription_item_details?.subscription) ??
    null
  );
}

webhook.post('/stripe/webhook', async (c) => {
  const payload = await c.req.text();
  const valid = await verifyStripeSignature(payload, c.req.header('Stripe-Signature'), c.env.STRIPE_WEBHOOK_SECRET);
  if (!valid) return c.json({ error: 'invalid signature' }, 400);

  let event: { id: string; type: string; data: { object: any } };
  try {
    event = JSON.parse(payload);
  } catch {
    return c.json({ error: 'invalid json' }, 400);
  }
  if (!event?.id || !event?.type || !event?.data?.object) return c.json({ error: 'invalid event' }, 400);

  const seen = await c.env.DB.prepare('SELECT 1 FROM webhook_events WHERE id = ?').bind(event.id).first();
  if (seen) return c.json({ received: true, duplicate: true });

  const obj = event.data.object;
  try {
    switch (event.type) {
      case 'checkout.session.completed': {
        if (obj.mode === 'setup' && obj.metadata?.veyro_subscription) {
          await attachCardFromSession(c.env, obj.id);
          break;
        }
        if (obj.mode !== 'subscription') break;
        const email = normalizeEmail(obj.customer_details?.email ?? obj.customer_email);
        const stripeCustomerId = idOf(obj.customer);
        if (email) {
          await upsertCustomer(c.env.DB, { email, name: obj.customer_details?.name ?? null, stripeCustomerId });
        }
        const subId = idOf(obj.subscription);
        if (subId) await syncSubscription(c.env, subId);
        break;
      }
      case 'customer.subscription.created':
      case 'customer.subscription.updated':
      case 'customer.subscription.deleted':
        await syncSubscription(c.env, obj.id, obj as StripeSubscription);
        break;
      case 'invoice.paid': {
        const subId = invoiceSubscriptionId(obj);
        if (subId) await syncSubscription(c.env, subId, undefined, { paymentFailed: false });
        break;
      }
      case 'invoice.payment_failed': {
        const subId = invoiceSubscriptionId(obj);
        if (subId) await syncSubscription(c.env, subId, undefined, { paymentFailed: true });
        break;
      }
      default:
        // Andre hændelser ignoreres, men kvitteres, så Stripe ikke prøver igen.
        break;
    }
  } catch (err) {
    console.error(
      `Webhook ${event.type} (${event.id}) fejlede:`,
      err instanceof StripeError ? `${err.status} ${err.message}` : (err as Error).message,
    );
    return c.json({ error: 'processing failed' }, 500); // Stripe prøver igen senere
  }

  await c.env.DB.prepare('INSERT OR IGNORE INTO webhook_events (id, type, received_at) VALUES (?, ?, ?)')
    .bind(event.id, event.type, nowSec())
    .run();
  return c.json({ received: true });
});

export default webhook;
