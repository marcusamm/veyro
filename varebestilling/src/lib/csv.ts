// CSV-import af varelister. Virker med eksport fra Excel (semikolon), Google Sheets (komma)
// og de fleste kasse-/lagersystemer. Kolonnenavne kan være på dansk eller engelsk.
import { oereToInput, parseIntStrict, parseKr, str } from './format';
import type { ProductRow } from '../env';
import { skuValid } from './products';

export const MAX_IMPORT_BYTES = 2_000_000;
export const MAX_IMPORT_ROWS = 5000;

/** Deler CSV-tekst op i rækker og felter (RFC 4180: citationstegn, "" og linjeskift i felter). */
export function parseCsv(text: string, delimiter?: string): string[][] {
  text = text.replace(/^﻿/, '');
  const d = delimiter ?? detectDelimiter(text);
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else quoted = false;
      } else field += ch;
    } else if (ch === '"' && field === '') {
      quoted = true;
    } else if (ch === d) {
      row.push(field);
      field = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else field += ch;
  }
  if (field !== '' || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((r) => r.some((f) => f.trim() !== ''));
}

/** Gætter separatoren ud fra første linje: den af ; , tab | der optræder flest gange uden for citationstegn. */
export function detectDelimiter(text: string): string {
  const first = text.split(/\r?\n/, 1)[0] ?? '';
  let best = ';';
  let bestCount = 0;
  for (const d of [';', ',', '\t', '|']) {
    let n = 0;
    let q = false;
    for (const ch of first) {
      if (ch === '"') q = !q;
      else if (!q && ch === d) n++;
    }
    if (n > bestCount) {
      best = d;
      bestCount = n;
    }
  }
  return best;
}

export type Field =
  | 'sku'
  | 'name'
  | 'category'
  | 'price'
  | 'stock'
  | 'unit'
  | 'description'
  | 'image_url'
  | 'low_stock_threshold'
  | 'active'
  | 'track_stock'
  | 'sort_order';

/** Kolonnenavne, der genkendes (små bogstaver, uden tegnsætning). */
const ALIASES: Record<Field, string[]> = {
  sku: ['sku', 'varenummer', 'varenr', 'vare nr', 'varenr', 'artikelnummer', 'artikelnr', 'produktnummer', 'item number'],
  name: ['navn', 'varenavn', 'produkt', 'produktnavn', 'vare', 'titel', 'name', 'title', 'product'],
  category: ['kategori', 'varegruppe', 'gruppe', 'category'],
  price: ['pris', 'salgspris', 'pris inkl moms', 'pris kr', 'enhedspris', 'price', 'unit price'],
  stock: ['lager', 'antal', 'beholdning', 'lagerantal', 'på lager', 'paa lager', 'lagerbeholdning', 'stock', 'quantity', 'qty', 'inventory'],
  unit: ['enhed', 'unit'],
  description: ['beskrivelse', 'tekst', 'description'],
  image_url: ['billede', 'billede url', 'billedurl', 'billedlink', 'image', 'image url', 'image_url'],
  low_stock_threshold: ['minimum', 'minimumslager', 'lavt lager', 'lav lager', 'advarsel ved', 'genbestillingspunkt', 'low stock', 'low_stock_threshold'],
  active: ['aktiv', 'synlig', 'vis', 'vis i shop', 'active', 'visible'],
  track_stock: ['lagerstyring', 'følg lager', 'track stock', 'track_stock'],
  sort_order: ['sortering', 'rækkefølge', 'sort', 'sort order', 'position'],
};

export const FIELD_LABEL: Record<Field, string> = {
  sku: 'Varenummer',
  name: 'Navn',
  category: 'Kategori',
  price: 'Pris',
  stock: 'Lager',
  unit: 'Enhed',
  description: 'Beskrivelse',
  image_url: 'Billede',
  low_stock_threshold: 'Minimum',
  active: 'Aktiv',
  track_stock: 'Lagerstyring',
  sort_order: 'Sortering',
};

function normHeader(h: string): string {
  return h
    .toLowerCase()
    .replace(/\(.*?\)/g, ' ')
    .replace(/[._:\-–#*]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function mapHeaders(headers: string[]): { map: Partial<Record<Field, number>>; unknown: string[] } {
  const map: Partial<Record<Field, number>> = {};
  const unknown: string[] = [];
  headers.forEach((h, i) => {
    const n = normHeader(h);
    const field = (Object.keys(ALIASES) as Field[]).find((f) => ALIASES[f].some((a) => normHeader(a) === n));
    if (field && map[field] === undefined) map[field] = i;
    else if (h.trim()) unknown.push(h.trim());
  });
  return { map, unknown };
}

function parseBool(raw: string): boolean | null {
  const v = raw.trim().toLowerCase();
  if (['1', 'ja', 'j', 'yes', 'y', 'true', 'sand', 'x', 'aktiv'].includes(v)) return true;
  if (['0', 'nej', 'n', 'no', 'false', 'falsk', 'inaktiv', 'skjult'].includes(v)) return false;
  return null;
}

/** En gyldig importrække. Felter, der ikke er med i filen, er undefined (= behold eksisterende værdi). */
export interface ImportRow {
  line: number;
  sku: string;
  name?: string;
  category?: string;
  price?: number;
  stock?: number;
  unit?: string;
  description?: string;
  image_url?: string;
  low_stock_threshold?: number | null;
  active?: boolean;
  track_stock?: boolean;
  sort_order?: number;
}

export interface ImportError {
  line: number;
  message: string;
}

export interface ParsedImport {
  rows: ImportRow[];
  errors: ImportError[];
  columns: Field[];
  unknownColumns: string[];
}

/** Læser og validerer en CSV-vareliste. Første række skal være kolonnenavne. */
export function parseImport(text: string): ParsedImport {
  const all = parseCsv(text);
  const errors: ImportError[] = [];
  if (all.length < 2) return { rows: [], errors: [{ line: 1, message: 'Filen skal have en række med kolonnenavne og mindst én vare.' }], columns: [], unknownColumns: [] };
  const { map, unknown } = mapHeaders(all[0]!);
  const columns = (Object.keys(map) as Field[]).sort((a, b) => map[a]! - map[b]!);
  if (map.sku === undefined) {
    return { rows: [], errors: [{ line: 1, message: 'Der mangler en kolonne med varenummer (fx "Varenummer" eller "SKU").' }], columns, unknownColumns: unknown };
  }
  if (all.length - 1 > MAX_IMPORT_ROWS) {
    return { rows: [], errors: [{ line: 1, message: `Filen har for mange rækker (højst ${MAX_IMPORT_ROWS} ad gangen).` }], columns, unknownColumns: unknown };
  }

  const rows: ImportRow[] = [];
  const seen = new Map<string, number>();
  for (let i = 1; i < all.length; i++) {
    const r = all[i]!;
    const line = i + 1;
    const get = (f: Field): string | undefined => (map[f] === undefined ? undefined : (r[map[f]!] ?? '').trim());
    const err = (message: string) => errors.push({ line, message });

    const sku = str(get('sku'), 64);
    if (!sku) {
      err('Varenummer mangler.');
      continue;
    }
    if (!skuValid(sku)) {
      err(`Varenummer "${sku}" må kun indeholde bogstaver, tal og - _ . / +`);
      continue;
    }
    const key = sku.toLowerCase();
    if (seen.has(key)) {
      err(`Varenummer "${sku}" står også i linje ${seen.get(key)}.`);
      continue;
    }
    seen.set(key, line);

    const row: ImportRow = { line, sku };
    let bad = false;
    const name = get('name');
    if (name !== undefined) row.name = str(name, 200);
    const category = get('category');
    if (category !== undefined) row.category = str(category, 80);
    const unit = get('unit');
    if (unit !== undefined && unit !== '') row.unit = str(unit, 20);
    const desc = get('description');
    if (desc !== undefined) row.description = str(desc, 2000, { multiline: true });
    const img = get('image_url');
    if (img !== undefined) {
      if (img && !/^https:\/\/[^\s<>"']+$/i.test(img)) {
        err('Billede skal være et link, der starter med https://');
        bad = true;
      } else row.image_url = img.slice(0, 500);
    }
    const price = get('price');
    if (price !== undefined && price !== '') {
      const v = parseKr(price);
      if (v === null) {
        err(`Prisen "${price}" kan ikke læses. Skriv fx 149,95`);
        bad = true;
      } else row.price = v;
    }
    const stock = get('stock');
    if (stock !== undefined && stock !== '') {
      const v = parseIntStrict(stock);
      if (v === null) {
        err(`Lager "${stock}" skal være et helt tal på 0 eller mere.`);
        bad = true;
      } else row.stock = v;
    }
    const low = get('low_stock_threshold');
    if (low !== undefined) {
      if (low === '') row.low_stock_threshold = null;
      else {
        const v = parseIntStrict(low);
        if (v === null) {
          err(`Minimum "${low}" skal være et helt tal.`);
          bad = true;
        } else row.low_stock_threshold = v;
      }
    }
    const sort = get('sort_order');
    if (sort !== undefined && sort !== '') {
      const v = parseIntStrict(sort, { signed: true, max: 1_000_000 });
      if (v === null) {
        err(`Sortering "${sort}" skal være et helt tal.`);
        bad = true;
      } else row.sort_order = v;
    }
    for (const f of ['active', 'track_stock'] as const) {
      const raw = get(f);
      if (raw !== undefined && raw !== '') {
        const v = parseBool(raw);
        if (v === null) {
          err(`${FIELD_LABEL[f]} "${raw}" skal være ja eller nej.`);
          bad = true;
        } else row[f] = v;
      }
    }
    if (!bad) rows.push(row);
  }
  return { rows, errors, columns, unknownColumns: unknown };
}

export interface PlannedRow extends ImportRow {
  action: 'opret' | 'opdater' | 'uændret';
  existing?: ProductRow;
}

/** Sammenholder importen med eksisterende varer og validerer krav til nye varer (navn og pris). */
export function planImport(parsed: ParsedImport, existing: Map<string, ProductRow>): { planned: PlannedRow[]; errors: ImportError[] } {
  const errors = [...parsed.errors];
  const planned: PlannedRow[] = [];
  for (const r of parsed.rows) {
    const ex = existing.get(r.sku.toLowerCase());
    if (!ex) {
      if (!r.name) {
        errors.push({ line: r.line, message: `Ny vare "${r.sku}" mangler navn.` });
        continue;
      }
      if (r.price === undefined) {
        errors.push({ line: r.line, message: `Ny vare "${r.sku}" mangler pris.` });
        continue;
      }
      planned.push({ ...r, action: 'opret' });
      continue;
    }
    if (r.name === '') {
      errors.push({ line: r.line, message: `Navn på "${r.sku}" må ikke være tomt.` });
      continue;
    }
    const changed =
      (r.name !== undefined && r.name !== ex.name) ||
      (r.category !== undefined && r.category !== ex.category) ||
      (r.price !== undefined && r.price !== ex.price) ||
      (r.stock !== undefined && r.stock !== ex.stock) ||
      (r.unit !== undefined && r.unit !== ex.unit) ||
      (r.description !== undefined && r.description !== ex.description) ||
      (r.image_url !== undefined && r.image_url !== ex.image_url) ||
      (r.low_stock_threshold !== undefined && r.low_stock_threshold !== ex.low_stock_threshold) ||
      (r.active !== undefined && (r.active ? 1 : 0) !== ex.active) ||
      (r.track_stock !== undefined && (r.track_stock ? 1 : 0) !== ex.track_stock) ||
      (r.sort_order !== undefined && r.sort_order !== ex.sort_order);
    planned.push({ ...r, action: changed ? 'opdater' : 'uændret', existing: ex });
  }
  errors.sort((a, b) => a.line - b.line);
  return { planned, errors };
}

/** CSV-felt med citationstegn, når det er nødvendigt. Felter, der starter med = + @ (eller - uden tal), beskyttes mod formler i Excel. */
function csvField(v: string, d: string): string {
  let s = v;
  if (/^[=+@\t\r]|^-(?!\d)/.test(s)) s = "'" + s;
  return /["\n\r]/.test(s) || s.includes(d) ? `"${s.replace(/"/g, '""')}"` : s;
}

export const EXPORT_HEADERS = ['Varenummer', 'Navn', 'Kategori', 'Pris', 'Lager', 'Enhed', 'Beskrivelse', 'Billede', 'Minimum', 'Aktiv', 'Lagerstyring', 'Sortering'];

/** Eksport i samme format som importen (semikolon, så den åbner direkte i dansk Excel). */
export function exportCsv(products: ProductRow[]): string {
  const d = ';';
  const lines = [EXPORT_HEADERS.join(d)];
  for (const p of products) {
    lines.push(
      [
        p.sku,
        p.name,
        p.category,
        oereToInput(p.price),
        String(p.stock),
        p.unit,
        p.description,
        p.image_url,
        p.low_stock_threshold === null ? '' : String(p.low_stock_threshold),
        p.active ? 'ja' : 'nej',
        p.track_stock ? 'ja' : 'nej',
        String(p.sort_order),
      ]
        .map((v) => csvField(v, d))
        .join(d),
    );
  }
  return '﻿' + lines.join('\r\n') + '\r\n';
}

export const TEMPLATE_CSV =
  '﻿' +
  [
    EXPORT_HEADERS.join(';'),
    'A-100;Eksempelvare;Kategori 1;149,95;25;stk.;Kort beskrivelse af varen;;5;ja;ja;1',
    'A-101;Vare uden lagerstyring;Kategori 1;499;;stk.;Fx en ydelse eller en vare, der altid kan bestilles;;;ja;nej;2',
  ].join('\r\n') +
  '\r\n';
