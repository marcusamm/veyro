// Offentlige adresser for kundehjemmesider:
//   <kundens domæne>/…            den publicerede version (domænet skal være knyttet i admin)
//   kunde.veyro.dk/s/<adresse>/…  den publicerede version (fast adresse uden domæne, skjult for søgemaskiner)
//   kunde.veyro.dk/vis/<token>/…  forhåndsvisning af kladden (tidsbegrænset link, kan tilbagekaldes)
//   kunde.veyro.dk/api/kundeside/<offentlig nøgle>/…  formular og offentlig konfiguration til tilsluttede sider
// Kun offentlige oplysninger forlader serveren. Formularer i forhåndsvisningen gemmes som test og sendes ikke videre.
import { Hono, type Context } from 'hono';
import type { Env } from '../env';
import { sha256Hex } from '../lib/crypto';
import { normalizeEmail, rateLimit } from '../lib/db';
import { escapeHtml, sendEmail } from '../lib/email';
import { logError } from '../lib/errlog';
import { INTER_TIGHT_WOFF2 } from '../views/brand';
import { projectIdForHost, veyroHost } from './domaener';
import { findPage, RenderError, renderPage, type RenderCtx, type WebsiteConfig } from './hjemmeside';
import { draftOf, fileIds, getFile, getProjectByKey, getProjectBySlug, getServices, getVersion, listDomains, resolvePreview, serviceConfig, versionConfig, type Project } from './model';
import { publicServicesFrom } from './publicering';

type KEnv = { Bindings: Env };
type Mode = 'live' | 'preview';

interface Target {
  project: Project;
  cfg: WebsiteConfig;
  mode: Mode;
  base: string;
  versionNumber: number | null;
}

async function liveTarget(env: Env, project: Project, base: string): Promise<Target | null> {
  if (project.kind !== 'skabelon' || !project.live_version_id) return null;
  const v = await getVersion(env.DB, project.id, project.live_version_id);
  if (!v) return null;
  return { project, cfg: versionConfig(v), mode: 'live', base, versionNumber: v.number };
}

async function canonicalFor(env: Env, project: Project): Promise<string | null> {
  const domains = await listDomains(env.DB, project.id);
  const d = domains.find((x) => x.kind === 'eget' && x.status === 'aktiv') ?? domains.find((x) => x.kind === 'veyro' && x.status === 'aktiv');
  return d ? `https://${d.hostname}` : null;
}

const unavailable = (c: Context<KEnv>, msg = 'Siden er midlertidigt utilgængelig.') =>
  c.html(`<!doctype html><html lang="da"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>Utilgængelig</title><body style="font-family:system-ui,sans-serif;max-width:36rem;margin:4rem auto;padding:0 1rem"><h1>${escapeHtml(msg)}</h1></body></html>`, 503);

const notFound = (c: Context<KEnv>) =>
  c.html('<!doctype html><html lang="da"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>Siden findes ikke</title><body style="font-family:system-ui,sans-serif;max-width:36rem;margin:4rem auto;padding:0 1rem"><h1>Siden findes ikke</h1></body></html>', 404);

async function renderTarget(c: Context<KEnv>, t: Target, sub: string, extra: Partial<RenderCtx> = {}) {
  if (t.project.offline && t.mode === 'live') return unavailable(c);
  const page = findPage(t.cfg, sub);
  if (!page) return notFound(c);
  const services = publicServicesFrom(await getServices(c.env.DB, t.project.id));
  const isOwnHost = t.base === '';
  const canonical = t.mode === 'live' ? await canonicalFor(c.env, t.project) : null;
  try {
    const html = renderPage(t.cfg, page, {
      base: t.base,
      mode: t.mode,
      services,
      canonical,
      files: await fileIds(c.env.DB, t.project.id),
      sent: c.req.query('sendt') === '1',
      formError: c.req.query('fejl') ? 'Henvendelsen blev ikke sendt. Udfyld navn, e-mail og besked, og sæt kryds i samtykke.' : null,
      // Kun kundens eget, verificerede domæne må indekseres
      noindex: t.mode === 'preview' || !isOwnHost,
      ...extra,
    });
    const res = c.html(html, 200);
    res.headers.set('X-Veyro-Project', t.project.id);
    if (t.versionNumber) res.headers.set('X-Veyro-Version', String(t.versionNumber));
    if (t.mode === 'preview' || !isOwnHost) res.headers.set('X-Robots-Tag', 'noindex, nofollow');
    return res;
  } catch (err) {
    if (err instanceof RenderError) {
      await logError(c.env.DB, `Kundeside ${t.project.id}`, err);
      return unavailable(c, t.mode === 'preview' ? `Forhåndsvisningen kan ikke vises: ${err.message}` : 'Siden er midlertidigt utilgængelig.');
    }
    throw err;
  }
}

/** Formular fra en kundehjemmeside: gemmes på projektet og sendes til kundens modtagere (aldrig fra forhåndsvisning) */
async function storeLead(env: Env, ctx: { waitUntil(p: Promise<unknown>): void }, project: Project, mode: Mode, f: Record<string, string>, ip: string, origin: string): Promise<'ok' | 'invalid' | 'limited' | 'off'> {
  const services = await getServices(env.DB, project.id);
  const contact = services.get('kontaktformular');
  const recipients: string[] = serviceConfig(contact).recipients ?? [];
  if (!contact?.enabled || !recipients.length) return 'off';
  if ((f.website_url ?? '').trim()) return 'ok'; // honningkrukke: robotter får et "ok"
  if (!(await rateLimit(env.DB, `kundeside-lead:${project.id}:${await sha256Hex(ip)}`, 8, 3600))) return 'limited';
  const email = normalizeEmail(f.email);
  const name = (f.name ?? '').trim().slice(0, 120);
  const message = (f.message ?? '').trim().slice(0, 5000);
  if (!email || !name || !message || f.samtykke !== '1') return 'invalid';
  const phone = (f.phone ?? '').trim().slice(0, 40) || null;
  const test = mode === 'preview' ? 1 : 0;
  const { meta } = await env.DB
    .prepare('INSERT INTO project_leads (project_id, name, email, phone, message, page, test, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .bind(project.id, name, email, phone, message, (f.side ?? '').slice(0, 120), test, Math.floor(Date.now() / 1000))
    .run();
  if (!test) {
    const id = Number(meta.last_row_id);
    const subject = String(serviceConfig(contact).subject || `Ny henvendelse fra ${origin}`);
    const lines = [`Navn: ${name}`, `E-mail: ${email}`, ...(phone ? [`Telefon: ${phone}`] : []), '', message, '', `Sendt fra ${origin}${f.side ? `/${f.side}` : ''}`];
    ctx.waitUntil(
      (async () => {
        let sent = false;
        for (const to of recipients) {
          sent = (await sendEmail(env, { to, replyTo: email, subject, text: lines.join('\n'), html: `<div style="font-family:system-ui,sans-serif;font-size:15px;line-height:1.5">${lines.map((l) => (l ? `<p style="margin:0 0 8px">${escapeHtml(l)}</p>` : '')).join('')}</div>` })) || sent;
        }
        if (sent) await env.DB.prepare('UPDATE project_leads SET notified_at = ? WHERE id = ?').bind(Math.floor(Date.now() / 1000), id).run();
      })().catch((err) => logError(env.DB, 'Kundeside-henvendelse', err)),
    );
  }
  return 'ok';
}

function sameOrigin(c: Context<KEnv>): boolean {
  const self = new URL(c.req.url).origin;
  const origin = c.req.header('Origin');
  if (origin) return origin === self;
  return c.req.header('Sec-Fetch-Site') !== 'cross-site';
}

async function contactPost(c: Context<KEnv>, t: Target) {
  if (!sameOrigin(c)) return c.text('Ugyldig anmodning.', 403);
  const body = await c.req.parseBody();
  const f = Object.fromEntries(Object.entries(body).map(([k, v]) => [k, typeof v === 'string' ? v : '']));
  const side = /^[a-z0-9-]{0,60}$/.test(f.side ?? '') ? f.side! : '';
  const back = `${t.base}/${side}`;
  const r = await storeLead(c.env, c.executionCtx, t.project, t.mode, f, c.req.header('CF-Connecting-IP') ?? 'ukendt', new URL(c.req.url).host);
  if (r === 'limited') return c.text('Du har sendt mange henvendelser på kort tid. Prøv igen senere.', 429);
  if (r === 'off') return c.redirect(`${back}?fejl=1#kontakt`, 303);
  return c.redirect(`${back}?${r === 'ok' ? 'sendt=1' : 'fejl=1'}#kontakt`, 303);
}

async function file(c: Context<KEnv>, project: Project) {
  const id = Number(c.req.param('id'));
  if (!Number.isInteger(id) || id <= 0) return notFound(c);
  const row = await getFile(c.env.DB, project.id, id);
  if (!row) return notFound(c);
  return c.body(new Uint8Array(row.data) as any, 200, { 'Content-Type': row.type, 'Cache-Control': 'public, max-age=86400', 'Content-Security-Policy': "default-src 'none'; sandbox" });
}

const font = (c: Context<KEnv>) => c.body(INTER_TIGHT_WOFF2 as any, 200, { 'Content-Type': 'font/woff2', 'Cache-Control': 'public, max-age=31536000, immutable' });

// ---------- På kunde.veyro.dk (monteres før session og CSRF) ----------

export const kundesider = new Hono<KEnv>();

kundesider.get('/_veyro/inter-tight.woff2', font);

const sub = (c: Context<KEnv>, prefix: string) => decodeURIComponent(new URL(c.req.url).pathname.slice(prefix.length)).replace(/^\/+|\/+$/g, '');

// Fast adresse for den publicerede version
async function bySlug(c: Context<KEnv>): Promise<Target | Response> {
  const p = await getProjectBySlug(c.env.DB, c.req.param('slug')!);
  if (p?.kind === 'tilsluttet' && p.live_version_id && p.external_url) return c.redirect(p.external_url, 302);
  const t = p ? await liveTarget(c.env, p, `/s/${p.slug}`) : null;
  return t ?? notFound(c);
}
kundesider.post('/s/:slug/_kontakt', async (c) => {
  const t = await bySlug(c);
  return t instanceof Response ? t : contactPost(c, t);
});
kundesider.get('/s/:slug/_filer/:id', async (c) => {
  const p = await getProjectBySlug(c.env.DB, c.req.param('slug'));
  return p?.live_version_id ? file(c, p) : notFound(c);
});
kundesider.get('/s/:slug/*', async (c) => {
  const t = await bySlug(c);
  return t instanceof Response ? t : renderTarget(c, t, sub(c, `/s/${t.project.slug}`));
});
kundesider.get('/s/:slug', (c) => c.redirect(`/s/${c.req.param('slug')}/`, 301));

// Forhåndsvisning af kladden
async function byToken(c: Context<KEnv>): Promise<Target | Response> {
  const p = await resolvePreview(c.env.DB, c.req.param('token')!);
  if (!p || p.kind !== 'skabelon') return c.html('<!doctype html><meta charset="utf-8"><meta name="robots" content="noindex"><title>Linket er udløbet</title><body style="font-family:system-ui,sans-serif;max-width:36rem;margin:4rem auto;padding:0 1rem"><h1>Linket virker ikke længere</h1><p>Forhåndsvisningen er udløbet eller tilbagekaldt. Bed om et nyt link.</p></body>', 404);
  return { project: p, cfg: draftOf(p), mode: 'preview', base: `/vis/${c.req.param('token')}`, versionNumber: null };
}
kundesider.post('/vis/:token/_kontakt', async (c) => {
  const t = await byToken(c);
  return t instanceof Response ? t : contactPost(c, t);
});
kundesider.get('/vis/:token/_filer/:id', async (c) => {
  const t = await byToken(c);
  return t instanceof Response ? t : file(c, t.project);
});
kundesider.get('/vis/:token/*', async (c) => {
  const t = await byToken(c);
  return t instanceof Response ? t : renderTarget(c, t, sub(c, t.base));
});
kundesider.get('/vis/:token', (c) => c.redirect(`/vis/${c.req.param('token')}/`, 301));

// ---------- Integration for tilsluttede (specialbyggede) hjemmesider ----------

/** De adresser, en tilsluttet side må sende formularer fra */
async function allowedOrigins(env: Env, p: Project): Promise<Set<string>> {
  const out = new Set<string>();
  if (p.external_url) {
    try {
      out.add(new URL(p.external_url).origin);
    } catch {
      /* ugyldig adresse */
    }
  }
  for (const d of await listDomains(env.DB, p.id)) if (d.status === 'aktiv') out.add(`https://${d.hostname}`);
  return out;
}

// Offentlig konfiguration: kun det, siden har brug for at vise og forbinde til. Ingen nøgler, ingen interne data.
kundesider.get('/api/kundeside/:key/config.json', async (c) => {
  const p = await getProjectByKey(c.env.DB, c.req.param('key'));
  if (!p) return c.json({ error: 'ukendt' }, 404);
  const services = await getServices(c.env.DB, p.id);
  const svc = publicServicesFrom(services);
  const live = p.live_version_id ? await getVersion(c.env.DB, p.id, p.live_version_id) : null;
  const info = live ? versionConfig(live).info : null;
  const app = (c.env.APP_URL || new URL(c.req.url).origin).replace(/\/+$/, '');
  return c.json(
    {
      projekt: p.id,
      navn: info?.name ?? null,
      kontakt: info ? { telefon: info.phone || null, email: info.email || null, adresse: info.address || null, aabningstider: info.opening_hours || null } : null,
      formular: svc.contact ? `${app}/api/kundeside/${p.public_key}/formular` : null,
      bestilling: svc.orderUrl,
    },
    200,
    { 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'public, max-age=60' },
  );
});

// Formular fra en tilsluttet side: en almindelig HTML-formular (virker uden JavaScript). Afsenderens adresse skal
// høre til projektet; nøglen alene giver kun lov til at aflevere en henvendelse til netop dette projekt.
kundesider.post('/api/kundeside/:key/formular', async (c) => {
  const p = await getProjectByKey(c.env.DB, c.req.param('key'));
  if (!p) return c.text('Ukendt formular.', 404);
  const allowed = await allowedOrigins(c.env, p);
  const origin = c.req.header('Origin') ?? '';
  if (!allowed.has(origin)) return c.text('Formularen må kun sendes fra kundens egen hjemmeside.', 403);
  const ct = c.req.header('Content-Type') ?? '';
  if (!ct.startsWith('application/x-www-form-urlencoded') && !ct.startsWith('multipart/form-data')) return c.text('Ugyldig anmodning.', 415);
  const body = await c.req.parseBody();
  const f = Object.fromEntries(Object.entries(body).map(([k, v]) => [k, typeof v === 'string' ? v : '']));
  const r = await storeLead(c.env, c.executionCtx, p, 'live', f, c.req.header('CF-Connecting-IP') ?? 'ukendt', new URL(origin).host);
  let back = `${origin}/`;
  try {
    const u = new URL(f.return_to || '/', origin);
    if (u.origin === origin) back = u.toString();
  } catch {
    /* behold standard */
  }
  if (r === 'limited') return c.text('Du har sendt mange henvendelser på kort tid. Prøv igen senere.', 429);
  const u = new URL(back);
  u.searchParams.set(r === 'ok' ? 'sendt' : 'fejl', '1');
  return c.redirect(u.toString(), 303);
});

// ---------- På kundens eget domæne ----------

export const kundeDomaeneApp = new Hono<KEnv & { Variables: { project: Project } }>();

kundeDomaeneApp.use('*', async (c, next) => {
  await next();
  const h = c.res.headers;
  if (!h.has('Content-Security-Policy')) {
    h.set('Content-Security-Policy', "default-src 'self'; script-src 'none'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'; object-src 'none'");
  }
  h.set('X-Content-Type-Options', 'nosniff');
  h.set('Referrer-Policy', 'strict-origin-when-cross-origin');
  h.set('Strict-Transport-Security', 'max-age=31536000');
  if (!h.has('Cache-Control')) h.set('Cache-Control', 'no-store');
});

kundeDomaeneApp.use('*', async (c, next) => {
  const host = new URL(c.req.url).hostname.toLowerCase();
  const id = await projectIdForHost(c.env, c.env.DB, host);
  const p = id ? await c.env.DB.prepare('SELECT * FROM projects WHERE id = ?').bind(id).first<Project>() : null;
  if (!p) return notFound(c as any);
  c.set('project', p);
  await next();
});

kundeDomaeneApp.get('/_veyro/status', (c) => c.json({ project: c.get('project').id, live: !!c.get('project').live_version_id }));
kundeDomaeneApp.get('/_veyro/inter-tight.woff2', font as any);
kundeDomaeneApp.get('/robots.txt', (c) => c.text(`User-agent: *\nAllow: /\n\nSitemap: https://${new URL(c.req.url).host}/sitemap.xml\n`));
kundeDomaeneApp.get('/sitemap.xml', async (c) => {
  const t = await liveTarget(c.env, c.get('project'), '');
  if (!t) return notFound(c as any);
  const host = `https://${new URL(c.req.url).host}`;
  return c.body(`<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${t.cfg.pages.map((p) => `  <url><loc>${host}/${p.handle}</loc></url>`).join('\n')}\n</urlset>\n`, 200, { 'Content-Type': 'application/xml; charset=utf-8' });
});
kundeDomaeneApp.get('/_filer/:id', (c) => (c.get('project').live_version_id ? file(c as any, c.get('project')) : notFound(c as any)));
kundeDomaeneApp.post('/_kontakt', async (c) => {
  const t = await liveTarget(c.env, c.get('project'), '');
  return t ? contactPost(c as any, t) : notFound(c as any);
});
kundeDomaeneApp.get('*', async (c) => {
  const t = await liveTarget(c.env, c.get('project'), '');
  if (!t) return unavailable(c as any, 'Hjemmesiden er ikke publiceret endnu.');
  return renderTarget(c as any, t, decodeURIComponent(new URL(c.req.url).pathname).replace(/^\/+|\/+$/g, ''));
});
kundeDomaeneApp.onError(async (err, c) => {
  await logError(c.env.DB, 'Kundedomæne', err);
  return unavailable(c as any);
});

/** Hører værtsnavnet til en kundehjemmeside? (ikke kundepanelets eller salgssidens egne domæner) */
export async function isCustomerHost(req: Request, env: Env): Promise<boolean> {
  const host = new URL(req.url).hostname.toLowerCase();
  if (host === 'localhost' || host === '127.0.0.1') return false;
  try {
    if (env.APP_URL && new URL(env.APP_URL).hostname === host) return false;
  } catch {
    /* ugyldig APP_URL */
  }
  if (host.endsWith('.workers.dev')) return false;
  try {
    return !!(await projectIdForHost(env, env.DB, host));
  } catch (err) {
    // Fx før migrationen er kørt: kundepanelet skal stadig svare
    console.error('Opslag af kundedomæne fejlede:', (err as Error).message);
    return false;
  }
}

/** Kontrol af den publicerede version ved publicering: hentes gennem samme kode som besøgende rammer */
export async function verifyLive(env: Env, p: Project): Promise<{ ok: boolean; detail: string }> {
  if (p.kind === 'tilsluttet') return { ok: true, detail: 'Tilsluttet side: kontrolleret i tjekket før publicering.' };
  const url = `${(env.APP_URL || 'https://kunde.veyro.dk').replace(/\/+$/, '')}/s/${p.slug}/`;
  const ctx = { waitUntil() {}, passThroughOnException() {}, props: {} } as unknown as ExecutionContext;
  const res = await kundesider.fetch(new Request(url), env, ctx);
  const html = await res.text();
  const v = await getVersion(env.DB, p.id, p.live_version_id);
  if (res.status !== 200) return { ok: false, detail: `${url} svarede HTTP ${res.status}` };
  if (res.headers.get('X-Veyro-Version') !== String(v?.number)) return { ok: false, detail: `${url} viser ikke version ${v?.number}` };
  if (!html.includes('</html>')) return { ok: false, detail: `${url} gav en ufuldstændig side` };
  return { ok: true, detail: `${url} svarer med version ${v?.number}.` };
}

export { veyroHost };
