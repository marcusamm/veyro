import { Hono, type Context } from 'hono';
import type { AppEnv } from '../env';
import { nowSec, sha256Hex } from '../lib/crypto';
import { getCustomerByEmail, normalizeEmail, rateLimit, upsertCustomer } from '../lib/db';
import { escapeHtml as e, sendEmail } from '../lib/email';
import { validateLogisticsInput, LogisticsValidationError, MAX_SAVED_INPUT_BYTES } from '../lib/logistics-input.mjs';
import { archiveLogisticsCalculation, copyStoredLogisticsCalculation, createLogisticsCalculation,
  getLogisticsCalculation, listLogisticsCalculations, saveLogisticsCalculation, type LogisticsToolId } from '../lib/logistics-store';
import { consumeLoginToken, createLoginToken, createSession, destroySession } from '../lib/session';

type C = Context<AppEnv>;
type Form = Record<string, unknown>;
const logistics = new Hono<AppEnv>();
const DESTINATION = '/logistik/mine/';
const text = (v: unknown) => typeof v === 'string' ? v : '';
const nameValue = (v: unknown) => text(v).trim().replace(/\s+/g, ' ');
const validName = (v: string, max = 120) => v.length > 0 && v.length <= max && !/[\u0000-\u001f\u007f]/.test(v);
const toolId = (v: unknown): v is LogisticsToolId => v === 'tco' || v === 'eoq' || v === 'genbestilling' || v === 'abc' || v === 'ladmeter' || v === 'luftfragt' || v === 'palletransport' || v === 'containertransport' || v === 'biltransport';
const validId = (v: string) => /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(v);
const versionValue = (v: unknown) => /^[1-9]\d{0,9}$/.test(text(v)) && Number(v) <= 2147483647 ? Number(v) : null;
const failure = (c: C, code: string, error: string, status: 400 | 401 | 404 | 409 | 413 | 429 | 503, path?: string) =>
  c.json({ error, code, ...(path ? { path } : {}) }, status);
const missing = (c: C) => failure(c, 'not_found', 'Beregningen findes ikke på din konto.', 404);
const conflict = (c: C) => failure(c, 'conflict', 'Beregningen er ændret eller arkiveret siden sidst. Genindlæs den gemte version, eller gem dine indtastninger som en ny kopi.', 409);
const quota = (c: C) => failure(c, 'quota', 'Du kan gemme op til 50 aktive beregninger og 200 i alt, inklusive arkiverede. Arkivér en aktiv beregning, hvis du har nået grænsen på 50.', 409);
const limited = (c: C) => { c.header('Retry-After', '60'); return failure(c, 'rate_limited', 'Der er gemt mange ændringer. Vent et minut, og prøv igen. Dine indtastninger er stadig i siden.', 429); };

function inputValue(body: Form, id: LogisticsToolId) {
  const raw = text(body.input);
  if (!raw || new TextEncoder().encode(raw).length > MAX_SAVED_INPUT_BYTES) {
    throw new LogisticsValidationError('input_size', '', 'Beregningen er tom eller fylder for meget. Brug højst 200 ABC-varer.');
  }
  let input: unknown;
  try { input = JSON.parse(raw); } catch { throw new LogisticsValidationError('invalid_json', '', 'Beregningen kunne ikke læses. Prøv at gemme igen.'); }
  return validateLogisticsInput(id, input);
}
async function writeAllowed(c: C) {
  return rateLimit(c.env.DB, `logistics:write:${await sha256Hex(c.get('session')!.email)}`, 60, 60);
}
async function owner(c: C) {
  const session = c.get('session');
  return session ? getCustomerByEmail(c.env.DB, session.email) : null;
}
async function owned(c: C) {
  const customer = await owner(c);
  const id = c.req.param('id') ?? '';
  const calculation = customer && validId(id) ? await getLogisticsCalculation(c.env.DB, customer.id, id) : null;
  return { customer, calculation };
}

// Public calculator HTML/assets are served before session middleware by index.ts.
// Every route here is an account/auth response and must never enter a shared cache.
logistics.use('*', async (c, next) => {
  c.header('Cache-Control', 'private, no-store');
  c.header('X-Robots-Tag', 'noindex, nofollow');
  if (c.req.path.startsWith('/logistik/api/calculations') && !c.get('session')) {
    return failure(c, 'sign_in_required', 'Log ind med din Veyro-konto for at gemme og åbne beregninger.', 401);
  }
  await next();
});

logistics.get('/api/session', (c) => c.json({ authenticated: !!c.get('session'), email: c.get('session')?.email ?? null, csrf: c.get('csrf') }));
logistics.get('/api/calculations', async (c) => {
  const customer = await owner(c);
  return c.json({ calculations: customer ? await listLogisticsCalculations(c.env.DB, customer.id, c.req.query('archived') === '1') : [] });
});
logistics.get('/api/calculations/:id', async (c) => {
  const { calculation } = await owned(c);
  return calculation ? c.json({ calculation }) : missing(c);
});
logistics.post('/api/calculations', async (c) => {
  const body = await c.req.parseBody();
  const name = nameValue(body.name);
  if (!validName(name)) return failure(c, 'invalid_name', 'Giv beregningen et navn på højst 120 tegn.', 400);
  if (!toolId(body.toolId)) return failure(c, 'invalid_tool', 'Vælg et af de understøttede værktøjer.', 400);
  const input = inputValue(body, body.toolId);
  if (!await writeAllowed(c)) return limited(c);
  // An existing admin/staff session is already verified too; its first explicit save
  // can create a free customer identity without changing roles, subscriptions or billing.
  const customer = await owner(c) ?? await upsertCustomer(c.env.DB, { email: c.get('session')!.email });
  const calculation = await createLogisticsCalculation(c.env.DB, customer.id, { name, toolId: body.toolId, input });
  return calculation ? c.json({ calculation }, 201) : quota(c);
});
logistics.post('/api/calculations/:id', async (c) => {
  const { customer, calculation: current } = await owned(c);
  if (!customer || !current) return missing(c);
  const body = await c.req.parseBody();
  const name = nameValue(body.name), version = versionValue(body.version);
  if (!validName(name)) return failure(c, 'invalid_name', 'Giv beregningen et navn på højst 120 tegn.', 400);
  if (!version) return failure(c, 'invalid_version', 'Den gemte version mangler. Åbn beregningen igen.', 400);
  if (body.toolId !== undefined && body.toolId !== current.toolId) return failure(c, 'invalid_tool', 'Beregningens værktøj kan ikke ændres.', 400);
  const input = inputValue(body, current.toolId);
  if (!await writeAllowed(c)) return limited(c);
  const calculation = await saveLogisticsCalculation(c.env.DB, customer.id, current.id, version, { name, input });
  return calculation ? c.json({ calculation }) : conflict(c);
});
logistics.post('/api/calculations/:id/copy', async (c) => {
  const { customer, calculation: current } = await owned(c);
  if (!customer || !current) return missing(c);
  const body = await c.req.parseBody();
  const name = body.name === undefined ? `${current.name.slice(0, 112)} (kopi)` : nameValue(body.name);
  const version = versionValue(body.version);
  if (!validName(name)) return failure(c, 'invalid_name', 'Giv kopien et navn på højst 120 tegn.', 400);
  if (!version) return failure(c, 'invalid_version', 'Den gemte version mangler. Åbn beregningen igen.', 400);
  if (body.toolId !== undefined && body.toolId !== current.toolId) return failure(c, 'invalid_tool', 'Beregningens værktøj kan ikke ændres.', 400);
  // An explicit editor draft may rescue a version conflict. A dashboard copy must
  // instead copy exactly the stored version the user selected, atomically.
  const input = body.input === undefined ? null : inputValue(body, current.toolId);
  if (!input && version !== current.version) return conflict(c);
  if (!await writeAllowed(c)) return limited(c);
  const calculation = input
    ? await createLogisticsCalculation(c.env.DB, customer.id, { name, toolId: current.toolId, input })
    : await copyStoredLogisticsCalculation(c.env.DB, customer.id, current.id, version, name);
  if (calculation) return c.json({ calculation }, 201);
  if (!input) {
    const latest = await getLogisticsCalculation(c.env.DB, customer.id, current.id);
    if (!latest || latest.version !== version) return conflict(c);
  }
  return quota(c);
});
for (const action of ['archive', 'restore'] as const) {
  logistics.post(`/api/calculations/:id/${action}`, async (c) => {
    const { customer, calculation: current } = await owned(c);
    if (!customer || !current) return missing(c);
    const body = await c.req.parseBody(), version = versionValue(body.version);
    if (!version) return failure(c, 'invalid_version', 'Den gemte version mangler. Åbn beregningen igen.', 400);
    if (!await writeAllowed(c)) return limited(c);
    const calculation = await archiveLogisticsCalculation(c.env.DB, customer.id, current.id, version, action === 'restore');
    if (calculation) return c.json({ calculation });
    if (action === 'restore' && current.version === version && current.archivedAt) {
      const latest = await getLogisticsCalculation(c.env.DB, customer.id, current.id);
      if (latest?.version === version) return quota(c);
    }
    return conflict(c);
  });
}

function authPage(c: C, state: { error?: string; name?: string; email?: string; sent?: boolean; token?: string; devLink?: string } = {}, status: 200 | 400 | 429 | 503 = 200) {
  const title = state.sent ? 'Tjek din indbakke' : state.token ? 'Bekræft dit login' : 'Gem med din Veyro-konto';
  const content = state.sent
    ? `<p>Vi har sendt et link til din e-mail. Det gælder i 15 minutter. Åbn linket, og bekræft dit login for at fortsætte.</p><p>Åbner linket i en ny fane, kan du vende tilbage hertil efter login. Dine eventuelle midlertidige tal findes i den oprindelige fane.</p>${state.devLink ? `<p><a href="${e(state.devLink)}">Åbn lokalt testlink</a></p>` : ''}<a href="/logistik/login">Send et nyt link</a>`
    : state.token
      ? `<p>Bekræft, at du vil logge ind på Logistikværktøjer med din Veyro-konto.</p><form method="post" action="/logistik/verify"><input type="hidden" name="_csrf" value="${e(c.get('csrf'))}"><input type="hidden" name="token" value="${e(state.token)}"><button class="button" type="submit">Bekræft login</button></form>`
      : `<p>Brug den samme e-mail som til Veyro. Har du ingen konto, opretter vi en gratis, når du bekræfter din e-mail.</p><form method="post" action="/logistik/login"><input type="hidden" name="_csrf" value="${e(c.get('csrf'))}"><label>Dit navn<input name="name" autocomplete="name" maxlength="100" required value="${e(state.name ?? '')}"></label><label>E-mail<input name="email" type="email" autocomplete="email" maxlength="254" required value="${e(state.email ?? '')}"></label><button class="button" type="submit">Send login-link</button></form><p class="fine">Ingen adgangskode eller betalingskort. Op til 50 aktive og 200 gemte beregninger i alt. Du kan altid bruge beregnerne uden at logge ind.</p>`;
  return c.html(`<!doctype html><html lang="da"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow"><title>${title} · Logistikværktøjer</title><link rel="stylesheet" href="/logistik/assets/styles.css">${state.sent ? '<script type="module" src="/logistik/assets/login.mjs"></script>' : ''}<style>body{margin:0;background:#f5f3ed;color:#163d3b;font-family:system-ui,sans-serif}.login-wrap{max-width:36rem;margin:6vh auto;padding:2rem}.login-wrap h1{font-size:clamp(2rem,6vw,3rem);line-height:1.1;margin:2rem 0 1rem}.login-wrap p{line-height:1.65}.login-wrap form{display:grid;gap:1.25rem;margin:2rem 0}.login-wrap label{display:grid;gap:.5rem}.login-wrap input{font:inherit;width:100%;box-sizing:border-box;border:1px solid #9faeaa;padding:.85rem;background:white;border-radius:.5rem}.login-wrap button{font:inherit;background:#163d3b;color:white;border:0;border-radius:.6rem;padding:1rem;cursor:pointer}.login-wrap .error{background:#ffe8df;color:#77260d;padding:1rem;border-radius:.6rem}.fine{font-size:.9rem}</style></head><body><main class="login-wrap"><a href="/logistik/">← Logistikværktøjer</a><h1>${title}</h1>${state.error ? `<p class="error" role="alert">${e(state.error)}</p>` : ''}${content}<p><a href="/logistik/">Fortsæt uden login</a></p></main></body></html>`, status);
}
logistics.get('/login', (c) => c.get('session') ? c.redirect(DESTINATION, 303) : authPage(c));
logistics.post('/login', async (c) => {
  if (c.get('session')) return c.redirect(DESTINATION, 303);
  const body = await c.req.parseBody(), name = nameValue(body.name), email = normalizeEmail(body.email);
  const again = (error: string, status: 400 | 429 | 503) => authPage(c, { error, name, email: text(body.email).slice(0, 254) }, status);
  if (!validName(name, 100)) return again('Skriv dit navn med højst 100 tegn.', 400);
  if (!email) return again('Skriv en gyldig e-mailadresse.', 400);
  const [ipAllowed, emailAllowed] = await Promise.all([
    rateLimit(c.env.DB, `logistics:login-ip:${await sha256Hex(c.req.header('CF-Connecting-IP') ?? 'unknown')}`, 10, 900),
    rateLimit(c.env.DB, `logistics:login-email:${await sha256Hex(email)}`, 3, 900),
  ]);
  if (!ipAllowed || !emailAllowed) { c.header('Retry-After', '900'); return again('Der er forsøgt at logge ind mange gange. Vent 15 minutter, og prøv igen.', 429); }
  // Identical response and mail for new/existing users; no account enumeration.
  const token = await createLoginToken(c.env, email, { signup: true, name, next: DESTINATION });
  const origin = c.env.APP_URL?.replace(/\/+$/, '') || new URL(c.req.url).origin;
  const link = `${origin}/logistik/verify?token=${encodeURIComponent(token)}`;
  if (!c.env.RESEND_API_KEY && c.env.DEV_MODE === '1') return authPage(c, { sent: true, devLink: link });
  try {
    const sent = await sendEmail(c.env, {
      to: email, subject: 'Dit login-link til Logistikværktøjer · Veyro',
      text: `Hej\n\nLog ind eller opret din gratis Veyro-konto for at gemme beregninger i Logistikværktøjer:\n\n${link}\n\nLinket gælder i 15 minutter og kan kun bruges én gang. Du bliver bedt om at bekræfte dit login.\n\nHvis du ikke har bedt om linket, kan du ignorere denne mail.\n\nVeyro`,
      html: `<p>Hej</p><p>Log ind eller opret din gratis Veyro-konto for at gemme beregninger i Logistikværktøjer.</p><p><a href="${e(link)}">Fortsæt til Logistikværktøjer</a></p><p>Linket gælder i 15 minutter og kan kun bruges én gang. Du bliver bedt om at bekræfte dit login.</p><p>Hvis du ikke har bedt om linket, kan du ignorere denne mail.</p><p>Veyro</p>`,
    });
    if (!sent) throw new Error('Email unavailable');
  } catch {
    await c.env.DB.prepare('DELETE FROM login_tokens WHERE token_hash = ?').bind(await sha256Hex(token)).run();
    return again('Login-mailen kunne ikke sendes. Prøv igen om lidt. Du kan bruge beregnerne uden login imens.', 503);
  }
  return authPage(c, { sent: true });
});
async function ownToken(c: C, token: string) {
  if (!/^[A-Za-z0-9_-]{32,64}$/.test(token)) return false;
  return !!await c.env.DB.prepare(`SELECT token_hash FROM login_tokens
    WHERE token_hash = ? AND next = ? AND signup = 1 AND used_at IS NULL AND expires_at > ?`)
    .bind(await sha256Hex(token), DESTINATION, nowSec()).first();
}
const invalidLink = (c: C) => authPage(c, { error: 'Linket er udløbet eller allerede brugt. Bed om et nyt login-link.' }, 400);
logistics.get('/verify', async (c) => {
  const token = c.req.query('token') ?? '';
  return await ownToken(c, token) ? authPage(c, { token }) : invalidLink(c);
});
logistics.post('/verify', async (c) => {
  const body = await c.req.parseBody(), token = text(body.token);
  // Check purpose before consumption: links for other Veyro flows remain untouched.
  if (!await ownToken(c, token)) return invalidLink(c);
  const data = await consumeLoginToken(c.env, token);
  if (!data || !data.signup || data.next !== DESTINATION) return invalidLink(c);
  if (!await getCustomerByEmail(c.env.DB, data.email)) await upsertCustomer(c.env.DB, { email: data.email, name: data.name });
  if (c.get('session')) await destroySession(c);
  await createSession(c, data.email);
  return c.redirect(DESTINATION, 303);
});
logistics.post('/logout', async (c) => { await destroySession(c); return c.redirect('/logistik/', 303); });

logistics.onError((err, c) => {
  if (err instanceof LogisticsValidationError) return failure(c, err.code, err.message, 400, err.path);
  // Never log private calculation inputs or return a database/provider error to the user.
  console.error('Logistics request failed', c.req.method, c.req.path);
  return failure(c, 'unavailable', 'Beregningen kunne ikke gemmes eller hentes. Dine indtastninger er stadig i siden. Prøv igen om lidt.', 503);
});
logistics.notFound((c) => missing(c));
export default logistics;
