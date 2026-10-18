import { Hono, type Context } from 'hono';
import type { AppEnv } from '../env';
import { sha256Hex } from '../lib/crypto';
import { listAllRequests, listCustomers, normalizeEmail, rateLimit, updateRequestStatus } from '../lib/db';
import { adminLoginEmail, sendEmail } from '../lib/email';
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
import {
  changePrice,
  createSubscription,
  giveOffer,
  isSubscriptionId,
  listAdminSubscriptions,
  parseOffer,
  removeOffer,
  setCancelAtPeriodEnd,
  validateSubDraft,
} from '../lib/admin-subscriptions';
import { parseKr } from '../lib/invoices';
import { createLoginToken, isAdmin } from '../lib/session';
import { render } from '../render';
import { adminCustomersPage, adminInvoicesPage, adminLoginPage, adminOverviewPage, adminRequestsPage, adminSubscriptionsPage } from '../views/admin';
import { errorPage } from '../views/pages';
import { REQUEST_STATUSES } from '../views/status';

const admin = new Hono<AppEnv>();

// ---- Login via link på mail (før adgangskontrollen nedenfor) ----

admin.get('/login', (c) => {
  const session = c.get('session');
  if (session && isAdmin(c.env, session.email)) return c.redirect('/admin', 303);
  return render(c, 'Admin-login', adminLoginPage({ csrf: c.get('csrf') }));
});

admin.post('/login', async (c) => {
  const body = await c.req.parseBody();
  const email = normalizeEmail(body['email']);
  const ip = c.req.header('CF-Connecting-IP') ?? 'ukendt';
  const ipOk = await rateLimit(c.env.DB, 'admin-ip:' + (await sha256Hex(ip)), 10, 15 * 60);
  const emailOk = email ? await rateLimit(c.env.DB, 'admin-email:' + (await sha256Hex(email)), 5, 15 * 60) : true;
  if (!ipOk || !emailOk) {
    return render(c, 'Admin-login', adminLoginPage({ csrf: c.get('csrf'), email: email ?? '', error: 'For mange forsøg. Vent 15 minutter, og prøv igen.' }), { status: 429 });
  }
  let devLink: string | null = null;
  if (email && isAdmin(c.env, email)) {
    const token = await createLoginToken(c.env, email, { next: '/admin' });
    const link = `${c.env.APP_URL.replace(/\/+$/, '')}/login/bekraeft?token=${encodeURIComponent(token)}`;
    if (c.env.RESEND_API_KEY) {
      c.executionCtx.waitUntil(
        sendEmail(c.env, { to: email, ...adminLoginEmail(link) }).catch((err) => logError(c.env.DB, 'admin.login-link', err)),
      );
    } else if (c.env.DEV_MODE === '1') devLink = link;
  }
  // Samme svar uanset e-mail, så siden ikke afslører, hvem der er admin.
  return render(c, 'Tjek din indbakke', adminLoginPage({ csrf: c.get('csrf'), email: email ?? '', sent: true, devLink }));
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

// ---- Abonnementer (oprettes i Stripe) ----

async function subscriptionsView(
  c: Context<AppEnv>,
  extra: { form?: DraftForm | null; body?: Record<string, unknown> | null; error?: string | null; errorField?: string | null; status?: 400 | 502 } = {},
) {
  const [customers, subs] = await Promise.all([
    listCustomers(c.env.DB),
    listAdminSubscriptions(c.env).catch(async (err) => {
      await logError(c.env.DB, 'admin.subscriptions.list', err);
      return null;
    }),
  ]);
  return render(
    c,
    'Abonnementer',
    adminSubscriptionsPage({
      csrf: c.get('csrf'),
      formKey: crypto.randomUUID(),
      subs,
      customers,
      form: extra.form ?? null,
      body: extra.body ?? null,
      error: extra.error ?? null,
      errorField: extra.errorField ?? null,
      flash: extra.form || extra.error ? null : (c.req.query('besked') ?? null),
    }),
    { nav: 'admin-abonnementer', admin: true, status: extra.status },
  );
}

admin.get('/abonnementer', (c) => subscriptionsView(c));

admin.post('/abonnementer', async (c) => {
  const body = await c.req.parseBody();
  const form = readDraftForm(body);
  const key = typeof body['key'] === 'string' && /^[0-9a-f-]{36}$/.test(body['key']) ? body['key'] : crypto.randomUUID();
  const v = validateSubDraft(form, body);
  if ('error' in v) return subscriptionsView(c, { form, body, error: v.error, errorField: v.field, status: 400 });
  try {
    const sub = await createSubscription(c.env, v.draft, { key: `admin-sub-${key}`, createdBy: c.get('session')!.email });
    return c.redirect(`/admin/abonnementer?besked=${v.draft.freeFirstMonth ? 'oprettet-gratis' : 'oprettet'}#${sub.id}`, 303);
  } catch (err) {
    await logError(c.env.DB, 'admin.subscriptions.create', err);
    const detail = err instanceof StripeError ? ` Stripe svarede: ${err.message}` : '';
    return subscriptionsView(c, { form, body, error: `Abonnementet kunne ikke oprettes.${detail}`, status: 502 });
  }
});

admin.post('/abonnementer/:id/:action', async (c) => {
  const id = c.req.param('id');
  const action = c.req.param('action');
  if (!isSubscriptionId(id)) return c.text('Ugyldig anmodning.', 400);
  const body = await c.req.parseBody();
  const fail = (error: string, status: 400 | 502 = 400) => subscriptionsView(c, { error, status });
  let flash: string;
  try {
    switch (action) {
      case 'pris': {
        const amount = parseKr(body['price']);
        const item = typeof body['item'] === 'string' && /^si_[A-Za-z0-9]{8,64}$/.test(body['item']) ? body['item'] : null;
        if (!amount || !item) return fail('Skriv en gyldig ny månedspris i kr., fx 1.500 eller 1499,50.');
        await changePrice(c.env, id, item, amount);
        flash = 'pris';
        break;
      }
      case 'tilbud': {
        const o = parseOffer(body['offer_kind'], body['offer']);
        if ('error' in o) return fail(o.error);
        if (!o.offer) return fail('Skriv rabatten i kr. eller procent.');
        await giveOffer(c.env, id, o.offer, `admin-offer-${crypto.randomUUID()}`);
        flash = 'tilbud';
        break;
      }
      case 'fjern-tilbud':
        await removeOffer(c.env, id);
        flash = 'tilbud-fjernet';
        break;
      case 'opsig':
        await setCancelAtPeriodEnd(c.env, id, true);
        flash = 'opsagt';
        break;
      case 'genoptag':
        await setCancelAtPeriodEnd(c.env, id, false);
        flash = 'genoptaget';
        break;
      default:
        return c.text('Ugyldig anmodning.', 400);
    }
  } catch (err) {
    await logError(c.env.DB, `admin.subscriptions.${action}`, err);
    const msg = err instanceof StripeError ? err.message : 'Ukendt fejl';
    return fail(`Handlingen mislykkedes. Stripe svarede: ${msg}`, 502);
  }
  return c.redirect(`/admin/abonnementer?besked=${flash}#${id}`, 303);
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
