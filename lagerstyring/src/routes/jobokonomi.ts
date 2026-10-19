// Jobbets økonomi i jobportalen: materialer med prisopslag, reservation og indkøb, timer og løn,
// prisoverslag i versioner og fakturaer med kreditnotaer. Ejer og indkøber ser og ændrer priser;
// medarbejdere kan tilføje materialer, registrere forbrug og egne timer, men ser ingen priser.

import { Hono, type Context } from 'hono';
import type { AppEnv, InvoiceItemRow, InvoiceMode, InvoiceRow, JobEntryRow, JobItemRow, JobRow, LabourTypeRow, User } from '../env';
import { getRetailer, retailers, type RetailerView } from '../lib/estimates';
import { Q, lineAmount, normalizeEmail, parseDay, parseIntStrict, parseKr, parseQty, str, todayDk } from '../lib/format';
import {
  buildCredit,
  buildDraft,
  getInvoice,
  invoiceItems,
  issueInvoice,
  issueProblems,
  jobInvoices,
  jobSources,
  remaining,
  settled,
} from '../lib/invoicing';
import { approveStmt, calcCtx, clearPriceStmt, getItem, itemCalc, jobItems, lookupItems, manualPriceStmt, preferredRetailerId, type ItemView } from '../lib/jobitems';
import { logStmt, syncStage } from '../lib/jobs';
import { billRate, internalRate, jobEntries, labourTypes, summarizeEntries, userType } from '../lib/labour';
import { Conflict } from '../lib/ledger';
import { defaultJobList, getJob, getMaterial, getProduct, jobMaterials, setPlanned } from '../lib/materials';
import { invoicePdf, quotePdf } from '../lib/pdf';
import { agreedQuote, companyInfo, computeQuote, customerInfo, getQuote, jobQuotes, saveQuote } from '../lib/quotes';
import { requireUser } from '../lib/session';
import { actorOf, isDemo, newOp, render, runTx } from '../render';
import { overviewPage, type JobHead, type JobSummary } from '../views/job';
import { hoursPage, invoicePage, invoicesPage, jobBillingPage, materialsPage, quotePage } from '../views/jobokonomi';
import { NAV, isManager, jobHead, me, nowSec } from './jobshared';
import { panelFor } from './produktkatalog';

const okonomi = new Hono<AppEnv>();
okonomi.use('*', requireUser);

const noAccess = (c: Context<AppEnv>) => c.redirect('/job?besked=ingen_adgang', 303);

async function retailerList(db: D1Database): Promise<RetailerView[]> {
  return retailers(db, { activeOnly: true });
}

async function itemsOf(c: Context<AppEnv>, jobId: number): Promise<ItemView[]> {
  return jobItems(c.env.DB, jobId, await preferredRetailerId(c.env.DB, c.get('settings')));
}

/** Navn på et byggemarked ud fra id (til prisforudsætninger). */
function nameOf(rs: RetailerView[]): (id: number | null) => string {
  const m = new Map(rs.map((r) => [r.id, r.name]));
  return (id) => (id === null ? 'Byggemarked' : (m.get(id) ?? 'Byggemarked'));
}

// --- Overblik ----------------------------------------------------------------------------------

export async function jobOverview(c: Context<AppEnv>, id: number, extra: { error?: string; status?: 200 | 409 } = {}) {
  const db = c.env.DB;
  const s = c.get('settings');
  const j = await jobHead(db, id);
  if (!j) return c.notFound();
  const manager = isManager(c);
  const now = nowSec();
  const [staff, rs, mats, pref] = await Promise.all([
    db.prepare('SELECT s.email, COALESCE(u.name, s.email) AS name FROM job_staff s LEFT JOIN users u ON u.email = s.email WHERE s.job_id = ? ORDER BY name COLLATE NOCASE').bind(id).all<{ email: string; name: string }>(),
    retailerList(db),
    jobMaterials(db, id),
    preferredRetailerId(db, s),
  ]);
  const rid = j.retailer_id ?? pref;
  const retailer = rs.find((r) => r.id === rid) ?? null;
  let summary: JobSummary | null = null;
  if (manager) {
    const [items, entries, quotes, inv] = await Promise.all([
      jobItems(db, id, pref),
      jobEntries(db, id),
      jobQuotes(db, id),
      db
        .prepare(
          `SELECT COUNT(CASE WHEN kind = 'faktura' AND status = 'udstedt' THEN 1 END) AS inv_issued, COUNT(CASE WHEN status = 'kladde' THEN 1 END) AS inv_drafts,
             COUNT(CASE WHEN kind = 'kreditnota' AND status = 'udstedt' THEN 1 END) AS inv_credits FROM invoices WHERE job_id = ?`,
        )
        .bind(id)
        .first<{ inv_issued: number; inv_drafts: number; inv_credits: number }>(),
    ]);
    const calc = computeQuote(j, items, entries, s, now, nameOf(rs));
    const lab = summarizeEntries(entries);
    const { sources } = await jobSources(db, j, items, s, now);
    const matSources = sources.filter((x) => x.type === 'materiale');
    const matCost = matSources.reduce((a, x) => a + lineAmount(x.unit_cost, x.qty), 0);
    const q = quotes[0];
    summary = {
      quote: q ? { version: q.version, subtotal: q.subtotal, total: q.total, incomplete: q.incomplete, shared_at: q.shared_at, accepted_at: q.accepted_at } : null,
      estimate: { subtotal: calc.subtotal, incomplete: calc.incomplete },
      actualMaterials: matSources.some((x) => x.unit_price === null) && !matSources.some((x) => x.unit_price !== null) ? null : matSources.reduce((a, x) => a + lineAmount(x.unit_price, x.qty), 0),
      actualLabour: lab.billableLabour + lab.actualOther,
      internalCost: matCost + lab.internalCost,
      internalMissing: lab.internalMissing,
      hours: lab.actualHours,
      hoursExpected: lab.expectedHours,
      pendingHours: lab.pendingHours,
      billing: inv ?? { inv_issued: 0, inv_drafts: 0, inv_credits: 0 },
    };
  }
  const waiting = mats.filter((m) => m.waiting > 0).length;
  return render(
    c,
    `${j.number} ${j.name}`,
    overviewPage({
      job: j,
      staff: staff.results,
      retailer,
      retailerFromSettings: !j.retailer_id && !!retailer,
      waiting,
      manager,
      summary,
      csrf: c.get('csrf'),
      op: newOp(),
      flashCode: c.req.query('besked'),
      error: extra.error,
    }),
    NAV('job'),
    extra.status ?? 200,
  );
}

// --- Materialer --------------------------------------------------------------------------------

export async function showMaterials(c: Context<AppEnv>, id: number, extra: { error?: string; result?: { ok: boolean; text: string; list: string[] }; status?: 200 | 400 | 409 } = {}) {
  const db = c.env.DB;
  const s = c.get('settings');
  const j = await jobHead(db, id);
  if (!j) return c.notFound();
  const now = nowSec();
  const pref = await preferredRetailerId(db, s);
  const [items, mats, rs, panel] = await Promise.all([
    jobItems(db, id, pref),
    jobMaterials(db, id),
    retailerList(db),
    panelFor(c, `/job/${id}/materialer`, { kind: 'job', jobId: id }, { anchor: 'tilfoj', perPage: 10 }),
  ]);
  const ctx = calcCtx(j, s, now);
  const fejl = c.req.query('fejl');
  return render(
    c,
    `${j.number} materialer`,
    materialsPage({
      job: j,
      items: items.map((it) => ({ it, c: itemCalc(it, it.qty, ctx) })),
      mats,
      panel,
      manualOpen: c.req.query('manuel') === '1' || !!extra.error,
      retailers: rs,
      jobRetailer: rs.find((r) => r.id === (j.retailer_id ?? pref)) ?? null,
      manager: isManager(c),
      csrf: c.get('csrf'),
      ops: mats.map(() => newOp()),
      reserveOp: newOp(),
      now,
      maxAgeDays: s.price_max_age_days,
      defaultMarkup: j.markup_pct ?? s.default_markup_pct,
      flashCode: c.req.query('besked'),
      error: extra.error ?? (fejl === 'maengde' ? 'Angiv en gyldig mængde.' : fejl ? fejl.slice(0, 300) : undefined),
      result: extra.result,
    }),
    NAV('job'),
    extra.status ?? 200,
  );
}

okonomi.get('/:id{[0-9]+}/materialer', (c) => showMaterials(c, Number(c.req.param('id'))));

okonomi.post('/:id{[0-9]+}/materialer/ny', async (c) => {
  const db = c.env.DB;
  const id = Number(c.req.param('id'));
  const j = await getJob(db, id);
  if (!j) return c.notFound();
  if (j.status !== 'aktiv') return showMaterials(c, id, { error: 'Jobbet er afsluttet.', status: 409 });
  const body = await c.req.parseBody();
  const qty = parseQty(body['qty']);
  if (qty === null || qty <= 0) return showMaterials(c, id, { error: 'Angiv en gyldig forventet mængde.', status: 400 });
  const now = nowSec();
  const actor = actorOf(c);
  const sort = `(SELECT COALESCE(MAX(sort_order), 0) + 1 FROM job_items WHERE job_id = ?1)`;
  if (body['kind'] === 'lager') {
    const pid = parseIntStrict(body['product_id']);
    const p = pid ? await getProduct(db, pid) : null;
    if (!p) return showMaterials(c, id, { error: 'Vælg en vare.', status: 400 });
    if (p.whole_units && qty % Q !== 0) return showMaterials(c, id, { error: `${p.name} håndteres kun i hele ${p.unit}.`, status: 400 });
    try {
      await db.batch([
        db
          .prepare(
            `INSERT INTO job_items (job_id, product_id, cost_basis, sku, name, unit, ean, mpn, brand, variant, qty, sale_mode, sale_price, sort_order, created_by, created_at, updated_at)
             VALUES (?1, ?2, 'lager', ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ${sort}, ?13, ?14, ?14)`,
          )
          .bind(id, p.id, p.sku, p.name, p.unit, p.ean, p.mpn, p.brand, p.variant, qty, p.sale_price !== null ? 'manuel' : 'paaslag', p.sale_price, actor.email, now),
        logStmt(db, id, 'materiale', `${p.name} tilføjet: ${qtyText(qty, p.unit)} forventet.`, actor, now),
      ]);
    } catch (err) {
      if (String((err as Error).message).includes('UNIQUE')) return showMaterials(c, id, { error: `${p.name} er allerede på jobbet. Ret mængden på linjen.`, status: 409 });
      throw err;
    }
  } else {
    const name = str(body['name'], 200);
    if (!name) return showMaterials(c, id, { error: 'Angiv varens navn.', status: 400 });
    const manager = isManager(c);
    const url = manager ? str(body['url'], 500) : '';
    if (url && !/^https:\/\//i.test(url)) return showMaterials(c, id, { error: 'Linket skal starte med https://', status: 400 });
    await db.batch([
      db
        .prepare(
          `INSERT INTO job_items (job_id, product_id, cost_basis, name, unit, ean, qty, url, sale_mode, sort_order, created_by, created_at, updated_at)
           VALUES (?1, NULL, 'byggemarked', ?2, ?3, ?4, ?5, ?6, 'paaslag', ${sort}, ?7, ?8, ?8)`,
        )
        .bind(id, name, str(body['unit'], 20) || 'stk.', manager ? str(body['ean'], 14).replace(/\D/g, '') : '', qty, url, actor.email, now),
      logStmt(db, id, 'materiale', `${name} tilføjet: ${qtyText(qty, str(body['unit'], 20) || 'stk.')} forventet.`, actor, now),
    ]);
  }
  return c.redirect(`/job/${id}/materialer?besked=materiale_tilfojet`, 303);
});

function qtyText(q: number, unit: string): string {
  return `${(q / Q).toLocaleString('da-DK', { maximumFractionDigits: 3 })} ${unit}`;
}

async function itemFor(c: Context<AppEnv>): Promise<{ j: JobRow; it: JobItemRow } | null> {
  const db = c.env.DB;
  const id = Number(c.req.param('id'));
  const it = await getItem(db, Number(c.req.param('item')));
  if (!it || it.job_id !== id) return null;
  const j = await getJob(db, id);
  return j ? { j, it } : null;
}

okonomi.post('/:id{[0-9]+}/materialer/:item{[0-9]+}', async (c) => {
  const found = await itemFor(c);
  if (!found) return c.notFound();
  const { j, it } = found;
  const db = c.env.DB;
  const body = await c.req.parseBody();
  const qty = parseQty(body['qty']);
  if (qty === null) return showMaterials(c, j.id, { error: 'Angiv en gyldig mængde.', status: 400 });
  const errs: string[] = [];
  const name = it.product_id ? it.name : str(body['name'], 200) || it.name;
  const unit = it.product_id ? it.unit : str(body['unit'], 20) || it.unit;
  let upd: Partial<JobItemRow> = { qty, name, unit, note: str(body['note'], 200) };
  if (!it.product_id) upd = { ...upd, ean: str(body['ean'], 14).replace(/\D/g, ''), mpn: str(body['mpn'], 60), brand: str(body['brand'], 60) };
  if (isManager(c)) {
    const rid = body['retailer_id'] ? parseIntStrict(body['retailer_id']) : null;
    if (rid !== null && !(await getRetailer(db, rid))) errs.push('Vælg et gyldigt byggemarked.');
    const mode = body['sale_mode'];
    const markupRaw = str(body['markup_pct'], 5);
    const markup = markupRaw ? parseIntStrict(markupRaw, { max: 1000 }) : null;
    if (markupRaw && markup === null) errs.push('Påslaget skal være et helt tal mellem 0 og 1000.');
    const saleRaw = str(body['sale_price'], 15);
    const sale = saleRaw ? parseKr(saleRaw) : null;
    if (saleRaw && sale === null) errs.push('Salgsprisen er ikke et gyldigt beløb.');
    if (mode === 'manuel' && sale === null) errs.push('Angiv den manuelle salgspris.');
    const url = str(body['url'], 500);
    if (url && !/^https:\/\//i.test(url)) errs.push('Linket skal starte med https://');
    const pack = parseQty(body['pack_qty'] || '1');
    if (!pack) errs.push('Indholdet pr. salgsenhed skal være større end 0.');
    upd = {
      ...upd,
      retailer_id: rid,
      cost_basis: it.product_id && body['cost_basis'] === 'byggemarked' ? 'byggemarked' : it.product_id ? 'lager' : 'byggemarked',
      sale_mode: mode === 'offentlig' || mode === 'manuel' ? mode : 'paaslag',
      markup_pct: markup,
      sale_price: sale,
      url,
      sales_unit: str(body['sales_unit'], 20) || unit,
      pack_qty: pack ?? Q,
    };
  }
  if (errs.length) return showMaterials(c, j.id, { error: errs.join(' '), status: 400 });
  const keys = Object.keys(upd) as (keyof JobItemRow)[];
  const now = nowSec();
  await db.batch([
    db.prepare(`UPDATE job_items SET ${keys.map((k) => `${k} = ?`).join(', ')}, updated_at = ? WHERE id = ?`).bind(...keys.map((k) => upd[k] ?? null), now, it.id),
    ...(qty !== it.qty ? [logStmt(db, j.id, 'materiale', `${name}: forventet mængde ændret fra ${qtyText(it.qty, it.unit)} til ${qtyText(qty, unit)}.`, actorOf(c), now)] : []),
  ]);
  return c.redirect(`/job/${j.id}/materialer?besked=gemt`, 303);
});

okonomi.post('/:id{[0-9]+}/materialer/:item{[0-9]+}/pris', async (c) => {
  if (!isManager(c)) return noAccess(c);
  const found = await itemFor(c);
  if (!found) return c.notFound();
  const { j, it } = found;
  const body = await c.req.parseBody();
  const price = parseKr(body['price']);
  const pack = parseQty(body['pack_qty'] || '1');
  const url = str(body['url'], 500);
  if (price === null) return showMaterials(c, j.id, { error: 'Angiv en gyldig pris.', status: 400 });
  if (!pack) return showMaterials(c, j.id, { error: 'Indholdet pr. salgsenhed skal være større end 0.', status: 400 });
  if (url && !/^https:\/\//i.test(url)) return showMaterials(c, j.id, { error: 'Linket skal starte med https://', status: 400 });
  const pref = await preferredRetailerId(c.env.DB, c.get('settings'));
  const now = nowSec();
  await c.env.DB.batch([
    manualPriceStmt(
      c.env.DB,
      it.id,
      it.retailer_id ?? j.retailer_id ?? pref,
      { price, vat: body['vat'] === 'ekskl' ? 'ekskl' : 'inkl', sales_unit: str(body['sales_unit'], 20) || it.unit, pack_qty: pack, url, found_name: it.found_name || it.name },
      actorOf(c),
      now,
    ),
    logStmt(c.env.DB, j.id, 'pris', `${it.name}: pris indtastet manuelt.`, actorOf(c), now),
  ]);
  return c.redirect(`/job/${j.id}/materialer?besked=pris_gemt`, 303);
});

okonomi.post('/:id{[0-9]+}/materialer/:item{[0-9]+}/godkend', async (c) => {
  if (!isManager(c)) return noAccess(c);
  const found = await itemFor(c);
  if (!found) return c.notFound();
  const now = nowSec();
  await c.env.DB.batch([
    approveStmt(c.env.DB, found.it.id, actorOf(c), now),
    logStmt(c.env.DB, found.j.id, 'pris', `${found.it.name}: alternativ godkendt (${found.it.found_name}).`, actorOf(c), now),
  ]);
  return c.redirect(`/job/${found.j.id}/materialer?besked=alternativ_godkendt_job`, 303);
});

okonomi.post('/:id{[0-9]+}/materialer/:item{[0-9]+}/afvis', async (c) => {
  if (!isManager(c)) return noAccess(c);
  const found = await itemFor(c);
  if (!found) return c.notFound();
  await clearPriceStmt(c.env.DB, found.it.id, `Alternativet "${found.it.found_name}" er afvist. Indsæt et link eller indtast prisen manuelt.`, nowSec()).run();
  return c.redirect(`/job/${found.j.id}/materialer?besked=gemt`, 303);
});

okonomi.post('/:id{[0-9]+}/materialer/:item{[0-9]+}/forbrug', async (c) => {
  const found = await itemFor(c);
  if (!found) return c.notFound();
  const { j, it } = found;
  if (it.product_id) return showMaterials(c, j.id, { error: 'Varer fra lageret registreres med "Registrér forbrug".', status: 400 });
  if (j.status !== 'aktiv') return showMaterials(c, j.id, { error: 'Jobbet er afsluttet.', status: 409 });
  const body = await c.req.parseBody();
  const q = parseQty(body['qty']);
  if (!q) return showMaterials(c, j.id, { error: 'Angiv en mængde.', status: 400 });
  const back = body['retning'] === 'retur';
  if (back && q > it.used_qty) return showMaterials(c, j.id, { error: `Der er kun registreret ${qtyText(it.used_qty, it.unit)} brugt.`, status: 409 });
  // Er en del af forbruget allerede faktureret, kan det ikke fjernes her (det krediteres)
  if (back) {
    const done = (await settled(c.env.DB, j.id)).get(`item:${it.id}`) ?? 0;
    if (it.used_qty - q < done) return showMaterials(c, j.id, { error: 'Den mængde er allerede faktureret. Lav en kreditnota i stedet.', status: 409 });
  }
  const now = nowSec();
  await c.env.DB.batch([
    c.env.DB.prepare(`UPDATE job_items SET used_qty = used_qty ${back ? '-' : '+'} ?, updated_at = ? WHERE id = ? AND used_qty ${back ? '>=' : '>='} ?`).bind(q, now, it.id, back ? q : 0),
    logStmt(c.env.DB, j.id, 'forbrug', `${it.name}: ${qtyText(q, it.unit)} ${back ? 'returneret (ikke brugt)' : 'brugt'}.`, actorOf(c), now),
  ]);
  await syncStage(c.env.DB, j.id, now, actorOf(c));
  return c.redirect(`/job/${j.id}/materialer?besked=forbrug_registreret`, 303);
});

okonomi.post('/:id{[0-9]+}/materialer/:item{[0-9]+}/slet', async (c) => {
  const found = await itemFor(c);
  if (!found) return c.notFound();
  const { j, it } = found;
  if (it.used_qty > 0 || it.planned_at) return showMaterials(c, j.id, { error: 'Linjen er reserveret eller brugt og kan ikke fjernes. Sæt mængden til 0 i stedet.', status: 409 });
  if (it.product_id) {
    const m = await getMaterial(c.env.DB, j.id, it.product_id);
    if (m.planned > 0 || m.issued > 0) return showMaterials(c, j.id, { error: 'Varen er reserveret eller brugt på jobbet og kan ikke fjernes.', status: 409 });
  }
  const now = nowSec();
  await c.env.DB.batch([c.env.DB.prepare('DELETE FROM job_items WHERE id = ?').bind(it.id), logStmt(c.env.DB, j.id, 'materiale', `${it.name} fjernet fra jobbet.`, actorOf(c), now)]);
  return c.redirect(`/job/${j.id}/materialer?besked=slettet`, 303);
});

// Prisopslag hos det valgte byggemarked (fejl stopper intet andet)
okonomi.post('/:id{[0-9]+}/materialer/priser', async (c) => {
  if (!isManager(c)) return noAccess(c);
  const id = Number(c.req.param('id'));
  const items = await itemsOf(c, id);
  const r = await lookupItems(c.env, items, nowSec());
  await logStmt(c.env.DB, id, 'pris', `Prisopslag: ${r.ok} fundet, ${r.failed} uden pris.`, actorOf(c), nowSec()).run();
  return showMaterials(c, id, {
    result: {
      ok: r.failed === 0,
      text: r.failed ? `Priser slået op: ${r.ok} med pris, ${r.failed} uden. Linjer uden pris tæller ikke med, før prisen er fundet eller indtastet.` : `Priser slået op for ${r.ok} ${r.ok === 1 ? 'linje' : 'linjer'}.`,
      list: r.messages,
    },
  });
});

/**
 * Reservér og bestil: varer fra lageret reserveres op til den forventede mængde, og det, der
 * mangler, kommer automatisk på jobbets indkøbsliste. Varer uden varenummer sættes på
 * indkøbslisten i den mængde, der skal købes (hele pakker), til levering på arbejdsstedet.
 */
okonomi.post('/:id{[0-9]+}/materialer/reserver', async (c) => {
  const id = Number(c.req.param('id'));
  const db = c.env.DB;
  const s = c.get('settings');
  const body = await c.req.parseBody();
  const j0 = await getJob(db, id);
  if (!j0) return c.notFound();
  const listId = await defaultJobList(db, j0, nowSec());
  const pref = await preferredRetailerId(db, s);
  const res = await runTx(c, 'reserver', body['op'], async (tx) => {
    const j = await getJob(tx.db, id);
    if (!j) throw new Conflict('Jobbet findes ikke.');
    if (j.status !== 'aktiv') throw new Conflict('Jobbet er afsluttet.');
    const items = await jobItems(tx.db, id, pref);
    const ctx = calcCtx(j, s, tx.now);
    for (const it of items) {
      if (it.product_id) {
        const p = await getProduct(tx.db, it.product_id);
        if (!p) continue;
        const m = await getMaterial(tx.db, id, p.id);
        if (it.qty > m.planned) await setPlanned(tx, j, p, it.qty);
      } else if (it.qty > 0 && !it.purchase_line_id) {
        const calc = itemCalc(it, it.qty, ctx);
        const buyQty = calc.buy?.covered ?? it.qty;
        const note = calc.buy && it.pack_qty && it.pack_qty !== Q ? `Køb ${qtyText(calc.buy.buy, it.sales_unit || 'pk.')} á ${qtyText(it.pack_qty, it.unit)}` : 'Købes til jobbet';
        tx.add(
          tx.db
            .prepare(
              `INSERT INTO purchase_lines (list_id, job_id, product_id, sku, name, unit, qty, unit_price, deliver_to, note, retailer_id, created_at, updated_at)
               VALUES (?, ?, NULL, '', ?, ?, ?, ?, 'arbejdssted', ?, ?, ?, ?)`,
            )
            .bind(listId, id, it.name, it.unit, buyQty, calc.unitCost, note, it.eff_retailer_id, tx.now, tx.now),
          tx.db
            .prepare(`UPDATE job_items SET purchase_line_id = (SELECT MAX(id) FROM purchase_lines WHERE list_id = ? AND job_id = ? AND product_id IS NULL AND name = ?), updated_at = ? WHERE id = ?`)
            .bind(listId, id, it.name, tx.now, it.id),
        );
        tx.touchList(listId);
        tx.jobs.add(id);
      }
      if (!it.planned_at) tx.add(tx.db.prepare('UPDATE job_items SET planned_at = ? WHERE id = ?').bind(tx.now, it.id));
    }
    tx.add(logStmt(tx.db, id, 'materiale', 'Materialer reserveret; det, der mangler, er sat på indkøbslisten.', tx.actor, tx.now));
    tx.jobs.add(id);
  });
  if (!res.ok && !res.duplicate) return showMaterials(c, id, { error: res.error, status: 409 });
  return c.redirect(`/job/${id}/materialer?besked=${res.ok ? 'reserveret' : 'dublet'}`, 303);
});

// --- Timer og løn ------------------------------------------------------------------------------

async function showHours(c: Context<AppEnv>, id: number, errs: string[] = []) {
  const db = c.env.DB;
  const s = c.get('settings');
  const j = await jobHead(db, id);
  if (!j) return c.notFound();
  const [entries, types, { results: users }] = await Promise.all([
    jobEntries(db, id),
    labourTypes(db),
    db.prepare('SELECT * FROM users WHERE active = 1 ORDER BY name COLLATE NOCASE').all<User>(),
  ]);
  const manager = isManager(c);
  // Medarbejdere ser kun deres egne registreringer og ingen priser
  const visible = manager ? entries : entries.filter((e) => e.phase === 'faktisk' && e.type === 'tid' && (e.worker_email === me(c).email || e.created_by === me(c).email));
  return render(
    c,
    `${j.number} timer`,
    hoursPage({
      job: j,
      entries: visible,
      summary: summarizeEntries(entries),
      users,
      types,
      me: me(c),
      manager,
      csrf: c.get('csrf'),
      rate: billRate(j, null, s),
      internalDefault: internalRate(null, s),
      today: todayDk(),
      flashCode: c.req.query('besked'),
      errs,
    }),
    NAV('job'),
    errs.length ? 400 : 200,
  );
}

okonomi.get('/:id{[0-9]+}/timer', (c) => showHours(c, Number(c.req.param('id'))));

okonomi.post('/:id{[0-9]+}/timer', async (c) => {
  const db = c.env.DB;
  const s = c.get('settings');
  const id = Number(c.req.param('id'));
  const j = await getJob(db, id);
  if (!j) return c.notFound();
  const body = await c.req.parseBody();
  const manager = isManager(c);
  const type = body['type'] === 'omkostning' ? 'omkostning' : 'tid';
  const phase = body['phase'] === 'forventet' ? 'forventet' : 'faktisk';
  if (!manager && (type !== 'tid' || phase !== 'faktisk')) return noAccess(c);
  if (phase === 'faktisk' && j.status !== 'aktiv') return showHours(c, id, ['Jobbet er afsluttet. Genåbn det for at registrere timer.']);
  const qty = parseQty(body['qty']);
  const errs: string[] = [];
  if (!qty) errs.push('Angiv antal timer (fx 7,5).');
  else if (type === 'tid' && phase === 'faktisk' && qty > 24 * Q) errs.push('Højst 24 timer pr. registrering.');
  const date = parseDay(body['work_date'] ?? '');
  if (date === null) errs.push('Datoen er ikke gyldig.');
  const priceRaw = str(body['unit_price'], 15);
  const price = priceRaw ? parseKr(priceRaw) : null;
  if (priceRaw && price === null) errs.push('Prisen er ikke et gyldigt beløb.');
  const costRaw = str(body['internal_cost'], 15);
  const cost = costRaw ? parseKr(costRaw) : null;
  if (costRaw && cost === null) errs.push('Den interne omkostning er ikke et gyldigt beløb.');
  const description = str(body['description'], 200);
  if (type === 'omkostning' && !description) errs.push('Beskriv omkostningen.');
  if (errs.length) return showHours(c, id, errs);
  const now = nowSec();
  const actor = actorOf(c);
  let worker = { email: '', name: '', type: '' };
  let unitPrice = price;
  let internal = cost;
  if (type === 'tid') {
    let lt: LabourTypeRow | null = null;
    if (phase === 'faktisk') {
      const email = manager ? (normalizeEmail(body['worker']) ?? me(c).email) : me(c).email;
      const u = await userType(db, email);
      if (!u.user) return showHours(c, id, ['Vælg en medarbejder.']);
      lt = u.type;
      worker = { email, name: u.user.name, type: lt?.name ?? '' };
    } else {
      const ltId = parseIntStrict(body['labour_type']);
      lt = ltId ? await db.prepare('SELECT * FROM labour_types WHERE id = ?').bind(ltId).first<LabourTypeRow>() : null;
      worker = { email: '', name: '', type: lt?.name ?? '' };
    }
    unitPrice = price ?? billRate(j, lt, s);
    internal = cost ?? internalRate(lt, s);
  }
  const billable = manager ? (body['billable'] === '1' ? 1 : 0) : 1;
  const approve = manager && phase === 'faktisk' && (type === 'omkostning' || body['approve'] === '1');
  await db.batch([
    db
      .prepare(
        `INSERT INTO job_entries (job_id, type, phase, worker_email, worker_name, worker_type, work_date, description, qty, unit, internal_cost, unit_price, billable, extra,
           approved_by, approved_at, created_by, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        id,
        type,
        phase,
        worker.email,
        worker.name,
        worker.type,
        date || (phase === 'faktisk' ? todayDk() : ''),
        description,
        qty,
        type === 'tid' ? 'timer' : str(body['unit'], 20) || 'stk.',
        internal,
        unitPrice,
        billable,
        manager && body['extra'] === '1' ? 1 : 0,
        approve ? actor.name : null,
        approve ? now : null,
        actor.email,
        now,
        now,
      ),
    logStmt(
      db,
      id,
      type === 'tid' ? 'timer' : 'omkostning',
      type === 'tid'
        ? `${phase === 'faktisk' ? `${worker.name}: ${qtyText(qty!, 'timer')} registreret` : `${qtyText(qty!, 'timer')} forventet`}${description ? ` (${description})` : ''}.`
        : `${phase === 'faktisk' ? 'Omkostning' : 'Forventet omkostning'}: ${description}.`,
      actor,
      now,
    ),
  ]);
  if (phase === 'faktisk') await syncStage(db, id, now, actor);
  return c.redirect(`/job/${id}/timer?besked=${phase === 'faktisk' && type === 'tid' ? (approve ? 'timer_godkendt' : 'timer_registreret') : 'gemt'}`, 303);
});

/** Er en registrering med på en udstedt faktura? Så kan den ikke ændres (rettes med kreditnota). */
async function invoiced(db: D1Database, jobId: number, key: string): Promise<boolean> {
  return ((await settled(db, jobId)).get(key) ?? 0) > 0;
}

async function entryFor(c: Context<AppEnv>): Promise<JobEntryRow | null> {
  const e = await c.env.DB.prepare('SELECT * FROM job_entries WHERE id = ? AND job_id = ?').bind(Number(c.req.param('eid')), Number(c.req.param('id'))).first<JobEntryRow>();
  return e;
}

const entryKey = (e: JobEntryRow) => `${e.type === 'tid' ? 'tid' : 'omk'}:${e.id}`;

okonomi.post('/:id{[0-9]+}/timer/godkend', async (c) => {
  if (!isManager(c)) return noAccess(c);
  const id = Number(c.req.param('id'));
  const body = await c.req.parseBody({ all: true });
  const raw = body['id'];
  const ids = (Array.isArray(raw) ? raw : [raw]).map((x) => parseIntStrict(x)).filter((x): x is number => !!x).slice(0, 200);
  const now = nowSec();
  const a = actorOf(c);
  if (ids.length) {
    await c.env.DB.batch([
      ...ids.map((eid) => c.env.DB.prepare("UPDATE job_entries SET approved_by = ?, approved_at = ?, updated_at = ? WHERE id = ? AND job_id = ? AND phase = 'faktisk' AND approved_at IS NULL").bind(a.name, now, now, eid, id)),
      logStmt(c.env.DB, id, 'timer', `${ids.length} ${ids.length === 1 ? 'timeregistrering' : 'timeregistreringer'} godkendt til fakturering.`, a, now),
    ]);
  }
  return c.redirect(`/job/${id}/timer?besked=timer_godkendt`, 303);
});

okonomi.post('/:id{[0-9]+}/timer/:eid{[0-9]+}/fortryd', async (c) => {
  if (!isManager(c)) return noAccess(c);
  const e = await entryFor(c);
  if (!e) return c.notFound();
  if (await invoiced(c.env.DB, e.job_id, entryKey(e))) return showHours(c, e.job_id, ['Timerne er faktureret. Lav en kreditnota for at rette dem.']);
  await c.env.DB.prepare('UPDATE job_entries SET approved_by = NULL, approved_at = NULL, updated_at = ? WHERE id = ?').bind(nowSec(), e.id).run();
  return c.redirect(`/job/${e.job_id}/timer?besked=gemt`, 303);
});

okonomi.post('/:id{[0-9]+}/timer/:eid{[0-9]+}/slet', async (c) => {
  const e = await entryFor(c);
  if (!e) return c.notFound();
  const mine = e.worker_email === me(c).email || e.created_by === me(c).email;
  if (!isManager(c) && !(mine && !e.approved_at)) return noAccess(c);
  if (await invoiced(c.env.DB, e.job_id, entryKey(e))) return showHours(c, e.job_id, ['Registreringen er faktureret og kan ikke slettes. Lav en kreditnota.']);
  const now = nowSec();
  await c.env.DB.batch([
    c.env.DB.prepare('DELETE FROM job_entries WHERE id = ?').bind(e.id),
    logStmt(c.env.DB, e.job_id, e.type === 'tid' ? 'timer' : 'omkostning', `Registrering slettet: ${e.description || e.worker_name || 'timer'} (${qtyText(e.qty, e.unit)}).`, actorOf(c), now),
  ]);
  return c.redirect(`/job/${e.job_id}/timer?besked=slettet`, 303);
});

okonomi.post('/:id{[0-9]+}/timer/:eid{[0-9]+}', async (c) => {
  if (!isManager(c)) return noAccess(c);
  const e = await entryFor(c);
  if (!e) return c.notFound();
  if (await invoiced(c.env.DB, e.job_id, entryKey(e))) return showHours(c, e.job_id, ['Registreringen er faktureret og kan ikke ændres. Lav en kreditnota.']);
  const body = await c.req.parseBody();
  const qty = parseQty(body['qty']);
  const date = parseDay(body['work_date'] ?? '');
  const priceRaw = str(body['unit_price'], 15);
  const costRaw = str(body['internal_cost'], 15);
  const price = priceRaw ? parseKr(priceRaw) : null;
  const cost = costRaw ? parseKr(costRaw) : null;
  if (!qty || date === null || (priceRaw && price === null) || (costRaw && cost === null)) return showHours(c, e.job_id, ['Kontrollér antal, dato og beløb.']);
  await c.env.DB.prepare('UPDATE job_entries SET qty = ?, work_date = ?, description = ?, unit_price = ?, internal_cost = ?, billable = ?, extra = ?, updated_at = ? WHERE id = ?')
    .bind(qty, date, str(body['description'], 200), price, cost, body['billable'] === '1' ? 1 : 0, body['extra'] === '1' ? 1 : 0, nowSec(), e.id)
    .run();
  return c.redirect(`/job/${e.job_id}/timer?besked=gemt`, 303);
});

// --- Prisoverslag ------------------------------------------------------------------------------

async function quoteCalc(c: Context<AppEnv>, j: JobRow) {
  const db = c.env.DB;
  const [items, entries, rs] = await Promise.all([itemsOf(c, j.id), jobEntries(db, j.id), retailers(db)]);
  return computeQuote(j, items, entries, c.get('settings'), nowSec(), nameOf(rs));
}

okonomi.get('/:id{[0-9]+}/overslag', async (c) => {
  if (!isManager(c)) return noAccess(c);
  const j = await jobHead(c.env.DB, Number(c.req.param('id')));
  if (!j) return c.notFound();
  const [calc, quotes] = await Promise.all([quoteCalc(c, j), jobQuotes(c.env.DB, j.id)]);
  const s = c.get('settings');
  return render(
    c,
    `${j.number} prisoverslag`,
    quotePage({ job: j, calc, quotes, csrf: c.get('csrf'), vatSet: s.vat_registered === 'ja' || s.vat_registered === 'nej', flashCode: c.req.query('besked') }),
    NAV('job'),
  );
});

okonomi.post('/:id{[0-9]+}/overslag', async (c) => {
  if (!isManager(c)) return noAccess(c);
  const j = await getJob(c.env.DB, Number(c.req.param('id')));
  if (!j) return c.notFound();
  const body = await c.req.parseBody();
  const calc = await quoteCalc(c, j);
  await saveQuote(c.env.DB, j.id, calc, c.get('settings'), str(body['note'], 600, { multiline: true }), actorOf(c), nowSec());
  return c.redirect(`/job/${j.id}/overslag?besked=overslag_gemt`, 303);
});

// Hono kan ikke have en fast endelse efter en parameter, så ".pdf" er en del af parameteren
okonomi.get('/:id{[0-9]+}/overslag/:qid{[0-9]+\\.pdf}', async (c) => {
  if (!isManager(c)) return noAccess(c);
  const q = await getQuote(c.env.DB, parseInt(c.req.param('qid'), 10));
  if (!q || q.job_id !== Number(c.req.param('id'))) return c.notFound();
  const j = await getJob(c.env.DB, q.job_id);
  const bytes = await quotePdf(q, isDemo(c));
  if (!q.shared_at) {
    const now = nowSec();
    await c.env.DB.batch([
      c.env.DB.prepare('UPDATE job_quotes SET shared_at = ?, shared_by = ? WHERE id = ? AND shared_at IS NULL').bind(now, me(c).email, q.id),
      logStmt(c.env.DB, q.job_id, 'overslag', `Prisoverslag version ${q.version} hentet som PDF (markeret som sendt).`, actorOf(c), now),
    ]);
  }
  return pdfResponse(bytes, `Prisoverslag-${j?.number ?? q.job_id}-v${q.version}.pdf`);
});

okonomi.post('/:id{[0-9]+}/overslag/:qid{[0-9]+}/accepteret', async (c) => {
  if (!isManager(c)) return noAccess(c);
  const q = await getQuote(c.env.DB, Number(c.req.param('qid')));
  if (!q || q.job_id !== Number(c.req.param('id'))) return c.notFound();
  const now = nowSec();
  await c.env.DB.batch([
    c.env.DB.prepare('UPDATE job_quotes SET accepted_at = ?, accepted_by = ?, shared_at = COALESCE(shared_at, ?), shared_by = COALESCE(shared_by, ?) WHERE id = ?').bind(now, me(c).email, now, me(c).email, q.id),
    logStmt(c.env.DB, q.job_id, 'overslag', `Prisoverslag version ${q.version} markeret som accepteret af slutkunden.`, actorOf(c), now),
  ]);
  return c.redirect(`/job/${q.job_id}/overslag?besked=overslag_accepteret`, 303);
});

function pdfResponse(bytes: Uint8Array, filename: string): Response {
  const safe = filename.replace(/[^A-Za-z0-9._-]/g, '_');
  return new Response(bytes, {
    headers: {
      'Content-Type': 'application/pdf',
      'Content-Disposition': `attachment; filename="${safe}"`,
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    },
  });
}

// --- Faktura -----------------------------------------------------------------------------------

async function showBilling(c: Context<AppEnv>, id: number, error?: string) {
  const db = c.env.DB;
  const j = await jobHead(db, id);
  if (!j) return c.notFound();
  const items = await itemsOf(c, id);
  const now = nowSec();
  const [{ sources, pendingHours }, done, invoices, quote] = await Promise.all([jobSources(db, j, items, c.get('settings'), now), settled(db, id), jobInvoices(db, id), agreedQuote(db, id)]);
  return render(
    c,
    `${j.number} faktura`,
    jobBillingPage({ job: j, invoices, rest: remaining(sources, done), pendingHours, quote, csrf: c.get('csrf'), flashCode: c.req.query('besked'), error }),
    NAV('job'),
    error ? 409 : 200,
  );
}

okonomi.get('/:id{[0-9]+}/faktura', (c) => (isManager(c) ? showBilling(c, Number(c.req.param('id'))) : noAccess(c)));

okonomi.post('/:id{[0-9]+}/faktura', async (c) => {
  if (!isManager(c)) return noAccess(c);
  const id = Number(c.req.param('id'));
  const j = await getJob(c.env.DB, id);
  if (!j) return c.notFound();
  const body = await c.req.parseBody();
  const mode: InvoiceMode = body['mode'] === 'fast' || body['mode'] === 'kombination' ? body['mode'] : 'medgaaet';
  const fixedRaw = str(body['fixed_amount'], 15);
  const fixed = fixedRaw ? parseKr(fixedRaw) : null;
  if (fixedRaw && fixed === null) return showBilling(c, id, 'Den faste pris er ikke et gyldigt beløb.');
  const invId = await buildDraft(c.env.DB, j, await itemsOf(c, id), c.get('settings'), { mode, fixed }, actorOf(c), nowSec());
  return c.redirect(`/job/faktura/${invId}?besked=kladde_oprettet`, 303);
});

okonomi.get('/faktura', async (c) => {
  if (!isManager(c)) return noAccess(c);
  const vis = c.req.query('vis') ?? '';
  const filter = vis === 'kladde' || vis === 'udstedt' ? vis : '';
  const db = c.env.DB;
  const [{ results: rows }, { results: ready }] = await Promise.all([
    db
      .prepare(`SELECT i.*, j.number AS job_number, j.name AS job_name FROM invoices i JOIN jobs j ON j.id = i.job_id ${filter ? 'WHERE i.status = ?' : ''} ORDER BY i.status = 'kladde' DESC, i.number DESC, i.id DESC LIMIT 300`)
      .bind(...(filter ? [filter] : []))
      .all<InvoiceRow & { job_number: string; job_name: string }>(),
    db
      .prepare(
        `SELECT id, number, name, customer_name FROM jobs j WHERE j.stage = 'afsluttet'
           AND NOT EXISTS (SELECT 1 FROM invoices i WHERE i.job_id = j.id AND i.kind = 'faktura') ORDER BY updated_at DESC LIMIT 20`,
      )
      .all<{ id: number; number: string; name: string; customer_name: string }>(),
  ]);
  return render(c, 'Fakturaer', invoicesPage({ rows, ready, flashCode: c.req.query('besked'), filter }), NAV('faktura'));
});

async function invoiceFor(c: Context<AppEnv>): Promise<InvoiceRow | null> {
  return getInvoice(c.env.DB, parseInt(c.req.param('iid') ?? '', 10));
}

async function showInvoice(c: Context<AppEnv>, inv: InvoiceRow, errs: string[] = []) {
  const db = c.env.DB;
  const s = c.get('settings');
  const [items, j] = await Promise.all([invoiceItems(db, inv.id), getJob(db, inv.job_id)]);
  if (!j) return c.notFound();
  const quote = inv.quote_id ? await getQuote(db, inv.quote_id) : await agreedQuote(db, j.id);
  const credited = inv.credit_of ? await getInvoice(db, inv.credit_of) : null;
  let problems: string[] = [];
  if (inv.status === 'kladde') {
    const { sources } = await jobSources(db, j, await itemsOf(c, j.id), s, nowSec());
    problems = await issueProblems(db, inv, items, s, new Map(sources.map((x) => [x.key, x.qty])));
  }
  return render(
    c,
    inv.number ? `${inv.kind === 'kreditnota' ? 'Kreditnota' : 'Faktura'} ${inv.number}` : 'Fakturakladde',
    invoicePage({ inv, items, job: j, quote, credited, problems, csrf: c.get('csrf'), flashCode: c.req.query('besked'), errs }),
    NAV('faktura'),
    errs.length ? 400 : 200,
  );
}

okonomi.get('/faktura/:iid{[0-9]+}', async (c) => {
  if (!isManager(c)) return noAccess(c);
  const inv = await invoiceFor(c);
  return inv ? showInvoice(c, inv) : c.notFound();
});

okonomi.get('/faktura/:iid{[0-9]+\\.pdf}', async (c) => {
  if (!isManager(c)) return noAccess(c);
  const inv = await invoiceFor(c);
  if (!inv) return c.notFound();
  const db = c.env.DB;
  const [items, j] = await Promise.all([invoiceItems(db, inv.id), getJob(db, inv.job_id)]);
  if (!j) return c.notFound();
  const credited = inv.credit_of ? await getInvoice(db, inv.credit_of) : null;
  const bytes = await invoicePdf(inv, items, j, { company: companyInfo(c.get('settings')), customer: customerInfo(j) }, isDemo(c), credited?.number ?? null);
  const name = inv.number ? `${inv.kind === 'kreditnota' ? 'Kreditnota' : 'Faktura'}-${inv.number}.pdf` : `Fakturakladde-${j.number}.pdf`;
  return pdfResponse(bytes, name);
});

function requireDraft(inv: InvoiceRow): string | null {
  return inv.status === 'kladde' ? null : 'Fakturaen er udstedt og låst. Rettelser sker med en kreditnota.';
}

okonomi.post('/faktura/:iid{[0-9]+}/oplysninger', async (c) => {
  if (!isManager(c)) return noAccess(c);
  const inv = await invoiceFor(c);
  if (!inv) return c.notFound();
  const locked = requireDraft(inv);
  if (locked) return showInvoice(c, inv, [locked]);
  const body = await c.req.parseBody();
  const delivery = parseDay(body['delivery_date'] ?? '');
  const days = body['payment_days'] === undefined ? inv.payment_days : parseIntStrict(body['payment_days'], { max: 120 });
  const fixedRaw = str(body['fixed_amount'], 15);
  const fixed = fixedRaw ? parseKr(fixedRaw) : null;
  if (delivery === null || days === null || (fixedRaw && fixed === null)) return showInvoice(c, inv, ['Kontrollér leveringsdato, betalingsfrist (0-120 dage) og beløb.']);
  const now = nowSec();
  const stmts = [
    c.env.DB.prepare('UPDATE invoices SET delivery_date = ?, payment_days = ?, note = ?, fixed_amount = COALESCE(?, fixed_amount), updated_at = ? WHERE id = ?').bind(delivery, days, str(body['note'], 600, { multiline: true }), fixed, now, inv.id),
  ];
  if (fixed !== null) stmts.push(c.env.DB.prepare("UPDATE invoice_items SET unit_price = ?, note = '' WHERE invoice_id = ? AND type = 'fastpris'").bind(fixed, inv.id));
  await c.env.DB.batch(stmts);
  return c.redirect(`/job/faktura/${inv.id}?besked=gemt`, 303);
});

okonomi.post('/faktura/:iid{[0-9]+}/linjer', async (c) => {
  if (!isManager(c)) return noAccess(c);
  const inv = await invoiceFor(c);
  if (!inv) return c.notFound();
  const locked = requireDraft(inv);
  if (locked) return showInvoice(c, inv, [locked]);
  const db = c.env.DB;
  const body = await c.req.parseBody();
  const items = await invoiceItems(db, inv.id);
  const errs: string[] = [];
  // Højeste mængde pr. linje: det, der ikke er afregnet (faktura), eller originalens mængde (kreditnota)
  const max = new Map<number, number>();
  if (inv.kind === 'faktura') {
    const j = await getJob(db, inv.job_id);
    const { sources } = await jobSources(db, j!, await itemsOf(c, inv.job_id), c.get('settings'), nowSec());
    const rest = new Map(remaining(sources, await settled(db, inv.job_id)).map((x) => [x.key, x.qty]));
    for (const l of items) if (l.source_key && l.source_key !== 'fastpris') max.set(l.id, rest.get(l.source_key) ?? 0);
  } else if (inv.credit_of) {
    const orig = await invoiceItems(db, inv.credit_of);
    for (const l of items) {
      const o = orig.find((x) => x.source_key === l.source_key && x.type === l.type && x.description === l.description);
      if (o) max.set(l.id, o.qty);
    }
  }
  const stmts: D1PreparedStatement[] = [];
  for (const l of items) {
    const include = body[`inc_${l.id}`] === '1' ? 1 : 0;
    const desc = str(body[`desc_${l.id}`], 300) || l.description;
    let qty = l.qty;
    if (l.type !== 'fastpris' && body[`qty_${l.id}`] !== undefined) {
      const q = parseQty(body[`qty_${l.id}`]);
      if (q === null || q <= 0) {
        errs.push(`${l.description}: mængden er ikke gyldig.`);
        continue;
      }
      const m = max.get(l.id);
      if (m !== undefined && q > m) {
        errs.push(`${l.description}: højst ${qtyText(m, l.unit)} (resten er ${inv.kind === 'faktura' ? 'faktureret' : 'ikke faktureret'}).`);
        continue;
      }
      qty = q;
    }
    let price = l.unit_price;
    if (!l.covered && body[`price_${l.id}`] !== undefined) {
      const raw = str(body[`price_${l.id}`], 15);
      price = raw ? parseKr(raw) : null;
      if (raw && price === null) {
        errs.push(`${l.description}: prisen er ikke gyldig.`);
        continue;
      }
    }
    stmts.push(db.prepare("UPDATE invoice_items SET include = ?, description = ?, qty = ?, unit_price = ?, note = CASE WHEN ? IS NOT NULL AND note LIKE '%mangler%' THEN '' ELSE note END WHERE id = ?").bind(include, desc, qty, price, price, l.id));
  }
  if (errs.length) return showInvoice(c, inv, errs);
  stmts.push(db.prepare('UPDATE invoices SET updated_at = ? WHERE id = ?').bind(nowSec(), inv.id));
  await db.batch(stmts);
  return c.redirect(`/job/faktura/${inv.id}?besked=gemt`, 303);
});

okonomi.post('/faktura/:iid{[0-9]+}/linje', async (c) => {
  if (!isManager(c)) return noAccess(c);
  const inv = await invoiceFor(c);
  if (!inv) return c.notFound();
  const locked = requireDraft(inv);
  if (locked) return showInvoice(c, inv, [locked]);
  const body = await c.req.parseBody();
  const desc = str(body['description'], 300);
  const qty = parseQty(body['qty']);
  const price = parseKr(body['unit_price']);
  if (!desc || !qty || price === null) return showInvoice(c, inv, ['Angiv beskrivelse, antal og pris.']);
  await c.env.DB.prepare(
    `INSERT INTO invoice_items (invoice_id, type, source_key, description, qty, unit, unit_price, include, covered, note, sort_order)
     VALUES (?, 'omkostning', '', ?, ?, ?, ?, 1, 0, 'Tilføjet manuelt', (SELECT COALESCE(MAX(sort_order), 0) + 1 FROM invoice_items WHERE invoice_id = ?))`,
  )
    .bind(inv.id, desc, qty, str(body['unit'], 20) || 'stk.', price, inv.id)
    .run();
  return c.redirect(`/job/faktura/${inv.id}?besked=gemt`, 303);
});

okonomi.post('/faktura/:iid{[0-9]+}/udsted', async (c) => {
  if (!isManager(c)) return noAccess(c);
  const inv = await invoiceFor(c);
  if (!inv) return c.notFound();
  const body = await c.req.parseBody();
  if (body['reviewed'] !== '1') return showInvoice(c, inv, ['Bekræft, at du har gennemset fakturaen.']);
  const j = await getJob(c.env.DB, inv.job_id);
  if (!j) return c.notFound();
  const r = await issueInvoice(c.env.DB, inv, j, await itemsOf(c, j.id), c.get('settings'), actorOf(c), nowSec());
  if (!r.ok) return showInvoice(c, (await invoiceFor(c)) ?? inv, r.errors);
  return c.redirect(`/job/faktura/${inv.id}?besked=${inv.kind === 'faktura' ? 'faktura_udstedt' : 'kreditnota_udstedt'}`, 303);
});

okonomi.post('/faktura/:iid{[0-9]+}/kreditnota', async (c) => {
  if (!isManager(c)) return noAccess(c);
  const inv = await invoiceFor(c);
  if (!inv) return c.notFound();
  if (inv.kind !== 'faktura' || inv.status !== 'udstedt') return showInvoice(c, inv, ['Der kan kun laves kreditnota for en udstedt faktura.']);
  const id = await buildCredit(c.env.DB, inv, actorOf(c), nowSec());
  return c.redirect(`/job/faktura/${id}?besked=kreditnota_oprettet`, 303);
});

okonomi.post('/faktura/:iid{[0-9]+}/slet', async (c) => {
  if (!isManager(c)) return noAccess(c);
  const inv = await invoiceFor(c);
  if (!inv) return c.notFound();
  const locked = requireDraft(inv);
  if (locked) return showInvoice(c, inv, [locked]);
  const now = nowSec();
  await c.env.DB.batch([
    c.env.DB.prepare('DELETE FROM invoice_items WHERE invoice_id = ?').bind(inv.id),
    c.env.DB.prepare("DELETE FROM invoices WHERE id = ? AND status = 'kladde'").bind(inv.id),
    logStmt(c.env.DB, inv.job_id, 'faktura', `${inv.kind === 'faktura' ? 'Fakturakladde' : 'Kreditnotakladde'} slettet.`, actorOf(c), now),
  ]);
  return c.redirect(`/job/${inv.job_id}/faktura?besked=slettet`, 303);
});

export type { InvoiceItemRow, JobHead };
export default okonomi;
