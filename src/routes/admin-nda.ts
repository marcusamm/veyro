// Veyros administration af fortrolighedsaftaler (/admin/nda). Kun e-mails i ADMIN_EMAILS.
// Godkendelse på Veyros vegne kræver desuden rollen i NDA_SIGNERS og en engangskode.
import { Hono, type Context, type MiddlewareHandler } from 'hono';
import type { AppEnv, CustomerRow } from '../env';
import { randomToken } from '../lib/crypto';
import { getCustomerById, rateLimit } from '../lib/db';
import { sendEmail } from '../lib/email';
import { logError } from '../lib/errlog';
import {
  approve,
  approvedVersion,
  canSignForVeyro,
  checkOtp,
  clean,
  completeTask,
  confidentialityEnd,
  createNda,
  createOtp,
  createTemplate,
  currentVersion,
  emptyForm,
  eventStmt,
  getNda,
  getRequest,
  listAll,
  listEvents,
  listOpenTasks,
  listRequestEvents,
  listRequests,
  listTasks,
  listTemplates,
  listVersions,
  markInProgress,
  missingVeyro,
  otpPending,
  parseForm,
  parseSnapshot,
  readForm,
  reopen,
  resolveRequest,
  saveForm,
  sendCheck,
  sendForApproval,
  setCooperation,
  signerEmails,
  STATUS_LABEL,
  terminate,
  validateForm,
  validateResolution,
  validateTemplate,
  veyroInfo,
  viewSnapshot,
  type NdaRow,
  type NdaStatus,
  type Resolution,
  type VersionRow,
} from '../lib/nda';
import {
  deliverAll,
  deliverMail,
  ensureFinalDocument,
  ensureTerminationDocument,
  listFailedMails,
  listMails,
  onActivated,
  onTerminated,
  pdfFilename,
  pdfResponse,
  queueMail,
  renderNdaPdf,
  resendMail,
} from '../lib/nda-docs';
import { getSettings, isTestEnv } from '../lib/poa';
import { isAdmin } from '../lib/session';
import { render } from '../render';
import { adminNdaDetailPage, adminNdaListPage, adminNdaNewPage, adminRequestPage, adminTemplatesPage, ndaTerminatePage } from '../views/nda';
import { errorPage } from '../views/pages';
import { otpMail } from './nda';

const adminNda = new Hono<AppEnv>();
const BASE = '/admin/nda';

const guard: MiddlewareHandler<AppEnv> = async (c, next) => {
  const session = c.get('session');
  if (!session) return c.redirect('/admin/login', 303);
  if (!isAdmin(c.env, session.email)) {
    return render(c, 'Ingen adgang', errorPage('Ingen adgang', 'Du har ikke adgang til denne side.', { href: '/konto', label: 'Til kundepanelet' }), { status: 403 });
  }
  await next();
};
adminNda.use('/nda', guard);
adminNda.use('/nda/*', guard);

const me = (c: Context<AppEnv>) => c.get('session')!.email;
const testLabel = (c: Context<AppEnv>) => (isTestEnv(c.env) ? c.env.TEST_LABEL || 'Testmiljø' : null);
const opts = { nav: 'admin-nda' as const, admin: true };

function num(v: string | undefined): number | null {
  const n = Number.parseInt(v ?? '', 10);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

const notFound = (c: Context<AppEnv>) =>
  render(c, 'Ikke fundet', errorPage('Ikke fundet', 'Aftalen eller anmodningen findes ikke (længere).', { href: BASE, label: 'Til fortrolighedsaftaler' }), {
    ...opts,
    status: 404,
  });

// ---------- Oversigt ----------

adminNda.get('/nda', async (c) => {
  const q = c.req.query('status') ?? '';
  const status = q in STATUS_LABEL ? (q as NdaStatus) : null;
  const [rows, tasks, requests, failed, settings] = await Promise.all([
    listAll(c.env.DB, status),
    listOpenTasks(c.env.DB),
    listRequests(c.env.DB, null),
    listFailedMails(c.env.DB),
    getSettings(c.env.DB),
  ]);
  return render(
    c,
    'Fortrolighedsaftaler',
    adminNdaListPage({
      rows,
      status: status ?? '',
      tasks,
      requests,
      failed,
      missing: missingVeyro(veyroInfo(settings)),
      canSign: canSignForVeyro(c.env, me(c)),
      signersConfigured: signerEmails(c.env).size > 0,
      flashKey: c.req.query('besked'),
    }),
    opts,
  );
});

// ---------- Ny aftale ----------

async function customers(db: D1Database): Promise<CustomerRow[]> {
  const { results } = await db.prepare('SELECT * FROM customers ORDER BY COALESCE(company, name, email) LIMIT 1000').all<CustomerRow>();
  return results;
}

adminNda.get('/nda/ny', async (c) => {
  const cid = num(c.req.query('kunde'));
  return render(c, 'Ny fortrolighedsaftale', adminNdaNewPage({ csrf: c.get('csrf'), customers: await customers(c.env.DB), idem: randomToken(16), customerId: cid ?? undefined }), opts);
});

adminNda.post('/nda/ny', async (c) => {
  const body = await c.req.parseBody();
  const cid = num(typeof body['customer_id'] === 'string' ? body['customer_id'] : undefined);
  const project = clean(body['project'], 2000, true);
  const idem = typeof body['_idem'] === 'string' && body['_idem'].length >= 16 ? body['_idem'] : randomToken(16);
  const customer = cid ? await getCustomerById(c.env.DB, cid) : null;
  if (!customer) return renderNew(c, idem, 'Vælg en kunde.', cid, project);
  if (project.length < 10) return renderNew(c, idem, 'Beskriv projektet med mindst 10 tegn.', cid, project);
  // Kendte oplysninger udfyldes på forhånd; kunden kontrollerer dem
  const form = {
    ...emptyForm(),
    company_name: customer.company ?? '',
    cvr: (customer.cvr ?? '').replace(/\s/g, ''),
    address: customer.address ?? '',
    postal_code: customer.postal_code ?? '',
    city: customer.city ?? '',
    contact_name: customer.name ?? '',
    contact_email: customer.email,
    project,
  };
  const id = await createNda(c.env.DB, { customerId: customer.id, form, idem, by: me(c) });
  return c.redirect(`${BASE}/${id}?besked=oprettet`, 303);
});

async function renderNew(c: Context<AppEnv>, idem: string, error: string, cid: number | null, project: string) {
  return render(
    c,
    'Ny fortrolighedsaftale',
    adminNdaNewPage({ csrf: c.get('csrf'), customers: await customers(c.env.DB), idem, error, customerId: cid ?? undefined, project }),
    { ...opts, status: 400 },
  );
}

// ---------- Skabeloner ----------

adminNda.get('/nda/skabeloner', async (c) => {
  return render(c, 'Skabelon', adminTemplatesPage({ csrf: c.get('csrf'), templates: await listTemplates(c.env.DB), flashKey: c.req.query('besked') }), opts);
});

adminNda.post('/nda/skabeloner', async (c) => {
  const body = await c.req.parseBody();
  const text = typeof body['body'] === 'string' ? body['body'].replace(/\r\n?/g, '\n').slice(0, 60000) : '';
  const footnote = clean(body['footnote'], 2000);
  const note = clean(body['note'], 200);
  const error = validateTemplate(text);
  if (error) {
    return render(c, 'Skabelon', adminTemplatesPage({ csrf: c.get('csrf'), templates: await listTemplates(c.env.DB), error, body: text, footnote, note }), { ...opts, status: 400 });
  }
  await createTemplate(c.env.DB, { body: text, footnote, note, by: me(c) });
  return c.redirect(`${BASE}/skabeloner?besked=skabelon`, 303);
});

// ---------- Anmodninger ----------

adminNda.get('/nda/anmodninger/:rid', async (c) => {
  const req = await getRequest(c.env.DB, num(c.req.param('rid')) ?? 0, null);
  if (!req) return notFound(c);
  return render(c, 'Anmodning', adminRequestPage({ csrf: c.get('csrf'), req, events: await listRequestEvents(c.env.DB, req.id), flashKey: c.req.query('besked') }), opts);
});

adminNda.post('/nda/anmodninger/:rid/start', async (c) => {
  const req = await getRequest(c.env.DB, num(c.req.param('rid')) ?? 0, null);
  if (!req) return notFound(c);
  await markInProgress(c.env.DB, req, me(c), null);
  return c.redirect(`${BASE}/anmodninger/${req.id}?besked=opdateret`, 303);
});

adminNda.post('/nda/anmodninger/:rid', async (c) => {
  const req = await getRequest(c.env.DB, num(c.req.param('rid')) ?? 0, null);
  if (!req) return notFound(c);
  const body = await c.req.parseBody();
  const res: Resolution = {
    outcome: (typeof body['outcome'] === 'string' ? body['outcome'] : '') as Resolution['outcome'],
    resultText: clean(body['result_text'], 3000, true),
    retainedInfo: clean(body['retained_info'], 2000, true),
    retentionReason: clean(body['retention_reason'], 2000, true),
    retainUntil: typeof body['retain_until'] === 'string' ? body['retain_until'] : '',
  };
  const error = validateResolution(res);
  if (error) {
    return render(c, 'Anmodning', adminRequestPage({ csrf: c.get('csrf'), req, events: await listRequestEvents(c.env.DB, req.id), error }), { ...opts, status: 400 });
  }
  const done = await resolveRequest(c.env.DB, req, me(c), res);
  if (done) {
    const to = req.email ?? (await getCustomerById(c.env.DB, req.customer_id))?.email;
    if (to) c.executionCtx.waitUntil(deliverAll(c.env, [await queueMail(c.env.DB, { requestId: req.id, kind: 'request_result', to })]));
  }
  return c.redirect(`${BASE}/anmodninger/${req.id}?besked=opdateret`, 303);
});

// ---------- Aftalens side ----------

async function loadNda(c: Context<AppEnv>): Promise<NdaRow | null> {
  const id = num(c.req.param('id'));
  return id ? getNda(c.env.DB, id) : null;
}

async function detail(
  c: Context<AppEnv>,
  n: NdaRow,
  extra: { errors?: Record<string, string>; form?: ReturnType<typeof parseForm>; error?: string | null; devCode?: string | null; otpSentTo?: string | null; status?: 200 | 400 | 429 | 502; name?: string; title?: string } = {},
) {
  const ver = await currentVersion(c.env.DB, n);
  const [versions, mails, requests, events, tasks, settings, snap, customer] = await Promise.all([
    listVersions(c.env.DB, n.id),
    listMails(c.env.DB, n.id),
    listRequests(c.env.DB, n.customer_id).then((rs) => rs.filter((x) => x.nda_id === n.id)),
    listEvents(c.env.DB, n.id),
    listTasks(c.env.DB, n.id),
    getSettings(c.env.DB),
    viewSnapshot(c.env, n, ver),
    getCustomerById(c.env.DB, n.customer_id),
  ]);
  const shown: VersionRow = n.status === 'active' || n.status === 'terminated' ? ((await approvedVersion(c.env.DB, n.id)) ?? ver) : ver;
  const shownSnap = shown === ver ? snap : (parseSnapshot(shown) ?? snap);
  const check = ver.state === 'draft' ? await sendCheck(c.env, ver) : { blockers: [], errors: {} };
  const email = me(c);
  const otpSentTo =
    extra.otpSentTo !== undefined
      ? extra.otpSentTo
      : ver.state === 'sent' && c.req.query('kode') === 'sendt' && (await otpPending(c.env.DB, ver.id, 'veyro', email))
        ? email
        : null;
  // Navn og titel huskes fra medarbejderens seneste godkendelse
  const last = await c.env.DB.prepare('SELECT veyro_name, veyro_title FROM nda_versions WHERE veyro_email = ? ORDER BY veyro_approved_at DESC LIMIT 1')
    .bind(email)
    .first<{ veyro_name: string; veyro_title: string }>();
  return render(
    c,
    n.number,
    adminNdaDetailPage({
      csrf: c.get('csrf'),
      nda: n,
      ver: shown,
      versions,
      snap: shownSnap,
      form: extra.form ?? parseForm(ver.form_json),
      errors: (extra.errors ?? check.errors ?? {}) as Record<string, string>,
      blockers: check.blockers,
      veyro: veyroInfo(settings),
      mails,
      requests,
      events,
      tasks,
      conf: confidentialityEnd(n),
      customerEmail: customer?.email ?? '–',
      canSign: canSignForVeyro(c.env, email),
      signerEmail: email,
      otpSentTo,
      devCode: extra.devCode,
      error: extra.error,
      flashKey: c.req.query('besked'),
      testLabel: testLabel(c),
      veyroName: extra.name ?? last?.veyro_name ?? '',
      veyroTitle: extra.title ?? last?.veyro_title ?? '',
    }),
    { ...opts, status: extra.status },
  );
}

adminNda.get('/nda/:id{[0-9]+}', async (c) => {
  const n = await loadNda(c);
  return n ? detail(c, n) : notFound(c);
});

adminNda.post('/nda/:id{[0-9]+}', async (c) => {
  const n = await loadNda(c);
  if (!n) return notFound(c);
  const ver = await currentVersion(c.env.DB, n);
  if (ver.state !== 'draft') return c.redirect(`${BASE}/${n.id}?besked=ikke-muligt`, 303);
  const body = await c.req.parseBody();
  const form = readForm(body);
  const errors = validateForm(form, { complete: false });
  if (Object.keys(errors).length) return detail(c, n, { errors: errors as Record<string, string>, form, status: 400 });
  await saveForm(c.env.DB, n, ver, form, me(c));
  if (body['next'] !== 'send') return c.redirect(`${BASE}/${n.id}?besked=opdateret`, 303);
  const res = await sendForApproval(c.env, n, await currentVersion(c.env.DB, n), me(c));
  if (!res.ok) return detail(c, n, { errors: res.errors as Record<string, string>, form, error: res.blockers.join(' '), status: 400 });
  return c.redirect(`${BASE}/${n.id}?besked=sendt`, 303);
});

adminNda.post('/nda/:id{[0-9]+}/ret', async (c) => {
  const n = await loadNda(c);
  if (!n) return notFound(c);
  const res = await reopen(c.env.DB, n, await currentVersion(c.env.DB, n), me(c));
  return c.redirect(`${BASE}/${n.id}?besked=${res === 'new_version' ? 'ny-version' : res ? 'aabnet' : 'ikke-muligt'}`, 303);
});

// ---------- Godkendelse på Veyros vegne ----------

adminNda.post('/nda/:id{[0-9]+}/kode', async (c) => {
  const n = await loadNda(c);
  if (!n) return notFound(c);
  const email = me(c);
  if (!canSignForVeyro(c.env, email)) return detail(c, n, { error: 'Du har ikke rollen til at godkende på Veyros vegne.', status: 400 });
  const ver = await currentVersion(c.env.DB, n);
  if (ver.state !== 'sent' || ver.veyro_approved_at) return c.redirect(`${BASE}/${n.id}`, 303);
  const body = await c.req.parseBody();
  if (body['hash'] !== ver.content_hash) return detail(c, n, { error: 'Aftalen er ændret, siden du åbnede siden. Læs den igen.', status: 400 });
  if (!c.env.RESEND_API_KEY && c.env.DEV_MODE !== '1') return detail(c, n, { error: 'Engangskoder kan ikke sendes, fordi mailintegrationen ikke er sat op.', status: 502 });
  if (!(await rateLimit(c.env.DB, `nda-otp-admin:${email}`, 10, 3600))) return detail(c, n, { error: 'For mange koder. Vent en time.', status: 429 });
  const code = await createOtp(c.env.DB, ver.id, 'veyro', email);
  if (c.env.RESEND_API_KEY) {
    try {
      await sendEmail(c.env, otpMail(email, n.number, code));
    } catch (err) {
      await logError(c.env.DB, 'NDA engangskode (Veyro)', err);
      return detail(c, n, { error: 'Engangskoden kunne ikke sendes. Prøv igen om lidt.', status: 502 });
    }
    await eventStmt(c.env.DB, n.id, email, 'otp_sent').run();
    return c.redirect(`${BASE}/${n.id}?kode=sendt#godkend`, 303);
  }
  await eventStmt(c.env.DB, n.id, email, 'otp_sent', 'Udviklingstilstand: vist på skærmen').run();
  return detail(c, n, { devCode: code, otpSentTo: email });
});

adminNda.post('/nda/:id{[0-9]+}/godkend', async (c) => {
  const n = await loadNda(c);
  if (!n) return notFound(c);
  const email = me(c);
  if (!canSignForVeyro(c.env, email)) return detail(c, n, { error: 'Du har ikke rollen til at godkende på Veyros vegne.', status: 400 });
  const ver = await currentVersion(c.env.DB, n);
  if (ver.state !== 'sent' || ver.veyro_approved_at) return c.redirect(`${BASE}/${n.id}`, 303);
  const body = await c.req.parseBody();
  const name = clean(body['name'], 120);
  const title = clean(body['title'], 120);
  const fail = (error: string) => detail(c, n, { error, otpSentTo: email, status: 400, name, title });
  if (body['hash'] !== ver.content_hash) return detail(c, n, { error: 'Aftalen er ændret, siden du åbnede siden.', status: 400 });
  if (!name || !title) return fail('Skriv dit navn og din titel.');
  if (body['confirm1'] !== '1' || body['confirm2'] !== '1') return fail('Markér begge bekræftelser.');
  const otp = await checkOtp(c.env.DB, ver.id, 'veyro', email, typeof body['code'] === 'string' ? body['code'].trim() : '');
  if (otp === 'missing' || otp === 'expired') return detail(c, n, { error: 'Engangskoden er udløbet. Send en ny kode.', otpSentTo: null, status: 400 });
  if (otp === 'wrong') {
    await eventStmt(c.env.DB, n.id, email, 'otp_failed').run();
    return fail('Engangskoden er forkert.');
  }
  const snap = parseSnapshot(ver)!;
  const res = await approve(c.env.DB, n, ver, 'veyro', { name, title, company: snap.veyro.legal_name, email }, ver.content_hash!);
  if (res.activated) {
    const after = (await getNda(c.env.DB, n.id))!;
    const customer = await getCustomerById(c.env.DB, n.customer_id);
    const ids = await onActivated(c.env, after, snap, ver.customer_email ?? customer?.email ?? snap.customer.contact_email);
    c.executionCtx.waitUntil(deliverAll(c.env, ids));
  }
  return c.redirect(`${BASE}/${n.id}?besked=${res.activated ? 'aktiv' : 'godkendt'}`, 303);
});

// ---------- Dokumenter ----------

adminNda.get('/nda/:id{[0-9]+}/udkast.pdf', async (c) => {
  const n = await loadNda(c);
  if (!n) return notFound(c);
  const ver = await currentVersion(c.env.DB, n);
  const pdf = await renderNdaPdf(await viewSnapshot(c.env, n, ver), ver.state === 'draft' ? null : ver, { final: false, hash: ver.content_hash });
  return pdfResponse(pdf, pdfFilename(n, ver.version, '-UDKAST'), false);
});

adminNda.get('/nda/:id{[0-9]+}/aftale.pdf', async (c) => {
  const n = await loadNda(c);
  if (!n) return notFound(c);
  const doc = await ensureFinalDocument(c.env.DB, n);
  if (!doc) return c.redirect(`${BASE}/${n.id}/udkast.pdf`, 303);
  const v = await approvedVersion(c.env.DB, n.id);
  return pdfResponse(doc.pdf, pdfFilename(n, v?.version ?? n.current_version), false);
});

adminNda.get('/nda/:id{[0-9]+}/ophoer.pdf', async (c) => {
  const n = await loadNda(c);
  if (!n) return notFound(c);
  const doc = await ensureTerminationDocument(c.env.DB, n);
  return doc ? pdfResponse(doc.pdf, pdfFilename(n, n.current_version, '-ophoer'), false) : notFound(c);
});

// ---------- Ophør, samarbejde, opgaver og mails ----------

adminNda.get('/nda/:id{[0-9]+}/ophoer', async (c) => {
  const n = await loadNda(c);
  if (!n) return notFound(c);
  if (n.status !== 'active') return c.redirect(`${BASE}/${n.id}?besked=ikke-muligt`, 303);
  return render(c, 'Afslut aftalen', ndaTerminatePage({ csrf: c.get('csrf'), nda: n, base: BASE }), opts);
});

adminNda.post('/nda/:id{[0-9]+}/ophoer', async (c) => {
  const n = await loadNda(c);
  if (!n) return notFound(c);
  const v = await approvedVersion(c.env.DB, n.id);
  const snap = v ? parseSnapshot(v) : null;
  if (!v || !snap) return c.redirect(`${BASE}/${n.id}?besked=ikke-muligt`, 303);
  const ok = await terminate(c.env.DB, n, 'veyro', me(c), snap.veyro.legal_name);
  if (!ok) return c.redirect(`${BASE}/${n.id}?besked=ikke-muligt`, 303);
  const after = (await getNda(c.env.DB, n.id))!;
  const customer = await getCustomerById(c.env.DB, n.customer_id);
  c.executionCtx.waitUntil(onTerminated(c.env, after, snap, v.customer_email ?? customer?.email ?? snap.customer.contact_email).then((ids) => deliverAll(c.env, ids)));
  return c.redirect(`${BASE}/${n.id}?besked=ophoert`, 303);
});

adminNda.post('/nda/:id{[0-9]+}/samarbejde', async (c) => {
  const n = await loadNda(c);
  if (!n) return notFound(c);
  const body = await c.req.parseBody();
  const coop = (typeof body['cooperation'] === 'string' ? body['cooperation'] : '') as NdaRow['cooperation'];
  const ended = typeof body['ended_on'] === 'string' && body['ended_on'] ? body['ended_on'] : null;
  const error = await setCooperation(c.env.DB, n, coop, ended, me(c));
  if (error) return detail(c, n, { error, status: 400 });
  return c.redirect(`${BASE}/${n.id}?besked=opdateret#coop-h`, 303);
});

adminNda.post('/nda/:id{[0-9]+}/opgaver/:tid', async (c) => {
  const n = await loadNda(c);
  if (!n) return notFound(c);
  await completeTask(c.env.DB, n.id, num(c.req.param('tid')) ?? 0, me(c));
  return c.redirect(`${BASE}/${n.id}?besked=opdateret`, 303);
});

adminNda.post('/nda/:id{[0-9]+}/mails/:mid', async (c) => {
  const n = await loadNda(c);
  if (!n) return notFound(c);
  const mid = num(c.req.param('mid')) ?? 0;
  const owned = await c.env.DB.prepare('SELECT id, status FROM nda_mails WHERE id = ? AND nda_id = ?').bind(mid, n.id).first<{ id: number; status: string }>();
  if (!owned) return notFound(c);
  // Gensendelse af en allerede leveret mail: en ny afsendelse af samme indhold (registreres som ny række)
  let status: string;
  if (owned.status === 'sent') {
    const row = await c.env.DB.prepare('SELECT kind, recipient FROM nda_mails WHERE id = ?').bind(mid).first<{ kind: string; recipient: string }>();
    const id = await queueMail(c.env.DB, { ndaId: n.id, kind: row!.kind as never, to: row!.recipient });
    status = await deliverMail(c.env, id);
  } else {
    status = await resendMail(c.env, mid);
  }
  await eventStmt(c.env.DB, n.id, me(c), 'mail_resend', status).run();
  return c.redirect(`${BASE}/${n.id}?besked=${status === 'sent' ? 'mail-sendt' : 'mail-fejl'}#mails-h`, 303);
});

export default adminNda;
