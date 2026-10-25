// Import af kundeemner fra Excel (.xlsx) og CSV. Originalfilen gemmes i databasen, indtil den slettes med "Slet fil".
// Intet oprettes før bekræftelse, eksisterende kundeemner overskrives aldrig, og der sendes ingen mails og oprettes
// ingen kunder. Hvert oprettet kundeemne får import_id og import_row, så en import kan fortrydes sikkert.
import { nowSec } from './crypto';
import { normalizeEmail } from './db';
import { companyDomain, normName, normWebsite, today } from './prospects';
import { DELIMITERS, SheetError, readCsv, readXlsx, type Delimiter, type NumberedRow } from './sheet-read';

export const MAX_IMPORT_FILE = 5_000_000;
const CHUNK = 900_000; // under D1's grænse på ca. 2 MB pr. række

export const IMPORT_FIELDS = ['company', 'contact_name', 'email', 'phone', 'website', 'city', 'notes'] as const;
export type ImportField = (typeof IMPORT_FIELDS)[number];
export const IMPORT_FIELD_LABEL: Record<ImportField, string> = {
  company: 'Virksomhedsnavn',
  contact_name: 'Kontaktperson',
  email: 'E-mail',
  phone: 'Telefonnummer',
  website: 'Hjemmeside',
  city: 'By/område',
  notes: 'Noter',
};

export const IMPORT_STATUSES = ['uploadet', 'importerer', 'importeret', 'delvist_fortrudt', 'fortrudt', 'annulleret'] as const;
export type ImportStatus = (typeof IMPORT_STATUSES)[number];
export const IMPORT_STATUS_LABEL: Record<ImportStatus, string> = {
  uploadet: 'Afventer bekræftelse',
  importerer: 'Importeres',
  importeret: 'Importeret',
  delvist_fortrudt: 'Delvist fortrudt',
  fortrudt: 'Fortrudt',
  annulleret: 'Ikke importeret',
};

export interface ImportRow {
  id: number;
  file_name: string;
  file_type: 'csv' | 'xlsx';
  file_size: number;
  file_sha256: string;
  file_deleted_at: number | null;
  file_deleted_by: string | null;
  status: ImportStatus;
  options: string | null;
  rows_total: number | null;
  created_count: number;
  skipped_duplicates: number;
  skipped_errors: number;
  skipped_blocked: number;
  undone_count: number;
  uploaded_at: number;
  uploaded_by: string;
  started_at: number | null;
  imported_at: number | null;
  imported_by: string | null;
  undone_at: number | null;
  undone_by: string | null;
}

// ---------- Kolonnegenkendelse ----------

/** Normaliseret kolonnenavn: små bogstaver, kun bogstaver og tal (fx "Tlf." → "tlf", "E-mail" → "email") */
export function normHeader(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9æøå]+/g, '');
}

const SYNONYMS: Record<ImportField, string[]> = {
  company: ['virksomhed', 'virksomhedsnavn', 'virksomhedensnavn', 'firma', 'firmanavn', 'company', 'companyname', 'business', 'businessname', 'organisation', 'organization', 'kunde', 'kundenavn', 'forretning', 'butik', 'navnpåvirksomhed', 'selskab'],
  contact_name: ['kontaktperson', 'kontakt', 'kontaktnavn', 'contact', 'contactname', 'contactperson', 'person', 'fuldtnavn', 'fuldenavn', 'fornavnogefternavn', 'ejer', 'indehaver', 'name', 'navn'],
  email: ['email', 'mail', 'emailadresse', 'mailadresse', 'epost', 'epostadresse', 'emailaddress', 'kontaktmail', 'emails', 'mails'],
  phone: ['telefon', 'tlf', 'tlfnr', 'telefonnummer', 'telefonnr', 'tel', 'phone', 'phonenumber', 'telephone', 'mobil', 'mobilnummer', 'mobilnr', 'mobile', 'nummer', 'tlfnummer'],
  website: ['hjemmeside', 'website', 'web', 'url', 'webside', 'www', 'websted', 'domæne', 'domain', 'site', 'webadresse', 'hjemmesideadresse'],
  city: ['by', 'område', 'omraade', 'byområde', 'byomraade', 'city', 'area', 'region', 'postby', 'lokation', 'location', 'kommune', 'sted', 'town', 'landsdel'],
  notes: ['noter', 'note', 'bemærkning', 'bemærkninger', 'kommentar', 'kommentarer', 'notes', 'comment', 'comments', 'beskrivelse', 'notat', 'info'],
};

export type ColumnMap = Partial<Record<ImportField, number>>;

/** Foreslår kolonner ud fra overskrifterne. "Navn" alene bliver kontaktperson, hvis der også er en virksomhedskolonne. */
export function autoMap(headers: string[]): ColumnMap {
  const norm = headers.map(normHeader);
  const map: ColumnMap = {};
  const used = new Set<number>();
  // Præcise navne først, derefter navne, der starter med et synonym (fx "Telefon (mobil)")
  for (const pass of ['exact', 'prefix'] as const) {
    for (const f of IMPORT_FIELDS) {
      if (map[f] !== undefined) continue;
      for (const syn of SYNONYMS[f]) {
        if (f === 'contact_name' && (syn === 'navn' || syn === 'name') && pass === 'prefix') continue;
        const i = norm.findIndex((h, idx) => !used.has(idx) && h && (pass === 'exact' ? h === syn : h.startsWith(syn) && syn.length >= 3));
        if (i >= 0) {
          map[f] = i;
          used.add(i);
          break;
        }
      }
    }
  }
  // "Navn" uden en virksomhedskolonne er sandsynligvis virksomheden
  if (map.company === undefined && map.contact_name !== undefined && ['navn', 'name'].includes(norm[map.contact_name]!)) {
    map.company = map.contact_name;
    delete map.contact_name;
  }
  return map;
}

// ---------- Læsning af filen ----------

export function safeImportName(name: string): string {
  const base = (name.split(/[\\/]/).pop() ?? '').replace(/[\u0000-\u001F\u007F"<>|*?:]/g, '').trim();
  return base.slice(-150) || 'fil';
}

/** Filtypen ud fra filnavn og indhold. Browserens påstand om typen bruges ikke. */
export function detectImportType(name: string, bytes: Uint8Array): { type: 'csv' | 'xlsx' } | { error: string } {
  const ext = name.toLowerCase().split('.').pop() ?? '';
  const zip = bytes.length > 4 && bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04;
  if (ext === 'xlsm' || ext === 'xlsb' || ext === 'xltm') return { error: 'Filer med makroer (.xlsm, .xlsb) kan ikke importeres. Gem filen som almindelig Excel-projektmappe (.xlsx) eller CSV.' };
  if (ext === 'xls') return { error: 'Det gamle Excel-format (.xls) understøttes ikke. Gem filen som .xlsx eller CSV.' };
  if (ext === 'xlsx') return zip ? { type: 'xlsx' } : { error: 'Filen hedder .xlsx, men er ikke en Excel-projektmappe.' };
  if (ext === 'csv' || ext === 'txt') {
    if (zip) return { error: 'Filen hedder .csv, men ligner en Excel-fil. Omdøb den til .xlsx, eller gem den som CSV.' };
    return { type: 'csv' };
  }
  return { error: 'Vælg en .xlsx- eller .csv-fil.' };
}

export interface ReadOptions {
  sheet: number;
  header: boolean;
  delimiter: Delimiter | null; // null = gæt
}

export interface Table {
  sheets: { name: string; hidden: boolean }[];
  sheet: number;
  delimiter: Delimiter | null;
  encoding: string | null;
  headers: string[];
  rows: NumberedRow[];
  formulas: number;
  truncated: boolean;
}

export async function readTable(bytes: Uint8Array, type: 'csv' | 'xlsx', o: ReadOptions): Promise<Table> {
  let rows: NumberedRow[];
  let sheets: Table['sheets'];
  let sheet = 0;
  let delimiter: Delimiter | null = null;
  let encoding: string | null = null;
  let formulas = 0;
  let truncated = false;
  if (type === 'xlsx') {
    const wb = await readXlsx(bytes);
    sheets = wb.sheets.map((s) => ({ name: s.name, hidden: s.hidden }));
    sheet = o.sheet >= 0 && o.sheet < sheets.length ? o.sheet : Math.max(0, sheets.findIndex((s) => !s.hidden));
    const s = await wb.load(sheet);
    rows = s.rows;
    formulas = s.formulas;
    truncated = s.truncated;
  } else {
    const r = readCsv(bytes, o.delimiter ?? undefined);
    sheets = [{ name: 'CSV', hidden: false }];
    rows = r.sheet.rows;
    delimiter = r.delimiter;
    encoding = r.encoding;
    truncated = r.sheet.truncated;
  }
  const width = Math.max(0, ...rows.slice(0, 200).map((r) => r.length));
  let headers: string[];
  if (o.header && rows.length) {
    const h = rows[0]!;
    headers = Array.from({ length: width }, (_, i) => (h[i] ?? '').trim() || `Kolonne ${colLetter(i)}`);
    rows = rows.slice(1);
  } else {
    headers = Array.from({ length: width }, (_, i) => `Kolonne ${colLetter(i)}`);
  }
  if (rows.length > 5000) {
    rows = rows.slice(0, 5000);
    truncated = true;
  }
  return { sheets, sheet, delimiter, encoding, headers, rows, formulas, truncated };
}

export function colLetter(i: number): string {
  let s = '';
  for (let n = i + 1; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s;
  return s;
}

// ---------- Validering, dubletter og blokeringer ----------

export interface Hit {
  text: string;
  href?: string;
}

export interface RowEval {
  row: number; // rækkenummer i filen
  values: Record<ImportField, string>;
  emails: string[];
  phones: string[];
  website: string | null;
  domain: string | null;
  errors: string[];
  duplicates: Hit[];
  blocked: Hit[];
  state: 'ok' | 'error' | 'blocked' | 'duplicate';
}

export interface Evaluation {
  rows: RowEval[];
  empty: number;
  counts: { ok: number; error: number; duplicate: number; blocked: number };
}

function splitMulti(s: string, re: RegExp): string[] {
  return s
    .split(re)
    .map((x) => x.trim())
    .filter(Boolean);
}

const LIMITS: Partial<Record<ImportField, number>> = { company: 200, contact_name: 150, city: 100, notes: 8000 };

function validateRow(values: Record<ImportField, string>): Omit<RowEval, 'row' | 'duplicates' | 'blocked' | 'state'> {
  const errors: string[] = [];
  if (!values.company) errors.push('Virksomhedsnavn mangler.');
  for (const [f, max] of Object.entries(LIMITS) as [ImportField, number][]) {
    if (values[f].length > max) errors.push(`${IMPORT_FIELD_LABEL[f]} er for langt (højst ${max} tegn).`);
  }
  const emails: string[] = [];
  for (const raw of splitMulti(values.email.replace(/mailto:/gi, ''), /[\s,;]+/)) {
    const e = normalizeEmail(raw);
    if (!e) errors.push(`"${raw.slice(0, 60)}" er ikke en gyldig e-mailadresse.`);
    else if (!emails.includes(e)) emails.push(e);
  }
  if (emails.length > 20) errors.push('Højst 20 e-mailadresser pr. række.');
  const phones: string[] = [];
  for (const raw of splitMulti(values.phone, /[\n,;/]+/)) {
    const digits = raw.replace(/\D/g, '').length;
    if (!/^[+0-9 ().-]{6,30}$/.test(raw) || digits < 6) errors.push(`"${raw.slice(0, 30)}" er ikke et gyldigt telefonnummer.`);
    else if (!phones.includes(raw)) phones.push(raw);
  }
  if (phones.length > 10) errors.push('Højst 10 telefonnumre pr. række.');
  let website: string | null = null;
  if (values.website) {
    website = normWebsite(values.website);
    if (!website) errors.push(`Hjemmesiden "${values.website.slice(0, 60)}" er ikke en gyldig adresse.`);
  }
  const domain = companyDomain(website) ?? (emails.map((e) => companyDomain(e)).find(Boolean) as string | undefined) ?? null;
  return { values, emails, phones, website, domain, errors };
}

interface Existing {
  byName: Map<string, Hit>;
  byEmail: Map<string, Hit>;
  byDomain: Map<string, Hit>;
  blocks: Map<string, Hit>;
}

async function loadExisting(db: D1Database, importId: number): Promise<Existing> {
  const [p, pc, cu, bl] = await db.batch([
    db.prepare('SELECT id, company, domain FROM prospects WHERE merged_into IS NULL AND (import_id IS NULL OR import_id != ?)').bind(importId),
    db
      .prepare(
        "SELECT pc.value, p.id, p.company FROM prospect_contacts pc JOIN prospects p ON p.id = pc.prospect_id WHERE pc.kind = 'email' AND p.merged_into IS NULL AND (p.import_id IS NULL OR p.import_id != ?)",
      )
      .bind(importId),
    db.prepare('SELECT id, email, company, COALESCE(company, name, email) AS label FROM customers'),
    db.prepare('SELECT scope, value, company, reason FROM prospect_blocks WHERE lifted_at IS NULL'),
  ]);
  const ex: Existing = { byName: new Map(), byEmail: new Map(), byDomain: new Map(), blocks: new Map() };
  const put = (m: Map<string, Hit>, k: string | null | undefined, h: Hit) => {
    if (k && !m.has(k)) m.set(k, h);
  };
  for (const r of (p?.results ?? []) as { id: number; company: string; domain: string | null }[]) {
    const h = { text: `kundeemnet "${r.company}"`, href: `/admin/kundeemner/${r.id}` };
    const n = normName(r.company);
    if (n.length >= 2) put(ex.byName, n, h);
    put(ex.byDomain, r.domain, h);
  }
  for (const r of (pc?.results ?? []) as { value: string; id: number; company: string }[]) {
    const h = { text: `kundeemnet "${r.company}"`, href: `/admin/kundeemner/${r.id}` };
    put(ex.byEmail, r.value, h);
    put(ex.byDomain, companyDomain(r.value), h);
  }
  for (const r of (cu?.results ?? []) as { id: number; email: string; company: string | null; label: string }[]) {
    const h = { text: `kunden "${r.label}"`, href: `/admin/kunder/${r.id}` };
    put(ex.byEmail, r.email.toLowerCase(), h);
    put(ex.byDomain, companyDomain(r.email), h);
    const n = normName(r.company);
    if (n.length >= 2) put(ex.byName, n, h);
  }
  for (const r of (bl?.results ?? []) as { scope: string; value: string; company: string | null; reason: string }[]) {
    put(ex.blocks, `${r.scope}:${r.value}`, { text: `${r.company ? `"${r.company}"` : r.value} er blacklistet (${r.reason.slice(0, 80)})`, href: '/admin/kundeemner/blokeringer' });
  }
  return ex;
}

export async function evaluate(db: D1Database, importId: number, table: Table, map: ColumnMap): Promise<Evaluation> {
  const ex = await loadExisting(db, importId);
  const seenName = new Map<string, number>();
  const seenEmail = new Map<string, number>();
  const seenDomain = new Map<string, number>();
  const out: RowEval[] = [];
  let empty = 0;
  table.rows.forEach((cells, i) => {
    const values = Object.fromEntries(IMPORT_FIELDS.map((f) => [f, map[f] !== undefined ? (cells[map[f]!] ?? '').trim() : ''])) as Record<ImportField, string>;
    if (IMPORT_FIELDS.every((f) => !values[f])) {
      empty++;
      return;
    }
    const v = validateRow(values);
    const row = cells.r ?? i + (table.headers.length ? 2 : 1);
    const duplicates: Hit[] = [];
    const blocked: Hit[] = [];
    const name = normName(values.company);
    const addDup = (h: Hit | undefined, why: string) => {
      if (h && !duplicates.some((d) => d.text.startsWith(why) && d.href === h.href)) duplicates.push({ text: `${why}: ${h.text}`, href: h.href });
    };
    if (name.length >= 2) addDup(ex.byName.get(name), 'Samme virksomhedsnavn');
    for (const e of v.emails) addDup(ex.byEmail.get(e), 'Samme e-mail');
    if (v.domain) addDup(ex.byDomain.get(v.domain), `Samme domæne (${v.domain})`);
    // Dubletter inde i filen
    const inFile = (m: Map<string, number>, k: string | null, why: string) => {
      if (!k) return;
      const first = m.get(k);
      if (first !== undefined && !duplicates.some((d) => d.text === `${why} som række ${first} i filen`)) duplicates.push({ text: `${why} som række ${first} i filen` });
    };
    if (name.length >= 2) inFile(seenName, name, 'Samme virksomhedsnavn');
    for (const e of v.emails) inFile(seenEmail, e, 'Samme e-mail');
    inFile(seenDomain, v.domain, 'Samme domæne');
    // Blokeringer: mail, domæne og navn
    for (const e of v.emails) {
      const b = ex.blocks.get(`email:${e}`);
      if (b) blocked.push(b);
    }
    for (const d of new Set([v.domain, ...v.emails.map((e) => companyDomain(e))].filter(Boolean) as string[])) {
      const b = ex.blocks.get(`domain:${d}`);
      if (b) blocked.push(b);
    }
    if (name) {
      const b = ex.blocks.get(`company:navn:${name}`);
      if (b) blocked.push(b);
    }
    const state: RowEval['state'] = v.errors.length ? 'error' : blocked.length ? 'blocked' : duplicates.length ? 'duplicate' : 'ok';
    if (!v.errors.length) {
      if (name.length >= 2 && !seenName.has(name)) seenName.set(name, row);
      for (const e of v.emails) if (!seenEmail.has(e)) seenEmail.set(e, row);
      if (v.domain && !seenDomain.has(v.domain)) seenDomain.set(v.domain, row);
    }
    out.push({ ...v, row, duplicates, blocked: [...new Map(blocked.map((b) => [b.text, b])).values()], state });
  });
  const counts = { ok: 0, error: 0, duplicate: 0, blocked: 0 };
  for (const r of out) counts[r.state]++;
  return { rows: out, empty, counts };
}

// ---------- Lagring af filen ----------

async function sha256Bytes(b: Uint8Array): Promise<string> {
  const d = await crypto.subtle.digest('SHA-256', b);
  return [...new Uint8Array(d)].map((x) => x.toString(16).padStart(2, '0')).join('');
}

export async function storeImport(db: D1Database, f: { name: string; type: 'csv' | 'xlsx'; bytes: Uint8Array; actor: string }): Promise<number> {
  const row = await db
    .prepare("INSERT INTO prospect_imports (file_name, file_type, file_size, file_sha256, status, uploaded_at, uploaded_by) VALUES (?, ?, ?, ?, 'uploadet', ?, ?) RETURNING id")
    .bind(f.name, f.type, f.bytes.length, await sha256Bytes(f.bytes), nowSec(), f.actor)
    .first<{ id: number }>();
  const id = row!.id;
  const stmts: D1PreparedStatement[] = [];
  for (let o = 0, seq = 0; o < f.bytes.length; o += CHUNK, seq++) {
    stmts.push(db.prepare('INSERT INTO prospect_import_chunks (import_id, seq, data) VALUES (?, ?, ?)').bind(id, seq, f.bytes.slice(o, o + CHUNK)));
  }
  try {
    await db.batch(stmts);
  } catch (e) {
    await db.prepare('DELETE FROM prospect_imports WHERE id = ?').bind(id).run();
    throw e;
  }
  return id;
}

export async function loadFile(db: D1Database, imp: ImportRow): Promise<Uint8Array | null> {
  if (imp.file_deleted_at) return null;
  const { results } = await db.prepare('SELECT data FROM prospect_import_chunks WHERE import_id = ? ORDER BY seq').bind(imp.id).all<{ data: ArrayBuffer | number[] }>();
  if (!results?.length) return null;
  const parts = results.map((r) => (r.data instanceof ArrayBuffer ? new Uint8Array(r.data) : new Uint8Array(r.data)));
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out.length === imp.file_size ? out : null;
}

export async function getImport(db: D1Database, id: number): Promise<ImportRow | null> {
  return db.prepare('SELECT * FROM prospect_imports WHERE id = ?').bind(id).first<ImportRow>();
}

export async function listImports(db: D1Database): Promise<(ImportRow & { remaining: number })[]> {
  const { results } = await db
    .prepare('SELECT i.*, (SELECT COUNT(*) FROM prospects p WHERE p.import_id = i.id) AS remaining FROM prospect_imports i ORDER BY i.uploaded_at DESC, i.id DESC LIMIT 200')
    .all<ImportRow & { remaining: number }>();
  return results ?? [];
}

/** Fjerner originalfilen fra lagringen. Importerede kundeemner bevares. */
export async function deleteImportFile(db: D1Database, imp: ImportRow, actor: string): Promise<void> {
  const now = nowSec();
  await db.batch([
    db.prepare('DELETE FROM prospect_import_chunks WHERE import_id = ?').bind(imp.id),
    db
      .prepare("UPDATE prospect_imports SET file_deleted_at = COALESCE(file_deleted_at, ?), file_deleted_by = COALESCE(file_deleted_by, ?), status = CASE WHEN status = 'uploadet' THEN 'annulleret' ELSE status END WHERE id = ?")
      .bind(now, actor, imp.id),
  ]);
}

// ---------- Selve importen ----------

export interface ConfirmOptions extends ReadOptions {
  map: ColumnMap;
  skipErrors: boolean;
  dupOk: number[]; // rækker, der skal oprettes, selv om de ligner en dublet
  includeBlocked: boolean;
  blockReason: string | null;
}

export type RunResult = { ok: true; created: number } | { ok: false; error: string; already?: boolean };

const LOCK_SECONDS = 300;

/**
 * Opretter kundeemnerne. Kun én bekræftelse kan køre ad gangen (låst i databasen); en gentagen bekræftelse eller et
 * genforsøg efter en afbrudt import opretter ikke en række to gange (unikt indeks på import_id + import_row).
 */
export async function runImport(db: D1Database, imp: ImportRow, opts: ConfirmOptions, actor: string): Promise<RunResult> {
  if (opts.map.company === undefined) return { ok: false, error: 'Vælg, hvilken kolonne der indeholder virksomhedsnavnet.' };
  const bytes = await loadFile(db, imp);
  if (!bytes) return { ok: false, error: 'Originalfilen er slettet, så importen kan ikke gennemføres. Upload filen igen.' };
  let table: Table;
  try {
    table = await readTable(bytes, imp.file_type, opts);
  } catch (e) {
    return { ok: false, error: e instanceof SheetError ? e.message : 'Filen kunne ikke læses.' };
  }
  const ev = await evaluate(db, imp.id, table, opts.map);
  if (ev.counts.error && !opts.skipErrors) return { ok: false, error: `${ev.counts.error} ${ev.counts.error === 1 ? 'række har' : 'rækker har'} fejl. Ret filen, eller vælg at springe rækker med fejl over.` };
  if (opts.includeBlocked && ev.counts.blocked && !opts.blockReason) return { ok: false, error: 'Skriv hvorfor blacklistede virksomheder skal importeres igen.' };

  const now = nowSec();
  const lock = await db
    .prepare(
      "UPDATE prospect_imports SET status = 'importerer', started_at = ?, options = ?, imported_by = ? WHERE id = ? AND file_deleted_at IS NULL AND (status = 'uploadet' OR (status = 'importerer' AND started_at < ?))",
    )
    .bind(now, JSON.stringify(opts), actor, imp.id, now - LOCK_SECONDS)
    .run();
  if (!lock.meta.changes) return { ok: false, already: true, error: 'Importen er allerede bekræftet eller er i gang. Der er ikke oprettet noget to gange.' };

  const dupOk = new Set(opts.dupOk);
  // Blacklistede rækker kræver det udtrykkelige valg; er de samtidig mulige dubletter, kræves også valget for dubletten
  const take = ev.rows.filter(
    (r) => r.state === 'ok' || (r.state === 'duplicate' && dupOk.has(r.row)) || (r.state === 'blocked' && opts.includeBlocked && (!r.duplicates.length || dupOk.has(r.row))),
  );
  const existing = new Set(
    ((await db.prepare('SELECT import_row FROM prospects WHERE import_id = ?').bind(imp.id).all<{ import_row: number }>()).results ?? []).map((r) => r.import_row),
  );
  const source = `Import: ${imp.file_name}`.slice(0, 100);
  const day = today();
  const todo = take.filter((r) => !existing.has(r.row));
  for (let i = 0; i < todo.length; i += 40) {
    const stmts: D1PreparedStatement[] = [];
    for (const r of todo.slice(i, i + 40)) {
      const v = r.values;
      const blockedNow = r.state === 'blocked';
      stmts.push(
        db
          .prepare(
            `INSERT INTO prospects (company, city, website, domain, contact_name, source, found_on, priority, status, status_set_at, status_set_by, notes,
               blacklisted, import_id, import_row, created_at, created_by, updated_at, updated_by)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 'mellem', 'undersoeges', ?8, ?9, ?10, ?11, ?12, ?13, ?8, ?9, ?8, ?9)`,
          )
          .bind(v.company, v.city || null, r.website, r.domain, v.contact_name || null, source, day, now, actor, v.notes || null, blockedNow ? 1 : 0, imp.id, r.row),
      );
      const sel = 'FROM prospects WHERE import_id = ? AND import_row = ?';
      for (const e of r.emails) stmts.push(db.prepare(`INSERT INTO prospect_contacts (prospect_id, kind, value, unverified, created_at) SELECT id, 'email', ?, 0, ? ${sel}`).bind(e, now, imp.id, r.row));
      for (const p of r.phones) stmts.push(db.prepare(`INSERT INTO prospect_contacts (prospect_id, kind, value, unverified, created_at) SELECT id, 'phone', ?, 0, ? ${sel}`).bind(p, now, imp.id, r.row));
      const body = `Importeret fra ${imp.file_name} (række ${r.row}).${blockedNow ? ` Importeret trods blacklisting: ${opts.blockReason}. Blokeringen gælder fortsat.` : ''}${r.state === 'duplicate' ? ' Oprettet som nyt kundeemne trods mulig dublet; eksisterende kundeemner er ikke ændret.' : ''}`;
      stmts.push(db.prepare(`INSERT INTO prospect_events (prospect_id, at, kind, actor, body, new_value, created_at) SELECT id, ?, 'created', ?, ?, 'undersoeges', ? ${sel}`).bind(now, actor, body, now, imp.id, r.row));
    }
    // Hver portion er én transaktion: enten oprettes rækkerne helt (med kontakter og historik), eller slet ikke
    await db.batch(stmts);
    await db.prepare("UPDATE prospect_imports SET started_at = ? WHERE id = ? AND status = 'importerer'").bind(nowSec(), imp.id).run();
  }
  const created = (await db.prepare('SELECT COUNT(*) AS n FROM prospects WHERE import_id = ?').bind(imp.id).first<{ n: number }>())?.n ?? 0;
  const taken = new Set(take.map((r) => r.row));
  const skippedDup = ev.rows.filter((r) => r.state === 'duplicate' && !taken.has(r.row)).length;
  const skippedBlocked = ev.rows.filter((r) => r.state === 'blocked' && !taken.has(r.row)).length;
  await db
    .prepare(
      "UPDATE prospect_imports SET status = 'importeret', rows_total = ?, created_count = ?, skipped_duplicates = ?, skipped_errors = ?, skipped_blocked = ?, imported_at = ?, imported_by = ? WHERE id = ?",
    )
    .bind(ev.rows.length, created, skippedDup, ev.counts.error, skippedBlocked, nowSec(), actor, imp.id)
    .run();
  return { ok: true, created };
}

// ---------- Fortryd import ----------

export interface ImportedProspect {
  id: number;
  company: string;
  import_row: number;
  status: string;
  reasons: string[]; // tom = kan slettes
}

const PROTECT_SQL = `
  SELECT p.id, p.company, p.import_row, p.status, p.version, p.customer_id, p.last_contact_at, p.archived_at, p.merged_into, p.lead_id, p.suggested_status,
    (SELECT COUNT(*) FROM prospect_events e WHERE e.prospect_id = p.id AND e.kind != 'created') AS ev,
    (SELECT COUNT(*) FROM prospect_events e WHERE e.prospect_id = p.id AND e.kind IN ('contact', 'mail')) AS contacts_n,
    (SELECT COUNT(*) FROM mail_threads m WHERE m.prospect_id = p.id) AS mails,
    (SELECT COUNT(*) FROM offers o WHERE o.prospect_id = p.id) AS offers_n,
    (SELECT COUNT(*) FROM time_entries t WHERE t.prospect_id = p.id) + (SELECT COUNT(*) FROM expenses x WHERE x.prospect_id = p.id)
      + (SELECT COUNT(*) FROM expense_allocations a WHERE a.prospect_id = p.id) AS costs,
    (SELECT COUNT(*) FROM prospect_files f WHERE f.prospect_id = p.id) + (SELECT COUNT(*) FROM prospect_links l WHERE l.prospect_id = p.id) AS files,
    (SELECT COUNT(*) FROM prospects q WHERE q.merged_into = p.id) AS merged_in,
    (SELECT COUNT(*) FROM prospect_blocks b WHERE b.prospect_id = p.id) AS blocks
  FROM prospects p WHERE p.import_id = ?`;

/** Betingelsen for, at et importeret kundeemne må slettes ved fortrydelse (bruges også i selve DELETE, så intet nyt når at slippe igennem) */
const UNTOUCHED_SQL = `version = 1 AND customer_id IS NULL AND status != 'kunde' AND last_contact_at IS NULL AND archived_at IS NULL AND merged_into IS NULL
  AND lead_id IS NULL AND suggested_status IS NULL
  AND NOT EXISTS (SELECT 1 FROM prospect_events e WHERE e.prospect_id = prospects.id AND e.kind != 'created')
  AND NOT EXISTS (SELECT 1 FROM mail_threads m WHERE m.prospect_id = prospects.id)
  AND NOT EXISTS (SELECT 1 FROM offers o WHERE o.prospect_id = prospects.id)
  AND NOT EXISTS (SELECT 1 FROM time_entries t WHERE t.prospect_id = prospects.id)
  AND NOT EXISTS (SELECT 1 FROM expenses x WHERE x.prospect_id = prospects.id)
  AND NOT EXISTS (SELECT 1 FROM expense_allocations a WHERE a.prospect_id = prospects.id)
  AND NOT EXISTS (SELECT 1 FROM prospect_files f WHERE f.prospect_id = prospects.id)
  AND NOT EXISTS (SELECT 1 FROM prospect_links l WHERE l.prospect_id = prospects.id)
  AND NOT EXISTS (SELECT 1 FROM prospects q WHERE q.merged_into = prospects.id)
  AND NOT EXISTS (SELECT 1 FROM prospect_blocks b WHERE b.prospect_id = prospects.id)`;

export async function importedProspects(db: D1Database, importId: number): Promise<ImportedProspect[]> {
  const { results } = await db.prepare(`${PROTECT_SQL} ORDER BY p.import_row`).bind(importId).all<Record<string, number | string | null>>();
  return (results ?? []).map((r) => {
    const reasons: string[] = [];
    if (r.customer_id || r.status === 'kunde') reasons.push('Er konverteret til aktiv kunde');
    if (r.last_contact_at || Number(r.contacts_n) || Number(r.mails) || r.suggested_status) reasons.push('Har fået kontaktaktivitet');
    if (Number(r.offers_n)) reasons.push('Har et tilbud');
    if (Number(r.costs)) reasons.push('Har registreret tid eller udgifter');
    if (Number(r.blocks)) reasons.push('Er blacklistet efter importen');
    if (
      !reasons.length &&
      (Number(r.version) > 1 || Number(r.ev) || Number(r.files) || r.merged_into || Number(r.merged_in) || r.lead_id || r.archived_at)
    )
      reasons.push('Er redigeret efter importen');
    return { id: Number(r.id), company: String(r.company), import_row: Number(r.import_row), status: String(r.status), reasons };
  });
}

/**
 * Sletter de valgte kundeemner fra importen. Kun kundeemner oprettet af netop denne import og uberørt siden;
 * betingelsen kontrolleres igen i selve sletningen. Blokeringer (blacklist) ligger i en særskilt tabel og bevares.
 */
export async function undoImport(db: D1Database, imp: ImportRow, ids: number[], actor: string): Promise<{ deleted: number; kept: number }> {
  let deleted = 0;
  const unique = [...new Set(ids.filter((n) => Number.isSafeInteger(n) && n > 0))];
  for (let i = 0; i < unique.length; i += 50) {
    const part = unique.slice(i, i + 50);
    const ph = part.map(() => '?').join(', ');
    // RETURNING tæller kun kundeemnerne (meta.changes tæller også kontakter og historik, der slettes med)
    const r = await db.prepare(`DELETE FROM prospects WHERE id IN (${ph}) AND import_id = ? AND ${UNTOUCHED_SQL} RETURNING id`).bind(...part, imp.id).all();
    deleted += r.results?.length ?? 0;
  }
  const left = await db.prepare('SELECT id FROM prospects WHERE import_id = ?').bind(imp.id).all<{ id: number }>();
  const leftIds = new Set((left.results ?? []).map((x) => x.id));
  const remaining = leftIds.size;
  if (deleted) {
    await db
      .prepare('UPDATE prospect_imports SET status = ?, undone_count = undone_count + ?, undone_at = ?, undone_by = ? WHERE id = ?')
      .bind(remaining ? 'delvist_fortrudt' : 'fortrudt', deleted, nowSec(), actor, imp.id)
      .run();
  }
  return { deleted, kept: unique.filter((id) => leftIds.has(id)).length };
}

// ---------- Læsning af valg fra formularer ----------

export function readOptions(get: (k: string) => string | undefined, headers: string[] | null): { read: ReadOptions; map: ColumnMap | null } {
  const sheet = Number.parseInt(get('ark') ?? '0', 10);
  const sep = get('skilletegn');
  const delimiter = sep === 'komma' ? ',' : sep === 'semikolon' ? ';' : sep === 'tab' ? '\t' : null;
  const read: ReadOptions = { sheet: Number.isSafeInteger(sheet) && sheet >= 0 ? sheet : 0, header: get('overskrift') !== '0', delimiter: DELIMITERS.includes(delimiter as Delimiter) ? (delimiter as Delimiter) : null };
  if (get('kolonner') !== '1') return { read, map: null };
  const map: ColumnMap = {};
  for (const f of IMPORT_FIELDS) {
    const raw = get(`k_${f}`);
    const n = raw === undefined || raw === '' ? NaN : Number.parseInt(raw, 10);
    if (Number.isSafeInteger(n) && n >= 0 && (!headers || n < headers.length)) map[f] = n;
  }
  return { read, map };
}

export const DELIM_PARAM: Record<Delimiter, string> = { ',': 'komma', ';': 'semikolon', '\t': 'tab' };
