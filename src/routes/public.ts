import { Hono } from 'hono';
import type { AppEnv } from '../env';
import { getCurrentSubscription, getCustomerByEmail } from '../lib/db';
import { isPlanKey, minMonths, priceIdFor } from '../lib/plans';
import { stripeRequest, StripeError, type Params } from '../lib/stripe';
import { render } from '../render';
import { plansPage, thanksPage } from '../views/pages';
import { subscriptionState } from '../views/status';

const pub = new Hono<AppEnv>();

pub.get('/', (c) => c.redirect(c.get('session') ? '/konto' : '/login', 302));

pub.get('/bestil', (c) =>
  render(c, 'Abonnementer', plansPage({ csrf: c.get('csrf'), minMonths: minMonths(c.env) })),
);

pub.post('/bestil', async (c) => {
  const body = await c.req.parseBody();
  const plan = body['plan'];
  if (!isPlanKey(plan)) {
    return render(c, 'Abonnementer', plansPage({ csrf: c.get('csrf'), minMonths: minMonths(c.env), error: 'Vælg en gyldig plan.' }), {
      status: 400,
    });
  }

  const base = c.env.APP_URL.replace(/\/+$/, '');
  const params: Params = {
    mode: 'subscription',
    locale: 'da',
    'line_items[0][price]': priceIdFor(c.env, plan),
    'line_items[0][quantity]': 1,
    billing_address_collection: 'required',
    'tax_id_collection[enabled]': 'true',
    success_url: `${base}/bestil/tak?session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${base}/bestil`,
    'subscription_data[metadata][plan]': plan,
  };
  if (c.env.STRIPE_TAX_RATE_ID) params['subscription_data[default_tax_rates][0]'] = c.env.STRIPE_TAX_RATE_ID;

  // Er kunden logget ind, genbruges Stripe-kunden (eller e-mailen forudfyldes).
  const session = c.get('session');
  if (session) {
    const customer = await getCustomerByEmail(c.env.DB, session.email);
    if (customer) {
      const sub = await getCurrentSubscription(c.env.DB, customer.id);
      const st = subscriptionState(sub);
      if (st && !st.ended) return c.redirect('/konto/plan?besked=har-abonnement', 303);
    }
    if (customer?.stripe_customer_id) {
      params.customer = customer.stripe_customer_id;
      params['customer_update[address]'] = 'auto';
      params['customer_update[name]'] = 'auto';
    } else {
      params.customer_email = session.email;
    }
  }

  try {
    const cs = await stripeRequest<{ url: string }>(c.env, 'POST', '/v1/checkout/sessions', params, {
      idempotencyKey: crypto.randomUUID(),
    });
    return c.redirect(cs.url, 303);
  } catch (err) {
    console.error('Checkout-fejl:', err instanceof StripeError ? `${err.status} ${err.code ?? ''}` : (err as Error).message);
    return render(
      c,
      'Abonnementer',
      plansPage({
        csrf: c.get('csrf'),
        minMonths: minMonths(c.env),
        error: 'Betalingssiden kunne ikke åbnes lige nu. Prøv igen om lidt, eller skriv til kontakt@veyro.dk.',
      }),
      { status: 502 },
    );
  }
});

pub.get('/bestil/tak', (c) => render(c, 'Tak for din bestilling', thanksPage()));

export default pub;
