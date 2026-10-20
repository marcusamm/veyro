// Salgshjemmesiden veyro.dk. Kører i samme Worker som kundepanelet, men på sine egne domæner (SITE_HOSTS).
import { Hono, type Context } from 'hono';
import { getCookie, setCookie, deleteCookie } from 'hono/cookie';
import type { Env } from '../env';
import { sha256Hex } from '../lib/crypto';
import { normalizeEmail, rateLimit } from '../lib/db';
import { adminNoticeEmail, sendEmail } from '../lib/email';
import { logError } from '../lib/errlog';
import { formatKr } from '../lib/format';
import { loadSite, type SiteData } from './content';
import { asset, THEME_VERSION, translate, warmUp, type FormState } from './engine';
import { countView, createLead, LEAD_KIND_LABEL, markLeadNotified, type LeadCartLine, type LeadKind } from './leads';
import { cartDrop, renderSitePage, type CartLine, type RenderRequest } from './render';

warmUp();

type SiteEnv = { Bindings: Env; Variables: { nonce: string } };
const site = new Hono<SiteEnv>();

export function siteHosts(env: Env): string[] {
  return (env.SITE_HOSTS ?? '')
    .split(',')
    .map((h) => h.trim().toLowerCase())
    .filter(Boolean);
}
export function isSiteRequest(req: Request, env: Env): boolean {
  const host = new URL(req.url).hostname.toLowerCase();
  return siteHosts(env).includes(host);
}
function canonicalOrigin(env: Env): string {
  return (env.SITE_URL || 'https://veyro.dk').replace(/\/+$/, '');
}
function isCanonicalHost(c: Context<SiteEnv>): boolean {
  return new URL(c.req.url).host === new URL(canonicalOrigin(c.env)).host;
}

// ---------- Sikkerhed og headers ----------

site.use('*', async (c, next) => {
  const url = new URL(c.req.url);
  // www.veyro.dk → veyro.dk
  if (url.hostname.startsWith('www.') && siteHosts(c.env).includes(url.hostname.slice(4))) {
    url.hostname = url.hostname.slice(4);
    return c.redirect(url.toString(), 301);
  }
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  const nonce = btoa(String.fromCharCode(...bytes));
  c.set('nonce', nonce);
  await next();
  const h = c.res.headers;
  h.set(
    'Content-Security-Policy',
    [
      "default-src 'self'",
      // Trustpilots widget indlæses kun efter samtykke (se sections/trustpilot.liquid)
      `script-src 'self' 'nonce-${nonce}' https://widget.trustpilot.com`,
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data: https://*.trustpilot.com",
      "font-src 'self'",
      "connect-src 'self' https://*.trustpilot.com",
      'frame-src https://widget.trustpilot.com',
      "form-action 'self'",
      "frame-ancestors 'none'",
      "base-uri 'none'",
      "object-src 'none'",
    ].join('; '),
  );
  h.set('X-Content-Type-Options', 'nosniff');
  h.set('X-Frame-Options', 'DENY');
  h.set('Referrer-Policy', 'strict-origin-when-cross-origin');
  h.set('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=()');
  if (url.protocol === 'https:') h.set('Strict-Transport-Security', 'max-age=31536000');
  // Prøveadressen (fx ny.veyro.dk) må ikke indekseres af søgemaskiner
  if (!isCanonicalHost(c)) h.set('X-Robots-Tag', 'noindex, nofollow');
  if (!h.has('Cache-Control')) h.set('Cache-Control', 'no-store');
});

/** Formularer må kun sendes fra siden selv */
function sameOrigin(c: Context<SiteEnv>): boolean {
  const self = new URL(c.req.url).origin;
  const origin = c.req.header('Origin');
  if (origin) return origin === self;
  if (c.req.header('Sec-Fetch-Site') === 'cross-site') return false;
  const ref = c.req.header('Referer');
  if (ref) {
    try {
      return new URL(ref).origin === self;
    } catch {
      return false;
    }
  }
  return true;
}

// ---------- Statiske filer ----------

site.get('/assets/:name', (c) => {
  const a = asset(c.req.param('name'));
  if (!a) return c.text('Ikke fundet', 404);
  const versioned = c.req.query('v') === THEME_VERSION;
  return c.body(a.body as any, 200, { 'Content-Type': a.type, 'Cache-Control': versioned ? 'public, max-age=31536000, immutable' : 'public, max-age=3600' });
});

site.get('/files/:id', async (c) => {
  const id = Number(c.req.param('id'));
  if (!Number.isInteger(id) || id <= 0) return c.text('Ikke fundet', 404);
  const row = await c.env.DB.prepare('SELECT type, data FROM site_files WHERE id = ?').bind(id).first<{ type: string; data: ArrayBuffer | number[] }>();
  if (!row) return c.text('Ikke fundet', 404);
  const body = row.data instanceof ArrayBuffer ? new Uint8Array(row.data) : new Uint8Array(row.data);
  return c.body(body as any, 200, { 'Content-Type': row.type, 'Cache-Control': 'public, max-age=86400', 'Content-Security-Policy': "default-src 'none'; sandbox" });
});

site.get('/favicon.ico', (c) => c.redirect(`/assets/favicon-96.png?v=${THEME_VERSION}`, 301));

site.get('/robots.txt', (c) => {
  if (!isCanonicalHost(c)) return c.text('User-agent: *\nDisallow: /\n');
  return c.text(`User-agent: *\nDisallow: /cart\nDisallow: /contact\n\nSitemap: ${canonicalOrigin(c.env)}/sitemap.xml\n`, 200, { 'Cache-Control': 'public, max-age=3600' });
});

site.get('/sitemap.xml', async (c) => {
  const data = await loadSite(c.env.DB);
  const o = canonicalOrigin(c.env);
  const urls = ['/', ...data.pages.filter((p) => p.published).map((p) => `/pages/${p.handle}`), ...data.products.filter((p) => p.status === 'active').map((p) => `/products/${p.handle}`)];
  const xml = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls.map((u) => `  <url><loc>${o}${u}</loc></url>`).join('\n')}\n</urlset>\n`;
  return c.body(xml, 200, { 'Content-Type': 'application/xml; charset=utf-8', 'Cache-Control': 'public, max-age=3600' });
});

// Gamle Shopify-adresser
site.get('/collections/*', (c) => c.redirect('/pages/ydelser#abonnement', 301));
site.get('/collections', (c) => c.redirect('/pages/ydelser#abonnement', 301));
site.get('/policies/privacy-policy', (c) => c.redirect('/pages/privatlivspolitik', 301));
site.get('/policies/*', (c) => c.redirect('/pages/privatlivspolitik', 301));
site.get('/search', (c) => c.redirect('/', 302));
site.get('/account', (c) => c.redirect('https://kunde.veyro.dk/login', 302));
site.get('/account/*', (c) => c.redirect('https://kunde.veyro.dk/login', 302));
site.get('/admin', (c) => c.redirect('https://kunde.veyro.dk/admin', 302));
site.get('/admin/*', (c) => c.redirect('https://kunde.veyro.dk/admin', 302));
site.get('/healthz', (c) => c.text('ok'));

// ---------- Kurv (gemmes i en cookie; sendes som forespørgsel, der betales ikke her) ----------

const CART_COOKIE = 'veyro_cart';
const MAX_QTY = 10;
const MAX_LINES = 10;

function readCart(c: Context<SiteEnv>): CartLine[] {
  const raw = getCookie(c, CART_COOKIE) ?? '';
  const out: CartLine[] = [];
  for (const part of raw.split('.')) {
    const m = part.match(/^([a-z0-9-]{1,60})_(\d{1,2})$/);
    if (!m) continue;
    const q = Math.min(MAX_QTY, Number(m[2]));
    const handle = m[1]!;
    if (q > 0 && !out.some((l) => l.handle === handle)) out.push({ handle, quantity: q });
    if (out.length >= MAX_LINES) break;
  }
  return out;
}

function writeCart(c: Context<SiteEnv>, lines: CartLine[]) {
  const clean = lines.filter((l) => l.quantity > 0).slice(0, MAX_LINES);
  if (!clean.length) {
    deleteCookie(c, CART_COOKIE, { path: '/' });
    return;
  }
  setCookie(c, CART_COOKIE, clean.map((l) => `${l.handle}_${Math.min(MAX_QTY, l.quantity)}`).join('.'), {
    path: '/',
    httpOnly: true,
    sameSite: 'Lax',
    secure: new URL(c.req.url).protocol === 'https:',
    maxAge: 30 * 86400,
  });
}

const qty = (v: unknown, fallback: number) => {
  const n = Math.floor(Number(v));
  return Number.isFinite(n) ? Math.max(0, Math.min(MAX_QTY, n)) : fallback;
};

site.post('/cart/add', async (c) => {
  if (!sameOrigin(c)) return c.text('Ugyldig anmodning.', 403);
  const body = await c.req.parseBody();
  const handle = String(body['id'] ?? '');
  const data = await loadSite(c.env.DB);
  const product = data.products.find((p) => p.handle === handle && p.status === 'active');
  if (!product) return c.redirect('/cart', 303);
  const lines = readCart(c);
  const add = Math.max(1, qty(body['quantity'], 1));
  const line = lines.find((l) => l.handle === handle);
  if (line) line.quantity = Math.min(MAX_QTY, line.quantity + add);
  else lines.push({ handle, quantity: add });
  writeCart(c, lines);
  return c.redirect('/cart', 303);
});

async function updateCart(c: Context<SiteEnv>) {
  if (!sameOrigin(c)) return c.text('Ugyldig anmodning.', 403);
  const body = await c.req.parseBody({ all: true });
  const raw = body['updates[]'];
  const updates = Array.isArray(raw) ? raw : raw != null ? [raw] : [];
  const data = await loadSite(c.env.DB);
  // updates[] følger rækkefølgen af de linjer, der vises (kun aktive abonnementer)
  const shown = cartDrop(data, readCart(c)).items.map((i) => i.product.handle);
  const lines = readCart(c).filter((l) => shown.includes(l.handle));
  shown.forEach((h, i) => {
    const l = lines.find((x) => x.handle === h);
    if (l && updates[i] != null) l.quantity = qty(updates[i], l.quantity);
  });
  writeCart(c, lines);
  return c.redirect('/cart', 303);
}
site.post('/cart', updateCart);
site.post('/cart/update', updateCart);

site.get('/cart/change', async (c) => {
  const line = Number(c.req.query('line'));
  const q = qty(c.req.query('quantity'), 0);
  const data = await loadSite(c.env.DB);
  const shown = cartDrop(data, readCart(c)).items.map((i) => i.product.handle);
  const handle = shown[line - 1];
  if (handle) {
    const lines = readCart(c);
    const l = lines.find((x) => x.handle === handle);
    if (l) l.quantity = q;
    writeCart(c, lines);
  }
  return c.redirect('/cart', 303);
});

site.post('/cart/clear', (c) => {
  if (!sameOrigin(c)) return c.text('Ugyldig anmodning.', 403);
  writeCart(c, []);
  return c.redirect('/cart', 303);
});
site.post('/cart/clear.js', (c) => {
  if (!sameOrigin(c)) return c.json({ error: 'forbidden' }, 403);
  writeCart(c, []);
  return c.json({ item_count: 0, items: [] });
});

// ---------- Sider ----------

type Resolved = Pick<RenderRequest, 'type' | 'page' | 'product'>;

function resolvePath(data: SiteData, path: string): Resolved | null {
  if (path === '/' || path === '') return { type: 'index' };
  if (path === '/cart') return { type: 'cart' };
  let m = path.match(/^\/pages\/([a-z0-9-]+)\/?$/);
  if (m) {
    const page = data.pages.find((p) => p.handle === m![1] && p.published);
    return page ? { type: 'page', page } : null;
  }
  m = path.match(/^\/products\/([a-z0-9-]+)\/?$/);
  if (m) {
    const product = data.products.find((p) => p.handle === m![1] && p.status === 'active');
    return product ? { type: 'product', product } : null;
  }
  return null;
}

// Gengivne sider i hukommelsen (pr. isolate) og i D1 (på tværs af servere), pr. indholdsversion
const memCache = new Map<string, string>();

async function pageHtml(c: Context<SiteEnv>, data: SiteData, path: string, r: Resolved, forms: Record<string, FormState> | null): Promise<string> {
  const host = new URL(c.req.url).host;
  const req: RenderRequest = { ...r, path, host, canonicalOrigin: canonicalOrigin(c.env), cart: r.type === 'cart' ? readCart(c) : [], forms: forms ?? {} };
  const cacheable = !forms && r.type !== 'cart';
  if (!cacheable) return renderSitePage(data, req);
  const key = `${data.version}|${host}|${path}`;
  const mem = memCache.get(key);
  if (mem) return mem;
  const row = await c.env.DB.prepare('SELECT html FROM site_cache WHERE key = ?').bind(key).first<{ html: string }>();
  let html = row?.html;
  if (!html) {
    html = renderSitePage(data, req);
    c.executionCtx.waitUntil(
      c.env.DB.prepare('INSERT OR REPLACE INTO site_cache (key, html, created_at) VALUES (?, ?, ?)')
        .bind(key, html, Math.floor(Date.now() / 1000))
        .run()
        .catch(() => {}),
    );
  }
  if (memCache.size > 60) memCache.clear();
  memCache.set(key, html);
  return html;
}

/** Ting, der er forskellige for hver besøgende, sættes ind efter cachen */
function personalize(c: Context<SiteEnv>, data: SiteData, html: string): string {
  const count = cartDrop(data, readCart(c)).item_count;
  const badge = count > 0 ? `<span class="site-header__count" aria-label="${translate('cart.count', { count })}">${count}</span>` : '';
  const nonce = c.get('nonce');
  return html.replace('<!--cart-count-->', badge).replace(/<script(?=[\s>])/g, `<script nonce="${nonce}"`);
}

async function respond(c: Context<SiteEnv>, path: string, forms: Record<string, FormState> | null = null, status: 200 | 404 | 422 | 429 = 200) {
  const data = await loadSite(c.env.DB);
  let r = resolvePath(data, path);
  if (!r) {
    r = { type: '404' };
    status = 404;
  }
  const html = await pageHtml(c, data, r.type === '404' ? '/404' : path, r, forms);
  if (status === 200 && c.req.method === 'GET' && !/bot|crawl|spider|slurp|preview|monitor/i.test(c.req.header('User-Agent') ?? '')) {
    c.executionCtx.waitUntil(countView(c.env.DB, path).catch(() => {}));
  }
  return c.html(personalize(c, data, html), status);
}

/** ?kontakt=ok&form=<id> efter en vellykket formular viser takkebeskeden i den formular */
function formsFromQuery(c: Context<SiteEnv>): Record<string, FormState> | null {
  const id = c.req.query('form');
  if (c.req.query('kontakt') !== 'ok' || !id) return null;
  return { [id]: { 'posted_successfully?': true, errors: null } };
}

site.get('/', (c) => respond(c, '/', formsFromQuery(c)));
site.get('/pages/:handle', (c) => respond(c, new URL(c.req.url).pathname.replace(/\/$/, ''), formsFromQuery(c)));
site.get('/products/:handle', (c) => respond(c, new URL(c.req.url).pathname.replace(/\/$/, ''), formsFromQuery(c)));
site.get('/cart', (c) => respond(c, '/cart', formsFromQuery(c)));

// ---------- Formularer ----------

function formErrors(fields: Record<string, string>): FormState['errors'] {
  const keys = Object.keys(fields);
  return Object.assign(keys, { messages: fields, translated_fields: Object.fromEntries(keys.map((k) => [k, k === 'email' ? 'E-mail' : k])) });
}

site.post('/contact', async (c) => {
  if (!sameOrigin(c)) return c.text('Ugyldig anmodning.', 403);
  const body = await c.req.parseBody();
  const formId = String(body['form_id'] ?? '').slice(0, 80);
  let returnTo = String(body['return_to'] ?? '/');
  if (!returnTo.startsWith('/') || returnTo.startsWith('//')) returnTo = '/';
  const returnPath = returnTo.split(/[?#]/)[0] || '/';

  const fields: Record<string, string> = {};
  for (const [k, v] of Object.entries(body)) {
    const m = k.match(/^contact\[(.{1,60})\]$/);
    if (m && typeof v === 'string' && Object.keys(fields).length < 40) fields[m[1]!] = v.trim().slice(0, 5000);
  }
  // Honningkrukke: robotter udfylder det skjulte felt. Lad som om det lykkedes.
  const success = () => {
    const u = new URL(returnTo, 'http://x');
    u.searchParams.set('kontakt', 'ok');
    u.searchParams.set('form', formId);
    return c.redirect(`${u.pathname}${u.search}#${encodeURIComponent(formId)}`, 303);
  };
  if (String(body['website_url'] ?? '').trim()) return success();

  const state = (errors: Record<string, string>): Record<string, FormState> => ({
    [formId]: { 'posted_successfully?': false, errors: formErrors(errors), name: fields['name'] ?? '', email: fields['email'] ?? '', body: fields['body'] ?? '' },
  });

  const ip = c.req.header('CF-Connecting-IP') ?? 'ukendt';
  if (!(await rateLimit(c.env.DB, 'lead-ip:' + (await sha256Hex(ip)), 8, 3600))) {
    return respond(c, returnPath, state({ form: 'Du har sendt mange henvendelser på kort tid. Vent lidt, eller skriv direkte til kontakt@veyro.dk.' }), 429);
  }

  const email = normalizeEmail(fields['email']);
  const kind: LeadKind = formId === 'CartRequest' ? 'kurv' : formId.startsWith('Assessment') ? 'vurdering' : 'kontakt';
  const errors: Record<string, string> = {};
  if (!email) errors.email = 'er ugyldig';
  if (!fields['Samtykke']) errors.form = 'Sæt kryds for at give samtykke til, at vi må bruge oplysningerne til at svare dig.';

  let cart: LeadCartLine[] | null = null;
  if (kind === 'kurv') {
    const data = await loadSite(c.env.DB);
    const drop = cartDrop(data, readCart(c));
    cart = drop.items.map((i) => {
      const p = data.products.find((x) => x.handle === i.product.handle)!;
      return { handle: p.handle, title: p.title, quantity: i.quantity, price: p.price, interval: p.interval };
    });
    if (!cart.length) errors.form = 'Kurven er tom. Læg et abonnement i kurven, eller brug kontaktformularen.';
  }
  if (Object.keys(errors).length) return respond(c, returnPath, state(errors), 422);

  const id = await createLead(c.env.DB, {
    kind,
    form_name: fields['Formular'] ?? null,
    name: fields['name'] || null,
    email: email!,
    phone: fields['Telefon'] || null,
    company: fields['Virksomhed'] || null,
    website: fields['Hjemmeside'] || null,
    service: fields['Ydelse'] || null,
    message: fields['body'] || null,
    fields,
    cart,
    page: returnPath,
  });
  if (kind === 'kurv') writeCart(c, []);

  // Besked til Veyro. Fejler e-mailen, ligger forespørgslen stadig i admin.
  if (c.env.NOTIFY_EMAIL) {
    const lines = [
      `${LEAD_KIND_LABEL[kind]} fra veyro.dk${fields['Formular'] ? ` (${fields['Formular']})` : ''}.`,
      `Navn: ${fields['name'] || '–'}`,
      `E-mail: ${email}`,
      ...(fields['Telefon'] ? [`Telefon: ${fields['Telefon']}`] : []),
      ...(fields['Virksomhed'] ? [`Virksomhed: ${fields['Virksomhed']}`] : []),
      ...(fields['Hjemmeside'] ? [`Hjemmeside: ${fields['Hjemmeside']}`] : []),
      ...(fields['Ydelse'] ? [`Ydelse: ${fields['Ydelse']}`] : []),
      ...(cart ?? []).map((l) => `Kurv: ${l.quantity} × ${l.title} – ${formatKr(l.price * l.quantity)} ${l.interval === 'year' ? 'pr. år' : 'pr. md.'}`),
      ...(fields['body'] ? [`Besked: ${fields['body']}`] : []),
    ];
    const link = `${c.env.APP_URL.replace(/\/+$/, '')}/admin/forespoergsler/${id}`;
    c.executionCtx.waitUntil(
      sendEmail(c.env, { to: c.env.NOTIFY_EMAIL, replyTo: email!, ...adminNoticeEmail(`Ny forespørgsel: ${fields['name'] || email}`, lines, link) })
        .then((sent) => (sent ? markLeadNotified(c.env.DB, id) : undefined))
        .catch((err) => logError(c.env.DB, 'Forespørgsel-mail', err)),
    );
  }
  return success();
});

site.notFound((c) => respond(c, new URL(c.req.url).pathname, null, 404));

site.onError((err, c) => {
  console.error('Fejl på hjemmesiden:', err.message);
  c.executionCtx.waitUntil(logError(c.env.DB, 'Hjemmeside', err));
  return c.html(
    '<!doctype html><html lang="da"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Fejl – Veyro</title><body style="font-family:system-ui,sans-serif;max-width:36rem;margin:4rem auto;padding:0 1rem"><h1>Der opstod en fejl</h1><p>Prøv igen om lidt. Fortsætter problemet, så skriv til <a href="mailto:kontakt@veyro.dk">kontakt@veyro.dk</a>.</p></body></html>',
    500,
  );
});

export default site;
