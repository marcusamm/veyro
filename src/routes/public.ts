import { Hono } from 'hono';
import type { AppEnv } from '../env';
import { getCurrentSubscription, getCustomerByEmail } from '../lib/db';
import { isPlanKey, minMonths, priceIdFor } from '../lib/plans';
import { logError } from '../lib/errlog';
import { recordAcceptance } from '../lib/legal';
import { stripeRequest, StripeError, type Params } from '../lib/stripe';
import { render } from '../render';
import { flash, plansPage, thanksPage } from '../views/pages';
import { subscriptionState } from '../views/status';

const pub = new Hono<AppEnv>();

pub.get('/', (c) => c.redirect(c.get('session') ? '/konto' : '/login', 302));

// ?plan=starter|business|premium (fra knapperne på veyro.dk) fremhæver den valgte plan.
pub.get('/bestil', (c) => {
  const plan = c.req.query('plan');
  return render(
    c,
    'Abonnementer',
    plansPage({
      csrf: c.get('csrf'),
      minMonths: minMonths(c.env),
      loggedIn: !!c.get('session'),
      selected: isPlanKey(plan) ? plan : undefined,
      info: flash(c.req.query('besked')),
    }),
  );
});

pub.post('/bestil', async (c) => {
  const body = await c.req.parseBody();
  const plan = body['plan'];
  const session = c.get('session');
  if (!isPlanKey(plan)) {
    return render(
      c,
      'Abonnementer',
      plansPage({ csrf: c.get('csrf'), minMonths: minMonths(c.env), loggedIn: !!session, error: 'Vælg en gyldig plan.' }),
      { status: 400 },
    );
  }
  // Kunden opretter en konto før betaling, så abonnementet altid hører til en konto.
  if (!session) return c.redirect(`/opret?plan=${plan}`, 303);
  if (body['accept'] !== '1') {
    return render(
      c,
      'Abonnementer',
      plansPage({
        csrf: c.get('csrf'),
        minMonths: minMonths(c.env),
        loggedIn: true,
        selected: plan,
        error: 'Sæt kryds for at acceptere handelsbetingelserne og databehandleraftalen, før du går videre til betaling.',
      }),
      { status: 400 },
    );
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
    // Stripe slår "Managed Payments" (Stripe som sælger) til som standard. Veyro fakturerer selv inkl. dansk moms.
    'managed_payments[enabled]': 'false',
    // Samme udseende som veyro.dk
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
  if (c.env.STRIPE_TAX_RATE_ID) params['subscription_data[default_tax_rates][0]'] = c.env.STRIPE_TAX_RATE_ID;

  // Stripe-kunden genbruges (eller e-mailen forudfyldes og låses).
  const customer = await getCustomerByEmail(c.env.DB, session.email);
  if (customer) {
    const sub = await getCurrentSubscription(c.env.DB, customer.id);
    const st = subscriptionState(sub);
    if (st && !st.ended) return c.redirect('/konto/plan?besked=har-abonnement', 303);
  }
  try {
    await recordAcceptance(c.env.DB, { email: session.email, customerId: customer?.id, context: 'bestil', ip: c.req.header('CF-Connecting-IP') });
  } catch (err) {
    await logError(c.env.DB, 'Accept af betingelser', err);
    return render(
      c,
      'Abonnementer',
      plansPage({ csrf: c.get('csrf'), minMonths: minMonths(c.env), loggedIn: true, selected: plan, accepted: true, error: 'Din accept kunne ikke gemmes. Prøv igen om lidt.' }),
      { status: 502 },
    );
  }
  if (customer?.stripe_customer_id) {
    params.customer = customer.stripe_customer_id;
    params['customer_update[address]'] = 'auto';
    params['customer_update[name]'] = 'auto';
  } else {
    params.customer_email = session.email;
  }

  const create = (p: Params) =>
    stripeRequest<{ url: string }>(c.env, 'POST', '/v1/checkout/sessions', p, { idempotencyKey: crypto.randomUUID() });
  try {
    let cs: { url: string };
    try {
      cs = await create(params);
    } catch (err) {
      // Afviser Stripe udseendet (fx logoet), åbnes betalingen hellere uden end slet ikke.
      if (!(err instanceof StripeError && err.status === 400 && /branding/i.test(err.message))) throw err;
      await logError(c.env.DB, 'Checkout-udseende', err);
      cs = await create(Object.fromEntries(Object.entries(params).filter(([k]) => !k.startsWith('branding_settings'))));
    }
    return c.redirect(cs.url, 303);
  } catch (err) {
    await logError(c.env.DB, 'Checkout', err);
    return render(
      c,
      'Abonnementer',
      plansPage({
        csrf: c.get('csrf'),
        minMonths: minMonths(c.env),
        loggedIn: true,
        error: 'Betalingssiden kunne ikke åbnes lige nu. Prøv igen om lidt, eller skriv til kontakt@veyro.dk.',
      }),
      { status: 502 },
    );
  }
});

pub.get('/bestil/tak', (c) => render(c, 'Tak for din bestilling', thanksPage()));

export default pub;
