// Fakturering af et job: fakturakladde → gennemse og godkend → udsted (låst, fortløbende nummer).
//
// Fakturaen bygger på det faktiske forbrug minus returvarer, godkendte fakturerbare timer, aftalte
// salgspriser og andre fakturerbare omkostninger. Hver linje har en kildenøgle (fx "lager:12" for en
// vare fra lageret eller "tid:5" for en timeregistrering). Summen pr. nøgle på udstedte fakturaer
// minus kreditnotaer er det, der er afregnet, så intet faktureres to gange, og et indkøb og det
// senere forbrug aldrig bliver til to fakturerbare hændelser:
//   lager:<vare>   udleveret eller brugt fra lageret minus returneret (også varer købt til jobbet)
//   sted:<vare>    leveret direkte til arbejdsstedet og registreret som brugt
//   item:<linje>   vare uden varenummer, registreret som brugt på jobbet
//   indkob:<linje> modtaget indkøb uden varenummer, som ikke hører til en materialelinje
//   tid:<id>       godkendt, fakturerbar arbejdstid
//   omk:<id>       anden fakturerbar omkostning
//   fastpris       aftalt fast pris
// Et overslag er aldrig automatisk en fast pris: fast pris vælges på fakturaen.

import type { InvoiceItemRow, InvoiceMode, InvoiceRow, JobRow } from '../env';
import { jobConsumption } from './billing';
import { Q, addDays, lineAmount, todayDk } from './format';
import { calcCtx, itemCalc, type ItemView } from './jobitems';
import { logStmt } from './jobs';
import type { Actor } from './ledger';
import { agreedQuote, companyInfo, customerInfo, quoteData, vatOf, vatRate, type CompanyInfo, type CustomerInfo } from './quotes';
import type { Settings } from './settings';

export const MODE_LABEL: Record<InvoiceMode, string> = {
  medgaaet: 'Medgået tid og materialer',
  fast: 'Aftalt fast pris',
  kombination: 'Fast pris for arbejdet + materialer efter forbrug',
};

export const TYPE_LABEL: Record<InvoiceItemRow['type'], string> = {
  materiale: 'Materialer',
  tid: 'Arbejdsløn',
  omkostning: 'Andre omkostninger',
  fastpris: 'Fast pris',
};

export interface Source {
  key: string;
  type: 'materiale' | 'tid' | 'omkostning';
  description: string;
  qty: number;
  unit: string;
  unit_price: number | null;
  unit_cost: number | null;
  extra: boolean;
  note: string;
}

export async function getInvoice(db: D1Database, id: number): Promise<InvoiceRow | null> {
  return db.prepare('SELECT * FROM invoices WHERE id = ?').bind(id).first<InvoiceRow>();
}

export async function invoiceItems(db: D1Database, id: number): Promise<InvoiceItemRow[]> {
  const { results } = await db.prepare('SELECT * FROM invoice_items WHERE invoice_id = ? ORDER BY sort_order, id').bind(id).all<InvoiceItemRow>();
  return results;
}

export async function jobInvoices(db: D1Database, jobId: number): Promise<InvoiceRow[]> {
  const { results } = await db.prepare('SELECT * FROM invoices WHERE job_id = ? ORDER BY id DESC').bind(jobId).all<InvoiceRow>();
  return results;
}

/** Afregnet mængde pr. kildenøgle: udstedte fakturaer minus kreditnotaer (og tidligere godkendte fakturagrundlag). */
export async function settled(db: D1Database, jobId: number): Promise<Map<string, number>> {
  const [{ results }, { results: legacy }] = await Promise.all([
    db
      .prepare(
        `SELECT ii.source_key AS key, SUM(CASE WHEN i.kind = 'faktura' THEN ii.qty ELSE -ii.qty END) AS qty
         FROM invoice_items ii JOIN invoices i ON i.id = ii.invoice_id
         WHERE i.job_id = ? AND i.status = 'udstedt' AND ii.include = 1 AND ii.source_key <> '' GROUP BY ii.source_key`,
      )
      .bind(jobId)
      .all<{ key: string; qty: number }>(),
    db
      .prepare(
        `SELECT l.source, l.product_id, l.purchase_line_id, SUM(l.qty) AS qty FROM invoice_lines l JOIN invoice_bases b ON b.id = l.basis_id
         WHERE b.job_id = ? AND b.status = 'godkendt' AND l.include = 1 GROUP BY l.source, l.product_id, l.purchase_line_id`,
      )
      .bind(jobId)
      .all<{ source: string; product_id: number | null; purchase_line_id: number | null; qty: number }>(),
  ]);
  const out = new Map(results.map((r) => [r.key, r.qty]));
  for (const l of legacy) {
    const key = l.source === 'lager' ? `lager:${l.product_id}` : l.source === 'arbejdssted' ? `sted:${l.product_id}` : `indkob:${l.purchase_line_id}`;
    out.set(key, (out.get(key) ?? 0) + l.qty);
  }
  return out;
}

/**
 * Alt fakturerbart på jobbet (før det afregnede trækkes fra). Salgspriser kommer fra det aftalte
 * overslag (accepteret eller delt med slutkunden), ellers fra materialelinjens aktuelle beregning,
 * ellers fra varens salgspris eller kostpris + påslag. Findes ingen pris, er den null (Pris mangler).
 */
export async function jobSources(db: D1Database, job: JobRow, items: ItemView[], s: Settings, now: number): Promise<{ sources: Source[]; pendingHours: number; quoteVersion: number | null }> {
  const ctx = calcCtx(job, s, now);
  const quote = await agreedQuote(db, job.id);
  const agreed = new Map<number, number | null>();
  if (quote) for (const m of quoteData(quote).materials) agreed.set(m.item_id, m.sale_unit);
  const markup = job.markup_pct ?? s.default_markup_pct;
  const byProduct = new Map(items.filter((i) => i.product_id).map((i) => [i.product_id!, i]));
  const itemPrice = (it: ItemView): { price: number | null; note: string } => {
    if (agreed.has(it.id) && agreed.get(it.id) !== null) return { price: agreed.get(it.id)!, note: `Aftalt i prisoverslag v${quote!.version}` };
    const c = itemCalc(it, it.qty, ctx);
    return { price: c.saleUnit, note: c.saleUnit === null ? c.missing : '' };
  };
  const sources: Source[] = [];
  const cons = await jobConsumption(db, job.id);
  const itemLines = new Set(items.map((i) => i.purchase_line_id).filter((x): x is number => x !== null));
  for (const c of cons) {
    if (c.source === 'direkte' && itemLines.has(c.purchase_line_id!)) continue;
    const it = c.product_id ? byProduct.get(c.product_id) : undefined;
    let price: number | null;
    let note = '';
    if (it) ({ price, note } = itemPrice(it));
    else price = c.sale_price ?? (c.unit_cost > 0 ? Math.round(c.unit_cost * (1 + markup / 100)) : null);
    if (price === null && !note) note = 'Pris mangler.';
    sources.push({
      key: c.source === 'lager' ? `lager:${c.product_id}` : c.source === 'arbejdssted' ? `sted:${c.product_id}` : `indkob:${c.purchase_line_id}`,
      type: 'materiale',
      description: c.name,
      qty: c.qty,
      unit: c.unit,
      unit_price: price,
      unit_cost: c.unit_cost || null,
      extra: false,
      note,
    });
  }
  for (const it of items) {
    if (it.product_id || it.used_qty <= 0) continue;
    const { price, note } = itemPrice(it);
    const cost = itemCalc(it, it.used_qty, ctx).unitCost;
    sources.push({ key: `item:${it.id}`, type: 'materiale', description: it.name, qty: it.used_qty, unit: it.unit, unit_price: price, unit_cost: cost, extra: false, note: price === null ? note || 'Pris mangler.' : note });
  }
  const { results: entries } = await db
    .prepare("SELECT * FROM job_entries WHERE job_id = ? AND phase = 'faktisk' AND billable = 1 ORDER BY work_date, id")
    .bind(job.id)
    .all<import('../env').JobEntryRow>();
  let pendingHours = 0;
  for (const e of entries) {
    if (e.type === 'tid' && !e.approved_at) {
      pendingHours += e.qty;
      continue;
    }
    const who = e.type === 'tid' ? [e.worker_type || e.worker_name, e.work_date].filter(Boolean).join(', ') : '';
    sources.push({
      key: `${e.type === 'tid' ? 'tid' : 'omk'}:${e.id}`,
      type: e.type === 'tid' ? 'tid' : 'omkostning',
      description: [e.description || (e.type === 'tid' ? 'Arbejdstimer' : 'Omkostning'), who && `(${who})`].filter(Boolean).join(' '),
      qty: e.qty,
      unit: e.unit,
      unit_price: e.unit_price,
      unit_cost: e.internal_cost,
      extra: !!e.extra,
      note: e.unit_price === null ? 'Timepris mangler.' : '',
    });
  }
  return { sources, pendingHours, quoteVersion: quote?.version ?? null };
}

/** Det, der endnu ikke er faktureret. */
export function remaining(sources: Source[], done: Map<string, number>): Source[] {
  return sources.map((x) => ({ ...x, qty: x.qty - (done.get(x.key) ?? 0) })).filter((x) => x.qty > 0);
}

export interface InvoiceTotals {
  byType: Record<InvoiceItemRow['type'], number>;
  subtotal: number;
  vat: number;
  total: number;
  missing: number;
}

export function itemAmount(l: Pick<InvoiceItemRow, 'qty' | 'unit_price' | 'include' | 'covered'>): number {
  return l.include && !l.covered ? lineAmount(l.unit_price, l.qty) : 0;
}

export function invoiceTotals(items: InvoiceItemRow[], rate: number): InvoiceTotals {
  const byType = { materiale: 0, tid: 0, omkostning: 0, fastpris: 0 };
  let missing = 0;
  for (const l of items) {
    if (l.include && !l.covered && l.unit_price === null) missing++;
    byType[l.type] += itemAmount(l);
  }
  const subtotal = byType.materiale + byType.tid + byType.omkostning + byType.fastpris;
  const vat = vatOf(subtotal, rate);
  return { byType, subtotal, vat, total: subtotal + vat, missing };
}

/** Er linjen indeholdt i den faste pris? */
function coveredBy(mode: InvoiceMode, src: Source): boolean {
  if (mode === 'medgaaet' || src.extra) return false;
  return mode === 'fast' || src.type === 'tid';
}

/**
 * Opretter jobbets fakturakladde (eller bygger den igen) ud fra det, der endnu ikke er faktureret.
 * Rettelser i en eksisterende kladde erstattes.
 */
export async function buildDraft(
  db: D1Database,
  job: JobRow,
  items: ItemView[],
  s: Settings,
  opts: { mode: InvoiceMode; fixed: number | null },
  actor: Actor,
  now: number,
): Promise<number> {
  const [{ sources }, done, quote] = await Promise.all([jobSources(db, job, items, s, now), settled(db, job.id), agreedQuote(db, job.id)]);
  const rest = remaining(sources, done);
  const fixedDone = (done.get('fastpris') ?? 0) >= Q;
  const mode = opts.mode;
  const fixed = mode === 'medgaaet' ? null : (opts.fixed ?? (mode === 'fast' ? (quote?.subtotal ?? null) : (quote?.labour ?? null)));
  const delivery = job.end_date || todayDk(now * 1000);
  const row = await db
    .prepare(
      `INSERT INTO invoices (job_id, kind, mode, fixed_amount, quote_id, customer, company, delivery_date, payment_days, vat_rate, created_by, created_at, updated_at)
       VALUES (?1, 'faktura', ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?11)
       ON CONFLICT(job_id, kind) WHERE status = 'kladde' DO UPDATE SET mode = ?2, fixed_amount = ?3, quote_id = ?4, customer = ?5, company = ?6,
         vat_rate = ?9, updated_at = ?11
       RETURNING id`,
    )
    .bind(job.id, mode, fixed, quote?.id ?? null, JSON.stringify(customerInfo(job)), JSON.stringify(companyInfo(s)), delivery, s.payment_days, vatRate(s), actor.email, now)
    .first<{ id: number }>();
  const id = row!.id;
  const stmts: D1PreparedStatement[] = [db.prepare('DELETE FROM invoice_items WHERE invoice_id = ?').bind(id)];
  const ins = (l: Omit<InvoiceItemRow, 'id' | 'invoice_id' | 'sort_order'>, i: number) =>
    db
      .prepare(
        `INSERT INTO invoice_items (invoice_id, type, source_key, description, qty, unit, unit_price, unit_cost, include, covered, note, sort_order)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(id, l.type, l.source_key, l.description.slice(0, 300), l.qty, l.unit, l.unit_price, l.unit_cost, l.include, l.covered, l.note.slice(0, 300), i);
  let n = 0;
  if (mode !== 'medgaaet' && !fixedDone) {
    stmts.push(
      ins(
        {
          type: 'fastpris',
          source_key: 'fastpris',
          description: mode === 'fast' ? `Aftalt fast pris: ${job.name}` : `Aftalt fast pris for arbejdet: ${job.name}`,
          qty: Q,
          unit: 'stk.',
          unit_price: fixed,
          unit_cost: null,
          include: 1,
          covered: 0,
          note: fixed === null ? 'Angiv den aftalte faste pris.' : '',
        },
        n++,
      ),
    );
  }
  const order: Source['type'][] = ['materiale', 'tid', 'omkostning'];
  for (const t of order) {
    for (const src of rest.filter((x) => x.type === t)) {
      const covered = coveredBy(mode, src) ? 1 : 0;
      stmts.push(
        ins(
          {
            type: src.type,
            source_key: src.key,
            description: src.description,
            qty: src.qty,
            unit: src.unit,
            unit_price: src.unit_price,
            unit_cost: src.unit_cost,
            include: 1,
            covered,
            note: covered ? 'Indeholdt i den faste pris' : src.extra ? `Ekstraarbejde. ${src.note}`.trim() : src.note,
          },
          n++,
        ),
      );
    }
  }
  stmts.push(logStmt(db, job.id, 'faktura', `Fakturakladde ${mode === 'medgaaet' ? 'oprettet' : `oprettet (${MODE_LABEL[mode].toLowerCase()})`} med ${n} linjer.`, actor, now));
  await db.batch(stmts);
  return id;
}

/** Kreditnota for en udstedt faktura. Linjerne kopieres, og brugeren kan fjerne eller sætte mængder ned. */
export async function buildCredit(db: D1Database, inv: InvoiceRow, actor: Actor, now: number): Promise<number> {
  const lines = await invoiceItems(db, inv.id);
  const row = await db
    .prepare(
      `INSERT INTO invoices (job_id, kind, credit_of, mode, fixed_amount, quote_id, customer, company, delivery_date, payment_days, vat_rate, note, created_by, created_at, updated_at)
       VALUES (?1, 'kreditnota', ?2, ?3, ?4, ?5, ?6, ?7, ?8, 0, ?9, ?10, ?11, ?12, ?12)
       ON CONFLICT(job_id, kind) WHERE status = 'kladde' DO UPDATE SET credit_of = ?2, mode = ?3, fixed_amount = ?4, customer = ?6, company = ?7, vat_rate = ?9, note = ?10, updated_at = ?12
       RETURNING id`,
    )
    .bind(inv.job_id, inv.id, inv.mode, inv.fixed_amount, inv.quote_id, inv.customer, inv.company, inv.delivery_date, inv.vat_rate, `Kreditnota for faktura nr. ${inv.number}.`, actor.email, now)
    .first<{ id: number }>();
  const id = row!.id;
  const stmts = [db.prepare('DELETE FROM invoice_items WHERE invoice_id = ?').bind(id)];
  lines
    .filter((l) => l.include)
    .forEach((l, i) =>
      stmts.push(
        db
          .prepare(
            `INSERT INTO invoice_items (invoice_id, type, source_key, description, qty, unit, unit_price, unit_cost, include, covered, note, sort_order)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, '', ?)`,
          )
          .bind(id, l.type, l.source_key, l.description, l.qty, l.unit, l.unit_price, l.unit_cost, l.covered, i),
      ),
    );
  stmts.push(logStmt(db, inv.job_id, 'faktura', `Kreditnotakladde oprettet for faktura nr. ${inv.number}.`, actor, now));
  await db.batch(stmts);
  return id;
}

/**
 * Det, der mangler, før fakturaen kan udstedes (tom liste = klar). `available` er det samlede
 * fakturerbare pr. kildenøgle; uden den kontrolleres kun mod det allerede afregnede.
 */
export async function issueProblems(db: D1Database, inv: InvoiceRow, items: InvoiceItemRow[], s: Settings, available?: Map<string, number>): Promise<string[]> {
  const p: string[] = [];
  const c = parseJson<CustomerInfo>(inv.customer);
  if (!s.company_name || s.company_name === 'Mit firma') p.push('Virksomhedens navn mangler (Indstillinger).');
  if (!s.company_address) p.push('Virksomhedens adresse mangler (Indstillinger).');
  if (!/^\d{8}$/.test(s.company_cvr.replace(/\s/g, ''))) p.push('Virksomhedens CVR-nummer mangler (8 cifre, Indstillinger).');
  if (s.vat_registered !== 'ja' && s.vat_registered !== 'nej') p.push('Angiv under Indstillinger, om virksomheden er momsregistreret.');
  if (!s.bank_reg || !s.bank_account) p.push('Betalingsoplysninger (reg.nr. og kontonr.) mangler (Indstillinger).');
  if (!c.name) p.push('Slutkundens navn mangler på jobbet.');
  if (!c.address) p.push('Slutkundens faktureringsadresse mangler på jobbet.');
  const live = items.filter((l) => l.include);
  if (!live.length) p.push('Fakturaen har ingen linjer.');
  const missing = live.filter((l) => !l.covered && l.unit_price === null);
  if (missing.length) p.push(`${missing.length} ${missing.length === 1 ? 'linje mangler' : 'linjer mangler'} en pris.`);
  if (!inv.delivery_date) p.push('Angiv leveringsdatoen.');
  const done = await settled(db, inv.job_id);
  const qty = new Map<string, number>();
  for (const l of live) if (l.source_key) qty.set(l.source_key, (qty.get(l.source_key) ?? 0) + l.qty);
  if (inv.kind === 'faktura') {
    // Intet må faktureres mere end én gang
    for (const [key, q] of qty) {
      const total = key === 'fastpris' ? Q : available?.get(key);
      if (total !== undefined && (done.get(key) ?? 0) + q > total) {
        p.push(key === 'fastpris' ? 'Den faste pris er allerede faktureret.' : 'Nogle linjer er allerede faktureret. Opdatér kladden fra jobbet.');
        break;
      }
    }
  } else {
    for (const [key, q] of qty) {
      if (q > (done.get(key) ?? 0)) {
        p.push('Der kan højst krediteres det, der er faktureret.');
        break;
      }
    }
  }
  return p;
}

/**
 * Udsteder fakturaen eller kreditnotaen: fortløbende nummer, låste oplysninger om virksomhed og
 * slutkunde, fakturadato, betalingsfrist og beløb. Herefter kan den ikke ændres; rettelser sker
 * med en kreditnota (og evt. en ny faktura).
 */
export async function issueInvoice(
  db: D1Database,
  inv: InvoiceRow,
  job: JobRow,
  items: ItemView[],
  s: Settings,
  actor: Actor,
  now: number,
): Promise<{ ok: true; number: number } | { ok: false; errors: string[] }> {
  if (inv.status !== 'kladde') return { ok: false, errors: ['Fakturaen er allerede udstedt.'] };
  const lines = await invoiceItems(db, inv.id);
  const { sources } = await jobSources(db, job, items, s, now);
  const problems = await issueProblems(db, inv, lines, s, new Map(sources.map((x) => [x.key, x.qty])));
  if (problems.length) return { ok: false, errors: problems };
  // En kreditnota bruger den krediterede fakturas oplysninger og momssats
  const credit = inv.kind === 'kreditnota';
  const rate = credit ? inv.vat_rate : vatRate(s);
  const t = invoiceTotals(lines, rate);
  const today = todayDk(now * 1000);
  const days = inv.kind === 'faktura' ? inv.payment_days : 0;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const row = await db
        .prepare(
          `UPDATE invoices SET status = 'udstedt', number = (SELECT MAX(COALESCE(MAX(number), 0) + 1, ?1) FROM invoices),
             company = ?2, customer = ?3, issue_date = ?4, due_date = ?5, vat_rate = ?6, subtotal = ?7, vat = ?8, total = ?9,
             issued_by = ?10, issued_at = ?11, updated_at = ?11
           WHERE id = ?12 AND status = 'kladde' RETURNING number`,
        )
        .bind(
          Math.max(1, s.invoice_start),
          credit ? inv.company : JSON.stringify(companyInfo(s)),
          credit ? inv.customer : JSON.stringify(customerInfo(job)),
          today,
          addDays(today, days),
          rate,
          t.subtotal,
          t.vat,
          t.total,
          actor.email,
          now,
          inv.id,
        )
        .first<{ number: number }>();
      if (!row) return { ok: false, errors: ['Fakturaen er allerede udstedt.'] };
      await logStmt(
        db,
        job.id,
        'faktura',
        `${inv.kind === 'faktura' ? 'Faktura' : 'Kreditnota'} nr. ${row.number} udstedt: ${(t.total / 100).toFixed(2).replace('.', ',')} kr. inkl. moms.`,
        actor,
        now,
      ).run();
      return { ok: true, number: row.number };
    } catch (err) {
      if (!String((err as Error)?.message).includes('UNIQUE') || attempt === 2) throw err;
    }
  }
  return { ok: false, errors: ['Fakturanummeret kunne ikke tildeles. Prøv igen.'] };
}

export function parseJson<T>(raw: string): T {
  try {
    return { ...(JSON.parse(raw) as T) };
  } catch {
    return {} as T;
  }
}

export type { CompanyInfo, CustomerInfo };

/** Fakturastatus for jobbet (til joblisten). */
export function billingStatus(r: { issued: number; drafts: number; credits: number }): string {
  if (r.issued > 0) return r.drafts > 0 ? 'Faktureret, ny kladde' : r.credits > 0 ? 'Faktureret, krediteret' : 'Faktureret';
  return r.drafts > 0 ? 'Fakturakladde' : 'Ikke faktureret';
}
