// Job- og forbrugsportalen: joblisten, oprettelse af job, jobbets overblik, registrering af forbrug
// fra lageret, jobbets indkøbslister og historik. Materialer med priser, timer, prisoverslag og
// faktura ligger i routes/jobokonomi.ts. Ejer og indkøber ser priser; medarbejdere gør ikke.

import { Hono, type Context } from 'hono';
import type { AppEnv, JobRow, JobStage, User } from '../env';
import { productOverview } from '../lib/catalog';
import { retailers } from '../lib/estimates';
import { normalizeEmail, parseDay, parseIntStrict, parseKr, parseQty, str } from '../lib/format';
import { STAGE_LABEL, isStage, jobLog, jobStaff, logStmt, staffStmts, syncStage } from '../lib/jobs';
import { Conflict, type Tx } from '../lib/ledger';
import {
  closeJob,
  getJob,
  getProduct,
  issueReserved,
  planMaterial,
  registerUse,
  releaseReservation,
  returnToStock,
  setPlanned,
  siteToStock,
  useFromSite,
} from '../lib/materials';
import { listLines, listsOverview } from '../lib/purchasing';
import { canManage, requireUser } from '../lib/session';
import { actorOf, idParam, newOp, render, runTx } from '../render';
import { pageHead } from '../views/common';
import {
  availabilityPage,
  jobFormPage,
  jobListsPage,
  jobValues,
  jobsPage,
  registerPage,
  staffListPage,
  staffListsPage,
  type JobFormValues,
  type JobListRow,
} from '../views/job';
import { historyTab } from '../views/jobokonomi';
import type { MovementView } from '../views/lager';
import { MOVE_SQL } from './lager';
import { jobOverview, showMaterials } from './jobokonomi';
import { NAV, jobHead, me } from './jobshared';

const job = new Hono<AppEnv>();
job.use('*', requireUser);


export const JOB_LIST_SQL = `SELECT j.*, u.name AS responsible_name,
   (SELECT GROUP_CONCAT(COALESCE(uu.name, s.email), ', ') FROM job_staff s LEFT JOIN users uu ON uu.email = s.email WHERE s.job_id = j.id) AS staff_names,
   (SELECT q.subtotal FROM job_quotes q WHERE q.job_id = j.id ORDER BY q.version DESC LIMIT 1) AS quote_subtotal,
   (SELECT q.version FROM job_quotes q WHERE q.job_id = j.id ORDER BY q.version DESC LIMIT 1) AS quote_version,
   (SELECT q.incomplete FROM job_quotes q WHERE q.job_id = j.id ORDER BY q.version DESC LIMIT 1) AS quote_incomplete,
   COALESCE((SELECT SUM(e.qty) FROM job_entries e WHERE e.job_id = j.id AND e.phase = 'faktisk' AND e.type = 'tid'), 0) AS hours,
   COALESCE((SELECT SUM(e.qty) FROM job_entries e WHERE e.job_id = j.id AND e.phase = 'forventet' AND e.type = 'tid'), 0) AS hours_expected,
   (SELECT COUNT(*) FROM job_materials m WHERE m.job_id = j.id AND m.issued - m.returned + m.site_used > 0)
     + (SELECT COUNT(*) FROM job_items i WHERE i.job_id = j.id AND i.product_id IS NULL AND i.used_qty > 0) AS used_lines,
   COALESCE((SELECT SUM((m.issued - m.returned + m.site_used) * COALESCE(p.purchase_price, 0) / 1000) FROM job_materials m JOIN products p ON p.id = m.product_id WHERE m.job_id = j.id), 0) AS mat_cost,
   (SELECT COUNT(*) FROM job_materials m WHERE m.job_id = j.id AND m.planned > 0) AS mat_count,
   (SELECT COUNT(*) FROM job_materials m WHERE m.job_id = j.id AND m.planned > m.issued - m.returned + m.reserved + m.site_received - m.site_returned) AS waiting_count,
   (SELECT COUNT(*) FROM invoices i WHERE i.job_id = j.id AND i.kind = 'faktura' AND i.status = 'udstedt') AS inv_issued,
   (SELECT COUNT(*) FROM invoices i WHERE i.job_id = j.id AND i.status = 'kladde') AS inv_drafts,
   (SELECT COUNT(*) FROM invoices i WHERE i.job_id = j.id AND i.kind = 'kreditnota' AND i.status = 'udstedt') AS inv_credits,
   COALESCE((SELECT SUM(CASE WHEN i.kind = 'faktura' THEN i.total ELSE -i.total END) FROM invoices i WHERE i.job_id = j.id AND i.status = 'udstedt'), 0) AS inv_total
 FROM jobs j LEFT JOIN users u ON u.email = j.responsible`;

job.get('/', async (c) => {
  const vis = c.req.query('vis') ?? '';
  const filter = ['mine', 'afsluttet', 'alle'].includes(vis) ? vis : '';
  const where =
    filter === 'afsluttet'
      ? "j.status <> 'aktiv'"
      : filter === 'alle'
        ? '1 = 1'
        : filter === 'mine'
          ? "j.status = 'aktiv' AND (j.responsible = ?1 OR EXISTS (SELECT 1 FROM job_staff s WHERE s.job_id = j.id AND s.email = ?1))"
          : "j.status = 'aktiv'";
  const order = filter === 'afsluttet' || filter === 'alle' ? 'j.updated_at DESC' : "j.start_date = '', j.start_date, j.number";
  const stmt = c.env.DB.prepare(`${JOB_LIST_SQL} WHERE ${where} ORDER BY ${order} LIMIT 300`);
  const { results } = await (filter === 'mine' ? stmt.bind(me(c).email) : stmt).all<JobListRow>();
  return render(
    c,
    'Job',
    jobsPage({ jobs: results, filter, q: (c.req.query('q') ?? '').slice(0, 100), flashCode: c.req.query('besked'), manager: canManage(me(c)) }),
    NAV('job'),
  );
});

// --- Opret og ret job -------------------------------------------------------------------------

async function activeUsers(db: D1Database): Promise<User[]> {
  const { results } = await db.prepare('SELECT * FROM users WHERE active = 1 ORDER BY name COLLATE NOCASE').all<User>();
  return results;
}

/** Næste ledige jobnummer i formen ÅÅÅÅ-NNN. */
async function nextJobNumber(db: D1Database): Promise<string> {
  const year = new Date().getFullYear();
  const { results } = await db.prepare('SELECT number FROM jobs WHERE number LIKE ?').bind(`${year}-%`).all<{ number: string }>();
  const max = results.reduce((m, r) => {
    const n = /^\d{4}-(\d{1,6})$/.exec(r.number);
    return n ? Math.max(m, parseInt(n[1]!, 10)) : m;
  }, 0);
  return `${year}-${String(max + 1).padStart(3, '0')}`;
}

function jobForm(body: Record<string, unknown>): JobFormValues {
  const s = (k: string, max = 120) => str(body[k], max);
  const ml = (k: string, max: number) => str(body[k], max, { multiline: true });
  const staffRaw = body['staff'];
  const staff = (Array.isArray(staffRaw) ? staffRaw : staffRaw ? [staffRaw] : []).map((x) => normalizeEmail(x)).filter((x): x is string => !!x).slice(0, 30);
  return {
    number: s('number', 30),
    name: s('name'),
    description: ml('description', 2000),
    stage: s('stage', 20),
    customer_name: s('customer_name'),
    customer_contact: s('customer_contact'),
    customer_cvr: s('customer_cvr', 12),
    customer_email: s('customer_email', 254),
    customer_phone: s('customer_phone', 40),
    customer_address: ml('customer_address', 300),
    site_address: ml('site_address', 200).replace(/\n/g, ', '),
    responsible: s('responsible', 254),
    staff,
    start_date: s('start_date', 10),
    end_date: s('end_date', 10),
    retailer_id: s('retailer_id', 10),
    hour_rate: s('hour_rate', 12),
    markup_pct: s('markup_pct', 5),
    note: ml('note', 1000),
  };
}

type JobInput = Omit<JobFormValues, 'markup_pct' | 'hour_rate' | 'retailer_id' | 'stage'> & {
  markup_pct: number | null;
  hour_rate: number | null;
  retailer_id: number | null;
  stage: JobStage;
};

function parseJob(v: JobFormValues, retailerIds: Set<number>): { input?: JobInput; errs: string[] } {
  const errs: string[] = [];
  if (!v.number) errs.push('Angiv et jobnummer.');
  if (!v.name) errs.push('Angiv en titel.');
  if (v.customer_email && !normalizeEmail(v.customer_email)) errs.push('Slutkundens e-mail er ikke gyldig.');
  if (v.customer_cvr && !/^\d{8}$/.test(v.customer_cvr.replace(/\s/g, ''))) errs.push('CVR-nummeret skal være 8 cifre.');
  const start = parseDay(v.start_date);
  const end = parseDay(v.end_date);
  if (start === null || end === null) errs.push('En af datoerne er ikke gyldig.');
  else if (start && end && end < start) errs.push('Slutdatoen kan ikke ligge før startdatoen.');
  let markup: number | null = null;
  if (v.markup_pct) {
    markup = parseIntStrict(v.markup_pct, { max: 1000 });
    if (markup === null) errs.push('Påslaget skal være et helt tal mellem 0 og 1000.');
  }
  let rate: number | null = null;
  if (v.hour_rate) {
    rate = parseKr(v.hour_rate);
    if (rate === null) errs.push('Timeprisen er ikke et gyldigt beløb.');
  }
  const rid = v.retailer_id ? Number(v.retailer_id) : null;
  if (rid !== null && !retailerIds.has(rid)) errs.push('Vælg et gyldigt byggemarked.');
  if (errs.length) return { errs };
  return {
    input: {
      ...v,
      customer_email: v.customer_email ? normalizeEmail(v.customer_email)! : '',
      customer_cvr: v.customer_cvr.replace(/\s/g, ''),
      start_date: start ?? '',
      end_date: end ?? '',
      markup_pct: markup,
      hour_rate: rate,
      retailer_id: rid,
      stage: v.stage === 'kladde' || v.stage === 'i_gang' ? v.stage : 'planlagt',
      staff: [...new Set([v.responsible, ...v.staff].filter(Boolean))],
    },
    errs,
  };
}

async function showForm(c: Context<AppEnv>, v: JobFormValues, d: { action: string; isNew: boolean; errs: string[] }, status: 200 | 400 = 200) {
  const s = c.get('settings');
  const rs = await retailers(c.env.DB, { activeOnly: true });
  return render(
    c,
    d.isNew ? 'Nyt job' : `Ret ${v.number}`,
    jobFormPage(v, {
      csrf: c.get('csrf'),
      users: await activeUsers(c.env.DB),
      retailers: rs,
      preferred: rs.find((r) => r.key === s.preferred_retailer)?.name ?? '',
      manager: canManage(me(c)),
      defaultMarkup: s.default_markup_pct,
      defaultRate: s.default_hour_rate,
      ...d,
    }),
    NAV('job'),
    status,
  );
}

async function retailerIdSet(db: D1Database): Promise<Set<number>> {
  return new Set((await retailers(db, { activeOnly: true })).map((r) => r.id));
}

job.get('/ny', async (c) => {
  const v = jobValues(null, [], await nextJobNumber(c.env.DB));
  v.responsible = me(c).email;
  return showForm(c, v, { action: '/job/ny', isNew: true, errs: [] });
});

job.post('/ny', async (c) => {
  const v = jobForm(await c.req.parseBody({ all: true }));
  if (!canManage(me(c))) {
    v.markup_pct = '';
    v.hour_rate = '';
    v.retailer_id = '';
  }
  const { input, errs } = parseJob(v, await retailerIdSet(c.env.DB));
  if (!input) return showForm(c, v, { action: '/job/ny', isNew: true, errs }, 400);
  const now = Math.floor(Date.now() / 1000);
  const db = c.env.DB;
  try {
    const row = await db
      .prepare(
        `INSERT INTO jobs (number, name, description, stage, customer_name, customer_contact, customer_cvr, customer_email, customer_phone, customer_address, site_address,
           responsible, planned_date, start_date, end_date, retailer_id, hour_rate, markup_pct, note, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`,
      )
      .bind(
        input.number,
        input.name,
        input.description,
        input.stage,
        input.customer_name,
        input.customer_contact,
        input.customer_cvr,
        input.customer_email,
        input.customer_phone,
        input.customer_address,
        input.site_address,
        input.responsible,
        input.start_date,
        input.start_date,
        input.end_date,
        input.retailer_id,
        input.hour_rate,
        input.markup_pct,
        input.note,
        now,
        now,
      )
      .first<{ id: number }>();
    await db.batch([...staffStmts(db, row!.id, input.staff), logStmt(db, row!.id, 'job', `Job oprettet (${STAGE_LABEL[input.stage]}).`, actorOf(c), now)]);
    return c.redirect(`/job/${row!.id}?besked=job_oprettet`, 303);
  } catch (err) {
    if (String((err as Error).message).includes('UNIQUE')) return showForm(c, v, { action: '/job/ny', isNew: true, errs: [`Jobnummer ${input.number} findes allerede.`] }, 400);
    throw err;
  }
});

job.get('/:id{[0-9]+}/ret', async (c) => {
  const j = await getJob(c.env.DB, Number(c.req.param('id')));
  if (!j) return c.notFound();
  const staff = (await jobStaff(c.env.DB, j.id)).map((s) => s.email).filter((e) => e !== j.responsible);
  return showForm(c, jobValues(j, staff), { action: `/job/${j.id}/ret`, isNew: false, errs: [] });
});

job.post('/:id{[0-9]+}/ret', async (c) => {
  const db = c.env.DB;
  const j = await getJob(db, Number(c.req.param('id')));
  if (!j) return c.notFound();
  const v = jobForm(await c.req.parseBody({ all: true }));
  // Kun ejer og indkøber må ændre priser og byggemarked
  if (!canManage(me(c))) {
    const keep = jobValues(j);
    v.markup_pct = keep.markup_pct;
    v.hour_rate = keep.hour_rate;
    v.retailer_id = keep.retailer_id;
  }
  v.stage = j.stage;
  const { input, errs } = parseJob(v, await retailerIdSet(db));
  const action = `/job/${j.id}/ret`;
  if (!input) return showForm(c, v, { action, isNew: false, errs }, 400);
  const now = Math.floor(Date.now() / 1000);
  try {
    await db.batch([
      db
        .prepare(
          `UPDATE jobs SET number = ?, name = ?, description = ?, customer_name = ?, customer_contact = ?, customer_cvr = ?, customer_email = ?, customer_phone = ?,
             customer_address = ?, site_address = ?, responsible = ?, planned_date = ?, start_date = ?, end_date = ?, retailer_id = ?, hour_rate = ?, markup_pct = ?,
             note = ?, updated_at = ? WHERE id = ?`,
        )
        .bind(
          input.number,
          input.name,
          input.description,
          input.customer_name,
          input.customer_contact,
          input.customer_cvr,
          input.customer_email,
          input.customer_phone,
          input.customer_address,
          input.site_address,
          input.responsible,
          input.start_date,
          input.start_date,
          input.end_date,
          input.retailer_id,
          input.hour_rate,
          input.markup_pct,
          input.note,
          now,
          j.id,
        ),
      ...staffStmts(db, j.id, input.staff),
    ]);
  } catch (err) {
    if (String((err as Error).message).includes('UNIQUE')) return showForm(c, v, { action, isNew: false, errs: [`Jobnummer ${input.number} findes allerede.`] }, 400);
    throw err;
  }
  return c.redirect(`/job/${j.id}?besked=gemt`, 303);
});

// --- Jobbet -----------------------------------------------------------------------------------

job.get('/:id{[0-9]+}', (c) => jobOverview(c, Number(c.req.param('id'))));

job.get('/:id{[0-9]+}/indkob', async (c) => {
  const db = c.env.DB;
  const j = await jobHead(db, Number(c.req.param('id')));
  if (!j) return c.notFound();
  const lists = await listsOverview(db, { jobId: j.id });
  const withLines = await Promise.all(
    lists.map(async (l) => {
      const lines = await listLines(db, l.id);
      const { results } = await db
        .prepare('SELECT l.id, r.name FROM purchase_lines l JOIN retailers r ON r.id = l.retailer_id WHERE l.list_id = ?')
        .bind(l.id)
        .all<{ id: number; name: string }>();
      const names = new Map(results.map((r) => [r.id, r.name]));
      return { ...l, lines: lines.map((x) => ({ ...x, retailer_name: names.get(x.id) ?? null })) };
    }),
  );
  return render(c, `${j.number} indkøb`, jobListsPage({ job: j, lists: withLines, manager: canManage(me(c)), csrf: c.get('csrf') }), NAV('job'));
});

job.get('/:id{[0-9]+}/historik', async (c) => {
  const db = c.env.DB;
  const j = await jobHead(db, Number(c.req.param('id')));
  if (!j) return c.notFound();
  const [{ results: moves }, log] = await Promise.all([db.prepare(`${MOVE_SQL} WHERE m.job_id = ? ORDER BY m.id DESC LIMIT 100`).bind(j.id).all<MovementView>(), jobLog(db, j.id)]);
  return render(c, `${j.number} historik`, historyTab({ job: j, manager: canManage(me(c)), moves, log }), NAV('job'));
});

// --- Registrér forbrug eller planlæg materialer ----------------------------------------------

async function showRegister(
  c: Context<AppEnv>,
  j: JobRow,
  type: 'forbrug' | 'plan',
  d: { values?: Record<number, string>; note?: string; errs?: string[]; status?: 200 | 400 | 409 } = {},
) {
  const db = c.env.DB;
  const [products, { results: mine }] = await Promise.all([
    productOverview(db),
    db.prepare('SELECT product_id, reserved FROM job_materials WHERE job_id = ?').bind(j.id).all<{ product_id: number; reserved: number }>(),
  ]);
  const reserved = new Map(mine.map((m) => [m.product_id, m.reserved]));
  // Varer med reservation til jobbet øverst, så udlevering er hurtig
  const rows = products
    .map((p) => ({ ...p, job_reserved: reserved.get(p.id) ?? 0 }))
    .sort((a, b) => Number(b.job_reserved > 0) - Number(a.job_reserved > 0));
  return render(
    c,
    type === 'plan' ? 'Planlæg materialer' : 'Registrér forbrug',
    registerPage({ job: j, type, products: rows, values: d.values ?? {}, note: d.note ?? '', csrf: c.get('csrf'), op: newOp(), errs: d.errs ?? [] }),
    NAV('job'),
    d.status ?? 200,
  );
}

job.get('/:id{[0-9]+}/registrer', async (c) => {
  const j = await getJob(c.env.DB, Number(c.req.param('id')));
  if (!j) return c.notFound();
  if (j.status !== 'aktiv') return c.redirect(`/job/${j.id}`, 303);
  return showRegister(c, j, c.req.query('type') === 'plan' ? 'plan' : 'forbrug');
});

/** Planlagte varer fra lageret står også på jobbets materialeliste (til prisoverslaget). */
function ensureItems(tx: Tx, jobId: number, products: { id: number; sku: string; name: string; unit: string; ean: string; mpn: string; brand: string; variant: string }[]): void {
  for (const p of products) {
    tx.add(
      tx.db
        .prepare(
          `INSERT INTO job_items (job_id, product_id, cost_basis, sku, name, unit, ean, mpn, brand, variant, qty, planned_at, created_by, created_at, updated_at)
           VALUES (?1, ?2, 'lager', ?3, ?4, ?5, ?6, ?7, ?8, ?9, (SELECT planned FROM job_materials WHERE job_id = ?1 AND product_id = ?2), ?10, ?11, ?10, ?10)
           ON CONFLICT(job_id, product_id) WHERE product_id IS NOT NULL
           DO UPDATE SET qty = MAX(qty, excluded.qty), planned_at = COALESCE(planned_at, excluded.planned_at), updated_at = excluded.updated_at`,
        )
        .bind(jobId, p.id, p.sku, p.name, p.unit, p.ean, p.mpn, p.brand, p.variant, tx.now, tx.actor.email),
    );
  }
}

job.post('/:id{[0-9]+}/registrer', async (c) => {
  const j = await getJob(c.env.DB, Number(c.req.param('id')));
  if (!j) return c.notFound();
  const body = await c.req.parseBody();
  const type = body['type'] === 'plan' ? 'plan' : 'forbrug';
  const note = str(body['note'], 200);
  const values: Record<number, string> = {};
  const items: { pid: number; q: number }[] = [];
  const errs: string[] = [];
  for (const [k, raw] of Object.entries(body)) {
    const m = /^q_(\d{1,9})$/.exec(k);
    if (!m || typeof raw !== 'string' || !raw.trim()) continue;
    const pid = Number(m[1]);
    values[pid] = raw.trim().slice(0, 20);
    const q = parseQty(raw);
    if (q === null || q < 0) errs.push(`"${values[pid]}" er ikke en gyldig mængde.`);
    else if (q > 0) items.push({ pid, q });
  }
  if (errs.length) return showRegister(c, j, type, { values, note, errs, status: 400 });
  if (!items.length) return showRegister(c, j, type, { values, note, errs: ['Angiv mindst én mængde.'], status: 400 });
  let short = 0;
  const res = await runTx(c, type === 'plan' ? 'planlagt' : 'forbrug', body['op'], async (tx) => {
    short = 0;
    const fresh = await getJob(tx.db, j.id);
    if (!fresh) throw new Conflict('Jobbet findes ikke længere.');
    const prods = [];
    for (const it of items) {
      const p = await getProduct(tx.db, it.pid);
      if (!p) throw new Conflict('En af varerne findes ikke længere.');
      prods.push(p);
      if (type === 'plan') short += (await planMaterial(tx, fresh, p, it.q, note)).short;
      else await registerUse(tx, fresh, p, it.q, note);
    }
    if (type === 'plan') ensureItems(tx, j.id, prods);
  });
  if (!res.ok && !res.duplicate) return showRegister(c, j, type, { values, note, errs: [res.error], status: 409 });
  const code = !res.ok ? 'dublet' : type === 'forbrug' ? 'forbrug' : short ? 'planlagt_mangler' : 'planlagt';
  return c.redirect(`/job/${j.id}${type === 'plan' ? '/materialer' : ''}?besked=${code}`, 303);
});

// --- Handlinger på en enkelt vare fra lageret -------------------------------------------------

type MaterialAction = (tx: Tx, j: JobRow, p: NonNullable<Awaited<ReturnType<typeof getProduct>>>, q: number, reason: string) => Promise<void>;

const ACTIONS: Record<string, { fn: MaterialAction; kind: string; allowZero?: boolean }> = {
  udlever: { fn: issueReserved, kind: 'udlevering' },
  frigiv: { fn: releaseReservation, kind: 'frigivelse' },
  retur: { fn: returnToStock, kind: 'retur' },
  brug_arbejdssted: { fn: useFromSite, kind: 'arbejdssted_forbrug' },
  arbejdssted_til_lager: { fn: siteToStock, kind: 'arbejdssted_retur' },
  behov: { fn: (tx, j, p, q) => setPlanned(tx, j, p, q), kind: 'behov', allowZero: true },
};

job.post('/:id{[0-9]+}/materiale/:pid{[0-9]+}', async (c) => {
  const id = Number(c.req.param('id'));
  const pid = Number(c.req.param('pid'));
  const body = await c.req.parseBody();
  const action = typeof body['action'] === 'string' ? ACTIONS[body['action']] : undefined;
  const q = parseQty(body['qty']);
  if (!action || q === null || q < 0 || (q === 0 && !action.allowZero)) return c.redirect(`/job/${id}/materialer?fejl=maengde`, 303);
  const res = await runTx(c, action.kind, body['op'], async (tx) => {
    const [j, p] = await Promise.all([getJob(tx.db, id), getProduct(tx.db, pid)]);
    if (!j || !p) throw new Conflict('Jobbet eller varen findes ikke.');
    await action.fn(tx, j, p, q, str(body['reason'], 200));
  });
  if (!res.ok && !res.duplicate) return showMaterials(c, id, { error: res.error, status: 409 });
  return c.redirect(`/job/${id}/materialer?besked=${res.ok ? 'registreret' : 'dublet'}`, 303);
});

job.post('/:id{[0-9]+}/status', async (c) => {
  const id = Number(c.req.param('id'));
  const body = await c.req.parseBody();
  // Ældre formularer sender status=aktiv/afsluttet
  const raw = body['stage'] ?? (body['status'] === 'aktiv' ? 'i_gang' : body['status'] === 'afsluttet' ? 'afsluttet' : undefined);
  if (!isStage(raw)) return c.redirect(`/job/${id}`, 303);
  const next: JobStage = raw;
  const res = await runTx(c, `job_${next}`, body['op'], async (tx) => {
    const j = await getJob(tx.db, id);
    if (!j) throw new Conflict('Jobbet findes ikke.');
    if (j.stage === next) throw new Conflict(`Jobbet er allerede ${STAGE_LABEL[next].toLowerCase()}.`);
    if (next === 'afsluttet' || next === 'annulleret') {
      if (j.status === 'aktiv') await closeJob(tx, j, next);
      else tx.add(tx.db.prepare('UPDATE jobs SET status = ?, updated_at = ? WHERE id = ?').bind(next, tx.now, id));
    } else if (j.status !== 'aktiv') {
      tx.add(tx.db.prepare("UPDATE jobs SET status = 'aktiv', updated_at = ? WHERE id = ?").bind(tx.now, id));
      // Genberegn indkøbsbehovet for jobbet
      tx.jobs.add(id);
    }
    tx.add(
      tx.db.prepare("UPDATE jobs SET stage = ?, stage_auto = 0, stage_prev = '', updated_at = ? WHERE id = ?").bind(next, tx.now, id),
      logStmt(tx.db, id, 'status', `Status ændret fra ${STAGE_LABEL[j.stage]} til ${STAGE_LABEL[next]}.`, tx.actor, tx.now),
    );
  });
  if (res.ok) await syncStage(c.env.DB, id, Math.floor(Date.now() / 1000), actorOf(c));
  if (!res.ok && !res.duplicate) return jobOverview(c, id, { error: res.error, status: 409 });
  const code = !res.ok ? 'dublet' : next === 'afsluttet' ? 'afsluttet' : next === 'annulleret' ? 'job_annulleret' : 'status_gemt';
  return c.redirect(`/job/${id}?besked=${code}`, 303);
});

// --- Lager og indkøbslister for medarbejdere --------------------------------------------------

job.get('/lager', async (c) =>
  render(c, 'Hvad er på lager', availabilityPage({ products: await productOverview(c.env.DB), q: (c.req.query('q') ?? '').slice(0, 100) }), NAV('lager')),
);

job.get('/indkob', async (c) => render(c, 'Indkøbslister', staffListsPage({ lists: await listsOverview(c.env.DB) }), NAV('indkob')));

job.get('/indkob/:id{[0-9]+}', async (c) => {
  const db = c.env.DB;
  const id = idParam(c.req.param('id'));
  const all = [...(await listsOverview(db)), ...(await listsOverview(db, { archived: true }))];
  const list = all.find((l) => l.id === id);
  if (!list) return render(c, 'Ikke fundet', pageHead('Indkøbslister', 'Listen findes ikke'), NAV('indkob'), 404);
  return render(c, list.name, staffListPage({ list, lines: await listLines(db, list.id), prices: canManage(me(c)) }), NAV('indkob'));
});

export default job;
