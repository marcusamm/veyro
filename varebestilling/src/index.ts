import { Hono } from 'hono';
import type { AppEnv, Env } from './env';
import { getSettings } from './lib/settings';
import { cleanup, csrfMiddleware, sessionMiddleware } from './lib/session';
import { renderShop } from './render';
import admin from './routes/admin';
import shop from './routes/shop';
import { CSS, JS } from './views/assets';
import { favicon } from './views/layout';
import { messagePage } from './views/shop';

const app = new Hono<AppEnv>();

// Sikkerheds-headers på alle svar
app.use('*', async (c, next) => {
  await next();
  const h = c.res.headers;
  h.set(
    'Content-Security-Policy',
    [
      "default-src 'self'",
      "script-src 'self'",
      "style-src 'self' 'unsafe-inline'",
      // Varebilleder kan ligge hos kundens eget webhotel eller CDN
      "img-src 'self' data: https:",
      "font-src 'self'",
      "connect-src 'self'",
      "form-action 'self'",
      "frame-ancestors 'none'",
      "base-uri 'none'",
      "object-src 'none'",
    ].join('; '),
  );
  h.set('X-Content-Type-Options', 'nosniff');
  h.set('X-Frame-Options', 'DENY');
  if (!h.has('Referrer-Policy')) h.set('Referrer-Policy', 'same-origin');
  h.set('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=()');
  h.set('Cross-Origin-Opener-Policy', 'same-origin');
  if (new URL(c.req.url).protocol === 'https:') h.set('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  if (!h.has('Cache-Control')) h.set('Cache-Control', 'no-store');
});

// Statiske filer
const STATIC_CACHE = 'public, max-age=3600';
app.get('/static/app.css', (c) => c.body(CSS, 200, { 'Content-Type': 'text/css; charset=utf-8', 'Cache-Control': STATIC_CACHE }));
app.get('/static/app.js', (c) => c.body(JS, 200, { 'Content-Type': 'text/javascript; charset=utf-8', 'Cache-Control': STATIC_CACHE }));
app.get('/healthz', (c) => c.text('ok'));
app.get('/robots.txt', (c) => c.text('User-agent: *\nDisallow: /admin\nDisallow: /kurv\nDisallow: /kassen\nDisallow: /ordre/\n', 200, { 'Cache-Control': STATIC_CACHE }));

// Butikkens indstillinger bruges af alle sider (navn, farve, levering m.m.)
app.use('*', async (c, next) => {
  c.set('settings', await getSettings(c.env.DB));
  await next();
});
app.get('/favicon.svg', (c) => c.body(favicon(c.get('settings')), 200, { 'Content-Type': 'image/svg+xml', 'Cache-Control': STATIC_CACHE }));
app.get('/favicon.ico', (c) => c.redirect('/favicon.svg', 301));

app.use('*', sessionMiddleware);
app.use('*', csrfMiddleware);

app.route('/admin', admin);
app.route('/', shop);

app.notFound((c) => renderShop(c, 'Siden findes ikke', messagePage('Siden findes ikke', 'Vi kunne ikke finde den side, du leder efter.'), { status: 404, noindex: true }));

app.onError((err, c) => {
  console.error('Uventet fejl:', err.message);
  return c.html(
    `<!doctype html><html lang="da"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Fejl</title><link rel="stylesheet" href="/static/app.css"><body><main><div class="wrap narrow stack-lg"><h1>Der opstod en fejl</h1><p class="muted">Prøv igen om lidt.</p><a class="btn btn-primary" href="/">Til forsiden</a></div></main></body></html>`,
    500,
  );
});

export default {
  fetch: app.fetch,
  async scheduled(_event: ScheduledController, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil(cleanup(env.DB));
  },
} satisfies ExportedHandler<Env>;
