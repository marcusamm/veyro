import { Hono } from 'hono';
import type { AppEnv, Env } from './env';
import { cleanup } from './lib/db';
import { logError } from './lib/errlog';
import { csrfMiddleware, sessionMiddleware } from './lib/session';
import { render } from './render';
import account from './routes/account';
import admin from './routes/admin';
import auth from './routes/auth';
import card from './routes/card';
import offer from './routes/offer';
import pub from './routes/public';
import webhook from './routes/webhook';
import adminSite from './routes/admin-site';
import adminStats from './routes/admin-stats';
import adminPoa from './routes/admin-poa';
import adminNda from './routes/admin-nda';
import kasse from './routes/kasse';
import adminProspects from './routes/admin-prospects';
import adminCosts from './routes/admin-costs';
import adminMail from './routes/admin-mail';
import adminProspectTools from './routes/admin-prospect-tools';
import { runMailSync } from './lib/gmail-sync';
import { runJobs } from './lib/prospect-jobs';
import { reconcilePending } from './lib/pos/sales';
import { getPosSettings } from './lib/pos/settings';
import { applyRetention as ndaRetention } from './lib/nda';
import { deliverAll as ndaDeliverAll, queueMail as ndaQueueMail, retryMails as ndaRetryMails } from './lib/nda-docs';
import { policyPage } from './routes/aftaler';
import { applyRetention, expireDue } from './lib/poa';
import { deliverAll, queueMail, retryMails } from './lib/poa-docs';
import site, { isSiteRequest } from './site/app';
import { purgeOldLeads } from './site/leads';
import { CSS, FAVICON, JS } from './views/assets';
import { KASSE_CSS, KASSE_JS } from './views/kasse-assets';
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
      // *.veyro.dk: Kundelogin sender brugere videre til deres virksomheds system
      "form-action 'self' https://checkout.stripe.com https://billing.stripe.com https://*.veyro.dk",
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
app.get('/static/kasse.css', (c) => c.body(KASSE_CSS, 200, { 'Content-Type': 'text/css; charset=utf-8', 'Cache-Control': STATIC_CACHE }));
app.get('/static/kasse.js', (c) => c.body(KASSE_JS, 200, { 'Content-Type': 'text/javascript; charset=utf-8', 'Cache-Control': STATIC_CACHE }));
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
app.route('/', offer);
app.route('/konto', account);
app.get('/fuldmagter/opbevaring', policyPage);
// Kassen før resten af admin: medarbejdere med en rolle i kassen skal kunne bruge den uden ADMIN_EMAILS
app.route('/admin/kasse', kasse);
// Faste undersider (mail, link, find) før /kundeemner/:id
app.route('/admin', adminMail);
app.route('/admin', adminProspectTools);
app.route('/admin', adminProspects);
app.route('/admin', adminCosts);
app.route('/admin', adminSite);
app.route('/admin', adminStats);
app.route('/admin', adminPoa);
app.route('/admin', adminNda);
app.route('/admin', admin);

app.notFound((c) =>
  render(c, 'Siden findes ikke', errorPage('Siden findes ikke', 'Vi kunne ikke finde den side, du leder efter.'), { status: 404 }),
);

app.onError((err, c) => {
  console.error('Uventet fejl:', err.message);
  // Gemmes i error_log, så fejlen kan findes bagefter (kun metode og sti, ingen forespørgselsdata)
  c.executionCtx.waitUntil(logError(c.env.DB, `Kundepanel ${c.req.method} ${new URL(c.req.url).pathname}`, err));
  return c.html(
    `<!doctype html><html lang="da"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Fejl · Veyro</title><link rel="stylesheet" href="/static/app.css"><body><main><div class="wrap narrow stack-lg"><h1>Der opstod en fejl</h1><p class="lead">Prøv igen om lidt. Fortsætter problemet, så skriv til <a href="mailto:kontakt@veyro.dk">kontakt@veyro.dk</a>.</p><a class="btn btn-primary" href="/">Til forsiden</a></div></main></body></html>`,
    500,
  );
});

/** Skal svare til den hyppige cron i wrangler.toml; den daglige oprydning kører kun ved den daglige */
const FREQUENT_CRON = '*/10 * * * *';

export default {
  // Salgshjemmesiden (veyro.dk) og kundepanelet (kunde.veyro.dk) kører i samme Worker; domænet afgør hvilken.
  fetch(req: Request, env: Env, ctx: ExecutionContext) {
    return isSiteRequest(req, env) ? site.fetch(req, env, ctx) : app.fetch(req, env, ctx);
  },
  async scheduled(event: ScheduledController, env: Env, ctx: ExecutionContext) {
    // Kundeemner (hvert 10. minut): Gmail-synkronisering og genforsøg på hentninger. Gør intet, før Google er sat op.
    ctx.waitUntil(runMailSync(env).catch((err) => logError(env.DB, 'Gmail cron', err)));
    ctx.waitUntil(runJobs(env).catch((err) => logError(env.DB, 'Kundeemner cron', err)));
    if (event.cron === FREQUENT_CRON) return;
    ctx.waitUntil(cleanup(env.DB));
    ctx.waitUntil(purgeOldLeads(env.DB));
    // Fuldmagter: udløb, opbevaringspolitik og genforsøg på mails
    ctx.waitUntil(
      (async () => {
        await expireDue(env.DB);
        const done = await applyRetention(env.DB);
        for (const rid of done) {
          const req = await env.DB.prepare('SELECT c.email FROM poa_deletion_requests d JOIN customers c ON c.id = d.customer_id WHERE d.id = ?')
            .bind(rid)
            .first<{ email: string }>();
          if (req) await deliverAll(env, [await queueMail(env.DB, { deletionRequestId: rid, kind: 'deletion_result', to: req.email })]);
        }
        await retryMails(env);
      })().catch((err) => logError(env.DB, 'Fuldmagter cron', err)),
    );
    // Kassen: kortbetalinger, der har ventet over 30 minutter, afsluttes eller annulleres
    ctx.waitUntil(
      (async () => reconcilePending(env, await getPosSettings(env.DB)))().catch((err) => logError(env.DB, 'Kasse cron', err)),
    );
    // Fortrolighedsaftaler: opbevaringsfrister, gamle kladder og genforsøg på mails
    ctx.waitUntil(
      (async () => {
        for (const rid of await ndaRetention(env.DB)) {
          const req = await env.DB.prepare('SELECT c.email FROM nda_requests r JOIN customers c ON c.id = r.customer_id WHERE r.id = ?')
            .bind(rid)
            .first<{ email: string }>();
          if (req) await ndaDeliverAll(env, [await ndaQueueMail(env.DB, { requestId: rid, kind: 'request_result', to: req.email })]);
        }
        await ndaRetryMails(env);
      })().catch((err) => logError(env.DB, 'Fortrolighedsaftaler cron', err)),
    );
  },
} satisfies ExportedHandler<Env>;
