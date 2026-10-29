// Bilag: kvitteringer, leverandørfakturaer og kreditnotaer.
//
// Forløbet er upload → kontrollér den digitale visning → tilknyt (fordel) → godkend → eksportér.
// Originalfilen ændres aldrig; aflæsning og rettelser gemmes som data ved siden af. Upload,
// aflæsning og godkendelse ændrer aldrig lageret. En varemodtagelse eller et direkte køb til et
// job fra et bilag registreres kun, når nogen bevidst trykker på knappen for det.

import type { Env, JobRow, PurchaseLineRow, Role } from '../env';
import { readText, type ReadField } from './bilagread';
import { extractReceiptText } from './ocr';
import { fileBytes, getFile, type FileRow } from './files';
import { formatKr, formatQty, todayDk } from './format';
import { logStmt } from './jobs';
import { Conflict, Tx, type Actor } from './ledger';
import { defaultJobList, getJob } from './materials';
import { pdfText } from './pdftext';
import { receiveLine, stockList } from './purchasing';
import type { Settings } from './settings';

export type BilagStatus = 'modtaget' | 'under_aflaesning' | 'klar' | 'afklaring' | 'godkendt' | 'arkiveret';
export type BilagPayment = 'virksomhed' | 'medarbejder' | 'ikke_betalt' | 'uafklaret';
export type DocType = 'kvittering' | 'faktura' | 'kreditnota' | 'andet';
export type AllocTarget = 'job' | 'lager' | 'drift';
export type AllocAction = 'eksisterende' | 'ny_modtagelse' | 'direkte_job' | 'udgift';

export interface BilagRow {
  id: number;
  doc_type: DocType;
  file_id: number;
  file_name: string;
  preview_file_id: number | null;
  status: BilagStatus;
  version: number;
  supplier_name: string;
  supplier_cvr: string;
  supplier_id: number | null;
  doc_number: string;
  doc_date: string;
  due_date: string;
  currency: string;
  net: number | null;
  vat: number | null;
  total: number | null;
  rounding: number;
  line_prices: 'ekskl' | 'inkl';
  payment_info: string;
  uncertain: string;
  reading_source: '' | 'pdf-tekst' | 'manuel' | 'simuleret';
  ocr_provider: string;
  reading_token: string;
  data_revision: number;
  reading_note: string;
  payment: BilagPayment;
  paid_by: string;
  reimbursed_at: number | null;
  reimbursed_by: string | null;
  job_hint: number | null;
  origin: string;
  credit_of: number | null;
  note: string;
  clarify: string;
  dup_of: number | null;
  dup_reason: string;
  dup_cleared_by: string | null;
  approved_by: string | null;
  approved_at: number | null;
  approved_version: number | null;
  exported_version: number | null;
  exported_at: number | null;
  export_id: number | null;
  export_failed: number;
  uploaded_by: string;
  uploaded_name: string;
  created_at: number;
  updated_at: number;
}

export interface BilagLineRow {
  id: number;
  bilag_id: number;
  pos: number;
  name: string;
  qty: number | null;
  unit: string;
  unit_price: number | null;
  discount: number;
  amount: number | null;
  vat_rate: number | null;
  product_id: number | null;
  product_state: '' | 'forslag' | 'godkendt';
  uncertain: number;
}

export interface AllocationRow {
  id: number;
  bilag_id: number;
  line_id: number | null;
  target: AllocTarget;
  job_id: number | null;
  amount: number;
  action: AllocAction;
  purchase_line_id: number | null;
  product_id: number | null;
  qty: number | null;
  match_state: '' | 'forslag' | 'godkendt';
  done_at: number | null;
  done_by: string | null;
  note: string;
  created_by: string;
  created_at: number;
}

export type AllocationView = AllocationRow & {
  job_number: string | null;
  job_name: string | null;
  product_name: string | null;
  product_unit: string | null;
  line_name: string | null;
  pl_name: string | null;
  pl_received: number | null;
  pl_unit: string | null;
};

export interface BilagEventRow {
  id: number;
  bilag_id: number;
  version: number;
  kind: string;
  text: string;
  actor: string;
  actor_name: string;
  created_at: number;
}

export const STATUS_LABEL: Record<BilagStatus, string> = {
  modtaget: 'Modtaget',
  under_aflaesning: 'Under aflæsning',
  klar: 'Klar til gennemgang',
  afklaring: 'Kræver afklaring',
  godkendt: 'Godkendt',
  arkiveret: 'Arkiveret',
};

export const STATUS_TAG: Record<BilagStatus, string> = {
  modtaget: 'tag-off',
  under_aflaesning: 'tag-sim',
  klar: 'tag-ready',
  afklaring: 'tag-low',
  godkendt: 'tag-ok',
  arkiveret: 'tag-off',
};

export const PAYMENT_LABEL: Record<BilagPayment, string> = {
  virksomhed: 'Betalt af virksomheden',
  medarbejder: 'Betalt privat af medarbejder (udlæg)',
  ikke_betalt: 'Ikke betalt',
  uafklaret: 'Uafklaret',
};

export const DOC_TYPE_LABEL: Record<DocType, string> = {
  kvittering: 'Kvittering',
  faktura: 'Leverandørfaktura',
  kreditnota: 'Kreditnota fra leverandør',
  andet: 'Andet bilag',
};

export const TARGET_LABEL: Record<AllocTarget, string> = {
  job: 'Job',
  lager: 'Lageropfyldning',
  drift: 'Almindelig drift',
};

export const ACTION_LABEL: Record<AllocAction, string> = {
  eksisterende: 'Knyttet til eksisterende køb/varemodtagelse',
  ny_modtagelse: 'Ny varemodtagelse',
  direkte_job: 'Direkte køb til job',
  udgift: 'Udgift uden lagerpåvirkning',
};

export const FIELD_LABEL: Record<string, string> = {
  doc_type: 'Dokumenttype',
  supplier_name: 'Leverandør',
  supplier_cvr: 'CVR',
  doc_number: 'Bilagsnummer',
  doc_date: 'Dato',
  due_date: 'Betalingsfrist',
  currency: 'Valuta',
  net: 'Ekskl. moms',
  vat: 'Moms',
  total: 'Total',
  rounding: 'Afrunding',
  payment_info: 'Betalingsoplysninger',
  line_prices: 'Linjepriser',
};

export const isStatus = (s: unknown): s is BilagStatus => typeof s === 'string' && s in STATUS_LABEL;
export const isPayment = (s: unknown): s is BilagPayment => typeof s === 'string' && s in PAYMENT_LABEL;
export const isDocType = (s: unknown): s is DocType => typeof s === 'string' && s in DOC_TYPE_LABEL;

/** Bilags-ID som det vises og eksporteres (stabilt). */
export const bilagNo = (id: number) => `B-${String(id).padStart(6, '0')}`;

export function uncertainOf(b: Pick<BilagRow, 'uncertain'>): string[] {
  try {
    const v = JSON.parse(b.uncertain);
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

export function eventStmt(db: D1Database, bilagId: number, version: number, kind: string, text: string, actor: Actor, now: number): D1PreparedStatement {
  return db
    .prepare('INSERT INTO bilag_events (bilag_id, version, kind, text, actor, actor_name, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .bind(bilagId, version, kind, text, actor.email, actor.name, now);
}

export async function getBilag(db: D1Database, id: number): Promise<BilagRow | null> {
  return db.prepare('SELECT * FROM bilag WHERE id = ?').bind(id).first<BilagRow>();
}

export async function bilagLines(db: D1Database, id: number): Promise<BilagLineRow[]> {
  const { results } = await db.prepare('SELECT * FROM bilag_lines WHERE bilag_id = ? ORDER BY pos, id').bind(id).all<BilagLineRow>();
  return results;
}

export async function allocations(db: D1Database, id: number): Promise<AllocationView[]> {
  const { results } = await db
    .prepare(
      `SELECT a.*, j.number AS job_number, j.name AS job_name, p.name AS product_name, p.unit AS product_unit, l.name AS line_name,
         pl.name AS pl_name, pl.received AS pl_received, pl.unit AS pl_unit
       FROM bilag_allocations a LEFT JOIN jobs j ON j.id = a.job_id LEFT JOIN products p ON p.id = a.product_id
       LEFT JOIN bilag_lines l ON l.id = a.line_id LEFT JOIN purchase_lines pl ON pl.id = a.purchase_line_id
       WHERE a.bilag_id = ? ORDER BY a.id`,
    )
    .bind(id)
    .all<AllocationView>();
  return results;
}

export async function bilagEvents(db: D1Database, id: number): Promise<BilagEventRow[]> {
  const { results } = await db.prepare('SELECT * FROM bilag_events WHERE bilag_id = ? ORDER BY created_at DESC, id DESC').bind(id).all<BilagEventRow>();
  return results;
}

/** Det beløb, der fordeles: ekskl. moms (eller total, når virksomheden ikke er momsregistreret). */
export function allocBase(b: Pick<BilagRow, 'net' | 'total'>, s: Pick<Settings, 'vat_registered'>): number | null {
  return s.vat_registered === 'nej' ? b.total : b.net;
}

/** Linjens beløb ekskl. moms (null hvis det ikke kan afgøres uden at gætte). */
export function lineNet(l: Pick<BilagLineRow, 'amount' | 'vat_rate'>, b: Pick<BilagRow, 'line_prices'>): number | null {
  if (l.amount === null) return null;
  if (b.line_prices === 'ekskl') return l.amount;
  if (l.vat_rate === null) return null;
  return Math.round((l.amount * 10000) / (10000 + l.vat_rate));
}

/** Eksportstatus ud fra godkendelse og seneste eksport. */
export type ExportState = 'ikke_klar' | 'klar' | 'eksporteret' | 'fejlet' | 'aendret';
export const EXPORT_LABEL: Record<ExportState, string> = {
  ikke_klar: 'Ikke klar',
  klar: 'Klar til eksport',
  eksporteret: 'Eksporteret',
  fejlet: 'Overførsel fejlet',
  aendret: 'Ændret siden seneste eksport',
};
export function exportState(b: Pick<BilagRow, 'status' | 'version' | 'approved_version' | 'exported_version' | 'export_failed'>): ExportState {
  const approved = (b.status === 'godkendt' || b.status === 'arkiveret') && b.approved_version === b.version;
  if (b.exported_version !== null && b.exported_version !== b.version) return 'aendret';
  if (!approved) return b.exported_version !== null ? 'aendret' : 'ikke_klar';
  if (b.export_failed) return 'fejlet';
  if (b.exported_version === b.version) return 'eksporteret';
  return 'klar';
}

// --- Kontrol --------------------------------------------------------------------------------------

export interface Checks {
  /** Skal være løst, før bilaget kan godkendes */
  errors: string[];
  /** Advarsler (blokerer ikke) */
  warnings: string[];
  linesSum: number | null;
  allocated: number;
  base: number | null;
}

export function checkBilag(b: BilagRow, lines: BilagLineRow[], allocs: AllocationRow[], s: Pick<Settings, 'vat_registered'>): Checks {
  const errors: string[] = [];
  const warnings: string[] = [];
  if (b.reading_token) errors.push('Bilaget afventer OCR eller er under aflæsning. Vent på resultatet, eller ret og gem oplysningerne manuelt for at afbryde aflæsningen.');
  if (!b.supplier_name.trim()) errors.push('Leverandørens navn mangler.');
  if (!b.doc_date) errors.push('Datoen mangler.');
  if (!/^[A-Z]{3}$/.test(b.currency)) errors.push('Valutaen mangler.');
  if (b.total === null) errors.push('Totalen mangler.');
  if (b.net === null) errors.push('Beløbet ekskl. moms mangler.');
  if (b.vat === null) errors.push('Momsen mangler (angiv 0, hvis der ikke er moms).');
  if (b.total !== null && b.net !== null && b.vat !== null) {
    const diff = b.net + b.vat + b.rounding - b.total;
    if (diff !== 0) errors.push(`Ekskl. moms + moms + afrunding giver ${formatKr(b.net + b.vat + b.rounding, { decimals: true })}, men totalen er ${formatKr(b.total, { decimals: true })} (forskel ${formatKr(diff, { decimals: true })}).`);
  }
  let linesSum: number | null = null;
  if (lines.length) {
    linesSum = lines.reduce((a, l) => a + (l.amount ?? 0), 0);
    const want = b.line_prices === 'ekskl' ? b.net : b.total !== null ? b.total - b.rounding : null;
    if (want !== null && Math.abs(linesSum - want) > 0) {
      warnings.push(`Varelinjerne summer til ${formatKr(linesSum, { decimals: true })}, men bilaget siger ${formatKr(want, { decimals: true })} ${b.line_prices === 'ekskl' ? 'ekskl.' : 'inkl.'} moms.`);
    }
    // Moms pr. sats (kun når alle linjer har en sats)
    if (b.vat !== null && lines.every((l) => l.vat_rate !== null && l.amount !== null)) {
      const byRate = new Map<number, number>();
      for (const l of lines) byRate.set(l.vat_rate!, (byRate.get(l.vat_rate!) ?? 0) + l.amount!);
      let expect = 0;
      for (const [rate, amt] of byRate) expect += b.line_prices === 'ekskl' ? Math.round((amt * rate) / 10000) : amt - Math.round((amt * 10000) / (10000 + rate));
      if (Math.abs(expect - b.vat) > byRate.size) warnings.push(`Momsen efter linjernes satser er ${formatKr(expect, { decimals: true })}, men bilaget angiver ${formatKr(b.vat, { decimals: true })}.`);
    }
    const bad = lines.filter((l) => l.qty !== null && l.unit_price !== null && l.amount !== null && Math.abs(Math.round((l.qty * l.unit_price) / 1000) - l.discount - l.amount) > 2);
    if (bad.length) warnings.push(`${bad.length} ${bad.length === 1 ? 'linje' : 'linjer'}: antal × pris − rabat giver ikke linjens beløb.`);
  }
  const unc = uncertainOf(b);
  if (b.ocr_provider && (unc.length || lines.some((l) => l.uncertain))) errors.push('Kontrollér alle OCR-forslag mod originalen, markér kontrollen og gem, før bilaget godkendes eller påvirker lageret.');
  if (unc.length) warnings.push(`Usikre værdier fra aflæsningen: ${unc.map((f) => FIELD_LABEL[f] ?? f).join(', ')}. Kontrollér dem mod originalen.`);
  if (lines.some((l) => l.uncertain)) warnings.push('Nogle varelinjer er usikre. Kontrollér dem mod originalen.');
  if (lines.some((l) => l.product_state === 'forslag')) errors.push('Godkend eller fjern de foreslåede varematch på linjerne.');
  const base = allocBase(b, s);
  const allocated = allocs.reduce((a, x) => a + x.amount, 0);
  if (!allocs.length) errors.push('Bilaget er ikke fordelt på job, lager eller drift.');
  else if (base !== null && allocated !== base) errors.push(`Fordelingen (${formatKr(allocated, { decimals: true })}) stemmer ikke med bilaget (${formatKr(base, { decimals: true })}). Rest: ${formatKr(base - allocated, { decimals: true })}.`);
  if (allocs.some((a) => a.match_state === 'forslag')) errors.push('Godkend de foreslåede match til køb/varemodtagelser.');
  if (b.dup_of && !b.dup_cleared_by) errors.push(`Mulig dublet af ${bilagNo(b.dup_of)} (${b.dup_reason}). Bekræft, at det ikke er en dublet, eller arkivér bilaget.`);
  if (b.payment === 'uafklaret') warnings.push('Betalingen er uafklaret.');
  if (b.payment === 'medarbejder' && !b.paid_by) errors.push('Angiv hvilken medarbejder, der har lagt ud.');
  return { errors, warnings, linesSum, allocated, base };
}

// --- Dubletter ------------------------------------------------------------------------------------

export async function findDuplicate(db: D1Database, b: Pick<BilagRow, 'id' | 'file_id' | 'supplier_name' | 'supplier_cvr' | 'doc_number' | 'doc_date' | 'total' | 'doc_type'>): Promise<{ id: number; reason: string } | null> {
  const same = await db.prepare('SELECT id FROM bilag WHERE file_id = ? AND id < ? ORDER BY id LIMIT 1').bind(b.file_id, b.id).first<{ id: number }>();
  if (same) return { id: same.id, reason: 'identisk fil' };
  const who = b.supplier_cvr ? 'supplier_cvr = ?2' : "supplier_name = ?2 COLLATE NOCASE AND supplier_name <> ''";
  const whoVal = b.supplier_cvr || b.supplier_name;
  if (!whoVal) return null;
  if (b.doc_number) {
    const r = await db
      .prepare(`SELECT id FROM bilag WHERE id < ?1 AND ${who} AND doc_number = ?3 AND doc_type = ?4 AND status <> 'arkiveret' ORDER BY id LIMIT 1`)
      .bind(b.id, whoVal, b.doc_number, b.doc_type)
      .first<{ id: number }>();
    if (r) return { id: r.id, reason: 'samme leverandør og bilagsnummer' };
  }
  if (b.doc_date && b.total !== null) {
    const r = await db
      .prepare(`SELECT id FROM bilag WHERE id < ?1 AND ${who} AND doc_date = ?3 AND total = ?4 AND doc_type = ?5 AND status <> 'arkiveret' ORDER BY id LIMIT 1`)
      .bind(b.id, whoVal, b.doc_date, b.total, b.doc_type)
      .first<{ id: number }>();
    if (r) return { id: r.id, reason: 'samme leverandør, dato og beløb' };
  }
  return null;
}

/** Opdaterer dublet-advarslen (fletter aldrig noget). */
export async function refreshDuplicate(db: D1Database, id: number, actor: Actor, now: number): Promise<void> {
  const b = await getBilag(db, id);
  if (!b) return;
  const d = await findDuplicate(db, b);
  if ((d?.id ?? null) === b.dup_of && (d?.reason ?? '') === b.dup_reason) return;
  const stmts = [db.prepare('UPDATE bilag SET dup_of = ?, dup_reason = ?, dup_cleared_by = CASE WHEN ? IS NULL THEN NULL ELSE dup_cleared_by END WHERE id = ?').bind(d?.id ?? null, d?.reason ?? '', d?.id ?? null, id)];
  if (d) stmts.push(eventStmt(db, id, b.version, 'dublet', `Mulig dublet af ${bilagNo(d.id)}: ${d.reason}. Intet er flettet.`, actor, now));
  await db.batch(stmts);
}

// --- Oprettelse og aflæsning ----------------------------------------------------------------------

export interface NewBilag {
  doc_type: DocType;
  payment: BilagPayment;
  paid_by: string;
  job_hint: number | null;
  origin: string;
  note: string;
  preview_file_id: number | null;
}

export async function createBilag(db: D1Database, file: FileRow, name: string, input: NewBilag, actor: Actor, now: number): Promise<number> {
  const row = await db
    .prepare(
      `INSERT INTO bilag (doc_type, file_id, file_name, preview_file_id, payment, paid_by, job_hint, origin, note, uploaded_by, uploaded_name, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`,
    )
    .bind(input.doc_type, file.id, name, input.preview_file_id, input.payment, input.paid_by, input.job_hint, input.origin, input.note, actor.email, actor.name, now, now)
    .first<{ id: number }>();
  const id = row!.id;
  await eventStmt(db, id, 1, 'upload', `Uploadet: ${name} (${file.mime}${file.pages ? `, ${file.pages} ${file.pages === 1 ? 'side' : 'sider'}` : ''}, ${Math.ceil(file.size / 1024)} KB).`, actor, now).run();
  await refreshDuplicate(db, id, actor, now);
  return id;
}

/**
 * Aflæser et bilag. En PDF med tekst læses med den indbyggede PDF-læser. Billeder og indskannede
 * PDF'er kan bruge en særskilt OCR-servicebinding. Uden binding registreres de manuelt.
 */
export interface ReadBilagResult {
  ok: boolean;
  message: string;
  needsOcr?: boolean;
  retryable?: boolean;
  cancelled?: boolean;
}

export interface BilagEvidence {
  bilag_id: number;
  file_id: number;
  /** Version of the saved fields when this unchanged original was read. */
  sourceVersion: number;
  currentVersion: number;
  pages: string[][];
  source: 'ocr' | 'pdf-tekst';
  provider: string;
  read_at: number;
  /** A large text PDF may have more source text than the review limit. */
  truncated: boolean;
}

const MAX_EVIDENCE_TEXT = 100_000;
const MAX_EVIDENCE_PAGES = 20;

function boundedEvidence(pages: string[][]): { pages: string[][]; textChars: number; truncated: boolean } {
  const bounded: string[][] = [];
  let remaining = MAX_EVIDENCE_TEXT;
  let truncated = pages.length > MAX_EVIDENCE_PAGES;
  for (const page of pages.slice(0, MAX_EVIDENCE_PAGES)) {
    const lines: string[] = [];
    for (const line of page) {
      // Preserve line boundaries within each page as part of the text budget.
      if (lines.length) {
        if (!remaining) { truncated = true; break; }
        remaining--;
      }
      if (line.length > remaining) {
        lines.push(line.slice(0, remaining));
        remaining = 0;
        truncated = true;
        break;
      } else {
        lines.push(line);
        remaining -= line.length;
      }
    }
    bounded.push(lines);
    if (!remaining && bounded.length < pages.length) { truncated = true; break; }
  }
  return { pages: bounded, textChars: MAX_EVIDENCE_TEXT - remaining, truncated };
}

/**
 * Exact text returned by the reader, separate from editable suggested fields.
 * Evidence survives manual field edits of the same original, with both versions
 * exposed so callers never imply that OCR reflects those later corrections.
 * Replaced originals can never select evidence belonging to the former file.
 * The caller must apply the same per-document access check as the detail view.
 */
export async function getBilagEvidence(db: D1Database, id: number): Promise<BilagEvidence | null> {
  const row = await db.prepare(`SELECT e.bilag_id,e.file_id,e.version AS sourceVersion,b.version AS currentVersion,
      e.pages_json,e.source,e.provider,e.read_at,e.truncated
    FROM bilag_ocr_evidence e JOIN bilag b ON b.id=e.bilag_id AND b.file_id=e.file_id
    WHERE b.id=? AND e.version<=b.version ORDER BY e.version DESC,e.read_at DESC LIMIT 1`).bind(id).first<{
      bilag_id: number; file_id: number; sourceVersion: number; currentVersion: number;
      pages_json: string; source: 'ocr' | 'pdf-tekst'; provider: string; read_at: number; truncated: number;
    }>();
  if (!row) return null;
  try {
    const pages: unknown = JSON.parse(row.pages_json);
    if (!Array.isArray(pages) || pages.length > MAX_EVIDENCE_PAGES || !pages.every((p) => Array.isArray(p) && p.every((l) => typeof l === 'string'))
      || (pages as string[][]).reduce((n, p) => n + p.join('\n').length, 0) > MAX_EVIDENCE_TEXT) return null;
    const { pages_json: _, truncated, ...value } = row;
    return { ...value, pages: pages as string[][], truncated: !!truncated };
  } catch { return null; }
}

export async function readBilag(env: Env, s: Settings, id: number, actor: Actor, now: number, opts: { deferOcr?: boolean; backgroundToken?: string } = {}): Promise<ReadBilagResult> {
  const db = env.DB;
  const b = await getBilag(db, id);
  if (!b) return { ok: false, message: 'Bilaget findes ikke.' };
  if (b.status === 'godkendt' || b.status === 'arkiveret') return { ok: false, message: 'Godkendte eller arkiverede bilag aflæses ikke igen. Ret oplysningerne manuelt, så historikken bevares.' };
  const allocated = await db.prepare('SELECT 1 FROM bilag_allocations WHERE bilag_id = ? LIMIT 1').bind(id).first();
  if (allocated) return { ok: false, message: 'Bilaget er allerede fordelt. Ret oplysningerne manuelt; genaflæsning må ikke fjerne fordeling eller registrerede varemodtagelser.' };
  const f = await getFile(db, b.file_id);
  if (!f) return { ok: false, message: 'Filen findes ikke.' };
  let message = 'Originalen er gemt. Kontrollér og registrér oplysningerne manuelt.';
  let ok = false;
  let pages: string[][] = [];
  let source: BilagRow['reading_source'] = '';
  let provider = '';
  const bytes = await fileBytes(db, f);
  if (f.mime === 'application/pdf' && bytes) {
    const text = await pdfText(bytes);
    if (text.hasText) { pages = text.pages; source = 'pdf-tekst'; }
  }
  if (!pages.length && bytes && opts.deferOcr && env.RECEIPT_OCR) return { ok: true, needsOcr: true, message: 'Bilaget skal aflæses med OCR.' };
  const token = opts.backgroundToken || crypto.randomUUID();
  if (opts.backgroundToken) {
    if (b.reading_token !== token || b.status !== 'under_aflaesning') return { ok: false, cancelled: true, message: 'Aflæsningen er afbrudt, fordi bilaget er ændret.' };
  } else {
    if (b.reading_token) return { ok: false, message: 'Bilaget er allerede i kø eller under aflæsning.' };
    const claimed = await db.prepare(`UPDATE bilag SET reading_token = ?, status = 'under_aflaesning', updated_at = ?
      WHERE id = ? AND data_revision = ? AND reading_token = '' AND status NOT IN ('godkendt','arkiveret')
      AND NOT EXISTS (SELECT 1 FROM bilag_allocations WHERE bilag_id = ?) RETURNING id`).bind(token, now, id, b.data_revision, id).first();
    if (!claimed) return { ok: false, cancelled: true, message: 'Bilaget er ændret imens. Genindlæs siden.' };
  }
  let retryable = false;
  if (!pages.length && bytes) {
    const ocr = await extractReceiptText(env, { bytes, mime: f.mime });
    if (ocr.status === 'ok') {
      pages = ocr.pages.map((page) => page.split(/\r?\n/));
      provider = ocr.provider;
    } else { message = ocr.message; retryable = !!ocr.retryable; }
  }
  // The queue owns retries and final failure state. Keep its lease/token intact
  // after a temporary provider failure; never re-post any business data.
  if (!pages.length && opts.backgroundToken) return { ok: false, message, retryable };
  const stmts: D1PreparedStatement[] = [];
  // The guard and suggested replacements commit in one D1 batch. Changes made
  // while a CPU container was working invalidate the token through DB triggers.
  stmts.push(db.prepare(`UPDATE bilag SET reading_token = CASE
    WHEN reading_token = ? AND data_revision = ? AND file_id = ? AND version = ? AND status = 'under_aflaesning'
      AND NOT EXISTS (SELECT 1 FROM bilag_allocations WHERE bilag_id = ?)
    THEN reading_token ELSE NULL END WHERE id = ?`).bind(token, b.data_revision, b.file_id, b.version, id, id));
  if (pages.length) {
      const evidence = boundedEvidence(pages);
      // This insert and the result replacement share the token/revision guard
      // and one atomic batch. A delayed/cancelled read leaves no new evidence.
      stmts.push(db.prepare(`INSERT INTO bilag_ocr_evidence
          (bilag_id,file_id,version,pages_json,text_chars,source,provider,read_at,truncated)
        VALUES (?,?,?,?,?,?,?,?,?) ON CONFLICT(bilag_id,file_id,version) DO UPDATE SET
          pages_json=excluded.pages_json,text_chars=excluded.text_chars,source=excluded.source,
          provider=excluded.provider,read_at=excluded.read_at,truncated=excluded.truncated`)
        .bind(id, b.file_id, b.version, JSON.stringify(evidence.pages), evidence.textChars, provider ? 'ocr' : 'pdf-tekst', provider, now, evidence.truncated ? 1 : 0));
      const { results: sups } = await db.prepare('SELECT id, name FROM suppliers').all<{ id: number; name: string }>();
      const r = readText(pages, { ownCvr: s.company_cvr, ownName: s.company_name, suppliers: sups });
      const v = r.values;
      if (provider) {
        r.uncertain = [...new Set([...r.uncertain, ...Object.keys(v) as ReadField[]])];
        r.lines.forEach((line) => { line.uncertain = true; });
      }
      const sup = sups.find((x) => x.name.toLowerCase() === String(v.supplier_name ?? '').toLowerCase());
      stmts.push(
        db
          .prepare(
            `UPDATE bilag SET doc_type = COALESCE(?, doc_type), supplier_name = ?, supplier_cvr = ?, supplier_id = ?, doc_number = ?, doc_date = ?, due_date = ?,
               currency = ?, net = ?, vat = ?, total = ?, rounding = ?, line_prices = ?, payment_info = ?, uncertain = ?, reading_source = ?, ocr_provider = ?, reading_note = ?, updated_at = ?
             WHERE id = ?`,
          )
          .bind(
            b.doc_type === 'kvittering' && v.doc_type ? v.doc_type : null,
            String(v.supplier_name ?? ''),
            String(v.supplier_cvr ?? ''),
            sup?.id ?? null,
            String(v.doc_number ?? ''),
            String(v.doc_date ?? ''),
            String(v.due_date ?? ''),
            String(v.currency ?? 'DKK'),
            typeof v.net === 'number' ? v.net : null,
            typeof v.vat === 'number' ? v.vat : null,
            typeof v.total === 'number' ? v.total : null,
            typeof v.rounding === 'number' ? v.rounding : 0,
            v.line_prices === 'inkl' ? 'inkl' : 'ekskl',
            String(v.payment_info ?? ''),
            JSON.stringify(r.uncertain),
            source,
            provider,
            r.notes.join(' '),
            now,
            id,
          ),
        db.prepare('DELETE FROM bilag_lines WHERE bilag_id = ?').bind(id),
      );
      r.lines.slice(0, 200).forEach((l, i) =>
        stmts.push(
          db
            .prepare('INSERT INTO bilag_lines (bilag_id, pos, name, qty, unit, unit_price, discount, amount, vat_rate, uncertain) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
            .bind(id, i + 1, l.name.slice(0, 200), l.qty, l.unit.slice(0, 20), l.unit_price, l.discount, l.amount, l.vat_rate, l.uncertain ? 1 : 0),
        ),
      );
      const found = Object.keys(v).filter((k) => k !== 'line_prices' && k !== 'doc_type').length;
      message = provider
        ? `OCR-forslag fra ${provider}: ${found} felter og ${r.lines.length} varelinjer. Alle forslag kræver kontrol mod originalen før godkendelse.`
        : `Aflæst fra PDF'ens tekst: ${found} felter og ${r.lines.length} varelinjer foreslået${r.uncertain.length ? `, ${r.uncertain.length} usikre` : ''}. Kontrollér mod originalen.`;
      ok = true;
  }
  stmts.push(
    db.prepare(`UPDATE bilag SET status = ?, reading_note = CASE WHEN ? THEN reading_note ELSE ? END, updated_at = ? WHERE id = ?`).bind(ok ? 'klar' : 'modtaget', ok ? 1 : 0, message, now, id),
    eventStmt(db, id, b.version, 'aflaesning', message, actor, now),
  );
  try { await db.batch(stmts); }
  catch (error) {
    if (String((error as Error)?.message).includes('bilag.reading_token')) return { ok: false, cancelled: true, message: 'OCR-resultatet blev ikke gemt, fordi bilaget er ændret eller fordelt imens. Dine ændringer er bevaret.' };
    throw error;
  }
  if (ok) await suggestProducts(db, id);
  await refreshDuplicate(db, id, actor, now);
  return { ok, message, ...(retryable ? { retryable: true } : {}) };
}

/** Foreslår egne varer til varelinjerne ud fra varenummer, EAN eller navn (skal godkendes). */
export async function suggestProducts(db: D1Database, id: number): Promise<void> {
  const lines = (await bilagLines(db, id)).filter((l) => l.product_id === null);
  if (!lines.length) return;
  const { results: prods } = await db.prepare('SELECT id, sku, name, ean FROM products WHERE active = 1').all<{ id: number; sku: string; name: string; ean: string }>();
  const words = (s: string) => new Set(s.toLowerCase().split(/[^a-zæøå0-9]+/).filter((w) => w.length >= 3));
  const stmts: D1PreparedStatement[] = [];
  for (const l of lines) {
    const text = l.name.toLowerCase();
    let best: { id: number; score: number } | null = null;
    for (const p of prods) {
      let score = 0;
      if (p.sku && text.includes(p.sku.toLowerCase())) score += 5;
      if (p.ean && text.includes(p.ean)) score += 5;
      const pw = words(p.name);
      const lw = words(l.name);
      let common = 0;
      for (const w of pw) if (lw.has(w)) common++;
      if (pw.size) score += (common / pw.size) * 3;
      if (score >= 2 && (!best || score > best.score)) best = { id: p.id, score };
    }
    if (best) stmts.push(db.prepare("UPDATE bilag_lines SET product_id = ?, product_state = 'forslag' WHERE id = ?").bind(best.id, l.id));
  }
  if (stmts.length) await db.batch(stmts);
}

// --- Rettelser ------------------------------------------------------------------------------------

export interface BilagData {
  doc_type: DocType;
  supplier_name: string;
  supplier_cvr: string;
  doc_number: string;
  doc_date: string;
  due_date: string;
  currency: string;
  net: number | null;
  vat: number | null;
  total: number | null;
  rounding: number;
  line_prices: 'ekskl' | 'inkl';
  payment_info: string;
  payment: BilagPayment;
  paid_by: string;
  note: string;
}

export interface LineInput {
  id: number | null;
  name: string;
  qty: number | null;
  unit: string;
  unit_price: number | null;
  discount: number;
  amount: number | null;
  vat_rate: number | null;
  product_id: number | null;
}

/** Ændring efter godkendelse: ny version, som skal godkendes igen. */
function reopenStmts(db: D1Database, b: BilagRow, why: string, actor: Actor, now: number): D1PreparedStatement[] {
  if (b.status !== 'godkendt' && b.status !== 'arkiveret') return [];
  const exported = b.exported_version !== null;
  return [
    db.prepare("UPDATE bilag SET version = version + 1, status = 'klar', updated_at = ? WHERE id = ?").bind(now, b.id),
    eventStmt(db, b.id, b.version + 1, 'ny_version', `Version ${b.version + 1}: ${why} Bilaget var godkendt og skal godkendes igen.${exported ? ' Version ' + b.exported_version + ' er eksporteret; bilaget er ændret siden eksport.' : ''}`, actor, now),
  ];
}

const show = (v: unknown) => (v === null || v === undefined || v === '' ? '(tom)' : typeof v === 'number' ? formatKr(v, { decimals: true }) : String(v));

export async function saveBilag(db: D1Database, b: BilagRow, d: BilagData, lines: LineInput[] | null, actor: Actor, now: number, opts: { confirmOCR?: boolean } = {}): Promise<string[]> {
  const changes: string[] = [];
  const keys: (keyof BilagData)[] = ['doc_type', 'supplier_name', 'supplier_cvr', 'doc_number', 'doc_date', 'due_date', 'currency', 'net', 'vat', 'total', 'rounding', 'line_prices', 'payment_info', 'payment', 'paid_by', 'note'];
  for (const k of keys) {
    if ((b as unknown as Record<string, unknown>)[k] !== d[k]) {
      const lbl = FIELD_LABEL[k] ?? (k === 'payment' ? 'Betaling' : k === 'paid_by' ? 'Udlæg af' : k === 'note' ? 'Intern bemærkning' : k);
      changes.push(k === 'payment' ? `Betaling: ${PAYMENT_LABEL[b.payment]} → ${PAYMENT_LABEL[d.payment]}` : `${lbl}: ${show((b as unknown as Record<string, unknown>)[k])} → ${show(d[k])}`);
    }
  }
  const old = await bilagLines(db, b.id);
  const confirmedOCR = !!b.ocr_provider && !!opts.confirmOCR && (uncertainOf(b).length > 0 || old.some((line) => !!line.uncertain));
  if (confirmedOCR) changes.push('OCR-forslag kontrolleret mod originalen.');
  const stmts: D1PreparedStatement[] = [];
  if (lines) {
    const keep = new Set(lines.map((line) => line.id));
    const linked = await db.prepare('SELECT line_id FROM bilag_allocations WHERE bilag_id = ? AND line_id IS NOT NULL AND (done_at IS NOT NULL OR purchase_line_id IS NOT NULL)').bind(b.id).all<{ line_id: number }>();
    if (linked.results.some((allocation) => !keep.has(allocation.line_id))) throw new Conflict('En linje knyttet til et registreret køb eller en varemodtagelse kan ikke fjernes. Bevar linjen, og registrér korrektioner under Indkøb eller Returer.');
  }
  if (confirmedOCR && !lines) stmts.push(db.prepare('UPDATE bilag_lines SET uncertain = 0 WHERE bilag_id = ?').bind(b.id));
  if (lines) {
    const keep = new Set(lines.map((l) => l.id).filter((x): x is number => x !== null));
    for (const o of old) if (!keep.has(o.id)) {
      stmts.push(db.prepare('DELETE FROM bilag_lines WHERE id = ?').bind(o.id));
      changes.push(`Linje fjernet: ${o.name}`);
    }
    lines.forEach((l, i) => {
      const o = l.id ? old.find((x) => x.id === l.id) : undefined;
      if (o) {
        const same = o.name === l.name && o.qty === l.qty && o.unit === l.unit && o.unit_price === l.unit_price && o.discount === l.discount && o.amount === l.amount && o.vat_rate === l.vat_rate && o.product_id === l.product_id;
        if (!same) changes.push(`Linje rettet: ${l.name}`);
        stmts.push(
          db
            .prepare(
              `UPDATE bilag_lines SET pos = ?, name = ?, qty = ?, unit = ?, unit_price = ?, discount = ?, amount = ?, vat_rate = ?, product_id = ?,
                 product_state = CASE WHEN ? IS NULL THEN '' WHEN product_id IS ? AND product_state = 'forslag' THEN 'forslag' ELSE 'godkendt' END,
                 uncertain = CASE WHEN ? THEN uncertain ELSE 0 END WHERE id = ?`,
            )
            .bind(i + 1, l.name, l.qty, l.unit, l.unit_price, l.discount, l.amount, l.vat_rate, l.product_id, l.product_id, l.product_id, confirmedOCR ? 0 : b.ocr_provider ? 1 : same ? 1 : 0, o.id),
        );
      } else {
        changes.push(`Linje tilføjet: ${l.name}`);
        stmts.push(
          db
            .prepare("INSERT INTO bilag_lines (bilag_id, pos, name, qty, unit, unit_price, discount, amount, vat_rate, product_id, product_state) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CASE WHEN ? IS NULL THEN '' ELSE 'godkendt' END)")
            .bind(b.id, i + 1, l.name, l.qty, l.unit, l.unit_price, l.discount, l.amount, l.vat_rate, l.product_id, l.product_id),
        );
      }
    });
  }
  if (!changes.length) return [];
  // Et felt, som brugeren har rettet eller bekræftet, er ikke længere usikkert
  const onlyInternal = changes.every((c) => /^(Betaling:|Udlæg af:|Intern bemærkning:)/.test(c));
  // Gemmes oplysningerne, har brugeren kontrolleret dem mod originalen
  const unc = b.ocr_provider && !confirmedOCR ? uncertainOf(b) : onlyInternal ? uncertainOf(b) : [];
  stmts.unshift(
    db
      .prepare(
        `UPDATE bilag SET doc_type = ?, supplier_name = ?, supplier_cvr = ?, doc_number = ?, doc_date = ?, due_date = ?, currency = ?, net = ?, vat = ?, total = ?,
           rounding = ?, line_prices = ?, payment_info = ?, payment = ?, paid_by = ?, note = ?, uncertain = ?,
           reading_source = CASE WHEN reading_source = '' THEN 'manuel' ELSE reading_source END,
           status = CASE WHEN status IN ('modtaget', 'under_aflaesning') THEN 'klar' ELSE status END, updated_at = ? WHERE id = ?`,
      )
      .bind(d.doc_type, d.supplier_name, d.supplier_cvr, d.doc_number, d.doc_date, d.due_date, d.currency, d.net, d.vat, d.total, d.rounding, d.line_prices, d.payment_info, d.payment, d.paid_by, d.note, JSON.stringify(unc), now, b.id),
  );
  // Betaling og interne bemærkninger ændrer ikke selve bilaget og kræver ikke ny godkendelse
  if (!onlyInternal) stmts.push(...reopenStmts(db, b, 'Oplysningerne er rettet.', actor, now));
  stmts.push(eventStmt(db, b.id, b.version + (onlyInternal || (b.status !== 'godkendt' && b.status !== 'arkiveret') ? 0 : 1), 'rettelse', changes.join(' · ').slice(0, 2000), actor, now));
  try { await db.batch(stmts); }
  catch (error) {
    if (String((error as Error).message).includes('BILAG_LINE_POSTED')) throw new Conflict('Linjen er knyttet til et registreret køb eller en varemodtagelse og kan ikke fjernes. Genindlæs siden.');
    throw error;
  }
  await refreshDuplicate(db, b.id, actor, now);
  return changes;
}

// --- Fordeling ------------------------------------------------------------------------------------

export interface AllocInput {
  line_id: number | null;
  target: AllocTarget;
  job_id: number | null;
  amount: number;
  action: AllocAction;
  purchase_line_id: number | null;
  product_id: number | null;
  qty: number | null;
  note: string;
}

export async function validateAlloc(db: D1Database, b: BilagRow, a: AllocInput): Promise<string | null> {
  if (a.target === 'job' && !a.job_id) return 'Vælg jobbet.';
  if (a.target !== 'job') a.job_id = null;
  if (a.target === 'drift' && a.action !== 'udgift') return 'Almindelig drift kan kun være en udgift uden lagerpåvirkning.';
  if (a.action === 'direkte_job' && a.target !== 'job') return 'Direkte køb kræver et job.';
  if (a.amount < 0) return 'Beløbet kan ikke være negativt.';
  if (a.job_id) {
    const j = await getJob(db, a.job_id);
    if (!j) return 'Jobbet findes ikke.';
  }
  if (a.action === 'eksisterende') {
    if (!a.purchase_line_id) return 'Vælg det køb eller den varemodtagelse, bilaget hører til.';
    const pl = await db.prepare('SELECT * FROM purchase_lines WHERE id = ?').bind(a.purchase_line_id).first<PurchaseLineRow>();
    if (!pl) return 'Købet findes ikke.';
    if ((pl.job_id ?? null) !== (a.target === 'job' ? a.job_id : null) && a.target !== 'drift') {
      return a.target === 'job' ? 'Købet hører ikke til det valgte job.' : 'Købet hører til et job. Vælg jobbet som mål.';
    }
    // Samme køb må kun knyttes til ét bilag (en kreditnota kan dog knyttes til samme køb)
    if (b.doc_type !== 'kreditnota') {
      const other = await db
        .prepare("SELECT a.bilag_id FROM bilag_allocations a JOIN bilag b ON b.id = a.bilag_id WHERE a.purchase_line_id = ? AND a.bilag_id <> ? AND b.doc_type <> 'kreditnota' AND b.status <> 'arkiveret' LIMIT 1")
        .bind(a.purchase_line_id, b.id)
        .first<{ bilag_id: number }>();
      if (other) return `Købet er allerede knyttet til ${bilagNo(other.bilag_id)}. Det tælles kun én gang.`;
    }
    a.product_id = pl.product_id;
  }
  if (a.action === 'ny_modtagelse' || a.action === 'direkte_job') {
    if (!a.qty || a.qty <= 0) return 'Angiv mængden.';
    if (a.action === 'ny_modtagelse' && !a.product_id) return 'En ny varemodtagelse på lageret kræver en vare med varenummer.';
  }
  if (a.line_id) {
    const l = await db.prepare('SELECT id FROM bilag_lines WHERE id = ? AND bilag_id = ?').bind(a.line_id, b.id).first();
    if (!l) return 'Linjen findes ikke på bilaget.';
  }
  return null;
}

export async function addAllocation(db: D1Database, b: BilagRow, a: AllocInput, actor: Actor, now: number): Promise<void> {
  const desc = `${TARGET_LABEL[a.target]}${a.job_id ? ` ${(await getJob(db, a.job_id))?.number ?? ''}` : ''}: ${formatKr(a.amount, { decimals: true })} (${ACTION_LABEL[a.action].toLowerCase()})`;
  await db.batch([
    db
      .prepare(
        `INSERT INTO bilag_allocations (bilag_id, line_id, target, job_id, amount, action, purchase_line_id, product_id, qty, match_state, note, created_by, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(b.id, a.line_id, a.target, a.job_id, a.amount, a.action, a.purchase_line_id, a.product_id, a.qty, a.action === 'eksisterende' ? 'godkendt' : '', a.note, actor.email, now),
    ...reopenStmts(db, b, 'Fordelingen er ændret.', actor, now),
    eventStmt(db, b.id, b.version, 'fordeling', `Fordelt: ${desc}.`, actor, now),
  ]);
}

export async function removeAllocation(db: D1Database, b: BilagRow, allocId: number, actor: Actor, now: number): Promise<string | null> {
  const a = await db.prepare('SELECT * FROM bilag_allocations WHERE id = ? AND bilag_id = ?').bind(allocId, b.id).first<AllocationRow>();
  if (!a) return 'Fordelingen findes ikke.';
  if (a.done_at) return 'Varemodtagelsen eller købet er allerede registreret på lageret/jobbet og kan ikke fjernes her. Ret det under Indkøb.';
  await db.batch([
    db.prepare('DELETE FROM bilag_allocations WHERE id = ?').bind(a.id),
    ...reopenStmts(db, b, 'Fordelingen er ændret.', actor, now),
    eventStmt(db, b.id, b.version, 'fordeling', `Fordeling fjernet: ${TARGET_LABEL[a.target]} ${formatKr(a.amount, { decimals: true })}.`, actor, now),
  ]);
  return null;
}

/** Forslag til eksisterende køb/varemodtagelser, som bilaget kan høre til (skal vælges af brugeren). */
export async function purchaseSuggestions(db: D1Database, b: BilagRow, lines: BilagLineRow[]): Promise<(PurchaseLineRow & { job_number: string | null; supplier_name: string | null; score: number; linked: number })[]> {
  const { results } = await db
    .prepare(
      `SELECT pl.*, j.number AS job_number, s.name AS supplier_name,
         (SELECT COUNT(*) FROM bilag_allocations a JOIN bilag bb ON bb.id = a.bilag_id WHERE a.purchase_line_id = pl.id AND bb.doc_type <> 'kreditnota' AND bb.status <> 'arkiveret') AS linked
       FROM purchase_lines pl LEFT JOIN jobs j ON j.id = pl.job_id LEFT JOIN suppliers s ON s.id = pl.supplier_id
       WHERE pl.cancelled = 0 AND pl.ordered > 0 ORDER BY pl.updated_at DESC LIMIT 300`,
    )
    .all<PurchaseLineRow & { job_number: string | null; supplier_name: string | null; linked: number }>();
  const lw = (s: string) => new Set(s.toLowerCase().split(/[^a-zæøå0-9]+/).filter((w) => w.length >= 3));
  const scored = results.map((pl) => {
    let score = 0;
    if (pl.supplier_name && b.supplier_name && b.supplier_name.toLowerCase().includes(pl.supplier_name.toLowerCase())) score += 2;
    if (pl.order_ref && b.doc_number && pl.order_ref === b.doc_number) score += 3;
    for (const l of lines) {
      if (l.product_id && l.product_id === pl.product_id) score += 3;
      const a = lw(l.name);
      const bw = lw(pl.name);
      let common = 0;
      for (const w of bw) if (a.has(w)) common++;
      if (bw.size && common / bw.size >= 0.5) score += 2;
      if (l.qty !== null && (l.qty === pl.received || l.qty === pl.ordered)) score += 1;
    }
    return { ...pl, score };
  });
  return scored.filter((x) => x.score >= 2 && !x.linked).sort((a, b) => b.score - a.score).slice(0, 6);
}

/**
 * Registrerer den lagerhandling, en fordeling beskriver (ny varemodtagelse eller direkte køb til job).
 * Sker kun ved et bevidst tryk; ændrer aldrig noget ved upload eller godkendelse.
 */
export async function performAllocation(env: Env, s: Settings, b: BilagRow, allocId: number, actor: Actor, now: number, run: (build: (tx: Tx) => Promise<void> | void) => Promise<{ ok: boolean; error?: string }>): Promise<string | null> {
  const db = env.DB;
  // Duplicate checks apply to photos and scans too, before any inventory action.
  await refreshDuplicate(db, b.id, actor, now);
  try {
    const result = await run(async (tx) => {
      const current = await getBilag(db, b.id);
      if (!current) throw new Conflict('Bilaget findes ikke.');
      const a = await db.prepare('SELECT * FROM bilag_allocations WHERE id = ? AND bilag_id = ?').bind(allocId, b.id).first<AllocationRow>();
      if (!a) throw new Conflict('Fordelingen findes ikke.');
      if (a.action !== 'ny_modtagelse' && a.action !== 'direkte_job') throw new Conflict('Denne fordeling påvirker ikke lageret.');
      if (a.done_at) throw new Conflict('Den er allerede registreret.');
      if (current.status === 'arkiveret') throw new Conflict('Et arkiveret bilag kan ikke registrere en ny varemodtagelse.');
      if (current.doc_type === 'kreditnota') throw new Conflict('En kreditnota registrerer ikke en ny positiv varemodtagelse. Brug Returer.');
      if (!a.qty) throw new Conflict('Mængden mangler.');
      const [lines, allocs] = await Promise.all([bilagLines(db, b.id), allocations(db, b.id)]);
      const checked = checkBilag(current, lines, allocs, s);
      if (checked.errors.length) throw new Conflict(checked.errors.join(' '));
      const job = a.job_id ? await getJob(db, a.job_id) : null;
      if (a.job_id && !job) throw new Conflict('Jobbet findes ikke.');
      const product = a.product_id ? await db.prepare('SELECT * FROM products WHERE id = ?').bind(a.product_id).first<{ id: number; sku: string; name: string; unit: string; whole_units: number }>() : null;
      if (a.product_id && !product) throw new Conflict('Varen findes ikke.');
      const line = a.line_id ? lines.find((l) => l.id === a.line_id) : null;
      const name = product?.name ?? line?.name ?? (current.supplier_name || 'Køb fra bilag');
      const unit = product?.unit ?? (line?.unit || 'stk.');
      const unitPrice = Math.round((a.amount * 1000) / a.qty);
      const listId = job ? await defaultJobList(db, job as JobRow, now) : await stockList(db, now);
      const deliver = a.action === 'direkte_job' ? 'arbejdssted' : 'lager';
      const ref = `${bilagNo(b.id)}${current.doc_number ? ` / ${current.doc_number}` : ''}`;
      // A concurrent integer-ID insert rolls this entire batch back. The ledger
      // retries the builder with a fresh ID; deleted IDs are not reused.
      const next = await db.prepare("SELECT MAX(COALESCE((SELECT seq FROM sqlite_sequence WHERE name = 'purchase_lines'), 0), COALESCE(MAX(id), 0)) + 1 AS id FROM purchase_lines").first<{ id: number }>();
      const pl: PurchaseLineRow = {
        id: next!.id, list_id: listId, job_id: job?.id ?? null, product_id: product?.id ?? null,
        sku: product?.sku ?? '', name, unit, supplier_id: current.supplier_id,
        qty: a.qty, ordered: a.qty, received: 0, unit_price: unitPrice, actual_price: null,
        expected_date: '', order_ref: ref, deliver_to: deliver, ready: 0, cancelled: 0, auto: 0,
        note: `Fra bilag ${bilagNo(b.id)}`, price_checked_at: null, retailer_id: null, created_at: now, updated_at: now,
      };
      tx.add(
        // This durable key is independent of the browser's one-use form token.
        // Purchase, receipt, linkage, completion and history commit together.
        db.prepare("INSERT INTO ops (token, kind, actor, created_at) VALUES (?, 'bilag-fordeling', ?, ?)").bind(`bilag-fordeling:${a.id}`, actor.email, now),
        db.prepare(`INSERT INTO purchase_lines (id, list_id, job_id, product_id, sku, name, unit, supplier_id, qty, ordered, unit_price, order_ref, deliver_to, note, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).bind(pl.id, pl.list_id, pl.job_id, pl.product_id, pl.sku, pl.name, pl.unit, pl.supplier_id, pl.qty, pl.ordered, pl.unit_price, pl.order_ref, pl.deliver_to, pl.note, now, now),
      );
      receiveLine(tx, pl, a.qty, unitPrice, !!product?.whole_units);
      if (!product && job && a.action === 'direkte_job') {
        tx.add(db.prepare(`INSERT INTO job_items (job_id, name, unit, qty, actual_cost, purchase_line_id, price_source, note, sort_order, created_by, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, 'bilag', ?, (SELECT COALESCE(MAX(sort_order), 0) + 1 FROM job_items WHERE job_id = ?), ?, ?, ?)`)
          .bind(job.id, name, unit, a.qty, unitPrice, pl.id, `Købt direkte til jobbet (${ref}). Registrér forbruget, når det er brugt.`, job.id, actor.email, now, now));
      }
      tx.add(
        db.prepare('UPDATE bilag_allocations SET purchase_line_id = ?, done_at = ?, done_by = ? WHERE id = ?').bind(pl.id, now, actor.email, a.id),
        eventStmt(db, b.id, current.version, 'lager', `${a.action === 'direkte_job' ? `Direkte køb til job ${job?.number} registreret (leveret til arbejdsstedet, ikke på hovedlageret og ikke registreret som brugt)` : `Varemodtagelse registreret på lageret${job ? `, til ${job.number}` : ''}`}: ${formatQty(a.qty)} ${unit} ${name}.`, actor, now),
      );
      if (job) tx.add(logStmt(db, job.id, 'bilag', `${a.action === 'direkte_job' ? 'Direkte køb til jobbet' : 'Varemodtagelse'} fra ${ref}: ${formatQty(a.qty)} ${unit} ${name}.`, actor, now));
    });
    return result.ok ? null : result.error ?? 'Registreringen kunne ikke gennemføres.';
  } catch (err) {
    // Never release completion after commit, even if a follow-up fails. The
    // next attempt sees done_at/the durable marker and cannot receive again.
    if (err instanceof Conflict) return err.message;
    throw err;
  }
}

// --- Status og godkendelse ------------------------------------------------------------------------

export async function approveBilag(db: D1Database, s: Settings, b: BilagRow, actor: Actor, now: number): Promise<string[]> {
  const [lines, allocs] = await Promise.all([bilagLines(db, b.id), allocations(db, b.id)]);
  const c = checkBilag(b, lines, allocs, s);
  if (c.errors.length) return c.errors;
  if (b.status === 'godkendt' && b.approved_version === b.version) return ['Bilaget er allerede godkendt.'];
  const stmts: D1PreparedStatement[] = [
    db.prepare("UPDATE bilag SET status = 'godkendt', approved_by = ?, approved_at = ?, approved_version = version, clarify = '', updated_at = ? WHERE id = ? AND version = ?").bind(actor.email, now, now, b.id, b.version),
    eventStmt(db, b.id, b.version, 'godkendt', `Godkendt (version ${b.version}): ${formatKr(b.total, { decimals: true })} inkl. moms, fordelt på ${allocs.length} ${allocs.length === 1 ? 'post' : 'poster'}.`, actor, now),
  ];
  // Faktiske priser fra bilaget på de knyttede køb (ændrer aldrig salgspriser eller udstedte fakturaer)
  if (b.doc_type !== 'kreditnota') {
    for (const a of allocs) {
      if (a.action !== 'eksisterende' || !a.purchase_line_id) continue;
      const pl = await db.prepare('SELECT * FROM purchase_lines WHERE id = ?').bind(a.purchase_line_id).first<PurchaseLineRow>();
      const qty = pl ? pl.received || pl.ordered : 0;
      if (!pl || !qty) continue;
      const price = Math.round((a.amount * 1000) / qty);
      if (pl.actual_price === price) continue;
      stmts.push(
        db.prepare('UPDATE purchase_lines SET actual_price = ?, updated_at = ? WHERE id = ?').bind(price, now, pl.id),
        db.prepare('UPDATE job_items SET actual_cost = ?, updated_at = ? WHERE purchase_line_id = ?').bind(price, now, pl.id),
        eventStmt(db, b.id, b.version, 'pris', `Faktisk pris på købet "${pl.name}": ${formatKr(pl.actual_price ?? pl.unit_price, { decimals: true })} → ${formatKr(price, { decimals: true })} pr. ${pl.unit}.`, actor, now),
      );
      if (pl.job_id) stmts.push(logStmt(db, pl.job_id, 'bilag', `Faktisk indkøbspris fra ${bilagNo(b.id)}: ${pl.name} ${formatKr(price, { decimals: true })} pr. ${pl.unit}.`, actor, now));
    }
  }
  const jobs = [...new Set(allocs.map((a) => a.job_id).filter((x): x is number => x !== null))];
  for (const j of jobs) stmts.push(logStmt(db, j, 'bilag', `${bilagNo(b.id)} godkendt (${b.supplier_name}).`, actor, now));
  // En godkendt kreditnota fra leverandøren markerer returen som krediteret
  if (b.doc_type === 'kreditnota') stmts.push(db.prepare("UPDATE returns SET credit_state = 'modtaget', updated_at = ? WHERE credit_bilag_id = ?").bind(now, b.id));
  await db.batch(stmts);
  return [];
}

export async function setStatus(db: D1Database, b: BilagRow, next: 'afklaring' | 'klar' | 'arkiveret', text: string, actor: Actor, now: number): Promise<string | null> {
  if (next === 'arkiveret' && b.status !== 'godkendt' && !b.dup_of) return 'Kun godkendte bilag og dubletter kan arkiveres.';
  if (next === 'klar' && b.status !== 'afklaring' && b.status !== 'arkiveret') return 'Bilaget er allerede til gennemgang.';
  if (b.status === 'arkiveret' && next === 'klar') {
    // Genåbn et arkiveret bilag: det bevarer sin godkendelse, hvis versionen er uændret
    await db.batch([
      db.prepare("UPDATE bilag SET status = CASE WHEN approved_version = version THEN 'godkendt' ELSE 'klar' END, updated_at = ? WHERE id = ?").bind(now, b.id),
      eventStmt(db, b.id, b.version, 'status', 'Genåbnet fra arkivet.', actor, now),
    ]);
    return null;
  }
  const label = next === 'afklaring' ? `Kræver afklaring${text ? `: ${text}` : ''}` : next === 'arkiveret' ? `Arkiveret${b.dup_of && b.status !== 'godkendt' ? ' som dublet' : ''}` : 'Afklaret, klar til gennemgang';
  await db.batch([
    db
      .prepare('UPDATE bilag SET status = ?, clarify = CASE WHEN ? = \'afklaring\' THEN ? ELSE clarify END, updated_at = ? WHERE id = ?')
      .bind(next === 'klar' && b.approved_version === b.version && b.approved_at ? 'godkendt' : next, next, text, now, b.id),
    eventStmt(db, b.id, b.version, 'status', label, actor, now),
  ]);
  return null;
}

// --- Oversigter -----------------------------------------------------------------------------------

export interface BilagFilter {
  q: string;
  status: string;
  payment: string;
  job: number | null;
  from: string;
  to: string;
  type: string;
  /** Medarbejdere ser kun egne bilag */
  owner: string | null;
}

export type BilagListRow = BilagRow & { jobs: string | null; uploader: string | null; payer: string | null };

export async function listBilag(db: D1Database, f: BilagFilter, limit = 300): Promise<BilagListRow[]> {
  const where: string[] = [];
  const args: (string | number)[] = [];
  if (f.q) {
    where.push("(b.supplier_name LIKE ? OR b.doc_number LIKE ? OR b.file_name LIKE ? OR b.supplier_cvr LIKE ? OR printf('B-%06d', b.id) LIKE ?)");
    const like = `%${f.q.replace(/[%_]/g, '')}%`;
    args.push(like, like, like, like, like);
  }
  if (f.status === 'aaben') where.push("b.status IN ('modtaget', 'under_aflaesning', 'klar', 'afklaring')");
  else if (f.status) {
    where.push('b.status = ?');
    args.push(f.status);
  }
  if (f.payment) {
    where.push('b.payment = ?');
    args.push(f.payment);
  }
  if (f.type) {
    where.push('b.doc_type = ?');
    args.push(f.type);
  }
  if (f.job === -1) where.push('NOT EXISTS (SELECT 1 FROM bilag_allocations a WHERE a.bilag_id = b.id AND a.job_id IS NOT NULL) AND b.job_hint IS NULL');
  else if (f.job) {
    where.push('(b.job_hint = ? OR EXISTS (SELECT 1 FROM bilag_allocations a WHERE a.bilag_id = b.id AND a.job_id = ?))');
    args.push(f.job, f.job);
  }
  if (f.from) {
    where.push("COALESCE(NULLIF(b.doc_date, ''), date(b.created_at, 'unixepoch')) >= ?");
    args.push(f.from);
  }
  if (f.to) {
    where.push("COALESCE(NULLIF(b.doc_date, ''), date(b.created_at, 'unixepoch')) <= ?");
    args.push(f.to);
  }
  if (f.owner) {
    where.push('(b.uploaded_by = ? OR b.paid_by = ?)');
    args.push(f.owner, f.owner);
  }
  const { results } = await db
    .prepare(
      `SELECT b.*, (SELECT group_concat(DISTINCT j.number) FROM bilag_allocations a JOIN jobs j ON j.id = a.job_id WHERE a.bilag_id = b.id) AS jobs,
         u.name AS uploader, pu.name AS payer
       FROM bilag b LEFT JOIN users u ON u.email = b.uploaded_by LEFT JOIN users pu ON pu.email = b.paid_by
       ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
       ORDER BY b.created_at DESC, b.id DESC LIMIT ${limit}`,
    )
    .bind(...args)
    .all<BilagListRow>();
  return results;
}

/** Bilag og jobbets andel for et job. */
export async function jobBilag(db: D1Database, jobId: number): Promise<(BilagRow & { share: number; actions: string })[]> {
  const { results } = await db
    .prepare(
      `SELECT b.*, COALESCE(SUM(a.amount), 0) AS share, group_concat(DISTINCT a.action) AS actions
       FROM bilag b LEFT JOIN bilag_allocations a ON a.bilag_id = b.id AND a.job_id = ?1
       WHERE b.job_hint = ?1 OR a.id IS NOT NULL GROUP BY b.id ORDER BY b.created_at DESC`,
    )
    .bind(jobId)
    .all<BilagRow & { share: number; actions: string }>();
  return results;
}

/**
 * Godkendte udgifter fra bilag på et job, som ikke allerede tæller via lagerforbrug eller indkøb
 * (kun "udgift uden lagerpåvirkning"; køb og varemodtagelser tæller via forbruget). En kreditnota
 * fra leverandøren trækkes fra.
 */
export async function jobBilagCost(db: D1Database, jobId: number): Promise<number> {
  const row = await db
    .prepare(
      `SELECT COALESCE(SUM(CASE WHEN b.doc_type = 'kreditnota' THEN -a.amount ELSE a.amount END), 0) AS n
       FROM bilag_allocations a JOIN bilag b ON b.id = a.bilag_id
       WHERE a.job_id = ? AND a.action = 'udgift' AND b.status IN ('godkendt', 'arkiveret') AND b.approved_version = b.version`,
    )
    .bind(jobId)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

/** Hvorfor bilaget ikke kan slettes (null = det kan). Godkendte, eksporterede og bilag med registreringer på lageret skal blive. */
export async function deleteBlocker(db: D1Database, b: BilagRow): Promise<string | null> {
  if (b.status === 'godkendt' || b.status === 'arkiveret' || b.approved_at) return 'Godkendte bilag kan ikke slettes, da de er en del af regnskabet.';
  if (b.exported_version !== null || b.export_id !== null) return 'Bilaget er eksporteret til bogholderen og kan ikke slettes.';
  const done = await db.prepare('SELECT COUNT(*) AS n FROM bilag_allocations WHERE bilag_id = ? AND done_at IS NOT NULL').bind(b.id).first<{ n: number }>();
  if (done && done.n > 0) return 'Bilaget har registreringer på lageret eller et job og kan ikke slettes.';
  const exp = await db.prepare("SELECT COUNT(*) AS n FROM export_items WHERE kind = 'bilag' AND ref_id = ?").bind(b.id).first<{ n: number }>();
  if (exp && exp.n > 0) return 'Bilaget er eksporteret til bogholderen og kan ikke slettes.';
  return null;
}

/** Sletter et bilag (med linjer, fordelinger og historik) og filen, hvis intet andet bruger den. */
export async function deleteBilag(db: D1Database, b: BilagRow): Promise<string | null> {
  const err = await deleteBlocker(db, b);
  if (err) return err;
  await db.prepare('DELETE FROM bilag WHERE id = ?').bind(b.id).run();
  for (const fid of new Set([b.file_id, b.preview_file_id].filter((x): x is number => x !== null))) {
    await db
      .prepare(
        `DELETE FROM files WHERE id = ?1
           AND NOT EXISTS (SELECT 1 FROM bilag WHERE file_id = ?1 OR preview_file_id = ?1)
           AND NOT EXISTS (SELECT 1 FROM exports WHERE file_id = ?1)`,
      )
      .bind(fid)
      .run();
  }
  return null;
}

/** Må brugeren se bilaget? Ejer og indkøber ser alle; medarbejdere egne uploads og egne udlæg. */
export function canSee(b: Pick<BilagRow, 'uploaded_by' | 'paid_by'>, u: { email: string; role: Role }): boolean {
  if (u.role === 'ejer' || u.role === 'indkober') return true;
  const e = u.email.toLowerCase();
  return b.uploaded_by.toLowerCase() === e || b.paid_by.toLowerCase() === e;
}

export function canEditData(b: Pick<BilagRow, 'status' | 'uploaded_by'>, u: { email: string; role: Role }): boolean {
  if (u.role === 'ejer' || u.role === 'indkober') return b.status !== 'arkiveret';
  return b.uploaded_by.toLowerCase() === u.email.toLowerCase() && !['godkendt', 'arkiveret'].includes(b.status);
}

export { todayDk };
