// Prisestimat på indkøbslister ud fra offentlige priser hos byggemarkeder og trælaster.
//
// Reglerne:
// - Kun offentlige priser uden login, medlemskab eller kundeaftale. Priser kommer fra en
//   forhandlers officielle prisfil (uploadet eller hentet fra et feed), fra manuel indtastning med
//   produktlink, eller fra demodata (markeret "Demodata"). Siderne skrabes ikke.
// - Der opfindes aldrig priser, links eller lagerstatus: findes der intet, er prisen "Pris mangler".
// - Match: 1) samme EAN/GTIN, 2) producentens varenummer + mærke + variant, 3) navn og mål.
//   Kun 1) og 2) er "Præcist match"; navnematch er altid "Alternativ – kræver godkendelse".
//   Forhandlernes egne varenumre sammenlignes aldrig på tværs af forhandlere.
// - Estimater er adskilt fra linjens forventede pris, den faktiske indkøbspris og salgspriser, og
//   et prisopslag ændrer aldrig en linjes status (bestiller intet, markerer intet som bestilt).

import type { PurchaseLineRow } from '../env';
import { Q, parseDay, parseKr, parseQty, todayDk } from './format';

export type Vat = 'inkl' | 'ekskl';
export type MatchKind = 'praecis' | 'alternativ';
export type MatchBasis = 'ean' | 'mpn' | 'navn' | 'manuel';
export type EstimateSource = 'prisfil' | 'demodata' | 'manuel';
export type EstimateStatus = 'aktuel' | 'tidligere' | 'forslag' | 'erstattet';
export type Access = 'manuel' | 'prisfil' | 'demo';

export const VAT_LABEL: Record<Vat, string> = { inkl: 'inkl. moms', ekskl: 'ekskl. moms' };
export const MATCH_LABEL: Record<MatchKind, string> = { praecis: 'Præcist match', alternativ: 'Alternativ – kræver godkendelse' };
export const BASIS_LABEL: Record<MatchBasis, string> = { ean: 'samme EAN', mpn: 'samme producentnr., mærke og variant', navn: 'navn og mål', manuel: 'valgt manuelt' };
export const SOURCE_LABEL: Record<EstimateSource, string> = { prisfil: 'Prisfil', demodata: 'Demodata', manuel: 'Manuelt indtastet' };
export const ACCESS_LABEL: Record<Access, string> = { manuel: 'Produktlink og manuel pris', prisfil: 'Officiel prisfil', demo: 'Demodata' };

export const DISCLAIMER =
  'Vejledende prisestimat baseret på offentlige priser. Endelig pris, tilgængelighed, fragt og eventuelle rabatter bekræftes hos leverandøren.';
export const FREIGHT_NOTE = 'Fragt og eventuelle gebyrer er ikke medregnet';
export const STALE_LABEL = 'Tidligere pris – ikke bekræftet';

/** Dansk moms (25 %). */
export function convertVat(oere: number, from: Vat, to: Vat): number {
  if (from === to) return oere;
  return from === 'inkl' ? Math.round((oere * 4) / 5) : Math.round((oere * 5) / 4);
}

// --- Enheder og produktdata -----------------------------------------------------------------

const UNIT_ALIASES: Record<string, string> = {
  stk: 'stk', styk: 'stk', stykker: 'stk', st: 'stk', pcs: 'stk',
  pk: 'pk', pakke: 'pk', pakker: 'pk', pak: 'pk', pkt: 'pk',
  m: 'm', meter: 'm', lbm: 'm', 'lb.m': 'm', lm: 'm',
  m2: 'm2', 'm²': 'm2', kvm: 'm2', kvadratmeter: 'm2',
  l: 'l', liter: 'l', ltr: 'l',
  rl: 'rl', rulle: 'rl', ruller: 'rl',
  kg: 'kg', kilo: 'kg',
  patron: 'patron', patroner: 'patron',
  spand: 'spand', spande: 'spand',
};

/** "Stk." og "styk" er samme enhed; ukendte enheder sammenlignes som skrevet. */
export function normUnit(u: string): string {
  const s = u.trim().toLowerCase().replace(/\.$/, '');
  return UNIT_ALIASES[s] ?? s;
}

/** EAN/GTIN (8, 12, 13 eller 14 cifre) med gyldigt kontrolciffer, normaliseret til 14 cifre. */
export function normGtin(raw: string): string | null {
  const s = raw.replace(/[\s-]/g, '');
  if (!/^(\d{8}|\d{12,14})$/.test(s)) return null;
  const g = s.padStart(14, '0');
  let sum = 0;
  for (let i = 0; i < 13; i++) sum += Number(g[i]) * (i % 2 === 0 ? 3 : 1);
  return (10 - (sum % 10)) % 10 === Number(g[13]) ? g : null;
}

/** Kontrolciffer til en 12-cifret EAN-13-start (bruges til demodata). */
export function ean13(first12: string): string {
  let sum = 0;
  for (let i = 0; i < 12; i++) sum += Number(first12[i]) * (i % 2 === 0 ? 1 : 3);
  return first12 + String((10 - (sum % 10)) % 10);
}

const normCode = (s: string) => s.toUpperCase().replace(/[^0-9A-ZÆØÅ]/g, '');
const normText = (s: string) => s.trim().toLowerCase().replace(/\s+/g, ' ');

const STOP = new Set(['og', 'til', 'med', 'for', 'af', 'i', 'the', 'stk', 'pk', 'pakke', 'pakker', 'styk', 'inkl', 'ekskl', 'ca']);

/** Navn -> mål (fx "13mm", "900", "2500") og ord (materiale, type, kvalitet). */
export function nameTokens(name: string): { dims: Set<string>; words: Set<string> } {
  let s = name.toLowerCase().replace(/(\d),(\d)/g, '$1.$2').replace(/[×*]/g, ' x ');
  const dims = new Set<string>();
  s = s.replace(/(\d+(?:\.\d+)?)\s*(mm|cm|ml|m²|m2|m|l|kg|g)(?![a-zæøå])/g, (_m, n: string, u: string) => {
    dims.add(`${Number(n)}${u === 'm²' ? 'm2' : u}`);
    return ' ';
  });
  for (const n of s.match(/\d+(?:\.\d+)?/g) ?? []) dims.add(String(Number(n)));
  const words = new Set((s.match(/[a-zæøå]{2,}/g) ?? []).filter((w) => !STOP.has(w) && w !== 'x'));
  return { dims, words };
}

export interface Wanted {
  ean: string;
  mpn: string;
  brand: string;
  variant: string;
  name: string;
  unit: string;
}

export interface CatalogRow {
  id: number;
  retailer_id: number;
  retailer_sku: string;
  ean: string;
  mpn: string;
  brand: string;
  variant: string;
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
  offer_min_qty: number | null;
  offer_until: string;
  stock_text: string;
  source: 'prisfil' | 'demodata';
  checked_at: number;
}

export interface Match<T> {
  row: T;
  match: MatchKind;
  basis: MatchBasis;
}

/**
 * Finder den bedste vare hos én forhandler. Rækkefølgen er fast: EAN, så producentnr. med mærke og
 * variant, så navn og mål. Kun de to første giver et præcist match.
 */
export function findMatch<T extends Pick<CatalogRow, 'ean' | 'mpn' | 'brand' | 'variant' | 'name' | 'content_unit'>>(w: Wanted, cands: T[]): Match<T> | null {
  const g = normGtin(w.ean);
  if (g) {
    const hit = cands.find((c) => normGtin(c.ean) === g);
    if (hit) return { row: hit, match: 'praecis', basis: 'ean' };
  }
  if (w.mpn && w.brand) {
    const hit = cands.find(
      (c) => c.mpn && normCode(c.mpn) === normCode(w.mpn) && normText(c.brand) === normText(w.brand) && normText(c.variant) === normText(w.variant),
    );
    if (hit) return { row: hit, match: 'praecis', basis: 'mpn' };
  }
  const want = nameTokens(w.name);
  if (!want.words.size) return null;
  let best: { row: T; score: number } | null = null;
  for (const c of cands) {
    if (normUnit(c.content_unit) !== normUnit(w.unit)) continue; // pakningsstørrelsen skal kunne omregnes
    const t = nameTokens(c.name);
    // Mål skal være de samme begge veje (13 mm er ikke 12,5 mm, og 2400 er ikke 2500)
    if (want.dims.size !== t.dims.size || [...want.dims].some((d) => !t.dims.has(d))) continue;
    const shared = [...want.words].filter((x) => t.words.has(x)).length;
    const score = shared / new Set([...want.words, ...t.words]).size;
    if (shared && score >= 0.4 && (!best || score > best.score)) best = { row: c, score };
  }
  return best ? { row: best.row, match: 'alternativ', basis: 'navn' } : null;
}

// --- Købsmængde og pris ---------------------------------------------------------------------

export interface OfferTerms {
  sales_unit: string;
  pack_qty: number;
  content_unit: string;
  min_qty: number;
  divisible: number;
  price: number;
  vat: Vat;
  offer_price: number | null;
  offer_text: string;
  offer_min_qty: number | null;
  offer_until: string;
}

export type BuyPlan =
  | { ok: true; buy: number; covered: number; unitPrice: number; amount: number; offer: 'gaelder' | 'opfyldes_ikke' | 'udloebet' | 'ingen' }
  | { ok: false; reason: string };

/**
 * Omregner den manglende mængde (i listens enhed) til forhandlerens salgsenhed: hele pakker,
 * mindstekøb og evt. tilbud. Fx 12 stk. i pakker á 10 = 2 pakker, 20 stk.
 */
export function buyPlan(need: number, lineUnit: string, o: OfferTerms, today = todayDk()): BuyPlan {
  if (normUnit(o.content_unit) !== normUnit(lineUnit)) {
    return { ok: false, reason: `Forhandleren sælger i ${o.content_unit}, listen er i ${lineUnit}. Mængden kan ikke omregnes.` };
  }
  if (need <= 0) return { ok: true, buy: 0, covered: 0, unitPrice: o.price, amount: 0, offer: 'ingen' };
  const exact = Math.ceil((need * Q) / o.pack_qty - 1e-9); // salgsenheder i tusindedele
  let buy = o.divisible ? exact : Math.ceil(exact / Q - 1e-9) * Q;
  const min = o.divisible ? o.min_qty : Math.ceil(o.min_qty / Q - 1e-9) * Q;
  buy = Math.max(buy, min);
  const covered = Math.round((buy * o.pack_qty) / Q);
  let offer: 'gaelder' | 'opfyldes_ikke' | 'udloebet' | 'ingen' = 'ingen';
  if (o.offer_price !== null) {
    if (o.offer_until && o.offer_until < today) offer = 'udloebet';
    else if (o.offer_min_qty !== null && buy < o.offer_min_qty) offer = 'opfyldes_ikke';
    else offer = 'gaelder';
  }
  const unitPrice = offer === 'gaelder' ? o.offer_price! : o.price;
  return { ok: true, buy, covered, unitPrice, amount: Math.round((unitPrice * buy) / Q), offer };
}

/** Den mængde, der mangler at blive købt på linjen. */
export function missingQty(l: Pick<PurchaseLineRow, 'qty' | 'ordered' | 'cancelled'>): number {
  return l.cancelled ? 0 : Math.max(0, l.qty - l.ordered);
}

// --- Visning af estimater -------------------------------------------------------------------

export interface EstimateRow extends OfferTerms {
  id: number;
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
  need_qty: number;
  buy_qty: number | null;
  amount: number | null;
  source: EstimateSource;
  status: EstimateStatus;
  note: string;
  checked_at: number;
  created_by: string;
  created_at: number;
  replaced_at: number | null;
}

export type EstimateView = EstimateRow & { retailer_name: string; retailer_access: Access };

export interface OfferLine {
  est: EstimateView;
  plan: BuyPlan;
  /** Linjens estimat i listens momsgrundlag (kun når planen kan beregnes) */
  amount: number | null;
  usable: boolean;
  stale: boolean;
  lowest: boolean;
  chosen: boolean;
}

export interface LineEstimate {
  need: number;
  offers: OfferLine[];
  proposals: EstimateView[];
  chosen: OfferLine | null;
  /** Hvorfor der ikke er en pris (når chosen er null) */
  missingReason: string;
}

export interface EstimateOpts {
  basis: Vat;
  maxAgeDays: number;
  now: number;
  today: string;
}

export function lineEstimate(
  line: Pick<PurchaseLineRow, 'qty' | 'ordered' | 'cancelled' | 'unit'>,
  ests: EstimateView[],
  o: EstimateOpts,
): LineEstimate {
  const need = missingQty(line);
  const live = ests.filter((e) => e.status === 'aktuel' || e.status === 'tidligere');
  const offers: OfferLine[] = live.map((est) => {
    const plan = buyPlan(need, line.unit, est, o.today);
    const usable = plan.ok && (est.match === 'praecis' || est.approved_at !== null);
    return {
      est,
      plan,
      amount: plan.ok ? convertVat(plan.amount, est.vat, o.basis) : null,
      usable,
      stale: est.status === 'tidligere' || o.now - est.checked_at > o.maxAgeDays * 86400,
      lowest: false,
      chosen: false,
    };
  });
  const usable = offers.filter((x) => x.usable);
  // Kun materialeprisen sammenlignes; ukendt fragt tælles aldrig som 0 kr. i en "billigst"-påstand
  if (usable.length >= 2) {
    const min = Math.min(...usable.map((x) => x.amount!));
    for (const x of usable) x.lowest = x.amount === min;
  }
  let chosen: OfferLine | null = null;
  let missingReason = '';
  if (need <= 0) missingReason = 'Hele mængden er bestilt.';
  else {
    // Altid den billigste sammenlignelige pris blandt alle forhandlere
    chosen = usable.find((x) => x.lowest) ?? usable[0] ?? null;
    if (!chosen) {
      missingReason = offers.some((x) => x.plan.ok && x.est.match === 'alternativ')
        ? 'Kun alternativer, der ikke er godkendt.'
        : offers.length
          ? 'Prisen kan ikke omregnes til listens enhed.'
          : 'Ingen offentlig pris fundet.';
    }
  }
  if (chosen) chosen.chosen = true;
  offers.sort((a, b) => Number(b.usable) - Number(a.usable) || (a.amount ?? Infinity) - (b.amount ?? Infinity));
  return { need, offers, proposals: ests.filter((e) => e.status === 'forslag'), chosen, missingReason };
}

export interface ListEstimate {
  basis: Vat;
  total: number;
  priced: number;
  missing: { name: string; reason: string }[];
  stale: number;
  oldest: number | null;
  newest: number | null;
  lines: number;
}

export function summarize(items: { name: string; est: LineEstimate }[], basis: Vat): ListEstimate {
  const s: ListEstimate = { basis, total: 0, priced: 0, missing: [], stale: 0, oldest: null, newest: null, lines: 0 };
  for (const { name, est } of items) {
    if (est.need <= 0) continue;
    s.lines++;
    const c = est.chosen;
    if (!c) {
      s.missing.push({ name, reason: est.missingReason });
      continue;
    }
    s.priced++;
    s.total += c.amount!;
    if (c.stale) s.stale++;
    s.oldest = s.oldest === null ? c.est.checked_at : Math.min(s.oldest, c.est.checked_at);
    s.newest = s.newest === null ? c.est.checked_at : Math.max(s.newest, c.est.checked_at);
  }
  return s;
}

// --- Prisfiler ------------------------------------------------------------------------------

/** Kolonner i en prisfil (CSV med semikolon, komma eller tabulator). Kun navn, link, pris og moms er krævet. */
export const FEED_COLUMNS = [
  ['varenr', 'Forhandlerens varenummer'],
  ['ean', 'EAN/GTIN'],
  ['producentnr', 'Producentens varenummer'],
  ['maerke', 'Mærke'],
  ['variant', 'Variant (fx farve eller længde)'],
  ['navn', 'Produktnavn (krævet)'],
  ['link', 'Produktside, https (krævet)'],
  ['salgsenhed', 'Enhed der sælges i, fx pk. eller stk.'],
  ['indhold', 'Indhold pr. salgsenhed, fx 10'],
  ['indholdsenhed', 'Enhed for indholdet, fx stk.'],
  ['min_koeb', 'Mindste køb i salgsenheder'],
  ['delbar', '"ja" hvis der kan købes brøkdele (metervare)'],
  ['pris', 'Pris pr. salgsenhed i kr. (krævet)'],
  ['moms', '"inkl" eller "ekskl" (krævet)'],
  ['tilbudspris', 'Tilbudspris pr. salgsenhed'],
  ['tilbudstekst', 'Tilbuddets betingelser'],
  ['tilbud_min_antal', 'Tilbuddet kræver mindst dette antal'],
  ['tilbud_til', 'Sidste dag for tilbuddet (ÅÅÅÅ-MM-DD)'],
  ['lagerstatus', 'Kun hvis kilden selv oplyser den'],
  ['kraever_login', '"ja" = prisen kræver login eller aftale (rækken springes over)'],
] as const;

const HEADER_ALIASES: Record<string, string> = {
  varenummer: 'varenr', sku: 'varenr', gtin: 'ean', ean13: 'ean', stregkode: 'ean',
  producentvarenummer: 'producentnr', mpn: 'producentnr', maerke: 'maerke', brand: 'maerke', fabrikat: 'maerke',
  produktnavn: 'navn', name: 'navn', url: 'link', produktlink: 'link', enhed: 'salgsenhed',
  antalprpakke: 'indhold', pakningsstoerrelse: 'indhold', minkoeb: 'min_koeb', mindstekoeb: 'min_koeb',
  price: 'pris', tilbud: 'tilbudspris', tilbudsbetingelse: 'tilbudstekst', tilbudminantal: 'tilbud_min_antal',
  tilbudtil: 'tilbud_til', kraeverlogin: 'kraever_login', minkob: 'min_koeb',
};

function headerKey(h: string): string {
  const k = h.trim().toLowerCase().replace(/æ/g, 'ae').replace(/ø/g, 'oe').replace(/å/g, 'aa').replace(/[^a-z0-9_]/g, '');
  const flat = k.replace(/_/g, '');
  if (FEED_COLUMNS.some(([c]) => c === k)) return k;
  return HEADER_ALIASES[flat] ?? HEADER_ALIASES[k] ?? FEED_COLUMNS.find(([c]) => c.replace(/_/g, '') === flat)?.[0] ?? k;
}

/** Simpel CSV-læser med anførselstegn. */
export function parseCsv(text: string): string[][] {
  const src = text.replace(/^﻿/, '');
  const first = src.split(/\r?\n/, 1)[0] ?? '';
  const delim = [';', '\t', ','].reduce((a, d) => (first.split(d).length > first.split(a).length ? d : a), ';');
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let q = false;
  for (let i = 0; i < src.length; i++) {
    const ch = src[i]!;
    if (q) {
      if (ch === '"' && src[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (ch === '"') q = false;
      else cell += ch;
    } else if (ch === '"' && cell === '') q = true;
    else if (ch === delim) {
      row.push(cell);
      cell = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && src[i + 1] === '\n') i++;
      row.push(cell);
      if (row.some((c) => c.trim())) rows.push(row);
      row = [];
      cell = '';
    } else cell += ch;
  }
  row.push(cell);
  if (row.some((c) => c.trim())) rows.push(row);
  return rows;
}

export type FeedItem = Omit<CatalogRow, 'id' | 'retailer_id' | 'source' | 'checked_at'>;

function hostOf(url: string): string | null {
  try {
    const u = new URL(url);
    return u.protocol === 'https:' ? u.hostname.toLowerCase() : null;
  } catch {
    return null;
  }
}

/** Domænet fra forhandlerens hjemmeside (www. fjernes), så links skal pege på forhandleren selv. */
export function siteDomain(website: string): string {
  return (hostOf(website) ?? '').replace(/^www\./, '');
}

export function parseFeed(text: string, website: string): { items: FeedItem[]; errors: string[]; skipped: number } {
  const rows = parseCsv(text);
  const errors: string[] = [];
  if (rows.length < 2) return { items: [], errors: ['Filen har ingen rækker under overskrifterne.'], skipped: 0 };
  const head = rows[0]!.map(headerKey);
  for (const need of ['navn', 'link', 'pris', 'moms']) if (!head.includes(need)) errors.push(`Kolonnen "${need}" mangler.`);
  if (errors.length) return { items: [], errors, skipped: 0 };
  const domain = siteDomain(website);
  const items: FeedItem[] = [];
  const seen = new Set<string>();
  let skipped = 0;
  rows.slice(1).forEach((r, i) => {
    const n = i + 2;
    const get = (k: string) => (r[head.indexOf(k)] ?? '').trim();
    const err = (m: string) => errors.push(`Række ${n}: ${m}`);
    if (/^(ja|1|true|yes)$/i.test(get('kraever_login'))) {
      skipped++;
      return;
    }
    const name = get('navn').slice(0, 200);
    const url = get('link');
    const host = hostOf(url);
    if (!name) return err('navn mangler.');
    if (!host) return err('link skal være en https-adresse.');
    if (domain && host !== domain && !host.endsWith(`.${domain}`)) return err(`linket peger ikke på ${domain}.`);
    const price = parseKr(get('pris'));
    if (price === null) return err('prisen er ikke gyldig.');
    const vatRaw = get('moms').toLowerCase();
    const vat: Vat | null = /^inkl/.test(vatRaw) ? 'inkl' : /^ekskl|^excl|^ex/.test(vatRaw) ? 'ekskl' : null;
    if (!vat) return err('moms skal være "inkl" eller "ekskl".');
    const eanRaw = get('ean');
    const ean = eanRaw ? normGtin(eanRaw) : '';
    if (ean === null) return err('EAN er ikke gyldig (kontrolcifferet passer ikke).');
    const salesUnit = get('salgsenhed') || 'stk.';
    const packRaw = get('indhold');
    const pack = packRaw ? parseQty(packRaw) : Q;
    if (!pack) return err('indhold pr. salgsenhed er ikke gyldigt.');
    const contentUnit = get('indholdsenhed');
    if (pack !== Q && !contentUnit) return err('angiv indholdsenhed, når indholdet ikke er 1.');
    const minRaw = get('min_koeb');
    const min = minRaw ? parseQty(minRaw) : Q;
    if (!min) return err('mindste køb er ikke gyldigt.');
    const offerRaw = get('tilbudspris');
    const offer = offerRaw ? parseKr(offerRaw) : null;
    if (offerRaw && offer === null) return err('tilbudsprisen er ikke gyldig.');
    const until = parseDay(get('tilbud_til'));
    if (until === null) return err('tilbud_til skal være ÅÅÅÅ-MM-DD.');
    const offerMinRaw = get('tilbud_min_antal');
    const offerMin = offerMinRaw ? parseQty(offerMinRaw) : null;
    if (offerMinRaw && offerMin === null) return err('tilbud_min_antal er ikke gyldigt.');
    const sku = (get('varenr') || url).slice(0, 300);
    if (seen.has(sku)) return err(`varenummeret ${sku} står flere gange.`);
    seen.add(sku);
    items.push({
      retailer_sku: sku,
      ean: ean ?? '',
      mpn: get('producentnr').slice(0, 60),
      brand: get('maerke').slice(0, 60),
      variant: get('variant').slice(0, 60),
      name,
      url: url.slice(0, 500),
      sales_unit: salesUnit.slice(0, 20),
      pack_qty: pack,
      content_unit: (contentUnit || salesUnit).slice(0, 20),
      min_qty: min,
      divisible: /^(ja|1|true|yes)$/i.test(get('delbar')) ? 1 : 0,
      price,
      vat,
      offer_price: offer,
      offer_text: get('tilbudstekst').slice(0, 200),
      offer_min_qty: offerMin,
      offer_until: until,
      stock_text: get('lagerstatus').slice(0, 60),
    });
  });
  return { items, errors, skipped };
}
