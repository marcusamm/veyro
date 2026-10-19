// Produktkatalog: søgning (begge portaler), produktdetaljer, valg af vare til et job og import
// af produktfiler i lagerportalen.

import { Hono, type Context } from 'hono';
import type { AppEnv } from '../env';
import { parseIntStrict, parseQty, str } from '../lib/format';
import { addToJob, applyCatalogPrice, ensureOwnProduct, ownProductFor, type Handling } from '../lib/katalogvalg';
import { DEMO_FILES, LOAD_SOURCE, demoFile, loadTestCount, loadTestProducts, removeLoadTest } from '../lib/katalogdemo';
import { Conflict } from '../lib/ledger';
import { getJob, getProduct } from '../lib/materials';
import {
  ImportConflict,
  approveImport,
  cancelImport,
  catalogFacets,
  catalogPrices,
  catalogSources,
  createImport,
  finishUpload,
  getCatalogProduct,
  getImport,
  getSource,
  missingRows,
  parseOptions,
  previewRows,
  searchCatalog,
  stageRows,
  variantsOf,
  type SourceKind,
} from '../lib/produktkatalog';
import { requireManager, requireUser } from '../lib/session';
import { actorOf, isDemo, newOp, render, runTx } from '../render';
import {
  catalogAdminPage,
  detailPage,
  importPage,
  portalSearchPage,
  previewPage,
  reviewPage,
  selectPage,
  suggestJson,
  type Ctx,
  type SearchPanel,
} from '../views/produktkatalog';
import { NAV, isManager, jobHead, nowSec } from './jobshared';

const LAGER_NAV = { portal: 'lager', tab: 'katalog' } as const;

/** Søgeparametre fra adressen. */
export function searchParams(c: Context<AppEnv>) {
  const page = parseIntStrict(c.req.query('side') ?? '1', { max: 10_000 }) ?? 1;
  return {
    q: (c.req.query('q') ?? '').slice(0, 100),
    maker: (c.req.query('producent') ?? '').slice(0, 100),
    category: (c.req.query('kategori') ?? '').slice(0, 100),
    page: Math.max(1, page),
  };
}

/** Søgepanel med resultater (der søges kun, når der er skrevet noget eller valgt et filter). */
export async function panelFor(c: Context<AppEnv>, action: string, ctx: Ctx, opts: { perPage?: number; anchor?: string; always?: boolean; hidden?: Record<string, string>; autofocus?: boolean } = {}): Promise<SearchPanel> {
  const db = c.env.DB;
  const p = searchParams(c);
  const searching = opts.always || !!(p.q || p.maker || p.category);
  const [facets, result] = await Promise.all([
    catalogFacets(db),
    searching ? searchCatalog(db, { q: p.q, maker: p.maker, category: p.category, page: p.page, perPage: opts.perPage ?? 20 }) : Promise.resolve(null),
  ]);
  return { action, ctx, q: p.q, maker: p.maker, category: p.category, facets, result, manager: isManager(c), anchor: opts.anchor, hidden: opts.hidden, autofocus: opts.autofocus };
}

// --- Fælles: søgning og produktdetaljer (alle brugere) ---------------------------------------------

export const katalog = new Hono<AppEnv>();
katalog.use('*', requireUser);

katalog.get('/sog', async (c) => {
  const p = searchParams(c);
  const ctxRaw = c.req.query('ctx');
  const jobId = parseIntStrict(c.req.query('job') ?? '');
  const ctx: Ctx = ctxRaw === 'job' && jobId ? { kind: 'job', jobId } : ctxRaw === 'lager' && isManager(c) ? { kind: 'lager' } : ctxRaw === 'ny' && isManager(c) ? { kind: 'ny' } : { kind: 'portal' };
  const n = parseIntStrict(c.req.query('n') ?? '8', { max: 50 }) ?? 8;
  const r = await searchCatalog(c.env.DB, { q: p.q, maker: p.maker, category: p.category, page: p.page, perPage: n });
  return c.json(suggestJson(r, ctx, isManager(c)), 200, { 'Cache-Control': 'no-store' });
});

katalog.get('/:id{[0-9]+}', async (c) => {
  const db = c.env.DB;
  const cp = await getCatalogProduct(db, Number(c.req.param('id')));
  if (!cp) return c.notFound();
  const [prices, variants, own] = await Promise.all([catalogPrices(db, cp.id), variantsOf(db, cp), ownProductFor(db, cp)]);
  const manager = isManager(c);
  return render(
    c,
    cp.name,
    detailPage({ c: cp, prices, variants, own, manager, csrf: c.get('csrf'), fromNew: c.req.query('fra') === 'ny', flashCode: c.req.query('besked') }),
    manager ? LAGER_NAV : NAV('katalog'),
  );
});

// --- Jobportalen: søgning og valg af vare til et job -------------------------------------------------

export const jobKatalog = new Hono<AppEnv>();
jobKatalog.use('*', requireUser);

jobKatalog.get('/katalog', async (c) => render(c, 'Produktkatalog', portalSearchPage({ panel: await panelFor(c, '/job/katalog', { kind: 'portal' }, { autofocus: true }) }), NAV('katalog')));

type SelectValues = { qty: string; unit: string; handling: Handling; note: string; use_price: boolean };

async function showSelect(c: Context<AppEnv>, jobId: number, ref: { cid?: number; pid?: number }, values?: SelectValues, errs: string[] = [], status: 200 | 400 | 409 = 200) {
  const db = c.env.DB;
  const j = await jobHead(db, jobId);
  if (!j) return c.notFound();
  if (j.status !== 'aktiv') return c.redirect(`/job/${jobId}/materialer`, 303);
  const cp = ref.cid ? await getCatalogProduct(db, ref.cid) : null;
  if (ref.cid && !cp) return c.notFound();
  const own = cp ? await ownProductFor(db, cp) : ref.pid ? await getProduct(db, ref.pid) : null;
  if (!cp && !own) return c.notFound();
  const [prices, variants] = cp ? await Promise.all([catalogPrices(db, cp.id), variantsOf(db, cp)]) : [[], []];
  return render(
    c,
    `${j.number} vælg vare`,
    selectPage({
      job: j,
      c: cp,
      own,
      prices,
      variants,
      manager: isManager(c),
      csrf: c.get('csrf'),
      op: newOp(),
      values: values ?? { qty: '', unit: own?.unit ?? cp?.unit ?? '', handling: 'reserver', note: '', use_price: false },
      errs,
    }),
    NAV('job'),
    status,
  );
}

jobKatalog.get('/:id{[0-9]+}/materialer/katalog/:cid{[0-9]+}', (c) => showSelect(c, Number(c.req.param('id')), { cid: Number(c.req.param('cid')) }));
jobKatalog.get('/:id{[0-9]+}/materialer/vare/:pid{[0-9]+}', (c) => showSelect(c, Number(c.req.param('id')), { pid: Number(c.req.param('pid')) }));

async function addSelected(c: Context<AppEnv>, ref: { cid?: number; pid?: number }) {
  const db = c.env.DB;
  const id = Number(c.req.param('id'));
  const job = await getJob(db, id);
  if (!job) return c.notFound();
  const body = await c.req.parseBody();
  const handling: Handling = body['handling'] === 'brugt' || body['handling'] === 'forventet' ? body['handling'] : 'reserver';
  const values: SelectValues = { qty: str(body['qty'], 20), unit: str(body['unit'], 20), handling, note: str(body['note'], 200), use_price: body['use_price'] === '1' };
  const q = parseQty(body['qty']);
  if (q === null || q <= 0) return showSelect(c, id, ref, values, ['Angiv et antal større end 0.'], 400);
  const actor = actorOf(c);
  const cp = ref.cid ? await getCatalogProduct(db, ref.cid) : null;
  if (ref.cid && !cp) return c.notFound();
  let product;
  try {
    product = cp ? (await ensureOwnProduct(db, cp, values.unit, actor, nowSec())).product : await getProduct(db, ref.pid!);
  } catch (err) {
    if (err instanceof Conflict) return showSelect(c, id, ref, values, [err.message], 400);
    throw err;
  }
  if (!product) return c.notFound();
  let short = 0;
  const res = await runTx(c, 'katalogvalg', body['op'], async (tx) => {
    const [j, p] = await Promise.all([getJob(tx.db, id), getProduct(tx.db, product.id)]);
    if (!j || !p) throw new Conflict('Jobbet eller varen findes ikke længere.');
    short = (await addToJob(tx, j, p, cp?.id ?? null, q, handling, values.note)).short;
  });
  if (!res.ok && !res.duplicate) return showSelect(c, id, ref, values, [res.error], 409);
  if (res.ok && cp && values.use_price && isManager(c)) {
    const prices = await catalogPrices(db, cp.id);
    if (prices[0]) await applyCatalogPrice(db, id, product.id, prices[0], actor, nowSec());
  }
  const code = !res.ok ? 'dublet' : handling === 'reserver' ? (short ? 'katalog_mangler' : 'katalog_reserveret') : handling === 'brugt' ? 'katalog_brugt' : 'materiale_tilfojet';
  return c.redirect(`/job/${id}/materialer?besked=${code}`, 303);
}

jobKatalog.post('/:id{[0-9]+}/materialer/katalog/:cid{[0-9]+}', (c) => addSelected(c, { cid: Number(c.req.param('cid')) }));
jobKatalog.post('/:id{[0-9]+}/materialer/vare/:pid{[0-9]+}', (c) => addSelected(c, { pid: Number(c.req.param('pid')) }));

// --- Lagerportalen: kilder, import og gennemgang (ejer og indkøber) ------------------------------------

export const lagerKatalog = new Hono<AppEnv>();
lagerKatalog.use('*', requireManager);

async function showAdmin(c: Context<AppEnv>, message?: string) {
  const db = c.env.DB;
  const [panel, sources, { results: imports }, loadTest] = await Promise.all([
    panelFor(c, '/lager/katalog', { kind: 'lager' }, { always: true }),
    catalogSources(db),
    db
      .prepare("SELECT i.*, s.name AS source_name FROM catalog_imports i JOIN catalog_sources s ON s.id = i.source_id WHERE i.status <> 'upload' ORDER BY i.id DESC LIMIT 8")
      .all<import('../lib/produktkatalog').CatalogImportRow & { source_name: string }>(),
    isDemo(c) ? loadTestCount(db) : Promise.resolve(0),
  ]);
  return render(
    c,
    'Produktkatalog',
    catalogAdminPage({ panel, sources, imports, demo: isDemo(c), loadTest: loadTest ? { n: loadTest } : null, csrf: c.get('csrf'), flashCode: c.req.query('besked'), message }),
    LAGER_NAV,
  );
}

lagerKatalog.get('/', (c) => showAdmin(c));

lagerKatalog.get('/import', async (c) => {
  const sources = (await catalogSources(c.env.DB)).filter((s) => isDemo(c) || s.kind !== 'demo');
  // I demoen vælges demokilden, så demofilerne ikke lægges under en rigtig producent
  const selected = parseIntStrict(c.req.query('kilde') ?? '') ?? (isDemo(c) ? sources.find((s) => s.kind === 'demo' && s.name !== LOAD_SOURCE) : sources[0])?.id ?? null;
  return render(c, 'Importér produktfil', importPage({ sources, csrf: c.get('csrf'), selected, demo: isDemo(c) }), LAGER_NAV);
});

const jsonError = (c: Context<AppEnv>, error: string, status: 400 | 404 | 409 = 400) => c.json({ error }, status);

// 1) Opret importen (datakilde og kolonneopsætning)
lagerKatalog.post('/import', async (c) => {
  const db = c.env.DB;
  const body = await c.req.parseBody();
  const actor = actorOf(c);
  const now = nowSec();
  let sourceId = parseIntStrict(body['source_id']);
  if (body['source_id'] === 'ny') {
    const name = str(body['new_name'], 80);
    if (!name) return jsonError(c, 'Angiv et navn på den nye datakilde.');
    const kindRaw = body['new_kind'];
    const kind: SourceKind = kindRaw === 'forhandler' ? 'forhandler' : kindRaw === 'demo' && isDemo(c) ? 'demo' : 'producent';
    try {
      const r = await db
        .prepare('INSERT INTO catalog_sources (name, kind, manufacturer, created_by, created_at) VALUES (?, ?, ?, ?, ?) RETURNING id')
        .bind(name, kind, str(body['new_manufacturer'], 100), actor.email, now)
        .first<{ id: number }>();
      sourceId = r!.id;
    } catch (err) {
      if (String((err as Error).message).includes('UNIQUE')) return jsonError(c, `Der findes allerede en datakilde med navnet ${name}. Vælg den på listen.`, 409);
      throw err;
    }
  }
  const source = sourceId ? await getSource(db, sourceId) : null;
  if (!source) return jsonError(c, 'Vælg en datakilde.');
  const opts = parseOptions(typeof body['mapping'] === 'string' ? body['mapping'] : '{}');
  if (!opts.manufacturer) opts.manufacturer = source.manufacturer;
  if (!opts.columns.name) return jsonError(c, 'Vælg kolonnen med produktnavnet.');
  if (!opts.columns.mpn && !opts.columns.ean) return jsonError(c, 'Vælg kolonnen med producentens varenummer eller EAN, så varerne kan genkendes ved næste import.');
  if (!opts.manufacturer && !opts.columns.manufacturer) return jsonError(c, 'Vælg kolonnen med producenten, eller angiv producenten for kilden.');
  const id = await createImport(db, source.id, str(body['filename'], 200), opts, actor.email, now);
  return c.json({ id });
});

async function openImport(c: Context<AppEnv>) {
  const imp = await getImport(c.env.DB, Number(c.req.param('iid')));
  return imp;
}

// 2) Rækkerne i bidder (højst 500 pr. bid)
lagerKatalog.post('/import/:iid{[0-9]+}/rader', async (c) => {
  const imp = await openImport(c);
  if (!imp) return jsonError(c, 'Importen findes ikke.', 404);
  if (imp.status !== 'upload') return jsonError(c, 'Importen er allerede indlæst.', 409);
  const body = await c.req.parseBody();
  let rows: unknown;
  try {
    rows = JSON.parse(typeof body['rows'] === 'string' ? body['rows'] : '');
  } catch {
    return jsonError(c, 'Rækkerne kunne ikke læses.');
  }
  if (!Array.isArray(rows) || rows.length > 500) return jsonError(c, 'Send højst 500 rækker ad gangen.');
  const clean: { row_no: number; values: Record<string, unknown> }[] = [];
  for (const r of rows) {
    if (!r || typeof r !== 'object') return jsonError(c, 'Ugyldig række.');
    const { row_no, values } = r as { row_no?: unknown; values?: unknown };
    if (typeof row_no !== 'number' || !Number.isInteger(row_no) || row_no < 1 || row_no > 10_000_000 || !values || typeof values !== 'object') return jsonError(c, 'Ugyldig række.');
    clean.push({ row_no, values: values as Record<string, unknown> });
  }
  const r = await stageRows(c.env.DB, imp, clean);
  return c.json(r);
});

// 3) Alle rækker er sendt: tæl op til forhåndsvisningen
lagerKatalog.post('/import/:iid{[0-9]+}/klar', async (c) => {
  const imp = await openImport(c);
  if (!imp) return jsonError(c, 'Importen findes ikke.', 404);
  if (imp.status === 'upload') await finishUpload(c.env.DB, imp);
  return c.json({ url: `/lager/katalog/import/${imp.id}` });
});

lagerKatalog.get('/import/:iid{[0-9]+}', async (c) => {
  const db = c.env.DB;
  const imp = await openImport(c);
  if (!imp) return c.notFound();
  const source = (await getSource(db, imp.source_id))!;
  const tab = ['ny', 'opdater', 'uaendret', 'fejl', 'advarsel', 'mangler'].includes(c.req.query('vis') ?? '') ? c.req.query('vis')! : '';
  const page = Math.max(1, parseIntStrict(c.req.query('side') ?? '1', { max: 100_000 }) ?? 1);
  const perPage = 50;
  const [rows, missing, warn] = await Promise.all([
    tab === 'mangler' ? Promise.resolve([]) : previewRows(db, imp.id, tab, perPage, (page - 1) * perPage),
    tab === 'mangler'
      ? imp.status === 'klar'
        ? missingRows(db, imp, 200)
        : db
            .prepare("SELECT * FROM catalog_products WHERE source_id = ? AND status = 'gennemgang' AND review_note LIKE ? ORDER BY name LIMIT 200")
            .bind(imp.source_id, `%(import ${imp.id}).`)
            .all<import('../lib/produktkatalog').CatalogProductRow>()
            .then((r) => r.results)
      : Promise.resolve([]),
    db.prepare("SELECT COUNT(*) AS n FROM catalog_import_rows WHERE import_id = ? AND warnings <> ''").bind(imp.id).first<{ n: number }>(),
  ]);
  return render(
    c,
    'Import',
    previewPage({ imp, source, tab, rows, missing, warnings: warn?.n ?? 0, csrf: c.get('csrf'), page, perPage, flashCode: c.req.query('besked'), error: c.req.query('fejl')?.slice(0, 300) }),
    LAGER_NAV,
  );
});

lagerKatalog.post('/import/:iid{[0-9]+}/godkend', async (c) => {
  const imp = await openImport(c);
  if (!imp) return c.notFound();
  try {
    await approveImport(c.env.DB, imp, actorOf(c).email, nowSec(), { demo: (await getSource(c.env.DB, imp.source_id))?.kind === 'demo' });
  } catch (err) {
    const msg = String((err as Error).message);
    if (err instanceof ImportConflict) return c.redirect(`/lager/katalog/import/${imp.id}?fejl=${encodeURIComponent(err.message)}`, 303);
    if (msg.includes('ops.token') || msg.includes('UNIQUE')) return c.redirect(`/lager/katalog/import/${imp.id}?besked=dublet`, 303);
    throw err;
  }
  return c.redirect(`/lager/katalog/import/${imp.id}?besked=import_godkendt`, 303);
});

lagerKatalog.post('/import/:iid{[0-9]+}/annuller', async (c) => {
  const imp = await openImport(c);
  if (!imp) return c.notFound();
  if (imp.status === 'godkendt') return c.redirect(`/lager/katalog/import/${imp.id}`, 303);
  await cancelImport(c.env.DB, imp);
  return c.redirect('/lager/katalog?besked=import_annulleret', 303);
});

lagerKatalog.get('/gennemgang', async (c) => {
  const { results } = await c.env.DB.prepare(
    `SELECT c.*, s.name AS source_name, (SELECT id FROM products p WHERE p.catalog_product_id = c.id) AS own_id FROM catalog_products c JOIN catalog_sources s ON s.id = c.source_id
     WHERE c.status = 'gennemgang' ORDER BY s.name, c.name LIMIT 500`,
  ).all<import('../lib/produktkatalog').CatalogProductRow & { source_name: string; own_id: number | null }>();
  return render(c, 'Til gennemgang', reviewPage({ rows: results, csrf: c.get('csrf'), flashCode: c.req.query('besked') }), LAGER_NAV);
});

lagerKatalog.post('/:cid{[0-9]+}/status', async (c) => {
  const body = await c.req.parseBody();
  const status = body['status'] === 'skjult' ? 'skjult' : 'aktiv';
  const note = status === 'skjult' ? `Skjult fra søgningen af ${actorOf(c).name}.` : '';
  await c.env.DB.prepare("UPDATE catalog_products SET status = ?, review_note = ? WHERE id = ? AND status = 'gennemgang'").bind(status, note, Number(c.req.param('cid'))).run();
  return c.redirect('/lager/katalog/gennemgang?besked=gemt', 303);
});

// Opret katalogvaren i varekartoteket (uden lagerbeholdning)
lagerKatalog.post('/:cid{[0-9]+}/opret', async (c) => {
  const db = c.env.DB;
  const cp = await getCatalogProduct(db, Number(c.req.param('cid')));
  if (!cp) return c.notFound();
  const body = await c.req.parseBody();
  try {
    const r = await ensureOwnProduct(db, cp, str(body['unit'], 20), actorOf(c), nowSec());
    return c.redirect(`/lager/varer/${r.product.id}?besked=${r.created ? 'katalog_oprettet' : 'katalog_knyttet'}`, 303);
  } catch (err) {
    if (err instanceof Conflict) return c.redirect(`/katalog/${cp.id}?besked=enhed_mangler`, 303);
    throw err;
  }
});

// --- Demo: filer og belastningstest -------------------------------------------------------------

lagerKatalog.get('/demofil/:name', (c) => {
  if (!isDemo(c)) return c.notFound();
  const name = c.req.param('name');
  if (!(DEMO_FILES as readonly string[]).includes(name)) return c.notFound();
  const f = demoFile(name as (typeof DEMO_FILES)[number]);
  return c.body(f.bytes as Uint8Array<ArrayBuffer>, 200, { 'Content-Type': f.type, 'Content-Disposition': `attachment; filename="${name}"` });
});

lagerKatalog.post('/demo/belastning', async (c) => {
  if (!isDemo(c)) return c.notFound();
  const n = await loadTestProducts(c.env.DB, actorOf(c).email, nowSec());
  return c.redirect(`/lager/katalog?besked=belastning&n=${n}`, 303);
});

lagerKatalog.post('/demo/belastning/fjern', async (c) => {
  if (!isDemo(c)) return c.notFound();
  await removeLoadTest(c.env.DB);
  return c.redirect('/lager/katalog?besked=belastning_fjernet', 303);
});
