// Intern tid og omkostninger (/admin/omkostninger) og omkostningsoverblik under Statistik
// (/admin/statistik/omkostninger). Kun ADMIN_EMAILS. Intet her rører Stripe, abonnementer eller fakturaer.
import { Hono, type Context, type MiddlewareHandler } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import type { AppEnv, Env } from '../env';
import {
  PURPOSE_LABEL,
  PURPOSE_SHORT,
  PURPOSES,
  EXPENSE_TYPE_LABEL,
  addAllocation,
  addExpense,
  addTime,
  deleteAllocation,
  deleteExpense,
  deletePeriod,
  deleteTime,
  updateExpense,
  updateTime,
  getDefaultRate,
  getExpense,
  getTime,
  listAllocations,
  listSharedExpenses,
  parseAmount,
  parseSubject,
  periodRange,
  periodStarts,
  readExpenseForm,
  readTimeForm,
  registerPeriod,
  setDefaultRate,
  summarize,
  subjectKey,
  timeValue,
  type CostFilter,
  type Purpose,
  type Subject,
} from '../lib/costs';
import { csvKr, toCsv } from '../lib/csv';
import { getCustomerById } from '../lib/db';
import { logError } from '../lib/errlog';
import { getProspect, isDay, safeFileName, sniffType, staffList, staffName, today, MAX_FILE } from '../lib/prospects';
import { isAdmin } from '../lib/session';
import { stripeRequest } from '../lib/stripe';
import { midnight, addDays } from '../lib/stats';
import { render } from '../render';
import { sharedExpensesPage } from '../views/costs';
import { costOverviewPage, type Revenue } from '../views/cost-stats';
import { errorPage } from '../views/pages';

const r = new Hono<AppEnv>();

const guard: MiddlewareHandler<AppEnv> = async (c, next) => {
  const session = c.get('session');
  if (!session) return c.redirect('/admin/login', 303);
  if (!isAdmin(c.env, session.email)) {
    return render(c, 'Ingen adgang', errorPage('Ingen adgang', 'Du har ikke adgang til denne side.', { href: '/konto', label: 'Til kundepanelet' }), { status: 403 });
  }
  await next();
};
r.use('/omkostninger', guard);
r.use('/omkostninger/*', guard);
r.use('/statistik/omkostninger', guard);
r.use('/statistik/omkostninger/*', guard);

const who = (c: Context<AppEnv>) => c.get('session')!.email.toLowerCase();

/** Kun interne admin-sider som returadresse */
function backUrl(raw: unknown): string {
  return typeof raw === 'string' && /^\/admin\/(kundeemner\/\d+|kunder\/\d+|omkostninger\/faelles)$/.test(raw) ? raw : '/admin/statistik/omkostninger';
}

function go(c: Context<AppEnv>, back: string, flash: string, error = false) {
  return c.redirect(`${back}?${error ? 'fejl' : 'besked'}=${encodeURIComponent(flash)}#omkostninger`, 303);
}

/** Navn på emnet/kunden (gemmes på posten, så den kan genkendes efter sletning). Null hvis det ikke findes. */
async function subjectLabel(env: Env, s: Subject): Promise<string | null> {
  if (s.kind === 'prospect') {
    const p = await getProspect(env.DB, s.id);
    return p && !p.merged_into ? p.company : null;
  }
  const c = await getCustomerById(env.DB, s.id);
  return c ? c.company ?? c.name ?? c.email : null;
}

/** Fejlbeskeden gives videre til næste side i en kortlivet cookie (ingen fri tekst i adressen) */
const fail = (c: Context<AppEnv>, back: string, message: string) => {
  setCookie(c, 'vk_cost_err', encodeURIComponent(message.slice(0, 300)), { path: '/admin', httpOnly: true, sameSite: 'Lax', secure: new URL(c.req.url).protocol === 'https:', maxAge: 60 });
  return go(c, back, '1', true);
};

/** Læser og fjerner en fejlbesked fra en omkostningshandling */
export function takeCostError(c: Context<AppEnv>): string | null {
  if (c.req.query('fejl') !== '1') return null;
  const v = getCookie(c, 'vk_cost_err');
  if (!v) return null;
  deleteCookie(c, 'vk_cost_err', { path: '/admin' });
  try {
    return decodeURIComponent(v);
  } catch {
    return null;
  }
}

// ---------- Tid ----------

r.post('/omkostninger/tid', async (c) => {
  const body = await c.req.parseBody();
  const back = backUrl(body['back']);
  const subject = parseSubject(c.req.query('emne'));
  const label = subject ? await subjectLabel(c.env, subject) : null;
  if (!subject || !label) return fail(c, back, 'Kundeemnet eller kunden findes ikke.');
  const v = readTimeForm(body, staffList(c.env), await getDefaultRate(c.env.DB));
  if ('error' in v) return fail(c, back, v.error);
  await addTime(c.env.DB, subject, v.input, who(c), label);
  return go(c, back, 'tid-gemt');
});

r.post('/omkostninger/tid/:id', async (c) => {
  const body = await c.req.parseBody();
  const back = backUrl(body['back']);
  const row = await getTime(c.env.DB, Number(c.req.param('id')));
  if (!row) return fail(c, back, 'Registreringen findes ikke.');
  const v = readTimeForm(body, staffList(c.env), row.rate);
  if ('error' in v) return fail(c, back, v.error);
  const ok = await updateTime(c.env.DB, row, v.input, Number(body['version']), who(c));
  if (!ok) return fail(c, back, 'Registreringen er ændret af en anden, siden du åbnede siden. Genindlæs og prøv igen.');
  return go(c, back, 'tid-rettet');
});

r.post('/omkostninger/tid/:id/slet', async (c) => {
  const body = await c.req.parseBody();
  const back = backUrl(body['back']);
  const row = await getTime(c.env.DB, Number(c.req.param('id')));
  if (row) await deleteTime(c.env.DB, row, who(c));
  return go(c, back, 'tid-slettet');
});

// ---------- Udgifter ----------

r.post('/omkostninger/udgift', async (c) => {
  const body = await c.req.parseBody();
  const back = backUrl(body['back']);
  const shared = c.req.query('emne') === 'faelles';
  const subject = shared ? null : parseSubject(c.req.query('emne'));
  const label = subject ? await subjectLabel(c.env, subject) : null;
  if (!shared && (!subject || !label)) return fail(c, back, 'Kundeemnet eller kunden findes ikke.');
  const v = readExpenseForm(body, staffList(c.env));
  if ('error' in v) return fail(c, back, v.error);
  const basis = shared ? String(body['basis'] ?? '').trim().slice(0, 300) : null;
  if (shared && !basis) return fail(c, back, 'Skriv fordelingsgrundlaget for den fælles udgift.');
  const file = body['file'];
  let upload: { bytes: Uint8Array; type: string; name: string } | null = null;
  if (file instanceof File && file.size > 0) {
    if (file.size > MAX_FILE) return fail(c, back, 'Bilaget er større end 2 MB.');
    const bytes = new Uint8Array(await file.arrayBuffer());
    const type = sniffType(bytes);
    if (!type || type === 'image/gif') return fail(c, back, 'Bilaget skal være PDF, PNG, JPG eller WebP.');
    upload = { bytes, type, name: safeFileName(file.name, type) };
  }
  const id = await addExpense(c.env.DB, subject, v.input, who(c), label, basis);
  if (upload) {
    await c.env.DB.prepare('INSERT INTO expense_files (expense_id, name, type, size, data, created_at, created_by) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .bind(id, upload.name, upload.type, upload.bytes.length, upload.bytes, Math.floor(Date.now() / 1000), who(c))
      .run();
  }
  return go(c, back, 'udgift-gemt');
});

r.post('/omkostninger/udgift/:id', async (c) => {
  const body = await c.req.parseBody();
  const back = backUrl(body['back']);
  const row = await getExpense(c.env.DB, Number(c.req.param('id')));
  if (!row) return fail(c, back, 'Udgiften findes ikke.');
  const v = readExpenseForm(body, staffList(c.env));
  if ('error' in v) return fail(c, back, v.error);
  const res = await updateExpense(c.env.DB, row, v.input, Number(body['version']), who(c));
  if (res === 'conflict') return fail(c, back, 'Udgiften er ændret af en anden, siden du åbnede siden. Genindlæs og prøv igen.');
  if (res === 'allocations') return fail(c, back, 'Beløbet kan ikke blive mindre end det, der allerede er fordelt.');
  return go(c, back, 'udgift-rettet');
});

r.post('/omkostninger/udgift/:id/slet', async (c) => {
  const body = await c.req.parseBody();
  const back = backUrl(body['back']);
  const row = await getExpense(c.env.DB, Number(c.req.param('id')));
  if (row) await deleteExpense(c.env.DB, row, who(c));
  return go(c, back, 'udgift-slettet');
});

r.post('/omkostninger/udgift/:id/periode', async (c) => {
  const body = await c.req.parseBody();
  const back = backUrl(body['back']);
  const row = await getExpense(c.env.DB, Number(c.req.param('id')));
  const period = String(body['period'] ?? '');
  const amount = parseAmount(body['amount']) ?? row?.amount ?? null;
  if (!row || !isDay(period) || !amount) return fail(c, back, 'Perioden kunne ikke registreres.');
  if (period > today()) return fail(c, back, 'En fremtidig periode kan ikke registreres som afholdt.');
  const res = await registerPeriod(c.env.DB, row, period, amount, null, who(c));
  if (res === 'invalid') return fail(c, back, 'Perioden passer ikke til udgiftens interval, eller beløbet er mindre end det fordelte.');
  return go(c, back, res === 'exists' ? 'periode-findes' : 'periode-gemt');
});

r.post('/omkostninger/periode/:id/slet', async (c) => {
  const body = await c.req.parseBody();
  await deletePeriod(c.env.DB, Number(c.req.param('id')), who(c));
  return go(c, backUrl(body['back']), 'periode-slettet');
});

r.post('/omkostninger/udgift/:id/fordeling', async (c) => {
  const body = await c.req.parseBody();
  const back = backUrl(body['back']);
  const row = await getExpense(c.env.DB, Number(c.req.param('id')));
  const subject = parseSubject(body['emne']);
  const label = subject ? await subjectLabel(c.env, subject) : null;
  const amount = parseAmount(body['amount']);
  if (!row || !row.shared) return fail(c, back, 'Den fælles udgift findes ikke.');
  if (!subject || !label) return fail(c, back, 'Vælg en kunde eller et kundeemne.');
  if (!amount) return fail(c, back, 'Skriv andelen i kr.');
  const res = await addAllocation(c.env.DB, row, subject, amount, label, who(c));
  if (res === 'over') return fail(c, back, 'Fordelingen ville overstige udgiftens beløb. Den er ikke gemt.');
  return go(c, back, 'fordeling-gemt');
});

r.post('/omkostninger/fordeling/:id/slet', async (c) => {
  const body = await c.req.parseBody();
  await deleteAllocation(c.env.DB, Number(c.req.param('id')), who(c));
  return go(c, backUrl(body['back']), 'fordeling-slettet');
});

r.get('/omkostninger/bilag/:id', async (c) => {
  const row = await c.env.DB.prepare('SELECT name, type, data FROM expense_files WHERE id = ?').bind(Number(c.req.param('id'))).first<{ name: string; type: string; data: ArrayBuffer }>();
  if (!row) return c.text('Ikke fundet', 404);
  return c.body(new Uint8Array(row.data) as any, 200, {
    'Content-Type': row.type,
    'Content-Disposition': `${row.type === 'application/pdf' ? 'attachment' : 'inline'}; filename="${row.name.replace(/"/g, '')}"`,
    'Cache-Control': 'private, no-store',
    'Content-Security-Policy': "default-src 'none'; img-src 'self'; sandbox",
  });
});

r.get('/omkostninger/faelles', async (c) => {
  const db = c.env.DB;
  const [expenses, prospects, customers] = await Promise.all([
    listSharedExpenses(db),
    db.prepare('SELECT id, company FROM prospects WHERE merged_into IS NULL ORDER BY company COLLATE NOCASE LIMIT 1000').all<{ id: number; company: string }>(),
    db.prepare('SELECT id, COALESCE(company, name, email) AS label FROM customers ORDER BY label COLLATE NOCASE LIMIT 1000').all<{ id: number; label: string }>(),
  ]);
  const allocations = new Map<number, Awaited<ReturnType<typeof listAllocations>>>();
  const expected = new Map<number, string[]>();
  for (const x of expenses) {
    allocations.set(x.id, await listAllocations(db, x.id));
    if (x.recurring) {
      const done = new Set(((await db.prepare('SELECT period FROM expense_periods WHERE expense_id = ?').bind(x.id).all<{ period: string }>()).results ?? []).map((p) => p.period));
      expected.set(x.id, periodStarts(x, today()).filter((d) => !done.has(d)));
    }
  }
  const staff = staffList(c.env);
  const me = who(c);
  return render(
    c,
    'Fælles udgifter',
    sharedExpensesPage({
      csrf: c.get('csrf'),
      staff,
      me: staff.includes(me) ? me : staff[0] ?? me,
      today: today(),
      expenses,
      allocations,
      expected,
      subjects: [
        ...(customers.results ?? []).map((x) => ({ key: `c:${x.id}`, label: `Kunde: ${x.label}` })),
        ...(prospects.results ?? []).map((x) => ({ key: `p:${x.id}`, label: `Kundeemne: ${x.company}` })),
      ],
      flash: c.req.query('besked') ?? null,
      error: takeCostError(c),
    }),
    { nav: 'admin-statistik', admin: true },
  );
});

r.post('/omkostninger/indstillinger', async (c) => {
  const body = await c.req.parseBody();
  const rate = String(body['rate'] ?? '').trim() === '0' ? 0 : parseAmount(body['rate']);
  if (rate === null) return c.redirect('/admin/statistik/omkostninger?fejl=sats', 303);
  await setDefaultRate(c.env.DB, rate, who(c));
  return c.redirect('/admin/statistik/omkostninger?besked=sats', 303);
});

// ---------- Filtre og eksport ----------

export function readCostFilter(c: Context<AppEnv>): { filter: CostFilter; period: { key: string; from: string | null; to: string | null } } {
  const period = periodRange(c.req.query('periode'), c.req.query('fra'), c.req.query('til'));
  const staff = (c.req.query('medarbejder') ?? '').toLowerCase();
  const purpose = c.req.query('kategori') as Purpose;
  return {
    period,
    filter: {
      from: period.from,
      to: period.to,
      staff: staffList(c.env).includes(staff) ? staff : null,
      purpose: (PURPOSES as readonly string[]).includes(purpose) ? purpose : null,
      subject: parseSubject(c.req.query('emne')),
    },
  };
}

r.get('/omkostninger/eksport.csv', async (c) => {
  const { filter } = readCostFilter(c);
  const s = await summarize(c.env.DB, filter);
  const names = await subjectNames(c.env.DB);
  const subj = (pid: number | null, cid: number | null, label: string | null) =>
    pid ? `Kundeemne: ${names.p.get(pid) ?? label ?? pid}` : cid ? `Kunde: ${names.c.get(cid) ?? label ?? cid}` : label ?? '';
  const csv = toCsv([
    ['Type', 'Dato', 'Kunde eller kundeemne', 'Medarbejder / registreret af', 'Kategori (formål)', 'Beskrivelse', 'Minutter', 'Timesats (kr. ekskl. moms)', 'Beløb (kr. ekskl. moms)', 'Udgiftstype', 'Leverandør', 'Fordelingsgrundlag'],
    ...s.time.map((t) => ['Tid', t.work_date, subj(t.prospect_id, t.customer_id, t.subject_label), t.staff, PURPOSE_LABEL[t.category], t.description, t.minutes, csvKr(t.rate), csvKr(timeValue(t.minutes, t.rate)), '', '', '']),
    ...s.lines.map((l) => ['Udgift', l.date, subj(l.prospect_id, l.customer_id, l.label), l.registered_by, PURPOSE_LABEL[l.purpose], l.description, '', '', csvKr(l.amount), EXPENSE_TYPE_LABEL[l.type], l.supplier, l.shared ? l.basis : '']),
    // Forventede perioder af tilbagevendende udgifter, der endnu ikke er registreret som afholdt (indgår ikke i I alt)
    ...s.expected.map((x) => ['Forventet (ikke registreret)', x.period, '', '', '', x.description, '', '', csvKr(x.amount), '', '', '']),
    [],
    ['I alt', '', '', '', '', 'Tidsværdi', s.totals.minutes, '', csvKr(s.totals.timeValue)],
    ['I alt', '', '', '', '', 'Eksterne udgifter', '', '', csvKr(s.totals.expenses)],
    ['I alt', '', '', '', '', 'Samlet kalkuleret omkostning', '', '', csvKr(s.totals.total)],
    ['Ikke medregnet', '', '', '', '', 'Forventede, ikke registrerede udgifter', '', '', csvKr(s.expected.reduce((a, x) => a + x.amount, 0))],
  ]);
  return c.body(csv, 200, { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="veyro-tid-og-omkostninger-${today()}.csv"`, 'Cache-Control': 'no-store' });
});

async function subjectNames(db: D1Database): Promise<{ p: Map<number, string>; c: Map<number, string> }> {
  const [p, c] = await db.batch([
    db.prepare('SELECT id, company AS n FROM prospects'),
    db.prepare('SELECT id, COALESCE(company, name, email) AS n FROM customers'),
  ]);
  return {
    p: new Map(((p?.results ?? []) as { id: number; n: string }[]).map((x) => [x.id, x.n])),
    c: new Map(((c?.results ?? []) as { id: number; n: string }[]).map((x) => [x.id, x.n])),
  };
}

// ---------- Omkostningsoverblik (TCA) ----------

/** Faktureret og betalt ekskl. moms fra Stripe i perioden (valgfrit for én Stripe-kunde) */
async function stripeRevenue(env: Env, from: string | null, to: string | null, stripeCustomer: string | null): Promise<Revenue> {
  if (!env.STRIPE_SECRET_KEY) return { ok: false, error: 'Stripe er ikke sat op.', invoiced: 0, paid: 0, count: 0 };
  const fromSec = from ? midnight(from) : 0;
  const toSec = to ? midnight(addDays(to, 1)) : Math.floor(Date.now() / 1000) + 86400;
  let invoiced = 0;
  let paid = 0;
  let count = 0;
  let after: string | undefined;
  try {
    for (let page = 0; page < 20; page++) {
      const res = await stripeRequest<{ data: { id: string; status: string; created: number; total_excluding_tax?: number | null; subtotal?: number; status_transitions?: { finalized_at?: number | null; paid_at?: number | null } }[]; has_more: boolean }>(
        env,
        'GET',
        '/v1/invoices',
        { limit: 100, 'created[gte]': Math.max(0, fromSec - 62 * 86400), 'created[lt]': toSec, starting_after: after, ...(stripeCustomer ? { customer: stripeCustomer } : {}) },
      );
      for (const inv of res.data ?? []) {
        const net = inv.total_excluding_tax ?? inv.subtotal ?? 0;
        const fin = inv.status_transitions?.finalized_at ?? null;
        if (fin && fin >= fromSec && fin < toSec && ['open', 'paid', 'uncollectible'].includes(inv.status)) {
          invoiced += net;
          count++;
        }
        const pa = inv.status_transitions?.paid_at ?? null;
        if (inv.status === 'paid' && pa && pa >= fromSec && pa < toSec) paid += net;
      }
      if (!res.has_more || !res.data?.length) break;
      after = res.data[res.data.length - 1]!.id;
    }
    return { ok: true, error: null, invoiced, paid, count };
  } catch (err) {
    await logError(env.DB, 'omkostninger.stripe', err);
    return { ok: false, error: 'Stripe svarede ikke. Faktureret og betalt kan ikke vises lige nu.', invoiced: 0, paid: 0, count: 0 };
  }
}

r.get('/statistik/omkostninger', async (c) => {
  const db = c.env.DB;
  const { filter, period } = readCostFilter(c);
  // Salgsindsats: formålet "salg" på alle kundeemner og kunder i perioden, uanset om emnet blev vundet
  const sales = await summarize(db, { ...filter, purpose: 'salg' });
  const all = await summarize(db, filter);
  // Salgsindsats på emner med afslag
  const lostIds = new Set(((await db.prepare("SELECT id FROM prospects WHERE status = 'afslag'").all<{ id: number }>()).results ?? []).map((x) => x.id));
  const lostTime = sales.time.filter((t) => t.prospect_id && lostIds.has(t.prospect_id));
  const lostExact = lostTime.reduce((s, t) => s + t.minutes * t.rate, 0);
  const lostExp = sales.lines.filter((l) => l.prospect_id && lostIds.has(l.prospect_id)).reduce((s, l) => s + l.amount, 0);
  // Vundne kunder i perioden: kundeemner, der fik en kundetilknytning i perioden
  const fromSec = period.from ? midnight(period.from) : 0;
  const toSec = period.to ? midnight(addDays(period.to, 1)) : 4102444800;
  const won = (
    await db
      .prepare(
        `SELECT p.id, p.company, MIN(e.at) AS at FROM prospect_events e JOIN prospects p ON p.id = e.prospect_id
         WHERE e.kind = 'customer' AND e.new_value IS NOT NULL AND p.status = 'kunde' AND p.customer_id IS NOT NULL AND p.merged_into IS NULL
         GROUP BY p.id HAVING MIN(e.at) >= ? AND MIN(e.at) < ? ORDER BY at`,
      )
      .bind(fromSec, toSec)
      .all<{ id: number; company: string; at: number }>()
  ).results ?? [];
  let stripeCustomer: string | null = null;
  if (filter.subject?.kind === 'customer') stripeCustomer = (await getCustomerById(db, filter.subject.id))?.stripe_customer_id ?? null;
  const revenue = filter.subject?.kind === 'prospect' || (filter.subject?.kind === 'customer' && !stripeCustomer)
    ? { ok: false, error: filter.subject?.kind === 'prospect' ? 'Kundeemner har ingen fakturaer.' : 'Kunden har ingen Stripe-kunde.', invoiced: 0, paid: 0, count: 0 }
    : await stripeRevenue(c.env, period.from, period.to, stripeCustomer);
  const [prospects, customers] = await db.batch([
    db.prepare('SELECT id, company FROM prospects WHERE merged_into IS NULL ORDER BY company COLLATE NOCASE LIMIT 1000'),
    db.prepare('SELECT id, COALESCE(company, name, email) AS label FROM customers ORDER BY label COLLATE NOCASE LIMIT 1000'),
  ]);
  return render(
    c,
    'Omkostningsoverblik',
    costOverviewPage({
      csrf: c.get('csrf'),
      filter,
      period,
      staff: staffList(c.env),
      subjects: [
        ...((customers?.results ?? []) as { id: number; label: string }[]).map((x) => ({ key: `c:${x.id}`, label: `Kunde: ${x.label}` })),
        ...((prospects?.results ?? []) as { id: number; company: string }[]).map((x) => ({ key: `p:${x.id}`, label: `Kundeemne: ${x.company}` })),
      ],
      all,
      sales,
      lost: { minutes: lostTime.reduce((s, t) => s + t.minutes, 0), timeValue: Math.round(lostExact / 60), expenses: lostExp, total: Math.round(lostExact / 60) + lostExp },
      won,
      revenue,
      rate: await getDefaultRate(db),
      flash: c.req.query('besked') ?? null,
      error: c.req.query('fejl') === 'sats' ? 'Skriv standardsatsen som et beløb i kr., fx 299.' : takeCostError(c),
      query: new URL(c.req.url).search.replace(/^\?/, ''),
    }),
    { nav: 'admin-statistik', admin: true },
  );
});

export default r;
export { subjectKey, staffName, PURPOSE_SHORT };
