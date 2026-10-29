// Jobbets materialer i prisberegningen: forventede mængder, prisopslag hos det valgte
// byggemarked, kostpris og salgspris til slutkunden.
//
// Tre ting holdes adskilt:
//   forbrug    = det, der bruges på jobbet (forventet mængde, senere registreret forbrug)
//   købsmængde = det, der skal købes (hele pakker, mindstekøb), fx 2 pk. á 10 stk. for 12 stk.
//   faktureres = forbruget; et overskud fra hele pakker faktureres aldrig automatisk
//
// Prisopslag bruger kun det byggemarked, der er valgt for linjen eller jobbet. Der skiftes aldrig
// byggemarked i stilhed, og en pris tæller kun med, når den er et præcist match, et godkendt
// alternativ eller indtastet manuelt. Mangler prisen, er salgsprisen "Pris mangler" (aldrig 0).

import type { Env, JobItemRow, JobRow } from '../env';
import { Q, lineAmount, todayDk } from './format';
import { canReadPages, fetchProductPage, getRetailer, readProductPages, type RetailerRow } from './estimates';
import { Conflict, type Actor, type Tx } from './ledger';
import { defaultJobList, getMaterial, getProduct, setPlanned } from './materials';
import { buyPlan, convertVat, findMatch, nameTokens, normGtin, normUnit, type BuyPlan, type CatalogRow, type MatchBasis, type MatchKind, type Vat } from './prices';
import type { Settings } from './settings';

export const SALE_MODE_LABEL: Record<JobItemRow['sale_mode'], string> = {
  offentlig: 'Offentlig pris',
  paaslag: 'Kostpris + påslag',
  manuel: 'Manuel salgspris',
};

export const COST_BASIS_LABEL: Record<JobItemRow['cost_basis'], string> = {
  lager: 'Eget lager (kostpris)',
  byggemarked: 'Købes i byggemarked',
};

/** Søgesider, der er afprøvet og åbner i brugerens egen browser (vi søger ikke selv). */
const SEARCH_URL: Record<string, string> = {
  stark: 'https://www.stark.dk/search?q=',
  bauhaus: 'https://www.bauhaus.dk/catalogsearch/result/?q=',
  jemogfix: 'https://www.jemogfix.dk/soeg?q=',
};

/** Link, hvor brugeren selv kan finde varen hos byggemarkedet (søgning eller forsiden). */
export function findUrl(r: Pick<RetailerRow, 'key' | 'website'>, name: string): string {
  const base = SEARCH_URL[r.key];
  return base ? base + encodeURIComponent(name) : r.website;
}

/** Byggemarkedet er aktivt i Veyro, når prisopslag er implementeret og afprøvet (eller demodata). */
export function retailerLive(r: Pick<RetailerRow, 'access' | 'active' | 'terms_confirmed_at'>): boolean {
  return !!r.active && (canReadPages(r) || r.access === 'prisfil' || r.access === 'demo');
}

export type ItemView = JobItemRow & {
  retailer_name: string | null;
  retailer_key: string | null;
  retailer_website: string | null;
  retailer_access: string | null;
  /** Permission belongs to the price's original retailer, independent of today's preference. */
  price_side_allowed: number;
  price_retailer_name: string | null;
  product_purchase_price: number | null;
  product_sale_price: number | null;
  product_whole_units: number | null;
  product_stock: number | null;
  product_reserved: number | null;
  /** Lagermotorens tal for varen på jobbet (kun varer med varenummer) */
  m_planned: number | null;
  m_reserved: number | null;
  m_issued: number | null;
  m_returned: number | null;
  m_site_received: number | null;
  m_site_used: number | null;
  /** Indkøbslinje for vare uden varenummer */
  pl_qty: number | null;
  pl_ordered: number | null;
  pl_received: number | null;
  pl_cancelled: number | null;
  /** Det effektive byggemarked (linjens, jobbets eller det foretrukne) */
  eff_retailer_id: number | null;
};

/**
 * Jobbets materialelinjer med lagerstatus. eff_retailer_id er linjens byggemarked, ellers jobbets,
 * ellers virksomhedens foretrukne.
 */
export async function jobItems(db: D1Database, jobId: number, prefRetailerId: number | null): Promise<ItemView[]> {
  const { results } = await db
    .prepare(
      `SELECT i.*, COALESCE(i.retailer_id, j.retailer_id, ?2) AS eff_retailer_id,
         r.name AS retailer_name, r.key AS retailer_key, r.website AS retailer_website, r.access AS retailer_access,
         price_retailer.name AS price_retailer_name,
         CASE WHEN price_retailer.active = 1 AND price_retailer.access = 'side' AND price_retailer.terms_confirmed_at IS NOT NULL THEN 1 ELSE 0 END AS price_side_allowed,
         p.purchase_price AS product_purchase_price, p.sale_price AS product_sale_price, p.whole_units AS product_whole_units,
         p.stock AS product_stock, p.reserved AS product_reserved,
         m.planned AS m_planned, m.reserved AS m_reserved, m.issued AS m_issued, m.returned AS m_returned, m.site_received AS m_site_received, m.site_used AS m_site_used,
         l.qty AS pl_qty, l.ordered AS pl_ordered, l.received AS pl_received, l.cancelled AS pl_cancelled
       FROM job_items i JOIN jobs j ON j.id = i.job_id
       LEFT JOIN retailers r ON r.id = COALESCE(i.retailer_id, j.retailer_id, ?2)
       LEFT JOIN retailers price_retailer ON price_retailer.id = i.price_retailer_id
       LEFT JOIN products p ON p.id = i.product_id
       LEFT JOIN job_materials m ON m.job_id = i.job_id AND m.product_id = i.product_id
       LEFT JOIN purchase_lines l ON l.id = i.purchase_line_id
       WHERE i.job_id = ?1 ORDER BY i.sort_order, i.id`,
    )
    .bind(jobId, prefRetailerId)
    .all<ItemView>();
  return results;
}

export async function getItem(db: D1Database, id: number): Promise<JobItemRow | null> {
  return db.prepare('SELECT * FROM job_items WHERE id = ?').bind(id).first<JobItemRow>();
}

export async function preferredRetailerId(db: D1Database, s: Settings): Promise<number | null> {
  if (!s.preferred_retailer) return null;
  const r = await db.prepare('SELECT id FROM retailers WHERE key = ? AND active = 1').bind(s.preferred_retailer).first<{ id: number }>();
  return r?.id ?? null;
}

/** Registreret forbrug på linjen: lagermotoren for varer, used_qty for varer uden varenummer. */
export function usedQty(it: ItemView): number {
  if (it.product_id) return (it.m_issued ?? 0) - (it.m_returned ?? 0) + (it.m_site_used ?? 0);
  return it.used_qty;
}

// --- Beregning ---------------------------------------------------------------------------------

export type PriceState = 'ok' | 'mangler' | 'godkend' | 'gammel';

export interface ItemCalc {
  /** Offentlig pris ekskl. moms pr. linjeenhed (kun præcist match, godkendt alternativ eller manuel) */
  publicUnit: number | null;
  /** Estimeret kostpris ekskl. moms pr. linjeenhed (eget lager: varens kostpris) */
  unitCost: number | null;
  /** Købsmængde i byggemarkedets salgsenhed og beløb ekskl. moms */
  buy: Extract<BuyPlan, { ok: true }> | null;
  buyAmount: number | null;
  /** Påslag i procent, der bruges, når salgsprisen er kostpris + påslag */
  markup: number;
  saleUnit: number | null;
  /** Salgspris for den forventede mængde (ikke købsmængden) */
  saleAmount: number | null;
  priceState: PriceState;
  /** Hvorfor salgsprisen mangler */
  missing: string;
}

export interface CalcCtx {
  jobMarkup: number | null;
  defaultMarkup: number;
  maxAgeDays: number;
  now: number;
}

export function calcCtx(job: Pick<JobRow, 'markup_pct'>, s: Settings, now: number): CalcCtx {
  return { jobMarkup: job.markup_pct, defaultMarkup: s.default_markup_pct, maxAgeDays: s.price_max_age_days, now };
}

/** Pris pr. linjeenhed ekskl. moms ud fra pris pr. salgsenhed. */
export function perUnitEx(price: number, vat: Vat, packQty: number): number {
  return Math.round((convertVat(price, vat, 'ekskl') * Q) / packQty);
}

/** Prisen hører til et andet byggemarked end det, linjen nu bruger (en manuel pris gælder altid). */
export function otherRetailer(it: Pick<ItemView, 'price' | 'price_source' | 'price_retailer_id' | 'eff_retailer_id'>): boolean {
  return it.price !== null && it.price_source !== 'manuel' && it.price_retailer_id !== it.eff_retailer_id;
}

export function sidePriceUnconfirmed(it: Pick<ItemView, 'price_source' | 'price_side_allowed'>): boolean {
  return it.price_source === 'side' && it.price_side_allowed !== 1;
}

export function itemCalc(it: Pick<ItemView, keyof JobItemRow | 'product_purchase_price' | 'eff_retailer_id' | 'price_side_allowed'>, qty: number, ctx: CalcCtx): ItemCalc {
  const markup = it.markup_pct ?? ctx.jobMarkup ?? ctx.defaultMarkup;
  const unconfirmed = sidePriceUnconfirmed(it);
  const hasPrice = it.price !== null && it.vat !== null && !!it.pack_qty && !otherRetailer(it) && !unconfirmed;
  const usable = hasPrice && (it.match === 'praecis' || it.approved_at !== null);
  const publicUnit = usable ? perUnitEx(it.price!, it.vat!, it.pack_qty!) : null;
  let buy: ItemCalc['buy'] = null;
  let buyAmount: number | null = null;
  if (usable) {
    const plan = buyPlan(qty, it.unit, {
      sales_unit: it.sales_unit,
      pack_qty: it.pack_qty!,
      content_unit: it.unit,
      min_qty: it.min_qty,
      divisible: it.divisible,
      price: it.price!,
      vat: it.vat!,
      offer_price: null,
      offer_text: '',
      offer_min_qty: null,
      offer_until: '',
    });
    if (plan.ok) {
      buy = plan;
      buyAmount = convertVat(plan.amount, it.vat!, 'ekskl');
    }
  }
  const unitCost = it.cost_basis === 'lager' && it.product_id ? it.product_purchase_price : (it.actual_cost ?? publicUnit);
  let saleUnit: number | null = null;
  let missing = '';
  if (it.sale_mode === 'manuel') {
    saleUnit = it.sale_price;
    if (saleUnit === null) missing = 'Salgsprisen er ikke udfyldt.';
  } else if (it.sale_mode === 'offentlig') {
    saleUnit = publicUnit;
    if (saleUnit === null) missing = hasPrice && it.match === 'alternativ' ? 'Alternativet skal godkendes.' : 'Pris mangler.';
  } else {
    saleUnit = unitCost === null ? null : Math.round(unitCost * (1 + markup / 100));
    if (saleUnit === null) {
      missing = it.cost_basis === 'lager' && it.product_id ? 'Kostprisen mangler på varen.' : hasPrice && it.match === 'alternativ' ? 'Alternativet skal godkendes.' : 'Pris mangler.';
    }
  }
  if (saleUnit === null && unconfirmed) missing = 'Den tidligere sidepris er ikke bekræftet. Brug en prisfil eller indtast prisen manuelt.';
  const stale = usable && it.checked_at !== null && it.price_source !== 'manuel' && ctx.now - it.checked_at > ctx.maxAgeDays * 86400;
  const priceState: PriceState = hasPrice && !usable ? 'godkend' : !usable && it.cost_basis !== 'lager' ? 'mangler' : stale ? 'gammel' : usable || it.cost_basis === 'lager' ? 'ok' : 'mangler';
  return {
    publicUnit,
    unitCost,
    buy,
    buyAmount,
    markup,
    saleUnit,
    saleAmount: saleUnit === null ? null : lineAmount(saleUnit, qty),
    priceState,
    missing,
  };
}

// --- Prisopslag --------------------------------------------------------------------------------

type CandRow = CatalogRow & { product_id: number | null };

async function catalogFor(db: D1Database, retailer: RetailerRow, it: JobItemRow): Promise<CandRow[]> {
  const words = [...nameTokens(it.name).words].sort((a, b) => b.length - a.length).slice(0, 2);
  const like = (i: number) => (words[i] ? `%${words[i]}%` : '\u0000');
  const { results } = await db
    .prepare(
      `SELECT * FROM retailer_products WHERE retailer_id = ?1 AND (source <> 'side' OR ?7 = 1)
         AND (ean = ?2 OR (mpn <> '' AND brand = ?3 COLLATE NOCASE) OR name LIKE ?4 OR name LIKE ?5 OR product_id = ?6) LIMIT 300`,
    )
    .bind(retailer.id, normGtin(it.ean) ?? '\u0000', it.brand || '\u0000', like(0), like(1), it.product_id ?? -1, canReadPages(retailer) ? 1 : 0)
    .all<CandRow>();
  return results;
}

export interface Found {
  retailer_product_id: number | null;
  match: MatchKind;
  match_basis: MatchBasis;
  found_name: string;
  url: string;
  sales_unit: string;
  pack_qty: number;
  min_qty: number;
  divisible: number;
  price: number;
  vat: Vat;
  price_source: string;
  checked_at: number;
}

function foundFromCatalog(c: CandRow, match: MatchKind, basis: MatchBasis): Found {
  return {
    retailer_product_id: c.id,
    match,
    match_basis: basis,
    found_name: c.name,
    url: c.url,
    sales_unit: c.sales_unit,
    pack_qty: c.pack_qty,
    min_qty: c.min_qty,
    divisible: c.divisible,
    price: c.price,
    vat: c.vat,
    price_source: c.source,
    checked_at: c.checked_at,
  };
}

/** Skriver et fundet resultat på linjen. En godkendelse følger med, når det er samme vare. */
function applyFound(db: D1Database, it: JobItemRow, f: Found, retailerId: number, now: number): D1PreparedStatement {
  const keepApproval = it.price_retailer_id === retailerId && it.url === f.url && f.retailer_product_id === it.retailer_product_id;
  return db
    .prepare(
      `UPDATE job_items SET retailer_product_id = ?, match = ?, match_basis = ?, found_name = ?, url = ?, sales_unit = ?, pack_qty = ?, min_qty = ?,
         divisible = ?, price = ?, vat = ?, price_source = ?, checked_at = ?, lookup_note = '', approved_by = ?, approved_at = ?,
         price_retailer_id = ?, updated_at = ? WHERE id = ?`,
    )
    .bind(
      f.retailer_product_id,
      f.match,
      f.match_basis,
      f.found_name.slice(0, 200),
      f.url.slice(0, 500),
      f.sales_unit.slice(0, 20),
      f.pack_qty,
      f.min_qty,
      f.divisible,
      f.price,
      f.vat,
      f.price_source,
      f.checked_at,
      keepApproval && f.match === 'alternativ' ? it.approved_by : null,
      keepApproval && f.match === 'alternativ' ? it.approved_at : null,
      retailerId,
      now,
      it.id,
    );
}

function noteStmt(db: D1Database, itemId: number, note: string, now: number): D1PreparedStatement {
  return db.prepare('UPDATE job_items SET lookup_note = ?, updated_at = ? WHERE id = ?').bind(note.slice(0, 300), now, itemId);
}

export interface LookupResult {
  ok: boolean;
  message: string;
}

/**
 * Slår prisen op hos linjens byggemarked: først en produktside, brugeren har knyttet til
 * linjen eller varen, derefter byggemarkedets prisdata (EAN, producentnr. med mærke og variant,
 * og til sidst navn og mål, som altid er et alternativ, der skal godkendes). En manuel pris
 * overskrives aldrig. Fejl gemmes som en note på linjen og stopper intet andet.
 */
export async function lookupItem(env: Env, it: JobItemRow, retailer: RetailerRow | null, now: number): Promise<LookupResult> {
  const db = env.DB;
  const label = it.name;
  if (!retailer) {
    await noteStmt(db, it.id, 'Vælg et byggemarked for jobbet eller linjen.', now).run();
    return { ok: false, message: `${label}: intet byggemarked valgt.` };
  }
  if (!retailerLive(retailer)) {
    const note = `Automatisk prisopslag hos ${retailer.name} kommer senere. Indtast prisen manuelt ud fra produktsiden.`;
    await noteStmt(db, it.id, note, now).run();
    return { ok: false, message: `${label}: ${note}` };
  }
  const manual = it.price_source === 'manuel' && it.price !== null;
  let found: Found | null = null;
  let failure = '';
  try {
    // 1) Et link, brugeren har sat på linjen, læses direkte (kun tilladte, offentlige sider)
    const ownLink = it.url && canReadPages(retailer) && (it.price_source !== 'manuel' || !it.price);
    if (ownLink && it.product_id) {
      // Knyt siden til varen, så den holdes opdateret og kan bruges på andre job
      await db
        .prepare(
          `INSERT INTO product_pages (retailer_id, product_id, url, match, sales_unit, pack_qty, created_by, created_at) VALUES (?, ?, ?, 'praecis', ?, ?, 'system', ?)
           ON CONFLICT(retailer_id, product_id) DO UPDATE SET url = excluded.url, sales_unit = excluded.sales_unit, pack_qty = excluded.pack_qty`,
        )
        .bind(retailer.id, it.product_id, it.url, it.sales_unit || it.unit, it.pack_qty ?? Q, now)
        .run();
      const res = await readProductPages(env, now, { productIds: [it.product_id], force: true });
      const mine = res.find((r) => r.name.startsWith(retailer.name));
      if (mine && !mine.ok) failure = mine.message;
    } else if (ownLink) {
      const p = await fetchProductPage(env, retailer, it.url, now);
      const g = normGtin(it.ean);
      const pg = normGtin(p.gtin);
      found = {
        retailer_product_id: null,
        // Brugerens eget link er brugerens valg; en anden EAN end varens er et alternativ
        match: g && pg && g !== pg ? 'alternativ' : 'praecis',
        match_basis: g && pg && g === pg ? 'ean' : 'manuel',
        found_name: p.name || it.name,
        url: it.url,
        sales_unit: it.sales_unit || it.unit,
        pack_qty: it.pack_qty ?? Q,
        min_qty: Q,
        divisible: 0,
        price: p.price,
        vat: 'inkl',
        price_source: 'side',
        checked_at: now,
      };
    } else if (it.product_id && canReadPages(retailer)) {
      // En side, der allerede er knyttet til varen, læses, hvis prisen er mere end 6 timer gammel
      await readProductPages(env, now, { productIds: [it.product_id] });
    }
    if (!found && !failure) {
      // 2) Byggemarkedets prisdata (cache fra prisfil, produktsider eller demodata)
      const cands = await catalogFor(db, retailer, it);
      const linked = it.product_id ? cands.find((c) => c.product_id === it.product_id) : undefined;
      const g = normGtin(it.ean);
      const m = linked
        ? { row: linked, match: (g && linked.ean && normGtin(linked.ean) !== g ? 'alternativ' : 'praecis') as MatchKind, basis: (g && normGtin(linked.ean) === g ? 'ean' : 'manuel') as MatchBasis }
        : findMatch({ ean: it.ean, mpn: it.mpn, brand: it.brand, variant: it.variant, name: it.name, unit: it.unit }, cands);
      if (m && normUnit(m.row.content_unit) !== normUnit(it.unit)) {
        failure = `${retailer.name} sælger varen i ${m.row.content_unit}, linjen er i ${it.unit}. Indtast prisen manuelt.`;
      } else if (m) found = foundFromCatalog(m.row, m.match, m.basis);
    }
  } catch (err) {
    failure = String((err as Error)?.message ?? err).slice(0, 200);
  }
  if (manual) {
    const note = found ? `Manuel pris bevares. ${retailer.name} viser nu ${(found.price / 100).toFixed(2).replace('.', ',')} kr. ${found.vat === 'inkl' ? 'inkl.' : 'ekskl.'} moms.` : '';
    await noteStmt(db, it.id, note, now).run();
    return { ok: true, message: `${label}: manuel pris bevaret.` };
  }
  if (found) {
    await applyFound(db, it, found, retailer.id, now).run();
    return { ok: true, message: `${label}: ${found.match === 'praecis' ? 'pris fundet' : 'alternativ fundet, kræver godkendelse'} hos ${retailer.name}.` };
  }
  const note = failure || `Ingen pris fundet hos ${retailer.name}. Indsæt et link til varen hos ${retailer.name}, eller indtast prisen manuelt.`;
  await noteStmt(db, it.id, it.price !== null ? `${note} Prisen ovenfor er fra et tidligere opslag.` : note, now).run();
  return { ok: false, message: `${label}: ${note}` };
}

/** Prisopslag for flere linjer. En fejl på én linje stopper ikke de andre. */
export async function lookupItems(env: Env, items: ItemView[], now: number): Promise<{ ok: number; failed: number; messages: string[] }> {
  const cache = new Map<number, RetailerRow | null>();
  let ok = 0;
  let failed = 0;
  const messages: string[] = [];
  for (const it of items) {
    try {
      const rid = it.eff_retailer_id;
      if (rid && !cache.has(rid)) cache.set(rid, await getRetailer(env.DB, rid));
      const r = await lookupItem(env, it, rid ? (cache.get(rid) ?? null) : null, now);
      if (r.ok) ok++;
      else {
        failed++;
        messages.push(r.message);
      }
    } catch (err) {
      failed++;
      messages.push(`${it.name}: prisopslaget fejlede (${(err as Error)?.message ?? err}).`);
    }
  }
  return { ok, failed, messages };
}

// --- Ændringer fra brugeren --------------------------------------------------------------------

export interface ManualPrice {
  price: number;
  vat: Vat;
  sales_unit: string;
  pack_qty: number;
  url: string;
  found_name: string;
}

export function manualPriceStmt(db: D1Database, itemId: number, retailerId: number | null, m: ManualPrice, actor: Actor, now: number): D1PreparedStatement {
  return db
    .prepare(
      `UPDATE job_items SET price = ?, vat = ?, sales_unit = ?, pack_qty = ?, url = ?, found_name = ?, min_qty = 1000, divisible = 0,
         match = 'praecis', match_basis = 'manuel', price_source = 'manuel', checked_at = ?, retailer_product_id = NULL, price_retailer_id = ?,
         approved_by = ?, approved_at = ?, lookup_note = '', updated_at = ? WHERE id = ?`,
    )
    .bind(m.price, m.vat, m.sales_unit, m.pack_qty, m.url, m.found_name, now, retailerId, actor.name, now, now, itemId);
}

export function approveStmt(db: D1Database, itemId: number, actor: Actor, now: number): D1PreparedStatement {
  return db
    .prepare("UPDATE job_items SET approved_by = ?, approved_at = ?, updated_at = ? WHERE id = ? AND match = 'alternativ' AND price IS NOT NULL")
    .bind(actor.name, now, now, itemId);
}

/** Fjerner prisen (fx et afvist alternativ). */
export function clearPriceStmt(db: D1Database, itemId: number, note: string, now: number): D1PreparedStatement {
  return db
    .prepare(
      `UPDATE job_items SET price = NULL, vat = NULL, match = NULL, match_basis = '', retailer_product_id = NULL, price_retailer_id = NULL, approved_by = NULL, approved_at = NULL,
         price_source = '', checked_at = NULL, lookup_note = ?, updated_at = ? WHERE id = ?`,
    )
    .bind(note, now, itemId);
}

export { todayDk };


/** Quantity to purchase in base units, including whole packs even before a price is known. */
export function purchaseQuantity(it: Pick<JobItemRow, 'qty' | 'unit' | 'sales_unit' | 'pack_qty' | 'min_qty' | 'divisible'>): number {
  if (it.qty === 0) return 0;
  if (!it.pack_qty) return it.qty;
  // The zero is used only for quantity conversion; no price is written from this plan.
  const plan = buyPlan(it.qty, it.unit, {
    sales_unit: it.sales_unit || it.unit,
    content_unit: it.unit,
    pack_qty: it.pack_qty,
    min_qty: it.min_qty,
    divisible: it.divisible,
    price: 0,
    vat: 'ekskl',
    offer_price: null,
    offer_text: '',
    offer_min_qty: null,
    offer_until: '',
  });
  if (!plan.ok) throw new Conflict(plan.reason);
  return plan.covered;
}

/**
 * Keep an already planned material in sync with its stock reservation or purchase draft.
 * Actual orders and receipts retain their quantities and prices; reducing below committed
 * goods requires the buyer to correct that order explicitly first.
 */
export async function syncItemPlan(tx: Tx, job: JobRow, it: ItemView, s: Settings, force = false): Promise<void> {
  if (it.product_id) {
    const p = await getProduct(tx.db, it.product_id);
    if (!p) throw new Conflict('Varen findes ikke længere.');
    if (p.whole_units && it.qty % Q !== 0) throw new Conflict(`${p.name} håndteres kun i hele ${p.unit}.`);
    const material = await getMaterial(tx.db, job.id, p.id);
    if (force || it.planned_at || material.planned > 0) await setPlanned(tx, job, p, it.qty);
  } else if (force || it.planned_at || it.purchase_line_id) {
    if (job.status !== 'aktiv') throw new Conflict('Jobbet er afsluttet. Genåbn jobbet for at ændre materialebehovet.');
    if (it.qty < it.used_qty) throw new Conflict(`Behovet kan ikke være mindre end det allerede registrerede forbrug.`);
    const next = purchaseQuantity(it);
    const line = it.purchase_line_id
      ? await tx.db.prepare('SELECT l.*, p.archived FROM purchase_lines l JOIN purchase_lists p ON p.id = l.list_id WHERE l.id = ? AND l.job_id = ?').bind(it.purchase_line_id, job.id).first<import('../env').PurchaseLineRow & { archived: number }>()
      : null;
    if (line?.cancelled && (line.ordered > 0 || line.received > 0)) throw new Conflict('Det annullerede indkøb har bestilte eller modtagne varer. Ret indkøbet direkte eller opret en særskilt materialelinje, så historikken bevares.');
    if (line && !line.cancelled) {
      if (line.archived) throw new Conflict('Indkøbslisten er arkiveret. Genåbn listen før materialebehovet ændres.');
      if (normUnit(line.unit) !== normUnit(it.unit) && (line.ordered > 0 || line.received > 0 || it.used_qty > 0)) {
        throw new Conflict('Enheden kan ikke ændres, når varen er bestilt, modtaget eller brugt. Opret en særskilt materialelinje.');
      }
      if (next < Math.max(line.ordered, line.received)) throw new Conflict(`Der er allerede bestilt eller modtaget ${line.ordered / Q} ${line.unit}. Ret bestillingen på indkøbslisten først.`);
      let changed = false;
      if (next === 0) {
        changed = true;
        tx.add(tx.db.prepare('UPDATE purchase_lines SET qty = CASE WHEN ordered + received = 0 THEN qty ELSE 0 END, cancelled = 1, updated_at = ? WHERE id = ?').bind(tx.now, line.id));
        tx.add(tx.db.prepare('UPDATE job_items SET purchase_line_id = NULL WHERE id = ?').bind(it.id));
      } else {
        const cost = itemCalc(it, it.qty, calcCtx(job, s, tx.now)).unitCost;
        const committed = line.ordered > 0 || line.received > 0;
        const retailer = committed ? line.retailer_id : it.eff_retailer_id;
        const unitChanged = normUnit(line.unit) !== normUnit(it.unit);
        changed = line.qty !== next || line.name !== it.name || line.unit !== it.unit || line.retailer_id !== retailer || (!committed && line.unit_price !== cost);
        if (changed) tx.add(tx.db.prepare(`UPDATE purchase_lines SET qty = CASE WHEN ?1 >= MAX(ordered, received) AND (?2 = 0 OR ordered + received = 0) THEN ?1 ELSE 0 END,
          name = ?3, unit = ?4, retailer_id = CASE WHEN ordered + received = 0 THEN ?5 ELSE retailer_id END,
          unit_price = CASE WHEN ordered + received = 0 THEN ?6 ELSE unit_price END,
          ready = CASE WHEN ordered = 0 AND qty <> ?1 THEN 0 ELSE ready END, updated_at = ?7 WHERE id = ?8`)
          .bind(next, unitChanged ? 1 : 0, it.name, it.unit, retailer, cost, tx.now, line.id));
      }
      if (changed) tx.touchList(line.list_id);
    } else if (next > 0) {
      if (line?.cancelled && !force) throw new Conflict('Indkøbet er annulleret. Brug Reservér og sæt på indkøbsliste for at oprette et nyt behov.');
      const listId = await defaultJobList(tx.db, job, tx.now);
      const cost = itemCalc(it, it.qty, calcCtx(job, s, tx.now)).unitCost;
      tx.add(
        tx.db.prepare(`INSERT INTO purchase_lines (list_id, job_id, product_id, sku, name, unit, qty, unit_price, deliver_to, note, retailer_id, created_at, updated_at)
          VALUES (?, ?, NULL, '', ?, ?, ?, ?, 'arbejdssted', ?, ?, ?, ?)`)
          .bind(listId, job.id, it.name, it.unit, next, cost, 'Købes til jobbet. Mængden er inkl. hele pakker.', it.eff_retailer_id, tx.now, tx.now),
        tx.db.prepare(`UPDATE job_items SET purchase_line_id = (SELECT MAX(id) FROM purchase_lines WHERE list_id = ? AND job_id = ? AND product_id IS NULL), updated_at = ? WHERE id = ?`)
          .bind(listId, job.id, tx.now, it.id),
      );
      tx.touchList(listId);
    }
  }
  if (force && !it.planned_at) tx.add(tx.db.prepare('UPDATE job_items SET planned_at = ? WHERE id = ?').bind(tx.now, it.id));
  tx.jobs.add(job.id);
}
