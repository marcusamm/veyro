// Forbrugsportalen: medarbejdere vælger et job, registrerer forbrug og planlagte materialer og
// følger jobbets indkøbslister. Ejer og indkøber har adgang til det samme.

import { Hono, type Context } from 'hono';
import type { AppEnv, JobRow, User } from '../env';
import { productOverview } from '../lib/catalog';
import { normalizeEmail, parseDay, parseIntStrict, parseQty, str } from '../lib/format';
import { Conflict, type Tx } from '../lib/ledger';
import {
  closeJob,
  getJob,
  getProduct,
  issueReserved,
  jobMaterials,
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
import { idParam, newOp, render, runTx } from '../render';
import { pageHead } from '../views/common';
import {
  availabilityPage,
  jobFormPage,
  jobPage,
  jobsPage,
  jobValues,
  registerPage,
  staffListPage,
  staffListsPage,
  type JobFormValues,
  type JobListRow,
} from '../views/job';
import type { MovementView } from '../views/lager';
import { MOVE_SQL } from './lager';

const job = new Hono<AppEnv>();
job.use('*', requireUser);

const NAV = (tab: 'job' | 'lager' | 'indkob') => ({ portal: 'job', tab }) as const;

const me = (c: Context<AppEnv>): User => c.get('session')!.user;

job.get('/', async (c) => {
  const vis = c.req.query('vis') ?? '';
  const filter = vis === 'mine' || vis === 'afsluttet' ? vis : '';
  const where = filter === 'afsluttet' ? "j.status <> 'aktiv'" : filter === 'mine' ? "j.status = 'aktiv' AND j.responsible = ?" : "j.status = 'aktiv'";
  const stmt = c.env.DB.prepare(
    `SELECT j.*, u.name AS responsible_name,
       (SELECT COUNT(*) FROM job_materials m WHERE m.job_id = j.id AND m.planned > 0) AS mat_count,
       (SELECT COUNT(*) FROM job_materials m WHERE m.job_id = j.id AND m.planned > m.issued - m.returned + m.reserved + m.site_received - m.site_returned) AS waiting_count
     FROM jobs j LEFT JOIN users u ON u.email = j.responsible
     WHERE ${where}
     ORDER BY ${filter === 'afsluttet' ? 'j.updated_at DESC' : "j.planned_date = '', j.planned_date, j.number"} LIMIT 300`,
  );
  const { results } = await (filter === 'mine' ? stmt.bind(me(c).email) : stmt).all<JobListRow>();
  return render(
    c,
    'Job',
    jobsPage({ jobs: results, filter, q: (c.req.query('q') ?? '').slice(0, 100), flashCode: c.req.query('besked'), mine: me(c).email }),
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
  return {
    number: s('number', 30),
    name: s('name'),
    customer_name: s('customer_name'),
    customer_email: s('customer_email', 254),
    customer_phone: s('customer_phone', 40),
    customer_address: s('customer_address', 200),
    site_address: s('site_address', 200),
    responsible: s('responsible', 254),
    planned_date: s('planned_date', 10),
    markup_pct: s('markup_pct', 5),
    note: str(body['note'], 1000, { multiline: true }),
  };
}

type JobInput = Omit<JobFormValues, 'markup_pct'> & { markup_pct: number | null };

function parseJob(v: JobFormValues): { input?: JobInput; errs: string[] } {
  const errs: string[] = [];
  if (!v.number) errs.push('Angiv et jobnummer.');
  if (!v.name) errs.push('Angiv et jobnavn.');
  if (v.customer_email && !normalizeEmail(v.customer_email)) errs.push('Kundens e-mail er ikke gyldig.');
  const day = parseDay(v.planned_date);
  if (day === null) errs.push('Datoen er ikke gyldig.');
  let markup: number | null = null;
  if (v.markup_pct) {
    markup = parseIntStrict(v.markup_pct, { max: 1000 });
    if (markup === null) errs.push('Avancen skal være et helt tal mellem 0 og 1000.');
  }
  if (errs.length) return { errs };
  return { input: { ...v, customer_email: v.customer_email ? normalizeEmail(v.customer_email)! : '', planned_date: day ?? '', markup_pct: markup }, errs };
}

async function showForm(c: Context<AppEnv>, v: JobFormValues, d: { action: string; isNew: boolean; errs: string[] }, status: 200 | 400 = 200) {
  return render(
    c,
    d.isNew ? 'Nyt job' : `Ret ${v.number}`,
    jobFormPage(v, { csrf: c.get('csrf'), users: await activeUsers(c.env.DB), manager: canManage(me(c)), defaultMarkup: c.get('settings').default_markup_pct, ...d }),
    NAV('job'),
    status,
  );
}

job.get('/ny', async (c) => {
  const v = jobValues(null, await nextJobNumber(c.env.DB));
  v.responsible = me(c).email;
  return showForm(c, v, { action: '/job/ny', isNew: true, errs: [] });
});

job.post('/ny', async (c) => {
  const v = jobForm(await c.req.parseBody());
  if (!canManage(me(c))) v.markup_pct = '';
  const { input, errs } = parseJob(v);
  if (!input) return showForm(c, v, { action: '/job/ny', isNew: true, errs }, 400);
  const now = Math.floor(Date.now() / 1000);
  try {
    const row = await c.env.DB.prepare(
      `INSERT INTO jobs (number, name, customer_name, customer_email, customer_phone, customer_address, site_address, responsible, planned_date, markup_pct, note, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`,
    )
      .bind(
        input.number,
        input.name,
        input.customer_name,
        input.customer_email,
        input.customer_phone,
        input.customer_address,
        input.site_address,
        input.responsible,
        input.planned_date,
        input.markup_pct,
        input.note,
        now,
        now,
      )
      .first<{ id: number }>();
    return c.redirect(`/job/${row!.id}?besked=job_oprettet`, 303);
  } catch (err) {
    if (String((err as Error).message).includes('UNIQUE')) return showForm(c, v, { action: '/job/ny', isNew: true, errs: [`Jobnummer ${input.number} findes allerede.`] }, 400);
    throw err;
  }
});

job.get('/:id{[0-9]+}/ret', async (c) => {
  const j = await getJob(c.env.DB, Number(c.req.param('id')));
  if (!j) return c.notFound();
  return showForm(c, jobValues(j), { action: `/job/${j.id}/ret`, isNew: false, errs: [] });
});

job.post('/:id{[0-9]+}/ret', async (c) => {
  const j = await getJob(c.env.DB, Number(c.req.param('id')));
  if (!j) return c.notFound();
  const v = jobForm(await c.req.parseBody());
  // Kun ejer og indkøber må ændre avancen
  if (!canManage(me(c))) v.markup_pct = j.markup_pct === null ? '' : String(j.markup_pct);
  const { input, errs } = parseJob(v);
  const action = `/job/${j.id}/ret`;
  if (!input) return showForm(c, v, { action, isNew: false, errs }, 400);
  try {
    await c.env.DB.prepare(
      `UPDATE jobs SET number = ?, name = ?, customer_name = ?, customer_email = ?, customer_phone = ?, customer_address = ?, site_address = ?,
         responsible = ?, planned_date = ?, markup_pct = ?, note = ?, updated_at = ? WHERE id = ?`,
    )
      .bind(
        input.number,
        input.name,
        input.customer_name,
        input.customer_email,
        input.customer_phone,
        input.customer_address,
        input.site_address,
        input.responsible,
        input.planned_date,
        input.markup_pct,
        input.note,
        Math.floor(Date.now() / 1000),
        j.id,
      )
      .run();
  } catch (err) {
    if (String((err as Error).message).includes('UNIQUE')) return showForm(c, v, { action, isNew: false, errs: [`Jobnummer ${input.number} findes allerede.`] }, 400);
    throw err;
  }
  return c.redirect(`/job/${j.id}?besked=gemt`, 303);
});

// --- Jobbet -----------------------------------------------------------------------------------

async function showJob(c: Context<AppEnv>, id: number, extra: { error?: string; status?: 200 | 400 | 409 } = {}) {
  const db = c.env.DB;
  const j = await db
    .prepare('SELECT j.*, u.name AS responsible_name FROM jobs j LEFT JOIN users u ON u.email = j.responsible WHERE j.id = ?')
    .bind(id)
    .first<JobRow & { responsible_name: string | null }>();
  if (!j) return c.notFound();
  const [mats, lists, { results: moves }] = await Promise.all([
    jobMaterials(db, id),
    listsOverview(db, { jobId: id }),
    db.prepare(`${MOVE_SQL} WHERE m.job_id = ? ORDER BY m.id DESC LIMIT 40`).bind(id).all<MovementView>(),
  ]);
  const withLines = await Promise.all(lists.map(async (l) => ({ ...l, lines: await listLines(db, l.id) })));
  return render(
    c,
    `${j.number} ${j.name}`,
    jobPage({
      job: j,
      mats,
      lists: withLines,
      moves,
      manager: canManage(me(c)),
      csrf: c.get('csrf'),
      ops: [...mats.map(() => newOp()), newOp()],
      flashCode: c.req.query('besked'),
      error: extra.error,
    }),
    NAV('job'),
    extra.status ?? 200,
  );
}

job.get('/:id{[0-9]+}', (c) => showJob(c, Number(c.req.param('id'))));

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
    for (const it of items) {
      const p = await getProduct(tx.db, it.pid);
      if (!p) throw new Conflict('En af varerne findes ikke længere.');
      if (type === 'plan') short += (await planMaterial(tx, fresh, p, it.q, note)).short;
      else await registerUse(tx, fresh, p, it.q, note);
    }
  });
  if (!res.ok && !res.duplicate) return showRegister(c, j, type, { values, note, errs: [res.error], status: 409 });
  const code = !res.ok ? 'dublet' : type === 'forbrug' ? 'forbrug' : short ? 'planlagt_mangler' : 'planlagt';
  return c.redirect(`/job/${j.id}?besked=${code}`, 303);
});

// --- Handlinger på en enkelt vare -------------------------------------------------------------

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
  if (!action || q === null || q < 0 || (q === 0 && !action.allowZero)) return showJob(c, id, { error: 'Angiv en gyldig mængde.', status: 400 });
  const res = await runTx(c, action.kind, body['op'], async (tx) => {
    const [j, p] = await Promise.all([getJob(tx.db, id), getProduct(tx.db, pid)]);
    if (!j || !p) throw new Conflict('Jobbet eller varen findes ikke.');
    await action.fn(tx, j, p, q, str(body['reason'], 200));
  });
  if (!res.ok && !res.duplicate) return showJob(c, id, { error: res.error, status: 409 });
  return c.redirect(`/job/${id}?besked=${res.ok ? 'registreret' : 'dublet'}`, 303);
});

job.post('/:id{[0-9]+}/status', async (c) => {
  const id = Number(c.req.param('id'));
  const body = await c.req.parseBody();
  const next = body['status'] === 'aktiv' ? 'aktiv' : 'afsluttet';
  const res = await runTx(c, `job_${next}`, body['op'], async (tx) => {
    const j = await getJob(tx.db, id);
    if (!j) throw new Conflict('Jobbet findes ikke.');
    if (next === 'afsluttet') {
      if (j.status !== 'aktiv') throw new Conflict('Jobbet er allerede afsluttet.');
      await closeJob(tx, j, 'afsluttet');
    } else {
      if (j.status === 'aktiv') throw new Conflict('Jobbet er allerede aktivt.');
      tx.add(tx.db.prepare("UPDATE jobs SET status = 'aktiv', updated_at = ? WHERE id = ?").bind(tx.now, id));
      // Genberegn indkøbsbehovet for jobbet
      tx.jobs.add(id);
    }
  });
  if (!res.ok && !res.duplicate) return showJob(c, id, { error: res.error, status: 409 });
  return c.redirect(`/job/${id}?besked=${!res.ok ? 'dublet' : next === 'aktiv' ? 'job_genaabnet' : 'afsluttet'}`, 303);
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
