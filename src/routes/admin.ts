import { Hono, type Context } from 'hono';
import type { AppEnv } from '../env';
import { nowSec, sha256Hex } from '../lib/crypto';
import { listAllRequests, listCustomers, normalizeEmail, rateLimit, updateRequestStatus } from '../lib/db';
import { adminPasswordEmail, sendEmail } from '../lib/email';
import { hasAdminPassword, passwordProblem, setAdminPassword, verifyAdminPassword } from '../lib/password';
import { logError } from '../lib/errlog';
import {
  createInvoice,
  deleteDraft,
  isInvoiceId,
  listAdminInvoices,
  markPaid,
  readDraftForm,
  sendInvoice,
  validateDraft,
  voidInvoice,
  type DraftForm,
} from '../lib/invoices';
import { StripeError } from '../lib/stripe';
import { createLoginToken, createSession, destroySession, isAdmin } from '../lib/session';
import { render } from '../render';
import { adminCustomersPage, adminInvoicesPage, adminLoginPage, adminOverviewPage, adminPasswordPage, adminRequestsPage } from '../views/admin';
import { errorPage } from '../views/pages';
import { REQUEST_STATUSES } from '../views/status';

const admin = new Hono<AppEnv>();

// ---- Login med adgangskode (før adgangskontrollen nedenfor) ----

const LOGIN_FAILED = 'Forkert e-mail eller adgangskode.';

async function limited(c: Context<AppEnv>, email: string | null): Promise<boolean> {
  const ip = c.req.header('CF-Connecting-IP') ?? 'ukendt';
  const ipOk = await rateLimit(c.env.DB, 'admin-ip:' + (await sha256Hex(ip)), 10, 15 * 60);
  const emailOk = email ? await rateLimit(c.env.DB, 'admin-email:' + (await sha256Hex(email)), 5, 15 * 60) : true;
  return !ipOk || !emailOk;
}

admin.get('/login', (c) => {
  const session = c.get('session');
  if (session && isAdmin(c.env, session.email)) return c.redirect('/admin', 303);
  return render(c, 'Admin-login', adminLoginPage({ csrf: c.get('csrf') }));
});

admin.post('/login', async (c) => {
  const body = await c.req.parseBody();
  const email = normalizeEmail(body['email']);
  const password = typeof body['password'] === 'string' ? body['password'] : '';
  const again = (error: string, status: 401 | 429) =>
    render(c, 'Admin-login', adminLoginPage({ csrf: c.get('csrf'), email: email ?? '', error }), { status });
  if (await limited(c, email)) return again('For mange forsøg. Vent 15 minutter, og prøv igen.', 429);
  // Adgangskoden tjekkes altid, så svartiden ikke afslører, hvilke e-mails der er admins.
  const ok = !!email && !!password && (await verifyAdminPassword(c.env.DB, email, password));
  if (!ok || !isAdmin(c.env, email)) return again(LOGIN_FAILED, 401);
  if (c.get('session')) await destroySession(c);
  await createSession(c, email!);
  return c.redirect('/admin', 303);
});

admin.post('/login/link', async (c) => {
  const body = await c.req.parseBody();
  const email = normalizeEmail(body['email']);
  if (await limited(c, email)) {
    return render(c, 'Admin-login', adminLoginPage({ csrf: c.get('csrf'), email: email ?? '', error: 'For mange forsøg. Vent 15 minutter, og prøv igen.' }), { status: 429 });
  }
  let devLink: string | null = null;
  if (email && isAdmin(c.env, email)) {
    const token = await createLoginToken(c.env, email, { next: '/admin/adgangskode' });
    const link = `${c.env.APP_URL.replace(/\/+$/, '')}/login/bekraeft?token=${encodeURIComponent(token)}`;
    if (c.env.RESEND_API_KEY) {
      c.executionCtx.waitUntil(
        sendEmail(c.env, { to: email, ...adminPasswordEmail(link) }).catch((err) => logError(c.env.DB, 'admin.password-link', err)),
      );
    } else if (c.env.DEV_MODE === '1') devLink = link;
  }
  const info = 'Hvis e-mailen hører til en admin, har vi sendt et link. Det virker i 15 minutter.';
  return render(c, 'Admin-login', adminLoginPage({ csrf: c.get('csrf'), email: email ?? '', info, devLink }));
});

// Kun e-mails i ADMIN_EMAILS
admin.use('*', async (c, next) => {
  const session = c.get('session');
  if (!session) return c.redirect('/admin/login', 303);
  if (!isAdmin(c.env, session.email)) {
    return render(c, 'Ingen adgang', errorPage('Ingen adgang', 'Du har ikke adgang til denne side.', { href: '/konto', label: 'Til kundepanelet' }), {
      status: 403,
    });
  }
  await next();
});

admin.get('/', async (c) => {
  const [customers, requests] = await Promise.all([listCustomers(c.env.DB), listAllRequests(c.env.DB, null)]);
  return render(c, 'Admin', adminOverviewPage({ customers, requests }), { nav: 'admin', admin: true });
});

admin.get('/kunder', async (c) => {
  const customers = await listCustomers(c.env.DB);
  return render(c, 'Kunder', adminCustomersPage({ customers }), { nav: 'admin-kunder', admin: true });
});

admin.get('/henvendelser', async (c) => {
  const q = c.req.query('status');
  const filter = q && q in REQUEST_STATUSES ? q : null;
  const requests = await listAllRequests(c.env.DB, filter);
  return render(
    c,
    'Henvendelser',
    adminRequestsPage({ csrf: c.get('csrf'), requests, filter, updated: c.req.query('opdateret') === '1' }),
    { nav: 'admin-henvendelser', admin: true },
  );
});

admin.post('/henvendelser/:id/status', async (c) => {
  const id = Number.parseInt(c.req.param('id'), 10);
  const body = await c.req.parseBody();
  const status = body['status'];
  if (!Number.isSafeInteger(id) || id <= 0 || typeof status !== 'string' || !(status in REQUEST_STATUSES)) {
    return c.text('Ugyldig anmodning.', 400);
  }
  const ok = await updateRequestStatus(c.env.DB, id, status);
  if (!ok) return c.text('Henvendelsen findes ikke.', 404);
  return c.redirect(`/admin/henvendelser?opdateret=1#h-${id}`, 303);
});

// ---- Skift adgangskode ----

/** Lige efter login via e-mail-link (glemt adgangskode) kræves den nuværende adgangskode ikke. */
async function sessionIsFresh(c: Context<AppEnv>): Promise<boolean> {
  const row = await c.env.DB.prepare('SELECT created_at FROM sessions WHERE id_hash = ?')
    .bind(c.get('session')!.idHash)
    .first<{ created_at: number }>();
  return !!row && row.created_at > nowSec() - 15 * 60;
}

async function passwordView(c: Context<AppEnv>, extra: { error?: string; saved?: boolean; status?: 200 | 400 } = {}) {
  const email = c.get('session')!.email;
  const hasPassword = await hasAdminPassword(c.env.DB, email);
  const needCurrent = hasPassword && !(await sessionIsFresh(c));
  return render(
    c,
    'Adgangskode',
    adminPasswordPage({ csrf: c.get('csrf'), email, hasPassword, needCurrent, error: extra.error, saved: extra.saved }),
    { nav: 'admin-adgangskode', admin: true, status: extra.status },
  );
}

admin.get('/adgangskode', (c) => passwordView(c, { saved: c.req.query('gemt') === '1' }));

admin.post('/adgangskode', async (c) => {
  const session = c.get('session')!;
  const body = await c.req.parseBody();
  const str = (k: string) => (typeof body[k] === 'string' ? (body[k] as string) : '');
  const fail = (error: string) => passwordView(c, { error, status: 400 });
  if (await hasAdminPassword(c.env.DB, session.email) && !(await sessionIsFresh(c))) {
    if (await limited(c, session.email)) return fail('For mange forsøg. Vent 15 minutter, og prøv igen.');
    if (!(await verifyAdminPassword(c.env.DB, session.email, str('current')))) return fail('Den nuværende adgangskode er forkert.');
  }
  const problem = passwordProblem(str('new'), session.email);
  if (problem) return fail(problem);
  if (str('new') !== str('repeat')) return fail('De to nye adgangskoder er ikke ens.');
  await setAdminPassword(c.env.DB, session.email, str('new'));
  // Log ud alle andre steder
  await c.env.DB.prepare('DELETE FROM sessions WHERE email = ? AND id_hash != ?').bind(session.email, session.idHash).run();
  return c.redirect('/admin/adgangskode?gemt=1', 303);
});

// ---- Fakturaer (oprettes i Stripe) ----

async function invoicesView(
  c: Context<AppEnv>,
  extra: { form?: DraftForm | null; error?: string | null; errorField?: string | null; status?: 200 | 400 | 502 } = {},
) {
  const [customers, invoices] = await Promise.all([
    listCustomers(c.env.DB),
    listAdminInvoices(c.env).catch(async (err) => {
      await logError(c.env.DB, 'admin.invoices.list', err);
      return null;
    }),
  ]);
  const flash = c.req.query('besked') ?? null;
  return render(
    c,
    'Fakturaer',
    adminInvoicesPage({
      csrf: c.get('csrf'),
      formKey: crypto.randomUUID(),
      invoices,
      customers,
      form: extra.form ?? null,
      error: extra.error ?? null,
      errorField: extra.errorField ?? null,
      flash: extra.form ? null : flash,
    }),
    { nav: 'admin-fakturaer', admin: true, status: extra.status },
  );
}

function stripeMessage(err: unknown): string {
  const detail = err instanceof StripeError ? ` Stripe svarede: ${err.message}` : '';
  return `Fakturaen kunne ikke oprettes.${detail}`;
}

admin.get('/fakturaer', (c) => invoicesView(c));

admin.post('/fakturaer', async (c) => {
  const body = await c.req.parseBody();
  const form = readDraftForm(body);
  const key = typeof body['key'] === 'string' && /^[0-9a-f-]{36}$/.test(body['key']) ? body['key'] : crypto.randomUUID();
  const send = body['action'] === 'send';
  const v = validateDraft(form);
  if ('error' in v) return invoicesView(c, { form, error: v.error, errorField: v.field, status: 400 });
  try {
    const inv = await createInvoice(c.env, v.draft, { send, key: `admin-inv-${key}`, createdBy: c.get('session')!.email });
    return c.redirect(`/admin/fakturaer?besked=${send ? 'sendt' : 'kladde'}#${inv.id}`, 303);
  } catch (err) {
    await logError(c.env.DB, 'admin.invoices.create', err);
    return invoicesView(c, { form, error: stripeMessage(err), status: 502 });
  }
});

const INVOICE_ACTIONS: Record<string, { run: (env: AppEnv['Bindings'], id: string) => Promise<unknown>; flash: string }> = {
  send: { run: sendInvoice, flash: 'sendt' },
  slet: { run: deleteDraft, flash: 'slettet' },
  betalt: { run: markPaid, flash: 'betalt' },
  annuller: { run: voidInvoice, flash: 'annulleret' },
};

admin.post('/fakturaer/:id/:action', async (c) => {
  const id = c.req.param('id');
  const act = INVOICE_ACTIONS[c.req.param('action')];
  if (!act || !isInvoiceId(id)) return c.text('Ugyldig anmodning.', 400);
  try {
    await act.run(c.env, id);
  } catch (err) {
    await logError(c.env.DB, `admin.invoices.${c.req.param('action')}`, err);
    const msg = err instanceof StripeError ? err.message : 'Ukendt fejl';
    return invoicesView(c, { error: `Handlingen mislykkedes. Stripe svarede: ${msg}`, status: 502 });
  }
  return c.redirect(`/admin/fakturaer?besked=${act.flash}`, 303);
});

export default admin;
