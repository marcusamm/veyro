// Veyros administration af fuldmagter (/admin/fuldmagter). Kun e-mails i ADMIN_EMAILS.
// Medarbejdere kan se, acceptere, registrere handlinger og behandle sletning, men aldrig ændre en godkendt fuldmagt.
import { Hono, type Context, type MiddlewareHandler } from 'hono';
import type { AppEnv } from '../env';
import { normalizeEmail } from '../lib/db';
import {
  acceptByVeyro,
  cancelPlannedAction,
  completePlannedAction,
  completeTask,
  eventStmt,
  expireDue,
  getPoa,
  getSettings,
  hasDoneActions,
  listActions,
  listDeletionRequests,
  listEvents,
  listTasks,
  parseSnapshot,
  processDeletion,
  registerAction,
  saveSettings,
  VEYRO_FIELDS,
  missingVeyroInfo,
  type ActionInput,
  type DeletionRequestRow,
} from '../lib/poa';
import { currentDocument, deliverAll, listMails, pdfFilename, queueMail, resendMail } from '../lib/poa-docs';
import { withStatusPage } from '../lib/poa-pdf';
import { isAdmin } from '../lib/session';
import { render } from '../render';
import { errorPage } from '../views/pages';
import { adminPoaDetailPage, adminPoaListPage, adminPoaSettingsPage, type AdminPoaRow } from '../views/poa';
import type { TaskRow } from '../lib/poa';

const adminPoa = new Hono<AppEnv>();
const BASE = '/admin/fuldmagter';

const guard: MiddlewareHandler<AppEnv> = async (c, next) => {
  const session = c.get('session');
  if (!session) return c.redirect('/admin/login', 303);
  if (!isAdmin(c.env, session.email)) {
    return render(c, 'Ingen adgang', errorPage('Ingen adgang', 'Du har ikke adgang til denne side.', { href: '/konto', label: 'Til kundepanelet' }), { status: 403 });
  }
  await expireDue(c.env.DB);
  await next();
};
adminPoa.use('/fuldmagter', guard);
adminPoa.use('/fuldmagter/*', guard);

const who = (c: Context<AppEnv>) => c.get('session')!.email;
const opts = { nav: 'admin-fuldmagter' as const, admin: true };

adminPoa.get('/fuldmagter', async (c) => {
  const q = (c.req.query('q') ?? '').trim().slice(0, 100);
  const status = c.req.query('status') ?? '';
  const where: string[] = [];
  const binds: unknown[] = [];
  if (q) {
    where.push("(p.number LIKE ?1 OR p.company_name LIKE ?1 OR p.project LIKE ?1 OR c.email LIKE ?1 OR p.snapshot_json LIKE ?2 OR p.draft_json LIKE ?2)");
    binds.push(`%${q}%`, `%"cvr":"${q.replace(/["%_\\]/g, '')}%`);
  }
  if (['draft', 'pending', 'active', 'revoked', 'expired'].includes(status)) {
    where.push(`p.status = ?${binds.length + 1}`);
    binds.push(status);
  }
  const { results: rows } = await c.env.DB.prepare(
    `SELECT p.*, c.email FROM poas p JOIN customers c ON c.id = p.customer_id ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
     ORDER BY (p.status = 'pending') DESC, p.updated_at DESC LIMIT 300`,
  )
    .bind(...binds)
    .all<AdminPoaRow>();
  const [requests, tasks, settings] = await Promise.all([
    listDeletionRequests(c.env.DB, null),
    c.env.DB.prepare("SELECT t.*, p.number, p.version FROM poa_tasks t JOIN poas p ON p.id = t.poa_id WHERE t.status = 'open' ORDER BY t.created_at")
      .all<TaskRow & { number: string; version: number }>()
      .then((r) => r.results),
    getSettings(c.env.DB),
  ]);
  return render(
    c,
    'Fuldmagter',
    adminPoaListPage({ rows, q, status, requests, openTasks: tasks, settings, missing: missingVeyroInfo(settings), flashKey: c.req.query('besked') }),
    opts,
  );
});

// ---------- Indstillinger ----------

adminPoa.get('/fuldmagter/indstillinger', async (c) => {
  return render(c, 'Fuldmagter: indstillinger', adminPoaSettingsPage({ csrf: c.get('csrf'), settings: await getSettings(c.env.DB) }), opts);
});

adminPoa.post('/fuldmagter/indstillinger', async (c) => {
  const body = await c.req.parseBody();
  const str = (k: string) => (typeof body[k] === 'string' ? (body[k] as string).replace(/\s+/g, ' ').trim().slice(0, 200) : '');
  const values: Record<string, string> = {};
  for (const [k] of VEYRO_FIELDS) values[k] = str(k);
  const settings = await getSettings(c.env.DB);
  const again = (error: string) =>
    render(c, 'Fuldmagter: indstillinger', adminPoaSettingsPage({ csrf: c.get('csrf'), settings: Object.assign({}, settings, values) as typeof settings, error }), { ...opts, status: 400 });
  if (values.veyro_cvr && !/^\d{8}$/.test(values.veyro_cvr.replace(/\s/g, ''))) return again('CVR-nummeret skal være 8 cifre.');
  if (values.veyro_contact_email && !normalizeEmail(values.veyro_contact_email)) return again('Kontaktmailen er ugyldig.');
  values.require_veyro_acceptance = body['require_veyro_acceptance'] === '1' ? '1' : '0';
  values.text_approved = body['text_approved'] === '1' ? '1' : '0';
  values.launched = body['launched'] === '1' && values.text_approved === '1' ? '1' : '0';
  if (body['launched'] === '1' && values.launched !== '1') return again('Siden kan først åbnes for alle kunder, når teksten, metoden og politikken er markeret som godkendt.');
  const pilots = (typeof body['pilot_emails'] === 'string' ? body['pilot_emails'] : '')
    .split(/[\s,;]+/)
    .map((e) => normalizeEmail(e))
    .filter((e): e is string => !!e);
  values.pilot_emails = [...new Set(pilots)].join('\n');
  await saveSettings(c.env.DB, values, who(c));
  return c.redirect(`${BASE}?besked=gemt`, 303);
});

// ---------- Sletteanmodninger ----------

adminPoa.post('/fuldmagter/sletning/:rid', async (c) => {
  const rid = Number.parseInt(c.req.param('rid'), 10);
  const body = await c.req.parseBody();
  const mode = body['mode'] === 'full' ? 'full' : 'policy';
  const req = await c.env.DB.prepare('SELECT d.*, c.email FROM poa_deletion_requests d JOIN customers c ON c.id = d.customer_id WHERE d.id = ?')
    .bind(rid)
    .first<DeletionRequestRow & { email: string }>();
  if (!req) return c.text('Ikke fundet', 404);
  const res = await processDeletion(c.env.DB, rid, who(c), mode);
  if (res) {
    const id = await queueMail(c.env.DB, { deletionRequestId: rid, kind: 'deletion_result', to: req.email });
    c.executionCtx.waitUntil(deliverAll(c.env, [id]));
  }
  if (res?.status === 'completed' || !req.poa_id) return c.redirect(`${BASE}?besked=slettet`, 303);
  return c.redirect(`${BASE}/${req.poa_id}#sletning`, 303);
});

// ---------- Én fuldmagt ----------

async function detail(c: Context<AppEnv>, id: number, extra: { error?: string | null; ok?: string | null; actionValues?: Record<string, string> } = {}, status: 200 | 400 = 200) {
  const poa = await c.env.DB.prepare('SELECT p.*, c.email FROM poas p JOIN customers c ON c.id = p.customer_id WHERE p.id = ?').bind(id).first<AdminPoaRow>();
  if (!poa) return render(c, 'Ikke fundet', errorPage('Fuldmagten findes ikke', 'Den kan være slettet.', { href: BASE, label: 'Til fuldmagter' }), { ...opts, status: 404 });
  const [events, mails, actions, tasks, requests, hasActions] = await Promise.all([
    listEvents(c.env.DB, id),
    listMails(c.env.DB, id),
    listActions(c.env.DB, id),
    listTasks(c.env.DB, id),
    c.env.DB.prepare('SELECT * FROM poa_deletion_requests WHERE poa_id = ? ORDER BY requested_at DESC').bind(id).all<DeletionRequestRow>().then((r) => r.results),
    hasDoneActions(c.env.DB, id),
  ]);
  return render(
    c,
    `Fuldmagt ${poa.number}`,
    adminPoaDetailPage({ csrf: c.get('csrf'), poa, snap: parseSnapshot(poa), events, mails, actions, tasks, requests, hasActions, ...extra }),
    { ...opts, status },
  );
}

const idOf = (c: Context<AppEnv>) => {
  const n = Number.parseInt(c.req.param('id') ?? '', 10);
  return Number.isSafeInteger(n) && n > 0 ? n : 0;
};

const OK: Record<string, string> = {
  accepteret: 'Fuldmagten er accepteret og nu aktiv. Kunden får besked.',
  registreret: 'Handlingen er kontrolleret og registreret.',
  udfoert: 'Den planlagte handling er udført.',
  stoppet: 'Den planlagte handling er stoppet.',
  opgave: 'Opfølgningen er registreret.',
  mail: 'Mailen er forsøgt sendt igen. Se status nedenfor.',
};

adminPoa.get('/fuldmagter/:id', async (c) => {
  const k = c.req.query('ok');
  return detail(c, idOf(c), { ok: k ? OK[k] ?? null : null, error: c.req.query('fejl') ? 'Handlingen kunne ikke gennemføres: fuldmagten gælder ikke.' : null });
});

adminPoa.get('/fuldmagter/:id/pdf', async (c) => {
  const p = await getPoa(c.env.DB, idOf(c));
  if (!p || p.status === 'draft') return c.text('Ikke fundet', 404);
  const doc = await currentDocument(c.env.DB, p);
  if (!doc) return c.text('Ikke fundet', 404);
  const original = c.req.query('original') === '1';
  const bytes = original ? doc.pdf : await withStatusPage(doc.pdf, p, doc.sha256);
  return c.body(bytes as Uint8Array<ArrayBuffer>, 200, {
    'Content-Type': 'application/pdf',
    'Content-Disposition': `attachment; filename="${pdfFilename(p, original ? '' : '-status')}"`,
    'Cache-Control': 'private, no-store',
  });
});

adminPoa.post('/fuldmagter/:id/accepter', async (c) => {
  const id = idOf(c);
  if (!(await acceptByVeyro(c.env.DB, id, who(c)))) return c.redirect(`${BASE}/${id}?fejl=1`, 303);
  const p = (await getPoa(c.env.DB, id))!;
  await currentDocument(c.env.DB, p);
  const snap = parseSnapshot(p);
  const mid = await queueMail(c.env.DB, { poaId: id, kind: 'activated', to: snap?.customer.receipt_email ?? '' });
  c.executionCtx.waitUntil(deliverAll(c.env, [mid]));
  return c.redirect(`${BASE}/${id}?ok=accepteret`, 303);
});

adminPoa.post('/fuldmagter/:id/handlinger', async (c) => {
  const id = idOf(c);
  const body = await c.req.parseBody();
  const s = (k: string, max: number) => (typeof body[k] === 'string' ? (body[k] as string).trim().slice(0, max) : '');
  const input: ActionInput = { power: s('power', 20), party: s('party', 200), description: s('description', 1000), amount: s('amount', 20), planned_for: s('planned_for', 10) };
  const error = await registerAction(c.env.DB, id, input, who(c));
  if (error) return detail(c, id, { error, actionValues: input as unknown as Record<string, string> }, 400);
  return c.redirect(`${BASE}/${id}?ok=registreret#handlinger`, 303);
});

adminPoa.post('/fuldmagter/:id/handlinger/:aid/udfoer', async (c) => {
  const id = idOf(c);
  const error = await completePlannedAction(c.env.DB, id, Number.parseInt(c.req.param('aid'), 10), who(c));
  if (error) return detail(c, id, { error }, 400);
  return c.redirect(`${BASE}/${id}?ok=udfoert#handlinger`, 303);
});

adminPoa.post('/fuldmagter/:id/handlinger/:aid/stop', async (c) => {
  const id = idOf(c);
  await cancelPlannedAction(c.env.DB, id, Number.parseInt(c.req.param('aid'), 10), who(c));
  return c.redirect(`${BASE}/${id}?ok=stoppet#handlinger`, 303);
});

adminPoa.post('/fuldmagter/:id/opgaver/:tid', async (c) => {
  const id = idOf(c);
  await completeTask(c.env.DB, id, Number.parseInt(c.req.param('tid'), 10), who(c));
  return c.redirect(`${BASE}/${id}?ok=opgave#opfoelgning`, 303);
});

adminPoa.post('/fuldmagter/:id/mails/:mid', async (c) => {
  const id = idOf(c);
  const mid = Number.parseInt(c.req.param('mid'), 10);
  const own = await c.env.DB.prepare('SELECT id FROM poa_mails WHERE id = ? AND poa_id = ?').bind(mid, id).first();
  if (!own) return c.text('Ikke fundet', 404);
  await resendMail(c.env, mid);
  await eventStmt(c.env.DB, id, who(c), 'mail_resend').run();
  return c.redirect(`${BASE}/${id}?ok=mail#mails`, 303);
});

export default adminPoa;
