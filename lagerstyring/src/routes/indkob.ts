import { Hono, type Context } from 'hono';
import type { AppEnv, JobRow, MailRow, PurchaseLineRow, User } from '../env';
import { suppliers } from '../lib/catalog';
import { parseDay, parseKr, parseQty, str } from '../lib/format';
import { getProduct } from '../lib/materials';
import { sendPurchaseList } from '../lib/notices';
import {
  addLine,
  cancelLine,
  createList,
  getLine,
  getList,
  linesToOrder,
  linesToReceive,
  listLines,
  listsOverview,
  receiveLine,
  registerOrder,
  setReady,
  updateLine,
} from '../lib/purchasing';
import { Conflict, type Tx } from '../lib/ledger';
import { actorOf, idParam, newOp, render, runTx } from '../render';
import { listPage, purchasingPage, receivingPage } from '../views/indkob';

const indkob = new Hono<AppEnv>();
const NAV = { portal: 'lager', tab: 'indkob' } as const;

async function showOverview(c: Context<AppEnv>, error?: string, status: 200 | 400 | 409 = 200) {
  const db = c.env.DB;
  const archived = c.req.query('arkiv') === '1';
  const [toOrder, lists, { results: jobs }] = await Promise.all([
    linesToOrder(db),
    listsOverview(db, { archived }),
    db.prepare("SELECT id, number, name FROM jobs WHERE status = 'aktiv' ORDER BY number").all<Pick<JobRow, 'id' | 'number' | 'name'>>(),
  ]);
  const groups = new Set(toOrder.map((l) => l.supplier_name ?? '')).size;
  return render(
    c,
    'Indkøb',
    purchasingPage({ toOrder, lists, jobs, archived, csrf: c.get('csrf'), ops: Array.from({ length: groups }, newOp), flashCode: c.req.query('besked'), error }),
    NAV,
    status,
  );
}

indkob.get('/', (c) => showOverview(c));

/** Registrerer bestilling hos én leverandør for flere linjer på én gang. */
indkob.post('/bestil', async (c) => {
  const body = await c.req.parseBody();
  const entries: { id: number; q: number; date: string }[] = [];
  const errs: string[] = [];
  for (const [k, v] of Object.entries(body)) {
    const m = /^o_(\d+)$/.exec(k);
    if (!m || typeof v !== 'string' || !v.trim()) continue;
    const q = parseQty(v);
    const date = parseDay(body[`d_${m[1]}`]);
    if (q === null || date === null) errs.push('En mængde eller dato er ikke gyldig.');
    else if (q > 0) entries.push({ id: Number(m[1]), q, date });
  }
  if (errs.length) return showOverview(c, errs[0], 400);
  if (!entries.length) return c.redirect('/lager/indkob?besked=tom', 303);
  const ref = str(body['ref'], 60);
  const res = await runTx(c, 'bestilling', body['op'], async (tx) => {
    for (const e of entries) {
      const line = await getLine(tx.db, e.id);
      if (!line) continue;
      registerOrder(tx, line, line.ordered + e.q, e.date || line.expected_date, ref || line.order_ref, null);
    }
  });
  if (!res.ok && !res.duplicate) return showOverview(c, res.error, 409);
  return c.redirect(`/lager/indkob?besked=${res.ok ? 'bestilt' : 'dublet'}`, 303);
});

indkob.post('/ny', async (c) => {
  const body = await c.req.parseBody();
  const jobId = idParam(String(body['job_id'] ?? ''));
  const name = str(body['name'], 80) || 'Indkøbsliste';
  if (jobId) {
    const job = await c.env.DB.prepare('SELECT id FROM jobs WHERE id = ?').bind(jobId).first();
    if (!job) return c.notFound();
  }
  const id = await createList(c.env.DB, { job_id: jobId, name, responsible: '', wanted_date: '', note: '' }, Math.floor(Date.now() / 1000));
  return c.redirect(`/lager/indkob/${id}?besked=oprettet`, 303);
});

async function showList(c: Context<AppEnv>, id: number, extra: { error?: string; mail?: { status: string; to: string }; status?: 200 | 400 | 409 } = {}) {
  const db = c.env.DB;
  const [overview] = (await listsOverview(db, { archived: false })).filter((l) => l.id === id);
  const list = overview ?? (await listsOverview(db, { archived: true })).find((l) => l.id === id);
  if (!list) return c.notFound();
  const [lines, sups, { results: products }, { results: users }, { results: mails }] = await Promise.all([
    listLines(db, id),
    suppliers(db),
    db.prepare('SELECT id, sku, name, unit FROM products WHERE active = 1 ORDER BY name COLLATE NOCASE').all<{ id: number; sku: string; name: string; unit: string }>(),
    db.prepare('SELECT * FROM users WHERE active = 1 ORDER BY role, name').all<User>(),
    db.prepare('SELECT * FROM mails WHERE list_id = ? ORDER BY id DESC LIMIT 10').bind(id).all<MailRow>(),
  ]);
  return render(
    c,
    list.name,
    listPage({
      list,
      lines,
      suppliers: sups,
      products,
      users,
      mails,
      csrf: c.get('csrf'),
      ops: Array.from({ length: lines.length * 2 + 3 }, newOp),
      flashCode: c.req.query('besked'),
      mail: extra.mail,
      error: extra.error,
    }),
    NAV,
    extra.status ?? 200,
  );
}

indkob.get('/:id{[0-9]+}', (c) => {
  const s = c.req.query('mail');
  return showList(c, Number(c.req.param('id')), { mail: s ? { status: s, to: c.req.query('til') ?? '' } : undefined });
});

indkob.post('/:id{[0-9]+}', async (c) => {
  const id = Number(c.req.param('id'));
  const body = await c.req.parseBody();
  const wanted = parseDay(body['wanted_date']);
  if (wanted === null) return showList(c, id, { error: 'Datoen er ikke gyldig.', status: 400 });
  await c.env.DB.prepare('UPDATE purchase_lists SET name = ?, responsible = ?, wanted_date = ?, note = ?, version = version + 1, updated_at = ? WHERE id = ?')
    .bind(str(body['name'], 80) || 'Indkøbsliste', str(body['responsible'], 254), wanted, str(body['note'], 500, { multiline: true }), Math.floor(Date.now() / 1000), id)
    .run();
  return c.redirect(`/lager/indkob/${id}?besked=gemt`, 303);
});

indkob.post('/:id{[0-9]+}/arkiver', async (c) => {
  const id = Number(c.req.param('id'));
  const body = await c.req.parseBody();
  const archive = body['archive'] === '1';
  await c.env.DB.prepare('UPDATE purchase_lists SET archived = ?, updated_at = ? WHERE id = ?').bind(archive ? 1 : 0, Math.floor(Date.now() / 1000), id).run();
  return c.redirect(`/lager/indkob/${id}?besked=${archive ? 'arkiveret' : 'genaabnet'}`, 303);
});

indkob.post('/:id{[0-9]+}/linje', async (c) => {
  const id = Number(c.req.param('id'));
  const body = await c.req.parseBody();
  const q = parseQty(body['qty']);
  const priceRaw = str(body['price'], 20);
  const price = priceRaw ? parseKr(priceRaw) : null;
  if (!q || (priceRaw && price === null)) return showList(c, id, { error: 'Angiv en gyldig mængde og pris.', status: 400 });
  const productId = idParam(String(body['product_id'] ?? ''));
  const supplierId = idParam(String(body['supplier_id'] ?? ''));
  const deliver = body['deliver_to'] === 'arbejdssted' ? 'arbejdssted' : 'lager';
  const res = await runTx(c, 'indkobslinje', body['op'], async (tx) => {
    const list = await getList(tx.db, id);
    if (!list) throw new Error('Listen findes ikke');
    if (productId) {
      const p = await getProduct(tx.db, productId);
      if (!p) throw new Error('Varen findes ikke');
      addLine(tx, list, {
        product_id: p.id,
        sku: p.sku,
        name: p.name,
        unit: p.unit,
        supplier_id: supplierId ?? p.supplier_id,
        qty: p.whole_units ? Math.ceil(q / 1000) * 1000 : q,
        unit_price: price ?? p.purchase_price,
        expected_date: '',
        deliver_to: deliver,
        note: str(body['note'], 200),
      });
    } else {
      const name = str(body['name'], 120);
      if (!name) throw new Conflict('Vælg en vare, eller skriv navnet på en vare uden varenummer.');
      addLine(tx, list, {
        product_id: null,
        sku: str(body['sku'], 40),
        name,
        unit: str(body['unit'], 20) || 'stk.',
        supplier_id: supplierId,
        qty: q,
        unit_price: price,
        expected_date: '',
        deliver_to: deliver,
        note: str(body['note'], 200),
      });
    }
  });
  if (!res.ok && !res.duplicate) return showList(c, id, { error: res.error, status: 409 });
  return c.redirect(`/lager/indkob/${id}?besked=${res.ok ? 'oprettet' : 'dublet'}`, 303);
});

indkob.post('/:id{[0-9]+}/klar', async (c) => {
  const id = Number(c.req.param('id'));
  const body = await c.req.parseBody();
  const res = await runTx(c, 'klar', body['op'], async (tx) => {
    const { results } = await tx.db.prepare('SELECT * FROM purchase_lines WHERE list_id = ? AND ready = 0 AND ordered = 0 AND cancelled = 0').bind(id).all<PurchaseLineRow>();
    setReady(tx, results, true);
  });
  return c.redirect(`/lager/indkob/${id}?besked=${res.ok ? 'gemt' : res.duplicate ? 'dublet' : 'gemt'}`, 303);
});

indkob.post('/:id{[0-9]+}/send', async (c) => {
  const id = Number(c.req.param('id'));
  const body = await c.req.parseBody();
  const userId = idParam(String(body['user_id'] ?? ''));
  const db = c.env.DB;
  const [list, user] = await Promise.all([
    getList(db, id),
    userId ? db.prepare('SELECT * FROM users WHERE id = ? AND active = 1').bind(userId).first<User>() : null,
  ]);
  if (!list) return c.notFound();
  if (!user) return showList(c, id, { error: 'Vælg en modtager.', status: 400 });
  const status = await sendPurchaseList(c.env, c.get('settings'), list, user, actorOf(c).email);
  return c.redirect(`/lager/indkob/${id}?mail=${status}&til=${encodeURIComponent(user.email)}`, 303);
});

async function lineAction(c: Context<AppEnv>, fn: (tx: Tx, line: LineViewRow, body: Record<string, unknown>) => void, kind: string) {
  const lineId = Number(c.req.param('lineId'));
  const body = await c.req.parseBody();
  const line = await getLine(c.env.DB, lineId);
  if (!line) return c.notFound();
  const res = await runTx(c, kind, body['op'], async (tx) => {
    const fresh = await getLine(tx.db, lineId);
    if (fresh) fn(tx, fresh, body);
  });
  if (!res.ok && !res.duplicate) return showList(c, line.list_id, { error: res.error, status: 409 });
  return c.redirect(`/lager/indkob/${line.list_id}?besked=${res.ok ? (kind === 'annuller' ? 'annulleret' : 'gemt') : 'dublet'}`, 303);
}

type LineViewRow = NonNullable<Awaited<ReturnType<typeof getLine>>>;

indkob.post('/linje/:lineId{[0-9]+}', (c) =>
  lineAction(
    c,
    (tx, line, body) => {
      const q = parseQty(body['qty']);
      const priceRaw = str(body['price'], 20);
      const price = priceRaw ? parseKr(priceRaw) : null;
      const date = parseDay(body['expected_date']);
      if (!q || (priceRaw && price === null) || date === null) throw new Conflict('Angiv en gyldig mængde, pris og dato.');
      updateLine(tx, line, {
        qty: line.whole_units ? Math.ceil(q / 1000) * 1000 : q,
        supplier_id: idParam(String(body['supplier_id'] ?? '')),
        unit_price: price,
        expected_date: date,
        note: str(body['note'], 200),
        deliver_to: body['deliver_to'] === 'arbejdssted' ? 'arbejdssted' : 'lager',
      });
    },
    'linje',
  ),
);

indkob.post('/linje/:lineId{[0-9]+}/klar', (c) =>
  lineAction(
    c,
    (tx, line, body) => {
      setReady(tx, [line], body['ready'] === '1');
    },
    'klar',
  ),
);

indkob.post('/linje/:lineId{[0-9]+}/annuller', (c) =>
  lineAction(
    c,
    (tx, line) => {
      cancelLine(tx, line);
    },
    'annuller',
  ),
);

/** Varemodtagelse (også delvis) af bestilte linjer fra én leverandør. */
export const modtagelse = new Hono<AppEnv>();
const RNAV = { portal: 'lager', tab: 'modtagelse' } as const;

async function showReceiving(c: Context<AppEnv>, error?: string, status: 200 | 400 | 409 = 200) {
  const lines = await linesToReceive(c.env.DB);
  const groups = new Set(lines.map((l) => l.supplier_name ?? '')).size;
  return render(
    c,
    'Varemodtagelse',
    receivingPage({ lines, csrf: c.get('csrf'), ops: Array.from({ length: groups }, newOp), flashCode: c.req.query('besked'), error }),
    RNAV,
    status,
  );
}

modtagelse.get('/', (c) => showReceiving(c));

modtagelse.post('/', async (c) => {
  const body = await c.req.parseBody();
  const entries: { id: number; q: number; price: number | null }[] = [];
  for (const [k, v] of Object.entries(body)) {
    const m = /^r_(\d+)$/.exec(k);
    if (!m || typeof v !== 'string' || !v.trim()) continue;
    const q = parseQty(v);
    const priceRaw = str(body[`p_${m[1]}`], 20);
    const price = priceRaw ? parseKr(priceRaw) : null;
    if (q === null || (priceRaw && price === null)) return showReceiving(c, 'En mængde eller pris er ikke gyldig.', 400);
    if (q > 0) entries.push({ id: Number(m[1]), q, price });
  }
  if (!entries.length) return c.redirect('/lager/modtagelse?besked=tom', 303);
  const res = await runTx(c, 'modtagelse', body['op'], async (tx) => {
    for (const e of entries) {
      const line = await getLine(tx.db, e.id);
      if (line) receiveLine(tx, line, e.q, e.price, !!line.whole_units);
    }
  });
  if (!res.ok && !res.duplicate) return showReceiving(c, res.error, 409);
  return c.redirect(`/lager/modtagelse?besked=${res.ok ? 'modtaget' : 'dublet'}`, 303);
});

export default indkob;
