// Bilag i begge portaler: /lager/bilag (lagerportalens menu) og /job/bilag (jobportalens menu).
// Medarbejdere kan uploade og se egne bilag og udlæg; ejer og indkøber kan alt.

import { Hono, type Context } from 'hono';
import type { AppEnv } from '../env';
import {
  addAllocation,
  allocations,
  approveBilag,
  bilagEvents,
  bilagLines,
  canEditData,
  canSee,
  checkBilag,
  createBilag,
  getBilag,
  getBilagEvidence,
  ensureBilagEvidence,
  BilagEvidenceError,
  isDocType,
  isPayment,
  listBilag,
  performAllocation,
  purchaseSuggestions,
  deleteBilag,
  deleteBlocker,
  removeAllocation,
  saveBilag,
  setStatus,
  bilagNo,
  eventStmt,
  exportState,
  validateAlloc,
  type AllocAction,
  type AllocTarget,
  type BilagFilter,
  type BilagRow,
  type LineInput,
} from '../lib/bilag';
import { ocrJob, requestBilagRead, wakeOcrQueue } from '../lib/bilagqueue';
import { askBilag, BilagChatError, chatHistory, reserveChatRequest, type ChatReply } from '../lib/bilagchat';
import { buildExport, bilagViewPdf } from '../lib/bilagexport';
import { FILE_MAX_BYTES, UPLOAD_MAX_FILES, fileBytes, getFile, safeName, storeFile } from '../lib/files';
import { normalizeEmail, parseDay, parseKr, parseQty, str } from '../lib/format';
import { Conflict } from '../lib/ledger';
import { canManage, requireUser } from '../lib/session';
import { actorOf, idParam, isDemo, newOp, render, runTx } from '../render';
import { bilagTabs, detailPage, exportPage, listPage, uploadPage, type ExportRow } from '../views/bilag';
import type { Nav } from '../views/layout';

type Portal = 'lager' | 'job';
const now = () => Math.floor(Date.now() / 1000);

export function bilagRoutes(portal: Portal) {
  const r = new Hono<AppEnv>();
  const base = `/${portal}/bilag`;
  const nav = (): Nav => (portal === 'lager' ? { portal: 'lager', tab: 'bilag' } : { portal: 'job', tab: 'bilag' });
  r.use('*', requireUser);
  // Lagerportalen er kun for ejer og indkøber
  if (portal === 'lager')
    r.use('*', async (c, next) => {
      if (!canManage(c.get('session')!.user)) return c.redirect('/job/bilag', 303);
      await next();
    });

  const user = (c: Context<AppEnv>) => c.get('session')!.user;
  const manager = (c: Context<AppEnv>) => canManage(user(c));

  async function jobsList(db: D1Database) {
    const { results } = await db.prepare("SELECT id, number, name FROM jobs WHERE status <> 'annulleret' ORDER BY status = 'afsluttet', number DESC LIMIT 300").all<{ id: number; number: string; name: string }>();
    return results;
  }
  async function usersList(db: D1Database) {
    const { results } = await db.prepare('SELECT email, name FROM users WHERE active = 1 ORDER BY name COLLATE NOCASE').all<{ email: string; name: string }>();
    return results;
  }
  async function counts(c: Context<AppEnv>) {
    const owner = manager(c) ? null : user(c).email;
    const o = owner ? ' AND (uploaded_by = ?1 OR paid_by = ?1)' : '';
    const row = await c.env.DB.prepare(
      `SELECT (SELECT COUNT(*) FROM bilag WHERE status IN ('modtaget', 'under_aflaesning', 'klar', 'afklaring')${o}) AS open,
         (SELECT COUNT(*) FROM bilag WHERE payment = 'medarbejder' AND reimbursed_at IS NULL AND status <> 'arkiveret'${o}) AS outlay,
         (SELECT COUNT(*) FROM bilag WHERE status IN ('godkendt', 'arkiveret') AND approved_version = version AND (exported_version IS NULL OR exported_version <> version OR export_failed = 1)) AS ready`,
    )
      .bind(...(owner ? [owner] : []))
      .first<{ open: number; outlay: number; ready: number }>();
    return row ?? { open: 0, outlay: 0, ready: 0 };
  }

  // --- Oversigt ---
  async function showList(c: Context<AppEnv>, tab: 'alle' | 'aabne' | 'udlaeg') {
    const q = c.req.query();
    const f: BilagFilter = {
      q: str(q['q'], 80),
      status: tab === 'aabne' ? 'aaben' : str(q['status'], 20),
      payment: tab === 'udlaeg' ? 'medarbejder' : str(q['payment'], 20),
      type: str(q['type'], 20),
      job: q['job'] === '-1' ? -1 : idParam(q['job']),
      from: parseDay(q['fra']) ?? '',
      to: parseDay(q['til']) ?? '',
      owner: manager(c) ? null : user(c).email,
    };
    const [rows, jobs, cnt] = await Promise.all([listBilag(c.env.DB, f), jobsList(c.env.DB), counts(c)]);
    return render(
      c,
      'Bilag',
      listPage({ base, rows, f: { q: f.q, status: f.status, payment: tab === 'udlaeg' ? '' : f.payment, type: f.type, job: q['job'] ?? '', from: f.from, to: f.to }, tab: f.status === 'aaben' ? 'aabne' : tab, jobs, manager: manager(c), counts: cnt, flashCode: q['besked'] }),
      nav(),
    );
  }
  r.get('/', (c) => showList(c, 'alle'));
  r.get('/udlaeg', (c) => showList(c, 'udlaeg'));

  // --- Upload ---
  async function showUpload(c: Context<AppEnv>, errs: string[] = []) {
    const [jobs, users] = await Promise.all([jobsList(c.env.DB), usersList(c.env.DB)]);
    return render(
      c,
      'Upload bilag',
      uploadPage({ base, csrf: c.get('csrf'), op: newOp(), jobs, users, me: user(c).email, manager: manager(c), jobId: idParam(c.req.query('job')), origin: str(c.req.query('fra'), 20), errs }),
      nav(),
      errs.length ? 400 : 200,
    );
  }
  r.get('/ny', (c) => showUpload(c));
  r.post('/ny', async (c) => {
    const db = c.env.DB;
    const body = await c.req.parseBody({ all: true });
    const files = ([] as unknown[]).concat(body['files'] ?? []).filter((f): f is File => f instanceof File && f.size > 0);
    if (!files.length) return showUpload(c, ['Vælg mindst én fil eller tag et billede.']);
    if (files.length > UPLOAD_MAX_FILES) return showUpload(c, [`Højst ${UPLOAD_MAX_FILES} filer ad gangen.`]);
    const one = (k: string) => {
      const v = body[k];
      return Array.isArray(v) ? v[0] : v;
    };
    const docType = isDocType(one('doc_type')) ? (one('doc_type') as BilagRow['doc_type']) : 'kvittering';
    const payment = isPayment(one('payment')) ? (one('payment') as BilagRow['payment']) : 'uafklaret';
    let paidBy = payment === 'medarbejder' ? (normalizeEmail(one('paid_by')) ?? '') : '';
    if (payment === 'medarbejder' && !manager(c)) paidBy = user(c).email;
    const jobId = idParam(String(one('job_id') ?? ''));
    if (jobId && !(await db.prepare('SELECT 1 FROM jobs WHERE id = ?').bind(jobId).first())) return showUpload(c, ['Jobbet findes ikke.']);
    const actor = actorOf(c);
    const errs: string[] = [];
    const ids: number[] = [];
    const notes: string[] = [];
    for (const f of files) {
      if (f.size > FILE_MAX_BYTES) {
        errs.push(`${f.name}: filen er for stor (højst ${FILE_MAX_BYTES / 1024 / 1024} MB).`);
        continue;
      }
      const t = now();
      const res = await storeFile(db, new Uint8Array(await f.arrayBuffer()), actor.email, t);
      if (!res.ok) {
        errs.push(`${f.name}: ${res.error}`);
        continue;
      }
      const id = await createBilag(
        db,
        res.file,
        safeName(f.name, 'bilag'),
        { doc_type: docType, payment, paid_by: paidBy, job_hint: jobId, origin: str(one('origin'), 20), note: str(one('note'), 300), preview_file_id: null },
        actor,
        t,
      );
      ids.push(id);
      const read = await requestBilagRead(c.env, c.get('settings'), id, actor, t);
      notes.push(read.message);
    }
    if (!ids.length) return showUpload(c, errs);
    if (ids.length === 1 && !errs.length) return c.redirect(`${base}/${ids[0]}?besked=uploadet`, 303);
    return c.redirect(`${base}?status=aaben&besked=uploadet${errs.length ? `&fejl=${errs.length}` : ''}`, 303);
  });

  // --- Eksport (kun ejer og indkøber) ---
  async function showExport(c: Context<AppEnv>, errs: string[] = []) {
    const db = c.env.DB;
    const [ready, inv, { results: history }, jobs, cnt] = await Promise.all([
      listBilag(db, { q: '', status: '', payment: '', type: '', job: null, from: '', to: '', owner: null }, 1000),
      db.prepare("SELECT COUNT(*) AS n FROM invoices WHERE status = 'udstedt' AND exported_at IS NULL").first<{ n: number }>(),
      db.prepare('SELECT e.*, j.number AS job_number FROM exports e LEFT JOIN jobs j ON j.id = e.job_id ORDER BY e.id DESC LIMIT 50').all<ExportRow>(),
      jobsList(db),
      counts(c),
    ]);
    return render(
      c,
      'Eksport til bogholder',
      exportPage({
        base,
        csrf: c.get('csrf'),
        op: newOp(),
        tabs: bilagTabs(base, 'eksport', cnt, true),
        ready: ready.filter((b) => exportState(b) === 'klar' || exportState(b) === 'fejlet'),
        changed: ready.filter((b) => exportState(b) === 'aendret'),
        invoicesReady: inv?.n ?? 0,
        history,
        jobs,
        flashCode: c.req.query('besked'),
        errs,
      }),
      nav(),
      errs.length ? 400 : 200,
    );
  }
  r.get('/eksport', (c) => (manager(c) ? showExport(c) : c.redirect(base, 303)));
  r.post('/eksport', async (c) => {
    if (!manager(c)) return c.redirect(base, 303);
    const db = c.env.DB;
    const body = await c.req.parseBody();
    const inp = { from: parseDay(body['fra']) ?? '', to: parseDay(body['til']) ?? '', jobId: idParam(String(body['job_id'] ?? '')), views: body['views'] === '1', all: body['all'] === '1' };
    if (inp.from && inp.to && inp.from > inp.to) return showExport(c, ['Fra-datoen er efter til-datoen.']);
    const actor = actorOf(c);
    const t = now();
    const ex = await db
      .prepare('INSERT INTO exports (scope, date_from, date_to, job_id, with_views, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING id')
      .bind(inp.jobId ? 'job' : 'periode', inp.from, inp.to, inp.jobId, inp.views ? 1 : 0, actor.name, t)
      .first<{ id: number }>();
    const id = ex!.id;
    const out = await buildExport(c.env, c.get('settings'), inp, id, isDemo(c));
    if (!out.bilag.length && !out.invoices.length) {
      await db.prepare('DELETE FROM exports WHERE id = ?').bind(id).run();
      return showExport(c, ['Der er intet nyt at eksportere med de valgte kriterier. Kun godkendte bilag og udstedte fakturaer eksporteres.']);
    }
    const stored = await storeFile(db, out.bytes, actor.email, t, ['zip'], 90 * 1024 * 1024);
    if (!stored.ok) {
      await db.prepare('DELETE FROM exports WHERE id = ?').bind(id).run();
      return showExport(c, [`Eksporten kunne ikke gemmes: ${stored.error}`]);
    }
    const stmts: D1PreparedStatement[] = [
      db.prepare('UPDATE exports SET file_id = ?, bilag_count = ?, invoice_count = ? WHERE id = ?').bind(stored.file.id, out.bilag.length, out.invoices.length, id),
    ];
    for (const b of out.bilag) {
      stmts.push(
        db.prepare("INSERT INTO export_items (export_id, kind, ref_id, version, data) VALUES (?, 'bilag', ?, ?, ?)").bind(id, b.id, b.version, JSON.stringify({ total: b.total, net: b.net, vat: b.vat, supplier: b.supplier_name, number: b.doc_number, date: b.doc_date })),
        db.prepare('UPDATE bilag SET exported_version = ?, exported_at = ?, export_id = ?, export_failed = 0 WHERE id = ? AND version = ?').bind(b.version, t, id, b.id, b.version),
        eventStmt(db, b.id, b.version, 'eksport', `Eksporteret til bogholder (eksport #${id}). Ikke bogført.`, actor, t),
      );
    }
    for (const i of out.invoices) {
      stmts.push(
        db.prepare("INSERT INTO export_items (export_id, kind, ref_id, version, data) VALUES (?, 'faktura', ?, 1, ?)").bind(id, i.id, JSON.stringify({ number: i.number, total: i.total, outstanding: i.st.outstanding })),
        db.prepare('UPDATE invoices SET exported_at = ?, export_id = ? WHERE id = ?').bind(t, id, i.id),
      );
    }
    await db.batch(stmts);
    return c.redirect(`${base}/eksport?besked=eksporteret`, 303);
  });
  r.get('/eksport/:file{[0-9]+\\.zip}', async (c) => {
    if (!manager(c)) return c.redirect(base, 303);
    const db = c.env.DB;
    const id = parseInt(c.req.param('file'), 10);
    const e = await db.prepare('SELECT * FROM exports WHERE id = ?').bind(id).first<{ id: number; file_id: number | null; created_at: number }>();
    const f = e?.file_id ? await getFile(db, e.file_id) : null;
    const bytes = f ? await fileBytes(db, f) : null;
    if (!bytes) return c.notFound();
    return c.body(bytes as Uint8Array<ArrayBuffer>, 200, {
      'Content-Type': 'application/zip',
      'Content-Disposition': `attachment; filename="bogholder-eksport-${id}.zip"`,
    });
  });
  r.post('/eksport/:id{[0-9]+}/fejlet', async (c) => {
    if (!manager(c)) return c.redirect(base, 303);
    const db = c.env.DB;
    const id = Number(c.req.param('id'));
    const body = await c.req.parseBody();
    const err = str(body['error'], 200) || 'Overførslen til bogholderen fejlede.';
    const actor = actorOf(c);
    const t = now();
    const { results: items } = await db.prepare("SELECT ref_id, version FROM export_items WHERE export_id = ? AND kind = 'bilag'").bind(id).all<{ ref_id: number; version: number }>();
    await db.batch([
      db.prepare("UPDATE exports SET status = 'fejlet', error = ? WHERE id = ?").bind(err, id),
      db.prepare("UPDATE invoices SET exported_at = NULL, export_id = NULL WHERE export_id = ?").bind(id),
      db.prepare('UPDATE bilag SET export_failed = 1 WHERE export_id = ?').bind(id),
      ...items.map((i) => eventStmt(db, i.ref_id, i.version, 'eksport', `Overførsel fejlet (eksport #${id}): ${err}`, actor, t)),
    ]);
    return c.redirect(`${base}/eksport?besked=fejlet`, 303);
  });

  // --- Et bilag ---
  async function load(c: Context<AppEnv>): Promise<BilagRow | null> {
    const id = idParam(c.req.param('id'));
    const b = id ? await getBilag(c.env.DB, id) : null;
    return b && canSee(b, user(c)) ? b : null;
  }

  async function showDetail(c: Context<AppEnv>, b: BilagRow, errs: string[] = [], message?: string, chatResult?: ChatReply & { question: string }) {
    const db = c.env.DB;
    const s = c.get('settings');
    const [full, f, lines, allocs, events, jobs, users, { results: products }, ocr] = await Promise.all([
      db
        .prepare('SELECT b.*, u.name AS uploader, pu.name AS payer, au.name AS approver FROM bilag b LEFT JOIN users u ON u.email = b.uploaded_by LEFT JOIN users pu ON pu.email = b.paid_by LEFT JOIN users au ON au.email = b.approved_by WHERE b.id = ?')
        .bind(b.id)
        .first<BilagRow & { uploader: string | null; payer: string | null; approver: string | null }>(),
      getFile(db, b.file_id),
      bilagLines(db, b.id),
      allocations(db, b.id),
      bilagEvents(db, b.id),
      jobsList(db),
      usersList(db),
      db.prepare('SELECT id, sku, name, unit FROM products WHERE active = 1 ORDER BY name COLLATE NOCASE LIMIT 2000').all<{ id: number; sku: string; name: string; unit: string }>(),
      ocrJob(db, b.id),
    ]);
    const suggestions = manager(c) ? await purchaseSuggestions(db, b, lines) : [];
    const dupOf = b.dup_of ? await db.prepare('SELECT id, supplier_name, total FROM bilag WHERE id = ?').bind(b.dup_of).first<{ id: number; supplier_name: string; total: number | null }>() : null;
    const evidence = c.env.RECEIPT_CHAT ? await getBilagEvidence(db, b.id) : null;
    return render(
      c,
      bilagNo(b.id),
      detailPage({
        base,
        csrf: c.get('csrf'),
        op: newOp(),
        b: full!,
        file: { mime: f?.mime ?? '', pages: f?.pages ?? null, size: f?.size ?? 0 },
        lines,
        allocs,
        events,
        ocr,
        ocrConfigured: !!c.env.RECEIPT_OCR && !!c.env.BILAG_OCR_QUEUE,
        chat: { available: !!c.env.RECEIPT_CHAT, ready: !!evidence,
          message: !c.env.RECEIPT_CHAT ? 'Bilagschatten er ikke tilsluttet på denne installation.' : !evidence ? 'Skriv dit spørgsmål. Chatten henter selv bilagets tekst første gang; det kan tage op til to minutter. De gemte felter ændres ikke.' : undefined,
          ...chatResult },
        checks: checkBilag(b, lines, allocs, s),
        canEdit: canEditData(b, user(c)),
        canDelete: (canEditData(b, user(c)) || manager(c)) && !(await deleteBlocker(db, b)),
        manager: manager(c),
        jobs,
        products,
        users,
        suggestions,
        dupOf,
        vatRegistered: s.vat_registered !== 'nej',
        flashCode: c.req.query('besked'),
        message,
        errs,
      }),
      nav(),
      errs.length ? 400 : 200,
    );
  }

  r.get('/:id{[0-9]+}', async (c) => {
    const b = await load(c);
    if (b?.reading_token) c.executionCtx.waitUntil(wakeOcrQueue(c.env));
    return b ? showDetail(c, b) : c.notFound();
  });

  // Read-only status for support/polling, with the same document access check.
  // No tokens, actors or document text are returned, and no work is enqueued.
  r.get('/:id{[0-9]+}/ocr-status', async (c) => {
    const b = await load(c);
    if (!b) return c.notFound();
    const job = await ocrJob(c.env.DB, b.id);
    return c.json({ ready: !!(await getBilagEvidence(c.env.DB, b.id)), job: job ? {
      state: job.state, attempts: job.attempts, queued_at: job.queued_at,
      available_at: job.available_at, started_at: job.started_at, lease_until: job.lease_until,
      finished_at: job.finished_at, last_error: job.last_error,
    } : null });
  });

  // Questions are read-only. The existing per-document authorization and CSRF
  // middleware also apply here; neither the model nor its reply can post data.
  r.post('/:id{[0-9]+}/spoerg', async (c) => {
    const b = await load(c);
    if (!b) return c.notFound();
    const body = await c.req.parseBody();
    const question = typeof body.question === 'string' ? body.question.trim() : '';
    try {
      if (!question || question.length > 1000) throw new BilagChatError('Skriv et spørgsmål på højst 1.000 tegn.', 400);
      if (String(body.file_id) !== String(b.file_id) || String(body.version) !== String(b.version)) throw new BilagChatError('Bilaget er ændret. Genindlæs siden før du spørger igen.', 409);
      if (!c.env.RECEIPT_CHAT) throw new BilagChatError('Bilagschatten er ikke tilsluttet på denne installation.', 503);
      const history = chatHistory(typeof body.history === 'string' ? body.history : '');
      await reserveChatRequest(c.env.DB, user(c).email, now());
      const evidence = await ensureBilagEvidence(c.env, b, now());
      const reply = await askBilag(c.env, b, evidence, question, history);
      const [current, currentEvidence] = await Promise.all([getBilag(c.env.DB, b.id), getBilagEvidence(c.env.DB, b.id)]);
      if (!current || !canSee(current, user(c)) || current.file_id !== b.file_id || current.version !== b.version || current.data_revision !== b.data_revision || currentEvidence?.read_at !== evidence.read_at) throw new BilagChatError('Bilaget blev ændret, mens chatten svarede. Genindlæs siden og stil spørgsmålet igen.', 409);
      return c.req.header('Accept')?.includes('application/json') ? c.json(reply) : showDetail(c, current, [], undefined, { ...reply, question });
    } catch (error) {
      const known = error instanceof BilagChatError || error instanceof BilagEvidenceError ? error : new BilagChatError('Chatten kunne ikke svare. Dit bilag er uændret; prøv igen senere.', 503);
      if (c.req.header('Accept')?.includes('application/json')) return c.json({ error: known.message }, known.status);
      return showDetail(c, b, [known.message]);
    }
  });

  // Originalfilen (uændret). Må vises i en ramme på appens egne sider, men kan aldrig køre kode.
  r.get('/:id{[0-9]+}/fil', async (c) => {
    const b = await load(c);
    const f = b ? await getFile(c.env.DB, b.file_id) : null;
    const bytes = f ? await fileBytes(c.env.DB, f) : null;
    if (!b || !f || !bytes) return c.notFound();
    const download = c.req.query('hent') === '1';
    return c.body(bytes as Uint8Array<ArrayBuffer>, 200, {
      'Content-Type': f.mime,
      'Content-Disposition': `${download ? 'attachment' : 'inline'}; filename="${b.file_name.replace(/[^\w.\-æøåÆØÅ ]/g, '_')}"`,
      'Content-Security-Policy': "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; plugin-types application/pdf; frame-ancestors 'self'",
      'X-Frame-Options': 'SAMEORIGIN',
      'Cache-Control': 'private, max-age=3600',
    });
  });

  r.get('/:id{[0-9]+}/visning.pdf', async (c) => {
    const b = await load(c);
    if (!b) return c.notFound();
    const bytes = await bilagViewPdf(b, await bilagLines(c.env.DB, b.id), c.get('settings'), isDemo(c));
    return c.body(bytes as Uint8Array<ArrayBuffer>, 200, {
      'Content-Type': 'application/pdf',
      'Content-Disposition': `inline; filename="${bilagNo(b.id)}-digital-visning.pdf"`,
    });
  });

  r.post('/:id{[0-9]+}', async (c) => {
    const db = c.env.DB;
    const b = await load(c);
    if (!b) return c.notFound();
    const body = await c.req.parseBody({ all: true });
    const one = (k: string): string => {
      const v = body[k];
      const x = Array.isArray(v) ? v[0] : v;
      return typeof x === 'string' ? x : '';
    };
    const many = (k: string): string[] => ([] as unknown[]).concat(body[k] ?? []).map((x) => (typeof x === 'string' ? x : ''));
    const action = one('do');
    const actor = actorOf(c);
    const t = now();
    const go = (code: string) => c.redirect(`${base}/${b.id}?besked=${code}`, 303);
    const isMgr = manager(c);
    const s = c.get('settings');

    if (action === 'gem') {
      if (!canEditData(b, user(c)) && !isMgr) return showDetail(c, b, ['Du kan ikke rette dette bilag.']);
      const errs: string[] = [];
      const money = (k: string, label: string, allowNeg = false): number | null => {
        const raw = one(k).trim();
        if (!raw) return null;
        const n = parseKr(raw.replace(/^-/, ''));
        if (n === null) {
          errs.push(`${label} er ikke et gyldigt beløb.`);
          return null;
        }
        return allowNeg && raw.startsWith('-') ? -n : n;
      };
      const editable = canEditData(b, user(c));
      const pay = isPayment(one('payment')) ? (one('payment') as BilagRow['payment']) : b.payment;
      const data = editable
        ? {
            doc_type: isDocType(one('doc_type')) ? (one('doc_type') as BilagRow['doc_type']) : b.doc_type,
            supplier_name: str(one('supplier_name'), 200),
            supplier_cvr: str(one('supplier_cvr'), 20).replace(/\s/g, ''),
            doc_number: str(one('doc_number'), 60),
            doc_date: parseDay(one('doc_date')) ?? '',
            due_date: parseDay(one('due_date')) ?? '',
            currency: (str(one('currency'), 3) || 'DKK').toUpperCase(),
            net: money('net', 'Ekskl. moms'),
            vat: money('vat', 'Moms'),
            total: money('total', 'Total'),
            rounding: money('rounding', 'Afrunding', true) ?? 0,
            line_prices: one('line_prices') === 'inkl' ? ('inkl' as const) : ('ekskl' as const),
            payment_info: str(one('payment_info'), 300),
          }
        : {
            doc_type: b.doc_type,
            supplier_name: b.supplier_name,
            supplier_cvr: b.supplier_cvr,
            doc_number: b.doc_number,
            doc_date: b.doc_date,
            due_date: b.due_date,
            currency: b.currency,
            net: b.net,
            vat: b.vat,
            total: b.total,
            rounding: b.rounding,
            line_prices: b.line_prices,
            payment_info: b.payment_info,
          };
      const paidBy = pay === 'medarbejder' ? (isMgr ? (normalizeEmail(one('paid_by')) ?? '') : b.paid_by || user(c).email) : '';
      let lines: LineInput[] | null = null;
      if (editable) {
        const ids = many('l_id');
        const names = many('l_name');
        const del = new Set(many('l_del'));
        lines = [];
        names.forEach((n, i) => {
          const name = str(n, 200);
          if (!name || del.has(String(i))) return;
          const qtyRaw = many('l_qty')[i] ?? '';
          const qty = qtyRaw.trim() ? parseQty(qtyRaw) : null;
          if (qtyRaw.trim() && qty === null) errs.push(`Antal på "${name}" er ikke gyldigt.`);
          const vatRaw = (many('l_vat')[i] ?? '').trim().replace(',', '.');
          const vat = vatRaw ? Math.round(parseFloat(vatRaw) * 100) : null;
          if (vatRaw && (vat === null || !Number.isFinite(vat) || vat < 0 || vat > 10000)) errs.push(`Momssatsen på "${name}" er ikke gyldig.`);
          const m = (k: string) => {
            const raw = (many(k)[i] ?? '').trim();
            if (!raw) return null;
            const v = parseKr(raw.replace(/^-/, ''));
            if (v === null) errs.push(`Et beløb på "${name}" er ikke gyldigt.`);
            return v === null ? null : raw.startsWith('-') ? -v : v;
          };
          lines!.push({
            id: idParam(ids[i]),
            name,
            qty,
            unit: str(many('l_unit')[i], 20),
            unit_price: m('l_price'),
            discount: m('l_disc') ?? 0,
            amount: m('l_amount'),
            vat_rate: vat !== null && Number.isFinite(vat) ? vat : null,
            product_id: idParam(many('l_product')[i]),
          });
        });
      }
      if (errs.length) return showDetail(c, b, errs);
      try {
        await saveBilag(db, b, { ...data, payment: pay, paid_by: paidBy, note: str(one('note'), 1000, { multiline: true }) }, lines, actor, t, { confirmOCR: editable && one('confirm_ocr') === '1' });
      } catch (error) {
        if (error instanceof Conflict) return showDetail(c, b, [error.message]);
        throw error;
      }
      return go('gemt');
    }

    if (action === 'slet') {
      if (!canEditData(b, user(c)) && !isMgr) return showDetail(c, b, ['Du kan ikke slette dette bilag.']);
      const err = await deleteBilag(db, b);
      return err ? showDetail(c, b, [err]) : c.redirect(`${base}?besked=slettet`, 303);
    }

    if (action === 'laes') {
      if (!canEditData(b, user(c))) return showDetail(c, b, ['Bilaget kan ikke aflæses igen.']);
      const res = await requestBilagRead(c.env, s, b.id, actor, t);
      return showDetail(c, (await getBilag(db, b.id))!, [], res.message);
    }

    // Resten kræver ejer eller indkøber
    if (!isMgr) return showDetail(c, b, ['Kun ejer og indkøber kan fordele, godkende og ændre status.']);

    if (action === 'fordel') {
      const target = (['job', 'lager', 'drift'].includes(one('target')) ? one('target') : 'drift') as AllocTarget;
      const act = (['eksisterende', 'ny_modtagelse', 'direkte_job', 'udgift'].includes(one('action')) ? one('action') : 'udgift') as AllocAction;
      const amount = parseKr(one('amount'));
      if (amount === null) return showDetail(c, b, ['Angiv beløbet.']);
      const qtyRaw = one('qty').trim();
      const a = {
        line_id: idParam(one('line_id')),
        target,
        job_id: idParam(one('job_id')),
        amount,
        action: act,
        purchase_line_id: idParam(one('purchase_line_id')),
        product_id: idParam(one('product_id')),
        qty: qtyRaw ? parseQty(qtyRaw) : null,
        note: str(one('note'), 200),
      };
      const err = await validateAlloc(db, b, a);
      if (err) return showDetail(c, b, [err]);
      await addAllocation(db, b, a, actor, t);
      return go('fordelt');
    }
    if (action === 'fjern') {
      const err = await removeAllocation(db, b, idParam(one('alloc')) ?? 0, actor, t);
      return err ? showDetail(c, b, [err]) : go('fjernet');
    }
    if (action === 'udfor') {
      const op = one('op');
      const err = await performAllocation(c.env, s, b, idParam(one('alloc')) ?? 0, actor, t, (build) => runTx(c, 'bilag', op, build));
      return err ? showDetail(c, b, [err]) : go('registreret');
    }
    if (action === 'godkend') {
      const errs = await approveBilag(db, s, b, actor, t);
      return errs.length ? showDetail(c, b, errs) : go('godkendt');
    }
    if (action === 'afklaring' || action === 'klar' || action === 'arkiver') {
      const err = await setStatus(db, b, action === 'arkiver' ? 'arkiveret' : action, str(one('clarify'), 300), actor, t);
      return err ? showDetail(c, b, [err]) : go('status');
    }
    if (action === 'dublet_ok') {
      await db.batch([
        db.prepare('UPDATE bilag SET dup_cleared_by = ?, updated_at = ? WHERE id = ?').bind(actor.email, t, b.id),
        eventStmt(db, b.id, b.version, 'dublet', `Markeret som ikke en dublet af ${b.dup_of ? bilagNo(b.dup_of) : 'andet bilag'}.`, actor, t),
      ]);
      return go('dublet_ok');
    }
    if (action === 'refunder') {
      if (b.payment !== 'medarbejder' || b.reimbursed_at) return showDetail(c, b, ['Bilaget er ikke et åbent medarbejderudlæg.']);
      await db.batch([
        db.prepare('UPDATE bilag SET reimbursed_at = ?, reimbursed_by = ?, updated_at = ? WHERE id = ?').bind(t, actor.email, t, b.id),
        eventStmt(db, b.id, b.version, 'udlaeg', 'Udlægget er markeret som refunderet til medarbejderen (registreret manuelt, ikke en bankbetaling fra systemet).', actor, t),
      ]);
      return go('refunderet');
    }
    return showDetail(c, b, ['Ukendt handling.']);
  });

  return r;
}
