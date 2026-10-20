import { Hono } from 'hono';
import type { AppEnv, Env } from './env';
import { fetchFeeds, readProductPages } from './lib/estimates';
import { syncKatalogLogged, syncKatalogOnce } from './lib/katalog';
import { appIcon } from './lib/icon';
import { runPurchaseDigest } from './lib/notices';
import { cleanup, csrfMiddleware, requireUser, sessionMiddleware } from './lib/session';
import { getLogo, getSettings } from './lib/settings';
import { render } from './render';
import auth from './routes/auth';
import { bilagRoutes } from './routes/bilag';
import betalinger from './routes/betalinger';
import retur from './routes/retur';
import guide from './routes/guide';
import job from './routes/job';
import okonomi from './routes/jobokonomi';
import lager from './routes/lager';
import { jobKatalog, katalog } from './routes/produktkatalog';
import { KATALOG_JS } from './views/katalog-js';
import { CSS, JS } from './views/assets';
import { pageHead } from './views/common';
import { INTER_TIGHT } from './views/font';
import { favicon } from './views/layout';
import { SERVICE_WORKER, iconColors, manifest } from './views/pwa';

const app = new Hono<AppEnv>();

// http:// på systemets egen adresse sendes videre til https://, så intet (fx login-links) går ukrypteret
app.use('*', async (c, next) => {
  const url = new URL(c.req.url);
  if (url.protocol === 'http:' && c.env.APP_URL?.startsWith('https://') && new URL(c.env.APP_URL).host === url.host) {
    url.protocol = 'https:';
    return c.redirect(url.toString(), 301);
  }
  await next();
});

// Sikkerheds-headers på alle svar
app.use('*', async (c, next) => {
  await next();
  const h = c.res.headers;
  // Ruter med deres egen, strengere politik (fx /logo) beholder den
  if (!h.has('Content-Security-Policy')) h.set(
    'Content-Security-Policy',
    [
      "default-src 'self'",
      "script-src 'self'",
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data:",
      "font-src 'self'",
      "connect-src 'self'",
      "form-action 'self'",
      "frame-ancestors 'none'",
      "base-uri 'none'",
      "object-src 'none'",
    ].join('; '),
  );
  h.set('X-Content-Type-Options', 'nosniff');
  if (!h.has('X-Frame-Options')) h.set('X-Frame-Options', 'DENY');
  if (!h.has('Referrer-Policy')) h.set('Referrer-Policy', 'same-origin');
  h.set('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=()');
  h.set('Cross-Origin-Opener-Policy', 'same-origin');
  h.set('X-Robots-Tag', 'noindex, nofollow');
  if (new URL(c.req.url).protocol === 'https:') h.set('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  if (!h.has('Cache-Control')) h.set('Cache-Control', 'no-store');
});

// Statiske filer
const STATIC_CACHE = 'public, max-age=3600';
app.get('/static/app.css', (c) => c.body(CSS, 200, { 'Content-Type': 'text/css; charset=utf-8', 'Cache-Control': STATIC_CACHE }));
app.get('/static/app.js', (c) => c.body(JS, 200, { 'Content-Type': 'text/javascript; charset=utf-8', 'Cache-Control': STATIC_CACHE }));
app.get('/static/katalog.js', (c) => c.body(KATALOG_JS, 200, { 'Content-Type': 'text/javascript; charset=utf-8', 'Cache-Control': STATIC_CACHE }));
app.get('/static/inter-tight.woff2', (c) =>
  c.body(INTER_TIGHT, 200, { 'Content-Type': 'font/woff2', 'Cache-Control': 'public, max-age=31536000, immutable' }),
);
app.get('/healthz', (c) => c.text('ok'));
app.get('/robots.txt', (c) => c.text('User-agent: *\nDisallow: /\n', 200, { 'Cache-Control': STATIC_CACHE }));

// Virksomhedens indstillinger bruges af alle sider (navn, farve m.m.)
app.use('*', async (c, next) => {
  c.set('settings', await getSettings(c.env.DB));
  syncKatalogOnce(c.env, c.executionCtx);
  await next();
});
app.get('/favicon.svg', (c) => c.body(favicon(c.get('settings')), 200, { 'Content-Type': 'image/svg+xml', 'Cache-Control': STATIC_CACHE }));
app.get('/favicon.ico', (c) => c.redirect('/favicon.svg', 301));

// Virksomhedens logo (vises også på login-siden, så det kræver ikke login)
app.get('/logo', async (c) => {
  const logo = await getLogo(c.env.DB);
  if (!logo) return c.notFound();
  return c.body(logo.bytes, 200, {
    'Content-Type': logo.type,
    'Cache-Control': 'public, max-age=31536000, immutable',
    // Et SVG-logo må aldrig kunne køre kode, heller ikke hvis det åbnes direkte
    'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; sandbox",
  });
});

// Installerbar app (manifest, ikoner og service worker)
app.get('/manifest.webmanifest', (c) =>
  c.body(manifest(c.get('settings')), 200, { 'Content-Type': 'application/manifest+json; charset=utf-8', 'Cache-Control': 'public, max-age=300' }),
);
app.get('/icons/:file{(192|512|180)\\.png}', async (c) => {
  const [bg, dot] = iconColors(c.get('settings'));
  return c.body(await appIcon(parseInt(c.req.param('file'), 10), bg, dot), 200, { 'Content-Type': 'image/png', 'Cache-Control': STATIC_CACHE });
});
app.get('/sw.js', (c) => c.body(SERVICE_WORKER, 200, { 'Content-Type': 'text/javascript; charset=utf-8', 'Cache-Control': 'no-cache' }));

app.use('*', sessionMiddleware);
app.use('*', csrfMiddleware);

app.get('/offline', (c) =>
  render(c, 'Ingen forbindelse', pageHead('Offline', 'Ingen forbindelse', '', 'Lager og job hentes altid direkte, så tallene er rigtige. Prøv igen, når du har forbindelse.'), { portal: 'none' }),
);

app.route('/', auth);
app.use('/lager/*', requireUser);
app.route('/lager/bilag', bilagRoutes('lager'));
app.route('/lager/retur', retur);
app.route('/lager/guide', guide);
app.route('/job/bilag', bilagRoutes('job'));
app.route('/job', betalinger);
app.route('/lager', lager);
app.route('/katalog', katalog);
app.route('/job', jobKatalog);
app.route('/job', job);
app.route('/job', okonomi);

app.notFound((c) => render(c, 'Siden findes ikke', pageHead('Fejl 404', 'Siden findes ikke', '', 'Vi kunne ikke finde den side, du leder efter.'), { portal: 'none' }, 404));

app.onError((err, c) => {
  console.error('Uventet fejl:', err.message);
  return c.html(
    `<!doctype html><html lang="da"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Fejl</title><link rel="stylesheet" href="/static/app.css"><body><main><div class="wrap narrow stack-lg"><h1>Der opstod en fejl</h1><p class="muted">Prøv igen om lidt. Intet er registreret to gange: en registrering gemmes enten helt eller slet ikke.</p><a class="btn btn-primary" href="/">Til forsiden</a></div></main></body></html>`,
    500,
  );
});

export default {
  fetch: app.fetch,
  async scheduled(_event: ScheduledController, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil(cleanup(env.DB));
    // Brugerne i kundekataloget, så Kundelogin på kunde.veyro.dk kan sende dem hertil
    ctx.waitUntil(syncKatalogLogged(env));
    // Samlet e-mail med nye indkøbsbehov med det valgte interval (slået fra som standard)
    ctx.waitUntil(getSettings(env.DB).then((s) => runPurchaseDigest(env, s)));
    // Officielle prisfiler fra forhandlere med et feed (højst hver 6. time; fejl stopper intet andet)
    ctx.waitUntil(fetchFeeds(env, Math.floor(Date.now() / 1000)).catch((e) => console.error('Prisfeed fejlede:', (e as Error)?.message)));
    // Offentlige produktsider hos butikker, hvor læsning er slået til (højst hver 6. time pr. side)
    ctx.waitUntil(readProductPages(env, Math.floor(Date.now() / 1000)).catch((e) => console.error('Produktsider fejlede:', (e as Error)?.message)));
  },
} satisfies ExportedHandler<Env>;
