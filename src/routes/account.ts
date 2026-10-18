import { Hono, type Context } from 'hono';
import type { AppEnv, CustomerRow } from '../env';
import { nowSec } from '../lib/crypto';
import {
  createRequest,
  getCurrentSubscription,
  getCustomerByEmail,
  listRequestsForCustomer,
  rateLimit,
  upsertSubscription,
} from '../lib/db';
import { newRequestEmail, sendEmail } from '../lib/email';
import { cancellableFrom, getPlan, isPlanKey, priceIdFor } from '../lib/plans';
import { isAdmin } from '../lib/session';
import { logError } from '../lib/errlog';
import { stripeRequest, StripeError, type StripeInvoice, type StripeSubscription } from '../lib/stripe';
import { render } from '../render';
import {
  cancelPage,
  choosePlanPage,
  confirmPlanPage,
  dashboardPage,
  errorPage,
  invoicesPage,
  requestsPage,
  type RequestFormValues,
} from '../views/pages';
import { REQUEST_TYPES, subscriptionState } from '../views/status';

type Vars = AppEnv & { Variables: AppEnv['Variables'] & { customer: CustomerRow } };
const account = new Hono<Vars>();

// Kræver login og en kundekonto
account.use('*', async (c, next) => {
  const session = c.get('session');
  if (!session) return c.redirect('/login', 303);
  const customer = await getCustomerByEmail(c.env.DB, session.email);
  if (!customer) {
    if (isAdmin(c.env, session.email)) return c.redirect('/admin', 303);
    return render(
      c as unknown as Context<AppEnv>,
      'Ingen konto',
      errorPage('Ingen kundekonto', 'Der er ikke knyttet et abonnement til denne e-mail.', { href: '/bestil', label: 'Se abonnementer' }),
      { status: 404, isCustomer: false },
    );
  }
  c.set('customer', customer);
  await next();
});

function logStripe(c: Context<Vars>, where: string, err: unknown): Promise<void> {
  return logError(c.env.DB, where, err);
}

const r = (c: Context<Vars>) => c as unknown as Context<AppEnv>;

// ---------- Overblik ----------
account.get('/', async (c) => {
  const customer = c.get('customer');
  const sub = await getCurrentSubscription(c.env.DB, customer.id);
  const open = await c.env.DB.prepare(
    "SELECT COUNT(*) AS n FROM requests WHERE customer_id = ? AND status != 'resolved'",
  )
    .bind(customer.id)
    .first<{ n: number }>();
  return render(
    r(c),
    'Overblik',
    dashboardPage({
      csrf: c.get('csrf'),
      name: customer.name,
      sub,
      cancellableFrom: cancellableFrom(c.env, sub?.started_at ?? null),
      openRequests: open?.n ?? 0,
      flashKey: c.req.query('besked'),
    }),
    { nav: 'overblik', isCustomer: true },
  );
});

// ---------- Skift plan ----------
async function manageableSub(c: Context<Vars>) {
  const sub = await getCurrentSubscription(c.env.DB, c.get('customer').id);
  const st = subscriptionState(sub);
  return { sub, st };
}

account.get('/plan', async (c) => {
  const { sub, st } = await manageableSub(c);
  if (!sub || !st || st.ended) return c.redirect('/bestil', 303);
  let blockedReason: string | undefined;
  if (!sub.plan) blockedReason = 'Dit abonnement er en særaftale med Veyro. Skriv til os, hvis du vil ændre det.';
  else if (st.cancelPending) blockedReason = 'Dit abonnement er opsagt. Fortsæt abonnementet fra overblikket, før du skifter plan.';
  else if (!st.manageable) blockedReason = 'Planen kan ikke skiftes lige nu. Kontakt os, hvis du har brug for hjælp.';
  const body = choosePlanPage({ sub, blockedReason, flashKey: c.req.query('besked') });
  return render(r(c), 'Skift plan', body, { nav: 'plan', isCustomer: true });
});

account.get('/plan/bekraeft', async (c) => {
  const target = c.req.query('plan');
  const { sub, st } = await manageableSub(c);
  if (!sub || !st || !st.manageable || st.cancelPending || !sub.plan || !isPlanKey(target) || target === sub.plan) {
    return c.redirect('/konto/plan', 303);
  }
  // Forhåndsvisning af næste faktura (bedste forsøg – siden virker også uden)
  let preview: { amountDue: number; date: number | null } | null = null;
  if (sub.item_id) {
    try {
      const customer = c.get('customer');
      const inv = await stripeRequest<{ amount_due: number; next_payment_attempt: number | null; period_end: number | null }>(
        c.env,
        'POST',
        '/v1/invoices/create_preview',
        {
          customer: customer.stripe_customer_id,
          subscription: sub.id,
          'subscription_details[items][0][id]': sub.item_id,
          'subscription_details[items][0][price]': priceIdFor(c.env, target),
          'subscription_details[proration_behavior]': 'create_prorations',
        },
      );
      preview = { amountDue: inv.amount_due, date: inv.next_payment_attempt ?? inv.period_end ?? null };
    } catch (err) {
      await logStripe(c, 'Fakturaeksempel', err);
    }
  }
  return render(
    r(c),
    'Bekræft planskift',
    confirmPlanPage({
      csrf: c.get('csrf'),
      current: getPlan(sub.plan),
      target: getPlan(target)!,
      periodEnd: sub.current_period_end,
      preview,
    }),
    { nav: 'plan', isCustomer: true },
  );
});

account.post('/plan', async (c) => {
  const body = await c.req.parseBody();
  const target = body['plan'];
  const { sub, st } = await manageableSub(c);
  if (!sub || !st || !st.manageable || st.cancelPending || !sub.plan || !isPlanKey(target) || target === sub.plan) {
    return c.redirect('/konto/plan', 303);
  }
  try {
    let itemId = sub.item_id;
    if (!itemId) {
      const fresh = await stripeRequest<StripeSubscription>(c.env, 'GET', `/v1/subscriptions/${encodeURIComponent(sub.id)}`);
      itemId = fresh.items.data[0]?.id ?? null;
    }
    if (!itemId) throw new Error('Abonnementet har ingen linjer');
    const updated = await stripeRequest<StripeSubscription>(
      c.env,
      'POST',
      `/v1/subscriptions/${encodeURIComponent(sub.id)}`,
      {
        'items[0][id]': itemId,
        'items[0][price]': priceIdFor(c.env, target),
        proration_behavior: 'create_prorations',
        'metadata[plan]': target,
      },
      { idempotencyKey: crypto.randomUUID() },
    );
    await upsertSubscription(c.env, c.get('customer').id, updated);
    return c.redirect('/konto?besked=plan-skiftet', 303);
  } catch (err) {
    await logStripe(c, 'Planskift', err);
    return c.redirect('/konto?besked=stripe-fejl', 303);
  }
});

// ---------- Opsigelse ----------
function cancelBlock(c: Context<Vars>, startedAt: number | null) {
  const from = cancellableFrom(c.env, startedAt);
  return { from, blocked: !!from && from > nowSec() };
}

account.get('/opsig', async (c) => {
  const { sub, st } = await manageableSub(c);
  if (!sub || !st || !st.manageable || st.cancelPending) return c.redirect('/konto', 303);
  const { from, blocked } = cancelBlock(c, sub.started_at);
  return render(r(c), 'Opsig abonnement', cancelPage({ csrf: c.get('csrf'), sub, cancellableFrom: from, blocked }), {
    nav: 'overblik',
    isCustomer: true,
  });
});

account.post('/opsig', async (c) => {
  const { sub, st } = await manageableSub(c);
  if (!sub || !st || !st.manageable || st.cancelPending) return c.redirect('/konto', 303);
  const { from, blocked } = cancelBlock(c, sub.started_at);
  if (blocked) {
    return render(r(c), 'Opsig abonnement', cancelPage({ csrf: c.get('csrf'), sub, cancellableFrom: from, blocked }), {
      nav: 'overblik',
      status: 403,
      isCustomer: true,
    });
  }
  try {
    const updated = await stripeRequest<StripeSubscription>(
      c.env,
      'POST',
      `/v1/subscriptions/${encodeURIComponent(sub.id)}`,
      { cancel_at_period_end: 'true' },
      { idempotencyKey: crypto.randomUUID() },
    );
    await upsertSubscription(c.env, c.get('customer').id, updated);
    return c.redirect('/konto?besked=opsagt', 303);
  } catch (err) {
    await logStripe(c, 'Opsigelse', err);
    return c.redirect('/konto?besked=stripe-fejl', 303);
  }
});

account.post('/genoptag', async (c) => {
  const { sub, st } = await manageableSub(c);
  if (!sub || !st || !st.cancelPending || st.ended) return c.redirect('/konto', 303);
  try {
    const params: Record<string, string> = { cancel_at_period_end: 'false' };
    if (sub.cancel_at && !sub.cancel_at_period_end) params.cancel_at = ''; // fjerner en fast slutdato
    const updated = await stripeRequest<StripeSubscription>(
      c.env,
      'POST',
      `/v1/subscriptions/${encodeURIComponent(sub.id)}`,
      params,
      { idempotencyKey: crypto.randomUUID() },
    );
    await upsertSubscription(c.env, c.get('customer').id, updated);
    return c.redirect('/konto?besked=genoptaget', 303);
  } catch (err) {
    await logStripe(c, 'Genoptag', err);
    return c.redirect('/konto?besked=stripe-fejl', 303);
  }
});

// ---------- Fakturaer og betalingskort ----------
account.get('/fakturaer', async (c) => {
  const customer = c.get('customer');
  let invoices: StripeInvoice[] | null = [];
  if (customer.stripe_customer_id) {
    try {
      const res = await stripeRequest<{ data: StripeInvoice[] }>(c.env, 'GET', '/v1/invoices', {
        customer: customer.stripe_customer_id,
        limit: 24,
      });
      invoices = res.data.filter((i) => i.status !== 'draft');
    } catch (err) {
      await logStripe(c, 'Fakturaliste', err);
      invoices = null;
    }
  }
  return render(
    r(c),
    'Fakturaer og betaling',
    invoicesPage({
      csrf: c.get('csrf'),
      invoices,
      hasStripeCustomer: !!customer.stripe_customer_id,
      flashKey: c.req.query('besked'),
    }),
    { nav: 'fakturaer', isCustomer: true },
  );
});

// Stripe Billing Portal, begrænset til opdatering af betalingsmetode (flow_data).
account.post('/betalingskort', async (c) => {
  const customer = c.get('customer');
  if (!customer.stripe_customer_id) return c.redirect('/konto/fakturaer', 303);
  const base = c.env.APP_URL.replace(/\/+$/, '');
  try {
    const ps = await stripeRequest<{ url: string }>(c.env, 'POST', '/v1/billing_portal/sessions', {
      customer: customer.stripe_customer_id,
      return_url: `${base}/konto/fakturaer?besked=kort-opdateret`,
      locale: 'da',
      'flow_data[type]': 'payment_method_update',
      'flow_data[after_completion][type]': 'redirect',
      'flow_data[after_completion][redirect][return_url]': `${base}/konto/fakturaer?besked=kort-opdateret`,
    });
    return c.redirect(ps.url, 303);
  } catch (err) {
    await logStripe(c, 'Betalingsportal', err);
    return c.redirect('/konto/fakturaer?besked=stripe-fejl', 303);
  }
});

// ---------- Henvendelser ----------
account.get('/henvendelser', async (c) => {
  const requests = await listRequestsForCustomer(c.env.DB, c.get('customer').id);
  return render(
    r(c),
    'Ændringsønsker og support',
    requestsPage({ csrf: c.get('csrf'), requests, flashKey: c.req.query('besked') }),
    { nav: 'henvendelser', isCustomer: true },
  );
});

function clean(v: unknown, max: number): string {
  if (typeof v !== 'string') return '';
  // Fjern kontroltegn (behold linjeskift og tab), normaliser linjeskift
  return v.replace(/\r\n?/g, '\n').replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '').trim().slice(0, max);
}

account.post('/henvendelser', async (c) => {
  const customer = c.get('customer');
  const body = await c.req.parseBody();
  const values: RequestFormValues = {
    type: typeof body['type'] === 'string' ? body['type'] : '',
    title: clean(body['title'], 120).replace(/\n/g, ' '),
    description: clean(body['description'], 5000),
  };
  const errors: Record<string, string> = {};
  if (!values.type || !(values.type in REQUEST_TYPES)) errors.type = 'Vælg en type.';
  if ((values.title ?? '').length < 3) errors.title = 'Skriv en overskrift på mindst 3 tegn.';
  if ((values.description ?? '').length < 10) errors.description = 'Beskriv din henvendelse med mindst 10 tegn.';

  if (!errors.type && !errors.title && !errors.description) {
    const ok = await rateLimit(c.env.DB, `req:${customer.id}`, 20, 3600);
    if (!ok) errors.description = 'Du har sendt mange henvendelser på kort tid. Prøv igen senere, eller skriv til kontakt@veyro.dk.';
  }

  if (Object.keys(errors).length) {
    const requests = await listRequestsForCustomer(c.env.DB, customer.id);
    return render(r(c), 'Ændringsønsker og support', requestsPage({ csrf: c.get('csrf'), requests, errors, values }), {
      nav: 'henvendelser',
      status: 400,
      isCustomer: true,
    });
  }

  const id = await createRequest(c.env.DB, {
    customerId: customer.id,
    type: values.type!,
    title: values.title!,
    description: values.description!,
  });

  const notify = c.env.NOTIFY_EMAIL || 'kontakt@veyro.dk';
  const msg = newRequestEmail({
    customerEmail: customer.email,
    typeLabel: REQUEST_TYPES[values.type!]!,
    title: values.title!,
    description: values.description!,
    adminUrl: `${c.env.APP_URL.replace(/\/+$/, '')}/admin/henvendelser#h-${id}`,
  });
  c.executionCtx.waitUntil(
    sendEmail(c.env, { to: notify, replyTo: customer.email, ...msg })
      .then((sent) => {
        if (!sent) console.log(`[DEV] Ny henvendelse #${id} (ingen RESEND_API_KEY – e-mail ikke sendt)`);
      })
      .catch((err) => console.error('Notifikation fejlede:', (err as Error).message)),
  );
  return c.redirect('/konto/henvendelser?besked=henvendelse-oprettet', 303);
});

export default account;
