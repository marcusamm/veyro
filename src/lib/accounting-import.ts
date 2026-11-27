/** Conservative import/read adapters. They never write originals, transactions or ledger entries.
 * PDF extraction, invoice text reading and private OCR reuse the existing Veyro implementations.
 */
import { PDFDocument } from 'pdf-lib';
import { pdfText } from '../../lagerstyring/src/lib/pdftext';
import { datesIn, readText } from '../../lagerstyring/src/lib/bilagread';
import { extractReceiptText } from '../../lagerstyring/src/lib/ocr';

export interface BankImportOptions { account?: string; currency?: string }
export interface BankImportRow {
  date: string;
  description: string;
  merchant: string;
  amount_minor: number;
  currency: string;
  account_key: string;
  external_id: string | null;
  balance_minor: number | null;
  fingerprint: string;
  identity_keys: string[];
  identity_strength: 'external_id' | 'balance' | 'ambiguous';
  source_row: number;
}
export interface BankImportPreview {
  format: 'revolut-csv' | 'revolut-pdf';
  rows: BankImportRow[];
  warnings: string[];
  errors: string[];
  skipped: number;
}
export interface ReceiptSuggestion {
  supplier: string | null;
  date: string | null;
  total_minor: number | null;
  currency: string | null;
  vat_minor: number | null;
  account_code: string | null;
  description: string;
  kind: 'receipt' | 'single_bank_transaction' | 'multi_bank_statement';
  warnings: string[];
  uncertain: string[];
}
export type AccountingText =
  | { ok: true; pages: string[][]; source: 'pdf-tekst' | 'ocr'; provider: string; warnings: string[] }
  | { ok: false; pages: []; source: 'unread'; provider: ''; warnings: string[] };

const MAX_TEXT = 500_000;
const MAX_ROWS = 250;
const MAX_BYTES = 15 * 1024 * 1024;
const CURRENCIES = new Set(['DKK','EUR','USD','GBP','SEK','NOK','CHF','PLN','CZK','HUF','RON','BGN','AUD','CAD','NZD','SGD','HKD','ZAR','TRY','ILS']);
const clean = (s: string) => s.replace(/\u0000/g, '').trim();
const normalized = (s: string) => clean(s).normalize('NFKC').toLowerCase().replace(/[\s_.\-]+/g, ' ').trim();
const accountKey = (s: string) => clean(s).normalize('NFKC').toLowerCase().replace(/\s+/g, '');
export function normalizeBankMerchant(value: string): string {
  return normalized(value)
    .replace(/^(?:(?:card|kort)\s+)?(?:payment|betaling)\s+(?:to|til)\s+/,'')
    .replace(/^(?:refund|refunded|refundering|tilbagebetaling)(?:\s+(?:from|fra|af))?\s+/, '')
    .replace(/^(?:to|from|til|fra)\s+/, '')
    .replace(/\s+(?:refund|refundering)$/, '').trim();
}

/** Two decimal minor units only; never silently rounds a bank statement. */
export function parseBankMoney(raw: string): number | null {
  let s = clean(raw).replace(/\u00a0/g, ' ').replace(/[−–]/g, '-');
  if (!s || /^(?:-|—|n\/a)$/i.test(s)) return null;
  let negative = false;
  if (/^\(.*\)$/.test(s)) { negative = true; s = s.slice(1,-1).trim(); }
  // Contradictory signs must not silently turn a debit into a credit.
  const signs = s.match(/[+-]/g) || [];
  if (signs.length > 1 || (negative && signs.length)) return null;
  s = s.replace(/(?:DKK|EUR|USD|GBP|SEK|NOK|CHF|PLN|CZK|HUF|RON|BGN|AUD|CAD|NZD|SGD|HKD|ZAR|TRY|ILS|kr\.?|€|£|\$)/gi, '').replace(/\s/g, '');
  if (/^[+-]/.test(s)) { if (s[0] === '-') negative = !negative; s = s.slice(1); }
  if (s.endsWith('-')) { negative = !negative; s = s.slice(0,-1); }
  let major = '', decimals = '00';
  if (/^\d+$/.test(s)) major = s;
  else if (/^(?:\d+|\d{1,3}(?:\.\d{3})+),\d{1,2}$/.test(s)) {
    const parts = s.split(','); major = parts[0]!.replace(/\./g,''); decimals = parts[1]!.padEnd(2,'0');
  } else if (/^(?:\d+|\d{1,3}(?:,\d{3})+)\.\d{1,2}$/.test(s)) {
    const at = s.lastIndexOf('.'); major = s.slice(0,at).replace(/,/g,''); decimals = s.slice(at+1).padEnd(2,'0');
  } else return null;
  const amount = Number(major) * 100 + Number(decimals);
  return Number.isSafeInteger(amount) && amount <= 1_000_000_000_000 ? (negative ? -amount : amount) : null;
}
export function parseBankDate(raw: string): string | null {
  const valueText = clean(raw);
  // Accept a date and an optional time, never a range, a two-digit year or arbitrary prose.
  // ISO timestamps retain the bank's stated calendar day rather than converting time zones.
  const match = /^(\d{4}-\d{2}-\d{2}|\d{1,2}([./-])\d{1,2}\2\d{4}|\d{1,2}\.?\s+[a-zæøå]+\.?,?\s+\d{4}|[a-z]+\.?\s+\d{1,2},?\s+\d{4})(?:(?:T|\s+)(\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,6})?)?(Z|[+-]\d{2}:?\d{2})?)?$/i.exec(valueText);
  if (!match || (match[3] !== undefined && (+match[3] > 23 || +match[4]! > 59 || +(match[5] || 0) > 59))) return null;
  if (match[6] && match[6].toUpperCase() !== 'Z') {
    const zone = match[6].replace(':','');
    if (+zone.slice(1,3) > 14 || +zone.slice(3) > 59 || (+zone.slice(1,3) === 14 && +zone.slice(3) !== 0)) return null;
  }
  const candidates = datesIn(match[1]!);
  const date = candidates.length === 1 ? candidates[0] : undefined;
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
  const value = new Date(date + 'T00:00:00Z');
  return Number.isFinite(value.getTime()) && value.toISOString().slice(0,10) === date ? date : null;
}
function currencyOf(s: string): string | null {
  const code = clean(s).toUpperCase();
  return CURRENCIES.has(code) ? code : null;
}
function currenciesIn(text: string): string[] {
  return [...new Set((text.match(/\b[A-Z]{3}\b/g) || []).filter(c => CURRENCIES.has(c)))];
}
export function bankSemanticKey(row: Pick<BankImportRow,'account_key'|'currency'|'date'|'amount_minor'|'merchant'>): string {
  return JSON.stringify([accountKey(row.account_key),row.currency.toUpperCase(),row.date,row.amount_minor,normalizeBankMerchant(row.merchant)]);
}
function identify(row: Omit<BankImportRow,'fingerprint'|'identity_keys'|'identity_strength'>): BankImportRow {
  const identity_keys: string[] = [];
  if (row.external_id) identity_keys.push('id:' + JSON.stringify([row.account_key,row.currency,row.external_id.toLowerCase()]));
  if (row.balance_minor !== null) identity_keys.push('balance:' + JSON.stringify([row.account_key,row.currency,row.date,row.amount_minor,row.balance_minor,normalizeBankMerchant(row.merchant)]));
  return {...row, identity_keys, fingerprint:identity_keys[0] ?? 'ambiguous:' + bankSemanticKey(row), identity_strength:row.external_id ? 'external_id' : row.balance_minor !== null ? 'balance' : 'ambiguous'};
}
function finish(preview: BankImportPreview): BankImportPreview {
  const duplicate = new Map<string, BankImportRow>();
  const semantic = new Map<string, number>();
  for (const row of preview.rows) {
    for (const key of row.identity_keys) {
      const old = duplicate.get(key);
      if (old && bankSemanticKey(old) !== bankSemanticKey(row)) preview.errors.push(`Linje ${row.source_row}: samme transaktions-id har modstridende oplysninger. Importen skal kontrolleres.`);
      if (old?.external_id && row.external_id && old.external_id !== row.external_id && key.startsWith('balance:')) preview.warnings.push('To særskilte transaktions-id’er har samme beløb og saldo. De må ikke automatisk slås sammen; kontrollér begge betalinger.');
      duplicate.set(key,row);
    }
    const key = bankSemanticKey(row); semantic.set(key,(semantic.get(key) || 0)+1);
  }
  if (preview.rows.some(r => r.identity_strength === 'ambiguous')) preview.warnings.push('Nogle linjer mangler transaktions-id og løbende saldo. Mulige dubletter kræver et udtrykkeligt valg ved bekræftelse; ens køb må ikke automatisk slås sammen.');
  if ([...semantic.values()].some(n => n > 1)) preview.warnings.push('Flere linjer ligner hinanden. Kontrollér hver linje; de kan være særskilte betalinger.');
  if (!preview.rows.length && !preview.errors.length) preview.errors.push('Ingen gennemførte transaktioner kunne læses.');
  preview.errors = [...new Set(preview.errors)]; preview.warnings = [...new Set(preview.warnings)];
  return preview;
}
function empty(format: BankImportPreview['format']): BankImportPreview { return {format,rows:[],warnings:[],errors:[],skipped:0}; }
function cells(text: string, delimiter: string): string[][] {
  const rows: string[][] = []; let row: string[] = [], cell = '', quote = false, closed = false;
  for (let i=0; i<text.length; i++) {
    const ch = text[i]!;
    if (quote) {
      if (ch === '"' && text[i+1] === '"') {cell += '"'; i++;}
      else if (ch === '"') {quote = false; closed = true;}
      else cell += ch;
    } else if (ch === '"') {
      if (cell.trim() || closed) throw new Error('Ugyldigt CSV-citat.');
      quote = true;
    } else if (ch === delimiter) {row.push(cell); cell=''; closed=false;}
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i+1] === '\n') i++;
      row.push(cell); if (row.some(s => s.trim())) rows.push(row); row=[]; cell=''; closed=false;
    } else { if (closed && !/\s/.test(ch)) throw new Error('Ugyldig tekst efter CSV-citat.'); cell += ch; }
    if (rows.length > MAX_ROWS + 20 || cell.length > 10_000) throw new Error('CSV-filen er for stor. Del den i mindre perioder.');
  }
  if (quote) throw new Error('CSV-filen har et uafsluttet citat.');
  row.push(cell); if (row.some(s => s.trim())) rows.push(row);
  return rows;
}
const HEADERS = {
  date:['completed date','date completed','booking date','dato','date','gennemført dato','completed at'],
  started:['started date','date started','started at'],
  description:['description','beskrivelse','transaction description','reference','reference text','merchant','counterparty'],
  amount:['amount','beløb','amount (dkk)','amount (eur)','amount (gbp)','amount (usd)','transaction amount'],
  out:['money out','paid out','debit','udbetaling','penge ud','money out (dkk)'],
  into:['money in','paid in','credit','indbetaling','penge ind','money in (dkk)'],
  currency:['currency','valuta','transaction currency'],
  account:['account','konto','account number','iban','account id','account name'],
  id:['id','transaction id','transaction identifier','transaktions-id','transaktions id','transaction reference'],
  balance:['balance','saldo','balance (dkk)','balance (eur)','closing balance'],
  status:['state','status','transaction status'],
  fee:['fee','gebyr'],
} as const;
type Header = keyof typeof HEADERS;
function mapHeaders(row: string[]): Partial<Record<Header,number>> {
  const out: Partial<Record<Header,number>> = {};
  for (const [key, aliases] of Object.entries(HEADERS)) {
    const index = row.findIndex(v => (aliases as readonly string[]).some(a => normalized(a) === normalized(v)));
    if (index >= 0) out[key as Header] = index;
  }
  return out;
}
const complete = /^(?:completed|complete|gennemført|fulfilled|booked|bogført)$/i;
const incomplete = /^(?:pending|reverted|declined|failed|cancelled|canceled|afventer|afvist|annulleret)$/i;
function readRow(raw: string[], heads: Partial<Record<Header,number>>, opts: BankImportOptions, sourceRow: number, p: BankImportPreview): void {
  const get = (key: Header) => heads[key] === undefined ? '' : clean(raw[heads[key]!] || '');
  const fail = (message:string) => p.errors.push(`Linje ${sourceRow}: ${message}`);
  const status = get('status');
  if (incomplete.test(status)) {p.skipped++; return;}
  if (heads.status !== undefined && !complete.test(status)) {fail('ukendt eller manglende transaktionsstatus.'); return;}
  const date = parseBankDate(get('date') || get('started'));
  const description = get('description');
  const embeddedCurrencies = currenciesIn([get('amount'),get('out'),get('into'),get('balance')].join(' '));
  if (embeddedCurrencies.length > 1 || (get('currency') && embeddedCurrencies.length && embeddedCurrencies[0] !== get('currency').toUpperCase())) {fail('flere modstridende valutaer er angivet.');return;}
  const currency = currencyOf(get('currency') || embeddedCurrencies[0] || opts.currency || '');
  const sourceAccount = get('account');
  const account = accountKey(sourceAccount || opts.account || '');
  if (sourceAccount && opts.account && account !== accountKey(opts.account)) p.warnings.push('Bankkontoen i filen er brugt frem for det indtastede reservekontonavn. Kontrollér kontoidentiteten før import.');
  let amount: number | null = null;
  if (heads.out !== undefined || heads.into !== undefined) {
    const rawOut=get('out'), rawIn=get('into');
    const out = rawOut && rawOut !== '-' ? parseBankMoney(rawOut) : 0;
    const into = rawIn && rawIn !== '-' ? parseBankMoney(rawIn) : 0;
    if (out === null || into === null || out < 0 || into < 0 || (out > 0 && into > 0)) {fail('Money out/Money in er tvetydige.'); return;}
    amount = into - out;
    if (heads.amount !== undefined && get('amount') && parseBankMoney(get('amount')) !== amount) {fail('beløb og Money out/Money in er ikke enige.'); return;}
  } else amount = parseBankMoney(get('amount'));
  const balance = get('balance') ? parseBankMoney(get('balance')) : null;
  if (get('fee') && parseBankMoney(get('fee')) !== 0) {fail('særskilt gebyr er angivet; brug et udtog med bankens samlede Money out/Money in, så gebyret ikke tælles forkert.'); return;}
  if (!date) {fail('dato mangler eller er ugyldig.'); return;}
  if (!description || description.length > 500) {fail('beskrivelse mangler eller er for lang.'); return;}
  if (!currency) {fail('valuta mangler eller understøttes ikke. Angiv valuta for bankkontoen.'); return;}
  if (!account || account.length > 120) {fail('vælg en bankkonto til importen.'); return;}
  if (amount === null || amount === 0) {fail('et entydigt beløb med fortegn mangler.'); return;}
  if (get('balance') && balance === null) {fail('saldo kunne ikke læses.'); return;}
  if (get('id').length > 160) {fail('transaktions-id er for langt.'); return;}
  p.rows.push(identify({date,description,merchant:normalizeBankMerchant(description),amount_minor:amount,currency,account_key:account,external_id:get('id') || null,balance_minor:balance,source_row:sourceRow}));
}

/** Supports Revolut signed-amount and explicit Money out/Money in exports. Preview only. */
export function parseRevolutCsv(text: string, opts: BankImportOptions = {}): BankImportPreview {
  const p = empty('revolut-csv');
  if (text.length > MAX_TEXT) {p.errors.push('CSV-filen er for stor. Brug højst 250 transaktioner pr. import.');return p;}
  const source = text.replace(/^\uFEFF/,'');
  let parsed: string[][] = [], heads: Partial<Record<Header,number>> = {}, headerAt = -1;
  for (const delimiter of [',',';','\t']) {
    let rows: string[][];
    try {rows=cells(source,delimiter);} catch {continue;}
    const at=rows.slice(0,10).findIndex(row => {const h=mapHeaders(row);return (h.date !== undefined || h.started !== undefined) && h.description !== undefined && (h.amount !== undefined || h.out !== undefined || h.into !== undefined);});
    if (at >= 0) {parsed=rows;heads=mapHeaders(rows[at]!);headerAt=at;break;}
  }
  if (headerAt < 0) {p.errors.push('CSV-formatet genkendes ikke. Brug Revoluts transaktions-CSV med dato, beskrivelse og Amount eller Money out/Money in.');return p;}
  if (parsed.length-headerAt-1 > MAX_ROWS) {p.errors.push('Der er for mange transaktioner. Del importen i mindre perioder.');return p;}
  if (heads.status === undefined) p.warnings.push('CSV-filen har ingen statuskolonne. Importér kun et udtog over gennemførte transaktioner.');
  const headerCurrencies = currenciesIn(parsed[headerAt]!.join(' '));
  const rowOptions = {...opts,currency:headerCurrencies.length===1 ? headerCurrencies[0] : opts.currency};
  if (headerCurrencies.length>1 && heads.currency===undefined) {p.errors.push('CSV-overskriften indeholder flere valutaer uden en valuta på hver transaktion.');return p;}
  for (let i=headerAt+1;i<parsed.length;i++) {
    const row=parsed[i]!;
    if (row.length !== parsed[headerAt]!.length) {p.errors.push(`Linje ${i+1}: antallet af kolonner afviger fra overskriften.`);continue;}
    readRow(row,heads,rowOptions,i+1,p);
  }
  return finish(p);
}

const PDF_ACCOUNT = /\b(?:IBAN|Account(?: number)?|Konto(?:nummer)?)\s*[:#]?\s*([A-Z]{2}\d{2}(?:[ \t]?[A-Z0-9]){8,30})/i;
const TRANSACTION_LABEL = /^(?:transaction(?: details| confirmation)?|transaktion(?:soplysninger)?|payment confirmation)\s*$/i;
const DATE_LINE = /^(?:\d{4}-\d{2}-\d{2}|\d{1,2}[./-]\d{1,2}[./-]\d{2,4}|\d{1,2}\s+[a-zæøå]+\s+\d{4})\b/i;
function tableCells(line: string): string[] {
  if (line.includes('|')) return line.split('|').map(clean).filter((_,i,all) => !(i === 0 && !all[i]) && !(i === all.length-1 && !all[i]));
  if (line.includes('\t')) return line.split('\t').map(clean);
  return line.trim().split(/\s{2,}/).map(clean);
}
function labelValue(lines:string[], labels:string): string | null {
  const re = new RegExp(`^(?:${labels})\\s*[:#]?\\s*(.+)$`,'i');
  const exact = new RegExp(`^(?:${labels})\\s*[:#]?\\s*$`,'i');
  for (let i=0;i<lines.length;i++) {
    const line=lines[i]!.trim(); const m=re.exec(line);
    if (m && m[1]?.trim()) return m[1].trim();
    if (exact.test(line) && lines[i+1]?.trim()) return lines[i+1]!.trim();
  }
  return null;
}
function pdfAccounts(lines:string[]):string[] {
  return [...new Set([...lines.join('\n').matchAll(new RegExp(PDF_ACCOUNT.source,'gi'))].map(m=>accountKey(m[1]!)))];
}
function pdfDefaults(lines:string[], opts:BankImportOptions): BankImportOptions {
  const text=lines.join('\n'), cur=currenciesIn(text);
  return {account:pdfAccounts(lines)[0] || opts.account,currency:cur.length===1 ? cur[0] : cur.length>1 ? undefined : opts.currency};
}
/** Supported PDF layouts: explicit-column transaction tables and labelled single-transaction receipts.
 * Compressed/ambiguous tables are rejected, never flattened to a guessed payment total.
 */
export function parseRevolutPdfText(pages: string[][] | string[], opts: BankImportOptions = {}): BankImportPreview {
  const p=empty('revolut-pdf');
  const lines=pages.flatMap(page => Array.isArray(page) ? page : page.split(/\r?\n/)).map(clean).filter(Boolean);
  const text=lines.join('\n');
  if (text.length > MAX_TEXT || lines.length > MAX_ROWS*8) {p.errors.push('PDF-udtoget er for stort. Vælg en kortere periode.');return p;}
  if (!/\brevolut\b/i.test(text)) {p.errors.push('Dette er ikke et genkendt Revolut-transaktionsudtog.');return p;}
  if (pdfAccounts(lines).length > 1) {p.errors.push('PDF-filen angiver flere konti. Brug et udtog for én konto eller CSV med en konto på hver linje, så betalingerne ikke sammenblandes.');return p;}
  const defaults=pdfDefaults(lines,opts);
  let heads:Partial<Record<Header,number>> | null=null, columnCount=0, sawTable=false;
  for (let i=0;i<lines.length;i++) {
    const split=tableCells(lines[i]!);const h=mapHeaders(split);
    if ((h.date !== undefined || h.started !== undefined) && h.description !== undefined && (h.amount !== undefined || h.out !== undefined || h.into !== undefined)) {
      heads=h;columnCount=split.length;sawTable=true;continue;
    }
    if (!heads) continue;
    // Columns may put the date anywhere, and English month names may come first.
    // A row that looks structurally like the table must be validated, not silently skipped.
    if (split.length === columnCount && split.length > 1) {
      readRow(split,heads,defaults,i+1,p);
      continue;
    }
    if (!DATE_LINE.test(lines[i]!)) {
      if (/^\d{1,4}(?:[./-]\d|\s+[a-zæøå]{3})/i.test(lines[i]!)) p.errors.push(`Linje ${i+1}: ufuldstændig eller ukendt datolinje. Brug CSV, så ingen transaktioner udelades.`);
      continue;
    }
    if (split.length !== columnCount) {p.errors.push(`Linje ${i+1}: PDF-kolonnerne kan ikke adskilles sikkert. Brug Revolut-CSV for denne periode.`);continue;}
  }
  if (sawTable) {p.warnings.push('PDF-tabellen skal sammenholdes med originalen før import.');return finish(p);}

  // A labelled single transaction has no opening/closing balances masquerading as invoice totals.
  const details=lines.filter(l => TRANSACTION_LABEL.test(l)).length;
  const starts=lines.filter(l => /^(?:transaction id|transaktions-id)\s*[:#]/i.test(l)).length;
  if (details>1 || starts>1 || lines.filter(l => /^(?:Description|Beskrivelse|Merchant|Forhandler)\s*[:#]/i.test(l)).length>1) {p.errors.push('PDF-filen indeholder flere transaktionsblokke uden en understøttet tabel. Brug CSV.');return p;}
  const description=labelValue(lines,'Description|Beskrivelse|Merchant|Forhandler');
  const date=labelValue(lines,'Completed date|Completed at|Dato|Date');
  const status=labelValue(lines,'State|Status');
  const out=labelValue(lines,'Money out|Paid out|Debit');
  const into=labelValue(lines,'Money in|Paid in|Credit');
  const amount=labelValue(lines,'Amount|Beløb');
  if (!description || !date || (!out && !into && !amount)) {p.errors.push('PDF-layoutet kan ikke aflæses sikkert. Brug Revolut-CSV, eller registrér et enkelt bilag manuelt.');return p;}
  if (!status || !complete.test(status)) {p.errors.push('Et enkelt transaktionsudtog skal udtrykkeligt være gennemført.');return p;}
  if (!out && !into && amount && !/^[\s(]*[-+−]/.test(amount)) {p.errors.push('Beløbets retning fremgår ikke. Brug Money out/Money in eller et beløb med fortegn.');return p;}
  const raw=[date,description,status,labelValue(lines,'Currency|Valuta') || defaults.currency || '',labelValue(lines,'Transaction ID|Transaktions-ID') || '',labelValue(lines,'Balance|Saldo') || ''];
  const header:Partial<Record<Header,number>>={date:0,description:1,status:2,currency:3,id:4,balance:5};
  if (out || into) {header.out=6;header.into=7;raw.push(out || '',into || '');}
  else {header.amount=6;raw.push(amount!);}
  readRow(raw,header,defaults,1,p);
  return finish(p);
}

function blankSuggestion(kind:ReceiptSuggestion['kind'], warnings:string[]):ReceiptSuggestion {
  return {supplier:null,date:null,total_minor:null,currency:null,vat_minor:null,account_code:null,description:'',kind,warnings,uncertain:[]};
}
export function readAccountingReceipt(pages:string[][], opts:{ownName?:string;ownCvr?:string} = {}):ReceiptSuggestion {
  const lines=pages.flat(), text=lines.join('\n');
  const isBank=/account statement|transaction statement|kontoudtog/i.test(text) ||
    (/\brevolut\b/i.test(text) && /money out|money in|transaction confirmation|transaction details/i.test(text)) ||
    (/money out/i.test(text) && /money in/i.test(text));
  if (isBank) {
    // The dummy key is local parsing context only. It must never be persisted as a bank account.
    const preview=parseRevolutPdfText(pages,{account:'reading-only'});
    if (preview.rows.length !== 1 || preview.skipped > 0 || preview.errors.length) {
      const result=blankSuggestion('multi_bank_statement',['Et bankudtog med flere eller uafklarede transaktioner må ikke bogføres som ét køb. Brug Bankafstemning til at importere linjerne.',...preview.errors]);
      return result;
    }
    const row=preview.rows[0]!;
    if (row.amount_minor >= 0) return blankSuggestion('multi_bank_statement',['Dette er en indbetaling. Den må ikke aflæses som en købsudgift.']);
    const fee=/^basic plan fee$/i.test(row.description.trim());
    return {supplier:fee?'Revolut':null,date:row.date,total_minor:-row.amount_minor,currency:row.currency,vat_minor:null,account_code:fee?'7410':null,description:row.description,kind:'single_bank_transaction',warnings:['Banklinjen dokumenterer betalingen. Moms er ikke angivet og skal kontrolleres; intet momsbeløb er beregnet.'],uncertain:fee?['vat_minor']:['supplier','vat_minor','account_code']};
  }
  const read=readText(pages,{ownName:opts.ownName || 'Veyro',ownCvr:opts.ownCvr || '46857569'});
  const known=(key:keyof typeof read.values) => !read.uncertain.includes(key) ? read.values[key] : undefined;
  const supplier=labelValue(lines,'Supplier|Leverandør|Seller|Sælger');
  const total=known('total'), vat=known('vat'), date=known('doc_date'), currency=known('currency');
  const validDate=typeof date==='string' ? parseBankDate(date) : null;
  const result:ReceiptSuggestion={supplier:supplier?.slice(0,200) || (typeof known('supplier_name')==='string'?String(known('supplier_name')):null),date:validDate,total_minor:typeof total==='number' && total>0?total:null,currency:typeof currency==='string' && currenciesIn(text).length===1?currencyOf(currency):null,vat_minor:null,account_code:null,description:typeof read.values.doc_number==='string' ? read.values.doc_number : '',kind:'receipt',warnings:[...read.notes],uncertain:[]};
  // An explicit VAT amount must be present. A percentage alone must not consume the next Total line.
  const vatEvidence=lines.some((l,i)=> /(?:^|\s)(?:heraf\s+moms|moms|vat|tax)\b/i.test(l) && !/inkl|ekskl|excl|incl|vat\s*(?:no|nr|id)|moms\s*(?:nr|nummer)|grundlag/i.test(l) &&
    (/[\d][.,]\d{2}\b/.test(l.replace(/\d+(?:[.,]\d+)?\s*%\s*(?:on|of|af|på)\s+[\d.,]+/gi,'').replace(/\d+(?:[.,]\d+)?\s*%/g,'')) || /^\s*(?:[A-Z]{3}\s*)?\d+[.,]\d{2}\s*(?:[A-Z]{3}|kr\.?)?\s*$/.test(lines[i+1] || '') || /^\s*\d+[.,]\d{2}\s*(?:[A-Z]{3}|kr\.?)?\s*$/.test(lines[i-1] || '')));
  if (vatEvidence && typeof vat==='number' && vat>=0 && (result.total_minor===null || vat<=result.total_minor)) result.vat_minor=vat;
  if (currenciesIn(text).length>1) {result.currency=null;result.warnings.push('Flere valutaer er angivet. Vælg den valuta, som bilaget er udstedt i.');}
  if (/webhosting|web hosting|hosting fee|hosting subscription/i.test(text)) result.account_code='7300';
  else if (/software|software subscription|licen[cs]e|saas/i.test(text)) result.account_code='7320';
  for (const key of ['supplier','date','total_minor','currency','vat_minor','account_code'] as const) if (result[key]===null) result.uncertain.push(key);
  if (result.uncertain.length) result.warnings.push('Usikre felter står åbne. Kontrollér oplysningerne mod originalen før godkendelse.');
  return result;
}

/** All OCR traffic stays on the pre-existing private service binding. No public URL is accepted. */
export async function extractAccountingText(env:{RECEIPT_OCR?:Fetcher}, input:{bytes:Uint8Array;mime:string}):Promise<AccountingText> {
  const fail=(message:string):AccountingText=>({ok:false,pages:[],source:'unread',provider:'',warnings:[message]});
  if (!['application/pdf','image/jpeg','image/png'].includes(input.mime) || !input.bytes.length || input.bytes.length>MAX_BYTES) return fail('Brug PDF, JPG eller PNG på højst 15 MB. Originalen ændres ikke.');
  let expectedPages = 1;
  if (input.mime==='application/pdf') {
    try {
      const doc=await PDFDocument.load(input.bytes,{updateMetadata:false});
      expectedPages=doc.getPageCount();
      if (doc.getPageCount()>20) return fail('PDF-filen har mere end 20 sider. Del udtoget i mindre perioder.');
      const extracted=await pdfText(input.bytes,20);
      if (extracted.hasText && extracted.pages.every(p=>p.join('').replace(/\s/g,'').length>20)) {
        if (extracted.pages.flat().join('\n').length>MAX_TEXT) return fail('PDF-teksten er for stor. Del udtoget i mindre perioder.');
        return {ok:true,pages:extracted.pages,source:'pdf-tekst',provider:'Veyro PDF-tekst',warnings:[]};
      }
      // Mixed PDFs must OCR every page so a scanned page cannot disappear silently.
      if (doc.getPageCount()>10) return fail('OCR understøtter højst 10 sider. Originalen er gemt; del udtoget eller udfyld kladden manuelt.');
    } catch {return fail('PDF-filen er beskadiget eller krypteret. Originalen er gemt uændret; brug en ulåst kopi til aflæsning.');}
  }
  const ocr=await extractReceiptText(env,input);
  if (ocr.status!=='ok') return fail(ocr.message);
  if (ocr.pages.length !== expectedPages || ocr.pages.some(page=>page.replace(/\s/g,'').length<=20)) return fail('OCR kunne ikke aflæse alle sider fuldstændigt. Originalen er bevaret; brug CSV til bankudtog eller kontrollér kladden manuelt.');
  return {ok:true,pages:ocr.pages.map(p=>p.split(/\r?\n/)),source:'ocr',provider:ocr.provider,warnings:['OCR-tekst kan indeholde fejl. Kontrollér alle forslag mod originalen.']};
}
