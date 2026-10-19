// Prisestimater i databasen: forhandlere, prisfiler (cache), prisopslag pr. indkøbslinje,
// manuelle priser, godkendelse af alternativer og valg af forhandler.
//
// Prisopslag kører adskilt fra lager og indkøb: de skriver kun i price_estimates og
// purchase_lines.price_checked_at, og en fejl hos en forhandler stopper
// aldrig registrering af forbrug eller oprettelse af lister.

import type { Env, PurchaseLineRow } from '../env';
import { todayDk } from './format';
import {
  buyPlan,
  findMatch,
  lineEstimate,
  missingQty,
  nameTokens,
  normGtin,
  parseFeed,
  summarize,
  type Access,
  type CatalogRow,
  type EstimateOpts,
  type EstimateSource,
  type EstimateView,
  type FeedItem,
  type LineEstimate,
  type ListEstimate,
  type MatchBasis,
  type MatchKind,
  type OfferTerms,
  type Vat,
} from './prices';
import type { Settings } from './settings';

export interface RetailerRow {
  id: number;
  key: string;
  name: string;
  website: string;
  access: Access;
  terms_note: string;
  feed_url: string;
  active: number;
  last_import_at: number | null;
  last_import_rows: number | null;
  last_error: string;
  created_at: number;
}

export type RetailerView = RetailerRow & { catalog_count: number; catalog_checked_at: number | null };

export async function retailers(db: D1Database, opts: { activeOnly?: boolean } = {}): Promise<RetailerView[]> {
  const { results } = await db
    .prepare(
      `SELECT r.*, (SELECT COUNT(*) FROM retailer_products p WHERE p.retailer_id = r.id) AS catalog_count,
         (SELECT MAX(checked_at) FROM retailer_products p WHERE p.retailer_id = r.id) AS catalog_checked_at
       FROM retailers r ${opts.activeOnly ? 'WHERE r.active = 1' : ''} ORDER BY r.access = 'demo' DESC, r.name COLLATE NOCASE`,
    )
    .all<RetailerView>();
  return results;
}

export async function getRetailer(db: D1Database, id: number): Promise<RetailerRow | null> {
  return db.prepare('SELECT * FROM retailers WHERE id = ?').bind(id).first<RetailerRow>();
}

export function estimateOpts(s: Settings, now: number): EstimateOpts {
  return { basis: s.estimate_vat === 'inkl' ? 'inkl' : 'ekskl', maxAgeDays: s.price_max_age_days, now, today: todayDk(now * 1000) };
}

// --- Prisfiler ------------------------------------------------------------------------------

/**
 * Lægger en forhandlers prisfil i cachen. Rækker, der ikke længere står i filen, fjernes, så et
 * senere prisopslag viser deres estimater som "Tidligere pris – ikke bekræftet".
 */
export async function importCatalog(db: D1Database, r: RetailerRow, items: FeedItem[], source: 'prisfil' | 'demodata', now: number): Promise<void> {
  const ins = (it: FeedItem) =>
    db
      .prepare(
        `INSERT INTO retailer_products (retailer_id, retailer_sku, ean, mpn, brand, variant, name, url, sales_unit, pack_qty, content_unit, min_qty, divisible,
           price, vat, offer_price, offer_text, offer_min_qty, offer_until, stock_text, source, checked_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19, ?20, ?21, ?22)
         ON CONFLICT(retailer_id, retailer_sku) DO UPDATE SET ean = ?3, mpn = ?4, brand = ?5, variant = ?6, name = ?7, url = ?8, sales_unit = ?9,
           pack_qty = ?10, content_unit = ?11, min_qty = ?12, divisible = ?13, price = ?14, vat = ?15, offer_price = ?16, offer_text = ?17,
           offer_min_qty = ?18, offer_until = ?19, stock_text = ?20, source = ?21, checked_at = ?22`,
      )
      .bind(
        r.id,
        it.retailer_sku,
        it.ean,
        it.mpn,
        it.brand,
        it.variant,
        it.name,
        it.url,
        it.sales_unit,
        it.pack_qty,
        it.content_unit,
        it.min_qty,
        it.divisible,
        it.price,
        it.vat,
        it.offer_price,
        it.offer_text,
        it.offer_min_qty,
        it.offer_until,
        it.stock_text,
        source,
        now,
      );
  for (let i = 0; i < items.length; i += 50) await db.batch(items.slice(i, i + 50).map(ins));
  await db.batch([
    db.prepare('DELETE FROM retailer_products WHERE retailer_id = ? AND checked_at < ?').bind(r.id, now),
    db
      .prepare(
        `UPDATE retailers SET last_import_at = ?, last_import_rows = ?, last_error = '', access = CASE WHEN access = 'manuel' THEN 'prisfil' ELSE access END WHERE id = ?`,
      )
      .bind(now, items.length, r.id),
  ]);
}

const FEED_MAX_BYTES = 5_000_000;
const FEED_MAX_AGE = 6 * 3600;

/**
 * Henter officielle prisfiler fra forhandlere med et feed (på serveren, med timeout). Resultatet
 * gemmes i cachen og hentes højst hver 6. time, medmindre `force` er sat. Fejl gemmes på
 * forhandleren og stopper ikke noget andet.
 */
export async function fetchFeeds(env: Env, now: number, force = false): Promise<{ name: string; ok: boolean; message: string }[]> {
  const { results } = await env.DB.prepare("SELECT * FROM retailers WHERE active = 1 AND feed_url <> '' AND access <> 'demo'").all<RetailerRow>();
  const out: { name: string; ok: boolean; message: string }[] = [];
  for (const r of results) {
    if (!force && r.last_import_at && now - r.last_import_at < FEED_MAX_AGE) continue;
    try {
      if (!feedUrlAllowed(env, r.feed_url)) throw new Error('Feedet skal være en https-adresse.');
      const res = await fetch(r.feed_url, { headers: { 'User-Agent': 'Veyro-Lagerstyring/1.0 (prisfil)', Accept: 'text/csv, text/plain' }, signal: AbortSignal.timeout(10_000) });
      if (!res.ok) throw new Error(`Feedet svarede ${res.status}.`);
      const text = await res.text();
      if (text.length > FEED_MAX_BYTES) throw new Error('Feedet er for stort.');
      const { items, errors } = parseFeed(text, r.website);
      if (!items.length) throw new Error(errors[0] ?? 'Feedet indeholdt ingen priser.');
      await importCatalog(env.DB, r, items, 'prisfil', now);
      out.push({ name: r.name, ok: true, message: `${items.length} ${items.length === 1 ? 'pris' : 'priser'} hentet${errors.length ? `, ${errors.length} rækker afvist` : ''}.` });
    } catch (err) {
      const message = String((err as Error)?.message ?? err).slice(0, 300);
      await env.DB.prepare('UPDATE retailers SET last_error = ? WHERE id = ?').bind(message, r.id).run();
      out.push({ name: r.name, ok: false, message });
    }
  }
  return out;
}

export function feedUrlAllowed(env: Pick<Env, 'DEV_MODE'>, url: string): boolean {
  try {
    const u = new URL(url);
    if (u.protocol === 'https:') return true;
    // Kun til lokale tests
    return env.DEV_MODE === '1' && u.protocol === 'http:' && (u.hostname === '127.0.0.1' || u.hostname === 'localhost');
  } catch {
    return false;
  }
}

// --- Prisopslag pr. linje -------------------------------------------------------------------

type WantedLine = PurchaseLineRow & { ean: string | null; mpn: string | null; brand: string | null; variant: string | null };
type CandRow = CatalogRow & { retailer_access: Access };

const WANTED_SQL = `SELECT l.*, p.ean, p.mpn, p.brand, p.variant FROM purchase_lines l LEFT JOIN products p ON p.id = l.product_id`;

const ESTIMATE_COLS = `line_id, retailer_id, retailer_product_id, match, basis, approved_by, approved_at, name, url, sales_unit, pack_qty, content_unit, min_qty,
  divisible, price, vat, offer_price, offer_text, offer_min_qty, offer_until, stock_text, need_qty, buy_qty, amount, source, status, note, checked_at, created_by, created_at`;

interface NewEstimate extends OfferTerms {
  line_id: number;
  retailer_id: number;
  retailer_product_id: number | null;
  match: MatchKind;
  basis: MatchBasis;
  approved_by: string | null;
  approved_at: number | null;
  name: string;
  url: string;
  stock_text: string;
  source: EstimateSource;
  status: 'aktuel' | 'forslag';
  note: string;
  checked_at: number;
}

function insertEstimate(db: D1Database, e: NewEstimate, line: Pick<PurchaseLineRow, 'qty' | 'ordered' | 'cancelled' | 'unit'>, actor: string, now: number): D1PreparedStatement {
  const need = missingQty(line);
  const plan = buyPlan(need, line.unit, e, todayDk(now * 1000));
  return db
    .prepare(`INSERT INTO price_estimates (${ESTIMATE_COLS}) VALUES (${Array.from({ length: 30 }, (_, i) => `?${i + 1}`).join(', ')})`)
    .bind(
      e.line_id,
      e.retailer_id,
      e.retailer_product_id,
      e.match,
      e.basis,
      e.approved_by,
      e.approved_at,
      e.name,
      e.url,
      e.sales_unit,
      e.pack_qty,
      e.content_unit,
      e.min_qty,
      e.divisible,
      e.price,
      e.vat,
      e.offer_price,
      e.offer_text,
      e.offer_min_qty,
      e.offer_until,
      e.stock_text,
      need,
      plan.ok ? plan.buy : null,
      plan.ok ? plan.amount : null,
      e.source,
      e.status,
      e.note,
      e.checked_at,
      actor,
      now,
    );
}

function fromCatalog(lineId: number, c: CandRow, match: MatchKind, basis: MatchBasis, status: 'aktuel' | 'forslag'): NewEstimate {
  return {
    line_id: lineId,
    retailer_id: c.retailer_id,
    retailer_product_id: c.id,
    match,
    basis,
    approved_by: null,
    approved_at: null,
    name: c.name,
    url: c.url,
    sales_unit: c.sales_unit,
    pack_qty: c.pack_qty,
    content_unit: c.content_unit,
    min_qty: c.min_qty,
    divisible: c.divisible,
    price: c.price,
    vat: c.vat,
    offer_price: c.offer_price,
    offer_text: c.offer_text,
    offer_min_qty: c.offer_min_qty,
    offer_until: c.offer_until,
    stock_text: c.stock_text,
    source: c.source,
    status,
    note: '',
    checked_at: c.checked_at,
  };
}

const sameOffer = (e: EstimateView, c: CandRow) =>
  e.retailer_product_id === c.id &&
  e.price === c.price &&
  e.vat === c.vat &&
  e.pack_qty === c.pack_qty &&
  e.min_qty === c.min_qty &&
  e.offer_price === c.offer_price &&
  e.offer_until === c.offer_until &&
  e.offer_min_qty === c.offer_min_qty &&
  e.checked_at === c.checked_at;

async function candidates(db: D1Database, w: WantedLine): Promise<CandRow[]> {
  const words = [...nameTokens(w.name).words].sort((a, b) => b.length - a.length).slice(0, 2);
  const like = (i: number) => (words[i] ? `%${words[i]}%` : '\u0000');
  const { results } = await db
    .prepare(
      `SELECT p.*, r.access AS retailer_access FROM retailer_products p JOIN retailers r ON r.id = p.retailer_id
       WHERE r.active = 1 AND r.access IN ('prisfil', 'demo')
         AND (p.ean = ?1 OR (p.mpn <> '' AND p.brand = ?2 COLLATE NOCASE) OR p.name LIKE ?3 OR p.name LIKE ?4)
       LIMIT 500`,
    )
    .bind(normGtin(w.ean ?? '') ?? '\u0000', w.brand || '\u0000', like(0), like(1))
    .all<CandRow>();
  return results;
}

/**
 * Slår priser op for linjerne hos alle aktive forhandlere med prisdata. Manuelle priser
 * overskrives aldrig: findes der en anden pris i prisdata, lægges den som et forslag, brugeren
 * kan acceptere. Forsvinder en pris fra prisdata, markeres estimatet som en tidligere pris.
 */
export async function refreshLines(db: D1Database, lineIds: number[], actor: string, now: number): Promise<{ checked: number; failed: number }> {
  let checked = 0;
  let failed = 0;
  for (const id of lineIds) {
    try {
      const w = await db.prepare(`${WANTED_SQL} WHERE l.id = ?`).bind(id).first<WantedLine>();
      if (!w || w.cancelled || missingQty(w) <= 0) continue;
      const wanted = { ean: w.ean ?? '', mpn: w.mpn ?? '', brand: w.brand ?? '', variant: w.variant ?? '', name: w.name, unit: w.unit };
      const [cands, { results: current }] = await Promise.all([
        candidates(db, w),
        db.prepare("SELECT e.*, r.name AS retailer_name, r.access AS retailer_access FROM price_estimates e JOIN retailers r ON r.id = e.retailer_id WHERE e.line_id = ? AND e.status <> 'erstattet'").bind(id).all<EstimateView>(),
      ]);
      const byRetailer = new Map<number, CandRow[]>();
      for (const c of cands) {
        if (!byRetailer.has(c.retailer_id)) byRetailer.set(c.retailer_id, []);
        byRetailer.get(c.retailer_id)!.push(c);
      }
      const stmts: D1PreparedStatement[] = [];
      const seen = new Set<number>();
      for (const [rid, list] of byRetailer) {
        const m = findMatch(wanted, list);
        if (!m) continue;
        seen.add(rid);
        const live = current.find((e) => e.retailer_id === rid && (e.status === 'aktuel' || e.status === 'tidligere'));
        const proposal = current.find((e) => e.retailer_id === rid && e.status === 'forslag');
        if (live?.source === 'manuel') {
          // Manuel pris: kun et forslag, og kun hvis prisdata siger noget andet
          if (live.price === m.row.price && live.vat === m.row.vat && live.pack_qty === m.row.pack_qty) continue;
          if (proposal && sameOffer(proposal, m.row)) continue;
          if (proposal) stmts.push(db.prepare("UPDATE price_estimates SET status = 'erstattet', replaced_at = ? WHERE id = ?").bind(now, proposal.id));
          stmts.push(insertEstimate(db, fromCatalog(id, m.row, m.match, m.basis, 'forslag'), w, actor, now));
          continue;
        }
        if (live && sameOffer(live, m.row) && live.match === m.match) {
          if (live.status === 'tidligere') stmts.push(db.prepare("UPDATE price_estimates SET status = 'aktuel' WHERE id = ?").bind(live.id));
          continue;
        }
        const next = fromCatalog(id, m.row, m.match, m.basis, 'aktuel');
        // En godkendelse gælder varen, så den følger med, når prisen på samme vare ændres
        if (live && live.retailer_product_id === m.row.id && live.approved_at) {
          next.approved_by = live.approved_by;
          next.approved_at = live.approved_at;
        }
        if (live) stmts.push(db.prepare("UPDATE price_estimates SET status = 'erstattet', replaced_at = ? WHERE id = ?").bind(now, live.id));
        stmts.push(insertEstimate(db, next, w, actor, now));
      }
      for (const e of current) {
        if (e.source !== 'manuel' && e.status === 'aktuel' && !seen.has(e.retailer_id) && (e.retailer_access === 'prisfil' || e.retailer_access === 'demo')) {
          stmts.push(db.prepare("UPDATE price_estimates SET status = 'tidligere' WHERE id = ?").bind(e.id));
        }
      }
      stmts.push(db.prepare('UPDATE purchase_lines SET price_checked_at = ? WHERE id = ?').bind(now, id));
      await db.batch(stmts);
      checked++;
    } catch (err) {
      failed++;
      console.error('Prisopslag fejlede for linje', id, (err as Error)?.message);
    }
  }
  return { checked, failed };
}

/** Prisopslag for en hel liste. `onlyNew` slår kun op for linjer, der aldrig er slået op. */
export async function refreshList(db: D1Database, listId: number, actor: string, now: number, opts: { onlyNew?: boolean } = {}) {
  const { results } = await db
    .prepare(`SELECT id FROM purchase_lines WHERE list_id = ? AND cancelled = 0 AND qty > ordered ${opts.onlyNew ? 'AND price_checked_at IS NULL' : ''}`)
    .bind(listId)
    .all<{ id: number }>();
  return refreshLines(db, results.map((r) => r.id), actor, now);
}

// --- Visning --------------------------------------------------------------------------------

export async function estimatesFor(db: D1Database, lineIds: number[]): Promise<Map<number, EstimateView[]>> {
  const out = new Map<number, EstimateView[]>();
  if (!lineIds.length) return out;
  const { results } = await db
    .prepare(
      `SELECT e.*, r.name AS retailer_name, r.access AS retailer_access FROM price_estimates e JOIN retailers r ON r.id = e.retailer_id
       WHERE e.status <> 'erstattet' AND e.line_id IN (${lineIds.map(() => '?').join(',')}) ORDER BY e.id`,
    )
    .bind(...lineIds)
    .all<EstimateView>();
  for (const e of results) {
    if (!out.has(e.line_id)) out.set(e.line_id, []);
    out.get(e.line_id)!.push(e);
  }
  return out;
}

export type EstimatedLine<L> = { line: L; est: LineEstimate };

export async function listEstimate<L extends Pick<PurchaseLineRow, 'id' | 'name' | 'qty' | 'ordered' | 'cancelled' | 'unit'>>(
  db: D1Database,
  s: Settings,
  lines: L[],
  now: number,
): Promise<{ items: EstimatedLine<L>[]; summary: ListEstimate; opts: EstimateOpts }> {
  const opts = estimateOpts(s, now);
  const live = lines.filter((l) => !l.cancelled);
  const map = await estimatesFor(db, live.map((l) => l.id));
  const items = live.map((line) => ({ line, est: lineEstimate(line, map.get(line.id) ?? [], opts) }));
  return { items, summary: summarize(items.map((x) => ({ name: x.line.name, est: x.est })), opts.basis), opts };
}

// --- Handlinger fra brugeren ----------------------------------------------------------------

export interface ManualInput {
  retailer_id: number;
  match: MatchKind;
  name: string;
  url: string;
  sales_unit: string;
  pack_qty: number;
  content_unit: string;
  min_qty: number;
  divisible: number;
  price: number;
  vat: Vat;
  offer_price: number | null;
  offer_text: string;
  note: string;
}

/** Manuelt indtastet pris (med produktlink). Erstatter det gældende estimat hos samme forhandler. */
export async function saveManual(db: D1Database, line: PurchaseLineRow, m: ManualInput, actor: string, now: number): Promise<void> {
  const stmts = [
    db.prepare("UPDATE price_estimates SET status = 'erstattet', replaced_at = ? WHERE line_id = ? AND retailer_id = ? AND status <> 'erstattet'").bind(now, line.id, m.retailer_id),
    insertEstimate(
      db,
      {
        ...m,
        line_id: line.id,
        retailer_product_id: null,
        basis: 'manuel',
        approved_by: null,
        approved_at: null,
        offer_min_qty: null,
        offer_until: '',
        stock_text: '',
        source: 'manuel',
        status: 'aktuel',
        checked_at: now,
      },
      line,
      actor,
      now,
    ),
  ];
  await db.batch(stmts);
}

/** Godkender et alternativ. Linjens vare ændres ikke; alternativet tæller blot med i estimatet. */
export async function approveAlternative(db: D1Database, estimateId: number, actorName: string, now: number): Promise<number | null> {
  const row = await db
    .prepare("UPDATE price_estimates SET approved_by = ?, approved_at = ? WHERE id = ? AND match = 'alternativ' AND status IN ('aktuel', 'tidligere') RETURNING line_id")
    .bind(actorName, now, estimateId)
    .first<{ line_id: number }>();
  return row?.line_id ?? null;
}

/** Brugeren accepterer en ny pris, der er fundet for en vare med manuel pris. */
export async function acceptProposal(db: D1Database, estimateId: number, now: number): Promise<number | null> {
  const p = await db.prepare("SELECT * FROM price_estimates WHERE id = ? AND status = 'forslag'").bind(estimateId).first<EstimateView>();
  if (!p) return null;
  await db.batch([
    db.prepare("UPDATE price_estimates SET status = 'erstattet', replaced_at = ? WHERE line_id = ? AND retailer_id = ? AND status IN ('aktuel', 'tidligere')").bind(now, p.line_id, p.retailer_id),
    db.prepare("UPDATE price_estimates SET status = 'aktuel' WHERE id = ?").bind(p.id),
  ]);
  return p.line_id;
}

/** Fjerner et estimat eller afviser et forslag (bevares i historikken som erstattet). */
export async function dismissEstimate(db: D1Database, estimateId: number, now: number): Promise<number | null> {
  const row = await db
    .prepare("UPDATE price_estimates SET status = 'erstattet', replaced_at = ? WHERE id = ? AND status <> 'erstattet' RETURNING line_id")
    .bind(now, estimateId)
    .first<{ line_id: number }>();
  return row?.line_id ?? null;
}

/** Historik: alle estimater for en linje, også de erstattede. */
export async function estimateHistory(db: D1Database, lineId: number): Promise<EstimateView[]> {
  const { results } = await db
    .prepare('SELECT e.*, r.name AS retailer_name, r.access AS retailer_access FROM price_estimates e JOIN retailers r ON r.id = e.retailer_id WHERE e.line_id = ? ORDER BY e.id DESC')
    .bind(lineId)
    .all<EstimateView>();
  return results;
}
