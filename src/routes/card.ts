import { Hono } from 'hono';
import { html } from 'hono/html';
import type { AppEnv } from '../env';
import { attachCardFromSession, readCardToken } from '../lib/card-link';
import { logError } from '../lib/errlog';
import { formatDate, formatKr } from '../lib/format';
import { StripeError, stripeRequest, type Params } from '../lib/stripe';
import { render } from '../render';
import { alert, csrfField, type H } from '../views/layout';
import { errorPage } from '../views/pages';

/** Offentlig side fra velkomstmailen: kunden tilføjer et betalingskort til sit abonnement. */
const card = new Hono<AppEnv>();

interface CardSub {
  id: string;
  status: string;
  customer: string;
  collection_method: string;
  default_payment_method: string | null;
  trial_end: number | null;
  items: { data: Array<{ quantity?: number; price: { unit_amount: number | null } }> };
}

const invalid = (c: Parameters<typeof render>[0]) =>
  render(c, 'Linket virker ikke', errorPage('Linket virker ikke længere', 'Linket er udløbet eller ugyldigt. Skriv til kontakt@veyro.dk, så sender vi et nyt.', { href: 'https://veyro.dk', label: 'Til veyro.dk' }), { status: 400 });

function cardPage(args: { csrf: string; token: string; sub: CardSub; error?: string }): H {
  const monthly = args.sub.items.data.reduce((s, i) => s + (i.price.unit_amount ?? 0) * (i.quantity ?? 1), 0);
  const hasCard = args.sub.collection_method === 'charge_automatically' && !!args.sub.default_payment_method;
  return html`<div class="narrow stack-lg">
  <div><p class="eyebrow">Veyro abonnement</p><h1>${hasCard ? 'Betalingskort tilføjet' : 'Tilføj betalingskort'}</h1>
    <p class="lead">${hasCard
      ? 'Betalingen trækkes automatisk hver måned. Du kan skifte kort her, hvis du vil.'
      : 'Tilføj dit kort, så trækkes betalingen automatisk hver måned, og du slipper for at betale fakturaer manuelt.'}</p></div>
  ${args.error ? alert('err', args.error) : ''}
  <div class="card stack">
    <p><strong>${formatKr(monthly, { decimals: true })}</strong> pr. måned ekskl. moms${args.sub.status === 'trialing' && args.sub.trial_end ? html`. Første betaling er <strong>${formatDate(args.sub.trial_end)}</strong>` : ''}.</p>
    <form method="post" action="/kort/${args.token}">
      ${csrfField(args.csrf)}
      <button class="btn btn-accent btn-block" type="submit" data-loading="Åbner Stripe …">${hasCard ? 'Skift kort' : 'Tilføj kort'}</button>
    </form>
    <p class="small muted">Kortoplysningerne håndteres sikkert af Stripe og gemmes aldrig hos Veyro.</p>
  </div>
</div>`;
}

async function loadSub(c: Parameters<typeof render>[0], token: string): Promise<CardSub | null> {
  const subId = await readCardToken(c.env, token);
  if (!subId) return null;
  const sub = await stripeRequest<CardSub>(c.env, 'GET', `/v1/subscriptions/${subId}`).catch(() => null);
  return sub && !['canceled', 'incomplete_expired'].includes(sub.status) ? sub : null;
}

card.get('/kort/:token', async (c) => {
  const token = c.req.param('token');
  const sub = await loadSub(c, token);
  if (!sub) return invalid(c);
  return render(c, 'Tilføj betalingskort', cardPage({ csrf: c.get('csrf'), token, sub }));
});

card.post('/kort/:token', async (c) => {
  const token = c.req.param('token');
  const sub = await loadSub(c, token);
  if (!sub) return invalid(c);
  const base = c.env.APP_URL.replace(/\/+$/, '');
  const params: Params = {
    mode: 'setup',
    'managed_payments[enabled]': 'false',
    customer: sub.customer,
    currency: 'dkk',
    locale: 'da',
    success_url: `${base}/kort/${token}/tak?session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${base}/kort/${token}`,
    'metadata[veyro_subscription]': sub.id,
    'setup_intent_data[metadata][veyro_subscription]': sub.id,
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
  const create = (p: Params) => stripeRequest<{ url: string }>(c.env, 'POST', '/v1/checkout/sessions', p, { idempotencyKey: crypto.randomUUID() });
  try {
    // Betalingsmetoder styres fra Stripe Dashboard. Afviser Stripe et valgfrit felt, prøves igen uden det.
    let p = params;
    let cs: { url: string } | null = null;
    for (let attempt = 0; !cs; attempt++) {
      try {
        cs = await create(p);
      } catch (err) {
        const opt = err instanceof StripeError && err.status === 400 && attempt < 2 ? ['branding_settings', 'locale'].find((k) => err.message.includes(k)) : undefined;
        if (!opt) throw err;
        p = Object.fromEntries(Object.entries(p).filter(([k]) => !k.startsWith(opt)));
      }
    }
    return c.redirect(cs.url, 303);
  } catch (err) {
    await logError(c.env.DB, 'Kortlink', err);
    return render(c, 'Tilføj betalingskort', cardPage({ csrf: c.get('csrf'), token, sub, error: 'Stripe kunne ikke åbnes lige nu. Prøv igen om lidt.' }), { status: 502 });
  }
});

card.get('/kort/:token/tak', async (c) => {
  const token = c.req.param('token');
  const subId = await readCardToken(c.env, token);
  const sessionId = c.req.query('session_id') ?? '';
  if (!subId || !/^cs_[A-Za-z0-9_]{8,200}$/.test(sessionId)) return invalid(c);
  try {
    const done = await attachCardFromSession(c.env, sessionId, subId);
    if (!done) return c.redirect(`/kort/${token}`, 303);
  } catch (err) {
    await logError(c.env.DB, 'Kort-tilknyt', err);
    return render(c, 'Tilføj betalingskort', errorPage('Kortet blev gemt, men…', 'Vi kunne ikke færdiggøre opsætningen lige nu. Vi kigger på det, og du behøver ikke gøre mere.', { href: 'https://veyro.dk', label: 'Til veyro.dk' }), { status: 502 });
  }
  return render(c, 'Tak', html`<div class="narrow stack-lg">
  <div><h1>Tak, dit kort er tilføjet</h1><p class="lead">Betalingen trækkes nu automatisk hver måned. Du får en kvittering på mail fra Stripe, hver gang.</p></div>
  <div class="card stack"><p>Du kan altid se dit abonnement og dine fakturaer i kundepanelet.</p><a class="btn btn-primary" href="/login">Log ind i kundepanelet</a></div>
</div>`);
});

export default card;
