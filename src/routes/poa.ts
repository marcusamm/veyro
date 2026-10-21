// Kundens side "Fuldmagter" (/konto/fuldmagter). Kræver login og en kundekonto (sat af account.ts).
// Kunden ser kun sin egen virksomheds fuldmagter: alle opslag sker med kundens id.
import { Hono, type Context } from 'hono';
import type { AppEnv, CustomerRow } from '../env';
import { rateLimit } from '../lib/db';
import { logError } from '../lib/errlog';
import {
  approve,
  buildSnapshot,
  canIssue,
  checkOtp,
  createDraft,
  createOtp,
  deleteDraft,
  emptyForm,
  eventStmt,
  expireDue,
  formFromSnapshot,
  getPoaForCustomer,
  getSettings,
  hasDoneActions,
  isTestEnv,
  listDeletionRequests,
  listEvents,
  listForCustomer,
  listTasks,
  missingVeyroInfo,
  parseForm,
  parseSnapshot,
  randomToken,
  readForm,
  requestDeletion,
  revoke,
  saveDraft,
  snapshotHash,
  validateForm,
  type PoaForm,
  type PoaRow,
} from '../lib/poa';
import { currentDocument, deliverAll, ensureDocument, listMails, pdfFilename, queueMail } from '../lib/poa-docs';
import { withStatusPage } from '../lib/poa-pdf';
import { sendEmail } from '../lib/email';
import { render } from '../render';
import { errorPage } from '../views/pages';
import {
  poaDeletePage,
  poaDetailPage,
  poaFormPage,
  poaListPage,
  poaReviewPage,
  poaRevokePage,
} from '../views/poa';

type Vars = AppEnv & { Variables: AppEnv['Variables'] & { customer: CustomerRow } };
const poa = new Hono<Vars>();
const r = (c: Context<Vars>) => c as unknown as Context<AppEnv>;
const BASE = '/konto/fuldmagter';

// Udløb kontrolleres før hver handling, så en udløbet fuldmagt aldrig vises eller bruges som aktiv.
poa.use('*', async (c, next) => {
  await expireDue(c.env.DB);
  await next();
});

const testLabel = (c: Context<Vars>) => (isTestEnv(c.env) ? c.env.TEST_LABEL || 'Testmiljø' : null);

function notFound(c: Context<Vars>) {
  return render(r(c), 'Ikke fundet', errorPage('Fuldmagten findes ikke', 'Vi kunne ikke finde fuldmagten på din konto.', { href: BASE, label: 'Til fuldmagter' }), {
    status: 404,
    nav: 'fuldmagter',
    isCustomer: true,
  });
}

async function load(c: Context<Vars>): Promise<PoaRow | null> {
  const id = Number.parseInt(c.req.param('id') ?? '', 10);
  if (!Number.isSafeInteger(id) || id <= 0) return null;
  return getPoaForCustomer(c.env.DB, id, c.get('customer').id);
}

function prefill(customer: CustomerRow): PoaForm {
  const f = emptyForm();
  f.company_name = customer.company ?? '';
  f.cvr = customer.cvr ?? '';
  f.address = customer.address ?? '';
  f.postal_city = [customer.postal_code, customer.city].filter(Boolean).join(' ');
  f.contact_name = customer.name ?? '';
  f.receipt_email = customer.email;
  f.approver_name = customer.name ?? '';
  return f;
}

// ---------- Liste ----------

poa.get('/', async (c) => {
  const customer = c.get('customer');
  const [rows, requests, settings] = await Promise.all([
    listForCustomer(c.env.DB, customer.id),
    listDeletionRequests(c.env.DB, customer.id),
    getSettings(c.env.DB),
  ]);
  return render(
    r(c),
    'Fuldmagter',
    poaListPage({ rows, requests, canIssue: canIssue(settings, customer.email), flashKey: c.req.query('besked'), testLabel: testLabel(c), textDraft: !settings.text_approved }),
    { nav: 'fuldmagter', isCustomer: true },
  );
});

// ---------- Ny og rediger ----------

poa.get('/ny', async (c) => {
  const customer = c.get('customer');
  const settings = await getSettings(c.env.DB);
  if (!canIssue(settings, customer.email)) return c.redirect(BASE, 303);
  return render(
    r(c),
    'Ny fuldmagt',
    poaFormPage({ csrf: c.get('csrf'), poa: null, form: prefill(customer), errors: {}, settings, idem: randomToken(18), testLabel: testLabel(c) }),
    { nav: 'fuldmagter', isCustomer: true },
  );
});

async function saveAndContinue(c: Context<Vars>, existing: PoaRow | null) {
  const customer = c.get('customer');
  const settings = await getSettings(c.env.DB);
  if (!existing && !canIssue(settings, customer.email)) return c.redirect(BASE, 303);
  const body = await c.req.parseBody({ all: true });
  const form = readForm(body as Record<string, unknown>);
  const next = body['next'] === 'review' ? 'review' : 'draft';
  const errors = validateForm(form, { complete: false });
  const idem = typeof body['_idem'] === 'string' && /^[A-Za-z0-9_-]{16,64}$/.test(body['_idem']) ? body['_idem'] : randomToken(18);
  if (Object.keys(errors).length) {
    return render(r(c), 'Fuldmagt', poaFormPage({ csrf: c.get('csrf'), poa: existing, form, errors, settings, idem, testLabel: testLabel(c) }), {
      nav: 'fuldmagter',
      status: 400,
      isCustomer: true,
    });
  }
  let id: number;
  if (existing) {
    if (!(await saveDraft(c.env.DB, existing, form))) return c.redirect(`${BASE}/${existing.id}?besked=ikke-kladde`, 303);
    id = existing.id;
  } else {
    if (!(await rateLimit(c.env.DB, `poa-new:${customer.id}`, 30, 3600))) {
      return render(r(c), 'For mange forsøg', errorPage('For mange nye fuldmagter', 'Prøv igen om lidt.', { href: BASE, label: 'Til fuldmagter' }), { status: 429, nav: 'fuldmagter', isCustomer: true });
    }
    id = await createDraft(c.env.DB, { customerId: customer.id, form, idem });
    // Dobbeltklik: anden indsendelse finder samme kladde og gemmer det samme indhold
    const created = await getPoaForCustomer(c.env.DB, id, customer.id);
    if (created?.status === 'draft') await saveDraft(c.env.DB, created, form);
  }
  return c.redirect(next === 'review' ? `${BASE}/${id}/oversigt` : `${BASE}/${id}/rediger?besked=kladde-gemt`, 303);
}

poa.post('/ny', (c) => saveAndContinue(c, null));

poa.get('/:id/rediger', async (c) => {
  const p = await load(c);
  if (!p) return notFound(c);
  if (p.status !== 'draft') return c.redirect(`${BASE}/${p.id}?besked=ikke-kladde`, 303);
  const settings = await getSettings(c.env.DB);
  const flash = c.req.query('besked') === 'kladde-gemt';
  const page = poaFormPage({ csrf: c.get('csrf'), poa: p, form: parseForm(p.draft_json), errors: {}, settings, idem: randomToken(18), testLabel: testLabel(c) });
  const { html } = await import('hono/html');
  const { alert } = await import('../views/layout');
  return render(r(c), `Fuldmagt ${p.number}`, flash ? html`${alert('ok', 'Kladden er gemt. Du kan fortsætte senere.')}<div style="height:16px"></div>${page}` : page, {
    nav: 'fuldmagter',
    isCustomer: true,
  });
});

poa.post('/:id/rediger', async (c) => {
  const p = await load(c);
  if (!p) return notFound(c);
  if (p.status !== 'draft') return c.redirect(`${BASE}/${p.id}?besked=ikke-kladde`, 303);
  return saveAndContinue(c, p);
});

// ---------- Oversigt, engangskode og godkendelse ----------

async function reviewModel(c: Context<Vars>, p: PoaRow) {
  const customer = c.get('customer');
  const settings = await getSettings(c.env.DB);
  const form = parseForm(p.draft_json);
  const errors = validateForm(form, { complete: true });
  const blockers: string[] = [...new Set(Object.values(errors))];
  const missing = missingVeyroInfo(settings);
  if (missing.length) blockers.push(`Veyros oplysninger er ikke udfyldt endnu (${missing.join(', ')}). Veyro skal udfylde dem, før fuldmagten kan godkendes.`);
  if (!canIssue(settings, customer.email)) blockers.push('Digitale fuldmagter er ikke åbnet for din konto.');
  if (!c.env.RESEND_API_KEY && c.env.DEV_MODE !== '1') blockers.push('Engangskoder kan ikke sendes, fordi mailintegrationen ikke er sat op. Kontakt Veyro.');
  const snap = buildSnapshot(p, form, settings, customer.email, c.env);
  const hash = await snapshotHash(snap);
  return { snap, hash, blockers, form };
}

async function otpPending(db: D1Database, poaId: number): Promise<boolean> {
  const row = await db.prepare('SELECT expires_at, attempts FROM poa_otps WHERE poa_id = ?').bind(poaId).first<{ expires_at: number; attempts: number }>();
  return !!row && row.expires_at > Math.floor(Date.now() / 1000) && row.attempts < 5;
}

poa.get('/:id/oversigt', async (c) => {
  const p = await load(c);
  if (!p) return notFound(c);
  if (p.status !== 'draft') return c.redirect(`${BASE}/${p.id}`, 303);
  const m = await reviewModel(c, p);
  const sent = c.req.query('kode') === 'sendt' && (await otpPending(c.env.DB, p.id));
  return render(
    r(c),
    'Gennemse fuldmagt',
    poaReviewPage({ csrf: c.get('csrf'), poa: p, snap: m.snap, hash: m.hash, blockers: m.blockers, sentTo: sent ? c.get('customer').email : null, testLabel: testLabel(c) }),
    { nav: 'fuldmagter', isCustomer: true },
  );
});

poa.post('/:id/kode', async (c) => {
  const p = await load(c);
  if (!p) return notFound(c);
  if (p.status !== 'draft') return c.redirect(`${BASE}/${p.id}`, 303);
  const customer = c.get('customer');
  const m = await reviewModel(c, p);
  const body = await c.req.parseBody();
  const again = (error: string, status: 200 | 400 | 429 | 502 = 400, devCode: string | null = null, sentTo: string | null = null) =>
    render(r(c), 'Gennemse fuldmagt', poaReviewPage({ csrf: c.get('csrf'), poa: p, snap: m.snap, hash: m.hash, blockers: m.blockers, error: error || null, devCode, sentTo, testLabel: testLabel(c) }), {
      nav: 'fuldmagter',
      status,
      isCustomer: true,
    });
  if (m.blockers.length) return again('Ret fejlene, før du godkender.');
  if (body['hash'] !== m.hash) return again('Fuldmagten er ændret, siden du åbnede siden. Gennemse den igen.');
  if (!(await rateLimit(c.env.DB, `poa-otp:${customer.id}`, 6, 3600))) return again('Du har bedt om mange koder. Vent en time, og prøv igen.', 429);
  const code = await createOtp(c.env.DB, p.id);
  if (c.env.RESEND_API_KEY) {
    try {
      await sendEmail(c.env, {
        to: customer.email,
        subject: `Engangskode til godkendelse af fuldmagt ${p.number}`,
        text: `Hej\n\nDin engangskode til at godkende fuldmagt ${p.number} er:\n\n${code}\n\nKoden virker i 10 minutter. Har du ikke bedt om koden, så kontakt Veyro på kontakt@veyro.dk.\n\nVeyro`,
        html: `<p>Hej</p><p>Din engangskode til at godkende fuldmagt ${p.number} er:</p><p style="font-size:28px;font-weight:700;letter-spacing:.2em">${code}</p><p style="color:#55534D;font-size:14px">Koden virker i 10 minutter. Har du ikke bedt om koden, så kontakt Veyro på kontakt@veyro.dk.</p>`,
      });
    } catch (err) {
      await c.env.DB.prepare('DELETE FROM poa_otps WHERE poa_id = ?').bind(p.id).run();
      await logError(c.env.DB, 'Fuldmagt engangskode', err);
      return again('Vi kunne ikke sende engangskoden lige nu. Prøv igen om lidt.', 502);
    }
    await eventStmt(c.env.DB, p.id, 'kunde', 'otp_sent').run();
    return c.redirect(`${BASE}/${p.id}/oversigt?kode=sendt#godkend`, 303);
  }
  // Kun udvikling: ingen mail; koden vises på skærmen (blokeres ellers i reviewModel)
  await eventStmt(c.env.DB, p.id, 'kunde', 'otp_sent', 'Udviklingstilstand: vist på skærmen').run();
  return again('', 200, code, customer.email);
});

poa.post('/:id/godkend', async (c) => {
  const p = await load(c);
  if (!p) return notFound(c);
  const customer = c.get('customer');
  // Dobbeltklik efter godkendelse: vis kvitteringen
  if (p.status !== 'draft') return c.redirect(`${BASE}/${p.id}${p.approved_at ? '?godkendt=1' : ''}`, 303);
  const m = await reviewModel(c, p);
  const body = await c.req.parseBody();
  const fail = (error: string) =>
    render(
      r(c),
      'Gennemse fuldmagt',
      poaReviewPage({ csrf: c.get('csrf'), poa: p, snap: m.snap, hash: m.hash, blockers: m.blockers, error, sentTo: customer.email, testLabel: testLabel(c) }),
      { nav: 'fuldmagter', status: 400, isCustomer: true },
    );
  if (m.blockers.length) return fail('Fuldmagten kan ikke godkendes endnu.');
  if (body['hash'] !== m.hash) return fail('Fuldmagten eller Veyros oplysninger er ændret, siden du åbnede siden. Gennemse den igen, og godkend på ny.');
  if (body['confirm1'] !== '1' || body['confirm2'] !== '1') return fail('Sæt flueben ved begge bekræftelser.');
  const code = typeof body['code'] === 'string' ? body['code'].replace(/\s/g, '') : '';
  const otp = await checkOtp(c.env.DB, p.id, code);
  if (otp === 'missing' || otp === 'expired') {
    return render(
      r(c),
      'Gennemse fuldmagt',
      poaReviewPage({ csrf: c.get('csrf'), poa: p, snap: m.snap, hash: m.hash, blockers: [], error: 'Engangskoden er udløbet eller brugt for mange gange. Send en ny kode.', testLabel: testLabel(c) }),
      { nav: 'fuldmagter', status: 400, isCustomer: true },
    );
  }
  if (otp === 'wrong') {
    await eventStmt(c.env.DB, p.id, 'kunde', 'otp_failed').run();
    return fail('Engangskoden er forkert.');
  }
  const status = await approve(c.env.DB, p, m.snap, m.hash, customer.email);
  if (!status) return c.redirect(`${BASE}/${p.id}`, 303);
  const approved = (await getPoaForCustomer(c.env.DB, p.id, customer.id))!;
  // Dokumentet laves og gemmes nu ud fra den godkendte version
  try {
    await ensureDocument(c.env.DB, approved, 'approved');
    if (status === 'active' && !m.snap.requires_veyro_acceptance) await currentDocument(c.env.DB, approved);
  } catch (err) {
    await logError(c.env.DB, 'Fuldmagt PDF', err);
  }
  const ids = [
    await queueMail(c.env.DB, { poaId: p.id, kind: 'receipt', to: m.snap.customer.receipt_email }),
    await queueMail(c.env.DB, { poaId: p.id, kind: 'staff_approved', to: c.env.NOTIFY_EMAIL || 'kontakt@veyro.dk' }),
  ];
  c.executionCtx.waitUntil(deliverAll(c.env, ids));
  return c.redirect(`${BASE}/${p.id}?godkendt=1`, 303);
});

// ---------- Visning og dokumenter ----------

poa.get('/:id', async (c) => {
  const p = await load(c);
  if (!p) return notFound(c);
  const [mails, tasks, requests, events] = await Promise.all([
    listMails(c.env.DB, p.id),
    listTasks(c.env.DB, p.id),
    c.env.DB.prepare('SELECT * FROM poa_deletion_requests WHERE poa_id = ? AND customer_id = ? ORDER BY requested_at DESC')
      .bind(p.id, p.customer_id)
      .all()
      .then((x) => x.results as never[]),
    listEvents(c.env.DB, p.id),
  ]);
  return render(
    r(c),
    `Fuldmagt ${p.number}`,
    poaDetailPage({
      csrf: c.get('csrf'),
      poa: p,
      snap: parseSnapshot(p),
      mails,
      tasks,
      requests,
      events: events.filter((e) => !['otp_failed'].includes(e.type)),
      justApproved: c.req.query('godkendt') === '1' && !!p.approved_at,
      flashKey: c.req.query('besked'),
      testLabel: testLabel(c),
    }),
    { nav: 'fuldmagter', isCustomer: true },
  );
});

poa.get('/:id/pdf', async (c) => {
  const p = await load(c);
  if (!p) return notFound(c);
  if (p.status === 'draft') return c.redirect(`${BASE}/${p.id}`, 303);
  const doc = await currentDocument(c.env.DB, p);
  if (!doc) return notFound(c);
  const original = c.req.query('original') === '1';
  const bytes = original ? doc.pdf : await withStatusPage(doc.pdf, p, doc.sha256);
  return c.body(bytes as Uint8Array<ArrayBuffer>, 200, {
    'Content-Type': 'application/pdf',
    'Content-Disposition': `attachment; filename="${pdfFilename(p, original ? '' : '-status')}"`,
    'Cache-Control': 'private, no-store',
  });
});

// ---------- Ny version ----------

poa.post('/:id/ny-version', async (c) => {
  const p = await load(c);
  if (!p) return notFound(c);
  const snap = parseSnapshot(p);
  if (!snap) return c.redirect(`${BASE}/${p.id}/rediger`, 303);
  const settings = await getSettings(c.env.DB);
  if (!canIssue(settings, c.get('customer').email)) return c.redirect(`${BASE}/${p.id}`, 303);
  const body = await c.req.parseBody();
  const idem = typeof body['_idem'] === 'string' && /^[A-Za-z0-9_-]{4,64}$/.test(body['_idem']) ? `${c.get('customer').id}-${body['_idem']}` : randomToken(18);
  const id = await createDraft(c.env.DB, { customerId: p.customer_id, form: formFromSnapshot(snap), idem, from: p });
  return c.redirect(`${BASE}/${id}/rediger`, 303);
});

// ---------- Tilbagekaldelse ----------

poa.get('/:id/tilbagekald', async (c) => {
  const p = await load(c);
  if (!p) return notFound(c);
  if (p.status !== 'active' && p.status !== 'pending') return c.redirect(`${BASE}/${p.id}?besked=ikke-aktiv`, 303);
  return render(r(c), 'Tilbagekald fuldmagt', poaRevokePage({ csrf: c.get('csrf'), poa: p }), { nav: 'fuldmagter', isCustomer: true });
});

async function doRevoke(c: Context<Vars>, p: PoaRow): Promise<boolean> {
  if (!(await revoke(c.env.DB, p))) return false;
  const snap = parseSnapshot(p);
  const ids = [
    await queueMail(c.env.DB, { poaId: p.id, kind: 'revoked', to: snap?.customer.receipt_email ?? c.get('customer').email }),
    await queueMail(c.env.DB, { poaId: p.id, kind: 'staff_revoked', to: c.env.NOTIFY_EMAIL || 'kontakt@veyro.dk' }),
  ];
  c.executionCtx.waitUntil(deliverAll(c.env, ids));
  return true;
}

poa.post('/:id/tilbagekald', async (c) => {
  const p = await load(c);
  if (!p) return notFound(c);
  const ok = await doRevoke(c, p);
  return c.redirect(`${BASE}/${p.id}?besked=${ok ? 'tilbagekaldt' : p.status === 'revoked' ? 'allerede-behandlet' : 'ikke-aktiv'}`, 303);
});

// ---------- Sletning ----------

poa.get('/:id/slet', async (c) => {
  const p = await load(c);
  if (!p) return notFound(c);
  if (p.status !== 'draft' && p.deletion_status !== 'none') return c.redirect(`${BASE}/${p.id}`, 303);
  return render(r(c), p.status === 'draft' ? 'Slet kladde' : 'Anmod om sletning', poaDeletePage({ csrf: c.get('csrf'), poa: p, hasActions: await hasDoneActions(c.env.DB, p.id) }), {
    nav: 'fuldmagter',
    isCustomer: true,
  });
});

poa.post('/:id/slet', async (c) => {
  const p = await load(c);
  if (!p) return c.redirect(`${BASE}?besked=allerede-behandlet`, 303);
  const customer = c.get('customer');
  if (p.status === 'draft') {
    await deleteDraft(c.env.DB, p.id, customer.id);
    return c.redirect(`${BASE}?besked=kladde-slettet`, 303);
  }
  if (p.deletion_status !== 'none') return c.redirect(`${BASE}/${p.id}?besked=allerede-behandlet`, 303);
  const body = await c.req.parseBody();
  let current = p;
  if (p.status === 'active' || p.status === 'pending') {
    if (body['revoke_first'] !== '1') {
      return render(
        r(c),
        'Anmod om sletning',
        poaDeletePage({ csrf: c.get('csrf'), poa: p, hasActions: await hasDoneActions(c.env.DB, p.id), error: 'Fuldmagten skal tilbagekaldes, før den kan slettes. Sæt flueben for at tilbagekalde den nu.' }),
        { nav: 'fuldmagter', status: 400, isCustomer: true },
      );
    }
    await doRevoke(c, p);
    current = (await getPoaForCustomer(c.env.DB, p.id, customer.id))!;
  }
  const reqId = await requestDeletion(c.env.DB, current);
  if (reqId) {
    const id = await queueMail(c.env.DB, { poaId: p.id, kind: 'staff_deletion', to: c.env.NOTIFY_EMAIL || 'kontakt@veyro.dk' });
    c.executionCtx.waitUntil(deliverAll(c.env, [id]));
  }
  return c.redirect(`${BASE}?besked=sletning-anmodet`, 303);
});

export default poa;
