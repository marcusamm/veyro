// Valg af en vare fra produktkataloget: reference i virksomhedens varekartotek og tilføjelse til
// et job. Referencen oprettes uden lagerbeholdning; mængder ændres kun af lagermotoren
// (reservation, forbrug og indkøb), aldrig af selve valget.

import type { JobRow, ProductRow } from '../env';
import { Q, formatQty } from './format';
import { Conflict, type Actor, type Tx } from './ledger';
import { logStmt } from './jobs';
import { manualPriceStmt } from './jobitems';
import { getProduct, planMaterial, registerUse } from './materials';
import { normGtin, normUnit } from './prices';
import { PRICE_TYPE_LABEL, codeKey, makerKey, veyroId, wholeUnitsFor, type CatalogDetail, type CatalogPriceRow } from './produktkatalog';

export type Handling = 'reserver' | 'brugt' | 'forventet';
export const HANDLING_LABEL: Record<Handling, string> = {
  reserver: 'Reservér det disponible og sæt det manglende på indkøbslisten',
  brugt: 'Registrér som brugt nu (trækkes fra lageret)',
  forventet: 'Tilføj kun som forventet materiale',
};

/** Varen i virksomhedens varekartotek, der svarer til katalogvaren (knyttet, eller samme EAN/producentnr.). */
export async function ownProductFor(db: D1Database, c: CatalogDetail): Promise<(ProductRow & { linked: boolean }) | null> {
  const linked = await db.prepare('SELECT * FROM products WHERE catalog_product_id = ?').bind(c.id).first<ProductRow>();
  if (linked) return { ...linked, linked: true };
  const { results } = await db
    .prepare(
      `SELECT * FROM products WHERE catalog_product_id IS NULL AND active = 1 AND (
         (?1 <> '' AND length(ean) >= 8 AND substr('00000000000000' || ean, -14) = ?1)
         OR (?2 <> '' AND lower(trim(brand)) = ?3 AND upper(replace(mpn, ' ', '')) = ?2)) LIMIT 2`,
    )
    .bind(c.gtin, c.mpn_key, c.maker_key)
    .all<ProductRow>();
  // Kun et entydigt match bruges; ellers oprettes en ny reference
  const p = results.length === 1 ? results[0]! : null;
  return p && (!p.ean || !c.gtin || normGtin(p.ean) === c.gtin) ? { ...p, linked: false } : null;
}

/** Ledigt varenummer til en ny reference: Veyros produkt-ID (kan rettes bagefter). */
async function freeSku(db: D1Database, c: CatalogDetail): Promise<string> {
  const base = veyroId(c.id);
  for (let i = 0; i < 20; i++) {
    const sku = i ? `${base}-${i + 1}` : base;
    if (!(await db.prepare('SELECT 1 FROM products WHERE sku = ?').bind(sku).first())) return sku;
  }
  return `${base}-${Date.now()}`;
}

/**
 * Sørger for, at katalogvaren findes i varekartoteket. En eksisterende vare med samme EAN eller
 * producentnr. knyttes til kataloget; ellers oprettes en ny vare med beholdning 0. Der oprettes
 * aldrig lager, indkøb eller modtagelse.
 */
export async function ensureOwnProduct(db: D1Database, c: CatalogDetail, unit: string, actor: Actor, now: number): Promise<{ product: ProductRow; created: boolean; linked: boolean }> {
  const found = await ownProductFor(db, c);
  if (found?.linked) return { product: found, created: false, linked: false };
  if (found) {
    await db.prepare('UPDATE products SET catalog_product_id = ?, updated_at = ? WHERE id = ? AND catalog_product_id IS NULL').bind(c.id, now, found.id).run();
    return { product: (await getProduct(db, found.id))!, created: false, linked: true };
  }
  const u = unit.trim().slice(0, 20);
  if (!u) throw new Conflict('Angiv varens enhed.');
  const sku = await freeSku(db, c);
  try {
    const row = await db
      .prepare(
        `INSERT INTO products (sku, name, unit, whole_units, category, ean, mpn, brand, variant, stock, reserved, catalog_product_id, active, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, ?, 1, ?, ?) RETURNING id`,
      )
      .bind(
        sku,
        c.name.slice(0, 120),
        u,
        wholeUnitsFor(u),
        c.category.slice(0, 60),
        c.gtin ? c.ean : '',
        c.mpn,
        c.manufacturer.slice(0, 60),
        [c.variant, c.dimensions].filter(Boolean).join(', ').slice(0, 60),
        c.id,
        now,
        now,
      )
      .first<{ id: number }>();
    await db
      .prepare(
        `INSERT INTO movements (product_id, kind, qty, stock_delta, reserved_delta, stock_after, reserved_after, reason, actor, actor_name, created_at)
         VALUES (?, 'oprettet', 0, 0, 0, 0, 0, ?, ?, ?, ?)`,
      )
      .bind(row!.id, `Oprettet fra produktkataloget (${veyroId(c.id)}, ${c.source_name}). Ingen lagerbeholdning.`, actor.email, actor.name, now)
      .run();
    return { product: (await getProduct(db, row!.id))!, created: true, linked: false };
  } catch (err) {
    // To samtidige valg af samme vare: den anden bruger den reference, den første oprettede
    if (String((err as Error).message).includes('UNIQUE')) {
      const p = await db.prepare('SELECT * FROM products WHERE catalog_product_id = ?').bind(c.id).first<ProductRow>();
      if (p) return { product: p, created: false, linked: false };
    }
    throw err;
  }
}

/** Jobbets materialelinje for varen (oprettes eller får mindst den nye mængde). */
function upsertItem(tx: Tx, jobId: number, p: ProductRow, catalogId: number | null, qty: number, planned: boolean, note: string): void {
  tx.add(
    tx.db
      .prepare(
        `INSERT INTO job_items (job_id, product_id, catalog_product_id, cost_basis, sku, name, unit, ean, mpn, brand, variant, qty, sale_mode, sale_price, note, planned_at,
           sort_order, created_by, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16,
           (SELECT COALESCE(MAX(sort_order), 0) + 1 FROM job_items WHERE job_id = ?1), ?17, ?18, ?18)
         ON CONFLICT(job_id, product_id) WHERE product_id IS NOT NULL
         DO UPDATE SET qty = MAX(qty, excluded.qty), catalog_product_id = COALESCE(catalog_product_id, excluded.catalog_product_id),
           planned_at = COALESCE(planned_at, excluded.planned_at), updated_at = excluded.updated_at`,
      )
      .bind(
        jobId,
        p.id,
        catalogId,
        p.purchase_price !== null ? 'lager' : 'byggemarked',
        p.sku,
        p.name,
        p.unit,
        p.ean,
        p.mpn,
        p.brand,
        p.variant,
        qty,
        p.sale_price !== null ? 'manuel' : 'paaslag',
        p.sale_price,
        note.slice(0, 200),
        planned ? tx.now : null,
        tx.actor.email,
        tx.now,
      ),
  );
}

/**
 * Tilføjer varen til jobbet med den valgte håndtering. Reservation og forbrug går gennem
 * lagermotoren, så lageret aldrig bliver negativt, og det manglende kommer på indkøbslisten.
 */
export async function addToJob(tx: Tx, job: JobRow, p: ProductRow, catalogId: number | null, q: number, handling: Handling, note: string): Promise<{ short: number }> {
  if (job.status !== 'aktiv') throw new Conflict('Jobbet er afsluttet.');
  if (p.whole_units && q % Q !== 0) throw new Conflict(`${p.name} håndteres kun i hele ${p.unit}.`);
  const existing = await tx.db.prepare('SELECT qty FROM job_items WHERE job_id = ? AND product_id = ?').bind(job.id, p.id).first<{ qty: number }>();
  const m = await tx.db.prepare('SELECT planned FROM job_materials WHERE job_id = ? AND product_id = ?').bind(job.id, p.id).first<{ planned: number }>();
  let short = 0;
  if (handling === 'forventet') {
    if (existing) throw new Conflict(`${p.name} er allerede på jobbet. Ret mængden på linjen.`);
    upsertItem(tx, job.id, p, catalogId, q, false, note);
    tx.add(logStmt(tx.db, job.id, 'materiale', `${p.name} tilføjet fra produktkataloget: ${formatQty(q)} ${p.unit} forventet.`, tx.actor, tx.now));
  } else if (handling === 'reserver') {
    const r = await planMaterial(tx, job, p, q, note || 'Valgt fra produktkataloget');
    short = r.short;
    upsertItem(tx, job.id, p, catalogId, (m?.planned ?? 0) + q, true, note);
  } else {
    await registerUse(tx, job, p, q, note || 'Valgt fra produktkataloget');
    upsertItem(tx, job.id, p, catalogId, Math.max(existing?.qty ?? 0, (m?.planned ?? 0) + q), false, note);
  }
  tx.jobs.add(job.id);
  return { short };
}

/** Katalogets pris kan bruges som pris på linjen, når valuta og momsgrundlag er kendt. */
export function usablePrice(p: Pick<CatalogPriceRow, 'currency' | 'vat'> | null): boolean {
  return !!p && p.currency === 'DKK' && p.vat !== 'ukendt';
}

/**
 * Sætter katalogets pris som manuel pris på linjen (kun når ejer eller indkøber vælger det).
 * Prisens kilde og type står ved prisen; den kaldes aldrig en forhandlers pris eller en indkøbspris.
 */
export async function applyCatalogPrice(db: D1Database, jobId: number, productId: number, price: CatalogPriceRow & { source_name: string }, actor: Actor, now: number): Promise<boolean> {
  if (!usablePrice(price)) return false;
  const it = await db.prepare('SELECT id, unit, price FROM job_items WHERE job_id = ? AND product_id = ?').bind(jobId, productId).first<{ id: number; unit: string; price: number | null }>();
  if (!it || it.price !== null) return false;
  // Prisen skal gælde linjens enhed (fx ikke en pakkepris på en linje i stk.)
  if (price.per && normUnit(price.per) !== normUnit(it.unit)) return false;
  const label = `${PRICE_TYPE_LABEL[price.price_type]} fra ${price.source_name}${price.seller ? ` (${price.seller})` : ''}`;
  await db.batch([
    manualPriceStmt(db, it.id, null, { price: price.amount, vat: price.vat as 'inkl' | 'ekskl', sales_unit: it.unit, pack_qty: Q, url: '', found_name: label.slice(0, 200) }, actor, now),
    logStmt(db, jobId, 'pris', `Pris fra produktkataloget sat som manuel pris: ${label}.`, actor, now),
  ]);
  return true;
}

export { codeKey, makerKey };
