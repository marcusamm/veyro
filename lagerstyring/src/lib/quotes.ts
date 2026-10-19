// Prisoverslag til slutkunden.
//
//   Overslag ekskl. moms = materialernes salgsbeløb + arbejdsløn + andre fakturerbare omkostninger
//
// Arbejdsløn = forventede timer × fakturerbar timepris. Materialernes salgsbeløb er salgsprisen ×
// den forventede mængde (ikke købsmængden). En linje uden pris tæller aldrig som 0 kr.: overslaget
// markeres som ufuldstændigt. Hver gemt version er et låst øjebliksbillede, så senere prisopslag
// eller ændringer på jobbet aldrig ændrer en version, der er sendt til slutkunden.

import type { JobEntryRow, JobQuoteRow, JobRow } from '../env';
import { addDays, lineAmount, todayDk } from './format';
import { calcCtx, itemCalc, type ItemView } from './jobitems';
import type { Actor } from './ledger';
import type { Settings } from './settings';

export const QUOTE_ASSUMPTIONS =
  'Prisoverslaget bygger på de forventede mængder og timer og på de viste prisforudsætninger (materialepriser, timepris og øvrige omkostninger). ' +
  'Det er et overslag og ikke en fast pris. Ændres mængder, timer eller priser, ændres den endelige pris tilsvarende.';

export interface CompanyInfo {
  name: string;
  address: string;
  cvr: string;
  email: string;
  phone: string;
  bank_reg: string;
  bank_account: string;
}

export interface CustomerInfo {
  name: string;
  contact: string;
  address: string;
  email: string;
  phone: string;
  cvr: string;
  site_address: string;
}

export function companyInfo(s: Settings): CompanyInfo {
  return {
    name: s.company_name,
    address: s.company_address,
    cvr: s.company_cvr,
    email: s.company_email,
    phone: s.company_phone,
    bank_reg: s.bank_reg,
    bank_account: s.bank_account,
  };
}

export function customerInfo(j: JobRow): CustomerInfo {
  return {
    name: j.customer_name,
    contact: j.customer_contact,
    address: j.customer_address,
    email: j.customer_email,
    phone: j.customer_phone,
    cvr: j.customer_cvr,
    site_address: j.site_address,
  };
}

export interface QuoteMaterial {
  item_id: number;
  sku: string;
  name: string;
  qty: number;
  unit: string;
  sale_unit: number | null;
  amount: number | null;
  /** Prisforudsætning, fx "STARK, læst 19. okt. 2026, + 20 % påslag" */
  basis: string;
  missing: string;
}

export interface QuoteLine {
  entry_id: number;
  description: string;
  qty: number;
  unit: string;
  rate: number | null;
  amount: number | null;
}

export interface QuoteData {
  company: CompanyInfo;
  customer: CustomerInfo;
  job: { number: string; name: string; description: string; start_date: string; end_date: string };
  materials: QuoteMaterial[];
  labour: QuoteLine[];
  other: QuoteLine[];
  vat_rate: number;
  vat_registered: string;
  assumptions: string;
  terms: string;
  missing: string[];
}

export interface QuoteCalc {
  data: QuoteData;
  materials: number;
  labour: number;
  other: number;
  subtotal: number;
  vat: number;
  total: number;
  incomplete: boolean;
}

/** Momssats i hundrededele procent: 25 % (2500), medmindre virksomheden ikke er momsregistreret. */
export function vatRate(s: Settings): number {
  return s.vat_registered === 'nej' ? 0 : 2500;
}

export function vatOf(subtotal: number, rate: number): number {
  return Math.round((subtotal * rate) / 10000);
}

const dk = (oere: number) => (oere / 100).toFixed(2).replace('.', ',');

export function computeQuote(job: JobRow, items: ItemView[], entries: JobEntryRow[], s: Settings, now: number, retailerName: (id: number | null) => string): QuoteCalc {
  const ctx = calcCtx(job, s, now);
  const missing: string[] = [];
  const materials: QuoteMaterial[] = items
    .filter((it) => it.qty > 0)
    .map((it) => {
      const c = itemCalc(it, it.qty, ctx);
      const basisParts: string[] = [];
      if (it.cost_basis === 'lager' && it.product_id) basisParts.push('Fra eget lager');
      else if (c.publicUnit !== null) basisParts.push(`${it.price_source === 'manuel' ? 'Pris indtastet' : retailerName(it.price_retailer_id)}${it.price_source === 'demodata' ? ' (demodata)' : ''}`);
      if (it.sale_mode === 'paaslag') basisParts.push(`kostpris + ${c.markup} % påslag`);
      else if (it.sale_mode === 'offentlig') basisParts.push('offentlig pris');
      else basisParts.push('aftalt salgspris');
      if (c.saleUnit === null) missing.push(`${it.name}: ${c.missing || 'pris mangler'}`);
      return {
        item_id: it.id,
        sku: it.sku,
        name: it.name,
        qty: it.qty,
        unit: it.unit,
        sale_unit: c.saleUnit,
        amount: c.saleAmount,
        basis: basisParts.join(', '),
        missing: c.saleUnit === null ? c.missing || 'Pris mangler.' : '',
      };
    });
  const line = (e: JobEntryRow): QuoteLine => ({
    entry_id: e.id,
    description: [e.description, e.worker_type].filter(Boolean).join(' – ') || (e.type === 'tid' ? 'Arbejdstimer' : 'Omkostning'),
    qty: e.qty,
    unit: e.unit,
    rate: e.unit_price,
    amount: e.unit_price === null ? null : lineAmount(e.unit_price, e.qty),
  });
  const expected = entries.filter((e) => e.phase === 'forventet' && e.billable);
  const labour = expected.filter((e) => e.type === 'tid').map(line);
  const other = expected.filter((e) => e.type === 'omkostning').map(line);
  for (const l of [...labour, ...other]) if (l.rate === null) missing.push(`${l.description}: pris pr. ${l.unit} mangler`);
  const sum = (xs: { amount: number | null }[]) => xs.reduce((a, x) => a + (x.amount ?? 0), 0);
  const m = sum(materials);
  const l = sum(labour);
  const o = sum(other);
  const subtotal = m + l + o;
  const rate = vatRate(s);
  const vat = vatOf(subtotal, rate);
  return {
    data: {
      company: companyInfo(s),
      customer: customerInfo(job),
      job: { number: job.number, name: job.name, description: job.description, start_date: job.start_date, end_date: job.end_date },
      materials,
      labour,
      other,
      vat_rate: rate,
      vat_registered: s.vat_registered,
      assumptions: QUOTE_ASSUMPTIONS,
      terms: s.quote_note,
      missing,
    },
    materials: m,
    labour: l,
    other: o,
    subtotal,
    vat,
    total: subtotal + vat,
    incomplete: missing.length > 0,
  };
}

export async function jobQuotes(db: D1Database, jobId: number): Promise<JobQuoteRow[]> {
  const { results } = await db.prepare('SELECT * FROM job_quotes WHERE job_id = ? ORDER BY version DESC').bind(jobId).all<JobQuoteRow>();
  return results;
}

export async function getQuote(db: D1Database, id: number): Promise<JobQuoteRow | null> {
  return db.prepare('SELECT * FROM job_quotes WHERE id = ?').bind(id).first<JobQuoteRow>();
}

export function quoteData(q: JobQuoteRow): QuoteData {
  return JSON.parse(q.data) as QuoteData;
}

/** Gemmer en ny, låst version. Versionsnummeret er fortløbende pr. job (UNIQUE i databasen). */
export async function saveQuote(db: D1Database, jobId: number, calc: QuoteCalc, s: Settings, note: string, actor: Actor, now: number): Promise<number> {
  const validUntil = s.quote_valid_days > 0 ? addDays(todayDk(now * 1000), s.quote_valid_days) : '';
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const row = await db
        .prepare(
          `INSERT INTO job_quotes (job_id, version, data, materials, labour, other, subtotal, vat, total, incomplete, note, valid_until, created_by, created_at)
           VALUES (?1, (SELECT COALESCE(MAX(version), 0) + 1 FROM job_quotes WHERE job_id = ?1), ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13) RETURNING id, version`,
        )
        .bind(jobId, JSON.stringify(calc.data), calc.materials, calc.labour, calc.other, calc.subtotal, calc.vat, calc.total, calc.incomplete ? 1 : 0, note, validUntil, actor.email, now)
        .first<{ id: number; version: number }>();
      await db
        .prepare('INSERT INTO job_log (job_id, kind, text, actor, actor_name, created_at) VALUES (?, ?, ?, ?, ?, ?)')
        .bind(jobId, 'overslag', `Prisoverslag version ${row!.version} gemt: ${dk(calc.subtotal)} kr. ekskl. moms${calc.incomplete ? ' (ufuldstændigt)' : ''}.`, actor.email, actor.name, now)
        .run();
      return row!.id;
    } catch (err) {
      if (!String((err as Error)?.message).includes('UNIQUE') || attempt === 2) throw err;
    }
  }
  throw new Error('Prisoverslaget kunne ikke gemmes.');
}

/**
 * Det overslag, der gælder over for slutkunden: det seneste accepterede, ellers det seneste delte.
 * Salgspriserne herfra bruges på fakturaen, så en senere ændret indkøbspris ikke ændrer den aftalte pris.
 */
export async function agreedQuote(db: D1Database, jobId: number): Promise<JobQuoteRow | null> {
  return db
    .prepare('SELECT * FROM job_quotes WHERE job_id = ? AND (accepted_at IS NOT NULL OR shared_at IS NOT NULL) ORDER BY accepted_at IS NULL, version DESC LIMIT 1')
    .bind(jobId)
    .first<JobQuoteRow>();
}
