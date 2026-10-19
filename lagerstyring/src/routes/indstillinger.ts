import { Hono, type Context } from 'hono';
import type { AppEnv, MailRow, Role, User } from '../env';
import { suppliers } from '../lib/catalog';
import { deliver, emailConfigured, inviteEmail } from '../lib/email';
import { appUrl } from '../lib/notices';
import { normalizeEmail, parseIntStrict, str } from '../lib/format';
import { DIGEST_CHOICES, LOGO_MAX_BYTES, deleteLogo, isHexColor, logoType, saveLogo, saveSettings } from '../lib/settings';
import { isAdminUser, parseAdminEmails } from '../lib/session';
import { idParam, isDemo, render } from '../render';
import { mailsPage, settingsPage } from '../views/indstillinger';

const indstillinger = new Hono<AppEnv>();
const NAV = { portal: 'lager', tab: 'indstillinger' } as const;
const ROLES: Role[] = ['ejer', 'indkober', 'medarbejder'];
const now = () => Math.floor(Date.now() / 1000);

/** Administratorer (ADMIN_EMAILS eller markeret i appen) må skifte logo og udnævne administratorer. */
const isAdmin = (c: Context<AppEnv>) => isAdminUser(c.env, c.get('session')?.user);

async function show(c: Context<AppEnv>, errs: string[] = []) {
  const db = c.env.DB;
  const [{ results: users }, sups] = await Promise.all([db.prepare('SELECT * FROM users ORDER BY active DESC, name COLLATE NOCASE').all<User>(), suppliers(db)]);
  return render(
    c,
    'Indstillinger',
    settingsPage({
      s: c.get('settings'),
      users,
      suppliers: sups,
      csrf: c.get('csrf'),
      mailConfigured: emailConfigured(c.env),
      canEditLogo: isAdmin(c),
      fixedAdmins: [...parseAdminEmails(c.env)],
      demo: isDemo(c),
      flashCode: c.req.query('besked'),
      errs,
    }),
    NAV,
    errs.length ? 400 : 200,
  );
}

indstillinger.get('/', (c) => show(c));

indstillinger.post('/firma', async (c) => {
  const body = await c.req.parseBody();
  const name = str(body['company_name'], 80);
  const accent = str(body['accent_color'], 7);
  const markup = parseIntStrict(body['default_markup_pct'], { max: 1000 });
  const digest = Number(body['purchase_digest_hours']);
  const errs: string[] = [];
  if (!name) errs.push('Angiv et firmanavn.');
  if (!isHexColor(accent)) errs.push('Vælg en gyldig farve.');
  if (markup === null) errs.push('Avancen skal være et helt tal mellem 0 og 1000.');
  if (!DIGEST_CHOICES.includes(digest)) errs.push('Vælg et gyldigt interval.');
  if (errs.length) return show(c, errs);
  await saveSettings(c.env.DB, {
    company_name: name,
    accent_color: accent.toUpperCase(),
    default_markup_pct: markup!,
    purchase_digest_hours: digest,
    alert_mail_enabled: body['alert_mail_enabled'] === '1',
  });
  return c.redirect('/lager/indstillinger?besked=gemt', 303);
});

indstillinger.post('/logo', async (c) => {
  if (!isAdmin(c)) return show(c, ['Kun administratorer kan skifte logoet.']);
  const file = (await c.req.parseBody())['logo'];
  if (!(file instanceof File) || file.size === 0) return show(c, ['Vælg en billedfil.']);
  if (file.size > LOGO_MAX_BYTES) return show(c, [`Logoet må højst fylde ${Math.round(LOGO_MAX_BYTES / 1024)} KB.`]);
  const bytes = new Uint8Array(await file.arrayBuffer());
  const type = logoType(bytes);
  if (!type) return show(c, ['Logoet skal være en PNG-, JPG-, WebP- eller SVG-fil.']);
  await saveLogo(c.env.DB, type, bytes);
  return c.redirect('/lager/indstillinger?besked=logo_gemt', 303);
});

indstillinger.post('/logo/slet', async (c) => {
  if (!isAdmin(c)) return show(c, ['Kun administratorer kan fjerne logoet.']);
  await deleteLogo(c.env.DB);
  return c.redirect('/lager/indstillinger?besked=logo_slettet', 303);
});

function userInput(body: Record<string, unknown>) {
  const role = ROLES.includes(body['role'] as Role) ? (body['role'] as Role) : null;
  return {
    name: str(body['name'], 80),
    role,
    alert_mail: body['alert_mail'] === '1' ? 1 : 0,
    purchase_mail: body['purchase_mail'] === '1' ? 1 : 0,
    active: body['active'] === '1' ? 1 : 0,
  };
}

indstillinger.post('/bruger', async (c) => {
  const body = await c.req.parseBody();
  const u = userInput(body);
  const email = normalizeEmail(body['email']);
  if (!u.name || !u.role || !email) return show(c, ['Angiv navn, en gyldig e-mail og en rolle.']);
  // Kun administratorer kan oprette administratorer; en administrator er altid ejer
  const admin = body['is_admin'] === '1' && isAdmin(c) ? 1 : 0;
  try {
    await c.env.DB.prepare('INSERT INTO users (email, name, role, alert_mail, purchase_mail, active, is_admin, created_at) VALUES (?, ?, ?, ?, ?, 1, ?, ?)')
      .bind(email, u.name, admin ? 'ejer' : u.role, u.alert_mail, u.purchase_mail, admin, now())
      .run();
  } catch (err) {
    if (String((err as Error).message).includes('UNIQUE')) return show(c, [`Der findes allerede en bruger med ${email}.`]);
    throw err;
  }
  if (body['invite'] !== '1') return c.redirect('/lager/indstillinger?besked=oprettet', 303);
  const me = c.get('session')!.user;
  const s = c.get('settings');
  const { status } = await deliver(c.env, s, { to: email, ...inviteEmail(`${appUrl(c.env)}/login`, me.name, s) }, { kind: 'invitation', actor: me.email });
  return c.redirect(`/lager/indstillinger?besked=${status === 'sendt' ? 'inviteret' : status === 'simuleret' ? 'invitation_simuleret' : 'invitation_fejlet'}`, 303);
});

indstillinger.post('/bruger/:id{[0-9]+}', async (c) => {
  const db = c.env.DB;
  const id = Number(c.req.param('id'));
  const body = await c.req.parseBody();
  const u = userInput(body);
  if (!u.name || !u.role) return show(c, ['Angiv navn og rolle.']);
  const target = await db.prepare('SELECT * FROM users WHERE id = ?').bind(id).first<User>();
  if (!target) return c.notFound();
  const fixed = parseAdminEmails(c.env).has(target.email.toLowerCase());
  const wasAdmin = isAdminUser(c.env, target);
  // Kun administratorer kan ændre en administrator eller udnævne nye
  if (wasAdmin && !isAdmin(c)) return show(c, ['Kun administratorer kan ændre en administrator.']);
  const admin = isAdmin(c) ? (body['is_admin'] === '1' ? 1 : 0) : target.is_admin;
  if (fixed && (!u.active || u.role !== 'ejer')) return show(c, [`${target.email} er fast administrator og skal være aktiv ejer.`]);
  if (admin && u.role !== 'ejer') return show(c, ['En administrator skal have rollen ejer.']);
  // Der skal altid være mindst én aktiv ejer
  const owners = await db.prepare("SELECT COUNT(*) AS n FROM users WHERE role = 'ejer' AND active = 1 AND id <> ?").bind(id).first<{ n: number }>();
  if (!owners?.n && (u.role !== 'ejer' || !u.active)) return show(c, ['Der skal være mindst én aktiv ejer.']);
  await db
    .prepare('UPDATE users SET name = ?, role = ?, alert_mail = ?, purchase_mail = ?, active = ?, is_admin = ? WHERE id = ?')
    .bind(u.name, u.role, u.alert_mail, u.purchase_mail, u.active, admin, id)
    .run();
  if (!u.active) {
    const row = await db.prepare('SELECT email FROM users WHERE id = ?').bind(id).first<{ email: string }>();
    if (row) await db.prepare('DELETE FROM sessions WHERE email = ?').bind(row.email).run();
  }
  return c.redirect('/lager/indstillinger?besked=gemt', 303);
});

function supplierInput(body: Record<string, unknown>) {
  const raw = str(body['lead_time_days'], 4);
  const lead = raw ? parseIntStrict(raw, { max: 365 }) : null;
  return { name: str(body['name'], 80), email: body['email'] ? normalizeEmail(body['email']) : '', phone: str(body['phone'], 40), lead, leadBad: !!raw && lead === null };
}

indstillinger.post('/leverandor', async (c) => {
  const x = supplierInput(await c.req.parseBody());
  if (!x.name || x.email === null || x.leadBad) return show(c, ['Angiv et navn, en gyldig e-mail (eller ingen) og en leveringstid på 0-365 dage.']);
  try {
    await c.env.DB.prepare('INSERT INTO suppliers (name, email, phone, lead_time_days, created_at) VALUES (?, ?, ?, ?, ?)').bind(x.name, x.email, x.phone, x.lead, now()).run();
  } catch (err) {
    if (String((err as Error).message).includes('UNIQUE')) return show(c, [`Leverandøren ${x.name} findes allerede.`]);
    throw err;
  }
  return c.redirect('/lager/indstillinger?besked=oprettet', 303);
});

indstillinger.post('/leverandor/:id{[0-9]+}', async (c) => {
  const x = supplierInput(await c.req.parseBody());
  if (!x.name || x.email === null || x.leadBad) return show(c, ['Angiv et navn, en gyldig e-mail (eller ingen) og en leveringstid på 0-365 dage.']);
  try {
    await c.env.DB.prepare('UPDATE suppliers SET name = ?, email = ?, phone = ?, lead_time_days = ? WHERE id = ?').bind(x.name, x.email, x.phone, x.lead, Number(c.req.param('id'))).run();
  } catch (err) {
    if (String((err as Error).message).includes('UNIQUE')) return show(c, [`Leverandøren ${x.name} findes allerede.`]);
    throw err;
  }
  return c.redirect('/lager/indstillinger?besked=gemt', 303);
});

indstillinger.get('/mails', async (c) => {
  const db = c.env.DB;
  const { results } = await db.prepare('SELECT * FROM mails ORDER BY id DESC LIMIT 100').all<MailRow>();
  const vis = idParam(c.req.query('vis'));
  const open = vis ? await db.prepare('SELECT * FROM mails WHERE id = ?').bind(vis).first<MailRow>() : null;
  return render(c, 'E-mail-log', mailsPage({ mails: results, open }), NAV);
});

export default indstillinger;
