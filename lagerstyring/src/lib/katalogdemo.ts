// Demodata til produktkataloget: en lille fil med fiktive varer (CSV og Excel), som også lægges
// ind i demoen, og en belastningstest med 10.000 syntetiske varer.
//
// Alle varer er opdigtede: producenterne "Nordlys Demo" og "Demo VVS" findes ikke, varenumrene
// begynder med DEMO-, og EAN-numrene har præfiks 20 (til internt brug), så de ikke er rigtige
// varers numre. Der er ingen priser eller numre fra KEMPER eller andre rigtige producenter.

import { ean13 } from './prices';
import { approveImport, createImport, finishUpload, getImport, parseOptions, stageRows, type CatalogField, type ImportOptions } from './produktkatalog';

const NORD = 'Nordlys Demo';
const VVS = 'Demo VVS';

type DemoRow = {
  maker: string;
  mpn: string;
  ean: string;
  name: string;
  desc: string;
  cat: string;
  variant: string;
  dims: string;
  material: string;
  unit: string;
  pack: string;
  price: number | null;
};

const e = (n: string) => ean13(`20${n.padStart(10, '0')}`);
const D = 'Fiktiv demovare.';

/** Samme EAN som demoens egne varer GIP-13 og VIN-90 (14 cifre med indledende nul). */
export const DEMO_GTIN = { gips: '0' + ean13('200000000013'), vinkel: '0' + ean13('200000000090') };

const V1: DemoRow[] = [
  { maker: NORD, mpn: 'DEMO-GP13-0925', ean: DEMO_GTIN.gips, name: 'Gipsplade 13 mm', desc: `Standard gipsplade til vægge og lofter. ${D}`, cat: 'Plader', variant: 'Standard', dims: '900×2500 mm', material: 'Gips', unit: 'stk.', pack: '', price: 64 },
  { maker: NORD, mpn: 'DEMO-GP13-1225', ean: e('1225'), name: 'Gipsplade 13 mm', desc: `Standard gipsplade til vægge og lofter. ${D}`, cat: 'Plader', variant: 'Standard', dims: '1200×2500 mm', material: 'Gips', unit: 'stk.', pack: '', price: 86 },
  { maker: NORD, mpn: 'DEMO-GP13-0927', ean: e('927'), name: 'Gipsplade 13 mm', desc: `Standard gipsplade til vægge og lofter. ${D}`, cat: 'Plader', variant: 'Standard', dims: '900×2700 mm', material: 'Gips', unit: 'stk.', pack: '', price: null },
  { maker: NORD, mpn: 'DEMO-GP13V-0925', ean: e('9925'), name: 'Gipsplade 13 mm', desc: `Imprægneret gipsplade til vådrum. ${D}`, cat: 'Plader', variant: 'Vådrum (grøn)', dims: '900×2500 mm', material: 'Gips', unit: 'stk.', pack: '', price: 118 },
  { maker: NORD, mpn: 'DEMO-VB90', ean: DEMO_GTIN.vinkel, name: 'Vinkelbeslag 90 mm', desc: D, cat: 'Beslag og skruer', variant: 'Galvaniseret', dims: '90×90×65 mm', material: 'Stål', unit: 'stk.', pack: '', price: null },
  { maker: NORD, mpn: 'DEMO-TS4535-200', ean: e('4535200'), name: 'Træskrue 4,5×35 mm', desc: D, cat: 'Beslag og skruer', variant: 'Forsænket hoved, gulforzinket', dims: '4,5×35 mm', material: 'Stål', unit: 'pk.', pack: '200 stk.', price: 79 },
  { maker: NORD, mpn: 'DEMO-TS4535-500', ean: e('4535500'), name: 'Træskrue 4,5×35 mm', desc: D, cat: 'Beslag og skruer', variant: 'Forsænket hoved, gulforzinket', dims: '4,5×35 mm', material: 'Stål', unit: 'pk.', pack: '500 stk.', price: 165 },
  { maker: NORD, mpn: 'DEMO-TS5050-200', ean: e('5050200'), name: 'Træskrue 5,0×50 mm', desc: D, cat: 'Beslag og skruer', variant: 'Forsænket hoved, gulforzinket', dims: '5,0×50 mm', material: 'Stål', unit: 'pk.', pack: '200 stk.', price: 99 },
  { maker: NORD, mpn: 'DEMO-RG4595', ean: '', name: 'Reglar 45×95 mm', desc: `Konstruktionstræ, høvlet. ${D}`, cat: 'Træ', variant: '', dims: '45×95 mm', material: 'Fyr C24', unit: 'm', pack: '', price: 17.5 },
  { maker: NORD, mpn: 'DEMO-FA300-H', ean: e('300101'), name: 'Fugemasse akryl 300 ml', desc: D, cat: 'Fuge og lim', variant: 'Hvid', dims: '', material: 'Akryl', unit: 'patron', pack: '', price: 29 },
  { maker: NORD, mpn: 'DEMO-FA300-G', ean: e('300102'), name: 'Fugemasse akryl 300 ml', desc: D, cat: 'Fuge og lim', variant: 'Grå', dims: '', material: 'Akryl', unit: 'patron', pack: '', price: 29 },
  { maker: NORD, mpn: 'DEMO-MU95', ean: e('95054'), name: 'Mineraluld 95 mm', desc: `Isoleringsbatts. ${D}`, cat: 'Isolering', variant: '', dims: '565×1170 mm', material: 'Stenuld', unit: 'pk.', pack: '5,4 m²', price: null },
  { maker: NORD, mpn: 'DEMO-MS228-R', ean: e('228101'), name: 'Mursten blødstrøgen', desc: D, cat: 'Mursten og blokke', variant: 'Rød', dims: '228×108×54 mm', material: 'Tegl', unit: 'stk.', pack: '', price: 6.2 },
  { maker: NORD, mpn: 'DEMO-MS228-G', ean: e('228102'), name: 'Mursten blødstrøgen', desc: D, cat: 'Mursten og blokke', variant: 'Gul', dims: '228×108×54 mm', material: 'Tegl', unit: 'stk.', pack: '', price: 5.4 },
  { maker: NORD, mpn: 'DEMO-MM-KC', ean: e('5050700'), name: 'Murermørtel KC 50/50/700', desc: D, cat: 'Mørtel og puds', variant: '', dims: '', material: '', unit: 'sæk', pack: '25 kg', price: 59 },
  { maker: VVS, mpn: 'DEMO-UK12-200', ean: e('12200'), name: 'Udekran frostsikker ½"', desc: `Frostsikker udekran med kontraventil. ${D}`, cat: 'VVS', variant: 'Længde 200 mm', dims: '200 mm', material: 'Messing', unit: 'stk.', pack: '', price: 389 },
  { maker: VVS, mpn: 'DEMO-UK12-300', ean: e('12300'), name: 'Udekran frostsikker ½"', desc: `Frostsikker udekran med kontraventil. ${D}`, cat: 'VVS', variant: 'Længde 300 mm', dims: '300 mm', material: 'Messing', unit: 'stk.', pack: '', price: 419 },
  { maker: VVS, mpn: 'DEMO-UK12-450', ean: e('12450'), name: 'Udekran frostsikker ½"', desc: `Frostsikker udekran med kontraventil. ${D}`, cat: 'VVS', variant: 'Længde 450 mm', dims: '450 mm', material: 'Messing', unit: 'stk.', pack: '', price: null },
  { maker: VVS, mpn: 'DEMO-KH12', ean: e('7012'), name: 'Kuglehane', desc: D, cat: 'VVS', variant: '½"', dims: '', material: 'Messing', unit: 'stk.', pack: '', price: 89 },
  { maker: VVS, mpn: 'DEMO-KH34', ean: e('7034'), name: 'Kuglehane', desc: D, cat: 'VVS', variant: '¾"', dims: '', material: 'Messing', unit: 'stk.', pack: '', price: 109 },
  { maker: VVS, mpn: 'DEMO-KH1', ean: e('7100'), name: 'Kuglehane', desc: D, cat: 'VVS', variant: '1"', dims: '', material: 'Messing', unit: 'stk.', pack: '', price: 149 },
  { maker: VVS, mpn: 'DEMO-PV15', ean: e('8015'), name: 'Pressfitting vinkel 90°', desc: D, cat: 'VVS', variant: '15 mm', dims: '15 mm', material: 'Kobber', unit: 'stk.', pack: '', price: 32 },
  { maker: VVS, mpn: 'DEMO-PV18', ean: e('8018'), name: 'Pressfitting vinkel 90°', desc: D, cat: 'VVS', variant: '18 mm', dims: '18 mm', material: 'Kobber', unit: 'stk.', pack: '', price: 38 },
  { maker: VVS, mpn: 'DEMO-PV22', ean: e('8022'), name: 'Pressfitting vinkel 90°', desc: D, cat: 'VVS', variant: '22 mm', dims: '22 mm', material: 'Kobber', unit: 'stk.', pack: '', price: 45 },
  { maker: VVS, mpn: 'DEMO-PEX16', ean: e('1620'), name: 'PEX-rør 16×2,0 mm', desc: `Rør til brugsvand. Sælges i ruller á 100 m. ${D}`, cat: 'VVS', variant: '', dims: '16×2,0 mm', material: 'PE-X', unit: 'm', pack: '100 m rulle', price: 9.8 },
];

/** Version 2: én pris ændret, én beskrivelse ændret, én pris tilføjet, én vare udgået, én ny og én fejl. */
const V2: DemoRow[] = [
  ...V1.filter((r) => r.mpn !== 'DEMO-KH1').map((r) =>
    r.mpn === 'DEMO-UK12-300'
      ? { ...r, price: 439 }
      : r.mpn === 'DEMO-GP13-1225'
        ? { ...r, desc: `Standard gipsplade til vægge og lofter. Nu også i 12,5 mm-kvalitet. ${D}` }
        : r.mpn === 'DEMO-GP13-0927'
          ? { ...r, price: 71 }
          : r,
  ),
  { maker: VVS, mpn: 'DEMO-KH114', ean: e('7114'), name: 'Kuglehane', desc: D, cat: 'VVS', variant: '1¼"', dims: '', material: 'Messing', unit: 'stk.', pack: '', price: 219 },
  { maker: VVS, mpn: '', ean: '', name: 'Slangetyl ½" (mangler varenummer)', desc: D, cat: 'VVS', variant: '', dims: '', material: 'Messing', unit: 'stk.', pack: '', price: 25 },
];

const HEADERS = ['Producent', 'Varenummer', 'EAN', 'Produktnavn', 'Beskrivelse', 'Varegruppe', 'Variant', 'Mål', 'Materiale', 'Enhed', 'Pakning', 'Listepris ekskl. moms', 'Valuta', 'Opdateret'];

/** Kolonneopsætningen til demofilen (samme overskrifter som i filen). */
export const DEMO_COLUMNS: Partial<Record<CatalogField, string>> = {
  manufacturer: 'Producent',
  mpn: 'Varenummer',
  ean: 'EAN',
  name: 'Produktnavn',
  description: 'Beskrivelse',
  category: 'Varegruppe',
  variant: 'Variant',
  dimensions: 'Mål',
  material: 'Materiale',
  unit: 'Enhed',
  pack_size: 'Pakning',
  price: 'Listepris ekskl. moms',
  currency: 'Valuta',
  source_updated: 'Opdateret',
};

function cells(r: DemoRow, updated: string): (string | number | null)[] {
  return [r.maker, r.mpn, r.ean, r.name, r.desc, r.cat, r.variant, r.dims, r.material, r.unit, r.pack, r.price, r.price === null ? '' : 'DKK', updated];
}

const VERSIONS = { 'v1': { rows: V1, updated: '2026-10-01' }, 'v2': { rows: V2, updated: '2026-10-15' } } as const;

/** Demofilens rækker som felter (til demoen, der indlæses ved opstart). */
export function demoRows(v: keyof typeof VERSIONS): { row_no: number; values: Record<string, unknown> }[] {
  const { rows, updated } = VERSIONS[v];
  return rows.map((r, i) => {
    const c = cells(r, updated);
    const values: Record<string, unknown> = {};
    HEADERS.forEach((h, k) => {
      const f = (Object.entries(DEMO_COLUMNS).find(([, col]) => col === h)?.[0] ?? '') as CatalogField;
      if (f) values[f] = c[k] === null ? '' : String(c[k]);
    });
    return { row_no: i + 2, values };
  });
}

// --- Filer ------------------------------------------------------------------------------------

export const DEMO_FILES = ['demokatalog-v1.csv', 'demokatalog-v1.xlsx', 'demokatalog-v2.csv', 'demokatalog-v2.xlsx'] as const;

function csv(v: keyof typeof VERSIONS): string {
  const { rows, updated } = VERSIONS[v];
  const esc = (x: string | number | null) => {
    const s = x === null ? '' : typeof x === 'number' ? x.toFixed(2).replace('.', ',') : x;
    return /[;"\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return '﻿' + [HEADERS, ...rows.map((r) => cells(r, updated))].map((row) => row.map(esc).join(';')).join('\r\n') + '\r\n';
}

const xmlEsc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function colName(i: number): string {
  let s = '';
  for (let n = i + 1; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s;
  return s;
}

function sheetXml(rows: (string | number | null)[][]): string {
  const body = rows
    .map(
      (row, r) =>
        `<row r="${r + 1}">${row
          .map((v, c) => {
            const ref = `${colName(c)}${r + 1}`;
            if (v === null || v === '') return '';
            if (typeof v === 'number') return `<c r="${ref}"><v>${v}</v></c>`;
            return `<c r="${ref}" t="inlineStr"><is><t xml:space="preserve">${xmlEsc(v)}</t></is></c>`;
          })
          .join('')}</row>`,
    )
    .join('');
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${body}</sheetData></worksheet>`;
}

let crcTable: Uint32Array | null = null;
function crc32(b: Uint8Array): number {
  if (!crcTable) {
    crcTable = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[n] = c >>> 0;
    }
  }
  let c = 0xffffffff;
  for (let i = 0; i < b.length; i++) c = crcTable[(c ^ b[i]!) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** ZIP uden komprimering (nok til et lille regneark). */
export function zipStored(files: [name: string, content: string][]): Uint8Array {
  const enc = new TextEncoder();
  const parts: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;
  for (const [name, content] of files) {
    const n = enc.encode(name);
    const data = enc.encode(content);
    const crc = crc32(data);
    const local = new Uint8Array(30 + n.length);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true);
    lv.setUint16(4, 20, true);
    lv.setUint16(8, 0, true);
    lv.setUint32(14, crc, true);
    lv.setUint32(18, data.length, true);
    lv.setUint32(22, data.length, true);
    lv.setUint16(26, n.length, true);
    local.set(n, 30);
    const cen = new Uint8Array(46 + n.length);
    const cv = new DataView(cen.buffer);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint16(4, 20, true);
    cv.setUint16(6, 20, true);
    cv.setUint32(16, crc, true);
    cv.setUint32(20, data.length, true);
    cv.setUint32(24, data.length, true);
    cv.setUint16(28, n.length, true);
    cv.setUint32(42, offset, true);
    cen.set(n, 46);
    parts.push(local, data);
    central.push(cen);
    offset += local.length + data.length;
  }
  const cdSize = central.reduce((a, c) => a + c.length, 0);
  const end = new Uint8Array(22);
  const ev = new DataView(end.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(8, files.length, true);
  ev.setUint16(10, files.length, true);
  ev.setUint32(12, cdSize, true);
  ev.setUint32(16, offset, true);
  const all = [...parts, ...central, end];
  const out = new Uint8Array(all.reduce((a, p) => a + p.length, 0));
  let o = 0;
  for (const p of all) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

/** Excel-fil med to faneblade: en forklaring og produkterne. */
export function xlsx(sheets: [name: string, rows: (string | number | null)[][]][]): Uint8Array {
  const ns = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
  return zipStored([
    [
      '[Content_Types].xml',
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>${sheets
        .map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`)
        .join('')}</Types>`,
    ],
    ['_rels/.rels', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${ns}/officeDocument" Target="xl/workbook.xml"/></Relationships>`],
    [
      'xl/workbook.xml',
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="${ns}"><sheets>${sheets
        .map(([name], i) => `<sheet name="${xmlEsc(name)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`)
        .join('')}</sheets></workbook>`,
    ],
    [
      'xl/_rels/workbook.xml.rels',
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${sheets
        .map((_, i) => `<Relationship Id="rId${i + 1}" Type="${ns}/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`)
        .join('')}</Relationships>`,
    ],
    ...sheets.map(([, rows], i): [string, string] => [`xl/worksheets/sheet${i + 1}.xml`, sheetXml(rows)]),
  ]);
}

export function demoFile(name: (typeof DEMO_FILES)[number]): { bytes: Uint8Array; type: string } {
  const v = name.includes('v2') ? 'v2' : 'v1';
  if (name.endsWith('.csv')) return { bytes: new TextEncoder().encode(csv(v)), type: 'text/csv; charset=utf-8' };
  const { rows, updated } = VERSIONS[v];
  return {
    bytes: xlsx([
      ['Om filen', [['DEMODATA – fiktive varer til afprøvning af Veyro'], ['Producenterne, varenumrene (DEMO-…), EAN-numrene (præfiks 20) og priserne er opdigtede.'], [`Version ${v}, ${updated}`]]],
      ['Produkter', [HEADERS, ...rows.map((r) => cells(r, updated))]],
    ]),
    type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  };
}

// --- Demo ved opstart ---------------------------------------------------------------------------

export const DEMO_SOURCE = 'Demokatalog (fiktive varer)';
export const KEMPER_NOTE =
  'Afventer produktfil. Ingen KEMPER-data er importeret, og der er ingen KEMPER-varenumre, EAN-numre eller priser i demoen. Filen uploades her, når adgangen og tilladelsen til brug er afklaret.';

export function demoOptions(): ImportOptions {
  return parseOptions(JSON.stringify({ columns: DEMO_COLUMNS, sheet: 'Produkter', header_row: 1, currency: 'DKK', vat: 'ekskl', price_type: 'listepris' }));
}

/** Lægger demokataloget (version 1) ind gennem den rigtige import og opretter KEMPER som tom kilde. */
export async function seedDemoCatalog(db: D1Database, actor: string, now: number): Promise<void> {
  await db.batch([
    db.prepare("INSERT INTO catalog_sources (name, kind, manufacturer, note, created_by, created_at) VALUES (?, 'demo', '', ?, ?, ?)").bind(DEMO_SOURCE, 'Fiktive varer fra de opdigtede producenter Nordlys Demo og Demo VVS.', actor, now),
    db.prepare("INSERT INTO catalog_sources (name, kind, manufacturer, note, created_by, created_at) VALUES ('KEMPER', 'producent', 'KEMPER', ?, ?, ?)").bind(KEMPER_NOTE, actor, now),
  ]);
  const src = (await db.prepare('SELECT id FROM catalog_sources WHERE name = ?').bind(DEMO_SOURCE).first<{ id: number }>())!;
  const id = await createImport(db, src.id, 'demokatalog-v1.xlsx', demoOptions(), actor, now);
  await stageRows(db, (await getImport(db, id))!, demoRows('v1'));
  await approveImport(db, await finishUpload(db, (await getImport(db, id))!), actor, now, { demo: true });
  // Demoens egne varer med samme EAN knyttes til katalogvarerne (lagerbeholdningen er uændret)
  await db.batch(
    [DEMO_GTIN.gips, DEMO_GTIN.vinkel].map((g) =>
      db
        .prepare("UPDATE products SET catalog_product_id = (SELECT id FROM catalog_products WHERE source_id = ?1 AND gtin = ?2) WHERE ean = ?2 AND catalog_product_id IS NULL")
        .bind(src.id, g),
    ),
  );
}

// --- Belastningstest ------------------------------------------------------------------------------

export const LOAD_SOURCE = 'DEMO-belastningstest (syntetiske varer)';
const LOAD_WORDS = ['skrue', 'plade', 'bjælke', 'fliser', 'kabel', 'beslag', 'isolering', 'maling', 'fugemasse', 'rør'];

export async function loadTestCount(db: D1Database): Promise<number> {
  const r = await db.prepare('SELECT COUNT(*) AS n FROM catalog_products c JOIN catalog_sources s ON s.id = c.source_id WHERE s.name = ?').bind(LOAD_SOURCE).first<{ n: number }>();
  return r?.n ?? 0;
}

/**
 * 10.000 syntetiske testvarer med egne DEMO-ID'er (DEMO-LT-00001 …) i en separat kilde. De
 * genereres i databasen med én SQL-sætning, så de ikke ligner eller blandes med producentdata.
 */
export async function loadTestProducts(db: D1Database, actor: string, now: number, n = 10_000): Promise<number> {
  await db
    .prepare("INSERT INTO catalog_sources (name, kind, manufacturer, note, created_by, created_at) VALUES (?, 'demo', 'DEMO Belastningstest', ?, ?, ?) ON CONFLICT(name) DO NOTHING")
    .bind(LOAD_SOURCE, 'Syntetiske testvarer til at måle søgningen med mange produkter. Ikke rigtige varer.', actor, now)
    .run();
  const src = (await db.prepare('SELECT id FROM catalog_sources WHERE name = ?').bind(LOAD_SOURCE).first<{ id: number }>())!;
  if (await loadTestCount(db)) return loadTestCount(db);
  const words = LOAD_WORDS.map((w, i) => `(${i}, '${w}')`).join(', ');
  const name = `'Syntetisk testvare ' || w.word || ' ' || (i % 97 + 3) || ' mm'`;
  const nameKey = `'syntetisk testvare ' || w.word || ' ' || (i % 97 + 3) || ' mm'`;
  await db.batch([
    db
      .prepare(
        `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ?3), w(k, word) AS (VALUES ${words})
         INSERT INTO catalog_products (source_id, manufacturer, maker_key, mpn, mpn_key, name, category, variant, unit, search_text, name_key, status, is_demo, imported_at, updated_at, created_at)
         SELECT ?1, 'DEMO Belastningstest', 'demo belastningstest', 'DEMO-LT-' || printf('%05d', i), 'DEMO-LT-' || printf('%05d', i), ${name},
           'Testvarer ' || (i % 20 + 1), 'Variant ' || (i % 7 + 1), 'stk.',
           ${nameKey} || ' variant ' || (i % 7 + 1) || ' testvarer ' || (i % 20 + 1) || ' demo belastningstest demo lt ' || printf('%05d', i),
           ${nameKey}, 'aktiv', 1, ?2, ?2, ?2
         FROM n JOIN w ON w.k = i % 10`,
      )
      .bind(src.id, now, n),
    db.prepare('INSERT OR IGNORE INTO catalog_words (word) SELECT value FROM json_each(?)').bind(JSON.stringify(['syntetisk', 'testvare', 'testvarer', 'variant', 'belastningstest', ...LOAD_WORDS])),
  ]);
  return loadTestCount(db);
}

export async function removeLoadTest(db: D1Database): Promise<void> {
  const ids = `(SELECT c.id FROM catalog_products c JOIN catalog_sources s ON s.id = c.source_id WHERE s.name = ?1)`;
  await db.batch([
    // Job og varekartotek bevares; kun henvisningen til testvaren fjernes
    db.prepare(`UPDATE products SET catalog_product_id = NULL WHERE catalog_product_id IN ${ids}`).bind(LOAD_SOURCE),
    db.prepare(`UPDATE job_items SET catalog_product_id = NULL WHERE catalog_product_id IN ${ids}`).bind(LOAD_SOURCE),
    db.prepare(`DELETE FROM catalog_prices WHERE catalog_product_id IN ${ids}`).bind(LOAD_SOURCE),
    db.prepare(`DELETE FROM catalog_products WHERE id IN ${ids}`).bind(LOAD_SOURCE),
  ]);
}
