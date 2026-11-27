/** Veyros fælles interne regnskab. Beløb er heltals-øre; bankimport er aldrig bogføring.
 * Mutationer bruger D1.batch (én transaktion), versionskontrol og databaseconstraints.
 * Kontrol af admin/session/CSRF foretages af den eksisterende adminmiddleware i ruten.
 */
import { nowSec, sha256Hex } from './crypto';
import { bankSemanticKey, type BankImportRow } from './accounting-import';

export class AccountingError extends Error {
  constructor(message: string, public status: 400 | 404 | 409 = 400) { super(message); }
}
export type AccountingActor = string | { email: string };
export type ReceiptKind = 'purchase' | 'sale' | 'purchase_credit' | 'sale_credit';
export type SourceKind = 'receipt' | 'single_bank_transaction' | 'multi_bank_statement';
export interface AccountRow { code: string; name: string; kind: 'income' | 'expense' | 'asset' | 'liability' | 'equity'; purpose: string; active: number; }
export interface ReceiptFields {
  kind: ReceiptKind;
  supplier: string;
  date: string;
  currency: string;
  gross_minor: number | null;
  vat_minor: number | null;
  deductible_vat_minor: number | null;
  base_gross_minor: number | null;
  base_vat_minor: number | null;
  base_deductible_vat_minor: number | null;
  account_code: string | null;
  settlement_account_code: string;
  note: string;
}
export interface ReceiptReading extends Partial<ReceiptFields> { source_kind?: SourceKind; reading_source?: string; reading_note?: string; uncertain?: string[] | string; }
export interface ReceiptRow extends ReceiptFields {
  id: number; file_id: number; file_name: string; status: 'draft' | 'posted'; version: number;
  source_kind: SourceKind; reading_source: string; reading_note: string; uncertain: string;
  correction_of: number | null; created_by: string; created_at: number; updated_at: number;
  bank_line_id: number | null; journal_id: number | null; reversal_id: number | null;
}
export interface BankLineRow {
  id: number; import_id: number; source_row: number; date: string; description: string; merchant: string;
  amount_minor: number; currency: string; account_key: string; external_id: string | null;
  balance_minor: number | null; semantic_key: string; hidden: number; hidden_reason: string; created_at: number;
  receipt_id: number | null; journal_id: number | null;
}
export interface ImportRow {
  id: number; file_id: number; file_name: string; format: 'csv' | 'pdf'; rows_json: string; warnings_json: string;
  digest: string; status: 'preview' | 'confirmed'; created_by: string; created_at: number; confirmed_by: string | null; confirmed_at: number | null;
}
export type ImportResolution = 'new' | number;
export interface PreviewLine extends BankImportRow {
  duplicate_status: 'new' | 'duplicate' | 'review' | 'conflict'; existing_id: number | null; candidate_ids: number[];
}
export interface ImportPreview extends ImportRow { rows: PreviewLine[]; warnings: string[]; bank_revision: number; }
export interface JournalRow {
  id: number; receipt_id: number; bank_line_id: number | null; reversal_of: number | null;
  operation_key: string; date: string; description: string; currency: 'DKK'; status: 'pending' | 'posted'; created_by: string; created_at: number;
}
export interface AccountingEvent { id: number; entity_type: string; entity_id: number; action: string; detail: string; actor: string; created_at: number; }

const receiptSelect = `SELECT r.*, l.bank_line_id, j.id AS journal_id, rev.id AS reversal_id FROM accounting_receipts r
  LEFT JOIN accounting_bank_links l ON l.receipt_id=r.id
  LEFT JOIN accounting_journals j ON j.receipt_id=r.id AND j.reversal_of IS NULL AND j.status='posted'
  LEFT JOIN accounting_journals rev ON rev.reversal_of=j.id AND rev.status='posted'`;
const bankSelect = `SELECT b.*, l.receipt_id, j.id AS journal_id FROM accounting_bank_lines b
  LEFT JOIN accounting_bank_links l ON l.bank_line_id=b.id
  LEFT JOIN accounting_journals j ON j.receipt_id=l.receipt_id AND j.reversal_of IS NULL AND j.status='posted'`;
const kinds: ReceiptKind[] = ['purchase', 'sale', 'purchase_credit', 'sale_credit'];
const fields = ['kind','supplier','date','currency','gross_minor','vat_minor','deductible_vat_minor','base_gross_minor','base_vat_minor','base_deductible_vat_minor','account_code','settlement_account_code','note'] as const;
const moneyFields = ['gross_minor','vat_minor','deductible_vat_minor','base_gross_minor','base_vat_minor','base_deductible_vat_minor'] as const;
const defaults: ReceiptFields = { kind:'purchase', supplier:'', date:'', currency:'', gross_minor:null, vat_minor:null, deductible_vat_minor:null, base_gross_minor:null, base_vat_minor:null, base_deductible_vat_minor:null, account_code:null, settlement_account_code:'5820', note:'' };
const actorEmail = (actor: AccountingActor) => typeof actor === 'string' ? actor : actor.email;
const idOk = (id: number) => Number.isSafeInteger(id) && id > 0;
const moneyOk = (n: unknown) => typeof n === 'number' && Number.isSafeInteger(n) && Math.abs(n) <= 100_000_000_000;
export function accountingDate(value: string): boolean {
  if(!/^\d{4}-\d{2}-\d{2}$/.test(value)||value<'1900-01-01'||value>'2199-12-31')return false;
  const date=new Date(value+'T12:00:00Z');
  return Number.isFinite(date.getTime())&&date.toISOString().slice(0,10)===value;
}
function guard(db: D1Database, sql: string, values: unknown[] = []): D1PreparedStatement {
  return db.prepare(`INSERT INTO accounting_assertions(valid) SELECT CASE WHEN (${sql}) THEN 1 ELSE 0 END`).bind(...values);
}
function event(db: D1Database, actor: AccountingActor, entity: string, id: number, action: string, detail: unknown, at = nowSec()): D1PreparedStatement {
  return db.prepare('INSERT INTO accounting_events(entity_type,entity_id,action,detail,actor,created_at) VALUES(?,?,?,?,?,?)')
    .bind(entity,id,action,JSON.stringify(detail),actorEmail(actor),at);
}
async function transact(db: D1Database, statements: D1PreparedStatement[]): Promise<void> {
  try { await db.batch([...statements, db.prepare('DELETE FROM accounting_assertions')]); }
  catch (error) {
    if (/constraint|immutable|must balance|use a reversal/i.test(String(error))) throw new AccountingError('Data er ændret, eller registreringen ville bryde regnskabsreglerne. Genindlæs siden og prøv igen.',409);
    throw error;
  }
}
export async function accountingEvents(db: D1Database, entity: string, id: number): Promise<AccountingEvent[]> {
  return (await db.prepare('SELECT * FROM accounting_events WHERE entity_type=? AND entity_id=? ORDER BY id DESC').bind(entity,id).all<AccountingEvent>()).results;
}
export async function searchAccounts(db: D1Database, search = ''): Promise<AccountRow[]> {
  const rows = (await db.prepare('SELECT * FROM accounting_accounts WHERE active=1 ORDER BY code').all<AccountRow>()).results;
  const terms = search.trim().toLocaleLowerCase('da-DK').split(/\s+/).filter(Boolean);
  return rows.filter(row => terms.every(term => `${row.code} ${row.name}`.toLocaleLowerCase('da-DK').includes(term)));
}
export async function getReceipt(db: D1Database, id: number): Promise<ReceiptRow | null> {
  return db.prepare(`${receiptSelect} WHERE r.id=?`).bind(id).first<ReceiptRow>();
}
export async function listReceipts(db: D1Database, opts: { status?: 'draft' | 'posted'; from?: string; to?: string } = {}): Promise<ReceiptRow[]> {
  const conditions: string[] = [], values: string[] = [];
  if (opts.status) { conditions.push('r.status=?'); values.push(opts.status); }
  if (opts.from) { conditions.push('r.date>=?'); values.push(opts.from); }
  if (opts.to) { conditions.push('r.date<=?'); values.push(opts.to); }
  return (await db.prepare(`${receiptSelect}${conditions.length ? ' WHERE '+conditions.join(' AND ') : ''} ORDER BY r.created_at DESC,r.id DESC`).bind(...values).all<ReceiptRow>()).results;
}
function draftFields(input: Partial<ReceiptFields>, previous: ReceiptFields = defaults): ReceiptFields {
  const next = { ...previous };
  for (const key of fields) if (Object.hasOwn(input,key)) (next as unknown as Record<string, unknown>)[key] = input[key];
  if (!kinds.includes(next.kind)) throw new AccountingError('Vælg køb, salg eller kreditnota.');
  for (const key of ['supplier','date','currency','settlement_account_code','note'] as const) if (typeof next[key] !== 'string') throw new AccountingError('Ugyldigt tekstfelt.');
  next.supplier = next.supplier.trim().slice(0,250); next.note = next.note.trim().slice(0,4000);
  next.currency = next.currency.trim().toUpperCase(); next.date = next.date.trim();
  if (next.currency && !/^[A-Z]{3}$/.test(next.currency)) throw new AccountingError('Valuta skal være en kode på tre bogstaver.');
  if (next.date && !accountingDate(next.date)) throw new AccountingError('Datoen er ugyldig.');
  if (next.account_code === '') next.account_code = null;
  for (const key of moneyFields) {
    const n = next[key];
    if (n !== null && (!moneyOk(n) || n < 0 || (key.includes('gross') && n === 0))) throw new AccountingError('Beløb skal være gyldige hele øre; totalen skal være større end nul.');
  }
  for (const prefix of ['', 'base_'] as const) {
    const gross = next[`${prefix}gross_minor`], vat = next[`${prefix}vat_minor`], deductible = next[`${prefix}deductible_vat_minor`];
    if (vat !== null && gross !== null && vat > gross) throw new AccountingError('Moms kan ikke være større end totalen.');
    if (deductible !== null && vat !== null && deductible > vat) throw new AccountingError('Fradragsberettiget moms kan ikke overstige angivet moms.');
  }
  return Object.fromEntries(fields.map(key=>[key,next[key]])) as unknown as ReceiptFields;
}
function readingMeta(reading: ReceiptReading, old?: ReceiptRow): { source: SourceKind; method: string; note: string; uncertain: string } {
  const source = old?.source_kind === 'multi_bank_statement' ? 'multi_bank_statement' : reading.source_kind ?? old?.source_kind ?? 'receipt';
  if (!['receipt','single_bank_transaction','multi_bank_statement'].includes(source)) throw new AccountingError('Ugyldig dokumenttype.');
  const uncertain = Array.isArray(reading.uncertain) ? reading.uncertain : (()=>{try{return JSON.parse(reading.uncertain || '[]')}catch{return []}})();
  return { source, method: String(reading.reading_source ?? old?.reading_source ?? '').slice(0,100), note: String(reading.reading_note ?? old?.reading_note ?? '').slice(0,8000), uncertain:JSON.stringify(Array.isArray(uncertain) ? uncertain.filter(x=>typeof x==='string').slice(0,30) : []) };
}
export async function createReceipt(db: D1Database, actor: AccountingActor, input: { file_id: number; file_name: string; reading?: ReceiptReading; bank_line_id?: number | null }): Promise<ReceiptRow> {
  if (!idOk(input.file_id)) throw new AccountingError('Originalfilen mangler.');
  const existing = await db.prepare('SELECT id FROM accounting_receipts WHERE file_id=? AND correction_of IS NULL').bind(input.file_id).first<{id:number}>();
  if (existing) {
    if (input.bank_line_id) await linkReceipt(db,actor,existing.id,input.bank_line_id);
    return (await getReceipt(db,existing.id))!;
  }
  const values = draftFields(input.reading || {}), meta = readingMeta(input.reading || {}), at=nowSec();
  try {
    await transact(db,[
      db.prepare(`INSERT INTO accounting_receipts(file_id,file_name,${fields.join(',')},source_kind,reading_source,reading_note,uncertain,created_by,created_at,updated_at) VALUES(${Array(2+fields.length+7).fill('?').join(',')})`)
        .bind(input.file_id,input.file_name.slice(0,200),...fields.map(k=>values[k]),meta.source,meta.method,meta.note,meta.uncertain,actorEmail(actor),at,at),
      db.prepare(`INSERT INTO accounting_events(entity_type,entity_id,action,detail,actor,created_at) SELECT 'receipt',id,'uploaded',?, ?,? FROM accounting_receipts WHERE file_id=? AND correction_of IS NULL`)
        .bind(JSON.stringify({file_id:input.file_id,reading_source:meta.method}),actorEmail(actor),at,input.file_id),
    ]);
  } catch(error) {
    const raced = await db.prepare('SELECT id FROM accounting_receipts WHERE file_id=? AND correction_of IS NULL').bind(input.file_id).first<{id:number}>();
    if (!raced) throw error;
  }
  const row = await db.prepare('SELECT id FROM accounting_receipts WHERE file_id=? AND correction_of IS NULL').bind(input.file_id).first<{id:number}>();
  if (!row) throw new AccountingError('Bilaget kunne ikke oprettes.',409);
  if (input.bank_line_id) await linkReceipt(db,actor,row.id,input.bank_line_id);
  return (await getReceipt(db,row.id))!;
}
async function saveDraft(db: D1Database, actor: AccountingActor, id: number, version: number, input: Partial<ReceiptFields>, reading?: ReceiptReading): Promise<ReceiptRow> {
  const previous = await getReceipt(db,id);
  if (!previous) throw new AccountingError('Bilaget findes ikke.',404);
  if (previous.status !== 'draft') throw new AccountingError('Bogførte bilag ændres med en sporbar tilbageførsel.',409);
  const next = draftFields(input,previous), meta=readingMeta(reading ?? {},previous), at=nowSec();
  await transact(db,[
    guard(db,"EXISTS(SELECT 1 FROM accounting_receipts WHERE id=? AND version=? AND status='draft')",[id,version]),
    db.prepare(`UPDATE accounting_receipts SET ${fields.map(k=>`${k}=?`).join(',')},source_kind=?,reading_source=?,reading_note=?,uncertain=?,version=version+1,updated_at=? WHERE id=?`)
      .bind(...fields.map(k=>next[k]),meta.source,meta.method,meta.note,meta.uncertain,at,id),
    event(db,actor,'receipt',id,reading?'reread':'draft_saved',{before:Object.fromEntries(fields.map(k=>[k,previous[k]])),after:next,reading_source:meta.method},at),
  ]);
  return (await getReceipt(db,id))!;
}
export const saveReceiptDraft = (db:D1Database,actor:AccountingActor,id:number,version:number,fields:Partial<ReceiptFields>) => saveDraft(db,actor,id,version,fields);
export const applyReceiptReading = (db:D1Database,actor:AccountingActor,id:number,version:number,reading:ReceiptReading) => saveDraft(db,actor,id,version,reading,reading);

function expectedBankAmount(receipt: Pick<ReceiptFields,'kind'|'gross_minor'>): number | null {
  if (receipt.gross_minor===null) return null;
  return (receipt.kind==='purchase'||receipt.kind==='sale_credit' ? -1 : 1)*receipt.gross_minor;
}
export async function getBankLine(db:D1Database,id:number):Promise<BankLineRow|null> { return db.prepare(`${bankSelect} WHERE b.id=?`).bind(id).first<BankLineRow>(); }
export async function listBankLines(db:D1Database,opts:{hidden?:boolean;missing?:boolean;from?:string;to?:string;account?:string;currency?:string}={}):Promise<BankLineRow[]> {
  const clauses:string[]=[], values:unknown[]=[];
  if (opts.hidden!==undefined) {clauses.push('b.hidden=?');values.push(opts.hidden?1:0);}
  if (opts.missing) clauses.push('b.amount_minor<0 AND l.receipt_id IS NULL AND b.hidden=0');
  if (opts.from) {clauses.push('b.date>=?');values.push(opts.from);}
  if (opts.to) {clauses.push('b.date<=?');values.push(opts.to);}
  if (opts.account) {clauses.push('b.account_key=?');values.push(opts.account);}
  if (opts.currency) {clauses.push('b.currency=?');values.push(opts.currency);}
  return (await db.prepare(`${bankSelect}${clauses.length?' WHERE '+clauses.join(' AND '):''} ORDER BY b.date DESC,b.id DESC`).bind(...values).all<BankLineRow>()).results;
}
export async function linkReceipt(db:D1Database,actor:AccountingActor,receiptId:number,lineId:number):Promise<void> {
  const [receipt,line]=await Promise.all([getReceipt(db,receiptId),getBankLine(db,lineId)]);
  if(!receipt||!line) throw new AccountingError('Bilag eller banklinje findes ikke.',404);
  if(line.receipt_id===receiptId) return;
  if(receipt.reversal_id!==null) throw new AccountingError('Den oprindelige postering er tilbageført. Tilknyt banklinjen til rettelseskladden.',409);
  if(line.hidden) throw new AccountingError('Gendan banklinjen, før den tilknyttes.');
  if(line.receipt_id!==null||receipt.bank_line_id!==null) throw new AccountingError('Bilaget eller banklinjen er allerede tilknyttet.',409);
  if(receipt.source_kind==='multi_bank_statement') throw new AccountingError('Et udtog med flere poster kan ikke bruges som ét købsbilag.');
  if(receipt.currency&&receipt.currency!==line.currency) throw new AccountingError('Bilag og banklinje skal have samme valuta.');
  const amount=expectedBankAmount(receipt);
  if(amount!==null&&amount!==line.amount_minor) throw new AccountingError('Bilagets beløb og fortegn skal svare til banklinjen.');
  await transact(db,[
    guard(db,'EXISTS(SELECT 1 FROM accounting_receipts WHERE id=? AND version=?)',[receiptId,receipt.version]),
    guard(db,'EXISTS(SELECT 1 FROM accounting_bank_lines WHERE id=? AND hidden=0)',[lineId]),
    db.prepare('INSERT INTO accounting_bank_links(bank_line_id,receipt_id,created_by,created_at) VALUES(?,?,?,?)').bind(lineId,receiptId,actorEmail(actor),nowSec()),
    event(db,actor,'receipt',receiptId,'bank_linked',{bank_line_id:lineId}),
    event(db,actor,'bank_line',lineId,'receipt_linked',{receipt_id:receiptId}),
  ]);
}
export async function unlinkReceipt(db:D1Database,actor:AccountingActor,receiptId:number,version:number):Promise<void> {
  const receipt=await getReceipt(db,receiptId);if(!receipt)throw new AccountingError('Bilaget findes ikke.',404);
  if(receipt.status!=='draft')throw new AccountingError('Et bogført bilags banktilknytning bevares i historikken.',409);
  if(receipt.bank_line_id===null)return;
  await transact(db,[guard(db,"EXISTS(SELECT 1 FROM accounting_receipts WHERE id=? AND version=? AND status='draft')",[receiptId,version]),db.prepare('DELETE FROM accounting_bank_links WHERE receipt_id=?').bind(receiptId),event(db,actor,'receipt',receiptId,'bank_unlinked',{bank_line_id:receipt.bank_line_id}),event(db,actor,'bank_line',receipt.bank_line_id,'receipt_unlinked',{receipt_id:receiptId})]);
}
export function isRefundPair(a:Pick<BankLineRow,'id'|'merchant'|'account_key'|'currency'|'amount_minor'>,b:Pick<BankLineRow,'id'|'merchant'|'account_key'|'currency'|'amount_minor'>):boolean {
  return a.id!==b.id && !!a.merchant.trim() && a.merchant===b.merchant && a.account_key===b.account_key && a.currency===b.currency && a.amount_minor===-b.amount_minor;
}
export async function refundCandidates(db:D1Database,id:number):Promise<BankLineRow[]> {
  const line=await getBankLine(db,id);if(!line||line.hidden||!line.merchant.trim())return[];
  return (await db.prepare(`${bankSelect} WHERE b.id<>? AND b.hidden=0 AND b.merchant=? AND b.account_key=? AND b.currency=? AND b.amount_minor=? ORDER BY b.date,b.id`).bind(line.id,line.merchant,line.account_key,line.currency,-line.amount_minor).all<BankLineRow>()).results;
}
export async function setBankLinesHidden(db:D1Database,actor:AccountingActor,ids:number[],hidden:boolean,reason='Fjernet fra mangellisten'):Promise<void> {
  const unique=[...new Set(ids)];
  if(unique.length<1||unique.length>2||unique.some(id=>!idOk(id)))throw new AccountingError('Vælg én linje eller et køb med fuld refundering.');
  const rows=await Promise.all(unique.map(id=>getBankLine(db,id)));
  if(rows.some(row=>!row))throw new AccountingError('Banklinjen findes ikke.',404);
  if(unique.length===2&&!isRefundPair(rows[0]!,rows[1]!))throw new AccountingError('Parret skal have samme forhandler, konto og valuta samt modsatte beløb af samme størrelse.');
  await transact(db,unique.flatMap(id=>[
    db.prepare('UPDATE accounting_bank_lines SET hidden=?,hidden_reason=? WHERE id=?').bind(hidden?1:0,hidden?reason.slice(0,500):'',id),
    event(db,actor,'bank_line',id,hidden?'hidden':'restored',{pair:unique.length===2?unique:null,reason:hidden?reason:''}),
  ]));
}

function validateBankRow(row:BankImportRow):void {
  if(!accountingDate(row.date)||!moneyOk(row.amount_minor)||row.amount_minor===0||!/^[A-Z]{3}$/.test(row.currency)||!row.account_key?.trim()||row.account_key.length>200||!row.description?.trim()||row.description.length>2000||!Number.isSafeInteger(row.source_row)||row.source_row<1)throw new AccountingError('Bankfilen indeholder en ugyldig dato, konto, valuta eller et ugyldigt beløb.');
  if(row.balance_minor!==null&&!moneyOk(row.balance_minor))throw new AccountingError('Bankfilens saldo er ugyldig.');
  if(!Array.isArray(row.identity_keys)||row.identity_keys.length>3||row.identity_keys.some(key=>typeof key!=='string'||!key||key.length>2000))throw new AccountingError('Bankfilens transaktionsidentitet er ugyldig.');
}
export async function createImportPreview(db:D1Database,actor:AccountingActor,input:{file_id:number;file_name:string;format:'csv'|'pdf';rows:BankImportRow[];warnings?:string[]}):Promise<ImportPreview> {
  if(!idOk(input.file_id)||!['csv','pdf'].includes(input.format)||!input.rows.length||input.rows.length>250)throw new AccountingError('Importér en fil med 1–250 gennemførte bankposter ad gangen.');
  input.rows.forEach(validateBankRow);
  if(new Set(input.rows.map(row=>row.source_row)).size!==input.rows.length)throw new AccountingError('Bankfilen indeholder gentagne linjenumre.');
  const rowsJson=JSON.stringify(input.rows);if(rowsJson.length>900000)throw new AccountingError('Importen er for stor. Del perioden i mindre udtog.');
  const digest=await sha256Hex(JSON.stringify([input.file_id,input.format,input.rows]));
  await db.prepare(`INSERT INTO accounting_imports(file_id,file_name,format,rows_json,warnings_json,digest,created_by,created_at) VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(digest) DO NOTHING`)
    .bind(input.file_id,input.file_name.slice(0,200),input.format,rowsJson,JSON.stringify(input.warnings||[]),digest,actorEmail(actor),nowSec()).run();
  const saved=await db.prepare('SELECT id FROM accounting_imports WHERE digest=?').bind(digest).first<{id:number}>();
  if(!saved)throw new AccountingError('Forhåndsvisningen kunne ikke gemmes.',409);
  return (await getImport(db,saved.id))!;
}
async function previewRows(db:D1Database,rows:BankImportRow[]):Promise<PreviewLine[]> {
  const out:PreviewLine[]=[];
  // One set query avoids a network round trip per line and stays under Workers/D1 query limits.
  const keys=[...new Set(rows.flatMap(row=>row.identity_keys))], semantics=[...new Set(rows.map(bankSemanticKey))];
  const stored=(await db.prepare(`SELECT b.id,b.semantic_key,COALESCE(json_group_array(k.identity_key) FILTER(WHERE k.identity_key IS NOT NULL),'[]') AS keys_json FROM accounting_bank_lines b LEFT JOIN accounting_bank_keys k ON k.bank_line_id=b.id WHERE b.semantic_key IN(SELECT value FROM json_each(?)) OR b.id IN(SELECT bank_line_id FROM accounting_bank_keys WHERE identity_key IN(SELECT value FROM json_each(?))) GROUP BY b.id,b.semantic_key`)
    .bind(JSON.stringify(semantics),JSON.stringify(keys)).all<{id:number;semantic_key:string;keys_json:string}>()).results.map(row=>({...row,keys:JSON.parse(row.keys_json) as string[]}));
  for(const row of rows){
    const externalKey=row.identity_keys.find(key=>key.startsWith('id:'))??null;
    const semantic=bankSemanticKey(row);
    const compatible=stored.filter(old=>!externalKey||!old.keys.some(key=>key.startsWith('id:')&&key!==externalKey));
    const matches=compatible.filter(old=>row.identity_keys.some(key=>old.keys.includes(key)));
    const candidates=compatible.filter(old=>old.semantic_key===semantic).map(x=>x.id);
    const byId=matches.filter(x=>externalKey&&x.keys.includes(externalKey)), byBalance=matches.filter(x=>x.semantic_key===semantic);
    // Never bridge two existing records merely because one upload contains both
    // an ID from one and a balance alias from the other. Keep that conflict visible.
    const conflicting=byId.some(x=>x.semantic_key!==semantic)||
      (byId.length>0&&byBalance.some(balance=>!byId.some(id=>id.id===balance.id)));
    const ids=[...new Set((byId.length?byId:byBalance).map(x=>x.id))];
    out.push({...row,duplicate_status:conflicting?'conflict':ids.length===1?'duplicate':ids.length>1||candidates.length?'review':'new',existing_id:ids.length===1&&!conflicting?ids[0]!:null,candidate_ids:[...new Set([...candidates,...ids])]});
  }
  return out;
}
export async function getImport(db:D1Database,id:number):Promise<ImportPreview|null> {
  const entry=await db.prepare('SELECT * FROM accounting_imports WHERE id=?').bind(id).first<ImportRow>();if(!entry)return null;
  const revision=await db.prepare("SELECT COUNT(*) AS n FROM accounting_imports WHERE status='confirmed'").first<{n:number}>();
  return {...entry,bank_revision:revision?.n??0,rows:await previewRows(db,JSON.parse(entry.rows_json) as BankImportRow[]),warnings:JSON.parse(entry.warnings_json) as string[]};
}
export async function listImports(db:D1Database):Promise<ImportRow[]> { return (await db.prepare('SELECT * FROM accounting_imports ORDER BY id DESC').all<ImportRow>()).results; }
export async function confirmImport(db:D1Database,actor:AccountingActor,id:number,resolutions:Record<string,ImportResolution>={}):Promise<{imported:number;duplicates:number;already_confirmed:boolean}> {
  const preview=await getImport(db,id);if(!preview)throw new AccountingError('Importen findes ikke.',404);
  if(preview.status==='confirmed')return {imported:0,duplicates:preview.rows.length,already_confirmed:true};
  const at=nowSec(), statements:D1PreparedStatement[]=[guard(db,"EXISTS(SELECT 1 FROM accounting_imports WHERE id=? AND status='preview')",[id]),guard(db,"(SELECT COUNT(*) FROM accounting_imports WHERE status='confirmed')=?",[preview.bank_revision])];
  let imported=0,duplicates=0;
  const sameBatchKeys=new Map<string,{source:number;externalKey:string|null;semantic:string}[]>();
  for(const row of preview.rows){
    validateBankRow(row);
    if(row.duplicate_status==='conflict')throw new AccountingError('Transaktions-ID og saldo peger på forskellige banklinjer. Ret eller afklar filen før import.');
    const resolution=resolutions[String(row.source_row)];
    let match=row.existing_id;
    if(row.duplicate_status==='review'){
      if(resolution!=='new'&&(!idOk(Number(resolution))||!row.candidate_ids.includes(Number(resolution))))throw new AccountingError(`Afklar mulig dublet på linje ${row.source_row}: vælg eksisterende transaktion eller særskilt betaling.`);
      match=resolution==='new'?null:Number(resolution);
    }
    // Two strong identities in a single upload refer to one transaction, never two expenses.
    const externalKey=row.identity_keys.find(key=>key.startsWith('id:'))??null;
    const semantic=bankSemanticKey(row);
    // Only an explicit repeated transaction ID deduplicates rows within the same statement.
    // Identical balances without IDs can be distinct purchases after an intervening refund.
    const sourceMatches=[...new Set((externalKey?(sameBatchKeys.get(externalKey)??[]):[]).filter(old=>old.semantic===semantic).map(old=>old.source))];
    if(sourceMatches.length>1)throw new AccountingError('Bankfilen indeholder modstridende transaktionsidentiteter.');
    const priorSource=sourceMatches[0];
    let lineSql:string, lineArgs:unknown[];
    if(match!==null){
      duplicates++;lineSql='?';lineArgs=[match];
      // Semantic confirmation is checked again within the same transaction.
      if(row.duplicate_status==='review')statements.push(guard(db,'EXISTS(SELECT 1 FROM accounting_bank_lines WHERE id=? AND semantic_key=?)',[match,bankSemanticKey(row)]));
    }else if(priorSource!==undefined){
      duplicates++;lineSql='(SELECT bank_line_id FROM accounting_import_lines WHERE import_id=? AND source_row=?)';lineArgs=[id,priorSource];
    }else{
      imported++;
      // The import revision guard serializes confirmation against every other committed import.
      statements.push(db.prepare(`INSERT INTO accounting_bank_lines(import_id,source_row,date,description,merchant,amount_minor,currency,account_key,external_id,balance_minor,semantic_key,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`)
        .bind(id,row.source_row,row.date,row.description,row.merchant,row.amount_minor,row.currency,row.account_key,row.external_id,row.balance_minor,bankSemanticKey(row),at));
      lineSql='(SELECT id FROM accounting_bank_lines WHERE import_id=? AND source_row=?)';lineArgs=[id,row.source_row];
    }
    statements.push(db.prepare(`INSERT INTO accounting_import_lines(import_id,source_row,bank_line_id) VALUES(?,?,${lineSql})`).bind(id,row.source_row,...lineArgs));
    if(row.identity_keys.length) statements.push(db.prepare(`INSERT INTO accounting_bank_keys(identity_key,bank_line_id) VALUES ${row.identity_keys.map(()=>`(?,${lineSql})`).join(',')} ON CONFLICT(identity_key,bank_line_id) DO NOTHING`).bind(...row.identity_keys.flatMap(key=>[key,...lineArgs])));
    for(const key of row.identity_keys){
      const aliases=sameBatchKeys.get(key)??[];
      aliases.push({source:priorSource??row.source_row,externalKey,semantic});
      sameBatchKeys.set(key,aliases);
    }
  }
  statements.push(db.prepare("UPDATE accounting_imports SET status='confirmed',confirmed_by=?,confirmed_at=? WHERE id=?").bind(actorEmail(actor),at,id),event(db,actor,'import',id,'confirmed',{imported,duplicates,resolutions},at));
  try{await transact(db,statements);}catch(error){
    const done=await db.prepare('SELECT status FROM accounting_imports WHERE id=?').bind(id).first<{status:string}>();
    if(done?.status==='confirmed')return {imported:0,duplicates:preview.rows.length,already_confirmed:true};
    throw error;
  }
  return {imported,duplicates,already_confirmed:false};
}

async function postingAccounts(db:D1Database,receipt:ReceiptRow):Promise<{main:AccountRow;settlement:AccountRow;input:AccountRow;output:AccountRow}> {
  const accounts=await searchAccounts(db), main=accounts.find(a=>a.code===receipt.account_code), settlement=accounts.find(a=>a.code===receipt.settlement_account_code), input=accounts.find(a=>a.purpose==='input_vat'), output=accounts.find(a=>a.purpose==='output_vat');
  const purchase=receipt.kind.startsWith('purchase');
  if(!main||main.kind!==(purchase?'expense':'income'))throw new AccountingError(`Vælg en ${purchase?'udgiftskonto':'salgskonto'} i kontoplanen.`);
  if(!settlement||settlement.purpose!=='settlement'||!input||!output)throw new AccountingError('Vælg en gyldig modkonto. Kontoplanen skal indeholde momskonti.');
  return {main,settlement,input,output};
}
function baseAmounts(receipt:ReceiptRow):{gross:number;vat:number;deductible:number} {
  if(!receipt.supplier.trim()||!accountingDate(receipt.date)||!receipt.currency||receipt.gross_minor===null||receipt.vat_minor===null)throw new AccountingError('Udfyld leverandør/kunde, dato, valuta, total og angivet moms. Skriv 0, hvis du har kontrolleret, at der ikke er moms.');
  const purchase=receipt.kind.startsWith('purchase');
  if(purchase&&receipt.deductible_vat_minor===null)throw new AccountingError('Angiv den fradragsberettigede købsmoms, også når beløbet er 0.');
  if(receipt.currency==='DKK')return {gross:receipt.gross_minor,vat:receipt.vat_minor,deductible:purchase?receipt.deductible_vat_minor!:0};
  if(receipt.base_gross_minor===null||receipt.base_vat_minor===null||(purchase&&receipt.base_deductible_vat_minor===null))throw new AccountingError('Udfyld kontrollerede DKK-beløb for total og moms. Der anvendes ingen automatisk valutakurs.');
  return {gross:receipt.base_gross_minor,vat:receipt.base_vat_minor,deductible:purchase?receipt.base_deductible_vat_minor!:0};
}
export async function approveReceipt(db:D1Database,actor:AccountingActor,id:number,expectedVersion:number):Promise<number> {
  const receipt=await getReceipt(db,id);if(!receipt)throw new AccountingError('Bilaget findes ikke.',404);
  if(receipt.journal_id!==null)return receipt.journal_id;
  if(receipt.status!=='draft')throw new AccountingError('Bilaget er allerede behandlet.',409);
  if(['pending','reading'].includes(receipt.reading_source))throw new AccountingError('Aflæsningen er endnu ikke afsluttet. Vent eller vælg Aflæs igen, før bilaget godkendes.',409);
  if(receipt.source_kind==='multi_bank_statement')throw new AccountingError('Et bankudtog med flere poster må ikke bogføres som ét samlet køb. Importér posterne under Bankafstemning.');
  const {gross,vat,deductible}=baseAmounts(receipt), accounts=await postingAccounts(db,receipt), operation=`receipt:${id}`, at=nowSec();
  const linked=receipt.bank_line_id===null?null:await getBankLine(db,receipt.bank_line_id);
  if(linked&&(linked.currency!==receipt.currency||linked.amount_minor!==expectedBankAmount(receipt)))throw new AccountingError('Bilagets valuta, beløb og fortegn svarer ikke til den tilknyttede banklinje.');
  const purchase=receipt.kind.startsWith('purchase'), credit=receipt.kind.endsWith('_credit');
  const lines:{account:AccountRow;debit:number;credit:number;tax:string}[]=[];
  const push=(account:AccountRow, debit:number, creditAmount:number, tax='')=>{if(debit||creditAmount)lines.push({account,debit:credit?creditAmount:debit,credit:credit?debit:creditAmount,tax});};
  if(purchase){push(accounts.main,gross-deductible,0);push(accounts.input,deductible,0,'input_vat');push(accounts.settlement,0,gross);}
  else{push(accounts.main,0,gross-vat);push(accounts.output,0,vat,'output_vat');push(accounts.settlement,gross,0);}
  const statements:D1PreparedStatement[]=[
    guard(db,"EXISTS(SELECT 1 FROM accounting_receipts WHERE id=? AND version=? AND status='draft')",[id,expectedVersion]),
    // Linking in another browser between validation and commit cannot silently add an unverified bank transaction.
    guard(db,'COALESCE((SELECT bank_line_id FROM accounting_bank_links WHERE receipt_id=?),0)=?',[id,receipt.bank_line_id??0]),
    db.prepare(`INSERT INTO accounting_journals(operation_key,receipt_id,bank_line_id,date,description,created_by,created_at) VALUES(?,?,?,?,?,?,?)`).bind(operation,id,receipt.bank_line_id,receipt.date,receipt.supplier,actorEmail(actor),at),
    ...lines.map(line=>db.prepare(`INSERT INTO accounting_journal_lines(journal_id,account_code,account_name,account_kind,tax_role,debit_minor,credit_minor) VALUES((SELECT id FROM accounting_journals WHERE operation_key=?),?,?,?,?,?,?)`).bind(operation,line.account.code,line.account.name,line.account.kind,line.tax,line.debit,line.credit)),
    db.prepare("UPDATE accounting_journals SET status='posted' WHERE operation_key=?").bind(operation),
    db.prepare("UPDATE accounting_receipts SET status='posted',version=version+1,updated_at=? WHERE id=?").bind(at,id),
    event(db,actor,'receipt',id,'posted',{operation,bank_line_id:receipt.bank_line_id,original_currency:receipt.currency,original_gross_minor:receipt.gross_minor,base_gross_minor:gross,base_vat_minor:vat,deductible_vat_minor:deductible},at),
  ];
  try{await transact(db,statements);}catch(error){
    const saved=await getReceipt(db,id);if(saved?.journal_id!==null&&saved?.journal_id!==undefined)return saved.journal_id;throw error;
  }
  return (await getReceipt(db,id))!.journal_id!;
}
export async function reversePosting(db:D1Database,actor:AccountingActor,journalId:number,date:string,reason:string):Promise<number> {
  if(!accountingDate(date)||!reason.trim()||reason.length>2000)throw new AccountingError('Angiv en gyldig korrektionsdato og begrundelse.');
  const original=await db.prepare("SELECT * FROM accounting_journals WHERE id=? AND status='posted'").bind(journalId).first<JournalRow>();
  if(!original||original.reversal_of!==null)throw new AccountingError('Vælg en oprindelig bogført post.',404);
  const existing=await db.prepare("SELECT id FROM accounting_journals WHERE reversal_of=? AND status='posted'").bind(journalId).first<{id:number}>();if(existing)return existing.id;
  const operation=`reversal:${journalId}`,at=nowSec();
  try{await transact(db,[
    db.prepare('INSERT INTO accounting_journals(operation_key,receipt_id,bank_line_id,reversal_of,date,description,created_by,created_at) VALUES(?,?,?,?,?,?,?,?)').bind(operation,original.receipt_id,original.bank_line_id,journalId,date,`Tilbageførsel: ${reason.trim()}`,actorEmail(actor),at),
    db.prepare(`INSERT INTO accounting_journal_lines(journal_id,account_code,account_name,account_kind,tax_role,debit_minor,credit_minor) SELECT (SELECT id FROM accounting_journals WHERE operation_key=?),account_code,account_name,account_kind,tax_role,credit_minor,debit_minor FROM accounting_journal_lines WHERE journal_id=?`).bind(operation,journalId),
    db.prepare("UPDATE accounting_journals SET status='posted' WHERE operation_key=?").bind(operation),
    event(db,actor,'receipt',original.receipt_id,'reversed',{journal_id:journalId,date,reason:reason.trim()},at),
  ]);}catch(error){const raced=await db.prepare('SELECT id FROM accounting_journals WHERE reversal_of=?').bind(journalId).first<{id:number}>();if(raced)return raced.id;throw error;}
  return (await db.prepare('SELECT id FROM accounting_journals WHERE operation_key=?').bind(operation).first<{id:number}>())!.id;
}
export async function createCorrectionDraft(db:D1Database,actor:AccountingActor,receiptId:number):Promise<ReceiptRow> {
  const original=await getReceipt(db,receiptId);if(!original||!original.reversal_id)throw new AccountingError('Tilbagefør den oprindelige postering før en rettelseskladde oprettes.');
  const existing=await db.prepare('SELECT id FROM accounting_receipts WHERE correction_of=?').bind(receiptId).first<{id:number}>();if(existing)return (await getReceipt(db,existing.id))!;
  const at=nowSec();
  const statements=[
    db.prepare(`INSERT INTO accounting_receipts(file_id,file_name,${fields.join(',')},source_kind,reading_source,reading_note,uncertain,correction_of,created_by,created_at,updated_at) SELECT file_id,file_name,${fields.join(',')},source_kind,reading_source,reading_note,uncertain,id,?,?,? FROM accounting_receipts WHERE id=?`).bind(actorEmail(actor),at,at,receiptId),
    db.prepare('UPDATE accounting_bank_links SET receipt_id=(SELECT id FROM accounting_receipts WHERE correction_of=?),created_by=?,created_at=? WHERE receipt_id=?').bind(receiptId,actorEmail(actor),at,receiptId),
    event(db,actor,'receipt',receiptId,'correction_draft_created',{original:receiptId},at),
    db.prepare(`INSERT INTO accounting_events(entity_type,entity_id,action,detail,actor,created_at) SELECT 'receipt',id,'correction_of',?,?,? FROM accounting_receipts WHERE correction_of=?`).bind(JSON.stringify({receipt_id:receiptId}),actorEmail(actor),at,receiptId),
  ];
  if(original.bank_line_id!==null)statements.push(event(db,actor,'bank_line',original.bank_line_id,'correction_linked',{previous_receipt_id:receiptId},at));
  try{await transact(db,statements);}catch(error){const raced=await db.prepare('SELECT id FROM accounting_receipts WHERE correction_of=?').bind(receiptId).first<{id:number}>();if(raced)return (await getReceipt(db,raced.id))!;throw error;}
  const row=await db.prepare('SELECT id FROM accounting_receipts WHERE correction_of=?').bind(receiptId).first<{id:number}>();return (await getReceipt(db,row!.id))!;
}
export interface ReportAccount {code:string;name:string;kind:string;debit_minor:number;credit_minor:number;balance_minor:number;}
export interface AccountingReport {
  from:string;to:string;currency:'DKK';sales_vat_minor:number;purchase_vat_minor:number;net_vat_minor:number;
  income_minor:number;expenses_minor:number;result_minor:number;accounts:ReportAccount[];entries:JournalRow[];
}
export async function accountingReport(db:D1Database,period:{from:string;to:string;currency?:'DKK'}):Promise<AccountingReport> {
  if(!accountingDate(period.from)||!accountingDate(period.to)||period.from>period.to)throw new AccountingError('Vælg en gyldig periode.');
  const [groups,taxes,entries]=await db.batch([
    db.prepare(`SELECT l.account_code AS code,l.account_name AS name,l.account_kind AS kind,SUM(l.debit_minor) AS debit_minor,SUM(l.credit_minor) AS credit_minor,SUM(l.debit_minor-l.credit_minor) AS balance_minor FROM accounting_journal_lines l JOIN accounting_journals j ON j.id=l.journal_id WHERE j.status='posted' AND j.date BETWEEN ? AND ? GROUP BY l.account_code,l.account_name,l.account_kind ORDER BY l.account_code`).bind(period.from,period.to),
    db.prepare(`SELECT COALESCE(SUM(CASE WHEN l.tax_role='output_vat' THEN l.credit_minor-l.debit_minor ELSE 0 END),0) AS sales,COALESCE(SUM(CASE WHEN l.tax_role='input_vat' THEN l.debit_minor-l.credit_minor ELSE 0 END),0) AS purchases FROM accounting_journal_lines l JOIN accounting_journals j ON j.id=l.journal_id WHERE j.status='posted' AND j.date BETWEEN ? AND ?`).bind(period.from,period.to),
    db.prepare("SELECT * FROM accounting_journals WHERE status='posted' AND date BETWEEN ? AND ? ORDER BY date,id").bind(period.from,period.to),
  ]);
  const accounts=groups!.results as unknown as ReportAccount[], tax=taxes!.results[0] as unknown as {sales:number;purchases:number}|undefined;
  const income=accounts.filter(a=>a.kind==='income').reduce((sum,a)=>sum-a.balance_minor,0),expenses=accounts.filter(a=>a.kind==='expense').reduce((sum,a)=>sum+a.balance_minor,0);
  return {from:period.from,to:period.to,currency:'DKK',sales_vat_minor:tax?.sales??0,purchase_vat_minor:tax?.purchases??0,net_vat_minor:(tax?.sales??0)-(tax?.purchases??0),income_minor:income,expenses_minor:expenses,result_minor:income-expenses,accounts,entries:entries!.results as unknown as JournalRow[]};
}
/** Balance movement always includes hidden lines and never joins journals/import duplicates. */
export async function bankTotals(db:D1Database):Promise<{account_key:string;currency:string;movement_minor:number;count:number}[]> {
  return (await db.prepare('SELECT account_key,currency,SUM(amount_minor) AS movement_minor,COUNT(*) AS count FROM accounting_bank_lines GROUP BY account_key,currency ORDER BY account_key,currency').all<{account_key:string;currency:string;movement_minor:number;count:number}>()).results;
}
