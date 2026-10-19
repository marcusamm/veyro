// Forhandlere og prisfiler til prisestimater på indkøbslister.

import { Hono, type Context } from 'hono';
import type { AppEnv } from '../env';
import { feedUrlAllowed, getRetailer, importCatalog, retailers } from '../lib/estimates';
import { parseIntStrict, str } from '../lib/format';
import { parseFeed } from '../lib/prices';
import { saveSettings } from '../lib/settings';
import { render } from '../render';
import { pricingPage } from '../views/priser';

const priser = new Hono<AppEnv>();
const NAV = { portal: 'lager', tab: 'indstillinger' } as const;
const now = () => Math.floor(Date.now() / 1000);

async function show(c: Context<AppEnv>, result?: { kind: 'ok' | 'warn' | 'err'; text: string; errors: string[] }, status: 200 | 400 = 200) {
  return render(
    c,
    'Forhandlere og prisfiler',
    pricingPage({ retailers: await retailers(c.env.DB), settings: c.get('settings'), csrf: c.get('csrf'), flashCode: c.req.query('besked'), result }),
    NAV,
    status,
  );
}

priser.get('/', (c) => show(c));

priser.post('/indstillinger', async (c) => {
  const body = await c.req.parseBody();
  const days = parseIntStrict(body['price_max_age_days'], { max: 365 });
  if (!days) return show(c, { kind: 'err', text: 'Angiv antal dage (1-365).', errors: [] }, 400);
  await saveSettings(c.env.DB, { estimate_vat: body['estimate_vat'] === 'inkl' ? 'inkl' : 'ekskl', price_max_age_days: days });
  return c.redirect('/lager/priser?besked=gemt', 303);
});

priser.post('/:id{[0-9]+}', async (c) => {
  const r = await getRetailer(c.env.DB, Number(c.req.param('id')));
  if (!r || r.access === 'demo') return c.notFound();
  const body = await c.req.parseBody();
  const feed = str(body['feed_url'], 500);
  if (feed && !feedUrlAllowed(c.env, feed)) return show(c, { kind: 'err', text: 'Feedet skal være en https-adresse.', errors: [] }, 400);
  await c.env.DB.prepare('UPDATE retailers SET active = ?, feed_url = ?, last_error = CASE WHEN feed_url = ? THEN last_error ELSE \'\' END WHERE id = ?')
    .bind(body['active'] === '1' ? 1 : 0, feed, feed, r.id)
    .run();
  return c.redirect('/lager/priser?besked=gemt', 303);
});

priser.post('/:id{[0-9]+}/prisfil', async (c) => {
  const r = await getRetailer(c.env.DB, Number(c.req.param('id')));
  if (!r || r.access === 'demo') return c.notFound();
  const body = await c.req.parseBody();
  if (body['public'] !== '1') return show(c, { kind: 'err', text: 'Bekræft, at priserne er offentlige.', errors: [] }, 400);
  const file = body['file'];
  const text = typeof file === 'string' ? file : file instanceof File ? await file.text() : '';
  if (!text.trim()) return show(c, { kind: 'err', text: 'Vælg en prisfil.', errors: [] }, 400);
  if (text.length > 5_000_000) return show(c, { kind: 'err', text: 'Prisfilen er for stor (højst 5 MB).', errors: [] }, 400);
  const { items, errors, skipped } = parseFeed(text, r.website);
  if (!items.length) return show(c, { kind: 'err', text: 'Prisfilen blev ikke indlæst.', errors }, 400);
  await importCatalog(c.env.DB, r, items, 'prisfil', now());
  return show(c, {
    kind: errors.length ? 'warn' : 'ok',
    text: `${items.length} ${items.length === 1 ? 'pris' : 'priser'} fra ${r.name} er indlæst.${skipped ? ` ${skipped} rækker med priser bag login eller aftale er sprunget over.` : ''}${errors.length ? ` ${errors.length} rækker er afvist:` : ''}`,
    errors,
  });
});

export default priser;
