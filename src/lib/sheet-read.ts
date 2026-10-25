// Læser regneark (.xlsx og .csv) som rene data: alle celler bliver tekst. Formler beregnes aldrig (kun den gemte
// værdi i filen læses), makroer afvises, og XML læses uden DTD'er eller eksterne entiteter. Ingen afhængigheder.

export const SHEET_LIMITS = { maxRows: 5000, maxCols: 50, maxCell: 8000, maxUnzipped: 40_000_000, maxEntry: 25_000_000, maxEntries: 2000 } as const;

export class SheetError extends Error {}

export interface Sheet {
  name: string;
  hidden: boolean;
  rows: string[][];
  formulas: number; // celler med en formel (kun den gemte værdi er brugt)
  truncated: boolean; // flere rækker end SHEET_LIMITS.maxRows
}

// ---------- CSV ----------

const CP1252: Record<number, number> = {
  0x80: 0x20ac, 0x82: 0x201a, 0x83: 0x0192, 0x84: 0x201e, 0x85: 0x2026, 0x86: 0x2020, 0x87: 0x2021, 0x88: 0x02c6, 0x89: 0x2030, 0x8a: 0x0160,
  0x8b: 0x2039, 0x8c: 0x0152, 0x8e: 0x017d, 0x91: 0x2018, 0x92: 0x2019, 0x93: 0x201c, 0x94: 0x201d, 0x95: 0x2022, 0x96: 0x2013, 0x97: 0x2014,
  0x98: 0x02dc, 0x99: 0x2122, 0x9a: 0x0161, 0x9b: 0x203a, 0x9c: 0x0153, 0x9e: 0x017e, 0x9f: 0x0178,
};

/** Tekst fra en CSV-fil: UTF-8 (med eller uden BOM), UTF-16 med BOM, ellers Windows-1252 (ældre Excel på dansk). */
export function decodeText(b: Uint8Array): { text: string; encoding: string } {
  if ((b[0] === 0xff && b[1] === 0xfe) || (b[0] === 0xfe && b[1] === 0xff)) return { text: utf16(b.subarray(2), b[0] === 0xff), encoding: 'UTF-16' };
  const body = b[0] === 0xef && b[1] === 0xbb && b[2] === 0xbf ? b.subarray(3) : b;
  try {
    return { text: new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(body), encoding: 'UTF-8' };
  } catch {
    let s = '';
    for (const x of body) s += String.fromCharCode(CP1252[x] ?? x);
    return { text: s, encoding: 'Windows-1252' };
  }
}

function utf16(b: Uint8Array, le: boolean): string {
  const parts: string[] = [];
  for (let i = 0; i + 1 < b.length; i += 8192) {
    const codes: number[] = [];
    for (let j = i; j + 1 < Math.min(b.length, i + 8192); j += 2) codes.push(le ? b[j]! | (b[j + 1]! << 8) : (b[j]! << 8) | b[j + 1]!);
    parts.push(String.fromCharCode(...codes));
  }
  return parts.join('');
}

export type Delimiter = ',' | ';' | '\t';
export const DELIMITERS: Delimiter[] = [';', ',', '\t'];
export const DELIMITER_LABEL: Record<Delimiter, string> = { ',': 'Komma', ';': 'Semikolon', '\t': 'Tabulator' };

/** RFC 4180-parser: anførselstegn, "" inde i felter, linjeskift i felter, CRLF/LF/CR. */
export function parseCsv(text: string, delim: Delimiter, maxRows = SHEET_LIMITS.maxRows + 1): { rows: string[][]; truncated: boolean } {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  let i = 0;
  let line = 0;
  const n = text.length;
  const endRow = () => {
    row.push(field);
    field = '';
    line++;
    if (row.length > 1 || row[0]!.trim() !== '') {
      (row as NumberedRow).r = line;
      rows.push(row);
    }
    row = [];
  };
  while (i < n) {
    const ch = text[i]!;
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        quoted = false;
        i++;
        continue;
      }
      field += ch;
      i++;
      continue;
    }
    if (ch === '"' && field === '') {
      quoted = true;
      i++;
    } else if (ch === delim) {
      row.push(field);
      field = '';
      i++;
    } else if (ch === '\r' || ch === '\n') {
      endRow();
      if (rows.length >= maxRows) return { rows, truncated: i + 1 < n && text.slice(i).trim() !== '' };
      i += ch === '\r' && text[i + 1] === '\n' ? 2 : 1;
    } else {
      field += ch;
      i++;
    }
  }
  if (field !== '' || row.length) endRow();
  return { rows, truncated: false };
}

/** Gætter skilletegnet: det, der giver flest kolonner med et ensartet antal på de første linjer. */
export function detectDelimiter(text: string): Delimiter {
  const sample = text.slice(0, 20000);
  let best: Delimiter = ',';
  let bestScore = 0;
  for (const d of DELIMITERS) {
    const { rows } = parseCsv(sample, d, 30);
    if (!rows.length) continue;
    const width = rows[0]!.length;
    if (width < 2) continue;
    const same = rows.filter((r) => r.length === width).length / rows.length;
    const score = same * 10 + Math.min(width, 10);
    if (score > bestScore) {
      bestScore = score;
      best = d;
    }
  }
  return best;
}

export function readCsv(bytes: Uint8Array, delim?: Delimiter): { sheet: Sheet; delimiter: Delimiter; encoding: string } {
  if (bytes.includes(0) && !(bytes[0] === 0xff || bytes[0] === 0xfe)) throw new SheetError('Filen ligner ikke en tekstfil (CSV). Gem den som CSV eller .xlsx og prøv igen.');
  const { text, encoding } = decodeText(bytes);
  const d = delim ?? detectDelimiter(text);
  const { rows, truncated } = parseCsv(text, d);
  return { sheet: { name: 'CSV', hidden: false, rows: rows.map((r) => cleanRowKeep(r, (r as NumberedRow).r ?? 0)), formulas: 0, truncated }, delimiter: d, encoding };
}

function cleanRow(r: string[]): string[] {
  return r.slice(0, SHEET_LIMITS.maxCols).map((v) => v.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '').slice(0, SHEET_LIMITS.maxCell));
}

// ---------- ZIP (til .xlsx) ----------

interface ZipEntry {
  name: string;
  method: number;
  csize: number;
  usize: number;
  offset: number;
}

const u16 = (b: Uint8Array, o: number) => b[o]! | (b[o + 1]! << 8);
const u32 = (b: Uint8Array, o: number) => (b[o]! | (b[o + 1]! << 8) | (b[o + 2]! << 16)) + b[o + 3]! * 0x1000000;

export function isZip(b: Uint8Array): boolean {
  return b.length > 22 && b[0] === 0x50 && b[1] === 0x4b && b[2] === 0x03 && b[3] === 0x04;
}

function zipEntries(b: Uint8Array): Map<string, ZipEntry> {
  let eocd = -1;
  for (let i = b.length - 22; i >= Math.max(0, b.length - 65557); i--) {
    if (b[i] === 0x50 && b[i + 1] === 0x4b && b[i + 2] === 0x05 && b[i + 3] === 0x06) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new SheetError('Excel-filen er beskadiget eller ikke en .xlsx-fil.');
  const count = u16(b, eocd + 10);
  let p = u32(b, eocd + 16);
  if (count > SHEET_LIMITS.maxEntries || count === 0xffff || p === 0xffffffff) throw new SheetError('Excel-filen har et format, der ikke understøttes.');
  const dec = new TextDecoder();
  const out = new Map<string, ZipEntry>();
  let total = 0;
  for (let k = 0; k < count; k++) {
    if (p + 46 > b.length || u32(b, p) !== 0x02014b50) throw new SheetError('Excel-filen er beskadiget.');
    const flags = u16(b, p + 8);
    const method = u16(b, p + 10);
    const csize = u32(b, p + 20);
    const usize = u32(b, p + 24);
    const nlen = u16(b, p + 28);
    const xlen = u16(b, p + 30);
    const clen = u16(b, p + 32);
    const offset = u32(b, p + 42);
    const name = dec.decode(b.subarray(p + 46, p + 46 + nlen));
    if (flags & 1) throw new SheetError('Excel-filen er beskyttet med adgangskode. Fjern beskyttelsen og prøv igen.');
    total += usize;
    if (usize > SHEET_LIMITS.maxEntry || total > SHEET_LIMITS.maxUnzipped) throw new SheetError('Excel-filen fylder for meget, når den pakkes ud.');
    out.set(name, { name, method, csize, usize, offset });
    p += 46 + nlen + xlen + clen;
  }
  return out;
}

async function unzip(b: Uint8Array, e: ZipEntry): Promise<Uint8Array> {
  const p = e.offset;
  if (p + 30 > b.length || u32(b, p) !== 0x04034b50) throw new SheetError('Excel-filen er beskadiget.');
  const start = p + 30 + u16(b, p + 26) + u16(b, p + 28);
  const data = b.subarray(start, start + e.csize);
  if (data.length !== e.csize) throw new SheetError('Excel-filen er beskadiget.');
  if (e.method === 0) return data;
  if (e.method !== 8) throw new SheetError('Excel-filen bruger en komprimering, der ikke understøttes.');
  // Pakkes ud i strømme med et loft, så en "zip-bombe" ikke kan fylde hukommelsen
  const stream = new Blob([data]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
  const reader = stream.getReader();
  const parts: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    let r: ReadableStreamReadResult<Uint8Array>;
    try {
      r = await reader.read();
    } catch {
      throw new SheetError('Excel-filen er beskadiget.');
    }
    if (r.done) break;
    size += r.value.length;
    if (size > Math.max(e.usize, 1) || size > SHEET_LIMITS.maxEntry) {
      await reader.cancel().catch(() => {});
      throw new SheetError('Excel-filen fylder for meget, når den pakkes ud.');
    }
    parts.push(r.value);
  }
  const out = new Uint8Array(size);
  let o = 0;
  for (const x of parts) {
    out.set(x, o);
    o += x.length;
  }
  return out;
}

// ---------- XML (SpreadsheetML) ----------

function unescapeXml(s: string): string {
  return s
    .replace(/&(#x[0-9a-fA-F]+|#\d+|amp|lt|gt|quot|apos);/g, (m, g: string) => {
      if (g[0] === '#') {
        const cp = g[1] === 'x' ? parseInt(g.slice(2), 16) : parseInt(g.slice(1), 10);
        return cp > 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : '';
      }
      return ({ amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" } as Record<string, string>)[g] ?? m;
    })
    .replace(/_x([0-9A-Fa-f]{4})_/g, (_, h: string) => String.fromCharCode(parseInt(h, 16)));
}

function attr(tag: string, name: string): string | null {
  const m = new RegExp(`(?:^|\\s)${name}\\s*=\\s*("([^"]*)"|'([^']*)')`).exec(tag);
  return m ? unescapeXml(m[2] ?? m[3] ?? '') : null;
}

/** Al tekst i <t>-elementer (uden fonetiske hjælpetekster <rPh>) */
function textOf(xml: string): string {
  const noPh = xml.replace(/<rPh\b[\s\S]*?<\/rPh>/g, '');
  let s = '';
  for (const m of noPh.matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>|<t\b[^>]*\/>/g)) s += m[1] ? unescapeXml(m[1]) : '';
  return s;
}

const xmlDecoder = new TextDecoder('utf-8');

function safeXml(b: Uint8Array): string {
  const s = xmlDecoder.decode(b);
  if (/<!DOCTYPE|<!ENTITY/i.test(s)) throw new SheetError('Excel-filen indeholder elementer, der ikke er tilladt.');
  return s;
}

function colIndex(ref: string): number {
  const m = /^([A-Z]+)/.exec(ref);
  if (!m) return -1;
  let n = 0;
  for (const ch of m[1]!) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

/** Tal som tekst uden eksponent (fx telefonnumre gemt som tal) */
function numText(v: string): string {
  if (!/[eE]/.test(v)) return v;
  const n = Number(v);
  if (!Number.isFinite(n)) return v;
  return n.toLocaleString('en-US', { useGrouping: false, maximumFractionDigits: 10 });
}

export interface Workbook {
  sheets: { name: string; hidden: boolean; path: string }[];
  load(index: number): Promise<Sheet>;
}

export async function readXlsx(bytes: Uint8Array): Promise<Workbook> {
  if (!isZip(bytes)) throw new SheetError('Filen er ikke en gyldig Excel-fil (.xlsx).');
  const entries = zipEntries(bytes);
  const has = (n: string) => entries.has(n);
  if (!has('[Content_Types].xml') || !has('xl/workbook.xml')) throw new SheetError('Filen er ikke en Excel-projektmappe (.xlsx).');
  if (has('xl/vbaProject.bin') || [...entries.keys()].some((k) => /vbaProject|\.bin$/i.test(k) && !/printerSettings/i.test(k))) {
    throw new SheetError('Filen indeholder makroer. Gem den som almindelig Excel-projektmappe (.xlsx) eller CSV og prøv igen.');
  }
  const types = safeXml(await unzip(bytes, entries.get('[Content_Types].xml')!));
  if (/macroEnabled/i.test(types)) throw new SheetError('Filen indeholder makroer. Gem den som almindelig Excel-projektmappe (.xlsx) eller CSV og prøv igen.');
  const wb = safeXml(await unzip(bytes, entries.get('xl/workbook.xml')!));
  const rels = has('xl/_rels/workbook.xml.rels') ? safeXml(await unzip(bytes, entries.get('xl/_rels/workbook.xml.rels')!)) : '';
  const target = new Map<string, string>();
  for (const m of rels.matchAll(/<Relationship\b([^>]*)\/?>/g)) {
    const id = attr(m[1]!, 'Id');
    const t = attr(m[1]!, 'Target');
    if (id && t) target.set(id, t.startsWith('/') ? t.slice(1) : `xl/${t.replace(/^\.\//, '')}`);
  }
  const sheets: Workbook['sheets'] = [];
  for (const m of wb.matchAll(/<sheet\b([^>]*)\/?>/g)) {
    const name = attr(m[1]!, 'name') ?? `Ark ${sheets.length + 1}`;
    const rid = attr(m[1]!, 'r:id') ?? attr(m[1]!, 'id');
    const path = (rid && target.get(rid)) || `xl/worksheets/sheet${sheets.length + 1}.xml`;
    if (!has(path)) continue; // fx diagramark uden celler
    sheets.push({ name, hidden: /hidden/i.test(attr(m[1]!, 'state') ?? ''), path });
  }
  if (!sheets.length) throw new SheetError('Excel-filen indeholder ingen ark med data.');
  let shared: string[] | null = null;
  const sharedStrings = async () => {
    if (shared) return shared;
    shared = [];
    const e = entries.get('xl/sharedStrings.xml');
    if (e) for (const m of safeXml(await unzip(bytes, e)).matchAll(/<si\b[^>]*>([\s\S]*?)<\/si>|<si\b[^>]*\/>/g)) shared.push(m[1] ? textOf(m[1]) : '');
    return shared;
  };
  return {
    sheets,
    async load(index: number): Promise<Sheet> {
      const s = sheets[index];
      if (!s) throw new SheetError('Arket findes ikke.');
      const ss = await sharedStrings();
      const xml = safeXml(await unzip(bytes, entries.get(s.path)!));
      const rows: string[][] = [];
      let formulas = 0;
      let truncated = false;
      let lastRow = 0;
      for (const rm of xml.matchAll(/<row\b([^>]*?)(?:\/>|>([\s\S]*?)<\/row>)/g)) {
        const rIdx = Number(attr(rm[1]!, 'r')) || lastRow + 1;
        lastRow = rIdx;
        const cells: string[] = [];
        let next = 0;
        for (const cm of (rm[2] ?? '').matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
          const a = cm[1]!;
          const inner = cm[2] ?? '';
          const ref = attr(a, 'r');
          const ci = ref ? colIndex(ref) : next;
          next = ci + 1;
          if (ci < 0 || ci >= SHEET_LIMITS.maxCols) continue;
          const t = attr(a, 't') ?? 'n';
          if (/<f\b/.test(inner)) formulas++;
          const v = /<v\b[^>]*>([\s\S]*?)<\/v>/.exec(inner)?.[1];
          let val = '';
          if (t === 's') val = v !== undefined ? (ss[Number(v)] ?? '') : '';
          else if (t === 'inlineStr') val = textOf(/<is\b[^>]*>([\s\S]*?)<\/is>/.exec(inner)?.[1] ?? '');
          else if (t === 'b') val = v === '1' ? 'SAND' : v === '0' ? 'FALSK' : '';
          else if (t === 'e') val = '';
          else if (t === 'str') val = v !== undefined ? unescapeXml(v) : '';
          else val = v !== undefined ? numText(unescapeXml(v).trim()) : '';
          while (cells.length < ci) cells.push('');
          cells[ci] = val;
        }
        if (!cells.some((x) => x.trim() !== '')) continue;
        // Tomme rækker springes over; rækkenummeret i arket gemmes til fejlbeskeder
        rows.push(cleanRowKeep(cells, rIdx));
        if (rows.length > SHEET_LIMITS.maxRows) {
          truncated = true;
          break;
        }
      }
      return { name: s.name, hidden: s.hidden, rows, formulas, truncated };
    },
  };
}

/** Rækkenummer i arket (1-baseret) gemmes på rækken, så fejl kan henvise til den rigtige række i Excel */
export type NumberedRow = string[] & { r?: number };

function cleanRowKeep(r: string[], rIdx: number): NumberedRow {
  const out = cleanRow(r) as NumberedRow;
  out.r = rIdx;
  return out;
}
