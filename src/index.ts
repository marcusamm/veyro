import { Hono } from 'hono';
import type { AppEnv, Env } from './env';
import { cleanup } from './lib/db';
import { csrfMiddleware, sessionMiddleware } from './lib/session';
import { render } from './render';
import account from './routes/account';
import admin from './routes/admin';
import auth from './routes/auth';
import card from './routes/card';
import pub from './routes/public';
import webhook from './routes/webhook';
import { CSS, FAVICON, JS } from './views/assets';
import { ICON_PNG, INTER_TIGHT_WOFF2, LOGO_PNG } from './views/brand';
import { errorPage } from './views/pages';

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
      "img-src 'self' data:",
      "font-src 'self'",
      "connect-src 'self'",
      "form-action 'self' https://checkout.stripe.com https://billing.stripe.com",
      "frame-ancestors 'none'",
      "base-uri 'none'",
      "object-src 'none'",
    ].join('; '),
  );
  h.set('X-Content-Type-Options', 'nosniff');
  h.set('X-Frame-Options', 'DENY');
  h.set('Referrer-Policy', 'same-origin'); // ikke no-referrer: så sender browsere Origin: null på egne formularer
  h.set('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=()');
  h.set('Cross-Origin-Opener-Policy', 'same-origin');
  if (new URL(c.req.url).protocol === 'https:') {
    h.set('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  }
  if (!h.has('Cache-Control')) h.set('Cache-Control', 'no-store');
});

// Statiske filer
const STATIC_CACHE = 'public, max-age=3600';
app.get('/static/app.css', (c) => c.body(CSS, 200, { 'Content-Type': 'text/css; charset=utf-8', 'Cache-Control': STATIC_CACHE }));
app.get('/static/app.js', (c) =>
  c.body(JS, 200, { 'Content-Type': 'text/javascript; charset=utf-8', 'Cache-Control': STATIC_CACHE }),
);
app.get('/favicon.svg', (c) => c.body(FAVICON, 200, { 'Content-Type': 'image/svg+xml', 'Cache-Control': STATIC_CACHE }));
app.get('/static/logo.png', (c) => c.body(LOGO_PNG, 200, { 'Content-Type': 'image/png', 'Cache-Control': STATIC_CACHE }));
app.get('/static/icon.png', (c) => c.body(ICON_PNG, 200, { 'Content-Type': 'image/png', 'Cache-Control': STATIC_CACHE }));
app.get('/static/inter-tight.woff2', (c) =>
  c.body(INTER_TIGHT_WOFF2, 200, { 'Content-Type': 'font/woff2', 'Cache-Control': 'public, max-age=31536000, immutable' }),
);
app.get('/favicon.ico', (c) => c.redirect('/favicon.svg', 301));
app.get('/robots.txt', (c) => c.text('User-agent: *\nDisallow: /\n', 200, { 'Cache-Control': STATIC_CACHE }));
app.get('/healthz', (c) => c.text('ok'));

// Stripe-webhook: før session/CSRF (verificeres med signatur i stedet)
app.route('/', webhook);

// Session + CSRF for resten
app.use('*', sessionMiddleware);
app.use('*', csrfMiddleware);

app.route('/', pub);
app.route('/', auth);
app.route('/', card);
app.route('/konto', account);
app.route('/admin', admin);

app.notFound((c) =>
  render(c, 'Siden findes ikke', errorPage('Siden findes ikke', 'Vi kunne ikke finde den side, du leder efter.'), { status: 404 }),
);

app.onError((err, c) => {
  console.error('Uventet fejl:', err.message);
  return c.html(
    `<!doctype html><html lang="da"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Fejl · Veyro</title><link rel="stylesheet" href="/static/app.css"><body><main><div class="wrap narrow stack-lg"><h1>Der opstod en fejl</h1><p class="lead">Prøv igen om lidt. Fortsætter problemet, så skriv til <a href="mailto:kontakt@veyro.dk">kontakt@veyro.dk</a>.</p><a class="btn btn-primary" href="/">Til forsiden</a></div></main></body></html>`,
    500,
  );
});

export default {
  fetch: app.fetch,
  async scheduled(_event: ScheduledController, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil(cleanup(env.DB));
  },
} satisfies ExportedHandler<Env>;
