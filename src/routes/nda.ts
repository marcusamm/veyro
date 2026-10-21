// Kundens fortrolighedsaftaler (/konto/nda). Kræver login og en kundekonto (sat af account.ts).
// Kunden ser kun sin egen virksomheds aftaler: alle opslag sker med kundens id.
import { Hono, type Context } from 'hono';
import type { AppEnv, CustomerRow } from '../env';
import { randomToken } from '../lib/crypto';
import { rateLimit } from '../lib/db';
import { sendEmail } from '../lib/email';
import { logError } from '../lib/errlog';
import {
  approve,
  canDeleteDirectly,
  checkOtp,
  confidentialityEnd,
  createOtp,
  createRequest,
  currentVersion,
  deleteDraft,
  eventStmt,
  getNdaForCustomer,
  getRequest,
  listEvents,
  listForCustomer,
  listRequestEvents,
  listRequests,
  listVersions,
  openDeletionRequest,
  otpPending,
  parseForm,
  parseSnapshot,
  readForm,
  reopen,
  saveForm,
  sendCheck,
  sendForApproval,
  terminate,
  validateForm,
  veyroInfo,
  viewSnapshot,
  approvedVersion,
  clean,
  type NdaRow,
  type VersionRow,
} from '../lib/nda';
import {
  deliverAll,
  ensureFinalDocument,
  ensureTerminationDocument,
  listMails,
  onActivated,
  onTerminated,
  pdfFilename,
  pdfResponse,
  queueMail,
  renderNdaPdf,
} from '../lib/nda-docs';
import { getSettings, isTestEnv } from '../lib/poa';
import { render } from '../render';
import { errorPage } from '../views/pages';
import { ndaDeletePage, ndaDetailPage, ndaListPage, ndaRequestPage, ndaReturnInfoPage, ndaTerminatePage } from '../views/nda';

type Vars = AppEnv & { Variables: AppEnv['Variables'] & { customer: CustomerRow } };
const nda = new Hono<Vars>();
const r = (c: Context<Vars>) => c as unknown as Context<AppEnv>;
const BASE = '/konto/nda';

const testLabel = (c: Context<Vars>) => (isTestEnv(c.env) ? c.env.TEST_LABEL || 'Testmiljø' : null);
const notFound = (c: Context<Vars>) =>
  render(r(c), 'Ikke fundet', errorPage('Aftalen findes ikke', 'Aftalen findes ikke, eller du har ikke adgang til den.', { href: BASE, label: 'Til fortrolighedsaftaler' }), {
    status: 404,
    isCustomer: true,
  });

function idParam(c: Context<Vars>): number | null {
  const id = Number.parseInt(c.req.param('id') ?? '', 10);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

async function load(c: Context<Vars>): Promise<NdaRow | null> {
  const id = idParam(c);
  return id ? getNdaForCustomer(c.env.DB, id, c.get('customer').id) : null;
}

// ---------- Oversigt ----------

nda.get('/', async (c) => {
  const customer = c.get('customer');
  const [rows, requests] = await Promise.all([listForCustomer(c.env.DB, customer.id), listRequests(c.env.DB, customer.id)]);
  return render(r(c), 'Fortrolighedsaftaler', ndaListPage({ rows, requests, flashKey: c.req.query('besked'), testLabel: testLabel(c) }), {
    nav: 'aftaler',
    isCustomer: true,
  });
});

nda.get('/anmodninger/:rid', async (c) => {
  const rid = Number.parseInt(c.req.param('rid'), 10);
  const req = Number.isSafeInteger(rid) ? await getRequest(c.env.DB, rid, c.get('customer').id) : null;
  if (!req) return notFound(c);
  return render(r(c), 'Anmodning', ndaRequestPage({ req, events: await listRequestEvents(c.env.DB, req.id), flashKey: c.req.query('besked') }), {
    nav: 'aftaler',
    isCustomer: true,
  });
});

// ---------- Aftalens side ----------

async function detail(
  c: Context<Vars>,
  n: NdaRow,
  extra: { errors?: Record<string, string>; formOverride?: ReturnType<typeof parseForm>; error?: string | null; devCode?: string | null; otpSentTo?: string | null; status?: 200 | 400 | 429 | 502 } = {},
) {
  const customer = c.get('customer');
  const ver = await currentVersion(c.env.DB, n);
  const [versions, mails, requests, events, settings, canDelete, snap] = await Promise.all([
    listVersions(c.env.DB, n.id),
    listMails(c.env.DB, n.id),
    listRequests(c.env.DB, customer.id).then((rs) => rs.filter((x) => x.nda_id === n.id)),
    listEvents(c.env.DB, n.id),
    getSettings(c.env.DB),
    canDeleteDirectly(c.env.DB, n),
    viewSnapshot(c.env, n, ver),
  ]);
  // Den gældende version: ved aktive/ophørte aftaler den godkendte, ellers den aktuelle
  const shown: VersionRow = n.status === 'active' || n.status === 'terminated' ? ((await approvedVersion(c.env.DB, n.id)) ?? ver) : ver;
  const shownSnap = shown === ver ? snap : (parseSnapshot(shown) ?? snap);
  const form = extra.formOverride ?? parseForm(ver.form_json);
  const check = ver.state === 'draft' ? await sendCheck(c.env, ver) : { blockers: [], errors: {} };
  const otpSentTo =
    extra.otpSentTo !== undefined
      ? extra.otpSentTo
      : ver.state === 'sent' && c.req.query('kode') === 'sendt' && (await otpPending(c.env.DB, ver.id, 'kunde', customer.email))
        ? customer.email
        : null;
  return render(
    r(c),
    `Fortrolighedsaftale ${n.number}`,
    ndaDetailPage({
      csrf: c.get('csrf'),
      nda: n,
      ver: shown,
      versions,
      snap: shownSnap,
      form,
      errors: (extra.errors ?? {}) as Record<string, string>,
      blockers: check.blockers,
      veyro: veyroInfo(settings),
      mails,
      requests,
      events,
      conf: confidentialityEnd(n),
      canDelete,
      otpSentTo,
      devCode: extra.devCode,
      error: extra.error,
      flashKey: c.req.query('besked'),
      testLabel: testLabel(c),
    }),
    { nav: 'aftaler', isCustomer: true, status: extra.status },
  );
}

nda.get('/:id{[0-9]+}', async (c) => {
  const n = await load(c);
  if (!n) return notFound(c);
  return detail(c, n);
});

// Gem kladde / gem og lås til godkendelse
nda.post('/:id{[0-9]+}', async (c) => {
  const n = await load(c);
  if (!n) return notFound(c);
  const ver = await currentVersion(c.env.DB, n);
  if (ver.state !== 'draft') return c.redirect(`${BASE}/${n.id}?besked=ikke-muligt`, 303);
  const body = await c.req.parseBody();
  const form = readForm(body);
  const formatErrors = validateForm(form, { complete: false });
  if (Object.keys(formatErrors).length) return detail(c, n, { errors: formatErrors as Record<string, string>, formOverride: form, status: 400 });
  await saveForm(c.env.DB, n, ver, form, 'kunde');
  if (body['next'] !== 'send') return c.redirect(`${BASE}/${n.id}?besked=gemt`, 303);
  const fresh = await currentVersion(c.env.DB, n);
  const res = await sendForApproval(c.env, n, fresh, 'kunde');
  if (!res.ok) return detail(c, n, { errors: res.errors as Record<string, string>, formOverride: form, status: 400 });
  return c.redirect(`${BASE}/${n.id}?besked=sendt#godkend`, 303);
});

// Ret oplysninger efter afsendelse (åbner kladden igen eller opretter en ny version)
nda.post('/:id{[0-9]+}/ret', async (c) => {
  const n = await load(c);
  if (!n) return notFound(c);
  const res = await reopen(c.env.DB, n, await currentVersion(c.env.DB, n), 'kunde');
  return c.redirect(`${BASE}/${n.id}?besked=${res === 'new_version' ? 'ny-version' : res ? 'aabnet' : 'ikke-muligt'}`, 303);
});

// ---------- Engangskode og godkendelse ----------

nda.post('/:id{[0-9]+}/kode', async (c) => {
  const n = await load(c);
  if (!n) return notFound(c);
  const customer = c.get('customer');
  const ver = await currentVersion(c.env.DB, n);
  if (ver.state !== 'sent' || ver.customer_approved_at) return c.redirect(`${BASE}/${n.id}`, 303);
  const body = await c.req.parseBody();
  if (body['hash'] !== ver.content_hash) return detail(c, n, { error: 'Aftalen er ændret, siden du åbnede siden. Læs den igen, før du godkender.', status: 400 });
  if (!c.env.RESEND_API_KEY && c.env.DEV_MODE !== '1') {
    return detail(c, n, { error: 'Engangskoder kan ikke sendes, fordi mailintegrationen ikke er sat op. Kontakt Veyro.', status: 502 });
  }
  if (!(await rateLimit(c.env.DB, `nda-otp:${customer.id}`, 6, 3600))) return detail(c, n, { error: 'Du har bedt om mange koder. Vent en time, og prøv igen.', status: 429 });
  const code = await createOtp(c.env.DB, ver.id, 'kunde', customer.email);
  if (c.env.RESEND_API_KEY) {
    try {
      await sendEmail(c.env, otpMail(customer.email, n.number, code));
    } catch (err) {
      await c.env.DB.prepare("DELETE FROM nda_otps WHERE version_id = ? AND party = 'kunde'").bind(ver.id).run();
      await logError(c.env.DB, 'NDA engangskode', err);
      return detail(c, n, { error: 'Vi kunne ikke sende engangskoden lige nu. Prøv igen om lidt.', status: 502 });
    }
    await eventStmt(c.env.DB, n.id, 'kunde', 'otp_sent').run();
    return c.redirect(`${BASE}/${n.id}?kode=sendt#godkend`, 303);
  }
  // Kun udvikling (DEV_MODE=1 uden mailnøgle): koden vises på skærmen
  await eventStmt(c.env.DB, n.id, 'kunde', 'otp_sent', 'Udviklingstilstand: vist på skærmen').run();
  return detail(c, n, { devCode: code, otpSentTo: customer.email });
});

export function otpMail(to: string, number: string, code: string) {
  return {
    to,
    subject: `Engangskode til godkendelse af fortrolighedsaftale ${number}`,
    text: `Hej\n\nDin engangskode til at godkende fortrolighedsaftale ${number} er:\n\n${code}\n\nKoden virker i 10 minutter. Har du ikke bedt om koden, så kontakt Veyro på kontakt@veyro.dk.\n\nVeyro`,
    html: `<p>Hej</p><p>Din engangskode til at godkende fortrolighedsaftale ${number} er:</p><p style="font-size:28px;font-weight:700;letter-spacing:.2em">${code}</p><p style="color:#55534D;font-size:14px">Koden virker i 10 minutter. Har du ikke bedt om koden, så kontakt Veyro på kontakt@veyro.dk.</p>`,
  };
}

nda.post('/:id{[0-9]+}/godkend', async (c) => {
  const n = await load(c);
  if (!n) return notFound(c);
  const customer = c.get('customer');
  const ver = await currentVersion(c.env.DB, n);
  if (ver.state !== 'sent' || ver.customer_approved_at) return c.redirect(`${BASE}/${n.id}`, 303);
  const body = await c.req.parseBody();
  const fail = (error: string) => detail(c, n, { error, otpSentTo: customer.email, status: 400 });
  if (body['hash'] !== ver.content_hash) return detail(c, n, { error: 'Aftalen er ændret, siden du åbnede siden. Læs den igen, før du godkender.', status: 400 });
  if (body['confirm1'] !== '1' || body['confirm2'] !== '1') return fail('Du skal markere begge bekræftelser for at godkende.');
  const code = typeof body['code'] === 'string' ? body['code'].trim() : '';
  const otp = await checkOtp(c.env.DB, ver.id, 'kunde', customer.email, code);
  if (otp === 'missing' || otp === 'expired') return detail(c, n, { error: 'Engangskoden er udløbet eller brugt for mange gange. Send en ny kode.', otpSentTo: null, status: 400 });
  if (otp === 'wrong') {
    await eventStmt(c.env.DB, n.id, 'kunde', 'otp_failed').run();
    return fail('Engangskoden er forkert.');
  }
  const snap = parseSnapshot(ver)!;
  const res = await approve(c.env.DB, n, ver, 'kunde', {
    name: snap.customer_approver.name,
    title: snap.customer_approver.title,
    company: snap.customer.company_name,
    email: customer.email,
  }, ver.content_hash!);
  if (!res.recorded) return c.redirect(`${BASE}/${n.id}`, 303);
  const after = (await getNdaForCustomer(c.env.DB, n.id, customer.id))!;
  const ids: number[] = [];
  for (const to of new Set([snap.customer.contact_email, customer.email])) ids.push(await queueMail(c.env.DB, { ndaId: n.id, kind: 'customer_receipt', to }));
  if (res.activated) ids.push(...(await onActivated(c.env, after, snap, customer.email)));
  else ids.push(await queueMail(c.env.DB, { ndaId: n.id, kind: 'staff_customer_approved', to: c.env.NOTIFY_EMAIL || 'kontakt@veyro.dk' }));
  c.executionCtx.waitUntil(deliverAll(c.env, ids));
  return c.redirect(`${BASE}/${n.id}?besked=${res.activated ? 'aktiv' : 'godkendt'}`, 303);
});

// ---------- Dokumenter ----------

nda.get('/:id{[0-9]+}/udkast.pdf', async (c) => {
  const n = await load(c);
  if (!n) return notFound(c);
  const ver = await currentVersion(c.env.DB, n);
  const snap = await viewSnapshot(c.env, n, ver);
  const pdf = await renderNdaPdf(snap, ver.state === 'draft' ? null : ver, { final: false, hash: ver.content_hash });
  return pdfResponse(pdf, pdfFilename(n, ver.version, '-UDKAST'), false);
});

nda.get('/:id{[0-9]+}/aftale.pdf', async (c) => {
  const n = await load(c);
  if (!n) return notFound(c);
  const doc = n.status === 'active' || n.status === 'terminated' ? await ensureFinalDocument(c.env.DB, n) : null;
  if (!doc) return c.redirect(`${BASE}/${n.id}/udkast.pdf`, 303);
  const v = await approvedVersion(c.env.DB, n.id);
  return pdfResponse(doc.pdf, pdfFilename(n, v?.version ?? n.current_version), c.req.query('vis') === '1');
});

nda.get('/:id{[0-9]+}/ophoer.pdf', async (c) => {
  const n = await load(c);
  if (!n) return notFound(c);
  const doc = await ensureTerminationDocument(c.env.DB, n);
  if (!doc) return notFound(c);
  return pdfResponse(doc.pdf, pdfFilename(n, n.current_version, '-ophoer'), false);
});

// ---------- Ophør ----------

nda.get('/:id{[0-9]+}/ophoer', async (c) => {
  const n = await load(c);
  if (!n) return notFound(c);
  if (n.status !== 'active') return c.redirect(`${BASE}/${n.id}?besked=ikke-muligt`, 303);
  return render(r(c), 'Afslut aftalen', ndaTerminatePage({ csrf: c.get('csrf'), nda: n }), { nav: 'aftaler', isCustomer: true });
});

nda.post('/:id{[0-9]+}/ophoer', async (c) => {
  const n = await load(c);
  if (!n) return notFound(c);
  const customer = c.get('customer');
  const v = await approvedVersion(c.env.DB, n.id);
  const snap = v ? parseSnapshot(v) : null;
  if (!v || !snap) return c.redirect(`${BASE}/${n.id}?besked=ikke-muligt`, 303);
  const ok = await terminate(c.env.DB, n, 'kunde', customer.email, snap.customer.company_name);
  if (!ok) return c.redirect(`${BASE}/${n.id}?besked=ikke-muligt`, 303);
  const after = (await getNdaForCustomer(c.env.DB, n.id, customer.id))!;
  c.executionCtx.waitUntil(onTerminated(c.env, after, snap, customer.email).then((ids) => deliverAll(c.env, ids)));
  return c.redirect(`${BASE}/${n.id}?besked=ophoert`, 303);
});

// ---------- Sletning ----------

nda.get('/:id{[0-9]+}/slet', async (c) => {
  const n = await load(c);
  if (!n) return notFound(c);
  const direct = await canDeleteDirectly(c.env.DB, n);
  if (!direct && (n.deletion_status !== 'none' || (await openDeletionRequest(c.env.DB, n.id)))) return c.redirect(`${BASE}/${n.id}?besked=ikke-muligt`, 303);
  return render(r(c), 'Sletning', ndaDeletePage({ csrf: c.get('csrf'), nda: n, direct, idem: randomToken(16) }), { nav: 'aftaler', isCustomer: true });
});

nda.post('/:id{[0-9]+}/slet', async (c) => {
  const n = await load(c);
  if (!n) return notFound(c);
  const customer = c.get('customer');
  if (await canDeleteDirectly(c.env.DB, n)) {
    await deleteDraft(c.env.DB, n);
    return c.redirect(`${BASE}?besked=kladde-slettet`, 303);
  }
  const body = await c.req.parseBody();
  const idem = typeof body['_idem'] === 'string' && body['_idem'].length >= 16 ? body['_idem'] : randomToken(16);
  const open = await openDeletionRequest(c.env.DB, n.id);
  if (open) return c.redirect(`${BASE}/anmodninger/${open.id}`, 303);
  const req = await createRequest(c.env.DB, { nda: n, kind: 'delete_document', choice: null, description: null, by: customer.email, idem });
  if (req.created) await queueRequestMails(c, req.id, customer.email);
  return c.redirect(`${BASE}/anmodninger/${req.id}?besked=anmodning-oprettet`, 303);
});

async function queueRequestMails(c: Context<Vars>, requestId: number, customerEmail: string) {
  const ids = [
    await queueMail(c.env.DB, { requestId, kind: 'request_received', to: customerEmail }),
    await queueMail(c.env.DB, { requestId, kind: 'staff_request', to: c.env.NOTIFY_EMAIL || 'kontakt@veyro.dk' }),
  ];
  c.executionCtx.waitUntil(deliverAll(c.env, ids));
}

// ---------- Tilbagelevering eller sletning af delte oplysninger ----------

nda.get('/:id{[0-9]+}/oplysninger', async (c) => {
  const n = await load(c);
  if (!n) return notFound(c);
  if (n.status !== 'active' && n.status !== 'terminated') return c.redirect(`${BASE}/${n.id}?besked=ikke-muligt`, 303);
  return render(r(c), 'Delte oplysninger', ndaReturnInfoPage({ csrf: c.get('csrf'), nda: n, idem: randomToken(16) }), { nav: 'aftaler', isCustomer: true });
});

nda.post('/:id{[0-9]+}/oplysninger', async (c) => {
  const n = await load(c);
  if (!n) return notFound(c);
  if (n.status !== 'active' && n.status !== 'terminated') return c.redirect(`${BASE}/${n.id}?besked=ikke-muligt`, 303);
  const customer = c.get('customer');
  const body = await c.req.parseBody();
  const choice = body['choice'] === 'return' || body['choice'] === 'delete' ? body['choice'] : null;
  const description = clean(body['description'], 3000, true);
  const idem = typeof body['_idem'] === 'string' && body['_idem'].length >= 16 ? body['_idem'] : randomToken(16);
  const again = (error: string) =>
    render(r(c), 'Delte oplysninger', ndaReturnInfoPage({ csrf: c.get('csrf'), nda: n, idem, error, choice: choice ?? '', description }), {
      nav: 'aftaler',
      isCustomer: true,
      status: 400,
    });
  if (!choice) return again('Vælg tilbagelevering eller sletning.');
  if (description.length < 5) return again('Beskriv, hvilke oplysninger anmodningen vedrører.');
  if (!(await rateLimit(c.env.DB, `nda-req:${customer.id}`, 20, 3600))) return again('Du har sendt mange anmodninger på kort tid. Prøv igen senere.');
  const req = await createRequest(c.env.DB, { nda: n, kind: 'return_info', choice, description, by: customer.email, idem });
  if (req.created) await queueRequestMails(c, req.id, customer.email);
  return c.redirect(`${BASE}/anmodninger/${req.id}?besked=anmodning-oprettet`, 303);
});

export default nda;
