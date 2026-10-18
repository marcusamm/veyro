import { Hono, type Context } from 'hono';
import type { AppEnv } from '../env';
import { listAllRequests, listCustomers, updateRequestStatus } from '../lib/db';
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
import { isAdmin } from '../lib/session';
import { render } from '../render';
import { adminCustomersPage, adminInvoicesPage, adminOverviewPage, adminRequestsPage } from '../views/admin';
import { errorPage } from '../views/pages';
import { REQUEST_STATUSES } from '../views/status';

const admin = new Hono<AppEnv>();

// Kun e-mails i ADMIN_EMAILS (samme magic-link-login som kunder)
admin.use('*', async (c, next) => {
  const session = c.get('session');
  if (!session) return c.redirect('/login', 303);
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
