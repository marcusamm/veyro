// Import af kundeemner fra Excel/CSV (/admin/kundeemner/import). Kun ADMIN_EMAILS; tjekkes på serveren.
// Filen valideres på serveren (filtype ud fra indhold, størrelse, makroer) og læses kun som data.
import { Hono, type Context } from 'hono';
import type { AppEnv } from '../env';
import {
  MAX_IMPORT_FILE,
  autoMap,
  deleteImportFile,
  detectImportType,
  evaluate,
  getImport,
  importedProspects,
  listImports,
  loadFile,
  readOptions,
  readTable,
  runImport,
  safeImportName,
  storeImport,
  undoImport,
  type ConfirmOptions,
  type ImportRow,
} from '../lib/prospect-import';
import { SheetError } from '../lib/sheet-read';
import { render } from '../render';
import { errorPage } from '../views/pages';
import { importPreviewPage, importStartPage, importSummaryPage, undoPage } from '../views/prospect-import';
import { adminGuard } from './admin-guard';

const r = new Hono<AppEnv>();
r.use('/kundeemner/import', adminGuard);
r.use('/kundeemner/import/*', adminGuard);

const who = (c: Context<AppEnv>) => c.get('session')!.email.toLowerCase();
const nav = { nav: 'admin-kundeemner' as const, admin: true };
const idOf = (raw: string | undefined) => {
  const n = Number.parseInt(raw ?? '', 10);
  return Number.isSafeInteger(n) && n > 0 && String(n) === raw ? n : null;
};

async function load(c: Context<AppEnv>): Promise<ImportRow | null> {
  const id = idOf(c.req.param('id'));
  return id ? getImport(c.env.DB, id) : null;
}

const notFound = (c: Context<AppEnv>) =>
  render(c, 'Findes ikke', errorPage('Importen findes ikke', '', { href: '/admin/kundeemner/import', label: 'Til import' }), { status: 404, ...nav });

const start = async (c: Context<AppEnv>, error: string | null = null, status = 200) =>
  render(c, 'Importér kundeemner', importStartPage({ csrf: c.get('csrf'), imports: await listImports(c.env.DB), error, flash: c.req.query('besked') ?? null }), { ...nav, status: status as 200 });

// ---------- Upload og oversigt ----------

r.get('/kundeemner/import', (c) => start(c));

r.post('/kundeemner/import', async (c) => {
  const file = (await c.req.parseBody())['file'];
  if (!(file instanceof File) || file.size === 0) return start(c, 'Vælg en fil.', 400);
  if (file.size > MAX_IMPORT_FILE) return start(c, 'Filen er større end 5 MB. Del den op i flere filer.', 400);
  const name = safeImportName(file.name);
  const bytes = new Uint8Array(await file.arrayBuffer());
  const t = detectImportType(name, bytes);
  if ('error' in t) return start(c, t.error, 400);
  // Indholdet kontrolleres, før filen gemmes: kan den ikke læses som regneark, afvises den
  try {
    const table = await readTable(bytes, t.type, { sheet: 0, header: true, delimiter: null });
    if (!table.rows.length && !table.headers.length) return start(c, 'Filen indeholder ingen rækker.', 400);
  } catch (e) {
    if (e instanceof SheetError) return start(c, e.message, 400);
    return start(c, 'Filen kunne ikke læses som et regneark. Gem den som .xlsx eller CSV og prøv igen.', 400);
  }
  const id = await storeImport(c.env.DB, { name, type: t.type, bytes, actor: who(c) });
  return c.redirect(`/admin/kundeemner/import/${id}`, 303);
});

// ---------- Forhåndsvisning eller resultat ----------

async function preview(c: Context<AppEnv>, imp: ImportRow, get: (k: string) => string | undefined, error: string | null = null, status = 200) {
  const bytes = await loadFile(c.env.DB, imp);
  if (!bytes) return summary(c, imp, 'Originalfilen findes ikke længere. Upload filen igen.');
  const first = readOptions(get, null);
  let table = null;
  let readError: string | null = null;
  try {
    table = await readTable(bytes, imp.file_type, first.read);
  } catch (e) {
    readError = e instanceof SheetError ? e.message : 'Filen kunne ikke læses.';
  }
  const map = table ? (readOptions(get, table.headers).map ?? autoMap(table.headers)) : {};
  const ev = table && map.company !== undefined ? await evaluate(c.env.DB, imp.id, table, map) : null;
  return render(
    c,
    'Forhåndsvisning af import',
    importPreviewPage({ csrf: c.get('csrf'), imp, table, readError, header: first.read.header, delimiterChosen: first.read.delimiter !== null, map, ev, error }),
    { ...nav, status: status as 200 },
  );
}

async function summary(c: Context<AppEnv>, imp: ImportRow, error: string | null = null, status = 200) {
  const remaining = (await c.env.DB.prepare('SELECT COUNT(*) AS n FROM prospects WHERE import_id = ?').bind(imp.id).first<{ n: number }>())?.n ?? 0;
  const canResume = imp.status === 'importerer' && !!imp.started_at && imp.started_at < Math.floor(Date.now() / 1000) - 300 && !imp.file_deleted_at;
  return render(c, imp.file_name, importSummaryPage({ csrf: c.get('csrf'), imp, remaining, flash: c.req.query('besked') ?? null, error, canResume }), { ...nav, status: status as 200 });
}

r.get('/kundeemner/import/:id', async (c) => {
  const imp = await load(c);
  if (!imp) return notFound(c);
  if (imp.status === 'uploadet' && !imp.file_deleted_at) return preview(c, imp, (k) => c.req.query(k));
  return summary(c, imp);
});

r.post('/kundeemner/import/:id/bekraeft', async (c) => {
  const imp = await load(c);
  if (!imp) return notFound(c);
  const body = await c.req.parseBody({ all: true });
  const get = (k: string) => {
    const v = body[k];
    return typeof v === 'string' ? v : undefined;
  };
  const list = (k: string) => ([] as unknown[]).concat(body[k] ?? []).map((v) => Number.parseInt(String(v), 10)).filter((n) => Number.isSafeInteger(n));
  if (imp.status !== 'uploadet') return c.redirect(`/admin/kundeemner/import/${imp.id}`, 303);
  const opts = readOptions(get, null);
  const confirm: ConfirmOptions = {
    ...opts.read,
    map: opts.map ?? {},
    skipErrors: get('spring_fejl') === '1',
    dupOk: list('dublet_ok'),
    includeBlocked: get('medtag_blokerede') === '1',
    blockReason: (get('blokering_aarsag') ?? '').trim().slice(0, 300) || null,
  };
  const res = await runImport(c.env.DB, imp, confirm, who(c));
  if (!res.ok) {
    if (res.already) return c.redirect(`/admin/kundeemner/import/${imp.id}`, 303);
    // Vis forhåndsvisningen igen med de samme valg
    return preview(c, imp, get, res.error, 400);
  }
  return c.redirect(`/admin/kundeemner/import/${imp.id}`, 303);
});

/** Genoptager en afbrudt import med de valg, der blev bekræftet. Rækker, der allerede er oprettet, springes over. */
r.post('/kundeemner/import/:id/genoptag', async (c) => {
  const imp = await load(c);
  if (!imp) return notFound(c);
  if (imp.status !== 'importerer' || !imp.options) return c.redirect(`/admin/kundeemner/import/${imp.id}`, 303);
  const res = await runImport(c.env.DB, imp, JSON.parse(imp.options) as ConfirmOptions, who(c));
  if (!res.ok && !res.already) return summary(c, imp, res.error, 400);
  return c.redirect(`/admin/kundeemner/import/${imp.id}`, 303);
});

// ---------- Originalfilen ----------

r.get('/kundeemner/import/:id/fil', async (c) => {
  const imp = await load(c);
  if (!imp) return notFound(c);
  const bytes = await loadFile(c.env.DB, imp);
  if (!bytes) return c.text('Filen er slettet.', 404);
  const type = imp.file_type === 'xlsx' ? 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' : 'text/csv; charset=utf-8';
  const ascii = imp.file_name.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '');
  return c.body(bytes as any, 200, {
    'Content-Type': type,
    'Content-Disposition': `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(imp.file_name)}`,
    'Cache-Control': 'private, no-store',
    'X-Content-Type-Options': 'nosniff',
    'Content-Security-Policy': "default-src 'none'; sandbox",
  });
});

r.post('/kundeemner/import/:id/slet-fil', async (c) => {
  const imp = await load(c);
  if (!imp) return notFound(c);
  if ((await c.req.parseBody())['confirm'] !== '1') return summary(c, imp, 'Bekræft, at originalfilen skal slettes.', 400);
  await deleteImportFile(c.env.DB, imp, who(c));
  return c.redirect('/admin/kundeemner/import?besked=fil-slettet', 303);
});

// ---------- Fortryd import ----------

r.get('/kundeemner/import/:id/fortryd', async (c) => {
  const imp = await load(c);
  if (!imp) return notFound(c);
  const rows = await importedProspects(c.env.DB, imp.id);
  return render(c, 'Fortryd import', undoPage({ csrf: c.get('csrf'), imp, rows, error: null, result: null }), nav);
});

r.post('/kundeemner/import/:id/fortryd', async (c) => {
  const imp = await load(c);
  if (!imp) return notFound(c);
  const body = await c.req.parseBody({ all: true });
  const ids = ([] as unknown[]).concat(body['id'] ?? []).map((v) => Number.parseInt(String(v), 10));
  let error: string | null = null;
  let result: { deleted: number; kept: number } | null = null;
  if (body['confirm'] !== '1') error = 'Bekræft sletningen.';
  else if (!ids.length) error = 'Vælg mindst ét kundeemne.';
  else result = await undoImport(c.env.DB, imp, ids, who(c));
  const fresh = (await getImport(c.env.DB, imp.id)) ?? imp;
  const rows = await importedProspects(c.env.DB, imp.id);
  return render(c, 'Fortryd import', undoPage({ csrf: c.get('csrf'), imp: fresh, rows, error, result }), { ...nav, status: error ? 400 : 200 });
});

export default r;
