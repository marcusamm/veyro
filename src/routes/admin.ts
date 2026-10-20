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
  sendWelcomeMail,
  setCancelAtPeriodEnd,
  validateSubDraft,
} from '../lib/admin-subscriptions';
import { parseKr } from '../lib/invoices';
import { createLoginToken, isAdmin } from '../lib/session';
import { getCustomerByEmail, getCustomerById, upsertSubscription } from '../lib/db';
import { offerEmail, priceChangeEmail } from '../lib/email';
import { formatDate, formatKr } from '../lib/format';
import { getPlan } from '../lib/plans';
import { stripeRequest, type StripeSubscription } from '../lib/stripe';
import {
  changeSubscriptionPrice,
  createOffer,
  ensureStripeCustomer,
  existingBilling,
  extendOffer,
  getOffer,
  hasExisting,
  INTERVAL_LABEL,
  listOffers,
  listPayments,
  listPriceChanges,
  markPriceChangeNotified,
  offerLink,
  readOfferForm,
  renewalDates,
  validateOffer,
  withdrawOffer,
  type ExistingBilling,
  type OfferForm,
} from '../lib/offers';
import { adminCustomerPage, adminOfferDetailPage, adminOffersPage, offerSummaryLines, type CustomerSubView } from '../views/offers';
import { render } from '../render';
import { adminCustomersPage, adminInvoicesPage, adminLoginPage, adminOverviewPage, adminRequestsPage, adminSubscriptionsPage } from '../views/admin';
import { errorPage } from '../views/pages';
import { REQUEST_STATUSES } from '../views/status';
import { getLead, updateLead, type LeadRow } from '../site/leads';
import { offerFormFromLead } from './admin-site';

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
    c.executionCtx.waitUntil(sendWelcomeMail(c.env, sub.id).catch((err) => logError(c.env.DB, 'admin.subscriptions.welcome', err)));
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
      case 'kortlink':
        await sendWelcomeMail(c.env, id);
        flash = 'kortlink';
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

// ---- Tilbud med individuel pris og personligt betalingslink ----

async function offersView(
  c: Context<AppEnv>,
  extra: { form?: OfferForm | null; error?: string | null; errorField?: string | null; existing?: ExistingBilling | null; status?: 400 | 409 | 502; formKey?: string; lead?: LeadRow | null } = {},
) {
  const offers = await listOffers(c.env.DB);
  const lead = extra.lead ?? null;
  return render(
    c,
    'Tilbud',
    adminOffersPage({
      csrf: c.get('csrf'),
      formKey: extra.formKey ?? crypto.randomUUID(),
      offers,
      form: extra.form ?? null,
      error: extra.error ?? null,
      errorField: extra.errorField ?? null,
      existing: extra.existing ?? null,
      flash: extra.form || extra.error ? null : (c.req.query('besked') ?? null),
      lead: lead ? { id: lead.id, label: `forespørgsel #${lead.id} fra ${lead.name || lead.email}` } : null,
    }),
    { nav: 'admin-tilbud', admin: true, status: extra.status },
  );
}

admin.get('/tilbud', async (c) => {
  // ?forespoergsel=<id>: udfyld tilbuddet ud fra en forespørgsel fra hjemmesiden
  const leadId = Number(c.req.query('forespoergsel'));
  const lead = Number.isSafeInteger(leadId) && leadId > 0 ? await getLead(c.env.DB, leadId) : null;
  return offersView(c, lead ? { form: offerFormFromLead(lead), lead } : {});
});

async function leadFromBody(c: Context<AppEnv>, body: Record<string, unknown>): Promise<LeadRow | null> {
  const id = Number(body['lead']);
  return Number.isSafeInteger(id) && id > 0 ? getLead(c.env.DB, id) : null;
}

admin.post('/tilbud', async (c) => {
  const body = await c.req.parseBody();
  const form = readOfferForm(body);
  const key = typeof body['key'] === 'string' && /^[0-9a-f-]{36}$/.test(body['key']) ? body['key'] : crypto.randomUUID();
  const lead = await leadFromBody(c, body);
  const v = validateOffer(form);
  if ('error' in v) return offersView(c, { form, error: v.error, errorField: v.field, status: 400, formKey: key, lead });
  try {
    // Undgå dobbelt fakturering: vis kundens eksisterende abonnementer, fakturaer og tilbud, før der laves et nyt link.
    const found = await stripeRequest<{ data: Array<{ id: string }> }>(c.env, 'GET', '/v1/customers', { email: v.draft.email, limit: 1 });
    const existing = await existingBilling(c.env, v.draft.email, found.data?.[0]?.id ?? null);
    if (hasExisting(existing) && !form.confirm_existing) {
      return offersView(c, { form, existing, error: 'Kunden har allerede et abonnement, en faktura eller et tilbud. Tjek listen, og bekræft nederst.', status: 409, formKey: key, lead });
    }
    const customerId = await ensureStripeCustomer(c.env, v.draft, `admin-offer-${key}`);
    const offer = await createOffer(c.env, v.draft, { key, createdBy: c.get('session')!.email, stripeCustomerId: customerId });
    if (lead) await updateLead(c.env.DB, lead.id, { offer_id: offer.id, status: 'tilbud' });
    return c.redirect(`/admin/tilbud/${offer.id}?besked=oprettet`, 303);
  } catch (err) {
    await logError(c.env.DB, 'admin.offers.create', err);
    const detail = err instanceof StripeError ? ` Stripe svarede: ${err.message}` : '';
    return offersView(c, { form, error: `Tilbuddet kunne ikke oprettes.${detail}`, status: 502, formKey: key, lead });
  }
});

async function offerDetail(c: Context<AppEnv>, id: number, extra: { error?: string; status?: 400 | 502 } = {}) {
  const offer = await getOffer(c.env.DB, id);
  if (!offer) return render(c, 'Findes ikke', errorPage('Tilbuddet findes ikke', '', { href: '/admin/tilbud', label: 'Til tilbud' }), { status: 404, admin: true });
  const customer = await getCustomerByEmail(c.env.DB, offer.email);
  return render(
    c,
    `Tilbud: ${offer.service}`,
    adminOfferDetailPage({
      csrf: c.get('csrf'),
      offer,
      link: offerLink(c.env, offer),
      customerId: customer?.id ?? null,
      flash: extra.error ? null : (c.req.query('besked') ?? null),
      error: extra.error ?? null,
    }),
    { nav: 'admin-tilbud', admin: true, status: extra.status },
  );
}

const idParam = (raw: string) => {
  const n = Number.parseInt(raw, 10);
  return Number.isSafeInteger(n) && n > 0 && String(n) === raw ? n : null;
};

admin.get('/tilbud/:id', (c) => {
  const id = idParam(c.req.param('id'));
  if (!id) return c.text('Ugyldig anmodning.', 400);
  return offerDetail(c, id);
});

admin.post('/tilbud/:id/:action', async (c) => {
  const id = idParam(c.req.param('id'));
  const offer = id ? await getOffer(c.env.DB, id) : null;
  if (!offer) return c.text('Ugyldig anmodning.', 400);
  const action = c.req.param('action');
  try {
    if (action === 'send') {
      if (offer.status !== 'open' || offer.valid_until < Math.floor(Date.now() / 1000)) return offerDetail(c, offer.id, { error: 'Kun åbne tilbud kan sendes.', status: 400 });
      const ok = await sendEmail(c.env, {
        to: offer.email,
        replyTo: 'kontakt@veyro.dk',
        ...offerEmail({ name: offer.name, service: offer.service, lines: offerSummaryLines(offer), link: offerLink(c.env, offer), validUntil: formatDate(offer.valid_until) }),
      });
      if (!ok) return offerDetail(c, offer.id, { error: 'Mailen kunne ikke sendes (RESEND_API_KEY mangler). Kopiér linket i stedet.', status: 502 });
      await c.env.DB.prepare('UPDATE offers SET emailed_at = ?, updated_at = ? WHERE id = ?').bind(Math.floor(Date.now() / 1000), Math.floor(Date.now() / 1000), offer.id).run();
      return c.redirect(`/admin/tilbud/${offer.id}?besked=sendt`, 303);
    }
    if (action === 'tilbagetraek') {
      await withdrawOffer(c.env, offer);
      return c.redirect(`/admin/tilbud/${offer.id}?besked=trukket-tilbage`, 303);
    }
    if (action === 'forlaeng') {
      await extendOffer(c.env, offer);
      return c.redirect(`/admin/tilbud/${offer.id}?besked=forlaenget`, 303);
    }
  } catch (err) {
    await logError(c.env.DB, `admin.offers.${action}`, err);
    const msg = err instanceof StripeError ? err.message : 'Ukendt fejl';
    return offerDetail(c, offer.id, { error: `Handlingen mislykkedes: ${msg}`, status: 502 });
  }
  return c.text('Ugyldig anmodning.', 400);
});

// ---- Én kunde: fakturering, abonnementer, betalinger ----

async function customerView(c: Context<AppEnv>, customerId: number, extra: { error?: string; status?: 400 | 502 } = {}) {
  const customer = await getCustomerById(c.env.DB, customerId);
  if (!customer) return render(c, 'Findes ikke', errorPage('Kunden findes ikke', '', { href: '/admin/kunder', label: 'Til kunder' }), { status: 404, admin: true });
  const { results: subs } = await c.env.DB.prepare('SELECT * FROM subscriptions WHERE customer_id = ? ORDER BY COALESCE(started_at, 0) DESC').bind(customer.id).all<any>();
  const offers = await listOffers(c.env.DB, customer.email);
  const views: CustomerSubView[] = subs.map((sub) => {
    const offer = offers.find((o) => o.subscription_id === sub.id || (sub.offer_id && o.id === sub.offer_id));
    const interval = sub.interval === 'year' ? 'year' : 'month';
    return {
      sub,
      service: offer?.service ?? getPlan(sub.plan)?.name ?? 'Abonnement',
      renewals: sub.current_period_end ? renewalDates(sub.current_period_end, interval, 6) : [],
    };
  });
  const [payments, priceChanges] = await Promise.all([
    customer.stripe_customer_id ? listPayments(c.env.DB, customer.stripe_customer_id) : Promise.resolve([]),
    listPriceChanges(c.env.DB, subs.map((s) => s.id)),
  ]);
  return render(
    c,
    customer.company ?? customer.name ?? customer.email,
    adminCustomerPage({ csrf: c.get('csrf'), customer, subs: views, offers, payments, priceChanges, flash: extra.error ? null : (c.req.query('besked') ?? null), error: extra.error ?? null }),
    { nav: 'admin-kunder', admin: true, status: extra.status },
  );
}

admin.get('/kunder/:id', (c) => {
  const id = idParam(c.req.param('id'));
  if (!id) return c.text('Ugyldig anmodning.', 400);
  return customerView(c, id);
});

admin.post('/kunder/:id/abonnement/:sub/:action', async (c) => {
  const id = idParam(c.req.param('id'));
  const subId = c.req.param('sub');
  const action = c.req.param('action');
  if (!id || !isSubscriptionId(subId)) return c.text('Ugyldig anmodning.', 400);
  const customer = await getCustomerById(c.env.DB, id);
  const owned = customer && (await c.env.DB.prepare('SELECT 1 FROM subscriptions WHERE id = ? AND customer_id = ?').bind(subId, customer.id).first());
  if (!customer || !owned) return c.text('Ugyldig anmodning.', 400);
  const body = await c.req.parseBody();
  let flash: string;
  try {
    if (action === 'pris') {
      const amount = parseKr(body['price']);
      if (!amount) return customerView(c, id, { error: 'Skriv en gyldig ny pris i kr. ekskl. moms, fx 1.500 eller 1499,50.', status: 400 });
      const eff = body['effective'];
      const effectiveAt = eff === 'next' || eff === undefined ? null : Number.parseInt(String(eff), 10);
      if (effectiveAt !== null && !Number.isSafeInteger(effectiveAt)) return customerView(c, id, { error: 'Vælg en gyldig dato.', status: 400 });
      const key = typeof body['key'] === 'string' && /^[0-9a-f-]{36}$/.test(body['key']) ? body['key'] : crypto.randomUUID();
      const res = await changeSubscriptionPrice(c.env, subId, amount, effectiveAt, { key: `price-change-${key}`, createdBy: c.get('session')!.email });
      const offer = await c.env.DB.prepare('SELECT service FROM offers WHERE subscription_id = ?').bind(subId).first<{ service: string }>();
      const per = INTERVAL_LABEL[res.interval].per;
      let mailed = false;
      try {
        mailed = await sendEmail(c.env, {
          to: customer.email,
          replyTo: 'kontakt@veyro.dk',
          ...priceChangeEmail({
            name: customer.name ?? '',
            service: offer?.service ?? 'abonnement hos Veyro',
            oldPrice: `${formatKr(res.oldAmount)} ekskl. moms ${per}`,
            newPrice: `${formatKr(amount)} ekskl. moms ${per}`,
            effective: formatDate(res.effectiveAt),
          }),
        });
      } catch (err) {
        await logError(c.env.DB, 'admin.price-change.mail', err);
      }
      if (mailed) await markPriceChangeNotified(c.env.DB, res.changeId);
      flash = mailed ? 'pris' : 'pris-uden-mail';
    } else if (action === 'opsig' || action === 'genoptag') {
      await setCancelAtPeriodEnd(c.env, subId, action === 'opsig');
      flash = action === 'opsig' ? 'opsagt' : 'genoptaget';
    } else return c.text('Ugyldig anmodning.', 400);
    // Opdatér med det samme (webhooken gør det også).
    const fresh = await stripeRequest<StripeSubscription>(c.env, 'GET', `/v1/subscriptions/${subId}`);
    await upsertSubscription(c.env, customer.id, fresh);
  } catch (err) {
    await logError(c.env.DB, `admin.customer.${action}`, err);
    const msg = err instanceof StripeError ? err.message : 'Ukendt fejl';
    return customerView(c, id, { error: `Handlingen mislykkedes. Stripe svarede: ${msg}`, status: 502 });
  }
  return c.redirect(`/admin/kunder/${id}?besked=${flash}#${subId}`, 303);
});


export default admin;
