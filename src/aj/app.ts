import { Hono, type Context } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import type { AppEnv, Env } from '../env';
import { getSettings, readiness } from './store';
import api from './api';
import { adminPage, adminCss, adminJs } from './admin-view';
import { js } from './client';
import { css } from './styles';
import { shell, home, services, about, booking, contact, manage } from './views';

export function isAjRequest(req: Request, env: Env): boolean {
  const host = new URL(req.url).hostname.toLowerCase();
  return (env.AJ_HOSTS || 'aj.veyro.dk').split(',').some(value => value.trim().toLowerCase() === host);
}

const app = new Hono<AppEnv>();
app.use('*', async (c, next) => {
  await next();
  c.header('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self'; connect-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'; object-src 'none'");
  c.header('X-Content-Type-Options', 'nosniff');
  c.header('X-Frame-Options', 'DENY');
  c.header('Referrer-Policy', 'no-referrer');
  c.header('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=()');
  c.header('Cache-Control', 'no-store');
  if (new URL(c.req.url).protocol === 'https:') c.header('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  if (c.req.path.startsWith('/api') || c.req.path.startsWith('/admin') || c.req.path.startsWith('/booking/aftale') || new URL(c.req.url).hostname !== 'aj.veyro.dk') c.header('X-Robots-Tag', 'noindex, nofollow');
});
app.use('/api/*', bodyLimit({ maxSize: 20 * 1024, onError: c => c.json({ error: 'Formularen indeholder for meget tekst.' }, 413) }));
app.get('/healthz', c => c.text('ok'));
app.get('/aj.css', c => c.body(css, 200, { 'Content-Type': 'text/css; charset=utf-8' }));
app.get('/aj.js', c => c.body(js, 200, { 'Content-Type': 'text/javascript; charset=utf-8' }));
app.get('/aj-admin.css', c => c.body(adminCss, 200, { 'Content-Type': 'text/css; charset=utf-8' }));
app.get('/aj-admin.js', c => c.body(adminJs, 200, { 'Content-Type': 'text/javascript; charset=utf-8' }));
app.get('/aj-logo.png', c => c.env.ASSETS ? c.env.ASSETS.fetch(new Request(new URL('/aj/logo.png', c.req.url), c.req.raw)) : c.notFound());
app.get('/favicon.svg', c => c.redirect('/aj-logo.png', 301));
app.get('/favicon.ico', c => c.redirect('/aj-logo.png', 301));
app.route('/api', api);
// Render the action with the page so it works before JavaScript loads.
async function canBook(env: Env): Promise<boolean> {
  try {
    const settings = await getSettings(env.DB);
    return settings.bookingEnabled && (await readiness(env, settings)).ready;
  } catch {
    // Customers can still reach the workshop while the calendar is unavailable.
    return false;
  }
}

type Page = {
  title: string;
  description: string;
  content: (bookingReady: boolean) => string;
  noindex?: boolean;
  admin?: boolean;
};

async function render(c: Context<AppEnv>, page: Page, status: 200 | 404 = 200) {
  const bookingReady = await canBook(c.env);
  const options = { bookingReady, noindex: page.noindex, admin: page.admin };
  return c.html(shell(c.req.path, page.title, page.description, page.content(bookingReady), options), status);
}

const pages: Record<string, Page> = {
  '/': {
    title: 'Olieskift og bilhandel i Slagelse | AJ Auto',
    description: 'Autoværksted og bilhandel på Sorøvej i Slagelse. Vi tilbyder olieskift, serviceeftersyn, reparationer, fejlfinding og klargøring til syn.',
    content: home,
  },
  '/ydelser': {
    title: 'Værkstedsydelser og bilhandel i Slagelse | AJ Auto',
    description: 'Få olieskift, serviceeftersyn, reparationer, motorarbejde, fejlfinding og klargøring til syn hos AJ Auto. Vi køber, sælger og bytter også biler.',
    content: services,
  },
  '/om-os': {
    title: 'Om værkstedet på Sorøvej | AJ Auto',
    description: 'AJ Auto er et lokalt værksted på Sorøvej 5kl i Slagelse. Du kan ringe til os på 60 64 41 43.',
    content: about,
  },
  '/kontakt': {
    title: 'Kontakt og rutevejledning | AJ Auto',
    description: 'Ring på 60 64 41 43, find vej til Sorøvej 5kl i Slagelse, eller skriv til AJ Auto.',
    content: contact,
  },
  '/booking': {
    title: 'Aftal tid til din bil | AJ Auto',
    description: 'Aftal et besøg hos AJ Auto på Sorøvej 5kl i Slagelse.',
    content: booking,
  },
  '/booking/aftale': {
    title: 'Din aftale | AJ Auto',
    description: 'Se tidspunktet, flyt din tid eller aflys din aftale.',
    content: manage, noindex: true,
  },
  '/admin': {
    title: 'Værkstedets login | AJ Auto',
    description: 'Log ind for at se værkstedets aftaler, beskeder og kalendere.',
    content: adminPage, admin: true, noindex: true,
  },
};

for (const [path, page] of Object.entries(pages)) {
  app.get(path, c => render(c, page));
}
app.get('/robots.txt', c => c.text(new URL(c.req.url).hostname === 'aj.veyro.dk' ? 'User-agent: *\nAllow: /\nDisallow: /admin\nDisallow: /api/\nDisallow: /booking/aftale\nSitemap: https://aj.veyro.dk/sitemap.xml\n' : 'User-agent: *\nDisallow: /\n'));
app.get('/sitemap.xml', c => c.body(`<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${['/', '/ydelser', '/om-os', '/booking', '/kontakt'].map(path => `<url><loc>https://aj.veyro.dk${path}</loc></url>`).join('')}</urlset>`, 200, { 'Content-Type': 'application/xml' }));
app.notFound(c => render(c, {
  title: 'Siden findes ikke | AJ Auto',
  description: 'Gå til forsiden eller kontakt AJ Auto.',
  content: () => `<section class="container message-page"><h1>Siden findes ikke</h1>
    <p>Linket kan være gammelt. Du kan finde vores ydelser og kontaktoplysninger på forsiden.</p>
    <a class="button" href="/">Gå til forsiden</a></section>`,
  noindex: true,
}, 404));

app.onError((_error, c) => {
  const message = 'Prøv igen om lidt, eller ring på 60 64 41 43.';
  if (c.req.path.startsWith('/api')) return c.json({ error: message }, 500);
  return c.html(shell(c.req.path, 'Siden kunne ikke indlæses | AJ Auto', message,
    `<section class="container message-page"><h1>Siden kunne ikke indlæses</h1>
     <p>Prøv igen om lidt, eller ring til værkstedet.</p>
     <a class="button" href="tel:+4560644143">Ring på 60 64 41 43</a></section>`,
    { noindex: true, bookingReady: false }), 500);
});
export default app;
