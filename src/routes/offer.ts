import { Hono } from 'hono';
import type { AppEnv } from '../env';
import { sha256Hex } from '../lib/crypto';
import { rateLimit } from '../lib/db';
import { logError } from '../lib/errlog';
import { checkoutForOffer, getOfferByToken } from '../lib/offers';
import { render } from '../render';
import { publicOfferPage, publicOfferThanksPage } from '../views/offers';
import { errorPage } from '../views/pages';

/** Kundens personlige tilbudsside: /tilbud/<token> → godkend → Stripe Checkout. */
const offer = new Hono<AppEnv>();

const notFound = (c: Parameters<typeof render>[0]) =>
  render(c, 'Tilbuddet findes ikke', errorPage('Tilbuddet findes ikke', 'Linket er ugyldigt. Skriv til kontakt@veyro.dk, så hjælper vi.', { href: 'https://veyro.dk', label: 'Til veyro.dk' }), {
    status: 404,
  });

offer.get('/tilbud/:token', async (c) => {
  const o = await getOfferByToken(c.env.DB, c.req.param('token'));
  if (!o) return notFound(c);
  return render(c, `Tilbud: ${o.service}`, publicOfferPage({ csrf: c.get('csrf'), offer: o }));
});

offer.post('/tilbud/:token', async (c) => {
  const ip = c.req.header('CF-Connecting-IP') ?? 'ukendt';
  if (!(await rateLimit(c.env.DB, 'offer-ip:' + (await sha256Hex(ip)), 30, 15 * 60))) return c.text('For mange forsøg. Vent lidt, og prøv igen.', 429);
  const o = await getOfferByToken(c.env.DB, c.req.param('token'));
  if (!o) return notFound(c);
  const body = await c.req.parseBody();
  const page = (error: string, status: 400 | 409 | 502) =>
    render(c, `Tilbud: ${o.service}`, publicOfferPage({ csrf: c.get('csrf'), offer: o, error, checked: body['accept'] === '1' }), { status });
  if (body['accept'] !== '1') return page('Sæt kryds for at godkende tilbuddet og vilkårene, før du går videre til betaling.', 400);
  try {
    const res = await checkoutForOffer(c.env, o.id);
    if ('url' in res) return c.redirect(res.url, 303);
    if (res.state === 'first-charge-passed') return page('Datoen for første opkrævning er for tæt på. Skriv til kontakt@veyro.dk, så sender vi et opdateret link.', 409);
    if (res.state === 'busy') return page('Betalingssiden er ved at blive åbnet. Prøv igen om et øjeblik.', 409);
    return c.redirect(`/tilbud/${o.token}`, 303);
  } catch (err) {
    await logError(c.env.DB, 'Tilbud-checkout', err);
    return page('Betalingssiden kunne ikke åbnes lige nu. Prøv igen om lidt, eller skriv til kontakt@veyro.dk.', 502);
  }
});

offer.get('/tilbud/:token/tak', async (c) => {
  const o = await getOfferByToken(c.env.DB, c.req.param('token'));
  if (!o) return notFound(c);
  return render(c, 'Tak', publicOfferThanksPage({ offer: o }));
});

export default offer;
