import { Hono, type Context } from 'hono';
import type { AppEnv, CustomerRow } from '../env';
import { nowSec, sha256Hex } from '../lib/crypto';
import { getCustomerByEmail, normalizeEmail, rateLimit, upsertCustomer } from '../lib/db';
import { escapeHtml, sendEmail } from '../lib/email';
import { createPlanningData, isPlanningTemplateId, validatePlanningData, type PlanningData } from '../lib/planning';
import { consumeLoginToken, createLoginToken, createSession, destroySession } from '../lib/session';
import { archiveToolProject, createToolProject, getToolProject, listToolProjects, saveToolProject, type ToolCurrency, type ToolProject } from '../lib/tools-store';
import { toolsPage, planningResults } from '../views/tools';
import { toolsCopy } from '../views/tools-copy';

type Language = 'da' | 'en' | 'sv';
type C = Context<AppEnv>;
type Form = Record<string, unknown>;
const tools = new Hono<AppEnv>();
const MAX_DATA_BYTES = 50_000;
const bytes = (s: string) => new TextEncoder().encode(s).length;
const text = (value: unknown) => typeof value === 'string' ? value : '';
const nameValue = (value: unknown) => text(value).trim().replace(/\s+/g, ' ');
const versionValue = (value: unknown) => /^\d{1,10}$/.test(text(value)) && Number(value) > 0 ? Number(value) : null;
const currencyValue = (value: unknown): ToolCurrency | null => value === 'DKK' || value === 'EUR' || value === 'SEK' ? value : null;
const validId = (id: string) => /^[a-f0-9-]{36}$/.test(id);
const target = (lang: Language, id?: string) => `/tools${id ? `/projects/${id}` : '/legacy'}?lang=${lang}`;
// Accept login links issued before the new calculator replaced the tools landing page.
const tokenDestination = (next: string | null | undefined) => /^\/tools(?:\/legacy)?\?lang=(da|en|sv)$/.exec(next ?? '');

function language(c: C, body?: Form): Language {
  const value = body?.lang ?? c.req.query('lang');
  if (value === 'da' || value === 'sv' || value === 'en') return value;
  const country = (c.req.raw.cf as { country?: string } | undefined)?.country;
  return country === 'DK' ? 'da' : country === 'SE' ? 'sv' : 'en';
}
function initialCurrency(lang: Language): ToolCurrency { return lang === 'da' ? 'DKK' : lang === 'sv' ? 'SEK' : 'EUR'; }
async function owner(c: C): Promise<CustomerRow | null> {
  const session = c.get('session');
  return session ? getCustomerByEmail(c.env.DB, session.email) : null;
}
async function home(c: C, lang: Language, extra: { error?: string; notice?: string; name?: string; view?: 'home' | 'sent' | 'verify'; token?: string; devLink?: string } = {}, status: 200 | 400 | 404 | 409 | 429 | 503 = 200) {
  const customer = await owner(c);
  return c.html(toolsPage({ lang, csrf: c.get('csrf'), email: c.get('session')?.email ?? null,
    projects: customer ? await listToolProjects(c.env.DB, customer.id) : [], view: 'home', ...extra }), status);
}
async function workspace(c: C, lang: Language, project: ToolProject, extra: { error?: string; notice?: string } = {}, status: 200 | 400 | 409 | 429 = 200) {
  return c.html(toolsPage({ lang, csrf: c.get('csrf'), email: c.get('session')!.email, projects: [], view: 'workspace', project, ...extra }), status);
}
async function writeAllowed(c: C): Promise<boolean> {
  const session = c.get('session');
  return !!session && rateLimit(c.env.DB, `tools:write:${await sha256Hex(session.email)}`, 60, 60);
}
async function quotaMessage(c: C, customerId: number, lang: Language): Promise<string> {
  const total = await c.env.DB.prepare('SELECT COUNT(*) AS n FROM tool_projects WHERE customer_id = ?').bind(customerId).first<{ n: number }>();
  return total && total.n >= 200 ? toolsCopy(lang).errors.storageQuota : toolsCopy(lang).errors.quota;
}
function parseData(body: Form): PlanningData | null {
  const raw = text(body.data);
  if (!raw || bytes(raw) > MAX_DATA_BYTES) return null;
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) && parsed.settings && typeof parsed.settings === 'object'
      && !Array.isArray(parsed.settings) && Array.isArray(parsed.rows) && parsed.rows.length <= 50
      && parsed.rows.every((r: unknown) => !!r && typeof r === 'object' && !Array.isArray(r)) ? parsed as PlanningData : null;
  } catch { return null; }
}
function validationMessage(lang: Language, err?: unknown): string {
  const copy = toolsCopy(lang);
  const path = err && typeof err === 'object' && 'path' in err && typeof err.path === 'string' ? err.path : '';
  const code = err && typeof err === 'object' && 'code' in err ? err.code : '';
  const rowField = path.match(/^rows\.(\d+)\.([A-Za-z][A-Za-z0-9]*)$/);
  const settingField = path.match(/^settings\.([A-Za-z][A-Za-z0-9]*)$/);
  const field = rowField?.[2] ?? settingField?.[1];
  const label = field && Object.hasOwn(copy.fields, field) ? copy.fields[field] : '';
  const location = label ? `${rowField ? `${copy.row} ${Number(rowField[1]) + 1}` : copy.settings}: ${label}` : '';
  const message = code === 'inconsistent' ? copy.errors.inconsistent : copy.errors.invalidInput;
  return `${message}${location ? ` ${location}.` : ''}`;
}

// The parent app applies the body-size limit, session cookies and CSRF protection.
tools.use('*', async (c, next) => {
  c.header('Cache-Control', 'private, no-store');
  c.header('X-Robots-Tag', 'noindex, nofollow');
  if ((c.req.method === 'GET' || c.req.method === 'HEAD') && (c.req.path === '/tools' || c.req.path === '/tools/')) {
    return c.redirect('/logistik/', 302);
  }
  if ((c.req.path.startsWith('/tools/projects') || c.req.path === '/tools/preview') && !c.get('session')) {
    return c.req.path === '/tools/preview'
      ? c.json({ error: toolsCopy(language(c)).errors.signInRequired }, 401)
      : c.redirect(`${target(language(c))}#account`, 303);
  }
  await next();
});

tools.get('/legacy', async (c) => {
  const lang = language(c);
  const key = c.req.query('notice');
  const notices = toolsCopy(lang).notices;
  const notice = key && Object.hasOwn(notices, key) ? notices[key as keyof typeof notices] : undefined;
  return home(c, lang, { notice });
});

tools.post('/sign-in', async (c) => {
  const body = await c.req.parseBody();
  const lang = language(c, body);
  const copy = toolsCopy(lang);
  if (c.get('session')) return c.redirect(target(lang), 303);
  const email = normalizeEmail(body.email);
  const name = nameValue(body.name);
  if (!email) return home(c, lang, { error: copy.errors.invalidEmail, name }, 400);
  if (!name || name.length > 100) return home(c, lang, { error: copy.errors.invalidName, name }, 400);
  const ip = c.req.header('CF-Connecting-IP') ?? 'unknown';
  const [ipOk, emailOk] = await Promise.all([
    rateLimit(c.env.DB, `tools:login-ip:${await sha256Hex(ip)}`, 10, 900),
    rateLimit(c.env.DB, `tools:login-email:${await sha256Hex(email)}`, 3, 900),
  ]);
  if (!ipOk || !emailOk) return home(c, lang, { error: copy.errors.tooMany, name }, 429);
  // Both existing and new accounts take the same path and receive the same message.
  // No customer row is written until the email owner confirms the single-use link.
  const token = await createLoginToken(c.env, email, { signup: true, name, next: target(lang) });
  const appUrl = c.env.APP_URL ? c.env.APP_URL.replace(/\/+$/, '') : new URL(c.req.url).origin;
  const link = `${appUrl}/tools/verify?token=${encodeURIComponent(token)}&lang=${lang}`;
  if (!c.env.RESEND_API_KEY && c.env.DEV_MODE === '1') return home(c, lang, { view: 'sent', devLink: link });
  try {
    const sent = await sendEmail(c.env, { to: email, ...loginEmail(lang, link) });
    if (!sent) throw new Error('Email unavailable');
  } catch {
    // A failed mail must never leave a usable link or display a success state.
    await c.env.DB.prepare('DELETE FROM login_tokens WHERE token_hash = ?').bind(await sha256Hex(token)).run();
    return home(c, lang, { error: copy.errors.emailFailed, name }, 503);
  }
  return home(c, lang, { view: 'sent' });
});

async function toolToken(c: C, token: string): Promise<boolean> {
  if (!/^[A-Za-z0-9_-]{32,64}$/.test(token)) return false;
  const row = await c.env.DB.prepare(`SELECT next FROM login_tokens WHERE token_hash = ? AND used_at IS NULL AND expires_at > ?`)
    .bind(await sha256Hex(token), nowSec()).first<{ next: string | null }>();
  return !!row && !!tokenDestination(row.next);
}
tools.get('/verify', async (c) => {
  const lang = language(c);
  const token = c.req.query('token') ?? '';
  if (!await toolToken(c, token)) return home(c, lang, { error: toolsCopy(lang).errors.invalidLink }, 400);
  return home(c, lang, { view: 'verify', token });
});
tools.post('/verify', async (c) => {
  const body = await c.req.parseBody();
  const lang = language(c, body);
  const token = text(body.token);
  if (!await toolToken(c, token)) return home(c, lang, { error: toolsCopy(lang).errors.invalidLink }, 400);
  const data = await consumeLoginToken(c.env, token);
  const destination = tokenDestination(data?.next);
  if (!data || !data.signup || !destination) return home(c, lang, { error: toolsCopy(lang).errors.invalidLink }, 400);
  if (!await getCustomerByEmail(c.env.DB, data.email)) await upsertCustomer(c.env.DB, { email: data.email, name: data.name });
  if (c.get('session')) await destroySession(c);
  await createSession(c, data.email);
  return c.redirect(target(destination[1] as Language), 303);
});
tools.post('/logout', async (c) => {
  const lang = language(c, await c.req.parseBody());
  await destroySession(c);
  return c.redirect(target(lang), 303);
});

tools.post('/projects', async (c) => {
  const body = await c.req.parseBody();
  const lang = language(c, body);
  const copy = toolsCopy(lang);
  if (!await writeAllowed(c)) return home(c, lang, { error: copy.errors.tooManyChanges }, 429);
  const templateId = body.templateId;
  const name = nameValue(body.name);
  if (!isPlanningTemplateId(templateId)) return home(c, lang, { error: copy.errors.invalidInput }, 400);
  if (!name || name.length > 100) return home(c, lang, { error: copy.errors.nameRequired }, 400);
  const currency = body.currency ? currencyValue(body.currency) : initialCurrency(lang);
  if (!currency) return home(c, lang, { error: copy.errors.currencyInvalid }, 400);
  const customer = await owner(c) ?? await upsertCustomer(c.env.DB, { email: c.get('session')!.email });
  const id = await createToolProject(c.env.DB, customer.id, { templateId, name, currency, data: createPlanningData(templateId) });
  if (!id) return home(c, lang, { error: await quotaMessage(c, customer.id, lang) }, 409);
  return c.redirect(`${target(lang, id)}&notice=created`, 303);
});

tools.get('/projects/:id', async (c) => {
  const lang = language(c);
  const customer = await owner(c);
  const id = c.req.param('id');
  const project = customer && validId(id) ? await getToolProject(c.env.DB, customer.id, id) : null;
  if (!project) return home(c, lang, { error: toolsCopy(lang).errors.notFound }, 404);
  const key = c.req.query('notice');
  const notices = toolsCopy(lang).notices;
  return workspace(c, lang, project, { notice: key && Object.hasOwn(notices, key) ? notices[key as keyof typeof notices] : undefined });
});

tools.post('/projects/:id/save', async (c) => {
  const body = await c.req.parseBody();
  const lang = language(c, body);
  const copy = toolsCopy(lang);
  const customer = await owner(c);
  const id = c.req.param('id');
  const current = customer && validId(id) ? await getToolProject(c.env.DB, customer.id, id) : null;
  if (!current || !customer) return home(c, lang, { error: copy.errors.notFound }, 404);
  const rawData = parseData(body);
  const name = nameValue(body.name);
  const currency = currencyValue(body.currency);
  const version = versionValue(body.version);
  const submitted = { ...current, name, currency: currency ?? current.currency, data: rawData ?? current.data, version: version ?? current.version };
  if (!await writeAllowed(c)) return workspace(c, lang, submitted, { error: copy.errors.tooManyChanges }, 429);
  if (!name || name.length > 100) return workspace(c, lang, submitted, { error: copy.errors.nameRequired }, 400);
  if (!currency) return workspace(c, lang, submitted, { error: copy.errors.currencyInvalid }, 400);
  if (!version) return workspace(c, lang, submitted, { error: copy.errors.versionInvalid }, 400);
  if (current.archivedAt !== null) return workspace(c, lang, submitted, { error: copy.errors.archived }, 409);
  if (!rawData) return workspace(c, lang, submitted, { error: copy.errors.invalidInput }, 400);
  let data: PlanningData;
  try { data = validatePlanningData(current.templateId, rawData); }
  catch (err) { return workspace(c, lang, submitted, { error: validationMessage(lang, err) }, 400); }
  const saved = await saveToolProject(c.env.DB, customer.id, id, version, { name, currency, data });
  if (!saved) return workspace(c, lang, submitted, { error: copy.errors.conflict }, 409);
  return c.redirect(`${target(lang, id)}&notice=saved`, 303);
});

tools.post('/projects/:id/duplicate', async (c) => {
  const body = await c.req.parseBody();
  const lang = language(c, body);
  const copy = toolsCopy(lang);
  const customer = await owner(c);
  const id = c.req.param('id');
  const current = customer && validId(id) ? await getToolProject(c.env.DB, customer.id, id) : null;
  if (!current || !customer) return home(c, lang, { error: copy.errors.notFound }, 404);
  const hasDraft = Object.hasOwn(body, 'data');
  const rawData = hasDraft ? parseData(body) : null;
  const name = Object.hasOwn(body, 'name') ? nameValue(body.name) : `${current.name.slice(0, 90)} (${lang === 'en' ? 'copy' : lang === 'sv' ? 'kopia' : 'kopi'})`;
  const submittedCurrency = hasDraft ? currencyValue(body.currency) : current.currency;
  const submitted = { ...current, name, data: rawData ?? current.data, currency: submittedCurrency ?? current.currency,
    version: versionValue(body.version) ?? current.version };
  if (!await writeAllowed(c)) return workspace(c, lang, submitted, { error: copy.errors.tooManyChanges }, 429);
  if (!name || name.length > 100) return workspace(c, lang, submitted, { error: copy.errors.nameRequired }, 400);
  // The editor can save a conflicting draft as a new project without overwriting
  // the version saved in another tab. Dashboard duplication uses the saved data.
  let data = current.data;
  let currency = current.currency;
  if (hasDraft) {
    if (!rawData || !submittedCurrency) return workspace(c, lang, submitted, { error: copy.errors.invalidInput }, 400);
    try { data = validatePlanningData(current.templateId, rawData); }
    catch (err) { return workspace(c, lang, submitted, { error: validationMessage(lang, err) }, 400); }
    currency = submittedCurrency;
  }
  const newId = await createToolProject(c.env.DB, customer.id, { ...current, name, data, currency });
  if (!newId) return workspace(c, lang, submitted, { error: await quotaMessage(c, customer.id, lang) }, 409);
  return c.redirect(`${target(lang, newId)}&notice=duplicated`, 303);
});

for (const action of ['archive', 'restore'] as const) {
  tools.post(`/projects/:id/${action}`, async (c) => {
    const body = await c.req.parseBody();
    const lang = language(c, body);
    const copy = toolsCopy(lang);
    const customer = await owner(c);
    const id = c.req.param('id');
    const current = customer && validId(id) ? await getToolProject(c.env.DB, customer.id, id) : null;
    if (!current || !customer) return home(c, lang, { error: copy.errors.notFound }, 404);
    if (!await writeAllowed(c)) return workspace(c, lang, current, { error: copy.errors.tooManyChanges }, 429);
    const version = versionValue(body.version);
    if (!version) return workspace(c, lang, current, { error: copy.errors.versionInvalid }, 400);
    const updated = await archiveToolProject(c.env.DB, customer.id, id, version, action === 'restore');
    if (!updated) {
      const count = action === 'restore' ? await c.env.DB.prepare('SELECT COUNT(*) AS n FROM tool_projects WHERE customer_id = ? AND archived_at IS NULL')
        .bind(customer.id).first<{ n: number }>() : null;
      return workspace(c, lang, current, { error: count && count.n >= 50 ? copy.errors.quota : copy.errors.conflict }, 409);
    }
    return c.redirect(`${target(lang)}&notice=${action === 'restore' ? 'restored' : 'archived'}`, 303);
  });
}

tools.post('/preview', async (c) => {
  const body = await c.req.parseBody();
  const lang = language(c, body);
  const copy = toolsCopy(lang);
  if (!await rateLimit(c.env.DB, `tools:preview:${await sha256Hex(c.get('session')!.email)}`, 180, 60)) return c.json({ error: copy.errors.tooManyChanges }, 429);
  const templateId = body.templateId;
  const currency = currencyValue(body.currency);
  const rawData = parseData(body);
  if (!isPlanningTemplateId(templateId) || !currency || !rawData) return c.json({ error: copy.errors.invalidInput }, 400);
  try {
    const data = validatePlanningData(templateId, rawData);
    return c.json({ html: planningResults(templateId, data, lang, currency) });
  } catch (err) { return c.json({ error: validationMessage(lang, err) }, 400); }
});

function loginEmail(lang: Language, link: string) {
  const t = {
    en: { subject: 'Your sign-in link for Veyro Tools', title: 'Your free Veyro workspace', body: 'Confirm your email to open your private logistics and procurement tools. Your account is free and does not require payment details.', button: 'Open my workspace', note: 'This link expires in 15 minutes and can only be used once. If you did not request it, ignore this email.' },
    da: { subject: 'Dit login-link til Veyro Tools', title: 'Dit gratis arbejdsrum hos Veyro', body: 'Bekræft din e-mail for at åbne dine private værktøjer til logistik og indkøb. Kontoen er gratis og kræver ingen betalingsoplysninger.', button: 'Åbn mit arbejdsrum', note: 'Linket udløber om 15 minutter og kan kun bruges én gang. Har du ikke bedt om det, kan du se bort fra denne mail.' },
    sv: { subject: 'Din inloggningslänk till Veyro Tools', title: 'Din kostnadsfria arbetsyta hos Veyro', body: 'Bekräfta din e-postadress för att öppna dina privata verktyg för logistik och inköp. Kontot är gratis och kräver inga betalningsuppgifter.', button: 'Öppna min arbetsyta', note: 'Länken gäller i 15 minuter och kan bara användas en gång. Om du inte har begärt den kan du bortse från mejlet.' },
  }[lang];
  return { subject: t.subject, text: `${t.title}\n\n${t.body}\n\n${link}\n\n${t.note}\n\nVeyro`,
    html: `<!doctype html><html lang="${lang}"><body style="font:16px/1.6 Arial,sans-serif;background:#f4f2ec;color:#171714;padding:32px"><main style="max-width:520px;margin:auto;background:#fff;padding:32px;border-radius:24px"><p>Veyro<span style="color:#ff5a1f">.</span></p><h1 style="font-size:28px">${t.title}</h1><p>${t.body}</p><p><a href="${escapeHtml(link)}" style="display:inline-block;background:#ff5a1f;color:#171714;padding:12px 20px;border-radius:12px;text-decoration:none">${t.button}</a></p><p style="color:#55534d">${t.note}</p></main></body></html>` };
}

export default tools;
