import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import type { AppEnv, Env } from '../env';
import { INTER_TIGHT_WOFF2 } from '../views/brand';
import api from './api';
import { adminPage, adminCss, adminJs } from './admin-view';
import { js } from './client';
import { css } from './styles';
import { shell, home, services, about, booking, contact, manage, favicon } from './views';

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
app.get('/aj-font.woff2', c => c.body(INTER_TIGHT_WOFF2, 200, { 'Content-Type': 'font/woff2' }));
app.get('/aj-logo.png', c => c.env.ASSETS ? c.env.ASSETS.fetch(new Request(new URL('/aj/logo.png', c.req.url), c.req.raw)) : c.notFound());
app.get('/favicon.svg', c => c.body(favicon, 200, { 'Content-Type': 'image/svg+xml' }));
app.get('/favicon.ico', c => c.redirect('/favicon.svg', 301));
app.route('/api', api);
app.get('/', c => c.html(shell('/', 'AJ Auto i Slagelse | Olieskift, køb, salg & bytte', 'Kontakt AJ Auto på Sorøvej i Slagelse om olieskift, køb, salg og bytte. Ring 60 64 41 43, eller book en ledig tid online.', home)));
app.get('/ydelser', c => c.html(shell('/ydelser', 'Olieskift og bilhandel i Slagelse | AJ Auto', 'Læs om olieskift med motorolie og oliefilter samt køb, salg og bytte hos AJ Auto i Slagelse. Kontakt os om din bil.', services)));
app.get('/om-os', c => c.html(shell('/om-os', 'Om AJ Auto | Køb, salg & bytte i Slagelse', 'AJ Auto holder til på Sorøvej 5kl i Slagelse. Kontakt os om olieskift eller mulighederne for køb, salg og bytte af bil.', about)));
app.get('/booking', c => c.html(shell('/booking', 'Book tid hos AJ Auto | Slagelse', 'Vælg ydelse og en ledig tid hos AJ Auto i Slagelse. Se og administrer din aftale via dit personlige bookinglink.', booking)));
app.get('/booking/aftale', c => c.html(shell('/booking/aftale', 'Din aftale | AJ Auto', 'Se, flyt eller aflys din aftale hos AJ Auto.', manage, { noindex: true })));
app.get('/kontakt', c => c.html(shell('/kontakt', 'Kontakt AJ Auto | 60 64 41 43 · Slagelse', 'Ring til AJ Auto på 60 64 41 43. Find os på Sorøvej 5kl i Slagelse, få rutevejledning, eller send en besked.', contact)));
app.get('/admin', c => c.html(shell('/admin', 'Værkstedets administration | AJ Auto', 'Beskyttet administration af aftaler og booking hos AJ Auto.', adminPage(), { admin: true, noindex: true })));
app.get('/robots.txt', c => c.text(new URL(c.req.url).hostname === 'aj.veyro.dk' ? 'User-agent: *\nAllow: /\nDisallow: /admin\nDisallow: /api/\nDisallow: /booking/aftale\nSitemap: https://aj.veyro.dk/sitemap.xml\n' : 'User-agent: *\nDisallow: /\n'));
app.get('/sitemap.xml', c => c.body(`<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${['/', '/ydelser', '/om-os', '/booking', '/kontakt'].map(path => `<url><loc>https://aj.veyro.dk${path}</loc></url>`).join('')}</urlset>`, 200, { 'Content-Type': 'application/xml' }));
app.notFound(c => c.html(shell(c.req.path, 'Siden findes ikke | AJ Auto', 'Find tilbage til AJ Autos hjemmeside.', '<section class="container page-intro"><p class="eyebrow">404</p><h1>Den side kunne<br>vi ikke finde.</h1><a class="button" href="/">Til forsiden ↗</a></section>', { noindex: true }), 404));
app.onError((_error, c) => c.req.path.startsWith('/api') ? c.json({ error: 'Handlingen kunne ikke gennemføres. Prøv igen, eller ring til AJ Auto på 60 64 41 43.' }, 500) : c.html(shell('/', 'Midlertidig fejl | AJ Auto', 'Kontakt AJ Auto på 60 64 41 43.', '<section class="container page-intro"><h1>Prøv igen<br>om lidt.</h1><p>Vi kunne ikke indlæse siden. Ring til os på <a href="tel:+4560644143">60 64 41 43</a>, hvis du har brug for hjælp.</p></section>', { noindex: true }), 500));
export default app;
