// Produktkatalog: import af produktfiler (CSV/Excel) og søgning efter materialer.
//
// Kataloget viser, hvilke produkter der findes; lageret (products) viser, hvad virksomheden selv
// har. Intet her ændrer products, movements, purchase_lines eller job_materials: en import
// opretter aldrig lagerbeholdning, ændrer ingen mængder og registrerer hverken indkøb eller
// modtagelse. Lageret ændres kun af de eksisterende funktioner (modtagelse, reservation,
// udlevering, forbrug og regulering).
//
// Importen sker i tre trin, så CPU-tiden pr. forespørgsel er lille, og intet ændres før godkendelse:
//   1. Browseren læser filen, administratoren vælger faneblad og kobler kolonner til felter.
//   2. Rækkerne sendes i bidder; hver bid normaliseres, sammenlignes med kataloget og gemmes i
//      catalog_import_rows (ny, opdatering, uændret eller fejl).
//   3. Forhåndsvisningen viser tallene; ved godkendelse flyttes rækkerne ind med SQL i én batch.

import { normGtin } from './prices';

export const CATALOG_FIELDS = [
  ['manufacturer', 'Producent'],
  ['mpn', 'Producentens varenummer'],
  ['dealer_sku', 'Forhandlerens varenummer'],
  ['ean', 'EAN/GTIN'],
  ['name', 'Produktnavn'],
  ['description', 'Beskrivelse'],
  ['category', 'Kategori'],
  ['variant', 'Variant'],
  ['dimensions', 'Dimensioner'],
  ['material', 'Materiale'],
  ['unit', 'Enhed'],
  ['pack_size', 'Pakkestørrelse'],
  ['url', 'Produktlink'],
  ['price', 'Pris'],
  ['currency', 'Valuta'],
  ['vat', 'Momsgrundlag'],
  ['price_per', 'Pris pr.'],
  ['source_updated', 'Dato for opdatering'],
] as const;

export type CatalogField = (typeof CATALOG_FIELDS)[number][0];
export const FIELD_LABEL = Object.fromEntries(CATALOG_FIELDS) as Record<CatalogField, string>;
const FIELD_KEYS = new Set<string>(CATALOG_FIELDS.map(([k]) => k));

export type PriceType = 'listepris' | 'vejledende' | 'forhandlerpris' | 'nettopris';
export const PRICE_TYPE_LABEL: Record<PriceType, string> = {
  listepris: 'Producentens listepris',
  vejledende: 'Vejledende udsalgspris',
  forhandlerpris: 'Forhandlerens pris',
  nettopris: 'Nettopris',
};
export type CatalogVat = 'inkl' | 'ekskl' | 'ukendt';
export const CATALOG_VAT_LABEL: Record<CatalogVat, string> = { inkl: 'inkl. moms', ekskl: 'ekskl. moms', ukendt: 'momsgrundlag ukendt' };

export type SourceKind = 'producent' | 'forhandler' | 'demo';
export const SOURCE_KIND_LABEL: Record<SourceKind, string> = { producent: 'Producent', forhandler: 'Forhandler', demo: 'Demodata' };

export interface CatalogSourceRow {
  id: number;
  name: string;
  kind: SourceKind;
  manufacturer: string;
  note: string;
  mapping: string;
  last_import_id: number | null;
  last_import_at: number | null;
  created_by: string;
  created_at: number;
}

export interface CatalogProductRow {
  id: number;
  source_id: number;
  manufacturer: string;
  maker_key: string;
  mpn: string;
  mpn_key: string;
  dealer_sku: string;
  dealer_key: string;
  ean: string;
  gtin: string;
  name: string;
  description: string;
  category: string;
  variant: string;
  dimensions: string;
  material: string;
  unit: string;
  pack_size: string;
  url: string;
  source_updated: string;
  search_text: string;
  name_key: string;
  status: 'aktiv' | 'gennemgang' | 'skjult';
  review_note: string;
  is_demo: number;
  last_seen_import_id: number | null;
  imported_at: number;
  updated_at: number;
  created_at: number;
}

export interface CatalogPriceRow {
  id: number;
  catalog_product_id: number;
  source_id: number;
  seller: string;
  price_type: PriceType;
  amount: number;
  currency: string;
  vat: CatalogVat;
  per: string;
  import_id: number | null;
  imported_at: number;
}

export interface CatalogImportRow {
  id: number;
  source_id: number;
  filename: string;
  sheet: string;
  mapping: string;
  status: 'upload' | 'klar' | 'godkendt' | 'annulleret';
  rows_total: number;
  rows_new: number;
  rows_updated: number;
  rows_same: number;
  rows_error: number;
  rows_missing: number;
  created_by: string;
  created_at: number;
  approved_by: string | null;
  approved_at: number | null;
}

/** Veyros interne produkt-ID, fx VK-000123 (adskilt fra producentens og forhandlerens numre). */
export function veyroId(id: number): string {
  return `VK-${String(id).padStart(6, '0')}`;
}

export function parseVeyroId(raw: string): number | null {
  const m = /^vk-?0*(\d{1,9})$/i.exec(raw.trim());
  return m ? Number(m[1]) : null;
}

// --- Normalisering ---------------------------------------------------------------------------

/** Tekst til søgning: små bogstaver (også æøå), × som x, decimalkomma som punktum og tal adskilt fra enheder. */
export function searchNorm(s: string): string {
  return s
    .toLowerCase()
    .replace(/[×*]/g, ' x ')
    .replace(/(\d),(\d)/g, '$1.$2')
    .replace(/[^0-9a-zæøåäöüé.]+/g, ' ')
    .replace(/(\d)([a-zæøå])/g, '$1 $2')
    .replace(/([a-zæøå])(\d)/g, '$1 $2')
    .replace(/(^|\s)\.+|\.+(?=\s|$)/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Varenummer til match: store bogstaver uden mellemrum. Bindestreger og punktummer bevares. */
export function codeKey(s: string): string {
  return s.toUpperCase().replace(/\s+/g, '');
}

export function makerKey(s: string): string {
  return s.trim().toLowerCase().replace(/\s+/g, ' ');
}

/** Ord til stavefejlsrettelse: kun bogstaver, mindst 4 tegn. */
export function wordsOf(text: string): string[] {
  return [...new Set(searchNorm(text).split(' ').filter((w) => w.length >= 4 && /^[a-zæøåäöüé]+$/.test(w)))];
}

const clip = (s: unknown, max: number): string => (typeof s === 'string' || typeof s === 'number' ? String(s).replace(/\s+/g, ' ').trim().slice(0, max) : '');

/** Pris fra en fil: "1.234,56", "1234.5678", "kr 12,50", "12,50 DKK". null = tom, NaN = ugyldig. */
export function parsePrice(raw: string): number | null {
  let s = raw.trim().replace(/\s|kr\.?|dkk|eur|€/gi, '');
  if (!s) return null;
  if (s.includes(',') && s.includes('.')) {
    // Den sidste separator er decimaltegnet
    s = s.lastIndexOf(',') > s.lastIndexOf('.') ? s.replace(/\./g, '').replace(',', '.') : s.replace(/,/g, '');
  } else if (s.includes(',')) {
    s = /^\d{1,3}(,\d{3})+$/.test(s) ? s.replace(/,/g, '') : s.replace(',', '.');
  } else if (/^\d{1,3}(\.\d{3})+$/.test(s)) {
    s = s.replace(/\./g, '');
  }
  if (!/^\d+(\.\d+)?$/.test(s)) return NaN;
  const v = Math.round(parseFloat(s) * 100);
  return Number.isSafeInteger(v) && v <= 100_000_000_00 ? v : NaN;
}

export function parseCurrency(raw: string): string {
  const s = raw.trim().toUpperCase().replace(/\.$/, '');
  if (!s) return '';
  if (s === 'KR' || s === 'DKR' || s === 'DKK') return 'DKK';
  if (s === '€' || s === 'EUR' || s === 'EURO') return 'EUR';
  if (s === 'SEK' || s === 'NOK') return s;
  return /^[A-Z]{3}$/.test(s) ? s : '';
}

export function parseVat(raw: string): CatalogVat | null {
  const s = raw.trim().toLowerCase();
  if (!s) return null;
  if (/^(inkl|incl|inkl\. moms|inkl moms|incl\. vat|incl vat|brutto|med moms|ja|1)/.test(s)) return 'inkl';
  if (/^(ekskl|excl|eksl|ex|ekskl\. moms|ekskl moms|excl\. vat|netto|uden moms|nej|0)/.test(s)) return 'ekskl';
  return null;
}

/** Dato fra en fil: YYYY-MM-DD, DD-MM-YYYY, DD.MM.YYYY, DD/MM/YYYY eller et Excel-serienummer. */
export function parseFileDate(raw: string): string | null {
  const s = raw.trim();
  if (!s) return '';
  let y: number, m: number, d: number;
  let r: RegExpExecArray | null;
  if ((r = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(s))) [y, m, d] = [Number(r[1]), Number(r[2]), Number(r[3])];
  else if ((r = /^(\d{1,2})[-./](\d{1,2})[-./](\d{4})$/.exec(s))) [y, m, d] = [Number(r[3]), Number(r[2]), Number(r[1])];
  else if (/^\d{5}(\.\d+)?$/.test(s)) {
    // Excel: dage siden 30. december 1899
    const t = Date.UTC(1899, 11, 30) + Math.floor(Number(s)) * 86400_000;
    return new Date(t).toISOString().slice(0, 10);
  } else return null;
  const t = Date.UTC(y, m - 1, d);
  const dt = new Date(t);
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) return null;
  return dt.toISOString().slice(0, 10);
}

/** Tal i Excel-format (fx 4.01234567890E12) som heltalstekst, så et EAN læses rigtigt. */
function digitsOf(raw: string): string {
  const s = raw.trim();
  if (/^\d+(\.\d+)?e\+?\d+$/i.test(s)) {
    const n = Number(s);
    if (Number.isSafeInteger(n)) return String(n);
  }
  return s.replace(/[\s-]/g, '');
}

// --- Import: én række ------------------------------------------------------------------------

export interface ImportOptions {
  /** Feltet -> kolonnens overskrift i filen */
  columns: Partial<Record<CatalogField, string>>;
  sheet?: string;
  header_row?: number;
  /** Bruges, når filen ikke selv har kolonnen */
  manufacturer: string;
  currency: string;
  vat: CatalogVat;
  price_type: PriceType;
}

export function parseOptions(raw: string): ImportOptions {
  let o: Partial<ImportOptions> = {};
  try {
    o = JSON.parse(raw) as Partial<ImportOptions>;
  } catch {
    o = {};
  }
  const columns: Partial<Record<CatalogField, string>> = {};
  if (o.columns && typeof o.columns === 'object') {
    for (const [k, v] of Object.entries(o.columns)) if (FIELD_KEYS.has(k) && typeof v === 'string' && v.trim()) columns[k as CatalogField] = v.slice(0, 200);
  }
  return {
    columns,
    sheet: typeof o.sheet === 'string' ? o.sheet.slice(0, 100) : '',
    header_row: typeof o.header_row === 'number' && o.header_row > 0 && o.header_row < 1000 ? Math.floor(o.header_row) : 1,
    manufacturer: clip(o.manufacturer, 100),
    currency: parseCurrency(typeof o.currency === 'string' ? o.currency : ''),
    vat: o.vat === 'inkl' || o.vat === 'ekskl' ? o.vat : 'ukendt',
    price_type: o.price_type && o.price_type in PRICE_TYPE_LABEL ? o.price_type : 'listepris',
  };
}

/** De felter, der er koblet til en kolonne (eller udfyldt med en standardværdi). */
export function mappedFields(o: ImportOptions): Set<CatalogField> {
  const s = new Set(Object.keys(o.columns) as CatalogField[]);
  if (o.manufacturer) s.add('manufacturer');
  return s;
}

/** En række efter normalisering, klar til at blive sammenlignet med kataloget. */
export interface StagedRow {
  row_no: number;
  manufacturer: string;
  maker_key: string;
  mpn: string;
  mpn_key: string;
  dealer_sku: string;
  dealer_key: string;
  ean: string;
  gtin: string;
  name: string;
  description: string;
  category: string;
  variant: string;
  dimensions: string;
  material: string;
  unit: string;
  pack_size: string;
  url: string;
  source_updated: string;
  price_state: 'set' | 'clear' | 'keep';
  price: number | null;
  currency: string;
  vat: CatalogVat;
  price_per: string;
  errors: string[];
  warnings: string[];
}

const TEXT_FIELDS = ['manufacturer', 'mpn', 'dealer_sku', 'name', 'description', 'category', 'variant', 'dimensions', 'material', 'unit', 'pack_size', 'url', 'source_updated'] as const;

/** Normaliserer en række fra filen (felt -> tekst). */
export function normalizeRow(rowNo: number, values: Record<string, unknown>, o: ImportOptions): StagedRow {
  const v = (f: CatalogField, max = 200) => clip(values[f], max);
  const errors: string[] = [];
  const warnings: string[] = [];
  const manufacturer = v('manufacturer', 100) || o.manufacturer;
  const mpn = v('mpn', 60);
  const dealer = v('dealer_sku', 60);
  let ean = digitsOf(v('ean', 40));
  let gtin = '';
  if (ean) {
    if (!/^\d+$/.test(ean)) {
      warnings.push(`EAN "${ean}" er ikke et tal og er ikke gemt.`);
      ean = '';
    } else {
      gtin = normGtin(ean) ?? '';
      if (!gtin) warnings.push(`EAN ${ean} har ikke et gyldigt kontrolciffer. Det er gemt, men bruges ikke til at matche.`);
    }
  }
  const name = v('name', 300);
  if (!name) errors.push('Produktnavn mangler.');
  if (!mpn && !gtin) errors.push(ean ? 'Producentens varenummer mangler, og EAN er ugyldigt.' : 'Både producentens varenummer og EAN mangler.');
  let url = v('url', 500);
  if (url && !/^https?:\/\/[^\s]+$/i.test(url)) {
    warnings.push('Produktlinket er ikke en webadresse og er ikke gemt.');
    url = '';
  }
  let updated = v('source_updated', 40);
  if (updated) {
    const d = parseFileDate(updated);
    if (d === null) warnings.push(`Datoen "${updated}" kan ikke læses og er ikke gemt.`);
    updated = d ?? '';
  }
  let price_state: StagedRow['price_state'] = o.columns.price ? 'clear' : 'keep';
  let price: number | null = null;
  const rawPrice = v('price', 40);
  if (o.columns.price && rawPrice) {
    const p = parsePrice(rawPrice);
    if (p === null) price_state = 'clear';
    else if (Number.isNaN(p)) errors.push(`Prisen "${rawPrice}" kan ikke læses.`);
    else if (p === 0) warnings.push('Prisen er 0 og er gemt som "Pris mangler".');
    else {
      price = p;
      price_state = 'set';
    }
  }
  const curRaw = v('currency', 10);
  const currency = curRaw ? parseCurrency(curRaw) : o.currency;
  if (curRaw && !currency) warnings.push(`Valutaen "${curRaw}" kendes ikke og står som ukendt.`);
  const vatRaw = v('vat', 40);
  const vat = (vatRaw ? parseVat(vatRaw) : null) ?? o.vat;
  if (vatRaw && !parseVat(vatRaw)) warnings.push(`Momsgrundlaget "${vatRaw}" kan ikke læses og står som ukendt.`);
  if (price !== null && !currency) warnings.push('Prisen har ingen valuta. Den vises, men kan ikke bruges som pris på et job.');
  return {
    row_no: rowNo,
    manufacturer,
    maker_key: makerKey(manufacturer),
    mpn,
    mpn_key: codeKey(mpn),
    dealer_sku: dealer,
    dealer_key: codeKey(dealer),
    ean,
    gtin,
    name,
    description: v('description', 2000),
    category: v('category', 100),
    variant: v('variant', 120),
    dimensions: v('dimensions', 120),
    material: v('material', 120),
    unit: v('unit', 20),
    pack_size: v('pack_size', 60),
    url,
    source_updated: updated,
    price_state,
    price,
    currency,
    vat: price === null && !vatRaw ? 'ukendt' : vat,
    price_per: v('price_per', 30),
    errors,
    warnings,
  };
}

/** Søgetekst for en katalogvare. */
export function searchTextOf(r: Pick<StagedRow, 'name' | 'variant' | 'dimensions' | 'material' | 'category' | 'manufacturer' | 'mpn' | 'dealer_sku' | 'ean' | 'description'>): string {
  return searchNorm([r.name, r.variant, r.dimensions, r.material, r.category, r.manufacturer, r.mpn, r.dealer_sku, r.ean, r.description.slice(0, 300)].join(' '));
}

/** Nøgle til dubletter i samme fil. */
export function identOf(r: Pick<StagedRow, 'maker_key' | 'mpn_key' | 'gtin'>): string {
  return `${r.maker_key}|${r.mpn_key}|${r.gtin}`;
}

// --- Import: en bid af rækker ------------------------------------------------------------------

type Candidate = CatalogProductRow & { p_amount: number | null; p_currency: string | null; p_vat: string | null; p_per: string | null };

// Filens dato alene gør ikke en vare ændret (den gemmes dog ved godkendelse)
const COMPARE = ['manufacturer', 'mpn', 'dealer_sku', 'ean', 'name', 'description', 'category', 'variant', 'dimensions', 'material', 'unit', 'pack_size', 'url'] as const;

function pickMatch(r: StagedRow, cands: Candidate[]): { match?: Candidate; error?: string } {
  if (r.mpn_key) {
    const same = cands.filter((c) => c.maker_key === r.maker_key && c.mpn_key === r.mpn_key);
    if (r.gtin) {
      const exact = same.filter((c) => c.gtin === r.gtin);
      if (exact.length === 1) return { match: exact[0] };
      const open = same.filter((c) => !c.gtin);
      if (open.length === 1) return { match: open[0] };
      if (open.length > 1) return { error: `Flere varer i kataloget har varenummer ${r.mpn}. Ret dem, før EAN kan tilføjes.` };
      // Samme varenummer med et andet EAN er en anden variant eller pakning: en ny vare
      const byGtin = cands.find((c) => c.gtin === r.gtin && c.maker_key === r.maker_key && c.mpn_key !== r.mpn_key);
      if (byGtin) return { error: `EAN ${r.ean} bruges allerede af varenummer ${byGtin.mpn || '(uden varenummer)'}. Kontrollér filen.` };
      return {};
    }
    if (same.length === 1) return { match: same[0] };
    if (same.length > 1) return { error: `Varenummer ${r.mpn} findes som flere varianter. Angiv EAN for at vælge den rigtige.` };
    return {};
  }
  const byGtin = cands.filter((c) => c.gtin === r.gtin && (!r.maker_key || !c.maker_key || c.maker_key === r.maker_key));
  if (byGtin.length === 1) return { match: byGtin[0] };
  if (byGtin.length > 1) return { error: `EAN ${r.ean} findes på flere varer i kataloget.` };
  return {};
}

/**
 * Normaliserer, sammenligner og gemmer en bid af en import (højst 500 rækker). Felter, der ikke
 * er koblet til en kolonne, beholder deres nuværende værdi på eksisterende varer.
 */
export async function stageRows(
  db: D1Database,
  imp: CatalogImportRow,
  rows: { row_no: number; values: Record<string, unknown> }[],
): Promise<{ staged: number; errors: number }> {
  const o = parseOptions(imp.mapping);
  const mapped = mappedFields(o);
  const staged = rows.map((r) => normalizeRow(r.row_no, r.values, o));
  const pairs = [...new Set(staged.filter((r) => r.mpn_key).map((r) => `${r.maker_key}|${r.mpn_key}`))];
  const gtins = [...new Set(staged.map((r) => r.gtin).filter(Boolean))];
  const idents = [...new Set(staged.map(identOf))];
  const nos = staged.map((r) => r.row_no);
  const [cands, prev, seenNos] = await Promise.all([
    db
      .prepare(
        `SELECT c.*, p.amount AS p_amount, p.currency AS p_currency, p.vat AS p_vat, p.per AS p_per FROM catalog_products c
         LEFT JOIN catalog_prices p ON p.catalog_product_id = c.id AND p.source_id = c.source_id AND p.seller = '' AND p.price_type = ?4
         WHERE c.source_id = ?1 AND ((c.maker_key || '|' || c.mpn_key) IN (SELECT value FROM json_each(?2)) OR (c.gtin <> '' AND c.gtin IN (SELECT value FROM json_each(?3))))`,
      )
      .bind(imp.source_id, JSON.stringify(pairs), JSON.stringify(gtins), o.price_type)
      .all<Candidate>(),
    db
      .prepare('SELECT row_no, ident, match_id FROM catalog_import_rows WHERE import_id = ?1 AND action <> \'fejl\' AND ident IN (SELECT value FROM json_each(?2))')
      .bind(imp.id, JSON.stringify(idents))
      .all<{ row_no: number; ident: string; match_id: number | null }>(),
    db.prepare('SELECT row_no FROM catalog_import_rows WHERE import_id = ?1 AND row_no IN (SELECT value FROM json_each(?2))').bind(imp.id, JSON.stringify(nos)).all<{ row_no: number }>(),
  ]);
  // Demoens fiktive varer må aldrig ende i en rigtig producents eller forhandlers kilde
  const src = await db.prepare('SELECT kind FROM catalog_sources WHERE id = ?').bind(imp.source_id).first<{ kind: SourceKind }>();
  if (src?.kind !== 'demo') for (const r of staged) if (/^DEMO-/i.test(r.mpn)) r.errors.push('Fiktive demovarer (DEMO-) kan kun importeres i en demokilde.');
  const already = new Set(seenNos.results.map((r) => r.row_no));
  const identSeen = new Map(prev.results.map((r) => [r.ident, r.row_no]));
  const matchIds = [...new Set(cands.results.map((c) => c.id))];
  const matchSeen = new Map<number, number>();
  if (matchIds.length) {
    const { results } = await db
      .prepare("SELECT row_no, match_id FROM catalog_import_rows WHERE import_id = ?1 AND action <> 'fejl' AND match_id IN (SELECT value FROM json_each(?2))")
      .bind(imp.id, JSON.stringify(matchIds))
      .all<{ row_no: number; match_id: number }>();
    for (const r of results) matchSeen.set(r.match_id, r.row_no);
  }

  const out: Record<string, unknown>[] = [];
  const words = new Set<string>();
  for (const r of staged) {
    if (already.has(r.row_no)) continue;
    const ident = identOf(r);
    let action: 'ny' | 'opdater' | 'uaendret' | 'fejl' = 'ny';
    let match: Candidate | undefined;
    const changes: string[] = [];
    if (!r.errors.length) {
      const dupRow = identSeen.get(ident);
      if (dupRow !== undefined) r.errors.push(`Samme vare som række ${dupRow} i filen.`);
    }
    if (!r.errors.length) {
      const m = pickMatch(r, cands.results);
      if (m.error) r.errors.push(m.error);
      match = m.match;
      if (match) {
        const dupRow = matchSeen.get(match.id);
        if (dupRow !== undefined) r.errors.push(`Matcher samme vare som række ${dupRow} i filen.`);
        // Samme varenummer, men en anden pakning eller variant: sammenlæg ikke
        else if (!r.gtin || !match.gtin) {
          if (mapped.has('pack_size') && r.pack_size && match.pack_size && searchNorm(r.pack_size) !== searchNorm(match.pack_size))
            r.errors.push(`Samme varenummer som ${veyroId(match.id)}, men en anden pakkestørrelse (${match.pack_size} / ${r.pack_size}). Angiv EAN, hvis det er en anden vare.`);
          else if (mapped.has('variant') && r.variant && match.variant && searchNorm(r.variant) !== searchNorm(match.variant))
            r.errors.push(`Samme varenummer som ${veyroId(match.id)}, men en anden variant (${match.variant} / ${r.variant}). Angiv EAN, hvis det er en anden vare.`);
        }
      }
    }
    if (r.errors.length) action = 'fejl';
    else if (match) {
      // Felter uden kolonne beholder den nuværende værdi
      for (const f of TEXT_FIELDS) if (!mapped.has(f)) (r as unknown as Record<string, string>)[f] = match[f];
      if (!mapped.has('ean')) {
        r.ean = match.ean;
        r.gtin = match.gtin;
      }
      r.maker_key = makerKey(r.manufacturer);
      r.mpn_key = codeKey(r.mpn);
      r.dealer_key = codeKey(r.dealer_sku);
      for (const f of COMPARE) if (String(r[f] ?? '') !== String(match[f] ?? '')) changes.push(FIELD_LABEL[f]);
      if (r.price_state === 'set' && (match.p_amount !== r.price || match.p_currency !== r.currency || match.p_vat !== r.vat || (match.p_per ?? '') !== r.price_per)) changes.push('Pris');
      if (r.price_state === 'clear' && match.p_amount !== null) changes.push('Pris (fjernet, mangler i filen)');
      action = changes.length ? 'opdater' : 'uaendret';
      if (match.status !== 'aktiv' && action === 'uaendret') {
        action = 'opdater';
        changes.push('Status (findes igen i filen)');
      }
      matchSeen.set(match.id, r.row_no);
    }
    if (action !== 'fejl') {
      identSeen.set(ident, r.row_no);
      for (const w of wordsOf([r.name, r.variant, r.material, r.category, r.manufacturer].join(' '))) words.add(w);
    }
    out.push({
      row_no: r.row_no,
      ident,
      action,
      match_id: match?.id ?? null,
      errors: r.errors.join(' '),
      warnings: r.warnings.join(' '),
      changes: changes.join(', '),
      manufacturer: r.manufacturer,
      maker_key: r.maker_key,
      mpn: r.mpn,
      mpn_key: r.mpn_key,
      dealer_sku: r.dealer_sku,
      dealer_key: r.dealer_key,
      ean: r.ean,
      gtin: r.gtin,
      name: r.name,
      description: r.description,
      category: r.category,
      variant: r.variant,
      dimensions: r.dimensions,
      material: r.material,
      unit: r.unit,
      pack_size: r.pack_size,
      url: r.url,
      source_updated: r.source_updated,
      search_text: searchTextOf(r),
      name_key: searchNorm(r.name),
      price_state: r.price_state,
      price: r.price,
      currency: r.currency,
      vat: r.vat,
      price_per: r.price_per,
    });
  }
  const cols = [
    'row_no', 'ident', 'action', 'match_id', 'errors', 'warnings', 'changes', 'manufacturer', 'maker_key', 'mpn', 'mpn_key', 'dealer_sku', 'dealer_key', 'ean', 'gtin',
    'name', 'description', 'category', 'variant', 'dimensions', 'material', 'unit', 'pack_size', 'url', 'source_updated', 'search_text', 'name_key', 'price_state', 'price',
    'currency', 'vat', 'price_per',
  ];
  const stmts: D1PreparedStatement[] = [];
  // Højst ca. 100 rækker pr. sætning, så parameteren holder sig under D1's grænser
  for (let i = 0; i < out.length; i += 100) {
    stmts.push(
      db
        .prepare(
          `INSERT INTO catalog_import_rows (import_id, ${cols.join(', ')})
           SELECT ?1, ${cols.map((c) => `json_extract(value, '$.${c}')`).join(', ')} FROM json_each(?2)`,
        )
        .bind(imp.id, JSON.stringify(out.slice(i, i + 100))),
    );
  }
  if (words.size) {
    stmts.push(db.prepare('INSERT OR IGNORE INTO catalog_import_words (import_id, word) SELECT ?1, value FROM json_each(?2)').bind(imp.id, JSON.stringify([...words])));
  }
  if (stmts.length) await db.batch(stmts);
  return { staged: out.length, errors: out.filter((r) => r.action === 'fejl').length };
}

// --- Import: forhåndsvisning og godkendelse ----------------------------------------------------

export async function getImport(db: D1Database, id: number): Promise<CatalogImportRow | null> {
  return db.prepare('SELECT * FROM catalog_imports WHERE id = ?').bind(id).first<CatalogImportRow>();
}

export async function getSource(db: D1Database, id: number): Promise<CatalogSourceRow | null> {
  return db.prepare('SELECT * FROM catalog_sources WHERE id = ?').bind(id).first<CatalogSourceRow>();
}

export async function catalogSources(db: D1Database): Promise<(CatalogSourceRow & { products: number; review: number })[]> {
  const { results } = await db
    .prepare(
      `SELECT s.*, (SELECT COUNT(*) FROM catalog_products c WHERE c.source_id = s.id AND c.status <> 'skjult') AS products,
         (SELECT COUNT(*) FROM catalog_products c WHERE c.source_id = s.id AND c.status = 'gennemgang') AS review
       FROM catalog_sources s ORDER BY s.kind = 'demo', s.name COLLATE NOCASE`,
    )
    .all<CatalogSourceRow & { products: number; review: number }>();
  return results;
}

export async function createImport(db: D1Database, sourceId: number, filename: string, mapping: ImportOptions, actor: string, now: number): Promise<number> {
  const r = await db
    .prepare('INSERT INTO catalog_imports (source_id, filename, sheet, mapping, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?) RETURNING id')
    .bind(sourceId, filename.slice(0, 200), mapping.sheet ?? '', JSON.stringify(mapping), actor, now)
    .first<{ id: number }>();
  return r!.id;
}

/** Tæller forhåndsvisningen op, når alle rækker er indlæst. */
export async function finishUpload(db: D1Database, imp: CatalogImportRow): Promise<CatalogImportRow> {
  const counts = await db
    .prepare(
      `SELECT COUNT(*) AS total, COUNT(CASE WHEN action = 'ny' THEN 1 END) AS n_new, COUNT(CASE WHEN action = 'opdater' THEN 1 END) AS n_upd,
         COUNT(CASE WHEN action = 'uaendret' THEN 1 END) AS n_same, COUNT(CASE WHEN action = 'fejl' THEN 1 END) AS n_err
       FROM catalog_import_rows WHERE import_id = ?`,
    )
    .bind(imp.id)
    .first<{ total: number; n_new: number; n_upd: number; n_same: number; n_err: number }>();
  const missing = await db
    .prepare(
      `SELECT COUNT(*) AS n FROM catalog_products c WHERE c.source_id = ?1 AND c.status = 'aktiv'
         AND NOT EXISTS (SELECT 1 FROM catalog_import_rows r WHERE r.import_id = ?2 AND r.match_id = c.id AND r.action <> 'fejl')`,
    )
    .bind(imp.source_id, imp.id)
    .first<{ n: number }>();
  await db
    .prepare("UPDATE catalog_imports SET status = 'klar', rows_total = ?, rows_new = ?, rows_updated = ?, rows_same = ?, rows_error = ?, rows_missing = ? WHERE id = ? AND status = 'upload'")
    .bind(counts!.total, counts!.n_new, counts!.n_upd, counts!.n_same, counts!.n_err, missing!.n, imp.id)
    .run();
  return (await getImport(db, imp.id))!;
}

export type PreviewRow = { row_no: number; action: string; errors: string; warnings: string; changes: string; match_id: number | null; manufacturer: string; mpn: string; ean: string; name: string; variant: string; unit: string; pack_size: string; price: number | null; price_state: string; currency: string; vat: string };

export async function previewRows(db: D1Database, importId: number, action: string, limit = 50, offset = 0): Promise<PreviewRow[]> {
  const { results } = await db
    .prepare(
      `SELECT row_no, action, errors, warnings, changes, match_id, manufacturer, mpn, ean, name, variant, unit, pack_size, price, price_state, currency, vat
       FROM catalog_import_rows WHERE import_id = ?1 AND (?2 = '' OR action = ?2 OR (?2 = 'advarsel' AND warnings <> '')) ORDER BY row_no LIMIT ?3 OFFSET ?4`,
    )
    .bind(importId, action, limit, offset)
    .all<PreviewRow>();
  return results;
}

export async function missingRows(db: D1Database, imp: CatalogImportRow, limit = 50): Promise<CatalogProductRow[]> {
  const { results } = await db
    .prepare(
      `SELECT c.* FROM catalog_products c WHERE c.source_id = ?1 AND c.status = 'aktiv'
         AND NOT EXISTS (SELECT 1 FROM catalog_import_rows r WHERE r.import_id = ?2 AND r.match_id = c.id AND r.action <> 'fejl') ORDER BY c.name LIMIT ?3`,
    )
    .bind(imp.source_id, imp.id, limit)
    .all<CatalogProductRow>();
  return results;
}

export class ImportConflict extends Error {}

/**
 * Godkender en import: nye varer oprettes, ændrede opdateres, priser gemmes, og varer, der
 * mangler i filen, markeres til gennemgang (de slettes aldrig). Alt sker i én batch, så
 * importen enten gennemføres helt eller slet ikke. Lager, job og historik røres ikke.
 */
export async function approveImport(db: D1Database, imp: CatalogImportRow, actor: string, now: number, opts: { demo?: boolean } = {}): Promise<void> {
  if (imp.status !== 'klar') throw new ImportConflict(imp.status === 'godkendt' ? 'Importen er allerede godkendt.' : 'Importen er ikke klar til godkendelse.');
  // Er en anden fil fra samme kilde godkendt imens, er sammenligningen forældet
  const newer = await db
    .prepare("SELECT 1 FROM catalog_imports WHERE source_id = ? AND status = 'godkendt' AND approved_at >= ? AND id <> ? LIMIT 1")
    .bind(imp.source_id, imp.created_at, imp.id)
    .first();
  if (newer) throw new ImportConflict('En anden fil fra samme kilde er godkendt, efter denne blev indlæst. Indlæs filen igen.');
  const o = parseOptions(imp.mapping);
  const demo = opts.demo ? 1 : 0;
  const F = 'manufacturer, maker_key, mpn, mpn_key, dealer_sku, dealer_key, ean, gtin, name, description, category, variant, dimensions, material, unit, pack_size, url, source_updated, search_text, name_key';
  await db.batch([
    // Engangsnøgle: en import kan kun godkendes én gang (en anden godkendelse afvises i sin helhed)
    db.prepare("INSERT INTO ops (token, kind, actor, created_at) VALUES (?, 'katalogimport', ?, ?)").bind(`katalogimport:${imp.id}`, actor, now),
    db.prepare("UPDATE catalog_imports SET status = 'godkendt', approved_by = ?, approved_at = ? WHERE id = ?").bind(actor, now, imp.id),
    db
      .prepare(
        `INSERT INTO catalog_products (source_id, ${F}, status, is_demo, created_import_id, created_row_no, last_seen_import_id, imported_at, updated_at, created_at)
         SELECT ?1, ${F}, 'aktiv', ?3, import_id, row_no, import_id, ?4, ?4, ?4 FROM catalog_import_rows
         WHERE import_id = ?2 AND action = 'ny'`,
      )
      .bind(imp.source_id, imp.id, demo, now),
    db
      .prepare(
        `UPDATE catalog_import_rows SET match_id = (SELECT c.id FROM catalog_products c WHERE c.created_import_id = catalog_import_rows.import_id AND c.created_row_no = catalog_import_rows.row_no)
         WHERE import_id = ? AND action = 'ny'`,
      )
      .bind(imp.id),
    db
      .prepare(
        `UPDATE catalog_products SET ${F.split(', ').map((f) => `${f} = r.${f}`).join(', ')}, status = 'aktiv', review_note = '', updated_at = ?2
         FROM catalog_import_rows r WHERE r.import_id = ?1 AND r.action = 'opdater' AND r.match_id = catalog_products.id`,
      )
      .bind(imp.id, now),
    db
      .prepare(
        `UPDATE catalog_products SET last_seen_import_id = ?1, imported_at = ?2, source_updated = r.source_updated
         FROM catalog_import_rows r WHERE r.import_id = ?1 AND r.action <> 'fejl' AND r.match_id = catalog_products.id`,
      )
      .bind(imp.id, now),
    // Varer, der ikke er med i filen, slettes ikke: de markeres til gennemgang
    db
      .prepare(
        `UPDATE catalog_products SET status = 'gennemgang', review_note = ?3
         WHERE source_id = ?1 AND status = 'aktiv' AND (last_seen_import_id IS NULL OR last_seen_import_id <> ?2)`,
      )
      .bind(imp.source_id, imp.id, `Manglede i filen ${imp.filename || ''} (import ${imp.id}).`.slice(0, 300)),
    db
      .prepare(
        `INSERT INTO catalog_prices (catalog_product_id, source_id, seller, price_type, amount, currency, vat, per, import_id, imported_at)
         SELECT match_id, ?2, '', ?3, price, currency, vat, price_per, ?1, ?4 FROM catalog_import_rows
         WHERE import_id = ?1 AND action <> 'fejl' AND price_state = 'set' AND match_id IS NOT NULL
         ON CONFLICT(catalog_product_id, source_id, seller, price_type) DO UPDATE SET amount = excluded.amount, currency = excluded.currency, vat = excluded.vat,
           per = excluded.per, import_id = excluded.import_id, imported_at = excluded.imported_at`,
      )
      .bind(imp.id, imp.source_id, o.price_type, now),
    // En tom priskolonne betyder, at prisen nu er ukendt (den bliver aldrig til 0 kr.)
    db
      .prepare(
        `DELETE FROM catalog_prices WHERE source_id = ?2 AND seller = '' AND price_type = ?3
           AND catalog_product_id IN (SELECT match_id FROM catalog_import_rows WHERE import_id = ?1 AND action <> 'fejl' AND price_state = 'clear')`,
      )
      .bind(imp.id, imp.source_id, o.price_type),
    db.prepare('INSERT OR IGNORE INTO catalog_words (word) SELECT word FROM catalog_import_words WHERE import_id = ?').bind(imp.id),
    db.prepare('DELETE FROM catalog_import_words WHERE import_id = ?').bind(imp.id),
    db
      .prepare('UPDATE catalog_sources SET mapping = ?, last_import_id = ?, last_import_at = ? WHERE id = ?')
      .bind(JSON.stringify({ ...o, columns: o.columns }), imp.id, now, imp.source_id),
  ]);
}

export async function cancelImport(db: D1Database, imp: CatalogImportRow): Promise<void> {
  await db.batch([
    db.prepare("UPDATE catalog_imports SET status = 'annulleret' WHERE id = ? AND status IN ('upload', 'klar')").bind(imp.id),
    db.prepare('DELETE FROM catalog_import_rows WHERE import_id = ?').bind(imp.id),
    db.prepare('DELETE FROM catalog_import_words WHERE import_id = ?').bind(imp.id),
  ]);
}

// --- Søgning ----------------------------------------------------------------------------------

/** Optimal string alignment-afstand (Levenshtein med ombytning af to nabotegn). */
export function editDistance(a: string, b: string, max: number): number {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  const prev2: number[] = new Array(b.length + 1).fill(0);
  let prev: number[] = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur: number[] = [i];
    let rowMin = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let v = Math.min(prev[j]! + 1, cur[j - 1]! + 1, prev[j - 1]! + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) v = Math.min(v, prev2[j - 2]! + 1);
      cur.push(v);
      rowMin = Math.min(rowMin, v);
    }
    if (rowMin > max) return max + 1;
    prev2.splice(0, prev2.length, ...prev);
    prev = cur;
  }
  return prev[b.length]!;
}

/** Ord fra kataloget, der ligner et ord uden træffere (mindre stavefejl). */
async function similarWords(db: D1Database, w: string): Promise<string[]> {
  const max = w.length >= 7 ? 2 : 1;
  const { results } = await db
    .prepare('SELECT word FROM catalog_words WHERE length(word) BETWEEN ?1 AND ?2 AND substr(word, 1, 1) IN (?3, ?4) LIMIT 5000')
    .bind(w.length - max, w.length + max + 6, w[0], w[1] ?? w[0])
    .all<{ word: string }>();
  const scored: { word: string; d: number }[] = [];
  for (const { word } of results) {
    // Hele ordet, eller begyndelsen af det (brugeren er måske ikke færdig med at skrive)
    const d = Math.min(editDistance(w, word, max), word.length > w.length ? editDistance(w, word.slice(0, w.length), max) + 0.5 : max + 1);
    if (d <= max) scored.push({ word, d });
  }
  scored.sort((a, b) => a.d - b.d || a.word.length - b.word.length);
  return scored.slice(0, 4).map((s) => s.word);
}

export interface SearchOpts {
  q: string;
  maker?: string;
  category?: string;
  sourceId?: number | null;
  page?: number;
  perPage?: number;
  /** Medtag virksomhedens egne varer, der ikke er knyttet til kataloget */
  includeOwn?: boolean;
}

export interface SearchHit {
  kind: 'katalog' | 'lager';
  id: number;
  name: string;
  manufacturer: string;
  mpn: string;
  dealer_sku: string;
  ean: string;
  variant: string;
  dimensions: string;
  unit: string;
  pack_size: string;
  category: string;
  status: string;
  is_demo: number;
  source_name: string;
  source_kind: string;
  product_id: number | null;
  product_sku: string | null;
  stock: number | null;
  reserved: number | null;
  price_json: string | null;
  score: number;
}

export interface HitPrice {
  amount: number;
  currency: string;
  vat: CatalogVat;
  price_type: PriceType;
  per: string;
  seller: string;
  source: string;
  imported_at: number;
}

export function hitPrice(h: Pick<SearchHit, 'price_json'>): HitPrice | null {
  if (!h.price_json) return null;
  try {
    return JSON.parse(h.price_json) as HitPrice;
  } catch {
    return null;
  }
}

export interface SearchResult {
  hits: SearchHit[];
  total: number;
  page: number;
  perPage: number;
  /** Ord, der også er søgt på, fordi det skrevne ord ikke fandtes (stavefejl) */
  corrected: { from: string; to: string[] }[];
}

const OWN_TEXT = `replace(replace(replace(replace(replace(replace(lower(p.name || ' ' || p.variant || ' ' || p.category || ' ' || p.brand || ' ' || p.sku || ' ' || p.mpn || ' ' || p.ean), 'Æ', 'æ'), 'Ø', 'ø'), 'Å', 'å'), '×', ' x '), ',', '.'), '-', ' ')`;

const PRICE_SQL = `(SELECT json_object('amount', cp.amount, 'currency', cp.currency, 'vat', cp.vat, 'price_type', cp.price_type, 'per', cp.per, 'seller', cp.seller,
    'source', (SELECT name FROM catalog_sources WHERE id = cp.source_id), 'imported_at', cp.imported_at)
  FROM catalog_prices cp WHERE cp.catalog_product_id = c.id ORDER BY cp.source_id = c.source_id DESC, cp.imported_at DESC LIMIT 1)`;

/**
 * Søger i hele kataloget og i virksomhedens egne varer på serveren med sideinddeling.
 * Præcist EAN og varenummer kommer først; derefter navn med alle ord. Et ord uden træffere
 * udvides med lignende ord fra kataloget, så mindre stavefejl stadig finder varen.
 */
export async function searchCatalog(db: D1Database, opts: SearchOpts): Promise<SearchResult> {
  const perPage = Math.min(Math.max(opts.perPage ?? 20, 1), 50);
  const page = Math.max(opts.page ?? 1, 1);
  const raw = opts.q.trim().slice(0, 100);
  const nq = searchNorm(raw);
  const code = codeKey(raw);
  const digits = raw.replace(/[\s-]/g, '');
  const gtin = /^\d{8,14}$/.test(digits) ? (normGtin(digits) ?? '') : '';
  const vk = parseVeyroId(raw);
  const words = [...new Set(nq.split(' ').filter(Boolean))].slice(0, 6);

  // Stavefejl: ord på mindst 4 bogstaver, der ikke er begyndelsen af et ord i kataloget
  const corrected: SearchResult['corrected'] = [];
  const groups: string[][] = [];
  for (const w of words) {
    let alts = [w];
    if (w.length >= 4 && /^[a-zæøåäöüé]+$/.test(w)) {
      const known = await db.prepare('SELECT 1 FROM catalog_words WHERE word >= ?1 AND word < ?2 LIMIT 1').bind(w, w + '￿').first();
      if (!known) {
        const sim = await similarWords(db, w);
        if (sim.length) {
          alts = [w, ...sim];
          corrected.push({ from: w, to: sim });
        }
      }
    }
    groups.push(alts);
  }

  // Parametre: ?1 gtin, ?2 kode, ?3 normaliseret søgetekst, ?4 producent, ?5 kategori, ?6 kilde, ?7 VK-id, ?8.. ord
  const params: unknown[] = [gtin, code, nq, makerKey(opts.maker ?? ''), (opts.category ?? '').trim(), opts.sourceId ?? 0, vk ?? 0];
  const wordParam = (w: string) => {
    params.push(`%${w}%`);
    return `?${params.length}`;
  };
  const groupSql = groups.map((alts) => {
    const ps = alts.map(wordParam);
    return { cat: `(${ps.map((p) => `c.search_text LIKE ${p}`).join(' OR ')})`, own: `(${ps.map((p) => `${OWN_TEXT} LIKE ${p}`).join(' OR ')})`, name: ps[0]! };
  });
  const catCode = `(?1 <> '' AND c.gtin = ?1) OR (?2 <> '' AND (c.mpn_key = ?2 OR c.dealer_key = ?2 OR (length(?2) >= 3 AND c.mpn_key LIKE ?2 || '%'))) OR (?7 > 0 AND c.id = ?7)`;
  const catWords = groupSql.length ? groupSql.map((g) => g.cat).join(' AND ') : '1';
  const catWhere = `c.status <> 'skjult' AND (?4 = '' OR c.maker_key = ?4) AND (?5 = '' OR c.category = ?5) AND (?6 = 0 OR c.source_id = ?6)
    AND (${raw ? `${catCode} OR (${catWords})` : '1'})`;
  const catScore = `(CASE WHEN ?1 <> '' AND c.gtin = ?1 THEN 1000 WHEN ?7 > 0 AND c.id = ?7 THEN 1000 WHEN ?2 <> '' AND (c.mpn_key = ?2 OR c.dealer_key = ?2) THEN 900
      WHEN length(?2) >= 3 AND c.mpn_key LIKE ?2 || '%' THEN 400 ELSE 0 END
    + CASE WHEN ?3 = '' THEN 0 WHEN c.name_key = ?3 THEN 300 WHEN c.name_key LIKE ?3 || '%' THEN 150 WHEN c.name_key LIKE '%' || ?3 || '%' THEN 80 ELSE 0 END
    ${groupSql.map((g) => `+ CASE WHEN c.name_key LIKE ${g.name} THEN 10 ELSE 0 END`).join(' ')}
    + CASE WHEN c.status = 'aktiv' THEN 2 ELSE 0 END + CASE WHEN p.id IS NOT NULL THEN 5 ELSE 0 END)`;

  const ownCode = `(?1 <> '' AND length(p.ean) >= 8 AND substr('00000000000000' || p.ean, -14) = ?1) OR (?2 <> '' AND (upper(replace(p.sku, ' ', '')) = ?2 OR upper(replace(p.mpn, ' ', '')) = ?2))`;
  const ownWords = groupSql.length ? groupSql.map((g) => g.own).join(' AND ') : '1';
  const own = opts.includeOwn !== false && !opts.sourceId;
  const ownWhere = `p.active = 1 AND p.catalog_product_id IS NULL AND (?4 = '' OR lower(p.brand) = ?4) AND (?5 = '' OR p.category = ?5)
    AND (${raw ? `${ownCode} OR (${ownWords})` : '1'})`;
  const ownScore = `(CASE WHEN ${ownCode} THEN 900 ELSE 0 END + CASE WHEN ?3 <> '' AND lower(p.name) LIKE ?3 || '%' THEN 150 ELSE 0 END
    ${groupSql.map((g) => `+ CASE WHEN lower(p.name) LIKE ${g.name} THEN 10 ELSE 0 END`).join(' ')} + 5)`;

  const catSelect = `SELECT 'katalog' AS kind, c.id, c.name, c.manufacturer, c.mpn, c.dealer_sku, c.ean, c.variant, c.dimensions, c.unit, c.pack_size, c.category, c.status, c.is_demo,
      s.name AS source_name, s.kind AS source_kind, p.id AS product_id, p.sku AS product_sku, p.stock, p.reserved, ${PRICE_SQL} AS price_json, ${catScore} AS score
    FROM catalog_products c JOIN catalog_sources s ON s.id = c.source_id LEFT JOIN products p ON p.catalog_product_id = c.id WHERE ${catWhere}`;
  const ownSelect = `SELECT 'lager' AS kind, p.id, p.name, p.brand AS manufacturer, p.mpn, '' AS dealer_sku, p.ean, p.variant, '' AS dimensions, p.unit, '' AS pack_size, p.category, 'aktiv' AS status, 0 AS is_demo,
      'Eget varekartotek' AS source_name, 'lager' AS source_kind, p.id AS product_id, p.sku AS product_sku, p.stock, p.reserved, NULL AS price_json, ${ownScore} AS score
    FROM products p WHERE ${ownWhere}`;
  const union = own ? `${catSelect} UNION ALL ${ownSelect}` : catSelect;
  const limitAt = params.length + 1;
  const [rows, count] = await Promise.all([
    db
      .prepare(`SELECT * FROM (${union}) ORDER BY score DESC, name COLLATE NOCASE, id LIMIT ?${limitAt} OFFSET ?${limitAt + 1}`)
      .bind(...params, perPage, (page - 1) * perPage)
      .all<SearchHit>(),
    db
      .prepare(
        `SELECT (SELECT COUNT(*) FROM catalog_products c JOIN catalog_sources s ON s.id = c.source_id LEFT JOIN products p ON p.catalog_product_id = c.id WHERE ${catWhere})
           ${own ? `+ (SELECT COUNT(*) FROM products p WHERE ${ownWhere})` : ''} AS n, ?7 AS vk`,
      )
      .bind(...params)
      .first<{ n: number }>(),
  ]);
  return { hits: rows.results, total: count?.n ?? 0, page, perPage, corrected };
}

/** Producenter og kategorier til filtrene (kun dem, der har aktive varer). */
export async function catalogFacets(db: D1Database): Promise<{ makers: { key: string; name: string; n: number }[]; categories: { name: string; n: number }[] }> {
  const [makers, cats] = await Promise.all([
    db
      .prepare("SELECT maker_key AS key, MIN(manufacturer) AS name, COUNT(*) AS n FROM catalog_products WHERE status <> 'skjult' AND maker_key <> '' GROUP BY maker_key ORDER BY name COLLATE NOCASE LIMIT 300")
      .all<{ key: string; name: string; n: number }>(),
    db
      .prepare("SELECT category AS name, COUNT(*) AS n FROM catalog_products WHERE status <> 'skjult' AND category <> '' GROUP BY category ORDER BY category COLLATE NOCASE LIMIT 300")
      .all<{ name: string; n: number }>(),
  ]);
  return { makers: makers.results, categories: cats.results };
}

export type CatalogDetail = CatalogProductRow & { source_name: string; source_kind: SourceKind };

export async function getCatalogProduct(db: D1Database, id: number): Promise<CatalogDetail | null> {
  return db
    .prepare('SELECT c.*, s.name AS source_name, s.kind AS source_kind FROM catalog_products c JOIN catalog_sources s ON s.id = c.source_id WHERE c.id = ?')
    .bind(id)
    .first<CatalogDetail>();
}

export async function catalogPrices(db: D1Database, id: number): Promise<(CatalogPriceRow & { source_name: string })[]> {
  const { results } = await db
    .prepare('SELECT p.*, s.name AS source_name FROM catalog_prices p JOIN catalog_sources s ON s.id = p.source_id WHERE p.catalog_product_id = ? ORDER BY p.imported_at DESC')
    .bind(id)
    .all<CatalogPriceRow & { source_name: string }>();
  return results;
}

/** Andre varianter: samme producent og samme produktnavn (fx andre mål eller pakninger). */
export async function variantsOf(db: D1Database, c: CatalogProductRow): Promise<CatalogProductRow[]> {
  const { results } = await db
    .prepare("SELECT * FROM catalog_products WHERE maker_key = ? AND name_key = ? AND id <> ? AND status <> 'skjult' ORDER BY variant, dimensions, pack_size LIMIT 30")
    .bind(c.maker_key, c.name_key, c.id)
    .all<CatalogProductRow>();
  return results;
}

/** Enheder, der kun håndteres i hele antal (rundes op). */
export function wholeUnitsFor(unit: string): number {
  return /^(stk|styk|pk|pakke|pakker|ps|rl|rulle|spand|patron|sæt|saet|par|ks|kasse|pose|sæk|saek|dåse|daase|plade|stang|bundt|palle)\.?$/i.test(unit.trim()) ? 1 : 0;
}
