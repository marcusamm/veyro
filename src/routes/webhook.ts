import { Hono } from 'hono';
import type { AppEnv, Env } from '../env';
import { attachCardFromSession } from '../lib/card-link';
import { nowSec } from '../lib/crypto';
import { getCustomerByStripeId, normalizeEmail, upsertCustomer, upsertSubscription } from '../lib/db';
import { adminNoticeEmail, offerActivatedEmail, sendEmail } from '../lib/email';
import { logError } from '../lib/errlog';
import { formatKr } from '../lib/format';
import {
  activateFromSession,
  cancelDuplicate,
  getOfferBySubscription,
  INTERVAL_LABEL,
  offerTotals,
  onAsyncPaymentFailed,
  onSessionExpired,
  onSubscriptionEnded,
  recordInvoice,
} from '../lib/offers';
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

/** Mail til Veyro (NOTIFY_EMAIL). Fejler mailen, logges det, men webhooken gennemføres. */
async function notifyAdmin(env: Env, subject: string, lines: string[], path?: string) {
  if (!env.NOTIFY_EMAIL) return;
  const link = path ? `${env.APP_URL.replace(/\/+$/, '')}${path}` : undefined;
  await sendEmail(env, { to: env.NOTIFY_EMAIL, ...adminNoticeEmail(subject, lines, link) }).catch((err) => logError(env.DB, 'webhook.notify', err));
}

/** Tilmelding via et tilbud: aktivér først, når Stripe har bekræftet betalingen. */
async function handleOfferSession(env: Env, sessionId: string) {
  const r = await activateFromSession(env, sessionId);
  if (r.kind === 'ignored') return;
  if (r.kind === 'duplicate') {
    // Sidste sikkerhedsnet: tilbuddet har allerede et abonnement, så det nye stoppes straks.
    await cancelDuplicate(env, r.subId);
    await notifyAdmin(env, `Dobbelt tilmelding stoppet: ${r.offer.service}`, [
      `${r.offer.email} gennemførte en ekstra betaling på et tilbud, der allerede har abonnementet ${r.offer.subscription_id}.`,
      `Det ekstra abonnement ${r.subId} er stoppet. Tjek i Stripe, om en betaling skal refunderes.`,
    ], `/admin/tilbud/${r.offer.id}`);
    return;
  }
  if (r.kind === 'activated') {
    const o = r.offer;
    const t = offerTotals(o);
    const priceLine = `${formatKr(t.recurringNet)} ekskl. moms ${INTERVAL_LABEL[o.interval].per}`;
    await sendEmail(env, {
      to: o.email,
      replyTo: 'kontakt@veyro.dk',
      ...offerActivatedEmail({ name: o.name, service: o.service, priceLine, loginLink: `${env.APP_URL.replace(/\/+$/, '')}/login` }),
    }).catch((err) => logError(env.DB, 'webhook.offer-welcome', err));
    await notifyAdmin(env, `Ny kunde aktiv: ${o.company ?? o.name}`, [`${o.company ?? o.name} (${o.email}) har tilmeldt sig ${o.service}: ${priceLine}.`, 'Stripe har bekræftet tilmelding og første betaling.'], `/admin/tilbud/${o.id}`);
  }
  await syncSubscription(env, r.subId);
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
        if (obj.metadata?.veyro_offer) {
          await handleOfferSession(c.env, obj.id);
          break;
        }
        const email = normalizeEmail(obj.customer_details?.email ?? obj.customer_email);
        const stripeCustomerId = idOf(obj.customer);
        if (email) {
          await upsertCustomer(c.env.DB, { email, name: obj.customer_details?.name ?? null, stripeCustomerId });
        }
        const subId = idOf(obj.subscription);
        if (subId) await syncSubscription(c.env, subId);
        break;
      }
      case 'checkout.session.async_payment_succeeded':
        if (obj.metadata?.veyro_offer) await handleOfferSession(c.env, obj.id);
        break;
      case 'checkout.session.async_payment_failed': {
        const o = await onAsyncPaymentFailed(c.env, obj.id);
        if (o) await notifyAdmin(c.env, `Betaling mislykkedes: ${o.service}`, [`Betalingen fra ${o.email} blev afvist. Tilbudslinket virker stadig, så kunden kan prøve igen.`], `/admin/tilbud/${o.id}`);
        break;
      }
      case 'checkout.session.expired':
        await onSessionExpired(c.env, obj.id);
        break;
      case 'customer.subscription.created':
      case 'customer.subscription.updated':
        await syncSubscription(c.env, obj.id, obj as StripeSubscription);
        break;
      case 'customer.subscription.deleted':
        await syncSubscription(c.env, obj.id, obj as StripeSubscription);
        await onSubscriptionEnded(c.env, obj.id);
        break;
      case 'invoice.finalized':
        await recordInvoice(c.env, obj, 'open', invoiceSubscriptionId(obj));
        break;
      case 'invoice.voided':
        await recordInvoice(c.env, obj, 'void', invoiceSubscriptionId(obj));
        break;
      case 'invoice.paid': {
        const subId = invoiceSubscriptionId(obj);
        await recordInvoice(c.env, obj, 'paid', subId);
        if (subId) await syncSubscription(c.env, subId, undefined, { paymentFailed: false });
        break;
      }
      case 'invoice.payment_failed': {
        const subId = invoiceSubscriptionId(obj);
        const recorded = await recordInvoice(c.env, obj, 'failed', subId);
        // En forsinket fejlhændelse for en faktura, der siden er betalt, ændrer intet.
        if (subId && recorded === 'failed') {
          await syncSubscription(c.env, subId, undefined, { paymentFailed: true });
          const offer = await getOfferBySubscription(c.env.DB, subId);
          const who = offer ? `${offer.company ?? offer.name} (${offer.email})` : (obj.customer_email ?? 'En kunde');
          const customer = await getCustomerByStripeId(c.env.DB, idOf(obj.customer) ?? '');
          await notifyAdmin(
            c.env,
            `Betaling mislykkedes: ${who}`,
            [
              `Betalingen af faktura ${obj.number ?? obj.id} på ${formatKr(obj.amount_due ?? 0)} mislykkedes (forsøg ${obj.attempt_count ?? 1}).`,
              obj.next_payment_attempt ? 'Stripe prøver automatisk igen. Kunden kan skifte kort i kundepanelet.' : 'Stripe prøver ikke igen automatisk. Kontakt kunden.',
            ],
            customer ? `/admin/kunder/${customer.id}` : undefined,
          );
        }
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
